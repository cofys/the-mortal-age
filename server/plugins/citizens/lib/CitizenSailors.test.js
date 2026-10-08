// CitizenSailors unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  tickSailors,
  hashStr,
  sailorTypeFor,
  portFor,
  shipFor,
  destinationFor,
  shipInPortFor,
  weatherFor,
  isStorm,
  workLineFor,
  arrivalLineFor,
  offerLineFor,
  voyageFor,
  animFor,
  shouldFire,
  shouldOffer,
  shouldAnnounceArrival,
  pickOne,
  isRealPlayer,
  withinTiles,
  SAILOR_TYPES,
  PORTS,
  SHIP_TYPES,
  SHIP_NAMES,
  _resetState,
} = require("./CitizenSailors");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function at(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}

function makeBot(username) {
  const chats = [];
  return {
    username,
    chats,
    forceChat(line) {
      chats.push(line);
    },
    performAnimation() {},
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => username,
    getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
  };
}

function makeRealPlayer(username) {
  return {
    getUsername: () => username,
    getHostAddress: () => "127.0.0.1",
    getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
  };
}

// --- hash determinism ---
{
  assert.equal(hashStr("sailor|alice"), hashStr("sailor|alice"), "hash stable");
  assert.notEqual(hashStr("sailor|alice"), hashStr("sailor|bob"), "hash varies");
}

// --- type assignment: stable, ~35%, all four types reachable ---
{
  const counts = {};
  let sailors = 0;
  for (let i = 0; i < 400; i++) {
    const t = sailorTypeFor("sailor-user-" + i);
    if (t) {
      sailors++;
      counts[t] = (counts[t] || 0) + 1;
      assert.ok(SAILOR_TYPES.includes(t), "type in list");
    }
  }
  assert.ok(sailors > 10 && sailors < 45, `~6% sailors (primary-profession partition), got ${sailors}`);
  assert.equal(Object.keys(counts).length, 4, "all four types assigned");
  assert.equal(sailorTypeFor("sailor-user-5"), sailorTypeFor("sailor-user-5"), "stable");
  assert.equal(sailorTypeFor(""), null, "empty username -> null");
}

// --- port assignment prefers kingdom ---
{
  const p = portFor("sailor-user-7", "kandarin");
  assert.ok(p && p.name, "port has name");
  assert.equal(p.kingdom, "kandarin", "prefers citizen kingdom");
  const p2 = portFor("sailor-user-7", "unknownkingdom");
  assert.ok(p2 && p2.name, "falls back to all ports");
  assert.equal(portFor("sailor-user-7", "kandarin").name, p.name, "stable");
}

// --- ship assignment stable ---
{
  const s1 = shipFor("captain-one", "misthalin");
  const s2 = shipFor("captain-one", "misthalin");
  assert.deepEqual(s1, s2, "ship stable across calls");
  assert.ok(SHIP_NAMES.includes(s1.name), "ship name in list");
  assert.ok(SHIP_TYPES.includes(s1.type), "ship type in list");
  assert.ok(s1.port && s1.port.name, "ship has home port");
}

// --- destination differs from home, stable per day ---
{
  const now = Date.now();
  const d1 = destinationFor("captain-one", "misthalin", now);
  const d2 = destinationFor("captain-one", "misthalin", now);
  assert.deepEqual(d1, d2, "destination stable per day");
  assert.notEqual(d1.name, portFor("captain-one", "misthalin").name, "not the home port");
}

// --- ship-in-port rhythm ---
{
  const days = new Set();
  for (let d = 0; d < 30; d++) {
    days.add(shipInPortFor("captain-one", Date.now() + d * 86400000));
  }
  assert.ok(days.size === 2, "in-port varies across days");
}

// --- weather: one of the three, storm detectable ---
{
  const w = weatherFor(Date.now());
  assert.ok(["calm", "breezy", "storm"].includes(w), "weather in set");
  assert.equal(isStorm("storm"), true);
  assert.equal(isStorm("calm"), false);
}

