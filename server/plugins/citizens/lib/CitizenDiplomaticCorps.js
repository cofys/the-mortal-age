"use strict";

/**
 * CitizenDiplomaticCorps — the diplomatic corps (diplomacy guild) operations layer.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenDiplomats owns: courtier-diplomat drafting, mission phase
 *     machines (departing/traveling/negotiating/returning/debrief), player
 *     escort invites, ambassador stationing, envoy ceremonies, and the
 *     diplomatic rumor streams. Its missions are READ-ONLY here (join
 *     gating may verify current mission service — nothing is ever started
 *     or resolved by this module).
 *   - CitizenTreaties owns: treaty proposals, negotiation rounds,
 *     ratification, embassies, summits, and the Tension cooling on
 *     ratification. Its records are READ-ONLY here (reviews read tension,
 *     embassy pairs, and active treaties — nothing is ever proposed or
 *     ratified by this module).
 *   - CitizenDiplomacy owns: passive intel gathering and royal marriages.
 *     Never touched here.
 *   - CitizenEspionage owns: spy networks, cells, covert operations,
 *     counter-intelligence. Read-only seam for the treason tribunal —
 *     an active spy cell in the guild is treason.
 *   - THIS module owns: the profession's GUILD layer — per-kingdom
 *     diplomatic corps associations, membership ranks with real-coin dues,
 *     the code of diplomatic protocol, border reviews with verifiable
 *     findings from the REAL tension ledger, the mediation fund (real
 *     tracked coins paying ambassadors who cool genuinely hot borders),
 *     the diplomatic school (training under ambassador-rank masters), and
 *     the disciplinary tribunal (verifiable treason only).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Corps: one per kingdom with a hall tile near the court anchor, a real
 *     tracked treasury, a real tracked mediation fund, border-review
 *     history, and crisis state.
 *   - Membership: envoy -> negotiator -> ambassador ranks. Joining requires
 *     being a REAL diplomat — career is "ambassador" (CitizenCareers) OR
 *     currently serving on a real diplomatic mission (CitizenDiplomats).
 *     The corps polices the trade, it does not mint diplomats. Weekly
 *     real-coin dues (25, of which 5 feeds the mediation fund); 2 missed
 *     online collections suspend; offline members skipped, never penalized.
 *   - Protocol code: the guild's code of diplomatic protocol (read-only —
 *     honesty, neutrality, discretion, cultural respect, peace duty).
 *   - Border reviews: ambassador-rank members inspect the REAL tension
 *     ledger. Verifiable findings only — hot borders (Tension.getTension),
 *     missing embassy pairs (CitizenTreaties.embassyPair), missing active
 *     treaties (CitizenTreaties.treatyBetween), active wars
 *     (CitizenTreaties.atWar). PASS when every border is calm; otherwise
 *     FLAG with reasons. Two consecutive flags with 2+ hot borders mark
 *     the frontier in CRISIS, which triggers mediation drives.
 *   - Mediation: the guild's fund pays the standard mediator fee to guild
 *     ambassadors who cool genuinely hot borders. Claims are filed only for
 *     borders whose tension is REALLY at or above HOT_BORDER and not at
 *     war; the ambassador's mediation genuinely reduces the border tension
 *     via the Tension API; the REAL fee goes from the guild's mediation
 *     fund into the mediator's REAL bank account (owed honestly when the
 *     fund runs dry, retried on the life tick). One mediation per pair per
 *     day — cooling cannot be spammed.
 *   - Diplomatic school: ambassador-rank masters hold protocol classes for
 *     envoys; attendance grants training credit. Promotion: negotiator at
 *     30 days tenure + 2 training credits + 1 mediation led + clean record;
 *     ambassador at 60 days + 4 credits + 2 reviews conducted + clean
 *     record. All verifiable from guild records — never invented.
 *   - Disciplinary tribunal: violations are REPORTED and VERIFIED against
 *     real data, never assumed. The one verifiable diplomatic crime:
 *     treason — an active spy cell in ANY kingdom
 *     (CitizenEspionage.cellFor). Ambassador-rank members vote; cases
 *     settle after 24h. Guilty: expulsion + the `traitor` fame deed.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here (lib/CitizenDiplomaticCorpsLife.js is ticked by the director).
 *   - No LLM. No movement (brain/actions/CitizenDiploCorps.js).
 *   - No invented coins, missions, treaties, embassies, or spy cells.
 */

