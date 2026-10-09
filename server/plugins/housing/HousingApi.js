"use strict";

/**
 * HousingApi — HTTP data layer for the web client's "My House" overlay.
 *
 * The engine already runs full player-owned houses (estate agent, rooms,
 * furniture, portals). This layer ties housing to the kingdom system and
 * makes it visible:
 *
 *   - Plot claim: a player with a kingdom claims a housing plot in their
 *     kingdom's capital for 25,000 real coins. The plot unlocks room boons
 *     and citizen visitors; the engine house stays the physical building.
 *   - Door mode: visitors allowed / closed, written to the real house save.
 *   - Payload: plot status, real rooms + furniture value from the house
 *     save, active room boons.
 *
 *   GET /api/housing-status?player=<username>
 *     -> { open, plot, house, boons, doorMode }
 *
 *   ...&action=open | close | claim | doormode&mode=0|1|2
 *
 * Attribute keys: housing:open, housing:plot, housing:housewarming,
 * housing:last-praised (kebab-case, namespaced per server/AGENTS.md).
 */

const Store = require("../kingdoms/KingdomStore");
const { valueHouse, hasRoom } = require("./lib/house-value");

const HOUSING_OPEN_ATTRIBUTE = "housing:open";
const HOUSING_PLOT_ATTRIBUTE = "housing:plot";
const HOUSING_WARMING_ATTRIBUTE = "housing:housewarming";
const HOUSE_ATTRIBUTE = "construction:house";

const PLOT_COST = 25000;
const COINS_ID = 995;

function findPlayer(api, name) {
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function kingdomIdOf(player) {
  try {
    return player.getAttribute("kingdom:id") || null;
  } catch {
    return null;
  }
}

function kingdomName(id) {
  try {
    const k = Store.getKingdom(id);
    return k ? k.name : String(id);
  } catch {
    return String(id);
  }
}

function houseSaveOf(player) {
  try {
    return player.getAttribute(HOUSE_ATTRIBUTE) || null;
  } catch {
    return null;
  }
}

function plotOf(player) {
  try {
    const raw = player.getAttribute(HOUSING_PLOT_ATTRIBUTE);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
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
  const plot = plotOf(player);
  const save = houseSaveOf(player);
  const owned = !!(save && save.owned !== false && plot);
  const valuation = save ? valueHouse(save) : null;
  let doorMode = 1;
  try {
    if (save && Number.isInteger(save.doorMode)) doorMode = save.doorMode;
  } catch {
    // keep default
  }
  return {
    plot,
    plotCost: PLOT_COST,
    playerKingdom: (() => {
      const id = kingdomIdOf(player);
      return id ? { id, name: kingdomName(id) } : null;
    })(),
    house: {
      owned,
      engineOwned: !!(save && save.owned !== false),
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

function claimPlot(player) {
  const kingdomId = kingdomIdOf(player);
  if (!kingdomId) {
    return { ok: false, error: "You must belong to a kingdom to claim a housing plot." };
  }
  if (plotOf(player)) {
    return { ok: false, error: "You already own a housing plot." };
  }
  let coins = 0;
  try {
    coins = player.getInventory().getAmount(COINS_ID);
  } catch {
    return { ok: false, error: "Could not read your inventory." };
  }
  if (coins < PLOT_COST) {
    return {
      ok: false,
      error: `A housing plot costs ${PLOT_COST.toLocaleString("en-US")} coins.`,
    };
  }
  try {
    player.getInventory().delete(COINS_ID, PLOT_COST);
  } catch {
    return { ok: false, error: "Could not take your coins." };
  }
  const plot = { kingdomId, kingdomName: kingdomName(kingdomId), claimedAt: Date.now() };
  try {
    player.setAttribute(HOUSING_PLOT_ATTRIBUTE, JSON.stringify(plot));
    // Housewarming: the visitor tick picks this up and has capital
    // citizens congratulate the player.
    player.setAttribute(HOUSING_WARMING_ATTRIBUTE, "1");
  } catch {
    // attribute write failed; coins already taken — still report plot
  }
  try {
    player.sendMessage(
      `You claim a housing plot in ${plot.kingdomName}. Your house is now tied to the realm.`
    );
  } catch {
    // ignore
  }
  return { ok: true, plot };
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

    if (action === "claim") {
      const result = claimPlot(player);
      return { open: true, ...buildPayload(player), claim: result };
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
module.exports.HOUSING_PLOT_ATTRIBUTE = HOUSING_PLOT_ATTRIBUTE;
module.exports.HOUSING_WARMING_ATTRIBUTE = HOUSING_WARMING_ATTRIBUTE;
module.exports.PLOT_COST = PLOT_COST;
// Test seams (pure logic, no engine).
module.exports._test = { plotOf, boonsFor, buildPayload, claimPlot, setDoorMode };
