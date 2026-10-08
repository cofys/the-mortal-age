"use strict";

// CitizenGiftGiving unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  occasionFor,
  pickGift,
  poolFor,
  fillLine,
  ceremonyLine,
  birthdayDayOfYear,
  dayOfYear,
  isBirthdayToday,
  giftAllowed,
  recordGift,
  toneToward,
  countRecentMoments,
  giveGift,
  GIFT_POOLS,
  OCC_BIRTHDAY,
  OCC_THANKYOU,
  OCC_RECIPROCITY,
  OCC_FESTIVAL,
  OCC_SPONTANEOUS,
  _test,
} = require("./CitizenGiftGiving");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeMemory(momentsByPair = {}, tones = {}) {
  return {
    getEntry(c, p) {
      const key = `${c}\u0000${p}`;
      return { tone: tones[key] ?? 0, moments: momentsByPair[key] ?? [] };
    },
  };
}

const baseDeps = () => ({
  nowMs: Date.now(),
  memory: makeMemory(),
  rng: lcg(42),
  birthdayGiftYears: new Map(),
  festivalGifted: new Map(),
  activeFestival: () => null,
  recentDoneFavor: () => null,
});

// 1. Birthday detection is deterministic and in range.
{
  const d1 = birthdayDayOfYear("Aldric Stone");
  const d2 = birthdayDayOfYear("Aldric Stone");
  assert.equal(d1, d2, "birthday day-of-year is stable");
  assert.ok(d1 >= 1 && d1 <= 366, "in valid day range");
  const spread = new Set();
  for (let i = 0; i < 50; i++) spread.add(birthdayDayOfYear(`Citizen${i}`));
  assert.ok(spread.size > 20, "birthdays spread across the year");
}

// 2. dayOfYear matches known dates.
{
  assert.equal(dayOfYear(new Date(2026, 0, 1)), 1);
  assert.equal(dayOfYear(new Date(2026, 11, 31)), 365);
}

// 3. Birthday occasion fires once per year.
{
  const record = { username: "BirthdayBob" };
  // Find a date that IS Bob's birthday: brute force from Jan 1.
  let bday = null;
  for (let m = 0; m < 12 && !bday; m++) {
    for (let d = 1; d <= 31 && !bday; d++) {
      const dt = new Date(2026, m, d);
      if (isBirthdayToday("BirthdayBob", dt)) bday = dt;
    }
  }
  assert.ok(bday, "found Bob's birthday");
  const deps = baseDeps();
  const occ = occasionFor(record, "PlayerOne", bday, deps);
  assert.equal(occ?.occasion, OCC_BIRTHDAY, "birthday occasion fires");
  // Mark gifted this year; second call should not re-fire birthday.
  deps.birthdayGiftYears.set("BirthdayBob", 2026);
  const occ2 = occasionFor(record, "PlayerOne", bday, deps);
  assert.ok(occ2?.occasion !== OCC_BIRTHDAY, "birthday fires once per year");
}

// 4. Thank-you occasion wins over festival/spontaneous and carries favor id.
{
  const deps = baseDeps();
  deps.recentDoneFavor = () => "favor-123";
  deps.activeFestival = () => ({ id: "embernight", name: "Embernight" });
  const occ = occasionFor({ username: "ThanksTess" }, "PlayerOne", new Date(2026, 5, 5), deps);
  assert.equal(occ?.occasion, OCC_THANKYOU, "thankyou outranks festival");
  assert.equal(occ?.detail, "favor-123", "favor id carried through");
}

// 5. Reciprocity: player gave more than citizen gave back.
{
  const now = Date.now();
  const memory = makeMemory({
    "ReciRae\u0000PlayerOne": [
      { kind: "gift", at: now - 1000, text: "gave me 5x logs" },
      { kind: "gift", at: now - 2000, text: "gave me 50 coins" },
    ],
  });
  const deps = baseDeps();
  deps.memory = memory;
  const occ = occasionFor({ username: "ReciRae" }, "PlayerOne", new Date(2026, 5, 5), deps);
  assert.equal(occ?.occasion, OCC_RECIPROCITY, "reciprocity fires when player gave first");

  // Citizen already reciprocated → no reciprocity.
  const memory2 = makeMemory({
    "ReciRae\u0000PlayerOne": [
      { kind: "gift", at: now - 1000, text: "gave me 5x logs" },
      { kind: "gifted", at: now - 500, text: "Gave PlayerOne 3x iron ore (reciprocity)." },
    ],
  });
  const deps2 = baseDeps();
  deps2.memory = memory2;
  const occ2 = occasionFor({ username: "ReciRae" }, "PlayerOne", new Date(2026, 5, 5), deps2);
  assert.ok(occ2?.occasion !== OCC_RECIPROCITY, "no reciprocity when debt settled");
}

