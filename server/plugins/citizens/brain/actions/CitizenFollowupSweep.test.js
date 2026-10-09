"use strict";

/**
 * CitizenFollowupSweep.test.js — regression tests for the 05:00
 * seven-systems audit follow-up sweep (scopes 1–3), run without a server.
 *
 * Every stub below follows the REAL engine API shape:
 *   requestMovement(player, targetX, targetY, options)  (BotNavigation.js)
 *   getJournal().log(citizenName, kind, text, opts)      (CitizenJournal.js)
 * Never let a stub codify a dead API.
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenFollowupSweep.test.js
 */

const assert = require("assert");
const path = require("path");

function stub(p, exports) {
  const abs = path.resolve(__dirname, p);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// --- engine stubs (real API shapes) ---

const movementCalls = [];
stub("../../../bots/behaviours/navigation/BotNavigation.js", {
  requestMovement: (player, targetX, targetY, options = {}) => {
    movementCalls.push({ player, targetX, targetY, z: options?.z ?? 0 });
    player.__movedTo = { x: targetX, y: targetY, z: options?.z ?? 0 };
  },
  clearMovementRequest: () => {},
});

stub("../../../bots/brain/ActionState.js", {
  playerState: (action, player, init) => {
    if (!player.__sweepState) player.__sweepState = init();
    return player.__sweepState;
  },
});

const HALL_TILE = { x: 3204, y: 3200, z: 0 };
const HOME_TILE = { x: 3200, y: 3200, z: 0 };

stub("../CitizenSites.js", {
  siteTile: () => ({ ...HOME_TILE }),
  siteTileByKingdom: () => ({ ...HOME_TILE }),
  kingdomIdOf: () => "varrock",
  KINGDOM_IDS: ["varrock"],
});

stub("../../constants.js", {
  ATTR_CITIZEN_PERSONALITY: "citizens:personality",
});

stub("../../lib/humanizer.js", {
  agentRng: () => () => 0.5,
  humanizerProfile: () => ({}),
});

// --- guild stubs (per-action membership control) ---

function guildStub(rankConst, rank) {
  return {
    [rankConst]: rank,
    isGuildMember: (u) => guildStub.members.has(String(u || "").toLowerCase()),
    guildRankOf: (u) =>
      guildStub.members.has(String(u || "").toLowerCase()) ? rank : null,
    memberOf: () => null,
    hallTileFor: () => ({ ...HALL_TILE }),
  };
}
guildStub.members = new Set();

stub("../../lib/CitizenSpyGuilds.js", guildStub("RANK_SPYMASTER", "spymaster"));
stub("../../lib/CitizenLawGuilds.js", guildStub("RANK_COUNSELOR", "counselor"));
stub(
  "../../lib/CitizenDiplomaticCorps.js",
  guildStub("RANK_AMBASSADOR", "ambassador")
);

// --- journal spy (real log() signature) ---

const journalCalls = [];
stub("../../lib/CitizenJournal.js", {
  getJournal: () => ({
    log: (citizenName, kind, text, opts = {}) => {
      journalCalls.push({ citizenName, kind, text, opts });
      return { citizenName, kind, text };
    },
  }),
});

// --- modules under test ---

const {
  createCitizenShadowGuildAction,
} = require("./CitizenShadowGuild");
const { createCitizenLawGuildAction } = require("./CitizenLawGuild");
const {
  createCitizenDiploCorpsAction,
} = require("./CitizenDiploCorps");

function stubPlayer(username, position) {
  return {
    __sweepState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: () => ({}),
    getPosition: () => position || { x: 0, y: 0, z: 0 },
  };
}

let passed = 0;
function test(name, fn) {
  movementCalls.length = 0;
  journalCalls.length = 0;
  guildStub.members.clear();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

// --- scope 1: walkTo uses the real requestMovement shape ---

test("ShadowGuild: non-member walks home with (player, x, y, {z})", () => {
  const a = createCitizenShadowGuildAction({}, {});
  const p = stubPlayer("Stranger", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.strictEqual(movementCalls.length, 1);
  const c = movementCalls[0];
  assert.strictEqual(c.player, p);
  assert.strictEqual(typeof c.targetX, "number"); // old shape passed an object here
  assert.deepStrictEqual(
    { x: c.targetX, y: c.targetY, z: c.z },
    HOME_TILE
  );
});

test("LawGuild: non-member walks home with (player, x, y, {z})", () => {
  const a = createCitizenLawGuildAction({}, {});
  const p = stubPlayer("Stranger", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.strictEqual(movementCalls.length, 1);
  const c = movementCalls[0];
  assert.strictEqual(typeof c.targetX, "number");
  assert.deepStrictEqual(
    { x: c.targetX, y: c.targetY, z: c.z },
    HOME_TILE
  );
});

test("DiploCorps: non-member walks home with (player, x, y, {z})", () => {
  const a = createCitizenDiploCorpsAction({}, {});
  const p = stubPlayer("Stranger", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.strictEqual(movementCalls.length, 1);
  const c = movementCalls[0];
  assert.strictEqual(typeof c.targetX, "number");
  assert.deepStrictEqual(
    { x: c.targetX, y: c.targetY, z: c.z },
    HOME_TILE
  );
});

// --- session journals: canonical log(name, kind, text, {data}) ---

function driveToFinalSession(create, username, rankTileMs) {
  guildStub.members.add(username.toLowerCase());
  const a = create({}, {});
  const p = stubPlayer(username, { ...HALL_TILE });
  let nowMs = 1000000;
  for (let i = 0; i < 12; i++) {
    nowMs += rankTileMs;
    const status = a.update({ player: p, nowMs });
    if (status !== "running") break;
  }
  return p;
}

test("ShadowGuild: spymaster session journaled as log(name, kind, text)", () => {
  driveToFinalSession(createCitizenShadowGuildAction, "SpymasterSue", 9000);
  assert.strictEqual(journalCalls.length, 1);
  const j = journalCalls[0];
  assert.strictEqual(j.citizenName, "SpymasterSue");
  assert.strictEqual(j.kind, "shadowguild"); // old shape put an object here
  assert.ok(
    typeof j.text === "string" && j.text.length > 0,
    "text must be present (old shape journaled nothing)"
  );
  assert.deepStrictEqual(j.opts, {
    data: { rank: "spymaster", kingdomId: "varrock" },
  });
});

test("LawGuild: counselor session journaled as log(name, kind, text)", () => {
  driveToFinalSession(createCitizenLawGuildAction, "CounselorCid", 9000);
  assert.strictEqual(journalCalls.length, 1);
  const j = journalCalls[0];
  assert.strictEqual(j.citizenName, "CounselorCid");
  assert.strictEqual(j.kind, "lawguild");
  assert.ok(typeof j.text === "string" && j.text.length > 0);
});

test("DiploCorps: ambassador session journaled as log(name, kind, text)", () => {
  driveToFinalSession(createCitizenDiploCorpsAction, "AmbassadorAl", 9000);
  assert.strictEqual(journalCalls.length, 1);
  const j = journalCalls[0];
  assert.strictEqual(j.citizenName, "AmbassadorAl");
  assert.strictEqual(j.kind, "diplocorps");
  assert.ok(typeof j.text === "string" && j.text.length > 0);
});

console.log(`\n${passed} passed`);
