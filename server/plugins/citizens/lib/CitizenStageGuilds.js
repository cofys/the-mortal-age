"use strict";

/**
 * CitizenStageGuilds — the Players' Guild: the theater profession's
 * operations layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenTheater owns: playwrights, plays, theaters, troupes, touring,
 *     performances, ticket sales, reviews, upkeep, royalties. THIS module
 *     never reimplements any of that — it READS it.
 *   - CitizenTheaterLife owns: playwright registration, ambient playwriting,
 *     troupe formation, tour settlement.
 *   - CitizenRehearse (brain) owns: troupe members walking to theaters and
 *     rehearsing in human-paced rounds.
 *   - CitizenTheaterEvents owns: the ::stage player command.
 *   - CitizenActors owns: scripted performance scenes (hash-derived flavor).
 *   - CitizenEntertainment owns: the Varrock house theater + 10-coin tickets.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One Players' Guild per kingdom with a hall tile near the theater, a
 *     real tracked treasury, a real tracked relief fund, and prestige.
 *   - Membership: player -> performer -> stagemaster. Joining requires
 *     being a REAL theater professional (registered playwright, member of
 *     a real troupe, or the actor/playwright career). The guild polices
 *     the trade, never mints professionals. Weekly dues in REAL coins;
 *     two missed online collections -> suspended until caught up. Offline
 *     members are never penalized.
 *   - Play certification: members submit plays they REALLY wrote (verified
 *     against CitizenTheater.playFor — record exists, playwright matches,
 *     not already sealed). A 50-coin real fee. Grades from the REAL
 *     quality: 1-4=C, 5-7=B, 8-10=A. The guild pays a REAL production
 *     bounty from its treasury (C:30 / B:60 / A:120, doubled for
 *     home-kingdom history/epic plays through the culture seam); the
 *     relief fund backs bounties when the treasury runs dry; when both
 *     are broke the bounty is owed honestly, never invented.
 *   - Plagiarism tribunal: the one verifiable theater crime — a play whose
 *     normalized title duplicates an EARLIER play by a different
 *     playwright. Members/players report; stagemasters vote; 24h
 *     auto-settle. Guilty -> expulsion + `plagiarist` deed.
 *   - Touring circuits: sponsors post REAL-coin bounties for troupes to
 *     tour a target kingdom. A troupe claims by VERIFIABLY touring there:
 *     the guild's own location ledger must show the troupe moving into
 *     the target kingdom after the bounty posted, and the troupe must
 *     carry at least one guild member in good standing. First valid claim
 *     wins; the bounty goes to the troupe's REAL treasury.
 *   - Critics' choice laurel: quarterly, the troupe with the most REAL
 *     5-star reviews in the kingdom wins a 200-coin real prize (owed
 *     honestly when broke) and a public announcement.
 *   - Stage school: stagemaster masters teach players (training credits).
 *     Promotion: player -> performer (30d tenure + 2 credits + real stage
 *     proof: troupe membership or 3 real plays written), performer ->
 *     stagemaster (60d tenure + 4 credits + 2 conducted certifications +
 *     clean record). All verifiable from real records — never invented.
 *   - Mentorship: stagemasters take player-rank members under wing. While
 *     mentored, the player pays no certification fees and their
 *     certifications count double toward promotion.
 *   - Repertoire archive: the guild's certified registry — metadata copies
 *     of every certified play (the play stays with its playwright; never
 *     a double-spend). Prestige 0-100 from real counts.
 *   - Public API: isGuildMember, guildRankOf, memberOf, sealFor,
 *     gradeFor, circuitsFor, guildTreasuryFor, describe.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenStageGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented plays, troupes, tours, reviews, coins, or locations.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-stageguilds.json";
const COINS_ID = 995;

const RANK_PLAYER = "player";
const RANK_PERFORMER = "performer";
const RANK_STAGEMASTER = "stagemaster";
const RANKS = Object.freeze([RANK_PLAYER, RANK_PERFORMER, RANK_STAGEMASTER]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_RELIEF_SHARE = 5; // of each dues payment feeds the relief fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const CERT_FEE = 50; // real coins to certify a play
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const CERT_BOUNTY_DOUBLE_GENRES = Object.freeze(["history", "epic"]); // culture seam

const CIRCUIT_MIN_BOUNTY = 100; // sponsors must post at least this

const LAUREL_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly critics' choice
const LAUREL_PRIZE = 200; // real coins from the treasury

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const HALL_TILE_DX = 8; // guild hall sits a few tiles from the theater
const HALL_TILE_DY = -6;

const PROMOTE_PERFORMER = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2 });
const PROMOTE_STAGEMASTER = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, certifications: 2 });

const STAGE_CODE = Object.freeze([
  "The play is the thing: never claim another's words as your own.",
  "The show goes on — a player's word to the troupe is iron.",
  "Respect the boards: leave every stage better than you found it.",
  "Charge honest prices; the crowd can smell a cheat.",
  "Teach one player for every season you play.",
]);

// --- state ---------------------------------------------------------------

let cache = null;
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury, reliefFund, prestige, lastLaurelAt }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntilMs, missedDues, suspended, trainingCredits, certCount, clean }
    seals: Object.create(null), // playId -> { playId, title, playwright, grade, genre, kingdomId, sealedAt, doubled }
    queue: [], // [ { playId, owner, kingdomId, submittedAt } ]
    bountiesOwed: Object.create(null), // "owner:playId" -> coins owed
    circuits: Object.create(null), // id -> { id, kingdomId, targetKingdom, sponsor, bounty, postedAt, status, claimedBy }
    lastSeen: Object.create(null), // troupeLower -> { kingdomId, at } — guild's own tour ledger
    cases: Object.create(null), // id -> { id, kingdomId, accused, playId, kind, reporter, filedAt, votes: {voter: verdict}, status }
    mentorships: Object.create(null), // apprenticeNorm -> masterNorm
    laurels: [], // [ { kingdomId, troupe, stars, fiveStarCount, at } ]
    nextCircuitId: 1,
    nextCaseId: 1,
  };
}

function savePath() {
  try {
    return require("path").join(process.cwd(), "data", "saves", SAVE_KEY);
  } catch {
    return SAVE_KEY;
  }
}

let SAVE_FILE = savePath();

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
}

function load() {
  if (cache) return cache;
  try {
    const fs = require("fs");
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      cache = Object.assign(blankState(), raw);
      cache.guilds = cache.guilds || Object.create(null);
      cache.members = cache.members || Object.create(null);
      cache.seals = cache.seals || Object.create(null);
      cache.queue = Array.isArray(cache.queue) ? cache.queue : [];
      cache.bountiesOwed = cache.bountiesOwed || Object.create(null);
      cache.circuits = cache.circuits || Object.create(null);
      cache.lastSeen = cache.lastSeen || Object.create(null);
      cache.cases = cache.cases || Object.create(null);
      cache.mentorships = cache.mentorships || Object.create(null);
      cache.laurels = Array.isArray(cache.laurels) ? cache.laurels : [];
      return cache;
    }
  } catch { /* corrupt save -> start fresh */ }
  cache = blankState();
  return cache;
}

