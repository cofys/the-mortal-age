"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenBankers — bank citizens who run the banks, manage money, and guard
 * the vaults.
 *
 * WHAT IT DOES (data tier, free):
 *   Every banker citizen gets a hash-stable banker type (teller, vault-keeper,
 *   loan-officer, auditor) and a hash-stable bank, preferring the citizen's
 *   kingdom. Banks keep wall-clock hours (08:00-20:00); the vault seals at
 *   night. Loans are a real ledger: principal + 10% interest, due in 7 days,
 *   with scripted collection reminders. Each bank carries a security "heat"
 *   level that decays over a week — a robbery (see the bank-robbery design)
 *   raises it, and vault-keepers react to the heat. Suspicion notes from
 *   casing attempts are recorded so the interaction tier can riff on them.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Tellers greet customers at the counter and serve scripted deposits and
 *   withdrawals ("Depositing, {name}?"). Vault-keepers challenge loiterers
 *   near the vault ("The vault is for customers only."), announce the vault
 *   sealing and opening, and tighten up when heat is high. Loan officers offer
 *   loans to lingering players and collect from debtors. Auditors announce
 *   their daily audit and mutter about the books when a figure doesn't add
 *   up. All lines scripted; zero LLM.
 *
 * Zero LLM: every line is scripted from pools; the LLM mouth only reads the
 * journal and the exported ledger/heat/suspicion APIs ("owes the bank 550
 * coins, due in three days"). Lending and robbery dialogue itself is LLM
 * tier — this module only tracks state and plays the visible bank scene.
 *
 * Wired into the director tick in tickProximity(), right after the guards
 * block. Plain-node testable: CitizenBankers.test.js.
 */

// === Tuning: all magic numbers here ===
const BANKER_RADIUS = 14; // tiles — a real player must be near to see/hear
const BANKER_COOLDOWN_MS = 20 * 60 * 1000; // per banker per flavor action
const TELLER_SERVICE_COOLDOWN_MS = 10 * 60 * 1000;
const VAULT_COOLDOWN_MS = 30 * 60 * 1000;
const LOAN_COOLDOWN_MS = 30 * 60 * 1000;
const AUDIT_COOLDOWN_MS = 60 * 60 * 1000;

const BANK_OPEN_HOUR = 8; // banks open 08:00-20:00 wall clock
const BANK_CLOSE_HOUR = 20;

const LOAN_INTEREST_BPS = 1000; // 10% interest on loans (basis points)
const LOAN_TERM_MS = 7 * 24 * 3600 * 1000; // loans due in 7 days
const LOAN_MAX = 50000; // biggest loan a citizen bank will float
const LOAN_MIN = 100;

const HEAT_TTL_MS = 7 * 24 * 3600 * 1000; // robbery heat decays over a week
const HEAT_STEP = 25; // each robbery adds 25 heat (100 = maximum alert)
const HEAT_MAX = 100;

const SUSPICION_TTL_MS = 6 * 3600 * 1000; // casing suspicion lasts 6 hours

// === Banks (names players recognise; kingdoms for derived assignment;
// tiers follow the bank-robbery design: village / city / capital vault) ===
const BANKS = Object.freeze([
  { name: "the Varrock west bank", short: "varrock-west", kingdom: "misthalin", tier: "city" },
  { name: "the Varrock east bank", short: "varrock-east", kingdom: "misthalin", tier: "city" },
  { name: "the Lumbridge bank", short: "lumbridge", kingdom: "misthalin", tier: "village" },
  { name: "the Draynor bank", short: "draynor", kingdom: "misthalin", tier: "village" },
  { name: "the Falador bank", short: "falador", kingdom: "asgarnia", tier: "city" },
  { name: "the Port Sarim bank", short: "portsarim", kingdom: "asgarnia", tier: "village" },
  { name: "the Al Kharid bank", short: "alkharid", kingdom: "asgarnia", tier: "city" },
  { name: "the Ardougne market bank", short: "ardougne", kingdom: "kandarin", tier: "city" },
  { name: "the Keldagrim deep vault", short: "keldagrim", kingdom: "keldagrim", tier: "capital" },
  { name: "the Darkmeyer blood vault", short: "darkmeyer", kingdom: "morytania", tier: "capital" },
]);

// === Banker types: teller 45% / loan-officer 20% / auditor 20% / vault-keeper 15% ===

// === Line pools (scripted, zero LLM) ===
const TELLER_GREET_LINES = Object.freeze([
  "Welcome to {bank}, {name}. Deposit or withdrawal?",
  "Step up to the counter, {name}. The bank is at your service.",
  "{bank} welcomes you, {name}. Coins in or coins out?",
]);

const TELLER_DEPOSIT_LINES = Object.freeze([
  "Depositing, {name}? I'll count it twice and the vault keeps it safe.",
  "Coins in. The ledger remembers every one, {name}.",
  "A wise saver. Your deposit is recorded, {name}.",
]);

const TELLER_WITHDRAW_LINES = Object.freeze([
  "Withdrawing, {name}? Mind the pickpockets outside.",
  "Coins out. Count them at the counter — the bank doesn't refund the street.",
  "Here you are, {name}. Spend it better than you earned it.",
]);

const TELLER_IDLE_LINES = Object.freeze([
  "The bank counts your coins while you sleep.",
  "No fees for honest folk. The vault does the rest.",
  "Ledgers balanced, vaults locked, clerks sober. A good day.",
]);

const VAULT_SEAL_LINES = Object.freeze([
  "The vault of {bank} is sealed for the night. Nothing moves till morning.",
  "Sealing the vault. Dream of interest, {name}.",
  "Vault sealed. The runes are armed — don't test them.",
]);

const VAULT_OPEN_LINES = Object.freeze([
  "The vault of {bank} is open. Business as usual.",
  "Unsealing the vault. Another day, another ledger.",
  "Vault open. The bank stands behind every coin.",
]);

const VAULT_LOITER_LINES = Object.freeze([
  "The vault is for customers only. Move along.",
  "You've been standing there a while. The vault notices.",
  "Eyes off the vault door, friend. The bank has a long memory.",
]);

const VAULT_HEAT_LINES = Object.freeze([
  "Security is tight today — there was trouble at {bank}. Eyes sharp.",
  "After the robbery attempt, the vault guard doubles. Don't get ideas.",
  "The bank remembers. {bank} is on high alert.",
]);

const LOAN_OFFER_LINES = Object.freeze([
  "Need coin, {name}? {bank} lends to honest folk — ten percent a week.",
  "A loan would set you right, {name}. The bank trusts a steady hand.",
  "The bank lends. The bank also collects. Interested, {name}?",
]);

const LOAN_GRANTED_LINES = Object.freeze([
  "Done. {amount} coins, owed back in seven days with interest. Don't be late, {name}.",
  "The ledger has you, {name}: {amount} coins, plus the bank's ten percent.",
]);

const LOAN_DENIED_LINES = Object.freeze([
  "The bank can't lend that much. Try a smaller sum, {name}.",
  "Denied. Even the bank has limits, {name}.",
]);

const LOAN_COLLECT_LINES = Object.freeze([
  "{name}. Your loan comes due. {owed} coins, and the bank dislikes waiting.",
  "A friendly reminder, {name}: {owed} coins owed to {bank}.",
  "The ledger doesn't forget, {name}. {owed} coins.",
]);

const LOAN_REPAID_LINES = Object.freeze([
  "Paid in full. The bank thanks you, {name} — and would lend again.",
  "Ledger cleared, {name}. An honest borrower is a rare coin.",
]);

const AUDIT_START_LINES = Object.freeze([
  "Daily audit of {bank} begins. Nobody touch the ledgers.",
  "Counting the vault. If a coin is missing, I will find it.",
  "Audit time. The books will balance or heads will roll — metaphorically.",
]);

const AUDIT_CLEAR_LINES = Object.freeze([
  "Audit complete: every coin accounted for at {bank}. As it should be.",
  "The books balance. {bank} stands sound.",
]);

const AUDIT_DISCREPANCY_LINES = Object.freeze([
  "Hm. Three coins unaccounted for. Someone's arithmetic is about to improve.",
  "A discrepancy in the ledger... interesting. Very interesting.",
  "The books don't lie, but somebody does. I'll find them.",
]);

const SUSPICION_LINES = Object.freeze([
  "You. Loitering again. The bank sees you, {name}.",
  "Casing the vault, are we? The watch will hear about this, {name}.",
  "Third time past the vault today, {name}. Coincidence wears thin.",
]);

// === State ===
const lastFlavorByBanker = new Map(); // banker username -> timestamp (flavor lines)
const lastTellerService = new Map(); // banker username -> timestamp
const lastVault = new Map(); // banker username -> timestamp
const lastLoan = new Map(); // banker username -> timestamp
const lastAudit = new Map(); // banker username -> timestamp
const lastVaultAnnounce = new Map(); // banker username -> "open"|"sealed" announced
const lastAuditDay = new Map(); // bank short -> day key audited

const loans = new Map(); // normalized player name -> { player, amount, owed, at, due, bank }
const heat = new Map(); // bank short -> { level, at }
const suspicion = new Map(); // normalized player name -> { player, bank, at, until }

let lastPruneAt = 0;
function pruneMaps(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastFlavorByBanker, lastTellerService, lastVault, lastLoan, lastAudit]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
  for (const [k, l] of loans) {
    if (!l || l.due + HEAT_TTL_MS <= nowMs) loans.delete(k);
  }
  for (const [k, h] of heat) {
    if (!h || h.at + HEAT_TTL_MS <= nowMs) heat.delete(k);
  }
  for (const [k, s] of suspicion) {
    if (!s || s.until <= nowMs) suspicion.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Fill "{name}" style slots in a scripted line. */
function fillLine(line, vars) {
  let out = String(line ?? "");
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.split(`{${k}}`).join(String(v ?? ""));
  }
  return out;
}

/** FNV-1a hash of a string — stable assignments across restarts. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Banker type from username hash, stable across restarts, zero storage.
 * ~35% of commoners are bankers: teller 45% / loan-officer 20% /
 * auditor 20% / vault-keeper 15%. Returns null for non-bankers.
 */
function bankerTypeFor(username) {
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "banker") return null;
  const t = fnv1a("bankertype|" + String(username ?? "").toLowerCase()) % 100;
  if (t < 45) return "teller";
  if (t < 65) return "loan-officer";
  if (t < 85) return "auditor";
  return "vault-keeper";
}

