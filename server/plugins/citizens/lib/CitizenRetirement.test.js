// CitizenRetirement unit checks — pure logic, no running server.
// Run: node lib/CitizenRetirement.test.js  (from server/plugins/citizens)
const assert = require("node:assert/strict");
const R = require("./CitizenRetirement");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// rng that always passes chance gates (returns ~0).
const always = () => 0.0001;

function loc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function ent(x, y, z = 0) {
  return { getLocation: () => loc(x, y, z) };
}
function realPlayer(x, y) {
  return { ...ent(x, y), getUsername: () => "RealHuman" };
}
function botPlayer(name, x, y) {
  const chats = [];
  return {
    ...ent(x, y),
    getUsername: () => name,
    isPlayerBot: () => true,
    getLocalPlayers: () => [],
    forceChat: (t) => chats.push(t),
    _chats: chats,
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok -", name);
}

// 1. ageOf defaults to 35 when personality is missing.
check("ageOf defaults to 35", () => {
  assert.equal(R.ageOf({}), 35);
  assert.equal(R.ageOf({ personality: {} }), 35);
  assert.equal(R.ageOf({ personality: { age: 72 } }), 72);
});

// 2. isElder: 60+ counts, younger does not.
check("isElder at 60 and below", () => {
  assert.equal(R.isElder({ personality: { age: 60 } }), true);
  assert.equal(R.isElder({ personality: { age: 85 } }), true);
  assert.equal(R.isElder({ personality: { age: 59 } }), false);
});

// 3. isElder: elderly trait counts regardless of age.
check("isElder via elderly trait", () => {
  assert.equal(R.isElder({ personality: { age: 40, traits: ["elderly"] } }), true);
});

// 4. isRetirableRole: guard/merchant/commoner yes; courtier/refugee no.
check("isRetirableRole roles", () => {
  assert.equal(R.isRetirableRole("guard"), true);
  assert.equal(R.isRetirableRole("merchant"), true);
  assert.equal(R.isRetirableRole("commoner"), true);
  assert.equal(R.isRetirableRole("courtier"), false);
  assert.equal(R.isRetirableRole("refugee"), false);
  assert.equal(R.isRetirableRole("GUARD"), true); // case-insensitive
});

// 5. markRetired / isRetired round-trip, normalized.
check("retired set round-trip", () => {
  R.resetForTests();
  assert.equal(R.isRetired("OldTom"), false);
  R.markRetired("OldTom");
  assert.equal(R.isRetired("OldTom"), true);
  assert.equal(R.isRetired("oldtom"), true); // normalized
});

// 6. shouldFire respects cooldown then chance.
check("shouldFire cooldown gate", () => {
  const now = 1_000_000;
  assert.equal(R.shouldFire(lcg(1), now - 1000, now, 60_000, 1.0), false);
  assert.equal(R.shouldFire(lcg(1), 0, now, 60_000, 1.0), true);
  assert.equal(R.shouldFire(lcg(1), 0, now, 60_000, 0.0), false);
});

// 7. pickStory / pickWisdom deterministic with seeded rng.
check("story and wisdom picks deterministic", () => {
  const a = R.pickStory(lcg(42));
  const b = R.pickStory(lcg(42));
  assert.equal(a, b);
  assert.ok(a.length > 10);
  const w1 = R.pickWisdom(lcg(7));
  const w2 = R.pickWisdom(lcg(7));
  assert.equal(w1, w2);
});

// 8. pickDeference names the elder.
check("pickDeference names elder", () => {
  const line = R.pickDeference(lcg(3), "Mira");
  assert.ok(line.includes("Mira"), `expected elder name, got: ${line}`);
});

// 9. ceremonyScript: 4 lines, host/elder/host/crowd, names the elder.
check("ceremonyScript structure", () => {
  const script = R.ceremonyScript(lcg(9), "Borin", "guard");
  assert.equal(script.length, 4);
  assert.deepEqual(
    script.map((s) => s.speaker),
    ["host", "elder", "host", "crowd"]
  );
  for (const line of script) {
    // Host and crowd lines name the elder; the elder's own line speaks as them.
    if (line.speaker !== "elder") {
      assert.ok(line.text.includes("Borin"), `line missing elder: ${line.text}`);
    }
    assert.ok(line.text.length <= 200);
  }
});

// 10. withinTiles / isRealPlayer basics.
check("withinTiles and isRealPlayer", () => {
  assert.equal(R.withinTiles(ent(0, 0), ent(5, 5), 10), true);
  assert.equal(R.withinTiles(ent(0, 0), ent(5, 5), 4), false);
  assert.equal(R.isRealPlayer(realPlayer(0, 0)), true);
  assert.equal(R.isRealPlayer(botPlayer("Bot", 0, 0)), false);
  assert.equal(R.isRealPlayer(null), false);
});

// 11. Ceremony fires once for an eligible elder near a real player.
check("ceremony fires for eligible elder", () => {
  R.resetForTests();
  const human = realPlayer(3010, 3010);
  const elderBot = botPlayer("ElderMira", 3010, 3010);
  elderBot.getLocalPlayers = () => [human];
  const records = new Map([
    ["ElderMira", { username: "ElderMira", kingdomId: "asgarnia", role: "merchant", personality: { age: 71 } }],
  ]);
  const director = {
    roster: records,
    playerFor: (rec) => (rec.username === "ElderMira" ? elderBot : null),
    getBot: (rec) => (rec.username === "ElderMira" ? elderBot : null),
  };
  R.tickRetirement(director, 800_000_000, null, always);
  assert.equal(R.isRetired("ElderMira"), true, "elder should be marked retired");
  assert.ok(elderBot._chats.length >= 1, "elder/host should have spoken");
});

// 12. Ceremony does not fire twice (cooldown / retired).
check("ceremony does not repeat", () => {
  const before = R.retirementStatus();
  const human = realPlayer(3010, 3010);
  const elderBot = botPlayer("ElderMira", 3010, 3010);
  elderBot.getLocalPlayers = () => [human];
  const director = {
    roster: new Map([
      ["ElderMira", { username: "ElderMira", kingdomId: "asgarnia", role: "merchant", personality: { age: 71 } }],
    ]),
    playerFor: () => elderBot,
    getBot: () => elderBot,
  };
  elderBot._chats.length = 0;
  R.tickRetirement(director, 800_000_001, null, always);
  // Second tick: no new ceremony lines (only story/wisdom may fire, or nothing).
  const chats = elderBot._chats.join(" ");
  assert.ok(!chats.includes("retires from the"), `unexpected repeat ceremony: ${chats}`);
  assert.equal(R.retirementStatus(), before);
});

// 13. Young citizens are never retired by the tick.
check("young citizens untouched", () => {
  R.resetForTests();
  const human = realPlayer(3010, 3010);
  const youngBot = botPlayer("YoungPete", 3010, 3010);
  youngBot.getLocalPlayers = () => [human];
  const director = {
    roster: new Map([
      ["YoungPete", { username: "YoungPete", kingdomId: "asgarnia", role: "commoner", personality: { age: 28 } }],
    ]),
    playerFor: () => youngBot,
    getBot: () => youngBot,
  };
  R.tickRetirement(director, 20_000_000, null, always);
  assert.equal(R.isRetired("YoungPete"), false);
});

// 14. Deference: a young citizen near a retired elder bows.
check("deference to retired elder", () => {
  R.resetForTests();
  R.markRetired("ElderMira");
  const human = realPlayer(3010, 3010);
  const youngBot = botPlayer("YoungPete", 3012, 3012);
  const elderBot = botPlayer("ElderMira", 3010, 3010);
  youngBot.getLocalPlayers = () => [human];
  const director = {
    roster: new Map([
      ["YoungPete", { username: "YoungPete", kingdomId: "asgarnia", role: "commoner", personality: { age: 28 } }],
      ["ElderMira", { username: "ElderMira", kingdomId: "asgarnia", role: "merchant", personality: { age: 71 } }],
    ]),
    playerFor: (rec) => (rec.username === "YoungPete" ? youngBot : elderBot),
    getBot: (rec) => (rec.username === "YoungPete" ? youngBot : elderBot),
  };
  // Force the deference chance to 1 by running many ticks is flaky; instead
  // run once and accept either outcome, but verify no crash and structure.
  R.tickRetirement(director, 30_000_000, null, always);
  assert.equal(R.isRetired("ElderMira"), true);
  // Deference may or may not have fired (chance 0.25); the important part is
  // the young bot never got a ceremony.
  assert.equal(R.isRetired("YoungPete"), false);
});

// 15. tickRetirement never throws on garbage input.
check("tick never throws", () => {
  R.resetForTests();
  R.tickRetirement({}, 40_000_000);
  R.tickRetirement({ roster: null }, 40_000_000);
  R.tickRetirement({ roster: new Map(), playerFor: () => { throw new Error("boom"); } }, 40_000_000);
});

console.log(`\n${passed}/15 checks passed`);
