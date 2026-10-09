import { CombatMethod } from "../CombatMethod";
import { Mobile } from "../../../../entity/impl/Mobile";
import { Sounds } from "../../../../Sounds";
import { CombatType } from "../../CombatType";
import { PendingHit } from "../../hit/PendingHit";
import { Animation } from "../../../../model/Animation";
import { WeaponProfiles } from "../../WeaponProfile";
export class MeleeCombatMethod extends CombatMethod {
    start(character: Mobile, target: Mobile) {
        const animation = character.getAttackAnim(target);
        if (animation !== -1) {
            character.performAnimation(new Animation(animation));
            Sounds.sendSound(character, character.getAttackSound());
        }
    }

    type(): CombatType {
        return CombatType.MELEE;
    }

    hits(character: Mobile, target: Mobile): PendingHit[] {
        return [new PendingHit(character, target, this)];
    }

    attackDistance(character: Mobile): number {
        return character.isPlayer() ? WeaponProfiles.attackDistance(character.getAsPlayer(), 1) : 1;
    }
}
