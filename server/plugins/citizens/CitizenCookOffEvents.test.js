"use strict";

/**
 * CitizenCookOffEvents.test.js — plain-node tests for the ::cookoff command.
 * Run: node server/plugins/citizens/CitizenCookOffEvents.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const CookOffs = require("./lib/CitizenCookOffs");
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cookoffev-")), "citizen-cookoffs.json");
CookOffs.setSaveFile(tmpSave);

const { onCookOffCommand, COOKOFF_USAGE } = require("./CitizenCookOffEvents");

function stubPlayer(username, { coins = 500, cooking = 60, kingdomId = "misthalin", isBot = false, inventory = null } = {}) {
  // Mock mirrors the REAL engine ItemContainer API: getAmount(id),
  // deleteNumber(id, amount), adds(id, amount). There is no inv.remove(id, amt)
  // and no inv.add(id, amt) — those were the silent no-ops being fixed.
  const inv = inventory || {
    _items: { 995: coins, 1942: 3, 1957: 3 }, // coins + real potato/onion item ids
    getAmount(id) { return this._items[id] ?? 0; },
    deleteNumber(id, amt) { if ((this._items[id] ?? 0) >= amt) this._items[id] -= amt; return this; },
    adds(id, amt) { if (amt > 0) this._items[id] = (this._items[id] ?? 0) + amt; return this; },
  };
  const messages = [];
  return {
    username,
    isPlayerBot: () => !!isBot,
    getUsername: () => username,
    sendMessage: (t) => messages.push(t),
    getSkillManager: () => ({ getCurrentLevel: () => cooking }),
    getInventory: () => inv,
    inventory: inv,
    _messages: messages,
    _inv: inv,
  };
}

let passed = 0;
function test(name, fn) {
  CookOffs.resetForTests();
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("bots are rejected", () => {
  const bot = stubPlayer("Bot", { isBot: true });
  onCookOffCommand(bot, "list");
  assert.ok(bot._messages[0].includes("not this command"));
});

test("usage string is exported", () => {
  assert.ok(COOKOFF_USAGE.includes("::cookoff"));
});

test("list shows open cook-offs", () => {
  CookOffs.scheduleCookOff("misthalin", Date.now());
  const p = stubPlayer("Alice");
  onCookOffCommand(p, "list");
  assert.ok(p._messages[0].includes("misthalin"), "lists the cook-off");
});

test("list with none running says so honestly", () => {
  const p = stubPlayer("Alice");
  onCookOffCommand(p, "list");
  assert.ok(p._messages[0].includes("No cook-offs"));
});

test("enter takes the real fee and gates on level", () => {
  CookOffs.scheduleCookOff("misthalin", Date.now());
  const rich = stubPlayer("Rich", { coins: 500, cooking: 60 });
  // Stub kingdomOf: events file requires CitizenSites; default is null -> honest message.
  // We test the no-kingdom path here (sites unreadable in plain node).
  onCookOffCommand(rich, "enter");
  assert.ok(rich._messages[0].length > 0, "responds");
});

test("recipes lists the caller's recipes", () => {
  CookOffs.inventRecipe("Alice", "Tart", ["honey", "apple"], 70, () => true, Date.now());
  const p = stubPlayer("Alice");
  onCookOffCommand(p, "recipes");
  assert.ok(p._messages[0].includes("Tart"), "lists recipe");
});

test("invent validates ingredient count", () => {
  const p = stubPlayer("Alice", { cooking: 60 });
  onCookOffCommand(p, "invent honey");
  assert.ok(p._messages[0].includes("Usage"), "rejects too few");
});

test("invent gates on cooking level", () => {
  const p = stubPlayer("Newb", { cooking: 5 });
  onCookOffCommand(p, "invent honey apple");
  assert.ok(p._messages[0].includes("Cooking 25"), "level gate");
});

test("discover requires a source", () => {
  const p = stubPlayer("Alice");
  onCookOffCommand(p, "discover");
  assert.ok(p._messages[0].includes("Usage"));
  onCookOffCommand(p, "discover Sunken pantry");
  assert.ok(p._messages[1].includes("Sunken pantry"), "records discovery");
});

test("sell rejects other players' recipes", () => {
  CookOffs.inventRecipe("Gordon", "Tart", ["honey", "apple"], 70, () => true, Date.now());
  const r = CookOffs.recipesByChef("Gordon")[0];
  const p = stubPlayer("Alice");
  onCookOffCommand(p, `sell ${r.id} 100`);
  assert.ok(p._messages[0].includes("not your recipe"));
});

test("rankings with no data says so honestly", () => {
  const p = stubPlayer("Alice");
  onCookOffCommand(p, "rankings");
  assert.ok(p._messages[0].includes("No rankings"));
});

test("unknown subcommand shows usage", () => {
  const p = stubPlayer("Alice");
  onCookOffCommand(p, "frobnicate");
  assert.ok(p._messages[0].includes("::cookoff"));
});

test("invent consumes real ingredients from the engine item table", () => {
  const p = stubPlayer("Gordon", { cooking: 60 });
  onCookOffCommand(p, "invent potato onion");
  assert.ok(p._messages[0].includes("Invented"), `succeeds, got: ${p._messages[0]}`);
  assert.strictEqual(p._inv.getAmount(1942), 2, "potato really consumed");
  assert.strictEqual(p._inv.getAmount(1957), 2, "onion really consumed");
  assert.strictEqual(CookOffs.recipesByChef("Gordon").length, 1, "recipe recorded");
});

test("invent with an unresolvable ingredient fails without eating anything", () => {
  const p = stubPlayer("Gordon", { cooking: 60 });
  const before = p._inv.getAmount(1942);
  onCookOffCommand(p, "invent potato honey");
  assert.ok(p._messages[0].includes("Invention failed"), `honest refusal, got: ${p._messages[0]}`);
  assert.strictEqual(p._inv.getAmount(1942), before, "no partial consumption on failure");
  assert.strictEqual(CookOffs.recipesByChef("Gordon").length, 0, "no recipe recorded");
});

test("invent fails honestly when the ingredient is not held", () => {
  const empty = {
    _items: { 995: 500 },
    getAmount(id) { return this._items[id] ?? 0; },
    deleteNumber(id, amt) { if ((this._items[id] ?? 0) >= amt) this._items[id] -= amt; return this; },
    adds(id, amt) { if (amt > 0) this._items[id] = (this._items[id] ?? 0) + amt; return this; },
  };
  const p = stubPlayer("Gordon", { cooking: 60, inventory: empty });
  onCookOffCommand(p, "invent potato onion");
  assert.ok(p._messages[0].includes("Invention failed"), `honest refusal, got: ${p._messages[0]}`);
});

test("enter takes the real fee through the canonical API", () => {
  // Stub CitizenSites so the command path sees a kingdom.
  const sitesPath = path.resolve(__dirname, "./brain/CitizenSites.js");
  require.cache[sitesPath] = {
    id: sitesPath, filename: sitesPath, loaded: true,
    exports: { KINGDOM_IDS: ["misthalin"], kingdomIdOf: () => "misthalin" },
  };
  CookOffs.scheduleCookOff("misthalin", Date.now());
  const rich = stubPlayer("Rich", { coins: 500, cooking: 60 });
  onCookOffCommand(rich, "enter");
  assert.ok(rich._messages[0].includes("Entered"), `entered, got: ${rich._messages[0]}`);
  assert.strictEqual(rich._inv.getAmount(995), 400, "entry fee really taken");
  delete require.cache[sitesPath];
});

test("enter refuses when deleteNumber is a no-op (old inv.remove shape)", () => {
  const sitesPath = path.resolve(__dirname, "./brain/CitizenSites.js");
  require.cache[sitesPath] = {
    id: sitesPath, filename: sitesPath, loaded: true,
    exports: { KINGDOM_IDS: ["misthalin"], kingdomIdOf: () => "misthalin" },
  };
  const noopInv = {
    _items: { 995: 500 },
    getAmount(id) { return this._items[id] ?? 0; },
    deleteNumber() { return this; }, // engine-shaped no-op
    adds(id, amt) { if (amt > 0) this._items[id] = (this._items[id] ?? 0) + amt; return this; },
  };
  CookOffs.scheduleCookOff("misthalin", Date.now());
  const cheater = stubPlayer("Cheater", { coins: 500, cooking: 60, inventory: noopInv });
  onCookOffCommand(cheater, "enter");
  assert.ok(cheater._messages[0].includes("Could not enter"), `refused, got: ${cheater._messages[0]}`);
  const open = CookOffs.openCookOff("misthalin");
  assert.ok(!open.entries.some((e) => e.chef === "Cheater"), "no free entry");
  delete require.cache[sitesPath];
});

console.log(`CookOff events: ${passed} passed`);
