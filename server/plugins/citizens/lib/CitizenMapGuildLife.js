"use strict";

/**
 * CitizenMapGuildLife — the slow-tick dynamics for the Grand Cartographers' Guild.
 *
 * No-overlap boundary:
 *   - CitizenMapLife owns: cartographer registration + ambient map drafting.
 *   - This owns: guild dues, certification review, survey bounties,
 *     mentorship bookkeeping, promotion, and guild announcements.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const Guilds = require("./CitizenMapGuilds");

const TICK_COOLDOWN_MS = 30 * 60 * 1000; // heavy guild business at most every 30 min
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // guild news at most every 6h per kingdom
const lastTick = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp

function mapsApi() {
  try { return require("./CitizenMaps"); }
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
  return record.username || record.name || null;
}

function kingdomIdOf(record) {
  // Roster records are plain objects with a real kingdomId field — they are
  // NOT player entities, so CitizenSites.kingdomIdOf(record) would silently
  // return KINGDOM_IDS[0] (it needs player.getAttribute). Prefer the real
  // record field; use the sites seam only for actual player entities.
  if (record && typeof record.getAttribute === "function") {
    try {
      const { kingdomIdOf } = require("../brain/CitizenSites");
      return kingdomIdOf(record) || record.kingdomId || null;
    } catch { return record.kingdomId || null; }
  }
  return record?.kingdomId || null;
}

function hasItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    if (typeof inv.count === "function") return inv.count(itemId) >= amount;
    if (Array.isArray(inv.items)) {
      return inv.items.filter((i) => (i?.id ?? i) === itemId).length >= amount;
    }
    return false;
  } catch { return false; }
}

function removeItem(bot, itemId, amount) {
  try {
    const inv = bot.inventory ?? bot.getInventory?.();
    if (!inv) return false;
    if (typeof inv.remove === "function") { inv.remove(itemId, amount); return true; }
    if (typeof inv.delete === "function") { inv.delete(itemId, amount); return true; }
    return false;
  } catch { return false; }
}

function awardDeed(username, deedKind) {
  try {
    const Rep = require("./CitizenReputation");
    Rep.awardDeed?.(username, deedKind);
  } catch { /* fame is optional */ }
}

// Canonical journal shape (CitizenJournal.js:79): log(citizenName, kind,
// text, opts). The old 2-arg call passed the data object as `kind` with no
// `text`, so log() returned null silently and guild events were never recorded.
function journal(citizenName, kind, text, data) {
  try {
    if (!citizenName || !text) return;
    const { getJournal } = require("./CitizenJournal");
    getJournal().log?.(citizenName, kind, text, data ? { data } : {});
  } catch { /* journal optional */ }
}

function nearestBot(director, kingdomId) {
  try {
    for (const record of onlineRoster(director)) {
      if (kingdomIdOf(record) !== kingdomId) continue;
      const bot = director.getBot ? director.getBot(record) : null;
      if (bot) return bot;
    }
  } catch { /* no bot */ }
  return null;
}

function announce(director, kingdomId, citizenName, text, kind, nowMs) {
  try {
    const last = lastAnnounce.get(kingdomId) || 0;
    if (last > 0 && nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    lastAnnounce.set(kingdomId, nowMs);
    const bot = nearestBot(director, kingdomId);
    if (bot) {
      const { sayPublic } = require("../chat/CitizenSayPublic");
      if (sayPublic) sayPublic(bot, text);
    }
    journal(citizenName, kind, text, { kingdomId });
  } catch { /* announcements never break the tick */ }
}

function kingdomIds() {
  try {
    const { KINGDOM_IDS } = require("../brain/CitizenSites");
    return Array.isArray(KINGDOM_IDS) ? KINGDOM_IDS : [];
  } catch { return []; }
}

/**
 * Dues: guild members who are ONLINE pay real weekly dues from their real
 * inventory. Offline members are skipped (no penalty for not being around).
 * Two consecutive missed online collections -> suspended.
 */
function collectDues(director, nowMs) {
  let collected = 0, suspended = 0;
  for (const record of onlineRoster(director)) {
    try {
      const username = usernameOf(record);
      if (!username) continue;
      const status = Guilds.duesStatus(username);
      if (!status || status.suspended || !status.overdue) continue;
      const bot = director.getBot ? director.getBot(record) : null;
      if (!bot) continue; // not really online — skip, no penalty
      if (hasItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY) && removeItem(bot, Guilds.COINS_ID, Guilds.DUES_WEEKLY)) {
        const mem = Guilds.memberOf(username);
        if (mem) Guilds.creditTreasury(mem.kingdomId, Guilds.DUES_WEEKLY);
        Guilds.recordDuesPaid(username, nowMs);
        collected++;
      } else {
        if (Guilds.recordDuesMissed(username)) {
          suspended++;
          journal(username, "guild-suspended",
            `${username} was suspended from the cartographers' guild — dues missed twice.`,
            { username });
        }
      }
    } catch { /* one bad citizen never breaks dues */ }
  }
  return { collected, suspended };
}

