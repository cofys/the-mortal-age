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
 *    standing at the market should feel present, not frozen. On top of
 *    that, idle MICRO-BEHAVIORS: citizens with truly nothing to do
 *    (no brain activity, no conversation, not following, not fighting,
 *    not trading) shift position within ~3 tiles of their anchor every
 *    45-90s and turn to face nearby points of interest every 20-40s —
 *    the fidget real players have and statues don't.
 *  - SOCIAL AWARENESS: citizens notice each other. When two citizens pass
 *    within a few tiles, they sometimes start a real conversation —
 *    multi-turn, one topic, human pacing — via chat/CitizenConversations.
 *    (The old fixed greeting+one-reply script lived here; it was the
 *    "always exactly 2 messages" tell. The engine owns the shape now.)
 *    Data-tier, zero LLM. The world feels alive even with no players around.
 *  - IMPERFECTIONS: real players get distracted, change their minds, and
 *    misclick. Citizens do too: mid-walk pauses to look at something,
 *    occasional destination changes, waypoint noise scaled by personality.
 *  - MOVEMENT STYLES: personality drives how citizens move. The hasty walk
 *    fast and direct; the elderly amble with pauses; the drunk weaves;
 *    the nervous stops and looks around.
 *
 * Data tier, zero LLM. Everything is wrapped per-citizen in try/catch.
 * Wiring: CitizenDirector.tickProximity() calls tickAlive(this, nowMs, desync) once per fast tick.
 */

const { agentRng, chance, logNormalJitter, humanizerProfile, noisyTile } = require("./humanizer");
const { getJournal } = require("./CitizenJournal");
const { brainTickDue } = require("./CitizenTickLod");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");
const CitizenConversations = require("../chat/CitizenConversations");
const { getFollow } = require("./CitizenBonds");


// --- tuning ------------------------------------------------------------------

const STUCK_THRESHOLD_MS = 3 * 60 * 1000; // 3 min without moving = stuck
const STUCK_CHECK_TILES = 2; // moved less than this = didn't move
const IDLE_FACE_CHANCE = 0.3; // per tick: turn to face a nearby player
const IDLE_EMOTE_CHANCE = 0.08; // per tick: play an idle emote/animation
const IDLE_OBSERVE_CHANCE = 0.12; // per tick: voice a small observation
// Idle micro-behaviors (drift + facing) live below with their own
// per-citizen cooldowns; see MICRO_* tuning.
const SOCIAL_GREET_RADIUS = 4; // tiles: citizens this close may greet
const SOCIAL_GREET_CHANCE = 0.15; // per eligible pair per tick
const SOCIAL_GREET_COOLDOWN_MS = 5 * 60 * 1000; // per citizen
// Player-directed initiation: occasionally a citizen hails a nearby REAL
// player instead of chatting with another citizen (rare, gated).
const PLAYER_HAIL_RADIUS = 10; // tiles: players this close may be hailed
const PLAYER_HAIL_CHANCE = 0.06; // per eligible citizen per tick, sociability-scaled
const PLAYER_HAIL_PLAYER_COOLDOWN_MS = 20 * 60 * 1000; // a player is hailed at most every 20 min
const lastHailedPlayerAt = new Map(); // player name -> timestamp
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

/**
 * Turn a citizen to face a tile. Citizens are full Player objects, so the
 * real engine API is Mobile.setPositionToFaceCoordinates — it flags
 * FACE_POSITION and the sync packet carries the facing to nearby clients
 * (verified: PlayerSession faceDirection from the flagged positionToFace).
 * The old bot.face?.(x, y) call was a silent no-op: Player has no `face`
 * method (only NPC.faceTile exists), so every idle look-around, newcomer
 * glance, and conversation face silently did nothing. This is the shared
 * helper — chat layers (CitizenSocial, CitizenConversations) use it via
 * lazy require to avoid a load cycle.
 * @returns {boolean} true when a facing update was issued
 */
