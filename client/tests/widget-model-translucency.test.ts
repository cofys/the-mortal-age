import assert from "node:assert/strict";

import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";
import { Model2DRenderer } from "../ui/model/Model2DRenderer";
import { InputManager } from "../game/InputManager";

// OSRS draws widget models straight into the frame, so a translucent face shows what is behind
// the widget. The fairy ring dials (interface 398) rely on it: the selected letters show through
// the windows of the wooden bar in front of them (component 18, model 16236, face alpha 192).
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

function coverage(modelId: number, xan2d: number): { opaque: number; translucent: number } {
    const model = factory
        .getModelLoader()
        .getModel(modelId)!
        .light(factory.getTextureLoader(), 64, 768, -50, -10, -50);
    const size = 400;
    const pixels: Uint8ClampedArray = renderer.renderModelSoftwareToPixels(
        model,
        { id: modelId, xan2d, yan2d: 0, zan2d: 0, zoom2d: 1000, offsetX2d: 0, offsetY2d: 0 },
        size,
        size,
        false,
        undefined,
        true,
    );
    let opaque = 0;
    let translucent = 0;
    for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] === 255) opaque++;
        else if (pixels[i] > 0) translucent++;
    }
    return { opaque, translucent };
}

const bar = coverage(16236, 1962);
assert.ok(bar.opaque > 0, "the bar's wood is opaque");
assert.ok(bar.translucent > 1000, "its three windows stay translucent");

const dial = coverage(16240, 0);
assert.equal(dial.translucent, 0, "a model without translucent faces is unchanged");

console.log("widget-model-translucency: ok");

// The globe's cache model has translucent glass and explicit face priorities.
// Exercise the actual type-6 tree -> software renderer boundary: a depth buffer
// must not reject contents which the cache intentionally paints after the glass.
async function globePainterOrder() {
    const noop = () => {};
    const canvas: any = { width: 800, height: 600, style: {}, addEventListener: noop,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        __textureCache: { beginFrame: noop, endFrame: noop } };
    (globalThis as any).window ??= { addEventListener: noop, devicePixelRatio: 1 };
    (globalThis as any).document ??= { createElement: () => canvas, addEventListener: noop };
    const { renderWidgetTreeGL } = await import("../widgets/gl/widgetsGl/renderWidgetTree");
    const widget: any = { uid: (519 << 16) | 2, groupId: 519, fileId: 2,
        parentUid: -1, type: 6, isIf3: true, x: 0, y: 0, width: 400, height: 400,
        modelType: 1, modelId: 32604, rotationX: 150, rotationY: 1678, rotationZ: 0, modelZoom: 671 };
    const model = factory.getModelLoader().getModel(widget.modelId)!
        .light(factory.getTextureLoader(), 64, 768, -50, -10, -50);
    let actual: Uint8ClampedArray | undefined, expected: Uint8ClampedArray | undefined;
    const wm: any = new Proxy({ getWidgetFlags: () => 0, getWidgetFlagsVersion: () => 0,
        getStaticChildrenByParentUid: () => [], getDynamicChildrenByParent: () => [],
        interfaceParents: new Map(), groups: new Map(),
    }, { get: (obj, key) => (obj as any)[key] ?? noop });
    const glr: any = new Proxy({ canvas, width: 800, height: 600,
        gl: new Proxy({}, { get: () => noop }) }, { get: (obj, key) => (obj as any)[key] ?? noop });
    renderWidgetTreeGL(glr, widget, { widgetManager: wm, spriteIndex: {} as any,
        fontLoader: () => undefined, hostW: 800, hostH: 600, skipTooltip: true, visible: new Map(),
        game: { osrsClient: { inputManager: new InputManager() } } as any,
        renderModelCanvas: (id, params) => {
            const renderParams = { id, ...params };
            actual = renderer.renderModelSoftwareToPixels(model, renderParams, 400, 400,
                false, undefined, params.depthTest === true).slice();
            expected = renderer.renderModelSoftwareToPixels(model, renderParams, 400, 400,
                false, undefined, false).slice();
            return undefined;
        } });
    assert.ok(actual && expected, "the native model widget must reach the software renderer");
    let drawn = 0, differences = 0;
    for (let i = 0; i < expected.length; i++) {
        if (i % 4 === 3 && expected[i]) drawn++;
        if (actual[i] !== expected[i]) differences++;
    }
    assert.ok(drawn > 1000, "the actual cached globe produces a substantial raster");
    assert.equal(differences, 0, "native widgets preserve cache painter ordering without depth rejection");
}
globePainterOrder().catch(error => { console.error(error); process.exitCode = 1; });
