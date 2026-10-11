/**
 * Tutorial Island - "Learning the Ropes", as recorded on OSRS (docs/tutorial-island.md).
 *
 * Progress is the OSRS `tutorial` varp value; the step data (texts, arrows, hint pictures,
 * flashing tabs, highlights, the island's own skilling) is in data/tutorial-island.json. The
 * instructors' words are the Wiki transcripts, played by NpcDialogues. Units:
 *  - Common: the data, progress and shared helpers
 *  - Interface: what each step shows, and the tab clicks that complete steps
 *  - Instructors: transcript variants, conditions and hand-outs (with the Ironman tutor)
 *  - Skills: the pond, tree, fire and range; gating mining, smelting and smithing
 *  - Combat: the equipment steps, the rats, Wind Strike, the level cap and no dying
 *  - Paths: doors, gates, ladders, the bank and the poll booth
 *  - Leave: starting, the skip offer, the Home Teleport off the island and the starter kit
 *
 * Enable/disable through world.json "disabledPlugins".
 */
const Common = require("./tutorialisland/Common.TutorialIsland");

module.exports = {
  name: "TutorialIsland",
  register(api) {
    Common.init(api);
    require("./tutorialisland/Interface.TutorialIsland")(api);
    require("./tutorialisland/Instructors.TutorialIsland")(api);
    require("./tutorialisland/Skills.TutorialIsland")(api);
    require("./tutorialisland/Combat.TutorialIsland")(api);
    require("./tutorialisland/Paths.TutorialIsland")(api);
    require("./tutorialisland/Leave.TutorialIsland")(api);
  },
};
