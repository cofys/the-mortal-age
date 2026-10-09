"use strict";

// Plain-node tests for CitizenObservatoryGuilds (no jest, no engine).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// --- Engine stubs (installed BEFORE the guild module loads) ---
const Module = require("module");
const origRequire = Module.prototype.require;

const careers = {}; // lowername -> career
let astronomers = {}; // lowername -> { username, kingdomId, wisdom }
let charts = []; // chart records
let activeEvent = null; // active celestial event kind
const awardDeeds = [];
const pubs = []; // science publications
let bankingDown = false;
const bankAccounts = {}; // lowername -> { balance }

const EVENT_SCHEDULES = {
  meteor_shower: { label: "meteor shower", scheduleMonths: 1 },
  comet: { label: "comet", scheduleMonths: 3 },
  lunar_eclipse: { label: "lunar eclipse", scheduleMonths: 6 },
  solar_eclipse: { label: "solar eclipse", scheduleMonths: 12 },
};

function installStubs() {
  const stubs = {
    "./CitizenBonds": { normalizeName: (s) => String(s || "").toLowerCase().trim() },
    "./CitizenAstronomy": {
      EVENTS: EVENT_SCHEDULES,
      astronomerFor: (u) => astronomers[String(u || "").toLowerCase()] || null,
      astronomersFor: (kid) => Object.values(astronomers).filter((a) => a.kingdomId === kid),
      chartsFor: (kid) => charts.filter((c) => c.kingdomId === kid),
      observatoryFor: (kid) => ({ kingdomId: kid, tile: { x: 3300, y: 3300, z: 0 } }),
      activeEventFor: () => (activeEvent ? { kind: activeEvent, label: activeEvent.replace(/_/g, " ") } : null),
    },
    "./CitizenCareers": { careerOf: (u) => careers[String(u || "").toLowerCase()] || null },
    "./CitizenReputation": { awardDeed: (u, deed) => { awardDeeds.push([u, deed]); } },
    "./CitizenScience": { recentPublications: () => pubs.slice() },
    "./CitizenBanking": {
      // Real contract: accountFor creates-and-returns the live record;
      // markDirty persists. bankingDown simulates unreachable banking.
      accountFor: (u) => {
        if (bankingDown) throw new Error("banking unreachable");
        const key = String(u || "").toLowerCase().trim();
        if (!bankAccounts[key]) bankAccounts[key] = { balance: 0 };
        return bankAccounts[key];
      },
      markDirty: () => {},
    },
    "../brain/CitizenSites": {
      KINGDOM_IDS: ["varrock"],
      kingdomIdOf: () => "varrock",
      siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    },
  };
  Module.prototype.require = function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return origRequire.apply(this, arguments);
  };
}
installStubs();

const Guilds = require("./CitizenObservatoryGuilds");

function freshSave() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "og-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  return p;
}

function resetEngine() {
  for (const k of Object.keys(careers)) delete careers[k];
  for (const k of Object.keys(bankAccounts)) delete bankAccounts[k];
  bankingDown = false;
  astronomers = {};
  charts = [];
  activeEvent = null;
  awardDeeds.length = 0;
  pubs.length = 0;
}

let passed = 0;
function test(name, fn) {
  freshSave();
  resetEngine();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- membership ---

test("join requires a real astronomer", () => {
  const r1 = Guilds.joinGuild("NotAstro", "varrock");
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, "not-an-astronomer");
  careers["gazer1"] = "astronomer";
  const r2 = Guilds.joinGuild("Gazer1", "varrock");
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.rank, "stargazer");
  assert.strictEqual(Guilds.isGuildMember("gazer1"), true);
  assert.strictEqual(Guilds.guildRankOf("Gazer1"), "stargazer");
});

test("registered astronomers can join without the career", () => {
  astronomers["sky"] = { username: "Sky", kingdomId: "varrock", wisdom: 10 };
  const r = Guilds.joinGuild("sky", "varrock");
  assert.strictEqual(r.ok, true);
});

