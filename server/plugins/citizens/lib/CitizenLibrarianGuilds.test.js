"use strict";

// Plain-node tests for CitizenLibrarianGuilds (no jest, no engine).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenLibrarianGuilds");

function freshSave() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lg-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  return p;
}

// --- Stub the engine reads ---
const Module = require("module");
const origRequire = Module.prototype.require;

function installStubs(opts = {}) {
  const books = opts.books || {}; // id -> book record
  const authorBooks = opts.authorBooks || {}; // lowername -> [ids]
  const archives = opts.archives || {}; // kingdomId -> [archive records]
  const stubs = {
    "./CitizenLibraries": {
      booksIn: (kid) => Object.values(books).filter((b) => b.kingdomId === kid),
      bookById: (id) => books[id] || null,
      archivesIn: (kid) => archives[kid] || [],
      isLibrarian: (u) => !!((opts.librarians || {})[String(u || "").toLowerCase()]),
      libraryTile: () => ({ x: 3200, y: 3200, z: 0 }),
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
    "./CitizenBanking": {
      // Real contract: accountFor(username) -> live account record,
      // markDirty() -> persist. creditAccount does NOT exist.
      accountFor: (u) => {
        const key = String(u || "").toLowerCase().trim();
        (opts.bankAccounts = opts.bankAccounts || {})[key] =
          (opts.bankAccounts || {})[key] || { balance: 0 };
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
    process.exitCode = 1;
  } finally {
    restore();
  }
}

function withStubs(opts, fn) {
  return () => {
    const restore = installStubs(opts);
    try { fn(); } finally { restore(); }
  };
}

// --- Membership ---

test("join requires a real librarian", () => {
  assert.strictEqual(Guilds.joinGuild("Nolag", "misthalin").ok, false);
  assert.strictEqual(Guilds.joinGuild("Nolag", "misthalin").reason, "not-a-librarian");
});

test("join works for the librarian career and for ledger librarians", withStubs(
  { careers: { alice: "librarian" }, librarians: { bob: true } },
  () => {
    assert.strictEqual(Guilds.joinGuild("Alice", "misthalin").ok, true);
    assert.strictEqual(Guilds.guildRankOf("Alice"), Guilds.RANK_PAGE);
    assert.strictEqual(Guilds.joinGuild("Bob", "misthalin").ok, true);
    assert.strictEqual(Guilds.joinGuild("Alice", "misthalin").ok, false); // already member
    assert.strictEqual(Guilds.leaveGuild("Bob").ok, true);
    assert.strictEqual(Guilds.isGuildMember("Bob"), false);
  }
));

test("dues: payment extends, two misses suspend", withStubs({ careers: { alice: "librarian" } }, () => {
  Guilds.joinGuild("Alice", "misthalin");
  const m = Guilds.memberOf("Alice");
  Guilds.recordDuesPayment("Alice", Date.now() + 8 * 24 * 3600 * 1000);
  assert.strictEqual(Guilds.memberOf("Alice").missedDues, 0);
  Guilds.recordMissedDues("Alice", Date.now());
  assert.strictEqual(Guilds.memberOf("Alice").suspended, false);
  Guilds.recordMissedDues("Alice", Date.now());
  assert.strictEqual(Guilds.memberOf("Alice").suspended, true);
  Guilds.recordDuesPayment("Alice", Date.now());
  assert.strictEqual(Guilds.memberOf("Alice").suspended, false); // caught up lifts it
}));

// --- Book certification ---

function bookStubs(books) {
  return withStubs({ careers: { alice: "librarian" }, books }, () => {});
}

test("certify verifies real authorship and grades from real quality", () => {
  const restore = installStubs({
    careers: { alice: "librarian", mallory: "librarian" },
    books: {
      "book-1": { id: "book-1", title: "A History of Misthalin", subject: "history", author: "alice", kingdomId: "misthalin", quality: 9 },
      "book-2": { id: "book-2", title: "Stolen Words", subject: "history", author: "mallory", kingdomId: "misthalin", quality: 4 },
    },
  });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    const r = Guilds.certifyBook("misthalin", "Alice", "book-1");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.grade, "A"); // quality 9
    assert.strictEqual(r.fee, Guilds.CERT_FEE);
    // Cannot certify someone else's book.
    assert.strictEqual(Guilds.certifyBook("misthalin", "Alice", "book-2").ok, false);
    // Cannot certify a book that does not exist.
    assert.strictEqual(Guilds.certifyBook("misthalin", "Alice", "book-zzz").ok, false);
    // No double-certification.
    assert.strictEqual(Guilds.certifyBook("misthalin", "Alice", "book-1").ok, false);
    assert.strictEqual(Guilds.gradeFor("Alice"), "A");
  } finally { restore(); }
});

test("certify grades B and C honestly", () => {
  const restore = installStubs({
    careers: { alice: "librarian" },
    books: {
      "book-1": { id: "book-1", title: "Mediocre Tales", subject: "lore", author: "alice", kingdomId: "misthalin", quality: 6 },
      "book-2": { id: "book-2", title: "Poor Pamphlet", subject: "lore", author: "alice", kingdomId: "misthalin", quality: 2 },
    },
  });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    assert.strictEqual(Guilds.certifyBook("misthalin", "Alice", "book-1").grade, "B");
    assert.strictEqual(Guilds.certifyBook("misthalin", "Alice", "book-2").grade, "C");
  } finally { restore(); }
});

