"use strict";

/**
 * CitizenLightFire — burn logs for real Firemaking XP, the RuneScape way.
 *
 * Citizens accumulate logs (woodcutting, the routine's work legs, bought from
 * players). When the decision layer picks citizen_light_fire, the citizen
 * lights each burnable log via the real Firemaking plugin's bot entry point
 * (startBotInventoryFiremaking) — the same path upstream's LightFire.js uses.
 * Real Firemaking XP flows through SkillManager, so the level-up celebration
 * fires for citizens exactly as it does for players.
 *
 * Flow per tick:
 *   - Fire already burning (isFiremakingActive) -> "running", wait it out.
 *   - No burnable log in inventory -> "success" (done, brain re-decides).
 *   - Currently moving -> "running".
 *   - Try startBotInventoryFiremaking -> true means the attempt started,
 *     "running". False means the tile is blocked (or another guard tripped) ->
 *     step to a nearby personal spot and try again next tick.
 *   - Give up after GIVE_UP_MS so a bad spot never stalls the day.
 *
 * Non-repeat: burns what's there, then the brain re-decides (usually back to
 * the routine, or to the bank hinge if the pack filled with ashes... it won't,
 * fires don't drop items — the hinge stays for the woodcutting that feeds this).
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in the
 * brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

// If no fire lights in this long, the spot is cursed — move on with the day.
const GIVE_UP_MS = 5 * 60 * 1000;
// Don't hammer the same blocked tile every tick.
const RETRY_MOVE_MS = 4000;

function firemakingPlugin() {
  try {
    return require("../../../skills/Firemaking.plugin");
  } catch {
    return null;
  }
}

/** First inventory log the citizen can actually burn, or null. */
function findBurnableLog(Firemaking, player) {
  let items = [];
  try {
    items = player.getInventory?.()?.getItems?.() ?? [];
  } catch {
    return null;
  }
  for (const item of items) {
    let id = 0;
    try {
      id = item?.getId?.() ?? 0;
    } catch {
      continue;
    }
    if (id <= 0) continue;
    try {
      if (Firemaking.isWoodcuttingLog?.(id) && Firemaking.canPlayerBurnLog?.(player, id)) {
        return id;
      }
    } catch {
      // Next item — never break the scan on one bad entry.
    }
  }
  return null;
}

function createCitizenLightFireAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`lightfire:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        nextMoveAt: 0,
      };
    });
  }

  function stepAside(player) {
    const username = player.getUsername?.() ?? "unknown";
    let loc = null;
    try {
      loc = player.getLocation?.();
    } catch {
      return false;
    }
    if (!loc) return false;
    let x = 0;
    let y = 0;
    let z = 0;
    try {
      x = loc.getX();
      y = loc.getY();
      z = loc.getZ?.() ?? 0;
    } catch {
      return false;
    }
    // Personal clear spot nearby — citizens don't stack on one tile.
    const spot = personalSpot(username, x, y, 2, 6);
    try {
      requestMovement(player, spot.x, spot.y, {
        reason: "citizen_light_fire",
        basicPather: true,
        z,
      });
      return true;
    } catch {
      return false;
    }
  }

  const action = {
    id: "citizenLightFire",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Firemaking = firemakingPlugin();
      if (!Firemaking?.startBotInventoryFiremaking) {
        return "failed"; // Firemaking plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        return "success"; // bad spot day — move on, don't stall
      }

      // A fire is already burning — wait it out.
      let active = false;
      try {
        active = Firemaking.isFiremakingActive?.(player) === true;
      } catch {
        active = false;
      }
      if (active) return "running";

      // Out of logs — done, brain re-decides.
      const logId = findBurnableLog(Firemaking, player);
      if (logId == null) return "success";

      // Let in-flight movement finish first.
      try {
        if (player.getForceMovement?.() != null) return "running";
        if (player.getMovementQueue?.()?.size?.() > 0) return "running";
      } catch {
        // Fall through and try the light.
      }

      // Light it. False = tile blocked (or another guard) — step aside and
      // retry; throttled so we don't jitter every tick.
      let started = false;
      try {
        started = Firemaking.startBotInventoryFiremaking(player, logId) === true;
      } catch {
        started = false;
      }
      if (started) {
        try {
          world?.log?.("citizen_light_fire", {
            citizen: player.getUsername?.(),
            logId,
          });
        } catch {
          // Non-fatal.
        }
        return "running";
      }
      if (nowMs >= state.nextMoveAt) {
        state.nextMoveAt = nowMs + RETRY_MOVE_MS;
        if (stepAside(player)) return "running";
      }
      return "running";
    },
    stop(ctx) {
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  return action;
}

module.exports = {
  createCitizenLightFireAction,
  // exposed for tests
  _findBurnableLog: findBurnableLog,
};
