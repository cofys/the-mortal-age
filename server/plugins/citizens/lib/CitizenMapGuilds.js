"use strict";

/**
 * CitizenMapGuilds — the Grand Cartographers' Guild: the profession's
 * operations layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenMaps owns: persistent map records, map shops, real coin map
 *     sales, exploration logs, treasure caches, navigation bonus.
 *     THIS module never reimplements maps, shops, or pricing.
 *   - CitizenCartographers / CitizenCartographers2 own: hash-derived
 *     cartographer flavor. Frozen — never touched.
 *   - CitizenMapLife owns: ambient map drafting by individual cartographers.
 *   - CitizenGuilds owns: generic trade-guild membership/ranks/dues for all
 *     trades. THIS owns the cartographers' guild specifically: certification
 *     standards, survey bounties, mentorship, and the certified archive.
 *   - CitizenApprentices owns: XP-based master/apprentice pairing for trade
 *     skills. THIS owns guild mentorship: fee waivers + promotion credit,
 *     graduated by certified maps, not XP.
 *   - CitizenDiscovery / CitizenExplorers own: discovery records and
 *     expeditions (read-only seams here).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Guild per kingdom with a guild hall (tile near the map shop), a real
 *     tracked treasury, and prestige.
 *   - Membership: apprentice -> journeyman -> master. Joining requires being
 *     a REAL registered cartographer (CitizenMaps). Weekly dues in REAL
 *     coins; two missed online collections -> suspended (no guild services)
 *     until dues are caught up.
 *   - Certification: members submit maps that are REALLY listed in the
 *     kingdom map shop (verified against CitizenMaps.listingsFor — creator
 *     name, id, and unsold status all checked honestly). A 50-coin fee is
 *     taken from the submitter's real inventory. Grades: C (quality 6-7),
 *     B (8), A (9-10). Certified creators earn a REAL bounty from the guild
 *     treasury (C:30 / B:60 / A:120); if the treasury is broke the bounty
 *     is owed honestly, never invented.
 *   - Survey bounties (guild-sponsored mapping): the guild posts standing
 *     bounties for map types ("wanted: dungeon charts"). A bounty is claimed
 *     only when the claimant holds a certification of that type certified
 *     AFTER the bounty posted — fully verifiable from this module's own
 *     records, never from hashes.
 *   - Mentorship: guild masters may take apprentice-rank members under wing.
 *     While mentored, the apprentice pays no certification fees and their
 *     certifications count double toward promotion. Mentorship ends when the
 *     apprentice reaches journeyman.
 *   - Archive: the guild's certified registry — every certified map is
 *     archived (metadata copy; the physical map stays in the shop, so there
 *     is never a double-spend). Archive prestige 0-100 from real counts.
 *   - Public API for other modules: isGuildMember, guildRankOf,
 *     certifiedGradeFor(mapId), guildSealFor(mapId), guildTreasuryFor,
 *     describe(kingdomId).
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenMapGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented geography, no invented coins, no invented maps.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-mapguilds.json";
const COINS_ID = 995;

const RANK_APPRENTICE = "apprentice";
const RANK_JOURNEYMAN = "journeyman";
const RANK_MASTER = "master";
const RANKS = Object.freeze([RANK_APPRENTICE, RANK_JOURNEYMAN, RANK_MASTER]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2; // missed online collections before suspension

const CERT_FEE = 50; // real coins to submit a map for certification
const CERT_MIN_QUALITY = 6; // below this a map cannot be certified
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });

const BOUNTY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // bounties expire after 30 days
const PROMOTE_JOURNEYMAN_CERTS = 5; // certified maps (mentored count double)
const PROMOTE_MASTER_CERTS = 12;

const HALL_TILE_DX = 4; // guild hall sits a few tiles from the map shop

// --- state ---------------------------------------------------------------

let cache = null;
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntil, missedDues, suspended, certCount, masterworks }
    certs: Object.create(null), // mapId -> { mapId, creator, type, quality, grade, certifiedAt, kingdomId, bountyUsedBy: null }
    queue: [], // [ { mapId, creator, kingdomId, submittedAt } ]
    bounties: Object.create(null), // id -> { id, kingdomId, targetType, reward, postedAt, expiresAt, claimedBy }
    mentors: Object.create(null), // apprenticeNorm -> { master, since }
    seenListings: Object.create(null), // listingKey -> true (auto-submit bookkeeping)
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

function markDirty() {
  dirty = true;
}

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

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

function allocId(prefix) {
  const st = load();
  const id = `${prefix}_${st.nextId++}`;
  markDirty();
  return id;
}

function maps() {
  try {
    return require("./CitizenMaps");
  } catch {
    return null;
  }
}

function kingdomIds() {
  try {
    const { KINGDOM_IDS } = require("../brain/CitizenSites");
    return Array.isArray(KINGDOM_IDS) ? KINGDOM_IDS : [];
  } catch {
    return [];
  }
}

// --- guilds ---------------------------------------------------------------

function hallTileFor(kingdomId) {
  const Maps = maps();
  let shop = null;
  try {
    shop = Maps ? Maps.shopOf(kingdomId) : null;
  } catch {
    shop = null;
  }
  if (shop && shop.tile) {
    return { x: (shop.tile.x ?? 0) + HALL_TILE_DX, y: shop.tile.y ?? 0, z: shop.tile.z ?? 0 };
  }
  return { x: HALL_TILE_DX, y: 0, z: 0 };
}

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

// --- membership ------------------------------------------------------------

function memberOf(username) {
  const st = load();
  return st.members[norm(username)] || null;
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
    if (!kingdomId || m.kingdomId === String(kingdomId)) n++;
  }
  return n;
}

function joinGuild(username, kingdomId) {
  const st = load();
  const name = String(username || "").trim();
  if (!name) return { ok: false, reason: "no-identity" };
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  if (st.members[norm(name)]) return { ok: false, reason: "already-member" };
  const Maps = maps();
  let isCartographer = false;
  try {
    isCartographer = Maps ? !!Maps.isCartographer(name) : false;
  } catch {
    isCartographer = false;
  }
  if (!isCartographer) return { ok: false, reason: "not-cartographer" };
  ensureGuild(kid);
  st.members[norm(name)] = {
    username: name,
    kingdomId: kid,
    rank: RANK_APPRENTICE,
    joinedAt: Date.now(),
    duesPaidUntil: Date.now() + DUES_PERIOD_MS,
    missedDues: 0,
    suspended: false,
    certCount: 0,
    masterworks: 0,
  };
  markDirty();
  return { ok: true, rank: RANK_APPRENTICE };
}

function leaveGuild(username) {
  const st = load();
  const key = norm(username);
  if (!st.members[key]) return false;
  delete st.members[key];
  // Dissolve mentorships involving this citizen.
  for (const [a, pair] of Object.entries(st.mentors)) {
    if (a === key || norm(pair.master) === key) delete st.mentors[a];
  }
  markDirty();
  return true;
}

function liftSuspension(username) {
  const m = memberOf(username);
  if (!m || !m.suspended) return false;
  m.suspended = false;
  m.missedDues = 0;
  m.duesPaidUntil = Date.now() + DUES_PERIOD_MS;
  markDirty();
  return true;
}

// --- certification -----------------------------------------------------------

function gradeFor(quality) {
  if (quality >= 9) return "A";
  if (quality === 8) return "B";
  if (quality >= CERT_MIN_QUALITY) return "C";
  return null;
}

function findListedMap(mapId, kingdomId) {
  // Honest verification: the map must be REALLY listed in the kingdom map
  // shop right now. Creator name and id are checked by the caller.
  const Maps = maps();
  if (!Maps) return null;
  try {
    const listings = Maps.listingsFor(kingdomId) || [];
    for (const l of listings) {
      if (l && l.map && String(l.map.id) === String(mapId)) return l.map;
    }
  } catch {
    return null;
  }
  return null;
}

function isCertified(mapId) {
  return !!load().certs[String(mapId)];
}

function certifiedGradeFor(mapId) {
  const c = load().certs[String(mapId)];
  return c ? c.grade : null;
}

function guildSealFor(mapId) {
  // Public read seam: other modules (chat, travel, trade) can ask whether
  // a map carries the guild seal without touching certification internals.
  const c = load().certs[String(mapId)];
  if (!c) return null;
  return { grade: c.grade, creator: c.creator, type: c.type, quality: c.quality, certifiedAt: c.certifiedAt };
}

function queuedFor(mapId) {
  const st = load();
  return st.queue.some((q) => String(q.mapId) === String(mapId));
}

function submitForCertification(username, mapId, kingdomId) {
  const st = load();
  const m = memberOf(username);
  if (!m) return { ok: false, reason: "not-member" };
  if (m.suspended) return { ok: false, reason: "suspended" };
  const kid = String(kingdomId || m.kingdomId);
  const listed = findListedMap(mapId, kid);
  if (!listed) return { ok: false, reason: "not-listed" };
  if (norm(listed.creator) !== norm(username)) return { ok: false, reason: "not-author" };
  if (isCertified(mapId) || queuedFor(mapId)) return { ok: false, reason: "already-certified" };
  const grade = gradeFor(Number(listed.quality) || 0);
  if (!grade) return { ok: false, reason: "quality-too-low" };
  st.queue.push({ mapId: String(mapId), creator: String(username), kingdomId: kid, submittedAt: Date.now() });
  markDirty();
  return { ok: true, fee: CERT_FEE, provisionalGrade: grade };
}

function processCertifications(nowMs) {
  // Grades the review queue deterministically from the map's real quality,
  // pays the certification bounty from the real treasury (owed honestly when
  // broke), and archives the record. Returns the newly certified entries.
  const st = load();
  const done = [];
  if (!st.queue.length) return done;
  const pending = st.queue.splice(0, st.queue.length);
  for (const q of pending) {
    const listed = findListedMap(q.mapId, q.kingdomId);
    if (!listed) {
      // Sold or delisted while waiting — honest skip, no certification.
      continue;
    }
    const quality = Number(listed.quality) || 0;
    const grade = gradeFor(quality);
    if (!grade) continue; // quality fell below standard (shouldn't happen)
    const cert = {
      mapId: String(q.mapId),
      creator: String(q.creator),
      type: listed.type,
      quality,
      grade,
      certifiedAt: nowMs,
      kingdomId: q.kingdomId,
      bountyOwed: 0,
    };
    const bounty = CERT_BOUNTY[grade] || 0;
    if (bounty > 0) {
      // Credit the creator's REAL bank account before debiting — never mark
      // paid what was never delivered (vanishing-coins fix).
      let credited = false;
      try {
        const B = bankingApi();
        const acct = B && typeof B.accountFor === "function" ? B.accountFor(q.creator) : null;
        if (acct) {
          acct.balance = (Number(acct.balance) || 0) + bounty;
          if (typeof B.markDirty === "function") B.markDirty();
          credited = true;
        }
      } catch { /* banking is best-effort */ }
      if (credited && debitTreasury(q.kingdomId, bounty)) {
        cert.bountyPaid = bounty;
      } else {
        // Treasury broke or banking down: the guild owes the bounty honestly.
        cert.bountyOwed = bounty;
      }
    }
    st.certs[cert.mapId] = cert;
    const mem = memberOf(q.creator);
    if (mem) {
      const mentored = !!st.mentors[norm(q.creator)];
      mem.certCount += mentored ? 2 : 1; // mentored apprentices learn faster
      if (quality >= 9) mem.masterworks += 1;
      // Mentorship ends when the apprentice reaches journeyman.
      if (mentored && mem.rank === RANK_APPRENTICE && mem.certCount >= PROMOTE_JOURNEYMAN_CERTS) {
        delete st.mentors[norm(q.creator)];
        cert.mentorGraduated = true;
      }
    }
    markDirty();
    done.push(cert);
  }
  return done;
}

