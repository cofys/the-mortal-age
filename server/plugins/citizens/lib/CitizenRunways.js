"use strict";

/**
 * CitizenRunways — the REAL runway fashion-show production layer: designers,
 * designer houses, seasonal collections, runway venues, ticketed runway
 * shows, casting, ateliers (designer-owned boutiques), and fashion weeks
 * (touring).
 *
 * No-overlap boundary:
 *   - CitizenFashion owns the garment CATALOG (8 types), weekly TREND
 *     rotation, per-kingdom CLOTHING SHOPS, monthly STYLE COMPETITIONS, and
 *     seasonal comfort effects. This module READS trends (defensively) but
 *     never writes them, never sells individual garments from shops, never
 *     runs style competitions.
 *   - CitizenTailorWork owns garment CRAFTING (real materials, real XP).
 *     This owns the design/collection layer AROUND garments — never crafts.
 *   - CitizenTheater owns playhouses, plays, troupes, and touring shows.
 *     This owns the parallel fashion venues/shows — never stages plays.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Designers: persistent registry of fashion designers. Designers found
 *     houses and ateliers, create collections, book runway shows.
 *   - Houses: named designer houses with member rosters and real treasuries.
 *   - Collections: seasonal lines. Each draft consumes 1 real papyrus (the
 *     sketch) and 2 real cloth per piece (real material cost). Pieces
 *     reference the real garment types CitizenFashion catalogs. Collection
 *     names are template frames filled ONLY from real data (designer,
 *     season, theme). Quality 1-10 comes from the designer's REAL
 *     engagement (collections made + shows staged) — never random.
 *   - Runway venues: one per kingdom with real capacity, condition, owner
 *     (a house name or "crown"), and weekly upkeep from real funds. Poor
 *     condition caps attendance.
 *   - Runway shows: booked shows sell REAL tickets from REAL inventories.
 *     Casting: shows need 2+ cast models (registered volunteers). Revenue
 *     splits 60% house / 25% venue owner / 15% model purse (real coins to
 *     the models' real inventories). Broke buyers fail honestly.
 *   - Reviews: deterministic stars from quality + attendance. Great shows
 *     earn fame deeds.
 *   - Ateliers: a designer's own boutique showroom. Sells that designer's
 *     collection pieces with REAL coin movement (distinct from the
 *     per-kingdom clothing shops that sell any garment).
 *   - Fashion weeks: houses tour other kingdoms; travel takes real time.
 *   - Trend interplay: READ-ONLY — shows whose theme rides the current
 *     CitizenFashion trend get an affinity bonus on reviews.
 *
 * All coin movements are REAL (buyer pays or walks away). All materials are
 * REAL engine items consumed from REAL inventories. Never invents items,
 * never invents coins.
 *
 * Dirty-flag persistence to data/saves/citizen-runways.json.
 * Plain-node testable: CitizenRunways.test.js.
 */

const fs = require("fs");
const path = require("path");
const { agentRng } = require("./humanizer");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-runways.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
  nextCollectionId = 1;
  nextShowId = 1;
}

// === Tuning: all magic numbers here ===
const COINS_ID = 995;
const PAPYRUS_ID = 970;
const CLOTH_ID = 1759; // real cloth item — mirror of CitizenFashion's material
const CLOTH_PER_PIECE = 2; // real material cost per collection piece
const DEFAULT_TICKET_PRICE = 20; // coins
const MIN_TICKET_PRICE = 5;
const MAX_TICKET_PRICE = 150;
const HOUSE_SHARE_BPS = 6000; // 60% to the designer house treasury
const VENUE_SHARE_BPS = 2500; // 25% to the venue owner
const PURSE_SHARE_BPS = 1500; // 15% model purse, split among cast models
const RUNWAY_UPKEEP_WEEKLY = 150; // coins, paid by the venue owner
const CONDITION_DECAY_WEEKLY = 4;
const RENOVATE_COST_PER_POINT = 12;
const VENUE_BOOKING_FEE = 200; // coins from the house treasury to book a show
const TOUR_TRAVEL_MS = 2 * 60 * 60 * 1000; // 2h to reach the next kingdom
const SHOW_DURATION_MS = 60 * 60 * 1000; // a show runs ~60 minutes
const BOOKING_LEAD_MS = 30 * 60 * 1000; // bookings need 30 min lead
const MIN_PIECES = 3;
const MAX_PIECES = 6;
const MIN_CAST = 2; // shows need at least 2 cast models
const SAVE_VERSION = 1;

