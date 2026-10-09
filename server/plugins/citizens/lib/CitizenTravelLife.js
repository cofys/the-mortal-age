"use strict";

/**
 * CitizenTravelLife — director tick dynamics for citizen travel.
 * Data tier, zero LLM.
 *
 * Each slow tick:
 *  1. Arrivals: journeys whose arrivesAt passed are completed —
 *     the traveler's roster kingdomId changes to the destination
 *     (the director's spawn logic puts them in the new kingdom's
 *     market; online travelers are teleported by the brain action).
 *  2. Danger: bandit and monster rolls on arrival — bandits take
 *     real coins, monsters deal real damage. Journaled.
 *  3. Cargo: peddler manifests sell at their margin on arrival —
 *     real coins to the traveler's inventory.
 *  4. Announcements: notable arrivals (long journeys, bandit
 *     survivors) are said via sayPublic where real players can hear.
 *  5. Stale cleanup: journeys for citizens who died or vanished
 *     are cleared.
 *
 * Wiring: CitizenDirector calls tickTravel(this, nowMs) in the slow tick
 * inside try/catch. CitizenTravel.save() goes in the save section.
 */

const Travel = require("./CitizenTravel");
const { agentRng } = require("./humanizer");
const { normalizeName } = require("./CitizenBonds");
const { ATTR_KINGDOM_ID } = require("../constants");

function journalEvent(citizenName, text, kind) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(citizenName, text, kind || "travel");
  } catch {
    // best-effort
  }
}

function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const player =
      director?.getPlayer?.(username) ?? director?.players?.get?.(username);
    if (player) sayPublic(player, text);
  } catch {
    // best-effort
  }
}

/** Roster records as an array. Defensive across director shapes. */
function rosterRecords(director) {
  try {
    const roster = director?.roster;
    if (!roster) return [];
    if (Array.isArray(roster)) return roster;
    if (typeof roster.values === "function") return [...roster.values()];
    if (typeof roster === "object") return Object.values(roster);
    return [];
  } catch {
    return [];
  }
}

/** Find a roster record by username. */
function recordFor(director, username) {
  const uname = normalizeName(username);
  return rosterRecords(director).find((r) => normalizeName(r?.username) === uname) ?? null;
}

/**
 * Complete an arrival: move the citizen to the destination kingdom,
 * roll danger, sell cargo, journal, and clear the journey.
 */
function processArrival(director, journey, nowMs) {
  const uname = journey.username;
  const record = recordFor(director, uname);
  const rng = agentRng(`travel:${uname}:${journey.arrivesAt}`);

  // Move the citizen: the roster record's kingdomId is the source of
  // truth the director syncs to the bot's attributes. Online travelers
  // also get teleported by the brain action; the record change covers
  // offline travelers and respawns.
  if (record) {
    record.kingdomId = journey.to;
  }

  // Danger rolls.
  const danger = Travel.rollDanger(journey, rng);
  let coinsLost = 0;
  let damage = 0;

  const player =
    director?.getPlayer?.(uname) ?? director?.players?.get?.(uname) ?? null;

  if (danger.bandit) {
    if (player) {
      const carried = Travel.countCoins(player);
      coinsLost = Math.round(carried * danger.coinsLost);
      if (coinsLost > 0) Travel.removeCoins(player, coinsLost);
    }
    journalEvent(
      uname,
      `was robbed by bandits on the road to ${Travel.kingdomName(journey.to)}` +
        (coinsLost > 0 ? `, losing ${coinsLost} coins` : "") +
        ".",
      "travel"
    );
  }

  if (danger.monster) {
    damage = danger.damage;
    if (player) {
      try {
        const cur = player.getSkills?.()?.getLevel?.(3) ?? 0; // HP skill
        void cur;
        // Apply damage through the engine's hit path when available.
        if (typeof player.hit === "function") {
          player.hit(damage);
        } else if (typeof player.damage === "function") {
          player.damage(damage);
        }
      } catch {
        // best-effort
      }
    }
    journalEvent(
      uname,
      `was attacked by monsters on the way to ${Travel.kingdomName(journey.to)}` +
        `, taking ${damage} damage.`,
      "travel"
    );
  }

  // Cargo: peddler goods sell at margin on arrival.
  let cargoProfit = 0;
  if (journey.cargo) {
    cargoProfit = Travel.cargoValue(journey.cargo);
    if (cargoProfit > 0 && player) {
      Travel.addCoins(player, cargoProfit);
    }
    journalEvent(
      uname,
      `sold travel goods in ${Travel.kingdomName(journey.to)} for ${cargoProfit} coins.`,
      "travel"
    );
  }

  // Arrival announcement — a real event real players can react to.
  const arrivalLine =
    `${displayName(uname)} arrived in ${Travel.kingdomName(journey.to)}` +
    ` by ${journey.mode === "ship" ? "ship" : "caravan"}` +
    (danger.bandit ? ", shaken by a bandit attack on the road" : "") +
    (cargoProfit > 0 ? ` with goods to sell (${cargoProfit} coins)` : "") +
    ".";
  sayPublicTo(director, uname, arrivalLine);
  journalEvent(uname, `arrived in ${Travel.kingdomName(journey.to)} by ${journey.mode}.`, "travel");

  Travel.clearJourney(uname);
  return { uname, to: journey.to, coinsLost, damage, cargoProfit, danger };
}

function displayName(username) {
  const s = String(username ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The slow-tick entry point. Processes due arrivals and clears stale
 * journeys. Never throws — the director wraps in try/catch anyway.
 */
function tickTravel(director, nowMs) {
  const now = nowMs ?? Date.now();
  const results = [];

  for (const journey of Travel.dueArrivals(now)) {
    try {
      results.push(processArrival(director, journey, now));
    } catch {
      // A broken arrival must not strand the journey — clear it.
      try {
        Travel.clearJourney(journey?.username);
      } catch {
        // ignore
      }
    }
  }

  // Stale cleanup: journeys for citizens no longer on the roster.
  try {
    for (const journey of Travel.allJourneys()) {
      if (!recordFor(director, journey?.username)) {
        Travel.clearJourney(journey.username);
      }
    }
  } catch {
    // best-effort
  }

  return results;
}

module.exports = {
  tickTravel,
  processArrival,
  displayName,
};
