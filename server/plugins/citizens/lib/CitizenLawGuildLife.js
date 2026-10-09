"use strict";

/**
 * CitizenLawGuildLife — the slow-tick dynamics for the bar association.
 *
 * No-overlap boundary:
 *   - CitizenCivilLife owns: contract deadlines, dispute mediation/hearings,
 *     judgment enforcement, will execution.
 *   - This owns: guild dues, case reviews, tribunal settlement, misconduct
 *     scanning, pro bono claim filing/assignment/payout, legal-school
 *     classes, promotion, and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenLawGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenMisconduct = new Set(); // misconduct keys already auto-reported (per process)

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

function tickLawGuildLife(director, nowMs = Date.now()) {
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
        if ((m.duesPaidUntilMs || 0) > nowMs) continue;
        const bot = botFor(director, record);
        if (bot && hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) && removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          // Broke or no inventory — a miss, not a crime. Offline members are
          // never iterated here, so they never accrue misses.
          Guilds.recordMissedDues(name, nowMs);
        }
      }

      // --- case review (guild auto-review when no counselor has reviewed recently)
      try {
        const g = Guilds.guildOf(kid);
        const lastReview = g && g.reviews.length ? g.reviews[g.reviews.length - 1].atMs : 0;
        if (g && nowMs - lastReview >= 7 * 24 * 60 * 60 * 1000) {
          const r = Guilds.conductReview(kid, "guild");
          if (r.ok && r.result === "FLAG") {
            announce(director, kid, `Bar association review: ${r.reasons.join("; ")}.`, nowMs);
          }
          if (r.ok && r.backlogged) {
            announce(director, kid, "The bar association declares the docket backlogged — pro bono advocates needed.", nowMs);
          }
        }
      } catch { /* review failure never breaks the tick */ }

      // --- pro bono: file claims for disputes needing advocates, assign, pay
      try {
        const CivilLaw = (() => { try { return require("./CitizenCivilLaw"); } catch { return null; } })();
        if (CivilLaw && CivilLaw.disputesNeedingAdvocates) {
          const needing = CivilLaw.disputesNeedingAdvocates() || [];
          for (const item of needing.slice(0, 5)) { // cap per tick
            const disputeId = item.disputeId || item.id;
            const party = item.party;
            if (!disputeId || !party) continue;
            Guilds.fileProBonoClaim(kid, disputeId, party);
          }
        }
        // Assign open claims to online guild advocates.
        const g = Guilds.guildOf(kid);
        if (g) {
          for (const claimId of Object.keys(g.probonoClaims)) {
            const claim = g.probonoClaims[claimId];
            if (claim.status !== "open") continue;
            const advocate = roster.map(usernameOf).find((n) => {
              const rank = Guilds.guildRankOf(n);
              return (rank === Guilds.RANK_ADVOCATE || rank === Guilds.RANK_COUNSELOR) &&
                     !Guilds.memberOf(n)?.suspended;
            });
            if (!advocate) break;
            const res = Guilds.assignProBonoAdvocate(kid, claimId, advocate);
            if (res.ok) {
              announce(director, kid,
                `The bar association assigned ${advocate} pro bono to a civil dispute.`, nowMs);
            }
          }
          // Retry owed payouts as the fund refills.
          Guilds.retryOwedProBono(kid);
        }
      } catch { /* pro bono failure never breaks the tick */ }

      // --- misconduct auto-scan (oathbreaker deeds are verifiable)
      try {
        for (const record of roster) {
          const name = usernameOf(record);
          if (!name || !Guilds.isGuildMember(name)) continue;
          const key = `${kid}:${name.toLowerCase()}`;
          if (seenMisconduct.has(key)) continue;
          const kind = Guilds.scanMisconduct(name);
          if (kind) {
            seenMisconduct.add(key);
            Guilds.reportMisconduct(kid, name, kind, null, "guild");
            announce(director, kid,
              `The bar association opened a disciplinary case against ${name}.`, nowMs);
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe disciplinary cases
      try {
        Guilds.settleRipeCases(kid, nowMs);
      } catch { /* never breaks the tick */ }

      // --- legal school (counselor teaches clerks)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_COUNSELOR);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              // Promotions are attempted for clerks with enough credits.
              const g = Guilds.guildOf(kid);
              if (g) {
                for (const n of Object.keys(g.members)) {
                  if (g.members[n].rank === Guilds.RANK_CLERK) Guilds.tryPromote(n);
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
  seenMisconduct.clear();
}

module.exports = {
  tickLawGuildLife,
  resetForTests,
};
