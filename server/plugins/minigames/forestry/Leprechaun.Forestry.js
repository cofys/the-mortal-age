/**
 * The Woodcutting Leprechaun, as recorded (rsprox 227/01850, 00083, 01723, 01855, 237/01104 and
 * 01098; forestry.json `leprechaun`):
 * - he appears on a clover by the tree: "It be yer lucky day, Foresters!";
 * - an End of Rainbow comes within 1-9 tiles every 37 ticks and fades 17-20 ticks later;
 *   standing in it: "You feel more in touch with the trees after standing in the rainbow.", and 12
 *   more luck (varbit 15344; its slot in 15343);
 * - each log then spends 5 luck on 22-23 bark: "You use your leprechaun's luck to gather some
 *   Anima-infused bark." ("You use the last of your leprechaun's luck..." when it runs out);
 * - Talk-to, and Deposit: "Bank all the items in your inventory?" (all of it, only woodcutting
 *   resources, nothing, or the deposit box);
 * - "I'll have to go shortly..." at 186 ticks, "Well, I must be getting on now." at 223, gone at
 *   224, the luck with him.
 * Wiki: six rainbows; a luck log's XP is about 1.33 x level + 38.7 more [confirmation needed]; he
 * banks everything for those who were chopping, else only woodcutting resources.
 */
const Common = require("./Common.Forestry");
const Spawns = require("./Spawns.Forestry");
const Woodcutting = require("../../skills/Woodcutting.plugin");

const L = () => Common.data.leprechaun;
/** Leprechauns now on the map. */
const events = new Set();
/** Luck by player -> { amount, event }: only while the leprechaun that gave it is out. */
const luck = new Map();
/** How near him the Deposit menu still works. */
const BANK_RANGE = 3;

function start(site) {
  const lep = L();
  const tiles = Common.freeTiles(site.location, 3, site.size);
  if (tiles.length < 1) return null;
  const event = { site, elapsed: 0, rainbows: [], made: 0, over: false };
  event.clover = Common.placeLoc(lep.locs.clover, tiles[0]);
  event.npc = Common.spawnNpc(lep.npc, tiles[0]);
  event.npc.forceChat?.(lep.lines.start);
  events.add(event);
  Common.every(() => tick(event));
  return event;
}

function setLuck(player, event, value) {
  if (value > 0) luck.set(player, { amount: value, event });
  else luck.delete(player);
  player.getPacketSender().sendVarbit?.(L().varbits.luck, Math.max(0, Math.min(255, value)));
}

function luckOf(player) {
  const held = luck.get(player);
  return held && !held.event.over ? held.amount : 0;
}

function rainbow(event) {
  const lep = L();
  const [near, far] = lep.rainbowRange;
  const here = event.npc.getLocation();
  const at = Common.freeTiles(here, far).find((tile) => Common.distance(tile, here) >= near);
  if (!at) return;
  event.made++;
  const life = Common.randomInt(...lep.rainbowLife);
  event.rainbows.push({ object: Common.placeLoc(lep.locs.rainbow, at), at, slot: event.made, goneAt: event.elapsed + life, stood: new Set() });
}

/** Whoever stands in a rainbow gets its luck, once. */
function standIn(event) {
  const lep = L();
  for (const bow of event.rainbows) {
    const players = new Set([...event.site.participants, ...Common.nearbyPlayers(bow.at, 0)]);
    for (const player of players) {
      if (bow.stood.has(player) || !player.getLocation().equals(bow.at)) continue;
      bow.stood.add(player);
      if (!Spawns.eligible(event, player)) continue;
      player.sendMessage(Common.message("rainbow"));
      const held = luck.get(player);
      const base = held?.event === event ? held.amount : lep.baseLuck;
      setLuck(player, event, base + lep.luckPerRainbow);
      player.getPacketSender().sendVarbit?.(lep.varbits.slot, bow.slot);
    }
  }
}

