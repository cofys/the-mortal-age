"use strict";

/**
 * The Ancient Guthixian Temple after While Guthix Sleeps, where the tormented demons live
 * (Wiki: Ancient Guthixian Temple, Tormented Demon):
 * - single-way combat, but each room lets a player fight its own number of demons at once
 *   (1, 2 or 3; plugins/bosses/data/tormented-demons.json), shown by the demon-head icon
 *   (varbit td_multiway_indicator, captured 0 -> 2 on arriving in the central room). Nobody
 *   else can attack a demon that is fighting a player until that player leaves;
 * - a demon that can't reach its target to melee switches to magic or ranged and carries on;
 *   one whose target leaves (teleports, dies, logs out) heals to full;
 * - captured: a respawned demon summons itself (sequence and graphic) and can't be attacked for
 *   8 ticks, keeping the prayer it had; dying, it plays its death graphic, drops its overhead
 *   and sounds at its spawn tile, and tells "tormented-demons:killed" who killed it.
 */

const Shared = require("./Shared.TormentedDemons");

const MULTIWAY_VARBIT = 10960;
const ATTACKED_MESSAGE = "I'm already under attack.";
const TAKEN_MESSAGE = "Someone else is fighting that.";
/** Captured: three area sounds at the spawn tile as a demon dies. */
const DEATH_SOUNDS = Object.freeze([[9333, 4], [9332, 128], [9336, 136]]);
const DEATH_SPOT = Object.freeze({ id: 2848, slot: 0 });
const DEATH_SOUND_RANGE = 7;
/** How long a demon waits for a target it lost (out of reach, say) before giving up and healing. */
const GIVE_UP_TICKS = 10;
const RANGED_STYLES = Object.freeze(["ranged", "magic"]);

const shownLimit = new WeakMap();
let pluginApi = null;

function zoneLimit(location) {
  let best = null;
  let bestDistance = Infinity;
  for (const zone of Shared.data().zones) {
    const dx = zone.x - location.getX();
    const dy = zone.y - location.getY();
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = zone;
      bestDistance = distance;
    }
  }
  return best?.limit ?? 1;
}

function showLimit(player, limit) {
  if (shownLimit.get(player) === limit) return;
  shownLimit.set(player, limit);
  player.getPacketSender().sendVarbit(MULTIWAY_VARBIT, limit);
}

/** Whether the demon's fight with `player` can go on: they're alive, here and in its world. */
function stillHere(area, npc, player) {
  return player?.isRegistered?.() !== false && player.getHitpoints() > 0 && player.getArea?.() === area &&
    player.getPrivateArea?.() === npc.getPrivateArea?.();
}

/** The fight is over: it heals to full and its shield and timers start again (Wiki). */
function endFight(npc) {
  const fight = Shared.fights.get(npc);
  if (!fight) return;
  Shared.fights.delete(npc);
  if (fight.defenceless) Shared.setDefenceless(fight, false);
  if (npc.getHitpoints() > 0) npc.setHitpoints(npc.getMaxHitpoints());
  if (npc.getCombat().getTarget()) npc.getCombat().reset();
}

function processDemon(area, npc) {
  const fight = Shared.fights.get(npc);
  if (!fight || npc.getHitpoints() <= 0) return;
  const now = Shared.tick();
  if (fight.started && !fight.defenceless && fight.defencelessAt >= 0 && now >= fight.defencelessAt) {
    Shared.setDefenceless(fight, true);
  }
  const player = fight.target;
  if (!player) return;
  if (!stillHere(area, npc, player)) {
    endFight(npc);
    return;
  }
  if (npc.getCombat().getTarget() === player) {
    fight.lostTargetAt = -1;
    require("./Combat.TormentedDemons").keepStaggered(npc, player);
    return;
  }
  // Out of reach for melee (Wiki): it switches to magic or ranged and keeps fighting.
  if (fight.lostTargetAt < 0) fight.lostTargetAt = now;
  if (now - fight.lostTargetAt > GIVE_UP_TICKS) {
    endFight(npc);
    return;
  }
  if (fight.style === "melee") fight.style = Shared.pick(RANGED_STYLES);
  npc.getCombat().attack(player);
}