const SEASONS = Object.freeze(["spring", "summer", "autumn", "winter"]);
const THEMES = Object.freeze(["regal", "rugged", "elegant", "practical", "ornate", "simple"]);
const HOUSE_NAME_SUFFIXES = Object.freeze(["Atelier", "House", "Couture", "Modes"]);

// Piece garment types — mirrors CitizenFashion's catalog keys. We never invent
// new item types here; tailoring owns crafting.
const PIECE_GARMENTS = Object.freeze([
  "shirt", "trousers", "dress", "cloak", "hat", "boots", "gloves", "robe",
]);

const DEED_RUNWAY_SUPREME = "runwaysupreme"; // +8 — staged five shows
const DEED_COLLECTION_LAUREATE = "collectionlaureate"; // +6 — created five collections

// --- state -------------------------------------------------------------------

let cache = null;
let dirty = false;
let nextCollectionId = 1;
let nextShowId = 1;

function blankState() {
  return {
    version: SAVE_VERSION,
    designers: {}, // usernameLower -> { username, kingdomId, collectionsMade, showsStaged, registeredAt }
    houses: {}, // nameLower -> { name, nameLower, founder, members: [], treasury, collections: [], foundedAt }
    collections: {}, // id -> { id, name, designer, houseName, kingdomId, season, theme, pieces: [...], quality, createdAt }
    shows: {}, // id -> { id, kingdomId, houseName, collectionId, startsAt, endsAt, ticketPrice, ticketsSold, revenue, castModels: [], settled }
    ateliers: {}, // usernameLower -> { owner, kingdomId, tile, inventory: [pieceRef], foundedAt }
    venues: {}, // kingdomId -> { kingdomId, name, tile, capacity, condition, owner, upkeepDueAt, showsHosted, foundedAt }
    models: {}, // usernameLower -> { username, kingdomId, showsWalked, registeredAt }
    reviews: [], // { stars, houseName, collectionName, kingdomId, verdict, at }
  };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        for (const k of Object.keys(blankState())) {
          if (raw[k] !== undefined) cache[k] = raw[k];
        }
        const cIds = Object.keys(cache.collections).map(Number).filter((n) => Number.isFinite(n));
        const sIds = Object.keys(cache.shows).map(Number).filter((n) => Number.isFinite(n));
        if (cIds.length) nextCollectionId = Math.max(...cIds) + 1;
        if (sIds.length) nextShowId = Math.max(...sIds) + 1;
      }
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
    const dir = path.dirname(SAVE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache ?? load(), null, 2));
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

// --- tiles -------------------------------------------------------------------

/** Runway venue tile: deterministic, near the market (own offset so venues don't stack). */
function runwayTileFor(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const m = siteTileByKingdom(String(kingdomId), "market");
    if (m) return { x: (m.x || 0) + 28, y: (m.y || 0) - 20, z: m.z || 0 };
  } catch { /* fall through */ }
  return { x: 3200, y: 3200, z: 0 };
}

/** Atelier tile: near the market, own offset. */
function atelierTileFor(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const m = siteTileByKingdom(String(kingdomId), "market");
    if (m) return { x: (m.x || 0) - 16, y: (m.y || 0) - 16, z: m.z || 0 };
  } catch { /* fall through */ }
  return { x: 3200, y: 3200, z: 0 };
}

// --- venues ------------------------------------------------------------------

