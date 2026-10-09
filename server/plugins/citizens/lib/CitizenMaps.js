"use strict";

/**
 * CitizenMaps — the REAL, persistent cartography layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenCartographers owns: HASH-DERIVED cartographer flavor — trade
 *     assignment, surveyor pacing, mapmaker desks, hawking, commissions as
 *     LLM flavor, daily hash-derived catalogs. Zero storage, zero real
 *     coins, zero real materials.
 *   - CitizenExplorers owns: abstract expedition sim (muster → journey →
 *     return with tales). CitizenCartographers owns mapping/charting flavor.
 *   - CitizenDiscovery owns: REAL discovery records (resource_node,
 *     dungeon_entrance, trade_route, ancient_ruin, monster_lair) with real
 *     coordinates and kingdom claiming.
 *   - THIS module owns: persistent MAP records with REAL material costs,
 *     REAL map shops with REAL coin transactions, exploration LOGS
 *     (travel journals from real journeys), and TREASURE maps that point
 *     at real discovery coordinates with real loot caches. Quality comes
 *     from real activity (discoveries made, charts completed), never from
 *     hashes. Navigation effects are exposed for CitizenTravel to read
 *     defensively — this module never touches travel itself.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Cartographer registry: real citizens who draft maps. Registered by
 *     the life tick from ONLINE citizens only (honest reads — no bot, no
 *     skill means no registration).
 *   - Map creation: consumes REAL papyrus (970) from the creator's real
 *     inventory (defensive — no papyrus, no map). Quality 1–10 is
 *     deterministic from the creator's real discoveries + charts: a human
 *     maps what they have actually seen.
 *   - Map types: world (kingdom overview), city (detailed capital),
 *     dungeon (drawn from a REAL CitizenDiscovery dungeon_entrance or
 *     ancient_ruin — honest null when none exists), treasure (points at a
 *     REAL discovery's coordinates; claiming the cache is first-come).
 *   - Map shops: one per kingdom, deterministic tile near the market.
 *     Creators sell at 70% of value; buyers pay full value in REAL coins.
 *     The shop never invents coins — broke buyers walk away.
 *   - Exploration logs: travel journals recorded when a citizen completes
 *     a REAL CitizenTravel journey (read defensively; nothing happens if
 *     travel is unavailable). Logs raise the author's next-map quality.
 *   - Treasure caches: a real loot cache spawns at the discovery's real
 *     coordinates when a treasure map is drafted; the FIRST citizen or
 *     player to reach it claims REAL coins. Caches expire after 14 days.
 *   - `mapNavigationBonusFor(kingdomId)`: percent journey-time reduction
 *     (capped) read defensively by CitizenTravel — a kingdom whose
 *     cartographers have mapped the roads travels them faster.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Registration/drafting/expiry lives in
 *     lib/CitizenMapLife.js (the director ticks that).
 *   - No LLM. Masterworks are journaled; the chat layer riffs.
 *   - No physical movement of bots — the brain action handles that.
 *   - No invented item IDs. Papyrus 970 is a real engine item (same ID
 *     the art module uses). Loot caches pay real coins only.
 */

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-maps.json";
const MAT_PAPYRUS = 970; // papyrus — real engine item (matches CitizenArt)

const MAP_WORLD = "world";
const MAP_CITY = "city";
const MAP_DUNGEON = "dungeon";
const MAP_TREASURE = "treasure";
const MAP_TYPES = Object.freeze([MAP_WORLD, MAP_CITY, MAP_DUNGEON, MAP_TREASURE]);

const BASE_VALUE = Object.freeze({
  [MAP_WORLD]: 60,
  [MAP_CITY]: 40,
  [MAP_DUNGEON]: 120,
  [MAP_TREASURE]: 200,
});
const CREATOR_CUT = 0.7; // creator gets 70% of value, shop keeps 30%
const MAX_QUALITY = 10;
const MAX_NAV_BONUS = 12; // percent — journey-time reduction cap
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // treasure caches expire
const MASTERWORK_QUALITY = 9; // quality >= 9 is a masterwork (fame deed)

// --- state --------------------------------------------------------------------

let cache = null; // { cartographers, shops, maps, listings, logs, caches, nextId }
let dirty = false;
let nextId = 1;

