"use strict";

// Plain-node tests for CitizenMusicGuilds (no jest, no engine).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenMusicGuilds");

function freshSave() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mg-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  return p;
}

// --- Stub the engine reads ---
const Module = require("module");
const origRequire = Module.prototype.require;

function installStubs(opts = {}) {
  const stubs = {
    "./CitizenMusicDance": {
      isStageProfessional: (u) => (opts.professionals || []).includes(u.toLowerCase()),
      ensembleOf: (u) => (opts.ensembleMembers || []).includes(u.toLowerCase()) ? { name: "The Lutes" } : null,
      concertFor: (id) => (opts.concerts || {})[id] || null,
      instrumentOf: (u) => (opts.instruments || {})[u.toLowerCase()] || null,
    },
    "./CitizenCareers": {
      careerOf: (u) => (opts.careers || {})[u.toLowerCase()] || null,
    },
    "../brain/CitizenSites": {
      KINGDOM_IDS: ["varrock", "falador"],
      kingdomIdOf: () => "varrock",
    },
    "./CitizenReputation": {
      awardDeed: () => {},
    },
    "./CitizenBonds": { normalizeName: (s) => String(s || "").toLowerCase().trim() },
  };
  Module.prototype.require = function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return origRequire.apply(this, arguments);
  };
  return () => { Module.prototype.require = origRequire; };
}

let passed = 0;
function test(name, fn) {
  freshSave();
  const restore = installStubs();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    restore();
  }
}

// === Guilds ===

test("ensureGuild creates a guild per kingdom", () => {
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g);
  assert.strictEqual(g.kingdomId, "varrock");
  assert.strictEqual(g.treasury, 0);
});

test("joinGuild requires a real musician", () => {
  const r = Guilds.joinGuild("notamusican", "varrock");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-a-musician");
});

test("joinGuild accepts stage professionals", () => {
  const restore = installStubs({ professionals: ["lute larry"] });
  try {
    const r = Guilds.joinGuild("Lute Larry", "varrock");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.rank, "novice");
    assert.ok(Guilds.isGuildMember("lute larry"));
  } finally { restore(); }
});

test("joinGuild accepts bard-career citizens", () => {
  const restore = installStubs({ careers: { "singing sue": "bard" } });
  try {
    const r = Guilds.joinGuild("Singing Sue", "varrock");
    assert.strictEqual(r.ok, true);
  } finally { restore(); }
});

test("joinGuild accepts ensemble members", () => {
  const restore = installStubs({ ensembleMembers: ["fiddle fred"] });
  try {
    const r = Guilds.joinGuild("Fiddle Fred", "varrock");
    assert.strictEqual(r.ok, true);
  } finally { restore(); }
});

test("joinGuild rejects duplicates", () => {
  const restore = installStubs({ professionals: ["lute larry"] });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const r = Guilds.joinGuild("Lute Larry", "varrock");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "already-member");
  } finally { restore(); }
});

test("dues payment extends membership and feeds funds", () => {
  const restore = installStubs({ professionals: ["lute larry"] });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const now = Date.now();
    const r = Guilds.recordDuesPayment("Lute Larry", now);
    assert.strictEqual(r.ok, true);
    const t = Guilds.guildTreasuryFor("varrock");
    assert.strictEqual(t.treasury, 20); // 25 - 5
    assert.strictEqual(t.instrumentFund, 5);
  } finally { restore(); }
});

test("two missed dues suspends the member", () => {
  const restore = installStubs({ professionals: ["lute larry"] });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const now = Date.now();
    Guilds.recordMissedDues("Lute Larry", now);
    let m = Guilds.memberOf("Lute Larry");
    assert.strictEqual(m.suspended, false);
    Guilds.recordMissedDues("Lute Larry", now);
    m = Guilds.memberOf("Lute Larry");
    assert.strictEqual(m.suspended, true);
  } finally { restore(); }
});

// === Certification ===

test("certifyPerformance verifies real concerts", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 9, title: "Moonlight Sonata" },
  };
  const restore = installStubs({ professionals: ["lute larry"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const r = Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Moonlight Sonata");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.grade, "A");
    assert.strictEqual(r.fee, 50);
    // Treasury was empty -> bounty owed honestly.
    assert.strictEqual(r.bountyPaid, 0);
    assert.strictEqual(r.bountyOwed, 120);
  } finally { restore(); }
});