const path = require("path");

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-diplocorps.json";
const COINS_ID = 995;

const RANK_ENVOY = "envoy";
const RANK_NEGOTIATOR = "negotiator";
const RANK_AMBASSADOR = "ambassador";
const RANKS = Object.freeze([RANK_ENVOY, RANK_NEGOTIATOR, RANK_AMBASSADOR]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_MEDIATION_SHARE = 5; // of each dues payment, this much feeds the mediation fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2; // missed online collections before suspension

const HOT_BORDER = 60; // tension at or above this is a hot border
const REVIEW_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // one border review per kingdom per week
const CRISIS_HOT_BORDERS_MIN = 2; // hot borders on two consecutive flags -> CRISIS
const CONSECUTIVE_FLAGS_TO_CRISIS = 2;

const MEDIATION_FEE = 250; // real coins paid to the mediator per mediation
const MEDIATION_TENSION_DROP = 8; // real tension points cooled per mediation
const MEDIATION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // one mediation per pair per day

const PROMOTE_NEGOTIATOR_DAYS = 30;
const PROMOTE_NEGOTIATOR_TRAINING = 2;
const PROMOTE_NEGOTIATOR_MEDIATIONS = 1;
const PROMOTE_AMBASSADOR_DAYS = 60;
const PROMOTE_AMBASSADOR_TRAINING = 4;
const PROMOTE_AMBASSADOR_REVIEWS = 2;

const CASE_SETTLE_MS = 24 * 60 * 60 * 1000; // auto-settle open cases after 24h

const HALL_TILE_DX = 6; // guild hall sits a few tiles from the court anchor

// --- state --------------------------------------------------------------------

let cache = null;
// {
//   corps: { kingdomId: {
//     treasury: number, mediationFund: number,
//     members: { normName: { displayName, rank, joinedAtMs, duesPaidUntilMs,
//       missedDues, suspended, suspendedUntilMs, trainingCredits,
//       mediationsLed, reviewsConducted, cleanRecord, finesOwed } },
//     reviews: [ { atMs, result, reasons } ],
//     consecutiveFlags: number, crisis: boolean,
//     mediations: { pairKey: { lastMediatedMs } },
//     mediationClaims: { claimId: { otherKingdom, filedAtMs, status,
//       mediator, paidAtMs, owed, tensionBefore, tensionAfter } },
//     cases: { caseId: { accused, kind, reporter, filedAtMs,
//       status, votes: { voter: "guilty"|"not" }, verdict } },
//   } },
// }

function _saveFile() {
  try {
    const { savePath } = require("./CitizenSaves");
    return savePath(SAVE_KEY);
  } catch {
    return path.join(__dirname, "..", "data", "saves", SAVE_KEY);
  }
}

function _setSavePathForTests(p) {
  _testSavePath = p;
}
let _testSavePath = null;

function state() {
  if (!cache) {
    cache = { corps: Object.create(null) };
    try {
      const fs = require("fs");
      const p = _testSavePath || _saveFile();
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        if (raw && typeof raw === "object") cache = raw;
        if (!cache.corps) cache.corps = Object.create(null);
      }
    } catch { /* start fresh */ }
  }
  return cache;
}

