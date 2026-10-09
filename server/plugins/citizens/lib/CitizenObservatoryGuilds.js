"use strict";

/**
 * CitizenObservatoryGuilds — the Astronomers' Guild: the astronomer
 * profession's operations layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenAstronomy owns: the astronomer profession registry, observatory
 *     DATA records (kingdomId -> tile), star charts (persistent records with
 *     real navigation bonuses read by CitizenTravel), celestial events
 *     (deterministic schedule + real game effects), and astrology omens.
 *     This READS those records (astronomers, observatory tiles, charts,
 *     active events, event schedule math) but never reimplements them.
 *   - CitizenObservatories owns: public observatory operations — visits,
 *     entry fees, the chart shop (copies for sale), guided tours, viewing
 *     parties, player hosts. This never sells tickets, runs tours, or hosts
 *     parties.
 *   - CitizenObserve (brain) owns: astronomers walking to the observatory at
 *     night to OBSERVE and create charts. This never creates charts.
 *   - CitizenScience owns: astronomy science experiments and discoveries.
 *     This reads (never writes) astronomy discoveries for its science tie.
 *   - CitizenSchools owns: schools, teachers, classes. This never runs
 *     classes — the star-chart school is the guild teaching its OWN
 *     members.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One Astronomers' Guild per kingdom with a hall tile near the
 *     observatory, a real tracked treasury, and prestige.
 *   - Membership: stargazer -> astronomer -> starmaster. Joining requires
 *     being a REAL astronomer: registered in the CitizenAstronomy ledger
 *     (CitizenAstronomy.astronomerFor), OR the `astronomer` career
 *     (CitizenCareers.careerOf). The guild polices the trade, never mints
 *     astronomers. Weekly dues in REAL coins; two missed online collections
 *     -> suspended until caught up. Offline members are never penalized.
 *   - Chart certification: members submit charts they REALLY created
 *     (verified against the CitizenAstronomy chart ledger — the chart
 *     exists and its recorded astronomer is the claimant). A 50-coin real
 *     fee (mentored stargazers certify free). Grades from the REAL chart
 *     quality: >=8=A, >=5=B, else C. The guild pays a REAL bounty from its
 *     treasury (C:30 / B:60 / A:120); when broke the bounty is owed
 *     honestly, never invented.
 *   - Fabrication tribunal: the one verifiable celestial crime — false
 *     attribution: a chart submitted for certification whose RECORDED
 *     astronomer (per the real ledger) is not the claimant. Caught at
 *     certify time (auto-opened case) and reportable by members/players.
 *     Astronomer-rank members vote; 24h auto-settle. Guilty -> expulsion +
 *     `fraudster` deed.
 *   - Celestial standards (accuracy audits): the guild's accuracy score per
 *     kingdom is computed from REAL data — every guild member's real chart
 *     output (CitizenAstronomy.chartsFor filtered by astronomer). Members
 *     with no real charts lower the score. Scores below 40 trigger a public
 *     celestial-audit announcement. The science tie: members holding real
 *     astronomy discoveries (CitizenScience) are recognized in the audit
 *     report.
 *   - Eclipse prediction: starmasters publish predictions of upcoming
 *     celestial events, computed from the REAL deterministic event schedule
 *     (same month math as CitizenAstronomy.shouldEventBeActive — never
 *     invented). Predictions are confirmed when the event actually goes
 *     active (CitizenAstronomy.activeEventFor). Correct predictions raise
 *     guild prestige, pay the herald a 100-coin prize, and award the
 *     `eclipseherald` deed. Missed predictions fail honestly.
 *   - Silver orrery: quarterly, the guild member with the most REAL
 *     certified charts in the kingdom wins a 200-coin real prize (owed
 *     honestly when broke) and a public announcement.
 *   - Star-chart school: starmaster astronomers teach stargazers (training
 *     credits). Promotion: stargazer -> astronomer (30d tenure + 2 credits +
 *     a real certified chart), astronomer -> starmaster (60d tenure +
 *     4 credits + 2 conducted certifications + clean record). All
 *     verifiable from real records — never invented.
 *   - Mentorship: starmasters take stargazer members under wing. While
 *     mentored, the stargazer pays no certification fees and their
 *     certifications count double toward promotion. Mentorship ends after
 *     the first certification.
 *   - Public API: isGuildMember, guildRankOf, memberOf, memberNames,
 *     chartCertFor, bestGradeFor, guildTreasuryFor, accuracyAuditFor,
 *     nextEventFor, predictionsFor, describe.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenObservatoryGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented astronomers, charts, events, predictions, coins, or
 *     predictions.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-observatoryguilds.json";
const COINS_ID = 995;

const RANK_STARGAZER = "stargazer";
const RANK_ASTRONOMER = "astronomer";
const RANK_STARMASTER = "starmaster";
const RANKS = Object.freeze([RANK_STARGAZER, RANK_ASTRONOMER, RANK_STARMASTER]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const CERT_FEE = 50; // real coins to certify a chart
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const GRADE_A_QUALITY = 8; // chart quality 1-10
const GRADE_B_QUALITY = 5;

const ORRERY_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly silver orrery
const ORRERY_PRIZE = 200; // real coins from the treasury

const HERALD_PRIZE = 100; // real coins for a confirmed prediction

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const PREDICTION_GRACE_MS = 45 * 24 * 60 * 60 * 1000; // a prediction fails 45d past its date
const PREDICTION_LOOKAHEAD_MONTHS = 24; // never predict further out than this

const HALL_TILE_DX = 5; // guild hall sits a few tiles from the observatory
const HALL_TILE_DY = 4;

const AUDIT_THRESHOLD = 40; // below this the guild announces a celestial audit

const PROMOTE_ASTRONOMER = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2 });
const PROMOTE_STARMASTER = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, certifications: 2 });

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", SAVE_KEY);

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

let cache = null;
let dirty = false;

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
}

function blankState() {
  return {
    version: 1,
    guilds: {}, // kingdomId -> guild record
    members: {}, // lower(username) -> member record
    certifications: {}, // certId -> certification record
    cases: {}, // caseId -> tribunal case
    mentorships: {}, // lower(stargazer) -> { master, sinceMs }
    predictions: {}, // predictionId -> celestial prediction
    nextCertId: 1,
    nextCaseId: 1,
    nextPredictionId: 1,
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    cache = JSON.parse(raw);
    if (!cache || typeof cache !== "object") cache = blankState();
  } catch {
    cache = blankState();
  }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function touch() {
  dirty = true;
}

// === Engine reads (all defensive) ===

function astronomyApi() {
  try { return require("./CitizenAstronomy"); } catch { return null; }
}

function careersApi() {
  try { return require("./CitizenCareers"); } catch { return null; }
}

function sitesApi() {
  try { return require("../brain/CitizenSites"); } catch { return null; }
}

function reputationApi() {
  try { return require("./CitizenReputation"); } catch { return null; }
}

function scienceApi() {
  try { return require("./CitizenScience"); } catch { return null; }
}

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

// Credit real coins to a username's REAL bank account. Returns true only
// when the balance actually moved. CitizenBanking exposes accountFor, not
// creditAccount — credit the live account record directly (same pattern as
// the art/law/diplo/spy guild payout fixes).
function creditBankAccount(username, amount) {
  if (!username || !(amount > 0)) return false;
  try {
    const B = bankingApi();
    const acct = B && typeof B.accountFor === "function" ? B.accountFor(username) : null;
    if (!acct) return false;
    acct.balance = (Number(acct.balance) || 0) + amount;
    if (typeof B.markDirty === "function") B.markDirty();
    return true;
  } catch {
    return false;
  }
}

// === Guild management ===

function ensureGuild(kingdomId) {
  const st = load();
  if (!st.guilds[kingdomId]) {
    let hallTile = null;
    try {
      const A = astronomyApi();
      let base = null;
      if (A && A.observatoryFor) {
        const obs = A.observatoryFor(kingdomId);
        base = obs?.tile ?? null;
      }
      if (!base) {
        const S = sitesApi();
        if (S && S.siteTileByKingdom) base = S.siteTileByKingdom(kingdomId, "market") ?? null;
      }
      if (base) {
        hallTile = { x: base.x + HALL_TILE_DX, y: base.y + HALL_TILE_DY, z: base.z || 0 };
      }
    } catch { /* no hall tile */ }
    st.guilds[kingdomId] = {
      kingdomId,
      hallTile,
      treasury: 0,
      prestige: 0,
      foundedMs: Date.now(),
      lastOrreryMs: 0,
      confirmedPredictions: 0,
      failedPredictions: 0,
    };
    touch();
  }
  return st.guilds[kingdomId];
}