test("duplicate join rejected; leave clears membership", () => {
  careers["gazer1"] = "astronomer";
  assert.strictEqual(Guilds.joinGuild("gazer1", "varrock").ok, true);
  assert.strictEqual(Guilds.joinGuild("gazer1", "varrock").ok, false);
  assert.strictEqual(Guilds.leaveGuild("gazer1").ok, true);
  assert.strictEqual(Guilds.isGuildMember("gazer1"), false);
  assert.strictEqual(Guilds.leaveGuild("gazer1").ok, false);
});

test("dues payment extends coverage; two misses suspend", () => {
  careers["gazer1"] = "astronomer";
  Guilds.joinGuild("gazer1", "varrock");
  const now = Date.now();
  assert.strictEqual(Guilds.recordDuesPayment("gazer1", now).ok, true);
  const m = Guilds.memberOf("gazer1");
  assert.strictEqual(m.duesPaidUntilMs, now + 7 * 24 * 3600 * 1000);
  assert.strictEqual(m.suspended, false);
  Guilds.recordMissedDues("gazer1", now);
  assert.strictEqual(Guilds.memberOf("gazer1").suspended, false);
  const r = Guilds.recordMissedDues("gazer1", now);
  assert.strictEqual(r.suspended, true);
  // catching up lifts the suspension
  Guilds.recordDuesPayment("gazer1", now + 1000);
  assert.strictEqual(Guilds.memberOf("gazer1").suspended, false);
});

// --- chart certification ---

function addAstronomer(name) {
  careers[name.toLowerCase()] = "astronomer";
  astronomers[name.toLowerCase()] = { username: name, kingdomId: "varrock", wisdom: 20 };
  Guilds.joinGuild(name, "varrock");
}

test("certifyChart verifies the real chart and the real astronomer", () => {
  addAstronomer("Sky");
  addAstronomer("Rival");
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 9, createdAt: 1 });

  // Unknown chart.
  assert.strictEqual(Guilds.certifyChart("varrock", "Sky", "nope").reason, "no-such-chart");
  // Another astronomer's chart -> rejected AND a fabrication case opened.
  const bad = Guilds.certifyChart("varrock", "Rival", "c1");
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, "not-the-astronomer");
  assert.ok(bad.caseId, "fabrication case opened automatically");
  const st = Guilds.load();
  assert.strictEqual(st.cases[bad.caseId].kind, "fabrication");

  // The real astronomer certifies.
  Guilds.creditTreasury("varrock", 1000);
  const res = Guilds.certifyChart("varrock", "Sky", "c1");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.grade, "A"); // quality 9
  assert.strictEqual(res.bountyPaid, 120);
  assert.strictEqual(Guilds.bestGradeFor("Sky"), "A");
  assert.ok(Guilds.chartCertFor(res.certId));

  // Double certification barred.
  assert.strictEqual(Guilds.certifyChart("varrock", "Sky", "c1").reason, "already-certified");
});

test("certification grades map from real quality; broke treasury owes honestly", () => {
  addAstronomer("Sky");
  charts.push(
    { id: "cB", astronomer: "Sky", kingdomId: "varrock", quality: 6, createdAt: 1 },
    { id: "cC", astronomer: "Sky", kingdomId: "varrock", quality: 2, createdAt: 2 },
  );
  // Treasury empty: bounties owed, never invented.
  const rb = Guilds.certifyChart("varrock", "Sky", "cB");
  assert.strictEqual(rb.ok, true);
  assert.strictEqual(rb.grade, "B");
  assert.strictEqual(rb.bountyPaid, 0);
  assert.strictEqual(rb.bountyOwed, 60);
  const rc = Guilds.certifyChart("varrock", "Sky", "cC");
  assert.strictEqual(rc.grade, "C");
  assert.strictEqual(rc.bountyOwed, 30);
  // Refill and retry: owed bounties are paid.
  Guilds.creditTreasury("varrock", 100);
  const retry = Guilds.retryOwedBounties("varrock");
  assert.strictEqual(retry.paid, 90);
  assert.strictEqual(Guilds.chartCertFor(rb.certId).bountyOwed, 0);
});

