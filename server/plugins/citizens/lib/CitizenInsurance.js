"use strict";

/**
 * CitizenInsurance — persistent registry of REAL insurance policies,
 * premiums, and claims with real coin movement.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenBanking owns REAL persistent money: accounts, loans, interest.
 *     Insurance moves premiums and payouts through it — never invents coins.
 *   - CitizenHealth owns REAL sickness records (the claim trigger for
 *     health policies).
 *   - CitizenTravel owns REAL journeys and road danger (the claim trigger
 *     for travel policies, via a guarded hook in CitizenTravelLife).
 *   - CitizenFunerals owns REAL death records (the claim trigger for life
 *     policies).
 *   - THIS module owns REAL persistent insurance: insurer registry,
 *     per-type policies (life, health, property, travel), risk-based
 *     premium pricing from real state (age, profession, kingdom danger,
 *     route bandit/monster risk, epidemics, crime), weekly premium
 *     collection from real inventories/bank accounts into a persistent
 *     pool, and claim payouts from the pool to real bank accounts or
 *     inventories. Every coin that moves touches a real inventory, a
 *     real bank account, or the pool. Nothing is invented.
 *
 * Zero LLM. Dirty-flag persistence. Plain-node testable.
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(__dirname, "..", "data", "saves", "citizen-insurance.json");

const COINS_ID = 995;

// === Policy types ===
const POLICY_TYPES = Object.freeze({
  life: Object.freeze({
    label: "life",
    baseBps: 300, // 3% of face value per week
    minFace: 1000,
    maxFace: 100000,
    term: "weekly",
    benefit: "Pays the full face value to the estate when the policyholder dies.",
  }),
  health: Object.freeze({
    label: "health",
    baseBps: 400, // 4% of face value per week
    minFace: 500,
    maxFace: 20000,
    term: "weekly",
    benefit: "Pays half the face value when the policyholder falls ill.",
  }),
  property: Object.freeze({
    label: "property",
    baseBps: 200, // 2% of face value per week
    minFace: 1000,
    maxFace: 50000,
    term: "weekly",
    benefit: "Pays 40% of face value on burglary or property damage.",
  }),
  travel: Object.freeze({
    label: "travel",
    baseBps: 600, // 6% of face value, one journey
    minFace: 500,
    maxFace: 25000,
    term: "journey",
    benefit: "Covers one journey: reimburses coins lost to bandits, up to face value.",
  }),
});

const PREMIUM_TICK_MS = 7 * 24 * 3600 * 1000; // premiums due weekly
const MAX_MISSED = 2; // missed payments before a policy lapses
const POOL_SOLVENCY_MULT = 2; // new policies need pool >= 2x new exposure

// Dangerous professions pay more for life cover.
const DANGEROUS_CAREERS = new Set(["guard", "warrior", "miner", "ranger"]);

// === Insurance offices: one per kingdom, near the market ===
// Prefer the bank branch tile (insurers set up next to banks); fall back
// to a hardcoded market-adjacent tile when banking is unavailable.
const OFFICE_FALLBACK = Object.freeze({
  misthalin: Object.freeze({ x: 3259, y: 3421 }),
  asgarnia: Object.freeze({ x: 2953, y: 3368 }),
  kandarin: Object.freeze({ x: 2661, y: 3283 }),
  keldagrim: Object.freeze({ x: 2843, y: 10208 }),
  morytania: Object.freeze({ x: 3499, y: 3242 }),
});

function norm(name) {
  return String(name ?? "").trim().toLowerCase();
}

// === Lazy cross-module reads (all guarded — a missing module never breaks insurance) ===

function Banking() {
  try {
    return require("./CitizenBanking");
  } catch {
    return null;
  }
}

function officeTile(kingdomId) {
  const kid = String(kingdomId ?? "").toLowerCase();
  try {
    const tile = Banking()?.branchTile?.(kid);
    if (tile) return Object.freeze({ x: tile.x + 6, y: tile.y, z: tile.z ?? 0 });
  } catch { /* fall through */ }
  const fb = OFFICE_FALLBACK[kid];
  return fb ? Object.freeze({ x: fb.x, y: fb.y, z: 0 }) : null;
}

// === State ===

let cache = null;
let dirty = false;

