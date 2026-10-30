const common = require("./Common.Schematics");

function complete(player, key) {
  const request = { player, key, complete: null };
  common.api().emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}
function ready(player) { return complete(player, "animal_magnetism") && complete(player, "pandemonium"); }
function ballistic() { return common.rows().find(row => row.key === "ballistic_attractor"); }
function owns(player, row) { return common.learned(player, row) || common.has(player, row.itemId); }
function give(player, row) {
  const inventory = player.getInventory(), item = new (common.core().Item)(row.itemId);
  if (inventory.getAddableAmount(item) < 1) { inventory.full(); return false; }
  inventory.add(item, true);
  common.api().emitCustomEvent("collection-log:obtain", { player, itemId: row.itemId, amount: 1, ensure: true });
  return true;
}
function avaAction(event) {
  if (event.npcId !== common.core().NpcIdentifiers.AVA || event.kind !== "message" || event.stepId !== "xcs6-R") return;
  const row = ballistic();
  if (!ready(event.player) || owns(event.player, row) || !give(event.player, row)) {
    event.handled = true;
    event.end = true;
  }
}
function condition(event) {
  if (event.npcId !== common.core().NpcIdentifiers.AVA) return null;
  if (event.stepId === "bYHaYD") return ready(event.player) && !owns(event.player, ballistic());
  if (event.stepId === "BN_FyY") return ready(event.player) && owns(event.player, ballistic());
  return null;
}
function raley(event) {
  if (event.npc.getId() !== common.core().NpcIdentifiers.ELDER_RALEY || event.clickType !== 1) return;
  const { player } = event;
  if (!complete(player, "the_red_reef") || player.busy() || player.getHitpoints() <= 0) return;
  const row = common.rows().find(row => row.key === "bosuns_workbench");
  if (owns(player, row)) return;
  event.handled = true;
  if (give(player, row)) common.itemBox(player, row.itemId, "Elder Raley hands you a schematic.");
}
function questReward(event) {
  if (event.key !== "the_red_reef") return;
  const row = common.rows().find(row => row.key === "bosuns_workbench");
  // QuestRuntime grants before this event, using an owned ground drop when full.
  common.api().emitCustomEvent("collection-log:obtain", { player: event.player, itemId: row.itemId, amount: 1, ensure: true });
}
function attach(api) {
  api.onCustomEvent("npc-dialogue:action", avaAction);
  api.onNpcDialogueCondition(condition);
  api.onBeforeNpcInteraction(raley);
  api.onCustomEvent("quest:completed", questReward);
}
module.exports = { attach };
