"use strict";

/**
 * CitizenTheater — the REAL theater production layer: playwrights, plays,
 * theater venues, touring troupes, ticketed performances, and reviews.
 *
 * No-overlap boundary:
 *   - CitizenActors owns the scripted performance SCENES at theaters
 *     (hash-derived daily schedules, monologue forceChat, tips). This owns
 *     the production ECONOMICS around them — never the scenes.
 *   - CitizenEntertainment owns the Varrock house theater venue record,
 *     the 10-coin house ticket, drinks/dice/bards/arena. This owns
 *     per-kingdom theater venues (ownership, capacity, upkeep) and
 *     troupe-booked performances with their own ticketing.
 *   - CitizenFestivals owns festival events; troupes may tour TO festivals
 *     but never run them.
 *
 * How it works:
 *   - Playwrights write real persistent plays (title/author/genre/quality),
 *     each draft consuming 1 real papyrus (item 970). Titles are template
 *     frames filled ONLY from real data (playwright name, genre, kingdom).
 *     Quality 1-10 comes from the playwright's real engagement (plays
 *     written + performances of their plays) — never random.
 *   - Theaters: one venue per kingdom with real capacity, condition, owner
 *     (a troupe name or "crown"), and weekly upkeep paid from the owner's
 *     real funds. Poor condition caps attendance.
 *   - Troupes: named companies with real member rosters and treasuries.
 *     Troupes book theaters, set ticket prices, and tour other kingdoms
 *     (travel takes real time; touring troupes perform abroad).
 *   - Performances: scheduled shows sell REAL tickets to REAL citizen
 *     inventories. Revenue splits 60% troupe / 25% venue owner / 15%
 *     playwright royalty — all real coin movement, honest failure when
 *     the buyer is broke.
 *   - Reviews: deterministic reception from quality + attendance. Great
 *     shows earn fame deeds; plays reflect kingdom values through the
 *     culture seam (prideDeltaFor) — history/epic plays performed at home
 *     raise kingdom pride; satire abroad is noticed.
 *
 * Zero LLM. Tick-safe: every engine read guarded. Plain-node testable.
 */

const fs = require("fs");
const path = require("path");
const { agentRng } = require("./humanizer");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-theater.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
  nextPlayId = 1;
  nextPerfId = 1;
}

// === Tuning: all magic numbers here ===
const COINS_ID = 995;
const PAPYRUS_ID = 970;
const DEFAULT_TICKET_PRICE = 25; // coins — premium over the 10-coin house show
const MIN_TICKET_PRICE = 5;
const MAX_TICKET_PRICE = 200;
const TROUPE_SHARE_BPS = 6000; // 60% to the troupe treasury
const VENUE_SHARE_BPS = 2500; // 25% to the venue owner
const ROYALTY_SHARE_BPS = 1500; // 15% playwright royalty
const THEATER_UPKEEP_WEEKLY = 200; // coins, paid by the venue owner
const CONDITION_DECAY_WEEKLY = 4; // condition lost per week without upkeep
const RENOVATE_COST_PER_POINT = 15; // coins per condition point restored
const TOUR_TRAVEL_MS = 2 * 60 * 60 * 1000; // 2h to reach the next kingdom
const PERF_DURATION_MS = 90 * 60 * 1000; // a show runs ~90 minutes
const BOOKING_LEAD_MS = 30 * 60 * 1000; // bookings need 30 min lead
const PRIDE_WINDOW_MS = 7 * 24 * 3600 * 1000; // culture seam looks back 7 days
const TROUPE_NAME_SUFFIXES = Object.freeze(["Players", "Company", "Troupe", "Stage"]);

const GENRES = Object.freeze({
  tragedy: Object.freeze({ label: "tragedy", mood: "somber" }),
  comedy: Object.freeze({ label: "comedy", mood: "merry" }),
  history: Object.freeze({ label: "history", mood: "proud" }),
  satire: Object.freeze({ label: "satire", mood: "sharp" }),
  epic: Object.freeze({ label: "epic", mood: "grand" }),
  romance: Object.freeze({ label: "romance", mood: "tender" }),
});
const GENRE_KEYS = Object.freeze(Object.keys(GENRES));

