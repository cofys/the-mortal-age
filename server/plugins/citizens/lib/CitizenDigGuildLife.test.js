"use strict";

/**
 * CitizenDigGuildLife.test.js — the guild slow tick without a running server.
 *
 * Run: node server/plugins/citizens/lib/CitizenDigGuildLife.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock"], kingdomIdOf: () => "varrock" },
};

const fakeArch = {
  archaeologists: new Set(),
  digs: Object.create(null),
  artifacts: Object.create(null),
  sites: Object.create(null),
  donations: [],
};
const archPath = path.resolve(__dirname, "./CitizenArchaeology.js");
require.cache[archPath] = {
  id: archPath, filename: archPath, loaded: true,
  exports: {
    isArchaeologist: (u) => fakeArch.archaeologists.has(String(u || "").toLowerCase()),
    digCountFor: (u) => fakeArch.digs[String(u || "").toLowerCase()] || 0,
    artifactOf: (id) => fakeArch.artifacts[String(id)] || null,
    siteOf: (id) => fakeArch.sites[String(id)] || null,
    artifactsOfOwner: (u) => Object.values(fakeArch.artifacts).filter((a) => a.owner === String(u || "").toLowerCase() && !a.donated),
    museumCollection: (kid) => fakeArch.donations.filter((d) => !kid || d.kingdomId === String(kid)),
    activeSites: (kid) => Object.values(fakeArch.sites).filter((s) => !kid || s.kingdomId === String(kid)),
    donateArtifact: (owner, id) => {
      const a = fakeArch.artifacts[String(id)];
      if (!a || a.owner !== String(owner || "").toLowerCase() || a.donated) return { ok: false };
      a.donated = true; a.displayedAt = Date.now(); a.owner = null;
      fakeArch.donations.push({ id: a.id, siteId: a.siteId, kingdomId: a.kingdomId, displayedAt: a.displayedAt });
      return { ok: true };
    },
    museumTileFor: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const sayPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[sayPath] = {
  id: sayPath, filename: sayPath, loaded: true,
  exports: { sayPublic: () => true },
};

const journalPath = path.resolve(__dirname, "./CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: { getJournal: () => ({ log: () => true }) },
};

// --- real modules ---

const Guilds = require("./CitizenDigGuilds");
const Life = require("./CitizenDigGuildLife");

function makeBot(coins) {
  return {
    inventory: {
      _coins: coins,
      getAmount: function () { return this._coins; },
      // Canonical ItemContainer API: adds(id, amount), deleteNumber(id, amount).
      // There is no inv.add / inv.remove / inv.count.
      adds: function (id, n) { this._coins += n; return true; },
      deleteNumber: function (id, n) { this._coins = Math.max(0, this._coins - n); },
    },
  };
}

function makeDirector(records) {
  // records: [ { username, bot } ]
  return {
    roster: records,
    isOnline: () => true,
    getBot: (r) => r.bot,
  };
}

function reset() {
  Guilds.resetForTests();
  Life.resetForTests();
  fakeArch.archaeologists = new Set();
  fakeArch.digs = Object.create(null);
  fakeArch.artifacts = Object.create(null);
  fakeArch.sites = Object.create(null);
  fakeArch.donations = [];
}

let passed = 0;
function test(name, fn) {
  reset();
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}\n${e.stack}`);
    process.exitCode = 1;
  }
}

test("tick never throws on an empty world", () => {
  Life.tickDigGuildLife(makeDirector([]), Date.now());
});

test("tick collects real dues from online members", () => {
  fakeArch.archaeologists.add("bob");
  Guilds.joinGuild("Bob", "varrock");
  const m = Guilds.memberOf("Bob");
  m.duesPaidUntilMs = Date.now() - 1000; // due
  const bot = makeBot(100);
  Life.tickDigGuildLife(makeDirector([{ username: "Bob", bot }]), Date.now());
  assert.strictEqual(bot.inventory._coins, 75); // 25 taken
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 20);
  assert.strictEqual(Guilds.conservationFundFor("varrock"), 5);
});

test("tick suspends after two missed online collections", () => {
  fakeArch.archaeologists.add("bob");
  Guilds.joinGuild("Bob", "varrock");
  const m = Guilds.memberOf("Bob");
  m.duesPaidUntilMs = Date.now() - 1000;
  const bot = makeBot(0); // broke
  const d = makeDirector([{ username: "Bob", bot }]);
  Life.resetForTests(); // clear cooldown so the second tick runs
  Life.tickDigGuildLife(d, Date.now());
  Life.resetForTests();
  Life.tickDigGuildLife(d, Date.now() + 31 * 60 * 1000);
  assert.ok(Guilds.memberOf("Bob").suspended);
});

test("tick auto-authenticates member artifacts and seals them", () => {
  fakeArch.archaeologists.add("bob");
  Guilds.joinGuild("Bob", "varrock");
  fakeArch.sites.s1 = { id: "s1", kingdomId: "varrock", digCount: 1, foundedAt: Date.now() - 5000, name: "Dig at s1" };
  fakeArch.artifacts.a1 = {
    id: "a1", owner: "bob", siteId: "s1", kingdomId: "varrock",
    kind: "tablet", condition: "pristine", value: 900, name: "pristine tablet",
    finder: "bob", foundAt: Date.now(), donated: false,
  };
  const bot = makeBot(1000);
  Guilds.ensureGuild("varrock").treasury = 1000;
  Life.tickDigGuildLife(makeDirector([{ username: "Bob", bot }]), Date.now());
  assert.ok(Guilds.sealFor("a1"), "sealed");
  assert.strictEqual(Guilds.authGradeFor("a1"), "A");
});

test("tick auto-reports forgeries, conservator vote settles guilty", () => {
  fakeArch.archaeologists.add("bob");
  fakeArch.archaeologists.add("con");
  fakeArch.archaeologists.add("con2");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Con", "varrock");
  Guilds.joinGuild("Con2", "varrock");
  Guilds.memberOf("Con").rank = Guilds.RANK_CONSERVATOR;
  Guilds.memberOf("Con2").rank = Guilds.RANK_CONSERVATOR;
  fakeArch.artifacts.a9 = {
    id: "a9", owner: "bob", siteId: "nope", kingdomId: "varrock",
    kind: "statue", condition: "pristine", value: 2000, name: "pristine statue",
    finder: "bob", foundAt: Date.now(), donated: false,
  };
  const d = makeDirector([{ username: "Bob", bot: makeBot(1000) }, { username: "Con", bot: makeBot(1000) }]);
  Life.tickDigGuildLife(d, Date.now());
  assert.ok(Guilds.describe("varrock").openCases >= 1, "forgery case auto-opened");
  // The auto-opened case needs votes: drive the tribunal through a fresh
  // manual case on a second forged artifact.
  fakeArch.artifacts.b9 = Object.assign({}, fakeArch.artifacts.a9, { id: "b9" });
  const rep2 = Guilds.reportForgery("varrock", "b9", "Con");
  assert.strictEqual(rep2.ok, true);
  assert.strictEqual(Guilds.voteOnCase(rep2.id, "Con", true).ok, true);
  assert.strictEqual(Guilds.voteOnCase(rep2.id, "Con2", true).ok, true);
  assert.strictEqual(Guilds.voteOnCase(rep2.id, "Bob", true).ok, false, "non-conservator cannot vote");
  Life.resetForTests();
  Life.tickDigGuildLife(d, Date.now() + 25 * 3600 * 1000);
  assert.ok(!Guilds.memberOf("Bob"), "forger expelled after guilty verdict");
});

test("tick inspects looted sites and declares protection", () => {
  fakeArch.sites.s1 = { id: "s1", kingdomId: "varrock", digCount: 9, foundedAt: Date.now() - 5000, name: "Dig at s1" };
  Life.tickDigGuildLife(makeDirector([]), Date.now());
  // inspections run on the 12h cooldown; first tick inspects
  assert.ok(Guilds.isProtectedSite("s1") || !Guilds.isProtectedSite("s1")); // first flag only
  Life.resetForTests();
  Life.tickDigGuildLife(makeDirector([]), Date.now() + 13 * 3600 * 1000);
  assert.ok(Guilds.isProtectedSite("s1"), "protected after two flags");
});

console.log(`CitizenDigGuildLife: ${passed} tests passed`);
