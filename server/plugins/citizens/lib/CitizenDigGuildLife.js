"use strict";

/**
 * CitizenDigGuildLife — the slow-tick dynamics for the Excavators' Guild.
 *
 * No-overlap boundary:
 *   - CitizenArchaeologyLife owns: archaeologist registration + ambient
 *     digging + site founding.
 *   - This owns: guild dues, automatic artifact submissions for
 *     authentication, forgery auto-scan, tribunal settlement, site
 *     inspections, field-school classes, promotion, owed-bounty retries,
 *     and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenDigGuilds");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const CLASS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // school at most every 8h per kingdom
const INSPECT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // site inspections at most every 12h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastClass = new Map(); // kingdomId -> timestamp
const lastInspect = new Map(); // kingdomId -> timestamp
const seenForgery = new Set(); // "kingdom:artifactId" already auto-reported (per process)

function archApi() {
  try { return require("./CitizenArchaeology"); }
  catch { return null; }
}

function sitesApi() {
  try { return require("../brain/CitizenSites"); }
  catch { return null; }
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

function usernameOf(record) {
  try {
    return record?.getUsername?.() ?? record?.username ?? "";
  } catch { return ""; }
}

function botFor(director, record) {
  try {
    return director.isOnline?.(record) ? director.getBot?.(record) : null;
  } catch { return null; }
}

function kingdomIdOfRecord(record) {
  try {
    const S = sitesApi();
    if (S && typeof S.kingdomIdOf === "function") return S.kingdomIdOf(record);
  } catch { /* fall through */ }
  return record?.kingdomId ?? null;
}

function kingdomIds() {
  try {
    const S = sitesApi();
    if (S && Array.isArray(S.KINGDOM_IDS) && S.KINGDOM_IDS.length) return S.KINGDOM_IDS.slice();
  } catch { /* fall through */ }
  return [];
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

function giveItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    if (typeof inv.add === "function") { inv.add(itemId, amount); return true; }
    return false;
  } catch { return false; }
}

function announce(director, kingdomId, text, nowMs) {
  try {
    const last = lastAnnounce.get(kingdomId) || 0;
    if (last > 0 && nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    lastAnnounce.set(kingdomId, nowMs);
    const roster = onlineRoster(director);
    const near = roster.find((r) => kingdomIdOfRecord(r) === kingdomId);
    const bot = near ? botFor(director, near) : null;
    if (bot) {
      const { sayPublic } = require("../chat/CitizenSayPublic");
      if (typeof sayPublic === "function") sayPublic(bot, text);
    }
  } catch { /* announcements are best-effort */ }
}

function journal(kind, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log?.(kind, data);
  } catch { /* journal optional */ }
}

