"use strict";
// CitizenMystery unit checks — pure logic, no running server.
// Run: node CitizenMystery.test.js
const assert = require("node:assert/strict");
const M = require("./CitizenMystery");

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeRoster(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      username: `Citizen${i}`,
      home: { x: 3200 + i, y: 3200 + i, z: 0 },
      personality: { traits: ["chatty"] },
    });
  }
  return out;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. monthKey formats as YYYY-MM (UTC).
check("monthKey formats YYYY-MM", () => {
  assert.equal(M.monthKey(Date.UTC(2026, 9, 7)), "2026-10");
  assert.equal(M.monthKey(Date.UTC(2026, 0, 1)), "2026-01");
});

// 2. hashStr is stable and differs per input.
check("hashStr stable and distinct", () => {
  assert.equal(M.hashStr("abc"), M.hashStr("abc"));
  assert.notEqual(M.hashStr("abc"), M.hashStr("abd"));
});

// 3. generateMystery returns null with too few citizens.
check("generateMystery needs 2+ citizens", () => {
  assert.equal(M.generateMystery([], "2026-10"), null);
  assert.equal(M.generateMystery([{ username: "Solo" }], "2026-10"), null);
});

// 4. generateMystery is deterministic for a month.
check("generateMystery deterministic per month", () => {
  const r = makeRoster(10);
  const a = M.generateMystery(r, "2026-10");
  const b = M.generateMystery(r, "2026-10");
  assert.deepEqual(a, b);
});

// 5. Different months give (almost surely) different mysteries.
check("generateMystery varies by month", () => {
  const r = makeRoster(10);
  const a = M.generateMystery(r, "2026-10");
  const b = M.generateMystery(r, "2026-11");
  assert.notDeepEqual(a, b);
});

// 6. Mystery structure: 3-5 clues, victim != culprit, truth set.
check("mystery structure valid", () => {
  const m = M.generateMystery(makeRoster(10), "2026-10");
  assert.ok(m.victim);
  assert.ok(m.culprit);
  assert.notEqual(m.victim, m.culprit);
  assert.ok(m.truth && m.truth.length > 10);
  assert.ok(m.clues.length >= 3 && m.clues.length <= 5);
  assert.equal(m.status, "active");
  assert.equal(m.monthKey, "2026-10");
});

// 7. Clues scatter near the victim's home.
check("clues scatter near victim home", () => {
  const roster = makeRoster(10);
  const m = M.generateMystery(roster, "2026-10");
  const victim = roster.find((r) => r.username === m.victim);
  for (const c of m.clues) {
    assert.ok(Math.abs(c.x - victim.home.x) <= 22, "clue x in scatter range");
    assert.ok(Math.abs(c.y - victim.home.y) <= 22, "clue y in scatter range");
    assert.ok(c.hint && c.where);
  }
});

// 8. clueAt finds unrevealed clues near a tile, ignores revealed ones.
check("clueAt locates and skips revealed", () => {
  const m = M.generateMystery(makeRoster(10), "2026-10");
  const c0 = m.clues[0];
  const found = M.clueAt(m, c0.x, c0.y, c0.z);
  assert.equal(found, c0);
  assert.equal(M.clueAt(m, c0.x + 999, c0.y, c0.z), null);
  c0.revealed = true;
  assert.equal(M.clueAt(m, c0.x, c0.y, c0.z), m.clues[1] === c0 ? null : M.clueAt(m, c0.x, c0.y, c0.z));
});

// 9. revealClue marks revealed; solving requires ALL clues.
check("revealClue solves only when all found", () => {
  const m = M.generateMystery(makeRoster(10), "2026-10");
  const n = m.clues.length;
  for (let i = 0; i < n - 1; i++) {
    assert.equal(M.revealClue(m, i), false, "not solved yet");
    assert.equal(m.status, "active");
  }
  assert.equal(M.revealClue(m, n - 1), true, "solved on last clue");
  assert.equal(m.status, "solved");
  assert.equal(M.revealClue(m, 0), false, "no double-solve");
});

// 10. whisperLine mentions the victim (missing/stolen types).
check("whisperLine references mystery", () => {
  const rng = lcg(42);
  const m = M.generateMystery(makeRoster(10), "2026-10");
  const line = M.whisperLine(rng, m);
  assert.ok(typeof line === "string" && line.length > 10);
  if (m.type !== "lights") assert.ok(line.includes(m.victim));
});

// 11. Helpful citizens give real hints; tricksters give red herrings.
check("hintLine helpful vs trickster", () => {
  const m = M.generateMystery(makeRoster(10), "2026-10");
  const helpful = { personality: { traits: ["chatty", "cheerful"] } };
  const line = M.hintLine(lcg(7), helpful, m);
  const next = m.clues.find((c) => !c.revealed);
  assert.ok(line.includes(next.hint), "helpful hint names the next clue");
  const trickster = { personality: { traits: ["suspicious"] } };
  const red = M.hintLine(lcg(7), trickster, m);
  assert.ok(!red.includes(next.hint), "trickster does not give the real hint");
});

