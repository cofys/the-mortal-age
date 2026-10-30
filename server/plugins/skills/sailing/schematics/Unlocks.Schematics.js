const common = require("./Common.Schematics");
const READ_SOUND = 2655; // rev241 synth_2655, RSProx235/3792 Read.

function read(event) {
  if (!common.canItemRead(event)) return;
  const row = common.rowForItem(event.itemId);
  if (!row) return;
  if (common.learned(event.player, row)) {
    event.player.sendMessage("You already know everything this schematic can teach you.");
    return;
  }
  event.player.getInventory().deleteAtSlot(event.slot, 1, false);
  common.markLearned(event.player, row);
  event.player.getInventory().refreshItems();
  event.player.getPacketSender().sendSound(READ_SOUND, 1, 0);
  common.itemBox(event.player, row.itemId,
    `You read the schematic. It details how to build <col=000080>${row.part}<col=000000> on boats. You take in everything the schematic covers and then discard it.`);
}
function canBuild(request) {
  const row = common.rows().find(candidate => candidate.buildRowIds.includes(request.row));
  if (!row || common.learned(request.player, row)) return;
  request.allow = false;
  request.player.sendMessage("You need to find and read the relevant schematic before you can build that.");
}
function directions(event) {
  const row = common.rows().find(row => row.box?.hintId === event.itemId);
  if (!row) return false;
  if (common.canItemRead(event)) common.itemBox(event.player, event.itemId, row.box.directions);
  return true;
}
function destroyPrompt(event) {
  const row = common.rows().find(row => row.itemId === event.item?.getId() || row.box?.keyId === event.item?.getId());
  if (!row) return;
  event.warning = row.box ? "You'll need to find the relevant lockbox again."
    : row.key === "ballistic_attractor" ? "You'll need to speak to Ava to get another."
      : "You'll need to speak to Elder Raley on The Great Conch to get another.";
}
function attach(api) {
  for (const row of common.rows()) api.onItemAction(row.name, { Read: read });
  for (const name of new Set(common.rows().filter(row => row.box).map(row => common.core().CacheDefinitions.getItem(row.box.hintId).name))) {
    api.onItemAction(name, { Read: directions });
  }
  api.onCustomEvent("sailing:schematic-can-build", canBuild);
  api.onCustomEvent("destroy-item:prompt", destroyPrompt);
}
module.exports = attach;
