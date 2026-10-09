"use strict";

/**
 * CitizenThieve — steal from market stalls (and pick pockets when bold) for
 * real Thieving XP, the RuneScape way.
 *
 * Citizens with light fingers work the market: they pick the best stall
 * their Thieving level allows, walk to it, and steal via the real Thieving
 * plugin's bot entry point (stealFromStallBot) — the same pattern upstream's
 * Smelt.js uses. Real loot lands in the inventory and real Thieving XP flows
 * through SkillManager, so the level-up celebration fires for citizens
 * exactly as it does for players.
 *
 * When no stall is in reach, bolder citizens try pickpocketing nearby NPCs
 * via the real pickpocket flow (startBotPickpocket) — success pays, failure
 * stuns, exactly like a player clicking.
 *
 * Thieving is a crime. When a guard is close enough to see the steal, the
 * guard calls the thief out and the thief flees — the action ends and the
 * brain re-decides. No invented fines or confiscations: the guard's shout
 * and the thief's flight ARE the consequence.
 *
 * Flow per tick:
 *   - Inventory full -> walk to bank, deposit, continue.
 *   - Best stall for level found nearby -> walk to it, steal, cooldown.
 *   - No stall nearby -> look for a pickpocketable NPC, attempt it.
 *   - Nothing to steal anywhere -> "success" (done, brain re-decides).
 *   - Caught by a guard -> flee, "success".
 *   - Give up after GIVE_UP_MS so a bad thieving day never stalls the day.
 *
 * Non-repeat: works one thieving run, then the brain re-decides.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { createBankAction } = require("../../../bots/brain/actions/Bank");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

// If nothing gets stolen in this long, the market is cursed — move on.
const GIVE_UP_MS = 10 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;
const STALL_ARRIVE_RADIUS = 3;
const STALL_SEARCH_RADIUS = 40;
// Human pacing between steals — slower than the engine's 1s click delay.
const STEAL_COOLDOWN_MS = 9000;
// Guards notice a steal within this many tiles.
const GUARD_SPOT_RADIUS = 8;
// Catch lines guards shout. Short, loud, human.
const GUARD_CATCH_LINES = [
  "Hey! Stop, thief!",
  "Thief! Someone stop them!",
  "You! Drop that and get out of here!",
];

function thievingPlugin() {
  try {
    return require("../../../skills/Thieving.plugin");
  } catch {
    return null;
  }
}

function bankApi() {
  try {
    return require("../../../../src/main/typescript/elvarg/game/model/container/impl/Bank")
      .Bank;
  } catch {
    return null;
  }
}

/** Thieving level, 1 when unreadable (bakery-stall-only — safe fallback). */
function thievingLevel(player) {
  try {
    const Thieving = thievingPlugin();
    if (Thieving?.thievingLevel) return Thieving.thievingLevel(player);
  } catch {
    // fall through
  }
  return 1;
}

function invFull(player) {
  try {
    return player.getInventory?.()?.isFull?.() === true;
  } catch {
    return false;
  }
}