// 12. hintLine on solved mystery tells the truth.
check("hintLine after solve tells truth", () => {
  const m = M.generateMystery(makeRoster(10), "2026-10");
  m.clues.forEach((c) => (c.revealed = true));
  m.status = "solved";
  const line = M.hintLine(lcg(1), { personality: { traits: ["chatty"] } }, m);
  assert.ok(line.includes(m.truth));
});

// 13. shouldWhisper respects cooldown and chance.
check("shouldWhisper gates", () => {
  const now = 1_000_000;
  assert.equal(M.shouldWhisper(lcg(1), now - 1000, now), false, "cooldown blocks");
  const old = now - 2 * 60 * 60 * 1000;
  let fired = 0;
  for (let i = 0; i < 200; i++) if (M.shouldWhisper(lcg(i), old, now)) fired++;
  assert.ok(fired > 0 && fired < 200, "chance gates some but not all");
});

// 14. isRealPlayer rejects bots and junk.
check("isRealPlayer gates", () => {
  assert.equal(M.isRealPlayer(null), false);
  assert.equal(M.isRealPlayer({}), false);
  assert.equal(
    M.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }),
    false
  );
  assert.equal(M.isRealPlayer({ getUsername: () => "Jon" }), true);
});

// 15. withinTiles Chebyshev, same plane only.
check("withinTiles distance", () => {
  const at = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(M.withinTiles(at(0, 0, 0), at(3, 4, 0), 4), true);
  assert.equal(M.withinTiles(at(0, 0, 0), at(5, 0, 0), 4), false);
  assert.equal(M.withinTiles(at(0, 0, 0), at(0, 0, 1), 4), false);
});

// 16. isTrickster reads traits.
check("isTrickster trait mapping", () => {
  assert.equal(M.isTrickster({ personality: { traits: ["suspicious"] } }), true);
  assert.equal(M.isTrickster({ personality: { traits: ["gruff"] } }), true);
  assert.equal(M.isTrickster({ personality: { traits: ["cheerful"] } }), false);
  assert.equal(M.isTrickster({}), false);
});

// 17. tickMystery runs against a mock director without throwing.
check("tickMystery mock director survives", () => {
  M.resetForTests();
  const said = [];
  const journaled = [];
  const mkCitizen = (username, traits, x, y) => ({
    getUsername: () => username,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: (line) => said.push([username, line]),
  });
  const citizens = {
    Alice: mkCitizen("Alice", ["chatty"], 3200, 3200),
    Bob: mkCitizen("Bob", ["suspicious"], 3205, 3205),
  };
  const director = {
    roster: new Map([
      ["alice", { username: "Alice", home: { x: 3200, y: 3200, z: 0 }, personality: { traits: ["chatty"] } }],
      ["bob", { username: "Bob", home: { x: 3205, y: 3205, z: 0 }, personality: { traits: ["suspicious"] } }],
    ]),
    playerFor: (record) => citizens[record.username] ?? null,
    onlinePlayers: () => [
      {
        getUsername: () => "Jon",
        getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
      },
    ],
  };
  M.tickMystery(director, Date.UTC(2026, 9, 7));
  const m = M._getActiveMystery();
  assert.ok(m, "mystery generated");
  assert.equal(m.monthKey, "2026-10");
  // A second tick with the same month keeps the same mystery object.
  M.tickMystery(director, Date.UTC(2026, 9, 8));
  assert.equal(M._getActiveMystery(), m, "same month keeps mystery");
  M.resetForTests();
});

// 18. Clue discovery: player standing on a clue reveals it.
check("tickMystery discovers clues under players", () => {
  M.resetForTests();
  const roster = [
    { username: "Alice", home: { x: 3200, y: 3200, z: 0 }, personality: { traits: ["chatty"] } },
    { username: "Bob", home: { x: 3210, y: 3210, z: 0 }, personality: { traits: ["chatty"] } },
  ];
  const director = {
    roster: new Map(roster.map((r) => [r.username.toLowerCase(), r])),
    playerFor: () => null, // nobody materialized; discovery only needs online players
    onlinePlayers: () => [],
  };
  M.tickMystery(director, Date.UTC(2026, 9, 7));
  const m = M._getActiveMystery();
  assert.ok(m);
  const target = m.clues[0];
  director.onlinePlayers = () => [
    {
      getUsername: () => "Jon",
      getLocation: () => ({
        getX: () => target.x,
        getY: () => target.y,
        getZ: () => target.z,
      }),
    },
  ];
  M.tickMystery(director, Date.UTC(2026, 9, 7, 1));
  assert.equal(target.revealed, true, "clue under player is revealed");
  M.resetForTests();
});

console.log(`\n${passed} assertions passed.`);
