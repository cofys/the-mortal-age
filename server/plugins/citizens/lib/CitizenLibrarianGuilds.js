"use strict";

/**
 * CitizenLibrarianGuilds — the Librarians' Guild: the library profession's
 * operations layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenLibraries owns: library BUILDINGS, BOOK writing (real papyrus),
 *     LENDING with real deposits, RESEARCH rooms granting real skill XP,
 *     ARCHIVES written from real kingdom events, and the librarian
 *     PROFESSION registry. Never reimplemented — READ only.
 *   - CitizenLibrarians / CitizenLibrarians2 own: hash-derived librarian
 *     flavor (frozen). Never reimplemented — READ only (and never read;
 *     flavor only).
 *   - CitizenScholars owns: the researcher profession and published
 *     findings. Never reimplemented — READ only.
 *   - CitizenSchools owns: schools, teachers, classes. This never runs
 *     classes.
 *   - CitizenLibrarian (brain) owns: librarians walking to the library and
 *     working in human-paced rounds. THIS module owns the profession's
 *     guild layer only.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One Librarians' Guild per kingdom with a hall tile near the library,
 *     a real tracked treasury, a real tracked scriptorium fund, and prestige.
 *   - Membership: page -> librarian -> archivist. Joining requires being a
 *     REAL librarian: the `librarian` career (CitizenCareers.careerOf), OR a
 *     registered librarian in the CitizenLibraries ledger. The guild polices
 *     the trade, never mints librarians. Weekly dues in REAL coins; two
 *     missed online collections -> suspended until caught up. Offline members
 *     are never penalized.
 *   - Book certification: members submit books they REALLY wrote (verified
 *     against the CitizenLibraries ledger — the book exists and its recorded
 *     author is the claimant). A 50-coin real fee (mentored pages certify
 *     free). Grades from the REAL book quality: >=8=A, >=5=B, else C. The
 *     guild pays a REAL bounty from its treasury (C:30 / B:60 / A:120); the
 *     scriptorium fund backs bounties when the treasury runs dry; when both
 *     are broke the bounty is owed honestly, never invented. The bounty is
 *     DELIVERED: to the author's inventory on the player path, to their
 *     bank account by the life-tick retry when owed. A failed delivery is
 *     re-recorded as owed, never claimed as paid. Indexed books
 *     (see the Restricted Index) are ineligible.
 *   - Plagiarism tribunal: the one verifiable literary crime — a plagiarized
 *     book: a certified book whose normalized title duplicates an EARLIER
 *     certified book (by certifiedMs) by a DIFFERENT author. Members/players
 *     report; librarian-rank members vote; 24h auto-settle. Guilty ->
 *     expulsion + `plagiarist` deed.
 *   - Scriptorium inspections: the guild's collection score per kingdom is
 *     computed from REAL data — every guild member's real written-book
 *     output (CitizenLibraries.booksIn filtered by author). Members with no
 *     real books lower the score. Scores below 40 trigger a public
 *     collection-audit announcement.
 *   - Archive seals: an archivist certifies the kingdom's ARCHIVE collection
 *     as authentic — verifiable from the real archive ledger: >=5 archive
 *     records covering >=3 distinct event subjects. The seal is a guild
 *     record (the archives stay in the CitizenLibraries ledger; never a
 *     double-spend) and raises guild prestige.
 *   - Restricted Index: the guild's content standards. Archivist-rank
 *     members propose a book for the index; librarian-rank+ members vote;
 *     a guilty-majority with quorum restricts the book: it can no longer be
 *     certified, and the restriction is announced. The index is the guild's
 *     own record — the library operations layer is never touched.
 *   - Golden quill: quarterly, the guild member with the most REAL certified
 *     books in the kingdom wins a 200-coin real prize (owed honestly when
 *     broke) and a public announcement.
 *   - Scriptorium board: sponsors post real-coin bounties for certified
 *     books on a subject; claims are verified against the guild's own
 *     certification ledger (certified after the bounty posted, subject
 *     matches, claimant is a member in good standing). The bounty goes to
 *     the author's real bank account (honest offline credit).
 *   - Scriptorium school: archivist librarians teach pages (training
 *     credits). Promotion: page -> librarian (30d tenure + 2 credits + a
 *     real certified book), librarian -> archivist (60d tenure + 4 credits
 *     + 2 conducted certifications + clean record). All verifiable from
 *     real records — never invented.
 *   - Mentorship: archivists take page members under wing. While mentored,
 *     the page pays no certification fees and their certifications count
 *     double toward promotion. Mentorship ends after the first certification.
 *   - Public API: isGuildMember, guildRankOf, memberOf, memberNames,
 *     sealFor, gradeFor, guildTreasuryFor, inspectionFor, describe,
 *     isRestricted.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenLibrarianGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented librarians, books, archives, inspections, coins, or
 *     bounties.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-librarianguilds.json";
const COINS_ID = 995;

const RANK_PAGE = "page";
const RANK_LIBRARIAN = "librarian";
const RANK_ARCHIVIST = "archivist";
const RANKS = Object.freeze([RANK_PAGE, RANK_LIBRARIAN, RANK_ARCHIVIST]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_SCRIPTORIUM_SHARE = 5; // of each dues payment feeds the scriptorium fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const CERT_FEE = 50; // real coins to certify a book
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const GRADE_A_QUALITY = 8; // books are quality 1-10
const GRADE_B_QUALITY = 5;

const QUILL_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly golden quill
const QUILL_PRIZE = 200; // real coins from the treasury

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const SEAL_MIN_RECORDS = 5; // archive seal needs >=5 real archive records
const SEAL_MIN_SUBJECTS = 3; // ...covering >=3 distinct event subjects

const HALL_TILE_DX = 4; // guild hall sits a few tiles from the library
const HALL_TILE_DY = 3;

const INSPECTION_AUDIT_THRESHOLD = 40; // below this the guild announces an audit

const PROMOTE_LIBRARIAN = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2 });
const PROMOTE_ARCHIVIST = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, certifications: 2 });

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", SAVE_KEY);

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

let cache = null;
let dirty = false;

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
}

function blankState() {
  return {
    version: 1,
    guilds: {}, // kingdomId -> guild record
    members: {}, // lower(username) -> member record
    certifications: {}, // certId -> certification record
    cases: {}, // caseId -> tribunal case
    mentorships: {}, // lower(page) -> { master, sinceMs }
    bounties: {}, // bountyId -> scriptorium bounty
    seals: {}, // kingdomId -> archive seal record
    index: {}, // lower(normalized title) -> restricted-index entry
    nextCertId: 1,
    nextCaseId: 1,
    nextBountyId: 1,
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    cache = JSON.parse(raw);
    if (!cache || typeof cache !== "object") cache = blankState();
  } catch {
    cache = blankState();
  }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function touch() {
  dirty = true;
}

// === Engine reads (all defensive) ===

function librariesApi() {
  try { return require("./CitizenLibraries"); } catch { return null; }
}

function careersApi() {
  try { return require("./CitizenCareers"); } catch { return null; }
}

function sitesApi() {
  try { return require("../brain/CitizenSites"); } catch { return null; }
}

function reputationApi() {
  try { return require("./CitizenReputation"); } catch { return null; }
}

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

// === Guild management ===

function ensureGuild(kingdomId) {
  const st = load();
  if (!st.guilds[kingdomId]) {
    let hallTile = null;
    try {
      const S = sitesApi();
      const Lib = librariesApi();
      let base = null;
      if (Lib && Lib.libraryTile) {
        base = Lib.libraryTile(kingdomId) ?? null;
      }
      if (!base && S && S.siteTileByKingdom) {
        base = S.siteTileByKingdom(kingdomId, "market") ?? null;
      }
      if (base) {
        hallTile = { x: base.x + HALL_TILE_DX, y: base.y + HALL_TILE_DY, z: base.z || 0 };
      }
    } catch { /* no hall tile */ }
    st.guilds[kingdomId] = {
      kingdomId,
      hallTile,
      treasury: 0,
      scriptoriumFund: 0,
      prestige: 0,
      foundedMs: Date.now(),
      lastQuillMs: 0,
    };
    touch();
  }
  return st.guilds[kingdomId];
}

