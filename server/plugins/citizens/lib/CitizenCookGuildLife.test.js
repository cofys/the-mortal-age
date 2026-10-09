"use strict";

/**
 * CitizenCookGuildLife.test.js — the slow tick never throws, charges dues from
 * real inventories, settles certifications FIFO, and inspects kitchens.
 *
 * Run: node server/plugins/citizens/lib/CitizenCookGuildLife.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock"], kingdomIdOf: () => "varrock" },
};

const fakeCareers = { careers: new Map() };
const careersPath = path.resolve(__dirname, "./CitizenCareers.js");
require.cache[careersPath] = {
  id: careersPath, filename: careersPath, loaded: true,
  exports: { careerOf: (u) => fakeCareers.careers.get(String(u || "").toLowerCase()) || null },
};

const fakeCuisine = {
  masterChefs: new Set(),
  menus: Object.create(null),
  dishes: Object.create(null),
};
const cuisinePath = path.resolve(__dirname, "./CitizenCuisine.js");
require.cache[cuisinePath] = {
  id: cuisinePath, filename: cuisinePath, loaded: true,
  exports: {
    isMasterChef: (u) => fakeCuisine.masterChefs.has(String(u || "").toLowerCase()),
    menuFor: (kid) => fakeCuisine.menus[kid] || [],
    dishById: (id) => fakeCuisine.dishes[id] || null,
  },
};

const fakeCookOffs = { recipes: new Map() };
const cookoffsPath = path.resolve(__dirname, "./CitizenCookOffs.js");
require.cache[cookoffsPath] = {
  id: cookoffsPath, filename: cookoffsPath, loaded: true,
  exports: {
    recipeById: (id) => fakeCookOffs.recipes.get(id) || null,
    recipesByChef: (u) => {
      const n = String(u || "").toLowerCase();
      return [...fakeCookOffs.recipes.values()].filter((r) => r.inventor.toLowerCase() === n);
    },
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

const Guilds = require("./CitizenCookGuilds.js");
const Life = require("./CitizenCookGuildLife.js");

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
  fakeCuisine.masterChefs = new Set();
  fakeCuisine.menus = Object.create(null);
  fakeCuisine.dishes = Object.create(null);
  fakeCookOffs.recipes = new Map();
  fakeInv.clear();
  fakeRep.awarded = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cookguild-life-"));
  Guilds.setSaveFile(path.join(tmp, "save.json"));
}

function makeChef(name) {
  fakeCareers.careers.set(String(name).toLowerCase(), { career: "chef" });
}

let passed = 0;
function check(name, fn) {
  fresh();
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.stack.split("\n").slice(0, 3).join("\n  ")}`); process.exitCode = 1; }
}

// --- tick contracts ---

check("tick never throws on an empty world", () => {
  Life.tickCookGuildLife(fakeDirector([]), Date.now());
});

check("tick collects dues from online members with real coins", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.memberOf("Gordon").duesPaidUntilMs = Date.now() - 1000; // dues due
  fakeInv.set("gordon", 100);
  Life.tickCookGuildLife(fakeDirector(["Gordon"]), Date.now());
  assert.strictEqual(fakeInv.get("gordon"), 75);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 20);
  assert.strictEqual(Guilds.guildOf("varrock").hygieneFund, 5);
});

check("tick never penalizes offline members", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  const before = Guilds.memberOf("Gordon").missedDues;
  Life.tickCookGuildLife(fakeDirector([]), Date.now());
  assert.strictEqual(Guilds.memberOf("Gordon").missedDues, before);
});

check("tick settles certifications FIFO, one per tick", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.guildOf("varrock").treasury = 1000;
  fakeCookOffs.recipes.set("r-1", { id: "r-1", name: "One", inventor: "Gordon", ingredients: ["a"], quality: 9, source: "invented", createdAt: Date.now() });
  fakeCookOffs.recipes.set("r-2", { id: "r-2", name: "Two", inventor: "Gordon", ingredients: ["a"], quality: 6, source: "invented", createdAt: Date.now() });
  Guilds.submitRecipe("Gordon", "varrock", "r-1", Date.now());
  Guilds.submitRecipe("Gordon", "varrock", "r-2", Date.now());
  Life.tickCookGuildLife(fakeDirector(["Gordon"]), Date.now());
  const graded = ["r-1", "r-2"].filter((id) => Guilds.gradeFor("varrock", id));
  assert.strictEqual(graded.length, 1, "exactly one settlement per tick");
  assert.strictEqual(graded[0], "r-1", "FIFO order");
});

check("tick pays owed bounties when funds arrive", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  fakeCookOffs.recipes.set("r-1", { id: "r-1", name: "One", inventor: "Gordon", ingredients: ["a"], quality: 9, source: "invented", createdAt: Date.now() });
  Guilds.submitRecipe("Gordon", "varrock", "r-1", Date.now());
  Life.tickCookGuildLife(fakeDirector(["Gordon"]), Date.now()); // broke: owed
  const g = Guilds.guildOf("varrock");
  assert.ok(Object.keys(Guilds.serialize().bountiesOwed).length > 0, "bounty owed while broke");
  g.treasury = 1000;
  Life.tickCookGuildLife(fakeDirector(["Gordon"]), Date.now() + 31 * 60 * 1000);
  assert.strictEqual(Object.keys(Guilds.serialize().bountiesOwed).length, 0, "owed bounty cleared on retry");
});

check("tick inspects kitchens from real menu data", () => {
  fakeCuisine.menus.varrock = ["d-1", "d-2"];
  fakeCuisine.dishes["d-1"] = { id: "d-1", quality: 2, chefName: "Heston" };
  fakeCuisine.dishes["d-2"] = { id: "d-2", quality: 1, chefName: "Heston" };
  Life.tickCookGuildLife(fakeDirector(["Gordon"]), Date.now());
  assert.ok(saidPublic.some((m) => /audit/i.test(m)), "audit announced");
  assert.ok(Guilds.guildOf("varrock").hygiene < 40, "hygiene reflects real menu data");
});

check("tick auto-settles ripe cases and awards the recipethief deed", () => {
  makeChef("Gordon");
  makeChef("Auguste");
  makeChef("Heston");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.joinGuild("Auguste", "varrock");
  Guilds.joinGuild("Heston", "varrock");
  Guilds.memberOf("Gordon").rank = Guilds.RANK_CHEFDECUISINE;
  Guilds.memberOf("Auguste").rank = Guilds.RANK_CHEFDECUISINE;
  const rep = Guilds.reportTheft("varrock", "Heston", "Gordon");
  Guilds.voteCase(rep.id, "Gordon", true);
  Guilds.voteCase(rep.id, "Auguste", true);
  Life.tickCookGuildLife(fakeDirector(["Gordon", "Auguste", "Heston"]), Date.now() + 25 * 3600 * 1000);
  assert.ok(fakeRep.awarded.some(([u, d]) => u === "Heston" && d === "recipethief"),
    "recipethief deed awarded on conviction");
});

check("tick grants the golden ladle and awards the guildchef deed", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.guildOf("varrock").treasury = 1000;
  Guilds.guildOf("varrock").ladleAt = Date.now() - 100 * 24 * 3600 * 1000; // long overdue
  fakeCookOffs.recipes.set("r-1", { id: "r-1", name: "One", inventor: "Gordon", ingredients: ["a"], quality: 9, source: "invented", createdAt: Date.now() });
  Guilds.submitRecipe("Gordon", "varrock", "r-1", Date.now());
  Guilds.settleCertification("varrock", "r-1", Date.now());
  Life.tickCookGuildLife(fakeDirector(["Gordon"]), Date.now());
  assert.ok(fakeRep.awarded.some(([u, d]) => u === "Gordon" && d === "guildchef"),
    "guildchef deed awarded with the ladle");
});

check("tick promotes eligible apprentices", () => {
  makeChef("Gordon");
  makeChef("Auguste");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.joinGuild("Auguste", "varrock");
  Guilds.memberOf("Auguste").rank = Guilds.RANK_CHEFDECUISINE;
  const m = Guilds.memberOf("Gordon");
  m.joinedAt = Date.now() - 31 * 24 * 3600 * 1000;
  m.trainingCredits = 2;
  fakeCookOffs.recipes.set("r-1", { id: "r-1", name: "One", inventor: "Gordon", ingredients: ["a"], quality: 5, source: "invented", createdAt: Date.now() });
  Life.tickCookGuildLife(fakeDirector(["Gordon", "Auguste"]), Date.now());
  assert.strictEqual(Guilds.guildRankOf("Gordon"), Guilds.RANK_SOUSCHEF);
});

check("tick never throws when modules misbehave", () => {
  // poison the cuisine stub to throw
  require.cache[cuisinePath].exports.menuFor = () => { throw new Error("boom"); };
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  Life.tickCookGuildLife(fakeDirector(["Gordon"]), Date.now());
  require.cache[cuisinePath].exports.menuFor = (kid) => fakeCuisine.menus[kid] || [];
});

console.log(`\nCitizenCookGuildLife: ${passed} passed`);
