import fs = require("fs");
import path = require("path");

import { Sound } from "../Sound";
import type { ItemDefinition } from "./ItemDefinition";

/** A sound, or rules tried in order: the first whose name pattern matches (no pattern: any). */
type SoundRules = number | Array<{ name?: string; sound: number }>;

interface EquipmentSoundData {
    default: number;
    weaponTypes: Record<string, SoundRules>;
    slots: Record<string, SoundRules>;
}

const FILE = "data/definitions/equipment-sounds.json";

/** Equipment slots by the names equipment-sounds.json uses. */
const SLOT_NAMES: Record<number, string> = {
    0: "head", 1: "cape", 2: "neck", 3: "weapon", 4: "body", 5: "shield",
    7: "legs", 9: "hands", 10: "feet", 12: "ring", 13: "ammo",
};

/**
 * The sound for wearing or removing an item (live OSRS plays the same one both ways): the item's
 * own `equipSound` (item-gameplay.json, recorded from live OSRS), else the rules for its kind in
 * equipment-sounds.json: its weapon type's, else its slot's, else the default.
 */
export class EquipmentSounds {
    private static data: EquipmentSoundData | null = null;
    private static readonly patterns = new Map<string, RegExp>();

    public static soundFor(definition: ItemDefinition): Sound {
        return new Sound(EquipmentSounds.soundIdFor(definition), 1, 0, 0);
    }

    public static soundIdFor(definition: ItemDefinition): number {
        const own = definition.getEquipSound();
        if (own > 0) return own;
        const data = EquipmentSounds.load();
        const name = definition.getName() ?? "";
        const weaponType = definition.getWeaponInterface?.()?.getName?.();
        const slot = SLOT_NAMES[definition.getEquipmentType?.()?.getSlot?.() ?? -1];
        const weaponRules = slot === "weapon" && weaponType ? data.weaponTypes[weaponType] : undefined;
        return EquipmentSounds.apply(weaponRules, name)
            ?? EquipmentSounds.apply(slot ? data.slots[slot] : undefined, name)
            ?? data.default;
    }

    private static apply(rules: SoundRules | undefined, name: string): number | undefined {
        if (rules === undefined) return undefined;
        if (typeof rules === "number") return rules;
        return rules.find((rule) => !rule.name || EquipmentSounds.pattern(rule.name).test(name))?.sound;
    }

    private static pattern(source: string): RegExp {
        let pattern = EquipmentSounds.patterns.get(source);
        if (!pattern) {
            pattern = new RegExp(source, "i");
            EquipmentSounds.patterns.set(source, pattern);
        }
        return pattern;
    }

    private static load(): EquipmentSoundData {
        EquipmentSounds.data ??= JSON.parse(fs.readFileSync(path.resolve(FILE), "utf8")) as EquipmentSoundData;
        return EquipmentSounds.data;
    }
}
