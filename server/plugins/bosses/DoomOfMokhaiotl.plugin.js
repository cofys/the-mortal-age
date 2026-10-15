"use strict";

/**
 * The Doom of Mokhaiotl: the ruins' entrance, the lobby and the delves. Each unit lives in
 * ./doom/; add one line per unit.
 */
module.exports = {
  name: "DoomOfMokhaiotl",
  register(api) {
    require("./doom/Lobby.DoomOfMokhaiotl")(api);
    require("./doom/Delve.DoomOfMokhaiotl")(api);
    require("./doom/Rewards.DoomOfMokhaiotl")(api);
    require("./doom/Scoreboard.DoomOfMokhaiotl")(api);
    require("./doom/Commands.DoomOfMokhaiotl")(api);
    require("./doom/CombatAchievements.DoomOfMokhaiotl")(api);
  },
};
