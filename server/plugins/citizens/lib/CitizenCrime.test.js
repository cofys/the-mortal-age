"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const os = require("os");
const path = require("path");

const Crime = require("./CitizenCrime");

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  Crime._setSavePathForTests(path.join(os.tmpdir(), `citizen-crime-test-${process.pid}.json`));
  Crime.resetForTests();
});

describe("CitizenCrime — crime catalog", () => {
  it("defines theft, assault, vandalism, curfew-violation with severities", () => {
    assert.deepEqual([...Crime.CRIME_KEYS].sort(), ["assault", "curfew-violation", "theft", "vandalism"]);
    assert.equal(Crime.crimeDef("theft").severity, 2);
    assert.equal(Crime.crimeDef("assault").severity, 3);
    assert.equal(Crime.crimeDef("vandalism").severity, 2);
    assert.equal(Crime.crimeDef("curfew-violation").severity, 1);
  });

  it("rejects unknown crime kinds", () => {
    assert.equal(Crime.crimeDef("dragonpox"), null);
    assert.equal(Crime.reportOffense("Alice", "dragonpox", { nowMs: NOW }), null);
    assert.deepEqual(Crime.crimeHistory("Alice"), []);
  });
});

describe("CitizenCrime — offense records", () => {
  it("reportOffense records the crime with evidence", () => {
    const rec = Crime.reportOffense("Alice", "theft", {
      nowMs: NOW,
      witnessed: true,
      kingdomId: "varrock",
      victim: "Bob",
    });
    assert.ok(rec);
    assert.equal(rec.kind, "theft");
    assert.equal(rec.severity, 2);
    assert.equal(rec.witnessed, true);
    assert.equal(rec.victim, "Bob");
    const hist = Crime.crimeHistory("Alice");
    assert.equal(hist.length, 1);
  });

  it("reportOffense degrades silently when the guard module is missing", () => {
    // The wanted-list report is best-effort; the record must land anyway.
    const rec = Crime.reportOffense("Zed", "vandalism", { nowMs: NOW });
    assert.ok(rec);
    assert.equal(Crime.crimeHistory("Zed").length, 1);
  });

  it("criminalSummary is null when clean, shaped after a crime", () => {
    assert.equal(Crime.criminalSummary("Alice"), null);
    Crime.reportOffense("Alice", "theft", { nowMs: NOW, witnessed: true });
    const s = Crime.criminalSummary("Alice");
    assert.equal(s.offenses, 1);
    assert.equal(s.convictions, 0);
    assert.equal(s.lastCrime, "theft");
    assert.ok(s.notoriety > 0);
  });
});

describe("CitizenCrime — notoriety", () => {
  it("starts at 0 and rises with severity", () => {
    assert.equal(Crime.notorietyFor("Alice", NOW), 0);
    Crime.reportOffense("Alice", "theft", { nowMs: NOW }); // severity 2 -> 24
    assert.equal(Crime.notorietyFor("Alice", NOW), 24);
  });

  it("decays over 30 days and caps at 100", () => {
    Crime.reportOffense("Alice", "assault", { nowMs: NOW - 31 * DAY });
    assert.equal(Crime.notorietyFor("Alice", NOW), 0); // fully decayed
    for (let i = 0; i < 10; i++) Crime.reportOffense("Bob", "assault", { nowMs: NOW });
    assert.equal(Crime.notorietyFor("Bob", NOW), 100); // capped
  });

  it("convictions add a lasting stain", () => {
    Crime.reportOffense("Alice", "theft", { nowMs: NOW - 40 * DAY }); // decayed
    Crime.convict("Alice", "theft", NOW);
    assert.ok(Crime.notorietyFor("Alice", NOW) >= 15);
  });
});

