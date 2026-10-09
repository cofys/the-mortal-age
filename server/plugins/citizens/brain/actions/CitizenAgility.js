"use strict";

/**
 * CitizenAgility — run real agility courses for real Agility XP, the RuneScape way.
 *
 * Citizens train on the best course their Agility level allows (Gnome
 * Stronghold at 1, Draynor rooftop at 10, ... Ardougne rooftop at 90) by
 * clicking the real obstacle objects — the same path a player click takes:
 * operateObstacle -> attemptObstacle -> ObstacleRunner -> finishObstacle.
 * Real XP flows through SkillManager, lap bonuses and marks of grace land
 * exactly as they do for players, and level-up celebrations fire.
 *
 * Flow per tick:
 *   - Mid-obstacle (ObstacleRunner busy) -> "running" (wait it out).
 *   - Next obstacle read from the plugin's lap progress attribute: obstacle 1
 *     always starts a lap, each following obstacle continues it. When the
 *     final obstacle is done the plugin completes the lap (lap bonus XP) and
 *     the action returns "success" — one lap per brain decision, then the
 *     brain re-decides (usually another lap).
 *   - The obstacle's world object is found via objectSearch (alternates
 *     sharing an index, e.g. the two Gnome pipes, resolve to the nearest).
 *   - Far away -> walk toward it ("running"); close -> walkToObject with an
 *     execute that fires the real object interaction (clickType 1).
 *   - No course obstacle in the area -> "success" (re-decide — the citizen
 *     looked around, no course here, and moved on).
 *   - Give up after GIVE_UP_MS so a broken course never stalls the day.
 *
 * The Wilderness course is excluded from bot selection (lawless zone, per
 * the PvP design — citizens don't train where they'd get PKed).
 *
 * Non-repeat: one lap, then re-decide.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  clearMovementRequest,
  approachObject,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const { agentRng, humanizerProfile } = require("../../lib/humanizer");

// If a lap takes this long, the course is cursed — move on.
const GIVE_UP_MS = 6 * 60 * 1000;
// Beyond this many tiles we approach first; inside it we click directly.
const MAX_DIRECT_ROUTE_TILES = 20;
// Don't spam object clicks faster than the engine can route them.
const INTERACT_COOLDOWN_MS = 1500;
// How far (regions) to look for the next obstacle's world object.
const OBSTACLE_SEARCH_RADIUS = 2;

function agilityPlugin() {
  try {
    return require("../../../skills/Agility.plugin");
  } catch {
    return null;
  }
}

/** Agility level, 1 when unreadable (Gnome Stronghold only — safe fallback). */
function agilityLevel(player) {
  try {
    const Skill = require("../../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.AGILITY);
    return Number.isInteger(lvl) && lvl > 0 ? lvl : 1;
  } catch {
    return 1;
  }
}

/**
 * The next obstacle index for this player on this course, read from the
 * plugin's lap progress. Obstacle 1 starts a lap; anything else continues
 * it. Returns 1 when there's no progress (or progress is on another course).
 */
function nextObstacleIndex(Agility, player, course) {
  try {
    const progress = Agility.getLapProgress?.(player);
    if (
      progress &&
      progress.course === course.key &&
      Number.isInteger(progress.index)
    ) {
      return progress.index + 1;
    }
  } catch {
    // fall through to 1
  }
  return 1;
}

/** Final obstacle index of a course (set by the plugin's buildIndex). */
function finalIndex(course) {
  try {
    if (Number.isInteger(course.finalIndex)) return course.finalIndex;
    const indexes = (course.obstacles ?? [])
      .map((o) => o?.index)
      .filter((i) => Number.isInteger(i));
    return indexes.length ? Math.max(...indexes) : 0;
  } catch {
    return 0;
  }
}

/** Obstacles at an index (alternates share one, e.g. the two Gnome pipes). */
function obstaclesAt(course, index) {
  try {
    return (course.obstacles ?? []).filter(
      (o) => o && o.index === index && typeof o.object === "number"
    );
  } catch {
    return [];
  }
}

/** Nearest world object for the next obstacle, same height level. */
function findObstacleObject(world, player, candidates) {
  try {
    const loc = player.getLocation?.();
    if (!loc || !candidates.length) return null;
    const ids = [...new Set(candidates.map((o) => o.object))];
    const found =
      world?.objectSearch?.findCandidatesByIds?.(player, ids, {
        regionRadius: OBSTACLE_SEARCH_RADIUS,
        z: loc.getZ?.(),
        privateArea: player.getPrivateArea?.() ?? null,
      }) ?? [];
    let best = null;
    let bestDistSq = Number.MAX_SAFE_INTEGER;
    for (const object of found) {
      const objectLoc = object?.getLocation?.();
      if (!objectLoc || objectLoc.getZ?.() !== loc.getZ?.()) continue;
      const dx = objectLoc.getX() - loc.getX();
      const dy = objectLoc.getY() - loc.getY();
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = object;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function createCitizenAgilityAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`agility:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        lastClickAt: 0,
        courseKey: null,
      };
    });
  }

  function emitObstacleClick(ctx, object) {
    const { player } = ctx;
    try {
      const objectLoc = object.getLocation();
      const playerLoc = player.getLocation();
      const queue = player.getMovementQueue?.();
      if (!queue) return "running";
      queue.walkToObject(object, {
        execute: () => {
          try {
            world.emitObjectInteraction?.({
              player,
              object,
              objectId: object.getId(),
              clickType: 1,
              location: {
                x: objectLoc.getX(),
                y: objectLoc.getY(),
                z: objectLoc.getZ(),
              },
              sourceLocation: {
                x: playerLoc.getX(),
                y: playerLoc.getY(),
                z: playerLoc.getZ(),
              },
              handled: false,
            });
          } catch {
            // interaction is best-effort; the runner is the real work
          }
        },
      });
    } catch {
      // routing failed; next tick retries
    }
    return "running";
  }

  const action = {
    id: "citizenAgility",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Agility = agilityPlugin();
      if (!Agility?.findBestCourseForLevel) {
        return "failed"; // Agility plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        return "success"; // bad course day — move on, don't stall
      }

      // Mid-obstacle: the runner owns the player until the steps finish.
      try {
        if (Agility.isObstacleRunning?.(player)) return "running";
      } catch {
        // treat as not running
      }

      const level = agilityLevel(player);
      const course = Agility.findBestCourseForLevel(level);
      if (!course) {
        return "success"; // nothing to train on — re-decide
      }
      state.courseKey = course.key;

      const next = nextObstacleIndex(Agility, player, course);
      if (next > finalIndex(course)) {
        // Lap complete (the plugin already paid the lap bonus) — one lap
        // per brain decision, then re-decide.
        return "success";
      }

      const candidates = obstaclesAt(course, next);
      if (!candidates.length) {
        return "success"; // course data has no such obstacle — re-decide
      }

      const object = findObstacleObject(world, player, candidates);
      if (!object) {
        return "success"; // no course obstacle nearby — re-decide
      }

      let objectLoc = null;
      let playerLoc = null;
      try {
        objectLoc = object.getLocation();
        playerLoc = player.getLocation();
      } catch {
        return "running";
      }
      if (!objectLoc || !playerLoc) return "running";

      const distance = Math.max(
        Math.abs(playerLoc.getX() - objectLoc.getX()),
        Math.abs(playerLoc.getY() - objectLoc.getY())
      );
      if (distance > MAX_DIRECT_ROUTE_TILES) {
        try {
          approachObject(player, object, {
            nowMs,
            reason: "citizen_agility_approach",
          });
        } catch {
          // fall through; next tick retries
        }
        return "running";
      }

      // Let in-flight movement finish first.
      try {
        if (player.getForceMovement?.() != null) return "running";
        if (player.getMovementQueue?.()?.size?.() > 0) return "running";
      } catch {
        // fall through and try the click
      }
      if (nowMs - state.lastClickAt < INTERACT_COOLDOWN_MS) {
        return "running";
      }
      state.lastClickAt = nowMs;
      return emitObstacleClick(ctx, object);
    },
    stop(ctx) {
      try {
        clearMovementRequest(ctx?.player);
      } catch {
        // best effort
      }
    },
  };

  return action;
}

module.exports = {
  createCitizenAgilityAction,
  _agilityLevel: agilityLevel,
  _nextObstacleIndex: nextObstacleIndex,
  _finalIndex: finalIndex,
  _obstaclesAt: obstaclesAt,
};
