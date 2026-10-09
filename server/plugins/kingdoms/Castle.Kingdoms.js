"use strict";

const Relations = require("./Relations.Kingdoms");
const Wars = require("./Wars.Kingdoms");

/**
 * Castle — the fortified heart of a kingdom.
 *
 * Phase 1: Data model — fortification tiers, 8 tiered buildings, banner
 * customization, war chest.
 * Phase 2: Citizen staffing + tithe economy — citizens staff buildings for
 * bonuses; kingdom citizens pay periodic tithes to the war chest; buildings
 * have upkeep; net income calculated.
 *
 * A castle belongs to a kingdom (kingdomId). The war chest is the castle's
 * treasury, separate from the kingdom treasury — it funds the garrison,
 * building upkeep, and siege defense.
 *
 * Storage: castle records live in KingdomStore state (data/saves/kingdoms.json)
 * under `castles: { [kingdomId]: castleRecord }`. Never touches players.
 *
 * RuneScape grounding: castles are the seat of power. Fortification tiers
 * gate what a kingdom can defend. Buildings provide concrete, visible
 * bonuses — not abstract numbers. Tithes are the medieval tax: citizens
 * pay, the castle spends on defense.
 */

// ---------------------------------------------------------------------------
// Fortification tiers
// ---------------------------------------------------------------------------

const FORT_TIERS = Object.freeze([
  { tier: 0, id: "camp", name: "War Camp", defense: 0, cost: 0, desc: "Tents and a palisade of sharpened stakes." },
  { tier: 1, id: "palisade", name: "Palisade", defense: 10, cost: 5000000, desc: "Wooden walls, ditch, and gatehouse." },
  { tier: 2, id: "stone", name: "Stone Walls", defense: 25, cost: 25000000, desc: "Curtain walls of dressed stone." },
  { tier: 3, id: "fortified", name: "Fortified Keep", defense: 50, cost: 100000000, desc: "Stone walls, towers, and a gatehouse with portcullis." },
  { tier: 4, id: "citadel", name: "Citadel", defense: 100, cost: 500000000, desc: "A fortress that dominates the skyline." },
]);

// ---------------------------------------------------------------------------
// Buildings (8 types, 3 tiers each)
// ---------------------------------------------------------------------------

/**
 * Building definitions. Each building:
 * - has 3 tiers (1-3), each with a build cost and upkeep
 * - has staff slots (citizens assigned to work there)
 * - provides a bonus scaled by tier and staffing
 *
 * Staff roles map to citizen roles:
 * - guards -> Barracks, Guardhouse
 * - workers -> Workshop, Granary, Stable
 * - clergy -> Chapel
 * - clerks -> Treasury, Library
 */
