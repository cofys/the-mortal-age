"use strict";

/**
 * CitizenArtGuildLife — the slow-tick dynamics for the Artists' Guild.
 *
 * No-overlap boundary:
 *   - CitizenArtLife owns: exhibition scheduling, market expiry, and
 *     announcements.
 *   - CitizenGalleriesLife owns: auction closes, budget accrual, exhibition
 *     travel, and announcements.
 *   - This owns: guild dues, certification settlement, owed-bounty retries,
 *     forgery auto-scan, tribunal settlement, studio inspections,
 *     golden-palette grants, art-school classes, promotions, and guild
 *     announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenArtGuilds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const seenForgery = new Set(); // forgery keys already auto-reported (per process)

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

function tickArtGuildLife(director, nowMs = Date.now()) {
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

      // --- retry owed certification bounties as funds refill
      try {
        Guilds.retryOwedBounties(kid);
      } catch { /* never breaks the tick */ }

      // --- forgery auto-scan: check recent certifications for forged works
      try {
        const st = Guilds.load();
        for (const cert of Object.values(st.certifications || {})) {
          if (cert.kingdomId !== kid) continue;
          const key = `${kid}:${Guilds.normalizeTitle(cert.title)}`;
          if (seenForgery.has(key)) continue;
          const found = Guilds.scanForgery(cert.title);
          if (found && found.accused.id === cert.id) {
            seenForgery.add(key);
            Guilds.reportForgery(kid, "guild", cert.title);
            announce(director, kid,
              `The Artists' Guild opened a forgery case over "${cert.title}".`, nowMs);
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe tribunal cases
      try {
        const res = Guilds.settleRipeCases(kid, nowMs);
        if (res.settled && res.settled.length) {
          announce(director, kid,
            `The Artists' Guild settled ${res.settled.length} tribunal case(s).`, nowMs);
        }
      } catch { /* never breaks the tick */ }

      // --- studio inspections: announce atelier audits
      try {
        const insp = Guilds.inspectionFor(kid);
        if (insp.members > 0 && insp.score < 40) {
          announce(director, kid,
            `The Artists' Guild calls an atelier audit — only ${insp.withWorks} of ${insp.members} members have real works.`, nowMs);
        }
      } catch { /* inspection failure never breaks the tick */ }

      // --- golden palette: quarterly award
      try {
        const r = Guilds.grantGoldenPalette(kid, nowMs);
        if (r.ok) {
          announce(director, kid,
            `${r.winner} wins the golden palette with ${r.artworks} certified artwork(s)!`, nowMs);
        }
      } catch { /* palette failure never breaks the tick */ }

      // --- art school (master teaches apprentices)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_MASTER);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              // Promotions are attempted for apprentices/artists with enough credits.
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
  seenForgery.clear();
}

module.exports = {
  tickArtGuildLife,
  resetForTests,
};
