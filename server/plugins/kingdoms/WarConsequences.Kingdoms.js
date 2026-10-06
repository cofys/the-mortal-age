"use strict";

/**
 * WarConsequences.Kingdoms — wars leave marks on the world.
 *
 * Skirmishes and wars happen in data (Tension.Kingdoms); this module makes
 * them physical:
 *
 *   kingdom:skirmish     -> a battlefield marker goes up at the border tile:
 *                           scorched earth, gravestones, carrion birds
 *                           (vultures), and lootable battlefield debris.
 *                           A signpost at the site can be Read for the story.
 *   kingdom:war-declared -> the site escalates (more graves, more debris);
 *                           a war with no prior skirmish site plants one.
 *   kingdom:war-ended    -> the whole site is cleaned up: objects
 *                           deregistered, birds removed, debris swept.
 *
 * Sites with no war behind them fade on their own (a slow task expires
 * anything older than SITE_TTL_MS that isn't inside an active war).
 *
 * Out (custom events): none new — the module works through the kingdom:*
 * events it listens to. In: kingdom:skirmish, kingdom:war-declared,
 * kingdom:war-ended.
 *
 * Border tiles are approximate OSRS surface tiles on each named border
 * (see Tension.Kingdoms borderName); they only anchor temporary flavor
 * markers. Object/NPC ids come from the generated cache identifiers.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const Store = require("./KingdomStore");

// A battlefield marker outlives the news cycle but not the season: sites
// that never escalated into a war are swept after this long.
const SITE_TTL_MS = 4 * 60 * 60 * 1000;
const SITE_SWEEP_TICKS = 1000; // ~10 minutes at 600ms/tick

// Approximate tiles on each named border (canonical "a:b" pair keys).
const BORDER_TILES = Object.freeze({
  "asgarnia:kandarin": { x: 2816, y: 3328, z: 0 },
  "asgarnia:keldagrim": { x: 3008, y: 3440, z: 0 },
  "asgarnia:misthalin": { x: 3105, y: 3510, z: 0 },
  "asgarnia:morytania": { x: 3405, y: 3488, z: 0 },
  "kandarin:keldagrim": { x: 2505, y: 3310, z: 0 },
  "kandarin:misthalin": { x: 2875, y: 3462, z: 0 },
  "kandarin:morytania": { x: 3445, y: 3405, z: 0 },
  "keldagrim:misthalin": { x: 2825, y: 3505, z: 0 },
  "keldagrim:morytania": { x: 3450, y: 3438, z: 0 },
  "misthalin:morytania": { x: 3420, y: 3470, z: 0 },
});

let pluginApi = null;
// pairKey -> { objects: GameObject[], npcs: [], items: ItemOnGround[],
//              signTiles: Set<string>, placedAt, escalated, signText }
const sites = new Map();

function pairKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

function borderTileFor(a, b) {
  return BORDER_TILES[pairKey(a, b)] ?? null;
}

function nameOf(kingdomId) {
  return Store.getKingdom(kingdomId)?.name ?? kingdomId;
}

function tileKey(x, y, z) {
  return `${x}:${y}:${z ?? 0}`;
}

function scatter(center, radius) {
  const dx = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
  const dy = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
  return { x: center.x + dx, y: center.y + dy, z: center.z ?? 0 };
}

function core() {
  return pluginApi?.core ?? {};
}

function placeObject(id, tile) {
  try {
    const { GameObject, Location, ObjectManager } = core();
    const obj = new GameObject(id, new Location(tile.x, tile.y, tile.z ?? 0), 10, 0, null);
    ObjectManager.register(obj, true);
    return obj;
  } catch {
    return null;
  }
}

function placeNpc(id, tile) {
  try {
    return pluginApi.spawnNpc({ id, x: tile.x, y: tile.y, z: tile.z ?? 0, wanderRadius: 4 });
  } catch {
    return null;
  }
}

function debrisPool() {
  const ItemIds = core().ItemIds ?? {};
  return [
    { id: ItemIds.BRONZE_SWORD ?? 1277, amount: 1, weight: 3 },
    { id: ItemIds.IRON_SWORD ?? 1279, amount: 1, weight: 2 },
    { id: ItemIds.STEEL_SWORD ?? 1281, amount: 1, weight: 1 },
    { id: ItemIds.WOODEN_SHIELD ?? 1171, amount: 1, weight: 2 },
    { id: ItemIds.BREAD ?? 2309, amount: 3, weight: 3 },
    { id: ItemIds.COINS ?? 995, amount: 60, weight: 2 },
  ];
}

function pickDebris() {
  const pool = debrisPool();
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of pool) {
    roll -= entry.weight;
    if (roll <= 0) {
      const amount =
        entry.id === (core().ItemIds?.COINS ?? 995)
          ? 25 + Math.floor(Math.random() * 100)
          : entry.amount;
      return { id: entry.id, amount };
    }
  }
  return { id: pool[0].id, amount: pool[0].amount };
}

function placeDebris(tile) {
  try {
    const { Item, ItemOnGround, GroundItemState, ItemOnGroundManager, Location } = core();
    const drop = pickDebris();
    const groundItem = new ItemOnGround(
      GroundItemState.SEEN_BY_EVERYONE,
      undefined,
      new Location(tile.x, tile.y, tile.z ?? 0),
      new Item(drop.id, drop.amount),
      false,
      -1,
      null
    );
    ItemOnGroundManager.register(groundItem);
    return groundItem;
  } catch {
    return null;
  }
}

function signTextFor(a, b, dead, location) {
  const aName = nameOf(a);
  const bName = nameOf(b);
  const clash =
    dead > 0
      ? `Here ${aName} and ${bName} patrols clashed on ${location} — ${dead} guards fell.`
      : `Here ${aName} and ${bName} came to open war on ${location}.`;
  return (
    clash +
    ` The grass burned black where the fires caught, and the crows have claimed the field.`
  );
}

/** A fresh battlefield marker at the pair's border tile. */
function plantSite(a, b, location, dead) {
  const center = borderTileFor(a, b);
  if (!center) return null;
  const { ObjectIdentifiers, NpcIdentifiers } = core();
  const site = {
    objects: [],
    npcs: [],
    items: [],
    signTiles: new Set(),
    placedAt: Date.now(),
    escalated: false,
    signText: signTextFor(a, b, dead, location),
  };
  // The readable marker: a signpost telling the field's story.
  const signTile = scatter(center, 1);
  const sign = placeObject(ObjectIdentifiers?.SIGNPOST ?? 1033, signTile);
  if (sign) {
    site.objects.push(sign);
    site.signTiles.add(tileKey(signTile.x, signTile.y, signTile.z));
  }
  for (let i = 0; i < 2; i++) {
    const obj = placeObject(ObjectIdentifiers?.SCORCHED_EARTH ?? 2579, scatter(center, 3));
    if (obj) site.objects.push(obj);
  }
  const graves = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < graves; i++) {
    const obj = placeObject(ObjectIdentifiers?.GRAVESTONE ?? 404, scatter(center, 4));
    if (obj) site.objects.push(obj);
  }
  const birds = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < birds; i++) {
    const npc = placeNpc(NpcIdentifiers?.VULTURE ?? 1267, scatter(center, 5));
    if (npc) site.npcs.push(npc);
  }
  const debris = 3 + Math.floor(Math.random() * 4);
  for (let i = 0; i < debris; i++) {
    const item = placeDebris(scatter(center, 5));
    if (item) site.items.push(item);
  }
  sites.set(pairKey(a, b), site);
  console.info("[war-consequences] battlefield marked", {
    pair: pairKey(a, b),
    location,
    dead,
  });
  return site;
}

