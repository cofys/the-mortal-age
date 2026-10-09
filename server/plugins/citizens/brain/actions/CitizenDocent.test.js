"use strict";

/**
 * CitizenDocent.test.js — plain-node tests (no jest).
 * Engine modules (BotNavigation, ActionState, CitizenSites, humanizer) are
 * stubbed via the require cache, per the CitizenChart.test.js pattern.
 * Run: node server/plugins/citizens/brain/actions/CitizenDocent.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const actionsDir = __dirname;
const libDir = path.join(actionsDir, "..", "..", "lib");

// --- stub engine modules -----------------------------------------------------
const navPath = path.join(actionsDir, "..", "..", "..", "bots", "behaviours", "navigation", "BotNavigation.js");
const actionStatePath = path.join(actionsDir, "..", "..", "..", "bots", "brain", "ActionState.js");
const sitesPath = path.join(actionsDir, "..", "CitizenSites.js");

const movements = [];
require.cache[navPath] = {
  exports: {
    requestMovement: (player, x, y) => movements.push({ player, x, y }),
    clearMovementRequest: () => {},
  },
};
require.cache[actionStatePath] = {
  exports: { playerState: () => ({ homeTile: { x: 0, y: 0 } }) },
};
require.cache[sitesPath] = {
  exports: { kingdomIdOf: () => "misthalin", siteTile: () => null },
};

// --- stub the observatories + astronomy data tiers ---------------------------
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "docent-test-")), "citizen-observatories.json");
const Obs = require(path.join(libDir, "CitizenObservatories.js"));
Obs._setSavePathForTests(tmpSave);

const astroPath = path.join(libDir, "CitizenAstronomy.js");
require.cache[astroPath] = {
  exports: {
    observatoryFor: (kid) => (kid === "misthalin" ? { kingdomId: kid, tile: { x: 100, y: 200 } } : null),
    astronomerFor: (u) => (u === "Stargazer_Sue" ? { username: u, kingdomId: "misthalin" } : null),
    chartsFor: () => [],
    activeEventFor: () => null,
  },
};

const { createCitizenDocentAction } = require("./CitizenDocent.js");

const NIGHT = new Date(2026, 5, 15, 23, 0, 0).getTime();
const DAY = new Date(2026, 5, 15, 12, 0, 0).getTime();

function makeBot(username, x = 0, y = 0) {
  const said = [];
  return {
    username,
    said,
    getUsername: () => username,
    getPosition: () => ({ x, y }),
    sayPublic: (line) => said.push(line),
  };
}

let passed = 0;
function test(name, fn) {
  Obs.resetForTests();
  movements.length = 0;
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("factory: returns tick/reset", () => {
  const a = createCitizenDocentAction();
  assert.strictEqual(typeof a.tick, "function");
  assert.strictEqual(typeof a.reset, "function");
});

test("non-astronomer honestly walks home", () => {
  const a = createCitizenDocentAction();
  const bot = makeBot("Random_Ron", 100, 200);
  const r = a.tick(bot, NIGHT);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.reason, "walk-home");
});

test("astronomer walks home in daytime (observatory closed)", () => {
  const a = createCitizenDocentAction();
  const bot = makeBot("Stargazer_Sue", 100, 200);
  const r = a.tick(bot, DAY);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.reason, "walk-home");
});

test("astronomer walks to observatory at night", () => {
  const a = createCitizenDocentAction();
  const bot = makeBot("Stargazer_Sue", 0, 0);
  const r = a.tick(bot, NIGHT);
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.phase, "outbound");
  assert.ok(movements.some((m) => m.x === 100 && m.y === 200), "should walk to observatory tile");
});

test("arrived astronomer hosts in rounds then walks home", () => {
  const a = createCitizenDocentAction();
  const bot = makeBot("Stargazer_Sue", 100, 200);
  let r = a.tick(bot, NIGHT);
  assert.strictEqual(r.phase, "hosting");
  // advance through hosting rounds
  let t = NIGHT;
  for (let i = 0; i < 10; i++) {
    t += 9000;
    r = a.tick(bot, t);
    if (r.done) break;
  }
  assert.strictEqual(r.done, true, "should finish hosting rounds and walk home");
});

test("null player safety", () => {
  const a = createCitizenDocentAction();
  const r = a.tick(null, NIGHT);
  assert.strictEqual(r.done, true);
});

test("give-up timeout walks home", () => {
  const a = createCitizenDocentAction();
  const bot = makeBot("Stargazer_Sue", 0, 0);
  a.tick(bot, NIGHT);
  const r = a.tick(bot, NIGHT + 11 * 60 * 1000);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.reason, "walk-home");
});

console.log(`CitizenDocent: ${passed} passed`);
if (process.exitCode) console.log("FAILURES PRESENT");
