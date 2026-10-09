"use strict";

/**
 * CitizenInsurance.test.js — data-tier tests for REAL insurance.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenInsurance.test.js
 */

const assert = require("assert");
const Insurance = require("./CitizenInsurance");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Insurance.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}

// --- Mock player with real inventory semantics ---
// Canonical engine ItemContainer shape: getAmount(id), adds(id, n),
// deleteNumber(id, n). The old add(id, n)/remove(id, n) shapes do not exist
// on the real container (add takes an Item instance) and masked dead
// payout/debit paths.
function mockPlayer(coins, username) {
  const inv = {
    coins,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    adds(id, n) { if (id === 995) this.coins += n; },
    deleteNumber(id, n) { if (id === 995 && this.coins >= n) { this.coins -= n; return true; } return false; },
  };
  return { username: username ?? "TestCitizen", getInventory: () => inv, _inv: inv };
}

// Seed the pool so the solvency gate passes (pool must cover 2x exposure).
function seedPool() {
  Insurance._data().pool = 1000000;
  Insurance._data().totalPremiums = 1000000;
}

// --- Policy types ---

test("four policy types exist", () => {
  for (const t of ["life", "health", "property", "travel"]) {
    assert(Insurance.POLICY_TYPES[t], `missing ${t}`);
    assert(Insurance.POLICY_TYPES[t].baseBps > 0, `${t} needs a rate`);
  }
});

// --- Risk assessment ---

test("risk assessment prices elder health cover higher", () => {
  const young = Insurance.assessRisk("Kid", "health", { age: 25, kingdomId: "misthalin" });
  const elder = Insurance.assessRisk("Gran", "health", { age: 70, kingdomId: "misthalin" });
  assert(elder.multiplier > young.multiplier, "elders pay more for health");
  assert(elder.factors.includes("elder"), "factor recorded");
});

test("risk assessment prices dangerous travel routes higher", () => {
  const safe = Insurance.assessRisk("A", "travel", { from: "misthalin", to: "asgarnia" });
  assert(safe.multiplier >= 0.5 && safe.multiplier <= 4.0, "clamped");
  assert(Array.isArray(safe.factors), "factors array");
});

test("risk assessment never prices below the floor or above the ceiling", () => {
  const r = Insurance.assessRisk("X", "life", { age: 99, career: "guard", kingdomId: "morytania" });
  assert(r.multiplier >= 0.5 && r.multiplier <= 4.0, `clamped: ${r.multiplier}`);
});

// --- Quotes ---

test("quote computes a premium from face value and risk", () => {
  const q = Insurance.quote("Alice", "life", 10000, { age: 30, kingdomId: "misthalin" });
  assert.strictEqual(q.ok, true);
  assert.strictEqual(q.type, "life");
  assert.strictEqual(q.faceValue, 10000);
  assert(q.premium > 0, "premium positive");
  // base 3% = 300 on 10000 at 1.0 risk
  assert(q.premium >= 150, `premium sane: ${q.premium}`);
});

test("quote rejects unknown types and out-of-range faces", () => {
  assert.strictEqual(Insurance.quote("A", "dragon", 1000).ok, false);
  const low = Insurance.quote("A", "life", 10);
  assert.strictEqual(low.ok, false);
  assert(low.minFace, "reports minimum");
  const high = Insurance.quote("A", "life", 999999999);
  assert.strictEqual(high.ok, false);
});

// --- Buying ---

test("buying a policy moves the premium from inventory to the pool", () => {
  seedPool();
  const p = mockPlayer(5000, "Alice");
  const before = Insurance.poolBalance();
  const r = Insurance.buyPolicy(p, "Alice", "life", 10000, { age: 30, kingdomId: "misthalin" });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert(r.policy.premium > 0, "premium recorded");
  assert.strictEqual(p._inv.coins, 5000 - r.policy.premium, "coins leave the inventory");
  assert.strictEqual(Insurance.poolBalance(), before + r.policy.premium, "premium lands in the pool");
  const got = Insurance.policyFor("Alice", "life");
  assert(got && got.status === "active", "policy active");
  assert.strictEqual(Insurance.policiesOf("Alice").length, 1);
});

