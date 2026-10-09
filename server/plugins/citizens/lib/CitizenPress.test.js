"use strict";

/**
 * CitizenPress.test.js — plain-node tests for the real journalism data tier.
 *
 * Run: node server/plugins/citizens/lib/CitizenPress.test.js
 */

const assert = require("assert");

const Press = require("./CitizenPress");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Press.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

console.log("CitizenPress tests:");

// --- beats ---

test("beats cover all five kinds", () => {
  assert.deepStrictEqual([...Press.BEATS].sort(), ["crime", "culture", "discovery", "politics", "war"]);
});

test("material is real papyrus", () => {
  assert.strictEqual(Press.MAT_PAPYRUS, 970);
});

// --- journalists ---

test("registerJournalist is honest about identity", () => {
  assert.strictEqual(Press.registerJournalist("", "misthalin").ok, false);
  assert.strictEqual(Press.registerJournalist("Alice", null).ok, false);
  const r = Press.registerJournalist("Alice", "misthalin");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already, false);
  assert.strictEqual(Press.isJournalist("alice"), true); // normalized
  assert.strictEqual(Press.isJournalist("bob"), false);
});

test("double registration is idempotent", () => {
  Press.registerJournalist("Alice", "misthalin");
  const r = Press.registerJournalist("Alice", "misthalin");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already, true);
  assert.strictEqual(Press.journalistsIn("misthalin").length, 1);
});

test("journalistsIn is kingdom-scoped", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.registerJournalist("Bob", "asgarnia");
  assert.strictEqual(Press.journalistsIn("misthalin").length, 1);
  assert.strictEqual(Press.journalistsIn("asgarnia").length, 1);
});

// --- events ---

test("recordEvent rejects bad beats", () => {
  assert.strictEqual(Press.recordEvent("sports", "misthalin", "x", "y").ok, false);
});

test("recordEvent dedupes on beat+subject", () => {
  const a = Press.recordEvent("crime", "misthalin", "trial-1", "Bob convicted of theft");
  const b = Press.recordEvent("crime", "misthalin", "trial-1", "Bob convicted of theft");
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.already, true);
  assert.strictEqual(a.id, b.id);
});

test("unclaimedEvents filters by beat, kingdom, and recency", () => {
  Press.recordEvent("war", "misthalin", "war-1", "Asgarnia marches");
  Press.recordEvent("war", "asgarnia", "war-2", "Misthalin marches");
  assert.strictEqual(Press.unclaimedEvents("war", "misthalin").length, 1);
  assert.strictEqual(Press.unclaimedEvents("crime", "misthalin").length, 0);
});

test("majorEventsSince only returns major events", () => {
  Press.recordEvent("war", "misthalin", "war-1", "War!", Press.KIND_MAJOR);
  Press.recordEvent("crime", "misthalin", "trial-1", "Trial", Press.KIND_ROUTINE);
  const majors = Press.majorEventsSince("misthalin", 3600000);
  assert.strictEqual(majors.length, 1);
  assert.strictEqual(majors[0].beat, "war");
});

// --- stories ---

test("fileStory requires a registered journalist", () => {
  Press.recordEvent("crime", "misthalin", "trial-1", "Bob convicted");
  const ev = Press.unclaimedEvents("crime", "misthalin")[0];
  const r = Press.fileStory("Nobody", ev.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-a-journalist");
});

test("fileStory claims the event and writes a deterministic headline", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.recordEvent("crime", "misthalin", "trial-1", "Bob convicted of theft");
  const ev = Press.unclaimedEvents("crime", "misthalin")[0];
  const r = Press.fileStory("Alice", ev.id);
  assert.strictEqual(r.ok, true);
  assert.ok(r.story.headline.length > 0);
  assert.ok(r.story.headline.includes("Bob convicted of theft"));
  assert.strictEqual(r.story.quality >= 1 && r.story.quality <= 10, true);
  // Claimed — no longer unclaimed.
  assert.strictEqual(Press.unclaimedEvents("crime", "misthalin").length, 0);
  assert.strictEqual(Press.storyCountFor("Alice"), 1);
});

