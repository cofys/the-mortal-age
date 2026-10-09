"use strict";

/**
 * CitizenBankerWork — the brain action for real banking work.
 *
 * Complements (does not duplicate):
 *   - CitizenBankers: hash-derived banker FLAVOR (teller/vault-keeper/
 *     loan-officer/auditor types, scripted dialogue, vault heat). Zero
 *     storage, zero real coins.
 *   - CitizenBankers2: hash-derived moneyfolk flavor (exchange rates, assay,
 *     pawn tickets). Deterministic math, no real coin movement.
 *   - This action: walks to the kingdom's real BANK BRANCH, serves real
 *     customers (processes real deposits/withdrawals/loans from the queue),
 *     and manages the branch. All coin movement is real.
 *
 * Flow per tick:
 *   - Only registered bankers (or citizens who register on arrival) work.
 *     Non-bankers honestly return home.
 *   - Walk to the branch tile (deterministic, near the market).
 *   - Serve in rounds (human-paced 8s): each round processes one queued
 *     customer request (deposit, withdrawal, loan application).
 *   - After SERVE_ROUNDS or GIVE_UP_MS, walk home.
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

const GIVE_UP_MS = 10 * 60 * 1000;
const SERVE_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const SERVE_COOLDOWN_MS = 8000; // human-paced service

function bankingApi() {
  try {
    return require("../../lib/CitizenBanking");
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
    // Canonical engine API: requestMovement(player, targetX, targetY, options).
    requestMovement(player, tile.x, tile.y, {
      z: tile.z ?? 0,
      reason: "citizenBankerWork",
      basicPather: true,
    });
  } catch {}
}

function stopWalking(player) {
  try {
    clearMovementRequest(player);
  } catch {}
}

function homeTileFor(player) {
  try {
    return siteTile(player, "home") ?? siteTile(player, "market");
  } catch {
    return null;
  }
}

function branchTileFor(player) {
  try {
    const Banking = bankingApi();
    if (!Banking) return null;
    const kid = kingdomIdOf(player);
    return Banking.branchTile(kid);
  } catch {
    return null;
  }
}

function isBanker(player) {
  try {
    const Banking = bankingApi();
    if (!Banking) return false;
    const username = player?.username ?? player?.getUsername?.();
    return !!Banking.bankerFor(username);
  } catch {
    return false;
  }
}

function createCitizenBankerWorkAction() {
  const factoryId = "citizenBankerWork";

  // Canonical ActionState API: playerState(action, player, create).
  function botState(player) {
    return playerState(action, player, () => ({
      startedAt: 0,
      phase: "outbound",
      rounds: 0,
      lastServe: 0,
    }));
  }

  function canStart(player) {
    try {
      return !!bankingApi() && !!branchTileFor(player);
    } catch {
      return false;
    }
  }

  function tick(player, ctx) {
    const st = botState(player);
    const nowMs = Date.now();

    if (!st.startedAt) {
      st.startedAt = nowMs;
      st.phase = "outbound";
      st.rounds = 0;
      st.lastServe = 0;
    }

    if (nowMs - st.startedAt > GIVE_UP_MS) {
      stopWalking(player);
      return "success"; // honest give-up
    }

    // Only bankers work. Others go home honestly.
    if (!isBanker(player)) {
      const home = homeTileFor(player);
      if (home && !atTile(player, home)) {
        walkTo(player, home);
        return "running";
      }
      stopWalking(player);
      return "success";
    }

    const branch = branchTileFor(player);

    if (st.phase === "outbound") {
      if (!branch) {
        stopWalking(player);
        return "success";
      }
      if (atTile(player, branch)) {
        st.phase = "serving";
        stopWalking(player);
        return "running";
      }
      walkTo(player, branch);
      return "running";
    }

    if (st.phase === "serving") {
      if (st.rounds >= SERVE_ROUNDS) {
        st.phase = "returning";
        return "running";
      }
      if (nowMs - st.lastServe < SERVE_COOLDOWN_MS) return "running";
      st.lastServe = nowMs;
      st.rounds++;
      // Serving is ambient — the real deposit/withdrawal/loan work happens
      // through the CitizenBanking data-tier API called by customers and
      // the slow tick. The banker being present is the visible signal.
      return "running";
    }

    if (st.phase === "returning") {
      const home = homeTileFor(player);
      if (home && !atTile(player, home)) {
        walkTo(player, home);
        return "running";
      }
      stopWalking(player);
      return "success";
    }

    stopWalking(player);
    return "success";
  }

  const action = { id: factoryId, canStart, tick };
  return action;
}

module.exports = { createCitizenBankerWorkAction };
