"use strict";

/**
 * CitizenCookGuild.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenSportsGuild.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenCookGuild.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__cookState) player.__cookState = init();
      return player.__cookState;
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

const journalCalls = [];
const journalPath = path.resolve(__dirname, "../../lib/CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: { getJournal: () => ({ log: (...args) => { journalCalls.push(args); return true; } }) },
};

// Controllable guild membership.
const members = new Set();
const suspended = new Set();
const ranks = new Map();
const mentors = new Map();
const guildsPath = path.resolve(__dirname, "../../lib/CitizenCookGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    RANK_APPRENTICE: "apprentice",
    RANK_SOUSCHEF: "souschef",
    RANK_CHEFDECUISINE: "chefdecuisine",
    isGuildMember: (u) => members.has(String(u || "").toLowerCase()),
    guildRankOf: (u) => ranks.get(String(u || "").toLowerCase()) || null,
    memberOf: (u) => {
      const n = String(u || "").toLowerCase();
      return members.has(n)
        ? { suspended: suspended.has(n), mentor: mentors.get(n) || null }
        : null;
    },
    ensureGuild: () => ({ hallTile: { x: 3208, y: 3194, z: 0 } }),
  },
};

// --- real module under test ---

const { createCitizenCookGuildAction } = require("./CitizenCookGuild");

const HALL_TILE = { x: 3208, y: 3194, z: 0 };
const HOME_TILE = { x: 3200, y: 3200, z: 0 };

function stubPlayer(username, position) {
  return {
    __cookState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: () => ({}),
    getPosition: () => position || { x: 0, y: 0, z: 0 },
  };
}

function runTicks(action, player, ticks, stepMs, startMs = 1000000) {
  let nowMs = startMs;
  let status = "running";
  for (let i = 0; i < ticks && status === "running"; i++) {
    nowMs += stepMs;
    status = action.update({ player, nowMs });
  }
  return { status, nowMs };
}

let passed = 0;
function test(name, fn) {
  members.clear();
  suspended.clear();
  ranks.clear();
  mentors.clear();
  journalCalls.length = 0;
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

function addMember(name, rank = "apprentice") {
  members.add(String(name).toLowerCase());
  ranks.set(String(name).toLowerCase(), rank);
}

test("factory creates the action", () => {
  const a = createCitizenCookGuildAction({}, {});
  assert.strictEqual(a.id, "citizenCookGuild");
  assert.strictEqual(typeof a.update, "function");
});

test("non-member walks home honestly", () => {
  const a = createCitizenCookGuildAction({}, {});
  const p = stubPlayer("Stranger", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.deepStrictEqual(p.__movedTo, HOME_TILE); // heading home, not to the hall
  p.getPosition = () => ({ ...HOME_TILE });
  const { status } = runTicks(a, p, 50, 1000);
  assert.strictEqual(status, "success");
});

test("suspended member walks home honestly", () => {
  addMember("Gwen");
  suspended.add("gwen");
  const a = createCitizenCookGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.deepStrictEqual(p.__movedTo, HOME_TILE);
});

test("member walks to the hall, holds sessions, returns home", () => {
  addMember("Gwen", "souschef");
  const a = createCitizenCookGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.deepStrictEqual(p.__movedTo, HALL_TILE);
  // arrive at the hall
  p.getPosition = () => ({ ...HALL_TILE });
  a.update({ player: p, nowMs: 1001000 });
  // run session rounds (3 rounds, 8s apart)
  const { status, nowMs } = runTicks(a, p, 100, 9000, 1001000);
  assert.strictEqual(p.__cookState.roundsDone, 3, "three session rounds held");
  // after sessions, heads home
  assert.deepStrictEqual(p.__movedTo, HOME_TILE);
  p.getPosition = () => ({ ...HOME_TILE });
  const done = runTicks(a, p, 50, 1000, nowMs);
  assert.strictEqual(done.status, "success");
});

test("gives up after ten minutes and heads home", () => {
  addMember("Gwen");
  const a = createCitizenCookGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.deepStrictEqual(p.__movedTo, HALL_TILE);
  // never arrives; jump past the give-up deadline
  const { status } = runTicks(a, p, 5, 1000, 1000000 + 11 * 60 * 1000);
  assert.strictEqual(p.__cookState.phase, "returning");
  assert.deepStrictEqual(p.__movedTo, HOME_TILE);
  assert.strictEqual(status, "running");
});

test("update never throws without a player", () => {
  const a = createCitizenCookGuildAction({}, {});
  assert.strictEqual(a.update({ player: null, nowMs: 1000000 }), "success");
});

test("mentored apprentice's final round writes a canonical mentoring journal entry", () => {
  // Regression: the old block fired only for chefdecuisine rank while reading
  // mem.mentor (which lives on the APPRENTICE's record) — a dead branch —
  // and called the dead 2-arg log(name, {...}) shape with no text.
  addMember("Gwen", "apprentice");
  mentors.set("gwen", "Auguste");
  const a = createCitizenCookGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 }); // outbound
  p.getPosition = () => ({ ...HALL_TILE });
  runTicks(a, p, 100, 9000, 1001000); // 3 session rounds
  assert.strictEqual(journalCalls.length, 1, "exactly one mentoring entry");
  const [name, kind, text, data] = journalCalls[0];
  assert.strictEqual(name, "Gwen", "canonical log(name, kind, text, {data})");
  assert.strictEqual(kind, "cookguild");
  assert.ok(typeof text === "string" && text.includes("Auguste"), "text names the master");
  assert.strictEqual(data.master, "Auguste");
  assert.strictEqual(data.apprentice, "Gwen");
});

test("unmentored apprentice writes no mentoring entry", () => {
  addMember("Gwen", "apprentice");
  const a = createCitizenCookGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  p.getPosition = () => ({ ...HALL_TILE });
  runTicks(a, p, 100, 9000, 1001000);
  assert.strictEqual(journalCalls.length, 0, "no mentor, no entry");
});

console.log(`\nCitizenCookGuild (action): ${passed} passed`);
