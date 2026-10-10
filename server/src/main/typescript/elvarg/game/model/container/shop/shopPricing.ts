/**
 * shopPricing — scarcity pricing for NPC shops.
 *
 * Pure module (no imports): the multiplier is computed on transaction from
 * the shop's live stock vs its original (max) stock, so there is no
 * per-tick work. ShopManager.itemPrice applies it to the base price.
 *
 * Curve (multiplier on the base price):
 * - ratio >= 1 (full or overstocked): 1.0 at full, then an asymptotic
 *   discount toward OVERSTOCK_PRICE_FLOOR as players sell surplus in.
 * - ratio < 1 (scarce): linear markup from 1.0 at full stock to
 *   SCARCITY_MAX_MARKUP at zero stock.
 * - No original-stock record (player sold-ins, custom runtime stock):
 *   multiplier 1.0 — base price untouched.
 *
 * Bounds are deliberately tight: 3x max markup keeps staples affordable
 * even when nearly out, and the 0.5x floor keeps overstock from becoming
 * free. Sell prices derive from the same itemPrice, so selling into a
 * scarce shop pays more — an incentive to restock it.
 */
export const SCARCITY_MAX_MARKUP = 3;
export const OVERSTOCK_PRICE_FLOOR = 0.5;

/**
 * Kingdom-choice price bias for NPC shops. Home-kingdom players get a small
 * discount, foreigners pay a small premium, wanderers (no kingdom) pay list.
 * Pure function — computed on transaction, no per-tick work. Stacks
 * multiplicatively with the scarcity multiplier: final = base × scarcity × bias.
 *
 * Reads the player's RAW kingdom:id (not a fallback helper) so wanderers are
 * never mispriced. Shops without a kingdomId (outside the great powers, or
 * missing data) are neutral ground: 1.0 for everyone.
 */
export const KINGDOM_HOME_BIAS = 0.95;
export const KINGDOM_FOREIGN_BIAS = 1.08;

export function kingdomPriceBias(
    playerKingdomId: unknown,
    shopKingdomId: unknown
): number {
    if (
        typeof playerKingdomId !== "string" ||
        playerKingdomId.length === 0 ||
        typeof shopKingdomId !== "string" ||
        shopKingdomId.length === 0
    ) {
        return 1;
    }
    return playerKingdomId === shopKingdomId
        ? KINGDOM_HOME_BIAS
        : KINGDOM_FOREIGN_BIAS;
}

export function scarcityPriceMultiplier(current: number, max: number): number {
    if (!(max > 0)) {
        return 1;
    }
    const ratio = Math.max(0, current) / max;
    if (ratio >= 1) {
        return Math.max(OVERSTOCK_PRICE_FLOOR, 1 / (1 + 0.5 * (ratio - 1)));
    }
    return Math.min(
        SCARCITY_MAX_MARKUP,
        1 + (SCARCITY_MAX_MARKUP - 1) * (1 - ratio)
    );
}
