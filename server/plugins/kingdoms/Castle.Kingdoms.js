"use strict";

/**
 * Castle.Kingdoms — "Raise the Walls" (Phase 1 of player-kingdoms-design.md).
 *
 * A founded kingdom is a flag, a ledger, and a war chest. The castle makes
 * it PHYSICAL: a 40x40 walled bailey with tiered buildings the ruler builds
 * with Construction, paid from the war chest.
 *
 * FORTIFICATION TRACK (separate from buildings):
 *   tier 0: none (camp)
 *   tier 1: palisade (5M, +500 strength — the existing founding levy)
 *   tier 2: stone walls (15M, +1500 strength)
 *   tier 3: battlements (30M, +3000 strength)
 *
 * BUILDINGS (tier 1-3, Construction-gated):
 *   keep (mandatory first) → barracks, workshop, chapel, kitchen,
 *   granary, guardhouse, grove
 *
 * Costs come from the war chest. Every coin is itemized in the ledger.
 * Unpaid upkeep decays buildings (Phase 2 hook — data model ready).
 *
 * Design doc: files/player-kingdoms-design.md
 */

const Store = require("./KingdomStore");

// --- flag keys ---------------------------------------------------------------
const FLAG_FORT_TIER = "castle:fort-tier"; // 0-3
const FLAG_BUILDINGS = "castle:buildings"; // { id: { tier: 1-3 } }
const FLAG_BANNER = "castle:banner"; // { colors: [a,b], emblem: str }

// --- fortification -----------------------------------------------------------
const FORT_TIERS = [
  { tier: 0, name: "none", cost: 0, strength: 0 },
  { tier: 1, name: "palisade", cost: 5_000_000, strength: 500 },
  { tier: 2, name: "stone walls", cost: 15_000_000, strength: 1500 },
  { tier: 3, name: "battlements", cost: 30_000_000, strength: 3000 },
];

// --- buildings ---------------------------------------------------------------
const BUILDINGS = {
  keep: {
    name: "Keep",
    desc: "Throne room, bank chest, war room, rested XP",
    tierCosts: [10_000_000, 25_000_000, 50_000_000],
    requires: null, // mandatory first
    construction: [40, 60, 80],
  },
  barracks: {
    name: "Barracks",
    desc: "Combat training, sparring master",
    tierCosts: [5_000_000, 12_000_000, 25_000_000],
    requires: "keep",
    construction: [35, 55, 75],
  },
  workshop: {
    name: "Workshop",
    desc: "Sawmill, stonecutter, invention bench",
    tierCosts: [5_000_000, 12_000_000, 25_000_000],
    requires: "keep",
    construction: [35, 55, 75],
  },
  chapel: {
    name: "Chapel",
    desc: "Altar, Prayer buffs, blessings",
    tierCosts: [5_000_000, 12_000_000, 25_000_000],
    requires: "keep",
    construction: [35, 55, 75],
  },
  kitchen: {
    name: "Kitchen",
    desc: "Range, feast buffs, master chef",
    tierCosts: [5_000_000, 12_000_000, 25_000_000],
    requires: "keep",
    construction: [35, 55, 75],
  },
  granary: {
    name: "Granary",
    desc: "Food storage, crop tithe, trade depot",
    tierCosts: [5_000_000, 12_000_000, 25_000_000],
    requires: "keep",
    construction: [35, 55, 75],
  },
  guardhouse: {
    name: "Guardhouse",
    desc: "Citizen guards, patrol routes",
    tierCosts: [5_000_000, 12_000_000, 25_000_000],
    requires: "keep",
    construction: [35, 55, 75],
  },
  grove: {
    name: "Grove",
    desc: "Trees, herb patch, spirit tree",
    tierCosts: [5_000_000, 12_000_000, 25_000_000],
    requires: "keep",
    construction: [35, 55, 75],
  },
};

// --- read API ----------------------------------------------------------------

/** Fortification tier 0-3 for a kingdom. */
function fortTier(kingdomId) {
  const k = Store.getKingdom(kingdomId);
  return k?.flags?.[FLAG_FORT_TIER] ?? 0;
}

/** Strength bonus from fortifications (feeds war math). */
function fortStrength(kingdomId) {
  const tier = fortTier(kingdomId);
  return FORT_TIERS[tier]?.strength ?? 0;
}

/** Buildings map: { id: { tier } }. */
function buildings(kingdomId) {
  const k = Store.getKingdom(kingdomId);
  return k?.flags?.[FLAG_BUILDINGS] ?? {};
}

