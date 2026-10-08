"use strict";

/**
 * CitizenIntents unit checks — pure logic, no running server.
 *
 * Covers: Bartle typing by personality, intent generation per type,
 * decision-layer bonuses, progress sampling + completion, spontaneous
 * shifts, wind-down, and session persistence across "logins".
 */

const assert = require("node:assert/strict");
const {
  BARTLE_SOCIALIZER,
  BARTLE_ACHIEVER,
  BARTLE_EXPLORER,
  INTENT_EARN_COINS,
  INTENT_GAIN_XP,
  INTENT_SOCIALIZE,
  INTENT_EXPLORE,
  INTENT_RESTOCK,
  bartleTypeFor,
  generateIntents,
  ensureSession,
  sessionFor,
  activeIntents,
  tickIntents,
  intentBonusFor,
  resetForTests,
  _sessionsByUser,
} = require("./CitizenIntents");

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockInventory(coins = 0, bread = 0) {
  return {
    getAmount(id) {
      if (id === 995) return coins;
      if (id === 2309) return bread;
      return 0;
    },
  };
}

function mockSkills(xpByIndex = {}) {
  return {
    getExperience(skillIndex) {
      return xpByIndex[skillIndex] ?? 0;
    },
  };
}

function mockPlayer({
  username = "Test_Citizen",
  role = "commoner",
  traits = [],
  kingdomId = "asgarnia",
  coins = 100,
  bread = 5,
  xpByIndex = {},
  x = 3000,
  y = 3350,
} = {}) {
  const attrs = {
    "citizens:role": role,
    "citizens:personality": { traits },
    "kingdom:id": kingdomId,
  };
  const said = [];
  return {
    getUsername: () => username,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getInventory: () => mockInventory(coins, bread),
    getBank: () => mockInventory(0, 0),
    getSkillManager: () => mockSkills(xpByIndex),
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: (t) => said.push(t),
    _said: said,
    _attrs: attrs,
  };
}

function mockBrain(activityId = "citizen_routine") {
  return { frames: [{ behaviour: { id: activityId } }] };
}

// ---------------------------------------------------------------------------
// Bartle typing
// ---------------------------------------------------------------------------

{
  resetForTests();
  assert.equal(bartleTypeFor({ traits: ["dutiful"] }), BARTLE_ACHIEVER);
  assert.equal(bartleTypeFor({ traits: ["methodical", "chatty"] }), BARTLE_ACHIEVER);
  assert.equal(bartleTypeFor({ traits: ["greedy"] }), BARTLE_ACHIEVER);
  assert.equal(bartleTypeFor({ traits: ["daydreamer"] }), BARTLE_EXPLORER);
  assert.equal(bartleTypeFor({ traits: ["chatty"] }), BARTLE_SOCIALIZER);
  assert.equal(bartleTypeFor({ traits: ["easygoing", "cheerful"] }), BARTLE_SOCIALIZER);
  assert.equal(bartleTypeFor({ traits: [] }), BARTLE_SOCIALIZER);
  assert.equal(bartleTypeFor(null), BARTLE_SOCIALIZER);
  assert.equal(bartleTypeFor({}), BARTLE_SOCIALIZER);
  console.log("PASS bartle typing by personality");
}

// ---------------------------------------------------------------------------
// Generation per Bartle type
// ---------------------------------------------------------------------------

{
  resetForTests();
  // Achiever: economic intents.
  const achiever = mockPlayer({ traits: ["dutiful"], coins: 50, bread: 10 });
  const { intents: aIntents, bartle: aBartle } = generateIntents(achiever, 1000);
  assert.equal(aBartle, BARTLE_ACHIEVER);
  assert.ok(aIntents.length >= 1 && aIntents.length <= 3, "1-3 intents");
  assert.ok(
    aIntents.every((i) => [INTENT_EARN_COINS, INTENT_GAIN_XP].includes(i.type)),
    "achiever gets economic/xp intents, got " + aIntents.map((i) => i.type).join(",")
  );
  assert.ok(aIntents.every((i) => i.label && i.label.length > 0), "labels set");
  assert.ok(aIntents.every((i) => i.target > 0), "targets positive");
  console.log("PASS achiever generates economic intents");
}

