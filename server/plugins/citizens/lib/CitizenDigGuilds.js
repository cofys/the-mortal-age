"use strict";

/**
 * CitizenDigGuilds — the Excavators' Guild: the archaeology profession's
 * operations layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenArchaeology owns: dig sites, artifacts, museums, restoration,
 *     donations, museum purchases. THIS module never reimplements digging,
 *     artifacts, or museum economics — it READS them.
 *   - CitizenArchaeologyLife owns: ambient digging + site founding.
 *   - CitizenExcavate (brain) owns: archaeologists walking to sites and
 *     digging in human-paced rounds.
 *   - CitizenArchaeologyEvents owns: the ::dig player command.
 *   - CitizenGalleries owns: the art-gallery operations layer (auctions of
 *     visual art). THIS owns only the excavators' guild: authentication
 *     standards, forgery tribunals, site conservation, field school, and
 *     the authenticated archive.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One guild per kingdom with a hall tile near the museum, a real
 *     tracked treasury, a real tracked conservation fund, and prestige.
 *   - Membership: digger -> excavator -> conservator. Joining requires
 *     being a REAL registered archaeologist (CitizenArchaeology).
 *     Weekly dues in REAL coins; two missed online collections ->
 *     suspended until caught up. Offline members are never penalized.
 *   - Authentication: members submit artifacts they REALLY own (verified
 *     against CitizenArchaeology.artifactOf — record exists, owner matches,
 *     not donated). A 50-coin real fee. Grades from the REAL condition:
 *     fragmented=C, damaged=B, pristine=A. The guild pays a REAL bounty
 *     from its treasury (C:30 / B:60 / A:120, doubled for protected-site
 *     finds); when broke the bounty is owed honestly, never invented.
 *   - Forgery tribunal: the one verifiable archaeology crime — a planted
 *     fake. A submitted artifact is suspect when its siteId is unknown to
 *     the real site records, or its foundAt predates the site's founding.
 *     Members/players report; conservators vote; 24h auto-settle. Guilty ->
 *     expulsion + `forger` deed, and the fake is confiscated to the museum
 *     through the REAL donate flow.
 *   - Site conservation: conservators inspect REAL active dig sites. A
 *     site is flagged LOOTED when it has 6+ real digs and 0 museum
 *     donations from it. Two consecutive flags -> PROTECTED status:
 *     artifacts from protected sites authenticate fee-free and earn
 *     double bounty.
 *   - Field school: conservator masters teach diggers (training credits).
 *     Promotion: digger -> excavator (30d tenure + 2 credits + 5 REAL digs),
 *     excavator -> conservator (60d tenure + 4 credits + 3 conducted
 *     authentications + clean record). Dig counts come from
 *     CitizenArchaeology — never invented.
 *   - Mentorship: conservators take digger-rank members under wing. While
 *     mentored, the digger pays no authentication fees and their
 *     authentications count double toward promotion.
 *   - Archive: the guild's authenticated registry — metadata copies of
 *     every authenticated artifact (the physical artifact stays with its
 *     owner or the museum; never a double-spend). Prestige 0-100 from
 *     real counts.
 *   - Public API: isGuildMember, guildRankOf, memberOf, sealFor,
 *     authGradeFor, protectedSites, guildTreasuryFor, describe.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenDigGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented sites, artifacts, coins, or dig counts.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-digguilds.json";
const COINS_ID = 995;

const RANK_DIGGER = "digger";
const RANK_EXCAVATOR = "excavator";
const RANK_CONSERVATOR = "conservator";
const RANKS = Object.freeze([RANK_DIGGER, RANK_EXCAVATOR, RANK_CONSERVATOR]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_CONSERVATION_SHARE = 5; // of each dues payment feeds the conservation fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const AUTH_FEE = 50; // real coins to authenticate an artifact
const AUTH_MIN_VALUE = 100; // below this an artifact isn't worth authenticating
const AUTH_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const GRADE_FOR_CONDITION = Object.freeze({
  fragmented: "C",
  damaged: "B",
  pristine: "A",
});

const LOOTED_DIGS = 6; // site digs at/above this with 0 donations = looted
const FLAGS_FOR_PROTECTION = 2;

const PROMOTE_EXCAVATOR = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2, digs: 5 });
const PROMOTE_CONSERVATOR = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, authentications: 3 });

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const HALL_TILE_DX = 6; // guild hall sits a few tiles from the museum
const HALL_TILE_DY = 10;

const EXCAVATION_CODE = Object.freeze([
  "Record everything: a find without context is a rumor, not history.",
  "Leave the site better than the diggers found it.",
  "The museum holds the past in trust; hoarding is looting with paperwork.",
  "Never sell what you cannot prove you dug.",
  "Teach one digger for every season you dig.",
]);

// --- state ---------------------------------------------------------------

let cache = null;
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury, conservationFund, prestige }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntilMs, missedDues, suspended, trainingCredits, authCount, clean }
    seals: Object.create(null), // artifactId -> { artifactId, owner, grade, kind, value, siteId, sealedAt, kingdomId, protected: bool }
    queue: [], // [ { artifactId, owner, kingdomId, submittedAt } ]
    bountiesOwed: Object.create(null), // "owner:artifactId" -> coins owed
    cases: Object.create(null), // id -> { id, kingdomId, accused, artifactId, kind, reporter, filedAt, votes: {voter: verdict}, status }
    inspections: Object.create(null), // siteId -> { siteId, kingdomId, flags, lastFlagAt, protected }
    mentors: Object.create(null), // diggerNorm -> { master, since }
    archive: [], // [ { artifactId, kind, grade, value, siteId, kingdomId, sealedAt } ]
    seenQueue: Object.create(null), // artifactId -> true (auto-submit bookkeeping)
    nextId: 1,
  };
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

function savePath() {
  try {
    const path = require("path");
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
        const blank = blankState();
        for (const k of Object.keys(blank)) {
          if (raw[k] !== undefined && raw[k] !== null) cache[k] = raw[k];
        }
        if (typeof cache.nextId !== "number" || cache.nextId < 1) cache.nextId = 1;
      }
    }
  } catch {
    // Corrupt or missing save — start fresh rather than crash the tick.
  }
  return cache;
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const dir = path.dirname(savePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(savePath(), JSON.stringify(load(), null, 2), "utf8");
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  cache = blankState();
  dirty = false;
}

function archApi() {
  try { return require("./CitizenArchaeology"); }
  catch { return null; }
}

// --- guilds ----------------------------------------------------------------

function hallTileFor(kingdomId) {
  try {
    const A = archApi();
    const museum = A && A.museumTileFor ? A.museumTileFor(kingdomId) : null;
    if (!museum) return null;
    return {
      x: (museum.x || 0) + HALL_TILE_DX,
      y: (museum.y || 0) + HALL_TILE_DY,
      z: museum.z || 0,
    };
  } catch { return null; }
}

function ensureGuild(kingdomId) {
  const st = load();
  const k = String(kingdomId || "unknown");
  if (!st.guilds[k]) {
    st.guilds[k] = {
      kingdomId: k,
      hallTile: hallTileFor(k),
      foundedAt: Date.now(),
      treasury: 0,
      conservationFund: 0,
      prestige: 0,
    };
    markDirty();
  }
  return st.guilds[k];
}

function guildOf(kingdomId) {
  const g = load().guilds[String(kingdomId || "unknown")];
  return g || null;
}

// --- membership --------------------------------------------------------------

function isGuildMember(username) {
  const m = load().members[norm(username)];
  return Boolean(m && !m.suspended);
}

function memberOf(username) {
  return load().members[norm(username)] || null;
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

/**
 * Join requires being a REAL registered archaeologist. The guild polices the
 * trade — it never mints archaeologists.
 */