/** Banner: { colors, emblem } or null. */
function banner(kingdomId) {
  const k = Store.getKingdom(kingdomId);
  return k?.flags?.[FLAG_BANNER] ?? null;
}

// --- write API ---------------------------------------------------------------

/**
 * Upgrade fortification to the next tier. Deducts from war chest.
 * Returns { ok, tier, cost } or { ok: false, reason }.
 */
function upgradeFort(kingdomId) {
  const k = Store.getKingdom(kingdomId);
  if (!k) return { ok: false, reason: "no-kingdom" };
  const current = fortTier(kingdomId);
  if (current >= 3) return { ok: false, reason: "max-tier" };
  const next = FORT_TIERS[current + 1];
  const chest = k.flags?.["founding:war-chest"] ?? 0;
  if (chest < next.cost) {
    return { ok: false, reason: "insufficient-funds", need: next.cost, have: chest };
  }
  Store.setFlag(kingdomId, "founding:war-chest", chest - next.cost);
  Store.setFlag(kingdomId, FLAG_FORT_TIER, current + 1);
  ledger(kingdomId, "castle", `fortification: ${next.name}`, next.cost);
  return { ok: true, tier: current + 1, name: next.name, cost: next.cost };
}

/**
 * Construct or upgrade a building. Keep must be built first.
 * Returns { ok, building, tier, cost } or { ok: false, reason }.
 */
function buildBuilding(kingdomId, buildingId) {
  const def = BUILDINGS[buildingId];
  if (!def) return { ok: false, reason: "unknown-building" };
  const k = Store.getKingdom(kingdomId);
  if (!k) return { ok: false, reason: "no-kingdom" };

  const built = buildings(kingdomId);
  const currentTier = built[buildingId]?.tier ?? 0;

  // Keep first
  if (def.requires && !(built[def.requires]?.tier >= 1)) {
    return { ok: false, reason: "requires-keep" };
  }
  if (currentTier >= 3) return { ok: false, reason: "max-tier" };

  const cost = def.tierCosts[currentTier]; // tierCosts[0] = tier 1 cost
  const chest = k.flags?.["founding:war-chest"] ?? 0;
  if (chest < cost) {
    return { ok: false, reason: "insufficient-funds", need: cost, have: chest };
  }

  Store.setFlag(kingdomId, "founding:war-chest", chest - cost);
  const next = { ...built, [buildingId]: { tier: currentTier + 1 } };
  Store.setFlag(kingdomId, FLAG_BUILDINGS, next);
  ledger(
    kingdomId,
    "castle",
    `${def.name} tier ${currentTier + 1}`,
    cost
  );
  return { ok: true, building: buildingId, tier: currentTier + 1, cost };
}

/**
 * Set the kingdom banner. Purely cosmetic; free.
 */
function setBanner(kingdomId, colors, emblem) {
  const k = Store.getKingdom(kingdomId);
  if (!k) return { ok: false, reason: "no-kingdom" };
  if (!Array.isArray(colors) || colors.length !== 2) {
    return { ok: false, reason: "bad-colors" };
  }
  Store.setFlag(kingdomId, FLAG_BANNER, { colors, emblem: String(emblem ?? "").slice(0, 20) });
  return { ok: true };
}

// --- helpers -----------------------------------------------------------------

function ledger(kingdomId, kind, what, amount) {
  try {
    const k = Store.getKingdom(kingdomId);
    const entries = k?.flags?.["founding:ledger"] ?? [];
    entries.push({ t: Date.now(), kind, what, amount });
    Store.setFlag(kingdomId, "founding:ledger", entries);
  } catch {
    // best-effort
  }
}

/** Migrate the old boolean walls-paid flag to fort tier 1. */
function migrateWallsPaid(kingdomId) {
  const k = Store.getKingdom(kingdomId);
  if (!k) return false;
  if (k.flags?.["founding:walls-paid"] === true && fortTier(kingdomId) === 0) {
    Store.setFlag(kingdomId, FLAG_FORT_TIER, 1);
    return true;
  }
  return false;
}

module.exports = {
  FORT_TIERS,
  BUILDINGS,
  fortTier,
  fortStrength,
  buildings,
  banner,
  upgradeFort,
  buildBuilding,
  setBanner,
  migrateWallsPaid,
  FLAG_FORT_TIER,
  FLAG_BUILDINGS,
  FLAG_BANNER,
};
