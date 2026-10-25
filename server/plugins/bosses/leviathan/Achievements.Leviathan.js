const Common = require('./Common.Leviathan');
const active = new WeakMap();
// Cache identifiers, including poisoned variants. This is ammunition provenance,
// not the ammo slot: blowpipes and thrown weapons resolve ammunition themselves.
const MITHRIL = ['MITHRIL_ARROW', 'MITHRIL_BOLTS', 'MITHRIL_DART', 'MITHRIL_KNIFE', 'MITHRIL_JAVELIN', 'MITHRIL_THROWNAXE',
  'SEEKING_MITHRIL_ARROW', 'EMERALD_BOLTS', 'EMERALD_BOLTS_E_',
  ...['ARROW', 'BOLTS', 'DART', 'KNIFE', 'JAVELIN'].flatMap(kind =>
    ['P_', 'P_PLUS_', 'P_PLUS_PLUS_'].map(poison => `MITHRIL_${kind}_${poison}`))];
const WOODEN_BLOWPIPES = ['ROSEWOOD', 'IRONWOOD', 'CAMPHOR'].flatMap(wood => [`${wood}_BLOWPIPE`, `${wood}_BLOWPIPE_2`]);
function begin(fight) {
  fight.unconventional = { eligible: !fight.awakened && fight.player.getHitpoints() <= 25, fired: false };
  fight.onSlayerTask = false;
  active.set(fight.player, fight);
}
function observe(fight) {
  if (fight.awakened || fight.onSlayerTask) return;
  const request = { player: fight.player, npc: fight.boss, onTask: false };
  Common.api.emitCustomEvent('slayer:on-task', request);
  if (request.onTask) fight.onSlayerTask = true;
}
function end(fight) { if (active.get(fight.player) === fight) active.delete(fight.player); }
function health({ player, skill, current }) {
  const fight = active.get(player);
  if (fight?.alive() && skill === Common.core.Skill.HITPOINTS && current > 25) fight.unconventional.eligible = false;
}
function launched({ player, target, hit }) {
  const fight = active.get(player);
  if (!fight?.alive() || target !== fight.boss || !fight.unconventional.eligible) return;
  const combat = player.getCombat();
  if (hit.getCombatType() === Common.core.CombatType.MAGIC &&
      Common.shadowSpell(combat.getCastSpell() ?? combat.getSelectedSpell())) return;
  const identifiers = Common.core.ItemIdentifiers;
  const weapon = player.getEquipment().getWeapon()?.getId();
  const ammunition = combat.getAmmunition()?.getItemId();
  if (hit.getCombatType() !== Common.core.CombatType.RANGED ||
      !MITHRIL.some(name => Number.isInteger(identifiers[name]) && identifiers[name] === ammunition) ||
      WOODEN_BLOWPIPES.some(name => identifiers[name] === weapon)) {
    fight.unconventional.eligible = false;
    return;
  }
  fight.unconventional.fired = true;
}
function attach(api) {
  api.onPlayerDealtDamage(launched);
  api.onCustomEvent('skills:current-level-changed', health);
}
module.exports = { begin, observe, end, attach };
