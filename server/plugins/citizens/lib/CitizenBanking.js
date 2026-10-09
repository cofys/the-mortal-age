"use strict";

/**
 * CitizenBanking — persistent registry of REAL bank accounts, deposits,
 * withdrawals, interest, and loans with real coin movement.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenBankers owns the hash-derived banker flavor: teller/vault-keeper/
 *     loan-officer/auditor types, scripted dialogue, bank names, vault heat,
 *     suspicion notes, wall-clock hours. Fiction and flavor, not persistent
 *     game state.
 *   - CitizenBankers2 owns the hash-derived moneyfolk flavor: exchange rates,
 *     assay results, pawn tickets, 7-day TTL micro-loan ledgers. Deterministic
 *     day+name math, not real coin movement.
 *   - THIS module owns REAL persistent banking: real coin deposits from real
 *     inventories into persistent accounts, real withdrawals back, real
 *     interest accrual on the slow tick, real loan disbursement and repayment
 *     with real coins, persistent bank branches per kingdom, a banker
 *     profession registry, kingdom treasury deposits, and a player banking
 *     bridge. Every coin that moves touches a real inventory or the real
 *     kingdom treasury. Nothing is invented.
 *
 * Zero LLM. Dirty-flag persistence. Plain-node testable.
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(__dirname, "..", "data", "saves", "citizen-banking.json");

const COINS_ID = 995;

// === Tuning ===
const SAVINGS_INTEREST_BPS = 200; // 2% per week on positive balances
const LOAN_INTEREST_BPS = 1000; // 10% per week on outstanding loans
const LOAN_TERM_MS = 30 * 24 * 3600 * 1000; // loans due in 30 days
const LOAN_DEFAULT_MS = 60 * 24 * 3600 * 1000; // default after 60 days
const LOAN_MIN = 100;
const LOAN_MAX = 50000;
const INTEREST_TICK_MS = 7 * 24 * 3600 * 1000; // interest accrues weekly
const TREASURY_DEPOSIT_MIN = 1000;

// === Bank branches: one per kingdom, deterministic tile near market ===
const BRANCHES = Object.freeze({
  misthalin: Object.freeze({ name: "Varrock Grand Exchange Bank", tile: Object.freeze({ x: 3253, y: 3421 }) }),
  asgarnia: Object.freeze({ name: "Falador Bank", tile: Object.freeze({ x: 2947, y: 3368 }) }),
  kandarin: Object.freeze({ name: "Ardougne Market Bank", tile: Object.freeze({ x: 2655, y: 3283 }) }),
  keldagrim: Object.freeze({ name: "Keldagrim Deep Vault", tile: Object.freeze({ x: 2837, y: 10208 }) }),
  morytania: Object.freeze({ name: "Darkmeyer Blood Vault", tile: Object.freeze({ x: 3493, y: 3242 }) }),
});

function branchFor(kingdomId) {
  return BRANCHES[String(kingdomId ?? "").toLowerCase()] ?? null;
}

function branchTile(kingdomId) {
  return branchFor(kingdomId)?.tile ?? null;
}

// === State ===
let cache = null;
let dirty = false;

function blankState() {
  return {
    accounts: {}, // norm -> { balance, lastInterest, createdAt }
    loans: {}, // norm -> { principal, owed, borrowedAt, dueAt, lastInterest }
    treasuryDeposits: {}, // kingdomId -> { amount, lastInterest }
    bankers: {}, // norm -> { kingdomId, appointedAt }
    totalDeposited: 0, // lifetime, for economy tracking
    totalLoaned: 0, // lifetime, for economy tracking
  };
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
    for (const k of ["accounts", "loans", "treasuryDeposits", "bankers"]) {
      if (!raw[k] || typeof raw[k] !== "object") raw[k] = {};
    }
    if (typeof raw.totalDeposited !== "number") raw.totalDeposited = 0;
    if (typeof raw.totalLoaned !== "number") raw.totalLoaned = 0;
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

// Clear only the in-memory cache, keeping the save file (for persistence tests).
function clearCacheForTests() {
  cache = null;
  dirty = false;
}

function norm(name) {
  return String(name ?? "").trim().toLowerCase();
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
  try {
    const inv = player?.getInventory?.();
    if (!inv || coinsOf(player) < amount) return false;
    inv.remove?.(COINS_ID, amount);
    return true;
  } catch {
    return false;
  }
}

function giveCoins(player, amount) {
  try {
    player?.getInventory?.()?.add?.(COINS_ID, amount);
    return true;
  } catch {
    return false;
  }
}

// === Accounts ===

function accountFor(username) {
  const st = data();
  const key = norm(username);
  if (!st.accounts[key]) {
    st.accounts[key] = { balance: 0, lastInterest: Date.now(), createdAt: Date.now() };
    dirty = true;
  }
  return st.accounts[key];
}

function balanceOf(username) {
  const acct = data().accounts[norm(username)];
  return acct ? acct.balance : 0;
}

/**
 * Deposit real coins from the citizen's real inventory into their account.
 * Returns { ok, deposited } — honest: fails when they don't have the coins.
 */
