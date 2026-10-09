"use strict";

/**
 * Treasury.Kingdoms — the court's purse: fealty taxes in, grants out.
 *
 * Two money movements, both scripted and journal-free:
 *
 *   collectTax(player, kingdomId, kind) — the court's due when influence
 *   lands. Fealty, earned promotions, and settled kingdom tasks each carry
 *   a small configurable coin tax from the player's purse into the kingdom
 *   treasury. Bots are excluded (the citizens director owns their wealth;
 *   bots don't carry purses). A player carrying nothing pays nothing — the
 *   tax never blocks the honor.
 *
 *   grantFromTreasury(kingdomId, granter, target, amount) — an office-holder
 *   grants treasury coins to a named player. The caller (the office
 *   dashboard) verifies the granter currently holds the seals; this module
 *   enforces the money rules: positive amount under the cap, treasury covers
 *   it, the recipient is a real online player, never a bot, never yourself.
 *
 * Persistence: the treasury lives on the kingdom record in KingdomStore
 * (data/saves/kingdoms.json), written by Store.save() on every mutation —
 * the same convention as donations, diplomacy gifts, and war drains. A
 * reseed never clobbers a live treasury (see upsertKingdom).
 */

const Store = require("./KingdomStore");

const COINS_ID = 995;

/** Config: the court's due, in coins. Small on purpose — a due, not a fine. */
const FEALTY_TAX = 25;
const PROMOTION_TAX = 50;
const TASK_TAX = 25;
/** Largest single treasury grant an office-holder may make. */
const GRANT_MAX = 100000;

const LAST_TAX_FLAG = "treasury:last-tax";

function taxForKind(kind) {
  switch (kind) {
    case "fealty":
      return FEALTY_TAX;
    case "promotion":
      return PROMOTION_TAX;
    case "task":
      return TASK_TAX;
    default:
      return 0;
  }
}

function isRealPlayer(player) {
  return !!player?.setAttribute && player.isPlayerBot?.() !== true;
}

function coinsCarried(player) {
  try {
    return Math.floor(player.getInventory?.()?.getAmount?.(COINS_ID) ?? 0);
  } catch {
    return 0;
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Collect the court's due when influence lands. Returns the coins taken
 * (0 when nothing moved). Emits kingdom:tax-collected through the injected
 * emitEvent(name, payload), mirroring Influence.settlePromotion's seam —
 * pass null when there is no bus (the money still moves).
 */
function collectTax(player, kingdomId, kind, emitEvent) {
  const due = taxForKind(kind);
  if (!isRealPlayer(player) || !kingdomId || !(due > 0)) return 0;
  const kingdom = Store.getKingdom(kingdomId);
  if (!kingdom) return 0;
  const taken = Math.min(due, coinsCarried(player));
  if (taken <= 0) return 0;
  try {
    const inventory = player.getInventory?.();
    inventory?.delete?.(COINS_ID, taken);
    inventory?.refreshItems?.();
  } catch {
    return 0;
  }
  Store.grantTax(kingdomId, taken);
  Store.recordIncome(kingdomId, kind, taken);
  Store.setFlag(kingdomId, LAST_TAX_FLAG, { at: Date.now(), amount: taken, source: kind });
  Store.save();
  try {
    player.sendMessage?.(
      `[Court] The crown takes its due — ${taken}c ${kind} tax to the ${kingdom.name} treasury.`
    );
  } catch {
    // Cosmetic; the tax already landed.
  }
  try {
    if (typeof emitEvent === "function") {
      emitEvent("kingdom:tax-collected", { kingdomId, amount: taken, source: kind });
    }
  } catch {
    // Notification only; the money already moved.
  }
  return taken;
}

/**
 * Grant treasury coins to a named player. The caller verifies the granter
 * currently holds the office seals (OfficeDashboardApi.checkHolder).
 * @returns {{ok: boolean, granted?: number, message?: string}}
 */
function grantFromTreasury(kingdomId, granter, target, amount) {
  const cost = Math.floor(Number(amount) || 0);
  if (!(cost > 0)) return { ok: false, message: "Name a sum greater than nothing." };
  if (cost > GRANT_MAX) {
    return { ok: false, message: `The court caps single grants at ${GRANT_MAX.toLocaleString("en-US")}c.` };
  }
  if (!target?.setAttribute) {
    return { ok: false, message: "That player is not here to receive it." };
  }
  if (target.isPlayerBot?.() === true) {
    return { ok: false, message: "The crown does not pay its own actors." };
  }
  const granterName = usernameOf(granter);
  const targetName = usernameOf(target);
  if (granterName && targetName && granterName.toLowerCase() === targetName.toLowerCase()) {
    return { ok: false, message: "The ledgers are watched — no grants to yourself." };
  }
  if (!Store.spendTax(kingdomId, cost)) {
    return { ok: false, message: "The coffers cannot bear it." };
  }
  try {
    const inventory = target.getInventory?.();
    // NOTE: ItemContainer.add takes an Item object, NOT (id, amount) —
    // the id/amount form is adds(). Using add() here used to throw and
    // silently delete the grant (treasury debited, player never paid).
    if (!inventory || typeof inventory.adds !== "function") {
      throw new Error("recipient has no inventory");
    }
    inventory.adds(COINS_ID, cost);
    inventory.refreshItems?.();
  } catch {
    // The treasury already paid; refund it rather than deleting the coins.
    try {
      Store.grantTax(kingdomId, cost);
      Store.save();
    } catch {
      // Best effort — the failure is already logged by the caller.
    }
    return { ok: false, message: "The grant failed to reach them — the treasury was refunded." };
  }
  Store.save();
  return { ok: true, granted: cost };
}

/** The most recent tax collection for the steward's survey, or null. */
function lastTax(kingdomId) {
  try {
    const rec = Store.getKingdom(kingdomId)?.flags?.[LAST_TAX_FLAG];
    return rec && typeof rec === "object" ? rec : null;
  } catch {
    return null;
  }
}

module.exports = {
  collectTax,
  grantFromTreasury,
  lastTax,
  taxForKind,
  FEALTY_TAX,
  PROMOTION_TAX,
  TASK_TAX,
  GRANT_MAX,
  COINS_ID,
  LAST_TAX_FLAG,
};