describe("CitizenCrime — prisons and jail", () => {
  it("ensurePrison creates an 8-cell gaol per kingdom", () => {
    const p = Crime.ensurePrison("varrock");
    assert.equal(p.cells, 8);
    assert.deepEqual(Crime.inmatesOfKingdom("varrock"), []);
  });

  it("imprison locks the citizen up; isJailed is true until release", () => {
    Crime.imprison("Alice", "varrock", NOW + 2 * DAY, "theft", "Alice");
    assert.equal(Crime.isJailed("Alice", NOW), true);
    assert.equal(Crime.jailPenaltyFor("Alice", NOW), 60);
    assert.equal(Crime.inmatesOfKingdom("varrock").length, 1);
  });

  it("imprison refuses when the gaol is full", () => {
    for (let i = 0; i < 8; i++) Crime.imprison(`Crook${i}`, "varrock", NOW + DAY, "theft");
    assert.equal(Crime.imprison("Alice", "varrock", NOW + DAY, "theft"), false);
  });

  it("release frees the citizen and clears the penalty", () => {
    Crime.imprison("Alice", "varrock", NOW + 2 * DAY, "theft");
    Crime.release("Alice");
    assert.equal(Crime.isJailed("Alice", NOW), false);
    assert.equal(Crime.jailPenaltyFor("Alice", NOW), 0);
    assert.deepEqual(Crime.inmatesOfKingdom("varrock"), []);
  });

  it("expired sentences read as free even before the tick releases them", () => {
    Crime.imprison("Alice", "varrock", NOW - 1000, "theft");
    assert.equal(Crime.isJailed("Alice", NOW), false);
  });
});

describe("CitizenCrime — sentencing", () => {
  it("first petty offense draws a fine, not jail", () => {
    const s = Crime.convict("Alice", "curfew-violation", NOW);
    assert.equal(s.type, "fine");
    assert.ok(s.fine > 0);
    assert.equal(Crime.convictionCount("Alice"), 1);
  });

  it("serious crimes draw jail; third serious conviction draws exile", () => {
    const s1 = Crime.convict("Bob", "assault", NOW);
    assert.equal(s1.type, "jail");
    const s2 = Crime.convict("Bob", "assault", NOW);
    assert.equal(s2.type, "jail");
    const s3 = Crime.convict("Bob", "assault", NOW);
    assert.equal(s3.type, "exile");
  });

  it("applyFine takes real coins when online, debts the rest", () => {
    const coins = { amount: 50 };
    const player = {
      getInventory: () => ({
        getAmount: () => coins.amount,
        deleteNumber: (id, n) => { coins.amount -= n; },
        adds: (id, n) => { coins.amount += n; },
      }),
    };
    const r = Crime.applyFine("Alice", 120, player);
    assert.equal(r.paid, 50);
    assert.equal(r.debted, 70);
    assert.equal(coins.amount, 0);
    const rec = Crime.recordOf("Alice");
    assert.equal(rec.fineDebt, 70);
  });

  it("offline criminals accrue fine debt, capped", () => {
    const r = Crime.applyFine("Alice", 5000, null);
    assert.equal(r.paid, 0);
    assert.equal(r.debted, 5000);
    assert.ok(Crime.recordOf("Alice").fineDebt <= 2000);
  });

  it("exile marks the citizen; pardon lifts it", () => {
    Crime.exileCitizen("Alice", "varrock", NOW);
    assert.equal(Crime.isExiled("Alice"), true);
    assert.equal(Crime.pardon("Alice"), true);
    assert.equal(Crime.isExiled("Alice"), false);
  });
});

describe("CitizenCrime — persistence", () => {
  it("save writes the file and reload keeps records", () => {
    Crime.reportOffense("Alice", "theft", { nowMs: NOW });
    assert.equal(Crime.save(), true);
    Crime.resetForTests();
    // Re-point at the same test file (resetForTests clears the override)
    Crime._setSavePathForTests(path.join(os.tmpdir(), `citizen-crime-test-${process.pid}.json`));
    assert.equal(Crime.crimeHistory("Alice").length, 1);
  });
});
