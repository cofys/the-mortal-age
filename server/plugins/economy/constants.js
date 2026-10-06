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
  /** { itemId, respond(price|null) } — synchronous reference-price lookup (e.g. citizen merchant stalls). */
  PRICE_QUERY: "economy:price-query",
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
 * Flat rate, no value ceiling (Jon 2026-10-06): loss scales with what the
 * victim carried — a 50m kit hurts fifty times more than a 1m kit, and no
 * treasure is exempt. The furnace drains the flood at every tier, which is
 * what keeps crafter demand alive across the whole price curve.
 */
const SINK_TUNING = {
  /** Flat destruction chance per dropped item in contested Wilderness PvP deaths. Tune here. */
  destructionChance: 0.35,
};

/** Grand Exchange completion-fee tuning (ECONOMY.md §5). */
const FEE_TUNING = {
  /** Fraction of a completed SELL offer's coin output sunk as a market fee. Quiet gold drain. */
  geCompletionFee: 0.01,
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
  FEE_TUNING,
  PRICE_TUNING,
};