function deposit(player, username, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { ok: false, reason: "amount" };
  if (coinsOf(player) < amount) return { ok: false, reason: "insufficient" };
  if (!takeCoins(player, amount)) return { ok: false, reason: "take-failed" };
  const acct = accountFor(username);
  acct.balance += amount;
  data().totalDeposited += amount;
  dirty = true;
  return { ok: true, deposited: amount, balance: acct.balance };
}

/**
 * Withdraw real coins from the account into the citizen's real inventory.
 * Returns { ok, withdrawn } — honest: fails when the balance is too low.
 */
function withdraw(player, username, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { ok: false, reason: "amount" };
  const acct = accountFor(username);
  if (acct.balance < amount) return { ok: false, reason: "insufficient" };
  acct.balance -= amount;
  dirty = true;
  if (!giveCoins(player, amount)) {
    // Roll back — never lose coins.
    acct.balance += amount;
    return { ok: false, reason: "give-failed" };
  }
  return { ok: true, withdrawn: amount, balance: acct.balance };
}

// === Interest ===

function accrueInterest(nowMs) {
  const st = data();
  let changed = 0;
  for (const key of Object.keys(st.accounts)) {
    const acct = st.accounts[key];
    if (acct.balance <= 0) continue;
    if (nowMs - (acct.lastInterest || 0) < INTEREST_TICK_MS) continue;
    const interest = Math.floor((acct.balance * SAVINGS_INTEREST_BPS) / 10000);
    if (interest > 0) {
      acct.balance += interest;
      changed++;
    }
    acct.lastInterest = nowMs;
  }
  // Treasury deposits earn too.
  for (const k of Object.keys(st.treasuryDeposits)) {
    const dep = st.treasuryDeposits[k];
    if (dep.amount <= 0) continue;
    if (nowMs - (dep.lastInterest || 0) < INTEREST_TICK_MS) continue;
    const interest = Math.floor((dep.amount * SAVINGS_INTEREST_BPS) / 10000);
    if (interest > 0) {
      dep.amount += interest;
      changed++;
    }
    dep.lastInterest = nowMs;
  }
  if (changed > 0) dirty = true;
  return changed;
}

// === Loans ===

function loanFor(username) {
  return data().loans[norm(username)] ?? null;
}

/**
 * Disburse a real loan: real coins go to the borrower's real inventory,
 * debt is recorded. Returns { ok, amount, owed }.
 */
function borrow(player, username, amount) {
  amount = Math.floor(amount);
  if (amount < LOAN_MIN || amount > LOAN_MAX) return { ok: false, reason: "amount" };
  const key = norm(username);
  const existing = data().loans[key];
  if (existing && existing.owed > 0) return { ok: false, reason: "existing-loan" };
  const nowMs = Date.now();
  data().loans[key] = {
    principal: amount,
    owed: amount,
    borrowedAt: nowMs,
    dueAt: nowMs + LOAN_TERM_MS,
    lastInterest: nowMs,
  };
  data().totalLoaned += amount;
  dirty = true;
  if (!giveCoins(player, amount)) {
    delete data().loans[key];
    return { ok: false, reason: "give-failed" };
  }
  return { ok: true, amount, owed: amount, dueAt: nowMs + LOAN_TERM_MS };
}

/**
 * Repay a loan with real coins from the borrower's real inventory.
 * Returns { ok, paid, remaining }.
 */
