"use strict";

/**
 * The Kraken Cove crevice shortcut (see ../Kraken.plugin.js for behaviour and sources).
 *
 * Crevice (ObjectIdentifiers CREVICE_4 = 537) at (2280, 10017) Enter leads into the
 * Kraken boss pool at (2280, 10022); Crevice (CREVICE_5 = 538) at (2280, 10021) Use
 * leads back out to (2280, 10016). The out-landing is the tile players stand on at
 * the crevice (verified walkable in testing). The boss-side landing has no Wiki or
 * cache source: it is cross-checked against ReasonPS and stated as such (rule 10) —
 * an RSPS reference, not a capture. Plain moves: no squeeze animation was captured,
 * so none is played (estimate). Private/Peek on 537 are not handled here (private
 * instances are a follow-up).
 */

const Shared = require("./Shared.Kraken");

const CREVICE_IN_TILE = [2280, 10017, 0];
const BOSS_SIDE_TILE = [2280, 10022, 0];
const CREVICE_OUT_TILE = [2280, 10021, 0];
const COVE_SIDE_TILE = [2280, 10016, 0];

function creviceIds() {
  const { CREVICE_4, CREVICE_5 } = Shared.core().ObjectIdentifiers;
  return { IN: CREVICE_4, OUT: CREVICE_5 };
}

function at(object, tile) {
  const location = object?.getLocation?.();
  return !!location
    && location.getX() === tile[0]
    && location.getY() === tile[1]
    && location.getZ() === tile[2];
}

function go(player, tile) {
  const { Location } = Shared.core();
  player.moveTo(new Location(tile[0], tile[1], tile[2]));
  return true;
}

function enter({ player, object }) {
  if (!object || !Shared.alive(player)) return false;
  if (object.getId?.() !== creviceIds().IN || !at(object, CREVICE_IN_TILE)) return false;
  return go(player, BOSS_SIDE_TILE);
}

function use({ player, object }) {
  if (!object || !Shared.alive(player)) return false;
  if (object.getId?.() !== creviceIds().OUT || !at(object, CREVICE_OUT_TILE)) return false;
  return go(player, COVE_SIDE_TILE);
}

function attach(api) {
  api.onObjectInteraction("Crevice", { Enter: enter, Use: use });
}

module.exports = { attach, enter, use };
