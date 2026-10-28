/**
 * Shattered Relics' fragment effects (data/league-shattered.json `fragmentEffects`): the combat
 * fragments and sets. Each works with the number its equipped level gives in the cache
 * (Fragments.equippedValue) or the tier of the set (Fragments.setTier). The skilling and misc
 * ones are follow-ups listed in docs/leagues.md.
 */
const Common = require("./Common.LeagueMode");
const Fragments = require("./Fragments.LeagueMode");
const { data, isShattered } = require("./Shattered.LeagueMode");

/** The extra attack rolls the sets queued, so they never roll again in turn. */
const extraHits = new WeakSet();
/** Per player: ticks since Divine Restoration last restored a point. */
const prayerTicks = new WeakMap();
/** The players whose per-tick effects are running (one task each, from login). */
const ticking = new WeakSet();
/** The per-tick task, defined once api.core.Task is reachable. */
let TickTask = null;
/** Per player: the world cycle it last took damage from an NPC or player (Saradominist Defence). */
const lastDamaged = new WeakMap();

function effects() {
  return data.fragmentEffects;
}

function core() {
  return Common.core;
}

function chance(percent) {
  return Math.random() * 100 < percent;
}

/** The value for a set's tier, or null below its first tier. */
function atTier(player, set, values) {
  const tier = Fragments.setTier(player, set);
  return tier > 0 ? values[Math.min(tier, values.length) - 1] : null;
}

// ---- Unholy Warrior / Ranger / Wizard: accuracy at 0 Prayer points ----

function accuracy(style) {
  const fragments = Object.entries(effects().accuracy).filter(([, each]) => each === style).map(([fragment]) => Number(fragment));
  return function unholyAccuracy(entity, roll) {
    if (!entity?.isPlayer?.()) return roll;
    if (entity.getSkillManager().getCurrentLevel(core().Skill.PRAYER) > 0) return roll;
    let multiplier = 1;
    for (const fragment of fragments) {
      const percent = Fragments.equippedValue(entity, fragment);
      if (percent !== null) multiplier += percent / 100;
    }
    return roll * multiplier;
  };
}

// ---- Bottomless Quiver, Arcane Conduit: ammunition, runes and charges saved ----

/** `combat:ammo-saving`: a shot's ammunition or bow charge saved (not chinchompas). */
function ammoSaving(request) {
  if (request.saved) return;
  const { fragment, excluded } = effects().ammoSaving;
  const save = Fragments.equippedValue(request.player, fragment);
  if (save === null) return;
  const weapon = core().ItemDefinition.forId(Number(request.weaponId))?.getName?.() ?? "";
  if (weapon.toLowerCase().includes(excluded)) return;
  if (chance(save)) request.saved = true;
}

/** `magic:rune-saving`: a cast's runes saved. */
function runeSaving(request) {
  if (request.saved) return;
  const save = Fragments.equippedValue(request.player, effects().runeSaving.fragment);
  if (save !== null && chance(save)) request.saved = true;
}

/** `combat:consume-charge` (powered staffs): the charge saved too. */
function chargeSaving(request) {
  if (request.skip) return;
  const save = Fragments.equippedValue(request.player, effects().runeSaving.fragment);
  if (save === null || core().CombatFactory.getMethod(request.player).type() !== core().CombatType.MAGIC) return;
  if (chance(save)) request.skip = true;
}

// ---- Larger Recharger: special energy back sooner ----

function specialRestore(entity, delayTicks) {
  if (!entity?.isPlayer?.()) return delayTicks;
  const ticks = Fragments.equippedValue(entity, effects().specialRestore.fragment);
  return ticks === null ? delayTicks : Math.min(delayTicks, ticks);
}

// ---- Every tick for a Shattered Relics character: Divine Restoration, Venomaster's immunity, `league:fragment-tick` ----

function perTick({ player }) {
  const restore = Fragments.equippedValue(player, effects().prayerRestore.fragment);
  if (restore !== null) {
    const ticks = (prayerTicks.get(player) ?? 0) + 1;
    prayerTicks.set(player, ticks >= restore ? 0 : ticks);
    if (ticks >= restore) {
      const skills = player.getSkillManager();
      const prayer = core().Skill.PRAYER;
      if (skills.getCurrentLevel(prayer) < skills.getMaxLevel(prayer)) skills.setCurrentLevel(prayer, skills.getCurrentLevel(prayer) + 1, true);
    }
  }
  const venom = effects().venom;
  const level = Fragments.equippedLevel(player, venom.fragment);
  if (level >= venom.poisonImmuneFrom) player.getCombat?.()?.getPoisonImmunityTimer?.()?.protectBriefly(2, level >= venom.venomImmuneFrom);
  // The other fragment units' per-tick effects (Unchained Talent) ride the same task.
  Common.api.emitCustomEvent("league:fragment-tick", { player });
}

