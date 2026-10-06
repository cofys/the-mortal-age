"use strict";

/**
 * Economy — the ECONOMY plugin for The Mortal Age.
 *
 * The connective tissue: item sinks, kingdom/buyer demand broadcasts, and a
 * reference-price feed that citizen merchants and war boards read. This file
 * is a registration list only. Design: ECONOMY.md in this directory.
 */

module.exports = {
  name: "Economy",
  register(api) {
    require("./Events.Economy")(api);
    require("./Sinks.Economy")(api);
    require("./Commands.Economy")(api);
  },
};
