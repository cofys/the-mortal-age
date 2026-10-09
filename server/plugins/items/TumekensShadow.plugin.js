"use strict";

/**
 * Tumeken's shadow (https://oldschool.runescape.wiki/w/Tumeken%27s_shadow).
 *
 * A powered staff with a built-in spell that can't cast others: max hit floor(Magic / 3) + 1,
 * an attack every 5 ticks from 8 tiles (10 on Longrange), one charge a cast. Its styles are the
 * powered staff's (cache weapon category 24). Its passive triples the magic attack and magic
 * damage bonuses of the worn gear (damage capped at 100%), quadruples them inside the Tombs of
 * Amascut, and it can't be used against other players. Casting gives the usual damage-based
 * Magic experience.
 *
 * Charged with two soul runes and five chaos runes a charge, up to 20,000; uncharging returns
 * every rune.
 *
 * The cast (rsprox captures): TOA_SOT_CAST_B (9493) with TUMEKENS_SHADOW_CASTING / _TRAVEL /
 * _IMPACT (2125-2127) and sound 6410.
 *
 * Whether the player is in the tombs is the raid's to answer: it emits
 * `toa:in-tombs` { player, inside: false } and the Tombs of Amascut plugin sets `inside`.
 */

const CHARGES_KEY = "tumekens-shadow-charges";
const MAX_CHARGES = 20000;
const SOULS_PER_CHARGE = 2;
const CHAOS_PER_CHARGE = 5;

const ANIMATION_CAST = 9493;
const GRAPHIC = { CASTING: 2125, TRAVEL: 2126, IMPACT: 2127 };
const ATTACK_SPEED = 5;
const ATTACK_RANGE = 8;
const LONGRANGE_EXTRA = 2;
const MAX_MAGIC_DAMAGE = 100;
const SOUND_CAST = 6410;
// The projectile (rsprox captures): it leaves after 56 client cycles and takes 16 more plus 10 a
// tile, with angle 32 and progress 40. Heights are sent times four (248 and 124; captured 250, 124).
const PROJECTILE = { DELAY: 56, LENGTH: 16, PER_TILE: 10, START_HEIGHT: 62, END_HEIGHT: 31, ANGLE: 32, PROGRESS: 40 };

const MAGIC_ATTACK = 3; // BonusManager.ATTACK_MAGIC
const MAGIC_DAMAGE = 12; // BonusManager.MAGIC_STRENGTH among the "other" bonuses

let api = null;
let ShadowCombatMethod = null;
/** Each caster's built-in spell: its max hit reads their Magic level. */
const spells = new WeakMap();

function core() {
  return api.core;
}

function ids() {
  return core().ItemIdentifiers;
}

function plural(amount, word) {
  return `${amount.toLocaleString()} ${word}${amount === 1 ? "" : "s"}`;
}

function weaponOf(player) {
  return player.getEquipment().getItems()[core().Equipment.WEAPON_SLOT] ?? null;
}

function wieldsShadow(player, chargedOnly = false) {
  const id = weaponOf(player)?.getId?.();
  const I = ids();
  return id === I.TUMEKENS_SHADOW || (!chargedOnly && id === I.TUMEKENS_SHADOW_UNCHARGED_);
}

function chargesOf(item) {
  return Math.max(0, Number(item?.getMetaValue?.(CHARGES_KEY)) || 0);
}

function inTombs(player) {
  const query = { player, inside: false };
  api.emitCustomEvent("toa:in-tombs", query);
  return query.inside === true;
}

// ------------------------------------------------------------------ combat

function travelCycles(from, to) {
  return PROJECTILE.DELAY + PROJECTILE.LENGTH + from.getLocation().getDistance(to.getLocation()) * PROJECTILE.PER_TILE;
}

