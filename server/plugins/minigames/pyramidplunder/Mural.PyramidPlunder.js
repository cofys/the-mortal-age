"use strict";

/**
 * The Mural in the Pyramid Plunder starting areas (ntk_tomb_wall_scoreboard: Read), the
 * minigame's scoreboard: how many Grand Gold Chests the reader has pillaged in each of the eight
 * rooms. Before the first, "At the time of writing, no pillaging has taken place here."
 * (Wiki, Mural (Pyramid Plunder)). It opens interface ntk_scores, the handwritten scroll with ten
 * lines. A chest counts when its search goes ahead (Containers.PyramidPlunder.js), swarm or not.
 *
 * Not from a recording or the Wiki: how the counts are worded. The Wiki's text gives only the
 * no-pillaging line (its screenshot, File:Mural (Pyramid Plunder) interface.png, has no
 * transcription and wasn't used), so each room is one line, "Room N: X", in room order, under
 * the first line "Grand Gold Chests pillaged:".
 */

const Common = require("./Common.PyramidPlunder");

const MURAL_LOC = "ntk_tomb_wall_scoreboard";
const INTERFACE_NAME = "ntk_scores";
/** The scroll's ten text lines, top to bottom. */
const LINES = 10;
/** Per player: the Grand Gold Chests pillaged, by room (index 0 is room 1). */
const CHESTS_ATTRIBUTE = "pyramid-plunder:grand-gold-chests";
const NONE = "At the time of writing, no pillaging has taken place here.";
const HEADER = "Grand Gold Chests pillaged:";

const cache = () => Common.getCore().CacheDefinitions;
const count = (value) => (Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0);

/** The player's counts, one per room, from whatever was saved. */
function chestsOf(player) {
  const saved = player.getAttribute(CHESTS_ATTRIBUTE);
  return Common.ROOMS.map((_, index) => count(Array.isArray(saved) ? saved[index] : 0));
}

/** A Grand Gold Chest searched in `room` (1-8). */
function chestPillaged(player, room) {
  const chests = chestsOf(player);
  const index = Math.trunc(Number(room)) - 1;
  if (!(index >= 0 && index < chests.length)) return;
  chests[index]++;
  player.setAttribute(CHESTS_ATTRIBUTE, chests);
}

/** The scroll's lines for this player, all ten (blank ones clear what was there). */
function lines(player) {
  const chests = chestsOf(player);
  const text = chests.some((n) => n > 0)
    ? [HEADER, ...chests.map((n, index) => `Room ${index + 1}: ${n.toLocaleString("en-US")}`)]
    : [NONE];
  while (text.length < LINES) text.push("");
  return text;
}

function read(event) {
  if (event.objectId !== cache().getLocId(MURAL_LOC)) return false;
  const player = event.player;
  const sender = player.getPacketSender();
  sender.sendInterface(cache().getInterfaceId(INTERFACE_NAME));
  lines(player).forEach((text, index) => {
    sender.sendString(text, cache().getComponentId(`${INTERFACE_NAME}:messagescroll${index + 1}_hw`));
  });
  return true;
}

module.exports = function registerMural(api) {
  Common.bind(api);
  api.persistAttribute(CHESTS_ATTRIBUTE, []);
  api.onObjectInteraction("Mural", { Read: read });
};

module.exports._test = { MURAL_LOC, INTERFACE_NAME, CHESTS_ATTRIBUTE, NONE, HEADER, chestsOf, chestPillaged, lines, read };
module.exports.chestPillaged = chestPillaged;
