"use strict";

/**
 * Managing Miscellania (https://oldschool.runescape.wiki/w/Managing_Miscellania): the kingdom's
 * state and the daily economy, shared by the units beside this file.
 *
 * The state is one persisted attribute: coffers, the workers on each job, the fish, hardwood
 * and herb/flax choices, the resource points saved up, the last day paid and the last day the
 * player was on Miscellania or Etceteria. Approval (favour, 0-127) stays with Throne of
 * Miscellania, which owns varbit misc_approval; it is read and set through that quest's
 * miscellania:get-approval / miscellania:set-approval events.
 *
 * Days are whole UTC days (OSRS pays at midnight UTC), worked out from the last day paid, so
 * days spent offline are paid exactly as if the server had run through them. Every formula is
 * the Wiki calculator's (Module:Miscellania_calculator); see ./data/kingdom.json.
 */

const DATA = require("./data/kingdom.json");

const KINGDOM_ATTRIBUTE = "managing-miscellania:kingdom";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Jobs as the interface lays them out (varbits misc_points_*). */
const JOBS = ["mine", "herbs", "wood", "fish", "hardwood", "farm"];
/** misc_rarewood_type: 0 mahogany, 1 teak, 2 both. */
const HARDWOOD = { MAHOGANY: 0, TEAK: 1, BOTH: 2 };

/** Miscellania and Etceteria, both islands (a visit keeps the subjects working). */
const ISLANDS = { minX: 2496, maxX: 2623, minY: 3776, maxY: 3903 };

const state = { api: null, core: null, items: null, varbits: null };

function bind(api) {
  state.api = api;
  state.core = api.core;
  if (!state.items) resolveIds(api.core.CacheDefinitions);
}

/** Every item and varbit from its cache gameval name. */
function resolveIds(cache) {
  const item = (name) => {
    const id = cache.getObjId(name.toLowerCase());
    if (id === null || id === undefined) throw new Error(`[ManagingMiscellania] unknown item ${name}`);
    return id;
  };
  const items = {};
  for (const name of ["MAPLE_LOGS", "COAL", "RAW_TUNA", "RAW_SWORDFISH", "TUNA", "SWORDFISH", "FLAX",
    "MAHOGANY_LOGS", "TEAK_LOGS", "COINS", "TRAIL_CLUE_EASY_SIMPLE001", "RAW_LOBSTER"]) items[name] = item(name);
  const tables = {};
  for (const [key, rows] of Object.entries(DATA.tables)) {
    tables[key] = rows.map(([name, weight, max]) => ({
      itemId: name === "CLUE_EASY" ? -1 : item(name),
      clue: name === "CLUE_EASY",
      weight,
      max,
    }));
  }
  const varbit = (name) => cache.getVarbitId(name);
  state.items = { ...items, tables };
  state.varbits = {
    approval: varbit("misc_approval"),
    coffers: varbit("misc_coffers"),
    workers: {
      wood: varbit("misc_points_wood"),
      herbs: varbit("misc_points_herb"),
      fish: varbit("misc_points_fish"),
      mine: varbit("misc_points_mine"),
      hardwood: varbit("misc_points_rarewood"),
      farm: varbit("misc_points_farm"),
    },
    hardwoodType: varbit("misc_rarewood_type"),
    herbsOrFlax: varbit("misc_herbs_or_flax"),
    cooked: varbit("misc_cooked"),
    resourceTotal: varbit("misc_restotal_lowbits"),
  };
}

const getCore = () => state.core;
const getApi = () => state.api;
const items = () => state.items;
const varbits = () => state.varbits;

// --- Quests

