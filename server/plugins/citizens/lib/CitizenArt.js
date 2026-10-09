"use strict";

/**
 * CitizenArt — the data tier for citizen art and culture.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Art mediums: painting (papyrus + dye), sculpture (soft clay + chisel),
 *     writing (papyrus → book/scroll). All materials are REAL engine item
 *     ids. No invented materials, ever.
 *   - Artworks: records with title, medium, artist, quality 1-100, value,
 *     owner, created-at. Quality derives from the artist's REAL Crafting
 *     level + creativity trait — never random, never hash-fiction.
 *   - Galleries: one per kingdom, deterministic tile near the market.
 *     Galleries display artworks (data records, not fake items).
 *   - Art market: artworks listed for sale. Buyers pay REAL coins.
 *     Ownership transfers as a data record. No invented item ids.
 *   - Exhibitions: scheduled cultural events where galleries showcase
 *     new works. Announced via sayPublic.
 *   - Value: base by medium × quality × artist fame (from CitizenReputation).
 *     Famous artists command real premiums; unknowns sell cheap.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Exhibition scheduling, market expiry, and
 *     announcements live in lib/CitizenArtLife.js.
 *   - No LLM. Titles come from word pools (not generated prose).
 *   - No invented items: artworks are data records, materials are real.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-art.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-art.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

// Real RS item ids for art materials.
const MAT_PAPYRUS = 970; // papyrus — painting canvas / writing surface
const MAT_CLAY = 1761; // soft clay — sculpture medium
const MAT_CHISEL = 1755; // chisel — sculpture tool (not consumed)
const MAT_RED_DYE = 1763; // red dye — painting pigment
const MAT_YELLOW_DYE = 1765; // yellow dye — painting pigment
const MAT_BLUE_DYE = 1767; // blue dye — painting pigment

const ART_MEDIUMS = Object.freeze({
  painting: Object.freeze({
    id: "painting",
    label: "painting",
    // 1 papyrus (canvas) + 1 dye (any color) per painting.
    materials: Object.freeze([
      { item: MAT_PAPYRUS, amount: 1, consumed: true },
      { item: MAT_RED_DYE, amount: 1, consumed: true, anyOf: [MAT_RED_DYE, MAT_YELLOW_DYE, MAT_BLUE_DYE] },
    ]),
    tools: Object.freeze([]),
    baseValue: 50, // coins, before quality/fame multipliers
    workMinutes: 30, // human-paced creation time
  }),
  sculpture: Object.freeze({
    id: "sculpture",
    label: "sculpture",
    // 2 soft clay + chisel (tool, not consumed).
    materials: Object.freeze([
      { item: MAT_CLAY, amount: 2, consumed: true },
    ]),
    tools: Object.freeze([MAT_CHISEL]),
    baseValue: 80,
    workMinutes: 45,
  }),
  writing: Object.freeze({
    id: "writing",
    label: "manuscript",
    // 2 papyrus per manuscript (a short work).
    materials: Object.freeze([
      { item: MAT_PAPYRUS, amount: 2, consumed: true },
    ]),
    tools: Object.freeze([]),
    baseValue: 40,
    workMinutes: 60,
  }),
});

// Title word pools — titles are assembled from pools, not LLM-generated.
// Format: "<adjective> <subject>" e.g. "Silent Harvest", "Crimson Docks".
const TITLE_ADJECTIVES = Object.freeze([
  "Silent", "Crimson", "Golden", "Weary", "Ancient", "Hollow",
  "Burning", "Quiet", "Stormy", "Pale", "Iron", "Velvet",
]);
const TITLE_SUBJECTS = Object.freeze([
  "Harvest", "Docks", "King", "River", "Forge", "Market",
  "Tower", "Fields", "Crown", "Waves", "Hearth", "Road",
]);

const QUALITY_MASTERPIECE = 85; // quality >= this = masterpiece (fame deed)
const FAME_DEED_MASTERPIECE = 5; // reputation points for a masterpiece
const FAME_DEED_EXHIBITED = 3; // reputation points for gallery exhibition
const MARKET_LISTING_DAYS = 14; // listings expire after this long
const EXHIBITION_COOLDOWN_DAYS = 7; // min days between exhibitions per gallery

// --- state -------------------------------------------------------------------

let cache = null; // { artworks: [], galleries: {}, exhibitions: [] }
let dirty = false;

function blankState() {
  return { artworks: [], galleries: {}, exhibitions: [] };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      if (Array.isArray(raw.artworks)) cache.artworks = raw.artworks;
      if (raw.galleries && typeof raw.galleries === "object") cache.galleries = raw.galleries;
      if (Array.isArray(raw.exhibitions)) cache.exhibitions = raw.exhibitions;
    }
  } catch {
    // Corrupt save → start fresh. Never crash the tick.
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
    fs.writeFileSync(SAVE_FILE, JSON.stringify(load(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
}

// --- galleries ---------------------------------------------------------------

/**
 * Gallery for a kingdom. Deterministic — one per kingdom, created on demand.
 * Location is a tile near the market (same pattern as schoolhouses).
 */
