"use strict";

/**
 * WarResolution — the spine that connects fighting to consequences.
 *
 * Before this module, the war machine had a working front half (tension →
 * declaration → attrition → supply → sieges → citizen soldiers) and a
 * diplomatic exit (peace treaties), but nothing turned battlefield success
 * into a war outcome: sieges resolved without touching the war, war goals
 * were never consulted at resolution, and timer expiry invented a victor
 * from treasury math and paid them nothing.
 *
 * The spine:
 *   - War score lives on the war record ({ attacker, defender }) and is
 *     fed by REAL events only: siege victories, sieges held, field-battle
 *     victories. No score is ever derived from a hash or a timer.
 *   - resolveWar() is the single exit door for conquest, collapse,
 *     surrender, decisive score, and expiry. It applies goal-shaped
 *     consequences with the existing primitives: reparations move real
 *     coins war-chest → war-chest (capped at what the loser holds, like
 *     treaty tribute), vassalize calls Wars.setVassalState, territory
 *     wars stand on the fort damage their sieges already dealt.
 *   - A vassalize-goal siege victory ends the war on the spot — the goal
 *     is achieved, the oath is sworn, the levies march home.
 *   - Surrender is a unilateral exit: the surrendering side loses, and
 *     pays surrender-grade reparations.
 *   - Wars declared by players or AI councils carry a resolveAt (7 days)
 *     so no war runs forever.
 *
 * All state functions take the store (KingdomStore) as the last argument
 * and use the store.load()/store.save() convention, so they test with
 * mock stores. Announcement/event emission uses the plugin api when the
 * module is attached; in unit tests the state changes stand on their own.
 */

const Wars = require("./Wars.Kingdoms");

// ---------------------------------------------------------------------------
// Tuning — every number for the war spine lives here.
// ---------------------------------------------------------------------------

const WAR_RESOLUTION_CONFIG = Object.freeze({
  /** Player/AI-council wars burn out after this long if nothing ends them. */
  PLAYER_WAR_TIMEOUT_MS: 7 * 24 * 3600 * 1000,
  /** War-score margin at which the leading side wins outright. */
  DECISIVE_MARGIN: 100,
  /** Score for breaching a castle in a siege. */
  SCORE_SIEGE_VICTORY: 40,
  /** Score for holding the walls against a siege. */
  SCORE_SIEGE_HELD: 25,
  /** Score for winning a field battle. */
  SCORE_BATTLE_VICTORY: 15,
  /** At expiry, a score margin below this is a genuine white peace. */
  WHITE_PEACE_MARGIN: 10,
  /** Share of the loser's war chest paid to the winner as reparations. */
  REPARATIONS_PCT: 0.15,
  /** Reparations share for a plunder (loot-goal) war. */
  REPARATIONS_PCT_LOOT_GOAL: 0.25,
  /** Reparations share when the loser surrendered. */
  SURRENDER_REPARATIONS_PCT: 0.25,
  /** Border tension after a dictated peace (conquest is not friendship). */
  CONQUEST_TENSION: 40,
  /** Border tension after a white peace. */
  WHITE_PEACE_TENSION: 25,
  /** Both treasuries bleed this share in a white peace — war is costly. */
  WHITE_PEACE_DRAIN_PCT: 0.05,
  /** Levies both sides go home with after a war (mirrors Tension). */
  GARRISON_AFTER_WAR: 30,
});

let pluginApi = null;

function pairKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function nameOf(state, kingdomId) {
  return state?.kingdoms?.[kingdomId]?.name ?? String(kingdomId);
}

function announceToRealm(message) {
  if (!pluginApi?.core?.World) return;
  try {
    pluginApi.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        try {
          p.sendMessage(message);
        } catch {
          // One deaf player doesn't silence the realm.
        }
      });
  } catch {
    // Announcement is courtesy; resolution already happened.
  }
}

function emitWarEnded(attackerId, defenderId, outcome) {
  try {
    pluginApi?.emitCustomEvent?.("kingdom:war-ended", {
      attackerId,
      defenderId,
      outcome,
    });
  } catch {
    // Listeners (battlefield cleanup, refugees) are best-effort here —
    // the war record itself is already closed by resolveWar.
  }
}

// ---------------------------------------------------------------------------
// War score
// ---------------------------------------------------------------------------

/** The war record's score, normalized: { attacker, defender }. */
function scoreFor(war) {
  const s = war?.score && typeof war.score === "object" ? war.score : {};
  return {
    attacker: Math.max(0, Math.floor(s.attacker ?? 0)),
    defender: Math.max(0, Math.floor(s.defender ?? 0)),
  };
}

