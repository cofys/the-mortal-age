"use strict";

/**
 * CitizenWorkLoops — ambient in-town craft-station work loops.
 *
 * Data tier, zero LLM. Periodically assigns IDLE COMMONERS already standing
 * near a known craft station (forge / anvil / range / workbench / market
 * stall) to a short (~60s) visible work loop: face the station, play the
 * trade's animation, emit occasional data-tier chatter, then release.
 * Journaled once per loop start ("work" kind) so the foreground LLM answers
 * "what have you been up to?" truthfully.
 *
 * Deliberately NOT CitizenSkilling:
 *   - CitizenSkilling runs wilderness sessions (trees / docks / rocks /
 *     tavern fire) with XP gain, item production, travel, parties, 8-14
 *     minute sessions, on the director tick whether or not anyone watches.
 *   - This module runs 60s ambient loops for commoners ALREADY near the
 *     station, grants NO XP, produces/consumes NO items, forms NO parties,
 *     moves NO citizens, and starts a loop ONLY while a real (non-bot)
 *     player is within 40 tiles — no wasted ticks, no empty-world noise.
 *   - Commoners in an active skilling session, party or follow are never
 *     poached (see eligibleForLoop).
 * Deliberately NOT CitizenDailyRoutines:
 *   - DailyRoutines covers merchant/guard SCHEDULED shifts (supplier forge
 *     shifts, stall phases on wall-clock time, journaled phase transitions).
 *   - This module covers unscheduled commoner micro-loops only; merchants
 *     and guards never qualify.
 *
 * Station landmarks: per-kingdom offset lists defined IN THIS MODULE,
 * anchored to existing sites.json tiles (square / tavern / market).
 * No new tile data, no engine object lookups. stationTile() is total:
 * unknown kingdoms fall back to the default kingdom's sites and never crash.
 *
 * Chatter: ~20-line data-tier corpus, trade flavored, tiered by level.
 * Levels are READ from CitizenSkilling's store (cook -> cooking, genuine);
 * smiths, carpenters and shopkeepers have no skill track in this repo, so
 * their tier reads the citizen's best genuine level (overall experience).
 * Never mutated here — CitizenSkilling owns XP.
 *
 * Animation ids are the engine's own, verified in server/plugins/skills:
 *   899 smelt / 898 smith (Smithing.plugin.js), 897 range cook
 *   (Cooking.plugin.js), 1248 fletching/whittling (Fletching.plugin.js —
 *   reads as carpentry at a workbench), 885 crafting (Crafting.plugin.js —
 *   hands working small goods; reads as arranging wares at a stall).
 *
 * Wiring: CitizenDirector.tickProximity() calls tickWorkLoops(this, nowMs)
 * on the fast (~10s) visible-life tick, right after the alive layer.
 * Per-citizen try/catch: one bad bot never breaks the tick.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { normalizeName } = require("./CitizenBonds");
const TimingDesync = require("./CitizenTimingDesync");
const { brainTickDue } = require("./CitizenTickLod");

// --- tuning --------------------------------------------------------------------

const LOOP_MS = 60 * 1000; // one work loop lasts ~60s
const COOLDOWN_MS = 10 * 60 * 1000; // ~10 min per citizen between loops
const START_CHANCE = 0.25; // per eligible idle citizen per fast tick
const CHATTER_CHANCE = 0.15; // per active loop tick (only when watched close)
const PROXIMITY_TILES = 40; // a real player must be this close to start a loop
const CHAT_TILES = 15; // chatter only when a real player is in bubble range
const NEAR_STATION_TILES = 12; // citizen must already be this near the station
const MAX_PER_STATION = 2; // max concurrent loopers per station

// --- stations ------------------------------------------------------------------
// Per-station: which trade works it, the animation to play, the sites.json
// anchor it derives from, and the verb for the journal line.

const STATION_DEFS = Object.freeze({
  forge: Object.freeze({
    trade: "smith",
    anim: 899,
    anchor: "square",
    verb: "smelting at the forge",
  }),
  anvil: Object.freeze({
    trade: "smith",
    anim: 898,
    anchor: "square",
    verb: "hammering at the anvil",
  }),
  range: Object.freeze({
    trade: "cook",
    anim: 897,
    anchor: "tavern",
    verb: "working the range",
  }),
  workbench: Object.freeze({
    trade: "carpenter",
    anim: 1248,
    anchor: "square",
    verb: "planing at the workbench",
  }),
  stall: Object.freeze({
    trade: "shopkeeper",
    anim: 885,
    anchor: "market",
    verb: "stocking the stall",
  }),
});

const STATION_KEYS = Object.freeze(Object.keys(STATION_DEFS));

// Per-kingdom [dx, dy] offsets from the anchor tile. Every kingdom has the
// three anchors (square / tavern / market) in sites.json — Keldagrim too
// (it only lacks dock/rocks, which no station uses). _default covers
// unknown/misconfigured kingdom ids.

const KINGDOM_STATION_OFFSETS = Object.freeze({
  asgarnia: Object.freeze({
    forge: [4, -3],
    anvil: [6, -2],
    range: [1, 1],
    workbench: [-3, 3],
    stall: [0, 0],
  }),
  kandarin: Object.freeze({
    forge: [-4, 3],
    anvil: [-6, 2],
    range: [-1, -1],
    workbench: [3, -3],
    stall: [1, 0],
  }),
  keldagrim: Object.freeze({
    forge: [3, 4],
    anvil: [5, 3],
    range: [2, -1],
    workbench: [-4, -3],
    stall: [0, 1],
  }),
  misthalin: Object.freeze({
    forge: [-3, -4],
    anvil: [-5, -3],
    range: [-2, 1],
    workbench: [4, 4],
    stall: [-1, 0],
  }),
  morytania: Object.freeze({
    forge: [5, 2],
    anvil: [7, 3],
    range: [0, -2],
    workbench: [-4, 4],
    stall: [0, -1],
  }),
  _default: Object.freeze({
    forge: [4, -3],
    anvil: [6, -2],
    range: [1, 1],
    workbench: [-3, 3],
    stall: [0, 0],
  }),
});

/**
 * Resolve a station's tile for a kingdom. Total: unknown kingdom ids,
 * missing anchors or bad offset data all degrade to a null return, never
 * an exception. Unknown kingdoms fall back to the first kingdom's sites
 * (siteTileByKingdom's own fallback) plus the _default offsets.
 */
