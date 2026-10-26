/**
 * Poachers, as recorded (rsprox 227/01855, 00083; forestry.json `poachers`):
 * - a frightened fox and three poachers appear by the tree;
 * - every 12-14 ticks a poacher sets a fox trap within two tiles of the fox, with a line ("This'll
 *   get that mangy fox!"); a trap left 13-15 ticks springs, and the fox takes a hit;
 * - Disarm: "You start disarming the trap...", then 9 ticks on "You successfully disarm the trap."
 *   and bark the next tick; the poachers grumble ("Oi, leave those traps alone!");
 * - at 200 ticks they leave ("We'll get you next time, fox!", "Let's get out of here!") and the fox
 *   leaves a gift: "Well done, you've saved the fox from the poachers! The fox has left you a
 *   gift..." with the bark lump.
 * Wiki: up to 15 traps; a sprung trap takes 33-34 of the fox's 100 HP, and at none it's lost
 * ("Unfortunately you weren't able to save the fox from the poachers..."); 11 bark a trap,
 * Woodcutting 1.5 x level and Hunter 0.5 x level a trap; 160 bark and 400 + 14.45 x level
 * Woodcutting XP for saving it.
 */
const Common = require("./Common.Forestry");
const Spawns = require("./Spawns.Forestry");

const F = () => Common.data.poachers;
/** Poacher events now on the map. */
const events = new Set();
/** Players disarming -> { event, trap, done, from }. */
const sessions = new Map();

let cycle = 0;

function start(site) {
  const poachers = F();
  const tiles = Common.freeTiles(site.location, poachers.range, site.size);
  if (tiles.length < 4) return null;
  const event = {
    site,
    elapsed: 0,
    traps: new Set(),
    set: 0,
    nextTrap: Common.randomInt(...poachers.trapEvery),
    foxHp: poachers.foxHp,
    disarmers: new Set(),
    over: false,
  };
  event.fox = Common.spawnNpc(poachers.npcs.fox, tiles[0], poachers.graphics.spawn);
  event.poachers = poachers.npcs.poachers.map((id, i) => {
    const npc = Common.spawnNpc(id, tiles[i + 1], poachers.graphics.spawn);
    Common.animate(npc, poachers.seqs.spawn);
    return npc;
  });
  events.add(event);
  Common.every(() => tick(event));
  return event;
}

function setTrap(event) {
  const poachers = F();
  const taken = [event.fox, ...event.poachers, ...[...event.traps].map((t) => t.npc)].map((npc) => npc.getLocation());
  const at = Common.freeTiles(event.fox.getLocation(), poachers.trapRange).find((tile) => !taken.some((t) => t.equals(tile)));
  if (!at) return;
  const poacher = Common.pick(event.poachers);
  Common.animate(poacher, poachers.seqs.arm);
  poacher.forceChat?.(Common.pick(poachers.chatter));
  const npc = Common.spawnNpc(poachers.npcs.trap, at);
  event.traps.add({ npc, springsAt: event.elapsed + Common.randomInt(...poachers.trapLife), disarming: false });
  event.set++;
}

function spring(event, trap) {
  const poachers = F();
  event.traps.delete(trap);
  Common.animate(trap.npc, poachers.seqs.trapSprung);
  Common.later(1, () => Common.removeNpc(trap.npc));
  Common.animate(event.fox, poachers.seqs.foxDefend);
  const damage = Common.randomInt(...poachers.springDamage);
  event.foxHp = Math.max(0, event.foxHp - damage);
  event.fox.showHitsplat?.(damage, { mine: poachers.hitsplat, others: poachers.hitsplat }, { current: event.foxHp, max: poachers.foxHp });
  if (event.foxHp <= 0) end(event, false);
}

function tick(event) {
  if (event.over) return false;
  event.elapsed++;
  const poachers = F();
  if (event.elapsed >= poachers.lifeTicks) {
    end(event, true);
    return false;
  }
  for (const trap of [...event.traps]) {
    if (!trap.disarming && event.elapsed >= trap.springsAt) spring(event, trap);
    if (event.over) return false;
  }
  if (event.elapsed >= event.nextTrap && event.set < poachers.maxTraps) {
    setTrap(event);
    event.nextTrap = event.elapsed + Common.randomInt(...poachers.trapEvery);
  }
  return true;
}

