"use strict";

/**
 * CitizenAlive — the "alive" layer. Makes citizens feel like real players.
 *
 * The brain activities (CitizenRoutine, GuardPatrol, etc.) handle the big
 * picture: walk to work, patrol, tend the stall. But real players do a
 * hundred small human things between the big actions — and it's those small
 * things that make someone read as alive vs. robotic:
 *
 *  - STUCK DETECTION: if a citizen hasn't moved in 3+ minutes while their
 *    brain says they should be doing something, force a re-path. Catches
 *    silent movement failures, unreachable destinations, pathing deadlocks.
 *  - IDLE LIFE: stationary citizens turn to face nearby players, play idle
 *    animations, emote occasionally, and voice small observations. A citizen
 *    standing at the market should feel present, not frozen.
 *  - SOCIAL AWARENESS: citizens notice each other. When two citizens pass
 *    within a few tiles, they sometimes greet, nod, or exchange a line —
 *    data-tier, zero LLM. The world feels alive even with no players around.
 *  - IMPERFECTIONS: real players get distracted, change their minds, and
 *    misclick. Citizens do too: mid-walk pauses to look at something,
 *    occasional destination changes, waypoint noise scaled by personality.
 *  - MOVEMENT STYLES: personality drives how citizens move. The hasty walk
 *    fast and direct; the elderly amble with pauses; the drunk weaves;
 *    the nervous stops and looks around.
 *
 * Data tier, zero LLM. Everything is wrapped per-citizen in try/catch.
 * Wiring: CitizenDirector.tick() calls tickAlive(this, nowMs) once per tick.
 */

const { agentRng, chance, logNormalJitter, humanizerProfile } = require("./humanizer");
const { getJournal } = require("./CitizenJournal");
const { brainTickDue } = require("./CitizenTickLod");

// --- tuning ------------------------------------------------------------------

const STUCK_THRESHOLD_MS = 3 * 60 * 1000; // 3 min without moving = stuck
const STUCK_CHECK_TILES = 2; // moved less than this = didn't move
const IDLE_FACE_CHANCE = 0.3; // per tick: turn to face a nearby player
const IDLE_EMOTE_CHANCE = 0.08; // per tick: play an idle emote/animation
const IDLE_OBSERVE_CHANCE = 0.12; // per tick: voice a small observation
const IDLE_WANDER_CHANCE = 0.15; // per tick: take a few steps (stretch legs)
const IDLE_WANDER_RADIUS = 5; // tiles: how far a wander goes
const SOCIAL_GREET_RADIUS = 4; // tiles: citizens this close may greet
const SOCIAL_GREET_CHANCE = 0.15; // per eligible pair per tick
const SOCIAL_GREET_COOLDOWN_MS = 5 * 60 * 1000; // per citizen
const DISTRACT_CHANCE = 0.06; // per tick: walking citizen gets distracted
const CHANGE_MIND_CHANCE = 0.03; // per tick: abandon destination, pick new one

// Idle animations that read as "alive" (engine animation ids).
// Verified against the engine's animation definitions.
const IDLE_ANIMS = Object.freeze({
  stretch: 1095, // stretching
  lookAround: 1096, // looking around (approximate; falls back silently)
  yawn: 1097, // yawning (approximate; falls back silently)
});

// Emote ids for occasional expressive moments.
const EMOTES = Object.freeze({
  wave: 1286, // wave
  cheer: 862, // cheer
  dance: 866, // dance
  shrug: 878, // shrug (approximate)
});

// Small observations citizens voice when idle and watched.
// Personality-filtered at the call site.
const IDLE_OBSERVATIONS = Object.freeze([
  "Nice day for it.",
  "Hmm.",
  "Wonder what's for supper.",
  "Busy, busy.",
  "Can't complain.",
  "Lovely weather we're having.",
  "My feet are killing me.",
  "Seen anything interesting today?",
]);

const DISTRACTION_LINES = Object.freeze([
  "Ooh, what's that?",
  "Hold on, look at this.",
  "Huh. Haven't seen that before.",
  "Wait — did you see that?",
]);

