"use strict";

/**
 * Battles — field battles as joinable events in an active war.
 *
 * Sieges test walls; battles test armies in the open. A battle is called
 * by one belligerent's court (war table: "Give battle"), fought at the
 * pair's border field — the same ground WarConsequences marks with
 * graves and scorched earth when war is declared.
 *
 * The shape of a battle:
 *   mustering (15 min) — the call goes out. Both kingdoms' militia
 *     musters are raised (Militia.setMuster): citizens volunteer at
 *     boosted rates through their normal utility-driven enlistment and
 *     WALK to the field via the militia brain action. Players join by
 *     walking there themselves. Nobody is ever teleported.
 *   fighting (30 min) — each side's host appears on the field as real
 *     NPC soldiers, sized from real state (the enemy's garrison). The
 *     militia brain targets them as enemies; kills are real combat,
 *     recorded per kingdom through the Citizens kill hook.
 *   resolved — a side whose host is wiped loses; at the horn, the side
 *     with more recorded kills wins; a tie is a drawn field. The winner
 *     feeds the war score (WarResolution) — battles are how wars are
 *     won short of taking a castle.
 *
 * Battle records persist in KingdomStore state.battles. Spawned NPCs
 * are session state (like siege raiders) and are despawned at the horn.
 */

const Wars = require("./Wars.Kingdoms");
const WarResolution = require("./WarResolution.Kingdoms");

const BATTLE_CONFIG = Object.freeze({
  /** Muster window before the hosts appear. */
  MUSTER_MS: 15 * 60 * 1000,
  /** Combat window once the hosts appear. */
  DURATION_MS: 30 * 60 * 1000,
  /** Rest between battles on the same border. */
  COOLDOWN_MS: 6 * 3600 * 1000,
  /** Every host fields at least this many soldiers. */
  BASE_NPCS: 4,
  /** Plus one soldier per this many enemy garrison levies. */
  GARRISON_PER_NPC: 10,
  /** The soldier NPC (same model as siege raiders). */
  NPC_ID: 11911,
  /** Scatter radius around the field center for spawns. */
  SPAWN_RADIUS: 10,
});

let pluginApi = null;

/** Spawned hosts this session: battleId -> [{ npc, forKingdomId }]. */
const hosts = new Map();

function battlesOf(state) {
  if (!Array.isArray(state.battles)) state.battles = [];
  return state.battles;
}

function pairMatches(battle, a, b) {
  return (
    (battle.warAttackerId === a && battle.warDefenderId === b) ||
    (battle.warAttackerId === b && battle.warDefenderId === a)
  );
}

/** The live (mustering/fighting) battle between a pair, or null. */
function activeBattleBetween(a, b, store) {
  const state = store.load();
  return (
    battlesOf(state).find(
      (bt) =>
        bt &&
        (bt.status === "mustering" || bt.status === "fighting") &&
        pairMatches(bt, a, b)
    ) ?? null
  );
}

/** Any live battle a kingdom is fighting (for the militia brain). */
function activeBattleFor(kingdomId, store) {
  const state = store.load();
  return (
    battlesOf(state).find(
      (bt) =>
        bt &&
        (bt.status === "mustering" || bt.status === "fighting") &&
        (bt.warAttackerId === kingdomId || bt.warDefenderId === kingdomId)
    ) ?? null
  );
}

/** The field a kingdom's soldiers should march to, or null. */
function activeBattleSiteFor(kingdomId, store) {
  const battle = activeBattleFor(kingdomId, store);
  if (!battle?.site) return null;
  return { ...battle.site, battleId: battle.id, status: battle.status };
}

function announce(api, message) {
  const world = api?.core?.World;
  if (!world) return;
  try {
    world
      .getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        try {
          p.sendMessage(message);
        } catch {
          // One deaf player doesn't silence the realm.
        }
      });
  } catch {
    // Announcement is courtesy.
  }
}

