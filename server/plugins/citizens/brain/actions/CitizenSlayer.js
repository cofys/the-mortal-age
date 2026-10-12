"use strict";

/**
 * CitizenSlayer — real Slayer tasks for citizens, the RuneScape way.
 *
 * Citizens visit a real Slayer master NPC, receive a real task assignment
 * via the Slayer plugin's units, then hunt the assigned monsters with the
 * real combat engine. Slayer XP flows automatically through Tasks' onNpcDeath
 * hook (npcKilled) — no direct XP awards, no interface clicking. The hook's
 * only gate is killer.isPlayer(), which is true for citizen bots (they are
 * Player instances), so citizen kills count down the task like any player's.
 *
 * API mapping (Slayer was rebuilt from cache tables into units under
 * server/plugins/skills/slayer/; the old top-level plugin exports are gone):
 *   - Slayer.getActiveTask(bot)            -> Tasks.current(bot)
 *       { taskId, task, bossId, count, original, masterId, area } | null
 *   - task.getRemaining()                  -> task.count
 *   - Slayer.assignTaskForNpc(bot, {...})   -> Data.masterForNpcName(name)
 *       to resolve the master, then Tasks.assign(bot, master)
 *   - task.getTask().getNpcNames()         -> Tasks.countsFor(task, npc)
 *       (the sanctioned kill-count predicate: NPC param 50 / named monsters /
 *       boss names, plus Konar-area and Krystilia-wilderness constraints)
 *   - task.getMaster().name / locations    -> Data.get().masters.get(
 *       task.masterId).names, task.area?.text (wilderness check)
 *
 * The Slayer plugin's register() runs unit.init(api) for every unit at boot,
 * so by tick time the units are initialized and safe to require directly —
 * the same pattern server/tests/slayer.test.cjs uses.
 *
 * Flow per tick:
 *   - No Slayer units -> "failed" (fail fast, don't stall).
 *   - No active task -> find a nearby Slayer master NPC, walk to them,
 *     resolve the master and call Tasks.assign. No master nearby, or the
 *     name resolves to nothing -> "success" (re-decide).
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
const Prayer = require("./CitizenPrayer");

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

/**
 * The Slayer units this action needs. Null when unavailable — the action
 * fails fast rather than stalling.
 */
function slayerUnits() {
  try {
    const Tasks = require("../../../skills/slayer/Tasks.Slayer");
    const Data = require("../../../skills/slayer/Data.Slayer");
    if (typeof Tasks?.current !== "function") return null;
    if (typeof Data?.masterForNpcName !== "function") return null;
    return { Tasks, Data };
  } catch {
    return null;
  }
}