function joinGuild(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key) return { ok: false, reason: "no identity" };
  const A = archApi();
  if (!A || typeof A.isArchaeologist !== "function") {
    return { ok: false, reason: "archaeology records unavailable" };
  }
  if (!A.isArchaeologist(username)) {
    return { ok: false, reason: "only registered archaeologists may join the Excavators' Guild" };
  }
  if (st.members[key] && !st.members[key].suspended) {
    return { ok: true, already: true, rank: st.members[key].rank };
  }
  const g = ensureGuild(kingdomId);
  st.members[key] = {
    username: String(username),
    kingdomId: g.kingdomId,
    rank: RANK_DIGGER,
    joinedAt: Date.now(),
    duesPaidUntilMs: Date.now() + DUES_PERIOD_MS, // a week of grace on joining
    missedDues: 0,
    suspended: false,
    trainingCredits: 0,
    authCount: 0,
    clean: true,
  };
  markDirty();
  return { ok: true, rank: RANK_DIGGER };
}

function leaveGuild(username) {
  const st = load();
  const key = norm(username);
  if (!st.members[key]) return { ok: false, reason: "not a member" };
  delete st.members[key];
  if (st.mentors[key]) delete st.mentors[key];
  markDirty();
  return { ok: true };
}

/** Record a real dues payment: treasury takes the cut, the conservation fund the share. */
function recordDuesPayment(username, nowMs) {
  const st = load();
  const m = st.members[norm(username)];
  if (!m) return { ok: false, reason: "not a member" };
  const g = ensureGuild(m.kingdomId);
  const share = Math.min(DUES_CONSERVATION_SHARE, DUES_WEEKLY);
  g.treasury += (DUES_WEEKLY - share);
  g.conservationFund += share;
  m.duesPaidUntilMs = (nowMs ?? Date.now()) + DUES_PERIOD_MS;
  m.missedDues = 0;
  if (m.suspended) m.suspended = false;
  markDirty();
  return { ok: true, treasury: g.treasury, fund: g.conservationFund };
}

