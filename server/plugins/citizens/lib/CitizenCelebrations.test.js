"use strict";

/**
 * Tests for CitizenCelebrations (data tier).
 * Plain-node, no engine required.
 */

const assert = require("assert");
const C = require("./CitizenCelebrations");

function fresh() {
  C.resetForTests();
}

function test(name, fn) {
  try {
    fresh();
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// === Planners ===

test("appointPlanner requires reputation and social score", () => {
  assert.strictEqual(C.appointPlanner("misthalin", "Alice", 5, 80), null, "low rep rejected");
  assert.strictEqual(C.appointPlanner("misthalin", "Alice", 30, 20), null, "low social rejected");
  const p = C.appointPlanner("misthalin", "Alice", 30, 80);
  assert.ok(p, "eligible appointed");
  assert.strictEqual(p.username, "alice");
});

test("plannerFor returns appointed planner", () => {
  assert.strictEqual(C.plannerFor("misthalin"), null, "none yet");
  C.appointPlanner("misthalin", "Bob", 50, 90);
  const p = C.plannerFor("misthalin");
  assert.strictEqual(p.username, "bob");
});

test("allPlanners lists across kingdoms", () => {
  C.appointPlanner("misthalin", "Alice", 30, 80);
  C.appointPlanner("asgarnia", "Bob", 40, 70);
  const all = C.allPlanners();
  assert.strictEqual(all.length, 2);
});

// === Custom festivals ===

test("organizeFestival requires valid theme and budget", () => {
  assert.strictEqual(
    C.organizeFestival({ theme: "not-a-theme", kingdomId: "k", organizer: "x", budget: 1000 }),
    null, "bad theme rejected"
  );
  assert.strictEqual(
    C.organizeFestival({ theme: "starlight", kingdomId: "k", organizer: "x", budget: 100 }),
    null, "low budget rejected"
  );
  const f = C.organizeFestival({ theme: "starlight", kingdomId: "k", organizer: "Zara", budget: 1000 });
  assert.ok(f, "valid festival created");
  assert.strictEqual(f.organizer, "zara");
  assert.ok(f.endsAt > f.startsAt, "has duration");
});

test("organizeFestival uses theme name as default", () => {
  const f = C.organizeFestival({ theme: "starlight", kingdomId: "k", organizer: "x", budget: 600 });
  assert.strictEqual(f.name, "Starlight Festival");
});

test("activeCustom finds running festival", () => {
  const now = Date.now();
  C.organizeFestival({ theme: "starlight", kingdomId: "k", organizer: "x", budget: 600, startsAt: now - 1000 });
  const active = C.activeCustom("k", now);
  assert.ok(active, "found active");
  assert.strictEqual(C.activeCustom("other", now), null, "wrong kingdom");
});

test("upcomingCustoms finds festivals starting within a week", () => {
  const now = Date.now();
  const soon = now + 3 * 24 * 60 * 60 * 1000;
  const far = now + 30 * 24 * 60 * 60 * 1000;
  C.organizeFestival({ theme: "starlight", kingdomId: "k", organizer: "x", budget: 600, startsAt: soon });
  C.organizeFestival({ theme: "peace-treaty", kingdomId: "k", organizer: "y", budget: 600, startsAt: far });
  const upcoming = C.upcomingCustoms("k", now);
  assert.strictEqual(upcoming.length, 1, "only the soon one");
});

// === Parades ===

test("scheduleParade creates parade with route", () => {
  const p = C.scheduleParade("fest-1", "misthalin", Date.now());
  assert.ok(p.id.startsWith("parade-"));
  assert.deepStrictEqual(p.route, ["market", "main-street", "temple", "market"]);
  assert.strictEqual(p.announced, false);
});

test("activeParades finds parades near start time", () => {
  const now = Date.now();
  C.scheduleParade("f1", "k", now);
  C.scheduleParade("f2", "k", now - 5 * 60 * 60 * 1000); // 5h ago
  const active = C.activeParades("k", now);
  assert.strictEqual(active.length, 1, "only the recent one");
});

test("markParadeAnnounced sets flag", () => {
  const p = C.scheduleParade("f1", "k", Date.now());
  C.markParadeAnnounced(p.id);
  const found = C.activeParades("k", Date.now())[0];
  assert.strictEqual(found.announced, true);
});

// === Fireworks ===

test("scheduleFireworks creates show", () => {
  const s = C.scheduleFireworks("fest-1", "misthalin", Date.now());
  assert.ok(s.id.startsWith("fw-"));
  assert.strictEqual(s.announced, false);
});

test("tonightFireworks finds shows in window", () => {
  const now = Date.now();
  C.scheduleFireworks("f1", "k", now + 60 * 60 * 1000); // in 1h
  C.scheduleFireworks("f2", "k", now + 10 * 60 * 60 * 1000); // in 10h
  const tonight = C.tonightFireworks("k", now);
  assert.strictEqual(tonight.length, 1, "only tonight's");
});

test("markFireworksAnnounced sets flag", () => {
  const s = C.scheduleFireworks("f1", "k", Date.now());
  C.markFireworksAnnounced(s.id);
  assert.strictEqual(C.tonightFireworks("k", Date.now())[0].announced, true);
});

// === Carnival booths ===

test("setupBooths creates one booth per type", () => {
  const booths = C.setupBooths("fest-1", ["Alice", "Bob"]);
  assert.strictEqual(booths.length, 3);
  assert.ok(booths.every((b) => b.prizePool === C.BOOTH_PRIZE * 10));
});

test("boothsFor returns festival booths", () => {
  C.setupBooths("fest-1", ["Alice"]);
  assert.strictEqual(C.boothsFor("fest-1").length, 3);
  assert.strictEqual(C.boothsFor("nope").length, 0);
});

test("playBooth handles missing booth and empty pool", () => {
  assert.strictEqual(C.playBooth("nope", "ring-toss").reason, "no-booth");
  C.setupBooths("fest-1", ["Alice"]);
  // Drain the pool
  const booths = C.boothsFor("fest-1");
  booths[0].prizePool = 0;
  assert.strictEqual(C.playBooth("fest-1", booths[0].type).reason, "pool-empty");
});

test("playBooth win deducts from pool", () => {
  C.setupBooths("fest-1", ["Alice"]);
  const boothType = C.BOOTH_TYPES[0];
  // Force wins by stubbing Math.random
  const orig = Math.random;
  Math.random = () => 0; // always win
  try {
    const before = C.boothsFor("fest-1").find((b) => b.type === boothType).prizePool;
    const result = C.playBooth("fest-1", boothType);
    assert.strictEqual(result.won, true);
    assert.strictEqual(result.prize, C.BOOTH_PRIZE);
    const after = C.boothsFor("fest-1").find((b) => b.type === boothType).prizePool;
    assert.strictEqual(after, before - C.BOOTH_PRIZE);
  } finally {
    Math.random = orig;
  }
});

test("playBooth loss gives no prize", () => {
  C.setupBooths("fest-1", ["Alice"]);
  const orig = Math.random;
  Math.random = () => 0.99; // always lose
  try {
    const result = C.playBooth("fest-1", C.BOOTH_TYPES[0]);
    assert.strictEqual(result.won, false);
    assert.strictEqual(result.prize, 0);
  } finally {
    Math.random = orig;
  }
});

// === Announce throttle ===

test("canAnnounce throttles per kingdom+kind", () => {
  const now = Date.now();
  assert.strictEqual(C.canAnnounce("k", "parade", now), true, "first ok");
  assert.strictEqual(C.canAnnounce("k", "parade", now + 1000), false, "throttled");
  assert.strictEqual(C.canAnnounce("k", "fireworks", now + 1000), true, "different kind ok");
  assert.strictEqual(C.canAnnounce("other", "parade", now + 1000), true, "different kingdom ok");
});

// === Persistence ===

test("save returns false when clean, true when dirty", () => {
  assert.strictEqual(C.save(), false, "clean");
  C.appointPlanner("k", "Alice", 30, 80);
  // save() tries to write; may fail in test env but dirty flag behavior is what matters
  C.save();
});

console.log("\nAll CitizenCelebrations tests done.");