// 6. Festival occasion fires once per festival per pair.
{
  const deps = baseDeps();
  deps.activeFestival = () => ({ id: "harvest-home", name: "Harvest Home" });
  const occ = occasionFor({ username: "FestFay" }, "PlayerOne", new Date(2026, 9, 8), deps);
  assert.equal(occ?.occasion, OCC_FESTIVAL, "festival occasion fires");
  deps.festivalGifted.set("FestFay\u0000PlayerOne\u0000harvest-home", Date.now());
  const occ2 = occasionFor({ username: "FestFay" }, "PlayerOne", new Date(2026, 9, 8), deps);
  assert.ok(occ2?.occasion !== OCC_FESTIVAL, "festival gift fires once per festival");
}

// 7. Spontaneous: needs fondness; cold citizens stay quiet.
{
  const fond = makeMemory({}, { "FondFred\u0000PlayerOne": 5 });
  const deps = baseDeps();
  deps.memory = fond;
  deps.rng = () => 0.0; // always under chance
  const occ = occasionFor({ username: "FondFred" }, "PlayerOne", new Date(2026, 5, 5), deps);
  assert.equal(occ?.occasion, OCC_SPONTANEOUS, "fond citizen is spontaneously generous");

  const cold = makeMemory({}, { "ColdCarl\u0000PlayerOne": -2 });
  const deps2 = baseDeps();
  deps2.memory = cold;
  deps2.rng = () => 0.0;
  const occ2 = occasionFor({ username: "ColdCarl" }, "PlayerOne", new Date(2026, 5, 5), deps2);
  assert.equal(occ2, null, "cold citizen gives nothing spontaneously");
}

// 8. Occasion priority: birthday > thankyou > reciprocity > festival > spontaneous.
{
  const now = Date.now();
  const memory = makeMemory(
    { "PriPam\u0000PlayerOne": [{ kind: "gift", at: now - 1000, text: "gave me coal" }] },
    { "PriPam\u0000PlayerOne": 8 }
  );
  // Find Pam's birthday.
  let bday = null;
  for (let m = 0; m < 12 && !bday; m++) {
    for (let d = 1; d <= 31 && !bday; d++) {
      const dt = new Date(2026, m, d);
      if (isBirthdayToday("PriPam", dt)) bday = dt;
    }
  }
  const deps = baseDeps();
  deps.memory = memory;
  deps.rng = () => 0.0;
  deps.recentDoneFavor = () => "favor-9";
  deps.activeFestival = () => ({ id: "midsummer", name: "Midsummer Revel" });
  const occ = occasionFor({ username: "PriPam" }, "PlayerOne", bday, deps);
  assert.equal(occ?.occasion, OCC_BIRTHDAY, "birthday is top priority");
}

// 9. poolFor maps personality to gift pool.
{
  assert.equal(poolFor({ personality: { traits: ["cheerful"] } }), "sentimental");
  assert.equal(poolFor({ personality: { traits: ["gruff"] } }), "practical");
  assert.equal(poolFor({ personality: { traits: ["methodical"] } }), "practical");
  assert.equal(poolFor({ role: "merchant", personality: { traits: [] } }), "generous");
  assert.equal(poolFor({}), "practical", "missing personality defaults practical");
}

// 10. pickGift respects pool catalog and qty bounds.
{
  const rng = lcg(7);
  for (let i = 0; i < 20; i++) {
    const g = pickGift(rng, "practical");
    const entry = GIFT_POOLS.practical.find((e) => e.id === g.id);
    assert.ok(entry, "gift id comes from the pool catalog");
    assert.ok(g.qty >= entry.qty[0] && g.qty <= entry.qty[1], "qty within catalog bounds");
    assert.ok(g.value <= 500, "gift value bounded");
  }
}

// 11. Ceremony lines template correctly.
{
  const line = ceremonyLine(lcg(3), OCC_BIRTHDAY, { name: "Jon", gift: "5x logs" });
  assert.ok(line.includes("Jon"), "name interpolated");
  assert.ok(line.includes("5x logs"), "gift interpolated");
  assert.ok(!line.includes("{name}"), "no leftover placeholders");
  assert.equal(fillLine("Hi {name}, {gift}!", { name: "A", gift: "B" }), "Hi A, B!");
}

