"use strict";

/**
 * Wars.Kingdoms — formal war declarations, war goals, and peace treaties (Phase 5).
 *
 * Sieges (Siege.Kingdoms) are military operations; wars are the political
 * frame around them. A kingdom declares war with a GOAL:
 *
 *   loot       — plunder: siege victories loot 35% of the defender war chest
 *   territory  — demolition: siege victories raze fortifications twice as hard
 *   vassalize  — subjugation: siege victory makes the defender a vassal
 *
 * Without a declared war, a siege is just a raid with the default spoils.
 * With one, the goal shapes what victory takes.
 *
 * War declarations cost the declarer's personal influence and carry a
 * per-pair cooldown: you cannot re-declare on the same power within 7 days
 * of the last war ending. Vassals cannot declare on their overlord — they
 * must break vassalage first (after 30 days, at an influence cost).
 *
 * Peace is a two-step dance: one side offers terms, the other accepts.
 * Terms: white-peace (nothing changes), tribute (a one-time payment), or
 * vassalize (the loser becomes the winner's vassal). Accepted peace sets
 * the border tension to 25 (an armistice, not friendship).
 *
 * Vassals pay 10% of their net tithe income to their overlord — the
 * castle tithe economy (Castle.collectTithes) applies this. Vassalage is
 * recorded on the shared kingdom state, never in a second registry.
 *
 * All functions take the store (KingdomStore) as the last argument and use
 * the store.load()/store.save() convention, so they test with mock stores.
 * State-level readers (warGoalBetween, vassal helpers) also work on a raw
 * state object for use inside siege resolution.
 *
 * RuneScape grounding: wars are how kingdoms change the map. Declaring one
 * is expensive and public; the goal tells everyone what you're really after.
 */

const Influence = require("./Influence.Kingdoms");
const Relations = require("./Relations.Kingdoms");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Declared war goals. */
const WAR_GOALS = ["loot", "territory", "vassalize"];
const WAR_GOAL_LABELS = {
  loot: "Plunder",
  territory: "Territory",
  vassalize: "Vassalize",
};

/** Personal influence the declarer spends to start a war. */
const WAR_DECLARE_INFLUENCE_COST = 100;
/** Per-pair cooldown after a war ends before another may be declared. */
const WAR_DECLARE_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
/** Influence to offer peace terms. Accepting is free. */
const PEACE_OFFER_INFLUENCE_COST = 25;
/** Influence a vassal spends to declare independence. */
const BREAK_VASSALAGE_INFLUENCE_COST = 75;
/** Days a vassal must wait before breaking vassalage. */
const BREAK_VASSALAGE_MIN_DAYS = 30;
/** Border tension after a ratified peace (armistice, not friendship). */
const PEACE_TENSION = 25;
/** Border tension after a vassal breaks away (the overlord is furious). */
const BREAKAWAY_TENSION = 80;
/** Share of a vassal's net tithe income paid to the overlord. */
const VASSAL_TITHE_PCT = 0.1;
/** Max tribute demandable in peace terms (coins). */
const MAX_TRIBUTE = 50_000_000;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/** Canonical pair key: "a:b" with a < b. */
function pairKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function warsOf(state) {
  if (!Array.isArray(state.wars)) state.wars = [];
  return state.wars;
}

function activeWarBetweenState(a, b, state) {
  return (
    warsOf(state).find(
      (w) =>
        w &&
        w.active &&
        ((w.attackerId === a && w.defenderId === b) ||
          (w.attackerId === b && w.defenderId === a))
    ) ?? null
  );
}

function lastEndedWarBetweenState(a, b, state) {
  const ended = warsOf(state).filter(
    (w) =>
      w &&
      !w.active &&
      ((w.attackerId === a && w.defenderId === b) ||
        (w.attackerId === b && w.defenderId === a))
  );
  ended.sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0));
  return ended[0] ?? null;
}

