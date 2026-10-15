import assert from "node:assert/strict";

import {
    INTERACTION_WORLD_DEFAULT,
    TileInteractionMode,
    interactionModes,
} from "../game/InteractionModes";
import {
    createHelmSteeringDeps,
    handleTileClick,
    headingIndexToward,
    isInEntityZones,
} from "../game/sailing/HelmSteering";
import { WorldEntity } from "../game/worldview/WorldEntity";

const tile = (t: number) => t * 128 + 64;

// Packed headings: 0 = south, 4 = west, 8 = north, 12 = east.
assert.equal(headingIndexToward(tile(100), tile(100), tile(100), tile(90)), 0);
assert.equal(headingIndexToward(tile(100), tile(100), tile(90), tile(100)), 4);
assert.equal(headingIndexToward(tile(100), tile(100), tile(100), tile(110)), 8);
assert.equal(headingIndexToward(tile(100), tile(100), tile(110), tile(100)), 12);
assert.equal(headingIndexToward(tile(100), tile(100), tile(104), tile(104)), 10, "north-east");
assert.equal(headingIndexToward(tile(100), tile(100), tile(100), tile(100)), undefined);

// Measured from the drawn position, not the tile: a boat drawn 0.9 tiles east of a tile's
// centre steering at the tile three rows north of that tile turns north-west-ish, not north.
assert.equal(headingIndexToward(tile(100) + 115, tile(100), tile(100), tile(103)), 7);

function setup(atHelm: boolean, deckTile = false, deckMode = TileInteractionMode.Walk) {
    const boat = new WorldEntity(3000);
    boat.setPosition({ x: tile(100), y: 0, z: tile(100), orientation: 1024 });
    const sent: number[] = [];
    const deps = {
        // At the helm live sets heading as the default and walk for the boat's own world.
        getClickedWorldId: (tileX: number) => (tileX === 3000 ? 3000 : -1),
        getTileMode: (worldId: number) =>
            !atHelm ? TileInteractionMode.Walk : worldId === 3000 ? deckMode : TileInteractionMode.Heading,
        getLocalWorldViewId: () => 3000,
        getWorldEntity: () => boat,
        isDeckTile: () => deckTile,
        // The deck tile clicked sits 5 tiles east of the boat in the world.
        projectDeckToWorld: () => ({ x: tile(105), y: tile(100) }),
        // The click met the water 5 tiles north of the boat.
        pickClickedSeaPoint: () => ({ x: tile(100), y: tile(105) }),
        sendSetHeading: (heading: number) => sent.push(heading),
    };
    return { deps, sent };
}

{
    const { deps, sent } = setup(false);
    assert.equal(handleTileClick(deps, 100, 110), false, "walks when not at the helm");
    assert.deepEqual(sent, []);
}
{
    const { deps, sent } = setup(true);
    assert.equal(handleTileClick(deps, 100, 110), true);
    assert.deepEqual(sent, [8]);
}
{
    const { deps, sent } = setup(true, true);
    assert.equal(handleTileClick(deps, 9603, 9604), true, "deck-scene clicks aim at the sea point");
    assert.deepEqual(sent, [8]);
}
{
    const { deps, sent } = setup(true);
    assert.equal(handleTileClick(deps, 3000, 3000), false, "the boat's own world walks");
    assert.deepEqual(sent, []);
}
{
    const { deps, sent } = setup(true, false, TileInteractionMode.Disabled);
    assert.equal(handleTileClick(deps, 3000, 3000), true, "a disabled world swallows the click");
    assert.deepEqual(sent, []);
}

{
    // A click on the deck scene's drawn border, just outside its world view (as reported: tile
    // 10058,9565 for a scene from 10064), is the sea: it steers, aimed at the sea point.
    const { deps: base, sent } = setup(true);
    // The boat fills the scene's middle zone (6,6) on its deck plane.
    const templateChunks = [0, 1, 2, 3].map((plane) =>
        Array.from({ length: 13 }, (_, x) =>
            Array.from({ length: 13 }, (_, y) => (plane === 1 && x === 6 && y === 6 ? 123 : -1)),
        ),
    );
    const view = { id: 3000, baseX: 10064, baseY: 9552, sizeX: 104, sizeY: 104, templateChunks };
    assert.equal(isInEntityZones(view, 10064 + 48, 9552 + 55), true, "on the boat's zone");
    assert.equal(isInEntityZones(view, 10064 + 47, 9552 + 55), false, "the drawn sea beside it");
    const deps = createHelmSteeringDeps(
        {
            controlledPlayerServerId: 1,
            playerEcs: { getIndexForServerId: () => 0, getWorldViewId: () => 3000 },
            worldViewManager: {
                getWorldEntity: () => base.getWorldEntity(),
                getWorldView: () => view,
                findWorldViewAt: () => view,
            },
            renderer: { pickSeaPointAt: () => ({ x: tile(100), y: tile(105) }) },
            inputManager: { leftClickX: 0, leftClickY: 0 },
        },
        (heading) => sent.push(heading),
    );
    assert.equal(deps.isDeckTile(3000, 10058, 9565), true);
    assert.equal(deps.isDeckTile(3000, 1853, 3968), false, "a real world tile");
    assert.equal(deps.getClickedWorldId(10058, 9565), -1, "the sea beside the boat is the root world");
    assert.equal(deps.getClickedWorldId(10112, 9607), 3000, "the boat's zone is the boat's world");
    // As live at the helm: heading by default, walk on the boat's own world.
    interactionModes.set(INTERACTION_WORLD_DEFAULT, TileInteractionMode.Heading, 1);
    interactionModes.set(3000, TileInteractionMode.Walk, 1);
    assert.equal(handleTileClick(deps, 10112, 9607), false, "a click on the boat walks");
    assert.equal(handleTileClick(deps, 10058, 9565), true);
    assert.deepEqual(sent, [8], "toward the sea point, not toward tile 10058");

    // Leaving the helm: the boat's world is reset and the default goes back to walk.
    interactionModes.reset(3000);
    interactionModes.set(INTERACTION_WORLD_DEFAULT, TileInteractionMode.Walk, 1);
    assert.equal(handleTileClick(deps, 10058, 9565), false);
    assert.deepEqual(sent, [8]);
}

console.log("helm-steering: ok");