/** Slayer level, 1 when unreadable (safe fallback). */
function slayerLevel(player) {
  try {
    const Skill = require("../../../../src/main/typescript/elvarg/game/model/Skill")
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

/** Resolve the Slayer master entry for a master NPC (by its cache name). */
function masterForNpc(npc, Data) {
  try {
    return Data.masterForNpcName(npcName(npc)) ?? null;
  } catch {
    return null;
  }
}

/**
 * True when the task is a Wilderness task. Krystilia's tasks are wilderness
 * by definition (kills only count there); Konar-style areas name the
 * Wilderness in their text.
 */
function isWildernessTask(task, Data) {
  try {
    if (!task) return false;
    const master = Data.get().masters.get(task.masterId);
    const names = master?.names ?? [];
    if (names.some((n) => String(n).toLowerCase().includes("krystilia")))
      return true;
    const areaText = task.area?.text ?? "";
    if (String(areaText).toLowerCase().includes("wilderness")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Find a huntable task NPC near the bot. Returns the NPC or null.
 * Skips NPCs that don't count for the task (Tasks.countsFor — the same
 * predicate the kill hook uses), claimed, dead, and contested NPCs;
 * prefers the nearest.
 */
function findTaskTarget(bot, task, username, Tasks) {
  if (!task) return null;
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
    let counts = false;
    try {
      counts = Tasks.countsFor(task, npc) === true;
    } catch {
      continue;
    }
    if (!counts) continue;
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
function inTaskCombat(bot, task, username, Tasks) {
  try {
    const target = bot.getCombat?.()?.getTarget?.();
    if (!target || !task) return false;
    return Tasks.countsFor(task, target) === true;
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

      const slayer = slayerUnits();
      if (!slayer) return failFast();
      const { Tasks, Data } = slayer;

      const now = Date.now();
      if (now - state.startedAt > GIVE_UP_MS) {
        return "success"; // hunt went stale — re-decide, never stall
      }

      const username = bot.getUsername?.() ?? "";

      // --- task state -------------------------------------------------------
      // Tasks.current(bot): { taskId, task, bossId, count, original,
      //   masterId, area } | null
      let task = null;
      try {
        task = Tasks.current(bot) ?? null;
      } catch {
        task = null;
      }
      const remaining = task?.count ?? 0;

      // No task (or finished): get an assignment from a nearby master.
      if (!task || remaining <= 0) {
        const masterNpc = findMasterNpc(bot);
        if (!masterNpc) return "success"; // no master here — re-decide
        const mt = npcTile(masterNpc);
        const bt = botTile(bot);
        if (bt && mt && chebyshev(bt.x, bt.y, mt.x, mt.y) > 3) {
          // Walk to the master.
          try {
            approachObject(bot, masterNpc, { reason: "citizen_slayer" });
          } catch {
            // approach failed — re-decide
          }
          return "running";
        }
        // Close enough: resolve the master and take the assignment.
        const master = masterForNpc(masterNpc, Data);
        if (!master) return "success"; // scan matched a name Data doesn't know
        try {
          Tasks.assign(bot, master);
        } catch {
          return "success";
        }
        // Check what we got — wilderness tasks are left alone.
        try {
          task = Tasks.current(bot) ?? null;
        } catch {
          task = null;
        }
        if (!task) return "success";
        if (isWildernessTask(task, Data)) return "success";
        return "running";
      }

      // Wilderness task: citizens don't hunt where they'd get PKed.
      if (isWildernessTask(task, Data)) return "success";

      // Already fighting a task NPC: pray like a player, wait it out.
      if (inTaskCombat(bot, task, username, Tasks)) {
        try {
          Prayer.maintainCombatPrayer(bot);
        } catch {
          // Prayer never breaks the hunt.
        }
        return "running";
      }

      // Stock prayer potions before the hunt (once per task; never stalls).
      if (!Prayer.tickSupplies(state, bot, world, ctx)) return "running";

      // Find something to hunt.
      const target = findTaskTarget(bot, task, username, Tasks);
      if (!target) return "success"; // nothing to hunt here — re-decide

      const tt = npcTile(target);
      const bt = botTile(bot);
      if (bt && tt && chebyshev(bt.x, bt.y, tt.x, tt.y) > MAX_DIRECT_ATTACK_TILES) {
        // Too far: approach first.
        try {
          approachObject(bot, target, { reason: "citizen_slayer" });
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
        Prayer.releaseCombatPrayers(ctx?.player);
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
    _masterForNpc: (npc) => {
      const slayer = slayerUnits();
      return slayer ? masterForNpc(npc, slayer.Data) : null;
    },
    _findTaskTarget: (bot, task, username) => {
      const slayer = slayerUnits();
      return slayer ? findTaskTarget(bot, task, username, slayer.Tasks) : null;
    },
    _isWildernessTask: (task) => {
      const slayer = slayerUnits();
      return slayer ? isWildernessTask(task, slayer.Data) : false;
    },
    _inTaskCombat: (bot, task, username) => {
      const slayer = slayerUnits();
      return slayer ? inTaskCombat(bot, task, username, slayer.Tasks) : false;
    },
    _slayerLevel: slayerLevel,
    _claims: CLAIMS,
  };
}

module.exports = { createCitizenSlayerAction };
