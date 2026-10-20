/**
 * The boss health bar through the shared BossHud plugin (boss-hud:* events). As captured
 * (varp hpbar_hud_npc, 1683): it follows the player's engagement, switching between Eldric
 * (14147) and Branda (12596) as they change target, and clears on leaving (-1). Minions
 * and rows never show it.
 */
const Shared = require("./Shared.RoyalTitans");

/** The bar fades out this long after the kill. */
const KILL_HIDE_TICKS = 4;

let api = null;
/** player -> { titan, current } for each bar on show. */
const bars = new Map();
/** player -> the titan id the HUD was last opened on. The client's open script (2376 -> 2377)
 * remembers the npc it opened (varc 1259) and only rebuilds the bar (2246) for that one; for a
 * different one it just redraws, and after a kill's clear (2249 empties the container) that
 * leaves the text without the bar. Switching titans mid-fight (an update) doesn't move it. */
const lastShown = new Map();

/** The titan the player is fighting, else whichever one is still up. */
function engagedTitan(player, session) {
  const target = player.getCombat().getTarget();
  if (target?.isNpc()) {
    const npc = target.getAsNpc();
    if (Shared.isLiveTitan(npc.getId()) && (npc === session.branda || npc === session.eldric)) return npc;
  }
  return [session.branda, session.eldric].find((npc) =>
    npc && Shared.isLiveTitan(npc.getId()) && Shared.alive(npc)) ?? null;
}

function showFor(player, session) {
  const engaged = engagedTitan(player, session);
  if (!engaged) return;
  // Reopen on the titan last drawn so the bar is rebuilt; tickPlayer switches after.
  const titan = [session.branda, session.eldric].find((npc) =>
    npc?.getId() === lastShown.get(player) && Shared.fighting(npc)) ?? engaged;
  const current = Math.max(0, titan.getHitpoints());
  bars.set(player, { titan, current });
  lastShown.set(player, titan.getId());
  api.emitCustomEvent("boss-hud:show", { player, npcId: titan.getId(), current, maximum: Shared.MAX_HITPOINTS });
}

/** Follows engagement and hitpoints; sends only what changed. */
function tickPlayer(player, session) {
  const titan = engagedTitan(player, session);
  const bar = bars.get(player);
  if (!titan) {
    if (bar) {
      bars.delete(player);
      api.emitCustomEvent("boss-hud:hide", { player });
    }
    return;
  }
  if (!bar) {
    showFor(player, session);
    return;
  }
  const current = Math.max(0, titan.getHitpoints());
  if (bar.titan !== titan) {
    bar.titan = titan;
    bar.current = current;
    api.emitCustomEvent("boss-hud:update", { player, npcId: titan.getId(), current, maximum: Shared.MAX_HITPOINTS, force: true });
    return;
  }
  if (current === bar.current) return;
  bar.current = current;
  api.emitCustomEvent("boss-hud:update", { player, current });
}

function killed(session) {
  for (const player of session.players) {
    if (!bars.delete(player)) continue;
    Shared.later(KILL_HIDE_TICKS, () => api.emitCustomEvent("boss-hud:hide", { player }));
  }
}

function dropFor(player) {
  lastShown.delete(player);
  if (!bars.delete(player)) return;
  api.emitCustomEvent("boss-hud:hide", { player, fade: false, afterTicks: 0 });
}

function attach(pluginApi) {
  api = pluginApi;
}

module.exports = { attach, showFor, tickPlayer, killed, dropFor };
