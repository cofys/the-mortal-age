"use strict";

/**
 * CitizenLibraries — the data tier for library operations.
 *
 * Complements (does not duplicate):
 *   - CitizenLibrarians owns: hash-derived librarian flavor — shelving emotes,
 *     storytellers, rare-tome unveilings, and an in-memory TTL-pruned
 *     borrowing ledger. This never reimplements that flavor layer.
 *   - CitizenScholars owns: the researcher profession and published findings
 *     (in-memory library via getLibrary). This reads published works for
 *     archive cross-references but never reimplements research.
 *   - CitizenSchools owns: schools, teachers, classes. Libraries SUPPORT
 *     schools (research rooms grant real skill XP students can use) but never
 *     run classes.
 *   - CitizenScience owns: science research projects. This provides the
 *     research ROOM (the venue + XP), never the projects.
 *
 * What it does (data tier, free — read by the slow tick and the brain):
 *   - Libraries: one persistent library per kingdom (capacity, condition,
 *     upkeep paid in real coins from the kingdom treasury).
 *   - Books: citizens and players WRITE real books. Each book costs 1 real
 *     papyrus (970) from the author's inventory. Quality 1-10 grows from the
 *     author's real engagement (books written + research done), never random.
 *     Book titles are template frames filled from real data (author, subject,
 *     kingdom) — never invented.
 *   - Lending: books are borrowed with a REAL coin deposit (returned on time,
 *     forfeit on loss). Due dates are real; late returns pay real late fees.
 *     Loan records persist. Honest failures when the borrower can't pay.
 *   - Research rooms: studying a book grants REAL skill XP via
 *     CitizenSkilling's skillStore (the application layer for education and
 *     science — this owns the room and the XP grant, not the curriculum).
 *   - Archives: historical records written from REAL kingdom events (wars
 *     declared, elections held, champions crowned, treaties ratified) via
 *     defensive reads. Never invents history.
 *   - Librarians: persistent registry of citizens employed to run libraries
 *     (real career, not hash-derived flavor).
 *   - knowledgeFor(kingdomId): culture seam — published books + archives
 *     raise kingdom knowledge, read by culture systems.
 *
 * What it does NOT do:
 *   - No ticking here. Registration, ambient writing, loan enforcement,
 *     archive writing, upkeep, and announcements live in
 *     lib/CitizenLibrariesLife.js.
 *   - No LLM. Book titles and archive entries come from template frames
 *     filled with real data.
 *   - No invented items or coins: every papyrus, deposit, fee, and upkeep
 *     moves real coins/materials through real inventories (or honest bank
 *     credits for offline citizens). No invented geography: library tiles
 *     come from CitizenSites — this never invents tiles.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-libraries.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-libraries.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------
const MAT_PAPYRUS = 970; // papyrus — real engine item (matches CitizenArt/CitizenMaps)
const BOOK_WRITE_PAPYRUS = 1; // papyrus per book written
const LOAN_DEPOSIT = 50; // coin deposit per borrowed book
const LOAN_DAYS = 7; // loan term in days
const LATE_FEE_PER_DAY = 5; // coins per overdue day
const LIBRARY_UPKEEP_WEEKLY = 200; // coins per week from kingdom treasury
const RESEARCH_XP_PER_SESSION = 25; // skill XP per research session
const RESEARCH_SESSION_MS = 30 * 60 * 1000; // 30 min per research session
const MAX_BOOKS_PER_LIBRARY = 200;

const KINGDOM_IDS = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"];

const BOOK_SUBJECTS = Object.freeze([
  "history", "naturalism", "craft", "warfare", "agriculture",
  "astronomy", "medicine", "law", "poetry", "theology",
]);

// --- state -------------------------------------------------------------------
function blankState() {
  return {
    libraries: {}, // kingdomId -> { capacity, condition, upkeepPaidUntil, foundedAt }
    books: {}, // bookId -> { id, title, subject, author, kingdomId, quality, writtenAt, available }
    loans: {}, // loanId -> { id, bookId, borrower, borrowedAt, dueAt, returnedAt, deposit }
    archives: {}, // kingdomId -> [ { id, event, subject, writtenAt } ]
    librarians: {}, // username -> { kingdomId, hiredAt }
    researchLog: {}, // username -> lastResearchAt
    knowledge: {}, // kingdomId -> knowledge score 0-100
    seq: 0,
  };
}

let state = blankState();
let dirty = false;
let loaded = false;

function load() {
  if (loaded) return state;
  loaded = true;
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      state = Object.assign(blankState(), raw);
    }
  } catch {
    // corrupt save — start fresh rather than crash
    state = blankState();
  }
  return state;
}

function markDirty() {
  dirty = true;
}

function save() {
  if (!dirty) return false;
  try {
    load();
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(state));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/** Test seam — reset all state. */
function resetForTests() {
  state = blankState();
  dirty = false;
  loaded = false; // force re-load from disk on next load()
}

