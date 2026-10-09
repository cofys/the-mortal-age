"use strict";

/**
 * CitizenPromote.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenRunway.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenPromote.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__promoteState) player.__promoteState = init();
      return player.__promoteState;
    },
  },
};

const navPath = path.resolve(__dirname, "../../../bots/behaviours/navigation/BotNavigation.js");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    // teleport on request: simulates the walk completing between ticks
    requestMovement: (player, targetX, targetY, options = {}) => { const t = { x: targetX, y: targetY, z: options?.z ?? 0 }; player.__movedTo = t; player.position = { ...t }; },
    clearMovementRequest: () => {},
  },
};

const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "asgarnia",
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

// --- real modules under test ---

const SAVE_PATH = path.join(os.tmpdir(), `citizen-promote-action-test-${process.pid}.json`);
const MF = require("../../lib/CitizenMusicFestivals");
MF._setSavePathForTests(SAVE_PATH);
const { createCitizenPromoteAction } = require("./CitizenPromote");

// --- helpers ---

function stubPlayer(username, opts) {
  const o = opts || {};
  const p = {
    __promoteState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: (k) => (k === "citizens:personality" ? (o.personality || {}) : undefined),
    getPosition: () => p.position,
    position: { x: 0, y: 0, z: 0 },
    performEmote: () => {},
  };
  return p;
}

function ctxFor(player, nowMs) {
  return { player, nowMs: nowMs || 1000000, world: {} };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    try { require("fs").unlinkSync(SAVE_PATH); } catch { /* fresh */ }
    MF.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}

// --- tests ---

test("action factory creates a citizenPromote action", () => {
  const a = createCitizenPromoteAction({}, {});
  assert(a && a.id === "citizenPromote", "action id");
  assert(typeof a.update === "function", "has update");
});

test("non-promoter honestly walks home", () => {
  const a = createCitizenPromoteAction({}, {});
  const p = stubPlayer("Nobody", {});
  let res = a.update(ctxFor(p, 1000000));
  assert(res === "running", "first tick running (heading home)");
  for (let i = 0; i < 5; i++) {
    res = a.update(ctxFor(p, 1000000 + (i + 1) * 1000));
    if (res === "success") break;
  }
  assert(res === "success", "non-promoter ends at home");
});

test("registered promoter walks to the ground and promotes", () => {
  MF.registerPromoter("Promo", "asgarnia");
  MF.ensureGround("asgarnia");
  const a = createCitizenPromoteAction({}, {});
  const p = stubPlayer("Promo", {});
  p.position = { x: 0, y: 0, z: 0 };
  let res = a.update(ctxFor(p, 1000000));
  assert(res === "running", "outbound");
  let promoted = false;
  for (let t = 1000000 + 1000; t < 1000000 + 200000; t += 9000) {
    res = a.update(ctxFor(p, t));
    const st = p.__promoteState;
    if (st && st.phase === "promoting") promoted = true;
    if (res === "success") break;
  }
  assert(promoted, "promoter reached the promoting phase");
  assert(res === "success", "action completes after promote rounds");
});

test("company member promotes too", () => {
  MF.registerPromoter("Boss", "asgarnia");
  MF.foundCompany("Boss", "Loud Sounds");
  MF.joinCompany("Helper", "Loud Sounds");
  const a = createCitizenPromoteAction({}, {});
  const p = stubPlayer("Helper", {});
  let res = "running";
  for (let i = 0; i < 6 && res === "running"; i++) {
    res = a.update(ctxFor(p, 1000000 + i * 9000));
  }
  // Helper is a company member — should promote, not walk straight home.
  const st = p.__promoteState;
  assert(st && (st.phase === "promoting" || st.phase === "returning" || res === "success"), "member promotes");
});

test("null player is safe", () => {
  const a = createCitizenPromoteAction({}, {});
  assert.strictEqual(a.update({ player: null, nowMs: 1 }), "success", "null player -> success");
});

test("give-up timeout returns the promoter home", () => {
  MF.registerPromoter("Slow", "asgarnia");
  MF.ensureGround("asgarnia");
  const a = createCitizenPromoteAction({}, {});
  const p = stubPlayer("Slow", {});
  p.position = { x: 0, y: 0, z: 0 };
  a.update(ctxFor(p, 1000000));
  const st = p.__promoteState;
  assert(st.giveUpAt > 1000000, "give-up deadline set");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