function blankState() {
  return {
    policies: {}, // norm -> { life, health, property, travel } (each a policy record or null)
    pool: 0, // persistent insurer pool: premiums in, claims out
    insurers: {}, // norm -> { kingdomId, appointedAt }
    payoutsOwed: {}, // norm -> coins still owed when the pool ran dry
    lastDeathWatermark: 0,
    totalPremiums: 0,
    totalClaims: 0,
    policiesSold: 0,
  };
}

function blankPolicies() {
  return { life: null, health: null, property: null, travel: null };
}

function data() {
  if (!cache) cache = load();
  return cache;
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return blankState();
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return blankState();
    for (const k of ["policies", "insurers", "payoutsOwed"]) {
      if (!raw[k] || typeof raw !== "object") raw[k] = {};
    }
    // Normalize per-holder slots.
    for (const key of Object.keys(raw.policies)) {
      if (!raw.policies[key] || typeof raw.policies[key] !== "object") {
        raw.policies[key] = blankPolicies();
        continue;
      }
      for (const t of Object.keys(POLICY_TYPES)) {
        if (!(raw.policies[key][t] && typeof raw.policies[key][t] === "object")) {
          raw.policies[key][t] = null;
        }
      }
    }
    for (const k of ["pool", "lastDeathWatermark", "totalPremiums", "totalClaims", "policiesSold"]) {
      if (typeof raw[k] !== "number") raw[k] = 0;
    }
    return raw;
  } catch {
    return blankState();
  }
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(data(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  cache = null;
  dirty = false;
  try {
    if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE);
  } catch { /* ignore */ }
}

/** Mark the store dirty when the tick mutates policy objects directly. */
function markDirty() {
  dirty = true;
}

// Clear only the in-memory cache, keeping the save file (for persistence tests).
function clearCacheForTests() {
  cache = null;
  dirty = false;
}

// === Coin helpers (real inventories, never invented) ===

function coinsOf(player) {
  try {
    return player?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0;
  } catch {
    return 0;
  }
}

function takeCoins(player, amount) {
  // Canonical: deleteNumber(id, amount) with balance verification.
  // ItemContainer has no inv.remove(id, amount) — the old call was a
  // silent no-op on the real engine (a stale mock's remove(id, n) shape
  // masked it), so premium payments could never actually debit anyone.
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(COINS_ID, amount);
    return (inv.getAmount?.(COINS_ID) ?? 0) === before - amount;
  } catch {
    return false;
  }
}

function giveCoins(player, amount) {
  // Canonical: adds(id, amount) with balance verification. inv.add takes an
  // Item instance, not (id, amount) — the old call threw on the real engine
  // and a stale mock's add(id, n) shape masked it, so player-present claim
  // payouts never credited anyone.
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    inv.adds?.(COINS_ID, amount);
    return (inv.getAmount?.(COINS_ID) ?? 0) === before + amount;
  } catch {
    return false;
  }
}

/**
 * Credit a payout to a real bank account (the persistent, honest home for
 * claim money when the holder is not holding an inventory right now).
 * Returns the coins actually credited; 0 when banking is unavailable — the
 * caller owes honestly in payoutsOwed, so this never double-books.
 * NOTE: CitizenBanking only persists when its dirty flag is set, so the
 * markDirty() call is load-bearing: without it the credit silently
 * vanishes on the next save cycle (the vanishing-coins class).
 */
function creditBank(username, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return 0;
  try {
    const B = Banking();
    if (!B || typeof B.accountFor !== "function") return 0;
    const acct = B.accountFor(username);
    if (!acct) return 0;
    acct.balance = (Number(acct.balance) || 0) + amount;
    if (typeof B.markDirty === "function") B.markDirty();
    return amount;
  } catch {
    return 0;
  }
}

// === Risk assessment ===
// Pricing from REAL state: age, profession, kingdom danger, route risk,
// epidemics, crime. Returns { multiplier, factors } — deterministic and testable.

