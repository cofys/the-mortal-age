"use strict";

// Plain-node tests for CitizenArtGuilds (no jest, no engine).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenArtGuilds");

function freshSave() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ag-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  return p;
}

// --- Stub the engine reads ---
const Module = require("module");
const origRequire = Module.prototype.require;

function installStubs(opts = {}) {
  const artworks = opts.artworks || {}; // id -> artwork record
  const artistWorks = opts.artistWorks || {}; // lowername -> [ids]
  const stubs = {
    "./CitizenArt": {
      QUALITY_MASTERPIECE: 85,
      artworksOf: (u) => (artistWorks[String(u || "").toLowerCase()] || []).map((id) => artworks[id]).filter(Boolean),
      artworkById: (id) => artworks[id] || null,
    },
    "./CitizenCareers": {
      careerOf: (u) => (opts.careers || {})[String(u || "").toLowerCase()] || null,
    },
    "../brain/CitizenSites": {
      siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    },
    "./CitizenReputation": {
      awardDeed: (u, deed) => { (opts.deeds = opts.deeds || []).push([u, deed]); },
    },
    "./CitizenBanking": opts.banking || {
      // Real contract: accountFor(username) -> live account record;
      // markDirty() -> persist. creditAccount does NOT exist on the engine.
      accountFor: (u) => {
        const key = String(u || "").toLowerCase().trim();
        (opts.bankAccounts = opts.bankAccounts || {})[key] =
          opts.bankAccounts[key] || { balance: 0 };
        return opts.bankAccounts[key];
      },
      markDirty: () => { opts.bankDirty = true; },
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

test("ensureGuild creates a guild per kingdom with a hall tile", () => {
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g);
  assert.strictEqual(g.kingdomId, "varrock");
  assert.ok(g.hallTile && typeof g.hallTile.x === "number");
  assert.strictEqual(g.treasury, 0);
});

test("joinGuild rejects non-artists", () => {
  const r = Guilds.joinGuild("notanartist", "varrock");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-an-artist");
});

test("joinGuild accepts artist-career citizens", () => {
  const restore = installStubs({ careers: { "painty pete": "artist" } });
  try {
    const r = Guilds.joinGuild("Painty Pete", "varrock");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.rank, Guilds.RANK_APPRENTICE);
    assert.ok(Guilds.isGuildMember("painty pete"));
    assert.strictEqual(Guilds.guildRankOf("Painty Pete"), Guilds.RANK_APPRENTICE);
  } finally { restore(); }
});

test("joinGuild accepts citizens with real artworks", () => {
  const restore = installStubs({
    artworks: { a1: { id: "a1", title: "Sunset", artist: "clay cara", quality: 70, medium: "painting" } },
    artistWorks: { "clay cara": ["a1"] },
  });
  try {
    const r = Guilds.joinGuild("Clay Cara", "varrock");
    assert.strictEqual(r.ok, true);
  } finally { restore(); }
});

test("joinGuild rejects re-join and leaveGuild removes", () => {
  const restore = installStubs({ careers: { "painty pete": "artist" } });
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    const again = Guilds.joinGuild("Painty Pete", "varrock");
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, "already-member");
    assert.strictEqual(Guilds.memberNames("varrock").length, 1);
    const left = Guilds.leaveGuild("Painty Pete");
    assert.strictEqual(left.ok, true);
    assert.ok(!Guilds.isGuildMember("painty pete"));
  } finally { restore(); }
});

test("dues: payment clears, two misses suspend", () => {
  const restore = installStubs({ careers: { "painty pete": "artist" } });
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    const now = Date.now();
    Guilds.recordDuesPayment("painty pete", now);
    assert.ok(Guilds.memberOf("painty pete").duesPaidUntilMs > now);
    Guilds.recordMissedDues("painty pete", now);
    assert.ok(!Guilds.memberOf("painty pete").suspended);
    Guilds.recordMissedDues("painty pete", now);
    assert.ok(Guilds.memberOf("painty pete").suspended);
  } finally { restore(); }
});

test("dues: payment extends banked coverage instead of resetting it", () => {
  // Regression: recordDuesPayment set duesPaidUntilMs = nowMs + PERIOD,
  // discarding any banked coverage when paid while still covered. The
  // canonical guild behavior extends from the later of existing coverage
  // or now.
  const restore = installStubs({ careers: { "painty pete": "artist" } });
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    const now = Date.now();
    const banked = now + 3 * 24 * 60 * 60 * 1000; // 3 days of coverage left
    Guilds.memberOf("painty pete").duesPaidUntilMs = banked;
    Guilds.recordDuesPayment("painty pete", now);
    const expected = banked + 7 * 24 * 60 * 60 * 1000;
    assert.strictEqual(Guilds.memberOf("painty pete").duesPaidUntilMs, expected,
      "banked coverage must be extended, not discarded");
  } finally { restore(); }
});

