// What sea combat's units share: the creatures and cannonballs (data/sea-combat.json), each
// cannon's stats from the cache (table 176's facility row -> table 162), the per-hotspot side
// panel varbits, and the player's own boat aboard. docs/sailing.md, Combat.
const DATA = require("../data/sea-combat.json");

const FACILITY_TABLE = 176;
const CANNON_TABLE = 162;
/** Table 176's loc and Sailing level columns (BoatFacilities.Sailing.js FACILITY). */
const FACILITY_LOC = 6;
const FACILITY_SAILING = 12;
/** `crew_facility` of cannons (table 176). */
const CREW_FACILITY_CANNON = 8;
/** Wiki (Boat combat): a cannon reaches 15 tiles, in a 180 degree arc to its front. */
const CANNON_RANGE = 15;

const VARBIT = Object.freeze({
  PREFERRED_AMMUNITION: 19101, // sailing_combat_preferred_ammunition: a cannonball type, 0 none
  LAST_FIRED_AMMUNITION: 19102, // sailing_combat_last_fired_ammunition_player
  HOTSPOT_NUMBER: 19103, // sailing_facility_hotspot_number: the manned hotspot + 1
  LOCKED_IN: 19105, // sailing_boat_facility_lockedin: 3 the helm, 4 a cannon
  AMMO_NEEDS_UPDATE: 19236,
  COMBAT_WEAPON_CATEGORY: 357,
  REPAIR_KITS: 19210, // sailing_sidepanel_repairkits
});
const VARP = Object.freeze({
  COM_MODE: 43,
  COMBAT_FACILITY_IN_USE: 5042, // the manned cannon's loc, -1
  COMBAT_FACILITY_DATA: 5043, // its table 162 row, -1
});
/** Manning a cannon: the combat tab becomes "Category: Cannon" (rsprox: 357 5->33, com_mode 1->5). */
const CANNON_WEAPON_CATEGORY = 33;
const CANNON_COM_MODE = 5;
const LOCKED_IN_CANNON = 4;

/** The side panel's per-hotspot arrays: 0-10 in one block, 11 and 12 added later (gamevals). */
function perHotspot(first, firstLate, step = 1, lateStep = step) {
  return (hotspot) => (hotspot <= 10 ? first + hotspot * step : firstLate + (hotspot - 11) * lateStep);
}
const PANEL = Object.freeze({
  playerAtFacility: perHotspot(19193, 20187), // sailing_sidepanel_player_at_facility_n
  hasTarget: perHotspot(19211, 20202, 2), // sailing_sidepanel_weapon_n_has_target
  followingTarget: perHotspot(20189, 20203, 1, 2), // sailing_sidepanel_weapon_n_following_target
  ammoType: perHotspot(13220, 13297), // sailing_sidepanel_ammunition_type_n
  ammoFlags: (hotspot) => 13299 + hotspot, // sailing_sidepanel_ammo_flags_n
  ammoCount: perHotspot(5129, 5474), // varp sailing_sidepanel_ammunition_count_n
});
/** ammo_flags while a cannon has ammunition to fire (rsprox: 4, 0 once none is left). */
const AMMO_FLAGS_LOADED = 4;

const creatures = new Map();
const corpses = new Map();
for (const creature of DATA.creatures) {
  creatures.set(creature.npc, creature);
  corpses.set(creature.dead, creature);
}
const ballsByItem = new Map(DATA.cannonballs.map((ball) => [ball.item, ball]));
const ballsByType = new Map(DATA.cannonballs.map((ball) => [ball.type, ball]));

let core;
let pluginApi;
let cannons;

function init(api) {
  core = api.core;
  pluginApi = api;
}

function coreApi() {
  if (!core) throw new Error("Sea combat used before its plugin attached");
  return core;
}

function api() {
  return pluginApi;
}

/** The sea creature an NPC is (alive), by its current id, or undefined. */
function creatureOf(npc) {
  return npc ? creatures.get(npc.getId()) : undefined;
}

/** The creature a corpse (`_dead` id) belongs to, or undefined. */
function corpseOf(npc) {
  return npc ? corpses.get(npc.getId()) : undefined;
}

function ballByItem(itemId) {
  return ballsByItem.get(itemId);
}

function ballByType(type) {
  return ballsByType.get(type);
}

/**
 * Every cannon loc's stats, from its facility row (table 176) and that row's combat facility
 * data (table 162): accuracy, strength, the highest cannonball tier it fires, its attack rate and
 * level requirements, and the Privateering a crewmate needs.
 */
