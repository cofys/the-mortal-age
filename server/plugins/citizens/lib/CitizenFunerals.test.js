"use strict";
// CitizenFunerals unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const F = require("./CitizenFunerals");

F.resetForTests();

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rng = lcg(1234);

// --- mortalityChanceFor ---
{
  const young = { personality: { age: 30 }, role: "merchant" };
  const elder = { personality: { age: 78 }, role: "merchant" };
  const venerable = { personality: { age: 90 }, role: "merchant" };
  const guard = { personality: { age: 30 }, role: "guard" };
  const pYoung = F.mortalityChanceFor(young);
  const pElder = F.mortalityChanceFor(elder);
  const pVenerable = F.mortalityChanceFor(venerable);
  const pGuard = F.mortalityChanceFor(guard);
  assert.ok(pYoung > 0, "everyone has a nonzero accident chance");
  assert.ok(pElder > pYoung, "elders die more than the young");
  assert.ok(pVenerable > pElder, "the venerable die more than mere elders");
  assert.ok(pGuard > pYoung, "guards risk battle death");
  // Sanity: deaths per week across ~170 citizens should be small single digits.
  const perWeek = 170 * pElder * 0.1 * 10080 + 170 * pYoung * 0.9 * 10080;
  assert.ok(perWeek < 10, `death rate sane (${perWeek.toFixed(2)}/week), not a plague`);
}

// --- causeOfDeath ---
{
  const elder = { personality: { age: 80 }, role: "commoner" };
  const erng = lcg(777);
  const causes = new Set();
  for (let i = 0; i < 50; i++) causes.add(F.causeOfDeath(erng, elder));
  assert.ok(causes.size > 1, "elder causes vary");
  const guard = { personality: { age: 30 }, role: "guard" };
  const grng = lcg(4242);
  const gcauses = new Set();
  for (let i = 0; i < 50; i++) gcauses.add(F.causeOfDeath(grng, guard));
  assert.ok([...gcauses].some((c) => /battle|wounds|gate/i.test(c)), "guards can fall in battle");
}

// --- eulogyFor ---
{
  const d = { display: "Marta", role: "merchant", age: 72, cause: "passed peacefully in their sleep", legacy: ["built the finest stall in the market"] };
  const line = F.eulogyFor(rng, d, "Old Tom");
  assert.ok(line.includes("Marta"), "eulogy names the deceased");
  assert.ok(line.includes("Old Tom"), "eulogy names the eulogist");
  assert.ok(line.includes("passed peacefully in their sleep"), "eulogy states the cause");
  assert.ok(line.length <= 400, "eulogy is a speakable length");
}

// --- griefLineFor ---
{
  const d = { display: "Marta" };
  const near = F.griefLineFor(rng, d, false);
  const close = F.griefLineFor(rng, d, true);
  assert.ok(near.includes("Marta"), "grief line names the dead");
  assert.ok(close.includes("Marta"), "close grief line names the dead");
  assert.notEqual(near, close, "close grief hits harder than casual grief");
}

// --- memorial / remembrance / thanks ---
{
  const d = { display: "Marta", cause: "drowned in the river", legacy: ["taught half the town to swim"] };
  assert.ok(F.memorialLineFor(rng, d).includes("Marta"), "memorial line names the dead");
  const rem = F.remembranceLineFor(rng, d);
  assert.ok(rem.includes("Marta"), "remembrance names the dead");
  assert.ok(F.thanksLineFor(rng, d).includes("Marta"), "thanks names the dead");
}

// --- shouldFire ---
{
  const now = 10_000_000;
  assert.equal(F.shouldFire(rng, now - 1000, now, 3600 * 1000, 1.0), false, "cooldown blocks");
  assert.equal(F.shouldFire(rng, now - 4000 * 1000, now, 3600 * 1000, 1.0), true, "expired cooldown + p=1 fires");
  assert.equal(F.shouldFire(rng, now - 4000 * 1000, now, 3600 * 1000, 0.0), false, "p=0 never fires");
}

// --- isRealPlayer / withinTiles ---
{
  assert.equal(F.isRealPlayer(null), false, "null is not a player");
  assert.equal(F.isRealPlayer({ isPlayerBot: () => true }), false, "bots are not real");
  assert.equal(F.isRealPlayer({ getHostAddress: () => "bot" }), false, "bot host is not real");
  assert.equal(F.isRealPlayer({ getUsername: () => "Jon" }), true, "username getter is real");
  const loc = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(F.withinTiles(loc(0, 0, 0), loc(5, 5, 0), 14), true, "nearby counts");
  assert.equal(F.withinTiles(loc(0, 0, 0), loc(50, 0, 0), 14), false, "far does not count");
  assert.equal(F.withinTiles(loc(0, 0, 0), loc(5, 5, 1), 14), false, "other plane does not count");
}

