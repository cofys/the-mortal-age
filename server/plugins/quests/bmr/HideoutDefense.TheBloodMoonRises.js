const DEFENSE = {
  // shortcut: the Wiki places the fight in the castle courtyard and says "several minutes";
  // its exact instance tiles and spawn clock are not published, so these are reachable
  // courtyard tiles and a four-minute hold, pending a live OSRS capture.
  bounds: [3561, 3589, 3347, 3367, 0],
  player: [3575, 3355],
  ivan: [3577, 3357],
  openingVyrewatch: [
    [3717, 3571, 3358], [3718, 3580, 3358], [3719, 3574, 3361],
  ],
  minimumTicks: 400,
  bloodveldAt: 40,
  sentinelAt: 120,
  bloodveldInterval: 50,
  sentinelInterval: 80,
};

module.exports = function createHideoutDefense({ api, stage, hideoutStage, escapeStage, complete }) {
  const { Boundary, HitDamage, HitMask, Location, NpcIdentifiers, PrivateArea, World } = api.core;
  const encounters = new Map();

  class CastleDefenseArea extends PrivateArea {
    constructor(owner) {
      super([new Boundary(...DEFENSE.bounds)]);
      this.owner = owner;
    }

    isMulti() { return true; }

    canAttack(attacker, target) {
      const attackerHere = attacker?.getArea?.() === this;
      const targetHere = target?.getArea?.() === this;
      if (attackerHere || targetHere) return attackerHere && targetHere;
      return null;
    }

    postLeave(mobile, logout) {
      super.postLeave(mobile, logout);
      if (!mobile?.isPlayer?.()) return;
      const encounter = encounters.get(this);
      if (encounter && !encounter.finished && mobile === encounter.player) {
        abandon(encounter, "Ivan's spell is interrupted when you leave the courtyard.");
      }
    }

    process(mobile) {
      if (!mobile?.isNpc?.()) return;
      const encounter = encounters.get(this);
      if (!encounter || !encounter.started || encounter.finished || mobile !== encounter.ivan || this.lastProcess === World.getProcessCycle()) return;
      this.lastProcess = World.getProcessCycle();
      const now = this.lastProcess;
      const { player, ivan } = encounter;
      if (player.getArea?.() !== this || player.getHitpoints() <= 0) {
        abandon(encounter, "Ivan's spell is interrupted while you recover from the fight.");
        return;
      }
      if (ivan.getHitpoints() <= 0) {
        abandon(encounter, "Ivan falls before he can finish the spell. Return to the hideout and try again.");
        return;
      }

      if (now >= encounter.nextBloodveldAt) {
        encounter.nextBloodveldAt = now + DEFENSE.bloodveldInterval;
        const bloodveld = spawn(encounter, NpcIdentifiers.ACIDIC_BLOODVELD, 3574, 3363);
        if (bloodveld) {
          bloodveld.getCombat().attack(ivan);
          encounter.acidicBloodvelds.add(bloodveld);
        }
      }
      if (now >= encounter.nextSentinelAt) {
        encounter.nextSentinelAt = now + DEFENSE.sentinelInterval;
        const sentinel = spawn(encounter, NpcIdentifiers.VYREWATCH_SENTINEL, 3583, 3362);
        if (sentinel) {
          sentinel.getCombat().attack(ivan);
          encounter.sentinels.add(sentinel);
        }
      }

      for (const bloodveld of [...encounter.acidicBloodvelds]) {
        if (bloodveld.getHitpoints() > 0 && chebyshev(bloodveld, ivan) <= 1) {
          encounter.acidicBloodvelds.delete(bloodveld);
          this.explode(bloodveld, encounter);
        }
      }

      if (now - encounter.startedAt >= DEFENSE.minimumTicks && encounter.openingKilled.size === encounter.opening.size) {
        encounter.finished = true;
        for (const npc of encounter.enemies) api.removeNpc(npc);
        api.removeNpc(ivan);
        player.setAttribute("quest.the_blood_moon_rises.hideout-defense-complete", true);
        player.setAttribute("quest.the_blood_moon_rises.hideout-defense-area", null);
        this.leave(player, false);
        encounters.delete(this);
        complete(player, ivan.getId());
      }
    }

    explode(bloodveld, encounter) {
      const { player, ivan } = encounter;
      const victims = [ivan, player, ...encounter.enemies].filter((npc) => npc === ivan || npc === player || npc.getHitpoints() > 0)
        .filter((npc) => chebyshev(npc, bloodveld) <= 1);
      for (const target of victims) {
        const damage = 25 + Math.floor(Math.random() * 6);
        target.getCombat().getHitQueue().addPendingDamage([
          new HitDamage(damage, HitMask.RED).setSource(bloodveld),
        ]);
      }
      api.removeNpc(bloodveld);
      player.sendMessage("An acidic bloodveld explodes. Keep it away from Ivan!");
    }
  }

  function spawn(encounter, id, x, y) {
    const npc = api.spawnNpc({ id, x, y, z: 0, wanderRadius: 0, owner: encounter.player, ownerOnly: true });
    if (!npc) return null;
    npc.setMultiCombat?.(true);
    encounter.area.enter(npc);
    encounter.enemies.add(npc);
    return npc;
  }

  function chebyshev(left, right) {
    const a = left.getLocation(), b = right.getLocation();
    return Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));
  }

  function abandon(encounter, message) {
    if (encounter.finished) return;
    encounter.finished = true;
    for (const npc of encounter.enemies) api.removeNpc(npc);
    api.removeNpc(encounter.ivan);
    encounter.player.setAttribute("quest.the_blood_moon_rises.hideout-defense-area", null);
    encounters.delete(encounter.area);
    encounter.player.sendMessage(message);
    if (encounter.player.getArea?.() === encounter.area) {
      encounter.area.leave(encounter.player, false);
      encounter.player.moveTo(new Location(3600, 9612, 0));
    }
  }

  function prepare(player) {
    if (!player || stage(player) !== hideoutStage) return false;
    const existing = player.getAttribute("quest.the_blood_moon_rises.hideout-defense-area");
    if (existing && encounters.has(existing)) return false;
    const area = new CastleDefenseArea(player.getUsername?.());
    const ivan = api.spawnNpc({ id: NpcIdentifiers.IVAN_STROM_13, x: DEFENSE.ivan[0], y: DEFENSE.ivan[1], z: 0,
      wanderRadius: 0, owner: player, ownerOnly: true });
    if (!ivan) { player.sendMessage("Ivan could not be reached in the castle courtyard. Try speaking to him again in the hideout."); return false; }
    ivan.setMultiCombat?.(true);
    ivan.setScriptedMovement?.(true);
    ivan.setMaxHitpoints(600);
    ivan.setHitpoints(600);
    area.enter(player);
    area.enter(ivan);
    const now = World.getProcessCycle();
    const encounter = { area, player, ivan, startedAt: now, nextBloodveldAt: now + DEFENSE.bloodveldAt,
      nextSentinelAt: now + DEFENSE.sentinelAt, enemies: new Set(), opening: new Set(),
      openingKilled: new Set(), acidicBloodvelds: new Set(), sentinels: new Set(), finished: false, started: false };
    encounters.set(area, encounter);
    player.setAttribute("quest.the_blood_moon_rises.hideout-defense-area", area);
    player.moveTo(new Location(...DEFENSE.player, 0));
    return true;
  }

  function start(player) {
    const area = player?.getAttribute?.("quest.the_blood_moon_rises.hideout-defense-area");
    const encounter = area && encounters.get(area);
    if (!encounter || encounter.player !== player || encounter.finished || encounter.started) return false;
    encounter.started = true;
    encounter.startedAt = World.getProcessCycle();
    encounter.nextBloodveldAt = encounter.startedAt + DEFENSE.bloodveldAt;
    encounter.nextSentinelAt = encounter.startedAt + DEFENSE.sentinelAt;
    for (const [id, x, y] of DEFENSE.openingVyrewatch) {
      const vyrewatch = spawn(encounter, id, x, y);
      if (!vyrewatch) { abandon(encounter, "The courtyard attackers could not be reached. Return to Ivan and try again."); return false; }
      encounter.opening.add(vyrewatch);
      vyrewatch.getCombat().attack(encounter.ivan);
    }
    player.sendMessage("Protect Ivan from the vyrewatch. Kill the three attackers, keep the bloodvelds away from him, and give him time to finish his spell.");
    return true;
  }

  function cancel(player) {
    const area = player?.getAttribute?.("quest.the_blood_moon_rises.hideout-defense-area");
    const encounter = area && encounters.get(area);
    if (encounter && encounter.player === player) abandon(encounter, "The courtyard fight has been reset.");
  }

  function onNpcHitModify({ npc, hit }) {
    const area = npc?.getArea?.();
    const encounter = area && encounters.get(area);
    const attacker = hit?.getAttacker?.();
    if (!encounter || encounter.finished || !encounter.enemies.has(npc) || !attacker?.isPlayer?.() || attacker !== encounter.player) return;
    if (npc.getCombat().getTarget?.() !== attacker) npc.getCombat().attack(attacker);
  }

  function onNpcDeath({ npc }) {
    const area = npc?.getArea?.();
    const encounter = area && encounters.get(area);
    if (!encounter || !encounter.opening.has(npc)) return;
    encounter.openingKilled.add(npc);
    if (encounter.openingKilled.size === encounter.opening.size) {
      encounter.player.sendMessage("The three vyrewatch are dead. Keep guarding Ivan while his spell takes effect.");
    }
  }

  function onPlayerLogout({ player }) {
    const area = player?.getAttribute?.("quest.the_blood_moon_rises.hideout-defense-area");
    const encounter = area && encounters.get(area);
    if (encounter && encounter.player === player) abandon(encounter, "The unfinished escape is lost when you leave the castle.");
  }

  api.onNpcHitModify(onNpcHitModify);
  api.onNpcDeath(onNpcDeath);
  api.onPlayerLogout(onPlayerLogout);
  return { prepare, start, cancel, onPlayerLogout, encounters, CastleDefenseArea };
};
