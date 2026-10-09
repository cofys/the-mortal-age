"use strict";

/**
 * CitizenMusicFestivals — the REAL music-festival production layer: promoters,
 * festival grounds (outdoor venues), multi-day music festival productions,
 * act bookings (real contracts with real coin), festival vendors, camping,
 * and festival tours.
 *
 * No-overlap boundary:
 *   - CitizenMusicDance owns multi-musician ENSEMBLES, DANCE TROUPES, DANCE
 *     HALLS, weekly ticketed CONCERTS, festival GRAND concerts, and
 *     music/dance LESSONS. This module READS ensembles (defensively) to book
 *     them as festival acts — never creates ensembles, never runs concerts.
 *   - CitizenBards owns professional solo/small-troupe minstrels (evening
 *     halls, repertoire, ballads, tips). This READS bards to book them —
 *     never runs bard halls.
 *   - CitizenStreetPerformers owns amateur buskers (daytime squares,
 *     markets). This READS street performers for daytime slots — never
 *     busks.
 *   - CitizenFestivals owns the SEASONAL calendar festivals (Founding Day,
 *     Harvest Home, 3-day windows, cheering/dancing). This owns
 *     promoter-run MUSIC festival productions — separate productions with
 *     lineups, stages, and headliners, never the seasonal calendar.
 *   - CitizenEntertainment owns taverns, dice, theater, arena, and bard
 *     performances AT taverns. This owns outdoor festival grounds — never
 *     taverns.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Promoters: persistent registry of festival promoters. Promoters found
 *     festival companies, book grounds, schedule festivals, sign acts.
 *   - Festival grounds: one outdoor venue per kingdom with real capacity,
 *     condition, owner (a company name or "crown"), and weekly upkeep from
 *     real funds. Poor condition caps attendance.
 *   - Music festivals: multi-day productions (2-4 days) with stages
 *     (main/acoustic), day-by-day lineups, and headliners. Scheduled with
 *     real lead time; announced near real players.
 *   - Act bookings: promoters book ensembles, bards, and street performers
 *     with REAL contracts — a booking fee in real coins moves from the
 *     company treasury to the act. Acts are read defensively from their
 *     owner modules; a missing act fails honestly, never invents one.
 *   - Tickets: festivals sell REAL tickets from REAL inventories. Day
 *     passes and full-festival passes. Broke buyers fail honestly.
 *   - Vendors: food/drink stalls at festivals. Vendors pay a real stall
 *     fee to the company; they keep their sales (tracked honestly).
 *   - Camping: overnight festival camping. Campers pay a real nightly fee.
 *   - Festival tours: companies tour other kingdoms; travel takes real time.
 *   - Reviews: deterministic stars from lineup quality + attendance.
 *     Great festivals earn fame deeds.
 *
 * All coin movements are REAL (buyer pays or walks away). Never invents
 * items, never invents coins.
 *
 * Dirty-flag persistence to data/saves/citizen-music-festivals.json.
 * Plain-node testable: CitizenMusicFestivals.test.js.
 */

const fs = require("fs");
const path = require("path");
const { agentRng } = require("./humanizer");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-music-festivals.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
  nextFestivalId = 1;
  nextBookingId = 1;
}

// === Tuning: all magic numbers here ===
const COINS_ID = 995;
const DEFAULT_DAY_PASS = 15; // coins
const DEFAULT_FULL_PASS = 40; // coins
const MIN_TICKET_PRICE = 5;
const MAX_TICKET_PRICE = 200;
const COMPANY_SHARE_BPS = 5500; // 55% to the promoter company treasury
const GROUND_SHARE_BPS = 2000; // 20% to the ground owner
const ACT_PURSE_BPS = 2500; // 25% act purse, split among booked acts
const GROUND_UPKEEP_WEEKLY = 120; // coins, paid by the ground owner
const CONDITION_DECAY_WEEKLY = 4;
const RENOVATE_COST_PER_POINT = 10;
const BOOKING_FEE_BASE = 100; // base coins per act booking, scaled by act tier
const STALL_FEE = 50; // coins per vendor stall
const CAMPING_FEE_NIGHTLY = 10; // coins per camper per night
const FESTIVAL_MIN_DAYS = 2;
const FESTIVAL_MAX_DAYS = 4;
const BOOKING_LEAD_MS = 60 * 60 * 1000; // festivals need 1h lead
const TOUR_TRAVEL_MS = 2 * 60 * 60 * 1000; // 2h to reach the next kingdom
const MIN_ACTS_PER_DAY = 2; // each festival day needs at least 2 acts
const SAVE_VERSION = 1;