function guildOf(kingdomId) {
  const st = load();
  return st.guilds[kingdomId] || null;
}

// === Membership ===

function isRealAstronomer(username) {
  // The guild polices the trade — it never mints astronomers. Two
  // verifiable paths: the CitizenAstronomy registry, or the `astronomer`
  // career.
  try {
    const A = astronomyApi();
    if (A && A.astronomerFor && A.astronomerFor(username)) return true;
  } catch { /* fall through */ }
  try {
    const C = careersApi();
    if (C && C.careerOf && C.careerOf(username) === "astronomer") return true;
  } catch { /* fall through */ }
  return false;
}

function joinGuild(username, kingdomId) {
  const st = load();
  const key = normalizeName(username);
  if (st.members[key]) return { ok: false, reason: "already-member" };
  if (!isRealAstronomer(username)) return { ok: false, reason: "not-an-astronomer" };
  ensureGuild(kingdomId);
  const now = Date.now();
  st.members[key] = {
    username,
    kingdomId,
    rank: RANK_STARGAZER,
    joinedMs: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS, // first week free
    missedDues: 0,
    suspended: false,
    trainingCredits: 0,
    certificationsConducted: 0,
    cleanRecord: true,
  };
  touch();
  return { ok: true, rank: RANK_STARGAZER };
}