function tickTask() {
  TickTask ??= class extends core().Task {
    constructor(player) {
      super(1);
      this.player = player;
    }

    execute() {
      if (this.player.isRegistered?.() === false || !isShattered(this.player)) {
        ticking.delete(this.player);
        this.stop();
        return;
      }
      perTick({ player: this.player });
    }
  };
  return TickTask;
}

/** `league:login`: a Shattered Relics character's per-tick effects run while it is online. */
function startTicking({ player }) {
  if (!isShattered(player) || ticking.has(player)) return;
  const manager = Common.api.getTaskManager?.();
  if (typeof manager?.submit !== "function") return;
  ticking.add(player);
  manager.submit(new (tickTask())(player));
}

// ---- Landed hits: Venomaster, Drakan's Touch, the extra rolls, Absolute Unit's reflection ----

/** Venomaster: its level's number is the poison's severity (15/25/35 hit for 3/5/7). */
function poisonOnHit(attacker, target, damage) {
  const venom = effects().venom;
  const severity = Fragments.equippedValue(attacker, venom.fragment);
  if (severity !== null && damage > 0 && chance(venom.chancePercent)) core().CombatFactory.poisonEntity(target, severity, 1);
}

function drakansTouch(attacker, damage) {
  const set = effects().sets.drakansTouch;
  const percent = atTier(attacker, set.set, set.healPercent);
  if (percent === null || damage <= 0 || !chance(set.chancePercent)) return;
  const heal = Math.floor(damage * percent / 100);
  if (heal > 0) attacker.heal(heal);
}

const STYLES = { melee: "MELEE", ranged: "RANGED", magic: "MAGIC" };

/**
 * Another roll of the hit it follows: with that hit's spell and cast (a manual cast is over by
 * now) and never a special attack's traits, both put back as they were once it is rolled. It can
 * take at most `hitpointsLeft`, which addPendingHit applies before paying its XP.
 */
function followUpHit(attacker, target, hit, hitpointsLeft) {
  const combat = attacker.getCombat();
  const castSpell = combat.getCastSpell();
  const special = attacker.isSpecialActivated();
  const spell = hit.getSpell?.() ?? null;
  if (spell) combat.setCastSpell(spell);
  attacker.setSpecialActivated(false);
  try {
    const extra = new (core().PendingHit)(attacker, target, hit.getCombatMethod(),
      { delay: 0, rollAccuracy: true, handleAfterHitEffects: false, damageBudget: { remaining: hitpointsLeft } },
      undefined, hit.getSpellContext?.() ?? null);
    return spell ? extra.setSpell(spell) : extra;
  } finally {
    combat.setCastSpell(castSpell);
    attacker.setSpecialActivated(special);
  }
}

/** The target's hitpoints once the damage already queued against it (the hit just resolved) lands. */
function hitpointsLeft(target) {
  const queued = Number(target.getCombat?.()?.getHitQueue?.()?.getQueuedDamage?.()) || 0;
  return Math.max(0, (Number(target.getHitpoints?.()) || 0) - queued);
}

/**
 * Twin Strikes / Double Tap / Chain Magic: after a landed hit of the set's style, a chance of
 * another roll, for no more than the hitpoints the target has left (none after a killing blow).
 */
function extraRoll(attacker, target, hit) {
  if (extraHits.has(hit) || !hit.isAccurate?.()) return;
  for (const [set, row] of Object.entries(effects().sets.extraRolls)) {
    if (hit.getCombatType?.() !== core().CombatType[STYLES[row.style]]) continue;
    const percent = atTier(attacker, Number(set), row.chancePercent);
    if (percent === null || !chance(percent)) continue;
    const left = hitpointsLeft(target);
    if (left <= 0) return;
    const extra = followUpHit(attacker, target, hit, left);
    extraHits.add(extra);
    core().CombatFactory.addPendingHit(extra);
  }
}

/** Absolute Unit: a share of what an NPC's hit still did is reflected back at it. */
function reflect(attacker, player, damage) {
  const set = effects().sets.absoluteUnit;
  const percent = atTier(player, set.set, set.reflectPercent);
  if (percent === null || damage <= 0 || !core().CombatFactory.canReceiveRecoil(attacker)) return;
  const reflected = Math.floor(damage * percent / 100);
  if (reflected <= 0) return;
  attacker.getCombat?.().getHitQueue().addPendingDamage([
    new (core().HitDamage)(reflected, core().HitMask.RED).markReflected().setSource(player),
  ]);
}

