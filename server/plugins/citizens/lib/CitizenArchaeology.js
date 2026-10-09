"use strict";

/**
 * CitizenArchaeology — the REAL archaeology layer: dig sites, artifacts,
 * museums, and restoration.
 *
 * No-overlap boundary:
 *   - CitizenExplorers owns expeditions and discoveries (this only READS
 *     finished expeditions via the public finishedExpeditions() seam —
 *     dig sites are founded from REAL discoveries, never invented).
 *   - CitizenArt owns art galleries (visual art display). This owns the
 *     archaeological MUSEUM (historical artifacts, prestige, curation).
 *   - CitizenMaps owns map drafting. This never invents geography: every
 *     dig site traces to a real explorer discovery record.
 *
 * How it works:
 *   - Dig sites are founded from finished explorer discoveries whose name
 *     smells ancient (ancient/forgotten/buried/sunken/lost/sealed/tomb/
 *     crypt/vault/hoard/old). Attributes (richness, slots, artifact kinds)
 *     are DETERMINISTIC from the discovery record — the site genuinely
 *     "contains" what the discovery promised.
 *   - Archaeologists excavate in human-paced rounds. Each completed dig
 *     yields a real artifact record with a real coin value and a history
 *     written from real data (site, kingdom, discoverer — template frames,
 *     never invented facts).
 *   - Artifacts can be donated to the kingdom museum (prestige + fame),
 *     sold to the museum fund for real coins, or restored (damaged →
 *     repaired → pristine) for a real coin fee.
 *   - Players dig via ::dig (CitizenArchaeologyEvents). Bots are rejected
 *     there; citizens dig through the brain (CitizenExcavate) or the tick.
 *
 * Zero LLM. Tick-safe: every engine read guarded. Plain-node testable.
 */

const { agentRng } = require("./humanizer");

// === Tuning ===
const SAVE_KEY = "citizen-archaeology.json";
const SITE_KEYWORDS = Object.freeze([
  "ancient", "forgotten", "buried", "sunken", "lost", "sealed",
  "tomb", "crypt", "vault", "cache", "hoard", "old", "ruin",
]);
const SITE_TTL_MS = 14 * 24 * 3600 * 1000; // dig sites exhaust or go cold after 14 days

// Artifact kinds: base value ranges (coins) and lore frames.
const ARTIFACT_KINDS = Object.freeze({
  pottery:  Object.freeze({ label: "pottery",  min: 40,   max: 220,  weight: 30 }),
  tablet:   Object.freeze({ label: "tablet",   min: 250,  max: 900,  weight: 18 }),
  jewelry:  Object.freeze({ label: "jewelry",  min: 450,  max: 1600, weight: 16 }),
  weapon:   Object.freeze({ label: "weapon",   min: 300,  max: 1200, weight: 14 }),
  statue:   Object.freeze({ label: "statue",   min: 900,  max: 3200, weight: 10 }),
  hoard:    Object.freeze({ label: "coin hoard", min: 700, max: 2200, weight: 12 }),
});
const CONDITION_MULT = Object.freeze({ fragmented: 0.4, damaged: 0.7, pristine: 1.0 });
const RESTORE_FEE_BPS = 1000; // 10% of current value
const MUSEUM_FUND_WEEKLY = 500; // coins accrued from the kingdom purse
const MAJOR_FIND_VALUE = 1500; // announcements for finds worth this much+

// History frames — filled ONLY from real data (site/discovery/kingdom/finder).
const HISTORY_FRAMES = Object.freeze([
  "Unearthed at {site} by {finder}. The old {discovery} gave up its dead.",
  "{finder} pulled this from the earth at {site}, where {discovery} once stood.",
  "Recovered from {site} ({kingdom}) by {finder} — a relic of {discovery}.",
  "Dug from {site} by {finder}. Scholars say it dates to the days of {discovery}.",
]);

// === State ===
let cache = null;
let dirty = false;
let nextSiteId = 1;
let nextArtifactId = 1;