function leaveGuild(username) {
  const st = load();
  const key = normalizeName(username);
  if (!st.members[key]) return { ok: false, reason: "not-a-member" };
  delete st.members[key];
  // End any mentorship involving this member.
  for (const novice of Object.keys(st.mentorships)) {
    if (novice === key || normalizeName(st.mentorships[novice].master) === key) {
      delete st.mentorships[novice];
    }
  }
  touch();
  return { ok: true };
}

function isGuildMember(username) {
  const st = load();
  return !!st.members[normalizeName(username)];
}

function memberOf(username) {
  const st = load();
  return st.members[normalizeName(username)] || null;
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function memberNames(kingdomId) {
  const st = load();
  return Object.values(st.members)
    .filter((m) => m.kingdomId === kingdomId)
    .map((m) => m.username);
}

function recordDuesPayment(username, nowMs) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return { ok: false, reason: "not-a-member" };
  const g = ensureGuild(m.kingdomId);
  g.treasury += DUES_WEEKLY;
  m.duesPaidUntilMs = nowMs + DUES_PERIOD_MS;
  m.missedDues = 0;
  if (m.suspended) m.suspended = false; // caught up — lift suspension
  touch();
  return { ok: true };
}

function recordMissedDues(username, nowMs) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return { ok: false, reason: "not-a-member" };
  m.missedDues += 1;
  if (m.missedDues >= SUSPEND_AFTER_MISSED) m.suspended = true;
  touch();
  return { ok: true, suspended: m.suspended };
}

// === Chart certification ===

function findChart(kingdomId, chartId) {
  // Verify a chart is REAL: it exists in the CitizenAstronomy chart ledger.
  try {
    const A = astronomyApi();
    if (!A || !A.chartsFor) return null;
    const charts = A.chartsFor(kingdomId) || [];
    return charts.find((c) => String(c.id) === String(chartId)) || null;
  } catch {
    return null;
  }
}

