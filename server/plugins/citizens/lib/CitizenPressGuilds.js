"use strict";

/**
 * CitizenPressGuilds — the press association (journalism guild) operations layer.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenPress owns: the journalist PROFESSION registry, investigative
 *     stories filed from real events, printing presses, special editions,
 *     subscriptions, player-submitted stories, political salience. Stories
 *     and events are READ-ONLY here — this module never files or edits them.
 *   - CitizenNewspaper owns: the weekly compiled paper + town-crier shouts.
 *   - THIS module owns: the profession's GUILD layer — per-kingdom press
 *     associations, membership ranks with real-coin dues, press passes
 *     (credentials), the ethics tribunal (verifiable violations only), the
 *     Inkwell press awards (real stories, real prizes), and the journalism
 *     school (training under editor-rank masters).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Associations: one per kingdom with a hall tile near the printing
 *     press, a real tracked treasury, founded timestamp.
 *   - Membership: stringer -> reporter -> editor ranks. Joining requires
 *     being a REAL registered journalist (CitizenPress.isJournalist) —
 *     the guild polices the trade, it does not mint reporters. Weekly
 *     real-coin dues (25); 2 missed online collections suspend; offline
 *     members are skipped, never penalized.
 *   - Press passes: members in good standing carry a 30-day credential;
 *     real players can buy a 1-day day-pass (10 coins to the treasury).
 *     Passes are records, not invented items — the guild never conjures
 *     engine items out of thin air.
 *   - Ethics tribunal: violations are REPORTED (by members or real
 *     players) and VERIFIED against real data, never assumed:
 *       * plagiarism — the accused story's normalized headline duplicates
 *         an earlier story by a different author (verifiable from real
 *         story records);
 *       * fabrication — the accused story references an event id that does
 *         not exist in CitizenPress state, or is filed by someone who is
 *         neither a registered journalist nor a player author.
 *     Editor-rank members vote; cases settle after 24h or when an editor
 *     majority is reached. Guilty plagiarism: 100-coin fine (owed honestly
 *     when broke) + 7-day suspension. Guilty fabrication: expulsion +
 *     the `fabricator` fame deed. All verdicts are journaled.
 *   - Inkwell awards: every 30 days per kingdom per beat, the highest-
 *     quality real story by a guild member in good standing wins
 *     (ties -> earliest). 200-coin prize from the real treasury (owed
 *     honestly when broke, paid on the life tick), `presslaureate` fame
 *     deed, and a public announcement.
 *   - Journalism school: editor-rank masters hold classes for stringers;
 *     attendance grants training credit. Promotion: reporter at 5 real
 *     filed stories; editor at 12 real filed stories + 2 training credits
 *     + a clean ethics record. Story counts come from CitizenPress —
 *     never invented here.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here (lib/CitizenPressGuildLife.js is ticked by the director).
 *   - No LLM. No movement (brain/actions/CitizenPressGuild.js).
 *   - No invented coins, items, stories, or events.
 */

const path = require("path");

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-pressguilds.json";
const COINS_ID = 995;

