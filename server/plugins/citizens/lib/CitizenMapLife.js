"use strict";

/**
 * CitizenMapLife — the slow-tick dynamics for the real cartography layer.
 *
 * No-overlap boundary:
 *   - CitizenCartographers owns hash-derived cartographer flavor (visible
 *     work loops, hawking, commission flavor).
 *   - This owns: cartographer REGISTRATION from real online citizens,
 *     ambient map drafting (real materials, real records), treasure-cache
 *     expiry, exploration-log recording from real CitizenTravel journeys,
 *     and masterwork announcements near real players.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // masterworks at most every 6h
const DRAFT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // ambient drafting at most every 3h
const lastAnnounce = new Map(); // kingdomId -> timestamp
const lastDraft = new Map(); // kingdomId -> timestamp

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

function personalityOf(record) {
  try {
    const p = record.personality ?? record.attrs?.["citizens:personality"];
    return p && typeof p === "object" ? p : {};
  } catch { return {}; }
}

function kingdomIdOf(record) {
  try {
    const { kingdomIdOf } = require("../brain/CitizenSites");
    return kingdomIdOf(record) || record.kingdomId || null;
  } catch { return record.kingdomId || null; }
}

function usernameOf(record) {
  return record.username || record.name || null;
}

/**
 * Register curious/adventurous online citizens (or cartographer-career
 * citizens) as real cartographers. Honest: only online citizens with
 * readable identity are registered — no bot, no skill means no entry.
 */
function registerCartographers(director, Maps) {
  let n = 0;
  for (const record of onlineRoster(director)) {
    try {
      const username = usernameOf(record);
      if (!username || Maps.isCartographer(username)) continue;
      const p = personalityOf(record);
      const curious = (p.curiosity ?? p.openness ?? 0) >= 0.5;
      const adventurous = (p.adventurousness ?? 0) >= 0.5;
      const career = String(record.career || record.role || "").toLowerCase();
      if (!curious && !adventurous && career !== "cartographer") continue;
      const kingdomId = kingdomIdOf(record);
      if (!kingdomId) continue;
      const res = Maps.registerCartographer(username, kingdomId);
      if (res.ok && !res.already) n++;
    } catch { /* one bad record never breaks registration */ }
  }
  return n;
}

/**
 * Ambient drafting: registered cartographers with real papyrus draft real
 * maps between slow ticks. The life tick consumes the papyrus from the
 * citizen's real inventory first (honest — no papyrus, no map), then
 * records the draft. This is how the world gets mapped even when nobody
 * is running the brain action.
 */
function ambientDrafting(director, Maps, nowMs) {
  let n = 0;
  const kingdoms = new Set();
  for (const record of onlineRoster(director)) {
    try {
      const username = usernameOf(record);
      if (!username || !Maps.isCartographer(username)) continue;
      const kingdomId = kingdomIdOf(record);
      if (!kingdomId) continue;
      if (kingdoms.has(kingdomId)) continue;
      const last = lastDraft.get(kingdomId) || 0;
      if (last > 0 && nowMs - last < DRAFT_COOLDOWN_MS) continue; // first draft always allowed
      const bot = director.getBot ? director.getBot(record) : null;
      if (!bot) continue;
      // Honest material check: real papyrus from the real inventory.
      if (!hasItem(bot, Maps.MAT_PAPYRUS, 1)) continue;
      if (!removeItem(bot, Maps.MAT_PAPYRUS, 1)) continue;
      const type = pickDraftType(Maps);
      const res = Maps.draftMap(username, kingdomId, type);
      if (res.ok) {
        n++;
        kingdoms.add(kingdomId);
        lastDraft.set(kingdomId, nowMs);
        Maps.listMap(res.map.id);
        if (res.masterwork) announceMasterwork(director, Maps, kingdomId, res.map, nowMs);
        awardFame(director, username, res.masterwork ? "master_cartographer" : null);
      }
    } catch { /* one bad citizen never breaks drafting */ }
  }
  return n;
}

function pickDraftType(Maps) {
  // Prefer dungeon/treasure maps when real discoveries exist (real
  // geography to chart), otherwise alternate world/city.
  const hasDiscovery = (() => {
    try {
      const Disc = require("./CitizenDiscovery");
      return (Disc.allDiscoveries?.() ?? []).length > 0;
    } catch { return false; }
  })();
  if (hasDiscovery && Math.random() < 0.4) return Math.random() < 0.5 ? Maps.MAP_DUNGEON : Maps.MAP_TREASURE;
  return Math.random() < 0.5 ? Maps.MAP_WORLD : Maps.MAP_CITY;
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

function awardFame(director, username, deed) {
  if (!deed) return;
  try {
    const Rep = require("./CitizenReputation");
    Rep.awardDeed?.(username, deed);
  } catch { /* fame is optional */ }
}

function announceMasterwork(director, Maps, kingdomId, map, nowMs) {
  try {
    const last = lastAnnounce.get(kingdomId) || 0;
    if (last > 0 && nowMs - last < ANNOUNCE_COOLDOWN_MS) return; // first announcement always allowed
    lastAnnounce.set(kingdomId, nowMs);
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const label = { world: "world chart", city: "city map", dungeon: "dungeon chart", treasure: "treasure map" }[map.type] || "map";
    const bot = nearestBot(director, kingdomId);
    if (bot && sayPublic) {
      sayPublic(bot, `${map.creator} has completed a masterwork ${label} — on sale at the map shop!`);
    }
    try {
      const { getJournal } = require("./CitizenJournal");
      getJournal().log?.("masterwork-map", { creator: map.creator, type: map.type, kingdomId });
    } catch { /* journal optional */ }
  } catch { /* announcements never break the tick */ }
}

function nearestBot(director, kingdomId) {
  try {
    for (const record of onlineRoster(director)) {
      if (String(kingdomIdOf(record)) !== String(kingdomId)) continue;
      const bot = director.getBot ? director.getBot(record) : null;
      if (bot) return bot;
    }
  } catch { /* none */ }
  return null;
}

/**
 * Record exploration logs from real CitizenTravel journeys. Defensive:
 * reads the travel module's journey records; nothing happens when travel
 * is unavailable. Logs raise the author's next-map quality.
 */
function recordJourneyLogs(Maps, nowMs) {
  let n = 0;
  try {
    const Travel = require("./CitizenTravel");
    const journeys = typeof Travel.dueArrivals === "function"
      ? Travel.dueArrivals(nowMs)
      : [];
    for (const j of journeys) {
      if (!j || j.logged) continue;
      const res = Maps.recordLog(j.username, j.from, j.to, j.mode);
      if (res.ok) { n++; j.logged = true; }
    }
  } catch { /* travel module unavailable */ }
  return n;
}

/**
 * Expire old treasure caches. Real coins left unclaimed return to the
 * void — honestly, nobody gets them; they simply stop existing.
 */
function expireCaches(Maps) {
  try { return Maps.pruneCaches(); }
  catch { return 0; }
}

function tickMapLife(director, nowMs) {
  const Maps = mapsApi();
  if (!Maps) return;
  try { registerCartographers(director, Maps); } catch {}
  try { ambientDrafting(director, Maps, nowMs); } catch {}
  try { recordJourneyLogs(Maps, nowMs); } catch {}
  try { expireCaches(Maps); } catch {}
}

function resetForTests() {
  lastAnnounce.clear();
  lastDraft.clear();
}

module.exports = { tickMapLife, resetForTests };
