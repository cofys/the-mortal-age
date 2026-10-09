"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const Schools = require("./CitizenSchools");
const { tickSchools } = require("./CitizenSchoolLife");

const COINS = 995;
const DAY_MS = 24 * 3600 * 1000;

function tmpSave() {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "schoollife-")),
    "citizen-schools.json"
  );
  Schools._setSavePathForTests(p);
  Schools.resetForTests();
  return p;
}

// --- stubs -----------------------------------------------------------------

function fakeBot(coins) {
  let c = coins;
  return {
    getInventory: () => ({
      getAmount: (id) => (id === COINS ? c : 0),
      deleted: (id, amount) => {
        if (id === COINS) c = Math.max(0, c - amount);
      },
      adds: (id, amount) => {
        if (id === COINS) c += amount;
      },
    }),
    _coins: () => c,
  };
}

function makeDirector(records, botsByName = {}) {
  const roster = new Map();
  for (const r of records) roster.set(String(r.username).toLowerCase(), r);
  return {
    roster,
    getBot: (rec) => botsByName[String(rec?.username).toLowerCase()] ?? null,
    getPlayer: () => null,
    players: { get: () => null },
    isOnline: (rec) => !!botsByName[String(rec?.username).toLowerCase()],
  };
}

function kid(id, stage, kingdomId = "misthalin") {
  return {
    id,
    display: `Kid ${id}`,
    surname: "Stone",
    parents: ["papa stone", "mama stone"],
    familyId: "fam_1",
    kingdomId,
    bornAt: Date.now() - 10 * DAY_MS,
    stage,
    traits: [],
    bequest: 0,
    joinedRoster: false,
    learnedXp: {},
    leftTown: false,
  };
}

/** Inject stub modules into require.cache; returns a restore function. */
function stubModules({ kids = [], careers = null, gov = null } = {}) {
  const saved = new Map();
  const put = (rel, exportsObj) => {
    const resolved = require.resolve(rel);
    saved.set(resolved, require.cache[resolved]);
    require.cache[resolved] = { exports: exportsObj };
  };
  put("./CitizenFamilies", {
    allChildren: () => kids,
    getChild: (id) => kids.find((k) => k.id === id) ?? null,
  });
  put("./CitizenCareers", careers ?? { careerOf: () => null });
  put("./CitizenGovernment", gov ?? { hasLaw: () => false });
  return () => {
    for (const [resolved, prev] of saved) {
      if (prev === undefined) delete require.cache[resolved];
      else require.cache[resolved] = prev;
    }
  };
}

// --- tests -----------------------------------------------------------------

test("schoolhouse is founded when a kingdom has enough school-age children", () => {
  tmpSave();
  const kids = [kid("c1", "child"), kid("c2", "child"), kid("c3", "teen"), kid("c4", "child")];
  const restore = stubModules({ kids });
  try {
    const d = makeDirector([]);
    tickSchools(d, Date.now());
    const school = Schools.schoolOfKingdom("misthalin");
    assert.ok(school, "school founded");
    assert.equal(school.name, "Misthalin Schoolhouse");
    assert.ok(school.tile && Number.isFinite(school.tile.x));
  } finally {
    restore();
  }
});

test("no schoolhouse without enough children", () => {
  tmpSave();
  const restore = stubModules({ kids: [kid("c1", "child")] });
  try {
    tickSchools(makeDirector([]), Date.now());
    assert.equal(Schools.schoolOfKingdom("misthalin"), null);
  } finally {
    restore();
  }
});

test("scribe becomes schoolmaster on founding tick", () => {
  tmpSave();
  const kids = [kid("c1", "child"), kid("c2", "child"), kid("c3", "teen"), kid("c4", "child")];
  const restore = stubModules({
    kids,
    careers: { careerOf: (u) => (u === "scribe sam" ? { career: "scribe" } : null) },
  });
  try {
    const d = makeDirector([
      { username: "scribe sam", kingdomId: "misthalin", personality: { traits: [] } },
      { username: "papa stone", kingdomId: "misthalin", personality: { traits: [] } },
    ]);
    tickSchools(d, Date.now());
    assert.equal(Schools.schoolOfKingdom("misthalin").teacher, "scribe sam");
  } finally {
    restore();
  }
});

test("school-age children enroll automatically", () => {
  tmpSave();
  const kids = [
    kid("c1", "child"),
    kid("c2", "teen"),
    kid("c3", "child"),
    kid("c4", "teen"),
    kid("c5", "baby"),
  ];
  const restore = stubModules({ kids });
  try {
    tickSchools(makeDirector([]), Date.now());
    // c1–c4 enrolled (once the school exists); c5 is a baby.
    for (const id of ["c1", "c2", "c3", "c4"]) {
      assert.ok(Schools.pupilOf(id), `${id} enrolled`);
    }
    assert.equal(Schools.pupilOf("c5"), null, "baby not enrolled");
  } finally {
    restore();
  }
});

