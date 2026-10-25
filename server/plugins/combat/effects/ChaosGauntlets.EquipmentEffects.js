let core;

// Wiki: chaos gauntlets increase the maximum hit of bolt spells by 3.
const BOLT_SPELL_NAMES = ["WIND_BOLT", "WATER_BOLT", "EARTH_BOLT", "FIRE_BOLT"];
const BONUS_MAX_HIT = 3;

function applyChaosGauntlets(request) {
    if (!request.attacker?.isPlayer?.()) return;
    const player = request.attacker.getAsPlayer();
    if (player.getEquipment().get(core.Equipment.HANDS_SLOT)?.getId?.() !== core.ItemIdentifiers.CHAOS_GAUNTLETS) {
        return;
    }
    if (BOLT_SPELL_NAMES.some(name => core.CombatSpells[name].spellId() === request.spell?.spellId?.())) {
        request.maxHit += BONUS_MAX_HIT;
    }
}

module.exports = function registerChaosGauntletsEffects(api) {
    core = api.core;
    api.onCustomEvent("combat:magic-base-max-hit", applyChaosGauntlets);
};