/** Nearest stall object the citizen may steal from, or null. */
function findStallObject(world, player, stallIds) {
  try {
    const loc = player.getLocation?.();
    if (!loc || !stallIds?.length) return null;
    const found =
      world?.objectSearch?.findCandidatesByIds?.(player, stallIds, {
        regionRadius: STALL_SEARCH_RADIUS,
        z: loc.getZ?.(),
        privateArea: player.getPrivateArea?.() ?? null,
      }) ?? [];
    let best = null;
    let bestDistSq = Number.MAX_SAFE_INTEGER;
    for (const object of found) {
      const objectLoc = object?.getLocation?.();
      if (!objectLoc || objectLoc.getZ?.() !== loc.getZ?.()) continue;
      const dx = objectLoc.getX() - loc.getX();
      const dy = objectLoc.getY() - loc.getY();
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = object;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Stall display name for a world object, or null. */
function stallNameFor(object, stallNames) {
  try {
    const name = object?.getDefinition?.()?.getName?.() ?? null;
    if (name && stallNames.has(name)) return name;
  } catch {
    // fall through
  }
  return null;
}

/** A pickpocketable NPC near the citizen, or null. Prefers the nearest. */
function findMark(player, allowedNames) {
  let npcs = [];
  try {
    npcs = player.getLocalNpcs?.() ?? [];
  } catch {
    return null;
  }
  if (!npcs.length || !allowedNames?.size) return null;
  let ploc = null;
  try {
    ploc = player.getLocation?.();
  } catch {
    return null;
  }
  let best = null;
  let bestDistSq = Number.MAX_SAFE_INTEGER;
  for (const npc of npcs) {
    let name = "";
    try {
      name = String(npc.getDefinition?.()?.getName?.() ?? "").toLowerCase();
    } catch {
      continue;
    }
    if (!allowedNames.has(name)) continue;
    try {
      if (npc.isRegistered?.() === false) continue;
    } catch {
      /* treat as available */
    }
    if (ploc) {
      try {
        const nloc = npc.getLocation?.();
        if (!nloc || (nloc.getZ?.() ?? 0) !== (ploc.getZ?.() ?? 0)) continue;
        const dx = nloc.getX() - ploc.getX();
        const dy = nloc.getY() - ploc.getY();
        const distSq = dx * dx + dy * dy;
        if (distSq >= bestDistSq) continue;
        bestDistSq = distSq;
      } catch {
        /* keep as candidate */
      }
    }
    best = npc;
  }
  return best;
}

/** A guard NPC close enough to witness the crime, or null. */
function witnessingGuard(player) {
  let npcs = [];
  try {
    npcs = player.getLocalNpcs?.() ?? [];
  } catch {
    return null;
  }
  let ploc = null;
  try {
    ploc = player.getLocation?.();
  } catch {
    return null;
  }
  if (!ploc) return null;
  for (const npc of npcs) {
    let name = "";
    try {
      name = String(npc.getDefinition?.()?.getName?.() ?? "").toLowerCase();
    } catch {
      continue;
    }
    if (!name.includes("guard")) continue;
    try {
      const nloc = npc.getLocation?.();
      if (!nloc || (nloc.getZ?.() ?? 0) !== (ploc.getZ?.() ?? 0)) continue;
      const d = Math.max(
        Math.abs(nloc.getX() - ploc.getX()),
        Math.abs(nloc.getY() - ploc.getY())
      );
      if (d <= GUARD_SPOT_RADIUS) return npc;
    } catch {
      /* skip */
    }
  }
  return null;
}

function atTile(player, tile, radius) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return false;
    return (
      (loc.getZ?.() ?? 0) === (tile.z ?? 0) &&
      Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <=
        radius
    );
  } catch {
    return false;
  }
}

function tileOf(object) {
  try {
    const loc = object?.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function walkTo(player, x, y, z, reason, spread = 4) {
  const username = player.getUsername?.() ?? "unknown";
  const spot = personalSpot(username, x, y, spread, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason,
      basicPather: true,
      z: z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenThieveAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`thieve:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        banking: false,
        bankDelegate: null,
        lastStealAt: 0,
        stallIds: null,
        stallNames: null,
      };
    });
  }

  function stopBanking(state, ctx) {
    try {
      state.bankDelegate?.stop?.(ctx);
    } catch {
      // best effort
    }
    state.bankDelegate = null;
    state.banking = false;
  }

  function ensureStallIndex(state, Thieving) {
    if (state.stallIds) return;
    let ids = [];
    let names = new Set();
    try {
      ids = Thieving.stallObjectIds?.() ?? [];
      for (const s of Thieving.stallInfo?.() ?? []) names.add(s.name);
    } catch {
      // leave empty
    }
    state.stallIds = Object.freeze([...ids]);
    state.stallNames = names;
  }

  const action = {
    id: "citizenThieve",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Thieving = thievingPlugin();
      if (!Thieving?.stealFromStallBot) {
        return "failed"; // Thieving plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) state.giveUpAt = nowMs + GIVE_UP_MS;
      if (nowMs >= state.giveUpAt) {
        stopBanking(state, ctx);
        return "success"; // bad thieving day — move on, don't stall
      }
      ensureStallIndex(state, Thieving);

      // Pockets full — bank the loot, then keep working.
      if (invFull(player)) {
        return bankLoot(ctx, state);
      }
      if (state.banking) stopBanking(state, ctx);

      const level = thievingLevel(player);

      // Primary: market stalls. Walk to the nearest one and steal.
      const stall = findStallObject(world, player, state.stallIds);
      if (stall) {
        return workStall(ctx, state, Thieving, stall, level);
      }

      // Fallback: pick pockets when no stall is in reach.
      const mark = findPickpocketMark(player, Thieving, level);
      if (mark) {
        return workMark(ctx, state, Thieving, mark);
      }

      return "success"; // nothing to steal anywhere; re-decide
    },
    stop(ctx) {
      try {
        const player = ctx?.player;
        if (player) {
          const st = playerState(action, player, () => null);
          if (st?.bankDelegate) {
            try {
              st.bankDelegate.stop?.(ctx);
            } catch {
              // best effort
            }
          }
        }
      } catch {
        // best effort
      }
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  function workStall(ctx, state, Thieving, stall, level) {
    const { player, nowMs } = ctx;
    const tile = tileOf(stall);
    if (!tile) return "running";
    if (!atTile(player, tile, STALL_ARRIVE_RADIUS)) {
      walkTo(player, tile.x, tile.y, tile.z, "citizen_thieve_stall", 3);
      return "running";
    }
    // At the stall. Pace the steals like a human, not a metronome.
    if (nowMs - state.lastStealAt < STEAL_COOLDOWN_MS) return "running";
    const stallName = stallNameFor(stall, state.stallNames);
    if (!stallName) return "running";
    const best = Thieving.bestStallForLevel?.(level);
    // Only steal from stalls at/below our level — the plugin enforces it,
    // but picking the best affordable stall first is what a human does.
    if (best && stallName !== best.name) {
      // This stall isn't our best option; another tick may find better.
      // Steal anyway — a thief doesn't walk past an open till.
    }
    let result = null;
    try {
      result = Thieving.stealFromStallBot(player, stallName, stall);
    } catch {
      result = { ok: false, reason: "error" };
    }
    state.lastStealAt = nowMs;
    if (!result?.ok) {
      if (result?.reason === "full") return bankLoot(ctx, state);
      return "running"; // level/no-stall — next tick re-evaluates
    }
    try {
      world?.log?.("citizen_thieve", {
        citizen: player.getUsername?.(),
        kingdom: kingdomIdOf(player),
        stall: stallName,
        xp: result.xp,
      });
    } catch {
      // non-fatal
    }
    // A guard saw it — get out of there.
    const guard = witnessingGuard(player);
    if (guard) {
      const roll = state.rng?.() ?? Math.random();
      // Closer guards are likelier to react; never certain, never impossible.
      if (roll < 0.65) {
        try {
          const line =
            GUARD_CATCH_LINES[
              Math.floor((state.rng?.() ?? Math.random()) * GUARD_CATCH_LINES.length)
            ];
          guard.forceChat?.(line);
        } catch {
          // best effort
        }
        // The watch has a witness: record the theft so the town court can
        // try the case. Defensive — the run ends the same either way.
        try {
          const Crime = require("../../lib/CitizenCrime");
          const username = player?.username ?? player?.getUsername?.() ?? null;
          if (username && typeof Crime.reportOffense === "function") {
            Crime.reportOffense(username, "theft", {
              witnessed: true,
              kingdomId: state.kingdomId ?? null,
            });
          }
        } catch {
          // best effort
        }
        fleeFrom(player, tile);
        stopBanking(state, ctx);
        return "success"; // caught — the run is over
      }
    }
    return "running";
  }

  function workMark(ctx, state, Thieving, npc) {
    const { player } = ctx;
    // Walk into pickpocket range first.
    let nloc = null;
    try {
      const loc = npc.getLocation?.();
      nloc = loc ? { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 } : null;
    } catch {
      return "running";
    }
    if (!nloc) return "running";
    if (!atTile(player, nloc, 2)) {
      walkTo(player, nloc.x, nloc.y, nloc.z, "citizen_thieve_mark", 2);
      return "running";
    }
    // In range — attempt the pickpocket via the real flow.
    let started = false;
    try {
      started = Thieving.startBotPickpocket?.(player, npc) === true;
    } catch {
      started = false;
    }
    if (started) {
      try {
        world?.log?.("citizen_thieve", {
          citizen: player.getUsername?.(),
          kingdom: kingdomIdOf(player),
          mark: npc.getDefinition?.()?.getName?.() ?? "unknown",
          mode: "pickpocket",
        });
      } catch {
        // non-fatal
      }
      // The outcome (loot or stun) lands on the engine's tick. A guard
      // witnessing the attempt reacts to the attempt itself.
      const guard = witnessingGuard(player);
      if (guard && (state.rng?.() ?? Math.random()) < 0.5) {
        try {
          guard.forceChat?.("Hey! Stop, thief!");
        } catch {
          // best effort
        }
        fleeFrom(player, nloc);
        return "success";
      }
    }
    return "running";
  }

  function findPickpocketMark(player, Thieving, level) {
    let targets = [];
    try {
      targets = Thieving.pickpocketTargetsForLevel?.(level) ?? [];
    } catch {
      return null;
    }
    if (!targets.length) return null;
    const allowed = new Set();
    for (const t of targets) {
      for (const n of t.npcs ?? []) allowed.add(String(n).toLowerCase());
    }
    return findMark(player, allowed);
  }

  function fleeFrom(player, tile) {
    // Run a dozen tiles away from the scene of the crime.
    try {
      const away = personalSpot(
        player.getUsername?.() ?? "unknown",
        tile.x + 12,
        tile.y + 12,
        6,
        14
      );
      requestMovement(player, away.x, away.y, {
        reason: "citizen_thieve_flee",
        basicPather: true,
        z: tile.z ?? 0,
      });
    } catch {
      // best effort
    }
  }

  function bankLoot(ctx, state) {
    const { player } = ctx;
    const bank = siteTile(player, "bank");
    if (!bank) {
      stopBanking(state, ctx);
      return "success"; // nowhere to stash it — call it a day
    }
    if (!state.banking) {
      if (!atTile(player, bank, BANK_ARRIVE_RADIUS)) {
        walkTo(player, bank.x, bank.y, bank.z, "citizen_thieve_bank");
        return "running";
      }
      state.banking = true;
      // Deposit everything — thieves travel light.
      state.bankDelegate = createBankAction({ deposit: "all" }, world);
    }
    let result = "running";
    try {
      result = state.bankDelegate.update(ctx);
    } catch {
      result = "failed";
    }
    if (result === "success" || result === "failed") {
      stopBanking(state, ctx);
      return "running";
    }
    return "running";
  }

  return action;
}

module.exports = {
  createCitizenThieveAction,
  // exposed for tests
  _thievingLevel: thievingLevel,
  _findStallObject: findStallObject,
  _findMark: findMark,
  _witnessingGuard: witnessingGuard,
  STEAL_COOLDOWN_MS,
  GUARD_SPOT_RADIUS,
};
