"use strict";

/**
 * CitizenHomes — the data layer for citizen housing.
 *
 * Every citizen gets a home: a cottage, house or manor on a real plot in
 * their kingdom's residential district (a deterministic grid off the market
 * tile, so houses never stack). Citizens pay daily rent from their real
 * coin pouch, buy furniture the carpenter trade crafts, host gatherings,
 * and invite players over as guests. Lose the rent race for four days and
 * you're evicted — the ledger is real state, the coins are real coins.
 *
 * This is the DATA tier: pure state, zero LLM, tick-safe. The dynamics
 * (assignment, rent collection, furnishing, gatherings) live in
 * lib/CitizenHomeLife.js, which the director ticks. The foreground (chat,
 * LLM) reads this and roleplays from it.
 *
 * Not to confuse with:
 *   - Guild halls (plugins/guilds): player-founded. Homes are citizen
 *     dwellings; players visit as guests, never as owners.
 *   - CitizenClans: clans gather AT homes, but the home belongs to the
 *     citizen, not the clan.
 *   - record.home (CitizenDirector): the citizen's spawn anchor tile.
 *     CitizenHomeLife points it at the house tile, so citizens wake up
 *     and materialize at home. Sleep itself is the existing offline
 *     sleep window — the house is where they go to do it.
 *
 * Persisted to data/saves/citizen-homes.json (never committed). Bounded:
 * guest lists, furnishing lists and activity logs are capped.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-homes.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- house sizes -------------------------------------------------------------

const SIZE_COTTAGE = "cottage";
const SIZE_HOUSE = "house";
const SIZE_MANOR = "manor";

const HOUSE_SIZES = Object.freeze({
  [SIZE_COTTAGE]: Object.freeze({ rentPerDay: 50, comfort: 1, status: 0, rooms: 1, label: "cottage" }),
  [SIZE_HOUSE]: Object.freeze({ rentPerDay: 150, comfort: 2, status: 1, rooms: 2, label: "house" }),
  [SIZE_MANOR]: Object.freeze({ rentPerDay: 400, comfort: 3, status: 2, rooms: 4, label: "manor" }),
});

/** House size from a roster record's real role. No hashes, no fiction. */
function sizeForRole(role) {
  const r = String(role ?? "").toLowerCase();
  if (r === "courtier") return SIZE_MANOR;
  if (r === "merchant" || r === "guard") return SIZE_HOUSE;
  return SIZE_COTTAGE;
}

// --- furniture ---------------------------------------------------------------
// Pieces the carpenter trade crafts (see lib/CitizenArtisans.js). Citizens
// buy them with real coins; comfort feeds the happiness readout.

const FURNITURE_CATALOG = Object.freeze([
  Object.freeze({ key: "lantern", name: "brass lantern", cost: 200, comfort: 1 }),
  Object.freeze({ key: "rug", name: "woven rug", cost: 300, comfort: 1 }),
  Object.freeze({ key: "rocking_chair", name: "willow rocking chair", cost: 500, comfort: 1 }),
  Object.freeze({ key: "bed", name: "oak bed", cost: 600, comfort: 1 }),
  Object.freeze({ key: "bookshelf", name: "oak bookshelf", cost: 800, comfort: 2 }),
  Object.freeze({ key: "painting", name: "framed painting", cost: 1000, comfort: 2 }),
  Object.freeze({ key: "table", name: "mahogany table", cost: 1200, comfort: 2 }),
  Object.freeze({ key: "wardrobe", name: "teak wardrobe", cost: 1500, comfort: 3 }),
]);

function furnitureByKey(key) {
  return FURNITURE_CATALOG.find((f) => f.key === String(key)) ?? null;
}

// --- bounds ------------------------------------------------------------------

const MAX_HOMES_PER_KINGDOM = 40;
const MAX_GUESTS = 12;
const MAX_FURNISHINGS = 8;
const MAX_ACTIVITY_LOG = 40;
const EVICT_DEBT_DAYS = 4; // unpaid days before eviction
const GUEST_VISIT_MS = 2 * 3600 * 1000; // gathering invitations last 2h

let cache = null;
let dirty = false;

function data() {
  if (!cache) cache = load();
  return cache;
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return { homes: {}, seq: 0 };
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return { homes: {}, seq: 0 };
    if (!raw.homes || typeof raw.homes !== "object") raw.homes = {};
    if (!Number.isFinite(raw.seq)) raw.seq = 0;
    return raw;
  } catch {
    return { homes: {}, seq: 0 };
  }
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Never break the tick.
  }
}

/**
 * Deterministic residential plot: a grid off the kingdom's market tile.
 * seq drives the plot, so houses never stack and the layout is stable
 * across restarts. 8x8 plots per block, blocks step 120 tiles east.
 */
