/**
 * Ladders, stairs, caves and holes tsps had no working handler for, and trapdoors that open and
 * close, played as live OSRS does (docs/loc-teleports.md):
 * - data/definitions/loc-teleports.json: where a loc placement takes the player
 *   (scripts/sync-loc-teleports.cjs writes it from the rsprox capture database);
 * - data/definitions/loc-swaps.json: trapdoors whose Open/Close swaps the loc for its other state.
 *
 * - A loc nobody else handles: the generic object hook takes the click when the clicked tile
 *   and option have an entry, or the loc and option have a swap.
 * - A ladder or staircase: Ladders asks other plugins first (ladders:climb), and an entry
 *   answers before Ladders guesses from the map.
 *
 * Each plays its captured animation, sound and fade, and moves the player (or swaps the loc) on
 * the captured tick. Ticks in the data count from the player arriving at the loc; the click is
 * handled on the tick after that, as Ladders' climbs are.
 *
 * Not members-only: free-to-play ladders are in the data too. On a free-to-play world,
 * FreeToPlay moves anyone who ends up in a members area back to free land.
 */
const fs = require("fs");
const path = require("path");

const MINIMAP_STATE_VARBIT = 6719;
const MINIMAP_OFF = 2;
const OVERLAY_ATMOSPHERE_UID = (161 << 16) | 1;
const FADE_OVERLAY = 174;
const FADE_SCRIPT = 948;
const FADE_CYCLES = 50;
/** The handler runs one tick after the arrival the captured ticks count from. */
const HANDLER_TICK = 1;

let core = null;
/** "x,y,z:op" -> loc teleport entry. */
let entries = new Map();
/** "id:op" -> trapdoor swap. */
let swaps = new Map();

const keyOf = (x, y, z, op) => `${x},${y},${z}:${op}`;
/** A captured tick, counted from the click instead of the arrival. */
const fromClick = (tick) => Math.max(0, tick - HANDLER_TICK);

function readDefinitions(name) {
  return JSON.parse(fs.readFileSync(path.join(core.GameConstants.DEFINITIONS_DIRECTORY, name), "utf8"));
}

function loadEntries() {
  return new Map(readDefinitions("loc-teleports.json").locs.map((entry) => [keyOf(entry.x, entry.y, entry.z, entry.op), entry]));
}

function loadSwaps() {
  return new Map(readDefinitions("loc-swaps.json").swaps.map((swap) => [`${swap.id}:${swap.op}`, swap]));
}

function entryFor(object, clickType) {
  const location = object?.getLocation?.();
  if (!location) return null;
  const entry = entries.get(keyOf(location.getX(), location.getY(), location.getZ(), clickType));
  return entry && entry.id === object.getId() ? entry : null;
}

/** The destination for a player at `at`: the entry's, or its side nearest them (a staircase used from either end). */
function destinationFor(entry, at) {
  if (entry.to) return entry.to;
  let best = null;
  for (const side of entry.sides ?? []) {
    const distance = Math.max(Math.abs(at.getX() - side.from[0]), Math.abs(at.getY() - side.from[1]));
    if (!best || distance < best.distance) best = { distance, to: side.to };
  }
  return best?.to ?? null;
}

function fade(player, out) {
  const args = out ? [0, 255, 0, 0, FADE_CYCLES] : [0, 0, 0, 255, FADE_CYCLES];
  player.getPacketSender().sendSubInterface(OVERLAY_ATMOSPHERE_UID, FADE_OVERLAY, 1, {
    postScripts: [{ scriptId: FADE_SCRIPT, args }],
  });
}

/**
 * Runs `steps` (tick from the click -> actions) one tick at a time, with the player's movement
 * blocked until the last. Steps due on the click's own tick run now. Stops if the player leaves,
 * dies or is moved off their tile before `holdUntil`.
 */
function runSteps(player, steps, holdUntil) {
  const { Task, TaskManager } = core;
  const movement = player.getMovementQueue();
  if (movement.isMovementBlocked()) return;
  const start = player.getLocation().clone();
  const privateArea = player.getPrivateArea();
  const last = Math.max(...steps.keys());
  let tick = 0;
  const run = () => {
    for (const step of steps.get(tick) ?? []) step();
  };
  movement.setBlockMovement(true).reset();
  run();
  if (tick >= last) {
    movement.setBlockMovement(false);
    return;
  }
  TaskManager.submit(new (class extends Task {
    constructor() { super(1, player, false); }
    execute() {
      tick++;
      const moved = tick <= holdUntil && !player.getLocation().equals(start);
      if (!player.isRegistered() || player.getHitpoints() <= 0 || player.getPrivateArea() !== privateArea || moved) {
        this.stop();
        return;
      }
      run();
      if (tick >= last) this.stop();
    }
    stop() {
      movement.setBlockMovement(false);
      super.stop();
    }
  })());
}