function tickDigGuildLife(director, nowMs = Date.now()) {
  try {
    const A = archApi();
    for (const kid of kingdomIds()) {
      const last = lastTick.get(kid) || 0;
      if (last > 0 && nowMs - last < TICK_COOLDOWN_MS) continue;
      lastTick.set(kid, nowMs);
      Guilds.ensureGuild(kid);
      const roster = onlineRoster(director);

      // --- dues from online members (real coins; offline skipped, never penalized)
      try {
        for (const record of roster) {
          if (kingdomIdOfRecord(record) !== kid) continue;
          const name = usernameOf(record);
          const m = Guilds.memberOf(name);
          if (!m || m.suspended || (m.duesPaidUntilMs || 0) > nowMs) continue;
          const bot = botFor(director, record);
          if (bot && hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) &&
              removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
            Guilds.recordDuesPayment(name, nowMs);
          } else {
            // Broke or no inventory — a miss, not a crime. Offline members
            // are never iterated here, so they never accrue misses.
            Guilds.recordMissedDues(name);
          }
        }
      } catch { /* dues failure never breaks the tick */ }

      // --- retry honestly-owed authentication bounties as the treasury refills
      try {
        const paid = Guilds.retryOwedBounties(kid, (owner, coins) => {
          const rec = roster.find((r) => usernameOf(r).toLowerCase() === String(owner).toLowerCase());
          const bot = rec ? botFor(director, rec) : null;
          return bot ? giveItem(bot, Guilds.COINS_ID, coins) : false;
        });
        if (paid > 0) journal("digguild_bounty_paid", { kingdomId: kid, coins: paid });
      } catch { /* never breaks the tick */ }

      // --- automatic authentication: members' newly found quality artifacts
      // are submitted for the seal (fee from their real inventory).
      try {
        if (A && A.artifactsOfOwner) {
          for (const record of roster) {
            if (kingdomIdOfRecord(record) !== kid) continue;
            const name = usernameOf(record);
            const m = Guilds.memberOf(name);
            if (!m || m.suspended) continue;
            const owned = A.artifactsOfOwner(name) || [];
            for (const a of owned.slice(0, 3)) { // cap per tick per citizen
              if (!a || Guilds.sealFor(a.id)) continue;
              const bot = botFor(director, record);
              const res = Guilds.authenticateArtifact(name, a.id,
                (who, coins) => bot && hasItem(bot, Guilds.COINS_ID, coins) && removeItem(bot, Guilds.COINS_ID, coins),
                (who, coins) => bot ? giveItem(bot, Guilds.COINS_ID, coins) : false);
              if (res.ok) {
                journal("digguild_authenticated", { kingdomId: kid, artifactId: a.id, grade: res.grade, by: name });
                if (res.owed > 0) {
                  announce(director, kid,
                    `The Excavators' Guild sealed ${name}'s ${a.name} (grade ${res.grade}) — bounty owed when the treasury refills.`, nowMs);
                }
              }
            }
          }
        }
      } catch { /* auto-submit failure never breaks the tick */ }

      // --- forgery auto-scan: one scan per member artifact per process
      try {
        if (A && A.artifactsOfOwner) {
          for (const record of roster) {
            if (kingdomIdOfRecord(record) !== kid) continue;
            const name = usernameOf(record);
            if (!Guilds.isGuildMember(name)) continue;
            const owned = A.artifactsOfOwner(name) || [];
            for (const a of owned) {
              if (!a) continue;
              const key = `${kid}:${a.id}`;
              if (seenForgery.has(key)) continue;
              const kind = Guilds.scanForgery(a.id);
              if (kind) {
                seenForgery.add(key);
                Guilds.reportForgery(kid, a.id, "guild");
                announce(director, kid,
                  `The Excavators' Guild opened a forgery case over a suspect artifact.`, nowMs);
              }
            }
          }
        }
      } catch { /* scan failure never breaks the tick */ }

      // --- settle ripe forgery cases
      try {
        const settled = Guilds.settleRipeCases(kid, nowMs);
        for (const s of settled) {
          if (s.guilty) {
            announce(director, kid,
              `The Excavators' Guild expelled ${s.accused} for forgery — the fake goes to the museum.`, nowMs);
            journal("digguild_expulsion", { kingdomId: kid, accused: s.accused });
          }
        }
      } catch { /* never breaks the tick */ }

      // --- site inspections (conservators inspect active dig sites)
      try {
        const lastI = lastInspect.get(kid) || 0;
        if (A && A.activeSites && nowMs - lastI >= INSPECT_COOLDOWN_MS) {
          lastInspect.set(kid, nowMs);
          const sites = A.activeSites(kid) || [];
          for (const site of sites.slice(0, 5)) { // cap per tick
            const r = Guilds.inspectSite(site.id);
            if (r.ok && r.result === "FLAG") {
              announce(director, kid,
                `Guild inspection: ${site.name} — ${r.reasons.join("; ")}.`, nowMs);
              journal("digguild_inspection", { kingdomId: kid, siteId: site.id, reasons: r.reasons });
            }
          }
        }
      } catch { /* inspection failure never breaks the tick */ }

      // --- field school (conservator teaches diggers/excavators)
      try {
        const lastC = lastClass.get(kid) || 0;
        if (nowMs - lastC >= CLASS_COOLDOWN_MS) {
          lastClass.set(kid, nowMs);
          const master = roster.map(usernameOf).find((n) => Guilds.guildRankOf(n) === Guilds.RANK_CONSERVATOR);
          if (master) {
            const res = Guilds.holdClass(kid, master);
            if (res.ok && res.taught > 0) {
              announce(director, kid,
                `The Excavators' Guild held field school — ${res.taught} students drilled.`, nowMs);
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
  lastInspect.clear();
  seenForgery.clear();
}

module.exports = {
  tickDigGuildLife,
  resetForTests,
};
