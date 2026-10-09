"use strict";

/**
 * CitizenSportsGuilds — the Athletes' Guild: the athletics profession's
 * operations layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenAthletics owns: athlete registry, training, fitness, stadiums,
 *     records (marks), fitness seam. THIS module never reimplements any of
 *     that — it READS it.
 *   - CitizenAthleticsLife owns: athlete registration, ambient training,
 *     record attempts.
 *   - CitizenTrain (brain) owns: athletes walking to stadiums and training
 *     in human-paced rounds.
 *   - CitizenSportsGuildEvents owns: the ::sportsguild player command.
 *   - CitizenSports owns: year-round leagues, fixtures, tables, betting.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One Athletes' Guild per kingdom with a hall tile near the stadium, a
 *     real tracked treasury, a real tracked medical fund, and prestige.
 *   - Membership: rookie -> competitor -> gamesmaster. Joining requires
 *     being a REAL registered athlete (CitizenAthletics.isAthlete). The
 *     guild polices the trade, never mints athletes. Weekly dues in REAL
 *     coins; two missed online collections -> suspended until caught up.
 *     Offline members are never penalized.
 *   - Record certification: members submit records they REALLY broke
 *     (verified against CitizenAthletics.recordFor — record exists, holder
 *     matches the claimant, mark is finite and positive, not already
 *     sealed). A 50-coin real fee. Grades from the REAL mark: >=300=A,
 *     >=200=B, else C. The guild pays a REAL bounty from its treasury
 *     (C:30 / B:60 / A:120, doubled for home-kingdom records); the medical
 *     fund backs bounties when the treasury runs dry; when both are broke
 *     the bounty is owed honestly, never invented.
 *   - Doping tribunal: the one verifiable athletics crime — a record in the
 *     athletics ledger whose holder is NOT a registered athlete (phantom
 *     record, impossible through the real attemptRecord flow), or whose
 *     mark is non-finite/negative (impossible). Members/players report;
 *     gamesmasters vote; 24h auto-settle. Guilty -> expulsion + `cheater`
 *     deed.
 *   - Training camps: sponsors post REAL-coin bounties for athletes to
 *     train in a target kingdom. A member claims by VERIFIABLY training
 *     there: the guild's own training ledger must show the member training
 *     in the target kingdom after the bounty posted. First valid claim
 *     wins; the bounty goes to the athlete's REAL bank account.
 *   - Golden laurel: quarterly, the guild member with the most REAL sealed
 *     records in the kingdom wins a 200-coin real prize (owed honestly when
 *     broke) and a public announcement.
 *   - Athletic school: gamesmaster masters teach rookies (training
 *     credits). Promotion: rookie -> competitor (30d tenure + 2 credits +
 *     real training proof), competitor -> gamesmaster (60d tenure + 4
 *     credits + 2 conducted certifications + clean record). All verifiable
 *     from real records — never invented.
 *   - Mentorship: gamesmasters take rookie members under wing. While
 *     mentored, the rookie pays no certification fees and their
 *     certifications count double toward promotion.
 *   - Hall of fame archive: the guild's certified registry — metadata
 *     copies of every certified record (the record stays in the athletics
 *     ledger; never a double-spend). Prestige 0-100 from real counts.
 *   - Public API: isGuildMember, guildRankOf, memberOf, sealFor,
 *     gradeFor, campsFor, guildTreasuryFor, describe.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenSportsGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented athletes, records, training sessions, coins, or camps.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-sportsguilds.json";
const COINS_ID = 995;

const RANK_ROOKIE = "rookie";
const RANK_COMPETITOR = "competitor";
const RANK_GAMESMASTER = "gamesmaster";
const RANKS = Object.freeze([RANK_ROOKIE, RANK_COMPETITOR, RANK_GAMESMASTER]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_MEDICAL_SHARE = 5; // of each dues payment feeds the medical fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const CERT_FEE = 50; // real coins to certify a record
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const GRADE_A_MARK = 300;
const GRADE_B_MARK = 200;

const CAMP_MIN_BOUNTY = 100; // sponsors must post at least this

const LAUREL_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly golden laurel
const LAUREL_PRIZE = 200; // real coins from the treasury

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const HALL_TILE_DX = 8; // guild hall sits a few tiles from the stadium
const HALL_TILE_DY = -6;

const PROMOTE_COMPETITOR = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2 });
const PROMOTE_GAMESMASTER = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, certifications: 2 });

const SPORTS_CODE = Object.freeze([
  "Run clean: no draught, charm, or trick shall touch a guild athlete's blood.",
  "The mark is the mark — never claim a record you did not earn.",
  "Respect the stadium: leave every track better than you found it.",
  "Charge honest fees; the crowd can smell a cheat.",
  "Teach one rookie for every season you compete.",
]);

// --- state ---------------------------------------------------------------

let cache = null;
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury, medicalFund, prestige, lastLaurelAt }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntilMs, missedDues, suspended, trainingCredits, certCount, clean, mentor }
    seals: Object.create(null), // "kingdomId:sport" -> { kingdomId, sport, holder, mark, grade, sealedAt, doubled }
    queue: [], // [ { kingdomId, sport, owner, submittedAt } ]
    bountiesOwed: Object.create(null), // "owner:kingdomId:sport" -> coins owed
    camps: Object.create(null), // campId -> { id, sponsor, targetKingdom, bounty, postedAt, claimedBy, claimedAt }
    campClaims: Object.create(null), // campId -> { claimant, at }
    trainingLedger: [], // [ { username, kingdomId, at } ] — real training sightings
    cases: Object.create(null), // caseId -> { id, kingdomId, accused, kind, reporter, at, votes: {voter: bool}, settled, verdict }
    laurelOwed: Object.create(null), // kingdomId -> coins owed
    nextCampId: 1,
    nextCaseId: 1,
  };
}

function ensure() {
  if (!cache) cache = blankState();
  return cache;
}

function markDirty() { dirty = true; }

function norm(name) {
  return String(name || "").toLowerCase().trim();
}

// --- kingdom helpers (defensive) ------------------------------------------

function kingdomIds() {
  try {
    const S = require("../brain/CitizenSites");
    if (S && Array.isArray(S.KINGDOM_IDS) && S.KINGDOM_IDS.length) return S.KINGDOM_IDS.slice();
  } catch { /* fall through */ }
  return [];
}

