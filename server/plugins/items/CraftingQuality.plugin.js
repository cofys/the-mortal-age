"use strict";

/**
 * CraftingQuality — player-crafted equipment gets a quality tier.
 *
 * Skill plugins (smithing, fletching) emit `crafting:produced` with the fresh
 * item BEFORE it lands in the inventory. This plugin rolls a quality tier from
 * the crafter's margin over the item's required level and stamps it into item
 * meta:
 *   Normal (0) — standard.
 *   Fine (1)   — +3% combat bonuses, wears 25% slower.
 *   Superior (2) — +6% combat bonuses, wears 50% slower.
 *
 * Only real equipment is stamped (gems, bars and other materials are skipped).
 * NPC shop stock never carries quality, so player-made gear is genuinely
 * better — the point of the whole system.
 *
 * Pure logic in ./lib/item-wear.js; this file is plugin-API wiring with the
 * attach() pattern for tests.
 */

const wear = require("./lib/item-wear");

let core = null;

function stampQuality({ player, item, skill, requiredLevel }) {
  if (!player || !item || !wear.isWearable(item)) return;
  let level = 1;
  try {
    level = player.getSkillManager().getCurrentLevel(skill);
  } catch {
    return;
  }
  const tier = wear.rollQuality(level - Number(requiredLevel || 1));
  if (tier <= 0) return;
  wear.setQuality(item, tier);
  try {
    player.sendMessage(
      `You craft a ${wear.qualityName(tier).toLowerCase()} ${wear.itemName(item)}.`
    );
  } catch {
    // ignore
  }
}

/** Fine/Superior gear grants a small combat-bonus uplift while worn. */
function applyQualityBonus({ player, bonuses }) {
  if (!bonuses || !player) return;
  let equipment = [];
  try {
    equipment = player.getEquipment().getItems();
  } catch {
    return;
  }
  for (const item of equipment) {
    const tier = wear.getQuality(item);
    if (tier <= 0 || !wear.isWearable(item) || wear.isBroken(item)) continue;
    let base = [];
    try {
      base = item.getDefinition().getBonuses() || [];
    } catch {
      continue;
    }
    const pct = wear.QUALITY_STAT_PCT[tier];
    // Indices 0-4 attack, 5-9 defence.
    const n = Math.min(10, bonuses.length, base.length);
    for (let i = 0; i < n; i++) {
      bonuses[i] += Math.round((Number(base[i]) || 0) * pct);
    }
  }
}

function attach(api) {
  core = api.core;
  api.onCustomEvent("crafting:produced", stampQuality);
  api.registerBonusProvider({ apply: applyQualityBonus });
}

module.exports = {
  name: "CraftingQuality",
  attach,
  register(api) {
    attach(api);
  },
  _test: { stampQuality, applyQualityBonus },
};