// 12. giftAllowed gates: citizen cooldown + pair window.
{
  _test.resetForTests();
  const now = Date.now();
  assert.ok(giftAllowed("GiverGus", "PlayerOne", now), "first gift allowed");
  recordGift("GiverGus", "PlayerOne", now);
  assert.ok(!giftAllowed("GiverGus", "PlayerOne", now), "pair window blocks repeat");
  assert.ok(!giftAllowed("GiverGus", "PlayerTwo", now), "citizen cooldown blocks others");
  assert.ok(giftAllowed("OtherOtis", "PlayerOne", now), "other citizens unaffected");
}

// 13. toneToward / countRecentMoments read memory safely.
{
  const memory = makeMemory(
    { "ToneTina\u0000PlayerOne": [{ kind: "gift", at: Date.now(), text: "x" }] },
    { "ToneTina\u0000PlayerOne": 4 }
  );
  assert.equal(toneToward("ToneTina", "PlayerOne", memory), 4);
  assert.equal(countRecentMoments("ToneTina", "PlayerOne", "gift", 100000, memory, Date.now()), 1);
  assert.equal(toneToward("Nobody", "Nobody", makeMemory()), 0, "missing pair → 0");
}

// 14. giveGift moves the item, speaks, and books occasion state.
{
  const added = [];
  const chats = [];
  const msgs = [];
  const player = {
    getUsername: () => "PlayerOne",
    getInventory: () => ({
      getFreeSlots: () => 10,
      getAmount: () => 0,
      adds: (id, qty) => added.push([id, qty]),
    }),
    sendMessage: (m) => msgs.push(m),
  };
  const citizen = { forceChat: (l) => chats.push(l) };
  const record = { username: "GiverGus" };

  // Stub memory + journal via require cache? No — giveGift calls the real
  // singletons, which are defensive no-ops without a server. Just verify transfer.
  const ok = giveGift(citizen, player, record, OCC_SPONTANEOUS, { id: 995, name: "coins", qty: 75, value: 75 }, {}, Date.now());
  assert.equal(ok, true, "gift landed");
  assert.deepEqual(added, [[995, 75]], "coins added to player inventory");
  assert.ok(chats.length === 1 && chats[0].length <= 120, "ceremony line spoken, capped");
  assert.ok(msgs[0].includes("GiverGus gives you"), "player notified");
}

// 15. giveGift refuses when the player's hands are full (non-stacking goods).
{
  const added = [];
  const player = {
    getUsername: () => "PlayerOne",
    getInventory: () => ({
      getFreeSlots: () => 0,
      getAmount: () => 0,
      adds: (id, qty) => added.push([id, qty]),
    }),
    sendMessage: () => {},
  };
  const citizen = { forceChat: () => {} };
  const ok = giveGift(
    citizen, player, { username: "GiverGus" }, OCC_SPONTANEOUS,
    { id: 1511, name: "logs", qty: 5, value: 75 }, {}, Date.now()
  );
  assert.equal(ok, false, "no gift when inventory full");
  assert.equal(added.length, 0, "nothing moved");
}

// 16. giveGift enforces the value ceiling.
{
  const player = {
    getUsername: () => "PlayerOne",
    getInventory: () => ({ adds: () => { throw new Error("should not move"); } }),
    sendMessage: () => {},
  };
  const ok = giveGift(
    { forceChat: () => {} }, player, { username: "GiverGus" }, OCC_SPONTANEOUS,
    { id: 995, name: "coins", qty: 999999, value: 999999 }, {}, Date.now()
  );
  assert.equal(ok, false, "over-value gift refused");
}

// 17. Catalog sanity: every pool has entries, ids are engine-known.
{
  const known = new Set([995, 1511, 317, 436, 438, 440, 453, 526]);
  for (const [poolName, pool] of Object.entries(GIFT_POOLS)) {
    assert.ok(pool.length >= 2, `${poolName} pool non-trivial`);
    for (const e of pool) {
      assert.ok(known.has(e.id), `${poolName} uses known item id ${e.id}`);
      assert.ok(e.value * e.qty[1] <= 500, `${poolName}/${e.name} max value bounded`);
    }
  }
}

console.log("CitizenGiftGiving: all assertions passed");