function certifyChart(kingdomId, username, chartId) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return { ok: false, reason: "not-a-member" };
  if (m.suspended) return { ok: false, reason: "suspended" };
  const g = ensureGuild(kingdomId);

  // The chart must be REAL: it exists in the astronomy ledger. The charts
  // stay in the CitizenAstronomy ledger; the guild only records its seal.
  const chart = findChart(kingdomId, chartId);
  if (!chart) return { ok: false, reason: "no-such-chart" };

  // False attribution — the one verifiable celestial crime: the chart's
  // recorded astronomer is not the claimant. Reject the certification and
  // open an ethics case automatically.
  if (normalizeName(chart.astronomer) !== key) {
    const caseId = openFabricationCase(kingdomId, "guild", chart);
    return { ok: false, reason: "not-the-astronomer", caseId };
  }

  const quality = Number(chart.quality);
  if (!Number.isFinite(quality) || quality < 1 || quality > 10) {
    return { ok: false, reason: "no-quality" };
  }
  // No double-certification of the same chart.
  const dup = Object.values(st.certifications).some(
    (c) => normalizeName(c.astronomer) === key && String(c.chartId) === String(chartId)
  );
  if (dup) return { ok: false, reason: "already-certified" };

  // Mentored stargazers certify free; everyone else pays the real fee.
  const mentored = st.mentorships[key];
  const fee = mentored ? 0 : CERT_FEE;

  const grade = quality >= GRADE_A_QUALITY ? "A" : quality >= GRADE_B_QUALITY ? "B" : "C";
  const certId = `cert-${st.nextCertId++}`;
  const now = Date.now();
  st.certifications[certId] = {
    id: certId,
    kingdomId,
    astronomer: username,
    chartId: String(chartId),
    quality,
    grade,
    feePaid: fee,
    bountyPaid: 0,
    bountyOwed: 0,
    certifiedMs: now,
  };

  // Pay the bounty from the treasury into the astronomer's REAL bank
  // account. When the treasury is broke the bounty is owed honestly, never
  // invented. When banking is unreachable the treasury deduction rolls back
  // and the full bounty stays owed: never mark paid what was never delivered.
  const bounty = CERT_BOUNTY[grade];
  let paid = 0;
  let owed = 0;
  if (g.treasury >= bounty) {
    g.treasury -= bounty;
    paid = bounty;
  } else {
    paid = g.treasury;
    owed = bounty - paid;
    g.treasury = 0;
  }
  if (paid > 0 && !creditBankAccount(username, paid)) {
    // Banking unreachable: restore the treasury, keep the whole bounty owed
    // for a later tick. The coins must not vanish while the record claims
    // they were paid.
    g.treasury += paid;
    owed = bounty;
    paid = 0;
  }
  st.certifications[certId].bountyPaid = paid;
  st.certifications[certId].bountyOwed = owed;

  // Mentorship ends after the first certification; the certification
  // counts double toward promotion while mentored.
  if (mentored) {
    delete st.mentorships[key];
    m.certificationsConducted = (m.certificationsConducted || 0) + 2;
  } else {
    m.certificationsConducted = (m.certificationsConducted || 0) + 1;
  }

  updatePrestige(kingdomId);
  touch();
  return { ok: true, certId, grade, fee, bountyPaid: paid, bountyOwed: owed };
}

function chartCertFor(certId) {
  const st = load();
  return st.certifications[certId] || null;
}

function bestGradeFor(username) {
  const st = load();
  const key = normalizeName(username);
  const certs = Object.values(st.certifications).filter((c) => normalizeName(c.astronomer) === key);
  if (!certs.length) return null;
  // Best grade wins: A > B > C.
  const order = { A: 3, B: 2, C: 1 };
  certs.sort((a, b) => order[b.grade] - order[a.grade]);
  return certs[0].grade;
}

function retryOwedBounties(kingdomId) {
  const st = load();
  const g = ensureGuild(kingdomId);
  let paid = 0;
  for (const cert of Object.values(st.certifications)) {
    if (cert.kingdomId !== kingdomId || !cert.bountyOwed) continue;
    if (g.treasury <= 0) break;
    const pay = Math.min(cert.bountyOwed, g.treasury);
    g.treasury -= pay;
    // Deliver to the astronomer's REAL bank account. If banking is
    // unreachable, restore the treasury and keep the bounty owed: never
    // mark paid what was never delivered.
    if (!creditBankAccount(cert.astronomer, pay)) {
      g.treasury += pay;
      continue;
    }
    cert.bountyOwed -= pay;
    cert.bountyPaid += pay;
    paid += pay;
    touch();
  }
  return { ok: true, paid };
}

// === Fabrication tribunal ===

function openFabricationCase(kingdomId, reporter, chart) {
  // A fabrication case: someone claimed credit for a chart the real ledger
  // attributes to someone else. No double jeopardy: one open case per chart.
  const st = load();
  const chartId = String(chart.id);
  const existing = Object.values(st.cases).find(
    (c) => String(c.chartId) === chartId && c.status === "open"
  );
  if (existing) return existing.id;
  const caseId = `case-${st.nextCaseId++}`;
  st.cases[caseId] = {
    id: caseId,
    kingdomId,
    kind: "fabrication",
    reporter,
    accused: reporter === "guild" ? "unknown" : null,
    accusedSetAtVote: false,
    chartId,
    recordedAstronomer: chart.astronomer,
    quality: chart.quality,
    votes: {}, // lower(username) -> "guilty" | "innocent"
    status: "open",
    openedMs: Date.now(),
  };
  touch();
  return caseId;
}

