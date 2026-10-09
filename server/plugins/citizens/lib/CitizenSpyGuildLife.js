"use strict";

/**
 * CitizenSpyGuildLife — the slow-tick dynamics for the spymasters'
 * association (espionage guild).
 *
 * No-overlap boundary:
 *   - CitizenEspionage owns: networks, cells, operations, counter-intel
 *     sweeps, interrogations, war-intel. Never touched here.
 *   - CitizenEspionageLife owns: op advancement/resolution and its
 *     announcements. Never touched here.
 *   - CitizenSpyMaster (brain) owns: planning operations, counter-agent
 *     patrols. Never touched here.
 *   - This owns: guild dues, dead-drop pruning, sanctuary expiry, mole
 *     scanning, tribunal settlement, interrogation-bounty retries,
 *     tradecraft school classes, promotion, and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenSpyGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenMoles = new Set(); // mole keys already auto-reported (per process)

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

function tickSpyGuildLife(director, nowMs = Date.now()) {
  try {
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Guilds.ensureGuild(kid);

      // --- dues from online members in good standing (real coins; sanctuary
      // members are in hiding — no dues; offline members never penalized)
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
        if (Guilds.inSanctuary(name, nowMs)) continue; // hiding — the guild asks nothing
        if ((m.duesPaidUntilMs || 0) > nowMs) continue;
        const bot = botFor(director, record);
        if (bot && hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) && removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          // Broke or no inventory — a miss, not a crime.
          Guilds.recordMissedDues(name);
        }
      }

      // --- dead-drop pruning + sanctuary expiry
      try { Guilds.pruneDrops(kid, nowMs); } catch { /* never breaks the tick */ }
      try { Guilds.expireSanctuaries(kid, nowMs); } catch { /* never breaks the tick */ }

      // --- retry owed interrogation bounties as the fund refills
      try { Guilds.retryOwedBounties(kid); } catch { /* never breaks the tick */ }

      // --- mole auto-scan (a guild member running a live foreign cell
      // against their own kingdom is verifiable)
      try {
        const g = Guilds.guildOf(kid);
        if (g) {
          for (const n of Object.keys(g.members)) {
            const rec = g.members[n];
            if (rec.suspended) continue;
            const key = `${kid}:${n}`;
            if (seenMoles.has(key)) continue;
            const kind = Guilds.scanMole(kid, rec.displayName || n);
            if (kind) {
              seenMoles.add(key);
              Guilds.reportMisconduct(kid, rec.displayName || n, kind, "guild");
              announce(director, kid,
                "The shadow guild opened a mole case — someone has been seen running a foreign cell.", nowMs);
            }
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe mole cases
      try {
        const settled = Guilds.settleRipeCases(kid, nowMs);
        if (settled > 0) {
          announce(director, kid, "The shadow guild settled its mole cases.", nowMs);
        }
      } catch { /* never breaks the tick */ }

      // --- tradecraft school (a spymaster teaches the operatives)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_SPYMASTER);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              // Promotions are attempted for eligible operatives and agents.
              const g = Guilds.guildOf(kid);
              if (g) {
                for (const n of Object.keys(g.members)) {
                  if (g.members[n].rank !== Guilds.RANK_SPYMASTER) Guilds.tryPromote(n);
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
  seenMoles.clear();
}

module.exports = {
  tickSpyGuildLife,
  resetForTests,
};
