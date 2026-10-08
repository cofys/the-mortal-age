"use strict";

/**
 * CitizenTaxCollectors — officials who assess, collect and enforce taxes:
 * assessors, collectors, auditors and enforcers.
 *
 * WHAT IT DOES (data tier, free):
 *   Every tax-collector citizen gets a hash-stable collector type.
 *   Collection rounds run on a weekly rhythm derived from hashes — which
 *   citizens owe what, derived tax bills, evasion flags, and penalties — all
 *   deterministic, zero disk state. Tax dues owed by real players live in an
 *   in-memory ledger (7-day TTL, pruned). Penalties are written through the
 *   real CitizenJudges fine ledger (lazy require, best-effort) so evasion
 *   lands in the tax courts. Everything is journaled so the LLM mouth can
 *   riff on it later ("you still owe the crown forty coins from Tuesday").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   During collection rounds (08:00-18:00 server time) collectors knock and
 *   call for dues; assessors pace out property with chalk and line; auditors
 *   invite lingering players to an audit; enforcers seize goods from
 *   delinquent bots in scripted scenes. Bribe attempts are risky — enforcers
 *   double the debt. The work is journaled once per loop.
 *
 * Zero LLM: every line is scripted from pools; the LLM mouth only reads the
 * journal and the public data API (taxDueFor, payTax, auditFor). Complements
 * CitizenBankers (money/ledgers) and CitizenJudges (fines/appeals) — this
 * module owns types, rounds, assessments, collections, audits, evasion and
 * enforcement. No overlap.
 *
 * Wired into the director tick in tickProximity(), right after the judges
 * block. Plain-node testable: CitizenTaxCollectors.test.js.
 */

// === Tuning: all magic numbers here ===
const TAX_RADIUS = 14; // tiles — a real player must be near to see/hear
const ROUND_COOLDOWN_MS = 4 * 60 * 60 * 1000; // a collector works a round at most this often
const AUDIT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // an auditor audits at most this often
const ENFORCE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // an enforcer seizes at most this often
const ASSESS_COOLDOWN_MS = 8 * 60 * 60 * 1000; // an assessor values property at most this often
const ROUND_HOUR_START = 8; // collection rounds 08:00-18:00 server time
const ROUND_HOUR_END = 18;
const TAX_LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // unpaid tax dues linger a week
const COLLECTOR_CHANCE = 0.35; // ~35% of courtiers become tax collectors
const EVASION_CHANCE = 0.08; // ~8% of taxed citizens flagged as evading this round

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Collector types and revenue offices ===
const COLLECTOR_TYPES = Object.freeze(["assessor", "collector", "auditor", "enforcer"]);

const OFFICES = Object.freeze([
  { name: "the Varrock exchequer", kingdom: "varrock" },
  { name: "the Lumbridge toll office", kingdom: "lumbridge" },
  { name: "the Falador excise hall", kingdom: "falador" },
  { name: "the Port Sarim harbour dues office", kingdom: "portsarim" },
  { name: "the Ardougne tithe office", kingdom: "ardougne" },
  { name: "the Kandarin revenue hall", kingdom: "kandarin" },
  { name: "the Keldagrim tax vault", kingdom: "keldagrim" },
  { name: "the Dorgesh water-tax kiosk", kingdom: "dorgeshuun" },
  { name: "the Darkmeyer tithe house", kingdom: "morytania" },
  { name: "the Al Kharid trade levy office", kingdom: "alkharid" },
]);

const TAX_TYPES = Object.freeze([
  { kind: "property tax", lo: 20, hi: 90 },
  { kind: "trade tax", lo: 15, hi: 70 },
  { kind: "income tithe", lo: 10, hi: 60 },
]);

// === Line pools (scripted, zero LLM) ===
const ROUND_OPEN_LINES = Object.freeze([
  "{collector} the {type} begins the day's collection round for {office}.",
  "Hear ye — {collector} the {type} is collecting the {kind} on behalf of {office}.",
  "{collector} pins the day's rate table to the {office} board. Pay up, everyone.",
]);

const COLLECT_DEMAND_LINES = Object.freeze([
  "{collector}: The crown's share, if you please. {due} coins for {kind}.",
  "{collector}: Taxes are due, {name}. {due} coins for {kind}, and no excuses.",
  "{collector}: {name}, you owe {due} coins in {kind}. The ledger does not forget.",
  "{collector}: A coin for the realm! {due} coins for {kind}, {name}.",
]);