function faceToward(bot, targetTile) {
  try {
    const my = botTile(bot);
    if (!my || !targetTile) return false;
    const dx = Math.sign(targetTile.x - my.x);
    const dy = Math.sign(targetTile.y - my.y);
    if (dx === 0 && dy === 0) return false;
    if (typeof bot?.setPositionToFaceCoordinates === "function") {
      bot.setPositionToFaceCoordinates(targetTile.x, targetTile.y, targetTile.z ?? my.z ?? 0);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function requestMovement(bot, x, y, z, reason) {
  try {
    const { requestMovement: rm } = require("../../bots/behaviours/navigation/Navigation.PlayerBots.js");
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
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: IDLE_OBSERVATIONS }, rng)); }
    } catch {
      // Cosmetic.
    }
  }

  // Rare expressive emote for high-sociability citizens.
  if (watched && profile.sociability > 1.2 && chance(rng, 0.02)) {
    const emotes = [EMOTES.wave, EMOTES.cheer, EMOTES.shrug];
    playAnim(director, bot, pickOne(rng, emotes));
  }
}

// --- idle micro-behaviors ---------------------------------------------------------

/**
 * Idle micro-behaviors — position drift + facing changes for citizens with
 * nothing to do. "Stand frozen for 30 minutes" is the canonical NPC tell;
 * real players fidget: they shift their weight, turn to look at things,
 * take a few steps, check their inventory.
 *
 * This is strictly idle-time behavior, never a decision-layer change:
 * - It NEVER fires when the citizen has an active brain activity, is in
 *   conversation, is following someone, is in combat, or is trading.
 * - It NEVER fights CitizenDecisions: the brain's frame state is checked
 *   every tick, so the moment the brain picks an activity the
 *   micro-behavior yields (state is dropped, anchor re-set next idle spell).
 *
 * Zero LLM. Real engine movement APIs via BotNavigation (same as the
 * follow/activity movement). Targets use humanizer noisyTile (uniform
 * disc-offset) so drifting citizens don't stack on one tile.
 */

const MICRO_DRIFT_MIN_MS = 45 * 1000; // drift every 45-90s, personality-scaled
const MICRO_DRIFT_MAX_MS = 90 * 1000;
const MICRO_FACE_MIN_MS = 20 * 1000; // face changes every 20-40s
const MICRO_FACE_MAX_MS = 40 * 1000;
const MICRO_DRIFT_RADIUS = 3; // tiles from the idle anchor
const MICRO_POI_RADIUS = 8; // tiles: nearby citizens/players worth looking at

const microState = new Map(); // username -> { anchor, driftAt, faceAt }

/**
 * True when the citizen's brain has an active activity frame. Mirrors the
 * "idle brain" concept in CitizenDecisions.interruptTarget: no frames, or
 * a top frame with no behaviour id, means the decision layer hasn't given
 * them anything to do — that's when micro-behaviors are allowed.
 */
function brainHasActiveActivity(director, username) {
  try {
    const entry = director?.runtime?.()?.entriesByUsername?.get(username);
    const frames = entry?.brain?.frames ?? [];
    const top = frames[frames.length - 1];
    return frames.length > 0 && !!top?.behaviour?.id;
  } catch {
    return false;
  }
}

/** Mirrors BotBehaviorTask.isInCombat: target, attacker, or combat-follow. */
function botInCombat(bot) {
  try {
    const combat = bot.getCombat?.();
    return !!(
      combat?.getTarget?.() ||
      combat?.getAttacker?.() ||
      bot.getCombatFollowing?.()
    );
  } catch {
    return false;
  }
}

/** A trade window is open on the bot. */
function botTrading(bot) {
  try {
    return !!bot.getTrading?.()?.getState?.()?.isTrading?.();
  } catch {
    return false;
  }
}

/**
 * Strict idle gate. Micro-behaviors must never interrupt: an active
 * activity, a conversation, following, combat, or trading. Pure-ish —
 * reads live state, no side effects. Exported for tests.
 */
