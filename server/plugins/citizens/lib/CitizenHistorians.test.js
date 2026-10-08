"use strict";

// CitizenHistorians unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  tickHistorians,
  historianTypeOf,
  historianTypeFromRoll,
  archiveFor,
  chronicleFor,
  chronicleEventsFor,
  recentChronicles,
  legendPreservedFor,
  librarianNoteFor,
  requestReading,
  readingFor,
  contributeAccount,
  accountFor,
  commissionHistory,
  commissionFor,
  hashStr,
  pickOne,
  fill,
  dayNumber,
  seededRng,
  isArchiveHour,
  isRealPlayer,
  withinTiles,
  HISTORIAN_TYPES,
  _resetState,
} = require("./CitizenHistorians");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- Type roll distribution ---
// 1. Rolls land in each bucket at the right boundaries (35/25/20/20).
assert.equal(historianTypeFromRoll(0), "chronicler");
assert.equal(historianTypeFromRoll(34), "chronicler");
assert.equal(historianTypeFromRoll(35), "archivist");
assert.equal(historianTypeFromRoll(59), "archivist");
assert.equal(historianTypeFromRoll(60), "genealogist");
assert.equal(historianTypeFromRoll(79), "genealogist");
assert.equal(historianTypeFromRoll(80), "lorekeeper");
assert.equal(historianTypeFromRoll(99), "lorekeeper");

// 2. historianTypeOf is stable for the same username and always a known type.
const rec = { username: "ChroniclerTestUser", role: "commoner", kingdomId: "asgarnia" };
const t1 = historianTypeOf(rec);
assert.ok(HISTORIAN_TYPES.includes(t1), "type must be one of the four");
assert.equal(historianTypeOf(rec), t1, "stable across calls");

// 3. Non-commoners are never historians (activity system only for commoners,
//    but no exclusion chain applies).
assert.equal(historianTypeOf({ username: "GuardUser", role: "guard" }), null);
assert.equal(historianTypeOf({ username: "MerchantUser", role: "COMMONER", kingdomId: "misthalin" }).constructor, String);

// 4. archiveFor is kingdom-preferred and stable.
const a1 = archiveFor({ username: "ArchiveTestUser", kingdomId: "asgarnia" });
assert.equal(a1.kingdom, "asgarnia");
assert.equal(archiveFor({ username: "ArchiveTestUser", kingdomId: "asgarnia" }).name, a1.name);

// --- Chronicle determinism ---
// 5. Same args → same chronicle; different day → different entries (derived).
const c1 = chronicleFor("misthalin", new Date(2026, 9, 8, 12, 0).getTime());
const c2 = chronicleFor("misthalin", new Date(2026, 9, 8, 12, 0).getTime());
assert.deepEqual(c1, c2, "chronicle must be deterministic");
assert.equal(c1.entries.length, 3, "chronicle fills to 3 entries");
assert.ok(c1.entries.every((e) => typeof e === "string" && e.length > 0));
assert.equal(c1.kingdom, "Misthalin");
const c3 = chronicleFor("misthalin", new Date(2026, 9, 9, 12, 0).getTime());
assert.ok(!c3.entries.every((e, i) => e === c1.entries[i]), "different day differs");

// 6. recentChronicles returns 3 days of chronicles.
const rc = recentChronicles("kandarin", new Date(2026, 9, 8, 12, 0).getTime());
assert.equal(rc.length, 3);
assert.ok(rc[0].date === rc[1].date + 1, "days descend");

// 7. chronicleEventsFor is bounded and safe with no journal loaded.
const evs = chronicleEventsFor();
assert.ok(Array.isArray(evs) && evs.length <= 3);

// --- Ledgers ---
_resetState();
// 8. Read-request round trip.
assert.equal(readingFor("NoSuchPlayer"), null);
assert.equal(requestReading("Cofy", "asgarnia"), "asgarnia");
assert.equal(readingFor("Cofy"), "asgarnia");

// 9. Account contribution round trip + truncation.
const long = "x".repeat(500);
assert.equal(contributeAccount("Cofy", long).length, 280);
assert.equal(accountFor("Cofy").length, 280);
assert.equal(accountFor("Nobody"), null);