// Citizen-to-citizen greetings when passing. Short, warm, human.
const CITIZEN_GREETINGS = Object.freeze([
  "Morning!",
  "Alright?",
  "How's the day treating you?",
  "Hey there.",
  "Good to see you.",
  "Mind how you go.",
]);

// --- helpers -------------------------------------------------------------------

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

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "alive", text);
  } catch {
    // Non-fatal.
  }
}

function isRealPlayer(p) {
  if (!p) return false;
  try {
    if (p.isPlayerBot?.() === true) return false;
    return typeof p.getUsername === "function";
  } catch {
    return false;
  }
}

function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && isRealPlayer(p)) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function citizenBotsNear(director, bot, radius) {
  const out = [];
  const tile = botTile(bot);
  if (!tile) return out;
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || !p?.isPlayerBot?.()) continue;
      const other = botTile(p);
      if (other && chebyshev(tile, other) <= radius) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/**
 * Play a REAL engine Animation on the bot.
 *
 * A raw numeric id (or a partial duck-type) stored via performAnimation
 * corrupts the actor update path: PlayerSession.createActorUpdates calls
 * animation.getId()/getDelay() and a non-Animation throws, aborting that
 * player's whole view update (playtest crash 2026-10-08). Always wrap.
 */
function playAnim(director, bot, animId) {
  try {
    if (!animId) return false;
    const Anim = director?.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(animId));
    return true;
  } catch {
    return false;
  }
}

function faceToward(bot, targetTile) {
  try {
    const my = botTile(bot);
    if (!my || !targetTile) return false;
    // Face by setting the direction — the engine derives facing from
    // movement or explicit face commands. We use a 1-tile step-and-stop
    // which naturally turns the model without visible movement.
    const dx = Math.sign(targetTile.x - my.x);
    const dy = Math.sign(targetTile.y - my.y);
    if (dx === 0 && dy === 0) return false;
    bot.face?.(targetTile.x, targetTile.y);
    return true;
  } catch {
    return false;
  }
}

function requestMovement(bot, x, y, z, reason) {
  try {
    const { requestMovement: rm } = require("../../bots/behaviours/navigation/BotNavigation");
    rm(bot, x, y, { reason: reason ?? "citizen_alive", basicPather: true, z: z ?? 0 });
    return true;
  } catch {
    return false;
  }
}

function isMoving(bot) {
  try {
    if (bot.getForceMovement?.() != null) return true;
    return (bot.getMovementQueue?.()?.size?.() ?? 0) > 0;
  } catch {
    return false;
  }
}

// --- stuck detection -----------------------------------------------------------

/**
 * Track each citizen's position over time. If they haven't meaningfully
 * moved in STUCK_THRESHOLD_MS while their brain is active, they're stuck —
 * force a recovery: clear the movement queue and re-request their home
 * (which unsticks pathing deadlocks and unreachable destinations).
 */
const positionHistory = new Map(); // username -> { x, y, checkedAt }

function tickStuckDetection(director, record, bot, nowMs) {
  const name = record.username;
  const tile = botTile(bot);
  if (!tile) return;

  const prev = positionHistory.get(name);
  if (!prev) {
    positionHistory.set(name, { x: tile.x, y: tile.y, checkedAt: nowMs });
    return;
  }

  const moved = chebyshev(tile, prev) > STUCK_CHECK_TILES;
  if (moved) {
    positionHistory.set(name, { x: tile.x, y: tile.y, checkedAt: nowMs });
    return;
  }

  // Hasn't moved. Check if it's been long enough to call it stuck.
  if (nowMs - prev.checkedAt < STUCK_THRESHOLD_MS) return;

  // Stuck! But don't "fix" citizens who are supposed to be stationary
  // (tending a stall, sleeping at home during off-hours).
  const activityId = record.currentActivityId ?? "";
  const stationaryOk =
    activityId.includes("merchant") ||
    activityId.includes("prime_merchant");
  if (stationaryOk) {
    // Refresh the timestamp so we don't spam; merchants stand still legitimately.
    positionHistory.set(name, { x: tile.x, y: tile.y, checkedAt: nowMs });
    return;
  }

  // Recovery: clear any wedged movement state and walk to a nearby tile.
  // We use a small random offset from home — not home itself (which might
  // be the unreachable destination causing the stuck).
  try {
    const rng = agentRng(`alive:stuck:${name}:${nowMs >> 13}`);
    bot.getMovementQueue?.()?.clear?.();
    const home = record.home ?? tile;
    const nx = home.x + Math.floor(rng() * 7) - 3;
    const ny = home.y + Math.floor(rng() * 7) - 3;
    requestMovement(bot, nx, ny, home.z ?? 0, "citizen_alive_stuck_recovery");
    journalEvent(name, "Got turned around for a moment — back on my way.", "alive");
  } catch {
    // Non-fatal.
  }
  positionHistory.set(name, { x: tile.x, y: tile.y, checkedAt: nowMs });
}