function schedule() {
  const steps = new Map();
  const at = (tick, step) => steps.set(tick, [...(steps.get(tick) ?? []), step]);
  return { steps, at };
}

function animateAndSound(player, { anim, sound }) {
  if (anim !== undefined) player.performAnimation(new core.Animation(anim));
  if (sound !== undefined) player.getPacketSender().sendSound(sound, 1, 0);
}

/**
 * A loc teleport: animation and sound (and the fade out) on the animation's tick, the minimap
 * off a tick later, the move, then the fade back in a tick after it and the overlay closed two
 * ticks later.
 */
function travel(player, entry, destination) {
  const { steps, at } = schedule();
  const animTick = fromClick(entry.animTick ?? entry.tick);
  const moveTick = Math.max(animTick + 1, fromClick(entry.tick));
  at(animTick, () => {
    animateAndSound(player, entry);
    if (entry.fade) fade(player, true);
  });
  if (entry.fade) at(animTick + 1, () => player.getPacketSender().sendVarbit(MINIMAP_STATE_VARBIT, MINIMAP_OFF));
  at(moveTick, () => player.moveTo(new core.Location(destination[0], destination[1], destination[2])));
  if (entry.fade) {
    at(moveTick + 1, () => {
      player.getPacketSender().sendVarbit(MINIMAP_STATE_VARBIT, 0);
      fade(player, false);
    });
    at(moveTick + 3, () => player.getPacketSender().closeSubInterface(OVERLAY_ATMOSPHERE_UID));
  }
  runSteps(player, steps, moveTick);
}

/** Puts `id` in place of the loc, for everyone (the game sends it as a zone update). */
function replaceLoc(object, id) {
  const { GameObject, Location, ObjectManager } = core;
  const location = object.getLocation();
  ObjectManager.deregister(object, true);
  ObjectManager.register(new GameObject(id, new Location(location.getX(), location.getY(), location.getZ()), object.getType(), object.getFace(), null), true);
}

/** A trapdoor's Open or Close: the message, the animation and sound, then the swap. */
function swapLoc(player, object, swap) {
  const { steps, at } = schedule();
  if (swap.message) at(fromClick(swap.messageTick ?? swap.tick), () => player.sendMessage(swap.message));
  at(fromClick(swap.animTick ?? swap.tick), () => animateAndSound(player, swap));
  const swapTick = fromClick(swap.tick);
  at(swapTick, () => {
    // Someone else may have opened or closed it meanwhile.
    if (core.MapObjects.get(swap.id, object.getLocation(), object.getPrivateArea?.() ?? null) === object) replaceLoc(object, swap.becomes);
  });
  runSteps(player, steps, swapTick);
}

/** Plays the entry or swap for this click, if there is one; true when it did. */
function play(player, object, clickType) {
  const entry = entryFor(object, clickType);
  if (entry) {
    const destination = destinationFor(entry, player.getLocation());
    if (!destination) return false;
    travel(player, entry, destination);
    return true;
  }
  const swap = object ? swaps.get(`${object.getId()}:${clickType}`) : null;
  if (!swap) return false;
  swapLoc(player, object, swap);
  return true;
}

function useLoc(event) {
  if (event.handled) return;
  if (play(event.player, event.object, event.clickType)) event.handled = true;
}

/** Ladders' "does anyone own this ladder?": captured ladders and staircases answer it. */
function claimLadder(request) {
  if (request.handled) return;
  if (play(request.player, request.object, request.clickType)) request.handled = true;
}

module.exports = {
  name: "LocTeleports",
  _test: { entryFor, destinationFor, play, get entries() { return entries; }, get swaps() { return swaps; } },
  register(api) {
    core = api.core;
    entries = loadEntries();
    swaps = loadSwaps();
    api.onObjectInteraction(useLoc);
    api.onCustomEvent("ladders:climb", claimLadder);
  },
};