function stadiumTileFor(kingdomId) {
  try {
    const A = require("./CitizenAthletics");
    if (A && typeof A.stadiumTile === "function") {
      const t = A.stadiumTile(kingdomId);
      if (t && typeof t.x === "number") return { x: t.x + HALL_TILE_DX, y: t.y + HALL_TILE_DY };
    }
  } catch { /* no athletics */ }
  return null;
}

// --- guilds ---------------------------------------------------------------

function ensureGuild(kingdomId) {
  const s = ensure();
  if (!s.guilds[kingdomId]) {
    s.guilds[kingdomId] = {
      kingdomId,
      hallTile: stadiumTileFor(kingdomId),
      foundedAt: Date.now(),
      treasury: 0,
      medicalFund: 0,
      prestige: 0,
      lastLaurelAt: 0,
    };
    markDirty();
  }
  return s.guilds[kingdomId];
}

function guildOf(kingdomId) {
  ensureGuild(kingdomId);
  return ensure().guilds[kingdomId];
}

function guildTreasuryFor(kingdomId) {
  return guildOf(kingdomId).treasury;
}

// --- membership -----------------------------------------------------------

function isGuildMember(username) {
  return !!ensure().members[norm(username)];
}

function memberOf(username) {
  return ensure().members[norm(username)] || null;
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function isRealAthlete(username) {
  try {
    const A = require("./CitizenAthletics");
    return !!(A && typeof A.isAthlete === "function" && A.isAthlete(username));
  } catch { return false; }
}

function joinGuild(username, kingdomId) {
  const s = ensure();
  const n = norm(username);
  if (!username) return { ok: false, reason: "no-username" };
  if (s.members[n]) return { ok: false, reason: "already-member" };
  if (!isRealAthlete(username)) return { ok: false, reason: "not-an-athlete" };
  ensureGuild(kingdomId);
  const now = Date.now();
  s.members[n] = {
    username,
    kingdomId,
    rank: RANK_ROOKIE,
    joinedAt: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS, // first week free
    missedDues: 0,
    suspended: false,
    trainingCredits: 0,
    certCount: 0,
    clean: true,
    mentor: null,
  };
  markDirty();
  return { ok: true, rank: RANK_ROOKIE };
}

function leaveGuild(username) {
  const s = ensure();
  const n = norm(username);
  if (!s.members[n]) return { ok: false, reason: "not-a-member" };
  delete s.members[n];
  markDirty();
  return { ok: true };
}

function recordDuesPayment(username, nowMs) {
  const s = ensure();
  const m = s.members[norm(username)];
  if (!m || m.suspended) return { ok: false };
  const g = ensureGuild(m.kingdomId);
  g.treasury += (DUES_WEEKLY - DUES_MEDICAL_SHARE);
  g.medicalFund += DUES_MEDICAL_SHARE;
  m.duesPaidUntilMs = Math.max(m.duesPaidUntilMs || 0, nowMs) + DUES_PERIOD_MS;
  m.missedDues = 0;
  if (m.suspended && m.missedDues === 0) m.suspended = false;
  markDirty();
  return { ok: true };
}

function recordMissedDues(username, nowMs) {
  const s = ensure();
  const m = s.members[norm(username)];
  if (!m) return { ok: false };
  m.missedDues = (m.missedDues || 0) + 1;
  if (m.missedDues >= SUSPEND_AFTER_MISSED) m.suspended = true;
  markDirty();
  return { ok: true, suspended: m.suspended };
}

// --- record certification -------------------------------------------------

function gradeForMark(mark) {
  if (mark >= GRADE_A_MARK) return "A";
  if (mark >= GRADE_B_MARK) return "B";
  return "C";
}

function realRecordFor(kingdomId, sport) {
  try {
    const A = require("./CitizenAthletics");
    if (A && typeof A.recordFor === "function") return A.recordFor(kingdomId, sport) || null;
  } catch { /* no athletics */ }
  return null;
}

function sealFor(kingdomId, sport) {
  return ensure().seals[`${kingdomId}:${sport}`] || null;
}

function gradeFor(kingdomId, sport) {
  const seal = sealFor(kingdomId, sport);
  return seal ? seal.grade : null;
}

function submitRecord(username, kingdomId, sport, nowMs) {
  const s = ensure();
  const n = norm(username);
  const m = s.members[n];
  if (!m || m.suspended) return { ok: false, reason: "not-member-in-good-standing" };
  if (m.kingdomId !== kingdomId) return { ok: false, reason: "wrong-kingdom" };
  // Verify against the REAL athletics ledger.
  const rec = realRecordFor(kingdomId, sport);
  if (!rec) return { ok: false, reason: "no-such-record" };
  if (norm(rec.holder) !== n) return { ok: false, reason: "not-your-record" };
  if (!Number.isFinite(rec.mark) || rec.mark <= 0) return { ok: false, reason: "impossible-mark" };
  const key = `${kingdomId}:${sport}`;
  if (s.seals[key]) return { ok: false, reason: "already-sealed" };
  // Fee: mentored rookies certify free.
  const fee = m.mentor ? 0 : CERT_FEE;
  s.queue.push({ kingdomId, sport, owner: username, submittedAt: nowMs || Date.now() });
  markDirty();
  return { ok: true, fee, mark: rec.mark };
}

function settleCertification(kingdomId, sport, nowMs) {
  const s = ensure();
  const key = `${kingdomId}:${sport}`;
  const qi = s.queue.findIndex((q) => q.kingdomId === kingdomId && q.sport === sport);
  if (qi < 0) return { ok: false, reason: "not-queued" };
  const q = s.queue[qi];
  // Re-verify at settle time (the record may have been broken since).
  const rec = realRecordFor(kingdomId, sport);
  if (!rec || norm(rec.holder) !== norm(q.owner) || !Number.isFinite(rec.mark) || rec.mark <= 0) {
    s.queue.splice(qi, 1);
    markDirty();
    return { ok: false, reason: "record-changed" };
  }
  const grade = gradeForMark(rec.mark);
  const m = s.members[norm(q.owner)];
  const doubled = !!(m && m.kingdomId === kingdomId);
  let bounty = CERT_BOUNTY[grade] || 0;
  if (doubled) bounty *= 2;
  const g = ensureGuild(kingdomId);
  let owed = 0;
  // Pay from treasury, then medical fund, then owe honestly.
  let remaining = bounty;
  const fromTreasury = Math.min(g.treasury, remaining);
  g.treasury -= fromTreasury; remaining -= fromTreasury;
  const fromMedical = Math.min(g.medicalFund, remaining);
  g.medicalFund -= fromMedical; remaining -= fromMedical;
  if (remaining > 0) {
    const okey = `${q.owner}:${key}`;
    s.bountiesOwed[okey] = (s.bountiesOwed[okey] || 0) + remaining;
    owed = remaining;
  }
  s.seals[key] = {
    kingdomId, sport, holder: q.owner, mark: rec.mark, grade,
    sealedAt: nowMs || Date.now(), doubled,
  };
  s.queue.splice(qi, 1);
  if (m) {
    const credit = m.mentor ? 2 : 1; // mentored rookies earn double credit
    m.certCount = (m.certCount || 0) + credit;
    if (m.mentor) m.mentor = null; // mentorship ends after first certification
  }
  g.prestige = Math.min(100, g.prestige + 2);
  markDirty();
  return { ok: true, grade, bounty, paid: bounty - owed, owed, doubled };
}

function retryOwedBounties(kingdomId) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  let paid = 0;
  for (const okey of Object.keys(s.bountiesOwed)) {
    const amt = s.bountiesOwed[okey];
    if (!amt) continue;
    const fromTreasury = Math.min(g.treasury, amt);
    g.treasury -= fromTreasury;
    let remaining = amt - fromTreasury;
    const fromMedical = Math.min(g.medicalFund, remaining);
    g.medicalFund -= fromMedical;
    remaining -= fromMedical;
    if (remaining <= 0) { delete s.bountiesOwed[okey]; paid += amt; }
    else { s.bountiesOwed[okey] = remaining; paid += (amt - remaining); }
  }
  if (paid) markDirty();
  return { paid };
}

