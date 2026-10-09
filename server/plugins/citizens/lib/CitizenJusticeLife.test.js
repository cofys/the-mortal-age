"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const os = require("os");
const path = require("path");

const Crime = require("./CitizenCrime");
const Justice = require("./CitizenJusticeLife");
const Guards = require("./CitizenGuards");

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;

const savePath = path.join(os.tmpdir(), `citizen-justice-test-${process.pid}.json`);

beforeEach(() => {
  Crime._setSavePathForTests(savePath);
  Crime.resetForTests();
});

function record(username, traits, extra = {}) {
  return {
    username,
    displayName: username,
    kingdomId: "varrock",
    personality: { traits },
    role: "commoner",
    ...extra,
  };
}

// rng that always returns just under 1: rolls succeed only at p ~ 1.
const hiRng = () => 0.999999;
// rng that always returns 0: every chance roll succeeds.
const loRng = () => 0;

describe("CitizenJusticeLife — crime onset", () => {
  it("honest citizens never commit crimes", () => {
    const recs = [record("Alice", ["honest", "kind"])];
    Justice._phaseOnset({}, recs, NOW, loRng);
    assert.deepEqual(Crime.crimeHistory("Alice"), []);
  });

  it("criminal-leaning citizens commit crimes when the roll succeeds", () => {
    const recs = [record("Sneaky", ["sneaky", "greedy"])];
    Justice._phaseOnset({}, recs, NOW, loRng);
    assert.ok(Crime.crimeHistory("Sneaky").length >= 1);
  });

  it("jailed and exiled citizens commit no crimes", () => {
    Crime.imprison("Alice", "varrock", NOW + DAY, "theft");
    Crime.exileCitizen("Bob", "varrock", NOW);
    const recs = [record("Alice", ["sneaky"]), record("Bob", ["violent"])];
    Justice._phaseOnset({}, recs, NOW, loRng);
    assert.deepEqual(Crime.crimeHistory("Alice"), []);
    assert.deepEqual(Crime.crimeHistory("Bob"), []);
  });

  it("with a failing rng, nobody commits crimes", () => {
    const recs = [record("Sneaky", ["sneaky", "desperate", "reckless"])];
    Justice._phaseOnset({}, recs, NOW, hiRng);
    assert.deepEqual(Crime.crimeHistory("Sneaky"), []);
  });
});

describe("CitizenJusticeLife — trials and punishments", () => {
  it("a witnessed theft goes: wanted -> trial -> guilty -> fine", () => {
    const recs = [record("Thief", ["sneaky"])];
    Crime.reportOffense("Thief", "theft", { nowMs: NOW, witnessed: true, kingdomId: "varrock" });
    assert.equal(Guards.isWanted("Thief", NOW), true);

    const verdicts = Justice._phaseTrials({}, recs, NOW, loRng); // loRng: guilty
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].username, "Thief");
    assert.equal(verdicts[0].sentence.type, "fine");
    // Sentenced: the wanted entry is cleared.
    assert.equal(Guards.isWanted("Thief", NOW), false);

    Justice._phasePunishments({}, verdicts, NOW);
    assert.equal(Crime.convictionCount("Thief"), 1);
    // Offline: the fine becomes debt.
    assert.ok(Crime.recordOf("Thief").fineDebt > 0);
  });

  it("an acquittal clears the wanted entry with no conviction", () => {
    const recs = [record("Innocent", ["honest"])];
    Crime.reportOffense("Innocent", "theft", { nowMs: NOW, witnessed: false, kingdomId: "varrock" });
    const verdicts = Justice._phaseTrials({}, recs, NOW, hiRng); // hiRng: not guilty
    assert.deepEqual(verdicts, []);
    assert.equal(Crime.convictionCount("Innocent"), 0);
    assert.equal(Guards.isWanted("Innocent", NOW), false);
  });

  it("a serious repeat offender is gaoled, not fined", () => {
    const recs = [record("Brute", ["violent"])];
    Crime.reportOffense("Brute", "assault", { nowMs: NOW, witnessed: true, kingdomId: "varrock" });
    const verdicts = Justice._phaseTrials({}, recs, NOW, loRng);
    assert.equal(verdicts[0].sentence.type, "jail");
    Justice._phasePunishments({}, verdicts, NOW);
    assert.equal(Crime.isJailed("Brute", NOW), true);
    assert.equal(Crime.inmatesOfKingdom("varrock").length, 1);
  });

  it("a wanted citizen with no recorded crime is released, not tried", () => {
    const recs = [record("Framed", ["honest"])];
    Guards.reportCrime("mallory", "Framed", "theft", NOW);
    const verdicts = Justice._phaseTrials({}, recs, NOW, loRng);
    assert.deepEqual(verdicts, []);
    assert.equal(Guards.isWanted("Framed", NOW), false);
  });
});

describe("CitizenJusticeLife — jail releases", () => {
  it("expired sentences release the inmate", () => {
    Crime.imprison("Alice", "varrock", NOW - 1000, "theft", "Alice");
    Justice._phaseJail({}, NOW);
    assert.equal(Crime.isJailed("Alice", NOW), false);
    assert.deepEqual(Crime.inmatesOfKingdom("varrock"), []);
  });

  it("unexpired sentences keep the inmate inside", () => {
    Crime.imprison("Alice", "varrock", NOW + DAY, "theft", "Alice");
    Justice._phaseJail({}, NOW);
    assert.equal(Crime.isJailed("Alice", NOW), true);
  });
});

describe("CitizenJusticeLife — curfew", () => {
  it("does nothing during the day", () => {
    const noon = new Date(NOW);
    noon.setHours(12, 0, 0, 0);
    const bot = { getLocation: () => ({ getX: () => 1, getY: () => 2, getZ: () => 0 }) };
    const director = { getPlayer: () => bot, players: new Map() };
    const recs = [record("Owl", ["sneaky"])];
    Justice._phaseCurfew(director, recs, noon.getTime(), loRng);
    assert.deepEqual(Crime.crimeHistory("Owl"), []);
  });

  it("does nothing at night without a curfew law", () => {
    const night = new Date(NOW);
    night.setHours(23, 0, 0, 0);
    const bot = { getLocation: () => ({ getX: () => 1, getY: () => 2, getZ: () => 0 }) };
    const director = { getPlayer: () => bot, players: new Map() };
    const recs = [record("Owl", ["sneaky"])];
    Justice._phaseCurfew(director, recs, night.getTime(), loRng);
    // No curfew law active in varrock -> no violation possible.
    assert.deepEqual(Crime.crimeHistory("Owl"), []);
  });
});

describe("CitizenJusticeLife — tickJustice entry", () => {
  it("runs all phases without a director blowing up", () => {
    assert.doesNotThrow(() => Justice.tickJustice(null, NOW));
    assert.doesNotThrow(() => Justice.tickJustice({}, NOW));
    const director = { roster: new Map() };
    assert.doesNotThrow(() => Justice.tickJustice(director, NOW));
  });
});
