/**
 * Tai Bwo Wannai Cleanup: the Broodoo victims a hack can disturb (combat white, poison green,
 * disease yellow).
 *
 * rsprox 227/01858 and 237/01102: they cast entangle every 6 ticks (human_castentangle, spotanim
 * 177 on the caster, entangle_travel to the player, sounds 2247, 151 and 227); the poison victim's
 * hits also bring "You feel incredibly weakened." and drain Attack, Strength, Defence, Ranged and
 * Magic by 1-3. The Wiki: max hit 7; a player's own hits do at most 3, but the right thing used on
 * one hurts it: any food on the white one (10-35, Cooking XP twice the damage), one dose of an
 * antipoison on the green one (antipoison 20, superantipoison and sanfew 30, antidote+ 40,
 * antidote++ and anti-venom 50; Herblore XP twice the damage after Druidic Ritual), Relicym's balm
 * or a sanfew serum on the yellow one; anything else "Nothing interesting happens.". The balm's
 * and sanfew's damage on the yellow one is not given anywhere; it is 30 here, as the sanfew's on
 * the green one. The disease victim's own effect is not recorded and is not modelled.
 */
const Common = require("./Common.TaiBwoWannaiCleanup");

const broodoo = () => Common.data.events.broodoo;
const npcId = (name) => Common.core.CacheDefinitions.getNpcId(name) ?? -1;
const ids = () => broodoo().npcs.map(npcId);
const nameOfId = (id) => broodoo().npcs.find((name) => npcId(name) === id) ?? null;
const between = ([low, high]) => low + Math.floor(Math.random() * (high - low + 1));

function combatClass() {
  const { Animation, CombatMethod, CombatType, Graphic, PendingHit, Projectile } = Common.core;
  return class BroodooVictimCombat extends CombatMethod {
    start(character, target) {
      const npc = character?.getAsNpc?.();
      if (!npc || !target) return;
      const { cast } = broodoo();
      npc.performAnimation(new Animation(Common.seqId(cast.seq)));
      npc.performGraphic?.(new Graphic(cast.spotanim));
      const projectile = Common.core.CacheDefinitions.getSpotanimId(cast.projectile);
      new Projectile(Projectile.centreOf(npc), target.getLocation(), target, projectile, cast.start, cast.end,
        cast.startHeight, cast.endHeight, npc.getPrivateArea()).withSource(npc).withAngle(cast.angle).withProgress(cast.progress).sendProjectile();
      if (target.isPlayer?.()) for (const [sound, delay] of cast.sounds) Common.sound(target.getAsPlayer(), sound, delay);
      this.weakens = npc.getId() === npcId(broodoo().weaken.npc);
    }

    hits(character, target) {
      if (!character || !target) return [];
      const hit = new PendingHit(character, target, this, { delay: Math.max(1, Math.ceil(broodoo().cast.end / 30)) });
      hit.setTotalDamage(Math.min(broodoo().maxHit, hit.getTotalDamage()));
      // Only a hit that lands and hurts weakens (a hit dropped with its dead caster does nothing).
      if (this.weakens && target.isPlayer?.()) {
        const player = target.getAsPlayer();
        for (const part of hit.getHits()) part.onApplied((taken) => {
          if (taken > 0) weaken(player);
        });
      }
      return [hit];
    }

    attackDistance() {
      return broodoo().distance;
    }

    attackSpeed() {
      return broodoo().speed;
    }

    type() {
      return CombatType.MAGIC;
    }
  };
}

function weaken(player) {
  const { weaken: drain } = broodoo();
  const skills = player.getSkillManager();
  for (const name of drain.skills) {
    const skill = Common.core.Skill[name];
    skills.setCurrentLevel(skill, Math.max(0, skills.getCurrentLevel(skill) - between(drain.drain)));
  }
  player.sendMessage(drain.message);
  Common.sound(player, drain.sound);
}

/**
 * A player's own blow on a victim does at most 3 in all (Wiki): capped as it is queued, before its
 * combat XP is paid, a multi-hit special sharing the 3 between its hits.
 */
function capHit({ target, hit }) {
  if (!ids().includes(target?.getId?.())) return;
  let left = broodoo().playerMaxHit;
  for (const damage of hit.getHits()) {
    const value = Math.min(damage.getDamage(), left);
    damage.setDamage(value);
    left -= value;
  }
  hit.updateTotalDamage();
}

const item = (id) => Common.core.CacheDefinitions.getItem(id);
const isNoted = (id) => item(id)?.noteTemplate >= 0;
const isFood = (id) => (item(id)?.inventoryActions ?? []).includes("Eat");
/** The potion's name without its dose, and its family (Potions' "potions:dose-family"). */
function potionOf(id) {
  const request = { itemId: id, family: null };
  Common.api.emitCustomEvent("potions:dose-family", request);
  const name = /^(.*)\((\d)\)$/.exec(item(id)?.name ?? "")?.[1];
  return request.family && name ? { name, family: request.family } : null;
}

function questComplete(player, key) {
  const request = { player, key };
  Common.api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

/** One dose used: the next lower dose, or the family's empty vessel after the last. */
function useDose(player, id, family) {
  const dose = family.byDose.indexOf(id);
  const inventory = player.getInventory();
  inventory.delete(id, 1);
  const next = family.byDose[Math.max(0, dose - 1)];
  if (next > 0) inventory.add(new Common.core.Item(next, 1));
}

/** The right thing on the right victim hurts it; anything else does nothing. */
function feed(event) {
  const { player, target: npc, itemId } = event;
  const name = nameOfId(npc?.getId?.());
  if (!name) return false;
  event.handled = true;
  const rule = broodoo().feed[name];
  if (npc.getHitpoints() <= 0 || npc.isDyingFunction?.()) return true;
  let damage = 0;
  let use = null;
  if (isNoted(itemId)) {
    damage = 0;
  } else if (rule.kind === "food" && isFood(itemId)) {
    damage = between(rule.damage);
    use = () => player.getInventory().delete(itemId, 1);
  } else if (rule.kind === "potion") {
    const potion = potionOf(itemId);
    if (potion && rule.potions[potion.name] !== undefined) {
      damage = rule.potions[potion.name];
      use = () => useDose(player, itemId, potion.family);
    }
  }
  if (damage <= 0 || !use) {
    player.sendMessage(broodoo().nothing);
    return true;
  }
  use();
  const { HitDamage, HitMask } = Common.core;
  const dealt = npc.decrementHealth(new HitDamage(Math.min(damage, npc.getHitpoints()), HitMask.RED));
  npc.addTickHit?.(dealt);
  // Counted as the player's damage, so the kill (favour, drops) is theirs.
  npc.getCombat().addDamage(player, dealt.getDamage());
  if (rule.kind === "food" || !rule.quest || questComplete(player, rule.quest)) Common.xp(player, rule.skill, dealt.getDamage() * 2);
  if (!npc.getCombat().getTarget?.()) npc.getCombat().attack(player);
  return true;
}

function attachBroodoo(api) {
  api.registerNpcCombatMethodProvider(ids(), combatClass(), { singleton: false });
  api.onPlayerDealtDamage(capHit);
  api.onItemOnNpc(feed);
}

module.exports = { attachBroodoo, feed, capHit, weaken, combatClass };
