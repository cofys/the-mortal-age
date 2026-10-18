import { Opcodes } from "./Opcodes";
import type { Script } from "./Script";

/**
 * RuneLite's `runelite_callback`s in the scroll-wheel zoom handler (its
 * ScrollWheelZoomHandler.rs2asm), so the Camera plugin can block wheel zoom and change its step:
 *
 *     iconst 1; iconst 0; sconst "scrollWheelZoom"; runelite_callback
 *     if_icmpne +1; return                    ; a listener sets the top to 1 to block the zoom
 *     iconst 0; iload 0; iconst 25
 *     sconst "scrollWheelZoomIncrement"; runelite_callback   ; the step, 25 unless changed
 *     multiply; ...
 *
 * Both blocks sit ahead of the script's first jump, and its jumps are relative, so none move.
 */
export const SCROLL_WHEEL_ZOOM_SCRIPT = 39;
export const SCROLL_WHEEL_ZOOM_EVENT = "scrollWheelZoom";
export const SCROLL_WHEEL_ZOOM_INCREMENT_EVENT = "scrollWheelZoomIncrement";

type Op = [number, number, string | null];

/** `iconst 0; iload 0; iconst 25; multiply`: the delta times the step. */
const ZOOM_STEP: Op[] = [
    [Opcodes.ICONST, 0, null],
    [Opcodes.ILOAD, 0, null],
    [Opcodes.ICONST, 25, null],
    [Opcodes.MULTIPLY, 0, null],
];

function startsWith(script: Script, ops: readonly Op[]): boolean {
    return ops.every(
        ([opcode, operand], i) => script.instructions[i] === opcode && script.intOperands[i] === operand,
    );
}

/** Adds both callbacks; returns false (script unchanged) if the script isn't the one expected. */
export function addZoomCallbacks(script: Script): boolean {
    if (!startsWith(script, ZOOM_STEP) || script.stringOperands.includes(SCROLL_WHEEL_ZOOM_EVENT)) {
        return false;
    }
    const head: Op[] = [
        [Opcodes.ICONST, 1, null],
        [Opcodes.ICONST, 0, null],
        [Opcodes.SCONST, 0, SCROLL_WHEEL_ZOOM_EVENT],
        [Opcodes.RUNELITE_CALLBACK, 0, null],
        // A jump at pc goes to pc + offset + 1: past the return.
        [Opcodes.IF_ICMPNE, 1, null],
        [Opcodes.RETURN, 0, null],
        ...ZOOM_STEP.slice(0, 3),
        [Opcodes.SCONST, 0, SCROLL_WHEEL_ZOOM_INCREMENT_EVENT],
        [Opcodes.RUNELITE_CALLBACK, 0, null],
    ];
    const rest = 3;
    const length = head.length + script.instructions.length - rest;

    const instructions = new Int32Array(length);
    const intOperands = new Int32Array(length);
    const stringOperands: (string | null)[] = new Array(length).fill(null);
    const longOperands = new BigInt64Array(length);
    head.forEach(([opcode, operand, text], i) => {
        instructions[i] = opcode;
        intOperands[i] = operand;
        stringOperands[i] = text;
    });
    instructions.set(script.instructions.subarray(rest), head.length);
    intOperands.set(script.intOperands.subarray(rest), head.length);
    for (let i = rest; i < script.instructions.length; i++) {
        stringOperands[head.length + i - rest] = script.stringOperands[i] ?? null;
    }
    longOperands.set(script.longOperands.subarray(rest, script.instructions.length), head.length);

    script.instructions = instructions;
    script.intOperands = intOperands;
    script.stringOperands = stringOperands;
    script.longOperands = longOperands;
    return true;
}

export function applyZoomCallbacks(script: Script): void {
    if (script.id !== SCROLL_WHEEL_ZOOM_SCRIPT) return;
    if (!addZoomCallbacks(script)) {
        console.warn(`[cs2] script ${script.id}: no scroll-wheel zoom step to patch`);
    }
}
