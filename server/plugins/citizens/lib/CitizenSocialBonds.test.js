"use strict";

// CitizenSocialBonds behavioral checks — plain node, no running server.

const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

const Bonds = require("./CitizenSocialBonds");
const CitizenBonds = require("./CitizenBonds");
const { getMemory } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");

let passed = 0;
function check(name, fn) {
  Bonds.resetForTests();
  try {
    getMemory().resetForTests();
  } catch {
    // Memory seam missing — non-fatal for these checks.
  }
  try {
    getJournal().resetForTests();
  } catch {
    // Journal seam missing — non-fatal.
  }
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- score updates ------------------------------------------------------------

check("recordInteraction: weights move the directed score", () => {
  assert.equal(Bonds.recordInteraction("SbAlice", "SbBob", "helped"), 6);
  assert.equal(Bonds.recordInteraction("SbAlice", "SbBob", "chatted"), 8);
  assert.equal(Bonds.scoreOf("SbAlice", "SbBob"), 8);
  // Directed: the reverse score is untouched.
  assert.equal(Bonds.scoreOf("SbBob", "SbAlice"), 0);
});

check("recordInteraction: unknown kind is a no-op", () => {
  assert.equal(Bonds.recordInteraction("SbAlice2", "SbBob2", "teleported"), 0);
  assert.equal(Bonds.scoreOf("SbAlice2", "SbBob2"), 0);
});

check("recordInteraction: scores clamp at +-100", () => {
  for (let i = 0; i < 20; i++) Bonds.recordInteraction("SbMax", "SbTgt", "bossed", { quiet: true });
  assert.equal(Bonds.scoreOf("SbMax", "SbTgt"), 100);
  for (let i = 0; i < 20; i++) Bonds.recordInteraction("SbMin", "SbTgt2", "killed_by", { quiet: true });
  assert.equal(Bonds.scoreOf("SbMin", "SbTgt2"), -100);
});

check("recordInteraction: mutual mirrors the change both ways", () => {
  Bonds.recordInteraction("SbMutA", "SbMutB", "helped", { mutual: true, quiet: true });
  assert.equal(Bonds.scoreOf("SbMutA", "SbMutB"), 6);
  assert.equal(Bonds.scoreOf("SbMutB", "SbMutA"), 6);
});

check("recordInteraction: self-interaction is ignored", () => {
  assert.equal(Bonds.recordInteraction("SbSelf", "SbSelf", "helped"), 0);
});

// --- standings ------------------------------------------------------------------

check("standing labels follow thresholds", () => {
  assert.equal(Bonds.standing(75), "close");
  assert.equal(Bonds.standing(50), "friend");
  assert.equal(Bonds.standing(20), "warm");
  assert.equal(Bonds.standing(0), "neutral");
  assert.equal(Bonds.standing(-20), "cold");
  assert.equal(Bonds.standing(-50), "rival");
  assert.equal(Bonds.standing(-80), "nemesis");
});

// --- promotion into the friends/enemies graph -------------------------------------

check("crossing friend threshold befriends in CitizenBonds", () => {
  for (let i = 0; i < 4; i++) Bonds.recordInteraction("SbPromA", "SbPromB", "befriended");
  assert.ok(Bonds.scoreOf("SbPromA", "SbPromB") >= Bonds.FRIEND_AT);
  assert.ok(CitizenBonds.isFriend("sbproma", "sbpromb"), "should be friends in CitizenBonds");
  assert.equal(Bonds.standingFor("SbPromA", "SbPromB"), "friend");
});

check("crossing rival threshold makes an enemy with journal line", () => {
  Bonds.recordInteraction("SbRivA", "SbRivB", "killed_by");
  assert.ok(Bonds.scoreOf("SbRivA", "SbRivB") <= Bonds.RIVAL_AT);
  assert.ok(CitizenBonds.isEnemy("sbriva", "sbrivb"), "should be enemies in CitizenBonds");
  assert.ok(!CitizenBonds.isFriend("sbriva", "sbrivb"), "enemy is not a friend");
  const recent = getJournal().recent("SbRivA", 5).map((e) => e.text).join(" ");
  assert.ok(/rival|bad blood/i.test(recent), `journal should note the rivalry, got: ${recent}`);
});

check("isRival honors both the score and the enemy list", () => {
  assert.ok(!Bonds.isRival("SbIrA", "SbIrB"));
  Bonds.recordInteraction("SbIrA", "SbIrB", "killed_by");
  assert.ok(Bonds.isRival("SbIrA", "SbIrB"));
  CitizenBonds.addEnemy("sbirx", "sbiry");
  assert.ok(Bonds.isRival("SbIrX", "SbIrY"), "enemy list alone counts as rivalry");
});

// --- favors and grudges ------------------------------------------------------------

check("recordFavor stores the story and warms the score", () => {
  Bonds.recordFavor("SbFavA", "SbFavB", "Lent me 5k for a rune scim.");
  assert.equal(Bonds.scoreOf("SbFavA", "SbFavB"), 8);
  const f = Bonds.favors("SbFavA", "SbFavB");
  assert.equal(f.length, 1);
  assert.ok(f[0].text.includes("5k"), "favor text stored");
  const summary = Bonds.bondSummary("SbFavA", "SbFavB");
  assert.ok(/favor/i.test(summary), `summary recalls the favor: ${summary}`);
});

check("recordGrudge stores kind+story and burns the score", () => {
  Bonds.recordGrudge("SbGrA", "SbGrB", "theft", "Stole my rune scim at the GE.");
  assert.equal(Bonds.scoreOf("SbGrA", "SbGrB"), -20);
  const g = Bonds.grudges("SbGrA", "SbGrB");
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, "theft");
  const summary = Bonds.bondSummary("SbGrA", "SbGrB");
  assert.ok(/stole from you/i.test(summary), `summary recalls the grudge: ${summary}`);
});