test("bounty is owed honestly when the treasury is broke", () => {
  const restore = installStubs({
    careers: { alice: "librarian" },
    books: { "book-1": { id: "book-1", title: "Great Work", subject: "lore", author: "alice", kingdomId: "misthalin", quality: 9 } },
  });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    const r = Guilds.certifyBook("misthalin", "Alice", "book-1");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bountyOwed, Guilds.CERT_BOUNTY.A); // treasury empty
    Guilds.creditTreasury("misthalin", 120);
    const retry = Guilds.retryOwedBounties("misthalin");
    assert.strictEqual(retry.paid, 120);
    assert.strictEqual(Guilds.sealFor(r.certId).bountyOwed, 0);
  } finally { restore(); }
});

test("retryOwedBounties credits the owed bounty to the author's real bank account", () => {
  // FAIL-before: the retry deducted the treasury and marked the bounty paid,
  // but the coins never reached the author's bank account.
  const opts = {
    careers: { alice: "librarian" },
    books: { "book-1": { id: "book-1", title: "Great Work", subject: "lore", author: "alice", kingdomId: "misthalin", quality: 9 } },
  };
  const restore = installStubs(opts);
  try {
    Guilds.joinGuild("Alice", "misthalin");
    const r = Guilds.certifyBook("misthalin", "Alice", "book-1");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bountyPaid, 0);
    assert.strictEqual(r.bountyOwed, Guilds.CERT_BOUNTY.A);
    Guilds.creditTreasury("misthalin", 120);
    const before = ((opts.bankAccounts || {}).alice || {}).balance || 0;
    const retry = Guilds.retryOwedBounties("misthalin");
    assert.strictEqual(retry.paid, 120);
    const after = ((opts.bankAccounts || {}).alice || {}).balance || 0;
    assert.strictEqual(after, before + Guilds.CERT_BOUNTY.A,
      "the owed bounty must actually reach the author's bank account");
    assert.strictEqual(Guilds.sealFor(r.certId).bountyOwed, 0);
  } finally { restore(); }
});

// --- Plagiarism tribunal ---

