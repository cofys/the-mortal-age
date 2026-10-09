"use strict";

/**
 * CitizenRelationships unit checks — citizen↔citizen bond formation.
 *
 * Pure dynamics + tick promotion, no running server. CitizenBonds and
 * CitizenJournal are stubbed in the require cache (same pattern as
 * CitizenRoutine.test.js) so no disk writes happen.
 */

const assert = require("node:assert/strict");
const path = require("node:path");

function stubEngineModules() {
  const friends = new Map(); // name -> Set
  const enemies = new Map();
  const journalCalls = [];
  const norm = (n) => String(n ?? "").trim().toLowerCase();
  const bondsStub = {
    isFriend: (a, b) => friends.get(norm(a))?.has(norm(b)) ?? false,
    isEnemy: (a, b) => enemies.get(norm(a))?.has(norm(b)) ?? false,
    addFriend: (a, b) => {
      const na = norm(a), nb = norm(b);
      if (!friends.has(na)) friends.set(na, new Set());
      if (friends.get(na).has(nb)) return false;
      friends.get(na).add(nb);
      return true;
    },
    addEnemy: (a, b) => {
      const na = norm(a), nb = norm(b);
      if (!enemies.has(na)) enemies.set(na, new Set());
      if (enemies.get(na).has(nb)) return false;
      enemies.get(na).add(nb);
      return true;
    },
    _friends: friends,
    _enemies: enemies,
  };
  const journalStub = {
    getJournal: () => ({
      log: (name, kind, text) => journalCalls.push({ name, kind, text }),
    }),
    _calls: journalCalls,
  };
  for (const [rel, exports] of Object.entries({
    "../lib/CitizenBonds": bondsStub,
    "../lib/CitizenJournal": journalStub,
  })) {
    const resolved = path.resolve(__dirname, rel + ".js");
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }
  return { bondsStub, journalStub };
}
const { bondsStub, journalStub } = stubEngineModules();

const {
  compatibility,
  noteInteraction,
  rapportOf,
  tickRelationships,
  pairKey,
  resetForTests,
  pairCount,
  FRIEND_AT,
  RIVAL_AT,
} = require("./CitizenRelationships");

function mockDirector(names) {
  return { roster: new Map(names.map((n) => [n.toLowerCase(), { username: n }])) };
}

let n = 0;
function freshPair() {
  n += 1;
  return [`rel-a-${n}`, `rel-b-${n}`];
}

// --- compatibility ---------------------------------------------------------

{
  resetForTests();
  const c = compatibility({ traits: ["chatty", "cheerful"] }, { traits: ["chatty", "warm"] });
  assert.ok(c > 0, `shared traits warm compatibility, got ${c}`);
}
{
  const c = compatibility({ traits: ["chatty"] }, { traits: ["taciturn"] });
  assert.ok(c < 0, `opposing traits cool compatibility, got ${c}`);
}
{
  assert.equal(compatibility({}, {}), 0, "empty personalities are neutral");
  assert.equal(compatibility(null, null), 0, "null personalities are neutral");
}
{
  const ab = compatibility({ traits: ["chatty"] }, { traits: ["chatty", "gruff"] });
  const ba = compatibility({ traits: ["chatty", "gruff"] }, { traits: ["chatty"] });
  assert.equal(ab, ba, "compatibility is symmetric");
}
{
  const c = compatibility(
    { traits: ["chatty", "cheerful", "generous", "trusting", "easygoing"] },
    { traits: ["chatty", "cheerful", "generous", "trusting", "easygoing"] }
  );
  assert.ok(c <= 1, `compatibility clamped at 1, got ${c}`);
}

// --- pairKey ---------------------------------------------------------------

{
  assert.equal(pairKey("Alice", "Bob"), pairKey("bob", "alice"), "pair key is symmetric + normalized");
}

// --- noteInteraction --------------------------------------------------------

