import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { PluginMessage } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { EventBus } from "@runelite/client/eventbus/EventBus";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { ClientState } from "../game/ClientState";
import { CollisionMap } from "../game/plugins/shortestpath/pathfinder/CollisionMap";
import { InProcessSearchBackend } from "../game/plugins/shortestpath/pathfinder/PathSearch";
import { FLAG_EAST, FLAG_NORTH, packRegionPosition, SplitFlagMap } from "../game/plugins/shortestpath/pathfinder/SplitFlagMap";
import type { PlayerSnapshot } from "../game/plugins/shortestpath/requirement/Requirements";
import { CONFIG_GROUP } from "../game/plugins/shortestpath/ShortestPathConfig";
import { ShortestPathPlugin } from "../game/plugins/shortestpath/ShortestPathPlugin";
import { SKILL_LEVELS_LENGTH } from "../game/plugins/shortestpath/transport/Transport";
import { packWorldPoint as p, unpackWorldX, unpackWorldY } from "../game/plugins/shortestpath/WorldPointUtil";
import type { SimpleMenuEntry } from "../ui/menu/MenuEngine";

const config = inject(ConfigManager);
for (const key of config.getConfigurationKeys(`${CONFIG_GROUP}.`)) config.unsetConfiguration(CONFIG_GROUP, key.slice(CONFIG_GROUP.length + 1));

// Lumbridge's region (3200-3263 x 3200-3263), open ground on plane 0.
const bits = new Uint8Array(64 * 64 * 4 / 8);
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const bit = (y * 64 + x) * 4;
    if (y < 63) bits[(bit + FLAG_NORTH) >> 3] |= 1 << ((bit + FLAG_NORTH) & 7);
    if (x < 63) bits[(bit + FLAG_EAST) >> 3] |= 1 << ((bit + FLAG_EAST) & 7);
}
const map = new CollisionMap(new SplitFlagMap(new Map([[packRegionPosition(50, 50), bits]])));

const tile = { x: 3222, y: 3218, plane: 0 };
const client: any = {
    gameState: 30,
    controlledPlayerServerId: 1,
    playerEcs: { getIndexForServerId: () => 0, getX: () => tile.x * 128 + 64, getY: () => tile.y * 128 + 64, getLevel: () => tile.plane },
};
const player: PlayerSnapshot = {
    levels: new Array(SKILL_LEVELS_LENGTH).fill(1), questState: () => "NOT_STARTED", varbit: () => 0, varp: () => 0,
    carried: new Map(), bank: null, currentTimeMinutes: 0,
};
const end = (plugin: ShortestPathPlugin) => {
    const last = plugin.activeSearch!.path.at(-1)!.packed;
    return `${unpackWorldX(last)},${unpackWorldY(last)}`;
};
const labels = (entries: SimpleMenuEntry[]) => entries.map((e) => `${e.option} ${e.target ?? ""}`.trim().replace(/<[^>]+>/g, ""));

