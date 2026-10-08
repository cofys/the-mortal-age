import { Equipment } from "../../model/container/impl/Equipment";
import type { Player } from "../../entity/impl/player/Player";
import { FightType } from "./FightType";
import { CombatSpecial } from "./CombatSpecial";
import { Autocasting } from "./magic/Autocasting";
import { FightStyle } from "./FightStyle";
import { WeaponInterfaces } from "./WeaponInterfaces";

export class WeaponInterfaceManager {
    private static readonly WEAPON_CATEGORY_VARBIT = 357;

    /** The combat tab's four style buttons (593:6, 10, 14, 18), the styles' slots 0-3. */
    private static readonly STYLE_BUTTONS = [6, 10, 14, 18];

    /** A style button clicked on the combat tab (the click is the server's to answer, as live). */
    public static handleStyleButton(player: Player, groupId: number, childId: number): boolean {
        if (groupId !== 593) return false;
        const slot = WeaponInterfaceManager.STYLE_BUTTONS.indexOf(childId);
        return slot >= 0 && WeaponInterfaceManager.changeCombatStyle(player, slot);
    }

    public static changeCombatStyle(player: Player, slot: number): boolean {
        if (!Number.isInteger(slot) || slot < 0 || slot > 3) return false;
        const fightType = Object.values(player.getWeapon()?.getFightType?.() ?? {})
            .find((type): type is FightType => type instanceof FightType && type.getChildId() === slot);
        if (!fightType) return false;
        Autocasting.clearForStyle(player);
        player.setFightType(fightType);
        player.getPacketSender().sendConfig(fightType.getParentId(), fightType.getChildId());
        Autocasting.refreshIndicators(player);
        return true;
    }

    /**
     * Assigns an interface to the combat sidebar based on the argued weapon.
     *
     * @param player the player that the interface will be assigned for.
     */
    public static assign(player: Player) {
        let equippedWeapon = player.getEquipment().getItems()[Equipment.WEAPON_SLOT];
        let weapon = WeaponInterfaces.UNARMED;

        //Get the currently equipped weapon's interface
        if (equippedWeapon.getId() > 0) {
            const resolvedWeaponInterface = equippedWeapon.getDefinition().getWeaponInterface();
            if (resolvedWeaponInterface != null && typeof (resolvedWeaponInterface as any).getInterfaceId === "function") {
                weapon = resolvedWeaponInterface;
            }
        }

        player.setWeapon(weapon);
        player.getPacketSender().sendVarbit(WeaponInterfaceManager.WEAPON_CATEGORY_VARBIT, weapon.getCategory());

        if (weapon == WeaponInterfaces.CROSSBOW) {
            player.getPacketSender().sendString("Weapon: ", weapon.getNameLineId() - 1,);
        } else if (weapon == WeaponInterfaces.WHIP) {
            player.getPacketSender().sendString("Weapon: ", weapon.getNameLineId() - 1);
        }

        //player.getPacketSender().sendItemOnInterface(weapon.getInterfaceId() + 1, 200, item);
        //player.getPacketSender().sendItemOnInterface(weapon.getInterfaceId() + 1, item, 0, 1);

        player.getPacketSender().sendTabInterface(0,
            weapon.getInterfaceId());
        // %option_nodef (varp 172) is inverted: 0 enables auto-retaliate.
        // Re-send it whenever the combat interface is opened or replaced.
        player.getPacketSender().sendConfig(172, player.autoRetaliateReturn() ? 0 : 1);
        player.getPacketSender().sendString(
(weapon == WeaponInterfaces.UNARMED ? "Unarmed" : equippedWeapon.getDefinition().getName()), weapon.getNameLineId());
        CombatSpecial.assign(player);
        CombatSpecial.updateBar(player);

        const availableFightTypes = Object.values(weapon.getFightType()).filter(
            (type): type is FightType => type instanceof FightType
        );

        const currentFightType = FightType.resolve(player.getFightType());
        const fightType = availableFightTypes.find(type => type === currentFightType)
            ?? availableFightTypes.find(type => type.getStyle() === FightStyle.AGGRESSIVE)
            ?? availableFightTypes[0];
        player.setFightType(fightType);
        player.getPacketSender().sendConfig(fightType.getParentId(), fightType.getChildId());
        // Covers unequip, bank equipment deposits, login and depleted thrown weapons.
        Autocasting.refreshIndicators(player);
    }

}