// === Certification ===

function certStubs() {
  return installStubs({
    careers: { "painty pete": "artist", "master moe": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset Over Varrock", artist: "painty pete", quality: 90, medium: "painting" },
      a2: { id: "a2", title: "Muddy Sketch", artist: "painty pete", quality: 40, medium: "painting" },
      a3: { id: "a3", title: "Other's Work", artist: "someone else", quality: 95, medium: "sculpture" },
    },
    artistWorks: { "painty pete": ["a1", "a2"], "someone else": ["a3"] },
  });
}

test("certifyArtwork grades from real quality", () => {
  const restore = certStubs();
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.creditTreasury("varrock", 1000);
    const r = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.grade, "A"); // 90 >= 85
    assert.strictEqual(r.bountyPaid, Guilds.CERT_BOUNTY.A);
    const r2 = Guilds.certifyArtwork("varrock", "painty pete", "a2");
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.grade, "C"); // 40 < 60
    assert.strictEqual(Guilds.gradeFor("painty pete"), "A");
  } finally { restore(); }
});

test("certifyArtwork rejects non-members and wrong artists", () => {
  const restore = certStubs();
  try {
    const r = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "not-a-member");
    Guilds.joinGuild("Painty Pete", "varrock");
    const r2 = Guilds.certifyArtwork("varrock", "painty pete", "a3");
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.reason, "not-the-artist");
  } finally { restore(); }
});

test("certifyArtwork rejects double certification", () => {
  const restore = certStubs();
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.creditTreasury("varrock", 1000);
    assert.strictEqual(Guilds.certifyArtwork("varrock", "painty pete", "a1").ok, true);
    const r = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "already-certified");
  } finally { restore(); }
});

test("certifyArtwork owes honestly when the treasury is broke", () => {
  const restore = certStubs();
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    // No treasury funding — bounty must be owed, not invented.
    const r = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bountyPaid, 0);
    assert.strictEqual(r.bountyOwed, Guilds.CERT_BOUNTY.A);
    // Funding the treasury later lets the retry pay out.
    Guilds.creditTreasury("varrock", 1000);
    const retry = Guilds.retryOwedBounties("varrock");
    assert.ok(retry.paid >= Guilds.CERT_BOUNTY.A);
  } finally { restore(); }
});

test("retryOwedBounties credits the owed bounty to the author's real bank account", () => {
  // FAIL-before: the retry deducted the treasury and marked the bounty paid,
  // but the coins never reached the author.
  const opts = {
    careers: { "painty pete": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset Over Varrock", artist: "painty pete", quality: 90, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"] },
  };
  const restore = installStubs(opts);
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    const r = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bountyPaid, 0);
    assert.strictEqual(r.bountyOwed, Guilds.CERT_BOUNTY.A);
    Guilds.creditTreasury("varrock", 1000);
    const before = ((opts.bankAccounts || {})["painty pete"] || {}).balance || 0;
    const retry = Guilds.retryOwedBounties("varrock");
    assert.ok(retry.paid >= Guilds.CERT_BOUNTY.A, `retry.paid=${retry.paid}`);
    const after = ((opts.bankAccounts || {})["painty pete"] || {}).balance || 0;
    assert.strictEqual(after, before + Guilds.CERT_BOUNTY.A,
      "the owed bounty must actually reach the author's bank account");
    assert.strictEqual(Guilds.sealFor(r.certId).bountyOwed, 0);
  } finally { restore(); }
});

test("retryOwedBounties keeps the bounty owed when banking is unreachable", () => {
  // Banking down: the retry must NOT deduct the treasury and mark paid —
  // the bounty stays owed so a later tick can deliver it.
  const opts = {
    careers: { "painty pete": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset Over Varrock", artist: "painty pete", quality: 90, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"] },
    noBanking: true,
  };
  const inner = installStubs(opts);
  // Simulate banking being unavailable: accountFor throws.
  const Module2 = require("module");
  const prev = Module2.prototype.require;
  Module2.prototype.require = function (id) {
    if (id === "./CitizenBanking") throw new Error("banking down");
    return prev.apply(this, arguments);
  };
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    const r = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    Guilds.creditTreasury("varrock", 1000);
    const treasBefore = Guilds.guildTreasuryFor("varrock").treasury;
    const retry = Guilds.retryOwedBounties("varrock");
    assert.strictEqual(retry.paid, 0, "nothing paid when banking is down");
    const cert = Guilds.sealFor(r.certId);
    assert.strictEqual(cert.bountyOwed, Guilds.CERT_BOUNTY.A, "bounty stays owed");
    assert.strictEqual(cert.bountyPaid, 0);
    assert.strictEqual(Guilds.guildTreasuryFor("varrock").treasury, treasBefore,
      "treasury untouched — no coins invented or destroyed");
  } finally {
    Module2.prototype.require = prev;
    inner();
  }
});

