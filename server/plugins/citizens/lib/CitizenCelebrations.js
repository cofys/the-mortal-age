"use strict";

/**
 * CitizenCelebrations — advanced festival layer: planners, custom festivals,
 * parades, fireworks, and carnival booths.
 *
 * WHAT IT DOES (data tier, free):
 *   The celebration system sits ON TOP of the existing festival calendar.
 *   While CitizenFestivals owns the 5 annual calendar festivals,
 *   CitizenFestivalLife owns the merged calendar (seasonal + religious +
 *   council weeks), and CitizenFestivalGames owns the 4 festival games,
 *   THIS module owns the PARTICIPATORY layer:
 *
 *   - Festival PLANNERS: organizer citizens (sociable, reputable) who
 *     plan custom celebrations. One head planner per kingdom.
 *   - CUSTOM festivals: citizen- or player-organized celebrations with
 *     a name, theme, date, and budget. Real coin funding.
 *   - PARADES: processions through the streets on festival days.
 *     Deterministic route: market -> main street -> temple -> market.
 *   - FIREWORKS: evening visual displays during festivals. Citizens
 *     gather and watch; planners fund them from the festival budget.
 *   - CARNIVAL booths: ring-toss, strength-test, fortune-telling.
 *     Real coin entry fees, real prizes.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Planners announce upcoming festivals in the streets. Parades march
 *   past with music and cheering. Fireworks light up the evening sky
 *   (announced via sayPublic). Carnival booths take real coins and pay
 *   real prizes. Players can organize their own festival (fund it, name
 *   it, pick the theme) — the planner runs it.
 *
 * Zero LLM: all scheduling is date math + honest state reads; visible
 * output is scripted sayPublic lines. The journal feeds the LLM mouth.
 *
 * No-overlap boundary:
 *   - CitizenFestivals owns: the 5 annual festival calendar (date math)
 *   - CitizenFestivalLife owns: merged calendar, anticipation, unrest relief
 *   - CitizenFestivalGames owns: wrestling/archery/pie-eating/dance games
 *   - THIS owns: planners, custom festivals, parades, fireworks, carnival
 *
 * Dirty-flag persistence to data/saves/citizen-celebrations.json.
 * Plain-node testable: CitizenCelebrations.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");

// === Tuning: all magic numbers here ===
const SAVE_PATH = "data/saves/citizen-celebrations.json";
const PLANNER_MIN_REPUTATION = 20; // reputation needed to become head planner
const PLANNER_MIN_SOCIAL = 50; // social score needed to organize
const CUSTOM_FESTIVAL_MIN_BUDGET = 500; // coins to fund a custom festival
const CUSTOM_FESTIVAL_DURATION_DAYS = 2; // custom festivals run 2 days
const PARADE_PARTICIPANTS = 12; // citizens in a parade procession
const FIREWORKS_COST = 200; // coins per fireworks show
const FIREWORKS_CROWD_RADIUS = 20; // tiles — crowd gathers within this
const BOOTH_ENTRY_FEE = 10; // coins per carnival game try
const BOOTH_PRIZE = 50; // coins for winning a carnival game
const BOOTH_WIN_CHANCE = 0.3; // 30% win rate (house edge)
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-announce at most every 6h

// === Custom festival themes ===
const THEMES = Object.freeze([
  "harvest-thanks", // celebrating the harvest
  "founders-memory", // honoring the kingdom's founders
  "peace-treaty", // celebrating peace
  "bountiful-sea", // fishermen's festival
  "starlight", // night festival with fireworks
  "craftsmans-pride", // celebrating artisans
]);

const THEME_NAMES = Object.freeze({
  "harvest-thanks": "Harvest Thanks",
  "founders-memory": "Founders' Memory",
  "peace-treaty": "Peace Treaty",
  "bountiful-sea": "Bountiful Sea",
  "starlight": "Starlight",
  "craftsmans-pride": "Craftsman's Pride",
});

// === Carnival booth types ===
const BOOTH_RING_TOSS = "ring-toss";
const BOOTH_STRENGTH = "strength-test";
const BOOTH_FORTUNE = "fortune-telling";
const BOOTH_TYPES = [BOOTH_RING_TOSS, BOOTH_STRENGTH, BOOTH_FORTUNE];

const BOOTH_NAMES = Object.freeze({
  [BOOTH_RING_TOSS]: "ring toss",
  [BOOTH_STRENGTH]: "the strength test",
  [BOOTH_FORTUNE]: "the fortune teller",
});

// === Parade route stops (deterministic, per kingdom) ===
const PARADE_STOPS = Object.freeze(["market", "main-street", "temple", "market"]);

// --- state -------------------------------------------------------------------

let cache = null; // { planners: {}, customs: [], parades: [], fireworks: [], booths: {} }
let dirty = false;

function blankState() {
  return {
    planners: {}, // kingdomId -> { username, appointedAt }
    customs: [], // [{ id, name, theme, kingdomId, organizer, budget, startsAt, endsAt, announced }]
    parades: [], // [{ id, festivalId, kingdomId, startsAt, route: [...], announced }]
    fireworks: [], // [{ id, festivalId, kingdomId, startsAt, announced }]
    booths: {}, // festivalId -> [{ type, operator, prizePool }]
    lastAnnounce: {}, // "kingdomId:kind" -> timestamp
  };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), SAVE_PATH);
    if (fs.existsSync(full)) {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      if (data && typeof data === "object") {
        cache = Object.assign(blankState(), data);
      }
    }
  } catch { /* start fresh */ }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), SAVE_PATH);
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function markDirty() { dirty = true; }