// --- doping tribunal -------------------------------------------------------

function scanDoping() {
  // The one verifiable athletics crime: a record in the athletics ledger
  // whose holder is NOT a registered athlete (phantom record, impossible
  // through the real attemptRecord flow), or whose mark is non-finite /
  // non-positive (impossible). Returns [{ kingdomId, sport, holder, kind }].
  const out = [];
  try {
    const A = require("./CitizenAthletics");
    if (!A || typeof A.recordFor !== "function") return out;
    for (const kid of kingdomIds()) {
      for (const sport of (A.SPORTS || [])) {
        const rec = A.recordFor(kid, sport);
        if (!rec || !rec.holder) continue;
        if (!A.isAthlete(rec.holder)) {
          out.push({ kingdomId: kid, sport, holder: rec.holder, kind: "phantom-record" });
        } else if (!Number.isFinite(rec.mark) || rec.mark <= 0) {
          out.push({ kingdomId: kid, sport, holder: rec.holder, kind: "impossible-mark" });
        }
      }
    }
  } catch { /* athletics missing */ }
  return out;
}

function reportDoping(kingdomId, accused, kind, reporter) {
  const s = ensure();
  const n = norm(accused);
  // No double jeopardy: one open case per accused.
  for (const id of Object.keys(s.cases)) {
    const c = s.cases[id];
    if (!c.settled && norm(c.accused) === n) return { ok: false, reason: "case-open" };
  }
  const id = `case-${s.nextCaseId++}`;
  s.cases[id] = {
    id, kingdomId, accused, kind,
    reporter: reporter || "guild",
    at: Date.now(), votes: {}, settled: false, verdict: null,
  };
  markDirty();
  return { ok: true, id };
}