{
  resetForTests();
  const [a, b] = freshPair();
  assert.equal(rapportOf(a, b), 0, "unknown pair starts at 0");
  assert.equal(noteInteraction(a, a, "chatted"), 0, "self-interaction ignored");
  assert.equal(noteInteraction(a, b, "danced"), 0, "unknown kind ignored");
  assert.equal(rapportOf(a, b), 0, "ignored interactions leave no trace");
  assert.equal(pairCount(), 0, "ignored interactions create no pairs");
}
{
  resetForTests();
  const [a, b] = freshPair();
  // First impression: compatible pair starts warm.
  const v = noteInteraction(a, b, "greeted", { traits: ["chatty", "cheerful"] }, { traits: ["chatty", "warm"] });
  assert.ok(v > 0, `compatible first greeting warms rapport, got ${v}`);
}
{
  resetForTests();
  const [a, b] = freshPair();
  // First impression: opposing pair starts cool.
  const v = noteInteraction(a, b, "greeted", { traits: ["chatty"] }, { traits: ["taciturn", "gruff"] });
  assert.ok(v < 2, `opposing first greeting stays cool, got ${v}`);
}
{
  resetForTests();
  const [a, b] = freshPair();
  const g = noteInteraction(a, b, "greeted");
  const h = noteInteraction(a, b, "helped");
  assert.ok(h - g > 3, `helped weighs more than greeted (${g} -> ${h})`);
  const before = rapportOf(a, b);
  noteInteraction(a, b, "argued");
  assert.ok(rapportOf(a, b) < before, "arguing cools rapport");
}
{
  resetForTests();
  const [a, b] = freshPair();
  for (let i = 0; i < 20; i++) noteInteraction(a, b, "fought");
  assert.equal(rapportOf(a, b), -100, "rapport floors at -100");
  for (let i = 0; i < 40; i++) noteInteraction(a, b, "helped");
  assert.equal(rapportOf(a, b), 100, "rapport caps at 100");
}

// --- tickRelationships: decay -------------------------------------------------

{
  resetForTests();
  const [a, b] = freshPair();
  noteInteraction(a, b, "helped");
  noteInteraction(a, b, "helped");
  const before = rapportOf(a, b);
  assert.ok(before > 0, "setup: rapport positive");
  const director = mockDirector([a, b]);
  tickRelationships(director);
  const after = rapportOf(a, b);
  assert.ok(after < before && after >= 0, `decay moves toward 0 (${before} -> ${after})`);
}

// --- tickRelationships: promotion to friends ----------------------------------

{
  resetForTests();
  journalStub._calls.length = 0;
  const [a, b] = freshPair();
  for (let i = 0; i < 8; i++) noteInteraction(a, b, "helped");
  assert.ok(rapportOf(a, b) >= FRIEND_AT, `setup: rapport at/above friend threshold (${rapportOf(a, b)})`);
  const director = mockDirector([a, b]);
  const res = tickRelationships(director);
  assert.equal(res.friends, 1, "one friendship formed");
  assert.ok(bondsStub.isFriend(a, b), "a lists b as friend");
  assert.ok(bondsStub.isFriend(b, a), "friendship is mutual");
  assert.ok(journalStub._calls.some((c) => c.text.includes("good friends")), "journal records the friendship");
}

// --- tickRelationships: demotion to rivals -------------------------------------

{
  resetForTests();
  journalStub._calls.length = 0;
  const [a, b] = freshPair();
  for (let i = 0; i < 6; i++) noteInteraction(a, b, "fought");
  assert.ok(rapportOf(a, b) <= RIVAL_AT, `setup: rapport at/below rival threshold (${rapportOf(a, b)})`);
  const director = mockDirector([a, b]);
  const res = tickRelationships(director);
  assert.equal(res.rivals, 1, "one rivalry formed");
  assert.ok(bondsStub.isEnemy(a, b), "a lists b as enemy");
  assert.ok(bondsStub.isEnemy(b, a), "rivalry is mutual");
  assert.ok(journalStub._calls.some((c) => c.text.includes("bad blood")), "journal records the fallout");
}

// --- tickRelationships: only roster citizens promote ----------------------------

{
  resetForTests();
  const [a, b] = freshPair();
  for (let i = 0; i < 8; i++) noteInteraction(a, b, "helped");
  // b is NOT in the roster (e.g. a logged-out citizen or a player name).
  const director = mockDirector([a]);
  const res = tickRelationships(director);
  assert.equal(res.friends, 0, "non-roster pairs never promote");
  assert.ok(!bondsStub.isFriend(a, b), "no bond created");
}

// --- tickRelationships: no director --------------------------------------------

{
  resetForTests();
  const res = tickRelationships(null);
  assert.deepEqual(res, { friends: 0, rivals: 0 }, "null director is a no-op");
}

// --- resetForTests ---------------------------------------------------------------

{
  const [a, b] = freshPair();
  noteInteraction(a, b, "chatted");
  assert.ok(pairCount() > 0, "setup: pairs tracked");
  resetForTests();
  assert.equal(pairCount(), 0, "reset clears pairs");
  assert.equal(rapportOf(a, b), 0, "reset clears rapport");
}

console.log("CitizenRelationships: all checks passed");
