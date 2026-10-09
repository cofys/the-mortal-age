"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenBankers2 — the moneyfolk: street money-changers, coin-sorters for
 * hire, market lenders and pawnbrokers. Commoners who live off coin without
 * working in a bank: the informal money economy under the pro trade's nose.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived moneyfolk types, per-day exchange rates and assay results,
 *   street-pitch assignments, assay set-pieces (clipped/counterfeit coin
 *   finds), lending-rush days, 7-day TTL ledgers for micro-loans and pawn
 *   tickets. Exchange rates and appraisals read deterministic day+name
 *   math; the pro bank's real open-hours and bank list are cross-read so
 *   changers can point players at the formal banks ("the bank's shut —
 *   but I'm quicker anyway").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 07:00-21:00 local): scripted exchange pitches with today's rates, coin
 * assay lines, counting emotes, loan offers, pawn lines, collection
 * callouts when a nearby player has an overdue brass-note loan, and
 * pawn-redemption callouts. Assay alerts and lending rushes are journaled
 * and rumor-seeded.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 * Loan/pawn dialogue itself is LLM tier — this module only tracks state,
 * timers and the visible street scene.
 *
 * Wired into the director tick right after the farmfolk block. Plain-node
 * testable: CitizenBankers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenBankers owns the FORMAL trade (teller deposits/withdrawals,
 *     vault security, loan-officer loans of 100-50k at 10% over 7 days,
 *     audits) — bankerTypeFor() citizens are excluded via the real
 *     module's null path.
 *   - CitizenHawker owns general street hawking — moneyfolk pitch money
 *     services only, never goods.
 *   - CitizenMarketStalls owns the anchored market stalls — moneyfolk work
 *     open street PITCHES at market edges, never stalls.
 *   - CitizenCouriers own message/parcel running — moneyfolk never carry.
 *   - Micro-loans are street brass-notes (25-5000 coins, 20% over 3 days),
 *     deliberately smaller and steeper than the bank's loan product; the
 *     two live in separate ledgers with separate APIs.
 */

// === Tuning: all magic numbers here ===
const MONEYFOLK_RADIUS = 14; // tiles — close enough to see/hear
const MONEYFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const MONEYFOLK_CHANCE = 0.15; // per eligible citizen per tick
const MONEYFOLK_SHARE = 45; // ~45% nominal share of commoners (post-exclusion)
const ASSAY_ALERT_CHANCE = 0.08; // ~8% per pitch per day: a clipped coin is found
const LENDING_RUSH_CHANCE = 0.08; // ~8% per kingdom per day: market lenders shout terms
const WORK_START_HOUR = 7; // 07:00 server local time
const WORK_END_HOUR = 21; // 21:00 server local time
const MICROLOAN_TTL_MS = 7 * 24 * 3600 * 1000;
const MICROLOAN_INTEREST_BPS = 2000; // 20% street interest (bank charges 10%)
const MICROLOAN_TERM_MS = 3 * 24 * 3600 * 1000; // brass notes come due in 3 days
const MICROLOAN_MIN = 25;
const MICROLOAN_MAX = 5000;
const PAWN_TTL_MS = 7 * 24 * 3600 * 1000;
const PAWN_TERM_MS = 7 * 24 * 3600 * 1000; // 7 days to redeem before forfeit
const PAWN_MIN = 10;

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProBankers = safeRequire("./CitizenBankers");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");
const Memory = safeRequire("./CitizenMemory");

// === Moneyfolk types ===
const MONEYFOLK_CHANGER = "money-changer";
const MONEYFOLK_SORTER = "coin-sorter";
const MONEYFOLK_LENDER = "market-lender";
const MONEYFOLK_PAWN = "pawnbroker";
const MONEYFOLK_TYPES = [
  MONEYFOLK_CHANGER,
  MONEYFOLK_SORTER,
  MONEYFOLK_LENDER,
  MONEYFOLK_PAWN,
];
const MONEYFOLK_WEIGHTS = {
  [MONEYFOLK_CHANGER]: 30,
  [MONEYFOLK_SORTER]: 25,
  [MONEYFOLK_LENDER]: 25,
  [MONEYFOLK_PAWN]: 20,
};

// === Street pitches: open corners at market edges, distinct from the bank
// buildings and the anchored stalls ===
const MONEY_PITCHES = [
  { name: "the Varrock market arch", kingdom: "misthalin" },
  { name: "the Lumbridge bridge gate", kingdom: "misthalin" },
  { name: "the Falador bazaar row", kingdom: "asgarnia" },
  { name: "the Rimmington dock gate", kingdom: "asgarnia" },
  { name: "the Ardougne coin row", kingdom: "kandarin" },
  { name: "the Hemenster fountain steps", kingdom: "kandarin" },
  { name: "the Keldagrim forge court", kingdom: "keldagrim" },
  { name: "the Dorgesh market nook", kingdom: "keldagrim" },
  { name: "the Darkmeyer night market", kingdom: "morytania" },
  { name: "the Al Kharid silk bazaar", kingdom: "kharidian" },
];

// === Foreign coins the changers trade ===
const FOREIGN_COINS = [
  "Kharidian dinars",
  "Misthalini nobles",
  "Asgarnian crowns",
  "Kandarin royals",
  "Keldagrim mint-stamps",
  "Morytanian bloodmarks",
];

// === Coin types changers assay ===
const ASSAY_COINS = [
  "a gold sovereign",
  "a silver noble",
  "a brass farthing",
  "a Kharidian dinar",
  "a Keldagrim mint-stamp",
];

// === Daily jobs coin-sorters are hired for ===
const COUNT_JOBS = [
  "the temple tithe",
  "the tavern takings",
  "the gate tolls",
  "the ferry fares",
  "the bazaar rents",
];

// === Items pawnbrokers lend against ===
const PAWN_ITEMS = [
  "a silver locket",
  "a brass compass",
  "a carving knife",
  "a wool cloak",
  "a copper kettle",
  "a set of tools",
  "a wedding band",
  "a fishing rod",
];

// === Scripted lines ===
const PITCH_LINES = [
  "Coins changed here! {coin} to honest coin, fair weight, no waiting!",
  "Foreign coin? I'll assay it and name you a rate — {rate} today!",
  "The bank has forms and queues. I have a table and a scale — {coin} at {rate}!",
  "Don't be short-changed at the gate — change your {coin} here at {rate}!",
];

const ASSAY_LINES = [
  "*bites the coin* {coin}, {verdict}!",
  "{verdict} — this {coin} is {weight}. Fair's fair, I'll name it true.",
  "I've seen cleaner — {coin}, {verdict}, and I'll still give you {rate}.",
];

const COUNT_LINES = [
  "Counting the day's takings.",
  "Just tallying up.",
  "Coins stacked neat.",
  "Balancing the books.",
];

const LOAN_LINES = [
  "Need a brass note, {player}? Quick coin, no bank forms, three days to pay.",
  "Short on coin, {player}? The market lenders always have a note ready.",
  "Brass notes here — small, quick, and I don't ask what it's for.",
  "The bank wants your name and your grandmother's. I just want it back in three days.",
];

const COLLECT_LINES = [
  "{player}! Your brass note is due — {owed} coins, and I'm not the bank: I remember faces.",
  "Three days are up, {player}. {owed} coins, and no hard feelings if you pay it now.",
  "{player} — the note you took? {owed} coins. The market remembers who pays.",
];

const PAWN_LINES = [
  "Pawning {item}? I'll lend against it — seven days to buy it back.",
  "Bring me {item} and I'll name a price. Seven days, then it's mine to sell.",
  "Pawnbroking's an honest trade: your {item} for my coin, seven days grace.",
];

const REDEEM_LINES = [
  "{player} — your {item} is still on my shelf. Come buy it back before the week is out!",
  "That {item} of yours, {player}? Seven days is nearly up. Don't lose it.",
];

const BANK_HOUR_LINES = [
  "The bank's shut — but I'm quicker anyway.",
  "Banks keep hours. Coin doesn't.",
  "The bank has its vault; I have my wits. Who needs the vault?",
];

const BANK_OPEN_LINES = [
  "The bank's open, aye — but my rate beats the queue.",
  "Take it to {bank} if you like forms. Or stay, and keep the morning.",
];

const DAILY_TASK_LINES = {
  [MONEYFOLK_CHANGER]: [
    "quoting rates for foreign coin",
    "assaying suspicious sovereigns",
    "polishing the brass scale",
    "chalking today's rates on the board",
  ],
  [MONEYFOLK_SORTER]: [
    "counting the temple tithe",
    "weighing the gate tolls",
    "stacking the day's takings",
    "auditing a merchant's purse",
  ],
  [MONEYFOLK_LENDER]: [
    "writing brass notes",
    "reminding debtors, gently",
    "checking who's good for it",
    "tallying the week's notes",
  ],
  [MONEYFOLK_PAWN]: [
    "tagging new pawns",
    "dusting the pawn shelf",
    "pricing an unclaimed lot",
    "oiling a repossessed hinge",
  ],
};

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Ledgers (TTL'd) ===
const microLoans = new Map(); // normPlayerName -> { loan }
const pawnTickets = new Map(); // normPlayerName -> { ticket }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of microLoans) {
    if (v.loan.until <= nowMs) microLoans.delete(k);
  }
  for (const [k, v] of pawnTickets) {
    if (v.ticket.until <= nowMs) pawnTickets.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** Weighted pick of a moneyfolk type from a 0..99 roll. */
function moneyfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of MONEYFOLK_TYPES) {
    acc += MONEYFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return MONEYFOLK_CHANGER;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during work hours (07:00-21:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
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

/** True when the player object is a citizen bot. */
function isCitizenBot(player) {
  try {
    return player?.isPlayerBot?.() === true || player?.getHostAddress?.() === "bot";
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

/** Cheap rng from a seed (mulberry-ish LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

/** Normalized username via CitizenBonds (fallback: lowercase). */
function normalizeName(name) {
  try {
    if (Bonds && typeof Bonds.normalizeName === "function") return Bonds.normalizeName(name);
  } catch { /* fall through */ }
  return String(name ?? "").toLowerCase();
}

// ============================================================================
// Moneyfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The moneyfolk type for a roster record, or null.
 * Excludes the professional trade (the real CitizenBankers.bankerTypeFor —
 * it has a null path via the primary-profession partition, so it is a
 * valid eligibility gate). Uses name-first salts to avoid the FNV-1a
 * prefix-correlation bug.
 */
function moneyfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the professional trade owns the banks.
    if (ProBankers && typeof ProBankers.bankerTypeFor === "function") {
      try {
        if (ProBankers.bankerTypeFor(record.username)) return null;
      } catch { /* banker check failed */ }
    }
    const roll = hashStr(name + "|moneyfolk") % 100;
    if (roll >= MONEYFOLK_SHARE) return null;
    return moneyfolkTypeFromRoll(hashStr(name + "|moneyfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred street-pitch assignment, stable across restarts. */
function pitchFor(record) {
  const kid = record?.kingdomId ?? record?.kingdom;
  const local = MONEY_PITCHES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : MONEY_PITCHES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|moneyfolk-pitch") % pool.length];
}

/** Today's exchange rate quote for a money-changer (stable per day). */
function rateForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|moneyfolk-rate:" + day));
  const coin = pickOne(rng, FOREIGN_COINS);
  // The changer's cut is baked in: 3-7 foreign units per 10 local coins.
  const units = 3 + Math.floor(rng() * 5);
  return { coin, rate: `${units} ${coin.toLowerCase()} to 10 coins` };
}

/** Today's featured pawn item for a pawnbroker (stable per day). */
function pawnItemForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|moneyfolk-pawn:" + day));
  return pickOne(rng, PAWN_ITEMS);
}

/** Today's counting job for a coin-sorter (stable per day). */
function countJobForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|moneyfolk-count:" + day));
  return pickOne(rng, COUNT_JOBS);
}

/** Today's task for a moneyfolk citizen (1 task of the day). */
function taskForToday(username, type, dateMs) {
  const tasks = DAILY_TASK_LINES[type] ?? DAILY_TASK_LINES[MONEYFOLK_CHANGER];
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|moneyfolk-task:" + day));
  return pickOne(rng, tasks);
}

/**
 * A deterministic coin appraisal — what a changer would say about the
 * given coin today. Stable per coin+day; the LLM dialogue tier performs
 * appraisals with this.
 */
function appraisalOf(coinDesc, dateMs) {
  const coin = String(coinDesc ?? "").slice(0, 60) || "a gold sovereign";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(coin.toLowerCase() + "|moneyfolk-appraisal:" + day));
  const roll = rng();
  if (roll < 0.7) {
    return { verdict: "genuine weight", weight: "full weight", coin };
  }
  if (roll < 0.9) {
    return { verdict: "clipped — short by a hair", weight: "light by a hair", coin };
  }
  return { verdict: "counterfeit — brass under the wash", weight: "false through", coin };
}

/**
 * Today's assay alert at a pitch (~8%/day), or null: a changer caught a
 * bad coin in the wild. Journaled + rumor-seeded by dailyRhythms.
 */
function assayAlertFor(pitch, dateMs) {
  if (!pitch?.name) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(pitch.name + "|assay-alert:" + day));
  if (rng() >= ASSAY_ALERT_CHANCE) return null;
  const coin = pickOne(rng, ASSAY_COINS);
  const bad = rng() < 0.5 ? "clipped" : "counterfeit";
  return { coin, bad };
}

/**
 * Today's lending rush for a kingdom (~8%/day), or null: market lenders
 * shout special terms. Journaled + rumor-seeded by dailyRhythms.
 */
function lendingRushFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|lending-rush:" + day));
  if (rng() >= LENDING_RUSH_CHANCE) return null;
  return true;
}

// ============================================================================
// Real-data bridges — the formal banks, cross-read from CitizenBankers.
// ============================================================================

/** The nearest formal bank for flavor lines (real pro data). */
function nearestBankFor(record) {
  try {
    if (ProBankers && typeof ProBankers.bankFor === "function") {
      const b = ProBankers.bankFor(record?.username, record?.kingdom ?? record?.kingdomId);
      return b?.name ?? "the bank";
    }
  } catch { /* pro absent */ }
  return "the bank";
}

/** True while the formal banks are open (real pro hours, 08:00-20:00). */
function banksOpenAt(dateMs) {
  try {
    if (ProBankers && typeof ProBankers.banksOpenAt === "function") {
      return ProBankers.banksOpenAt(new Date(dateMs).getHours());
    }
  } catch { /* pro absent */ }
  return false;
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Whole coins owed on a brass note at 20% street interest. */
function microLoanOwedFor(amount) {
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  return a + Math.floor((a * MICROLOAN_INTEREST_BPS) / 10000);
}

/** A market lender writes a player a brass note (7d TTL on the record). */
function offerMicroLoan(playerName, lenderName, amount, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const lender = String(lenderName ?? "").slice(0, 40);
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  if (!name || !lender || a < MICROLOAN_MIN || a > MICROLOAN_MAX) return null;
  pruneLedgers(nowMs);
  const rec = {
    loan: {
      player: String(playerName),
      lender,
      amount: a,
      owed: microLoanOwedFor(a),
      dueAt: nowMs + MICROLOAN_TERM_MS,
      takenAt: nowMs,
      until: nowMs + MICROLOAN_TTL_MS,
    },
  };
  microLoans.set(name, rec);
  return rec.loan;
}

/** The player's outstanding brass note, or null. */
function microLoanFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = microLoans.get(name);
  if (!rec || rec.loan.until <= nowMs) return null;
  return { ...rec.loan };
}

/** True when the brass note is past its 3-day term. */
function microLoanOverdue(loan, nowMs = Date.now()) {
  if (!loan) return false;
  return nowMs > loan.dueAt;
}

/** The player pays off their brass note (deletes the record). */
function repayMicroLoan(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return microLoans.delete(name);
}

/** A pawnbroker takes an item as collateral (7d TTL on the ticket). */
function pawnItem(playerName, brokerName, item, amount, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const broker = String(brokerName ?? "").slice(0, 40);
  const i = String(item ?? "").slice(0, 60);
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  if (!name || !broker || !i || a < PAWN_MIN) return null;
  pruneLedgers(nowMs);
  const rec = {
    ticket: {
      player: String(playerName),
      broker,
      item: i,
      amount: a,
      dueAt: nowMs + PAWN_TERM_MS,
      takenAt: nowMs,
      until: nowMs + PAWN_TTL_MS,
    },
  };
  pawnTickets.set(name, rec);
  return rec.ticket;
}

/** The player's outstanding pawn ticket, or null. */
function pawnTicketFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = pawnTickets.get(name);
  if (!rec || rec.ticket.until <= nowMs) return null;
  return { ...rec.ticket };
}

