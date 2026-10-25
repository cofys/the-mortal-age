"use strict";

/**
 * Fishing Trawler: the data (plugins/minigames/data/fishing-trawler.json) with every gameval
 * name resolved to its cache id, and the small helpers the units share.
 *
 * Wiki: https://oldschool.runescape.wiki/w/Fishing_Trawler
 */

const DATA = require("../data/fishing-trawler.json");

/** The catch waiting in the Port Khazard net: { items: [[id, count]], xp }. */
const REWARD_ATTRIBUTE = "fishing-trawler:reward";
/** Set while the player is on the trawler at sea, so a login can put them ashore. */
const AT_SEA_ATTRIBUTE = "fishing-trawler:at-sea";

const state = { api: null, core: null, ids: null };

function resolve(names, lookup, kind) {
  const out = {};
  for (const [key, name] of Object.entries(names)) {
    if (Array.isArray(name)) {
      out[key] = name.map((entry) => resolve({ entry }, lookup, kind).entry);
      continue;
    }
    const id = lookup(name);
    if (id === null || id === undefined) throw new Error(`[FishingTrawler] unknown ${kind} ${name}`);
    out[key] = id;
  }
  return out;
}

function bind(api) {
  state.api = api;
  state.core = api.core;
  if (state.ids) return;
  const cache = api.core.CacheDefinitions;
  const item = (name) => cache.getObjId(name);
  state.ids = {
    locs: resolve(DATA.names.locs, (name) => cache.getLocId(name), "loc"),
    items: resolve(DATA.names.items, item, "item"),
    varbits: resolve(DATA.names.varbits, (name) => cache.getVarbitId(name), "varbit"),
    interfaces: resolve(DATA.names.interfaces, (name) => cache.getInterfaceId(name), "interface"),
    seqs: resolve(DATA.names.seqs, (name) => cache.getSeqId(name), "seq"),
    fish: DATA.fish.map(([name, level, xp]) => ({ id: resolve({ name }, item, "item").name, level, xp })),
    junk: DATA.junk.map((name) => resolve({ name }, item, "item").name),
  };
}

const api = () => state.api;
const core = () => state.core;
const ids = () => state.ids;

const OVERLAY_HUD_UID = (161 << 16) | 8;

function loc([x, y, z = 0]) {
  return new (core().Location)(x, y, z);
}

function inBounds([minX, maxX, minY, maxY, z], location) {
  const x = location.getX();
  const y = location.getY();
  return x >= minX && x <= maxX && y >= minY && y <= maxY && (z === undefined || location.getZ() === z);
}

/** Runs `action` once, `ticks` from now (at least one). */
function later(ticks, action) {
  const { Task, TaskManager } = core();
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

/** Runs `action` every tick until it returns false. */
function everyTick(action) {
  const { Task, TaskManager } = core();
  const task = new (class extends Task {
    constructor() {
      super(1, null, false);
    }
    execute() {
      if (action() === false) this.stop();
    }
  })();
  TaskManager.submit(task);
  return task;
}

function message(key, values = {}) {
  return DATA.messages[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

function animate(player, seq) {
  player.performAnimation(new (core().Animation)(seq));
}

function addXp(player, skill, amount) {
  if (amount > 0) player.getSkillManager().addExperiences(core().Skill[skill], amount);
}

function level(player, skill) {
  return player.getSkillManager().getCurrentLevel(core().Skill[skill]);
}

function baseLevel(player, skill) {
  return player.getSkillManager().getMaxLevel(core().Skill[skill]);
}

function carries(player, itemId) {
  return player.getInventory().contains(itemId);
}

/** The player's varbit, sent only when it changes. */
function setVarbit(player, varbit, value) {
  const sender = player.getPacketSender();
  if (sender.getVarbit(varbit) !== value) sender.sendVarbit(varbit, value);
}

module.exports = {
  DATA,
  REWARD_ATTRIBUTE,
  AT_SEA_ATTRIBUTE,
  OVERLAY_HUD_UID,
  bind,
  api,
  core,
  ids,
  loc,
  inBounds,
  later,
  everyTick,
  message,
  animate,
  addXp,
  level,
  baseLevel,
  carries,
  setVarbit,
};
