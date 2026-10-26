/**
 * Rising Roots, as recorded (rsprox 227/01850 t7914-8113; forestry.json `roots`):
 * - six roots rise within four tiles of the tree, then a wave of two to four every 27 ticks, one
 *   of them anima-infused from the second wave on;
 * - a root sinks (its despawn anim) 21 ticks after it rose and is gone with the next wave; the
 *   event is over at 199 ticks;
 * - Chop down: "You swing your axe at the roots.", then a chop every four ticks.
 * Wiki: normal roots give 2-3 bark (Woodcutting 15-40) or 3-4 (41+), anima roots 8-10 or 11-13;
 * 0.55 x the Woodcutting level in XP a normal root, 1.2 x an anima one.
 * Inferred: a root goes once chopped; it is chopped at a willow's chance.
 */
const Common = require("./Common.Forestry");
const Spawns = require("./Spawns.Forestry");
const Woodcutting = require("../../skills/Woodcutting.plugin");

const R = () => Common.data.roots;
/** Root events now on the map. */
const events = new Set();
/** Players chopping a root -> { event, root, axe, next, from }. */
const sessions = new Map();

let cycle = 0;

function rootTiles(site) {
  const { range } = R();
  const [x0, y0, z] = [site.location.getX(), site.location.getY(), site.location.getZ()];
  const tiles = [];
  for (let x = x0 - range; x < x0 + site.size + range; x++) {
    for (let y = y0 - range; y < y0 + site.size + range; y++) {
      if (Common.walkable(x, y, z)) tiles.push(new Common.core.Location(x, y, z));
    }
  }
  return tiles;
}

function start(site) {
  const event = { site, roots: new Set(), elapsed: 0, waves: 0, over: false };
  if (rootTiles(site).length < R().first) return null;
  events.add(event);
  wave(event, R().first, false);
  Common.every(() => tick(event));
  return event;
}

/** The last wave's roots go; `count` new ones rise, one anima-infused when `anima`. */
function wave(event, count, anima) {
  const { locs, seqs, sound } = R();
  for (const root of event.roots) Common.removeLoc(root.object);
  event.roots.clear();
  const tiles = rootTiles(event.site);
  for (let i = 0; i < count && tiles.length; i++) {
    const at = tiles.splice(Common.randomInt(0, tiles.length - 1), 1)[0];
    const kind = anima && i === 0 ? "anima" : "normal";
    const object = Common.placeLoc(locs[kind], at);
    Common.locAnim(object, seqs.spawn);
    event.roots.add({ object, kind, born: event.elapsed });
  }
  Common.areaSound(event.site.location, sound, R().range);
  event.waves++;
}

function tick(event) {
  if (event.over) return false;
  event.elapsed++;
  const { despawnAfter, lifeTicks, waveTicks, wave: [low, high], seqs } = R();
  for (const root of event.roots) {
    if (event.elapsed - root.born === despawnAfter) Common.locAnim(root.object, seqs.despawn);
  }
  if (event.elapsed >= lifeTicks) {
    end(event);
    return false;
  }
  if (event.elapsed % waveTicks === 0) wave(event, Common.randomInt(low, high), true);
  return true;
}

function end(event) {
  event.over = true;
  events.delete(event);
  for (const root of event.roots) Common.locAnim(root.object, R().seqs.despawn);
  const left = [...event.roots];
  event.roots.clear();
  Common.later(2, () => left.forEach((root) => Common.removeLoc(root.object)));
  Spawns.ended(event);
}

function rootAt(object) {
  for (const event of events) {
    for (const root of event.roots) {
      if (root.object.getLocation().equals(object.getLocation())) return { event, root };
    }
  }
  return null;
}

function chop({ player, object }) {
  const found = rootAt(object);
  if (!found) return false;
  const axe = Woodcutting.findBestUsableAxe(player);
  if (!axe) {
    player.sendMessage(Common.message("noAxe"));
    return true;
  }
  Woodcutting.stopWoodcutting?.(player);
  Common.spam(player, Common.message("swingRoots"));
  player.setPositionToFace?.(object.getLocation());
  player.performAnimation(new Common.core.Animation(axe.animationId));
  sessions.set(player, { ...found, axe, next: cycle + R().chopTicks, from: player.getLocation().clone() });
  return true;
}

let willow = null;

function cutChance(player, axe) {
  willow ??= Woodcutting.TREES.find((tree) => tree.objectNames.includes("Willow tree"));
  return Woodcutting.calculateCutChance(Common.level(player, "WOODCUTTING"), willow, axe);
}

/** The bark band for the player's level; a boost past 99 stays in the top band. */
function rootReward(player, kind) {
  const level = Common.level(player, "WOODCUTTING");
  const bands = R().bark[kind];
  const [, low, high] = bands.find(([upTo]) => level <= upTo) ?? bands[bands.length - 1];
  return Common.randomInt(low, high);
}

function chopped(player, session) {
  const { event, root } = session;
  event.roots.delete(root);
  Common.removeLoc(root.object);
  if (!Spawns.eligible(event, player)) {
    Common.xp(player, "WOODCUTTING", 1);
    return;
  }
  Common.xp(player, "WOODCUTTING", Common.level(player, "WOODCUTTING") * R().xpPerLevel[root.kind]);
  Common.bark(player, rootReward(player, root.kind));
}

/** A chop every four ticks while the root stands and the player stays put. */
function chopTick() {
  cycle++;
  for (const [player, session] of sessions) {
    if (!player.isRegistered?.() || !session.event.roots.has(session.root) || !player.getLocation().equals(session.from)) {
      sessions.delete(player);
      continue;
    }
    if (cycle < session.next) continue;
    session.next = cycle + R().chopTicks;
    player.performAnimation(new Common.core.Animation(session.axe.animationId));
    if (Math.random() >= cutChance(player, session.axe)) continue;
    sessions.delete(player);
    player.performAnimation(Common.core.Animation.DEFAULT_RESET_ANIMATION);
    chopped(player, session);
  }
}

function forget({ player }) {
  sessions.delete(player);
}

/** Starting on a tree ends a root chop. */
function choppingTree(request) {
  if (request.allow) sessions.delete(request.player);
}

function attachRoots(api) {
  Spawns.registerEvent("roots", { start });
  api.onObjectInteraction("Tree roots", { "Chop down": chop });
  api.onObjectInteraction("Anima-infused Tree roots", { "Chop down": chop });
  api.onPlayerLogout(forget);
  api.onCustomEvent("woodcutting:validate-tree", choppingTree);
  Common.every(chopTick);
}

module.exports = { attachRoots, start, chop, chopTick, events, sessions };