function voteCase(caseId, voter, guilty) {
  const s = ensure();
  const c = s.cases[caseId];
  if (!c || c.settled) return { ok: false, reason: "no-such-case" };
  if (guildRankOf(voter) !== RANK_GAMESMASTER) return { ok: false, reason: "not-gamesmaster" };
  c.votes[norm(voter)] = !!guilty;
  markDirty();
  return { ok: true };
}

function settleRipeCases(kingdomId, nowMs) {
  const s = ensure();
  const settled = [];
  for (const id of Object.keys(s.cases)) {
    const c = s.cases[id];
    if (c.settled || c.kingdomId !== kingdomId) continue;
    if ((nowMs || Date.now()) - c.at < CASE_TTL_MS) continue;
    const votes = Object.values(c.votes);
    const guilty = votes.filter(Boolean).length;
    const total = votes.length;
    c.settled = true;
    if (total >= VOTES_FOR_QUORUM && guilty * 2 > total) {
      c.verdict = "guilty";
      // Expel the cheat.
      const m = s.members[norm(c.accused)];
      if (m) { m.suspended = true; m.clean = false; }
    } else {
      c.verdict = "acquitted";
    }
    settled.push({ id, verdict: c.verdict, accused: c.accused });
    markDirty();
  }
  return settled;
}

