"use strict";

/**
 * HousingPortals — one POH portal in every town and city.
 *
 * Design (Jon, 2026-10-10): no city-building, no visible plots. Each of the
 * 5 great-power capitals and 8 frontier settlements gets a real cache
 * "Portal" object (4150, Use) on its square. Clicking a town portal takes
 * the player into their OWN engine house through the real house-tablet
 * entry path: the `construction:house-tablet` custom event (option
 * "inside") computes the destination and arrival, then TeleportHandler
 * runs it — exactly what breaking a house tablet does.
 *
 * Residence: every player has one town of residence
 * (housing:residence). The first portal they use becomes home — that is
 * first placement (the walk to a town and the click is the choice). Moving
 * residence is handled by the housing panel (HousingApi action=move),
 * not here; the house and everything in it moves with them.
 *
 * Follows the DiegeticObjects pattern: spawn on startup, one global
 * onObjectInteraction("Portal", { Use }) hook gated by (objectId,
 * location), so every other "Portal" object in the game is untouched.
 * Returning false from the handler lets other Portal/Use handlers run.
 */

const HOUSING_RESIDENCE_ATTRIBUTE = "housing:residence";
const HOUSING_WARMING_ATTRIBUTE = "housing:housewarming";

const PORTAL_OBJECT_ID = 4150; // Portal (cache interactions: ["Use", ...])
const PORTAL_SHAPE = 10; // scenery

// Canonical town list. Capitals sit on the same squares as the other
// diegetic objects; settlements on their citizen square. The portal tile
// is offset a few tiles so it never sits on a spawn tile.
const TOWNS = Object.freeze([
  { id: "asgarnia", name: "Falador", kind: "capital", x: 2968, y: 3380, z: 0 },
  { id: "misthalin", name: "Varrock", kind: "capital", x: 3169, y: 3487, z: 0 },
  { id: "kandarin", name: "East Ardougne", kind: "capital", x: 2664, y: 3292, z: 0 },
  { id: "morytania", name: "Canifis", kind: "capital", x: 3499, y: 3237, z: 0 },
  { id: "keldagrim", name: "Keldagrim", kind: "capital", x: 2859, y: 10202, z: 0 },
  { id: "alkharid", name: "Al Kharid", kind: "settlement", x: 3286, y: 3164, z: 0 },
  { id: "brimhaven", name: "Brimhaven", kind: "settlement", x: 2756, y: 3174, z: 0 },
  { id: "lletya", name: "Lletya", kind: "settlement", x: 2342, y: 3140, z: 0 },
  { id: "nardah", name: "Nardah", kind: "settlement", x: 3422, y: 2920, z: 0 },
  { id: "pollnivneach", name: "Pollnivneach", kind: "settlement", x: 3336, y: 2998, z: 0 },
  { id: "rellekka", name: "Rellekka", kind: "settlement", x: 2666, y: 3626, z: 0 },
  { id: "shilo", name: "Shilo Village", kind: "settlement", x: 2852, y: 2950, z: 0 },
  { id: "sophanem", name: "Sophanem", kind: "settlement", x: 3286, y: 2784, z: 0 },
]);

const TOWN_BY_ID = new Map(TOWNS.map((t) => [t.id, t]));

function townById(id) {
  return (typeof id === "string" && TOWN_BY_ID.get(id)) || null;
}

let pluginApi = null;
let core = null;

// Spawned portals: [{ townId, townName, objectId, x, y, z }]
const spawned = [];

function spawnAll() {
  const { ObjectManager, GameObject, Location } = core || {};
  if (!ObjectManager || !GameObject || !Location) {
    console.warn("[housing-portals] missing core classes, portals not spawned");
    return;
  }
  for (const town of TOWNS) {
    try {
      const obj = new GameObject(
        PORTAL_OBJECT_ID,
        new Location(town.x, town.y, town.z),
        PORTAL_SHAPE,
        0,
        null
      );
      ObjectManager.register(obj, true);
      spawned.push({
        townId: town.id,
        townName: town.name,
        objectId: PORTAL_OBJECT_ID,
        x: town.x,
        y: town.y,
        z: town.z,
      });
    } catch (error) {
      console.warn("[housing-portals] spawn failed", {
        town: town.id,
        error: error?.message,
      });
    }
  }
  console.info("[housing-portals] portals spawned", { count: spawned.length });
}

