"use strict";

// StreetIdle unit test — pure helpers + stubbed-director integration
// (no engine, no live director).

const assert = require("node:assert/strict");
const {
  onIdleSeen,
  clearIdleOnLogout,
  sameTile,
  isAfk,
  voiceOf,
  fillLine,
  IDLE_LINES,
  IDLE_AFK_THRESHOLD_MS,
  _resetStateForTests,
} = require("./StreetIdle");

const T0 = 1_800_000_000_000; // fixed anchor, avoids Date.now races
const MIN = 60 * 1000;

// --- (1) sameTile: pure tile-equality logic ---
assert.equal(sameTile({ x: 1, y: 2, z: 0 }, { x: 1, y: 2, z: 0 }), true);
assert.equal(sameTile({ x: 1, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }), false);
assert.equal(sameTile({ x: 1, y: 2, z: 0 }, { x: 1, y: 2, z: 1 }), false);
assert.equal(sameTile(null, { x: 1, y: 2, z: 0 }), false);
assert.equal(sameTile({ x: 1, y: 2, z: 0 }, undefined), false);
assert.equal(sameTile(null, null), false);
console.log("sameTile: PASS");

// --- (2) isAfk: threshold timing with injectable timestamps ---
assert.equal(IDLE_AFK_THRESHOLD_MS, 10 * MIN, "AFK threshold is 10 minutes");
const entry = { x: 0, y: 0, z: 0, sinceMs: T0, nudged: false };
assert.equal(isAfk(entry, T0 + 10 * MIN - 1), false, "not AFK at +9:59");
assert.equal(isAfk(entry, T0 + 10 * MIN), true, "AFK at exactly +10:00");
assert.equal(isAfk(entry, T0 + 60 * MIN), true, "AFK at +60:00");
assert.equal(isAfk(null, T0 + 60 * MIN), false);
assert.equal(isAfk({ sinceMs: "nope" }, T0 + 60 * MIN), false);
console.log("isAfk: PASS");

// --- (5) voiceOf: personality -> nudge voice, incl. merchant/dismissive ---
const warm = { personality: { traits: ["cheerful", "friendly"] } };
const wry = { personality: { traits: ["proud"] } };
const neutral = { personality: { traits: [] } };
const grumpy = { personality: { traits: ["gruff"] } };
const fearful = { personality: { traits: ["timid"] } };
const merchant = { personality: { traits: ["friendly"] }, merchantKind: "prime" };
const grumpyMerchant = {
  personality: { traits: ["surly"] },
  merchantKind: "supplier",
};
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
  fillLine("You alright there, {name}? You've been standing a while.", {
    name: "Jon",
  }),
  "You alright there, Jon? You've been standing a while."
);
assert.equal(fillLine("Hmph. Human statue.", { name: "Jon" }), "Hmph. Human statue.");
console.log("fillLine: PASS");

// --- (6) IDLE_LINES: pool sanity ---
for (const voice of ["warm", "neutral", "wry", "merchant", "dismissive"]) {
  const pool = IDLE_LINES[voice];
  assert.ok(Array.isArray(pool) && pool.length > 0, `${voice} pool missing`);
  for (const line of pool) {
    assert.ok(line.length <= 120, `${voice} line too long: ${line}`);
    assert.ok(!line.includes("{skill}"), `${voice} has unfilled placeholder`);
    assert.ok(!line.includes("{foe}"), `${voice} has unfilled placeholder`);
  }
  // Every line interpolates cleanly — no braces left over.
  for (const line of pool) {
    const filled = fillLine(line, { name: "TestPlayer" });
    assert.ok(!filled.includes("{") && !filled.includes("}"),
      `${voice} line has leftover braces: ${line}`);
  }
}
// Dismissive lines never address the player by name — they're muttering.
for (const line of IDLE_LINES.dismissive) {
  assert.ok(!line.includes("{name}"), `dismissive line names the player: ${line}`);
}
// Every other voice addresses the idle player by name.
for (const voice of ["warm", "neutral", "wry", "merchant"]) {
  for (const line of IDLE_LINES[voice]) {
    assert.ok(line.includes("{name}"), `${voice} line missing player name: ${line}`);
  }
}
console.log("IDLE_LINES: PASS");

