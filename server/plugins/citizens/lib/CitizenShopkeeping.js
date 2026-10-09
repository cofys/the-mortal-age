"use strict";

/**
 * CitizenShopkeeping — visible shopkeeper work loops for merchant citizens.
 *
 * Data tier, zero LLM. On the fast (~10s) visible-life tick, online merchant
 * citizens who own a shop cycle through a shopkeeping work loop:
 *
 *   restock (every 5 min) → arrange (every 3 min) → sweep (every 10 min)
 *   → idle/chat (the gaps in between)
 *
 * Each task is VISIBLE: the owner walks to the task's spot near the shop
 * (shelves / display / floor), plays the trade's animation, and emits an
 * emote-style chat line like "*restocks the shelves*". One journal line per
 * task so the foreground LLM answers "what have you been up to?" truthfully.
 *
 * Customers get greeted: when a real (non-bot) player steps within greeting
 * radius of the shop while the owner is idle, the owner greets them from a
 * data-tier shopkeeper greeting pool — never an LLM call on the hot path.
 *
 * Deliberately NOT CitizenWorkLoops:
 *   - WorkLoops assigns idle COMMONERS to craft-station micro-loops and
 *     never moves them; it runs on station proximity.
 *   - This module is for MERCHANT shop owners only, runs a longer
 *     restock/arrange/sweep task cycle tied to the shop's market-stall
 *     anchor, MOVES the owner between task spots, and adds customer
 *     greetings. Merchants are explicitly excluded from WorkLoops.
 * Deliberately NOT CitizenDailyRoutines:
 *   - DailyRoutines covers scheduled merchant SHIFTS (wall-clock phases,
 *     supplier runs). This module covers the in-shift shopkeeping bustle
 *     between those phases — the visible "the shopkeeper is working"
 *     texture a customer actually sees.
 *
 * Shop anchor: the kingdom's "market" site tile (sites.json), same anchor
 * the WorkLoops stall station uses. Task spots are per-task [dx, dy]
 * offsets from it. Total: unknown kingdoms fall back through
 * siteTileByKingdom's own fallback and never crash.
 *
 * Animation ids are the engine's own, verified in server/plugins/skills:
 *   885 crafting (Crafting.plugin.js — hands working small goods; reads as
 *       placing stock on shelves / handling wares)
 *   1248 fletching/whittling (Fletching.plugin.js — fiddly hand work; reads
 *       as adjusting displays)
 * Sweeping has no engine animation; the sweep task is movement + emote only.
 *
 * Wiring: CitizenDirector.tickProximity() calls tickShopkeeping(this, nowMs)
 * on the fast (~10s) visible-life tick, after the work-loops layer.
 * Per-citizen try/catch: one bad bot never breaks the tick.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// --- tuning --------------------------------------------------------------------

const RESTOCK_INTERVAL_MS = 5 * 60 * 1000;
const ARRANGE_INTERVAL_MS = 3 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const TASK_DURATION_MS = 30 * 1000; // one shopkeeping task lasts ~30s
const TASK_CHANCE = 0.5; // per due task per fast tick (staggers starts)
const GREET_RADIUS = 8; // tiles: a real player this close gets greeted
const GREET_COOLDOWN_MS = 2 * 60 * 1000; // per citizen, so they don't spam
const PROXIMITY_TILES = 40; // a real player must be this close for any of it
const SHOP_TASK_STAGGER_MS = 60 * 1000; // tasks start at most this often

// --- tasks ---------------------------------------------------------------------
// Per-task: how often, the animation to play, the visible emote line, the
// [dx, dy] spot offset from the shop's market anchor, and the journal line.

const SHOP_TASK_DEFS = Object.freeze({
  restock: Object.freeze({
    intervalMs: RESTOCK_INTERVAL_MS,
    anim: 885,
    emote: "*restocks the shelves*",
    offset: [-2, 1],
    journal: "Restocked the shelves.",
  }),
  arrange: Object.freeze({
    intervalMs: ARRANGE_INTERVAL_MS,
    anim: 1248,
    emote: "*arranges the front display*",
    offset: [2, -1],
    journal: "Arranged the front display.",
  }),
  sweep: Object.freeze({
    intervalMs: SWEEP_INTERVAL_MS,
    anim: null, // no sweep animation in the engine; movement + emote
    emote: "*sweeps the shop floor*",
    offset: [0, 2],
    journal: "Swept the shop floor.",
  }),
});

const SHOP_TASK_KEYS = Object.freeze(Object.keys(SHOP_TASK_DEFS));

// The idle home spot: behind the counter, ready to serve.
const COUNTER_OFFSET = Object.freeze([0, 0]);

// --- greetings -------------------------------------------------------------------
// Data-tier shopkeeper customer greetings. The LLM never writes these.

const SHOPKEEPER_GREETINGS = Object.freeze([
  "Welcome! Have a look around.",
  "Come in, come in! Best prices in town.",
  "Browsing or buying today?",
  "Afternoon! Let me know if you need anything.",
  "Welcome to my shop, friend.",
  "Take your time — shout if you want the good stuff.",
]);

// --- state (in-memory; the journal is what persists) ----------------------------

const activeTasks = new Map(); // normalized citizen name -> active task
const lastTaskAt = new Map(); // normalized citizen name -> { taskKey: ms }
const lastGreetAt = new Map(); // normalized citizen name -> ms

// --- bot helpers (same shapes as CitizenAlive / CitizenWorkLoops) ---------------

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
  if (animId == null) return true; // tasks without an anim are still valid
  try {
    const Anim = director?.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(animId));
    return true;
  } catch {
    return false;
  }
}

function makeLocation(director, x, y, z) {
  try {
    const Loc = director?.api?.core?.Location;
    if (Loc) return new Loc(x, y, z ?? 0);
  } catch {
    // Non-fatal.
  }
  return null;
}

function walkTo(director, bot, tile) {
  try {
    const loc = makeLocation(director, tile.x, tile.y, tile.z);
    if (!loc) return false;
    bot.moveTo?.(loc);
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

// --- shop anchor -----------------------------------------------------------------

/**
 * The shop's market-stall tile for a kingdom. Total: unknown kingdom ids
 * or missing anchors degrade to null, never an exception.
 */
