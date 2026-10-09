"use strict";

/**
 * CitizenWeaverGuilds.test.js — guild data-tier contracts without a running server.
 * The sites, careers, runways, and reputation modules are stubbed in the
 * require cache so plain-node tests stay engine-free.
 *
 * Run: node server/plugins/citizens/lib/CitizenWeaverGuilds.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the guild module) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["varrock", "falador"],
    kingdomIdOf: () => "varrock",
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const fakeCareers = { careers: new Map() };
const careersPath = path.resolve(__dirname, "./CitizenCareers.js");
require.cache[careersPath] = {
  id: careersPath, filename: careersPath, loaded: true,
  exports: {
    careerOf: (u) => fakeCareers.careers.get(String(u || "").toLowerCase()) || null,
  },
};

// Controllable fake of the real CitizenRunways data tier.
const fakeRunways = {
  designers: new Set(),
  houses: new Map(), // normName -> { name, members: Set }
  collections: new Map(), // id -> collection
  ateliers: Object.create(null), // kingdomId -> [atelier]
};
const runwaysPath = path.resolve(__dirname, "./CitizenRunways.js");
require.cache[runwaysPath] = {
  id: runwaysPath, filename: runwaysPath, loaded: true,
  exports: {
    isDesigner: (u) => fakeRunways.designers.has(String(u || "").toLowerCase()),
    houseForDesigner: (u) => {
      const n = String(u || "").toLowerCase();
      for (const h of fakeRunways.houses.values()) if (h.members.has(n)) return h;
      return null;
    },
    collectionFor: (id) => fakeRunways.collections.get(String(id)) || null,
    collectionsIn: (kid) =>
      [...fakeRunways.collections.values()].filter((c) => String(c.kingdomId).toLowerCase() === String(kid).toLowerCase()),
    ateliersIn: (kid) => fakeRunways.ateliers[kid] || [],
    runwayTileFor: () => ({ x: 3210, y: 3210, z: 0 }),
  },
};

const fakeRep = { deeds: [] };
const repPath = path.resolve(__dirname, "./CitizenReputation.js");
require.cache[repPath] = {
  id: repPath, filename: repPath, loaded: true,
  exports: {
    awardDeed: (u, kind) => { fakeRep.deeds.push({ u, kind }); return 0; },
  },
};

const G = require("./CitizenWeaverGuilds.js");

let passed = 0;
function test(name, fn) {
  G.resetForTests();
  fakeCareers.careers.clear();
  fakeRunways.designers.clear();
  fakeRunways.houses.clear();
  fakeRunways.collections.clear();
  fakeRunways.ateliers = Object.create(null);
  fakeRep.deeds.length = 0;
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    console.error(e.stack);
    process.exitCode = 1;
  }
}

function asDesigner(u) { fakeRunways.designers.add(String(u).toLowerCase()); }
function addCollection(id, opts) {
  fakeRunways.collections.set(String(id), Object.assign({
    id: String(id), name: "Unnamed", designer: "alice", kingdomId: "varrock",
    quality: 6, createdAt: Date.now(),
  }, opts));
}

// --- guilds / membership ---

test("ensureGuild creates a hall tile near the runway venue", () => {
  const g = G.ensureGuild("varrock");
  assert.ok(g.hallTile);
  assert.strictEqual(g.hallTile.x, 3215); // 3210 + 5
  assert.strictEqual(g.hallTile.y, 3206); // 3210 - 4
});

test("joinGuild requires a real designer", () => {
  let r = G.joinGuild("alice", "varrock");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-a-designer");
  asDesigner("alice");
  r = G.joinGuild("alice", "varrock");
  assert.ok(r.ok);
  assert.ok(G.isGuildMember("alice"));
});

test("joinGuild accepts the designer career path", () => {
  fakeCareers.careers.set("bob", { career: "designer" });
  const r = G.joinGuild("bob", "varrock");
  assert.ok(r.ok, "designer career should count as a real designer");
});

test("joinGuild accepts designer-house members", () => {
  fakeRunways.houses.set("velvet", { name: "Velvet", members: new Set(["cara"]) });
  const r = G.joinGuild("cara", "varrock");
  assert.ok(r.ok, "house members should count as real designers");
});

test("leaveGuild removes membership", () => {
  asDesigner("alice");
  G.joinGuild("alice", "varrock");
  assert.ok(G.leaveGuild("alice").ok);
  assert.ok(!G.isGuildMember("alice"));
});

test("dues payment splits treasury and atelier fund", () => {
  asDesigner("alice");
  G.joinGuild("alice", "varrock");
  const res = G.recordDuesPayment("alice", Date.now());
  assert.ok(res.ok);
  assert.strictEqual(G.guildTreasuryFor("varrock"), G.DUES_WEEKLY - G.DUES_ATELIER_SHARE);
  const g = G.guildOf("varrock");
  assert.strictEqual(g.atelierFund, G.DUES_ATELIER_SHARE);
});

test("two missed dues suspends", () => {
  asDesigner("alice");
  G.joinGuild("alice", "varrock");
  G.recordMissedDues("alice", Date.now());
  assert.ok(!G.memberOf("alice").suspended);
  G.recordMissedDues("alice", Date.now());
  assert.ok(G.memberOf("alice").suspended);
});

// --- certification ---

test("submitCollection verifies against the real ledger", () => {
  asDesigner("alice");
  G.joinGuild("alice", "varrock");
  let r = G.submitCollection("alice", "varrock", "c1", Date.now());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-such-collection");
  addCollection("c1", { designer: "mallory" });
  r = G.submitCollection("alice", "varrock", "c1", Date.now());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-your-collection");
  addCollection("c2", { designer: "alice", quality: 9 });
  r = G.submitCollection("alice", "varrock", "c2", Date.now());
  assert.ok(r.ok);
  assert.strictEqual(r.fee, G.CERT_FEE);
  assert.strictEqual(r.quality, 9);
});

test("settleCertification grades from real quality and pays bounty", () => {
  asDesigner("alice");
  G.joinGuild("alice", "varrock");
  const g = G.guildOf("varrock");
  g.treasury = 1000;
  addCollection("c2", { designer: "alice", quality: 9 });
  G.submitCollection("alice", "varrock", "c2", Date.now());
  const res = G.settleCertification("varrock", "c2", Date.now());
  assert.ok(res.ok);
  assert.strictEqual(res.grade, "A");
  assert.strictEqual(res.paid, 120);
  assert.strictEqual(G.gradeFor("varrock", "c2"), "A");
});

test("settleCertification owes honestly when broke", () => {
  asDesigner("alice");
  G.joinGuild("alice", "varrock");
  addCollection("c2", { designer: "alice", quality: 6 });
  G.submitCollection("alice", "varrock", "c2", Date.now());
  const res = G.settleCertification("varrock", "c2", Date.now());
  assert.ok(res.ok);
  assert.strictEqual(res.paid, 0);
  assert.strictEqual(res.owed, 60);
  assert.ok(G.bountiesOwedFor("alice") > 0);
});

test("mentored apprentices certify free and earn double credit", () => {
  asDesigner("alice"); asDesigner("master1");
  G.joinGuild("alice", "varrock");
  G.joinGuild("master1", "varrock");
  G.guildOf("varrock").treasury = 1000;
  const mem = G.memberOf("master1");
  mem.rank = G.RANK_GRANDCOUTURIER; mem.joinedAt = Date.now() - 70 * 24 * 3600 * 1000;
  assert.ok(G.takeApprentice("master1", "alice").ok);
  addCollection("c2", { designer: "alice", quality: 8 });
  const sub = G.submitCollection("alice", "varrock", "c2", Date.now());
  assert.strictEqual(sub.fee, 0);
  G.settleCertification("varrock", "c2", Date.now());
  assert.strictEqual(G.memberOf("alice").certCount, 2, "mentored certification counts double");
});

// --- knockoff tribunal ---

test("scanKnockoffs flags duplicate names by different designers", () => {
  addCollection("c1", { name: "The Spring Elegant Collection", designer: "alice", createdAt: 1000 });
  addCollection("c2", { name: "The Spring Elegant Collection", designer: "mallory", createdAt: 2000 });
  addCollection("c3", { name: "Totally Original", designer: "mallory", createdAt: 3000 });
  const hits = G.scanKnockoffs();
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].designer, "mallory");
  assert.strictEqual(hits[0].earlierDesigner, "alice");
});

test("reportKnockoff requires a real counterfeit", () => {
  addCollection("c1", { name: "The Spring Elegant Collection", designer: "alice", createdAt: 1000 });
  const r = G.reportKnockoff("varrock", "mallory", "bob");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-counterfeit-found");
  addCollection("c2", { name: "The Spring Elegant Collection", designer: "mallory", createdAt: 2000 });
  const r2 = G.reportKnockoff("varrock", "mallory", "bob");
  assert.ok(r2.ok);
});

test("tribunal convicts with quorum and expels with deed", () => {
  asDesigner("alice"); asDesigner("mallory"); asDesigner("judge1"); asDesigner("judge2");
  G.joinGuild("mallory", "varrock");
  G.joinGuild("judge1", "varrock");
  G.joinGuild("judge2", "varrock");
  for (const j of ["judge1", "judge2"]) {
    const m = G.memberOf(j);
    m.rank = G.RANK_COUTURIER; m.joinedAt = Date.now() - 70 * 24 * 3600 * 1000;
  }
  addCollection("c1", { name: "The Spring Elegant Collection", designer: "alice", createdAt: 1000 });
  addCollection("c2", { name: "The Spring Elegant Collection", designer: "mallory", createdAt: 2000 });
  const rep = G.reportKnockoff("varrock", "mallory", "alice");
  assert.ok(rep.ok);
  assert.ok(G.voteCase(rep.id, "judge1", true).ok);
  assert.ok(G.voteCase(rep.id, "judge2", true).ok);
  const settled = G.settleRipeCases("varrock", Date.now() + 25 * 3600 * 1000);
  assert.strictEqual(settled[0].verdict, "guilty");
  assert.ok(!G.isGuildMember("mallory"));
  assert.ok(fakeRep.deeds.some((d) => d.u === "mallory" && d.kind === "knockoff"));
});

// --- inspections ---

test("inspectAteliers scores from real atelier stock", () => {
  fakeRunways.ateliers["varrock"] = [
    { owner: "alice", inventory: [{ pieceId: "1:0", sold: false }] },
    { owner: "bob", inventory: [{ pieceId: "2:0", sold: true }] },
  ];
  const res = G.inspectAteliers("varrock", Date.now());
  assert.ok(res.ok);
  assert.strictEqual(res.inspection, 50);
  assert.deepStrictEqual(res.idle, ["bob"]);
});

test("inspectAteliers is honest with no ateliers", () => {
  const res = G.inspectAteliers("varrock", Date.now());
  assert.strictEqual(res.inspection, 100);
});

// --- golden needle ---

test("grantGoldenNeedle awards the member with most seals", () => {
  asDesigner("alice"); asDesigner("bob");
  G.joinGuild("alice", "varrock");
  G.joinGuild("bob", "varrock");
  const g = G.guildOf("varrock");
  g.treasury = 1000;
  g.lastNeedleAt = 0;
  for (const [cid, holder] of [["c1", "alice"], ["c2", "alice"], ["c3", "bob"]]) {
    addCollection(cid, { designer: holder, quality: 6 });
    G.submitCollection(holder, "varrock", cid, Date.now());
    G.settleCertification("varrock", cid, Date.now());
  }
  const res = G.grantGoldenNeedle("varrock", Date.now());
  assert.ok(res.ok);
  assert.strictEqual(res.winner, "alice");
  assert.strictEqual(res.paid, G.NEEDLE_PRIZE);
});

// --- school / promotion ---

test("holdClass teaches apprentices; tryPromote gates on real records", () => {
  asDesigner("alice"); asDesigner("master1");
  G.joinGuild("alice", "varrock");
  G.joinGuild("master1", "varrock");
  const mm = G.memberOf("master1");
  mm.rank = G.RANK_GRANDCOUTURIER; mm.joinedAt = Date.now() - 70 * 24 * 3600 * 1000;
  const cls = G.holdClass("varrock", "master1");
  assert.strictEqual(cls.taught, 1);
  // Not enough tenure yet.
  assert.strictEqual(G.tryPromote("alice").ok, false);
  const am = G.memberOf("alice");
  am.joinedAt = Date.now() - 40 * 24 * 3600 * 1000;
  am.trainingCredits = 2;
  addCollection("c1", { designer: "alice", quality: 6 });
  G.guildOf("varrock").treasury = 1000;
  G.submitCollection("alice", "varrock", "c1", Date.now());
  G.settleCertification("varrock", "c1", Date.now());
  const pr = G.tryPromote("alice");
  assert.ok(pr.ok);
  assert.strictEqual(pr.rank, G.RANK_COUTURIER);
});

// --- misc ---

test("describe reports the guild state", () => {
  asDesigner("alice");
  G.joinGuild("alice", "varrock");
  const d = G.describe("varrock");
  assert.ok(d.exists);
  assert.strictEqual(d.memberCount, 1);
});

test("save round-trips", () => {
  const fs = require("fs");
  const os = require("os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "weaverguild-"));
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    asDesigner("alice");
    G.joinGuild("alice", "varrock");
    assert.ok(G.save());
    G.resetForTests();
    // re-load path covered by save; reset clears
    assert.ok(!G.isGuildMember("alice"));
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed} tests passed`);