function guildOf(kingdomId) {
  const st = load();
  return st.guilds[kingdomId] || null;
}

// === Membership ===

function isRealLibrarian(username) {
  // The guild polices the trade — it never mints librarians. Two verifiable
  // paths: the `librarian` career, or a registered librarian in the library
  // ledger.
  try {
    const C = careersApi();
    if (C && C.careerOf && C.careerOf(username) === "librarian") return true;
  } catch { /* fall through */ }
  try {
    const Lib = librariesApi();
    if (Lib && Lib.isLibrarian && Lib.isLibrarian(username)) return true;
  } catch { /* fall through */ }
  return false;
}

function joinGuild(username, kingdomId) {
  const st = load();
  const key = normalizeName(username);
  if (st.members[key]) return { ok: false, reason: "already-member" };
  if (!isRealLibrarian(username)) return { ok: false, reason: "not-a-librarian" };
  ensureGuild(kingdomId);
  const now = Date.now();
  st.members[key] = {
    username,
    kingdomId,
    rank: RANK_PAGE,
    joinedMs: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS, // first week free
    missedDues: 0,
    suspended: false,
    trainingCredits: 0,
    certificationsConducted: 0,
    cleanRecord: true,
  };
  touch();
  return { ok: true, rank: RANK_PAGE };
}

