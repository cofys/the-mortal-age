"use strict";

/**
 * CitizenTimingDesync.test.js — unit tests for the timing desync layer.
 * Run with: node --test server/plugins/citizens/lib/CitizenTimingDesync.test.js
 * (from the repo root; uses node:test, no external deps)
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SPREAD,
  slotFor,
  phaseFor,
  isCitizenDue,
  dueThisTick,
  distribution,
  configuredSpread,
  _hashUsername,
} = require("./CitizenTimingDesync");

function record(name) {
  return { username: name };
}

describe("_hashUsername", () => {
  it("is stable across calls (persistent offset)", () => {
    assert.equal(_hashUsername("some_citizen"), _hashUsername("some_citizen"));
  });

  it("is case-insensitive", () => {
    assert.equal(_hashUsername("Jon Coffey"), _hashUsername("jon coffey"));
  });

  it("returns a 32-bit unsigned integer", () => {
    const h = _hashUsername("x");
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
  });

  it("handles empty/missing input without throwing", () => {
    assert.equal(_hashUsername(""), _hashUsername(null));
    assert.equal(_hashUsername(undefined), _hashUsername(""));
  });

  it("distinguishes usernames", () => {
    assert.notEqual(_hashUsername("alice"), _hashUsername("bob"));
  });
});

describe("slotFor", () => {
  it("lands inside 0..spread-1", () => {
    for (const name of ["alice", "bob", "carol", "dave", "eve"]) {
      const slot = slotFor(name, 10);
      assert.ok(slot >= 0 && slot < 10, `${name} -> ${slot}`);
    }
  });

  it("is stable across restarts (same input, same slot)", () => {
    assert.equal(slotFor("merchant_prime"), slotFor("merchant_prime"));
  });

  it("defaults to DEFAULT_SPREAD", () => {
    assert.equal(slotFor("alice"), slotFor("alice", DEFAULT_SPREAD));
  });

  it("normalizes invalid spreads to the default", () => {
    assert.equal(slotFor("alice", 0), slotFor("alice", DEFAULT_SPREAD));
    assert.equal(slotFor("alice", -3), slotFor("alice", DEFAULT_SPREAD));
    assert.equal(slotFor("alice", "nope"), slotFor("alice", DEFAULT_SPREAD));
  });

  it("spread of 1 always yields slot 0", () => {
    assert.equal(slotFor("alice", 1), 0);
    assert.equal(slotFor("bob", 1), 0);
  });
});

describe("phaseFor", () => {
  it("cycles 0..spread-1", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((t) => phaseFor(t, 10)),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]
    );
  });

  it("handles negative and non-finite counters", () => {
    assert.equal(phaseFor(-1, 10), 9);
    assert.equal(phaseFor(NaN, 10), 0);
  });
});

describe("isCitizenDue", () => {
  it("fires exactly once per spread cycle for a citizen", () => {
    const name = "gossiping_greta";
    const slot = slotFor(name, 10);
    let hits = 0;
    for (let t = 0; t < 30; t++) {
      if (isCitizenDue(record(name), t, 10)) {
        hits++;
        assert.equal(phaseFor(t, 10), slot, "due only on its own slot");
      }
    }
    assert.equal(hits, 3, "once per 10-tick cycle");
  });

  it("supports records keyed by name instead of username", () => {
    const r = { name: "nameless_ned" };
    const slot = slotFor("nameless_ned", 10);
    assert.equal(isCitizenDue(r, slot, 10), true);
  });

  it("records without a name land in a deterministic slot", () => {
    const slot = slotFor("", 10);
    assert.equal(isCitizenDue({}, slot, 10), true);
    assert.equal(isCitizenDue(null, slot, 10), true);
  });
});

describe("dueThisTick", () => {
  it("partitions the roster across the cycle", () => {
    const roster = [];
    for (let i = 0; i < 100; i++) {
      roster.push(record(`citizen_${i}`));
    }
    const seen = new Set();
    let total = 0;
    for (let t = 0; t < 10; t++) {
      const due = dueThisTick(roster, t, 10);
      for (const r of due) {
        assert.ok(!seen.has(r.username), `${r.username} due twice in one cycle`);
        seen.add(r.username);
      }
      total += due.length;
    }
    assert.equal(total, 100, "every citizen due exactly once per cycle");
    assert.equal(seen.size, 100);
  });

  it("preserves iteration order", () => {
    const roster = [record("zebra"), record("apple"), record("mango")];
    for (let t = 0; t < 10; t++) {
      const due = dueThisTick(roster, t, 10);
      const names = due.map((r) => r.username);
      assert.deepEqual(names, [...names].sort((a, b) => {
        // relative order must match roster order
        return (
          roster.findIndex((r) => r.username === a) -
          roster.findIndex((r) => r.username === b)
        );
      }));
    }
  });

  it("handles empty input", () => {
    assert.deepEqual(dueThisTick([], 0, 10), []);
    assert.deepEqual(dueThisTick(null, 0, 10), []);
  });
});

describe("distribution", () => {
  it("spreads the load instead of clumping (the actual anti-wave check)", () => {
    const roster = [];
    for (let i = 0; i < 200; i++) {
      roster.push(record(`citizen_${i}`));
    }
    const counts = distribution(roster, 10);
    assert.equal(counts.length, 10);
    assert.equal(
      counts.reduce((a, b) => a + b, 0),
      200
    );
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    // FNV-1a won't be perfect, but it must not collapse into a few slots.
    assert.ok(min > 0, `no empty slots: ${counts}`);
    assert.ok(max - min <= 12, `reasonably even: ${counts}`);
  });

  it("everyone in slot 0 when spread is 1", () => {
    const roster = [record("a"), record("b"), record("c")];
    assert.deepEqual(distribution(roster, 1), [3]);
  });
});

describe("configuredSpread", () => {
  it("defaults to DEFAULT_SPREAD when unset", () => {
    assert.equal(configuredSpread({}), DEFAULT_SPREAD);
  });

  it("reads CITIZEN_DESYNC_SPREAD", () => {
    assert.equal(configuredSpread({ CITIZEN_DESYNC_SPREAD: "5" }), 5);
  });

  it("falls back to default on invalid values", () => {
    assert.equal(configuredSpread({ CITIZEN_DESYNC_SPREAD: "0" }), DEFAULT_SPREAD);
    assert.equal(configuredSpread({ CITIZEN_DESYNC_SPREAD: "-2" }), DEFAULT_SPREAD);
    assert.equal(configuredSpread({ CITIZEN_DESYNC_SPREAD: "junk" }), DEFAULT_SPREAD);
    assert.equal(configuredSpread({ CITIZEN_DESYNC_SPREAD: "" }), DEFAULT_SPREAD);
  });
});

describe("DEFAULT_SPREAD", () => {
  it("is 10 per the requirement", () => {
    assert.equal(DEFAULT_SPREAD, 10);
  });
});
