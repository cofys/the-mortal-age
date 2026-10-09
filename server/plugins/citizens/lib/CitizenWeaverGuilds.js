"use strict";

/**
 * CitizenWeaverGuilds — the Weavers' Guild: the fashion profession's operations
 * layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenRunways owns: designers, houses, venues, shows, tickets,
 *     ateliers, collections, reviews (never reimplemented — READ only).
 *   - CitizenFashion owns: garment catalog, clothing shops, weekly trends,
 *     style competitions, seasonal effects (never reimplemented — READ only).
 *   - CitizenTailors / CitizenTailors2 own: hash-derived tailor flavor
 *     (frozen, untouched).
 *   - CitizenRunway (brain) owns: designers walking to venues and staging in
 *     human-paced rounds. THIS module owns the profession's guild layer only.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One Weavers' Guild per kingdom with a hall tile near the runway venue,
 *     a real tracked treasury, a real tracked atelier fund, and prestige.
 *   - Membership: apprentice -> couturier -> grandcouturier. Joining requires
 *     being a REAL designer: the registered designer list
 *     (CitizenRunways.isDesigner), OR the `designer` career
 *     (CitizenCareers.careerOf), OR membership in a designer house
 *     (CitizenRunways.houseForDesigner). The guild polices the trade, never
 *     mints designers. Weekly dues in REAL coins; two missed online
 *     collections -> suspended until caught up. Offline members are never
 *     penalized.
 *   - Collection certification: members submit collections they REALLY
 *     created (verified against CitizenRunways.collectionFor — collection
 *     exists, designer matches the claimant, quality is finite 1-10, not
 *     already sealed). A 50-coin real fee (mentored apprentices certify
 *     free). Grades from the REAL quality: >=8=A, >=5=B, else C. The guild
 *     pays a REAL bounty from its treasury (C:30 / B:60 / A:120); the atelier
 *     fund backs bounties when the treasury runs dry; when both are broke
 *     the bounty is owed honestly, never invented.
 *   - Knockoff tribunal: the one verifiable fashion crime — a counterfeit:
 *     a collection whose normalized name duplicates an EARLIER collection
 *     (by createdAt) by a DIFFERENT designer. Members/players report;
 *     couturier-rank members vote; 24h auto-settle. Guilty -> expulsion +
 *     `knockoff` deed.
 *   - Atelier inspections: the guild's style score per kingdom is computed
 *     from REAL data — every atelier (CitizenRunways.ateliersIn) and its REAL
 *     available inventory. Ateliers with zero available pieces are idle.
 *     Scores below 40 trigger a public style-audit announcement.
 *   - Golden needle: quarterly, the guild member with the most REAL sealed
 *     collections in the kingdom wins a 200-coin real prize (owed honestly
 *     when broke) and a public announcement.
 *   - Fashion school: grandcouturier masters teach apprentices (training
 *     credits). Promotion: apprentice -> couturier (30d tenure + 2 credits +
 *     a real sealed collection), couturier -> grandcouturier (60d tenure +
 *     4 credits + 2 conducted certifications + clean record). All verifiable
 *     from real records — never invented.
 *   - Mentorship: grandcouturier masters take apprentice members under wing.
 *     While mentored, the apprentice pays no certification fees and their
 *     certifications count double toward promotion. Mentorship ends after
 *     the first certification.
 *   - Certified archive: the guild's certified registry — metadata copies of
 *     every certified collection (the collection stays in the runways
 *     ledger; never a double-spend). Prestige 0-100 from real counts.
 *   - Public API: isGuildMember, guildRankOf, memberOf, memberNames,
 *     sealFor, gradeFor, guildTreasuryFor, inspectionFor, describe.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenWeaverGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented designers, collections, inspections, coins, or ateliers.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-weaverguilds.json";
const COINS_ID = 995;

const RANK_APPRENTICE = "apprentice";
const RANK_COUTURIER = "couturier";
const RANK_GRANDCOUTURIER = "grandcouturier";
const RANKS = Object.freeze([RANK_APPRENTICE, RANK_COUTURIER, RANK_GRANDCOUTURIER]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_ATELIER_SHARE = 5; // of each dues payment feeds the atelier fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const CERT_FEE = 50; // real coins to certify a collection
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const GRADE_A_QUALITY = 8;
const GRADE_B_QUALITY = 5;

const NEEDLE_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly golden needle
const NEEDLE_PRIZE = 200; // real coins from the treasury

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const HALL_TILE_DX = 5; // guild hall sits a few tiles from the runway venue
const HALL_TILE_DY = -4;

const INSPECTION_AUDIT_THRESHOLD = 40; // below this the guild announces an audit

const PROMOTE_COUTURIER = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2 });
const PROMOTE_GRANDCOUTURIER = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, certifications: 2 });

const WEAVERS_CODE = Object.freeze([
  "The stitch is the signature — never claim a collection you did not cut.",
  "A straight seam is a guild seam: nothing below grade leaves the atelier.",
  "Honor every bolt of cloth; waste is theft from the loom.",
  "Charge honest prices; the sharp-eyed can spot a cheat.",
  "Teach one apprentice for every season you design.",
]);

// --- state ---------------------------------------------------------------

let cache = null;
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury, atelierFund, prestige, inspection, lastInspectionAt, lastNeedleAt }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntilMs, missedDues, suspended, trainingCredits, certCount, clean, mentor }
    seals: Object.create(null), // "kingdomId:collectionId" -> { kingdomId, collectionId, holder, grade, sealedAt }
    queue: [], // [ { kingdomId, collectionId, owner, submittedAt } ]
    bountiesOwed: Object.create(null), // "owner:kingdomId:collectionId" -> coins owed
    cases: Object.create(null), // caseId -> { id, kingdomId, accused, kind, reporter, at, votes: {voter: bool}, settled, verdict }
    needleOwed: Object.create(null), // kingdomId -> coins owed
    nextCaseId: 1,
  };
}

function ensure() {
  if (!cache) cache = blankState();
  return cache;
}

function markDirty() { dirty = true; }

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

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

function hallTileFor(kingdomId) {
  const kid = String(kingdomId || "");
  let tile = null;
  try {
    const R = require("./CitizenRunways");
    tile = R && typeof R.runwayTileFor === "function" ? R.runwayTileFor(kid) : null;
  } catch { tile = null; }
  if (!tile) {
    try {
      const S = require("../brain/CitizenSites");
      // siteTile needs a player entity; for a bare kingdom id the real
      // contract is siteTileByKingdom (a plain { kingdomId } object would
      // silently resolve to the first kingdom).
      tile = S && typeof S.siteTileByKingdom === "function" ? S.siteTileByKingdom(kid, "market") : null;
    } catch { tile = null; }
  }
  if (!tile) return { x: 3200, y: 3200, z: 0 };
  return { x: (tile.x ?? 3200) + HALL_TILE_DX, y: (tile.y ?? 3200) + HALL_TILE_DY, z: tile.z ?? 0 };
}

// --- guilds ---------------------------------------------------------------

function ensureGuild(kingdomId) {
  const s = ensure();
  if (!s.guilds[kingdomId]) {
    s.guilds[kingdomId] = {
      kingdomId,
      hallTile: hallTileFor(kingdomId),
      foundedAt: Date.now(),
      treasury: 0,
      atelierFund: 0,
      prestige: 0,
      inspection: 100,
      lastInspectionAt: 0,
      lastNeedleAt: 0,
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

function inspectionFor(kingdomId) {
  return guildOf(kingdomId).inspection;
}

// --- membership -----------------------------------------------------------

function isGuildMember(username) {
  return !!ensure().members[norm(username)];
}

function memberOf(username) {
  return ensure().members[norm(username)] || null;
}

function memberNames(kingdomId) {
  const s = ensure();
  return Object.keys(s.members).filter((n) => s.members[n].kingdomId === kingdomId);
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

/**
 * A REAL designer: registered in the runway designer list, the designer
 * career, or a member of a designer house. The guild polices the trade,
 * never mints designers.
 */
