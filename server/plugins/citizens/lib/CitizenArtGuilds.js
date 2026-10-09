"use strict";

/**
 * CitizenArtGuilds — the Artists' Guild: the art profession's operations
 * layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenArt owns: art mediums, artwork creation (real materials),
 *     gallery DISPLAY spaces, the fixed-price art market, exhibitions,
 *     valuations (valueFor), and masterpiece detection (isMasterpiece).
 *     Never reimplemented — READ only.
 *   - CitizenGalleries owns: the curator profession registry, competitive
 *     AUCTIONS, gallery ACQUISITIONS, COMMISSIONS (patron escrow for bespoke
 *     works), APPRAISALS, traveling exhibitions, and gallery PRESTIGE.
 *     Never reimplemented — READ only.
 *   - CitizenArtisans owns: master craftspeople in five trades (blacksmith,
 *     jeweler, carpenter, tailor, alchemist) — a different profession.
 *     Never reimplemented — READ only.
 *   - CitizenArtGuild (brain) owns: artists walking to the guild hall and
 *     holding sessions in human-paced rounds. THIS module owns the
 *     profession's guild layer only.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - One Artists' Guild per kingdom with a hall tile near the gallery, a
 *     real tracked treasury, a real tracked patron fund, and prestige.
 *   - Membership: apprentice -> artist -> master. Joining requires being a
 *     REAL artist: the `artist` career (CitizenCareers.careerOf), OR real
 *     created artworks (CitizenArt.artworksOf). The guild polices the
 *     trade, never mints artists. Weekly dues in REAL coins; two missed
 *     online collections -> suspended until caught up. Offline members are
 *     never penalized.
 *   - Masterpiece certification: members submit artworks they REALLY
 *     created (verified against the CitizenArt ledger — artwork exists and
 *     its recorded artist is the claimant). A 50-coin real fee (mentored
 *     apprentices certify free). Grades from the REAL artwork quality:
 *     >=85=A (masterpiece-grade), >=60=B, else C. The guild pays a REAL
 *     bounty from its treasury (C:30 / B:60 / A:120); the patron fund backs
 *     bounties when the treasury runs dry; when both are broke the bounty
 *     is owed honestly, never invented. The bounty is DELIVERED: to the
 *     author's inventory on the player path, to their bank account by the
 *     life-tick retry when owed. A failed delivery is re-recorded as owed,
 *     never claimed as paid.
 *   - Forgery tribunal: the one verifiable art crime — a forged artwork:
 *     a certified artwork whose normalized title duplicates an EARLIER
 *     certified artwork (by certifiedMs) by a DIFFERENT artist.
 *     Members/players report; artist-rank members vote; 24h auto-settle.
 *     Guilty -> expulsion + `forger` deed.
 *   - Studio inspections: the guild's atelier score per kingdom is computed
 *     from REAL data — every guild member's real artwork output
 *     (CitizenArt.artworksOf). Members with no real artworks lower the
 *     score. Scores below 40 trigger a public atelier-audit announcement.
 *   - Golden palette: quarterly, the guild member with the most REAL
 *     certified artworks in the kingdom wins a 200-coin real prize (owed
 *     honestly when broke) and a public announcement.
 *   - Patronage board: sponsors post real-coin bounties for certified works
 *     in a medium; claims are verified against the guild's own certification
 *     ledger (certified after the bounty posted, medium matches, claimant is
 *     a member in good standing). The bounty goes to the artist's real bank
 *     account (honest offline credit) — this is guild patronage, not the
 *     galleries' escrow commissions.
 *   - Art school: master artists teach apprentices (training credits).
 *     Promotion: apprentice -> artist (30d tenure + 2 credits + a real
 *     certified artwork), artist -> master (60d tenure + 4 credits + 2
 *     conducted certifications + clean record). All verifiable from real
 *     records — never invented.
 *   - Mentorship: master artists take apprentice members under wing. While
 *     mentored, the apprentice pays no certification fees and their
 *     certifications count double toward promotion. Mentorship ends after
 *     the first certification.
 *   - Certified archive: the guild's certified registry — metadata copies of
 *     every certified artwork (the artwork stays in the CitizenArt ledger;
 *     never a double-spend). Prestige 0-100 from real counts.
 *   - Public API: isGuildMember, guildRankOf, memberOf, memberNames,
 *     sealFor, gradeFor, guildTreasuryFor, inspectionFor, describe.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here — see lib/CitizenArtGuildLife.js.
 *   - No LLM. Announcements are journaled; the chat layer riffs.
 *   - No invented artists, artworks, inspections, coins, or bounties.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-artguilds.json";
const COINS_ID = 995;

const RANK_APPRENTICE = "apprentice";
const RANK_ARTIST = "artist";
const RANK_MASTER = "master";
const RANKS = Object.freeze([RANK_APPRENTICE, RANK_ARTIST, RANK_MASTER]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_PATRON_SHARE = 5; // of each dues payment feeds the patron fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2;

const CERT_FEE = 50; // real coins to certify an artwork
const CERT_BOUNTY = Object.freeze({ C: 30, B: 60, A: 120 });
const GRADE_A_QUALITY = 85; // masterpiece-grade (matches CitizenArt)
const GRADE_B_QUALITY = 60;

const PALETTE_PERIOD_MS = 90 * 24 * 60 * 60 * 1000; // quarterly golden palette
const PALETTE_PRIZE = 200; // real coins from the treasury

const CASE_TTL_MS = 24 * 60 * 60 * 1000; // tribunal cases auto-settle after 24h
const VOTES_FOR_QUORUM = 2;

const HALL_TILE_DX = 5; // guild hall sits a few tiles from the gallery
const HALL_TILE_DY = -4;

const INSPECTION_AUDIT_THRESHOLD = 40; // below this the guild announces an audit

const PROMOTE_ARTIST = Object.freeze({ tenureMs: 30 * 24 * 3600 * 1000, credits: 2 });
const PROMOTE_MASTER = Object.freeze({ tenureMs: 60 * 24 * 3600 * 1000, credits: 4, certifications: 2 });

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
    mentorships: {}, // lower(apprentice) -> { master, sinceMs }
    bounties: {}, // bountyId -> patronage bounty
    nextCertId: 1,
    nextCaseId: 1,
    nextBountyId: 1,
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

function artApi() {
  try { return require("./CitizenArt"); } catch { return null; }
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

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

// === Guild management ===

function ensureGuild(kingdomId) {
  const st = load();
  if (!st.guilds[kingdomId]) {
    let hallTile = null;
    try {
      const S = sitesApi();
      const Art = artApi();
      let base = null;
      if (Art && Art.galleryFor) {
        const gallery = Art.galleryFor(kingdomId);
        if (gallery && gallery.tile) base = gallery.tile;
      }
      if (!base && S && S.siteTileByKingdom) {
        base = S.siteTileByKingdom(kingdomId, "market") ?? null;
      }
      if (base) {
        hallTile = { x: base.x + HALL_TILE_DX, y: base.y + HALL_TILE_DY, z: base.z || 0 };
      }
    } catch { /* no hall tile */ }
    st.guilds[kingdomId] = {
      kingdomId,
      hallTile,
      treasury: 0,
      patronFund: 0,
      prestige: 0,
      foundedMs: Date.now(),
      lastPaletteMs: 0,
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

function isRealArtist(username) {
  // The guild polices the trade — it never mints artists. Two verifiable
  // paths: the `artist` career, or real created artworks in the art ledger.
  try {
    const C = careersApi();
    if (C && C.careerOf && C.careerOf(username) === "artist") return true;
  } catch { /* fall through */ }
  try {
    const Art = artApi();
    if (Art && Art.artworksOf && (Art.artworksOf(username) || []).length > 0) return true;
  } catch { /* fall through */ }
  return false;
}

function joinGuild(username, kingdomId) {
  const st = load();
  const key = normalizeName(username);
  if (st.members[key]) return { ok: false, reason: "already-member" };
  if (!isRealArtist(username)) return { ok: false, reason: "not-an-artist" };
  ensureGuild(kingdomId);
  const now = Date.now();
  st.members[key] = {
    username,
    kingdomId,
    rank: RANK_APPRENTICE,
    joinedMs: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS, // first week free
    missedDues: 0,
    suspended: false,
    trainingCredits: 0,
    certificationsConducted: 0,
    cleanRecord: true,
  };
  touch();
  return { ok: true, rank: RANK_APPRENTICE };
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
  g.treasury += (DUES_WEEKLY - DUES_PATRON_SHARE);
  g.patronFund += DUES_PATRON_SHARE;
  // Never discard banked coverage: a payment made while still covered extends
  // from the later of the existing coverage or now (canonical guild behavior).
  m.duesPaidUntilMs = Math.max(m.duesPaidUntilMs || 0, nowMs) + DUES_PERIOD_MS;
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

// === Masterpiece certification ===

function normalizeTitle(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function certifyArtwork(kingdomId, username, artworkId) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return { ok: false, reason: "not-a-member" };
  if (m.suspended) return { ok: false, reason: "suspended" };
  const g = ensureGuild(kingdomId);

  // Verify the artwork is REAL: it exists in the CitizenArt ledger and its
  // recorded artist is the claimant. We read the art ledger defensively —
  // never invent.
  let artwork = null;
  try {
    const Art = artApi();
    if (Art && Art.artworkById) artwork = Art.artworkById(artworkId);
  } catch { /* no artwork */ }
  if (!artwork) return { ok: false, reason: "no-such-artwork" };
  if (normalizeName(artwork.artist) !== key) return { ok: false, reason: "not-the-artist" };
  const quality = Number(artwork.quality);
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
    return { ok: false, reason: "no-quality" };
  }
  // No double-certification of the same artwork by the same artist.
  const dup = Object.values(st.certifications).some(
    (c) => normalizeName(c.artist) === key && c.artworkId === artworkId
  );
  if (dup) return { ok: false, reason: "already-certified" };

  // Mentored apprentices certify free; everyone else pays the real fee.
  const mentored = st.mentorships[key];
  const fee = mentored ? 0 : CERT_FEE;

  const grade = quality >= GRADE_A_QUALITY ? "A" : quality >= GRADE_B_QUALITY ? "B" : "C";
  const certId = `cert-${st.nextCertId++}`;
  const now = Date.now();
  st.certifications[certId] = {
    id: certId,
    kingdomId,
    artist: username,
    artworkId,
    title: String(artwork.title || "untitled artwork"),
    medium: String(artwork.medium || "unknown"),
    quality,
    grade,
    feePaid: fee,
    bountyPaid: 0,
    bountyOwed: 0,
    certifiedMs: now,
  };

  // Pay the bounty from the treasury; the patron fund backs it; when
  // both are broke the bounty is owed honestly, never invented.
  // NOTE: this only deducts the bounty from the guild's reserves — the
  // actual delivery happens in the Events layer (player inventory) or the
  // life-tick retry (author's bank account). The per-pool split is returned
  // so a failed delivery can be parked back exactly, never invented.
  const bounty = CERT_BOUNTY[grade];
  const beforeTreasury = g.treasury;
  const beforeFund = g.patronFund;
  let paid = 0;
  let owed = 0;
  if (g.treasury >= bounty) {
    g.treasury -= bounty;
    paid = bounty;
  } else if (g.treasury + g.patronFund >= bounty) {
    const fromTreasury = g.treasury;
    const fromFund = bounty - fromTreasury;
    g.treasury = 0;
    g.patronFund -= fromFund;
    paid = bounty;
  } else {
    paid = g.treasury + g.patronFund;
    owed = bounty - paid;
    g.treasury = 0;
    g.patronFund = 0;
  }
  st.certifications[certId].bountyPaid = paid;
  st.certifications[certId].bountyOwed = owed;

  // Mentorship ends after the first certification; the certification counts
  // double toward promotion while mentored.
  if (mentored) {
    delete st.mentorships[key];
    m.certificationsConducted = (m.certificationsConducted || 0) + 2;
  } else {
    m.certificationsConducted = (m.certificationsConducted || 0) + 1;
  }

  // Update prestige from real counts.
  updatePrestige(kingdomId);
  touch();
  return {
    ok: true, certId, grade, fee, bountyPaid: paid, bountyOwed: owed,
    bountyPaidFromTreasury: beforeTreasury - g.treasury,
    bountyPaidFromFund: beforeFund - g.patronFund,
  };
}

function refundCertBounty(certId, amount, fromTreasury, fromFund) {
  // Park a deducted-but-never-delivered bounty back in the guild's
  // reserves and re-record it as owed. Used when the player-facing coin
  // credit failed: the treasury was already deducted, so without this the
  // coins would vanish while the record claims they were paid. Restores
  // the exact per-pool split; never invents or destroys coins.
  const st = load();
  const cert = st.certifications[certId];
  if (!cert) return { ok: false, reason: "no-such-certification" };
  amount = Math.floor(Number(amount) || 0);
  if (!(amount > 0) || cert.bountyPaid < amount) return { ok: false, reason: "bad-amount" };
  const g = ensureGuild(cert.kingdomId);
  let t = Math.max(0, Math.floor(Number(fromTreasury) || 0));
  let f = Math.max(0, Math.floor(Number(fromFund) || 0));
  if (t + f > amount) { t = amount; f = 0; } // clamp: never restore more than deducted
  g.treasury += t + Math.max(0, amount - t - f); // any un-split remainder back to treasury
  g.patronFund += f;
  cert.bountyPaid -= amount;
  cert.bountyOwed += amount;
  touch();
  return { ok: true, refunded: amount, bountyPaid: cert.bountyPaid, bountyOwed: cert.bountyOwed };
}

function sealFor(certId) {
  const st = load();
  return st.certifications[certId] || null;
}

function gradeFor(username) {
  const st = load();
  const key = normalizeName(username);
  const certs = Object.values(st.certifications).filter((c) => normalizeName(c.artist) === key);
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
    const available = g.treasury + g.patronFund;
    if (available <= 0) break;
    const pay = Math.min(cert.bountyOwed, available);
    // Drain treasury first, then the fund.
    const fromTreasury = Math.min(pay, g.treasury);
    const fromFund = pay - fromTreasury;
    g.treasury -= fromTreasury;
    g.patronFund -= fromFund;
    // Credit the author's REAL bank account (honest offline delivery —
    // same pattern as the librarian payBounty fix). If banking is
    // unreachable, restore the reserves and keep the bounty owed: never
    // mark paid what was never delivered, never invent coins.
    let credited = false;
    try {
      const B = bankingApi();
      const acct = B && typeof B.accountFor === "function" ? B.accountFor(cert.artist) : null;
      if (acct) {
        acct.balance = (Number(acct.balance) || 0) + pay;
        if (typeof B.markDirty === "function") B.markDirty();
        credited = true;
      }
    } catch { /* banking is best-effort */ }
    if (!credited) {
      g.treasury += fromTreasury;
      g.patronFund += fromFund;
      break; // banking is down globally; a later tick retries
    }
    cert.bountyOwed -= pay;
    cert.bountyPaid += pay;
    paid += pay;
    touch();
  }
  return { ok: true, paid };
}

