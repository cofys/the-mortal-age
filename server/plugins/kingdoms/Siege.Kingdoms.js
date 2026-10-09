"use strict";

/**
 * Siege — castle siege warfare (Phase 3).
 *
 * A kingdom can declare siege on another kingdom's castle. Sieges resolve
 * over multiple ticks (1 hour each), with attacker progress driven by the
 * power ratio between attacker investment and defender fortifications.
 *
 * Data model:
 * - Siege declaration costs war chest funds (attacker) and has a cooldown
 *   per defender (7 days).
 * - Attacker power = f(investment, attacker fort tier). More coins committed
 *   = stronger siege. Fort tier represents military infrastructure.
 * - Defender power = fortDefense(defenderCastle) — fort tier + staffed
 *   barracks defense. The real defensive value from Phase 1+2.
 * - Each tick: power ratio determines progress gain/loss.
 * - Victory at 100 progress: loot 25% of defender war chest, damage buildings,
 *   reduce fort tier.
 * - Defeat if progress hits 0 after minimum ticks: attacker loses investment.
 * - Stalemate at max ticks: both exhausted.
 *
 * Defense actions (defender):
 * - Sally forth: spend war chest to reduce siege progress (counterattack).
 * - Repair walls: spend war chest to reduce progress (emergency repairs).
 *
 * Storage: siege records live in KingdomStore state under
 * `sieges: { [defenderKingdomId]: siegeRecord }`. Resolved sieges are kept
 * for cooldown checks and history.
 *
 * RuneScape grounding: sieges are the ultimate kingdom conflict — expensive,
 * slow, and decisive. The defender's fortifications matter. The attacker's
 * deep pockets matter. No instant gratification.
 */

