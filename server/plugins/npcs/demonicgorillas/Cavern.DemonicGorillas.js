"use strict";

/**
 * The Crash Site Cavern as an Area (Wiki):
 * - its gorillas are aggressive until the player has completed Monkey Madness II;
 * - a gorilla in Melee that can't reach its target for a while changes style, so a safespot
 *   doesn't hold it (it is counted here, per tick, for the cavern's NPCs only).
 */
const { DEMONIC_IDS, TORTURED_IDS, UNREACHABLE_TICKS, MONKEY_MADNESS_II, CAVERN } = require("./Data.DemonicGorillas");
const State = require("./State.DemonicGorillas");

let api = null;

function isGorilla(npc) {
  const id = npc.getId();
  return DEMONIC_IDS.includes(id) || TORTURED_IDS.includes(id);
}

/** Asked once a tick per player: aggression asks for every gorilla in range. */
const questChecks = new WeakMap();

function completedQuest(player) {
  const cycle = api.core.World.getProcessCycle();
  const cached = questChecks.get(player);
  if (cached?.cycle === cycle) return cached.complete;
  const request = { player, key: MONKEY_MADNESS_II, complete: false };
  api.emitCustomEvent("quest:is-complete", request);
  questChecks.set(player, { cycle, complete: request.complete === true });
  return request.complete === true;
}

/** One more tick in Melee with a target it hasn't hit; too many and it changes style. */
function ageMelee(npc) {
  if (!isGorilla(npc) || npc.getHitpoints() <= 0) return;
  const state = State.stateOf(npc);
  if (state.style !== "melee" || !npc.getCombat().getTarget()) {
    state.unreachable = 0;
    return;
  }
  if (++state.unreachable >= UNREACHABLE_TICKS) State.changeStyle(npc, state);
}

function createCavern() {
  const { Area, Boundary } = api.core;
  class CrashSiteCavern extends Area {
    process(mobile) {
      if (mobile.isNpc()) ageMelee(mobile.getAsNpc());
    }

    npcAggression(player, npc) {
      if (!isGorilla(npc)) return null;
      return completedQuest(player) ? null : true;
    }
  }
  return new CrashSiteCavern([new Boundary(CAVERN.minX, CAVERN.maxX, CAVERN.minY, CAVERN.maxY, CAVERN.z)]);
}

module.exports = function attachCavern(pluginApi) {
  api = pluginApi;
  pluginApi.registerArea(createCavern());
};

Object.assign(module.exports, { ageMelee });