/**
 * Is this (objectId, location) one of our town portals?
 * Returns the spawn record { townId, townName, ... } or null.
 */
function matchPortal(objectId, location) {
  if (objectId !== PORTAL_OBJECT_ID) return null;
  const x = location?.x ?? location?.getX?.() ?? 0;
  const y = location?.y ?? location?.getY?.() ?? 0;
  const z = location?.z ?? location?.getZ?.() ?? 0;
  for (const s of spawned) {
    if (Math.abs(s.x - x) <= 2 && Math.abs(s.y - y) <= 2 && s.z === z) return s;
  }
  return null;
}

function residenceOf(player) {
  try {
    const id = player.getAttribute?.(HOUSING_RESIDENCE_ATTRIBUTE);
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Walk the player into their own engine house through the real entry path.
 * Returns true when the entry sequence started. When the player owns no
 * engine house, the construction plugin has already told them to see the
 * estate agent and request.destination stays null.
 */
function enterOwnHouse(api, player) {
  const request = { player, option: "inside", destination: null, onArrival: null };
  try {
    api.emitCustomEvent("construction:house-tablet", request);
  } catch {
    return false;
  }
  if (!request.destination) return false;
  const c = api?.core;
  const th = c?.TeleportHandler;
  if (!th) return false;
  try {
    if (typeof th.checkReqs === "function" && !th.checkReqs(player, request.destination)) {
      return false;
    }
    th.teleport(
      player,
      request.destination,
      c.TeleportType.TELE_TAB,
      false,
      request.onArrival ?? undefined
    );
    return true;
  } catch {
    return false;
  }
}

function onPortalUse(event) {
  const { player, objectId, location } = event ?? {};
  if (!player || player.isPlayerBot?.() === true) return false;
  let match = null;
  try {
    match = matchPortal(objectId, location);
  } catch {
    return false;
  }
  if (!match) return false;

  // First placement: the first town portal used becomes home.
  try {
    if (!residenceOf(player)) {
      player.setAttribute(HOUSING_RESIDENCE_ATTRIBUTE, match.townId);
      player.setAttribute(HOUSING_WARMING_ATTRIBUTE, "1");
      player.sendMessage(`You are now a resident of ${match.townName}.`);
    }
  } catch {
    // attribute write failed; still try to enter the house
  }

  try {
    enterOwnHouse(pluginApi, player);
  } catch {
    // never break the click
  }
  return true;
}

function attach(api) {
  pluginApi = api;
  core = api.core;
  api.onObjectInteraction("Portal", { Use: onPortalUse });
  // Spawn after the world is ready — delay a tick.
  try {
    const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
    class PortalSpawnTask extends Task {
      execute() {
        spawnAll();
        this.stop?.();
      }
    }
    api.getTaskManager()?.submit(new PortalSpawnTask(2));
  } catch {
    // Fallback: try immediately (tests / no task manager).
    spawnAll();
  }
}

module.exports = attach;
module.exports.attach = attach;
module.exports.TOWNS = TOWNS;
module.exports.townById = townById;
module.exports.HOUSING_RESIDENCE_ATTRIBUTE = HOUSING_RESIDENCE_ATTRIBUTE;
module.exports.HOUSING_WARMING_ATTRIBUTE = HOUSING_WARMING_ATTRIBUTE;
module.exports.PORTAL_OBJECT_ID = PORTAL_OBJECT_ID;
// Test seams.
module.exports._test = {
  TOWNS,
  townById,
  matchPortal,
  residenceOf,
  enterOwnHouse,
  seedSpawned(list) {
    spawned.length = 0;
    for (const s of list) spawned.push(s);
  },
};