function blankState() {
  return {
    cartographers: Object.create(null), // norm -> { username, kingdomId, charts, registeredAt }
    shops: Object.create(null), // kingdomId -> { kingdomId, tile, foundedAt }
    maps: Object.create(null), // id -> { id, type, creator, kingdomId, quality, value, createdAt, discoveryId?, cacheId? }
    listings: Object.create(null), // id -> { mapId, price, listedAt } (maps currently for sale)
    logs: Object.create(null), // id -> { id, author, from, to, mode, writtenAt }
    caches: Object.create(null), // id -> { id, mapId, x, y, z, coins, claimedBy, claimedAt, expiresAt }
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
        for (const k of Object.keys(blankState())) {
          if (raw[k] && typeof raw[k] === "object") cache[k] = raw[k];
        }
        if (typeof raw.nextId === "number") nextId = raw.nextId;
      }
    }
  } catch { /* corrupt save = start fresh, never crash */ }
  return cache;
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const st = load();
    st.nextId = nextId;
    const p = savePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(st, null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function resetForTests() {
  cache = blankState();
  dirty = false;
  nextId = 1;
}

function allocId(prefix) {
  return `${prefix}-${nextId++}`;
}

// --- cartographers ------------------------------------------------------------

/**
 * Register a citizen as a cartographer. Honest: only registers real
 * usernames with a kingdom; the caller (life tick) checks the citizen is
 * online and curious/adventurous or in the cartographer career.
 */
function registerCartographer(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key || !kingdomId) return { ok: false, reason: "no-identity" };
  if (st.cartographers[key]) return { ok: true, already: true };
  st.cartographers[key] = {
    username: String(username),
    kingdomId: String(kingdomId),
    charts: 0,
    registeredAt: Date.now(),
  };
  markDirty();
  return { ok: true, already: false };
}

function isCartographer(username) {
  return !!load().cartographers[norm(username)];
}

function cartographerCount(kingdomId) {
  const st = load();
  let n = 0;
  for (const k of Object.keys(st.cartographers)) {
    if (String(st.cartographers[k].kingdomId) === String(kingdomId)) n++;
  }
  return n;
}

function noteChart(username) {
  const st = load();
  const rec = st.cartographers[norm(username)];
  if (!rec) return false;
  rec.charts = (rec.charts || 0) + 1;
  markDirty();
  return true;
}

// --- shops --------------------------------------------------------------------

/**
 * Deterministic map-shop tile: near the market, offset so it doesn't sit on
 * the travel dock tile. Returns null when the sites module is unavailable.
 */
function shopTileFor(kingdomId) {
  try {
    const { siteTile } = require("../brain/CitizenSites");
    const market = siteTile(kingdomId, "market");
    if (!market) return null;
    return { x: (market.x || 0) - 25, y: (market.y || 0) + 12, z: market.z || 0 };
  } catch { return null; }
}

function ensureShop(kingdomId) {
  const st = load();
  if (!st.shops[kingdomId]) {
    st.shops[kingdomId] = {
      kingdomId: String(kingdomId),
      tile: shopTileFor(kingdomId),
      foundedAt: Date.now(),
    };
    markDirty();
  }
  return st.shops[kingdomId];
}

function shopOf(kingdomId) {
  return load().shops[kingdomId] || null;
}

// --- quality ------------------------------------------------------------------

/**
 * Quality 1–10, deterministic from REAL activity: discoveries the creator
 * has made (via CitizenDiscovery, defensive) plus charts drafted plus
 * exploration logs written. A human maps what they have actually seen —
 * quality is never random and never hash-derived.
 */
function qualityFor(username) {
  let score = 3; // base: anyone with papyrus can sketch
  try {
    const Disc = require("./CitizenDiscovery");
    const mine = (Disc.allDiscoveries?.() ?? []).filter(
      (d) => norm(d.discoverer) === norm(username)
    );
    score += Math.min(mine.length, 4); // up to +4 for real discoveries
  } catch { /* no discovery module */ }
  const st = load();
  const rec = st.cartographers[norm(username)];
  if (rec) score += Math.min(Math.floor((rec.charts || 0) / 3), 2); // +2 for practice
  const logs = Object.values(st.logs).filter((l) => norm(l.author) === norm(username));
  score += Math.min(logs.length, 1); // +1 for a real travel journal
  return Math.max(1, Math.min(MAX_QUALITY, score));
}

function valueFor(type, quality) {
  const base = BASE_VALUE[type] || BASE_VALUE[MAP_CITY];
  return Math.round(base * (0.5 + quality / MAX_QUALITY));
}

// --- map creation -------------------------------------------------------------

