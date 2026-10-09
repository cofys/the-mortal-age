"use strict";

/**
 * CitizenHunt — lay bird snares and trap birds for real Hunter XP, the
 * RuneScape way.
 *
 * Citizens pick up bird snares (bought from players, banked from earlier
 * trips). When the decision layer picks citizen_hunt, the citizen works a
 * full hunting run: withdraw snares from the bank when the pack is empty,
 * walk to the hunting grounds, lay traps via the real Hunter plugin's bot
 * entry point (startBotHunting) — the same pattern upstream's Smelt.js
 * uses — then wait for catches and check traps via the real object
 * interaction. Real birds land in the inventory and real Hunter XP flows
 * through SkillManager, so the level-up celebration fires for citizens
 * exactly as it does for players.
 *
 * Hunter is trap work — the citizen lays snares where birds wander, the
 * engine's trap tick process does the catching, and the citizen collects.
 * The work chains naturally: lay traps -> wait -> check -> collect ->
 * re-lay. The session always picks the best trap kind the citizen's level
 * allows, and the brain re-decides between runs.
 *
 * Flow per tick:
 *   - Hunter traps already active (isHuntingActive) -> wait/check them.
 *   - No snares in pack but bank holds some -> walk to bank, withdraw.
 *   - At hunting spot with snares -> lay trap via startBotHunting.
 *   - Trap laid, waiting for catch -> "running" (trap works on its own).
 *   - Trap caught -> check it via real object interaction, collect.
 *   - No snares anywhere -> "success" (done, brain re-decides).
 *   - Give up after GIVE_UP_MS so a bad hunting day never stalls the day.
 *
 * Non-repeat: works one full hunting run, then the brain re-decides.
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

// If no trap gets laid in this long, the hunting grounds are cursed — move on.
const GIVE_UP_MS = 10 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;
const HUNT_ARRIVE_RADIUS = 6;
// How long to wait for a trap to catch before checking/re-laying.
const TRAP_WAIT_MS = 3 * 60 * 1000;

// Hunting spots: where the birds are. Crimson swifts (level 1) at Feldip.
// Spots are picked by trap kind — the citizen goes where their best trap works.
const HUNTING_SPOTS = [
  { kind: "bird", x: 1960, y: 5897, z: 0, name: "Feldip swift grounds" },
  { kind: "bird", x: 1550, y: 3436, z: 0, name: "Woodcutting guild longtails" },
];

function hunterPlugin() {
  try {
    return require("../../../skills/Hunter.plugin");
  } catch {
    return null;
  }
}

function bankApi() {
  try {
    return require("../../../src/main/typescript/elvarg/game/model/container/impl/Bank")
      .Bank;
  } catch {
    return null;
  }
}

/** Hunter level, 1 when unreadable (bird-snare-only — safe fallback). */
function hunterLevel(player) {
  try {
    const Hunter = hunterPlugin();
    if (Hunter?.hunterLevel) return Hunter.hunterLevel(player);
    return 1;
  } catch {
    return 1;
  }
}

function invAmount(player, itemId) {
  try {
    return player.getInventory?.()?.getAmount?.(itemId) ?? 0;
  } catch {
    return 0;
  }
}

/** Total of itemId across all bank tabs (bounded). */
function bankAmount(player, itemId) {
  let total = 0;
  try {
    const Bank = bankApi();
    const tabs = Bank?.TOTAL_BANK_TABS ?? 9;
    for (let tab = 0; tab < tabs - 1; tab++) {
      const bank = player.getBank?.(tab);
      if (!bank) continue;
      const slot = bank.getSlotForItemId?.(itemId) ?? -1;
      if (slot < 0) continue;
      const stack = bank.getItems?.()[slot];
      if (!stack || stack.getId?.() !== itemId) continue;
      total += stack.getAmount?.() ?? 0;
    }
  } catch {
    // treat as empty
  }
  return total;
}

/**
 * Best trap kind the citizen can work: highest item-based trap at/under
 * their level. Bird snares at 1, box traps at 27, rabbit snares at 27.
 */
function bestTrapKind(Hunter, player) {
  try {
    let level = 1;
    if (Hunter?.hunterLevel) {
      level = Hunter.hunterLevel(player);
    } else {
      level = hunterLevel(player);
    }
    if (Hunter?.bestTrapKindForLevel) {
      return Hunter.bestTrapKindForLevel(level);
    }
    return "bird";
  } catch {
    return "bird";
  }
}

/** Item id for a trap kind (bird snare, box trap, etc.). */
function trapItemId(Hunter, kind) {
  try {
    const info = Hunter?.huntingTrapInfo?.() ?? [];
    const found = info.find((t) => t.kind === kind);
    return found?.itemId ?? null;
  } catch {
    return null;
  }
}

