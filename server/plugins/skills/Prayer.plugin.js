const { BONE_XP: BONES } = require("../../src/main/typescript/elvarg/game/content/combat/magic/ArceuusOfferings");
const BURY_DELAY_MS = 1200; // Two OSRS game ticks.
const OFFER_DELAY_MS = 1800; // Three OSRS game ticks per offering.

// OSRS altar multipliers applied to the bury XP: a plain altar (churches,
// Edgeville, etc.) grants 2.5x; a gilded altar grants 3.5x.
const ALTAR_MULTIPLIERS = new Map([
  ["Altar", 2.5],
  ["Gilded altar", 3.5],
]);

function consumeBone(api, player, itemId, slot, xp, messageLines) {
  const core = api.core;
  player.getSkillManager().stopSkillable();
  player.getPacketSender().sendInterfaceRemoval();
  player.performAnimation(new core.Animation(827));
  core.Sounds.sendSound(player, core.Sound.BURY_BONES);
  const location = player.getLocation().clone();
  const inventory = player.getInventory();
  // Consume and award XP together on the resolving tick. An interrupted
  // burial/offering keeps its bone, including on logout before the account
  // is saved.
  const task = new core.CountdownTask(player, 2, () => {
    if (!canComplete() || inventory.get(slot)?.getId() !== itemId) return;
    inventory.deleteAtSlot(slot, 1);
    for (const line of messageLines(player, itemId)) {
      player.sendMessage(line);
    }
    player.getSkillManager().addExperiences(core.Skill.PRAYER, xp);
  });
  function canComplete() {
    return player.isRegistered() && player.getHitpoints() > 0 &&
      player.getLocation().equals(location) && player.getMovementQueue().size() === 0 &&
      player.getForceMovement() == null;
  }
  task.onTick = () => { if (!canComplete()) task.stop(); };
  const stop = task.stop.bind(task);
  task.stop = () => {
    stop();
    if (player.isRegistered()) player.performAnimation(core.Animation.DEFAULT_RESET_ANIMATION);
  };
  api.getTaskManager().submit(task);
  player.getClickDelay().reset();
  return true;
}

function buryBone(api, { player, itemId, slot }) {
  const core = api.core;
  const xp = BONES.get(itemId);
  if (!xp) return false;
  if (!player.getClickDelay().elapsedTime(BURY_DELAY_MS)) return true;
  const inventory = player.getInventory();
  if (inventory.get(slot)?.getId() !== itemId) return true;

  return consumeBone(api, player, itemId, slot, xp, (p, id) => [
    "You dig a hole in the ground..",
    `..and bury the ${core.ItemDefinition.forId(id).getName()}.`,
  ]);
}

function offerBone(api, event) {
  const { player, itemId, slot, object } = event;
  const core = api.core;
  const baseXp = BONES.get(itemId);
  if (!baseXp) return;
  const altarName = object.getDefinition()?.getName();
  const multiplier = ALTAR_MULTIPLIERS.get(altarName);
  if (!multiplier) return;
  if (!player.getClickDelay().elapsedTime(OFFER_DELAY_MS)) {
    event.handled = true;
    return;
  }
  const inventory = player.getInventory();
  if (inventory.get(slot)?.getId() !== itemId) {
    event.handled = true;
    return;
  }
  const xp = Math.floor(baseXp * multiplier);
  const offered = consumeBone(api, player, itemId, slot, xp, (p, id) => {
    const boneName = core.ItemDefinition.forId(id).getName();
    return altarName === "Gilded altar"
      ? [
          `You offer the ${boneName} at the gilded altar.`,
          "The gods are pleased with your offering.",
        ]
      : [`You offer the ${boneName} at the altar.`];
  });
  if (offered) event.handled = true;
}

module.exports = {
  name: "Prayer",
  register(api) {
    api.onItemFirstAction(buryBone.bind(null, api));
    api.onItemOnObject(offerBone.bind(null, api), { noted: false });
  },
};
