import { strict as assert } from "node:assert";
import * as NpcID from "@runelite/api/gameval/NpcID";
import { isDying } from "../game/plugins/npcindicators/npcDeath";
import {
    convexHull,
    fromCSV,
    recolorMenuTarget,
    resolveHighlightFlags,
    tagColorChoices,
    toCSV,
    wildcardMatches,
} from "../game/plugins/npcindicators/npcMatching";
import {
    MAX_RESPAWN_TIME_TICKS,
    RespawnTracker,
    formatRespawn,
    respawnSecondsLeft,
    worldLocationBehind,
} from "../game/plugins/npcindicators/respawn";

// --- Names: CSV and RuneLite's WildcardMatcher ---------------------------------------------
assert.deepEqual(fromCSV(" Goblin, ,Man ,"), ["Goblin", "Man"]);
assert.equal(toCSV(["Goblin", "Man"]), "Goblin,Man");
assert.ok(wildcardMatches("goblin", "Goblin"), "case-insensitive");
assert.ok(!wildcardMatches("gob", "Goblin"), "whole name only");
assert.ok(wildcardMatches("gob*", "Goblin"));
assert.ok(wildcardMatches("*rat", "Giant rat"));
assert.ok(wildcardMatches("g*n", "Goblin"));
assert.ok(wildcardMatches("Man (level-2)", "man (level-2)"), "regex characters are literal");
assert.ok(!wildcardMatches("M.n", "Man"));

// --- Menu recolouring: NONE / BOTH / NAME / LEVEL --------------------------------------------
const target = "<col=ffff00>Goblin<col=00ff00>  (level-2)";
assert.equal(recolorMenuTarget(target, "NONE", 0xff0000), target);
assert.equal(recolorMenuTarget(target, "BOTH", 0xff0000), "<col=ff0000>Goblin  (level-2)");
assert.equal(recolorMenuTarget(target, "NAME", 0xff0000), "<col=ff0000>Goblin<col=00ff00>  (level-2)");
assert.equal(recolorMenuTarget(target, "LEVEL", 0xff0000), "<col=ffff00>Goblin<col=ff0000>  (level-2)");
assert.equal(recolorMenuTarget("<col=ffff00>Banker", "NAME", 0xff0000), "<col=ffff00>Banker", "no level: unchanged");

// --- Tag style replaces the global toggles with one style ------------------------------------
const global = { hull: true, tile: true, trueTile: false, swTile: false, swTrueTile: false, outline: false };
assert.deepEqual(resolveHighlightFlags(global, undefined), global);
assert.deepEqual(resolveHighlightFlags(global, "outline"),
    { hull: false, tile: false, trueTile: false, swTile: false, swTrueTile: false, outline: true });
assert.deepEqual(resolveHighlightFlags(global, "bogus"), global);

// --- Tag colours: those in use (up to five), topped up with RuneLite's ----------------------
assert.deepEqual(tagColorChoices([]), [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff]);
assert.deepEqual(tagColorChoices([0x123456, 0x123456, 0xff0000]), [0x123456, 0xff0000, 0x00ff00, 0x0000ff, 0xffff00]);

// --- Convex hull -------------------------------------------------------------------------------
const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 0]]);
assert.equal(hull.length, 4, "interior and collinear points dropped");

// --- NpcUtil.isDying ---------------------------------------------------------------------------
const fighter = { id: NpcID.GOBLIN, actions: ["Attack", null, null, null, "Examine"], deathHiderExclude: 0, dead: true, healthRatio: 0 };
assert.ok(isDying(fighter), "attackable and dead");
assert.ok(!isDying({ ...fighter, dead: false }));
assert.ok(!isDying({ ...fighter, actions: ["Talk-to"] }), "no Attack option: never dying");
assert.ok(!isDying({ ...fighter, deathHiderExclude: 1 }));
assert.ok(!isDying({ ...fighter, actions: undefined }));
assert.ok(!isDying({ ...fighter, id: NpcID.SLAYER_GARGOYLE_1 }), "gargoyles reach 0 hp without dying");
assert.ok(isDying({ ...fighter, id: NpcID.DRAKE_DEATH, dead: false, actions: [] }), "dead forms are always dying");
assert.ok(isDying({ ...fighter, id: NpcID.AMOXLIATL, dead: false }), "Amoxliatl uses its health ratio");