// Play title frames — filled ONLY from real data (playwright, genre, kingdom).
const TITLE_FRAMES = Object.freeze([
  "{playwright}'s {genreCap} of {kingdom}",
  "The {kingdom} {genreCap}",
  "{genreCap} at {kingdom}",
  "The {playwright} {genreCap}",
  "A {kingdom} {genreCap} in Three Acts",
  "{playwright}'s New {genreCap}",
]);

// === State ===
let cache = null;
let dirty = false;
let nextPlayId = 1;
let nextPerfId = 1;

function blankState() {
  return {
    theaters: {}, // kingdomId -> theater
    plays: {}, // playId -> play
    playwrights: {}, // usernameLower -> { username, kingdomId, playsWritten, registeredAt }
    troupes: {}, // troupeNameLower -> troupe
    performances: {}, // perfId -> performance
    reviews: [], // recent reviews (capped)
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const data = JSON.parse(raw);
    cache = Object.assign(blankState(), data);
    // re-seed id counters from existing records
    for (const id of Object.keys(cache.plays)) {
      const n = parseInt(String(id).split("-")[1], 10);
      if (n >= nextPlayId) nextPlayId = n + 1;
    }
    for (const id of Object.keys(cache.performances)) {
      const n = parseInt(String(id).split("-")[1], 10);
      if (n >= nextPerfId) nextPerfId = n + 1;
    }
  } catch {
    cache = blankState();
  }
  return cache;
}

function markDirty() {
  dirty = true;
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

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function cap(s) {
  const t = String(s || "");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

// --- tiles ------------------------------------------------------------------

/** Theater tile: deterministic, near the market (own offset so venues don't stack). */
function theaterTileFor(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const m = siteTileByKingdom(String(kingdomId), "market");
    if (m) return { x: (m.x || 0) - 24, y: (m.y || 0) + 24, z: m.z || 0 };
  } catch { /* fall through */ }
  return { x: 3200, y: 3200, z: 0 };
}

// --- theaters ----------------------------------------------------------------

function ensureTheater(kingdomId) {
  const st = load();
  const kid = norm(kingdomId);
  if (!kid) return null;
  if (!st.theaters[kid]) {
    const rng = agentRng(`theater:${kid}`);
    st.theaters[kid] = {
      kingdomId: kid,
      name: `The ${cap(kid)} Playhouse`,
      tile: theaterTileFor(kid),
      capacity: 60 + Math.floor(rng() * 81), // 60..140 seats
      condition: 100,
      owner: "crown", // troupe name (lower) or "crown"
      upkeepDueAt: Date.now() + 7 * 24 * 3600 * 1000,
      showsHosted: 0,
      foundedAt: Date.now(),
    };
    markDirty();
  }
  return st.theaters[kid];
}

function theaterFor(kingdomId) {
  const st = load();
  return st.theaters[norm(kingdomId)] || null;
}

/** Effective seats: poor condition caps attendance honestly. */
function effectiveCapacity(theater) {
  if (!theater) return 0;
  const cond = Math.max(0, Math.min(100, theater.condition ?? 100));
  return Math.floor((theater.capacity || 0) * (0.4 + 0.6 * (cond / 100)));
}

// --- playwrights & plays ------------------------------------------------------

function registerPlaywright(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key) return { ok: false, reason: "no name" };
  if (!st.playwrights[key]) {
    st.playwrights[key] = {
      username: String(username),
      kingdomId: norm(kingdomId) || null,
      playsWritten: 0,
      registeredAt: Date.now(),
    };
    markDirty();
  }
  return { ok: true, playwright: st.playwrights[key] };
}

function isPlaywright(username) {
  return !!load().playwrights[norm(username)];
}

function playwrightFor(username) {
  return load().playwrights[norm(username)] || null;
}

