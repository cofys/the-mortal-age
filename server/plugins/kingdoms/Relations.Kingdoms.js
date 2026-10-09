"use strict";

/**
 * Relations.Kingdoms — the DIPLOMATIC STANCE LAYER (Phase 4).
 *
 * Every pair of kingdoms stands in one relation:
 *   "at-war"  — an active war or an active siege between them
 *   "allied"  — a live pact in the alliance registry
 *   "hostile" — bilateral tension at or above HOSTILE_TENSION (no pact)
 *   "neutral" — everything else (the default)
 *
 * This is a READ of existing state (wars, alliances, tension, sieges) —
 * not a second source of truth. The political layer (Diplomacy.Kingdoms),
 * the tension engine, and the war table all keep writing the state they
 * already own; this module just answers "where do we stand?"
 *
 * What it drives:
 *   - Sieges require hostile/at-war: canSiegeRelation() gates
 *     Siege.declareSiege. You cannot besiege an ally or a neutral power —
 *     escalate first (issueUltimatum) or fight a declared war.
 *   - Alliances enable trade: alliedTradeBonus() feeds the castle tithe
 *     economy — pact roads carry goods, and the war chest feels it.
 *   - Diplomacy actions: players spend personal influence to move the
 *     needle — sendEnvoy cools a hostile border toward neutral,
 *     issueUltimatum heats a neutral border toward hostile.
 *
 * RuneScape grounding: relations are the visible map of the realm. A
 * player should be able to ask "who hates whom" and get a straight
 * answer, then spend their hard-earned influence to change it.
 */

const Influence = require("./Influence.Kingdoms");

// ---------------------------------------------------------------------------
// Relation labels
// ---------------------------------------------------------------------------

const RELATION_AT_WAR = "at-war";
const RELATION_ALLIED = "allied";
const RELATION_HOSTILE = "hostile";
const RELATION_NEUTRAL = "neutral";
const RELATION_SELF = "self";

/** Bilateral tension at or above this reads as hostile (WAR_AT is 100). */
const HOSTILE_TENSION = 60;
/** Tension for a pair that has never been scored. */
const TENSION_DEFAULT = 20;

// ---------------------------------------------------------------------------
// State readers (all work on the passed store — testable with mock stores)
// ---------------------------------------------------------------------------