function isRealDesigner(username) {
  const n = norm(username);
  if (!n) return false;
  try {
    const R = require("./CitizenRunways");
    if (R && typeof R.isDesigner === "function" && R.isDesigner(username)) return true;
    if (R && typeof R.houseForDesigner === "function" && R.houseForDesigner(username)) return true;
  } catch { /* no runways */ }
  try {
    const C = require("./CitizenCareers");
    const rec = C && typeof C.careerOf === "function" ? C.careerOf(username) : null;
    if (rec && String(rec.career || rec.name || "").toLowerCase() === "designer") return true;
  } catch { /* no careers */ }
  return false;
}

function joinGuild(username, kingdomId) {
  const s = ensure();
  const n = norm(username);
  if (!username) return { ok: false, reason: "no-username" };
  if (s.members[n]) return { ok: false, reason: "already-member" };
  if (!isRealDesigner(username)) return { ok: false, reason: "not-a-designer" };
  ensureGuild(kingdomId);
  const now = Date.now();
  s.members[n] = {
    username,
    kingdomId,
    rank: RANK_APPRENTICE,
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
  return { ok: true, rank: RANK_APPRENTICE };
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
  if (!m) return { ok: false };
  // Suspended members may catch up: paying clears the suspension ("suspended
  // until caught up"). The old guard rejected suspended payers AFTER their
  // coins were already taken by the caller — coins lost, dues unrecorded.
  const g = ensureGuild(m.kingdomId);
  g.treasury += (DUES_WEEKLY - DUES_ATELIER_SHARE);
  g.atelierFund += DUES_ATELIER_SHARE;
  m.duesPaidUntilMs = Math.max(m.duesPaidUntilMs || 0, nowMs) + DUES_PERIOD_MS;
  m.missedDues = 0;
  m.suspended = false;
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

// --- collection certification ----------------------------------------------

function gradeForQuality(quality) {
  if (quality >= GRADE_A_QUALITY) return "A";
  if (quality >= GRADE_B_QUALITY) return "B";
  return "C";
}

/** The REAL collection record, or null. */
function realCollectionFor(collectionId) {
  try {
    const R = require("./CitizenRunways");
    if (R && typeof R.collectionFor === "function") return R.collectionFor(collectionId) || null;
  } catch { /* no runways */ }
  return null;
}

function sealFor(kingdomId, collectionId) {
  return ensure().seals[`${kingdomId}:${collectionId}`] || null;
}

function gradeFor(kingdomId, collectionId) {
  const seal = sealFor(kingdomId, collectionId);
  return seal ? seal.grade : null;
}

function sealsForKingdom(kingdomId) {
  return Object.values(ensure().seals).filter((s2) => s2.kingdomId === kingdomId);
}

function submitCollection(username, kingdomId, collectionId, nowMs) {
  const s = ensure();
  const n = norm(username);
  const m = s.members[n];
  if (!m || m.suspended) return { ok: false, reason: "not-member-in-good-standing" };
  if (m.kingdomId !== kingdomId) return { ok: false, reason: "wrong-kingdom" };
  // Verify against the REAL runways ledger.
  const col = realCollectionFor(collectionId);
  if (!col) return { ok: false, reason: "no-such-collection" };
  if (norm(col.designer) !== n) return { ok: false, reason: "not-your-collection" };
  if (!Number.isFinite(col.quality) || col.quality < 1 || col.quality > 10) {
    return { ok: false, reason: "impossible-quality" };
  }
  const key = `${kingdomId}:${collectionId}`;
  if (s.seals[key]) return { ok: false, reason: "already-sealed" };
  if (s.queue.some((q) => q.kingdomId === kingdomId && String(q.collectionId) === String(collectionId))) {
    return { ok: false, reason: "already-queued" };
  }
  // Fee: mentored apprentices certify free.
  const fee = m.mentor ? 0 : CERT_FEE;
  s.queue.push({ kingdomId, collectionId: String(collectionId), owner: username, submittedAt: nowMs || Date.now() });
  markDirty();
  return { ok: true, fee, quality: col.quality };
}

function settleCertification(kingdomId, collectionId, nowMs) {
  const s = ensure();
  const key = `${kingdomId}:${collectionId}`;
  const qi = s.queue.findIndex((q) => q.kingdomId === kingdomId && String(q.collectionId) === String(collectionId));
  if (qi < 0) return { ok: false, reason: "not-queued" };
  const q = s.queue[qi];
  // Re-verify at settle time (the collection may have changed since).
  const col = realCollectionFor(collectionId);
  if (!col || norm(col.designer) !== norm(q.owner) ||
      !Number.isFinite(col.quality) || col.quality < 1 || col.quality > 10) {
    s.queue.splice(qi, 1);
    markDirty();
    return { ok: false, reason: "collection-changed" };
  }
  const grade = gradeForQuality(col.quality);
  const m = s.members[norm(q.owner)];
  const bounty = CERT_BOUNTY[grade] || 0;
  const g = ensureGuild(kingdomId);
  let owed = 0;
  // Pay from treasury, then atelier fund, then owe honestly.
  let remaining = bounty;
  const fromTreasury = Math.min(g.treasury, remaining);
  const fromFund = Math.min(g.atelierFund, remaining - fromTreasury);
  const toPay = fromTreasury + fromFund;
  // Credit the owner's REAL bank account before deducting — never mark
  // paid what was never delivered (vanishing-coins fix).
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
      g.treasury -= fromTreasury; remaining -= fromTreasury;
      g.atelierFund -= fromFund; remaining -= fromFund;
    }
  }
  if (remaining > 0) {
    const okey = `${q.owner}:${key}`;
    s.bountiesOwed[okey] = (s.bountiesOwed[okey] || 0) + remaining;
    owed = remaining;
  }
  s.seals[key] = {
    kingdomId, collectionId: String(collectionId), holder: q.owner, grade,
    sealedAt: nowMs || Date.now(),
  };
  s.queue.splice(qi, 1);
  if (m) {
    const credit = m.mentor ? 2 : 1; // mentored apprentices earn double credit
    m.certCount = (m.certCount || 0) + credit;
    if (m.mentor) m.mentor = null; // mentorship ends after first certification
  }
  g.prestige = Math.min(100, g.prestige + 2);
  markDirty();
  return { ok: true, grade, bounty, paid: bounty - owed, owed };
}

