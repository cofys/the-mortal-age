"use strict";

/**
 * CitizenCookOffs.test.js — plain-node tests for the cook-off data tier.
 * Run: node server/plugins/citizens/lib/CitizenCookOffs.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const CookOffs = require("./CitizenCookOffs");

// Isolate persistence to a temp file.
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cookoff-")), "citizen-cookoffs.json");
CookOffs.setSaveFile(tmpSave);

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

const NOW = 1_700_000_000_000;

test("scheduleCookOff creates a weekly cook-off with a real theme", () => {
  const co = CookOffs.scheduleCookOff("misthalin", NOW);
  assert.ok(co, "cook-off scheduled");
  assert.ok(CookOffs.THEME_KEYS.includes(co.theme), "theme is a real key");
  assert.ok(CookOffs.MYSTERY_THEMES[co.theme].length > 0, "theme has produce");
  // Second schedule too soon -> null.
  assert.strictEqual(CookOffs.scheduleCookOff("misthalin", NOW + 1000), null);
  // Other kingdom is independent.
  assert.ok(CookOffs.scheduleCookOff("asgarnia", NOW));
});

test("openCookOff returns the unresolved cook-off", () => {
  CookOffs.scheduleCookOff("misthalin", NOW);
  const open = CookOffs.openCookOff("misthalin");
  assert.ok(open && open.kingdomId === "misthalin");
  assert.strictEqual(CookOffs.openCookOff("kandarin"), null);
});

test("enterCookOff takes a real entry fee; broke chefs fail honestly", () => {
  const co = CookOffs.scheduleCookOff("misthalin", NOW);
  const rich = () => true;
  const broke = () => false;
  assert.strictEqual(CookOffs.enterCookOff(co.id, "Gordon", rich, NOW), true);
  assert.strictEqual(CookOffs.enterCookOff(co.id, "Gordon", rich, NOW), false, "no double entry");
  assert.strictEqual(CookOffs.enterCookOff(co.id, "Broke", broke, NOW), false, "broke fails honestly");
  assert.strictEqual(CookOffs.cookOffById(co.id).pot, CookOffs.ENTRY_FEE);
});

test("roundScore is deterministic and rewards level + theme recipes", () => {
  const co = CookOffs.scheduleCookOff("misthalin", NOW);
  const a = CookOffs.roundScore(co.id, "appetizer", "Gordon", 80, 0.8);
  const b = CookOffs.roundScore(co.id, "appetizer", "Gordon", 80, 0.8);
  assert.strictEqual(a, b, "deterministic");
  const low = CookOffs.roundScore(co.id, "appetizer", "Novice", 10, 0.1);
  assert.ok(a > low, "higher level scores higher");
  // Recipe bonus: invent a theme recipe first.
  const themeIng = CookOffs.MYSTERY_THEMES[co.theme][0];
  CookOffs.inventRecipe("Gordon", "Theme special", [themeIng, "wheat"], 80, () => true, NOW);
  const withRecipe = CookOffs.roundScore(co.id, "appetizer", "Gordon", 80, 0.8);
  assert.ok(withRecipe >= a, "theme recipe gives a bonus");
});

test("recordRoundScore stores per-round scores on the entry", () => {
  const co = CookOffs.scheduleCookOff("misthalin", NOW);
  CookOffs.enterCookOff(co.id, "Gordon", () => true, NOW);
  const s = CookOffs.recordRoundScore(co.id, "Gordon", "main", 70, 0.5);
  assert.ok(s >= 1 && s <= 100);
  const entry = CookOffs.cookOffById(co.id).entries[0];
  assert.strictEqual(entry.rounds.main, s);
  assert.strictEqual(CookOffs.roundsTotal(entry), s);
  // Unknown chef / bad round -> 0.
  assert.strictEqual(CookOffs.recordRoundScore(co.id, "Nobody", "main", 70, 0.5), 0);
  assert.strictEqual(CookOffs.recordRoundScore(co.id, "Gordon", "pudding", 70, 0.5), 0);
});

test("judgeScore is deterministic and strictness penalizes", () => {
  const co = CookOffs.scheduleCookOff("misthalin", NOW);
  const kind = { name: "Kind", strictness: 0 };
  const strict = { name: "Stern", strictness: 1 };
  const a = CookOffs.judgeScore(co.id, "Gordon", kind, 70);
  const b = CookOffs.judgeScore(co.id, "Gordon", kind, 70);
  assert.strictEqual(a, b, "deterministic");
  const s = CookOffs.judgeScore(co.id, "Gordon", strict, 70);
  assert.ok(s <= a, "strict judges score lower");
});

test("resolveCookOff needs 2+ scored chefs; pays real prizes 70/20/10", () => {
  const co = CookOffs.scheduleCookOff("misthalin", NOW);
  CookOffs.enterCookOff(co.id, "Gordon", () => true, NOW);
  CookOffs.enterCookOff(co.id, "Julia", () => true, NOW);
  CookOffs.enterCookOff(co.id, "Marco", () => true, NOW);
  // Only one chef scored -> unresolvable.
  CookOffs.recordRoundScore(co.id, "Gordon", "appetizer", 90, 0.9);
  const judges = [{ name: "J1", strictness: 0.2 }, { name: "J2", strictness: 0.3 }, { name: "J3", strictness: 0.1 }];
  assert.strictEqual(CookOffs.resolveCookOff(co.id, judges, () => {}, NOW), null);
  // Score everyone across all rounds.
  for (const chef of ["Gordon", "Julia", "Marco"]) {
    for (const round of CookOffs.ROUNDS) {
      CookOffs.recordRoundScore(co.id, chef, round, chef === "Gordon" ? 90 : chef === "Julia" ? 40 : 20, 0.5);
    }
  }
  const paid = {};
  const res = CookOffs.resolveCookOff(co.id, judges, (name, amt) => { paid[name] = amt; }, NOW);
  assert.ok(res, "resolved");
  assert.strictEqual(res.winner, "Gordon", "best chef wins");
  assert.strictEqual(res.placements.length, 3);
  assert.strictEqual(res.pot, CookOffs.ENTRY_FEE * 3);
  assert.strictEqual(paid.Gordon + paid.Julia + paid.Marco, res.pot, "whole pot paid out");
  assert.ok(paid.Gordon > paid.Julia && paid.Julia >= paid.Marco, "70/20/10 split");
  // Resolved twice -> null.
  assert.strictEqual(CookOffs.resolveCookOff(co.id, judges, () => {}, NOW), null);
});

test("resolveCookOff records seasonal rankings", () => {
  const co = CookOffs.scheduleCookOff("misthalin", NOW);
  for (const chef of ["Gordon", "Julia"]) {
    CookOffs.enterCookOff(co.id, chef, () => true, NOW);
    for (const round of CookOffs.ROUNDS) CookOffs.recordRoundScore(co.id, chef, round, 60, 0.5);
  }
  const judges = [{ name: "J1", strictness: 0 }, { name: "J2", strictness: 0 }, { name: "J3", strictness: 0 }];
  CookOffs.resolveCookOff(co.id, judges, () => {}, NOW);
  const season = CookOffs.seasonOf(NOW);
  const ranks = CookOffs.rankingsFor("misthalin", season, 5);
  assert.strictEqual(ranks.length, 2);
  assert.ok(ranks[0].points >= ranks[1].points, "sorted by points");
  assert.strictEqual(ranks[0].wins, 1, "winner has a win");
});

test("inventRecipe consumes real ingredients and scales quality with level", () => {
  const consumed = [];
  const consume = (chef, ing) => { consumed.push(ing); return true; };
  const r = CookOffs.inventRecipe("Gordon", "Honey apple tart", ["honey", "apple", "wheat"], 80, consume, NOW);
  assert.ok(r, "recipe invented");
  assert.strictEqual(r.source, "invented");
  assert.deepStrictEqual(consumed, ["honey", "apple", "wheat"]);
  assert.ok(r.quality >= 1 && r.quality <= 10);
  const weak = CookOffs.inventRecipe("Novice", "Mush", ["wheat", "milk"], 60, () => true, NOW);
  assert.ok(weak.quality <= r.quality, "higher level -> better or equal quality");
  // Too few ingredients / too low level / missing ingredient -> null.
  assert.strictEqual(CookOffs.inventRecipe("Gordon", "X", ["wheat"], 80, () => true, NOW), null);
  assert.strictEqual(CookOffs.inventRecipe("Gordon", "X", ["wheat", "milk"], 10, () => true, NOW), null);
  assert.strictEqual(CookOffs.inventRecipe("Gordon", "X", ["wheat", "milk"], 80, () => false, NOW), null);
});

test("discoverRecipe records exploration-sourced recipes", () => {
  const r = CookOffs.discoverRecipe("Gordon", "Sunken pantry of Karamja", NOW);
  assert.ok(r, "discovered");
  assert.strictEqual(r.source, "discovered");
  assert.ok(r.name.includes("Sunken pantry of Karamja"));
  assert.ok(r.quality >= 3 && r.quality <= 8);
  const again = CookOffs.discoverRecipe("Gordon", "Sunken pantry of Karamja", NOW);
  assert.strictEqual(again.quality, r.quality, "deterministic");
});

test("recipesByChef / recipeById read back records", () => {
  CookOffs.inventRecipe("Gordon", "Tart", ["honey", "apple"], 70, () => true, NOW);
  CookOffs.discoverRecipe("Julia", "Old cellar", NOW);
  assert.strictEqual(CookOffs.recipesByChef("Gordon").length, 1);
  assert.strictEqual(CookOffs.recipesByChef("Julia").length, 1);
  const r = CookOffs.recipesByChef("Gordon")[0];
  assert.strictEqual(CookOffs.recipeById(r.id).id, r.id);
  assert.strictEqual(CookOffs.recipeById("nope"), null);
});

test("sellRecipe moves real coins and transfers ownership", () => {
  const r = CookOffs.inventRecipe("Gordon", "Tart", ["honey", "apple"], 70, () => true, NOW);
  const money = { Julia: 500, Gordon: 0 };
  const take = (name, amt) => { if ((money[name] ?? 0) < amt) return false; money[name] -= amt; return true; };
  const give = (name, amt) => { money[name] = (money[name] ?? 0) + amt; };
  assert.strictEqual(CookOffs.sellRecipe(r.id, "Julia", 200, take, give), true);
  assert.strictEqual(money.Julia, 300);
  assert.strictEqual(money.Gordon, 200);
  assert.strictEqual(CookOffs.recipeById(r.id).inventor, "Julia", "ownership transferred");
  // Broke buyer fails honestly; self-buy rejected.
  const r2 = CookOffs.inventRecipe("Gordon", "Pie", ["wheat", "milk"], 70, () => true, NOW);
  assert.strictEqual(CookOffs.sellRecipe(r2.id, "Broke", 200, take, give), false);
  assert.strictEqual(CookOffs.sellRecipe(r2.id, "Gordon", 200, take, give), false);
});

test("listRecipe / buyListedRecipe trade listed recipes honestly", () => {
  const r = CookOffs.inventRecipe("Gordon", "Tart", ["honey", "apple"], 70, () => true, NOW);
  assert.strictEqual(CookOffs.listRecipe(r.id, 150), true);
  assert.strictEqual(CookOffs.listRecipe(r.id, 0), false, "no free listings");
  assert.strictEqual(CookOffs.listedRecipes().length, 1);
  const money = { Julia: 100, Gordon: 0 };
  const take = (name, amt) => { if ((money[name] ?? 0) < amt) return false; money[name] -= amt; return true; };
  const give = (name, amt) => { money[name] = (money[name] ?? 0) + amt; return true; };
  assert.strictEqual(CookOffs.buyListedRecipe(r.id, "Julia", take, give), false, "broke buyer fails");
  money.Julia = 500;
  assert.strictEqual(CookOffs.buyListedRecipe(r.id, "Julia", take, give), true);
  assert.strictEqual(money.Julia, 350);
  assert.strictEqual(money.Gordon, 150);
  assert.strictEqual(CookOffs.recipeById(r.id).inventor, "Julia");
  assert.strictEqual(CookOffs.listedRecipes().length, 0, "listing cleared");
  assert.strictEqual(CookOffs.buyListedRecipe(r.id, "Marco", take, give), false, "unlisted -> fail");
  // Seller credit failure refunds the buyer honestly.
  const r3 = CookOffs.inventRecipe("Gordon", "Stew", ["potato", "milk"], 70, () => true, NOW);
  CookOffs.listRecipe(r3.id, 100);
  money.Julia = 500;
  let refunded = 0;
  const failGive = () => false;
  const refund = (name, amt) => { money[name] += amt; refunded = amt; };
  assert.strictEqual(CookOffs.buyListedRecipe(r3.id, "Julia", take, failGive, refund), false);
  assert.strictEqual(money.Julia, 500, "buyer refunded");
  assert.strictEqual(refunded, 100);
});

test("persistence round-trips through the save file", () => {
  const co = CookOffs.scheduleCookOff("misthalin", NOW);
  CookOffs.enterCookOff(co.id, "Gordon", () => true, NOW);
  CookOffs.inventRecipe("Gordon", "Tart", ["honey", "apple"], 70, () => true, NOW);
  assert.strictEqual(CookOffs.save(), true, "dirty save writes");
  assert.strictEqual(CookOffs.save(), false, "clean save is a no-op");
  CookOffs.resetForTests();
  CookOffs.load();
  assert.ok(CookOffs.cookOffById(co.id), "cook-off survived");
  assert.strictEqual(CookOffs.recipesByChef("Gordon").length, 1, "recipe survived");
});

console.log(`CookOffs data tier: ${passed} passed`);
