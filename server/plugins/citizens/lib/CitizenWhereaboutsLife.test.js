"use strict";

/**
 * CitizenWhereaboutsLife.test — data-tier want-driven movement (slice 1).
 * Plain node: `node lib/CitizenWhereaboutsLife.test.js` from the citizens dir.
 */

const assert = require("assert");
const { tickWhereabouts } = require("./CitizenWhereaboutsLife");

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