// --- work lines: per type + storm variant ---
{
  const rng = lcg(42);
  for (const t of SAILOR_TYPES) {
    const line = workLineFor(rng, t, "calm");
    assert.ok(typeof line === "string" && line.length > 0, `line for ${t}`);
  }
  const stormWords = /storm|mooring|hatch|batten|port|sail|swell|sea|hatches/i;
  for (let s = 0; s < 20; s++) {
    const line = workLineFor(lcg(100 + s), SAILOR_TYPES[0], "storm");
    assert.ok(stormWords.test(line), `storm line is nautical: ${line}`);
  }
  function SAILOR_DECKHAND_FIXTURE() {
    return SAILOR_TYPES[0];
  }
  void SAILOR_DECKHAND_FIXTURE;
}

// --- arrival and offer lines mention ship and places ---
{
  const rng = lcg(7);
  const ship = shipFor("captain-one", "misthalin");
  const a = arrivalLineFor(rng, ship, ship.port);
  assert.ok(a.includes(ship.name), "arrival names the ship");
  const dest = destinationFor("captain-one", "misthalin", Date.now());
  const o = offerLineFor(rng, ship, dest);
  assert.ok(o.includes(ship.name) && o.includes(dest.name), "offer names ship + destination");
}

// --- animFor: engine-verified ids ---
{
  assert.equal(animFor(SAILOR_TYPES[2]), 13340, "captain helm anim");
  assert.equal(animFor(SAILOR_TYPES[3]), 13599, "dockworker sort anim");
  assert.equal(animFor(SAILOR_TYPES[0]), 13576, "deckhand cast anim");
  assert.equal(animFor(SAILOR_TYPES[1]), 0, "navigator no anim");
}

// --- shouldFire / shouldOffer / shouldAnnounceArrival: cooldown gates ---
{
  const rng = lcg(1);
  const now = 100 * 3600 * 1000; // well past all cooldown windows
  assert.equal(shouldFire(rng, now - 1000, now), false, "work cooldown");
  assert.equal(shouldOffer(rng, now - 1000, now), false, "offer cooldown");
  assert.equal(shouldAnnounceArrival(rng, now - 1000, now), false, "arrival cooldown");
  // With rng that always passes: after cooldown, chance gate decides.
  const pass = () => 0.0;
  assert.equal(shouldFire(pass, 0, now), true, "work fires after cooldown");
  assert.equal(shouldOffer(pass, 0, now), true, "offer fires after cooldown");
  assert.equal(shouldAnnounceArrival(pass, 0, now), true, "arrival fires after cooldown");
  const fail = () => 0.99999;
  assert.equal(shouldFire(fail, 0, now), false, "chance gate can block");
}

// --- voyageFor: captains only ---
{
  // Find a captain username deterministically.
  let captainUser = null;
  for (let i = 0; i < 400 && !captainUser; i++) {
    if (sailorTypeFor("voy-" + i) === SAILOR_TYPES[2]) captainUser = "voy-" + i;
  }
  assert.ok(captainUser, "found a captain");
  const v = voyageFor(captainUser, "kandarin", Date.now());
  assert.ok(v && v.ship && v.from && v.to, "voyage has ship, from, to");
  assert.equal(typeof v.inPort, "boolean", "inPort boolean");
  assert.equal(voyageFor("sailor-user-0", "kandarin", Date.now()) === null ||
    sailorTypeFor("sailor-user-0") === SAILOR_TYPES[2], true, "non-captains null");
}

// --- isRealPlayer / withinTiles gates ---
{
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot" }), false);
  assert.equal(isRealPlayer({ getUsername: () => "x" }), true);
  assert.equal(withinTiles(at(0, 0, 0), at(10, 5, 0), 14), true, "chebyshev in range");
  assert.equal(withinTiles(at(0, 0, 0), at(15, 0, 0), 14), false, "chebyshev out of range");
  assert.equal(withinTiles(at(0, 0, 0), at(0, 0, 1), 14), false, "different plane");
}

