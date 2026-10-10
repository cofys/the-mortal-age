"use strict";

/**
 * CitizenSlotCapacity — per-spot occupancy for citizen activities.
 *
 * The 2026-10-08 destack (humanizer.personalSpot) gives every citizen a
 * stable personal ring around shared anchors, but it can't coordinate:
 * with a big enough crowd two citizens still draw the same ring tile, and
 * nothing bounds how many pile onto one fishing spot or farm patch.
 *
 * This module is the coordination layer that sits ON TOP of personalSpot:
 * spots (real engine positions — sites.json anchors, real fishing-spot NPC
 * tiles, real patch centers, real world-object tiles; NEVER invented
 * coordinates) get a fixed number of capacity slots. Citizens claim a slot
 * when they arrive at a spot; each slot is a distinct tile by construction,
 * so N citizens claiming the same spot land on N distinct tiles. When a
 * spot is full the claim is denied and the caller picks another spot of
 * the same activity or falls back — never a fixed wait loop.
 *
 * Slot capacity is data, not code: data/citizen-activities.json carries an
 * optional per-activity `slotCapacity` (default DEFAULT_SLOT_CAPACITY when
 * absent). Keyed by activity+spot: `${activityId}@${x},${y},${z}`.
 *
 * Claim lifecycle (one claim per citizen at a time):
 *   - claimSlot(player, activityId, x, y, z, rng) -> claim | null (full)
 *   - releaseFor(player) on activity end (CitizenDecisions.pick releases
 *     stale claims), interrupt (doInterrupt), depart (a new claim releases
 *     the old one), and logout (Citizens.plugin onPlayerLogout).
 *   - Stale claims (no refresh in STALE_CLAIM_MS) are pruned as a backstop.
 *
 * Zero LLM. Tick-safe: every public function is defensive and never throws
 * on malformed input. No *2 modules, no hash-derived fictional coordinates
 * — slot tiles are integer offsets around the REAL anchor tile.
 */

const path = require("path");
const fs = require("fs");
const { hashSeed } = require("../lib/humanizer");

const ACTIVITIES_PATH = path.join(
  __dirname,
  "..",
  "data",
  "citizen-activities.json"
);

/** Sane default when an activity has no `slotCapacity` in the JSON. */
const DEFAULT_SLOT_CAPACITY = 3;
/** Epsilon-greedy jitter: this often, skip the favorite slot for variety. */
const SLOT_EPSILON = 0.2;
/** Backstop: a claim unrefreshed this long is dead (logout hook is primary). */
const STALE_CLAIM_MS = 30 * 60 * 1000;
/** Empty spots older than this are dropped from the registry. */
const EMPTY_SPOT_TTL_MS = 60 * 60 * 1000;

// Deterministic spiral offsets per slot index, in tiles around the real
// anchor. Structural de-dup: slot i at the same anchor is ALWAYS a distinct
// tile from slot j — the offsets are unique by construction, not by luck.
const SLOT_SPIRAL = [
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [3, 3],
  [-3, -3],
  [3, -3],
  [-3, 3],
  [4, 1],
  [-4, -1],
  [1, 4],
  [-1, -4],
  [5, 0],
  [-5, 0],
  [0, 5],
  [0, -5],
];

/** Integer tile for a slot index around a real anchor (x, y). */
function slotTile(x, y, slot) {
  if (slot < SLOT_SPIRAL.length) {
    const [dx, dy] = SLOT_SPIRAL[slot];
    return { x: x + dx, y: y + dy };
  }
  // Beyond the table: keep spiraling outward — never reuse an offset.
  const extra = slot - SLOT_SPIRAL.length;
  const r = 6 + Math.floor(extra / 8) * 2;
  const a = (extra % 8) * (Math.PI / 4);
  return { x: Math.round(x + Math.cos(a) * r), y: Math.round(y + Math.sin(a) * r) };
}

// --- data (slotCapacity per activity) ----------------------------------------

let definitionsCache = null;
let definitionsMtimeMs = 0;

function loadDefinitions() {
  if (definitionsCache) {
    return definitionsCache;
  }
  const map = new Map();
  try {
    const stat = fs.statSync(ACTIVITIES_PATH);
    definitionsMtimeMs = stat.mtimeMs;
    const raw = JSON.parse(fs.readFileSync(ACTIVITIES_PATH, "utf8"));
    for (const activity of raw?.activities ?? []) {
      if (activity && typeof activity.id === "string") {
        map.set(activity.id, activity);
      }
    }
  } catch {
    // A missing/unreadable JSON degrades to defaults — the module still works.
  }
  definitionsCache = map;
  return map;
}