// === Forgery tribunal ===

test("scanForgery detects a normalized duplicate by a different artist", () => {
  const restore = installStubs({
    careers: { "painty pete": "artist", "copy cat": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset Over Varrock", artist: "painty pete", quality: 90, medium: "painting" },
      a9: { id: "a9", title: "  sunset OVER varrock! ", artist: "copy cat", quality: 88, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"], "copy cat": ["a9"] },
  });
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.joinGuild("Copy Cat", "varrock");
    Guilds.creditTreasury("varrock", 1000);
    Guilds.certifyArtwork("varrock", "painty pete", "a1");
    const r2 = Guilds.certifyArtwork("varrock", "copy cat", "a9");
    assert.strictEqual(r2.ok, true); // certification itself is fine (real artwork)
    const found = Guilds.scanForgery("sunset over varrock");
    assert.ok(found, "forgery detected");
    assert.strictEqual(found.accused.artist, "copy cat");
  } finally { restore(); }
});

test("forgery tribunal: guilty verdict expels and records the deed", () => {
  const opts = {};
  const restore = installStubs({
    careers: { "painty pete": "artist", "copy cat": "artist", "master moe": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset Over Varrock", artist: "painty pete", quality: 90, medium: "painting" },
      a9: { id: "a9", title: "sunset over varrock", artist: "copy cat", quality: 88, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"], "copy cat": ["a9"] },
  });
  // Capture deeds via a custom stub.
  Module.prototype.require = (function (prev) {
    return function (id) {
      if (id === "./CitizenReputation") {
        return { awardDeed: (u, deed) => { opts.deeds = opts.deeds || []; opts.deeds.push([u, deed]); } };
      }
      return prev.apply(this, arguments);
    };
  })(Module.prototype.require);
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.joinGuild("Copy Cat", "varrock");
    Guilds.joinGuild("Master Moe", "varrock");
    Guilds.creditTreasury("varrock", 1000);
    Guilds.certifyArtwork("varrock", "painty pete", "a1");
    Guilds.certifyArtwork("varrock", "copy cat", "a9");
    // Promote two voters to artist rank so they can vote.
    Guilds.load().members["painty pete"].rank = Guilds.RANK_ARTIST;
    Guilds.load().members["master moe"].rank = Guilds.RANK_ARTIST;
    const rep = Guilds.reportForgery("varrock", "painty pete", "Sunset Over Varrock");
    assert.strictEqual(rep.ok, true);
    assert.strictEqual(Guilds.voteOnCase(rep.caseId, "painty pete", "guilty").ok, true);
    assert.strictEqual(Guilds.voteOnCase(rep.caseId, "master moe", "guilty").ok, true);
    // A non-artist-rank member cannot vote.
    assert.strictEqual(Guilds.voteOnCase(rep.caseId, "copy cat", "innocent").ok, false);
    const res = Guilds.settleRipeCases("varrock", Date.now() + 25 * 60 * 60 * 1000);
    assert.strictEqual(res.settled.length, 1);
    const kase = Guilds.load().cases[res.settled[0]];
    assert.strictEqual(kase.verdict, "guilty");
    assert.strictEqual(kase.status, "convicted");
    assert.ok(!Guilds.isGuildMember("copy cat"), "forger expelled");
    assert.ok((opts.deeds || []).some((d) => d[0] === "copy cat" && d[1] === "forger"));
  } finally { restore(); }
});

// === Inspections, palette, patronage, school ===

test("inspectionFor scores real artwork output", () => {
  const restore = installStubs({
    careers: { "painty pete": "artist", "lazy leo": "artist" },
    artworks: { a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" } },
    artistWorks: { "painty pete": ["a1"], "lazy leo": [] },
  });
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.joinGuild("Lazy Leo", "varrock");
    const insp = Guilds.inspectionFor("varrock");
    assert.strictEqual(insp.members, 2);
    assert.strictEqual(insp.withWorks, 1);
    assert.strictEqual(insp.score, 50);
  } finally { restore(); }
});

test("grantGoldenPalette awards quarterly to the most-certified member", () => {
  const opts = {};
  const restore = installStubs({
    careers: { "painty pete": "artist" },
    artworks: {
      a1: { id: "a1", title: "One", artist: "painty pete", quality: 90, medium: "painting" },
      a2: { id: "a2", title: "Two", artist: "painty pete", quality: 70, medium: "sculpture" },
    },
    artistWorks: { "painty pete": ["a1", "a2"] },
  });
  Module.prototype.require = (function (prev) {
    return function (id) {
      if (id === "./CitizenReputation") {
        return { awardDeed: (u, deed) => { opts.deeds = opts.deeds || []; opts.deeds.push([u, deed]); } };
      }
      if (id === "./CitizenBanking") {
        return { creditAccount: (u, amt) => { opts.credits = opts.credits || []; opts.credits.push([u, amt]); return true; } };
      }
      return prev.apply(this, arguments);
    };
  })(Module.prototype.require);
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.creditTreasury("varrock", 1000);
    Guilds.certifyArtwork("varrock", "painty pete", "a1");
    Guilds.certifyArtwork("varrock", "painty pete", "a2");
    const r = Guilds.grantGoldenPalette("varrock", Date.now());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.winner, "Painty Pete");
    assert.strictEqual(r.artworks, 2);
    assert.strictEqual(r.prizePaid, Guilds.PALETTE_PRIZE);
    assert.ok((opts.deeds || []).some((d) => d[1] === "goldenpalette"));
    const treas = Guilds.guildTreasuryFor("varrock");
    // a1 is grade A (120), a2 is grade B (60); palette prize is 200.
    assert.strictEqual(treas.treasury, 1000 - Guilds.CERT_BOUNTY.A - Guilds.CERT_BOUNTY.B - Guilds.PALETTE_PRIZE);
    // Same quarter: no double award.
    assert.strictEqual(Guilds.grantGoldenPalette("varrock", Date.now()).ok, false);
  } finally { restore(); }
});

