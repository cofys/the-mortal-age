"use strict";

/**
 * CitizenWeaverGuildLife — the slow-tick dynamics for the Weavers' Guild.
 *
 * No-overlap boundary:
 *   - CitizenRunways owns: designers, collections, ateliers, shows (READ
 *     only here, except guild-settled certifications through the real API).
 *   - CitizenFashion owns: trends, shops, competitions (READ only here).
 *   - This owns: guild dues, certification settlement, owed-bounty retries,
 *     knockoff auto-scan, tribunal settlement, atelier inspections, golden
 *     needle grants, fashion-school classes, promotions, and guild
 *     announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenWeaverGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenKnockoff = new Set(); // accused keys already auto-reported (per process)

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

function tickWeaverGuildLife(director, nowMs = Date.now()) {
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
        if (bot && hasItem(bot, 995, Guilds.DUES_WEEKLY) && removeItem(bot, 995, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          // Broke or no inventory — a miss, not a crime. Offline members are
          // never iterated here, so they never accrue misses.
          Guilds.recordMissedDues(name, nowMs);
        }
      }

      // --- settle queued certifications (FIFO)
      try {
        const s = Guilds.serialize();
        const queued = s.queue.filter((q) => q.kingdomId === kid);
        for (const q of queued) {
          const res = Guilds.settleCertification(q.kingdomId, q.collectionId, nowMs);
          if (res.ok && res.grade === "A") {
            announce(director, kid,
              `The Weavers' Guild certified ${q.owner}'s collection with an A seal.`, nowMs);
          }
        }
        Guilds.retryOwedBounties(kid);
      } catch { /* certification failure never breaks the tick */ }

      // --- knockoff auto-scan (duplicate collection names are verifiable)
      try {
        for (const hit of Guilds.scanKnockoffs()) {
          const key = `${kid}:${String(hit.designer).toLowerCase()}`;
          if (seenKnockoff.has(key)) continue;
          if (Guilds.guildOf(kid) && hit) {
            const rep = Guilds.reportKnockoff(kid, hit.designer, "guild");
            if (rep.ok) {
              seenKnockoff.add(key);
              announce(director, kid,
                `The Weavers' Guild opened a knockoff case against ${hit.designer}.`, nowMs);
            }
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe tribunal cases
      try {
        const settled = Guilds.settleRipeCases(kid, nowMs);
        for (const s2 of settled) {
          if (s2.verdict === "guilty") {
            announce(director, kid,
              "The Weavers' Guild expelled a counterfeiter for selling knockoffs.", nowMs);
          }
        }
      } catch { /* never breaks the tick */ }

      // --- atelier inspections
      try {
        const res = Guilds.inspectAteliers(kid, nowMs);
        if (res.ok && res.inspection < Guilds.INSPECTION_AUDIT_THRESHOLD && res.inspected > 0) {
          announce(director, kid,
            `The Weavers' Guild declares a style audit — ${res.idle.length} ateliers stand idle.`, nowMs);
        }
      } catch { /* inspection failure never breaks the tick */ }

      // --- golden needle
      try {
        const res = Guilds.grantGoldenNeedle(kid, nowMs);
        if (res.ok) {
          try {
            const Rep = require("./CitizenReputation");
            if (Rep && typeof Rep.awardDeed === "function") Rep.awardDeed(res.winner, "needlegrand", nowMs);
          } catch { /* reputation is best-effort */ }
          announce(director, kid,
            `${res.winner} won the golden needle of the Weavers' Guild.`, nowMs);
        }
        Guilds.retryNeedleOwed(kid);
      } catch { /* needle failure never breaks the tick */ }

      // --- fashion school (grandcouturier teaches apprentices)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_GRANDCOUTURIER);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              for (const n of Guilds.memberNames(kid)) {
                const mem = Guilds.memberOf(n);
                if (mem && mem.rank === Guilds.RANK_APPRENTICE) Guilds.tryPromote(n);
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
  seenKnockoff.clear();
}

module.exports = {
  tickWeaverGuildLife,
  resetForTests,
};
