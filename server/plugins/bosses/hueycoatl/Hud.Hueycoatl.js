/**
 * The boss health bar through the shared BossHud plugin (boss-hud:* events). As captured
 * (varp hpbar_hud_npc, 1683): it shows whichever part the player last hit (a segment's 250,
 * the head's 2500, the tail's 300), the head's npc switches to huey_head_invulnerable (14011)
 * while shielded and back, and it clears 9 ticks after the kill.
 */
const Shared = require("./Shared.Hueycoatl");

const KILL_HIDE_TICKS = 9;
const MAXIMUM = Object.freeze({
  [Shared.NPC.HEAD]: Shared.HEAD_HITPOINTS,
  [Shared.NPC.HEAD_SHIELDED]: Shared.HEAD_HITPOINTS,
  [Shared.NPC.TAIL]: Shared.TAIL_HITPOINTS,
  [Shared.NPC.BODY]: Shared.BODY_HITPOINTS,
});

let api = null;
/** player -> { npc, npcId, current } on show. */
const bars = new WeakMap();

/** A hit on a part: show its bar, or move the bar to it, and bring everyone's up to date. */
function hitPart(session, player, npc) {
  const npcId = npc.getId();
  const maximum = MAXIMUM[npcId];
  if (!maximum) return;
  const current = Math.max(0, npc.getHitpoints());
  const bar = bars.get(player);
  if (!bar) {
    bars.set(player, { npc, npcId, current });
    api.emitCustomEvent("boss-hud:show", { player, npcId, current, maximum });
  } else if (bar.npc !== npc || bar.npcId !== npcId) {
    Object.assign(bar, { npc, npcId, current });
    api.emitCustomEvent("boss-hud:update", { player, npcId, current, maximum, force: true });
  }
  for (const member of session.members) {
    const shown = bars.get(member);
    if (!shown || shown.npc !== npc || shown.current === current) continue;
    shown.current = current;
    api.emitCustomEvent("boss-hud:update", { player: member, current });
  }
}

/** The head changed form (shield up or down): its bars follow. */
function retarget(session, head) {
  for (const member of session.members) {
    const bar = bars.get(member);
    if (!bar || bar.npc !== head) continue;
    bar.npcId = head.getId();
    api.emitCustomEvent("boss-hud:update", { player: member, npcId: bar.npcId, force: true });
  }
}

function killed(session) {
  for (const member of session.members) {
    if (!bars.has(member)) continue;
    bars.delete(member);
    Shared.later(KILL_HIDE_TICKS, () => member.isRegistered() && api.emitCustomEvent("boss-hud:hide", { player: member }));
  }
}

function dropFor(player) {
  if (!bars.has(player)) return;
  bars.delete(player);
  api.emitCustomEvent("boss-hud:hide", { player, fade: false, afterTicks: 0 });
}

function attach(pluginApi) {
  api = pluginApi;
}

module.exports = { attach, hitPart, retarget, killed, dropFor };