/**
 * Auto-certification: guild members' newly listed high-quality maps are
 * submitted for guild review. The certification fee comes from the member's
 * real inventory (waived while mentored); broke or offline members wait.
 */
function autoSubmit(director, Maps, nowMs) {
  if (!Maps) return 0;
  let n = 0;
  const st = { seen: null };
  for (const record of onlineRoster(director)) {
    try {
      const username = usernameOf(record);
      if (!username || !Guilds.isGuildMember(username)) continue;
      const kingdomId = kingdomIdOf(record);
      if (!kingdomId) continue;
      const bot = director.getBot ? director.getBot(record) : null;
      if (!bot) continue;
      let listings = [];
      try { listings = Maps.listingsFor(kingdomId) || []; } catch { continue; }
      for (const l of listings) {
        const map = l?.map;
        if (!map || norm2(map.creator) !== norm2(username)) continue;
        const key = `${kingdomId}:${map.id}`;
        if (seenListing(key)) continue;
        markSeenListing(key);
        const quality = Number(map.quality) || 0;
        if (quality < Guilds.CERT_MIN_QUALITY) continue;
        if (Guilds.isCertified(map.id)) continue;
        // Fee: waived for mentored apprentices, otherwise real coins.
        const mentored = !!Guilds.mentorOf(username);
        if (!mentored) {
          if (!hasItem(bot, Guilds.COINS_ID, Guilds.CERT_FEE)) continue;
          if (!removeItem(bot, Guilds.COINS_ID, Guilds.CERT_FEE)) continue;
          Guilds.creditTreasury(kingdomId, Guilds.CERT_FEE);
        }
        const res = Guilds.submitForCertification(username, map.id, kingdomId);
        if (res.ok) n++;
      }
    } catch { /* one bad citizen never breaks auto-submit */ }
  }
  return n;
}

// Listing-seen bookkeeping lives in a tiny module-local set so tests stay
// hermetic; it is rebuilt from the save on each process start is unnecessary
// because resubmission is idempotent (isCertified / queue guards).
const seenCache = new Set();
function seenListing(key) { return seenCache.has(key); }
function markSeenListing(key) { seenCache.add(key); if (seenCache.size > 5000) seenCache.clear(); }

function norm2(s) { return String(s || "").trim().toLowerCase(); }

function settleCertifications(director, nowMs) {
  const done = Guilds.processCertifications(nowMs);
  for (const cert of done) {
    try {
      const mem = Guilds.memberOf(cert.creator);
      if (mem) {
        if (mem.certCount >= 10) awardDeed(cert.creator, "masterofcharts");
        const promoted = Guilds.checkPromotion(cert.creator);
        if (promoted === Guilds.RANK_MASTER) {
          awardDeed(cert.creator, "guildmaster");
          journal(cert.creator, "guild-promotion",
            `${cert.creator} was raised to ${promoted} of the cartographers' guild.`,
            { username: cert.creator, rank: promoted, kingdomId: cert.kingdomId });
          announce(director, cert.kingdomId, cert.creator,
            `${cert.creator} has been raised to Guildmaster of the cartographers!`,
            "guild-master", nowMs);
        } else if (promoted) {
          journal(cert.creator, "guild-promotion",
            `${cert.creator} was raised to ${promoted} of the cartographers' guild.`,
            { username: cert.creator, rank: promoted, kingdomId: cert.kingdomId });
        }
      }
      if (cert.grade === "A") {
        announce(director, cert.kingdomId, cert.creator,
          `The guild seals ${cert.creator}'s ${cert.type} chart with the master seal — a flawless survey.`,
          "guild-certification", nowMs);
      }
      journal(cert.creator, "guild-certification",
        `${cert.creator}'s ${cert.type} chart was sealed by the guild — grade ${cert.grade}.`, {
        creator: cert.creator, type: cert.type, grade: cert.grade,
        kingdomId: cert.kingdomId, bountyPaid: cert.bountyPaid ?? 0, bountyOwed: cert.bountyOwed ?? 0,
      });
    } catch { /* one bad cert never breaks settlement */ }
  }
  return done.length;
}

