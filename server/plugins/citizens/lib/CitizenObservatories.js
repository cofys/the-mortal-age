"use strict";

/**
 * CitizenObservatories — the data tier for public observatory operations.
 *
 * Complements (does not duplicate):
 *   - CitizenAstronomy owns: the astronomer profession registry, observatory
 *     DATA records (kingdomId -> tile), star charts (persistent records with
 *     real navigation bonuses read by CitizenTravel), celestial events
 *     (deterministic schedule + real game effects), and astrology omens.
 *     This READS those records (observatory tiles, active events, charts for
 *     sale) but never reimplements them.
 *   - CitizenObserve (brain) owns: astronomers walking to the observatory at
 *     night to OBSERVE and create charts. This never creates charts; it hosts
 *     VISITORS who look through the telescope.
 *   - CitizenScience owns: astronomy science experiments. This never does
 *     science.
 *   - CitizenDayNightLife owns: stargazing FLAVOR lines. This never does
 *     flavor; every sighting is derived from real state (active event +
 *     deterministic date math).
 *
 * What it does (data tier, free — read by the slow tick and the brain):
 *   - Public visits: players visit the kingdom observatory at NIGHT (daytime
 *     is an honest closed-door). Entry is 10 real coins from the visitor's
 *     inventory; fees go to the observatory fund.
 *   - Telescope viewing: what a visitor sees is REAL — the currently active
 *     celestial event (defensive read of CitizenAstronomy.activeEventFor)
 *     plus deterministic sky objects from date math (planets, moon phase,
 *     zodiac constellation). Sightings are recorded per player.
 *   - Chart shop: observatories sell COPIES of the astronomers' real charts
 *     (read from CitizenAstronomy.chartsFor). Copies are collectible records
 *     the buyer can view any time; owning 3+ earns a reputation deed. Real
 *     coins move to the observatory fund; honest failure when broke or when
 *     no charts exist.
 *   - Guided tours: registered astronomers schedule tours (1h notice, 30 min
 *     duration). Players join; the tour is announced.
 *   - Viewing parties: when a celestial event is active, the observatory
 *     hosts a viewing party — a social gathering players join. The EVENT
 *     effects stay in CitizenAstronomy; the party is the venue.
 *   - Player hosts: real players can host their own stargazing gatherings.
 *
 * What it does NOT do:
 *   - No ticking here. Tour scheduling, party hosting, and announcements
 *     live in lib/CitizenObservatoriesLife.js.
 *   - No LLM. Sky descriptions are template frames filled from real data.
 *   - No invented items, coins, or geography: every fee moves real coins
 *     through real inventories; observatory tiles come from CitizenAstronomy
 *     (which gets them from CitizenSites) — this never invents tiles.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-observatories.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-observatories.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------
const ENTRY_FEE = 10; // coins per visit
const CHART_BASE_PRICE = 50; // + quality * CHART_PRICE_PER_QUALITY
const CHART_PRICE_PER_QUALITY = 10;
const TOUR_NOTICE_MS = 60 * 60 * 1000; // 1h notice before a tour
const TOUR_DURATION_MS = 30 * 60 * 1000; // 30 min tours
const PARTY_DURATION_MS = 2 * 60 * 60 * 1000; // 2h viewing parties
const MAX_TOUR_ATTENDEES = 12;

const KINGDOM_IDS = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"];

// Deterministic sky: planets visible in fixed month windows (0 = January).
const PLANETS = Object.freeze([
  Object.freeze({ name: "Saturn", months: [0, 1, 11] }),
  Object.freeze({ name: "Jupiter", months: [2, 3, 4] }),
  Object.freeze({ name: "Mars", months: [5, 6] }),
  Object.freeze({ name: "Venus", months: [7, 8] }),
  Object.freeze({ name: "Mercury", months: [9, 10] }),
]);

const ZODIAC = Object.freeze([
  "Capricorn", "Aquarius", "Pisces", "Aries", "Taurus", "Gemini",
  "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius",
]);

// --- state -------------------------------------------------------------------
function blankState() {
  return {
    visits: {}, // visitId -> { id, player, kingdomId, startedAt, endedAt }
    sightings: {}, // playerNorm -> { objects: [names], sawEvent: kind|null, at }
    chartCopies: {}, // playerNorm -> [chartId, ...]
    chartSales: {}, // saleId -> { id, chartId, buyer, price, at }
    tours: {}, // tourId -> { id, astronomer, kingdomId, scheduledFor, endsAt, attendees: [], status }
    toursLed: {}, // astronomerNorm -> count of completed tours
    parties: {}, // kingdomId -> { eventKind, startedAt, endsAt, attendees: [] }
    gatherings: {}, // gatheringId -> { id, host, kingdomId, at, attendees: [] }
    funds: {}, // kingdomId -> coins (entry fees + chart sales)
    seq: 0,
  };
}

let state = blankState();
let dirty = false;
let loaded = false;

function load() {
  if (loaded) return state;
  loaded = true;
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      state = Object.assign(blankState(), raw);
    }
  } catch {
    state = blankState();
  }
  return state;
}

function markDirty() {
  dirty = true;
}

function save() {
  if (!dirty) return false;
  load();
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(state, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  state = blankState();
  dirty = false;
  loaded = true;
}

function nextId(prefix) {
  load();
  state.seq += 1;
  markDirty();
  return `${prefix}_${state.seq}`;
}

function norm(name) {
  try {
    return normalizeName(name);
  } catch {
    return String(name || "").toLowerCase().trim();
  }
}

// --- defensive reads of the astronomy profession layer -----------------------

function astronomyApi() {
  try {
    return require("./CitizenAstronomy");
  } catch {
    return null;
  }
}

/** Observatory tile for a kingdom — owned by CitizenAstronomy, read here. */
function observatoryTile(kingdomId) {
  const Astro = astronomyApi();
  if (!Astro) return null;
  try {
    const obs = Astro.observatoryFor(kingdomId);
    return obs?.tile ?? null;
  } catch {
    return null;
  }
}

