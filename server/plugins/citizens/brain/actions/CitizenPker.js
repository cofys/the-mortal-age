"use strict";

/**
 * CitizenPker — wilderness player-hunting for citizens, the RuneScape way.
 *
 * A small, personality-gated slice of citizens (~5%) head into the Wilderness
 * and hunt REAL players with the real combat engine. Everything is real:
 *   - targeting is filtered by the Wilderness plugin's own level-range rule
 *     (canAttackByWildernessLevel), so the citizen can only hit legal targets;
 *   - attacking skulls the citizen via CombatFactory.handleSkull (core), and
 *     death drops their items like any player;
 *   - navigation crosses the Edgeville ditch through the brain's own
 *     DitchCrossing dispatch — requestMovement just works.
 *
 * Flow per tick:
 *   - Not a player-bot / not PK-willing / combat level too low -> "failed"
 *     (fail fast, don't stall). The decision layer should only offer this
 *     to eligible citizens; the action double-checks.
 *   - Carrying too much (won't risk the bank) or no food -> "success"
 *     (re-decide — a meal or bank run is the honest next step).
 *   - Session timer expired (5-15 min randomized) -> "success" (leave wild,
 *     re-decide — never hunt forever).
 *   - HP below FLEE_HP -> eat bread from inventory (real heal), and if
 *     still low, run to the Edgeville-side edge tile -> "success" once out.
 *   - Not in the Wilderness yet -> walk to the Edgeville ditch anchor.
 *   - In the Wilderness -> scan getLocalPlayers for real players (bots
 *     excluded), prefer skulled / lower-combat / near targets, approach and
 *     attack with getCombat().attack(target).
 *   - Kill confirmed (target dead/dying) -> "gg" once, keep hunting.
 *
 * Zero LLM. Tick-safe: every engine read guarded, local try/catch in update.
 *
 * ENGINE GAP (documented): personalities.js has no aggressive/brave/timid
 * traits (TRAITS is a fixed 15-item list). pkerWilling() checks for those
 * trait names anyway so they gate directly if ever added, and falls back to
 * a stable per-username hash (~5%) otherwise.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { hashSeed, agentRng, personalSpot } = require("../../lib/humanizer");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  eat,
  hpPercent,
  breadCount,
  BREAD_ID,
  COINS_ID,
} = require("../CitizenNeeds");

// --- tuning ------------------------------------------------------------------

// Minimum combat level to go PKing — citizens shouldn't feed.
const MIN_COMBAT_LEVEL = 40;
// 1 in 20 citizens has the temperament (~5%), stable per username.
const PKER_ONE_IN = 20;
// A PK trip lasts this long, randomized per session, then they leave.
const SESSION_MIN_MS = 5 * 60 * 1000;
const SESSION_MAX_MS = 15 * 60 * 1000;
// Below this HP: eat, and if still low, run for the edge.
const FLEE_HP = 35;
// Beyond this many tiles we approach first; inside it we attack directly.
const MAX_DIRECT_ATTACK_TILES = 10;
// Risk gate: citizens only risk what they're willing to lose.
const MAX_RISK_COINS = 20000;
const MAX_RISK_ITEMS = 10;
const MIN_FOOD = 3;
// Edgeville ditch anchor (from pvp-bot-hotspots.json "edge_ditch") — the
// wilderness-side hunting ground, low wild, real player traffic.
const HUNT_ANCHOR = { x: 3085, y: 3528, z: 0 };
// Just south of the ditch (Edgeville side): the flee destination.
const EDGE_TILE = { x: 3086, y: 3520, z: 0 };

const TAUNT_LINES = [
  "free loot delivery",
  "wrong ditch, mate",
  "should've stayed home",
  "this one's mine",
  "gl, you're gonna need it",
];
const GG_LINES = ["gg", "gf", "thanks for the loot", "better luck next time"];

function wildernessPlugin() {
  try {
    return require("../../areas/Wilderness.plugin.js");
  } catch {
    return null;
  }
}

/** True when the citizen has the temperament to PK. */
function pkerWilling(bot) {
  let personality = {};
  try {
    personality = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    return false;
  }
  const traits = new Set(personality?.traits ?? []);
  // If the trait system ever gains these, they gate directly.
  if (traits.has("aggressive") || traits.has("brave")) return true;
  if (traits.has("timid") || traits.has("cautious")) return false;
  const username = bot.getUsername?.() ?? "";
  if (!username) return false;
  return hashSeed(username) % PKER_ONE_IN === 0;
}