const COLLECT_PAID_LINES = Object.freeze([
  "{collector}: Paid in full. The crown thanks you, {name}.",
  "{collector}: {due} coins received. A receipt for your records, {name}.",
  "{collector}: Mark the ledger: {name} is square on the {kind}.",
]);

const ASSESS_LINES = Object.freeze([
  "{collector} chalks property lines and mutters valuations to {assistant}.",
  "{collector}: That shop front is worth more than you declared, {name}. Reassessed.",
  "{collector}: Hmm — the {kind} on this plot comes to {due} coins this round.",
]);

const AUDIT_OFFER_LINES = Object.freeze([
  "{collector}: {name}, your books look... interesting. Shall we audit together?",
  "{collector}: A word, {name}. The auditor's quill is itching.",
  "{collector}: {name}, {office} requests a look at your accounts.",
]);

const AUDIT_CLEAN_LINES = Object.freeze([
  "{collector}: Clean books, {name}. A rare pleasure. Mind you keep them so.",
  "{collector}: No discrepancies, {name}. The office apologizes for the trouble.",
]);

const AUDIT_EVASION_LINES = Object.freeze([
  "{collector}: {name}, the ledger says {due} coins and your purse says otherwise. Evasion.",
  "{collector}: Underreported, {name}. This goes to the court — and the fine will sting.",
]);

const ENFORCE_LINES = Object.freeze([
  "{collector}: By order of {office}, these goods are seized for unpaid {kind}.",
  "{collector}: The tax is owed and the tax is taken. Seize the crate.",
  "{collector}: {name} would not pay, so the crown helps itself.",
]);

const BRIBE_CAUGHT_LINES = Object.freeze([
  "{collector}: You offer {collector} a bribe? The debt just doubled, {name}.",
  "{collector}: Bribery! The enforcers have been told, {name}. Foolish.",
  "{collector}: {name}, the crown does not haggle. Your debt is now {due} coins.",
]);

const BRIBE_MISSED_LINES = Object.freeze([
  "{collector} pockets the coin and forgets the whole visit ever happened. Probably.",
]);

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

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

/** Lowercase-normalized name for ledger keys. */
function normName(name) {
  return String(name ?? "").toLowerCase().trim();
}

/** Pick one item from an array with an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Collector type from username hash, stable across restarts, zero storage.
 * ~35% of courtiers are collectors: assessor 40% / collector 30% /
 * auditor 15% / enforcer 15%. Returns null for non-collectors.
 */
function collectorTypeFor(username) {
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "taxcollector") return null;
  const t = fnv1a("tax|ctype|" + normName(username)) % 100;
  if (t < 40) return "assessor";
  if (t < 70) return "collector";
  if (t < 85) return "auditor";
  return "enforcer";
}

/** True if this username is a tax collector of any type. */
function isTaxCollector(username) {
  return collectorTypeFor(username) !== null;
}

/** Revenue office for a citizen: kingdom-preferred, hash-stable. */
function officeFor(username, kingdomId) {
  const k = String(kingdomId ?? "").toLowerCase();
  const home = OFFICES.filter((o) => o.kingdom === k);
  const pool = home.length > 0 ? home : OFFICES;
  return pool[fnv1a("tax|office|" + normName(username) + "|" + k) % pool.length];
}

/** Tax bill for a citizen this round: kind + derived amount. */
function taxBillFor(username, kingdomId, dayStamp) {
  const h = fnv1a("tax|bill|" + normName(username) + "|" + String(dayStamp));
  const tax = TAX_TYPES[h % TAX_TYPES.length];
  const amount = tax.lo + (h >>> 8) % (tax.hi - tax.lo + 1);
  return { kind: tax.kind, due: amount };
}

/** Derived evasion flag: ~8% of taxed citizens evade this round. */
function isEvading(username, dayStamp) {
  return fnv1a("tax|evade|" + normName(username) + "|" + String(dayStamp)) % 100 < 8;
}

