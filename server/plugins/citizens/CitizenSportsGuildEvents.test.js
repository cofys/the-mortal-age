"use strict";

/**
 * CitizenSportsGuildEvents.test.js — ::sportsguild command contracts without a
 * running server. The guild data tier is stubbed in the require cache.
 *
 * Run: node server/plugins/citizens/CitizenSportsGuildEvents.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stub guild module ---

const guildCalls = [];
const fakeGuilds = {
  members: new Set(),
  camps: [],
  cases: [],
};
const guildsPath = path.resolve(__dirname, "./lib/CitizenSportsGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    DUES_WEEKLY: 25,
    CERT_FEE: 50,
    SPORTS_CODE: ["Rule one.", "Rule two."],
    RANK_GAMESMASTER: "gamesmaster",
    describe: () => ({ exists: true, memberCount: 3, gamesmasters: 1, sealed: 5, openCamps: 2, treasury: 100, medicalFund: 20, prestige: 40 }),
    isGuildMember: (u) => fakeGuilds.members.has(String(u || "").toLowerCase()),
    guildRankOf: (u) => (fakeGuilds.members.has(String(u || "").toLowerCase()) ? "competitor" : null),
    memberOf: (u) => (fakeGuilds.members.has(String(u || "").toLowerCase()) ? { username: u, rank: "competitor", suspended: false } : null),
    ensureGuild: (kid) => { const g = { treasury: 100 }; return g; },
    joinGuild: (u) => { guildCalls.push(["join", u]); fakeGuilds.members.add(String(u).toLowerCase()); return { ok: true, rank: "rookie" }; },
    leaveGuild: (u) => { guildCalls.push(["leave", u]); fakeGuilds.members.delete(String(u).toLowerCase()); return { ok: true }; },
    recordDuesPayment: (u) => { guildCalls.push(["dues", u]); return { ok: true }; },
    submitRecord: (u, kid, sport) => {
      guildCalls.push(["submit", u, sport]);
      if (sport === "nope") return { ok: false, reason: "no-such-record" };
      return { ok: true, fee: 50, mark: 250 };
    },
    settleCertification: (kid, sport) => ({ ok: true, grade: "B", bounty: 120, paid: 120, owed: 0, doubled: true }),
    realRecordFor: (kid, sport) => (sport === "nope" ? null : { holder: "Alice", mark: 250, at: Date.now() }),
    reportDoping: (kid, accused, kind, reporter) => {
      guildCalls.push(["report", accused, reporter]);
      const c = { id: "case-1", accused, kind, votes: {} };
      fakeGuilds.cases.push(c);
      return { ok: true, id: "case-1" };
    },
    voteCase: (id, voter, guilty) => ({ ok: id === "case-1", reason: "no-such-case" }),
    campsFor: () => fakeGuilds.camps,
    postCamp: (sponsor, target, bounty) => {
      guildCalls.push(["post", target, sponsor, bounty]);
      if (bounty < 100) return { ok: false, reason: "bounty-too-low" };
      const c = { id: "camp-1", targetKingdom: target, bounty, sponsor };
      fakeGuilds.camps.push(c);
      return { ok: true, id: "camp-1" };
    },
    claimCamp: (id, claimant) => {
      guildCalls.push(["claim", id, claimant]);
      if (id !== "camp-1") return { ok: false, reason: "no-such-camp" };
      return { ok: true, bounty: 500 };
    },
    holdClass: (kid, master) => ({ ok: master === "Master", reason: "not-gamesmaster", taught: 2 }),
    takeApprentice: (master, rookie) => ({ ok: master === "Master", reason: "not-gamesmaster" }),
    serialize: () => ({ cases: Object.fromEntries(fakeGuilds.cases.map((c) => [c.id, c])) }),
  },
};

const sitesPath = path.resolve(__dirname, "./brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { kingdomIdOf: () => "varrock" },
};

// --- real module under test ---

const { onSportsGuildCommand, SPORTSGUILD_USAGE } = require("./CitizenSportsGuildEvents");

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
  fakeGuilds.camps = [];
  fakeGuilds.cases = [];
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
  onSportsGuildCommand(p, "status");
  assert.ok(p.messages[0].includes("Citizens work the guild"));
});

test("status shows guild summary", () => {
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "status");
  assert.ok(p.messages[0].includes("Athletes' Guild"));
  assert.ok(p.messages[0].includes("3 members"));
});

test("join works", () => {
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "join");
  assert.ok(guildCalls.some((c) => c[0] === "join"));
  assert.ok(p.messages[0].includes("Welcome"));
});

test("dues takes real coins", () => {
  fakeGuilds.members.add("alice");
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "dues");
  assert.strictEqual(p.inventory.coins, 75);
  assert.ok(p.messages[0].includes("Dues paid"));
});

test("dues fails honestly when broke", () => {
  fakeGuilds.members.add("alice");
  const p = stubPlayer("Alice", 5);
  onSportsGuildCommand(p, "dues");
  assert.ok(p.messages[0].includes("need 25 coins"));
});

test("certify takes fee and certifies", () => {
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "certify running");
  assert.strictEqual(p.inventory.coins, 50);
  assert.ok(p.messages[0].includes("grade B"));
});

test("certify fails honestly with no record", () => {
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "certify nope");
  assert.ok(p.messages[0].includes("no-such-record"));
  assert.strictEqual(p.inventory.coins, 100); // fee not taken
});

test("report opens a doping case", () => {
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "report running");
  assert.ok(p.messages[0].includes("case-1"));
});

test("vote records a vote", () => {
  const p = stubPlayer("Master", 100);
  onSportsGuildCommand(p, "vote case-1 guilty");
  assert.ok(p.messages[0].includes("Vote recorded"));
});

test("post camp takes the bounty coins", () => {
  const p = stubPlayer("Alice", 500);
  onSportsGuildCommand(p, "post falador 200");
  assert.strictEqual(p.inventory.coins, 300);
  assert.ok(p.messages[0].includes("camp-1"));
});

test("post camp rejects low bounties", () => {
  const p = stubPlayer("Alice", 500);
  onSportsGuildCommand(p, "post falador 50");
  assert.ok(p.messages[0].includes("bounty-too-low"));
});

test("claim camp works", () => {
  fakeGuilds.camps.push({ id: "camp-1", targetKingdom: "falador", bounty: 500, sponsor: "S" });
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "claim camp-1");
  assert.ok(p.messages[0].includes("500 coins"));
});

test("code shows the sports code", () => {
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "code");
  assert.ok(p.messages[0].includes("Rule one"));
});

test("unknown subcommand shows usage", () => {
  const p = stubPlayer("Alice", 100);
  onSportsGuildCommand(p, "frobnicate");
  assert.ok(p.messages[0].includes("::sportsguild"));
});

console.log(`\n${passed} tests passed.`);
