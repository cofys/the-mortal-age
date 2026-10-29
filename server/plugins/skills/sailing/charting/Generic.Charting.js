// Generic charting spots (rsprox 1009, 3455, 3467, 944, 948): a loc at sea with one option, Chart,
// used from the deck within its usual reach (further off: "I can't reach that!", and the helm is
// kept). The click lets go of the helm; then, a tick later when the player was at it, the writing
// animation, the spot's own line and the charting (Common.complete). Two generic tasks have no
// loc of their own: the Port Sarim port task board and salvaging station chart as they're used.
const common = require("./Common.Charting");

const SEQ_WRITING = 13302; // human_sailing_charting_writing01
const ALREADY_CHARTED = "You have already charted this and can get no further information from it.";
const NO_ROOM = "You don't have enough inventory space.";
/** Locs whose gameval name differs from their task's row name. */
const LOC_NAMES = Object.freeze({ generic_rowboat_port_khazard: "sailing_charting_generic_rowboat_strait_of_khazard" });
/** The two tasks charted by using a Port Sarim loc (the Wiki: the board at 3030,3198, the station at 3029,3207). */
const USED_AT_PORT_SARIM = Object.freeze([
  { key: "generic_board_port_sarim", name: "Notice board", option: "Inspect" },
  { key: "generic_salvage_station_port_sarim", name: "Salvaging station", option: "Sort-salvage" },
]);
const PORT_SARIM_REACH = 3;
/**
 * The crab statue on Wintumber Island also hands over a Medallion fragment (rsprox 944: the
 * collection log line, then this object box, with the fragment in the inventory).
 */
const CRAB_STATUE = Object.freeze({
  key: "generic_crab_statue",
  item: 32395, // motd_frag_8
  text: "As you inspect the monument, a crab suddenly scuttles up to you and presses a mysterious piece of a medallion into your hands! Before it departs, it moves its pincers in an unusual way, almost as if it's dancing!",
});

let byLoc;

/** Each generic spot's loc id. */
function spotsByLoc() {
  if (byLoc) return byLoc;
  const { CacheDefinitions } = common.core();
  byLoc = new Map();
  for (const spot of common.spotsOfType("generic")) {
    const id = CacheDefinitions.getLocId(LOC_NAMES[spot.key] ?? `sailing_charting_${spot.key}`);
    if (id !== null && id !== undefined) byLoc.set(id, spot);
  }
  return byLoc;
}

function chart(player, spot) {
  if (common.isCharted(player, spot)) {
    player.sendMessage(ALREADY_CHARTED);
    return;
  }
  if (!roomForReward(player, spot)) return;
  common.afterHelm(player, () => {
    if (common.isCharted(player, spot) || !roomForReward(player, spot)) return;
    player.performAnimation(new (common.core().Animation)(SEQ_WRITING));
    if (common.complete(player, spot) && spot.key === CRAB_STATUE.key) crabFragment(player);
  });
}

/**
 * The crab statue's fragment needs a free slot; with none the statue stays uncharted, so charting
 * it again later still hands the fragment over (ours: the full-inventory case isn't captured).
 */
function roomForReward(player, spot) {
  if (spot.key !== CRAB_STATUE.key || player.getInventory().getFreeSlots() > 0) return true;
  player.sendMessage(NO_ROOM);
  return false;
}

function crabFragment(player) {
  const { Item, DialogueChainBuilder, ItemStatementDialogue } = common.core();
  const inventory = player.getInventory();
  const before = inventory.getAmount(CRAB_STATUE.item);
  inventory.addItem(new Item(CRAB_STATUE.item, 1));
  if (inventory.getAmount(CRAB_STATUE.item) <= before) return;
  common.api().emitCustomEvent("collection-log:obtain", { player, itemId: CRAB_STATUE.item });
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, CRAB_STATUE.item, CRAB_STATUE.text)));
}

function onLoc(event) {
  const spot = spotsByLoc().get(event.objectId);
  if (!spot || event.clickType !== 1) return;
  event.handled = true;
  chart(event.player, spot);
}

/** The board's Inspect and the station's Sort-salvage chart their task first, then go on as usual. */
function onPortSarimLoc(event) {
  const name = event.definition?.getName?.();
  const used = USED_AT_PORT_SARIM.find((each) => each.name === name && each.option === event.option);
  if (!used) return;
  const spot = common.spotByKey(used.key);
  const [x, y] = spot?.location ?? [];
  if (!spot || Math.max(Math.abs(event.location.x - x), Math.abs(event.location.y - y)) > PORT_SARIM_REACH) return;
  if (!common.isCharted(event.player, spot)) common.complete(event.player, spot);
}

function attach(api) {
  common.init(api);
  api.setUsableFromDeck([...spotsByLoc().keys()]);
  api.onObjectInteraction(onLoc);
  api.onBeforeObjectInteraction(onPortSarimLoc);
}

module.exports = attach;
module.exports.spotsByLoc = spotsByLoc;
module.exports.ALREADY_CHARTED = ALREADY_CHARTED;