/** Quality 1-10 from the playwright's REAL engagement — never random. */
function qualityForPlaywright(pw) {
  if (!pw) return 3;
  const st = load();
  let perfs = 0;
  for (const p of Object.values(st.performances)) {
    if (p.playwrightLower === norm(pw.username)) perfs++;
  }
  const q = 3 + Math.min(4, Math.floor((pw.playsWritten || 0) / 2)) + Math.min(3, Math.floor(perfs / 3));
  return Math.max(1, Math.min(10, q));
}

function titleForPlay(playwrightName, genre, kingdomId) {
  const rng = agentRng(`playtitle:${norm(playwrightName)}:${genre}:${norm(kingdomId)}:${Date.now()}`);
  const frame = TITLE_FRAMES[Math.floor(rng() * TITLE_FRAMES.length)];
  return frame
    .replace("{playwright}", String(playwrightName).split(" ")[0])
    .replace("{genreCap}", cap(genre))
    .replace("{genre}", genre)
    .replace("{kingdom}", cap(String(kingdomId || "the realm")));
}

function takePapyrus(player) {
  // Canonical: deleteNumber(id, amount) with balance verification. ItemContainer
  // has no inv.remove(id, amount).
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const before = inv.getAmount?.(PAPYRUS_ID) ?? 0;
    if (before < 1) return false;
    inv.deleteNumber?.(PAPYRUS_ID, 1);
    return (inv.getAmount?.(PAPYRUS_ID) ?? 0) === before - 1;
  } catch {
    return false;
  }
}

/**
 * A playwright drafts a play. Costs 1 real papyrus from the drafter's
 * inventory — no papyrus, no play (honest failure).
 */
function writePlay(player, genre) {
  const st = load();
  const username = player?.getUsername?.() ?? player?.username ?? "";
  const key = norm(username);
  if (!key) return { ok: false, reason: "no name" };
  const g = norm(genre);
  if (!GENRES[g]) return { ok: false, reason: "unknown genre", genres: GENRE_KEYS };
  const pw = st.playwrights[key];
  if (!pw) return { ok: false, reason: "not a playwright" };
  if (!takePapyrus(player)) return { ok: false, reason: "need papyrus" };
  const id = `play-${nextPlayId++}`;
  const quality = qualityForPlaywright(pw);
  const play = {
    id,
    title: titleForPlay(pw.username, g, pw.kingdomId),
    genre: g,
    playwright: pw.username,
    playwrightLower: key,
    kingdomId: pw.kingdomId,
    quality,
    acts: 3 + (quality >= 7 ? 2 : 0),
    performances: 0,
    royaltiesEarned: 0,
    writtenAt: Date.now(),
  };
  st.plays[id] = play;
  pw.playsWritten = (pw.playsWritten || 0) + 1;
  markDirty();
  return { ok: true, play };
}

function playFor(playId) {
  return load().plays[String(playId)] || null;
}

function playsBy(playwrightUsername) {
  const key = norm(playwrightUsername);
  return Object.values(load().plays).filter((p) => p.playwrightLower === key);
}

function playsIn(kingdomId) {
  const kid = norm(kingdomId);
  return Object.values(load().plays).filter((p) => p.kingdomId === kid);
}

// --- troupes ------------------------------------------------------------------

function troupeNameFor(founderName) {
  const rng = agentRng(`troupe:${norm(founderName)}:${Date.now()}`);
  const suffix = TROUPE_NAME_SUFFIXES[Math.floor(rng() * TROUPE_NAME_SUFFIXES.length)];
  const first = String(founderName).split(" ")[0] || "Wandering";
  return `${first}'s ${suffix}`;
}

function formTroupe(founderUsername, kingdomId, name) {
  const st = load();
  const key = norm(founderUsername);
  if (!key) return { ok: false, reason: "no name" };
  const tname = String(name || "").trim() || troupeNameFor(founderUsername);
  const tkey = norm(tname);
  if (st.troupes[tkey]) return { ok: false, reason: "name taken" };
  const troupe = {
    name: tname,
    nameLower: tkey,
    founder: String(founderUsername),
    homeKingdom: norm(kingdomId) || null,
    members: [String(founderUsername)],
    repertoire: [], // playIds
    treasury: 0,
    touring: null, // { toKingdom, departsAt, arrivesAt }
    showsPlayed: 0,
    formedAt: Date.now(),
  };
  st.troupes[tkey] = troupe;
  markDirty();
  return { ok: true, troupe };
}

