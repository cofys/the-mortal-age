"use strict";

/**
 * OfficeDashboardApi.test — plain-node tests for the office-holder
 * dashboard endpoint. Uses the real KingdomStore / Offices / OfficeTools
 * modules (they are pure data + flag logic, no api reference needed for
 * the paths under test).
 */

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");

// Tension.Kingdoms requires the TS Task class; stub it for plain node.
const TASK_PATH = path.resolve(
  __dirname,
  "../../src/main/typescript/elvarg/game/task/Task"
);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");
const OfficeTools = require("./OfficeTools.Kingdoms");
const Api = require("./OfficeDashboardApi");

// --- save isolation ----------------------------------------------------------
// Store.resetForTests() sets persist=false: no save file is written.

// --- fakes -------------------------------------------------------------------

function makePlayer(username, opts = {}) {
  const attrs = new Map();
  return {
    username,
    getUsername: () => username,
    isPlayerBot: () => !!opts.isBot,
    getAttribute: (k) => attrs.get(k) ?? null,
    setAttribute: (k, v) => attrs.set(k, v),
    sendMessage: () => {},
    getRights: () => ({ getId: () => 0 }),
    getInventory: () => ({
      getAmount: () => 100000,
      delete: () => {},
      deleteNumber: () => {},
      adds: () => {},
    }),
  };
}

function makeQuery(params) {
  const map = new Map(Object.entries(params));
  return { get: (k) => map.get(k) ?? null };
}

function makeApi() {
  const endpoints = new Map();
  const events = [];
  return {
    registerContentEndpoint: (name, fn) => endpoints.set(name, fn),
    emitCustomEvent: (name, payload) => events.push({ name, payload }),
    onCustomEvent: () => {},
    core: { World: { getPlayerByName: () => null } },
    _endpoints: endpoints,
    _events: events,
  };
}

function seedKingdom() {
  Store.resetForTests();
  Store.upsertKingdom({
    id: "asgarnia",
    name: "Asgarnia",
    capital: "Falador",
    ruler: "King Roald",
    treasury: 50000,
  });
  for (const std of Offices.STANDARD_OFFICES) {
    Offices.defineOffice({ kingdomId: "asgarnia", office: std.office });
    Offices.vacateOffice(Offices.officeIdFor("asgarnia", std.office));
  }
}

