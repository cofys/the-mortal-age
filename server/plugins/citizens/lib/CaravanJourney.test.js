// CaravanJourney unit checks — visible caravan journeys, no running server.
//
// Proves the visible-layer contracts:
//   - onCaravanDepart starts a visible walk on road routes (position,
//     waypoint index, crew records + live-bot duty tags); abstracted
//     (Keldagrim-style) routes are left untouched.
//   - tickVisibleCaravans advances the caravan toward waypoints, syncs crew
//     record positions, and ends the visible leg at the final waypoint
//     (duty tags cleared, phase machine untouched).
//   - Entering a dangerSegments leg rolls the route's bandit risk: bandits
//     spawn only when a real player is near; dead bandits let the caravan
//     continue; a slain merchant leader fails the run (cargo lost).
//   - onCaravanReturn walks the same road back, waypoints reversed.
//
// The caravan store lives in CitizenTradeCaravans (module-private), so the
// tests patch its exported accessors (visibleCaravanList / removeCaravan /
// deathCountFor) on the module exports object — the journey module reads
// them lazily at call time.
const assert = require("node:assert/strict");

const journey = require("./CaravanJourney");
const ctc = require("./CitizenTradeCaravans");
const cdr = require("./CitizenDeathRespawn");
const { agentRng } = require("./humanizer");

const {
  onCaravanDepart,
  onCaravanReturn,
  tickVisibleCaravans,
  TILES_PER_SLOW_TICK,
  BANDIT_NPC_ID,
} = journey;

// --- route table ------------------------------------------------------------
journey._setRouteTable([
  {
    key: "test->road",
    from: "test",
    to: "road",
    waypoints: [
      [100, 100, 0],
      [200, 100, 0],
      [300, 100, 0],
    ],
    dangerSegments: [],
    abstracted: false,
  },
  {
    key: "test->danger",
    from: "test",
    to: "danger",
    waypoints: [
      [100, 100, 0],
      [160, 100, 0],
      [220, 100, 0],
    ],
    dangerSegments: [1],
    abstracted: false,
  },
  {
    key: "test->under",
    from: "test",
    to: "under",
    waypoints: [],
    dangerSegments: [],
    abstracted: true,
  },
]);

// --- fakes ------------------------------------------------------------------

function fakeBot() {
  return {
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    },
  };
}

function makeDirector({ playersNear = true } = {}) {
  const director = {
    roster: new Map(),
    bots: new Map(),
    spawned: [],
    removed: [],
    api: null,
    getBot(record) {
      return director.bots.get(record.username) ?? null;
    },
    realPlayerPositions() {
      return playersNear ? [{ x: 160, y: 100, z: 0 }] : [];
    },
    anyRealPlayerNear(x, y, z, radius, positions) {
      return positions.some(
        (p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) <= radius
      );
    },
  };
  director.api = {
    spawnNpc(spec) {
      const npc = {
        spec,
        _dead: false,
        isDead() {
          return this._dead;
        },
        isDying() {
          return false;
        },
        isRegistered() {
          return true;
        },
      };
      director.spawned.push(npc);
      return npc;
    },
    removeNpc(npc) {
      director.removed.push(npc);
    },
  };
  return director;
}

function addCrew(director, leader, guards, { online = [] } = {}) {
  for (const username of [leader, ...guards]) {
    director.roster.set(username.toLowerCase(), {
      username,
      position: { x: 1, y: 1, z: 0 },
      caravanDuty: null,
    });
  }
  for (const username of online) {
    director.bots.set(username, fakeBot());
  }
}

function makeCaravan(routeKey, id = "caravan:test:1") {
  return {
    id,
    routeKey,
    from: "test",
    to: "road",
    phase: "traveling",
    leader: "MerchA",
    guards: ["Guard1", "Guard2"],
  };
}

// Patch the caravan-store accessors on the real module exports.
const removedKeys = [];
let testVisible = [];
const origVisible = ctc.visibleCaravanList;
const origRemove = ctc.removeCaravan;
ctc.visibleCaravanList = () => testVisible;
ctc.removeCaravan = (k) => {
  removedKeys.push(k);
  return true;
};
// Death counts: controllable per test.
const deathCounts = {};
const origDeathCountFor = cdr.deathCountFor;
cdr.deathCountFor = (u) => deathCounts[String(u).toLowerCase()] ?? 0;

function reset() {
  testVisible = [];
  removedKeys.length = 0;
  for (const k of Object.keys(deathCounts)) delete deathCounts[k];
}

