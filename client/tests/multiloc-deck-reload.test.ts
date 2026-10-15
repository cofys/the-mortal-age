import assert from "node:assert/strict";

import { GameRenderer } from "../game/GameRenderer";
import { WorldViewManager } from "../game/worldview/WorldViewManager";
import { getMapSquareId } from "../rs/map/MapFileIndex";

// A varp multiloc stands in a world square and on a boat's deck (deck scenes are drawn as the
// overlay map square 200+index). A change to its varp reloads the world square as a map square
// but rebuilds the deck from its template: a plain reload of the deck's square built an empty
// square in its place and the boat vanished.
const locTypeLoader: any = { load: (id: number) => (id === 100 ? { transforms: [1, 2], transformVarbit: -1, transformVarp: 42 } : undefined) };
const varbitLoader: any = { load: () => undefined };
const withMultiloc = [Int32Array.from([100])];

const worldViews = new WorldViewManager();
worldViews.createWorldView(3008, 104, 104);
const deckMapId = worldViews.getWorldView(3008)!.overlayMapId;

const reloaded: string[] = [];
const rebuiltDecks: number[] = [];
const renderer: any = {
    changedVarps: new Set([42]),
    osrsClient: {
        loaderFactory: { getVarBitTypeLoader: () => varbitLoader },
        locTypeLoader,
        updateVars: () => {},
        worldViewManager: worldViews,
    },
    mapManager: {
        mapSquares: new Map([
            [getMapSquareId(50, 50), { mapX: 50, mapY: 50, tileLocIdsByLevel: withMultiloc }],
            [deckMapId, { mapX: deckMapId >> 8, mapY: deckMapId & 0xff, tileLocIdsByLevel: withMultiloc }],
        ]),
        worldEntityMapIds: new Set([deckMapId]),
    },
    reloadMultiLocSquare: (mapX: number, mapY: number) => reloaded.push(`${mapX},${mapY}`),
    scheduleWorldEntityLocRebuild: (entityIndex: number) => rebuiltDecks.push(entityIndex),
};

(GameRenderer.prototype as any).reloadMultiLocSquares.call(renderer);
assert.deepEqual(reloaded, ["50,50"], "the world square reloads as a map square");
assert.deepEqual(rebuiltDecks, [3008], "the deck rebuilds from its template");

console.log("multiloc-deck-reload: ok");
