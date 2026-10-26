import assert from "node:assert/strict";

import { SceneBuffer } from "../render/buffer/SceneBuffer";
import { addLocEntities } from "../render/loader/SdMapDataLoader";
import { getSceneLocs } from "../render/loc/SceneLocs";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { LocModelLoader } from "../rs/config/loctype/LocModelLoader";
import { LocModelType } from "../rs/config/loctype/LocModelType";
import { VarManager } from "../rs/config/vartype/VarManager";
import { LocLoadType, SceneBuilder } from "../rs/scene/SceneBuilder";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

// PicoGL expects a browser global when SceneRaycaster imports WebGLMapSquare.
(globalThis as any).self = globalThis;
const { SceneRaycaster } = require("../game/scene/SceneRaycaster");

// The house portal's swirl (seq 3174) is shrunk to one point in its first frame. Its Lock option
// made the client draw it as a door, which stands still, while its clickbox came from that
// first frame: a hole where the purple swirl was drawn.
const info = loadCacheList(loadCacheInfos()).latest;
const cache = loadCache(info);
const factory: any = getCacheLoaderFactory(info, CacheSystem.fromFiles(info, cache.files));
const locTypeLoader = factory.getLocTypeLoader();
const raycaster = new SceneRaycaster({}, {
    locTypeLoader,
    modelLoader: factory.getModelLoader(),
    textureLoader: factory.getTextureLoader(),
    seqTypeLoader: factory.getSeqTypeLoader(),
    seqFrameLoader: factory.getSeqFrameLoader(),
    skeletalSeqLoader: factory.getSkeletalSeqLoader?.(),
});
const PORTAL = 4525;
const portal = locTypeLoader.load(PORTAL);
const seqType = factory.getSeqTypeLoader().load(portal.seqId);

// The construction template's portal (1803, 5699) is drawn swirling, with the animated locs.
const locModelLoader = new LocModelLoader(locTypeLoader, factory.getModelLoader(), factory.getTextureLoader(),
    factory.getSeqTypeLoader(), factory.getSeqFrameLoader(), factory.getSkeletalSeqLoader());
const builder = new SceneBuilder(info, factory.getMapFileLoader(), factory.getUnderlayTypeLoader(),
    factory.getOverlayTypeLoader(), locTypeLoader, locModelLoader, cache.xteas);
const border = 6;
const mapX = 28, mapY = 89;
const scene = builder.buildScene(mapX * 64 - border, mapY * 64 - border, 76, 76, true, LocLoadType.NO_MODELS);
const sceneLocs = getSceneLocs(locTypeLoader, scene, border, 3);
const doorModels: any[] = [];
const groups = addLocEntities(builder.centerLocHeightWithSize, locModelLoader,
    new VarManager(factory.getVarBitTypeLoader()), scene, [], doorModels,
    new SceneBuffer(factory.getTextureLoader(), new Map(), 1000), sceneLocs.locEntities);
const animated = new SceneBuffer(factory.getTextureLoader(), new Map(), 1000)
    .addLocAnimatedGroups(groups).filter((loc) => loc.locId === PORTAL);
assert.equal(doorModels.filter((model) => model.interactId === PORTAL).length, 0, "the portal is not a still door");
// Raycaster fine position of the 2x2 portal: its centre, from the square's render base.
const sceneX = ((1803 - mapX * 64) << 7) + 128;
const sceneZ = ((5699 - mapY * 64) << 7) + 128;
const drawn = animated.find((loc) => loc.x === sceneX && loc.y === sceneZ);
assert.ok(drawn, "the portal animates, where the raycaster looks it up");

// The raycaster finds that animation and clicks on the frame it is on.
const playing = { id: PORTAL, x: drawn.x, y: drawn.y, level: drawn.level, seqType, frame: 5 };
const map = { locsAnimated: [{ ...playing, id: PORTAL + 1 }, playing] };
assert.equal(raycaster.animatedLocAt(map, PORTAL, drawn.level, sceneX, sceneZ), playing);
assert.equal(raycaster.animatedLocAt(map, PORTAL, drawn.level, sceneX, sceneZ + 128), undefined);

// Straight through the middle of the arch, a little below the point the first frame shrinks to.
const throughCentre = (frame: number) =>
    raycaster.intersectLocModel(
        { origin: [1, -1.25, -1], direction: [0, 0, 1] },
        100,
        portal,
        LocModelType.NORMAL,
        0,
        128,
        128,
        0,
        { seqType, frame },
    );
assert.equal(throughCentre(0), undefined, "the first frame's swirl is a single point");
assert.ok(throughCentre(5) !== undefined, "the centre of the portal is clickable while the swirl shows");
console.log("House portal pick regression passed");