/**
 * Add war score to a kingdom in its active war with another kingdom.
 * @param {string} a - one belligerent
 * @param {string} b - the other belligerent
 * @param {string} scoringKingdomId - who earned the points
 * @param {number} points
 * @param {object} store
 * @returns the updated war record, or null when no active war exists
 */
function addWarScore(a, b, scoringKingdomId, points, store) {
  if (!a || !b || !scoringKingdomId || !(points > 0) || !store) return null;
  const war = Wars.activeWarBetween(a, b, store);
  if (!war) return null;
  const score = scoreFor(war);
  if (scoringKingdomId === war.attackerId) score.attacker += points;
  else if (scoringKingdomId === war.defenderId) score.defender += points;
  else return null;
  war.score = score;
  store.save();
  return war;
}

/** Score snapshot for the active war between two kingdoms (or null). */
function warScoreBetween(a, b, store) {
  if (!a || !b || !store) return null;
  const state = store.load();
  const war = Wars.activeWarBetween(a, b, store);
  if (!war) return null;
  const score = scoreFor(war);
  return {
    war,
    score,
    leaderId:
      score.attacker === score.defender
        ? null
        : score.attacker > score.defender
          ? war.attackerId
          : war.defenderId,
    margin: Math.abs(score.attacker - score.defender),
  };
}

// ---------------------------------------------------------------------------
// Consequences
// ---------------------------------------------------------------------------

/**
 * Apply the material consequences of a decided war to state. The caller
 * (resolveWar) owns closing the war record.
 *
 * @param {object} war - the active war record
 * @param {string} winnerId
 * @param {string} loserId
 * @param {object} opts - { surrender?: boolean }
 * @param {object} state
 * @returns {{ reparations: number, vassalized: boolean, goal: string|null }}
 */
function applyConsequences(war, winnerId, loserId, opts, state) {
  const goal = war.goal && Wars.WAR_GOALS.includes(war.goal) ? war.goal : null;
  const applied = { reparations: 0, vassalized: false, goal };

  // Reparations: real coins, war chest to war chest, capped at what the
  // loser actually holds — the same honesty treaty tribute uses.
  let pct = WAR_RESOLUTION_CONFIG.REPARATIONS_PCT;
  if (opts?.surrender) pct = WAR_RESOLUTION_CONFIG.SURRENDER_REPARATIONS_PCT;
  else if (goal === "loot") pct = WAR_RESOLUTION_CONFIG.REPARATIONS_PCT_LOOT_GOAL;
  if (!state.castles) state.castles = {};
  const loserCastle = state.castles[loserId];
  const winnerCastle = state.castles[winnerId];
  const available = Math.max(0, Math.floor(loserCastle?.warChest ?? 0));
  const reparations = Math.min(available, Math.floor(available * pct));
  if (reparations > 0 && loserCastle && winnerCastle) {
    loserCastle.warChest -= reparations;
    winnerCastle.warChest += reparations;
    applied.reparations = reparations;
  }

  // Vassalize: the prize is the oath. The primitives (tithe, break-oath
  // gates, war-table tree) already exist and just work from here.
  if (goal === "vassalize") {
    Wars.setVassalState(loserId, winnerId, state);
    applied.vassalized = true;
  }

  // Territory: there is no tile transfer anywhere in the realm — the
  // consequence stands on the fort and building damage the winning
  // side's sieges already dealt, plus reparations above.

  return applied;
}

/** Active sieges between the pair are lifted: the armies march home. */
function liftSiegesBetween(a, b, state) {
  const sieges = state.sieges ?? {};
  for (const [defenderId, siege] of Object.entries(sieges)) {
    if (!siege || siege.status !== "active") continue;
    const pair = [siege.attackerKingdomId, defenderId].sort().join(":");
    if (pair === pairKey(a, b)) {
      siege.status = "lifted";
      siege.outcome = "war-ended";
      siege.resolvedAt = Date.now();
    }
  }
}

/** Pending peace offers between the pair die with the war. */
function clearPeaceOffersBetween(a, b, state) {
  if (!Array.isArray(state.peaceOffers)) return;
  state.peaceOffers = state.peaceOffers.filter(
    (o) => !o || !((o.a === a && o.b === b) || (o.a === b && o.b === a))
  );
}

function setTensionPair(a, b, score, state) {
  if (!state.tension || typeof state.tension !== "object") state.tension = {};
  state.tension[pairKey(a, b)] = Math.max(0, Math.min(100, Math.round(score)));
}

function resetGarrisons(a, b) {
  try {
    const Tension = require("./Tension.Kingdoms");
    if (typeof Tension.setGarrison === "function") {
      Tension.setGarrison(a, WAR_RESOLUTION_CONFIG.GARRISON_AFTER_WAR);
      Tension.setGarrison(b, WAR_RESOLUTION_CONFIG.GARRISON_AFTER_WAR);
    }
  } catch {
    // Tension module unavailable: garrisons keep their wartime values.
  }
}