/** True when the pawn ticket is past its 7-day redemption term. */
function pawnForfeited(ticket, nowMs = Date.now()) {
  if (!ticket) return false;
  return nowMs > ticket.dueAt;
}

/** The player buys back their pawned item (deletes the ticket). */
function redeemPawn(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return pawnTickets.delete(name);
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

function journalize(citizen, text) {
  try {
    if (Journal && typeof Journal.appendEntry === "function") {
      Journal.appendEntry(citizen, text);
    } else if (Journal && typeof Journal.addEntry === "function") {
      Journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(text) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor(text);
  } catch { /* rumors absent */ }
}

/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → moneyfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickMoneyfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < MONEYFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible moneyfolk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be moneyfolk (hash-derived, cheap; exclusions inside)
        const type = moneyfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. Street hours only
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, MONEYFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, MONEYFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doMoneyfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-moneyfolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: assay alerts and lending rushes (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-moneyfolk] tick failed:", e?.message ?? e);
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

function doMoneyfolkWork(director, record, citizen, type, nowMs) {
  const pitch = pitchFor(record);
  const name = normalizeName(record.username);

  // A nearby player's overdue brass note takes priority for lenders.
  if (type === MONEYFOLK_LENDER) {
    const debtor = nearbyDebtor(director, citizen, nowMs);
    if (debtor) {
      const loan = microLoanFor(debtor.name, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, COLLECT_LINES), {
        player: debtor.name,
        owed: loan ? String(loan.owed) : "the coins you owe",
      }));
      journalize(citizen, `pressed a debtor for an overdue brass note at ${pitch.name}`);
      return;
    }
  }

  // A nearby player's pawn ticket takes priority for pawnbrokers.
  if (type === MONEYFOLK_PAWN) {
    const holder = nearbyPawnHolder(director, citizen, nowMs);
    if (holder && Math.random() < 0.5) {
      const ticket = pawnTicketFor(holder, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, REDEEM_LINES), {
        player: holder,
        item: ticket ? ticket.item : "your goods",
      }));
      journalize(citizen, `reminded a customer about their pawn at ${pitch.name}`);
      return;
    }
  }

  if (type === MONEYFOLK_CHANGER) {
    const q = rateForToday(name, nowMs);
    const roll = Math.random();
    if (roll < 0.55) {
      forceSay(citizen, fill(pickOne(Math.random, PITCH_LINES), { coin: q.coin, rate: q.rate }));
      journalize(citizen, `pitched coin exchange at ${pitch.name}`);
    } else if (roll < 0.75 && !banksOpenAt(nowMs)) {
      forceSay(citizen, pickOne(Math.random, BANK_HOUR_LINES));
      journalize(citizen, `worked the pitch while the banks were shut at ${pitch.name}`);
    } else if (roll < 0.9 && banksOpenAt(nowMs)) {
      forceSay(citizen, fill(pickOne(Math.random, BANK_OPEN_LINES), { bank: nearestBankFor(record) }));
      journalize(citizen, `baited bank-bound customers at ${pitch.name}`);
    } else {
      const a = appraisalOf(q.coin, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, ASSAY_LINES), {
        coin: a.coin,
        verdict: a.verdict,
        weight: a.weight,
        rate: q.rate,
      }));
      journalize(citizen, `assayed coin for a traveler at ${pitch.name}`);
    }
    return;
  }

  if (type === MONEYFOLK_SORTER) {
    const job = countJobForToday(name, nowMs);
    if (Math.random() < 0.6) {
      forceSay(citizen, pickOne(Math.random, COUNT_LINES));
    } else {
      forceSay(citizen, fill(pickOne(Math.random, [
        "Counted and true — {job}, not a coin missing.",
        "{job} done to the last coin. Anyone else need a counter?",
        "I'll count your takings for a small fee — did {job} this morning.",
      ]), { job }));
    }
    journalize(citizen, `${taskForToday(name, type, nowMs)} at ${pitch.name}`);
    return;
  }

  if (type === MONEYFOLK_LENDER) {
    const rush = lendingRushFor(record?.kingdomId ?? record?.kingdom, nowMs);
    const line = pickOne(Math.random, LOAN_LINES);
    const np = nearbyPlayerName(director, citizen);
    forceSay(citizen, rush ? line.replace("{player}", "friend — rush terms today") : fill(line, { player: np || "friend" }));
    journalize(citizen, `offered brass notes${rush ? " on a lending-rush day" : ""} at ${pitch.name}`);
    return;
  }

  // Pawnbroker: featured item pitches.
  const item = pawnItemForToday(name, nowMs);
  forceSay(citizen, fill(pickOne(Math.random, PAWN_LINES), { item }));
  journalize(citizen, `pitched pawnbroking at ${pitch.name}`);
}

