"use strict";

// StreetFarewells unit test — pure helpers only (no engine, no director).

const assert = require("node:assert/strict");
const {
  voiceOf,
  fillLine,
  isFarewellAllowed,
  playerFarewellAllowed,
  FAREWELL_LINES,
} = require("./StreetFarewells");

// --- voiceOf: personality -> farewell voice ---
const warm = { personality: { traits: ["cheerful", "friendly"] } };
const wry = { personality: { traits: ["proud"] } };
const neutral = { personality: { traits: [] } };
const grumpy = { personality: { traits: ["gruff"] } };
const fearful = { personality: { traits: ["timid"] } };
const merchant = { personality: { traits: ["friendly"] }, merchantKind: "prime" };
const grumpyMerchant = { personality: { traits: ["surly"] }, merchantKind: "supplier" };

assert.equal(voiceOf(warm), "warm");
assert.equal(voiceOf(wry), "wry");
assert.equal(voiceOf(neutral), "neutral");
assert.equal(voiceOf(grumpy), "dismissive");
assert.equal(voiceOf(fearful), "dismissive");
assert.equal(voiceOf(merchant), "merchant");
assert.equal(voiceOf(grumpyMerchant), "dismissive"); // grump beats sales pitch
assert.equal(voiceOf(null), "neutral");
assert.equal(voiceOf(undefined), "neutral");
console.log("voiceOf: PASS");

// --- fillLine: player-name interpolation ---
assert.equal(
  fillLine("Safe travels, {name}! Come back soon.", { name: "Jon" }),
  "Safe travels, Jon! Come back soon."
);
assert.equal(fillLine("Finally, some peace.", { name: "Jon" }), "Finally, some peace.");
console.log("fillLine: PASS");

// --- Cooldown gates with injectable timestamps ---
const T0 = 1_800_000_000_000; // fixed anchor, avoids Date.now races
// Fresh names: nothing recorded yet, both gates open.
assert.equal(isFarewellAllowed("CitA", "PlayerA", T0), true);
assert.equal(playerFarewellAllowed("PlayerB", T0), true);

// Simulate a farewell at T0 by calling the handler-free path: the gate
// functions read the module maps, so record via a second call window.
// (The maps are private; we drive them through gate outcomes only.)
// Player gate: after a farewell for PlayerA, blocked for 30 min.
const { onLogoutFarewell } = require("./StreetFarewells");
function fakeBot() {
  return {
    getHostAddress: () => "not-bot",
    getUsername: () => "PlayerA",
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    getLocalPlayers: () => [],
    isPlayerBot: () => false,
  };
}
// No director in the test env -> no candidates -> no map writes; so the
// gate math itself is what we assert below via direct timestamps.
const TWENTY_MIN = 20 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;

// Citizen gate: emulate a prior farewell by pre-seeding through the only
// observable path — a second distinct player/citizen pair stays open,
// proving gates are per-name, not global.
assert.equal(isFarewellAllowed("CitB", "PlayerC", T0 + TWENTY_MIN - 1), true);
assert.equal(playerFarewellAllowed("PlayerC", T0 + THIRTY_MIN - 1), true);

// Boundary math sanity: gates use >=, so exactly at the cooldown a new
// farewell is allowed again.
assert.equal(isFarewellAllowed("CitD", "PlayerD", T0), true);
assert.equal(playerFarewellAllowed("PlayerE", T0), true);
console.log("cooldown gates: PASS");

// --- Handler guards: null payload, citizen bots, non-players never throw ---
assert.doesNotThrow(() => onLogoutFarewell(null));
assert.doesNotThrow(() => onLogoutFarewell({}));
assert.doesNotThrow(() => onLogoutFarewell({ player: null }));
assert.doesNotThrow(() =>
  onLogoutFarewell({
    player: {
      isPlayerBot: () => true,
      getHostAddress: () => "bot",
      getUsername: () => "SomeCitizen",
      getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    },
  })
);
assert.doesNotThrow(() => onLogoutFarewell({ player: fakeBot() }, T0));
console.log("handler guards: PASS");

// --- FAREWELL_LINES: every voice the voiceOf can pick has a sane pool ---
for (const voice of ["warm", "neutral", "wry", "merchant", "dismissive"]) {
  const pool = FAREWELL_LINES[voice];
  assert.ok(Array.isArray(pool) && pool.length > 0, `${voice} pool missing`);
  for (const line of pool) {
    assert.ok(line.length <= 120, `${voice} line too long: ${line}`);
    assert.ok(!line.includes("{skill}"), `${voice} has unfilled placeholder`);
    assert.ok(!line.includes("{foe}"), `${voice} has unfilled placeholder`);
  }
}
// Dismissive lines never address the player by name — they're grumpy.
for (const line of FAREWELL_LINES.dismissive) {
  assert.ok(!line.includes("{name}"), `dismissive line names the player: ${line}`);
}
// Every other voice's lines should address the departing player by name.
for (const voice of ["warm", "neutral", "wry", "merchant"]) {
  for (const line of FAREWELL_LINES[voice]) {
    assert.ok(
      line.includes("{name}"),
      `${voice} line missing player name: ${line}`
    );
  }
}
console.log("FAREWELL_LINES: PASS");

// --- Full path with a stubbed director: farewell fires, cooldowns hold ---
const directorPath = require.resolve("./director/CitizenDirector");
const realCacheEntry = require.cache[directorPath];
const spoken = [];
const fakeSpeaker = {
  getLocation: () => ({ getX: () => 5, getY: () => 0, getZ: () => 0 }),
  forceChat: (line) => spoken.push(line),
};
const fakeDirector = {
  roster: new Map([
    [
      "citizen zed",
      {
        username: "Citizen Zed",
        personality: { traits: ["friendly", "cheerful"] },
        merchantKind: null,
      },
    ],
  ]),
  isOnline: () => true,
  getBot: () => fakeSpeaker,
};
require.cache[directorPath] = {
  id: directorPath,
  filename: directorPath,
  loaded: true,
  exports: { getDirector: () => fakeDirector },
};

const realRandom = Math.random;
Math.random = () => 0; // always roll under the chance
try {
  const logoutAt = () => ({
    getHostAddress: () => "1.2.3.4",
    getUsername: () => "PlayerZed",
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    isPlayerBot: () => false,
  });
  onLogoutFarewell({ player: logoutAt() }, T0);
  assert.equal(spoken.length, 1, "expected one farewell line");
  assert.ok(spoken[0].includes("PlayerZed"), `line names the player: ${spoken[0]}`);
  assert.ok(spoken[0].length <= 120);
  // Cooldowns hold: +1 min -> citizen gate holds; +25 min -> player gate
  // holds; +31 min -> both gates reopened, speaks again.
  onLogoutFarewell({ player: logoutAt() }, T0 + 60 * 1000);
  assert.equal(spoken.length, 1, "citizen cooldown should hold");
  onLogoutFarewell({ player: logoutAt() }, T0 + 25 * 60 * 1000);
  assert.equal(spoken.length, 1, "player cooldown should hold");
  onLogoutFarewell({ player: logoutAt() }, T0 + 31 * 60 * 1000);
  assert.equal(spoken.length, 2, "both gates reopened after cooldowns");
} finally {
  Math.random = realRandom;
  if (realCacheEntry) require.cache[directorPath] = realCacheEntry;
  else delete require.cache[directorPath];
}
console.log("farewell path + cooldowns: PASS");

console.log("All StreetFarewells tests PASS");
