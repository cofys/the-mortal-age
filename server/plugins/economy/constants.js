"use strict";

/**
 * constants — shared names and tuning for the ECONOMY plugin.
 *
 * Event names, attribute keys, zone geometry, and sink tuning live here so
 * the design doc (ECONOMY.md), the sink mechanics, and the price service all
 * read the same numbers. Tune the furnace here.
 */

const EVENTS = {
  /** { itemId, amount, sink, zone?, victim?, killer?, reason? } — items left the world for good. */
  ITEM_SINK: "economy:item-sink",
  /** { source, sourceKind?, items: [{ itemId, amount, priceEach? }], reason?, expiresAt? } — a buyer needs supplies. */
  DEMAND: "economy:demand",
  /** { itemId, price, previous, reason? } — reference price moved; merchants reprice. */
  PRICE: "economy:price",
};

const SINKS = {
  WILDERNESS_PVP_DEATH: "wilderness-pvp-death",
  GEAR_WEAR: "gear-wear", // design only (ECONOMY.md §3) — no emitter yet
  WAR_CONSUMPTION: "war-consumption", // design only — waits on the kingdoms war sim
  UPKEEP: "upkeep", // design only
};

/** Coins are money, not goods: never destroyed by item sinks. */
const COINS_ID = 995;

/**
 * The contested Wilderness, surface level. Pure coordinates — no core TS
 * import, no reach into the Wilderness plugin (AGENTS.md rule 2). v1
 * approximation of the PK region north of the ditch (y 3519): generous on
 * purpose. If the Areas ever emit an `area:contested` authority, replace
 * isContestedWilderness's body with that query — the sink logic stays.
 */
const WILDERNESS_SURFACE = { x1: 2930, x2: 3430, y1: 3520, y2: 4000, z: 0 };

/**
 * Wilderness PvP death-destruction tuning (ECONOMY.md §3, sink 1).
 * Junk dies, treasure survives: the furnace drains the flood (arrows, food,
 * cheap gear) while the jackpot loot that makes the Wilderness worth
 * entering still drops for the killer.
 */
const SINK_TUNING = {
  /** Items under this reference value: destruction chance per dropped item. */
  lowValueCap: 100000,
  lowValueChance: 0.35,
  /** Items under this reference value (and over the low cap). */
  midValueCap: 5000000,
  midValueChance: 0.1,
  /** Above midValueCap: never destroyed (stakes preserved). */
};

/** Reference-price feed tuning (ECONOMY.md §6). */
const PRICE_TUNING = {
  /** Broadcast economy:price when the reference moves more than this fraction. */
  broadcastThreshold: 0.1,
  /** Demand pressure decays back to baseline with this half-life. */
  pressureHalfLifeMs: 60 * 60 * 1000,
  /** Hard cap on the demand multiplier (2x baseline, never more). */
  maxMultiplier: 2.0,
  /** One demand broadcast adds this much pressure per item. */
  demandPressureStep: 0.02,
  /** One sunk item-stack adds this much pressure (scarcity signal). */
  sinkPressureStep: 0.005,
};

module.exports = {
  EVENTS,
  SINKS,
  COINS_ID,
  WILDERNESS_SURFACE,
  SINK_TUNING,
  PRICE_TUNING,
};