function markDirty() { dirty = true; }

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(load(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

// --- helpers -------------------------------------------------------------

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function normTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function theaterApi() {
  try { return require("./CitizenTheater"); }
  catch { return null; }
}

function sitesApi() {
  try { return require("../brain/CitizenSites"); }
  catch { return null; }
}

function careersApi() {
  try { return require("./CitizenCareers"); }
  catch { return null; }
}

function repApi() {
  try { return require("./CitizenReputation"); }
  catch { return null; }
}

function gradeForQuality(q) {
  const n = Number(q) || 0;
  if (n >= 8) return "A";
  if (n >= 5) return "B";
  return "C";
}

/** Is this username a REAL theater professional? Playwright, troupe member, or stage career. */
function isTheaterProfessional(username) {
  const key = norm(username);
  if (!key) return false;
  try {
    const T = theaterApi();
    if (T) {
      if (typeof T.isPlaywright === "function" && T.isPlaywright(username)) return true;
      // troupe membership: scan every kingdom's troupes for the name
      const S = sitesApi();
      const kids = (S && Array.isArray(S.KINGDOM_IDS) && S.KINGDOM_IDS.length) ? S.KINGDOM_IDS : [];
      for (const kid of kids) {
        try {
          const troupes = T.troupesIn(kid) || [];
          for (const t of troupes) {
            if (Array.isArray(t.members) && t.members.some((m) => norm(m) === key)) return true;
          }
        } catch { /* keep scanning */ }
      }
    }
  } catch { /* fall through to career check */ }
  try {
    const C = careersApi();
    if (C && typeof C.careerOf === "function") {
      const career = norm(C.careerOf(username));
      if (career === "actor" || career === "playwright") return true;
    }
  } catch { /* no careers */ }
  return false;
}

/** Count real plays written by a username (for promotion proof). */
function playsWrittenCount(username) {
  try {
    const T = theaterApi();
    if (T && typeof T.playsBy === "function") {
      return (T.playsBy(username) || []).length;
    }
  } catch { /* no theater */ }
  return 0;
}

/** Is the username in any real troupe's roster? */
function troupeMemberSomewhere(username) {
  const key = norm(username);
  if (!key) return false;
  try {
    const T = theaterApi();
    const S = sitesApi();
    if (!T || !S) return false;
    const kids = Array.isArray(S.KINGDOM_IDS) ? S.KINGDOM_IDS : [];
    for (const kid of kids) {
      try {
        for (const t of T.troupesIn(kid) || []) {
          if (Array.isArray(t.members) && t.members.some((m) => norm(m) === key)) return true;
        }
      } catch { /* keep scanning */ }
    }
  } catch { /* no */ }
  return false;
}

// --- guilds --------------------------------------------------------------

function ensureGuild(kingdomId) {
  const st = load();
  const kid = norm(kingdomId);
  if (!kid) return null;
  if (!st.guilds[kid]) {
    let hallTile = { x: 3200, y: 3200, z: 0 };
    try {
      const T = theaterApi();
      if (T && typeof T.theaterTileFor === "function") {
        const tt = T.theaterTileFor(kid);
        if (tt) hallTile = { x: (tt.x || 0) + HALL_TILE_DX, y: (tt.y || 0) + HALL_TILE_DY, z: tt.z || 0 };
      }
    } catch { /* default tile */ }
    st.guilds[kid] = {
      kingdomId: kid, hallTile, foundedAt: Date.now(),
      treasury: 0, reliefFund: 0, prestige: 0, lastLaurelAt: 0,
    };
    markDirty();
  }
  return st.guilds[kid];
}

function guildOf(kingdomId) {
  const kid = norm(kingdomId);
  return kid ? load().guilds[kid] || null : null;
}

function guildTreasuryFor(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? { treasury: g.treasury || 0, reliefFund: g.reliefFund || 0 } : null;
}

// --- membership ----------------------------------------------------------

function memberOf(username) {
  const key = norm(username);
  return key ? load().members[key] || null : null;
}

function isGuildMember(username) {
  const m = memberOf(username);
  return !!(m && !m.suspended);
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function joinGuild(username, kingdomId) {
  const st = load();
  const key = norm(username);
  const kid = norm(kingdomId);
  if (!key) return { ok: false, reason: "no name" };
  if (!kid) return { ok: false, reason: "no kingdom" };
  if (st.members[key]) return { ok: false, reason: "already a member" };
  // The guild polices the trade: only real theater professionals may join.
  if (!isTheaterProfessional(username)) {
    return { ok: false, reason: "not a theater professional" };
  }
  ensureGuild(kid);
  const now = Date.now();
  st.members[key] = {
    username: String(username), kingdomId: kid, rank: RANK_PLAYER,
    joinedAt: now, duesPaidUntilMs: now + DUES_PERIOD_MS,
    missedDues: 0, suspended: false, trainingCredits: 0, certCount: 0, clean: true,
  };
  markDirty();
  return { ok: true, member: st.members[key] };
}

function leaveGuild(username) {
  const st = load();
  const key = norm(username);
  if (!key || !st.members[key]) return { ok: false, reason: "not a member" };
  delete st.members[key];
  // drop mentorships involving this member
  delete st.mentorships[key];
  for (const [app, master] of Object.entries(st.mentorships)) {
    if (norm(master) === key) delete st.mentorships[app];
  }
  markDirty();
  return { ok: true };
}

function recordDuesPayment(username, nowMs = Date.now()) {
  const st = load();
  const m = memberOf(username);
  if (!m) return { ok: false, reason: "not a member" };
  const g = ensureGuild(m.kingdomId);
  m.duesPaidUntilMs = nowMs + DUES_PERIOD_MS;
  m.missedDues = 0;
  if (m.suspended) m.suspended = false; // caught up -> reinstated
  if (g) {
    g.treasury = (g.treasury || 0) + (DUES_WEEKLY - DUES_RELIEF_SHARE);
    g.reliefFund = (g.reliefFund || 0) + DUES_RELIEF_SHARE;
  }
  markDirty();
  return { ok: true, member: m };
}

function recordMissedDues(username, nowMs = Date.now()) {
  const st = load();
  const m = memberOf(username);
  if (!m) return { ok: false, reason: "not a member" };
  m.missedDues = (m.missedDues || 0) + 1;
  if (m.missedDues >= SUSPEND_AFTER_MISSED) m.suspended = true;
  markDirty();
  return { ok: true, member: m, suspended: m.suspended };
}

// --- play certification --------------------------------------------------

/**
 * Submit a play for guild certification. Verifies against the REAL theater
 * records: the play must exist, the submitter must be its playwright, and
 * it must not already carry a guild seal. The 50-coin fee is taken by the
 * caller (events command / life tick) — this only queues verified plays.
 */
function submitForCertification(playId, owner, kingdomId) {
  const st = load();
  const pid = String(playId || "");
  const key = norm(owner);
  const kid = norm(kingdomId);
  if (!pid) return { ok: false, reason: "no play" };
  if (!key) return { ok: false, reason: "no owner" };
  const T = theaterApi();
  if (!T || typeof T.playFor !== "function") return { ok: false, reason: "no theater records" };
  const play = T.playFor(pid);
  if (!play) return { ok: false, reason: "no such play" };
  if (norm(play.playwrightLower || play.playwright) !== key) {
    return { ok: false, reason: "not your play" };
  }
  if (st.seals[pid]) return { ok: false, reason: "already certified" };
  if (st.queue.some((q) => q.playId === pid)) return { ok: false, reason: "already queued" };
  st.queue.push({ playId: pid, owner: play.playwright || owner, kingdomId: kid || play.kingdomId, submittedAt: Date.now() });
  markDirty();
  return { ok: true, play };
}

/** Settle one queued certification: grade from real quality, pay the real bounty. */
function settleCertification(playId, nowMs = Date.now()) {
  const st = load();
  const pid = String(playId || "");
  const qi = st.queue.findIndex((q) => q.playId === pid);
  if (qi < 0) return { ok: false, reason: "not queued" };
  const q = st.queue[qi];
  const T = theaterApi();
  const play = T && typeof T.playFor === "function" ? T.playFor(pid) : null;
  if (!play) {
    st.queue.splice(qi, 1); // play vanished — drop honestly
    markDirty();
    return { ok: false, reason: "play gone" };
  }
  const grade = gradeForQuality(play.quality);
  const doubled = CERT_BOUNTY_DOUBLE_GENRES.includes(norm(play.genre)) &&
    norm(play.kingdomId) === norm(q.kingdomId);
  let bounty = CERT_BOUNTY[grade] || 0;
  if (doubled) bounty *= 2;
  const g = ensureGuild(q.kingdomId);
  let paid = 0;
  let owed = 0;
  if (g && bounty > 0) {
    // The bounty is credited to the playwright's REAL bank account before
    // the reserves are touched — never mark paid what was never delivered.
    const fromTreasury = Math.min(g.treasury || 0, bounty);
    const fromRelief = Math.min(g.reliefFund || 0, bounty - fromTreasury);
    const toPay = fromTreasury + fromRelief;
    if (toPay > 0) {
      let credited = false;
      try {
        const B = bankingApi();
        const acct = B && typeof B.accountFor === "function" ? B.accountFor(q.owner) : null;
        if (acct) {
          acct.balance = (Number(acct.balance) || 0) + toPay;
          if (typeof B.markDirty === "function") B.markDirty();
          credited = true;
        }
      } catch { /* banking is best-effort */ }
      if (credited) {
        g.treasury = (g.treasury || 0) - fromTreasury;
        g.reliefFund = (g.reliefFund || 0) - fromRelief;
        paid = toPay;
      }
    }
    owed = bounty - paid;
    if (owed > 0) {
      const okey = `${norm(q.owner)}:${pid}`;
      st.bountiesOwed[okey] = (st.bountiesOwed[okey] || 0) + owed;
    }
    g.prestige = Math.min(100, (g.prestige || 0) + (grade === "A" ? 3 : grade === "B" ? 2 : 1));
  }
  st.seals[pid] = {
    playId: pid, title: play.title, playwright: play.playwright,
    grade, genre: play.genre, kingdomId: q.kingdomId, sealedAt: nowMs, doubled,
  };
  st.queue.splice(qi, 1);
  // mentorship double credit + cert counts for promotion
  const m = memberOf(q.owner);
  if (m) {
    const mentored = st.mentorships[norm(q.owner)];
    m.certCount = (m.certCount || 0) + (mentored ? 2 : 1);
    if (m.certCount >= PROMOTE_STAGEMASTER.certifications && m.rank === RANK_PERFORMER) {
      // promotion itself happens on the life tick / school; count is the proof
    }
  }
  markDirty();
  return { ok: true, seal: st.seals[pid], paid, owed, grade, doubled };
}

/** Settle the whole queue (called by the life tick). */
function settleQueue(nowMs = Date.now()) {
  const st = load();
  const results = [];
  for (const q of st.queue.slice()) {
    results.push(settleCertification(q.playId, nowMs));
  }
  return results;
}

/** Retry honestly-owed bounties as funds refill. Returns coins paid out. */
function retryOwedBounties(kingdomId) {
  const st = load();
  const g = guildOf(kingdomId);
  if (!g) return { paid: [] };
  const paid = [];
  for (const okey of Object.keys(st.bountiesOwed)) {
    const owed = st.bountiesOwed[okey] || 0;
    if (owed <= 0) continue;
    // only pay bounties for this kingdom's seals
    const pid = okey.split(":").slice(1).join(":");
    const seal = st.seals[pid];
    if (!seal || norm(seal.kingdomId) !== norm(kingdomId)) continue;
    const fromTreasury = Math.min(g.treasury || 0, owed);
    const fromRelief = Math.min(g.reliefFund || 0, owed - fromTreasury);
    const total = fromTreasury + fromRelief;
    if (total <= 0) continue;
    // Credit the playwright's bank account before deducting — the okey
    // starts with the owner's normalized name.
    const owner = String(okey).split(":")[0];
    let credited = false;
    try {
      const B = bankingApi();
      const acct = B && typeof B.accountFor === "function" ? B.accountFor(owner) : null;
      if (acct) {
        acct.balance = (Number(acct.balance) || 0) + total;
        if (typeof B.markDirty === "function") B.markDirty();
        credited = true;
      }
    } catch { /* banking is best-effort */ }
    if (!credited) continue;
    g.treasury = (g.treasury || 0) - fromTreasury;
    g.reliefFund = (g.reliefFund || 0) - fromRelief;
    st.bountiesOwed[okey] = owed - total;
    if (st.bountiesOwed[okey] <= 0) delete st.bountiesOwed[okey];
    paid.push({ key: okey, paid: total });
    markDirty();
  }
  return { paid };
}

function sealFor(playId) {
  return load().seals[String(playId || "")] || null;
}

function gradeFor(playId) {
  const s = sealFor(playId);
  return s ? s.grade : null;
}

// --- plagiarism tribunal -----------------------------------------------

/**
 * Scan the REAL play records for plagiarism: a play whose normalized title
 * duplicates an EARLIER play by a DIFFERENT playwright. Returns candidates
 * (the later play is the suspect).
 */
function plagiarismScan() {
  const out = [];
  try {
    const T = theaterApi();
    const S = sitesApi();
    if (!T || typeof T.playsIn !== "function" || !S) return out;
    const kids = Array.isArray(S.KINGDOM_IDS) ? S.KINGDOM_IDS : [];
    const seen = Object.create(null); // normTitle -> earliest { playId, playwrightLower, writtenAt }
    for (const kid of kids) {
      let plays = [];
      try { plays = T.playsIn(kid) || []; } catch { continue; }
      const ordered = plays.slice().sort((a, b) => (a.writtenAt || 0) - (b.writtenAt || 0));
      for (const p of ordered) {
        const t = normTitle(p.title);
        if (!t) continue;
        const first = seen[t];
        if (!first) {
          seen[t] = { playId: p.id, playwrightLower: norm(p.playwrightLower || p.playwright), writtenAt: p.writtenAt || 0 };
        } else if (norm(p.playwrightLower || p.playwright) !== first.playwrightLower) {
          out.push({
            playId: p.id, title: p.title, accused: p.playwright,
            originalPlayId: first.playId, kingdomId: p.kingdomId,
          });
        }
      }
    }
  } catch { /* scan failure -> no candidates */ }
  return out;
}

function reportPlagiarism(kingdomId, playId, reporter) {
  const st = load();
  const kid = norm(kingdomId);
  const pid = String(playId || "");
  if (!kid || !pid) return { ok: false, reason: "need kingdom and play" };
  // verify against real records: the suspect play must exist and there must
  // be an earlier same-title play by a different playwright
  const suspect = plagiarismScan().find((c) => c.playId === pid);
  if (!suspect) return { ok: false, reason: "no plagiarism found" };
  // no double jeopardy: one open case per play
  for (const c of Object.values(st.cases)) {
    if (c.playId === pid && c.status === "open") return { ok: false, reason: "case already open" };
  }
  const id = `case-${st.nextCaseId++}`;
  st.cases[id] = {
    id, kingdomId: kid, accused: suspect.accused, playId: pid,
    kind: "plagiarism", reporter: reporter || "guild",
    filedAt: Date.now(), votes: Object.create(null), status: "open",
  };
  markDirty();
  return { ok: true, case: st.cases[id] };
}

function voteOnCase(caseId, voter, verdict) {
  const st = load();
  const c = st.cases[String(caseId || "")];
  if (!c || c.status !== "open") return { ok: false, reason: "no open case" };
  // only stagemasters of the case's kingdom may vote
  const m = memberOf(voter);
  if (!m || m.rank !== RANK_STAGEMASTER || m.suspended) return { ok: false, reason: "stagemasters only" };
  if (norm(m.kingdomId) !== norm(c.kingdomId)) return { ok: false, reason: "wrong kingdom" };
  const v = norm(verdict) === "innocent" ? "innocent" : "guilty";
  c.votes[norm(voter)] = v;
  markDirty();
  return { ok: true, case: c };
}

function settleRipeCases(kingdomId, nowMs = Date.now()) {
  const st = load();
  const kid = norm(kingdomId);
  const settled = [];
  for (const c of Object.values(st.cases)) {
    if (c.status !== "open") continue;
    if (norm(c.kingdomId) !== kid) continue;
    if (nowMs - (c.filedAt || 0) < CASE_TTL_MS) continue;
    const votes = Object.values(c.votes || {});
    const guilty = votes.filter((v) => v === "guilty").length;
    const innocent = votes.filter((v) => v === "innocent").length;
    if (votes.length >= VOTES_FOR_QUORUM && guilty > innocent) {
      c.status = "guilty";
      // expel the plagiarist and mark the deed
      const m = memberOf(c.accused);
      if (m) { m.suspended = true; m.clean = false; }
      try {
        const Rep = repApi();
        if (Rep && typeof Rep.awardDeed === "function") Rep.awardDeed(c.accused, "plagiarist", nowMs);
      } catch { /* deed is best-effort */ }
    } else {
      c.status = votes.length >= VOTES_FOR_QUORUM ? "acquitted" : "dismissed";
    }
    settled.push(c);
    markDirty();
  }
  return settled;
}

// --- touring circuits ----------------------------------------------------

/**
 * Sponsors post REAL-coin bounties for troupes to tour a target kingdom.
 * The coins are taken by the caller and held in escrow on the circuit.
 */
function postCircuit(kingdomId, targetKingdom, sponsor, bounty) {
  const st = load();
  const kid = norm(kingdomId);
  const target = norm(targetKingdom);
  const amt = Math.floor(Number(bounty) || 0);
  if (!kid || !target) return { ok: false, reason: "need kingdoms" };
  if (kid === target) return { ok: false, reason: "already there" };
  if (amt < CIRCUIT_MIN_BOUNTY) return { ok: false, reason: `minimum bounty is ${CIRCUIT_MIN_BOUNTY}` };
  ensureGuild(kid);
  const id = `circuit-${st.nextCircuitId++}`;
  st.circuits[id] = {
    id, kingdomId: kid, targetKingdom: target,
    sponsor: sponsor || "anonymous", bounty: amt,
    postedAt: Date.now(), status: "open", claimedBy: null,
  };
  markDirty();
  return { ok: true, circuit: st.circuits[id] };
}

function circuitsFor(kingdomId, onlyOpen = true) {
  const kid = norm(kingdomId);
  return Object.values(load().circuits).filter((c) =>
    (!kid || norm(c.kingdomId) === kid) && (!onlyOpen || c.status === "open"));
}

/**
 * Snapshot every real troupe's current location into the guild's own tour
 * ledger. Called by the life tick; claims are verified against it.
 */
function noteTroupeLocations(nowMs = Date.now()) {
  const st = load();
  try {
    const T = theaterApi();
    const S = sitesApi();
    if (!T || !S || typeof T.troupesIn !== "function") return 0;
    const kids = Array.isArray(S.KINGDOM_IDS) ? S.KINGDOM_IDS : [];
    let n = 0;
    for (const kid of kids) {
      for (const t of T.troupesIn(kid) || []) {
        let loc = null;
        try { loc = T.troupeLocation(t); } catch { continue; }
        if (!loc || !loc.kingdomId) continue;
        st.lastSeen[norm(t.name)] = { kingdomId: norm(loc.kingdomId), at: nowMs };
        n++;
      }
    }
    if (n > 0) markDirty();
    return n;
  } catch {
    return 0;
  }
}

/**
 * Claim a touring-circuit bounty. Verified: the troupe must be REAL, must
 * currently be in the target kingdom, the guild's ledger must show it
 * arriving there AFTER the bounty posted (a real tour, not residence),
 * and the troupe must carry at least one guild member in good standing.
 * First valid claim wins; the bounty goes to the troupe's REAL treasury.
 */
function claimCircuit(circuitId, troupeName, claimant) {
  const st = load();
  const c = st.circuits[String(circuitId || "")];
  if (!c || c.status !== "open") return { ok: false, reason: "no open circuit" };
  const T = theaterApi();
  if (!T || typeof T.troupeFor !== "function") return { ok: false, reason: "no theater records" };
  const troupe = T.troupeFor(troupeName);
  if (!troupe) return { ok: false, reason: "no such troupe" };
  let loc = null;
  try { loc = T.troupeLocation(troupe); } catch { /* no */ }
  if (!loc || norm(loc.kingdomId) !== norm(c.targetKingdom)) {
    return { ok: false, reason: "troupe is not there" };
  }
  // the guild ledger must show arrival after the bounty posted
  const seen = st.lastSeen[norm(troupe.name)];
  if (!seen || norm(seen.kingdomId) !== norm(c.targetKingdom) || (seen.at || 0) < c.postedAt) {
    return { ok: false, reason: "tour not verified" };
  }
  // the troupe must carry a guild member in good standing
  const hasMember = (troupe.members || []).some((m) => isGuildMember(m));
  if (!hasMember) return { ok: false, reason: "no guild member in troupe" };
  c.status = "claimed";
  c.claimedBy = troupe.name;
  c.claimedAt = Date.now();
  troupe.treasury = (troupe.treasury || 0) + c.bounty;
  const g = guildOf(c.kingdomId);
  if (g) g.prestige = Math.min(100, (g.prestige || 0) + 2);
  markDirty();
  try {
    const Tm = theaterApi();
    if (Tm && typeof Tm._markDirty === "function") Tm._markDirty();
  } catch { /* theater persists on its own tick */ }
  markDirty();
  return { ok: true, circuit: c, bounty: c.bounty };
}

// --- critics' choice laurel ----------------------------------------------

/**
 * Quarterly critics' choice: the troupe with the most REAL 5-star reviews
 * in the kingdom wins a REAL 200-coin prize from the treasury (owed
 * honestly when broke) and a public announcement.
 */
function grantLaurel(kingdomId, nowMs = Date.now()) {
  const st = load();
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no guild" };
  if (nowMs - (g.lastLaurelAt || 0) < LAUREL_PERIOD_MS) return { ok: false, reason: "too soon" };
  const T = theaterApi();
  if (!T || typeof T.recentReviews !== "function") return { ok: false, reason: "no reviews" };
  let reviews = [];
  try { reviews = T.recentReviews(kingdomId, 60) || []; } catch { return { ok: false, reason: "no reviews" }; }
  const fiveStar = reviews.filter((r) => (r.stars || 0) >= 5);
  if (!fiveStar.length) {
    g.lastLaurelAt = nowMs; // no contenders this quarter — don't spam
    markDirty();
    return { ok: false, reason: "no acclaimed shows" };
  }
  const counts = Object.create(null);
  for (const r of fiveStar) {
    const t = norm(r.troupe);
    if (t) counts[t] = (counts[t] || 0) + 1;
  }
  let winner = null;
  let best = 0;
  for (const [t, n] of Object.entries(counts)) {
    if (n > best) { best = n; winner = t; }
  }
  if (!winner) return { ok: false, reason: "no winner" };
  const rep = fiveStar.find((r) => norm(r.troupe) === winner);
  let paid = 0;
  let owed = 0;
  const fromTreasury = Math.min(g.treasury || 0, LAUREL_PRIZE);
  g.treasury = (g.treasury || 0) - fromTreasury;
  paid += fromTreasury;
  owed = LAUREL_PRIZE - fromTreasury;
  if (owed > 0) {
    const okey = `laurel:${winner}:${nowMs}`;
    st.bountiesOwed[okey] = (st.bountiesOwed[okey] || 0) + owed;
  }
  // credit the winning troupe's real treasury with what we could pay now
  try {
    const troupe = T.troupeFor(rep.troupe);
    if (troupe && paid > 0) troupe.treasury = (troupe.treasury || 0) + paid;
  } catch { /* treasury credit is best-effort */ }
  g.lastLaurelAt = nowMs;
  g.prestige = Math.min(100, (g.prestige || 0) + 4);
  const laurel = { kingdomId: norm(kingdomId), troupe: rep.troupe, stars: 5, fiveStarCount: best, at: nowMs, paid, owed };
  st.laurels.push(laurel);
  if (st.laurels.length > 20) st.laurels = st.laurels.slice(-20);
  markDirty();
  return { ok: true, laurel };
}

// --- stage school & mentorship -------------------------------------------

function holdClass(kingdomId, master) {
  const st = load();
  const m = memberOf(master);
  if (!m || m.rank !== RANK_STAGEMASTER || m.suspended) return { ok: false, reason: "need a stagemaster" };
  if (norm(m.kingdomId) !== norm(kingdomId)) return { ok: false, reason: "wrong kingdom" };
  let taught = 0;
  for (const mem of Object.values(st.members)) {
    if (norm(mem.kingdomId) !== norm(kingdomId)) continue;
    if (mem.rank !== RANK_PLAYER || mem.suspended) continue;
    mem.trainingCredits = (mem.trainingCredits || 0) + 1;
    taught++;
  }
  if (taught > 0) markDirty();
  return { ok: true, taught };
}

function takeMentorship(master, apprentice) {
  const st = load();
  const ma = memberOf(master);
  const ap = memberOf(apprentice);
  if (!ma || ma.rank !== RANK_STAGEMASTER || ma.suspended) return { ok: false, reason: "need a stagemaster" };
  if (!ap || ap.rank !== RANK_PLAYER || ap.suspended) return { ok: false, reason: "need a player-rank member" };
  st.mentorships[norm(apprentice)] = norm(master);
  markDirty();
  return { ok: true };
}

function mentoredBy(username) {
  const key = norm(username);
  const master = load().mentorships[key];
  return master || null;
}

/**
 * Try to promote a member. All gates are verifiable from real records:
 * player -> performer: 30d tenure + 2 training credits + real stage proof
 *   (member of a real troupe OR 3+ real plays written).
 * performer -> stagemaster: 60d tenure + 4 credits + 2 conducted
 *   certifications + clean record.
 */
function tryPromote(username, nowMs = Date.now()) {
  const st = load();
  const m = memberOf(username);
  if (!m || m.suspended) return { ok: false, reason: "not promotable" };
  if (m.rank === RANK_PLAYER) {
    const tenureOk = nowMs - (m.joinedAt || 0) >= PROMOTE_PERFORMER.tenureMs;
    const creditsOk = (m.trainingCredits || 0) >= PROMOTE_PERFORMER.credits;
    const stageProof = troupeMemberSomewhere(username) || playsWrittenCount(username) >= 3;
    if (tenureOk && creditsOk && stageProof) {
      m.rank = RANK_PERFORMER;
      markDirty();
      return { ok: true, rank: RANK_PERFORMER };
    }
    return { ok: false, reason: "requirements not met" };
  }
  if (m.rank === RANK_PERFORMER) {
    const tenureOk = nowMs - (m.joinedAt || 0) >= PROMOTE_STAGEMASTER.tenureMs;
    const creditsOk = (m.trainingCredits || 0) >= PROMOTE_STAGEMASTER.credits;
    const certsOk = (m.certCount || 0) >= PROMOTE_STAGEMASTER.certifications;
    const cleanOk = m.clean !== false;
    if (tenureOk && creditsOk && certsOk && cleanOk) {
      m.rank = RANK_STAGEMASTER;
      try {
        const Rep = repApi();
        if (Rep && typeof Rep.awardDeed === "function") Rep.awardDeed(username, "stagemaster", nowMs);
      } catch { /* deed is best-effort */ }
      markDirty();
      return { ok: true, rank: RANK_STAGEMASTER };
    }
    return { ok: false, reason: "requirements not met" };
  }
  return { ok: false, reason: "top rank" };
}

// --- contributions -------------------------------------------------------

function contribute(username, amount, kingdomId, toRelief = false) {
  const st = load();
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no guild" };
  const amt = Math.floor(Number(amount) || 0);
  if (amt <= 0) return { ok: false, reason: "need coins" };
  // the caller takes the real coins; this only credits the tracked fund
  if (toRelief) g.reliefFund = (g.reliefFund || 0) + amt;
  else g.treasury = (g.treasury || 0) + amt;
  markDirty();
  return { ok: true, treasury: g.treasury, reliefFund: g.reliefFund };
}

// --- describe ------------------------------------------------------------

function describe(kingdomId) {
  const st = load();
  const g = guildOf(kingdomId);
  if (!g) return { exists: false };
  const members = Object.values(st.members).filter((m) => norm(m.kingdomId) === norm(kingdomId) && !m.suspended);
  return {
    exists: true,
    memberCount: members.length,
    stagemasters: members.filter((m) => m.rank === RANK_STAGEMASTER).length,
    certified: Object.values(st.seals).filter((s) => norm(s.kingdomId) === norm(kingdomId)).length,
    openCircuits: circuitsFor(kingdomId, true).length,
    treasury: g.treasury || 0,
    reliefFund: g.reliefFund || 0,
    prestige: g.prestige || 0,
  };
}

module.exports = {
  // constants
  RANK_PLAYER, RANK_PERFORMER, RANK_STAGEMASTER, RANKS,
  COINS_ID, DUES_WEEKLY, CERT_FEE, CERT_BOUNTY,
  CIRCUIT_MIN_BOUNTY, LAUREL_PRIZE, LAUREL_PERIOD_MS,
  STAGE_CODE,
  // guilds
  ensureGuild, guildOf, guildTreasuryFor, describe,
  // membership
  memberOf, isGuildMember, guildRankOf, joinGuild, leaveGuild,
  recordDuesPayment, recordMissedDues,
  // certification
  submitForCertification, settleCertification, settleQueue, retryOwedBounties,
  sealFor, gradeFor, gradeForQuality,
  // tribunal
  plagiarismScan, reportPlagiarism, voteOnCase, settleRipeCases,
  // circuits
  postCircuit, circuitsFor, claimCircuit, noteTroupeLocations,
  // laurel
  grantLaurel,
  // school & mentorship
  holdClass, takeMentorship, mentoredBy, tryPromote,
  // funds
  contribute,
  // persistence
  save, load, resetForTests, _setSavePathForTests,
};
