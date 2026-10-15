// Naval warfare Phase 1 ("Sail & Shoot"): cannon broadsides, hull HP, fires, sinking,
// one kraken encounter and one navy cutter. Pure-ish engine: the plugin file wires it up.
//
// Targets are resolved by world tile: the firing ship's `Boat.worldTile()` against the
// kraken's lair, the navy cutter's world tile, and other crewed player ships.
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { BoatManager } = require("../../../src/main/typescript/elvarg/game/content/sailing/BoatManager");
const { BoatMoveMode } = require("../../../src/main/typescript/elvarg/game/content/sailing/Boat");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../../src/main/typescript/elvarg/game/model/Item");
const { boatStats } = require("./BoatParts.Sailing");
const { facilitiesOf, facilityAt, FACILITY } = require("./BoatFacilities.Sailing");
const { CacheDefinitions } = require("../../../src/main/typescript/elvarg/game/cache/CacheDefinitions");
const { content } = require("./SailingContent.Sailing");
const { notorietyOf, addNotoriety } = require("./navalNotoriety");

/** Broadside range in tiles (design doc). */
const BROADSIDE_RANGE = 10;
/** Broadside cooldown: ~8s at 0.6s/tick. */
const BROADSIDE_COOLDOWN_TICKS = 13;
const CANNONBALL = 2;
const COINS = 995;
/** Kraken lair: deep ocean by the fremennik wreck site (sailing-salvage.json, confirmed water). */
const KRAKEN = { x: 2590, y: 4170, maxHp: 600, npcId: 494, respawnTicks: 1000, attackRange: 12 };
/** Navy cutter patrol: a circuit around Port Sarim's buoy. */
const NAVY = {
  centerX: 3048, centerY: 3186, radius: 45,
  maxHp: 220, respawnTicks: 1500, aggroRange: 26, aggroNotoriety: 50,
};
const METAL_TIERS = ["bronze", "iron", "steel", "mithril", "adamant", "rune", "dragon"];
/** Hull damage per cannon per broadside, before tier scaling. */
const CANNON_BASE_DAMAGE = 8;
const CANNON_TIER_DAMAGE = 4;
const FIRE_CHANCE = 0.2;
const FIRE_TICKS = 30;

let tick = 0;
const kraken = { hp: KRAKEN.maxHp, alive: true, npc: null, respawnAt: 0, nextAttack: 0 };
const navy = { boat: null, hp: NAVY.maxHp, alive: true, respawnAt: 0, nextShot: 0, waypoint: 0 };