const BUILDINGS = Object.freeze({
  barracks: {
    id: "barracks",
    name: "Barracks",
    desc: "Houses the garrison. More guards, better defense.",
    staffRole: "guard",
    tiers: [
      { tier: 1, name: "Guard Barracks", cost: 1000000, upkeep: 5000, slots: 10, defense: 5 },
      { tier: 2, name: "Garrison Barracks", cost: 5000000, upkeep: 15000, slots: 25, defense: 15 },
      { tier: 3, name: "Fortress Barracks", cost: 20000000, upkeep: 40000, slots: 50, defense: 30 },
    ],
  },
  guardhouse: {
    id: "guardhouse",
    name: "Guardhouse",
    desc: "Watchtower and gate watch. Extends patrol range.",
    staffRole: "guard",
    tiers: [
      { tier: 1, name: "Watch Post", cost: 500000, upkeep: 3000, slots: 5, patrolRange: 10 },
      { tier: 2, name: "Guardhouse", cost: 2500000, upkeep: 8000, slots: 12, patrolRange: 25 },
      { tier: 3, name: "Watchtower", cost: 10000000, upkeep: 20000, slots: 25, patrolRange: 50 },
    ],
  },
  workshop: {
    id: "workshop",
    name: "Workshop",
    desc: "Smiths and artisans. Speeds crafting for the war effort.",
    staffRole: "worker",
    tiers: [
      { tier: 1, name: "Smithy", cost: 750000, upkeep: 4000, slots: 8, craftBonus: 0.10 },
      { tier: 2, name: "Workshop", cost: 4000000, upkeep: 12000, slots: 20, craftBonus: 0.25 },
      { tier: 3, name: "Grand Workshop", cost: 15000000, upkeep: 30000, slots: 40, craftBonus: 0.50 },
    ],
  },
  chapel: {
    id: "chapel",
    name: "Chapel",
    desc: "Place of worship. Raises citizen morale.",
    staffRole: "clergy",
    tiers: [
      { tier: 1, name: "Shrine", cost: 500000, upkeep: 2000, slots: 3, morale: 5 },
      { tier: 2, name: "Chapel", cost: 2500000, upkeep: 6000, slots: 8, morale: 12 },
      { tier: 3, name: "Cathedral", cost: 12000000, upkeep: 15000, slots: 15, morale: 25 },
    ],
  },
  granary: {
    id: "granary",
    name: "Granary",
    desc: "Food storage. Supports a larger population.",
    staffRole: "worker",
    tiers: [
      { tier: 1, name: "Storehouse", cost: 600000, upkeep: 3000, slots: 5, popCap: 50 },
      { tier: 2, name: "Granary", cost: 3000000, upkeep: 9000, slots: 12, popCap: 150 },
      { tier: 3, name: "Grand Granary", cost: 12000000, upkeep: 22000, slots: 25, popCap: 400 },
    ],
  },
  treasury: {
    id: "treasury",
    name: "Treasury",
    desc: "Counts the coins. Improves tithe collection efficiency.",
    staffRole: "clerk",
    tiers: [
      { tier: 1, name: "Counting House", cost: 800000, upkeep: 4000, slots: 5, titheEff: 0.05 },
      { tier: 2, name: "Treasury", cost: 4000000, upkeep: 12000, slots: 12, titheEff: 0.12 },
      { tier: 3, name: "Royal Treasury", cost: 16000000, upkeep: 30000, slots: 25, titheEff: 0.25 },
    ],
  },
  stable: {
    id: "stable",
    name: "Stable",
    desc: "Houses mounts. Speeds patrols and messengers.",
    staffRole: "worker",
    tiers: [
      { tier: 1, name: "Stable", cost: 700000, upkeep: 3500, slots: 6, moveBonus: 0.10 },
      { tier: 2, name: "Grand Stable", cost: 3500000, upkeep: 10000, slots: 15, moveBonus: 0.20 },
      { tier: 3, name: "Royal Stables", cost: 14000000, upkeep: 25000, slots: 30, moveBonus: 0.35 },
    ],
  },
  library: {
    id: "library",
    name: "Library",
    desc: "Hall of records. Citizens learn faster.",
    staffRole: "clerk",
    tiers: [
      { tier: 1, name: "Archive", cost: 600000, upkeep: 3000, slots: 4, xpBonus: 0.05 },
      { tier: 2, name: "Library", cost: 3000000, upkeep: 9000, slots: 10, xpBonus: 0.12 },
      { tier: 3, name: "Grand Library", cost: 12000000, upkeep: 22000, slots: 20, xpBonus: 0.25 },
    ],
  },
});

// ---------------------------------------------------------------------------
// Banner customization
// ---------------------------------------------------------------------------

const BANNER_COLORS = Object.freeze([
  "crimson", "azure", "emerald", "gold", "silver", "sable", "purpure", "vert",
]);

const BANNER_SYMBOLS = Object.freeze([
  "lion", "eagle", "dragon", "tower", "sword", "crown", "oak", "wave",
]);

// ---------------------------------------------------------------------------
// Tithe economy tuning
// ---------------------------------------------------------------------------

