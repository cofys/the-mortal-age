/**
 * The power-ups of a Rumble dream (Wiki: Nightmare Zone, Power surge, Recurrent damage, Zapper,
 * Ultimate force; nightmare-zone.json `powerUps`):
 * - one at a time appears somewhere in the arena and goes after a minute if left; Activate:
 * - Power surge (45 s): the special attack bar full, and kept full (20% a tick);
 * - Recurrent damage (45 s): every hit the player lands brings another of 3/4 of it, with no
 *   experience;
 * - Zapper (60 s): every 2 ticks, up to 8 damage to the monsters near the player (not the
 *   Dagannoth mother, Tanglefoot or the Everlasting);
 * - Ultimate force: every monster in the arena dies at once, for no points.
 * Not recorded: how often they appear (my guess: 50-100 ticks after the last one went) and where.
 */
const Common = require("./Common.NightmareZone");

const ZAPPER_IMMUNE = ["horror_dagganoth", "fairy_tanglefoot", "dream_everlasting"];

const sender = (player) => player.getPacketSender();
const powerUps = () => Common.data.powerUps;

/** The dream's floor: { object, kind, until } or null; and its timers. */
function powerState(state) {
  state.power ??= { floor: null, next: Common.randomInt(...powerUps().spawnEvery), active: {} };
  return state.power;
}

function active(state, kind) {
  return (powerState(state).active[kind] ?? 0) > state.tick;
}

/** Each tick of a Rumble: a power-up appears or goes, and the active ones work. */
function tick(player, state, spawnTile) {
  if (state.dream.mode !== "rumble") return;
  const power = powerState(state);
  if (power.floor && power.floor.until <= state.tick) remove(power);
  if (!power.floor && state.tick >= power.next) place(state, power, spawnTile());
  if (active(state, "surge")) player.setSpecialPercentage?.(Math.min(100, (player.getSpecialPercentage?.() ?? 0) + powerUps().surge.perTick));
  if (active(state, "zapper") && state.tick % powerUps().zapper.every === 0) zap(player, state);
}

function place(state, power, tile) {
  const kinds = Object.keys(powerUps().kinds);
  const kind = kinds[Common.randomInt(0, kinds.length - 1)];
  const id = Common.core.CacheDefinitions.getLocId(powerUps().kinds[kind]);
  const object = new Common.core.GameObject(id, tile, 10, 0, state.area);
  Common.core.ObjectManager.register(object, true);
  power.floor = { object, kind, until: state.tick + powerUps().lastsTicks };
}

function remove(power) {
  if (!power.floor) return;
  Common.core.ObjectManager.deregister(power.floor.object, true);
  power.floor = null;
}

/** Activate: the power-up on the floor, if it is this one. */
function activate({ player, object }) {
  const state = Common.dreamOf(player);
  const power = state ? powerState(state) : null;
  const floor = power?.floor;
  if (!floor || !object || object.getId?.() !== floor.object.getId() || !object.getLocation?.()?.equals?.(floor.object.getLocation())) return false;
  remove(power);
  power.next = state.tick + Common.randomInt(...powerUps().spawnEvery);
  if (floor.kind === "nuke") nuke(state);
  else power.active[floor.kind] = state.tick + powerUps()[floor.kind].ticks;
  if (floor.kind === "surge") player.setSpecialPercentage?.(100);
  return true;
}

/** Ultimate force: everything in the arena dies, and gives no points (Wiki). */
function nuke(state) {
  for (const npc of [...state.npcs]) {
    npc.__noPoints = true;
    npc.getCombat?.().getHitQueue?.().addPendingDamage([new Common.core.HitDamage(npc.getHitpoints(), Common.core.HitMask.RED)]);
  }
}

function zap(player, state) {
  const here = player.getLocation();
  for (const npc of state.npcs) {
    const name = Common.core.CacheDefinitions.getNpcNames().get(npc.getId()) ?? "";
    if (ZAPPER_IMMUNE.some((part) => name.includes(part))) continue;
    if (npc.getLocation().getDistance?.(here) > powerUps().zapper.range) continue;
    const damage = Common.randomInt(1, powerUps().zapper.maxHit);
    npc.getCombat?.().getHitQueue?.().addPendingDamage([new Common.core.HitDamage(damage, Common.core.HitMask.RED)]);
  }
}

/** Recurrent damage: a hit the player lands brings another of 3/4 of it a tick later. */
function recurrent({ npc, hit }) {
  const owner = npc?.__nightmareZone;
  const attacker = hit?.getAttacker?.();
  if (!owner || !attacker?.isPlayer?.() || attacker !== owner.player) return;
  const state = Common.dreamOf(owner.player);
  if (!state || !active(state, "recurrent")) return;
  const extra = Math.floor((hit.getTotalDamage() * 3) / 4);
  if (extra <= 0) return;
  Common.later(1, () => {
    if (state.npcs.has(npc) && npc.getHitpoints() > 0) npc.getCombat?.().getHitQueue?.().addPendingDamage([new Common.core.HitDamage(extra, Common.core.HitMask.RED)]);
  });
}

function dreamEnded(state) {
  if (state.power) remove(state.power);
}

function attachPowerUps(api) {
  for (const name of powerUps().names) api.onObjectInteraction(name, { Activate: activate });
  api.onNpcHitModify(recurrent);
}

module.exports = { attachPowerUps, tick, activate, nuke, zap, recurrent, dreamEnded, powerState, active };