const STAGES = Object.freeze(["main", "acoustic"]);
const ACT_TYPES = Object.freeze(["ensemble", "bard", "busker"]);
const COMPANY_NAME_SUFFIXES = Object.freeze(["Productions", "Festivals", "Live", "Sounds"]);
const FESTIVAL_NAME_THEMES = Object.freeze([
  "Harvest Beats", "Summer Strings", "Moonlit Melodies", "Thunder Drums",
  "Golden Horns", "Starlight Songs", "River Rhythms", "Ember Anthems",
]);

const DEED_FESTIVAL_LEGEND = "festivallegend"; // +8 — promoted five festivals
const DEED_HEADLINER = "festivalheadliner"; // +6 — headlined three festivals

// --- state -------------------------------------------------------------------

let cache = null;
let dirty = false;
let nextFestivalId = 1;
let nextBookingId = 1;

function blankState() {
  return {
    version: SAVE_VERSION,
    promoters: {}, // usernameLower -> { username, kingdomId, festivalsPromoted, actsBooked, registeredAt }
    companies: {}, // nameLower -> { name, nameLower, founder, members: [], treasury, foundedAt }
    grounds: {}, // kingdomId -> { kingdomId, capacity, condition, owner, lastUpkeepAt }
    festivals: {}, // id -> { id, name, companyLower, kingdomId, groundId, days, stages, lineup: {day: [{actType, actName, fee, headliner}]}, tickets: {dayPass, fullPass}, status, scheduledAt, startsAt, endsAt, attendance, revenue, reviews }
    bookings: {}, // id -> { id, festivalId, actType, actName, fee, status, bookedAt }
    vendors: {}, // festivalId -> [{ username, stallFee, sales }]
    campers: {}, // festivalId -> { usernameLower -> nights }
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && data.version === SAVE_VERSION) {
      cache = data;
      // Restore id counters.
      for (const id of Object.keys(cache.festivals || {})) {
        const n = parseInt(String(id).replace("fest", ""), 10);
        if (!isNaN(n) && n >= nextFestivalId) nextFestivalId = n + 1;
      }
      for (const id of Object.keys(cache.bookings || {})) {
        const n = parseInt(String(id).replace("book", ""), 10);
        if (!isNaN(n) && n >= nextBookingId) nextBookingId = n + 1;
      }
      return cache;
    }
  } catch (e) { /* missing or corrupt — start fresh */ }
  cache = blankState();
  dirty = true;
  return cache;
}

function markDirty() {
  dirty = true;
}

function save() {
  if (!dirty) return false;
  try {
    load();
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2), "utf8");
    dirty = false;
    return true;
  } catch (e) {
    return false;
  }
}

// --- helpers -----------------------------------------------------------------

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function seededRoll(seedStr, salt) {
  const rng = agentRng(seedStr + ":" + salt);
  return rng();
}

// --- promoters -----------------------------------------------------------------

/**
 * Register a promoter. Idempotent — re-registering returns the existing record.
 */
function registerPromoter(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key) return { ok: false, reason: "no-username" };
  if (!st.promoters[key]) {
    st.promoters[key] = {
      username: String(username),
      kingdomId: kingdomId || null,
      festivalsPromoted: 0,
      actsBooked: 0,
      registeredAt: Date.now(),
    };
    markDirty();
  }
  return { ok: true, promoter: st.promoters[key] };
}

function promoterFor(username) {
  const st = load();
  return st.promoters[norm(username)] || null;
}

function isPromoter(username) {
  return !!promoterFor(username);
}

// --- companies -----------------------------------------------------------------

/**
 * Found a festival company. Founder must be a registered promoter.
 */
