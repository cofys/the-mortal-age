"use strict";

/**
 * KingdomChoicePhase1.test.js — Phase 1 "Home ground welcome" contracts.
 *
 * Verifies that guards and merchants recognize a real player's kingdom
 * affiliation: warm greetings for fellows in home territory, cold-but-neutral
 * lines for foreigners, 5-minute per-player cooldown, no spam.
 *
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenTradeGuild.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/KingdomChoicePhase1.test.js
 */

const assert = require("assert");
const path = require("path");

// The engine sources are TypeScript: extensionless requires like
// ../../../../src/.../Bank resolve to Bank.ts under ts-node. Plain node
// needs the .ts extension registered before require.resolve can find them;
// the stubs below are pre-populated in require.cache so the .ts bodies are
// never actually loaded.
require.extensions[".ts"] = require.extensions[".js"];

// --- stubs (must be installed before requiring the actions) ---

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
    isKingdomAtWar: () => false,
    officesHeldBy: () => [],
  },
};

const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "misthalin",
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
    chance: () => true, // deterministic: always pass the speech roll
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
    voiceLine: (voice, pool) => pool.plain[0], // deterministic: first plain line
  },
};

// Capture sayPublic calls: [{ player, line }]
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

const hawkerPath = path.resolve(__dirname, "../../lib/CitizenHawker.js");
require.cache[hawkerPath] = {
  id: hawkerPath, filename: hawkerPath, loaded: true,
  exports: {
    hawkerLine: () => null, // shelves silent: skip advertising in tests
  },
};

const storePath = path.resolve(__dirname, "../../../kingdoms/KingdomStore.js");
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true,
  exports: {
    getKingdom: (id) => ({ capital: id === "misthalin" ? "Varrock" : id }),
  },
};

// Engine TS modules required by Merchant.js at load time (unused by the
// recognition path; stubbed so the test stays engine-free).
const bankPath = path.resolve(__dirname, "../../../../src/main/typescript/elvarg/game/model/container/impl/Bank.ts");
require.cache[bankPath] = {
  id: bankPath, filename: bankPath, loaded: true,
  exports: { Bank: { TOTAL_BANK_TABS: 9, withdraw: () => {} } },
};

const itemPath = path.resolve(__dirname, "../../../../src/main/typescript/elvarg/game/model/Item.ts");
require.cache[itemPath] = {
  id: itemPath, filename: itemPath, loaded: true,
  exports: { Item: class {} },
};

const idEnumsPath = path.resolve(__dirname, "../../../../src/main/typescript/elvarg/util/IdEnums.ts");
require.cache[idEnumsPath] = {
  id: idEnumsPath, filename: idEnumsPath, loaded: true,
  exports: { ItemIds: { COINS: 995, BRONZE_SWORD: 1277, BREAD: 2309 } },
};

// --- real modules under test ---

const { createGuardPatrolAction } = require("./GuardPatrol");
const { createMerchantAction } = require("./Merchant");

// --- mocks ---

function mockLoc(x, y) {
  return { getX: () => x, getY: () => y, getZ: () => 0 };
}

function stubCitizen(username, kingdomId) {
  return {
    __actionState: null,
    getUsername: () => username,
    isPlayerBot: () => true,
    getAttribute: (key) => {
      if (key === "kingdom:id") return kingdomId;
      if (key === "citizens:personality") return {};
      return undefined;
    },
    getLocation: () => mockLoc(3200, 3200),
    getLocalPlayers: () => [],
    getForceMovement: () => null,
    getMovementQueue: () => ({ size: () => 0 }),
    getInventory: () => ({
      getAmount: () => 100,
      add: () => {},
      deleteNumber: () => {},
    }),
  };
}

function stubRealPlayer(username, kingdomId, x, y) {
  return {
    getUsername: () => username,
    // no isPlayerBot: treated as a real player
    getAttribute: (key) => {
      if (key === "kingdom:id") return kingdomId;
      return undefined;
    },
    getLocation: () => mockLoc(x, y),
  };
}

// --- test harness ---

