"use strict";

/**
 * CitizenDiplomaticCorpsLife — the slow-tick dynamics for the diplomatic corps.
 *
 * No-overlap boundary:
 *   - CitizenDiplomats owns: mission phase machines, escort invites,
 *     ambassador stationing, ceremonies and chatter.
 *   - CitizenTreaties owns: treaty negotiations, embassies, summits, and
 *     ratification-time tension cooling.
 *   - CitizenTreatyLife owns: treaty expiry and the treaty tick.
 *   - This owns: corps dues, border reviews, treason scanning, tribunal
 *     settlement, mediation claim filing/assignment/payout, diplomatic
 *     school classes, promotion, and corps announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Corps = require("./CitizenDiplomaticCorps");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy corps business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // corps news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const REVIEW_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // guild auto border review weekly
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenTreason = new Set(); // treason keys already auto-reported (per process)

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
    if (typeof inv.remove === "function") inv.remove(itemId, amount);
    else if (typeof inv.delete === "function") inv.delete(itemId, amount);
    else return false;
    return true;
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

function tickDiplomaticCorpsLife(director, nowMs = Date.now()) {
  try {
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Corps.ensureCorps(kid);

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
        const m = Corps.memberOf(name);
        if (!m || m.suspended) continue;
        if ((m.duesPaidUntilMs || 0) > nowMs) continue;
        const bot = botFor(director, record);
        if (bot && hasItem(bot, Corps.COINS_ID, Corps.DUES_WEEKLY) && removeItem(bot, Corps.COINS_ID, Corps.DUES_WEEKLY)) {
          Corps.recordDuesPayment(name, nowMs);
        } else {
          // Broke or no inventory — a miss, not a crime. Offline members are
          // never iterated here, so they never accrue misses.
          Corps.recordMissedDues(name, nowMs);
        }
      }

      // --- border review (guild auto-review when none conducted recently)
      try {
        const g = Corps.corpsOf(kid);
        const lastReview = g && g.reviews.length ? g.reviews[g.reviews.length - 1].atMs : 0;
        if (g && nowMs - lastReview >= REVIEW_PERIOD_MS) {
          const r = Corps.conductReview(kid, "corps");
          if (r.ok && r.result === "FLAG") {
            announce(director, kid, `Diplomatic corps border review: ${r.reasons.join("; ")}.`, nowMs);
          }
          if (r.ok && r.crisis) {
            announce(director, kid,
              "The diplomatic corps declares the frontier in CRISIS — mediators are needed.", nowMs);
          }
        }
      } catch { /* review failure never breaks the tick */ }

      // --- mediation: file claims for genuinely hot borders, assign, pay
      try {
        const g = Corps.corpsOf(kid);
        if (g && (g.crisis || (g.consecutiveFlags || 0) > 0)) {
          const hot = Corps.hotBordersFor(kid);
          for (const { other } of hot.slice(0, 3)) { // cap per tick
            Corps.fileMediationClaim(kid, other);
          }
          // Assign open claims to online ambassador-rank members in standing.
          const rosterNames = roster.map(usernameOf);
          for (const claimId of Object.keys(g.mediationClaims)) {
            const claim = g.mediationClaims[claimId];
            if (claim.status !== "open") continue;
            const mediator = rosterNames.find((n) => {
              const m = Corps.memberOf(n);
              return m && m.kingdomId === kid &&
                     Corps.guildRankOf(n) === Corps.RANK_AMBASSADOR && !m.suspended;
            });
            if (!mediator) break;
            const res = Corps.assignMediation(kid, claimId, mediator);
            if (res.ok) {
              announce(director, kid,
                `The diplomatic corps sent ${mediator} to mediate the ${claim.otherKingdom} border — tension eased.`, nowMs);
            }
          }
          // Retry owed mediator fees as the fund refills.
          Corps.retryOwedMediation(kid);
        }
      } catch { /* mediation failure never breaks the tick */ }

      // --- treason auto-scan (active spy cells inside the corps are verifiable)
      try {
        for (const record of roster) {
          const name = usernameOf(record);
          if (!name || !Corps.isGuildMember(name)) continue;
          const key = `${kid}:${name.toLowerCase()}`;
          if (seenTreason.has(key)) continue;
          const kind = Corps.scanTreason(name);
          if (kind) {
            seenTreason.add(key);
            Corps.reportMisconduct(kid, name, kind, "corps");
            announce(director, kid,
              `The diplomatic corps opened a treason case against ${name}.`, nowMs);
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe disciplinary cases
      try {
        Corps.settleRipeCases(kid, nowMs);
      } catch { /* never breaks the tick */ }

      // --- diplomatic school (an ambassador teaches the envoys)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Corps.guildRankOf(n) === Corps.RANK_AMBASSADOR);
          if (master) {
            const res = Corps.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              // Promotions are attempted for eligible envoys and negotiators.
              const g = Corps.corpsOf(kid);
              if (g) {
                for (const n of Object.keys(g.members)) {
                  if (g.members[n].rank !== Corps.RANK_AMBASSADOR) Corps.tryPromote(n);
                }
              }
            }
          }
        }
      } catch { /* school failure never breaks the tick */ }
    }
  } catch { /* the whole tick never throws */ }
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  lastClass.clear();
  seenTreason.clear();
}

module.exports = {
  tickDiplomaticCorpsLife,
  resetForTests,
};