function isMicroIdle(director, record, bot) {
  const name = record.username;
  if (isMoving(bot)) return false;
  if (brainHasActiveActivity(director, name)) return false;
  try {
    if (CitizenConversations.activeConversationFor(name)) return false;
  } catch {
    // Non-fatal.
  }
  try {
    if (getFollow(name)) return false;
  } catch {
    // Non-fatal.
  }
  if (botInCombat(bot)) return false;
  if (botTrading(bot)) return false;
  return true;
}

/**
 * Pure: next position-drift delay. Restless (fidgety) citizens drift more
 * often; methodical ones rarely do. Unit-tested.
 */
function microDriftIntervalMs(profile, rng) {
  const random = typeof rng === "function" ? rng : Math.random;
  const tempo = profile?.tempoSigma ?? 0.7;
  const scale = 0.7 / Math.max(0.2, tempo); // fidgety 1.0 -> 0.7x, methodical 0.45 -> ~1.56x
  const base =
    MICRO_DRIFT_MIN_MS + random() * (MICRO_DRIFT_MAX_MS - MICRO_DRIFT_MIN_MS);
  return Math.round(base * scale);
}

/** Pure: next facing-change delay, 20-40s. Unit-tested. */
function microFaceIntervalMs(rng) {
  const random = typeof rng === "function" ? rng : Math.random;
  return Math.round(
    MICRO_FACE_MIN_MS + random() * (MICRO_FACE_MAX_MS - MICRO_FACE_MIN_MS)
  );
}

/**
 * Pure: pick where to face. Half the time a nearby point of interest
 * (another citizen, a player walking by); otherwise a random nearby
 * direction (1-2 tiles out). Unit-tested.
 */
function pickFaceTarget(rng, myTile, poiTiles) {
  const random = typeof rng === "function" ? rng : Math.random;
  if (Array.isArray(poiTiles) && poiTiles.length > 0 && random() < 0.5) {
    return poiTiles[Math.floor(random() * poiTiles.length)];
  }
  const angle = random() * 2 * Math.PI;
  const dist = 1 + Math.floor(random() * 2);
  return {
    x: myTile.x + Math.round(Math.cos(angle) * dist),
    y: myTile.y + Math.round(Math.sin(angle) * dist),
    z: myTile.z,
  };
}

/**
 * The micro-behavior tick. Runs inside the existing alive tick (no new
 * tick system). Returns { drifted, faced } for tests; callers ignore it.
 */
function tickIdleMicrobehaviors(director, record, bot, nowMs) {
  const name = record.username;
  let st = microState.get(name);
  if (!isMicroIdle(director, record, bot)) {
    // Yield immediately: the brain picked an activity or the citizen got
    // busy. Drop the anchor so the next idle spell re-anchors from scratch.
    if (st) microState.delete(name);
    return { drifted: null, faced: false };
  }
  const tile = botTile(bot);
  if (!tile) return { drifted: null, faced: false };
  if (!st) {
    st = { anchor: null, driftAt: 0, faceAt: 0 };
    microState.set(name, st);
  }
  // If something else moved the citizen far off-anchor (safety-net
  // wander, a shove), their idle spot is here now — re-anchor instead of
  // dragging them back.
  if (!st.anchor || chebyshev(tile, st.anchor) > MICRO_DRIFT_RADIUS) {
    st.anchor = { x: tile.x, y: tile.y, z: tile.z };
  }
  const rng = agentRng(`alive:micro:${name}:${nowMs >> 14}`);
  const profile = humanizerProfile(record.personality);
  const out = { drifted: null, faced: false };

  // Position drift: shift weight / reposition within ~3 tiles of the
  // anchor, never pacing off somewhere. noisyTile is the humanizer
  // disc-offset — uniform on the disc, so drift targets spread instead
  // of stacking on the anchor tile.
  if (nowMs >= st.driftAt) {
    st.driftAt = nowMs + microDriftIntervalMs(profile, rng);
    const target = noisyTile(st.anchor.x, st.anchor.y, MICRO_DRIFT_RADIUS, rng);
    if (target.x !== tile.x || target.y !== tile.y) {
      if (requestMovement(bot, target.x, target.y, tile.z, "citizen_idle_drift")) {
        out.drifted = target;
      }
    }
  }

  // Facing changes: turn toward a nearby citizen, a player walking by, or
  // a random direction. Highly visible, costs nothing.
  if (nowMs >= st.faceAt) {
    st.faceAt = nowMs + microFaceIntervalMs(rng);
    const pois = [];
    for (const other of citizenBotsNear(director, bot, MICRO_POI_RADIUS)) {
      const t = botTile(other);
      if (t) pois.push(t);
    }
    for (const p of realPlayersNear(bot)) {
      const t = botTile(p);
      if (t) pois.push(t);
    }
    if (faceToward(bot, pickFaceTarget(rng, tile, pois))) {
      out.faced = true;
    }
  }
  return out;
}