function shopTile(kingdomId) {
  try {
    const anchor = siteTileByKingdom(kingdomId, "market");
    if (!anchor) return null;
    return { x: anchor.x, y: anchor.y, z: anchor.z ?? 0 };
  } catch {
    return null;
  }
}

/** A task's spot tile: shop anchor + the task's offset. */
function taskTile(kingdomId, taskKey) {
  const shop = shopTile(kingdomId);
  const def = SHOP_TASK_DEFS[taskKey];
  if (!shop || !def) return null;
  return {
    x: shop.x + def.offset[0],
    y: shop.y + def.offset[1],
    z: shop.z,
  };
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
 * Merchant shop owners only: online, not mid-task, not claimed by skilling
 * sessions, parties or follows. Commoners/guards/courtiers never qualify.
 */
function eligibleForShopkeeping(record, director) {
  if (!record || record.role !== "merchant") return false;
  const name = normalizeName(record.username);
  if (!name) return false;
  if (!director?.isOnline?.(record)) return false;
  if (activeTasks.has(name)) return false;
  if (skillingBusy(record)) return false;
  if (socialBusy(record)) return false;
  return true;
}

/** Which task (if any) is due for this citizen right now. */
function dueTask(name, nowMs) {
  const last = lastTaskAt.get(name) ?? {};
  for (const key of SHOP_TASK_KEYS) {
    const def = SHOP_TASK_DEFS[key];
    if (nowMs - (last[key] ?? 0) >= def.intervalMs) {
      return key;
    }
  }
  return null;
}

// --- task lifecycle ---------------------------------------------------------------

function startTask(director, record, bot, taskKey, nowMs) {
  const name = normalizeName(record.username);
  const kingdomId = record.kingdomId ?? "unknown";
  const def = SHOP_TASK_DEFS[taskKey];
  const tile = taskTile(kingdomId, taskKey);
  if (!def || !tile) return false;
  activeTasks.set(name, {
    taskKey,
    tile,
    kingdomId,
    startedAt: nowMs,
  });
  const last = lastTaskAt.get(name) ?? {};
  last[taskKey] = nowMs;
  lastTaskAt.set(name, last);
  // Walk to the spot, then face it and work. The emote is the visible bit.
  walkTo(director, bot, tile);
  try {
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [def.emote] })); }
  } catch {
    // Cosmetic.
  }
  faceToward(bot, tile);
  playAnim(director, bot, def.anim);
  journalEvent(record.username, def.journal);
  return true;
}

function endTask(name) {
  activeTasks.delete(name);
}

/** Expire stale tasks (citizen logged out mid-task, tick hiccups, etc.). */
function pruneTasks(nowMs) {
  for (const [name, task] of activeTasks) {
    if (nowMs - task.startedAt > TASK_DURATION_MS + 5 * 60 * 1000) {
      activeTasks.delete(name);
    }
  }
}

