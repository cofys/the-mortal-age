"use strict";

/**
 * CitizenIntents — session intents: citizens log in with a plan (model doc
 * build step 3, section 3 "Session arcs").
 *
 * A real player logs in thinking "I want 5k fishing XP and to sell my logs."
 * Citizens materialized with no plan just exist until logout. This module
 * gives each materialization 1-3 concrete, measurable intents:
 *
 *   Bartle weighting (Gemini OSRS research, model doc appendix): ~80% of
 *   players are Socializers, ~10% Achievers, ~10% Explorers. Personality
 *   traits map to a Bartle type, and most citizens get SOCIAL intents, not
 *   economic ones. A server where everyone intends "earn 2000 coins" is the
 *   bot tell.
 *     socializer (chatty/easygoing/cheerful, the default): "catch up with
 *       friends at the market", "join the tavern crowd"
 *     achiever (dutiful/methodical/greedy): "earn 2000 coins",
 *       "gain 1500 Fishing XP"
 *     explorer (daydreamer): "see the market, tavern, and bank",
 *       "try a different skill today"
 *
 * Intent lifecycle: generated on first brain tick after materialize ("login
 * with a plan", journaled) -> sampled on the decision cadence -> completed
 * intents get a visible reaction + journal entry -> all done = wind-down
 * (bank, socialize, "done for the day"; the director's sleep cycle handles
 * the actual logout). Intents persist in a username-keyed Map, so they
 * survive logout/login like CitizenNeeds does.
 *
 * Spontaneous goal shifts (SDT autonomy, model appendix finding 3): ~5% of
 * sessions abandon the current intent mid-session for an unrelated one,
 * like a player ditching a grind to do something fun. Separate from the
 * decision layer's epsilon-greedy micro-choices — this is a macro interrupt.
 *
 * Drives the decision layer via intentBonusFor(activityId, player): added
 * to CitizenDecisions scores. Zero LLM, pure arithmetic. No parallel needs
 * system — reads CitizenNeeds/goals/inventory state only.
 *
 * Two-tier safe: no-ops for non-citizens; every public function guards
 * its reads. There is no hunger in RuneScape — food need is HP-driven;
 * "restock" intents are about carrying food for healing.
 */

const { needsFor, breadCount } = require("./CitizenNeeds");
const { siteTile } = require("./CitizenSites");
const { coinWealth } = require("../lib/goals");
const { getJournal } = require("../lib/CitizenJournal");
const {
  ATTR_CITIZEN_ROLE,
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_INTENTS,
} = require("../constants");
const { hashSeed, agentRng, chance } = require("../lib/humanizer");
const { sayPublic } = require("../chat/CitizenSayPublic");

// ---------------------------------------------------------------------------
// Bartle types
// ---------------------------------------------------------------------------

const BARTLE_SOCIALIZER = "socializer";
const BARTLE_ACHIEVER = "achiever";
const BARTLE_EXPLORER = "explorer";

/**
 * Personality traits -> Bartle type. Strong achiever/explorer signals win;
 * everyone else is a socializer (the ~80% majority). Deterministic per
 * citizen — a citizen is the same kind of player every session.
 */
function bartleTypeFor(personality) {
  const traits = new Set(personality?.traits ?? []);
  if (traits.has("dutiful") || traits.has("methodical") || traits.has("greedy")) {
    return BARTLE_ACHIEVER;
  }
  if (traits.has("daydreamer")) {
    return BARTLE_EXPLORER;
  }
  return BARTLE_SOCIALIZER;
}

// ---------------------------------------------------------------------------
// Intent types
// ---------------------------------------------------------------------------

const INTENT_EARN_COINS = "earn_coins";
const INTENT_GAIN_XP = "gain_xp";
const INTENT_SOCIALIZE = "socialize";
const INTENT_EXPLORE = "explore";
const INTENT_RESTOCK = "restock";