function questComplete(player, key) {
  const request = { player, key, complete: null };
  getApi().emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

const ruler = (player) => questComplete(player, "throne_of_miscellania");
const royalTrouble = (player) => questComplete(player, "royal_trouble");

function favour(player) {
  const request = { player, value: null };
  getApi().emitCustomEvent("miscellania:get-approval", request);
  return Number.isFinite(request.value) ? request.value : 0;
}

function setFavour(player, value) {
  getApi().emitCustomEvent("miscellania:set-approval", { player, value });
}

/** The percentage Advisor Ghrim and the quest show for a favour value. */
function approvalPercent(value) {
  return Math.floor((value * 100) / DATA.favourMax);
}

// --- State

function today(nowMs = Date.now()) {
  return Math.floor(nowMs / DAY_MS);
}

/** Throne of Miscellania's reward: 10,000 coins in the coffers, every subject idle. */
function freshKingdom(day) {
  return {
    coffer: 10000,
    workers: { mine: 0, herbs: 0, wood: 0, fish: 0, hardwood: 0, farm: 0 },
    cooked: false,
    hardwoodType: HARDWOOD.MAHOGANY,
    flax: false,
    points: 0,
    lastDay: day,
    lastVisitDay: day,
  };
}

function kingdomOf(player, day = today()) {
  const saved = player.getAttribute(KINGDOM_ATTRIBUTE);
  if (saved && typeof saved === "object" && Number.isFinite(saved.coffer)) return saved;
  const fresh = freshKingdom(day);
  player.setAttribute(KINGDOM_ATTRIBUTE, fresh);
  return fresh;
}

function save(player, kingdom) {
  player.setAttribute(KINGDOM_ATTRIBUTE, { ...kingdom, workers: { ...kingdom.workers } });
}

function limits(rt) {
  const key = rt ? "royalTrouble" : "base";
  return {
    cofferMax: DATA.cofferMax[key],
    dailyPayMax: DATA.dailyPayMax[key],
    favourSubtraction: DATA.favourSubtraction[key],
    workers: DATA.workers[key],
  };
}

function workersBusy(kingdom) {
  return JOBS.reduce((sum, job) => sum + (kingdom.workers[job] | 0), 0);
}

// --- The day's work (pure)

/**
 * Pays every day since the last one, up to 30 days after the last visit. Returns the new
 * kingdom and favour; the input is not changed.
 */
function payDays(kingdom, favourNow, day, rt) {
  const next = { ...kingdom, workers: { ...kingdom.workers } };
  const cap = limits(rt);
  let currentFavour = favourNow;
  const lastWorkday = Math.min(day, next.lastVisitDay + DATA.pauseAfterDays);
  for (let d = next.lastDay + 1; d <= lastWorkday; d++) {
    const paid = Math.min(5 + Math.floor(next.coffer / 10), cap.dailyPayMax, next.coffer);
    next.coffer -= paid;
    const effectiveness = Math.floor((paid * 100) / 8333);
    next.points = Math.min(DATA.resourcePointCap, next.points + Math.floor((effectiveness * currentFavour) / 100));
    if (currentFavour > DATA.favourFloor) {
      currentFavour = Math.max(DATA.favourFloor, currentFavour - Math.ceil((cap.favourSubtraction - currentFavour) / 15));
    }
  }
  next.lastDay = Math.max(next.lastDay, day);
  return { kingdom: next, favour: currentFavour };
}

/** floor(workers * inverseCost * points / 2048). */
function baseQuantity(workers, inverseCost, points) {
  return Math.floor((workers * inverseCost * points) / 2048);
}

/** n rolls on a weighted table, each row capped at its maximum. Returns [itemId|clue, count]. */
function rollTable(table, rolls, random = Math.random) {
  const counts = new Map();
  if (rolls <= 0) return counts;
  const total = table.reduce((sum, row) => sum + row.weight, 0);
  for (let i = 0; i < rolls; i++) {
    let at = random() * total;
    let row = table[table.length - 1];
    for (const r of table) {
      if ((at -= r.weight) < 0) {
        row = r;
        break;
      }
    }
    const key = row.clue ? "clue" : row.itemId;
    const have = counts.get(key) ?? 0;
    if (row.max !== undefined && have >= row.max) continue;
    counts.set(key, have + 1);
  }
  return counts;
}

function add(out, key, count) {
  if (count > 0) out.set(key, (out.get(key) ?? 0) + count);
}

function addAll(out, counts) {
  for (const [key, count] of counts) add(out, key, count);
}

/** Everything the subjects gathered with these points, by the module's rules. Keys: item ids, or "clue". */
function gather(kingdom, random = Math.random) {
  const out = new Map();
  const i = items();
  const t = i.tables;
  const cost = DATA.inverseCost;
  const w = kingdom.workers;
  const points = kingdom.points;

  const maple = baseQuantity(w.wood, cost.maple, points);
  add(out, i.MAPLE_LOGS, maple);
  addAll(out, rollTable(t.nests, Math.min(999, Math.floor(maple / 100)), random));

  const coal = baseQuantity(w.mine, cost.coal, points);
  add(out, i.COAL, coal);
  addAll(out, rollTable(t.miningGems, Math.floor(coal / 200 + 0.5), random));

  const fish = baseQuantity(w.fish, cost.fish, points);
  add(out, kingdom.cooked ? i.TUNA : i.RAW_TUNA, Math.floor(0.5 * fish));
  add(out, kingdom.cooked ? i.SWORDFISH : i.RAW_SWORDFISH, Math.floor(0.15 * fish));
  addAll(out, rollTable(t.fishingLoot, Math.floor(fish / 200), random));

  if (kingdom.flax) {
    const flax = baseQuantity(w.herbs, cost.flax, points);
    add(out, i.FLAX, flax);
    addAll(out, rollTable(t.flaxSeeds, Math.floor(flax / 600), random));
  } else {
    const herbs = baseQuantity(w.herbs, cost.herbs, points);
    addAll(out, rollTable(t.herbs, herbs, random));
    addAll(out, rollTable(t.herbSeeds, Math.floor(herbs / 100), random));
  }

  const hardwoodCost = kingdom.hardwoodType === HARDWOOD.TEAK ? cost.teak
    : kingdom.hardwoodType === HARDWOOD.BOTH ? cost.bothHardwood : cost.mahogany;
  const hardwood = baseQuantity(w.hardwood, hardwoodCost, points);
  if (kingdom.hardwoodType === HARDWOOD.BOTH) {
    add(out, i.MAHOGANY_LOGS, Math.floor(0.5 * hardwood));
    add(out, i.TEAK_LOGS, Math.floor(0.5 * hardwood));
  } else {
    add(out, kingdom.hardwoodType === HARDWOOD.TEAK ? i.TEAK_LOGS : i.MAHOGANY_LOGS, hardwood);
  }
  addAll(out, rollTable(t.nests, Math.floor(hardwood / 350), random));

  const farm = baseQuantity(w.farm, cost.farm, points);
  addAll(out, rollTable(t.seeds, farm, random));
  addAll(out, rollTable(t.treeSeeds, Math.floor(farm / 200), random));
  return out;
}

// --- Visits

function onIslands(player) {
  const at = player.getLocation();
  return at.getX() >= ISLANDS.minX && at.getX() <= ISLANDS.maxX && at.getY() >= ISLANDS.minY && at.getY() <= ISLANDS.maxY;
}

/**
 * Brings the kingdom up to today: pays the days owed (favour falls with them) and, when the
 * player is on the islands, records the visit. Only for regents.
 */
function catchUp(player, day = today()) {
  if (!ruler(player)) return null;
  const rt = royalTrouble(player);
  const result = payDays(kingdomOf(player, day), favour(player), day, rt);
  if (onIslands(player)) result.kingdom.lastVisitDay = day;
  save(player, result.kingdom);
  if (result.favour !== favour(player)) setFavour(player, result.favour);
  return result.kingdom;
}

module.exports = {
  DATA,
  KINGDOM_ATTRIBUTE,
  DAY_MS,
  JOBS,
  HARDWOOD,
  ISLANDS,
  state,
  bind,
  getCore,
  getApi,
  items,
  varbits,
  ruler,
  royalTrouble,
  favour,
  setFavour,
  approvalPercent,
  today,
  freshKingdom,
  kingdomOf,
  save,
  limits,
  workersBusy,
  payDays,
  baseQuantity,
  rollTable,
  gather,
  onIslands,
  catchUp,
};
