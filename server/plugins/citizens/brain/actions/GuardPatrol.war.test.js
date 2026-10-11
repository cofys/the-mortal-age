"use strict";

/**
 * GuardPatrol.war.test.js — wartime aggression contracts (Jon, 2026-10-11).
 *
 * The watch seizes enemy subjects on sight in wartime — the war alone is
 * reason enough, no personal hatred needed — while peacetime, neutral
 * kingdoms, fellows and strayed beats stay hands-off. Hatred behaviour is
 * unchanged: enemy tier seizes in any season, and a hated wartime enemy
 * is attacked, not merely harassed.
 *
 * Modules are stubbed in the require cache (same pattern as
 * KingdomChoicePhase1.test.js); the war state lives in controllable
 * stubs for CitizenEvents (any-war gate) and WartimePvp (pairwise war +
 * ground), and Influence is stubbed to a per-name points map.
 *
 * Run: node server/plugins/citizens/brain/actions/GuardPatrol.war.test.js
 */

const assert = require("assert");
const path = require("path");

require.extensions[".ts"] = require.extensions[".js"];

// --- controllable world state (reset per test) ---

const warPairs = new Set(); // "a|b" sorted pair keys with an active war
const anyWarKingdoms = new Set(); // kingdoms at war with anyone
let guardGround = "asgarnia"; // WartimePvp.territoryAt(guard); null = unknown
const influenceByName = new Map(); // username -> effective influence vs the guard's kingdom

function pairKey(a, b) {
  return [a, b].sort().join("|");
}

function setWar(a, b) {
  warPairs.add(pairKey(a, b));
  anyWarKingdoms.add(a);
  anyWarKingdoms.add(b);
}

function resetWorld() {
  warPairs.clear();
  anyWarKingdoms.clear();
  guardGround = "asgarnia";
  influenceByName.clear();
  saidLines.length = 0;
  logs.length = 0;
}

// --- stubs (installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__actionState) player.__actionState = init();
      return player.__actionState;
    },
  },
};

const navPath = path.resolve(__dirname, "../../../bots/behaviours/navigation/BotNavigation.js");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: () => {},
    clearMovementRequest: () => {},
  },
};

const eventsPath = path.resolve(__dirname, "../../CitizenEvents.js");
require.cache[eventsPath] = {
  id: eventsPath, filename: eventsPath, loaded: true,
  exports: {
    isKingdomAtWar: (id) => anyWarKingdoms.has(id),
    officesHeldBy: () => [],
  },
};

const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: (player) => player.__kingdom,
    patrolCircuit: () => [{ x: 3200, y: 3200, z: 0 }],
  },
};

const constPath = path.resolve(__dirname, "../../constants.js");
require.cache[constPath] = {
  id: constPath, filename: constPath, loaded: true,
  exports: {
    ATTR_KINGDOM_ID: "kingdom:id",
    ATTR_CITIZEN_PERSONALITY: "citizens:personality",
    ATTR_WARE_ITEM: "citizens:wareItem",
    ATTR_WARE_PRICE: "citizens:warePrice",
  },
};

const humanizerPath = path.resolve(__dirname, "../../lib/humanizer.js");
require.cache[humanizerPath] = {
  id: humanizerPath, filename: humanizerPath, loaded: true,
  exports: {
    agentRng: () => () => 0.5,
    logNormalJitter: () => 1000,
    noisyTile: (x, y) => ({ x, y, z: 0 }),
    chance: () => true,
    humanizerProfile: () => ({ chatRate: 1, tempoSigma: 0.1, challengeRate: 1, misclickRate: 0, pauseRate: 0 }),
  },
};

const memoryPath = path.resolve(__dirname, "../../lib/CitizenMemory.js");
require.cache[memoryPath] = {
  id: memoryPath, filename: memoryPath, loaded: true,
  exports: {
    getMemory: () => ({ notoriety: () => 0 }),
  },
};

const voicePath = path.resolve(__dirname, "../../lib/citizenVoice.js");
require.cache[voicePath] = {
  id: voicePath, filename: voicePath, loaded: true,
  exports: {
    voiceFor: () => "plain",
    voiceLine: (voice, pool) => pool.plain[0],
  },
};

const saidLines = [];
const sayPublicPath = path.resolve(__dirname, "../../chat/CitizenSayPublic.js");
require.cache[sayPublicPath] = {
  id: sayPublicPath, filename: sayPublicPath, loaded: true,
  exports: {
    sayPublic: (player, line) => {
      saidLines.push({ player: player.getUsername(), line });
    },
  },
};

const influencePath = path.resolve(__dirname, "../../../kingdoms/Influence.Kingdoms.js");
require.cache[influencePath] = {
  id: influencePath, filename: influencePath, loaded: true,
  exports: {
    effectiveInfluence: (player) => influenceByName.get(player.getUsername()) ?? 0,
    hatredTier: (v) => (v <= -100 ? "enemy" : v <= -25 ? "hated" : v < 0 ? "disliked" : null),
    addInfluence: () => 0,
  },
};

const wartimePath = path.resolve(__dirname, "../../../kingdoms/WartimePvp.Kingdoms.js");
require.cache[wartimePath] = {
  id: wartimePath, filename: wartimePath, loaded: true,
  exports: {
    atWar: (a, b) => warPairs.has(pairKey(a, b)),
    territoryAt: () => guardGround,
    isLawfulWarFight: () => false,
  },
};

const storePath = path.resolve(__dirname, "../../../kingdoms/KingdomStore.js");
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true,
  exports: {
    getKingdom: (id) => ({ capital: id }),
  },
};

// --- the module under test ---

const { createGuardPatrolAction } = require("./GuardPatrol");

