"use strict";

// Crowd reply model (Jon 2026-10-13): the hard 2-replier cap is replaced by a
// variable crowd — 1 guaranteed + crowd-scaled extras, max 5, busy citizens
// usually keep working.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { crowdReplyCount, selectRepliers, MAX_CROWD_REPLIERS } = require("./CitizenChat");

function botAt(name, x, y) {
  return {
    getUsername: () => name,
    getLocation: () => ({ getX: () => x, getY: () => y }),
  };
}

function speakerAt(x, y) {
  return {
    getUsername: () => "Cofy",
    getLocation: () => ({ getX: () => x, getY: () => y }),
  };
}

test("crowdReplyCount: zero scored -> zero repliers", () => {
  assert.equal(crowdReplyCount(0, 10), 0);
});

test("crowdReplyCount: at least 1 when someone is willing", () => {
  for (let i = 0; i < 20; i++) {
    assert.ok(crowdReplyCount(3, 10) >= 1);
  }
});

test("crowdReplyCount: never exceeds the cap or the scored count", () => {
  for (let i = 0; i < 200; i++) {
    const n = crowdReplyCount(10, 30);
    assert.ok(n >= 1 && n <= MAX_CROWD_REPLIERS);
    assert.ok(crowdReplyCount(2, 30) <= 2);
  }
});

test("crowdReplyCount: bigger crowds pull more responders on average", () => {
  const avg = (nearby) => {
    let sum = 0;
    for (let i = 0; i < 300; i++) sum += crowdReplyCount(10, nearby);
    return sum / 300;
  };
  assert.ok(avg(25) > avg(3), `big crowd avg should exceed small crowd avg`);
});

test("selectRepliers: addressed citizen always replies", () => {
  const citizens = [botAt("Petra Lane", 0, 0), botAt("Harold Finch", 5, 5)];
  const repliers = selectRepliers(citizens, speakerAt(0, 1), "Cofy", "hey petra, how are you?");
  const names = repliers.map((b) => b.getUsername());
  assert.ok(names.includes("Petra Lane"));
});

test("selectRepliers: variable count in a crowd, never a storm", () => {
  const citizens = [];
  for (let i = 0; i < 15; i++) citizens.push(botAt(`Citizen ${i}`, i, 0));
  const counts = new Set();
  for (let i = 0; i < 50; i++) {
    const repliers = selectRepliers(citizens, speakerAt(7, 1), "Cofy", "hello everyone");
    counts.add(repliers.length);
    assert.ok(repliers.length <= MAX_CROWD_REPLIERS);
  }
  assert.ok(counts.size > 1, "responder count should vary across utterances");
});

test("selectRepliers: different citizens speak up across utterances", () => {
  const citizens = [];
  for (let i = 0; i < 8; i++) citizens.push(botAt(`Citizen ${i}`, i, 0));
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    for (const b of selectRepliers(citizens, speakerAt(4, 1), "Cofy", "anyone here?")) {
      seen.add(b.getUsername());
    }
  }
  assert.ok(seen.size > 2, "more than the same 2 citizens should reply over time");
});
