import { strict as assert } from "node:assert";

import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { LocModelLoader } from "../rs/config/loctype/LocModelLoader";
import { Model } from "../rs/model/Model";
import { getIdFromTag } from "../rs/scene/entity/EntityTag";
import { LocLoadType, SceneBuilder } from "../rs/scene/SceneBuilder";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";

// A multi-tile loc sits on every tile it covers, but its normals merge once, from its start
// tile. Merged again from the others, its offsets were wrong and the repeating shingle rows of
// Ardeaglais's roof (Wyrmscraig) matched their neighbours by chance: a third of the roof's
// faces were hidden as occluded seams, leaving flat brown holes.
const info = loadCacheList(loadCacheInfos()).latest;
const cache = loadCache(info);
const factory = getCacheLoaderFactory(info, CacheSystem.fromFiles(info, cache.files));
const locTypeLoader = factory.getLocTypeLoader();
const locModelLoader = new LocModelLoader(locTypeLoader, factory.getModelLoader(), factory.getTextureLoader(),
    factory.getSeqTypeLoader(), factory.getSeqFrameLoader(), factory.getSkeletalSeqLoader());
const builder = new SceneBuilder(info, factory.getMapFileLoader(), factory.getUnderlayTypeLoader(),
    factory.getOverlayTypeLoader(), locTypeLoader, locModelLoader, cache.xteas);

const scene = builder.buildScene(2496 - 6, 2176 - 6, 76, 76, true, LocLoadType.MODELS);
const roofs = new Set<Model>();
for (const column of scene.tiles[2]) {
    for (const tile of column) {
        for (const loc of tile?.locs ?? []) {
            const id = getIdFromTag(loc.tag);
            if (id >= 62279 && id <= 62342 && loc.entity instanceof Model) roofs.add(loc.entity);
        }
    }
}
assert.equal(roofs.size, 64, "the cathedral roof has 64 locs");

let faces = 0;
let hidden = 0;
for (const model of roofs) {
    faces += model.faceCount;
    for (let i = 0; i < model.faceCount; i++) if (model.faceColors3[i] === -2) hidden++;
}
assert.ok(hidden < faces * 0.01, `${hidden} of ${faces} roof faces hidden as merged seams`);
console.log(`Multi-tile loc normals: ${hidden} of ${faces} Ardeaglais roof faces hidden`);
