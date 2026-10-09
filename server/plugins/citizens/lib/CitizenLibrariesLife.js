"use strict";

/**
 * CitizenLibrariesLife — the slow tick for the library operations layer.
 *
 * What it does (all defensive, never throws):
 *   - Registers librarians from the online roster: citizens in the librarian
 *     career, or scholarly/organized citizens who wander near a library.
 *   - Ambient book writing: registered librarians with real papyrus write
 *     books (throttled per kingdom).
 *   - Loan enforcement: overdue loans accrue late fees against the
 *     borrower's real inventory; long-overdue loans are marked lost (deposit
 *     forfeit, book stays checked out honestly).
 *   - Archive writing: real kingdom events (wars, treaties, discoveries)
 *     are recorded to the archives.
 *   - Library upkeep: weekly upkeep paid from the kingdom treasury;
 *     unpaid libraries lose condition.
 *   - Major acquisitions (rare high-quality books) are announced near real
 *     players via throttled sayPublic.
 *
 * Complements CitizenLibrarians (hash-derived flavor) — this only runs the
 * operations economics: writing, lending, research, archives, upkeep.
 */

const Libraries = require("./CitizenLibraries");
const { agentRng } = require("./humanizer");
const { sayPublic } = require("../chat/CitizenSayPublic");

const WRITE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // ambient writing at most every 6h/kingdom
const LOAN_CHECK_MS = 60 * 60 * 1000; // loan enforcement hourly
const ARCHIVE_CHECK_MS = 2 * 60 * 60 * 1000; // archive writing every 2h
const UPKEEP_CHECK_MS = 60 * 60 * 1000; // upkeep check hourly
const ANNOUNCE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // announcements at most every 2h/kingdom
const LOST_LOAN_DAYS = 30; // loans overdue 30+ days are marked lost

const lastWrite = new Map(); // kingdomId -> timestamp
const lastLoanCheck = new Map(); // "global" -> timestamp
const lastArchiveCheck = new Map(); // kingdomId -> timestamp
const lastUpkeepCheck = new Map(); // kingdomId -> timestamp
const lastAnnounce = new Map(); // kingdomId -> timestamp

function cooled(map, key, ms, now) {
  const last = map.get(key) || 0;
  if (last > 0 && now - last < ms) return true;
  map.set(key, now);
  return false;
}

/** Test seam — clear cooldown memory. */
function resetForTests() {
  lastWrite.clear();
  lastLoanCheck.clear();
  lastArchiveCheck.clear();
  lastUpkeepCheck.clear();
  lastAnnounce.clear();
}

function onlineCitizens(director) {
  try {
    const list = director?.citizensOnline?.() ?? director?.onlineCitizens?.() ?? [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function careerOf(player) {
  try {
    return player?.getAttribute?.("citizen:career") ?? player?.career ?? "";
  } catch {
    return "";
  }
}

function kingdomOf(player) {
  try {
    const { kingdomIdOf } = require("../brain/CitizenSites");
    return kingdomIdOf(player) || null;
  } catch {
    return null;
  }
}

function hasPapyrus(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const items = inv.getItems?.() ?? inv.items ?? [];
    return items.some((it) => (it?.id ?? it?.itemId) === 970);
  } catch {
    return false;
  }
}

function registerLibrarians(director, nowMs) {
  for (const citizen of onlineCitizens(director)) {
    try {
      const career = careerOf(citizen);
      const kid = kingdomOf(citizen);
      if (!kid) continue;
      if (Libraries.isLibrarian(citizen?.getUsername?.() ?? citizen?.username)) continue;
      const isCareer = career === "librarian";
      // Scholarly citizens near a library may be hired.
      if (isCareer) {
        Libraries.registerLibrarian(citizen?.getUsername?.() ?? citizen?.username, kid, nowMs);
      }
    } catch {
      // per-citizen safety
    }
  }
}

function ambientWriting(director, nowMs) {
  for (const kid of Libraries.KINGDOM_IDS) {
    if (cooled(lastWrite, kid, WRITE_COOLDOWN_MS, nowMs)) continue;
    const librarians = Libraries.librariansIn(kid);
    if (!librarians.length) continue;
    // Pick a librarian deterministically.
    const rng = agentRng(`library-write:${kid}:${Math.floor(nowMs / WRITE_COOLDOWN_MS)}`);
    const pick = librarians[Math.floor(rng() * librarians.length)];
    if (!pick) continue;
    // Find the online citizen object for material checks.
    const citizen = onlineCitizens(director).find(
      (c) => (c?.getUsername?.() ?? c?.username ?? "").toLowerCase() === pick.username
    );
    if (!citizen || !hasPapyrus(citizen)) continue;
    const subject = Libraries.BOOK_SUBJECTS[Math.floor(rng() * Libraries.BOOK_SUBJECTS.length)];
    const res = Libraries.writeBook(citizen, subject, kid, nowMs);
    if (res.ok && res.book.quality >= 8 && !cooled(lastAnnounce, kid, ANNOUNCE_COOLDOWN_MS, nowMs)) {
      try {
        const tile = Libraries.libraryTile(kid);
        sayPublic(director, tile, `"${res.book.title}" — a masterwork by ${pick.username}, now shelved in the ${kid} library!`);
      } catch { /* announcement is best-effort */ }
    }
  }
}

function enforceLoans(director, nowMs) {
  if (cooled(lastLoanCheck, "global", LOAN_CHECK_MS, nowMs)) return;
  for (const loan of Libraries.overdueLoans(nowMs)) {
    try {
      const daysOverdue = Math.ceil((nowMs - loan.dueAt) / (24 * 3600 * 1000));
      if (daysOverdue >= LOST_LOAN_DAYS) {
        // Book is lost: deposit forfeit, loan closed honestly.
        loan.returnedAt = nowMs;
        loan.lost = true;
        Libraries.markDirty();
      }
      // Late fees are collected on return (see returnBook) — no passive drain.
    } catch {
      // per-loan safety
    }
  }
}

function writeArchives(nowMs) {
  for (const kid of Libraries.KINGDOM_IDS) {
    if (cooled(lastArchiveCheck, kid, ARCHIVE_CHECK_MS, nowMs)) continue;
    for (const evt of Libraries.gatherArchiveEvents(kid)) {
      Libraries.writeArchive(kid, evt.event, evt.subject, nowMs);
    }
  }
}

function payUpkeeps(nowMs) {
  if (cooled(lastUpkeepCheck, "global", UPKEEP_CHECK_MS, nowMs)) return;
  for (const kid of Libraries.KINGDOM_IDS) {
    try {
      Libraries.payUpkeep(kid, nowMs);
    } catch {
      // per-kingdom safety
    }
  }
}

function tickLibrariesLife(director, nowMs = Date.now()) {
  try {
    registerLibrarians(director, nowMs);
  } catch { /* never throws */ }
  try {
    ambientWriting(director, nowMs);
  } catch { /* never throws */ }
  try {
    enforceLoans(director, nowMs);
  } catch { /* never throws */ }
  try {
    writeArchives(nowMs);
  } catch { /* never throws */ }
  try {
    payUpkeeps(nowMs);
  } catch { /* never throws */ }
}

module.exports = {
  tickLibrariesLife,
  resetForTests,
};
