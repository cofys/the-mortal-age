"use strict";

/**
 * CitizenTravel — the data tier for citizen transportation between kingdoms.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Route catalog: every pair of kingdom capitals gets a deterministic
 *     route with distance, fare, danger, and mode (ship where both ends
 *     have docks, caravan otherwise).
 *   - Journeys: records of citizens currently traveling — { username,
 *     from, to, mode, departsAt, arrivesAt, fare, cargo }. Travel takes
 *     real time (journeys span multiple slow ticks), never instant.
 *   - Fares: honest — real coins removed from the traveler's real
 *     inventory when the journey starts. Broke citizens can't travel.
 *   - Danger: routes carry bandit risk and monster risk. Rolled on
 *     arrival: bandits take coins/goods, monsters hurt the traveler.
 *     Dangerous routes are cheaper — risk has a price.
 *   - War blocking: routes to or from a kingdom at war are CLOSED.
 *     War is read live from KingdomStore.getActiveWars() (defensive —
 *     if the store is unavailable, routes stay open rather than strand
 *     everyone).
 *   - Cargo: travelers may carry small trade goods (a manifest, not
 *     inventory). On arrival the goods sell at a margin — the honest
 *     micro-economics of a traveling peddler.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Departure/arrival processing lives in
 *     lib/CitizenTravelLife.js (the director ticks that).
 *   - No LLM. Notable journeys are journaled; the chat layer riffs.
 *   - No physical movement of bots — arrival updates the roster
 *     kingdomId; the director's spawn logic puts them in the new
 *     kingdom's market on next spawn. The brain action teleports
 *     online travelers directly.
 *
 * Persisted to data/saves/citizen-travel.json (dirty-flag pattern, never
 * committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-travel.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

function resetForTests() {
  cache = null;
  dirty = false;
}

// === Route catalog ===========================================================
// Deterministic per route-pair: same pair always yields the same route, so
// fares and danger are stable across restarts and testable.

const COINS = 995;

// Kingdom display names for journal/chat lines.
const KINGDOM_NAMES = Object.freeze({
  asgarnia: "Asgarnia",
  kandarin: "Kandarin",
  keldagrim: "Keldagrim",
  misthalin: "Misthalin",
  morytania: "Morytania",
});

// Dock availability per kingdom (keldagrim is landlocked).
const HAS_DOCK = Object.freeze({
  asgarnia: true,
  kandarin: true,
  keldagrim: false,
  misthalin: true,
  morytania: true,
});

function hashStr(s) {
  let h = 2166136261;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Canonical unordered pair key: "asgarnia:misthalin". */
function routeKey(a, b) {
  return [String(a ?? "").toLowerCase(), String(b ?? "").toLowerCase()]
    .sort()
    .join(":");
}

/**
 * Deterministic route between two kingdoms. Returns null for same-kingdom
 * or unknown kingdoms.
 *
 * Route shape:
 *   { from, to, key, mode ("ship"|"caravan"), distanceKm, durationMs,
 *     fare, banditRisk (0..1), monsterRisk (0..1) }
 *
 * Fares scale with distance; danger discounts the fare (risk has a price);
 * ships are faster and pricier than caravans.
 */
