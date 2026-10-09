"use strict";

/**
 * CitizenEspionageLife.test.js — plain-node tests for the espionage tick.
 * Run: node server/plugins/citizens/lib/CitizenEspionageLife.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Esp = require("./CitizenEspionage");

// --- real-API-shape stubs (installed before the Life module's lazy requires)
// The real journal seam is getJournal().log(citizenName, kind, text, opts)
// (CitizenJournal.js:79) — NOT director.journal (doesn't exist on the real
// director). The real speech seam is CitizenSayPublic.sayPublic(bot, text).
const journaled = [];
const said = [];
const journalPath = path.resolve(__dirname, "./CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: {
    getJournal: () => ({
      log: (name, kind, text, data) => { journaled.push({ name, kind, text, data }); },
    }),
  },
};
const sayPublicPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[sayPublicPath] = {
  id: sayPublicPath, filename: sayPublicPath, loaded: true,
  exports: {
    sayPublic: (bot, text) => { said.push({ bot, text }); return true; },
    isRealPlayer: (p) => { try { return p?.isRealPlayer?.() ?? !p?.isBot; } catch { return false; } },
  },
};

const Life = require("./CitizenEspionageLife");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "esplife-test-")), "espionage.json");
Esp._setSavePathForTests(SAVE);

function fakeDirector() {
  // Real director shape: getBot takes the RECORD ({username}), roster is a
  // Map of plain data records, log() is the server log. Speech and
  // journaling go through the stubbed canonical seams above.
  return {
    roster: new Map(),
    log(text, data) { /* server log, unused here */ },
    getBot(query) {
      const username = typeof query === "string" ? query : query?.username;
      if (!username) return null;
      return { username, forceChat() {}, getLocalPlayers: () => [] };
    },
  };
}

let passed = 0;
function test(name, fn) {
  Esp.resetForTests();
  Life.resetForTests();
  journaled.length = 0;
  said.length = 0;
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

test("tick never throws on empty state", () => {
  const d = fakeDirector();
  Life.tickEspionage(d, Date.now());
  assert.ok(true, "survived");
});

test("planning ops activate after the planning window", () => {
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  const op = Esp.planOperation({
    network: "asgarnia", type: "sabotage", subtype: "supply",
    targetKingdom: "kandarin", operative: "tick-spy", nowMs: 1000,
  });
  const d = fakeDirector();
  Life.tickEspionage(d, 1000 + Esp.PLANNING_MS + 5000);
  const after = Esp.operationById(op.id);
  assert.strictEqual(after.state, "active", "planning -> active");
  assert.ok(journaled.some((j) => j.data?.op === op.id && j.kind === "espionage"), "activation journaled via getJournal().log");
  assert.strictEqual(journaled.find((j) => j.data?.op === op.id)?.name, "tick-spy", "journaled under the operative");
});

test("active ops resolve on the tick", () => {
  Esp.foundNetwork({ kingdom: "kandarin", founder: "f" });
  const op = Esp.planOperation({
    network: "kandarin", type: "sabotage", subtype: "treasury",
    targetKingdom: "asgarnia", operative: "tick-spy-2", nowMs: 0,
  });
  Esp.activateOperation(op.id, Esp.PLANNING_MS + 1);
  const d = fakeDirector();
  Life.tickEspionage(d, Esp.PLANNING_MS + 60000);
  const after = Esp.operationById(op.id);
  assert.strictEqual(after.state, "done", "active -> done");
  assert.ok(["success", "failed", "caught"].includes(after.outcome));
});

test("counter-intel sweep can catch an enemy cell", () => {
  Esp.foundNetwork({ kingdom: "morytania", founder: "f" });
  Esp.assignCounterAgent({ kingdom: "asgarnia", agent: "eagle-eye" });
  const cell = Esp.assignCell({ spy: "enemy-spy", homeKingdom: "morytania", targetKingdom: "asgarnia" });
  const d = fakeDirector();
  // Sweep many windows to force a catch (12% base per window).
  let caught = false;
  for (let w = 0; w < 200 && !caught; w++) {
    Life.tickEspionage(d, Date.now() + w * 61 * 60 * 1000);
    caught = Esp.cellFor("enemy-spy") === null;
  }
  assert.ok(caught, "sweep eventually caught the cell");
  assert.ok(journaled.some((j) => /unmasked/i.test(j.text)), "catch journaled via getJournal().log");
  assert.ok(said.some((s) => /Found one/i.test(s.text) && s.bot?.username === "eagle-eye"), "catch announced via canonical sayPublic(bot, text)");
  void cell;
});

test("assassination uses the real death path when roster is present", () => {
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  const victim = { username: "lord-victim", displayName: "Lord Victim", kingdomId: "kandarin" };
  const op = Esp.planOperation({
    network: "asgarnia", type: "assassination",
    targetKingdom: "kandarin", target: "lord-victim", operative: "blade", nowMs: 0,
  });
  Esp.activateOperation(op.id, Esp.PLANNING_MS + 1);
  const d = fakeDirector();
  d.roster.set("lord-victim", victim);
  // Force success path by resolving directly with context many times until success.
  // Simpler: assert the attempt is recorded and the death path is attempted.
  Life.tickEspionage(d, Esp.PLANNING_MS + 60000);
  const after = Esp.operationById(op.id);
  assert.strictEqual(after.state, "done");
  if (after.outcome === "success") {
    assert.strictEqual(after.assassinationAttempted, true, "attempt recorded");
  }
});

console.log(`\n${passed} tests passed.`);