function troupeFor(name) {
  return load().troupes[norm(name)] || null;
}

function troupesIn(kingdomId) {
  const kid = norm(kingdomId);
  return Object.values(load().troupes).filter((t) => t.homeKingdom === kid);
}

function joinTroupe(username, troupeName) {
  const st = load();
  const t = st.troupes[norm(troupeName)];
  if (!t) return { ok: false, reason: "no such troupe" };
  const name = String(username);
  if (!t.members.includes(name)) {
    t.members.push(name);
    markDirty();
  }
  return { ok: true, troupe: t };
}

function addToRepertoire(troupeName, playId) {
  const st = load();
  const t = st.troupes[norm(troupeName)];
  const play = st.plays[String(playId)];
  if (!t) return { ok: false, reason: "no such troupe" };
  if (!play) return { ok: false, reason: "no such play" };
  if (!t.repertoire.includes(play.id)) {
    t.repertoire.push(play.id);
    markDirty();
  }
  return { ok: true, troupe: t };
}

/** Send a troupe touring to another kingdom. Travel takes real time. */
function tourTo(troupeName, toKingdomId) {
  const st = load();
  const t = st.troupes[norm(troupeName)];
  if (!t) return { ok: false, reason: "no such troupe" };
  const kid = norm(toKingdomId);
  if (!kid) return { ok: false, reason: "no destination" };
  if (kid === t.homeKingdom && !t.touring) return { ok: false, reason: "already home" };
  const now = Date.now();
  t.touring = { toKingdom: kid, departsAt: now, arrivesAt: now + TOUR_TRAVEL_MS };
  markDirty();
  return { ok: true, troupe: t, arrivesAt: t.touring.arrivesAt };
}

/** Where is the troupe right now? Home, or arrived at tour destination. */
function troupeLocation(troupe) {
  if (!troupe) return null;
  const now = Date.now();
  if (troupe.touring && now >= troupe.touring.arrivesAt) {
    // arrived — settle
    troupe.homeKingdom = troupe.touring.toKingdom;
    troupe.touring = null;
    markDirty();
  }
  if (troupe.touring) return { kingdomId: troupe.touring.toKingdom, traveling: true };
  return { kingdomId: troupe.homeKingdom, traveling: false };
}

// --- performances ---------------------------------------------------------------

/**
 * Book a performance: troupe + play at a kingdom theater.
 * The troupe must be located in (or arrived at) the theater's kingdom,
 * the play must be in the troupe's repertoire, and the show needs lead time.
 */
function bookPerformance(troupeName, playId, kingdomId, ticketPrice) {
  const st = load();
  const t = st.troupes[norm(troupeName)];
  if (!t) return { ok: false, reason: "no such troupe" };
  const play = st.plays[String(playId)];
  if (!play) return { ok: false, reason: "no such play" };
  if (!t.repertoire.includes(play.id)) return { ok: false, reason: "not in repertoire" };
  const loc = troupeLocation(t);
  const kid = norm(kingdomId);
  if (!loc || loc.traveling || loc.kingdomId !== kid) {
    return { ok: false, reason: "troupe not here" };
  }
  const theater = ensureTheater(kid);
  const price = Math.max(MIN_TICKET_PRICE, Math.min(MAX_TICKET_PRICE, Number(ticketPrice) || DEFAULT_TICKET_PRICE));
  const id = `perf-${nextPerfId++}`;
  const now = Date.now();
  const perf = {
    id,
    troupe: t.name,
    troupeLower: t.nameLower,
    playId: play.id,
    playTitle: play.title,
    genre: play.genre,
    playwright: play.playwright,
    playwrightLower: play.playwrightLower,
    kingdomId: kid,
    ticketPrice: price,
    startsAt: now + BOOKING_LEAD_MS,
    endsAt: now + BOOKING_LEAD_MS + PERF_DURATION_MS,
    ticketsSold: 0,
    revenue: 0,
    settled: false,
    bookedAt: now,
  };
  st.performances[id] = perf;
  markDirty();
  return { ok: true, performance: perf, theater };
}

