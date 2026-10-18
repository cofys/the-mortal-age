/**
 * Callisto's and Artio's bear traps (https://oldschool.runescape.wiki/w/Callisto/Strategies), as
 * captured: from the first roar on, a wave of five traps every 6 ticks on random open tiles up to
 * 12 from the bear's middle. Each shows fx_callisto_trap with sound 6908 and becomes the trap
 * loc (47146) a tick later; it lasts 30 ticks. A player who steps on one: "The bear trap
 * immobilizes you." (red), it springs (trap_bear01_activate, sound 6891), they are held for 3
 * ticks and take up to 15 the tick after, as the trap goes. When the bear dies every trap springs
 * (sound 6920) and is gone a tick later.
 */
const Common = require("./Common.WildernessBosses");

const TRAP_LOC = 47146; // callisto_trap_loc
const TRAP_GRAPHIC = 2343; // fx_callisto_trap
const SPRING_ANIMATION = 9999; // trap_bear01_activate
const SOUND = Object.freeze({ wave: 6908, spring: 6891, cleared: 6920 });
const WAVE_SIZE = 5;
const WAVE_EVERY_TICKS = 6;
const LIFETIME_TICKS = 30;
const RADIUS = 12;
const HOLD_TICKS = 3;
const MAX_DAMAGE = 15;
const MESSAGE = "<col=ef1020>The bear trap immobilizes you.</col>";
const SCENERY_SHAPE = 10;

let api = null;
let core = null;
let playersIn = () => [];
/** lair key -> { npc, active, traps: Map("x,y" -> { location, object }) } */
const lairs = new Map();

function stateOf(key) {
  let state = lairs.get(key);
  if (!state) {
    state = { npc: null, active: false, traps: new Map() };
    lairs.set(key, state);
  }
  return state;
}

const tileKey = (x, y) => `${x},${y}`;

function at(key, x, y) {
  return stateOf(key).traps.get(tileKey(x, y)) ?? null;
}

function toLair(key, send) {
  for (const player of playersIn(key)) send(player);
}

function underBear(npc, x, y) {
  const base = npc.getLocation();
  const size = npc.getSize();
  return x >= base.getX() && x < base.getX() + size && y >= base.getY() && y < base.getY() + size;
}

/** Five open tiles around the bear, off the bear, the players and the traps already down. */
function waveTiles(key, npc, centre) {
  const taken = new Set(playersIn(key).map((player) => tileKey(player.getLocation().getX(), player.getLocation().getY())));
  const tiles = [];
  for (let tries = 0; tiles.length < WAVE_SIZE && tries < 200; tries++) {
    const x = centre.x + Math.floor(Math.random() * (2 * RADIUS + 1)) - RADIUS;
    const y = centre.y + Math.floor(Math.random() * (2 * RADIUS + 1)) - RADIUS;
    const id = tileKey(x, y);
    if (taken.has(id) || at(key, x, y) || underBear(npc, x, y)) continue;
    const location = new core.Location(x, y, centre.z);
    if (core.RegionManager.blocked(location, null)) continue;
    taken.add(id);
    tiles.push(location);
  }
  return tiles;
}

function remove(key, trap) {
  const state = stateOf(key);
  if (state.traps.get(tileKey(trap.location.getX(), trap.location.getY())) !== trap) return;
  state.traps.delete(tileKey(trap.location.getX(), trap.location.getY()));
  if (trap.object) api.getObjectManager().deregister(trap.object, true);
}

function wave(key) {
  const state = stateOf(key);
  const npc = state.npc;
  if (!state.active || !npc?.isRegistered() || npc.getHitpoints() <= 0) return;
  const base = npc.getLocation();
  const half = Math.floor(npc.getSize() / 2);
  const centre = { x: base.getX() + half, y: base.getY() + half, z: base.getZ() };
  for (const location of waveTiles(key, npc, centre)) {
    const trap = { location, object: null };
    state.traps.set(tileKey(location.getX(), location.getY()), trap);
    toLair(key, (player) => player.getPacketSender()
      .sendGlobalGraphic(new core.Graphic(TRAP_GRAPHIC), location)
      .sendAreaSound(SOUND.wave, location.getX(), location.getY(), location.getZ(), 1, 0, 15));
    Common.later(1, () => {
      if (state.traps.get(tileKey(location.getX(), location.getY())) !== trap) return;
      trap.object = new core.GameObject(TRAP_LOC, location.clone(), SCENERY_SHAPE, 0, null);
      api.getObjectManager().register(trap.object, true);
      Common.later(LIFETIME_TICKS, () => remove(key, trap));
    });
  }
  Common.later(WAVE_EVERY_TICKS, () => wave(key));
}

/** The first roar: the waves begin a tick later. */
function start(npc, key) {
  const state = stateOf(key);
  state.npc = npc;
  if (state.active) return;
  state.active = true;
  Common.later(1, () => wave(key));
}

/** A player standing on an armed trap springs it. */
function playerTick(player, lair) {
  const location = player.getLocation();
  const trap = at(lair.key, location.getX(), location.getY());
  if (!trap?.object || trap.sprung) return;
  trap.sprung = true;
  player.sendMessage(MESSAGE);
  trap.object.performAnimation(new core.Animation(SPRING_ANIMATION));
  toLair(lair.key, (other) => other.getPacketSender()
    .sendAreaSound(SOUND.spring, location.getX(), location.getY(), location.getZ(), 1, 0, 3));
  player.getMovementQueue().reset();
  player.getTimers().registers(core.TimerKey.FREEZE, HOLD_TICKS);
  Common.later(1, () => {
    remove(lair.key, trap);
    if (player.isRegistered() && player.getHitpoints() > 0) {
      const damage = Math.floor(Math.random() * (MAX_DAMAGE + 1));
      player.getCombat().getHitQueue().addPendingDamage([new core.HitDamage(damage, damage > 0 ? core.HitMask.RED : core.HitMask.BLUE)]);
    }
  }, player);
}

/** Ends the waves; `spring` (the bear's death) springs every trap first. */
function clear(key, spring) {
  const state = stateOf(key);
  state.active = false;
  const traps = [...state.traps.values()];
  if (spring) {
    for (const trap of traps) {
      if (!trap.object) continue;
      trap.object.performAnimation(new core.Animation(SPRING_ANIMATION));
      const location = trap.location;
      toLair(key, (player) => player.getPacketSender()
        .sendAreaSound(SOUND.cleared, location.getX(), location.getY(), location.getZ(), 1, 0, 3));
    }
    Common.later(1, () => traps.forEach((trap) => remove(key, trap)));
  } else {
    traps.forEach((trap) => remove(key, trap));
  }
}

function attach(pluginApi, hooks) {
  api = pluginApi;
  core = pluginApi.core;
  playersIn = hooks.playersIn;
}

module.exports = { attach, start, clear, at, playerTick, _test: { lairs, waveTiles } };