function leaveGuild(username) {
  const st = load();
  const key = normalizeName(username);
  if (!st.members[key]) return { ok: false, reason: "not-a-member" };
  delete st.members[key];
  // End any mentorship involving this member.
  for (const novice of Object.keys(st.mentorships)) {
    if (novice === key || normalizeName(st.mentorships[novice].master) === key) {
      delete st.mentorships[novice];
    }
  }
  touch();
  return { ok: true };
}

function isGuildMember(username) {
  const st = load();
  return !!st.members[normalizeName(username)];
}

function memberOf(username) {
  const st = load();
  return st.members[normalizeName(username)] || null;
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function memberNames(kingdomId) {
  const st = load();
  return Object.values(st.members)
    .filter((m) => m.kingdomId === kingdomId)
    .map((m) => m.username);
}

function recordDuesPayment(username, nowMs) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return { ok: false, reason: "not-a-member" };
  const g = ensureGuild(m.kingdomId);
  g.treasury += (DUES_WEEKLY - DUES_SCRIPTORIUM_SHARE);
  g.scriptoriumFund += DUES_SCRIPTORIUM_SHARE;
  m.duesPaidUntilMs = nowMs + DUES_PERIOD_MS;
  m.missedDues = 0;
  if (m.suspended) m.suspended = false; // caught up — lift suspension
  touch();
  return { ok: true };
}

function recordMissedDues(username, nowMs) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return { ok: false, reason: "not-a-member" };
  m.missedDues += 1;
  if (m.missedDues >= SUSPEND_AFTER_MISSED) m.suspended = true;
  touch();
  return { ok: true, suspended: m.suspended };
}

// === Book certification ===

function normalizeTitle(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function certifyBook(kingdomId, username, bookId) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return { ok: false, reason: "not-a-member" };
  if (m.suspended) return { ok: false, reason: "suspended" };
  const g = ensureGuild(kingdomId);

  // Verify the book is REAL: it exists in the CitizenLibraries ledger and
  // its recorded author is the claimant. We read the library ledger
  // defensively — never invent.
  let book = null;
  try {
    const Lib = librariesApi();
    if (Lib && Lib.bookById) book = Lib.bookById(bookId);
  } catch { /* no book */ }
  if (!book) return { ok: false, reason: "no-such-book" };
  if (normalizeName(book.author) !== key) return { ok: false, reason: "not-the-author" };
  const quality = Number(book.quality);
  if (!Number.isFinite(quality) || quality < 1 || quality > 10) {
    return { ok: false, reason: "no-quality" };
  }
  // No double-certification of the same book by the same author.
  const dup = Object.values(st.certifications).some(
    (c) => normalizeName(c.author) === key && c.bookId === bookId
  );
  if (dup) return { ok: false, reason: "already-certified" };
  // The Restricted Index bars certification of indexed works.
  if (isRestricted(book.title)) return { ok: false, reason: "restricted" };

  // Mentored pages certify free; everyone else pays the real fee.
  const mentored = st.mentorships[key];
  const fee = mentored ? 0 : CERT_FEE;

  const grade = quality >= GRADE_A_QUALITY ? "A" : quality >= GRADE_B_QUALITY ? "B" : "C";
  const certId = `cert-${st.nextCertId++}`;
  const now = Date.now();
  st.certifications[certId] = {
    id: certId,
    kingdomId,
    author: username,
    bookId,
    title: String(book.title || "untitled tome"),
    subject: String(book.subject || "unknown"),
    quality,
    grade,
    feePaid: fee,
    bountyPaid: 0,
    bountyOwed: 0,
    certifiedMs: now,
  };

  // Pay the bounty from the treasury; the scriptorium fund backs it; when
  // both are broke the bounty is owed honestly, never invented.
  // NOTE: this only deducts the bounty from the guild's reserves — the
  // actual delivery happens in the Events layer (player inventory) or the
  // life-tick retry (author's bank account). The per-pool split is returned
  // so a failed delivery can be parked back exactly, never invented.
  const bounty = CERT_BOUNTY[grade];
  const beforeTreasury = g.treasury;
  const beforeFund = g.scriptoriumFund;
  let paid = 0;
  let owed = 0;
  if (g.treasury >= bounty) {
    g.treasury -= bounty;
    paid = bounty;
  } else if (g.treasury + g.scriptoriumFund >= bounty) {
    const fromTreasury = g.treasury;
    const fromFund = bounty - fromTreasury;
    g.treasury = 0;
    g.scriptoriumFund -= fromFund;
    paid = bounty;
  } else {
    paid = g.treasury + g.scriptoriumFund;
    owed = bounty - paid;
    g.treasury = 0;
    g.scriptoriumFund = 0;
  }
  st.certifications[certId].bountyPaid = paid;
  st.certifications[certId].bountyOwed = owed;

  // Mentorship ends after the first certification; the certification counts
  // double toward promotion while mentored.
  if (mentored) {
    delete st.mentorships[key];
    m.certificationsConducted = (m.certificationsConducted || 0) + 2;
  } else {
    m.certificationsConducted = (m.certificationsConducted || 0) + 1;
  }

  // Update prestige from real counts.
  updatePrestige(kingdomId);
  touch();
  return {
    ok: true, certId, grade, fee, bountyPaid: paid, bountyOwed: owed,
    bountyPaidFromTreasury: beforeTreasury - g.treasury,
    bountyPaidFromFund: beforeFund - g.scriptoriumFund,
  };
}

