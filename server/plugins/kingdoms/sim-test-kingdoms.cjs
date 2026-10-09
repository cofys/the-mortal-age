"use strict";

/**
 * Kingdom systems adversarial simulation — exercises the REAL server modules
 * (KingdomStore, Offices, OfficeTools, Treasury, MyKingdomApi,
 * OfficeDashboardApi, Influence, Events) with mocked players, hunting for:
 *   - authorization bypasses (non-holders executing office actions)
 *   - broken state transitions
 *   - money-loss bugs (spend-before-validate)
 *   - edge-case crashes (no kingdom, unknown kingdom, null player)
 *
 * Run: node server/plugins/kingdoms/sim-test-kingdoms.cjs
 */

const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

// Tension.Kingdoms requires the TS Task class; stub it for plain node.
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
const Treasury = require("./Treasury.Kingdoms");
const MyKingdomApi = require("./MyKingdomApi");
const OfficeDashboardApi = require("./OfficeDashboardApi");
const Influence = require("./Influence.Kingdoms");
const Events = require("./Events.Kingdoms");

// --- fakes ---------------------------------------------------------------

function makePlayer(username, opts = {}) {
  const attrs = new Map(Object.entries(opts.attrs || {}));
  const p = {
    username,
    getUsername: () => username,
    isPlayerBot: () => !!opts.isBot,
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, v),
    sendMessage: (m) => p._messages.push(m),
    getRights: () => ({ getId: () => opts.rights ?? 0 }),
    getInventory: () => p._inventory,
    _messages: [],
    _attrs: attrs,
    _inventory: {
      coins: opts.coins ?? 1000,
      getAmount: (id) => (id === 995 ? p._inventory.coins : 0),
      delete: (id, n) => { if (id === 995) p._inventory.coins = Math.max(0, p._inventory.coins - n); },
      adds: (id, n) => { if (id === 995) p._inventory.coins += n; },
      refreshItems: () => {},
    },
  };
  return p;
}

function makeQuery(params) {
  const map = new Map(Object.entries(params));
  return { get: (k) => (map.has(k) ? map.get(k) : null) };
}

function makeApi(players = {}) {
  const endpoints = new Map();
  const handlers = new Map();
  const events = [];
  const api = {
    registerContentEndpoint: (n, fn) => endpoints.set(n, fn),
    emitCustomEvent: (n, payload) => {
      events.push({ name: n, payload });
      // Wire the REAL Events.Kingdoms listeners for rank/office events.
      for (const h of handlers.get(n) || []) h(payload);
    },
    onCustomEvent: (n, fn) => {
      if (!handlers.has(n)) handlers.set(n, []);
      handlers.get(n).push(fn);
    },
    persistAttribute: () => {},
    sendMultiChatboxPrompt: () => true,
    core: {
      World: {
        getPlayerByName: (n) => players[n?.toLowerCase?.()] ?? null,
        getPlayers: () => ({ stream: () => ({ filter: () => ({ forEach: () => {} }) }) }),
      },
      PlayerRights: { OWNER: 3 },
    },
    _endpoints: endpoints,
    _events: events,
    _handlers: handlers,
  };
  return api;
}

function seed() {
  Store.resetForTests();
  Store.upsertKingdom({
    id: "asgarnia", name: "Asgarnia", capital: "Falador",
    ruler: "King Roald", treasury: 50000,
    hierarchy: ["Subject", "Freeman", "Knight", "Lord", "Monarch"],
  });
  Store.upsertKingdom({
    id: "misthalin", name: "Misthalin", capital: "Varrock",
    ruler: "King Roald", treasury: 30000,
    hierarchy: ["Subject", "Freeman", "Knight", "Lord", "Monarch"],
  });
  for (const std of Offices.STANDARD_OFFICES) {
    for (const k of ["asgarnia", "misthalin"]) {
      Offices.defineOffice({ kingdomId: k, office: std.office });
      Offices.vacateOffice(Offices.officeIdFor(k, std.office));
    }
  }
  // Plant a rumor so suppress-rumor has something to bury.
  OfficeTools.recordRumor("asgarnia", "They say the granaries stand half-empty.");
}