function assessRisk(username, type, opts = {}) {
  const factors = [];
  let mult = 1.0;
  const t = String(type ?? "").toLowerCase();

  const age = Number(opts.age);
  const career = String(opts.career ?? "").toLowerCase();
  const kingdomId = String(opts.kingdomId ?? "").toLowerCase();

  if (t === "life" || t === "health") {
    if (Number.isFinite(age)) {
      if (age >= 60) {
        mult *= t === "health" ? 1.8 : 1.6;
        factors.push("elder");
      } else if (age <= 15) {
        mult *= t === "health" ? 1.6 : 0.8;
        factors.push("child");
      }
    }
    if (t === "life" && DANGEROUS_CAREERS.has(career)) {
      mult *= 1.4;
      factors.push("dangerous trade");
    }
    if (t === "health" && opts.currentlySick) {
      mult *= 1.5;
      factors.push("pre-existing illness");
    }
    if (t === "health" && kingdomId) {
      try {
        const Health = require("./CitizenHealth");
        const sick = Health.sickOfKingdom?.(kingdomId) ?? [];
        // Any active epidemic makes health cover pricier.
        for (const rec of sick) {
          if (Health.isEpidemic?.(kingdomId, rec?.illness)) {
            mult *= 2.5;
            factors.push("epidemic");
            break;
          }
        }
      } catch { /* health optional */ }
    }
  }

  if (t === "property" && kingdomId) {
    try {
      const Travel = require("./CitizenTravel");
      if (Travel.warringKingdoms?.().includes(kingdomId)) {
        mult *= 2.0;
        factors.push("kingdom at war");
      }
    } catch { /* travel optional */ }
    try {
      const Crime = require("./CitizenCrime");
      const inmates = Crime.inmatesOfKingdom?.(kingdomId) ?? [];
      if (inmates.length > 0) {
        const crimeMult = 1 + Math.min(1.0, inmates.length * 0.1);
        mult *= crimeMult;
        factors.push("high crime");
      }
    } catch { /* crime optional */ }
    if (kingdomId === "morytania") {
      mult *= 1.3;
      factors.push("dark lands");
    }
  }

  if (t === "life" && kingdomId) {
    try {
      const Travel = require("./CitizenTravel");
      if (Travel.warringKingdoms?.().includes(kingdomId)) {
        mult *= 1.5;
        factors.push("kingdom at war");
      }
    } catch { /* travel optional */ }
  }

  if (t === "travel") {
    const from = String(opts.from ?? "").toLowerCase();
    const to = String(opts.to ?? "").toLowerCase();
    if (from && to) {
      try {
        const Travel = require("./CitizenTravel");
        const route = Travel.routeBetween?.(from, to);
        const bandit = Number(route?.banditRisk ?? 0.15);
        const monster = Number(route?.monsterRisk ?? 0.1);
        const routeMult = 1 + (bandit + monster) * 2;
        mult *= routeMult;
        if (bandit >= 0.25) factors.push("bandit road");
        if (monster >= 0.2) factors.push("monster wilds");
        if (!Travel.routeOpen?.(from, to)) {
          mult *= 3;
          factors.push("closed route");
        }
      } catch { /* travel optional */ }
    }
    if (Number(opts.cargoValue) > 0) {
      mult *= 1.2;
      factors.push("insured cargo");
    }
  }

  // Clamp: insurance stays affordable, and never free.
  mult = Math.min(4.0, Math.max(0.5, mult));
  return { multiplier: Math.round(mult * 100) / 100, factors };
}

// === Quotes and policies ===

function policyTypeOf(type) {
  return POLICY_TYPES[String(type ?? "").toLowerCase()] ?? null;
}

function quote(username, type, faceValue, opts = {}) {
  const def = policyTypeOf(type);
  if (!def) return { ok: false, reason: "unknown-type" };
  faceValue = Math.floor(Number(faceValue) || 0);
  if (faceValue < def.minFace || faceValue > def.maxFace) {
    return { ok: false, reason: "amount", minFace: def.minFace, maxFace: def.maxFace };
  }
  const risk = assessRisk(username, def.label, opts);
  const premium = Math.max(1, Math.ceil((faceValue * def.baseBps * risk.multiplier) / 10000));
  return { ok: true, type: def.label, faceValue, premium, risk: risk.multiplier, factors: risk.factors, term: def.term };
}

function slotFor(username) {
  const key = norm(username);
  const st = data();
  if (!st.policies[key]) {
    st.policies[key] = blankPolicies();
    dirty = true;
  }
  return st.policies[key];
}

function policyFor(username, type) {
  const def = policyTypeOf(type);
  if (!def) return null;
  const slot = data().policies[norm(username)];
  return slot ? slot[def.label] ?? null : null;
}

