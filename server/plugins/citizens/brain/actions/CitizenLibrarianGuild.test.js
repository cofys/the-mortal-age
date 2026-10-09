"use strict";

/**
 * CitizenLibrarianGuild.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenArtGuild.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenLibrarianGuild.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__libGuildState) player.__libGuildState = init();
      return player.__libGuildState;
    },
  },
};

const navPath = path.resolve(__dirname, "../../../bots/behaviours/navigation/BotNavigation.js");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: (player, targetX, targetY, options = {}) => { player.__movedTo = { x: targetX, y: targetY, z: options?.z ?? 0 }; },
    clearMovementRequest: () => {},
  },
};

const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "varrock",
  },
};

const constPath = path.resolve(__dirname, "../../constants.js");
require.cache[constPath] = {
  id: constPath, filename: constPath, loaded: true,
  exports: { ATTR_CITIZEN_PERSONALITY: "citizens:personality" },
};

const humanizerPath = path.resolve(__dirname, "../../lib/humanizer.js");
require.cache[humanizerPath] = {
  id: humanizerPath, filename: humanizerPath, loaded: true,
  exports: {
    agentRng: () => () => 0.5,
    humanizerProfile: () => ({}),
  },
};

// Controllable guild membership.
const members = new Set();
const archivists = new Set();
const guildsPath = path.resolve(__dirname, "../../lib/CitizenLibrarianGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    RANK_PAGE: "page",
    RANK_LIBRARIAN: "librarian",
    RANK_ARCHIVIST: "archivist",
    isGuildMember: (u) => members.has(String(u || "").toLowerCase()),
    memberOf: (u) => (members.has(String(u || "").toLowerCase()) ? { suspended: false } : null),
    guildRankOf: (u) => {
      const k = String(u || "").toLowerCase();
      if (archivists.has(k)) return "archivist";
      return members.has(k) ? "librarian" : null;
    },
    ensureGuild: () => ({ hallTile: { x: 3204, y: 3203, z: 0 } }),
  },
};

// --- real module under test ---

const { createCitizenLibrarianGuildAction } = require("./CitizenLibrarianGuild");

const HALL_TILE = { x: 3204, y: 3203, z: 0 };
const HOME_TILE = { x: 3200, y: 3200, z: 0 };

function stubPlayer(username, position) {
  return {
    username,
    getUsername: () => username,
    getPosition: () => ({ ...position }),
    position: { ...position },
    getAttribute: () => ({}),
    __movedTo: null,
  };
}

let passed = 0;
function test(name, fn) {
  members.clear();
  archivists.clear();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    console.error(e.stack);
    process.exitCode = 1;
  }
}

test("non-members honestly return home", () => {
  const player = stubPlayer("stranger", { x: 0, y: 0, z: 0 });
  const action = createCitizenLibrarianGuildAction({}, {});
  const r = action.update({ player, nowMs: 1000 });
  assert.strictEqual(r, "running");
  // Walking home, not to the hall.
  assert.deepStrictEqual(player.__movedTo, { x: HOME_TILE.x, y: HOME_TILE.y, z: 0 });
});

test("members walk to the guild hall", () => {
  members.add("bookish berta");
  const player = stubPlayer("bookish berta", { x: 0, y: 0, z: 0 });
  const action = createCitizenLibrarianGuildAction({}, {});
  const r = action.update({ player, nowMs: 1000 });
  assert.strictEqual(r, "running");
  assert.deepStrictEqual(player.__movedTo, { x: HALL_TILE.x, y: HALL_TILE.y, z: 0 });
});

test("members hold human-paced session rounds then return home", () => {
  members.add("bookish berta");
  const player = stubPlayer("bookish berta", { x: HALL_TILE.x, y: HALL_TILE.y, z: 0 });
  const action = createCitizenLibrarianGuildAction({}, {});
  let now = 1000;
  // First update: arrives at hall, enters session.
  assert.strictEqual(action.update({ player, nowMs: now }), "running");
  // Three rounds at 8s human pace.
  for (let i = 0; i < 3; i++) {
    now += 8000;
    assert.strictEqual(action.update({ player, nowMs: now }), "running");
  }
  // Next update: rounds done, heading home.
  now += 8000;
  assert.strictEqual(action.update({ player, nowMs: now }), "running");
  // Teleport home; the action completes.
  player.getPosition = () => ({ ...HOME_TILE });
  player.position = { ...HOME_TILE };
  assert.strictEqual(action.update({ player, nowMs: now + 1000 }), "success");
});

test("action gives up and returns home after the give-up window", () => {
  members.add("bookish berta");
  const player = stubPlayer("bookish berta", { x: 0, y: 0, z: 0 });
  const action = createCitizenLibrarianGuildAction({}, {});
  assert.strictEqual(action.update({ player, nowMs: 1000 }), "running");
  // 11 minutes later: past the 10-minute give-up.
  const r = action.update({ player, nowMs: 1000 + 11 * 60 * 1000 });
  assert.strictEqual(r, "running");
  assert.deepStrictEqual(player.__movedTo, { x: HOME_TILE.x, y: HOME_TILE.y, z: 0 });
});

test("action id is citizenLibrarianGuild", () => {
  const action = createCitizenLibrarianGuildAction({}, {});
  assert.strictEqual(action.id, "citizenLibrarianGuild");
});

console.log(`\n${passed} tests passed`);
