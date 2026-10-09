"use strict";

/**
 * CitizenTradeGuilds — the merchants' association (guild operations layer).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Associations: one per kingdom, hall tile near the market anchor, real
 *     tracked treasury + trade-fair fund.
 *   - Membership: peddler -> trader -> merchantmaster. Joining requires REAL
 *     trader status (CitizenGuilds merchants-guild member, trader career,
 *     market-stall history, or caravan trader — the guild polices the trade,
 *     never mints traders). Weekly 25-coin real dues (5 feeds the fair fund);
 *     2 missed online collections suspend; offline members skipped, never
 *     penalized.
 *   - Standards code: read-only 5-point code of honest trade.
 *   - Weights & measures inspections: merchantmaster inspectors check stall
 *     wares against real reference prices. Price > 3x reference = gouging
 *     violation. Findings are journaled; violations feed the tribunal.
 *   - Market licenses: 30-day license for 100 real coins. Trading from a
 *     stall without one is the verifiable "unlicensed trading" offense.
 *   - Caravan manifest certification: members in good standing certify (7
 *     days); certified leaders earn +3% caravan profit via certifiedBonusFor,
 *     read defensively by CitizenTradeCaravans.settleCaravan (same pattern
 *     as the CitizenTreaties trade bonus — additive, no double-count).
 *   - Trade fairs: quarterly per kingdom; stallholders pay real entry fees;
 *     the fairest-priced licensed stall wins a real prize from the fair fund.
 *   - Merchant school: merchantmaster masters teach peddlers (credits);
 *     promotions are tenure + credits + inspections, all verifiable.
 *   - Tribunal: the two verifiable trade crimes are unlicensed trading and
 *     price gouging. Merchantmasters vote; 24h auto-settle; guilty
 *     unlicensed -> 100-coin fine (owed honestly) + 7-day suspension;
 *     guilty gouging -> expulsion + `profiteer` fame deed.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Dues, inspections, tribunal settlement, fairs, and
 *     school live in lib/CitizenTradeGuildLife.js.
 *   - No LLM. Journaled facts only.
 *   - No invented money: every coin movement is real (inventories) or
 *     honestly tracked (treasury / fair-fund ledgers).
 *   - Never touches lib/*2 (frozen).
 *
 * No-overlap boundary:
 *   - CitizenGuilds owns generic trade guilds incl. the merchants guild
 *     (membership/ranks/missions/rivalry/training bonus) — read-only here
 *     as one join-gating path.
 *   - CitizenTradeCharters owns monopoly charters/tolls (we never read or
 *     write charters).
 *   - CitizenTradeCaravans owns caravan operations (we only expose the
 *     certification bonus number; settleCaravan reads it defensively).
 *   - CitizenMarketStalls owns stall setup/sales (we only read the published
 *     wares attribute and referencePrice for inspections).
 *
 * Persisted to data/saves/citizen-tradeguilds.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-tradeguilds.json";
const COINS_ID = 995;

const RANK_PEDDLER = "peddler";
const RANK_TRADER = "trader";
const RANK_MASTER = "merchantmaster";
const RANKS = Object.freeze([RANK_PEDDLER, RANK_TRADER, RANK_MASTER]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_FAIR_SHARE = 5; // of each dues payment, this much feeds the fair fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2; // missed online collections before suspension

const LICENSE_FEE = 100; // real coins
const LICENSE_MS = 30 * 24 * 60 * 60 * 1000; // 30-day market license

const GOUGING_RATIO = 3; // price > 3x reference = gouging violation

const CERT_MS = 7 * 24 * 60 * 60 * 1000; // manifest certification validity
const CERT_BONUS = 0.03; // +3% caravan profit for certified leaders

const FAIR_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly trade fair
const FAIR_ENTRY_FEE = 50; // real coins per stallholder
const FAIR_PRIZE = 500; // real coins from the fair fund

const FINE_UNLICENSED = 100; // real coins, owed honestly when broke
const SUSPEND_UNLICENSED_MS = 7 * 24 * 60 * 60 * 1000;

const CASE_SETTLE_MS = 24 * 60 * 60 * 1000; // auto-settle open cases after 24h

const PROMOTE_TRADER_DAYS = 30;
const PROMOTE_TRADER_CREDITS = 2;
const PROMOTE_MASTER_DAYS = 60;
const PROMOTE_MASTER_CREDITS = 4;
const PROMOTE_MASTER_INSPECTIONS = 3;

const HALL_TILE_DX = 5; // guild hall sits a few tiles from the market anchor

const STANDARDS_CODE = Object.freeze([
  "Weigh true and measure full: no short weights, no hollow measures.",
  "Price honestly: no ware above three times its fair reference price.",
  "Trade licensed: no stall without a guild market license.",
  "Deal fairly with caravan partners: manifests true, shares paid.",
  "Keep the guild's peace: no member undercuts another by deceit.",
]);

// === Persistence (dirty-flag) ===
let savePathOverride = null;
let state = null;
let dirty = false;

function blankState() {
  return { version: 1, guilds: {} };
}

function norm(name) {
  try {
    return normalizeName(name);
  } catch {
    return String(name || "").toLowerCase();
  }
}

function savePath() {
  if (savePathOverride) return savePathOverride;
  return path.join(__dirname, "..", "..", "data", "saves", SAVE_KEY);
}

function load() {
  if (state) return state;
  state = blankState();
  try {
    const raw = fs.readFileSync(savePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.guilds) state = parsed;
  } catch {
    // first run — start blank
  }
  return state;
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(savePath()), { recursive: true });
    fs.writeFileSync(savePath(), JSON.stringify(load(), null, 2), "utf8");
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  state = null; // next load() re-reads from disk (blank when no file)
  dirty = false;
}

function _setSavePathForTests(p) {
  savePathOverride = p;
}

let idCounter = 0;
function allocId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

// === Engine seams (all defensive) ===
function sitesApi() {
  try { return require("../brain/CitizenSites"); } catch { return null; }
}

function kingdomIds() {
  try {
    const S = sitesApi();
    if (S && Array.isArray(S.KINGDOM_IDS) && S.KINGDOM_IDS.length) return S.KINGDOM_IDS.slice();
  } catch { /* fall through */ }
  return [];
}