const logs = [];
const world = { log: (event, data) => logs.push({ event, ...data }) };
const action = createGuardPatrolAction({}, world);

// --- mocks ---

function mockLoc(x, y) {
  return { getX: () => x, getY: () => y, getZ: () => 0 };
}

function stubGuard(kingdom) {
  const guard = {
    __kingdom: kingdom,
    __actionState: null,
    __locals: [],
    attacks: [],
    getUsername: () => "Watchman",
    isPlayerBot: () => true,
    getAttribute: (key) => {
      if (key === "kingdom:id") return kingdom;
      if (key === "citizens:personality") return {};
      return undefined;
    },
    getLocation: () => mockLoc(3200, 3200),
    getLocalPlayers: () => guard.__locals,
    getForceMovement: () => null,
    getMovementQueue: () => ({ size: () => 0 }),
    getCombat: () => ({
      attack: (t) => guard.attacks.push(t.getUsername()),
      getTarget: () => null,
    }),
  };
  return guard;
}

function stubTarget(username, kingdom, { bot = false, x = 3205, y = 3200 } = {}) {
  const target = {
    getUsername: () => username,
    getAttribute: (key) => (key === "kingdom:id" ? kingdom : undefined),
    getLocation: () => mockLoc(x, y),
    getCombat: () => ({ getTarget: () => null }),
  };
  if (bot) target.isPlayerBot = () => true;
  return target;
}

// --- harness ---

let passed = 0;
function test(name, fn) {
  resetWorld();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

const WAR_SEIZE_MARKERS = ["Enemy colours", "We're at war", "enemy subject", "at war with ours"];
function saidWarSeize(name) {
  return saidLines.some(
    ({ line }) =>
      line.includes(name) && WAR_SEIZE_MARKERS.some((m) => line.includes(m))
  );
}
function logged(event) {
  return logs.some((l) => l.event === event);
}

// --- tests ---

test("guard seizes an enemy-kingdom player on sight in wartime", () => {
  setWar("asgarnia", "misthalin");
  const guard = stubGuard("asgarnia");
  guard.__locals = [stubTarget("EnemyJoe", "misthalin")];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, ["EnemyJoe"]);
  assert.ok(logged("citizen_guard_war_attack"), `expected war attack log, got ${JSON.stringify(logs)}`);
  assert.ok(saidWarSeize("EnemyJoe"), `expected a seize line, got ${JSON.stringify(saidLines)}`);
});

test("guard seizes an enemy citizen bot too — the watch does not check papers", () => {
  setWar("asgarnia", "misthalin");
  const guard = stubGuard("asgarnia");
  guard.__locals = [stubTarget("EnemyCitizen", "misthalin", { bot: true })];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, ["EnemyCitizen"]);
  assert.ok(logged("citizen_guard_war_attack"));
});

test("peacetime: no war seizure — a challenge at most", () => {
  const guard = stubGuard("asgarnia");
  guard.__locals = [stubTarget("Traveller", "misthalin")];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, []);
  assert.ok(!logged("citizen_guard_war_attack"));
});

test("a neutral kingdom's subject is not seized in wartime", () => {
  setWar("asgarnia", "misthalin");
  const guard = stubGuard("asgarnia");
  guard.__locals = [stubTarget("NeutralNia", "kandarin")];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, []);
  assert.ok(!logged("citizen_guard_war_attack"));
});

test("a fellow subject is not seized in wartime", () => {
  setWar("asgarnia", "misthalin");
  const guard = stubGuard("asgarnia");
  guard.__locals = [stubTarget("FellowFred", "asgarnia")];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, []);
  assert.ok(!logged("citizen_guard_war_attack"));
});

test("a strayed watch does not start fights abroad", () => {
  setWar("asgarnia", "misthalin");
  guardGround = "kandarin"; // the beat somehow stands on foreign ground
  const guard = stubGuard("asgarnia");
  guard.__locals = [stubTarget("EnemyJoe", "misthalin")];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, []);
  assert.ok(!logged("citizen_guard_war_attack"));
});

test("a hated wartime enemy is attacked, not merely harassed", () => {
  setWar("asgarnia", "misthalin");
  influenceByName.set("HatedHarry", -50); // tier "hated" with the guard's kingdom
  const guard = stubGuard("asgarnia");
  guard.__locals = [stubTarget("HatedHarry", "misthalin")];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, ["HatedHarry"]);
  assert.ok(logged("citizen_guard_war_attack"));
  assert.ok(!logged("citizen_guard_hatred_harass"), "war seizure must outrank the harass");
});

test("enemy-tier hatred still seizes in peacetime (unchanged)", () => {
  influenceByName.set("TraitorTom", -120); // tier "enemy"
  const guard = stubGuard("asgarnia");
  guard.__locals = [stubTarget("TraitorTom", "misthalin")];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, ["TraitorTom"]);
  assert.ok(logged("citizen_guard_hatred_attack"));
  assert.ok(!logged("citizen_guard_war_attack"));
});

test("war's end stands the watch down", () => {
  setWar("asgarnia", "misthalin");
  const guard = stubGuard("asgarnia");
  const enemy = stubTarget("EnemyJoe", "misthalin");
  guard.__locals = [enemy];
  action.update({ player: guard, nowMs: 1000000 });
  assert.deepEqual(guard.attacks, ["EnemyJoe"]);
  warPairs.clear();
  anyWarKingdoms.clear();
  action.update({ player: guard, nowMs: 1000000 + 61000 }); // past every cooldown
  assert.deepEqual(guard.attacks, ["EnemyJoe"], "no second seizure after the peace");
  assert.equal(logs.filter((l) => l.event === "citizen_guard_war_attack").length, 1);
});

console.log(`\n${passed} tests passed.`);
