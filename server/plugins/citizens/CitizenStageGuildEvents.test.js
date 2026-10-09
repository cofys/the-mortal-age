"use strict";

/**
 * CitizenStageGuildEvents.test.js — ::stageguild command contracts without a
 * running server. The guild data tier is stubbed in the require cache.
 *
 * Run: node server/plugins/citizens/CitizenStageGuildEvents.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stub guild module ---

const guildCalls = [];
const fakeGuilds = {
  members: new Set(),
  circuits: [],
  cases: [],
  laurels: [],
};
const guildsPath = path.resolve(__dirname, "./lib/CitizenStageGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    DUES_WEEKLY: 25,
    CERT_FEE: 50,
    STAGE_CODE: ["Rule one.", "Rule two."],
    RANK_STAGEMASTER: "stagemaster",
    load: () => ({ cases: Object.fromEntries(fakeGuilds.cases.map((c) => [c.id, c])), laurels: fakeGuilds.laurels }),
    describe: () => ({ exists: true, memberCount: 3, stagemasters: 1, certified: 5, openCircuits: 2, treasury: 100, reliefFund: 20, prestige: 40 }),
    isGuildMember: (u) => fakeGuilds.members.has(String(u || "").toLowerCase()),
    guildRankOf: (u) => (fakeGuilds.members.has(String(u || "").toLowerCase()) ? "performer" : null),
    memberOf: (u) => (fakeGuilds.members.has(String(u || "").toLowerCase()) ? { username: u, rank: "performer", suspended: false } : null),
    joinGuild: (u) => { guildCalls.push(["join", u]); fakeGuilds.members.add(String(u).toLowerCase()); return { ok: true }; },
    leaveGuild: (u) => { guildCalls.push(["leave", u]); fakeGuilds.members.delete(String(u).toLowerCase()); return { ok: true }; },
    recordDuesPayment: (u) => { guildCalls.push(["dues", u]); return { ok: true }; },
    submitForCertification: (playId, owner) => {
      guildCalls.push(["submit", playId, owner]);
      if (playId === "nope") return { ok: false, reason: "no such play" };
      return { ok: true, play: { title: "A Play" } };
    },
    settleCertification: (playId) => ({ ok: true, seal: { title: "A Play" }, grade: "B", doubled: false, paid: 60, owed: 0 }),
    reportPlagiarism: (kid, playId, reporter) => {
      guildCalls.push(["report", playId, reporter]);
      if (playId === "clean") return { ok: false, reason: "no plagiarism found" };
      const c = { id: "case-1", accused: "Bad", playId, votes: {} };
      fakeGuilds.cases.push(c);
      return { ok: true, case: c };
    },
    voteOnCase: (id, voter, verdict) => ({ ok: id === "case-1", reason: "no open case" }),
    circuitsFor: () => fakeGuilds.circuits,
    postCircuit: (kid, target, sponsor, bounty) => {
      guildCalls.push(["post", target, sponsor, bounty]);
      if (bounty < 100) return { ok: false, reason: "minimum bounty is 100" };
      const c = { id: "circuit-1", targetKingdom: target, bounty, sponsor };
      fakeGuilds.circuits.push(c);
      return { ok: true, circuit: c };
    },
    claimCircuit: (id, troupe) => {
      guildCalls.push(["claim", id, troupe]);
      if (id !== "circuit-1") return { ok: false, reason: "no open circuit" };
      return { ok: true, bounty: 500 };
    },
    contribute: (u, amt) => { guildCalls.push(["contribute", u, amt]); return { ok: true }; },
    tryPromote: (u) => ({ ok: false, reason: "requirements not met" }),
    takeMentorship: (master, app) => ({ ok: master === "Master", reason: "need a stagemaster" }),
  },
};

const sitesPath = path.resolve(__dirname, "./brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { kingdomIdOf: () => "varrock" },
};

// --- real module under test ---

const { onStageGuildCommand } = require("./CitizenStageGuildEvents");

function stubPlayer(name, coins, isBot = false) {
  const messages = [];
  const inv = {
    coins,
    // Real ItemContainer API: getAmount(id), adds(id, amount), deleteNumber(id, amount).
    getAmount: (id) => (id === 995 ? inv.coins : 0),
    deleteNumber: (id, n) => { if (id === 995) inv.coins -= n; },
    adds: (id, n) => { if (id === 995 && n > 0) inv.coins += n; },
  };
  return {
    messages,
    inventory: inv,
    getInventory: () => inv,
    getUsername: () => name,
    username: name,
    isBot,
    isRealPlayer: () => !isBot,
    sendMessage: (t) => messages.push(t),
  };
}

let passed = 0;
function test(name, fn) {
  fakeGuilds.members = new Set();
  fakeGuilds.circuits = [];
  fakeGuilds.cases = [];
  fakeGuilds.laurels = [];
  guildCalls.length = 0;
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("bots are rejected", () => {
  const p = stubPlayer("Bot1", 100, true);
  onStageGuildCommand(p, "status");
  assert.ok(p.messages[0].includes("Citizens work the guild"));
});

test("status shows guild summary", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "status");
  assert.ok(p.messages[0].includes("Players' Guild"));
  assert.ok(p.messages[0].includes("3 members"));
});

test("join works", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "join");
  assert.ok(guildCalls.some((c) => c[0] === "join"));
  assert.ok(p.messages[0].includes("Welcome"));
});

test("dues takes real coins", () => {
  fakeGuilds.members.add("alice");
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "dues");
  assert.strictEqual(p.inventory.coins, 75);
  assert.ok(p.messages[0].includes("Dues paid"));
});

test("dues fails honestly when broke", () => {
  fakeGuilds.members.add("alice");
  const p = stubPlayer("Alice", 5);
  onStageGuildCommand(p, "dues");
  assert.ok(p.messages[0].includes("need 25 coins"));
});

test("certify takes fee and certifies", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "certify play-1");
  assert.strictEqual(p.inventory.coins, 50);
  assert.ok(p.messages[0].includes("grade B"));
});

test("certify refunds fee on failure", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "certify nope");
  assert.strictEqual(p.inventory.coins, 100); // refunded
  assert.ok(p.messages[0].includes("Fee refunded"));
});

test("report opens a plagiarism case", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "report play-9");
  assert.ok(p.messages[0].includes("case-1"));
});

test("report fails honestly on clean plays", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "report clean");
  assert.ok(p.messages[0].includes("no plagiarism found"));
});

test("vote records a vote", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "vote case-1 guilty");
  assert.ok(p.messages[0].includes("Vote recorded"));
});

test("post takes real coins for the bounty", () => {
  const p = stubPlayer("Alice", 1000);
  onStageGuildCommand(p, "post falador 500");
  assert.strictEqual(p.inventory.coins, 500);
  assert.ok(p.messages[0].includes("circuit-1"));
});

test("claim pays the troupe", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "claim circuit-1 The Players");
  assert.ok(p.messages[0].includes("500 coins"));
});

test("contribute takes real coins", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "contribute 40");
  assert.strictEqual(p.inventory.coins, 60);
});

test("apprentice arranges mentorship", () => {
  const p = stubPlayer("Alice", 100);
  onStageGuildCommand(p, "apprentice Master");
  assert.ok(p.messages[0].includes("took you as apprentice"));
});

console.log(`\n${passed} tests passed`);
