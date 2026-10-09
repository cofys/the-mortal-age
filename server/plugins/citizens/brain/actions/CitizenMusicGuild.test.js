"use strict";

// Plain-node tests for the CitizenMusicGuild brain action.
// Uses require-cache stubs for engine modules (per the CitizenChart pattern).
const assert = require("assert");

const Module = require("module");
const origRequire = Module.prototype.require;

// --- Stubs ---
const guildState = {
  members: {}, // lower -> { rank, suspended }
  guilds: {}, // kid -> { hallTile }
};

const stubs = {
  "../../../bots/brain/ActionState": {
    playerState: (action, player, init) => {
      if (!player._musicGuildState) player._musicGuildState = init();
      return player._musicGuildState;
    },
  },
  "../../../bots/behaviours/navigation/BotNavigation": {
    requestMovement: (player, x, y) => { player._moveTo = { x, y }; },
    clearMovementRequest: (player) => { player._moveTo = null; },
  },
  "../CitizenSites": {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "varrock",
  },
  "../../constants": { ATTR_CITIZEN_PERSONALITY: "citizen:personality" },
  "../../lib/humanizer": {
    agentRng: () => Math.random,
    humanizerProfile: () => ({}),
  },
  "../../lib/CitizenMusicGuilds": {
    RANK_MAESTRO: "maestro",
    isGuildMember: (u) => !!guildState.members[u.toLowerCase()],
    guildRankOf: (u) => guildState.members[u.toLowerCase()]?.rank || null,
    memberOf: (u) => guildState.members[u.toLowerCase()] || null,
    ensureGuild: (kid) => {
      if (!guildState.guilds[kid]) {
        guildState.guilds[kid] = { hallTile: { x: 3300, y: 3300, z: 0 } };
      }
      return guildState.guilds[kid];
    },
  },
};

Module.prototype.require = function (id) {
  if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
  return origRequire.apply(this, arguments);
};

const { createCitizenMusicGuildAction } = require("./CitizenMusicGuild");

function makePlayer(username, pos) {
  return {
    username,
    getUsername: () => username,
    getAttribute: () => ({}),
    getPosition: () => pos,
    position: pos,
    _moveTo: null,
    _musicGuildState: null,
  };
}

let passed = 0;
function test(name, fn) {
  guildState.members = {};
  guildState.guilds = {};
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

test("factory creates action with id", () => {
  const action = createCitizenMusicGuildAction({}, {});
  assert.strictEqual(action.id, "citizenMusicGuild");
  assert.strictEqual(typeof action.update, "function");
});

test("non-member walks home honestly", () => {
  const action = createCitizenMusicGuildAction({}, {});
  const player = makePlayer("Stranger", { x: 3200, y: 3200, z: 0 });
  // Not a member — should go to "returning" phase and walk home.
  const result = action.update({ player, nowMs: 1000 });
  assert.strictEqual(result, "success"); // already at home
});

test("member walks to hall then sessions", () => {
  guildState.members["lute larry"] = { rank: "minstrel", suspended: false };
  const action = createCitizenMusicGuildAction({}, {});
  const player = makePlayer("Lute Larry", { x: 3200, y: 3200, z: 0 });
  let nowMs = 1000;
  // First tick: outbound — should request movement to hall.
  let result = action.update({ player, nowMs });
  assert.strictEqual(result, "running");
  assert.ok(player._moveTo);
  assert.strictEqual(player._moveTo.x, 3300);
  // Simulate arrival at hall.
  player.position = { x: 3300, y: 3300, z: 0 };
  player.getPosition = () => player.position;
  nowMs += 1000;
  result = action.update({ player, nowMs });
  assert.strictEqual(result, "running");
  // Should now be in session phase (movement cleared).
  assert.strictEqual(player._moveTo, null);
});

test("suspended member walks home", () => {
  guildState.members["lute larry"] = { rank: "minstrel", suspended: true };
  const action = createCitizenMusicGuildAction({}, {});
  const player = makePlayer("Lute Larry", { x: 3200, y: 3200, z: 0 });
  const result = action.update({ player, nowMs: 1000 });
  assert.strictEqual(result, "success"); // at home already
});

test("null player returns success", () => {
  const action = createCitizenMusicGuildAction({}, {});
  const result = action.update({ player: null, nowMs: 1000 });
  assert.strictEqual(result, "success");
});

test("members TALK during session rounds (no silent guild hall)", () => {
  guildState.members["lute larry"] = { rank: "minstrel", suspended: false };
  const said = [];
  const spec = { sayPublic: (player, line) => said.push(line) };
  const action = createCitizenMusicGuildAction(spec, {});
  const player = makePlayer("Lute Larry", { x: 3200, y: 3200, z: 0 });
  let nowMs = 1000;
  action.update({ player, nowMs }); // outbound
  player.position = { x: 3300, y: 3300, z: 0 };
  player.getPosition = () => player.position;
  nowMs += 1000;
  action.update({ player, nowMs }); // arrives, enters session
  for (let i = 0; i < 3; i++) {
    nowMs += 8000;
    action.update({ player, nowMs }); // session rounds
  }
  assert.ok(said.length >= 1, `expected hall chatter, got ${said.length} lines`);
  for (const line of said) {
    assert.ok(line && line.length <= 80, `bad line: ${JSON.stringify(line)}`);
    assert.ok(line.trim().split(/\s+/).length <= 15, `line too long: "${line}"`);
  }
});

test("give-up timeout redirects to returning", () => {
  guildState.members["lute larry"] = { rank: "minstrel", suspended: false };
  const action = createCitizenMusicGuildAction({}, {});
  // Start far from hall so we never arrive.
  const player = makePlayer("Lute Larry", { x: 1000, y: 1000, z: 0 });
  let nowMs = 1000;
  action.update({ player, nowMs });
  // Jump past the give-up timeout (10 min). First tick after timeout just
  // flips the phase; the walk home starts on the following tick.
  nowMs += 11 * 60 * 1000;
  let result = action.update({ player, nowMs });
  assert.strictEqual(result, "running");
  nowMs += 1000;
  result = action.update({ player, nowMs });
  assert.strictEqual(result, "running");
  // Should now be heading home (returning phase).
  assert.ok(player._moveTo);
});

Module.prototype.require = origRequire;
console.log(`\n${passed} tests passed`);
