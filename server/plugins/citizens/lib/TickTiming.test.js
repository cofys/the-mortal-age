// TickTiming unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/TickTiming.test.js (plain node)
const assert = require("node:assert/strict");

const TickTiming = require("./TickTiming");

function withCapturedLog(fn) {
  const lines = [];
  TickTiming.setLogFnForTests((line) => lines.push(line));
  try {
    return { result: fn(), lines };
  } finally {
    TickTiming.setLogFnForTests(console.log);
  }
}

function reset() {
  TickTiming.stopForTests();
  TickTiming.setLogFnForTests(console.log);
}

// --- records timings and flushes a summary line ---
reset();
{
  const { result, lines } = withCapturedLog(() => {
    TickTiming.record("director.tick", 12, 100);
    TickTiming.record("director.tick", 18, 100);
    TickTiming.record("director.tick", 30, 98);
    return TickTiming.flush();
  });
  assert.equal(result.length, 1, "one summary per label");
  const s = result[0];
  assert.equal(s.label, "director.tick");
  assert.equal(s.cycles, 3);
  assert.equal(s.meanMs, 20);
  assert.equal(s.maxMs, 30);
  assert.equal(s.citizensMean, 99.33);
  assert.equal(s.citizensMax, 100);
  assert.equal(lines.length, 1, "one log line per label");
  assert.ok(lines[0].startsWith("[tick-timing] "), "MemoryDiag-style prefix");
  const logged = JSON.parse(lines[0].slice("[tick-timing] ".length));
  assert.equal(logged.cycles, 3);
  assert.equal(logged.meanMs, 20);
  assert.equal(logged.p95Ms, 30);
}
reset();

// --- window resets after flush; labels are independent ---
{
  const { result, lines } = withCapturedLog(() => {
    TickTiming.record("director.tickProximity", 5, 40);
    TickTiming.record("director.tick", 50, 100);
    TickTiming.record("director.tick", 60, 100);
    return TickTiming.flush();
  });
  assert.equal(result.length, 2, "one summary per label");
  const prox = result.find((s) => s.label === "director.tickProximity");
  assert.equal(prox.cycles, 1);
  assert.equal(prox.meanMs, 5);
  assert.equal(prox.p95Ms, 5);
  assert.equal(lines.length, 2);
  // Second flush with no records logs nothing.
  const again = TickTiming.flush();
  assert.equal(again.length, 0, "window reset after flush");
}
reset();

// --- invalid samples are dropped, never throw ---
{
  TickTiming.record("director.tick", NaN, 100);
  TickTiming.record("director.tick", -5, 100);
  TickTiming.record("director.tick", "fast", 100);
  const summaries = TickTiming.flush();
  assert.equal(summaries.length, 0, "bad samples ignored");
}
reset();

console.log("TickTiming.test.js: all checks passed");
