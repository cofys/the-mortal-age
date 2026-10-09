"use strict";

/**
 * CitizenDigGuilds.test.js — guild data-tier contracts without a running server.
 * The archaeology and sites modules are stubbed in the require cache so
 * plain-node tests stay engine-free.
 *
 * Run: node server/plugins/citizens/lib/CitizenDigGuilds.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the guild module) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock", "falador"], kingdomIdOf: () => "varrock" },
};

// Controllable fake of the real CitizenArchaeology data tier.
const fakeArch = {
  archaeologists: new Set(), // lower usernames
  digs: Object.create(null), // lower -> count
  artifacts: Object.create(null), // id -> artifact
  sites: Object.create(null), // id -> site
  donations: [], // { siteId, kingdomId, id, displayedAt }
};
const archPath = path.resolve(__dirname, "./CitizenArchaeology.js");
require.cache[archPath] = {
  id: archPath, filename: archPath, loaded: true,
  exports: {
    isArchaeologist: (u) => fakeArch.archaeologists.has(String(u || "").toLowerCase()),
    digCountFor: (u) => fakeArch.digs[String(u || "").toLowerCase()] || 0,
    artifactOf: (id) => fakeArch.artifacts[String(id)] || null,
    siteOf: (id) => fakeArch.sites[String(id)] || null,
    artifactsOfOwner: (u) => Object.values(fakeArch.artifacts).filter((a) => a.owner === String(u || "").toLowerCase() && !a.donated),
    museumCollection: (kid) => fakeArch.donations.filter((d) => !kid || d.kingdomId === String(kid)),
    activeSites: (kid) => Object.values(fakeArch.sites).filter((s) => !kid || s.kingdomId === String(kid)),
    donateArtifact: (owner, id) => {
      const a = fakeArch.artifacts[String(id)];
      if (!a || a.owner !== String(owner || "").toLowerCase() || a.donated) return { ok: false };
      a.donated = true; a.displayedAt = Date.now(); a.owner = null;
      fakeArch.donations.push({ id: a.id, siteId: a.siteId, kingdomId: a.kingdomId, displayedAt: a.displayedAt });
      return { ok: true };
    },
    museumTileFor: (kid) => ({ x: 3200, y: 3200, z: 0 }),
  },
};

// --- real module under test ---

const Guilds = require("./CitizenDigGuilds");

let passed = 0;
function test(name, fn) {
  Guilds.resetForTests();
  fakeArch.archaeologists = new Set();
  fakeArch.digs = Object.create(null);
  fakeArch.artifacts = Object.create(null);
  fakeArch.sites = Object.create(null);
  fakeArch.donations = [];
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}\n${e.stack}`);
    process.exitCode = 1;
  }
}

function regArch(name, digs = 0) {
  fakeArch.archaeologists.add(String(name).toLowerCase());
  fakeArch.digs[String(name).toLowerCase()] = digs;
}

function site(id, kingdomId = "varrock", digCount = 0, foundedAt = Date.now() - 1000) {
  fakeArch.sites[id] = { id, kingdomId, digCount, foundedAt, name: `Dig at ${id}` };
}

function artifact(id, owner, siteId, opts = {}) {
  fakeArch.artifacts[id] = Object.assign({
    id, owner: String(owner).toLowerCase(), siteId,
    kingdomId: "varrock", kind: "tablet", condition: "damaged",
    value: 500, name: "damaged tablet", finder: String(owner).toLowerCase(),
    foundAt: Date.now(), donated: false,
  }, opts);
}

// --- guilds ---

test("ensureGuild creates a hall near the museum", () => {
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g.hallTile, "hall tile");
  assert.strictEqual(g.hallTile.x, 3206);
  assert.strictEqual(g.hallTile.y, 3210);
  assert.strictEqual(g.treasury, 0);
});

test("join requires a real registered archaeologist", () => {
  const r = Guilds.joinGuild("Bob", "varrock");
  assert.strictEqual(r.ok, false);
  assert.ok(/archaeologist/.test(r.reason));
  regArch("Bob");
  const r2 = Guilds.joinGuild("Bob", "varrock");
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.rank, Guilds.RANK_DIGGER);
  assert.ok(Guilds.isGuildMember("Bob"));
  assert.strictEqual(Guilds.guildRankOf("Bob"), Guilds.RANK_DIGGER);
});

test("dues payment splits treasury and conservation fund", () => {
  regArch("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const r = Guilds.recordDuesPayment("Bob", Date.now());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.treasury, 20);
  assert.strictEqual(r.fund, 5);
});

test("two missed dues suspend, payment lifts", () => {
  regArch("Bob");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.recordMissedDues("Bob");
  assert.ok(!Guilds.memberOf("Bob").suspended);
  Guilds.recordMissedDues("Bob");
  assert.ok(Guilds.memberOf("Bob").suspended);
  assert.ok(!Guilds.isGuildMember("Bob"));
  Guilds.recordDuesPayment("Bob", Date.now());
  assert.ok(!Guilds.memberOf("Bob").suspended);
  assert.ok(Guilds.isGuildMember("Bob"));
});

// --- authentication ---

test("verifyArtifact rejects non-owned and donated pieces", () => {
  regArch("Bob"); regArch("Alice");
  Guilds.joinGuild("Bob", "varrock");
  site("s1");
  artifact("a1", "alice", "s1");
  let r = Guilds.verifyArtifact("Bob", "a1");
  assert.strictEqual(r.ok, false); // not Bob's
  r = Guilds.verifyArtifact("Alice", "nope");
  assert.strictEqual(r.ok, false); // no such artifact
});

test("authenticate grades by real condition and pays bounty from real treasury", () => {
  regArch("Bob");
  Guilds.joinGuild("Bob", "varrock");
  site("s1");
  artifact("a1", "bob", "s1", { condition: "pristine", value: 900 });
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 1000;
  const paid = [];
  const res = Guilds.authenticateArtifact("Bob", "a1",
    () => true, // fee taken
    (who, coins) => { paid.push(coins); return true; });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.grade, "A");
  assert.strictEqual(res.bounty, 120);
  assert.deepStrictEqual(paid, [120]);
  assert.strictEqual(g.treasury, 1000 + 50 - 120); // fee in, bounty out
  assert.strictEqual(Guilds.authGradeFor("a1"), "A");
  assert.ok(Guilds.sealFor("a1"));
});

test("authentication bounty owed honestly when treasury broke", () => {
  regArch("Bob");
  Guilds.joinGuild("Bob", "varrock");
  site("s1");
  artifact("a1", "bob", "s1", { condition: "damaged", value: 400 });
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 0;
  const res = Guilds.authenticateArtifact("Bob", "a1", () => true, () => true);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.grade, "B");
  assert.strictEqual(res.owed, 60); // honestly owed, never invented
  assert.strictEqual(g.treasury, 50); // fee still landed
});

test("protected-site finds earn double bounty", () => {
  regArch("Bob");
  const j = Guilds.joinGuild("Bob", "varrock");
  assert.strictEqual(j.ok, true);
  site("s1", "varrock", 9); // 9 digs, 0 donations -> looted on inspection
  Guilds.inspectSite("s1");
  Guilds.inspectSite("s1");
  assert.ok(Guilds.isProtectedSite("s1"));
  artifact("a1", "bob", "s1", { condition: "damaged", value: 400 });
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 1000;
  const fees = [];
  const res = Guilds.authenticateArtifact("Bob", "a1",
    (who, coins) => { fees.push(coins); return true; },
    () => true);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.protected, true);
  assert.strictEqual(res.bounty, 120); // doubled from 60
  assert.deepStrictEqual(fees, [50]); // fee still applies (only mentored diggers are waived)
});

test("mentored diggers pay no fee and earn double credit", () => {
  regArch("Bob"); regArch("Master");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Master", "varrock");
  Guilds.memberOf("Master").rank = Guilds.RANK_CONSERVATOR;
  const t = Guilds.takeApprentice("Master", "Bob");
  assert.strictEqual(t.ok, true);
  site("s1");
  artifact("a1", "bob", "s1", { condition: "fragmented", value: 200 });
  const fees = [];
  const res = Guilds.authenticateArtifact("Bob", "a1",
    (who, coins) => { fees.push(coins); return true; }, () => true);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(fees, []); // fee waived
  assert.strictEqual(Guilds.memberOf("Bob").authCount, 2); // double credit
});

test("retryOwedBounties pays when the treasury refills", () => {
  regArch("Bob");
  Guilds.joinGuild("Bob", "varrock");
  site("s1");
  artifact("a1", "bob", "s1", { condition: "damaged", value: 400 });
  Guilds.ensureGuild("varrock").treasury = 0;
  const res = Guilds.authenticateArtifact("Bob", "a1", () => true, () => true);
  assert.strictEqual(res.owed, 60);
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 500;
  const paid = [];
  const n = Guilds.retryOwedBounties("varrock", (who, coins) => { paid.push(coins); return true; });
  assert.strictEqual(n, 60);
  assert.deepStrictEqual(paid, [60]);
});

// --- forgery tribunal ---

test("scanForgery catches phantom sites and impossible dates", () => {
  site("s1", "varrock", 0, Date.now() - 5000);
  artifact("a1", "bob", "s1", { foundAt: Date.now() }); // fine
  artifact("a2", "bob", "nope", { foundAt: Date.now() }); // phantom site
  artifact("a3", "bob", "s1", { foundAt: Date.now() - 99999999 }); // impossible date
  assert.strictEqual(Guilds.scanForgery("a1"), null);
  assert.strictEqual(Guilds.scanForgery("a2"), "phantom site");
  assert.strictEqual(Guilds.scanForgery("a3"), "impossible date");
});

test("forgery report, vote, conviction expels and confiscates", () => {
  regArch("Bob"); regArch("Con1"); regArch("Con2");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Con1", "varrock");
  Guilds.joinGuild("Con2", "varrock");
  Guilds.memberOf("Con1").rank = Guilds.RANK_CONSERVATOR;
  Guilds.memberOf("Con2").rank = Guilds.RANK_CONSERVATOR;
  artifact("a9", "bob", "nope", { value: 500 }); // phantom site = forged
  const rep = Guilds.reportForgery("varrock", "a9", "Con1");
  assert.strictEqual(rep.ok, true);
  assert.strictEqual(rep.kind, "phantom site");
  // double jeopardy
  const rep2 = Guilds.reportForgery("varrock", "a9", "Con2");
  assert.strictEqual(rep2.ok, false);
  // non-conservator cannot vote
  const v0 = Guilds.voteOnCase(rep.id, "Bob", true);
  assert.strictEqual(v0.ok, false);
  assert.strictEqual(Guilds.voteOnCase(rep.id, "Con1", true).ok, true);
  assert.strictEqual(Guilds.voteOnCase(rep.id, "Con2", true).ok, true);
  const settled = Guilds.settleRipeCases("varrock", Date.now() + 25 * 3600 * 1000);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].guilty, true);
  assert.ok(!Guilds.memberOf("Bob"), "expelled");
  assert.ok(fakeArch.artifacts.a9.donated, "confiscated to the museum");
});

test("acquittal leaves the member standing", () => {
  regArch("Bob"); regArch("Con1"); regArch("Con2");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Con1", "varrock");
  Guilds.joinGuild("Con2", "varrock");
  Guilds.memberOf("Con1").rank = Guilds.RANK_CONSERVATOR;
  Guilds.memberOf("Con2").rank = Guilds.RANK_CONSERVATOR;
  artifact("a9", "bob", "nope", { value: 500 });
  const rep = Guilds.reportForgery("varrock", "a9", "Con1");
  Guilds.voteOnCase(rep.id, "Con1", false);
  Guilds.voteOnCase(rep.id, "Con2", false);
  const settled = Guilds.settleRipeCases("varrock", Date.now() + 25 * 3600 * 1000);
  assert.strictEqual(settled[0].guilty, false);
  assert.ok(Guilds.memberOf("Bob"), "still a member");
});

// --- conservation ---

test("inspectSite flags looted sites and protects after two flags", () => {
  site("s1", "varrock", 9); // 9 digs, 0 donations
  let r = Guilds.inspectSite("s1");
  assert.strictEqual(r.result, "FLAG");
  assert.ok(/looted/.test(r.reasons.join(" ")));
  assert.ok(!r.protected);
  r = Guilds.inspectSite("s1");
  assert.ok(r.protected);
  assert.ok(Guilds.isProtectedSite("s1"));
  assert.deepStrictEqual(Guilds.protectedSites("varrock"), ["s1"]);
});

test("inspectSite passes healthy sites", () => {
  site("s1", "varrock", 9);
  fakeArch.donations.push({ id: "a1", siteId: "s1", kingdomId: "varrock", displayedAt: Date.now() });
  const r = Guilds.inspectSite("s1");
  assert.strictEqual(r.result, "PASS");
});

// --- school / promotion ---

test("promotion digger->excavator needs tenure, credits, real digs", () => {
  regArch("Bob", 5);
  Guilds.joinGuild("Bob", "varrock");
  const m = Guilds.memberOf("Bob");
  m.joinedAt = Date.now() - 31 * 24 * 3600 * 1000;
  m.trainingCredits = 2;
  const el = Guilds.canPromote("Bob");
  assert.strictEqual(el.ok, true);
  assert.strictEqual(el.to, Guilds.RANK_EXCAVATOR);
  const p = Guilds.promote("Bob");
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.rank, Guilds.RANK_EXCAVATOR);
});

test("promotion blocked without real digs", () => {
  regArch("Bob", 2); // only 2 real digs
  Guilds.joinGuild("Bob", "varrock");
  const m = Guilds.memberOf("Bob");
  m.joinedAt = Date.now() - 31 * 24 * 3600 * 1000;
  m.trainingCredits = 2;
  const el = Guilds.canPromote("Bob");
  assert.strictEqual(el.ok, false);
  assert.ok(/digs/.test(el.reason));
});

test("promotion excavator->conservator needs authentications", () => {
  regArch("Bob", 9);
  Guilds.joinGuild("Bob", "varrock");
  const m = Guilds.memberOf("Bob");
  m.rank = Guilds.RANK_EXCAVATOR;
  m.joinedAt = Date.now() - 61 * 24 * 3600 * 1000;
  m.trainingCredits = 4;
  m.authCount = 2; // needs 3
  assert.strictEqual(Guilds.canPromote("Bob").ok, false);
  m.authCount = 3;
  const el = Guilds.canPromote("Bob");
  assert.strictEqual(el.ok, true);
  assert.strictEqual(Guilds.promote("Bob").rank, Guilds.RANK_CONSERVATOR);
});

test("holdClass teaches diggers and excavators", () => {
  regArch("Bob"); regArch("Al"); regArch("Master");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Al", "varrock");
  Guilds.joinGuild("Master", "varrock");
  Guilds.memberOf("Master").rank = Guilds.RANK_CONSERVATOR;
  Guilds.memberOf("Al").rank = Guilds.RANK_EXCAVATOR;
  const r = Guilds.holdClass("varrock", "Master");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.taught, 2);
  assert.strictEqual(Guilds.memberOf("Bob").trainingCredits, 1);
});

test("contribute grows the conservation fund with real coins", () => {
  regArch("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const r = Guilds.contribute("Bob", 200, () => true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fund, 200);
});

test("describe reports the guild honestly", () => {
  regArch("Bob");
  Guilds.joinGuild("Bob", "varrock");
  const d = Guilds.describe("varrock");
  assert.strictEqual(d.exists, true);
  assert.strictEqual(d.memberCount, 1);
  assert.strictEqual(d.treasury, 0);
});

test("leaveGuild removes membership and mentorship", () => {
  regArch("Bob"); regArch("Master");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Master", "varrock");
  Guilds.memberOf("Master").rank = Guilds.RANK_CONSERVATOR;
  Guilds.takeApprentice("Master", "Bob");
  assert.strictEqual(Guilds.mentoredBy("Bob"), "master");
  Guilds.leaveGuild("Bob");
  assert.ok(!Guilds.memberOf("Bob"));
  assert.strictEqual(Guilds.mentoredBy("Bob"), null);
});

console.log(`CitizenDigGuilds: ${passed} tests passed`);