function outcomeText(war, winnerId, loserId, opts, state) {
  const winnerName = nameOf(state, winnerId);
  const loserName = nameOf(state, loserId);
  if (opts?.surrender) {
    return `${loserName} surrenders — ${winnerName} dictates the peace`;
  }
  switch (opts?.reason) {
    case "vassalize-siege":
      return `${winnerName} takes the castle — ${loserName} bends the knee`;
    case "garrison-collapse":
      return `${loserName}'s levies break in the field — ${winnerName} victorious`;
    case "decisive-score":
      return `${winnerName} victorious — the war is won in the field, not at the table`;
    case "expiry":
      return `${winnerName} victorious — the peace is dictated, not negotiated`;
    default:
      return `${winnerName} victorious over ${loserName}`;
  }
}

// ---------------------------------------------------------------------------
// The exit door
// ---------------------------------------------------------------------------

/**
 * End the active war between attackerId and defenderId (the stored war's
 * own direction). When winnerId is null the outcome is decided by war
 * score: a real margin crowns the leader; a near-tie is a white peace.
 *
 * @param {string} attackerId - the war record's attacker
 * @param {string} defenderId - the war record's defender
 * @param {string|null} winnerId
 * @param {object} opts - { reason, surrender }
 * @param {object} store
 */
function resolveWar(attackerId, defenderId, winnerId, opts, store) {
  if (!attackerId || !defenderId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const state = store.load();
  const wars = Array.isArray(state.wars) ? state.wars : [];
  const war = wars.find(
    (w) => w && w.active && w.attackerId === attackerId && w.defenderId === defenderId
  );
  if (!war) return { ok: false, reason: "not-at-war" };

  const score = scoreFor(war);
  let winner = winnerId ?? null;
  let whitePeace = false;
  if (!winner) {
    const margin = Math.abs(score.attacker - score.defender);
    if (margin < WAR_RESOLUTION_CONFIG.WHITE_PEACE_MARGIN) {
      whitePeace = true;
    } else {
      winner = score.attacker > score.defender ? war.attackerId : war.defenderId;
    }
  }
  const loser = winner
    ? winner === war.attackerId
      ? war.defenderId
      : war.attackerId
    : null;

  let applied = { reparations: 0, vassalized: false, goal: war.goal ?? null };
  let outcome;
  if (whitePeace) {
    // Both treasuries bleed a little into the mud — war is costly even
    // when nobody wins it.
    let drained = 0;
    for (const id of [war.attackerId, war.defenderId]) {
      const k = state.kingdoms?.[id];
      if (k && (k.treasury ?? 0) > 0) {
        const loss = Math.floor(k.treasury * WAR_RESOLUTION_CONFIG.WHITE_PEACE_DRAIN_PCT);
        k.treasury -= loss;
        drained += loss;
      }
    }
    applied.drained = drained;
    outcome = "white peace — the crowns count their dead and call it even";
    setTensionPair(war.attackerId, war.defenderId, WAR_RESOLUTION_CONFIG.WHITE_PEACE_TENSION, state);
  } else {
    applied = applyConsequences(war, winner, loser, opts ?? {}, state);
    outcome = outcomeText(war, winner, loser, opts ?? {}, state);
    setTensionPair(war.attackerId, war.defenderId, WAR_RESOLUTION_CONFIG.CONQUEST_TENSION, state);
  }

  liftSiegesBetween(war.attackerId, war.defenderId, state);
  clearPeaceOffersBetween(war.attackerId, war.defenderId, state);

  war.active = false;
  war.outcome = outcome;
  war.endedAt = Date.now();
  war.resolution = {
    winnerId: winner,
    loserId: loser,
    reason: opts?.reason ?? (whitePeace ? "white-peace" : "resolution"),
    surrender: !!opts?.surrender,
    reparations: applied.reparations ?? 0,
    vassalized: !!applied.vassalized,
    score,
  };
  store.save();
  resetGarrisons(war.attackerId, war.defenderId);
  emitWarEnded(war.attackerId, war.defenderId, outcome);
  announceToRealm(
    whitePeace
      ? `[Realm] Peace between ${nameOf(state, war.attackerId)} and ${nameOf(state, war.defenderId)}: ${outcome}. The rebuilding begins.`
      : `[Realm] The war is over: ${outcome}. ${nameOf(state, winner)} takes ${applied.reparations} coins in reparations${applied.vassalized ? `, and ${nameOf(state, loser)} swears fealty` : ""}.`
  );
  console.info("[war-resolution] war ended", {
    attackerId: war.attackerId,
    defenderId: war.defenderId,
    winnerId: winner,
    reason: war.resolution.reason,
    reparations: applied.reparations ?? 0,
  });
  return { ok: true, outcome, winnerId: winner, loserId: loser, applied, war };
}

/**
 * Surrender: a belligerent lays down its arms. The other side wins and
 * the war's goal consequences apply, at surrender-grade reparations.
 * The price of surrender is in the terms, not an influence fee.
 */
function surrender(player, kingdomId, targetKingdomId, store) {
  if (!player || !kingdomId || !targetKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  const state = store.load();
  const war = Wars.activeWarBetween(kingdomId, targetKingdomId, store);
  if (!war) return { ok: false, reason: "not-at-war" };
  return resolveWar(war.attackerId, war.defenderId, targetKingdomId, {
    reason: "surrender",
    surrender: true,
  }, store);
}

// ---------------------------------------------------------------------------
// Event feeders: sieges and battles report into the spine here.
// ---------------------------------------------------------------------------

/**
 * A siege resolved. Feeds the war score and — for a vassalize war — ends
 * the war when the castle falls. Called from Siege.tickSiege after the
 * outcome is set, before its save.
 *
 * @param {object} siege - the resolved siege record
 * @param {object} store
 */
function onSiegeResolved(siege, store) {
  if (!siege || !store) return null;
  const atk = siege.attackerKingdomId;
  const def = siege.defenderKingdomId;
  if (!atk || !def) return null;
  const state = store.load();
  const war = Wars.activeWarBetween(atk, def, store);
  if (!war) return null; // a raid, not a war — no score to feed

  if (siege.outcome === "victory") {
    addWarScore(atk, def, atk, WAR_RESOLUTION_CONFIG.SCORE_SIEGE_VICTORY, store);
    if (war.goal === "vassalize") {
      // The goal is achieved: the oath was sworn in resolveVictory.
      // Close the war so the new vassal and overlord are not still
      // bleeding each other under an active war record.
      return resolveWar(war.attackerId, war.defenderId, atk, {
        reason: "vassalize-siege",
      }, store);
    }
  } else if (siege.outcome === "defeat") {
    addWarScore(atk, def, def, WAR_RESOLUTION_CONFIG.SCORE_SIEGE_HELD, store);
  } else {
    return null; // stalemate / lifted: the field decides nothing
  }
  return checkDecisiveWar(war.attackerId, war.defenderId, store);
}

/**
 * A field battle was won. Feeds the war score.
 * @returns the updated war record or null
 */
function onBattleWon(attackerId, defenderId, winnerKingdomId, store) {
  return addWarScore(
    attackerId,
    defenderId,
    winnerKingdomId,
    WAR_RESOLUTION_CONFIG.SCORE_BATTLE_VICTORY,
    store
  );
}

/**
 * End a war whose score margin has become decisive, if it has.
 * @returns the resolveWar result, or null when the war may continue
 */
function checkDecisiveWar(attackerId, defenderId, store) {
  const snap = warScoreBetween(attackerId, defenderId, store);
  if (!snap || !snap.leaderId) return null;
  if (snap.margin < WAR_RESOLUTION_CONFIG.DECISIVE_MARGIN) return null;
  return resolveWar(snap.war.attackerId, snap.war.defenderId, snap.leaderId, {
    reason: "decisive-score",
  }, store);
}

/** Sweep every active war for a decisive margin. Skips founding wars. */
function checkDecisiveWars(store) {
  if (!store) return [];
  const state = store.load();
  const wars = (Array.isArray(state.wars) ? state.wars : []).filter(
    (w) => w && w.active && w.declaredBy !== "founding"
  );
  const results = [];
  for (const war of wars) {
    try {
      const r = checkDecisiveWar(war.attackerId, war.defenderId, store);
      if (r) results.push(r);
    } catch (error) {
      console.warn("[war-resolution] decisive check failed", error?.message ?? error);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Attach: keep the plugin api for announcements + the war-ended event.
// ---------------------------------------------------------------------------

function attachWarResolution(api) {
  pluginApi = api;
  console.info("[war-resolution] war spine armed");
}

module.exports = attachWarResolution;
module.exports.attachWarResolution = attachWarResolution;
module.exports.WAR_RESOLUTION_CONFIG = WAR_RESOLUTION_CONFIG;
module.exports.scoreFor = scoreFor;
module.exports.addWarScore = addWarScore;
module.exports.warScoreBetween = warScoreBetween;
module.exports.applyConsequences = applyConsequences;
module.exports.resolveWar = resolveWar;
module.exports.surrender = surrender;
module.exports.onSiegeResolved = onSiegeResolved;
module.exports.onBattleWon = onBattleWon;
module.exports.checkDecisiveWar = checkDecisiveWar;
module.exports.checkDecisiveWars = checkDecisiveWars;
