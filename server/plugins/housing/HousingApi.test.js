"use strict";

/**
 * HousingApi.test.js — plain-node tests for the housing data layer.
 *
 * Verifies: claim gating (kingdom required, coins required, real coin
 * deduction), door mode writes to the house save, payload shape, and that
 * every failure path returns safely.
 */

const path = require("path");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok -", name);
  } catch (e) {
    failed++;
    console.log("  FAIL -", name, ":", e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// --- Stub KingdomStore via require.cache ------------------------------------
const storePath = require.resolve("../kingdoms/KingdomStore.js");
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    getKingdom: (id) =>
      id === "misthalin" ? { id: "misthalin", name: "Misthalin" } : null,
    getKingdoms: () => [{ id: "misthalin", name: "Misthalin" }],
  },
};

const api = require("./HousingApi");
const T = api._test;

function makePlayer(attrs, coins) {
  let coinBalance = coins;
  return {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getUsername: () => "TestPlayer",
    isPlayerBot: () => false,
    sendMessage: () => {},
    getInventory: () => ({
      getAmount: (id) => (id === 995 ? coinBalance : 0),
      delete: (id, n) => {
        if (id === 995) coinBalance -= n;
      },
    }),
    _coins: () => coinBalance,
  };
}

function houseSave() {
  return {
    owned: true,
    rooms: [
      [
        [
          { roomKey: "PARLOUR", rotation: 0, furniture: {} },
          { roomKey: "CHAPEL", rotation: 0, furniture: {} },
        ],
      ],
    ],
  };
}

test("claim requires kingdom membership", () => {
  const p = makePlayer({}, 100000);
  const r = T.claimPlot(p);
  assert(r.ok === false, "claim blocked");
  assert(/kingdom/i.test(r.error), "error mentions kingdom");
  assert(p._coins() === 100000, "no coins taken");
});

test("claim requires 25k coins", () => {
  const p = makePlayer({ "kingdom:id": "misthalin" }, 1000);
  const r = T.claimPlot(p);
  assert(r.ok === false, "claim blocked");
  assert(p._coins() === 1000, "no coins taken");
});

test("claim takes real coins and writes plot", () => {
  const attrs = { "kingdom:id": "misthalin" };
  const p = makePlayer(attrs, 30000);
  const r = T.claimPlot(p);
  assert(r.ok === true, "claim ok");
  assert(p._coins() === 5000, `coins deducted, got ${p._coins()}`);
  const plot = JSON.parse(attrs["housing:plot"]);
  assert(plot.kingdomId === "misthalin", "plot kingdom");
  assert(plot.kingdomName === "Misthalin", "plot kingdom name");
  assert(attrs["housing:housewarming"] === "1", "housewarming flag set");
});

test("claim is idempotent", () => {
  const attrs = {
    "kingdom:id": "misthalin",
    "housing:plot": JSON.stringify({ kingdomId: "misthalin" }),
  };
  const p = makePlayer(attrs, 100000);
  const r = T.claimPlot(p);
  assert(r.ok === false, "second claim blocked");
  assert(p._coins() === 100000, "no coins taken twice");
});

test("door mode writes to house save", () => {
  const save = houseSave();
  const p = makePlayer({ "construction:house": save }, 0);
  const r = T.setDoorMode(p, 0);
  assert(r.ok === true, "door mode ok");
  assert(save.doorMode === 0, "save updated");
  const r2 = T.setDoorMode(p, 2);
  assert(r2.ok === true && save.doorMode === 2, "mode 2 ok");
});

test("door mode rejects bad values", () => {
  const p = makePlayer({ "construction:house": houseSave() }, 0);
  const r = T.setDoorMode(p, 5);
  assert(r.ok === false, "bad mode rejected");
});

test("door mode requires a house", () => {
  const p = makePlayer({}, 0);
  const r = T.setDoorMode(p, 1);
  assert(r.ok === false, "no house -> blocked");
});

test("boons reflect real rooms", () => {
  const boons = T.boonsFor(houseSave());
  const skills = boons.map((b) => b.skill);
  assert(skills.includes("Prayer"), "chapel -> prayer boon");
  assert(!skills.includes("Crafting"), "no workshop -> no crafting boon");
  assert(T.boonsFor(null).length === 0, "null save -> no boons");
});

test("payload shape", () => {
  const attrs = {
    "kingdom:id": "misthalin",
    "housing:plot": JSON.stringify({ kingdomId: "misthalin", kingdomName: "Misthalin" }),
    "construction:house": houseSave(),
  };
  const p = makePlayer(attrs, 0);
  const payload = T.buildPayload(p);
  assert(payload.plot.kingdomId === "misthalin", "plot in payload");
  assert(payload.house.roomCount === 2, "room count");
  assert(payload.house.value === 51000, `value ${payload.house.value}`);
  assert(payload.house.tier.key === "cottage", "tier");
  assert(payload.boons.length === 1, "one boon");
  assert(payload.plotCost === 25000, "plot cost exposed");
});

test("plotOf handles bad JSON", () => {
  const p = makePlayer({ "housing:plot": "{broken" }, 0);
  const payload = T.buildPayload(p);
  assert(payload.plot === null, "bad json -> null plot, no throw");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