/**
 * Pull a queued submission back out (e.g. the submitter could not pay the
 * certification fee). Without this a failed payment leaves the collection
 * queued and the life tick settles it for free.
 */
function withdrawSubmission(kingdomId, collectionId) {
  const s = ensure();
  const qi = s.queue.findIndex((q) => q.kingdomId === kingdomId && String(q.collectionId) === String(collectionId));
  if (qi < 0) return { ok: false, reason: "not-queued" };
  s.queue.splice(qi, 1);
  markDirty();
  return { ok: true };
}

function retryOwedBounties(kingdomId) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  let paid = 0;
  for (const okey of Object.keys(s.bountiesOwed)) {
    // Key shape is `${owner}:${kingdomId}:${collectionId}` — never pay one
    // kingdom's owed bounties out of another kingdom's treasury.
    const parts = String(okey).split(":");
    if (parts.length < 3 || parts[1] !== String(kingdomId)) continue;
    const amt = s.bountiesOwed[okey];
    if (!amt) continue;
    const owner = parts[0];
    const fromTreasury = Math.min(g.treasury, amt);
    const fromFund = Math.min(g.atelierFund, amt - fromTreasury);
    const toPay = fromTreasury + fromFund;
    if (toPay <= 0) continue;
    // Credit the owner's bank account before deducting — never mark paid
    // what was never delivered.
    let credited = false;
    try {
      const B = bankingApi();
      const acct = B && typeof B.accountFor === "function" ? B.accountFor(owner) : null;
      if (acct) {
        acct.balance = (Number(acct.balance) || 0) + toPay;
        if (typeof B.markDirty === "function") B.markDirty();
        credited = true;
      }
    } catch { /* banking is best-effort */ }
    if (!credited) continue; // banking down — stays owed for a later tick
    g.treasury -= fromTreasury;
    let remaining = amt - fromTreasury;
    g.atelierFund -= fromFund;
    remaining -= fromFund;
    if (remaining <= 0) {
      delete s.bountiesOwed[okey];
      paid += amt;
    } else {
      s.bountiesOwed[okey] = remaining;
      paid += amt - remaining;
    }
  }
  if (paid > 0) markDirty();
  return { ok: true, paid };
}

