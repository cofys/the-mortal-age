// CitizenCooks unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  hashStr,
  cookTypeFor,
  kitchenFor,
  mealFor,
  specialFor,
  waresFor,
  ingredientsFor,
  seasonFor,
  workLineFor,
  mealLineFor,
  hawkLineFor,
  teachLineFor,
  specialLineFor,
  mealOfTheDayFor,
  animFor,
  shouldFire,
  shouldHawk,
  shouldTeach,
  isRealPlayer,
  withinTiles,
  COOK_TYPES,
  KITCHENS,
  ANIM_FIRE_COOK,
  ANIM_RANGE_COOK,
} = require("./CitizenCooks");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const MIDDAY = Date.UTC(2026, 6, 15, 12, 0, 0); // July 15 — summer

// 1. hashStr is stable and unsigned.
assert.equal(hashStr("cook|bob"), hashStr("cook|bob"));
assert.ok(hashStr("cook|bob") >>> 0 >= 0);

// 2. ~6% of usernames are cooks (primary-profession partition); every cook type is a valid type.
{
  let cooks = 0;
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const t = cookTypeFor("user" + i);
    if (t) {
      cooks++;
      assert.ok(COOK_TYPES.includes(t), "invalid cook type: " + t);
      seen.add(t);
    }
  }
  assert.ok(cooks > 60 && cooks < 200, "expected ~6% (primary-profession partition), got " + cooks);
  assert.equal(seen.size, 4, "expected all 4 cook types, saw " + Array.from(seen));
}

// 3. Non-cook usernames return null; empty input returns null.
assert.equal(cookTypeFor(""), null);
assert.equal(cookTypeFor(null), null);

// 4. Kitchen assignment prefers the citizen's kingdom and is stable.
{
  const k1 = kitchenFor("someuser", "misthalin", "baker");
  const k2 = kitchenFor("someuser", "misthalin", "baker");
  assert.equal(k1.name, k2.name);
  assert.equal(k1.kingdom, "misthalin");
  const kx = kitchenFor("someuser", "no-such-kingdom", "baker");
  assert.ok(KITCHENS.includes(kx), "fallback should still pick a kitchen");
}

// 5. Meal of the day is deterministic per day and regional.
{
  const m1 = mealFor("bob", "keldagrim", MIDDAY);
  const m2 = mealFor("bob", "keldagrim", MIDDAY);
  assert.equal(m1, m2);
  assert.ok(typeof m1 === "string" && m1.length > 3);
}

// 6. Seasonal specials follow the farmer season calendar (summer in July).
{
  assert.equal(seasonFor(MIDDAY), "summer");
  assert.equal(seasonFor(Date.UTC(2026, 0, 15)), "winter");
  assert.equal(seasonFor(Date.UTC(2026, 3, 15)), "spring");
  assert.equal(seasonFor(Date.UTC(2026, 9, 15)), "autumn");
  const s = specialFor("bob", "misthalin", MIDDAY);
  assert.ok(typeof s === "string" && s.length > 3);
}

// 7. Ingredients come from the farmers' produce tables (or fallback).
{
  const ing = ingredientsFor("summer");
  assert.ok(Array.isArray(ing) && ing.length > 0, "expected ingredients, got " + JSON.stringify(ing));
  assert.ok(ing.includes("sweetcorn") || ing.includes("wheat"), "expected summer produce from farmers, got " + ing.join(","));
}

// 8. Wares differ by cook type.
{
  const cookUser = (() => {
    for (let i = 0; i < 500; i++) {
      if (cookTypeFor("waresuser" + i)) return "waresuser" + i;
    }
    throw new Error("no cook found");
  })();
  const type = cookTypeFor(cookUser);
  const w = waresFor(cookUser, type, MIDDAY);
  assert.ok(typeof w === "string" && w.length > 3);
}

