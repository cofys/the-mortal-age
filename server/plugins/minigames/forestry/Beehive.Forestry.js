/**
 * The Beehive, as recorded (rsprox 227/01855, 237/01104, 01098; forestry.json `beehive`):
 * - the bee keeper ("Oh, Bees!"), an unfinished beehive, the wild hive and bees appear by the tree;
 * - Build adds the player's logs to the hive, one every two ticks with the pickup seq, filling its
 *   bar (headbar 17); at 60% it changes form, full it's complete: "Well done, you've completed a
 *   beehive. The bees can now be safely rehomed.", the keeper's "Come with me little bees I'll keep
 *   you safe.", and bark the next tick (sometimes sturdy beehive parts: "The temporary beehive was
 *   made so well you take some parts for building a permanent hive.");
 * - a new unfinished hive appears within three tiles with a puff of smoke, the old one goes four
 *   ticks later;
 * - at 247 ticks "Well, I must be getting on now."; at 250 all is gone.
 * Wiki: 5 logs a player (at most 50) a hive; bark and XP a log by its tier; 25-30 bark and
 * 5.45x - 0.02x^2 Woodcutting XP a hive; parts 2/3 of the time. Calibrated: Build adds logs until
 * the hive is done or the player runs out (live asks how many).
 */
const Common = require("./Common.Forestry");
const Spawns = require("./Spawns.Forestry");

const B = () => Common.data.beehive;
/** Beehive events now on the map. */
const events = new Set();
/** Players building -> { event, box, next, from }. */
const sessions = new Map();

let cycle = 0;
/** When each player may next add a log, so clicking Build again can't hurry it. */
const nextLog = new WeakMap();

function start(site) {
  const beehive = B();
  const tiles = Common.freeTiles(site.location, beehive.range, site.size);
  if (tiles.length < 4) return null;
  const event = { site, elapsed: 0, needed: Math.min(beehive.maxLogs, beehive.logsPerPlayer * Math.max(1, site.participants.size)), over: false };
  event.keeper = Common.spawnNpc(beehive.npcs.keeper, tiles[0]);
  event.keeper.forceChat?.(beehive.lines.start);
  event.wild = Common.spawnNpc(beehive.npcs.wild, tiles[1]);
  event.bees = [Common.spawnNpc(beehive.npcs.bees, tiles[1]), Common.spawnNpc(beehive.npcs.bees, tiles[1])];
  event.box = newBox(event, tiles[2]);
  events.add(event);
  Common.every(() => tick(event));
  return event;
}

function newBox(event, at) {
  const box = { npc: Common.spawnNpc(B().npcs.boxes[0], at), logs: 0, builders: new Set(), done: false };
  showFill(event, box);
  return box;
}

function showFill(event, box) {
  const { id, width } = B().headbar;
  box.npc.showHeadbar?.(id, { fill: Math.round((width * box.logs) / event.needed) });
}

function tick(event) {
  if (event.over) return false;
  event.elapsed++;
  const { lifeTicks, byeAt, lines } = B();
  if (event.elapsed === byeAt) event.keeper.forceChat?.(lines.bye);
  if (event.elapsed >= lifeTicks) {
    end(event);
    return false;
  }
  return true;
}

function end(event) {
  event.over = true;
  events.delete(event);
  for (const [player, session] of sessions) if (session.event === event) sessions.delete(player);
  for (const npc of [event.keeper, event.wild, ...event.bees, event.box.npc]) Common.removeNpc(npc);
  Spawns.ended(event);
}

/** The first logs in the pack Build takes, with their tier. */
function logsIn(player) {
  const { tiers } = B();
  for (const tier of ["normal", "oak", "better"]) {
    for (const id of tiers[tier].logs) if (player.getInventory().contains(id)) return { id, tier: tiers[tier] };
  }
  return null;
}

function boxOf(npc) {
  for (const event of events) if (event.box.npc === npc && !event.box.done) return event;
  return null;
}