check("kill grudge: rival standing + nemesis line at the extreme", () => {
  Bonds.recordGrudge("SbKillA", "SbKillB", "kill", "Killed me at the Giant Mole.");
  assert.equal(Bonds.scoreOf("SbKillA", "SbKillB"), -60);
  assert.equal(Bonds.standingFor("SbKillA", "SbKillB"), "rival");
  Bonds.recordGrudge("SbKillA", "SbKillB", "kill", "Killed me again. Unforgivable.");
  assert.equal(Bonds.standingFor("SbKillA", "SbKillB"), "nemesis");
  const summary = Bonds.bondSummary("SbKillA", "SbKillB");
  assert.ok(/nemesis/i.test(summary), `summary names the nemesis: ${summary}`);
  assert.ok(/killed you/i.test(summary), `summary recalls the kills: ${summary}`);
});

check("bondSummary: close friend line", () => {
  for (let i = 0; i < 9; i++) Bonds.recordInteraction("SbCloseA", "SbCloseB", "bossed", { quiet: true });
  const summary = Bonds.bondSummary("SbCloseA", "SbCloseB");
  assert.ok(/closest friends/i.test(summary), `summary: ${summary}`);
});

check("bondSummary: empty for strangers", () => {
  assert.equal(Bonds.bondSummary("SbStrangerA", "SbStrangerB"), "");
});

// --- decay --------------------------------------------------------------------------

check("tickDecay drifts scores toward indifference", () => {
  Bonds.recordInteraction("SbDecA", "SbDecB", "helped", { quiet: true }); // +6
  Bonds.recordInteraction("SbDecA", "SbDecC", "insulted", { quiet: true }); // -12
  const r = Bonds.tickDecay(Date.now());
  assert.ok(r.decayed >= 2, `expected decay activity, got ${JSON.stringify(r)}`);
  assert.equal(Bonds.scoreOf("SbDecA", "SbDecB"), 5);
  assert.equal(Bonds.scoreOf("SbDecA", "SbDecC"), -11);
});

check("tickDecay forgets ancient favors and grudges", () => {
  const old = Date.now() - 40 * 24 * 3600 * 1000;
  Bonds.recordFavor("SbOldA", "SbOldB", "Ancient loan.", old);
  Bonds.recordGrudge("SbOldA", "SbOldC", "insult", "Ancient slight.", old);
  Bonds.tickDecay(Date.now());
  assert.equal(Bonds.favors("SbOldA", "SbOldB").length, 0, "old favor forgotten");
  assert.equal(Bonds.grudges("SbOldA", "SbOldC").length, 0, "old grudge forgotten");
});

// --- kill attribution ------------------------------------------------------------------