/** Night check: observatories open 21:00–05:00 local server time. */
function isNight(nowMs) {
  try {
    const DayNight = require("./CitizenDayNight");
    if (typeof DayNight.isNight === "function") return !!DayNight.isNight(nowMs);
  } catch { /* fall through */ }
  const h = new Date(nowMs).getHours();
  return h >= 21 || h < 5;
}

/**
 * What is visible in the sky right now — REAL state only:
 * the active celestial event (if any) plus deterministic sky objects
 * derived from the date. Never random, never invented.
 */
function whatIsVisible(kingdomId, nowMs = Date.now()) {
  const visible = { event: null, objects: [] };
  const Astro = astronomyApi();
  if (Astro) {
    try {
      const ev = Astro.activeEventFor(kingdomId, nowMs);
      if (ev) visible.event = ev.kind ?? ev;
    } catch { /* no event info — sky still has objects */ }
  }
  const d = new Date(nowMs);
  const month = d.getMonth();
  const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  for (const p of PLANETS) {
    if (p.months.includes(month)) visible.objects.push(p.name);
  }
  visible.objects.push(ZODIAC[month]); // zodiac constellation of the month
  // Moon phase from day of year — deterministic.
  const phase = dayOfYear % 29;
  visible.objects.push(phase < 7 ? "waxing moon" : phase < 15 ? "full moon" : phase < 22 ? "waning moon" : "new moon");
  if (!visible.event) visible.objects.push("the milky way");
  return visible;
}

function describeSky(kingdomId, nowMs = Date.now()) {
  const v = whatIsVisible(kingdomId, nowMs);
  const bits = [];
  if (v.event) {
    const label = String(v.event).replace(/_/g, " ");
    bits.push(`a ${label} fills the sky`);
  }
  if (v.objects.length) bits.push(v.objects.slice(0, 3).join(", "));
  return bits.length ? bits.join(" — ") : "cloud-covered sky";
}

// --- coin helpers ------------------------------------------------------------

function coinsOf(player) {
  try {
    const inv = player?.getInventory?.();
    const items = inv?.getItems?.() ?? inv?.items ?? [];
    let total = 0;
    for (const it of items) {
      const id = it?.id ?? it?.itemId;
      if (id === 995) total += it?.quantity ?? it?.amount ?? 0;
    }
    return total;
  } catch {
    return 0;
  }
}

function takeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (inv?.removeItem) {
      const removed = inv.removeItem(995, amount);
      return removed !== false;
    }
    // Fallback: manual scan.
    const items = inv?.getItems?.() ?? inv?.items ?? [];
    let need = amount;
    for (const it of items) {
      if (need <= 0) break;
      const id = it?.id ?? it?.itemId;
      if (id !== 995) continue;
      const qty = it?.quantity ?? it?.amount ?? 0;
      const take = Math.min(qty, need);
      if (typeof inv.removeItem === "function") inv.removeItem(995, take);
      else if ("quantity" in it) it.quantity -= take;
      else if ("amount" in it) it.amount -= take;
      need -= take;
    }
    return need <= 0;
  } catch {
    return false;
  }
}