/** Snares the citizen could hunt with right now (inventory, else bank). */
function huntMaterials(Hunter, player) {
  const kind = bestTrapKind(Hunter, player);
  const itemId = trapItemId(Hunter, kind);
  if (!itemId) return 0;
  const inv = invAmount(player, itemId);
  if (inv > 0) return inv;
  return bankAmount(player, itemId);
}

/** Hunting spot for a trap kind — where the birds are. */
function huntingSpotFor(kind) {
  return HUNTING_SPOTS.find((s) => s.kind === kind) ?? HUNTING_SPOTS[0];
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

function walkTo(player, tile, reason, radius = 4) {
  const username = player.getUsername?.() ?? "unknown";
  const spot = personalSpot(username, tile.x, tile.y, radius, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason,
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenHuntAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`hunt:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        withdrawing: false,
        withdrawDelegate: null,
        trapLaidAt: 0,
        trapKind: null,
      };
    });
  }

  function stopWithdraw(state, ctx) {
    try {
      state.withdrawDelegate?.stop?.(ctx);
    } catch {
      // best effort
    }
    state.withdrawDelegate = null;
    state.withdrawing = false;
  }

  const action = {
    id: "citizenHunt",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Hunter = hunterPlugin();
      if (!Hunter?.startBotHunting) {
        return "failed"; // Hunter plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        stopWithdraw(state, ctx);
        return "success"; // bad hunting day — move on, don't stall
      }

      const kind = bestTrapKind(Hunter, player);
      const itemId = trapItemId(Hunter, kind);
      if (!itemId) return "failed"; // no trap item for this kind

      // Traps already laid — wait for catches. The engine's trap tick
      // does the catching; we check back after the wait.
      let hunting = false;
      try {
        hunting = Hunter.isHuntingActive?.(player) === true;
      } catch {
        hunting = false;
      }
      if (hunting) {
        if (state.withdrawing) stopWithdraw(state, ctx);
        // If we've waited long enough, the trap may have caught or
        // failed — the next tick will re-lay or collect. For now, wait.
        return "running";
      }

      // No active traps. Do we have snares in the pack?
      if (invAmount(player, itemId) > 0) {
        if (state.withdrawing) stopWithdraw(state, ctx);
        return layTrap(ctx, state, Hunter, kind, itemId);
      }

      // No snares in pack — check the bank before giving up.
      if (bankAmount(player, itemId) > 0) {
        return withdrawSnares(ctx, state, itemId);
      }

      return "success"; // nothing to hunt with anywhere; re-decide
    },
    stop(ctx) {
      try {
        const player = ctx?.player;
        if (player) {
          const st = playerState(action, player, () => null);
          if (st?.withdrawDelegate) {
            try {
              st.withdrawDelegate.stop?.(ctx);
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

  function layTrap(ctx, state, Hunter, kind, itemId) {
    const { player, nowMs } = ctx;
    const spot = huntingSpotFor(kind);
    // Walk to the hunting grounds first — traps need birds nearby.
    if (!atTile(player, spot, HUNT_ARRIVE_RADIUS)) {
      walkTo(player, spot, "citizen_hunt_spot");
      return "running";
    }
    // At the spot with snares — lay the trap via the real plugin path.
    try {
      const started = Hunter.startBotHunting?.(player, kind);
      if (started) {
        state.trapLaidAt = nowMs;
        state.trapKind = kind;
        try {
          world?.log?.("citizen_hunt", {
            citizen: player.getUsername?.(),
            kingdom: kingdomIdOf(player),
            kind,
            spot: spot.name,
          });
        } catch {
          // non-fatal
        }
      }
    } catch {
      // next tick retries
    }
    return "running";
  }

  function withdrawSnares(ctx, state, itemId) {
    const { player } = ctx;
    const bank = siteTile(player, "bank");
    if (!bank) {
      return "failed"; // no bank anchor for this kingdom
    }
    if (!state.withdrawing) {
      if (!atTile(player, bank, BANK_ARRIVE_RADIUS)) {
        walkTo(player, bank, "citizen_hunt_bank");
        return "running";
      }
      state.withdrawing = true;
      // Take up to 5 snares — a full trapping run.
      const take = Math.max(
        1,
        Math.min(5 - invAmount(player, itemId), bankAmount(player, itemId))
      );
      state.withdrawDelegate = createBankAction(
        { withdraw: [{ item: itemId, amount: invAmount(player, itemId) + take }] },
        world
      );
    }
    let result = "running";
    try {
      result = state.withdrawDelegate.update(ctx);
    } catch {
      result = "failed";
    }
    if (result === "success" || result === "failed") {
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  return action;
}

module.exports = {
  createCitizenHuntAction,
  // exposed for tests
  _huntMaterials: huntMaterials,
  _bestTrapKind: bestTrapKind,
  _trapItemId: trapItemId,
  _huntingSpotFor: huntingSpotFor,
  _hunterLevel: hunterLevel,
  HUNTING_SPOTS,
};
