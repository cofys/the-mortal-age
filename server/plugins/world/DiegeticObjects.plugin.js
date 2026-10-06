"use strict";

/**
 * DiegeticObjects.plugin — spawns the physical anchors for the no-commands
 * migration (market boards, war tables, donation chests, steward's desks).
 * See DiegeticObjects.js for the registry.
 */

const { initDiegeticObjects } = require("./DiegeticObjects");

module.exports = {
  name: "DiegeticObjects",
  register(api) {
    initDiegeticObjects(api);
  },
};