/** Spawn tiles whose demon died and hasn't come back yet. */
const respawning = new Set();

/**
 * A demon in the temple: always multi-combat (the rooms set the limits), with its old prayer. One
 * coming back after dying summons itself; one whose region just woke doesn't.
 */
function arrive(npc) {
  const { Animation, TimerKey } = Shared.core();
  npc.setMultiCombat(true);
  Shared.setPrayer(npc, Shared.prayerOf(npc));
  if (!respawning.delete(Shared.spawnKey(npc))) return;
  npc.setModelCustomisation?.(null);
  npc.performAnimation(new Animation(Shared.SEQ.SUMMON));
  Shared.spotanim(npc, Shared.SPOT.SUMMON);
  npc.getTimers().registers(TimerKey.ATTACK_IMMUNITY, Shared.SUMMON_TICKS);
}

function createTemple(api) {
  const { Area, Boundary } = api.core;
  const { minX, maxX, minY, maxY, z } = Shared.data().temple;

  class AncientGuthixianTemple extends Area {
    postEnter(mobile) {
      if (mobile.isPlayer()) showLimit(mobile.getAsPlayer(), zoneLimit(mobile.getLocation()));
      else if (Shared.isDemon(mobile)) arrive(mobile.getAsNpc());
    }

    postLeave(mobile) {
      if (!mobile.isPlayer()) return;
      const player = mobile.getAsPlayer();
      shownLimit.delete(player);
      player.getPacketSender().sendVarbit(MULTIWAY_VARBIT, 0);
    }

    process(mobile) {
      if (mobile.isPlayer()) showLimit(mobile.getAsPlayer(), zoneLimit(mobile.getLocation()));
      else if (Shared.isDemon(mobile)) processDemon(this, mobile.getAsNpc());
    }

    canAttack(attacker, target) {
      if (!attacker?.isPlayer?.() || !Shared.isDemon(target)) return null;
      const player = attacker.getAsPlayer();
      const fight = Shared.fights.get(target);
      if (fight?.target && fight.target !== player && stillHere(this, target, fight.target)) {
        player.sendMessage(TAKEN_MESSAGE);
        return false;
      }
      const others = Shared.demonsFighting(player).filter((npc) => npc !== target);
      if (others.length >= zoneLimit(player.getLocation())) {
        player.sendMessage(ATTACKED_MESSAGE);
        return false;
      }
      return null;
    }
  }

  return new AncientGuthixianTemple([new Boundary(minX, maxX, minY, maxY, z)]);
}

function beforeDeath({ npc }) {
  if (!Shared.isDemon(npc)) return;
  const fight = Shared.fights.get(npc);
  const player = fight?.target;
  if (player && player.isRegistered?.() !== false && player.getHitpoints() > 0) {
    // The shield is down from its drop until the attack after the unshielded one restores it.
    pluginApi.emitCustomEvent(Shared.KILLED_EVENT, { player, npc, shieldDown: fight.shield === "down" || fight.shield === "spent" });
  }
  Shared.fights.delete(npc);
  respawning.add(Shared.spawnKey(npc));
  npc.setHeadIcon(-1);
  Shared.spotanim(npc, DEATH_SPOT);
  const spawn = npc.getSpawnPosition?.() ?? npc.getLocation();
  for (const viewer of npc.getPlayersWithinDistance(15)) {
    for (const [id, delay] of DEATH_SOUNDS) {
      viewer.getPacketSender().sendAreaSound(id, spawn.getX(), spawn.getY(), spawn.getZ(), 1, delay, DEATH_SOUND_RANGE);
    }
  }
}

function attach(api) {
  pluginApi = api;
  api.registerArea(createTemple(api));
  api.onNpcBeforeDeath(beforeDeath);
}

module.exports = { attach, _test: { zoneLimit, processDemon, endFight } };