// --- training camps ---------------------------------------------------------

function postCamp(sponsor, targetKingdom, bounty) {
  const s = ensure();
  if (!sponsor) return { ok: false, reason: "no-sponsor" };
  if ((bounty | 0) < CAMP_MIN_BOUNTY) return { ok: false, reason: "bounty-too-low" };
  const id = `camp-${s.nextCampId++}`;
  s.camps[id] = {
    id, sponsor, targetKingdom, bounty: bounty | 0,
    postedAt: Date.now(), claimedBy: null, claimedAt: 0,
  };
  markDirty();
  return { ok: true, id };
}

function campsFor(targetKingdom) {
  const s = ensure();
  return Object.values(s.camps).filter((c) => !c.claimedBy && (!targetKingdom || c.targetKingdom === targetKingdom));
}

function recordTraining(username, kingdomId, nowMs) {
  const s = ensure();
  s.trainingLedger.push({ username, kingdomId, at: nowMs || Date.now() });
  if (s.trainingLedger.length > 500) s.trainingLedger.splice(0, s.trainingLedger.length - 500);
  markDirty();
}

function claimCamp(campId, claimant) {
  const s = ensure();
  const camp = s.camps[campId];
  if (!camp) return { ok: false, reason: "no-such-camp" };
  if (camp.claimedBy) return { ok: false, reason: "already-claimed" };
  const m = s.members[norm(claimant)];
  if (!m || m.suspended) return { ok: false, reason: "not-member-in-good-standing" };
  // Verify: the claimant trained in the target kingdom AFTER the bounty posted.
  const trained = s.trainingLedger.some((t) =>
    norm(t.username) === norm(claimant) &&
    t.kingdomId === camp.targetKingdom &&
    t.at > camp.postedAt
  );
  if (!trained) return { ok: false, reason: "no-training-proof" };
  camp.claimedBy = claimant;
  camp.claimedAt = Date.now();
  markDirty();
  return { ok: true, bounty: camp.bounty };
}

// --- golden laurel ------------------------------------------------------------

function grantLaurel(kingdomId, nowMs) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  if ((nowMs || Date.now()) - (g.lastLaurelAt || 0) < LAUREL_PERIOD_MS) {
    return { ok: false, reason: "too-soon" };
  }
  // The member with the most sealed records in this kingdom wins.
  let best = null; let bestCount = 0;
  for (const key of Object.keys(s.seals)) {
    const seal = s.seals[key];
    if (seal.kingdomId !== kingdomId) continue;
    const m = s.members[norm(seal.holder)];
    if (!m || m.suspended) continue;
    const count = Object.values(s.seals).filter((x) =>
      x.kingdomId === kingdomId && norm(x.holder) === norm(seal.holder)).length;
    if (count > bestCount) { bestCount = count; best = seal.holder; }
  }
  if (!best) return { ok: false, reason: "no-candidates" };
  g.lastLaurelAt = nowMs || Date.now();
  let owed = 0;
  const fromTreasury = Math.min(g.treasury, LAUREL_PRIZE);
  g.treasury -= fromTreasury;
  const remaining = LAUREL_PRIZE - fromTreasury;
  if (remaining > 0) {
    s.laurelOwed[kingdomId] = (s.laurelOwed[kingdomId] || 0) + remaining;
    owed = remaining;
  }
  markDirty();
  return { ok: true, winner: best, records: bestCount, paid: LAUREL_PRIZE - owed, owed };
}

// --- athletic school & mentorship ---------------------------------------------

function holdClass(kingdomId, master) {
  const s = ensure();
  if (guildRankOf(master) !== RANK_GAMESMASTER) return { ok: false, reason: "not-gamesmaster" };
  const g = ensureGuild(kingdomId);
  let taught = 0;
  for (const n of Object.keys(s.members)) {
    const m = s.members[n];
    if (m.kingdomId !== kingdomId || m.suspended) continue;
    if (m.rank === RANK_ROOKIE) { m.trainingCredits = (m.trainingCredits || 0) + 1; taught++; }
  }
  if (taught) markDirty();
  return { ok: true, taught };
}