check("noteKill: real-player killer earns a kill grudge", () => {
  const killer = { getUsername: () => "PkerJoe", isPlayerBot: () => false };
  const director = { roster: new Map([["sbvic", {}]]) };
  const res = Bonds.noteKill("SbVic", killer, director);
  assert.ok(res, "should attribute the kill");
  assert.equal(res.killer, "pkerjoe");
  assert.equal(res.player, true);
  assert.equal(Bonds.scoreOf("SbVic", "PkerJoe"), -60);
  assert.ok(Bonds.isRival("SbVic", "PkerJoe"));
  const g = Bonds.grudges("SbVic", "PkerJoe");
  assert.equal(g[0].kind, "kill");
});

check("noteKill: fellow-citizen killer earns a grudge too", () => {
  const killer = { getUsername: () => "Killer Karl", isPlayerBot: () => true };
  const director = { roster: new Map([["sbvic2", {}], ["killer karl", {}]]) };
  const res = Bonds.noteKill("SbVic2", killer, director);
  assert.ok(res, "citizen killer attributed");
  assert.equal(res.player, false);
  assert.equal(Bonds.scoreOf("SbVic2", "Killer Karl"), -60);
});

check("noteKill: NPC killer is not personal", () => {
  const wolf = { getDefinition: () => ({ getName: () => "Wolf" }) };
  const director = { roster: new Map([["sbvic3", {}]]) };
  const res = Bonds.noteKill("SbVic3", wolf, director);
  assert.equal(res, null, "NPC kills are not grudges");
  assert.equal(Bonds.scoreOf("SbVic3", "wolf"), 0);
});

check("noteKill: suicide is not a grudge", () => {
  const killer = { getUsername: () => "SbVic4", isPlayerBot: () => false };
  const director = { roster: new Map([["sbvic4", {}]]) };
  assert.equal(Bonds.noteKill("SbVic4", killer, director), null);
});

// --- top bonds ----------------------------------------------------------------------------

check("topBonds returns strongest bonds first", () => {
  Bonds.recordInteraction("SbTop", "SbWarm", "helped", { quiet: true }); // 6 — below bar
  for (let i = 0; i < 5; i++) Bonds.recordInteraction("SbTop", "SbPal", "bossed", { quiet: true }); // 40
  Bonds.recordInteraction("SbTop", "SbFoe", "killed_by", { quiet: true }); // -60
  const top = Bonds.topBonds("SbTop", 5);
  assert.equal(top.length, 2, "warm-only bond is below the bar");
  assert.equal(top[0].name, "sbfoe", "strongest |score| first");
  assert.equal(top[0].standing, "rival");
  assert.equal(top[1].name, "sbpal");
});

// --- persistence round-trip ------------------------------------------------------------------

check("persistence: save/load round-trips scores, favors, grudges", () => {
  const tmp = path.join(os.tmpdir(), `sb-test-${Date.now()}-${process.pid}.json`);
  Bonds._setSavePathForTests(tmp);
  Bonds.recordFavor("SbPerA", "SbPerB", "Covered my shift at the mill.");
  Bonds.recordGrudge("SbPerA", "SbPerC", "insult", "Mocked my hat.");
  assert.ok(Bonds.save(), "dirty save should write");
  assert.ok(!Bonds.save(), "clean save should not rewrite");
  Bonds.resetForTests();
  Bonds._setSavePathForTests(tmp); // re-point after reset
  Bonds.load();
  assert.equal(Bonds.scoreOf("SbPerA", "SbPerB"), 8);
  assert.equal(Bonds.scoreOf("SbPerA", "SbPerC"), -12);
  assert.ok(Bonds.favors("SbPerA", "SbPerB")[0].text.includes("mill"));
  assert.ok(Bonds.grudges("SbPerA", "SbPerC")[0].text.includes("hat"));
  try {
    require("fs").unlinkSync(tmp);
  } catch {
    // Cleanup best-effort.
  }
  Bonds._setSavePathForTests(
    path.join(process.cwd(), "data", "saves", "citizen-social-bonds.json")
  );
});

// --- brain write-through ------------------------------------------------------------------------

check("brain rapport writes through to persistent bond memory", () => {
  const Brain = require("./../brain/CitizenRelationships");
  Brain.resetForTests();
  Brain.noteInteraction("SbBrainA", "SbBrainB", "helped");
  assert.equal(Bonds.scoreOf("SbBrainA", "SbBrainB"), 6, "persistent score follows brain rapport");
  assert.equal(Bonds.scoreOf("SbBrainB", "SbBrainA"), 6, "write-through is mutual");
  Brain.resetForTests();
});

console.log(`\n${passed} checks passed.`);
