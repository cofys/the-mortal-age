/**
 * Zahur's "Make unfinished potion(s)" in Nardah (https://oldschool.runescape.wiki/w/Zahur):
 * after the hard Desert Diary, or while wearing a Herblore cape (or max cape), she makes every
 * clean herb and vial of water the player carries - noted or not - into unfinished potions for
 * 200 coins each, as many as they can pay for. Noted pairs come back noted. The option is only
 * on her right-click menu; its messages have no capture.
 */
const COST = 200;

let api;
let core;

function unlocked(player) {
  const cape = { player, skill: "HERBLORE", result: false };
  api.emitCustomEvent("skillcape:has-perk", cape);
  if (cape.result === true) return true;
  const diary = { player, diary: "desert", tier: "hard", complete: false };
  api.emitCustomEvent("diary:is-complete", diary);
  return diary.complete === true;
}

function unfinishedFor(herbId) {
  const request = { herbId, potion: null };
  api.emitCustomEvent("herblore:unfinished", request);
  return request.potion;
}

function notedOf(id) {
  return core.ItemDefinition.forId(id)?.getNoteId?.() ?? -1;
}

/** Each kind of carried clean herb with its unfinished potion, unnoted and noted counts. */
function herbsCarried(player) {
  const inventory = player.getInventory();
  const herbs = new Map();
  for (const item of inventory.getItems()) {
    const id = item?.getId?.() ?? -1;
    if (id <= 0) continue;
    const definition = core.ItemDefinition.forId(id);
    const herbId = definition.isNoted() ? definition.unNote() : id;
    if (herbs.has(herbId)) continue;
    const potion = unfinishedFor(herbId);
    if (potion) herbs.set(herbId, { potion, unnoted: inventory.getAmount(herbId), noted: inventory.getAmount(notedOf(herbId)) });
  }
  return herbs;
}

function makeUnfinished(event) {
  const { player } = event;
  if (!unlocked(player)) {
    player.sendMessage("Zahur will only do that for those who have completed the hard Desert Diary.");
    return true;
  }
  const inventory = player.getInventory();
  const { ItemIdentifiers } = core;
  const vial = ItemIdentifiers.VIAL_OF_WATER;
  let vials = { unnoted: inventory.getAmount(vial), noted: inventory.getAmount(notedOf(vial)) };
  let affordable = Math.floor(inventory.getAmount(ItemIdentifiers.COINS) / COST);
  let made = 0;
  for (const [herbId, herb] of herbsCarried(player)) {
    for (const kind of ["unnoted", "noted"]) {
      const count = Math.min(herb[kind], vials[kind], affordable);
      if (count <= 0) continue;
      const noted = kind === "noted";
      inventory.deleteNumber(noted ? notedOf(herbId) : herbId, count);
      inventory.deleteNumber(noted ? notedOf(vial) : vial, count);
      inventory.deleteNumber(ItemIdentifiers.COINS, count * COST);
      inventory.adds(noted ? notedOf(herb.potion) : herb.potion, count);
      vials = { ...vials, [kind]: vials[kind] - count };
      affordable -= count;
      made += count;
    }
  }
  player.sendMessage(made === 0
    ? "Zahur needs clean herbs, vials of water and 200 coins for each potion."
    : `Zahur makes ${made} unfinished potion${made === 1 ? "" : "s"} for you.`);
  return true;
}

module.exports = {
  name: "Zahur",
  members: true,
  _test: { makeUnfinished, unlocked, herbsCarried },
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    api.onNpcInteraction("Zahur", { "Make unfinished potion(s)": makeUnfinished });
  },
};
