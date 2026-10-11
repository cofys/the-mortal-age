"use strict";

/**
 * Housing — player housing, kingdom edition.
 *
 * The engine runs full player-owned houses (estate agent, rooms, furniture,
 * portals). This plugin is the kingdom layer on top:
 *
 *   HousingPortals — one real POH portal (Use) in each of the 5 capitals
 *                    and 8 frontier settlements; the first portal used
 *                    becomes the player's town of residence, and Use walks
 *                    them into their own engine house via the real
 *                    house-tablet entry path
 *   HousingApi     — /api/housing-status: residence + 5k move, door-mode
 *                    toggles, house valuation payload
 *   HousingBoons   — tick: chapel/workshop/kitchen room boons while the
 *                    owner is home (real SkillManager effects)
 *   HousingVisitors — tick: residence-town citizens congratulate new
 *                    residents and gossip about grand houses (sayPublic
 *                    + voice)
 *
 * Register is attach-only per server/AGENTS.md.
 */

const HousingApi = require("./HousingApi");
const HousingDiegetic = require("./HousingDiegetic");
const HousingPortals = require("./HousingPortals");
const HousingBoons = require("./HousingBoons");
const HousingVisitors = require("./HousingVisitors");

module.exports = {
  name: "Housing",
  register(api) {
    HousingApi(api);
    HousingDiegetic(api);
    HousingPortals(api);
    HousingBoons.start(api);
    HousingVisitors.start(api);
  },
};