function sealFor(certId) {
  const st = load();
  return st.certifications[certId] || null;
}

function refundCertBounty(certId, amount, fromTreasury, fromFund) {
  // Park a deducted-but-never-delivered bounty back in the guild's
  // reserves and re-record it as owed. Used when the player-facing coin
  // credit failed: the treasury was already deducted, so without this the
  // coins would vanish while the record claims they were paid. Restores
  // the exact per-pool split; never invents or destroys coins.
  const st = load();
  const cert = st.certifications[certId];
  if (!cert) return { ok: false, reason: "no-such-certification" };
  amount = Math.floor(Number(amount) || 0);
  if (!(amount > 0) || cert.bountyPaid < amount) return { ok: false, reason: "bad-amount" };
  const g = ensureGuild(cert.kingdomId);
  let t = Math.max(0, Math.floor(Number(fromTreasury) || 0));
  let f = Math.max(0, Math.floor(Number(fromFund) || 0));
  if (t + f > amount) { t = amount; f = 0; } // clamp: never restore more than deducted
  g.treasury += t + Math.max(0, amount - t - f); // any un-split remainder back to treasury
  g.scriptoriumFund += f;
  cert.bountyPaid -= amount;
  cert.bountyOwed += amount;
  touch();
  return { ok: true, refunded: amount, bountyPaid: cert.bountyPaid, bountyOwed: cert.bountyOwed };
}

function gradeFor(username) {
  const st = load();
  const key = normalizeName(username);
  const certs = Object.values(st.certifications).filter((c) => normalizeName(c.author) === key);
  if (!certs.length) return null;
  // Best grade wins: A > B > C.
  const order = { A: 3, B: 2, C: 1 };
  certs.sort((a, b) => order[b.grade] - order[a.grade]);
  return certs[0].grade;
}

function retryOwedBounties(kingdomId) {
  const st = load();
  const g = ensureGuild(kingdomId);
  let paid = 0;
  for (const cert of Object.values(st.certifications)) {
    if (cert.kingdomId !== kingdomId || !cert.bountyOwed) continue;
    const available = g.treasury + g.scriptoriumFund;
    if (available <= 0) break;
    const pay = Math.min(cert.bountyOwed, available);
    // Drain treasury first, then the fund.
    const fromTreasury = Math.min(pay, g.treasury);
    const fromFund = pay - fromTreasury;
    g.treasury -= fromTreasury;
    g.scriptoriumFund -= fromFund;
    // Credit the author's REAL bank account (honest offline delivery —
    // same pattern as the payBounty fix). If banking is unreachable,
    // restore the reserves and keep the bounty owed: never mark paid what
    // was never delivered, never invent coins.
    let credited = false;
    try {
      const B = bankingApi();
      const acct = B && typeof B.accountFor === "function" ? B.accountFor(cert.author) : null;
      if (acct) {
        acct.balance = (Number(acct.balance) || 0) + pay;
        if (typeof B.markDirty === "function") B.markDirty();
        credited = true;
      }
    } catch { /* banking is best-effort */ }
    if (!credited) {
      g.treasury += fromTreasury;
      g.scriptoriumFund += fromFund;
      break; // banking is down globally; a later tick retries
    }
    cert.bountyOwed -= pay;
    cert.bountyPaid += pay;
    paid += pay;
    touch();
  }
  return { ok: true, paid };
}

// === Plagiarism tribunal ===

function scanPlagiarism(title) {
  // The one verifiable literary crime: a plagiarized book — a certified
  // book whose normalized title duplicates an EARLIER certified book (by
  // certifiedMs) by a DIFFERENT author.
  const st = load();
  const norm = normalizeTitle(title);
  if (!norm) return null;
  const matches = Object.values(st.certifications)
    .filter((c) => normalizeTitle(c.title) === norm)
    .sort((a, b) => a.certifiedMs - b.certifiedMs);
  if (matches.length < 2) return null;
  const original = matches[0];
  const latest = matches[matches.length - 1];
  if (normalizeName(original.author) === normalizeName(latest.author)) return null;
  return { original, accused: latest };
}