let passed = 0;
function test(name, fn) {
  seedKingdom();
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.error(`  FAIL - ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

// --- tests -------------------------------------------------------------------

test("closed by default: open:false, no offices", () => {
  const api = makeApi();
  Api.attach(api);
  const player = makePlayer("nobody");
  const out = api._endpoints.get("office-status")(makeQuery({ player: "nobody" }));
  // findPlayer returns null (no World) -> open:false
  assert.strictEqual(out.open, false);
});

test("open action sets the attribute", () => {
  const api = makeApi();
  const player = makePlayer("steward_bob");
  api.core.World.getPlayerByName = (n) => (n === "steward_bob" ? player : null);
  Api.attach(api);
  const out = api._endpoints.get("office-status")(
    makeQuery({ player: "steward_bob", action: "open" })
  );
  assert.strictEqual(player.getAttribute("office:open"), "1");
  assert.deepStrictEqual(out.heldOffices, []);
});

test("close action clears the attribute", () => {
  const api = makeApi();
  const player = makePlayer("steward_bob");
  player.setAttribute("office:open", "1");
  api.core.World.getPlayerByName = (n) => (n === "steward_bob" ? player : null);
  Api.attach(api);
  api._endpoints.get("office-status")(
    makeQuery({ player: "steward_bob", action: "close" })
  );
  assert.strictEqual(player.getAttribute("office:open"), "");
});

test("held office appears with steward data", () => {
  const api = makeApi();
  const player = makePlayer("steward_bob");
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  api.core.World.getPlayerByName = (n) => (n === "steward_bob" ? player : null);
  Api.attach(api);
  const out = api._endpoints.get("office-status")(makeQuery({ player: "steward_bob" }));
  assert.strictEqual(out.heldOffices.length, 1);
  const held = out.heldOffices[0];
  assert.strictEqual(held.office, "steward");
  assert.strictEqual(held.kingdomName, "Asgarnia");
  assert.strictEqual(held.data.kind, "steward");
  assert.strictEqual(held.data.treasury, 50000);
  assert.strictEqual(held.data.taxRate, 1);
});

test("steward set-tax-rate writes real policy", () => {
  const api = makeApi();
  const player = makePlayer("steward_bob");
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  api.core.World.getPlayerByName = (n) => (n === "steward_bob" ? player : null);
  Api.attach(api);
  const out = api._endpoints.get("office-status")(
    makeQuery({ player: "steward_bob", action: "set-tax-rate", officeId: "asgarnia:steward", rate: "1.5" })
  );
  assert.strictEqual(out.actionResult.ok, true);
  assert.strictEqual(OfficeTools.getTaxRate("asgarnia"), 1.5);
});

test("steward set-tax-rate rejects invalid rate", () => {
  const api = makeApi();
  const player = makePlayer("steward_bob");
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  api.core.World.getPlayerByName = (n) => (n === "steward_bob" ? player : null);
  Api.attach(api);
  const out = api._endpoints.get("office-status")(
    makeQuery({ player: "steward_bob", action: "set-tax-rate", officeId: "asgarnia:steward", rate: "3" })
  );
  assert.strictEqual(out.actionResult.ok, false);
  assert.strictEqual(OfficeTools.getTaxRate("asgarnia"), 1);
});

test("non-holder cannot set tax rate", () => {
  const api = makeApi();
  const player = makePlayer("mallory");
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  api.core.World.getPlayerByName = (n) => (n === "mallory" ? player : null);
  Api.attach(api);
  const out = api._endpoints.get("office-status")(
    makeQuery({ player: "mallory", action: "set-tax-rate", officeId: "asgarnia:steward", rate: "2" })
  );
  assert.strictEqual(out.actionResult.ok, false);
  assert.strictEqual(OfficeTools.getTaxRate("asgarnia"), 1);
});

test("quartermaster supply order round-trips", () => {
  const api = makeApi();
  const player = makePlayer("qm_alice");
  Offices.assignOffice("asgarnia:quartermaster", { kind: "player", ref: "qm_alice" });
  api.core.World.getPlayerByName = (n) => (n === "qm_alice" ? player : null);
  Api.attach(api);
  let out = api._endpoints.get("office-status")(
    makeQuery({
      player: "qm_alice",
      action: "issue-supply-order",
      officeId: "asgarnia:quartermaster",
      units: "250",
      price: "2",
    })
  );
  assert.strictEqual(out.actionResult.ok, true);
  assert.strictEqual(OfficeTools.getSupplyOrder("asgarnia").units, 250);
  out = api._endpoints.get("office-status")(
    makeQuery({ player: "qm_alice", action: "cancel-supply-order", officeId: "asgarnia:quartermaster" })
  );
  assert.strictEqual(out.actionResult.ok, true);
  assert.strictEqual(OfficeTools.getSupplyOrder("asgarnia"), null);
});

test("marshal patrol order round-trips", () => {
  const api = makeApi();
  const player = makePlayer("marshal_ced");
  Offices.assignOffice("asgarnia:marshal", { kind: "player", ref: "marshal_ced" });
  api.core.World.getPlayerByName = (n) => (n === "marshal_ced" ? player : null);
  Api.attach(api);
  let out = api._endpoints.get("office-status")(
    makeQuery({
      player: "marshal_ced",
      action: "set-patrol",
      officeId: "asgarnia:marshal",
      target: "home",
      guards: "8",
    })
  );
  assert.strictEqual(out.actionResult.ok, true);
  assert.strictEqual(OfficeTools.getPatrolOrder("asgarnia").guards, 8);
  out = api._endpoints.get("office-status")(
    makeQuery({ player: "marshal_ced", action: "set-war-levy", officeId: "asgarnia:marshal", levy: "2.0" })
  );
  assert.strictEqual(out.actionResult.ok, true);
  assert.strictEqual(OfficeTools.getWarLevy("asgarnia"), 2.0);
});

test("spymaster plant-rumor spends treasury and records", () => {
  const api = makeApi();
  const player = makePlayer("spy_dan");
  Offices.assignOffice("asgarnia:spymaster", { kind: "player", ref: "spy_dan" });
  api.core.World.getPlayerByName = (n) => (n === "spy_dan" ? player : null);
  Api.attach(api);
  const before = Store.getKingdom("asgarnia").treasury;
  const out = api._endpoints.get("office-status")(
    makeQuery({
      player: "spy_dan",
      action: "plant-rumor",
      officeId: "asgarnia:spymaster",
      target: "asgarnia",
      template: "0",
    })
  );
  assert.strictEqual(out.actionResult.ok, true);
  assert.strictEqual(Store.getKingdom("asgarnia").treasury, before - 200);
  assert.ok(OfficeTools.getRumors("asgarnia").length >= 1);
});

test("vacant offices listed for petition", () => {
  const api = makeApi();
  const player = makePlayer("ambitious_eve");
  api.core.World.getPlayerByName = (n) => (n === "ambitious_eve" ? player : null);
  Api.attach(api);
  const out = api._endpoints.get("office-status")(makeQuery({ player: "ambitious_eve" }));
  assert.ok(out.vacantOffices.length >= 4);
  assert.ok(out.vacantOffices.every((v) => v.officeId && v.title));
});

test("unknown action returns null actionResult", () => {
  const api = makeApi();
  const player = makePlayer("steward_bob");
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  api.core.World.getPlayerByName = (n) => (n === "steward_bob" ? player : null);
  Api.attach(api);
  const out = api._endpoints.get("office-status")(
    makeQuery({ player: "steward_bob", action: "frobnicate", officeId: "asgarnia:steward" })
  );
  assert.strictEqual(out.actionResult, null);
});

console.log(`\n${passed} tests passed`);