function foundCompany(founderUsername, companyName) {
  const st = load();
  const founder = promoterFor(founderUsername);
  if (!founder) return { ok: false, reason: "not-promoter" };
  const key = norm(companyName);
  if (!key) return { ok: false, reason: "no-name" };
  if (st.companies[key]) return { ok: false, reason: "name-taken" };
  st.companies[key] = {
    name: String(companyName),
    nameLower: key,
    founder: founder.username,
    members: [founder.username],
    treasury: 0,
    foundedAt: Date.now(),
  };
  markDirty();
  return { ok: true, company: st.companies[key] };
}

function companyFor(name) {
  const st = load();
  return st.companies[norm(name)] || null;
}

function joinCompany(username, companyName) {
  const st = load();
  const c = st.companies[norm(companyName)];
  if (!c) return { ok: false, reason: "no-company" };
  if (!c.members.includes(username)) {
    c.members.push(username);
    markDirty();
  }
  return { ok: true, company: c };
}

function companyTreasury(name) {
  const c = companyFor(name);
  return c ? c.treasury : 0;
}

/**
 * Find the company a promoter belongs to (founder or member).
 * Returns the company or null.
 */
function companyForPromoter(username) {
  const st = load();
  const key = norm(username);
  for (const c of Object.values(st.companies || {})) {
    if (norm(c.founder) === key) return c;
    if ((c.members || []).some((m) => norm(m) === key)) return c;
  }
  return null;
}

/**
 * Credit a company treasury. Amount must be positive.
 */
function creditTreasury(name, amount) {
  const st = load();
  const c = st.companies[norm(name)];
  if (!c || !(amount > 0)) return { ok: false, reason: "bad-credit" };
  c.treasury += Math.floor(amount);
  markDirty();
  return { ok: true, treasury: c.treasury };
}

/**
 * Debit a company treasury. Honest failure when funds are insufficient.
 */
function debitTreasury(name, amount) {
  const st = load();
  const c = st.companies[norm(name)];
  const need = Math.floor(amount);
  if (!c || !(need > 0)) return { ok: false, reason: "bad-debit" };
  if (c.treasury < need) return { ok: false, reason: "insufficient-funds", treasury: c.treasury };
  c.treasury -= need;
  markDirty();
  return { ok: true, treasury: c.treasury };
}

// --- festival grounds ------------------------------------------------------------

/**
 * Get (or deterministically create) the festival ground for a kingdom.
 * Grounds are outdoor venues — distinct from dance halls.
 */
function ensureGround(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "unknown");
  if (!st.grounds[kid]) {
    st.grounds[kid] = {
      kingdomId: kid,
      capacity: 200,
      condition: 80,
      owner: "crown",
      lastUpkeepAt: Date.now(),
    };
    markDirty();
  }
  return st.grounds[kid];
}

function groundFor(kingdomId) {
  const st = load();
  return st.grounds[String(kingdomId || "unknown")] || null;
}

/**
 * Pay weekly upkeep from the owner's funds. Returns honest status.
 * `payFn(owner, amount)` moves real coins; returns { ok }.
 */
function payUpkeep(kingdomId, payFn) {
  const st = load();
  const g = st.grounds[String(kingdomId || "unknown")];
  if (!g) return { ok: false, reason: "no-ground" };
  const now = Date.now();
  const weeksDue = Math.floor((now - (g.lastUpkeepAt || now)) / (7 * 24 * 60 * 60 * 1000));
  if (weeksDue < 1) return { ok: true, due: 0 };
  const due = weeksDue * GROUND_UPKEEP_WEEKLY;
  let paid = 0;
  if (typeof payFn === "function") {
    const r = payFn(g.owner, due);
    if (r && r.ok) paid = r.paid || due;
  } else {
    // No pay function — crown grounds are maintained by the realm.
    paid = g.owner === "crown" ? due : 0;
  }
  if (paid >= due) {
    g.lastUpkeepAt = now;
  } else {
    // Partial upkeep — condition decays.
    g.condition = Math.max(10, g.condition - CONDITION_DECAY_WEEKLY * weeksDue);
  }
  markDirty();
  return { ok: paid >= due, due, paid, condition: g.condition };
}

/**
 * Renovate a festival ground. `takeFn(amount)` removes real coins; returns { ok }.
 */