// Skill indices in Skill.VALUES order (see Skill.ts).
const SKILL_WOODCUTTING = 8;
const SKILL_FISHING = 10;
const SKILL_MINING = 14;
const SKILL_NAMES = {
  [SKILL_WOODCUTTING]: "Woodcutting",
  [SKILL_FISHING]: "Fishing",
  [SKILL_MINING]: "Mining",
};
const WORK_SKILLS = [SKILL_WOODCUTTING, SKILL_FISHING, SKILL_MINING];

// Anchor kinds an explorer can "visit".
const EXPLORE_ANCHORS = ["market", "tavern", "bank", "court"];
const EXPLORE_VISIT_RADIUS = 10; // tiles (Chebyshev)

// A session's intents expire after this long — a new "day", fresh plan.
const SESSION_MAX_AGE_MS = 4 * 3600 * 1000;
// After all intents resolve, the citizen winds down (bank, socialize) for
// this long before a fresh session begins. The director's sleep cycle
// usually logs them out first; this covers long sessions.
const WIND_DOWN_MS = 15 * 60 * 1000;
// ~5% of sessions get a spontaneous mid-session goal shift.
const SHIFT_CHANCE = 0.05;
const SHIFT_DELAY_MIN_MS = 10 * 60 * 1000;
const SHIFT_DELAY_JITTER_MS = 30 * 60 * 1000;

// Intent count per session: 1-3, hash-varied.
const MAX_INTENTS = 3;

const SOCIAL_TEMPLATES = [
  { label: "catch up with friends at the market", minutes: 20 },
  { label: "join the tavern crowd", minutes: 15 },
  { label: "hang out at the bank", minutes: 12 },
  { label: "see who's around the square", minutes: 15 },
  { label: "chat with the regulars", minutes: 18 },
];

const DONE_LINES = {
  [INTENT_EARN_COINS]: ["Made my coins. Nice.", "That's the money sorted.", "Good haul today."],
  [INTENT_GAIN_XP]: ["XP grind done.", "Levels going up.", "That's enough training."],
  [INTENT_SOCIALIZE]: ["Good times.", "Great catching up.", "Love this crowd."],
  [INTENT_EXPLORE]: ["Seen the whole city.", "Good walkabout.", "Know this place better now."],
  [INTENT_RESTOCK]: ["Stocked up.", "Got my food sorted.", "Ready for anything now."],
};

/** username -> { intents, sessionId, createdAt, windingDown, shiftAt, shifted, lastSampleMs } */
const sessionsByUser = new Map();
let lastPruneAt = 0;