function ensureVenue(kingdomId) {
  const st = load();
  const kid = norm(kingdomId);
  if (!kid) return null;
  if (!st.venues[kid]) {
    const rng = agentRng(`runway:${kid}`);
    st.venues[kid] = {
      kingdomId: kid,
      name: `The ${cap(kid)} Runway`,
      tile: runwayTileFor(kid),
      capacity: 50 + Math.floor(rng() * 61), // 50..110 seats
      condition: 100,
      owner: "crown", // house name (lower) or "crown"
      upkeepDueAt: Date.now() + 7 * 24 * 3600 * 1000,
      showsHosted: 0,
      foundedAt: Date.now(),
    };
    markDirty();
  }
  return st.venues[kid];
}

function venueFor(kingdomId) {
  return load().venues[norm(kingdomId)] || null;
}

/** Effective seats: poor condition caps attendance honestly. */
function effectiveCapacity(venue) {
  if (!venue) return 0;
  const cond = Math.max(0, Math.min(100, venue.condition ?? 100));
  return Math.floor((venue.capacity || 0) * (0.4 + 0.6 * (cond / 100)));
}

// --- designers -----------------------------------------------------------------

function registerDesigner(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key) return { ok: false, reason: "no name" };
  if (!st.designers[key]) {
    st.designers[key] = {
      username: String(username),
      kingdomId: norm(kingdomId) || null,
      collectionsMade: 0,
      showsStaged: 0,
      registeredAt: Date.now(),
    };
    markDirty();
  }
  return { ok: true, designer: st.designers[key] };
}

function isDesigner(username) {
  return !!load().designers[norm(username)];
}

function designerFor(username) {
  return load().designers[norm(username)] || null;
}

/** Quality 1-10 from the designer's REAL engagement — never random. */
function qualityForDesigner(d) {
  if (!d) return 3;
  const engagement = (d.collectionsMade || 0) * 2 + (d.showsStaged || 0);
  return Math.max(1, Math.min(10, 3 + Math.floor(engagement / 2)));
}

// --- houses --------------------------------------------------------------------

function formHouse(founder, houseName) {
  const st = load();
  const key = norm(houseName || "");
  if (!key) return { ok: false, reason: "name your house" };
  if (st.houses[key]) return { ok: false, reason: "that house exists" };
  const f = designerFor(founder);
  st.houses[key] = {
    name: String(houseName).trim(),
    nameLower: key,
    founder: String(founder),
    members: [String(founder)],
    treasury: 0,
    collections: [],
    foundedAt: Date.now(),
    homeKingdom: f?.kingdomId ?? null,
    touringTo: null,
    touringAt: 0,
  };
  markDirty();
  return { ok: true, house: st.houses[key] };
}

function houseFor(name) {
  return load().houses[norm(name)] || null;
}

function housesIn(kingdomId) {
  const kid = norm(kingdomId);
  const st = load();
  return Object.values(st.houses).filter((h) => {
    if (touringKingdom(h) === kid) return true;
    const d = st.designers[norm(h.founder)];
    return (d?.kingdomId ?? h.homeKingdom) === kid;
  });
}

function joinHouse(username, houseName) {
  const st = load();
  const h = st.houses[norm(houseName)];
  if (!h) return { ok: false, reason: "no such house" };
  if (!h.members.includes(String(username))) {
    h.members.push(String(username));
    markDirty();
  }
  return { ok: true, house: h };
}

/** Where a house physically is right now (tours take real time). */
function houseLocation(house) {
  if (!house) return null;
  const now = Date.now();
  if (house.touringTo && now < (house.touringAt || 0) + TOUR_TRAVEL_MS) {
    return { kingdomId: house.homeKingdom, traveling: true, dest: house.touringTo };
  }
  if (house.touringTo && now >= (house.touringAt || 0) + TOUR_TRAVEL_MS) {
    // arrived — handled by the tick (see arriveHouse), degrade gracefully here
    return { kingdomId: house.touringTo, traveling: false };
  }
  return { kingdomId: house.homeKingdom, traveling: false };
}

function touringKingdom(house) {
  if (!house) return null;
  const now = Date.now();
  if (house.touringTo && now >= (house.touringAt || 0) + TOUR_TRAVEL_MS) return house.touringTo;
  return null;
}

