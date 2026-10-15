/** Quest Helper palace positions, with the cache's playable NPC variants. */
const PREPARATION_VELIAF_PARENT = 15871;
const PREPARATION_VANESCULA_PARENT = 15906;
module.exports = function registerPalace({ api, stage, preparationAttribute, processHall }) {
  const { Area, Boundary, NpcIdentifiers: N } = api.core;
  const residents = new WeakMap();
  const preparationTalkers = new WeakMap();
  let palaceArea;
  function addNpcToArea(npc) {
    if (npc && palaceArea && !palaceArea.hasMember(npc)) palaceArea.enter(npc);
  }
  function removeNpcFromArea(npc) {
    if (npc && palaceArea?.hasMember(npc)) palaceArea.leave(npc, false);
    api.removeNpc(npc);
  }
  function cleanup(player) {
    for (const npc of residents.get(player) ?? []) removeNpcFromArea(npc);
    residents.delete(player);
    for (const npc of preparationTalkers.get(player) ?? []) removeNpcFromArea(npc);
    preparationTalkers.delete(player);
  }
  function sync(player) {
    if (stage(player) !== 60) { cleanup(player); return; }
    let cast = residents.get(player);
    if (!cast) {
      cast = [];
      residents.set(player, cast);
    }
    for (const [id, x, y] of [[N.SAFALAAN_HALLOW_14, 3157, 7841], [N.EFARITAY_HALLOW, 3157, 7839],
      [N.IVAN_STROM_13, 3175, 7834], [N.SUGADINTI_VITUR, 3168, 7828]]) {
      if (cast.some(npc => npc.getId?.() === id && !npc.isDestroyed?.())) continue;
      const npc = api.spawnNpc({ id, x, y, z: 1, wanderRadius: 0, owner: player, ownerOnly: true });
      if (npc) { npc.setScriptedMovement(true); npc.getMovementQueue().setBlockMovement(true); addNpcToArea(npc); cast.push(npc); }
    }
    const fed = player.getAttribute(preparationAttribute)?.stewFed;
    const safalaan = cast.find(npc => npc.getId?.() === N.SAFALAAN_HALLOW_14 && !npc.isDestroyed?.());
    safalaan?.setNpcTransformationId(fed ? N.SAFALAAN_HALLOW_12 : N.SAFALAAN_HALLOW_14);

    // RSProx 4288 records the required downstairs conversation pair on the z0
    // floor after the player has made both hallowed weapons. These are cache
    // parents whose IDs are not named in NpcIdentifiers in this cache export.
    const prep = player.getAttribute(preparationAttribute) ?? {};
    if (prep.flail && prep.stakes) {
      let talkers = preparationTalkers.get(player);
      if (!talkers) { talkers = []; preparationTalkers.set(player, talkers); }
      for (const [id, x, y] of [[PREPARATION_VELIAF_PARENT, 3168, 7842], [PREPARATION_VANESCULA_PARENT, 3168, 7844]]) {
        if (talkers.some(npc => npc.getId?.() === id && !npc.isDestroyed?.())) continue;
        const npc = api.spawnNpc({ id, x, y, z: 0, wanderRadius: 0, owner: player, ownerOnly: true });
        if (npc) { npc.setScriptedMovement(true); npc.getMovementQueue().setBlockMovement(true); addNpcToArea(npc); talkers.push(npc); }
      }
    } else {
      for (const npc of preparationTalkers.get(player) ?? []) removeNpcFromArea(npc);
      preparationTalkers.delete(player);
    }
  }
  class PalaceArea extends Area {
    constructor() { super([new Boundary(3154, 3183, 7823, 7861, 0), new Boundary(3154, 3183, 7823, 7861, 1)]); }
    process(member) {
      if (!member.isPlayer?.()) return;
      const player = member.getAsPlayer();
      sync(player);
      if (player.getLocation?.().getZ?.() === 1) processHall?.({ player });
    }
    postLeave(member) { if (member.isPlayer?.()) cleanup(member.getAsPlayer()); }
  }
  palaceArea = new PalaceArea();
  api.registerArea(palaceArea);
  return { sync, cleanup, residents, preparationTalkers };
};
