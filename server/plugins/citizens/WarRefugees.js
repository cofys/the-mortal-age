"use strict";

/**
 * WarRefugees — war's losers, on foot.
 *
 * kingdom:war-declared: 3-5 commoners of the DEFENDING kingdom spawn at its
 * border towns and flee along the roads toward the capital, walking a
 * refugee_flight brain route (border -> road -> market). They spawn starving
 * and frightened — empty purses, hollow needs — speak witness lines overhead,
 * and their flight is reported through the rumor system so the streets
 * repeat what they saw.
 *
 * kingdom:war-ended: the running stops. Roster records are dropped and the
 * bots logged out; a rumor notes them walking home.
 *
 * The flight is always news, even with the director idle (CITIZENS_ENABLED=0):
 * the rumors go out regardless; only the bodies need the director.
 */

const { getDirector } = require("./director/CitizenDirector");
const { siteTileByKingdom } = require("./brain/CitizenSites");
const { needsFor, addMood } = require("./brain/CitizenNeeds");
const { noisyTile, agentRng } = require("./lib/humanizer");
const {
  ROLE_REFUGEE,
  ATTR_REFUGEE_ROUTE,
  ATTR_REFUGEE_WAR,
} = require("./constants");
const KingdomStore = require("../kingdoms/KingdomStore");
const { borderTileFor, pairKey } = require("../kingdoms/WarConsequences.Kingdoms");
const { getJournal } = require("./lib/CitizenJournal");

let pluginApi = null;
// warKey -> [{ username, record }] — the living, for cleanup at peace.
const columns = new Map();

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function nameOf(kingdomId) {
  return KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
}

const FLIGHT_CRIES = [
  "They burned the border villages! Run!",
  "The levy's broken! Flee!",
  "Don't stand there — RUN!",
  "To the walls! To the walls!",
];

/** Waypoints: border town -> road -> the safe city, straight-ish legs. */
function buildRoute(from, to) {
  const legs = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    legs.push({
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
      z: 0,
    });
  }
  return legs;
}

/** The flight is news in both courts, whatever the director is doing. */
function emitFlightRumors(attackerId, defenderId) {
  const aName = nameOf(attackerId);
  const dName = nameOf(defenderId);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: defenderId,
    text: `They say refugees from the ${dName} border villages reached the capital — hungry, hollow-eyed, speaking of fire.`,
  });
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId: attackerId,
    text: `They say the ${dName} border villages empty before the ${aName} levies — the roads choke with the fleeing.`,
  });
}

function spawnColumn(attackerId, defenderId) {
  const director = getDirector();
  if (!director) return;
  const border = borderTileFor(attackerId, defenderId);
  const market = siteTileByKingdom(defenderId, "market");
  if (!border || !market) return;
  const warKey = pairKey(attackerId, defenderId);
  const count = 3 + Math.floor(Math.random() * 3);
  const fled = [];
  for (let i = 0; i < count; i++) {
    try {
      const record = director.addCitizen(defenderId, ROLE_REFUGEE);
      // Start at the border town, scattered so they don't stack.
      const start = noisyTile(border.x, border.y, 4, agentRng(`refugee:${record.username}`));
      record.home = { x: start.x, y: start.y, z: border.z ?? 0 };
      const route = buildRoute(record.home, market);
      if (!director.spawnCitizen(record)) continue;
      const bot = director.getBot(record);
      if (!bot) continue;
      bot.setAttribute?.(ATTR_REFUGEE_ROUTE, route);
      bot.setAttribute?.(ATTR_REFUGEE_WAR, warKey);
      // Hungry and scared: starving, broke, frightened. The director's
      // feeding pass finds no coins, so they stay visibly hungry.
      const needs = needsFor(record.username);
      if (needs) {
        needs.hunger = 5 + Math.random() * 15;
        needs.energy = 40 + Math.random() * 20;
      }
      addMood(bot, -30);
      // Journal what they saw — the LLM speaks truthfully when asked later.
      try {
        getJournal().log(
          record.username,
          "traveled",
          `Fled the ${nameOf(defenderId)} border villages as ${nameOf(attackerId)} marched. Saw smoke on the horizon.`
        );
      } catch {
        // Non-fatal.
      }
      try {
        bot.forceChat?.(pick(FLIGHT_CRIES).slice(0, 120));
      } catch {
        // The flight speaks for itself.
      }
      fled.push({ username: record.username, record });
    } catch (error) {
      console.warn("[war-refugees] spawn failed", error?.message ?? error);
    }
  }
  if (fled.length > 0) {
    columns.set(warKey, fled);
    pluginApi.log?.("[war-refugees] column fled", { war: warKey, fled: fled.length });
  }
}

/** kingdom:war-declared — the losing side's border towns empty. */
function onWarDeclared(event) {
  const attackerId = event?.attackerId;
  const defenderId = event?.defenderId;
  if (!attackerId || !defenderId) return;
  try {
    emitFlightRumors(attackerId, defenderId);
    spawnColumn(attackerId, defenderId);
  } catch (error) {
    console.warn("[war-refugees] declaration failed", error?.message ?? error);
  }
}

/** kingdom:war-ended — the running stops; they walk home. */
function onWarEnded(event) {
  const attackerId = event?.attackerId;
  const defenderId = event?.defenderId;
  if (!attackerId || !defenderId) return;
  const warKey = pairKey(attackerId, defenderId);
  const fled = columns.get(warKey) ?? [];
  columns.delete(warKey);
  if (fled.length === 0) return;
  const director = getDirector();
  for (const { username, record } of fled) {
    try {
      if (director) {
        director.removeCitizen(record);
      }
    } catch {
      // One stranded refugee doesn't stop the peace.
    }
  }
  pluginApi.log?.("[war-refugees] column stood down", { war: warKey });
  try {
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: defenderId,
      text: `They say the refugees are walking home — what home the war left them.`,
    });
  } catch {
    // Peace needs no herald.
  }
}

function attachWarRefugees(api) {
  pluginApi = api;
  api.onCustomEvent("kingdom:war-declared", onWarDeclared);
  api.onCustomEvent("kingdom:war-ended", onWarEnded);
}

module.exports = attachWarRefugees;
module.exports.attachWarRefugees = attachWarRefugees;
module.exports.onWarDeclared = onWarDeclared;
module.exports.onWarEnded = onWarEnded;
