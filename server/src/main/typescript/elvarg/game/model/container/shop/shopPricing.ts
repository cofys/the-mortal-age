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
/** Hatred premium: disliked customers pay this on top of the home/foreign bias. */
export const HATRED_DISLIKED_MULT = 1.1;

// Hatred tier thresholds — must match server/plugins/kingdoms/Influence.Kingdoms.js
// (HATRED_HATED_AT / HATRED_ENEMY_AT, HATRED_FLOOR, decay rates). That module is
// the source of truth; this is a read-only mirror for the shop price path so
// the TS shop code doesn't import the JS plugin layer.
const HATRED_FLOOR = -150;
const HATRED_HATED_AT = -25;
const HATRED_ENEMY_AT = -100;
const HATRED_DECAY_PER_DAY = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HatredTier = "disliked" | "hated" | "enemy" | null;

/**
 * Hatred tier of a player with a shop's kingdom, read from the raw
 * kingdom:influence attribute ({ [kingdomId]: { points, lastEarned } }).
 * Settles idle decay the same way Influence.Kingdoms does: positive decays
 * toward zero (never into hatred), negative rises toward zero slowly.
 * Pure — computed on transaction, no per-tick work.
 */
export function hatredTierForShop(player: any, shopKingdomId: unknown): HatredTier {
    if (typeof shopKingdomId !== "string" || shopKingdomId.length === 0) {
        return null;
    }
    let rec: any = null;
    try {
        rec = player?.getAttribute?.("kingdom:influence")?.[shopKingdomId] ?? null;
    } catch {
        return null;
    }
    if (!rec || typeof rec !== "object") {
        return null;
    }
    const points = Number(rec.points ?? 0);
    if (!(points < 0)) {
        return null;
    }
    const idleDays = Math.floor(
        Math.max(0, (Date.now() - (Number(rec.lastEarned) || Date.now())) / DAY_MS)
    );
    const settled = Math.max(HATRED_FLOOR, Math.min(0, points + idleDays * HATRED_DECAY_PER_DAY));
    if (!(settled < 0)) {
        return null;
    }
    if (settled <= HATRED_ENEMY_AT) {
        return "enemy";
    }
    if (settled <= HATRED_HATED_AT) {
        return "hated";
    }
    return "disliked";
}

export function kingdomPriceBias(
    playerKingdomId: unknown,
    shopKingdomId: unknown,
    hatred: HatredTier = null
): number {
    if (
        typeof playerKingdomId !== "string" ||
        playerKingdomId.length === 0 ||
        typeof shopKingdomId !== "string" ||
        shopKingdomId.length === 0
    ) {
        return 1;
    }
    const base =
        playerKingdomId === shopKingdomId ? KINGDOM_HOME_BIAS : KINGDOM_FOREIGN_BIAS;
    return hatred === "disliked" ? base * HATRED_DISLIKED_MULT : base;
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
