"use strict";

// CitizenScribes unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenScribes.test.js (plain node)
const assert = require("node:assert/strict");
const S = require("./CitizenScribes");

let checks = 0;
function check(cond, msg) {
  checks++;
  assert.ok(cond, msg);
}

// --- scribeTypeFromRoll: weights 30/30/25/15 ---
check(S.scribeTypeFromRoll(0) === S.SCRIBE_COPYIST, "roll 0 -> copyist");
check(S.scribeTypeFromRoll(29) === S.SCRIBE_COPYIST, "roll 29 -> copyist");
check(S.scribeTypeFromRoll(30) === S.SCRIBE_LETTER, "roll 30 -> letter-writer");
check(S.scribeTypeFromRoll(59) === S.SCRIBE_LETTER, "roll 59 -> letter-writer");
check(S.scribeTypeFromRoll(60) === S.SCRIBE_RECORD, "roll 60 -> record-keeper");
check(S.scribeTypeFromRoll(84) === S.SCRIBE_RECORD, "roll 84 -> record-keeper");
check(S.scribeTypeFromRoll(85) === S.SCRIBE_CALLIGRAPHER, "roll 85 -> calligrapher");
check(S.scribeTypeFromRoll(99) === S.SCRIBE_CALLIGRAPHER, "roll 99 -> calligrapher");

// --- scribeTypeOf: commoner gating, stability, universal ---
check(S.scribeTypeOf({ username: "GuardBob", role: "guard" }) === null, "guards do not scribe");
check(S.scribeTypeOf({ username: "MerchMara", role: "MERCHANT" }) === null, "merchants do not scribe");
check(S.scribeTypeOf({ username: "" }) === null, "empty name -> null");
check(S.scribeTypeOf(null) === null, "null record -> null");
const t1 = S.scribeTypeOf({ username: "QuillKid" });
check(S.SCRIBE_TYPES.includes(t1), "commoner gets a type");
check(S.scribeTypeOf({ username: "  quillkid " }) === t1, "case/whitespace stable");
check(S.scribeTypeOf({ username: "QUILLKID" }) === t1, "case stable");

// --- broad distribution: all types reachable, ~100% of names pass ---
{
  const seen = new Set();
  let pass = 0;
  for (let i = 0; i < 2000; i++) {
    const t = S.scribeTypeOf({ username: "ScribeName" + i });
    if (t) { pass++; seen.add(t); }
  }
  check(pass > 1200, `broad distribution: ${pass}/2000 (~65%; librarians excluded)`);
  check(seen.size === 4, `all 4 types reachable: ${[...seen].join(",")}`);
}

// --- librarians excluded (professional library scribes own that) ---
{
  const lib = require("./CitizenLibrarians");
  let excluded = 0, tested = 0;
  for (let i = 0; i < 500 && tested < 25; i++) {
    const name = "LibCheck" + i;
    if (lib.isLibrarian(name)) {
      tested++;
      if (S.scribeTypeOf({ username: name }) === null) excluded++;
    }
  }
  check(tested > 0, "found librarians to test");
  check(excluded === tested, `all ${tested} librarians excluded from freelance scribing`);
}

// --- scriptoriumFor: kingdom-preferred, stable ---
{
  const s1 = S.scriptoriumFor({ username: "QuillKid", kingdomId: "varrock" });
  check(s1.kingdom === "varrock", "varrock citizen gets varrock scriptorium");
  check(S.scriptoriumFor({ username: "QuillKid", kingdomId: "varrock" }) === s1, "stable");
  const s2 = S.scriptoriumFor({ username: "QuillKid", kingdomId: "nope" });
  check(s2 && s2.name, "falls back to any scriptorium");
}

// --- jobsFor: deterministic, day-varying ---
{
  const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // local-time constructor (EDT rule)
  const j1 = S.jobsFor("QuillKid", T0);
  check(Array.isArray(j1) && j1.length >= 1 && j1.length <= 3, "1-3 jobs");
  check(JSON.stringify(j1) === JSON.stringify(S.jobsFor("QuillKid", T0)), "deterministic same day");
  const j2 = S.jobsFor("QuillKid", T0 + 86400000);
  check(Array.isArray(j2), "next day still jobs");
}

// --- manuscriptForToday: librarian tie-in, never throws ---
{
  const T0 = new Date(2026, 9, 8, 10, 0).getTime();
  const m = S.manuscriptForToday(T0);
  check(typeof m === "string" && m.length > 0, "manuscript is a non-empty string");
  check(S.manuscriptForToday(null) !== undefined, "null date does not throw");
}

// --- pricesFor: sane prices ---
{
  const p = S.pricesFor(S.SCRIBE_CALLIGRAPHER);
  check(p.length === 3, "calligrapher has 3 services");
  check(p.every((s) => s.price > 0 && s.price <= 100), "prices sane and capped");
  check(S.pricesFor("nope").length === 0, "unknown type -> empty");
}

// --- ledgers: round-trip + TTL expiry ---
{
  S._resetState();
  const T0 = new Date(2026, 9, 8, 10, 0).getTime();
  check(S.hireScribe("Jon", "QuillKid", "a love letter", T0) === "a love letter", "hire returns service");
  const h = S.hireFor("Jon", T0 + 1000);
  check(h && h.scribe === "quillkid" && h.service === "a love letter", "hire round-trips");
  check(S.hireFor("Jon", T0 + 8 * 86400000) === null, "hire expires after 7 days");
  check(S.hireScribe("", "QuillKid", "x", T0) === null, "empty player rejected");
  check(S.hireScribe("Jon", "", "x", T0) === null, "empty scribe rejected");

  S._resetState(); // avoid prune rate-limit cross-test pollution
  check(S.requestCopy("Jon", "the Chronicles", T0) === "the Chronicles", "copy request returns title");
  check(S.copyFor("Jon", T0 + 1000) === "the Chronicles", "copy round-trips");
  check(S.copyFor("Jon", T0 + 8 * 86400000) === null, "copy expires after 7 days");

  S._resetState(); // avoid prune rate-limit cross-test pollution
  check(S.commissionRecord("Jon", "shop takings", T0) === "shop takings", "record commission returns subject");
  check(S.recordFor("Jon", T0 + 1000) === "shop takings", "record round-trips");
  check(S.recordFor("Jon", T0 + 8 * 86400000) === null, "record expires after 7 days");
  S._resetState();
}