function routeBetween(from, to) {
  const a = String(from ?? "").toLowerCase();
  const b = String(to ?? "").toLowerCase();
  if (!a || !b || a === b) return null;
  if (!KINGDOM_NAMES[a] || !KINGDOM_NAMES[b]) return null;

  const key = routeKey(a, b);
  const h = hashStr(key);
  const ship = HAS_DOCK[a] && HAS_DOCK[b];
  const mode = ship ? "ship" : "caravan";

  // Distance in "km" — flavor number driving fare and duration.
  const distanceKm = 60 + (h % 240);
  // Duration: ships ~20-50 min, caravans ~45-120 min. Real time, not instant.
  const baseMs = ship ? 20 * 60 * 1000 : 45 * 60 * 1000;
  const varianceMs = ship ? 30 * 60 * 1000 : 75 * 60 * 1000;
  const durationMs = baseMs + (hashStr(key + ":dur") % varianceMs);

  // Danger: 0-35% bandit, 0-25% monster. Sea routes: fewer bandits, some
  // sea monsters. Land routes: more bandits.
  let banditRisk = (hashStr(key + ":bandit") % 36) / 100;
  let monsterRisk = (hashStr(key + ":monster") % 26) / 100;
  if (ship) {
    banditRisk = Math.max(0, banditRisk - 0.15);
    monsterRisk = Math.min(0.3, monsterRisk + 0.05);
  }

  // Fare: base 40 + distance, ships cost more, danger discounts.
  let fare = 40 + Math.round(distanceKm * 0.8);
  if (ship) fare = Math.round(fare * 1.4);
  const dangerDiscount = Math.round((banditRisk + monsterRisk) * 60);
  fare = Math.max(25, fare - dangerDiscount);

  return {
    from: a,
    to: b,
    key,
    mode,
    distanceKm,
    durationMs,
    fare,
    banditRisk: Math.round(banditRisk * 100) / 100,
    monsterRisk: Math.round(monsterRisk * 100) / 100,
  };
}

/** All routes from a kingdom to every other kingdom. */
function routesFrom(kingdomId) {
  const a = String(kingdomId ?? "").toLowerCase();
  return Object.keys(KINGDOM_NAMES)
    .filter((k) => k !== a)
    .map((k) => routeBetween(a, k))
    .filter(Boolean);
}

/** Pretty kingdom name. */
function kingdomName(kingdomId) {
  return KINGDOM_NAMES[String(kingdomId ?? "").toLowerCase()] ?? String(kingdomId ?? "");
}

// === War blocking =============================================================
// Lazy KingdomStore access (defensive: never break travel if kingdoms fail).

let KingdomStore = null;
function kingdoms() {
  if (KingdomStore === null) {
    try {
      KingdomStore = require("../../kingdoms/KingdomStore");
    } catch {
      KingdomStore = false;
    }
  }
  return KingdomStore || null;
}