function upcomingPerformances(kingdomId) {
  const kid = norm(kingdomId);
  const now = Date.now();
  return Object.values(load().performances)
    .filter((p) => p.kingdomId === kid && !p.settled && p.endsAt > now)
    .sort((a, b) => a.startsAt - b.startsAt);
}

/** Finished but not yet settled — the tick settles these. */
function finishedUnsettledPerformances(kingdomId) {
  const kid = norm(kingdomId);
  const now = Date.now();
  return Object.values(load().performances)
    .filter((p) => p.kingdomId === kid && !p.settled && p.endsAt <= now);
}

function performanceFor(perfId) {
  return load().performances[String(perfId)] || null;
}

function takeCoins(player, amount) {
  // Canonical: deleteNumber(id, amount) with balance verification. ItemContainer
  // has no inv.remove(id, amount).
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(COINS_ID, amount);
    return (inv.getAmount?.(COINS_ID) ?? 0) === before - amount;
  } catch {
    return false;
  }
}

function giveCoinsToTroupe(troupe, amount) {
  troupe.treasury = (troupe.treasury || 0) + amount;
}

/**
 * Buy a ticket: REAL coins leave the buyer's inventory. Broke buyers fail
 * honestly. Attendance is capped by effective capacity (condition matters).
 */
function buyTicket(player, perfId) {
  const st = load();
  const perf = st.performances[String(perfId)];
  if (!perf) return { ok: false, reason: "no such performance" };
  if (perf.settled) return { ok: false, reason: "show over" };
  if (Date.now() >= perf.startsAt) return { ok: false, reason: "already started" };
  const theater = st.theaters[perf.kingdomId];
  const capSeats = effectiveCapacity(theater);
  if (perf.ticketsSold >= capSeats) return { ok: false, reason: "sold out" };
  if (!takeCoins(player, perf.ticketPrice)) return { ok: false, reason: "can't afford it" };
  perf.ticketsSold++;
  perf.revenue += perf.ticketPrice;
  // hold revenue on the performance until settlement
  markDirty();
  return { ok: true, performance: perf };
}

/**
 * Settle a finished performance: split REAL revenue 60/25/15 across
 * troupe treasury / venue owner / playwright royalty. The playwright's
 * royalty is credited to their troupe treasury if they're a member of one,
 * else recorded on the play (claimable via troupe). Venue owner's share
 * goes to the owning troupe's treasury, or the crown (kingdom purse seam
 * left for the kingdoms layer — recorded, not invented).
 */