function reportFabrication(kingdomId, reporter, chartId) {
  // A member or player reports a suspected fabrication: the chart must be
  // REAL, and the guild's own certification ledger must show someone other
  // than the recorded astronomer holding credit for it.
  const st = load();
  const chart = findChart(kingdomId, chartId);
  if (!chart) return { ok: false, reason: "no-such-chart" };
  const realAstronomer = normalizeName(chart.astronomer);
  const badCert = Object.values(st.certifications).find(
    (c) => String(c.chartId) === String(chartId) && normalizeName(c.astronomer) !== realAstronomer
  );
  if (!badCert) return { ok: false, reason: "no-fabrication-found" };
  const caseId = `case-${st.nextCaseId++}`;
  st.cases[caseId] = {
    id: caseId,
    kingdomId,
    kind: "fabrication",
    reporter,
    accused: badCert.astronomer,
    accusedCertId: badCert.id,
    chartId: String(chartId),
    recordedAstronomer: chart.astronomer,
    quality: chart.quality,
    votes: {},
    status: "open",
    openedMs: Date.now(),
  };
  touch();
  return { ok: true, caseId };
}

function voteOnCase(caseId, voter, verdict) {
  const st = load();
  const c = st.cases[caseId];
  if (!c) return { ok: false, reason: "no-such-case" };
  if (c.status !== "open") return { ok: false, reason: "case-closed" };
  // Only astronomer-rank+ members in good standing may vote.
  const m = memberOf(voter);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  if (m.rank === RANK_STARGAZER) return { ok: false, reason: "rank-too-low" };
  if (verdict !== "guilty" && verdict !== "innocent") {
    return { ok: false, reason: "bad-verdict" };
  }
  c.votes[normalizeName(voter)] = verdict;
  touch();
  return { ok: true };
}

function settleRipeCases(kingdomId, nowMs) {
  const st = load();
  const settled = [];
  for (const c of Object.values(st.cases)) {
    if (c.kingdomId !== kingdomId || c.status !== "open") continue;
    if (nowMs - c.openedMs < CASE_TTL_MS) continue;
    const votes = Object.values(c.votes);
    const guilty = votes.filter((v) => v === "guilty").length;
    const innocent = votes.filter((v) => v === "innocent").length;
    if (votes.length >= VOTES_FOR_QUORUM && guilty > innocent) {
      c.status = "convicted";
      c.verdict = "guilty";
      // Expel the fabricator (if identified) and mark the deed.
      const accusedName = c.accused && c.accused !== "unknown" ? c.accused : null;
      if (accusedName) {
        const key = normalizeName(accusedName);
        if (st.members[key]) {
          st.members[key].cleanRecord = false;
          delete st.members[key];
        }
        try {
          const R = reputationApi();
          if (R && R.awardDeed) R.awardDeed(accusedName, "fraudster");
        } catch { /* deed is best-effort */ }
      }
    } else {
      c.status = "dismissed";
      c.verdict = "innocent";
    }
    settled.push(c.id);
    touch();
  }
  return { ok: true, settled };
}

// === Celestial standards: accuracy audits ===

function accuracyAuditFor(kingdomId) {
  // The guild's accuracy score: computed from REAL data — every guild
  // member's real chart output (CitizenAstronomy.chartsFor). Members with
  // no real charts lower the score. The science tie: members holding real
  // astronomy discoveries are recognized (read-only).
  const st = load();
  const names = memberNames(kingdomId);
  if (!names.length) return { score: 100, members: 0, withCharts: 0, idle: 0, withDiscoveries: 0 };
  let withCharts = 0;
  try {
    const A = astronomyApi();
    const charts = A && A.chartsFor ? (A.chartsFor(kingdomId) || []) : [];
    for (const n of names) {
      if (charts.some((c) => normalizeName(c.astronomer) === normalizeName(n))) withCharts++;
    }
  } catch { /* no charts */ }
  let withDiscoveries = 0;
  try {
    const S = scienceApi();
    const pubs = S && S.recentPublications ? (S.recentPublications(200) || []) : [];
    for (const n of names) {
      const nn = normalizeName(n);
      if (pubs.some((p) => normalizeName(p.author ?? p.username ?? "") === nn &&
        /astronom/i.test(String(p.field ?? p.subject ?? "")))) {
        withDiscoveries++;
      }
    }
  } catch { /* science unreadable */ }
  const score = Math.round((withCharts / names.length) * 100);
  return { score, members: names.length, withCharts, idle: names.length - withCharts, withDiscoveries };
}