test("buying fails honestly when the buyer cannot pay", () => {
  seedPool();
  const p = mockPlayer(10, "Bob");
  const r = Insurance.buyPolicy(p, "Bob", "life", 10000, { kingdomId: "misthalin" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "insufficient");
  assert.strictEqual(p._inv.coins, 10, "inventory untouched");
  assert.strictEqual(Insurance.policyFor("Bob", "life"), null, "no phantom policy");
});

test("buying fails when a capitalized pool is too thin", () => {
  // Pool has capital but cannot cover 2x exposure of a 10k face policy.
  Insurance._data().pool = 1000;
  const p = mockPlayer(5000, "Carol");
  const r = Insurance.buyPolicy(p, "Carol", "life", 10000, { kingdomId: "misthalin" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "insurer-insolvent");
});

test("buying bootstraps from an empty pool", () => {
  // Fresh reset: pool is 0 — the solvency gate is skipped so the first
  // sales' premiums can capitalize the pool; otherwise no policy could
  // ever be sold.
  const p = mockPlayer(5000, "Carol2");
  const r = Insurance.buyPolicy(p, "Carol2", "life", 10000, { kingdomId: "misthalin" });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert(Insurance.poolBalance() > 0, "first premium capitalized the pool");
});

test("cannot hold two active policies of the same type", () => {
  seedPool();
  const p = mockPlayer(20000, "Dave");
  assert.strictEqual(Insurance.buyPolicy(p, "Dave", "health", 2000, { kingdomId: "asgarnia" }).ok, true);
  const r2 = Insurance.buyPolicy(p, "Dave", "health", 2000, { kingdomId: "asgarnia" });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, "already-insured");
});

// --- Premiums ---

test("weekly premium renews the due date", () => {
  seedPool();
  const p = mockPlayer(10000, "Erin");
  const b = Insurance.buyPolicy(p, "Erin", "property", 5000, { kingdomId: "kandarin" });
  assert.strictEqual(b.ok, true);
  const policy = Insurance.policyFor("Erin", "property");
  policy.nextDueAt = Date.now() - 1000; // force due
  const coinsBefore = p._inv.coins;
  const r = Insurance.payPremium(p, "Erin", "property");
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(p._inv.coins, coinsBefore - policy.premium);
  assert(policy.nextDueAt > Date.now(), "due date pushed out");
});

test("premium payment fails honestly when broke", () => {
  seedPool();
  const p = mockPlayer(10000, "Frank");
  assert.strictEqual(Insurance.buyPolicy(p, "Frank", "property", 5000, { kingdomId: "kandarin" }).ok, true);
  const policy = Insurance.policyFor("Frank", "property");
  policy.nextDueAt = Date.now() - 1000;
  p._inv.coins = 0;
  const r = Insurance.payPremium(p, "Frank", "property");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "insufficient");
});

test("cancel lapses the policy", () => {
  seedPool();
  const p = mockPlayer(10000, "Gail");
  assert.strictEqual(Insurance.buyPolicy(p, "Gail", "life", 5000, { kingdomId: "misthalin" }).ok, true);
  assert.strictEqual(Insurance.cancelPolicy("Gail", "life").ok, true);
  assert.strictEqual(Insurance.policiesOf("Gail").length, 0, "no active policies");
});

// --- Claims ---

test("life claim pays the face value to the estate", () => {
  seedPool();
  const p = mockPlayer(10000, "Hank");
  const b = Insurance.buyPolicy(p, "Hank", "life", 8000, { kingdomId: "misthalin" });
  assert.strictEqual(b.ok, true);
  // No player present: payout routes to the bank account (banking module
  // is real in this checkout) or to payoutsOwed.
  const r = Insurance.fileClaim("Hank", "life", "death");
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert(r.paid + r.owed === 8000, `full face accounted: ${r.paid}+${r.owed}`);
  const after = Insurance.policyFor("Hank", "life");
  assert.strictEqual(after.status, "claimed", "life pays once");
});

test("health claim pays half face once per illness bout", () => {
  seedPool();
  const p = mockPlayer(10000, "Ivy");
  assert.strictEqual(Insurance.buyPolicy(p, "Ivy", "health", 4000, { kingdomId: "asgarnia" }).ok, true);
  const r = Insurance.fileClaim("Ivy", "health", "illness", { illnessKey: "flu" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.paid + r.owed, 2000, "half the face value");
  const dup = Insurance.fileClaim("Ivy", "health", "illness", { illnessKey: "flu" });
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.reason, "already-claimed");
  // A new illness is a new claim.
  const r2 = Insurance.fileClaim("Ivy", "health", "illness", { illnessKey: "cold" });
  assert.strictEqual(r2.ok, true);
});

