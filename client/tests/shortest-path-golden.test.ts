import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { loadCollisionMap } from "../game/plugins/shortestpath/pathfinder/loadCollisionMap";
import { Pathfinder } from "../game/plugins/shortestpath/pathfinder/Pathfinder";
import { toPathfinderConfig } from "../game/plugins/shortestpath/pathfinder/PathSearch";
import type { PlayerSnapshot } from "../game/plugins/shortestpath/requirement/Requirements";
import { CONFIG_GROUP } from "../game/plugins/shortestpath/ShortestPathConfig";
import { ShortestPathPlugin } from "../game/plugins/shortestpath/ShortestPathPlugin";
import { SKILL_LEVELS_LENGTH } from "../game/plugins/shortestpath/transport/Transport";
import { packWorldPoint as p, unpackWorldPlane, unpackWorldX, unpackWorldY } from "../game/plugins/shortestpath/WorldPointUtil";

// The golden routes run on the collision map exported from this server's cache
// (server/scripts/export-collision-map.cjs) with the bundled transport TSVs, so a change to either
// that moves a well-known route shows up here.
const config = inject(ConfigManager);
for (const key of config.getConfigurationKeys(`${CONFIG_GROUP}.`)) config.unsetConfiguration(CONFIG_GROUP, key.slice(CONFIG_GROUP.length + 1));

const levels = new Array<number>(SKILL_LEVELS_LENGTH).fill(1);
levels[3] = 10;
const player: { -readonly [K in keyof PlayerSnapshot]: PlayerSnapshot[K] } = {
    levels,
    questState: () => "NOT_STARTED",
    varbit: () => 0,
    varp: () => 0,
    carried: new Map(),
    bank: null,
    currentTimeMinutes: 29_000_000,
};

const xyz = (packed: number) => `${unpackWorldX(packed)},${unpackWorldY(packed)},${unpackWorldPlane(packed)}`;

async function main(): Promise<void> {
    const map = await loadCollisionMap(readFileSync("public/shortestpath/collision-map.zip"));
    const plugin = new ShortestPathPlugin({} as any, {
        configManager: config,
        readText: async (path) => readFileSync(`public/${path}`, "utf8"),
        player: () => player,
        backend: { ready: Promise.resolve(), map: () => map, search: () => () => {}, dispose() {} },
    });
    await plugin.ensureLoaded();
    const route = (from: number, to: number) => {
        const request = plugin.buildRequest(from, [to]);
        return new Pathfinder(toPathfinderConfig(map, request), request.start, request.targets).run();
    };
    const used = (result: ReturnType<typeof route>) => result.path.filter((s) => s.transport >= 0)
        .map((s) => `${plugin.transports[s.transport].objectInfo ?? plugin.transports[s.transport].displayInfo} -> ${xyz(s.packed)}`);

    // Lumbridge to Varrock square on foot, as a new account with nothing in the inventory.
    const walk = route(p(3222, 3218, 0), p(3213, 3428, 0));
    assert.equal(walk.reached, true);
    assert.equal(walk.cost, 237, "237 tiles");
    assert.deepEqual(used(walk), [], "no transport");
    const steps = walk.path.map((s) => xyz(s.packed));
    for (const waypoint of ["3232,3229,0", "3240,3275,0", "3239,3295,0", "3206,3351,0", "3211,3411,0"]) {
        assert.ok(steps.includes(waypoint), `the road north through ${waypoint}`);
    }

    // The same trip with Varrock Teleport's runes and 25 Magic: cast it.
    player.carried = new Map([[563, 1], [556, 3], [554, 1]]);
    levels[6] = 25;
    const teleport = route(p(3222, 3218, 0), p(3213, 3428, 0));
    assert.deepEqual(used(teleport), ["Varrock Teleport -> 3213,3424,0"]);
    assert.equal(teleport.cost, 8);
    player.carried = new Map();
    levels[6] = 1;

    // Up Lumbridge Castle's staircase to the bank on the top floor.
    const bank = route(p(3222, 3218, 0), p(3208, 3220, 2));
    assert.equal(bank.reached, true);
    assert.deepEqual(used(bank), [
        "Climb-up Staircase 16671 -> 3205,3209,1",
        "Climb-up Staircase 16672 -> 3205,3209,2",
    ]);

    // Into the house east of the castle through its door (loc 1535 on the edge 3226|3227, 3214).
    const house = route(p(3230, 3214, 0), p(3224, 3214, 0));
    assert.equal(house.reached, true);
    const houseSteps = house.path.map((s) => xyz(s.packed));
    const doorway = houseSteps.indexOf("3227,3214,0");
    assert.ok(doorway >= 0 && houseSteps[doorway + 1] === "3226,3214,0", "walks through the door");

    console.log("shortest-path-golden: ok");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
