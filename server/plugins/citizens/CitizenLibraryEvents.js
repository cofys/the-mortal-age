"use strict";

/**
 * CitizenLibraryEvents — player-facing library operations: the ::library command.
 *
 * Mirrors the ::gallery / ::festival / ::runway command pattern
 * (PlayerRights.NONE so every player can use it). Players can check library
 * status, write books, borrow/return books, research books for real skill XP,
 * read the archives, and donate books. Bots are rejected: citizens work
 * through the brain, not the command.
 */

const Libraries = require("./lib/CitizenLibraries");

const LIBRARY_USAGE =
  "::library [status|books|write <subject>|borrow <bookId>|return <loanId>|loans|research <bookId> <skill>|archives|donate <bookId>]";

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function isRealPlayer(player) {
  try {
    // Engine truth: Player#isPlayerBot() (server/src/main/typescript/elvarg/game/entity/impl/player/Player.ts:1084)
    // returns true for bot entities. The `?? false` fallback is deliberate: gate
    // call sites always receive a live command entity, so isPlayerBot() is always
    // callable there; the fallback preserves the legacy pass-through for anything
    // that isn't a known bot instead of silently blocking a new class of callers.
    return !(player?.isPlayerBot?.() ?? false);
  } catch {
    return true;
  }
}

function say(player, text) {
  try {
    player?.sendMessage?.(text);
  } catch {
    // messaging is best-effort
  }
}

function kingdomOf(player) {
  try {
    const { kingdomIdOf } = require("./lib/../brain/CitizenSites");
    return kingdomIdOf(player) || null;
  } catch {
    return null;
  }
}

function onLibraryCommand(player, args) {
  if (!isRealPlayer(player)) {
    say(player, "Citizens work the libraries through their own routines.");
    return;
  }
  const sub = (args[0] || "status").toLowerCase();
  const kid = kingdomOf(player);
  const nowMs = Date.now();

  if (sub === "status") {
    if (!kid) return say(player, "You are not in a kingdom with a library.");
    const lib = Libraries.ensureLibrary(kid, nowMs);
    const books = Libraries.booksIn(kid).length;
    const available = Libraries.availableBooks(kid).length;
    const knowledge = Libraries.knowledgeFor(kid);
    say(player, `Library of ${kid}: ${books} books (${available} available), condition ${lib.condition}%, knowledge ${knowledge}.`);
    return;
  }

  if (sub === "books") {
    if (!kid) return say(player, "You are not in a kingdom with a library.");
    const books = Libraries.availableBooks(kid).slice(0, 10);
    if (!books.length) return say(player, "No books available right now.");
    for (const b of books) {
      say(player, `[${b.id}] "${b.title}" — ${b.subject}, quality ${b.quality}/10, by ${b.author}`);
    }
    return;
  }

  if (sub === "write") {
    const subject = (args[1] || "").toLowerCase();
    if (!Libraries.BOOK_SUBJECTS.includes(subject)) {
      return say(player, `Subjects: ${Libraries.BOOK_SUBJECTS.join(", ")}. Usage: ::library write <subject>`);
    }
    if (!kid) return say(player, "You are not in a kingdom with a library.");
    const res = Libraries.writeBook(player, subject, kid, nowMs);
    if (!res.ok && res.reason === "no-papyrus") return say(player, "You need papyrus (970) to write a book.");
    if (!res.ok) return say(player, `Could not write: ${res.reason}.`);
    say(player, `You wrote "${res.book.title}" (quality ${res.book.quality}/10). It is shelved in the ${kid} library.`);
    return;
  }

  if (sub === "borrow") {
    const bookId = args[1];
    if (!bookId) return say(player, "Usage: ::library borrow <bookId>");
    const res = Libraries.borrowBook(player, bookId, nowMs);
    if (!res.ok && res.reason === "no-deposit") {
      return say(player, `You need ${Libraries.LOAN_DEPOSIT} coins deposit to borrow.`);
    }
    if (!res.ok) return say(player, `Could not borrow: ${res.reason}.`);
    say(player, `Borrowed. Due in ${Libraries.LOAN_DAYS} days. Deposit ${Libraries.LOAN_DEPOSIT} coins held.`);
    return;
  }

  if (sub === "return") {
    const loanId = args[1];
    if (!loanId) return say(player, "Usage: ::library return <loanId>");
    const res = Libraries.returnBook(player, loanId, nowMs);
    if (!res.ok && res.reason === "cant-pay-late-fee") {
      return say(player, `Overdue! You owe a ${res.lateFee}-coin late fee you cannot pay.`);
    }
    if (!res.ok) return say(player, `Could not return: ${res.reason}.`);
    say(player, res.lateFee > 0 ? `Returned late. Late fee ${res.lateFee} coins paid. Deposit refunded.` : "Returned on time. Deposit refunded.");
    return;
  }

  if (sub === "loans") {
    const loans = Libraries.loansFor(usernameOf(player));
    if (!loans.length) return say(player, "You have no books on loan.");
    for (const l of loans.slice(0, 10)) {
      const book = Libraries.bookById(l.bookId);
      const due = new Date(l.dueAt).toLocaleDateString();
      say(player, `[${l.id}] "${book?.title ?? l.bookId}" — due ${due}`);
    }
    return;
  }

  if (sub === "research") {
    const bookId = args[1];
    const skill = (args[2] || "").toLowerCase();
    if (!bookId || !skill) return say(player, "Usage: ::library research <bookId> <skill>");
    const res = Libraries.researchBook(player, bookId, skill, nowMs);
    if (!res.ok && res.reason === "too-soon") return say(player, "You need rest before another research session.");
    if (!res.ok) return say(player, `Could not research: ${res.reason}.`);
    say(player, `Research session complete: +${res.xp} ${skill} XP.`);
    return;
  }

  if (sub === "archives") {
    if (!kid) return say(player, "You are not in a kingdom with archives.");
    const records = Libraries.archivesIn(kid).slice(-10);
    if (!records.length) return say(player, "The archives are empty — history is still being written.");
    for (const r of records) {
      say(player, `[${r.subject}] ${r.event}`);
    }
    return;
  }

  if (sub === "donate") {
    const bookId = args[1];
    if (!bookId) return say(player, "Usage: ::library donate <bookId>");
    if (!kid) return say(player, "You are not in a kingdom with a library.");
    const res = Libraries.donateBook(player, bookId, kid, nowMs);
    if (!res.ok) return say(player, `Could not donate: ${res.reason}.`);
    say(player, `Donated "${res.book.title}" to the ${kid} library. The kingdom thanks you.`);
    return;
  }

  say(player, LIBRARY_USAGE);
}

module.exports = { onLibraryCommand, LIBRARY_USAGE };
