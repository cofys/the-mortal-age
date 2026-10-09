"use strict";

/**
 * HousingVisitors — citizen visitor commentary tick.
 *
 * Citizens can't physically enter a player's private house instance, so
 * visits happen where the town can see them: the kingdom capital. Every
 * ~2 minutes:
 *
 *   - Housewarming: a player who just claimed a plot (housing:housewarming
 *     flag) gets congratulated by a citizen in their kingdom's capital.
 *   - Admiration: a player with a plot and a house worth 100k+ (tier House
 *     or better) gets admired once per 6 hours — citizens gossip about the
 *     showpiece room, scaled by house tier.
 *
 * Lines go through sayPublic + citizenVoice so they sound like the
 * citizen's personality, not a broadcast. All data is real: the plot, the
 * house value (from the real house save), the citizen's location.
 *
 * No LLM in the tick path — pools are scripted, personality-scaled.
 */

let Task = null;
try {
  ({ Task } = require("../../src/main/typescript/elvarg/game/task/Task"));
} catch {
  // plain-node test env: start() no-ops without Task
}
const { valueHouse, showpieceRoom } = require("./lib/house-value");
const { sayPublic } = require("../citizens/chat/CitizenSayPublic");
const { voiceFor, voiceLine } = require("../citizens/lib/citizenVoice");
const { ATTR_CITIZEN_PERSONALITY } = require("../citizens/constants");

const HOUSING_PLOT_ATTRIBUTE = "housing:plot";
const HOUSING_WARMING_ATTRIBUTE = "housing:housewarming";
const HOUSING_PRAISED_ATTRIBUTE = "housing:last-praised";
const HOUSE_ATTRIBUTE = "construction:house";

// ~2 minutes at 600ms/tick.
const VISITOR_TICK_TICKS = 200;
// Admiration threshold: tier "House" (100k) and up.
const ADMIRE_MIN_VALUE = 100000;
// One admiration per player per 6 hours.
const ADMIRE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Citizen must be within this many tiles of the capital center.
const CAPITAL_RADIUS = 45;

// Capital centers (OSRS map coords, documented approximations).
const CAPITALS = Object.freeze({
  asgarnia: { x: 2966, y: 3381 }, // Falador
  misthalin: { x: 3210, y: 3424 }, // Varrock
  kandarin: { x: 2662, y: 3305 }, // East Ardougne
  morytania: { x: 3499, y: 3480 }, // Canifis
  keldagrim: { x: 2860, y: 10180 }, // Keldagrim
});

const WARMING_LINES = Object.freeze([
  "heard {name} claimed a housing plot! housewarming soon?",
  "welcome to the neighbourhood, {name}!",
  "{name} got a plot! wonder what they will build",
  "another new homeowner in the capital, gz {name}",
]);

const ADMIRE_LINES = Object.freeze([
  "have you seen {name}'s {room}? absolutely stunning",
  "{name}'s {room} is the talk of the capital",
  "i walked past {name}'s place yesterday... that {room}!",
  "if you have not seen {name}'s {room}, you are missing out",
]);

const ADMIRE_GRAND_LINES = Object.freeze([
  "they say {name}'s {room} rivals the palace itself",
  "{name}'s house is a {tier}... i have never seen anything like that {room}",
]);

function isRealPlayer(p) {
  try {
    return !!p && p.isPlayer?.() === true && p.isPlayerBot?.() !== true;
  } catch {
    return false;
  }
}

function isCitizen(p) {
  try {
    return !!p && p.isPlayerBot?.() === true;
  } catch {
    return false;
  }
}

function locationOf(p) {
  try {
    const l = p.getLocation?.();
    return l ? { x: l.getX(), y: l.getY() } : null;
  } catch {
    return null;
  }
}