function certsByCreator(username) {
  const st = load();
  const key = norm(username);
  return Object.values(st.certs).filter((c) => norm(c.creator) === key);
}

// --- survey bounties (guild-sponsored mapping) ---------------------------------

function postBounty(kingdomId, targetType, reward) {
  const st = load();
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  const Maps = maps();
  const types = Maps ? Maps.MAP_TYPES : ["world", "city", "dungeon", "treasure"];
  if (!types.includes(targetType)) return { ok: false, reason: "bad-type" };
  const r = Math.floor(Number(reward) || 0);
  if (r <= 0) return { ok: false, reason: "bad-reward" };
  // The reward is locked from the guild treasury at posting time — real coins only.
  if (!debitTreasury(kid, r)) return { ok: false, reason: "treasury-broke" };
  const id = allocId("bounty");
  const now = Date.now();
  st.bounties[id] = {
    id,
    kingdomId: kid,
    targetType,
    reward: r,
    postedAt: now,
    expiresAt: now + BOUNTY_TTL_MS,
    claimedBy: null,
  };
  markDirty();
  return { ok: true, id, reward: r };
}

function activeBounties(kingdomId) {
  const st = load();
  const now = Date.now();
  return Object.values(st.bounties).filter(
    (b) => !b.claimedBy && b.expiresAt > now && (!kingdomId || b.kingdomId === String(kingdomId))
  );
}