/** A missed online collection. Two in a row -> suspended. Offline members are never iterated. */
function recordMissedDues(username) {
  const st = load();
  const m = st.members[norm(username)];
  if (!m || m.suspended) return { ok: false };
  m.missedDues = (m.missedDues || 0) + 1;
  if (m.missedDues >= SUSPEND_AFTER_MISSED) m.suspended = true;
  markDirty();
  return { ok: true, suspended: m.suspended, missed: m.missedDues };
}

function guildTreasuryFor(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? g.treasury : 0;
}

function conservationFundFor(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? g.conservationFund : 0;
}

// --- authentication ------------------------------------------------------------

/** Verify an artifact can honestly be authenticated: real record, owned by the submitter, not donated. */
function verifyArtifact(username, artifactId) {
  const A = archApi();
  if (!A) return { ok: false, reason: "archaeology records unavailable" };
  const a = A.artifactOf ? A.artifactOf(artifactId) : null;
  if (!a) return { ok: false, reason: "no such artifact" };
  if (a.owner !== norm(username)) return { ok: false, reason: "not yours to authenticate" };
  if (a.donated) return { ok: false, reason: "museum pieces are already curated" };
  if ((a.value || 0) < AUTH_MIN_VALUE) return { ok: false, reason: "too humble to warrant the guild seal" };
  const st = load();
  if (st.seals[String(artifactId)]) return { ok: false, reason: "already authenticated" };
  return { ok: true, artifact: a };
}

/**
 * Authenticate an artifact. `takeFee(botLike, coins) => bool` and
 * `payBounty(botLike, coins) => bool` keep this engine-agnostic. Mentored
 * diggers pay no fee; protected-site finds earn double bounty. The bounty
 * is owed honestly when the treasury runs dry.
 */
function authenticateArtifact(username, artifactId, takeFee, payBounty) {
  const st = load();
  const key = norm(username);
  const m = st.members[key];
  if (!m || m.suspended) return { ok: false, reason: "guild members in good standing only" };
  const v = verifyArtifact(username, artifactId);
  if (!v.ok) return v;
  const a = v.artifact;
  const mentored = Boolean(st.mentors[key]);
  if (!mentored) {
    let paid = false;
    try { paid = takeFee ? takeFee(username, AUTH_FEE) === true : false; } catch { paid = false; }
    if (!paid) return { ok: false, reason: "could not pay the authentication fee" };
    const g = ensureGuild(m.kingdomId);
    g.treasury += AUTH_FEE;
  }
  const grade = GRADE_FOR_CONDITION[a.condition] || "C";
  const prot = isProtectedSite(a.siteId);
  let bounty = AUTH_BOUNTY[grade] || 0;
  if (prot) bounty *= 2;
  const g = ensureGuild(m.kingdomId);
  let owed = 0;
  if (bounty > 0) {
    if (g.treasury >= bounty) {
      let paid = false;
      try { paid = payBounty ? payBounty(username, bounty) === true : false; } catch { paid = false; }
      if (paid) {
        g.treasury -= bounty;
      } else {
        owed = bounty; // payment failed — owe it honestly
      }
    } else {
      owed = bounty; // treasury broke — owe it honestly, never invent coins
    }
  }
  if (owed > 0) st.bountiesOwed[`${key}:${a.id}`] = (st.bountiesOwed[`${key}:${a.id}`] || 0) + owed;
  st.seals[a.id] = {
    artifactId: a.id, owner: key, grade, kind: a.kind, value: a.value,
    siteId: a.siteId, sealedAt: Date.now(), kingdomId: m.kingdomId, protected: prot,
  };
  st.archive.push({
    artifactId: a.id, kind: a.kind, grade, value: a.value,
    siteId: a.siteId, kingdomId: m.kingdomId, sealedAt: Date.now(),
  });
  const credit = mentored ? 2 : 1; // mentored authentications count double
  m.authCount = (m.authCount || 0) + credit;
  g.prestige = Math.min(100, g.prestige + 1);
  markDirty();
  return { ok: true, grade, bounty, owed, protected: prot, seal: st.seals[a.id] };
}

