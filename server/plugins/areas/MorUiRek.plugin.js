/**
 * Mor Ul Rek (TzHaar city) area interactions.
 *
 * Cave exit at 2479,5176 > Enter: back into the Karamja volcano dungeon at 2862,9572, beside its
 * cave entrance (rsprox captures, the move on the tick). The rocks up to the surface are
 * Karamja's.
 */
const CAVE_EXIT_POSITION = { x: 2479, y: 5176, z: 0 };
const VOLCANO_DUNGEON_LANDING = [2862, 9572, 0];

let core;

function isAt(location, position) {
  return location.x === position.x && location.y === position.y && (location.z ?? 0) === position.z;
}

function exitToVolcano(event) {
  const { player, location } = event;
  if (!isAt(location, CAVE_EXIT_POSITION)) return false;
  player.moveTo(new core.Location(...VOLCANO_DUNGEON_LANDING));
  event.handled = true;
}

module.exports = {
  name: "MorUiRek",
  members: true,
  register(api) {
    core = api.core;
    api.onObjectInteraction("Cave exit", { Enter: exitToVolcano });
  },
};
