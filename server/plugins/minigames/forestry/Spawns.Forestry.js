/**
 * When and where a Forestry event appears, and who it rewards (forestry.json `spawn`).
 *
 * Wiki:
 * - events come from overworld trees except the regular, burnt, hollow, blisterwood and
 *   Woodcutting Guild ones, and need a chopper with a forestry kit;
 * - there are 40-120 s between events, and none appears within 30 tiles of another;
 * - full rewards need a chop within 30 tiles of the event's tree in the 3 minutes before it
 *   started.
 * Recorded:
 * - the first event came 19-29 ticks into chopping, always the tick after a log;
 * - the spawn stops the chopping;
 * - a late joiner gets "As you weren't chopping near the event when it started, you aren't
 *   eligible for full rewards." and almost nothing.
 * Wiki: an event comes at a random point while the tree stands, or when it falls.
 * Calibrated: 20-200 ticks of chopping before an event (sooner if the tree falls), and the
 * buffer as 67-200 ticks after the last (forestry.json `spawn.chopTicks` / `cooldownTicks`).
 */
const Common = require("./Common.Forestry");
const Woodcutting = require("../../skills/Woodcutting.plugin");
const Guild = require("../../skills/woodcutting/Guild.Woodcutting");

/**
 * Event units by name: { start(site) -> event, takesTree? }, registered by each event's unit. One
 * that takes the tree's place (the sapling) keeps the tree from falling or growing back meanwhile.
 */
const EVENT_TYPES = new Map();
/** Events now on the map. */
const active = new Set();
/** Choppers -> { object, location, name, size, lastChop, chopped, needed }. */
const choppers = new Map();
/** When each player (by name, so a relog doesn't clear it) may next bring an event. */
const readyAt = new Map();
/** Events' ends: no new one within 30 tiles until the buffer is over. */
const quiet = [];
/** Trees an event has taken, by tile. */
const heldTrees = new Set();
const tileKey = (location) => `${location.getX()},${location.getY()},${location.getZ()}`;

let now = 0;

function registerEvent(name, unit) {
  EVENT_TYPES.set(name, unit);
}

function treeName(object) {
  return Common.core.CacheDefinitions.getObject(object.getId())?.name ?? "";
}

function eligibleTree(name) {
  return Object.hasOwn(Common.data.trees, name);
}

const roll = ([low, high]) => Common.randomInt(low, high);

/** Woodcutting started on a tree: remember it. */
function choppingStarted(request) {
  const { player, object } = request;
  if (!request.allow || !object) return;
  const record = choppers.get(player);
  const definition = Common.core.CacheDefinitions.getObject(object.getId());
  choppers.set(player, {
    object,
    location: object.getLocation().clone(),
    name: definition?.name ?? "",
    size: Math.max(1, definition?.sizeX ?? 1),
    lastChop: now,
    chopped: record?.chopped ?? 0,
    needed: record?.needed ?? roll(Common.data.spawn.chopTicks),
  });
}

/** A tree an event has taken can't be chopped (the event's loc stands over it). */
function refuseHeldTree(request) {
  if (request.object && heldTrees.has(tileKey(request.object.getLocation()))) request.allow = false;
}

function quietNear(location) {
  const { radius } = Common.data.spawn;
  for (let i = quiet.length - 1; i >= 0; i--) {
    if (now >= quiet[i].until) quiet.splice(i, 1);
    else if (quiet[i].location.getZ() === location.getZ() && Common.distance(quiet[i].location, location) <= radius) return true;
  }
  return false;
}

function eventNear(location) {
  for (const event of active) {
    if (event.location.getZ() === location.getZ() && Common.distance(event.location, location) <= Common.data.spawn.radius) return event;
  }
  return null;
}

/** Whoever chopped within 30 tiles of `location` in the last 3 minutes. */
function recentChoppersNear(location) {
  const { radius, recentTicks } = Common.data.spawn;
  const players = [];
  for (const [player, record] of choppers) {
    if (!player.isRegistered?.()) continue;
    if (record.location.getZ() !== location.getZ() || Common.distance(record.location, location) > radius) continue;
    if (now - record.lastChop <= recentTicks) players.push(player);
  }
  return players;
}

/** A log: the tree may now bring an event, if its choppers have chopped long enough. */
function logChopped({ player }) {
  const record = choppers.get(player);
  if (record && record.chopped >= record.needed) trySpawn(player, record);
}

