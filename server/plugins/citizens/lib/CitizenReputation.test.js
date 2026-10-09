"use strict";

/**
 * CitizenReputation.test.js — data-tier tests for reputation and fame.
 * Zero engine: exercises the module with the save path redirected to tmp.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const Rep = require("./CitizenReputation");

let tmpFile;

beforeEach(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rep-test-")), "rep.json");
  Rep._setSavePathForTests(tmpFile);
  Rep.resetForTests();
});

describe("tiers", () => {
  test("tierForScore maps boundaries", () => {
    expect(Rep.tierForScore(100)).toBe("legendary");
    expect(Rep.tierForScore(75)).toBe("legendary");
    expect(Rep.tierForScore(74)).toBe("famous");
    expect(Rep.tierForScore(40)).toBe("famous");
    expect(Rep.tierForScore(39)).toBe("known");
    expect(Rep.tierForScore(10)).toBe("known");
    expect(Rep.tierForScore(9)).toBe("unknown");
    expect(Rep.tierForScore(0)).toBe("unknown");
    expect(Rep.tierForScore(-9)).toBe("unknown");
    expect(Rep.tierForScore(-10)).toBe("disliked");
    expect(Rep.tierForScore(-39)).toBe("disliked");
    expect(Rep.tierForScore(-40)).toBe("notorious");
    expect(Rep.tierForScore(-74)).toBe("notorious");
    expect(Rep.tierForScore(-75)).toBe("infamous");
    expect(Rep.tierForScore(-100)).toBe("infamous");
  });

  test("tierLabel returns human labels", () => {
    expect(Rep.tierLabel("legendary")).toBe("legendary");
    expect(Rep.tierLabel("known")).toBe("well-known");
    expect(Rep.tierLabel("bogus")).toBe("unknown");
  });
});

describe("addReputation", () => {
  test("starts at 0 and accumulates", () => {
    expect(Rep.reputationFor("Alice")).toBe(0);
    Rep.addReputation("Alice", 10, "test");
    expect(Rep.reputationFor("Alice")).toBe(10);
    expect(Rep.fameTierFor("Alice")).toBe("known");
  });

  test("clamps to [-100, 100]", () => {
    Rep.addReputation("Bob", 500, "test");
    expect(Rep.reputationFor("Bob")).toBe(100);
    Rep.addReputation("Bob", -500, "test");
    expect(Rep.reputationFor("Bob")).toBe(-100);
  });

  test("ignores zero/NaN amounts and empty usernames", () => {
    expect(Rep.addReputation("Carol", 0, "test")).toBe(0);
    expect(Rep.addReputation("Carol", NaN, "test")).toBe(0);
    expect(Rep.addReputation("", 10, "test")).toBe(0);
    expect(Rep.reputationFor("Carol")).toBe(0);
  });

  test("name normalization is case-insensitive", () => {
    Rep.addReputation("Dave", 20, "test");
    expect(Rep.reputationFor("dave")).toBe(20);
    expect(Rep.reputationFor("DAVE")).toBe(20);
  });
});

describe("awardDeed", () => {
  test("catalogued deeds award the right points", () => {
    expect(Rep.awardDeed("Erin", "generosity")).toBe(3);
    expect(Rep.awardDeed("Erin", "heroism")).toBe(11);
    expect(Rep.awardDeed("Erin", "skill_mastery")).toBe(16);
    expect(Rep.awardDeed("Erin", "quest_hero")).toBe(26);
    expect(Rep.awardDeed("Erin", "betrayal")).toBe(20);
    expect(Rep.awardDeed("Erin", "cowardice")).toBe(16);
  });

  test("unknown deed kinds are no-ops", () => {
    expect(Rep.awardDeed("Frank", "bogus_deed")).toBe(0);
    expect(Rep.reputationFor("Frank")).toBe(0);
  });
});

describe("summary", () => {
  test("reputationSummary carries score, tier, label, deeds", () => {
    Rep.awardDeed("Gail", "quest_hero");
    Rep.awardDeed("Gail", "quest_hero");
    Rep.awardDeed("Gail", "quest_hero");
    Rep.awardDeed("Gail", "quest_hero");
    const s = Rep.reputationSummary("Gail");
    expect(s.score).toBe(40);
    expect(s.tier).toBe("famous");
    expect(s.tierLabel).toBe("famous");
    expect(s.recentDeeds.length).toBe(4);
  });
});

describe("modifiers", () => {
  test("salePriceModifierFor rewards fame, punishes infamy", () => {
    Rep.addReputation("Hank", 80, "test");
    expect(Rep.salePriceModifierFor("Hank")).toBe(1.15);
    Rep.addReputation("Ivy", 50, "test");
    expect(Rep.salePriceModifierFor("Ivy")).toBe(1.1);
    Rep.addReputation("Jed", 15, "test");
    expect(Rep.salePriceModifierFor("Jed")).toBe(1.05);
    Rep.addReputation("Kim", -15, "test");
    expect(Rep.salePriceModifierFor("Kim")).toBe(0.95);
    Rep.addReputation("Leo", -50, "test");
    expect(Rep.salePriceModifierFor("Leo")).toBe(0.9);
    Rep.addReputation("Mia", -80, "test");
    expect(Rep.salePriceModifierFor("Mia")).toBe(0.85);
    expect(Rep.salePriceModifierFor("Nobody")).toBe(1.0);
  });

  test("socialModifierFor mirrors the tier ladder", () => {
    Rep.addReputation("Hank", 80, "test");
    expect(Rep.socialModifierFor("Hank")).toBe(12);
    Rep.addReputation("Ivy", 50, "test");
    expect(Rep.socialModifierFor("Ivy")).toBe(8);
    Rep.addReputation("Jed", 15, "test");
    expect(Rep.socialModifierFor("Jed")).toBe(4);
    expect(Rep.socialModifierFor("Nobody")).toBe(0);
    Rep.addReputation("Kim", -15, "test");
    expect(Rep.socialModifierFor("Kim")).toBe(-4);
    Rep.addReputation("Leo", -50, "test");
    expect(Rep.socialModifierFor("Leo")).toBe(-8);
    Rep.addReputation("Mia", -80, "test");
    expect(Rep.socialModifierFor("Mia")).toBe(-12);
  });
});

describe("topFamous", () => {
  test("returns only known-and-above, sorted desc", () => {
    Rep.addReputation("A", 90, "t");
    Rep.addReputation("B", 45, "t");
    Rep.addReputation("C", 5, "t"); // unknown — excluded
    Rep.addReputation("D", -50, "t"); // notorious — excluded
    const top = Rep.topFamous(5);
    expect(top.map((r) => r.username)).toEqual(["A", "B"]);
    expect(top[0].tier).toBe("legendary");
    expect(top[1].tier).toBe("famous");
  });

  test("respects the limit", () => {
    for (let i = 0; i < 10; i++) Rep.addReputation(`P${i}`, 20 + i, "t");
    expect(Rep.topFamous(3).length).toBe(3);
  });
});

describe("decay", () => {
  test("decayOnce moves toward 0 once per day", () => {
    const now = Date.now();
    Rep.addReputation("Quinn", 10, "t");
    // lastDecay starts at 0 (long ago), so the first decay applies.
    expect(Rep.decayOnce("Quinn", now)).toBe(true);
    expect(Rep.reputationFor("Quinn")).toBe(9);
    // Same instant again: the daily gate blocks a second decay.
    expect(Rep.decayOnce("Quinn", now)).toBe(false);
    expect(Rep.reputationFor("Quinn")).toBe(9);
  });

  test("decayAll returns count changed and fades over days", () => {
    const t0 = Date.now();
    Rep.addReputation("Rita", 5, "t");
    Rep.addReputation("Sam", -5, "t");
    // Force lastDecay into the past by decaying with a future nowMs.
    const future = t0 + 2 * 24 * 3600 * 1000;
    const changed = Rep.decayAll(future);
    expect(changed).toBe(2);
    expect(Rep.reputationFor("Rita")).toBe(4);
    expect(Rep.reputationFor("Sam")).toBe(-4);
    // Same instant again: no double-decay.
    expect(Rep.decayAll(future)).toBe(0);
  });

  test("decay never crosses zero", () => {
    const future = Date.now() + 3 * 24 * 3600 * 1000;
    Rep.addReputation("Tiny", 1, "t");
    Rep.decayAll(future);
    expect(Rep.reputationFor("Tiny")).toBe(0);
  });
});

describe("tier announcements", () => {
  test("markTierAnnounced / announcedTierFor round-trip", () => {
    expect(Rep.announcedTierFor("Uma")).toBe("unknown");
    Rep.markTierAnnounced("Uma", "famous");
    expect(Rep.announcedTierFor("Uma")).toBe("famous");
  });
});

describe("persistence", () => {
  test("save writes the state to disk", () => {
    Rep.addReputation("Vera", 42, "t");
    expect(Rep.save()).toBe(true);
    expect(fs.existsSync(tmpFile)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
    const key = Object.keys(onDisk.reps)[0];
    expect(onDisk.reps[key].score).toBe(42);
    expect(onDisk.reps[key].username).toBe("Vera");
  });

  test("save is a no-op when clean", () => {
    Rep.resetForTests();
    expect(Rep.save()).toBe(false);
  });
});

describe("syncCrimeInfamy", () => {
  test("no-ops when the crime module is missing or has no notoriety", () => {
    // No crime module mock: the real CitizenCrime exists in-repo but the
    // test citizen has no record, so notoriety is 0 -> no change.
    const before = Rep.reputationFor("Wendy");
    Rep.syncCrimeInfamy("Wendy");
    expect(Rep.reputationFor("Wendy")).toBe(before);
  });
});