function cannonsByLoc() {
  if (cannons) return cannons;
  cannons = new Map();
  const { CacheDefinitions } = coreApi();
  const column = (table, name) => CacheDefinitions.getDbColumn(table, name);
  const dataColumn = column(FACILITY_TABLE, "combat_facility_data");
  const crewColumn = column(FACILITY_TABLE, "crew_facility");
  const requirementColumn = column(FACILITY_TABLE, "crew_stat_requirement");
  const [accuracy, damage, maxTier, attackRate, sailing, ranged] = [
    "accuracy", "damage", "ammunition_max_tier", "attack_rate", "sailing_level_required", "ranged_level_required",
  ].map((name) => column(CANNON_TABLE, name));
  for (const row of CacheDefinitions.getDbTableRows(FACILITY_TABLE)) {
    if (crewColumn === null || row.int(crewColumn, 0) !== CREW_FACILITY_CANNON) continue;
    const loc = row.column(FACILITY_LOC)?.[0];
    const dataRow = dataColumn === null ? -1 : row.int(dataColumn, -1);
    const data = dataRow >= 0 ? CacheDefinitions.getDbRow(dataRow) : undefined;
    if (typeof loc !== "number" || !data) continue;
    const requirement = requirementColumn === null ? [] : row.column(requirementColumn) ?? [];
    cannons.set(loc, {
      loc,
      facilityRow: row.id,
      dataRow,
      name: String(row.string(0) ?? "cannon"),
      accuracy: data.int(accuracy, 0),
      strength: data.int(damage, 0),
      maxTier: data.int(maxTier, 1),
      attackRate: data.int(attackRate, 7),
      // Table 162's level columns are empty in the client cache but for Ranged; the facility
      // row's Sailing level (12, the one building it needs) is the one it takes (Wiki).
      sailing: data.int(sailing, 0) || row.int(FACILITY_SAILING, 1),
      ranged: data.int(ranged, 1),
      privateering: Number(requirement[1] ?? 1),
    });
  }
  return cannons;
}

function cannonAt(locId) {
  return cannonsByLoc().get(locId);
}

/** The player's own boat they stand on, with its saved state: `{ boat, owned }`, or undefined. */
function ownBoat(player) {
  const { Sailing } = coreApi();
  const boat = Sailing.instanceAboard(player);
  const owned = boat && Sailing.activeBoat(player);
  return boat && owned ? { boat, owned } : undefined;
}

function spam(player, text) {
  player.getPacketSender().sendTypedMessage(coreApi().ChatType.SPAM, text);
}

/** Live's @mes_hl_red@ (the same red whatever the chatbox's transparency). */
function red(text) {
  return `<col=ef1020>${text}</col>`;
}

/** The main-world tile under a deck tile of a boat. */
function worldTile(boat, x, y) {
  const tile = boat.deckTileToWorld(x, y);
  return new (coreApi().Location)(tile.x, tile.y, boat.level);
}

/** Chebyshev distance from a tile to the nearest tile of an NPC's footprint. */
function distanceToNpc(from, npc) {
  const at = npc.getLocation();
  const size = Math.max(1, npc.getSize?.() ?? 1);
  const dx = Math.max(0, at.getX() - from.getX(), from.getX() - (at.getX() + size - 1));
  const dy = Math.max(0, at.getY() - from.getY(), from.getY() - (at.getY() + size - 1));
  return Math.max(dx, dy);
}

/** A boat's centre on the sea, as a tile. */
function boatCentre(boat) {
  return { x: boat.tileX, y: boat.tileY };
}

/** The sea tiles under a boat's deck, as it now lies (its walkable deck tiles, rotated). */
function hullTiles(boat) {
  const spec = coreApi().BoatManager.getSpec(boat);
  return (spec?.walkableDeck ?? []).map((tile) => boat.deckTileToWorld(boat.deckBaseX + tile.x, boat.deckBaseY + tile.y));
}

/** How far an NPC is from a boat's hull: 0 under it, 1 beside it. */
function distanceToBoat(npc, boat) {
  const tiles = hullTiles(boat);
  if (!tiles.length) return distanceToNpc(new (coreApi().Location)(boat.tileX, boat.tileY, boat.level), npc);
  let best = Infinity;
  for (const tile of tiles) {
    best = Math.min(best, distanceToNpc(new (coreApi().Location)(tile.x, tile.y, boat.level), npc));
    if (best === 0) break;
  }
  return best;
}

module.exports = {
  DATA,
  VARBIT,
  VARP,
  PANEL,
  AMMO_FLAGS_LOADED,
  CANNON_RANGE,
  CANNON_WEAPON_CATEGORY,
  CANNON_COM_MODE,
  LOCKED_IN_CANNON,
  CREW_FACILITY_CANNON,
  init,
  core: coreApi,
  api,
  creatureOf,
  corpseOf,
  ballByItem,
  ballByType,
  cannonsByLoc,
  cannonAt,
  ownBoat,
  spam,
  red,
  worldTile,
  distanceToNpc,
  distanceToBoat,
  boatCentre,
  hullTiles,
};