function usernameOf(player) {
  try {
    if (typeof player === "string") return player;
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

// --- visits ------------------------------------------------------------------

/**
 * Begin a public visit. Night only, 10 real coins entry.
 * Returns { ok, visitId?, reason? } — honest failures, never throws.
 */
function beginVisit(player, kingdomId, nowMs = Date.now()) {
  load();
  const username = usernameOf(player);
  if (!username) return { ok: false, reason: "unknown-visitor" };
  if (!KINGDOM_IDS.includes(kingdomId)) return { ok: false, reason: "no-such-kingdom" };
  if (!observatoryTile(kingdomId)) return { ok: false, reason: "no-observatory" };
  if (!isNight(nowMs)) return { ok: false, reason: "closed-daytime" };
  if (coinsOf(player) < ENTRY_FEE) return { ok: false, reason: "cannot-afford" };
  if (!takeCoins(player, ENTRY_FEE)) return { ok: false, reason: "payment-failed" };
  const id = nextId("visit");
  state.visits[id] = { id, player: username, kingdomId, startedAt: nowMs, endedAt: 0 };
  state.funds[kingdomId] = (state.funds[kingdomId] ?? 0) + ENTRY_FEE;
  markDirty();
  return { ok: true, visitId: id };
}

function endVisit(visitId, nowMs = Date.now()) {
  load();
  const v = state.visits[visitId];
  if (!v || v.endedAt) return false;
  v.endedAt = nowMs;
  markDirty();
  return true;
}

/** Record what a visitor saw through the telescope. */
function recordSighting(player, kingdomId, nowMs = Date.now()) {
  load();
  const username = usernameOf(player);
  if (!username) return null;
  const v = whatIsVisible(kingdomId, nowMs);
  state.sightings[norm(username)] = { objects: v.objects, sawEvent: v.event, at: nowMs };
  markDirty();
  return v;
}

function sightingFor(player) {
  load();
  return state.sightings[norm(usernameOf(player))] ?? null;
}

function fundFor(kingdomId) {
  load();
  return state.funds[kingdomId] ?? 0;
}

// --- chart shop --------------------------------------------------------------

/**
 * Charts available for sale — real charts from CitizenAstronomy with prices.
 * Copies are collectible records; the kingdom navigation bonus stays in
 * CitizenAstronomy (read by CitizenTravel) — this never reimplements it.
 */
function chartsForSale(kingdomId) {
  const Astro = astronomyApi();
  if (!Astro) return [];
  try {
    const charts = Astro.chartsFor(kingdomId) ?? [];
    return charts.map((c) => ({
      id: c.id,
      quality: c.quality,
      astronomer: c.astronomer,
      price: CHART_BASE_PRICE + (c.quality ?? 1) * CHART_PRICE_PER_QUALITY,
    }));
  } catch {
    return [];
  }
}

function chartPrice(chart) {
  return CHART_BASE_PRICE + (chart?.quality ?? 1) * CHART_PRICE_PER_QUALITY;
}

/**
 * Buy a copy of a real chart. Real coins to the observatory fund.
 * Honest failures: no such chart, cannot afford, payment failed.
 */
function buyChart(player, chartId, kingdomId, nowMs = Date.now()) {
  load();
  const username = usernameOf(player);
  if (!username) return { ok: false, reason: "unknown-buyer" };
  const forSale = chartsForSale(kingdomId);
  const chart = forSale.find((c) => c.id === chartId);
  if (!chart) return { ok: false, reason: "no-such-chart" };
  if (coinsOf(player) < chart.price) return { ok: false, reason: "cannot-afford" };
  if (!takeCoins(player, chart.price)) return { ok: false, reason: "payment-failed" };
  const key = norm(username);
  state.chartCopies[key] = state.chartCopies[key] ?? [];
  if (!state.chartCopies[key].includes(chartId)) state.chartCopies[key].push(chartId);
  const saleId = nextId("sale");
  state.chartSales[saleId] = { id: saleId, chartId, buyer: username, price: chart.price, at: nowMs };
  state.funds[kingdomId] = (state.funds[kingdomId] ?? 0) + chart.price;
  markDirty();
  // Award the chartcollector deed at 3 owned copies.
  if (state.chartCopies[key].length >= 3) {
    try {
      const Rep = require("./CitizenReputation");
      if (typeof Rep.awardDeed === "function") Rep.awardDeed(username, "chartcollector", nowMs);
    } catch { /* reputation is best-effort */ }
  }
  return { ok: true, saleId, chart };
}

/** Chart copies owned by a player — viewable collection. */
function chartCopiesFor(player) {
  load();
  const owned = state.chartCopies[norm(usernameOf(player))] ?? [];
  const Astro = astronomyApi();
  return owned.map((id) => {
    let detail = null;
    try {
      const all = [];
      for (const kid of KINGDOM_IDS) {
        for (const c of Astro.chartsFor(kid) ?? []) all.push(c);
      }
      detail = all.find((c) => c.id === id) ?? null;
    } catch { /* chart may have lapsed from the profession layer */ }
    return { id, quality: detail?.quality ?? null, astronomer: detail?.astronomer ?? "unknown" };
  });
}

// --- guided tours ------------------------------------------------------------

/**
 * Schedule a guided tour. Only registered astronomers (CitizenAstronomy)
 * may lead. 1h notice, 30 min duration.
 */
function scheduleTour(astronomerUsername, kingdomId, nowMs = Date.now()) {
  load();
  const Astro = astronomyApi();
  let isAstronomer = false;
  try {
    isAstronomer = !!Astro?.astronomerFor?.(astronomerUsername);
  } catch { /* not an astronomer */ }
  if (!isAstronomer) return { ok: false, reason: "not-an-astronomer" };
  if (!KINGDOM_IDS.includes(kingdomId)) return { ok: false, reason: "no-such-kingdom" };
  if (!observatoryTile(kingdomId)) return { ok: false, reason: "no-observatory" };
  const id = nextId("tour");
  state.tours[id] = {
    id,
    astronomer: astronomerUsername,
    kingdomId,
    scheduledFor: nowMs + TOUR_NOTICE_MS,
    endsAt: nowMs + TOUR_NOTICE_MS + TOUR_DURATION_MS,
    attendees: [],
    status: "scheduled",
  };
  markDirty();
  return { ok: true, tourId: id };
}

function joinTour(player, tourId, nowMs = Date.now()) {
  load();
  const t = state.tours[tourId];
  if (!t) return { ok: false, reason: "no-such-tour" };
  if (t.status === "done" || nowMs > t.endsAt) return { ok: false, reason: "tour-over" };
  const username = usernameOf(player);
  if (!username) return { ok: false, reason: "unknown-visitor" };
  if (t.attendees.length >= MAX_TOUR_ATTENDEES) return { ok: false, reason: "tour-full" };
  if (!t.attendees.includes(username)) {
    t.attendees.push(username);
    markDirty();
  }
  return { ok: true, tour: t };
}

function toursFor(kingdomId, nowMs = Date.now()) {
  load();
  return Object.values(state.tours).filter(
    (t) => t.kingdomId === kingdomId && t.status !== "done" && nowMs <= t.endsAt
  );
}

function liveTourFor(kingdomId, nowMs = Date.now()) {
  return toursFor(kingdomId, nowMs).find(
    (t) => nowMs >= t.scheduledFor && nowMs <= t.endsAt
  ) ?? null;
}

function closeTour(tourId, nowMs = Date.now()) {
  load();
  const t = state.tours[tourId];
  if (!t || t.status === "done") return false;
  t.status = "done";
  // Track tours led per astronomer for the tourguide deed.
  const key = norm(t.astronomer);
  state.toursLed[key] = (state.toursLed[key] ?? 0) + 1;
  markDirty();
  // Award the tourguide deed at 5 completed tours.
  if (state.toursLed[key] >= 5) {
    try {
      const Rep = require("./CitizenReputation");
      if (typeof Rep.awardDeed === "function") Rep.awardDeed(t.astronomer, "tourguide", nowMs);
    } catch { /* reputation is best-effort */ }
  }
  return true;
}

function toursLedBy(astronomerUsername) {
  load();
  return state.toursLed[norm(astronomerUsername)] ?? 0;
}

// --- viewing parties ---------------------------------------------------------

/**
 * Viewing parties are the SOCIAL venue for celestial events. The event
 * itself (schedule, effects) stays in CitizenAstronomy — this only hosts
 * the gathering while the event is active.
 */
function maybeStartParty(kingdomId, nowMs = Date.now()) {
  load();
  if (!KINGDOM_IDS.includes(kingdomId)) return null;
  const existing = state.parties[kingdomId];
  if (existing && nowMs < existing.endsAt) return existing;
  const Astro = astronomyApi();
  let ev = null;
  try {
    ev = Astro?.activeEventFor?.(kingdomId, nowMs) ?? null;
  } catch { /* no event info */ }
  if (!ev) return null;
  const kind = ev.kind ?? ev;
  const party = {
    eventKind: kind,
    startedAt: nowMs,
    endsAt: nowMs + PARTY_DURATION_MS,
    attendees: [],
  };
  state.parties[kingdomId] = party;
  markDirty();
  return party;
}

function partyFor(kingdomId, nowMs = Date.now()) {
  load();
  const p = state.parties[kingdomId];
  if (!p || nowMs >= p.endsAt) return null;
  return p;
}

function joinParty(player, kingdomId, nowMs = Date.now()) {
  load();
  const p = partyFor(kingdomId, nowMs);
  if (!p) return { ok: false, reason: "no-party" };
  const username = usernameOf(player);
  if (!username) return { ok: false, reason: "unknown-visitor" };
  if (!p.attendees.includes(username)) {
    p.attendees.push(username);
    markDirty();
  }
  return { ok: true, party: p };
}

// --- player-hosted gatherings ------------------------------------------------

function hostGathering(player, kingdomId, nowMs = Date.now()) {
  load();
  const username = usernameOf(player);
  if (!username) return { ok: false, reason: "unknown-host" };
  if (!KINGDOM_IDS.includes(kingdomId)) return { ok: false, reason: "no-such-kingdom" };
  if (!isNight(nowMs)) return { ok: false, reason: "closed-daytime" };
  const id = nextId("gathering");
  state.gatherings[id] = { id, host: username, kingdomId, at: nowMs, attendees: [username] };
  markDirty();
  return { ok: true, gatheringId: id };
}

function joinGathering(player, gatheringId) {
  load();
  const g = state.gatherings[gatheringId];
  if (!g) return { ok: false, reason: "no-such-gathering" };
  const username = usernameOf(player);
  if (!username) return { ok: false, reason: "unknown-visitor" };
  if (!g.attendees.includes(username)) {
    g.attendees.push(username);
    markDirty();
  }
  return { ok: true, gathering: g };
}

function gatheringsFor(kingdomId, nowMs = Date.now()) {
  load();
  const cutoff = nowMs - 4 * 60 * 60 * 1000; // gatherings last ~4h
  return Object.values(state.gatherings).filter(
    (g) => g.kingdomId === kingdomId && g.at >= cutoff
  );
}

// --- describe (chat) -----------------------------------------------------------

function describe(kingdomId, nowMs = Date.now()) {
  load();
  const tile = observatoryTile(kingdomId);
  if (!tile) return null;
  const tours = toursFor(kingdomId, nowMs);
  const party = partyFor(kingdomId, nowMs);
  const v = whatIsVisible(kingdomId, nowMs);
  return {
    open: isNight(nowMs),
    entryFee: ENTRY_FEE,
    sky: describeSky(kingdomId, nowMs),
    eventActive: v.event,
    upcomingTours: tours.length,
    partyLive: !!party,
    fund: fundFor(kingdomId),
  };
}

module.exports = {
  // tuning (exported for tests)
  ENTRY_FEE,
  CHART_BASE_PRICE,
  CHART_PRICE_PER_QUALITY,
  MAX_TOUR_ATTENDEES,
  KINGDOM_IDS,
  PLANETS,
  ZODIAC,
  // sky
  isNight,
  whatIsVisible,
  describeSky,
  observatoryTile,
  // visits
  beginVisit,
  endVisit,
  recordSighting,
  sightingFor,
  fundFor,
  // chart shop
  chartsForSale,
  chartPrice,
  buyChart,
  chartCopiesFor,
  // tours
  scheduleTour,
  joinTour,
  toursFor,
  liveTourFor,
  closeTour,
  toursLedBy,
  // parties
  maybeStartParty,
  partyFor,
  joinParty,
  // gatherings
  hostGathering,
  joinGathering,
  gatheringsFor,
  // chat
  describe,
  // persistence
  load,
  save,
  resetForTests,
  _setSavePathForTests,
};
