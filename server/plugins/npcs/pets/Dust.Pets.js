// Wiki: Metamorphic dust and its transcript. Unlock requires Use on the owned follower.
let api, services;
function useDust(event) {
  const { player, target: npc, itemId, item, slot } = event;
  const { ItemIdentifiers, Item, DialogueChainBuilder, ItemStatementDialogue } = api.core;
  if (event.handled || itemId !== ItemIdentifiers.METAMORPHIC_DUST || !player || !npc) return;
  const pet = services.getPetByNpcId(npc.getId());
  if (pet?.itemId !== ItemIdentifiers.OLMLET || player.getAttribute("pets:current") !== npc
      || npc.getOwner() !== player || !npc.isRegistered()) return;
  event.handled = true;
  // The walk-to callback can outlive the action's original life/interface state.
  if (!player.isRegistered() || player.busy()) return;
  const inventory = player.getInventory();
  if (inventory.getItems()[slot] !== item || item?.getId() !== itemId || item.getAmount() < 1) return;
  const family = services.petFamily(pet);
  if (services.getMorphUnlocks(player).includes(family)) {
    player.sendMessage("You have already unlocked the metamorphosis ability for your pet.");
    return;
  }
  inventory.deletedItem(new Item(itemId, 1), slot, true);
  services.unlockMorphFamily(player, family);
  api.emitCustomEvent("persistence:save", { player, reason: "pet-metamorphosis" });
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new ItemStatementDialogue(0, itemId, "You sprinkle the dust over Olmlet. Congratulations! You may now metamorphise them."),
  ));
}
function attach(pluginApi, helpers) {
  api = pluginApi; services = helpers;
  api.onItemOnNpc(useDust);
}
module.exports = { attach };
