"use strict";

/**
 * Bounty Hunter points and kill counts (OSRS Wiki: Bounty Hunter#Bounty Hunter points).
 *
 * Each target kill earns 2 points, plus a milestone bonus on every 10th (3), 50th (5), 100th (10)
 * and 500th (25) target kill. A penalised killer (skipped too many skulled targets) has the points
 * halved. Rogue kills only count. The points are the Bounty Hunter Store's currency.
 *
 * Saved as attributes and mirrored to the cache varps the client reads.
 */

const POINTS_ATTRIBUTE = "bounty-hunter:points";
const TARGET_KILLS_ATTRIBUTE = "bounty-hunter:target-kills";
const ROGUE_KILLS_ATTRIBUTE = "bounty-hunter:rogue-kills";

const VARP_POINTS = "bh_2023_points";
const VARP_TARGET_KILLS = "bh_2023_target_kill";
const VARP_ROGUE_KILLS = "bh_2023_rogue_kill";

/** shops.json "Bounty Hunter Store" currency. */
const STORE_CURRENCY = "BOUNTY HUNTER POINTS";

const POINTS_PER_TARGET = 2;
/** Highest milestone first: a 500th kill pays the 500th bonus, not every bonus it divides. */
const MILESTONES = [[500, 25], [100, 10], [50, 5], [10, 3]];

let core;

function varp(name) {
  return core.CacheDefinitions.getVarpId(name);
}

function count(player, key) {
  const value = Number(player.getAttribute(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function store(player, key, name, value) {
  player.setAttribute(key, value);
  player.getPacketSender().sendConfig(varp(name), value);
}

function getPoints(player) {
  return count(player, POINTS_ATTRIBUTE);
}

function setPoints(player, value) {
  store(player, POINTS_ATTRIBUTE, VARP_POINTS, Math.max(0, Math.floor(value)));
}

function addPoints(player, value) {
  setPoints(player, getPoints(player) + value);
}

function targetKills(player) {
  return count(player, TARGET_KILLS_ATTRIBUTE);
}

/** Points for a player's `kills`-th target kill. */
function pointsForKill(kills, penalised) {
  const bonus = MILESTONES.find(([every]) => kills % every === 0)?.[1] ?? 0;
  const points = POINTS_PER_TARGET + bonus;
  return penalised ? Math.floor(points / 2) : points;
}

function targetKilled({ killer, penalised }) {
  const kills = targetKills(killer) + 1;
  store(killer, TARGET_KILLS_ATTRIBUTE, VARP_TARGET_KILLS, kills);
  const points = pointsForKill(kills, penalised);
  addPoints(killer, points);
  // Best guess: no capture of this message exists.
  killer.sendMessage(`You have been awarded ${points} Bounty Hunter points. You now have ${getPoints(killer).toLocaleString()}.`);
}

function rogueKilled({ killer }) {
  store(killer, ROGUE_KILLS_ATTRIBUTE, VARP_ROGUE_KILLS, count(killer, ROGUE_KILLS_ATTRIBUTE) + 1);
}

function showBalance({ player }) {
  if (player.isPlayerBot?.() === true) return;
  player.sendMessage(`You currently have ${getPoints(player).toLocaleString()} Bounty Hunter points.`);
}

function syncVarps({ player }) {
  player.getPacketSender()
    .sendConfig(varp(VARP_POINTS), getPoints(player))
    .sendConfig(varp(VARP_TARGET_KILLS), targetKills(player))
    .sendConfig(varp(VARP_ROGUE_KILLS), count(player, ROGUE_KILLS_ATTRIBUTE));
}

const storeCurrency = {
  name: "Bounty Hunter Points",
  amount: getPoints,
  add: (player, value) => addPoints(player, value),
  remove: (player, value) => addPoints(player, -value),
};

module.exports = function attachBountyHunterPoints(api) {
  core = api.core;
  api.persistAttribute(POINTS_ATTRIBUTE, 0);
  api.persistAttribute(TARGET_KILLS_ATTRIBUTE, 0);
  api.persistAttribute(ROGUE_KILLS_ATTRIBUTE, 0);
  // Replaces Shopkeepers' generic attribute-backed handler: the plugin must load after it.
  api.registerShopCurrency(STORE_CURRENCY, storeCurrency);
  api.onPlayerLogin(syncVarps);
  api.onCustomEvent("bounty-hunter:entered-arena", showBalance);
  api.onCustomEvent("bounty-hunter:left-arena", showBalance);
  api.onCustomEvent("bounty-hunter:target-killed", targetKilled);
  api.onCustomEvent("bounty-hunter:rogue-killed", rogueKilled);
};
Object.assign(module.exports, { getPoints, addPoints, targetKills, pointsForKill });