/** War makes the field worse: more graves, more debris, another carrion bird. */
function escalateSite(a, b, location, dead) {
  const key = pairKey(a, b);
  let site = sites.get(key);
  if (!site) {
    return plantSite(a, b, location, dead);
  }
  if (site.escalated) {
    site.placedAt = Date.now();
    return site;
  }
  const { ObjectIdentifiers, NpcIdentifiers } = core();
  const center = borderTileFor(a, b);
  for (let i = 0; i < 2; i++) {
    const obj = placeObject(ObjectIdentifiers?.GRAVESTONE ?? 404, scatter(center, 4));
    if (obj) site.objects.push(obj);
  }
  const obj = placeObject(ObjectIdentifiers?.SCORCHED_EARTH ?? 2579, scatter(center, 3));
  if (obj) site.objects.push(obj);
  const npc = placeNpc(NpcIdentifiers?.VULTURE ?? 1267, scatter(center, 5));
  if (npc) site.npcs.push(npc);
  for (let i = 0; i < 3; i++) {
    const item = placeDebris(scatter(center, 5));
    if (item) site.items.push(item);
  }
  site.escalated = true;
  site.placedAt = Date.now();
  site.signText = signTextFor(a, b, dead, location);
  console.info("[war-consequences] battlefield escalated", { pair: key });
  return site;
}

