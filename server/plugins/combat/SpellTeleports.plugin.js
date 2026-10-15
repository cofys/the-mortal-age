const { CacheDefinitions } = require("../../src/main/typescript/elvarg/game/cache/CacheDefinitions");
const { SpellTeleports } = require("../../src/main/typescript/elvarg/game/content/combat/magic/SpellTeleports");

function spellName(event) {
  const itemId = event.itemId ?? -1;
  const packed = Number.isInteger(event.groupId) && Number.isInteger(event.childId)
    ? (event.groupId << 16) | (event.childId & 0xffff)
    : -1;
  return CacheDefinitions.getSpellName(event.buttonId, itemId)
    ?? CacheDefinitions.getSpellName(packed, itemId)
    ?? CacheDefinitions.getSpellName(event.childId ?? -1, itemId);
}

let core;
let pluginApi;

const HOUSE_TABLET = "teleport to house";
const HOUSE_TABLET_OPTIONS = new Set(["break", "inside", "outside"]);
const REDIRECTED_HOUSE_TABLETS = new Map([
  ["rimmington teleport", [2953, 3224, 0]],
  ["taverley teleport", [2893, 3466, 0]],
  ["pollnivneach teleport", [3340, 3004, 0]],
  ["rellekka teleport", [2670, 3632, 0]],
  ["brimhaven teleport", [2757, 3179, 0]],
]);
// Clue teleport scrolls use the cache option "Teleport" rather than "Break".
// The Nardah scroll lands beside the town's carpet merchant (Wiki: Nardah,
// near the Magic carpet); that is the nearest supported walking arrival for
// routes which continue north-east to the Ancient Vault.
const SCROLL_TELEPORTS = new Map([
  ["nardah teleport", [3401, 2918, 0]],
]);

/**
 * Teleport tablets share their spell's name ("Varrock teleport") and destination;
 * the house tablet asks Construction where the player's house is. The usual teleport
 * rules (level 20 Wilderness, teleblock, busy) are checked first, so a refused
 * tablet is never used up.
 */
function breakTablet(event) {
  const option = event.option?.toLowerCase() ?? "";
  const name = core.ItemDefinition.forId(event.itemId)?.getName?.()?.toLowerCase() ?? "";
  const house = name === HOUSE_TABLET;
  const scroll = SCROLL_TELEPORTS.get(name);
  if (house ? !HOUSE_TABLET_OPTIONS.has(option) : (scroll ? option !== "teleport" : option !== "break")) return;
  let destination = null;
  let onArrival;
  if (house) {
    const request = { player: event.player, option, destination: null, onArrival: null };
    pluginApi.emitCustomEvent("construction:house-tablet", request);
    destination = request.destination;
    onArrival = request.onArrival ?? undefined;
    event.handled = true;
  } else {
    destination = scroll ? new core.Location(...scroll) :
      SpellTeleports.getTeleportDestinations().find((spell) => spell.name === name)?.destination;
    if (!destination) {
      const tile = REDIRECTED_HOUSE_TABLETS.get(name);
      if (tile) destination = new core.Location(...tile);
    }
    if (destination) event.handled = true;
  }
  if (!destination) return;
  const { player } = event;
  if (!player.getInventory().contains(event.itemId) || !core.TeleportHandler.checkReqs(player, destination)) return;
  // OSRS uses the tablet up two ticks in, as it is absorbed (docs/teleport-tablets.md).
  const useTablet = () => player.getInventory().deleteNumber(event.itemId, 1);
  core.TeleportHandler.teleport(player, destination, core.TeleportType.TELE_TAB, false, onArrival, useTablet);
}

module.exports = {
  name: "SpellTeleports",
  register(api) {
    core = api.core;
    pluginApi = api;
    api.onItemAction(breakTablet);
    api.onInterfaceActionClick((event) => {
      if (SpellTeleports.handleSelf(event.player, spellName(event))) {
        event.handled = true;
      }
    });
  },
};
