"use strict";

/**
 * CitizenSportsGuilds.test.js — guild data-tier contracts without a running server.
 * The athletics, sites, careers, and reputation modules are stubbed in the
 * require cache so plain-node tests stay engine-free.
 *
 * Run: node server/plugins/citizens/lib/CitizenSportsGuilds.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- stubs (must be installed before requiring the guild module) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock", "falador"], kingdomIdOf: () => "varrock" },
};

// Controllable fake of the real CitizenAthletics data tier.
const fakeAthletics = {
  athletes: new Set(), // lower usernames
  records: Object.create(null), // "kingdomId:sport" -> record
};
const athleticsPath = path.resolve(__dirname, "./CitizenAthletics.js");
require.cache[athleticsPath] = {
  id: athleticsPath, filename: athleticsPath, loaded: true,
  exports: {
    SPORTS: ["running", "wrestling", "archery", "racing"],
    isAthlete: (u) => fakeAthletics.athletes.has(String(u || "").toLowerCase()),
    athleteInfo: (u) => {
      const n = String(u || "").toLowerCase();
      return fakeAthletics.athletes.has(n) ? { name: u, sport: "running", fitness: 60, skill: 10, trainedAt: Date.now() } : null;
    },
    recordFor: (kid, sport) => fakeAthletics.records[`${kid}:${sport}`] || null,
    stadiumTile: (kid) => ({ x: 3200, y: 3200, z: 0 }),
  },
};

// Controllable fake of the real CitizenBanking data tier. Real contract:
// accountFor(username) -> live account record; markDirty() persists.
// bankingDown simulates unreachable banking. Without this stub the guild
// module would load the REAL banking tier and pollute its save file.
let bankingDown = false;
const bankAccounts = {}; // lowername -> { balance }
const bankingPath = path.resolve(__dirname, "./CitizenBanking.js");
require.cache[bankingPath] = {
  id: bankingPath, filename: bankingPath, loaded: true,
  exports: {
    accountFor: (u) => {
      if (bankingDown) throw new Error("banking unreachable");
      const key = String(u || "").toLowerCase().trim();
      if (!bankAccounts[key]) bankAccounts[key] = { balance: 0 };
      return bankAccounts[key];
    },
    markDirty: () => {},
  },
};

// --- real module under test ---

const Guilds = require("./CitizenSportsGuilds.js");

function fresh() {
  Guilds.resetForTests();
  fakeAthletics.athletes = new Set();
  fakeAthletics.records = Object.create(null);
  for (const k of Object.keys(bankAccounts)) delete bankAccounts[k];
  bankingDown = false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sportsguild-"));
  Guilds.setSaveFile(path.join(tmp, "save.json"));
}

function addAthlete(name) {
  fakeAthletics.athletes.add(String(name).toLowerCase());
}

function setRecord(kingdomId, sport, holder, mark) {
  fakeAthletics.records[`${kingdomId}:${sport}`] = { holder, mark, at: Date.now() };
}

let passed = 0;
function test(name, fn) {
  fresh();
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// --- guilds ---

test("ensureGuild creates a guild with hall near stadium", () => {
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g.hallTile, "hall tile set");
  assert.strictEqual(g.treasury, 0);
  assert.strictEqual(g.medicalFund, 0);
});

test("join requires a real registered athlete", () => {
  const r1 = Guilds.joinGuild("Bob", "varrock");
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, "not-an-athlete");
  addAthlete("Bob");
  const r2 = Guilds.joinGuild("Bob", "varrock");
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.rank, "rookie");
});

test("join is idempotent — no double membership", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const r = Guilds.joinGuild("Bob", "varrock");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "already-member");
});

test("leave removes membership", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  assert.ok(Guilds.isGuildMember("Bob"));
  Guilds.leaveGuild("Bob");
  assert.ok(!Guilds.isGuildMember("Bob"));
});

test("dues payment credits treasury and medical fund", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const res = Guilds.recordDuesPayment("Bob", Date.now());
  assert.strictEqual(res.ok, true);
  const g = Guilds.guildOf("varrock");
  assert.strictEqual(g.treasury, 20); // 25 - 5
  assert.strictEqual(g.medicalFund, 5);
});

test("two missed dues suspend the member", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.recordMissedDues("Bob", Date.now());
  assert.ok(!Guilds.memberOf("Bob").suspended);
  Guilds.recordMissedDues("Bob", Date.now());
  assert.ok(Guilds.memberOf("Bob").suspended);
});

// --- record certification ---

test("certify rejects when no real record exists", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const res = Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "no-such-record");
});

test("certify rejects another athlete's record", () => {
  addAthlete("Bob"); addAthlete("Alice");
  Guilds.joinGuild("Bob", "varrock");
  setRecord("varrock", "running", "Alice", 250);
  const res = Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not-your-record");
});

test("certify grades from the real mark and pays the bounty", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  setRecord("varrock", "running", "Bob", 250); // B grade
  const g = Guilds.guildOf("varrock");
  g.treasury = 1000;
  const sub = Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  assert.strictEqual(sub.ok, true);
  assert.strictEqual(sub.fee, 50);
  const res = Guilds.settleCertification("varrock", "running", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.grade, "B");
  assert.strictEqual(res.bounty, 120); // B:60 doubled for home kingdom
  assert.strictEqual(res.paid, 120);
  assert.strictEqual(Guilds.gradeFor("varrock", "running"), "B");
});

test("certify grades A for elite marks", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  setRecord("varrock", "running", "Bob", 350);
  const g = Guilds.guildOf("varrock");
  g.treasury = 1000;
  Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  const res = Guilds.settleCertification("varrock", "running", Date.now());
  assert.strictEqual(res.grade, "A");
  assert.strictEqual(res.bounty, 240); // A:120 doubled
});

test("broke treasury owes the bounty honestly", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  setRecord("varrock", "running", "Bob", 150); // C grade
  const sub = Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  assert.strictEqual(sub.ok, true);
  const res = Guilds.settleCertification("varrock", "running", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.paid, 0);
  assert.strictEqual(res.owed, 60); // C:30 doubled
});

test("retryOwedBounties pays when funds refill", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  setRecord("varrock", "running", "Bob", 150);
  Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  Guilds.settleCertification("varrock", "running", Date.now());
  const g = Guilds.guildOf("varrock");
  g.treasury = 100;
  const res = Guilds.retryOwedBounties("varrock");
  assert.ok(res.paid > 0);
});

// --- doping tribunal ---

test("scanDoping finds phantom records", () => {
  setRecord("varrock", "running", "Ghost", 250); // Ghost is not a registered athlete
  const hits = Guilds.scanDoping();
  assert.ok(hits.some((h) => h.kind === "phantom-record" && h.holder === "Ghost"));
});

test("scanDoping finds impossible marks", () => {
  addAthlete("Bob");
  setRecord("varrock", "running", "Bob", -5);
  const hits = Guilds.scanDoping();
  assert.ok(hits.some((h) => h.kind === "impossible-mark"));
});

test("scanDoping passes clean records", () => {
  addAthlete("Bob");
  setRecord("varrock", "running", "Bob", 250);
  const hits = Guilds.scanDoping();
  assert.strictEqual(hits.length, 0);
});

test("tribunal convicts with quorum and expels", () => {
  addAthlete("Bob"); addAthlete("Ann"); addAthlete("Cat");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Ann", "varrock");
  Guilds.joinGuild("Cat", "varrock");
  // Promote Ann and Cat to gamesmaster via direct rank set (test shortcut).
  Guilds.memberOf("Ann").rank = Guilds.RANK_GAMESMASTER;
  Guilds.memberOf("Cat").rank = Guilds.RANK_GAMESMASTER;
  const rep = Guilds.reportDoping("varrock", "Bob", "phantom-record", "Ann");
  assert.strictEqual(rep.ok, true);
  Guilds.voteCase(rep.id, "Ann", true);
  Guilds.voteCase(rep.id, "Cat", true);
  const settled = Guilds.settleRipeCases("varrock", Date.now() + 25 * 60 * 60 * 1000);
  assert.strictEqual(settled[0].verdict, "guilty");
  assert.ok(Guilds.memberOf("Bob").suspended);
});

test("tribunal acquits without quorum", () => {
  addAthlete("Bob"); addAthlete("Ann");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Ann", "varrock");
  Guilds.memberOf("Ann").rank = Guilds.RANK_GAMESMASTER;
  const rep = Guilds.reportDoping("varrock", "Bob", "phantom-record", "Ann");
  Guilds.voteCase(rep.id, "Ann", true);
  const settled = Guilds.settleRipeCases("varrock", Date.now() + 25 * 60 * 60 * 1000);
  assert.strictEqual(settled[0].verdict, "acquitted");
});

test("no double jeopardy — one open case per accused", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const r1 = Guilds.reportDoping("varrock", "Bob", "phantom-record", "guild");
  assert.strictEqual(r1.ok, true);
  const r2 = Guilds.reportDoping("varrock", "Bob", "impossible-mark", "guild");
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, "case-open");
});

// --- training camps ---

test("postCamp requires minimum bounty", () => {
  const r = Guilds.postCamp("Sponsor", "falador", 50);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "bounty-too-low");
});

test("claimCamp requires verifiable training proof", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const post = Guilds.postCamp("Sponsor", "falador", 200);
  assert.strictEqual(post.ok, true);
  // No training proof yet — claim fails honestly.
  const c1 = Guilds.claimCamp(post.id, "Bob");
  assert.strictEqual(c1.ok, false);
  assert.strictEqual(c1.reason, "no-training-proof");
  // Record training AFTER the bounty posted.
  Guilds.recordTraining("Bob", "falador", Date.now() + 1000);
  const c2 = Guilds.claimCamp(post.id, "Bob");
  assert.strictEqual(c2.ok, true);
  assert.strictEqual(c2.bounty, 200);
});

// --- school / promotion / mentorship ---

test("holdClass teaches rookies", () => {
  addAthlete("Bob"); addAthlete("Ann");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Ann", "varrock");
  Guilds.memberOf("Ann").rank = Guilds.RANK_GAMESMASTER;
  const res = Guilds.holdClass("varrock", "Ann");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.taught, 1);
  assert.strictEqual(Guilds.memberOf("Bob").trainingCredits, 1);
});

test("takeApprentice waives fees and doubles credit", () => {
  addAthlete("Bob"); addAthlete("Ann");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Ann", "varrock");
  Guilds.memberOf("Ann").rank = Guilds.RANK_GAMESMASTER;
  const res = Guilds.takeApprentice("Ann", "Bob");
  assert.strictEqual(res.ok, true);
  setRecord("varrock", "running", "Bob", 250);
  const g = Guilds.guildOf("varrock");
  g.treasury = 1000;
  const sub = Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  assert.strictEqual(sub.fee, 0); // mentored: free
  Guilds.settleCertification("varrock", "running", Date.now());
  assert.strictEqual(Guilds.memberOf("Bob").certCount, 2); // double credit
});

// --- persistence / describe ---

test("save and load round-trip", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  assert.strictEqual(Guilds.save(), true);
  const snap = Guilds.serialize();
  Guilds.resetForTests();
  assert.ok(!Guilds.isGuildMember("Bob"));
  Guilds.deserialize(snap);
  assert.ok(Guilds.isGuildMember("Bob"));
});

test("describe reports guild stats", () => {
  addAthlete("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const d = Guilds.describe("varrock");
  assert.strictEqual(d.exists, true);
  assert.strictEqual(d.memberCount, 1);
});

// --- golden laurel: vanishing-coins regressions ---

function sealRecordForLaurel(name) {
  addAthlete(name);
  Guilds.joinGuild(name, "varrock");
  setRecord("varrock", "running", name, 250);
  Guilds.guildOf("varrock").treasury = 1000;
  assert.strictEqual(Guilds.submitRecord(name, "varrock", "running", Date.now()).ok, true);
  assert.strictEqual(Guilds.settleCertification("varrock", "running", Date.now()).ok, true);
  // The certification bounty (B grade, doubled for the home kingdom = 120)
  // already landed in the winner's bank account via the fixed cert path.
  return 120;
}

test("grantLaurel credits the winner's real bank account", () => {
  const certBounty = sealRecordForLaurel("Flash");
  Guilds.guildOf("varrock").treasury = 1000;
  const before = Guilds.guildOf("varrock").treasury;
  const r = Guilds.grantLaurel("varrock", Date.now());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.winner, "Flash");
  assert.strictEqual(r.paid, Guilds.LAUREL_PRIZE);
  assert.strictEqual(r.owed, 0);
  // The prize lands in the winner's REAL bank account — never vanishes.
  assert.strictEqual(Guilds.guildOf("varrock").treasury, before - Guilds.LAUREL_PRIZE);
  assert.strictEqual(bankAccounts["flash"].balance, certBounty + Guilds.LAUREL_PRIZE);
});

test("grantLaurel with unreachable banking: treasury intact, prize honestly owed", () => {
  const certBounty = sealRecordForLaurel("Flash");
  Guilds.guildOf("varrock").treasury = 1000;
  bankingDown = true;
  const r = Guilds.grantLaurel("varrock", Date.now());
  bankingDown = false;
  assert.strictEqual(r.ok, true);
  // The laurel was awarded but the prize was NOT marked paid: no coins
  // vanished while the record claimed payment.
  assert.strictEqual(r.paid, 0);
  assert.strictEqual(r.owed, Guilds.LAUREL_PRIZE);
  assert.strictEqual(Guilds.guildOf("varrock").treasury, 1000);
  assert.strictEqual(bankAccounts["flash"].balance, certBounty);
  // Recovery: retry delivers the owed prize to the winner's bank account.
  const retry = Guilds.retryLaurelOwed("varrock");
  assert.strictEqual(retry.paid, Guilds.LAUREL_PRIZE);
  assert.strictEqual(bankAccounts["flash"].balance, certBounty + Guilds.LAUREL_PRIZE);
  assert.strictEqual(Guilds.guildOf("varrock").treasury, 1000 - Guilds.LAUREL_PRIZE);
});

test("retryLaurelOwed is partial-honest and survives banking outages", () => {
  const certBounty = sealRecordForLaurel("Flash");
  // Short treasury: partial prize paid, rest owed honestly.
  Guilds.guildOf("varrock").treasury = 80;
  const r = Guilds.grantLaurel("varrock", Date.now());
  assert.strictEqual(r.paid, 80);
  assert.strictEqual(r.owed, Guilds.LAUREL_PRIZE - 80);
  assert.strictEqual(bankAccounts["flash"].balance, certBounty + 80);
  // Banking down during retry: nothing delivered, treasury untouched.
  Guilds.guildOf("varrock").treasury = 500;
  bankingDown = true;
  const retry1 = Guilds.retryLaurelOwed("varrock");
  bankingDown = false;
  assert.strictEqual(retry1.paid, 0);
  assert.strictEqual(Guilds.guildOf("varrock").treasury, 500);
  // Banking back: remainder delivered to the winner's bank account.
  const retry2 = Guilds.retryLaurelOwed("varrock");
  assert.strictEqual(retry2.paid, Guilds.LAUREL_PRIZE - 80);
  assert.strictEqual(bankAccounts["flash"].balance, certBounty + Guilds.LAUREL_PRIZE);
});

console.log(`\n${passed} tests passed.`);
