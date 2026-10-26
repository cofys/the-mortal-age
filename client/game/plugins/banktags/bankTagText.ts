/** RuneLite's Text helpers, as Bank Tags uses them. */

/** Text.removeTags: drops `<...>` markup. */
export function removeTags(text: string): string {
    return String(text ?? "").replace(/<[^>]*>/g, "");
}

/** Text.standardize: no markup, non-breaking spaces as spaces, trimmed, lower case. */
export function standardize(text: string): string {
    return removeTags(text).replace(/ /g, " ").trim().toLowerCase();
}

/** Text.fromCSV: split on commas, trimmed, empties dropped. */
export function fromCSV(text: string): string[] {
    return String(text ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** Text.toCSV: joined with "," (Guava's Joiner.on(",")). */
export function toCSV(values: Iterable<string | number>): string {
    return Array.from(values, String).join(",");
}

/** TabInterface.FILTERED_CHARS: the characters a tag name can't contain. */
export function isAllowedTagChar(c: string): boolean {
    return !"</>:".includes(c);
}

/** ColorUtil.wrapWithColorTag. */
export function wrapWithColorTag(text: string, rgb: number): string {
    return `<col=${(rgb & 0xffffff).toString(16).padStart(6, "0")}>${text}</col>`;
}

/** JagexColors.MENU_TARGET, the orange of menu targets. */
export const MENU_TARGET_COLOR = 0xff9040;