/** Return to the counter after a task finishes (if anyone's watching). */
function returnToCounter(director, record, bot) {
  const shop = shopTile(record.kingdomId);
  if (!shop) return;
  const counter = {
    x: shop.x + COUNTER_OFFSET[0],
    y: shop.y + COUNTER_OFFSET[1],
    z: shop.z,
  };
  const me = botTile(bot);
  if (me && chebyshev(me, counter) <= 1) return; // already there
  walkTo(director, bot, counter);
}

// --- customer greetings -------------------------------------------------------------

/**
 * A real player walked into the shop while the owner is idle: greet them
 * from the data-tier pool. Cooldown per citizen so a loiterer doesn't get
 * spammed. Zero LLM — same contract as CitizenAlive's greetings.
 */
function tickGreeting(director, record, bot, nowMs) {
  const name = normalizeName(record.username);
  if (nowMs - (lastGreetAt.get(name) ?? 0) < GREET_COOLDOWN_MS) return;
  const customers = realPlayersWithin(bot, GREET_RADIUS);
  if (customers.length === 0) return;
  const rng = agentRng(`shopkeep:greet:${name}:${Math.floor(nowMs / 60000)}`);
  // Face the customer, then greet.
  try {
    faceToward(bot, botTile(customers[0]));
  } catch {
    // Non-fatal.
  }
  try {
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [SHOPKEEPER_GREETINGS[Math.floor(rng() * SHOPKEEPER_GREETINGS.length)]] })); }
  } catch {
    // Cosmetic.
  }
  lastGreetAt.set(name, nowMs);
  journalEvent(record.username, `Greeted a customer at the shop.`);
}

// --- main tick ----------------------------------------------------------------------

function tickCitizenShopkeeping(director, record, nowMs) {
  const name = normalizeName(record.username);
  const bot = director.getBot(record);
  if (!bot) return;
  const task = activeTasks.get(name);

  if (task) {
    // Continue an in-progress task: keep facing the spot, re-play the
    // animation (one-shot engine anims need re-triggering).
    if (nowMs - task.startedAt >= TASK_DURATION_MS) {
      endTask(name);
      returnToCounter(director, record, bot);
      return;
    }
    if (isMoving(bot)) return; // still walking there — don't emote again
    const def = SHOP_TASK_DEFS[task.taskKey];
    faceToward(bot, task.tile);
    playAnim(director, bot, def?.anim);
    return;
  }

  // Proximity gate: nobody watching, nobody working. No wasted ticks.
  if (realPlayersWithin(bot, PROXIMITY_TILES).length === 0) return;
  if (!eligibleForShopkeeping(record, director)) return;
  if (isMoving(bot)) return;

  // Customers first: greet, don't start a task this tick.
  tickGreeting(director, record, bot, nowMs);

  // Then consider starting the next due task.
  const due = dueTask(name, nowMs);
  if (!due) return;
  const rng = agentRng(`shopkeep:task:${name}:${Math.floor(nowMs / 60000)}`);
  if (!chance(rng, TASK_CHANCE)) return;
  startTask(director, record, bot, due, nowMs);
}

/**
 * Fast-tick entry. Called from CitizenDirector.tickProximity() (~10s),
 * after the work-loops layer. Wraps every citizen in try/catch.
 */
function tickShopkeeping(director, nowMs = Date.now()) {
  if (!director?.roster) return;
  for (const record of director.roster.values()) {
    try {
      tickCitizenShopkeeping(director, record, nowMs);
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
  try {
    pruneTasks(nowMs);
  } catch {
    // Non-fatal.
  }
}

module.exports = {
  // tuning
  RESTOCK_INTERVAL_MS,
  ARRANGE_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
  TASK_DURATION_MS,
  TASK_CHANCE,
  GREET_RADIUS,
  GREET_COOLDOWN_MS,
  PROXIMITY_TILES,
  SHOP_TASK_STAGGER_MS,
  // data
  SHOP_TASK_DEFS,
  SHOP_TASK_KEYS,
  SHOPKEEPER_GREETINGS,
  COUNTER_OFFSET,
  // pure/testable
  shopTile,
  taskTile,
  dueTask,
  eligibleForShopkeeping,
  // lifecycle
  tickShopkeeping,
  startTask,
  endTask,
  // seams (tests)
  _activeTasks: activeTasks,
  _lastTaskAt: lastTaskAt,
  _lastGreetAt: lastGreetAt,
};
