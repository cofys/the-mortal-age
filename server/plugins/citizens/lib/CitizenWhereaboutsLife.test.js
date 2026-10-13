"use strict";

/**
 * CitizenWhereaboutsLife.test — data-tier want-driven movement (slice 1).
 * Plain node: `node lib/CitizenWhereaboutsLife.test.js` from the citizens dir.
 */

const assert = require("assert");
const {
  tickWhereabouts,
  applyRelocation,
  visitLengthFor,
  visitExpired,
  VISIT_MIN_MS,
  VISIT_MAX_MS,
} = require("./CitizenWhereaboutsLife");

// A slow-tick timestamp at 14:00 local — nobody is asleep (sleepStart 22).
const NOW = new Date(2026, 9, 13, 14, 0, 0).getTime();

function fakeDirector(records, isOnline = () => false) {
  const roster = new Map();
  for (const r of records) {
    if (r && r.username) roster.set(r.username.toLowerCase(), r);
  }
  return { roster, isOnline };
}

function baseRecord(name, overrides = {}) {
  return {
    username: name,
    role: "commoner",
    goal: { type: "save_gold", target: 10000, progress: 0 },
    personality: { traits: [] },
    home: { x: 3200, y: 3200, z: 0 },
    position: { x: 3200, y: 3200, z: 0 },
    sleepStart: 22,
    sleepHours: 7,
    ...overrides,
  };
}

// 1. Offline citizen gets a destination and moves toward it.
// (Nearby destinations settle in the same tick — a player who wants to be
//  next door is just there. Either outcome proves the tick acted.)
{
  const rec = baseRecord("Walker1");
  tickWhereabouts(fakeDirector([rec]), NOW);
  const acted =
    (rec.dest && Number.isFinite(rec.dest.x)) ||
    rec.position.x !== 3200 ||
    rec.position.y !== 3200;
  assert(acted, "citizen neither picked a dest nor moved");
  console.log("ok 1 — destination picked, citizen advances");
}

// 2. Arrival settles: dest cleared, position at a personal spot near dest.
// (dest is 50 tiles out: not "arrived" yet, inside one tick's walk range.)
{
  const rec = baseRecord("Walker2");
  rec.dest = { x: 3250, y: 3200, z: 0, placeId: "test:square", kind: "square", reason: "test" };
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert.strictEqual(rec.dest, null, "dest not cleared on arrival");
  const d = Math.max(Math.abs(rec.position.x - 3250), Math.abs(rec.position.y - 3200));
  assert(d <= 10, `settled too far: ${d}`);
  console.log("ok 2 — arrival settles with destack jitter");
}

// 3. Long hauls interpolate over multiple ticks (en-route, on the road).
{
  const rec = baseRecord("Walker3");
  rec.dest = { x: 3200 + 900, y: 3200, z: 0, placeId: "far:away", kind: "square", reason: "test" };
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert(rec.enRoute, "long haul did not go en-route");
  assert(rec.enRoute.arriveAt > NOW, "arrival not in the future");
  const x0 = rec.position.x;
  // 5 minutes later: partway there, dest kept, not arrived.
  tickWhereabouts(fakeDirector([rec]), NOW + 5 * 60 * 1000);
  assert(rec.position.x > x0, "en-route citizen did not advance");
  assert(rec.dest, "dest lost mid-route");
  assert(rec.position.x < 3200 + 900, "teleported instead of interpolating");
  console.log("ok 3 — long hauls interpolate (road presence)");
}

// 4. Online citizens are untouched (live engine owns them).
{
  const rec = baseRecord("Walker4");
  tickWhereabouts(fakeDirector([rec], () => true), NOW);
  assert.strictEqual(rec.dest, undefined, "online citizen got a dest");
  assert.deepStrictEqual(rec.position, { x: 3200, y: 3200, z: 0 }, "online position moved");
  console.log("ok 4 — online citizens skipped");
}

