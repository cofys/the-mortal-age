// A port master (rsprox.net recordings): Claim-rewards hands over what a full inventory kept back
// ("Thanks, sailor. Here's your payment."), Cancel-task drops a held task (Wiki: freely, at any
// port master). Talk-to is the Wiki dialogue in npc-dialogues.json. A cancelled task's crates
// go too, from the player's hands and their boats' cargo holds.
const common = require("./Common.PortTasks");
const cargo = require("../cargo");

let pluginApi;

function say(player, npc, text) {
  const { DialogueChainBuilder, NpcDialogue } = common.core();
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new NpcDialogue(0, npc.getId(), text)));
}

function claimRewards({ player, npc }) {
  const unclaimed = player.getAttribute(common.UNCLAIMED_ATTRIBUTE) ?? [];
  if (unclaimed.length === 0) {
    say(player, npc, "According to my records, you don't have any port task rewards to claim.");
    return;
  }
  const inventory = player.getInventory();
  const kept = [];
  for (const itemId of unclaimed) {
    if (inventory.getFreeSlots() > 0) inventory.addItem(new (common.core().Item)(itemId, 1));
    else kept.push(itemId);
  }
  player.setAttribute(common.UNCLAIMED_ATTRIBUTE, kept);
  say(player, npc, "Thanks, sailor. Here's your payment.");
}

/** Drops a held task and its crates: in the player's hands and in their boats' holds. */
function cancel(player, index) {
  const held = common.slots(player);
  const task = held[index] && common.taskById(held[index].id);
  if (!task) return;
  held[index] = null;
  common.setSlots(player, held);
  if (task.crate !== undefined && common.heldCrate(player) === task.crate) common.putDown(player);
  for (const boat of player.getSailing().boats) {
    if (task.crate !== undefined) cargo.take(boat, 0, task.crate, cargo.countIn(boat, task.crate));
  }
  player.sendMessage(`You have cancelled the ${common.blue(task.name)} port task.`);
}

function cancelTask({ player, npc }) {
  const held = common.slots(player)
    .map((slot, index) => [index, slot && common.taskById(slot.id)])
    .filter(([, task]) => task);
  if (held.length === 0) {
    say(player, npc, "I'm afraid you don't have any assigned tasks for me to cancel.");
    return;
  }
  const options = held.flatMap(([index, task]) => [task.name, () => cancel(player, index)]);
  pluginApi.sendMultiChatboxPrompt(player, "Cancel which task?", ...options, "Never mind", () => {});
}

function attach(api) {
  common.init(api);
  pluginApi = api;
  api.onNpcInteraction("Port master", { "Claim-rewards": claimRewards, "Cancel-task": cancelTask });
}

module.exports = attach;
module.exports.cancel = cancel;
