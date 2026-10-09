"use strict";

/**
 * CitizenMusicGuilds — the Minstrels' Guild: the music profession's operations
 * layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenMusicDance owns: ensembles, dance troupes, dance halls, ticketed
 *     concerts, lessons, proficiency, instruments (never reimplemented —
 *     READ only).
 *   - CitizenMusicFestivals owns: promoters, festival grounds, multi-day
 *     productions, act bookings, vendors, camping (never reimplemented —
 *     READ only).
 *   - CitizenBards owns: solo minstrels, evening halls, repertoire, ballads,
 *     song requests, tips (never reimplemented — READ only).
 *   - CitizenStreetPerformers owns: amateur buskers (never reimplemented —
 *     READ only).
 *   - CitizenMusicGuild (brain) owns: musicians walking to the guild hall and
 *     holding sessions in human-paced rounds. THIS module owns the
 *     profession's guild layer only.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One Minstrels' Guild per kingdom with a hall tile near the dance hall,
 *     a real tracked treasury, a real tracked instrument fund, and prestige.
 *   - Membership: novice -> minstrel -> maestro. Joining requires being a
 *     REAL musician: the stage-professional registry
 *     (CitizenMusicDance.isStageProfessional), OR the `bard` career
 *     (CitizenCareers.careerOf), OR membership in a real ensemble
 *     (CitizenMusicDance.ensembleOf). The guild polices the trade, never
 *     mints musicians. Weekly dues in REAL coins; two missed online
 *     collections -> suspended until caught up. Offline members are never
 *     penalized.
 *   - Performance certification: members submit performances they REALLY
 *     gave (verified against CitizenMusicDance concert records — the
 *     performer played in a real resolved concert). A 50-coin real fee
 *     (mentored novices certify free). Grades from the REAL concert
 *     quality: >=8=A, >=5=B, else C. The guild pays a REAL bounty from its
 *     treasury (C:30 / B:60 / A:120); the instrument fund backs bounties
 *     when the treasury runs dry; when both are broke the bounty is owed
 *     honestly, never invented.
 *   - Plagiarism tribunal: the one verifiable music crime — a stolen song:
 *     a performance whose normalized title duplicates an EARLIER certified
 *     performance (by createdAt) by a DIFFERENT musician. Members/players
 *     report; minstrel-rank members vote; 24h auto-settle. Guilty ->
 *     expulsion + `songthief` deed.
 *   - Instrument inspections: the guild's harmony score per kingdom is
 *     computed from REAL data — every guild member's real instrument
 *     ownership (CitizenMusicDance.instrumentOf). Members without a real
 *     instrument lower the score. Scores below 40 trigger a public
 *     harmony-audit announcement.
 *   - Golden lyre: quarterly, the guild member with the most REAL certified
 *     performances in the kingdom wins a 200-coin real prize (owed honestly
 *     when broke) and a public announcement.
 *   - Music school: maestro masters teach novices (training credits).
 *     Promotion: novice -> minstrel (30d tenure + 2 credits + a real
 *     certified performance), minstrel -> maestro (60d tenure + 4 credits +
 *     2 conducted certifications + clean record). All verifiable from real
 *     records — never invented.
 *   - Mentorship: maestro masters take novice members under wing. While
 *     mentored, the novice pays no certification fees and their
 *     certifications count double toward promotion. Mentorship ends after
 *     the first certification.
 *   - Certified archive: the guild's certified registry — metadata copies of
 *     every certified performance (the performance stays in the music-dance
 *     ledger; never a double-spend). Prestige 0-100 from real counts.
 *   - Public API: isGuildMember, guildRankOf, memberOf, memberNames,
 *     sealFor, gradeFor, guildTreasuryFor, inspectionFor, describe.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenMusicGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented musicians, performances, inspections, coins, or instruments.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-musicguilds.json";
const COINS_ID = 995;

const RANK_NOVICE = "novice";
const RANK_MINSTREL = "minstrel";
const RANK_MAESTRO = "maestro";
const RANKS = Object.freeze([RANK_NOVICE, RANK_MINSTREL, RANK_MAESTRO]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_INSTRUMENT_SHARE = 5; // of each dues payment feeds the instrument fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const CERT_FEE = 50; // real coins to certify a performance
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const GRADE_A_QUALITY = 8;
const GRADE_B_QUALITY = 5;

const LYRE_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly golden lyre
const LYRE_PRIZE = 200; // real coins from the treasury

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const HALL_TILE_DX = 5; // guild hall sits a few tiles from the dance hall
const HALL_TILE_DY = -4;

const INSPECTION_AUDIT_THRESHOLD = 40; // below this the guild announces an audit

const PROMOTE_MINSTREL = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2 });
const PROMOTE_MAESTRO = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, certifications: 2 });

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
    mentorships: {}, // lower(novice) -> { master, sinceMs }
    nextCertId: 1,
    nextCaseId: 1,
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

function musicDanceApi() {
  try { return require("./CitizenMusicDance"); } catch { return null; }
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

// === Guild management ===

function ensureGuild(kingdomId) {
  const st = load();
  if (!st.guilds[kingdomId]) {
    let hallTile = null;
    try {
      const S = sitesApi();
      const MD = musicDanceApi();
      if (S && MD && MD.danceHallOfKingdom) {
        const hall = MD.danceHallOfKingdom(kingdomId);
        if (hall && hall.tile) {
          hallTile = { x: hall.tile.x + HALL_TILE_DX, y: hall.tile.y + HALL_TILE_DY, z: hall.tile.z || 0 };
        }
      }
    } catch { /* no hall tile */ }
    st.guilds[kingdomId] = {
      kingdomId,
      hallTile,
      treasury: 0,
      instrumentFund: 0,
      prestige: 0,
      foundedMs: Date.now(),
      lastLyreMs: 0,
      reviews: [],
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

function isRealMusician(username) {
  // The guild polices the trade — it never mints musicians. Three verifiable
  // paths: the stage-professional registry, the bard career, or real
  // ensemble membership.
  try {
    const MD = musicDanceApi();
    if (MD && MD.isStageProfessional && MD.isStageProfessional(username)) return true;
  } catch { /* fall through */ }
  try {
    const C = careersApi();
    if (C && C.careerOf && C.careerOf(username) === "bard") return true;
  } catch { /* fall through */ }
  try {
    const MD = musicDanceApi();
    if (MD && MD.ensembleOf && MD.ensembleOf(username)) return true;
  } catch { /* fall through */ }
  return false;
}

function joinGuild(username, kingdomId) {
  const st = load();
  const key = normalizeName(username);
  if (st.members[key]) return { ok: false, reason: "already-member" };
  if (!isRealMusician(username)) return { ok: false, reason: "not-a-musician" };
  ensureGuild(kingdomId);
  const now = Date.now();
  st.members[key] = {
    username,
    kingdomId,
    rank: RANK_NOVICE,
    joinedMs: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS, // first week free
    missedDues: 0,
    suspended: false,
    trainingCredits: 0,
    certificationsConducted: 0,
    cleanRecord: true,
  };
  touch();
  return { ok: true, rank: RANK_NOVICE };
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
  g.treasury += (DUES_WEEKLY - DUES_INSTRUMENT_SHARE);
  g.instrumentFund += DUES_INSTRUMENT_SHARE;
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

// === Performance certification ===

function normalizeTitle(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Non-mutating pre-flight for certification. The ::musicguild certify command
 * validates with this BEFORE taking the player's fee — certifyPerformance
 * creates the certification and pays the bounty, so validating first is the
 * only way a failed validation can never cost the player coins.
 */
function validateCertification(kingdomId, username, concertId) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return { ok: false, reason: "not-a-member" };
  if (m.suspended) return { ok: false, reason: "suspended" };

  // Verify the performance is REAL: the claimant played in a real resolved
  // concert. We read the music-dance ledger defensively — never invent.
  let concert = null;
  try {
    const MD = musicDanceApi();
    if (MD && MD.concertFor) concert = MD.concertFor(concertId);
  } catch { /* no concert */ }
  if (!concert) return { ok: false, reason: "no-such-concert" };
  const performers = concert.performers || concert.lineup || [];
  const played = performers.some((p) => normalizeName(p) === key || normalizeName(p?.username) === key);
  if (!played) return { ok: false, reason: "not-a-performer" };
  const quality = Number(concert.quality);
  if (!Number.isFinite(quality) || quality < 1 || quality > 10) {
    return { ok: false, reason: "no-quality" };
  }
  // No double-certification of the same concert by the same musician.
  const dup = Object.values(st.certifications).some(
    (c) => normalizeName(c.musician) === key && c.concertId === concertId
  );
  if (dup) return { ok: false, reason: "already-certified" };

  // Mentored novices certify free; everyone else pays the real fee.
  const mentored = st.mentorships[key];
  const fee = mentored ? 0 : CERT_FEE;
  return { ok: true, fee, quality, mentored: !!mentored, concertTitle: concert.title };
}

/** Public pre-flight: can this musician certify this concert, and at what fee? */
function canCertify(kingdomId, username, concertId) {
  const v = validateCertification(kingdomId, username, concertId);
  if (!v.ok) return v;
  return { ok: true, fee: v.fee };
}

function certifyPerformance(kingdomId, username, concertId, title) {
  const v = validateCertification(kingdomId, username, concertId);
  if (!v.ok) return v;
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  const g = ensureGuild(kingdomId);

  const grade = v.quality >= GRADE_A_QUALITY ? "A" : v.quality >= GRADE_B_QUALITY ? "B" : "C";
  const certId = `cert-${st.nextCertId++}`;
  const now = Date.now();
  st.certifications[certId] = {
    id: certId,
    kingdomId,
    musician: username,
    concertId,
    title: String(title || v.concertTitle || "untitled performance"),
    quality: v.quality,
    grade,
    feePaid: v.fee,
    bountyPaid: 0,
    bountyOwed: 0,
    certifiedMs: now,
  };

  // Pay the bounty from the treasury; the instrument fund backs it; when
  // both are broke the bounty is owed honestly, never invented.
  const bounty = CERT_BOUNTY[grade];
  let paid = 0;
  let owed = 0;
  if (g.treasury >= bounty) {
    g.treasury -= bounty;
    paid = bounty;
  } else if (g.treasury + g.instrumentFund >= bounty) {
    const fromTreasury = g.treasury;
    const fromFund = bounty - fromTreasury;
    g.treasury = 0;
    g.instrumentFund -= fromFund;
    paid = bounty;
  } else {
    paid = g.treasury + g.instrumentFund;
    owed = bounty - paid;
    g.treasury = 0;
    g.instrumentFund = 0;
  }
  st.certifications[certId].bountyPaid = paid;
  st.certifications[certId].bountyOwed = owed;

  // Mentorship ends after the first certification; the certification counts
  // double toward promotion while mentored.
  if (v.mentored) {
    delete st.mentorships[key];
    m.certificationsConducted = (m.certificationsConducted || 0) + 2;
  } else {
    m.certificationsConducted = (m.certificationsConducted || 0) + 1;
  }

  // Update prestige from real counts.
  updatePrestige(kingdomId);
  touch();
  return { ok: true, certId, grade, fee: v.fee, bountyPaid: paid, bountyOwed: owed };
}

function sealFor(certId) {
  const st = load();
  return st.certifications[certId] || null;
}

function gradeFor(username) {
  const st = load();
  const key = normalizeName(username);
  const certs = Object.values(st.certifications).filter((c) => normalizeName(c.musician) === key);
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
    const available = g.treasury + g.instrumentFund;
    if (available <= 0) break;
    const pay = Math.min(cert.bountyOwed, available);
    // Drain treasury first, then the fund.
    const fromTreasury = Math.min(pay, g.treasury);
    g.treasury -= fromTreasury;
    g.instrumentFund -= (pay - fromTreasury);
    cert.bountyOwed -= pay;
    cert.bountyPaid += pay;
    paid += pay;
    touch();
  }
  return { ok: true, paid };
}

// === Plagiarism tribunal ===

function scanPlagiarism(title) {
  // The one verifiable music crime: a stolen song — a performance whose
  // normalized title duplicates an EARLIER certified performance (by
  // certifiedMs) by a DIFFERENT musician.
  const st = load();
  const norm = normalizeTitle(title);
  if (!norm) return null;
  const matches = Object.values(st.certifications)
    .filter((c) => normalizeTitle(c.title) === norm)
    .sort((a, b) => a.certifiedMs - b.certifiedMs);
  if (matches.length < 2) return null;
  const original = matches[0];
  const latest = matches[matches.length - 1];
  if (normalizeName(original.musician) === normalizeName(latest.musician)) return null;
  return { original, accused: latest };
}

function reportPlagiarism(kingdomId, reporter, title) {
  const st = load();
  const found = scanPlagiarism(title);
  if (!found) return { ok: false, reason: "no-plagiarism-found" };
  // No double jeopardy: one case per accused certification.
  const existing = Object.values(st.cases).find(
    (c) => c.accusedCertId === found.accused.id && c.status !== "dismissed"
  );
  if (existing) return { ok: false, reason: "case-exists", caseId: existing.id };
  const caseId = `case-${st.nextCaseId++}`;
  st.cases[caseId] = {
    id: caseId,
    kingdomId,
    kind: "plagiarism",
    reporter,
    accused: found.accused.musician,
    accusedCertId: found.accused.id,
    originalMusician: found.original.musician,
    title: found.accused.title,
    votes: {}, // lower(username) -> "guilty" | "innocent"
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
  // Only minstrel-rank+ members in good standing may vote.
  const m = memberOf(voter);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  if (m.rank === RANK_NOVICE) return { ok: false, reason: "rank-too-low" };
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
      // Expel the plagiarist and mark the deed.
      const key = normalizeName(c.accused);
      if (st.members[key]) {
        st.members[key].cleanRecord = false;
        delete st.members[key];
      }
      try {
        const R = reputationApi();
        if (R && R.awardDeed) R.awardDeed(c.accused, "songthief");
      } catch { /* deed is best-effort */ }
    } else {
      c.status = "dismissed";
      c.verdict = "innocent";
    }
    settled.push(c.id);
    touch();
  }
  return { ok: true, settled };
}