/**
 * Slot capacity for an activity id: the JSON `slotCapacity` when present,
 * DEFAULT_SLOT_CAPACITY otherwise. Always a positive integer.
 */
function slotCapacityFor(activityId) {
  const def = loadDefinitions().get(activityId);
  const raw = def?.slotCapacity;
  if (Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SLOT_CAPACITY;
}

// --- registry state -----------------------------------------------------------

/** key `${activityId}@${x},${y},${z}` -> { activityId, spotKey, x, y, z, occupants: Map<username, claim>, lastSeen } */
const spots = new Map();
/** username -> claim { activityId, spotKey, slot, username, x, y, z, claimedAt } */
const claimByUser = new Map();
let lastPruneAt = 0;

function usernameOf(player) {
  try {
    const name = player?.getUsername?.() ?? player?.username ?? null;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function spotKeyOf(activityId, x, y, z) {
  return `${activityId}@${x},${y},${z}`;
}

/** Ensure the spot record exists; returns it. */
function ensureSpot(activityId, x, y, z, nowMs) {
  const spotKey = spotKeyOf(activityId, x, y, z);
  let spot = spots.get(spotKey);
  if (!spot) {
    spot = {
      activityId,
      spotKey,
      x,
      y,
      z,
      occupants: new Map(),
      lastSeen: nowMs,
    };
    spots.set(spotKey, spot);
  } else {
    spot.lastSeen = nowMs;
  }
  return spot;
}

function prune(nowMs) {
  if (nowMs - lastPruneAt < 60 * 1000) {
    return;
  }
  lastPruneAt = nowMs;
  for (const [key, spot] of spots) {
    // Drop stale occupant claims (backstop; the logout/interrupt/pick
    // releases are the primary lifecycle).
    for (const [username, claim] of spot.occupants) {
      if (nowMs - claim.claimedAt > STALE_CLAIM_MS) {
        spot.occupants.delete(username);
        if (claimByUser.get(username) === claim) {
          claimByUser.delete(username);
        }
      }
    }
    if (spot.occupants.size === 0 && nowMs - spot.lastSeen > EMPTY_SPOT_TTL_MS) {
      spots.delete(key);
    }
  }
}

// --- public API ---------------------------------------------------------------

/**
 * Register a real spot position (sites.json anchor, real fishing-spot NPC,
 * real patch center, real world object) for an activity. Idempotent.
 * Returns the spotKey.
 */
function registerSpot(activityId, x, y, z = 0) {
  if (typeof activityId !== "string" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const nowMs = Date.now();
  const spot = ensureSpot(
    activityId,
    Math.round(x),
    Math.round(y),
    Math.round(Number.isFinite(z) ? z : 0),
    nowMs
  );
  prune(nowMs);
  return spot.spotKey;
}

/**
 * Claim a slot at a real spot. Returns { x, y, z, slot, spotKey, capacity,
 * taken } — the tile the citizen should stand on — or null when the spot
 * is full (the caller picks another spot of the same activity, or falls
 * back to a different activity; never a fixed wait).
 *
 * One claim per citizen: claiming releases any previous claim (departing
 * a spot frees it). The citizen's "usual" slot is stable per
 * citizen+spot (like a human's favorite corner); epsilon-greedy jitter
 * keeps it from always being slot 0 and spreads load when taken.
 */
function claimSlot(player, activityId, x, y, z = 0, rng = Math.random) {
  const username = usernameOf(player);
  if (!username || typeof activityId !== "string") {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const nowMs = Date.now();
  const ax = Math.round(x);
  const ay = Math.round(y);
  const az = Math.round(Number.isFinite(z) ? z : 0);
  const capacity = slotCapacityFor(activityId);
  const spot = ensureSpot(activityId, ax, ay, az, nowMs);
  prune(nowMs);

  // Re-claiming the spot the citizen already holds just refreshes it —
  // actions that claim every tick (farm patches, routine legs) must not
  // shuffle the citizen between slots.
  const existing = claimByUser.get(username);
  if (existing && existing.spotKey === spot.spotKey) {
    existing.claimedAt = nowMs;
    return {
      x: existing.x,
      y: existing.y,
      z: existing.z,
      slot: existing.slot,
      spotKey: existing.spotKey,
      capacity,
      taken: spot.occupants.size,
    };
  }

  // Departing the old spot frees it — one claim per citizen.
  releaseFor(player);

  if (spot.occupants.size >= capacity) {
    return null; // full — caller chooses another spot or activity
  }
  const taken = new Set(spot.occupants.values());
  const free = [];
  for (let i = 0; i < capacity; i++) {
    if (!taken.has(i)) {
      free.push(i);
    }
  }
  if (free.length === 0) {
    return null;
  }
  const favorite = hashSeed(`${username}@${spot.spotKey}`) % capacity;
  const random = typeof rng === "function" ? rng : Math.random;
  let slot;
  if (!taken.has(favorite) && random() >= SLOT_EPSILON) {
    slot = favorite;
  } else {
    slot = free[Math.floor(random() * free.length)];
  }
  const tile = slotTile(ax, ay, slot);
  const claim = {
    activityId,
    spotKey: spot.spotKey,
    slot,
    username,
    x: tile.x,
    y: tile.y,
    z: az,
    claimedAt: nowMs,
  };
  spot.occupants.set(username, slot);
  claimByUser.set(username, claim);
  return {
    x: tile.x,
    y: tile.y,
    z: az,
    slot,
    spotKey: spot.spotKey,
    capacity,
    taken: spot.occupants.size,
  };
}

/** Release the citizen's current claim, if any. Idempotent, never throws. */
function releaseFor(player) {
  try {
    const username = usernameOf(player);
    if (!username) {
      return false;
    }
    return releaseUsername(username);
  } catch {
    return false;
  }
}

/** Release by username (logout paths that only have a name). */
function releaseUsername(username) {
  try {
    const claim = claimByUser.get(username);
    if (!claim) {
      return false;
    }
    claimByUser.delete(username);
    const spot = spots.get(claim.spotKey);
    if (spot && spot.occupants.get(username) === claim.slot) {
      spot.occupants.delete(username);
    }
    return true;
  } catch {
    return false;
  }
}

/** The citizen's current claim, or null. */
function claimOf(username) {
  return claimByUser.get(username) ?? null;
}

/** Occupancy snapshot for a spot: { capacity, taken, free }. */
function spotStatus(activityId, spotKey) {
  const spot = spots.get(spotKey);
  const capacity = slotCapacityFor(activityId);
  return {
    capacity,
    taken: spot ? spot.occupants.size : 0,
    free: Math.max(0, capacity - (spot ? spot.occupants.size : 0)),
    registered: !!spot,
  };
}

/** All registered spots for an activity (for "another spot" fallbacks). */
function spotsForActivity(activityId) {
  const out = [];
  for (const spot of spots.values()) {
    if (spot.activityId === activityId) {
      out.push({
        spotKey: spot.spotKey,
        x: spot.x,
        y: spot.y,
        z: spot.z,
        capacity: slotCapacityFor(activityId),
        taken: spot.occupants.size,
      });
    }
  }
  return out;
}

/** Test seam: clear all registry state. */
function resetForTests() {
  spots.clear();
  claimByUser.clear();
  lastPruneAt = 0;
}

/** Test seam: override the activity definitions (bypasses the JSON file). */
function setDefinitionsForTests(definitions) {
  definitionsCache = new Map();
  for (const def of definitions ?? []) {
    if (def && typeof def.id === "string") {
      definitionsCache.set(def.id, def);
    }
  }
}

/** Test seam: reload from the JSON file on next read. */
function reloadDefinitions() {
  definitionsCache = null;
  definitionsMtimeMs = 0;
}

module.exports = {
  DEFAULT_SLOT_CAPACITY,
  SLOT_EPSILON,
  slotCapacityFor,
  registerSpot,
  claimSlot,
  releaseFor,
  releaseUsername,
  claimOf,
  spotStatus,
  spotsForActivity,
  resetForTests,
  // Test seams (not part of the public contract):
  _slotTile: slotTile,
  _spotKeyOf: spotKeyOf,
  _setDefinitionsForTests: setDefinitionsForTests,
  _reloadDefinitions: reloadDefinitions,
  _spots: spots,
  _claimByUser: claimByUser,
};
