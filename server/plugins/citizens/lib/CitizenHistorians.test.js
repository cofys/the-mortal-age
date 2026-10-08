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
  preservedLegendFor,
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
  CHRONICLE_LINES,
  LEDGER_ACK_LINES,
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

// --- Rung 2: real-API wiring + in-world acknowledgment ---
const Journal = require("./CitizenJournal");
const Rumors = require("./CitizenRumors");
const { isHobbyVisible } = require("./CitizenPrimaryHobby");

// A username whose hobby visibility passes (deterministic, hash-based).
function visibleHistorian(base) {
  for (let i = 0; i < 500; i++) {
    const name = base + i;
    if (isHobbyVisible(name, "historian")) return name;
  }
  throw new Error("no visible historian username found");
}
// A local-noon timestamp whose deterministic chronicle roll does (or does
// not) fire the once-per-archive-per-day chronicle moment.
function chronicleDay(username, wantFire) {
  const archive = archiveFor({ username, kingdomId: "misthalin" });
  for (let d = 0; d < 400; d++) {
    const ms = new Date(2026, 9, 8 + d, 12, 0).getTime();
    const rng = seededRng(hashStr("chronicle:" + archive.name + ":" + dayNumber(ms)));
    if ((rng() < 0.1) === wantFire) return ms;
  }
  throw new Error("no suitable chronicle day found");
}

// 19. The chronicle moment writes via CitizenJournal.log (the REAL journal
// API — addEntry does not exist) and seeds via the REAL
// seedRumor(rng, event) signature (a bare string is a silent no-op).
_resetState();
Journal.getJournal().resetForTests();
Rumors.resetForTests();
const rumorName = visibleHistorian("RumorHistorian");
const rumorMs = chronicleDay(rumorName, true);
const chatR = [];
const citR = {
  getLocation: () => fakeLoc(200, 200, 0),
  forceChat: (s) => chatR.push(s),
  getUsername: () => rumorName,
};
const dirR = {
  roster: new Map([[rumorName, { username: rumorName, role: "commoner", kingdomId: "misthalin" }]]),
  playerFor: () => citR,
  onlinePlayers: () => [{ getLocation: () => fakeLoc(201, 200, 0), getUsername: () => "RealHuman2" }],
};
Math.random = () => 0.0;
try {
  tickHistorians(dirR, rumorMs);
} finally {
  Math.random = origRandom;
}
const recentR = Journal.getJournal().recent(rumorName, 5);
assert.ok(
  recentR.some((e) => e.text.includes("entered today's chronicle")),
  "chronicle moment must journalize through log()"
);
const seeded = [...Rumors._activeRumors.values()].filter((r) => r.seedKind === "chronicle");
assert.ok(seeded.length > 0, "chronicle moment must seed a real rumor");
assert.ok(seeded.some((r) => r.truth.who === rumorName), "rumor holder is the historian");
assert.ok(chatR.length > 0, "chronicle moment should speak");
assert.ok(chatR.every((l) => l.length <= 120), "every spoken chronicle line <=120 chars");

// 20. A nearby player with a pending reading/account/commission gets a
// scripted in-world answer (the ledgers finally talk back).
const ackCases = [
  ["reading", "read today's entry", (n, ms) => requestReading(n, "misthalin", ms)],
  ["account", "entered in the annals", (n, ms) => contributeAccount(n, "I saw the dragon fly over at dawn.", ms)],
  ["commission", "commissioned history is underway", (n, ms) => commissionHistory(n, "my family line", ms)],
];
for (const [kind, snippet, setup] of ackCases) {
  _resetState();
  const cname = visibleHistorian("AckHistorian" + kind);
  const ms = chronicleDay(cname, false); // no chronicle moment: the ack branch must run
  const pname = "LedgerPlayer" + kind;
  setup(pname, ms);
  const lines = [];
  const cit = {
    getLocation: () => fakeLoc(300, 300, 0),
    forceChat: (s) => lines.push(s),
    getUsername: () => cname,
  };
  const dir = {
    roster: new Map([[cname, { username: cname, role: "commoner", kingdomId: "misthalin" }]]),
    playerFor: () => cit,
    onlinePlayers: () => [{ getLocation: () => fakeLoc(301, 300, 0), getUsername: () => pname }],
  };
  Math.random = () => 0.0;
  try {
    tickHistorians(dir, ms);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(
    lines.some((l) => l.includes(snippet)),
    `expected a ${kind} acknowledgment, got ${JSON.stringify(lines)}`
  );
  assert.ok(lines.every((l) => l.length <= 120), "ack lines <=120 chars");
}

// 21. Every filled chronicle line stays within the 120-char convention.
for (const kid of ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"]) {
  const ch = chronicleFor(kid, new Date(2026, 9, 8, 12, 0).getTime());
  for (const e of ch.entries) {
    for (const t of CHRONICLE_LINES) {
      const s = fill(t, { kingdom: ch.kingdom, entry: e });
      assert.ok(s.length <= 120, `chronicle line too long (${s.length}): ${s}`);
    }
  }
}
for (const l of Object.values(LEDGER_ACK_LINES)) assert.ok(l.length <= 120);

// 22. preservedLegendFor returns { legend, text }; the string wrapper matches.
_resetState();
const pl = preservedLegendFor("misthalin", new Date(2026, 9, 8, 12, 0).getTime());
assert.ok(pl === null || (typeof pl.legend === "string" && typeof pl.text === "string"));
if (pl) {
  assert.equal(legendPreservedFor("misthalin", new Date(2026, 9, 8, 12, 0).getTime()), pl.text);
}

console.log("CitizenHistorians: all tests passed");