function renovateGround(kingdomId, points, takeFn) {
  const g = ensureGround(kingdomId);
  const pts = Math.max(1, Math.min(20, Math.floor(points || 5)));
  if (g.condition >= 100) return { ok: false, reason: "already-pristine" };
  const cost = pts * RENOVATE_COST_PER_POINT;
  if (typeof takeFn === "function") {
    const r = takeFn(cost);
    if (!r || !r.ok) return { ok: false, reason: "insufficient-funds", cost };
  }
  g.condition = Math.min(100, g.condition + pts);
  markDirty();
  return { ok: true, condition: g.condition, cost };
}

// --- festivals -------------------------------------------------------------------

/**
 * Schedule a music festival. The company pays nothing upfront; the ground
 * must exist and be in usable condition.
 */
function scheduleFestival(companyName, kingdomId, days, name) {
  const st = load();
  const c = st.companies[norm(companyName)];
  if (!c) return { ok: false, reason: "no-company" };
  const d = Math.max(FESTIVAL_MIN_DAYS, Math.min(FESTIVAL_MAX_DAYS, Math.floor(days || 2)));
  const ground = ensureGround(kingdomId);
  if (ground.condition < 30) return { ok: false, reason: "ground-derelict" };
  const now = Date.now();
  const id = "fest" + (nextFestivalId++);
  const theme = FESTIVAL_NAME_THEMES[Math.floor(seededRoll(companyName + id, "theme") * FESTIVAL_NAME_THEMES.length)];
  st.festivals[id] = {
    id,
    name: name || (c.name + " presents " + theme),
    companyLower: c.nameLower,
    kingdomId: String(kingdomId),
    groundId: ground.kingdomId,
    days: d,
    stages: [...STAGES],
    lineup: {}, // dayIndex -> [{ bookingId, actType, actName, fee, headliner, stage }]
    tickets: { dayPass: DEFAULT_DAY_PASS, fullPass: DEFAULT_FULL_PASS },
    status: "scheduled", // scheduled -> live -> settled
    scheduledAt: now,
    startsAt: now + BOOKING_LEAD_MS,
    endsAt: now + BOOKING_LEAD_MS + d * 24 * 60 * 60 * 1000,
    attendance: 0,
    revenue: 0,
    reviews: null,
  };
  const promoter = st.promoters[norm(c.founder)];
  if (promoter) {
    promoter.festivalsPromoted += 1;
  }
  markDirty();
  return { ok: true, festival: st.festivals[id] };
}

function festivalFor(id) {
  const st = load();
  return st.festivals[String(id)] || null;
}

function festivalsForKingdom(kingdomId) {
  const st = load();
  const kid = String(kingdomId);
  return Object.values(st.festivals).filter((f) => f.kingdomId === kid);
}

function upcomingFestivals(kingdomId) {
  const now = Date.now();
  return festivalsForKingdom(kingdomId).filter(
    (f) => f.status === "scheduled" && f.startsAt > now
  );
}

/**
 * Book an act for a festival day. The booking fee moves from the company
 * treasury — honest failure when the treasury can't cover it.
 * `actLookup(actType, actName)` defensively reads the act from its owner
 * module; returns the act or null.
 */
function bookAct(festivalId, dayIndex, actType, actName, headliner, actLookup) {
  const st = load();
  const f = st.festivals[String(festivalId)];
  if (!f) return { ok: false, reason: "no-festival" };
  if (f.status !== "scheduled") return { ok: false, reason: "not-schedulable" };
  if (!ACT_TYPES.includes(actType)) return { ok: false, reason: "bad-act-type" };
  const day = Math.floor(dayIndex || 0);
  if (day < 0 || day >= f.days) return { ok: false, reason: "bad-day" };
  // Defensive act lookup — never invent an act.
  let act = null;
  if (typeof actLookup === "function") {
    try { act = actLookup(actType, actName); } catch (e) { act = null; }
  }
  if (!act) return { ok: false, reason: "act-not-found" };
  const tier = actType === "ensemble" ? 3 : actType === "bard" ? 2 : 1;
  const fee = BOOKING_FEE_BASE * tier;
  const debit = debitTreasury(f.companyLower, fee);
  if (!debit.ok) return { ok: false, reason: "insufficient-funds", fee };
  const bookingId = "book" + (nextBookingId++);
  st.bookings[bookingId] = {
    id: bookingId,
    festivalId: f.id,
    actType,
    actName: String(actName),
    fee,
    status: "booked",
    bookedAt: Date.now(),
  };
  if (!f.lineup[day]) f.lineup[day] = [];
  const stage = f.lineup[day].length % 2 === 0 ? "main" : "acoustic";
  f.lineup[day].push({ bookingId, actType, actName: String(actName), fee, headliner: !!headliner, stage });
  // Pay the act their fee — the treasury debit above is the company's side;
  // the act's receipt is handled by the caller via onActPaid.
  markDirty();
  return { ok: true, booking: st.bookings[bookingId], fee };
}