test("patronage: post, claim with a real cert, pay from treasury", () => {
  const opts = {};
  // NOTE: pass the test's own opts object (not a fresh literal): installStubs'
  // parameter shadows the outer binding, so a literal would leave this opts
  // empty and the bankAccounts/bankDirty assertions below would read undefined.
  const restore = installStubs(Object.assign(opts, {
    careers: { "painty pete": "artist", "rich rita": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"] },
  }));
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.joinGuild("Rich Rita", "varrock");
    const post = Guilds.postBounty("varrock", "rich rita", "painting", 200);
    assert.strictEqual(post.ok, true);
    Guilds.creditTreasury("varrock", 200); // sponsor's coins (taken by the command layer)
    Guilds.creditTreasury("varrock", 1000);
    const cert = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    assert.strictEqual(cert.ok, true);
    const claim = Guilds.claimBounty(post.bountyId, "painty pete", cert.certId);
    assert.strictEqual(claim.ok, true);
    const pay = Guilds.payBounty(post.bountyId);
    assert.strictEqual(pay.ok, true);
    assert.strictEqual(pay.amount, 200);
    // The patronage bounty must land in the claimant's REAL bank account
    // via accountFor — the old creditAccount mock masked a silent no-op.
    assert.strictEqual((opts.bankAccounts["painty pete"] || {}).balance, 200);
    assert.strictEqual(opts.bankDirty, true);
  } finally { restore(); }
});

test("claimBounty requires the cert to postdate the bounty", () => {
  const restore = installStubs({
    careers: { "painty pete": "artist", "rich rita": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"] },
  });
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.joinGuild("Rich Rita", "varrock");
    Guilds.creditTreasury("varrock", 1000);
    const cert = Guilds.certifyArtwork("varrock", "painty pete", "a1"); // certified FIRST
    // Backdate the cert so the ordering is deterministic (same-ms is a flake).
    Guilds.load().certifications[cert.certId].certifiedMs = Date.now() - 5000;
    const post = Guilds.postBounty("varrock", "rich rita", "painting", 200); // bounty SECOND
    const claim = Guilds.claimBounty(post.bountyId, "painty pete", cert.certId);
    assert.strictEqual(claim.ok, false);
    assert.strictEqual(claim.reason, "predates-bounty");
  } finally { restore(); }
});

