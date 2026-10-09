"use strict";

/**
 * CitizenWeaverGuildLife.test.js — the slow tick never throws, collects dues
 * from real inventories, settles certifications FIFO, and inspects ateliers.
 *
 * Run: node server/plugins/citizens/lib/CitizenWeaverGuildLife.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["varrock"],
    kingdomIdOf: () => "varrock",
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const fakeCareers = { careers: new Map() };
const careersPath = path.resolve(__dirname, "./CitizenCareers.js");
require.cache[careersPath] = {
  id: careersPath, filename: careersPath, loaded: true,
  exports: { careerOf: (u) => fakeCareers.careers.get(String(u || "").toLowerCase()) || null },
};

const fakeRunways = {
  designers: new Set(),
  houses: new Map(),
  collections: new Map(),
  ateliers: Object.create(null),
};
const runwaysPath = path.resolve(__dirname, "./CitizenRunways.js");
require.cache[runwaysPath] = {
  id: runwaysPath, filename: runwaysPath, loaded: true,
  exports: {
    isDesigner: (u) => fakeRunways.designers.has(String(u || "").toLowerCase()),
    houseForDesigner: () => null,
    collectionFor: (id) => fakeRunways.collections.get(String(id)) || null,
    collectionsIn: (kid) =>
      [...fakeRunways.collections.values()].filter((c) => String(c.kingdomId).toLowerCase() === String(kid).toLowerCase()),
    ateliersIn: (kid) => fakeRunways.ateliers[kid] || [],
    runwayTileFor: () => ({ x: 3210, y: 3210, z: 0 }),
  },
};

const fakeRep = { awarded: [] };
const repPath = path.resolve(__dirname, "./CitizenReputation.js");
require.cache[repPath] = {
  id: repPath, filename: repPath, loaded: true,
  exports: { awardDeed: (u, d) => { fakeRep.awarded.push([String(u), d]); } },
};

const saidPublic = [];
const sayPublicPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[sayPublicPath] = {
  id: sayPublicPath, filename: sayPublicPath, loaded: true,
  exports: { sayPublic: (bot, text) => { saidPublic.push(String(text)); } },
};

// --- real modules under test ---

const Guilds = require("./CitizenWeaverGuilds.js");
const Life = require("./CitizenWeaverGuildLife.js");

const fakeInv = new Map(); // username -> coins
function botFor(name) {
  const key = String(name).toLowerCase();
  return {
    username: name,
    inventory: {
      getAmount: (id) => (id === Guilds.COINS_ID ? (fakeInv.get(key) ?? 0) : 0),
      count: (id) => (id === Guilds.COINS_ID ? (fakeInv.get(key) ?? 0) : 0),
      remove: (id, n) => {
        if (id !== Guilds.COINS_ID) return false;
        const have = fakeInv.get(key) ?? 0;
        fakeInv.set(key, Math.max(0, have - n));
        return true;
      },
    },
  };
}
function fakeDirector(players) {
  return {
    roster: { values: () => players.map((p) => ({ username: p })) },
    isOnline: () => true,
    getBot: (r) => botFor(r?.username ?? ""),
    sayPublic: () => {},
  };
}

function fresh() {
  Guilds.resetForTests();
  Life.resetForTests();
  saidPublic.length = 0;
  fakeCareers.careers = new Map();
  fakeRunways.designers.clear();
  fakeRunways.houses.clear();
  fakeRunways.collections.clear();
  fakeRunways.ateliers = Object.create(null);
  fakeInv.clear();
  fakeRep.awarded = [];
}

function makeDesigner(name) {
  fakeRunways.designers.add(String(name).toLowerCase());
}

let passed = 0;
function check(name, fn) {
  fresh();
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.stack.split("\n").slice(0, 3).join("\n  ")}`); process.exitCode = 1; }
}

// --- tick contracts ---

check("tick never throws on an empty world", () => {
  Life.tickWeaverGuildLife(fakeDirector([]), Date.now());
});

check("tick collects dues from online members with real coins", () => {
  makeDesigner("Anya");
  Guilds.joinGuild("Anya", "varrock");
  Guilds.memberOf("Anya").duesPaidUntilMs = Date.now() - 1000; // dues due
  fakeInv.set("anya", 100);
  Life.tickWeaverGuildLife(fakeDirector(["Anya"]), Date.now());
  assert.strictEqual(fakeInv.get("anya"), 75);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 20);
  assert.strictEqual(Guilds.guildOf("varrock").atelierFund, 5);
});

check("tick never penalizes offline members", () => {
  makeDesigner("Anya");
  Guilds.joinGuild("Anya", "varrock");
  const before = Guilds.memberOf("Anya").missedDues;
  Life.tickWeaverGuildLife(fakeDirector([]), Date.now());
  assert.strictEqual(Guilds.memberOf("Anya").missedDues, before);
});

check("tick settles queued certifications FIFO", () => {
  makeDesigner("Anya");
  Guilds.joinGuild("Anya", "varrock");
  Guilds.guildOf("varrock").treasury = 1000;
  fakeRunways.collections.set("c1", { id: "c1", name: "One", designer: "Anya", kingdomId: "varrock", quality: 9, createdAt: Date.now() });
  fakeRunways.collections.set("c2", { id: "c2", name: "Two", designer: "Anya", kingdomId: "varrock", quality: 6, createdAt: Date.now() });
  Guilds.submitCollection("Anya", "varrock", "c1", Date.now());
  Guilds.submitCollection("Anya", "varrock", "c2", Date.now());
  Life.tickWeaverGuildLife(fakeDirector(["Anya"]), Date.now());
  assert.strictEqual(Guilds.gradeFor("varrock", "c1"), "A");
  assert.strictEqual(Guilds.gradeFor("varrock", "c2"), "B");
});

check("tick auto-reports knockoffs and announces them", () => {
  fakeRunways.collections.set("c1", { id: "c1", name: "The Golden Collection", designer: "Anya", kingdomId: "varrock", quality: 7, createdAt: 1000 });
  fakeRunways.collections.set("c2", { id: "c2", name: "The Golden Collection", designer: "Marco", kingdomId: "varrock", quality: 3, createdAt: 2000 });
  makeDesigner("Anya");
  Life.tickWeaverGuildLife(fakeDirector(["Anya"]), Date.now());
  const cases = Object.values(Guilds.serialize().cases);
  assert.strictEqual(cases.length, 1);
  assert.ok(saidPublic.some((t) => /knockoff/i.test(t)));
});

check("tick runs atelier inspections and flags idle shops", () => {
  fakeRunways.ateliers["varrock"] = [
    { owner: "alice", inventory: [{ pieceId: "1:0", sold: true }] },
  ];
  Life.tickWeaverGuildLife(fakeDirector(["Anya"]), Date.now());
  assert.strictEqual(Guilds.inspectionFor("varrock"), 0);
  assert.ok(saidPublic.some((t) => /style audit/i.test(t)));
});

check("tick grants the golden needle quarterly", () => {
  makeDesigner("Anya");
  Guilds.joinGuild("Anya", "varrock");
  const g = Guilds.guildOf("varrock");
  g.treasury = 1000;
  g.lastNeedleAt = 0;
  fakeRunways.collections.set("c1", { id: "c1", name: "One", designer: "Anya", kingdomId: "varrock", quality: 8, createdAt: Date.now() });
  Guilds.submitCollection("Anya", "varrock", "c1", Date.now());
  Guilds.settleCertification("varrock", "c1", Date.now());
  Life.tickWeaverGuildLife(fakeDirector(["Anya"]), Date.now());
  assert.ok(fakeRep.awarded.some(([u, d]) => u === "Anya" && d === "needlegrand"));
});

console.log(`\n${passed} tests passed`);
