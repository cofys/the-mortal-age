"use strict";

/**
 * CitizenFestivalGames — citizens compete in festival games: wrestling,
 * archery, pie-eating contests, and dance competitions.
 *
 * WHAT IT DOES (data tier, free):
 *   During each realm festival (from CitizenFestivals' calendar), a per-day
 *   games schedule is derived from date + kingdom hashes — which games run,
 *   who competes, and who wins. Winners are journaled once per festival day.
 *   No disk state, no storage, zero LLM.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Citizens near a player during a festival announce the day's games,
 *   cheer on competitors with scripted lines, and celebrate winners with
 *   fanfare. Players can join in (the join dialogue is LLM; this module
 *   tracks the ledger), place bets, or cheer.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 * This is an ACTIVITY system, not a profession — any citizen can compete,
 * no exclusions (chain saturation does not apply).
 *
 * Wired into the director tick right after CitizenFestivals. Plain-node
 * testable: CitizenFestivalGames.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const GAMES_RADIUS = 14; // tiles — close enough to see/hear
const GAMES_CITIZEN_COOLDOWN_MS = 2 * 60 * 60 * 1000; // a citizen fires at most every 2h
const GAMES_CHANCE = 0.35; // per eligible citizen per tick
const GAME_ANNOUNCE_CHANCE = 0.4; // chance the line announces rather than cheers
const MAX_COMPETITORS_SHOWN = 3; // how many competitor names in an announcement

// === Game types ===
const GAME_WRESTLING = "wrestling";
const GAME_ARCHERY = "archery";
const GAME_PIE_EATING = "pie-eating";
const GAME_DANCE = "dance";
const GAME_TYPES = [GAME_WRESTLING, GAME_ARCHERY, GAME_PIE_EATING, GAME_DANCE];

const GAME_NAMES = {
  [GAME_WRESTLING]: "the wrestling ring",
  [GAME_ARCHERY]: "the archery butts",
  [GAME_PIE_EATING]: "the pie-eating contest",
  [GAME_DANCE]: "the dance competition",
};

const GAME_VERBS = {
  [GAME_WRESTLING]: "wrestle",
  [GAME_ARCHERY]: "shoot",
  [GAME_PIE_EATING]: "eat",
  [GAME_DANCE]: "dance",
};

// === Scripted lines ===
const ANNOUNCE_LINES = [
  "Hear ye! {game} starts at the {venue} — competitors wanted!",
  "The {game} is on! Who'll {verb} for {kingdom}?",
  "Step right up! {game} at the {venue} — glory awaits!",
  "{game} begins shortly! Bring your courage and your appetite!",
];

const CHEER_LINES = {
  [GAME_WRESTLING]: [
    "Go on! Throw him! Throw him!",
    "What a grapple! The crowd roars!",
    "He's got the hold! He's got it!",
  ],
  [GAME_ARCHERY]: [
    "Bullseye! Did you see that shot?",
    "Steady... loose! A hit!",
    "The arrows fly true today!",
  ],
  [GAME_PIE_EATING]: [
    "Another pie! He's barely chewing!",
    "Look at him go! Pie number seven!",
    "The crusts are piling up!",
  ],
  [GAME_DANCE]: [
    "What footwork! The crowd claps along!",
    "She dances like the wind itself!",
    "Encore! Encore!",
  ],
};

const WINNER_LINES = [
  "Victory! {winner} takes {game} for {kingdom}!",
  "The champion! {winner} wins {game}! Three cheers!",
  "Huzzah! {winner} is the {game} champion!",
];

const PLAYER_INVITE_LINES = [
  "You look sturdy — fancy a bout at {game}?",
  "Care to test yourself at {game}? The prize is glory!",
  "The {game} needs one more competitor — how about you?",
];

const BET_LINES = [
  "Two to one on {name} at {game}!",
  "I'll wager five coins on {name}!",
  "The smart money's on {name} at {game}!",
];

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const announcedToday = new Map(); // "kingdom:day:game" -> true (one announcement per game per day)

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of announcedToday) {
    if (at < cutoff) announcedToday.delete(k);
  }
}

// === Player participation ledgers (data tier, zero LLM) ===
const competitors = new Map(); // normName -> { game, kingdom, at }
const bets = new Map(); // normName -> { on, amount, at }
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of competitors) {
    if (nowMs - v.at > LEDGER_TTL_MS) competitors.delete(k);
  }
  for (const [k, v] of bets) {
    if (nowMs - v.at > LEDGER_TTL_MS) bets.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** Cheap rng from a seed (LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

/**
 * The active festival today, or null. Reads the real CitizenFestivals
 * calendar (activeFestival is the verified export) so games only run
 * during actual festivals.
 */