function kingdomName(state, kingdomId) {
  return state?.kingdoms?.[kingdomId]?.name ?? String(kingdomId);
}

// ---------------------------------------------------------------------------
// Calling a battle
// ---------------------------------------------------------------------------

/**
 * Call a battle against an enemy your kingdom is at war with. Raises
 * both sides' musters — the enemy's soldiers answer their own call.
 *
 * @param {string} initiatorKingdomId
 * @param {string} opponentKingdomId
 * @param {object} store
 * @param {object} [opts] - { calledBy, now }
 */
function callBattle(initiatorKingdomId, opponentKingdomId, store, opts = {}) {
  if (!initiatorKingdomId || !opponentKingdomId || !store) {
    return { ok: false, reason: "missing-params" };
  }
  if (initiatorKingdomId === opponentKingdomId) {
    return { ok: false, reason: "cannot-target-self" };
  }
  const war = Wars.activeWarBetween(initiatorKingdomId, opponentKingdomId, store);
  if (!war) return { ok: false, reason: "not-at-war" };
  if (activeBattleBetween(initiatorKingdomId, opponentKingdomId, store)) {
    return { ok: false, reason: "battle-already-called" };
  }
  const now = opts.now ?? Date.now();
  const state = store.load();
  const last = battlesOf(state)
    .filter((bt) => bt && bt.status === "resolved" && pairMatches(bt, initiatorKingdomId, opponentKingdomId))
    .sort((x, y) => (y.resolvedAt ?? 0) - (x.resolvedAt ?? 0))[0];
  if (last?.resolvedAt && now - last.resolvedAt < BATTLE_CONFIG.COOLDOWN_MS) {
    return { ok: false, reason: "battle-on-cooldown" };
  }

  let site = null;
  try {
    site = require("./WarConsequences.Kingdoms").borderTileFor(
      war.attackerId,
      war.defenderId
    );
  } catch {
    site = null;
  }
  if (!site) return { ok: false, reason: "no-battlefield" };

  const battle = {
    id: `battle-${war.attackerId}-${war.defenderId}-${now}`,
    warAttackerId: war.attackerId,
    warDefenderId: war.defenderId,
    initiatorId: initiatorKingdomId,
    site: { x: site.x, y: site.y, z: site.z ?? 0 },
    status: "mustering",
    createdAt: now,
    createdBy: opts.calledBy ?? null,
    musterEndsAt: now + BATTLE_CONFIG.MUSTER_MS,
    endsAt: null,
    kills: {},
    winnerId: null,
    outcome: null,
    resolvedAt: null,
  };
  battlesOf(state).push(battle);
  store.save();

  // Raise both musters: citizens volunteer and march on their own feet.
  try {
    const Militia = require("./Militia.Kingdoms");
    Militia.setMuster(war.attackerId, battle.id, opts.calledBy ?? null, battle.musterEndsAt);
    Militia.setMuster(war.defenderId, battle.id, opts.calledBy ?? null, battle.musterEndsAt);
  } catch {
    // Muster boost is an aid, not a requirement.
  }

  announce(
    pluginApi,
    `[Realm] ${kingdomName(state, initiatorKingdomId)} gives battle! ` +
      `The hosts muster at the border field — soldiers, to your banners!`
  );
  console.info("[battles] battle called", { id: battle.id, by: initiatorKingdomId });
  return { ok: true, battle };
}

// ---------------------------------------------------------------------------
// The fighting
// ---------------------------------------------------------------------------

/** Soldiers a host fields, sized from the enemy's real garrison. */
function forceSize(enemyKingdomId) {
  let garrison = 30;
  try {
    garrison = require("./Tension.Kingdoms").garrisonOf(enemyKingdomId) ?? 30;
  } catch {
    garrison = 30;
  }
  return (
    BATTLE_CONFIG.BASE_NPCS +
    Math.max(0, Math.floor(garrison / BATTLE_CONFIG.GARRISON_PER_NPC))
  );
}

