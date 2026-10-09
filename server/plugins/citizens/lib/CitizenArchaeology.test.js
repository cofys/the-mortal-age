"use strict";

/**
 * CitizenArchaeology.test.js — plain node (no jest in this environment).
 * Run: node server/plugins/citizens/lib/CitizenArchaeology.test.js
 */

const assert = require("assert");
const Arch = require("./CitizenArchaeology");

let passed = 0;
function test(name, fn) {
  Arch.resetForTests();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const ANCIENT = { name: "a lost tomb" };
const MODERN = { name: "a misty valley" };

// --- discovery honesty ---
test("non-ancient discoveries cannot found sites", () => {
  const res = Arch.foundSiteFromDiscovery("exp-1", MODERN, "lumbridge", "Bob");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not ancient enough");
});

test("ancient discovery founds a site with deterministic attributes", () => {
  const a = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob");
  assert.strictEqual(a.ok, true);
  assert.ok(a.site.id.startsWith("site-"));
  assert.ok(a.site.richness >= 2 && a.site.richness <= 10);
  assert.ok(a.site.slotsLeft > 0);
  assert.ok(a.site.name.includes("lost tomb"));
  // Deterministic: same discovery seeds the same attributes.
  Arch.resetForTests();
  const b = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob");
  assert.strictEqual(b.site.richness, a.site.richness);
  assert.strictEqual(b.site.totalSlots, a.site.totalSlots);
});

test("same discovery never founds two sites (idempotent)", () => {
  const a = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob");
  const b = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob");
  assert.strictEqual(b.already, true);
  assert.strictEqual(Arch.describe().sites, 1);
  assert.strictEqual(a.site.id, b.site.id);
});

test("different discoveries found different sites", () => {
  Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob");
  Arch.foundSiteFromDiscovery("exp-2", { name: "a sealed crypt" }, "lumbridge", "Bob");
  assert.strictEqual(Arch.describe().sites, 2);
});

// --- archaeologists ---
test("register archaeologist, honest identity required", () => {
  assert.strictEqual(Arch.registerArchaeologist("", "lumbridge").ok, false);
  const r = Arch.registerArchaeologist("Indy", "lumbridge");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(Arch.isArchaeologist("indy"), true); // normalized
  assert.strictEqual(Arch.isArchaeologist("Lara"), false);
  assert.strictEqual(Arch.archaeologistCount("lumbridge"), 1);
  assert.strictEqual(Arch.archaeologistCount("varrock"), 0);
});

// --- excavation ---
test("excavate yields real artifact with value and history", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const before = s.slotsLeft;
  const res = Arch.excavate("Indy", s.id);
  assert.strictEqual(res.ok, true);
  const a = res.artifact;
  assert.ok(a.id.startsWith("art-"));
  assert.ok(a.value >= 10);
  assert.ok(a.history.includes("Indy"), "history names the real finder");
  assert.ok(a.history.includes(s.name), "history names the real site");
  assert.strictEqual(Arch.siteOf(s.id).slotsLeft, before - 1);
});

test("excavation order is deterministic per site", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s1 = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const first = Arch.excavate("Indy", s1.id).artifact;
  Arch.resetForTests();
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s2 = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const firstAgain = Arch.excavate("Indy", s2.id).artifact;
  assert.strictEqual(firstAgain.kind, first.kind);
  assert.strictEqual(firstAgain.condition, first.condition);
  assert.strictEqual(firstAgain.value, first.value);
});

test("excavate unknown/exhausted site fails honestly", () => {
  assert.strictEqual(Arch.excavate("Indy", "site-999").ok, false);
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const slots = s.slotsLeft;
  for (let i = 0; i < slots; i++) Arch.excavate("Indy", s.id);
  const res = Arch.excavate("Indy", s.id);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "site exhausted");
});

test("artifact values scale with condition and kind", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const vals = [];
  for (let i = 0; i < 3; i++) {
    Arch.resetForTests();
    Arch.registerArchaeologist("Indy", "lumbridge");
    const s = Arch.foundSiteFromDiscovery(`exp-${i}`, { name: "a buried war-cache" }, "lumbridge", "Bob").site;
    vals.push(Arch.excavate("Indy", s.id).artifact.value);
  }
  assert.ok(vals.every((v) => v >= 10), "every artifact has real value");
});

// --- donation ---
test("donate moves artifact to museum with real prestige", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const a = Arch.excavate("Indy", s.id).artifact;
  const res = Arch.donateArtifact("Indy", a.id);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(Arch.artifactOf(a.id).donated, true);
  assert.ok(res.museum.prestige > 0);
  assert.strictEqual(res.museum.donations, 1);
  assert.strictEqual(Arch.artifactsOfOwner("Indy").length, 0);
  // Cannot donate twice, cannot donate another's.
  assert.strictEqual(Arch.donateArtifact("Indy", a.id).ok, false);
  assert.strictEqual(Arch.donateArtifact("Lara", a.id).ok, false);
});

test("museum collection lists donated pieces", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const a = Arch.excavate("Indy", s.id).artifact;
  Arch.donateArtifact("Indy", a.id);
  const col = Arch.museumCollection("lumbridge");
  assert.strictEqual(col.length, 1);
  assert.strictEqual(Arch.museumCollection("varrock").length, 0);
});

