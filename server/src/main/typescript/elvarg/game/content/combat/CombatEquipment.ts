import type { Player } from "../../entity/impl/player/Player";
// Avoid importing Equipment to dodge bootstrap cycles; use slot ids directly.
const SHIELD_SLOT = 5;
// Wiki Dragonfire, Methods: every shield that protects like an anti-dragon shield, charged or not.
// Matched by cache name so every wearable variant counts.
const DRAGON_PROTECTION_SHIELDS = new Set([
    "Anti-dragon shield",
    "Anti-dragon shield (nz)",
    "Dragonfire shield",
    "Dragonfire ward",
    "Ancient wyvern shield",
]);
export class CombatEquipment {
    public static hasDragonProtectionGear(player: Player): boolean {
        const shield = player.getEquipment().get(SHIELD_SLOT);
        const definition = shield && shield.getId() > 0 ? shield.getDefinition() : null;
        return !!definition && !definition.isNoted() && DRAGON_PROTECTION_SHIELDS.has(definition.getName());
    }
}