function tick(event) {
  if (event.over) return false;
  event.elapsed++;
  const lep = L();
  if (event.elapsed === lep.warnAt) event.npc.forceChat?.(lep.lines.warn);
  if (event.elapsed === lep.byeAt) event.npc.forceChat?.(lep.lines.bye);
  if (event.elapsed >= lep.lifeTicks) {
    end(event);
    return false;
  }
  if (event.made < lep.rainbows && (event.elapsed - 1) % lep.rainbowEvery === 0) rainbow(event);
  for (const bow of [...event.rainbows]) {
    if (event.elapsed === bow.goneAt - 3) Common.locAnim(bow.object, lep.seqs.rainbowGone);
    if (event.elapsed >= bow.goneAt) {
      Common.removeLoc(bow.object);
      event.rainbows.splice(event.rainbows.indexOf(bow), 1);
    }
  }
  standIn(event);
  return true;
}

function end(event) {
  event.over = true;
  events.delete(event);
  for (const bow of event.rainbows) Common.removeLoc(bow.object);
  event.rainbows = [];
  Common.removeLoc(event.clover);
  Common.removeNpc(event.npc);
  for (const [player, held] of [...luck]) {
    if (held.event !== event) continue;
    setLuck(player, event, 0);
    player.getPacketSender().sendVarbit?.(L().varbits.slot, 0);
  }
  Spawns.ended(event);
}

/** A log with luck to spend: bark instead of nothing more, and the extra XP. */
function logChopped({ player }) {
  const lep = L();
  const left = luckOf(player);
  if (left < lep.luckPerLog) return;
  const record = Spawns.choppers.get(player);
  if (!record || !Spawns.eligibleTree(record.name)) return;
  const after = left - lep.luckPerLog;
  setLuck(player, luck.get(player).event, after);
  Common.spam(player, Common.message(after < lep.luckPerLog ? "lastLuck" : "luck"));
  Common.bark(player, Common.randomInt(...lep.bark));
  Common.xp(player, "WOODCUTTING", lep.xp.perLevel * Common.level(player, "WOODCUTTING") + lep.xp.plus);
}

function eventOf(npc) {
  for (const event of events) if (event.npc === npc) return event;
  return null;
}

function talk({ player, npc }) {
  const event = eventOf(npc);
  if (!event) return false;
  const lines = [["npc", L().lines.talk]];
  if (event.site.participants.has(player)) lines.push(["npc", L().lines.talkBank]);
  Common.chat(player, L().npc, lines);
  return true;
}

function woodcuttingResource(id) {
  return Woodcutting.TREES.some((tree) => tree.logId === id) || Object.values(Common.data.leaves).includes(id) || id === Common.data.items.bark;
}

/** Banks what he will: all of it for those who were chopping, else woodcutting resources. */
function nearHim(player, event) {
  return !event.over && Common.distance(player.getLocation(), event.npc.getLocation()) <= BANK_RANGE;
}

function bankItems(player, event, onlyResources) {
  if (!nearHim(player, event)) return;
  const { Bank } = Common.core;
  if (Common.api.emitCanBank?.(player, "forestry-leprechaun") === false) return;
  const everything = !onlyResources && event.site.participants.has(player);
  const inventory = player.getInventory();
  let refused = false;
  let banked = false;
  inventory.getItems().forEach((item, slot) => {
    if (!item || item.getId() <= 0) return;
    if (!everything && !woodcuttingResource(item.getId())) return;
    const before = inventory.getAmount(item.getId());
    Bank.deposit(player, item.getId(), slot, item.getAmount(), true);
    if (inventory.getAmount(item.getId()) < before) banked = true;
    else refused = true;
  });
  inventory.refreshItems?.();
  if (banked) Common.animate(player, L().seqs.deposit);
  if (refused) player.sendMessage(Common.message("cantBank"));
}

function deposit({ player, npc }) {
  const event = eventOf(npc);
  if (!event) return false;
  const [title, all, resources, none, box] = L().bankMenu;
  Common.api.sendMultiChatboxPrompt(player, title,
    all, () => bankItems(player, event, false),
    resources, () => bankItems(player, event, true),
    none, () => {},
    box, () => {
      if (nearHim(player, event)) Common.api.emitCustomEvent("bank:open-deposit-box", { player });
    });
  return true;
}

function forget({ player }) {
  luck.delete(player);
}

function attachLeprechaun(api) {
  Spawns.registerEvent("leprechaun", { start });
  api.onCustomEvent("woodcutting:success", logChopped);
  api.onNpcInteraction("Woodcutting Leprechaun", { "Talk-to": talk, Deposit: deposit });
  api.onPlayerLogout(forget);
}

module.exports = { attachLeprechaun, start, logChopped, deposit, events, luck, luckOf };
