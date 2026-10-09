"use strict";

/**
 * Housing — player housing, kingdom edition.
 *
 * The engine runs full player-owned houses (estate agent, rooms, furniture,
 * portals). This plugin is the kingdom layer on top:
 *
 *   HousingApi       — /api/housing-status: plot claim (25k, kingdom
 *                      required), door-mode toggles, house valuation payload
 *   HousingBoons     — tick: chapel/workshop/kitchen room boons while the
 *                      owner is home (real SkillManager effects)
 *   HousingVisitors  — tick: capital citizens congratulate new plot owners
 *                      and gossip about grand houses (sayPublic + voice)
 *
 * Register is attach-only per server/AGENTS.md.
 */

const HousingApi = require("./HousingApi");
const HousingBoons = require("./HousingBoons");
const HousingVisitors = require("./HousingVisitors");
const HousingDiegetic = require("./HousingDiegetic");

module.exports = {
  name: "Housing",
  register(api) {
    HousingApi(api);
    HousingDiegetic(api);
    HousingBoons.start(api);
    HousingVisitors.start(api);
  },
};