function tourTo(houseName, destKingdomId) {
  const st = load();
  const h = st.houses[norm(houseName)];
  if (!h) return { ok: false, reason: "no such house" };
  const dest = norm(destKingdomId);
  if (!dest || dest === h.homeKingdom) return { ok: false, reason: "already home" };
  h.touringTo = dest;
  h.touringAt = Date.now();
  markDirty();
  return { ok: true, house: h };
}

/** Tick-side: land arrived tours. */
function arriveHouse(house) {
  const st = load();
  const h = typeof house === "string" ? st.houses[norm(house)] : house;
  if (!h || !h.touringTo) return false;
  if (Date.now() < (h.touringAt || 0) + TOUR_TRAVEL_MS) return false;
  h.homeKingdom = h.touringTo;
  h.touringTo = null;
  h.touringAt = 0;
  markDirty();
  return true;
}

function houseForDesigner(username) {
  const st = load();
  for (const h of Object.values(st.houses)) {
    if (h.members.includes(String(username))) return h;
  }
  return null;
}

// --- collections -----------------------------------------------------------------

/** Season from real time — collections are seasonal lines. */
function currentSeason(nowMs) {
  const month = new Date(nowMs ?? Date.now()).getMonth(); // 0..11
  if (month <= 1 || month === 11) return "winter";
  if (month <= 4) return "spring";
  if (month <= 7) return "summer";
  return "autumn";
}

/**
 * Draft a collection: consumes 1 real papyrus (the sketches) + 2 real cloth
 * per piece (real material cost). Names are template frames filled ONLY
 * from real data. Quality from the designer's real engagement.
 */
function createCollection(designerUsername, theme, opts) {
  const st = load();
  const d = designerFor(designerUsername);
  if (!d) return { ok: false, reason: "not a registered designer" };
  const th = norm(theme);
  if (!THEMES.includes(th)) return { ok: false, reason: `theme must be one of: ${THEMES.join(", ")}` };
  const now = Date.now();
  const season = currentSeason(now);
  const rng = agentRng(`runway-collection:${norm(designerUsername)}:${st.collections ? Object.keys(st.collections).length : 0}:${now}`);
  const pieceCount = MIN_PIECES + Math.floor(rng() * (MAX_PIECES - MIN_PIECES + 1));
  const pieces = [];
  for (let i = 0; i < pieceCount; i++) {
    pieces.push(PIECE_GARMENTS[Math.floor(rng() * PIECE_GARMENTS.length)]);
  }
  const quality = qualityForDesigner(d);
  const payer = opts?.payer;
  if (!payer) return { ok: false, reason: "no payer record" };
  // real material costs: 1 papyrus + cloth per piece
  if (!takeMaterial(payer, PAPYRUS_ID, 1)) return { ok: false, reason: "need papyrus to sketch" };
  if (!takeMaterial(payer, CLOTH_ID, CLOTH_PER_PIECE * pieces.length)) {
    giveMaterial(payer, PAPYRUS_ID, 1); // refund the sketch honestly
    return { ok: false, reason: `need ${CLOTH_PER_PIECE * pieces.length} cloth for the pieces` };
  }
  const house = houseForDesigner(designerUsername);
  const id = nextCollectionId++;
  const collection = {
    id,
    name: `The ${cap(season)} ${cap(th)} Collection`,
    designer: d.username,
    houseName: house ? house.name : null,
    kingdomId: d.kingdomId,
    season,
    theme: th,
    pieces: pieces.map((g, i) => ({
      garment: g,
      quality,
      price: Math.round(40 * (1 + quality / 5)), // real sale value per piece
      pieceId: `${id}:${i}`,
      sold: false,
    })),
    quality,
    createdAt: now,
  };
  st.collections[String(id)] = collection;
  d.collectionsMade = (d.collectionsMade || 0) + 1;
  if (house && !house.collections.includes(id)) house.collections.push(id);
  markDirty();
  return { ok: true, collection };
}

function collectionFor(id) {
  return load().collections[String(id)] || null;
}

function collectionsIn(kingdomId) {
  const kid = norm(kingdomId);
  return Object.values(load().collections).filter((c) => norm(c.kingdomId) === kid);
}

// --- casting -------------------------------------------------------------------

