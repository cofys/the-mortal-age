// OSRS Wiki: Stray dog. Only public Shoo-away dogs, never A Ruff Situation actors.
const followers = new WeakMap();
const PET_SOUND = 652;
const SHOO_SOUND = 911;
// shortcut: Wiki specifies a temporary follow but no duration; calibrate 100 ticks from a live capture.
const FOLLOW_TICKS = 100;

function publicDog(definition) {
  return definition.getName() === "Stray dog" && definition.getActions().includes("Shoo-away");
}

function stopFollowing(npc) {
  followers.get(npc)?.stop();
  followers.delete(npc);
  npc.setFollowing(null);
  npc.setMobileInteraction(null);
  npc.getMovementQueue().reset();
}

function follow(core, player, npc) {
  stopFollowing(npc);
  npc.setFollowing(player);
  let remaining = FOLLOW_TICKS;
  const task = new (class extends core.Task {
    constructor() { super(1, npc); }
    execute() {
      const tile = player.getLocation();
      if (--remaining <= 0 || !npc.isRegistered() || !player.isRegistered() || player.getHitpoints() <= 0 ||
          player.getPrivateArea() !== npc.getPrivateArea() || !npc.getLocation().isWithinDistance(tile, 15)) {
        stopFollowing(npc);
        return;
      }
      const indoors = core.RegionManager.getRegion(tile.getX(), tile.getY())?.isUnderRoof(tile.getX(), tile.getY(), tile.getZ());
      npc.setFollowing(indoors ? null : player);
      if (indoors) npc.getMovementQueue().reset();
    }
  })();
  followers.set(npc, task);
  core.TaskManager.submit(task);
}

function flee(core, player, npc) {
  stopFollowing(npc);
  const tile = npc.getLocation();
  const from = player.getLocation();
  const dx = Math.sign(tile.getX() - from.getX()) || 1;
  const dy = Math.sign(tile.getY() - from.getY());
  npc.getMovementQueue().addSteps(new core.Location(tile.getX() + dx * 3, tile.getY() + dy * 3, tile.getZ()));
}

function catEars(core, player, npc) {
  const head = player.getEquipment().get(core.Equipment.HEAD_SLOT).getId();
  if (![core.ItemIdentifiers.CAT_EARS, core.ItemIdentifiers.HELL_CAT_EARS].includes(head)) return false;
  npc.forceChat("Bark!");
  player.sendMessage("He doesn't approve of your ears.");
  flee(core, player, npc);
  return true;
}

function pet(core, { player, npc, definition }) {
  if (!publicDog(definition)) return false;
  if (catEars(core, player, npc)) return;
  player.forceChat("Who's a good doggie?");
  npc.forceChat("Woof!");
  player.getPacketSender().sendSoundEffect(PET_SOUND, 1, 0);
  follow(core, player, npc);
}

function shoo(core, { player, npc, definition }) {
  if (!publicDog(definition)) return false;
  if (catEars(core, player, npc)) return;
  player.forceChat("Thbbbbt!");
  npc.forceChat("Whine!");
  player.getPacketSender().sendSoundEffect(SHOO_SOUND, 1, 0);
  flee(core, player, npc);
}

function feed(api, event) {
  const { player, target: npc, definition, item, itemId, slot } = event;
  if (!publicDog(definition)) return;
  event.handled = true;
  const core = api.core;
  if (catEars(core, player, npc)) return;
  const I = core.ItemIdentifiers;
  if ([I.SHAIKAHAN_BONES, I.MARINATED_J_BONES, I.MARINATED_J_BONES_2].includes(itemId)) {
    player.sendMessage("That's disgusting - you can't give it to the poor dog!");
    return;
  }
  const bones = /\bbones$/i.test(item.getDefinition().getName());
  const meat = [I.RAW_BEEF, I.RAW_RAT_MEAT, I.RAW_BEAR_MEAT, I.RAW_CHICKEN, I.COOKED_MEAT].includes(itemId);
  if (item.getDefinition().isNoted() || (!bones && !meat)) {
    npc.forceChat("Grrrr!");
    player.sendMessage("The dog doesn't seem interested in that.");
    return;
  }
  player.getInventory().deleteAtSlot(slot);
  npc.forceChat("Woof woof!");
  player.sendMessage(bones ? "You give the dog some nice bones." : "You give the dog a nice piece of meat.");
  player.sendMessage(bones ? "It happily gnaws on them." : "It gobbles it up.");
  follow(core, player, npc);
  if (itemId === I.BONES) api.emitCustomEvent("diary:task", { player, diary: "varrock", task: "give-a-dog-a-bone" });
}

module.exports = {
  name: "StrayDogs",
  register(api) {
    api.onNpcInteraction("Stray dog", { Pet: pet.bind(null, api.core), "Shoo-away": shoo.bind(null, api.core) });
    api.onItemOnNpc(feed.bind(null, api));
  },
};