test("school and promotion: credits lead apprentice to artist", () => {
  const restore = installStubs({
    careers: { "painty pete": "artist", "master moe": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"] },
  });
  try {
    Guilds.joinGuild("Master Moe", "varrock");
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.load().members["master moe"].rank = Guilds.RANK_MASTER;
    Guilds.creditTreasury("varrock", 1000);
    const cls = Guilds.holdClass("varrock", "master moe");
    assert.strictEqual(cls.ok, true);
    assert.ok(cls.taught >= 1);
    // Not enough tenure yet — no promotion.
    assert.strictEqual(Guilds.tryPromote("painty pete").ok, false);
    // Age the membership and add credits + a real cert.
    const mem = Guilds.memberOf("painty pete");
    mem.joinedMs = Date.now() - 31 * 24 * 60 * 60 * 1000;
    mem.trainingCredits = 2;
    Guilds.certifyArtwork("varrock", "painty pete", "a1");
    const promo = Guilds.tryPromote("painty pete");
    assert.strictEqual(promo.ok, true);
    assert.strictEqual(promo.rank, Guilds.RANK_ARTIST);
  } finally { restore(); }
});

test("takeApprentice waives the fee and doubles certification credit", () => {
  const restore = installStubs({
    careers: { "painty pete": "artist", "master moe": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"] },
  });
  try {
    Guilds.joinGuild("Master Moe", "varrock");
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.load().members["master moe"].rank = Guilds.RANK_MASTER;
    assert.strictEqual(Guilds.takeApprentice("master moe", "painty pete").ok, true);
    Guilds.creditTreasury("varrock", 1000);
    const cert = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    assert.strictEqual(cert.ok, true);
    assert.strictEqual(cert.fee, 0); // mentored apprentice: fee waived
    const mem = Guilds.memberOf("painty pete");
    assert.strictEqual(mem.certificationsConducted, 2); // double cert credit while mentored
  } finally { restore(); }
});

test("describe reports guild state honestly", () => {
  const restore = installStubs({ careers: { "painty pete": "artist" } });
  try {
    assert.strictEqual(Guilds.describe("nowhere").exists, false);
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.creditTreasury("varrock", 500);
    const d = Guilds.describe("varrock");
    assert.strictEqual(d.exists, true);
    assert.strictEqual(d.memberCount, 1);
    assert.strictEqual(d.treasury, 500);
  } finally { restore(); }
});

test("persistence round-trips through the save file", () => {
  const p = freshSave();
  const restore = installStubs({ careers: { "painty pete": "artist" } });
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    assert.ok(Guilds.save());
    assert.ok(fs.existsSync(p));
    // Point at a fresh empty path: member is gone.
    const p2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ag2-")), "save.json");
    Guilds._setSavePathForTests(p2);
    Guilds.resetForTests();
    assert.ok(!Guilds.isGuildMember("painty pete"));
    // Point back at the real save: member loads back.
    Guilds._setSavePathForTests(p);
    Guilds.resetForTests();
    assert.ok(Guilds.isGuildMember("painty pete"));
  } finally { restore(); }
});

test("payBounty: banking unreachable keeps coins honest (no vanishing)", () => {
  const opts = {};
  const restore = installStubs({
    careers: { "painty pete": "artist", "rich rita": "artist" },
    artworks: {
      a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
    },
    artistWorks: { "painty pete": ["a1"] },
    banking: {}, // CitizenBanking present but accountFor missing: unreachable
  });
  try {
    Guilds.joinGuild("Painty Pete", "varrock");
    Guilds.joinGuild("Rich Rita", "varrock");
    const post = Guilds.postBounty("varrock", "rich rita", "painting", 200);
    assert.strictEqual(post.ok, true);
    Guilds.creditTreasury("varrock", 1200);
    const cert = Guilds.certifyArtwork("varrock", "painty pete", "a1");
    assert.strictEqual(cert.ok, true);
    const claim = Guilds.claimBounty(post.bountyId, "painty pete", cert.certId);
    assert.strictEqual(claim.ok, true);
    const treasuryBefore = Guilds.describe("varrock").treasury;
    const pay = Guilds.payBounty(post.bountyId);
    // Must NOT report success: the coins never reached the claimant.
    assert.strictEqual(pay.ok, false);
    assert.strictEqual(pay.reason, "banking-unreachable");
    // Treasury must be restored — no coins invented, none destroyed.
    assert.strictEqual(Guilds.describe("varrock").treasury, treasuryBefore);
    // Bounty stays unpaid and fully owed, never silently marked paid.
    assert.strictEqual(pay.owed, 200);
  } finally { restore(); }
});

console.log(`\n${passed} tests passed`);