function spawnHost(api, battle, forKingdomId, enemyKingdomId) {
  if (!api?.spawnNpc) return 0;
  const count = forceSize(enemyKingdomId);
  const spawned = hosts.get(battle.id) ?? [];
  let n = 0;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const x = Math.round(battle.site.x + Math.cos(angle) * BATTLE_CONFIG.SPAWN_RADIUS);
    const y = Math.round(battle.site.y + Math.sin(angle) * BATTLE_CONFIG.SPAWN_RADIUS);
    try {
      const npc = api.spawnNpc({
        id: BATTLE_CONFIG.NPC_ID,
        x,
        y,
        z: battle.site.z ?? 0,
        wanderRadius: 8,
      });
      if (npc) {
        try {
          npc.warBattle = { battleId: battle.id, forKingdomId: String(forKingdomId) };
        } catch {
          // Tag is best-effort.
        }
        spawned.push({ npc, forKingdomId: String(forKingdomId) });
        n++;
      }
    } catch {
      // Spawn failed — the host is smaller, not fictional.
    }
  }
  if (spawned.length > 0) hosts.set(battle.id, spawned);
  return n;
}

function liveHost(battleId, forKingdomId) {
  const list = hosts.get(battleId) ?? [];
  return list
    .filter((r) => r.forKingdomId === String(forKingdomId))
    .map((r) => r.npc)
    .filter((npc) => {
      try {
        return npc && !npc.isDead?.() && !npc.isDying?.() && npc.isRegistered?.() !== false;
      } catch {
        return false;
      }
    });
}

function despawnHost(battleId) {
  const list = hosts.get(battleId) ?? [];
  let n = 0;
  for (const { npc } of list) {
    try {
      npc?.unregister?.();
      n++;
    } catch {
      // Already gone.
    }
  }
  hosts.delete(battleId);
  return n;
}

/** Record a battle kill for a kingdom (from the Citizens kill hook). */
function recordBattleKill(battleId, killerKingdomId, store) {
  if (!battleId || !killerKingdomId || !store) return false;
  const state = store.load();
  const battle = battlesOf(state).find((bt) => bt && bt.id === battleId);
  if (!battle || battle.status !== "fighting") return false;
  if (
    killerKingdomId !== battle.warAttackerId &&
    killerKingdomId !== battle.warDefenderId
  ) {
    return false;
  }
  battle.kills[killerKingdomId] = (battle.kills[killerKingdomId] ?? 0) + 1;
  store.save();
  return true;
}

function resolveBattle(battle, winnerId, outcome, store, api) {
  battle.status = "resolved";
  battle.winnerId = winnerId;
  battle.outcome = outcome;
  battle.resolvedAt = Date.now();
  store.save();
  despawnHost(battle.id);
  try {
    const Militia = require("./Militia.Kingdoms");
    Militia.clearMuster(battle.warAttackerId);
    Militia.clearMuster(battle.warDefenderId);
  } catch {
    // Musters lapse on their own.
  }
  const state = store.load();
  if (winnerId) {
    WarResolution.onBattleWon(battle.warAttackerId, battle.warDefenderId, winnerId, store);
    announce(
      api,
      `[Realm] The battle is decided: ${kingdomName(state, winnerId)} holds the field ` +
        `against ${kingdomName(state, winnerId === battle.warAttackerId ? battle.warDefenderId : battle.warAttackerId)}.`
    );
    try {
      WarResolution.checkDecisiveWar(battle.warAttackerId, battle.warDefenderId, store);
    } catch {
      // The war continues; the score still moved.
    }
  } else {
    announce(
      api,
      `[Realm] The battle between ${kingdomName(state, battle.warAttackerId)} and ` +
        `${kingdomName(state, battle.warDefenderId)} ends drawn — the field keeps its dead and gives no victor.`
    );
  }
  // Job board: soldiers who stood at this field settle their contracts.
  try {
    require("./Jobs.Kingdoms").onWarEventResolved({
      kind: "battle",
      attackerId: battle.warAttackerId,
      defenderId: battle.warDefenderId,
      site: battle.site ?? null,
      store,
      worldLookup: (name) => {
        try {
          return api?.core?.World?.getPlayerByName?.(name) ?? null;
        } catch {
          return null;
        }
      },
    });
  } catch {
    // Jobs must never break a battle resolution.
  }
  console.info("[battles] battle resolved", { id: battle.id, winnerId, outcome });
  return battle;
}

