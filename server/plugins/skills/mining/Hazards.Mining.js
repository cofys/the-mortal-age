/**
 * Mining hazards: the deep earth pushes back.
 *
 * The Deep Delve (and the old deep workings) are dug too deep and too fast:
 * every yield there risks a cave-in - falling rock hurts, and the session ends
 * as the miner scrambles clear. Gas pockets vent with a warning crack; keep
 * swinging and the gas takes its toll. Master Prospectors (see
 * Mastery.Mining) read the rock and never get caught.
 *
 * Kingdom mining policy: while a kingdom's quartermaster cries for supplies
 * ("kingdom:war-demand" inside the quota window), that kingdom's mines work
 * wartime quotas - +15% XP, but the quotas push men deeper and cave-in risk
 * doubles. Citizens talk about it.
 *
 * Weather never reaches underground: the mines are exempt from the sky, the
 * way fishing's cave spots are. This module is the mines' changing condition.
 *
 * Attaches after Mines: it reads event.mine stamped by Mines.Mining and sets
 * event.stop on "mining:success" (honored by Mining.plugin's awardOre).
 */
const Mastery = require("./Mastery.Mining");
const { spreadRumor } = require("./Rumors.Mining");

// The Deep Delve's short name in Mines.Mining; the old deep workings sit just
// south of the Dwarven Mine rect.
const DELVE_SHORT = "delve";
const DEEP_WORKINGS = Object.freeze({ x1: 3005, x2: 3025, y1: 9855, y2: 9885, z: 0 });

const CAVE_IN_CHANCE = 0.04;
const GAS_CHANCE = 0.03;
const QUOTA_CAVE_IN_MULTIPLIER = 2;
const QUOTA_XP_BONUS = 0.15;
// A war demand keeps wartime quotas up for half an hour after the last cry.
const QUOTA_WINDOW_MS = 30 * 60 * 1000;

// Flavor messages are throttled per player so they stay flavor, not spam.
const FLAVOR_ATTRIBUTE = "mining:hazards-flavor-at";
const FLAVOR_COOLDOWN_MS = 5 * 60 * 1000;

const KINGDOM_NAMES = Object.freeze({
  asgarnia: "Asgarnia",
  misthalin: "Misthalin",
  kandarin: "Kandarin",
  morytania: "Morytania",
  keldagrim: "Keldagrim",
});

let api = null;
let core = null;
// kingdomId -> timestamp of the last war demand heard.
const lastWarDemandAt = new Map();

function inDeepWorkings(x, y, z) {
  return z === DEEP_WORKINGS.z &&
    x >= DEEP_WORKINGS.x1 && x <= DEEP_WORKINGS.x2 &&
    y >= DEEP_WORKINGS.y1 && y <= DEEP_WORKINGS.y2;
}

/** True when this yield happens in ground that can fall. */
function isDangerousGround(event) {
  const { x, y, z } = event.location ?? {};
  if (x == null || y == null) return false;
  return event.mine?.short === DELVE_SHORT || inDeepWorkings(x, y, z);
}

/** Wartime mining quotas: the crown wants ore, yields rise, risks rise. */
function quotasActive(kingdomId) {
  const last = lastWarDemandAt.get(kingdomId) ?? 0;
  return Date.now() - last < QUOTA_WINDOW_MS;
}

function sayThrottled(player, text) {
  const now = Date.now();
  const last = Number(player.getAttribute(FLAVOR_ATTRIBUTE)) || 0;
  if (now - last < FLAVOR_COOLDOWN_MS) return;
  player.setAttribute(FLAVOR_ATTRIBUTE, now);
  player.sendMessage(text);
}

/** Falling rock, best-effort: the world does not depend on the hit landing. */
function caveInHit(player, amount) {
  try {
    const cur = player.getHitpoints?.() ?? 0;
    player.setHitpoints?.(Math.max(0, cur - amount));
  } catch {
    // best-effort
  }
}

function onWarDemand(event) {
  const kingdomId = event?.kingdomId;
  if (!kingdomId) return;
  const wasActive = quotasActive(kingdomId);
  lastWarDemandAt.set(kingdomId, Date.now());
  if (!wasActive) {
    const kingdom = KINGDOM_NAMES[kingdomId] ?? kingdomId;
    spreadRumor(
      api, kingdomId,
      `Wartime quotas in the mines of ${kingdom} - the crown pays full XP for every load, but the quotas push men deeper!`,
    );
  }
}

function onOreYield(event) {
  if (!(event.multiplier > 0)) return;
  const kingdomId = event.mine?.kingdom;
  if (kingdomId && quotasActive(kingdomId)) {
    event.quota = true;
    event.multiplier *= 1 + QUOTA_XP_BONUS;
  }
}

function onSuccess(event) {
  const { player } = event;
  if (!isDangerousGround(event)) return;

  // Master Prospectors read the rock: never caught.
  if (Mastery.isCaveInImmune(player)) return;

  const quota = event.mine?.kingdom && quotasActive(event.mine.kingdom);
  const caveInChance = CAVE_IN_CHANCE * (quota ? QUOTA_CAVE_IN_MULTIPLIER : 1);
  const random = Math.random;

  if (random() < caveInChance) {
    const damage = 5 + Math.floor(random() * 11);
    caveInHit(player, damage);
    event.stop = true;
    event.survivedCaveIn = true;
    player.sendMessage("The tunnel shudders - rocks fall around you! You scramble clear.");
    api.log("cave-in", { player: player.getUsername?.(), damage });
    return;
  }
  if (random() < GAS_CHANCE) {
    const damage = 3 + Math.floor(random() * 6);
    caveInHit(player, damage);
    sayThrottled(player, "Gas hisses from a cracked seam - mind the deep air!");
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("mining:ore-yield", onOreYield);
  api.onCustomEvent("mining:success", onSuccess);
  api.onCustomEvent("kingdom:war-demand", onWarDemand);
  api.log("registered", { caveInChance: CAVE_IN_CHANCE, gasChance: GAS_CHANCE });
}

module.exports = {
  attach, isDangerousGround, quotasActive, inDeepWorkings,
  CAVE_IN_CHANCE, GAS_CHANCE, QUOTA_XP_BONUS, QUOTA_CAVE_IN_MULTIPLIER,
  FLAVOR_ATTRIBUTE, DEEP_WORKINGS,
  _test: { onOreYield, onSuccess, onWarDemand, lastWarDemandAt, sayThrottled },
};