test("plagiarism scan finds normalized-title duplicates by a different author", () => {
  const restore = installStubs({
    careers: { alice: "librarian", mallory: "librarian", warden: "librarian" },
    books: {
      "book-1": { id: "book-1", title: "Chronicles of Kings", subject: "history", author: "alice", kingdomId: "misthalin", quality: 8 },
      "book-2": { id: "book-2", title: "Chronicles  of   KINGS!", subject: "history", author: "mallory", kingdomId: "misthalin", quality: 3 },
    },
  });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    Guilds.joinGuild("Mallory", "misthalin");
    const c1 = Guilds.certifyBook("misthalin", "Alice", "book-1");
    assert.strictEqual(c1.ok, true);
    const c2 = Guilds.certifyBook("misthalin", "Mallory", "book-2");
    assert.strictEqual(c2.ok, true);
    const found = Guilds.scanPlagiarism("Chronicles of Kings");
    assert.ok(found);
    assert.strictEqual(found.accused.author, "Mallory");
    const rep = Guilds.reportPlagiarism("misthalin", "Warden", "Chronicles of Kings");
    assert.strictEqual(rep.ok, true);
    // Duplicate report is rejected (no double jeopardy).
    assert.strictEqual(Guilds.reportPlagiarism("misthalin", "Warden", "Chronicles of Kings").ok, false);
  } finally { restore(); }
});

test("tribunal convicts on guilty majority and expels the plagiarist", () => {
  const opts = { careers: { alice: "librarian", mallory: "librarian", warden: "librarian", judge: "librarian" }, books: {} };
  const restore = installStubs(opts);
  try {
    Guilds.joinGuild("Alice", "misthalin");
    Guilds.joinGuild("Mallory", "misthalin");
    Guilds.joinGuild("Warden", "misthalin");
    Guilds.joinGuild("Judge", "misthalin");
    // Promote Warden and Judge to librarian rank so they can vote.
    Guilds.memberOf("Warden").rank = Guilds.RANK_LIBRARIAN;
    Guilds.memberOf("Judge").rank = Guilds.RANK_LIBRARIAN;
    // Seed a certified duplicate pair directly.
    const now = Date.now();
    const st = Guilds.load();
    st.certifications["cert-1"] = { id: "cert-1", kingdomId: "misthalin", author: "Alice", title: "Stolen Tales", subject: "lore", quality: 8, grade: "A", certifiedMs: now - 1000 };
    st.certifications["cert-2"] = { id: "cert-2", kingdomId: "misthalin", author: "Mallory", title: "Stolen Tales", subject: "lore", quality: 2, grade: "C", certifiedMs: now };
    Guilds.touch();
    const rep = Guilds.reportPlagiarism("misthalin", "Alice", "Stolen Tales");
    assert.strictEqual(rep.ok, true);
    // Pages cannot vote.
    assert.strictEqual(Guilds.voteOnCase(rep.caseId, "Alice", "guilty").ok, false);
    assert.strictEqual(Guilds.voteOnCase(rep.caseId, "Warden", "guilty").ok, true);
    assert.strictEqual(Guilds.voteOnCase(rep.caseId, "Judge", "guilty").ok, true);
    const settled = Guilds.settleRipeCases("misthalin", now + 25 * 3600 * 1000);
    assert.deepStrictEqual(settled.settled, [rep.caseId]);
    assert.strictEqual(Guilds.isGuildMember("Mallory"), false); // expelled
    assert.deepStrictEqual(opts.deeds, [["Mallory", "plagiarist"]]);
  } finally { restore(); }
});

// --- Scriptorium inspections ---

test("inspection score comes from real member book output", () => {
  const restore = installStubs({
    careers: { alice: "librarian", bob: "librarian" },
    books: { "book-1": { id: "book-1", title: "Real Book", subject: "lore", author: "alice", kingdomId: "misthalin", quality: 7 } },
  });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    Guilds.joinGuild("Bob", "misthalin");
    const insp = Guilds.inspectionFor("misthalin");
    assert.strictEqual(insp.score, 50);
    assert.strictEqual(insp.members, 2);
    assert.strictEqual(insp.withWorks, 1);
    assert.strictEqual(insp.idle, 1);
  } finally { restore(); }
});

// --- Archive seals ---

