import assert from "node:assert/strict";

import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";
import { Model2DRenderer } from "../ui/model/Model2DRenderer";

// A widget model larger than the 1024-pixel render cap that fills its widget (the spyglass's
// frame in Sailing's sea charting, interface 936) is cut to the widget around its centre, where
// it is drawn. Cutting it to its first 1024 pixels from the left drew only the frame's left half.
const cacheInfo = loadCacheList(loadCacheInfos()).latest;
const factory = getCacheLoaderFactory(
    cacheInfo,
    CacheSystem.fromFiles(cacheInfo, loadCache(cacheInfo).files),
);
const renderer: any = new Model2DRenderer(
    factory.getObjTypeLoader(),
    factory.getModelLoader(),
    factory.getTextureLoader(),
    factory.getSeqTypeLoader(),
    factory.getSeqFrameLoader(),
    undefined as any,
);

/** A canvas stand-in for node: the renderer only sizes it and puts the pixels in. */
function canvas(): any {
    return {
        width: 0,
        height: 0,
        getContext: () => ({
            createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData() {},
        }),
    };
}

const model = factory
    .getModelLoader()
    .getModel(16240)!
    .light(factory.getTextureLoader(), 64, 768, -50, -10, -50);
// Close up, so the model projects far wider than the cap.
const params = { xan2d: 0, yan2d: 0, zan2d: 0, zoom2d: 60, offsetX2d: 0, offsetY2d: 0 };

const widget = { width: 1500, height: 900 };
const cut = renderer.renderModelExtents(model, params, 16240, canvas(), widget);
assert.ok(cut.canvas.width > 1024, `the widget's width is kept (${cut.canvas.width})`);
assert.ok(cut.canvas.width <= widget.width + 12, "and no more than it");
// Drawn at the widget's centre minus offsetX: the cut is centred on it.
assert.ok(Math.abs(cut.offsetX - cut.canvas.width / 2) <= 4, `centred (offset ${cut.offsetX} of ${cut.canvas.width})`);

// A model within the cap is untouched by its widget.
const small = { ...params, zoom2d: 2000 };
const plain = renderer.renderModelExtents(model, small, 16240, canvas());
const inWidget = renderer.renderModelExtents(model, small, 16240, canvas(), widget);
assert.deepEqual([inWidget.canvas.width, inWidget.offsetX], [plain.canvas.width, plain.offsetX]);

console.log("widget-model-oversize: ok");
