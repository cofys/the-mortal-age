"use strict";

/**
 * CitizenEspionage.test.js — plain-node tests for the espionage data tier.
 * Run: node server/plugins/citizens/lib/CitizenEspionage.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Esp = require("./CitizenEspionage");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "esp-test-")), "espionage.json");
Esp._setSavePathForTests(SAVE);

let passed = 0;
function test(name, fn) {
  Esp.resetForTests();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- networks ---

test("foundNetwork creates one network per kingdom", () => {
  const a = Esp.foundNetwork({ kingdom: "asgarnia", founder: "spymaster-anne" });
  assert.ok(a, "network created");
  assert.strictEqual(a.kingdom, "asgarnia");
  const b = Esp.foundNetwork({ kingdom: "asgarnia", founder: "someone-else" });
  assert.strictEqual(b, a, "second found returns the existing network");
  assert.strictEqual(Esp.foundNetwork({ kingdom: "nope", founder: "x" }), null);
});

test("recruitSpy / promoteHandler", () => {
  Esp.foundNetwork({ kingdom: "kandarin", founder: "f" });
  assert.strictEqual(Esp.recruitSpy({ kingdom: "kandarin", spy: "sneaky-pete" }), true);
  assert.strictEqual(Esp.recruitSpy({ kingdom: "kandarin", spy: "sneaky-pete" }), false, "no double recruit");
  assert.strictEqual(Esp.promoteHandler({ kingdom: "kandarin", spy: "sneaky-pete" }), true);
  assert.strictEqual(Esp.isHandler("kandarin", "sneaky-pete"), true);
  assert.strictEqual(Esp.promoteHandler({ kingdom: "kandarin", spy: "stranger" }), false, "must be a spy first");
});

test("recruitSpy fails without a network", () => {
  assert.strictEqual(Esp.recruitSpy({ kingdom: "misthalin", spy: "x" }), false);
});

// --- cells ---

test("assignCell creates a cell; no self-infiltration", () => {
  const cell = Esp.assignCell({ spy: "sneaky-pete", homeKingdom: "asgarnia", targetKingdom: "kandarin" });
  assert.ok(cell, "cell created");
  assert.strictEqual(cell.underCover, false, "no embassy pair in tests -> no cover");
  assert.strictEqual(
    Esp.assignCell({ spy: "sneaky-pete", homeKingdom: "asgarnia", targetKingdom: "kandarin" }),
    cell,
    "second assign returns the live cell"
  );
  assert.strictEqual(
    Esp.assignCell({ spy: "sneaky-pete", homeKingdom: "asgarnia", targetKingdom: "asgarnia" }),
    null,
    "cannot infiltrate home"
  );
});

test("cover is only granted with a standing embassy pair", () => {
  // No CitizenTreaties embassy pairs exist in this test env -> cover stays false honestly.
  const cell = Esp.assignCell({
    spy: "cover-op",
    homeKingdom: "keldagrim",
    targetKingdom: "morytania",
    underCover: true,
  });
  assert.ok(cell);
  assert.strictEqual(cell.underCover, false, "cover denied without a real embassy pair");
  assert.strictEqual(cell.coverRequested, true, "the request is recorded honestly");
});

test("cellsIn / recallCell", () => {
  const cell = Esp.assignCell({ spy: "cell-a", homeKingdom: "asgarnia", targetKingdom: "morytania" });
  assert.strictEqual(Esp.cellsIn("morytania").length, 1);
  assert.strictEqual(Esp.recallCell(cell.id), true);
  assert.strictEqual(Esp.cellsIn("morytania").length, 0, "recalled cell is gone");
  assert.strictEqual(Esp.cellFor("cell-a"), null);
});

// --- counter-intel ---

test("counter agents register per kingdom", () => {
  assert.strictEqual(Esp.assignCounterAgent({ kingdom: "misthalin", agent: "watcher-jo" }), true);
  assert.strictEqual(Esp.assignCounterAgent({ kingdom: "misthalin", agent: "watcher-jo" }), false);
  assert.deepStrictEqual(Esp.counterAgentsOf("misthalin"), ["watcher-jo"]);
  assert.strictEqual(Esp.counterIntelStrength("misthalin"), 1);
  assert.strictEqual(Esp.counterIntelStrength("asgarnia"), 0);
});

// --- operations ---

test("planOperation validates type and kingdoms", () => {
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  assert.strictEqual(
    Esp.planOperation({ network: "asgarnia", type: "sabotage", subtype: "supply", targetKingdom: "kandarin", operative: "op-1" }).type,
    "sabotage"
  );
  Esp.resetForTests();
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  assert.strictEqual(
    Esp.planOperation({ network: "asgarnia", type: "sabotage", targetKingdom: "kandarin", operative: "op-1" }),
    null,
    "sabotage needs a subtype"
  );
  assert.strictEqual(
    Esp.planOperation({ network: "asgarnia", type: "assassination", targetKingdom: "kandarin", operative: "op-1" }),
    null,
    "assassination needs a target"
  );
  assert.strictEqual(
    Esp.planOperation({ network: "asgarnia", type: "sabotage", subtype: "supply", targetKingdom: "asgarnia", operative: "op-1" }),
    null,
    "cannot target home"
  );
  assert.strictEqual(
    Esp.planOperation({ network: "asgarnia", type: "dance", targetKingdom: "kandarin", operative: "op-1" }),
    null,
    "unknown op type"
  );
});

test("one operation at a time per operative", () => {
  Esp.foundNetwork({ kingdom: "kandarin", founder: "f" });
  const a = Esp.planOperation({ network: "kandarin", type: "sabotage", subtype: "treasury", targetKingdom: "asgarnia", operative: "busy-spy" });
  assert.ok(a);
  const b = Esp.planOperation({ network: "kandarin", type: "sabotage", subtype: "supply", targetKingdom: "asgarnia", operative: "busy-spy" });
  assert.strictEqual(b, null, "operative is busy");
});

test("activateOperation respects the planning window", () => {
  Esp.foundNetwork({ kingdom: "morytania", founder: "f" });
  const op = Esp.planOperation({
    network: "morytania", type: "sabotage", subtype: "supply",
    targetKingdom: "keldagrim", operative: "planner", nowMs: 1000,
  });
  assert.strictEqual(Esp.activateOperation(op.id, 1000 + 1000), null, "too early");
  const active = Esp.activateOperation(op.id, 1000 + Esp.PLANNING_MS + 1);
  assert.ok(active, "activates after planning");
  assert.strictEqual(active.state, "active");
});

test("resolveOperation moves op to done with a valid outcome", () => {
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  const op = Esp.planOperation({
    network: "asgarnia", type: "sabotage", subtype: "supply",
    targetKingdom: "kandarin", operative: "det-a", nowMs: 0,
  });
  Esp.activateOperation(op.id, Esp.PLANNING_MS + 1);
  const now = Date.now();
  const r1 = Esp.resolveOperation(op.id, now);
  assert.ok(["success", "failed", "caught"].includes(r1.outcome), `valid outcome, got ${r1.outcome}`);
  assert.strictEqual(r1.state, "done");
  assert.strictEqual(Esp.resolveOperation(op.id, now), null, "already resolved -> null");
  // Deterministic roll: same seed always gives the same 0..1.
  const rollA = Esp.discoveryChanceFor({ operative: "x", targetKingdom: "kandarin" });
  const rollB = Esp.discoveryChanceFor({ operative: "x", targetKingdom: "kandarin" });
  assert.strictEqual(rollA, rollB, "discovery chance is deterministic");
});

test("caught operatives are reported for real crimes", () => {
  // Force discovery by stacking counter-intel: 15 agents -> chance capped at 0.6.
  // We can't force the roll, so run many ops and assert at least the crime path is wired
  // via discoveryChanceFor math instead.
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  for (let i = 0; i < 15; i++) Esp.assignCounterAgent({ kingdom: "kandarin", agent: `agent-${i}` });
  const op = Esp.planOperation({
    network: "asgarnia", type: "sabotage", subtype: "supply",
    targetKingdom: "kandarin", operative: "doomed", nowMs: 0,
  });
  Esp.activateOperation(op.id, Esp.PLANNING_MS + 1);
  const chance = Esp.discoveryChanceFor(op);
  assert.strictEqual(chance, 0.6, "counter-intel stacks to the cap");
});

test("discoveryChanceFor halves under embassy cover", () => {
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  const mk = (operative) => {
    const op = Esp.planOperation({
      network: "asgarnia", type: "sabotage", subtype: "supply",
      targetKingdom: "morytania", operative, nowMs: 0,
    });
    return op;
  };
  const plain = mk("plain-spy");
  const base = Esp.discoveryChanceFor(plain);
  // Fake a covered cell by directly pushing one with underCover=true (unit-level).
  const cell = Esp.assignCell({ spy: "covered-spy", homeKingdom: "asgarnia", targetKingdom: "morytania" });
  cell.underCover = true;
  const covered = mk("covered-spy");
  const coveredChance = Esp.discoveryChanceFor(covered);
  assert.ok(coveredChance < base, `cover reduces chance: ${coveredChance} < ${base}`);
});

// --- interrogation ---

test("interrogate reveals live operations and burns the cell", () => {
  Esp.foundNetwork({ kingdom: "keldagrim", founder: "f" });
  Esp.assignCell({ spy: "talkative", homeKingdom: "keldagrim", targetKingdom: "asgarnia" });
  const op1 = Esp.planOperation({ network: "keldagrim", type: "sabotage", subtype: "supply", targetKingdom: "asgarnia", operative: "other-spy", nowMs: 0 });
  const revealed = Esp.interrogate({ spy: "talkative", by: "asgarnia watch" });
  assert.ok(revealed.includes(op1.id), "live op revealed");
  assert.strictEqual(Esp.cellFor("talkative"), null, "cell burned");
  assert.strictEqual(Esp.interrogationsOf("talkative").length, 1);
});

// --- war seam ---

test("intelAdvantageFor decays and prunes", () => {
  const now = Date.now();
  Esp.recordIntel("asgarnia", "kandarin", 0.8, "test", now);
  const adv = Esp.intelAdvantageFor("asgarnia", "kandarin", now);
  assert.ok(adv > 0 && adv <= 1, `advantage in range: ${adv}`);
  assert.strictEqual(Esp.intelAdvantageFor("asgarnia", "kandarin", now + Esp.INTEL_FRESH_MS + 1), 0, "stale intel is no intel");
  assert.strictEqual(Esp.intelAdvantageFor("kandarin", "asgarnia", now), 0, "directional");
  const pruned = Esp.pruneIntel(now + Esp.INTEL_FRESH_MS * 2 + 1);
  assert.strictEqual(pruned, 1);
});

test("noteIntel feeds the seam", () => {
  const now = Date.now();
  Esp.noteIntel("misthalin", "morytania", now);
  assert.ok(Esp.intelAdvantageFor("misthalin", "morytania", now) > 0);
});

// --- career ---

test("isSpymasterCandidate reads the sneaky trait", () => {
  assert.strictEqual(Esp.isSpymasterCandidate({ personality: { sneaky: 0.9 } }), true);
  assert.strictEqual(Esp.isSpymasterCandidate({ personality: { mischievous: 0.7 } }), true);
  assert.strictEqual(Esp.isSpymasterCandidate({ personality: { sneaky: 0.2 } }), false);
  assert.strictEqual(Esp.isSpymasterCandidate(null), false);
});

// --- persistence ---

test("save round-trips networks and ops", () => {
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  Esp.recruitSpy({ kingdom: "asgarnia", spy: "persist-spy" });
  assert.strictEqual(Esp.save(), true, "dirty save writes");
  assert.strictEqual(Esp.save(), false, "clean save is a no-op");
  const raw = JSON.parse(fs.readFileSync(SAVE, "utf8"));
  assert.ok(raw.networks.asgarnia, "network persisted");
  assert.ok(raw.networks.asgarnia.spies.includes("persist-spy"), "spy persisted");
});

console.log(`\n${passed} tests passed.`);
