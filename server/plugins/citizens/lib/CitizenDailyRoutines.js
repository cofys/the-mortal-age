"use strict";

/**
 * CitizenDailyRoutines — make citizen daily lives VISIBLE.
 *
 * The background tier already simulates citizen lives as data, and the brain
 * actions already move merchants to their stalls and guards along their
 * circuits. What's missing is the *visible* layer: a player watching a
 * citizen should see a coherent day — stall opening, forge shift, patrol,
 * meal break, tavern evening — not just a body standing somewhere.
 *
 * This module is that layer. Data tier, zero LLM:
 *
 *  - ROUTINE PHASES: each online merchant/guard/crafter gets a wall-clock
 *    phase (stall_open, forge_shift, patrol, meal, tavern) computed from
 *    the same schedule the director already uses for spawn/activity
 *    switching, so the journaled day always matches what the brain is
 *    actually doing. Phase transitions are journaled ("Opened the sword
 *    stall at the market.") so the foreground LLM answers "what's your
 *    day like?" truthfully from the journal.
 *  - VISIBLE ANNOUNCEMENTS: on a phase change, if real players are near,
 *    the citizen says a short data-tier line ("Stall's open — fresh
 *    blades today!"). No LLM — the LLM can riff on it later if asked.
 *  - CRAFTER WORK: supplier (swordsmith) and provisioner (baker) merchants
 *    get visible forge shifts — smithing (898) / cooking (897) animations
 *    at the stall, flavor lines, journaled output. Complements
 *    CitizenCrafting's wall-clock production (which journals the batches).
 *  - FOLLOW ACKNOWLEDGMENT: a real player can follow a citizen through
 *    their day (engine follow). The citizen notices and acknowledges with
 *    a phase-appropriate line ("Walking the walls. Keep up if you're
 *    coming."), journaled, on a per-citizen cooldown.
 *
 * Scope: merchant (prime retailer + supplier/provisioner crafters) and
 * guard. Commoners already run the full CitizenRoutine brain day; courtiers
 * and refugees keep their existing loops.
 *
 * Wiring: CitizenDirector.tick() calls tickRoutines(this, hour) once per
 * tick, after the skilling block. Everything is wrapped per-citizen in
 * try/catch so one bad bot never breaks the tick.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// --- phases ------------------------------------------------------------------

const PHASE_STALL_OPEN = "stall_open";
const PHASE_FORGE_SHIFT = "forge_shift";
const PHASE_PATROL = "patrol";
const PHASE_MEAL = "meal";
const PHASE_TAVERN = "tavern";
const PHASE_HOME = "home"; // offline hours; logged-out citizens never tick here

// Animation ids, verified in server/plugins/skills/*.plugin.js:
//   Smithing.plugin.js: SMITH_ANIMATION = new Animation(898)
//   Cooking.plugin.js:  RANGE_COOK_ANIMATION = new Animation(897)
const ANIM_SMITH = 898;
const ANIM_COOK = 897;

const FOLLOW_ACK_COOLDOWN_MS = 10 * 60 * 1000;
const WORK_FLAVOR_CHANCE = 0.25;

/** supplier (swordsmith) + provisioner (baker) merchants are the crafters. */
function isCrafter(record) {
  return (
    record.role === "merchant" &&
    (record.merchantKind === "supplier" || record.merchantKind === "provisioner")
  );
}

function isSupplier(record) {
  return record.role === "merchant" && record.merchantKind === "supplier";
}

/**
 * The citizen's routine phase right now. Mirrors the director's
 * desiredPhase schedule so the journaled day matches the brain activity
 * the citizen is actually running. Returns null for roles this module
 * doesn't cover.
 */