function festivalToday(nowMs) {
  try {
    const festivals = require("./CitizenFestivals");
    if (typeof festivals.activeFestival === "function") {
      return festivals.activeFestival(nowMs);
    }
    // Fallback: check the FESTIVALS array directly (3-day festivals,
    // matching CitizenFestivals' FESTIVAL_DURATION_DAYS).
    if (Array.isArray(festivals.FESTIVALS)) {
      const d = new Date(nowMs);
      const month = d.getMonth();
      const day = d.getDate();
      for (const f of festivals.FESTIVALS) {
        if (f.month === month && day >= f.startDay && day < f.startDay + 3) {
          return f;
        }
      }
    }
  } catch { /* module absent */ }
  return null;
}

/**
 * The day's games for a kingdom: 2-3 game types derived from date + kingdom.
 * Zero storage.
 */
function gamesForDay(kingdomId, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("festivalgames:" + (kingdomId || "none") + ":" + day));
  const count = 2 + Math.floor(rng() * 2); // 2-3 games
  const pool = [...GAME_TYPES];
  const out = [];
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * The competitors for a game today: 3-5 citizen names derived from
 * date + kingdom + game. Returns display names (not normalized).
 * The roster is passed in so names come from real citizens.
 */
function competitorsFor(game, kingdomId, dateMs, rosterNames) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("gamecompetitors:" + game + ":" + (kingdomId || "none") + ":" + day));
  const pool = [...(rosterNames || [])];
  const count = Math.min(3 + Math.floor(rng() * 3), pool.length); // 3-5
  const out = [];
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * The winner of a game today: one of the competitors, derived deterministically.
 */
function winnerFor(game, kingdomId, dateMs, rosterNames) {
  const comps = competitorsFor(game, kingdomId, dateMs, rosterNames);
  if (!comps.length) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("gamewinner:" + game + ":" + (kingdomId || "none") + ":" + day));
  return comps[Math.floor(rng() * comps.length)];
}

/** Human-readable kingdom name. */
function kingdomName(kid) {
  const names = {
    misthalin: "Misthalin",
    asgarnia: "Asgarnia",
    kandarin: "Kandarin",
    keldagrim: "Keldagrim",
    morytania: "Morytania",
    kharidian: "the Kharidian",
  };
  return names[kid] ?? "the kingdom";
}

/** Venue name for a game in a kingdom. */
function venueFor(game, kingdomId) {
  const venues = {
    [GAME_WRESTLING]: "the festival green",
    [GAME_ARCHERY]: "the archery field",
    [GAME_PIE_EATING]: "the feast tent",
    [GAME_DANCE]: "the dance floor",
  };
  return venues[game] ?? "the festival grounds";
}

// ============================================================================
// Player participation (data tier, zero LLM).
// ============================================================================

/** A player enters a game as a competitor. */
function enterGame(playerName, game, kingdomId, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !GAME_TYPES.includes(game)) return null;
  pruneLedgers(nowMs);
  competitors.set(name, { game, kingdom: kingdomId, at: nowMs });
  return game;
}

/** What game a player entered, or null. */
function entryFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = competitors.get(name);
  return rec ? rec.game : null;
}

/** A player bets on a competitor. Amount in coins. */
function placeBet(playerName, onName, amount, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const on = normalizeName(onName);
  if (!name || !on) return null;
  const amt = Math.max(0, Math.floor(amount ?? 0));
  if (amt <= 0) return null;
  pruneLedgers(nowMs);
  bets.set(name, { on, amount: Math.min(amt, 25000), at: nowMs });
  return amt;
}

/** A player's bet, or null. */
function betFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  return bets.get(name) ?? null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

/**
 * Journal a games event for the LLM foreground tier (it reads the journal
 * when a player asks what happened). Uses the real CitizenJournal API:
 * getJournal().log(citizenName, kind, text). Same "social" kind as the
 * other activity systems (CitizenActivityParties). Never breaks the tick.
 */