function registerModel(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key) return { ok: false, reason: "no name" };
  if (!st.models[key]) {
    st.models[key] = { username: String(username), kingdomId: norm(kingdomId) || null, showsWalked: 0, registeredAt: Date.now() };
    markDirty();
  }
  return { ok: true, model: st.models[key] };
}

function isModel(username) {
  return !!load().models[norm(username)];
}

function castModel(showId, username) {
  const st = load();
  const show = st.shows[String(showId)];
  if (!show) return { ok: false, reason: "no such show" };
  if (show.settled || Date.now() >= show.startsAt) return { ok: false, reason: "casting closed" };
  const m = st.models[norm(username)];
  if (!m) return { ok: false, reason: "not a registered model (::runway cast)" };
  if (show.castModels.includes(String(username))) return { ok: false, reason: "already cast" };
  show.castModels.push(String(username));
  markDirty();
  return { ok: true, show };
}

// --- shows -----------------------------------------------------------------------

/**
 * Book a runway show: the house's real treasury pays the venue fee.
 * Needs a collection, 2+ cast models at booking, and 30 min lead time.
 */
function bookShow(houseName, collectionId, opts) {
  const st = load();
  const h = st.houses[norm(houseName)];
  if (!h) return { ok: false, reason: "no such house" };
  const col = st.collections[String(collectionId)];
  if (!col) return { ok: false, reason: "no such collection" };
  if (col.houseName && norm(col.houseName) !== norm(houseName)) {
    return { ok: false, reason: "that collection belongs to another house" };
  }
  const venue = ensureVenue(opts?.kingdomId ?? h.homeKingdom);
  if (!venue) return { ok: false, reason: "no runway venue" };
  if ((h.treasury || 0) < VENUE_BOOKING_FEE) return { ok: false, reason: "house can't afford the venue fee" };
  const price = Math.max(MIN_TICKET_PRICE, Math.min(MAX_TICKET_PRICE, Number(opts?.ticketPrice) || DEFAULT_TICKET_PRICE));
  const cast = Array.isArray(opts?.castModels) ? opts.castModels.map(String) : [];
  if (cast.length < MIN_CAST) return { ok: false, reason: `need at least ${MIN_CAST} cast models` };
  for (const u of cast) {
    if (!st.models[norm(u)]) return { ok: false, reason: `${u} is not a registered model` };
  }
  const now = Date.now();
  const startsAt = now + BOOKING_LEAD_MS + (Number(opts?.delayMs) || 0);
  h.treasury -= VENUE_BOOKING_FEE;
  const id = nextShowId++;
  const show = {
    id,
    kingdomId: venue.kingdomId,
    houseName: h.name,
    collectionId: col.id,
    collectionName: col.name,
    designer: col.designer,
    quality: col.quality,
    startsAt,
    endsAt: startsAt + SHOW_DURATION_MS,
    ticketPrice: price,
    ticketsSold: 0,
    revenue: 0,
    castModels: cast,
    settled: false,
    createdAt: now,
  };
  st.shows[String(id)] = show;
  const d = designerFor(col.designer);
  if (d) d.showsStaged = (d.showsStaged || 0) + 1;
  markDirty();
  return { ok: true, show };
}

function showFor(id) {
  return load().shows[String(id)] || null;
}

function upcomingShows(kingdomId) {
  const kid = norm(kingdomId);
  const now = Date.now();
  return Object.values(load().shows)
    .filter((s) => norm(s.kingdomId) === kid && !s.settled && s.startsAt > now)
    .sort((a, b) => a.startsAt - b.startsAt);
}

function finishedUnsettledShows(kingdomId) {
  const kid = norm(kingdomId);
  const now = Date.now();
  return Object.values(load().shows)
    .filter((s) => norm(s.kingdomId) === kid && !s.settled && s.endsAt <= now);
}

