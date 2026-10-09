"use strict";

/**
 * CitizenSportsGuildLife — the slow-tick dynamics for the Athletes' Guild.
 *
 * No-overlap boundary:
 *   - CitizenAthleticsLife owns: athlete registration, ambient training,
 *     record attempts, stadium upkeep.
 *   - This owns: guild dues, certification settlement, owed-bounty retries,
 *     doping auto-scan, tribunal settlement, training-camp claim
 *     verification, athletic-school classes, promotions, golden laurel,
 *     and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenSportsGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenDoping = new Set(); // doping keys already auto-reported (per process)

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

function kingdomIdOfRecord(record) {
  try {
    const S = sitesApi();
    return S && typeof S.kingdomIdOf === "function" ? S.kingdomIdOf(record) : null;
  } catch { return null; }
}

function announce(director, kingdomId, text, nowMs) {
  try {
    const last = lastAnnounce.get(kingdomId) || 0;
    if (nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    lastAnnounce.set(kingdomId, nowMs);
    const roster = onlineRoster(director);
    const near = roster.find((r) => kingdomIdOfRecord(r) === kingdomId);
    const bot = near ? botFor(director, near) : null;
    if (bot && typeof sayPublic === "function") sayPublic(bot, text);
  } catch { /* announcements are best-effort */ }
}

function tickSportsGuildLife(director, nowMs = Date.now()) {
  try {
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Guilds.ensureGuild(kid);

      const roster = onlineRoster(director);

      // --- dues from online members (real coins; offline skipped, never penalized)
      for (const record of roster) {
        if (kingdomIdOfRecord(record) !== kid) continue;
        const name = usernameOf(record);
        const m = Guilds.memberOf(name);
        if (!m || m.suspended) continue;
        if ((m.duesPaidUntilMs || 0) > nowMs) continue;
        const bot = botFor(director, record);
        if (bot && hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) && removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          Guilds.recordMissedDues(name, nowMs);
        }
      }

      // --- settle queued record certifications
      try {
        for (const q of Guilds.serialize().queue.filter((x) => x.kingdomId === kid)) {
          const res = Guilds.settleCertification(q.kingdomId, q.sport, nowMs);
          if (res.ok) {
            announce(director, kid,
              `The Athletes' Guild certified ${q.owner}'s ${q.sport} record — grade ${res.grade}.`, nowMs);
          }
        }
      } catch { /* certification failure never breaks the tick */ }

      // --- retry honestly-owed bounties as funds refill
      try { Guilds.retryOwedBounties(kid); } catch { /* never breaks */ }

      // --- doping auto-scan (phantom records / impossible marks are verifiable)
      try {
        for (const hit of Guilds.scanDoping()) {
          if (hit.kingdomId !== kid) continue;
          const key = `${kid}:${hit.sport}:${String(hit.holder).toLowerCase()}`;
          if (seenDoping.has(key)) continue;
          seenDoping.add(key);
          Guilds.reportDoping(kid, hit.holder, hit.kind, "guild");
          announce(director, kid,
            `The Athletes' Guild opened a doping case against ${hit.holder}.`, nowMs);
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe tribunal cases
      try {
        const settled = Guilds.settleRipeCases(kid, nowMs);
        for (const c of settled) {
          if (c.verdict === "guilty") {
            announce(director, kid,
              `${c.accused} was expelled from the Athletes' Guild for doping.`, nowMs);
          }
        }
      } catch { /* never breaks the tick */ }

      // --- golden laurel (quarterly)
      try {
        const res = Guilds.grantLaurel(kid, nowMs);
        if (res.ok) {
          announce(director, kid,
            `${res.winner} takes the golden laurel with ${res.records} certified records!`, nowMs);
        }
      } catch { /* never breaks the tick */ }

      // --- athletic school (gamesmaster teaches rookies)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_GAMESMASTER);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              const g = Guilds.guildOf(kid);
              if (g) {
                for (const n of Object.keys(Guilds.serialize().members)) {
                  const mem = Guilds.memberOf(n);
                  if (mem && mem.kingdomId === kid && mem.rank === Guilds.RANK_ROOKIE) {
                    Guilds.tryPromote(n, nowMs);
                  }
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
  seenDoping.clear();
}

module.exports = {
  tickSportsGuildLife,
  resetForTests,
};