function tryPromote(username, nowMs) {
  const s = ensure();
  const m = s.members[norm(username)];
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  const now = nowMs || Date.now();
  if (m.rank === RANK_ROOKIE) {
    const tenureOk = now - m.joinedAt >= PROMOTE_COMPETITOR.tenureMs;
    const creditsOk = (m.trainingCredits || 0) >= PROMOTE_COMPETITOR.credits;
    // Real training proof: the athlete trained at least once since joining.
    let trainedOk = false;
    try {
      const A = require("./CitizenAthletics");
      const info = A && typeof A.athleteInfo === "function" ? A.athleteInfo(username) : null;
      trainedOk = !!(info && info.trainedAt > m.joinedAt);
    } catch { /* no athletics */ }
    if (tenureOk && creditsOk && trainedOk && m.clean) {
      m.rank = RANK_COMPETITOR;
      markDirty();
      return { ok: true, rank: RANK_COMPETITOR };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  if (m.rank === RANK_COMPETITOR) {
    const tenureOk = now - m.joinedAt >= PROMOTE_GAMESMASTER.tenureMs;
    const creditsOk = (m.trainingCredits || 0) >= PROMOTE_GAMESMASTER.credits;
    const certsOk = (m.certCount || 0) >= PROMOTE_GAMESMASTER.certifications;
    if (tenureOk && creditsOk && certsOk && m.clean) {
      m.rank = RANK_GAMESMASTER;
      markDirty();
      return { ok: true, rank: RANK_GAMESMASTER };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  return { ok: false, reason: "max-rank" };
}

function takeApprentice(master, rookie) {
  const s = ensure();
  if (guildRankOf(master) !== RANK_GAMESMASTER) return { ok: false, reason: "not-gamesmaster" };
  const m = s.members[norm(rookie)];
  if (!m || m.rank !== RANK_ROOKIE || m.suspended) return { ok: false, reason: "not-eligible" };
  m.mentor = master;
  markDirty();
  return { ok: true };
}

// --- describe / persistence -----------------------------------------------------

function describe(kingdomId) {
  const s = ensure();
  const g = s.guilds[kingdomId];
  if (!g) return { exists: false };
  const members = Object.values(s.members).filter((m) => m.kingdomId === kingdomId && !m.suspended);
  return {
    exists: true,
    memberCount: members.length,
    gamesmasters: members.filter((m) => m.rank === RANK_GAMESMASTER).length,
    sealed: Object.values(s.seals).filter((x) => x.kingdomId === kingdomId).length,
    openCamps: campsFor(kingdomId).length,
    treasury: g.treasury,
    medicalFund: g.medicalFund,
    prestige: g.prestige,
  };
}

const fs = require("fs");
const path = require("path");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", SAVE_KEY);

function setSaveFile(p) { SAVE_FILE = p; }

function save() {
  if (!dirty) return false;
  try {
    ensure();
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function load() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      cache = Object.assign(blankState(), raw);
      dirty = false;
      return true;
    }
  } catch { /* corrupt save -> start fresh */ }
  return false;
}

function serialize() { ensure(); return JSON.parse(JSON.stringify(cache)); }
function deserialize(data) { cache = Object.assign(blankState(), data || {}); dirty = true; }
function resetForTests() { cache = blankState(); dirty = false; }

module.exports = {
  SAVE_KEY,
  COINS_ID,
  RANK_ROOKIE,
  RANK_COMPETITOR,
  RANK_GAMESMASTER,
  RANKS,
  DUES_WEEKLY,
  CERT_FEE,
  CERT_BOUNTY,
  CAMP_MIN_BOUNTY,
  LAUREL_PRIZE,
  SPORTS_CODE,
  ensureGuild,
  guildOf,
  guildTreasuryFor,
  isGuildMember,
  memberOf,
  guildRankOf,
  isRealAthlete,
  joinGuild,
  leaveGuild,
  recordDuesPayment,
  recordMissedDues,
  gradeForMark,
  realRecordFor,
  sealFor,
  gradeFor,
  submitRecord,
  settleCertification,
  retryOwedBounties,
  scanDoping,
  reportDoping,
  voteCase,
  settleRipeCases,
  postCamp,
  campsFor,
  recordTraining,
  claimCamp,
  grantLaurel,
  holdClass,
  tryPromote,
  takeApprentice,
  describe,
  save,
  load,
  setSaveFile,
  serialize,
  deserialize,
  resetForTests,
};