function plotFor(kingdomId, seq) {
  let market = null;
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    market = siteTileByKingdom(kingdomId, "market");
  } catch {
    // Fall through to the fallback tile.
  }
  const mx = Number.isFinite(market?.x) ? market.x : 3200;
  const my = Number.isFinite(market?.y) ? market.y : 3200;
  const mz = Number.isFinite(market?.z) ? market.z : 0;
  const perBlock = 64;
  const cols = 8;
  const spacing = 12;
  const block = Math.floor(seq / perBlock);
  const within = seq % perBlock;
  const col = within % cols;
  const row = Math.floor(within / cols);
  return {
    x: Math.round(mx + 60 + block * 120 + (col - 3.5) * spacing),
    y: Math.round(my + 60 + (row - 3.5) * spacing),
    z: mz,
  };
}

function blankHome(id, ownerName, ownerDisplay, kingdomId, size, tile) {
  const spec = HOUSE_SIZES[size] ?? HOUSE_SIZES[SIZE_COTTAGE];
  return {
    id,
    kingdomId: String(kingdomId ?? ""),
    owner: normalizeName(ownerName),
    ownerDisplay: ownerDisplay ?? ownerName,
    tile: { x: tile.x, y: tile.y, z: tile.z ?? 0 },
    size,
    furnishings: [], // [{ key, name, comfort, boughtAt }]
    rentPerDay: spec.rentPerDay,
    rentDueAt: Date.now() + 24 * 3600 * 1000,
    rentDebt: 0,
    guests: [], // [{ name, until }]
    activityLog: [],
    createdAt: Date.now(),
  };
}

// --- reads -------------------------------------------------------------------

function getHome(homeId) {
  return data().homes[String(homeId)] ?? null;
}

function allHomes() {
  return Object.values(data().homes);
}

function homesInKingdom(kingdomId) {
  const kid = String(kingdomId ?? "");
  return allHomes().filter((h) => String(h.kingdomId) === kid);
}

/** The home a citizen owns, or null. */
function homeOf(citizenName) {
  const n = normalizeName(citizenName);
  if (!n) return null;
  return allHomes().find((h) => h.owner === n) ?? null;
}

/** The tile a citizen's home sits on — the spawn-at-home anchor. */
function homeTile(citizenName) {
  const home = homeOf(citizenName);
  return home ? { x: home.tile.x, y: home.tile.y, z: home.tile.z ?? 0 } : null;
}

/** Comfort: size base + furnishings. Feeds the happiness readout. */
function comfortOf(home) {
  if (!home) return 0;
  const base = HOUSE_SIZES[home.size]?.comfort ?? 1;
  const furn = (home.furnishings ?? []).reduce((s, f) => s + (f.comfort ?? 0), 0);
  return base + furn;
}

/** Social status: size rank, +1 for a well-furnished home. */
function statusOf(home) {
  if (!home) return 0;
  const base = HOUSE_SIZES[home.size]?.status ?? 0;
  return base + ((home.furnishings ?? []).length >= 3 ? 1 : 0);
}

function pruneGuests(home, nowMs) {
  if (!home) return;
  const before = (home.guests ?? []).length;
  home.guests = (home.guests ?? []).filter((g) => (g.until ?? 0) > nowMs);
  if (home.guests.length !== before) markDirty();
}

/** Owner is always allowed; guests need a live invitation. */
function isGuestAllowed(home, guestName, nowMs = Date.now()) {
  if (!home || !guestName) return false;
  const n = normalizeName(guestName);
  if (home.owner === n) return true;
  pruneGuests(home, nowMs);
  return (home.guests ?? []).some((g) => g.name === n);
}

/** Rent is due when the clock passes rentDueAt. */
function rentDue(home, nowMs = Date.now()) {
  if (!home) return false;
  return (home.rentDueAt ?? 0) <= nowMs;
}

/** True when unpaid debt reaches the eviction grace limit. */
function evictable(home) {
  if (!home) return false;
  return (home.rentDebt ?? 0) >= EVICT_DEBT_DAYS * (home.rentPerDay ?? 50);
}

// --- writes ------------------------------------------------------------------

function recordActivity(home, text) {
  if (!home || !text) return;
  home.activityLog.push({ at: Date.now(), text: String(text) });
  while (home.activityLog.length > MAX_ACTIVITY_LOG) home.activityLog.shift();
  markDirty();
}

/**
 * Give a citizen a home. One home per citizen; capped per kingdom.
 * The plot is deterministic from the creation sequence.
 */