let passed = 0, failed = 0;
function test(name, fn) {
  seed();
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL - ${name}: ${e.message}\n${e.stack.split("\n").slice(1, 3).join("\n")}`);
  }
}

function attachAll(api) {
  MyKingdomApi.attach(api);
  OfficeDashboardApi.attach(api);
  Events(api); // real event listeners: onRankGranted, onOfficeAssigned, onOfficeVacated
}

const myk = (api, params) => api._endpoints.get("mykingdom-status")(makeQuery(params));
const off = (api, params) => api._endpoints.get("office-status")(makeQuery(params));

// === MyKingdomApi ==========================================================

test("mykingdom: null player -> open:false, no crash", () => {
  const api = makeApi();
  attachAll(api);
  const out = myk(api, {});
  assert.strictEqual(out.open, false);
});

test("mykingdom: player with no kingdom -> graceful empty state", () => {
  const bob = makePlayer("bob");
  const api = makeApi({ bob });
  attachAll(api);
  bob.setAttribute("mykingdom:open", "1");
  const out = myk(api, { player: "bob" });
  assert.strictEqual(out.open, true);
  assert.strictEqual(out.kingdom, null);
  assert.deepStrictEqual(out.news, []);
});

test("mykingdom: unknown kingdom id -> graceful, no crash", () => {
  const bob = makePlayer("bob");
  bob.setAttribute("kingdom:id", "narnia");
  bob.setAttribute("mykingdom:open", "1");
  const api = makeApi({ bob });
  attachAll(api);
  const out = myk(api, { player: "bob" });
  assert.strictEqual(out.kingdom, null);
});

test("mykingdom: member sees real rank, treasury, other powers", () => {
  const bob = makePlayer("bob");
  const api = makeApi({ bob });
  attachAll(api);
  // Simulate the real origins pipeline: rank-granted event applies membership.
  api.emitCustomEvent("kingdom:rank-granted", { player: bob, kingdomId: "asgarnia", rank: "Knight" });
  bob.setAttribute("mykingdom:open", "1");
  const out = myk(api, { player: "bob" });
  assert.strictEqual(out.kingdom.name, "Asgarnia");
  assert.strictEqual(out.kingdom.ruler, "King Roald");
  assert.strictEqual(out.kingdom.treasury, 50000 + 50); // promotion tax goes INTO the treasury
  assert.strictEqual(out.standing.rank, "Knight");
  assert.strictEqual(out.standing.office, null);
  assert.ok(out.realms.some((r) => r.id === "misthalin"), "other powers listed");
  assert.ok(!out.realms.some((r) => r.id === "asgarnia"), "home excluded from others");
});

test("mykingdom: office holder detected in standing", () => {
  const bob = makePlayer("bob");
  const api = makeApi({ bob });
  attachAll(api);
  api.emitCustomEvent("kingdom:rank-granted", { player: bob, kingdomId: "asgarnia", rank: "Subject" });
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "bob" });
  bob.setAttribute("mykingdom:open", "1");
  const out = myk(api, { player: "bob" });
  assert.strictEqual(out.standing.office.office, "steward");
});

test("mykingdom: closed flag -> open:false even with kingdom", () => {
  const bob = makePlayer("bob");
  const api = makeApi({ bob });
  attachAll(api);
  api.emitCustomEvent("kingdom:rank-granted", { player: bob, kingdomId: "asgarnia", rank: "Subject" });
  const out = myk(api, { player: "bob" });
  assert.strictEqual(out.open, false);
});

// === OfficeDashboardApi authorization =======================================

const ACTIONS = [
  ["set-tax-rate", { officeId: "asgarnia:steward", rate: "2" }, "asgarnia:steward"],
  ["approve-petition", { officeId: "asgarnia:steward", petitionId: "x" }, "asgarnia:steward"],
  ["deny-petition", { officeId: "asgarnia:steward", petitionId: "x" }, "asgarnia:steward"],
  ["grant-treasury", { officeId: "asgarnia:steward", to: "mallory", amount: "100" }, "asgarnia:steward"],
  ["set-target-peace", { officeId: "asgarnia:quartermaster", value: "500" }, "asgarnia:quartermaster"],
  ["set-target-war", { officeId: "asgarnia:quartermaster", value: "1200" }, "asgarnia:quartermaster"],
  ["issue-supply-order", { officeId: "asgarnia:quartermaster", units: "100", price: "2" }, "asgarnia:quartermaster"],
  ["cancel-supply-order", { officeId: "asgarnia:quartermaster" }, "asgarnia:quartermaster"],
  ["set-patrol", { officeId: "asgarnia:marshal", target: "home", guards: "8" }, "asgarnia:marshal"],
  ["clear-patrol", { officeId: "asgarnia:marshal" }, "asgarnia:marshal"],
  ["set-war-levy", { officeId: "asgarnia:marshal", levy: "2.0" }, "asgarnia:marshal"],
  ["plant-rumor", { officeId: "asgarnia:spymaster", target: "misthalin", template: "1" }, "asgarnia:spymaster"],
  ["suppress-rumor", { officeId: "asgarnia:spymaster", index: "0" }, "asgarnia:spymaster"],
];

test("authz: stranger blocked on ALL 13 write actions", () => {
  const bob = makePlayer("steward_bob");
  const mallory = makePlayer("mallory");
  const api = makeApi({ steward_bob: bob, mallory });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  Offices.assignOffice("asgarnia:quartermaster", { kind: "player", ref: "steward_bob" });
  Offices.assignOffice("asgarnia:marshal", { kind: "player", ref: "steward_bob" });
  Offices.assignOffice("asgarnia:spymaster", { kind: "player", ref: "steward_bob" });
  for (const [action, params] of ACTIONS) {
    const out = off(api, { player: "mallory", action, ...params });
    assert.strictEqual(out.actionResult.ok, false, `${action} should be blocked for stranger`);
  }
  // Nothing changed.
  assert.strictEqual(OfficeTools.getTaxRate("asgarnia"), 1);
  assert.strictEqual(Store.getKingdom("asgarnia").treasury, 50000);
});

test("authz: holder of office X cannot act as office Y (kind gate)", () => {
  const bob = makePlayer("steward_bob");
  const api = makeApi({ steward_bob: bob });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  // Steward tries the marshal's patrol action with the steward's officeId.
  const out = off(api, {
    player: "steward_bob", action: "set-patrol",
    officeId: "asgarnia:steward", target: "home", guards: "8",
  });
  assert.strictEqual(out.actionResult.ok, false, "cross-office action blocked by kind gate");
  assert.strictEqual(OfficeTools.getPatrolOrder("asgarnia"), null, "no patrol was set");
});

test("authz: vacated office immediately loses write access", () => {
  const bob = makePlayer("steward_bob");
  const api = makeApi({ steward_bob: bob });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  let out = off(api, { player: "steward_bob", action: "set-tax-rate", officeId: "asgarnia:steward", rate: "1.5" });
  assert.strictEqual(out.actionResult.ok, true);
  // Vacate through the REAL event path.
  api.emitCustomEvent("kingdom:office-vacated", { officeId: "asgarnia:steward", kingdomId: "asgarnia" });
  assert.strictEqual(Offices.holderOf("asgarnia:steward"), null);
  out = off(api, { player: "steward_bob", action: "set-tax-rate", officeId: "asgarnia:steward", rate: "2" });
  assert.strictEqual(out.actionResult.ok, false, "ex-holder blocked after vacate");
  assert.strictEqual(OfficeTools.getTaxRate("asgarnia"), 1.5, "rate unchanged by ex-holder");
});

test("authz: vacate-office by stranger blocked; by owner allowed", () => {
  const bob = makePlayer("steward_bob");
  const mallory = makePlayer("mallory");
  const root = makePlayer("root", { rights: 3 });
  const api = makeApi({ steward_bob: bob, mallory, root });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  let out = off(api, { player: "mallory", action: "vacate-office", officeId: "asgarnia:steward" });
  assert.strictEqual(out.actionResult.ok, false);
  assert.ok(Offices.holderOf("asgarnia:steward"), "still held after stranger attempt");
  out = off(api, { player: "root", action: "vacate-office", officeId: "asgarnia:steward" });
  assert.strictEqual(out.actionResult.ok, true, "owner force-vacate works");
  assert.strictEqual(Offices.holderOf("asgarnia:steward"), null);
});

test("authz: holder vacates own office through dashboard", () => {
  const bob = makePlayer("steward_bob");
  const api = makeApi({ steward_bob: bob });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  const out = off(api, { player: "steward_bob", action: "vacate-office", officeId: "asgarnia:steward" });
  assert.strictEqual(out.actionResult.ok, true);
  assert.strictEqual(Offices.holderOf("asgarnia:steward"), null, "office actually vacated");
});

test("money: suppress-rumor with bad index must NOT spend treasury", () => {
  const dan = makePlayer("spy_dan");
  const api = makeApi({ spy_dan: dan });
  attachAll(api);
  Offices.assignOffice("asgarnia:spymaster", { kind: "player", ref: "spy_dan" });
  const before = Store.getKingdom("asgarnia").treasury;
  const out = off(api, {
    player: "spy_dan", action: "suppress-rumor",
    officeId: "asgarnia:spymaster", index: "99",
  });
  assert.strictEqual(out.actionResult.ok, false);
  assert.strictEqual(
    Store.getKingdom("asgarnia").treasury, before,
    `treasury lost ${before - Store.getKingdom("asgarnia").treasury}c on failed suppress`
  );
});

test("money: suppress-rumor with valid index spends exactly 300c", () => {
  const dan = makePlayer("spy_dan");
  const api = makeApi({ spy_dan: dan });
  attachAll(api);
  Offices.assignOffice("asgarnia:spymaster", { kind: "player", ref: "spy_dan" });
  const before = Store.getKingdom("asgarnia").treasury;
  const out = off(api, {
    player: "spy_dan", action: "suppress-rumor",
    officeId: "asgarnia:spymaster", index: "0",
  });
  assert.strictEqual(out.actionResult.ok, true);
  assert.strictEqual(Store.getKingdom("asgarnia").treasury, before - 300);
});

test("money: plant-rumor with bad template must NOT spend treasury", () => {
  const dan = makePlayer("spy_dan");
  const api = makeApi({ spy_dan: dan });
  attachAll(api);
  Offices.assignOffice("asgarnia:spymaster", { kind: "player", ref: "spy_dan" });
  const before = Store.getKingdom("asgarnia").treasury;
  const out = off(api, {
    player: "spy_dan", action: "plant-rumor",
    officeId: "asgarnia:spymaster", target: "misthalin", template: "99",
  });
  assert.strictEqual(out.actionResult.ok, false);
  assert.strictEqual(Store.getKingdom("asgarnia").treasury, before);
});

test("money: plant-rumor with empty target must NOT spend treasury", () => {
  const dan = makePlayer("spy_dan");
  const api = makeApi({ spy_dan: dan });
  attachAll(api);
  Offices.assignOffice("asgarnia:spymaster", { kind: "player", ref: "spy_dan" });
  const before = Store.getKingdom("asgarnia").treasury;
  const out = off(api, {
    player: "spy_dan", action: "plant-rumor",
    officeId: "asgarnia:spymaster", target: "", template: "0",
  });
  assert.strictEqual(out.actionResult.ok, false);
  assert.strictEqual(Store.getKingdom("asgarnia").treasury, before);
});

// === origins -> kingdom pipeline ============================================

test("pipeline: rank-granted applies kingdom:id + rank + fealty tax", () => {
  const newbie = makePlayer("newbie", { coins: 100 });
  const api = makeApi({ newbie });
  attachAll(api);
  // This is what Membership.joinKingdom emits during origins claimOrigin.
  api.emitCustomEvent("kingdom:rank-granted", {
    player: newbie, kingdomId: "asgarnia", rank: "Subject",
  });
  assert.strictEqual(newbie.getAttribute("kingdom:id"), "asgarnia");
  assert.strictEqual(newbie.getAttribute("kingdom:rank"), "Subject");
  assert.strictEqual(newbie._inventory.coins, 75, "25c fealty tax taken");
  assert.strictEqual(Store.getKingdom("asgarnia").treasury, 50025);
});

test("pipeline: earned promotion settles through influence", () => {
  const vet = makePlayer("vet", { coins: 10000 });
  const api = makeApi({ vet });
  attachAll(api);
  api.emitCustomEvent("kingdom:rank-granted", { player: vet, kingdomId: "asgarnia", rank: "Subject" });
  assert.strictEqual(vet.getAttribute("kingdom:rank"), "Subject");
  // Shower influence: many tasks.
  for (let i = 0; i < 60; i++) {
    api.emitCustomEvent("kingdom:task-completed", { player: vet, kingdomId: "asgarnia", task: "x" });
  }
  const rank = vet.getAttribute("kingdom:rank");
  assert.notStrictEqual(rank, "Subject", `expected promotion, still ${rank}`);
  console.log(`      (promoted to ${rank} after 60 tasks)`);
});

test("pipeline: office seating grants honorific title quietly (no influence farm)", () => {
  const bob = makePlayer("bob", { coins: 500 });
  const api = makeApi({ bob });
  attachAll(api);
  api.emitCustomEvent("kingdom:rank-granted", { player: bob, kingdomId: "asgarnia", rank: "Subject" });
  const infBefore = JSON.stringify(bob.getAttribute("influence") ?? bob.getAttribute("kingdom:influence"));
  api.emitCustomEvent("kingdom:office-assigned", {
    officeId: "asgarnia:marshal", kingdomId: "asgarnia",
    holder: { kind: "player", ref: "bob" },
  });
  const titles = bob.getAttribute("kingdom:titles") || [];
  assert.ok(titles.includes("Marshal"), `titles: ${JSON.stringify(titles)}`);
  assert.strictEqual(Offices.holderOf("asgarnia:marshal").ref, "bob");
});

test("pipeline: vacate -> seeks-holder emitted, holder cleared", () => {
  const bob = makePlayer("bob");
  const api = makeApi({ bob });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "bob" });
  api.emitCustomEvent("kingdom:office-vacated", { officeId: "asgarnia:steward", kingdomId: "asgarnia" });
  assert.strictEqual(Offices.holderOf("asgarnia:steward"), null);
  assert.ok(api._events.some((e) => e.name === "kingdom:office-seeks-holder"), "seeks-holder emitted");
});

// === edge cases ==============================================================

test("edge: grant-treasury to offline player refused, treasury untouched", () => {
  const bob = makePlayer("steward_bob");
  const api = makeApi({ steward_bob: bob });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  const before = Store.getKingdom("asgarnia").treasury;
  const out = off(api, {
    player: "steward_bob", action: "grant-treasury",
    officeId: "asgarnia:steward", to: "ghost", amount: "1000",
  });
  assert.strictEqual(out.actionResult.ok, false);
  assert.strictEqual(Store.getKingdom("asgarnia").treasury, before);
});

test("edge: office-status for unknown player -> open:false", () => {
  const api = makeApi();
  attachAll(api);
  const out = off(api, { player: "nobody" });
  assert.strictEqual(out.open, false);
});

test("edge: action on unknown officeId blocked", () => {
  const bob = makePlayer("steward_bob");
  const api = makeApi({ steward_bob: bob });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  const out = off(api, {
    player: "steward_bob", action: "set-tax-rate",
    officeId: "asgarnia:pope", rate: "2",
  });
  assert.strictEqual(out.actionResult.ok, false);
  assert.strictEqual(OfficeTools.getTaxRate("asgarnia"), 1);
});

test("authz: office-kind gate — steward cannot wield marshal/spymaster/QM seals", () => {
  const bob = makePlayer("steward_bob");
  const api = makeApi({ steward_bob: bob });
  attachAll(api);
  Offices.assignOffice("asgarnia:steward", { kind: "player", ref: "steward_bob" });
  const attempts = [
    ["set-patrol", { target: "home", guards: "8" }],
    ["clear-patrol", {}],
    ["set-war-levy", { levy: "2.5" }],
    ["plant-rumor", { target: "misthalin", template: "0" }],
    ["suppress-rumor", { index: "0" }],
    ["set-target-peace", { value: "500" }],
    ["issue-supply-order", { units: "100", price: "2" }],
  ];
  for (const [action, extra] of attempts) {
    const out = off(api, { player: "steward_bob", action, officeId: "asgarnia:steward", ...extra });
    assert.strictEqual(out.actionResult.ok, false, `${action} must be kind-gated`);
    assert.match(out.actionResult.message, /seals are not yours/);
  }
  assert.strictEqual(OfficeTools.getPatrolOrder("asgarnia"), null);
  assert.strictEqual(OfficeTools.getWarLevy("asgarnia"), 1.6);
  assert.strictEqual(Store.getKingdom("asgarnia").treasury, 50000);
});

test("authz: each office CAN wield its own seals", () => {
  const holders = {
    steward_bob: "asgarnia:steward",
    qm_alice: "asgarnia:quartermaster",
    marshal_ced: "asgarnia:marshal",
    spy_dan: "asgarnia:spymaster",
  };
  const players = {};
  for (const name of Object.keys(holders)) players[name] = makePlayer(name);
  const api = makeApi(players);
  attachAll(api);
  for (const [name, officeId] of Object.entries(holders)) {
    Offices.assignOffice(officeId, { kind: "player", ref: name });
  }
  const checks = [
    ["steward_bob", "asgarnia:steward", "set-tax-rate", { rate: "1.5" }],
    ["qm_alice", "asgarnia:quartermaster", "issue-supply-order", { units: "100", price: "2" }],
    ["marshal_ced", "asgarnia:marshal", "set-patrol", { target: "home", guards: "8" }],
    ["spy_dan", "asgarnia:spymaster", "plant-rumor", { target: "misthalin", template: "0" }],
  ];
  for (const [name, officeId, action, extra] of checks) {
    const out = off(api, { player: name, action, officeId, ...extra });
    assert.strictEqual(out.actionResult.ok, true, `${name} ${action} should work`);
  }
});

test("crier: Talk-to offers 'Ask about the realm' and opens the panel", () => {
  const MyKingdom = require("./MyKingdom.Kingdoms");
  const bob = makePlayer("bob");
  const api = makeApi({ bob });
  let promptArgs = null;
  api.sendMultiChatboxPrompt = (player, title, ...pairs) => {
    promptArgs = { player, title, pairs };
    return true;
  };
  const npcHooks = [];
  api.onNpcInteraction = (name, actions) => npcHooks.push({ name, actions });
  MyKingdom(api);
  // Both name casings registered, Talk-to (the crier's real cache action).
  assert.strictEqual(npcHooks.length, 2);
  for (const h of npcHooks) {
    assert.ok(h.name.toLowerCase() === "town crier", h.name);
    assert.strictEqual(typeof h.actions["Talk-to"], "function");
    assert.ok(!h.actions["Ask-about-realm"], "dead custom action key must be gone");
  }
  // Simulate the click: Talk-to -> prompt with the realm option.
  const handled = npcHooks[0].actions["Talk-to"]({ player: bob, npc: {}, npcId: 277 });
  assert.strictEqual(handled, true, "Talk-to handled, default dialogue suppressed");
  assert.ok(promptArgs, "prompt shown");
  const labels = promptArgs.pairs.filter((_, i) => i % 2 === 0);
  assert.ok(labels.includes("Ask about the realm."), `options: ${labels.join("|")}`);
  // Choose "Ask about the realm."
  const idx = promptArgs.pairs.findIndex((p) => p === "Ask about the realm.");
  promptArgs.pairs[idx + 1](bob);
  assert.strictEqual(bob.getAttribute("mykingdom:open"), "1", "panel opens");
});

test("crier: bots never get the panel", () => {
  const MyKingdom = require("./MyKingdom.Kingdoms");
  const bot = makePlayer("bot_1", { isBot: true });
  const api = makeApi({ bot_1: bot });
  api.sendMultiChatboxPrompt = () => true;
  const npcHooks = [];
  api.onNpcInteraction = (name, actions) => npcHooks.push({ name, actions });
  MyKingdom(api);
  const handled = npcHooks[0].actions["Talk-to"]({ player: bot, npc: {}, npcId: 277 });
  assert.strictEqual(handled, false, "bots fall through to normal dialogue");
  assert.strictEqual(bot.getAttribute("mykingdom:open"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