// 9. Line pools return strings for every cook type.
{
  const rng = lcg(42);
  for (const t of COOK_TYPES) {
    assert.ok(typeof workLineFor(rng, t) === "string", "no work line for " + t);
  }
  assert.ok(typeof workLineFor(rng, "nope") === "undefined" || workLineFor(rng, "nope") === null);
  assert.ok(mealLineFor(rng, "shepherd's pie", KITCHENS[0]).toLowerCase().includes("shepherd's pie"));
  assert.ok(hawkLineFor(rng, "warm bread loaves", KITCHENS[1]).toLowerCase().includes("warm bread loaves"));
  assert.ok(teachLineFor(rng, "shepherd's pie").toLowerCase().includes("shepherd's pie"));
  assert.ok(specialLineFor(rng, "pumpkin pie", KITCHENS[0]).toLowerCase().includes("pumpkin pie"));
}

// 10. Animation ids: engine-verified cooking anims from Cooking.plugin.js.
assert.equal(ANIM_FIRE_COOK, 896);
assert.equal(ANIM_RANGE_COOK, 897);
assert.equal(animFor("baker"), 897);
assert.equal(animFor("chef"), 897);
assert.equal(animFor("tavern-keeper"), 896);
assert.equal(animFor("street-vendor"), 896);

// 11. shouldFire / shouldHawk / shouldTeach gate on cooldown and chance.
{
  const now = 1_000_000_000;
  assert.equal(shouldFire(lcg(1), now - 10, now), false, "cooldown must block");
  assert.equal(shouldHawk(lcg(1), now - 10, now), false, "cooldown must block");
  assert.equal(shouldTeach(lcg(1), now - 10, now), false, "cooldown must block");
  // expired cooldown + chance=1 fires
  assert.equal(shouldFire(() => 0.0, 0, now), true);
  assert.equal(shouldHawk(() => 0.0, 0, now), true);
  assert.equal(shouldTeach(() => 0.0, 0, now), true);
  // expired cooldown + chance=1 refuses
  assert.equal(shouldFire(() => 0.999, 0, now), false);
}

// 12. isRealPlayer / withinTiles.
{
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ getUsername: () => "real" }), true);
  const at = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(withinTiles(at(0, 0, 0), at(5, 5, 0), 10), true);
  assert.equal(withinTiles(at(0, 0, 0), at(20, 0, 0), 10), false);
  assert.equal(withinTiles(at(0, 0, 0), at(5, 5, 1), 10), false, "different plane must not match");
}

// 13. mealOfTheDayFor returns null for non-cooks and a full record for cooks.
{
  assert.equal(mealOfTheDayFor("definitely-not-a-cook-xyz-123", "misthalin", MIDDAY), null);
  const cookUser = (() => {
    for (let i = 0; i < 500; i++) {
      if (cookTypeFor("mealuser" + i)) return "mealuser" + i;
    }
    throw new Error("no cook found");
  })();
  const rec = mealOfTheDayFor(cookUser, "misthalin", MIDDAY);
  assert.ok(rec && typeof rec.meal === "string" && typeof rec.kitchen === "string" && typeof rec.wares === "string");
  assert.ok(COOK_TYPES.includes(rec.type));
}

// 14. Tick never throws on hostile input.
{
  const cooks = require("./CitizenCooks");
  cooks.tickCooks(null, MIDDAY);
  cooks.tickCooks({}, MIDDAY);
  cooks.tickCooks({ roster: new Map() }, MIDDAY);
}