// --- idle life -------------------------------------------------------------------

/**
 * When a citizen is stationary (not walking somewhere), make them feel
 * present: face nearby players, play idle animations, voice observations.
 * This is the difference between "a statue" and "a person waiting."
 */
function tickIdleLife(director, record, bot, nowMs) {
  if (isMoving(bot)) return; // only when stationary

  const rng = agentRng(`alive:idle:${record.username}:${nowMs >> 13}`);
  const profile = humanizerProfile(record.personality);
  const nearby = realPlayersNear(bot);
  const watched = nearby.length > 0;

  // Face a nearby player — the most basic "I see you" signal.
  if (watched && chance(rng, IDLE_FACE_CHANCE)) {
    const target = pickOne(rng, nearby);
    faceToward(bot, botTile(target));
  }

  // Idle animations: stretch, look around. Scaled by personality —
  // fidgety citizens fidget more.
  const emoteChance = IDLE_EMOTE_CHANCE * (profile.tempoSigma > 0.8 ? 1.8 : 1.0);
  if (chance(rng, emoteChance)) {
    const anims = [IDLE_ANIMS.stretch, IDLE_ANIMS.lookAround, IDLE_ANIMS.yawn];
    playAnim(director, bot, pickOne(rng, anims));
  }

  // Small observations, only when watched (nobody monologues to an empty room).
  if (watched && chance(rng, IDLE_OBSERVE_CHANCE * profile.chatRate)) {
    try {
      bot.forceChat?.(pickOne(rng, IDLE_OBSERVATIONS));
    } catch {
      // Cosmetic.
    }
  }

  // Rare expressive emote for high-sociability citizens.
  if (watched && profile.sociability > 1.2 && chance(rng, 0.02)) {
    const emotes = [EMOTES.wave, EMOTES.cheer, EMOTES.shrug];
    playAnim(director, bot, pickOne(rng, emotes));
  }

  // Stretch legs: stationary citizens occasionally wander a few tiles.
  // This is the most visible "alive" signal — a citizen who never moves
  // reads as a statue. Don't wander if the brain has them doing something
  // stationary on purpose (merchant tending stall).
  const activityId = record.currentActivityId ?? "";
  const rootedOk =
    activityId.includes("merchant") || activityId.includes("prime_merchant");
  if (!rootedOk && chance(rng, IDLE_WANDER_CHANCE)) {
    const tile = botTile(bot);
    if (tile) {
      const nx = tile.x + Math.floor(rng() * (IDLE_WANDER_RADIUS * 2 + 1)) - IDLE_WANDER_RADIUS;
      const ny = tile.y + Math.floor(rng() * (IDLE_WANDER_RADIUS * 2 + 1)) - IDLE_WANDER_RADIUS;
      if (nx !== tile.x || ny !== tile.y) {
        requestMovement(bot, nx, ny, tile.z, "citizen_alive_wander");
      }
    }
  }
}

// --- social awareness ------------------------------------------------------------

/**
 * Citizens notice each other. When two citizen bots pass within greeting
 * radius, they sometimes exchange a quick greeting — data-tier, zero LLM.
 * This makes cities feel alive even with zero real players around.
 */
const lastGreetAt = new Map(); // username -> timestamp