function reportPlagiarism(kingdomId, reporter, title) {
  const st = load();
  const found = scanPlagiarism(title);
  if (!found) return { ok: false, reason: "no-plagiarism-found" };
  // No double jeopardy: one case per accused certification.
  const existing = Object.values(st.cases).find(
    (c) => c.accusedCertId === found.accused.id && c.status !== "dismissed"
  );
  if (existing) return { ok: false, reason: "case-exists", caseId: existing.id };
  const caseId = `case-${st.nextCaseId++}`;
  st.cases[caseId] = {
    id: caseId,
    kingdomId,
    kind: "plagiarism",
    reporter,
    accused: found.accused.author,
    accusedCertId: found.accused.id,
    originalAuthor: found.original.author,
    title: found.accused.title,
    votes: {}, // lower(username) -> "guilty" | "innocent"
    status: "open",
    openedMs: Date.now(),
  };
  touch();
  return { ok: true, caseId };
}

function voteOnCase(caseId, voter, verdict) {
  const st = load();
  const c = st.cases[caseId];
  if (!c) return { ok: false, reason: "no-such-case" };
  if (c.status !== "open") return { ok: false, reason: "case-closed" };
  // Only librarian-rank+ members in good standing may vote.
  const m = memberOf(voter);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  if (m.rank === RANK_PAGE) return { ok: false, reason: "rank-too-low" };
  if (verdict !== "guilty" && verdict !== "innocent") {
    return { ok: false, reason: "bad-verdict" };
  }
  c.votes[normalizeName(voter)] = verdict;
  touch();
  return { ok: true };
}

function settleRipeCases(kingdomId, nowMs) {
  const st = load();
  const settled = [];
  for (const c of Object.values(st.cases)) {
    if (c.kingdomId !== kingdomId || c.status !== "open") continue;
    if (nowMs - c.openedMs < CASE_TTL_MS) continue;
    const votes = Object.values(c.votes);
    const guilty = votes.filter((v) => v === "guilty").length;
    const innocent = votes.filter((v) => v === "innocent").length;
    if (votes.length >= VOTES_FOR_QUORUM && guilty > innocent) {
      c.status = "convicted";
      c.verdict = "guilty";
      // Expel the plagiarist and mark the deed.
      const key = normalizeName(c.accused);
      if (st.members[key]) {
        st.members[key].cleanRecord = false;
        delete st.members[key];
      }
      try {
        const R = reputationApi();
        if (R && R.awardDeed) R.awardDeed(c.accused, "plagiarist");
      } catch { /* deed is best-effort */ }
    } else {
      c.status = "dismissed";
      c.verdict = "innocent";
    }
    settled.push(c.id);
    touch();
  }
  return { ok: true, settled };
}

// === Scriptorium inspections ===

function inspectionFor(kingdomId) {
  // The guild's collection score: computed from REAL data — every guild
  // member's real written-book output. Members with no real books lower
  // the score.
  const st = load();
  const names = memberNames(kingdomId);
  if (!names.length) return { score: 100, members: 0, withWorks: 0, idle: 0 };
  let withWorks = 0;
  try {
    const Lib = librariesApi();
    for (const n of names) {
      try {
        const books = Lib && Lib.booksIn ? Lib.booksIn(kingdomId) : [];
        if (books.some((b) => normalizeName(b.author) === normalizeName(n))) withWorks++;
      } catch { /* no books */ }
    }
  } catch { /* no library */ }
  const score = Math.round((withWorks / names.length) * 100);
  return { score, members: names.length, withWorks, idle: names.length - withWorks };
}

// === Archive seals ===

function sealArchives(kingdomId, archivist) {
  // An archivist certifies the kingdom's ARCHIVE collection as authentic.
  // Verifiable from the real archive ledger: >=5 records covering >=3
  // distinct event subjects. The seal is a guild record — the archives
  // stay in the CitizenLibraries ledger; never a double-spend.
  const st = load();
  const m = memberOf(archivist);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  if (m.rank !== RANK_ARCHIVIST) return { ok: false, reason: "rank-too-low" };
  if (m.kingdomId !== kingdomId) return { ok: false, reason: "wrong-kingdom" };
  let records = [];
  try {
    const Lib = librariesApi();
    if (Lib && Lib.archivesIn) records = Lib.archivesIn(kingdomId) || [];
  } catch { /* no archives */ }
  if (records.length < SEAL_MIN_RECORDS) return { ok: false, reason: "too-few-records" };
  const subjects = new Set(records.map((r) => String(r.subject || r.event || "unknown").toLowerCase()));
  if (subjects.size < SEAL_MIN_SUBJECTS) return { ok: false, reason: "too-few-subjects" };
  const g = ensureGuild(kingdomId);
  st.seals[kingdomId] = {
    kingdomId,
    sealedBy: archivist,
    sealedMs: Date.now(),
    archiveCount: records.length,
    subjects: [...subjects],
  };
  g.prestige = Math.min(100, g.prestige + 10);
  touch();
  return { ok: true, archiveCount: records.length, subjects: [...subjects] };
}

