"use strict";

/**
 * CitizenDayNightLife — director tick dynamics for the day/night cycle.
 * Data tier, zero LLM.
 *
 * Each slow tick (~60s):
 *  1. Transitions: when dusk falls, night falls, or dawn breaks, citizens
 *     near a real player react once (personality-gated lines), and the
 *     transition is journaled. Persisted so restarts don't repeat it.
 *  2. Sleep: at night, online citizens with low energy recover faster —
 *     the realm sleeps. Night owls are exempt (they're at the tavern).
 *  3. Night watch: guards on duty get a patrol announcement near players
 *     (they hold their post while others sleep).
 *  4. Stargazing: clear nights, citizens near players sometimes remark on
 *     the stars (cooldown-gated, personality-gated).
 *  5. Lamps: street lamps are lit at dusk/night/dawn — announced once per
 *     transition near players ("the lamplighter's been round").
 *
 * Wiring: CitizenDirector calls tickDayNight(this, nowMs) in the slow tick
 * inside try/catch. CitizenDayNight.save() goes in the save section.
 * Plain-node testable: CitizenDayNightLife.test.js.
 */

const DayNight = require("./CitizenDayNight");
const { agentRng } = require("./humanizer");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

// === Tuning ===
const REACTION_RADIUS = 16; // tiles — close enough to see/hear
const TRANSITION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // a citizen announces a transition at most this often
const STARGAZE_CHANCE = 0.08; // per eligible citizen per tick on clear nights
const STARGAZE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const PATROL_CHANCE = 0.15; // per online guard per tick at night
const PATROL_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// Sleep recovery: at night, sleeping citizens recover energy faster.
const SLEEP_RECOVER_AMOUNT = 4; // +4 energy per slow tick while asleep at night

// === Cooldown state ===
const lastTransitionAnnounce = new Map(); // username -> timestamp
const lastStargaze = new Map(); // username -> timestamp
const lastPatrol = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastTransitionAnnounce) if (at < cutoff) lastTransitionAnnounce.delete(k);
  for (const [k, at] of lastStargaze) if (at < cutoff) lastStargaze.delete(k);
  for (const [k, at] of lastPatrol) if (at < cutoff) lastPatrol.delete(k);
}
/** Test seam: reset cooldown state. */
function _resetState() {
  lastTransitionAnnounce.clear();
  lastStargaze.clear();
  lastPatrol.clear();
  lastPruneAt = 0;
}

// === Scripted line pools (zero LLM, personality-gated) ===
const LINES = Object.freeze({
  dusk: [
    "Sun's going down. Another day done.",
    "Dusk already? The days are flying by.",
    "Evening's here. Time to head in soon.",
  ],
  night: [
    "Night's fallen. Stay safe out there.",
    "Dark out. The watch has the streets tonight.",
    "Night time. Lamps are lit, doors are barred.",
  ],
  dawn: [
    "Dawn's breaking. A new day begins.",
    "Up with the sun! Let's get to work.",
    "Morning's here. Best part of the day.",
  ],
  stargaze: [
    "Clear night. The stars are beautiful.",
    "Look at that sky... makes you feel small, doesn't it?",
    "Stars are out. Good omen for tomorrow, they say.",
  ],
  patrol: [
    "Night watch. All quiet on my round.",
    "Patrolling the streets. Sleep well, citizens.",
    "Watchman's rounds. Nothing to report.",
  ],
  lamp: [
    "Lamps are lit. The lamplighter's been round.",
    "Street lamps are on. The town glows at night.",
  ],
  sleepy: [
    "I'm beat. Heading home to sleep.",
    "Long day. My bed's calling.",
    "Time for sleep. Tomorrow's another day.",
  ],
});

function pick(rng, arr) {
  if (!arr || arr.length === 0) return "";
  const r = typeof rng === "function" ? rng() : Math.random();
  return arr[Math.floor(r * arr.length) % arr.length];
}

function rosterRecords(director) {
  try {
    const roster = director?.roster;
    if (!roster) return [];
    if (typeof roster.values === "function") return Array.from(roster.values());
    if (Array.isArray(roster)) return roster;
    return Object.values(roster);
  } catch {
    return [];
  }
}

function isRealPlayer(player) {
  try {
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

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

function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])]
      .filter((r) => director.isOnline(r))
      .map((r) => director.getBot(r))
      .filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function say(bot, line) {
  try {
    const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [String(line).slice(0, 120)] }));
  } catch {
    // Non-fatal.
  }
}

function journal(username, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(username, "daynight", text, { data });
  } catch {
    // The journal must never break the night.
  }
}

function energyOf(bot) {
  try {
    const { needsFor } = require("../brain/CitizenNeeds");
    return needsFor(bot)?.energy ?? 100;
  } catch {
    return 100;
  }
}

function addEnergy(bot, amount) {
  try {
    const { addEnergy } = require("../brain/CitizenNeeds");
    addEnergy(bot, amount);
    return true;
  } catch {
    return false;
  }
}

// --- Transition announcements ------------------------------------------------
// When dusk/night/dawn arrives, citizens near real players react once
// (personality-gated), and the transition is journaled realm-wide.

