import { Opcodes } from "./Opcodes";
import type { Script } from "./Script";

/**
 * RuneLite-style `runelite_callback`s after the cache's list sorts, so a client plugin can
 * reorder or shorten a list before the script draws it (RuneLite injects the same
 * "spellbookSort" callback into magic_spellbook_redraw).
 *
 * After the sort returns, the patched script runs:
 *
 *     iload <enum>; iload <count>; oload <array>; sconst "<event>"; runelite_callback
 *     istore <count>; pop_int; pop_object
 *
 * so a listener sees the list's enum and length on the int stack (length on top) and the
 * sorted array on the object stack. It may sort the array's first `length` entries in place
 * and lower the length. The block is appended to the script, and the sort's `invoke` becomes
 * a jump to it, so no other jump offset changes.
 */
export type SortCallback = {
    scriptId: number;
    /** The sort the script invokes: sort(array, 0, count - 1[, enum]). */
    sortScript: number;
    eventName: string;
    enumLocal: number;
    countLocal: number;
    arrayLocal: number;
};

export const SPELLBOOK_SORT_EVENT = "spellbookSort";
export const PRAYER_SORT_EVENT = "prayerSort";
export const QUICK_PRAYER_SORT_EVENT = "quickPrayerSort";

export const SORT_CALLBACKS: readonly SortCallback[] = [
    // magic_spellbook_redraw, after magic_spellbook_sort
    { scriptId: 2611, sortScript: 2621, eventName: SPELLBOOK_SORT_EVENT, enumLocal: 14, countLocal: 22, arrayLocal: 2 },
    // prayer_redraw, after prayer_quicksort
    { scriptId: 547, sortScript: 465, eventName: PRAYER_SORT_EVENT, enumLocal: 10, countLocal: 11, arrayLocal: 2 },
    // quickprayer_init, after prayer_quicksort
    { scriptId: 466, sortScript: 465, eventName: QUICK_PRAYER_SORT_EVENT, enumLocal: 3, countLocal: 4, arrayLocal: 0 },
];

/** Finds `oload array; iconst 0; iload count; iconst 1; sub; [iload enum;] invoke sort`. */
function findSortCall(script: Script, callback: SortCallback): number {
    const { instructions: ops, intOperands: args } = script;
    let found = -1;
    for (let pc = 0; pc < ops.length; pc++) {
        if (ops[pc] !== Opcodes.INVOKE || args[pc] !== callback.sortScript) continue;
        let at = pc - 1;
        if (ops[at] === Opcodes.ILOAD && args[at] === callback.enumLocal) at--;
        const matches =
            ops[at] === Opcodes.SUB &&
            ops[at - 1] === Opcodes.ICONST && args[at - 1] === 1 &&
            ops[at - 2] === Opcodes.ILOAD && args[at - 2] === callback.countLocal &&
            ops[at - 3] === Opcodes.ICONST && args[at - 3] === 0 &&
            ops[at - 4] === Opcodes.OLOAD && args[at - 4] === callback.arrayLocal;
        if (!matches || found !== -1) return -1;
        found = pc;
    }
    return found;
}

/** Adds the callback; returns false (script unchanged) if the sort call isn't where expected. */
export function addSortCallback(script: Script, callback: SortCallback): boolean {
    const call = findSortCall(script, callback);
    if (call === -1) return false;
    const block: [number, number, string | null][] = [
        [Opcodes.INVOKE, callback.sortScript, null],
        [Opcodes.ILOAD, callback.enumLocal, null],
        [Opcodes.ILOAD, callback.countLocal, null],
        [Opcodes.OLOAD, callback.arrayLocal, null],
        [Opcodes.SCONST, 0, callback.eventName],
        [Opcodes.RUNELITE_CALLBACK, 0, null],
        [Opcodes.ISTORE, callback.countLocal, null],
        [Opcodes.POP_INT, 0, null],
        [Opcodes.POP_OBJECT, 0, null],
    ];
    const start = script.instructions.length;
    const end = start + block.length;
    // A jump at pc goes to pc + offset + 1.
    block.push([Opcodes.JUMP, call + 1 - end - 1, null]);

    const instructions = new Int32Array(end + 1);
    instructions.set(script.instructions);
    const intOperands = new Int32Array(end + 1);
    intOperands.set(script.intOperands);
    const stringOperands = script.stringOperands.slice();
    stringOperands.length = end + 1;
    const longOperands = new BigInt64Array(end + 1);
    longOperands.set(script.longOperands.subarray(0, start));
    block.forEach(([opcode, operand, text], i) => {
        instructions[start + i] = opcode;
        intOperands[start + i] = operand;
        stringOperands[start + i] = text;
    });
    instructions[call] = Opcodes.JUMP;
    intOperands[call] = start - call - 1;

    script.instructions = instructions;
    script.intOperands = intOperands;
    script.stringOperands = stringOperands;
    script.longOperands = longOperands;
    return true;
}

export function applySortCallbacks(script: Script): void {
    for (const callback of SORT_CALLBACKS) {
        if (callback.scriptId !== script.id) continue;
        if (!addSortCallback(script, callback)) {
            console.warn(`[cs2] script ${script.id}: no ${callback.eventName} sort call to patch`);
        }
    }
}