function spellFor(player) {
  let spell = spells.get(player);
  if (spell) return spell;
  const { CombatNormalSpell, Animation, Graphic, GraphicHeight, Projectile, Skill } = core();
  spell = new CombatNormalSpell({
    spellId: () => ids().TUMEKENS_SHADOW,
    maximumHit: () => Math.floor(player.getSkillManager().getCurrentLevel(Skill.MAGIC) / 3) + 1,
    castAnimation: () => new Animation(ANIMATION_CAST),
    startGraphic: () => new Graphic(GRAPHIC.CASTING),
    castProjectile: (cast, castOn) => Projectile.createProjectile(cast, castOn, GRAPHIC.TRAVEL, PROJECTILE.DELAY,
      travelCycles(cast, castOn), PROJECTILE.START_HEIGHT, PROJECTILE.END_HEIGHT)
      .withAngle(PROJECTILE.ANGLE).withProgress(PROJECTILE.PROGRESS),
    castSound: () => SOUND_CAST,
    endGraphic: () => new Graphic(GRAPHIC.IMPACT, GraphicHeight.HIGH),
    baseExperience: () => 0,
    levelRequired: () => 1,
  });
  spells.set(player, spell);
  return spell;
}

/** Takes a charge; an emptied staff becomes the uncharged one. */
function useCharge(player) {
  const { Flag } = core();
  const staff = weaponOf(player);
  const left = chargesOf(staff) - 1;
  staff.setMetaValue(CHARGES_KEY, Math.max(0, left));
  if (left > 0) return;
  staff.setId(ids().TUMEKENS_SHADOW_UNCHARGED_);
  player.getEquipment().refreshItems();
  player.getUpdateFlag().flag(Flag.APPEARANCE);
  api.getBonusManager().update(player);
  player.sendMessage("Your Tumeken's shadow has run out of charges.");
}

function shadowMethod() {
  if (ShadowCombatMethod) return ShadowCombatMethod;
  const { MagicCombatMethod, PendingHit } = core();

  ShadowCombatMethod = new (class extends MagicCombatMethod {
    canAttack(character, target) {
      const player = character.getAsPlayer();
      if (target?.isPlayer?.()) {
        player.sendMessage("You can't use Tumeken's shadow against other players.");
        player.getCombat().reset();
        return false;
      }
      if (!wieldsShadow(player, true) || chargesOf(weaponOf(player)) <= 0) {
        player.sendMessage("Tumeken's shadow has no charges! You need to charge it with soul runes and chaos runes.");
        player.getCombat().reset();
        return false;
      }
      // Its built-in spell is the only one it casts, whatever is selected or autocast.
      player.getCombat().setCastSpell(spellFor(player));
      // The passive's multiplier depends on being in the tombs; refresh it for this cast.
      api.getBonusManager().update(player);
      useCharge(player);
      return true;
    }

    canPursue(character) {
      const player = character.getAsPlayer();
      return wieldsShadow(player, true) && chargesOf(weaponOf(player)) > 0;
    }

    hits(character, target) {
      const spell = spellFor(character.getAsPlayer());
      // The hit lands as the slow projectile arrives.
      const delay = Math.max(1, Math.floor(travelCycles(character, target) / 30));
      const hit = new PendingHit(character, target, this, delay);
      spell.onHitCalc(hit);
      return [hit];
    }

    attackSpeed() {
      return ATTACK_SPEED;
    }

    attackDistance(character) {
      const { FightStyle } = core();
      // Longrange is the powered staff's defensive style.
      return ATTACK_RANGE + (character.getFightType?.()?.getStyle?.() === FightStyle.DEFENSIVE ? LONGRANGE_EXTRA : 0);
    }

    /** Keeps attacking: the staff casts on its own, unlike a single manual cast. */
    finished(character) {
      const combat = character.getCombat();
      combat.setPreviousCast(spellFor(character.getAsPlayer()));
      combat.setCastSpell(null);
    }
  })();
  return ShadowCombatMethod;
}

function resolveShadow(attacker) {
  if (!attacker?.isPlayer?.()) return null;
  return wieldsShadow(attacker.getAsPlayer()) ? shadowMethod() : null;
}

/** The passive: worn magic attack and damage x3 (x4 in the tombs), damage capped at 100%. */
function shadowBonuses({ player, bonuses }) {
  if (!wieldsShadow(player, true)) return;
  const multiplier = inTombs(player) ? 4 : 3;
  bonuses[MAGIC_ATTACK] *= multiplier;
  bonuses[MAGIC_DAMAGE] = Math.min(MAX_MAGIC_DAMAGE, bonuses[MAGIC_DAMAGE] * multiplier);
}

