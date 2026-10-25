"use strict";

/**
 * Esoteric emblems (OSRS Wiki: Esoteric emblem, Bounty Hunter#Bounty Hunter points).
 *
 * A target kill upgrades the killer's emblem one tier (to 10, or 5 while unskulled); a killer
 * who owns none gets a tier 1 emblem instead, unless they are an Ironman (they buy it from the
 * store) or penalised. A penalised killer's emblem is not upgraded either. Dying with an emblem
 * keeps it, one tier lower; a tier 1 emblem is lost. The trader buys them for points.
 */

const MAX_TIER = 10;
const MAX_UNSKULLED_TIER = 5;
/** Bounty Hunter points each tier is worth to the Emblem Trader. */
const POINT_VALUES = [2, 4, 7, 11, 16, 22, 29, 37, 46, 56];

let core;
let pluginApi;
/** EMBLEM_IDS[tier - 1] */
let EMBLEM_IDS = [];

function tierOfItem(itemId) {
  return EMBLEM_IDS.indexOf(itemId) + 1;
}

/** The emblem in the inventory: { tier, slot }, or null. */
function carriedEmblem(player) {
  const inventory = player.getInventory();
  for (let tier = MAX_TIER; tier >= 1; tier--) {
    const slot = inventory.getSlotForItemId(EMBLEM_IDS[tier - 1]);
    if (slot >= 0) return { tier, slot };
  }
  return null;
}

function ownsEmblem(player) {
  return EMBLEM_IDS.some((id) => player.getInventory().contains(id)
    || (player.getBanks?.() ?? []).some((bank) => bank?.contains?.(id)));
}

function setTier(player, slot, tier) {
  const inventory = player.getInventory();
  inventory.setItem(slot, tier > 0 ? new core.Item(EMBLEM_IDS[tier - 1], 1) : new core.Item(-1, 0));
  inventory.refreshItems();
}

function isIronman(player) {
  const query = { player, mode: "none" };
  pluginApi.emitCustomEvent("ironman:mode", query);
  return query.mode !== "none";
}

/** The tier a kill takes an emblem to, or null when it stays as it is. */
function upgradedTier(tier, killerSkulled) {
  const cap = killerSkulled ? MAX_TIER : MAX_UNSKULLED_TIER;
  return tier < cap ? tier + 1 : null;
}

// Best-guess messages: no capture of them exists.
function targetKilled({ killer, killerSkulled, penalised }) {
  if (penalised) return;
  const emblem = carriedEmblem(killer);
  if (emblem) {
    const tier = upgradedTier(emblem.tier, killerSkulled);
    if (tier === null) return;
    setTier(killer, emblem.slot, tier);
    killer.sendMessage(`Your esoteric emblem has been upgraded to tier ${tier}.`);
  } else if (!ownsEmblem(killer) && !isIronman(killer)) {
    killer.getInventory().forceAdd(killer, new core.Item(EMBLEM_IDS[0], 1));
    killer.sendMessage("You receive an esoteric emblem.");
  }
}

function died({ player }) {
  const emblem = carriedEmblem(player);
  if (!emblem) return;
  setTier(player, emblem.slot, emblem.tier - 1);
  player.sendMessage(emblem.tier > 1
    ? `Your esoteric emblem has been downgraded to tier ${emblem.tier - 1}.`
    : "Your esoteric emblem has been lost.");
}

/** The emblem stays with its owner; "bounty-hunter:died" takes the tier off. */
function keepEmblem(event) {
  if (tierOfItem(event.item?.getId?.()) > 0) event.keep = true;
}

module.exports = function attachBountyHunterEmblems(api) {
  core = api.core;
  pluginApi = api;
  EMBLEM_IDS = POINT_VALUES.map((_, index) => core.ItemIdentifiers[`ESOTERIC_EMBLEM_TIER_${index + 1}_`]);
  api.onShouldKeepItemOnDeath(keepEmblem);
  api.onCustomEvent("bounty-hunter:target-killed", targetKilled);
  api.onCustomEvent("bounty-hunter:died", died);
};
Object.assign(module.exports, { POINT_VALUES, carriedEmblem, tierOfItem, setTier, upgradedTier });
