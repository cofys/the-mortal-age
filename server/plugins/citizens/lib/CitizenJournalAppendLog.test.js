"use strict";

/**
 * Tests for the CitizenJournal append-only log.
 *
 * Verifies:
 * 1. saveIfDirty appends (not full rewrite) — fast, O(new events).
 * 2. load() replays snapshot + log correctly.
 * 3. Corrupt log lines don't break load (crash safety).
 * 4. forget() tombstones work through replay.
 * 5. compact() rewrites snapshot and truncates log.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// Load the journal module fresh (it uses a singleton, so we test via instances).
const journalPath = path.join(__dirname, "CitizenJournal.js");

function freshJournal(tmpDir) {
  // Clear require cache to get a fresh module (avoids singleton pollution).
  delete require.cache[require.resolve(journalPath)];
  const mod = require(journalPath);
  // Access the class via a fresh instance. The module exports a singleton
  // getter; we need the class. Use resetForTests + manual paths.
  const j = mod.getJournal ? mod.getJournal() : new mod.CitizenJournal();
  j.resetForTests();
  j._savePath = path.join(tmpDir, "citizen-journal.json");
  j._logPath = path.join(tmpDir, "citizen-journal.log");
  j._pending = [];
  return j;
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "journal-test-"));
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL: " + msg);
  }
}

// Test 1: save appends, doesn't rewrite snapshot
(function testAppendNotRewrite() {
  const tmp = makeTmpDir();
  const j = freshJournal(tmp);
  j.log("Alice", "worked", "Fished 10 salmon");
  j.log("Bob", "traded", "Sold iron ore");
  const t0 = Date.now();
  const saved = j.saveIfDirty();
  const dt = Date.now() - t0;
  assert(saved, "saveIfDirty returns true when dirty");
  assert(dt < 50, "save is fast (<50ms), took " + dt + "ms");
  // Snapshot should NOT exist (no full rewrite on normal save).
  assert(!fs.existsSync(j._savePath), "snapshot NOT written on normal save");
  // Log SHOULD exist with 2 lines.
  assert(fs.existsSync(j._logPath), "log file created");
  const lines = fs.readFileSync(j._logPath, "utf8").trim().split("\n");
  assert(lines.length === 2, "log has 2 lines, got " + lines.length);
  // Second save with no new events should be a no-op.
  const saved2 = j.saveIfDirty();
  assert(!saved2, "second save is no-op when clean");
})();

// Test 2: load replays snapshot + log
(function testLoadReplay() {
  const tmp = makeTmpDir();
  const j1 = freshJournal(tmp);
  j1.log("Alice", "worked", "Fished 10 salmon");
  j1.saveIfDirty();
  // Compact to create a snapshot.
  j1.compact();
  assert(fs.existsSync(j1._savePath), "snapshot created on compact");
  // Add more events after the snapshot.
  j1.log("Bob", "traded", "Sold iron ore");
  j1.log("Alice", "chatted", "Greeted Bob");
  j1.saveIfDirty();
  // Fresh journal, load from disk.
  const j2 = freshJournal(tmp);
  const loaded = j2.load();
  assert(loaded, "load returns true");
  const aliceEvents = j2.recent("Alice", 10);
  assert(aliceEvents.length === 2, "Alice has 2 events after replay, got " + aliceEvents.length);
  const bobEvents = j2.recent("Bob", 10);
  assert(bobEvents.length === 1, "Bob has 1 event after replay");
})();

// Test 3: corrupt log lines don't break load
(function testCorruptLog() {
  const tmp = makeTmpDir();
  const j1 = freshJournal(tmp);
  j1.log("Alice", "worked", "Fished 10 salmon");
  j1.saveIfDirty();
  // Corrupt the log with garbage.
  fs.appendFileSync(j1._logPath, "NOT VALID JSON{{{\n", "utf8");
  fs.appendFileSync(j1._logPath, '{"incomplete": \n', "utf8");
  j1.log("Bob", "traded", "Sold iron ore");
  j1.saveIfDirty();
  const j2 = freshJournal(tmp);
  const loaded = j2.load();
  assert(loaded, "load survives corrupt lines");
  assert(j2.recent("Alice", 10).length === 1, "Alice event preserved");
  assert(j2.recent("Bob", 10).length === 1, "Bob event preserved");
})();

// Test 4: forget tombstones
(function testForgetTombstone() {
  const tmp = makeTmpDir();
  const j1 = freshJournal(tmp);
  j1.log("Alice", "worked", "Fished 10 salmon");
  j1.saveIfDirty();
  j1.compact(); // Snapshot has Alice.
  j1.forget("Alice");
  j1.saveIfDirty(); // Tombstone in log.
  const j2 = freshJournal(tmp);
  j2.load();
  assert(j2.recent("Alice", 10).length === 0, "Alice forgotten after replay");
})();

// Test 5: compact rewrites snapshot and truncates log
(function testCompact() {
  const tmp = makeTmpDir();
  const j1 = freshJournal(tmp);
  for (let i = 0; i < 100; i++) {
    j1.log("Citizen" + i, "worked", "Did work " + i);
  }
  j1.saveIfDirty();
  const logSizeBefore = fs.statSync(j1._logPath).size;
  assert(logSizeBefore > 0, "log has content before compact");
  j1.compact();
  const logSizeAfter = fs.statSync(j1._logPath).size;
  assert(logSizeAfter === 0, "log truncated after compact");
  assert(fs.existsSync(j1._savePath), "snapshot exists after compact");
  // Verify all data survived.
  const j2 = freshJournal(tmp);
  j2.load();
  assert(j2.recent("Citizen50", 10).length === 1, "data survives compact");
})();

// Test 6: performance at scale (1000 citizens, 30 events each)
(function testPerfAtScale() {
  const tmp = makeTmpDir();
  const j = freshJournal(tmp);
  for (let i = 0; i < 1000; i++) {
    for (let e = 0; e < 30; e++) {
      j.log("Citizen" + i, "worked", "Event " + e + " with some descriptive text about what happened");
    }
  }
  const t0 = Date.now();
  j.saveIfDirty();
  const dt = Date.now() - t0;
  // 30,000 events appended. Should be fast (vs 100ms+ for full rewrite).
  console.log("  [perf] 30k events appended in " + dt + "ms");
  assert(dt < 200, "30k events save in <200ms, took " + dt + "ms");
})();

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