function policiesOf(username) {
  const slot = data().policies[norm(username)];
  const out = [];
  if (!slot) return out;
  for (const t of Object.keys(POLICY_TYPES)) {
    if (slot[t] && slot[t].status === "active") out.push(slot[t]);
  }
  return out;
}

/**
 * Sell a policy: the first premium leaves the buyer's REAL inventory and
 * lands in the insurer pool. Honest: fails when they cannot pay.
 */
function buyPolicy(player, username, type, faceValue, opts = {}) {
  const q = quote(username, type, faceValue, opts);
  if (!q.ok) return q;
  const key = norm(username);
  const slot = slotFor(username);
  if (slot[q.type] && slot[q.type].status === "active") {
    return { ok: false, reason: "already-insured" };
  }
  // Solvency: once the pool is capitalized, it must cover twice the new
  // exposure. From an empty pool the gate is skipped — the first sales'
  // premiums are what capitalize the pool (bootstrap); without this the
  // pool could never become non-zero and no policy could ever be sold.
  const st = data();
  if (st.pool > 0 && st.pool + q.premium < q.faceValue * POOL_SOLVENCY_MULT) {
    return { ok: false, reason: "insurer-insolvent" };
  }
  if (!player || coinsOf(player) < q.premium) {
    return { ok: false, reason: "insufficient", premium: q.premium };
  }
  if (!takeCoins(player, q.premium)) return { ok: false, reason: "take-failed" };
  st.pool += q.premium;
  st.totalPremiums += q.premium;
  const nowMs = Date.now();
  const policy = {
    type: q.type,
    faceValue: q.faceValue,
    premium: q.premium,
    risk: q.risk,
    factors: q.factors,
    kingdomId: String(opts.kingdomId ?? "").toLowerCase() || null,
    startedAt: nowMs,
    nextDueAt: q.term === "weekly" ? nowMs + PREMIUM_TICK_MS : null,
    missed: 0,
    status: "active",
    claimedFor: null,
    journey: q.type === "travel" && opts.from && opts.to
      ? { from: String(opts.from).toLowerCase(), to: String(opts.to).toLowerCase() }
      : null,
    isPlayer: !!opts.isPlayer,
  };
  slot[q.type] = policy;
  st.policiesSold += 1;
  dirty = true;
  return { ok: true, policy };
}

/**
 * Pay a weekly premium: real coins from inventory first, then from the
 * holder's bank account (withdrawn to inventory, then taken — all real).
 */
function payPremium(player, username, type) {
  const def = policyTypeOf(type);
  if (!def) return { ok: false, reason: "unknown-type" };
  if (def.term !== "weekly") return { ok: false, reason: "not-weekly" };
  const policy = policyFor(username, def.label);
  if (!policy || policy.status !== "active") return { ok: false, reason: "no-policy" };
  const nowMs = Date.now();
  if (policy.nextDueAt && nowMs < policy.nextDueAt) return { ok: false, reason: "not-due" };
  const premium = policy.premium;
  // Inventory first.
  if (player && takeCoins(player, premium)) {
    return settlePremiumPaid(username, policy, premium, nowMs);
  }
  // Then the bank account: withdraw to inventory, then take.
  try {
    const B = Banking();
    if (player && B && B.balanceOf(username) >= premium) {
      const w = B.withdraw(player, username, premium);
      if (w.ok && takeCoins(player, premium)) {
        return settlePremiumPaid(username, policy, premium, nowMs);
      }
      // Roll the withdrawal back on failure — never lose coins.
      if (w.ok) B.deposit(player, username, premium);
    }
  } catch { /* banking optional */ }
  return { ok: false, reason: "insufficient", premium };
}

function settlePremiumPaid(username, policy, premium, nowMs) {
  const st = data();
  st.pool += premium;
  st.totalPremiums += premium;
  policy.nextDueAt = nowMs + PREMIUM_TICK_MS;
  policy.missed = 0;
  dirty = true;
  return { ok: true, paid: premium, nextDueAt: policy.nextDueAt };
}

function cancelPolicy(username, type) {
  const def = policyTypeOf(type);
  if (!def) return { ok: false, reason: "unknown-type" };
  const policy = policyFor(username, def.label);
  if (!policy || policy.status !== "active") return { ok: false, reason: "no-policy" };
  policy.status = "lapsed";
  dirty = true;
  return { ok: true };
}

