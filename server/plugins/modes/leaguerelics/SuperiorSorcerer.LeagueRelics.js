/**
 * Superior Sorcerer (https://oldschool.runescape.wiki/w/Superior_Sorcerer), Trailblazer Reloaded's
 * tier 4 magic relic: magic weapons attack at speed 2, magic accuracy +175% and damage +20%, 90%
 * of runes (required, not spent) and powered-staff charges saved, in multicombat a landed spell also strikes up to five
 * surrounding targets for up to 25% of its damage, and binding spells always land unless the
 * target is immune or already bound. The arcane grimoire and rune pouch are granted on unlock
 * (data/league-relics.json).
 */
const Common = require("./Common.LeagueRelics");

let api;
let core;
let effect;
let bindSpells;

/** The splash hits this relic queued, so they never splash in turn. */
const splashHits = new WeakSet();

function active(player) {
  return Common.effectActive(player, effect);
}

function magicAccuracy(entity, roll) {
  return active(entity) ? roll * effect.accuracyMultiplier : roll;
}

function magicDamageBonus(entity, permille) {
  return active(entity) ? permille + effect.damageBonusPermille : permille;
}

function attackSpeed(event) {
  if (event.combatType === core.CombatType.MAGIC && active(event.attacker)) event.speed = effect.attackSpeed;
}

function saves() {
  return Math.random() < effect.saveChance;
}

/**
 * `magic:rune-saving`, asked once a cast when its runes are about to go (after the cast checked
 * the player has them, so the runes are still required, just not spent): the 90% roll.
 */
function runeSaving(request) {
  if (request.saved || !active(request.player)) return;
  if (saves()) request.saved = true;
}

/** `combat:consume-charge`: a powered staff's charge (every charge weapon asks; only a magic attack's counts here) has the same 90% roll. */
function consumeCharge(request) {
  if (request.skip || !active(request.player)) return;
  if (core.CombatFactory.getMethod(request.player).type() !== core.CombatType.MAGIC) return;
  if (saves()) request.skip = true;
}

function bindSpellSet() {
  if (!bindSpells) bindSpells = new Set(effect.bindSpells.map((name) => core.CombatSpells[name]).filter(Boolean));
  return bindSpells;
}

/** A binding spell lands unless the target is frozen or still immune from a previous freeze. */
function bindsLand(roll) {
  if (roll.combatType !== core.CombatType.MAGIC || !active(roll.attacker)) return;
  const spell = roll.attacker.getCombat().getSelectedSpell();
  if (!spell || !bindSpellSet().has(spell)) return;
  const timers = roll.target.getTimers();
  if (timers.has(core.TimerKey.FREEZE) || timers.has(core.TimerKey.FREEZE_IMMUNITY)) return;
  roll.forceAccurate = true;
}

/** In multicombat, a landed spell also hits up to five others around its target for up to a quarter of its damage. */
function splash({ attacker, target, hit }) {
  if (splashHits.has(hit) || hit.getCombatType() !== core.CombatType.MAGIC || !hit.isAccurate() || !active(attacker)) return;
  const damage = hit.getTotalDamage();
  if (damage <= 0) return;
  const areas = api.getAreaManager();
  if (!areas.inMulti(attacker) || !areas.inMulti(target)) return;
  const candidates = target.isNpc() ? attacker.getLocalNpcs() : attacker.getLocalPlayers();
  const method = core.CombatFactory.MAGIC_COMBAT;
  const most = Math.floor(damage * effect.splashFraction);
  let struck = 0;
  for (const candidate of candidates) {
    if (struck >= effect.splashTargets) break;
    if (!core.CombatFactory.canAttackSecondaryTarget(attacker, target, candidate, effect.splashRadius)) continue;
    // A derived hit: its damage is already a share of the primary's, so hit-scaling relics (Berserker) skip it.
    const extra = Common.derivedHit(() => new core.PendingHit(attacker, candidate, method, {
      delay: 0, rollAccuracy: false, experience: false, damage: core.Misc.randomInclusive(0, most),
    }));
    splashHits.add(extra);
    candidate.getCombat().getHitQueue().addPendingHit(extra, core.World.getProcessCycle());
    struck++;
  }
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  effect = Common.data.effects.superiorSorcerer;
  api.registerMagicAttackAccuracyModifier(magicAccuracy);
  api.registerMagicDamageBonusModifier(magicDamageBonus);
  api.onAttackSpeed(attackSpeed);
  api.onCustomEvent("magic:rune-saving", runeSaving);
  api.onCustomEvent("combat:consume-charge", consumeCharge);
  api.onCombatHitRoll(bindsLand);
  api.onCombatHitResolved(splash);
};