function journalize(citizenName, kind, text) {
  try {
    require("./CitizenJournal").getJournal().log(citizenName, kind, text);
  } catch { /* journal absent — never break the tick */ }
}

function seedRumor(text) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(text);
  } catch { /* rumors absent */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → festival? → materialized →
// real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickFestivalGames(director, nowMs) {
  pruneCooldowns(nowMs);
  // No games outside festivals — cheap early exit.
  const festival = festivalToday(nowMs);
  if (!festival) return;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < GAMES_CITIZEN_COOLDOWN_MS) continue;

        // 2. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 3. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, GAMES_RADIUS)) continue;

        // 4. Chance gate
        if (!chance(Math.random, GAMES_CHANCE)) continue;

        // 5. Do the thing (scripted, zero LLM)
        doGameWork(director, record, citizen, festival, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-festivalgames] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-festivalgames] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doGameWork(director, record, citizen, festival, nowMs) {
  const kingdomId = record.kingdomId;
  const games = gamesForDay(kingdomId, nowMs);
  if (!games.length) return;
  const day = dayNumber(nowMs);

  // Pick today's game for this citizen (stable per citizen per day).
  const game = games[hashStr("mygame:" + normalizeName(record.username) + ":" + day) % games.length];
  const venue = venueFor(game, kingdomId);
  const kName = kingdomName(kingdomId);
  const slots = { game: GAME_NAMES[game], verb: GAME_VERBS[game], venue, kingdom: kName };

  const roll = Math.random();
  if (roll < GAME_ANNOUNCE_CHANCE) {
    // Announce the game (once per kingdom per game per day).
    const key = kingdomId + ":" + day + ":" + game;
    if (!announcedToday.has(key)) {
      announcedToday.set(key, nowMs);
      const line = fill(pickOne(Math.random, ANNOUNCE_LINES), slots);
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(record.username, "social", `announced ${GAME_NAMES[game]} at the festival`);
      return;
    }
  }

  if (roll < 0.7) {
    // Cheer on the competitors.
    const line = pickOne(Math.random, CHEER_LINES[game]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    return;
  }

  if (roll < 0.85) {
    // Celebrate today's winner (derived — same for everyone).
    const rosterNames = [];
    try {
      for (const r of director.roster?.values?.() ?? []) {
        if (r.kingdomId === kingdomId) rosterNames.push(r.username);
        if (rosterNames.length >= 30) break;
      }
    } catch { /* ignore */ }
    const winner = winnerFor(game, kingdomId, nowMs, rosterNames);
    if (winner) {
      const line = fill(pickOne(Math.random, WINNER_LINES), {
        ...slots,
        winner,
      });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(record.username, "social", `cheered ${winner}'s victory at ${GAME_NAMES[game]}`);
      // Seed the win into rumors once per game per day.
      const rkey = "win:" + kingdomId + ":" + day + ":" + game;
      if (!announcedToday.has(rkey)) {
        announcedToday.set(rkey, nowMs);
        seedRumor(`${winner} won ${GAME_NAMES[game]} at the ${festival.name}!`);
      }
      return;
    }
  }

  // Invite the player to join, or talk bets.
  if (Math.random() < 0.5) {
    const line = fill(pickOne(Math.random, PLAYER_INVITE_LINES), slots);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } else {
    const rosterNames = [];
    try {
      for (const r of director.roster?.values?.() ?? []) {
        if (r.kingdomId === kingdomId) rosterNames.push(r.username);
        if (rosterNames.length >= 30) break;
      }
    } catch { /* ignore */ }
    const comps = competitorsFor(game, kingdomId, nowMs, rosterNames);
    if (comps.length) {
      const line = fill(pickOne(Math.random, BET_LINES), {
        ...slots,
        name: comps[0],
      });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    }
  }
}

module.exports = {
  tickFestivalGames,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  enterGame,
  entryFor,
  placeBet,
  betFor,
  gamesForDay,
  competitorsFor,
  winnerFor,
  festivalToday,
  venueFor,
  kingdomName,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  seededRng,
  dayNumber,
  chance,
  isRealPlayer,
  withinTiles,
  GAME_TYPES,
  GAME_WRESTLING,
  GAME_ARCHERY,
  GAME_PIE_EATING,
  GAME_DANCE,
  GAME_NAMES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    announcedToday.clear();
    competitors.clear();
    bets.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
