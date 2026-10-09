"use strict";

/**
 * CitizenObservatoryGuildLife — the slow-tick dynamics for the Astronomers'
 * Guild.
 *
 * No-overlap boundary:
 *   - CitizenAstronomyLife owns: astronomer observation ticks, chart
 *     creation, celestial-event announcements and effects.
 *   - CitizenObservatoriesLife owns: viewing parties, tours, and
 *     observatory announcements.
 *   - CitizenScienceLife owns: experiments, discoveries, grants.
 *   - This owns: guild dues, certification settlement, owed-bounty retries,
 *     fabrication tribunal settlement, celestial-standard audits, eclipse
 *     prediction confirmations, the silver orrery, the star-chart school,
 *     promotions, and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenObservatoryGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp

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
        // Plain roster records carry kingdomId; the brain read is only the
        // live-entity fallback (it pins plain records to KINGDOM_IDS[0]).
        const rkid = r?.kingdomId ||
          (S && typeof S.kingdomIdOf === "function" ? S.kingdomIdOf(r) : null);
        return rkid === kingdomId;
      } catch { return false; }
    });
    const bot = near ? botFor(director, near) : null;
    if (bot && typeof sayPublic === "function") sayPublic(bot, text);
  } catch { /* announcements are best-effort */ }
}

function monthLabel(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return "an upcoming month";
  }
}

function tickObservatoryGuildLife(director, nowMs = Date.now()) {
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
          // Plain roster record first — the brain read silently pins plain
          // records to the first kingdom (no getAttribute).
          rkid = record?.kingdomId ||
            (S && typeof S.kingdomIdOf === "function" ? S.kingdomIdOf(record) : null);
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

      // --- retry owed certification bounties as funds refill
      try {
        Guilds.retryOwedBounties(kid);
      } catch { /* never breaks the tick */ }

      // --- confirm or fail open celestial predictions against the real sky
      try {
        const res = Guilds.confirmPredictions(kid, nowMs);
        for (const pid of res.confirmed) {
          const preds = Guilds.predictionsFor(kid);
          const p = preds.find((x) => x.id === pid);
          if (p) {
            announce(director, kid,
              `${p.predictedBy} foretold the ${p.label} — and the sky kept its word. ` +
              `The guild's herald takes ${Guilds.HERALD_PRIZE} coins.` +
              (p.prizeOwed > 0 ? ` (${p.prizeOwed} owed until the treasury refills.)` : ""),
              nowMs);
          }
        }
      } catch { /* prediction confirmation never breaks the tick */ }

      // --- settle ripe fabrication tribunal cases
      try {
        const res = Guilds.settleRipeCases(kid, nowMs);
        if (res.settled && res.settled.length) {
          announce(director, kid,
            `The Astronomers' Guild settled ${res.settled.length} fabrication case(s).`, nowMs);
        }
      } catch { /* never breaks the tick */ }

      // --- celestial standards: accuracy audits
      try {
        const audit = Guilds.accuracyAuditFor(kid);
        if (audit.members > 0 && audit.score < 40) {
          announce(director, kid,
            `The Astronomers' Guild calls a celestial audit — only ${audit.withCharts} of ${audit.members} members have real certified charts.`, nowMs);
        }
      } catch { /* audit failure never breaks the tick */ }

      // --- silver orrery: quarterly award
      try {
        const r = Guilds.grantSilverOrrery(kid, nowMs);
        if (r.ok) {
          announce(director, kid,
            `${r.winner} wins the silver orrery with ${r.charts} certified chart(s)!`, nowMs);
        }
      } catch { /* orrery failure never breaks the tick */ }

      // --- star-chart school (starmaster teaches stargazers)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          // The teaching starmaster must belong to THIS kingdom. Roster records
          // are plain ({username, kingdomId}), so scope by the record field —
          // a foreign starmaster must not teach another kingdom's school.
          const masterRec = roster.find((r) => {
            try {
              return (r?.kingdomId ?? null) === kid &&
                Guilds.guildRankOf(usernameOf(r)) === Guilds.RANK_STARMASTER;
            } catch { return false; }
          });
          const master = masterRec ? usernameOf(masterRec) : null;
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              // Promotions are attempted for stargazers/astronomers with enough credits.
              for (const n of Guilds.memberNames(kid)) {
                Guilds.tryPromote(n);
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
}

module.exports = {
  tickObservatoryGuildLife,
  resetForTests,
};
