"use strict";

/**
 * Ensures the inventory holds a tool (tinderbox), conjured the same way equipTool
 * provides an axe or pickaxe. Tools only: resources (ores, logs) must come from
 * gathering or a bank withdrawal, so bots never add free items to the economy.
 */
function createEnsureItemAction(spec) {
  const itemId = spec.item;
  const amount = Math.max(1, Math.floor(Number(spec.amount ?? 1)));
  return {
    id: "ensureItem",
    update(ctx) {
      const inventory = ctx.player?.getInventory?.();
      if (!inventory || !Number.isInteger(itemId)) {
        return "failed";
      }
      const missing = amount - inventory.getAmount(itemId);
      if (missing <= 0) {
        return "success";
      }
      inventory.adds(itemId, missing);
      return inventory.getAmount(itemId) >= amount ? "success" : "failed";
    },
  };
}

module.exports = {
  createEnsureItemAction,
};