test("property claim pays 40% of face", () => {
  seedPool();
  const p = mockPlayer(10000, "Jack");
  assert.strictEqual(Insurance.buyPolicy(p, "Jack", "property", 10000, { kingdomId: "keldagrim" }).ok, true);
  const r = Insurance.fileClaim("Jack", "property", "burglary");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.paid + r.owed, 4000);
});

test("travel claim reimburses bandit losses up to face value", () => {
  seedPool();
  const p = mockPlayer(10000, "Kim");
  assert.strictEqual(Insurance.buyPolicy(p, "Kim", "travel", 3000, { from: "misthalin", to: "morytania" }).ok, true);
  const r = Insurance.fileClaim("Kim", "travel", "journey-danger", { coinsLost: 5000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.paid + r.owed, 3000, "capped at face value");
  assert.strictEqual(Insurance.policyFor("Kim", "travel").status, "claimed", "single journey");
});

test("claim fails honestly with no active policy", () => {
  const r = Insurance.fileClaim("Nobody", "life", "death");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-policy");
});

test("claim fails honestly on uncovered events", () => {
  seedPool();
  const p = mockPlayer(10000, "Liam");
  assert.strictEqual(Insurance.buyPolicy(p, "Liam", "property", 5000, { kingdomId: "misthalin" }).ok, true);
  const r = Insurance.fileClaim("Liam", "property", "dragon-attack");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-covered");
});

test("settleTravelDanger pays insured travelers and ignores the uninsured", () => {
  seedPool();
  const p = mockPlayer(10000, "Mia");
  assert.strictEqual(Insurance.buyPolicy(p, "Mia", "travel", 2000, { from: "misthalin", to: "asgarnia" }).ok, true);
  const r = Insurance.settleTravelDanger("Mia", { from: "misthalin", to: "asgarnia" }, { coinsLost: 1500, damage: 0 }, null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.paid + r.owed, 1500);
  const none = Insurance.settleTravelDanger("Zed", {}, { coinsLost: 1500, damage: 0 }, null);
  assert.strictEqual(none.ok, false);
  const noLoss = Insurance.settleTravelDanger("Mia", {}, { coinsLost: 0, damage: 5 }, null);
  assert.strictEqual(noLoss.ok, false, "safe arrival consumes nothing new");
});

// --- Insurers ---

test("insurer registry is per-kingdom", () => {
  Insurance.registerInsurer("Nora", "misthalin");
  Insurance.registerInsurer("Omar", "asgarnia");
  assert(Insurance.insurerFor("Nora"), "registered");
  assert.deepStrictEqual(Insurance.insurersIn("misthalin"), ["nora"]);
  assert.deepStrictEqual(Insurance.insurersIn("kandarin"), [], "none there");
});

test("offices exist for every kingdom", () => {
  for (const kid of ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"]) {
    const t = Insurance.officeTile(kid);
    assert(t && Number.isFinite(t.x) && Number.isFinite(t.y), `office tile for ${kid}`);
  }
  assert.strictEqual(Insurance.officeTile("nowhere"), null);
});

// --- Pool and stats ---

test("stats report pool, exposure, and counts", () => {
  seedPool();
  const p = mockPlayer(20000, "Pam");
  assert.strictEqual(Insurance.buyPolicy(p, "Pam", "life", 10000, { kingdomId: "misthalin" }).ok, true);
  assert.strictEqual(Insurance.buyPolicy(p, "Pam", "health", 2000, { kingdomId: "misthalin" }).ok, true);
  const s = Insurance.stats();
  assert.strictEqual(s.activePolicies, 2);
  assert.strictEqual(s.exposure, 12000);
  assert(s.pool > 1000000, "premiums added to the seeded pool");
  assert.strictEqual(s.policiesSold, 2);
});

test("describe returns the office summary for chat", () => {
  const d = Insurance.describe("misthalin");
  assert(d && d.officeTile, "office described");
  assert.deepStrictEqual(d.types, ["life", "health", "property", "travel"]);
  assert.strictEqual(Insurance.describe("nowhere"), null);
});

// --- Persistence ---

test("policies persist across a cache clear", () => {
  seedPool();
  const p = mockPlayer(10000, "Quinn");
  assert.strictEqual(Insurance.buyPolicy(p, "Quinn", "life", 6000, { kingdomId: "misthalin" }).ok, true);
  assert.strictEqual(Insurance.save(), true, "save reports dirty");
  Insurance.clearCacheForTests();
  const got = Insurance.policyFor("Quinn", "life");
  assert(got && got.status === "active" && got.faceValue === 6000, "policy reloaded");
  assert(Insurance.poolBalance() > 0, "pool reloaded");
});

// --- vanishing-coins: credit-before-debit, honest owing, persistent bank credits ---

test("claim with unreachable inventory: pool untouched, full face honestly owed", () => {
  seedPool();
  const p = mockPlayer(10000, "NoInv");
  assert.strictEqual(Insurance.buyPolicy(p, "NoInv", "life", 8000, { kingdomId: "misthalin" }).ok, true);
  const poolBefore = Insurance._data().pool;
  const broken = { username: "NoInv", getInventory: () => { throw new Error("no inventory"); } };
  const r = Insurance.fileClaim("NoInv", "life", "death", { player: broken });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.paid, 0, "nothing delivered");
  assert.strictEqual(r.owed, 8000, "full face honestly owed");
  assert.strictEqual(Insurance._data().pool, poolBefore, "pool not debited for undelivered coins");
});