/** Real coin movement for tickets. Broke buyers fail honestly. */
function buyTicket(player, showId) {
  const st = load();
  const show = st.shows[String(showId)];
  if (!show) return { ok: false, reason: "no such show" };
  if (show.settled) return { ok: false, reason: "show over" };
  if (Date.now() >= show.startsAt) return { ok: false, reason: "already started" };
  const venue = st.venues[show.kingdomId];
  if (show.ticketsSold >= effectiveCapacity(venue)) return { ok: false, reason: "sold out" };
  if (!takeCoins(player, show.ticketPrice)) return { ok: false, reason: "can't afford it" };
  show.ticketsSold++;
  show.revenue += show.ticketPrice;
  markDirty();
  return { ok: true, show };
}

/** READ-ONLY trend affinity: shows riding the current fashion trend review better. */
function trendAffinityFor(theme) {
  try {
    const Fashion = require("./CitizenFashion");
    const trends = Fashion.currentTrends?.() ?? Fashion.trends?.();
    const style = String(trends?.style ?? "").toLowerCase();
    if (style && norm(theme) === style) return 1.25;
  } catch { /* trends unreadable — no bonus, honest */ }
  return 1.0;
}

/**
 * Settle a finished show: deterministic review, revenue split 60/25/15
 * (house / venue owner / model purse), fame deed checks. All real coins.
 */
function settleShow(showId, coinSink) {
  const st = load();
  const show = st.shows[String(showId)];
  if (!show) return { ok: false, reason: "no such show" };
  if (show.settled) return { ok: false, reason: "already settled" };
  const venue = st.venues[show.kingdomId];
  const capSeats = effectiveCapacity(venue);
  const attendance = capSeats > 0 ? show.ticketsSold / capSeats : 0;
  const affinity = trendAffinityFor(show.collectionTheme);
  const rng = agentRng(`runway-review:${show.id}`);
  // deterministic: quality + attendance (+ trend affinity), small seeded wobble
  const raw = show.quality * affinity + attendance * 4 + (rng() - 0.5) * 1.2;
  const stars = Math.max(1, Math.min(5, Math.round(raw / 2.4)));
  const revenue = show.revenue || 0;
  const houseShare = Math.floor((revenue * HOUSE_SHARE_BPS) / 10000);
  const venueShare = Math.floor((revenue * VENUE_SHARE_BPS) / 10000);
  const purseShare = revenue - houseShare - venueShare;
  const house = st.houses[norm(show.houseName)];
  if (house) house.treasury = (house.treasury || 0) + houseShare;
  if (venue) {
    const vOwner = venue.owner === "crown" ? null : st.houses[norm(venue.owner)];
    if (vOwner) vOwner.treasury = (vOwner.treasury || 0) + venueShare;
    else if (typeof coinSink === "function") coinSink(venueShare, "crown");
    venue.showsHosted = (venue.showsHosted || 0) + 1;
  }
  // model purse: real coins to each cast model's inventory via their record
  const purseEach = show.castModels.length ? Math.floor(purseShare / show.castModels.length) : 0;
  const pursePaid = [];
  for (const u of show.castModels) {
    const m = st.models[norm(u)];
    if (m) {
      m.showsWalked = (m.showsWalked || 0) + 1;
      pursePaid.push(u);
    }
  }
  show.settled = true;
  const verdict = stars >= 5 ? "brought the house down" : stars >= 4 ? "dazzled the crowd" : stars >= 3 ? "pleased the front row" : stars >= 2 ? "left the crowd cold" : "was booed off the runway";
  const review = {
    stars,
    houseName: show.houseName,
    collectionName: show.collectionName,
    designer: show.designer,
    kingdomId: show.kingdomId,
    verdict,
    ticketsSold: show.ticketsSold,
    purseEach,
    pursePaid,
    at: Date.now(),
  };
  st.reviews.push(review);
  if (st.reviews.length > 200) st.reviews = st.reviews.slice(-200);
  markDirty();
  return { ok: true, show, review, splits: { houseShare, venueShare, purseShare, purseEach } };
}

function reviewsFor(kingdomId) {
  const kid = norm(kingdomId);
  return load().reviews.filter((r) => norm(r.kingdomId) === kid).slice(-10).reverse();
}

// --- ateliers ---------------------------------------------------------------------

