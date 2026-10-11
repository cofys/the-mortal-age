// CitizenJobs unit checks — plain node, no running server.
// From server/plugins/citizens: node lib/CitizenJobs.test.js
const assert = require("node:assert/strict");
const Module = require("node:module");

// Some kingdoms modules transitively require the TS Task class; stub it.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("../../kingdoms/KingdomStore");
const Jobs = require("../../kingdoms/Jobs.Kingdoms");
const CitizenJobs = require("./CitizenJobs");

const K = "kandarin";
const NOW = 1790000000000;

function mockBot(name, coins, inv = {}) {
  const attrs = { "kingdom:id": K };
  const items = { 995: coins, ...inv };
  return {
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getUsername: () => name,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => ({ getX: () => 2660, getY: () => 3290, getZ: () => 0 }),
    getInventory: () => ({
      getAmount: (id) => items[id] ?? 0,
      delete: (id, n) => {
        items[id] = Math.max(0, (items[id] ?? 0) - n);
      },
      deleteNumber: (id, n) => {
        items[id] = Math.max(0, (items[id] ?? 0) - n);
      },
      adds: (id, n) => {
        items[id] = (items[id] ?? 0) + n;
      },
      refreshItems: () => {},
    }),
    sendMessage: () => {},
    _items: () => items,
  };
}

function mockDirector(bots) {
  const roster = new Map();
  const byName = new Map();
  for (const bot of bots) {
    const username = bot.getUsername();
    roster.set(username.toLowerCase(), { username, kingdomId: K });
    byName.set(username, bot);
  }
  return {
    roster,
    getBot: (record) => byName.get(record.username) ?? null,
  };
}

function seed() {
  Store.resetForTests();
  Store.upsertKingdom({ id: K, name: "Kandarin", capital: "East Ardougne" });
  Store.getKingdom(K).treasury = 100000;
  Store.getKingdom(K).flags = {};
  CitizenJobs._test.lastAttemptByCitizen.clear();
}

// 1. A comfortable citizen takes no work.
seed();
{
  const rich = mockBot("Rich", 10000);
  CitizenJobs.tickCitizenJobs(mockDirector([rich]), NOW);
  assert.equal(Jobs.claimsOf("Rich", Store).length, 0, "rich citizen claims nothing");
  console.log("ok - no money pressure, no claim");
}

// 2. A broke citizen claims the peacetime stockpile contract.
seed();
{
  const broke = mockBot("Broke", 10, { 2309: 60 }); // carries bread
  const director = mockDirector([broke]);
  CitizenJobs.tickCitizenJobs(director, NOW);
  const claims = Jobs.claimsOf("Broke", Store);
  assert.equal(claims.length, 1, "broke citizen claims one job");
  assert.equal(claims[0].type, "supply");
  console.log("ok - money pressure claims a supply job");

  // 3. Attributed deliveries + a later tick complete it and pay real coin.
  const job = claims[0];
  Jobs.recordDelivery("Broke", K, "food", job.units, null, Store);
  const coinsBefore = broke._items()[995];
  CitizenJobs.tickCitizenJobs(director, NOW + CitizenJobs.JOBS_COOLDOWN_MS + 1000);
  assert.equal(Jobs.claimsOf("Broke", Store).length, 0, "claim settled");
  const stored = Store.load().jobs.list.find((j) => j.id === job.id);
  assert.equal(stored.status, "done");
  assert.ok(broke._items()[995] > coinsBefore, "treasury-funded reward landed in the purse");
  console.log("ok - delivery attribution completes the job and pays the citizen");
}

// 4. An unmaterialized citizen (no bot object) is never worked.
seed();
{
  const director = {
    roster: new Map([["ghost", { username: "Ghost", kingdomId: K }]]),
    getBot: () => null,
  };
  CitizenJobs.tickCitizenJobs(director, NOW);
  assert.equal(Jobs.claimsOf("Ghost", Store).length, 0);
  console.log("ok - data-tier citizens are skipped (no purse to pay)");
}

console.log("CitizenJobs: all checks passed");
