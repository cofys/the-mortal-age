"use strict";

/**
 * CitizenShadowGuild.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenLawGuild.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenShadowGuild.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__shadowguildState) player.__shadowguildState = init();
      return player.__shadowguildState;
    },
  },
};

const movedTo = [];
const navPath = path.resolve(__dirname, "../../../bots/behaviours/navigation/BotNavigation.js");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: (player, tile) => { movedTo.push({ player: player?.getUsername?.(), tile }); },
    clearMovementRequest: () => {},
  },
};

const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "misthalin",
  },
};

const constPath = path.resolve(__dirname, "../../constants.js");
require.cache[constPath] = {
  id: constPath, filename: constPath, loaded: true,
  exports: { ATTR_CITIZEN_PERSONALITY: "citizen:personality" },
};

const humanizerPath = path.resolve(__dirname, "../../lib/humanizer.js");
require.cache[humanizerPath] = {
  id: humanizerPath, filename: humanizerPath, loaded: true,
  exports: {
    agentRng: () => ({ next: () => 0.5 }),
    humanizerProfile: () => ({}),
  },
};

let guildMembers = {};
const guildsPath = path.resolve(__dirname, "../../lib/CitizenSpyGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    RANK_SPYMASTER: "spymaster",
    isGuildMember: (u) => !!guildMembers[String(u || "").toLowerCase()],
    guildRankOf: (u) => guildMembers[String(u || "").toLowerCase()] || null,
    memberOf: (u) => {
      const r = guildMembers[String(u || "").toLowerCase()];
      return r ? { rank: r, suspended: false } : null;
    },
    hallTileFor: () => ({ x: 3193, y: 3203, z: 0 }),
    ensureGuild: () => ({}),
  },
};

// Now require the action (it picks up the stubs).
const { createCitizenShadowGuildAction } = require("./CitizenShadowGuild");

function makePlayer(username, x, y) {
  return {
    getUsername: () => username,
    username,
    getPosition: () => ({ x, y, z: 0 }),
    position: { x, y, z: 0 },
    getAttribute: () => ({}),
    __shadowguildState: null,
    __movedTo: null,
  };
}

// --- tests -------------------------------------------------------------------

function testFactory() {
  const action = createCitizenShadowGuildAction({}, {});
  assert.strictEqual(action.id, "citizenShadowGuild");
  assert.strictEqual(typeof action.update, "function");
  console.log("ok - factory");
}

function testNonMemberWalksHome() {
  guildMembers = {};
  movedTo.length = 0;
  const action = createCitizenShadowGuildAction({}, {});
  const player = makePlayer("Bob", 3200, 3200);
  const now = Date.now();
  let result = action.update({ player, nowMs: now });
  assert.ok(["running", "success"].includes(result));
  // Player is at market (3200,3200) which is home -> success.
  for (let i = 0; i < 5; i++) {
    result = action.update({ player, nowMs: now + (i + 1) * 1000 });
    if (result === "success") break;
  }
  assert.strictEqual(result, "success", "non-member returns home");
  console.log("ok - non-member walks home");
}

function testMemberSessionFlow() {
  guildMembers = { alice: "operative" };
  movedTo.length = 0;
  const action = createCitizenShadowGuildAction({}, {});
  const player = makePlayer("Alice", 3100, 3100);
  const now = Date.now();
  let result = action.update({ player, nowMs: now });
  assert.strictEqual(result, "running");
  assert.ok(movedTo.length > 0, "member walks toward hall");
  // Teleport to hall; session rounds run (8s rounds).
  player.getPosition = () => ({ x: 3193, y: 3203, z: 0 });
  player.position = { x: 3193, y: 3203, z: 0 };
  for (let i = 0; i < 12; i++) {
    result = action.update({ player, nowMs: now + 10000 + i * 9000 });
    if (result === "success") break;
  }
  // After 3 rounds it heads home.
  player.getPosition = () => ({ x: 3200, y: 3200, z: 0 });
  player.position = { x: 3200, y: 3200, z: 0 };
  for (let i = 0; i < 10; i++) {
    result = action.update({ player, nowMs: now + 300000 + i * 1000 });
    if (result === "success") break;
  }
  assert.strictEqual(result, "success", "member completes session and returns");
  console.log("ok - member session flow");
}

function testNullSafety() {
  const action = createCitizenShadowGuildAction({}, {});
  assert.strictEqual(action.update({ player: null, nowMs: Date.now() }), "success");
  assert.strictEqual(action.update({}), "success");
  console.log("ok - null safety");
}

function testGiveUp() {
  guildMembers = { alice: "operative" };
  const action = createCitizenShadowGuildAction({}, {});
  const player = makePlayer("Alice", 1000, 1000);
  const now = Date.now();
  action.update({ player, nowMs: now });
  // 11 minutes later: give-up triggers returning.
  const result = action.update({ player, nowMs: now + 11 * 60 * 1000 });
  assert.ok(["running", "success"].includes(result), "give-up moves to returning");
  console.log("ok - give-up");
}

function testSuspendedWalksHome() {
  guildMembers = {};
  const suspendPath = path.resolve(__dirname, "../../lib/CitizenSpyGuilds.js");
  require.cache[suspendPath].exports.memberOf = (u) => ({ rank: "operative", suspended: true });
  require.cache[suspendPath].exports.isGuildMember = () => true;
  require.cache[suspendPath].exports.guildRankOf = () => "operative";
  const action = createCitizenShadowGuildAction({}, {});
  const player = makePlayer("Sue", 3200, 3200);
  const now = Date.now();
  let result = action.update({ player, nowMs: now });
  for (let i = 0; i < 5; i++) {
    result = action.update({ player, nowMs: now + (i + 1) * 1000 });
    if (result === "success") break;
  }
  assert.strictEqual(result, "success", "suspended member returns home");
  // Restore stubs.
  require.cache[suspendPath].exports.memberOf = (u) => {
    const r = guildMembers[String(u || "").toLowerCase()];
    return r ? { rank: r, suspended: false } : null;
  };
  require.cache[suspendPath].exports.isGuildMember = (u) => !!guildMembers[String(u || "").toLowerCase()];
  require.cache[suspendPath].exports.guildRankOf = (u) => guildMembers[String(u || "").toLowerCase()] || null;
  console.log("ok - suspended walks home");
}

const tests = [
  testFactory,
  testNonMemberWalksHome,
  testMemberSessionFlow,
  testNullSafety,
  testGiveUp,
  testSuspendedWalksHome,
];

let passed = 0;
for (const t of tests) {
  try {
    t();
    passed++;
  } catch (e) {
    console.error(`FAIL ${t.name}: ${e.message}`);
    console.error(e.stack.split("\n").slice(0, 4).join("\n"));
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} CitizenShadowGuild tests passed`);
