"use strict";

/**
 * CitizenMilitia — citizens at war, with real combat.
 *
 * When a citizen volunteers for the militia (see Militia.Kingdoms), this
 * action takes over their brain. The lifecycle:
 *
 *   MUSTER: walk to the kingdom's capital muster point. Battle cry on
 *     arrival ("For Asgarnia!").
 *   DEPLOY: march to the battlefield. Attackers head for the enemy capital;
 *     defenders hold at home. Follows the Marshal's orders.
 *   FIGHT: scan for enemy NPCs (war raiders, enemy guards), close distance,
 *     and attack with the REAL combat engine (bot.getCombat().attack —
 *     the CitizenSlayer path). Battle cries. Eat when hurt. Fall back when
 *     badly hurt or ordered.
 *   FALLBACK: ordered retreat. Walk home, don't engage.
 *
 * Orders (attack/defend/fallback) come from Militia.Kingdoms.getOrders,
 * set by the Marshal through the office dashboard. War state comes from
 * CitizenEvents.isKingdomAtWar. Death is real — the Citizens plugin's
 * onPlayerDeath hook records it with a battle cause and the funeral system
 * takes over.
 *
 * Zero LLM. Every engine read guarded. Per-action try/catch in the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { isKingdomAtWar } = require("../../CitizenEvents");
const { kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const { agentRng, chance } = require("../../lib/humanizer");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { sayPublic } = require("../../chat/CitizenSayPublic");

const Militia = require("../../../kingdoms/Militia.Kingdoms");

// --- tuning ---------------------------------------------------------------
const MUSTER_OFFSET = { dx: 5, dy: 5 }; // muster point relative to capital
const ARRIVE_RADIUS = 3;
const ENEMY_SCAN_TILES = 15;
const MAX_DIRECT_ATTACK_TILES = 10;
const RETREAT_HP_PCT = 25; // below this, fall back to eat
const CRY_COOLDOWN_MS = 45000;
const GIVE_UP_MS = 30 * 60 * 1000; // a deployment that never finds a fight ends

// --- battle cries -----------------------------------------------------------
const MUSTER_CRIES = Object.freeze({
  plain: Object.freeze([
    "For {kingdom}! I volunteer.",
    "The levy calls — I answer.",
    "Give me a spear. {kingdom} needs blades.",
    "My kingdom, my blood. I'm in.",
  ]),
  terse: Object.freeze([
    "for {kingdom}.",
    "levy calls. i'm in.",
    "spear me. let's go.",
  ]),
});

const BATTLE_CRIES = Object.freeze({
  plain: Object.freeze([
    "For {kingdom}!",
    "Have at you!",
    "For the crown!",
    "No step back!",
    "{kingdom} forever!",
  ]),
  terse: Object.freeze(["for {kingdom}!", "have at you!", "no step back!"]),
});

const FALLBACK_LINES = Object.freeze({
  plain: Object.freeze([
    "Fall back! Fall back!",
    "We're overrun — to the walls!",
    "Sound the retreat!",
  ]),
  terse: Object.freeze(["fall back!", "retreat!", "to the walls!"]),
});

// --- helpers ----------------------------------------------------------------

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function npcTile(npc) {
  try {
    const loc = npc.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function hpPercent(bot) {
  try {
    const hp = bot.getHitpoints?.() ?? 1;
    const max = bot.getMaxHitpoints?.() ?? 1;
    return max > 0 ? (hp / max) * 100 : 100;
  } catch {
    return 100;
  }
}

function kingdomName(kingdomId) {
  try {
    const Store = require("../../../kingdoms/KingdomStore");
    const k = Store.getKingdom?.(kingdomId);
    return k?.name ?? String(kingdomId);
  } catch {
    return String(kingdomId);
  }
}

function capitalOf(kingdomId) {
  try {
    const { CAPITALS } = require("../../../world/DiegeticObjects");
    return CAPITALS.find((c) => c.id === String(kingdomId)) ?? null;
  } catch {
    return null;
  }
}

/** True when the NPC is a valid war target: alive, registered, and an enemy. */
function isEnemyTarget(npc, myKingdomId) {
  try {
    if (!npc) return false;
    if (npc.isDead?.() || npc.isDying?.()) return false;
    if (npc.isRegistered?.() === false) return false;
    // War raiders are always valid targets for the defending side.
    const raider = npc.warRaider;
    if (raider && raider.defenderId === String(myKingdomId)) return true;
    // Don't attack raiders fighting FOR our kingdom.
    if (raider) return false;
    // Enemy guards: NPCs tagged with a different kingdom.
    const npcKingdom = npc.getAttribute?.("kingdom:id");
    if (npcKingdom && npcKingdom !== String(myKingdomId)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Find the nearest enemy NPC within scan range. */
function findEnemy(bot, kingdomId) {
  let npcs = [];
  try {
    npcs = bot.getLocalNpcs?.() ?? [];
  } catch {
    return null;
  }
  const bt = botTile(bot);
  let best = null;
  let bestDist = Number.MAX_SAFE_INTEGER;
  for (const npc of npcs) {
    if (!isEnemyTarget(npc, kingdomId)) continue;
    const nt = npcTile(npc);
    if (bt && nt) {
      if (nt.z !== bt.z) continue;
      const d = chebyshev(bt.x, bt.y, nt.x, nt.y);
      if (d > ENEMY_SCAN_TILES) continue;
      if (d < bestDist) {
        bestDist = d;
        best = npc;
      }
    } else if (!best) {
      best = npc;
    }
  }
  return best;
}

/** True when the bot is currently fighting an enemy. */
function inCombatWithEnemy(bot, kingdomId) {
  try {
    const target = bot.getCombat?.()?.getTarget?.();
    return isEnemyTarget(target, kingdomId);
  } catch {
    return false;
  }
}

function sayCry(bot, state, pool, kingdomId) {
  const now = Date.now();
  if (now - state.lastCryAt < CRY_COOLDOWN_MS) return;
  state.lastCryAt = now;
  try {
    const personality = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    const line = voiceLine(voiceFor(personality), pool, state.rng);
    sayPublic(bot, line.replaceAll("{kingdom}", kingdomName(kingdomId)));
  } catch {
    // Cosmetic.
  }
}

// --- action -----------------------------------------------------------------

function createCitizenMilitiaAction(spec, world) {
  const action = {
    id: "militiaDuty",

    update(ctx) {
      const bot = ctx?.player;
      const nowMs = ctx?.nowMs ?? Date.now();
      if (!bot) return "failed";

      const state = playerState(action, bot, () => ({
        rng: agentRng(`militia:${bot.getUsername?.() ?? "unknown"}`),
        phase: "muster",
        target: null,
        lastCryAt: 0,
        startedAt: nowMs,
        mustered: false,
      }));

      // War over or discharged: stand down.
      const kingdomId = kingdomIdOf(bot);
      if (!kingdomId || !isKingdomAtWar(kingdomId)) {
        return "success"; // brain re-decides; director discharges
      }
      if (!Militia.isMilitia(bot.getUsername?.())) {
        return "success"; // discharged mid-action
      }
      if (nowMs - state.startedAt > GIVE_UP_MS) {
        return "success"; // never stall the brain
      }

      const orders = Militia.getOrders(kingdomId);
      const rec = Militia.militiaOf(bot.getUsername?.());
      const side = rec?.side ?? "defender";

      // Badly hurt: fall back and eat (humans retreat; heroes die).
      if (hpPercent(bot) < RETREAT_HP_PCT && state.phase !== "fallback") {
        state.phase = "fallback";
        sayCry(bot, state, FALLBACK_LINES, kingdomId);
      }
      // Marshal's fallback order overrides everything.
      if (orders === "fallback" && state.phase !== "fallback") {
        state.phase = "fallback";
        sayCry(bot, state, FALLBACK_LINES, kingdomId);
      }

      switch (state.phase) {
        case "muster":
          return doMuster(ctx, state, bot, kingdomId, side, orders);
        case "deploy":
          return doDeploy(ctx, state, bot, kingdomId, side, orders);
        case "fight":
          return doFight(ctx, state, bot, kingdomId, side, orders);
        case "fallback":
          return doFallback(ctx, state, bot, kingdomId);
        default:
          state.phase = "muster";
          return "running";
      }
    },

    stop(ctx) {
      try {
        clearMovementRequest(ctx?.player);
      } catch {
        // Non-fatal.
      }
      try {
        ctx?.player?.getCombat?.()?.reset?.();
      } catch {
        // Non-fatal.
      }
    },

    // Test seams.
    _isEnemyTarget: isEnemyTarget,
    _findEnemy: findEnemy,
    _hpPercent: hpPercent,
  };

  function doMuster(ctx, state, bot, kingdomId, side, orders) {
    const capital = capitalOf(kingdomId);
    if (!capital) return "success";
    const muster = {
      x: capital.x + MUSTER_OFFSET.dx,
      y: capital.y + MUSTER_OFFSET.dy,
      z: capital.z ?? 0,
    };
    const bt = botTile(bot);
    if (bt && chebyshev(bt.x, bt.y, muster.x, muster.y) <= ARRIVE_RADIUS) {
      if (!state.mustered) {
        state.mustered = true;
        sayCry(bot, state, MUSTER_CRIES, kingdomId);
      }
      state.phase = orders === "fallback" ? "fallback" : "deploy";
      state.target = null;
      return "running";
    }
    requestMovement(bot, muster.x, muster.y, {
      reason: "citizen_militia_muster",
      basicPather: true,
      z: muster.z,
    });
    return "running";
  }

  function doDeploy(ctx, state, bot, kingdomId, side, orders) {
    // Already fighting? Switch to fight phase.
    if (inCombatWithEnemy(bot, kingdomId)) {
      state.phase = "fight";
      return "running";
    }
    // Enemy nearby? Engage.
    const enemy = findEnemy(bot, kingdomId);
    if (enemy) {
      state.phase = "fight";
      return "running";
    }
    // Attackers march on the enemy capital; defenders hold.
    if (side === "attacker" && orders === "attack") {
      const target = attackerTarget(kingdomId);
      if (target) {
        const bt = botTile(bot);
        if (bt && chebyshev(bt.x, bt.y, target.x, target.y) <= ARRIVE_RADIUS * 2) {
          // Arrived at enemy ground — fight whoever's here.
          state.phase = "fight";
          return "running";
        }
        requestMovement(bot, target.x, target.y, {
          reason: "citizen_militia_march",
          basicPather: true,
          z: target.z ?? 0,
        });
        return "running";
      }
    }
    // Defenders (or attackers without a target): hold and scan.
    state.phase = "fight";
    return "running";
  }

  function doFight(ctx, state, bot, kingdomId, side, orders) {
    // Keep fighting current enemy.
    if (inCombatWithEnemy(bot, kingdomId)) {
      // Battle cry occasionally mid-fight.
      if (chance(state.rng, 0.05)) {
        sayCry(bot, state, BATTLE_CRIES, kingdomId);
      }
      return "running";
    }
    // Find a new enemy.
    const enemy = findEnemy(bot, kingdomId);
    if (!enemy) {
      // No enemies in range.
      if (orders === "attack" && side === "attacker") {
        state.phase = "deploy"; // march on
        return "running";
      }
      // Hold position.
      return "running";
    }
    const et = npcTile(enemy);
    const bt = botTile(bot);
    if (bt && et && chebyshev(bt.x, bt.y, et.x, et.y) > MAX_DIRECT_ATTACK_TILES) {
      // Too far: close distance first.
      requestMovement(bot, et.x, et.y, {
        reason: "citizen_militia_engage",
        basicPather: true,
        z: et.z ?? 0,
      });
      return "running";
    }
    // In range: attack with the real combat engine.
    sayCry(bot, state, BATTLE_CRIES, kingdomId);
    try {
      bot.getCombat?.()?.attack?.(enemy);
    } catch {
      return "success";
    }
    return "running";
  }

  function doFallback(ctx, state, bot, kingdomId) {
    // Stop fighting.
    try {
      bot.getCombat?.()?.reset?.();
    } catch {
      // Non-fatal.
    }
    const capital = capitalOf(kingdomId);
    if (!capital) return "success";
    const bt = botTile(bot);
    if (bt && chebyshev(bt.x, bt.y, capital.x, capital.y) <= ARRIVE_RADIUS * 2) {
      // Made it home. If the war is still on and orders changed, re-deploy.
      const orders = Militia.getOrders(kingdomId);
      if (orders !== "fallback" && hpPercent(bot) > RETREAT_HP_PCT + 20) {
        state.phase = "muster";
        state.mustered = false;
        state.startedAt = Date.now();
        return "running";
      }
      return "running"; // hold at home
    }
    requestMovement(bot, capital.x, capital.y, {
      reason: "citizen_militia_fallback",
      basicPather: true,
      z: capital.z ?? 0,
    });
    return "running";
  }

  /**
   * Where attackers march: the enemy capital of the war they're in.
   * Reads the active war from the kingdoms store.
   */
  function attackerTarget(kingdomId) {
    try {
      const Wars = require("../../../kingdoms/Wars.Kingdoms");
      const Store = require("../../../kingdoms/KingdomStore");
      const wars = Wars.getWars(kingdomId, Store);
      const war = wars.find((w) => w.attackerId === String(kingdomId));
      if (!war) return null;
      return capitalOf(war.defenderId);
    } catch {
      return null;
    }
  }

  return action;
}

module.exports = { createCitizenMilitiaAction };