function createHome(ownerName, ownerDisplay, kingdomId, size) {
  const n = normalizeName(ownerName);
  if (!n) return null;
  if (homeOf(n)) return null; // one home per citizen
  const kid = String(kingdomId ?? "");
  if (homesInKingdom(kid).length >= MAX_HOMES_PER_KINGDOM) return null;
  const d = data();
  const finalSize = HOUSE_SIZES[size] ? size : SIZE_COTTAGE;
  d.seq += 1;
  const id = `home_${d.seq}`;
  const tile = plotFor(kid, d.seq);
  const home = blankHome(id, n, ownerDisplay ?? ownerName, kid, finalSize, tile);
  d.homes[id] = home;
  markDirty();
  const label = HOUSE_SIZES[finalSize].label;
  journalEvent(n, `Moved into a ${label} of my own.`, "social");
  recordActivity(home, `${home.ownerDisplay} moved in.`);
  return home;
}

/** Add a furniture piece (the coins were already taken by the caller). */
function addFurnishing(homeId, furnishingKey) {
  const home = getHome(homeId);
  const piece = furnitureByKey(furnishingKey);
  if (!home || !piece) return false;
  if ((home.furnishings ?? []).length >= MAX_FURNISHINGS) return false;
  if ((home.furnishings ?? []).some((f) => f.key === piece.key)) return false;
  home.furnishings.push({ key: piece.key, name: piece.name, comfort: piece.comfort, boughtAt: Date.now() });
  markDirty();
  journalEvent(home.owner, `Furnished the ${HOUSE_SIZES[home.size].label} with a ${piece.name}.`, "social");
  recordActivity(home, `Added a ${piece.name}.`);
  return true;
}

/** Invite a guest — gathering invitations last 2 hours. */
function inviteGuest(homeId, guestName, nowMs = Date.now()) {
  const home = getHome(homeId);
  const n = normalizeName(guestName);
  if (!home || !n) return false;
  pruneGuests(home, nowMs);
  if ((home.guests ?? []).length >= MAX_GUESTS) return false;
  const existing = (home.guests ?? []).find((g) => g.name === n);
  if (existing) {
    existing.until = nowMs + GUEST_VISIT_MS;
  } else {
    home.guests.push({ name: n, until: nowMs + GUEST_VISIT_MS });
  }
  markDirty();
  return true;
}

function revokeGuest(homeId, guestName) {
  const home = getHome(homeId);
  const n = normalizeName(guestName);
  if (!home || !n) return false;
  const before = (home.guests ?? []).length;
  home.guests = (home.guests ?? []).filter((g) => g.name !== n);
  if (home.guests.length !== before) markDirty();
  return home.guests.length !== before;
}

/** Rent paid in full (including arrears): clock resets, debt clears. */
function recordRentPaid(home, nowMs = Date.now()) {
  if (!home) return;
  home.rentDebt = 0;
  home.rentDueAt = nowMs + 24 * 3600 * 1000;
  markDirty();
}

/** A missed day: debt grows, clock resets for the next attempt. */
function addRentDebt(home, nowMs = Date.now()) {
  if (!home) return;
  home.rentDebt = (home.rentDebt ?? 0) + (home.rentPerDay ?? 50);
  home.rentDueAt = nowMs + 24 * 3600 * 1000;
  markDirty();
  recordActivity(home, `Rent went unpaid (${home.rentDebt} coins owed).`);
}

/** Evict: the home is gone, the citizen is homeless (journaled). */
function removeHome(homeId, reason) {
  const d = data();
  const home = d.homes[String(homeId)];
  if (!home) return false;
  journalEvent(home.owner, `Lost my home (${reason ?? "evicted"}).`, "social");
  recordActivity(home, `The home was lost (${reason ?? "evicted"}).`);
  delete d.homes[String(homeId)];
  markDirty();
  return true;
}

// --- test seams ---------------------------------------------------------------

function resetForTests() {
  cache = null;
  dirty = false;
}

function homeCount() {
  return Object.keys(data().homes).length;
}

module.exports = {
  SAVE_FILE,
  SIZE_COTTAGE,
  SIZE_HOUSE,
  SIZE_MANOR,
  HOUSE_SIZES,
  FURNITURE_CATALOG,
  MAX_HOMES_PER_KINGDOM,
  MAX_GUESTS,
  EVICT_DEBT_DAYS,
  GUEST_VISIT_MS,
  sizeForRole,
  furnitureByKey,
  plotFor,
  createHome,
  getHome,
  allHomes,
  homesInKingdom,
  homeOf,
  homeTile,
  comfortOf,
  statusOf,
  isGuestAllowed,
  rentDue,
  evictable,
  recordActivity,
  addFurnishing,
  inviteGuest,
  revokeGuest,
  recordRentPaid,
  addRentDebt,
  removeHome,
  save,
  resetForTests,
  _setSavePathForTests,
  homeCount,
  normalizeName,
};