function blankState() {
  return {
    sites: {},        // siteId -> site
    sitedDiscoveries: {}, // "expId:name" -> siteId (idempotence)
    artifacts: {},    // artifactId -> artifact
    museums: {},      // kingdomId -> { tile, prestige, fund, fundAccruedAt, donations }
    archaeologists: {}, // usernameLower -> { username, kingdomId, registeredAt, digs }
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
        if (typeof raw.nextSiteId === "number") nextSiteId = raw.nextSiteId;
        if (typeof raw.nextArtifactId === "number") nextArtifactId = raw.nextArtifactId;
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
    st.nextSiteId = nextSiteId;
    st.nextArtifactId = nextArtifactId;
    const p = savePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(st, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

// --- tiles ------------------------------------------------------------------

/** Museum tile: deterministic, near the market (different offset from map shop). */
function museumTileFor(kingdomId) {
  try {
    const { siteTile } = require("../brain/CitizenSites");
    const market = siteTile(kingdomId, "market");
    if (!market) return null;
    return { x: (market.x || 0) + 30, y: (market.y || 0) - 18, z: market.z || 0 };
  } catch { return null; }
}

/** Dig-site tile: near the museum, spread by seeded offset so sites don't stack. */
function siteTileFor(kingdomId, siteId) {
  try {
    const m = ensureMuseum(kingdomId).tile || museumTileFor(kingdomId);
    if (!m) return null;
    const rng = agentRng(`digsite:${kingdomId}:${siteId}`);
    const ang = rng() * Math.PI * 2;
    const dist = 18 + Math.floor(rng() * 30);
    return {
      x: Math.round(m.x + Math.cos(ang) * dist),
      y: Math.round(m.y + Math.sin(ang) * dist),
      z: m.z || 0,
    };
  } catch { return null; }
}

function ensureMuseum(kingdomId) {
  const st = load();
  const k = String(kingdomId);
  if (!st.museums[k]) {
    st.museums[k] = {
      kingdomId: k,
      tile: museumTileFor(kingdomId),
      prestige: 0,
      fund: 0,
      fundAccruedAt: Date.now(),
      donations: 0,
      foundedAt: Date.now(),
    };
    markDirty();
  }
  return st.museums[k];
}

// --- archaeologists -----------------------------------------------------------

function registerArchaeologist(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key) return { ok: false, reason: "no identity" };
  if (st.archaeologists[key]) return { ok: true, already: true };
  st.archaeologists[key] = {
    username: String(username),
    kingdomId: String(kingdomId || "unknown"),
    registeredAt: Date.now(),
    digs: 0,
  };
  markDirty();
  return { ok: true, already: false };
}

function isArchaeologist(username) {
  return Boolean(load().archaeologists[norm(username)]);
}

function archaeologistCount(kingdomId) {
  const st = load();
  const k = String(kingdomId);
  return Object.values(st.archaeologists).filter((a) => a.kingdomId === k).length;
}

// --- dig sites ----------------------------------------------------------------

/** Honest: a discovery can seed a dig site only if its name smells ancient. */
function discoveryIsDiggable(discovery) {
  const name = String(discovery?.name || "").toLowerCase();
  return SITE_KEYWORDS.some((kw) => name.includes(kw));
}

function discoveryKey(expId, discovery) {
  return `${expId}:${String(discovery?.name || "").toLowerCase()}`;
}

/**
 * Found a dig site from a REAL explorer discovery. Deterministic attributes
 * from the discovery record. Idempotent: the same discovery never founds
 * two sites. Returns { ok, site?, already?, reason? }.
 */
function foundSiteFromDiscovery(expeditionId, discovery, kingdomId, founder) {
  const st = load();
  if (!discoveryIsDiggable(discovery)) return { ok: false, reason: "not ancient enough" };
  const key = discoveryKey(expeditionId, discovery);
  if (st.sitedDiscoveries[key]) {
    return { ok: true, already: true, site: st.sites[st.sitedDiscoveries[key]] || null };
  }
  const rng = agentRng(`digsite-seed:${key}`);
  const richness = 2 + Math.floor(rng() * 9); // 2..10 — the discovery promised *something*
  const totalSlots = 3 + Math.floor(rng() * (richness + 2)); // richer sites hold more
  const site = {
    id: `site-${nextSiteId++}`,
    kingdomId: String(kingdomId || "unknown"),
    name: `Dig at ${String(discovery.name || "the old find").replace(/^(a|an)\s+/i, "")}`,
    discoveryName: String(discovery.name || ""),
    discoveryId: key,
    founder: founder || null,
    foundedAt: Date.now(),
    richness,
    totalSlots,
    slotsLeft: totalSlots,
    digCount: 0,
    tile: null, // filled below
  };
  site.tile = siteTileFor(site.kingdomId, site.id);
  st.sites[site.id] = site;
  st.sitedDiscoveries[key] = site.id;
  markDirty();
  return { ok: true, site };
}

function siteOf(siteId) {
  return load().sites[String(siteId)] || null;
}

function activeSites(kingdomId) {
  const now = Date.now();
  const k = kingdomId ? String(kingdomId) : null;
  return Object.values(load().sites).filter((s) => {
    if (k && s.kingdomId !== k) return false;
    if ((s.slotsLeft ?? 0) <= 0) return false;
    if (now - (s.foundedAt ?? 0) > SITE_TTL_MS) return false;
    return true;
  });
}

function pruneSites(nowMs) {
  const st = load();
  const now = nowMs ?? Date.now();
  let n = 0;
  for (const [id, s] of Object.entries(st.sites)) {
    if ((s.slotsLeft ?? 0) <= 0 || now - (s.foundedAt ?? 0) > SITE_TTL_MS) {
      delete st.sites[id];
      n++;
    }
  }
  if (n) markDirty();
  return n;
}

// --- artifacts ----------------------------------------------------------------

function pickKind(rng) {
  const kinds = Object.keys(ARTIFACT_KINDS);
  const total = kinds.reduce((a, k) => a + ARTIFACT_KINDS[k].weight, 0);
  let r = rng() * total;
  for (const k of kinds) {
    r -= ARTIFACT_KINDS[k].weight;
    if (r <= 0) return k;
  }
  return "pottery";
}

function pickCondition(rng) {
  const r = rng();
  if (r < 0.25) return "pristine";
  if (r < 0.65) return "damaged";
  return "fragmented";
}

function artifactValue(kind, condition, richness) {
  const spec = ARTIFACT_KINDS[kind] || ARTIFACT_KINDS.pottery;
  const base = spec.min + (spec.max - spec.min) * (richness / 10);
  return Math.max(10, Math.round(base * (CONDITION_MULT[condition] ?? 0.5)));
}

function historyFor(site, finder) {
  const frame = HISTORY_FRAMES[Math.floor(agentRng(`hist:${site.id}`)() * HISTORY_FRAMES.length)];
  return frame
    .replace("{site}", site.name)
    .replace("{finder}", String(finder || "an unknown digger"))
    .replace("{discovery}", site.discoveryName.replace(/^(a|an)\s+/i, ""))
    .replace("{kingdom}", site.kingdomId);
}

/**
 * Excavate one artifact from a site. Deterministic per (site, digCount) —
 * the site genuinely contains these finds in this order. Honest failures:
 * unknown/exhausted site. Returns { ok, artifact?, reason? }.
 */
function excavate(username, siteId) {
  const st = load();
  const site = st.sites[String(siteId)];
  if (!site) return { ok: false, reason: "no such dig site" };
  if ((site.slotsLeft ?? 0) <= 0) return { ok: false, reason: "site exhausted" };
  if (Date.now() - (site.foundedAt ?? 0) > SITE_TTL_MS) return { ok: false, reason: "site gone cold" };

  const rng = agentRng(`dig:${site.id}:${site.digCount}`);
  const kind = pickKind(rng);
  const condition = pickCondition(rng);
  const value = artifactValue(kind, condition, site.richness);
  const artifact = {
    id: `art-${nextArtifactId++}`,
    siteId: site.id,
    kingdomId: site.kingdomId,
    kind,
    name: `${condition} ${ARTIFACT_KINDS[kind].label}`,
    condition,
    value,
    history: historyFor(site, username),
    finder: String(username || "unknown"),
    foundAt: Date.now(),
    owner: norm(username) || null,
    donated: false,
    displayedAt: null,
  };
  site.slotsLeft -= 1;
  site.digCount += 1;
  st.artifacts[artifact.id] = artifact;
  const arch = st.archaeologists[norm(username)];
  if (arch) arch.digs = (arch.digs || 0) + 1;
  markDirty();
  return { ok: true, artifact, major: value >= MAJOR_FIND_VALUE };
}

function artifactOf(artifactId) {
  return load().artifacts[String(artifactId)] || null;
}

function artifactsOfOwner(username) {
  const key = norm(username);
  return Object.values(load().artifacts).filter((a) => a.owner === key && !a.donated);
}

function museumCollection(kingdomId) {
  const k = String(kingdomId);
  return Object.values(load().artifacts).filter((a) => a.donated && a.kingdomId === k);
}

/** Donate an artifact to the kingdom museum. Real prestige, real record. */
function donateArtifact(username, artifactId) {
  const st = load();
  const a = st.artifacts[String(artifactId)];
  if (!a) return { ok: false, reason: "no such artifact" };
  if (a.owner !== norm(username)) return { ok: false, reason: "not yours to donate" };
  if (a.donated) return { ok: false, reason: "already in the museum" };
  a.donated = true;
  a.displayedAt = Date.now();
  a.owner = null;
  const museum = ensureMuseum(a.kingdomId);
  museum.donations += 1;
  museum.prestige += 1 + Math.floor(a.value / 1000); // real prestige from real value
  markDirty();
  return { ok: true, artifact: a, museum };
}

function accrueMuseumFund(kingdomId, nowMs) {
  const museum = ensureMuseum(kingdomId);
  const now = nowMs ?? Date.now();
  const weeks = Math.floor((now - (museum.fundAccruedAt ?? now)) / (7 * 24 * 3600 * 1000));
  if (weeks > 0) {
    museum.fund += weeks * MUSEUM_FUND_WEEKLY;
    museum.fundAccruedAt = now;
    markDirty();
  }
  return museum.fund;
}

/**
 * Sell an artifact to the museum fund for real coins. Honest: the fund must
 * actually cover the price, and the seller must hold the artifact.
 * `pay` is a (botLike, coins) => boolean coin granter supplied by the caller
 * (keeps this module engine-agnostic and testable).
 */
function sellArtifactToMuseum(username, artifactId, pay) {
  const st = load();
  const a = st.artifacts[String(artifactId)];
  if (!a) return { ok: false, reason: "no such artifact" };
  if (a.owner !== norm(username)) return { ok: false, reason: "not yours to sell" };
  if (a.donated) return { ok: false, reason: "already in the museum" };
  const museum = ensureMuseum(a.kingdomId);
  accrueMuseumFund(a.kingdomId, Date.now());
  if (museum.fund < a.value) return { ok: false, reason: "museum cannot afford it" };
  let paid = false;
  try { paid = pay ? pay(username, a.value) === true : false; } catch { paid = false; }
  if (!paid) return { ok: false, reason: "payment failed" };
  museum.fund -= a.value;
  a.donated = true;
  a.displayedAt = Date.now();
  a.owner = null;
  museum.donations += 1;
  museum.prestige += 1 + Math.floor(a.value / 1000);
  markDirty();
  return { ok: true, artifact: a, price: a.value };
}

/**
 * Restore an artifact one condition step (fragmented→damaged→pristine).
 * Real coin fee (10% of current value) via `takeFee(botLike, coins) => bool`.
 */
function restoreArtifact(username, artifactId, takeFee) {
  const st = load();
  const a = st.artifacts[String(artifactId)];
  if (!a) return { ok: false, reason: "no such artifact" };
  if (a.owner !== norm(username)) return { ok: false, reason: "not yours to restore" };
  if (a.donated) return { ok: false, reason: "museum pieces are already curated" };
  const next = a.condition === "fragmented" ? "damaged" : a.condition === "damaged" ? "pristine" : null;
  if (!next) return { ok: false, reason: "already pristine" };
  const fee = Math.max(5, Math.round(a.value * (RESTORE_FEE_BPS / 10000)));
  let paid = false;
  try { paid = takeFee ? takeFee(username, fee) === true : false; } catch { paid = false; }
  if (!paid) return { ok: false, reason: "could not pay the restoration fee" };
  a.condition = next;
  a.name = `${next} ${ARTIFACT_KINDS[a.kind].label}`;
  // Re-value at the site's richness (stored on the site record).
  const site = st.sites[a.siteId];
  a.value = artifactValue(a.kind, next, site ? site.richness : 5);
  markDirty();
  return { ok: true, artifact: a, fee };
}

function museumStatus(kingdomId) {
  const museum = ensureMuseum(kingdomId);
  accrueMuseumFund(kingdomId, Date.now());
  const collection = museumCollection(kingdomId);
  return {
    kingdomId: String(kingdomId),
    tile: museum.tile,
    prestige: museum.prestige,
    fund: museum.fund,
    donations: museum.donations,
    displayed: collection.length,
    finest: collection.sort((a, b) => b.value - a.value).slice(0, 3).map((a) => ({
      name: a.name, value: a.value, finder: a.finder,
    })),
  };
}

function describe() {
  const st = load();
  return {
    sites: Object.keys(st.sites).length,
    artifacts: Object.keys(st.artifacts).length,
    archaeologists: Object.keys(st.archaeologists).length,
    museums: Object.keys(st.museums).length,
  };
}

function resetForTests() {
  cache = blankState();
  dirty = false;
  nextSiteId = 1;
  nextArtifactId = 1;
}

/**
 * Additive read accessor (for the Excavators' Guild): real lifetime dig
 * count for a registered archaeologist. Used to gate guild promotion —
 * never invented, 0 when unknown.
 */
function digCountFor(username) {
  const rec = load().archaeologists[norm(username)];
  return rec ? (rec.digs || 0) : 0;
}

module.exports = {
  SAVE_KEY,
  SITE_KEYWORDS,
  SITE_TTL_MS,
  ARTIFACT_KINDS,
  MAJOR_FIND_VALUE,
  registerArchaeologist,
  isArchaeologist,
  archaeologistCount,
  discoveryIsDiggable,
  foundSiteFromDiscovery,
  siteOf,
  activeSites,
  pruneSites,
  excavate,
  artifactOf,
  artifactsOfOwner,
  museumCollection,
  donateArtifact,
  accrueMuseumFund,
  sellArtifactToMuseum,
  restoreArtifact,
  ensureMuseum,
  museumTileFor,
  siteTileFor,
  museumStatus,
  describe,
  digCountFor,
  save,
  resetForTests,
};