/** Retry honestly-owed bounties as the treasury refills. */
function retryOwedBounties(kingdomId, payBounty) {
  const st = load();
  const g = guildOf(kingdomId);
  if (!g) return 0;
  let paid = 0;
  for (const k of Object.keys(st.bountiesOwed)) {
    const [owner, artifactId] = k.split(":");
    const owed = st.bountiesOwed[k];
    if (owed <= 0) { delete st.bountiesOwed[k]; continue; }
    const m = st.members[owner];
    if (!m || m.kingdomId !== g.kingdomId) continue;
    if (g.treasury < owed) continue;
    let ok = false;
    try { ok = payBounty ? payBounty(owner, owed) === true : false; } catch { ok = false; }
    if (ok) {
      g.treasury -= owed;
      delete st.bountiesOwed[k];
      paid += owed;
    }
  }
  if (paid) markDirty();
  return paid;
}

function sealFor(artifactId) {
  return load().seals[String(artifactId)] || null;
}

function authGradeFor(artifactId) {
  const s = sealFor(artifactId);
  return s ? s.grade : null;
}

// --- forgery tribunal ------------------------------------------------------------

/**
 * Verifiable forgery: the artifact's site is unknown to the real site
 * records, or its foundAt predates the site's founding. Real data only —
 * never a hunch.
 */
function scanForgery(artifactId) {
  const A = archApi();
  if (!A) return null;
  const a = A.artifactOf ? A.artifactOf(artifactId) : null;
  if (!a) return null;
  const site = A.siteOf ? A.siteOf(a.siteId) : null;
  if (!site) return "phantom site";
  if ((a.foundAt || 0) < (site.foundedAt || 0)) return "impossible date";
  return null;
}

function reportForgery(kingdomId, artifactId, reporter) {
  const st = load();
  const A = archApi();
  const a = A && A.artifactOf ? A.artifactOf(artifactId) : null;
  if (!a) return { ok: false, reason: "no such artifact" };
  // No double jeopardy: one live case per artifact.
  for (const c of Object.values(st.cases)) {
    if (c.artifactId === String(artifactId) && c.status === "open") {
      return { ok: false, reason: "a case is already open on this artifact" };
    }
  }
  const kind = scanForgery(artifactId);
  if (!kind) return { ok: false, reason: "the guild finds no fault with this piece" };
  const g = ensureGuild(kingdomId);
  const id = `case-${st.nextId++}`;
  st.cases[id] = {
    id, kingdomId: g.kingdomId, accused: a.owner || a.finder || "unknown",
    artifactId: String(artifactId), kind,
    reporter: reporter || "guild", filedAt: Date.now(),
    votes: Object.create(null), status: "open",
  };
  markDirty();
  return { ok: true, id, kind };
}

function voteOnCase(caseId, voter, guilty) {
  const st = load();
  const c = st.cases[String(caseId)];
  if (!c || c.status !== "open") return { ok: false, reason: "no open case" };
  const v = st.members[norm(voter)];
  if (!v || v.suspended || v.rank !== RANK_CONSERVATOR) {
    return { ok: false, reason: "conservators in good standing vote" };
  }
  c.votes[norm(voter)] = guilty ? "guilty" : "innocent";
  markDirty();
  return { ok: true };
}