function materialCost() {
  return [{ item: MAT_PAPYRUS, amount: 1, consumed: true }];
}

/**
 * Draft a map. The caller (brain action / life tick) MUST have already
 * removed the real papyrus from the creator's real inventory — this data
 * tier records the honest result. Dungeon and treasure maps require a REAL
 * discovery (defensive read of CitizenDiscovery); without one the call
 * honestly fails instead of inventing geography.
 */
function draftMap(username, kingdomId, type) {
  const st = load();
  if (!MAP_TYPES.includes(type)) return { ok: false, reason: "bad-type" };
  if (!username || !kingdomId) return { ok: false, reason: "no-identity" };

  let discovery = null;
  if (type === MAP_DUNGEON || type === MAP_TREASURE) {
    discovery = findUnmappedDiscovery(type);
    if (!discovery) return { ok: false, reason: "no-discovery" };
  }

  const quality = qualityFor(username);
  const value = valueFor(type, quality);
  const id = allocId("map");
  const map = {
    id,
    type,
    creator: String(username),
    kingdomId: String(kingdomId),
    quality,
    value,
    createdAt: Date.now(),
    discoveryId: discovery?.id ?? null,
  };
  st.maps[id] = map;

  // Treasure maps spawn a real loot cache at the discovery's real
  // coordinates. The cache pays real coins, first-come.
  if (type === MAP_TREASURE && discovery) {
    const cacheId = allocId("cache");
    const loot = Math.round(150 + quality * 35);
    st.caches[cacheId] = {
      id: cacheId,
      mapId: id,
      x: discovery.x ?? 0,
      y: discovery.y ?? 0,
      z: discovery.z ?? 0,
      coins: loot,
      claimedBy: null,
      claimedAt: 0,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    map.cacheId = cacheId;
  }

  noteChart(username);
  ensureShop(kingdomId);
  markDirty();
  return { ok: true, map, masterwork: quality >= MASTERWORK_QUALITY };
}

/**
 * Find a real discovery suitable for a dungeon or treasure map.
 * Defensive: returns null when CitizenDiscovery is unavailable.
 */
function findUnmappedDiscovery(type) {
  try {
    const Disc = require("./CitizenDiscovery");
    const kinds = type === MAP_TREASURE
      ? ["dungeon_entrance", "ancient_ruin", "monster_lair"]
      : ["dungeon_entrance", "ancient_ruin"];
    for (const k of kinds) {
      const list = Disc.discoveriesOfType?.(k) ?? [];
      const open = list.find((d) => d && !d.claimed);
      if (open) return open;
    }
    const all = Disc.allDiscoveries?.() ?? [];
    return all.find((d) => d && kinds.includes(d.type)) || null;
  } catch { return null; }
}

// --- shop transactions ----------------------------------------------------------

/**
 * List a drafted map for sale. Honest: the map must exist and not already
 * be listed. Price is the map's real value.
 */
function listMap(mapId) {
  const st = load();
  const map = st.maps[mapId];
  if (!map) return { ok: false, reason: "no-map" };
  if (st.listings[mapId]) return { ok: false, reason: "already-listed" };
  st.listings[mapId] = { mapId, price: map.value, listedAt: Date.now() };
  markDirty();
  return { ok: true, price: map.value };
}

/**
 * Compute a purchase: the buyer pays `price` real coins. The caller moves
 * the real coins (it has the players); this tier reports who gets what so
 * no coins are ever invented or lost. The creator gets 70%, the shop 30%.
 */
function purchaseQuote(mapId) {
  const st = load();
  const listing = st.listings[mapId];
  const map = listing && st.maps[mapId];
  if (!listing || !map) return { ok: false, reason: "not-listed" };
  const price = listing.price;
  const creatorShare = Math.round(price * CREATOR_CUT);
  return {
    ok: true,
    price,
    creator: map.creator,
    kingdomId: map.kingdomId,
    creatorShare,
    shopShare: price - creatorShare,
    map,
  };
}

/**
 * Complete a purchase after the caller moved real coins. Transfers the map
 * record to the buyer and clears the listing.
 */
function completePurchase(mapId, buyerUsername) {
  const st = load();
  const listing = st.listings[mapId];
  const map = listing && st.maps[mapId];
  if (!listing || !map) return { ok: false, reason: "not-listed" };
  map.owner = String(buyerUsername);
  map.soldAt = Date.now();
  delete st.listings[mapId];
  markDirty();
  return { ok: true, map };
}

function listingsFor(kingdomId) {
  const st = load();
  return Object.values(st.listings)
    .map((l) => ({ ...l, map: st.maps[l.mapId] }))
    .filter((l) => l.map && String(l.map.kingdomId) === String(kingdomId));
}

// --- exploration logs -----------------------------------------------------------

/**
 * Record a travel journal from a REAL completed journey. Called by the life
 * tick reading CitizenTravel arrivals defensively. Logs raise the author's
 * next-map quality — a human who has traveled writes better maps.
 */
function recordLog(author, from, to, mode) {
  const st = load();
  if (!author || !from || !to) return { ok: false, reason: "no-journey" };
  const id = allocId("log");
  st.logs[id] = {
    id,
    author: String(author),
    from: String(from),
    to: String(to),
    mode: String(mode || "caravan"),
    writtenAt: Date.now(),
  };
  markDirty();
  return { ok: true, id };
}

function logsBy(author) {
  const st = load();
  return Object.values(st.logs).filter((l) => norm(l.author) === norm(author));
}

// --- treasure caches --------------------------------------------------------------

/**
 * Claim a treasure cache. First-come: returns the real coin amount for the
 * caller to move. Honest — expired or already-claimed caches pay nothing.
 */
function claimCache(cacheId, claimer) {
  const st = load();
  const c = st.caches[cacheId];
  if (!c) return { ok: false, reason: "no-cache" };
  if (c.claimedBy) return { ok: false, reason: "claimed" };
  if (Date.now() > c.expiresAt) return { ok: false, reason: "expired" };
  c.claimedBy = String(claimer);
  c.claimedAt = Date.now();
  markDirty();
  return { ok: true, coins: c.coins, x: c.x, y: c.y, z: c.z };
}

function unclaimedCaches() {
  const st = load();
  const now = Date.now();
  return Object.values(st.caches).filter(
    (c) => !c.claimedBy && now <= c.expiresAt
  );
}

function pruneCaches() {
  const st = load();
  const now = Date.now();
  let n = 0;
  for (const id of Object.keys(st.caches)) {
    const c = st.caches[id];
    if ((c.claimedBy || now > c.expiresAt) && now - (c.claimedAt || c.expiresAt) > 7 * 24 * 60 * 60 * 1000) {
      delete st.caches[id];
      n++;
    }
  }
  if (n) markDirty();
  return n;
}

// --- navigation effect ------------------------------------------------------------

/**
 * Journey-time reduction percent for a kingdom, from real maps drafted by
 * its cartographers. Read defensively by CitizenTravel: a kingdom whose
 * roads are mapped travels them faster. Capped so maps stack gently.
 */
function mapNavigationBonusFor(kingdomId) {
  try {
    const st = load();
    const maps = Object.values(st.maps).filter(
      (m) => String(m.kingdomId) === String(kingdomId) && !m.soldAt
    );
    if (!maps.length) return 0;
    const total = maps.reduce((s, m) => s + (m.quality || 1), 0);
    return Math.min(MAX_NAV_BONUS, Math.round(total / 4));
  } catch { return 0; }
}

// --- describe (chat seam) ----------------------------------------------------------

function describe(kingdomId) {
  const st = load();
  const maps = Object.values(st.maps).filter(
    (m) => String(m.kingdomId) === String(kingdomId)
  );
  const listings = listingsFor(kingdomId);
  const caches = unclaimedCaches().filter((c) => {
    const m = st.maps[c.mapId];
    return m && String(m.kingdomId) === String(kingdomId);
  });
  return {
    mapCount: maps.length,
    listingCount: listings.length,
    cheapest: listings.length ? Math.min(...listings.map((l) => l.price)) : null,
    treasureRumors: caches.length,
    cartographerCount: cartographerCount(kingdomId),
  };
}

module.exports = {
  MAP_TYPES,
  MAP_WORLD,
  MAP_CITY,
  MAP_DUNGEON,
  MAP_TREASURE,
  MAT_PAPYRUS,
  registerCartographer,
  isCartographer,
  cartographerCount,
  shopTileFor,
  ensureShop,
  shopOf,
  qualityFor,
  valueFor,
  materialCost,
  draftMap,
  listMap,
  purchaseQuote,
  completePurchase,
  listingsFor,
  recordLog,
  logsBy,
  claimCache,
  unclaimedCaches,
  pruneCaches,
  mapNavigationBonusFor,
  describe,
  save,
  resetForTests,
};
