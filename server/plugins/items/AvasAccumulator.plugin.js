/**
 * Ava's attractor (10498) and Ava's accumulator (10499) recover a share of the
 * ammunition a player fires before it hits the floor: 60% and 72% respectively.
 * Core breaks 20% of every shot and drops the rest where the target stood.
 * A worn Ranging cape (or max cape) recovers as an accumulator, or 80% once Vorkath's head has
 * upgraded it (the Skillcapes plugin's "skillcape:ammo-recovery").
 * OSRS Wiki: Ava's device, Ranging cape.
 */

let Equipment;
let ItemIdentifiers;
let pluginApi;

function recoveryFor(player) {
  const capeId = player?.getEquipment?.()?.get?.(Equipment.CAPE_SLOT)?.getId?.() ?? -1;
  if (capeId === ItemIdentifiers.AVAS_ATTRACTOR) return 60;
  if (capeId === ItemIdentifiers.AVAS_ACCUMULATOR) return 72;
  const cape = { player, recovery: null };
  pluginApi?.emitCustomEvent("skillcape:ammo-recovery", cape);
  return cape.recovery;
}

module.exports = {
  name: "AvasAccumulator",
  register(api) {
    pluginApi = api;
    Equipment = api.core.Equipment;
    ItemIdentifiers = api.core.ItemIdentifiers;
    api.registerRangedAmmoRecovery({ recovery: recoveryFor });
  },
};
