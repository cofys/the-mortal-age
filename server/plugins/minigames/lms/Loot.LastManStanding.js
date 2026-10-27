/**
 * Keys, chests, crates and what the fallen leave, as captured (rsprox 20261026T161730):
 * - a kill puts a bloody key in the killer's inventory (Wiki: a bloodier key with five or fewer
 *   left) and fills their special bar; Wiki: health, run energy and supplies are replenished too;
 * - a chest (Open, or Search once someone opened it) takes the key: "You find some loot:
 *   <col=ef1020>Volatile Nightmare staff</col>" then the defensive roll's line; it shows as
 *   opened (br_loot_chest_looted_open) and closes again 100 ticks later; with no key "You require
 *   a key to claim the loot.";
 * - a loot crate: "A magical loot crate has appeared near the Trading Post!", 300 ticks in and
 *   every 200 after; br_lootcrate_spawning for five ticks, then br_lootcrate, searched once for
 *   one upgraded roll ("You find some loot: 1,000 x <col=ef1020>Morrigan's javelin</col>");
 * - the dead drop their bones, their ammunition and what they picked up where they fell, seen by
 *   the killer first (100 ticks), gone after 200. Wiki: slain opponents do not drop their supplies.
 * Wiki: a bloody key rolls the offensive and the defensive table; a bloodier key and a crate the
 * upgraded one; crates land anywhere on Desert Island and near the safe zone on Wild Varrock.
 * Inferred: a crate lands within 10 tiles of a chest or of the safe zone's centre.
 */
const Common = require("./Common.LastManStanding");
const Match = require("./Match.LastManStanding");
const Loadouts = require("./Loadouts.LastManStanding");

const CRATE_RANGE = 10;
const CRATE_READY = 5;
/** Players whose chest opens this tick (one key, one opening, however often the click arrives). */
const looting = new Set();
/** human_pickuptable, as a chest or crate is looted (captured). */
const LOOT_ANIMATION = 832;

function keyIds() {
  return { bloody: Common.objId(Common.data.keys.bloody), bloodier: Common.objId(Common.data.keys.bloodier) };
}

function tableOf(game) {
  return Common.data.loot[Common.data.builds[game.build].name];
}

/** One entry of a table, as items: names, or [name, amount] for a stack. */
function roll(table) {
  const { Item } = Common.core;
  return Common.pick(table).map((entry) => {
    const [name, amount] = Array.isArray(entry) ? entry : [entry, 1];
    return new Item(Common.objId(name), amount);
  }).filter((item) => item.getId() > 0);
}

/** "Purging staff", or "1,000 x Morrigan's javelin", as the line lists them. */
function lineOf(items) {
  return items.map((item) => {
    const name = `<col=ef1020>${Common.core.CacheDefinitions.getItem(item.getId())?.name ?? "item"}</col>`;
    return item.getAmount() > 1 ? `${item.getAmount().toLocaleString("en-GB")} x ${name}` : name;
  }).join(", ");
}

/** Into the inventory, or at their feet when it's full. */
function give(game, player, items) {
  const { ItemOnGroundManager } = Common.core;
  const inventory = player.getInventory();
  for (const item of items) {
    const stackable = Common.core.ItemDefinition.forId(item.getId())?.isStackable() === true;
    const room = stackable ? inventory.contains(item.getId()) || inventory.getFreeSlots() > 0 : inventory.getFreeSlots() > 0;
    if (room) inventory.add(item, false);
    else ItemOnGroundManager.registerLocation(player, item, player.getLocation().clone(), game.area);
  }
  inventory.refreshItems();
  player.sendMessage(Common.message("loot", { items: lineOf(items) }));
}

// ---------------------------------------------------------------- kills

function killed(game, killer) {
  const { Item } = Common.core;
  const ids = keyIds();
  const key = game.alive.size <= Common.data.keys.bloodierAtOrBelow ? ids.bloodier : ids.bloody;
  const inventory = killer.getInventory();
  Loadouts.refill(killer);
  Loadouts.resupply(killer, game.build, (item) => Common.core.ItemOnGroundManager.registerLocation(killer, item, killer.getLocation().clone(), game.area, { despawnDelay: 100 }));
  if (inventory.getFreeSlots() > 0) inventory.add(new Item(key, 1), true);
  else Common.core.ItemOnGroundManager.registerLocation(killer, new Item(key, 1), killer.getLocation().clone(), game.area);
}

/**
 * What the fallen leave: their bones (the core's), their ammunition and whatever they carried
 * that isn't from their own load-out (captured: a 1 Def Pure left only its bolts; a Max/Med whose
 * load-out had changed left a whip, a defender and a robe top). Wiki: no supplies.
 */