/** The bank this banker works at — kingdom-preferred, stable across restarts. */
function bankFor(username, kingdom) {
  let pool = (BANKS || []).filter((b) => b.kingdom === kingdom);
  if (pool.length === 0) pool = BANKS;
  const h = fnv1a("bank|" + String(username ?? "").toLowerCase());
  return pool[h % pool.length];
}

/** Pure: are banks open at this wall-clock hour? 08:00-20:00. */
function banksOpenAt(hour) {
  return hour >= BANK_OPEN_HOUR && hour < BANK_CLOSE_HOUR;
}

/** Pure: whole coins owed on a loan of `amount` at 10% interest. */
function loanOwedFor(amount) {
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  return a + Math.floor((a * LOAN_INTEREST_BPS) / 10000);
}

/** Pure: is this loan amount within the bank's lending range? */
function loanAmountOk(amount) {
  const a = Math.floor(Number(amount) || 0);
  return a >= LOAN_MIN && a <= LOAN_MAX;
}

/** Normalize a name for the ledger (lowercase, trimmed). */
function normName(name) {
  return String(name ?? "").trim().toLowerCase();
}

/**
 * Record a loan. Called by the LLM dialogue tier when a loan officer agrees
 * to lend. Pure-ish: writes the module-level ledger.
 * @returns {object|null} the loan record, or null if the amount is invalid
 */
