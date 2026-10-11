"use strict";

/**
 * HousingApi — HTTP data layer for the web client's "My House" overlay.
 *
 * The engine already runs full player-owned houses (estate agent, rooms,
 * furniture, portals). This layer ties housing to a place and makes it
 * visible:
 *
 *   - Residence: every player has one town of residence
 *     (housing:residence) — one of the 5 capitals or 8 frontier
 *     settlements. The first town portal used becomes home; moving costs
 *     MOVE_COST real coins and the house (rooms, furniture, everything)
 *     moves with them — no rebuilding.
 *   - Door mode: visitors allowed / closed, written to the real house save.
 *   - Payload: residence, real rooms + furniture value from the house
 *     save, active room boons.
 *
 *   GET /api/housing-status?player=<username>
 *     -> { open, residence, towns, moveCost, house, boons, doorMode }
 *
 *   ...&action=open | close | move&town=<townId> | doormode&mode=0|1|2
 *
 * Attribute keys: housing:open, housing:residence, housing:housewarming,
 * housing:last-praised (kebab-case, namespaced per server/AGENTS.md).
 *
 * Retired: the 25,000-coin "capital plot" was metadata with no land
 * behind it (Jon, 2026-10-10). Holders are grandfathered: the first
 * payload build migrates housing:plot -> housing:residence using the
 * plot's kingdom as the town, then deletes the plot attribute.
 */

const { TOWNS, townById, HOUSING_RESIDENCE_ATTRIBUTE } = require("./HousingPortals");
const { HOUSING_WARMING_ATTRIBUTE } = require("./HousingPortals");
const { valueHouse, hasRoom } = require("./lib/house-value");

const HOUSING_OPEN_ATTRIBUTE = "housing:open";
const HOUSING_PLOT_ATTRIBUTE = "housing:plot"; // retired; read once for migration only
const HOUSING_PRAISED_ATTRIBUTE = "housing:last-praised";
const HOUSE_ATTRIBUTE = "construction:house";

const MOVE_COST = 5000;
const COINS_ID = 995;