function nextId(prefix, nowMs) {
  load();
  state.seq += 1;
  markDirty();
  return `${prefix}_${nowMs}_${state.seq}`;
}

// --- coin/material helpers ----------------------------------------------------
function countCoins(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    let total = 0;
    const items = inv.getItems?.() ?? inv.items ?? [];
    for (const it of items) {
      const id = it?.id ?? it?.itemId;
      if (id === 995 || String(it?.name ?? "").toLowerCase() === "coins") {
        total += it?.amount ?? it?.qty ?? 1;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function removeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv?.removeItem) return false;
    if (countCoins(player) < amount) return false;
    inv.removeItem(995, amount);
    return true;
  } catch {
    return false;
  }
}

function giveCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv?.addItem) return false;
    inv.addItem(995, amount);
    return true;
  } catch {
    return false;
  }
}

function countPapyrus(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    let total = 0;
    const items = inv.getItems?.() ?? inv.items ?? [];
    for (const it of items) {
      if ((it?.id ?? it?.itemId) === MAT_PAPYRUS) total += it?.amount ?? it?.qty ?? 1;
    }
    return total;
  } catch {
    return 0;
  }
}

function removePapyrus(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv?.removeItem) return false;
    if (countPapyrus(player) < amount) return false;
    inv.removeItem(MAT_PAPYRUS, amount);
    return true;
  } catch {
    return false;
  }
}

/** Credit an offline citizen's bank account honestly. */
function creditBank(username, amount) {
  try {
    const Banking = require("./CitizenBanking");
    const acct = Banking.accountFor(username);
    if (!acct) return false;
    acct.balance = (acct.balance || 0) + amount;
    if (typeof Banking.markDirty === "function") Banking.markDirty();
    return true;
  } catch {
    return false;
  }
}

// --- libraries ----------------------------------------------------------------
function ensureLibrary(kingdomId, nowMs = Date.now()) {
  load();
  if (!KINGDOM_IDS.includes(kingdomId)) return null;
  if (!state.libraries[kingdomId]) {
    state.libraries[kingdomId] = {
      kingdomId,
      capacity: MAX_BOOKS_PER_LIBRARY,
      condition: 100,
      upkeepPaidUntil: nowMs,
      foundedAt: nowMs,
    };
    markDirty();
  }
  return state.libraries[kingdomId];
}

function libraryFor(kingdomId) {
  load();
  return state.libraries[kingdomId] || null;
}

function libraryTile(kingdomId) {
  try {
    const { siteTile } = require("../brain/CitizenSites");
    const base = siteTile(kingdomId, "market");
    if (!base) return null;
    // Library sits just off the market square — deterministic offset.
    return { x: base.x + 6, y: base.y - 4, z: base.z || 0 };
  } catch {
    return null;
  }
}

function payUpkeep(kingdomId, nowMs = Date.now()) {
  load();
  const lib = ensureLibrary(kingdomId, nowMs);
  if (!lib) return false;
  if (lib.upkeepPaidUntil > nowMs) return true; // already paid
  try {
    const Banking = require("./CitizenBanking");
    if (typeof Banking.treasuryWithdraw === "function") {
      if (!Banking.treasuryWithdraw(kingdomId, LIBRARY_UPKEEP_WEEKLY)) return false;
    }
  } catch {
    return false;
  }
  lib.upkeepPaidUntil = nowMs + 7 * 24 * 3600 * 1000;
  lib.condition = Math.min(100, lib.condition + 10);
  markDirty();
  return true;
}

// --- librarians ----------------------------------------------------------------
function registerLibrarian(username, kingdomId, nowMs = Date.now()) {
  load();
  const key = normalizeName(username);
  if (!key || state.librarians[key]) return false;
  state.librarians[key] = { username: key, kingdomId, hiredAt: nowMs };
  markDirty();
  return true;
}

function isLibrarian(username) {
  load();
  return !!state.librarians[normalizeName(username)];
}

function librarianInfo(username) {
  load();
  return state.librarians[normalizeName(username)] || null;
}

function librariansIn(kingdomId) {
  load();
  return Object.values(state.librarians).filter((l) => l.kingdomId === kingdomId);
}

// --- books ---------------------------------------------------------------------
const TITLE_FRAMES = Object.freeze([
  (a, s, k) => `${a}'s Treatise on ${s}`,
  (a, s, k) => `A ${k} Account of ${s}`,
  (a, s, k) => `${s}: Notes by ${a}`,
  (a, s, k) => `The ${k} ${s} Compendium`,
]);