function sealStatus(kingdomId) {
  const st = load();
  return st.seals[kingdomId] || null;
}

// === Restricted Index (content standards) ===

function proposeRestriction(kingdomId, proposer, title) {
  // An archivist proposes a book for the Restricted Index. The book must be
  // REAL (it exists in the library ledger). The index entry starts open and
  // is decided by member vote.
  const st = load();
  const m = memberOf(proposer);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  if (m.rank !== RANK_ARCHIVIST) return { ok: false, reason: "rank-too-low" };
  const norm = normalizeTitle(title);
  if (!norm) return { ok: false, reason: "bad-title" };
  if (st.index[norm]) return { ok: false, reason: "already-proposed" };
  // Verify the book is real.
  let real = false;
  try {
    const Lib = librariesApi();
    const books = Lib && Lib.booksIn ? Lib.booksIn(kingdomId) : [];
    real = books.some((b) => normalizeTitle(b.title) === norm);
  } catch { /* no library */ }
  if (!real) return { ok: false, reason: "no-such-book" };
  st.index[norm] = {
    title,
    kingdomId,
    proposer,
    votes: {}, // lower(username) -> "restrict" | "allow"
    status: "open",
    proposedMs: Date.now(),
  };
  touch();
  return { ok: true, norm };
}

function voteOnRestriction(title, voter, verdict) {
  const st = load();
  const norm = normalizeTitle(title);
  const entry = st.index[norm];
  if (!entry) return { ok: false, reason: "no-such-entry" };
  if (entry.status !== "open") return { ok: false, reason: "entry-closed" };
  const m = memberOf(voter);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  if (m.rank === RANK_PAGE) return { ok: false, reason: "rank-too-low" };
  if (verdict !== "restrict" && verdict !== "allow") {
    return { ok: false, reason: "bad-verdict" };
  }
  entry.votes[normalizeName(voter)] = verdict;
  touch();
  return { ok: true };
}

function settleRipeRestrictions(kingdomId, nowMs) {
  const st = load();
  const settled = [];
  for (const [norm, entry] of Object.entries(st.index)) {
    if (entry.kingdomId !== kingdomId || entry.status !== "open") continue;
    if (nowMs - entry.proposedMs < CASE_TTL_MS) continue;
    const votes = Object.values(entry.votes);
    const restrict = votes.filter((v) => v === "restrict").length;
    const allow = votes.filter((v) => v === "allow").length;
    if (votes.length >= VOTES_FOR_QUORUM && restrict > allow) {
      entry.status = "restricted";
    } else {
      entry.status = "dismissed";
    }
    settled.push(norm);
    touch();
  }
  return { ok: true, settled };
}

function isRestricted(title) {
  const st = load();
  const entry = st.index[normalizeTitle(title)];
  return !!(entry && entry.status === "restricted");
}

function restrictedList(kingdomId) {
  const st = load();
  return Object.entries(st.index)
    .filter(([, e]) => e.kingdomId === kingdomId && e.status === "restricted")
    .map(([norm, e]) => ({ title: e.title, norm }));
}

// === Golden quill ===

