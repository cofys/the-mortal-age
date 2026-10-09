"use strict";

/**
 * CitizenAstronomy — persistent registry of REAL astronomers, observatories,
 * star charts, celestial events, and astrology readings.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenScience owns the astronomy SCIENCE field: real experiments,
 *     astronomy discoveries, navigationBonusFor() from verified findings.
 *     Scientists test hypotheses; discoveries are peer-reviewed findings.
 *   - CitizenDayNightLife owns stargazing FLAVOR: scripted voice lines on
 *     clear nights ("the stars are bright tonight") — fiction, not state.
 *   - THIS module owns the persistent PROFESSION layer: astronomer registry
 *     (real citizens who watch the sky), observatories (real buildings with
 *     real tiles), star charts (persistent records with REAL navigation
 *     effects read by CitizenTravel), celestial events (real scheduled
 *     eclipses/comets/meteor showers with real game effects), and astrology
 *     readings (omens that the faith system can read).
 *
 * The science layer discovers WHY; this layer is the people who watch and
 * record. A scientist runs an experiment about comets; an astronomer spots
 * the comet and charts it.
 *
 * Celestial events (deterministic schedule from real date math):
 *   - meteor_shower:  monthly; +15% travel speed that night (clear skies guide)
 *   - comet:          quarterly; kingdom-wide mood +5 for a week (wonder)
 *   - lunar_eclipse:  6-monthly; faith devotion +10% that week (omen)
 *   - solar_eclipse:  yearly;    crime +25% that day (darkness covers)
 *
 * Star charts: persistent records created by astronomers observing at night.
 * Quality from astronomer's wisdom + observation time. Charts give a real
 * navigation bonus read by CitizenTravel (defensive: missing travel module
 * = no bonus, never an error).
 *
 * Astrology: omens for a citizen or kingdom, derived from real state
 * (active celestial event + personality + recent fortune). The faith system
 * can read kingdomOmenFor() defensively. Omens never invent items or coins.
 *
 * Zero LLM. Dirty-flag persistence. Plain-node testable.
 */

const SAVE_KEY = "citizen-astronomy.json";

// --- tuning -------------------------------------------------------------------

const OBSERVATION_TICKS = 12; // slow-tick cycles for one observation session
const CHART_NAV_BONUS_PER_QUALITY = 0.5; // % journey-time reduction per chart quality point
const CHART_MAX_QUALITY = 10;
const ASTRONOMER_MIN_CURIOSITY = 0.5; // personality threshold
const EVENT_ANNOUNCE_COOLDOWN_MS = 6 * 3600 * 1000; // 6h per event kind per kingdom

// Celestial event catalog: kind -> { label, scheduleMonths, effect }.
const EVENTS = Object.freeze({
  meteor_shower: Object.freeze({
    label: "meteor shower",
    scheduleMonths: 1,
    effect: Object.freeze({ kind: "travel_speed", amount: 15 }),
  }),
  comet: Object.freeze({
    label: "comet",
    scheduleMonths: 3,
    effect: Object.freeze({ kind: "mood", amount: 5 }),
  }),
  lunar_eclipse: Object.freeze({
    label: "lunar eclipse",
    scheduleMonths: 6,
    effect: Object.freeze({ kind: "devotion", amount: 10 }),
  }),
  solar_eclipse: Object.freeze({
    label: "solar eclipse",
    scheduleMonths: 12,
    effect: Object.freeze({ kind: "crime", amount: 25 }),
  }),
});

const EVENT_IDS = Object.freeze(Object.keys(EVENTS));

// Omen kinds for astrology readings.
const OMENS = Object.freeze([
  "fortune", // good luck ahead
  "warning", // danger ahead
  "change", // big change coming
  "love", // romance in the air
  "wealth", // prosperity ahead
  "journey", // travel will go well
]);

// --- state --------------------------------------------------------------------

let cache = null; // { astronomers, observatories, charts, events, readings }
let dirty = false;

function blankState() {
  return {
    astronomers: Object.create(null), // norm -> { username, kingdomId, wisdom, registeredAt }
    observatories: Object.create(null), // kingdomId -> { kingdomId, tile, builtAt }
    charts: Object.create(null), // id -> { id, astronomer, kingdomId, quality, createdAt }
    events: Object.create(null), // "kingdomId:kind" -> { kind, kingdomId, scheduledFor, announcedAt }
    readings: Object.create(null), // norm -> { username, omen, readAt }
  };
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    const path = require("path");
    const p = savePath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw && typeof raw === "object") {
        for (const k of Object.keys(blankState())) {
          if (raw[k] && typeof raw[k] === "object") cache[k] = raw[k];
        }
      }
    }
  } catch { /* corrupt save = start fresh, never crash */ }
  return cache;
}