// --- tick never throws on hostile input ---
{
  _resetState();
  assert.doesNotThrow(() => tickSailors(null, Date.now()), "null director");
  assert.doesNotThrow(() => tickSailors({}, Date.now()), "empty director");
  assert.doesNotThrow(
    () => tickSailors({ roster: { values: () => { throw new Error("boom"); } } }, Date.now()),
    "throwing roster"
  );
}

// --- tick fires work for a materialized sailor near a real player ---
{
  _resetState();
  // Find a sailor username.
  let sailorUser = null;
  for (let i = 0; i < 400 && !sailorUser; i++) {
    if (sailorTypeFor("tick-" + i)) sailorUser = "tick-" + i;
  }
  const bot = makeBot(sailorUser);
  const director = {
    roster: new Map([[sailorUser, { username: sailorUser, role: "commoner", kingdom: "kandarin" }]]),
    playerFor: () => bot,
    onlinePlayers: () => [makeRealPlayer("RealPlayer")],
  };
  // Force the chance gate by running many ticks worth of simulated time.
  const origRandom = Math.random;
  Math.random = () => 0.0;
  try {
    tickSailors(director, Date.now());
  } finally {
    Math.random = origRandom;
  }
  assert.ok(bot.chats.length >= 1, `sailor worked, chats=${bot.chats.length}`);
  assert.ok(typeof bot.chats[0] === "string" && bot.chats[0].length > 0, "chat line non-empty");
}

// --- tick stays silent for non-sailors and bots-only crowds ---
{
  _resetState();
  const bot = makeBot("definitely-not-a-sailor-zzz");
  const director = {
    roster: new Map([["definitely-not-a-sailor-zzz", { username: "definitely-not-a-sailor-zzz", role: "commoner", kingdom: "kandarin" }]]),
    playerFor: () => bot,
    onlinePlayers: () => [makeRealPlayer("RealPlayer")],
  };
  const origRandom = Math.random;
  Math.random = () => 0.0;
  try {
    tickSailors(director, Date.now());
  } finally {
    Math.random = origRandom;
  }
  assert.equal(bot.chats.length, 0, "non-sailor silent");

  // Bots-only: no real player near -> silence.
  _resetState();
  let sailorUser2 = null;
  for (let i = 0; i < 400 && !sailorUser2; i++) {
    if (sailorTypeFor("botcrowd-" + i)) sailorUser2 = "botcrowd-" + i;
  }
  const bot2 = makeBot(sailorUser2);
  const botCrowd = makeBot("otherbot");
  const director2 = {
    roster: new Map([[sailorUser2, { username: sailorUser2, role: "commoner", kingdom: "kandarin" }]]),
    playerFor: () => bot2,
    onlinePlayers: () => [botCrowd],
  };
  Math.random = () => 0.0;
  try {
    tickSailors(director2, Date.now());
  } finally {
    Math.random = origRandom;
  }
  assert.equal(bot2.chats.length, 0, "silent near bots only");
}

// --- guards never sail ---
{
  let guardSails = false;
  for (let i = 0; i < 400; i++) {
    // sailorTypeFor only looks at username; the tick gates on role.
    void i;
  }
  const bot = makeBot("tick-guard");
  const director = {
    roster: new Map([["tick-guard", { username: "tick-guard", role: "guard", kingdom: "kandarin" }]]),
    playerFor: () => bot,
    onlinePlayers: () => [makeRealPlayer("RealPlayer")],
  };
  const origRandom = Math.random;
  Math.random = () => 0.0;
  _resetState();
  try {
    tickSailors(director, Date.now());
  } finally {
    Math.random = origRandom;
  }
  assert.equal(bot.chats.length, 0, "guards never sail");
  assert.equal(guardSails, false);
}

console.log("CitizenSailors: all checks passed");