function bountiesOwedFor(username) {
  const n = norm(username);
  const s = ensure();
  let total = 0;
  for (const okey of Object.keys(s.bountiesOwed)) {
    if (okey.toLowerCase().startsWith(`${n}:`)) total += s.bountiesOwed[okey];
  }
  return total;
}

// --- knockoff tribunal -------------------------------------------------------

/**
 * Scan the real runways ledger for counterfeits: a collection whose
 * normalized name duplicates an EARLIER collection (by createdAt) by a
 * DIFFERENT designer. Returns [{ collectionId, name, designer, earlierId,
 * earlierDesigner }] or [] when the ledger is unreadable.
 */
function scanKnockoffs() {
  let cols = [];
  try {
    const R = require("./CitizenRunways");
    if (!R || typeof R.collectionsIn !== "function") return [];
    for (const kid of kingdomIds()) {
      cols = cols.concat(R.collectionsIn(kid) || []);
    }
  } catch { return []; }
  const hits = [];
  const seen = [];
  const sorted = cols
    .filter((c) => c && c.name && Number.isFinite(c.createdAt))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const c of sorted) {
    const nameKey = String(c.name).toLowerCase().replace(/[^a-z0-9]/g, "");
    const earlier = seen.find((e) => e.nameKey === nameKey && norm(e.designer) !== norm(c.designer));
    if (earlier) {
      hits.push({
        collectionId: c.id,
        name: c.name,
        designer: c.designer,
        earlierId: earlier.id,
        earlierDesigner: earlier.designer,
      });
    }
    seen.push({ nameKey, designer: c.designer, id: c.id });
  }
  return hits;
}