test("fileStory quality grows with the author's real engagement", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.recordEvent("crime", "misthalin", "t1", "one");
  Press.recordEvent("war", "misthalin", "w1", "two");
  Press.recordEvent("politics", "misthalin", "p1", "three");
  const q1 = Press.fileStory("Alice", Press.unclaimedEvents("crime", "misthalin")[0].id).story.quality;
  const q2 = Press.fileStory("Alice", Press.unclaimedEvents("war", "misthalin")[0].id).story.quality;
  const q3 = Press.fileStory("Alice", Press.unclaimedEvents("politics", "misthalin")[0].id).story.quality;
  assert.ok(q3 >= q1, `quality should grow with experience: ${q1} -> ${q3}`);
});

test("fileStory cannot double-claim an event", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.registerJournalist("Bob", "misthalin");
  Press.recordEvent("crime", "misthalin", "trial-1", "Bob convicted");
  const ev = Press.unclaimedEvents("crime", "misthalin")[0];
  Press.fileStory("Alice", ev.id);
  const r = Press.fileStory("Bob", ev.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "already-claimed");
});

test("submitPlayerStory validates beat and length", () => {
  assert.strictEqual(Press.submitPlayerStory("Jon", "misthalin", "sports", "hi").ok, false);
  assert.strictEqual(Press.submitPlayerStory("Jon", "misthalin", "war", "short").ok, false);
  const r = Press.submitPlayerStory("Jon", "misthalin", "war", "I watched the siege of Falador from the hill and saw the banners fall");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.story.authorIsPlayer, true);
  assert.strictEqual(r.story.author, "Jon");
});

test("fameDeedsFor awards inkslinger and muckraker at thresholds", () => {
  Press.registerJournalist("Alice", "misthalin");
  assert.deepStrictEqual(Press.fameDeedsFor("Alice"), []);
  for (let i = 0; i < 5; i++) {
    Press.recordEvent(i % 2 ? "culture" : "politics", "misthalin", `e${i}`, `event ${i}`);
    const ev = Press.unclaimedEvents(i % 2 ? "culture" : "politics", "misthalin")[0];
    Press.fileStory("Alice", ev.id);
  }
  assert.ok(Press.fameDeedsFor("Alice").includes("inkslinger"));
  for (let i = 0; i < 3; i++) {
    Press.recordEvent("crime", "misthalin", `c${i}`, `crime ${i}`);
    Press.fileStory("Alice", Press.unclaimedEvents("crime", "misthalin")[0].id);
  }
  assert.ok(Press.fameDeedsFor("Alice").includes("muckraker"));
});

// --- presses ---

test("ensurePress creates a press with a real tile", () => {
  const p = Press.ensurePress("misthalin");
  assert.ok(p);
  assert.ok(p.tile && typeof p.tile.x === "number");
  assert.strictEqual(p.paper, 0);
  assert.strictEqual(Press.pressFor("misthalin").paper, 0);
});

test("stockPress accumulates real paper", () => {
  Press.stockPress("misthalin", 10);
  Press.stockPress("misthalin", 5);
  assert.strictEqual(Press.pressFor("misthalin").paper, 15);
});

// --- editions ---

test("compileEdition honestly refuses without paper", () => {
  Press.registerJournalist("Alice", "misthalin");
  for (let i = 0; i < 3; i++) {
    Press.recordEvent("war", "misthalin", `w${i}`, `war event ${i}`);
    Press.fileStory("Alice", Press.unclaimedEvents("war", "misthalin")[0].id);
  }
  const r = Press.compileEdition("misthalin", "war", "test");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-paper");
});

test("compileEdition prints only what the press can afford", () => {
  Press.registerJournalist("Alice", "misthalin");
  for (let i = 0; i < 3; i++) {
    Press.recordEvent("war", "misthalin", `w${i}`, `war event ${i}`);
    Press.fileStory("Alice", Press.unclaimedEvents("war", "misthalin")[0].id);
  }
  Press.stockPress("misthalin", 4); // want 5 copies (min), can print 4
  const r = Press.compileEdition("misthalin", "war", "test");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.edition.copies, 4);
  assert.strictEqual(Press.pressFor("misthalin").paper, 0);
  // Stories are now bundled.
  assert.strictEqual(Press.storiesFor("misthalin", "war").length, 0);
});