function fell(game, victim, where, killer) {
  const { ItemOnGroundManager, Item } = Common.core;
  const owner = killer && game.players.has(killer) ? killer : victim;
  const pouch = Common.objId("br_rune_replacement");
  const loadout = require("./Profile.LastManStanding").loadout(victim, game.build);
  const own = new Map();
  const count = (id) => own.set(id, (own.get(id) ?? 0) + 1);
  for (const [slot, value] of Object.entries(loadout.worn)) if (slot !== "quiver") count(Loadouts.itemOf(game.build, value));
  for (const value of loadout.inventory) count(Loadouts.itemOf(game.build, value));
  const leave = (item, ammo) => {
    if (!item || item.getId() <= 0 || item.getId() === pouch || Loadouts.isSupply(item.getId())) return;
    if (!ammo && (own.get(item.getId()) ?? 0) > 0) {
      own.set(item.getId(), own.get(item.getId()) - 1);
      return;
    }
    // The core's own reveal (100 ticks) is the captured one.
    ItemOnGroundManager.registerLocation(owner, new Item(item.getId(), item.getAmount()), where, game.area,
      { despawnDelay: Common.data.timing.dropDespawn });
  };
  victim.getEquipment().getItems().forEach((item, slot) => leave(item, slot === Common.core.Equipment.AMMUNITION_SLOT));
  for (const item of victim.getInventory().getItems()) leave(item, false);
}

// ---------------------------------------------------------------- chests

function openChest(event) {
  const { player, object } = event;
  const game = Match.gameOf(player);
  if (!game || !object) return false;
  if (!game.begun) {
    player.sendMessage(Common.message("roundNotStarted"));
    return true;
  }
  if (!hasKey(player)) {
    player.sendMessage(Common.message("needKey"));
    return true;
  }
  // Captured: the chest opens as they reach it; the loot and the animation a tick later.
  if (looting.has(player)) return true;
  looting.add(player);
  showOpened(game, object);
  Common.later(1, () => {
    looting.delete(player);
    if (game.over || !game.alive.has(player) || !claim(game, player)) return;
    player.performAnimation(new Common.core.Animation(LOOT_ANIMATION));
  });
  return true;
}

function hasKey(player) {
  const ids = keyIds();
  return player.getInventory().contains(ids.bloodier) || player.getInventory().contains(ids.bloody);
}

/** A key's loot: the bloodier key first; false when the player has neither. */
function claim(game, player) {
  const ids = keyIds();
  const inventory = player.getInventory();
  const key = inventory.contains(ids.bloodier) ? ids.bloodier : inventory.contains(ids.bloody) ? ids.bloody : null;
  if (!key) return false;
  inventory.delete(key, 1);
  inventory.refreshItems();
  const table = tableOf(game);
  if (key === ids.bloodier) give(game, player, roll(table.upgraded));
  else {
    give(game, player, roll(table.offensive));
    give(game, player, roll(table.defensive));
  }
  return true;
}

/** Captured: the chest shows opened, and closes again 100 ticks later. */
function showOpened(game, object) {
  const opened = Common.locId("br_loot_chest_looted_open");
  const closed = Common.locId("br_loot_chest_closed");
  if (object.getId() === opened) return;
  const { GameObject, ObjectManager } = Common.core;
  const place = (id, from) => {
    ObjectManager.deregister(from, true);
    game.area.detach(from);
    const next = new GameObject(id, from.getLocation(), from.getType(), from.getFace(), game.area);
    ObjectManager.register(next, true);
    return next;
  };
  const open = place(opened, object);
  Common.later(Common.data.timing.chestReset, () => {
    if (!game.over) place(closed, open);
  });
}

// ---------------------------------------------------------------- crates

function spawnCrate(game) {
  const { GameObject, ObjectManager } = Common.core;
  // Wiki: anywhere on Desert Island; on Wild Varrock always close to the safe zone.
  const centre = game.area.at([...game.zone.centre, 0]);
  const near = game.map.cratesNearZone || !game.chestSpots?.length ? centre : Common.pick(game.chestSpots);
  const tile = game.openTileNear(near, CRATE_RANGE) ?? centre;
  const line = Common.message("crate", { zone: game.zone.name });
  for (const player of game.alive) Common.broadcast(player, line);
  const spawning = new GameObject(Common.locId("br_lootcrate_spawning"), tile, 10, 0, game.area);
  ObjectManager.register(spawning, true);
  Common.later(CRATE_READY, () => {
    if (game.over) return;
    ObjectManager.deregister(spawning, true);
    game.area.detach(spawning);
    ObjectManager.register(new GameObject(Common.locId("br_lootcrate"), tile, 10, 0, game.area), true);
  });
}

function searchCrate(event) {
  const { player, object } = event;
  const game = Match.gameOf(player);
  if (!game || !object) return false;
  Common.core.ObjectManager.deregister(object, true);
  game.area.detach(object);
  give(game, player, roll(tableOf(game).upgraded));
  player.performAnimation(new Common.core.Animation(LOOT_ANIMATION));
  return true;
}

function tick(game) {
  const { crateFirst, crateEvery } = Common.data.timing;
  if (!game.begun || game.clock < crateFirst) return;
  if ((game.clock - crateFirst) % crateEvery === 0) spawnCrate(game);
}

function attachLoot(api) {
  Match.onKill(killed);
  Match.onDeath(fell);
  Match.onTick(tick);
  api.onObjectFirstClick([Common.locId("br_loot_chest_closed"), Common.locId("br_loot_chest_looted_open")], openChest);
  api.onObjectFirstClick([Common.locId("br_lootcrate")], searchCrate);
}

module.exports = { attachLoot, claim, roll, lineOf, openChest, searchCrate, killed, fell, spawnCrate };
