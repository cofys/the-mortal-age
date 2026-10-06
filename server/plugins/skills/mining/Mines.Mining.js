/**
 * Mining mines: where you swing matters as much as what you swing at.
 *
 * Named mines drawn on real OSRS geography (the world comes from the cache),
 * each with its own character: the safe crowded Dwarven Mine, the guild-kept
 * Mining Guild, Al Kharid's hot pits, Keldagrim's sunless workings, and the
 * Deep Delve's dangerous richness. A mine scales the XP of every yield inside
 * it and sometimes yields a bonus ore from a rich seam, and stamps event.mine
 * on "mining:ore-yield"/"mining:success" for the later depth modules.
 *
 * The Rich Vein: a rich vein surfaces in one mine at a time for ~30 minutes -
 * every yield there lands a bonus ore and +50% XP. Nobody is told directly:
 * arrival and departure seed citizen rumors and gossip, so the first pick
 * there gets rich. Every load cut on a vein feeds the war effort
 * (see Supply.Mining).
 *
 * Attaches first of the depth modules: it stamps event.mine / event.vein for
 * Hazards/Wilderness/Mastery/Supply.
 */
const { spreadRumor } = require("./Rumors.Mining");

const MINES = Object.freeze([
  {
    name: "the Dwarven Mine", short: "dwarven",
    x1: 3030, x2: 3060, y1: 9770, y2: 9850, z: 0, kingdom: "asgarnia",
    xp: 1.0, rich: 0.05, blurb: "iron and coal under Falador - safe, crowded",
  },
  {
    name: "the Mining Guild", short: "guild",
    x1: 3015, x2: 3055, y1: 9690, y2: 9730, z: 0, kingdom: "asgarnia",
    xp: 1.05, rich: 0.05, blurb: "guild-kept coal seams, bank nearby",
  },
  {
    name: "the Al Kharid mine", short: "alkharid",
    x1: 3270, x2: 3300, y1: 3315, y2: 3345, z: 0, kingdom: "misthalin",
    xp: 1.0, rich: 0.05, blurb: "hot pits on the Misthalin marches",
  },
  {
    name: "the Keldagrim mines", short: "keldagrim",
    x1: 2840, x2: 2880, y1: 10180, y2: 10220, z: 0, kingdom: "keldagrim",
    xp: 1.1, rich: 0.1, blurb: "the city that never sees the sun",
  },
  {
    name: "the Deep Delve", short: "delve",
    x1: 3640, x2: 3720, y1: 5110, y2: 5180, z: 0, kingdom: "keldagrim",
    xp: 1.15, rich: 0.15, blurb: "living rock caverns - rich, and hungry",
  },
]);

const KINGDOM_NAMES = Object.freeze({
  asgarnia: "Asgarnia",
  misthalin: "Misthalin",
  kandarin: "Kandarin",
  morytania: "Morytania",
  keldagrim: "Keldagrim",
});

const VEIN_XP_MULTIPLIER = 1.5;
// The vein lasts ~30 minutes, then it plays out for 15-40 minutes.
const VEIN_TICKS = 3000;
const VEIN_COOLDOWN_MIN_TICKS = 1500;
const VEIN_COOLDOWN_JITTER_TICKS = 2500;
// Checked every 5 minutes.
const CHECK_TICKS = 500;
const FOUND_ATTRIBUTE = "mining:rich-vein-found";

let api = null;
let core = null;
let vein = null; // { mineIndex, endsAt, id }
let veinCooldownUntil = 0;
let lastMineIndex = -1;
let veinId = 0;

function inRect(rect, x, y, z) {
  return z === rect.z && x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2;
}

function mineAt(x, y, z = 0) {
  if (x == null || y == null) return null;
  return MINES.find((mine) => inRect(mine, x, y, z)) ?? null;
}

function veinMine() {
  return vein ? MINES[vein.mineIndex] : null;
}

function isActiveAt(x, y, z = 0) {
  const mine = veinMine();
  return !!mine && inRect(mine, x, y, z);
}

function pickMine(preferKingdom = null, random = Math.random) {
  let options = MINES.map((_, index) => index).filter((index) => index !== lastMineIndex);
  if (preferKingdom) {
    const home = options.filter((index) => MINES[index].kingdom === preferKingdom);
    if (home.length > 0) options = home;
  }
  return options[Math.floor(random() * options.length)];
}

function startVein(preferKingdom = null, random = Math.random) {
  const mineIndex = pickMine(preferKingdom, random);
  lastMineIndex = mineIndex;
  veinId += 1;
  vein = { mineIndex, endsAt: Date.now() + VEIN_TICKS * 600, id: veinId };
  const mine = MINES[mineIndex];
  const kingdom = KINGDOM_NAMES[mine.kingdom] ?? mine.kingdom;
  spreadRumor(
    api, mine.kingdom,
    `Miners whisper a rich vein has opened in ${mine.name} - get down there before the word spreads! (${kingdom})`,
  );
  api.log("rich vein started", { mine: mine.name });
}

function endVein() {
  const mine = veinMine();
  vein = null;
  veinCooldownUntil = Date.now() + (VEIN_COOLDOWN_MIN_TICKS + Math.floor(Math.random() * VEIN_COOLDOWN_JITTER_TICKS)) * 600;
  if (mine) {
    spreadRumor(api, mine.kingdom, `The rich vein in ${mine.name} has played out.`);
    api.log("rich vein ended", { mine: mine.name });
  }
}

function checkVein() {
  const now = Date.now();
  if (vein && now >= vein.endsAt) {
    endVein();
  } else if (!vein && now >= veinCooldownUntil) {
    startVein();
  }
}

/** A hungry kingdom pulls the next vein its way, if none is active. */
function onWarDemand(event) {
  const kingdomId = event?.kingdomId;
  if (!kingdomId) return;
  if (!vein && Date.now() >= veinCooldownUntil) {
    startVein(kingdomId);
  }
}

function onOreYield(event) {
  if (!(event.multiplier > 0)) return;
  const { x, y, z } = event.location ?? {};
  const mine = mineAt(x, y, z);
  event.mine = mine;
  if (!mine) return;
  event.multiplier *= mine.xp;
  if (Math.random() < mine.rich) {
    event.bonusOre += 1;
  }
  if (isActiveAt(x, y, z)) {
    event.multiplier *= VEIN_XP_MULTIPLIER;
    event.bonusOre += 1;
  }
}

function onSuccess(event) {
  const { player, location } = event;
  const { x, y, z } = location ?? {};
  const mine = mineAt(x, y, z);
  event.mine = mine;
  if (!mine) return;
  if (isActiveAt(x, y, z)) {
    event.vein = true;
    // First load on a vein: the rock tells you before anyone else does.
    if (Number(player.getAttribute(FOUND_ATTRIBUTE)) !== vein.id) {
      player.setAttribute(FOUND_ATTRIBUTE, vein.id);
      player.sendMessage("The rock splits along a glittering seam - a rich vein runs here!");
    }
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("mining:ore-yield", onOreYield);
  api.onCustomEvent("mining:success", onSuccess);
  api.onCustomEvent("kingdom:war-demand", onWarDemand);
  api.getTaskManager().submit(new (class extends core.Task {
    constructor() { super(CHECK_TICKS); }
    execute() { checkVein(); }
  })());
  api.log("registered", { mines: MINES.length });
}

module.exports = {
  attach, mineAt, veinMine, isActiveAt, startVein, endVein, checkVein,
  MINES, VEIN_XP_MULTIPLIER, FOUND_ATTRIBUTE,
  _test: { onOreYield, onSuccess, onWarDemand, pickMine },
};