const RANK_STRINGER = "stringer";
const RANK_REPORTER = "reporter";
const RANK_EDITOR = "editor";
const RANKS = Object.freeze([RANK_STRINGER, RANK_REPORTER, RANK_EDITOR]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2; // missed online collections before suspension

const AWARD_PRIZE = 200; // real coins from the treasury
const AWARD_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // one award cycle per beat
const AWARD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // eligible stories window

const PROMOTE_REPORTER_STORIES = 5; // mirror the inkslinger deed threshold
const PROMOTE_EDITOR_STORIES = 12;
const PROMOTE_EDITOR_TRAINING = 2; // training credits needed for editor

const PASS_MEMBER_DAYS = 30;
const PASS_PLAYER_DAYS = 1;
const PASS_PLAYER_FEE = 10; // real coins to the treasury

const VIOLATION_FABRICATION = "fabrication";
const VIOLATION_PLAGIARISM = "plagiarism";
const VIOLATION_TYPES = Object.freeze([VIOLATION_FABRICATION, VIOLATION_PLAGIARISM]);

const PLAGIARISM_FINE = 100; // real coins
const PLAGIARISM_SUSPEND_MS = 7 * 24 * 60 * 60 * 1000;

const CASE_SETTLE_MS = 24 * 60 * 60 * 1000; // auto-settle open cases after 24h

const HALL_TILE_DX = 4; // guild hall sits a few tiles from the printing press

// --- state --------------------------------------------------------------------

let cache = null;
// { guilds, members, cases, awards, passes, classes, nextId }
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntil, missedDues, suspended, suspendUntil, trainingCredits, fineOwed, expelled }
    cases: Object.create(null), // id -> { id, accuser, accused, type, storyId, status, filedAt, votes, verdict, settledAt, sanction }
    awards: Object.create(null), // id -> { id, kingdomId, beat, winner, storyId, quality, prize, prizeOwed, awardedAt }
    passes: Object.create(null), // norm -> { username, kingdomId, kind, issuedAt, expiresAt }
    classes: Object.create(null), // id -> { id, master, apprentices, kingdomId, heldAt }
    nextId: 1,
  };
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

function savePath() {
  try {
    return path.join(__dirname, "..", "data", "saves", SAVE_KEY);
  } catch {
    return SAVE_KEY;
  }
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    if (fs.existsSync(savePath())) {
      const raw = JSON.parse(fs.readFileSync(savePath(), "utf8"));
      if (raw && typeof raw === "object") {
        for (const k of Object.keys(blankState())) {
          if (raw[k] && typeof raw[k] === "object") cache[k] = raw[k];
        }
        if (typeof raw.nextId === "number") cache.nextId = raw.nextId;
      }
    }
  } catch { /* corrupt save -> blank; never throws */ }
  return cache;
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    fs.mkdirSync(path.dirname(savePath()), { recursive: true });
    fs.writeFileSync(savePath(), JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function resetForTests() {
  cache = blankState();
  dirty = false;
}

function allocId(prefix) {
  const st = load();
  const id = `${prefix}${st.nextId++}`;
  markDirty();
  return id;
}

// --- dependency seams (lazy, defensive) ---------------------------------------

function pressApi() {
  try { return require("./CitizenPress"); } catch { return null; }
}

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
  const kid = String(kingdomId || "");
  let tile = null;
  try {
    const P = pressApi();
    tile = P ? P.pressTileFor(kid) : null;
  } catch { tile = null; }
  if (!tile) {
    try {
      const S = sitesApi();
      tile = S && typeof S.siteTile === "function" ? S.siteTile({ kingdomId: kid }, "market") : null;
    } catch { tile = null; }
  }
  if (!tile) return { x: 3200, y: 3200, z: 0 };
  return { x: (tile.x ?? 3200) + HALL_TILE_DX, y: tile.y ?? 3200, z: tile.z ?? 0 };
}

// --- associations ------------------------------------------------------------

function ensureGuild(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "");
  if (!kid) return null;
  if (!st.guilds[kid]) {
    st.guilds[kid] = { kingdomId: kid, hallTile: hallTileFor(kid), foundedAt: Date.now(), treasury: 0 };
    markDirty();
  }
  return st.guilds[kid];
}

function guildOf(kingdomId) {
  const st = load();
  return st.guilds[String(kingdomId || "")] || null;
}

function guildTreasuryFor(kingdomId) {
  const g = ensureGuild(kingdomId);
  return g ? g.treasury : 0;
}

function creditTreasury(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  if (!g || !(amount > 0)) return false;
  g.treasury += Math.floor(amount);
  markDirty();
  return true;
}

