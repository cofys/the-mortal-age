import assert from "node:assert/strict";
import { test } from "node:test";
import { clearWorldOverlays, loadFromPayload, getWorldLocChanges, getWorldLocSpawns, getWorldTerrainOverrides } from "../common/gamemode/GamemodeContentStore";

test("partial content updates preserve other world datasets; explicit empty datasets clear only their owner", () => {
    const changes = [{ oldId: 1, newId: 2, x: 3200, y: 3200, level: 0 }];
    const spawns = [{ locId: 3, x: 3201, y: 3200, level: 0, shape: 10, rotation: 0 }];
    const terrain = [{ x: 3200, y: 3200, level: 0, overlay: 4 }];
    loadFromPayload({ gamemodeId: "world", datasets: [
        { key: "worldLocChanges", rows: changes }, { key: "worldLocSpawns", rows: spawns },
        { key: "worldTerrainOverrides", rows: terrain },
    ] });
    loadFromPayload({ gamemodeId: "seasonal", datasets: [{ key: "definitionArchives", rows: [] }] });
    assert.deepEqual(getWorldLocChanges(), changes);
    assert.deepEqual(getWorldLocSpawns(), spawns);
    assert.deepEqual(getWorldTerrainOverrides(), terrain);
    loadFromPayload({ gamemodeId: "world", datasets: [{ key: "worldLocSpawns", rows: [] }] });
    assert.deepEqual(getWorldLocSpawns(), []);
    assert.deepEqual(getWorldLocChanges(), changes);
    assert.deepEqual(getWorldTerrainOverrides(), terrain);
    clearWorldOverlays();
    assert.deepEqual(getWorldLocChanges(), []);
    assert.deepEqual(getWorldLocSpawns(), []);
    assert.deepEqual(getWorldTerrainOverrides(), []);
});