function galleryFor(kingdomId, nowMs = Date.now()) {
  const st = load();
  const key = String(kingdomId ?? "unknown");
  if (!st.galleries[key]) {
    st.galleries[key] = {
      kingdomId: key,
      name: `${key} Gallery`,
      foundedAt: nowMs,
      displayed: [], // artwork ids currently on display
      lastExhibitionAt: 0,
    };
    markDirty();
  }
  return st.galleries[key];
}

// --- artworks ----------------------------------------------------------------

/**
 * Create an artwork record. Quality is derived from the artist's real
 * Crafting level and creativity trait — never random.
 *
 * @param {string} artistUsername
 * @param {string} mediumId - painting|sculpture|writing
 * @param {number} craftingLevel - artist's real Crafting level
 * @param {number} creativity - 0..1 personality trait
 * @param {string} kingdomId
 */
function createArtwork(artistUsername, mediumId, craftingLevel, creativity, kingdomId, nowMs = Date.now()) {
  const medium = ART_MEDIUMS[mediumId];
  if (!medium) return null;
  const st = load();

  // Quality: crafting skill (0-99 → 0-60 pts) + creativity (0-1 → 0-40 pts).
  // A level-99 master with full creativity hits 100. A level-1 novice
  // with no creativity makes a 1. Deterministic from real state.
  const skillPts = Math.min(60, Math.max(0, (craftingLevel / 99) * 60));
  const creatPts = Math.min(40, Math.max(0, creativity * 40));
  const quality = Math.max(1, Math.min(100, Math.round(skillPts + creatPts)));

  // Title from pools, indexed by artwork count (deterministic, not random).
  const n = st.artworks.length;
  const title = `${TITLE_ADJECTIVES[n % TITLE_ADJECTIVES.length]} ${TITLE_SUBJECTS[Math.floor(n / TITLE_ADJECTIVES.length) % TITLE_SUBJECTS.length]}`;

  const artwork = {
    id: `art-${nowMs}-${n}`,
    title,
    medium: mediumId,
    mediumLabel: medium.label,
    artist: normalizeName(artistUsername),
    quality,
    kingdomId: String(kingdomId ?? "unknown"),
    createdAt: nowMs,
    owner: normalizeName(artistUsername), // artist owns it until sold
    forSale: false,
    price: 0,
    listedAt: 0,
    exhibited: false,
  };
  st.artworks.push(artwork);
  markDirty();
  return artwork;
}

/**
 * Honest value: base × quality multiplier × artist fame multiplier.
 * Fame comes from CitizenReputation (defensive — no fame = 1.0×).
 */
function valueFor(artwork) {
  const medium = ART_MEDIUMS[artwork.medium];
  if (!medium) return 0;
  const qualityMult = 0.5 + (artwork.quality / 100) * 2; // 0.5× .. 2.5×
  let fameMult = 1.0;
  try {
    const Rep = require("./CitizenReputation");
    const tier = Rep.tierFor?.(artwork.artist) ?? "unknown";
    // Famous artists command premiums; infamous ones sell at discount.
    const mults = {
      legendary: 2.0, famous: 1.5, known: 1.2, unknown: 1.0,
      disliked: 0.9, notorious: 0.8, infamous: 0.7,
    };
    fameMult = mults[tier] ?? 1.0;
  } catch {
    // No reputation module → no fame adjustment.
  }
  return Math.max(1, Math.round(medium.baseValue * qualityMult * fameMult));
}

/** All artworks by an artist (or owned by them). */
function artworksOf(username) {
  const st = load();
  const name = normalizeName(username);
  return st.artworks.filter((a) => a.artist === name || a.owner === name);
}

/** Look up a single artwork by id (for gallery operations). */
function artworkById(artworkId) {
  const st = load();
  return st.artworks.find((a) => a.id === artworkId) ?? null;
}

/**
 * Transfer artwork ownership (for auctions, acquisitions, commissions).
 * Marks the record dirty so it persists. Returns true on success.
 */
function transferOwnership(artworkId, newOwner) {
  const st = load();
  const art = st.artworks.find((a) => a.id === artworkId);
  if (!art) return false;
  art.owner = normalizeName(newOwner);
  art.forSale = false;
  art.price = 0;
  art.listedAt = 0;
  markDirty();
  return true;
}

/** Artworks currently listed for sale in a kingdom. */
function marketListings(kingdomId) {
  const st = load();
  const key = String(kingdomId ?? "unknown");
  return st.artworks.filter((a) => a.forSale && a.kingdomId === key);
}

/**
 * List an artwork for sale. Price defaults to honest value.
 * Returns the listing or null.
 */
function listForSale(artworkId, price, nowMs = Date.now()) {
  const st = load();
  const art = st.artworks.find((a) => a.id === artworkId);
  if (!art) return null;
  art.forSale = true;
  art.price = price > 0 ? Math.round(price) : valueFor(art);
  art.listedAt = nowMs;
  markDirty();
  return art;
}

