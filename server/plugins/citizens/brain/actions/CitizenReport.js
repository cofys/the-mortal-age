"use strict";

/**
 * CitizenReport — the brain action for real journalism.
 *
 * Complements (does not duplicate):
 *   - CitizenNewspaper: the WEEKLY compiled paper (template headlines from
 *     journals, town-crier shouts, heraldic overlay). Zero storage of
 *     reporters, zero presses, zero subscriptions.
 *   - This action: the journalist's physical work — walks to the kingdom's
 *     real PRINTING PRESS, investigates real unclaimed events, writes real
 *     stories (1 real papyrus each from the real inventory), and stocks
 *     the press with real papyrus so editions can print.
 *
 * Flow per tick:
 *   - Only registered journalists (or curious/social citizens who register
 *     on arrival) report. Others honestly return home.
 *   - Walk to the press tile (deterministic, near the market).
 *   - Investigate in rounds (human-paced 8s): claim an unclaimed event on
 *     any beat, write the story — 1 real papyrus consumed per story, no
 *     papyrus = session ends honestly.
 *   - Stocking: donate spare papyrus (keep 2) to the press.
 *   - After REPORT_ROUNDS or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const REPORT_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const REPORT_COOLDOWN_MS = 8000; // human-paced reporting
const SPARE_PAPYRUS_KEPT = 2;

function pressApi() {
  try {
    return require("../../lib/CitizenPress");
  } catch {
    return null;
  }
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  try {
    const p = player.getPosition?.() ?? player.position;
    if (!p || !tile) return false;
    const dx = (p.x ?? 0) - tile.x;
    const dy = (p.y ?? 0) - tile.y;
    return Math.hypot(dx, dy) <= radius;
  } catch {
    return false;
  }
}

function walkTo(player, tile) {
  try {
    if (!tile) return;
    // Canonical engine shape: requestMovement(player, targetX, targetY, opts).
    requestMovement(player, tile.x, tile.y, { z: tile.z ?? 0 });
  } catch {}
}

function stopWalking(player) {
  try {
    clearMovementRequest(player);
  } catch {}
}

function homeTileFor(player) {
  try {
    return siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
  } catch {
    return { x: 3200, y: 3200, z: 0 };
  }
}

function countItem(player, itemId) {
  try {
    const inv = player.inventory ?? player.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(itemId);
    if (Array.isArray(inv.items)) {
      return inv.items.filter((i) => (i?.id ?? i) === itemId).length;
    }
    return 0;
  } catch { return 0; }
}

function removeItem(player, itemId, amount) {
  try {
    const inv = player.inventory ?? player.getInventory?.();
    if (!inv) return false;
    if (typeof inv.remove === "function") { inv.remove(itemId, amount); return true; }
    if (typeof inv.delete === "function") { inv.delete(itemId, amount); return true; }
    return false;
  } catch { return false; }
}

function createCitizenReportAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`report:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> reporting -> returning -> done
        roundsDone: 0,
        lastReportAt: 0,
        pressTile: null,
        homeTile: null,
        kingdomId: null,
        isJournalist: false,
        filed: 0,
      };
    });
  }

  const action = {
    id: "citizenReport",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Press = pressApi();
      if (!Press) return "success"; // no press system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        state.isJournalist = Press.isJournalist(username);
        if (!state.kingdomId) {
          state.phase = "returning";
        } else {
          const press = Press.ensurePress(state.kingdomId);
          state.pressTile = press?.tile ?? Press.pressTileFor(state.kingdomId);
          if (!state.pressTile) {
            state.phase = "returning";
          } else if (!state.isJournalist) {
            // Register curious/social citizens as journalists (honest first visit).
            const p = state.personality ?? {};
            const curiosity = p.curiosity ?? p.curious ?? 0;
            const sociability = p.sociability ?? p.social ?? 0;
            if (curiosity >= 0.6 || sociability >= 0.6) {
              Press.registerJournalist(username, state.kingdomId);
              state.isJournalist = true;
            } else {
              state.phase = "returning"; // not a reporter
            }
          }
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.pressTile)) {
            stopWalking(player);
            state.phase = "reporting";
            state.lastReportAt = nowMs - REPORT_COOLDOWN_MS; // report immediately on arrival
            return "running";
          }
          walkTo(player, state.pressTile);
          return "running";
        }
        case "reporting": {
          if (state.roundsDone >= REPORT_ROUNDS) {
            // Stock the press with spare papyrus before leaving.
            donateSparePapyrus(player, Press, state);
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastReportAt < REPORT_COOLDOWN_MS) return "running";
          state.lastReportAt = nowMs;
          state.roundsDone++;
          // Find an unclaimed event on any beat.
          let target = null;
          try {
            for (const beat of Press.BEATS) {
              const open = Press.unclaimedEvents(beat, state.kingdomId);
              if (open.length) { target = open[0]; break; }
            }
          } catch { target = null; }
          if (!target) return "running"; // nothing to report this round
          // Honest materials: 1 real papyrus per story.
          if (countItem(player, Press.MAT_PAPYRUS) < 1) {
            state.phase = "returning";
            return "running";
          }
          if (!removeItem(player, Press.MAT_PAPYRUS, 1)) {
            state.phase = "returning";
            return "running";
          }
          try {
            const res = Press.fileStory(username, target.id);
            if (res.ok) {
              state.filed++;
              try {
                const Rep = require("../../lib/CitizenReputation");
                for (const deed of Press.fameDeedsFor(username)) Rep.awardDeed?.(username, deed);
              } catch { /* fame optional */ }
            }
          } catch { /* filing failed, round still spent */ }
          return "running";
        }
        case "returning": {
          if (atTile(player, state.homeTile)) {
            stopWalking(player);
            return "success";
          }
          walkTo(player, state.homeTile);
          return "running";
        }
        default: {
          stopWalking(player);
          return "success";
        }
      }
    },
  };

  return action;
}

/** Donate spare papyrus to the press — keeps SPARE_PAPYRUS_KEPT for self. */
function donateSparePapyrus(player, Press, state) {
  try {
    const have = countItem(player, Press.MAT_PAPYRUS);
    const spare = have - SPARE_PAPYRUS_KEPT;
    if (spare < 1) return;
    if (removeItem(player, Press.MAT_PAPYRUS, spare)) {
      Press.stockPress(state.kingdomId, spare);
    }
  } catch { /* donation failed — no harm */ }
}

module.exports = { createCitizenReportAction };