function hitResolved({ attacker, target, hit }) {
  const damage = Number(hit?.getTotalDamage?.() ?? 0);
  if (attacker?.isPlayer?.() && target) {
    poisonOnHit(attacker, target, damage);
    drakansTouch(attacker, damage);
    extraRoll(attacker, target, hit);
  }
  if (target?.isPlayer?.()) tookDamage(attacker, target.getAsPlayer?.() ?? target, damage);
  if (target?.isPlayer?.() && attacker?.isNpc?.()) reflect(attacker, target.getAsPlayer?.() ?? target, damage);
}

/** Absolute Unit: less damage from monsters. */
function incomingDamage(victim, hitDamage, context = {}) {
  if (!victim?.isPlayer?.() || !context.attacker?.isNpc?.()) return;
  const set = effects().sets.absoluteUnit;
  const percent = atTier(victim, set.set, set.reductionPercent);
  if (percent === null) return;
  hitDamage.setDamage(Math.floor(hitDamage.getDamage() * (100 - percent) / 100));
}

// ---- Slay All Day: healed by an on-task kill ----

function slayerKill({ player }) {
  const heal = Fragments.equippedValue(player, effects().slayerHeal.fragment);
  if (heal !== null) player.heal(heal);
}

// ---- Slay 'n' Pay, Superior Tracking: more Slayer points, likelier superiors ----

/** `slayer:task-reward`: a completed task's points raised by the fragment's percent (Slayer rounds down). */
function slayerPoints(reward) {
  const percent = Fragments.equippedValue(reward.player, effects().slayerPoints.fragment);
  if (percent !== null) reward.multiplier *= (100 + percent) / 100;
}

/** `slayer:superior-spawn`: 1 in the fragment's number, Bigger and Badder or not (its text names no unlock); the toggle-off still holds. */
function superiorChance(query) {
  const oneIn = Fragments.equippedValue(query.player, effects().superiorChance.fragment);
  if (oneIn === null || oneIn < 1) return;
  query.chance = Math.min(query.chance, oneIn);
  query.unlocked = true;
}

// ---- Tactical Duelist, Livin' On A Prayer, Special Discount, Thrall Damage ----

/** `combat:melee-charge`: a melee weapon's charge saved. */
function meleeChargeSaving(request) {
  if (request.skip) return;
  const save = Fragments.equippedValue(request.player, effects().meleeChargeSaving.fragment);
  if (save !== null && chance(save)) request.skip = true;
}

/** Active prayers drain the fragment's percent slower. */
function prayerDrainRate(entity, drainEffect) {
  if (!entity?.isPlayer?.()) return drainEffect;
  const percent = Fragments.equippedValue(entity, effects().prayerDrain.fragment);
  return percent === null ? drainEffect : drainEffect * (100 - percent) / 100;
}

/** A special costing more than the fragment's share of energy costs that share instead. */
function specialCost(entity, cost) {
  if (!entity?.isPlayer?.()) return cost;
  const { fragment, perPercent } = effects().specialCost;
  const cap = Fragments.equippedValue(entity, fragment);
  return cap === null ? cost : Math.min(cost, cap / perPercent);
}

/** `magic:thrall-max-hit`: the thrall's max hit raised by the fragment's percent, rounded up. */
function thrallMaxHit(request) {
  const percent = Fragments.equippedValue(request.player, effects().thrallMaxHit.fragment);
  if (percent !== null) request.maxHit = Math.ceil(request.maxHit * (100 + percent) / 100);
}

// ---- The god-armour four: their number while four of the god's items are worn ----

function godItems(player, god) {
  const query = { player, god, count: 0 };
  Common.api.emitCustomEvent("godwars:god-items", query);
  return Number(query.count) || 0;
}

/** The god's fragment's number, or null unless it is equipped and enough of the god's items are worn. */
function godValue(entity, god) {
  if (!entity?.isPlayer?.()) return null;
  const armour = effects().godArmour;
  const value = Fragments.equippedValue(entity, armour[god].fragment);
  return value !== null && godItems(entity, god) >= armour.items ? value : null;
}

/** Bandosian Might: the melee max hit, plus its number for each tick of the weapon's attack speed. */
function bandosianMight(entity, maxHit) {
  const perTick = godValue(entity, "bandos");
  return perTick === null ? maxHit : maxHit + perTick * entity.getBaseAttackSpeed();
}