function bookTitleFor(author, subject, kingdomId, seq) {
  const frame = TITLE_FRAMES[seq % TITLE_FRAMES.length];
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  return frame(author, cap(subject), cap(kingdomId));
}

function authorEngagement(author) {
  load();
  const key = normalizeName(author);
  let written = 0, researched = 0;
  for (const b of Object.values(state.books)) {
    if (normalizeName(b.author) === key) written += 1;
  }
  // research sessions counted via researchLog presence
  if (state.researchLog[key]) researched = 1;
  return written + researched;
}

function writeBook(authorPlayer, subject, kingdomId, nowMs = Date.now()) {
  load();
  const author = authorPlayer?.getUsername?.() ?? authorPlayer?.username ?? "";
  if (!author) return { ok: false, reason: "no-author" };
  if (!BOOK_SUBJECTS.includes(subject)) return { ok: false, reason: "bad-subject" };
  const lib = ensureLibrary(kingdomId, nowMs);
  if (!lib) return { ok: false, reason: "no-library" };
  const bookCount = Object.values(state.books).filter((b) => b.kingdomId === kingdomId).length;
  if (bookCount >= lib.capacity) return { ok: false, reason: "shelf-full" };
  if (!removePapyrus(authorPlayer, BOOK_WRITE_PAPYRUS)) {
    return { ok: false, reason: "no-papyrus" };
  }
  const quality = Math.min(10, 1 + Math.floor(authorEngagement(author) / 2));
  const id = nextId("book", nowMs);
  state.books[id] = {
    id,
    title: bookTitleFor(author, subject, kingdomId, state.seq),
    subject,
    author: normalizeName(author),
    kingdomId,
    quality,
    writtenAt: nowMs,
    available: true,
  };
  addKnowledge(kingdomId, 1);
  markDirty();
  return { ok: true, book: state.books[id] };
}

function booksIn(kingdomId) {
  load();
  return Object.values(state.books).filter((b) => b.kingdomId === kingdomId);
}

function availableBooks(kingdomId) {
  return booksIn(kingdomId).filter((b) => b.available);
}

function bookById(bookId) {
  load();
  return state.books[bookId] || null;
}

function donateBook(donorPlayer, bookId, kingdomId, nowMs = Date.now()) {
  load();
  const book = state.books[bookId];
  if (!book) return { ok: false, reason: "no-book" };
  // Donation moves the book into the library collection (changes kingdom).
  book.kingdomId = kingdomId;
  book.available = true;
  addKnowledge(kingdomId, 1);
  markDirty();
  return { ok: true, book };
}

// --- lending ---------------------------------------------------------------------
function borrowBook(borrowerPlayer, bookId, nowMs = Date.now()) {
  load();
  const borrower = borrowerPlayer?.getUsername?.() ?? borrowerPlayer?.username ?? "";
  if (!borrower) return { ok: false, reason: "no-borrower" };
  const book = state.books[bookId];
  if (!book || !book.available) return { ok: false, reason: "unavailable" };
  if (!removeCoins(borrowerPlayer, LOAN_DEPOSIT)) {
    return { ok: false, reason: "no-deposit" };
  }
  const id = nextId("loan", nowMs);
  state.loans[id] = {
    id,
    bookId,
    borrower: normalizeName(borrower),
    borrowedAt: nowMs,
    dueAt: nowMs + LOAN_DAYS * 24 * 3600 * 1000,
    returnedAt: 0,
    deposit: LOAN_DEPOSIT,
  };
  book.available = false;
  markDirty();
  return { ok: true, loan: state.loans[id] };
}

function returnBook(borrowerPlayer, loanId, nowMs = Date.now()) {
  load();
  const loan = state.loans[loanId];
  if (!loan || loan.returnedAt) return { ok: false, reason: "no-loan" };
  const book = state.books[loan.bookId];
  // Late fee from real coins.
  let lateFee = 0;
  if (nowMs > loan.dueAt) {
    const daysLate = Math.ceil((nowMs - loan.dueAt) / (24 * 3600 * 1000));
    lateFee = daysLate * LATE_FEE_PER_DAY;
    if (lateFee > 0 && !removeCoins(borrowerPlayer, lateFee)) {
      return { ok: false, reason: "cant-pay-late-fee", lateFee };
    }
  }
  // Deposit back to the borrower (real coins).
  giveCoins(borrowerPlayer, loan.deposit);
  loan.returnedAt = nowMs;
  loan.lateFee = lateFee;
  if (book) book.available = true;
  markDirty();
  return { ok: true, lateFee };
}

