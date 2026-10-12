"use strict";

/**
 * CitizenResourceProfile — kingdom resource-profile scoring (phase 3 of the
 * citizen world-population rebuild).
 *
 * Jon's directive: "some kingdoms naturally have more of something" — a
 * citizen's kingdom should shape WHAT work they choose. The authority is
 * server/plugins/economy/data/regional-resources.json (ECONOMY.md §1):
 * surplus = what the region exports, deficit = what it must import. The
 * JSON is read once and cached — never hardcoded here.
 *
 * profileWorkBonus(kingdomId, activityId) returns a small integer nudge:
 *   +8  when the activity gathers a resource the kingdom has in surplus
 *   -4  when the activity gathers a resource the kingdom must import
 *    0  otherwise (unknown kingdom, non-gather activity, missing data)
 *
 * Tie-breaker scale by design: personality, goals, and needs still dominate.
 * A Kandarin citizen CAN mine — the surplus just wins ties. No LLM, no
 * hashes; pure lookup.
 */

// Activity ids mirror the ACT_* constants in CitizenDecisions.js (kept as
// literals here to avoid a require cycle — this module is required by
// CitizenDecisions).
const ACT_MINE = "citizen_mine";
const ACT_CHOP = "citizen_chop";
const ACT_FISH = "citizen_fish";
const ACT_HERB = "citizen_herb";
const ACT_FARM = "citizen_farm";

/** Surplus match: strong nudge toward the kingdom's characteristic work. */
const SURPLUS_BONUS = 8;
/** Deficit match: a whisper away — nudge, not a lock. */
const DEFICIT_PENALTY = -4;

// Resource name (regional-resources.json) -> the gather activity that
// produces it. Resources with no gather activity in the scoring layer are
// deliberately unmapped (flax has no flax-pick activity; metal_bars are
// smelted not mined; bread/cloth/leather/wool/cowhide/trade_services and
// master_smithing_labor are processed goods or services, not gatherables).
const ACTIVITY_FOR_RESOURCE = Object.freeze({
  // Ores & stone -> mining
  coal: ACT_MINE,
  iron_ore: ACT_MINE,
  mithril_ore: ACT_MINE,
  adamantite_ore: ACT_MINE,
  metal_ore: ACT_MINE,
  gems: ACT_MINE,
  limestone: ACT_MINE,
  // Logs & timber -> woodcutting
  oak_logs: ACT_CHOP,
  willow_logs: ACT_CHOP,
  yew_logs: ACT_CHOP,
  magic_logs: ACT_CHOP,
  timber: ACT_CHOP,
  high_tier_timber: ACT_CHOP,
  // Fish -> fishing
  raw_fish: ACT_FISH,
  // Alchemical gatherables -> herblore gathering
  herbs: ACT_HERB,
  mort_myre_fungus: ACT_HERB,
  swamp_paste: ACT_HERB,
  swamp_tar: ACT_HERB,
  // Crops -> farming
  wheat: ACT_FARM,
  barley: ACT_FARM,
  hops: ACT_FARM,
  food: ACT_FARM,
});

const path = require("path");
const fs = require("fs");

let cachedProfiles = null;
let loadFailed = false;

/** Read the economy authority JSON once; null when unreadable. */
function loadProfiles() {
  if (cachedProfiles || loadFailed) {
    return cachedProfiles;
  }
  try {
    const file = path.join(
      __dirname,
      "..",
      "..",
      "economy",
      "data",
      "regional-resources.json"
    );
    cachedProfiles = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    loadFailed = true;
    cachedProfiles = null;
  }
  return cachedProfiles;
}

/** The regional profile for a kingdom id, or null. Contested regions (the
 * Wilderness) live outside `regions` — citizens don't routinely work there,
 * so they resolve to null here. */
function profileFor(kingdomId) {
  if (!kingdomId) {
    return null;
  }
  const data = loadProfiles();
  const region = data?.regions?.[kingdomId];
  return region && typeof region === "object" ? region : null;
}

/**
 * Scoring nudge for (kingdomId, activityId). +8 when the activity gathers a
 * surplus resource of the citizen's kingdom, -4 when it gathers a deficit
 * resource, 0 otherwise. Pure lookup — safe to call from scoreActivity with
 * any snapshot.
 */
function profileWorkBonus(kingdomId, activityId) {
  if (!kingdomId || !activityId) {
    return 0;
  }
  const profile = profileFor(kingdomId);
  if (!profile) {
    return 0;
  }
  const surplus = profile.surplus;
  const deficit = profile.deficit;
  if (Array.isArray(surplus) && surplus.some((r) => ACTIVITY_FOR_RESOURCE[r] === activityId)) {
    return SURPLUS_BONUS;
  }
  if (Array.isArray(deficit) && deficit.some((r) => ACTIVITY_FOR_RESOURCE[r] === activityId)) {
    return DEFICIT_PENALTY;
  }
  return 0;
}

/** Test seam: drop the cached JSON so tests can re-read. */
function resetForTests() {
  cachedProfiles = null;
  loadFailed = false;
}

module.exports = {
  profileWorkBonus,
  profileFor,
  resetForTests,
  SURPLUS_BONUS,
  DEFICIT_PENALTY,
  ACTIVITY_FOR_RESOURCE,
};