function grantGoldenQuill(kingdomId, nowMs) {
  const st = load();
  const g = ensureGuild(kingdomId);
  if (nowMs - (g.lastQuillMs || 0) < QUILL_PERIOD_MS) {
    return { ok: false, reason: "too-soon" };
  }
  // The member with the most REAL certified books in the kingdom.
  const counts = {};
  for (const cert of Object.values(st.certifications)) {
    if (cert.kingdomId !== kingdomId) continue;
    const key = normalizeName(cert.author);
    const m = st.members[key];
    if (!m || m.suspended) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { ok: false, reason: "no-candidates" };
  const [winnerKey, count] = entries[0];
  const winner = st.members[winnerKey].username;

  // 200-coin real prize; owed honestly when the treasury is broke.
  let paid = 0;
  let owed = 0;
  if (g.treasury >= QUILL_PRIZE) {
    g.treasury -= QUILL_PRIZE;
    paid = QUILL_PRIZE;
  } else {
    paid = g.treasury;
    owed = QUILL_PRIZE - paid;
    g.treasury = 0;
  }
  g.lastQuillMs = nowMs;
  try {
    const R = reputationApi();
    if (R && R.awardDeed) R.awardDeed(winner, "goldenquill");
  } catch { /* deed is best-effort */ }
  touch();
  return { ok: true, winner, books: count, prizePaid: paid, prizeOwed: owed };
}

// === Scriptorium board ===

function postBounty(kingdomId, sponsor, subject, amount) {
  const st = load();
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount < 100) return { ok: false, reason: "min-bounty-100" };
  subject = String(subject || "").toLowerCase();
  ensureGuild(kingdomId);
  const bountyId = `bounty-${st.nextBountyId++}`;
  st.bounties[bountyId] = {
    id: bountyId,
    kingdomId,
    sponsor,
    subject,
    amount,
    status: "open",
    postedMs: Date.now(),
    claimedBy: null,
    claimedCertId: null,
  };
  touch();
  return { ok: true, bountyId };
}

function claimBounty(bountyId, username, certId) {
  const st = load();
  const b = st.bounties[bountyId];
  if (!b) return { ok: false, reason: "no-such-bounty" };
  if (b.status !== "open") return { ok: false, reason: "already-claimed" };
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  // Verify the claim against the guild's OWN certification ledger: the
  // certification must exist, belong to the claimant, be on the bounty's
  // subject, and be certified AFTER the bounty was posted.
  const cert = st.certifications[certId];
  if (!cert) return { ok: false, reason: "no-such-certification" };
  if (normalizeName(cert.author) !== key) return { ok: false, reason: "not-your-work" };
  if (String(cert.subject).toLowerCase() !== b.subject) return { ok: false, reason: "wrong-subject" };
  if (cert.certifiedMs < b.postedMs) return { ok: false, reason: "predates-bounty" };
  b.status = "claimed";
  b.claimedBy = username;
  b.claimedCertId = certId;
  touch();
  return { ok: true, amount: b.amount };
}

function payBounty(bountyId) {
  // Pay the bounty from the guild treasury (sponsors funded it at post
  // time) into the claimant's REAL bank account (honest offline credit).
  // If the treasury ran dry, the remainder is owed honestly.
  const st = load();
  const b = st.bounties[bountyId];
  if (!b) return { ok: false, reason: "no-such-bounty" };
  if (b.status !== "claimed") return { ok: false, reason: "not-claimed" };
  if (b.paid) return { ok: false, reason: "already-paid" };
  const g = ensureGuild(b.kingdomId);
  const pay = Math.min(b.amount, g.treasury);
  const owed = b.amount - pay;
  g.treasury -= pay;
  if (pay > 0) {
    try {
      const B = bankingApi();
      // CitizenBanking exposes accountFor, not creditAccount — credit the
      // live account record directly (same pattern as CitizenCivilLaw).
      const acct = B && typeof B.accountFor === "function" ? B.accountFor(b.claimedBy) : null;
      if (acct) {
        acct.balance = (Number(acct.balance) || 0) + pay;
        if (typeof B.markDirty === "function") B.markDirty();
      }
    } catch { /* banking is best-effort */ }
  }
  b.paid = true;
  b.paidAmount = pay;
  b.owedAmount = owed;
  touch();
  return { ok: true, amount: pay, owed, to: b.claimedBy };
}

// === Scriptorium school & mentorship ===

function holdClass(kingdomId, master) {
  const st = load();
  const mKey = normalizeName(master);
  const m = st.members[mKey];
  if (!m || m.rank !== RANK_ARCHIVIST || m.suspended) {
    return { ok: false, reason: "not-an-archivist" };
  }
  let taught = 0;
  for (const n of memberNames(kingdomId)) {
    const nm = st.members[normalizeName(n)];
    if (nm && nm.rank === RANK_PAGE && !nm.suspended) {
      nm.trainingCredits = (nm.trainingCredits || 0) + 1;
      taught++;
    }
  }
  touch();
  return { ok: true, taught };
}

