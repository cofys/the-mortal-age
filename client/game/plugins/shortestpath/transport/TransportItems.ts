/** Shortest Path's account unlocks an item requirement can name as UNLOCK_<NAME>. */
export const UNLOCKS = ["CANOE_AXE", "DRAGONTOOTH", "XERICS_HONOUR", "KARAMJA_ELITE", "MOR_UL_REK", "BALLOON_LOG_BASKET"] as const;
export type Unlock = (typeof UNLOCKS)[number];

/** Coins, trading sticks, ecto-tokens and warrior guild tokens: priced against currencyThreshold. */
export const CURRENCIES: ReadonlySet<number> = new Set([995, 6306, 4278, 8851]);

/** One OR alternative of a requirement: any of the item ids, or a staff or offhand standing in for it. */
export type Branch = {
    readonly itemIds: readonly number[] | null;
    readonly staffIds: readonly number[] | null;
    readonly offhandIds: readonly number[] | null;
    readonly quantity: number;
    readonly unlock: Unlock | null;
};

/** One AND group: satisfied by any of its branches. */
export type ItemRequirement = { readonly branches: readonly Branch[] };

/** A transport's item requirements: every group must be satisfied. */
export class TransportItems {
    constructor(readonly requirements: readonly ItemRequirement[]) {}

    static merge(first: TransportItems | null, second: TransportItems | null): TransportItems | null {
        if (!first) return second;
        if (!second) return first;
        return new TransportItems([...first.requirements, ...second.requirements]);
    }

    /** A requirement whose branches are all unlocks: gated on the declared unlocks, not items. */
    static isPureUnlock(requirement: ItemRequirement): boolean {
        return requirement.branches.length > 0 && requirement.branches.every((b) => b.unlock !== null);
    }

    /**
     * TransportItems.isSatisfiedBy: every group is covered by an owned item, an unlock, one owned
     * offhand (a tome standing in for a rune, used once), and whatever is left by one owned staff.
     */
    isSatisfiedBy(itemCounts: ReadonlyMap<number, number>, currencyThreshold: number, unlocks: ReadonlySet<Unlock>): boolean {
        if (this.requirements.length === 0) return true;
        const leftover: ItemRequirement[] = [];
        let usedOffhand = false;
        for (const requirement of this.requirements) {
            const items = satisfiedByItems(requirement, itemCounts, currencyThreshold, unlocks);
            if (items === null) return false;
            if (items) continue;
            if (!usedOffhand && requirement.branches.some((b) => ownedIds(b.offhandIds, itemCounts, b.quantity, true).length > 0)) {
                usedOffhand = true;
                continue;
            }
            leftover.push(requirement);
        }
        return leftover.length === 0 || existsOneStaffCovering(leftover, itemCounts);
    }
}

/** true when owned, false when not, null when only owned beyond the currency threshold. */
function satisfiedByItems(requirement: ItemRequirement, itemCounts: ReadonlyMap<number, number>, currencyThreshold: number,
    unlocks: ReadonlySet<Unlock>): boolean | null {
    let blocked = false;
    for (const branch of requirement.branches) {
        if (branch.unlock !== null) {
            if (unlocks.has(branch.unlock)) return true;
            continue;
        }
        if (!branch.itemIds) continue;
        for (const itemId of branch.itemIds) {
            if (!hasQuantity(itemCounts, itemId, branch.quantity, false)) continue;
            if (CURRENCIES.has(itemId) && branch.quantity > currencyThreshold) {
                blocked = true;
                break;
            }
            return true;
        }
    }
    return blocked ? null : false;
}

function existsOneStaffCovering(leftover: ItemRequirement[], itemCounts: ReadonlyMap<number, number>): boolean {
    let candidates = null as Set<number> | null;
    for (const requirement of leftover) {
        const owned = new Set<number>();
        for (const branch of requirement.branches) {
            for (const id of ownedIds(branch.staffIds, itemCounts, branch.quantity, true)) owned.add(id);
        }
        if (owned.size === 0) return false;
        candidates = candidates === null ? owned : new Set([...candidates].filter((id: number) => owned.has(id)));
        if (candidates.size === 0) return false;
    }
    return true;
}

function ownedIds(ids: readonly number[] | null, itemCounts: ReadonlyMap<number, number>, required: number, unlimited: boolean): number[] {
    if (!ids) return [];
    return ids.filter((id) => hasQuantity(itemCounts, id, required, unlimited));
}

/** A quantity of 0 means "none held" (an empty equipment slot). */
function hasQuantity(itemCounts: ReadonlyMap<number, number>, itemId: number, required: number, unlimited: boolean): boolean {
    const quantity = itemCounts.get(itemId) ?? 0;
    if (unlimited) return (required > 0 && quantity >= 1) || (required === 0 && quantity === 0);
    return (required > 0 && quantity >= required) || (required === 0 && quantity === 0);
}