// For tests: reset to blank.
function resetForTests() {
  cache = blankState();
  dirty = false;
}

// === Planners ===

/**
 * Appoint a head planner for a kingdom. Must be sociable and reputable.
 * Returns the planner record or null if ineligible.
 */
function appointPlanner(kingdomId, username, reputation, socialScore) {
  const s = load();
  if ((reputation ?? 0) < PLANNER_MIN_REPUTATION) return null;
  if ((socialScore ?? 0) < PLANNER_MIN_SOCIAL) return null;
  const norm = normalizeName(username);
  s.planners[kingdomId] = { username: norm, appointedAt: Date.now() };
  markDirty();
  try {
    getJournal().log(norm, "celebration", `${norm} was appointed festival planner for ${kingdomId}.`);
  } catch { /* journal optional */ }
  return s.planners[kingdomId];
}

/** Get the head planner for a kingdom, or null. */
function plannerFor(kingdomId) {
  return load().planners[kingdomId] ?? null;
}

/** All planners across kingdoms. */
function allPlanners() {
  const s = load();
  return Object.entries(s.planners).map(([kingdomId, p]) => ({ kingdomId, ...p }));
}

// === Custom festivals ===

/**
 * Organize a custom festival. The organizer funds it with real coins
 * (the caller moves the coins; this records the festival).
 * Returns the festival record or null if the budget is too low.
 */
function organizeFestival({ name, theme, kingdomId, organizer, budget, startsAt }) {
  const s = load();
  if (!THEMES.includes(theme)) return null;
  if ((budget ?? 0) < CUSTOM_FESTIVAL_MIN_BUDGET) return null;
  const start = startsAt ?? Date.now();
  const fest = {
    id: `custom-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    name: name ?? `${THEME_NAMES[theme]} Festival`,
    theme,
    kingdomId,
    organizer: normalizeName(organizer),
    budget,
    startsAt: start,
    endsAt: start + CUSTOM_FESTIVAL_DURATION_DAYS * 24 * 60 * 60 * 1000,
    announced: false,
  };
  s.customs.push(fest);
  markDirty();
  try {
    getJournal().log(fest.organizer, "celebration", `${fest.organizer} organized "${fest.name}" in ${kingdomId}.`);
  } catch { /* journal optional */ }
  return fest;
}

/** Get all custom festivals for a kingdom (past and future). */
function customsFor(kingdomId) {
  return load().customs.filter((c) => c.kingdomId === kingdomId);
}

/** Get the currently active custom festival for a kingdom, or null. */
function activeCustom(kingdomId, nowMs) {
  const now = nowMs ?? Date.now();
  return load().customs.find(
    (c) => c.kingdomId === kingdomId && c.startsAt <= now && now <= c.endsAt
  ) ?? null;
}

/** Get upcoming custom festivals (starting within 7 days). */
function upcomingCustoms(kingdomId, nowMs) {
  const now = nowMs ?? Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  return load().customs.filter(
    (c) => c.kingdomId === kingdomId && c.startsAt > now && c.startsAt - now <= week
  );
}

// === Parades ===

/**
 * Schedule a parade for a festival. The parade marches a deterministic
 * route through the kingdom's streets.
 */
function scheduleParade(festivalId, kingdomId, startsAt) {
  const s = load();
  const parade = {
    id: `parade-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    festivalId,
    kingdomId,
    startsAt: startsAt ?? Date.now(),
    route: [...PARADE_STOPS],
    announced: false,
  };
  s.parades.push(parade);
  markDirty();
  return parade;
}

/** Get parades for a kingdom happening now (within 1 hour of start). */
function activeParades(kingdomId, nowMs) {
  const now = nowMs ?? Date.now();
  const hour = 60 * 60 * 1000;
  return load().parades.filter(
    (p) => p.kingdomId === kingdomId && Math.abs(p.startsAt - now) <= hour
  );
}