function requestLoan(playerUsername, amount, bankShort, nowMs) {
  const key = normName(playerUsername);
  if (!key || !loanAmountOk(amount)) return null;
  if (loans.has(key)) return null; // one loan at a time — the bank is careful
  const owed = loanOwedFor(amount);
  const loan = {
    player: String(playerUsername ?? "").trim(),
    amount: Math.floor(Number(amount)),
    owed,
    at: nowMs,
    due: nowMs + LOAN_TERM_MS,
    bank: String(bankShort ?? ""),
  };
  loans.set(key, loan);
  return loan;
}

/** Pure-ish: the outstanding loan for a player, or null. Prunes the dead. */
function loanFor(playerUsername, nowMs) {
  const key = normName(playerUsername);
  const l = loans.get(key);
  if (!l) return null;
  if (l.due + HEAT_TTL_MS <= nowMs) {
    loans.delete(key);
    return null;
  }
  return l;
}

/**
 * Repay part or all of a loan.
 * @returns {number} remaining owed after payment (0 = cleared)
 */
function repayLoan(playerUsername, amount, nowMs) {
  const key = normName(playerUsername);
  const l = loans.get(key);
  if (!l) return 0;
  const pay = Math.max(0, Math.floor(Number(amount) || 0));
  l.owed = Math.max(0, l.owed - pay);
  if (l.owed === 0) loans.delete(key);
  return l.owed;
}

