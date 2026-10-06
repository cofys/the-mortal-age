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
 * Destruction is a FLAT rate (SINK_TUNING.destructionChance), no value
 * ceiling: every dropped item rolls the same chance whether it's arrows or
 * a twisted bow. Loss scales with what the victim carried.
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

// Throttled sink logging: wilderness PK deaths are frequent, so we log at
// most one summary line per minute (and only when something was destroyed).
let lastSinkLogAt = 0;
const SINK_LOG_INTERVAL_MS = 60000;
const sinceLog = { destroyedStacks: 0, destroyedValue: 0, deathsTouched: 0 };

function maybeLogSink() {
  const nowMs = Date.now();
  if (sinceLog.destroyedStacks === 0) return;
  if (nowMs - lastSinkLogAt < SINK_LOG_INTERVAL_MS) return;
  lastSinkLogAt = nowMs;
  pluginApi?.log?.("[economy] wilderness-pvp sink", {
    destroyedStacks: sinceLog.destroyedStacks,
    destroyedValue: sinceLog.destroyedValue,
    deathsTouched: sinceLog.deathsTouched,
    lifetimeDestroyedValue: stats.destroyedValue,
  });
  sinceLog.destroyedStacks = 0;
  sinceLog.destroyedValue = 0;
  sinceLog.deathsTouched = 0;
}

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

/** Flat rate: every dropped item rolls the same chance, whatever it's worth. */
function destructionChance(/* referenceValue — kept for the test seam; value no longer matters */) {
  return SINK_TUNING.destructionChance;
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
  sinceLog.destroyedStacks += 1;
  sinceLog.destroyedValue += referenceValue * amount;
  const victimName = usernameOf(event.player);
  const nowMs = Date.now();
  if (lastDeath.victim !== victimName || nowMs - lastDeath.at > 5000) {
    stats.deathsTouched += 1;
    sinceLog.deathsTouched += 1;
    lastDeath = { victim: victimName, at: nowMs };
  }
  maybeLogSink();

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
