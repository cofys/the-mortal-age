"use strict";

/**
 * Arrival — the starting experience for The Mortal Age.
 *
 * The first 15 minutes are a SITUATION, not a quest chain: the player arrives
 * home, gets their bearings from a guard and a townsfolk, hears the world's
 * state as ambient rumor, and gets one gentle nudge toward the living world.
 * No quest keys, no varps, no stages, no QPs. If this ever grows a checklist,
 * it has failed.
 *
 * Units (one file each, following the module's existing pattern):
 * - Origins.Arrival: the welcome beat on `origins:selected`.
 * - Chatter.Arrival: NPC idle rumor chatter in the capitals.
 * - Asides.Arrival: bartender dialogue asides (canon verbatim + muttered aside).
 * - Noticeboards.Arrival: Read a Noticeboard, get the kingdom's broadsheet.
 */
module.exports = {
  name: "Arrival",
  register(api) {
    require("./Origins.Arrival")(api);
    require("./Chatter.Arrival")(api);
    require("./Asides.Arrival")(api);
    require("./Noticeboards.Arrival")(api);
  },
};