/** Pure: is this player's loan overdue? */
function loanOverdue(playerUsername, nowMs) {
  const l = loanFor(playerUsername, nowMs);
  return !!l && l.due <= nowMs;
}

/**
 * Raise a bank's security heat (a robbery attempt). Decays over a week.
 * @returns {number} the new heat level (0-100)
 */
function raiseHeat(bankShort, nowMs) {
  const key = String(bankShort ?? "");
  if (!key) return 0;
  const h = heat.get(key);
  const level = Math.min(HEAT_MAX, (h?.level ?? 0) + HEAT_STEP);
  heat.set(key, { level, at: nowMs });
  return level;
}

/** Pure-ish: current heat for a bank (0-100), decayed linearly over a week. */
function heatFor(bankShort, nowMs) {
  const key = String(bankShort ?? "");
  const h = heat.get(key);
  if (!h) return 0;
  const age = nowMs - h.at;
  if (age >= HEAT_TTL_MS) {
    heat.delete(key);
    return 0;
  }
  return Math.max(0, Math.round(h.level * (1 - age / HEAT_TTL_MS)));
}

/**
 * Note that a player is casing a bank (loitering near the vault). Called by
 * the LLM tier / robbery systems when casing is detected.
 */
function noteSuspicion(playerUsername, bankShort, nowMs) {
  const key = normName(playerUsername);
  if (!key) return false;
  suspicion.set(key, {
    player: String(playerUsername ?? "").trim(),
    bank: String(bankShort ?? ""),
    at: nowMs,
    until: nowMs + SUSPICION_TTL_MS,
  });
  return true;
}

/** Pure-ish: is this player currently suspected of casing? Prunes expired. */
function suspicionFor(playerUsername, nowMs) {
  const key = normName(playerUsername);
  const s = suspicion.get(key);
  if (!s) return null;
  if (s.until <= nowMs) {
    suspicion.delete(key);
    return null;
  }
  return s;
}

/** Generic cooldown + chance gate. Pure and testable. */
function shouldFire(rng, lastMs, nowMs, cooldownMs, chance) {
  if (nowMs - (lastMs || 0) < cooldownMs) return false;
  return rng() < chance;
}

/** Plain tile of an engine player, or null. */
function botTile(player) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ() ?? 0 };
  } catch {
    return null;
  }
}

function journal(director, name, kind, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(name, kind, text, data ? { data } : undefined);
  } catch {
    // Journal must never break the bank.
  }
}

function forceSay(bot, line) {
  try {
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [String(line).slice(0, 120)] })); }
  } catch {
    // Cosmetic only.
  }
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me) return out;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || !isRealPlayer(p)) continue;
      const t = botTile(p);
      if (!t) continue;
      const d = Math.max(Math.abs(me.x - t.x), Math.abs(me.y - t.y));
      if (d <= tiles) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

// ============================================================================
// Per-type ticks.
// ============================================================================

function tickTeller(director, record, bot, nowMs, rng, seen, open, bank) {
  if (!seen) return;
  const username = record.username;
  const near = realPlayersWithin(bot, BANKER_RADIUS);
  if (near.length === 0) return;
  if (!open) {
    // After hours: a teller behind a closed counter.
    if (!shouldFire(rng, lastFlavorByBanker.get(username), nowMs, BANKER_COOLDOWN_MS, 0.3)) return;
    forceSay(bot, "The bank is closed. Come back at eight in the morning.");
    lastFlavorByBanker.set(username, nowMs);
    return;
  }
  const p = near[0];
  const pname = p.getUsername?.() ?? "?";
  // Serve a customer: deposit, withdrawal, or greeting.
  if (shouldFire(rng, lastTellerService.get(username), nowMs, TELLER_SERVICE_COOLDOWN_MS, 0.7)) {
    const roll = rng();
    const vars = { name: pname, bank: bank.name };
    if (roll < 0.35) {
      forceSay(bot, fillLine(pickOne(rng, TELLER_DEPOSIT_LINES), vars));
      journal(director, username, "work", `Served a deposit for ${pname}.`);
    } else if (roll < 0.7) {
      forceSay(bot, fillLine(pickOne(rng, TELLER_WITHDRAW_LINES), vars));
      journal(director, username, "work", `Served a withdrawal for ${pname}.`);
    } else {
      forceSay(bot, fillLine(pickOne(rng, TELLER_GREET_LINES), vars));
    }
    lastTellerService.set(username, nowMs);
    return;
  }
  if (shouldFire(rng, lastFlavorByBanker.get(username), nowMs, BANKER_COOLDOWN_MS, 0.3)) {
    forceSay(bot, pickOne(rng, TELLER_IDLE_LINES));
    lastFlavorByBanker.set(username, nowMs);
  }
}