/** Collection rounds happen 08:00-18:00 server time. */
function inRoundAtHour(hour) {
  return hour >= ROUND_HOUR_START && hour < ROUND_HOUR_END;
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

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ============================================================================
// Tax dues ledger (data tier) — what real players owe the crown.
// ============================================================================

const taxDues = new Map(); // normName -> { name, kind, due, assessedAt, until }
let lastTaxPruneAt = 0;

function pruneTaxLedger(nowMs) {
  if (nowMs - lastTaxPruneAt < 3600 * 1000) return;
  lastTaxPruneAt = nowMs;
  for (const [k, v] of taxDues) {
    if (v.until <= nowMs) taxDues.delete(k);
  }
}

/** Assess tax dues against a player (called by collectors; LLM dialogue tier may call too). */
function assessTax(playerName, kind, due, nowMs) {
  pruneTaxLedger(nowMs);
  const key = normName(playerName);
  taxDues.set(key, {
    name: String(playerName),
    kind: String(kind),
    due: Math.max(1, Math.floor(Number(due) || 0)),
    assessedAt: nowMs,
    until: nowMs + TAX_LEDGER_TTL_MS,
  });
  return taxDues.get(key);
}

/** Tax dues owed by a player, or null. */
function taxDueFor(playerName, nowMs) {
  pruneTaxLedger(nowMs);
  const v = taxDues.get(normName(playerName));
  if (!v) return null;
  if (v.until <= nowMs) {
    taxDues.delete(normName(playerName));
    return null;
  }
  return { name: v.name, kind: v.kind, due: v.due };
}

/** Pay taxes: partial or full payment against the dues ledger. */
function payTax(playerName, amount, nowMs) {
  pruneTaxLedger(nowMs);
  const v = taxDues.get(normName(playerName));
  if (!v) return null;
  const paid = Math.min(Math.max(0, Math.floor(Number(amount) || 0)), v.due);
  v.due -= paid;
  if (v.due <= 0) taxDues.delete(normName(playerName));
  return { paid, remaining: v.due };
}

// ============================================================================
// Cross-module ties (lazy, best-effort — never throw).
// ============================================================================

/** Write an evasion penalty into the real court fine ledger (CitizenJudges). */
function recordCourtFine(defendant, amount, text) {
  try {
    const { recordFine } = require("./CitizenJudges");
    if (typeof recordFine === "function") return recordFine(defendant, amount, text);
  } catch {
    // Courts must never break tax collection.
  }
  return null;
}

// ============================================================================
// Engine helpers (impure, guarded).
// ============================================================================

function journal(director, name, kind, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(name, kind, text, data ? { data } : undefined);
  } catch {
    // Journal must never break tax collection.
  }
}

function forceSay(bot, line) {
  try {
    bot.forceChat?.(String(line).slice(0, 120));
  } catch {
    // Cosmetic only.
  }
}

function roleOf(record) {
  try {
    return String(record.attributes?.citizenRole ?? record.attributes?.role ?? "").toLowerCase();
  } catch {
    return "";
  }
}

function kingdomOf(record) {
  try {
    return record.attributes?.kingdomId ?? record.attributes?.kingdom ?? "varrock";
  } catch {
    return "varrock";
  }
}

/** Hour of day (0-23) in the server's local timezone. */
function hourOf(nowMs) {
  return new Date(nowMs).getHours();
}