function build({ player, npc }) {
  const event = boxOf(npc);
  if (!event) return false;
  if (!logsIn(player)) {
    player.sendMessage(Common.message("noLogs"));
    return true;
  }
  player.setPositionToFace?.(npc.getLocation());
  const current = sessions.get(player);
  if (current?.box === event.box && player.getLocation().equals(current.from)) return true;
  sessions.set(player, { event, box: event.box, next: Math.max(cycle, nextLog.get(player) ?? 0), from: player.getLocation().clone() });
  return true;
}

function addLog(player, session) {
  const { event, box } = session;
  const logs = logsIn(player);
  if (!logs) return false;
  const beehive = B();
  player.getInventory().delete(logs.id, 1);
  Common.animate(player, beehive.pickup);
  box.logs++;
  box.builders.add(player);
  showFill(event, box);
  if (Spawns.eligible(event, player)) {
    Common.bark(player, Common.randomInt(...logs.tier.bark));
    const [low, high] = logs.tier.woodcutting;
    Common.xp(player, "WOODCUTTING", Common.level(player, "WOODCUTTING") * (low + Math.random() * (high - low)));
    Common.xp(player, "CONSTRUCTION", Common.level(player, "CONSTRUCTION") * logs.tier.construction);
  } else {
    Common.xp(player, "WOODCUTTING", 1);
  }
  if (box.logs >= event.needed) complete(event, box);
  else if (box.logs / event.needed >= beehive.headbar.secondForm) box.npc.setNpcTransformationId?.(beehive.npcs.boxes[1]);
  return true;
}

/** The hive is done: its builders' lump next tick, and a fresh hive nearby. */
function complete(event, box) {
  const beehive = B();
  box.done = true;
  box.npc.setNpcTransformationId?.(beehive.npcs.boxes[2]);
  event.keeper.forceChat?.(beehive.lines.done);
  for (const player of box.builders) player.sendMessage(Common.message("hiveDone"));
  Common.later(1, () => {
    for (const player of box.builders) {
      if (!player.isRegistered?.() || !event.site.participants.has(player)) continue;
      Common.bark(player, Common.randomInt(...beehive.hiveBark), true);
      const level = Common.level(player, "WOODCUTTING");
      Common.xp(player, "WOODCUTTING", 5.45 * level - 0.02 * level * level);
      if (Math.random() < beehive.partsChance) {
        Common.give(player, beehive.parts, 1);
        player.sendMessage(Common.message("hiveParts"));
      }
    }
  });
  // No room elsewhere: the next one goes where this one stood.
  const at = Common.freeTiles(box.npc.getLocation(), beehive.range).find((tile) => !tile.equals(box.npc.getLocation())) ?? box.npc.getLocation().clone();
  event.box = newBox(event, at);
  Common.tileGraphic(at, beehive.smoke);
  event.keeper.forceChat?.(Common.pick(beehive.lines.rehome));
  Common.later(beehive.doneRemoveTicks, () => Common.removeNpc(box.npc));
}

/** A log every two ticks while the player stays and the hive needs them. */
function buildTick() {
  cycle++;
  for (const [player, session] of sessions) {
    if (!player.isRegistered?.() || session.event.over || session.box.done || !player.getLocation().equals(session.from)) {
      sessions.delete(player);
      continue;
    }
    if (cycle < session.next) continue;
    session.next = cycle + B().logTicks;
    nextLog.set(player, session.next);
    if (!addLog(player, session)) sessions.delete(player);
  }
}

function forget({ player }) {
  sessions.delete(player);
}

/** Anything else the player clicks ends their building. */
function otherAction({ player, npc }) {
  const session = sessions.get(player);
  if (session && npc !== session.box.npc) sessions.delete(player);
}

function attachBeehive(api) {
  Spawns.registerEvent("beehive", { start });
  api.onNpcInteraction("<col=00ffff>Unfinished Beehive</col>", { Build: build });
  api.onPlayerLogout(forget);
  api.onNpcInteraction(otherAction);
  api.onObjectInteraction(otherAction);
  Common.every(buildTick);
}

module.exports = { attachBeehive, start, build, buildTick, events, sessions };