function tickVaultKeeper(director, record, bot, nowMs, rng, seen, open, bank) {
  if (!seen) return;
  const username = record.username;
  // Vault open/seal announcements: once per state, only where players hear.
  const d = new Date(nowMs);
  const state = open ? "open" : "sealed";
  const announced = lastVaultAnnounce.get(username);
  if (announced !== state) {
    if (d.getHours() === BANK_OPEN_HOUR && open) {
      forceSay(bot, fillLine(pickOne(rng, VAULT_OPEN_LINES), { bank: bank.name }));
      journal(director, username, "work", `Unsealed the vault of ${bank.name}.`);
      lastVaultAnnounce.set(username, state);
      return;
    }
    if (d.getHours() === BANK_CLOSE_HOUR && !open) {
      forceSay(bot, fillLine(pickOne(rng, VAULT_SEAL_LINES), { bank: bank.name, name: "" }));
      journal(director, username, "work", `Sealed the vault of ${bank.name}.`);
      lastVaultAnnounce.set(username, state);
      return;
    }
  }
  if (!shouldFire(rng, lastVault.get(username), nowMs, VAULT_COOLDOWN_MS, 0.5)) return;
  const near = realPlayersWithin(bot, BANKER_RADIUS);
  const heatLevel = heatFor(bank.short, nowMs);
  // High heat: the vault keeper says so.
  if (heatLevel >= 50 && rng() < 0.5) {
    forceSay(bot, fillLine(pickOne(rng, VAULT_HEAT_LINES), { bank: bank.name }));
    journal(director, username, "work", `${bank.name} on high alert (heat ${heatLevel}).`);
    lastVault.set(username, nowMs);
    return;
  }
  if (near.length === 0) return;
  // Call out a suspected casing player by name; otherwise a loiterer warning.
  for (const p of near) {
    const pname = p.getUsername?.() ?? "?";
    const s = suspicionFor(pname, nowMs);
    if (s) {
      forceSay(bot, fillLine(pickOne(rng, SUSPICION_LINES), { name: pname }));
      journal(director, username, "work", `Warned suspected casing: ${pname}.`);
      lastVault.set(username, nowMs);
      return;
    }
  }
  if (rng() < 0.4) {
    forceSay(bot, pickOne(rng, VAULT_LOITER_LINES));
    lastVault.set(username, nowMs);
  }
}

function tickLoanOfficer(director, record, bot, nowMs, rng, seen, open, bank) {
  if (!seen || !open) return;
  const username = record.username;
  if (!shouldFire(rng, lastLoan.get(username), nowMs, LOAN_COOLDOWN_MS, 0.5)) return;
  const near = realPlayersWithin(bot, BANKER_RADIUS);
  if (near.length === 0) return;
  const p = near[0];
  const pname = p.getUsername?.() ?? "?";
  const loan = loanFor(pname, nowMs);
  if (loan) {
    // Collect from a debtor.
    const vars = { name: pname, owed: `${loan.owed} coins`, bank: bank.name };
    forceSay(bot, fillLine(pickOne(rng, LOAN_COLLECT_LINES), vars));
    journal(director, username, "work", `Collected on ${pname}'s loan (${loan.owed} owed).`);
  } else if (rng() < 0.5) {
    forceSay(bot, fillLine(pickOne(rng, LOAN_OFFER_LINES), { name: pname, bank: bank.name }));
    journal(director, username, "work", `Offered a loan to ${pname}.`);
  }
  lastLoan.set(username, nowMs);
}

