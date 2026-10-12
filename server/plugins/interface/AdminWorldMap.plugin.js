"use strict";

/**
 * AdminWorldMap — Jon's live admin tools on the game's real world map.
 *
 * Jon (2026-10-12): "maybe we need to create an admin ui/map, where I can see
 * where all players, teleport to them, have special tools and whatnot in there
 * so we can easily see what all is happening in the world."
 *
 * Jon (2026-10-12): "Why didn't you just use the map already in the game, and
 * add an overlay to it?" — the old full-screen React overlay is gone. This
 * plugin attaches the AdminWorldMapApi action endpoint and registers
 * ::worldmap, which opens the game's own world map with the citizen layer on.
 * Citizen dots are streamed by WorldMapPlayers.plugin.js; right-clicking a
 * dot offers Teleport / Pause brain.
 */

const { attach, CITIZEN_LAYER_ATTRIBUTE } = require("./AdminWorldMapApi");

function openWorldMap({ player }) {
  try {
    player.setAttribute(CITIZEN_LAYER_ATTRIBUTE, "1");
    const sender = player.getPacketSender?.();
    if (sender && typeof sender.isWorldMapOpen === "function" && !sender.isWorldMapOpen()) {
      sender.toggleWorldMap();
    }
  } catch {
    /* never fail a command */
  }
  return true;
}

function attachPlugin(api) {
  attach(api);
  api.registerCommand("worldmap", openWorldMap, undefined, "Open the world map with the citizen layer");
  api.registerCommand("adminmap", openWorldMap, undefined, "Open the world map with the citizen layer");
}

module.exports = {
  name: "AdminWorldMap",
  register: attachPlugin,
};