/** Canonical tension key: "a:b" with a < b (matches KingdomStore). */
function tensionKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function rawTension(a, b, store) {
  const v = store.load().tension?.[tensionKey(a, b)];
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

function tensionOf(a, b, store) {
  const stored = rawTension(a, b, store);
  return stored === null ? TENSION_DEFAULT : stored;
}

function setTension(a, b, score, store) {
  const state = store.load();
  if (!state.tension || typeof state.tension !== "object") state.tension = {};
  state.tension[tensionKey(a, b)] = Math.max(0, Math.min(100, Math.round(score)));
  // No save: callers save (same convention as KingdomStore.setRawTension).
}

function activeWars(store) {
  const wars = store.load().wars ?? [];
  return wars.filter((w) => w && w.active);
}

function atWarBetween(a, b, store) {
  return activeWars(store).some(
    (w) =>
      (w.attackerId === a && w.defenderId === b) ||
      (w.attackerId === b && w.defenderId === a)
  );
}

function activeSiegeBetween(a, b, store) {
  const sieges = store.load().sieges ?? {};
  return Object.values(sieges).some(
    (s) =>
      s &&
      s.status === "active" &&
      ((s.attackerKingdomId === a && s.defenderKingdomId === b) ||
        (s.attackerKingdomId === b && s.defenderKingdomId === a))
  );
}

function alliedIn(a, b, store) {
  const [x, y] = [String(a), String(b)].sort();
  const alliances = store.load().alliances ?? [];
  return alliances.some((r) => r && r.a === x && r.b === y);
}

function alliesOfIn(kingdomId, store) {
  const id = String(kingdomId);
  const alliances = store.load().alliances ?? [];
  return alliances
    .filter((r) => r && (r.a === id || r.b === id))
    .map((r) => (r.a === id ? r.b : r.a));
}

// ---------------------------------------------------------------------------
// Relation labels
// ---------------------------------------------------------------------------

/**
 * The diplomatic stance between two kingdoms.
 * @returns {"at-war"|"allied"|"hostile"|"neutral"|"self"}
 */
function relationOf(a, b, store) {
  if (!a || !b || !store) return RELATION_NEUTRAL;
  if (a === b) return RELATION_SELF;
  if (atWarBetween(a, b, store) || activeSiegeBetween(a, b, store)) {
    return RELATION_AT_WAR;
  }
  if (alliedIn(a, b, store)) return RELATION_ALLIED;
  if (tensionOf(a, b, store) >= HOSTILE_TENSION) return RELATION_HOSTILE;
  return RELATION_NEUTRAL;
}

/** True when the pair may go to siege: hostile borders or open war. */
function canSiegeRelation(attackerKingdomId, defenderKingdomId, store) {
  const rel = relationOf(attackerKingdomId, defenderKingdomId, store);
  if (rel === RELATION_ALLIED) {
    return { ok: false, reason: "allied-cannot-siege", relation: rel };
  }
  if (rel === RELATION_NEUTRAL || rel === RELATION_SELF) {
    return { ok: false, reason: "not-hostile", relation: rel };
  }
  return { ok: true, relation: rel };
}

// ---------------------------------------------------------------------------
// Alliance trade bonus
// ---------------------------------------------------------------------------

/** Tithe-efficiency bonus per allied kingdom (pact roads carry goods). */
const TRADE_BONUS_PER_ALLY = 0.05;
/** Cap so a web of pacts doesn't print money. */
const TRADE_BONUS_CAP = 0.15;

/**
 * Pact strength for the trade bonus: stronger bonds carry more goods.
 * Defaults to 1 for pacts that predate the strength field.
 */
function pactStrengthOf(a, b, store) {
  const [x, y] = [String(a), String(b)].sort();
  const alliances = store.load().alliances ?? [];
  const rec = alliances.find((r) => r && r.a === x && r.b === y);
  return rec?.strength ?? 1;
}

/**
 * Trade bonus for the castle tithe economy: +5% tithe efficiency per
 * allied kingdom, scaled by pact strength (a strength-3 pact moves
 * three times the goods), capped at +15%. Zero when friendless.
 */
function alliedTradeBonus(kingdomId, store) {
  if (!kingdomId || !store) return 0;
  const total = alliesOfIn(kingdomId, store).reduce(
    (sum, ally) => sum + TRADE_BONUS_PER_ALLY * pactStrengthOf(kingdomId, ally, store),
    0
  );
  return Math.min(TRADE_BONUS_CAP, total);
}

// ---------------------------------------------------------------------------
// Diplomacy actions (cost player influence)
// ---------------------------------------------------------------------------

/** Influence cost to send envoys that cool a hostile border. */
const ENVOY_INFLUENCE_COST = 50;
/** Tension relieved by a successful envoy mission. */
const ENVOY_TENSION_RELIEF = 15;
/** Influence cost to issue an ultimatum that heats a border. */
const ULTIMATUM_INFLUENCE_COST = 40;
/** Tension added by an ultimatum. */
const ULTIMATUM_TENSION_HIT = 15;
/**
 * Ultimatums sour relations to the brink but never declare war by
 * themselves — formal war goes through the war table / tension engine.
 */
const ULTIMATUM_TENSION_CAP = 99;

function spendOrFail(player, kingdomId, amount) {
  const available = Influence.effectiveInfluence(player, kingdomId);
  if (available < amount) {
    return { ok: false, reason: "insufficient-influence", available, cost: amount };
  }
  const spent = Influence.spendInfluence(player, kingdomId, amount);
  if (!spent.ok) {
    return { ok: false, reason: "insufficient-influence", available, cost: amount };
  }
  return { ok: true };
}

/**
 * Send envoys to cool a hostile border toward neutral. Costs influence.
 * Cannot target allies (nothing to cool), self, or a power you're at
 * war with (envoys don't cross battle lines).
 */
function sendEnvoy(player, kingdomId, targetKingdomId, store) {
  if (!player || !kingdomId || !targetKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const rel = relationOf(kingdomId, targetKingdomId, store);
  if (rel === RELATION_SELF) return { ok: false, reason: "cannot-target-self", relation: rel };
  if (rel === RELATION_ALLIED) return { ok: false, reason: "already-allied", relation: rel };
  if (rel === RELATION_AT_WAR) return { ok: false, reason: "at-war-no-envoys", relation: rel };
  if (rel === RELATION_NEUTRAL) return { ok: false, reason: "already-calm", relation: rel };

  const paid = spendOrFail(player, kingdomId, ENVOY_INFLUENCE_COST);
  if (!paid.ok) return paid;

  const before = tensionOf(kingdomId, targetKingdomId, store);
  const after = Math.max(0, before - ENVOY_TENSION_RELIEF);
  setTension(kingdomId, targetKingdomId, after, store);
  store.save();

  return {
    ok: true,
    tensionBefore: before,
    tension: after,
    relation: relationOf(kingdomId, targetKingdomId, store),
    influenceSpent: ENVOY_INFLUENCE_COST,
  };
}

/**
 * Issue an ultimatum that heats a neutral border toward hostile.
 * Costs influence. Cannot target allies (that's betrayal, not
 * diplomacy) or powers you're already fighting.
 */
function issueUltimatum(player, kingdomId, targetKingdomId, store) {
  if (!player || !kingdomId || !targetKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const rel = relationOf(kingdomId, targetKingdomId, store);
  if (rel === RELATION_SELF) return { ok: false, reason: "cannot-target-self", relation: rel };
  if (rel === RELATION_ALLIED) return { ok: false, reason: "allied-cannot-threaten", relation: rel };
  if (rel === RELATION_AT_WAR) return { ok: false, reason: "already-at-war", relation: rel };

  const paid = spendOrFail(player, kingdomId, ULTIMATUM_INFLUENCE_COST);
  if (!paid.ok) return paid;

  const before = tensionOf(kingdomId, targetKingdomId, store);
  const after = Math.min(ULTIMATUM_TENSION_CAP, before + ULTIMATUM_TENSION_HIT);
  setTension(kingdomId, targetKingdomId, after, store);
  store.save();

  return {
    ok: true,
    tensionBefore: before,
    tension: after,
    relation: relationOf(kingdomId, targetKingdomId, store),
    influenceSpent: ULTIMATUM_INFLUENCE_COST,
  };
}

module.exports = {
  // Labels
  RELATION_AT_WAR,
  RELATION_ALLIED,
  RELATION_HOSTILE,
  RELATION_NEUTRAL,
  RELATION_SELF,
  HOSTILE_TENSION,
  // Reads
  relationOf,
  canSiegeRelation,
  tensionOf,
  alliedTradeBonus,
  pactStrengthOf,
  // Actions
  sendEnvoy,
  issueUltimatum,
  ENVOY_INFLUENCE_COST,
  ENVOY_TENSION_RELIEF,
  ULTIMATUM_INFLUENCE_COST,
  ULTIMATUM_TENSION_HIT,
};