async function main(): Promise<void> {
    ClientState.baseX = 3168;
    ClientState.baseY = 3168;
    ClientState.inInstance = false;
    ClientState.instanceTemplateChunks = null;
    const plugin = new ShortestPathPlugin(client, {
        configManager: config,
        backend: new InProcessSearchBackend(async () => map, true),
        readText: async (path) => (path.endsWith("item-variations.tsv") ? readFileSync(`public/${path}`, "utf8") : ""),
        player: () => player,
    });
    assert.equal(ShortestPathPlugin.descriptor.enabledByDefault, false, "off until enabled, like the plugin hub");
    await plugin.start();
    await plugin.ensureLoaded();
    const bus = new EventBus();
    bus.register(plugin);

    // --- PluginMessage("shortestpath", "path", {start, target}), exactly as Quest Helper sends it ---
    bus.post(new PluginMessage("shortestpath", "path", { start: { x: 3210, y: 3210, plane: 0 }, target: { x: 3240, y: 3230, plane: 0 } }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(plugin.activeSearch, "the path message starts a search");
    assert.equal(plugin.activeSearch!.start, p(3210, 3210, 0));
    assert.deepEqual(plugin.activeSearch!.targets, [p(3240, 3230, 0)]);
    assert.equal(plugin.isDone(), true);
    assert.equal(end(plugin), "3240,3230");

    // No start: from the player. A packed target and a collection both work.
    bus.post(new PluginMessage("shortestpath", "path", { target: [p(3250, 3250, 0), { point: { x: 3201, y: 3201, plane: 0 } }] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plugin.activeSearch!.start, p(3222, 3218, 0));
    assert.equal(plugin.activeSearch!.targets.length, 2);
    // With several targets the first tile within the unreachable distance (2) of one ends it.
    assert.equal(end(plugin), "3203,3201", "towards the cheaper of the two targets");

    // A malformed target leaves the path as it was; another namespace is ignored.
    const before = plugin.activeSearch;
    bus.post(new PluginMessage("shortestpath", "path", { target: "nowhere" }));
    bus.post(new PluginMessage("questhelper", "path", { target: { x: 3230, y: 3230, plane: 0 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plugin.activeSearch, before);

    // Setting overrides ride along and last until "clear".
    bus.post(new PluginMessage("shortestpath", "path", { config: { recalculateDistance: -1 } }));
    assert.equal(plugin.setting("recalculateDistance"), -1);
    bus.post(new PluginMessage("shortestpath", "clear", {}));
    assert.equal(plugin.activeSearch, null, "clear removes the path");
    assert.equal(plugin.setting("recalculateDistance"), 10, "and the overrides");

    // A network message (channel + data, no name) still reaches other plugins unchanged.
    const network = new PluginMessage("voice", { type: "peers" });
    assert.equal(network.name, "");
    assert.equal(network.namespace, "voice");

    // --- Shift + right-click "Walk here": Set Target under it, nothing with Ctrl too ---------------
    const world = () => plugin.transformMenuEntries(
        [{ option: "Walk here", target: "", mapX: 62, mapY: 62 }, { option: "Cancel", target: "" }], { surface: "world", menu: true });
    assert.deepEqual(labels(world()), ["Walk here", "Cancel"], "nothing without Shift");
    ClientState.setKeybindState(81, true);
    let menu = world();
    assert.deepEqual(labels(menu), ["Walk here", "Set Target", "Cancel"], "Walk here stays the left click");
    ClientState.setKeybindState(82, true);
    assert.deepEqual(labels(world()), ["Walk here", "Cancel"], "Ctrl + Shift is the dev teleport");
    ClientState.setKeybindState(82, false);
    menu[1].onClick!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(plugin.activeSearch!.targets, [p(3230, 3230, 0)], "scene (62, 62) is (3230, 3230)");

    // With a path: a second target, Set Start, and Clear Path on a tile of the path.
    menu = world();
    assert.deepEqual(labels(menu), ["Walk here", "Set Target", "Set Target 2", "Set Start", "Clear Path", "Cancel"]);
    menu[4].onClick!();
    assert.equal(plugin.activeSearch, null);
    ClientState.setKeybindState(81, false);

    // --- The world map: Set Target anywhere; Set Start and Clear Path once a path is shown ---------
    assert.deepEqual(labels(plugin.worldMapMenuEntries({ x: 3250, y: 3205, plane: 0 })), ["Set Target"]);
    plugin.worldMapMenuEntries({ x: 3250, y: 3205, plane: 0 })[0].onClick!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(end(plugin), "3250,3205");
    const mapMenu = plugin.worldMapMenuEntries({ x: 3210, y: 3240, plane: 0 });
    assert.deepEqual(labels(mapMenu), ["Set Target", "Set Target 2", "Set Start", "Clear Path"]);
    mapMenu[2].onClick!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plugin.activeSearch!.start, p(3210, 3240, 0), "Set Start moves the start");
    assert.equal(end(plugin), "3250,3205", "to the same target");

    // A set start stays until the path is cleared.
    plugin.setTarget(p(3251, 3205, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plugin.activeSearch!.start, p(3210, 3240, 0));
    plugin.setTarget(-1);

    // --- Off the path it recalculates from the player; near the target it finishes ---------------
    plugin.setTarget(p(3250, 3205, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plugin.activeSearch!.start, p(3222, 3218, 0));
    tile.x = 3205; tile.y = 3260;
    plugin.onGameTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plugin.activeSearch!.start, p(3205, 3260, 0), "recalculated from where the player went");
    tile.x = 3247; tile.y = 3205;
    plugin.onGameTick();
    assert.equal(plugin.activeSearch, null, "finishes within 5 tiles of the target");

    // cancelInstead: straying clears the path instead.
    config.setConfiguration(CONFIG_GROUP, "cancelInstead", "true");
    tile.x = 3222; tile.y = 3218;
    plugin.setTarget(p(3250, 3205, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    plugin.onGameTick();
    tile.x = 3205; tile.y = 3260;
    plugin.onGameTick();
    assert.equal(plugin.activeSearch, null);
    config.unsetConfiguration(CONFIG_GROUP, "cancelInstead");

    await plugin.stop();
    assert.deepEqual(plugin.worldMapMenuEntries({ x: 3250, y: 3205, plane: 0 }), [], "no entries once stopped");
    await lazyBackendFollowsLifecycle();
    console.log("shortest-path-plugin: ok");
}

/** Enabling then disabling before the lazy worker import settles must not leave a live worker behind. */
async function lazyBackendFollowsLifecycle(): Promise<void> {
    const workers: { terminated: boolean }[] = [];
    const g = globalThis as any;
    const saved = { Worker: g.Worker, location: g.location };
    g.location = { href: "http://localhost/" };
    g.Worker = class {
        terminated = false;
        onmessage: unknown = null;
        constructor() { workers.push(this); }
        postMessage(): void {}
        terminate(): void { this.terminated = true; }
    };
    const live = () => workers.filter((w) => !w.terminated).length;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
    try {
        const plugin = new ShortestPathPlugin(client, { configManager: config, readText: async () => "", player: () => player });
        await plugin.start();
        await plugin.stop();
        await settle();
        assert.equal(plugin.isStarted(), false);
        assert.equal(live(), 0, "start then stop leaves no live worker");
        assert.equal((plugin as any).backend, undefined, "start then stop leaves no backend");

        await plugin.start();
        await plugin.stop();
        await plugin.start();
        await settle();
        assert.equal(live(), 1, "start, stop, start leaves exactly one live worker");
        assert.ok((plugin as any).backend, "the restarted plugin has its backend");
        await plugin.stop();
        assert.equal(live(), 0, "stopping terminates it");
    } finally {
        g.Worker = saved.Worker;
        g.location = saved.location;
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
