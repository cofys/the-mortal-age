"use strict";

/**
 * AdminWorldMap — Jon's live admin world map.
 *
 * Jon (2026-10-12): "maybe we need to create an admin ui/map, where I can see
 * where all players, teleport to them, have special tools and whatnot in there
 * so we can easily see what all is happening in the world."
 *
 * The React overlay (client/game/plugins/adminworldmap) polls the
 * AdminWorldMapApi content endpoint. This plugin attaches the API and
 * registers the ::worldmap admin command to open it.
 */

const { attach, OPEN_ATTRIBUTE } = require("./AdminWorldMapApi");

function openWorldMap({ player }) {
  player.setAttribute(OPEN_ATTRIBUTE, "1");
  return true;
}

function attachPlugin(api) {
  attach(api);
  api.registerCommand("worldmap", openWorldMap, undefined, "Open the admin world map");
  api.registerCommand("adminmap", openWorldMap, undefined, "Open the admin world map");
}

module.exports = {
  name: "AdminWorldMap",
  register: attachPlugin,
};