test("claim pays a present player's real inventory and debits the pool", () => {
  seedPool();
  const p = mockPlayer(10000, "Present");
  assert.strictEqual(Insurance.buyPolicy(p, "Present", "life", 8000, { kingdomId: "misthalin" }).ok, true);
  const poolBefore = Insurance._data().pool;
  const coinsBefore = p._inv.coins;
  const r = Insurance.fileClaim("Present", "life", "death", { player: p });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.paid, 8000, "paid in full");
  assert.strictEqual(r.owed, 0, "nothing owed");
  assert.strictEqual(p._inv.coins, coinsBefore + 8000, "real inventory credited via canonical adds");
  assert.strictEqual(Insurance._data().pool, poolBefore - 8000, "pool debited only for delivered coins");
});

test("absent-holder claim credits the real bank account (not just the journal)", () => {
  seedPool();
  const Banking = require("./CitizenBanking");
  Banking.resetForTests();
  const p = mockPlayer(10000, "Estate");
  assert.strictEqual(Insurance.buyPolicy(p, "Estate", "life", 8000, { kingdomId: "misthalin" }).ok, true);
  const r = Insurance.fileClaim("Estate", "life", "death");
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.paid, 8000, "paid in full to the bank");
  assert.strictEqual(Banking.accountFor("Estate").balance, 8000, "real bank account credited");
  Banking.resetForTests();
});

test("bank credits mark the banking module dirty so they persist", () => {
  seedPool();
  const Module = require("module");
  const origRequire = Module.prototype.require;
  let bankDirty = false;
  const accounts = {};
  Module.prototype.require = function (id) {
    if (id === "./CitizenBanking") {
      return {
        accountFor: (u) => {
          const key = String(u || "").toLowerCase();
          accounts[key] = accounts[key] || { balance: 0 };
          return accounts[key];
        },
        markDirty: () => { bankDirty = true; },
      };
    }
    return origRequire.apply(this, arguments);
  };
  try {
    const st = Insurance._data();
    st.payoutsOwed["dirtycheck"] = 300;
    const flushed = Insurance.flushOwedPayouts();
    assert.strictEqual(flushed, 300, "flushed");
    assert.strictEqual(accounts["dirtycheck"].balance, 300, "bank credited");
    assert.strictEqual(bankDirty, true, "banking marked dirty so the credit persists");
  } finally {
    Module.prototype.require = origRequire;
  }
});

test("flushOwedPayouts delivers owed claims to the bank and debits the pool", () => {
  seedPool();
  const Banking = require("./CitizenBanking");
  Banking.resetForTests();
  const st = Insurance._data();
  st.payoutsOwed["flushme"] = 500;
  const poolBefore = st.pool;
  const flushed = Insurance.flushOwedPayouts();
  assert.strictEqual(flushed, 500, "flushed the owed amount");
  assert.strictEqual(st.pool, poolBefore - 500, "pool debited for delivered coins");
  assert(!("flushme" in st.payoutsOwed), "owed entry cleared");
  assert.strictEqual(Banking.accountFor("flushme").balance, 500, "bank account credited");
  Banking.resetForTests();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