test("compileEdition refuses with no stories", () => {
  Press.stockPress("misthalin", 10);
  const r = Press.compileEdition("misthalin", "war", "test");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-stories");
});

test("latestEdition returns the newest edition", () => {
  Press.registerJournalist("Alice", "misthalin");
  for (let i = 0; i < 6; i++) {
    Press.recordEvent("war", "misthalin", `w${i}`, `war event ${i}`);
    Press.fileStory("Alice", Press.unclaimedEvents("war", "misthalin")[0].id);
  }
  Press.stockPress("misthalin", 20);
  const a = Press.compileEdition("misthalin", "war", "first");
  assert.strictEqual(Press.latestEdition("misthalin").id, a.id);
});

test("recordCopySold tracks newsstand sales", () => {
  Press.registerJournalist("Alice", "misthalin");
  for (let i = 0; i < 3; i++) {
    Press.recordEvent("war", "misthalin", `w${i}`, `war event ${i}`);
    Press.fileStory("Alice", Press.unclaimedEvents("war", "misthalin")[0].id);
  }
  Press.stockPress("misthalin", 10);
  const ed = Press.compileEdition("misthalin", "war", "test").edition;
  Press.recordCopySold(ed.id);
  assert.strictEqual(Press.editionFor(ed.id).soldCopies, 1);
});

// --- subscriptions ---

test("subscribe is idempotent and priced", () => {
  const a = Press.subscribe("Bob", "misthalin");
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.price, Press.SUBSCRIPTION_PRICE);
  const b = Press.subscribe("Bob", "misthalin");
  assert.strictEqual(b.already, true);
  assert.strictEqual(Press.isSubscriber("bob", "misthalin"), true);
  assert.strictEqual(Press.subscribersIn("misthalin").length, 1);
});

test("politicalSalienceFor counts recent political reads", () => {
  assert.strictEqual(Press.politicalSalienceFor("misthalin"), 0);
  Press.registerJournalist("Alice", "misthalin");
  for (let i = 0; i < 3; i++) {
    Press.recordEvent("politics", "misthalin", `p${i}`, `politics ${i}`);
    Press.fileStory("Alice", Press.unclaimedEvents("politics", "misthalin")[0].id);
  }
  Press.stockPress("misthalin", 10);
  Press.subscribe("Bob", "misthalin");
  const ed = Press.compileEdition("misthalin", "politics", "test").edition;
  Press.recordRead("Bob", ed.id);
  assert.strictEqual(Press.politicalSalienceFor("misthalin"), 1);
  // War reads don't count toward political salience.
  for (let i = 0; i < 3; i++) {
    Press.recordEvent("war", "misthalin", `w${i}`, `war ${i}`);
    Press.fileStory("Alice", Press.unclaimedEvents("war", "misthalin")[0].id);
  }
  Press.stockPress("misthalin", 10);
  const ed2 = Press.compileEdition("misthalin", "war", "test").edition;
  Press.recordRead("Bob", ed2.id);
  assert.strictEqual(Press.politicalSalienceFor("misthalin"), 1);
});

// --- describe ---

test("describe returns a press summary for chat", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.stockPress("misthalin", 7);
  const d = Press.describe("misthalin");
  assert.strictEqual(d.hasPress, true);
  assert.strictEqual(d.paper, 7);
  assert.strictEqual(d.journalistCount, 1);
});

// --- persistence ---

test("save returns false when clean, resetForTests clears", () => {
  assert.strictEqual(Press.save(), false);
  Press.registerJournalist("Alice", "misthalin");
  assert.strictEqual(Press.isJournalist("Alice"), true);
  Press.resetForTests();
  assert.strictEqual(Press.isJournalist("Alice"), false);
  assert.strictEqual(Press.describe("misthalin").journalistCount, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
