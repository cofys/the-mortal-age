"use strict";

/**
 * CitizenPrimaryProfession — one primary profession per citizen.
 *
 * WHAT IT DOES (data tier, free):
 *   Every username is deterministically assigned EXACTLY ONE primary
 *   profession from the 17 early professional modules, via a weighted
 *   hash partition. No storage, stable across restarts, zero token cost.
 *
 * WHY IT EXISTS:
 *   The 2026-10-08 distribution audit found the 17 early professional modules
 *   each ran an independent ~35% membership roll with zero mutual exclusion.
 *   Mean: 6.0 professions per citizen; one citizen held 12. A "blacksmith"
 *   was also, on average, five other things — so no profession was a
 *   meaningful identity for the LLM dialogue tier to anchor on, and every
 *   identity added another roster-wide tick pass.
 *
 *   The 35% nominal shares are preserved as the partition WEIGHTS, so the
 *   relative representation of each profession is unchanged — each citizen
 *   simply holds one instead of six.
 *
 * HOW TO USE:
 *   Each early profession module gates its identity function on this:
 *
 *     const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
 *     function farmerTypeFor(username) {
 *       if (!username) return null;
 *       if (primaryProfessionFor(username) !== "farmer") return null;
 *       ...sub-type derivation (unchanged)...
 *     }
 *
 *   The tick's existing `if (!type) continue;` then works unchanged.
 *
 * SCOPE (deliberate):
 *   - Covers ONLY the 17 early professions (farmers … tailors). The late
 *     professional exclusion chain (actors … potters) is already exclusive
 *     and is NOT part of this partition.
 *   - Activity systems (hobbyists, gardeners, storytellers, historians,
 *     menders, volunteers, pet owners) are intentionally universal and are
 *     NOT gated here.
 *   - Couriers narrow to ~15% and messenger/courier mutual exclusion are
 *     Phase 2, not this module.
 *
 * Zero LLM. Pure hash math. This module requires nothing (no imports), so
 * it can never create a circular dependency.
 */

/** FNV-1a 32-bit, same as the sibling profession modules. */
function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The 17 early professions with their audit-measured nominal shares as
 * weights. The partition preserves relative representation: a profession
 * that used to claim 41.2% of citizens now gets 41.2/598.1 ≈ 6.9% as the
 * SOLE primary profession of those citizens.
 */
const PRIMARY_PROFESSIONS = [
  { key: "farmer", weight: 41.2 },
  { key: "hunter", weight: 36.2 },
  { key: "cartographer", weight: 35.6 },
  { key: "sailor", weight: 35.6 },
  { key: "innkeeper", weight: 35.5 },
  { key: "fisher", weight: 35.4 },
  { key: "stablehand", weight: 35.3 },
  { key: "blacksmith", weight: 34.9 },
  { key: "cook", weight: 34.9 },
  { key: "messenger", weight: 34.8 },
  { key: "taxcollector", weight: 34.7 },
  { key: "priest", weight: 34.6 },
  { key: "alchemist", weight: 34.4 },
  { key: "banker", weight: 34.3 },
  { key: "jeweler", weight: 33.8 },
  { key: "miner", weight: 33.6 },
  { key: "tailor", weight: 33.3 },
];

const TOTAL_WEIGHT = PRIMARY_PROFESSIONS.reduce((a, p) => a + p.weight, 0);

const PRIMARY_PROFESSION_KEYS = PRIMARY_PROFESSIONS.map((p) => p.key);

/**
 * Exactly one primary profession for this username, stable across restarts.
 * Returns one of the 17 keys for any non-empty username, null otherwise.
 */
function primaryProfessionFor(username) {
  if (username === null || username === undefined) return null;
  const name = String(username).toLowerCase();
  if (!name) return null;
  // Fine-grained roll: 100k buckets across the weight range.
  const roll = ((hashStr("primaryprofession|" + name) % 100000) / 100000) * TOTAL_WEIGHT;
  let acc = 0;
  for (const p of PRIMARY_PROFESSIONS) {
    acc += p.weight;
    if (roll < acc) return p.key;
  }
  return PRIMARY_PROFESSIONS[PRIMARY_PROFESSIONS.length - 1].key;
}

/** Weight share of one profession key (0..1), or 0 for unknown keys. */
function primaryProfessionShareFor(key) {
  const p = PRIMARY_PROFESSIONS.find((x) => x.key === key);
  return p ? p.weight / TOTAL_WEIGHT : 0;
}

module.exports = {
  primaryProfessionFor,
  primaryProfessionShareFor,
  PRIMARY_PROFESSIONS,
  PRIMARY_PROFESSION_KEYS,
  TOTAL_WEIGHT,
  hashStr,
};