test("certifyPerformance rejects non-performers", () => {
  const concerts = {
    "c1": { performers: ["Someone Else"], quality: 9, title: "Moonlight Sonata" },
  };
  const restore = installStubs({ professionals: ["lute larry"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const r = Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Moonlight Sonata");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "not-a-performer");
  } finally { restore(); }
});

test("certifyPerformance rejects unknown concerts", () => {
  const restore = installStubs({ professionals: ["lute larry"], concerts: {} });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const r = Guilds.certifyPerformance("varrock", "Lute Larry", "nope", "X");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "no-such-concert");
  } finally { restore(); }
});

test("certifyPerformance rejects double-certification", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 7, title: "Tune" },
  };
  const restore = installStubs({ professionals: ["lute larry"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const r1 = Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Tune");
    assert.strictEqual(r1.ok, true);
    const r2 = Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Tune");
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.reason, "already-certified");
  } finally { restore(); }
});

test("retryOwedBounties pays when the treasury refills", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 9, title: "Tune" },
  };
  const restore = installStubs({ professionals: ["lute larry"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const r = Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Tune");
    assert.strictEqual(r.bountyOwed, 120);
    Guilds.contributeToFund("varrock", 200);
    const retry = Guilds.retryOwedBounties("varrock");
    assert.ok(retry.paid >= 120);
  } finally { restore(); }
});

// === Plagiarism tribunal ===

test("scanPlagiarism detects stolen songs", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 8, title: "My Original Song" },
    "c2": { performers: ["Copy Cat"], quality: 6, title: "My Original Song" },
  };
  const restore = installStubs({ professionals: ["lute larry", "copy cat"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    Guilds.joinGuild("Copy Cat", "varrock");
    Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "My Original Song");
    // Backdate the first cert so ordering is deterministic.
    Guilds.certifyPerformance("varrock", "Copy Cat", "c2", "My Original Song");
    const found = Guilds.scanPlagiarism("My Original Song");
    assert.ok(found);
    assert.strictEqual(found.original.musician, "Lute Larry");
    assert.strictEqual(found.accused.musician, "Copy Cat");
  } finally { restore(); }
});

test("reportPlagiarism opens a case, no double jeopardy", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 8, title: "Stolen Tune" },
    "c2": { performers: ["Copy Cat"], quality: 6, title: "Stolen Tune" },
  };
  const restore = installStubs({ professionals: ["lute larry", "copy cat"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    Guilds.joinGuild("Copy Cat", "varrock");
    Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Stolen Tune");
    Guilds.certifyPerformance("varrock", "Copy Cat", "c2", "Stolen Tune");
    const r1 = Guilds.reportPlagiarism("varrock", "Lute Larry", "Stolen Tune");
    assert.strictEqual(r1.ok, true);
    const r2 = Guilds.reportPlagiarism("varrock", "Lute Larry", "Stolen Tune");
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.reason, "case-exists");
  } finally { restore(); }
});

test("tribunal convicts with quorum and expels", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 8, title: "Hot Track" },
    "c2": { performers: ["Copy Cat"], quality: 6, title: "Hot Track" },
  };
  const restore = installStubs({ professionals: ["lute larry", "copy cat", "judge judy"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    Guilds.joinGuild("Copy Cat", "varrock");
    Guilds.joinGuild("Judge Judy", "varrock");
    // Promote voters to minstrel so they can vote.
    const st = Guilds.load();
    st.members["lute larry"].rank = "minstrel";
    st.members["judge judy"].rank = "minstrel";
    Guilds.touch();
    Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Hot Track");
    Guilds.certifyPerformance("varrock", "Copy Cat", "c2", "Hot Track");
    const rep = Guilds.reportPlagiarism("varrock", "Lute Larry", "Hot Track");
    assert.strictEqual(rep.ok, true);
    Guilds.voteOnCase(rep.caseId, "Lute Larry", "guilty");
    Guilds.voteOnCase(rep.caseId, "Judge Judy", "guilty");
    const settled = Guilds.settleRipeCases("varrock", Date.now() + 25 * 3600 * 1000);
    assert.ok(settled.settled.includes(rep.caseId));
    assert.strictEqual(Guilds.isGuildMember("Copy Cat"), false); // expelled
  } finally { restore(); }
});

test("tribunal acquits without quorum", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 8, title: "Cold Track" },
    "c2": { performers: ["Copy Cat"], quality: 6, title: "Cold Track" },
  };
  const restore = installStubs({ professionals: ["lute larry", "copy cat"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    Guilds.joinGuild("Copy Cat", "varrock");
    const st = Guilds.load();
    st.members["lute larry"].rank = "minstrel";
    Guilds.touch();
    Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Cold Track");
    Guilds.certifyPerformance("varrock", "Copy Cat", "c2", "Cold Track");
    const rep = Guilds.reportPlagiarism("varrock", "Lute Larry", "Cold Track");
    Guilds.voteOnCase(rep.caseId, "Lute Larry", "guilty"); // only 1 vote, no quorum
    Guilds.settleRipeCases("varrock", Date.now() + 25 * 3600 * 1000);
    assert.strictEqual(Guilds.isGuildMember("Copy Cat"), true); // not expelled
  } finally { restore(); }
});

