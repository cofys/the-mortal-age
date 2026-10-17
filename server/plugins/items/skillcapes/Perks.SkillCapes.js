/**
 * "skillcape:has-perk": the one question other plugins ask about skillcapes. The payload is
 * `{ player, skill, inventory?, result }`; `skill` is a Skill or its key ("COOKING"), and
 * `inventory: true` counts a carried cape too (the Prayer cape's holy wrench). The skill's own
 * cape (trimmed or not), the max cape and, for the perks they keep, combined max capes answer.
 */
const Capes = require("./Common.SkillCapes");

module.exports = function attachPerks(api) {
  api.onCustomEvent("skillcape:has-perk", Capes.answerPerk);
};