// --- social awareness ------------------------------------------------------------

/**
 * Citizens notice each other. When two citizen bots pass within greeting
 * radius, they sometimes exchange a quick greeting — data-tier, zero LLM.
 * This makes cities feel alive even with zero real players around.
 */
const lastGreetAt = new Map(); // username -> timestamp

/**
 * Citizens notice each other. When two citizen bots pass within greeting
 * radius, they sometimes start a conversation — owned end-to-end by
 * chat/CitizenConversations (multi-turn, one real-state topic, variable
 * length, human pacing). This starter keeps the volume gates: per-citizen
 * start cooldown, sociability-scaled chance, nobody starts a second chat
 * while already in one, and open feuds/enemies never chat.
 */

/**
 * A citizen occasionally hails a nearby REAL player — real players call
 * out to people standing near them, not just to other NPCs. Heavily
 * gated: the player-side cooldown lives here, the citizen-side cooldown
 * and conversation caps live in the engine. Returns true when a hail
 * started (the caller should stop for this tick).
 */
function maybeHailPlayer(director, record, bot, nowMs) {
  try {
    const myTile = botTile(bot);
    if (!myTile) return false;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || !isRealPlayer(p)) continue;
      const name = p.getUsername?.();
      if (!name) continue;
      if (nowMs - (lastHailedPlayerAt.get(name) ?? 0) < PLAYER_HAIL_PLAYER_COOLDOWN_MS) continue;
      const pt = botTile(p);
      if (!pt || chebyshev(myTile, pt) > PLAYER_HAIL_RADIUS) continue;
      // Don't hail someone mid-fight — StreetActivity already comments
      // on fights; an opener there would be odd.
      try {
        if (p.inCombat?.() === true) continue;
      } catch {
        // Unknown is hail-able.
      }
      const conv = CitizenConversations.maybePlayerInitiate(director, record, bot, name, p, nowMs);
      if (conv) {
        lastHailedPlayerAt.set(name, nowMs);
        return true;
      }
    }
  } catch {
    // Non-fatal.
  }
  return false;
}