// --- depart -----------------------------------------------------------------
{
  reset();
  const director = makeDirector();
  addCrew(director, "MerchA", ["Guard1", "Guard2"], { online: ["Guard1"] });
  const caravan = makeCaravan("test->road");

  assert.equal(onCaravanDepart(director, caravan), true);
  assert.equal(caravan.visible, true);
  assert.equal(caravan.walkPath.length, 3);
  assert.equal(caravan.waypointIndex, 1, "walking toward the second waypoint");
  assert.deepEqual(caravan.position, { x: 100, y: 100, z: 0 });

  for (const name of ["mercha", "guard1", "guard2"]) {
    const record = director.roster.get(name);
    assert.deepEqual(record.position, { x: 100, y: 100, z: 0 }, `${name} record tracks caravan`);
    assert.equal(record.caravanDuty, caravan.id, `${name} record tagged`);
  }
  assert.equal(
    director.bots.get("Guard1").getAttribute("caravan:duty"),
    caravan.id,
    "online crew bot gets the attribute"
  );
  assert.equal(
    director.bots.get("MerchA") ?? null,
    null,
    "offline leader has no bot to tag"
  );
}

// --- abstracted routes are untouched ------------------------------------------
{
  reset();
  const director = makeDirector();
  addCrew(director, "MerchA", ["Guard1"]);
  const caravan = makeCaravan("test->under", "caravan:test:2");

  assert.equal(onCaravanDepart(director, caravan), false);
  assert.ok(!caravan.visible, "abstracted caravan stays invisible");
  assert.equal(caravan.walkPath, undefined);
  assert.equal(director.roster.get("mercha").caravanDuty, null);
  assert.deepEqual(director.roster.get("mercha").position, { x: 1, y: 1, z: 0 });
}

{
  reset();
  const director = makeDirector();
  addCrew(director, "MerchA", ["Guard1"]);
  const caravan = makeCaravan("nope->nope", "caravan:test:3");

  assert.equal(onCaravanDepart(director, caravan), false, "unknown route => abstracted");
  assert.ok(!caravan.visible);
}

// --- waypoint advancement ----------------------------------------------------
{
  reset();
  const director = makeDirector();
  addCrew(director, "MerchA", ["Guard1", "Guard2"], { online: ["Guard1", "Guard2"] });
  const caravan = makeCaravan("test->road", "caravan:test:4");
  onCaravanDepart(director, caravan);
  testVisible = [caravan];

  // 100 tiles separate the waypoints; one slow tick advances 100.
  assert.equal(TILES_PER_SLOW_TICK, 100);
  tickVisibleCaravans(director, 1000);
  assert.deepEqual(caravan.position, { x: 200, y: 100, z: 0 });
  assert.equal(caravan.waypointIndex, 2, "reached waypoint 1, now toward waypoint 2");
  for (const name of ["mercha", "guard1", "guard2"]) {
    assert.deepEqual(director.roster.get(name).position, { x: 200, y: 100, z: 0 });
  }

  // Final waypoint: the visible leg ends, duty tags cleared, phase untouched.
  tickVisibleCaravans(director, 2000);
  assert.deepEqual(caravan.position, { x: 300, y: 100, z: 0 });
  assert.equal(caravan.visible, false);
  assert.equal(caravan.phase, "traveling", "phase machine proceeds on its own timer");
  for (const name of ["mercha", "guard1", "guard2"]) {
    assert.equal(director.roster.get(name).caravanDuty, null, `${name} record untagged`);
  }
  assert.equal(director.bots.get("Guard1").getAttribute("caravan:duty"), null);
}

// --- tick early-out: no visible caravans ------------------------------------
{
  reset();
  const director = makeDirector();
  tickVisibleCaravans(director, 3000); // must not throw
  assert.equal(director.spawned.length, 0);
}

// --- ambush on a danger leg, player near -------------------------------------
// Find a caravan id whose ambush roll beats this route's risk (deterministic:
// agentRng is seeded, so the search is stable).
const dangerKey = "test->danger";
const dangerRisk = ctc.riskFor(dangerKey);
let ambushId = null;
for (let i = 0; i < 500 && !ambushId; i++) {
  const id = `caravan:test:ambush:${i}`;
  if (agentRng(`caravan:ambush:${id}:1`)() < dangerRisk) ambushId = id;
}
assert.ok(ambushId, "found a deterministic ambush-hit id");
assert.ok(dangerRisk >= 0.1 && dangerRisk <= 0.3);