test("mentored stargazers certify free and earn double promotion credit", () => {
  addAstronomer("Master");
  addAstronomer("Novice");
  // Master -> starmaster rank for mentorship.
  const mm = Guilds.memberOf("Master");
  mm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  assert.strictEqual(Guilds.takeApprentice("Master", "Novice").ok, true);
  charts.push({ id: "c9", astronomer: "Novice", kingdomId: "varrock", quality: 7, createdAt: 1 });
  Guilds.creditTreasury("varrock", 500);
  const res = Guilds.certifyChart("varrock", "Novice", "c9");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.fee, 0);
  // Mentorship ended after the first certification; counts double.
  assert.strictEqual(Guilds.memberOf("Novice").certificationsConducted, 2);
  assert.strictEqual(Guilds.load().mentorships["novice"], undefined);
});

// --- tribunal ---

test("fabrication tribunal: vote, settle, expel", () => {
  addAstronomer("Sky");
  addAstronomer("Rival");
  const rm = Guilds.memberOf("Rival");
  rm.rank = Guilds.RANK_ASTRONOMER;
  Guilds.touch();
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 5, createdAt: 1 });
  const rep = Guilds.reportFabrication("varrock", "Sky", "c1");
  assert.strictEqual(rep.ok, false); // no fraudulent certification exists yet
  assert.strictEqual(rep.reason, "no-fabrication-found");

  // Auto-opened case from a false-attribution attempt.
  const bad = Guilds.certifyChart("varrock", "Rival", "c1");
  const caseId = bad.caseId;
  // Stargazers cannot vote; astronomers can.
  const sv = Guilds.voteOnCase(caseId, "Sky", "guilty");
  assert.strictEqual(sv.ok, false); // Sky is a stargazer
  assert.strictEqual(sv.reason, "rank-too-low");
  assert.strictEqual(Guilds.voteOnCase(caseId, "Rival", "guilty").ok, true);
  addAstronomer("Judge");
  const jm = Guilds.memberOf("Judge");
  jm.rank = Guilds.RANK_ASTRONOMER;
  Guilds.touch();
  assert.strictEqual(Guilds.voteOnCase(caseId, "Judge", "guilty").ok, true);
  // Settle after TTL.
  const now = Date.now();
  const res = Guilds.settleRipeCases("varrock", now + 25 * 3600 * 1000);
  assert.deepStrictEqual(res.settled, [caseId]);
  const c = Guilds.load().cases[caseId];
  assert.strictEqual(c.status, "convicted");
  // No expulsion here: the auto-opened case had no identified accused.
  // Now the manual path with an identified fabricator:
  charts.push({ id: "c2", astronomer: "Sky", kingdomId: "varrock", quality: 5, createdAt: 2 });
  // Slip a fraudulent certification directly into the ledger (simulates a
  // manipulated engine write) and report it.
  const st = Guilds.load();
  st.certifications["cert-x"] = {
    id: "cert-x", kingdomId: "varrock", astronomer: "Rival", chartId: "c2",
    quality: 5, grade: "B", feePaid: 0, bountyPaid: 0, bountyOwed: 0, certifiedMs: Date.now(),
  };
  Guilds.touch();
  const rep2 = Guilds.reportFabrication("varrock", "Sky", "c2");
  assert.strictEqual(rep2.ok, true);
  Guilds.voteOnCase(rep2.caseId, "Rival", "guilty");
  Guilds.voteOnCase(rep2.caseId, "Judge", "guilty");
  const res2 = Guilds.settleRipeCases("varrock", now + 25 * 3600 * 1000);
  assert.ok(res2.settled.includes(rep2.caseId));
  assert.strictEqual(Guilds.isGuildMember("Rival"), false); // expelled
  assert.ok(awardDeeds.some(([u, d]) => u === "Rival" && d === "fraudster"));
});

// --- celestial standards ---

test("accuracy audit reflects real chart output", () => {
  addAstronomer("Sky");
  addAstronomer("Idle");
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 8, createdAt: 1 });
  const audit = Guilds.accuracyAuditFor("varrock");
  assert.strictEqual(audit.members, 2);
  assert.strictEqual(audit.withCharts, 1);
  assert.strictEqual(audit.score, 50);
});

test("accuracy audit recognizes real astronomy discoveries", () => {
  addAstronomer("Sky");
  pubs.push({ author: "Sky", field: "astronomy", title: "On Lunar Cycles" });
  const audit = Guilds.accuracyAuditFor("varrock");
  assert.strictEqual(audit.withDiscoveries, 1);
});