function tickSocialAwareness(director, record, bot, nowMs) {
  const name = record.username;
  if (nowMs - (lastGreetAt.get(name) ?? 0) < SOCIAL_GREET_COOLDOWN_MS) return;
  if (CitizenConversations.activeConversationFor(name)) return;

  const rng = agentRng(`alive:social:${name}:${nowMs >> 13}`);
  const profile = humanizerProfile(record.personality);
  // Taciturn citizens rarely start chats; chatty ones often do.
  const greetChance = SOCIAL_GREET_CHANCE * profile.sociability;
  if (!chance(rng, greetChance)) return;

  // Player-directed initiation rolls first: even in a crowded square,
  // citizens sometimes hail the actual player standing near them.
  if (chance(rng, PLAYER_HAIL_CHANCE * profile.sociability)) {
    if (maybeHailPlayer(director, record, bot, nowMs)) {
      lastGreetAt.set(name, nowMs);
      return;
    }
  }

  const others = citizenBotsNear(director, bot, SOCIAL_GREET_RADIUS);
  if (others.length === 0) return;

  const other = pickOne(rng, others);
  const otherName = other.getUsername?.() ?? null;
  if (!otherName) return;
  if (CitizenConversations.activeConversationFor(otherName)) return;

  let otherRecord = null;
  try {
    const { normalizeName } = require("./CitizenBonds");
    otherRecord = director.roster?.get(normalizeName(otherName)) ?? null;
  } catch {
    otherRecord = null;
  }
  if (!otherRecord) return;

  // Open feuds and real enmity silence small talk (mirrors CitizenSocial).
  try {
    const { isOpenFeud } = require("./CitizenKinship");
    if (isOpenFeud(name, otherName) || isOpenFeud(otherName, name)) return;
  } catch {
    // Non-fatal.
  }

  lastGreetAt.set(name, nowMs);
  CitizenConversations.maybeStart(director, record, bot, otherRecord, other, nowMs, {
    rng,
  });
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
  // More likely for daydreamers, less for the dutiful. The pause turns
  // into a pause-and-scan: the citizen stops AND turns toward whatever
  // caught their eye, which reads as looking around instead of a pathing
  // hiccup. (The client only honors facing when standing — a glance
  // issued mid-walk is invisible, so the turn happens with the stop.)
  if (moving && chance(rng, DISTRACT_CHANCE * (profile.pauseRate / 0.1))) {
    try {
      bot.getMovementQueue?.()?.clear?.();
      try {
        const myTile = botTile(bot);
        if (myTile) {
          const pois = [];
          for (const other of citizenBotsNear(director, bot, MICRO_POI_RADIUS)) {
            const t = botTile(other);
            if (t) pois.push(t);
          }
          for (const p of realPlayersNear(bot)) {
            const t = botTile(p);
            if (t) pois.push(t);
          }
          faceToward(bot, pickFaceTarget(rng, myTile, pois));
        }
      } catch {
        // A failed glance never blocks the pause.
      }
      if (watched && chance(rng, 0.5)) {
        { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: DISTRACTION_LINES }, rng)); }
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
            { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); }
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
 * The alive tick. Called from CitizenDirector.tickProximity() once per ~10s fast tick.
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
    // Idle micro-behaviors: anchored position drift + facing changes for
    // citizens with nothing to do. Strict idle gate inside — yields the
    // moment the brain picks an activity.
    try {
      tickIdleMicrobehaviors(director, record, bot, nowMs);
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
  // Conversation housekeeping: prune finished/stale conversations and
  // expired per-citizen chat cooldowns (bounded by the engine's own caps).
  try {
    CitizenConversations.housekeep(nowMs);
  } catch {
    // Non-fatal.
  }
  // Prune per-citizen cooldown maps for logged-out citizens (memory hygiene).
  // These maps are keyed by username and would otherwise grow across
  // spawn/despawn cycles. Memory-leak plug, 2026-10-07.
  try {
    const onlineNames = new Set();
    for (const record of director.roster.values()) {
      if (director.isOnline(record)) onlineNames.add(record.username);
    }
    for (const map of [positionHistory, lastGreetAt, lastEmoteReactAt, microState]) {
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
  faceToward,
  // exposed for tests
  _positionHistory: positionHistory,
  _tickStuckDetection: tickStuckDetection,
  _tickIdleLife: tickIdleLife,
  _tickSocialAwareness: tickSocialAwareness,
  _tickImperfections: tickImperfections,
  _tickEmoteReactions: tickEmoteReactions,
  _tickIdleMicrobehaviors: tickIdleMicrobehaviors,
  _isMicroIdle: isMicroIdle,
  _microState: microState,
  microDriftIntervalMs,
  microFaceIntervalMs,
  pickFaceTarget,
  MICRO_DRIFT_MIN_MS,
  MICRO_DRIFT_MAX_MS,
  MICRO_FACE_MIN_MS,
  MICRO_FACE_MAX_MS,
  MICRO_DRIFT_RADIUS,
  _playAnim: playAnim,
};