function tickSocialAwareness(director, record, bot, nowMs) {
  const name = record.username;
  if (nowMs - (lastGreetAt.get(name) ?? 0) < SOCIAL_GREET_COOLDOWN_MS) return;

  const rng = agentRng(`alive:social:${name}:${nowMs >> 13}`);
  const profile = humanizerProfile(record.personality);
  // Taciturn citizens rarely greet; chatty ones often do.
  const greetChance = SOCIAL_GREET_CHANCE * profile.sociability;
  if (!chance(rng, greetChance)) return;

  const others = citizenBotsNear(director, bot, SOCIAL_GREET_RADIUS);
  if (others.length === 0) return;

  const other = pickOne(rng, others);
  const otherName = other.getUsername?.() ?? "friend";
  lastGreetAt.set(name, nowMs);

  try {
    bot.forceChat?.(pickOne(rng, CITIZEN_GREETINGS));
  } catch {
    // Cosmetic.
  }
  journalEvent(name, `Greeted ${otherName} in passing.`, "social");

  // Sometimes the other citizen responds.
  if (chance(rng, 0.4 * profile.sociability)) {
    try {
      const responses = ["Hey!", "Good day!", "Alright, mate.", "You too!"];
      setTimeout(() => {
        try {
          other.forceChat?.(pickOne(rng, responses));
        } catch {
          // Cosmetic.
        }
      }, 1500 + Math.floor(rng() * 2000));
    } catch {
      // Non-fatal.
    }
  }
}

// --- imperfections -----------------------------------------------------------------

/**
 * Real players are imperfect: they get distracted mid-walk, change their
 * minds about where they're going, and misclick. This layer adds those
 * human moments to citizen movement.
 */
function tickImperfections(director, record, bot, nowMs) {
  const rng = agentRng(`alive:imperfect:${record.username}:${nowMs >> 13}`);
  const profile = humanizerProfile(record.personality);
  const moving = isMoving(bot);
  const watched = realPlayersNear(bot).length > 0;

  // Distraction: walking citizen pauses to look at something.
  // More likely for daydreamers, less for the dutiful.
  if (moving && chance(rng, DISTRACT_CHANCE * (profile.pauseRate / 0.1))) {
    try {
      bot.getMovementQueue?.()?.clear?.();
      if (watched && chance(rng, 0.5)) {
        bot.forceChat?.(pickOne(rng, DISTRACTION_LINES));
      }
      journalEvent(record.username, "Got distracted by something on the way.", "alive");
    } catch {
      // Non-fatal.
    }
    return;
  }

  // Change of mind: abandon current destination, wander somewhere new nearby.
  // Rare — real players don't do this constantly.
  if (moving && chance(rng, CHANGE_MIND_CHANCE)) {
    try {
      const tile = botTile(bot);
      if (tile) {
        bot.getMovementQueue?.()?.clear?.();
        const nx = tile.x + Math.floor(rng() * 11) - 5;
        const ny = tile.y + Math.floor(rng() * 11) - 5;
        requestMovement(bot, nx, ny, tile.z, "citizen_alive_changed_mind");
        journalEvent(record.username, "Changed my mind about where I was headed.", "alive");
      }
    } catch {
      // Non-fatal.
    }
  }
}

// --- movement styles ---------------------------------------------------------------

/**
 * Personality drives movement style. Returns a style descriptor used by
 * brain actions to modulate walk behavior. Called once per citizen;
 * the result is cached on the record.
 *
 * Styles:
 *  - hasty: fast, direct, few pauses (young, energetic, dutiful)
 *  - ambler: slow, frequent pauses, meandering (elderly, relaxed)
 *  - weaver: slight lateral weave, occasional stumble-pause (drunk, clumsy)
 *  - skittish: frequent stops, look-arounds, direction changes (nervous)
 *  - steady: default human walk (everyone else)
 */