let passed = 0;
function test(name, fn) {
  saidLines.length = 0;
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

const HOME_GREET_MARKERS = ["welcome back", "welcome home", "one of our own"];
const COLD_MARKERS = ["your kind", "outlander", "no warm hearth"];

function saidHomeGreeting() {
  return saidLines.some(({ line }) =>
    HOME_GREET_MARKERS.some((m) => line.toLowerCase().includes(m))
  );
}

function saidColdLine() {
  return saidLines.some(({ line }) =>
    COLD_MARKERS.some((m) => line.toLowerCase().includes(m))
  );
}

// --- GuardPatrol tests ---

test("guard greets a fellow-kingdom player in home territory", () => {
  const action = createGuardPatrolAction({}, {});
  const guard = stubCitizen("GuardBot", "misthalin");
  guard.getLocalPlayers = () => [stubRealPlayer("Jon", "misthalin", 3205, 3200)];
  action.update({ player: guard, nowMs: 1000000 });
  assert.ok(saidLines.length > 0, "expected sayPublic to be called");
  assert.ok(saidHomeGreeting(), `expected a home greeting, got: ${JSON.stringify(saidLines.map((s) => s.line))}`);
});

test("guard does not re-greet the same player within 5 minutes", () => {
  const action = createGuardPatrolAction({}, {});
  const guard = stubCitizen("GuardBot", "misthalin");
  const fellow = stubRealPlayer("Jon", "misthalin", 3205, 3200);
  guard.getLocalPlayers = () => [fellow];
  action.update({ player: guard, nowMs: 1000000 });
  const firstCount = saidLines.length;
  assert.ok(firstCount > 0, "expected first greeting");
  saidLines.length = 0;
  action.update({ player: guard, nowMs: 1000000 + 60000 }); // +1 min
  assert.ok(!saidHomeGreeting(), "should not greet again within cooldown");
});

test("guard greets again after the 5-minute cooldown expires", () => {
  const action = createGuardPatrolAction({}, {});
  const guard = stubCitizen("GuardBot", "misthalin");
  guard.getLocalPlayers = () => [stubRealPlayer("Jon", "misthalin", 3205, 3200)];
  action.update({ player: guard, nowMs: 1000000 });
  assert.ok(saidLines.length > 0, "expected first greeting");
  saidLines.length = 0;
  action.update({ player: guard, nowMs: 1000000 + 6 * 60000 }); // +6 min
  assert.ok(saidHomeGreeting(), "expected greeting after cooldown expiry");
});

test("guard does not give a home greeting to a foreign player", () => {
  const action = createGuardPatrolAction({}, {});
  const guard = stubCitizen("GuardBot", "misthalin");
  guard.getLocalPlayers = () => [stubRealPlayer("Stranger", "asgarnia", 3205, 3200)];
  action.update({ player: guard, nowMs: 1000000 });
  assert.ok(!saidHomeGreeting(), `foreigner should not get a home greeting, got: ${JSON.stringify(saidLines.map((s) => s.line))}`);
});

// --- Merchant tests ---

test("merchant gives a warm word to a fellow-kingdom player", () => {
  const action = createMerchantAction({}, {});
  const merchant = stubCitizen("MerchantBot", "misthalin");
  merchant.getLocalPlayers = () => [stubRealPlayer("Jon", "misthalin", 3202, 3200)];
  action.update({ player: merchant, nowMs: 1000000 });
  assert.ok(saidLines.length > 0, "expected sayPublic to be called");
  assert.ok(saidHomeGreeting(), `expected a warm fellow line, got: ${JSON.stringify(saidLines.map((s) => s.line))}`);
});

test("merchant gives a cold-but-neutral line to a foreign player", () => {
  const action = createMerchantAction({}, {});
  const merchant = stubCitizen("MerchantBot", "misthalin");
  merchant.getLocalPlayers = () => [stubRealPlayer("Outlander", "asgarnia", 3202, 3200)];
  action.update({ player: merchant, nowMs: 1000000 });
  assert.ok(saidLines.length > 0, "expected sayPublic to be called");
  assert.ok(saidColdLine(), `expected a cold line, got: ${JSON.stringify(saidLines.map((s) => s.line))}`);
  assert.ok(!saidHomeGreeting(), "foreigner must not get a home greeting");
});

test("merchant does not re-recognize the same player within 5 minutes", () => {
  const action = createMerchantAction({}, {});
  const merchant = stubCitizen("MerchantBot", "misthalin");
  merchant.getLocalPlayers = () => [stubRealPlayer("Jon", "misthalin", 3202, 3200)];
  action.update({ player: merchant, nowMs: 1000000 });
  assert.ok(saidLines.length > 0, "expected first recognition");
  saidLines.length = 0;
  action.update({ player: merchant, nowMs: 1000000 + 60000 }); // +1 min
  assert.strictEqual(saidLines.length, 0, "should not recognize again within cooldown");
});

test("sayPublic receives the speaking citizen and a string line", () => {
  const action = createGuardPatrolAction({}, {});
  const guard = stubCitizen("GuardBot", "misthalin");
  guard.getLocalPlayers = () => [stubRealPlayer("Jon", "misthalin", 3205, 3200)];
  action.update({ player: guard, nowMs: 1000000 });
  assert.ok(saidLines.length > 0, "expected sayPublic call");
  for (const { player, line } of saidLines) {
    assert.strictEqual(player, "GuardBot", "sayPublic player should be the guard's username");
    assert.strictEqual(typeof line, "string", "sayPublic line should be a string");
    assert.ok(line.length > 0, "sayPublic line should not be empty");
  }
});

console.log(`\n${passed} tests passed.`);