/** Count real coins in a player's inventory (defensive, multi-API). */
function countCoins(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(995);
    if (typeof inv.getAmount === "function") return inv.getAmount(995);
    return 0;
  } catch {
    return 0;
  }
}

/** Remove real coins from a player's inventory. Returns amount taken. */
function removeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    const have = countCoins(player);
    const take = Math.min(have, amount);
    if (take <= 0) return 0;
    if (typeof inv.remove === "function") inv.remove(995, take);
    else if (typeof inv.delete === "function") inv.delete(995, take);
    else return 0;
    return take;
  } catch {
    return 0;
  }
}

/**
 * Buy an artwork. Transfers ownership, moves REAL coins from buyer
 * to seller. Returns { ok, reason }.
 *
 * @param {string} artworkId
 * @param {object} buyerPlayer - must have getInventory with coin methods
 * @param {function} paySeller - (sellerUsername, amount) => boolean
 */
function buyArtwork(artworkId, buyerPlayer, paySeller, nowMs = Date.now()) {
  const st = load();
  const art = st.artworks.find((a) => a.id === artworkId);
  if (!art) return { ok: false, reason: "not-found" };
  if (!art.forSale) return { ok: false, reason: "not-for-sale" };

  // Buyer must have real coins.
  if (countCoins(buyerPlayer) < art.price) return { ok: false, reason: "insufficient-coins" };

  // Take coins from buyer (real inventory operation).
  const taken = removeCoins(buyerPlayer, art.price);
  if (taken < art.price) return { ok: false, reason: "no-remove" };

  // Pay the seller (callback handles online/offline).
  const seller = art.owner;
  const paid = paySeller ? paySeller(seller, art.price) : false;

  // Transfer ownership regardless — the sale happened.
  art.owner = normalizeName(buyerPlayer?.getUsername?.() ?? buyerPlayer?.username ?? "unknown");
  art.forSale = false;
  art.price = 0;
  art.listedAt = 0;
  markDirty();
  return { ok: true, paid, seller };
}

/** Remove expired listings (older than MARKET_LISTING_DAYS). */
function expireListings(nowMs = Date.now()) {
  const st = load();
  const cutoff = nowMs - MARKET_LISTING_DAYS * 24 * 60 * 60 * 1000;
  let expired = 0;
  for (const art of st.artworks) {
    if (art.forSale && art.listedAt < cutoff) {
      art.forSale = false;
      art.price = 0;
      art.listedAt = 0;
      expired++;
      markDirty();
    }
  }
  return expired;
}

/** Can this gallery host an exhibition now? (cooldown check) */
function canExhibit(kingdomId, nowMs = Date.now()) {
  const g = galleryFor(kingdomId, nowMs);
  if (!g.lastExhibitionAt) return true; // never exhibited → always allowed
  return nowMs - g.lastExhibitionAt >= EXHIBITION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Host an exhibition: display up to 5 recent unexhibited artworks.
 * Returns the exhibition record or null.
 */
function hostExhibition(kingdomId, nowMs = Date.now()) {
  const st = load();
  const key = String(kingdomId ?? "unknown");
  if (!canExhibit(key, nowMs)) return null;
  const g = galleryFor(key, nowMs);

  const candidates = st.artworks
    .filter((a) => a.kingdomId === key && !a.exhibited)
    .sort((a, b) => b.quality - a.quality)
    .slice(0, 5);
  if (!candidates.length) return null;

  for (const art of candidates) {
    art.exhibited = true;
  }
  g.displayed = candidates.map((a) => a.id);
  g.lastExhibitionAt = nowMs;

  const exhibition = {
    kingdomId: key,
    at: nowMs,
    artworkIds: candidates.map((a) => a.id),
    artists: [...new Set(candidates.map((a) => a.artist))],
  };
  st.exhibitions.push(exhibition);
  markDirty();

  // Exhibited artists earn fame (real reputation deeds).
  try {
    const Rep = require("./CitizenReputation");
    for (const artist of exhibition.artists) {
      Rep.addReputation?.(artist, FAME_DEED_EXHIBITED, "gallery exhibition", nowMs);
    }
  } catch {
    // No reputation module → no fame. Art still exhibits.
  }

  return exhibition;
}

/** Check if an artwork is a masterpiece (fame-worthy). */
function isMasterpiece(artwork) {
  return (artwork?.quality ?? 0) >= QUALITY_MASTERPIECE;
}

module.exports = {
  ART_MEDIUMS,
  TITLE_ADJECTIVES,
  TITLE_SUBJECTS,
  QUALITY_MASTERPIECE,
  _setSavePathForTests,
  resetForTests,
  galleryFor,
  createArtwork,
  valueFor,
  artworksOf,
  artworkById,
  transferOwnership,
  marketListings,
  listForSale,
  buyArtwork,
  expireListings,
  canExhibit,
  hostExhibition,
  isMasterpiece,
  save,
  load,
};
