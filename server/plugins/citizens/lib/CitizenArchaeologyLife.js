"use strict";

/**
 * CitizenArchaeologyLife — the slow-tick dynamics for the real archaeology layer.
 *
 * No-overlap boundary:
 *   - CitizenExplorers owns expeditions and discovery rolls. This only reads
 *     FINISHED expeditions through the public finishedExpeditions() seam and
 *     founds dig sites from the ancient-smelling ones.
 *   - CitizenArt owns gallery flavor. This owns museum curation records.
 *
 * Tick-safe: never throws. Every engine read is guarded. Missing modules
 * degrade to a no-op rather than breaking the director tick.
 */

const { sayPublic } = require("../chat/CitizenSayPublic");
const { voiceFor, voiceLine } = require("./citizenVoice");

const SITE_FOUND_COOLDOWN_MS = 6 * 60 * 60 * 1000; // new sites at most every 6h per kingdom
const DIG_COOLDOWN_MS = 2 * 60 * 60 * 1000; // ambient digs at most every 2h per kingdom
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastSiteFound = new Map(); // kingdomId -> timestamp
const lastDig = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp

function archApi() {
  try { return require("./CitizenArchaeology"); }
  catch { return null; }
}

function explorersApi() {
  try { return require("./CitizenExplorers"); }
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

function realPlayersNear(director, tile, radius) {
  try {
    // director.getRealPlayers doesn't exist on the real CitizenDirector —
    // scan materialized citizens' getLocalPlayers (the canonical engine
    // seam) for real players within radius of the tile.
    if (!tile) return [];
    const { isRealPlayer } = require("../chat/CitizenSayPublic");
    const roster = director?.roster?.values?.() ?? [];
    for (const record of roster) {
      let bot = null;
      try { bot = director?.getBot ? director.getBot(record) : null; }
      catch { continue; }
      const locals = bot?.getLocalPlayers?.() ?? [];
      for (const p of locals) {
        try {
          const real = isRealPlayer ? isRealPlayer(p) : (p?.isRealPlayer?.() ?? !p?.isBot);
          if (!real) continue;
          const pos = p.getPosition?.() ?? p.position;
          if (!pos) continue;
          if (Math.hypot((pos.x ?? 0) - tile.x, (pos.y ?? 0) - tile.y) <= (radius ?? 14)) return [p];
        } catch { /* one bad player never breaks the scan */ }
      }
    }
    return [];
  } catch { return []; }
}

/**
 * Register curious/history-loving online citizens (or archaeologist-career
 * citizens) as real archaeologists. Honest: only online citizens with
 * readable identity — no bot, no entry.
 */
function registerArchaeologists(director, Arch) {
  let n = 0;
  for (const record of onlineRoster(director)) {
    try {
      const username = usernameOf(record);
      if (!username || Arch.isArchaeologist(username)) continue;
      const p = personalityOf(record);
      const curious = (p.curiosity ?? p.openness ?? 0) >= 0.5;
      const scholarly = (p.scholarliness ?? p.wisdom ?? 0) >= 0.5;
      const career = String(record.career || record.role || "").toLowerCase();
      if (!curious && !scholarly && career !== "archaeologist") continue;
      const kingdomId = kingdomIdOf(record);
      if (!kingdomId) continue;
      const res = Arch.registerArchaeologist(username, kingdomId);
      if (res.ok && !res.already) n++;
    } catch { /* one bad record never breaks registration */ }
  }
  return n;
}

/**
 * Found dig sites from fresh finished expeditions. Only discoveries that
 * smell ancient qualify — the honesty rule: no invented geography.
 * Idempotent via sitedDiscoveries (first-ever founding always allowed).
 */
function foundSitesFromExpeditions(director, Arch, Explorers, nowMs) {
  let n = 0;
  let expeditions = [];
  try {
    expeditions = Explorers.finishedExpeditions(nowMs, 48 * 3600 * 1000) || [];
  } catch { return 0; }
  for (const exp of expeditions) {
    try {
      const kingdomId = exp.kingdomId;
      if (!kingdomId) continue;
      const last = lastSiteFound.get(kingdomId) || 0;
      if (last > 0 && nowMs - last < SITE_FOUND_COOLDOWN_MS) continue;
      for (const d of exp.discoveries || []) {
        if (!Arch.discoveryIsDiggable(d)) continue;
        const res = Arch.foundSiteFromDiscovery(exp.id, d, kingdomId, exp.leader);
        if (res.ok && !res.already && res.site) {
          n++;
          lastSiteFound.set(kingdomId, nowMs);
          announceSite(director, Arch, res.site, nowMs);
          break; // one site per expedition per tick is plenty
        }
      }
    } catch { /* one bad expedition never breaks founding */ }
  }
  return n;
}

function announceSite(director, Arch, site, nowMs) {
  try {
    const last = lastAnnounce.get(site.kingdomId) || 0;
    if (last > 0 && nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    const museum = Arch.ensureMuseum(site.kingdomId);
    const near = realPlayersNear(director, museum.tile, 16);
    if (!near.length) return;
    const bot = director.getBot ? director.getBot({ username: site.founder }) : null;
    const speaker = bot || near[0];
    const p = {};
    sayPublic(speaker, voiceLine(voiceFor(p), {
      plain: [`Word is there's a dig starting at ${site.name} — old bones under old stones.`],
    }));
    lastAnnounce.set(site.kingdomId, nowMs);
  } catch { /* announcements are best-effort */ }
}

/**
 * Ambient excavation: one registered archaeologist per kingdom per cooldown
 * works an active site. The artifact is REAL (persistent record, real value).
 * Major finds are announced near real players.
 */
function ambientDigging(director, Arch, nowMs) {
  let n = 0;
  const kingdoms = new Set();
  for (const record of onlineRoster(director)) {
    try {
      const username = usernameOf(record);
      if (!username || !Arch.isArchaeologist(username)) continue;
      const kingdomId = kingdomIdOf(record);
      if (!kingdomId || kingdoms.has(kingdomId)) continue;
      const last = lastDig.get(kingdomId) || 0;
      if (last > 0 && nowMs - last < DIG_COOLDOWN_MS) continue; // first dig always allowed
      const sites = Arch.activeSites(kingdomId);
      if (!sites.length) continue;
      // Work the richest active site — a human digs where the finds are.
      const site = sites.sort((a, b) => b.richness - a.richness)[0];
      const res = Arch.excavate(username, site.id);
      if (res.ok) {
        n++;
        kingdoms.add(kingdomId);
        lastDig.set(kingdomId, nowMs);
        awardFame(director, username, res.major ? "relichunter" : null);
        if (res.major) announceMajorFind(director, Arch, site, res.artifact, nowMs);
      }
    } catch { /* one bad citizen never breaks digging */ }
  }
  return n;
}

function announceMajorFind(director, Arch, site, artifact, nowMs) {
  try {
    const last = lastAnnounce.get(`major:${site.kingdomId}`) || 0;
    if (last > 0 && nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    const museum = Arch.ensureMuseum(site.kingdomId);
    const near = realPlayersNear(director, museum.tile, 16);
    if (!near.length) return;
    const bot = director.getBot ? director.getBot({ username: artifact.finder }) : null;
    const speaker = bot || near[0];
    const p = {};
    sayPublic(speaker, voiceLine(voiceFor(p), {
      plain: [`They pulled ${artifact.name} from ${site.name} — worth a fortune, they say!`],
    }));
    lastAnnounce.set(`major:${site.kingdomId}`, nowMs);
  } catch { /* announcements are best-effort */ }
}

function awardFame(director, username, deed) {
  if (!deed) return;
  try {
    const Rep = require("./CitizenReputation");
    Rep.awardDeed?.(username, deed);
  } catch { /* fame is best-effort */ }
}

function tickArchLife(director, nowMs) {
  try {
    const Arch = archApi();
    if (!Arch) return;
    const Explorers = explorersApi();
    const now = nowMs ?? Date.now();
    registerArchaeologists(director, Arch);
    if (Explorers) foundSitesFromExpeditions(director, Arch, Explorers, now);
    ambientDigging(director, Arch, now);
    try { Arch.pruneSites(now); } catch { /* ignore */ }
  } catch { /* the tick never throws */ }
}

function resetForTests() {
  lastSiteFound.clear();
  lastDig.clear();
  lastAnnounce.clear();
}

module.exports = { tickArchLife, resetForTests };
