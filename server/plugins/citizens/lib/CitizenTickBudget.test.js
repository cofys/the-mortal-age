"use strict";

/**
 * CitizenTickBudget.test.js — unit tests for the per-cycle execution budget.
 * Run with: node --test server/plugins/citizens/lib/CitizenTickBudget.test.js
 * (from the repo root; uses node:test, no external deps)
 *
 * The clock is fully injectable, so every assertion is deterministic —
 * no wall-clock flakes.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  TICK_BUDGET_MS,
  createBudget,
  runWithinBudget,
  rotateStart,
  advanceCursor,
} = require("./CitizenTickBudget");

/** Manual clock: ms advances only when tick(ms) is called. */
function manualClock(start = 1000) {
  let now = start;
  const nowFn = () => now;
  nowFn.tick = (ms) => {
    now += ms;
  };
  return nowFn;
}

describe("createBudget", () => {
  it("exposes the 30ms default and honors custom budgets", () => {
    assert.equal(TICK_BUDGET_MS, 30);
    const clock = manualClock();
    assert.equal(createBudget(30, clock).budgetMs, 30);
    assert.equal(createBudget(undefined, clock).budgetMs, TICK_BUDGET_MS);
  });

  it("tracks elapsed/remaining with the injected clock", () => {
    const clock = manualClock();
    const b = createBudget(30, clock);
    assert.equal(b.elapsedMs(), 0);
    assert.equal(b.remainingMs(), 30);
    assert.equal(b.hasTime(), true);
    clock.tick(10);
    assert.equal(b.elapsedMs(), 10);
    assert.equal(b.remainingMs(), 20);
    clock.tick(20);
    assert.equal(b.elapsedMs(), 30);
    assert.equal(b.hasTime(), false);
  });

  it("normalizes garbage budgets to the safe default", () => {
    const clock = manualClock();
    assert.equal(createBudget(NaN, clock).budgetMs, TICK_BUDGET_MS);
    assert.equal(createBudget(-5, clock).budgetMs, 0);
    assert.equal(createBudget("abc", clock).budgetMs, TICK_BUDGET_MS);
    assert.equal(createBudget(0, clock).budgetMs, 0);
    assert.equal(createBudget(0, clock).hasTime(), false);
  });

  it("clamps elapsed at zero if the clock runs backwards", () => {
    const clock = manualClock(5000);
    const b = createBudget(30, clock);
    clock.tick(-100);
    assert.equal(b.elapsedMs(), 0);
    assert.equal(b.hasTime(), true);
  });
});

describe("runWithinBudget", () => {
  it("runs every item when the budget is ample", () => {
    const clock = manualClock();
    const ran = [];
    const result = runWithinBudget(["a", "b", "c"], (item) => ran.push(item), createBudget(1000, clock));
    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.deepEqual(result.deferred, []);
    assert.equal(result.exhausted, false);
    assert.equal(result.stoppedAt, 3);
  });

  it("defers the rest when the budget runs out mid-list", () => {
    const clock = manualClock();
    const ran = [];
    const items = ["a", "b", "c", "d"];
    const result = runWithinBudget(
      items,
      (item) => {
        ran.push(item);
        clock.tick(12); // each item costs 12ms of a 30ms budget
      },
      createBudget(30, clock)
    );
    // a(12) + b(24) + c(36 > 30): hasTime checked before each item, so
    // a and b run (elapsed 24 < 30), c is checked at elapsed=24 (has time),
    // runs, then d is checked at elapsed=36 -> deferred.
    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.deepEqual(result.deferred, ["d"]);
    assert.equal(result.exhausted, true);
    assert.equal(result.stoppedAt, 3);
  });

  it("defers everything when the budget starts exhausted", () => {
    const ran = [];
    const result = runWithinBudget(
      ["a", "b"],
      (item) => ran.push(item),
      createBudget(0, manualClock())
    );
    assert.deepEqual(ran, []);
    assert.deepEqual(result.deferred, ["a", "b"]);
    assert.equal(result.exhausted, true);
    assert.equal(result.stoppedAt, 0);
  });

  it("passes the item and index to runOne, in order", () => {
    const seen = [];
    runWithinBudget(["x", "y"], (item, i) => seen.push([item, i]), createBudget(1000, manualClock()));
    assert.deepEqual(seen, [["x", 0], ["y", 1]]);
  });

  it("a single slow item runs to completion (never preempted mid-item)", () => {
    const clock = manualClock();
    let finished = false;
    const result = runWithinBudget(
      ["slow", "next"],
      (item) => {
        if (item === "slow") {
          clock.tick(5000); // blows the whole budget
          finished = true;
        }
      },
      createBudget(30, clock)
    );
    assert.equal(finished, true);
    assert.deepEqual(result.deferred, ["next"]);
    assert.equal(result.exhausted, true);
  });

  it("tolerates a non-array item list", () => {
    const result = runWithinBudget(null, () => {}, createBudget(1000, manualClock()));
    assert.deepEqual(result.ran, []);
    assert.deepEqual(result.deferred, []);
    assert.equal(result.exhausted, false);
  });

  it("lets a throwing runOne abort the run (callers isolate per item)", () => {
    const clock = manualClock();
    assert.throws(() =>
      runWithinBudget(
        ["ok", "boom", "never"],
        (item) => {
          if (item === "boom") throw new Error("boom");
        },
        createBudget(1000, clock)
      )
    );
  });
});

describe("rotateStart", () => {
  it("rotates the list so the next cycle resumes at startIndex", () => {
    assert.deepEqual(rotateStart(["a", "b", "c", "d"], 2), ["c", "d", "a", "b"]);
    assert.deepEqual(rotateStart(["a", "b", "c", "d"], 0), ["a", "b", "c", "d"]);
    assert.deepEqual(rotateStart(["a", "b", "c", "d"], 4), ["a", "b", "c", "d"]);
  });

  it("wraps out-of-range and negative indices", () => {
    assert.deepEqual(rotateStart(["a", "b", "c"], 5), ["c", "a", "b"]);
    assert.deepEqual(rotateStart(["a", "b", "c"], -1), ["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const items = ["a", "b", "c"];
    rotateStart(items, 1);
    assert.deepEqual(items, ["a", "b", "c"]);
  });

  it("handles degenerate inputs", () => {
    assert.deepEqual(rotateStart([], 3), []);
    assert.deepEqual(rotateStart(["solo"], 7), ["solo"]);
    assert.deepEqual(rotateStart(null, 1), []);
  });
});

describe("advanceCursor", () => {
  it("advances by the ran count, wrapping around the total", () => {
    assert.equal(advanceCursor(0, 3, 5), 3);
    assert.equal(advanceCursor(3, 3, 5), 1);
    assert.equal(advanceCursor(4, 1, 5), 0);
  });

  it("is a stable full cycle: advancing by total returns to the same cursor", () => {
    assert.equal(advanceCursor(2, 5, 5), 2);
    assert.equal(advanceCursor(0, 0, 5), 0);
  });

  it("handles garbage input with a safe 0", () => {
    assert.equal(advanceCursor(NaN, 2, 5), 2);
    assert.equal(advanceCursor(1, NaN, 5), 1);
    assert.equal(advanceCursor(1, 2, 0), 0);
    assert.equal(advanceCursor(1, 2, NaN), 0);
  });
});
