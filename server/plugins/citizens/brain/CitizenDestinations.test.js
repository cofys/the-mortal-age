"use strict";

/**
 * CitizenDestinations.test — want-driven destination selection (slice 1).
 * Plain node: `node brain/CitizenDestinations.test.js` from the citizens dir.
 */

const assert = require("assert");
const {
  DEST_PLACES,
  pickDestination,
  arrivedAt,
  favoriteGatherKind,
  placementOf,
  activeVisit,
  visitBiasMult,
  VISIT_STAY_MULT,
  VISIT_HOME_DAMP,
} = require("./CitizenDestinations");

function baseRecord(overrides = {}) {
  return {
    username: "Testy McTest",
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

const NOW = 1760400000000; // fixed bucket-stable timestamp

// 1. Candidate set: real tiles only, non-empty.
assert(DEST_PLACES.length > 40, `expected >40 places, got ${DEST_PLACES.length}`);
for (const p of DEST_PLACES) {
  assert(Number.isFinite(p.x) && Number.isFinite(p.y), `bad tile ${p.id}`);
  assert(typeof p.kind === "string" && p.kind.length > 0, `bad kind ${p.id}`);
}
console.log(`ok 1 — ${DEST_PLACES.length} candidate places, all real tiles`);

// 2. Deterministic per citizen per bucket.
const r = baseRecord();
const a = pickDestination(r, NOW);
const b = pickDestination(r, NOW);
assert.deepStrictEqual(a, b, "same citizen+time must pick the same destination");
console.log("ok 2 — deterministic within the sticky bucket");

// 3. Valid destination shape.
for (const key of ["x", "y", "z", "placeId", "kind", "reason"]) {
  assert(a[key] !== undefined && a[key] !== null, `missing ${key}`);
}
assert(Number.isFinite(a.x) && Number.isFinite(a.y), "finite tiles");
console.log("ok 3 — destination shape valid");

// 4. Different citizens diverge (distribution emerges, not one tile).
const kinds = new Set();
for (let i = 0; i < 30; i += 1) {
  const rec = baseRecord({ username: `Divergent${i}` });
  kinds.add(pickDestination(rec, NOW).kind);
}
assert(kinds.size >= 2, `expected variety, got ${[...kinds]}`);
console.log(`ok 4 — population diverges (${[...kinds].join(", ")})`);

// 5. Merchants want markets/squares.
{
  const mk = new Set();
  for (let i = 0; i < 20; i += 1) {
    const rec = baseRecord({ username: `Merchant${i}`, role: "merchant" });
    mk.add(pickDestination(rec, NOW).kind);
  }
  assert(mk.has("market") || mk.has("square"), `merchants off-script: ${[...mk]}`);
  console.log(`ok 5 — merchants head to trade (${[...mk].join(", ")})`);
}

// 6. Achievers grind their favorite gather kind.
{
  const counts = {};
  for (let i = 0; i < 30; i += 1) {
    const rec = baseRecord({
      username: `Grinder${i}`,
      goal: { type: "master_trade", target: 99, progress: 0 },
    });
    const d = pickDestination(rec, NOW);
    counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  }
  const gather = (counts.tree ?? 0) + (counts.rock ?? 0) + (counts.fish ?? 0);
  assert(gather >= 15, `grinders not gathering: ${JSON.stringify(counts)}`);
  console.log(`ok 6 — achievers grind (${JSON.stringify(counts)})`);
}

// 7. Explorers roam farther than homebodies.
{
  let explorerFar = 0;
  let homebodyFar = 0;
  for (let i = 0; i < 20; i += 1) {
    const ex = baseRecord({ username: `Explorer${i}`, personality: { traits: ["daydreamer", "curious"] } });
    const hb = baseRecord({ username: `Homebody${i}`, personality: { traits: ["dutiful"] } });
    const de = pickDestination(ex, NOW);
    const dh = pickDestination(hb, NOW);
    const distE = Math.max(Math.abs(de.x - 3200), Math.abs(de.y - 3200));
    const distH = Math.max(Math.abs(dh.x - 3200), Math.abs(dh.y - 3200));
    if (distE > 150) explorerFar += 1;
    if (distH > 150) homebodyFar += 1;
  }
  assert(explorerFar > homebodyFar, `explorers not roaming: ${explorerFar} vs ${homebodyFar}`);
  console.log(`ok 7 — explorers roam farther (${explorerFar} vs ${homebodyFar} far picks)`);
}

// 8. arrivedAt: radius + plane aware.
{
  const rec = baseRecord();
  const dest = { x: 3210, y: 3200, z: 0 };
  rec.position = { x: 3212, y: 3201, z: 0 };
  assert(arrivedAt(rec, dest, 6) === true, "nearby same-plane = arrived");
  rec.position = { x: 3212, y: 3201, z: 1 };
  assert(arrivedAt(rec, dest, 6) === false, "other plane = not arrived");
  rec.position = { x: 3300, y: 3300, z: 0 };
  assert(arrivedAt(rec, dest, 6) === false, "far = not arrived");
  console.log("ok 8 — arrivedAt radius/plane logic");
}

// 9. favoriteGatherKind is stable per citizen.
{
  const k1 = favoriteGatherKind("StableSam");
  const k2 = favoriteGatherKind("StableSam");
  assert.strictEqual(k1, k2, "favorite must be stable");
  assert(["tree", "rock", "fish"].includes(k1), `bad kind ${k1}`);
  console.log(`ok 9 — stable favorite gather kind (${k1})`);
}

// 10. Missing data degrades to a valid home destination, never throws.
{
  const d = pickDestination({ username: "BarelyThere" }, NOW);
  assert(Number.isFinite(d.x) && Number.isFinite(d.y), "degraded dest invalid");
  console.log("ok 10 — missing-data record degrades gracefully");
}

// --- slice 3: inter-kingdom visit semantics ------------------------------

// 11. Every destination carries its placement (kingdom/town/settlement).
{
  for (let i = 0; i < 40; i += 1) {
    const rec = baseRecord({ username: `Placed${i}` });
    const d = pickDestination(rec, NOW);
    assert("kingdomId" in d && "townId" in d && "settlementId" in d,
      `dest missing placement: ${JSON.stringify(d)}`);
  }
  // The hurt->home path carries the citizen's own placement, not a visit's.
  const { ensureNeeds } = require("./CitizenNeeds");
  ensureNeeds("HurtHedwig").hp = 5;
  const hd = pickDestination(
    baseRecord({ username: "HurtHedwig", kingdomId: "asgarnia", townId: "falador" }),
    NOW
  );
  assert.strictEqual(hd.placeId, "home", "hurt citizen must head home");
  assert.strictEqual(hd.kingdomId, "asgarnia", "home dest must keep home kingdom");
  assert.strictEqual(hd.townId, "falador", "home dest must keep home town");
  console.log("ok 11 — destinations carry kingdomId/townId/settlementId");
}

// 12. placementOf resolves real data: a town place maps to its kingdom.
{
  const townPlace = DEST_PLACES.find((p) => p.townId);
  assert(townPlace, "no town places in the candidate set");
  const place = placementOf(townPlace);
  assert.strictEqual(place.townId, townPlace.townId, "townId passthrough");
  assert(typeof place.kingdomId === "string" && place.kingdomId.length > 0,
    `town ${townPlace.townId} has no kingdom`);
  assert.strictEqual(place.settlementId, null, "town place must not claim a settlement");
  const capPlace = DEST_PLACES.find((p) => p.kingdomId && !p.townId && !p.settlementId);
  const cap = placementOf(capPlace);
  assert.strictEqual(cap.kingdomId, capPlace.kingdomId, "capital kingdom passthrough");
  assert.deepStrictEqual(placementOf(null), { kingdomId: null, townId: null, settlementId: null },
    "null place degrades");
  console.log(`ok 12 — placementOf resolves towns to kingdoms (${townPlace.townId} -> ${place.kingdomId})`);
}

// 13. activeVisit: active inside the window, null when expired/missing.
{
  const v = { kingdomId: "kandarin", since: NOW - 3600000, len: 8 * 3600000 };
  assert.strictEqual(activeVisit({ visit: v }, NOW), v, "active visit not returned");
  assert.strictEqual(
    activeVisit({ visit: { ...v, since: NOW - 9 * 3600000 } }, NOW), null,
    "expired visit must read as none"
  );
  assert.strictEqual(activeVisit({}, NOW), null, "missing visit must read as none");
  assert.strictEqual(activeVisit({ visit: { since: NOW } }, NOW), null,
    "malformed visit must read as none");
  console.log("ok 13 — activeVisit window logic");
}

// 14. Visit stay-bias: visited-kingdom candidates win more often (linger),
// home-kingdom candidates lose their pull (don't drift back early).
// Everything else scores normally; no visit means no bias.
{
  const visit = { kingdomId: "kandarin", since: NOW - 3600000, len: 8 * 3600000 };
  assert.strictEqual(visitBiasMult("kandarin", visit, "asgarnia"), VISIT_STAY_MULT,
    "visited kingdom must get the stay multiplier");
  assert.strictEqual(visitBiasMult("asgarnia", visit, "asgarnia"), VISIT_HOME_DAMP,
    "home kingdom must be damped during a visit");
  assert.strictEqual(visitBiasMult("morytania", visit, "asgarnia"), 1,
    "third kingdoms score normally");
  assert.strictEqual(visitBiasMult("kandarin", null, "asgarnia"), 1, "no visit, no bias");
  assert.strictEqual(visitBiasMult(null, visit, "asgarnia"), 1, "unknown kingdom, no bias");
  // Integration: an active visit never breaks picking and the dest still
  // carries placement.
  const rec = baseRecord({
    username: "BiasIntegration",
    kingdomId: "asgarnia",
    position: { x: 5000, y: 5000, z: 0 },
    visit,
  });
  const d = pickDestination(rec, NOW);
  assert(Number.isFinite(d.x) && typeof d.kingdomId === "string",
    `bad dest during visit: ${JSON.stringify(d)}`);
  console.log("ok 14 — visit stay-bias multipliers");
}

console.log("CitizenDestinations.test: all passed");
