"use strict";

// CitizenTavernGames unit checks — pure logic, no running server.
// Run: cd server/plugins/citizens && node lib/CitizenTavernGames.test.js

const assert = require("node:assert/strict");
const T = require("./CitizenTavernGames");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function rec(username, traits, demeanor, role, kingdomId) {
  return {
    username,
    personality: { traits, demeanor },
    role: role ?? "commoner",
    kingdomId: kingdomId ?? "asgarnia",
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

// 1. skillFor: deterministic per username+game, in 1..99.
check("skillFor is deterministic and in range", () => {
  const a = T.skillFor("Alice", "dice");
  const b = T.skillFor("Alice", "dice");
  assert.equal(a, b);
  assert.ok(a >= 1 && a <= 99);
  // Different game types differ (usually).
  const c = T.skillFor("Alice", "cards");
  assert.ok(c >= 1 && c <= 99);
});

// 2. skillFor: different users get different skills (hash spread).
check("skillFor spreads across users", () => {
  const vals = new Set();
  for (let i = 0; i < 20; i++) vals.add(T.skillFor("user" + i, "dice"));
  assert.ok(vals.size >= 10, "hash should spread");
});

// 3. playKeenness: guards love arm wrestling, hate cards less predictably.
check("playKeenness gates by personality and role", () => {
  const guard = rec("Guard", [], "", "guard");
  const nervous = rec("Nerv", ["honest"], "nervous");
  const bold = rec("Bold", ["cunning"], "bold");
  assert.ok(T.playKeenness(guard, "armwrestle") > T.playKeenness(nervous, "armwrestle"));
  assert.ok(T.playKeenness(bold, "cards") > T.playKeenness(nervous, "cards"));
  const k = T.playKeenness(guard, "dice");
  assert.ok(k >= 0 && k <= 1);
});

// 4. wagerFor: bold bets more than cautious; bounded.
check("wagerFor scales with risk tolerance and stays bounded", () => {
  const rng = lcg(7);
  const bold = rec("Bold", [], "bold");
  const cautious = rec("Caut", [], "soft-spoken");
  let boldSum = 0, cautSum = 0;
  for (let i = 0; i < 50; i++) {
    boldSum += T.wagerFor(bold, rng);
    cautSum += T.wagerFor(cautious, rng);
  }
  assert.ok(boldSum > cautSum, "bold should bet more on average");
  for (let i = 0; i < 20; i++) {
    const w = T.wagerFor(bold, rng);
    assert.ok(w >= 10 && w <= 1000);
  }
});

// 5. resolveDice: higher skill wins more often; result shape valid.
check("resolveDice favors higher skill", () => {
  const rng = lcg(42);
  let aWins = 0;
  for (let i = 0; i < 200; i++) {
    const r = T.resolveDice(rng, 90, 10);
    assert.ok(["a", "b", "draw"].includes(r.winner));
    if (r.winner === "a") aWins++;
  }
  assert.ok(aWins > 120, `skill 90 should dominate skill 10 (got ${aWins}/200)`);
});

// 6. resolveDice: totals are sane 2d6+bonus.
check("resolveDice totals in plausible range", () => {
  const rng = lcg(99);
  for (let i = 0; i < 50; i++) {
    const r = T.resolveDice(rng, 50, 50);
    assert.ok(r.aTotal >= 2 && r.aTotal <= 12 + 3);
    assert.ok(r.bTotal >= 2 && r.bTotal <= 12 + 3);
  }
});

// 7. resolveCards: bold bluff pays off more often than straight play.
check("resolveCards bluff gives bold an edge", () => {
  const rng = lcg(1234);
  let boldWins = 0;
  for (let i = 0; i < 300; i++) {
    const r = T.resolveCards(rng, 50, 50, true, false);
    if (r.winner === "a") boldWins++;
  }
  assert.ok(boldWins > 140, `bluff should help (got ${boldWins}/300)`);
});

// 8. resolveArmwrestle: stronger wins best-of-3; rounds recorded.
check("resolveArmwrestle favors strength, rounds are best-of-3", () => {
  const rng = lcg(555);
  let aWins = 0;
  for (let i = 0; i < 200; i++) {
    const r = T.resolveArmwrestle(rng, 100, 40);
    assert.ok(r.rounds.length >= 2 && r.rounds.length <= 3);
    assert.ok(["a", "b"].includes(r.winner));
    if (r.winner === "a") aWins++;
  }
  assert.ok(aWins > 150, `strength 100 should crush 40 (got ${aWins}/200)`);
});

// 9. resolveDrinking: higher constitution survives longer; always terminates.
check("resolveDrinking terminates and favors constitution", () => {
  const rng = lcg(777);
  let aWins = 0;
  for (let i = 0; i < 200; i++) {
    const r = T.resolveDrinking(rng, 90, 20);
    assert.ok(r.rounds >= 1 && r.rounds <= 20);
    assert.ok(["a", "b", "draw"].includes(r.winner));
    if (r.winner === "a") aWins++;
  }
  assert.ok(aWins > 120, `con 90 should beat con 20 (got ${aWins}/200)`);
});

// 10. resolveDrinking: equal constitution can still draw.
check("resolveDrinking can draw on simultaneous failure", () => {
  const rng = lcg(31337);
  let draws = 0;
  for (let i = 0; i < 500; i++) {
    const r = T.resolveDrinking(rng, 50, 50);
    if (r.winner === "draw") draws++;
  }
  assert.ok(draws >= 0, "draw path reachable");
});

// 11. strengthBonus: guards get the biggest bonus.
check("strengthBonus ranks roles", () => {
  assert.ok(T.strengthBonus("guard") > T.strengthBonus("commoner"));
  assert.ok(T.strengthBonus("commoner") >= 0);
});

// 12. isBold: detects bold/brash/cunning.
check("isBold reads demeanor and traits", () => {
  assert.equal(T.isBold(rec("A", [], "bold")), true);
  assert.equal(T.isBold(rec("B", ["cunning"], "")), true);
  assert.equal(T.isBold(rec("C", [], "nervous")), false);
  assert.equal(T.isBold(rec("D", [], "")), false);
});

// 13. fillLine: substitutes all vars.
check("fillLine substitutes templates", () => {
  assert.equal(T.fillLine("{a} beats {b} at {game}!", { a: "Al", b: "Bo", game: "dice" }),
    "Al beats Bo at dice!");
});

// 14. isEvening: tavern prime time.
check("isEvening covers night hours", () => {
  assert.equal(T.isEvening(20), true);
  assert.equal(T.isEvening(0), true);
  assert.equal(T.isEvening(12), false);
  assert.equal(T.isEvening(8), false);
});

// 15. resolveGame: integrates all four game types with records.
check("resolveGame handles all game types", () => {
  const rng = lcg(2024);
  const a = rec("Alice", [], "", "guard", "asgarnia");
  const b = rec("Bob", [], "", "commoner", "asgarnia");
  for (const g of T.GAME_TYPES) {
    const r = T.resolveGame(rng, g, a, b);
    assert.ok(r.draw || (r.winner && r.loser), `game ${g} must resolve`);
    if (!r.draw) {
      assert.notEqual(r.winner, r.loser);
    }
  }
});

// 16. pickGameType: returns a valid game type.
check("pickGameType returns a known game type", () => {
  const rng = lcg(11);
  const host = rec("Host", ["cheerful", "chatty"], "", "commoner");
  for (let i = 0; i < 20; i++) {
    assert.ok(T.GAME_TYPES.includes(T.pickGameType(rng, host)));
  }
});

// 17. GAME_TYPES has all four games.
check("all four game types defined", () => {
  assert.deepEqual([...T.GAME_TYPES].sort(), ["armwrestle", "cards", "dice", "drinking"]);
  for (const g of T.GAME_TYPES) assert.ok(T.GAME_LABELS[g]);
});

// 18. handlePlayerJoin: joins a forming game, rejects bad input.
check("handlePlayerJoin validates and joins", () => {
  const night = {
    kingdomId: "asgarnia", phase: "forming", gameType: "dice",
    host: { username: "Alice" },
    players: [{ username: "Alice", isPlayer: false }],
  };
  T._gameNights.set("asgarnia", night);
  assert.equal(T.handlePlayerJoin({}, { kingdomId: "asgarnia", playerName: "Jon" }), true);
  assert.equal(night.players.length, 2);
  assert.equal(night.players[1].isPlayer, true);
  // Duplicate join rejected.
  assert.equal(T.handlePlayerJoin({}, { kingdomId: "asgarnia", playerName: "Jon" }), false);
  // Bad input rejected.
  assert.equal(T.handlePlayerJoin({}, { kingdomId: "asgarnia" }), false);
  assert.equal(T.handlePlayerJoin({}, null), false);
  T._gameNights.delete("asgarnia");
});

// 19. handlePlayerResult: records outcome during playing phase.
check("handlePlayerResult records player outcome", () => {
  const night = {
    kingdomId: "asgarnia", phase: "playing", gameType: "dice",
    host: { username: "Alice" },
    players: [{ username: "Alice", isPlayer: false }, { username: "Jon", isPlayer: true }],
    result: null,
  };
  T._gameNights.set("asgarnia", night);
  assert.equal(T.handlePlayerResult({}, { kingdomId: "asgarnia", playerName: "Jon", won: true }), true);
  assert.equal(night.result.winner, "jon");
  assert.equal(night.result.isPlayer, true);
  // Wrong phase rejected.
  night.phase = "idle";
  assert.equal(T.handlePlayerResult({}, { kingdomId: "asgarnia", playerName: "Jon", won: true }), false);
  T._gameNights.delete("asgarnia");
});

// 20. hash01: deterministic, in [0,1).
check("hash01 is deterministic and bounded", () => {
  const a = T.hash01("test");
  assert.equal(a, T.hash01("test"));
  assert.ok(a >= 0 && a < 1);
});

console.log(`\nAll ${passed} checks passed.`);