// --- (4) handler guards: null payloads, citizen bots, non-players ---
_resetStateForTests();
assert.doesNotThrow(() => onIdleSeen(null));
assert.doesNotThrow(() => onIdleSeen({}));
assert.doesNotThrow(() => onIdleSeen({ player: null }));
// A citizen bot standing still is not an AFK player — excluded.
assert.doesNotThrow(() =>
  onIdleSeen(
    {
      player: {
        isPlayerBot: () => true,
        getHostAddress: () => "bot",
        getUsername: () => "SomeCitizen",
        getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
        getLocalPlayers: () => [],
      },
    },
    T0
  )
);
// A host-address bot that isn't flagged isPlayerBot is still excluded.
assert.doesNotThrow(() =>
  onIdleSeen(
    {
      player: {
        getHostAddress: () => "bot",
        getUsername: () => "StreetSweeper",
        getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
        getLocalPlayers: () => [],
      },
    },
    T0
  )
);
// Not a player at all (no getUsername function) — excluded.
assert.doesNotThrow(() =>
  onIdleSeen(
    { player: { getHostAddress: () => "1.2.3.4", getLocalPlayers: () => [] } },
    T0
  )
);
// clearIdleOnLogout never throws, even on junk.
assert.doesNotThrow(() => clearIdleOnLogout(null));
assert.doesNotThrow(() => clearIdleOnLogout({}));
assert.doesNotThrow(() => clearIdleOnLogout({ player: null }));
assert.doesNotThrow(() =>
  clearIdleOnLogout({ player: { getUsername: () => "Ghost" } })
);
console.log("handler guards: PASS");

// --- (3) + (7): stubbed director — AFK fires once, tile change resets,
// cooldowns hold then reopen ---
const directorPath = require.resolve("./director/CitizenDirector");
const realCacheEntry = require.cache[directorPath];
const spoken = [];
const fakeSpeaker = {
  getUsername: () => "Citizen Zed",
  getHostAddress: () => "bot",
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
};
require.cache[directorPath] = {
  id: directorPath,
  filename: directorPath,
  loaded: true,
  exports: { getDirector: () => fakeDirector },
};

function makeTile() {
  const t = { x: 0, y: 0, z: 0 };
  return {
    set: (x, y, z) => {
      t.x = x;
      t.y = y;
      t.z = z;
    },
    location: () => ({
      getX: () => t.x,
      getY: () => t.y,
      getZ: () => t.z,
    }),
  };
}
const zedTile = makeTile();
const betaTile = makeTile();
function fakePlayer(name, tile) {
  return {
    getHostAddress: () => "1.2.3.4",
    getUsername: () => name,
    getLocation: () => tile.location(),
    getLocalPlayers: () => [fakeSpeaker],
    isPlayerBot: () => false,
  };
}