// === Eclipse prediction ===

function nextEventFor(kind, fromMs = Date.now()) {
  // Compute the next scheduled occurrence of a celestial event kind from
  // the REAL deterministic schedule — the same month math as
  // CitizenAstronomy.shouldEventBeActive (monthIndex % scheduleMonths ===
  // 0). Never invented: it mirrors the engine's own schedule.
  let scheduleMonths = 0;
  let label = String(kind).replace(/_/g, " ");
  try {
    const A = astronomyApi();
    const spec = A && A.EVENTS ? A.EVENTS[kind] : null;
    if (!spec || !spec.scheduleMonths) return null;
    scheduleMonths = spec.scheduleMonths;
    label = spec.label || label;
  } catch {
    return null;
  }
  const from = new Date(fromMs);
  const fromIndex = from.getFullYear() * 12 + from.getMonth();
  for (let i = 1; i <= PREDICTION_LOOKAHEAD_MONTHS; i++) {
    const idx = fromIndex + i;
    if (idx % scheduleMonths === 0) {
      // idx -> year/month: year = floor(idx/12), month = idx % 12
      const year = Math.floor(idx / 12);
      const month = idx % 12;
      const predictedForMs = Date.UTC(year, month, 1, 0, 0, 0);
      return { kind, label, scheduleMonths, predictedForMs, year, month: month + 1 };
    }
  }
  return null;
}

function predictEvent(kingdomId, predictor, kind) {
  // A starmaster publishes a celestial prediction for the kingdom. The
  // date is computed from the real schedule (nextEventFor); the guild only
  // records the claim.
  const st = load();
  const m = memberOf(predictor);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  if (m.rank !== RANK_STARMASTER) return { ok: false, reason: "rank-too-low" };
  if (m.kingdomId !== kingdomId) return { ok: false, reason: "wrong-kingdom" };
  kind = String(kind || "").toLowerCase().replace(/\s+/g, "_");
  if (!kind) kind = "lunar_eclipse"; // the guild's signature prediction
  const next = nextEventFor(kind);
  if (!next) return { ok: false, reason: "no-such-event" };
  // One open prediction per kind per kingdom.
  const existing = Object.values(st.predictions).find(
    (p) => p.kingdomId === kingdomId && p.kind === kind && p.status === "open"
  );
  if (existing) return { ok: false, reason: "already-predicted", predictionId: existing.id };
  const id = `pred-${st.nextPredictionId++}`;
  st.predictions[id] = {
    id,
    kingdomId,
    kind,
    label: next.label,
    predictedForMs: next.predictedForMs,
    predictedBy: predictor,
    predictedMs: Date.now(),
    status: "open",
  };
  touch();
  return { ok: true, predictionId: id, kind, label: next.label, predictedForMs: next.predictedForMs };
}

function confirmPredictions(kingdomId, nowMs) {
  // Confirm or fail open predictions against the REAL sky: the event is
  // active per CitizenAstronomy.activeEventFor. Confirmed predictions pay
  // the herald and raise prestige; missed ones fail honestly.
  const st = load();
  const confirmed = [];
  const failed = [];
  let activeKind = null;
  try {
    const A = astronomyApi();
    const active = A && A.activeEventFor ? A.activeEventFor(kingdomId, nowMs) : null;
    activeKind = active?.kind ?? null;
  } catch { /* sky unreadable */ }
  for (const p of Object.values(st.predictions)) {
    if (p.kingdomId !== kingdomId || p.status !== "open") continue;
    // The predicted month has arrived (or passed) and the predicted kind is
    // actually in the sky — confirmed. The grace check is strictly AFTER
    // predictedForMs: an earlier same-kind event must never confirm a later
    // prediction.
    if (p.kind === activeKind && nowMs >= p.predictedForMs) {
      // The predicted event is actually in the sky — confirmed.
      p.status = "confirmed";
      p.confirmedMs = nowMs;
      confirmed.push(p.id);
      const g = ensureGuild(kingdomId);
      g.confirmedPredictions = (g.confirmedPredictions || 0) + 1;
      g.prestige = Math.min(100, g.prestige + 5);
      // The herald's prize: 100 real coins into the predictor's REAL bank
      // account, owed honestly when the treasury is broke. When banking is
      // unreachable the deduction rolls back and the full prize stays owed:
      // never mark paid what was never delivered.
      let paid = 0;
      let owed = 0;
      if (g.treasury >= HERALD_PRIZE) {
        g.treasury -= HERALD_PRIZE;
        paid = HERALD_PRIZE;
      } else {
        paid = g.treasury;
        owed = HERALD_PRIZE - paid;
        g.treasury = 0;
      }
      if (paid > 0 && !creditBankAccount(p.predictedBy, paid)) {
        g.treasury += paid;
        owed = HERALD_PRIZE;
        paid = 0;
      }
      p.prizePaid = paid;
      p.prizeOwed = owed;
      try {
        const R = reputationApi();
        if (R && R.awardDeed) R.awardDeed(p.predictedBy, "eclipseherald");
      } catch { /* deed is best-effort */ }
      touch();
    } else if (nowMs > p.predictedForMs + PREDICTION_GRACE_MS) {
      // The date passed and the sky never showed it — failed honestly.
      p.status = "failed";
      p.failedMs = nowMs;
      failed.push(p.id);
      const g = ensureGuild(kingdomId);
      g.failedPredictions = (g.failedPredictions || 0) + 1;
      touch();
    }
  }
  return { ok: true, confirmed, failed };
}

