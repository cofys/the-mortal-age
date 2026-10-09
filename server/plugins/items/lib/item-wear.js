"use strict";

/**
 * item-wear — shared pure logic for equipment wear, repair and crafting quality.
 *
 * State lives on the item itself via namespaced meta keys (kebab-case, per
 * plugin conventions):
 *   wear:durability -> 0..MAX_DURABILITY (absent = full, so every pre-existing
 *                       item in the world defaults to pristine condition)
 *   wear:quality    -> 0 normal | 1 fine | 2 superior (absent = normal)
 *
 * Items already tracked by a bespoke degradation system (barrows, crystal
 * charges) are left alone — those plugins own their items, detected by the
 * presence of their meta keys.
 *
 * No plugin API dependency here: pure functions over { getId, getMetaValue,
 * setMetaValue, getDefinition } shaped items, so plain-node tests can drive it.
 */

const WEAR_META_KEY = "wear:durability";
const QUALITY_META_KEY = "wear:quality";

const MAX_DURABILITY = 1000;

// Combat gear slots that wear: head, weapon, body, shield, legs, hands, feet.
// Capes, amulets, rings and ammo are utility/enchanted items and do not wear.
const WEARABLE_SLOTS = new Set([0, 3, 4, 5, 7, 9, 10]);

// Meta keys owned by other degradation systems — never double-degrade.
const FOREIGN_DEGRADE_KEYS = ["barrows", "crystal-halberd", "crystal-armour"];

const QUALITY_NAMES = ["", "Fine", "Superior"];
const QUALITY_WEAR_SKIP = [0, 0.25, 0.5]; // chance to skip a wear tick
const QUALITY_STAT_PCT = [0, 0.03, 0.06]; // bonus uplift on equipped items

// Warning thresholds (fraction of max) that trigger chat warnings.
const WARN_THRESHOLDS = [0.25, 0.1];

// Rough smithing level needed to self-repair, by metal in the item name.
// Deliberately modest: the point is smiths matter, not hard gating.
const METAL_SMITHING_LEVELS = [
  [/rune/i, 40],
  [/dragon/i, 60],
  [/adamant/i, 30],
  [/mithril/i, 20],
  [/black/i, 10],
  [/steel/i, 5],
  [/iron/i, 1],
  [/bronze/i, 1],
  [/crystal/i, 70],
];

function safeMeta(item, key) {
  try {
    return item?.getMetaValue?.(key);
  } catch {
    return undefined;
  }
}

function equipmentSlot(item) {
  try {
    return item?.getDefinition?.()?.getEquipmentType?.()?.getSlot?.() ?? -1;
  } catch {
    return -1;
  }
}

function isWearable(item) {
  if (!item || item.getId?.() <= 0) return false;
  if (!WEARABLE_SLOTS.has(equipmentSlot(item))) return false;
  for (const key of FOREIGN_DEGRADE_KEYS) {
    if (safeMeta(item, key) !== undefined) return false;
  }
  return true;
}

function getDurability(item) {
  const saved = Number(safeMeta(item, WEAR_META_KEY));
  if (Number.isInteger(saved)) return Math.max(0, Math.min(MAX_DURABILITY, saved));
  return MAX_DURABILITY;
}

function setDurability(item, value) {
  const clamped = Math.max(0, Math.min(MAX_DURABILITY, Math.floor(value)));
  if (clamped >= MAX_DURABILITY) {
    item.setMetaValue(WEAR_META_KEY, undefined);
  } else {
    item.setMetaValue(WEAR_META_KEY, clamped);
  }
  return clamped;
}

function isBroken(item) {
  return isWearable(item) && getDurability(item) <= 0;
}

function getQuality(item) {
  const q = Number(safeMeta(item, QUALITY_META_KEY));
  return q === 1 || q === 2 ? q : 0;
}

function setQuality(item, tier) {
  if (tier === 1 || tier === 2) item.setMetaValue(QUALITY_META_KEY, tier);
  else item.setMetaValue(QUALITY_META_KEY, undefined);
}

function qualityName(tier) {
  return QUALITY_NAMES[tier] || "";
}

function itemName(item) {
  try {
    return item?.getDefinition?.()?.getName?.() || "item";
  } catch {
    return "item";
  }
}

function highAlch(item) {
  try {
    return Number(item?.getDefinition?.()?.getHighAlchValue?.()) || 0;
  } catch {
    return 0;
  }
}

/** Coins to fully repair: scales with item value, always at least 1/pt. */
function repairCost(item) {
  if (!isWearable(item)) return 0;
  const missing = MAX_DURABILITY - getDurability(item);
  if (missing <= 0) return 0;
  const perPoint = Math.max(1, Math.ceil(highAlch(item) / 5000));
  return missing * perPoint;
}

function smithingLevelFor(item) {
  const name = itemName(item);
  for (const [pattern, level] of METAL_SMITHING_LEVELS) {
    if (pattern.test(name)) return level;
  }
  return 1;
}

/**
 * Roll a crafting quality tier.
 * margin = crafter skill level - item required level.
 * rng: () => [0,1), injectable for tests.
 */
function rollQuality(margin, rng = Math.random) {
  const roll = rng();
  if (margin >= 20) {
    if (roll < 0.15) return 2;
    if (roll < 0.5) return 1;
    return 0;
  }
  if (margin >= 10) {
    if (roll < 0.05) return 2;
    if (roll < 0.3) return 1;
    return 0;
  }
  if (margin >= 0) {
    return roll < 0.1 ? 1 : 0;
  }
  return 0;
}

/** Human-readable condition line for examine messages and "check" output. */
function describe(item) {
  const parts = [];
  const q = getQuality(item);
  if (q > 0) parts.push(`${qualityName(q)} craftsmanship`);
  const pct = Math.round((getDurability(item) / MAX_DURABILITY) * 100);
  if (pct >= 100) parts.push("pristine condition");
  else if (pct <= 0) parts.push("BROKEN");
  else parts.push(`${pct}% durability`);
  return parts.join(", ");
}

module.exports = {
  WEAR_META_KEY,
  QUALITY_META_KEY,
  MAX_DURABILITY,
  WEARABLE_SLOTS,
  QUALITY_WEAR_SKIP,
  QUALITY_STAT_PCT,
  WARN_THRESHOLDS,
  isWearable,
  getDurability,
  setDurability,
  isBroken,
  getQuality,
  setQuality,
  qualityName,
  itemName,
  repairCost,
  smithingLevelFor,
  rollQuality,
  describe,
};