test("enrolled pupils gain literacy and numeracy from lessons", () => {
  tmpSave();
  const kids = [kid("c1", "child"), kid("c2", "child"), kid("c3", "child"), kid("c4", "child")];
  const restore = stubModules({ kids });
  try {
    const d = makeDirector([]);
    tickSchools(d, Date.now());
    const before = Schools.pupilOf("c1").lessonsAttended;
    tickSchools(d, Date.now() + 61000);
    const after = Schools.pupilOf("c1");
    assert.ok(after.lessonsAttended > before, "lessons attended");
    assert.ok(after.literacy > 0 && after.numeracy > 0, "scores climb");
  } finally {
    restore();
  }
});

test("tuition is collected from an online parent's real coins", () => {
  tmpSave();
  const kids = [kid("c1", "child"), kid("c2", "child"), kid("c3", "child"), kid("c4", "child")];
  const restore = stubModules({ kids });
  try {
    const papaBot = fakeBot(1000);
    const d = makeDirector(
      [{ username: "papa stone", kingdomId: "misthalin", personality: { traits: [] } }],
      { "papa stone": papaBot }
    );
    // Enroll first.
    tickSchools(d, Date.now());
    assert.ok(Schools.pupilOf("c1"), "enrolled");
    // Force tuition due.
    const p = Schools.pupilOf("c1");
    p.lastTuitionAt = Date.now() - DAY_MS - 1;
    const before = papaBot._coins();
    tickSchools(d, Date.now());
    assert.ok(papaBot._coins() < before, "coins taken for tuition");
    assert.equal(Schools.pupilOf("c1").tuitionDebtDays, 0);
  } finally {
    restore();
  }
});

test("offline parents accrue debt; seven days unpaid unenrolls", () => {
  tmpSave();
  const kids = [kid("c1", "child"), kid("c2", "child"), kid("c3", "child"), kid("c4", "child")];
  const restore = stubModules({ kids });
  try {
    // No bots online: nobody can pay.
    const d = makeDirector([
      { username: "papa stone", kingdomId: "misthalin", personality: { traits: [] } },
    ]);
    tickSchools(d, Date.now());
    assert.ok(Schools.pupilOf("c1"), "enrolled");
    // Simulate seven unpaid days.
    for (let day = 1; day <= 7; day++) {
      const p = Schools.pupilOf("c1");
      if (!p || p.unenrolledAt) break;
      p.lastTuitionAt = Date.now() - DAY_MS - 1;
      tickSchools(d, Date.now() + day * DAY_MS);
    }
    const p = Schools.pupilOf("c1");
    assert.ok(!Schools.isEnrolled("c1"), "unenrolled after 7 unpaid days");
    assert.equal(p.unenrollReason, "unpaid tuition");
  } finally {
    restore();
  }
});

test("free schooling law waives tuition", () => {
  tmpSave();
  const kids = [kid("c1", "child"), kid("c2", "child"), kid("c3", "child"), kid("c4", "child")];
  const restore = stubModules({
    kids,
    gov: { hasLaw: (k, id) => id === "school-funding" },
  });
  try {
    const papaBot = fakeBot(1000);
    const d = makeDirector(
      [{ username: "papa stone", kingdomId: "misthalin", personality: { traits: [] } }],
      { "papa stone": papaBot }
    );
    tickSchools(d, Date.now());
    const p = Schools.pupilOf("c1");
    p.lastTuitionAt = Date.now() - DAY_MS - 1;
    tickSchools(d, Date.now());
    assert.equal(papaBot._coins(), 1000, "no coins taken under free schooling");
    assert.equal(Schools.pupilOf("c1").tuitionDebtDays, 0);
  } finally {
    restore();
  }
});

test("pupils graduate when they outgrow school age", () => {
  tmpSave();
  const kids = [kid("c1", "child"), kid("c2", "child"), kid("c3", "child"), kid("c4", "child")];
  const restore = stubModules({ kids });
  try {
    const d = makeDirector([]);
    tickSchools(d, Date.now());
    assert.ok(Schools.isEnrolled("c1"));
    // The child grows up: stage flips to adult.
    kids[0].stage = "adult";
    tickSchools(d, Date.now() + 61000);
    const p = Schools.pupilOf("c1");
    assert.ok(p.graduated, "graduated on adulthood");
    assert.ok(p.graduatedAt, "graduation timestamped");
    assert.equal(Schools.isEnrolled("c1"), false);
  } finally {
    restore();
  }
});

test("null director and empty roster never throw", () => {
  tmpSave();
  const restore = stubModules({ kids: [] });
  try {
    assert.doesNotThrow(() => tickSchools(null, Date.now()));
    assert.doesNotThrow(() => tickSchools(makeDirector([]), Date.now()));
  } finally {
    restore();
  }
});
