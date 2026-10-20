import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
    isMobileChatKeyboardFocused,
    shouldFreezeViewportForVirtualKeyboard,
} from "../common/utils/DeviceUtil";
import {
    applyForcedLandscapeSize,
    getForcedLandscapeRotation,
} from "../game/useSafariLandscapeLock";

test("chat keyboard resizes gameplay while login inputs keep the stable viewport", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
        Object.defineProperty(globalThis, "document", {
            configurable: true,
            value: { activeElement: { tagName: "INPUT", dataset: { mobileChatInput: "true" } } },
        });
        assert.equal(isMobileChatKeyboardFocused(), true);
        assert.equal(
            shouldFreezeViewportForVirtualKeyboard(
                { width: 800, height: 600 },
                { width: 800, height: 300 },
                true,
            ),
            false,
        );
        const properties = new Map<string, string>();
        const root = {
            dataset: { iosSafariForceLandscapeRotated: "0" },
            style: { setProperty: (key: string, value: string) => properties.set(key, value) },
        } as any;
        const portrait = applyForcedLandscapeSize(root, 390, 844);
        assert.deepEqual(portrait, { width: 844, height: 390, rotated: true });
        assert.equal(properties.get("--ios-safari-center-x"), "195px");
        assert.equal(properties.get("--ios-safari-center-y"), "422px");

        const keyboardAboveWidth = applyForcedLandscapeSize(root, 390, 500, true);
        assert.deepEqual(keyboardAboveWidth, { width: 500, height: 390, rotated: true });
        assert.equal(properties.get("--ios-safari-center-y"), "250px");

        const keyboardBelowWidth = applyForcedLandscapeSize(root, 390, 280, true, 0, 20);
        assert.deepEqual(
            keyboardBelowWidth,
            { width: 280, height: 390, rotated: true },
            "a keyboard-shrunk viewport below the phone width keeps its physical bounds and rotation",
        );
        assert.equal(properties.get("--ios-safari-landscape-w"), "280px");
        assert.equal(properties.get("--ios-safari-landscape-h"), "390px");
        assert.equal(properties.get("--ios-safari-center-x"), "195px");
        assert.equal(properties.get("--ios-safari-center-y"), "160px");

        const restored = applyForcedLandscapeSize(root, 390, 844);
        assert.deepEqual(restored, { width: 844, height: 390, rotated: true });
        assert.equal(root.dataset.iosSafariForceLandscapeRotated, "1");
        assert.equal(properties.get("--ios-safari-center-y"), "422px");

        const orientationChange = applyForcedLandscapeSize(root, 844, 390);
        assert.deepEqual(
            orientationChange,
            { width: 844, height: 390, rotated: false },
            "an already-landscape gameplay viewport stays unrotated",
        );
        assert.equal(root.dataset.iosSafariForceLandscapeRotated, "0");
        assert.equal(properties.get("--ios-safari-center-x"), "422px");
        assert.equal(properties.get("--ios-safari-center-y"), "195px");

        const sequenceRoot = {
            dataset: { iosSafariForceLandscapeRotated: "1" },
            style: { setProperty: () => {} },
        } as any;
        const sequence = [
            { width: 390, height: 280, portrait: true, rotated: true },
            { width: 390, height: 280, portrait: true, rotated: true },
            { width: 390, height: 270, portrait: true, rotated: true },
            { width: 390, height: 844, portrait: true, rotated: true },
            { width: 844, height: 390, portrait: false, rotated: false },
            { width: 390, height: 280, portrait: true, rotated: true },
            { width: 390, height: 280, portrait: true, rotated: true },
        ];
        for (const viewport of sequence) {
            const targetRotation = getForcedLandscapeRotation(
                true,
                sequenceRoot.dataset.iosSafariForceLandscapeRotated === "1",
                viewport.portrait,
            );
            const preserveRotation = targetRotation !== undefined;
            if (targetRotation !== undefined) {
                sequenceRoot.dataset.iosSafariForceLandscapeRotated =
                    targetRotation ? "1" : "0";
            }
            const applied = applyForcedLandscapeSize(
                sequenceRoot,
                viewport.width,
                viewport.height,
                preserveRotation,
            );
            assert.equal(
                applied.rotated,
                viewport.rotated,
                `rotation decision for ${viewport.width}x${viewport.height} while focused`,
            );
        }

        const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
        const rotatedLayout = css.match(
            /\.App\.ios-safari-force-landscape\.ios-safari-force-landscape-rotated\s*\{([^}]+)\}/,
        )?.[1];
        assert.ok(rotatedLayout, "forced-landscape rotated layout rule exists");
        assert.match(rotatedLayout, /top:\s*var\(--ios-safari-center-y/);
        assert.match(rotatedLayout, /left:\s*var\(--ios-safari-center-x/);
        assert.match(rotatedLayout, /width:\s*var\(--ios-safari-landscape-w/);
        assert.match(rotatedLayout, /height:\s*var\(--ios-safari-landscape-h/);

        Object.defineProperty(globalThis, "document", {
            configurable: true,
            value: { activeElement: { tagName: "INPUT", dataset: {} } },
        });
        assert.equal(isMobileChatKeyboardFocused(), false);
        assert.equal(
            shouldFreezeViewportForVirtualKeyboard(
                { width: 800, height: 600 },
                { width: 800, height: 300 },
            ),
            true,
        );
    } finally {
        if (original) Object.defineProperty(globalThis, "document", original);
        else delete (globalThis as { document?: Document }).document;
    }
});