// --- eclipse prediction ---

test("nextEventFor mirrors the engine's deterministic schedule", () => {
  for (const kind of Object.keys(EVENT_SCHEDULES)) {
    const n = Guilds.nextEventFor(kind);
    assert.ok(n, `prediction for ${kind}`);
    const d = new Date(n.predictedForMs);
    const idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
    assert.strictEqual(idx % EVENT_SCHEDULES[kind].scheduleMonths, 0, kind);
    assert.ok(n.predictedForMs > Date.now(), "prediction is in the future");
  }
  assert.strictEqual(Guilds.nextEventFor("nope"), null);
});

test("predictEvent requires a starmaster; confirmations pay the herald", () => {
  addAstronomer("Seer");
  // Not a starmaster yet.
  assert.strictEqual(Guilds.predictEvent("varrock", "Seer", "lunar_eclipse").reason, "rank-too-low");
  const sm = Guilds.memberOf("Seer");
  sm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  Guilds.creditTreasury("varrock", 500);
  const p = Guilds.predictEvent("varrock", "Seer", "lunar_eclipse");
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.kind, "lunar_eclipse");
  // Duplicate open prediction rejected.
  assert.strictEqual(Guilds.predictEvent("varrock", "Seer", "lunar_eclipse").ok, false);
  // The event goes active after the predicted month: confirmed.
  activeEvent = "lunar_eclipse";
  const res = Guilds.confirmPredictions("varrock", p.predictedForMs + 1000);
  assert.deepStrictEqual(res.confirmed, [p.predictionId]);
  const pred = Guilds.predictionsFor("varrock")[0];
  assert.strictEqual(pred.status, "confirmed");
  assert.strictEqual(pred.prizePaid, Guilds.HERALD_PRIZE);
  assert.ok(awardDeeds.some(([u, d]) => u === "Seer" && d === "eclipseherald"));
  assert.strictEqual(Guilds.guildOf("varrock").confirmedPredictions, 1);
  assert.ok(Guilds.guildOf("varrock").prestige >= 5);
});

test("predictions fail honestly when the sky never shows", () => {
  addAstronomer("Seer");
  const sm = Guilds.memberOf("Seer");
  sm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  const p = Guilds.predictEvent("varrock", "Seer", "comet");
  assert.strictEqual(p.ok, true);
  // No event active, long past the predicted month + grace.
  activeEvent = null;
  const res = Guilds.confirmPredictions("varrock", p.predictedForMs + 50 * 24 * 3600 * 1000);
  assert.deepStrictEqual(res.failed, [p.predictionId]);
  assert.strictEqual(Guilds.predictionsFor("varrock")[0].status, "failed");
});

test("an earlier same-kind event never confirms a later prediction", () => {
  addAstronomer("Seer");
  const sm = Guilds.memberOf("Seer");
  sm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  const p = Guilds.predictEvent("varrock", "Seer", "solar_eclipse");
  // A solar eclipse is active NOW, but the prediction is for a later one.
  activeEvent = "solar_eclipse";
  const res = Guilds.confirmPredictions("varrock", Date.now());
  assert.deepStrictEqual(res.confirmed, []);
  assert.strictEqual(Guilds.predictionsFor("varrock")[0].status, "open");
});

// --- silver orrery ---

test("silver orrery awards the most-certified member; broke treasury owes", () => {
  addAstronomer("Sky");
  addAstronomer("Rival");
  charts.push(
    { id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 8, createdAt: 1 },
    { id: "c2", astronomer: "Sky", kingdomId: "varrock", quality: 7, createdAt: 2 },
    { id: "c3", astronomer: "Rival", kingdomId: "varrock", quality: 8, createdAt: 3 },
  );
  Guilds.creditTreasury("varrock", 30); // not enough for the 200 prize
  for (const c of ["c1", "c2"]) Guilds.certifyChart("varrock", "Sky", c);
  Guilds.certifyChart("varrock", "Rival", "c3");
  const now = Date.now();
  const r = Guilds.grantSilverOrrery("varrock", now);
  // Sky has 2, Rival has 1.
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.winner, "Sky");
  assert.strictEqual(r.charts, 2);
  assert.ok(r.prizePaid <= 200);
  assert.strictEqual(r.prizePaid + r.prizeOwed, 200);
  assert.ok(awardDeeds.some(([u, d]) => u === "Sky" && d === "silverorrery"));
  // Quarterly gate.
  assert.strictEqual(Guilds.grantSilverOrrery("varrock", now + 1000).reason, "too-soon");
});