// 5. Sleeping citizens stay put.
{
  const rec = baseRecord("Walker5", { sleepStart: 13, sleepHours: 8 }); // asleep at 14:00
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert.strictEqual(rec.dest, undefined, "sleeping citizen got a dest");
  console.log("ok 5 — sleeping citizens skipped");
}

// 6. Caravan duty citizens are untouched.
{
  const rec = baseRecord("Walker6", { caravanDuty: true });
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert.strictEqual(rec.dest, undefined, "caravan citizen got a dest");
  console.log("ok 6 — caravan duty skipped");
}

// 7. Missing position is repaired from home, not crashed on.
{
  const rec = baseRecord("Walker7");
  delete rec.position;
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert(rec.position && Number.isFinite(rec.position.x), "position not repaired");
  console.log("ok 7 — missing position repaired from home");
}

// 8. A broken record never stalls the roster.
{
  const good = baseRecord("Walker8");
  const bad = null;
  tickWhereabouts(fakeDirector([good, bad]), NOW);
  const acted =
    (good.dest && Number.isFinite(good.dest.x)) ||
    good.position.x !== 3200 ||
    good.position.y !== 3200;
  assert(acted, "good record stalled by bad record");
  console.log("ok 8 — per-record guards hold");
}

// 9. Hurt citizens head home (needs drive the picker).
// (Position starts far from home so the home dest survives the tick.)
{
  const rec = baseRecord("Walker9", { position: { x: 3500, y: 3500, z: 0 } });
  // Force low HP via the needs store: ensureNeeds + damage the record.
  const { ensureNeeds } = require("../brain/CitizenNeeds");
  const needs = ensureNeeds("Walker9");
  needs.hp = 10;
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert(rec.dest && rec.dest.placeId === "home", `hurt citizen not sent home: ${JSON.stringify(rec.dest)}`);
  console.log("ok 9 — hurt citizens head home");
}

// 10. Arrival stamps record.arrived for slice-2 brain seeding (kind + tile
// + time), and the stamp is consumed where the citizen settled.
{
  const rec = baseRecord("Walker10");
  rec.dest = { x: 3250, y: 3200, z: 0, placeId: "test:tree-1", kind: "tree", reason: "test" };
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert(rec.arrived, "arrival marker not stamped on settle");
  assert.strictEqual(rec.arrived.kind, "tree", `wrong kind: ${rec.arrived.kind}`);
  assert.strictEqual(rec.arrived.placeId, "test:tree-1", `wrong placeId: ${rec.arrived.placeId}`);
  assert.strictEqual(rec.arrived.z, 0, "wrong plane on stamp");
  assert(
    Number.isFinite(rec.arrived.at) && Math.abs(rec.arrived.at - NOW) < 60000,
    `bad stamp time: ${rec.arrived.at}`
  );
  const d = Math.max(
    Math.abs(rec.arrived.x - rec.position.x),
    Math.abs(rec.arrived.y - rec.position.y)
  );
  assert.strictEqual(d, 0, "stamp tile != settled tile");
  console.log("ok 10 — arrival stamps record.arrived on settle");
}

console.log("CitizenWhereaboutsLife.test: all passed");

// --- slice 3: inter-kingdom visits -----------------------------------------
// (appended after the pass line so the numbered slice-1/2 cases above stay
// stable; these run as a second block in the same file.)

function visitRecord(name, overrides = {}) {
  return baseRecord(name, {
    kingdomId: "asgarnia",
    townId: null,
    settlementId: null,
    position: { x: 5000, y: 5000, z: 0 },
    home: { x: 3000, y: 3400, z: 0 },
    ...overrides,
  });
}