function end(event, saved) {
  if (event.over) return;
  event.over = true;
  events.delete(event);
  const poachers = F();
  for (const trap of event.traps) Common.removeNpc(trap.npc);
  event.traps.clear();
  for (const [player, session] of sessions) if (session.event === event) sessions.delete(player);
  event.poachers.forEach((npc, i) => {
    npc.forceChat?.(Common.message(i === 1 ? "poacherLeaving" : "poachersLeaving"));
    Common.animate(npc, poachers.seqs.leave, 30);
  });
  Common.tileGraphic(event.fox.getLocation(), poachers.graphics.leave);
  Common.later(1, () => {
    for (const npc of [...event.poachers, event.fox]) Common.removeNpc(npc);
  });
  const players = new Set([...event.site.participants, ...event.disarmers]);
  for (const player of players) {
    if (!saved) {
      player.sendMessage(Common.message("foxLost"));
      continue;
    }
    const gift = event.site.participants.has(player) && event.disarmers.has(player);
    player.sendMessage(Common.message(gift ? "foxSaved" : "foxSavedNoGift"));
    if (!gift) continue;
    Common.bark(player, poachers.lump, true);
    Common.xp(player, "WOODCUTTING", poachers.xp.bonusBase + poachers.xp.bonusPerLevel * Common.level(player, "WOODCUTTING"));
  }
  Spawns.ended(event);
}

function trapOf(npc) {
  for (const event of events) {
    for (const trap of event.traps) if (trap.npc === npc) return { event, trap };
  }
  return null;
}

function disarm({ player, npc }) {
  const found = trapOf(npc);
  if (!found) return false;
  const { event, trap } = found;
  if (trap.disarming) return true;
  const previous = sessions.get(player);
  if (previous) previous.trap.disarming = false;
  trap.disarming = true;
  const poachers = F();
  Common.spam(player, Common.message("startDisarm"));
  Common.animate(player, poachers.seqs.disarm);
  player.setPositionToFace?.(npc.getLocation());
  Common.pick(event.poachers).forceChat?.(Common.pick(poachers.annoyed));
  sessions.set(player, { event, trap, done: cycle + poachers.disarmTicks, from: player.getLocation().clone() });
  return true;
}

function disarmed(player, session) {
  const { event, trap } = session;
  const poachers = F();
  event.traps.delete(trap);
  Common.animate(player, poachers.seqs.disarmEnd);
  Common.animate(trap.npc, poachers.seqs.trapDisarmed);
  Common.later(1, () => Common.removeNpc(trap.npc));
  player.sendMessage(Common.message("disarmed"));
  event.disarmers.add(player);
  if (!Spawns.eligible(event, player)) {
    Common.xp(player, "WOODCUTTING", 1);
    return;
  }
  Common.xp(player, "WOODCUTTING", Common.level(player, "WOODCUTTING") * poachers.xp.woodcutting);
  Common.xp(player, "HUNTER", Common.level(player, "HUNTER") * poachers.xp.hunter);
  Common.later(1, () => Common.bark(player, poachers.trapBark));
}

/** A disarm takes 9 ticks with the player kept still; walking off leaves the trap to spring. */
function disarmTick() {
  cycle++;
  for (const [player, session] of sessions) {
    const { event, trap } = session;
    if (event.over || !event.traps.has(trap)) {
      sessions.delete(player);
      continue;
    }
    if (!player.isRegistered?.() || !player.getLocation().equals(session.from)) {
      trap.disarming = false;
      sessions.delete(player);
      continue;
    }
    if (cycle < session.done) continue;
    sessions.delete(player);
    disarmed(player, session);
  }
}

function forget({ player }) {
  const session = sessions.get(player);
  if (session) session.trap.disarming = false;
  sessions.delete(player);
}

function attachPoachers(api) {
  Spawns.registerEvent("poachers", { start });
  api.onNpcInteraction("<col=00ffff>Fox trap</col>", { Disarm: disarm });
  api.onPlayerLogout(forget);
  Common.every(disarmTick);
}

module.exports = { attachPoachers, start, disarm, disarmTick, end, events, sessions };