const realRandom = Math.random;
Math.random = () => 0; // always roll under the chance
try {
  _resetStateForTests();

  // --- (3) nudge fires once; tile change resets the AFK clock ---
  // Simulated timestamps stay >=31s apart: the module's tick gate only
  // evaluates every 30s (real onPlayerProcess ticks are ~600ms).
  onIdleSeen({ player: fakePlayer("PlayerZed", zedTile) }, T0);
  assert.equal(spoken.length, 0, "no nudge on first sighting");
  onIdleSeen({ player: fakePlayer("PlayerZed", zedTile) }, T0 + 9 * MIN + 59 * 1000);
  assert.equal(spoken.length, 0, "no nudge at +9:59");
  onIdleSeen({ player: fakePlayer("PlayerZed", zedTile) }, T0 + 10 * MIN + 31 * 1000);
  assert.equal(spoken.length, 1, "nudge fires once past +10:00");
  assert.ok(spoken[0].includes("PlayerZed"), `line names the player: ${spoken[0]}`);
  assert.ok(spoken[0].length <= 120);
  // Nudged: no second nudge without moving.
  onIdleSeen({ player: fakePlayer("PlayerZed", zedTile) }, T0 + 20 * MIN + 31 * 1000);
  assert.equal(spoken.length, 1, "nudged player is not re-nudged");
  console.log("nudge fires once: PASS");

  // Tile change resets the clock: this player moves BEFORE ever going
  // AFK, so at +19m of total standing they are still not AFK (only 9m
  // at the new tile). Without the reset they would be AFK and fire —
  // no cooldowns are set for this fresh player, so silence proves it.
  _resetStateForTests();
  const moverTile = makeTile();
  const mover = () => fakePlayer("PlayerMover", moverTile);
  onIdleSeen({ player: mover() }, T0);
  onIdleSeen({ player: mover() }, T0 + 9 * MIN);
  assert.equal(spoken.length, 1, "still silent at +9m");
  moverTile.set(7, 0, 0); // moved: tracking dropped
  onIdleSeen({ player: mover() }, T0 + 9 * MIN + 31 * 1000);
  assert.equal(spoken.length, 1, "tile change drops tracking, no nudge");
  onIdleSeen({ player: mover() }, T0 + 10 * MIN + 2 * 1000);
  assert.equal(spoken.length, 1, "re-sighted at the new tile, no nudge");
  onIdleSeen({ player: mover() }, T0 + 19 * MIN + 2 * 1000);
  assert.equal(
    spoken.length,
    1,
    "AFK clock restarted by the move: 9m at the new tile is not AFK"
  );
  console.log("tile change resets AFK: PASS");

  // --- (7) cooldowns: citizen gate at +1min, player gate at +20min ---
  _resetStateForTests();
  const beta = () => fakePlayer("PlayerBeta", betaTile);
  const zed = () => fakePlayer("PlayerZed2", zedTile);
  zedTile.set(0, 0, 0);
  betaTile.set(0, 0, 0);

  onIdleSeen({ player: beta() }, T0); // beta first sighting
  onIdleSeen({ player: zed() }, T0 + 31 * 1000); // zed first sighting
  onIdleSeen({ player: beta() }, T0 + 10 * MIN + 31 * 1000); // beta AFK -> fires
  assert.equal(spoken.length, 2, "first nudge fires once");
  // zed crosses AFK a minute later, but the citizen just spoke.
  onIdleSeen({ player: zed() }, T0 + 11 * MIN + 2 * 1000);
  assert.equal(spoken.length, 2, "citizen cooldown holds at +1min");
  // beta moves, stands still again: AFK again at +22min, but the
  // per-player 45-minute cooldown holds.
  betaTile.set(2, 0, 0);
  onIdleSeen({ player: beta() }, T0 + 11 * MIN + 33 * 1000); // move drops tracking
  onIdleSeen({ player: beta() }, T0 + 12 * MIN + 4 * 1000); // re-sighting
  onIdleSeen({ player: beta() }, T0 + 22 * MIN + 4 * 1000); // AFK again
  assert.equal(spoken.length, 2, "player cooldown holds at +20min");
  // Both gates reopened after expiry: +56min fires again.
  onIdleSeen({ player: beta() }, T0 + 56 * MIN + 31 * 1000);
  assert.equal(spoken.length, 3, "both gates reopen after expiry");
  assert.ok(spoken[2].includes("PlayerBeta"));
  assert.ok(spoken[2].length <= 120);
  console.log("nudge path + cooldowns: PASS");

  // Logout clears tracking: beta logs out mid-still-spell, relogs —
  // the clock starts over, no stale entry.
  _resetStateForTests();
  betaTile.set(0, 0, 0);
  onIdleSeen({ player: beta() }, T0);
  clearIdleOnLogout({ player: beta() });
  onIdleSeen({ player: beta() }, T0 + 10 * MIN + 31 * 1000); // would fire if entry survived
  assert.equal(spoken.length, 3, "logout cleared the idle tracking");
  console.log("logout clears tracking: PASS");
} finally {
  Math.random = realRandom;
  if (realCacheEntry) require.cache[directorPath] = realCacheEntry;
  else delete require.cache[directorPath];
}

console.log("All StreetIdle tests PASS");