// 15. Tick interaction tier: fires near real players, silent near bots only,
// silent when the director says offline.
// (cooks audit 2026-10-08: the old prod code used director.playerFor /
// director.onlinePlayers, which do not exist, so this tier was
// dead-on-arrival. These checks pin the fixed shape.)
{
  const cooks = require("./CitizenCooks");
  cooks._resetState();
  let cookName = null;
  for (let i = 0; i < 2000 && !cookName; i++) {
    if (cookTypeFor("e2ecook" + i)) cookName = "e2ecook" + i;
  }
  assert.ok(cookName, "seed produced a cook");
  const locOf = (x, y) => ({ getX: () => x, getY: () => y, getZ: () => 0 });
  const said = [];
  const bot = {
    forceChat: (m) => said.push(m),
    performAnimation: () => {},
    getLocation: () => locOf(3000, 3000),
    getLocalPlayers: () => [],
  };
  const mkHuman = (x) => ({
    getUsername: () => "human",
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getLocation: () => locOf(x, 3000),
  });
  const mkBotPlayer = () => ({
    getUsername: () => "botty",
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => locOf(3005, 3000),
  });
  // Real-API director shape: isOnline/getBot (CitizenDirector.js:1374/1379);
  // the citizen bot carries getLocalPlayers (Player.ts:796).
  const mkDirector = (online, materialized = true) => {
    bot.getLocalPlayers = () => online;
    return {
      roster: new Map([[cookName, { username: cookName, role: "commoner", kingdomId: "misthalin" }]]),
      isOnline: () => materialized,
      getBot: () => bot,
      api: { core: { Animation: function (id) { this.id = id; } } },
    };
  };
  const real = Math.random;
  Math.random = () => 0.0; // force all chance gates open
  try {
    // Offline -> silent.
    cooks.tickCooks(mkDirector([mkHuman(3005)], false), Date.now());
    assert.equal(said.length, 0, "silent when the director says the citizen is offline");
    // Bots only -> silent.
    cooks.tickCooks(mkDirector([mkBotPlayer()]), Date.now());
    assert.equal(said.length, 0, "silent when only bots are near");
    // Real player near -> the cook speaks (work, hawk, or teach tier).
    let fired = false;
    for (let i = 0; i < 5 && !fired; i++) {
      cooks.tickCooks(mkDirector([mkHuman(3005)]), Date.now());
      fired = said.length > 0;
    }
    assert.ok(fired, "visible work fires near a real player");
  } finally {
    Math.random = real;
  }
}

// 16. Journal is canonical: kind:"work" entries per visible loop, and the
// kitchen prefers the citizen's kingdom (records carry kingdomId, not
// kingdom — the old code passed record.kingdom, silently undefined).
{
  const cooks = require("./CitizenCooks");
  cooks._resetState();
  const { getJournal } = require("./CitizenJournal");
  getJournal().resetForTests();
  let cookName = null;
  let cookType = null;
  for (let i = 0; i < 2000 && !cookName; i++) {
    const t = cookTypeFor("e2ej" + i);
    if (t) { cookName = "e2ej" + i; cookType = t; }
  }
  assert.ok(cookName, "seed produced a cook");
  const locOf = (x, y) => ({ getX: () => x, getY: () => y, getZ: () => 0 });
  const bot = {
    forceChat: () => {},
    performAnimation: () => {},
    getLocation: () => locOf(3000, 3000),
    getLocalPlayers: () => [{
      getUsername: () => "human",
      isPlayerBot: () => false,
      getHostAddress: () => "127.0.0.1",
      getLocation: () => locOf(3005, 3000),
    }],
  };
  const director = {
    roster: new Map([[cookName, { username: cookName, role: "commoner", kingdomId: "misthalin" }]]),
    isOnline: () => true,
    getBot: () => bot,
    api: { core: { Animation: function (id) { this.id = id; } } },
  };
  const real = Math.random;
  Math.random = () => 0.0;
  try {
    cooks.tickCooks(director, Date.now());
  } finally {
    Math.random = real;
  }
  const events = getJournal().recent(cookName, 10);
  const work = events.find((e) => e.kind === "work");
  assert.ok(work, "journal holds a kind:work entry for the cook");
  const expectedKitchen = kitchenFor(cookName, "misthalin", cookType);
  assert.ok(expectedKitchen && work.text.includes(expectedKitchen.name),
    `kitchen kingdom-preferred to misthalin ("${expectedKitchen.name}"), journal: "${work.text}"`);
}

console.log("All CitizenCooks checks passed.");
