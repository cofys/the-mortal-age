/**
 * The boss health bar in the Wilderness boss lairs, through the shared BossHud plugin
 * (boss-hud:* events). As captured: everyone in a lair sees its boss's bar from the tick after
 * they arrive, whether they fight or not; it follows the boss's hitpoints (and its form, for
 * Vet'ion and Calvar'ion); eight ticks after the dead boss is gone the values clear, and the
 * next boss shows the bar again as it spawns. Leaving the lair drops it at once.
 */

/** Captured: the bar clears eight ticks after the dead boss is removed. */
const CLEAR_AFTER_GONE_TICKS = 8;

let api = null;
let core = null;
/** player -> { npcId, current, maximum, goneAt } for each bar on show. */
const bars = new Map();

function bossIn(area, lair) {
  return area.getNpcs().find((npc) => npc.isRegistered() && lair.bossIds.includes(npc.getId())) ?? null;
}

function formOf(npc) {
  const transformed = npc.getNpcTransformationId();
  return transformed !== -1 ? transformed : npc.getId();
}

/** Per tick, for each player in a lair: show, follow or clear the boss's bar. */
function process(player, lair, area) {
  const boss = bossIn(area, lair);
  const bar = bars.get(player);
  const now = core.World.getProcessCycle();
  if (!boss) {
    if (!bar) return;
    bar.goneAt ??= now;
    if (now - bar.goneAt < CLEAR_AFTER_GONE_TICKS) return;
    bars.delete(player);
    api.emitCustomEvent("boss-hud:hide", { player, fade: false, afterTicks: 0 });
    return;
  }
  const npcId = formOf(boss);
  const current = Math.max(0, boss.getHitpoints());
  const maximum = boss.getMaxHitpoints();
  if (!bar || bar.goneAt != null) {
    bars.set(player, { npcId, current, maximum, goneAt: null });
    api.emitCustomEvent("boss-hud:show", { player, npcId, current, maximum });
    return;
  }
  if (bar.npcId === npcId && bar.current === current && bar.maximum === maximum) return;
  Object.assign(bar, { npcId, current, maximum });
  api.emitCustomEvent("boss-hud:update", { player, npcId, current, maximum });
}

function entered(player) {
  bars.delete(player);
}

function left(player) {
  if (!bars.delete(player)) return;
  api.emitCustomEvent("boss-hud:hide", { player, fade: false, afterTicks: 0 });
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
}

module.exports = { attach, process, entered, left, bossIn, bars, _test: { formOf } };
