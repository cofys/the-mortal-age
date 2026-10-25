/** JagexColors.MENU_TARGET: the orange of a menu entry's target. */
export const MENU_TARGET_COLOR = 0xff9040;

/** ColorUtil.wrapWithColorTag. */
function wrapWithColorTag(text: string, rgb: number): string {
    return `<col=${(rgb & 0xffffff).toString(16).padStart(6, "0")}>${text}</col>`;
}

/**
 * RuneLite's WidgetMenuOption: an option and target MenuManager adds to the right-click menu of
 * the widgets with these ids (packed group << 16 | child).
 */
export class WidgetMenuOption {
    menuOption: string;
    menuTarget = "";
    color = MENU_TARGET_COLOR;
    readonly widgetIds: readonly number[];
    callback?: () => void;

    constructor(menuOption: string, menuTarget: string, ...widgetIds: number[]) {
        this.menuOption = menuOption;
        this.setMenuTarget(menuTarget);
        this.widgetIds = widgetIds;
    }

    setMenuTarget(target: string): void {
        this.menuTarget = wrapWithColorTag(target, this.color);
    }
}