/**
 * Advance all live battles. Called from the CitizenDirector tick with
 * the citizens api (spawnNpc lives there); ~60s granularity suits the
 * muster/fight windows.
 */
function tickBattles(director, api, store, now = Date.now()) {
  const Store = store ?? require("./KingdomStore");
  const state = Store.load();
  const live = battlesOf(state).filter(
    (bt) => bt && (bt.status === "mustering" || bt.status === "fighting")
  );
  for (const battle of live) {
    try {
      // A war that ended takes its battle with it.
      const war = Wars.activeWarBetween(battle.warAttackerId, battle.warDefenderId, Store);
      if (!war) {
        battle.status = "resolved";
        battle.outcome = "war-ended";
        battle.resolvedAt = now;
        Store.save();
        despawnHost(battle.id);
        continue;
      }
      if (battle.status === "mustering" && now >= battle.musterEndsAt) {
        battle.status = "fighting";
        battle.endsAt = now + BATTLE_CONFIG.DURATION_MS;
        Store.save();
        spawnHost(api, battle, battle.warAttackerId, battle.warDefenderId);
        spawnHost(api, battle, battle.warDefenderId, battle.warAttackerId);
        announce(
          api,
          `[Realm] The hosts meet at the border field — ${kingdomName(state, battle.warAttackerId)} ` +
            `against ${kingdomName(state, battle.warDefenderId)}. Steel decides now.`
        );
        continue;
      }
      if (battle.status === "fighting") {
        const atkAlive = liveHost(battle.id, battle.warAttackerId).length;
        const defAlive = liveHost(battle.id, battle.warDefenderId).length;
        const spawned = (hosts.get(battle.id) ?? []).length > 0;
        if (spawned && atkAlive === 0 && defAlive === 0) {
          resolveBattle(battle, null, "mutual-ruin", Store, api);
        } else if (spawned && atkAlive === 0) {
          resolveBattle(battle, battle.warDefenderId, "host-destroyed", Store, api);
        } else if (spawned && defAlive === 0) {
          resolveBattle(battle, battle.warAttackerId, "host-destroyed", Store, api);
        } else if (battle.endsAt && now >= battle.endsAt) {
          const atkKills = battle.kills[battle.warAttackerId] ?? 0;
          const defKills = battle.kills[battle.warDefenderId] ?? 0;
          if (atkKills === defKills) {
            resolveBattle(battle, null, "drawn", Store, api);
          } else {
            resolveBattle(
              battle,
              atkKills > defKills ? battle.warAttackerId : battle.warDefenderId,
              "kills-at-the-horn",
              Store,
              api
            );
          }
        }
      }
    } catch (error) {
      console.warn("[battles] tick failed", battle.id, error?.message ?? error);
    }
  }
}

function attachBattles(api) {
  pluginApi = api;
  console.info("[battles] field battles armed");
}

module.exports = attachBattles;
module.exports.attachBattles = attachBattles;
module.exports.BATTLE_CONFIG = BATTLE_CONFIG;
module.exports.callBattle = callBattle;
module.exports.activeBattleBetween = activeBattleBetween;
module.exports.activeBattleFor = activeBattleFor;
module.exports.activeBattleSiteFor = activeBattleSiteFor;
module.exports.recordBattleKill = recordBattleKill;
module.exports.tickBattles = tickBattles;
module.exports.forceSize = forceSize;
// Test seams.
module.exports._hosts = hosts;