/** Mark a parade as announced (so we don't spam). */
function markParadeAnnounced(paradeId, nowMs) {
  const s = load();
  const p = s.parades.find((x) => x.id === paradeId);
  if (p) { p.announced = true; markDirty(); }
}

// === Fireworks ===

/**
 * Schedule a fireworks show. Costs real coins from the festival budget
 * (the caller deducts; this records the show).
 */
function scheduleFireworks(festivalId, kingdomId, startsAt) {
  const s = load();
  const show = {
    id: `fw-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    festivalId,
    kingdomId,
    startsAt: startsAt ?? Date.now(),
    announced: false,
  };
  s.fireworks.push(show);
  markDirty();
  return show;
}

/** Get fireworks shows for a kingdom happening tonight (within 3 hours). */
function tonightFireworks(kingdomId, nowMs) {
  const now = nowMs ?? Date.now();
  const threeHours = 3 * 60 * 60 * 1000;
  return load().fireworks.filter(
    (f) => f.kingdomId === kingdomId && f.startsAt >= now - threeHours && f.startsAt <= now + threeHours
  );
}

function markFireworksAnnounced(showId) {
  const s = load();
  const f = s.fireworks.find((x) => x.id === showId);
  if (f) { f.announced = true; markDirty(); }
}

// === Carnival booths ===

/**
 * Set up carnival booths for a festival. Each booth has an operator
 * (a citizen) and a prize pool funded from the festival budget.
 */
function setupBooths(festivalId, operators) {
  const s = load();
  const booths = BOOTH_TYPES.map((type, i) => ({
    type,
    operator: normalizeName(operators[i % operators.length] ?? "the carnival"),
    prizePool: BOOTH_PRIZE * 10, // 10 prizes per booth
  }));
  s.booths[festivalId] = booths;
  markDirty();
  return booths;
}

/** Get booths for a festival. */
function boothsFor(festivalId) {
  return load().booths[festivalId] ?? [];
}

/**
 * Play a carnival game. Honest: the player pays the entry fee
 * (caller moves real coins), then we roll for a win.
 * Returns { won, prize } — prize is 0 if lost or pool is empty.
 */
function playBooth(festivalId, boothType) {
  const s = load();
  const booths = s.booths[festivalId] ?? [];
  const booth = booths.find((b) => b.type === boothType);
  if (!booth) return { won: false, prize: 0, reason: "no-booth" };
  if (booth.prizePool < BOOTH_PRIZE) return { won: false, prize: 0, reason: "pool-empty" };
  const won = Math.random() < BOOTH_WIN_CHANCE;
  if (won) {
    booth.prizePool -= BOOTH_PRIZE;
    markDirty();
    return { won: true, prize: BOOTH_PRIZE };
  }
  return { won: false, prize: 0 };
}

// === Announcement throttling ===

/** Check if we can announce (kind per kingdom), and record it. */
function canAnnounce(kingdomId, kind, nowMs) {
  const s = load();
  const key = `${kingdomId}:${kind}`;
  const last = s.lastAnnounce[key] ?? 0;
  if ((nowMs ?? Date.now()) - last < ANNOUNCE_COOLDOWN_MS) return false;
  s.lastAnnounce[key] = nowMs ?? Date.now();
  markDirty();
  return true;
}

module.exports = {
  // tuning (for tests)
  PLANNER_MIN_REPUTATION,
  PLANNER_MIN_SOCIAL,
  CUSTOM_FESTIVAL_MIN_BUDGET,
  CUSTOM_FESTIVAL_DURATION_DAYS,
  PARADE_PARTICIPANTS,
  FIREWORKS_COST,
  FIREWORKS_CROWD_RADIUS,
  BOOTH_ENTRY_FEE,
  BOOTH_PRIZE,
  BOOTH_WIN_CHANCE,
  THEMES,
  THEME_NAMES,
  BOOTH_TYPES,
  BOOTH_NAMES,
  PARADE_STOPS,
  SAVE_PATH,
  // planners
  appointPlanner,
  plannerFor,
  allPlanners,
  // custom festivals
  organizeFestival,
  customsFor,
  activeCustom,
  upcomingCustoms,
  // parades
  scheduleParade,
  activeParades,
  markParadeAnnounced,
  // fireworks
  scheduleFireworks,
  tonightFireworks,
  markFireworksAnnounced,
  // carnival
  setupBooths,
  boothsFor,
  playBooth,
  // announce throttle
  canAnnounce,
  // persistence
  save,
  load,
  resetForTests,
};
