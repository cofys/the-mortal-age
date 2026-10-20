import assert from "node:assert/strict";
import { test } from "node:test";

import { getMapPlaneId } from "../rs/map/MapFileIndex";
import { registerMinimapData } from "../render/render/minimap";

test("missing minimap data preserves the previous tile icons; explicit empty data clears them", () => {
    const key = getMapPlaneId(12, 34, 0);
    const previous = [{ elementId: 1 }] as any;
    const host = {
        osrsClient: { setMinimapImageUrl: () => assert.fail("no image was provided") },
        minimapIcons: new Map([[key, previous]]),
    } as any;

    registerMinimapData(host, { mapX: 12, mapY: 34 } as any);
    assert.equal(host.minimapIcons.get(key), previous);

    registerMinimapData(host, {
        mapX: 12,
        mapY: 34,
        minimapIcons: [[], [], [], []],
    } as any);
    assert.equal(host.minimapIcons.has(key), false);
});