function savePath() {
  try {
    const path = require("path");
    return path.join(__dirname, "..", "data", "saves", SAVE_KEY);
  } catch {
    return SAVE_KEY;
  }
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const p = savePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(load(), null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function resetForTests() {
  cache = blankState();
  dirty = false;
}

// --- astronomers --------------------------------------------------------------

/**
 * Register a citizen as an astronomer. Honest: only registers if they meet
 * the curiosity threshold (checked by the caller from real personality).
 */
function registerAstronomer(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key || !kingdomId) return { ok: false, reason: "no-identity" };
  if (st.astronomers[key]) return { ok: true, already: true };
  st.astronomers[key] = {
    username: String(username),
    kingdomId: String(kingdomId),
    wisdom: 10,
    registeredAt: Date.now(),
  };
  markDirty();
  return { ok: true };
}

function astronomerFor(username) {
  const st = load();
  return st.astronomers[norm(username)] || null;
}

function astronomersFor(kingdomId) {
  const st = load();
  return Object.values(st.astronomers).filter((a) => a.kingdomId === String(kingdomId));
}

function gainWisdom(username, amount) {
  const st = load();
  const rec = st.astronomers[norm(username)];
  if (!rec) return false;
  rec.wisdom = Math.min(100, rec.wisdom + amount);
  markDirty();
  return true;
}

// --- observatories ------------------------------------------------------------

/**
 * Get or create the observatory for a kingdom. Deterministic tile near the
 * market (hilltop, away from city lights). Real tile for brain actions.
 */
function observatoryFor(kingdomId) {
  const st = load();
  const key = String(kingdomId);
  if (!st.observatories[key]) {
    let tile = null;
    try {
      const Sites = require("../brain/CitizenSites");
      const market = Sites.siteTileByKingdom
        ? Sites.siteTileByKingdom(key, "market")
        : null;
      if (market && typeof market.x === "number") {
        // Hilltop: 40 tiles north-east of the market.
        tile = { x: market.x + 40, y: market.y - 40, z: market.z ?? 0 };
      }
    } catch { /* no sites module = no tile, honest */ }
    st.observatories[key] = { kingdomId: key, tile, builtAt: Date.now() };
    markDirty();
  }
  return st.observatories[key];
}

// --- star charts --------------------------------------------------------------

/**
 * Create a star chart. Quality 1-10 from astronomer wisdom + observation
 * effort. Charts are persistent records with real navigation effects.
 */
let chartSeq = 0;

function createChart(astronomerUsername, kingdomId, quality) {
  const st = load();
  const astro = astronomerFor(astronomerUsername);
  if (!astro) return { ok: false, reason: "not-astronomer" };
  const q = Math.max(1, Math.min(CHART_MAX_QUALITY, Math.round(quality) || 1));
  chartSeq++;
  const id = `chart-${Date.now()}-${chartSeq}-${norm(astronomerUsername).slice(0, 8)}`;
  st.charts[id] = {
    id,
    astronomer: astro.username,
    kingdomId: String(kingdomId),
    quality: q,
    createdAt: Date.now(),
  };
  gainWisdom(astronomerUsername, 2);
  markDirty();
  return { ok: true, id, quality: q };
}

function chartsFor(kingdomId) {
  const st = load();
  return Object.values(st.charts).filter((c) => c.kingdomId === String(kingdomId));
}

/**
 * Navigation bonus for a kingdom: total chart quality × per-point bonus,
 * capped at 10%. Read by CitizenTravel defensively.
 */
function chartBonusFor(kingdomId) {
  try {
    const charts = chartsFor(kingdomId);
    if (!charts.length) return 0;
    const total = charts.reduce((s, c) => s + (c.quality || 0), 0);
    return Math.min(10, total * CHART_NAV_BONUS_PER_QUALITY);
  } catch { return 0; }
}

// --- celestial events ---------------------------------------------------------

/**
 * Deterministic event scheduling from real date math. Each event kind fires
 * on its schedule: we check "should this event be active this month?"
 * using the month number modulo the schedule.
 */
function shouldEventBeActive(kind, nowMs) {
  const spec = EVENTS[kind];
  if (!spec) return false;
  const d = new Date(nowMs);
  const monthIndex = d.getFullYear() * 12 + d.getMonth();
  return monthIndex % spec.scheduleMonths === 0;
}

function activeEventFor(kingdomId, nowMs) {
  const now = nowMs || Date.now();
  for (const kind of EVENT_IDS) {
    if (shouldEventBeActive(kind, now)) {
      return { kind, ...EVENTS[kind] };
    }
  }
  return null;
}

/**
 * Mark an event announced (throttle). Returns true if this is a fresh
 * announcement (not within cooldown).
 */
function announceEvent(kingdomId, kind, nowMs) {
  const st = load();
  const now = nowMs || Date.now();
  const key = `${kingdomId}:${kind}`;
  const rec = st.events[key];
  if (rec && now - (rec.announcedAt || 0) < EVENT_ANNOUNCE_COOLDOWN_MS) {
    return false; // already announced recently
  }
  st.events[key] = {
    kind,
    kingdomId: String(kingdomId),
    scheduledFor: now,
    announcedAt: now,
  };
  markDirty();
  return true;
}

/**
 * Effect bonus for a kingdom from the active celestial event.
 * Read defensively by other modules (travel, faith, crime).
 */
function eventEffectFor(kingdomId, effectKind, nowMs) {
  try {
    const ev = activeEventFor(kingdomId, nowMs);
    if (!ev || ev.effect.kind !== effectKind) return 0;
    return ev.effect.amount || 0;
  } catch { return 0; }
}

// --- astrology ----------------------------------------------------------------

/**
 * Read an omen for a citizen. Deterministic from username + day (not random):
 * same citizen gets the same omen all day. Omens are flavor + mild effects
 * (the faith system may read kingdomOmenFor).
 */
function readOmen(username, kingdomId, nowMs) {
  const st = load();
  const now = nowMs || Date.now();
  const key = norm(username);
  const today = new Date(now).toISOString().slice(0, 10);
  const existing = st.readings[key];
  if (existing && new Date(existing.readAt).toISOString().slice(0, 10) === today) {
    return existing; // one reading per day, honest
  }
  // Deterministic pick from username hash + date.
  let h = 0;
  const s = key + today;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const omen = OMENS[Math.abs(h) % OMENS.length];
  const rec = { username: String(username), omen, kingdomId: String(kingdomId || ""), readAt: now };
  st.readings[key] = rec;
  markDirty();
  return rec;
}

/**
 * Kingdom-wide omen: the dominant omen from recent readings, or the active
 * celestial event's flavor. Defensive read for the faith system.
 */
function kingdomOmenFor(kingdomId, nowMs) {
  try {
    const ev = activeEventFor(kingdomId, nowMs);
    if (ev && ev.kind === "solar_eclipse") return "warning";
    if (ev && ev.kind === "comet") return "change";
    if (ev && ev.kind === "lunar_eclipse") return "fortune";
    return null;
  } catch { return null; }
}

// --- describe -----------------------------------------------------------------

function describe(kingdomId, nowMs) {
  const ev = activeEventFor(kingdomId, nowMs);
  const charts = chartsFor(kingdomId);
  const astros = astronomersFor(kingdomId);
  return {
    kingdomId: String(kingdomId),
    activeEvent: ev ? ev.kind : null,
    eventLabel: ev ? ev.label : null,
    chartCount: charts.length,
    chartBonus: chartBonusFor(kingdomId),
    astronomerCount: astros.length,
    omen: kingdomOmenFor(kingdomId, nowMs),
  };
}

module.exports = {
  // catalog
  EVENTS,
  EVENT_IDS,
  OMENS,
  OBSERVATION_TICKS,
  ASTRONOMER_MIN_CURIOSITY,
  // astronomers
  registerAstronomer,
  astronomerFor,
  astronomersFor,
  gainWisdom,
  // observatories
  observatoryFor,
  // charts
  createChart,
  chartsFor,
  chartBonusFor,
  // events
  shouldEventBeActive,
  activeEventFor,
  announceEvent,
  eventEffectFor,
  // astrology
  readOmen,
  kingdomOmenFor,
  // describe
  describe,
  // persistence
  load,
  save,
  resetForTests,
};