function distance(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Packed heading (0-2047; 0 = south) from one tile toward another. */
function angleToward(fx, fy, tx, ty) {
  const angle = 1024 + (Math.atan2(tx - fx, ty - fy) * 1024) / Math.PI;
  return ((Math.round(angle) % 2048) + 2048) % 2048;
}

/** The name of the facility built on a hotspot, or undefined. */
function facilityNameAt(owned, hotspot) {
  const row = facilityAt(owned, hotspot);
  return row === undefined ? undefined : CacheDefinitions.getDbRow(row)?.string(FACILITY.name);
}

/**
 * The ship's broadside: how many cannons are mounted and their best metal tier.
 * A cannon facility is any built facility whose name ends in "cannon".
 */
function cannonsOf(owned) {
  let count = 0;
  let tier = 0;
  for (let hotspot = 0; hotspot < facilitiesOf(owned).length; hotspot++) {
    const name = facilityNameAt(owned, hotspot);
    if (!name || !name.toLowerCase().endsWith("cannon")) continue;
    count++;
    const metal = METAL_TIERS.findIndex((tierName) => name.toLowerCase().startsWith(tierName));
    if (metal > tier) tier = metal;
  }
  return { count, tier };
}

function maxHullOf(owned) {
  return Math.max(1, boatStats(owned).hitpoints);
}

/** Current hull HP, persisted on the owned boat (0/unset reads as full). */
function hullOf(owned) {
  const max = maxHullOf(owned);
  const current = owned.hitpoints;
  return current > 0 ? Math.min(current, max) : max;
}

function setHull(owned, hp) {
  owned.hitpoints = Math.max(0, Math.min(maxHullOf(owned), Math.round(hp)));
  return owned.hitpoints;
}

/** Roll one broadside's hull damage: every cannon fires round shot (Phase 1). */
function broadsideDamage(cannons, random = Math.random) {
  let total = 0;
  for (let i = 0; i < cannons.count; i++) {
    total += Math.round((CANNON_BASE_DAMAGE + CANNON_TIER_DAMAGE * cannons.tier) * (0.85 + random() * 0.3));
  }
  return total;
}

/**
 * Damages a player's owned boat. Returns { sunk, fireStarted }. Fires tick down in navalTick
 * and are put out by patching the hull.
 */
function damageHull(owned, player, amount, random = Math.random) {
  const remaining = setHull(owned, hullOf(owned) - amount);
  let fireStarted = false;
  if (remaining > 0 && random() < FIRE_CHANCE && !owned.combatFireTicks) {
    owned.combatFireTicks = FIRE_TICKS;
    fireStarted = true;
  }
  return { sunk: remaining <= 0, fireStarted };
}

/** Every player aboard a world boat instance. */
function aboard(boat) {
  const crew = [];
  for (const player of World.getPlayers()) {
    if (Sailing.instanceAboard(player) === boat) crew.push(player);
  }
  return crew;
}

function messageAboard(boat, text) {
  for (const player of aboard(boat)) player.sendMessage(text);
}

/** Crewed player ships (owner aboard their own boat) other than `boat`, for targeting. */
function enemyShips(boat) {
  const enemies = [];
  for (const player of World.getPlayers()) {
    const other = Sailing.instanceAboard(player);
    if (!other || other === boat || other.ownerPlayerId !== player.getIndex()) continue;
    enemies.push({ boat: other, player, owned: Sailing.activeBoat(player) });
  }
  return enemies;
}

/**
 * The nearest hostile in broadside range of `tile`: the kraken, the navy cutter, or a
 * crewed player ship. Returns { kind, ... } or undefined.
 */
function findTarget(tile) {
  const inRange = (x, y) => distance(tile.x, tile.y, x, y) <= BROADSIDE_RANGE;
  const targets = [];
  if (kraken.alive && inRange(KRAKEN.x, KRAKEN.y)) {
    targets.push({ kind: "kraken", x: KRAKEN.x, y: KRAKEN.y, distance: distance(tile.x, tile.y, KRAKEN.x, KRAKEN.y) });
  }
  if (navy.alive && navy.boat) {
    const navyTile = navy.boat.worldTile();
    if (inRange(navyTile.x, navyTile.y)) {
      targets.push({ kind: "navy", boat: navy.boat, distance: distance(tile.x, tile.y, navyTile.x, navyTile.y) });
    }
  }
  return targets.sort((a, b) => a.distance - b.distance)[0];
}

function fireBroadside(player, random = Math.random) {
  const boat = Sailing.instanceAboard(player);
  if (!boat) {
    player.sendMessage("You need to be aboard your ship to fire its cannons.");
    return false;
  }
  if (boat.ownerPlayerId !== player.getIndex()) {
    player.sendMessage("Only the ship's owner can order a broadside.");
    return false;
  }
  const owned = Sailing.activeBoat(player);
  if (!owned) {
    player.sendMessage("You need to be aboard your own ship to fire its cannons.");
    return false;
  }
  const cannons = cannonsOf(owned);
  if (cannons.count === 0) {
    player.sendMessage("Your ship has no cannons mounted. Build some at a shipyard first.");
    return false;
  }
  if (tick < (owned.combatCooldownUntil ?? 0)) {
    player.sendMessage("The gun crews are still reloading.");
    return false;
  }
  if (player.getInventory().getAmount(CANNONBALL) < cannons.count) {
    player.sendMessage(`You need ${cannons.count} cannonballs to fire a broadside.`);
    return false;
  }
  const tile = boat.worldTile();
  const target = findTarget(tile) ?? nearestEnemyShip(player, boat, tile);
  if (!target) {
    player.sendMessage("There is nothing hostile in broadside range.");
    return false;
  }
  player.getInventory().delete(CANNONBALL, cannons.count);
  owned.combatCooldownUntil = tick + BROADSIDE_COOLDOWN_TICKS;
  const damage = broadsideDamage(cannons, random);
  player.getSkillManager().addExperience(Skill.SAILING, Math.max(1, Math.round(damage / 2)), true);
  if (target.kind === "kraken") return hitKraken(player, boat, damage);
  if (target.kind === "navy") return hitNavy(player, boat, damage);
  return hitPlayerShip(player, boat, target, damage, random);
}

/** The nearest crewed enemy player ship in range, or undefined. */
function nearestEnemyShip(player, boat, tile) {
  let nearest;
  for (const enemy of enemyShips(boat)) {
    if (!enemy.owned) continue;
    const enemyTile = enemy.boat.worldTile();
    const d = distance(tile.x, tile.y, enemyTile.x, enemyTile.y);
    if (d <= BROADSIDE_RANGE && (!nearest || d < nearest.distance)) {
      nearest = { kind: "ship", ...enemy, distance: d };
    }
  }
  return nearest;
}

function hitKraken(player, boat, damage) {
  kraken.hp -= damage;
  messageAboard(boat, `Your broadside slams into the kraken for ${damage} damage!`);
  if (kraken.hp <= 0) return slayKraken(player, boat);
  return true;
}

function slayKraken(player, boat) {
  kraken.alive = false;
  kraken.hp = 0;
  kraken.respawnAt = tick + KRAKEN.respawnTicks;
  const loot = 2000 + Math.floor(Math.random() * 3000);
  player.getInventory().addItem(new Item(COINS, loot));
  player.getInventory().addItem(new Item(CANNONBALL, 40));
  player.getSkillManager().addExperience(Skill.SAILING, 500, true);
  addNotoriety(player, -10);
  messageAboard(boat, `The kraken sinks beneath the waves! You loot its lair: ${loot} coins and 40 cannonballs.`);
  return true;
}

function hitNavy(player, boat, damage) {
  navy.hp -= damage;
  messageAboard(boat, `Your broadside hits the navy cutter for ${damage} damage!`);
  if (navy.hp <= 0) return sinkNavy(player, boat);
  return true;
}

function sinkNavy(player, boat) {
  navy.alive = false;
  navy.hp = 0;
  navy.respawnAt = tick + NAVY.respawnTicks;
  if (navy.boat) BoatManager.dispose(navy.boat);
  navy.boat = null;
  addNotoriety(player, 25);
  player.getInventory().addItem(new Item(COINS, 1500));
  player.getInventory().addItem(new Item(CANNONBALL, 30));
  player.getSkillManager().addExperience(Skill.SAILING, 250, true);
  messageAboard(boat, "The navy cutter sinks! You loot its powder room: 1,500 coins and 30 cannonballs. Your notoriety rises.");
  return true;
}

function hitPlayerShip(player, boat, target, damage, random) {
  const result = damageHull(target.owned, target.player, damage, random);
  addNotoriety(player, 10);
  messageAboard(boat, `Your broadside hits ${target.player.getUsername()}'s ship for ${damage} damage!`);
  target.player.sendMessage(`${player.getUsername()}'s ship fires a broadside at you for ${damage} damage!`);
  if (result.fireStarted) target.player.sendMessage("Fire breaks out on your deck! Patch the hull with a repair kit.");
  if (result.sunk) return sinkPlayerShip(player, boat, target);
  return true;
}

function sinkPlayerShip(player, boat, target) {
  addNotoriety(player, 15);
  player.getInventory().addItem(new Item(COINS, 500));
  messageAboard(boat, `You sink ${target.player.getUsername()}'s ship and loot the wreck: 500 coins.`);
  target.player.sendMessage("Your ship sinks beneath the waves! A shipwright can recover it for a fee.");
  // Sailing.sink is private in TS but callable at runtime; the victim is aboard their own
  // active boat (guaranteed by enemyShips), which is exactly what sink expects.
  Sailing.sink(target.player, target.boat);
  return true;
}

/**
 * Patches the hull with a repair kit from the inventory: restores a quarter of max hull and
 * puts out any fire. Kits live in the cargo hold; the player takes one out to use it here.
 */
function patchHull(player, kitIds) {
  const boat = Sailing.instanceAboard(player);
  if (!boat || boat.ownerPlayerId !== player.getIndex()) {
    player.sendMessage("You need to be aboard your own ship to patch its hull.");
    return false;
  }
  const owned = Sailing.activeBoat(player);
  if (!owned) return false;
  const inventory = player.getInventory();
  const kitId = kitIds.find((id) => inventory.getAmount(id) > 0);
  if (kitId === undefined) {
    player.sendMessage("You need a repair kit. Take one from your cargo hold first.");
    return false;
  }
  const max = maxHullOf(owned);
  if (hullOf(owned) >= max && !owned.combatFireTicks) {
    player.sendMessage("Your hull is already in perfect shape.");
    return false;
  }
  inventory.delete(kitId, 1);
  setHull(owned, hullOf(owned) + Math.ceil(max / 4));
  const hadFire = !!owned.combatFireTicks;
  owned.combatFireTicks = 0;
  player.sendMessage(hadFire
    ? "You patch the hull and douse the flames."
    : "You patch the hull.");
  return true;
}

/** The per-tick driver: kraken attacks, navy patrol/combat, fires, respawns. */
function navalTick() {
  tick++;
  tickKraken();
  tickNavy();
  tickFires();
  tickRespawns();
}

function crewedBoatsNear(x, y, range) {
  const found = [];
  for (const boat of BoatManager.all()) {
    if (boat.ownerPlayerId < 0) continue;
    const tile = boat.worldTile();
    if (distance(tile.x, tile.y, x, y) <= range) found.push(boat);
  }
  return found;
}

function tickKraken() {
  if (!kraken.alive || tick < kraken.nextAttack) return;
  kraken.nextAttack = tick + 10;
  for (const boat of crewedBoatsNear(KRAKEN.x, KRAKEN.y, KRAKEN.attackRange)) {
    const damage = 12 + Math.floor(Math.random() * 13);
    const owner = World.getPlayers().get(boat.ownerPlayerId);
    const owned = owner && Sailing.activeBoat(owner);
    if (!owned) continue;
    const result = damageHull(owned, owner, damage);
    messageAboard(boat, `A kraken tentacle slams into your hull for ${damage} damage!`);
    if (result.fireStarted) messageAboard(boat, "The impact starts a fire on deck!");
    if (result.sunk) {
      messageAboard(boat, "The kraken drags your ship under!");
      Sailing.sink(owner, boat);
    }
  }
}

function navyWaypoints() {
  const points = [];
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    points.push({
      x: NAVY.centerX + Math.round(Math.cos(angle) * NAVY.radius),
      y: NAVY.centerY + Math.round(Math.sin(angle) * NAVY.radius),
    });
  }
  return points;
}

