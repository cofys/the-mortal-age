"use strict";

// CitizenDiplomats unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  pickDiplomats,
  diplomatRole,
  kindsForRole,
  missionTarget,
  successChance,
  resolveMission,
  fillLine,
  isRealPlayer,
  withinTiles,
  pickOne,
  _resetForTests,
  MISSION_TRADE,
  MISSION_CULTURE,
  MISSION_PEACE,
  MISSION_ALLIANCE,
  ROLE_ENVOY,
  ROLE_NEGOTIATOR,
} = require("./CitizenDiplomats");

_resetForTests();

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const KINGDOMS = ["asgarnia", "kandarin", "misthalin", "morytania", "keldagrim"];
// Fixed tension board for targeting tests: asgarnia-morytania hot, asgarnia-kandarin calm.
const TENSION = {
  "asgarnia|morytania": 80,
  "asgarnia|kandarin": 10,
  "asgarnia|misthalin": 40,
  "asgarnia|keldagrim": 55,
};
function tensionOf(a, b) {
  return TENSION[`${a}|${b}`] ?? TENSION[`${b}|${a}`] ?? 20;
}

// --- pickDiplomats: deterministic, capped at 2 ---
{
  const courtiers = [
    { username: "Zara", seed: "seed-3" },
    { username: "Aldric", seed: "seed-1" },
    { username: "Mira", seed: "seed-2" },
  ];
  const picked = pickDiplomats(courtiers);
  assert.equal(picked.length, 2, "caps at 2 diplomats");
  assert.equal(picked[0].username, "Aldric", "deterministic by seed");
  assert.equal(picked[1].username, "Mira", "deterministic by seed");
  assert.deepEqual(
    pickDiplomats(courtiers).map((c) => c.username),
    ["Aldric", "Mira"],
    "stable across calls"
  );
  assert.equal(pickDiplomats([]).length, 0, "no courtiers, no diplomats");
}

// --- diplomatRole / kindsForRole ---
{
  assert.equal(diplomatRole(0), ROLE_ENVOY, "first diplomat is the envoy");
  assert.equal(diplomatRole(1), ROLE_NEGOTIATOR, "second diplomat is the negotiator");
  assert.deepEqual(kindsForRole(ROLE_ENVOY), [MISSION_TRADE, MISSION_CULTURE], "envoy kinds");
  assert.deepEqual(kindsForRole(ROLE_NEGOTIATOR), [MISSION_PEACE, MISSION_ALLIANCE], "negotiator kinds");
}

// --- missionTarget ---
{
  const rng = lcg(42);
  assert.equal(
    missionTarget("asgarnia", MISSION_PEACE, KINGDOMS, tensionOf, rng),
    "morytania",
    "peace targets the hottest border"
  );
  assert.equal(
    missionTarget("asgarnia", MISSION_TRADE, KINGDOMS, tensionOf, rng),
    "kandarin",
    "trade targets the calmest border"
  );
  // Alliance: median of [10, 40, 55, 80] -> sorted [10,40,55,80], index 2 -> keldagrim (55)
  assert.equal(
    missionTarget("asgarnia", MISSION_ALLIANCE, KINGDOMS, tensionOf, rng),
    "keldagrim",
    "alliance targets the median border"
  );
  const culture = missionTarget("asgarnia", MISSION_CULTURE, KINGDOMS, tensionOf, rng);
  assert.ok(KINGDOMS.includes(culture) && culture !== "asgarnia", "culture targets another kingdom");
  assert.equal(
    missionTarget("asgarnia", MISSION_PEACE, ["asgarnia"], tensionOf, rng),
    null,
    "no partners -> null"
  );
}

// --- successChance: personality weighting + peace heat penalty ---
{
  const base = successChance(MISSION_TRADE, [], 0);
  assert.equal(base, 0.65, "trade base chance");
  assert.ok(
    successChance(MISSION_TRADE, ["cheerful", "easygoing"], 0) > base,
    "positive traits raise the chance"
  );
  assert.ok(
    successChance(MISSION_TRADE, ["gruff", "suspicious"], 0) < base,
    "negative traits lower the chance"
  );
  assert.ok(
    successChance(MISSION_PEACE, [], 90) < successChance(MISSION_PEACE, [], 10),
    "hot borders are harder to calm"
  );
  assert.ok(successChance(MISSION_PEACE, [], 0) <= 0.95, "chance capped high");
  assert.ok(successChance(MISSION_PEACE, ["gruff"], 100) >= 0.05, "chance floored low");
  // Trait math: two positive traits = +0.16 (approximate — float arithmetic)
  assert.ok(
    Math.abs(successChance(MISSION_CULTURE, ["cheerful", "dutiful"], 0) - 0.86) < 1e-9,
    "trait weights stack"
  );
}

// --- resolveMission ---
{
  const alwaysWin = () => 0.0;
  const alwaysLose = () => 0.999999;
  assert.equal(resolveMission(alwaysWin, 0.5), "success", "roll under chance wins");
  assert.equal(resolveMission(alwaysLose, 0.5), "failure", "roll over chance loses");
}

// --- fillLine ---
{
  assert.equal(
    fillLine("I ride for {city} with a {mission}!", { city: "Ardougne", mission: "trade agreement" }),
    "I ride for Ardougne with a trade agreement!",
    "fills placeholders"
  );
  assert.equal(fillLine("Hello {missing}", {}), "Hello {missing}", "unknown keys left as-is");
}

// --- pickOne ---
{
  const rng = lcg(7);
  const arr = ["a", "b", "c"];
  assert.ok(arr.includes(pickOne(rng, arr)), "picks a member");
  assert.equal(pickOne(() => 0, arr), "a", "rng 0 picks first");
  assert.equal(pickOne(() => 0.999, arr), "c", "rng ~1 picks last");
}

// --- isRealPlayer ---
{
  assert.equal(isRealPlayer(null), false, "null is not a player");
  assert.equal(
    isRealPlayer({ isPlayerBot: () => true, getUsername: () => "Bot" }),
    false,
    "bots are not real players"
  );
  assert.equal(
    isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "Bot" }),
    false,
    "bot host is not a real player"
  );
  assert.equal(
    isRealPlayer({ getUsername: () => "Jon", getHostAddress: () => "127.0.0.1" }),
    true,
    "human player passes"
  );
}

// --- withinTiles ---
{
  const at = (x, y, z = 0) => ({
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
  });
  assert.equal(withinTiles(at(0, 0), at(5, 5), 12), true, "inside radius");
  assert.equal(withinTiles(at(0, 0), at(13, 0), 12), false, "outside radius");
  assert.equal(withinTiles(at(0, 0, 0), at(0, 0, 1), 12), false, "different plane");
  assert.equal(withinTiles(null, at(0, 0), 12), false, "null-safe");
}

console.log("CitizenDiplomats: all assertions passed");