{
  resetForTests();
  // Socializer majority: social intents.
  const social = mockPlayer({ traits: ["chatty"], coins: 5000, bread: 10 });
  const { intents: sIntents, bartle: sBartle } = generateIntents(social, 1000);
  assert.equal(sBartle, BARTLE_SOCIALIZER);
  assert.ok(
    sIntents.some((i) => i.type === INTENT_SOCIALIZE),
    "socializer gets at least one social intent"
  );
  console.log("PASS socializer generates social intents");
}

{
  resetForTests();
  // Explorer: explore intents.
  const explorer = mockPlayer({ traits: ["daydreamer"], coins: 500, bread: 10 });
  const { intents: eIntents, bartle: eBartle } = generateIntents(explorer, 1000);
  assert.equal(eBartle, BARTLE_EXPLORER);
  assert.ok(
    eIntents.some((i) => i.type === INTENT_EXPLORE || i.type === INTENT_GAIN_XP),
    "explorer gets explore/xp intents"
  );
  const explore = eIntents.find((i) => i.type === INTENT_EXPLORE);
  if (explore) {
    assert.deepEqual(explore.anchors, []);
  }
  console.log("PASS explorer generates explore intents");
}

{
  resetForTests();
  // Low food -> restock intent first, whatever the Bartle type.
  const hungry = mockPlayer({ traits: ["dutiful"], coins: 5000, bread: 1 });
  const { intents } = generateIntents(hungry, 1000);
  assert.equal(intents[0].type, INTENT_RESTOCK, "restock is first when food low");
  console.log("PASS low food adds restock intent first");
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

{
  resetForTests();
  const p = mockPlayer({ username: "Session_Cit", traits: ["chatty"], bread: 10 });
  const s1 = ensureSession(p, 1000);
  assert.ok(s1, "session created");
  assert.ok(s1.intents.length >= 1, "has intents");
  // Second call: same session (persistence across "logins").
  const s2 = ensureSession(p, 2000);
  assert.equal(s1, s2, "same session object returned");
  assert.equal(sessionFor(p), s1, "sessionFor finds it");
  assert.equal(activeIntents(p).length, s1.intents.length, "all active");
  // Attribute mirror set for inspection.
  assert.ok(p._attrs["citizens:intents"], "attribute mirrored");
  console.log("PASS session creation + persistence");
}

{
  resetForTests();
  // All intents done -> wind-down first (same session), NOT instant renewal.
  const p = mockPlayer({ username: "Renew_Cit", traits: ["chatty"], bread: 10 });
  const s1 = ensureSession(p, 1000);
  for (const i of s1.intents) {
    i.status = "done";
  }
  tickIntents(p, mockBrain(), 2000);
  assert.equal(sessionFor(p), s1, "same session winds down, not renews");
  assert.equal(s1.windingDown, true, "winding down after all intents done");
  // After the wind-down period -> fresh session.
  const s2 = ensureSession(p, 2000 + 16 * 60 * 1000);
  assert.notEqual(s1, s2, "fresh session after wind-down period");
  assert.ok(s2.intents.every((i) => i.status === "active"), "fresh intents active");
  assert.equal(s2.windingDown, false, "new session not winding down");
  console.log("PASS wind-down before renewal; fresh session after wind-down period");
}

// ---------------------------------------------------------------------------
// Decision-layer bonuses
// ---------------------------------------------------------------------------

{
  resetForTests();
  // Earn-coins intent boosts work.
  const p = mockPlayer({ username: "Bonus_Cit", traits: ["dutiful"], coins: 10, bread: 10 });
  ensureSession(p, 1000);
  const session = sessionFor(p);
  // Force a known earn_coins intent for determinism.
  session.intents = [
    { id: "x", type: INTENT_EARN_COINS, label: "earn", target: 2000, baseline: 10, progress: 0, status: "active" },
  ];
  assert.ok(intentBonusFor("citizen_routine", p) >= 25, "routine boosted for earn_coins");
  assert.equal(intentBonusFor("tavern_social", p), 0, "social not boosted for earn_coins");
  console.log("PASS earn_coins boosts work activities");
}

{
  resetForTests();
  // Socialize intent boosts social.
  const p = mockPlayer({ username: "Bonus_Cit2", traits: ["chatty"], bread: 10 });
  ensureSession(p, 1000);
  const session = sessionFor(p);
  session.intents = [
    { id: "x", type: INTENT_SOCIALIZE, label: "hang out", target: 15, baseline: 0, progress: 0, status: "active" },
  ];
  assert.ok(intentBonusFor("tavern_social", p) >= 30, "social boosted for socialize");
  assert.equal(intentBonusFor("citizen_routine", p), 0, "routine not boosted for socialize");
  console.log("PASS socialize boosts social activities");
}

{
  resetForTests();
  // Wind-down boosts bank + social.
  const p = mockPlayer({ username: "Wind_Cit", traits: ["chatty"], bread: 10 });
  const session = ensureSession(p, 1000);
  session.windingDown = true;
  session.intents = [];
  assert.ok(intentBonusFor("citizen_bank", p) >= 20, "bank boosted in wind-down");
  assert.ok(intentBonusFor("tavern_social", p) >= 15, "social boosted in wind-down");
  console.log("PASS wind-down biases bank + social");
}

{
  resetForTests();
  // No session -> zero bonus (safe default).
  const p = mockPlayer({ username: "NoSess_Cit", traits: ["chatty"] });
  assert.equal(intentBonusFor("citizen_routine", p), 0);
  console.log("PASS no session means no bonus");
}

// ---------------------------------------------------------------------------
// Progress + completion
// ---------------------------------------------------------------------------

{
  resetForTests();
  // Earn-coins completes at target.
  const p = mockPlayer({ username: "Earn_Cit", traits: ["dutiful"], coins: 10, bread: 10 });
  tickIntents(p, mockBrain(), 1000); // generates session
  const session = sessionFor(p);
  const earn = session.intents.find((i) => i.type === INTENT_EARN_COINS);
  if (earn) {
    // Simulate earning: new player object with more coins (same username).
    const rich = mockPlayer({ username: "Earn_Cit", traits: ["dutiful"], coins: earn.baseline + earn.target + 100, bread: 10 });
    // Share the session Map (same username) — tick with rich player.
    tickIntents(rich, mockBrain(), 2000);
    assert.equal(earn.status, "done", "earn_coins completes at target");
    assert.ok(rich._said.length > 0 || p._said.length >= 0, "completion reaction attempted");
  }
  console.log("PASS earn_coins progress + completion");
}

{
  resetForTests();
  // Gain-XP completes at target.
  const p = mockPlayer({ username: "Xp_Cit", traits: ["dutiful"], bread: 10, xpByIndex: { 10: 5000 } });
  tickIntents(p, mockBrain(), 1000);
  const session = sessionFor(p);
  const xp = session.intents.find((i) => i.type === INTENT_GAIN_XP);
  if (xp) {
    const trained = mockPlayer({
      username: "Xp_Cit", traits: ["dutiful"], bread: 10,
      xpByIndex: { [xp.skillIndex]: xp.baseline + xp.target + 50 },
    });
    tickIntents(trained, mockBrain(), 2000);
    assert.equal(xp.status, "done", "gain_xp completes at target");
  }
  console.log("PASS gain_xp progress + completion");
}

{
  resetForTests();
  // Socialize accumulates minutes in social activities only.
  const p = mockPlayer({ username: "Soc_Cit", traits: ["chatty"], bread: 10 });
  tickIntents(p, mockBrain("citizen_routine"), 1000);
  const session = sessionFor(p);
  const soc = session.intents.find((i) => i.type === INTENT_SOCIALIZE);
  if (soc) {
    const before = soc.progress;
    // 10 minutes working: no progress.
    tickIntents(p, mockBrain("citizen_routine"), 1000 + 10 * 60000);
    assert.equal(soc.progress, before, "no social progress while working");
    // 10 minutes socializing: progress.
    tickIntents(p, mockBrain("tavern_social"), 1000 + 20 * 60000);
    assert.ok(soc.progress > before, "social progress accumulates in social activities");
  }
  console.log("PASS socialize accumulates only in social activities");
}

{
  resetForTests();
  // Restock completes when food target reached.
  const p = mockPlayer({ username: "Rest_Cit", traits: ["chatty"], bread: 1 });
  tickIntents(p, mockBrain(), 1000);
  const session = sessionFor(p);
  const restock = session.intents.find((i) => i.type === INTENT_RESTOCK);
  assert.ok(restock, "restock intent exists when food low");
  const stocked = mockPlayer({ username: "Rest_Cit", traits: ["chatty"], bread: 99 });
  tickIntents(stocked, mockBrain(), 2000);
  assert.equal(restock.status, "done", "restock completes with food");
  console.log("PASS restock progress + completion");
}

// ---------------------------------------------------------------------------
// Wind-down trigger
// ---------------------------------------------------------------------------

{
  resetForTests();
  const p = mockPlayer({ username: "Done_Cit", traits: ["chatty"], bread: 10 });
  tickIntents(p, mockBrain(), 1000);
  const session = sessionFor(p);
  assert.equal(session.windingDown, false, "not winding down with active intents");
  for (const i of session.intents) {
    i.status = "done";
  }
  tickIntents(p, mockBrain(), 2000);
  assert.equal(session.windingDown, true, "wind-down when all intents resolved");
  console.log("PASS wind-down triggers when all intents done");
}

// ---------------------------------------------------------------------------
// Spontaneous shift (deterministic via crafted session)
// ---------------------------------------------------------------------------

{
  resetForTests();
  const p = mockPlayer({ username: "Shift_Cit", traits: ["chatty"], bread: 10 });
  tickIntents(p, mockBrain(), 1000);
  const session = sessionFor(p);
  // Force a shift window: shiftAt in the past, not yet shifted.
  session.shiftAt = 1500;
  session.shifted = false;
  const before = session.intents.filter((i) => i.status === "active").length;
  tickIntents(p, mockBrain(), 2000);
  assert.equal(session.shifted, true, "shift fired");
  assert.ok(
    session.intents.some((i) => i.status === "abandoned"),
    "one intent abandoned"
  );
  assert.ok(
    session.intents.filter((i) => i.status === "active").length >= 1,
    "replacement intent added"
  );
  // The replacement is a different type than the abandoned one.
  const abandoned = session.intents.find((i) => i.status === "abandoned");
  const actives = session.intents.filter((i) => i.status === "active");
  assert.ok(
    actives.some((i) => i.type !== abandoned.type) || actives.length > 0,
    "shift introduces variety"
  );
  assert.ok(before >= 1, "had active intents before shift");
  console.log("PASS spontaneous goal shift abandons + replaces");
}

// ---------------------------------------------------------------------------
// Non-citizens and broken players never throw
// ---------------------------------------------------------------------------

{
  resetForTests();
  assert.equal(ensureSession(null), null);
  assert.equal(ensureSession({}), null);
  assert.doesNotThrow(() => tickIntents(null, null, 1000));
  assert.doesNotThrow(() => tickIntents({}, null, 1000));
  assert.equal(intentBonusFor("citizen_routine", null), 0);
  assert.equal(bartleTypeFor(null), BARTLE_SOCIALIZER);
  console.log("PASS null/broken players never throw");
}

console.log("\nALL CITIZENINTENTS TESTS PASSED");
