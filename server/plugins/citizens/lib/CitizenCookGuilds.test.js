"use strict";

/**
 * CitizenCookGuilds.test.js — guild data-tier contracts without a running server.
 * The sites, careers, cuisine, and cookoffs modules are stubbed in the
 * require cache so plain-node tests stay engine-free.
 *
 * Run: node server/plugins/citizens/lib/CitizenCookGuilds.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- stubs (must be installed before requiring the guild module) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["varrock", "falador"],
    kingdomIdOf: () => "varrock",
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

// Controllable fake of the real CitizenCareers data tier.
const fakeCareers = { careers: new Map() };
const careersPath = path.resolve(__dirname, "./CitizenCareers.js");
require.cache[careersPath] = {
  id: careersPath, filename: careersPath, loaded: true,
  exports: {
    careerOf: (u) => fakeCareers.careers.get(String(u || "").toLowerCase()) || null,
  },
};

// Controllable fake of the real CitizenCuisine data tier.
const fakeCuisine = {
  masterChefs: new Set(),
  menus: Object.create(null), // kingdomId -> [dishId]
  dishes: Object.create(null), // dishId -> { id, quality, chefName }
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

// Controllable fake of the real CitizenCookOffs data tier.
const fakeCookOffs = { recipes: new Map() }; // id -> recipe
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

// --- real module under test ---

const Guilds = require("./CitizenCookGuilds.js");

function fresh() {
  Guilds.resetForTests();
  fakeCareers.careers = new Map();
  fakeCuisine.masterChefs = new Set();
  fakeCuisine.menus = Object.create(null);
  fakeCuisine.dishes = Object.create(null);
  fakeCookOffs.recipes = new Map();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cookguild-"));
  Guilds.setSaveFile(path.join(tmp, "save.json"));
}

function makeChef(name) {
  fakeCareers.careers.set(String(name).toLowerCase(), { career: "chef" });
}

function makeRecipe(id, inventor, quality, createdAt) {
  fakeCookOffs.recipes.set(id, {
    id, name: `Recipe ${id}`, inventor, ingredients: ["a", "b"],
    quality, source: "invented", createdAt: createdAt ?? Date.now(),
  });
}

let passed = 0;
function check(name, fn) {
  fresh();
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.stack.split("\n").slice(0, 3).join("\n  ")}`); process.exitCode = 1; }
}

// --- guilds ---

check("ensureGuild creates a hall and treasury", () => {
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g.hallTile && typeof g.hallTile.x === "number", "hall tile");
  assert.strictEqual(g.treasury, 0);
  assert.strictEqual(g.hygiene, 100);
});

check("joinGuild requires a real chef", () => {
  const no = Guilds.joinGuild("Gordon", "varrock");
  assert.strictEqual(no.ok, false);
  assert.strictEqual(no.reason, "not-a-chef");
  makeChef("Gordon");
  const yes = Guilds.joinGuild("Gordon", "varrock");
  assert.strictEqual(yes.ok, true);
  assert.strictEqual(yes.rank, Guilds.RANK_APPRENTICE);
});

check("joinGuild accepts master chefs and recipe holders", () => {
  fakeCuisine.masterChefs.add("escoffier");
  assert.strictEqual(Guilds.joinGuild("Escoffier", "varrock").ok, true);
  makeRecipe("r-1", "Heston", 7);
  assert.strictEqual(Guilds.joinGuild("Heston", "varrock").ok, true);
});

check("joinGuild rejects duplicates", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  const again = Guilds.joinGuild("Gordon", "varrock");
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, "already-member");
});

check("dues payment credits treasury and hygiene fund", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  const res = Guilds.recordDuesPayment("Gordon", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), Guilds.DUES_WEEKLY - 5);
  assert.strictEqual(Guilds.guildOf("varrock").hygieneFund, 5);
});

check("two missed dues suspend the member", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.recordMissedDues("Gordon", Date.now());
  const res = Guilds.recordMissedDues("Gordon", Date.now());
  assert.strictEqual(res.suspended, true);
  assert.strictEqual(Guilds.memberOf("Gordon").suspended, true);
});

// --- certification ---

check("submitRecipe verifies against the real ledger", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  const missing = Guilds.submitRecipe("Gordon", "varrock", "nope", Date.now());
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, "no-such-recipe");
  makeRecipe("r-1", "Heston", 7);
  const notYours = Guilds.submitRecipe("Gordon", "varrock", "r-1", Date.now());
  assert.strictEqual(notYours.ok, false);
  assert.strictEqual(notYours.reason, "not-your-recipe");
  makeRecipe("r-2", "Gordon", 7);
  const ok = Guilds.submitRecipe("Gordon", "varrock", "r-2", Date.now());
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.fee, Guilds.CERT_FEE);
});

check("settleCertification grades by real quality and pays bounty", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.guildOf("varrock").treasury = 1000;
  makeRecipe("r-a", "Gordon", 9);
  Guilds.submitRecipe("Gordon", "varrock", "r-a", Date.now());
  const res = Guilds.settleCertification("varrock", "r-a", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.grade, "A");
  assert.strictEqual(res.paid, Guilds.CERT_BOUNTY.A);
  assert.strictEqual(res.owed, 0);
  assert.strictEqual(Guilds.gradeFor("varrock", "r-a"), "A");
});

check("settleCertification grades B and C honestly", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.guildOf("varrock").treasury = 1000;
  makeRecipe("r-b", "Gordon", 6);
  makeRecipe("r-c", "Gordon", 3);
  Guilds.submitRecipe("Gordon", "varrock", "r-b", Date.now());
  Guilds.submitRecipe("Gordon", "varrock", "r-c", Date.now());
  assert.strictEqual(Guilds.settleCertification("varrock", "r-b", Date.now()).grade, "B");
  assert.strictEqual(Guilds.settleCertification("varrock", "r-c", Date.now()).grade, "C");
});

check("bounty is owed honestly when the guild is broke", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  makeRecipe("r-a", "Gordon", 9);
  Guilds.submitRecipe("Gordon", "varrock", "r-a", Date.now());
  const res = Guilds.settleCertification("varrock", "r-a", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.paid, 0);
  assert.strictEqual(res.owed, Guilds.CERT_BOUNTY.A);
  // retry pays when funds arrive
  Guilds.guildOf("varrock").treasury = 500;
  const retry = Guilds.retryOwedBounties("varrock");
  assert.ok(retry.paid > 0, "owed bounty retried");
});

check("certification rejects impossible quality", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  fakeCookOffs.recipes.set("r-bad", { id: "r-bad", name: "Bad", inventor: "Gordon", ingredients: [], quality: 99, source: "invented", createdAt: Date.now() });
  const res = Guilds.submitRecipe("Gordon", "varrock", "r-bad", Date.now());
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "impossible-quality");
});

check("mentored apprentices certify free and earn double credit", () => {
  makeChef("Gordon");
  makeChef("Auguste");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.joinGuild("Auguste", "varrock");
  const m = Guilds.memberOf("Auguste");
  m.rank = Guilds.RANK_CHEFDECUISINE;
  Guilds.takeApprentice("Auguste", "Gordon");
  makeRecipe("r-m", "Gordon", 6);
  const sub = Guilds.submitRecipe("Gordon", "varrock", "r-m", Date.now());
  assert.strictEqual(sub.fee, 0);
  Guilds.guildOf("varrock").treasury = 1000;
  Guilds.settleCertification("varrock", "r-m", Date.now());
  assert.strictEqual(Guilds.memberOf("Gordon").certCount, 2);
  assert.strictEqual(Guilds.memberOf("Gordon").mentor, null, "mentorship ends after first certification");
});

// --- inspections ---

check("inspectKitchens computes hygiene from real menu data", () => {
  fakeCuisine.menus.varrock = ["d-1", "d-2"];
  fakeCuisine.dishes["d-1"] = { id: "d-1", quality: 8, chefName: "Gordon" };
  fakeCuisine.dishes["d-2"] = { id: "d-2", quality: 2, chefName: "Heston" };
  const res = Guilds.inspectKitchens("varrock", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.inspected, 2);
  assert.strictEqual(res.fails.length, 1);
  assert.strictEqual(res.fails[0].dishId, "d-2");
  assert.strictEqual(res.hygiene, 50);
});

check("empty menu scores perfect hygiene", () => {
  const res = Guilds.inspectKitchens("varrock", Date.now());
  assert.strictEqual(res.hygiene, 100);
});

// --- tribunal ---

check("reportTheft enforces no double jeopardy", () => {
  const a = Guilds.reportTheft("varrock", "Heston", "Gordon");
  assert.strictEqual(a.ok, true);
  const b = Guilds.reportTheft("varrock", "Heston", "Auguste");
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, "case-open");
});

check("voteCase requires chefdecuisine rank", () => {
  makeChef("Gordon");
  makeChef("Auguste");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.joinGuild("Auguste", "varrock");
  const rep = Guilds.reportTheft("varrock", "Heston", "Gordon");
  const vote = Guilds.voteCase(rep.id, "Gordon", true);
  assert.strictEqual(vote.ok, false);
  assert.strictEqual(vote.reason, "not-chefdecuisine");
  Guilds.memberOf("Gordon").rank = Guilds.RANK_CHEFDECUISINE;
  const vote2 = Guilds.voteCase(rep.id, "Gordon", true);
  assert.strictEqual(vote2.ok, true);
});

check("settleRipeCases convicts on quorum and expels", () => {
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
  const settled = Guilds.settleRipeCases("varrock", Date.now() + 25 * 60 * 60 * 1000);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].verdict, "guilty");
  assert.strictEqual(Guilds.memberOf("Heston").suspended, true);
  assert.strictEqual(Guilds.memberOf("Heston").clean, false);
});

// --- ladle ---

check("grantLadle picks the member with most seals", () => {
  makeChef("Gordon");
  makeChef("Heston");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.joinGuild("Heston", "varrock");
  Guilds.guildOf("varrock").treasury = 1000;
  makeRecipe("r-1", "Gordon", 9);
  makeRecipe("r-2", "Gordon", 8);
  makeRecipe("r-3", "Heston", 9);
  Guilds.submitRecipe("Gordon", "varrock", "r-1", Date.now());
  Guilds.submitRecipe("Gordon", "varrock", "r-2", Date.now());
  Guilds.submitRecipe("Heston", "varrock", "r-3", Date.now());
  Guilds.settleCertification("varrock", "r-1", Date.now());
  Guilds.settleCertification("varrock", "r-2", Date.now());
  Guilds.settleCertification("varrock", "r-3", Date.now());
  const res = Guilds.grantLadle("varrock", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.winner, "Gordon");
  assert.strictEqual(res.recipes, 2);
});

// --- school ---

check("tryPromote requires tenure, credits, and a real recipe", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  const m = Guilds.memberOf("Gordon");
  m.joinedAt = Date.now() - 31 * 24 * 3600 * 1000;
  m.trainingCredits = 2;
  const tooSoon = Guilds.tryPromote("Gordon", Date.now());
  assert.strictEqual(tooSoon.ok, false, "no real recipe yet");
  makeRecipe("r-1", "Gordon", 5);
  const ok = Guilds.tryPromote("Gordon", Date.now());
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.rank, Guilds.RANK_SOUSCHEF);
});

check("deedsForChefdecuisine reflects real records", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  assert.deepStrictEqual(Guilds.deedsForChefdecuisine("Nobody"), []);
  const deeds = Guilds.deedsForChefdecuisine("Gordon");
  assert.ok(Array.isArray(deeds));
});

// --- persistence ---

check("save/load round-trips state", () => {
  makeChef("Gordon");
  Guilds.joinGuild("Gordon", "varrock");
  Guilds.guildOf("varrock").treasury = 77;
  assert.strictEqual(Guilds.save(), true);
  Guilds.resetForTests();
  assert.strictEqual(Guilds.isGuildMember("Gordon"), false);
  // point at the same file and reload
  const Guilds2 = require("./CitizenCookGuilds.js");
  // save file path persists across resetForTests; reload via load()
  Guilds.load();
  assert.strictEqual(Guilds.isGuildMember("Gordon"), true);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 77);
});

console.log(`\nCitizenCookGuilds: ${passed} passed`);