test("sealArchives needs archivist rank and real archive coverage", () => {
  const archives = {
    misthalin: [
      { id: "a1", event: "war-declared", subject: "war", writtenAt: 1 },
      { id: "a2", event: "election-held", subject: "election", writtenAt: 2 },
      { id: "a3", event: "champion-crowned", subject: "champion", writtenAt: 3 },
      { id: "a4", event: "war-ended", subject: "war", writtenAt: 4 },
      { id: "a5", event: "treaty-ratified", subject: "treaty", writtenAt: 5 },
    ],
  };
  const restore = installStubs({ careers: { alice: "librarian" }, archives });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    // Not an archivist yet.
    assert.strictEqual(Guilds.sealArchives("misthalin", "Alice").ok, false);
    Guilds.memberOf("Alice").rank = Guilds.RANK_ARCHIVIST;
    const r = Guilds.sealArchives("misthalin", "Alice");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.archiveCount, 5);
    assert.ok(r.subjects.includes("war"));
    assert.ok(Guilds.sealStatus("misthalin"));
    assert.strictEqual(Guilds.describe("misthalin").sealed, true);
  } finally { restore(); }
});

test("sealArchives fails on too-few archives", () => {
  const restore = installStubs({ careers: { alice: "librarian" }, archives: { misthalin: [{ id: "a1", event: "x", subject: "war", writtenAt: 1 }] } });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    Guilds.memberOf("Alice").rank = Guilds.RANK_ARCHIVIST;
    assert.strictEqual(Guilds.sealArchives("misthalin", "Alice").reason, "too-few-records");
  } finally { restore(); }
});

// --- Restricted Index ---

test("restricted index: propose, vote, restrict bars certification", () => {
  const books = {
    "book-1": { id: "book-1", title: "Dangerous Ideas", subject: "politics", author: "alice", kingdomId: "misthalin", quality: 9 },
  };
  const restore = installStubs({ careers: { alice: "librarian", warden: "librarian", judge: "librarian" }, books });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    Guilds.joinGuild("Warden", "misthalin");
    Guilds.joinGuild("Judge", "misthalin");
    Guilds.memberOf("Warden").rank = Guilds.RANK_ARCHIVIST;
    Guilds.memberOf("Judge").rank = Guilds.RANK_LIBRARIAN;
    Guilds.memberOf("Alice").rank = Guilds.RANK_LIBRARIAN;
    // Only archivists may propose.
    assert.strictEqual(Guilds.proposeRestriction("misthalin", "Alice", "Dangerous Ideas").ok, false);
    assert.strictEqual(Guilds.proposeRestriction("misthalin", "Warden", "Dangerous Ideas").ok, true);
    assert.strictEqual(Guilds.voteOnRestriction("Dangerous Ideas", "Judge", "restrict").ok, true);
    assert.strictEqual(Guilds.voteOnRestriction("Dangerous Ideas", "Warden", "restrict").ok, true);
    const settled = Guilds.settleRipeRestrictions("misthalin", Date.now() + 25 * 3600 * 1000);
    assert.deepStrictEqual(settled.settled.length, 1);
    assert.strictEqual(Guilds.isRestricted("Dangerous Ideas"), true);
    // Indexed books cannot be certified.
    assert.strictEqual(Guilds.certifyBook("misthalin", "Alice", "book-1").reason, "restricted");
    assert.deepStrictEqual(Guilds.restrictedList("misthalin").length, 1);
  } finally { restore(); }
});

// --- Golden quill ---

test("golden quill: funded treasury credits the winner's bank account", () => {
  const opts = { careers: { alice: "librarian" }, books: {} };
  const restore = installStubs(opts);
  try {
    Guilds.joinGuild("Alice", "misthalin");
    const st = Guilds.load();
    st.certifications["cert-1"] = { id: "cert-1", kingdomId: "misthalin", author: "Alice", title: "A", subject: "lore", quality: 8, grade: "A", certifiedMs: 1 };
    Guilds.touch();
    Guilds.creditTreasury("misthalin", 1000);
    const r = Guilds.grantGoldenQuill("misthalin", Date.now());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.winner, "Alice");
    assert.strictEqual(r.prizePaid, Guilds.QUILL_PRIZE);
    assert.strictEqual(r.prizeOwed, 0);
    // Vanishing-coins regression: the bank balance actually moved.
    assert.strictEqual((opts.bankAccounts || {})["alice"]?.balance, Guilds.QUILL_PRIZE);
  } finally { restore(); }
});