function dist(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function plotOf(player) {
  try {
    const raw = player.getAttribute?.(HOUSING_PLOT_ATTRIBUTE);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function playerName(p) {
  try {
    return p.getUsername?.() ?? "someone";
  } catch {
    return "someone";
  }
}

function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Citizens (bots) currently near the capital center. */
function citizensNear(players, capitalId) {
  const center = CAPITALS[capitalId];
  if (!center) return [];
  const out = [];
  players.forEach((p) => {
    try {
      if (!isCitizen(p)) return;
      const loc = locationOf(p);
      if (!loc || dist(loc, center) > CAPITAL_RADIUS) return;
      out.push(p);
    } catch {
      // per-citizen isolation
    }
  });
  return out;
}

function citizenSay(citizen, template, vars) {
  let text = template;
  for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
  let personality = {};
  try {
    personality = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    // default voice
  }
  const voice = voiceFor(personality);
  // voiceLine scales the phrasing by personality; fall back to raw text.
  let line = text;
  try {
    line = voiceLine(voice, { plain: [text] }, Math.random) || text;
  } catch {
    // keep raw
  }
  sayPublic(citizen, line);
}

function roomDisplayName(roomKey) {
  const names = {
    CHAPEL: "chapel",
    WORKSHOP: "workshop",
    KITCHEN: "kitchen",
    PARLOUR: "parlour",
    THRONE_ROOM: "throne room",
    PORTAL_NEXUS: "portal nexus",
    MENAGERIE_OUTDOORS: "menagerie",
    SUPERIOR_GARDEN: "garden",
    TREASURE_ROOM: "treasure room",
    STUDY: "study",
    BEDROOM: "bedroom",
    DINING_ROOM: "dining room",
  };
  return names[roomKey] || String(roomKey).toLowerCase().replace(/_/g, " ");
}

function tickHousingVisitors(api) {
  let world = null;
  try {
    world = api.core?.World;
  } catch {
    return;
  }
  const players = world?.players;
  if (!players || typeof players.forEach !== "function") return;

  players.forEach((p) => {
    try {
      if (!isRealPlayer(p)) return;
      const plot = plotOf(p);
      if (!plot || !plot.kingdomId) return;
      const capitalId = plot.kingdomId;
      const nearby = citizensNear(players, capitalId);
      if (!nearby.length) return;
      const citizen = pick(nearby);
      const name = playerName(p);

      // Housewarming takes priority, once.
      let warming = "";
      try {
        warming = p.getAttribute?.(HOUSING_WARMING_ATTRIBUTE) || "";
      } catch {
        // ignore
      }
      if (warming) {
        citizenSay(citizen, pick(WARMING_LINES), { name });
        try {
          p.setAttribute(HOUSING_WARMING_ATTRIBUTE, "");
        } catch {
          // ignore
        }
        return;
      }

      // Admiration: valuable house, off cooldown.
      let save = null;
      try {
        save = p.getAttribute?.(HOUSE_ATTRIBUTE) || null;
      } catch {
        // ignore
      }
      if (!save) return;
      const valuation = valueHouse(save);
      if (valuation.value < ADMIRE_MIN_VALUE) return;
      let lastPraised = 0;
      try {
        lastPraised = Number(p.getAttribute?.(HOUSING_PRAISED_ATTRIBUTE) || 0);
      } catch {
        // ignore
      }
      if (Date.now() - lastPraised < ADMIRE_COOLDOWN_MS) return;
      const showpiece = showpieceRoom(save);
      if (!showpiece) return;
      const room = roomDisplayName(showpiece);
      const tier = valuation.tier.name.toLowerCase();
      const grand = valuation.value >= 500000;
      citizenSay(citizen, pick(grand ? ADMIRE_GRAND_LINES : ADMIRE_LINES), {
        name,
        room,
        tier,
      });
      try {
        p.setAttribute(HOUSING_PRAISED_ATTRIBUTE, String(Date.now()));
      } catch {
        // ignore
      }
    } catch {
      // per-player isolation
    }
  });
}

function start(api) {
  try {
    if (!Task) return;
    const tm = api.getTaskManager?.();
    if (!tm) return;
    const taskApi = api;
    class HousingVisitorTask extends Task {
      execute() {
        try {
          tickHousingVisitors(taskApi);
        } catch {
          // Never kill the task on a bad tick.
        }
      }
    }
    tm.submit(new HousingVisitorTask(VISITOR_TICK_TICKS));
  } catch {
    // TaskManager unavailable (tests).
  }
}

module.exports = { start, tickHousingVisitors };
module.exports._test = {
  isRealPlayer,
  isCitizen,
  citizensNear,
  roomDisplayName,
  plotOf,
  CAPITALS,
  VISITOR_TICK_TICKS,
  ADMIRE_MIN_VALUE,
  ADMIRE_COOLDOWN_MS,
};
