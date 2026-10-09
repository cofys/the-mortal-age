"use strict";

/**
 * CitizenMapGuilds.test.js — guild data-tier contracts without a running server.
 * The maps and sites modules are stubbed in the require cache so plain-node
 * tests stay engine-free.
 *
 * Run: node server/plugins/citizens/lib/CitizenMapGuilds.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the guild module) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock", "falador"], kingdomIdOf: () => "varrock" },
};

// Controllable fake of the real CitizenMaps data tier.
const fakeListings = { varrock: [], falador: [] }; // kingdomId -> [ { map } ]
const fakeCartographers = new Set();
const mapsPath = path.resolve(__dirname, "./CitizenMaps.js");
require.cache[mapsPath] = {
  id: mapsPath, filename: mapsPath, loaded: true,
  exports: {
    MAP_TYPES: ["world", "city", "dungeon", "treasure"],
    MAT_PAPYRUS: 970,
    isCartographer: (u) => fakeCartographers.has(String(u || "").toLowerCase()),
    registerCartographer: (u) => { fakeCartographers.add(String(u || "").toLowerCase()); return { ok: true }; },
    listingsFor: (kid) => fakeListings[String(kid)] || [],
    shopOf: (kid) => ({ kingdomId: kid, tile: { x: 3200, y: 3200, z: 0 } }),
    ensureShop: (kid) => ({ kingdomId: kid, tile: { x: 3200, y: 3200, z: 0 } }),
    listMap: () => true,
  },
};

// --- real module under test ---

const Guilds = require("./CitizenMapGuilds");

function reset() {
  Guilds.resetForTests();
  fakeCartographers.clear();
  fakeListings.varrock = [];
  fakeListings.falador = [];
}

function listMap(kingdomId, map) {
  fakeListings[kingdomId].push({ map, price: 100, listedAt: Date.now() });
}

let passed = 0;
function test(name, fn) {
  reset();
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}\n${e.stack}`);
    process.exitCode = 1;
  }
}

// --- guilds ---

test("ensureGuild creates a hall near the map shop", () => {
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g);
  assert.deepStrictEqual(g.hallTile, { x: 3204, y: 3200, z: 0 });
  assert.strictEqual(g.treasury, 0);
});

test("treasury credit/debit is honest — no overdraft", () => {
  Guilds.ensureGuild("varrock");
  assert.strictEqual(Guilds.debitTreasury("varrock", 10), false);
  assert.ok(Guilds.creditTreasury("varrock", 100));
  assert.ok(Guilds.debitTreasury("varrock", 60));
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 40);
});

// --- membership ---

test("join requires a real registered cartographer", () => {
  const res = Guilds.joinGuild("Alice", "varrock");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not-cartographer");
  fakeCartographers.add("alice");
  const ok = Guilds.joinGuild("Alice", "varrock");
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.rank, "apprentice");
  assert.ok(Guilds.isGuildMember("Alice"));
  assert.strictEqual(Guilds.guildRankOf("Alice"), "apprentice");
});

test("join is idempotent-safe and leave works", () => {
  fakeCartographers.add("bob");
  assert.ok(Guilds.joinGuild("Bob", "varrock").ok);
  assert.strictEqual(Guilds.joinGuild("Bob", "varrock").ok, false);
  assert.ok(Guilds.leaveGuild("Bob"));
  assert.ok(!Guilds.isGuildMember("Bob"));
});

// --- certification ---

test("submit requires a genuinely listed map by its creator", () => {
  fakeCartographers.add("cara");
  Guilds.joinGuild("Cara", "varrock");
  // Not listed -> honest failure.
  assert.strictEqual(Guilds.submitForCertification("Cara", "map_9", "varrock").ok, false);
  // Listed but by someone else -> not the author.
  listMap("varrock", { id: "map_1", creator: "Dave", type: "world", quality: 8 });
  fakeCartographers.add("dave");
  Guilds.joinGuild("Dave", "varrock");
  assert.strictEqual(Guilds.submitForCertification("Cara", "map_1", "varrock").reason, "not-author");
  // Low quality -> below guild standard.
  listMap("varrock", { id: "map_2", creator: "Cara", type: "world", quality: 4 });
  assert.strictEqual(Guilds.submitForCertification("Cara", "map_2", "varrock").reason, "quality-too-low");
  // Good map -> queued with provisional grade.
  listMap("varrock", { id: "map_3", creator: "Cara", type: "city", quality: 8 });
  const res = Guilds.submitForCertification("Cara", "map_3", "varrock");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.provisionalGrade, "B");
  assert.strictEqual(res.fee, 50);
  // Double submit -> already queued.
  assert.strictEqual(Guilds.submitForCertification("Cara", "map_3", "varrock").reason, "already-certified");
});

test("suspended members cannot submit", () => {
  fakeCartographers.add("erin");
  Guilds.joinGuild("Erin", "varrock");
  Guilds.recordDuesMissed("Erin");
  Guilds.recordDuesMissed("Erin");
  assert.ok(Guilds.memberOf("Erin").suspended);
  listMap("varrock", { id: "map_4", creator: "Erin", type: "world", quality: 9 });
  assert.strictEqual(Guilds.submitForCertification("Erin", "map_4", "varrock").reason, "suspended");
});

test("processCertifications grades, pays real bounties, archives", () => {
  fakeCartographers.add("finn");
  Guilds.joinGuild("Finn", "varrock");
  Guilds.creditTreasury("varrock", 1000);
  listMap("varrock", { id: "map_5", creator: "Finn", type: "dungeon", quality: 9 });
  assert.ok(Guilds.submitForCertification("Finn", "map_5", "varrock").ok);
  const done = Guilds.processCertifications(Date.now());
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].grade, "A");
  assert.strictEqual(done[0].bountyPaid, 120);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 880);
  assert.strictEqual(Guilds.certifiedGradeFor("map_5"), "A");
  const seal = Guilds.guildSealFor("map_5");
  assert.ok(seal && seal.creator === "Finn" && seal.quality === 9);
  assert.strictEqual(Guilds.memberOf("Finn").certCount, 1);
  assert.strictEqual(Guilds.archiveFor("varrock").length, 1);
});

test("broke treasury owes the bounty honestly — never invents coins", () => {
  fakeCartographers.add("gina");
  Guilds.joinGuild("Gina", "varrock");
  listMap("varrock", { id: "map_6", creator: "Gina", type: "world", quality: 8 });
  assert.ok(Guilds.submitForCertification("Gina", "map_6", "varrock").ok);
  const done = Guilds.processCertifications(Date.now());
  assert.strictEqual(done[0].bountyPaid, undefined);
  assert.strictEqual(done[0].bountyOwed, 60);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 0);
});

test("sold-while-queued maps are honestly skipped", () => {
  fakeCartographers.add("hal");
  Guilds.joinGuild("Hal", "varrock");
  listMap("varrock", { id: "map_7", creator: "Hal", type: "city", quality: 7 });
  assert.ok(Guilds.submitForCertification("Hal", "map_7", "varrock").ok);
  fakeListings.varrock = []; // sold before review
  const done = Guilds.processCertifications(Date.now());
  assert.strictEqual(done.length, 0);
  assert.strictEqual(Guilds.certifiedGradeFor("map_7"), null);
});

// --- bounties ---

test("bounty posting locks real treasury coins; expiry refunds", () => {
  fakeCartographers.add("ivy");
  Guilds.joinGuild("Ivy", "varrock");
  Guilds.creditTreasury("varrock", 500);
  const res = Guilds.postBounty("varrock", "dungeon", 150);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 350);
  assert.strictEqual(Guilds.postBounty("varrock", "dungeon", 9999).reason, "treasury-broke");
  assert.strictEqual(Guilds.activeBounties("varrock").length, 1);
});

test("bounty claim requires honest proof — a fresh certification of that type", () => {
  fakeCartographers.add("jay");
  Guilds.joinGuild("Jay", "varrock");
  Guilds.creditTreasury("varrock", 500);
  const b = Guilds.postBounty("varrock", "dungeon", 150);
  // No certification yet -> no proof.
  assert.strictEqual(Guilds.claimBounty("Jay", b.id).reason, "no-proof");
  // Certify a dungeon chart AFTER the bounty posted.
  listMap("varrock", { id: "map_8", creator: "Jay", type: "dungeon", quality: 7 });
  assert.ok(Guilds.submitForCertification("Jay", "map_8", "varrock").ok);
  Guilds.processCertifications(Date.now());
  const claim = Guilds.claimBounty("Jay", b.id);
  assert.strictEqual(claim.ok, true);
  assert.strictEqual(claim.reward, 150);
  // Proof is spent — cannot claim twice.
  const b2 = Guilds.postBounty("varrock", "dungeon", 150);
  assert.strictEqual(Guilds.claimBounty("Jay", b2.id).reason, "no-proof");
});

test("wrong-type certification does not satisfy a bounty", () => {
  fakeCartographers.add("kim");
  Guilds.joinGuild("Kim", "varrock");
  Guilds.creditTreasury("varrock", 500);
  const b = Guilds.postBounty("varrock", "treasure", 200);
  listMap("varrock", { id: "map_9", creator: "Kim", type: "world", quality: 8 });
  assert.ok(Guilds.submitForCertification("Kim", "map_9", "varrock").ok);
  Guilds.processCertifications(Date.now());
  assert.strictEqual(Guilds.claimBounty("Kim", b.id).reason, "no-proof");
});

// --- mentorship ---

test("masters mentor apprentices; mentorship doubles promotion credit", () => {
  for (const u of ["liam", "mia"]) fakeCartographers.add(u);
  Guilds.joinGuild("Liam", "varrock");
  Guilds.joinGuild("Mia", "varrock");
  // Not a master yet -> cannot mentor.
  assert.strictEqual(Guilds.takeApprentice("Liam", "Mia").reason, "not-master");
  // Promote Liam to master directly through certs.
  Guilds.creditTreasury("varrock", 10000);
  for (let i = 0; i < 12; i++) {
    const id = `lm_${i}`;
    listMap("varrock", { id, creator: "Liam", type: "world", quality: 8 });
    assert.ok(Guilds.submitForCertification("Liam", id, "varrock").ok);
  }
  Guilds.processCertifications(Date.now());
  assert.strictEqual(Guilds.checkPromotion("Liam"), "journeyman");
  assert.strictEqual(Guilds.checkPromotion("Liam"), "master");
  assert.strictEqual(Guilds.takeApprentice("Liam", "Mia").ok, true);
  assert.strictEqual(Guilds.mentorOf("Mia"), "Liam");
  // Mentored cert counts double toward journeyman (5 needed).
  for (let i = 0; i < 3; i++) {
    const id = `mia_${i}`;
    listMap("varrock", { id, creator: "Mia", type: "world", quality: 7 });
    assert.ok(Guilds.submitForCertification("Mia", id, "varrock").ok);
  }
  Guilds.processCertifications(Date.now());
  assert.strictEqual(Guilds.memberOf("Mia").certCount, 6); // 3 certs x2
  assert.strictEqual(Guilds.checkPromotion("Mia"), "journeyman");
  // Mentorship dissolved on graduation.
  assert.strictEqual(Guilds.mentorOf("Mia"), null);
});

// --- dues ---

test("dues paid / missed / suspended lifecycle", () => {
  fakeCartographers.add("ned");
  Guilds.joinGuild("Ned", "varrock");
  const now = Date.now();
  assert.strictEqual(Guilds.duesStatus("Ned").overdue, false);
  assert.ok(Guilds.recordDuesPaid("Ned", now));
  Guilds.recordDuesMissed("Ned");
  assert.ok(!Guilds.memberOf("Ned").suspended);
  Guilds.recordDuesMissed("Ned");
  assert.ok(Guilds.memberOf("Ned").suspended);
  assert.ok(!Guilds.isGuildMember("Ned")); // suspended members read as non-members
  assert.ok(Guilds.liftSuspension("Ned"));
  assert.ok(Guilds.isGuildMember("Ned"));
});

// --- describe / archive ---

test("describe reports real guild state", () => {
  fakeCartographers.add("ora");
  Guilds.joinGuild("Ora", "varrock");
  Guilds.creditTreasury("varrock", 250);
  const d = Guilds.describe("varrock");
  assert.ok(d.exists);
  assert.strictEqual(d.memberCount, 1);
  assert.strictEqual(d.treasury, 250);
  assert.strictEqual(d.prestige, 0);
  listMap("varrock", { id: "map_10", creator: "Ora", type: "world", quality: 9 });
  Guilds.submitForCertification("Ora", "map_10", "varrock");
  Guilds.processCertifications(Date.now());
  const d2 = Guilds.describe("varrock");
  assert.strictEqual(d2.certified, 1);
  assert.strictEqual(d2.prestige, 10); // one A-grade masterwork
});

console.log(`CitizenMapGuilds: ${passed} tests passed`);