{
  reset();
  const director = makeDirector({ playersNear: true });
  addCrew(director, "MerchA", ["Guard1", "Guard2"]);
  const caravan = makeCaravan(dangerKey, ambushId);
  // Walk the road manually to leg 1: position one tile off waypoint 1.
  caravan.walkPath = [
    { x: 100, y: 100, z: 0 },
    { x: 160, y: 100, z: 0 },
    { x: 220, y: 100, z: 0 },
  ];
  caravan.waypointIndex = 1;
  caravan.position = { x: 159, y: 100, z: 0 };
  caravan.visible = true;
  caravan.phase = "traveling";
  caravan.ambushLegsRolled = [];
  caravan.leaderDeathSeq = 0;
  testVisible = [caravan];

  tickVisibleCaravans(director, 4000);
  assert.equal(caravan.waypointIndex, 2, "advanced onto leg 1");
  assert.ok(caravan.ambush, "ambush rolled on the danger leg");
  assert.ok(
    director.spawned.length >= 2 && director.spawned.length <= 4,
    `2-4 bandits spawned, got ${director.spawned.length}`
  );
  for (const npc of director.spawned) {
    assert.equal(npc.spec.id, BANDIT_NPC_ID);
    assert.ok(Math.abs(npc.spec.x - 160) <= 5 && Math.abs(npc.spec.y - 100) <= 5);
  }

  // While the fight runs the caravan holds position.
  const held = { ...caravan.position };
  tickVisibleCaravans(director, 5000);
  assert.deepEqual(caravan.position, held, "caravan holds during the ambush");

  // Bandits slain: the caravan walks on — only 60 tiles of road left, so it
  // reaches the final waypoint and the visible leg ends normally (duty
  // cleared, no failure).
  for (const npc of director.spawned) npc._dead = true;
  tickVisibleCaravans(director, 6000);
  assert.equal(caravan.ambush, null, "ambush cleared after the fight");
  assert.deepEqual(caravan.position, { x: 220, y: 100, z: 0 });
  assert.equal(caravan.visible, false, "arrived after the fight — leg over, not failed");
  assert.deepEqual(removedKeys, [], "caravan NOT deleted — the run survived");
  for (const name of ["mercha", "guard1", "guard2"]) {
    assert.equal(director.roster.get(name).caravanDuty, null);
  }
}

// --- ambush skipped when no player is near ------------------------------------
{
  reset();
  const director = makeDirector({ playersNear: false });
  addCrew(director, "MerchA", ["Guard1"]);
  const caravan = makeCaravan(dangerKey, ambushId);
  caravan.walkPath = [
    { x: 100, y: 100, z: 0 },
    { x: 160, y: 100, z: 0 },
    { x: 220, y: 100, z: 0 },
  ];
  caravan.waypointIndex = 1;
  caravan.position = { x: 159, y: 100, z: 0 };
  caravan.visible = true;
  caravan.phase = "traveling";
  caravan.ambushLegsRolled = [];
  caravan.leaderDeathSeq = 0;
  testVisible = [caravan];

  tickVisibleCaravans(director, 7000);
  assert.equal(director.spawned.length, 0, "no wasted spawn without witnesses");
  assert.ok(!caravan.ambush, "no ambush recorded");
  assert.deepEqual(caravan.ambushLegsRolled, [1], "leg still marked rolled");
}

// --- leader death fails the run ----------------------------------------------
{
  reset();
  const director = makeDirector();
  addCrew(director, "MerchA", ["Guard1", "Guard2"], { online: ["Guard1"] });
  const caravan = makeCaravan("test->road", "caravan:test:5");
  onCaravanDepart(director, caravan);
  testVisible = [caravan];
  deathCounts["mercha"] = 1; // the leader died after the depart snapshot

  tickVisibleCaravans(director, 8000);
  assert.deepEqual(removedKeys, ["test->road"], "caravan deleted — cargo lost");
  assert.equal(caravan.visible, false);
  for (const name of ["mercha", "guard1", "guard2"]) {
    assert.equal(director.roster.get(name).caravanDuty, null);
  }
  assert.equal(director.bots.get("Guard1").getAttribute("caravan:duty"), null);
}

// --- return trip: reversed waypoints ------------------------------------------
{
  reset();
  const director = makeDirector();
  addCrew(director, "MerchA", ["Guard1"]);
  const caravan = makeCaravan("test->road", "caravan:test:6");
  caravan.phase = "returning";

  assert.equal(onCaravanReturn(director, caravan), true);
  assert.equal(caravan.visible, true);
  assert.deepEqual(caravan.position, { x: 300, y: 100, z: 0 }, "starts at the destination");
  assert.deepEqual(caravan.walkPath[2], { x: 100, y: 100, z: 0 }, "waypoints reversed");
  assert.equal(caravan.waypointIndex, 1);
  assert.equal(director.roster.get("mercha").caravanDuty, caravan.id);

  testVisible = [caravan];
  tickVisibleCaravans(director, 9000);
  assert.deepEqual(caravan.position, { x: 200, y: 100, z: 0 }, "walking home");
}

// --- abstracted return is untouched --------------------------------------------
{
  reset();
  const director = makeDirector();
  addCrew(director, "MerchA", ["Guard1"]);
  const caravan = makeCaravan("test->under", "caravan:test:7");
  caravan.phase = "returning";
  assert.equal(onCaravanReturn(director, caravan), false);
  assert.ok(!caravan.visible);
}

// --- restore patched module state ----------------------------------------------
ctc.visibleCaravanList = origVisible;
ctc.removeCaravan = origRemove;
cdr.deathCountFor = origDeathCountFor;
journey._resetForTests();

console.log("CaravanJourney.test.js: all assertions passed");