// A. Settling cross-kingdom stamps record.visit (visiting, not moving).
{
  const rec = visitRecord("Visitor1");
  rec.dest = {
    x: 5050, y: 5000, z: 0, placeId: "kandarin:square", kind: "square",
    reason: "test", kingdomId: "kandarin", townId: null, settlementId: null,
  };
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert(rec.visit, "cross-kingdom settle did not stamp a visit");
  assert.strictEqual(rec.visit.kingdomId, "kandarin", `wrong visit kingdom: ${rec.visit.kingdomId}`);
  assert.strictEqual(rec.kingdomId, "asgarnia", "visit must NOT flip kingdomId");
  assert(
    rec.visit.len >= VISIT_MIN_MS && rec.visit.len <= VISIT_MAX_MS,
    `visit len out of range: ${rec.visit.len}`
  );
  assert(Math.abs(rec.visit.since - NOW) < 60000, "visit since not stamped");
  console.log("ok A — cross-kingdom settle stamps a visit, keeps kingdomId");
}

// B. Settling on home turf clears any visit.
{
  const rec = visitRecord("Visitor2", {
    position: { x: 3020, y: 3400, z: 0 },
    visit: { kingdomId: "kandarin", since: NOW - 3600000, len: 8 * 3600000 },
  });
  rec.dest = {
    x: 3005, y: 3405, z: 0, placeId: "home", kind: "home",
    reason: "test", kingdomId: "asgarnia", townId: null, settlementId: null,
  };
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert.strictEqual(rec.visit, null, "coming home did not clear the visit");
  console.log("ok B — settling home clears the visit");
}

// C. Matured visit + settling goal -> relocation (fallback path: bare
// director without relocateCitizen flips the record fields directly).
{
  const rec = visitRecord("Mover1", {
    visit: {
      kingdomId: "kandarin", townId: "catherby", settlementId: null,
      placeId: "catherby:square", x: 5000, y: 5000, z: 0,
      since: NOW - 9 * 3600000, len: 8 * 3600000,
    },
  });
  rec.dest = null;
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert.strictEqual(rec.visit, null, "visit not cleared on relocation");
  assert.strictEqual(rec.kingdomId, "kandarin", `kingdom not flipped: ${rec.kingdomId}`);
  assert.strictEqual(rec.townId, "catherby", `town not flipped: ${rec.townId}`);
  assert.deepStrictEqual(rec.home, { x: 5000, y: 5000, z: 0 }, `home not re-anchored: ${JSON.stringify(rec.home)}`);
  console.log("ok C — matured visit + save_gold relocates (fallback flip)");
}

// D. Matured visit + non-settling goal -> trip home, no relocation.
{
  const rec = visitRecord("Tripper1", {
    goal: { type: "boss_slayer", target: 1, progress: 0 },
    visit: {
      kingdomId: "kandarin", townId: null, settlementId: null,
      placeId: "kandarin:square", x: 5000, y: 5000, z: 0,
      since: NOW - 9 * 3600000, len: 8 * 3600000,
    },
  });
  rec.dest = null;
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert.strictEqual(rec.visit, null, "visit not cleared on trip home");
  assert.strictEqual(rec.kingdomId, "asgarnia", "non-settling goal must NOT relocate");
  assert(rec.dest && rec.dest.placeId === "home", `not headed home: ${JSON.stringify(rec.dest)}`);
  console.log("ok D — matured visit + boss_slayer heads home");
}

// E. Expired visit mid en-route: left alone, matures on arrival.
{
  const rec = visitRecord("Midway1", {
    position: { x: 4000, y: 4200, z: 0 },
    dest: {
      x: 5050, y: 5000, z: 0, placeId: "kandarin:square", kind: "square",
      reason: "test", kingdomId: "kandarin", townId: null, settlementId: null,
    },
    enRoute: {
      from: { x: 3000, y: 3400, z: 0 },
      to: { x: 5050, y: 5000, z: 0 },
      departAt: NOW - 60000,
      arriveAt: NOW + 3600000,
    },
    visit: {
      kingdomId: "kandarin", townId: null, settlementId: null,
      placeId: "kandarin:square", x: 5050, y: 5000, z: 0,
      since: NOW - 9 * 3600000, len: 8 * 3600000,
    },
  });
  const destBefore = rec.dest;
  tickWhereabouts(fakeDirector([rec]), NOW);
  assert(rec.visit, "mid-route visit was matured early");
  assert.strictEqual(rec.dest, destBefore, "mid-route dest was yanked");
  assert.strictEqual(rec.kingdomId, "asgarnia", "mid-route citizen relocated early");
  console.log("ok E — expired visit mid-route is left alone");
}