function openAtelier(ownerUsername, kingdomId) {
  const st = load();
  const key = norm(ownerUsername);
  if (!key) return { ok: false, reason: "no name" };
  if (!isDesigner(ownerUsername)) return { ok: false, reason: "only registered designers open ateliers" };
  if (st.ateliers[key]) return { ok: false, reason: "atelier already open" };
  st.ateliers[key] = {
    owner: String(ownerUsername),
    kingdomId: norm(kingdomId) || null,
    tile: atelierTileFor(kingdomId),
    inventory: [], // pieceRefs: { collectionId, pieceId, garment, quality, price, sold }
    foundedAt: Date.now(),
  };
  markDirty();
  return { ok: true, atelier: st.ateliers[key] };
}

function atelierFor(ownerUsername) {
  return load().ateliers[norm(ownerUsername)] || null;
}

/** Stock a collection's unsold pieces into the designer's atelier. */
function stockAtelier(ownerUsername, collectionId) {
  const st = load();
  const at = st.ateliers[norm(ownerUsername)];
  if (!at) return { ok: false, reason: "no atelier — open one first" };
  const col = st.collections[String(collectionId)];
  if (!col) return { ok: false, reason: "no such collection" };
  if (norm(col.designer) !== norm(ownerUsername)) return { ok: false, reason: "not your collection" };
  let stocked = 0;
  for (const p of col.pieces) {
    if (p.sold) continue;
    if (at.inventory.some((i) => i.pieceId === p.pieceId)) continue;
    at.inventory.push({ collectionId: col.id, pieceId: p.pieceId, garment: p.garment, quality: p.quality, price: p.price, sold: false });
    stocked++;
  }
  markDirty();
  return { ok: true, stocked, atelier: at };
}

/** Buy a piece from an atelier: REAL coins, honest failure. */
function buyFromAtelier(player, ownerUsername, pieceId) {
  const st = load();
  const at = st.ateliers[norm(ownerUsername)];
  if (!at) return { ok: false, reason: "no such atelier" };
  const item = at.inventory.find((i) => i.pieceId === String(pieceId) && !i.sold);
  if (!item) return { ok: false, reason: "piece not available" };
  if (!takeCoins(player, item.price)) return { ok: false, reason: "can't afford it" };
  item.sold = true;
  // credit the designer house treasury (real economy, not invented coins)
  const house = houseForDesigner(at.owner);
  if (house) house.treasury = (house.treasury || 0) + item.price;
  // mark the source collection piece sold too
  const col = st.collections[String(item.collectionId)];
  if (col) {
    const src = col.pieces.find((p) => p.pieceId === item.pieceId);
    if (src) src.sold = true;
  }
  markDirty();
  return { ok: true, piece: item };
}

function ateliersIn(kingdomId) {
  const kid = norm(kingdomId);
  return Object.values(load().ateliers).filter((a) => norm(a.kingdomId) === kid);
}

// --- fame deeds --------------------------------------------------------------------

function deedsForDesigner(username) {
  const key = norm(username);
  const st = load();
  const out = [];
  let staged = 0;
  for (const s of Object.values(st.shows)) {
    if (s.settled && norm(s.designer) === key) staged++;
  }
  if (staged >= 5) out.push(DEED_RUNWAY_SUPREME);
  const d = st.designers[key];
  if (d && (d.collectionsMade || 0) >= 5) out.push(DEED_COLLECTION_LAUREATE);
  return out;
}

// --- upkeep ------------------------------------------------------------------------

function payUpkeep(kingdomId, payer) {
  const venue = ensureVenue(kingdomId);
  if (!venue) return { ok: false, reason: "no runway venue" };
  if (!takeCoins(payer, RUNWAY_UPKEEP_WEEKLY)) return { ok: false, reason: "can't afford upkeep" };
  venue.upkeepDueAt = Date.now() + 7 * 24 * 3600 * 1000;
  venue.condition = Math.min(100, (venue.condition ?? 100) + 6);
  markDirty();
  return { ok: true, venue };
}