// --- isMourning / griefOf ---
{
  assert.equal(F.isMourning("nobody", Date.now()), false, "strangers do not mourn");
  assert.equal(F.griefOf("nobody", Date.now()), null, "no grief record for strangers");
}

// --- isDeceased / getDeceased start empty ---
{
  assert.equal(F.isDeceased("Marta"), false, "nobody dead yet");
  assert.deepEqual(F.getDeceased(), [], "registry starts empty");
}

// --- recordDeath: full lifecycle on a mock director ---
{
  const removed = [];
  const journaled = [];
  const director = {
    roster: new Map([
      ["marta", { username: "marta", display: "Marta", role: "merchant", kingdomId: "asgarnia", personality: { age: 80 }, home: { x: 1, y: 2, z: 0 } }],
      ["tom", { username: "tom", display: "Old Tom", role: "commoner", kingdomId: "asgarnia", personality: { age: 60 }, home: { x: 3, y: 4, z: 0 } }],
    ]),
    removeCitizen: (u) => { removed.push(u); director.roster.delete(u.toLowerCase()); return true; },
  };
  const rec = director.roster.get("marta");
  const d = F.recordDeath(director, rec, "passed peacefully in their sleep", 2_000_000);
  assert.ok(d, "recordDeath returns a record");
  assert.equal(d.display, "Marta", "snapshot keeps the display name");
  assert.equal(d.cause, "passed peacefully in their sleep", "cause recorded");
  assert.equal(d.funeralHeld, false, "funeral not yet held");
  assert.ok(d.funeralAt > 2_000_000, "funeral scheduled in the future");
  assert.ok(removed.includes("marta"), "citizen removed via director cleanup");
  assert.equal(F.isDeceased("marta"), true, "deceased registry updated");
  assert.equal(F.isDeceased("MARTA"), true, "deceased lookup is case-insensitive");
  assert.equal(F.getDeceased().length, 1, "one death recorded");
  assert.equal(F.getDeceased()[0].display, "Marta", "getDeceased returns newest first");
  void journaled;
}

// --- tickMortality: funerals come due data-tier ---
{
  F.resetForTests();
  const director = {
    roster: new Map([
      ["marta", { username: "marta", display: "Marta", role: "merchant", kingdomId: "asgarnia", personality: { age: 80 }, home: { x: 1, y: 2, z: 0 } }],
    ]),
    removeCitizen: (u) => { director.roster.delete(u.toLowerCase()); return true; },
  };
  // Force a death by injecting directly, then run the tick past the funeral time.
  const rec = director.roster.get("marta");
  const d = F.recordDeath(director, rec, "drowned in the river", 1_000_000);
  assert.equal(d.funeralHeld, false, "funeral pending right after death");
  F.tickMortality(director, 1_000_000 + 25 * 3600 * 1000, lcg(7)); // >24h later
  const after = F.getDeceased().find((x) => x.username === "marta");
  assert.equal(after.funeralHeld, true, "funeral held data-tier when due");
  assert.ok(after.funeralHeldAt > 1_000_000, "funeral timestamp recorded");
}

// --- tickMortality never throws on an empty/broken director ---
{
  F.resetForTests();
  assert.doesNotThrow(() => F.tickMortality({}, Date.now(), lcg(1)), "empty director is safe");
  assert.doesNotThrow(() => F.tickMortality(null, Date.now(), lcg(1)), "null director is safe");
  assert.doesNotThrow(() => F.tickFuneralRites({}, Date.now(), null, lcg(1)), "empty rites tick is safe");
}

// --- persistence round-trip ---
{
  F.resetForTests();
  const director = {
    roster: new Map([
      ["marta", { username: "marta", display: "Marta", role: "merchant", kingdomId: "asgarnia", personality: { age: 80 }, home: { x: 1, y: 2, z: 0 } }],
    ]),
    removeCitizen: (u) => { director.roster.delete(u.toLowerCase()); return true; },
  };
  F.recordDeath(director, director.roster.get("marta"), "passed peacefully in their sleep", 3_000_000);
  assert.equal(F.saveIfDirty(), true, "dirty save writes");
  assert.equal(F.saveIfDirty(), false, "clean save is a no-op");
}

console.log("CitizenFunerals: all assertions passed");