function debitTreasury(kingdomId, amount) {
  const g = guildOf(kingdomId);
  if (!g || !(amount > 0)) return false;
  const take = Math.floor(amount);
  if (g.treasury < take) return false;
  g.treasury -= take;
  markDirty();
  return true;
}

// --- membership --------------------------------------------------------------

function memberOf(username) {
  const st = load();
  const m = st.members[norm(username)] || null;
  return m && !m.expelled ? m : null;
}

function isGuildMember(username) {
  const m = memberOf(username);
  return !!(m && !m.suspended);
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function memberCount(kingdomId) {
  const st = load();
  let n = 0;
  for (const m of Object.values(st.members)) {
    if (m.expelled) continue;
    if (!kingdomId || m.kingdomId === String(kingdomId)) n++;
  }
  return n;
}

function editorsIn(kingdomId) {
  const st = load();
  return Object.values(st.members).filter(
    (m) => !m.expelled && !m.suspended && m.rank === RANK_EDITOR && (!kingdomId || m.kingdomId === String(kingdomId))
  );
}

function joinGuild(username, kingdomId) {
  const st = load();
  const name = String(username || "").trim();
  if (!name) return { ok: false, reason: "no-identity" };
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  if (st.members[norm(name)] && !st.members[norm(name)].expelled) return { ok: false, reason: "already-member" };
  const P = pressApi();
  let isJournalist = false;
  try { isJournalist = P ? !!P.isJournalist(name) : false; } catch { isJournalist = false; }
  if (!isJournalist) return { ok: false, reason: "not-journalist" };
  ensureGuild(kid);
  st.members[norm(name)] = {
    username: name,
    kingdomId: kid,
    rank: RANK_STRINGER,
    joinedAt: Date.now(),
    duesPaidUntil: Date.now() + DUES_PERIOD_MS,
    missedDues: 0,
    suspended: false,
    suspendUntil: 0,
    trainingCredits: 0,
    fineOwed: 0,
    expelled: false,
  };
  markDirty();
  return { ok: true, rank: RANK_STRINGER };
}

function leaveGuild(username) {
  const st = load();
  const key = norm(username);
  if (!st.members[key] || st.members[key].expelled) return false;
  delete st.members[key];
  delete st.passes[key];
  markDirty();
  return true;
}

function liftSuspension(username) {
  const m = memberOf(username);
  if (!m || !m.suspended) return false;
  m.suspended = false;
  m.suspendUntil = 0;
  m.missedDues = 0;
  m.duesPaidUntil = Date.now() + DUES_PERIOD_MS;
  markDirty();
  return true;
}

// --- story access (read-only; CitizenPress owns stories) ----------------------

function allStories(windowMs) {
  const P = pressApi();
  if (!P) return [];
  const since = windowMs > 0 ? windowMs : 0;
  const out = [];
  try {
    for (const kid of kingdomIds()) {
      for (const beat of P.BEATS || []) {
        for (const s of P.storiesFor(kid, beat, since) || []) out.push(s);
      }
    }
  } catch { /* defensive */ }
  return out;
}

function findStory(storyId) {
  if (!storyId) return null;
  // storiesFor windows are bounded; scan a wide window so old stories are found.
  for (const s of allStories(365 * 24 * 3600 * 1000)) {
    if (String(s.id) === String(storyId)) return s;
  }
  return null;
}

function storyCountFor(username) {
  try {
    const P = pressApi();
    return P ? P.storyCountFor(username) : 0;
  } catch { return 0; }
}

function normalizedHeadline(headline) {
  return String(headline || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// --- ethics tribunal ----------------------------------------------------------

function reportViolation(accuser, accused, type, storyId, nowMs = Date.now()) {
  const st = load();
  if (!VIOLATION_TYPES.includes(type)) return { ok: false, reason: "bad-type" };
  const acc = String(accused || "").trim();
  if (!acc) return { ok: false, reason: "no-accused" };
  const m = memberOf(acc);
  if (!m) return { ok: false, reason: "not-a-member" };
  const story = findStory(storyId);
  if (!story) return { ok: false, reason: "no-such-story" };
  // A story by someone else cannot be pinned on the accused.
  if (norm(story.author) !== norm(acc)) return { ok: false, reason: "not-their-story" };
  // No double jeopardy: one open case per story.
  for (const c of Object.values(st.cases)) {
    if (c.status === "open" && String(c.storyId) === String(story.id)) {
      return { ok: false, reason: "already-open", id: c.id };
    }
  }
  const id = allocId("case");
  st.cases[id] = {
    id,
    accuser: String(accuser || "guild").trim() || "guild",
    accused: m.username,
    type,
    storyId: story.id,
    status: "open",
    filedAt: nowMs,
    votes: Object.create(null),
    verdict: null,
    settledAt: 0,
    sanction: null,
  };
  markDirty();
  return { ok: true, id };
}

function caseFor(id) {
  return load().cases[String(id)] || null;
}

function openCases(kingdomId) {
  return Object.values(load().cases).filter(
    (c) => c.status === "open" && (!kingdomId || guildKingdomOf(c.accused) === String(kingdomId))
  );
}

function guildKingdomOf(username) {
  const m = memberOf(username);
  return m ? m.kingdomId : null;
}

/**
 * Verifiable plagiarism: another story with the same normalized headline by
 * a different author, published earlier. Real records only — never inferred.
 */
function verifyPlagiarism(storyId) {
  const story = findStory(storyId);
  if (!story) return { ok: false, reason: "no-such-story" };
  const nh = normalizedHeadline(story.headline);
  if (!nh) return { ok: true, plagiarized: false };
  let original = null;
  for (const s of allStories(365 * 24 * 3600 * 1000)) {
    if (String(s.id) === String(story.id)) continue;
    if (norm(s.author) === norm(story.author)) continue;
    if (normalizedHeadline(s.headline) !== nh) continue;
    if ((s.publishedAt ?? 0) >= (story.publishedAt ?? 0)) continue;
    if (!original || (s.publishedAt ?? 0) < (original.publishedAt ?? 0)) original = s;
  }
  if (original) {
    return { ok: true, plagiarized: true, originalId: original.id, originalAuthor: original.author };
  }
  return { ok: true, plagiarized: false };
}

/**
 * Verifiable fabrication: the story cites an event id that does not exist in
 * CitizenPress state, or the author is neither a registered journalist nor
 * a player author. Anything else is "unverifiable" — the tribunal needs
 * evidence, not suspicion.
 */
function verifyFabrication(storyId) {
  const story = findStory(storyId);
  if (!story) return { ok: false, reason: "no-such-story" };
  const P = pressApi();
  if (story.eventId) {
    let ev = null;
    try { ev = P && typeof P.eventFor === "function" ? P.eventFor(story.eventId) : null; } catch { ev = null; }
    if (!ev) return { ok: true, fabricated: true, reason: "no-such-event" };
  }
  let journalist = false;
  let playerAuthor = !!story.authorIsPlayer;
  try { journalist = P ? !!P.isJournalist(story.author) : false; } catch { journalist = false; }
  if (!journalist && !playerAuthor) {
    return { ok: true, fabricated: true, reason: "not-an-author" };
  }
  return { ok: true, fabricated: false };
}

function verifyCase(caseRec) {
  if (!caseRec) return { ok: false, reason: "no-such-case" };
  if (caseRec.type === VIOLATION_PLAGIARISM) return verifyPlagiarism(caseRec.storyId);
  if (caseRec.type === VIOLATION_FABRICATION) return verifyFabrication(caseRec.storyId);
  return { ok: false, reason: "bad-type" };
}

function voteOnCase(caseId, voter, guilty, nowMs = Date.now()) {
  const st = load();
  const c = st.cases[String(caseId)];
  if (!c || c.status !== "open") return { ok: false, reason: "no-open-case" };
  const v = memberOf(voter);
  if (!v) return { ok: false, reason: "not-a-member" };
  if (v.rank !== RANK_EDITOR || v.suspended) return { ok: false, reason: "not-an-editor" };
  if (norm(voter) === norm(c.accused)) return { ok: false, reason: "cannot-judge-self" };
  c.votes[norm(voter)] = { voter: v.username, guilty: !!guilty, at: nowMs };
  markDirty();
  return { ok: true };
}

function settleCase(caseId, nowMs = Date.now()) {
  const st = load();
  const c = st.cases[String(caseId)];
  if (!c || c.status !== "open") return { ok: false, reason: "no-open-case" };
  const evidence = verifyCase(c);
  const votes = Object.values(c.votes);
  const guiltyVotes = votes.filter((v) => v.guilty).length;
  const notGuiltyVotes = votes.filter((v) => !v.guilty).length;
  // The guild's evidence counts as one guilty vote — the tribunal weighs
  // verifiable facts, and editors weigh judgment.
  const evidenceGuilty = evidence.ok && (evidence.plagiarized || evidence.fabricated);
  const totalGuilty = guiltyVotes + (evidenceGuilty ? 1 : 0);
  const quorum = votes.length >= 1 || nowMs - c.filedAt >= CASE_SETTLE_MS;
  if (!quorum) return { ok: false, reason: "no-quorum" };
  const guilty = totalGuilty > notGuiltyVotes;
  c.status = "decided";
  c.verdict = guilty ? "guilty" : "not-guilty";
  c.settledAt = nowMs;
  if (guilty) {
    if (c.type === VIOLATION_FABRICATION) {
      c.sanction = "expulsion";
      const m = memberOf(c.accused);
      if (m) { m.expelled = true; m.suspended = true; }
      delete st.passes[norm(c.accused)];
    } else {
      c.sanction = "fine-and-suspension";
      const m = memberOf(c.accused);
      if (m) {
        m.fineOwed = (m.fineOwed || 0) + PLAGIARISM_FINE;
        m.suspended = true;
        m.suspendUntil = nowMs + PLAGIARISM_SUSPEND_MS;
      }
    }
  } else {
    c.sanction = "none";
  }
  markDirty();
  return { ok: true, verdict: c.verdict, sanction: c.sanction, evidence };
}

function violationsFor(username) {
  return Object.values(load().cases).filter((c) => norm(c.accused) === norm(username));
}

function guiltyVerdictsFor(username) {
  return violationsFor(username).filter((c) => c.status === "decided" && c.verdict === "guilty");
}

// --- Inkwell awards ------------------------------------------------------------

/**
 * Award contenders: real stories in the window whose author is a guild
 * member in good standing. Quality is the real story quality.
 */
function contendersFor(kingdomId, beat, windowMs = AWARD_WINDOW_MS) {
  const P = pressApi();
  if (!P) return [];
  const kid = String(kingdomId || "");
  let stories = [];
  try { stories = P.storiesFor(kid, beat, windowMs) || []; } catch { stories = []; }
  return stories.filter((s) => isGuildMember(s.author));
}

function bestStoryFor(kingdomId, beat, windowMs = AWARD_WINDOW_MS) {
  const contenders = contendersFor(kingdomId, beat, windowMs);
  if (!contenders.length) return null;
  let best = contenders[0];
  for (const s of contenders) {
    if ((s.quality ?? 0) > (best.quality ?? 0)) best = s;
    else if ((s.quality ?? 0) === (best.quality ?? 0) && (s.publishedAt ?? 0) < (best.publishedAt ?? 0)) best = s;
  }
  return best;
}

function lastAwardAt(kingdomId, beat) {
  const kid = String(kingdomId || "");
  let last = 0;
  for (const a of Object.values(load().awards)) {
    if (a.kingdomId === kid && a.beat === beat && (a.awardedAt ?? 0) > last) last = a.awardedAt;
  }
  return last;
}

function awardsFor(kingdomId) {
  const kid = String(kingdomId || "");
  return Object.values(load().awards)
    .filter((a) => !kid || a.kingdomId === kid)
    .sort((a, b) => (b.awardedAt ?? 0) - (a.awardedAt ?? 0));
}

function grantAward(kingdomId, beat, nowMs = Date.now()) {
  const st = load();
  const kid = String(kingdomId || "");
  const P = pressApi();
  if (!kid || !P || !(P.BEATS || []).includes(beat)) return { ok: false, reason: "bad-award" };
  if (nowMs - lastAwardAt(kid, beat) < AWARD_PERIOD_MS) return { ok: false, reason: "too-soon" };
  const best = bestStoryFor(kid, beat);
  if (!best) return { ok: false, reason: "no-contenders" };
  const prizePaid = debitTreasury(kid, AWARD_PRIZE);
  const id = allocId("award");
  const award = {
    id,
    kingdomId: kid,
    beat,
    winner: best.author,
    storyId: best.id,
    quality: best.quality,
    prize: AWARD_PRIZE,
    prizeOwed: prizePaid ? 0 : AWARD_PRIZE,
    awardedAt: nowMs,
  };
  st.awards[id] = award;
  markDirty();
  return { ok: true, award };
}

// --- journalism school ----------------------------------------------------------

function holdClass(master, apprenticeUsernames, kingdomId, nowMs = Date.now()) {
  const st = load();
  const kid = String(kingdomId || "");
  const m = memberOf(master);
  if (!m || m.rank !== RANK_EDITOR || m.suspended) return { ok: false, reason: "not-an-editor" };
  const pupils = [];
  for (const u of apprenticeUsernames || []) {
    const p = memberOf(u);
    if (p && p.rank === RANK_STRINGER && !p.suspended && p.kingdomId === kid) {
      p.trainingCredits = (p.trainingCredits || 0) + 1;
      pupils.push(p.username);
    }
  }
  if (!pupils.length) return { ok: false, reason: "no-pupils" };
  const id = allocId("class");
  st.classes[id] = { id, master: m.username, apprentices: pupils, kingdomId: kid, heldAt: nowMs };
  markDirty();
  return { ok: true, id, pupils };
}

function classesFor(username) {
  return Object.values(load().classes).filter((c) => c.apprentices.some((a) => norm(a) === norm(username)));
}

function promotionEligible(username) {
  const m = memberOf(username);
  if (!m || m.suspended || m.expelled) return { ok: false, reason: "not-eligible" };
  const stories = storyCountFor(m.username);
  if (m.rank === RANK_STRINGER) {
    if (stories >= PROMOTE_REPORTER_STORIES) return { ok: true, to: RANK_REPORTER };
    return { ok: false, reason: "needs-stories", need: PROMOTE_REPORTER_STORIES - stories };
  }
  if (m.rank === RANK_REPORTER) {
    if (guiltyVerdictsFor(m.username).length) return { ok: false, reason: "ethics-record" };
    if (stories < PROMOTE_EDITOR_STORIES) return { ok: false, reason: "needs-stories", need: PROMOTE_EDITOR_STORIES - stories };
    if ((m.trainingCredits || 0) < PROMOTE_EDITOR_TRAINING) {
      return { ok: false, reason: "needs-training", need: PROMOTE_EDITOR_TRAINING - (m.trainingCredits || 0) };
    }
    return { ok: true, to: RANK_EDITOR };
  }
  return { ok: false, reason: "at-top" };
}

function promote(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return { ok: false, reason: "not-a-member" };
  const elig = promotionEligible(username);
  if (!elig.ok) return elig;
  m.rank = elig.to;
  m.promotedAt = nowMs;
  markDirty();
  return { ok: true, to: elig.to };
}

// --- press passes -----------------------------------------------------------------

function issueMemberPass(username, nowMs = Date.now()) {
  const st = load();
  const m = memberOf(username);
  if (!m) return { ok: false, reason: "not-a-member" };
  if (m.suspended) return { ok: false, reason: "suspended" };
  st.passes[norm(username)] = {
    username: m.username,
    kingdomId: m.kingdomId,
    kind: "member",
    issuedAt: nowMs,
    expiresAt: nowMs + PASS_MEMBER_DAYS * 24 * 60 * 60 * 1000,
  };
  markDirty();
  return { ok: true, expiresAt: st.passes[norm(username)].expiresAt };
}

function issueDayPass(username, kingdomId, nowMs = Date.now()) {
  const st = load();
  const name = String(username || "").trim();
  if (!name) return { ok: false, reason: "no-identity" };
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  ensureGuild(kid);
  st.passes[norm(name)] = {
    username: name,
    kingdomId: kid,
    kind: "day",
    issuedAt: nowMs,
    expiresAt: nowMs + PASS_PLAYER_DAYS * 24 * 60 * 60 * 1000,
  };
  markDirty();
  return { ok: true, expiresAt: st.passes[norm(name)].expiresAt };
}

function hasPressPass(username, nowMs = Date.now()) {
  const p = load().passes[norm(username)];
  return !!(p && p.expiresAt > nowMs);
}

function passFor(username) {
  return load().passes[norm(username)] || null;
}

function prunePasses(nowMs = Date.now()) {
  const st = load();
  let n = 0;
  for (const [k, p] of Object.entries(st.passes)) {
    if (p.expiresAt <= nowMs) { delete st.passes[k]; n++; }
  }
  if (n) markDirty();
  return n;
}

// --- describe --------------------------------------------------------------------

function describe(kingdomId) {
  const kid = String(kingdomId || "");
  const g = ensureGuild(kid);
  if (!g) return null;
  return {
    kingdomId: kid,
    members: memberCount(kid),
    editors: editorsIn(kid).length,
    treasury: g.treasury,
    openCases: openCases(kid).length,
    awards: awardsFor(kid).length,
    latestAward: awardsFor(kid)[0] || null,
  };
}

module.exports = {
  // constants
  SAVE_KEY, COINS_ID,
  RANK_STRINGER, RANK_REPORTER, RANK_EDITOR, RANKS,
  DUES_WEEKLY, DUES_PERIOD_MS, SUSPEND_AFTER_MISSED,
  AWARD_PRIZE, AWARD_PERIOD_MS, AWARD_WINDOW_MS,
  PROMOTE_REPORTER_STORIES, PROMOTE_EDITOR_STORIES, PROMOTE_EDITOR_TRAINING,
  PASS_MEMBER_DAYS, PASS_PLAYER_DAYS, PASS_PLAYER_FEE,
  VIOLATION_FABRICATION, VIOLATION_PLAGIARISM, VIOLATION_TYPES,
  PLAGIARISM_FINE, PLAGIARISM_SUSPEND_MS, CASE_SETTLE_MS,
  // associations
  ensureGuild, guildOf, guildTreasuryFor, creditTreasury, debitTreasury,
  hallTileFor,
  // membership
  memberOf, isGuildMember, guildRankOf, memberCount, editorsIn,
  joinGuild, leaveGuild, liftSuspension, guildKingdomOf,
  // stories (read-only)
  findStory, storyCountFor, allStories, normalizedHeadline,
  // ethics
  reportViolation, caseFor, openCases, violationsFor, guiltyVerdictsFor,
  verifyPlagiarism, verifyFabrication, verifyCase,
  voteOnCase, settleCase,
  // awards
  contendersFor, bestStoryFor, lastAwardAt, awardsFor, grantAward,
  // school
  holdClass, classesFor, promotionEligible, promote,
  // passes
  issueMemberPass, issueDayPass, hasPressPass, passFor, prunePasses,
  // describe + persistence
  describe, save, resetForTests,
};
