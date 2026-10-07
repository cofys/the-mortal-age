"use strict";

/**
 * Data.QuestRegistry — the full Mortal Age quest catalogue.
 *
 * Merges the starter quests (Data.StarterQuests) and the second-tier
 * quests (Data.FollowUpQuests) into one registry. Consumers should require
 * this file, not the individual data files.
 */

const Starter = require("./Data.StarterQuests");
const FollowUp = require("./Data.FollowUpQuests");

const ALL_QUESTS = [...Starter.STARTER_QUESTS, ...FollowUp.FOLLOW_UP_QUESTS];
const BY_ID = new Map(ALL_QUESTS.map((q) => [q.id, q]));

module.exports = {
  ALL_QUESTS,
  BY_ID,
  BY_ORIGIN: Starter.BY_ORIGIN,
  STARTER_QUESTS: Starter.STARTER_QUESTS,
  FOLLOW_UP_QUESTS: FollowUp.FOLLOW_UP_QUESTS,
};