const Castle = require("./Castle.Kingdoms");

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Flat cost to declare a siege (from attacker's war chest). */
const SIEGE_DECLARE_COST = 1_000_000;
/** Cooldown before the same attacker can siege the same defender again. */
const SIEGE_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
/** Milliseconds between siege ticks. */
const SIEGE_TICK_MS = 3600 * 1000;
/** Maximum ticks before stalemate (72 hours = 3 days). */
const SIEGE_MAX_TICKS = 72;
/** Minimum ticks before defeat can trigger (prevents instant failure). */
const SIEGE_MIN_TICKS_BEFORE_DEFEAT = 12;
/** Cost for defender to sally forth (war chest). */
const SALLY_COST = 500_000;
/** Cooldown between sally attempts. */
const SALLY_COOLDOWN_MS = 6 * 3600 * 1000;
/** Progress reduction from a successful sally. */
const SALLY_PROGRESS_HIT = 15;
/** Cost for defender to repair walls (war chest). */
const REPAIR_COST = 250_000;
/** Progress reduction from repairs. */
const REPAIR_PROGRESS_HIT = 10;
/** Percentage of defender war chest looted on victory (0-1). */
const VICTORY_LOOT_PCT = 0.25;
/** Number of buildings damaged on victory. */
const VICTORY_BUILDINGS_DAMAGED = 2;

// ---------------------------------------------------------------------------
// Siege power
// ---------------------------------------------------------------------------

/**
 * Attacker siege power from investment and military infrastructure.
 * Every 100k coins invested = 1 power, plus attacker fort tier defense
 * (their own military infrastructure contributes).
 *
 * @param {number} investment - coins committed to the siege
 * @param {number} attackerFortTier - attacker's fortification tier (0-4)
 * @returns {number} attacker power
 */
function siegePower(investment, attackerFortTier) {
  const fromCoins = Math.floor(Math.max(0, investment) / 100000);
  const fromInfra = Castle.fortTierDef(Math.max(0, Math.min(4, attackerFortTier))).defense;
  return fromCoins + fromInfra;
}

/**
 * Defender power is their castle's real defensive value.
 * @param {object} defenderCastle - castle record
 * @returns {number} defender power
 */
function defenderPower(defenderCastle) {
  return Castle.fortDefense(defenderCastle);
}

// ---------------------------------------------------------------------------
// Siege store helpers
// ---------------------------------------------------------------------------

function getSiegesState(store) {
  const state = store.load();
  if (!state.sieges) state.sieges = {};
  return state;
}

function getSiege(defenderKingdomId, store) {
  const state = store.load();
  return state.sieges?.[defenderKingdomId] ?? null;
}

function getSiegesByAttacker(attackerKingdomId, store) {
  const state = store.load();
  const sieges = state.sieges ?? {};
  return Object.values(sieges).filter(
    (s) => s.attackerKingdomId === attackerKingdomId
  );
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

/**
 * Check if a siege can be declared.
 * @returns {{ ok: boolean, reason?: string }}
 */
function canDeclareSiege(attackerKingdomId, defenderKingdomId, store) {
  if (!attackerKingdomId || !defenderKingdomId) {
    return { ok: false, reason: "missing-kingdom" };
  }
  if (attackerKingdomId === defenderKingdomId) {
    return { ok: false, reason: "cannot-siege-self" };
  }

  const attackerCastle = Castle.ensureCastle(attackerKingdomId, store);
  const defenderCastle = Castle.ensureCastle(defenderKingdomId, store);

  // Attacker must afford the declaration cost
  if (attackerCastle.warChest < SIEGE_DECLARE_COST) {
    return { ok: false, reason: "insufficient-funds" };
  }

  // No active siege on this defender already
  const existing = getSiege(defenderKingdomId, store);
  if (existing && existing.status === "active") {
    return { ok: false, reason: "already-besieged" };
  }

  // Cooldown: check last resolved siege against this defender
  if (existing && existing.resolvedAt) {
    const since = Date.now() - existing.resolvedAt;
    if (since < SIEGE_COOLDOWN_MS) {
      return { ok: false, reason: "on-cooldown" };
    }
  }

  return { ok: true };
}

/**
 * Declare a siege. Deducts declaration cost + investment from attacker's
 * war chest. Investment determines siege power.
 *
 * @param {string} attackerKingdomId
 * @param {string} defenderKingdomId
 * @param {number} investment - coins committed (on top of declare cost)
 * @param {object} store - KingdomStore
 * @returns {{ ok: boolean, reason?: string, siege?: object }}
 */
function declareSiege(attackerKingdomId, defenderKingdomId, investment, store) {
  const check = canDeclareSiege(attackerKingdomId, defenderKingdomId, store);
  if (!check.ok) return check;

  investment = Math.max(0, Math.floor(investment ?? 0));
  const totalCost = SIEGE_DECLARE_COST + investment;

  const state = getSiegesState(store);
  const attackerCastle = state.castles[attackerKingdomId];
  if (attackerCastle.warChest < totalCost) {
    return { ok: false, reason: "insufficient-funds" };
  }

  attackerCastle.warChest -= totalCost;

  const power = siegePower(investment, attackerCastle.fortTier);

  const siege = {
    attackerKingdomId,
    defenderKingdomId,
    progress: 0,
    investment,
    attackerPower: power,
    declaredAt: Date.now(),
    lastTickAt: Date.now(),
    ticksElapsed: 0,
    status: "active",
    lastSallyAt: 0,
    resolvedAt: 0,
    outcome: null,
  };

  state.sieges[defenderKingdomId] = siege;
  store.save();

  return { ok: true, siege };
}

// ---------------------------------------------------------------------------
// Siege tick
// ---------------------------------------------------------------------------

/**
 * Advance a siege by one tick. Called periodically (e.g., hourly).
 * Compares attacker power vs defender power to adjust progress.
 *
 * @param {string} defenderKingdomId
 * @param {object} store - KingdomStore
 * @returns {{ ok: boolean, reason?: string, outcome?: string, siege?: object }}
 */
function tickSiege(defenderKingdomId, store) {
  const state = getSiegesState(store);
  const siege = state.sieges[defenderKingdomId];
  if (!siege || siege.status !== "active") {
    return { ok: false, reason: "no-active-siege" };
  }

  const now = Date.now();
  if (now - siege.lastTickAt < SIEGE_TICK_MS) {
    return { ok: false, reason: "too-soon" };
  }

  const defenderCastle = state.castles[defenderKingdomId];
  if (!defenderCastle) {
    return { ok: false, reason: "no-defender-castle" };
  }

  const atk = siege.attackerPower;
  const def = Math.max(1, defenderPower(defenderCastle));
  const ratio = atk / def;

  // Progress based on power ratio
  if (ratio > 1.2) {
    siege.progress += 8; // Overwhelming attack
  } else if (ratio > 0.8) {
    siege.progress += 3; // Even fight, slow grind
  } else if (ratio > 0.5) {
    siege.progress += 1; // Weak attack, barely dents
  } else {
    siege.progress -= 5; // Defense holds, pushes back
  }

  siege.progress = Math.max(0, Math.min(100, siege.progress));
  siege.ticksElapsed += 1;
  siege.lastTickAt = now;

  // Check outcomes
  let outcome = null;
  if (siege.progress >= 100) {
    outcome = resolveVictory(siege, state);
  } else if (
    siege.progress <= 0 &&
    siege.ticksElapsed >= SIEGE_MIN_TICKS_BEFORE_DEFEAT
  ) {
    outcome = resolveDefeat(siege, state);
  } else if (siege.ticksElapsed >= SIEGE_MAX_TICKS) {
    outcome = resolveStalemate(siege, state);
  }

  if (outcome) {
    siege.status = outcome;
    siege.outcome = outcome;
    siege.resolvedAt = now;
  }

  store.save();
  return { ok: true, outcome, siege };
}

/**
 * Victory: attacker breaches the walls.
 * - Loot 25% of defender war chest → attacker's war chest
 * - Damage 2 random buildings (lose a tier, or destroyed if tier 1)
 * - Reduce defender fort tier by 1 (min 0)
 */
function resolveVictory(siege, state) {
  const attackerCastle = state.castles[siege.attackerKingdomId];
  const defenderCastle = state.castles[siege.defenderKingdomId];

  // Loot
  const loot = Math.floor(defenderCastle.warChest * VICTORY_LOOT_PCT);
  defenderCastle.warChest -= loot;
  if (attackerCastle) attackerCastle.warChest += loot;

  // Damage buildings
  const buildingIds = Object.keys(defenderCastle.buildings);
  // Shuffle and take up to VICTORY_BUILDINGS_DAMAGED
  for (let i = buildingIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [buildingIds[i], buildingIds[j]] = [buildingIds[j], buildingIds[i]];
  }
  const damaged = [];
  for (const bid of buildingIds.slice(0, VICTORY_BUILDINGS_DAMAGED)) {
    const b = defenderCastle.buildings[bid];
    if (!b) continue;
    if (b.tier > 1) {
      b.tier -= 1;
      damaged.push(`${bid}:tier-${b.tier}`);
    } else {
      delete defenderCastle.buildings[bid];
      damaged.push(`${bid}:destroyed`);
    }
  }

  // Damage fortification
  if (defenderCastle.fortTier > 0) {
    defenderCastle.fortTier -= 1;
  }

  siege.loot = loot;
  siege.damaged = damaged;
  return "victory";
}

/**
 * Defeat: defense holds, attacker repelled. Investment is lost.
 */
function resolveDefeat(siege, state) {
  // Investment already deducted at declaration; nothing to refund.
  // Attacker wasted their coins.
  return "defeat";
}

/**
 * Stalemate: siege drags on too long, both sides exhausted.
 */
function resolveStalemate(siege, state) {
  return "stalemate";
}

// ---------------------------------------------------------------------------
// Defense actions
// ---------------------------------------------------------------------------

/**
 * Defender sallies forth: a counterattack that reduces siege progress.
 * Costs war chest funds, has a cooldown.
 */
function sallyForth(defenderKingdomId, store) {
  const state = getSiegesState(store);
  const siege = state.sieges[defenderKingdomId];
  if (!siege || siege.status !== "active") {
    return { ok: false, reason: "no-active-siege" };
  }

  const now = Date.now();
  if (now - (siege.lastSallyAt ?? 0) < SALLY_COOLDOWN_MS) {
    return { ok: false, reason: "sally-on-cooldown" };
  }

  const defenderCastle = state.castles[defenderKingdomId];
  if (!defenderCastle || defenderCastle.warChest < SALLY_COST) {
    return { ok: false, reason: "insufficient-funds" };
  }

  defenderCastle.warChest -= SALLY_COST;
  siege.progress = Math.max(0, siege.progress - SALLY_PROGRESS_HIT);
  siege.lastSallyAt = now;
  store.save();

  return { ok: true, progress: siege.progress };
}

/**
 * Defender repairs walls: emergency repairs that reduce siege progress.
 * Cheaper than sallying but less effective. No cooldown (but costs add up).
 */
function repairWalls(defenderKingdomId, store) {
  const state = getSiegesState(store);
  const siege = state.sieges[defenderKingdomId];
  if (!siege || siege.status !== "active") {
    return { ok: false, reason: "no-active-siege" };
  }

  const defenderCastle = state.castles[defenderKingdomId];
  if (!defenderCastle || defenderCastle.warChest < REPAIR_COST) {
    return { ok: false, reason: "insufficient-funds" };
  }

  defenderCastle.warChest -= REPAIR_COST;
  siege.progress = Math.max(0, siege.progress - REPAIR_PROGRESS_HIT);
  store.save();

  return { ok: true, progress: siege.progress };
}

// ---------------------------------------------------------------------------
// Lifting sieges
// ---------------------------------------------------------------------------

/**
 * Attacker can lift (abandon) their siege. Investment is lost.
 */
function liftSiege(attackerKingdomId, defenderKingdomId, store) {
  const state = getSiegesState(store);
  const siege = state.sieges[defenderKingdomId];
  if (!siege || siege.status !== "active") {
    return { ok: false, reason: "no-active-siege" };
  }
  if (siege.attackerKingdomId !== attackerKingdomId) {
    return { ok: false, reason: "not-your-siege" };
  }

  siege.status = "lifted";
  siege.outcome = "lifted";
  siege.resolvedAt = Date.now();
  store.save();

  return { ok: true };
}

module.exports = {
  // Tuning
  SIEGE_DECLARE_COST,
  SIEGE_COOLDOWN_MS,
  SIEGE_TICK_MS,
  SIEGE_MAX_TICKS,
  SIEGE_MIN_TICKS_BEFORE_DEFEAT,
  SALLY_COST,
  SALLY_COOLDOWN_MS,
  SALLY_PROGRESS_HIT,
  REPAIR_COST,
  REPAIR_PROGRESS_HIT,
  VICTORY_LOOT_PCT,
  VICTORY_BUILDINGS_DAMAGED,
  // Power
  siegePower,
  defenderPower,
  // Declaration
  canDeclareSiege,
  declareSiege,
  // Tick
  tickSiege,
  // Queries
  getSiege,
  getSiegesByAttacker,
  // Defense
  sallyForth,
  repairWalls,
  // Attacker
  liftSiege,
};
