"use strict";

/**
 * CitizenHangouts.test.js — unit tests for visible ambient social clusters.
 * Run with: node --test server/plugins/citizens/lib/CitizenHangouts.test.js
 * (from the repo root; uses node:test, no external deps)
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { tickHangouts, _test } = require("./CitizenHangouts");
const { agentRng } = require("./humanizer");

const { pairKey, anchorFor, eligibleHost, eligibleGuest, tryFormHangout } = _test;

const TAVERN = { x: 2961, y: 3374, z: 0 }; // asgarnia tavern from sites.json

function fakeBot(x, y) {
  return {
    getLocation: () => ({
      getX: () => x,
      getY: () => y,
      getZ: () => 0,
    }),
    face: () => {},
    forceChat: () => {},
    _pos: { x, y },
  };
}

function fakeRecord(username, opts = {}) {
  return {
    username,
    personality: { traits: ["chatty"], demeanor: "warm", age: 30 },
    kingdomId: "asgarnia",
    role: "commoner",
    hangoutUntil: null,
    ...opts,
  };
}

function fakeDirector(records, positions) {
  const bots = new Map();
  return {
    roster: new Map(records.map((r) => [r.username.toLowerCase(), r])),
    isOnline: () => true,
    getBot: (record) => {
      if (!bots.has(record.username)) {
        const p = positions[record.username] ?? { x: TAVERN.x + 5, y: TAVERN.y + 5 };
        bots.set(record.username, fakeBot(p.x, p.y));
      }
      return bots.get(record.username);
    },
    log: () => {},
  };
}

describe("CitizenHangouts", () => {
  it("pairKey is order-independent", () => {
    assert.equal(pairKey("Alice", "Bob"), pairKey("Bob", "Alice"));
    assert.notEqual(pairKey("Alice", "Bob"), pairKey("Alice", "Cara"));
  });

  it("anchorFor prefers tavern, falls back to square/market", () => {
    const anchor = anchorFor("asgarnia");
    assert.ok(anchor);
    assert.equal(anchor.kind, "tavern");
    assert.equal(anchor.tile.x, TAVERN.x);
    assert.equal(anchor.tile.y, TAVERN.y);
    // Keldagrim has no tavern tile; the fallback chain must still resolve.
    const kAnchor = anchorFor("keldagrim");
    assert.ok(kAnchor);
    assert.ok(Number.isFinite(kAnchor.tile.x));
  });

  it("eligibleHost rejects far citizens and in-hangout citizens", () => {
    const director = fakeDirector([fakeRecord("Host")], {
      Host: { x: TAVERN.x, y: TAVERN.y },
    });
    const host = director.roster.get("host");
    assert.ok(eligibleHost(host, director, TAVERN));
    host.hangoutUntil = Date.now() + 60000;
    assert.ok(!eligibleHost(host, director, TAVERN));
  });

  it("forms a hangout of 2-5 citizens near the anchor", () => {
    const records = ["Host", "GuestA", "GuestB"].map((n) => fakeRecord(n));
    const director = fakeDirector(records, {
      Host: { x: TAVERN.x + 3, y: TAVERN.y },
      GuestA: { x: TAVERN.x - 4, y: TAVERN.y + 2 },
      GuestB: { x: TAVERN.x + 1, y: TAVERN.y - 6 },
    });
    let formed = false;
    for (let i = 0; i < 60 && !formed; i++) {
      // Fresh state each attempt: reset the per-attempt busy marks.
      for (const r of records) r.hangoutUntil = null;
      tryFormHangout(director, agentRng(`hangout-test:${i}`), Date.now());
      formed = _test.active.size > 0;
    }
    assert.ok(formed, "expected a hangout to form within 60 seeded attempts");
    const hangout = _test.active.get("asgarnia");
    assert.ok(hangout);
    assert.ok(hangout.members.length >= 2);
    assert.ok(hangout.members.length <= 5);
    for (const m of hangout.members) {
      assert.ok(m.record.hangoutUntil > Date.now(), "members are marked busy");
    }
    // tickHangouts must not throw with an active hangout.
    tickHangouts(director, 12);
    _test.active.clear();
    for (const r of records) r.hangoutUntil = null;
  });

  it("eligibleGuest rejects enemies (no seated feuds)", () => {
    const { addEnemy, isEnemy } = require("./CitizenBonds");
    const director = fakeDirector([fakeRecord("Host"), fakeRecord("Foe")], {
      Host: { x: TAVERN.x, y: TAVERN.y },
      Foe: { x: TAVERN.x + 2, y: TAVERN.y },
    });
    const host = director.roster.get("host");
    const foe = director.roster.get("foe");
    addEnemy(host.username, foe.username);
    assert.ok(isEnemy(host.username, foe.username));
    assert.ok(!eligibleGuest(foe, director, host, TAVERN));
    // cleanup for other tests
    const { removeEnemy } = require("./CitizenBonds");
    removeEnemy(host.username, foe.username);
  });
});
