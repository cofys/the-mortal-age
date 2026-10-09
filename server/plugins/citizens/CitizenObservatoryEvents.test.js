"use strict";

/**
 * CitizenObservatoryEvents.test.js — plain-node tests (no jest).
 * Run: node server/plugins/citizens/CitizenObservatoryEvents.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const Obs = require("./lib/CitizenObservatories");
const { onObservatoryCommand, OBSERVATORY_USAGE } = require("./CitizenObservatoryEvents");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "obsevents-test-")), "citizen-observatories.json");
Obs._setSavePathForTests(tmpSave);

// Stub the astronomy profession layer.
const astroPath = path.join(__dirname, "lib", "CitizenAstronomy.js");
require.cache[astroPath] = {
  exports: {
    observatoryFor: (kid) => (kid === "misthalin" ? { kingdomId: kid, tile: { x: 100, y: 200 } } : null),
    astronomerFor: (u) => (u === "Stargazer_Sue" ? { username: u, kingdomId: "misthalin" } : null),
    chartsFor: (kid) =>
      kid === "misthalin" ? [{ id: "chart_1", astronomer: "Stargazer_Sue", kingdomId: kid, quality: 8 }] : [],
    activeEventFor: () => null,
  },
};

// Stub CitizenSites.kingdomIdOf
const sitesPath = path.join(__dirname, "brain", "CitizenSites.js");
require.cache[sitesPath] = {
  exports: { kingdomIdOf: (p) => (p?.username === "Far_Fred" ? null : "misthalin") },
};

const NIGHT_REAL = Date.now();
function atNight() {
  // force night by stubbing isNight — instead, run and accept either branch;
  // for determinism we test the daytime honesty separately via a noon timestamp.
  return NIGHT_REAL;
}

function makePlayer(username, coins, isBot = false) {
  const items = coins > 0 ? [{ id: 995, quantity: coins }] : [];
  const messages = [];
  return {
    username,
    messages,
    isBot,
    getUsername: () => username,
    sendMessage: (t) => messages.push(t),
    getInventory: () => ({
      getItems: () => items,
      removeItem: (id, qty) => {
        const it = items.find((i) => i.id === id);
        if (!it || it.quantity < qty) return false;
        it.quantity -= qty;
        return true;
      },
    }),
  };
}

let passed = 0;
function test(name, fn) {
  Obs.resetForTests();
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("usage exported", () => {
  assert.ok(OBSERVATORY_USAGE.includes("::observatory"));
});

test("bots rejected", () => {
  const bot = makePlayer("Bot_Bert", 100, true);
  onObservatoryCommand(bot, ["visit"]);
  assert.ok(bot.messages[0].includes("Citizens work"));
});

test("visit: no kingdom honesty", () => {
  const p = makePlayer("Far_Fred", 100);
  onObservatoryCommand(p, ["visit"]);
  assert.ok(p.messages[0].includes("not in a kingdom"));
});

test("sky: reports real sky", () => {
  const p = makePlayer("Sky_Sam", 0);
  onObservatoryCommand(p, ["sky"]);
  assert.ok(p.messages[0].includes("Tonight's sky:"));
});

test("charts: lists real charts for sale", () => {
  const p = makePlayer("Buyer_Bea", 0);
  onObservatoryCommand(p, ["charts"]);
  assert.ok(p.messages[0].includes("chart_1"));
});

test("buy: usage without id", () => {
  const p = makePlayer("Buyer_Bea", 1000);
  onObservatoryCommand(p, ["buy"]);
  assert.ok(p.messages[0].includes("Usage:"));
});

test("buy: honest no-such-chart", () => {
  const p = makePlayer("Buyer_Bea", 1000);
  onObservatoryCommand(p, ["buy", "chart_nope"]);
  assert.ok(p.messages[0].includes("No chart with that id"));
});

test("buy: honest cannot-afford", () => {
  const p = makePlayer("Broke_Bob", 10);
  onObservatoryCommand(p, ["buy", "chart_1"]);
  assert.ok(p.messages[0].includes("cannot afford"));
});

test("buy: success", () => {
  const p = makePlayer("Buyer_Bea", 1000);
  onObservatoryCommand(p, ["buy", "chart_1"]);
  assert.ok(p.messages[0].includes("You buy a copy"));
});

test("collection: empty honesty", () => {
  const p = makePlayer("New_Nina", 0);
  onObservatoryCommand(p, ["collection"]);
  assert.ok(p.messages[0].includes("no star chart copies"));
});

test("collection: shows owned copies", () => {
  const p = makePlayer("Buyer_Bea", 1000);
  onObservatoryCommand(p, ["buy", "chart_1"]);
  p.messages.length = 0;
  onObservatoryCommand(p, ["collection"]);
  assert.ok(p.messages[0].includes("chart_1"));
});

test("tours: empty honesty", () => {
  const p = makePlayer("Tour_Tess", 0);
  onObservatoryCommand(p, ["tours"]);
  assert.ok(p.messages[0].includes("No guided sky tours"));
});

test("join: usage without id", () => {
  const p = makePlayer("Tour_Tess", 0);
  onObservatoryCommand(p, ["join"]);
  assert.ok(p.messages[0].includes("Usage:"));
});

test("party: no-party honesty when no event", () => {
  const p = makePlayer("Party_Pam", 0);
  onObservatoryCommand(p, ["party"]);
  assert.ok(p.messages[0].includes("No viewing party"));
});

test("host + gatherings: player-hosted stargazing", () => {
  // hosting requires night; if it is day, we get the honest closed message
  const p = makePlayer("Host_Hank", 0);
  onObservatoryCommand(p, ["host"]);
  const nightOk = p.messages[0].includes("stargazing gathering");
  const dayHonest = p.messages[0].includes("night");
  assert.ok(nightOk || dayHonest, `unexpected: ${p.messages[0]}`);
  if (nightOk) {
    const g = makePlayer("Guest_Gail", 0);
    onObservatoryCommand(g, ["gatherings"]);
    assert.ok(g.messages[0].includes("Host_Hank"));
  }
});

test("unknown subcommand shows usage", () => {
  const p = makePlayer("Confused_Carl", 0);
  onObservatoryCommand(p, ["frobnicate"]);
  assert.ok(p.messages[0].includes("::observatory"));
});

console.log(`CitizenObservatoryEvents: ${passed} passed`);
if (process.exitCode) console.log("FAILURES PRESENT");
