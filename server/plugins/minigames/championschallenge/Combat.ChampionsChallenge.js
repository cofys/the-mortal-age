"use strict";

/**
 * The champions' attacks. The melee-only ones (Giant, Zombies, Earth Warrior, Jogre, Leon d'Cour)
 * fight with the core NPC melee and their npc-combat-defs.json animations; these six have ranged
 * or magic attacks, named in the cache (champions_* sequences and spot animations). Styles and
 * max hits are the Wiki's; the Ghoul and the Lesser Demon "will not close in to use [their]
 * melee attack" (Wiki), so they keep their distance and swing only at a player beside them.
 * Projectile timing is not captured: it uses a thrown weapon's arc.
 *
 *   { style: "MELEE" | "RANGED" | "MAGIC", anim, maxHit?, npcGfx?, projectile?, targetGfx? }
 */
const Common = require("./Common.ChampionsChallenge");

const CYCLES_PER_TICK = 30;
/** A thrown weapon's arc, as the core's NPC ranged uses it. */
const ARC = { start: 41, base: 46, perTile: 5, startHeight: 43, endHeight: 31 };
const REACH = 7;

const IMP = [
  { style: "MELEE", anim: 5285 },
  { style: "RANGED", anim: 2955, npcGfx: 493, projectile: 494 },
];
const GOBLIN = [{ style: "MAGIC", anim: 6134, npcGfx: 488, targetGfx: 489 }];
const SKELETON = [{ style: "RANGED", anim: 5512 }];
const HOBGOBLIN = [{ style: "RANGED", anim: 2959, npcGfx: 490, projectile: 491 }];
const GHOUL = [
  { style: "MELEE", anim: 2967 },
  { style: "RANGED", anim: 2968, npcGfx: 495, projectile: 496 },
];
const LESSER_DEMON = [
  { style: "MELEE", anim: 4680, maxHit: 15 },
  { style: "MAGIC", anim: 4630, maxHit: 14, npcGfx: 497, projectile: 498 },
];

/** Melee when the target is beside the NPC (either attack then), otherwise the distance one. */
function choose(attacks, npc, target) {
  const ranged = attacks.filter((attack) => attack.style !== "MELEE");
  const melee = attacks.filter((attack) => attack.style === "MELEE");
  if (!ranged.length) return melee[0];
  const { Projectile, Misc } = Common.core;
  const beside = melee.length && Projectile.centreOf(npc).getDistance(Projectile.centreOf(target)) <= npc.getSize();
  const options = beside ? attacks : ranged;
  return options[Misc.randomInclusive(0, options.length - 1)];
}

function createMethod(attacks) {
  const { CombatMethod, CombatType, CombatFactory, PendingHit, Animation, Graphic, Projectile } = Common.core;
  const distance = attacks.some((attack) => attack.style !== "MELEE") ? REACH : 1;
  return class ChampionCombatMethod extends CombatMethod {
    constructor() {
      super();
      this.attack = null;
      this.landing = 0;
    }

    type() {
      return CombatType[this.attack?.style ?? attacks[0].style];
    }

    attackDistance() {
      return distance;
    }

    start(npc, target) {
      const attack = choose(attacks, npc, target);
      this.attack = attack;
      npc.performAnimation(new Animation(attack.anim));
      if (attack.npcGfx) npc.performGraphic(new Graphic(attack.npcGfx));
      this.landing = 0;
      if (attack.projectile) {
        const tiles = Projectile.centreOf(npc).getDistance(Projectile.centreOf(target));
        this.landing = ARC.base + ARC.perTile * tiles;
        Projectile.createProjectile(npc, target, attack.projectile, ARC.start, this.landing, ARC.startHeight, ARC.endHeight).sendProjectile();
      }
      if (attack.targetGfx) target.performGraphic(new Graphic(attack.targetGfx));
    }

    hits(npc, target) {
      const attack = this.attack;
      if (!attack) return [];
      const delay = attack.style === "MELEE" ? 0 : Math.max(1, Math.floor(this.landing / CYCLES_PER_TICK) || 2);
      const hit = new PendingHit(npc, target, this, delay);
      CombatFactory.applyStyleDamage(hit, attack.maxHit ?? npc.getDefinition().getMaxHit());
      return [hit];
    }
  };
}

function attachCombat(api) {
  const npc = (key) => Common.byKey.get(key).npc;
  api.registerNpcCombatMethodProvider(npc("imp"), createMethod(IMP), { singleton: false });
  api.registerNpcCombatMethodProvider(npc("goblin"), createMethod(GOBLIN), { singleton: false });
  api.registerNpcCombatMethodProvider(npc("skeleton"), createMethod(SKELETON), { singleton: false });
  api.registerNpcCombatMethodProvider(npc("hobgoblin"), createMethod(HOBGOBLIN), { singleton: false });
  api.registerNpcCombatMethodProvider(npc("ghoul"), createMethod(GHOUL), { singleton: false });
  api.registerNpcCombatMethodProvider(npc("lesserdemon"), createMethod(LESSER_DEMON), { singleton: false });
}

module.exports = { attachCombat, choose };