function tickAuditor(director, record, bot, nowMs, rng, seen, open, bank) {
  if (!seen) return;
  const username = record.username;
  if (!shouldFire(rng, lastAudit.get(username), nowMs, AUDIT_COOLDOWN_MS, 0.5)) return;
  const d = new Date(nowMs);
  const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const roll = rng();
  if (lastAuditDay.get(bank.short) !== dayKey && roll < 0.5) {
    // The daily audit, once per bank per day.
    forceSay(bot, fillLine(pickOne(rng, AUDIT_START_LINES), { bank: bank.name }));
    if (rng() < 0.25) {
      forceSay(bot, pickOne(rng, AUDIT_DISCREPANCY_LINES));
      journal(director, username, "work", `Audit of ${bank.name}: a discrepancy found.`);
    } else {
      forceSay(bot, fillLine(pickOne(rng, AUDIT_CLEAR_LINES), { bank: bank.name }));
      journal(director, username, "work", `Audit of ${bank.name}: books balanced.`);
    }
    lastAuditDay.set(bank.short, dayKey);
  } else {
    forceSay(bot, pickOne(rng, AUDIT_DISCREPANCY_LINES.concat(AUDIT_CLEAR_LINES)));
    journal(director, username, "work", `Muttered over the books at ${bank.name}.`);
  }
  lastAudit.set(username, nowMs);
}

function tickBanker(director, record, bot, nowMs, rng, seen, open) {
  const type = bankerTypeFor(record.username);
  if (!type) return;
  const bank = bankFor(record.username, record.kingdom);
  try {
    if (type === "teller") tickTeller(director, record, bot, nowMs, rng, seen, open, bank);
    else if (type === "vault-keeper") tickVaultKeeper(director, record, bot, nowMs, rng, seen, open, bank);
    else if (type === "loan-officer") tickLoanOfficer(director, record, bot, nowMs, rng, seen, open, bank);
    else if (type === "auditor") tickAuditor(director, record, bot, nowMs, rng, seen, open, bank);
  } catch {
    // One bad banker never breaks the bank.
  }
}

// ============================================================================
// Main tick — called from CitizenDirector.tickProximity(), right after the
// guards block. Gate order: commoner → banker type → cooldown → materialized
// → real player near → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickBankers(director, nowMs, desync) {
  void desync;
  pruneMaps(nowMs);
  const open = banksOpenAt(new Date(nowMs).getHours());
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners bank (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        if (!bankerTypeFor(record.username)) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        const last = lastFlavorByBanker.get(record.username) || 0;
        if (nowMs - last < 5 * 60 * 1000) continue;

        // 3. Materialized bot? Real player near?
        let bot = null;
        try {
          bot = (director.isOnline(record) ? director.getBot(record) : null);
        } catch {
          continue;
        }
        if (!bot) continue;
        const seen = realPlayersWithin(bot, BANKER_RADIUS).length > 0;
        if (!seen) continue;

        tickBanker(director, record, bot, nowMs, Math.random, seen, open);
        lastFlavorByBanker.set(record.username, nowMs);
      } catch {
        // One bad banker never breaks the tick.
      }
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-bankers] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickBankers,
  requestLoan,
  repayLoan,
  loanFor,
  loanOverdue,
  raiseHeat,
  heatFor,
  noteSuspicion,
  suspicionFor,
  // Export pure helpers for tests:
  pickOne,
  isRealPlayer,
  fillLine,
  fnv1a,
  bankerTypeFor,
  bankFor,
  banksOpenAt,
  loanOwedFor,
  loanAmountOk,
  shouldFire,
  normName,
  // Tuning (tests pin the documented behavior):
  BANKER_RADIUS,
  BANK_OPEN_HOUR,
  BANK_CLOSE_HOUR,
  LOAN_INTEREST_BPS,
  LOAN_TERM_MS,
  LOAN_MAX,
  LOAN_MIN,
  HEAT_TTL_MS,
  HEAT_STEP,
  HEAT_MAX,
  SUSPICION_TTL_MS,
  // Data (non-empty checks):
  BANKS,
  // Line pools (non-empty checks):
  TELLER_GREET_LINES,
  TELLER_DEPOSIT_LINES,
  TELLER_WITHDRAW_LINES,
  TELLER_IDLE_LINES,
  VAULT_SEAL_LINES,
  VAULT_OPEN_LINES,
  VAULT_LOITER_LINES,
  VAULT_HEAT_LINES,
  LOAN_OFFER_LINES,
  LOAN_GRANTED_LINES,
  LOAN_DENIED_LINES,
  LOAN_COLLECT_LINES,
  LOAN_REPAID_LINES,
  AUDIT_START_LINES,
  AUDIT_CLEAR_LINES,
  AUDIT_DISCREPANCY_LINES,
  SUSPICION_LINES,
};