/** The declared goal of the active war between two kingdoms (or null). */
function warGoalBetween(a, b, state) {
  const war = activeWarBetweenState(a, b, state);
  return war && WAR_GOALS.includes(war.goal) ? war.goal : null;
}

function setTensionState(a, b, score, state) {
  if (!state.tension || typeof state.tension !== "object") state.tension = {};
  state.tension[pairKey(a, b)] = Math.max(0, Math.min(100, Math.round(score)));
}

// ---------------------------------------------------------------------------
// Vassalage (state-level, shared with siege resolution)
// ---------------------------------------------------------------------------

function vassalsOf(state) {
  if (!state.vassals || typeof state.vassals !== "object") state.vassals = {};
  return state.vassals;
}

/** Record vassalage: vassalId swears fealty to overlordId. */
function setVassalState(vassalId, overlordId, state) {
  vassalsOf(state)[String(vassalId)] = {
    overlordId: String(overlordId),
    since: Date.now(),
  };
}

/** Clear vassalage for a vassal. */
function clearVassalState(vassalId, state) {
  delete vassalsOf(state)[String(vassalId)];
}

/** The overlord of a vassal kingdom, or null. */
function getVassalOverlordState(vassalId, state) {
  const record = vassalsOf(state)[String(vassalId)];
  return record ? record.overlordId : null;
}

/** All vassals sworn to an overlord: [{ vassalId, since }]. */
function getVassalsOfState(overlordId, state) {
  return Object.entries(vassalsOf(state))
    .filter(([, r]) => r && r.overlordId === String(overlordId))
    .map(([vassalId, r]) => ({ vassalId, since: r.since }));
}

function isVassalOfState(vassalId, overlordId, state) {
  return getVassalOverlordState(vassalId, state) === String(overlordId);
}

/**
 * Vassal tribute owed on a tithe cycle: 10% of positive net income.
 * Pure — the caller moves the coins.
 */
function vassalTributeOf(kingdomId, net, state) {
  const overlordId = getVassalOverlordState(kingdomId, state);
  if (!overlordId || !(net > 0)) return { tribute: 0, overlordId: null };
  return { tribute: Math.floor(net * VASSAL_TITHE_PCT), overlordId };
}

// ---------------------------------------------------------------------------
// War declaration
// ---------------------------------------------------------------------------

/**
 * Can attackerId declare war on defenderId right now?
 * @returns {{ ok: boolean, reason?: string }}
 */
function canDeclareWar(attackerId, defenderId, store) {
  if (!attackerId || !defenderId) return { ok: false, reason: "missing-kingdom" };
  if (attackerId === defenderId) return { ok: false, reason: "cannot-war-self" };

  const state = store.load();

  // Vassals fight their overlord by breaking away, not by declaration.
  if (isVassalOfState(attackerId, defenderId, state)) {
    return { ok: false, reason: "vassal-cannot-declare" };
  }

  // No declaring on allies — that's betrayal, and the pact system owns it.
  // (Relations reads from the store itself.)
  const rel = Relations.relationOf(attackerId, defenderId, store);
  if (rel === Relations.RELATION_ALLIED) {
    return { ok: false, reason: "allied-cannot-war", relation: rel };
  }

  if (activeWarBetweenState(attackerId, defenderId, state)) {
    return { ok: false, reason: "already-at-war" };
  }

  const last = lastEndedWarBetweenState(attackerId, defenderId, state);
  if (last && last.endedAt && Date.now() - last.endedAt < WAR_DECLARE_COOLDOWN_MS) {
    return { ok: false, reason: "on-cooldown" };
  }

  return { ok: true, relation: rel };
}

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
 * State-level war declaration core. Both the player path (personal
 * influence) and the AI council path (war-chest mobilization) land here,
 * so the war record shape never drifts between them.
 */