// === Claims ===
// Payout routing: real inventory when the holder is present, else the real
// bank account, else payoutsOwed until the pool recovers.

function routePayout(username, amount, player) {
  amount = Math.floor(amount);
  if (amount <= 0) return { paid: 0, owed: 0 };
  const st = data();
  // Deliver FIRST, debit the pool only for coins that actually moved.
  // Debiting first (the old shape) is the vanishing-coins bug: the pool
  // shrinks while failed giveCoins / unreachable banking deliver nothing,
  // and totalClaims counted coins that were never paid.
  const payable = Math.min(amount, st.pool);
  let paid = 0;
  if (payable > 0) {
    let delivered = 0;
    if (player) {
      delivered = giveCoins(player, payable) ? payable : 0;
    } else {
      delivered = creditBank(username, payable);
    }
    if (delivered > 0) {
      st.pool -= delivered;
      st.totalClaims += delivered;
      paid = delivered;
    }
  }
  // Whatever wasn't delivered is honestly owed — never invented, never lost.
  const owed = amount - paid;
  if (owed > 0) {
    const key = norm(username);
    st.payoutsOwed[key] = (st.payoutsOwed[key] ?? 0) + owed;
  }
  dirty = true;
  return { paid, owed };
}

/**
 * File a claim against an active policy. kind is the insurable event:
 *   life:     "death"
 *   health:   "illness" (opts.illnessKey — one payout per bout)
 *   property: "burglary"
 *   travel:   "journey-danger" (opts.coinsLost — reimburse up to face value)
 * Returns { ok, paid, owed } or { ok: false, reason }.
 */
function fileClaim(username, type, kind, opts = {}) {
  const def = policyTypeOf(type);
  if (!def) return { ok: false, reason: "unknown-type" };
  const policy = policyFor(username, def.label);
  if (!policy || policy.status !== "active") return { ok: false, reason: "no-policy" };
  const player = opts.player ?? null;
  let amount = 0;

  if (def.label === "life" && kind === "death") {
    amount = policy.faceValue;
    policy.status = "claimed"; // a life policy pays once
  } else if (def.label === "health" && kind === "illness") {
    const illnessKey = String(opts.illnessKey ?? "").toLowerCase();
    if (!illnessKey) return { ok: false, reason: "no-evidence" };
    if (policy.claimedFor === illnessKey) return { ok: false, reason: "already-claimed" };
    amount = Math.floor(policy.faceValue / 2);
    policy.claimedFor = illnessKey;
  } else if (def.label === "property" && kind === "burglary") {
    amount = Math.floor((policy.faceValue * 40) / 100);
  } else if (def.label === "travel" && kind === "journey-danger") {
    const coinsLost = Math.floor(Number(opts.coinsLost) || 0);
    if (coinsLost <= 0) return { ok: false, reason: "no-loss" };
    amount = Math.min(policy.faceValue, coinsLost);
    policy.status = "claimed"; // a travel policy covers one journey
  } else {
    return { ok: false, reason: "not-covered" };
  }

  if (amount <= 0) return { ok: false, reason: "no-loss" };
  const routed = routePayout(username, amount, player);
  dirty = true;
  return { ok: true, paid: routed.paid, owed: routed.owed, amount };
}

/**
 * Travel-danger hook called by CitizenTravelLife after road danger is
 * applied: reimburse insured travelers for bandit losses.
 */