function hallTileFor(kingdomId) {
  try {
    const S = sitesApi();
    const market = S && typeof S.siteTile === "function" ? S.siteTile(kingdomId, "market") : null;
    if (market && Number.isFinite(market.x)) {
      return { x: market.x + HALL_TILE_DX, y: market.y, z: market.z ?? 0 };
    }
  } catch { /* fall through */ }
  return null;
}

// === Guild records ===
function blankGuild(kingdomId) {
  return {
    kingdomId,
    foundedAtMs: Date.now(),
    treasury: 0, // honestly tracked coins
    fairFund: 0, // honestly tracked coins
    members: {}, // normName -> member record
    licenses: {}, // normName -> { licensedUntilMs }
    inspections: [], // [{ id, atMs, inspector, stallholder, pass, violations }]
    certifications: {}, // normName -> { certifiedUntilMs }
    fairs: [], // [{ id, atMs, entries: [names], winner, prizePaid }]
    lastFairAtMs: 0,
    cases: {}, // caseId -> tribunal case
    classes: [], // [{ atMs, master, taught }]
  };
}

function ensureGuild(kingdomId) {
  const st = load();
  if (!st.guilds[kingdomId]) {
    st.guilds[kingdomId] = blankGuild(kingdomId);
    markDirty();
  }
  return st.guilds[kingdomId];
}

function guildOf(kingdomId) {
  const st = load();
  return st.guilds[kingdomId] || null;
}

function guildTreasuryFor(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? g.treasury : 0;
}

function fairFundFor(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? g.fairFund : 0;
}

function creditTreasury(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  g.treasury = Math.max(0, (g.treasury || 0) + Math.floor(amount));
  markDirty();
}

function debitTreasury(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  const have = g.treasury || 0;
  const take = Math.min(have, Math.floor(amount));
  g.treasury = have - take;
  markDirty();
  return take;
}

function creditFairFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  g.fairFund = Math.max(0, (g.fairFund || 0) + Math.floor(amount));
  markDirty();
}

function debitFairFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  const have = g.fairFund || 0;
  const take = Math.min(have, Math.floor(amount));
  g.fairFund = have - take;
  markDirty();
  return take;
}