function settlePerformance(perfId) {
  const st = load();
  const perf = st.performances[String(perfId)];
  if (!perf) return { ok: false, reason: "no such performance" };
  if (perf.settled) return { ok: false, reason: "already settled" };
  if (Date.now() < perf.endsAt) return { ok: false, reason: "not over yet" };
  const troupe = st.troupes[perf.troupeLower];
  const play = st.plays[perf.playId];
  const theater = st.theaters[perf.kingdomId];
  const revenue = perf.revenue || 0;
  const troupeShare = Math.floor((revenue * TROUPE_SHARE_BPS) / 10000);
  const venueShare = Math.floor((revenue * VENUE_SHARE_BPS) / 10000);
  const royaltyShare = revenue - troupeShare - venueShare;
  const split = { troupeShare, venueShare, royaltyShare };
  if (troupe) {
    troupe.treasury = (troupe.treasury || 0) + troupeShare;
    troupe.showsPlayed = (troupe.showsPlayed || 0) + 1;
  }
  if (theater) {
    theater.showsHosted = (theater.showsHosted || 0) + 1;
    if (theater.owner && theater.owner !== "crown") {
      const ownerTroupe = st.troupes[norm(theater.owner)];
      if (ownerTroupe) ownerTroupe.treasury = (ownerTroupe.treasury || 0) + venueShare;
      // crown-owned venue share accrues to the theater record for the
      // kingdoms layer to collect (kingdom purse seam).
      else theater.crownRevenue = (theater.crownRevenue || 0) + venueShare;
    } else {
      theater.crownRevenue = (theater.crownRevenue || 0) + venueShare;
    }
  }
  if (play) {
    play.performances = (play.performances || 0) + 1;
    play.royaltiesEarned = (play.royaltiesEarned || 0) + royaltyShare;
    // royalty follows the playwright into their troupe treasury when known
    let paid = false;
    for (const tr of Object.values(st.troupes)) {
      if (tr.members.includes(play.playwright)) {
        tr.treasury = (tr.treasury || 0) + royaltyShare;
        paid = true;
        break;
      }
    }
    if (!paid) play.royaltiesOwed = (play.royaltiesOwed || 0) + royaltyShare;
  }
  // review: deterministic from quality + attendance
  const review = reviewFor(perf, theater);
  st.reviews.push(review);
  if (st.reviews.length > 60) st.reviews = st.reviews.slice(-60);
  perf.settled = true;
  perf.review = review;
  markDirty();
  return { ok: true, performance: perf, split, review };
}

/** Deterministic review from play quality and how full the house was. */
function reviewFor(perf, theater) {
  const play = load().plays[perf.playId];
  const quality = play?.quality ?? 5;
  const seats = effectiveCapacity(theater) || 1;
  const fullness = Math.min(1, (perf.ticketsSold || 0) / seats);
  // deterministic wobble from the performance id — same show, same review
  const rng = agentRng(`review:${perf.id}`);
  const wobble = Math.floor(rng() * 3) - 1; // -1..+1
  const stars = Math.max(1, Math.min(5, Math.round((quality / 2) * (0.6 + 0.4 * fullness) + wobble * 0.5)));
  const verdict =
    stars >= 5 ? "a triumph — the crowd roars" :
    stars === 4 ? "warmly received" :
    stars === 3 ? "politely applauded" :
    stars === 2 ? "met with scattered coughs" :
    "hissed off the stage";
  return {
    perfId: perf.id,
    playTitle: perf.playTitle,
    troupe: perf.troupe,
    kingdomId: perf.kingdomId,
    stars,
    verdict,
    ticketsSold: perf.ticketsSold || 0,
    at: Date.now(),
  };
}

function recentReviews(kingdomId, limit = 5) {
  const kid = norm(kingdomId);
  return load()
    .reviews.filter((r) => !kid || r.kingdomId === kid)
    .slice(-(limit || 5))
    .reverse();
}

// --- culture seam ---------------------------------------------------------------

/**
 * Kingdom pride delta from recent performances: history/epic plays staged
 * at home raise pride; satire staged abroad is noticed (small negative
 * for the mocked kingdom's pride — read by the kingdoms layer).
 * Returns { pride: number } — the kingdoms layer decides what to do.
 */
function prideDeltaFor(kingdomId) {
  const kid = norm(kingdomId);
  const cutoff = Date.now() - PRIDE_WINDOW_MS;
  let pride = 0;
  for (const r of load().reviews) {
    if (r.at < cutoff) continue;
    const perf = load().performances[r.perfId];
    if (!perf) continue;
    const genre = perf.genre;
    if (r.kingdomId === kid && (genre === "history" || genre === "epic") && r.stars >= 4) {
      pride += 1;
    }
    if (r.kingdomId !== kid && genre === "satire" && r.stars >= 3) {
      // satire abroad mocks someone — check if the play's home kingdom matches
      const play = load().plays[perf.playId];
      if (play && play.kingdomId !== kid && norm(play.kingdomId) === kid) pride -= 1;
    }
  }
  return { pride };
}

// --- fame deeds -------------------------------------------------------------------

const DEED_STANDING_OVATION = "standingovation"; // +8 acclaimed 5-star show
const DEED_PLAYWRIGHT_LAUREATE = "playwrightlaureate"; // +6 written 5 plays

