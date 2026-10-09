"use strict";

/**
 * CitizenWeaverGuildEvents.test.js — ::weaverguild command contracts.
 * The guild data tier is stubbed in the require cache so plain-node tests
 * stay engine-free.
 *
 * Run: node server/plugins/citizens/CitizenWeaverGuildEvents.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "./brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["varrock"],
    kingdomIdOf: () => "varrock",
  },
};

const calls = { withdraw: [], reports: [], settled: [] };
const fakeGuilds = {
  DUES_WEEKLY: 25,
  WEAVERS_CODE: ["a", "b"],
  describe: () => ({ exists: true, memberCount: 1, grandcouturiers: 0, sealed: 0, inspection: 100, treasury: 0, prestige: 0 }),
  memberOf: () => ({ rank: "apprentice", suspended: false }),
  joinGuild: () => ({ ok: true }),
  leaveGuild: () => ({ ok: true }),
  recordDuesPayment: () => ({ ok: true }),
  submitCollection: (u, k, cid) => ({ ok: true, fee: 50, quality: 7 }),
  settleCertification: (k, cid) => { calls.settled.push(cid); return { ok: true, grade: "B", paid: 60, owed: 0 }; },
  withdrawSubmission: (k, cid) => { calls.withdraw.push(cid); return { ok: true }; },
  reportKnockoff: (k, accused, reporter) => { calls.reports.push({ accused, reporter }); return { ok: true, id: "k1" }; },
  inspectAteliers: () => ({ ok: true, inspection: 80, inspected: 1, idle: [] }),
  serialize: () => ({ cases: {} }),
  voteCase: () => ({ ok: true }),
  ensureGuild: () => ({ treasury: 0 }),
  holdClass: () => ({ ok: true, taught: 1 }),
  takeApprentice: () => ({ ok: true }),
};
const guildsPath = path.resolve(__dirname, "./lib/CitizenWeaverGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: fakeGuilds,
};

const { onWeaverGuildCommand } = require("./CitizenWeaverGuildEvents.js");

function fakePlayer(username, coins) {
  const messages = [];
  return {
    player: {
      username,
      getUsername: () => username,
      isRealPlayer: () => true,
      sendMessage: (t) => messages.push(String(t)),
      // Real ItemContainer contract: getAmount(id), deleteNumber(id, amount).
      getInventory: () => ({
        getAmount: (id) => (id === 995 ? coins : 0),
        deleteNumber: (id, n) => { if (id === 995) coins = Math.max(0, coins - n); },
      }),
    },
    messages,
    coinsLeft: () => coins,
  };
}

let passed = 0;
function check(name, fn) {
  calls.withdraw.length = 0;
  calls.reports.length = 0;
  calls.settled.length = 0;
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

check("certify with an unpaid fee withdraws the submission (no free certification)", () => {
  const f = fakePlayer("Anya", 10); // cannot afford the 50-coin fee
  onWeaverGuildCommand(f.player, "certify c1");
  assert.deepStrictEqual(calls.withdraw, ["c1"], "submission must be pulled back");
  assert.deepStrictEqual(calls.settled, [], "must NOT settle after a failed payment");
  assert.strictEqual(f.coinsLeft(), 10, "no coins taken");
  assert.ok(f.messages.some((m) => /50 coins/.test(m)), "player told the fee");
});

check("certify with fee paid settles and takes the coins", () => {
  const f = fakePlayer("Anya", 100);
  onWeaverGuildCommand(f.player, "certify c1");
  assert.deepStrictEqual(calls.withdraw, [], "nothing withdrawn");
  assert.deepStrictEqual(calls.settled, ["c1"]);
  assert.strictEqual(f.coinsLeft(), 50);
});

check("report accuses the named designer, never the reporter", () => {
  const f = fakePlayer("Anya", 100);
  onWeaverGuildCommand(f.player, "report Mallory");
  assert.strictEqual(calls.reports.length, 1);
  assert.strictEqual(calls.reports[0].accused, "Mallory");
  assert.strictEqual(calls.reports[0].reporter, "Anya");
});

check("report with no target asks for usage and reports nobody", () => {
  const f = fakePlayer("Anya", 100);
  onWeaverGuildCommand(f.player, "report");
  assert.deepStrictEqual(calls.reports, [], "no self-accusation");
  assert.ok(f.messages.some((m) => /report <designer>/.test(m)));
});

console.log(`\n${passed} tests passed`);