function reportKnockoff(kingdomId, accused, reporter) {
  const s = ensure();
  const n = norm(accused);
  if (!n) return { ok: false, reason: "no-accused" };
  // Must be a real designer on the real ledger with a flagged collection.
  const hits = scanKnockoffs();
  if (!hits.some((h) => norm(h.designer) === n)) {
    return { ok: false, reason: "no-counterfeit-found" };
  }
  // No double jeopardy: one open case per accused.
  const open = Object.values(s.cases).find((c) => !c.settled && norm(c.accused) === n);
  if (open) return { ok: false, reason: "case-already-open", id: open.id };
  const id = `k${s.nextCaseId++}`;
  s.cases[id] = {
    id,
    kingdomId,
    accused,
    kind: "knockoff",
    reporter: reporter || "guild",
    at: Date.now(),
    votes: {},
    settled: false,
    verdict: null,
  };
  markDirty();
  return { ok: true, id };
}

function voteCase(caseId, voter, guilty) {
  const s = ensure();
  const c = s.cases[caseId];
  if (!c) return { ok: false, reason: "no-such-case" };
  if (c.settled) return { ok: false, reason: "case-settled" };
  const rank = guildRankOf(voter);
  if (rank !== RANK_COUTURIER && rank !== RANK_GRANDCOUTURIER) {
    return { ok: false, reason: "not-a-judge" };
  }
  const m = memberOf(voter);
  if (!m || m.kingdomId !== c.kingdomId || m.suspended) {
    return { ok: false, reason: "wrong-kingdom-or-suspended" };
  }
  c.votes[norm(voter)] = !!guilty;
  markDirty();
  return { ok: true };
}

