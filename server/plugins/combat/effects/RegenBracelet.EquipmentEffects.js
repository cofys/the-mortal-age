const { wearing } = require("./GearChecks.EquipmentEffects");

let core;

// Wiki: a worn regen bracelet doubles natural Hitpoints regeneration, and stacks with Rapid Heal
// or a Hitpoints cape (2 Hitpoints every 30 seconds).
const REGEN_BRACELET_NAMES = new Set(["regen bracelet"]);
const REGEN_AMOUNT_MULTIPLIER = 2;

function applyRegenBracelet(regen) {
    if (wearing(regen.player, core.Equipment.HANDS_SLOT, REGEN_BRACELET_NAMES)) {
        regen.amount *= REGEN_AMOUNT_MULTIPLIER;
    }
}

module.exports = function registerRegenBraceletEffects(api) {
    core = api.core;
    api.onCustomEvent("stats:hitpoints-regen", applyRegenBracelet);
};

module.exports._test = { applyRegenBracelet };