function fameDeedsFor(username) {
  const key = norm(username);
  const st = load();
  const out = [];
  // standing ovation: member of a troupe with a 5-star review
  for (const r of st.reviews) {
    if (r.stars < 5) continue;
    const t = st.troupes[norm(r.troupe)];
    if (t && t.members.includes(username)) {
      out.push(DEED_STANDING_OVATION);
      break;
    }
  }
  const pw = st.playwrights[key];
  if (pw && (pw.playsWritten || 0) >= 5) out.push(DEED_PLAYWRIGHT_LAUREATE);
  return out;
}

// --- upkeep -------------------------------------------------------------------------

function payUpkeep(kingdomId, payer) {
  const theater = theaterFor(kingdomId);
  if (!theater) return { ok: false, reason: "no theater" };
  if (!takeCoins(payer, THEATER_UPKEEP_WEEKLY)) return { ok: false, reason: "can't afford upkeep" };
  theater.upkeepDueAt = Date.now() + 7 * 24 * 3600 * 1000;
  theater.condition = Math.min(100, (theater.condition ?? 100) + 6);
  markDirty();
  return { ok: true, theater };
}

/** Weekly decay for crown theaters whose upkeep lapsed. Called by the tick. */
function decayTheater(kingdomId) {
  const theater = theaterFor(kingdomId);
  if (!theater) return { ok: false, reason: "no theater" };
  theater.condition = Math.max(20, (theater.condition ?? 100) - CONDITION_DECAY_WEEKLY);
  theater.upkeepDueAt = Date.now() + 7 * 24 * 3600 * 1000;
  markDirty();
  return { ok: true, theater };
}

function renovate(kingdomId, payer, points) {
  const theater = theaterFor(kingdomId);
  if (!theater) return { ok: false, reason: "no theater" };
  const pts = Math.max(1, Math.min(50, Number(points) || 10));
  const cost = pts * RENOVATE_COST_PER_POINT;
  if (!takeCoins(payer, cost)) return { ok: false, reason: "can't afford it" };
  theater.condition = Math.min(100, (theater.condition ?? 0) + pts);
  markDirty();
  return { ok: true, theater, cost };
}

// --- describe -------------------------------------------------------------------------

function describe() {
  const st = load();
  return {
    theaters: Object.keys(st.theaters).length,
    plays: Object.keys(st.plays).length,
    playwrights: Object.keys(st.playwrights).length,
    troupes: Object.keys(st.troupes).length,
    performances: Object.keys(st.performances).length,
    reviews: st.reviews.length,
  };
}

module.exports = {
  // constants
  GENRES,
  GENRE_KEYS,
  COINS_ID,
  PAPYRUS_ID,
  DEFAULT_TICKET_PRICE,
  MIN_TICKET_PRICE,
  MAX_TICKET_PRICE,
  TROUPE_SHARE_BPS,
  VENUE_SHARE_BPS,
  ROYALTY_SHARE_BPS,
  THEATER_UPKEEP_WEEKLY,
  DEED_STANDING_OVATION,
  DEED_PLAYWRIGHT_LAUREATE,
  // theaters
  ensureTheater,
  theaterFor,
  theaterTileFor,
  effectiveCapacity,
  payUpkeep,
  decayTheater,
  renovate,
  // playwrights & plays
  registerPlaywright,
  isPlaywright,
  playwrightFor,
  writePlay,
  playFor,
  playsBy,
  playsIn,
  qualityForPlaywright,
  // troupes
  formTroupe,
  troupeFor,
  troupesIn,
  joinTroupe,
  addToRepertoire,
  tourTo,
  troupeLocation,
  // performances
  bookPerformance,
  upcomingPerformances,
  finishedUnsettledPerformances,
  performanceFor,
  buyTicket,
  settlePerformance,
  recentReviews,
  // culture seam
  prideDeltaFor,
  // fame
  fameDeedsFor,
  // describe + persistence
  describe,
  save,
  resetForTests,
  _setSavePathForTests,
};