/**
 * Settle ripe cases (older than CASE_TTL_MS). Quorum = 2 votes; ties acquit.
 * Guilty knockoff -> expulsion + knockoff deed via the real reputation API.
 */
function settleRipeCases(kingdomId, nowMs) {
  const s = ensure();
  nowMs = nowMs || Date.now();
  const settled = [];
  for (const c of Object.values(s.cases)) {
    if (c.settled || c.kingdomId !== kingdomId) continue;
    if (nowMs - c.at < CASE_TTL_MS) continue;
    const votes = Object.values(c.votes);
    if (votes.length < VOTES_FOR_QUORUM) {
      // No quorum: dismiss without prejudice.
      c.settled = true;
      c.verdict = "dismissed";
      settled.push({ id: c.id, verdict: "dismissed" });
      continue;
    }
    const guilty = votes.filter(Boolean).length;
    const innocent = votes.length - guilty;
    if (guilty > innocent) {
      c.settled = true;
      c.verdict = "guilty";
      // Expel the counterfeiter; dirty record.
      const m = s.members[norm(c.accused)];
      if (m) {
        delete s.members[norm(c.accused)];
        m.clean = false;
      }
      try {
        const Rep = require("./CitizenReputation");
        if (Rep && typeof Rep.awardDeed === "function") Rep.awardDeed(c.accused, "knockoff", nowMs);
      } catch { /* reputation is best-effort */ }
      settled.push({ id: c.id, verdict: "guilty" });
    } else {
      c.settled = true;
      c.verdict = "innocent";
      settled.push({ id: c.id, verdict: "innocent" });
    }
  }
  if (settled.length) markDirty();
  return settled;
}

// --- atelier inspections -------------------------------------------------------

/**
 * Compute the style score for a kingdom from REAL atelier data: the share of
 * the kingdom's ateliers with at least one available (unsold) piece. Empty
 * kingdoms score 100 (nothing to inspect — honest). Below the audit
 * threshold the guild announces a style audit.
 */
function inspectAteliers(kingdomId, nowMs) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  let ateliers = [];
  try {
    const R = require("./CitizenRunways");
    if (R && typeof R.ateliersIn === "function") ateliers = R.ateliersIn(kingdomId) || [];
  } catch { ateliers = []; }
  let inspected = 0;
  let stocked = 0;
  const idle = [];
  for (const at of ateliers) {
    if (!at) continue;
    inspected++;
    const available = (at.inventory || []).filter((p) => p && !p.sold).length;
    if (available > 0) stocked++;
    else idle.push(at.owner);
  }
  const score = inspected === 0 ? 100 : Math.round((stocked / inspected) * 100);
  g.inspection = score;
  g.lastInspectionAt = nowMs || Date.now();
  markDirty();
  return { ok: true, inspection: score, inspected, stocked, idle };
}

// --- golden needle --------------------------------------------------------------