function stationTile(kingdomId, stationKey) {
  try {
    const def = STATION_DEFS[stationKey];
    if (!def) return null;
    const anchor = siteTileByKingdom(kingdomId, def.anchor);
    if (!anchor) return null;
    const offsets =
      KINGDOM_STATION_OFFSETS[kingdomId] ?? KINGDOM_STATION_OFFSETS._default;
    const pair = offsets[stationKey] ?? [0, 0];
    return { x: anchor.x + pair[0], y: anchor.y + pair[1], z: anchor.z ?? 0 };
  } catch {
    return null;
  }
}

/** All stations for a kingdom with resolved tiles (unresolvable ones dropped). */
function stationsForKingdom(kingdomId) {
  const out = [];
  for (const key of STATION_KEYS) {
    const tile = stationTile(kingdomId, key);
    if (!tile) continue;
    const def = STATION_DEFS[key];
    out.push({ key, trade: def.trade, anim: def.anim, verb: def.verb, tile });
  }
  return out;
}

// --- chatter -------------------------------------------------------------------
// ~20 lines, trade flavored, tiered by level. The LLM never writes these.

const TRADE_LINES = Object.freeze({
  smith: Object.freeze({
    novice: Object.freeze([
      "Easy... fold it slow.",
      "Watch the heat — don't burn the steel.",
    ]),
    seasoned: Object.freeze(["Another blade for the rack."]),
    master: Object.freeze([
      "Forty years at this anvil, still learning.",
      "This edge will hold a lifetime.",
    ]),
  }),
  cook: Object.freeze({
    novice: Object.freeze([
      "Don't let it catch, don't let it catch...",
      "Is this meant to smoke like that?",
    ]),
    seasoned: Object.freeze(["Stew's coming along nicely."]),
    master: Object.freeze([
      "Forty years on this range. Never burnt a batch.",
      "Season it like you mean it.",
    ]),
  }),
  carpenter: Object.freeze({
    novice: Object.freeze([
      "Measure twice... right?",
      "This plank's fighting me.",
    ]),
    seasoned: Object.freeze(["Nice grain on this one."]),
    master: Object.freeze([
      "The wood tells you what it wants to be.",
      "Joints so tight they don't need glue.",
    ]),
  }),
  shopkeeper: Object.freeze({
    novice: Object.freeze([
      "Where does this one go again?",
      "Mind the display, mind the display.",
    ]),
    seasoned: Object.freeze(["Front row's the money row."]),
    master: Object.freeze([
      "Forty years of market days. I know every face.",
      "Best stall on the row, ask anyone.",
    ]),
  }),
});

// Only genuine CitizenSkilling tracks count here. Smiths, carpenters and
// shopkeepers have no skill track in this repo, so they tier on the
// citizen's best genuine level (a citizen who's been skilling for weeks is
// a seasoned worker, whatever the trade).
const TRADE_SKILL = Object.freeze({ cook: "cooking" });
const GENUINE_SKILLS = Object.freeze([
  "woodcutting",
  "fishing",
  "mining",
  "cooking",
]);