function movementStyleFor(record) {
  // Note: callers may pass a lightweight { username, personality } shape
  // (brain actions have the player, not the director record), so this is
  // computed fresh each call. It's a few string checks — cheap enough.
  const traits = new Set(record.personality?.traits ?? []);
  const demeanor = String(record.personality?.demeanor ?? "").toLowerCase();
  const age = Number(record.personality?.age ?? 35);

  if (traits.has("drunk") || demeanor.includes("drunk")) {
    return "weaver";
  }
  if (demeanor.includes("nervous") || traits.has("skittish")) {
    return "skittish";
  }
  if (age >= 60 || traits.has("elderly")) {
    return "ambler";
  }
  if (
    traits.has("hasty") ||
    traits.has("energetic") ||
    demeanor.includes("brisk") ||
    (traits.has("dutiful") && age < 35)
  ) {
    return "hasty";
  }
  return "steady";
}

/**
 * Apply movement style to a walk request. Returns the (possibly modified)
 * destination. Brain actions call this before requestMovement to get
 * personality-flavored movement.
 */
function styleWalkTarget(record, x, y, rng) {
  const style = movementStyleFor(record);
  const random = rng ?? agentRng(`alive:walk:${record.username}:${Date.now() >> 14}`);
  switch (style) {
    case "weaver": {
      // Drunk weave: lateral offset on the destination.
      const weave = 2 + Math.floor(random() * 3);
      const dir = random() < 0.5 ? -1 : 1;
      return { x: x + dir * weave, y: y + Math.floor(random() * 3) - 1 };
    }
    case "ambler": {
      // Elderly: shorter legs, stop halfway is handled by pause logic.
      // Just add a bit more waypoint noise (less precise).
      return {
        x: x + Math.floor(random() * 5) - 2,
        y: y + Math.floor(random() * 5) - 2,
      };
    }
    case "skittish":
    case "hasty":
    default:
      return { x, y };
  }
}

/**
 * Should this citizen pause mid-walk right now? Called by brain actions
 * at walk decision points. Personality-scaled.
 */
function shouldPauseMidWalk(record, rng) {
  const style = movementStyleFor(record);
  const random = rng ?? agentRng(`alive:pause:${record.username}:${Date.now() >> 14}`);
  const baseRates = {
    hasty: 0.03,
    steady: 0.08,
    ambler: 0.18,
    weaver: 0.15,
    skittish: 0.25,
  };
  return chance(random, baseRates[style] ?? 0.08);
}

// --- emote reactions ------------------------------------------------------------

// Animation ids for common player emotes (from Emotes.plugin.js).
// Citizens react when they see a real player perform these nearby.
const EMOTE_ANIMS = Object.freeze({
  wave: 1286,
  cheer: 862,
  dance: 866,
  bow: 855,
  yes: 855, // nod (approximate)
});

const EMOTE_REACT_RADIUS = 8;
const EMOTE_REACT_COOLDOWN_MS = 2 * 60 * 1000;
const lastEmoteReactAt = new Map(); // username -> timestamp

/**
 * Citizens notice when real players emote nearby and react like real
 * players would: wave back, cheer along, bow in return. Data-tier, zero LLM.
 * Polled from the alive tick — no core plugin changes needed.
 */
