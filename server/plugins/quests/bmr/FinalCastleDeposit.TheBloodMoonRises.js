const FINAL_STAGE = 100;
const FINAL_STAGE_ATTRIBUTE = "quest.the_blood_moon_rises.stage";
const FINAL_PORTAL_USED_ATTRIBUTE = "quest.the_blood_moon_rises.final-portal-used";
const CHEST_IDS = new Set([61764, 61765]);
const CHEST_TILE = Object.freeze({ x: 2503, y: 7386, z: 0 });
let pluginApi;

function coordinate(location, axis) {
  const getter = `get${axis.toUpperCase()}`;
  return location?.[axis] ?? location?.[getter]?.();
}

function handleFinalCastleDeposit(event) {
  const option = String(event?.option ?? "").toLowerCase();
  if (option !== "deposit") return false;
  const tile = event.location;
  const ids = [event.objectId, event.definition?.id];
  if (!ids.some((id) => CHEST_IDS.has(id)) ||
    coordinate(tile, "x") !== CHEST_TILE.x || coordinate(tile, "y") !== CHEST_TILE.y ||
    coordinate(tile, "z") !== CHEST_TILE.z) return false;

  event.handled = true;
  const player = event.player;
  const location = player?.getLocation?.();
  const stage = Number(player?.getAttribute?.(FINAL_STAGE_ATTRIBUTE));
  const inEarnedCastle = stage === FINAL_STAGE &&
    player.getAttribute(FINAL_PORTAL_USED_ATTRIBUTE) === true &&
    coordinate(location, "x") >= 2500 && coordinate(location, "x") <= 2516 &&
    coordinate(location, "y") >= 7378 && coordinate(location, "y") <= 7390 &&
    coordinate(location, "z") === 0;
  if (!inEarnedCastle) {
    player?.sendMessage?.("The deposit chest is only available in the final Castle staging area.");
    return true;
  }

  pluginApi.emitCustomEvent("bank:open-deposit-box", { player });
  return true;
}

module.exports = function registerFinalCastleDeposit(api) {
  pluginApi = api;
  api.onObjectInteraction("Chest", { Deposit: handleFinalCastleDeposit });
};