function tickNavy() {
  if (!navy.alive || !navy.boat) return;
  const tile = navy.boat.worldTile();
  // Hunt the most notorious pirate in range, else keep patrolling.
  let prey;
  let preyDistance = Infinity;
  for (const boat of BoatManager.all()) {
    if (boat.ownerPlayerId < 0 || boat === navy.boat) continue;
    const owner = World.getPlayers().get(boat.ownerPlayerId);
    if (!owner || Sailing.instanceAboard(owner) !== boat) continue;
    if (notorietyOf(owner) < NAVY.aggroNotoriety) continue;
    const boatTile = boat.worldTile();
    const d = distance(tile.x, tile.y, boatTile.x, boatTile.y);
    if (d <= NAVY.aggroRange && d < preyDistance) {
      prey = { boat, owner, tile: boatTile };
      preyDistance = d;
    }
  }
  const destination = prey ? prey.tile : navyWaypoints()[navy.waypoint % 4];
  if (!prey && distance(tile.x, tile.y, destination.x, destination.y) < 8) navy.waypoint++;
  navy.boat.heading = angleToward(tile.x, tile.y, destination.x, destination.y);
  navy.boat.moveMode = BoatMoveMode.Full;
  if (prey && preyDistance <= BROADSIDE_RANGE && tick >= navy.nextShot) {
    navy.nextShot = tick + BROADSIDE_COOLDOWN_TICKS;
    const owned = Sailing.activeBoat(prey.owner);
    if (!owned) return;
    const damage = 40 + Math.floor(Math.random() * 25);
    const result = damageHull(owned, prey.owner, damage);
    messageAboard(prey.boat, `"Surrender, pirate!" The navy cutter fires a broadside for ${damage} damage!`);
    if (result.fireStarted) messageAboard(prey.boat, "Fire breaks out on your deck!");
    if (result.sunk) {
      messageAboard(prey.boat, "The navy sends your ship to the bottom.");
      Sailing.sink(prey.owner, prey.boat);
    }
  }
}