function tickEmoteReactions(director, record, bot, nowMs) {
  const name = record.username;
  if (nowMs - (lastEmoteReactAt.get(name) ?? 0) < EMOTE_REACT_COOLDOWN_MS) return;

  const rng = agentRng(`alive:emote:${name}:${nowMs >> 13}`);
  const profile = humanizerProfile(record.personality);
  // Only sociable citizens react to emotes.
  if (profile.sociability < 0.8) return;

  for (const p of realPlayersNear(bot)) {
    let animId = null;
    try {
      animId = p.getAnimation?.()?.getId?.() ?? p.getAnimation?.();
    } catch {
      continue;
    }
    if (!Number.isInteger(animId)) continue;

    let reaction = null;
    let line = null;
    if (animId === EMOTE_ANIMS.wave) {
      reaction = EMOTES.wave;
      if (chance(rng, 0.5 * profile.chatRate)) line = pickOne(rng, ["Hey!", "Hello there!", "Well met!"]);
    } else if (animId === EMOTE_ANIMS.cheer) {
      reaction = EMOTES.cheer;
      if (chance(rng, 0.4 * profile.chatRate)) line = pickOne(rng, ["Huzzah!", "Well done!", "Cheers!"]);
    } else if (animId === EMOTE_ANIMS.dance) {
      reaction = EMOTES.dance;
      if (chance(rng, 0.3 * profile.chatRate)) line = pickOne(rng, ["Ha! Nice moves!", "Go on then!"]);
    } else if (animId === EMOTE_ANIMS.bow) {
      reaction = EMOTE_ANIMS.bow;
      if (chance(rng, 0.4 * profile.chatRate)) line = pickOne(rng, ["My lord.", "An honour."]);
    }
    if (!reaction) continue;

    // Check they're actually close enough to see it.
    const playerTile = botTile(p);
    const myTile = botTile(bot);
    if (!playerTile || !myTile || chebyshev(myTile, playerTile) > EMOTE_REACT_RADIUS) continue;

    lastEmoteReactAt.set(name, nowMs);
    playAnim(director, bot, reaction);
    faceToward(bot, playerTile);
    if (line) {
      try {
        // Small delay so it doesn't look instantaneous/robotic.
        setTimeout(() => {
          try {
            bot.forceChat?.(line);
          } catch {
            // Cosmetic.
          }
        }, 800 + Math.floor(rng() * 1200));
      } catch {
        // Non-fatal.
      }
    }
    const playerName = p.getUsername?.() ?? "traveller";
    journalEvent(name, `Reacted to ${playerName}'s emote.`, "social");
    break; // one reaction per tick max
  }
}

// --- public tick ---------------------------------------------------------------------

/**
 * The alive tick. Called from CitizenDirector.tick() once per ~60s tick.
 * All sub-ticks are data-tier, zero LLM, per-citizen try/catch.
 */
function tickAlive(director, nowMs, desync = null) {
  if (!director?.roster) return;
  for (const record of director.roster.values()) {
    if (!director.isOnline(record)) continue;
    const bot = director.getBot(record);
    if (!bot) continue;
    try {
      tickStuckDetection(director, record, bot, nowMs);
    } catch {
      // One bad citizen never breaks the tick.
    }
    // LOD brain gate: distant citizens skip visible-life work on most
    // cycles. Near-band (and unclassified) citizens are always due, so
    // behavior near players is unchanged. Runs before the desync hash —
    // a single Map lookup short-circuits the rest for distant citizens.
    if (!brainTickDue(director, record, desync?.tick)) {
      continue;
    }
    // Note: timing desync intentionally NOT applied to idle life. The desync
    // spread (10x) throttled visible behavior to ~1/10 the designed rate,
    // freezing citizens. LOD gate above handles distant-citizen perf; the
    // random chances in tickIdleLife provide natural variation without
    // synchronized waves.
    try {
      tickIdleLife(director, record, bot, nowMs);
    } catch {
      // Non-fatal.
    }
    try {
      tickSocialAwareness(director, record, bot, nowMs);
    } catch {
      // Non-fatal.
    }
    try {
      tickImperfections(director, record, bot, nowMs);
    } catch {
      // Non-fatal.
    }
    try {
      tickEmoteReactions(director, record, bot, nowMs);
    } catch {
      // Non-fatal.
    }
  }
  // Prune per-citizen cooldown maps for logged-out citizens (memory hygiene).
  // These maps are keyed by username and would otherwise grow across
  // spawn/despawn cycles. Memory-leak plug, 2026-10-07.
  try {
    const onlineNames = new Set();
    for (const record of director.roster.values()) {
      if (director.isOnline(record)) onlineNames.add(record.username);
    }
    for (const map of [positionHistory, lastGreetAt, lastEmoteReactAt]) {
      for (const name of [...map.keys()]) {
        if (!onlineNames.has(name)) map.delete(name);
      }
    }
  } catch {
    // Non-fatal.
  }
}

module.exports = {
  tickAlive,
  movementStyleFor,
  styleWalkTarget,
  shouldPauseMidWalk,
  // exposed for tests
  _positionHistory: positionHistory,
  _tickStuckDetection: tickStuckDetection,
  _tickIdleLife: tickIdleLife,
  _tickSocialAwareness: tickSocialAwareness,
  _tickImperfections: tickImperfections,
  _tickEmoteReactions: tickEmoteReactions,
  _playAnim: playAnim,
};