// ------------------------------------------------------------------ charges

function setCharges(player, item, charges) {
  const I = ids();
  item.setMetaValue(CHARGES_KEY, charges);
  item.setId(charges > 0 ? I.TUMEKENS_SHADOW : I.TUMEKENS_SHADOW_UNCHARGED_);
  player.getInventory().refreshItems();
}

/** Two soul runes and five chaos runes a charge, as many as the inventory affords. */
function chargeShadow(event) {
  const { player } = event;
  const I = ids();
  const shadowIds = [I.TUMEKENS_SHADOW, I.TUMEKENS_SHADOW_UNCHARGED_];
  const staff = shadowIds.includes(event.usedItemId) ? event.usedItem : event.usedWithItem;
  if (!staff) return false;
  const inventory = player.getInventory();
  const current = chargesOf(staff);
  if (current >= MAX_CHARGES) {
    player.sendMessage("Your Tumeken's shadow is already fully charged.");
    return true;
  }
  const affordable = Math.min(
    Math.floor(inventory.getAmount(I.SOUL_RUNE) / SOULS_PER_CHARGE),
    Math.floor(inventory.getAmount(I.CHAOS_RUNE) / CHAOS_PER_CHARGE),
    MAX_CHARGES - current,
  );
  if (affordable < 1) {
    player.sendMessage("You need two soul runes and five chaos runes for each charge.");
    return true;
  }
  inventory.deleteNumber(I.SOUL_RUNE, affordable * SOULS_PER_CHARGE);
  inventory.deleteNumber(I.CHAOS_RUNE, affordable * CHAOS_PER_CHARGE);
  setCharges(player, staff, current + affordable);
  player.sendMessage(current === 0
    ? `You apply ${plural(affordable, "charge")} to your Tumeken's shadow.`
    : `You apply an additional ${plural(affordable, "charge")} to your Tumeken's shadow. It now has ${plural(current + affordable, "charge")} in total.`);
  return true;
}

function checkShadow({ player, item }) {
  player.sendMessage(`Your Tumeken's shadow has ${plural(chargesOf(item), "charge")} remaining.`);
  return true;
}

function unchargeShadow({ player, item }) {
  const { Item } = core();
  const I = ids();
  const charges = chargesOf(item);
  if (charges <= 0) {
    player.sendMessage("Your Tumeken's shadow has no charges to remove.");
    return true;
  }
  const inventory = player.getInventory();
  const needed = (inventory.contains(I.SOUL_RUNE) ? 0 : 1) + (inventory.contains(I.CHAOS_RUNE) ? 0 : 1);
  if (inventory.getFreeSlots() < needed) {
    player.sendMessage("Your inventory is too full to hold the runes.");
    return true;
  }
  api.sendMultiChatboxPrompt(player, "Uncharge all the charges from your staff?", "Yes.", () => {
    const left = chargesOf(item);
    if (left <= 0) return;
    inventory.addItem(new Item(I.SOUL_RUNE, left * SOULS_PER_CHARGE));
    inventory.addItem(new Item(I.CHAOS_RUNE, left * CHAOS_PER_CHARGE));
    setCharges(player, item, 0);
    player.sendMessage(`You uncharge your Tumeken's shadow, regaining ${plural(left * SOULS_PER_CHARGE, "soul rune")} and ${plural(left * CHAOS_PER_CHARGE, "chaos rune")} in the process.`);
  }, "No.", () => {});
  return true;
}

module.exports = {
  name: "TumekensShadow",
  members: true,
  register(pluginApi) {
    api = pluginApi;
    pluginApi.registerCombatMethodResolver({ resolve: resolveShadow });
    pluginApi.registerBonusProvider({ apply: shadowBonuses });
    for (const rune of ["Soul rune", "Chaos rune"]) {
      pluginApi.onItemOnItem(rune, "Tumeken's shadow", chargeShadow);
      pluginApi.onItemOnItem(rune, "Tumeken's shadow (uncharged)", chargeShadow);
    }
    pluginApi.onItemAction("Tumeken's shadow", { Check: checkShadow, Uncharge: unchargeShadow });
  },
  /** Where a staff keeps its charges (::maxgear fills it). */
  CHARGES_KEY,
};