// --- Respawn learning ----------------------------------------------------------------------------
for (const [orientation, dx, dy] of [[0, 0, 1], [256, 1, 1], [512, 1, 0], [768, 1, -1], [1024, 0, -1], [1280, -1, -1], [1536, -1, 0], [1792, -1, 1]]) {
    assert.deepEqual(worldLocationBehind({ x: 10, y: 10, plane: 0 }, orientation), { x: 10 + dx, y: 10 + dy, plane: 0 },
        `behind for orientation ${orientation}`);
}
const player = { x: 3200, y: 3200, plane: 0 };
const spawnAt = { x: 3205, y: 3205, plane: 0 };
const tracker = new RespawnTracker();
tracker.memorize(7, "Chicken", 1);
tracker.tick(1, player); // first tick only clears the start-up skip
tracker.onSpawned(7, spawnAt, 0);
tracker.tick(2, player);
assert.equal(tracker.memorized.get(7)!.possibleRespawnLocations.length, 2, "spawn tile and the one behind");
tracker.onDespawned(7, { x: 3206, y: 3206, plane: 0 });
tracker.tick(10, player);
assert.equal(tracker.memorized.get(7)!.diedOnTick, 11);
assert.ok(tracker.deadNpcsToDisplay.has(7), "a known spawn tile: count down");
tracker.onSpawned(7, spawnAt, 0);
tracker.tick(35, player);
assert.equal(tracker.memorized.get(7)!.respawnTime, 25, "learnt: 35 + 1 - 11");
assert.deepEqual(tracker.memorized.get(7)!.possibleRespawnLocations[0], spawnAt, "the countdown tile is where it spawned");
tracker.onDespawned(7, spawnAt);
tracker.tick(40, player);
tracker.onSpawned(7, spawnAt, 0);
tracker.tick(80, player);
assert.equal(tracker.memorized.get(7)!.respawnTime, 25, "a slower respawn doesn't replace the shortest");
// Far away, teleports and implausible times are ignored.
tracker.onDespawned(7, { x: 3300, y: 3300, plane: 0 });
tracker.tick(90, player);
assert.equal(tracker.memorized.get(7)!.diedOnTick, -1, "out of view range");
tracker.onTeleport(spawnAt);
tracker.onDespawned(7, spawnAt);
tracker.tick(91, player);
assert.equal(tracker.memorized.get(7)!.diedOnTick, -1, "a teleport puff is not a death");
const slow = new RespawnTracker();
slow.memorize(1, "Boss", 3);
slow.tick(1, player);
slow.onDespawned(1, spawnAt);
slow.tick(2, player);
slow.onSpawned(1, spawnAt, 0);
slow.tick(2 + MAX_RESPAWN_TIME_TICKS + 5, player);
assert.equal(slow.memorized.get(1)!.respawnTime, -1, "over 500 ticks is not believed");

// Countdown: 0.6 s a tick, smooth between ticks; expired entries are dropped.
const npc = tracker.memorized.get(7)!;
npc.diedOnTick = 100;
npc.respawnTime = 10;
assert.equal(formatRespawn(respawnSecondsLeft(npc, 105, 0)), "3.0");
assert.equal(formatRespawn(respawnSecondsLeft(npc, 105, 300)), "2.7");
assert.equal(formatRespawn(respawnSecondsLeft(npc, 120, 0)), "0.0");
tracker.deadNpcsToDisplay.set(7, npc);
tracker.tick(109, player);
assert.ok(!tracker.deadNpcsToDisplay.has(7), "removed the tick before it respawns");
tracker.resetForHop();
assert.equal(npc.diedOnTick, -1);

console.log("npc indicators rules tests passed");
