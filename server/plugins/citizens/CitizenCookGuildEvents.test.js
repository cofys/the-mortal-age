"use strict";

/**
 * CitizenCookGuildEvents.test.js — the ::cookguild command contracts without a
 * running server. Bots are rejected, honest failures are messaged, and the
 * data tier is stubbed in the require cache.
 *
 * Run: node server/plugins/citizens/CitizenCookGuildEvents.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "./brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { kingdomIdOf: () => "varrock" },
};

const fakeCareers = { careers: new Map() };
const careersPath = path.resolve(__dirname, "./lib/CitizenCareers.js");
require.cache[careersPath] = {
  id: careersPath, filename: careersPath, loaded: true,
  exports: { careerOf: (u) => fakeCareers.careers.get(String(u || "").toLowerCase()) || null },
};

const cuisinePath = path.resolve(__dirname, "./lib/CitizenCuisine.js");
require.cache[cuisinePath] = {
  id: cuisinePath, filename: cuisinePath, loaded: true,
  exports: { isMasterChef: () => false, menuFor: () => [], dishById: () => null },
};

const cookoffsPath = path.resolve(__dirname, "./lib/CitizenCookOffs.js");
require.cache[cookoffsPath] = {
  id: cookoffsPath, filename: cookoffsPath, loaded: true,
  exports: { recipeById: () => null, recipesByChef: () => [] },
};

const guildsPath = path.resolve(__dirname, "./lib/CitizenCookGuilds.js");
const guildCalls = [];
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    RANK_APPRENTICE: "apprentice",
    RANK_CHEFDECUISINE: "chefdecuisine",
    CERT_FEE: 50,
    describe: (kid) => {
      guildCalls.push(["describe", kid]);
      return { exists: true, memberCount: 3, chefdecuisines: 1, sealed: 5, hygiene: 90, treasury: 200, prestige: 40 };
    },
    memberOf: () => null,
    joinGuild: (u, kid) => { guildCalls.push(["joinGuild", u, kid]); return { ok: false, reason: "not-a-chef" }; },
    leaveGuild: () => ({ ok: true }),
    recordDuesPayment: () => ({ ok: true }),
    CULINARY_CODE: ["code line one", "code line two"],
    submitRecipe: () => ({ ok: false, reason: "no-such-recipe" }),
    sealsFor: () => [],
    reportTheft: (kid, accused, reporter) => {
      guildCalls.push(["reportTheft", kid, accused, reporter]);
      return { ok: true, id: "case-1" };
    },
    inspectKitchens: () => ({ ok: true, hygiene: 90, inspected: 0, fails: [] }),
    openCases: () => [],
    voteCase: () => ({ ok: false, reason: "not-chefdecuisine" }),
    grantLadle: () => ({ ok: false, reason: "too-soon" }),
    contribute: () => ({ ok: true }),
    holdClass: () => ({ ok: true, taught: 0 }),
    takeApprentice: () => ({ ok: false, reason: "not-chefdecuisine" }),
  },
};

// --- real module under test ---

const { onCookGuildCommand, COOKGUILD_USAGE } = require("./CitizenCookGuildEvents");

function stubPlayer(username, { bot = false, coins = 0 } = {}) {
  const messages = [];
  return {
    messages,
    getUsername: () => username,
    isBot: bot,
    isRealPlayer: () => !bot,
    getInventory: () => ({
      // Real ItemContainer API: getAmount(id), deleteNumber(id, amount).
      getAmount: (id) => (id === 995 ? coins : 0),
      deleteNumber: (id, n) => { if (id === 995 && coins >= n) coins -= n; },
    }),
    sendMessage: (t) => messages.push(String(t)),
  };
}

let passed = 0;
function test(name, fn) {
  guildCalls.length = 0;
  fakeCareers.careers = new Map();
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

test("exports the usage string", () => {
  assert.ok(COOKGUILD_USAGE.includes("::cookguild"));
  assert.ok(COOKGUILD_USAGE.includes("certify"));
});

test("bots are rejected", () => {
  const p = stubPlayer("BotGordon", { bot: true });
  onCookGuildCommand(p, "status");
  assert.ok(p.messages.some((m) => /own sessions/i.test(m)), "bot rejection messaged");
  assert.strictEqual(guildCalls.length, 0, "no guild calls for bots");
});

test("status reports the guild honestly", () => {
  const p = stubPlayer("Jon");
  onCookGuildCommand(p, "status");
  assert.deepStrictEqual(guildCalls[0], ["describe", "varrock"]);
  assert.ok(p.messages.some((m) => /3 members/.test(m)), "member count reported");
  assert.ok(p.messages.some((m) => /not a member/i.test(m)), "non-member status honest");
});

test("join failure is messaged honestly", () => {
  const p = stubPlayer("Jon");
  onCookGuildCommand(p, "join");
  assert.deepStrictEqual(guildCalls[0], ["joinGuild", "Jon", "varrock"]);
  assert.ok(p.messages.some((m) => /chef/i.test(m)), "not-a-chef explained");
});

test("code shows the culinary code", () => {
  const p = stubPlayer("Jon");
  onCookGuildCommand(p, "code");
  assert.ok(p.messages.some((m) => /code line one/i.test(m)));
});

test("certify without a recipe id asks for one", () => {
  const p = stubPlayer("Jon");
  onCookGuildCommand(p, "certify");
  assert.ok(p.messages.some((m) => /recipe/i.test(m)));
});

test("unknown subcommand shows usage", () => {
  const p = stubPlayer("Jon");
  onCookGuildCommand(p, "frobnicate");
  assert.ok(p.messages.some((m) => m.includes("::cookguild")));
});

test("report accuses the named chef, not the reporter", () => {
  // Regression: reportTheft(kingdomId, username, username) opened the theft
  // case against the REPORTER — a self-accusation.
  const p = stubPlayer("Jon");
  onCookGuildCommand(p, "report Heston");
  assert.deepStrictEqual(guildCalls[0], ["reportTheft", "varrock", "Heston", "Jon"],
    "the named chef is accused, the reporter is the reporter");
  assert.ok(p.messages.some((m) => /Heston/.test(m)), "confirmation names the accused");
});

test("report without a name shows usage and opens no case", () => {
  const p = stubPlayer("Jon");
  onCookGuildCommand(p, "report");
  assert.ok(!guildCalls.some(([c]) => c === "reportTheft"), "no self-accusation without a target");
  assert.ok(p.messages.some((m) => /report <name>/.test(m)), "usage names the target argument");
});

console.log(`\nCitizenCookGuildEvents: ${passed} passed`);