/** Zamorakian Sight: magic accuracy raised by its percent. */
function zamorakianSight(entity, roll) {
  const percent = godValue(entity, "zamorak");
  return percent === null ? roll : roll * (100 + percent) / 100;
}

/** Armadylean Decree: `combat:bolt-effect-chance`, raised by its percent. */
function armadyleanDecree(request) {
  const percent = godValue(request.player, "armadyl");
  if (percent !== null) request.chance *= (100 + percent) / 100;
}

/** Saradominist Defence remembers when combat damage from an NPC or player landed (never poison, which isn't a hit). */
function tookDamage(attacker, target, damage) {
  if (attacker && damage > 0 && isShattered(target)) lastDamaged.set(target, core().World.getProcessCycle());
}

/** Saradominist Defence: every style's max hit, plus its number, within 6 ticks of taking damage. */
function saradoministDefence(entity, maxHit) {
  const bonus = godValue(entity, "saradomin");
  if (bonus === null) return maxHit;
  const last = lastDamaged.get(entity);
  const recent = last !== undefined && core().World.getProcessCycle() - last <= effects().godArmour.saradomin.withinTicks;
  return recent ? maxHit + bonus : maxHit;
}

// ---- Knife's Edge, Fast Metabolism ----

/** Knife's Edge: every style's max hit raised by 0.3% / 0.6% (in permille, so it stays exact) for each hitpoint missing. */
function knifesEdge(entity, maxHit) {
  if (!entity?.isPlayer?.()) return maxHit;
  const set = effects().sets.knifesEdge;
  const permille = atTier(entity, set.set, set.permillePerHitpoint);
  if (permille === null) return maxHit;
  const skills = entity.getSkillManager();
  const missing = Math.max(0, skills.getMaxLevel(core().Skill.HITPOINTS) - skills.getCurrentLevel(core().Skill.HITPOINTS));
  return maxHit * (1000 + permille * missing) / 1000;
}

/** Fast Metabolism: `stats:hitpoints-regen`, each regen heals four times as much. */
function hitpointsRegen(regen) {
  const set = effects().sets.fastMetabolism;
  const multiplier = atTier(regen.player, set.set, set.regenMultiplier);
  if (multiplier !== null) regen.amount *= multiplier;
}

function meleeMaxHit(entity, maxHit) {
  return knifesEdge(entity, saradoministDefence(entity, bandosianMight(entity, maxHit)));
}

function otherMaxHit(entity, maxHit) {
  return knifesEdge(entity, saradoministDefence(entity, maxHit));
}

module.exports = function attach(api) {
  api.registerMeleeAttackAccuracyModifier(accuracy("melee"));
  api.registerRangedAttackAccuracyModifier(accuracy("ranged"));
  api.registerMagicAttackAccuracyModifier(accuracy("magic"));
  api.onCustomEvent("combat:ammo-saving", ammoSaving);
  api.onCustomEvent("magic:rune-saving", runeSaving);
  api.onCustomEvent("combat:consume-charge", chargeSaving);
  api.registerSpecialEnergyRestoreModifier(specialRestore);
  api.onCustomEvent("league:login", startTicking);
  api.onCombatHitResolved(hitResolved);
  api.registerIncomingDamageModifier(incomingDamage);
  api.onCustomEvent("slayer:task-kill", slayerKill);
  api.onCustomEvent("slayer:task-reward", slayerPoints);
  api.onCustomEvent("slayer:superior-spawn", superiorChance);
  api.onCustomEvent("combat:melee-charge", meleeChargeSaving);
  api.registerPrayerDrainRateModifier(prayerDrainRate);
  api.registerSpecialEnergyCostModifier(specialCost);
  api.onCustomEvent("magic:thrall-max-hit", thrallMaxHit);
  api.registerMeleeHitModifier(meleeMaxHit);
  api.registerRangedHitModifier(otherMaxHit);
  api.registerMagicHitModifier(otherMaxHit);
  api.registerMagicAttackAccuracyModifier(zamorakianSight);
  api.onCustomEvent("combat:bolt-effect-chance", armadyleanDecree);
  api.onCustomEvent("stats:hitpoints-regen", hitpointsRegen);
};

module.exports._test = {
  accuracy, ammoSaving, runeSaving, chargeSaving, specialRestore, perTick, startTicking, hitResolved, incomingDamage, slayerKill, followUpHit, extraHits,
  slayerPoints, superiorChance, meleeChargeSaving, prayerDrainRate, specialCost, thrallMaxHit, bandosianMight, zamorakianSight, armadyleanDecree,
  saradoministDefence, knifesEdge, hitpointsRegen, lastDamaged,
};