/** Base tithe per citizen per tithe cycle (coins). Scales with treasury tier. */
const TITHE_BASE = 100;
/** Tithe cycle: how often tithes are collected (ms). */
const TITHE_CYCLE_MS = 24 * 60 * 60 * 1000; // daily

// ---------------------------------------------------------------------------
// Castle record
// ---------------------------------------------------------------------------

function emptyCastle(kingdomId) {
  return {
    kingdomId,
    fortTier: 0,
    buildings: {}, // buildingId -> { tier, staff: [usernames] }
    banner: { color: "crimson", symbol: "tower" },
    warChest: 0,
    lastTitheAt: 0,
    foundedAt: Date.now(),
  };
}

function getCastle(kingdomId, store) {
  const castles = store.load().castles ?? {};
  return castles[kingdomId] ?? null;
}

function ensureCastle(kingdomId, store) {
  const state = store.load();
  if (!state.castles) state.castles = {};
  if (!state.castles[kingdomId]) {
    state.castles[kingdomId] = emptyCastle(kingdomId);
    store.save();
  }
  return state.castles[kingdomId];
}

// ---------------------------------------------------------------------------
// Fortification
// ---------------------------------------------------------------------------

function fortTierDef(tier) {
  return FORT_TIERS.find((t) => t.tier === tier) ?? FORT_TIERS[0];
}

/**
 * Upgrade fortification. Deducts cost from war chest.
 * @returns {{ok, reason?}}
 */
function upgradeFortification(kingdomId, store) {
  const castle = ensureCastle(kingdomId, store);
  const next = fortTierDef(castle.fortTier + 1);
  if (castle.fortTier >= 4) return { ok: false, reason: "already-max" };
  if (castle.warChest < next.cost) return { ok: false, reason: "insufficient-funds" };
  castle.warChest -= next.cost;
  castle.fortTier += 1;
  store.save();
  return { ok: true, tier: castle.fortTier, name: next.name };
}

