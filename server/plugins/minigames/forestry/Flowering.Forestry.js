/**
 * The Flowering Bush, as recorded (rsprox 227/00083, 01850, 237/01104 and 01108;
 * forestry.json `flowering`):
 * - eight bushes, each its own colour, and two bees appear by the tree;
 * - two bushes at a time are in flower, as a pair. Tend-to on one collects Strange pollen
 *   ("Bees are very active on this bush and there are pollen-rich flowers. You carefully collect
 *   some Strange pollen."); on the other it pollinates and takes pollen back ("...there are
 *   unpollinated flowers. You carefully apply your pollen with the help of your bee then extract
 *   some from the bush."), for bark each time;
 * - the other bushes refuse ("The flowers on this bush have not yet opened enough to harvest
 *   pollen.", "There are no open, unpollinated flowers on this bush yet.", "You took the pollen from
 *   this bush...", "The bush is already fruiting...", "This bush has finished flowering...");
 * - a pollinated pair fruits ("A bush has started producing fruit, well done!");
 * - at 300 ticks "The bushes become dormant and the bees move on...", "You discard your left
 *   over pollen.", and the lump the next tick.
 * Wiki: five pairs in turn (four of 43 s, a last of 8 s); 1-2 bark an exchange; at least one
 * exchange makes a pair fruit; the lump is 0.75-0.85 x the bark collected, with 1-8 strange fruit.
 * Inferred: which bushes pair up (no packet shows it), and that the pair's second bush fruits.
 * Calibrated: the XP (forestry.json `flowering.xp`).
 */
const Common = require("./Common.Forestry");
const Spawns = require("./Spawns.Forestry");

const F = () => Common.data.flowering;
/** Flowering bush events now on the map. */
const events = new Set();
/** Players carrying pollen -> { event, from }. */
const pollen = new Map();

function start(site) {
  const flowering = F();
  const tiles = Common.freeTiles(site.location, flowering.range, site.size);
  if (tiles.length < flowering.bushes.length) return null;
  const event = { site, bushes: [], bees: [], elapsed: 0, iteration: -1, nextChange: flowering.firstPairAt, pair: null, bark: new Map(), told: new Set(), over: false };
  flowering.bushes.forEach(([id], colour) => {
    const npc = Common.spawnNpc(id, tiles[colour], flowering.spawnGraphic);
    event.bushes.push({ npc, colour, fruited: false, finished: false });
  });
  for (let i = 0; i < 2; i++) event.bees.push(Common.spawnNpc(flowering.bees, tiles[flowering.bushes.length + i] ?? tiles[i]));
  events.add(event);
  Common.every(() => tick(event));
  return event;
}

/** The pair closes: a pollinated pair's second bush fruits, both stop flowering; the next pair opens. */
function nextPair(event) {
  const flowering = F();
  const { pair } = event;
  if (pair) {
    const [first, second] = pair.bushes;
    if (pair.exchanges > 0) {
      second.fruited = true;
      second.npc.setNpcTransformationId?.(flowering.bushes[second.colour][1]);
      const fruiting = event.bushes.filter((b) => b.fruited).length;
      for (const player of pair.helpers) player.sendMessage(Common.message(fruiting > 1 ? "fruitSome" : "fruitOne"));
    } else {
      second.finished = true;
    }
    first.finished = true;
  }
  event.iteration++;
  const open = event.bushes.filter((b) => !b.fruited && !b.finished);
  if (event.iteration >= flowering.iterations.length || open.length < 2) {
    event.pair = null;
    event.nextChange = Infinity;
    return;
  }
  const first = open.splice(Common.randomInt(0, open.length - 1), 1)[0];
  const second = Common.pick(open);
  event.pair = { bushes: [first, second], exchanges: 0, helpers: new Set() };
  event.nextChange = event.elapsed + flowering.iterations[event.iteration];
}

function tick(event) {
  if (event.over) return false;
  event.elapsed++;
  if (event.elapsed >= F().lifeTicks) {
    end(event);
    return false;
  }
  if (event.elapsed >= event.nextChange) nextPair(event);
  return true;
}

function dropPollen(player) {
  pollen.delete(player);
  const amount = player.getInventory().getAmount(F().pollen);
  if (amount > 0) player.getInventory().delete(F().pollen, amount);
  return amount > 0;
}

