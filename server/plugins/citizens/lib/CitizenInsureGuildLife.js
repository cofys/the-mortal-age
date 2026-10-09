"use strict";

/**
 * CitizenInsureGuildLife — the slow-tick dynamics for the underwriters' association.
 *
 * No-overlap boundary:
 *   - CitizenInsuranceLife owns: premium collection, claim settlement from
 *     the pool, insurer appointment, policy lapse, travel-danger settlement.
 *   - This owns: guild dues, solvency reviews, tribunal settlement, fraud
 *     scanning, reinsurance-claim filing and payout, actuarial-school
 *     classes, promotion, and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenInsureGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenFraud = new Set(); // fraud holder keys already auto-reported (per process)

function sitesApi() {
  try { return require("../brain/CitizenSites"); } catch { return null; }
}

function kingdomIds() {
  try {
    const S = sitesApi();
    if (S && Array.isArray(S.KINGDOM_IDS) && S.KINGDOM_IDS.length) return S.KINGDOM_IDS.slice();
  } catch { /* fall through */ }
  return [];
}

function onlineRoster(director) {
  try {
    const roster = director.roster?.values?.() ?? director.roster ?? [];
    const arr = Array.isArray(roster) ? roster : [...roster];
    return arr.filter((r) => {
      try { return director.isOnline ? director.isOnline(r) : true; }
      catch { return false; }
    });
  } catch { return []; }
}

function botFor(director, record) {
  try {
    return director.isOnline?.(record) ? director.getBot?.(record) : null;
  } catch { return null; }
}

function usernameOf(record) {
  try {
    return record?.getUsername?.() ?? record?.username ?? "";
  } catch { return ""; }
}

function hasItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    const n = inv.getAmount?.(itemId) ?? inv.count?.(itemId) ?? 0;
    return n >= amount;
  } catch { return false; }
}

function removeItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    // Canonical: deleteNumber(id, amount) with balance verification. ItemContainer
    // has no inv.remove(id, amount).
    const before = inv.getAmount?.(itemId) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(itemId, amount);
    return (inv.getAmount?.(itemId) ?? 0) === before - amount;
  } catch { return false; }
}

function announce(director, kingdomId, text, nowMs) {
  try {
    const last = lastAnnounce.get(kingdomId) || 0;
    if (nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    lastAnnounce.set(kingdomId, nowMs);
    const roster = onlineRoster(director);
    const near = roster.find((r) => {
      try {
        const S = sitesApi();
        return S && typeof S.kingdomIdOf === "function" && S.kingdomIdOf(r) === kingdomId;
      } catch { return false; }
    });
    const bot = near ? botFor(director, near) : null;
    if (bot && typeof sayPublic === "function") sayPublic(bot, text);
  } catch { /* announcements are best-effort */ }
}

function tickInsureGuildLife(director, nowMs = Date.now()) {
  try {
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Guilds.ensureGuild(kid);

      // --- dues from online members (real coins; offline skipped, never penalized)
      const roster = onlineRoster(director);
      for (const record of roster) {
        let rkid = null;
        try {
          const S = sitesApi();
          rkid = S && typeof S.kingdomIdOf === "function" ? S.kingdomIdOf(record) : null;
        } catch { rkid = null; }
        if (rkid !== kid) continue;
        const name = usernameOf(record);
        const m = Guilds.memberOf(name);
        if (!m || m.suspended) continue;
        if ((m.duesPaidUntil || 0) > nowMs) continue;
        const bot = botFor(director, record);
        if (bot && hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) && removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          // Broke or no inventory — a miss, not a crime. Offline members are
          // never iterated here, so they never accrue misses.
          Guilds.recordMissedDues(name, nowMs);
        }
      }

      // --- solvency review (guild auto-review when no actuary has reviewed recently)
      try {
        const g = Guilds.guildOf(kid);
        if (g && nowMs - (g.pool.lastReviewAt || 0) >= Guilds.REVIEW_PERIOD_MS) {
          const r = Guilds.conductReview(kid, "guild", nowMs);
          if (r.ok && r.review.verdict === "flag") {
            announce(director, kid, `Underwriters' guild review: ${r.review.reasons.join("; ")}.`, nowMs);
          }
        }
      } catch { /* review failure never breaks the tick */ }

      // --- insolvency: file reinsurance claims, then pay what the fund allows
      try {
        const g = Guilds.guildOf(kid);
        if (g && g.pool.status === "insolvent") {
          Guilds.fileReinsuranceClaims(kid, nowMs);
          for (const claim of Guilds.openReinsuranceClaims(kid)) {
            const res = Guilds.payReinsuranceClaim(claim.id);
            if (res.ok && res.paid > 0) {
              announce(director, kid, `The underwriters' guild paid ${res.paid} coins of reinsurance to ${claim.claimant}.`, nowMs);
            }
            if (!res.ok && res.reason === "fund-empty") break;
          }
        }
      } catch { /* reinsurance failure never breaks the tick */ }

      // --- fraud scan: auto-report verifiable policy fraud once per holder
      try {
        for (const f of Guilds.scanForFraud()) {
          if (seenFraud.has(f.holder)) continue;
          seenFraud.add(f.holder);
          Guilds.reportFraud("guild", f.holder);
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- tribunal settlement
      try {
        const settled = Guilds.settleCases(nowMs);
        for (const c of settled) {
          if (c.verdict === "guilty") {
            announce(director, kid, `${c.accused} was expelled from the underwriters' guild for insurance fraud.`, nowMs);
          }
        }
      } catch { /* tribunal failure never breaks the tick */ }

      // --- actuarial school (actuary master teaches agent pupils)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          const masters = Guilds.membersIn(kid).filter((m) => m.rank === Guilds.RANK_ACTUARY && !m.suspended);
          const pupils = Guilds.membersIn(kid).filter((m) => m.rank === Guilds.RANK_AGENT && !m.suspended);
          const masterRec = masters.find((m) => {
            try {
              return roster.some((r) => norm2(usernameOf(r)) === norm2(m.username));
            } catch { return false; }
          });
          if (masterRec && pupils.length > 0) {
            const pupilNames = pupils
              .filter((p) => roster.some((r) => norm2(usernameOf(r)) === norm2(p.username)))
              .slice(0, 4)
              .map((p) => p.username);
            if (pupilNames.length > 0) {
              Guilds.holdClass(masterRec.username, pupilNames, kid, nowMs);
              lastClass.set(kid, nowMs);
              for (const pn of pupilNames) Guilds.tryPromote(pn, nowMs);
            }
          }
        }
      } catch { /* school failure never breaks the tick */ }
    }
  } catch { /* the whole tick never throws */ }
}

function norm2(s) {
  return String(s ?? "").trim().toLowerCase();
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  lastClass.clear();
  seenFraud.clear();
}

module.exports = { tickInsureGuildLife, resetForTests };
