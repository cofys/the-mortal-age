"use strict";

/**
 * The tormented demon kill count and Combat Achievements (Wiki: Tormented Demon, Combat
 * Achievements):
 * - varp wgs_tormented_demon_killcount (4240) counts the player's kills (captured: one more each
 *   kill), saved and sent at login;
 * - "Through Fire and Flames": a kill while its shield is down;
 * - "Two Times the Torment" / "Three Times the Thrashing": two kills within 2 seconds, three
 *   within 3;
 * - "Rapid Reload": hits on three different demons within 3 seconds with a crossbow or ballista.
 * "Unending Torment" (one kill) is a plain kill count, which Combat Achievements counts itself.
 */

const Shared = require("./Shared.TormentedDemons");
const { heavyRanged } = require("./Shield.TormentedDemons");

const KILLS_ATTRIBUTE = "tormented-demons:kills";
const KILL_COUNT_VARP = 4240;
const SHIELD_DOWN_TASK = "Through Fire and Flames";
/** [task, kills, within ticks]: 2 seconds is 3 ticks, 3 seconds 5. */
const MULTI_KILL_TASKS = Object.freeze([["Two Times the Torment", 2, 3], ["Three Times the Thrashing", 3, 5]]);
const RAPID_RELOAD_TASK = "Rapid Reload";
const RAPID_RELOAD = Object.freeze({ demons: 3, ticks: 5 });

/** player -> ticks of their recent kills. */
const recentKills = new WeakMap();
/** player -> [{ tick, npc }] of recent crossbow/ballista hits on demons. */
const recentHits = new WeakMap();

function complete(player, task) {
  Shared.api().emitCustomEvent("combat-achievements:complete", { player, task });
}

function kills(player) {
  return Number(player.getAttribute(KILLS_ATTRIBUTE)) || 0;
}

function sendKillCount({ player }) {
  player.getPacketSender().sendConfig(KILL_COUNT_VARP, kills(player));
}

function killed({ player, shieldDown }) {
  player.setAttribute(KILLS_ATTRIBUTE, kills(player) + 1);
  sendKillCount({ player });
  if (shieldDown) complete(player, SHIELD_DOWN_TASK);
  const now = Shared.tick();
  const longest = Math.max(...MULTI_KILL_TASKS.map(([, , ticks]) => ticks));
  const ticks = (recentKills.get(player) ?? []).filter((tick) => now - tick <= longest);
  ticks.push(now);
  recentKills.set(player, ticks);
  for (const [task, count, within] of MULTI_KILL_TASKS) {
    if (ticks.filter((tick) => now - tick <= within).length >= count) complete(player, task);
  }
}

function hitLanded({ attacker, target, hit }) {
  if (!attacker?.isPlayer?.() || !Shared.isDemon(target) || !hit?.isAccurate?.()) return;
  const player = attacker.getAsPlayer();
  if (hit.getCombatType() !== Shared.core().CombatType.RANGED || !heavyRanged(player)) return;
  const now = Shared.tick();
  const hits = (recentHits.get(player) ?? []).filter((entry) => now - entry.tick <= RAPID_RELOAD.ticks);
  hits.push({ tick: now, npc: target });
  recentHits.set(player, hits);
  if (new Set(hits.map((entry) => entry.npc)).size >= RAPID_RELOAD.demons) complete(player, RAPID_RELOAD_TASK);
}

function attach(api) {
  api.persistAttribute(KILLS_ATTRIBUTE, 0);
  api.onCustomEvent(Shared.KILLED_EVENT, killed);
  api.onCombatHitResolved(hitLanded);
  api.onPlayerLogin(sendKillCount);
}

module.exports = { attach, _test: { killed, hitLanded, kills } };