function predictionsFor(kingdomId) {
  const st = load();
  return Object.values(st.predictions)
    .filter((p) => p.kingdomId === kingdomId)
    .sort((a, b) => b.predictedMs - a.predictedMs);
}

// === Silver orrery ===

function grantSilverOrrery(kingdomId, nowMs) {
  const st = load();
  const g = ensureGuild(kingdomId);
  if (nowMs - (g.lastOrreryMs || 0) < ORRERY_PERIOD_MS) {
    return { ok: false, reason: "too-soon" };
  }
  // The member with the most REAL certified charts in the kingdom.
  const counts = {};
  for (const cert of Object.values(st.certifications)) {
    if (cert.kingdomId !== kingdomId) continue;
    const key = normalizeName(cert.astronomer);
    const m = st.members[key];
    if (!m || m.suspended) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { ok: false, reason: "no-candidates" };
  const [winnerKey, count] = entries[0];
  const winner = st.members[winnerKey].username;

  // 200-coin real prize into the winner's REAL bank account; owed honestly
  // when the treasury is broke. When banking is unreachable the deduction
  // rolls back: never mark paid what was never delivered.
  let paid = 0;
  let owed = 0;
  if (g.treasury >= ORRERY_PRIZE) {
    g.treasury -= ORRERY_PRIZE;
    paid = ORRERY_PRIZE;
  } else {
    paid = g.treasury;
    owed = ORRERY_PRIZE - paid;
    g.treasury = 0;
  }
  if (paid > 0 && !creditBankAccount(winner, paid)) {
    g.treasury += paid;
    owed = ORRERY_PRIZE;
    paid = 0;
  }
  g.lastOrreryMs = nowMs;
  try {
    const R = reputationApi();
    if (R && R.awardDeed) R.awardDeed(winner, "silverorrery");
  } catch { /* deed is best-effort */ }
  touch();
  return { ok: true, winner, charts: count, prizePaid: paid, prizeOwed: owed };
}

// === Star-chart school & mentorship ===

function holdClass(kingdomId, master) {
  const st = load();
  const mKey = normalizeName(master);
  const m = st.members[mKey];
  if (!m || m.rank !== RANK_STARMASTER || m.suspended) {
    return { ok: false, reason: "not-a-starmaster" };
  }
  let taught = 0;
  for (const n of memberNames(kingdomId)) {
    const nm = st.members[normalizeName(n)];
    if (nm && nm.rank === RANK_STARGAZER && !nm.suspended) {
      nm.trainingCredits = (nm.trainingCredits || 0) + 1;
      taught++;
    }
  }
  touch();
  return { ok: true, taught };
}

function tryPromote(username) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  const now = Date.now();
  const tenure = now - m.joinedMs;
  if (m.rank === RANK_STARGAZER) {
    // Stargazer -> astronomer: 30d tenure + 2 credits + a real certified chart.
    const hasCert = Object.values(st.certifications).some(
      (c) => normalizeName(c.astronomer) === key
    );
    if (tenure < PROMOTE_ASTRONOMER.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_ASTRONOMER.credits) return { ok: false, reason: "credits" };
    if (!hasCert) return { ok: false, reason: "no-certification" };
    if (!m.cleanRecord) return { ok: false, reason: "record" };
    m.rank = RANK_ASTRONOMER;
    touch();
    return { ok: true, rank: RANK_ASTRONOMER };
  }
  if (m.rank === RANK_ASTRONOMER) {
    // Astronomer -> starmaster: 60d tenure + 4 credits + 2 conducted
    // certifications.
    if (tenure < PROMOTE_STARMASTER.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_STARMASTER.credits) return { ok: false, reason: "credits" };
    if ((m.certificationsConducted || 0) < PROMOTE_STARMASTER.certifications) {
      return { ok: false, reason: "certifications" };
    }
    if (!m.cleanRecord) return { ok: false, reason: "record" };
    m.rank = RANK_STARMASTER;
    try {
      const R = reputationApi();
      if (R && R.awardDeed) R.awardDeed(m.username, "starmaster");
    } catch { /* deed is best-effort */ }
    touch();
    return { ok: true, rank: RANK_STARMASTER };
  }
  return { ok: false, reason: "max-rank" };
}