// --- school & mentorship ---

test("holdClass teaches stargazers; tryPromote enforces real requirements", () => {
  addAstronomer("Master");
  addAstronomer("Novice");
  const mm = Guilds.memberOf("Master");
  mm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  assert.strictEqual(Guilds.holdClass("varrock", "Master").taught, 1);
  assert.strictEqual(Guilds.memberOf("Novice").trainingCredits, 1);
  // Promotion needs 30d tenure + 2 credits + a real certified chart.
  assert.strictEqual(Guilds.tryPromote("Novice").reason, "tenure");
  const nm = Guilds.memberOf("Novice");
  nm.joinedMs = Date.now() - 31 * 24 * 3600 * 1000;
  nm.trainingCredits = 2;
  Guilds.touch();
  assert.strictEqual(Guilds.tryPromote("Novice").reason, "no-certification");
  charts.push({ id: "c1", astronomer: "Novice", kingdomId: "varrock", quality: 6, createdAt: 1 });
  Guilds.creditTreasury("varrock", 500);
  Guilds.certifyChart("varrock", "Novice", "c1");
  const pr = Guilds.tryPromote("Novice");
  assert.strictEqual(pr.ok, true);
  assert.strictEqual(pr.rank, "astronomer");
  // Astronomer -> starmaster needs 60d + 4 credits + 2 conducted certs.
  const nm2 = Guilds.memberOf("Novice");
  assert.strictEqual(Guilds.tryPromote("Novice").reason, "tenure");
  nm2.joinedMs = Date.now() - 61 * 24 * 3600 * 1000;
  nm2.trainingCredits = 4;
  nm2.certificationsConducted = 2;
  Guilds.touch();
  const pr2 = Guilds.tryPromote("Novice");
  assert.strictEqual(pr2.ok, true);
  assert.strictEqual(pr2.rank, "starmaster");
  assert.ok(awardDeeds.some(([u, d]) => u === "Novice" && d === "starmaster"));
});

// --- describe ---

test("describe summarizes the guild", () => {
  assert.strictEqual(Guilds.describe("varrock").exists, false);
  careers["gazer1"] = "astronomer";
  Guilds.joinGuild("gazer1", "varrock");
  const d = Guilds.describe("varrock");
  assert.strictEqual(d.exists, true);
  assert.strictEqual(d.memberCount, 1);
  assert.strictEqual(d.treasury, 0);
  assert.ok(d.hallTile, "hall tile resolved near the observatory");
});

// --- vanishing-coins fixes: bounties and prizes reach real bank accounts ---

test("certifyChart bounty lands in the astronomer's bank account", () => {
  addAstronomer("Sky");
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 9, createdAt: 1 });
  Guilds.creditTreasury("varrock", 1000);
  const before = Guilds.guildOf("varrock").treasury;
  const res = Guilds.certifyChart("varrock", "Sky", "c1");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bountyPaid, 120);
  assert.strictEqual(res.bountyOwed, 0);
  // The coins actually moved: treasury down, bank balance up. No vanishing.
  assert.strictEqual(Guilds.guildOf("varrock").treasury, before - 120);
  assert.strictEqual(bankAccounts["sky"].balance, 120);
});

test("certifyChart with unreachable banking: treasury rolls back, bounty owed", () => {
  addAstronomer("Sky");
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 9, createdAt: 1 });
  Guilds.creditTreasury("varrock", 1000);
  const before = Guilds.guildOf("varrock").treasury;
  bankingDown = true;
  const res = Guilds.certifyChart("varrock", "Sky", "c1");
  bankingDown = false;
  // Certification itself succeeded, but the bounty was NOT marked paid.
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.bountyPaid, 0);
  assert.strictEqual(res.bountyOwed, 120);
  // Treasury intact: no coins vanished while the record claimed payment.
  assert.strictEqual(Guilds.guildOf("varrock").treasury, before);
  assert.strictEqual(bankAccounts["sky"], undefined);
  // Recovery: retry delivers once banking is back.
  const retry = Guilds.retryOwedBounties("varrock");
  assert.strictEqual(retry.paid, 120);
  assert.strictEqual(bankAccounts["sky"].balance, 120);
  assert.strictEqual(Guilds.chartCertFor(res.certId).bountyOwed, 0);
});

