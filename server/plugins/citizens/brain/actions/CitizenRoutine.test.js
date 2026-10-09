"use strict";

/**
 * CitizenRoutine goal-threading unit checks — intents bend the day plan.
 *
 * The routine's wall-clock day plan (home->work->market->meal->work->
 * tavern->home) is a reasonable default, but the decision layer is
 * goal-first. bendLeg consults active session intents at phase boundaries:
 *   - a citizen grinding earn_coins/gain_xp skips the midday market browse
 *   - leaving work near goal completion (>=70%) stretches the shift 45 min
 *   - a fresh grind (<50%) works an hour late into the evening
 *   - the meal leg is never bent (eating stays HP-driven)
 *   - at most 2 bends per day; day-off plans are untouched
 * Bends mutate today's plan, so they're idempotent across re-entries.
 */
const assert = require("node:assert/strict");

// The routine pulls engine-wired bot modules (BotNavigation, InteractObject,
// Bank) whose transitive deps hit TypeScript. Stub them in the require cache
// so plain-node tests stay engine-free — same pattern as
// CitizenDecisions.test.js. bendLeg itself only touches CitizenIntents.
function stubEngineModules() {
  const stubs = {
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: () => {},
      clearMovementRequest: () => {},
    },
    "../../../bots/brain/actions/InteractObject": {
      createInteractObjectAction: () => ({ update: () => "running", stop: () => {} }),
    },
    "../../../bots/brain/actions/Bank": {
      createBankAction: () => ({ update: () => "running", stop: () => {} }),
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const path = require.resolve(rel);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
}
stubEngineModules();

const {
  buildDayPlan,
  _bendLeg: bendLeg,
  _extendWorkShift: extendWorkShift,
  _phaseFor: phaseFor,
  _haulPriceFor: haulPriceFor,
  _sellItems: sellItems,
  _verifiedAdds: verifiedAdds,
  _KIND_WORK: KIND_WORK,
  _KIND_MARKET: KIND_MARKET,
  _KIND_MEAL: KIND_MEAL,
  _KIND_SOCIAL: KIND_SOCIAL,
  _KIND_HOME: KIND_HOME,
} = require("./CitizenRoutine");

const {
  INTENT_EARN_COINS,
  INTENT_GAIN_XP,
  INTENT_SOCIALIZE,
  resetForTests,
  _sessionsByUser,
} = require("../CitizenIntents");

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Deterministic rng: zero offsets, no late days, no days off.
const steadyRng = () => 0.5;

function mockPlayer(username) {
  return {
    getUsername: () => username,
    getAttribute: () => null,
  };
}

function seedSession(username, intents) {
  _sessionsByUser.set(username, {
    intents: intents.map((i) => ({ status: "active", progress: 0, ...i })),
  });
}

function earnIntent(progress, target = 2000) {
  return { type: INTENT_EARN_COINS, label: "earn 2k coins", progress, target };
}

function xpIntent(progress, target = 1500) {
  return { type: INTENT_GAIN_XP, label: "gain xp", progress, target };
}

function freshState(plan, phaseKind) {
  return { day: 2026001, plan, phaseKind, bendsToday: 0 };
}

function phaseByKind(plan, kind, nth = 0) {
  const matches = plan.filter((p) => p.kind === kind);
  return matches[nth] ?? null;
}

function reset() {
  resetForTests();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testNoIntentsNoBend() {
  reset();
  const player = mockPlayer("grinder_no_intent");
  const plan = buildDayPlan(steadyRng);
  const market = phaseByKind(plan, KIND_MARKET);
  const state = freshState(plan, KIND_WORK);
  const before = JSON.stringify(plan);
  const kind = bendLeg(player, state, market);
  assert.equal(kind, KIND_MARKET, "no intents: market leg stands");
  assert.equal(state.bendsToday, 0, "no bend counted");
  assert.equal(JSON.stringify(plan), before, "plan untouched");
}

function testWorkIntentSkipsMarket() {
  reset();
  const player = mockPlayer("grinder1");
  seedSession("grinder1", [earnIntent(400)]);
  const plan = buildDayPlan(steadyRng);
  const market = phaseByKind(plan, KIND_MARKET);
  const state = freshState(plan, KIND_WORK);
  const kind = bendLeg(player, state, market);
  assert.equal(kind, KIND_WORK, "grinder skips the market browse");
  assert.equal(market.kind, KIND_WORK, "today's plan mutated: market leg is work");
  assert.equal(state.bendsToday, 1, "bend counted");
}

function testSocialPullBlocksSkip() {
  reset();
  const player = mockPlayer("social_grinder");
  seedSession("social_grinder", [
    earnIntent(400),
    { type: INTENT_SOCIALIZE, label: "catch up", progress: 0, target: 20 },
  ]);
  const plan = buildDayPlan(steadyRng);
  const market = phaseByKind(plan, KIND_MARKET);
  const state = freshState(plan, KIND_WORK);
  const kind = bendLeg(player, state, market);
  assert.equal(kind, KIND_MARKET, "social intent keeps the market leg");
  assert.equal(state.bendsToday, 0, "no bend counted");
}

function testNearDoneExtendsWork() {
  reset();
  const player = mockPlayer("almost_done");
  seedSession("almost_done", [earnIntent(1600, 2000)]); // 80%
  const plan = buildDayPlan(steadyRng);
  const social = phaseByKind(plan, KIND_SOCIAL);
  const workEndBefore = phaseByKind(plan, KIND_WORK, 1).end;
  const state = freshState(plan, KIND_WORK);
  const kind = bendLeg(player, state, social);
  assert.equal(kind, KIND_WORK, "near-done grinder keeps working");
  const workEndAfter = phaseByKind(plan, KIND_WORK, 1).end;
  assert.equal(workEndAfter - workEndBefore, 45, "shift stretched 45 min to finish");
  assert.equal(state.bendsToday, 1);
}

function testFreshGrindWorksLate() {
  reset();
  const player = mockPlayer("fresh_grind");
  seedSession("fresh_grind", [xpIntent(200, 1500)]); // ~13%
  const plan = buildDayPlan(steadyRng);
  const social = phaseByKind(plan, KIND_SOCIAL);
  const workEndBefore = phaseByKind(plan, KIND_WORK, 1).end;
  const state = freshState(plan, KIND_WORK);
  const kind = bendLeg(player, state, social);
  assert.equal(kind, KIND_WORK, "fresh grind works into the evening");
  const workEndAfter = phaseByKind(plan, KIND_WORK, 1).end;
  assert.equal(workEndAfter - workEndBefore, 60, "shift stretched an hour");
}

function testSteadyProgressNoBend() {
  reset();
  const player = mockPlayer("steady");
  seedSession("steady", [earnIntent(1200, 2000)]); // 60%: the dead zone
  const plan = buildDayPlan(steadyRng);
  const social = phaseByKind(plan, KIND_SOCIAL);
  const state = freshState(plan, KIND_WORK);
  const before = JSON.stringify(plan);
  const kind = bendLeg(player, state, social);
  assert.equal(kind, KIND_SOCIAL, "steady progress follows the plan");
  assert.equal(state.bendsToday, 0);
  assert.equal(JSON.stringify(plan), before, "plan untouched");
}

function testMaxBendsPerDay() {
  reset();
  const player = mockPlayer("bent_out");
  seedSession("bent_out", [earnIntent(100)]);
  const plan = buildDayPlan(steadyRng);
  const market = phaseByKind(plan, KIND_MARKET);
  const state = freshState(plan, KIND_WORK);
  state.bendsToday = 2;
  const kind = bendLeg(player, state, market);
  assert.equal(kind, KIND_MARKET, "bend cap respected");
  assert.equal(state.bendsToday, 2, "counter not incremented past cap");
}

function testMealNeverBent() {
  reset();
  const player = mockPlayer("hungry_grinder");
  seedSession("hungry_grinder", [earnIntent(100)]);
  const plan = buildDayPlan(steadyRng);
  const meal = phaseByKind(plan, KIND_MEAL);
  const state = freshState(plan, KIND_WORK);
  const kind = bendLeg(player, state, meal);
  assert.equal(kind, KIND_MEAL, "lunch stays lunch");
  assert.equal(state.bendsToday, 0);
}

function testDayOffUntouched() {
  reset();
  const player = mockPlayer("day_off_grinder");
  seedSession("day_off_grinder", [earnIntent(100)]);
  // Hand-built day-off plan: no work legs at all.
  const plan = [
    { kind: KIND_HOME, start: 0, end: 390 },
    { kind: KIND_SOCIAL, start: 390, end: 660 },
    { kind: KIND_MARKET, start: 660, end: 720 },
    { kind: KIND_MEAL, start: 720, end: 780 },
    { kind: KIND_SOCIAL, start: 780, end: 1320 },
    { kind: KIND_HOME, start: 1320, end: 1440 },
  ];
  const market = phaseByKind(plan, KIND_MARKET);
  const state = freshState(plan, KIND_SOCIAL);
  const kind = bendLeg(player, state, market);
  assert.equal(kind, KIND_MARKET, "day off is not bent into work");
  assert.equal(state.bendsToday, 0);
}

function testBendIdempotent() {
  reset();
  const player = mockPlayer("reentry");
  seedSession("reentry", [earnIntent(400)]);
  const plan = buildDayPlan(steadyRng);
  const market = phaseByKind(plan, KIND_MARKET);
  const state = freshState(plan, KIND_WORK);
  bendLeg(player, state, market); // first bend: market -> work
  assert.equal(state.bendsToday, 1);
  // Simulate re-entry: phaseFor now returns the bent (work) phase.
  const again = phaseFor(plan, 700); // 11:40, inside the bent leg
  assert.equal(again.kind, KIND_WORK, "bent plan reads back as work");
  const kind2 = bendLeg(player, state, again);
  assert.equal(kind2, KIND_WORK, "no double-bend on re-entry");
  assert.equal(state.bendsToday, 1, "bend counted once");
}

function testExtendClampedToNextLeg() {
  reset();
  const plan = [
    { kind: KIND_WORK, start: 780, end: 1020 },
    { kind: KIND_SOCIAL, start: 1020, end: 1080 }, // short 60-min leg
    { kind: KIND_HOME, start: 1080, end: 1440 },
  ];
  const social = plan[1];
  const ok = extendWorkShift(plan, social, 120); // ask for 2h
  assert.equal(ok, true, "extension applied");
  assert.ok(
    plan[0].end <= social.end,
    "never swallows the entire next leg"
  );
  assert.equal(plan[0].end, social.end, "clamped to the leg boundary");
}

function testBrokenIntentReadsDontBreakRoutine() {
  reset();
  const player = {
    getUsername: () => {
      throw new Error("boom");
    },
  };
  const plan = buildDayPlan(steadyRng);
  const market = phaseByKind(plan, KIND_MARKET);
  const state = freshState(plan, KIND_WORK);
  const kind = bendLeg(player, state, market);
  assert.equal(kind, KIND_MARKET, "broken reads fall back to the plan");
}

// ---------------------------------------------------------------------------
// Real haul pricing (alignment review finding #5)
// ---------------------------------------------------------------------------

const { getReferencePrice } = require("../../../economy/Prices.Economy");

// Canonical engine ItemContainer shape: getAmount(id), deleteNumber(id, n),
// adds(id, n) — the shapes the vanishing-coins sweep standardized on.
function mockInv(contents) {
  const m = new Map(Object.entries(contents));
  return {
    getAmount: (id) => m.get(String(id)) ?? 0,
    adds: (id, qty) => {
      m.set(String(id), (m.get(String(id)) ?? 0) + qty);
    },
    deleteNumber: (id, qty) => {
      m.set(String(id), (m.get(String(id)) ?? 0) - qty);
    },
    _map: m,
  };
}

function testHaulPriceIsRealReferencePrice() {
  // Haul prices come from the living-economy reference price — the same
  // real table merchant stalls and player shops use — never a fixed coin.
  assert.equal(haulPriceFor(317), getReferencePrice(317), "raw shrimps = reference price");
  assert.equal(haulPriceFor(1511), getReferencePrice(1511), "logs = reference price");
  assert.equal(haulPriceFor(440), getReferencePrice(440), "iron ore = reference price");
  assert.ok(haulPriceFor(317) > 1, "a real GE-listed haul is worth more than the 1-coin floor");
  assert.equal(haulPriceFor(999999), 1, "unknown item ids floor at 1, never throw");
}

function testSellItemsHappyPath() {
  const seller = mockInv({ 1511: 10, 995: 0 });
  const buyer = mockInv({ 1511: 0, 995: 500 });
  const paid = sellItems(seller, buyer, 1511, 4, 23);
  assert.equal(paid, 92, "4 logs @ 23 = 92 coins");
  assert.equal(seller._map.get("1511"), 6, "seller loses the logs");
  assert.equal(seller._map.get("995"), 92, "seller gains the coins");
  assert.equal(buyer._map.get("1511"), 4, "buyer gains the logs");
  assert.equal(buyer._map.get("995"), 408, "buyer pays from its own coin");
}

function testSellItemsBuyerCannotCover() {
  const seller = mockInv({ 1511: 10, 995: 0 });
  const buyer = mockInv({ 1511: 0, 995: 50 }); // can't cover 4 @ 23
  const paid = sellItems(seller, buyer, 1511, 4, 23);
  assert.equal(paid, 0, "no trade when the buyer can't cover");
  assert.equal(seller._map.get("1511"), 10, "seller keeps the logs");
  assert.equal(buyer._map.get("995"), 50, "buyer keeps its coins");
}

function testSellItemsItemCreditFailureRestoresSeller() {
  const seller = mockInv({ 1511: 10, 995: 0 });
  const buyer = mockInv({ 1511: 0, 995: 500 });
  buyer.adds = () => {
    throw new Error("engine add throws");
  };
  const paid = sellItems(seller, buyer, 1511, 4, 23);
  assert.equal(paid, 0, "failed item credit pays nothing");
  assert.equal(seller._map.get("1511"), 10, "seller's debited drops are restored");
  assert.equal(buyer._map.get("995"), 500, "buyer's coins untouched");
}

function testSellItemsCoinCreditFailureRollsBack() {
  const seller = mockInv({ 1511: 10, 995: 0 });
  const buyer = mockInv({ 1511: 0, 995: 500 });
  // Coin adds throw but item adds succeed: the trade must unwind fully.
  seller.adds = (id, qty) => {
    if (String(id) === "995") throw new Error("engine coin credit throws");
    seller._map.set(String(id), (seller._map.get(String(id)) ?? 0) + qty);
  };
  const paid = sellItems(seller, buyer, 1511, 4, 23);
  assert.equal(paid, 0, "failed coin credit pays nothing");
  assert.equal(seller._map.get("1511"), 10, "seller's items come back");
  assert.equal(seller._map.get("995"), 0, "seller gains no coins");
  assert.equal(buyer._map.get("1511"), 0, "buyer keeps no items");
  assert.equal(buyer._map.get("995"), 500, "buyer's coins come back");
}

function testVerifiedAddsDetectsThrowingCredit() {
  const inv = mockInv({ 995: 100 });
  assert.equal(verifiedAdds(inv, 995, 50), true, "real credit verifies");
  assert.equal(inv._map.get("995"), 150);
  const broken = mockInv({ 995: 100 });
  broken.adds = () => {
    throw new Error("engine add throws");
  };
  assert.equal(verifiedAdds(broken, 995, 50), false, "throwing credit fails verification");
  assert.equal(broken._map.get("995"), 100, "nothing landed");
}

const tests = [
  testNoIntentsNoBend,
  testWorkIntentSkipsMarket,
  testSocialPullBlocksSkip,
  testNearDoneExtendsWork,
  testFreshGrindWorksLate,
  testSteadyProgressNoBend,
  testMaxBendsPerDay,
  testMealNeverBent,
  testDayOffUntouched,
  testBendIdempotent,
  testExtendClampedToNextLeg,
  testBrokenIntentReadsDontBreakRoutine,
  testHaulPriceIsRealReferencePrice,
  testSellItemsHappyPath,
  testSellItemsBuyerCannotCover,
  testSellItemsItemCreditFailureRestoresSeller,
  testSellItemsCoinCreditFailureRollsBack,
  testVerifiedAddsDetectsThrowingCredit,
];

let pass = 0;
for (const t of tests) {
  try {
    t();
    pass += 1;
    console.log(`PASS: ${t.name}`);
  } catch (error) {
    console.error(`FAIL: ${t.name}: ${error.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${tests.length} CitizenRoutine goal-threading tests passed.`);