function phaseFor(record, hour) {
  if (record.role === "guard") {
    // Three watches; meal breaks at noon and supper, like desiredPhase.
    const watch = record.watch ?? 0;
    const watchStart = [6, 14, 22][watch] ?? 6;
    const watchEnd = [14, 22, 30][watch] ?? 14;
    const onWatch =
      watchEnd <= 24
        ? hour >= watchStart && hour < watchEnd
        : hour >= watchStart || hour < watchEnd - 24;
    const mealBreak = (hour >= 12 && hour < 13) || (hour >= 19 && hour < 20);
    if (mealBreak) return PHASE_MEAL;
    return onWatch ? PHASE_PATROL : PHASE_TAVERN;
  }
  if (record.role === "merchant") {
    if (isCrafter(record)) {
      // Crafter's day: forge shift, stall, lunch, forge shift, stall.
      if (hour >= 8 && hour < 10) return PHASE_FORGE_SHIFT;
      if (hour >= 10 && hour < 12) return PHASE_STALL_OPEN;
      if (hour >= 12 && hour < 13) return PHASE_MEAL;
      if (hour >= 13 && hour < 15) return PHASE_FORGE_SHIFT;
      if (hour >= 15 && hour < 19) return PHASE_STALL_OPEN;
      return PHASE_HOME;
    }
    // Prime retailer: stall all day, lunch, tavern evening.
    if (hour >= 8 && hour < 12) return PHASE_STALL_OPEN;
    if (hour >= 12 && hour < 13) return PHASE_MEAL;
    if (hour >= 13 && hour < 19) return PHASE_STALL_OPEN;
    if (hour >= 19 && hour < 22) return PHASE_TAVERN;
    return PHASE_HOME;
  }
  return null;
}

// --- visible lines -------------------------------------------------------------

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "routine", text);
  } catch {
    // Non-fatal.
  }
}

function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/** Real players currently engine-following this citizen's bot. */
function playerFollowers(bot) {
  const out = [];
  let selfName = null;
  try {
    selfName = bot.getUsername?.() ?? null;
  } catch {
    selfName = null;
  }
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || p?.isPlayerBot?.() === true) continue;
      try {
        const following = p.getFollowing?.();
        if (!following) continue;
        if (following === bot) {
          out.push(p);
          continue;
        }
        const fn = following.getUsername?.() ?? null;
        if (selfName && fn && fn === selfName) out.push(p);
      } catch {
        // One bad read skips one candidate.
      }
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function playerNameOf(p) {
  try {
    return p?.getUsername?.() ?? "traveller";
  } catch {
    return "traveller";
  }
}

function playAnim(director, bot, animId) {
  try {
    const Anim = director.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(animId));
    return true;
  } catch {
    return false;
  }
}

// Journal lines for phase transitions — what the LLM reads when asked
// "what's your day like?"
function journalForPhase(record, phase) {
  switch (phase) {
    case PHASE_STALL_OPEN:
      if (isSupplier(record)) return "Opened the sword stall at the market.";
      if (record.merchantKind === "provisioner")
        return "Opened the bread stall at the market.";
      return "Opened the stall at the market.";
    case PHASE_FORGE_SHIFT:
      if (isSupplier(record))
        return "Started the forge shift — blades to hammer out.";
      return "Fired up the ovens — bread to bake.";
    case PHASE_PATROL:
      return "Started the patrol round.";
    case PHASE_MEAL:
      return "Broke for a meal at the tavern.";
    case PHASE_TAVERN:
      return "Settled in at the tavern for the evening.";
    default:
      return null;
  }
}

// Data-tier shout on phase change, only when real players are near.
function sayForPhase(record, phase, rng) {
  switch (phase) {
    case PHASE_STALL_OPEN:
      if (isSupplier(record)) return "Stall's open — fresh blades today!";
      if (record.merchantKind === "provisioner") return "Hot bread! Stall's open!";
      return "Stall's open, come browse!";
    case PHASE_FORGE_SHIFT:
      if (isSupplier(record)) return "Back to the forge — orders to fill.";
      return "Ovens are hot — baking now.";
    case PHASE_PATROL:
      return pickOne(rng, ["On patrol. All quiet.", "Walking the round."]);
    case PHASE_MEAL:
      return "Time for a bite.";
    case PHASE_TAVERN:
      return pickOne(rng, ["Off duty. Ale time.", "Shift's done — tavern time."]);
    default:
      return null;
  }
}