/** Quarterly award: the guild member with the most sealed collections wins. */
function grantGoldenNeedle(kingdomId, nowMs) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  nowMs = nowMs || Date.now();
  if (nowMs - (g.lastNeedleAt || 0) < NEEDLE_PERIOD_MS) return { ok: false, reason: "not-due" };
  const names = memberNames(kingdomId).filter((n) => !s.members[n].suspended);
  let winner = null;
  let best = 0;
  for (const n of names) {
    const sealed = sealsForKingdom(kingdomId).filter((sv) => norm(sv.holder) === n).length;
    if (sealed > best) { best = sealed; winner = s.members[n].username; }
  }
  g.lastNeedleAt = nowMs;
  if (!winner || best === 0) { markDirty(); return { ok: false, reason: "no-candidates" }; }
  // The prize is credited to the winner's REAL bank account — deducting
  // from the treasury without delivering is the vanishing-coins bug.
  let owed = 0;
  let paid = 0;
  const prize = Math.min(g.treasury, NEEDLE_PRIZE);
  if (prize > 0) {
    let credited = false;
    try {
      const B = bankingApi();
      const acct = B && typeof B.accountFor === "function" ? B.accountFor(winner) : null;
      if (acct) {
        acct.balance = (Number(acct.balance) || 0) + prize;
        if (typeof B.markDirty === "function") B.markDirty();
        credited = true;
      }
    } catch { /* banking is best-effort */ }
    if (credited) {
      g.treasury -= prize;
      paid = prize;
    }
  }
  owed = NEEDLE_PRIZE - paid;
  if (owed > 0) s.needleOwed[kingdomId] = (s.needleOwed[kingdomId] || 0) + owed;
  g.lastNeedleWinner = winner;
  markDirty();
  return { ok: true, winner, sealed: best, paid, owed };
}

function retryNeedleOwed(kingdomId) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  const owed = s.needleOwed[kingdomId] || 0;
  if (!owed) return { ok: true, paid: 0 };
  const paid = Math.min(g.treasury, owed);
  if (paid <= 0) return { ok: true, paid: 0 };
  // Credit the recorded winner's bank account before deducting — never
  // mark paid what was never delivered.
  const winner = g.lastNeedleWinner;
  let credited = false;
  try {
    const B = bankingApi();
    const acct = B && winner && typeof B.accountFor === "function" ? B.accountFor(winner) : null;
    if (acct) {
      acct.balance = (Number(acct.balance) || 0) + paid;
      if (typeof B.markDirty === "function") B.markDirty();
      credited = true;
    }
  } catch { /* banking is best-effort */ }
  if (!credited) return { ok: true, paid: 0 };
  g.treasury -= paid;
  if (paid >= owed) delete s.needleOwed[kingdomId];
  else s.needleOwed[kingdomId] = owed - paid;
  markDirty();
  return { ok: true, paid };
}

// --- fashion school + mentorship ---------------------------------------------------

function holdClass(kingdomId, teacher) {
  const s = ensure();
  const rank = guildRankOf(teacher);
  if (rank !== RANK_GRANDCOUTURIER) return { ok: false, reason: "not-a-grandcouturier" };
  const tm = memberOf(teacher);
  if (!tm || tm.kingdomId !== kingdomId || tm.suspended) return { ok: false, reason: "wrong-kingdom-or-suspended" };
  let taught = 0;
  for (const n of memberNames(kingdomId)) {
    const m = s.members[n];
    if (m.rank !== RANK_APPRENTICE || m.suspended) continue;
    m.trainingCredits = (m.trainingCredits || 0) + 1;
    taught++;
  }
  markDirty();
  return { ok: true, taught };
}

function tryPromote(username) {
  const s = ensure();
  const m = s.members[norm(username)];
  if (!m || m.suspended) return { ok: false, reason: "not-member-in-good-standing" };
  if (m.clean === false) return { ok: false, reason: "dirty-record" };
  const now = Date.now();
  if (m.rank === RANK_APPRENTICE) {
    if (now - m.joinedAt < PROMOTE_COUTURIER.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_COUTURIER.credits) return { ok: false, reason: "training" };
    const sealed = sealsForKingdom(m.kingdomId).filter((sv) => norm(sv.holder) === norm(username)).length;
    if (sealed < 1) return { ok: false, reason: "no-sealed-collection" };
    m.rank = RANK_COUTURIER;
    markDirty();
    return { ok: true, rank: RANK_COUTURIER };
  }
  if (m.rank === RANK_COUTURIER) {
    if (now - m.joinedAt < PROMOTE_GRANDCOUTURIER.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_GRANDCOUTURIER.credits) return { ok: false, reason: "training" };
    if ((m.certCount || 0) < PROMOTE_GRANDCOUTURIER.certifications) return { ok: false, reason: "certifications" };
    m.rank = RANK_GRANDCOUTURIER;
    markDirty();
    return { ok: true, rank: RANK_GRANDCOUTURIER };
  }
  return { ok: false, reason: "top-rank" };
}