function takeApprentice(master, stargazer) {
  const st = load();
  const mKey = normalizeName(master);
  const nKey = normalizeName(stargazer);
  const m = st.members[mKey];
  const n = st.members[nKey];
  if (!m || m.rank !== RANK_STARMASTER || m.suspended) {
    return { ok: false, reason: "not-a-starmaster" };
  }
  if (!n || n.rank !== RANK_STARGAZER || n.suspended) {
    return { ok: false, reason: "not-a-stargazer" };
  }
  st.mentorships[nKey] = { master: m.username, sinceMs: Date.now() };
  touch();
  return { ok: true };
}

// === Prestige & treasury ===

function updatePrestige(kingdomId) {
  const st = load();
  const g = st.guilds[kingdomId];
  if (!g) return;
  const certCount = Object.values(st.certifications).filter((c) => c.kingdomId === kingdomId).length;
  const memberCount = memberNames(kingdomId).length;
  const confirmed = g.confirmedPredictions || 0;
  g.prestige = Math.min(100, certCount * 2 + memberCount + confirmed * 5);
}

function guildTreasuryFor(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? { treasury: g.treasury } : null;
}

function contributeToFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  g.treasury += amount;
  touch();
  return { ok: true, treasury: g.treasury };
}

/** Credit coins to the treasury (dues and contributions are guild-held). */
function creditTreasury(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  g.treasury += amount;
  touch();
  return { ok: true, treasury: g.treasury };
}

function describe(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return { exists: false };
  const names = memberNames(kingdomId);
  const certCount = Object.values(load().certifications).filter((c) => c.kingdomId === kingdomId).length;
  const audit = accuracyAuditFor(kingdomId);
  const openPredictions = predictionsFor(kingdomId).filter((p) => p.status === "open").length;
  return {
    exists: true,
    kingdomId,
    memberCount: names.length,
    certified: certCount,
    accuracy: audit.score,
    treasury: g.treasury,
    prestige: g.prestige,
    openPredictions,
    confirmedPredictions: g.confirmedPredictions || 0,
    hallTile: g.hallTile,
  };
}

module.exports = {
  // tuning
  SAVE_KEY,
  COINS_ID,
  RANK_STARGAZER,
  RANK_ASTRONOMER,
  RANK_STARMASTER,
  RANKS,
  DUES_WEEKLY,
  CERT_FEE,
  CERT_BOUNTY,
  ORRERY_PRIZE,
  HERALD_PRIZE,
  // guilds
  ensureGuild,
  guildOf,
  // membership
  isRealAstronomer,
  joinGuild,
  leaveGuild,
  isGuildMember,
  memberOf,
  guildRankOf,
  memberNames,
  recordDuesPayment,
  recordMissedDues,
  // certification
  findChart,
  certifyChart,
  chartCertFor,
  bestGradeFor,
  retryOwedBounties,
  // tribunal
  openFabricationCase,
  reportFabrication,
  voteOnCase,
  settleRipeCases,
  // celestial standards
  accuracyAuditFor,
  // eclipse prediction
  nextEventFor,
  predictEvent,
  confirmPredictions,
  predictionsFor,
  // silver orrery
  grantSilverOrrery,
  // star-chart school & mentorship
  holdClass,
  tryPromote,
  takeApprentice,
  // treasury & prestige
  guildTreasuryFor,
  contributeToFund,
  creditTreasury,
  describe,
  // persistence
  load,
  save,
  touch,
  resetForTests,
  _setSavePathForTests,
};
