"use strict";

module.exports = {
  name: "BeginnerTreasureTrails",
  register(api) {
    require("./beginner/Runtime.BeginnerTreasureTrails")(api);
    require("./beginner/Rewards.BeginnerTreasureTrails")(api);
    require("./beginner/Capacity.BeginnerTreasureTrails")(api);
  },
};