/** Settle ripe cases (24h+): guilty needs 2+ guilty votes. Guilty -> expulsion + forger deed + confiscation via the real donate flow. */
function settleRipeCases(kingdomId, nowMs) {
  const st = load();
  const now = nowMs ?? Date.now();
  const settled = [];
  for (const c of Object.values(st.cases)) {
    if (c.status !== "open") continue;
    if (c.kingdomId !== String(kingdomId)) continue;
    if (now - (c.filedAt || 0) < CASE_TTL_MS) continue;
    const votes = Object.values(c.votes || {});
    const guiltyVotes = votes.filter((x) => x === "guilty").length;
    const guilty = guiltyVotes >= VOTES_FOR_QUORUM;
    c.status = guilty ? "guilty" : "acquitted";
    c.settledAt = now;
    if (guilty) {
      const key = norm(c.accused);
      const m = st.members[key];
      if (m) { m.suspended = true; m.clean = false; delete st.members[key]; }
      // Confiscate the fake through the real museum-donation flow.
      try {
        const A = archApi();
        const a = A && A.artifactOf ? A.artifactOf(c.artifactId) : null;
        if (A && a && a.owner && A.donateArtifact) {
          A.donateArtifact(a.owner, c.artifactId);
        }
      } catch { /* confiscation is best-effort */ }
      try {
        const Rep = require("./CitizenReputation");
        if (Rep.awardDeed) Rep.awardDeed(c.accused, "forger");
      } catch { /* fame optional */ }
    }
    settled.push({ id: c.id, guilty, accused: c.accused });
    markDirty();
  }
  return settled;
}

// --- site conservation ------------------------------------------------------------

function donationsFromSite(siteId, kingdomId) {
  const A = archApi();
  if (!A || !A.museumCollection) return 0;
  return A.museumCollection(kingdomId).filter((a) => a.siteId === String(siteId)).length;
}

/**
 * Inspect a REAL active dig site. Returns { ok, result, reasons }.
 * LOOTED: 6+ real digs, 0 museum donations from the site.
 */
function inspectSite(siteId) {
  const st = load();
  const A = archApi();
  if (!A) return { ok: false, reason: "archaeology records unavailable" };
  const site = A.siteOf ? A.siteOf(siteId) : null;
  if (!site) return { ok: false, reason: "no such dig site" };
  const donations = donationsFromSite(site.id, site.kingdomId);
  const reasons = [];
  let result = "PASS";
  if ((site.digCount || 0) >= LOOTED_DIGS && donations === 0) {
    result = "FLAG";
    reasons.push(`looted: ${site.digCount} digs, nothing reached the museum`);
  }
  const rec = st.inspections[site.id] || { siteId: site.id, kingdomId: site.kingdomId, flags: 0, lastFlagAt: 0, protected: false };
  if (result === "FLAG") {
    rec.flags = (rec.flags || 0) + 1;
    rec.lastFlagAt = Date.now();
    if (rec.flags >= FLAGS_FOR_PROTECTION && !rec.protected) {
      rec.protected = true;
      reasons.push("declared PROTECTED by the guild");
    }
  } else {
    rec.flags = 0;
  }
  st.inspections[site.id] = rec;
  markDirty();
  return { ok: true, result, reasons, protected: rec.protected, site };
}

function isProtectedSite(siteId) {
  const rec = load().inspections[String(siteId)];
  return Boolean(rec && rec.protected);
}

function protectedSites(kingdomId) {
  const k = String(kingdomId);
  return Object.values(load().inspections)
    .filter((r) => r.protected && (!kingdomId || r.kingdomId === k))
    .map((r) => r.siteId);
}

// --- mentorship ---------------------------------------------------------------------

function takeApprentice(masterUsername, diggerUsername) {
  const st = load();
  const master = st.members[norm(masterUsername)];
  const digger = st.members[norm(diggerUsername)];
  if (!master || master.suspended || master.rank !== RANK_CONSERVATOR) {
    return { ok: false, reason: "conservators in good standing mentor" };
  }
  if (!digger || digger.suspended || digger.rank !== RANK_DIGGER) {
    return { ok: false, reason: "only digger-rank members can be mentored" };
  }
  st.mentors[norm(diggerUsername)] = { master: norm(masterUsername), since: Date.now() };
  markDirty();
  return { ok: true };
}

function mentoredBy(username) {
  const rec = load().mentors[norm(username)];
  return rec ? rec.master : null;
}

// --- field school ---------------------------------------------------------------------

function holdClass(kingdomId, teacherUsername) {
  const st = load();
  const g = ensureGuild(kingdomId);
  const teacher = st.members[norm(teacherUsername)];
  if (!teacher || teacher.suspended || teacher.rank !== RANK_CONSERVATOR) {
    return { ok: false, reason: "a conservator must teach" };
  }
  let taught = 0;
  for (const m of Object.values(st.members)) {
    if (m.kingdomId !== g.kingdomId || m.suspended) continue;
    if (m.rank === RANK_DIGGER || m.rank === RANK_EXCAVATOR) {
      m.trainingCredits = (m.trainingCredits || 0) + 1;
      taught += 1;
    }
  }
  if (taught) markDirty();
  return { ok: true, taught };
}

