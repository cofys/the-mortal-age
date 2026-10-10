"use strict";

const { Location } = require("../../../../src/main/typescript/elvarg/game/model/Location");
const { ObjectManager } = require("../../../../src/main/typescript/elvarg/game/entity/impl/object/ObjectManager");
const { RegionManager } = require("../../../../src/main/typescript/elvarg/game/collision/RegionManager");
const Firemaking = require("../../../skills/Firemaking.plugin");
const { requestMovement } = require("../../behaviours/navigation/BotNavigation");
const { playerState } = require("../ActionState");

const TILE_SEARCH_ATTEMPTS = 40;
// Banks are where the logs come from, and their floors refuse fires: look past the room.
const TILE_SEARCH_RADIUS = 6;
// Refused this many lights in a row (nowhere clear nearby): give the step up.
const MAX_REFUSED = 4;

/**
 * Burns the inventory's logs one at a time on clear tiles near the bank, then
 * completes. Wraps the firemaking plugin's bot entry point; produces events
 * already reset the frame stall clock.
 */
function createLightFireAction(spec, world) {
  function findBurnableLog(player) {
    for (const item of player.getInventory?.()?.getItems?.() ?? []) {
      const id = item?.getId?.();
      if (id > 0 && Firemaking.isWoodcuttingLog?.(id) && Firemaking.canPlayerBurnLog?.(player, id)) {
        return id;
      }
    }
    return null;
  }

  function moveToClearTile(player) {
    const loc = player.getLocation();
    for (let attempt = 0; attempt < TILE_SEARCH_ATTEMPTS; attempt++) {
      const dx = Math.floor(Math.random() * (TILE_SEARCH_RADIUS * 2 + 1)) - TILE_SEARCH_RADIUS;
      const dy = Math.floor(Math.random() * (TILE_SEARCH_RADIUS * 2 + 1)) - TILE_SEARCH_RADIUS;
      if (dx === 0 && dy === 0) {
        continue;
      }
      const candidate = new Location(loc.getX() + dx, loc.getY() + dy, loc.getZ());
      if (
        !RegionManager.blocked(candidate, player.getPrivateArea?.() ?? null) &&
        !ObjectManager.existsLocation(candidate) &&
        !Firemaking.isFireTileBlocked?.(candidate, player.getPrivateArea?.() ?? null)
      ) {
        requestMovement(player, candidate.getX(), candidate.getY(), {
          reason: "brain_light_tile",
          basicPather: true,
          z: candidate.getZ(),
        });
        return true;
      }
    }
    return false;
  }

  const action = {
    id: "lightFire",
    update(ctx) {
      const { player } = ctx;
      const bot = playerState(action, player, () => ({ refused: 0 }));
      if (Firemaking.isFiremakingActive?.(player)) {
        return "running";
      }
      const logId = findBurnableLog(player);
      if (logId == null) {
        return "success";
      }
      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }
      const loc = player.getLocation();
      // The skill's own rule: a fire, or a map object here (a bank floor), refuses the light.
      const blocked = ObjectManager.existsLocation(loc) ||
        Firemaking.isFireTileBlocked?.(loc, player.getPrivateArea?.() ?? null) === true;
      if (!blocked && Firemaking.startBotInventoryFiremaking?.(player, logId) !== false) {
        bot.refused = 0;
        return "running";
      }
      bot.refused += 1;
      if (bot.refused >= MAX_REFUSED) {
        bot.refused = 0;
        return "failed";
      }
      return moveToClearTile(player) ? "running" : "failed";
    },
    stop(ctx) {
      playerState(action, ctx.player, () => ({ refused: 0 })).refused = 0;
    },
  };
  return action;
}

module.exports = {
  createLightFireAction,
};