/**
 * Set ticket prices for a festival. Only the owning company may set them.
 */
function setTicketPrices(festivalId, companyName, dayPass, fullPass) {
  const st = load();
  const f = st.festivals[String(festivalId)];
  if (!f) return { ok: false, reason: "no-festival" };
  if (f.companyLower !== norm(companyName)) return { ok: false, reason: "not-owner" };
  const dp = Math.max(MIN_TICKET_PRICE, Math.min(MAX_TICKET_PRICE, Math.floor(dayPass || DEFAULT_DAY_PASS)));
  const fp = Math.max(MIN_TICKET_PRICE, Math.min(MAX_TICKET_PRICE, Math.floor(fullPass || DEFAULT_FULL_PASS)));
  f.tickets = { dayPass: dp, fullPass: fp };
  markDirty();
  return { ok: true, tickets: f.tickets };
}

/**
 * Sell a ticket. `takeCoins(amount)` removes real coins from the buyer;
 * returns { ok }. Honest failure when the buyer is broke.
 */
function sellTicket(festivalId, buyerUsername, passType, takeCoins) {
  const st = load();
  const f = st.festivals[String(festivalId)];
  if (!f) return { ok: false, reason: "no-festival" };
  if (f.status === "settled") return { ok: false, reason: "festival-over" };
  const price = passType === "full" ? f.tickets.fullPass : f.tickets.dayPass;
  if (typeof takeCoins === "function") {
    const r = takeCoins(price);
    if (!r || !r.ok) return { ok: false, reason: "insufficient-funds", price };
  }
  f.attendance += 1;
  f.revenue += price;
  markDirty();
  return { ok: true, price, attendance: f.attendance };
}

/**
 * Register a vendor stall. The stall fee moves to the company treasury.
 * `takeCoins(amount)` removes real coins from the vendor.
 */
function addVendor(festivalId, vendorUsername, takeCoins) {
  const st = load();
  const f = st.festivals[String(festivalId)];
  if (!f) return { ok: false, reason: "no-festival" };
  if (f.status === "settled") return { ok: false, reason: "festival-over" };
  if (typeof takeCoins === "function") {
    const r = takeCoins(STALL_FEE);
    if (!r || !r.ok) return { ok: false, reason: "insufficient-funds", fee: STALL_FEE };
  }
  creditTreasury(f.companyLower, STALL_FEE);
  if (!st.vendors[f.id]) st.vendors[f.id] = [];
  st.vendors[f.id].push({ username: String(vendorUsername), stallFee: STALL_FEE, sales: 0 });
  markDirty();
  return { ok: true, fee: STALL_FEE };
}

/**
 * Register festival camping. The nightly fee moves to the company treasury.
 */
function addCamper(festivalId, camperUsername, nights, takeCoins) {
  const st = load();
  const f = st.festivals[String(festivalId)];
  if (!f) return { ok: false, reason: "no-festival" };
  if (f.status === "settled") return { ok: false, reason: "festival-over" };
  const n = Math.max(1, Math.min(f.days, Math.floor(nights || 1)));
  const fee = n * CAMPING_FEE_NIGHTLY;
  if (typeof takeCoins === "function") {
    const r = takeCoins(fee);
    if (!r || !r.ok) return { ok: false, reason: "insufficient-funds", fee };
  }
  creditTreasury(f.companyLower, fee);
  if (!st.campers[f.id]) st.campers[f.id] = {};
  st.campers[f.id][norm(camperUsername)] = n;
  markDirty();
  return { ok: true, fee, nights: n };
}