// Acknowledgment when a real player follows the citizen through their day.
function ackForPhase(record, phase, rng) {
  switch (phase) {
    case PHASE_FORGE_SHIFT:
      if (isSupplier(record)) return "Off to the forge — coming along?";
      return "Bread won't bake itself — coming?";
    case PHASE_STALL_OPEN:
      return "Stall's open — have a browse.";
    case PHASE_PATROL:
      return "Walking the walls. Keep up if you're coming.";
    case PHASE_MEAL:
      return "Just grabbing a bite — pull up a stool.";
    case PHASE_TAVERN:
      return "Off duty — pull up a stool.";
    default:
      return "Heading out — stick with me if you like.";
  }
}

const FORGE_FLAVOR = Object.freeze([
  "hammered out a blade, quenched it hissing",
  "is beating a bar into shape, sparks flying",
  "held a half-finished sword up to the light, nodded",
  "sharpened a batch, testing each edge with a thumb",
]);

const BAKE_FLAVOR = Object.freeze([
  "pulled a tray of loaves from the oven, golden",
  "is kneading dough, flour to the elbows",
  "slid another batch into the ovens",
  "tapped a loaf, listening for the hollow sound",
]);

// --- per-tick ------------------------------------------------------------------

function workTick(director, record, bot, nowMs) {
  const supplier = isSupplier(record);
  playAnim(director, bot, supplier ? ANIM_SMITH : ANIM_COOK);
  const rng = agentRng(`routine:work:${record.username}:${nowMs >> 16}`);
  if (!chance(rng, WORK_FLAVOR_CHANCE)) return;
  const line = pickOne(rng, supplier ? FORGE_FLAVOR : BAKE_FLAVOR);
  const display = record.displayName ?? record.username;
  const text = `${display} ${line}.`;
  journalEvent(record.username, text, "routine");
  if (realPlayersNear(bot).length > 0) {
    try {
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    } catch {
      // Cosmetic.
    }
  }
}

function followAckTick(director, record, bot, phase, nowMs, rng) {
  const followers = playerFollowers(bot);
  if (followers.length === 0) return;
  const lastAck = record.followAckAt ?? 0;
  if (nowMs - lastAck < FOLLOW_ACK_COOLDOWN_MS) return;
  record.followAckAt = nowMs;
  const line = ackForPhase(record, phase, rng);
  try {
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // Cosmetic.
  }
  const names = followers.map(playerNameOf).join(", ");
  journalEvent(record.username, `${names} followed me through the day.`, "social");
}

function tickCitizenRoutine(director, record, bot, hour, nowMs) {
  const phase = phaseFor(record, hour);
  if (!phase || phase === PHASE_HOME) return;
  const rng = agentRng(`routine:${record.username}:${nowMs >> 16}`);

  // Phase transition: journal it (the LLM's source of truth) and say it
  // out loud if real players are near to hear.
  if (record.routinePhase !== phase) {
    record.routinePhase = phase;
    const journalLine = journalForPhase(record, phase);
    if (journalLine) journalEvent(record.username, journalLine, "routine");
    const sayLine = sayForPhase(record, phase, rng);
    if (sayLine && realPlayersNear(bot).length > 0) {
      try {
        { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [sayLine] })); }
      } catch {
        // Cosmetic.
      }
    }
  }

  // Crafter forge shift: visible work animations + flavor.
  if (phase === PHASE_FORGE_SHIFT) {
    workTick(director, record, bot, nowMs);
  }

  // Someone following this citizen through their day gets acknowledged.
  followAckTick(director, record, bot, phase, nowMs, rng);
}

/**
 * Make the day visible for every online merchant/guard/crafter.
 * Called from CitizenDirector.tick() once per tick (~60s).
 * Data tier, zero LLM.
 */
function tickRoutines(director, hour) {
  if (!director?.roster) return;
  const nowMs = Date.now();
  for (const record of director.roster.values()) {
    if (record.role !== "guard" && record.role !== "merchant") continue;
    if (!director.isOnline(record)) continue;
    const bot = director.getBot(record);
    if (!bot) continue;
    try {
      tickCitizenRoutine(director, record, bot, hour, nowMs);
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
}

module.exports = {
  PHASE_STALL_OPEN,
  PHASE_FORGE_SHIFT,
  PHASE_PATROL,
  PHASE_MEAL,
  PHASE_TAVERN,
  PHASE_HOME,
  ANIM_SMITH,
  ANIM_COOK,
  isCrafter,
  phaseFor,
  tickRoutines,
};
