"use strict";

/**
 * CitizenDiscovery — persistent registry of citizen-made discoveries.
 *
 * Complements (does not duplicate) CitizenExplorers: that module runs the
 * abstract expedition simulation (muster -> journey -> return with tales).
 * This module is the REAL discovery layer: discoveries have coordinates,
 * persist to disk, and have game-mechanical consequences.
 *
 * Discovery types:
 *   - resource_node: a new mining/fishing/woodcutting spot (real skilling site)
 *   - dungeon_entrance: a dangerous location (real danger, real loot potential)
 *   - trade_route: a new overland route between two points (feeds CitizenTravel)
 *   - ancient_ruin: flavor + fame (real reputation deed)
 *   - monster_lair: danger that guards should clear (feeds CitizenGuards)
 *
 * Discoveries are found by the CitizenExplore brain action (physical
 * exploration) and by CitizenExplorers expeditions (abstract). Both write
 * here. Discoveries persist in data/saves/citizen-discoveries.json.
 *
 * Kingdom integration: discoveries within a kingdom's territory can be
 * "claimed" — claimed resource nodes boost that kingdom's economy,
 * claimed dungeons become guard patrol targets.
 *
 * Trade integration: trade_route discoveries are offered to CitizenTravel
 * as candidate routes (it decides whether to adopt them).
 *
 * Zero LLM. All state transitions are pure functions of stored state.
 * Plain-node testable: CitizenDiscovery.test.js.
 */

const { getJournal } = require("./CitizenJournal");

// --- tuning ---------------------------------------------------------------

const DISCOVERY_TYPES = Object.freeze({
  resource_node: Object.freeze({ label: "resource node", fame: 3 }),
  dungeon_entrance: Object.freeze({ label: "dungeon entrance", fame: 8 }),
  trade_route: Object.freeze({ label: "trade route", fame: 5 }),
  ancient_ruin: Object.freeze({ label: "ancient ruin", fame: 6 }),
  monster_lair: Object.freeze({ label: "monster lair", fame: 4 }),
});

// How far from a kingdom capital a discovery can be and still be claimable.
const CLAIM_RADIUS = 100;

// --- state -----------------------------------------------------------------

let cache = null; // { discoveries: { [id]: discovery } }
let dirty = false;
let nextId = 1;

function blankState() {
  return { discoveries: Object.create(null) };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    const path = require("path");
    const file = path.join(
      __dirname, "..", "..", "data", "saves", "citizen-discoveries.json"
    );
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      cache = { discoveries: Object.create(null) };
      for (const [id, d] of Object.entries(raw.discoveries ?? {})) {
        cache.discoveries[id] = d;
        const n = parseInt(id.replace("disc-", ""), 10);
        if (!Number.isNaN(n) && n >= nextId) nextId = n + 1;
      }
    }
  } catch {
    cache = blankState();
  }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "..", "data", "saves");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "citizen-discoveries.json");
    fs.writeFileSync(file, JSON.stringify({ discoveries: load().discoveries }, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a new discovery. Returns the discovery record.
 * Pure given inputs: (type, x, y, z, discoverer, name) => discovery.
 */
function recordDiscovery(type, x, y, z, discoverer, name) {
  if (!DISCOVERY_TYPES[type]) return null;
  const st = load();
  const id = `disc-${nextId++}`;
  const d = {
    id,
    type,
    x, y, z,
    discoverer: String(discoverer ?? "unknown"),
    name: String(name ?? `${DISCOVERY_TYPES[type].label} ${id}`),
    foundAt: Date.now(),
    claimedBy: null,      // kingdomId once claimed
    mappedBy: null,       // cartographer username once mapped
    tradeRouteAdopted: false,
  };
  st.discoveries[id] = d;
  dirty = true;

  try {
    // Canonical signature: log(citizenName, kind, text, opts).
    getJournal().log(
      d.discoverer,
      "discovery",
      `${d.discoverer} discovered ${d.name} (${DISCOVERY_TYPES[type].label}) at ${x}, ${y}.`,
      { data: { id, type, name: d.name, x, y, z } }
    );
  } catch { /* journal is best-effort */ }

  return { ...d };
}

/**
 * All discoveries, newest last.
 */
function allDiscoveries() {
  return Object.values(load().discoveries).map((d) => ({ ...d }));
}

/**
 * Discoveries of a given type.
 */
function discoveriesOfType(type) {
  return allDiscoveries().filter((d) => d.type === type);
}

/**
 * Unclaimed discoveries within CLAIM_RADIUS of a tile.
 */
function claimableNear(x, y, kingdomId) {
  void kingdomId;
  return allDiscoveries().filter((d) => {
    if (d.claimedBy) return false;
    const dx = d.x - x, dy = d.y - y;
    return Math.sqrt(dx * dx + dy * dy) <= CLAIM_RADIUS;
  });
}

/**
 * Claim a discovery for a kingdom. Returns true if claimed.
 */
function claimDiscovery(id, kingdomId) {
  const st = load();
  const d = st.discoveries[id];
  if (!d || d.claimedBy) return false;
  d.claimedBy = String(kingdomId);
  dirty = true;
  try {
    // Canonical signature: log(citizenName, kind, text, opts). No citizen
    // claims a discovery — the kingdom does — so journal under "Realm".
    getJournal().log(
      "Realm",
      "discovery-claimed",
      `${kingdomId} claimed the discovery ${d.name}.`,
      { data: { id, kingdomId, type: d.type } }
    );
  } catch { /* best-effort */ }
  return true;
}

/**
 * Mark a discovery as mapped by a cartographer.
 */
function markMapped(id, cartographer) {
  const st = load();
  const d = st.discoveries[id];
  if (!d) return false;
  d.mappedBy = String(cartographer);
  dirty = true;
  return true;
}

/**
 * Mark a trade_route discovery as adopted into the travel network.
 */
function markTradeRouteAdopted(id) {
  const st = load();
  const d = st.discoveries[id];
  if (!d || d.type !== "trade_route") return false;
  d.tradeRouteAdopted = true;
  dirty = true;
  return true;
}

/**
 * Unmapped discoveries (cartographers have work to do).
 */
function unmappedDiscoveries() {
  return allDiscoveries().filter((d) => !d.mappedBy);
}

/**
 * Trade-route discoveries not yet adopted.
 */
function unadoptedTradeRoutes() {
  return discoveriesOfType("trade_route").filter((d) => !d.tradeRouteAdopted);
}

/**
 * Fame value for discovering something (feeds CitizenReputation).
 */
function fameForDiscovery(type) {
  return DISCOVERY_TYPES[type]?.fame ?? 0;
}

// --- test seams -------------------------------------------------------------

function resetForTests() {
  cache = blankState();
  dirty = false;
  nextId = 1;
}

module.exports = {
  DISCOVERY_TYPES,
  CLAIM_RADIUS,
  recordDiscovery,
  allDiscoveries,
  discoveriesOfType,
  claimableNear,
  claimDiscovery,
  markMapped,
  markTradeRouteAdopted,
  unmappedDiscoveries,
  unadoptedTradeRoutes,
  fameForDiscovery,
  save,
  resetForTests,
};
