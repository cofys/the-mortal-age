"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const os = require("os");
const path = require("path");

const Health = require("./CitizenHealth");

const NOW = Date.now();

beforeEach(() => {
  Health._setSavePathForTests(path.join(os.tmpdir(), `citizen-health-test-${process.pid}.json`));
  Health.resetForTests();
});

describe("CitizenHealth — illness records", () => {
  it("starts with nobody sick", () => {
    assert.equal(Health.isSick("Alice"), false);
    assert.equal(Health.recordOf("Alice"), null);
  });

  it("sicken creates a record with a recovery time in the illness window", () => {
    const rec = Health.sicken("Alice", "cold", NOW, { rng: () => 0 });
    assert.ok(rec);
    assert.equal(rec.illness, "cold");
    assert.equal(rec.severity, 1);
    // rng 0 → minimum duration (2 days for cold)
    assert.equal(rec.recoverAt, NOW + 2 * 24 * 3600 * 1000);
    assert.equal(Health.isSick("Alice"), true);
  });

  it("rejects unknown illnesses", () => {
    assert.equal(Health.sicken("Alice", "dragonpox", NOW), null);
    assert.equal(Health.isSick("Alice"), false);
  });

  it("a worse bout replaces a milder one, not vice versa", () => {
    Health.sicken("Alice", "cold", NOW, { rng: () => 0 });
    Health.sicken("Alice", "flu", NOW, { rng: () => 0 });
    assert.equal(Health.recordOf("Alice").illness, "flu");
    Health.sicken("Alice", "cold", NOW, { rng: () => 0 });
    assert.equal(Health.recordOf("Alice").illness, "flu");
  });

  it("cure removes the record", () => {
    Health.sicken("Alice", "flu", NOW, { rng: () => 0 });
    assert.equal(Health.cure("Alice"), true);
    assert.equal(Health.isSick("Alice"), false);
    assert.equal(Health.cure("Alice"), false);
  });

  it("sicknessSummary is null when healthy, shaped when sick", () => {
    assert.equal(Health.sicknessSummary("Alice"), null);
    Health.sicken("Alice", "plague", NOW, { rng: () => 0 });
    const s = Health.sicknessSummary("Alice");
    assert.equal(s.illness, "plague");
    assert.equal(s.severity, 4);
    assert.match(s.label, /plague/);
  });
});

describe("CitizenHealth — work penalty and mortality", () => {
  it("work penalty scales with severity (plague = 60)", () => {
    assert.equal(Health.workPenaltyFor("Nobody"), 0);
    Health.sicken("Alice", "cold", NOW, { rng: () => 0 });
    assert.equal(Health.workPenaltyFor("Alice"), 15);
    Health.sicken("Bob", "plague", NOW, { rng: () => 0 });
    assert.equal(Health.workPenaltyFor("Bob"), 60);
  });

  it("only plague adds mortality", () => {
    Health.sicken("Alice", "flu", NOW, { rng: () => 0 });
    assert.equal(Health.mortalityBonusFor("Alice"), 0);
    Health.sicken("Bob", "plague", NOW, { rng: () => 0 });
    assert.ok(Health.mortalityBonusFor("Bob") > 0);
    assert.equal(Health.mortalityBonusFor("Healthy"), 0);
  });

  it("treatment shortens the bout and records the healer", () => {
    const rec = Health.sicken("Alice", "flu", NOW, { rng: () => 0.99 });
    const before = rec.recoverAt;
    // Freeze time: stub Date.now for the shortening math.
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      assert.equal(Health.setTreatedBy("Alice", "Mira"), true);
    } finally {
      Date.now = realNow;
    }
    const after = Health.recordOf("Alice");
    assert.equal(after.treatedBy, "Mira");
    assert.ok(after.recoverAt < before);
    assert.equal(Health.setTreatedBy("Nobody", "Mira"), false);
  });
});

describe("CitizenHealth — kingdom queries and epidemics", () => {
  it("sickOfKingdom and casesOf filter correctly", () => {
    Health.sicken("Alice", "flu", NOW, { kingdomId: "misthalin" });
    Health.sicken("Bob", "flu", NOW, { kingdomId: "misthalin" });
    Health.sicken("Cara", "cold", NOW, { kingdomId: "asgarnia" });
    assert.equal(Health.sickOfKingdom("misthalin").length, 2);
    assert.equal(Health.casesOf("misthalin", "flu"), 2);
    assert.equal(Health.casesOf("misthalin", "cold"), 0);
    assert.equal(Health.sickOfKingdom("asgarnia").length, 1);
  });

  it("epidemic threshold is 3 same-illness cases", () => {
    assert.equal(Health.isEpidemic("misthalin", "flu"), false);
    Health.sicken("A", "flu", NOW, { kingdomId: "misthalin" });
    Health.sicken("B", "flu", NOW, { kingdomId: "misthalin" });
    assert.equal(Health.isEpidemic("misthalin", "flu"), false);
    Health.sicken("C", "flu", NOW, { kingdomId: "misthalin" });
    assert.equal(Health.isEpidemic("misthalin", "flu"), true);
  });
});

describe("CitizenHealth — hospitals", () => {
  it("ensureHospital creates a hospital with beds", () => {
    const h = Health.ensureHospital("misthalin");
    assert.equal(h.beds, 6);
    assert.deepEqual(h.patients, []);
  });

  it("severe cases are admitted, mild ones are not forced", () => {
    Health.sicken("Alice", "plague", NOW, { kingdomId: "misthalin" });
    assert.equal(Health.admitPatient("Alice", "misthalin"), true);
    const rec = Health.recordOf("Alice");
    assert.equal(rec.inHospital, true);
    assert.deepEqual(Health.patientsOfKingdom("misthalin"), ["alice"]);
  });

  it("admission fails when full or patient not sick", () => {
    assert.equal(Health.admitPatient("Healthy", "misthalin"), false);
    for (let i = 0; i < 6; i++) {
      Health.sicken(`P${i}`, "infection", NOW, { kingdomId: "full" });
      assert.equal(Health.admitPatient(`P${i}`, "full"), true);
    }
    Health.sicken("Extra", "infection", NOW, { kingdomId: "full" });
    assert.equal(Health.admitPatient("Extra", "full"), false);
  });

  it("discharge clears the patient list and flag", () => {
    Health.sicken("Alice", "infection", NOW, { kingdomId: "misthalin" });
    Health.admitPatient("Alice", "misthalin");
    Health.dischargePatient("Alice");
    assert.deepEqual(Health.patientsOfKingdom("misthalin"), []);
    assert.equal(Health.recordOf("Alice").inHospital, false);
  });

  it("hospital admission shortens recovery", () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const rec = Health.sicken("Alice", "infection", NOW, { rng: () => 0.99, kingdomId: "misthalin" });
      const before = rec.recoverAt;
      Health.admitPatient("Alice", "misthalin");
      assert.ok(Health.recordOf("Alice").recoverAt < before);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("CitizenHealth — persistence", () => {
  it("save and reload round-trips sick records", () => {
    const tmp = path.join(os.tmpdir(), `citizen-health-rt-${process.pid}.json`);
    Health._setSavePathForTests(tmp);
    Health.resetForTests();
    Health.sicken("Alice", "flu", NOW, { kingdomId: "misthalin" });
    Health.ensureHospital("misthalin");
    Health.save();
    Health.resetForTests();
    assert.equal(Health.isSick("Alice"), true);
    assert.equal(Health.recordOf("Alice").illness, "flu");
    assert.ok(Health.hospitalOfKingdom("misthalin"));
  });
});