function applyDeclareWar(attackerKingdomId, defenderKingdomId, goal, declaredBy, state, reasonOverride = null) {
  const war = {
    attackerId: attackerKingdomId,
    defenderId: defenderKingdomId,
    goal,
    declaredBy,
    reason: reasonOverride ?? `War of ${WAR_GOAL_LABELS[goal].toLowerCase()}`,
    active: true,
    declaredAt: Date.now(),
    endedAt: null,
    outcome: null,
    resolveAt: null,
  };
  warsOf(state).push(war);
  setTensionState(attackerKingdomId, defenderKingdomId, 100, state);
  return war;
}

/**
 * Formally declare war with a goal. Costs influence. Sets border tension
 * to 100 — the realm hears about it.
 *
 * @param {object} player - the declaring player (must hold influence in the kingdom)
 * @param {string} attackerKingdomId - the declaring kingdom
 * @param {string} defenderKingdomId - the target kingdom
 * @param {string} goal - one of WAR_GOALS
 * @param {object} store - KingdomStore
 */
function declareWar(player, attackerKingdomId, defenderKingdomId, goal, store) {
  if (!player || !attackerKingdomId || !defenderKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  if (!WAR_GOALS.includes(goal)) {
    return { ok: false, reason: "invalid-goal", validGoals: WAR_GOALS };
  }

  const check = canDeclareWar(attackerKingdomId, defenderKingdomId, store);
  if (!check.ok) return check;

  const paid = spendOrFail(player, attackerKingdomId, WAR_DECLARE_INFLUENCE_COST);
  if (!paid.ok) return paid;

  const state = store.load();
  const war = applyDeclareWar(
    attackerKingdomId,
    defenderKingdomId,
    goal,
    player.username ?? player.getUsername?.() ?? null,
    state
  );
  store.save();

  return {
    ok: true,
    war,
    goal,
    goalLabel: WAR_GOAL_LABELS[goal],
    influenceSpent: WAR_DECLARE_INFLUENCE_COST,
  };
}

/** War-chest coins an AI kingdom pays to mobilize for a council-declared war. */
const AI_WAR_MOBILIZATION_COST = 2_000_000;

/**
 * The AI war council declares war. Same gates as canDeclareWar, but the
 * price is war-chest mobilization instead of personal influence — courts,
 * not heroes, move the pieces. The record carries declaredBy "ai-council"
 * so the tension engine and the annals treat it like any other war.
 *
 * @param {string} attackerKingdomId
 * @param {string} defenderKingdomId
 * @param {string} goal - one of WAR_GOALS
 * @param {object} store - KingdomStore
 * @param {object} opts - { reason } annals line override
 */
function declareWarAi(attackerKingdomId, defenderKingdomId, goal, store, opts = {}) {
  if (!attackerKingdomId || !defenderKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  if (!WAR_GOALS.includes(goal)) {
    return { ok: false, reason: "invalid-goal", validGoals: WAR_GOALS };
  }

  const check = canDeclareWar(attackerKingdomId, defenderKingdomId, store);
  if (!check.ok) return check;

  const state = store.load();
  const castle = state.castles?.[attackerKingdomId];
  const warChest = castle?.warChest ?? 0;
  if (warChest < AI_WAR_MOBILIZATION_COST) {
    return {
      ok: false,
      reason: "insufficient-funds",
      available: warChest,
      cost: AI_WAR_MOBILIZATION_COST,
    };
  }
  if (castle) castle.warChest = warChest - AI_WAR_MOBILIZATION_COST;

  const war = applyDeclareWar(
    attackerKingdomId,
    defenderKingdomId,
    goal,
    "ai-council",
    state,
    opts.reason ?? null
  );
  store.save();

  return {
    ok: true,
    war,
    goal,
    goalLabel: WAR_GOAL_LABELS[goal],
    mobilizationCost: AI_WAR_MOBILIZATION_COST,
  };
}

// ---------------------------------------------------------------------------
// Peace treaties
// ---------------------------------------------------------------------------

/** Peace term shapes. */
const PEACE_TERMS = ["white-peace", "tribute", "vassalize"];

function peaceOffersOf(state) {
  if (!Array.isArray(state.peaceOffers)) state.peaceOffers = [];
  return state.peaceOffers;
}

function offerBetweenState(a, b, state) {
  return (
    peaceOffersOf(state).find(
      (o) =>
        o &&
        ((o.a === a && o.b === b) || (o.a === b && o.b === a))
    ) ?? null
  );
}

function validateTerms(terms) {
  if (!terms || typeof terms !== "object") return { ok: false, reason: "invalid-terms" };
  if (!PEACE_TERMS.includes(terms.type)) {
    return { ok: false, reason: "invalid-terms", validTerms: PEACE_TERMS };
  }
  if (terms.type === "tribute") {
    const amount = Math.floor(terms.amount ?? 0);
    if (!(amount > 0) || amount > MAX_TRIBUTE) {
      return { ok: false, reason: "invalid-tribute", max: MAX_TRIBUTE };
    }
    return { ok: true, terms: { type: "tribute", amount } };
  }
  return { ok: true, terms: { type: terms.type } };
}

/** Shared gates for putting peace terms on the table (player or council). */
function checkOfferPeace(kingdomId, targetKingdomId, state) {
  const war = activeWarBetweenState(kingdomId, targetKingdomId, state);
  if (!war) return { ok: false, reason: "not-at-war" };
  if (offerBetweenState(kingdomId, targetKingdomId, state)) {
    return { ok: false, reason: "offer-pending" };
  }
  return { ok: true };
}

/** Shared push: record the offer once every gate (and price) is settled. */
function pushOfferPeace(kingdomId, targetKingdomId, terms, offeredByLabel, state) {
  const [a, b] = [String(kingdomId), String(targetKingdomId)].sort();
  const offer = {
    a,
    b,
    offeredBy: String(kingdomId),
    offeredByPlayer: offeredByLabel,
    terms,
    offeredAt: Date.now(),
  };
  peaceOffersOf(state).push(offer);
  return offer;
}

/**
 * Offer peace terms to the other side of an active war. Either belligerent
 * may offer; the other accepts. Costs influence to put terms on the table.
 */
function offerPeace(player, kingdomId, targetKingdomId, terms, store) {
  if (!player || !kingdomId || !targetKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const state = store.load();
  const gate = checkOfferPeace(kingdomId, targetKingdomId, state);
  if (!gate.ok) return gate;

  const checked = validateTerms(terms);
  if (!checked.ok) return checked;

  const paid = spendOrFail(player, kingdomId, PEACE_OFFER_INFLUENCE_COST);
  if (!paid.ok) return paid;

  const offer = pushOfferPeace(
    kingdomId,
    targetKingdomId,
    checked.terms,
    player.username ?? player.getUsername?.() ?? null,
    state
  );
  store.save();

  return { ok: true, offer, influenceSpent: PEACE_OFFER_INFLUENCE_COST };
}

/**
 * The AI war council offers peace terms. Same gates as the player path —
 * courts pay in concessions, not influence.
 */
function offerPeaceAi(kingdomId, targetKingdomId, terms, store) {
  if (!kingdomId || !targetKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const state = store.load();
  const gate = checkOfferPeace(kingdomId, targetKingdomId, state);
  if (!gate.ok) return gate;

  const checked = validateTerms(terms);
  if (!checked.ok) return checked;

  const offer = pushOfferPeace(kingdomId, targetKingdomId, checked.terms, "ai-council", state);
  store.save();

  return { ok: true, offer };
}

/** Pending peace offers involving a kingdom. */
function getPeaceOffers(kingdomId, store) {
  const state = store.load();
  return peaceOffersOf(state).filter((o) => o && (o.a === kingdomId || o.b === kingdomId));
}

function removeOffer(a, b, state) {
  const offers = peaceOffersOf(state);
  const idx = offers.findIndex(
    (o) => o && ((o.a === a && o.b === b) || (o.a === b && o.b === a))
  );
  if (idx >= 0) offers.splice(idx, 1);
}

/**
 * Shared core: ratify a pending peace offer. Terms name the loser: tribute
 * and vassalize apply to the side that did NOT offer (the offerer dictates).
 * White peace touches nothing. The war closes as a treaty and the border
 * cools to an armistice.
 */
function applyAcceptPeace(kingdomId, targetKingdomId, state) {
  const offer = offerBetweenState(kingdomId, targetKingdomId, state);
  if (!offer) return { ok: false, reason: "no-offer" };
  const war = activeWarBetweenState(kingdomId, targetKingdomId, state);
  if (!war) return { ok: false, reason: "not-at-war" };

  const loserId = offer.offeredBy === String(kingdomId) ? String(targetKingdomId) : String(kingdomId);
  const winnerId = loserId === String(kingdomId) ? String(targetKingdomId) : String(kingdomId);
  const applied = { type: offer.terms.type };

  if (offer.terms.type === "tribute") {
    const amount = offer.terms.amount;
    if (!state.castles) state.castles = {};
    const loserCastle = state.castles[loserId] ?? { warChest: 0 };
    const paid = Math.min(Math.max(0, Math.floor(loserCastle.warChest ?? 0)), amount);
    loserCastle.warChest = (loserCastle.warChest ?? 0) - paid;
    state.castles[loserId] = loserCastle;
    const winnerCastle = state.castles[winnerId] ?? { warChest: 0 };
    winnerCastle.warChest = (winnerCastle.warChest ?? 0) + paid;
    state.castles[winnerId] = winnerCastle;
    applied.paid = paid;
  } else if (offer.terms.type === "vassalize") {
    setVassalState(loserId, winnerId, state);
    applied.vassal = loserId;
    applied.overlord = winnerId;
  }

  war.active = false;
  war.outcome = "peace-treaty";
  war.endedAt = Date.now();
  war.peaceTerms = offer.terms;

  setTensionState(kingdomId, targetKingdomId, PEACE_TENSION, state);
  removeOffer(kingdomId, targetKingdomId, state);
  return { ok: true, outcome: "peace-treaty", applied, war };
}

/**
 * Accept a pending peace offer. Ends the war as a treaty, applies the
 * terms, and cools the border to an armistice. Accepting is free — the
 * offerer already paid to put terms on the table.
 */
function acceptPeace(player, kingdomId, targetKingdomId, store) {
  if (!player || !kingdomId || !targetKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const state = store.load();
  const res = applyAcceptPeace(kingdomId, targetKingdomId, state);
  if (!res.ok) return res;
  store.save();
  return res;
}

/**
 * The AI war council accepts a pending peace offer — same terms, same
 * treaty, no player at the table.
 */
function acceptPeaceAi(kingdomId, targetKingdomId, store) {
  if (!kingdomId || !targetKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const state = store.load();
  const res = applyAcceptPeace(kingdomId, targetKingdomId, state);
  if (!res.ok) return res;
  store.save();
  return res;
}

// ---------------------------------------------------------------------------
// Breaking vassalage
// ---------------------------------------------------------------------------

/** Shared timing gate for breaking an oath (player or council). */
function vassalBreakTiming(vassalKingdomId, state) {
  const record = vassalsOf(state)[String(vassalKingdomId)];
  if (!record) return { ok: false, reason: "not-a-vassal" };

  const days = (Date.now() - (record.since ?? 0)) / (24 * 3600 * 1000);
  if (days < BREAK_VASSALAGE_MIN_DAYS) {
    return {
      ok: false,
      reason: "too-soon",
      daysElapsed: Math.floor(days),
      daysRequired: BREAK_VASSALAGE_MIN_DAYS,
    };
  }
  return { ok: true, record };
}

/** Shared effect: the oath is broken and the overlord's border burns. */
function applyBreakVassalage(vassalKingdomId, record, state) {
  clearVassalState(vassalKingdomId, state);
  setTensionState(vassalKingdomId, record.overlordId, BREAKAWAY_TENSION, state);
  return { ok: true, formerOverlord: record.overlordId };
}

/**
 * A vassal declares independence. Only after BREAK_VASSALAGE_MIN_DAYS have
 * passed, and at an influence cost. The overlord's border burns to 80.
 */
function breakVassalage(player, vassalKingdomId, store) {
  if (!player || !vassalKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const state = store.load();
  const timing = vassalBreakTiming(vassalKingdomId, state);
  if (!timing.ok) return timing;

  const paid = spendOrFail(player, vassalKingdomId, BREAK_VASSALAGE_INFLUENCE_COST);
  if (!paid.ok) return paid;

  const res = applyBreakVassalage(vassalKingdomId, timing.record, state);
  store.save();

  return { ...res, influenceSpent: BREAK_VASSALAGE_INFLUENCE_COST };
}

/**
 * The AI war council breaks a vassal's oath — same 30-day wait, no
 * influence price. Resentment, not heroes, ends fealty.
 */
function breakVassalageAi(vassalKingdomId, store) {
  if (!vassalKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const state = store.load();
  const timing = vassalBreakTiming(vassalKingdomId, state);
  if (!timing.ok) return timing;

  const res = applyBreakVassalage(vassalKingdomId, timing.record, state);
  store.save();
  return res;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Active wars involving a kingdom, with goals and labels. */
function getWars(kingdomId, store) {
  const state = store.load();
  return warsOf(state)
    .filter((w) => w && w.active && (w.attackerId === kingdomId || w.defenderId === kingdomId))
    .map((w) => ({
      attackerId: w.attackerId,
      defenderId: w.defenderId,
      goal: w.goal ?? null,
      goalLabel: w.goal ? WAR_GOAL_LABELS[w.goal] : null,
      declaredAt: w.declaredAt ?? null,
      declaredBy: w.declaredBy ?? null,
    }));
}

function getVassalOverlord(kingdomId, store) {
  return getVassalOverlordState(kingdomId, store.load());
}

function getVassalsOf(overlordId, store) {
  return getVassalsOfState(overlordId, store.load());
}

function isVassalOf(vassalId, overlordId, store) {
  return isVassalOfState(vassalId, overlordId, store.load());
}

module.exports = {
  // Tuning
  WAR_GOALS,
  WAR_GOAL_LABELS,
  PEACE_TERMS,
  WAR_DECLARE_INFLUENCE_COST,
  WAR_DECLARE_COOLDOWN_MS,
  PEACE_OFFER_INFLUENCE_COST,
  BREAK_VASSALAGE_INFLUENCE_COST,
  BREAK_VASSALAGE_MIN_DAYS,
  PEACE_TENSION,
  VASSAL_TITHE_PCT,
  MAX_TRIBUTE,
  // Declaration
  canDeclareWar,
  declareWar,
  declareWarAi,
  AI_WAR_MOBILIZATION_COST,
  // State-level readers (siege resolution)
  warGoalBetween,
  activeWarBetween: (a, b, store) => activeWarBetweenState(a, b, store.load()),
  // Vassalage
  setVassalState,
  clearVassalState,
  getVassalOverlordState,
  getVassalsOfState,
  isVassalOfState,
  vassalTributeOf,
  getVassalOverlord,
  getVassalsOf,
  isVassalOf,
  breakVassalage,
  breakVassalageAi,
  // Peace
  offerPeace,
  offerPeaceAi,
  acceptPeace,
  acceptPeaceAi,
  getPeaceOffers,
  // Queries
  getWars,
};
