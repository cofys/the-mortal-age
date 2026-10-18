/**
 * Tormented Demons in the Ancient Guthixian Temple, after While Guthix Sleeps
 * (https://oldschool.runescape.wiki/w/Tormented_Demon, docs/tormented-demons.md): three combat
 * styles and protection prayers, the fire shield and its unshielded attack, the defenceless
 * phase, fire bombs, the temple's 1/2/3-demon rooms, the Guthixian temple teleport, the kill count
 * and Combat Achievements. Drops roll from data/definitions/npc-drops.json; the quest's own pair
 * is fought in plugins/quests/wgs.
 */
const Shared = require("./tormenteddemons/Shared.TormentedDemons");
const Combat = require("./tormenteddemons/Combat.TormentedDemons");
const Shield = require("./tormenteddemons/Shield.TormentedDemons");
const Temple = require("./tormenteddemons/Temple.TormentedDemons");
const Scroll = require("./tormenteddemons/Scroll.TormentedDemons");
const CombatAchievements = require("./tormenteddemons/CombatAchievements.TormentedDemons");

module.exports = {
  name: "TormentedDemons",
  members: true,
  register(api) {
    Shared.attachApi(api);
    Combat.attach(api);
    Shield.attach(api);
    Temple.attach(api);
    Scroll.attach(api);
    CombatAchievements.attach(api);
  },
};