// === Inspections ===

test("inspectionFor scores real instrument ownership", () => {
  const restore = installStubs({
    professionals: ["lute larry", "drum dan"],
    instruments: { "lute larry": { id: 3689 } },
  });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    Guilds.joinGuild("Drum Dan", "varrock");
    const insp = Guilds.inspectionFor("varrock");
    assert.strictEqual(insp.members, 2);
    assert.strictEqual(insp.withInstruments, 1);
    assert.strictEqual(insp.score, 50);
  } finally { restore(); }
});

// === Golden lyre ===

test("grantGoldenLyre picks the most-certified member", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 8, title: "A" },
    "c2": { performers: ["Lute Larry"], quality: 7, title: "B" },
    "c3": { performers: ["Drum Dan"], quality: 9, title: "C" },
  };
  const restore = installStubs({ professionals: ["lute larry", "drum dan"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    Guilds.joinGuild("Drum Dan", "varrock");
    Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "A");
    Guilds.certifyPerformance("varrock", "Lute Larry", "c2", "B");
    Guilds.certifyPerformance("varrock", "Drum Dan", "c3", "C");
    const r = Guilds.grantGoldenLyre("varrock", Date.now());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.winner, "Lute Larry");
    assert.strictEqual(r.performances, 2);
  } finally { restore(); }
});

// === School & mentorship ===

test("holdClass grants training credits to novices", () => {
  const restore = installStubs({ professionals: ["maestro max", "lute larry"] });
  try {
    Guilds.joinGuild("Maestro Max", "varrock");
    Guilds.joinGuild("Lute Larry", "varrock");
    const st = Guilds.load();
    st.members["maestro max"].rank = "maestro";
    Guilds.touch();
    const r = Guilds.holdClass("varrock", "Maestro Max");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.taught, 1);
    assert.strictEqual(Guilds.memberOf("Lute Larry").trainingCredits, 1);
  } finally { restore(); }
});

test("takeApprentice waives certification fees", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 8, title: "Apprentice Tune" },
  };
  const restore = installStubs({ professionals: ["maestro max", "lute larry"], concerts });
  try {
    Guilds.joinGuild("Maestro Max", "varrock");
    Guilds.joinGuild("Lute Larry", "varrock");
    const st = Guilds.load();
    st.members["maestro max"].rank = "maestro";
    Guilds.touch();
    Guilds.takeApprentice("Maestro Max", "Lute Larry");
    const r = Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Apprentice Tune");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fee, 0); // mentored = free
  } finally { restore(); }
});

test("tryPromote novice to minstrel needs tenure, credits, cert", () => {
  const concerts = {
    "c1": { performers: ["Lute Larry"], quality: 8, title: "Promo Tune" },
  };
  const restore = installStubs({ professionals: ["lute larry"], concerts });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    // Too soon: tenure fails.
    let r = Guilds.tryPromote("Lute Larry");
    assert.strictEqual(r.ok, false);
    // Fake the tenure and credits.
    const st = Guilds.load();
    st.members["lute larry"].joinedMs = Date.now() - 31 * 24 * 3600 * 1000;
    st.members["lute larry"].trainingCredits = 2;
    Guilds.touch();
    Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Promo Tune");
    r = Guilds.tryPromote("Lute Larry");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.rank, "minstrel");
  } finally { restore(); }
});

// === Persistence ===

test("save round-trip preserves state", () => {
  const savePath = freshSave();
  const restore = installStubs({ professionals: ["lute larry"] });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    assert.strictEqual(Guilds.save(), true);
    // Verify the file was written with our data.
    const raw = fs.readFileSync(savePath, "utf8");
    const data = JSON.parse(raw);
    assert.ok(data.members["lute larry"]);
    assert.strictEqual(data.members["lute larry"].username, "Lute Larry");
  } finally { restore(); }
});

test("describe returns guild summary", () => {
  const restore = installStubs({ professionals: ["lute larry"] });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    const d = Guilds.describe("varrock");
    assert.strictEqual(d.exists, true);
    assert.strictEqual(d.memberCount, 1);
    const missing = Guilds.describe("falador");
    assert.strictEqual(missing.exists, false);
  } finally { restore(); }
});

console.log(`\n${passed} tests passed`);
