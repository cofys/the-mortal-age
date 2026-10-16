import { PRAYERBOOK } from "@runelite/api/gameval/VarbitID";
import type { PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { PRAYER_SORT_EVENT, QUICK_PRAYER_SORT_EVENT } from "../../../rs/cs2/sortCallbacks";
import { BookReorderPlugin, type BookWidget, type SortedList } from "./BookReorderPlugin";
import { prayerOrder, swapPrayers, visibleList } from "./tabReorder";

const GROUP = "prayer";
/** prayerbook:universe, whose var listener is prayer_redraw. */
const PRAYERBOOK_ROOT = (541 << 16) | 0;
/** toplevel:stone5, toplevel_osrs_stretch:stone5, toplevel_pre_eoc:stone5 (the Prayer tab). */
const PRAYER_STONES = [(548 << 16) | 69, (161 << 16) | 64, (164 << 16) | 57];
/** Hide/Unhide is op 4, as RuneLite. */
const HIDE_OP = 4;
/** obj params: the prayer's component, and its level (prayer_quicksort's key). */
const PARAM_PRAYER_COMPONENT = 1751;
const PARAM_PRAYER_LEVEL = 1753;
/** prayer_redraw and prayer_updatebutton (both script ids of each), which redo a prayer's ops. */
const PRAYER_REDRAW_SCRIPTS = new Set([359, 547]);
const PRAYER_UPDATEBUTTON_SCRIPTS = new Set([461, 463]);
/** The prayer's icon (prayer_redraw's second dynamic child), faded while hidden. */
const ICON_CHILD = 1;
/** RuneLite's opacity for a hidden prayer's icon while reordering. */
const HIDDEN_TRANSPARENCY = 200;

/**
 * Port of RuneLite's prayer reordering (its Prayer plugin): right-click the Prayer tab for
 * "Enable prayer reordering", then drag a prayer onto another to swap them, or Hide it. The
 * order also applies to the quick-prayer setup. Saved per prayer book, under RuneLite's keys.
 */
export class PrayerPlugin extends BookReorderPlugin {
    static descriptor: PluginDescriptor = {
        name: "Prayer",
        description: "Reorder and hide prayers",
        tags: ["prayer", "reorder", "hide", "quick"],
        configKey: "prayerplugin",
    };

    protected readonly noun = "Prayer";
    protected readonly stones = PRAYER_STONES;
    protected readonly rootUid = PRAYERBOOK_ROOT;
    protected readonly redrawEvent = "onVarTransmit";
    protected readonly hideOp = HIDE_OP;
    protected readonly componentParam = PARAM_PRAYER_COMPONENT;
    protected readonly levelParam = PARAM_PRAYER_LEVEL;
    /** The prayer enum last drawn (it depends on the prayer book and unlocked prayers). */
    private prayers = -1;

    override resetConfiguration(): void {
        for (const prefix of ["prayer_order_book", "prayer_hidden_book"]) {
            for (const key of this.configManager.getConfigurationKeys(`${GROUP}.${prefix}`)) {
                this.configManager.unsetConfiguration(GROUP, key.slice(GROUP.length + 1));
            }
        }
        this.redraw();
    }

    onScriptFinished(scriptId: number): void {
        if (!this.isStarted()) return;
        // prayer_updatebutton clears the prayer's ops, Hide/Unhide among them.
        if (!PRAYER_REDRAW_SCRIPTS.has(scriptId) && !(this.reordering && PRAYER_UPDATEBUTTON_SCRIPTS.has(scriptId))) return;
        for (const entry of this.currentBook() ?? []) this.decorate(entry, this.reordering, this.isHidden(entry));
    }

    protected sortList(eventName: string, { enumId, shown }: SortedList): number[] | undefined {
        if (eventName !== PRAYER_SORT_EVENT && eventName !== QUICK_PRAYER_SORT_EVENT) return undefined;
        const entries = this.book(enumId);
        const order = prayerOrder(entries, this.savedOrder());
        if (eventName === QUICK_PRAYER_SORT_EVENT) return visibleList(shown, order, () => false, true);
        this.prayers = enumId;
        const byIndex = new Map(entries.map(entry => [entry.index, entry]));
        return visibleList(shown, order, index => {
            const entry = byIndex.get(index);
            return !!entry && this.isHidden(entry);
        }, this.reordering);
    }

    protected decorate(entry: BookWidget, reordering: boolean, hidden: boolean): void {
        const w = this.widget(entry);
        if (!w) return;
        this.setOp(w, HIDE_OP, reordering ? (hidden ? "Unhide" : "Hide") : null);
        this.setDraggable(entry, reordering);
        if (reordering && hidden) {
            const icon = this.client.widgetManager
                ?.getDynamicChildrenByParent(w)
                .find(child => (child as any).childIndex === ICON_CHILD);
            this.setTransparency(icon, HIDDEN_TRANSPARENCY);
        }
    }

    /** prayer_redraw rebuilds the icons, so their fading comes back right. */
    protected override toggleHidden(entry: BookWidget): void {
        this.setHidden(entry, !this.isHidden(entry));
        this.redraw();
    }

    protected move(from: BookWidget, to: BookWidget): void {
        const order = prayerOrder(this.book(this.prayers), this.savedOrder());
        const next = swapPrayers(order, from.index, to.index);
        this.configManager.setConfiguration(GROUP, `prayer_order_book_${this.prayerBook()}`, next.join(","));
        this.redraw();
    }

    protected currentBook(): BookWidget[] | undefined {
        return this.prayers === -1 ? undefined : this.book(this.prayers);
    }

    protected isHidden(entry: BookWidget): boolean {
        return this.configManager.getConfiguration(GROUP, this.hiddenKey(entry)) === "true";
    }

    protected setHidden(entry: BookWidget, hidden: boolean): void {
        if (hidden) this.configManager.setConfiguration(GROUP, this.hiddenKey(entry), true);
        else this.configManager.unsetConfiguration(GROUP, this.hiddenKey(entry));
    }

    private hiddenKey(entry: BookWidget): string {
        return `prayer_hidden_book_${this.prayerBook()}_${entry.index}`;
    }

    private savedOrder(): number[] | undefined {
        const saved = this.configManager.getConfiguration(GROUP, `prayer_order_book_${this.prayerBook()}`);
        if (!saved) return undefined;
        const order = saved.split(",").map(Number);
        return order.every(Number.isInteger) ? order : undefined;
    }

    /** 0 for the normal prayers, 1 for the ruinous ones. */
    private prayerBook(): number {
        return this.client.varManager?.getVarbit(PRAYERBOOK) ?? 0;
    }
}
