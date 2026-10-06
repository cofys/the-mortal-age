"use strict";

/**
 * Kingdoms — the KINGDOM SYSTEM for The Mortal Age.
 *
 * Kingdoms are the weather: territory, war, succession. This plugin wires the
 * five great powers from the world bible as Area subclasses (territory with
 * edges), a JSON world-state store (rulers, treasuries, wars, story flags),
 * player membership attributes, and the kingdom:* custom-event API that the
 * rest of the server talks to. Content units live in sibling files; this file
 * is a registration list only.
 */

module.exports = {
  name: "Kingdoms",
  register(api) {
    require("./Seed.Kingdoms")(api);
    require("./Areas.Kingdoms")(api);
    require("./Events.Kingdoms")(api);
    require("./Membership.Kingdoms")(api);
    require("./Influence.Kingdoms")(api);
    require("./Politics.Kingdoms")(api);
    require("./Commands.Kingdoms")(api);
    require("./Alliances.Kingdoms")(api);
    require("./Diplomacy.Kingdoms")(api);
    require("./Royals.Kingdoms")(api);
    require("./Succession.Kingdoms")(api);
    require("./Simulation.Kingdoms")(api);
    require("./Tension.Kingdoms")(api);
    // require("./WarConsequences.Kingdoms")(api); // TODO: re-enable when the file lands
  },
};