/** Kingdoms currently at war (ids). Defensive — empty set on failure. */
function warringKingdoms() {
  try {
    const ks = kingdoms();
    if (!ks || typeof ks.getActiveWars !== "function") return new Set();
    const wars = ks.getActiveWars() ?? [];
    const out = new Set();
    for (const w of wars) {
      if (w?.attackerId) out.add(String(w.attackerId).toLowerCase());
      if (w?.defenderId) out.add(String(w.defenderId).toLowerCase());
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Is the route open? Closed when either endpoint is at war — nobody sails
 * or rides into a war zone. (Unknown store = open, fail-safe.)
 */
function routeOpen(from, to, warring) {
  const war = warring ?? warringKingdoms();
  const a = String(from ?? "").toLowerCase();
  const b = String(to ?? "").toLowerCase();
  return !war.has(a) && !war.has(b);
}

// === Journey store =============================================================

let cache = null;
let dirty = false;

function blank() {
  return { journeys: {} }; // journeys keyed by normalized username
}

function data() {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      if (!cache || typeof cache !== "object") cache = blank();
      if (!cache.journeys || typeof cache.journeys !== "object") cache.journeys = {};
    } catch {
      cache = blank();
    }
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
    fs.writeFileSync(SAVE_FILE, JSON.stringify(data(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/** The active journey for a citizen, or null. */
function journeyOf(username) {
  const d = data();
  return d.journeys[normalizeName(username)] ?? null;
}

/** All active journeys as an array. */
function allJourneys() {
  return Object.values(data().journeys);
}

/**
 * Start a journey. Deducts the fare from the player's real coins when a
 * player entity is provided (honest money — no fare, no travel).
 * Returns { ok, journey } or { ok: false, reason }.
 *
 * Reasons: "already-traveling", "no-route", "route-closed",
 * "no-fare" (can't afford), "invalid".
 */
function startJourney(username, from, to, nowMs, player) {
  const uname = normalizeName(username);
  if (!uname) return { ok: false, reason: "invalid" };
  if (journeyOf(uname)) return { ok: false, reason: "already-traveling" };

  const route = routeBetween(from, to);
  if (!route) return { ok: false, reason: "no-route" };
  if (!routeOpen(from, to)) return { ok: false, reason: "route-closed" };

  // Honest fare: real coins from the real inventory.
  if (player) {
    const paid = removeCoins(player, route.fare);
    if (paid < route.fare) {
      // Refund partial payment — a failed purchase takes nothing.
      if (paid > 0) addCoins(player, paid);
      return { ok: false, reason: "no-fare" };
    }
  }

  const now = nowMs ?? Date.now();
  // Mounted citizens travel faster — horses are real transport.
  let durationMs = route.durationMs;
  try {
    const Pets = require("./CitizenPets");
    durationMs = Math.round(route.durationMs * Pets.travelSpeedFor(uname));
  } catch {
    // A missing/broken pets module never slows travel.
  }
  // Built bridges and roads shorten the journey (real infrastructure effect).
  try {
    const Infra = require("./CitizenInfrastructure");
    const bonus = Infra.travelBonusFor(route.from, route.to) || 0;
    if (bonus > 0) {
      durationMs = Math.round(durationMs * Math.max(0.5, 1 - bonus / 100));
    }
  } catch {
    // A missing/broken infrastructure module never slows travel.
  }
  // Star charts guide the way (real astronomy effect). Charts are made by
  // astronomers observing at night; the bonus reads from the chart records.
  try {
    const Astro = require("./CitizenAstronomy");
    const bonus = Astro.chartBonusFor(route.from) || 0;
    if (bonus > 0) {
      durationMs = Math.round(durationMs * Math.max(0.5, 1 - bonus / 100));
    }
  } catch {
    // A missing/broken astronomy module never slows travel.
  }
  // Good maps shorten the road (real cartography effect). Maps are drafted
  // by cartographers at the map shop; the bonus reads from the map records.
  try {
    const Maps = require("./CitizenMaps");
    const bonus = Maps.mapNavigationBonusFor(route.from) || 0;
    if (bonus > 0) {
      durationMs = Math.round(durationMs * Math.max(0.5, 1 - bonus / 100));
    }
  } catch {
    // A missing/broken maps module never slows travel.
  }
  // Meteor showers light the night road (real celestial-event effect).
  try {
    const Astro = require("./CitizenAstronomy");
    const bonus = Astro.eventEffectFor(route.from, "travel_speed", now) || 0;
    if (bonus > 0) {
      durationMs = Math.round(durationMs * Math.max(0.5, 1 - bonus / 100));
    }
  } catch {
    // A missing/broken astronomy module never slows travel.
  }
  const journey = {
    username: uname,
    from: route.from,
    to: route.to,
    mode: route.mode,
    departsAt: now,
    arrivesAt: now + durationMs,
    fare: route.fare,
    cargo: null, // optional trade manifest, set by setCargo
    announced: false,
  };
  data().journeys[uname] = journey;
  markDirty();
  return { ok: true, journey };
}

/** Attach a small trade-goods manifest to a journey (peddler cargo). */
function setCargo(username, manifest) {
  const j = journeyOf(username);
  if (!j) return false;
  j.cargo = Array.isArray(manifest) ? manifest.slice(0, 6) : null;
  markDirty();
  return true;
}

/** Remove a journey record (arrival processed or cancelled). */
function clearJourney(username) {
  const uname = normalizeName(username);
  if (data().journeys[uname]) {
    delete data().journeys[uname];
    markDirty();
    return true;
  }
  return false;
}

/** Journeys whose arrival time has passed. */
function dueArrivals(nowMs) {
  const now = nowMs ?? Date.now();
  return allJourneys().filter((j) => j && j.arrivesAt <= now);
}

/** Journeys currently in transit (departed, not yet arrived). */
function inTransit(nowMs) {
  const now = nowMs ?? Date.now();
  return allJourneys().filter((j) => j && j.departsAt <= now && j.arrivesAt > now);
}

// === Coin helpers (honest money) =================================================

function countCoins(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(COINS);
    if (typeof inv.getAmount === "function") return inv.getAmount(COINS);
    return 0;
  } catch {
    return 0;
  }
}

function removeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    const have = countCoins(player);
    const take = Math.min(have, amount);
    if (take <= 0) return 0;
    if (typeof inv.remove === "function") inv.remove(COINS, take);
    else if (typeof inv.delete === "function") inv.delete(COINS, take);
    else return 0;
    return take;
  } catch {
    return 0;
  }
}

function addCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return 0;
    if (typeof inv.add === "function") {
      inv.add(COINS, amount);
      return amount;
    }
    return 0;
  } catch {
    return 0;
  }
}

// === Danger rolls (arrival) ========================================================
// Pure functions — the tick passes an rng.

const BANDIT_LOSS_PCT = [0.15, 0.4]; // bandits take 15-40% of carried coins
const MONSTER_HP_LOSS = [8, 25]; // monsters deal 8-25 damage

/**
 * Roll arrival danger for a journey. Returns
 * { bandit: bool, coinsLost, monster: bool, damage }.
 */
function rollDanger(journey, rng) {
  const route = routeBetween(journey.from, journey.to);
  const r = rng ?? Math.random;
  let banditRisk = route?.banditRisk ?? 0.15;
  const monsterRisk = route?.monsterRisk ?? 0.1;

  // Built roads are patrolled — bandits think twice (real infrastructure effect).
  try {
    const Infra = require("./CitizenInfrastructure");
    if (Infra.routeSafer(journey.from, journey.to)) {
      banditRisk = Math.max(0.02, banditRisk * 0.5);
    }
  } catch {
    // A missing/broken infrastructure module never changes danger.
  }

  const bandit = r() < banditRisk;
  const monster = r() < monsterRisk;

  let coinsLost = 0;
  let damage = 0;
  if (bandit) {
    const pct =
      BANDIT_LOSS_PCT[0] + r() * (BANDIT_LOSS_PCT[1] - BANDIT_LOSS_PCT[0]);
    coinsLost = pct; // as fraction — the tick applies it to real coins
  }
  if (monster) {
    damage = Math.round(
      MONSTER_HP_LOSS[0] + r() * (MONSTER_HP_LOSS[1] - MONSTER_HP_LOSS[0])
    );
  }
  return { bandit, coinsLost, monster, damage };
}

// === Trade goods (peddler cargo) =====================================================
// Small manifests travelers carry. On arrival the goods sell at a margin —
// the honest micro-economics of a traveling peddler. Data only.

const TRADE_GOODS = Object.freeze([
  { name: "spices", margin: [30, 80] },
  { name: "silk", margin: [50, 120] },
  { name: "pottery", margin: [15, 40] },
  { name: "furs", margin: [25, 60] },
  { name: "wine", margin: [20, 55] },
  { name: "tools", margin: [18, 45] },
]);

/** Build a small random cargo manifest (2-4 goods). Pure with rng. */
function buildCargo(rng) {
  const r = rng ?? Math.random;
  const n = 2 + Math.floor(r() * 3);
  const goods = TRADE_GOODS.slice();
  const manifest = [];
  for (let i = 0; i < n && goods.length; i++) {
    const idx = Math.floor(r() * goods.length);
    const [g] = goods.splice(idx, 1);
    manifest.push({
      name: g.name,
      margin: Math.round(g.margin[0] + r() * (g.margin[1] - g.margin[0])),
    });
  }
  return manifest;
}

/** Total sale value of a cargo manifest. */
function cargoValue(manifest) {
  if (!Array.isArray(manifest)) return 0;
  return manifest.reduce((sum, g) => sum + (Number(g?.margin) || 0), 0);
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  KINGDOM_NAMES,
  HAS_DOCK,
  hashStr,
  routeKey,
  routeBetween,
  routesFrom,
  kingdomName,
  routeOpen,
  warringKingdoms,
  journeyOf,
  allJourneys,
  startJourney,
  setCargo,
  clearJourney,
  dueArrivals,
  inTransit,
  countCoins,
  removeCoins,
  addCoins,
  rollDanger,
  buildCargo,
  cargoValue,
  TRADE_GOODS,
  BANDIT_LOSS_PCT,
  MONSTER_HP_LOSS,
};