/** A nearby real player with an overdue brass note, if any. */
function nearbyDebtor(director, citizen, nowMs) {
  try {
    for (const p of director.onlinePlayers?.() ?? []) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, MONEYFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) continue;
      const loan = microLoanFor(pname, nowMs);
      if (loan && microLoanOverdue(loan, nowMs)) return { name: pname, loan };
    }
  } catch { /* best effort */ }
  return null;
}

/** A nearby real player holding a pawn ticket, if any (returns the name). */
function nearbyPawnHolder(director, citizen, nowMs) {
  try {
    for (const p of director.onlinePlayers?.() ?? []) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, MONEYFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (pname && pawnTicketFor(pname, nowMs)) return pname;
    }
  } catch { /* best effort */ }
  return null;
}

/** Name of any nearby real player, for offer lines. */
function nearbyPlayerName(director, citizen) {
  try {
    for (const p of director.onlinePlayers?.() ?? []) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, MONEYFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (pname) return pname;
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day pitch/kingdom rhythms: assay alerts and lending rushes. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  try {
    for (const pitch of MONEY_PITCHES) {
      const alert = assayAlertFor(pitch, nowMs);
      if (!alert) continue;
      const key = "assay-alert:" + pitch.name + ":" + day;
      if (lastFiredByCitizen.has(key)) continue;
      lastFiredByCitizen.set(key, nowMs);
      const line = `${alert.coin} found ${alert.bad} at ${pitch.name} — the changers are biting every coin today.`;
      journalize({ username: pitch.name }, line);
      seedRumor(line);
    }
    const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
    for (const kid of kingdoms) {
      if (!lendingRushFor(kid, nowMs)) continue;
      const key = "lending-rush:" + kid + ":" + day;
      if (lastFiredByCitizen.has(key)) continue;
      lastFiredByCitizen.set(key, nowMs);
      const pitch = (MONEY_PITCHES.filter((v) => v.kingdom === kid)[0] ?? MONEY_PITCHES[0]).name;
      const line = `Lending rush in ${kid}! The market lenders at ${pitch} are writing brass notes on easy terms.`;
      journalize({ username: "the moneyfolk" }, line);
      seedRumor(line);
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickMoneyfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  moneyfolkTypeOf,
  pitchFor,
  rateForToday,
  pawnItemForToday,
  countJobForToday,
  taskForToday,
  appraisalOf,
  assayAlertFor,
  lendingRushFor,
  nearestBankFor,
  banksOpenAt,
  offerMicroLoan,
  microLoanFor,
  microLoanOverdue,
  repayMicroLoan,
  microLoanOwedFor,
  pawnItem,
  pawnTicketFor,
  pawnForfeited,
  redeemPawn,
  nearbyDebtor,
  nearbyPawnHolder,
  nearbyPlayerName,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  moneyfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  MONEYFOLK_TYPES,
  MONEYFOLK_CHANGER,
  MONEYFOLK_SORTER,
  MONEYFOLK_LENDER,
  MONEYFOLK_PAWN,
  MONEY_PITCHES,
  // Tuning (tests pin the documented behavior):
  MONEYFOLK_RADIUS,
  MONEYFOLK_CITIZEN_COOLDOWN_MS,
  MONEYFOLK_CHANCE,
  MONEYFOLK_SHARE,
  ASSAY_ALERT_CHANCE,
  LENDING_RUSH_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  MICROLOAN_TTL_MS,
  MICROLOAN_INTEREST_BPS,
  MICROLOAN_TERM_MS,
  MICROLOAN_MIN,
  MICROLOAN_MAX,
  PAWN_TTL_MS,
  PAWN_TERM_MS,
  PAWN_MIN,
  FOREIGN_COINS,
  ASSAY_COINS,
  COUNT_JOBS,
  PAWN_ITEMS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    microLoans.clear();
    pawnTickets.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
