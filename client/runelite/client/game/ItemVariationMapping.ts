import itemVariations from "./item_variations.json";

/**
 * RuneLite's ItemVariationMapping: groups of item ids that are variations of one item (charges,
 * doses, ornament kits), each led by its base id. `item_variations.json` is RuneLite 1.13.3's
 * (runelite-client/src/main/resources, BSD-2-Clause), minified.
 */
const MAPPINGS = new Map<number, number>();
const INVERTED = new Map<number, number[]>();

for (const ids of Object.values(itemVariations as Record<string, number[]>)) {
    const [base, ...rest] = ids;
    const variations = INVERTED.get(base) ?? [];
    for (const id of rest) {
        MAPPINGS.set(id, base);
        variations.push(id);
    }
    variations.push(base);
    INVERTED.set(base, variations);
}

/** The base item id of a variation, or the id itself. */
export function mapVariation(itemId: number): number {
    return MAPPINGS.get(itemId) ?? itemId;
}

/** Every id in the base item's group (the base last, as RuneLite's multimap lists it), or just the id. */
export function getVariations(itemId: number): readonly number[] {
    return INVERTED.get(itemId) ?? [itemId];
}