function phaseTransitions(director, nowMs, rng) {
  const tod = DayNight.timeOfDay(nowMs);
  // Only dusk/night/dawn are transitions worth announcing (day is the default).
  if (tod !== DayNight.TIME.DUSK && tod !== DayNight.TIME.NIGHT && tod !== DayNight.TIME.DAWN) return 0;
  if (!DayNight.noteTransitionAnnounced(tod)) return 0; // already announced this transition

  let announced = 0;
  for (const record of rosterRecords(director)) {
    try {
      if (!director.isOnline(record)) continue;
      const bot = director.getBot(record);
      if (!bot || isRealPlayer(bot)) continue;
      if (!anyRealPlayerNear(director, bot, REACTION_RADIUS)) continue;
      const last = lastTransitionAnnounce.get(record.username) || 0;
      if (nowMs - last < TRANSITION_COOLDOWN_MS) continue;
      const lines = LINES[tod] || LINES.night;
      say(bot, pick(rng, lines));
      lastTransitionAnnounce.set(record.username, nowMs);
      journal(record.username, `noticed ${tod} falling over the realm.`, { timeOfDay: tod });
      announced++;
      if (announced >= 3) break; // a few voices, not a chorus
    } catch {
      // One bad citizen never breaks the night.
    }
  }
  return announced;
}

// --- Sleep -------------------------------------------------------------------
// At night, online citizens with low energy sleep: they recover energy
// faster. Night owls are exempt (they're living their best tavern life).

function phaseSleep(director, nowMs) {
  if (!DayNight.isNight(nowMs)) return 0;
  let slept = 0;
  for (const record of rosterRecords(director)) {
    try {
      if (!director.isOnline(record)) continue;
      if (DayNight.isNightOwl(record)) continue;
      if (record?.role === "guard") continue; // guards hold their post
      const bot = director.getBot(record);
      if (!bot || isRealPlayer(bot)) continue;
      const energy = energyOf(bot);
      if (energy > 70) continue; // only the weary sleep
      if (addEnergy(bot, SLEEP_RECOVER_AMOUNT)) slept++;
    } catch {
      // One bad citizen never breaks the night.
    }
  }
  return slept;
}

// --- Night watch ---------------------------------------------------------------
// Guards patrol at night. Near players, they announce their rounds.

function phasePatrol(director, nowMs, rng) {
  if (!DayNight.isNight(nowMs)) return 0;
  let patrolled = 0;
  for (const record of rosterRecords(director)) {
    try {
      if (record?.role !== "guard") continue;
      if (!director.isOnline(record)) continue;
      const bot = director.getBot(record);
      if (!bot || isRealPlayer(bot)) continue;
      if (!anyRealPlayerNear(director, bot, REACTION_RADIUS)) continue;
      const last = lastPatrol.get(record.username) || 0;
      if (nowMs - last < PATROL_COOLDOWN_MS) continue;
      if ((rng() ?? Math.random()) > PATROL_CHANCE) continue;
      say(bot, pick(rng, LINES.patrol));
      lastPatrol.set(record.username, nowMs);
      patrolled++;
      if (patrolled >= 2) break;
    } catch {
      // One bad guard never breaks the night.
    }
  }
  return patrolled;
}

// --- Stargazing -----------------------------------------------------------------
// Clear nights, citizens near players sometimes remark on the stars.

function phaseStargaze(director, nowMs, rng) {
  if (!DayNight.isNight(nowMs)) return 0;
  let weather = "clear";
  try {
    weather = String(require("../../skills/fishing/Conditions.Fishing").getWeather?.() ?? "clear").toLowerCase();
  } catch {
    weather = "clear";
  }
  if (weather === "rain" || weather === "storm") return 0; // clouds hide the stars
  let gazed = 0;
  for (const record of rosterRecords(director)) {
    try {
      if (!director.isOnline(record)) continue;
      const bot = director.getBot(record);
      if (!bot || isRealPlayer(bot)) continue;
      if (!anyRealPlayerNear(director, bot, REACTION_RADIUS)) continue;
      const last = lastStargaze.get(record.username) || 0;
      if (nowMs - last < STARGAZE_COOLDOWN_MS) continue;
      if ((rng() ?? Math.random()) > STARGAZE_CHANCE) continue;
      say(bot, pick(rng, LINES.stargaze));
      lastStargaze.set(record.username, nowMs);
      gazed++;
      if (gazed >= 2) break;
    } catch {
      // One bad citizen never breaks the night.
    }
  }
  return gazed;
}

/**
 * The slow-tick entry. Never throws.
 * @param {object} director — CitizenDirector
 * @param {number} nowMs
 */
function tickDayNight(director, nowMs = Date.now(), rng = agentRng) {
  try {
    pruneCooldowns(nowMs);
    phaseTransitions(director, nowMs, rng);
    phaseSleep(director, nowMs);
    phasePatrol(director, nowMs, rng);
    phaseStargaze(director, nowMs, rng);
  } catch (error) {
    try {
      director?.log?.("daynight tick failed", { error: String(error?.message ?? error) });
    } catch {
      // Never throw from the tick.
    }
  }
}

module.exports = {
  tickDayNight,
  _resetState,
  SLEEP_RECOVER_AMOUNT,
};