/** Day stamp YYYYMMDD for per-day derived values. */
function dayStampOf(nowMs) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → citizen exists → real player near → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickTaxCollectors(director, nowMs) {
  pruneCooldowns(nowMs);
  pruneTaxLedger(nowMs);
  try {
    const hour = hourOf(nowMs);
    const inRound = inRoundAtHour(hour);
    const day = dayStampOf(nowMs);

    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 0. Only courtiers may be tax collectors.
        if (roleOf(record) !== "courtier") continue;
        const type = collectorTypeFor(record.username);
        if (!type) continue;

        // 1. Cooldown gate — O(1), skips almost everyone.
        const cooldown =
          type === "auditor" ? AUDIT_COOLDOWN_MS
          : type === "assessor" ? ASSESS_COOLDOWN_MS
          : type === "enforcer" ? ENFORCE_COOLDOWN_MS
          : ROUND_COOLDOWN_MS;
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < cooldown) continue;

        // 2. Citizen must be materialized (near a player already).
        const bot = director.playerFor?.(record);
        if (!bot) continue;

        // 3. A real player must be within earshot.
        const players = director.onlinePlayers?.() ?? [];
        let near = null;
        for (const p of players) {
          if (!isRealPlayer(p)) continue;
          if (withinTiles(bot, p, TAX_RADIUS)) { near = p; break; }
        }
        if (!near) continue;

        const office = officeFor(record.username, kingdomOf(record));
        const rng = Math.random;
        const pname = near.getUsername?.() ?? "traveler";

        if (type === "collector" && inRound) {
          const bill = taxBillFor(pname, kingdomOf(record), day);
          const existing = taxDueFor(pname, nowMs);
          if (!existing || existing.due <= 0) assessTax(pname, bill.kind, bill.due, nowMs);
          forceSay(bot, fillLine(pickOne(rng, COLLECT_DEMAND_LINES), {
            collector: record.username,
            name: pname,
            kind: bill.kind,
            due: bill.due,
          }));
          journal(director, record.username, "tax",
            `assessed ${pname} ${bill.due} coins for ${bill.kind}`);
        } else if (type === "assessor" && inRound) {
          const bill = taxBillFor(record.username, kingdomOf(record), day);
          forceSay(bot, fillLine(pickOne(rng, ASSESS_LINES), {
            collector: record.username,
            assistant: "the clerk",
            name: pname,
            kind: bill.kind,
            due: bill.due,
          }));
          journal(director, record.username, "tax", `reassessed property at ${office.name}`);
        } else if (type === "auditor") {
          const due = taxDueFor(pname, nowMs);
          if (due && due.due > 0) {
            forceSay(bot, fillLine(pickOne(rng, AUDIT_EVASION_LINES), {
              collector: record.username,
              name: pname,
              due: due.due,
            }));
            const fine = Math.max(50, due.due * 2);
            recordCourtFine(pname, fine, `tax evasion (${due.kind})`);
            journal(director, record.username, "tax",
              `audited ${pname}: underpaid ${due.due} coins, referred to court`);
          } else {
            forceSay(bot, fillLine(pickOne(rng, AUDIT_CLEAN_LINES), {
              collector: record.username,
              name: pname,
            }));
          }
        } else if (type === "enforcer" && inRound) {
          // Scripted seizure: the enforcer takes goods from a delinquent bot target.
          const bill = taxBillFor(pname, kingdomOf(record), day);
          forceSay(bot, fillLine(pickOne(rng, ENFORCE_LINES), {
            collector: record.username,
            office: office.name,
            name: pname,
            kind: bill.kind,
          }));
          journal(director, record.username, "tax",
            `seized goods from ${pname} for unpaid ${bill.kind}`);
        } else if (type === "collector" && !inRound) {
          // Outside hours collectors just mutter about the day's take.
          journal(director, record.username, "tax", "balanced the day's collection book");
        }

        lastFiredByCitizen.set(record.username, nowMs);
      } catch {
        // One bad collector never breaks the tick.
      }
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-taxcollectors] tick failed:", e?.message ?? e);
  }
}

/**
 * A bribe attempt by a player at the interaction tier (LLM dialogue reports
 * the attempt; this resolves the outcome deterministically).
 * Returns { outcome: "caught"|"missed", newDue }.
 */
function bribeOutcome(playerName, amount, nowMs) {
  pruneTaxLedger(nowMs);
  const h = fnv1a("tax|bribe|" + normName(playerName) + "|" + String(dayStampOf(nowMs)));
  const caught = h % 100 < 75; // 75% of bribes backfire — the crown does not haggle
  const due = taxDueFor(playerName, nowMs);
  let newDue = due ? due.due : 0;
  if (caught && due) {
    newDue = due.due * 2;
    taxDues.get(normName(playerName)).due = newDue;
    recordCourtFine(playerName, Math.max(50, newDue), "attempted bribery of a tax collector");
  }
  return { outcome: caught ? "caught" : "missed", newDue };
}

module.exports = {
  tickTaxCollectors,
  assessTax,
  taxDueFor,
  payTax,
  bribeOutcome,
  recordCourtFine,
  // Export pure helpers for tests:
  pickOne,
  isRealPlayer,
  withinTiles,
  fillLine,
  fnv1a,
  normName,
  collectorTypeFor,
  isTaxCollector,
  officeFor,
  taxBillFor,
  isEvading,
  inRoundAtHour,
  // Tuning (tests pin the documented behavior):
  TAX_RADIUS,
  ROUND_COOLDOWN_MS,
  AUDIT_COOLDOWN_MS,
  ENFORCE_COOLDOWN_MS,
  ASSESS_COOLDOWN_MS,
  ROUND_HOUR_START,
  ROUND_HOUR_END,
  TAX_LEDGER_TTL_MS,
  COLLECTOR_CHANCE,
  EVASION_CHANCE,
  // Data (non-empty checks):
  COLLECTOR_TYPES,
  OFFICES,
  // Line pools (non-empty checks):
  ROUND_OPEN_LINES,
  COLLECT_DEMAND_LINES,
  COLLECT_PAID_LINES,
  ASSESS_LINES,
  AUDIT_OFFER_LINES,
  AUDIT_CLEAN_LINES,
  AUDIT_EVASION_LINES,
  ENFORCE_LINES,
  BRIBE_CAUGHT_LINES,
  BRIBE_MISSED_LINES,
};
