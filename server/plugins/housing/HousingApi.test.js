"use strict";

/**
 * HousingApi.test.js — plain-node tests for the housing data layer.
 *
 * Verifies: residence resolution, the 5k move (fee, real coin deduction,
 * contents preserved because the engine house save is untouched), retired
 * plot migration (grandfathering), door mode writes to the house save,
 * payload shape, and that every failure path returns safely.
 */

const api = require("./HousingApi");
const T = api._test;

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
    _attrs: () => attrs,
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

test("residenceOf resolves towns, tolerates missing", () => {
  const p = makePlayer({ "housing:residence": "alkharid" }, 0);
  assert(T.residenceOf(p).name === "Al Kharid", "resolves");
  assert(T.residenceOf(makePlayer({}, 0)) === null, "missing -> null");
  assert(T.residenceOf(makePlayer({ "housing:residence": "nope" }, 0)) === null, "unknown -> null");
});

test("move requires 5k coins", () => {
  const p = makePlayer({ "housing:residence": "misthalin" }, 1000);
  const r = T.moveResidence(p, "alkharid");
  assert(r.ok === false, "move blocked");
  assert(p._coins() === 1000, "no coins taken");
  assert(p._attrs()["housing:residence"] === "misthalin", "residence unchanged");
});

test("move takes real coins and switches residence", () => {
  const save = houseSave();
  const attrs = { "housing:residence": "misthalin", "construction:house": save };
  const p = makePlayer(attrs, 8000);
  const r = T.moveResidence(p, "alkharid");
  assert(r.ok === true, "move ok");
  assert(p._coins() === 3000, `coins deducted, got ${p._coins()}`);
  assert(attrs["housing:residence"] === "alkharid", "residence switched");
  assert(attrs["construction:house"] === save, "house save untouched — contents move with them");
  assert(r.town.name === "Al Kharid", "town returned");
});

test("move rejects unknown towns and same town", () => {
  const p = makePlayer({ "housing:residence": "misthalin" }, 100000);
  assert(T.moveResidence(p, "nope").ok === false, "unknown town blocked");
  assert(T.moveResidence(p, "misthalin").ok === false, "same town blocked");
  assert(p._coins() === 100000, "no coins taken");
});

test("move works with no prior residence", () => {
  const p = makePlayer({}, 6000);
  const r = T.moveResidence(p, "shilo");
  assert(r.ok === true, "move ok");
  assert(p._attrs()["housing:residence"] === "shilo", "residence set");
});

test("retired plot migrates to residence and is deleted", () => {
  const attrs = {
    "housing:plot": JSON.stringify({ kingdomId: "misthalin", kingdomName: "Misthalin" }),
  };
  const p = makePlayer(attrs, 0);
  T.migrateRetiredPlot(p);
  assert(attrs["housing:residence"] === "misthalin", "residence grandfathered");
  assert(!attrs["housing:plot"], "plot attribute deleted");
  // Idempotent: second run changes nothing.
  T.migrateRetiredPlot(p);
  assert(attrs["housing:residence"] === "misthalin", "still grandfathered");
});

test("retired plot with bogus kingdom does not strand", () => {
  const attrs = { "housing:plot": JSON.stringify({ kingdomId: "nope" }) };
  const p = makePlayer(attrs, 0);
  T.migrateRetiredPlot(p);
  assert(!attrs["housing:plot"], "plot deleted");
  assert(!attrs["housing:residence"], "no bogus residence");
});

test("buildPayload migrates on read", () => {
  const attrs = {
    "housing:plot": JSON.stringify({ kingdomId: "kandarin", kingdomName: "Kandarin" }),
    "construction:house": houseSave(),
  };
  const p = makePlayer(attrs, 0);
  const payload = T.buildPayload(p);
  assert(payload.residence && payload.residence.id === "kandarin", "migrated residence in payload");
  assert(!attrs["housing:plot"], "plot deleted on read");
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
    "housing:residence": "misthalin",
    "construction:house": houseSave(),
  };
  const p = makePlayer(attrs, 0);
  const payload = T.buildPayload(p);
  assert(payload.residence.id === "misthalin", "residence in payload");
  assert(payload.residence.name === "Varrock", "residence name");
  assert(payload.towns.length === 13, `13 towns, got ${payload.towns.length}`);
  assert(payload.moveCost === 5000, "move cost exposed");
  assert(!("plot" in payload), "no plot in payload");
  assert(!("plotCost" in payload), "no plotCost in payload");
  assert(payload.house.roomCount === 2, "room count");
  assert(payload.house.value === 51000, `value ${payload.house.value}`);
  assert(payload.house.tier.key === "cottage", "tier");
  assert(payload.boons.length === 1, "one boon");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