// === Forgery tribunal ===

function scanForgery(title) {
  // The one verifiable art crime: a forged artwork — a certified artwork
  // whose normalized title duplicates an EARLIER certified artwork (by
  // certifiedMs) by a DIFFERENT artist.
  const st = load();
  const norm = normalizeTitle(title);
  if (!norm) return null;
  const matches = Object.values(st.certifications)
    .filter((c) => normalizeTitle(c.title) === norm)
    .sort((a, b) => a.certifiedMs - b.certifiedMs);
  if (matches.length < 2) return null;
  const original = matches[0];
  const latest = matches[matches.length - 1];
  if (normalizeName(original.artist) === normalizeName(latest.artist)) return null;
  return { original, accused: latest };
}

function reportForgery(kingdomId, reporter, title) {
  const st = load();
  const found = scanForgery(title);
  if (!found) return { ok: false, reason: "no-forgery-found" };
  // No double jeopardy: one case per accused certification.
  const existing = Object.values(st.cases).find(
    (c) => c.accusedCertId === found.accused.id && c.status !== "dismissed"
  );
  if (existing) return { ok: false, reason: "case-exists", caseId: existing.id };
  const caseId = `case-${st.nextCaseId++}`;
  st.cases[caseId] = {
    id: caseId,
    kingdomId,
    kind: "forgery",
    reporter,
    accused: found.accused.artist,
    accusedCertId: found.accused.id,
    originalArtist: found.original.artist,
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
  // Only artist-rank+ members in good standing may vote.
  const m = memberOf(voter);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  if (m.rank === RANK_APPRENTICE) return { ok: false, reason: "rank-too-low" };
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
      // Expel the forger and mark the deed.
      const key = normalizeName(c.accused);
      if (st.members[key]) {
        st.members[key].cleanRecord = false;
        delete st.members[key];
      }
      try {
        const R = reputationApi();
        if (R && R.awardDeed) R.awardDeed(c.accused, "forger");
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

// === Studio inspections ===

function inspectionFor(kingdomId) {
  // The guild's atelier score: computed from REAL data — every guild
  // member's real artwork output. Members with no real artworks lower
  // the score.
  const st = load();
  const names = memberNames(kingdomId);
  if (!names.length) return { score: 100, members: 0, withWorks: 0, idle: 0 };
  let withWorks = 0;
  try {
    const Art = artApi();
    for (const n of names) {
      try {
        if (Art && Art.artworksOf && (Art.artworksOf(n) || []).length > 0) withWorks++;
      } catch { /* no artworks */ }
    }
  } catch { /* no art */ }
  const score = Math.round((withWorks / names.length) * 100);
  return { score, members: names.length, withWorks, idle: names.length - withWorks };
}

// === Golden palette ===

function grantGoldenPalette(kingdomId, nowMs) {
  const st = load();
  const g = ensureGuild(kingdomId);
  if (nowMs - (g.lastPaletteMs || 0) < PALETTE_PERIOD_MS) {
    return { ok: false, reason: "too-soon" };
  }
  // The member with the most REAL certified artworks in the kingdom.
  const counts = {};
  for (const cert of Object.values(st.certifications)) {
    if (cert.kingdomId !== kingdomId) continue;
    const key = normalizeName(cert.artist);
    const m = st.members[key];
    if (!m || m.suspended) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { ok: false, reason: "no-candidates" };
  const [winnerKey, count] = entries[0];
  const winner = st.members[winnerKey].username;

  // 200-coin real prize; owed honestly when the treasury is broke.
  // The prize is credited to the winner's REAL bank account — deducting
  // from the treasury without delivering is the vanishing-coins bug.
  let paid = 0;
  let owed = 0;
  const prize = Math.min(g.treasury, PALETTE_PRIZE);
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
  owed = PALETTE_PRIZE - paid;
  // Honest owing: record the shortfall so a later tick retries delivery.
  if (owed > 0) {
    st.paletteOwed = st.paletteOwed || {};
    st.paletteOwed[kingdomId] = (st.paletteOwed[kingdomId] || 0) + owed;
  }
  g.lastPaletteMs = nowMs;
  try {
    const R = reputationApi();
    if (R && R.awardDeed) R.awardDeed(winner, "goldenpalette");
  } catch { /* deed is best-effort */ }
  touch();
  return { ok: true, winner, artworks: count, prizePaid: paid, prizeOwed: owed };
}

// === Patronage board ===

function postBounty(kingdomId, sponsor, medium, amount) {
  const st = load();
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount < 100) return { ok: false, reason: "min-bounty-100" };
  medium = String(medium || "").toLowerCase();
  if (!["painting", "sculpture", "writing"].includes(medium)) {
    return { ok: false, reason: "bad-medium" };
  }
  ensureGuild(kingdomId);
  const bountyId = `bounty-${st.nextBountyId++}`;
  st.bounties[bountyId] = {
    id: bountyId,
    kingdomId,
    sponsor,
    medium,
    amount,
    status: "open",
    postedMs: Date.now(),
    claimedBy: null,
    claimedCertId: null,
  };
  touch();
  return { ok: true, bountyId };
}

function claimBounty(bountyId, username, certId) {
  const st = load();
  const b = st.bounties[bountyId];
  if (!b) return { ok: false, reason: "no-such-bounty" };
  if (b.status !== "open") return { ok: false, reason: "already-claimed" };
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  // Verify the claim against the guild's OWN certification ledger: the
  // certification must exist, belong to the claimant, be in the bounty's
  // medium, and be certified AFTER the bounty was posted.
  const cert = st.certifications[certId];
  if (!cert) return { ok: false, reason: "no-such-certification" };
  if (normalizeName(cert.artist) !== key) return { ok: false, reason: "not-your-work" };
  if (String(cert.medium).toLowerCase() !== b.medium) return { ok: false, reason: "wrong-medium" };
  if (cert.certifiedMs < b.postedMs) return { ok: false, reason: "predates-bounty" };
  b.status = "claimed";
  b.claimedBy = username;
  b.claimedCertId = certId;
  touch();
  return { ok: true, amount: b.amount };
}

function payBounty(bountyId) {
  // Pay the bounty from the guild treasury (sponsors funded it at post
  // time) into the claimant's REAL bank account (honest offline credit).
  // If the treasury ran dry, the remainder is owed honestly.
  const st = load();
  const b = st.bounties[bountyId];
  if (!b) return { ok: false, reason: "no-such-bounty" };
  if (b.status !== "claimed") return { ok: false, reason: "not-claimed" };
  if (b.paid) return { ok: false, reason: "already-paid" };
  const g = ensureGuild(b.kingdomId);
  const pay = Math.min(b.amount, g.treasury);
  const owed = b.amount - pay;
  g.treasury -= pay;
  if (pay > 0) {
    // CitizenBanking exposes accountFor, not creditAccount — credit the
    // live account record directly (same pattern as CitizenLibrarianGuilds
    // payBounty). If banking is unreachable, restore the treasury and keep
    // the bounty owed: never mark paid what was never delivered.
    let credited = false;
    try {
      const B = bankingApi();
      const acct = B && typeof B.accountFor === "function" ? B.accountFor(b.claimedBy) : null;
      if (acct) {
        acct.balance = (Number(acct.balance) || 0) + pay;
        if (typeof B.markDirty === "function") B.markDirty();
        credited = true;
      }
    } catch { /* banking is best-effort */ }
    if (!credited) {
      g.treasury += pay;
      b.paid = false;
      b.paidAmount = 0;
      b.owedAmount = b.amount;
      touch();
      return { ok: false, reason: "banking-unreachable", amount: 0, owed: b.amount, to: b.claimedBy };
    }
  }
  b.paid = true;
  b.paidAmount = pay;
  b.owedAmount = owed;
  touch();
  return { ok: true, amount: pay, owed, to: b.claimedBy };
}

// === Art school & mentorship ===

function holdClass(kingdomId, master) {
  const st = load();
  const mKey = normalizeName(master);
  const m = st.members[mKey];
  if (!m || m.rank !== RANK_MASTER || m.suspended) {
    return { ok: false, reason: "not-a-master" };
  }
  let taught = 0;
  for (const n of memberNames(kingdomId)) {
    const nm = st.members[normalizeName(n)];
    if (nm && nm.rank === RANK_APPRENTICE && !nm.suspended) {
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
  if (m.rank === RANK_APPRENTICE) {
    // Apprentice -> artist: 30d tenure + 2 credits + a real certified artwork.
    const hasCert = Object.values(st.certifications).some(
      (c) => normalizeName(c.artist) === key
    );
    if (tenure < PROMOTE_ARTIST.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_ARTIST.credits) return { ok: false, reason: "credits" };
    if (!hasCert) return { ok: false, reason: "no-certification" };
    if (!m.cleanRecord) return { ok: false, reason: "record" };
    m.rank = RANK_ARTIST;
    touch();
    return { ok: true, rank: RANK_ARTIST };
  }
  if (m.rank === RANK_ARTIST) {
    // Artist -> master: 60d tenure + 4 credits + 2 conducted certifications.
    if (tenure < PROMOTE_MASTER.tenureMs) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_MASTER.credits) return { ok: false, reason: "credits" };
    if ((m.certificationsConducted || 0) < PROMOTE_MASTER.certifications) {
      return { ok: false, reason: "certifications" };
    }
    if (!m.cleanRecord) return { ok: false, reason: "record" };
    m.rank = RANK_MASTER;
    try {
      const R = reputationApi();
      if (R && R.awardDeed) R.awardDeed(m.username, "artmaster");
    } catch { /* deed is best-effort */ }
    touch();
    return { ok: true, rank: RANK_MASTER };
  }
  return { ok: false, reason: "max-rank" };
}

function takeApprentice(master, apprentice) {
  const st = load();
  const mKey = normalizeName(master);
  const nKey = normalizeName(apprentice);
  const m = st.members[mKey];
  const n = st.members[nKey];
  if (!m || m.rank !== RANK_MASTER || m.suspended) {
    return { ok: false, reason: "not-a-master" };
  }
  if (!n || n.rank !== RANK_APPRENTICE || n.suspended) {
    return { ok: false, reason: "not-an-apprentice" };
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
  return g ? { treasury: g.treasury, patronFund: g.patronFund } : null;
}

function contributeToFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  g.patronFund += amount;
  touch();
  return { ok: true, fund: g.patronFund };
}

/** Credit sponsor coins to the treasury (patronage bounties are guild-held). */
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
  const insp = inspectionFor(kingdomId);
  return {
    exists: true,
    kingdomId,
    memberCount: names.length,
    certified: certCount,
    atelier: insp.score,
    treasury: g.treasury,
    patronFund: g.patronFund,
    prestige: g.prestige,
    hallTile: g.hallTile,
  };
}

module.exports = {
  // tuning
  SAVE_KEY,
  COINS_ID,
  RANK_APPRENTICE,
  RANK_ARTIST,
  RANK_MASTER,
  RANKS,
  DUES_WEEKLY,
  CERT_FEE,
  CERT_BOUNTY,
  PALETTE_PRIZE,
  // guilds
  ensureGuild,
  guildOf,
  // membership
  isRealArtist,
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
  certifyArtwork,
  refundCertBounty,
  sealFor,
  gradeFor,
  retryOwedBounties,
  // tribunal
  scanForgery,
  reportForgery,
  voteOnCase,
  settleRipeCases,
  // inspections
  inspectionFor,
  // golden palette
  grantGoldenPalette,
  // patronage
  postBounty,
  claimBounty,
  payBounty,
  // school & mentorship
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
