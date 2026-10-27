/**
 * Items that stand in for another in the id-keyed weapon tables: special attacks, ranged weapons
 * and their ammunition, and weapon profiles (animations, speed, reach). A minigame's own copy of
 * an item (Last Man Standing's br_ items, with their own ids but the same name and model) behaves
 * as the item it copies wherever it has no entry of its own.
 */
export class ItemAliases {
    private static readonly aliases = new Map<number, number>();

    /** `aliasId` behaves as `baseId` wherever it has no entry of its own. */
    public static register(aliasId: number, baseId: number): void {
        if (!Number.isInteger(aliasId) || !Number.isInteger(baseId) || aliasId <= 0 || baseId <= 0 || aliasId === baseId) return;
        ItemAliases.aliases.set(aliasId, baseId);
    }

    /** The item an id stands in for, or null when it is nobody's copy. */
    public static baseOf(id: number): number | null {
        return ItemAliases.aliases.get(Number(id)) ?? null;
    }

    /** Looks an id up in a table, then the item it copies. */
    public static lookup<V>(table: Map<number, V>, id: number): V | undefined {
        const own = table.get(Number(id));
        if (own !== undefined) return own;
        const base = ItemAliases.aliases.get(Number(id));
        return base === undefined ? undefined : table.get(base);
    }

    /** Whether two ids are the same item or one copies the other. */
    public static same(a: number, b: number): boolean {
        return Number(a) === Number(b) || ItemAliases.aliases.get(Number(a)) === Number(b) || ItemAliases.aliases.get(Number(b)) === Number(a);
    }
}
