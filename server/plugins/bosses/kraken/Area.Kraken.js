"use strict";

/**
 * Kraken Cove multicombat and task gate (see ../Kraken.plugin.js for behaviour and sources).
 *
 * The boss fights beside four tentacles and cave krakens swarm the lake, so the cove
 * is multicombat throughout its Slayer-area box (plugins/skills/data/slayer-areas.json:
 * Kraken Cove [[2240, 9984, 2300, 10048]]). Per-area opt-in, as AreaManager requires
 * outside the Wilderness.
 *
 * Wiki: every creature in the cove can only be killed on a Kraken or cave kraken task,
 * so attacks here are refused unless slayer:on-task covers the target.
 */

const Shared = require("./Shared.Kraken");

/** [minX, minY, maxX, maxY] from the cove's Slayer-area box. */
const COVE = [2240, 9984, 2300, 10048];

function areaClass() {
  const { Area, Boundary } = Shared.core();
  return class KrakenCoveArea extends Area {
    constructor() {
      super([new Boundary(COVE[0], COVE[2], COVE[1], COVE[3], 0)]);
    }

    getName() {
      return "Kraken Cove";
    }

    isMulti() {
      return true;
    }

    /** Only a player whose task covers the cove's monsters may attack them (Wiki). */
    canAttack(attacker, target) {
      if (!attacker?.isPlayer?.() || !target?.isNpc?.()) return null;
      return Shared.onTask(attacker.getAsPlayer(), target) ? null : false;
    }
  };
}

function attach(api) {
  api.registerArea(new (areaClass())());
}

module.exports = { attach, areaClass, COVE };
