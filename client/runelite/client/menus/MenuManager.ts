import { ClientState } from "../../../game/ClientState";
import type { SimpleMenuEntry } from "../../../ui/menu/MenuEngine";
import type { MenuTransformContext } from "../../../ui/menu/menuTransforms";
import type { WidgetMenuOption } from "./WidgetMenuOption";

/** MenuAction.CC_OP. */
const CC_OP = 57;

/**
 * RuneLite's MenuManager (its managed custom menus): options added to particular widgets'
 * right-click menus. RuneLite adds them as the widget's first CC_OP entry is added, just above
 * it, so they sit over the widget's last op; this does the same to the finished entry list.
 */
export class MenuManager {
    private readonly managedMenuOptions = new Map<number, WidgetMenuOption[]>();

    addManagedCustomMenu(customMenuOption: WidgetMenuOption, callback: () => void): void {
        for (const id of customMenuOption.widgetIds) {
            const options = this.managedMenuOptions.get(id) ?? [];
            if (!options.includes(customMenuOption)) options.push(customMenuOption);
            this.managedMenuOptions.set(id, options);
        }
        customMenuOption.callback = callback;
    }

    removeManagedCustomMenu(customMenuOption: WidgetMenuOption): void {
        for (const id of customMenuOption.widgetIds) {
            const options = this.managedMenuOptions.get(id)?.filter((o) => o !== customMenuOption) ?? [];
            if (options.length > 0) this.managedMenuOptions.set(id, options);
            else this.managedMenuOptions.delete(id);
        }
    }

    /** A widget menu (display order, top first) with the managed options for its widget. */
    apply(entries: SimpleMenuEntry[], context: MenuTransformContext): SimpleMenuEntry[] {
        if (context.surface === "world") return entries;
        if (ClientState.isSpellSelected || ClientState.isItemSelected) return entries;
        const widgetId = context.widgetId;
        if (widgetId === undefined) return entries;
        const options = this.managedMenuOptions.get(widgetId);
        if (!options || options.length === 0) return entries;
        // The widget's first-added CC_OP entry is its lowest one on screen.
        let firstOp = -1;
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].opcode === CC_OP) {
                firstOp = i;
                break;
            }
        }
        if (firstOp === -1) return entries;
        const added: SimpleMenuEntry[] = [];
        for (const option of options) {
            if (entries.some((e) => e.option === option.menuOption && e.target === option.menuTarget)) return entries;
            added.push({
                option: option.menuOption,
                target: option.menuTarget,
                param1: widgetId,
                onClick: () => option.callback?.(),
            });
        }
        return [...entries.slice(0, firstOp), ...added, ...entries.slice(firstOp)];
    }
}
