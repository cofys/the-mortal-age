"use strict";

/**
 * CitizenCookGuildLife — the slow-tick dynamics for the Chefs' Guild.
 *
 * No-overlap boundary:
 *   - CitizenCookOffLife owns: cook-off scheduling, judging, prizes, rankings.
 *   - CitizenCuisineLife owns: dishes, menus, showcases, critics.
 *   - This owns: guild dues, certification settlement, owed-bounty retries,
 *     kitchen inspections, recipe-theft auto-scan, tribunal settlement,
 *     culinary-school classes, promotions, the golden ladle, and guild
 *     announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenCookGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenTheft = new Set(); // theft keys already auto-reported (per process)

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

function awardDeed(username, deedKind) {
  try {
    const Rep = require("./CitizenReputation");
    Rep.awardDeed?.(username, deedKind);
  } catch { /* fame is optional */ }
}

function announce(director, kingdomId, text, nowMs) {  try {
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

function tickCookGuildLife(director, nowMs = Date.now()) {
  try {
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Guilds.ensureGuild(kid);
      const roster = onlineRoster(director);

      // --- dues from online members (real coins; offline skipped, never penalized)
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
        if (bot && hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) &&
            removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
          Guilds.recordDuesPayment(name, nowMs);
        } else {
          // Broke or no inventory — a miss, not a crime. Offline members are
          // never iterated here, so they never accrue misses.
          Guilds.recordMissedDues(name, nowMs);
        }
      }

      // --- certification settlement (first-in, first-out)
      try {
        const g = Guilds.guildOf(kid);
        // Retry owed bounties as funds refill.
        Guilds.retryOwedBounties(kid);
        // Settle one queued certification per tick to keep the tick cheap.
        const s = Guilds.serialize();
        const first = (s.queue || []).find((q) => q.kingdomId === kid);
        if (first) {
          const res = Guilds.settleCertification(kid, first.recipeId, nowMs);
          if (res.ok) {
            const m = Guilds.memberOf(first.owner);
            if (m && m.rank === Guilds.RANK_APPRENTICE) {
              const pr = Guilds.tryPromote(first.owner, nowMs);
              if (pr.ok) {
                announce(director, kid,
                  `The Chefs' Guild raised ${first.owner} to ${pr.rank}.`, nowMs);
              }
            }
            announce(director, kid,
              `The Chefs' Guild certified ${first.owner}'s recipe (grade ${res.grade}).`, nowMs);
          }
        }
      } catch { /* certification failure never breaks the tick */ }

      // --- kitchen inspections
      try {
        const res = Guilds.inspectKitchens(kid, nowMs);
        if (res.ok && res.hygiene < Guilds.HYGIENE_AUDIT_THRESHOLD) {
          announce(director, kid,
            `The Chefs' Guild posted a kitchen audit: ${res.fails.length} dish(es) failed inspection.`, nowMs);
        }
      } catch { /* inspection failure never breaks the tick */ }

      // --- recipe-theft auto-scan
      try {
        for (const hit of Guilds.scanRecipeTheft()) {
          const key = `${hit.recipeId}:${hit.originalId}`;
          if (seenTheft.has(key)) continue;
          seenTheft.add(key);
          Guilds.reportTheft(kid, hit.inventor, "guild");
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe tribunal cases
      try {
        const settled = Guilds.settleRipeCases(kid, nowMs);
        for (const st of settled) {
          if (st.verdict === "guilty") {
            awardDeed(st.accused, "recipethief");
            announce(director, kid,
              `The Chefs' Guild expelled ${st.accused} for recipe theft.`, nowMs);
          }
        }
      } catch { /* never breaks the tick */ }

      // --- culinary school (chefdecuisine teaches apprentices)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_CHEFDECUISINE);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              for (const n of Guilds.memberNames(kid)) {
                if (Guilds.guildRankOf(n) === Guilds.RANK_APPRENTICE) Guilds.tryPromote(n, nowMs);
              }
            }
          }
        }
      } catch { /* school failure never breaks the tick */ }

      // --- golden ladle
      try {
        const res = Guilds.grantLadle(kid, nowMs);
        if (res.ok) {
          awardDeed(res.winner, "guildchef");
          announce(director, kid,
            `The Chefs' Guild awarded the golden ladle to ${res.winner}.`, nowMs);
        }
      } catch { /* ladle failure never breaks the tick */ }
    }
  } catch { /* the whole tick never throws */ }
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  lastClass.clear();
  seenTheft.clear();
}

module.exports = {
  tickCookGuildLife,
  resetForTests,
};