test("golden quill goes to the most-certified member", () => {
  const opts = { careers: { alice: "librarian", bob: "librarian" }, books: {} };
  const restore = installStubs(opts);
  try {
    Guilds.joinGuild("Alice", "misthalin");
    Guilds.joinGuild("Bob", "misthalin");
    const st = Guilds.load();
    st.certifications["cert-1"] = { id: "cert-1", kingdomId: "misthalin", author: "Alice", title: "A", subject: "lore", quality: 8, grade: "A", certifiedMs: 1 };
    st.certifications["cert-2"] = { id: "cert-2", kingdomId: "misthalin", author: "Alice", title: "B", subject: "lore", quality: 6, grade: "B", certifiedMs: 2 };
    st.certifications["cert-3"] = { id: "cert-3", kingdomId: "misthalin", author: "Bob", title: "C", subject: "lore", quality: 9, grade: "A", certifiedMs: 3 };
    Guilds.touch();
    const r = Guilds.grantGoldenQuill("misthalin", Date.now());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.winner, "Alice");
    assert.strictEqual(r.books, 2);
    assert.strictEqual(r.prizeOwed, Guilds.QUILL_PRIZE); // broke treasury
    assert.deepStrictEqual(opts.deeds, [["Alice", "goldenquill"]]);
    // Too soon to award again.
    assert.strictEqual(Guilds.grantGoldenQuill("misthalin", Date.now()).ok, false);
  } finally { restore(); }
});

// --- Scriptorium board ---

test("scriptorium bounty: post, claim, pay", () => {
  const opts = { careers: { alice: "librarian", sponsor: "librarian" }, books: {} };
  const restore = installStubs(opts);
  try {
    Guilds.joinGuild("Alice", "misthalin");
    const b = Guilds.postBounty("misthalin", "Sponsor", "history", 500);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(Guilds.postBounty("misthalin", "Sponsor", "history", 50).ok, false); // min 100
    Guilds.creditTreasury("misthalin", 500); // sponsor funds held by the guild
    const st = Guilds.load();
    st.certifications["cert-1"] = {
      id: "cert-1", kingdomId: "misthalin", author: "Alice", title: "Real History",
      subject: "history", quality: 8, grade: "A", certifiedMs: Date.now(),
    };
    Guilds.touch();
    const claim = Guilds.claimBounty(b.bountyId, "Alice", "cert-1");
    assert.strictEqual(claim.ok, true);
    const pay = Guilds.payBounty(b.bountyId);
    assert.strictEqual(pay.ok, true);
    assert.strictEqual(pay.amount, 500);
    // The bounty really lands in the claimant's bank account (real
    // accountFor/markDirty contract — creditAccount does not exist).
    assert.strictEqual((opts.bankAccounts || {}).alice.balance, 500);
    assert.strictEqual(opts.bankDirty, true);
    // Cannot claim twice.
    assert.strictEqual(Guilds.claimBounty(b.bountyId, "Alice", "cert-1").ok, false);
  } finally { restore(); }
});

test("bounty claim rejected for wrong subject", () => {
  const restore = installStubs({ careers: { alice: "librarian" }, books: {} });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    const b = Guilds.postBounty("misthalin", "Sponsor", "history", 500);
    const st = Guilds.load();
    st.certifications["cert-1"] = {
      id: "cert-1", kingdomId: "misthalin", author: "Alice", title: "Lore Tome",
      subject: "lore", quality: 8, grade: "A", certifiedMs: Date.now(),
    };
    Guilds.touch();
    assert.strictEqual(Guilds.claimBounty(b.bountyId, "Alice", "cert-1").reason, "wrong-subject");
  } finally { restore(); }
});