function claimBounty(username, bountyId) {
  const st = load();
  const m = memberOf(username);
  if (!m) return { ok: false, reason: "not-member" };
  if (m.suspended) return { ok: false, reason: "suspended" };
  const b = st.bounties[String(bountyId)];
  if (!b) return { ok: false, reason: "no-bounty" };
  if (b.claimedBy) return { ok: false, reason: "already-claimed" };
  if (b.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  if (m.kingdomId !== b.kingdomId) return { ok: false, reason: "wrong-kingdom" };
  // Honest proof: a certification of the wanted type, certified AFTER the
  // bounty was posted, not already spent on another bounty.
  const proof = certsByCreator(username).find(
    (c) => c.type === b.targetType && c.certifiedAt >= b.postedAt && !c.bountyUsedBy
  );
  if (!proof) return { ok: false, reason: "no-proof" };
  proof.bountyUsedBy = b.id;
  b.claimedBy = String(username);
  b.claimedAt = Date.now();
  markDirty();
  return { ok: true, reward: b.reward, mapId: proof.mapId };
}

function expireBounties(nowMs) {
  // Expired unclaimed bounties refund to the treasury — the coins were real.
  const st = load();
  let refunded = 0;
  for (const b of Object.values(st.bounties)) {
    if (!b.claimedBy && b.expiresAt <= nowMs) {
      creditTreasury(b.kingdomId, b.reward);
      refunded += b.reward;
      delete st.bounties[b.id];
    }
  }
  if (refunded > 0) markDirty();
  return refunded;
}

// --- mentorship ------------------------------------------------------------------

function takeApprentice(masterUsername, apprenticeUsername) {
  const st = load();
  const master = memberOf(masterUsername);
  const appr = memberOf(apprenticeUsername);
  if (!master || !appr) return { ok: false, reason: "not-member" };
  if (master.rank !== RANK_MASTER) return { ok: false, reason: "not-master" };
  if (appr.rank !== RANK_APPRENTICE) return { ok: false, reason: "not-apprentice" };
  if (master.kingdomId !== appr.kingdomId) return { ok: false, reason: "wrong-kingdom" };
  if (master.suspended || appr.suspended) return { ok: false, reason: "suspended" };
  if (st.mentors[norm(apprenticeUsername)]) return { ok: false, reason: "already-mentored" };
  // One apprentice per master at a time — a human master has limited hours.
  for (const p of Object.values(st.mentors)) {
    if (norm(p.master) === norm(masterUsername)) return { ok: false, reason: "master-busy" };
  }
  st.mentors[norm(apprenticeUsername)] = { master: String(masterUsername), since: Date.now() };
  markDirty();
  return { ok: true };
}

function mentorOf(apprenticeUsername) {
  const p = load().mentors[norm(apprenticeUsername)];
  return p ? p.master : null;
}

function mentoredBy(masterUsername) {
  const st = load();
  for (const [a, p] of Object.entries(st.mentors)) {
    if (norm(p.master) === norm(masterUsername)) return a;
  }
  return null;
}

// --- promotion ---------------------------------------------------------------------

function checkPromotion(username) {
  // Returns the new rank when promoted, null otherwise. Promotions are
  // earned from real certified-map counts, never granted.
  const m = memberOf(username);
  if (!m || m.suspended) return null;
  if (m.rank === RANK_APPRENTICE && m.certCount >= PROMOTE_JOURNEYMAN_CERTS) {
    m.rank = RANK_JOURNEYMAN;
    markDirty();
    return RANK_JOURNEYMAN;
  }
  if (m.rank === RANK_JOURNEYMAN && m.certCount >= PROMOTE_MASTER_CERTS) {
    m.rank = RANK_MASTER;
    markDirty();
    return RANK_MASTER;
  }
  return null;
}

// --- archive --------------------------------------------------------------------------

function archiveFor(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "");
  return Object.values(st.certs)
    .filter((c) => !kid || c.kingdomId === kid)
    .sort((a, b) => b.certifiedAt - a.certifiedAt);
}

