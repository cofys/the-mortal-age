"use strict";

/**
 * Espionage — kept simple and honest (Jon's diplomacy design, 2026-10-11).
 *
 * Two things only:
 *   1. Real intel. The war table can show what spies would actually
 *      learn: the enemy's garrison strength, supply morale, militia
 *      headcount, and fort tier. Every number is read from the system
 *      that owns it (Tension, WarSupply, Militia, Castle state) — no
 *      estimates, no invented scouting reports.
 *   2. Sabotage. A mission (wired through the kingdom job board) that
 *      burns real war stock via WarSupply.sabotageStock. Getting caught
 *      is a real event with real teeth: the saboteur takes war-treason
 *      hatred in the victim's court (the hatred API's "war-treason"
 *      reason, wired here for the first time) and the pair's goodwill
 *      chills.
 *
 * The citizen side (CitizenEspionage's intel advantage for musters)
 * stays as it is — this module is the player/diplomacy face.
 */

const Influence = require("./Influence.Kingdoms");
const Relations = require("./Relations.Kingdoms");
const WarSupply = require("./WarSupply.Kingdoms");

const ESPIONAGE_CONFIG = Object.freeze({
  /** War-stock units a successful sabotage burns (fullest category). */
  SABOTAGE_UNITS: 25,
  /** Chance a sabotage is detected (the saboteur is named). */
  DETECTION_CHANCE: 0.35,
  /** Hatred applied to a caught saboteur in the victim's court. */
  TREASON_HATRED: -25,
});

/**
 * What the spies report about another kingdom, from real state.
 * @returns {{ garrison: number, morale: number, militia: number, fortTier: number } | null}
 */
function intelOn(kingdomId, targetKingdomId, store) {
  if (!kingdomId || !targetKingdomId || !store) return null;
  let garrison = 0;
  try {
    garrison = require("./Tension.Kingdoms").garrisonOf(targetKingdomId) ?? 0;
  } catch {
    garrison = 0;
  }
  let militia = 0;
  try {
    militia = require("./Militia.Kingdoms").militiaCount(targetKingdomId) ?? 0;
  } catch {
    militia = 0;
  }
  const state = store.load();
  const warKey = WarSupply.warKeyFor(kingdomId, targetKingdomId);
  return {
    garrison,
    morale: Math.round(WarSupply.moraleOf(targetKingdomId, warKey, store) * 100) / 100,
    militia,
    fortTier: state.castles?.[targetKingdomId]?.fortTier ?? 0,
  };
}

/**
 * Intel for every kingdom the viewer's crown is at war with, or stands
 * tense/hostile toward. Allies' and friends' books stay closed.
 * @returns {{ [kingdomId]: intel }} keyed by target kingdom
 */
function intelFor(kingdomId, store) {
  if (!kingdomId || !store) return {};
  const state = store.load();
  const out = {};
  for (const k of Object.values(state.kingdoms ?? {})) {
    const targetId = k?.id;
    if (!targetId || targetId === kingdomId) continue;
    const rel = Relations.relationOf(kingdomId, targetId, store);
    if (
      rel === Relations.RELATION_AT_WAR ||
      rel === Relations.RELATION_HOSTILE ||
      rel === Relations.RELATION_TENSE
    ) {
      out[targetId] = intelOn(kingdomId, targetId, store);
    }
  }
  return out;
}

/**
 * Burn an enemy's war stock. The actor must be at war with the target
 * or stand hostile/tense toward it — you cannot sabotage a friend.
 *
 * @param {object|null} actorPlayer - the saboteur (null for citizen actors)
 * @param {string} actorKingdomId
 * @param {string} targetKingdomId
 * @param {object} store
 * @param {function} [rng] - injectable for tests
 * @returns {{ ok: boolean, reason?: string, caught?: boolean, category?: string, removed?: number }}
 */
function sabotage(actorPlayer, actorKingdomId, targetKingdomId, store, rng = Math.random) {
  if (!actorKingdomId || !targetKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  if (actorKingdomId === targetKingdomId) {
    return { ok: false, reason: "cannot-target-self" };
  }
  const rel = Relations.relationOf(actorKingdomId, targetKingdomId, store);
  if (
    rel !== Relations.RELATION_AT_WAR &&
    rel !== Relations.RELATION_HOSTILE &&
    rel !== Relations.RELATION_TENSE
  ) {
    return { ok: false, reason: "not-an-enemy", relation: rel };
  }
  const warKey = WarSupply.warKeyFor(actorKingdomId, targetKingdomId);
  const hit = WarSupply.sabotageStock(
    targetKingdomId,
    warKey,
    ESPIONAGE_CONFIG.SABOTAGE_UNITS,
    store
  );
  if (!hit) return { ok: false, reason: "no-war-stock" };

  const caught = rng() < ESPIONAGE_CONFIG.DETECTION_CHANCE;
  if (caught) {
    // The crime is named: the pair's goodwill chills, and a player
    // saboteur carries war-treason hatred in the victim's court.
    Relations.addGoodwill(actorKingdomId, targetKingdomId, Relations.GOODWILL_CRIME, store);
    store.save();
    if (actorPlayer) {
      try {
        Influence.addInfluence(
          actorPlayer,
          targetKingdomId,
          ESPIONAGE_CONFIG.TREASON_HATRED,
          "war-treason"
        );
      } catch {
        // Hatred is the consequence, not the mission — never fail on it.
      }
      // A caught saboteur is wanted: the victim's court posts a bounty
      // on the job board (Bounties module, funded from its treasury).
      try {
        const username = actorPlayer.getUsername?.() ?? actorPlayer.username;
        if (username) {
          require("./Bounties.Kingdoms").markWanted(
            username,
            targetKingdomId,
            "sabotage",
            store
          );
        }
      } catch {
        // Bounty board unavailable: hatred above still stands.
      }
    }
  }
  return { ok: true, caught, category: hit.category, removed: hit.removed };
}

function attachEspionage(api) {
  // No tasks or hooks of its own: intel is read on demand by the war
  // table, and sabotage is invoked by the job board.
  console.info("[espionage] intel + sabotage armed");
}

module.exports = attachEspionage;
module.exports.attachEspionage = attachEspionage;
module.exports.ESPIONAGE_CONFIG = ESPIONAGE_CONFIG;
module.exports.intelOn = intelOn;
module.exports.intelFor = intelFor;
module.exports.sabotage = sabotage;