function fortDefense(castle) {
  let defense = fortTierDef(castle.fortTier).defense;
  // Barracks adds defense
  const barracks = castle.buildings.barracks;
  if (barracks) {
    const def = BUILDINGS.barracks.tiers[barracks.tier - 1];
    const staffed = barracks.staff?.length ?? 0;
    const staffingRatio = def.slots > 0 ? Math.min(1, staffed / def.slots) : 0;
    defense += Math.round(def.defense * staffingRatio);
  }
  return defense;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

function buildingDef(id) {
  return BUILDINGS[id] ?? null;
}

/**
 * Construct or upgrade a building. Deducts cost from war chest.
 * @returns {{ok, reason?}}
 */
function buildBuilding(kingdomId, buildingId, store) {
  const def = buildingDef(buildingId);
  if (!def) return { ok: false, reason: "unknown-building" };
  const castle = ensureCastle(kingdomId, store);
  const existing = castle.buildings[buildingId];
  const nextTier = existing ? existing.tier + 1 : 1;
  if (nextTier > 3) return { ok: false, reason: "already-max" };
  const tierDef = def.tiers[nextTier - 1];
  if (castle.warChest < tierDef.cost) return { ok: false, reason: "insufficient-funds" };
  castle.warChest -= tierDef.cost;
  castle.buildings[buildingId] = { tier: nextTier, staff: existing?.staff ?? [] };
  store.save();
  return { ok: true, tier: nextTier, name: tierDef.name };
}

// ---------------------------------------------------------------------------
// Citizen staffing (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Assign a citizen to a building's staff.
 * The citizen's role must match the building's staffRole.
 * @param {string} kingdomId
 * @param {string} buildingId
 * @param {string} username - citizen's username
 * @param {string} citizenRole - citizen's role (guard, worker, clergy, clerk)
 * @returns {{ok, reason?}}
 */
function staffBuilding(kingdomId, buildingId, username, citizenRole, store) {
  const def = buildingDef(buildingId);
  if (!def) return { ok: false, reason: "unknown-building" };
  const castle = ensureCastle(kingdomId, store);
  const building = castle.buildings[buildingId];
  if (!building) return { ok: false, reason: "not-built" };
  if (citizenRole !== def.staffRole) return { ok: false, reason: "wrong-role" };
  const tierDef = def.tiers[building.tier - 1];
  if ((building.staff?.length ?? 0) >= tierDef.slots) return { ok: false, reason: "full" };
  if (building.staff.includes(username)) return { ok: false, reason: "already-staffed" };
  // Remove from any other building first (one job per citizen)
  for (const b of Object.values(castle.buildings)) {
    const idx = b.staff?.indexOf(username) ?? -1;
    if (idx >= 0) b.staff.splice(idx, 1);
  }
  building.staff.push(username);
  store.save();
  return { ok: true };
}

/**
 * Remove a citizen from building staff.
 */
function unstaffBuilding(kingdomId, username, store) {
  const castle = getCastle(kingdomId, store);
  if (!castle) return { ok: false, reason: "no-castle" };
  for (const building of Object.values(castle.buildings)) {
    const idx = building.staff?.indexOf(username) ?? -1;
    if (idx >= 0) {
      building.staff.splice(idx, 1);
      store.save();
      return { ok: true };
    }
  }
  return { ok: false, reason: "not-staffed" };
}

/**
 * Get staffing info for a building.
 * @returns {{staffed, slots, ratio}}
 */
function staffingInfo(castle, buildingId) {
  const building = castle.buildings[buildingId];
  if (!building) return { staffed: 0, slots: 0, ratio: 0 };
  const def = buildingDef(buildingId);
  const tierDef = def.tiers[building.tier - 1];
  const staffed = building.staff?.length ?? 0;
  return {
    staffed,
    slots: tierDef.slots,
    ratio: tierDef.slots > 0 ? staffed / tierDef.slots : 0,
  };
}

// ---------------------------------------------------------------------------
// Building effects (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Calculate the effective bonus for a building, scaled by staffing.
 * Unstaffed buildings provide 25% of their bonus (the building exists,
 * but no one works there).
 */
function buildingBonus(castle, buildingId, bonusKey) {
  const building = castle.buildings[buildingId];
  if (!building) return 0;
  const def = buildingDef(buildingId);
  const tierDef = def.tiers[building.tier - 1];
  const base = tierDef[bonusKey] ?? 0;
  const { ratio } = staffingInfo(castle, buildingId);
  // 25% base + 75% scaled by staffing
  return base * (0.25 + 0.75 * Math.min(1, ratio));
}

/** Aggregate all castle bonuses. */
function castleBonuses(castle) {
  return {
    defense: fortDefense(castle),
    patrolRange: Math.round(buildingBonus(castle, "guardhouse", "patrolRange")),
    craftBonus: buildingBonus(castle, "workshop", "craftBonus"),
    morale: Math.round(buildingBonus(castle, "chapel", "morale")),
    popCap: Math.round(buildingBonus(castle, "granary", "popCap")),
    titheEff: buildingBonus(castle, "treasury", "titheEff"),
    moveBonus: buildingBonus(castle, "stable", "moveBonus"),
    xpBonus: buildingBonus(castle, "library", "xpBonus"),
  };
}

// ---------------------------------------------------------------------------
// Tithe economy (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Calculate total upkeep per tithe cycle for all buildings.
 */
function totalUpkeep(castle) {
  let upkeep = 0;
  for (const [id, building] of Object.entries(castle.buildings)) {
    const def = buildingDef(id);
    if (!def) continue;
    const tierDef = def.tiers[building.tier - 1];
    upkeep += tierDef.upkeep;
  }
  return upkeep;
}

/**
 * Collect tithes from kingdom citizens.
 * @param {string} kingdomId
 * @param {Array<string>} citizenUsernames - citizens in the kingdom
 * @param {object} store - KingdomStore
 * @returns {{collected, upkeep, net, citizenCount}}
 */
function collectTithes(kingdomId, citizenUsernames, store) {
  const castle = ensureCastle(kingdomId, store);
  const nowMs = Date.now();
  // Throttle: only collect once per cycle
  if (nowMs - castle.lastTitheAt < TITHE_CYCLE_MS) {
    return { ok: false, reason: "too-soon" };
  }
  const bonuses = castleBonuses(castle);
  // Phase 4: pact roads carry goods — allied kingdoms boost tithe efficiency.
  const tradeBonus = Relations.alliedTradeBonus(kingdomId, store);
  const tithePerCitizen = Math.round(TITHE_BASE * (1 + bonuses.titheEff + tradeBonus));
  const collected = tithePerCitizen * citizenUsernames.length;
  const upkeep = totalUpkeep(castle);
  const net = collected - upkeep;
  castle.warChest = Math.max(0, castle.warChest + net);
  castle.lastTitheAt = nowMs;

  // Phase 5: vassals pay 10% of net tithe income to their overlord.
  let vassalTribute = 0;
  let vassalOverlord = null;
  const tributeDue = Wars.vassalTributeOf(kingdomId, net, store.load());
  if (tributeDue.tribute > 0) {
    vassalTribute = tributeDue.tribute;
    vassalOverlord = tributeDue.overlordId;
    castle.warChest = Math.max(0, castle.warChest - vassalTribute);
    const overlordCastle = ensureCastle(vassalOverlord, store);
    overlordCastle.warChest += vassalTribute;
  }

  store.save();
  return {
    ok: true,
    collected,
    upkeep,
    net,
    citizenCount: citizenUsernames.length,
    tithePerCitizen,
    tradeBonus,
    vassalTribute,
    vassalOverlord,
    warChest: castle.warChest,
  };
}

/**
 * Force a tithe collection (for testing, bypasses the cycle throttle).
 */
function collectTithesForce(kingdomId, citizenUsernames, store) {
  const castle = ensureCastle(kingdomId, store);
  castle.lastTitheAt = 0;
  return collectTithes(kingdomId, citizenUsernames, store);
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function setBanner(kingdomId, color, symbol, store) {
  if (!BANNER_COLORS.includes(color)) return { ok: false, reason: "bad-color" };
  if (!BANNER_SYMBOLS.includes(symbol)) return { ok: false, reason: "bad-symbol" };
  const castle = ensureCastle(kingdomId, store);
  castle.banner = { color, symbol };
  store.save();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// War chest
// ---------------------------------------------------------------------------

function depositWarChest(kingdomId, amount, store) {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "bad-amount" };
  const castle = ensureCastle(kingdomId, store);
  castle.warChest += Math.floor(amount);
  store.save();
  return { ok: true, warChest: castle.warChest };
}

function withdrawWarChest(kingdomId, amount, store) {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "bad-amount" };
  const castle = ensureCastle(kingdomId, store);
  const amt = Math.floor(amount);
  if (castle.warChest < amt) return { ok: false, reason: "insufficient-funds" };
  castle.warChest -= amt;
  store.save();
  return { ok: true, warChest: castle.warChest };
}

module.exports = {
  // Data
  FORT_TIERS,
  BUILDINGS,
  BANNER_COLORS,
  BANNER_SYMBOLS,
  TITHE_BASE,
  TITHE_CYCLE_MS,
  // Castle CRUD
  emptyCastle,
  getCastle,
  ensureCastle,
  // Fortification
  fortTierDef,
  upgradeFortification,
  fortDefense,
  // Buildings
  buildingDef,
  buildBuilding,
  // Staffing
  staffBuilding,
  unstaffBuilding,
  staffingInfo,
  // Effects
  buildingBonus,
  castleBonuses,
  // Economy
  totalUpkeep,
  collectTithes,
  collectTithesForce,
  // Banner
  setBanner,
  // War chest
  depositWarChest,
  withdrawWarChest,
};