function tierForLevel(level) {
  const l = Math.max(1, Math.floor(Number(level) || 1));
  if (l >= 40) return "master";
  if (l >= 10) return "seasoned";
  return "novice";
}

let levelProvider = null; // test seam: setLevelProvider(fn)

/** Read-only level lookup. CitizenSkilling owns XP; never mutated here. */
function defaultLevelProvider(record, tradeKey) {
  try {
    const store = require("./CitizenSkilling").skillStore;
    if (!store || typeof store.getLevel !== "function") return 1;
    const name = record?.username ?? "";
    const skillId = TRADE_SKILL[tradeKey];
    if (skillId) return store.getLevel(name, skillId);
    let best = 1;
    for (const id of GENUINE_SKILLS) {
      best = Math.max(best, store.getLevel(name, id));
    }
    return best;
  } catch {
    return 1;
  }
}

function setLevelProvider(fn) {
  levelProvider = typeof fn === "function" ? fn : null;
}

function tradeLevel(record, tradeKey) {
  try {
    return (levelProvider ?? defaultLevelProvider)(record, tradeKey);
  } catch {
    return 1;
  }
}

/** Pick a data-tier chatter line for the trade/level, or null. */
function workLine(record, tradeKey, rng) {
  const pools = TRADE_LINES[tradeKey];
  if (!pools) return null;
  const pool = pools[tierForLevel(tradeLevel(record, tradeKey))] ?? [];
  if (pool.length === 0) return null;
  const r = typeof rng === "function" ? rng : Math.random;
  return pool[Math.floor(r() * pool.length)];
}

// --- state (in-memory; the journal is what persists) ----------------------------

const loops = new Map(); // normalized citizen name -> active loop
const cooldowns = new Map(); // normalized citizen name -> last loop start ms

function occupancyKey(kingdomId, stationKey) {
  return `${String(kingdomId ?? "unknown")}:${stationKey}`;
}

function stationOccupancy(kingdomId, stationKey) {
  const key = occupancyKey(kingdomId, stationKey);
  let n = 0;
  for (const loop of loops.values()) {
    if (occupancyKey(loop.kingdomId, loop.stationKey) === key) n++;
  }
  return n;
}

// --- bot helpers (same shapes as CitizenAlive / CitizenDailyRoutines) -----------

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function isMoving(bot) {
  try {
    if (bot.getForceMovement?.() != null) return true;
    return (bot.getMovementQueue?.()?.size?.() ?? 0) > 0;
  } catch {
    return false;
  }
}

function faceToward(bot, targetTile) {
  try {
    if (!targetTile) return false;
    bot.face?.(targetTile.x, targetTile.y);
    return true;
  } catch {
    return false;
  }
}

function playAnim(director, bot, animId) {
  try {
    const Anim = director?.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(animId));
    return true;
  } catch {
    return false;
  }
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me) return out;
    // getLocalPlayers is the engine viewport list; the 40-tile gate over it
    // effectively reads as "a real player is around". Cheap by construction.
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || p?.isPlayerBot?.() === true) continue;
      if (chebyshev(me, botTile(p)) <= tiles) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function journalEvent(citizenName, text) {
  try {
    getJournal().log(citizenName, "work", text);
  } catch {
    // Non-fatal.
  }
}

// --- eligibility -----------------------------------------------------------------

