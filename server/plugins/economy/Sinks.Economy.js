"use strict";

/**
 * Sinks.Economy — item sinks, the demand engine for every crafter.
 *
 * Sink 1 (WIRED): Wilderness PvP death destruction. The existing
 * onPlayerDeathItemDrop hook fires once per item that would drop on death —
 * for players and wilderness PK bots alike. When the death happened in the
 * contested Wilderness and the killer is a player, each dropped item rolls
 * destruction scaled by value (constants SINK_TUNING): junk dies, treasure
 * survives for the killer. Destroyed items never hit the floor
 * (suppressDefaultDrop) and each destruction emits economy:item-sink, which
 * feeds the price service's scarcity pressure.
 *
 * Coins are never destroyed (money supply is separate — ECONOMY.md §4).
 * Items other plugins already claimed (event.handled / suppressDefaultDrop,
 * e.g. the looting bag) are left alone. Safe deaths (shouldDropItems false)
 * and items core wouldn't drop (dropEligible false) are skipped.
 *
 * Sinks 2–4 (gear wear/repair, war consumption, upkeep) are design-only —
 * see ECONOMY.md §3 and the SINKS names in constants.js.
 */

const { EVENTS, SINKS, COINS_ID, WILDERNESS_SURFACE, SINK_TUNING } = require("./constants");
const Prices = require("./Prices.Economy");

let pluginApi = null;

/** Lifetime stats for ::economy (in-memory; the ledger of record is the event stream). */
const stats = { destroyedStacks: 0, destroyedValue: 0, deathsTouched: 0 };
let lastDeath = { victim: null, at: 0 }; // the per-item hook fires once per item of a death

function usernameOf(mobile) {
  try {
    return mobile?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Contested-zone test, pure coordinates (no core TS import, no reach into
 * the Wilderness plugin — AGENTS.md). v1 approximation of the surface PK
 * region north of the ditch; see constants.js.
 */
function isContestedWilderness(location) {
  if (!location || typeof location.getX !== "function") return false;
  const x = location.getX();
  const y = location.getY();
  const z = location.getZ();
  return (
    z === WILDERNESS_SURFACE.z &&
    x >= WILDERNESS_SURFACE.x1 &&
    x <= WILDERNESS_SURFACE.x2 &&
    y >= WILDERNESS_SURFACE.y1 &&
    y <= WILDERNESS_SURFACE.y2
  );
}

/** Junk dies, treasure survives: destruction chance from the reference value. */
function destructionChance(referenceValue) {
  if (referenceValue < SINK_TUNING.lowValueCap) return SINK_TUNING.lowValueChance;
  if (referenceValue < SINK_TUNING.midValueCap) return SINK_TUNING.midValueChance;
  return 0;
}

function onDeathItemDrop(event) {
  if (!event || event.handled || event.suppressDefaultDrop) return;
  if (!event.shouldDropItems || !event.dropEligible) return;
  if (!isContestedWilderness(event.location)) return;
  // PvP only: NPC kills (revenants etc.) keep their normal death behavior.
  if (!event.killer || typeof event.killer.isPlayer !== "function" || !event.killer.isPlayer()) return;
  const item = event.item;
  if (!item || typeof item.getId !== "function") return;
  const itemId = item.getId();
  if (itemId === COINS_ID) return;

  const referenceValue = Prices.getBaseline(itemId);
  const chance = destructionChance(referenceValue);
  if (chance <= 0 || Math.random() >= chance) return;

  const amount = typeof item.getAmount === "function" ? item.getAmount() : 1;
  event.suppressDefaultDrop = true;
  stats.destroyedStacks += 1;
  stats.destroyedValue += referenceValue * amount;
  const victimName = usernameOf(event.player);
  const nowMs = Date.now();
  if (lastDeath.victim !== victimName || nowMs - lastDeath.at > 5000) {
    stats.deathsTouched += 1;
    lastDeath = { victim: victimName, at: nowMs };
  }

  pluginApi.emitCustomEvent(EVENTS.ITEM_SINK, {
    itemId,
    amount,
    sink: SINKS.WILDERNESS_PVP_DEATH,
    zone: "wilderness",
    victim: victimName,
    killer: usernameOf(event.killer),
    referenceValue,
  });
}

function getStats() {
  return { ...stats };
}

module.exports = function attachSinks(api) {
  pluginApi = api;
  api.onPlayerDeathItemDrop(onDeathItemDrop);
};

module.exports.isContestedWilderness = isContestedWilderness;
module.exports.destructionChance = destructionChance;
module.exports.getStats = getStats;
