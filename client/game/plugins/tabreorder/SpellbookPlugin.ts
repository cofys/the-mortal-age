import type { PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { SPELLBOOK_SORT_EVENT } from "../../../rs/cs2/sortCallbacks";
import { BookReorderPlugin, type BookWidget, type SortedList } from "./BookReorderPlugin";
import { moveSpell, spellOrder, visibleList } from "./tabReorder";

const GROUP = "spellbook";
/** magic_spellbook:universe, whose inventory listener is magic_spellbook_redraw. */
const SPELLBOOK_ROOT = (218 << 16) | 0;
/** toplevel:stone6, toplevel_osrs_stretch:stone6, toplevel_pre_eoc:stone6 (the Magic tab). */
const MAGIC_STONES = [(548 << 16) | 70, (161 << 16) | 65, (164 << 16) | 58];
/** magic_spellbook_modifyops uses ops 1-5 and 10, so Hide/Unhide is op 6 (as RuneLite). */
const HIDE_OP = 6;
/** obj params: the spell's button component, and its level (magic_spellbook_sort's key). */
const PARAM_SPELL_BUTTON = 596;
const PARAM_SPELL_LEVEL = 604;
/** RuneLite's opacity for a hidden spell while reordering. */
const HIDDEN_TRANSPARENCY = 100;

/**
 * Port of RuneLite's Spellbook plugin: right-click the Magic tab for "Enable spell
 * reordering", then drag a spell onto another to move it there, or Hide it. Saved per
 * spellbook, under RuneLite's config keys.
 */
export class SpellbookPlugin extends BookReorderPlugin {
    static descriptor: PluginDescriptor = {
        name: "Spellbook",
        description: "Reorder and hide spells",
        tags: ["magic", "spells", "reorder", "hide"],
        configKey: "spellbookplugin",
    };

    protected readonly noun = "Spell";
    protected readonly stones = MAGIC_STONES;
    protected readonly rootUid = SPELLBOOK_ROOT;
    protected readonly redrawEvent = "onInvTransmit";
    protected readonly hideOp = HIDE_OP;
    protected readonly componentParam = PARAM_SPELL_BUTTON;
    protected readonly levelParam = PARAM_SPELL_LEVEL;
    /** The spellbook enum last drawn (spellbook and sublist, as magic_spellbook_redraw picks it). */
    private spellbook = -1;

    override resetConfiguration(): void {
        for (const key of this.configManager.getConfigurationKeys(`${GROUP}.spell_`)) {
            this.configManager.unsetConfiguration(GROUP, key.slice(GROUP.length + 1));
        }
        this.redraw();
    }

    protected sortList(eventName: string, { enumId, shown }: SortedList): number[] | undefined {
        if (eventName !== SPELLBOOK_SORT_EVENT) return undefined;
        this.spellbook = enumId;
        const entries = this.book(enumId);
        const byIndex = new Map(entries.map(entry => [entry.index, entry]));
        const isHidden = (index: number) => {
            const entry = byIndex.get(index);
            return !!entry && this.isHidden(entry);
        };
        for (const index of shown) {
            const entry = byIndex.get(index);
            if (!entry) continue;
            const hidden = isHidden(index);
            if (hidden && !this.reordering) this.hide(this.widget(entry));
            this.decorate(entry, this.reordering, hidden);
        }
        return visibleList(shown, spellOrder(entries, obj => this.position(obj)), isHidden, this.reordering);
    }

    protected decorate(entry: BookWidget, reordering: boolean, hidden: boolean): void {
        const w = this.widget(entry);
        if (!w) return;
        this.setTransparency(w, reordering && hidden ? HIDDEN_TRANSPARENCY : 0);
        this.setOp(w, HIDE_OP, reordering ? (hidden ? "Unhide" : "Hide") : null);
        this.setDraggable(entry, reordering);
    }

    protected move(from: BookWidget, to: BookWidget): void {
        const entries = this.book(this.spellbook);
        const order = spellOrder(entries, obj => this.position(obj));
        const objOf = new Map(entries.map(entry => [entry.index, entry.obj]));
        for (const [index, position] of moveSpell(order, order.indexOf(from.index), order.indexOf(to.index))) {
            this.configManager.setConfiguration(GROUP, `spell_pos_book_${this.spellbook}_${objOf.get(index)}`, position);
        }
        this.redraw();
    }

    protected currentBook(): BookWidget[] | undefined {
        return this.spellbook === -1 ? undefined : this.book(this.spellbook);
    }

    protected isHidden(entry: BookWidget): boolean {
        return this.configManager.getConfiguration(GROUP, this.hiddenKey(entry)) === "true";
    }

    protected setHidden(entry: BookWidget, hidden: boolean): void {
        if (hidden) this.configManager.setConfiguration(GROUP, this.hiddenKey(entry), true);
        else this.configManager.unsetConfiguration(GROUP, this.hiddenKey(entry));
    }

    private hiddenKey(entry: BookWidget): string {
        return `spell_hidden_book_${this.spellbook}_${entry.obj}`;
    }

    private position(obj: number): number | undefined {
        const saved = this.configManager.getConfiguration(GROUP, `spell_pos_book_${this.spellbook}_${obj}`);
        const position = saved === undefined ? NaN : Number(saved);
        return Number.isInteger(position) ? position : undefined;
    }
}