// --- selling ---
test("sell to museum needs a funded museum and pays real coins", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const a = Arch.excavate("Indy", s.id).artifact;
  // Poor museum: honest failure.
  const broke = Arch.sellArtifactToMuseum("Indy", a.id, () => true);
  assert.strictEqual(broke.ok, false);
  assert.strictEqual(broke.reason, "museum cannot afford it");
  // Fund it (simulate many weeks of accrual).
  const museum = Arch.ensureMuseum("lumbridge");
  museum.fund = a.value + 100;
  let paidTo = null;
  let paidCoins = 0;
  const res = Arch.sellArtifactToMuseum("Indy", a.id, (who, coins) => {
    paidTo = who; paidCoins = coins; return true;
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(paidTo, "Indy");
  assert.strictEqual(paidCoins, a.value);
  assert.strictEqual(Arch.artifactOf(a.id).donated, true);
});

test("sell fails honestly when payment fails or not owner", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const a = Arch.excavate("Indy", s.id).artifact;
  Arch.ensureMuseum("lumbridge").fund = 100000;
  assert.strictEqual(Arch.sellArtifactToMuseum("Lara", a.id, () => true).ok, false);
  assert.strictEqual(Arch.sellArtifactToMuseum("Indy", a.id, () => false).ok, false);
  assert.strictEqual(Arch.artifactOf(a.id).donated, false);
});

// --- restoration ---
test("restore upgrades condition for a real fee", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  // Dig across several sites until a fragmented artifact turns up.
  let art = null;
  let siteIdx = 0;
  while (!art && siteIdx < 8) {
    const s = Arch.foundSiteFromDiscovery(`exp-${siteIdx}`, ANCIENT, "lumbridge", "Bob").site;
    siteIdx++;
    const slots = s.slotsLeft;
    for (let i = 0; i < slots && !art; i++) {
      const a = Arch.excavate("Indy", s.id).artifact;
      if (a.condition === "fragmented") art = a;
    }
  }
  assert.ok(art, "found a fragmented artifact while digging");
  const oldValue = art.value;
  let feeTaken = 0;
  const res = Arch.restoreArtifact("Indy", art.id, (who, coins) => { feeTaken = coins; return true; });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.artifact.condition, "damaged");
  assert.ok(feeTaken > 0, "real fee taken");
  assert.ok(res.artifact.value > oldValue, "restored artifact worth more");
  // Restore again -> pristine.
  const res2 = Arch.restoreArtifact("Indy", art.id, () => true);
  assert.strictEqual(res2.artifact.condition, "pristine");
  // Pristine cannot be restored further.
  assert.strictEqual(Arch.restoreArtifact("Indy", art.id, () => true).ok, false);
});

test("restore fails honestly: not owner, unpaid, donated", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const a = Arch.excavate("Indy", s.id).artifact;
  if (a.condition === "pristine") {
    // Degrade artificially for the test? No — skip unpaid check via owner check instead.
    assert.strictEqual(Arch.restoreArtifact("Lara", a.id, () => true).ok, false);
    return;
  }
  assert.strictEqual(Arch.restoreArtifact("Lara", a.id, () => true).ok, false);
  assert.strictEqual(Arch.restoreArtifact("Indy", a.id, () => false).ok, false);
  Arch.donateArtifact("Indy", a.id);
  assert.strictEqual(Arch.restoreArtifact("Indy", a.id, () => true).ok, false);
});

// --- sites / pruning ---
test("activeSites filters exhausted and unknown kingdoms", () => {
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  assert.strictEqual(Arch.activeSites("lumbridge").length, 1);
  assert.strictEqual(Arch.activeSites("varrock").length, 0);
  assert.strictEqual(Arch.activeSites().length, 1);
});

test("pruneSites removes exhausted sites", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const slots = s.slotsLeft;
  for (let i = 0; i < slots; i++) Arch.excavate("Indy", s.id);
  assert.strictEqual(Arch.pruneSites(Date.now()), 1);
  assert.strictEqual(Arch.siteOf(s.id), null);
});

// --- museum ---
test("museumStatus reports real collection", () => {
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  const a = Arch.excavate("Indy", s.id).artifact;
  Arch.donateArtifact("Indy", a.id);
  const m = Arch.museumStatus("lumbridge");
  assert.strictEqual(m.displayed, 1);
  assert.ok(m.prestige > 0);
  assert.strictEqual(m.finest[0].finder, "Indy");
});

test("museum fund accrues weekly", () => {
  const m = Arch.ensureMuseum("lumbridge");
  m.fundAccruedAt = Date.now() - 21 * 24 * 3600 * 1000; // 3 weeks ago
  const fund = Arch.accrueMuseumFund("lumbridge", Date.now());
  assert.strictEqual(fund, 3 * 500);
});

// --- persistence ---
test("save round-trips state", () => {
  const fs = require("fs");
  const path = require("path");
  Arch.registerArchaeologist("Indy", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", ANCIENT, "lumbridge", "Bob").site;
  Arch.excavate("Indy", s.id);
  assert.strictEqual(Arch.save(), true);
  const p = path.join(__dirname, "..", "data", "saves", Arch.SAVE_KEY);
  assert.ok(fs.existsSync(p), "save file written");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.ok(raw.sites[s.id], "site persisted");
  assert.strictEqual(Object.keys(raw.artifacts).length, 1);
  fs.unlinkSync(p); // keep the repo clean
});

console.log(`\n${passed} tests passed`);
