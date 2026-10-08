"use strict";

// CitizenCompanions unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  shouldInvite,
  companionHistory,
  flavorFor,
  invitationLine,
  pickOne,
  isRealPlayer,
  withinTiles,
  pendingKey,
  ACTIVITIES,
  INVITE_COMPANION,
  COMPANION_CITIZEN_COOLDOWN_MS,
} = require("./CitizenCompanions");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- shouldInvite: cooldown gate ---
check("shouldInvite blocks during cooldown", () => {
  const now = 1_000_000;
  const rng = lcg(1);
  assert.equal(shouldInvite(rng, now - 1000, now), false);
});

check("shouldInvite allows after cooldown when rng passes", () => {
  const now = 10 * 3600 * 1000;
  const rng = () => 0.0; // always under chance
  assert.equal(shouldInvite(rng, 0, now), true);
});

check("shouldInvite respects chance gate", () => {
  const now = 10 * 3600 * 1000;
  const rng = () => 0.99; // always over chance
  assert.equal(shouldInvite(rng, 0, now), false);
});

check("shouldInvite treats missing lastInvite as long ago", () => {
  const now = 10 * 3600 * 1000;
  const rng = () => 0.0;
  assert.equal(shouldInvite(rng, undefined, now), true);
  assert.equal(shouldInvite(rng, null, now), true);
});

// --- companionHistory: parse moments ---
check("companionHistory counts accepts and declines", () => {
  const moments = [
    { text: "joined me for a fishing trip" },
    { text: "joined me for a walk" },
    { text: "turned down my dungeon run invitation" },
    { text: "ignored my tavern drink invitation" },
    { text: "helped me carry lumber" }, // not a companion moment — skipped
  ];
  const h = companionHistory(moments);
  assert.equal(h.accepted, 2);
  assert.equal(h.declined, 2);
});

check("companionHistory handles empty/missing moments", () => {
  assert.deepEqual(companionHistory([]), { accepted: 0, declined: 0 });
  assert.deepEqual(companionHistory(null), { accepted: 0, declined: 0 });
  assert.deepEqual(companionHistory(undefined), { accepted: 0, declined: 0 });
});

// --- flavorFor: warm / wistful / first ---
check("flavorFor returns first with no history", () => {
  assert.equal(flavorFor({ accepted: 0, declined: 0 }), "first");
});

check("flavorFor returns warm for regular companions", () => {
  assert.equal(flavorFor({ accepted: 3, declined: 0 }), "warm");
  assert.equal(flavorFor({ accepted: 2, declined: 1 }), "warm");
});

check("flavorFor returns wistful for chronic decliners", () => {
  assert.equal(flavorFor({ accepted: 0, declined: 3 }), "wistful");
  assert.equal(flavorFor({ accepted: 1, declined: 2 }), "wistful");
});

check("flavorFor returns first on tied history", () => {
  assert.equal(flavorFor({ accepted: 1, declined: 1 }), "first");
});

// --- invitationLine: flavor substitution ---
check("invitationLine substitutes invite text into flavor", () => {
  const rng = lcg(42);
  const activity = ACTIVITIES[0]; // fishing
  const line = invitationLine(rng, activity, "first");
  // "first" flavor is just "{invite}" — line must be one of the activity's lines
  assert.ok(activity.invites.includes(line), `unexpected line: ${line}`);
});

check("invitationLine warm flavor wraps the invite", () => {
  const rng = lcg(7);
  const activity = ACTIVITIES[2]; // walk
  const line = invitationLine(rng, activity, "warm");
  const hasBase = activity.invites.some((i) => line.includes(i));
  assert.ok(hasBase, `warm line should contain a walk invite: ${line}`);
  assert.ok(!line.includes("{invite}"), "template placeholder must be replaced");
});

check("invitationLine wistful flavor wraps the invite", () => {
  const rng = lcg(99);
  const activity = ACTIVITIES[1]; // dungeon
  const line = invitationLine(rng, activity, "wistful");
  const hasBase = activity.invites.some((i) => line.includes(i));
  assert.ok(hasBase, `wistful line should contain a dungeon invite: ${line}`);
});

// --- ACTIVITIES: data sanity ---
check("ACTIVITIES has 4 activities with invites", () => {
  assert.equal(ACTIVITIES.length, 4);
  const ids = ACTIVITIES.map((a) => a.id).sort();
  assert.deepEqual(ids, ["dungeon", "fishing", "tavern", "walk"]);
  for (const a of ACTIVITIES) {
    assert.ok(a.noun && a.noun.length > 0, `${a.id} needs a noun`);
    assert.ok(Array.isArray(a.invites) && a.invites.length >= 2, `${a.id} needs invite lines`);
  }
});

check("INVITE_COMPANION is a distinct kind string", () => {
  assert.equal(typeof INVITE_COMPANION, "string");
  assert.ok(INVITE_COMPANION.length > 0);
  assert.notEqual(INVITE_COMPANION, "activity_invite"); // must not collide with party invites
});

// --- pickOne: deterministic ---
check("pickOne is deterministic with same rng", () => {
  const arr = ["a", "b", "c", "d"];
  assert.equal(pickOne(lcg(5), arr), pickOne(lcg(5), arr));
});

// --- isRealPlayer ---
check("isRealPlayer rejects bots and nulls", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer(undefined), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({}), false); // no getUsername
});

check("isRealPlayer accepts real players", () => {
  assert.equal(isRealPlayer({ getUsername: () => "Liam" }), true);
});

// --- withinTiles ---
function fakeAt(x, y, z = 0) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}

check("withinTiles uses Chebyshev distance on same plane", () => {
  const a = fakeAt(3000, 3000);
  assert.equal(withinTiles(a, fakeAt(3005, 3005), 12), true); // diagonal 5
  assert.equal(withinTiles(a, fakeAt(3012, 3000), 12), true); // edge
  assert.equal(withinTiles(a, fakeAt(3013, 3000), 12), false); // just over
  assert.equal(withinTiles(a, fakeAt(3000, 3000, 1), 12), false); // different plane
});

// --- pendingKey: normalized ---
check("pendingKey normalizes names", () => {
  assert.equal(pendingKey("Bob", "Liam"), pendingKey("bob", "liam"));
});

// --- cooldown constant sanity ---
check("cooldown is 2 hours", () => {
  assert.equal(COMPANION_CITIZEN_COOLDOWN_MS, 2 * 60 * 60 * 1000);
});

console.log(`\n${passed} assertions passed.`);