function tryPromote(username) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  const now = Date.now();
  const tenure = now - m.joinedMs;
  if (m.rank === RANK_PAGE) {
    // Page -> librarian: 30d tenure + 2 credits + a real certified book.
    const hasCert = Object.values(st.certifications).some(
      (c) => normalizeName(c.author) === key
    );
    if (tenure < PROMOTE_LIBRARIAN.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_LIBRARIAN.credits) return { ok: false, reason: "credits" };
    if (!hasCert) return { ok: false, reason: "no-certification" };
    if (!m.cleanRecord) return { ok: false, reason: "record" };
    m.rank = RANK_LIBRARIAN;
    touch();
    return { ok: true, rank: RANK_LIBRARIAN };
  }
  if (m.rank === RANK_LIBRARIAN) {
    // Librarian -> archivist: 60d tenure + 4 credits + 2 conducted
    // certifications.
    if (tenure < PROMOTE_ARCHIVIST.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_ARCHIVIST.credits) return { ok: false, reason: "credits" };
    if ((m.certificationsConducted || 0) < PROMOTE_ARCHIVIST.certifications) {
      return { ok: false, reason: "certifications" };
    }
    if (!m.cleanRecord) return { ok: false, reason: "record" };
    m.rank = RANK_ARCHIVIST;
    try {
      const R = reputationApi();
      if (R && R.awardDeed) R.awardDeed(m.username, "loremaster");
    } catch { /* deed is best-effort */ }
    touch();
    return { ok: true, rank: RANK_ARCHIVIST };
  }
  return { ok: false, reason: "max-rank" };
}

function takeApprentice(master, page) {
  const st = load();
  const mKey = normalizeName(master);
  const nKey = normalizeName(page);
  const m = st.members[mKey];
  const n = st.members[nKey];
  if (!m || m.rank !== RANK_ARCHIVIST || m.suspended) {
    return { ok: false, reason: "not-an-archivist" };
  }
  if (!n || n.rank !== RANK_PAGE || n.suspended) {
    return { ok: false, reason: "not-a-page" };
  }
  st.mentorships[nKey] = { master: m.username, sinceMs: Date.now() };
  touch();
  return { ok: true };
}

// === Prestige & treasury ===

function updatePrestige(kingdomId) {
  const st = load();
  const g = st.guilds[kingdomId];
  if (!g) return;
  const certCount = Object.values(st.certifications).filter((c) => c.kingdomId === kingdomId).length;
  const memberCount = memberNames(kingdomId).length;
  const sealed = st.seals[kingdomId] ? 10 : 0;
  g.prestige = Math.min(100, certCount * 2 + memberCount + sealed);
}

function guildTreasuryFor(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? { treasury: g.treasury, scriptoriumFund: g.scriptoriumFund } : null;
}

function contributeToFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  g.scriptoriumFund += amount;
  touch();
  return { ok: true, fund: g.scriptoriumFund };
}

/** Credit sponsor coins to the treasury (scriptorium bounties are guild-held). */
function creditTreasury(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  g.treasury += amount;
  touch();
  return { ok: true, treasury: g.treasury };
}

function describe(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return { exists: false };
  const names = memberNames(kingdomId);
  const certCount = Object.values(load().certifications).filter((c) => c.kingdomId === kingdomId).length;
  const insp = inspectionFor(kingdomId);
  return {
    exists: true,
    kingdomId,
    memberCount: names.length,
    certified: certCount,
    collection: insp.score,
    treasury: g.treasury,
    scriptoriumFund: g.scriptoriumFund,
    prestige: g.prestige,
    sealed: !!load().seals[kingdomId],
    hallTile: g.hallTile,
  };
}

module.exports = {
  // tuning
  SAVE_KEY,
  COINS_ID,
  RANK_PAGE,
  RANK_LIBRARIAN,
  RANK_ARCHIVIST,
  RANKS,
  DUES_WEEKLY,
  CERT_FEE,
  CERT_BOUNTY,
  QUILL_PRIZE,
  SEAL_MIN_RECORDS,
  SEAL_MIN_SUBJECTS,
  // guilds
  ensureGuild,
  guildOf,
  // membership
  isRealLibrarian,
  joinGuild,
  leaveGuild,
  isGuildMember,
  memberOf,
  guildRankOf,
  memberNames,
  recordDuesPayment,
  recordMissedDues,
  // certification
  normalizeTitle,
  certifyBook,
  refundCertBounty,
  sealFor,
  gradeFor,
  retryOwedBounties,
  // tribunal
  scanPlagiarism,
  reportPlagiarism,
  voteOnCase,
  settleRipeCases,
  // inspections
  inspectionFor,
  // archive seals
  sealArchives,
  sealStatus,
  // restricted index
  proposeRestriction,
  voteOnRestriction,
  settleRipeRestrictions,
  isRestricted,
  restrictedList,
  // golden quill
  grantGoldenQuill,
  // scriptorium board
  postBounty,
  claimBounty,
  payBounty,
  // school & mentorship
  holdClass,
  tryPromote,
  takeApprentice,
  // treasury & prestige
  guildTreasuryFor,
  contributeToFund,
  creditTreasury,
  describe,
  // persistence
  load,
  save,
  touch,
  resetForTests,
  _setSavePathForTests,
};
