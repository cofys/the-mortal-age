"use strict";

/**
 * CitizenGoalResolver — connect citizen goals to concrete activities and places.
 *
 * A citizen with goal "60 Woodcutting" should resolve to "chop willows at
 * Draynor's grove". This module maps goal blobs to { activityId, place, reason }.
 *
 * Goal types (extends the generic types in lib/goals.js):
 *   { type: "skill_target", skill: "woodcutting", target: 60 }
 *   { type: "item_buy", itemId: 1333, itemName: "rune scimitar" }
 *   { type: "skill_unlock", skill: "woodcutting", unlock: "yew", requiredLevel: 60 }
 *
 * Pure functions; no state. The decision layer calls resolveGoal() and boosts
 * the resolved activity's score. Additive only — does not replace existing
 * scoring.
 */

const { GATHER_PLACES, pickPlace } = require("./CitizenSites");
const { agentRng } = require("../lib/humanizer");

// New goal type constants (additive to lib/goals.js).
const GOAL_SKILL_TARGET = "skill_target";
const GOAL_ITEM_BUY = "item_buy";
const GOAL_SKILL_UNLOCK = "skill_unlock";

// Score boost for the resolved activity. Strong enough to matter, not so
// strong it overrides needs (hurt/weary still subtract 25-50).
const GOAL_RESOLUTION_BOOST = 30;

// Tier progression: skill level required for each tier.
// Trees: normal(1) -> oak(15) -> willow(30) -> yew(60)
// Rocks: copper(1) -> iron(15) -> coal(30)
const TREE_TIERS = [
  { tier: "yew", level: 60 },
  { tier: "willow", level: 30 },
  { tier: "oak", level: 15 },
  { tier: "normal", level: 1 },
];

const ROCK_TIERS = [
  { tier: "coal", level: 30 },
  { tier: "iron", level: 15 },
  { tier: "copper", level: 1 },
];

// Map skill names to activity IDs and place kinds.
const SKILL_TO_ACTIVITY = {
  woodcutting: { activityId: "citizen_chop", kind: "tree", tiers: TREE_TIERS },
  mining: { activityId: "citizen_mine", kind: "rock", tiers: ROCK_TIERS },
  fishing: { activityId: "citizen_fish", kind: "fish", tiers: null }, // no tiers for fish
};

/**
 * Get a citizen's level in a skill. Safe: returns 1 on any failure.
 */
function skillLevel(player, skill) {
  try {
    const skills = player?.getSkills?.();
    if (skills?.getLevel) return skills.getLevel(skill) ?? 1;
    return player?.getLevel?.(skill) ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Find the best tier place for a skill at the citizen's level.
 * Returns the highest tier the citizen can use, or null if no places.
 */
function bestTierPlace(player, kind, tiers, rng) {
  const level = skillLevel(player, kind === "tree" ? "woodcutting" : kind === "rock" ? "mining" : "fishing");
  // Find highest tier at or below citizen's level.
  let targetTier = null;
  if (tiers) {
    for (const t of tiers) {
      if (level >= t.level) {
        targetTier = t.tier;
        break;
      }
    }
  }
  // Pick a place of this kind, preferring the target tier.
  const candidates = GATHER_PLACES.filter((p) => p.kind === kind);
  if (candidates.length === 0) return null;
  if (targetTier) {
    const tierMatches = candidates.filter((p) => p.tier === targetTier);
    if (tierMatches.length > 0) {
      // Use pickPlace logic but filtered to tier matches.
      // For simplicity, pick the first tier match via weighted rng.
      const idx = Math.floor(rng() * tierMatches.length);
      return tierMatches[idx];
    }
  }
  // Fallback: any place of this kind.
  return pickPlace(player, kind, rng);
}

/**
 * Resolve a skill-target goal to an activity and place.
 * e.g. { skill: "woodcutting", target: 60 } → chop willows
 */
function resolveSkillTarget(player, goal, rng) {
  const mapping = SKILL_TO_ACTIVITY[goal.skill];
  if (!mapping) return null;
  const place = bestTierPlace(player, mapping.kind, mapping.tiers, rng);
  if (!place) return null;
  const current = skillLevel(player, goal.skill);
  return {
    activityId: mapping.activityId,
    place,
    reason: `${goal.target} ${goal.skill} (now ${current})`,
  };
}

/**
 * Resolve an item-buy goal to a money-making activity.
 * Uses reference prices to pick the most profitable skill the citizen can do.
 */
function resolveItemBuy(player, goal, rng) {
  let price = 0;
  try {
    const { getReferencePrice } = require("../../economy/Prices.Economy");
    price = getReferencePrice(goal.itemId) ?? 0;
  } catch {
    // Economy unavailable — fall back to generic money-making.
  }
  // Pick the best money-making skill based on levels.
  const wc = skillLevel(player, "woodcutting");
  const mining = skillLevel(player, "mining");
  const fishing = skillLevel(player, "fishing");
  let best = { skill: "woodcutting", level: wc, activityId: "citizen_chop", kind: "tree", tiers: TREE_TIERS };
  if (mining > best.level) best = { skill: "mining", level: mining, activityId: "citizen_mine", kind: "rock", tiers: ROCK_TIERS };
  if (fishing > best.level) best = { skill: "fishing", level: fishing, activityId: "citizen_fish", kind: "fish", tiers: null };
  const place = bestTierPlace(player, best.kind, best.tiers, rng);
  if (!place) return null;
  const priceStr = price > 0 ? ` (${price} coins)` : "";
  return {
    activityId: best.activityId,
    place,
    reason: `afford ${goal.itemName}${priceStr} via ${best.skill}`,
  };
}

/**
 * Resolve a skill-unlock goal to training at the best available tier.
 * e.g. { skill: "woodcutting", unlock: "yew", requiredLevel: 60 }
 */
function resolveSkillUnlock(player, goal, rng) {
  const mapping = SKILL_TO_ACTIVITY[goal.skill];
  if (!mapping) return null;
  const current = skillLevel(player, goal.skill);
  if (current >= goal.requiredLevel) return null; // already unlocked
  const place = bestTierPlace(player, mapping.kind, mapping.tiers, rng);
  if (!place) return null;
  return {
    activityId: mapping.activityId,
    place,
    reason: `unlock ${goal.unlock} (${current}/${goal.requiredLevel} ${goal.skill})`,
  };
}

/**
 * Main entry: resolve a goal blob to { activityId, place, reason }.
 * Returns null if the goal doesn't map to a concrete activity.
 */
function resolveGoal(player, goal) {
  if (!goal || !goal.type) return null;
  const name = player?.getUsername?.() ?? "unknown";
  const rng = agentRng(`goal:${name}:${goal.type}`);
  switch (goal.type) {
    case GOAL_SKILL_TARGET:
      return resolveSkillTarget(player, goal, rng);
    case GOAL_ITEM_BUY:
      return resolveItemBuy(player, goal, rng);
    case GOAL_SKILL_UNLOCK:
      return resolveSkillUnlock(player, goal, rng);
    default:
      return null; // generic goals (save_gold, etc.) don't resolve
  }
}

module.exports = {
  GOAL_SKILL_TARGET,
  GOAL_ITEM_BUY,
  GOAL_SKILL_UNLOCK,
  GOAL_RESOLUTION_BOOST,
  resolveGoal,
  // Exported for tests:
  skillLevel,
  bestTierPlace,
};
