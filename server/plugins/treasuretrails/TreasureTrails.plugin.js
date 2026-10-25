"use strict";

module.exports = {
  name: "TreasureTrails",
  members: true,
  register(api) {
    require("./trails/Runtime.TreasureTrails")(api);
    require("./trails/Caskets.TreasureTrails")(api);
    require("./trails/Stash.TreasureTrails")(api);
    require("./trails/Puzzle.TreasureTrails")(api);
  },
};