// F. A director offering relocateCitizen gets the call with the placement.
{
  const rec = visitRecord("Mover2", {
    visit: {
      kingdomId: "kandarin", townId: null, settlementId: null,
      placeId: "kandarin:square", x: 5000, y: 5000, z: 0,
      since: NOW - 9 * 3600000, len: 8 * 3600000,
    },
  });
  rec.dest = null;
  const calls = [];
  const director = fakeDirector([rec]);
  director.relocateCitizen = (username, placement) => {
    calls.push({ username, placement });
    // mimic the real method: flip the fields
    rec.kingdomId = placement.kingdomId;
    rec.townId = placement.townId;
    rec.settlementId = placement.settlementId;
    rec.home = placement.home;
    return true;
  };
  tickWhereabouts(director, NOW);
  assert.strictEqual(calls.length, 1, `relocateCitizen not called once: ${calls.length}`);
  assert.strictEqual(calls[0].username, "Mover2", "wrong username passed");
  assert.strictEqual(calls[0].placement.kingdomId, "kandarin", "wrong placement");
  assert.deepStrictEqual(calls[0].placement.home, { x: 5000, y: 5000, z: 0 },
    "placement home not the visit tile");
  console.log("ok F — director.relocateCitizen receives the placement");
}

// G. visitLengthFor: deterministic per citizen per visit, inside 2–8h.
{
  const a = visitLengthFor("Lenny", 1111);
  const b = visitLengthFor("Lenny", 1111);
  const c = visitLengthFor("Lenny", 2222);
  assert.strictEqual(a, b, "same visit must give the same length");
  assert(a >= VISIT_MIN_MS && a <= VISIT_MAX_MS, `out of range: ${a}`);
  assert(c >= VISIT_MIN_MS && c <= VISIT_MAX_MS, `out of range: ${c}`);
  console.log(`ok G — deterministic visit length (${Math.round(a / 3600000 * 10) / 10}h)`);
}

// H. visitExpired boundaries.
{
  const v = { kingdomId: "k", since: NOW - 1000, len: 2000 };
  assert.strictEqual(visitExpired({ visit: v }, NOW), false, "1s in must not be expired");
  assert.strictEqual(visitExpired({ visit: v }, NOW + 1500), true, "past len must be expired");
  assert.strictEqual(visitExpired({}, NOW), false, "no visit must not be expired");
  console.log("ok H — visitExpired boundaries");
}

// I. applyRelocation: pure field flip.
{
  const rec = { username: "Pure", kingdomId: "a", townId: "t", settlementId: null, home: { x: 1, y: 2, z: 0 } };
  assert.strictEqual(
    applyRelocation(rec, { kingdomId: "b", townId: null, settlementId: "s", home: { x: 9, y: 9, z: 0 } }),
    true, "applyRelocation must return true"
  );
  assert.strictEqual(rec.kingdomId, "b");
  assert.strictEqual(rec.townId, null);
  assert.strictEqual(rec.settlementId, "s");
  assert.deepStrictEqual(rec.home, { x: 9, y: 9, z: 0 });
  assert.strictEqual(applyRelocation(rec, null), false, "null placement must fail");
  console.log("ok I — applyRelocation flips fields");
}

console.log("CitizenWhereaboutsLife.test (slice 3): all passed");