/** Real combat level, 1 when unreadable (safe fallback — never eligible). */
function combatLevelOf(player) {
  try {
    const lvl = player?.getSkillManager?.()?.getCombatLevel?.() | 0;
    return lvl > 0 ? lvl : 1;
  } catch {
    return 1;
  }
}

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function playerTile(p) {
  try {
    const loc = p?.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * The citizen's own wilderness depth. On the default (non-PvP-tagged) world
 * the plugin's attack range for self-vs-self is exactly the tile's wild
 * level (base 0), so >0 means "in levelled wilderness".
 */
function wildernessDepthOf(bot, Wild) {
  try {
    return Wild?.wildernessAttackRange?.(bot, bot) | 0;
  } catch {
    return 0;
  }
}

/** Real players only: no bots, no self, alive and registered. */
function isHuntablePlayer(bot, p) {
  try {
    if (!p || p === bot) return false;
    if (p?.isPlayer?.() !== true) return false;
    if (p?.isPlayerBot?.() === true) return false;
    if (p?.isDead?.() || p?.isDying?.()) return false;
    if (p?.isRegistered?.() === false) return false;
    return true;
  } catch {
    return false;
  }
}

function isSkulled(p) {
  try {
    return p?.isSkulled?.() === true;
  } catch {
    return false;
  }
}

/** Scan for real players the wilderness rules actually let us hit. */
function scanTargets(bot, Wild) {
  let players = [];
  try {
    players = bot.getLocalPlayers?.() ?? [];
  } catch {
    return [];
  }
  const bt = botTile(bot);
  const out = [];
  for (const p of players) {
    if (!isHuntablePlayer(bot, p)) continue;
    const pt = playerTile(p);
    if (bt && pt && pt.z !== bt.z) continue;
    try {
      if (Wild && !Wild.canAttackByWildernessLevel(bot, p)) continue;
    } catch {
      continue; // rule unreadable — skip, don't gamble
    }
    out.push(p);
  }
  return out;
}

/**
 * Pick a victim: skulled players first (they're carrying the risk), then
 * weaker players (safer kills), then the nearest. The wilderness level rule
 * already filtered the list — this is preference, not permission.
 */
function pickTarget(bot, targets) {
  const bt = botTile(bot);
  const myLevel = combatLevelOf(bot);
  let best = null;
  let bestScore = -Infinity;
  for (const p of targets) {
    let s = 0;
    if (isSkulled(p)) s += 40;
    const lvl = combatLevelOf(p);
    if (lvl < myLevel) s += Math.min(30, (myLevel - lvl) * 2);
    else if (lvl > myLevel) s -= (lvl - myLevel) * 3;
    const pt = playerTile(p);
    if (bt && pt) s -= chebyshev(bt.x, bt.y, pt.x, pt.y);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
}

/** True when carrying more than they're willing to lose on death. */
function carryingTooMuch(bot) {
  try {
    const inv = bot.getInventory?.();
    if (!inv) return false;
    const coins = inv.getAmount?.(COINS_ID) ?? 0;
    if (coins > MAX_RISK_COINS) return true;
    const items = inv.getItems?.() ?? [];
    let risk = 0;
    for (const item of items) {
      const id = item?.getId?.() ?? 0;
      if (id <= 0 || id === COINS_ID || id === BREAD_ID) continue;
      risk += 1;
      if (risk > MAX_RISK_ITEMS) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Real players nearby — chatter is for players, never the empty wild. */
function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayer?.() === true && p?.isPlayerBot?.() !== true) {
        out.push(p);
      }
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function personalityOf(bot) {
  try {
    return bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    return {};
  }
}

function sayTaunt(bot) {
  try {
    if (realPlayersNear(bot).length === 0) return;
    const line = voiceLine(voiceFor(personalityOf(bot)), { plain: TAUNT_LINES });
    if (line) sayPublic(bot, line);
  } catch {
    // Speech never breaks the hunt.
  }
}

function sayGg(bot) {
  try {
    if (realPlayersNear(bot).length === 0) return;
    const line = voiceLine(voiceFor(personalityOf(bot)), { plain: GG_LINES });
    if (line) sayPublic(bot, line);
  } catch {
    // Speech never breaks the hunt.
  }
}

function targetIdOf(p) {
  try {
    return p?.getUsername?.() ?? String(p?.getId?.() ?? "");
  } catch {
    return "";
  }
}

function tickPker(action, bot) {
  const Wild = wildernessPlugin();
  if (!Wild) return "failed";

  // Eligibility: temperament + combat stats. Checked every tick so a
  // citizen who stops qualifying mid-trip drops out.
  if (!pkerWilling(bot)) return "failed";
  if (combatLevelOf(bot) < MIN_COMBAT_LEVEL) return "failed";

  const username = bot.getUsername?.() ?? "unknown";
  const state = playerState(action, bot, () => {
    const rng = agentRng(`pker:${username}`);
    return {
      startedAt: Date.now(),
      sessionMs: SESSION_MIN_MS + rng() * (SESSION_MAX_MS - SESSION_MIN_MS),
      engagedId: null,
      fled: false,
    };
  });

  const now = Date.now();
  if (now - state.startedAt > state.sessionMs) {
    return "success"; // trip's over — leave the wild, re-decide
  }

  // Bring food or don't go: no supplies, no PK trip.
  if (breadCount(bot) < MIN_FOOD) return "success";
  // Won't risk the bank: bank first, PK later.
  if (carryingTooMuch(bot)) return "success";

  const depth = wildernessDepthOf(bot, Wild);
  if (state.fled && depth <= 0) return "success"; // made it out — re-decide

  // Survival: hurt -> eat, and if still low, run for the edge.
  if (hpPercent(bot) < FLEE_HP) {
    if (depth <= 0) return "success"; // hurt outside the wild — heal first
    try {
      eat(bot);
    } catch {
      // best effort
    }
    if (hpPercent(bot) < FLEE_HP) {
      state.fled = true;
      try {
        bot.getCombat?.()?.reset?.();
        requestMovement(bot, EDGE_TILE.x, EDGE_TILE.y, {
          reason: "citizen_pker_flee",
          basicPather: true,
          z: EDGE_TILE.z,
        });
      } catch {
        // movement failed — still fleeing conceptually
      }
      return "running";
    }
  }

  if (depth <= 0) {
    // Travel: walk to the ditch-side hunting ground. The brain's dispatch
    // crosses the ditch object automatically.
    const spot = personalSpot(username, HUNT_ANCHOR.x, HUNT_ANCHOR.y, 4, 10);
    try {
      requestMovement(bot, spot.x, spot.y, {
        reason: "citizen_pker_travel",
        basicPather: true,
        z: HUNT_ANCHOR.z,
      });
    } catch {
      return "success";
    }
    return "running";
  }

  // Already fighting someone: let it play out.
  let combatTarget = null;
  try {
    combatTarget = bot.getCombat?.()?.getTarget?.() ?? null;
  } catch {
    combatTarget = null;
  }
  if (combatTarget) {
    // Kill confirmed -> "gg" once, then keep hunting.
    if (
      state.engagedId &&
      targetIdOf(combatTarget) === state.engagedId &&
      (combatTarget?.isDead?.() || combatTarget?.isDying?.())
    ) {
      sayGg(bot);
      state.engagedId = null;
      try {
        bot.getCombat?.()?.reset?.();
      } catch {
        // non-fatal
      }
    } else {
      return "running";
    }
  }

  // Hunt: scan, pick, approach, attack.
  const targets = scanTargets(bot, Wild);
  if (targets.length === 0) {
    // Nobody here — drift around the anchor, don't stand like a pole.
    const spot = personalSpot(username, HUNT_ANCHOR.x, HUNT_ANCHOR.y, 4, 10);
    try {
      requestMovement(bot, spot.x, spot.y, {
        reason: "citizen_pker_patrol",
        basicPather: true,
        z: HUNT_ANCHOR.z,
      });
    } catch {
      // non-fatal
    }
    return "running";
  }

  const target = pickTarget(bot, targets);
  if (!target) return "running";

  const tt = playerTile(target);
  const bt = botTile(bot);
  if (bt && tt && chebyshev(bt.x, bt.y, tt.x, tt.y) > MAX_DIRECT_ATTACK_TILES) {
    try {
      requestMovement(bot, tt.x, tt.y, {
        reason: "citizen_pker_chase",
        basicPather: true,
        z: tt.z,
      });
    } catch {
      // approach failed — try again next tick
    }
    return "running";
  }

  // In range: taunt once per victim, then attack for real. The core skulls
  // us via CombatFactory.handleSkull — real consequences.
  const tid = targetIdOf(target);
  if (state.engagedId !== tid) {
    sayTaunt(bot);
    state.engagedId = tid;
  }
  try {
    bot.getCombat?.()?.attack?.(target);
  } catch {
    return "success";
  }
  return "running";
}

function createCitizenPkerAction(spec, world) {
  const action = {
    id: "citizenPker",

    update(ctx) {
      const bot = ctx?.player;
      if (!bot || bot?.isPlayerBot?.() !== true) return "failed";
      try {
        return tickPker(action, bot);
      } catch {
        return "success"; // a broken hunt re-decides, never stalls
      }
    },

    stop(ctx) {
      try {
        clearMovementRequest(ctx?.player);
      } catch {
        // non-fatal
      }
      try {
        ctx?.player?.getCombat?.()?.reset?.();
      } catch {
        // non-fatal
      }
    },

    // Test seams.
    _pkerWilling: pkerWilling,
    _combatLevelOf: combatLevelOf,
    _wildernessDepthOf: wildernessDepthOf,
    _scanTargets: scanTargets,
    _pickTarget: pickTarget,
    _carryingTooMuch: carryingTooMuch,
    _isHuntablePlayer: isHuntablePlayer,
  };

  return action;
}

module.exports = { createCitizenPkerAction };