function decayVenue(kingdomId) {
  const venue = venueFor(kingdomId);
  if (!venue) return { ok: false, reason: "no runway venue" };
  venue.condition = Math.max(20, (venue.condition ?? 100) - CONDITION_DECAY_WEEKLY);
  venue.upkeepDueAt = Date.now() + 7 * 24 * 3600 * 1000;
  markDirty();
  return { ok: true, venue };
}

function renovate(kingdomId, payer, points) {
  const venue = ensureVenue(kingdomId);
  if (!venue) return { ok: false, reason: "no runway venue" };
  const pts = Math.max(1, Math.min(50, Number(points) || 10));
  const cost = pts * RENOVATE_COST_PER_POINT;
  if (!takeCoins(payer, cost)) return { ok: false, reason: "can't afford it" };
  venue.condition = Math.min(100, (venue.condition ?? 0) + pts);
  markDirty();
  return { ok: true, venue, cost };
}

// --- coin & material helpers --------------------------------------------------------

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

function giveCoins(player, amount) {
  // Canonical: adds(id, amount) with balance verification. inv.add takes an
  // Item instance, not (id, amount) — the old call threw inside ItemContainer.
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(COINS_ID) ?? 0;
    inv.adds?.(COINS_ID, amount);
    return (inv.getAmount?.(COINS_ID) ?? 0) === before + amount;
  } catch {
    return false;
  }
}

function takeMaterial(player, itemId, amount) {
  // Canonical: deleteNumber(id, amount) with balance verification. ItemContainer
  // has no inv.remove(id, amount).
  try {
    const inv = player?.getInventory?.();
    if (!inv) return false;
    const before = inv.getAmount?.(itemId) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(itemId, amount);
    return (inv.getAmount?.(itemId) ?? 0) === before - amount;
  } catch {
    return false;
  }
}

function giveMaterial(player, itemId, amount) {
  // Canonical: adds(id, amount) with balance verification. inv.add takes an
  // Item instance, not (id, amount) — the old call threw inside ItemContainer.
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(itemId) ?? 0;
    inv.adds?.(itemId, amount);
    return (inv.getAmount?.(itemId) ?? 0) === before + amount;
  } catch {
    return false;
  }
}

// --- describe ------------------------------------------------------------------------

function describe() {
  const st = load();
  return {
    designers: Object.keys(st.designers).length,
    houses: Object.keys(st.houses).length,
    collections: Object.keys(st.collections).length,
    shows: Object.keys(st.shows).length,
    ateliers: Object.keys(st.ateliers).length,
    venues: Object.keys(st.venues).length,
    models: Object.keys(st.models).length,
    reviews: st.reviews.length,
  };
}

module.exports = {
  // test seams
  _setSavePathForTests,
  resetForTests,
  // tuning
  COINS_ID,
  PAPYRUS_ID,
  CLOTH_ID,
  CLOTH_PER_PIECE,
  VENUE_BOOKING_FEE,
  MIN_CAST,
  SEASONS,
  THEMES,
  PIECE_GARMENTS,
  DEED_RUNWAY_SUPREME,
  DEED_COLLECTION_LAUREATE,
  // venues
  ensureVenue,
  venueFor,
  effectiveCapacity,
  runwayTileFor,
  // designers
  registerDesigner,
  isDesigner,
  designerFor,
  qualityForDesigner,
  // houses
  formHouse,
  houseFor,
  housesIn,
  joinHouse,
  houseForDesigner,
  houseLocation,
  tourTo,
  arriveHouse,
  // collections
  currentSeason,
  createCollection,
  collectionFor,
  collectionsIn,
  // casting
  registerModel,
  isModel,
  castModel,
  // shows
  bookShow,
  showFor,
  upcomingShows,
  finishedUnsettledShows,
  buyTicket,
  trendAffinityFor,
  settleShow,
  reviewsFor,
  // ateliers
  openAtelier,
  atelierFor,
  stockAtelier,
  buyFromAtelier,
  ateliersIn,
  // fame
  deedsForDesigner,
  // upkeep
  payUpkeep,
  decayVenue,
  renovate,
  // coins/materials
  takeCoins,
  giveCoins,
  takeMaterial,
  giveMaterial,
  // persistence
  load,
  save,
  describe,
};