// === Membership ===
function memberOf(username) {
  const key = norm(username);
  const st = load();
  for (const kid of Object.keys(st.guilds)) {
    const m = st.guilds[kid].members[key];
    if (m) return { ...m, kingdomId: kid };
  }
  return null;
}

function isGuildMember(username) {
  return !!memberOf(username);
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

/**
 * Join gating: the caller proves REAL trader status. At least one proof path
 * must be true. The association polices the trade — it never mints traders.
 * proof = { guildMember, traderCareer, stallholder, caravanTrader }
 */
function canJoinWithProof(proof) {
  if (!proof || typeof proof !== "object") return false;
  return !!(proof.guildMember || proof.traderCareer || proof.stallholder || proof.caravanTrader);
}

function joinGuild(kingdomId, username, proof, nowMs = Date.now()) {
  const key = norm(username);
  if (!key) return { ok: false, reason: "no-name" };
  if (memberOf(username)) return { ok: false, reason: "already-member" };
  if (!canJoinWithProof(proof)) return { ok: false, reason: "not-a-trader" };
  const g = ensureGuild(kingdomId);
  g.members[key] = {
    username: key,
    rank: RANK_PEDDLER,
    joinedAtMs: nowMs,
    duesPaidUntilMs: nowMs + DUES_PERIOD_MS, // first week included
    missedDues: 0,
    suspended: false,
    suspendedUntilMs: 0,
    trainingCredits: 0,
    inspectionsConducted: 0,
    finesOwed: 0,
  };
  markDirty();
  return { ok: true, rank: RANK_PEDDLER };
}

function leaveGuild(username) {
  const key = norm(username);
  const st = load();
  for (const kid of Object.keys(st.guilds)) {
    if (st.guilds[kid].members[key]) {
      delete st.guilds[kid].members[key];
      markDirty();
      return { ok: true };
    }
  }
  return { ok: false, reason: "not-a-member" };
}

function recordDuesPayment(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return { ok: false };
  const g = guildOf(m.kingdomId);
  const rec = g.members[norm(username)];
  rec.duesPaidUntilMs = nowMs + DUES_PERIOD_MS;
  rec.missedDues = 0;
  if (rec.suspended && (rec.suspendedUntilMs || 0) <= nowMs) rec.suspended = false;
  creditTreasury(m.kingdomId, DUES_WEEKLY - DUES_FAIR_SHARE);
  creditFairFund(m.kingdomId, DUES_FAIR_SHARE);
  markDirty();
  return { ok: true };
}

function recordMissedDues(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return { ok: false };
  const g = guildOf(m.kingdomId);
  const rec = g.members[norm(username)];
  rec.missedDues = (rec.missedDues || 0) + 1;
  if (rec.missedDues >= SUSPEND_AFTER_MISSED) rec.suspended = true;
  markDirty();
  return { ok: true, suspended: !!rec.suspended };
}

// === Market licenses ===
function licenseFor(username, nowMs = Date.now()) {
  const key = norm(username);
  const st = load();
  for (const kid of Object.keys(st.guilds)) {
    const lic = st.guilds[kid].licenses[key];
    if (lic && (lic.licensedUntilMs || 0) > nowMs) return { ...lic, kingdomId: kid, valid: true };
  }
  return { valid: false };
}

function buyLicense(kingdomId, username, nowMs = Date.now()) {
  // The caller takes the REAL coins from the buyer's inventory; this records
  // the license and credits the treasury honestly.
  const key = norm(username);
  if (!key) return { ok: false, reason: "no-name" };
  const g = ensureGuild(kingdomId);
  g.licenses[key] = { licensedUntilMs: nowMs + LICENSE_MS, boughtAtMs: nowMs };
  creditTreasury(kingdomId, LICENSE_FEE);
  markDirty();
  return { ok: true, licensedUntilMs: nowMs + LICENSE_MS };
}

// === Weights & measures inspections (pure: wares + price lookup in) ===
function inspectWares(wares, priceFor) {
  const violations = [];
  let worstRatio = 0;
  const list = Array.isArray(wares) ? wares : [];
  for (const w of list) {
    const id = Math.floor(Number(w && w.id));
    const price = Math.floor(Number(w && w.price));
    if (!(id > 0) || !(price > 0)) continue;
    let ref = 1;
    try {
      ref = Math.max(1, Math.floor(Number(priceFor(id)) || 1));
    } catch {
      ref = 1;
    }
    const ratio = price / ref;
    if (ratio > worstRatio) worstRatio = ratio;
    if (ratio > GOUGING_RATIO) {
      violations.push({ id, price, ref, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return { pass: violations.length === 0, violations, worstRatio: Math.round(worstRatio * 100) / 100, checked: list.length };
}

function recordInspection(kingdomId, inspector, stallholder, result, nowMs = Date.now()) {
  const g = ensureGuild(kingdomId);
  const rec = {
    id: allocId("insp"),
    atMs: nowMs,
    inspector: norm(inspector),
    stallholder: norm(stallholder),
    pass: !!result.pass,
    violations: result.violations || [],
    worstRatio: result.worstRatio || 0,
    checked: result.checked || 0,
  };
  g.inspections.push(rec);
  if (g.inspections.length > 200) g.inspections = g.inspections.slice(-200);
  const im = g.members[norm(inspector)];
  if (im) im.inspectionsConducted = (im.inspectionsConducted || 0) + 1;
  markDirty();
  return rec;
}

function inspectionsFor(stallholder) {
  const key = norm(stallholder);
  const out = [];
  const st = load();
  for (const kid of Object.keys(st.guilds)) {
    for (const r of st.guilds[kid].inspections) {
      if (r.stallholder === key) out.push({ ...r, kingdomId: kid });
    }
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

// === Caravan manifest certification ===
function certifyManifest(kingdomId, username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m || m.suspended) return { ok: false, reason: "not-member-standing" };
  const g = ensureGuild(kingdomId);
  g.certifications[norm(username)] = { certifiedUntilMs: nowMs + CERT_MS, atMs: nowMs };
  markDirty();
  return { ok: true, certifiedUntilMs: nowMs + CERT_MS };
}

/**
 * Caravan profit bonus for certified manifest leaders. Read defensively by
 * CitizenTradeCaravans.settleCaravan (same pattern as the treaties bonus).
 * Returns 0.03 when the caravan leader is a guild member in good standing
 * with a valid manifest certification, else 0.
 */
function certifiedBonusFor(caravan, nowMs = Date.now()) {
  try {
    const leader = norm(caravan && caravan.leader);
    if (!leader) return 0;
    const m = memberOf(caravan.leader);
    if (!m || m.suspended) return 0;
    const g = guildOf(m.kingdomId);
    const cert = g && g.certifications[leader];
    if (!cert || (cert.certifiedUntilMs || 0) <= nowMs) return 0;
    return CERT_BONUS;
  } catch {
    return 0;
  }
}

// === Trade fairs ===
function fairDue(kingdomId, nowMs = Date.now()) {
  const g = guildOf(kingdomId);
  if (!g) return true;
  return nowMs - (g.lastFairAtMs || 0) >= FAIR_PERIOD_MS;
}

function enterFair(kingdomId, username) {
  // The caller takes the REAL entry fee from the entrant's inventory.
  const key = norm(username);
  if (!key) return { ok: false, reason: "no-name" };
  const g = ensureGuild(kingdomId);
  let fair = g.fairs[g.fairs.length - 1];
  if (!fair || fair.resolved) {
    fair = { id: allocId("fair"), atMs: Date.now(), entries: [], winner: null, prizePaid: 0, resolved: false };
    g.fairs.push(fair);
  }
  if (!fair.entries.includes(key)) fair.entries.push(key);
  creditFairFund(kingdomId, FAIR_ENTRY_FEE);
  markDirty();
  return { ok: true, fairId: fair.id };
}

/**
 * Resolve the fair: winner = licensed stallholder with a passing inspection
 * and the fairest (lowest worst-ratio) prices. Prize from the fair fund;
 * owed honestly when the fund is short.
 */
function resolveFair(kingdomId, stallReaders, nowMs = Date.now()) {
  const g = ensureGuild(kingdomId);
  const fair = g.fairs[g.fairs.length - 1];
  if (!fair || fair.resolved || fair.entries.length === 0) return { ok: false, reason: "no-fair" };
  let best = null;
  for (const name of fair.entries) {
    if (!licenseFor(name, nowMs).valid) continue;
    const insp = inspectionsFor(name)[0];
    if (!insp || !insp.pass) continue;
    if (!best || (insp.worstRatio || 0) < (best.ratio || Infinity)) {
      best = { name, ratio: insp.worstRatio || 0 };
    }
  }
  fair.resolved = true;
  g.lastFairAtMs = nowMs;
  if (!best) {
    markDirty();
    return { ok: true, winner: null, reason: "no-eligible-stall" };
  }
  const paid = debitFairFund(kingdomId, FAIR_PRIZE);
  fair.winner = best.name;
  fair.prizePaid = paid;
  fair.prizeOwed = Math.max(0, FAIR_PRIZE - paid);
  markDirty();
  return { ok: true, winner: best.name, prizePaid: paid, prizeOwed: fair.prizeOwed };
}

// === Tribunal ===
const CASE_UNLICENSED = "unlicensed";
const CASE_GOUGING = "gouging";

function reportMisconduct(kingdomId, accused, kind, reporter, evidence) {
  const key = norm(accused);
  if (!key) return { ok: false, reason: "no-name" };
  if (kind !== CASE_UNLICENSED && kind !== CASE_GOUGING) return { ok: false, reason: "bad-kind" };
  const g = ensureGuild(kingdomId);
  // No double jeopardy: one open case per accused+kind.
  for (const id of Object.keys(g.cases)) {
    const c = g.cases[id];
    if (c.accused === key && c.kind === kind && c.status === "open") {
      return { ok: false, reason: "already-open" };
    }
  }
  // Verify against real data at report time.
  if (kind === CASE_UNLICENSED) {
    // evidence.stallActive must be true (caller saw real wares).
    if (!evidence || evidence.stallActive !== true) return { ok: false, reason: "no-evidence" };
    if (licenseFor(accused, Date.now()).valid) return { ok: false, reason: "licensed" };
  }
  if (kind === CASE_GOUGING) {
    // evidence.violation must be a real recorded inspection violation.
    const insp = inspectionsFor(accused).find((r) => !r.pass);
    if (!insp && !(evidence && evidence.violation)) return { ok: false, reason: "no-evidence" };
  }
  const id = allocId("case");
  g.cases[id] = {
    id,
    accused: key,
    kind,
    reporter: reporter ? norm(reporter) : "guild",
    atMs: Date.now(),
    status: "open",
    votes: {},
  };
  markDirty();
  return { ok: true, caseId: id };
}

function voteOnCase(kingdomId, caseId, voter, guilty) {
  const g = guildOf(kingdomId);
  if (!g || !g.cases[caseId]) return { ok: false, reason: "no-case" };
  const c = g.cases[caseId];
  if (c.status !== "open") return { ok: false, reason: "closed" };
  if (guildRankOf(voter) !== RANK_MASTER) return { ok: false, reason: "not-master" };
  c.votes[norm(voter)] = !!guilty;
  markDirty();
  return { ok: true };
}

function settleRipeCases(kingdomId, nowMs = Date.now()) {
  const g = guildOf(kingdomId);
  if (!g) return [];
  const settled = [];
  for (const id of Object.keys(g.cases)) {
    const c = g.cases[id];
    if (c.status !== "open") continue;
    if (nowMs - c.atMs < CASE_SETTLE_MS) continue;
    const votes = Object.values(c.votes);
    const guiltyVotes = votes.filter(Boolean).length;
    // Conviction needs a merchantmaster majority of cast votes; ties acquit.
    const guilty = votes.length > 0 && guiltyVotes > votes.length / 2;
    c.status = guilty ? "guilty" : "acquitted";
    c.settledAtMs = nowMs;
    if (guilty) applySentence(kingdomId, c, nowMs);
    settled.push({ caseId: id, accused: c.accused, kind: c.kind, guilty });
    markDirty();
  }
  return settled;
}

function applySentence(kingdomId, c, nowMs) {
  const g = guildOf(kingdomId);
  const rec = g && g.members[c.accused];
  if (c.kind === CASE_UNLICENSED) {
    if (rec) {
      rec.finesOwed = (rec.finesOwed || 0) + FINE_UNLICENSED;
      rec.suspended = true;
      rec.suspendedUntilMs = nowMs + SUSPEND_UNLICENSED_MS;
    }
  } else if (c.kind === CASE_GOUGING) {
    if (rec) delete g.members[c.accused]; // expelled
    try {
      require("./CitizenReputation").awardDeed(c.accused, "profiteer", nowMs);
    } catch { /* reputation absent — fine recorded anyway */ }
  }
}

function openCases(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return [];
  return Object.values(g.cases).filter((c) => c.status === "open").map((c) => ({ ...c }));
}

// === Merchant school ===
function holdClass(kingdomId, master) {
  const g = ensureGuild(kingdomId);
  if (guildRankOf(master) !== RANK_MASTER) return { ok: false, reason: "not-master" };
  let taught = 0;
  for (const key of Object.keys(g.members)) {
    const m = g.members[key];
    if (m.rank === RANK_PEDDLER && !m.suspended) {
      m.trainingCredits = (m.trainingCredits || 0) + 1;
      taught += 1;
    }
  }
  g.classes.push({ atMs: Date.now(), master: norm(master), taught });
  markDirty();
  return { ok: true, taught };
}

function tryPromote(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m || m.suspended) return { ok: false, reason: "not-member" };
  const g = guildOf(m.kingdomId);
  const rec = g.members[norm(username)];
  const tenureDays = (nowMs - (rec.joinedAtMs || nowMs)) / (24 * 60 * 60 * 1000);
  if (rec.rank === RANK_PEDDLER) {
    if (tenureDays < PROMOTE_TRADER_DAYS) return { ok: false, reason: "tenure" };
    if ((rec.trainingCredits || 0) < PROMOTE_TRADER_CREDITS) return { ok: false, reason: "credits" };
    rec.rank = RANK_TRADER;
    markDirty();
    return { ok: true, rank: RANK_TRADER };
  }
  if (rec.rank === RANK_TRADER) {
    if (tenureDays < PROMOTE_MASTER_DAYS) return { ok: false, reason: "tenure" };
    if ((rec.trainingCredits || 0) < PROMOTE_MASTER_CREDITS) return { ok: false, reason: "credits" };
    if ((rec.inspectionsConducted || 0) < PROMOTE_MASTER_INSPECTIONS) return { ok: false, reason: "inspections" };
    rec.rank = RANK_MASTER;
    try {
      require("./CitizenReputation").awardDeed(username, "fairtrader", nowMs);
    } catch { /* best-effort */ }
    markDirty();
    return { ok: true, rank: RANK_MASTER };
  }
  return { ok: false, reason: "top-rank" };
}

// === Public describe (chat) ===
function describe(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return null;
  const members = Object.keys(g.members).length;
  const masters = Object.values(g.members).filter((m) => m.rank === RANK_MASTER).length;
  return {
    members,
    masters,
    treasury: g.treasury || 0,
    fairFund: g.fairFund || 0,
    openCases: Object.values(g.cases).filter((c) => c.status === "open").length,
    licensed: Object.keys(g.licenses).length,
  };
}

module.exports = {
  // tuning
  RANK_PEDDLER,
  RANK_TRADER,
  RANK_MASTER,
  RANKS,
  DUES_WEEKLY,
  LICENSE_FEE,
  LICENSE_MS,
  GOUGING_RATIO,
  CERT_MS,
  CERT_BONUS,
  FAIR_ENTRY_FEE,
  FAIR_PRIZE,
  STANDARDS_CODE,
  // persistence
  save,
  resetForTests,
  _setSavePathForTests,
  markDirty,
  // guilds
  ensureGuild,
  guildOf,
  guildTreasuryFor,
  fairFundFor,
  hallTileFor,
  kingdomIds,
  // membership
  memberOf,
  isGuildMember,
  guildRankOf,
  canJoinWithProof,
  joinGuild,
  leaveGuild,
  recordDuesPayment,
  recordMissedDues,
  // licenses
  licenseFor,
  buyLicense,
  // inspections
  inspectWares,
  recordInspection,
  inspectionsFor,
  // caravan certification
  certifyManifest,
  certifiedBonusFor,
  // fairs
  fairDue,
  enterFair,
  resolveFair,
  // tribunal
  CASE_UNLICENSED,
  CASE_GOUGING,
  reportMisconduct,
  voteOnCase,
  settleRipeCases,
  openCases,
  // school
  holdClass,
  tryPromote,
  // chat
  describe,
};