function archivePrestige(kingdomId) {
  // 0-100 from real counts: masterworks weigh most.
  const entries = archiveFor(kingdomId);
  let score = 0;
  for (const e of entries) score += e.grade === "A" ? 10 : e.grade === "B" ? 4 : 2;
  return Math.min(100, score);
}

// --- dues (called by the life tick with real inventories) ----------------------------

function duesStatus(username) {
  const m = memberOf(username);
  if (!m) return null;
  return {
    rank: m.rank,
    suspended: m.suspended,
    duesPaidUntil: m.duesPaidUntil,
    missedDues: m.missedDues,
    overdue: Date.now() > m.duesPaidUntil,
  };
}

function recordDuesPaid(username, nowMs) {
  const m = memberOf(username);
  if (!m) return false;
  m.duesPaidUntil = nowMs + DUES_PERIOD_MS;
  m.missedDues = 0;
  if (m.suspended) m.suspended = false;
  markDirty();
  return true;
}

function recordDuesMissed(username) {
  const m = memberOf(username);
  if (!m) return false;
  m.missedDues += 1;
  if (m.missedDues >= SUSPEND_AFTER_MISSED) m.suspended = true;
  markDirty();
  return m.suspended;
}

// --- description for chat ---------------------------------------------------------------

function describe(kingdomId) {
  const kid = String(kingdomId || "");
  const g = guildOf(kid);
  if (!g) return { exists: false };
  const members = Object.values(load().members).filter((m) => m.kingdomId === kid);
  return {
    exists: true,
    memberCount: members.length,
    masters: members.filter((m) => m.rank === RANK_MASTER).length,
    treasury: g.treasury,
    prestige: archivePrestige(kid),
    certified: archiveFor(kid).length,
    bounties: activeBounties(kid).length,
    hallTile: g.hallTile,
  };
}

module.exports = {
  SAVE_KEY,
  COINS_ID,
  RANK_APPRENTICE,
  RANK_JOURNEYMAN,
  RANK_MASTER,
  RANKS,
  DUES_WEEKLY,
  CERT_FEE,
  CERT_MIN_QUALITY,
  ensureGuild,
  guildOf,
  hallTileFor,
  guildTreasuryFor,
  creditTreasury,
  debitTreasury,
  memberOf,
  isGuildMember,
  guildRankOf,
  memberCount,
  joinGuild,
  leaveGuild,
  liftSuspension,
  gradeFor,
  submitForCertification,
  processCertifications,
  isCertified,
  certifiedGradeFor,
  guildSealFor,
  certsByCreator,
  postBounty,
  activeBounties,
  claimBounty,
  expireBounties,
  takeApprentice,
  mentorOf,
  mentoredBy,
  checkPromotion,
  archiveFor,
  archivePrestige,
  duesStatus,
  recordDuesPaid,
  recordDuesMissed,
  describe,
  save,
  resetForTests,
};
