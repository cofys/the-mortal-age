/**
 * Shades of Mort'ton: what the units share - the plugin api, plugins/minigames/data/
 * shades-of-mortton.json, cache ids by name, tick timing and the keys.
 */
const fs = require("fs");
const path = require("path");

let api = null;
let core = null;
let data = null;

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "shades-of-mortton.json"), "utf8"));
}

const npcId = (name) => core.CacheDefinitions.getNpcId(name);
const objId = (name) => core.CacheDefinitions.getObjId(name);
const locId = (name) => core.CacheDefinitions.getLocId(name);

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

const randomInt = (low, high) => low + Math.floor(Math.random() * (high - low + 1));

/** A key's metal and colour from its gameval (shadekey_<metal>_<colour>), or null. */
function keyOf(itemId) {
  const name = core.CacheDefinitions.getObjNames().get(itemId) ?? "";
  const match = /^shadekey_([a-z]+)_([a-z]+)$/.exec(name);
  return match ? { metal: match[1], colour: match[2] } : null;
}

const tier = (metal) => data.keyMetals.indexOf(metal);

/** The best key the player carries (by metal), or null. */
function bestKey(player) {
  let best = null;
  for (const item of player.getInventory().getValidItems?.() ?? []) {
    const key = keyOf(item.getId());
    if (key && (!best || tier(key.metal) > tier(best.metal))) best = { ...key, itemId: item.getId() };
  }
  return best;
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
  npcId,
  objId,
  locId,
  later,
  every,
  message,
  randomInt,
  keyOf,
  tier,
  bestKey,
};