function findPlayer(api, name) {
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function houseSaveOf(player) {
  try {
    return player.getAttribute(HOUSE_ATTRIBUTE) || null;
  } catch {
    return null;
  }
}

function residenceOf(player) {
  try {
    const id = player.getAttribute(HOUSING_RESIDENCE_ATTRIBUTE);
    return townById(typeof id === "string" ? id : null);
  } catch {
    return null;
  }
}

/**
 * Grandfather the retired capital plot: a holder's plot kingdom becomes
 * their town of residence, then the plot attribute is deleted. Idempotent.
 */
function migrateRetiredPlot(player) {
  let plot = null;
  try {
    const raw = player.getAttribute(HOUSING_PLOT_ATTRIBUTE);
    if (!raw) return;
    plot = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    plot = null;
  }
  try {
    player.setAttribute(HOUSING_PLOT_ATTRIBUTE, "");
  } catch {
    // best effort; a stale plot must not strand anyone
  }
  if (!plot || !plot.kingdomId) return;
  try {
    if (player.getAttribute(HOUSING_RESIDENCE_ATTRIBUTE)) return;
  } catch {
    return;
  }
  if (!townById(plot.kingdomId)) return;
  try {
    player.setAttribute(HOUSING_RESIDENCE_ATTRIBUTE, plot.kingdomId);
  } catch {
    // ignore
  }
}

/** Room boons the player's house currently grants (real rooms only). */
function boonsFor(save) {
  const boons = [];
  if (!save) return boons;
  if (hasRoom(save, "CHAPEL")) {
    boons.push({
      room: "chapel",
      skill: "Prayer",
      effect: "Your chapel blesses you: prayer points slowly restore while home.",
    });
  }
  if (hasRoom(save, "WORKSHOP")) {
    boons.push({
      room: "workshop",
      skill: "Crafting",
      effect: "Your workshop inspires you: Crafting experience while home.",
    });
  }
  if (hasRoom(save, "KITCHEN")) {
    boons.push({
      room: "kitchen",
      skill: "Cooking",
      effect: "Your kitchen sharpens you: Cooking experience while home.",
    });
  }
  return boons;
}

function buildPayload(player) {
  migrateRetiredPlot(player);
  const residence = residenceOf(player);
  const save = houseSaveOf(player);
  const owned = !!(save && save.owned !== false);
  const valuation = save ? valueHouse(save) : null;
  let doorMode = 1;
  try {
    if (save && Number.isInteger(save.doorMode)) doorMode = save.doorMode;
  } catch {
    // keep default
  }
  return {
    residence: residence ? { id: residence.id, name: residence.name } : null,
    towns: TOWNS.map((t) => ({ id: t.id, name: t.name })),
    moveCost: MOVE_COST,
    house: {
      owned,
      engineOwned: owned,
      roomCount: valuation ? valuation.roomCount : 0,
      furnitureCount: valuation ? valuation.furnitureCount : 0,
      value: valuation ? valuation.value : 0,
      tier: valuation ? valuation.tier : null,
      rooms: valuation ? valuation.rooms : [],
    },
    boons: boonsFor(save),
    doorMode,
  };
}

function moveResidence(player, townId) {
  const town = townById(townId);
  if (!town) {
    return { ok: false, error: "Unknown town." };
  }
  const current = residenceOf(player);
  if (current && current.id === town.id) {
    return { ok: false, error: `You already live in ${town.name}.` };
  }
  let coins = 0;
  try {
    coins = player.getInventory().getAmount(COINS_ID);
  } catch {
    return { ok: false, error: "Could not read your inventory." };
  }
  if (coins < MOVE_COST) {
    return {
      ok: false,
      error: `Moving residence costs ${MOVE_COST.toLocaleString("en-US")} coins.`,
    };
  }
  try {
    player.getInventory().delete(COINS_ID, MOVE_COST);
  } catch {
    return { ok: false, error: "Could not take your coins." };
  }
  try {
    player.setAttribute(HOUSING_RESIDENCE_ATTRIBUTE, town.id);
  } catch {
    // attribute write failed; coins already taken — still report the move
  }
  try {
    player.sendMessage(
      `You move your residence to ${town.name}. Your house and everything in it comes with you.`
    );
  } catch {
    // ignore
  }
  return { ok: true, town: { id: town.id, name: town.name } };
}

function setDoorMode(player, mode) {
  const m = Number(mode);
  if (![0, 1, 2].includes(m)) return { ok: false, error: "Door mode must be 0, 1 or 2." };
  const save = houseSaveOf(player);
  if (!save) return { ok: false, error: "You do not own a house yet — see the estate agent." };
  try {
    save.doorMode = m;
    player.setAttribute(HOUSE_ATTRIBUTE, save);
  } catch {
    return { ok: false, error: "Could not update your house." };
  }
  const label = ["closed to visitors", "open to visitors", "open, doors removed"][m];
  try {
    player.sendMessage(`Your house portal is now ${label}.`);
  } catch {
    // ignore
  }
  return { ok: true, doorMode: m };
}

function attach(api) {
  api.registerContentEndpoint("housing-status", (query) => {
    const player = findPlayer(api, query.get("player"));
    const action = (query.get("action") || "").trim().toLowerCase();

    if (player && action === "close") {
      try {
        player.setAttribute(HOUSING_OPEN_ATTRIBUTE, "");
      } catch {
        // ignore
      }
      return { open: false };
    }
    if (player && action === "open") {
      try {
        player.setAttribute(HOUSING_OPEN_ATTRIBUTE, "1");
      } catch {
        // ignore
      }
      return { open: true, ...buildPayload(player) };
    }
    if (!player) return { open: false };

    if (action === "move") {
      const result = moveResidence(player, (query.get("town") || "").trim());
      return { open: true, ...buildPayload(player), move: result };
    }
    if (action === "doormode") {
      const result = setDoorMode(player, query.get("mode"));
      return { open: true, ...buildPayload(player), doorModeResult: result };
    }

    let open = "";
    try {
      open = String(player.getAttribute(HOUSING_OPEN_ATTRIBUTE) || "").trim();
    } catch {
      // ignore
    }
    if (!open) return { open: false };
    return { open: true, ...buildPayload(player) };
  });
}

module.exports = attach;
module.exports.HOUSING_OPEN_ATTRIBUTE = HOUSING_OPEN_ATTRIBUTE;
module.exports.HOUSING_RESIDENCE_ATTRIBUTE = HOUSING_RESIDENCE_ATTRIBUTE;
module.exports.HOUSING_WARMING_ATTRIBUTE = HOUSING_WARMING_ATTRIBUTE;
module.exports.MOVE_COST = MOVE_COST;
// Test seams (pure logic, no engine).
module.exports._test = { residenceOf, boonsFor, buildPayload, moveResidence, setDoorMode, migrateRetiredPlot };
