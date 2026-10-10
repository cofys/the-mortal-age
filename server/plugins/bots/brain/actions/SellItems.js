"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { playerState } = require("../ActionState");
const { requestMovement, peekMovementRequest } = require("../../behaviours/navigation/BotNavigation");
const { nearestClusters, npcClustersFor } = require("../NpcClusterIndex");

// Close enough to the shopkeeper to trade (the Trade option's reach, roughly).
const TRADE_RANGE = 3;
// Not moving this long on the way to a store: give up so the activity backs off.
const STUCK_MS = 30000;

/** General stores (matched by name, like ShopManager does) -> keeper NPC id -> shop id. */
function loadGeneralStoreKeepers() {
  const file = path.join(process.cwd(), "data", "definitions", "shops.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const keepers = new Map();
  for (const shop of Array.isArray(raw) ? raw : raw.shops ?? []) {
    if (!/general store/i.test(shop.name ?? "")) continue;
    for (const link of shop.npcInteractions ?? []) {
      for (const npcId of link.npcIds ?? []) keepers.set(npcId, shop.id);
    }
  }
  return keepers;
}

/**
 * Walks to the nearest general store keeper (found through the NPC cluster index,
 * no hard-coded store locations) and sells the listed items through the normal
 * shop code: prices, stock and coins as for a player. Unsellable leftovers stay.
 */
function createSellItemsAction(spec, world, keepers = loadGeneralStoreKeepers()) {
  const itemIds = (spec.itemIds ?? []).filter(Number.isInteger);
  const keeperShop = (npc) => keepers.get(npc?.getDefinition?.()?.getId?.());
  const stateFor = (player) => playerState(action, player, () => ({ position: null, movedAt: 0, moved: false }));

  function nearestStore(player) {
    const loc = player.getLocation();
    const index = npcClustersFor(world, "generalStoreKeepers",
      (definition) => (keepers.has(definition?.getId?.()) ? "keeper" : null));
    return nearestClusters(index, ["keeper"], { x: loc.getX(), y: loc.getY(), z: loc.getZ() })[0] ?? null;
  }

  function sell(player, shopId) {
    const { ShopManager } = world.core;
    if (!ShopManager.open(player, shopId, true)) return false;
    const inventory = player.getInventory();
    for (const itemId of itemIds) {
      const amount = inventory.getAmount(itemId);
      const slot = inventory.getItems().findIndex((item) => item?.getId?.() === itemId);
      if (amount <= 0 || slot < 0) continue;
      ShopManager.handleItemContainerAction(player, {
        kind: "buy_sell", containerId: ShopManager.INVENTORY_INTERFACE_ID, slot, itemId, amount,
      });
    }
    ShopManager.close(player);
    return true;
  }

  const action = {
    id: "sellItems",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (!itemIds.some((itemId) => player.getInventory().getAmount(itemId) > 0)) return "success";
      const loc = player.getLocation();
      const position = `${loc.getX()},${loc.getY()},${loc.getZ()}`;
      if (position !== bot.position) {
        bot.position = position;
        bot.movedAt = nowMs;
        bot.moved = true;
      } else if (nowMs - bot.movedAt > STUCK_MS) {
        return "failed";
      }
      const keeper = world.core.World.getNpcsNear(loc, 16, player.getPrivateArea?.() ?? null)
        .find((npc) => keeperShop(npc) !== undefined && npc.isRegistered?.() !== false);
      const at = keeper?.getLocation();
      if (at && Math.max(Math.abs(at.getX() - loc.getX()), Math.abs(at.getY() - loc.getY())) <= TRADE_RANGE) {
        return sell(player, keeperShop(keeper)) ? "success" : "failed";
      }
      if (player.getMovementQueue().size() > 0 || peekMovementRequest(player)) return "running";
      const store = at ? { x: at.getX(), y: at.getY(), z: at.getZ() } : nearestStore(player);
      if (!store) return "failed";
      requestMovement(player, store.x, store.y, { nowMs, z: store.z, reason: "brain_sell_walk", basicPather: true });
      return "running";
    },
    stop(ctx) {
      stateFor(ctx.player).position = null;
    },
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      const moved = bot.moved;
      bot.moved = false;
      return moved;
    },
    describe(ctx) {
      return `sell items=${itemIds.join(",")}`;
    },
  };
  return action;
}

module.exports = {
  createSellItemsAction,
  loadGeneralStoreKeepers,
};