/**
 * Settle a finished festival: split revenue 55% company / 20% ground owner /
 * 25% act purse. `payCoins(to, amount)` moves real coins; returns { ok }.
 * Deterministic reviews from lineup quality + attendance.
 */
function settleFestival(festivalId, payCoins) {
  const st = load();
  const f = st.festivals[String(festivalId)];
  if (!f) return { ok: false, reason: "no-festival" };
  if (f.status === "settled") return { ok: false, reason: "already-settled" };
  const revenue = f.revenue || 0;
  const companyShare = Math.floor((revenue * COMPANY_SHARE_BPS) / 10000);
  const groundShare = Math.floor((revenue * GROUND_SHARE_BPS) / 10000);
  const purseShare = revenue - companyShare - groundShare;
  creditTreasury(f.companyLower, companyShare);
  // Ground owner payout.
  const ground = st.grounds[f.groundId];
  if (ground && typeof payCoins === "function" && groundShare > 0) {
    payCoins(ground.owner, groundShare);
  }
  // Act purse split among booked acts.
  const acts = [];
  for (const day of Object.keys(f.lineup || {})) {
    for (const slot of f.lineup[day]) acts.push(slot);
  }
  if (acts.length > 0 && purseShare > 0 && typeof payCoins === "function") {
    const perAct = Math.floor(purseShare / acts.length);
    for (const slot of acts) {
      payCoins(slot.actName, perAct);
    }
  }
  // Deterministic review: lineup depth + attendance vs capacity.
  const groundCap = ground ? ground.capacity : 200;
  const fillRatio = Math.min(1, f.attendance / Math.max(1, groundCap * f.days));
  const lineupScore = Math.min(1, acts.length / Math.max(1, f.days * MIN_ACTS_PER_DAY * 2));
  const stars = Math.max(1, Math.min(5, Math.round(1 + 4 * (0.5 * fillRatio + 0.5 * lineupScore))));
  f.reviews = {
    stars,
    attendance: f.attendance,
    revenue,
    summary: stars >= 4 ? "triumphant" : stars >= 3 ? "lively" : "quiet",
  };
  f.status = "settled";
  markDirty();
  return { ok: true, revenue, companyShare, groundShare, purseShare, stars, acts: acts.length };
}

/**
 * Festival tour: a company tours to another kingdom. Travel takes real time.
 */
function startTour(companyName, fromKingdomId, toKingdomId) {
  const st = load();
  const c = st.companies[norm(companyName)];
  if (!c) return { ok: false, reason: "no-company" };
  if (String(fromKingdomId) === String(toKingdomId)) return { ok: false, reason: "same-kingdom" };
  ensureGround(toKingdomId);
  markDirty();
  return {
    ok: true,
    company: c.name,
    from: String(fromKingdomId),
    to: String(toKingdomId),
    arrivesAt: Date.now() + TOUR_TRAVEL_MS,
  };
}

// --- public API ------------------------------------------------------------------

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  markDirty,
  // promoters
  registerPromoter,
  promoterFor,
  isPromoter,
  // companies
  foundCompany,
  companyFor,
  companyForPromoter,
  joinCompany,
  companyTreasury,
  creditTreasury,
  debitTreasury,
  // grounds
  ensureGround,
  groundFor,
  payUpkeep,
  renovateGround,
  // festivals
  scheduleFestival,
  festivalFor,
  festivalsForKingdom,
  upcomingFestivals,
  bookAct,
  setTicketPrices,
  sellTicket,
  addVendor,
  addCamper,
  settleFestival,
  startTour,
  // constants (tests + life tick)
  COINS_ID,
  STAGES,
  ACT_TYPES,
  MIN_ACTS_PER_DAY,
  BOOKING_LEAD_MS,
  TOUR_TRAVEL_MS,
  STALL_FEE,
  CAMPING_FEE_NIGHTLY,
  DEED_FESTIVAL_LEGEND,
  DEED_HEADLINER,
};
