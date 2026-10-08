import assert from "assert";
import { EquipmentSlot, withSeqHandItems } from "../rs/config/player/Equipment";
import { PlayerAppearance } from "../rs/config/player/PlayerAppearance";

const app = new PlayerAppearance(0, [0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6]);

// No held items: the same appearance, so its cache key and base model are reused.
assert.strictEqual(withSeqHandItems(app, { leftHandItem: -1, rightHandItem: -1 }), app);
assert.strictEqual(withSeqHandItems(app, undefined), app);

// Net fishing holds the small net (303) in the weapon hand; the cache stores ids offset by 512.
const netting = withSeqHandItems(app, { leftHandItem: -1, rightHandItem: 303 + 512 });
assert.strictEqual(netting.equip[EquipmentSlot.WEAPON], 303);
assert.strictEqual(netting.equip[EquipmentSlot.SHIELD], -1);
assert.notStrictEqual(netting.getCacheKey(), app.getCacheKey());
assert.strictEqual(app.equip[EquipmentSlot.WEAPON], -1, "the player's own appearance is untouched");

// Ids past 1024 (a dragon harpoon) only lose the one offset.
assert.strictEqual(withSeqHandItems(app, { leftHandItem: 21028 + 512, rightHandItem: -1 }).equip[EquipmentSlot.SHIELD], 21028);

// An NPC-transformed player draws the NPC, not held items.
const transformed = new PlayerAppearance(0, [0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6], undefined, undefined, 172);
assert.strictEqual(withSeqHandItems(transformed, { leftHandItem: -1, rightHandItem: 815 }), transformed);

console.log("seq-hand-items ok");