/**
 * A tree fell: it brings an event if its chopper is past the buffer. Returns the event's name, or
 * null.
 */
function trySpawn(player, record) {
  if (!eligibleTree(record.name) || Guild.isInGuild(player) || EVENT_TYPES.size === 0) return null;
  if (now < (readyAt.get(player.getUsername()) ?? 0) || eventNear(record.location) || quietNear(record.location)) return null;
  const nearby = recentChoppersNear(record.location);
  if (!nearby.some(Common.hasKit)) return null;
  const name = Common.pick([...EVENT_TYPES.keys()]);
  // Recorded: the event comes the tick after the log. Until then the spot is taken.
  const pending = { location: record.location.clone(), participants: new Set() };
  active.add(pending);
  if (EVENT_TYPES.get(name).takesTree) heldTrees.add(tileKey(record.location));
  Common.later(1, () => {
    active.delete(pending);
    if (!spawn(record, nearby, name)) heldTrees.delete(tileKey(record.location));
  });
  return name;
}

function spawn(record, participants, name = Common.pick([...EVENT_TYPES.keys()])) {
  const site = { tree: record.object, location: record.location.clone(), name: record.name, size: record.size, participants: new Set(participants) };
  const event = EVENT_TYPES.get(name).start(site);
  if (!event) return null;
  if (EVENT_TYPES.get(name).takesTree) heldTrees.add(tileKey(site.location));
  for (const player of participants) {
    Woodcutting.stopWoodcutting?.(player);
    const chopper = choppers.get(player);
    if (chopper) chopper.chopped = 0;
  }
  event.kind = name;
  event.location = site.location;
  event.participants = site.participants;
  event.warned = new Set();
  active.add(event);
  return event;
}

/**
 * An event is over: there's a buffer before the next near it, and its choppers start counting
 * again. A tree it took stays held until the event gives it back (`releaseTree`).
 */
function ended(event) {
  active.delete(event);
  const until = now + roll(Common.data.spawn.cooldownTicks);
  quiet.push({ location: event.location, until });
  for (const player of event.participants) {
    readyAt.set(player.getUsername(), until);
    const chopper = choppers.get(player);
    if (!chopper) continue;
    chopper.chopped = 0;
    chopper.needed = roll(Common.data.spawn.chopTicks);
  }
}

function releaseTree(location) {
  heldTrees.delete(tileKey(location));
}

/** Whether the player gets full rewards from `event`; tells a late joiner once why not. */
function eligible(event, player) {
  if (event.participants.has(player)) return true;
  if (!event.warned.has(player)) {
    event.warned.add(player);
    player.sendMessage(Common.message("ineligible"));
  }
  return false;
}

function tick() {
  now++;
  for (const [player, record] of choppers) {
    if (!player.isRegistered?.()) {
      choppers.delete(player);
      continue;
    }
    if (Woodcutting.isWoodcuttingActive(player)) {
      record.lastChop = now;
      record.chopped++;
    }
  }
}

function forget({ player }) {
  choppers.delete(player);
}

/**
 * A tree is falling. One an event has taken neither falls nor grows back (the event puts it back).
 * Otherwise the fall may bring an event, which takes the stump's place when it takes the tree's.
 */
function treeFalling(event) {
  if (heldTrees.has(tileKey(event.object.getLocation()))) {
    event.handled = true;
    return;
  }
  const record = choppers.get(event.player);
  if (!record || !record.location.equals(event.object.getLocation()) || record.chopped <= 0) return;
  const name = trySpawn(event.player, record);
  if (name && EVENT_TYPES.get(name).takesTree) event.handled = true;
}

function attachSpawns(api) {
  api.onCustomEvent("woodcutting:validate-tree", refuseHeldTree);
  api.onCustomEvent("woodcutting:validate-tree", choppingStarted);
  api.onCustomEvent("woodcutting:success", logChopped);
  api.onCustomEvent("woodcutting:deplete-tree", treeFalling);
  api.onPlayerLogout(forget);
  Common.every(tick);
}

module.exports = {
  attachSpawns,
  registerEvent,
  spawn,
  ended,
  releaseTree,
  refuseHeldTree,
  eligible,
  eligibleTree,
  choppingStarted,
  logChopped,
  tick,
  treeFalling,
  choppers,
  heldTrees,
  readyAt,
  quiet,
  active,
  EVENT_TYPES,
  treeName,
};