/** Peace: the field is cleared — objects deregistered, birds gone, debris swept. */
function clearSite(a, b) {
  const key = pairKey(a, b);
  const site = sites.get(key);
  if (!site) return;
  const { ObjectManager, ItemOnGroundManager } = core();
  for (const obj of site.objects) {
    try {
      ObjectManager.deregister(obj, true);
    } catch {
      // A missing object is already clean.
    }
  }
  for (const npc of site.npcs) {
    try {
      pluginApi.removeNpc(npc);
    } catch {
      // Already gone.
    }
  }
  for (const item of site.items) {
    try {
      ItemOnGroundManager.deregister(item);
    } catch {
      // Picked clean already.
    }
  }
  sites.delete(key);
  console.info("[war-consequences] battlefield cleared", { pair: key });
}

function pairAtWar(a, b) {
  try {
    return Store.getActiveWars().some(
      (w) =>
        (w.attackerId === a && w.defenderId === b) ||
        (w.attackerId === b && w.defenderId === a)
    );
  } catch {
    return false;
  }
}

/** Stale markers fade: anything older than the TTL with no war behind it. */
function sweepStaleSites() {
  try {
    const now = Date.now();
    for (const [key, site] of Array.from(sites)) {
      if (now - site.placedAt < SITE_TTL_MS) continue;
      const [a, b] = key.split(":");
      if (pairAtWar(a, b)) {
        site.placedAt = now; // the war keeps the field fresh
        continue;
      }
      clearSite(a, b);
    }
  } catch (error) {
    console.warn("[war-consequences] sweep failed", error?.message ?? error);
  }
}

/** kingdom:skirmish — patrols clashed; the border keeps the scar. */
function onSkirmish(event) {
  const a = event?.attackerId;
  const b = event?.defenderId;
  if (!a || !b) return;
  const dead = (event?.casualtiesA ?? 0) + (event?.casualtiesB ?? 0);
  const location = event?.location ?? "the border marches";
  if (sites.has(pairKey(a, b))) return; // one marker per border
  plantSite(a, b, location, dead);
}

/** kingdom:war-declared — the field grows teeth. */
function onWarDeclared(event) {
  const a = event?.attackerId;
  const b = event?.defenderId;
  if (!a || !b) return;
  escalateSite(a, b, "the border marches", 0);
}

/** kingdom:war-ended — peace clears the field. */
function onWarEnded(event) {
  const a = event?.attackerId;
  const b = event?.defenderId;
  if (!a || !b) return;
  clearSite(a, b);
}

/**
 * Reading a battlefield signpost: only ours answer. Anything else falls
 * through (return false) to the default signpost behaviour.
 */
function onReadSignpost(event) {
  const object = event?.object;
  const player = event?.player;
  if (!object || !player?.sendMessage) return false;
  let loc = null;
  try {
    loc = object.getLocation?.();
  } catch {
    return false;
  }
  if (!loc) return false;
  const key = tileKey(loc.getX(), loc.getY(), loc.getZ());
  for (const site of sites.values()) {
    if (site.signTiles.has(key)) {
      player.sendMessage(site.signText);
      return; // handled — the default signpost text stays silent
    }
  }
  return false;
}

function startSweepTask(api) {
  class SiteSweepTask extends Task {
    execute() {
      sweepStaleSites();
    }
  }
  api.getTaskManager()?.submit(new SiteSweepTask(SITE_SWEEP_TICKS));
}

function attachWarConsequences(api) {
  pluginApi = api;
  api.onCustomEvent("kingdom:skirmish", onSkirmish);
  api.onCustomEvent("kingdom:war-declared", onWarDeclared);
  api.onCustomEvent("kingdom:war-ended", onWarEnded);
  api.onObjectInteraction("Signpost", { Read: onReadSignpost });
  startSweepTask(api);
  console.info("[war-consequences] armed");
}

module.exports = attachWarConsequences;
module.exports.attachWarConsequences = attachWarConsequences;
module.exports.pairKey = pairKey;
module.exports.borderTileFor = borderTileFor;
module.exports.onSkirmish = onSkirmish;
module.exports.onWarDeclared = onWarDeclared;
module.exports.onWarEnded = onWarEnded;
module.exports.SITE_TTL_MS = SITE_TTL_MS;
