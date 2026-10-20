"use strict";

/**
 * Tentacle/boss respawn cycle (see ../Kraken.plugin.js for behaviour and sources).
 *
 * Wiki-mirroring shared-fight rules (estimates where the Wiki is silent):
 * - A tentacle killed while the Kraken is up stays dead: no mid-fight trickle respawn.
 * - Killing the Kraken kills its remaining tentacles with it (they drop nothing — they
 *   have no drop table), then boss + tentacles respawn together as whirlpools once the
 *   boss's own respawn timer elapses.
 * - A tentacle killed while the Kraken is down respawns normally as its whirlpool.
 * Deaths respawn as whirlpools because the engine clears the transformation first.
 *
 * State is keyed by private area (open world included): each area runs its own pending
 * flag and dead list, so a future instanced fight cannot mix with the public one. A
 * server restart clears the memory, and the engine re-spawns every whirlpool from
 * npc-spawns.json at boot, so nothing can strand whirlpools missing.
 */

const Shared = require("./Shared.Kraken");

/** Areas with a joint respawn scheduled: their deaths join it instead of respawning. */
const simultaneousPending = new Set();
/** Area -> whirlpools to respawn together: [{ id, at }]. */
const deadByArea = new Map();

function later(ticks, action) {
  const { Task, TaskManager } = Shared.core();
  TaskManager.submit(
    new (class extends Task {
      constructor() {
        super(Math.max(1, ticks), null, false);
      }
      execute() {
        this.stop();
        action();
      }
    })(),
  );
}

function areaOf(npc) {
  return npc?.getPrivateArea?.() ?? null;
}

function deadList(area) {
  let list = deadByArea.get(area);
  if (!list) {
    list = [];
    deadByArea.set(area, list);
  }
  return list;
}

function livingIn(area, npcId) {
  let World = null;
  try {
    World = Shared.core().World;
  } catch {
    return [];
  }
  const found = [];
  for (const other of World?.getNpcs?.() ?? []) {
    if (!other?.isNpc?.()) continue;
    if (other.getId?.() !== npcId) continue;
    if (!Shared.alive(other)) continue;
    if (other.getPrivateArea?.() !== area) continue;
    found.push(other);
  }
  return found;
}

/** Whether the Kraken is currently up in `area`. */
function bossUp(area) {
  return livingIn(area, Shared.ids().BOSS).length > 0;
}

function tentacleDied({ npc }) {
  if (!npc || npc.getId?.() !== Shared.ids().TENTACLE) return;
  const area = areaOf(npc);
  if (simultaneousPending.has(area) || bossUp(area)) {
    // Mid-fight (or fight cleanup): stay dead, come back with the rest after the fight.
    npc.__skipDefaultRespawn = true;
    deadList(area).push({ id: Shared.ids().TENTACLE_WHIRLPOOL, at: npc.getSpawnPosition() });
    return;
  }
  // Boss is down: a normal respawn as the whirlpool.
  npc.__skipDefaultRespawn = false;
}

function respawnAll(area) {
  const { NPC, World } = Shared.core();
  for (const { id, at } of (deadByArea.get(area) ?? []).splice(0)) {
    try {
      World.getAddNPCQueue().push(NPC.create(id, at));
    } catch {
      // One failed spawn must not block the rest.
    }
  }
  deadByArea.delete(area);
  simultaneousPending.delete(area);
}

function bossDied({ npc }) {
  if (!npc || npc.getId?.() !== Shared.ids().BOSS) return;
  const area = areaOf(npc);
  simultaneousPending.add(area);
  npc.__skipDefaultRespawn = true;
  deadList(area).push({ id: Shared.ids().BOSS_WHIRLPOOL, at: npc.getSpawnPosition() });
  // The remaining tentacles die with the Kraken; their deaths join the same respawn.
  for (const tentacle of livingIn(area, Shared.ids().TENTACLE)) {
    try {
      tentacle.setHitpoints(0);
    } catch {
      // Already dying; its death event still joins the respawn.
    }
  }
  const delay = npc.getDefinition?.()?.getRespawn?.() ?? 25;
  later(delay, () => respawnAll(area));
}

function attach(api) {
  api.onNpcDeath(tentacleDied);
  api.onNpcDeath(bossDied);
}

module.exports = { attach, tentacleDied, bossDied, bossUp, respawnAll };