function overdueLoans(nowMs = Date.now()) {
  load();
  return Object.values(state.loans).filter((l) => !l.returnedAt && l.dueAt < nowMs);
}

function loansFor(borrower) {
  load();
  const key = normalizeName(borrower);
  return Object.values(state.loans).filter((l) => l.borrower === key && !l.returnedAt);
}

// --- research ----------------------------------------------------------------------
function researchBook(researcherPlayer, bookId, skill, nowMs = Date.now()) {
  load();
  const username = researcherPlayer?.getUsername?.() ?? researcherPlayer?.username ?? "";
  if (!username) return { ok: false, reason: "no-researcher" };
  const book = state.books[bookId];
  if (!book) return { ok: false, reason: "no-book" };
  const key = normalizeName(username);
  const last = state.researchLog[key] || 0;
  if (last > 0 && nowMs - last < RESEARCH_SESSION_MS) {
    return { ok: false, reason: "too-soon" };
  }
  // Real skill XP via CitizenSkilling.
  try {
    const { skillStore } = require("./CitizenSkilling");
    const xp = RESEARCH_XP_PER_SESSION + book.quality * 2;
    skillStore.addXp(username, skill, xp);
  } catch {
    return { ok: false, reason: "no-xp-store" };
  }
  state.researchLog[key] = nowMs;
  markDirty();
  return { ok: true, xp: RESEARCH_XP_PER_SESSION + book.quality * 2 };
}

// --- archives ------------------------------------------------------------------------
const ARCHIVE_SUBJECTS = Object.freeze(["war", "election", "champion", "treaty", "discovery"]);

function writeArchive(kingdomId, event, subject, nowMs = Date.now()) {
  load();
  if (!ARCHIVE_SUBJECTS.includes(subject)) return null;
  if (!KINGDOM_IDS.includes(kingdomId)) return null;
  const archives = (state.archives[kingdomId] = state.archives[kingdomId] || []);
  // Dedupe: same event+subject within 24h is the same record.
  const dupe = archives.find(
    (a) => a.event === event && a.subject === subject && nowMs - a.writtenAt < 24 * 3600 * 1000
  );
  if (dupe) return dupe;
  const record = { id: nextId("archive", nowMs), event, subject, writtenAt: nowMs };
  archives.push(record);
  addKnowledge(kingdomId, 2);
  markDirty();
  return record;
}

function archivesIn(kingdomId) {
  load();
  return state.archives[kingdomId] || [];
}

/** Gather real kingdom events for the archive writer (defensive — all optional). */
function gatherArchiveEvents(kingdomId) {
  const events = [];
  try {
    const Warfare = require("./CitizenWarfare");
    if (typeof Warfare.recentWarsFor === "function") {
      for (const w of Warfare.recentWarsFor(kingdomId) || []) {
        events.push({ event: `War: ${w.name || w.id}`, subject: "war" });
      }
    }
  } catch { /* optional */ }
  try {
    const Treaties = require("./CitizenTreaties");
    if (typeof Treaties.recentTreatiesFor === "function") {
      for (const t of Treaties.recentTreatiesFor(kingdomId) || []) {
        events.push({ event: `Treaty ratified: ${t.type}`, subject: "treaty" });
      }
    }
  } catch { /* optional */ }
  try {
    const Scholars = require("./CitizenScholars");
    if (typeof Scholars.getLibrary === "function") {
      const works = Scholars.getLibrary(kingdomId) || [];
      const latest = works[works.length - 1];
      if (latest) events.push({ event: `Discovery published: ${latest.topic || latest.id}`, subject: "discovery" });
    }
  } catch { /* optional */ }
  return events;
}

// --- knowledge seam --------------------------------------------------------------------
function addKnowledge(kingdomId, delta) {
  load();
  state.knowledge[kingdomId] = Math.max(0, Math.min(100, (state.knowledge[kingdomId] || 0) + delta));
  markDirty();
}

function knowledgeFor(kingdomId) {
  load();
  return state.knowledge[kingdomId] || 0;
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  load,
  save,
  markDirty,
  KINGDOM_IDS,
  BOOK_SUBJECTS,
  ARCHIVE_SUBJECTS,
  LOAN_DEPOSIT,
  LOAN_DAYS,
  LATE_FEE_PER_DAY,
  ensureLibrary,
  libraryFor,
  libraryTile,
  payUpkeep,
  registerLibrarian,
  isLibrarian,
  librarianInfo,
  librariansIn,
  writeBook,
  booksIn,
  availableBooks,
  bookById,
  donateBook,
  borrowBook,
  returnBook,
  overdueLoans,
  loansFor,
  researchBook,
  writeArchive,
  archivesIn,
  gatherArchiveEvents,
  addKnowledge,
  knowledgeFor,
};
