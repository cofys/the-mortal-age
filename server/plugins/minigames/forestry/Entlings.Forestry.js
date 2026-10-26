/**
 * Entlings, as recorded (rsprox 237/01104, 227/01723, 237/01098; forestry.json `entlings`):
 * - five entlings appear by the tree, each calling for a cut ("Short on top!", "Breezy at the
 *   back!", "Short back and sides!", "A leafy mullet!");
 * - Prune asks "Which area of the entling would you like to prune?" (Top / Back / Sides /
 *   Cancel); Prune-top, Prune-back and Prune-sides cut at once: "You prune the entling." and bark;
 * - done, an entling is pruned and thanks the player ("That feels better! Thanks!"); pruning it
 *   again ("Hey, my cut is perfect, leave it alone!") or the wrong cut ("Woah, that's not the cut I
 *   asked for!") stuns;
 * - "Almost time to go!" at 155 ticks; at 200 they leave: "Well done, you've given N entlings
 *   haircuts! The entlings have left you a gift..." with bark and leaves.
 * Wiki: a leafy mullet is top and sides; 4-5 bark a prune, 0.5 x Woodcutting and 0.2 x Fletching
 * level in XP; 25 bark, 4 leaves and 3 x level Woodcutting XP for each fully pruned entling; a
 * 3 s stun. Calibrated: 10-20 prunes an entling, split over the areas it wants.
 */
const Common = require("./Common.Forestry");
const Spawns = require("./Spawns.Forestry");

const E = () => Common.data.entlings;
/** Entling events now on the map. */
const events = new Set();

function start(site) {
  const entlings = E();
  const tiles = Common.freeTiles(site.location, entlings.range, site.size);
  if (tiles.length < entlings.count) return null;
  const event = { site, entlings: [], elapsed: 0, haircuts: new Map(), over: false };
  for (let i = 0; i < entlings.count; i++) {
    const [say, areas] = Common.pick(entlings.requests);
    const total = Common.randomInt(...entlings.prunes);
    const needs = Object.fromEntries(areas.map((area, n) => [area, n === 0 ? Math.ceil(total / areas.length) : Math.floor(total / areas.length)]));
    const npc = Common.spawnNpc(entlings.npcs.entling, tiles[i], entlings.graphics.spawn);
    Common.animate(npc, entlings.seqs.spawn);
    event.entlings.push({ npc, say, needs, helpers: new Set(), pruned: false });
  }
  events.add(event);
  Common.every(() => tick(event));
  return event;
}

function tick(event) {
  if (event.over) return false;
  event.elapsed++;
  const { lifeTicks, warnAt, sayEvery } = E();
  if (event.elapsed >= lifeTicks) {
    end(event);
    return false;
  }
  for (const entling of event.entlings) {
    if (event.elapsed === warnAt) entling.npc.forceChat?.(Common.message("almostGo"));
    else if (!entling.pruned && event.elapsed % sayEvery === 1) entling.npc.forceChat?.(entling.say);
  }
  return true;
}

function end(event) {
  event.over = true;
  events.delete(event);
  const entlings = E();
  for (const entling of event.entlings) {
    Common.animate(entling.npc, entlings.seqs.despawn);
    Common.tileGraphic(entling.npc.getLocation(), entlings.graphics.leave);
  }
  Common.later(1, () => event.entlings.forEach((e) => Common.removeNpc(e.npc)));
  for (const [player, count] of event.haircuts) {
    if (count <= 0 || !player.isRegistered?.() || !Spawns.eligible(event, player)) continue;
    player.sendMessage(Common.message("haircuts", { count }));
    Common.bark(player, entlings.barkPerEntling * count, true);
    const leaves = Common.data.trees[event.site.name] ?? "Leaves";
    const amount = entlings.leavesPerEntling * count;
    Common.give(player, Common.data.leaves[leaves], amount);
    player.sendMessage(Common.message("leaves", { amount, leaves }));
    Common.xp(player, "WOODCUTTING", entlings.xp.bonusPerLevel * Common.level(player, "WOODCUTTING") * count);
  }
  Spawns.ended(event);
}

function entlingOf(npc) {
  for (const event of events) {
    const entling = event.entlings.find((e) => e.npc === npc);
    if (entling) return { event, entling };
  }
  return null;
}

function stun(player, entling, line) {
  const { seqs, graphics, stunTicks, npcs } = E();
  Common.chat(player, entling.pruned ? npcs.pruned : npcs.entling, [["npc", line]]);
  Common.animate(player, seqs.stunned);
  player.performGraphic?.(new Common.core.Graphic(graphics.stun));
  player.getMovementQueue?.().reset?.();
  player.getTimers?.().registers?.(Common.core.TimerKey.STUN, stunTicks);
}

function prune(player, event, entling, area) {
  if (event.over || player.getTimers?.().has?.(Common.core.TimerKey.STUN)) return;
  const entlings = E();
  if (Common.distance(player.getLocation(), entling.npc.getLocation()) > 1) return;
  if (Common.busy(player, entlings.actionTicks)) return;
  if (entling.pruned) {
    stun(player, entling, Common.message("leaveAlone"));
    entling.npc.forceChat?.(Common.message("leaveAloneSay"));
    return;
  }
  if (!(entling.needs[area] > 0)) {
    stun(player, entling, Common.message("wrongCut"));
    return;
  }
  player.setPositionToFace?.(entling.npc.getLocation());
  Common.animate(player, entlings.seqs.prune);
  Common.spam(player, Common.message("prune"));
  entling.needs[area]--;
  entling.helpers.add(player);
  if (Spawns.eligible(event, player)) {
    Common.bark(player, Common.randomInt(...entlings.bark));
    Common.xp(player, "WOODCUTTING", entlings.xp.woodcutting * Common.level(player, "WOODCUTTING"));
    Common.xp(player, "FLETCHING", entlings.xp.fletching * Common.level(player, "FLETCHING"));
  } else {
    Common.xp(player, "WOODCUTTING", 1);
  }
  if (Object.values(entling.needs).every((left) => left <= 0)) {
    entling.pruned = true;
    entling.npc.setNpcTransformationId?.(entlings.npcs.pruned);
    entling.npc.forceChat?.(Common.pick(entlings.thanks));
    for (const helper of entling.helpers) event.haircuts.set(helper, (event.haircuts.get(helper) ?? 0) + 1);
  }
}

function direct(area) {
  return ({ player, npc }) => {
    const found = entlingOf(npc);
    if (!found) return false;
    prune(player, found.event, found.entling, area);
    return true;
  };
}

/** Prune: the recorded menu, then the cut chosen. */
function choose({ player, npc }) {
  const found = entlingOf(npc);
  if (!found) return false;
  const pick = (area) => () => prune(player, found.event, found.entling, area);
  Common.api.sendMultiChatboxPrompt(player, Common.message("pruneMenu"),
    "Top", pick("top"), "Back", pick("back"), "Sides", pick("sides"), "Cancel", () => {});
  return true;
}

function attachEntlings(api) {
  Spawns.registerEvent("entlings", { start });
  const ops = { Prune: choose, "Prune-top": direct("top"), "Prune-back": direct("back"), "Prune-sides": direct("sides") };
  api.onNpcInteraction("Entling", ops);
  api.onNpcInteraction("Pruned Entling", ops);
}

module.exports = { attachEntlings, start, prune, events };