function takeApprentice(mentor, apprentice) {
  const s = ensure();
  const mm = s.members[norm(mentor)];
  const am = s.members[norm(apprentice)];
  if (!mm || mm.rank !== RANK_GRANDCOUTURIER || mm.suspended) return { ok: false, reason: "not-a-grandcouturier" };
  if (!am || am.rank !== RANK_APPRENTICE || am.suspended) return { ok: false, reason: "not-an-apprentice" };
  if (am.kingdomId !== mm.kingdomId) return { ok: false, reason: "wrong-kingdom" };
  am.mentor = mm.username;
  markDirty();
  return { ok: true };
}

// --- contribution --------------------------------------------------------------------

function contribute(username, kingdomId, amount) {
  const s = ensure();
  const g = ensureGuild(kingdomId);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "bad-amount" };
  g.treasury += amount;
  markDirty();
  return { ok: true, treasury: g.treasury };
}

// --- describe / persistence ------------------------------------------------------------

function describe(kingdomId) {
  const s = ensure();
  const g = s.guilds[kingdomId];
  if (!g) return { exists: false };
  const names = memberNames(kingdomId);
  return {
    exists: true,
    memberCount: names.length,
    grandcouturiers: names.filter((n) => s.members[n].rank === RANK_GRANDCOUTURIER).length,
    couturiers: names.filter((n) => s.members[n].rank === RANK_COUTURIER).length,
    sealed: sealsForKingdom(kingdomId).length,
    inspection: g.inspection,
    treasury: g.treasury,
    atelierFund: g.atelierFund,
    prestige: g.prestige,
  };
}

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), "data/saves", SAVE_KEY);
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, JSON.stringify(ensure(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function serialize() { ensure(); return JSON.parse(JSON.stringify(cache)); }

function resetForTests() {
  cache = blankState();
  dirty = false;
}

module.exports = {
  // tuning
  COINS_ID,
  DUES_WEEKLY,
  DUES_ATELIER_SHARE,
  CERT_FEE,
  CERT_BOUNTY,
  GRADE_A_QUALITY,
  GRADE_B_QUALITY,
  NEEDLE_PERIOD_MS,
  NEEDLE_PRIZE,
  RANK_APPRENTICE,
  RANK_COUTURIER,
  RANK_GRANDCOUTURIER,
  RANKS,
  WEAVERS_CODE,
  INSPECTION_AUDIT_THRESHOLD,
  // guilds
  ensureGuild,
  guildOf,
  guildTreasuryFor,
  inspectionFor,
  // membership
  isGuildMember,
  memberOf,
  memberNames,
  guildRankOf,
  isRealDesigner,
  joinGuild,
  leaveGuild,
  recordDuesPayment,
  recordMissedDues,
  // certification
  gradeForQuality,
  realCollectionFor,
  sealFor,
  gradeFor,
  sealsForKingdom,
  submitCollection,
  settleCertification,
  withdrawSubmission,
  retryOwedBounties,
  bountiesOwedFor,
  // tribunal
  scanKnockoffs,
  reportKnockoff,
  voteCase,
  settleRipeCases,
  // inspections
  inspectAteliers,
  // golden needle
  grantGoldenNeedle,
  retryNeedleOwed,
  // school
  holdClass,
  tryPromote,
  takeApprentice,
  // funds
  contribute,
  // misc
  describe,
  save,
  serialize,
  resetForTests,
  kingdomIds,
};