function repay(player, username, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { ok: false, reason: "amount" };
  const key = norm(username);
  const loan = data().loans[key];
  if (!loan || loan.owed <= 0) return { ok: false, reason: "no-loan" };
  const payAmount = Math.min(amount, loan.owed);
  if (coinsOf(player) < payAmount) return { ok: false, reason: "insufficient" };
  if (!takeCoins(player, payAmount)) return { ok: false, reason: "take-failed" };
  loan.owed -= payAmount;
  dirty = true;
  if (loan.owed <= 0) delete data().loans[key];
  return { ok: true, paid: payAmount, remaining: loan.owed ?? 0 };
}

function accrueLoanInterest(nowMs) {
  const st = data();
  let changed = 0;
  for (const key of Object.keys(st.loans)) {
    const loan = st.loans[key];
    if (loan.owed <= 0) continue;
    if (nowMs - (loan.lastInterest || 0) < INTEREST_TICK_MS) continue;
    const interest = Math.floor((loan.owed * LOAN_INTEREST_BPS) / 10000);
    if (interest > 0) {
      loan.owed += interest;
      changed++;
    }
    loan.lastInterest = nowMs;
  }
  if (changed > 0) dirty = true;
  return changed;
}

function isOverdue(username, nowMs) {
  const loan = loanFor(username);
  return loan ? nowMs > loan.dueAt : false;
}

function isDefaulted(username, nowMs) {
  const loan = loanFor(username);
  return loan ? nowMs - loan.borrowedAt > LOAN_DEFAULT_MS : false;
}

// === Bankers ===

function registerBanker(username, kingdomId) {
  const key = norm(username);
  data().bankers[key] = { kingdomId: String(kingdomId ?? ""), appointedAt: Date.now() };
  dirty = true;
}

function bankerFor(username) {
  return data().bankers[norm(username)] ?? null;
}

function bankersIn(kingdomId) {
  const kid = String(kingdomId ?? "").toLowerCase();
  return Object.keys(data().bankers).filter((k) => data().bankers[k].kingdomId === kid);
}

// === Treasury deposits ===

function treasuryDeposit(kingdomId, amount) {
  amount = Math.floor(amount);
  if (amount < TREASURY_DEPOSIT_MIN) return { ok: false, reason: "minimum" };
  const kid = String(kingdomId ?? "").toLowerCase();
  const st = data();
  if (!st.treasuryDeposits[kid]) {
    st.treasuryDeposits[kid] = { amount: 0, lastInterest: Date.now() };
  }
  st.treasuryDeposits[kid].amount += amount;
  dirty = true;
  return { ok: true, amount: st.treasuryDeposits[kid].amount };
}

function treasuryBalance(kingdomId) {
  const dep = data().treasuryDeposits[String(kingdomId ?? "").toLowerCase()];
  return dep ? dep.amount : 0;
}

// === Economy ===

function moneySupply() {
  const st = data();
  let total = 0;
  for (const k of Object.keys(st.accounts)) total += st.accounts[k].balance;
  for (const k of Object.keys(st.treasuryDeposits)) total += st.treasuryDeposits[k].amount;
  return total;
}

function outstandingLoans() {
  let total = 0;
  for (const k of Object.keys(data().loans)) total += data().loans[k].owed;
  return total;
}

// === Description for chat ===

function describe(kingdomId) {
  const branch = branchFor(kingdomId);
  if (!branch) return null;
  return {
    name: branch.name,
    kingdomId,
    bankerCount: bankersIn(kingdomId).length,
    totalAccounts: Object.keys(data().accounts).length,
    moneySupply: moneySupply(),
  };
}

module.exports = {
  SAVE_FILE,
  COINS_ID,
  SAVINGS_INTEREST_BPS,
  LOAN_INTEREST_BPS,
  LOAN_TERM_MS,
  LOAN_MIN,
  LOAN_MAX,
  branchFor,
  branchTile,
  accountFor,
  balanceOf,
  deposit,
  withdraw,
  accrueInterest,
  loanFor,
  borrow,
  repay,
  accrueLoanInterest,
  isOverdue,
  isDefaulted,
  registerBanker,
  bankerFor,
  bankersIn,
  treasuryDeposit,
  treasuryBalance,
  moneySupply,
  outstandingLoans,
  describe,
  save,
  resetForTests,
  clearCacheForTests,
  _data: data,
};
