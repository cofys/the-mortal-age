"use strict";

/**
 * CitizenCharterToll — collects guild charter tolls on GE sell offers.
 *
 * WHAT IT DOES (custom-event listener, zero LLM):
 *   Listens for the GE plugin's `ge:offer-confirmed` event. When a SELL offer
 *   is confirmed:
 *     1. Reads the seller's kingdom from player attributes (defensive).
 *     2. Maps the sold itemId to a charter category via ItemDefinition name
 *        keywords (defensive — unknown items are skipped).
 *     3. If (kingdom, category) is chartered AND the seller is not a member
 *        of the holding guild, takes the flat sale toll (SALE_TOLL_FLAT) from
 *        the seller's inventory as real coins and credits the holding guild's
 *        treasury via CitizenTradeCharters.collectToll.
 *   Silent by design (same as the economy fee hook): no chat spam.
 *   The seller is notified once via sendMessage (their coins moved).
 *
 * Honesty: no charter = no toll. Guild members are exempt. Unknown items
 * or missing kingdom = skipped, never guessed. Every coin is real.
 */

const Charters = require("./CitizenTradeCharters");

// Keyword -> charter category. Matched against the lowercased item name.
// Conservative: only clear product categories.
const CATEGORY_KEYWORDS = Object.freeze([
  [/\b(sword|scimitar|dagger|mace|warhammer|battleaxe|halberd|longsword)\b/, "weapons"],
  [/\b(platebody|platelegs|plateskirt|chainbody|full helm|med helm|sq shield|kiteshield)\b/, "armor"],
  [/\b(shark|lobster|swordfish|tuna|salmon|trout|pike|bread|cake|pie|stew|curry|pizza)\b/, "food"],
  [/\bpotion\b/, "potions"],
  [/\brune\b/, "runes"],
  [/\blogs\b/, "lumber"],
  [/\bore\b/, "ore"],
  [/\b(ring|necklace|amulet|bracelet)\b/, "jewelry"],
]);

const COINS_ID = 995;

function categoryForItemName(name) {
  const n = String(name ?? "").toLowerCase();
  if (!n || n === "null") return null;
  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (re.test(n)) return cat;
  }
  return null;
}

function kingdomOf(player) {
  try {
    return (
      player?.getAttribute?.("kingdom:id") ??
      player?.getAttribute?.("kingdomId") ??
      null
    );
  } catch {
    return null;
  }
}

let itemNameOverride = null;

/** Test seam — override item name lookup (tests have no ItemDefinition). */
function _setItemNameForTests(fn) {
  itemNameOverride = fn;
}

function itemNameOf(itemId) {
  if (itemNameOverride) {
    try {
      return itemNameOverride(itemId);
    } catch {
      return null;
    }
  }
  try {
    // Same pattern as the GE plugin (server/plugins/interface/).
    const { ItemDefinition } = require("../../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
    return ItemDefinition.forId(itemId)?.getName?.() ?? null;
  } catch {
    return null;
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function coinsOf(player) {
  try {
    const inv = player?.getInventory?.();
    return Number(inv?.getAmount?.(COINS_ID) ?? inv?.count?.(COINS_ID) ?? 0);
  } catch {
    return 0;
  }
}

function takeCoins(player, amount) {
  // Canonical: deleteNumber(id, amount) with balance verification. ItemContainer
  // has no inv.remove(id, amount).
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(COINS_ID, amount);
    return (inv.getAmount?.(COINS_ID) ?? 0) === before - amount;
  } catch {
    // fall through
  }
  return false;
}

function offerValueOf(event) {
  // The confirmation event doesn't carry price or quantity, so the toll is
  // flat (SALE_TOLL_FLAT), not percentage-based. TOLL_BPS remains the
  // reference rate for consumers that do know the offer value.
  void event;
  return 0;
}

/**
 * Handle ge:offer-confirmed. Exported for tests; wired via
 * api.onCustomEvent in Citizens.plugin.js.
 */
function onOfferConfirmed(event) {
  try {
    if (!event || event.sell !== true || event.accepted === false) return;
    const player = event.player;
    if (!player) return;
    const kingdomId = kingdomOf(player);
    if (!kingdomId) return;

    const name = itemNameOf(event.itemId);
    const category = categoryForItemName(name);
    if (!category) return;

    const holder = Charters.charterHolder(kingdomId, category);
    if (!holder) return; // no charter, no toll

    const username = usernameOf(player);
    if (Charters.memberExempt(username)) return; // guild members exempt

    const toll = Charters.SALE_TOLL_FLAT;
    if (!(toll > 0)) return;
    if (coinsOf(player) < toll) return; // can't pay, don't block the trade

    if (takeCoins(player, toll)) {
      Charters.collectToll(holder, toll);
      try {
        player.sendMessage?.(
          `A ${toll.toLocaleString("en-US")} coin charter toll was collected for the ${holder === "merchants" ? "Merchants'" : "Crafters'"} Guild's ${category} monopoly in ${kingdomId}.`
        );
      } catch {
        // messaging is best-effort
      }
    }
  } catch {
    // never throw from an event listener
  }
}

module.exports = {
  onOfferConfirmed,
  categoryForItemName,
  _setItemNameForTests,
};
