"use strict";

/**
 * CitizenPrimaryHobby — one primary hobby per citizen (visibility focus).
 *
 * WHAT IT DOES (data tier, free):
 *   Every username is deterministically assigned EXACTLY ONE primary hobby
 *   from the 7 universal activity systems, via a uniform hash partition.
 *   No storage, stable across restarts, zero token cost.
 *
 * WHY IT EXISTS:
 *   The 2026-10-08 distribution audit found all 7 activity systems
 *   (hobbyists, gardeners, storytellers, historians, menders, volunteers,
 *   pet owners) claim 100% of commoners by design — "everyone has a hobby".
 *   That's fine for the data tier, but with 7 universal layers firing at
 *   full rate, no citizen's visible behavior has focus: everyone is
 *   visibly doing everything.
 *
 *   The data tier stays universal (all 7 type functions still return types
 *   for everyone). Only the VISIBLE tick firing is weighted: a citizen's
 *   primary hobby always passes the visibility gate; each of their other
 *   six hobbies passes deterministically 1-in-3. The primary hobby thus
 *   fires ~3x more often than any other single hobby, giving each citizen
 *   a visible focus while the LLM dialogue tier keeps all 7 for depth.
 *
 * HOW TO USE:
 *   In each activity tick, right after the identity check:
 *
 *     const { isHobbyVisible } = require("./CitizenPrimaryHobby");
 *     if (!isHobbyVisible(record.username, "gardener")) continue;
 *
 *   The hobby key must be one of HOBBY_KEYS. Data-tier functions
 *   (type derivation, ledgers, catalogs) are NOT gated — only the tick.
 *
 * SCOPE (deliberate):
 *   - Covers ONLY the 7 universal activity systems. Professional modules
 *     (early partition + late chain) are NOT part of this.
 *   - Couriers are an activity system but are narrowed separately
 *     (COURIER_CHANCE + messenger exclusion); they are not in HOBBY_KEYS.
 *
 * Zero LLM. Pure hash math. This module requires nothing (no imports), so
 * it can never create a circular dependency.
 */

/** FNV-1a 32-bit, same as the sibling citizen modules. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The 7 universal activity systems. Keys match the hobby name each
 * module's tick passes to isHobbyVisible().
 */
const HOBBY_KEYS = Object.freeze([
  "hobbyist",    // CitizenHobbyists
  "gardener",    // CitizenGardeners
  "storyteller", // CitizenStorytellers
  "historian",   // CitizenHistorians
  "mender",      // CitizenMenders
  "volunteer",   // CitizenVolunteers
  "pet_owner",   // CitizenPetOwners
]);

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

/**
 * Exactly one primary hobby for this username, stable across restarts.
 * Uniform across the 7 keys (~14.3% each). Returns null for empty names.
 */
function primaryHobbyFor(username) {
  const name = normalizeName(username);
  if (!name) return null;
  return HOBBY_KEYS[fnv1a("primaryhobby:" + name) % HOBBY_KEYS.length];
}

/**
 * Visibility gate for activity ticks. The citizen's primary hobby always
 * passes; each other hobby passes deterministically 1-in-3 (stable per
 * username + hobby key, so behavior is consistent across ticks).
 *
 * Returns false for empty usernames or unknown hobby keys.
 */
function isHobbyVisible(username, hobbyKey) {
  const name = normalizeName(username);
  if (!name || !hobbyKey) return false;
  if (!HOBBY_KEYS.includes(hobbyKey)) return false;
  if (primaryHobbyFor(name) === hobbyKey) return true;
  return fnv1a("hobbyvis:" + hobbyKey + ":" + name) % 3 === 0;
}

module.exports = {
  primaryHobbyFor,
  isHobbyVisible,
  HOBBY_KEYS,
  fnv1a,
  normalizeName,
};
