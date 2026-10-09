"use strict";

/**
 * CitizenLegalCode.test.js — data-tier tests for the legal system.
 * Plain node asserts (no jest/babel) so they run anywhere.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LegalCode = require("./CitizenLegalCode");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legalcode-test-"));
  const savePath = path.join(dir, "citizen-legalcode.json");
  LegalCode._setSavePathForTests(savePath);
  LegalCode.resetForTests();
  return { dir, savePath };
}

let passed = 0;
function test(name, fn) {
  try {
    freshStore();
    fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("CitizenLegalCode tests:");

// --- statutes ---------------------------------------------------------------

test("sentenceFor returns base penalty without laws", () => {
  const s = LegalCode.sentenceFor("varrock", "theft", 0, Date.now());
  assert.ok(s.fine > 0, "theft has a base fine");
  assert.ok(s.jailDays >= 1, "theft has jail days");
  assert.strictEqual(s.victimRestitution, 0, "no restitution without the law");
});

test("sentenceFor scales fines with priors", () => {
  const base = LegalCode.sentenceFor("varrock", "theft", 0, Date.now());
  const repeat = LegalCode.sentenceFor("varrock", "theft", 2, Date.now());
  assert.ok(repeat.fine > base.fine, "repeat offenders pay more");
});

test("sentenceFor handles unknown crime kinds defensively", () => {
  const s = LegalCode.sentenceFor("varrock", "not-a-crime", 0, Date.now());
  assert.ok(s.fine > 0, "falls back to a default fine");
  assert.ok(s.jailDays >= 0, "jail days defined");
});

// --- judges -------------------------------------------------------------------

test("assignJudge and judgeFor round-trip", () => {
  const now = Date.now();
  LegalCode.assignJudge("varrock", "Judge Judy", now);
  const j = LegalCode.judgeFor("varrock", now);
  assert.ok(j, "judge found");
  assert.strictEqual(j.username, "Judge Judy");
  assert.ok(j.fairness >= 0 && j.fairness <= 1, "fairness in range");
});

test("judgeFor returns null when no judge assigned", () => {
  assert.strictEqual(LegalCode.judgeFor("falador", Date.now()), null);
});

test("judge term expires after 30 days", () => {
  const now = Date.now();
  LegalCode.assignJudge("varrock", "Judge Judy", now - 31 * 24 * 60 * 60 * 1000);
  assert.strictEqual(LegalCode.judgeFor("varrock", now), null, "expired term");
});

test("clearJudge removes the judge", () => {
  const now = Date.now();
  LegalCode.assignJudge("varrock", "Judge Judy", now);
  LegalCode.clearJudge("varrock");
  assert.strictEqual(LegalCode.judgeFor("varrock", now), null);
});

// --- lawyers ---------------------------------------------------------------------

test("hireLawyer and lawyerFor round-trip", () => {
  const rep = LegalCode.hireLawyer("Accused Al", "Lawyer Larry", Date.now(), true);
  assert.ok(rep, "representation recorded");
  assert.strictEqual(rep.lawyer, "Lawyer Larry");
  assert.strictEqual(rep.feePaid, true);
  const found = LegalCode.lawyerFor("Accused Al");
  assert.strictEqual(found.lawyer, "Lawyer Larry");
});

test("lawyerFor returns null when unrepresented", () => {
  assert.strictEqual(LegalCode.lawyerFor("Innocent Ian"), null);
});

test("defenseBonusFor is 0.15 when represented, 0 otherwise", () => {
  assert.strictEqual(LegalCode.defenseBonusFor("Nobody"), 0);
  LegalCode.hireLawyer("Accused Al", "Lawyer Larry", Date.now(), true);
  assert.strictEqual(LegalCode.defenseBonusFor("Accused Al"), LegalCode.LAWYER_DEFENSE_BONUS);
});

test("clearLawyer ends representation", () => {
  LegalCode.hireLawyer("Accused Al", "Lawyer Larry", Date.now(), true);
  LegalCode.clearLawyer("Accused Al");
  assert.strictEqual(LegalCode.lawyerFor("Accused Al"), null);
});

test("representationCount counts active cases", () => {
  assert.strictEqual(LegalCode.representationCount(), 0);
  LegalCode.hireLawyer("A", "L1", Date.now(), true);
  LegalCode.hireLawyer("B", "L2", Date.now(), false);
  assert.strictEqual(LegalCode.representationCount(), 2);
});

// --- appeals ----------------------------------------------------------------------

test("fileAppeal records a pending appeal", () => {
  const a = LegalCode.fileAppeal("Convicted Carl", "theft", Date.now(), true);
  assert.ok(a, "appeal filed");
  assert.strictEqual(a.status, "pending");
  assert.strictEqual(LegalCode.pendingAppeals(Date.now()).length, 1);
});

test("fileAppeal rejects duplicate pending appeals", () => {
  LegalCode.fileAppeal("Convicted Carl", "theft", Date.now(), true);
  const dup = LegalCode.fileAppeal("Convicted Carl", "theft", Date.now(), true);
  assert.strictEqual(dup, null, "no duplicate pending appeal");
});

test("resolveAppeal overturns and upholds", () => {
  const now = Date.now();
  LegalCode.fileAppeal("Carl", "theft", now, true);
  const over = LegalCode.resolveAppeal("Carl", true, now);
  assert.strictEqual(over.status, "overturned");
  assert.strictEqual(LegalCode.pendingAppeals(now).length, 0);

  LegalCode.fileAppeal("Dave", "theft", now, true);
  const up = LegalCode.resolveAppeal("Dave", false, now);
  assert.strictEqual(up.status, "upheld");
});

test("expired appeals leave the pending list", () => {
  const now = Date.now();
  const old = now - 8 * 24 * 60 * 60 * 1000; // 8 days ago
  LegalCode.fileAppeal("Old Ollie", "theft", old, true);
  assert.strictEqual(LegalCode.pendingAppeals(now).length, 0, "expired appeal not pending");
});

// --- pardons ------------------------------------------------------------------------

test("requestPardon records a pending pardon", () => {
  const p = LegalCode.requestPardon("Convicted Carl", "Wife Wendy", Date.now(), true);
  assert.ok(p, "pardon requested");
  assert.strictEqual(p.status, "pending");
  assert.strictEqual(LegalCode.pendingPardons().length, 1);
});

test("requestPardon rejects duplicates", () => {
  LegalCode.requestPardon("Carl", null, Date.now(), false);
  assert.strictEqual(LegalCode.requestPardon("Carl", null, Date.now(), false), null);
});

test("grantPardon and denyPardon resolve", () => {
  const now = Date.now();
  LegalCode.requestPardon("Carl", null, now, false);
  const g = LegalCode.grantPardon("Carl", now);
  assert.strictEqual(g.status, "granted");
  assert.strictEqual(LegalCode.pendingPardons().length, 0);

  LegalCode.requestPardon("Dave", null, now, false);
  const d = LegalCode.denyPardon("Dave", now);
  assert.strictEqual(d.status, "denied");
});

// --- player accusations ----------------------------------------------------------------

test("accusePlayer records a pending accusation", () => {
  const a = LegalCode.accusePlayer("Player Pete", "theft", "Guard Gary", Date.now());
  assert.ok(a, "accusation recorded");
  assert.strictEqual(a.status, "pending");
  assert.strictEqual(LegalCode.pendingPlayerAccusations().length, 1);
});

test("accusePlayer dedupes same player+kind", () => {
  const now = Date.now();
  LegalCode.accusePlayer("Player Pete", "theft", "Guard Gary", now);
  const dup = LegalCode.accusePlayer("Player Pete", "theft", "Guard Gary", now);
  assert.ok(dup, "returns existing");
  assert.strictEqual(LegalCode.pendingPlayerAccusations().length, 1);
});

test("resolvePlayerAccusation records verdict", () => {
  const now = Date.now();
  LegalCode.accusePlayer("Player Pete", "theft", "Guard Gary", now);
  const r = LegalCode.resolvePlayerAccusation("Player Pete", "theft", "guilty", now);
  assert.strictEqual(r.status, "guilty");
  assert.strictEqual(LegalCode.pendingPlayerAccusations().length, 0);
});

// --- persistence ------------------------------------------------------------------------

test("save and reload round-trip", () => {
  const { savePath } = freshStore();
  const now = Date.now();
  LegalCode.assignJudge("varrock", "Judge Judy", now);
  LegalCode.hireLawyer("Accused Al", "Lawyer Larry", now, true);
  LegalCode.fileAppeal("Carl", "theft", now, true);
  assert.ok(LegalCode.save(), "saved");
  assert.ok(fs.existsSync(savePath), "save file exists");

  LegalCode.resetForTests(); // drops the cache
  const j = LegalCode.judgeFor("varrock", now);
  assert.ok(j, "judge reloaded from disk");
  assert.strictEqual(j.username, "Judge Judy");
});

test("tuning constants are exported", () => {
  assert.strictEqual(LegalCode.LAWYER_FEE, 150);
  assert.strictEqual(LegalCode.APPEAL_FEE, 100);
  assert.strictEqual(LegalCode.PARDON_REPUTATION_THRESHOLD, 40);
  assert.strictEqual(LegalCode.JUDGE_REPUTATION_MIN, 20);
});

console.log(`\n${passed} tests passed.`);
