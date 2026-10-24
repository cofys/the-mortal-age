import assert from "node:assert/strict";


// The core plugin list pulls in shaders, styles and images, and PicoGL reads `self` on load.
(globalThis as any).self = globalThis;
for (const ext of [".glsl", ".wgsl", ".css", ".png", ".jpg", ".webp", ".wasm", ".cs2"]) {
    require.extensions[ext] = (module: any) => { module.exports = ""; };
}
const { ClientPluginManager } = require("../game/plugins/ClientPluginManager");
const { RuneLite } = require("../runelite/client/RuneLite");

// ?edit starts RuneLite without constructing a single plugin.
const clientPlugins = new ClientPluginManager();
const client = { stateMachine: { subscribe: () => () => {} }, clientPlugins } as any;
const runeLite = RuneLite.start(client, false);
assert.equal(runeLite.pluginManager.getPlugins().length, 0, "edit mode loads no plugins");

const { BeforeRender, ClientTick, PostClientTick } = require("../runelite/api/events");
const posted: object[] = [];
const post = runeLite.eventBus.post.bind(runeLite.eventBus);
runeLite.eventBus.post = (event: object) => { posted.push(event); post(event); };
const emit = [
    () => runeLite.postBeforeRender(), () => runeLite.postClientTick(), () => runeLite.postPostClientTick(),
];
for (let i = 0; i < 1000; i++) for (const event of emit) event();
assert.equal(posted.length, 0, "3,000 frame/tick events with no subscribers need no allocation or dispatch");
for (const [index, eventClass] of [BeforeRender, ClientTick, PostClientTick].entries()) {
    let received = 0;
    const unsubscribe = runeLite.eventBus.subscribe(eventClass, () => received++);
    emit[index]();
    emit[index]();
    assert.equal(received, 2, "subscribing after an empty pass starts delivery immediately");
    assert.notEqual(posted.at(-1), posted.at(-2), "subscribed events remain distinct instances");
    const count = posted.length;
    unsubscribe();
    emit[index]();
    assert.equal(posted.length, count, "removing the last subscriber stops empty dispatches again");
}

// With none loaded every hook is a no-op the renderer can call unguarded.
assert.equal(clientPlugins.gpuSettings(), undefined);
assert.equal(clientPlugins.hdEnabled(), false);
assert.equal(clientPlugins.smoothsNpcs(), false);
assert.equal(clientPlugins.sceneResolutionScale(), 1);
assert.equal(clientPlugins.resizableScale(2, 800, 600), 2);
assert.equal(clientPlugins.fixedStretch(800, 600, 1), null);
assert.equal(clientPlugins.tileMarkersConfig().enabled, false);
assert.equal(clientPlugins.interactHighlightConfig(), undefined);
assert.deepEqual(clientPlugins.groundItemOverlayEntries(3200, 3200, 0), []);
assert.deepEqual(clientPlugins.renderHud(client), []);

// Hooks cache their implementers; adding a plugin later must still be seen.
clientPlugins.add({ hdEnabled: () => true });
assert.equal(clientPlugins.hdEnabled(), true);

console.log("edit mode loads no plugins");
