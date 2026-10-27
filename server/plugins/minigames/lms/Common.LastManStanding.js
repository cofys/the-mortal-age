/**
 * Last Man Standing: what the units share - the plugin api, plugins/minigames/data/
 * last-man-standing.json, cache ids by name, tick helpers and the saved figures.
 */
const fs = require("fs");
const path = require("path");

let api = null;
let core = null;
let data = null;
const ids = { components: {}, varbits: {}, varps: {}, objs: {}, locs: {}, npcs: {}, interfaces: {} };

/** Saved figures (kebab-case attributes); the points are the shop currency's own attribute. */
const ATTRIBUTES = {
  tutorial: "last-man-standing:tutorial",
  rank: "last-man-standing:rank",
  wins: "last-man-standing:wins",
  kills: "last-man-standing:kills",
  games: "last-man-standing:games",
  preferredBuild: "last-man-standing:preferred-build",
  loadouts: "last-man-standing:loadouts",
  coffer: "last-man-standing:coffer",
  stash: "last-man-standing:stash",
  winnings: "last-man-standing:winnings",
  freeHighStakes: "last-man-standing:free-high-stakes",
  forfeits: "last-man-standing:forfeits",
};
/** Clipping: a loc on the tile, and floor decoration that blocks it (RegionManager.BLOCKED_TILE is the third). */
const LOC_ON_TILE = 0x100;
const FLOOR_BLOCKED = 0x40000;

/** Shopkeepers.plugin.js's currency for shop 1449, so points bought before stay spendable. */
const POINTS_ATTRIBUTE = "shop-currency:Last Man Standing Points";

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "last-man-standing.json"), "utf8"));
}

function cached(kind, name, lookup) {
  if (!(name in ids[kind])) ids[kind][name] = lookup(name);
  return ids[kind][name];
}

const component = (name) => cached("components", name, (n) => core.CacheDefinitions.getComponentId(n));
const varbitId = (name) => cached("varbits", name, (n) => core.CacheDefinitions.getVarbitId(n));
const varpId = (name) => cached("varps", name, (n) => core.CacheDefinitions.getVarpId(n));
const objId = (name) => cached("objs", name, (n) => core.CacheDefinitions.getObjId(n));
const locId = (name) => cached("locs", name, (n) => core.CacheDefinitions.getLocId(n));
const npcId = (name) => cached("npcs", name, (n) => core.CacheDefinitions.getNpcId(n));
const interfaceId = (name) => cached("interfaces", name, (n) => core.CacheDefinitions.getInterfaceId(n));

function varbit(player, name, value) {
  const id = varbitId(name);
  if (id != null) player.getPacketSender().sendVarbit(id, value);
}

function varp(player, name, value) {
  const id = typeof name === "number" ? name : varpId(name);
  if (id != null) player.getPacketSender().sendConfig(id, value);
}

function text(player, name, value) {
  const id = component(name);
  if (id != null) player.getPacketSender().sendString(String(value), id);
}

function number(player, key) {
  return Number(player.getAttribute(key)) || 0;
}

function add(player, key, amount) {
  const value = number(player, key) + amount;
  player.setAttribute(key, value);
  return value;
}

function later(ticks, action) {
  const { Task, TaskManager } = core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(Math.max(1, ticks), null, false);
    }
    execute() {
      this.stop();
      action();
    }
  })());
}

function every(action) {
  const { Task, TaskManager } = core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(1, null, false);
    }
    execute() {
      if (action() === false) this.stop();
    }
  })());
}

function message(name, values = {}) {
  return String(data.messages[name]).replace(/\{(\w+)\}/g, (_, field) => String(values[field] ?? ""));
}

/** A game-message line of the captured type (spam lines go to the filtered channel). */
function spam(player, line) {
  player.getPacketSender().sendTypedMessage(core.ChatType.SPAM, line);
}

/** A broadcast line, as the fog and crate announcements are captured. */
function broadcast(player, line) {
  player.getPacketSender().sendTypedMessage(core.ChatType.BROADCAST, line);
}

const randomInt = (low, high) => low + Math.floor(Math.random() * (high - low + 1));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Whether a tile on `area` can be stood on (nothing standing there, a floor). */
function standable(x, y, z, area) {
  const { RegionManager } = core;
  return (RegionManager.getClipping(x, y, z, area) & (LOC_ON_TILE | FLOOR_BLOCKED | RegionManager.BLOCKED_TILE)) === 0;
}

/** Whether a loc stands on the tile. */
function occupied(x, y, z, area) {
  return (core.RegionManager.getClipping(x, y, z, area) & LOC_ON_TILE) !== 0;
}

function inBox(location, [x0, y0, x1, y1]) {
  const x = location.getX();
  const y = location.getY();
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function asPlayer(mobile) {
  return mobile?.isPlayer?.() ? mobile.getAsPlayer?.() ?? mobile : null;
}

/** "Novice (500)": the lobby overlay's rank line. */
function rankText(rank) {
  const [, title] = data.rank.titles.find(([from]) => rank >= from);
  return `${title} (${rank})`;
}

/** Wiki: +10-place for 1st-9th, nothing for 10th-16th, -(place-16) for 17th-24th (data `rank`). */
function rankChange(place) {
  const { gainUpTo, gainFrom, loseFrom } = data.rank;
  if (place <= gainUpTo) return gainFrom - place;
  if (place >= loseFrom) return -(place - (loseFrom - 1));
  return 0;
}

/** Captured: "Novice (0)" until Lisa's introduction sets the rank to 500. */
function rankOf(player) {
  const rank = player.getAttribute(ATTRIBUTES.rank);
  return rank == null ? 0 : Number(rank);
}

function points(player) {
  return number(player, POINTS_ATTRIBUTE);
}

module.exports = {
  init,
  get api() {
    return api;
  },
  get core() {
    return core;
  },
  get data() {
    return data;
  },
  ATTRIBUTES,
  POINTS_ATTRIBUTE,
  component,
  varbitId,
  varpId,
  objId,
  locId,
  npcId,
  interfaceId,
  varbit,
  varp,
  text,
  number,
  add,
  later,
  every,
  message,
  spam,
  broadcast,
  randomInt,
  pick,
  inBox,
  standable,
  occupied,
  asPlayer,
  rankText,
  rankOf,
  rankChange,
  points,
};
