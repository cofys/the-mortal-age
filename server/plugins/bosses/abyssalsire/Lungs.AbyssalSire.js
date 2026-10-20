/**
 * The respiratory systems (Wiki: Respiratory system), as captured:
 * - while the tentacles guard them, a hit does 0-3 whatever it rolled, with "You can't deal much
 *   damage with those tentacles getting in the way.";
 * - with the Sire stunned, a hit does at least half the player's maximum hit, and a demonbane
 *   hit (holy water aside) that lands destroys one outright (Wiki, Poll 84);
 * - they regain a hitpoint every 5 seconds (Fight, Wiki);
 * - one destroyed gives 50 Slayer experience (Wiki), leaves its dying vent NPC with
 *   nexus_lung_death and the invisible blocker on its tile, and the dead vent 7 ticks later.
 */
const Common = require("./Common.AbyssalSire");
const { isDemonbaneAttack } = require("../../combat/effects/Demonbane.EquipmentEffects");

const HOLY_WATER = "Holy water";
/** Ticks between the tentacles message, so a fast weapon doesn't flood the chat. */
const MESSAGE_TICKS = 5;

function lungOf(npc) {
  const lair = npc?.__sireLair;
  if (!lair || npc.getId() !== Common.data.npcs.lung) return null;
  return lair.lungs.find((lung) => lung.npc === npc) ?? null;
}

function setDamage(hit, damage) {
  const parts = hit.getHits();
  parts.forEach((part, index) => part.setDamage(index === 0 ? damage : 0));
  hit.updateTotalDamage();
}

function maxHitOf(player, hit) {
  const { DamageFormulas } = Common.core;
  return Math.max(0, DamageFormulas.sourceMaxHit(player, hit.getCombatType()) || 0);
}

function lungHit({ npc, hit }) {
  const lung = lungOf(npc);
  if (!lung) return;
  const fight = npc.__sireLair.fight;
  const attacker = hit.getAttacker?.();
  if (!fight || attacker !== fight.player || lung.dead) {
    setDamage(hit, 0);
    return;
  }
  fight.lastHitAt = fight.tick;
  const guarded = fight.lair.tentacles.some((tentacle) => tentacle.state === "active");
  if (guarded) {
    setDamage(hit, Math.min(npc.getHitpoints(), Common.randomInt(...Common.data.phase1.blockedDamage)));
    if (fight.tick - (fight.tentacleMessageAt ?? -MESSAGE_TICKS) >= MESSAGE_TICKS) {
      fight.tentacleMessageAt = fight.tick;
      attacker.sendMessage(Common.message("tentaclesInTheWay"));
    }
    return;
  }
  if (!hit.isAccurate()) return;
  const weapon = attacker.getEquipment?.()?.getItems?.()?.[Common.core.Equipment.WEAPON_SLOT]?.getDefinition?.()?.getName?.();
  if (isDemonbaneAttack(attacker) && weapon !== HOLY_WATER) {
    setDamage(hit, npc.getHitpoints());
    return;
  }
  const floor = Math.ceil(maxHitOf(attacker, hit) / 2);
  if (hit.getTotalDamage() < floor) setDamage(hit, Math.min(npc.getHitpoints(), floor));
}

/** A lung's death is the chamber's: its vent dies and the fight hears of it, no drop. */
function lungDeath(event) {
  const lung = lungOf(event.npc);
  if (!lung || lung.dead) return;
  event.preventDeath = true;
  const lair = event.npc.__sireLair;
  const fight = lair.fight;
  const { npcs, locs, anims, phase1 } = Common.data;
  const { Animation, GameObject, ObjectManager, Skill } = Common.core;
  lung.dead = true;
  Common.api.removeNpc(lung.npc);
  lung.npc = null;
  fight?.player.getSkillManager().addExperiences(Skill.SLAYER, phase1.lungSlayerXp);
  const dying = lair.spawnNpc(npcs.lungDying, lung.tile, null);
  dying?.performAnimation(new Animation(anims.lungDeath));
  const replace = (id) => {
    if (lung.vent) ObjectManager.deregister(lung.vent, true);
    lung.vent = new GameObject(id, lung.tile, locs.ventShape, lung.rotation, null);
    ObjectManager.register(lung.vent, true);
  };
  replace(locs.ventDying);
  Common.later(phase1.lungDyingTicks, () => {
    if (dying) Common.api.removeNpc(dying);
    if (lair.lungs.includes(lung)) replace(locs.ventDead);
  });
  fight?.lungDied();
}

function attachLungs(api) {
  api.onNpcHitModify(lungHit);
  api.onNpcBeforeDeath(lungDeath);
}

module.exports = { attachLungs, lungHit, lungDeath };
