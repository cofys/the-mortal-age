"use strict";

/**
 * CitizenInsuranceLife.test.js — slow-tick tests for REAL insurance.
 * Plain node, no jest. Real data tier + real careers, stubbed funerals/
 * health for deterministic claim triggers.
 */

const assert = require("assert");
const Module = require("module");
const origRequire = Module.prototype.require;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack?.split("\n")[1] ?? ""}`);
  }
}

// --- Stubs for claim triggers (deterministic) ---
const stubFunerals = { _deaths: [], getDeceased() { return this._deaths.slice(); }, reset() { this._deaths = []; } };
const stubHealth = { _sick: {}, recordOf(u) { return this._sick[String(u ?? "").toLowerCase()] ?? null; }, reset() { this._sick = {}; } };

Module.prototype.require = function (id) {
  if (id === "./CitizenFunerals") return stubFunerals;
  if (id === "./CitizenHealth") return stubHealth;
  return origRequire.apply(this, arguments);
};

const Insurance = require("./CitizenInsurance");
const Careers = require("./CitizenCareers");
const { tickInsuranceLife } = require("./CitizenInsuranceLife");

// --- Mock director ---
function mockBot(coins) {
  const inv = {
    coins,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    add(id, n) { if (id === 995) this.coins += n; },
    remove(id, n) { if (id === 995 && this.coins >= n) { this.coins -= n; return true; } return false; },
  };
  return { getInventory: () => inv, _inv: inv };
}

function mockDirector(records, botsByName) {
  const bots = {};
  for (const k of Object.keys(botsByName)) bots[k.toLowerCase()] = botsByName[k];
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    isOnline: (rec) => !!bots[String(rec?.username ?? "").toLowerCase()],
    getBot: (rec) => bots[String(rec?.username ?? "").toLowerCase()] ?? null,
    getLocalPlayers: () => [],
    log: () => {},
    getJournal: () => ({ log: () => {} }),
  };
}

function rec(username, kingdomId, age) {
  return { username, role: "commoner", kingdomId, personality: { age: age ?? 30 } };
}

function setup() {
  Insurance.resetForTests();
  stubFunerals.reset();
  stubHealth.reset();
  try { Careers.resetForTests(); } catch { /* optional */ }
  Insurance._data().pool = 1000000;
  Insurance._data().totalPremiums = 1000000;
}

test("appoints insurers from the insurer career, one per kingdom", () => {
  setup();
  Careers.setCareer("Alice", "insurer", Date.now());
  const d = mockDirector([rec("Alice", "misthalin")], {});
  tickInsuranceLife(d, Date.now());
  const reg = Insurance.insurerFor("Alice");
  assert(reg, "alice appointed");
  assert.strictEqual(reg.kingdomId, "misthalin");
  // Second tick does not duplicate.
  tickInsuranceLife(d, Date.now());
  assert.strictEqual(Insurance.insurersIn("misthalin").length, 1);
});

test("collects weekly premiums from online holders", () => {
  setup();
  const bot = mockBot(10000);
  const d = mockDirector([rec("Bob", "misthalin")], { Bob: bot });
  const b = Insurance.buyPolicy(bot, "Bob", "life", 5000, { kingdomId: "misthalin" });
  assert.strictEqual(b.ok, true);
  const poolBefore = Insurance.poolBalance();
  const coinsBefore = bot._inv.coins;
  const policy = Insurance.policyFor("Bob", "life");
  policy.nextDueAt = Date.now() - 1000;
  Insurance.markDirty();
  tickInsuranceLife(d, Date.now());
  assert.strictEqual(bot._inv.coins, coinsBefore - policy.premium, "premium taken from inventory");
  assert.strictEqual(Insurance.poolBalance(), poolBefore + policy.premium, "premium lands in pool");
  assert(policy.nextDueAt > Date.now(), "due date renewed");
});

test("offline holders lapse after repeated missed premiums", () => {
  setup();
  const bot = mockBot(10000);
  const d = mockDirector([rec("Cara", "misthalin")], { Cara: bot });
  assert.strictEqual(Insurance.buyPolicy(bot, "Cara", "health", 2000, { kingdomId: "misthalin" }).ok, true);
  const policy = Insurance.policyFor("Cara", "health");
  policy.nextDueAt = Date.now() - 1000;
  Insurance.markDirty();
  // Cara goes offline: no bot in the director.
  const dOffline = mockDirector([rec("Cara", "misthalin")], {});
  for (let i = 0; i <= Insurance.MAX_MISSED; i++) tickInsuranceLife(dOffline, Date.now());
  assert.strictEqual(Insurance.policyFor("Cara", "health").status, "lapsed", "lapsed after misses");
});

test("death claims pay life policies from the funeral feed", () => {
  setup();
  const bot = mockBot(10000);
  const d = mockDirector([rec("Dan", "misthalin")], { Dan: bot });
  assert.strictEqual(Insurance.buyPolicy(bot, "Dan", "life", 8000, { kingdomId: "misthalin" }).ok, true);
  const poolBefore = Insurance.poolBalance();
  stubFunerals._deaths = [{ username: "Dan", diedAt: Date.now() }];
  tickInsuranceLife(d, Date.now());
  const policy = Insurance.policyFor("Dan", "life");
  assert.strictEqual(policy.status, "claimed", "life policy paid out");
  assert(Insurance.poolBalance() < poolBefore, "pool paid the claim");
  // A second tick does not pay again (watermark advanced).
  const poolAfter = Insurance.poolBalance();
  tickInsuranceLife(d, Date.now());
  assert.strictEqual(Insurance.poolBalance(), poolAfter, "no double payout");
});

test("sickness triggers health claims once per bout", () => {
  setup();
  const bot = mockBot(10000);
  const d = mockDirector([rec("Erin", "asgarnia")], { Erin: bot });
  assert.strictEqual(Insurance.buyPolicy(bot, "Erin", "health", 4000, { kingdomId: "asgarnia" }).ok, true);
  const poolBefore = Insurance.poolBalance();
  stubHealth._sick = { erin: { illness: "flu" } };
  tickInsuranceLife(d, Date.now());
  assert.strictEqual(Insurance.poolBalance(), poolBefore - 2000, "half face paid");
  const poolAfter = Insurance.poolBalance();
  tickInsuranceLife(d, Date.now());
  assert.strictEqual(Insurance.poolBalance(), poolAfter, "same bout not paid twice");
});

test("insurers sell policies to uninsured citizens who can afford them", () => {
  setup();
  Careers.setCareer("Fay", "insurer", Date.now());
  Insurance.registerInsurer("Fay", "misthalin");
  const bot = mockBot(20000);
  const d = mockDirector([rec("Fay", "misthalin"), rec("Gus", "misthalin")], { Fay: mockBot(5000), Gus: bot });
  const soldBefore = Insurance.stats().policiesSold;
  tickInsuranceLife(d, Date.now());
  const gusPolicies = Insurance.policiesOf("Gus");
  assert(gusPolicies.length > 0, "gus was sold a policy");
  assert(bot._inv.coins < 20000, "gus paid real coins");
  assert.strictEqual(Insurance.stats().policiesSold, soldBefore + 1);
});

test("tick never throws on an empty director", () => {
  setup();
  tickInsuranceLife({}, Date.now());
  tickInsuranceLife(null, Date.now());
});

console.log(`\nCitizenInsuranceLife: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
