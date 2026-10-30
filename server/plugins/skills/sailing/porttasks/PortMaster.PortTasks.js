// A port master (rsprox.net recordings): Claim-rewards hands in finished bounties (Wiki) and hands
// over what a full inventory kept back ("Thanks, sailor. Here's your payment."), Cancel-task drops a held task (Wiki: freely, at any
// port master). Talk-to is the Wiki dialogue in npc-dialogues.json. A cancelled task's crates
// go too, from the player's hands and their boats' cargo holds.
const common = require("./Common.PortTasks");
const cargo = require("../Cargo.Sailing");

let pluginApi;

function say(player, npc, text) {
  const { DialogueChainBuilder, NpcDialogue } = common.core();
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new NpcDialogue(0, npc.getId(), text)));
}

function claimRewards(event) {
  const { player, npc } = event;
  // Finished bounties are handed in here (Bounty.PortTasks.js).
  const bounties = { player, handedIn: false };
  require("./Bounty.PortTasks").claim(bounties);
  const unclaimed = player.getAttribute(common.UNCLAIMED_ATTRIBUTE) ?? [];
  if (unclaimed.length === 0 && bounties.handedIn) {
    say(player, npc, "Thanks, sailor. Here's your payment.");
    return;
  }
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
  if (!task || task.cancellable === false) return false;
  held[index] = null;
  common.setSlots(player, held);
  // The crew carrying its crates put them down too (crew/Courier.Crew.js).
  common.setCrewCargo(player, index, null);
  common.core().PluginManager.emitCustomEvent("port-tasks:cancelled", { player, index, task });
  if (task.crate !== undefined && common.heldCrate(player) === task.crate) common.putDown(player);
  for (const boat of player.getSailing().boats) {
    if (task.crate !== undefined) cargo.take(boat, 0, task.crate, cargo.countIn(boat, task.crate));
  }
  player.sendMessage(`You have cancelled the ${common.blue(task.name)} port task.`);
  return true;
}

function cancelTask({ player, npc }) {
  const held = common.slots(player)
    .map((slot, index) => [index, slot && common.taskById(slot.id)])
    .filter(([, task]) => task && task.cancellable !== false);
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