let _dirty = false;
function markDirty() { _dirty = true; }
function save() {
  if (!_dirty) return false;
  try {
    const fs = require("fs");
    const p = _testSavePath || _saveFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 1));
    _dirty = false;
    return true;
  } catch { return false; }
}
function resetForTests() {
  cache = null;
  _dirty = false;
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

function pairKey(a, b) {
  const x = String(a), y = String(b);
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

// --- corps existence ------------------------------------------------------------

function corpsOf(kingdomId) {
  if (!kingdomId) return null;
  return state().corps[kingdomId] || null;
}

function ensureCorps(kingdomId) {
  if (!kingdomId) return null;
  const s = state();
  if (!s.corps[kingdomId]) {
    s.corps[kingdomId] = {
      treasury: 0,
      mediationFund: 0,
      members: Object.create(null),
      reviews: [],
      consecutiveFlags: 0,
      crisis: false,
      mediations: Object.create(null),
      mediationClaims: Object.create(null),
      cases: Object.create(null),
      foundedAtMs: Date.now(),
    };
    markDirty();
  }
  return s.corps[kingdomId];
}

function hallTileFor(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const court = siteTileByKingdom ? siteTileByKingdom(kingdomId, "court") : null;
    if (court && typeof court.x === "number") {
      return { x: court.x + HALL_TILE_DX, y: court.y, z: court.z ?? 0 };
    }
  } catch { /* no sites */ }
  return null;
}

// --- membership -----------------------------------------------------------------

function isRealDiplomat(username) {
  const name = norm(username);
  if (!name) return false;
  // Path 1: the citizen's career is ambassador.
  try {
    const Careers = require("./CitizenCareers");
    const rec = Careers.careerOf ? Careers.careerOf(username) : null;
    const key = rec && (rec.key || rec.career || rec.name);
    if (key && String(key).toLowerCase() === "ambassador") return true;
  } catch { /* no careers */ }
  // Path 2: currently serving on a REAL diplomatic mission. Judge-claimed
  // courtiers are excluded through the diplomats tier's own predicate.
  try {
    const D = require("./CitizenDiplomats");
    if (D.isDiplomat && !D.isDiplomat(username)) return false;
    const status = D.diplomatStatus ? D.diplomatStatus() : null;
    if (Array.isArray(status)) {
      for (const line of status) {
        if (String(line).toLowerCase().startsWith(name + " (")) return true;
      }
    }
  } catch { /* no diplomats */ }
  return false;
}

function isGuildMember(username) {
  const name = norm(username);
  if (!name) return false;
  const s = state();
  for (const kid of Object.keys(s.corps)) {
    const m = s.corps[kid].members[name];
    if (m) return true;
  }
  return false;
}

function memberOf(username) {
  const name = norm(username);
  if (!name) return null;
  const s = state();
  for (const kid of Object.keys(s.corps)) {
    const m = s.corps[kid].members[name];
    if (m) return { kingdomId: kid, ...m };
  }
  return null;
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function joinGuild(kingdomId, username) {
  const name = norm(username);
  if (!kingdomId || !name) return { ok: false, reason: "bad-request" };
  if (!isRealDiplomat(username)) return { ok: false, reason: "not-a-diplomat" };
  if (memberOf(username)) return { ok: false, reason: "already-member" };
  const g = ensureCorps(kingdomId);
  const now = Date.now();
  g.members[name] = {
    displayName: username,
    rank: RANK_ENVOY,
    joinedAtMs: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS,
    missedDues: 0,
    suspended: false,
    suspendedUntilMs: 0,
    trainingCredits: 0,
    mediationsLed: 0,
    reviewsConducted: 0,
    cleanRecord: true,
  };
  markDirty();
  return { ok: true, rank: RANK_ENVOY };
}

function leaveGuild(username) {
  const name = norm(username);
  if (!name) return false;
  const s = state();
  for (const kid of Object.keys(s.corps)) {
    if (s.corps[kid].members[name]) {
      delete s.corps[kid].members[name];
      markDirty();
      return true;
    }
  }
  return false;
}

function recordDuesPayment(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return false;
  const g = corpsOf(m.kingdomId);
  if (!g) return false;
  const rec = g.members[norm(username)];
  rec.duesPaidUntilMs = nowMs + DUES_PERIOD_MS;
  rec.missedDues = 0;
  if (!(rec.suspended && rec.suspendedUntilMs && nowMs < rec.suspendedUntilMs)) {
    rec.suspended = false;
  }
  g.treasury += DUES_WEEKLY - DUES_MEDIATION_SHARE;
  g.mediationFund += DUES_MEDIATION_SHARE;
  markDirty();
  return true;
}

function recordMissedDues(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return;
  const g = corpsOf(m.kingdomId);
  if (!g) return;
  const rec = g.members[norm(username)];
  rec.missedDues = (rec.missedDues || 0) + 1;
  if (rec.missedDues >= SUSPEND_AFTER_MISSED) rec.suspended = true;
  markDirty();
}

// --- protocol code (read-only) ---------------------------------------------------

const PROTOCOL_CODE = Object.freeze([
  "Honesty between crowns: never mislead a foreign court.",
  "Neutrality in mediation: hear every side before every word.",
  "Discretion: a diplomat's confidence is a kingdom's trust.",
  "Cultural respect: honor every court's customs as your own.",
  "Peace duty: the corps stands for calm borders, not conquest.",
]);

function protocolCode() {
  return PROTOCOL_CODE.slice();
}

// --- border reviews -----------------------------------------------------------------

function _tensionOf(a, b) {
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    const t = Tension.getTension ? Tension.getTension(a, b) : null;
    return typeof t === "number" ? t : 50;
  } catch { return 50; }
}

function _treatyRead(fnName, ...args) {
  try {
    const Treaties = require("./CitizenTreaties");
    const fn = Treaties[fnName];
    return typeof fn === "function" ? fn(...args) : null;
  } catch { return null; }
}

function hotBordersFor(kingdomId) {
  const out = [];
  if (!kingdomId) return out;
  let ids = [];
  try {
    const { KINGDOM_IDS } = require("../brain/CitizenSites");
    if (Array.isArray(KINGDOM_IDS)) ids = KINGDOM_IDS;
  } catch { /* no sites */ }
  for (const other of ids) {
    if (other === kingdomId) continue;
    const t = _tensionOf(kingdomId, other);
    if (t >= HOT_BORDER) out.push({ other, tension: t });
  }
  return out;
}

function conductReview(kingdomId, reviewer) {
  const g = ensureCorps(kingdomId);
  if (!g) return { ok: false, reason: "no-corps" };
  const reasons = [];
  const hot = hotBordersFor(kingdomId);

  for (const { other, tension } of hot) {
    const bits = [`tension ${Math.round(tension)} with ${other}`];
    const atWar = _treatyRead("atWar", kingdomId, other);
    if (atWar) bits.push("at war");
    else {
      const pair = _treatyRead("embassyPair", kingdomId, other);
      if (!pair) bits.push("no standing embassy");
      const treaty = _treatyRead("treatyBetween", kingdomId, other);
      if (!treaty) bits.push("no active treaty");
    }
    reasons.push(bits.join(", "));
  }

  const result = reasons.length === 0 ? "PASS" : "FLAG";
  g.reviews.push({ atMs: Date.now(), result, reasons, reviewer: reviewer || null });
  if (g.reviews.length > 52) g.reviews = g.reviews.slice(-52);

  if (result === "FLAG") {
    g.consecutiveFlags = (g.consecutiveFlags || 0) + 1;
    if (g.consecutiveFlags >= CONSECUTIVE_FLAGS_TO_CRISIS && hot.length >= CRISIS_HOT_BORDERS_MIN) {
      g.crisis = true;
    }
  } else {
    g.consecutiveFlags = 0;
    g.crisis = false;
  }
  if (reviewer) {
    const rec = g.members[norm(reviewer)];
    if (rec) rec.reviewsConducted = (rec.reviewsConducted || 0) + 1;
  }
  markDirty();
  return { ok: true, result, reasons, crisis: g.crisis, hotBorders: hot.length };
}

// --- mediation -----------------------------------------------------------------------

function fileMediationClaim(kingdomId, otherKingdomId) {
  const g = ensureCorps(kingdomId);
  if (!g) return { ok: false, reason: "no-corps" };
  if (!otherKingdomId || otherKingdomId === kingdomId) return { ok: false, reason: "bad-request" };
  // Verify the border is genuinely hot and not at war — mediation happens
  // between strained neighbors, not active belligerents.
  const t = _tensionOf(kingdomId, otherKingdomId);
  if (t < HOT_BORDER) return { ok: false, reason: "border-not-hot" };
  if (_treatyRead("atWar", kingdomId, otherKingdomId)) return { ok: false, reason: "at-war" };
  const claimId = `m-${pairKey(kingdomId, otherKingdomId)}`;
  if (g.mediationClaims[claimId] && g.mediationClaims[claimId].status !== "done") {
    return { ok: false, reason: "already-filed" };
  }
  g.mediationClaims[claimId] = {
    otherKingdom: otherKingdomId, filedAtMs: Date.now(), status: "open",
    mediator: null, paidAtMs: 0, owed: 0, tensionBefore: t, tensionAfter: null,
  };
  markDirty();
  return { ok: true, claimId };
}

function assignMediation(kingdomId, claimId, mediatorName) {
  const g = corpsOf(kingdomId);
  if (!g) return { ok: false, reason: "no-corps" };
  const claim = g.mediationClaims[claimId];
  if (!claim || claim.status !== "open") return { ok: false, reason: "no-such-claim" };
  if (guildRankOf(mediatorName) !== RANK_AMBASSADOR) return { ok: false, reason: "ambassadors-only" };
  const mem = memberOf(mediatorName);
  if (!mem || mem.suspended) return { ok: false, reason: "not-in-standing" };
  // Cooldown: one mediation per border pair per day — cooling cannot be spammed.
  const pk = pairKey(kingdomId, claim.otherKingdom);
  const last = g.mediations[pk]?.lastMediatedMs || 0;
  if (Date.now() - last < MEDIATION_COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  // Lead the mediation: genuinely cool the border through the Tension API.
  let tensionBefore = _tensionOf(kingdomId, claim.otherKingdom);
  let tensionAfter = tensionBefore;
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    if (typeof Tension.setTension === "function") {
      tensionAfter = Math.max(0, tensionBefore - MEDIATION_TENSION_DROP);
      Tension.setTension(kingdomId, claim.otherKingdom, tensionAfter);
    }
  } catch { /* tension unreachable — the fee still honors the work */ }
  claim.mediator = mediatorName;
  claim.tensionBefore = tensionBefore;
  claim.tensionAfter = tensionAfter;
  g.mediations[pk] = { lastMediatedMs: Date.now() };
  // Pay the REAL mediator fee from the guild's mediation fund into the
  // mediator's REAL bank account. Owed honestly when the fund runs dry.
  let paid = 0;
  let owed = MEDIATION_FEE;
  if (g.mediationFund >= MEDIATION_FEE) {
    g.mediationFund -= MEDIATION_FEE;
    paid = MEDIATION_FEE;
    owed = 0;
  } else if (g.mediationFund > 0) {
    paid = g.mediationFund;
    owed = MEDIATION_FEE - paid;
    g.mediationFund = 0;
  }
  if (paid > 0) {
    try {
      const Banking = require("./CitizenBanking");
      if (Banking.creditAccount) Banking.creditAccount(mediatorName, paid);
    } catch { paid = 0; owed = MEDIATION_FEE; }
  }
  claim.paidAtMs = paid > 0 ? Date.now() : 0;
  claim.owed = owed;
  claim.status = owed > 0 ? "owed" : "paid";
  const rec = g.members[norm(mediatorName)];
  if (rec) rec.mediationsLed = (rec.mediationsLed || 0) + 1;
  markDirty();
  return { ok: true, paid, owed, tensionBefore, tensionAfter };
}

function retryOwedMediation(kingdomId) {
  const g = corpsOf(kingdomId);
  if (!g) return 0;
  let paid = 0;
  for (const cid of Object.keys(g.mediationClaims)) {
    const claim = g.mediationClaims[cid];
    if (claim.status !== "owed" || !claim.owed) continue;
    if (g.mediationFund <= 0) break;
    const amt = Math.min(claim.owed, g.mediationFund);
    g.mediationFund -= amt;
    claim.owed -= amt;
    try {
      const Banking = require("./CitizenBanking");
      if (Banking.creditAccount) Banking.creditAccount(claim.mediator, amt);
    } catch { g.mediationFund += amt; claim.owed += amt; break; }
    if (claim.owed <= 0) { claim.status = "paid"; claim.paidAtMs = Date.now(); }
    paid += amt;
  }
  if (paid > 0) markDirty();
  return paid;
}

function contributeMediation(kingdomId, username, amount) {
  // The Events command already took the real coins from the player's
  // inventory; this records the contribution honestly in the guild's fund.
  const g = ensureCorps(kingdomId);
  if (!g || !amount || amount <= 0) return { ok: false, reason: "bad-request" };
  const taken = Math.floor(amount);
  if (taken <= 0) return { ok: false, reason: "bad-request" };
  g.mediationFund += taken;
  markDirty();
  return { ok: true, contributed: taken };
}

// --- disciplinary tribunal ---------------------------------------------------------------

function scanTreason(username) {
  // The one verifiable diplomatic crime: an ACTIVE spy cell in ANY kingdom
  // (CitizenEspionage.cellFor). A diplomat running a foreign cell is treason.
  const name = norm(username);
  if (!name) return null;
  try {
    const Esp = require("./CitizenEspionage");
    const cell = Esp.cellFor ? Esp.cellFor(username) : null;
    if (cell) return "treason";
  } catch { /* no espionage */ }
  return null;
}

function reportMisconduct(kingdomId, accused, kind, reporter) {
  const g = ensureCorps(kingdomId);
  if (!g) return { ok: false, reason: "no-corps" };
  if (kind !== "treason") return { ok: false, reason: "bad-kind" };
  if (!scanTreason(accused)) return { ok: false, reason: "unverifiable" };
  // No double jeopardy: one open case per accused+kind.
  for (const cid of Object.keys(g.cases)) {
    const c = g.cases[cid];
    if (c.status === "open" && norm(c.accused) === norm(accused) && c.kind === kind) {
      return { ok: false, reason: "already-open" };
    }
  }
  const caseId = `d-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  g.cases[caseId] = {
    accused, kind, reporter: reporter || "corps",
    filedAtMs: Date.now(), status: "open", votes: Object.create(null), verdict: null,
  };
  markDirty();
  return { ok: true, caseId };
}

function voteOnCase(kingdomId, caseId, voter, guilty) {
  const g = corpsOf(kingdomId);
  if (!g) return { ok: false, reason: "no-corps" };
  const c = g.cases[caseId];
  if (!c || c.status !== "open") return { ok: false, reason: "no-such-case" };
  if (guildRankOf(voter) !== RANK_AMBASSADOR) return { ok: false, reason: "ambassadors-only" };
  c.votes[norm(voter)] = guilty ? "guilty" : "not";
  markDirty();
  return { ok: true };
}

function settleCase(kingdomId, caseId) {
  const g = corpsOf(kingdomId);
  if (!g) return { ok: false, reason: "no-corps" };
  const c = g.cases[caseId];
  if (!c || c.status !== "open") return { ok: false, reason: "no-such-case" };
  const votes = Object.values(c.votes);
  const guilty = votes.filter((v) => v === "guilty").length;
  const notGuilty = votes.filter((v) => v === "not").length;
  const verdict = guilty > notGuilty ? "guilty" : "acquitted";
  c.status = "decided";
  c.verdict = verdict;
  if (verdict === "guilty") {
    // Treason: expulsion from the corps + the traitor fame deed.
    delete g.members[norm(c.accused)];
    try {
      const Rep = require("./CitizenReputation");
      if (Rep.grantDeed) Rep.grantDeed(c.accused, "traitor");
    } catch { /* reputation unavailable */ }
  }
  markDirty();
  return { ok: true, verdict };
}

function settleRipeCases(kingdomId, nowMs) {
  const g = corpsOf(kingdomId);
  if (!g) return 0;
  let settled = 0;
  for (const cid of Object.keys(g.cases)) {
    const c = g.cases[cid];
    if (c.status === "open" && nowMs - c.filedAtMs >= CASE_SETTLE_MS) {
      settleCase(kingdomId, cid);
      settled++;
    }
  }
  return settled;
}

// --- diplomatic school -----------------------------------------------------------------------

function holdClass(kingdomId, masterName) {
  const g = corpsOf(kingdomId);
  if (!g) return { ok: false, reason: "no-corps" };
  if (guildRankOf(masterName) !== RANK_AMBASSADOR) return { ok: false, reason: "ambassadors-only" };
  let taught = 0;
  for (const n of Object.keys(g.members)) {
    const rec = g.members[n];
    if (rec.rank === RANK_ENVOY && !rec.suspended) {
      rec.trainingCredits = (rec.trainingCredits || 0) + 1;
      taught++;
    }
  }
  markDirty();
  return { ok: true, taught };
}

function tryPromote(username) {
  const m = memberOf(username);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  const g = corpsOf(m.kingdomId);
  const rec = g.members[norm(username)];
  const tenureDays = (Date.now() - rec.joinedAtMs) / (24 * 60 * 60 * 1000);
  if (rec.rank === RANK_ENVOY) {
    if (tenureDays >= PROMOTE_NEGOTIATOR_DAYS &&
        (rec.trainingCredits || 0) >= PROMOTE_NEGOTIATOR_TRAINING &&
        (rec.mediationsLed || 0) >= PROMOTE_NEGOTIATOR_MEDIATIONS &&
        rec.cleanRecord) {
      rec.rank = RANK_NEGOTIATOR;
      markDirty();
      return { ok: true, rank: RANK_NEGOTIATOR };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  if (rec.rank === RANK_NEGOTIATOR) {
    if (tenureDays >= PROMOTE_AMBASSADOR_DAYS &&
        (rec.trainingCredits || 0) >= PROMOTE_AMBASSADOR_TRAINING &&
        (rec.reviewsConducted || 0) >= PROMOTE_AMBASSADOR_REVIEWS &&
        rec.cleanRecord) {
      rec.rank = RANK_AMBASSADOR;
      markDirty();
      try {
        const Rep = require("./CitizenReputation");
        if (Rep.grantDeed) Rep.grantDeed(username, "peacemaker");
      } catch { /* reputation unavailable */ }
      return { ok: true, rank: RANK_AMBASSADOR };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  return { ok: false, reason: "max-rank" };
}

// --- describe -----------------------------------------------------------------------------

function describe(kingdomId) {
  const g = corpsOf(kingdomId);
  if (!g) return null;
  let ambassadors = 0, negotiators = 0, envoys = 0;
  for (const n of Object.keys(g.members)) {
    const r = g.members[n];
    if (r.suspended) continue;
    if (r.rank === RANK_AMBASSADOR) ambassadors++;
    else if (r.rank === RANK_NEGOTIATOR) negotiators++;
    else envoys++;
  }
  const openClaims = Object.values(g.mediationClaims).filter((c) => c.status === "open" || c.status === "owed").length;
  const openCases = Object.values(g.cases).filter((c) => c.status === "open").length;
  return {
    members: ambassadors + negotiators + envoys,
    ambassadors, negotiators, envoys,
    treasury: g.treasury,
    mediationFund: g.mediationFund,
    crisis: !!g.crisis,
    openClaims, openCases,
  };
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  markDirty,
  COINS_ID,
  RANK_ENVOY, RANK_NEGOTIATOR, RANK_AMBASSADOR, RANKS,
  DUES_WEEKLY, DUES_MEDIATION_SHARE, MEDIATION_FEE, MEDIATION_TENSION_DROP,
  HOT_BORDER,
  ensureCorps,
  corpsOf,
  hallTileFor,
  isRealDiplomat,
  isGuildMember,
  memberOf,
  guildRankOf,
  joinGuild,
  leaveGuild,
  recordDuesPayment,
  recordMissedDues,
  protocolCode,
  conductReview,
  hotBordersFor,
  fileMediationClaim,
  assignMediation,
  retryOwedMediation,
  contributeMediation,
  scanTreason,
  reportMisconduct,
  voteOnCase,
  settleCase,
  settleRipeCases,
  holdClass,
  tryPromote,
  describe,
};