// === Instrument inspections ===

function inspectionFor(kingdomId) {
  // The guild's harmony score: computed from REAL data — every guild
  // member's real instrument ownership. Members without a real instrument
  // lower the score.
  const st = load();
  const names = memberNames(kingdomId);
  if (!names.length) return { score: 100, members: 0, withInstruments: 0, idle: 0 };
  let withInstruments = 0;
  try {
    const MD = musicDanceApi();
    for (const n of names) {
      try {
        if (MD && MD.instrumentOf && MD.instrumentOf(n)) withInstruments++;
      } catch { /* no instrument */ }
    }
  } catch { /* no music-dance */ }
  const score = Math.round((withInstruments / names.length) * 100);
  return { score, members: names.length, withInstruments, idle: names.length - withInstruments };
}

// === Golden lyre ===

function grantGoldenLyre(kingdomId, nowMs) {
  const st = load();
  const g = ensureGuild(kingdomId);
  if (nowMs - (g.lastLyreMs || 0) < LYRE_PERIOD_MS) {
    return { ok: false, reason: "too-soon" };
  }
  // The member with the most REAL certified performances in the kingdom.
  const counts = {};
  for (const cert of Object.values(st.certifications)) {
    if (cert.kingdomId !== kingdomId) continue;
    const key = normalizeName(cert.musician);
    const m = st.members[key];
    if (!m || m.suspended) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { ok: false, reason: "no-candidates" };
  const [winnerKey, count] = entries[0];
  const winner = st.members[winnerKey].username;

  // 200-coin real prize; owed honestly when the treasury is broke.
  let paid = 0;
  let owed = 0;
  if (g.treasury >= LYRE_PRIZE) {
    g.treasury -= LYRE_PRIZE;
    paid = LYRE_PRIZE;
  } else {
    paid = g.treasury;
    owed = LYRE_PRIZE - paid;
    g.treasury = 0;
  }
  g.lastLyreMs = nowMs;
  try {
    const R = reputationApi();
    if (R && R.awardDeed) R.awardDeed(winner, "goldenlyre");
  } catch { /* deed is best-effort */ }
  touch();
  return { ok: true, winner, performances: count, prizePaid: paid, prizeOwed: owed };
}

// === Music school & mentorship ===

function holdClass(kingdomId, master) {
  const st = load();
  const mKey = normalizeName(master);
  const m = st.members[mKey];
  if (!m || m.rank !== RANK_MAESTRO || m.suspended) {
    return { ok: false, reason: "not-a-maestro" };
  }
  let taught = 0;
  for (const n of memberNames(kingdomId)) {
    const nm = st.members[normalizeName(n)];
    if (nm && nm.rank === RANK_NOVICE && !nm.suspended) {
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
  if (m.rank === RANK_NOVICE) {
    // Novice -> minstrel: 30d tenure + 2 credits + a real certified performance.
    const hasCert = Object.values(st.certifications).some(
      (c) => normalizeName(c.musician) === key
    );
    if (tenure < PROMOTE_MINSTREL.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_MINSTREL.credits) return { ok: false, reason: "credits" };
    if (!hasCert) return { ok: false, reason: "no-certification" };
    if (!m.cleanRecord) return { ok: false, reason: "record" };
    m.rank = RANK_MINSTREL;
    touch();
    return { ok: true, rank: RANK_MINSTREL };
  }
  if (m.rank === RANK_MINSTREL) {
    // Minstrel -> maestro: 60d tenure + 4 credits + 2 conducted certifications.
    if (tenure < PROMOTE_MAESTRO.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_MAESTRO.credits) return { ok: false, reason: "credits" };
    if ((m.certificationsConducted || 0) < PROMOTE_MAESTRO.certifications) {
      return { ok: false, reason: "certifications" };
    }
    if (!m.cleanRecord) return { ok: false, reason: "record" };
    m.rank = RANK_MAESTRO;
    try {
      const R = reputationApi();
      if (R && R.awardDeed) R.awardDeed(m.username, "maestro");
    } catch { /* deed is best-effort */ }
    touch();
    return { ok: true, rank: RANK_MAESTRO };
  }
  return { ok: false, reason: "max-rank" };
}

function takeApprentice(master, novice) {
  const st = load();
  const mKey = normalizeName(master);
  const nKey = normalizeName(novice);
  const m = st.members[mKey];
  const n = st.members[nKey];
  if (!m || m.rank !== RANK_MAESTRO || m.suspended) {
    return { ok: false, reason: "not-a-maestro" };
  }
  if (!n || n.rank !== RANK_NOVICE || n.suspended) {
    return { ok: false, reason: "not-a-novice" };
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
  g.prestige = Math.min(100, certCount * 2 + memberCount);
}

function guildTreasuryFor(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? { treasury: g.treasury, instrumentFund: g.instrumentFund } : null;
}

function contributeToFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  g.instrumentFund += amount;
  touch();
  return { ok: true, fund: g.instrumentFund };
}

function describe(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return { exists: false };
  const names = memberNames(kingdomId);
  const certCount = Object.values(load().certifications).filter((c) => c.kingdomId === kingdomId).length;
  const insp = inspectionFor(kingdomId);
  return {
    exists: true,
    kingdomId,
    memberCount: names.length,
    certified: certCount,
    harmony: insp.score,
    treasury: g.treasury,
    instrumentFund: g.instrumentFund,
    prestige: g.prestige,
    hallTile: g.hallTile,
  };
}

module.exports = {
  // tuning
  SAVE_KEY,
  COINS_ID,
  RANK_NOVICE,
  RANK_MINSTREL,
  RANK_MAESTRO,
  RANKS,
  DUES_WEEKLY,
  CERT_FEE,
  CERT_BOUNTY,
  LYRE_PRIZE,
  // guilds
  ensureGuild,
  guildOf,
  // membership
  isRealMusician,
  joinGuild,
  leaveGuild,
  isGuildMember,
  memberOf,
  guildRankOf,
  memberNames,
  recordDuesPayment,
  recordMissedDues,
  // certification
  normalizeTitle,
  validateCertification,
  canCertify,
  certifyPerformance,
  sealFor,
  gradeFor,
  retryOwedBounties,
  // tribunal
  scanPlagiarism,
  reportPlagiarism,
  voteOnCase,
  settleRipeCases,
  // inspections
  inspectionFor,
  // golden lyre
  grantGoldenLyre,
  // school & mentorship
  holdClass,
  tryPromote,
  takeApprentice,
  // treasury & prestige
  guildTreasuryFor,
  contributeToFund,
  describe,
  // persistence
  load,
  save,
  touch,
  resetForTests,
  _setSavePathForTests,
};