function settleTravelDanger(username, journey, danger, player) {
  try {
    const policy = policyFor(username, "travel");
    if (!policy || policy.status !== "active") return { ok: false, reason: "no-policy" };
    const coinsLost = Math.floor(Number(danger?.coinsLost) || 0);
    if (coinsLost <= 0) return { ok: false, reason: "no-loss" };
    return fileClaim(username, "travel", "journey-danger", { coinsLost, player });
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Pay down payoutsOwed while the pool allows. Returns coins flushed. */
function flushOwedPayouts() {
  const st = data();
  let flushed = 0;
  let changed = false;
  for (const key of Object.keys(st.payoutsOwed)) {
    const owed = st.payoutsOwed[key];
    if (!owed || owed <= 0) { delete st.payoutsOwed[key]; changed = true; continue; }
    const payable = Math.min(owed, st.pool);
    if (payable <= 0) continue;
    // Deliver first: the old deduct-then-credit drained the pool on every
    // retry even when banking was missing and nothing moved (the
    // vanishing-coins class — totalClaims grew while coins went nowhere).
    const credited = creditBank(key, payable);
    if (credited > 0) {
      st.pool -= credited;
      st.totalClaims += credited;
      flushed += credited;
      const stillOwed = owed - credited;
      if (stillOwed <= 0) delete st.payoutsOwed[key];
      else st.payoutsOwed[key] = stillOwed;
      changed = true;
    }
    // else: banking unavailable — leave the pool AND the owed ledger
    // untouched so the next tick retries honestly.
  }
  if (changed) dirty = true;
  return flushed;
}

// === Insurers ===

/**
 * Reduce payoutsOwed for a claimant by `amount` — used when the underwriters'
 * guild pays the owed claim from its own reinsurance fund, so the pool never
 * double-pays when it recovers. Returns the coins actually covered (never
 * more than was owed). Additive seam for the guild layer; the pool, claims,
 * and policy logic are untouched.
 */
function coverOwedPayout(username, amount) {
  const st = data();
  const key = norm(username);
  const owed = st.payoutsOwed[key];
  if (!owed || owed <= 0) return 0;
  const covered = Math.min(owed, Math.max(0, Math.floor(Number(amount) || 0)));
  if (covered <= 0) return 0;
  const rest = owed - covered;
  if (rest <= 0) delete st.payoutsOwed[key];
  else st.payoutsOwed[key] = rest;
  st.totalClaims += covered;
  dirty = true;
  return covered;
}

function setDeathWatermark(ts) {
  const st = data();
  const t = Math.floor(Number(ts) || 0);
  if (t > st.lastDeathWatermark) {
    st.lastDeathWatermark = t;
    dirty = true;
  }
  return st.lastDeathWatermark;
}

function registerInsurer(username, kingdomId) {
  const key = norm(username);
  data().insurers[key] = { kingdomId: String(kingdomId ?? "").toLowerCase(), appointedAt: Date.now() };
  dirty = true;
}

function insurerFor(username) {
  return data().insurers[norm(username)] ?? null;
}

function insurersIn(kingdomId) {
  const kid = String(kingdomId ?? "").toLowerCase();
  return Object.keys(data().insurers).filter((k) => data().insurers[k].kingdomId === kid);
}

// === Economy ===

function poolBalance() {
  return data().pool;
}

function totalExposure() {
  let total = 0;
  for (const key of Object.keys(data().policies)) {
    const slot = data().policies[key];
    for (const t of Object.keys(POLICY_TYPES)) {
      const p = slot[t];
      if (p && p.status === "active") total += p.faceValue;
    }
  }
  return total;
}

function stats() {
  const st = data();
  let active = 0;
  for (const key of Object.keys(st.policies)) {
    const slot = st.policies[key];
    for (const t of Object.keys(POLICY_TYPES)) {
      if (slot[t] && slot[t].status === "active") active++;
    }
  }
  return {
    pool: st.pool,
    activePolicies: active,
    exposure: totalExposure(),
    totalPremiums: st.totalPremiums,
    totalClaims: st.totalClaims,
    policiesSold: st.policiesSold,
    insurers: Object.keys(st.insurers).length,
    payoutsOwed: Object.keys(st.payoutsOwed).length,
  };
}

// === Description for chat ===

function describe(kingdomId) {
  const kid = String(kingdomId ?? "").toLowerCase();
  const tile = officeTile(kid);
  if (!tile) return null;
  return {
    kingdomId: kid,
    officeTile: tile,
    insurerCount: insurersIn(kid).length,
    pool: poolBalance(),
    activePolicies: stats().activePolicies,
    types: Object.keys(POLICY_TYPES),
  };
}

module.exports = {
  SAVE_FILE,
  COINS_ID,
  POLICY_TYPES,
  PREMIUM_TICK_MS,
  MAX_MISSED,
  officeTile,
  assessRisk,
  quote,
  buyPolicy,
  payPremium,
  cancelPolicy,
  policyFor,
  policiesOf,
  fileClaim,
  settleTravelDanger,
  flushOwedPayouts,
  coverOwedPayout,
  setDeathWatermark,
  registerInsurer,
  insurerFor,
  insurersIn,
  poolBalance,
  totalExposure,
  stats,
  describe,
  save,
  resetForTests,
  clearCacheForTests,
  markDirty,
  _data: data,
};
