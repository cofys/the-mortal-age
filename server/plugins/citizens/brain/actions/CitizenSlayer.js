"use strict";

/**
 * CitizenSlayer — real Slayer tasks for citizens, the RuneScape way.
 *
 * Citizens visit a real Slayer master NPC, receive a real task assignment
 * via the Slayer plugin, then hunt the assigned monsters with the real
 * combat engine. Slayer XP flows automatically through the plugin's
 * onNpcDeath hook — no direct XP awards, no interface clicking.
 *
 * Flow per tick:
 *   - No Slayer plugin -> "failed" (fail fast, don't stall).
 *   - No active task -> find a nearby Slayer master NPC, walk to them,
 *     call assignTaskForNpc. No master nearby -> "success" (re-decide).
 *   - Wilderness task -> "success" (citizens don't hunt where they'd get
 *     PKed, per the PvP design — Krystilia's tasks stay untouched).
 *   - Task complete (remaining 0) -> "success" (brain re-decides, usually
 *     back to the master for a new assignment).
 *   - Already in combat with a task NPC -> "running" (wait it out).
 *   - Task NPC nearby -> claim it (10s shared reservation so citizens
 *     don't dogpile), walk into range, getCombat().attack(npc).
 *   - No task NPC nearby -> "success" (nothing to hunt here, re-decide).
 *   - Give up after GIVE_UP_MS so a broken hunt never stalls the day.
 *
 * Non-repeat: one task's worth of hunting per brain decision, then re-decide.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  clearMovementRequest,
  approachObject,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { agentRng } = require("../../lib/humanizer");

// If a hunt takes this long, the monsters moved on — re-decide.
const GIVE_UP_MS = 10 * 60 * 1000;
// Beyond this many tiles we approach first; inside it we attack directly.
const MAX_DIRECT_ATTACK_TILES = 10;
// Shared target claims: normalized username -> { npcId, expiresAt }.
const CLAIMS = new Map();
const CLAIM_MS = 10000;
// How far to scan for NPCs (getLocalNpcs is already proximity-bounded).
const MASTER_SCAN_NAMES = [
  "Turael",
  "Spria",
  "Mazchna",
  "Vannaka",
  "Chaeldar",
  "Konar quo Maten",
  "Nieve",
  "Duradel",
  "Mortimer",
  // Krystilia deliberately excluded — wilderness master.
];

function slayerPlugin() {
  try {
    return require("../../../skills/Slayer.plugin.js");
  } catch {
    return null;
  }
}

/** Slayer level, 1 when unreadable (safe fallback). */
function slayerLevel(player) {
  try {
    const Skill = require("../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.SLAYER);
    return Number.isInteger(lvl) && lvl > 0 ? lvl : 1;
  } catch {
    return 1;
  }
}

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

function npcName(npc) {
  try {
    return (
      npc?.getCurrentDefinition?.()?.getName?.() ??
      npc?.getDefinition?.()?.getName?.() ??
      ""
    );
  } catch {
    return "";
  }
}

function npcId(npc) {
  try {
    return npc?.getId?.() ?? 0;
  } catch {
    return 0;
  }
}

/** True when the NPC is dead, gone, or already fighting someone else. */
function npcUnavailable(npc, myUsername) {
  try {
    if (npc?.isDead?.() || npc?.isDying?.()) return true;
    if (npc?.isRegistered?.() === false) return true;
    // Never steal another player's target.
    const target = npc?.getCombat?.()?.getTarget?.() ?? npc?.getTarget?.();
    if (target) {
      const targetName = target?.getUsername?.() ?? "";
      if (targetName && targetName !== myUsername) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function claimKey(username) {
  return String(username ?? "").toLowerCase().trim();
}

function claimTarget(username, npc) {
  const id = npcId(npc);
  if (!id) return;
  CLAIMS.set(claimKey(username), { npcId: id, expiresAt: Date.now() + CLAIM_MS });
}

function isClaimedByOther(username, npc) {
  const id = npcId(npc);
  if (!id) return false;
  const now = Date.now();
  for (const [user, claim] of CLAIMS) {
    if (claim.expiresAt < now) {
      CLAIMS.delete(user);
      continue;
    }
    if (claim.npcId === id && user !== claimKey(username)) return true;
  }
  return false;
}

/** Find a Slayer master NPC near the bot. Returns the NPC or null. */
function findMasterNpc(bot) {
  let npcs = [];
  try {
    npcs = bot.getLocalNpcs?.() ?? [];
  } catch {
    return null;
  }
  const wanted = new Set(MASTER_SCAN_NAMES.map((n) => n.toLowerCase()));
  for (const npc of npcs) {
    const name = npcName(npc).toLowerCase();
    if (wanted.has(name)) return npc;
  }
  return null;
}

/** True when any of the task's locations is in the Wilderness. */
function isWildernessTask(task) {
  try {
    const locations = task?.getTask?.()?.locations ?? task?.locations ?? [];
    for (const loc of locations) {
      if (String(loc ?? "").toLowerCase().includes("wilderness")) return true;
    }
    // Krystilia's tasks are wilderness by definition.
    const masterName = task?.getMaster?.()?.name ?? "";
    if (String(masterName).toLowerCase().includes("krystilia")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Find a huntable task NPC near the bot. Returns the NPC or null.
 * Skips claimed, dead, and contested NPCs; prefers the nearest.
 */
function findTaskTarget(bot, task, username) {
  let npcNames = [];
  try {
    npcNames = task?.getTask?.()?.getNpcNames?.() ?? [];
  } catch {
    return null;
  }
  if (!npcNames.length) return null;
  const wanted = new Set(npcNames.map((n) => String(n).toLowerCase()));

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
    if (!wanted.has(npcName(npc).toLowerCase())) continue;
    if (npcUnavailable(npc, username)) continue;
    if (isClaimedByOther(username, npc)) continue;
    const nt = npcTile(npc);
    if (bt && nt) {
      if (nt.z !== bt.z) continue;
      const d = chebyshev(bt.x, bt.y, nt.x, nt.y);
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

/** True when the bot is already fighting a task NPC. */
function inTaskCombat(bot, task, username) {
  try {
    const combat = bot.getCombat?.();
    const target = combat?.getTarget?.();
    if (!target) return false;
    let npcNames = [];
    try {
      npcNames = task?.getTask?.()?.getNpcNames?.() ?? [];
    } catch {
      return false;
    }
    const wanted = new Set(npcNames.map((n) => String(n).toLowerCase()));
    return wanted.has(npcName(target).toLowerCase());
  } catch {
    return false;
  }
}

function createCitizenSlayerAction(spec, world) {
  const state = {
    startedAt: Date.now(),
    targetId: 0,
  };

  function failFast() {
    return "failed";
  }

  return {
    id: "citizenSlayer",

    update(ctx) {
      const bot = ctx?.player;
      if (!bot) return failFast();

      const Slayer = slayerPlugin();
      if (!Slayer) return failFast();

      const now = Date.now();
      if (now - state.startedAt > GIVE_UP_MS) {
        return "success"; // hunt went stale — re-decide, never stall
      }

      const username = bot.getUsername?.() ?? "";

      // --- task state -------------------------------------------------------
      let task = null;
      try {
        task = Slayer.getActiveTask?.(bot) ?? null;
      } catch {
        task = null;
      }
      const remaining = task?.getRemaining?.() ?? 0;

      // No task (or finished): get an assignment from a nearby master.
      if (!task || remaining <= 0) {
        const master = findMasterNpc(bot);
        if (!master) return "success"; // no master here — re-decide
        const mt = npcTile(master);
        const bt = botTile(bot);
        if (bt && mt && chebyshev(bt.x, bt.y, mt.x, mt.y) > 3) {
          // Walk to the master.
          try {
            approachObject(ctx, bot, world, master, { reason: "citizen_slayer" });
          } catch {
            // approach failed — re-decide
          }
          return "running";
        }
        // Close enough: take the assignment.
        try {
          Slayer.assignTaskForNpc?.(bot, {
            npcId: npcId(master),
            npcName: npcName(master),
          });
        } catch {
          return "success";
        }
        // Check what we got — wilderness tasks are left alone.
        try {
          task = Slayer.getActiveTask?.(bot) ?? null;
        } catch {
          task = null;
        }
        if (!task) return "success";
        if (isWildernessTask(task)) return "success";
        return "running";
      }

      // Wilderness task: citizens don't hunt where they'd get PKed.
      if (isWildernessTask(task)) return "success";

      // Already fighting a task NPC: wait it out.
      if (inTaskCombat(bot, task, username)) return "running";

      // Find something to hunt.
      const target = findTaskTarget(bot, task, username);
      if (!target) return "success"; // nothing to hunt here — re-decide

      const tt = npcTile(target);
      const bt = botTile(bot);
      if (bt && tt && chebyshev(bt.x, bt.y, tt.x, tt.y) > MAX_DIRECT_ATTACK_TILES) {
        // Too far: approach first.
        try {
          approachObject(ctx, bot, world, target, { reason: "citizen_slayer" });
        } catch {
          // approach failed — re-decide
        }
        return "running";
      }

      // In range: claim it and attack with the real combat engine.
      claimTarget(username, target);
      state.targetId = npcId(target);
      try {
        bot.getCombat?.()?.attack?.(target);
      } catch {
        return "success";
      }
      return "running";
    },

    stop(ctx) {
      try {
        clearMovementRequest(ctx?.player);
      } catch {
        // non-fatal
      }
      try {
        ctx?.player?.getCombat?.()?.reset?.();
      } catch {
        // non-fatal
      }
      state.targetId = 0;
    },

    // Test seams.
    _findMasterNpc: findMasterNpc,
    _findTaskTarget: findTaskTarget,
    _isWildernessTask: isWildernessTask,
    _inTaskCombat: inTaskCombat,
    _slayerLevel: slayerLevel,
    _claims: CLAIMS,
  };
}

module.exports = { createCitizenSlayerAction };