function payOwedBounties(director) {
  // Certification bounties the treasury couldn't afford are paid when funds arrive.
  // Credits go to the creator's REAL bank account (works for offline citizens too).
  let paid = 0;
  try {
    const B = (() => { try { return require("./CitizenBanking"); } catch { return null; } })();
    for (const record of onlineRoster(director)) {
      const username = usernameOf(record);
      if (!username) continue;
      for (const cert of Guilds.certsByCreator(username)) {
        if (!(cert.bountyOwed > 0)) continue;
        // Credit the bank account BEFORE debiting the treasury — never mark
        // paid what was never delivered.
        let credited = false;
        try {
          const acct = B && typeof B.accountFor === "function" ? B.accountFor(username) : null;
          if (acct) {
            acct.balance = (Number(acct.balance) || 0) + cert.bountyOwed;
            if (typeof B.markDirty === "function") B.markDirty();
            credited = true;
          }
        } catch { /* banking is best-effort */ }
        if (!credited) continue; // banking down — stays owed
        if (!Guilds.debitTreasury(cert.kingdomId, cert.bountyOwed)) {
          // Treasury broke after all — roll back the bank credit.
          try {
            const acct = B.accountFor(username);
            acct.balance = (Number(acct.balance) || 0) - cert.bountyOwed;
            if (typeof B.markDirty === "function") B.markDirty();
          } catch { /* rollback is best-effort */ }
          continue;
        }
        journal(username, "guild-bounty-paid",
          `The guild paid ${username} ${cert.bountyOwed} owed coins for chart ${cert.mapId}.`,
          { username, mapId: cert.mapId, amount: cert.bountyOwed });
        cert.bountyOwed = 0;
        paid++;
      }
    }
  } catch { /* owed payouts never break the tick */ }
  return paid;
}

function tickMapGuildLife(director, nowMs) {
  try {
    const Maps = mapsApi();
    for (const kingdomId of kingdomIds()) {
      try {
        const last = lastTick.get(kingdomId) || 0;
        if (last > 0 && nowMs - last < TICK_COOLDOWN_MS) continue; // first run always allowed
        lastTick.set(kingdomId, nowMs);
        Guilds.ensureGuild(kingdomId);
      } catch { /* one bad kingdom never breaks the tick */ }
    }
    collectDues(director, nowMs);
    autoSubmit(director, Maps, nowMs);
    settleCertifications(director, nowMs);
    payOwedBounties(director);
    Guilds.expireBounties(nowMs);
    // Opportunistic promotion sweep (certifications usually promote already).
    try {
      for (const record of onlineRoster(director)) {
        const username = usernameOf(record);
        if (!username) continue;
        const promoted = Guilds.checkPromotion(username);
        if (promoted === Guilds.RANK_MASTER) {
          awardDeed(username, "guildmaster");
          journal(username, "guild-promotion",
            `${username} was raised to ${promoted} of the cartographers' guild.`,
            { username, rank: promoted });
        }
      }
    } catch { /* promotions never break the tick */ }
  } catch { /* the guild tick never breaks the director */ }
}

function resetForTests() {
  lastTick.clear();
  lastAnnounce.clear();
  seenCache.clear();
}

module.exports = { tickMapGuildLife, resetForTests };