test("retryOwedBounties delivers to bank; unreachable banking keeps owed", () => {
  addAstronomer("Sky");
  charts.push({ id: "cB", astronomer: "Sky", kingdomId: "varrock", quality: 6, createdAt: 1 });
  // Broke treasury: owed honestly.
  const r = Guilds.certifyChart("varrock", "Sky", "cB");
  assert.strictEqual(r.bountyOwed, 60);
  // Banking down during retry: nothing delivered, treasury untouched.
  Guilds.creditTreasury("varrock", 100);
  const before = Guilds.guildOf("varrock").treasury;
  bankingDown = true;
  const retry1 = Guilds.retryOwedBounties("varrock");
  bankingDown = false;
  assert.strictEqual(retry1.paid, 0);
  assert.strictEqual(Guilds.guildOf("varrock").treasury, before);
  assert.strictEqual(Guilds.chartCertFor(r.certId).bountyOwed, 60);
  // Banking back: delivered to the real account.
  const retry2 = Guilds.retryOwedBounties("varrock");
  assert.strictEqual(retry2.paid, 60);
  assert.strictEqual(bankAccounts["sky"].balance, 60);
});

test("confirmPredictions herald prize lands in the predictor's bank account", () => {
  addAstronomer("Seer");
  const sm = Guilds.memberOf("Seer");
  sm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  Guilds.creditTreasury("varrock", 500);
  const p = Guilds.predictEvent("varrock", "Seer", "lunar_eclipse");
  assert.strictEqual(p.ok, true);
  activeEvent = "lunar_eclipse";
  const res = Guilds.confirmPredictions("varrock", p.predictedForMs + 1000);
  assert.deepStrictEqual(res.confirmed, [p.predictionId]);
  const pred = Guilds.predictionsFor("varrock")[0];
  assert.strictEqual(pred.prizePaid, Guilds.HERALD_PRIZE);
  assert.strictEqual(pred.prizeOwed, 0);
  assert.strictEqual(bankAccounts["seer"].balance, Guilds.HERALD_PRIZE);
});

test("confirmPredictions with unreachable banking: prize owed, treasury intact", () => {
  addAstronomer("Seer");
  const sm = Guilds.memberOf("Seer");
  sm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  Guilds.creditTreasury("varrock", 500);
  const before = Guilds.guildOf("varrock").treasury;
  const p = Guilds.predictEvent("varrock", "Seer", "lunar_eclipse");
  activeEvent = "lunar_eclipse";
  bankingDown = true;
  const res = Guilds.confirmPredictions("varrock", p.predictedForMs + 1000);
  bankingDown = false;
  assert.deepStrictEqual(res.confirmed, [p.predictionId]);
  const pred = Guilds.predictionsFor("varrock")[0];
  assert.strictEqual(pred.status, "confirmed"); // the sky confirmed it
  assert.strictEqual(pred.prizePaid, 0);
  assert.strictEqual(pred.prizeOwed, Guilds.HERALD_PRIZE);
  assert.strictEqual(Guilds.guildOf("varrock").treasury, before);
});

test("silver orrery prize lands in the winner's bank account", () => {
  addAstronomer("Sky");
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 9, createdAt: 1 });
  Guilds.creditTreasury("varrock", 1000);
  const cert = Guilds.certifyChart("varrock", "Sky", "c1");
  assert.strictEqual(cert.ok, true);
  // Isolate the orrery prize from the certification bounty.
  bankAccounts["sky"].balance = 0;
  Guilds.creditTreasury("varrock", 500);
  const res = Guilds.grantSilverOrrery("varrock", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.winner, "Sky");
  assert.strictEqual(res.prizePaid, 200);
  assert.strictEqual(bankAccounts["sky"].balance, 200);
});

console.log(`\n${passed} tests passed`);