function tickFires() {
  if (tick % 5 !== 0) return;
  for (const boat of BoatManager.all()) {
    const owner = boat.ownerPlayerId >= 0 && World.getPlayers().get(boat.ownerPlayerId);
    const owned = owner && Sailing.activeBoat(owner);
    if (!owned || !owned.combatFireTicks) continue;
    owned.combatFireTicks -= 5;
    setHull(owned, hullOf(owned) - 2);
    if (hullOf(owned) <= 0) {
      messageAboard(boat, "The fire consumes your ship!");
      Sailing.sink(owner, boat);
    } else if (owned.combatFireTicks <= 0) {
      owned.combatFireTicks = 0;
      messageAboard(boat, "The fire burns itself out.");
    }
  }
}

function tickRespawns() {
  if (!kraken.alive && tick >= kraken.respawnAt) {
    kraken.alive = true;
    kraken.hp = KRAKEN.maxHp;
  }
  if (!navy.alive && tick >= navy.respawnAt) {
    navy.alive = true;
    navy.hp = NAVY.maxHp;
    spawnNavyBoat();
  }
}

/** Spawns the navy cutter's world boat (an ownerless sloop on patrol). */
function spawnNavyBoat() {
  const spec = content().boats.find((boat) => boat.type === "sloop");
  if (!spec) return;
  navy.boat = BoatManager.spawn(-1, spec, {
    fineX: NAVY.centerX * 128,
    fineY: NAVY.centerY * 128,
    level: 0,
    angle: 1024,
  }) ?? null;
  navy.waypoint = 0;
}

module.exports = {
  BROADSIDE_RANGE,
  BROADSIDE_COOLDOWN_TICKS,
  KRAKEN,
  NAVY,
  METAL_TIERS,
  distance,
  angleToward,
  cannonsOf,
  maxHullOf,
  hullOf,
  setHull,
  broadsideDamage,
  damageHull,
  findTarget,
  fireBroadside,
  patchHull,
  navalTick,
  spawnNavyBoat,
  krakenState: kraken,
  navyState: navy,
};
