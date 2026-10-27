// Wiki: Rondache (The Fractured Archive). Passive: +2 flat armour and magic resistance. Its
// charges come from the damage it mitigates with either, are added on the tick damage is
// calculated, and stop at 20. Shield Slam spends them (specials/Rondache.SpecialAttack.js).
// The 2 is the Wiki's: the cache params of the item (1564, 2731, 2583) are not read by any
// client script that names flat armour, so nothing there gives it. Estimate: flat armour takes
// 2 off every landing hit (a hit of 1 goes to 0), and magic resistance is the same 2.
const CHARGES_ATTRIBUTE = "rondache:charges";
const CHARGES_VARBIT = 16438; // rondache_charges (gameval)
const MAX_CHARGES = 20;
const FLAT_ARMOUR = 2;
const SPECIAL_ID = "rondache";
let core = null;

const charges = (player) => Number(player.getAttribute(CHARGES_ATTRIBUTE)) || 0;

/** Sets the charges (0-20) and shows them in the combat tab's bar (varbit rondache_charges). */
function setCharges(player, count) {
  player.setAttribute(CHARGES_ATTRIBUTE, Math.max(0, Math.min(MAX_CHARGES, count)));
  player.getPacketSender().sendVarbit(CHARGES_VARBIT, charges(player));
}

function wearsRondache(player) {
  const { Equipment, ItemIdentifiers } = core;
  const id = player.getEquipment().getItems()[Equipment.SHIELD_SLOT]?.getId?.();
  return id === ItemIdentifiers.RONDACHE || id === ItemIdentifiers.RONDACHE_2 || id === ItemIdentifiers.RONDACHE_3;
}

function applyRondache(entity, hitDamage) {
  if (!entity?.isPlayer?.() || !(hitDamage?.getDamage?.() > 0)) return;
  const player = entity.getAsPlayer();
  if (!wearsRondache(player)) return;
  const damage = hitDamage.getDamage();
  const mitigated = Math.min(damage, FLAT_ARMOUR);
  hitDamage.setDamage(damage - mitigated);
  setCharges(player, charges(player) + mitigated);
}

/** The shield's special follows what is worn, whichever path changed it (equip, death, banking...). */
function refreshShieldSpecial({ player }) {
  const hasSpecial = player.getCombatSpecial?.()?.getId?.() === SPECIAL_ID;
  if (hasSpecial === wearsRondache(player)) return;
  core.CombatSpecial.assign(player);
  core.CombatSpecial.updateBar(player);
}

module.exports = function registerRondacheEffects(api) {
  core = api.core;
  api.onCustomEvent?.("equipment:changed", refreshShieldSpecial);
  api.persistAttribute?.(CHARGES_ATTRIBUTE, 0);
  api.registerIncomingDamageModifier(applyRondache);
  api.onPlayerLogin?.(({ player }) => setCharges(player, charges(player)));
};

module.exports.charges = charges;
module.exports.setCharges = setCharges;
module.exports._test = { applyRondache, CHARGES_ATTRIBUTE, MAX_CHARGES, bind: (value) => { core = value; } };
