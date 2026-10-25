"use strict";

/**
 * Earning Potential (OSRS Wiki: Bounty Hunter#Earning Potential, Bounty crate).
 *
 * EP rises 1% per 30 seconds in the arena, capped at 100%: half that while unskulled, twice that
 * with a target while risking at least 50,000 coins. A target kill gives a bounty crate whose tier
 * follows the killer's EP, and receiving one resets EP to 0%.
 *
 * The wiki gives no EP-to-tier table. The cache names the nine crates bh_ep_crate_2..10, so a
 * crate's internal number is read as EP / 10: 20-29% gives tier 1 ... 100% gives tier 9, and
 * under 20% gives no crate.
 */

const EP_ATTRIBUTE = "bounty-hunter:earning-potential";

const TICKS_PER_GAIN = 50; // 30 seconds
const MAX_EP = 100;
const RISK_FOR_DOUBLE = 50_000;
const MIN_CRATE_EP = 20;

let core;
let pluginApi;
/** CRATE_IDS[tier - 1] */
let CRATE_IDS = [];
/** Players in the arena -> ticks there since their last EP gain. */
const inArena = new Map();

function getEp(player) {
  const value = Number(player.getAttribute(EP_ATTRIBUTE));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hasTarget(player) {
  const query = { player, target: null };
  pluginApi.emitCustomEvent("bounty-hunter:has-target", query);
  return query.target != null;
}

/** Risk is Agent C's (risk skulls); unanswered counts as nothing risked. */
function riskedValue(player) {
  const query = { player, value: 0 };
  pluginApi.emitCustomEvent("bounty-hunter:risk", query);
  return Number(query.value) || 0;
}

function gainPerStep(skulled, targetWithRisk) {
  return (skulled ? 1 : 0.5) * (targetWithRisk ? 2 : 1);
}

function gain(player) {
  const doubled = hasTarget(player) && riskedValue(player) >= RISK_FOR_DOUBLE;
  const ep = Math.min(MAX_EP, getEp(player) + gainPerStep(player.isSkulled(), doubled));
  player.setAttribute(EP_ATTRIBUTE, ep);
}

/** The crate tier (1-9) a kill at this EP gives, or 0 for none. */
function crateTier(ep) {
  return ep >= MIN_CRATE_EP ? Math.min(9, Math.floor(ep / 10) - 1) : 0;
}

function tick() {
  for (const [player, ticks] of inArena) {
    if (ticks + 1 < TICKS_PER_GAIN) {
      inArena.set(player, ticks + 1);
      continue;
    }
    inArena.set(player, 0);
    gain(player);
  }
}

function enteredArena({ player }) {
  if (!inArena.has(player)) inArena.set(player, 0);
}

function leftArena({ player }) {
  inArena.delete(player);
}

function targetKilled({ killer }) {
  const tier = crateTier(getEp(killer));
  if (!tier) return;
  killer.setAttribute(EP_ATTRIBUTE, 0);
  killer.getInventory().forceAdd(killer, new core.Item(CRATE_IDS[tier - 1], 1));
  // Best guess: no capture of this message exists.
  killer.sendMessage(`You receive a tier ${tier} bounty crate.`);
}

function answerEp(query) {
  query.value = Math.floor(getEp(query.player));
}

function start() {
  core.TaskManager.submit(new (class extends core.Task {
    constructor() { super(1); }
    execute() { tick(); }
  })());
}

module.exports = function attachBountyHunterEarningPotential(api) {
  core = api.core;
  pluginApi = api;
  CRATE_IDS = Array.from({ length: 9 }, (_, index) => core.ItemIdentifiers[`BOUNTY_CRATE_TIER_${index + 1}_`]);
  api.persistAttribute(EP_ATTRIBUTE, 0);
  api.onServerStartup(start);
  api.onPlayerLogout(leftArena);
  api.onCustomEvent("bounty-hunter:entered-arena", enteredArena);
  api.onCustomEvent("bounty-hunter:left-arena", leftArena);
  api.onCustomEvent("bounty-hunter:target-killed", targetKilled);
  api.onCustomEvent("bounty-hunter:earning-potential", answerEp);
};
Object.assign(module.exports, { getEp, crateTier, gainPerStep, tick, inArena });