// 10. Commission round trip + blank rejection.
assert.equal(commissionHistory("Cofy", ""), null);
assert.equal(commissionHistory("Cofy", "the history of my family line"), "the history of my family line");
assert.equal(commissionFor("Cofy"), "the history of my family line");
assert.equal(commissionFor("Nobody"), null);

// --- Cross-system bridges ---
// 11. Storyteller bridge: lorekeeper preserves an oral legend as written record.
const legend = legendPreservedFor("misthalin", new Date(2026, 9, 8, 12, 0).getTime());
assert.ok(legend === null || (typeof legend === "string" && legend.length > 0));

// 12. Librarian bridge: cross-reference note names a real library.
const note = librarianNoteFor("BridgeTestUser", "misthalin", new Date(2026, 9, 8, 12, 0).getTime());
assert.ok(note === null || note.includes("written records are kept at"), JSON.stringify(note));

// --- Pure helpers ---
// 13. Archive hours read server-local time (use local constructors, not UTC).
assert.equal(isArchiveHour(new Date(2026, 9, 8, 8, 0).getTime()), true);
assert.equal(isArchiveHour(new Date(2026, 9, 8, 12, 0).getTime()), true);
assert.equal(isArchiveHour(new Date(2026, 9, 8, 19, 59).getTime()), true);
assert.equal(isArchiveHour(new Date(2026, 9, 8, 20, 0).getTime()), false);
assert.equal(isArchiveHour(new Date(2026, 9, 8, 3, 0).getTime()), false);

// 14. fill / dayNumber / seededRng basics.
assert.equal(fill("hello {name}", { name: "cofy" }), "hello cofy");
assert.equal(dayNumber(0), 0);
assert.equal(pickOne(lcg(1), ["a"]), "a");
assert.equal(hashStr("x"), hashStr("x"));

// 15. isRealPlayer rejects bots and nulls.
assert.equal(isRealPlayer(null), false);
assert.equal(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "bot" }), false);
assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
assert.equal(isRealPlayer({ getUsername: () => "Cofy" }), true);

// 16. withinTiles plane mismatch fails, near passes.
function fakeLoc(x, y, z) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
const pa = { getLocation: () => fakeLoc(0, 0, 0) };
const pb = { getLocation: () => fakeLoc(5, 5, 0) };
const pc = { getLocation: () => fakeLoc(5, 5, 1) };
assert.equal(withinTiles(pa, pb, 14), true);
assert.equal(withinTiles(pa, pb, 4), false);
assert.equal(withinTiles(pa, pc, 14), false);

// --- Tick ---
_resetState();
// 17. Tick fires scripted output for an eligible historian near a real player.
const chatLines = [];
const now = new Date(2026, 9, 8, 12, 0).getTime();
const citizenRec = { username: "TickHistorian", role: "commoner", kingdomId: "misthalin" };
const fakeCitizen = {
  getLocation: () => fakeLoc(100, 100, 0),
  forceChat: (s) => chatLines.push(s),
  getUsername: () => "TickHistorian",
};
const fakePlayer = {
  getLocation: () => fakeLoc(102, 101, 0),
  getUsername: () => "RealHuman",
};
const director = {
  roster: new Map([["TickHistorian", citizenRec]]),
  playerFor: () => fakeCitizen,
  onlinePlayers: () => [fakePlayer],
};
// Force pass the chance gate by overriding Math.random.
const origRandom = Math.random;
Math.random = () => 0.0;
try {
  tickHistorians(director, now);
} finally {
  Math.random = origRandom;
}
assert.ok(chatLines.length > 0, "historian near a real player should speak");

// 18. Tick never fires outside archive hours, and never crashes on garbage.
_resetState();
const chatLines2 = [];
fakeCitizen.forceChat = (s) => chatLines2.push(s);
tickHistorians(director, new Date(2026, 9, 8, 3, 0).getTime());
assert.equal(chatLines2.length, 0, "no output at 03:00");
tickHistorians({}, Date.now());
tickHistorians(null, Date.now());
assert.equal(chatLines.length > 0, true);

console.log("CitizenHistorians: all tests passed");