function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) {
    return;
  }
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, s] of sessionsByUser) {
    if ((s?.createdAt ?? 0) < cutoff) {
      sessionsByUser.delete(k);
    }
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function isCitizen(player) {
  try {
    const role = player?.getAttribute?.(ATTR_CITIZEN_ROLE);
    return typeof role === "string" && role.length > 0;
  } catch {
    return false;
  }
}

function personalityOf(player) {
  try {
    return player?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    return {};
  }
}

function roleOf(player) {
  try {
    return player?.getAttribute?.(ATTR_CITIZEN_ROLE) ?? "commoner";
  } catch {
    return "commoner";
  }
}

function foodCount(player) {
  try {
    return breadCount(player);
  } catch {
    return 0;
  }
}

function xpFor(player, skillIndex) {
  try {
    return player?.getSkillManager?.()?.getExperience?.(skillIndex) ?? 0;
  } catch {
    return 0;
  }
}

function journal(player, text) {
  try {
    const username = usernameOf(player);
    if (username) {
      getJournal().log(username, "intent", text);
    }
  } catch {
    // Journaling never breaks the tick.
  }
}

function say(player, text) {
  try {
    // Player-style speech: overhead + chat box.
    sayPublic(player, text);
  } catch {
    // Cosmetic only.
  }
}

function fmtCoins(n) {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`;
}

// ---------------------------------------------------------------------------
// Intent generation
// ---------------------------------------------------------------------------

function pickTemplate(rng, templates) {
  return templates[Math.floor(rng() * templates.length) % templates.length];
}

function makeIntent(type, label, target, extra = {}) {
  return {
    id: `intent_${Math.floor(Math.random() * 1e9).toString(36)}`,
    type,
    label,
    target,
    baseline: 0,
    progress: 0,
    status: "active",
    createdAt: Date.now(),
    completedAt: 0,
    ...extra,
  };
}

/**
 * Build 1-3 intents for a citizen's session. Deterministic-ish per citizen
 * per session (seeded rng) with state-driven additions (low food -> restock).
 * Pure except for baseline reads (coins, xp, food).
 */
function generateIntents(player, nowMs = Date.now()) {
  const username = usernameOf(player);
  const rng = agentRng(`intents:${username ?? "unknown"}:${Math.floor(nowMs / SESSION_MAX_AGE_MS)}`);
  const bartle = bartleTypeFor(personalityOf(player));
  const role = roleOf(player);
  const intents = [];

  // State-driven: nearly out of food -> restock first (HP is life).
  if (foodCount(player) < 3) {
    const target = 5 + Math.floor(rng() * 4); // 5-8 food
    const intent = makeIntent(
      INTENT_RESTOCK,
      "restock food",
      target,
      { bartle }
    );
    intent.baseline = foodCount(player);
    intents.push(intent);
  }

  const remaining = MAX_INTENTS - intents.length;
  const count = Math.min(remaining, 1 + Math.floor(rng() * 2)); // 1-2 more

  for (let i = 0; i < count; i++) {
    if (bartle === BARTLE_ACHIEVER) {
      if (chance(rng, 0.5)) {
        const target = 1500 + Math.floor(rng() * 1500); // 1500-3000 coins
        const intent = makeIntent(INTENT_EARN_COINS, `earn ${fmtCoins(target)} coins`, target, { bartle });
        intent.baseline = coinWealth(player);
        intents.push(intent);
      } else if (role === "commoner") {
        const skillIndex = WORK_SKILLS[Math.floor(rng() * WORK_SKILLS.length)];
        const target = 1000 + Math.floor(rng() * 1500); // 1000-2500 xp
        const intent = makeIntent(
          INTENT_GAIN_XP,
          `gain ${fmtCoins(target)} ${SKILL_NAMES[skillIndex]} XP`,
          target,
          { bartle, skillIndex, skillName: SKILL_NAMES[skillIndex] }
        );
        intent.baseline = xpFor(player, skillIndex);
        intents.push(intent);
      } else {
        const target = 1500 + Math.floor(rng() * 1500);
        const intent = makeIntent(INTENT_EARN_COINS, `earn ${fmtCoins(target)} coins`, target, { bartle });
        intent.baseline = coinWealth(player);
        intents.push(intent);
      }
    } else if (bartle === BARTLE_EXPLORER) {
      if (chance(rng, 0.6)) {
        const target = 3; // distinct anchors
        intents.push(
          makeIntent(INTENT_EXPLORE, "see the market, tavern, and bank", target, {
            bartle,
            anchors: [],
          })
        );
      } else {
        // Try a different skill: pick one, any one.
        const skillIndex = WORK_SKILLS[Math.floor(rng() * WORK_SKILLS.length)];
        const target = 800 + Math.floor(rng() * 1200);
        const intent = makeIntent(
          INTENT_GAIN_XP,
          `try some ${SKILL_NAMES[skillIndex]} today`,
          target,
          { bartle, skillIndex, skillName: SKILL_NAMES[skillIndex] }
        );
        intent.baseline = xpFor(player, skillIndex);
        intents.push(intent);
      }
    } else {
      // Socializer majority: social intents, light and interleaved.
      const t = pickTemplate(rng, SOCIAL_TEMPLATES);
      intents.push(
        makeIntent(INTENT_SOCIALIZE, t.label, t.minutes, { bartle })
      );
      // Occasionally one light economic intent alongside.
      if (intents.length < MAX_INTENTS && chance(rng, 0.25)) {
        const target = 800 + Math.floor(rng() * 700);
        const intent = makeIntent(INTENT_EARN_COINS, `earn ${fmtCoins(target)} coins`, target, { bartle });
        intent.baseline = coinWealth(player);
        intents.push(intent);
      }
    }
  }

  return { intents, bartle };
}

/**
 * Ensure this citizen has an active session. Called on the brain's tick
 * cadence — the first call after materialize is the "login with a plan"
 * moment. Returns the session or null.
 */
function ensureSession(player, nowMs = Date.now()) {
  if (!isCitizen(player)) {
    return null;
  }
  const username = usernameOf(player);
  if (!username) {
    return null;
  }
  pruneState(nowMs);
  let session = sessionsByUser.get(username);
  const expired = session && nowMs - session.createdAt > SESSION_MAX_AGE_MS;
  const finished =
    session && session.intents.length > 0 && session.intents.every((i) => i.status !== "active");
  // A finished session winds down first (bank, socialize, "done for the
  // day") — it only renews after the wind-down period, so the arc is
  // visible instead of instantly restarting.
  const windDownOver =
    session &&
    session.windingDown &&
    nowMs - (session.woundDownAt ?? 0) > WIND_DOWN_MS;
  if (!session || expired || (finished && windDownOver)) {
    const { intents, bartle } = generateIntents(player, nowMs);
    const rng = agentRng(`shift:${username}:${nowMs}`);
    session = {
      intents,
      bartle,
      sessionId: `${username}:${nowMs}`,
      createdAt: nowMs,
      windingDown: false,
      woundDownAt: 0,
      // ~5% of sessions: spontaneous mid-session goal shift.
      shiftAt:
        rng() < SHIFT_CHANCE
          ? nowMs + SHIFT_DELAY_MIN_MS + Math.floor(rng() * SHIFT_DELAY_JITTER_MS)
          : 0,
      shifted: false,
      lastSampleMs: nowMs,
    };
    sessionsByUser.set(username, session);
    // Login with a plan, journaled and visible.
    const labels = intents.map((i) => i.label).join("; ");
    journal(player, `Today: ${labels}.`);
    mirrorAttribute(player, session);
  }
  return session;
}

/** Read-only accessor for the decision layer and tests. */
function sessionFor(player) {
  const username = usernameOf(player);
  return (username && sessionsByUser.get(username)) || null;
}

function activeIntents(player) {
  const session = sessionFor(player);
  if (!session) {
    return [];
  }
  return session.intents.filter((i) => i.status === "active");
}

/** Small attribute mirror for inspection/debugging. */
function mirrorAttribute(player, session) {
  try {
    const summary = session.intents.map((i) => ({
      t: i.type,
      label: i.label,
      s: i.status,
      p: Math.round(i.progress),
      tg: i.target,
    }));
    player?.setAttribute?.(ATTR_CITIZEN_INTENTS, JSON.stringify(summary).slice(0, 500));
  } catch {
    // Inspection-only.
  }
}

// ---------------------------------------------------------------------------
// Progress sampling + completion
// ---------------------------------------------------------------------------

function currentActivityId(brain) {
  try {
    const frames = brain?.frames ?? [];
    const frame = frames[frames.length - 1];
    return frame?.behaviour?.id ?? null;
  } catch {
    return null;
  }
}

const SOCIAL_ACTIVITIES = new Set(["tavern_social", "leisure_stroll", "courtier_attend"]);

function atAnchor(player, kind) {
  try {
    const tile = siteTile(player, kind);
    if (!tile) {
      return false;
    }
    const loc = player?.getLocation?.();
    if (!loc) {
      return false;
    }
    return (
      Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <=
      EXPLORE_VISIT_RADIUS
    );
  } catch {
    return false;
  }
}

/** Sample one intent's progress. Returns true when newly completed. */
function sampleIntent(intent, player, activityId, elapsedMin) {
  if (intent.status !== "active") {
    return false;
  }
  switch (intent.type) {
    case INTENT_EARN_COINS: {
      intent.progress = Math.max(0, coinWealth(player) - intent.baseline);
      break;
    }
    case INTENT_GAIN_XP: {
      intent.progress = Math.max(0, xpFor(player, intent.skillIndex) - intent.baseline);
      break;
    }
    case INTENT_SOCIALIZE: {
      if (activityId && SOCIAL_ACTIVITIES.has(activityId)) {
        intent.progress += elapsedMin;
      }
      break;
    }
    case INTENT_EXPLORE: {
      for (const kind of EXPLORE_ANCHORS) {
        if (!intent.anchors.includes(kind) && atAnchor(player, kind)) {
          intent.anchors.push(kind);
        }
      }
      intent.progress = intent.anchors.length;
      break;
    }
    case INTENT_RESTOCK: {
      intent.progress = foodCount(player);
      break;
    }
    default:
      return false;
  }
  if (intent.progress >= intent.target) {
    intent.status = "done";
    intent.completedAt = Date.now();
    intent.progress = intent.target; // clamp for display
    return true;
  }
  return false;
}

function completeIntent(player, intent) {
  const lines = DONE_LINES[intent.type] ?? ["Done."];
  say(player, lines[Math.floor(Math.random() * lines.length)]);
  journal(player, `Done: ${intent.label}.`);
}

/**
 * Spontaneous goal shift: abandon a random active intent for an unrelated
 * one. Fires once per session at most.
 */
function maybeShiftGoal(player, session, nowMs) {
  if (!session.shiftAt || session.shifted || nowMs < session.shiftAt) {
    return false;
  }
  const active = session.intents.filter((i) => i.status === "active");
  if (active.length === 0) {
    return false;
  }
  const rng = agentRng(`shiftnow:${usernameOf(player)}:${nowMs}`);
  const victim = active[Math.floor(rng() * active.length)];
  victim.status = "abandoned";

  // New intent of a DIFFERENT type.
  const types = [INTENT_EARN_COINS, INTENT_GAIN_XP, INTENT_SOCIALIZE, INTENT_EXPLORE].filter(
    (t) => t !== victim.type
  );
  const newType = types[Math.floor(rng() * types.length)];
  let replacement;
  if (newType === INTENT_SOCIALIZE) {
    const t = SOCIAL_TEMPLATES[Math.floor(rng() * SOCIAL_TEMPLATES.length)];
    replacement = makeIntent(INTENT_SOCIALIZE, t.label, t.minutes, { bartle: session.bartle });
  } else if (newType === INTENT_EXPLORE) {
    replacement = makeIntent(INTENT_EXPLORE, "see the market, tavern, and bank", 3, {
      bartle: session.bartle,
      anchors: [],
    });
  } else if (newType === INTENT_GAIN_XP) {
    const skillIndex = WORK_SKILLS[Math.floor(rng() * WORK_SKILLS.length)];
    const target = 800 + Math.floor(rng() * 1200);
    replacement = makeIntent(
      INTENT_GAIN_XP,
      `try some ${SKILL_NAMES[skillIndex]} today`,
      target,
      { bartle: session.bartle, skillIndex, skillName: SKILL_NAMES[skillIndex] }
    );
    replacement.baseline = xpFor(player, skillIndex);
  } else {
    const target = 800 + Math.floor(rng() * 700);
    replacement = makeIntent(INTENT_EARN_COINS, `earn ${fmtCoins(target)} coins`, target, {
      bartle: session.bartle,
    });
    replacement.baseline = coinWealth(player);
  }
  session.intents.push(replacement);
  session.shifted = true;
  say(player, "Eh, changed my mind.");
  journal(player, `Dropped "${victim.label}" — doing "${replacement.label}" instead.`);
  mirrorAttribute(player, session);
  return true;
}

/**
 * Per-citizen intent tick. Called from the decision layer on its staggered
 * cadence (NOT every brain tick). Ensures the session, samples progress,
 * fires completions, shifts, and wind-down.
 */
function tickIntents(player, brain, nowMs = Date.now()) {
  if (!isCitizen(player)) {
    return;
  }
  const session = ensureSession(player, nowMs);
  if (!session) {
    return;
  }
  const elapsedMin = Math.max(0, (nowMs - (session.lastSampleMs ?? nowMs)) / 60000);
  session.lastSampleMs = nowMs;
  const activityId = currentActivityId(brain);

  let changed = false;
  for (const intent of session.intents) {
    if (sampleIntent(intent, player, activityId, elapsedMin)) {
      completeIntent(player, intent);
      changed = true;
    }
  }
  if (maybeShiftGoal(player, session, nowMs)) {
    changed = true;
  }
  // Wind-down: every intent resolved -> bank, socialize, done for the day.
  // The director's sleep cycle handles the actual logout; we just bias
  // decisions toward closing out.
  if (!session.windingDown && session.intents.every((i) => i.status !== "active")) {
    session.windingDown = true;
    session.woundDownAt = nowMs;
    journal(player, "Done for the day.");
    changed = true;
  }
  if (changed) {
    mirrorAttribute(player, session);
  }
}

// ---------------------------------------------------------------------------
// Decision-layer integration
// ---------------------------------------------------------------------------

const ACT_ROUTINE = "citizen_routine";
const ACT_MEAL = "citizen_meal";
const ACT_REST = "citizen_rest";
const ACT_BANK = "citizen_bank";
const ACT_SOCIAL = "tavern_social";

/**
 * Score bonus for one candidate activity, from the citizen's active intents.
 * Added to CitizenDecisions scores in pick(). Capped so intents steer but
 * never override critical needs (those score 58-70+ on their own).
 */
function intentBonusFor(activityId, player) {
  const session = sessionFor(player);
  if (!session) {
    return 0;
  }
  let bonus = 0;
  for (const intent of session.intents) {
    if (intent.status !== "active") {
      continue;
    }
    switch (intent.type) {
      case INTENT_EARN_COINS:
        if (activityId === ACT_ROUTINE) bonus += 25;
        else if (activityId === "merchant_tend" || activityId === "prime_merchant") bonus += 25;
        else if (activityId === "guard_patrol") bonus += 10;
        break;
      case INTENT_GAIN_XP:
        if (activityId === ACT_ROUTINE) bonus += 25;
        break;
      case INTENT_SOCIALIZE:
        if (activityId === ACT_SOCIAL) bonus += 30;
        else if (activityId === "leisure_stroll") bonus += 15;
        else if (activityId === "courtier_attend") bonus += 15;
        break;
      case INTENT_EXPLORE:
        if (activityId === "leisure_stroll") bonus += 25;
        else if (activityId === ACT_ROUTINE) bonus += 10;
        break;
      case INTENT_RESTOCK:
        if (activityId === ACT_MEAL) bonus += 20;
        else if (activityId === ACT_BANK) bonus += 10;
        break;
      default:
        break;
    }
  }
  if (session.windingDown) {
    if (activityId === ACT_BANK) bonus += 20;
    else if (activityId === ACT_SOCIAL) bonus += 15;
    else if (activityId === "leisure_stroll") bonus += 10;
  }
  return Math.min(40, bonus);
}

/** Test seam: clear all intent state. */
function resetForTests() {
  sessionsByUser.clear();
  lastPruneAt = 0;
}

module.exports = {
  BARTLE_SOCIALIZER,
  BARTLE_ACHIEVER,
  BARTLE_EXPLORER,
  INTENT_EARN_COINS,
  INTENT_GAIN_XP,
  INTENT_SOCIALIZE,
  INTENT_EXPLORE,
  INTENT_RESTOCK,
  bartleTypeFor,
  generateIntents,
  ensureSession,
  sessionFor,
  activeIntents,
  tickIntents,
  intentBonusFor,
  resetForTests,
  // Test seams:
  _sessionsByUser: sessionsByUser,
};
