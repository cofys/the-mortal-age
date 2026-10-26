/**
 * RuneLite's Layout: a tag tab's item positions. Slot `i` holds a (canonical) item id, or -1 for
 * an empty slot.
 */
export class Layout {
    readonly tag: string;
    private layout: number[];

    constructor(tag: string, layout?: readonly number[]);
    constructor(other: Layout);
    constructor(tagOrOther: string | Layout, layout: readonly number[] = []) {
        if (tagOrOther instanceof Layout) {
            this.tag = tagOrOther.tag;
            this.layout = [...tagOrOther.layout];
        } else {
            this.tag = tagOrOther;
            this.layout = [...layout];
        }
    }

    getLayout(): number[] {
        return [...this.layout];
    }

    getItemAtPos(pos: number): number {
        return pos < 0 || pos >= this.layout.length ? -1 : this.layout[pos];
    }

    setItemAtPos(itemId: number, pos: number): void {
        if (pos < 0) return;
        while (this.layout.length <= pos) this.layout.push(-1);
        this.layout[pos] = itemId;
    }

    addItem(itemId: number): void {
        this.addItemAfter(itemId, 0);
    }

    /** Puts the item in the first empty slot from `pos`, growing the layout if none is free. */
    addItemAfter(itemId: number, pos: number): void {
        let i: number;
        for (i = pos; i < this.layout.length; ++i) {
            if (this.layout[i] === -1) {
                this.layout[i] = itemId;
                return;
            }
        }
        this.resize(Math.max(pos + 1, this.layout.length + 1));
        this.layout[i] = itemId;
    }

    removeItem(itemId: number): void {
        for (let i = 0; i < this.layout.length; ++i) if (this.layout[i] === itemId) this.layout[i] = -1;
    }

    removeItemAtPos(pos: number): void {
        if (pos >= 0 && pos < this.layout.length) this.layout[pos] = -1;
    }

    swap(sidx: number, tidx: number): void {
        const sid = this.layout[sidx];
        this.layout[sidx] = this.layout[tidx];
        this.layout[tidx] = sid;
    }

    /** Moves the item at `sidx` to `tidx`, shifting the items between towards the next blank slot. */
    insert(sidx: number, tidx: number): void {
        const l = this.layout;
        const sid = l[sidx];
        if (sidx < tidx) {
            let i = tidx;
            while (i > sidx && l[i] > -1) --i;
            l[sidx] = -1;
            l.copyWithin(i, i + 1, tidx + 1);
            l[tidx] = sid;
        } else if (sidx > tidx) {
            let i = tidx;
            while (i < sidx && l[i] > -1) ++i;
            l[sidx] = -1;
            l.copyWithin(tidx + 1, tidx, i);
            l[tidx] = sid;
        }
    }

    count(itemId: number): number {
        return this.layout.reduce((n, id) => (id === itemId ? n + 1 : n), 0);
    }

    size(): number {
        return this.layout.length;
    }

    resize(size: number): void {
        if (size < this.layout.length) this.layout.length = size;
        while (this.layout.length < size) this.layout.push(-1);
    }

    lastItemIndex(): number {
        for (let i = this.layout.length - 1; i >= 0; --i) if (this.layout[i] !== -1) return i;
        return -1;
    }
}

/** RuneLite's AutoLayout: builds a layout from the previous one. */
export interface AutoLayout {
    generateLayout(previous: Layout): Layout;
}