// --- scriptorium hours: local-time constructors (EDT rule) ---
check(S.isScriptHour(new Date(2026, 9, 8, 8, 0).getTime()) === true, "08:00 open");
check(S.isScriptHour(new Date(2026, 9, 8, 12, 30).getTime()) === true, "midday open");
check(S.isScriptHour(new Date(2026, 9, 8, 17, 59).getTime()) === true, "17:59 open");
check(S.isScriptHour(new Date(2026, 9, 8, 18, 0).getTime()) === false, "18:00 closed");
check(S.isScriptHour(new Date(2026, 9, 8, 3, 0).getTime()) === false, "03:00 closed");

// --- guards: isRealPlayer / isCitizenBot / withinTiles ---
{
  const real = { getUsername: () => "Jon", isPlayerBot: () => false, getHostAddress: () => "127.0.0.1" };
  const bot = { getUsername: () => "Bot1", isPlayerBot: () => true, getHostAddress: () => "bot" };
  check(S.isRealPlayer(real) === true, "real player passes");
  check(S.isRealPlayer(bot) === false, "bot rejected");
  check(S.isRealPlayer(null) === false, "null rejected");
  check(S.isCitizenBot(bot) === true, "bot detected");
  check(S.isCitizenBot(real) === false, "real not a bot");

  const loc = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  check(S.withinTiles(loc(0, 0, 0), loc(10, 10, 0), 14) === true, "within radius");
  check(S.withinTiles(loc(0, 0, 0), loc(20, 0, 0), 14) === false, "outside radius");
  check(S.withinTiles(loc(0, 0, 0), loc(0, 0, 1), 14) === false, "different plane");
}

// --- tick: fires near a real player, silent otherwise ---
function mockDirector({ rosterNames, realNear, hourMs }) {
  const roster = new Map(rosterNames.map((u) => [u.toLowerCase(), { username: u, role: "commoner" }]));
  const players = {};
  for (const u of rosterNames) {
    players[u.toLowerCase()] = {
      getUsername: () => u,
      isPlayerBot: () => true,
      getHostAddress: () => "bot",
      forceChat: (m) => { (players[u.toLowerCase()]._chats ||= []).push(m); },
      getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    };
  }
  const real = {
    getUsername: () => "Jon",
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getLocation: () => ({ getX: () => realNear ? 5 : 500, getY: () => 0, getZ: () => 0 }),
  };
  return {
    roster,
    playerFor: (rec) => players[String(rec.username).toLowerCase()] ?? null,
    onlinePlayers: () => [real, ...Object.values(players)],
    _real: real,
    _players: players,
  };
}

// find a username that is a scribe AND hobby-visible for "scribe"
function visibleScribeName() {
  const H = require("./CitizenPrimaryHobby");
  for (let i = 0; i < 5000; i++) {
    const name = "TickScribe" + i;
    if (S.scribeTypeOf({ username: name }) && H.isHobbyVisible(name, "scribe")) return name;
  }
  throw new Error("no visible scribe found");
}

{
  S._resetState();
  const name = visibleScribeName();
  const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local, scriptorium open
  const d = mockDirector({ rosterNames: [name], realNear: true, hourMs: T0 });
  // force the chance gate: stub Math.random to 0
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    S.tickScribes(d, T0);
  } finally {
    Math.random = origRandom;
  }
  const chats = d._players[name.toLowerCase()]._chats || [];
  check(chats.length === 1, `tick fires near real player (got ${chats.length} chats)`);
}

{
  S._resetState();
  const name = visibleScribeName();
  const T0 = new Date(2026, 9, 8, 10, 0).getTime();
  const d = mockDirector({ rosterNames: [name], realNear: false, hourMs: T0 });
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    S.tickScribes(d, T0);
  } finally {
    Math.random = origRandom;
  }
  const chats = d._players[name.toLowerCase()]._chats || [];
  check(chats.length === 0, "tick silent when no real player near");
}

{
  S._resetState();
  const name = visibleScribeName();
  const T3 = new Date(2026, 9, 8, 3, 0).getTime(); // 03:00 local, closed
  const d = mockDirector({ rosterNames: [name], realNear: true, hourMs: T3 });
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    S.tickScribes(d, T3);
  } finally {
    Math.random = origRandom;
  }
  const chats = d._players[name.toLowerCase()]._chats || [];
  check(chats.length === 0, "tick silent outside scriptorium hours");
}

// --- tick never throws on hostile input ---
{
  S._resetState();
  S.tickScribes(null, Date.now());
  S.tickScribes({}, Date.now());
  S.tickScribes({ roster: null }, Date.now());
  check(true, "never throws on hostile director");
}

// --- fill / hash helpers ---
check(S.fill("Copy {title} for {name}.", { title: "X", name: "Jon" }) === "Copy X for Jon.", "fill works");
check(S.fill("No tokens.", {}) === "No tokens.", "fill passthrough");
check(typeof S.hashStr("x") === "number", "hashStr returns number");
check(S.hashStr("a") === S.hashStr("a"), "hashStr stable");

console.log(`All CitizenScribes checks passed (${checks} assertions).`);