function canPromote(username) {
  const st = load();
  const m = st.members[norm(username)];
  if (!m || m.suspended || !m.clean) return { ok: false, reason: "not eligible" };
  const now = Date.now();
  const A = archApi();
  if (m.rank === RANK_DIGGER) {
    if (now - (m.joinedAt || 0) < PROMOTE_EXCAVATOR.tenureMs) return { ok: false, reason: "needs more tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_EXCAVATOR.credits) return { ok: false, reason: "needs field-school credits" };
    const digs = A && A.digCountFor ? A.digCountFor(username) : 0;
    if (digs < PROMOTE_EXCAVATOR.digs) return { ok: false, reason: `needs ${PROMOTE_EXCAVATOR.digs} real digs` };
    return { ok: true, to: RANK_EXCAVATOR };
  }
  if (m.rank === RANK_EXCAVATOR) {
    if (now - (m.joinedAt || 0) < PROMOTE_CONSERVATOR.tenureMs) return { ok: false, reason: "needs more tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_CONSERVATOR.credits) return { ok: false, reason: "needs field-school credits" };
    if ((m.authCount || 0) < PROMOTE_CONSERVATOR.authentications) return { ok: false, reason: "needs conducted authentications" };
    return { ok: true, to: RANK_CONSERVATOR };
  }
  return { ok: false, reason: "already at the top" };
}

function promote(username) {
  const st = load();
  const m = st.members[norm(username)];
  if (!m) return { ok: false, reason: "not a member" };
  const el = canPromote(username);
  if (!el.ok) return el;
  m.rank = el.to;
  if (st.mentors[norm(username)]) delete st.mentors[norm(username)]; // mentorship ends at excavator
  if (el.to === RANK_CONSERVATOR) {
    try {
      const Rep = require("./CitizenReputation");
      if (Rep.awardDeed) Rep.awardDeed(username, "masterexcavator");
    } catch { /* fame optional */ }
  }
  markDirty();
  return { ok: true, rank: m.rank };
}

// --- voluntary contributions ------------------------------------------------------------

function contribute(username, coins, takeCoins) {
  const st = load();
  const m = st.members[norm(username)];
  if (!m || m.suspended) return { ok: false, reason: "guild members in good standing only" };
  let taken = false;
  try { taken = takeCoins ? takeCoins(username, coins) === true : false; } catch { taken = false; }
  if (!taken) return { ok: false, reason: "could not take the coins" };
  const g = ensureGuild(m.kingdomId);
  g.conservationFund += coins;
  markDirty();
  return { ok: true, fund: g.conservationFund };
}

// --- describe ---------------------------------------------------------------------

function describe(kingdomId) {
  const st = load();
  const g = guildOf(kingdomId);
  const members = Object.values(st.members).filter((m) => !kingdomId || m.kingdomId === String(kingdomId));
  return {
    exists: Boolean(g),
    hallTile: g ? g.hallTile : null,
    treasury: g ? g.treasury : 0,
    conservationFund: g ? g.conservationFund : 0,
    prestige: g ? g.prestige : 0,
    memberCount: members.length,
    conservators: members.filter((m) => m.rank === RANK_CONSERVATOR).length,
    authenticated: Object.keys(st.seals).length,
    protected: protectedSites(kingdomId).length,
    openCases: Object.values(st.cases).filter((c) => c.status === "open").length,
  };
}

module.exports = {
  SAVE_KEY,
  COINS_ID,
  RANK_DIGGER,
  RANK_EXCAVATOR,
  RANK_CONSERVATOR,
  RANKS,
  DUES_WEEKLY,
  DUES_PERIOD_MS,
  AUTH_FEE,
  AUTH_MIN_VALUE,
  AUTH_BOUNTY,
  GRADE_FOR_CONDITION,
  EXCAVATION_CODE,
  ensureGuild,
  guildOf,
  isGuildMember,
  memberOf,
  guildRankOf,
  joinGuild,
  leaveGuild,
  recordDuesPayment,
  recordMissedDues,
  guildTreasuryFor,
  conservationFundFor,
  verifyArtifact,
  authenticateArtifact,
  retryOwedBounties,
  sealFor,
  authGradeFor,
  scanForgery,
  reportForgery,
  voteOnCase,
  settleRipeCases,
  inspectSite,
  isProtectedSite,
  protectedSites,
  takeApprentice,
  mentoredBy,
  holdClass,
  canPromote,
  promote,
  contribute,
  describe,
  save,
  resetForTests,
};
