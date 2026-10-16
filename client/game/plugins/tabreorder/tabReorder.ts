/**
 * Ordering rules shared by the Spellbook and Prayer plugins (RuneLite's spell and prayer
 * reordering). Lists hold enum indices: the spellbook's or prayer book's enum maps each to
 * the spell's or prayer's obj.
 */

export type BookEntry = {
    /** Enum index (a prayer's id in RuneLite's saved order). */
    index: number;
    obj: number;
    /** The cache's sort key: the spell's level (param 604) or the prayer's (param 1753). */
    level: number;
};

/** The cache's own order (magic_spellbook_sort, prayer_quicksort): level, then enum index. */
export function defaultOrder(entries: readonly BookEntry[]): number[] {
    return entries
        .slice()
        .sort((a, b) => a.level * 1000 + a.index - (b.level * 1000 + b.index))
        .map(entry => entry.index);
}

/**
 * Every spell of a book in the player's order: each spell with a saved position goes there,
 * the rest keep their place in the cache's order (RuneLite's calculateSpellbookOrder).
 */
export function spellOrder(
    entries: readonly BookEntry[],
    savedPosition: (obj: number) => number | undefined,
): number[] {
    const objOf = new Map(entries.map(entry => [entry.index, entry.obj]));
    const order = defaultOrder(entries);
    const wanted = new Map(order.map((index, i) => [index, savedPosition(objOf.get(index)!) ?? i]));
    return order.slice().sort((a, b) => wanted.get(a)! - wanted.get(b)!);
}

/**
 * Dragging the spell at `from` onto the one at `to` (places in `order`) inserts it there; the
 * spells between shift by one. Returns the new position of every spell that moved.
 */
export function moveSpell(order: readonly number[], from: number, to: number): [index: number, position: number][] {
    if (from < 0 || to < 0 || from === to) return [];
    const moved: [number, number][] = [[order[from], to]];
    if (from < to) for (let i = from + 1; i <= to; i++) moved.push([order[i], i - 1]);
    else for (let i = to; i < from; i++) moved.push([order[i], i + 1]);
    return moved;
}

/**
 * A book's prayers in the player's order: the saved order, then any prayer it lacks (one
 * unlocked later) in the cache's order.
 */
export function prayerOrder(entries: readonly BookEntry[], saved: readonly number[] | undefined): number[] {
    const all = defaultOrder(entries);
    if (!saved) return all;
    const known = new Set(all);
    const order = saved.filter(index => known.has(index));
    const listed = new Set(order);
    return order.concat(all.filter(index => !listed.has(index)));
}

/** Dragging one prayer onto another swaps the two (RuneLite's PrayerReorder). */
export function swapPrayers(order: readonly number[], a: number, b: number): number[] {
    const from = order.indexOf(a);
    const to = order.indexOf(b);
    if (from === -1 || to === -1 || from === to) return order.slice();
    const next = order.slice();
    [next[from], next[to]] = [next[to], next[from]];
    return next;
}

/**
 * The list a redraw shows: the entries the cache's filters left, in the player's order, and
 * without the hidden ones unless reordering is on (hidden entries are then shown faded).
 */
export function visibleList(
    shown: readonly number[],
    order: readonly number[],
    isHidden: (index: number) => boolean,
    reordering: boolean,
): number[] {
    const rank = new Map(order.map((index, i) => [index, i]));
    const last = order.length;
    return shown
        .filter(index => reordering || !isHidden(index))
        .sort((a, b) => (rank.get(a) ?? last) - (rank.get(b) ?? last));
}