// --- School & mentorship ---

test("school, mentorship, and promotion chain", () => {
  const restore = installStubs({ careers: { archie: "librarian", page: "librarian" }, books: {} });
  try {
    Guilds.joinGuild("Archie", "misthalin");
    Guilds.joinGuild("Page", "misthalin");
    Guilds.memberOf("Archie").rank = Guilds.RANK_ARCHIVIST;
    const cls = Guilds.holdClass("misthalin", "Archie");
    assert.strictEqual(cls.ok, true);
    assert.strictEqual(cls.taught, 1);
    assert.strictEqual(Guilds.memberOf("Page").trainingCredits, 1);
    // Non-archivists cannot teach.
    assert.strictEqual(Guilds.holdClass("misthalin", "Page").ok, false);
    // Mentorship: free certification, double credit.
    assert.strictEqual(Guilds.takeApprentice("Archie", "Page").ok, true);
    const st = Guilds.load();
    assert.ok(st.mentorships["page"]);
    // Promotion: tenure + credits + a certified book.
    Guilds.memberOf("Page").joinedMs = Date.now() - 31 * 24 * 3600 * 1000;
    Guilds.memberOf("Page").trainingCredits = 2;
    st.certifications["cert-1"] = { id: "cert-1", kingdomId: "misthalin", author: "Page", title: "P", subject: "lore", quality: 6, grade: "B", certifiedMs: 1 };
    Guilds.touch();
    const promo = Guilds.tryPromote("Page");
    assert.strictEqual(promo.ok, true);
    assert.strictEqual(promo.rank, Guilds.RANK_LIBRARIAN);
    // Librarian -> archivist needs 60d + 4 credits + 2 conducted certifications.
    Guilds.memberOf("Page").joinedMs = Date.now() - 61 * 24 * 3600 * 1000;
    Guilds.memberOf("Page").trainingCredits = 4;
    Guilds.memberOf("Page").certificationsConducted = 2;
    const promo2 = Guilds.tryPromote("Page");
    assert.strictEqual(promo2.ok, true);
    assert.strictEqual(promo2.rank, Guilds.RANK_ARCHIVIST);
  } finally { restore(); }
});

test("leave clears mentorships", () => {
  const restore = installStubs({ careers: { archie: "librarian", page: "librarian" } });
  try {
    Guilds.joinGuild("Archie", "misthalin");
    Guilds.joinGuild("Page", "misthalin");
    Guilds.memberOf("Archie").rank = Guilds.RANK_ARCHIVIST;
    Guilds.takeApprentice("Archie", "Page");
    Guilds.leaveGuild("Archie");
    assert.strictEqual(Object.keys(Guilds.load().mentorships).length, 0);
  } finally { restore(); }
});

// --- Treasury & prestige ---

test("dues split treasury and scriptorium fund", () => {
  const restore = installStubs({ careers: { alice: "librarian" } });
  try {
    Guilds.joinGuild("Alice", "misthalin");
    Guilds.recordDuesPayment("Alice", Date.now());
    const t = Guilds.guildTreasuryFor("misthalin");
    assert.strictEqual(t.treasury, Guilds.DUES_WEEKLY - 5);
    assert.strictEqual(t.scriptoriumFund, 5);
    Guilds.contributeToFund("misthalin", 100);
    assert.strictEqual(Guilds.guildTreasuryFor("misthalin").scriptoriumFund, 105);
  } finally { restore(); }
});

test("describe summarizes the guild", () => {
  const restore = installStubs({ careers: { alice: "librarian" } });
  try {
    assert.deepStrictEqual(Guilds.describe("asgarnia").exists, false);
    Guilds.joinGuild("Alice", "misthalin");
    const d = Guilds.describe("misthalin");
    assert.strictEqual(d.exists, true);
    assert.strictEqual(d.memberCount, 1);
    assert.strictEqual(d.sealed, false);
    assert.ok(d.hallTile);
  } finally { restore(); }
});

console.log(`\n${passed} tests passed`);