/** Never poach citizens already claimed by CitizenSkilling's sessions. */
function skillingBusy(record) {
  try {
    const sk = require("./CitizenSkilling");
    const name = normalizeName(record.username);
    const sessions = sk._sessions;
    if (!sessions) return false;
    if (sessions.has(name)) return true;
    for (const s of sessions.values()) {
      if (
        (s.members ?? []).some((m) => normalizeName(m) === name) ||
        normalizeName(s.leader) === name
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Never poach citizens in a party or being followed. */
function socialBusy(record) {
  try {
    const { getParty, getFollow } = require("./CitizenBonds");
    return !!(getParty(record.username) || getFollow(record.username));
  } catch {
    return false;
  }
}

/**
 * Idle commoners only: not already looping, off cooldown, online, and not
 * claimed by skilling sessions, parties or follows. Merchants and guards
 * have scheduled shifts elsewhere (CitizenDailyRoutines) and never qualify.
 */
function eligibleForLoop(record, director, nowMs) {
  if (!record || record.role !== "commoner") return false;
  const name = normalizeName(record.username);
  if (!name) return false;
  if (!director?.isOnline?.(record)) return false;
  if (loops.has(name)) return false;
  if (nowMs - (cooldowns.get(name) ?? 0) < COOLDOWN_MS) return false;
  if (skillingBusy(record)) return false;
  if (socialBusy(record)) return false;
  return true;
}

/** Nearest station within NEAR_STATION_TILES of the bot, or null. */
function nearestStation(record, bot) {
  const me = botTile(bot);
  if (!me) return null;
  let best = null;
  let bestDist = NEAR_STATION_TILES;
  for (const station of stationsForKingdom(record.kingdomId)) {
    const d = chebyshev(me, station.tile);
    if (d <= bestDist) {
      best = station;
      bestDist = d;
    }
  }
  return best;
}

// --- loop lifecycle --------------------------------------------------------------

function startLoop(director, record, bot, station, nowMs) {
  const name = normalizeName(record.username);
  const kingdomId = record.kingdomId ?? "unknown";
  loops.set(name, {
    stationKey: station.key,
    trade: station.trade,
    anim: station.anim,
    tile: station.tile,
    kingdomId,
    startedAt: nowMs,
  });
  cooldowns.set(name, nowMs);
  faceToward(bot, station.tile);
  playAnim(director, bot, station.anim);
  // One journal line per loop start — the LLM's source of truth.
  journalEvent(record.username, `Took a turn at the ${station.key} — ${station.verb}.`);
}

function endLoop(name) {
  loops.delete(name);
}

/** Expire stale loops (citizen logged out mid-loop, tick hiccups, etc.). */
function pruneLoops(nowMs) {
  for (const [name, loop] of loops) {
    if (nowMs - loop.startedAt > LOOP_MS + 5 * 60 * 1000) {
      loops.delete(name);
    }
  }
}

function tickCitizenWork(director, record, nowMs) {
  const name = normalizeName(record.username);
  const bot = director.getBot(record);
  const active = loops.get(name);

  if (active) {
    // Continue an in-progress loop: re-face, re-play the animation
    // (one-shot engine anims need re-triggering), occasional chatter.
    if (nowMs - active.startedAt >= LOOP_MS) {
      endLoop(name);
      return;
    }
    if (!bot) return;
    faceToward(bot, active.tile);
    playAnim(director, bot, active.anim);
    const rng = agentRng(`workloop:chat:${name}:${Math.floor(nowMs / 10000)}`);
    if (
      chance(rng, CHATTER_CHANCE) &&
      realPlayersWithin(bot, CHAT_TILES).length > 0
    ) {
      const line = workLine(record, active.trade, rng);
      if (line) {
        try {
          bot.forceChat?.(line);
        } catch {
          // Cosmetic.
        }
      }
    }
    return;
  }

  // Consider starting a new loop.
  if (!bot) return;
  if (!eligibleForLoop(record, director, nowMs)) return;
  if (isMoving(bot)) return; // only idle citizens
  // Proximity gate: nobody watching, nobody working. No wasted ticks.
  if (realPlayersWithin(bot, PROXIMITY_TILES).length === 0) return;
  const station = nearestStation(record, bot);
  if (!station) return;
  if (stationOccupancy(record.kingdomId, station.key) >= MAX_PER_STATION) return;
  const rng = agentRng(`workloop:start:${name}:${Math.floor(nowMs / 10000)}`);
  if (!chance(rng, START_CHANCE)) return;
  startLoop(director, record, bot, station, nowMs);
}

/**
 * Fast-tick entry. Called from CitizenDirector.tickProximity() (~10s),
 * after the alive layer. Wraps every citizen in try/catch.
 */
function tickWorkLoops(director, nowMs = Date.now(), desync = null) {
  if (!director?.roster) return;
  for (const record of director.roster.values()) {
    // LOD brain gate: distant citizens skip visible work loops on most
    // cycles. Near-band (and unclassified) citizens are always due, so
    // behavior near players is unchanged.
    if (!brainTickDue(director, record, desync?.tick)) {
      continue;
    }
    // Timing desync: only the citizens whose hash slot matches this tick's
    // phase are evaluated — no synchronized wave of loop starts.
    if (
      desync &&
      !TimingDesync.isCitizenDue(record, desync.tick, desync.spread)
    ) {
      continue;
    }
    try {
      tickCitizenWork(director, record, nowMs);
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
  try {
    pruneLoops(nowMs);
  } catch {
    // Non-fatal.
  }
}

module.exports = {
  // tuning
  LOOP_MS,
  COOLDOWN_MS,
  START_CHANCE,
  CHATTER_CHANCE,
  PROXIMITY_TILES,
  CHAT_TILES,
  NEAR_STATION_TILES,
  MAX_PER_STATION,
  // data
  STATION_DEFS,
  STATION_KEYS,
  KINGDOM_STATION_OFFSETS,
  TRADE_LINES,
  // pure/testable
  stationTile,
  stationsForKingdom,
  tierForLevel,
  tradeLevel,
  workLine,
  eligibleForLoop,
  // lifecycle
  tickWorkLoops,
  startLoop,
  endLoop,
  stationOccupancy,
  // seams (tests)
  setLevelProvider,
  _loops: loops,
  _cooldowns: cooldowns,
};
