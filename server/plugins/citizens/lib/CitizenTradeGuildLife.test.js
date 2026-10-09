"use strict";

/**
 * CitizenTradeGuildLife.test.js — plain-node tests for the merchants'
 * association life tick. Director, bots, sites, market stalls, and chat are
 * stubbed; the tick must never throw and must move real coins.
 */

const assert = require("assert");

const Guilds = require("./CitizenTradeGuilds");

// Stub sayPublic BEFORE requiring the Life module (top-level require).
const sayKey = require.resolve("../chat/CitizenSayPublic");
require.cache[sayKey] = {
  id: sayKey, filename: sayKey, loaded: true,
  exports: { sayPublic: () => {} },
};

const Life = require("./CitizenTradeGuildLife");

function fresh() {
  Guilds.resetForTests();
  Life.resetForTests();
}

// --- stubs ---
function makeBot(coins, wares) {
  let c = coins;
  return {
    inventory: {
      getAmount: (id) => (id === 995 ? c : 0),
      // Canonical ItemContainer API: deleteNumber(id, amount).
      deleteNumber: (id, n) => { if (id === 995) c = Math.max(0, c - n); },
    },
    getAttribute: (k) => (k === "citizens:market-wares" && wares ? JSON.stringify(wares) : null),
    sendMessage: () => {},
    _coins: () => c,
  };
}

function makeDirector(records) {
  const roster = new Map(records.map((r) => [r.username, r]));
  const bots = new Map(records.map((r) => [r.username, r.bot]));
  return {
    roster,
    isOnline: () => true,
    getBot: (r) => bots.get(r.username) || null,
  };
}

function stubSites(kingdoms) {
  const key = require.resolve("../brain/CitizenSites");
  require.cache[key] = {
    id: key, filename: key, loaded: true,
    exports: {
      KINGDOM_IDS: kingdoms,
      kingdomIdOf: (record) => record?.kingdomId || null,
      siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    },
  };
  return () => { delete require.cache[key]; };
}

function stubStalls(refPrices) {
  const key = require.resolve("./CitizenMarketStalls");
  require.cache[key] = {
    id: key, filename: key, loaded: true,
    exports: {
      parseMarketWares: (raw) => {
        if (!raw) return null;
        try {
          const l = JSON.parse(raw);
          return Array.isArray(l) ? l.filter((w) => w && w.id > 0 && w.price > 0) : null;
        } catch { return null; }
      },
      referencePrice: (director, id) => refPrices[id] || 1,
    },
  };
  return () => { delete require.cache[key]; };
}

const KID = "misthalin";
const PROOF = { guildMember: true };
const T0 = 3600000; // 1h: past the 30-min tick cooldown

// --- tests ---
fresh();
{
  const rs = stubSites([KID]);
  const rt = stubStalls({});
  Life.tickTradeGuildLife(makeDirector([]), T0);
  Life.tickTradeGuildLife(null, T0); // null director safe
  rs(); rt();
}
console.log("ok - never throws, empty director");

fresh();
{
  // Dues collected from real online inventories.
  const rs = stubSites([KID]);
  const rt = stubStalls({});
  Guilds.joinGuild(KID, "Alice", PROOF, T0 - 8 * 24 * 60 * 60 * 1000); // dues overdue
  const bot = makeBot(1000, null);
  const d = makeDirector([{ username: "alice", kingdomId: KID, bot }]);
  Life.tickTradeGuildLife(d, T0); // past cooldown, dues due
  assert.strictEqual(bot._coins(), 1000 - Guilds.DUES_WEEKLY, "dues taken from real inventory");
  assert.strictEqual(Guilds.guildTreasuryFor(KID), Guilds.DUES_WEEKLY - 5);
  assert.strictEqual(Guilds.fairFundFor(KID), 5);
  rs(); rt();
}
console.log("ok - dues from real coins");

fresh();
{
  // Broke member accrues a miss, not a crime.
  const rs = stubSites([KID]);
  const rt = stubStalls({});
  Guilds.joinGuild(KID, "Bob", PROOF, T0 - 8 * 24 * 60 * 60 * 1000); // dues overdue
  const bot = makeBot(0, null);
  const d = makeDirector([{ username: "bob", kingdomId: KID, bot }]);
  Life.tickTradeGuildLife(d, T0);
  const m = Guilds.memberOf("Bob");
  assert.strictEqual(m.suspended, false, "one miss is not suspension");
  assert.strictEqual(bot._coins(), 0);
  rs(); rt();
}
console.log("ok - broke member miss");

fresh();
{
  // Inspection: gouger flagged, honest stall passes silently.
  const rs = stubSites([KID]);
  const rt = stubStalls({ 42: 100 });
  const now = T0;
  Guilds.joinGuild(KID, "Insp", PROOF, now);
  Guilds.ensureGuild(KID).members["insp"].rank = Guilds.RANK_MASTER;
  const gouger = makeBot(500, [{ id: 42, price: 500 }]); // 5x ref
  const honest = makeBot(500, [{ id: 42, price: 150 }]); // 1.5x ref
  const d = makeDirector([
    { username: "insp", kingdomId: KID, bot: makeBot(500, null) },
    { username: "gouger", kingdomId: KID, bot: gouger },
    { username: "honest", kingdomId: KID, bot: honest },
  ]);
  Life.tickTradeGuildLife(d, T0 + 40 * 60 * 1000);
  const insp = Guilds.inspectionsFor("gouger");
  assert.strictEqual(insp.length, 1, "gouger inspected");
  assert.strictEqual(insp[0].pass, false);
  const hinsp = Guilds.inspectionsFor("honest");
  assert.strictEqual(hinsp.length, 1);
  assert.strictEqual(hinsp[0].pass, true);
  const cases = Guilds.openCases(KID);
  assert.ok(cases.some((c) => c.accused === "gouger" && c.kind === Guilds.CASE_GOUGING),
    "gouging auto-reported");
  rs(); rt();
}
console.log("ok - inspection flags gouger");

fresh();
{
  // Unlicensed stall triggers the unlicensed case.
  const rs = stubSites([KID]);
  const rt = stubStalls({ 7: 50 });
  const now = T0;
  Guilds.joinGuild(KID, "Insp", PROOF, now);
  Guilds.ensureGuild(KID).members["insp"].rank = Guilds.RANK_MASTER;
  const d = makeDirector([
    { username: "insp", kingdomId: KID, bot: makeBot(500, null) },
    { username: "stall", kingdomId: KID, bot: makeBot(500, [{ id: 7, price: 60 }]) },
  ]);
  Life.tickTradeGuildLife(d, T0 + 40 * 60 * 1000);
  const cases = Guilds.openCases(KID);
  assert.ok(cases.some((c) => c.accused === "stall" && c.kind === Guilds.CASE_UNLICENSED),
    "unlicensed trading reported");
  rs(); rt();
}
console.log("ok - unlicensed scan");

fresh();
{
  // Throttle: second tick inside the cooldown does nothing.
  const rs = stubSites([KID]);
  const rt = stubStalls({});
  const bot = makeBot(1000, null);
  const d = makeDirector([{ username: "zed", kingdomId: KID, bot }]);
  const t = T0 + 40 * 60 * 1000;
  Life.tickTradeGuildLife(d, t);
  const afterFirst = bot._coins();
  Life.tickTradeGuildLife(d, t + 1000); // inside 30-min cooldown
  assert.strictEqual(bot._coins(), afterFirst, "throttled tick takes nothing");
  rs(); rt();
}
console.log("ok - tick throttle");

console.log("\nAll CitizenTradeGuildLife tests passed.");
