"use strict";

/**
 * CitizenDigGuildEvents.test.js — the ::digguild player command without a server.
 *
 * Run: node server/plugins/citizens/CitizenDigGuildEvents.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "./brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock"], kingdomIdOf: () => "varrock" },
};

const archPath = path.resolve(__dirname, "./lib/CitizenArchaeology.js");
require.cache[archPath] = {
  id: archPath, filename: archPath, loaded: true,
  exports: {
    isArchaeologist: () => true,
    artifactOf: () => null,
    museumTileFor: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const guildsPath = path.resolve(__dirname, "./lib/CitizenDigGuilds.js");
const guildCalls = [];
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    DUES_WEEKLY: 25,
    EXCAVATION_CODE: ["Record everything."],
    describe: () => ({ exists: true, treasury: 100, conservationFund: 20, prestige: 5, memberCount: 3, conservators: 1, authenticated: 7, protected: 1, openCases: 0, hallTile: { x: 1, y: 2, z: 0 } }),
    guildRankOf: (u) => (String(u).toLowerCase() === "bob" ? "digger" : null),
    memberOf: (u) => (String(u).toLowerCase() === "bob" ? { duesPaidUntilMs: Date.now() + 99999 } : null),
    joinGuild: (u) => (guildCalls.push(["join", u]), { ok: true, rank: "digger" }),
    leaveGuild: (u) => (guildCalls.push(["leave", u]), { ok: true }),
    recordDuesPayment: (u) => (guildCalls.push(["dues", u]), { ok: true }),
    authenticateArtifact: (u, id) => (guildCalls.push(["authenticate", u, id]), id === "a1" ? { ok: true, grade: "B", bounty: 60, owed: 0, protected: false } : { ok: false, reason: "no such artifact" }),
    reportForgery: (kid, id, reporter) => (guildCalls.push(["report", id]), { ok: true, id: "case-1", kind: "phantom site" }),
    voteOnCase: (cid, voter, guilty) => (guildCalls.push(["vote", cid, guilty]), { ok: true }),
    inspectSite: (sid) => (guildCalls.push(["inspect", sid]), sid === "s1" ? { ok: true, result: "FLAG", reasons: ["looted: 9 digs"], protected: false, site: { name: "Dig at s1" } } : { ok: false, reason: "no such dig site" }),
    contribute: (u, coins) => (guildCalls.push(["contribute", u, coins]), { ok: true, fund: 20 + coins }),
    canPromote: () => ({ ok: false, reason: "needs more tenure" }),
    takeApprentice: (m, d) => (guildCalls.push(["apprentice", m, d]), { ok: true }),
  },
};

// --- real module under test ---

const { onDigGuildCommand, DIGGUILD_USAGE } = require("./CitizenDigGuildEvents");

function stubPlayer(username, coins, isBot = false) {
  const messages = [];
  return {
    messages,
    isPlayerBot: () => isBot,
    getUsername: () => username,
    username,
    getInventory: () => ({
      // Real ItemContainer API: getAmount(id), adds(id, amount), deleteNumber(id, amount).
      getAmount: (id) => (id === 995 ? coins : 0),
      adds: function (id, n) { if (id === 995 && n > 0) coins += n; return true; },
      deleteNumber: function (id, n) { if (id === 995 && coins >= n) coins -= n; return true; },
    }),
    sendMessage: (t) => messages.push(t),
    _coins: () => coins,
  };
}

let passed = 0;
function test(name, fn) {
  guildCalls.length = 0;
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("usage string exists", () => {
  assert.ok(DIGGUILD_USAGE.includes("::digguild"));
});

test("bots are rejected", () => {
  const p = stubPlayer("Bot1", 100, true);
  onDigGuildCommand(p, ["status"]);
  assert.ok(p.messages[0].includes("Citizens work"));
  assert.strictEqual(guildCalls.length, 0);
});

test("status describes the guild", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["status"]);
  assert.ok(p.messages.join(" ").includes("Excavators' Guild"));
  assert.ok(p.messages.join(" ").includes("digger"));
});

test("join calls the data tier", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["join"]);
  assert.deepStrictEqual(guildCalls[0][0], "join");
});

test("leave calls the data tier", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["leave"]);
  assert.deepStrictEqual(guildCalls[0][0], "leave");
});

test("dues paid up is reported honestly", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["dues"]);
  assert.ok(p.messages.join(" ").includes("paid up"));
  assert.strictEqual(guildCalls.length, 0);
});

test("code lists the excavation code", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["code"]);
  assert.ok(p.messages.join(" ").includes("Excavator's Code"));
});

test("authenticate success and failure paths", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["authenticate", "a1"]);
  assert.ok(p.messages.join(" ").includes("grade B"));
  const p2 = stubPlayer("Bob", 100);
  onDigGuildCommand(p2, ["authenticate"]);
  assert.ok(p2.messages.join(" ").includes("Usage"));
  const p3 = stubPlayer("Bob", 100);
  onDigGuildCommand(p3, ["authenticate", "nope"]);
  assert.ok(p3.messages.join(" ").includes("failed"));
});

test("report opens a forgery case", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["report", "a9"]);
  assert.ok(p.messages.join(" ").includes("case-1"));
});

test("vote records through the data tier", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["vote", "case-1", "guilty"]);
  assert.deepStrictEqual(guildCalls[0], ["vote", "case-1", true]);
  const p2 = stubPlayer("Bob", 100);
  onDigGuildCommand(p2, ["vote", "case-1"]);
  assert.ok(p2.messages.join(" ").includes("Usage"));
});

test("inspect reports the verdict", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["inspect", "s1"]);
  assert.ok(p.messages.join(" ").includes("FLAG"));
  const p2 = stubPlayer("Bob", 100);
  onDigGuildCommand(p2, ["inspect", "nope"]);
  assert.ok(p2.messages.join(" ").includes("failed"));
});

test("contribute moves real coins", () => {
  const p = stubPlayer("Bob", 300);
  onDigGuildCommand(p, ["contribute", "200"]);
  assert.strictEqual(p._coins(), 100);
  assert.ok(p.messages.join(" ").includes("conservation fund"));
  const p2 = stubPlayer("Bob", 100);
  onDigGuildCommand(p2, ["contribute", "abc"]);
  assert.ok(p2.messages.join(" ").includes("Usage"));
});

test("school reports promotion status", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["school"]);
  assert.ok(p.messages.join(" ").includes("tenure"));
});

test("apprentice arranges mentorship", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["apprentice", "Alice"]);
  assert.deepStrictEqual(guildCalls[0][0], "apprentice");
  const p2 = stubPlayer("Bob", 100);
  onDigGuildCommand(p2, ["apprentice"]);
  assert.ok(p2.messages.join(" ").includes("Usage"));
});

test("unknown subcommand prints usage", () => {
  const p = stubPlayer("Bob", 100);
  onDigGuildCommand(p, ["frobnicate"]);
  assert.ok(p.messages.join(" ").includes("::digguild"));
});

console.log(`CitizenDigGuildEvents: ${passed} tests passed`);