function end(event) {
  // The pair still open closes with the event.
  if (event.pair) nextPair(event);
  event.over = true;
  events.delete(event);
  const flowering = F();
  for (const bush of event.bushes) {
    Common.tileGraphic(bush.npc.getLocation(), flowering.spawnGraphic);
    Common.removeNpc(bush.npc);
  }
  for (const bee of event.bees) Common.removeNpc(bee);
  const fruiting = event.bushes.filter((b) => b.fruited).length;
  const players = new Set([...event.site.participants, ...event.bark.keys(), ...[...pollen].filter(([, held]) => held.event === event).map(([p]) => p)]);
  for (const player of players) {
    if (event.bark.has(player)) player.sendMessage(Common.message("dormant"));
    if (dropPollen(player)) player.sendMessage(Common.message("discardPollen"));
  }
  if (fruiting > 0) Common.later(1, () => gifts(event, fruiting));
  Spawns.ended(event);
}

/** The next tick: a share of the bark collected, strange fruit and XP for the fruiting bushes. */
function gifts(event, fruiting) {
  const flowering = F();
  for (const [player, collected] of event.bark) {
    if (!player.isRegistered?.()) continue;
    const [low, high] = flowering.lumpShare;
    Common.bark(player, Math.max(1, Math.round(collected * (low + Math.random() * (high - low)))), true);
    Common.give(player, flowering.fruit, Common.randomInt(...flowering.fruitAmount));
    Common.xp(player, "WOODCUTTING", flowering.xp.fruitPerLevel * Common.level(player, "WOODCUTTING") * fruiting);
  }
}

function bushOf(npc) {
  for (const event of events) {
    const bush = event.bushes.find((b) => b.npc === npc);
    if (bush) return { event, bush };
  }
  return null;
}

function statement(player, text) {
  const { DialogueChainBuilder, EndDialogue, StatementDialogue } = Common.core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, text)).add(new EndDialogue(1)));
}

function collect(event, player, bush) {
  if (player.getInventory().getFreeSlots() <= 0 && !player.getInventory().contains(F().pollen)) {
    player.getInventory().full?.();
    return;
  }
  Common.animate(player, F().pickup);
  if (!player.getInventory().contains(F().pollen)) player.getInventory().add(new Common.core.Item(F().pollen, 1), true);
  pollen.set(player, { event, from: bush });
  player.sendMessage(Common.message("pollenRich"));
}

function pollinate(event, player, bush) {
  const flowering = F();
  Common.animate(player, flowering.pickup);
  pollen.set(player, { event, from: bush });
  event.pair.exchanges++;
  event.pair.helpers.add(player);
  // Recorded: the long line once, then only the bark.
  if (!event.told.has(player)) {
    event.told.add(player);
    player.sendMessage(Common.message("unpollinated"));
  }
  if (!Spawns.eligible(event, player)) {
    Common.xp(player, "WOODCUTTING", 1);
    return;
  }
  const amount = Common.randomInt(...flowering.bark);
  event.bark.set(player, (event.bark.get(player) ?? 0) + amount);
  Common.bark(player, amount);
  Common.xp(player, "WOODCUTTING", flowering.xp.perLevel * Common.level(player, "WOODCUTTING") + flowering.xp.plus);
}

function tend({ player, npc }) {
  const found = bushOf(npc);
  if (!found) return false;
  const { event, bush } = found;
  if (Common.busy(player, F().actionTicks)) return true;
  if (bush.fruited) {
    player.sendMessage(Common.message("fruiting"));
    return true;
  }
  if (bush.finished) {
    player.sendMessage(Common.message("finished"));
    return true;
  }
  const held = pollen.get(player);
  const holding = held?.event === event && player.getInventory().contains(F().pollen) && event.pair?.bushes.includes(held.from);
  if (!event.pair?.bushes.includes(bush)) {
    if (holding) player.sendMessage(Common.message("noUnpollinated"));
    else statement(player, Common.message("notOpen"));
    return true;
  }
  if (!holding) collect(event, player, bush);
  else if (held.from === bush) player.sendMessage(Common.message("sameBush"));
  else pollinate(event, player, bush);
  return true;
}

function forget({ player }) {
  dropPollen(player);
}

function attachFlowering(api) {
  Spawns.registerEvent("flowering", { start });
  for (const colour of Common.data.flowering.names) {
    api.onNpcInteraction(`<col=00ffff>Flowering bush (${colour})</col>`, { "Tend-to": tend });
    api.onNpcInteraction(`<col=00ffff>Strange bush (${colour})</col>`, { "Tend-to": tend });
  }
  api.onPlayerLogout(forget);
}

module.exports = { attachFlowering, start, tend, nextPair, events, pollen };
