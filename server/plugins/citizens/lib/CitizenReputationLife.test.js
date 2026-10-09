"use strict";

/**
 * CitizenReputationLife.test.js — slow-tick tests.
 * Uses stub directors; never touches the real engine.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const Rep = require("./CitizenReputation");
const { tickReputation, maybeBardSong } = require("./CitizenReputationLife");

let tmpFile;

function stubDirector(records) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  return {
    roster,
    isOnline: () => true,
    getBot: (record) => ({ username: record.username }),
    getPlayer: () => null,
    players: new Map(),
    log: () => {},
  };
}

beforeEach(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "replife-test-")), "rep.json");
  Rep._setSavePathForTests(tmpFile);
  Rep.resetForTests();
  // NOTE: no jest.resetModules() — CitizenReputation is a singleton by
  // design; resetting modules would give the tick a different instance
  // than the test asserts against.
});

describe("tickReputation", () => {
  test("never throws on an empty/broken director", () => {
    expect(() => tickReputation(null)).not.toThrow();
    expect(() => tickReputation({})).not.toThrow();
    expect(() => tickReputation({ roster: { values: () => { throw new Error("x"); } } })).not.toThrow();
  });

  test("decays reputation over time", () => {
    Rep.addReputation("Alice", 10, "t");
    const director = stubDirector([{ username: "Alice" }]);
    const future = Date.now() + 2 * 24 * 3600 * 1000;
    tickReputation(director, future);
    expect(Rep.reputationFor("Alice")).toBe(9);
  });

  test("skill mastery awards reputation once per threshold", () => {
    const record = { username: "Bob" };
    const director = stubDirector([record]);
    // Bot with level-55 skills via getSkills().getLevel().
    director.getBot = () => ({
      username: "Bob",
      getSkills: () => ({ getLevel: () => 55 }),
    });
    tickReputation(director, Date.now());
    expect(Rep.reputationFor("Bob")).toBe(5); // skill_mastery deed
    expect(record.reputationMasterySeen["mastery:50"]).toBe(true);
    // Second tick: no double award (decay may shave a point, but no +5).
    const afterFirst = Rep.reputationFor("Bob");
    tickReputation(director, Date.now());
    expect(Rep.reputationFor("Bob")).toBeLessThanOrEqual(afterFirst);
    expect(Rep.reputationFor("Bob")).toBeGreaterThanOrEqual(afterFirst - 1);
  });

  test("tier watermark updates without announcement for quiet tiers", () => {
    Rep.addReputation("Carol", 5, "t"); // unknown tier
    const director = stubDirector([{ username: "Carol" }]);
    tickReputation(director, Date.now());
    expect(Rep.announcedTierFor("Carol")).toBe("unknown");
  });

  test("famous tier crossing marks announced", () => {
    Rep.addReputation("Dave", 50, "t"); // famous
    const director = stubDirector([{ username: "Dave" }]);
    // No real player nearby -> no sayPublic, but the watermark still moves.
    tickReputation(director, Date.now());
    expect(Rep.announcedTierFor("Dave")).toBe("famous");
  });
});

describe("maybeBardSong", () => {
  test("returns false with no bards or no famous citizens", () => {
    const director = stubDirector([{ username: "Erin", career: "bard" }]);
    expect(maybeBardSong(director, Date.now())).toBe(false);
    Rep.addReputation("Famous", 80, "t");
    const noBards = stubDirector([{ username: "Gail", career: "cook" }]);
    expect(maybeBardSong(noBards, Date.now())).toBe(false);
  });

  test("never throws on broken input", () => {
    expect(() => maybeBardSong(null)).not.toThrow();
    expect(() => maybeBardSong({})).not.toThrow();
  });
});
