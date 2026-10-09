"use strict";

/**
 * CitizenSpyGuilds.test.js — plain-node tests for the spymasters'
 * association (espionage guild). No jest, no engine. CitizenCareers,
 * CitizenEspionage, CitizenBanking, CitizenReputation, CitizenSites are
 * stubbed through the require cache.
 */

const assert = require("assert");

const Guilds = require("./CitizenSpyGuilds");

function fresh() {
  Guilds.resetForTests();
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `spyguild-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  }
  Guilds._setSavePathForTests(fresh.tmp);
}

// --- stubs -------------------------------------------------------------------

function stubCareers(careerMap) {
  const key = require.resolve("./CitizenCareers");
  const fake = {
    careerOf: (u) => {
      const k = String(u || "").trim().toLowerCase();
      const c = (careerMap || {})[k];
      return c ? { key: c } : null;
    },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubSites() {
  const key = require.resolve("../brain/CitizenSites");
  const fake = {
    KINGDOM_IDS: ["misthalin", "kandarin", "asgarnia"],
    siteTile: (who, kind) => ({ x: 3200, y: 3200, z: 0 }),
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubEspionage(cfg) {
  const key = require.resolve("./CitizenEspionage");
  const c = cfg || {};
  const fake = {
    networkFor: (kid) => (c.networks || {})[String(kid || "").toLowerCase()] || null,
    cellFor: (u) => {
      const cells = c.cells || [];
      return cells.find((x) => String(x.spy || "").trim().toLowerCase() === String(u || "").trim().toLowerCase() && !x.recalledAt) || null;
    },
    cellsIn: (kid) => (c.cells || []).filter((x) => String(x.targetKingdom || "").toLowerCase() === String(kid || "").toLowerCase() && !x.recalledAt),
    counterAgentsOf: (kid) => (c.counters || {})[String(kid || "").toLowerCase()] || [],
    isHandler: (kid, u) => {
      const net = (c.networks || {})[String(kid || "").toLowerCase()];
      return !!(net && (net.handlers || []).some((x) => String(x).trim().toLowerCase() === String(u || "").trim().toLowerCase()));
    },
    interrogate: ({ spy, by }) => {
      c.interrogated = c.interrogated || [];
      c.interrogated.push({ spy, by });
      return (c.revealed || {})[String(spy || "").trim().toLowerCase()] || [];
    },
    interrogationsOf: (u) => (c.pastInterrogations || {})[String(u || "").trim().toLowerCase()] || [],
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubBanking() {
  const key = require.resolve("./CitizenBanking");
  const accounts = {};
  // Real contract: accountFor(username) -> live account record;
  // markDirty() -> persist. creditAccount does NOT exist on the engine —
  // the old mock masked a silent no-op.
  const fake = {
    accountFor: (u) => {
      const k = String(u || "").trim().toLowerCase();
      accounts[k] = accounts[k] || { balance: 0 };
      return accounts[k];
    },
    markDirty: () => { fake._dirty = true; },
    _accounts: accounts,
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  const un = () => { delete require.cache[key]; };
  return { un, balanceOf: (u) => (accounts[String(u || "").trim().toLowerCase()] || {}).balance || 0 };
}

function stubReputation() {
  const key = require.resolve("./CitizenReputation");
  const awarded = [];
  const fake = { awardDeed: (u, kind) => { awarded.push({ u, kind }); return 0; } };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  const un = () => { delete require.cache[key]; };
  return { un, awarded };
}

// --- tests -------------------------------------------------------------------

function testGuildAndHall() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubEspionage({})];
  const g = Guilds.ensureGuild("misthalin");
  assert.ok(g, "guild created");
  assert.strictEqual(g.treasury, 0, "treasury starts at 0");
  assert.ok(g.hallTile && typeof g.hallTile.x === "number", "hall tile placed");
  // Back-alley offset: not the market tile itself.
  assert.ok(g.hallTile.x !== 3200 || g.hallTile.y !== 3200, "hall offset from market");
  cleanup(...un);
}

function testJoinGating() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage({})];
  // Alice: spymaster career -> real spy.
  let r = Guilds.joinGuild("misthalin", "Alice");
  assert.ok(r.ok && r.rank === "operative", "career spymaster can join");
  // Bob: nobody -> rejected honestly.
  r = Guilds.joinGuild("misthalin", "Bob");
  assert.ok(!r.ok && r.reason === "not-a-spy", "non-spy rejected");
  // Duplicate join rejected.
  r = Guilds.joinGuild("misthalin", "Alice");
  assert.ok(!r.ok && r.reason === "already-member", "double join rejected");
  cleanup(...un);
}

function testJoinViaNetwork() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubEspionage({
    networks: { misthalin: { spies: ["Netsy"], handlers: ["Handy"] } },
  })];
  let r = Guilds.joinGuild("misthalin", "Netsy");
  assert.ok(r.ok, "network spy can join");
  r = Guilds.joinGuild("misthalin", "Handy");
  assert.ok(r.ok, "network handler can join");
  cleanup(...un);
}

function testJoinViaCellAndCounter() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubEspionage({
    cells: [{ spy: "Abroad", homeKingdom: "misthalin", targetKingdom: "kandarin" }],
    counters: { misthalin: ["Hunter"] },
  })];
  let r = Guilds.joinGuild("misthalin", "Abroad");
  assert.ok(r.ok, "live cell operative can join");
  r = Guilds.joinGuild("misthalin", "Hunter");
  assert.ok(r.ok, "counter-agent can join");
  // A cell operative for misthalin's network is not a kandarin spy.
  r = Guilds.joinGuild("kandarin", "Abroad");
  assert.ok(!r.ok && r.reason === "not-a-spy", "foreign cell operative rejected by other kingdom");
  cleanup(...un);
}

function testDuesHonesty() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage({})];
  Guilds.joinGuild("misthalin", "Alice");
  const g = Guilds.guildOf("misthalin");
  assert.strictEqual(g.treasury, 0, "no dues yet");
  Guilds.recordDuesPayment("Alice");
  assert.strictEqual(g.treasury, Guilds.DUES_WEEKLY - Guilds.DUES_TRADECRAFT_SHARE, "treasury credited");
  assert.strictEqual(g.tradecraftFund, Guilds.DUES_TRADECRAFT_SHARE, "tradecraft fund fed");
  Guilds.recordMissedDues("Alice");
  Guilds.recordMissedDues("Alice");
  const m = Guilds.memberOf("Alice");
  assert.ok(m.suspended, "suspended after 2 missed");
  // Payment lifts suspension.
  Guilds.recordDuesPayment("Alice");
  assert.ok(!Guilds.memberOf("Alice").suspended, "payment lifts suspension");
  cleanup(...un);
}

function testTradecraftCode() {
  fresh();
  const code = Guilds.tradecraftCode();
  assert.strictEqual(code.length, 5, "five-point code");
  assert.ok(code[0].includes("Discretion"), "first tenet is discretion");
  cleanup();
}

function testDeadDrops() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster", bob: "spymaster", zed: "spymaster" }), stubEspionage({})];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Bob");
  // Alice leaves a sealed drop for Bob.
  let r = Guilds.leaveDrop("misthalin", "Alice", "Bob", "The raven flies at midnight.");
  assert.ok(r.ok && r.dropId, "drop left");
  // Bob picks it up.
  const p = Guilds.pickupDrops("Bob");
  assert.ok(p.ok && p.drops.length === 1, "one drop for Bob");
  assert.strictEqual(p.drops[0].text, "The raven flies at midnight.", "message intact");
  assert.strictEqual(p.drops[0].from, "Alice", "sender recorded");
  // Second pickup: already read, still listed but marked.
  const p2 = Guilds.pickupDrops("Bob");
  assert.strictEqual(p2.drops.length, 1, "drop still listed after read");
  assert.strictEqual(Guilds.unreadDropCount("Bob"), 0, "no unread drops after read");
  // Non-member recipient rejected honestly.
  r = Guilds.leaveDrop("misthalin", "Alice", "Stranger", "hello");
  assert.ok(!r.ok && r.reason === "recipient-not-standing", "outsider recipient rejected");
  // Non-member sender rejected.
  r = Guilds.leaveDrop("misthalin", "Stranger", "Bob", "hello");
  assert.ok(!r.ok && r.reason === "sender-not-standing", "outsider sender rejected");
  // Self-drops rejected.
  r = Guilds.leaveDrop("misthalin", "Alice", "Alice", "hello");
  assert.ok(!r.ok && r.reason === "no-self-drops", "self-drop rejected");
  // Empty message rejected.
  r = Guilds.leaveDrop("misthalin", "Alice", "Bob", "   ");
  assert.ok(!r.ok && r.reason === "empty-message", "empty message rejected");
  // Expiry pruning.
  Guilds.leaveDrop("misthalin", "Alice", "Bob", "old news", Date.now() - Guilds.DROP_TTL_MS - 1000);
  const pruned = Guilds.pruneDrops("misthalin", Date.now());
  assert.strictEqual(pruned, 1, "expired drop pruned");
  cleanup(...un);
}

function testSanctuary() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage({})];
  Guilds.joinGuild("misthalin", "Alice");
  assert.ok(!Guilds.inSanctuary("Alice"), "not hidden initially");
  const r = Guilds.layLow("misthalin", "Alice");
  assert.ok(r.ok && r.untilMs > Date.now(), "sanctuary granted");
  assert.ok(Guilds.inSanctuary("Alice"), "hidden now");
  // Double sanctuary rejected.
  const r2 = Guilds.layLow("misthalin", "Alice");
  assert.ok(!r2.ok && r2.reason === "already-hidden", "double sanctuary rejected");
  // Expiry.
  const expired = Guilds.expireSanctuaries("misthalin", r.untilMs + 1000);
  assert.strictEqual(expired, 1, "sanctuary expired");
  assert.ok(!Guilds.inSanctuary("Alice"), "no longer hidden");
  cleanup(...un);
}

function testMoleTribunal() {
  fresh();
  const rep = stubReputation();
  const un = [stubSites(), stubCareers({ alice: "spymaster", mole: "spymaster", voter: "spymaster" }), stubEspionage({
    cells: [{ spy: "Mole", homeKingdom: "kandarin", targetKingdom: "misthalin" }],
  })];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Mole");
  Guilds.joinGuild("misthalin", "Voter");
  // Promote Alice and Voter to spymaster rank directly for the vote.
  const g = Guilds.guildOf("misthalin");
  g.members["alice"].rank = Guilds.RANK_SPYMASTER;
  g.members["voter"].rank = Guilds.RANK_SPYMASTER;
  // Mole scan: Mole runs a live kandarin cell in misthalin -> verifiable.
  assert.strictEqual(Guilds.scanMole("misthalin", "Mole"), "mole", "mole detected");
  assert.strictEqual(Guilds.scanMole("misthalin", "Alice"), null, "clean member not a mole");
  // Report.
  const rep1 = Guilds.reportMisconduct("misthalin", "Mole", "mole", "Alice");
  assert.ok(rep1.ok, "mole case opened");
  // Double jeopardy.
  const rep2 = Guilds.reportMisconduct("misthalin", "Mole", "mole", "Voter");
  assert.ok(!rep2.ok && rep2.reason === "already-open", "no double jeopardy");
  // Unverifiable report rejected.
  const rep3 = Guilds.reportMisconduct("misthalin", "Alice", "mole", "Voter");
  assert.ok(!rep3.ok && rep3.reason === "unverifiable", "clean member not reportable");
  // Vote + settle.
  Guilds.voteOnCase("misthalin", rep1.caseId, "Alice", true);
  Guilds.voteOnCase("misthalin", rep1.caseId, "Voter", true);
  const s = Guilds.settleCase("misthalin", rep1.caseId);
  assert.strictEqual(s.verdict, "guilty", "guilty verdict");
  assert.ok(!Guilds.isGuildMember("Mole"), "mole expelled");
  assert.ok(rep.awarded.some((a) => a.u === "Mole" && a.kind === "doubleagent"), "doubleagent deed awarded");
  // Non-spymaster cannot vote.
  const rep4 = Guilds.reportMisconduct("misthalin", "Alice", "mole", "Voter");
  assert.ok(!rep4.ok, "no cell, no case");
  cleanup(...un, rep.un);
}

function testMoleAcquittal() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster", mole: "spymaster" }), stubEspionage({
    cells: [{ spy: "Mole", homeKingdom: "kandarin", targetKingdom: "misthalin" }],
  })];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Mole");
  const g = Guilds.guildOf("misthalin");
  g.members["alice"].rank = Guilds.RANK_SPYMASTER;
  const rep1 = Guilds.reportMisconduct("misthalin", "Mole", "mole", "Alice");
  Guilds.voteOnCase("misthalin", rep1.caseId, "Alice", false);
  const s = Guilds.settleCase("misthalin", rep1.caseId);
  assert.strictEqual(s.verdict, "acquitted", "acquittal on not-guilty vote");
  assert.ok(Guilds.isGuildMember("Mole"), "acquitted member stays");
  cleanup(...un);
}

function testInterrogationBounty() {
  fresh();
  const espCfg = { revealed: { caughtspy: ["op-1", "op-2"] } };
  const un = [stubSites(), stubCareers({ alice: "spymaster", bob: "spymaster" }), stubEspionage(espCfg)];
  const bank = stubBanking();
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Bob");
  const g = Guilds.guildOf("misthalin");
  g.members["alice"].rank = Guilds.RANK_SPYMASTER;
  g.tradecraftFund = 500;
  const r = Guilds.bountyInterrogation("misthalin", "Alice", "CaughtSpy");
  assert.ok(r.ok, "bounty interrogation runs");
  assert.deepStrictEqual(r.revealed, ["op-1", "op-2"], "real op ids revealed");
  assert.strictEqual(r.paid, Guilds.INTERROGATION_BOUNTY, "full bounty paid");
  assert.strictEqual(r.owed, 0, "nothing owed");
  assert.ok(bank.balanceOf("Alice") === Guilds.INTERROGATION_BOUNTY, "bank credited via real accountFor");
  assert.strictEqual(g.tradecraftFund, 500 - Guilds.INTERROGATION_BOUNTY, "fund debited");
  assert.strictEqual(g.intel.length, 1, "intel logged");
  // Non-spymaster cannot run bounty interrogations.
  const r2 = Guilds.bountyInterrogation("misthalin", "Bob", "CaughtSpy");
  assert.ok(!r2.ok && r2.reason === "spymasters-only", "operatives cannot interrogate for bounty");
  // Broke fund: owed honestly.
  g.tradecraftFund = 30;
  const r3 = Guilds.bountyInterrogation("misthalin", "Alice", "CaughtSpy");
  assert.ok(r3.ok && r3.paid === 30 && r3.owed === Guilds.INTERROGATION_BOUNTY - 30, "partial bounty, rest owed");
  const retry = Guilds.retryOwedBounties("misthalin");
  assert.strictEqual(retry, 0, "nothing to retry with empty fund");
  g.tradecraftFund = 1000;
  const retry2 = Guilds.retryOwedBounties("misthalin");
  assert.ok(retry2 > 0, "owed bounty retried when fund refills");
  cleanup(...un, bank.un);
}

function testSchoolAndPromotion() {
  fresh();
  const rep = stubReputation();
  const un = [stubSites(), stubCareers({ alice: "spymaster", bob: "spymaster" }), stubEspionage({
    networks: { misthalin: { spies: ["Bob"], handlers: ["Bob"] } },
  })];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Bob");
  const g = Guilds.guildOf("misthalin");
  g.members["alice"].rank = Guilds.RANK_SPYMASTER;
  // Bob is a handler in the real network -> veteran, verifiable.
  const cls = Guilds.holdClass("misthalin", "Alice");
  assert.ok(cls.ok && cls.taught >= 1, "class taught");
  g.members["bob"].trainingCredits = 5;
  g.members["bob"].joinedAtMs = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const p = Guilds.tryPromote("Bob");
  assert.ok(p.ok && p.rank === "agent", "handler promoted to agent");
  // Agent -> spymaster needs interrogations led.
  g.members["bob"].trainingCredits = 10;
  g.members["bob"].joinedAtMs = Date.now() - 61 * 24 * 60 * 60 * 1000;
  const p2 = Guilds.tryPromote("Bob");
  assert.ok(!p2.ok, "not enough interrogations yet");
  g.members["bob"].interrogationsLed = 2;
  const p3 = Guilds.tryPromote("Bob");
  assert.ok(p3.ok && p3.rank === "spymaster", "promoted to spymaster");
  assert.ok(rep.awarded.some((a) => a.u === "Bob" && a.kind === "shadowmaster"), "shadowmaster deed awarded");
  // Max rank.
  const p4 = Guilds.tryPromote("Bob");
  assert.ok(!p4.ok && p4.reason === "max-rank", "no promotion past spymaster");
  cleanup(...un, rep.un);
}

function testContributeAndDescribe() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage({})];
  Guilds.joinGuild("misthalin", "Alice");
  const r = Guilds.contributeTradecraft("misthalin", 250);
  assert.ok(r.ok && r.contributed === 250, "contribution recorded");
  const d = Guilds.describe("misthalin");
  assert.strictEqual(d.members, 1, "one member");
  assert.strictEqual(d.tradecraftFund, 250, "fund holds the contribution (dues are paid separately)");
  assert.strictEqual(d.unreadDrops, 0, "no drops");
  Guilds.leaveGuild("Alice");
  assert.ok(!Guilds.isGuildMember("Alice"), "left the guild");
  assert.strictEqual(Guilds.describe("misthalin").members, 0, "no members left");
  cleanup(...un);
}

function testPersistence() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage({})];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.leaveDrop("misthalin", "Alice", "Alice2", "x").ok; // will fail (not member) — fine
  assert.ok(Guilds.save(), "save returns true when dirty");
  Guilds.resetForTests();
  Guilds._setSavePathForTests(fresh.tmp);
  const m = Guilds.memberOf("Alice");
  assert.ok(m && m.rank === "operative", "member persisted");
  cleanup(...un);
}

function cleanup(...uns) {
  for (const u of uns) { try { u(); } catch { /* already cleaned */ } }
}

const tests = [
  testGuildAndHall,
  testJoinGating,
  testJoinViaNetwork,
  testJoinViaCellAndCounter,
  testDuesHonesty,
  testTradecraftCode,
  testDeadDrops,
  testSanctuary,
  testMoleTribunal,
  testMoleAcquittal,
  testInterrogationBounty,
  testSchoolAndPromotion,
  testContributeAndDescribe,
  testPersistence,
];

let passed = 0;
for (const t of tests) {
  try {
    t();
    passed++;
  } catch (e) {
    console.error(`FAIL ${t.name}: ${e.message}`);
    console.error(e.stack.split("\n").slice(0, 4).join("\n"));
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} CitizenSpyGuilds tests passed`);
