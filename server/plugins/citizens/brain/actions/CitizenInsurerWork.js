"use strict";

/**
 * CitizenInsurerWork — the brain action for real insurance work.
 *
 * Complements (does not duplicate):
 *   - CitizenInsurance: the data tier — policies, premiums, claims, pool,
 *     risk assessment. Real persistent state, real coins.
 *   - CitizenInsuranceLife: the slow tick — premium collection, policy
 *     sales, claim triggers. The real economic work.
 *   - This action: walks to the kingdom's real INSURANCE OFFICE, serves
 *     real customers (the visible signal — selling and claims happen
 *     through the data tier on the slow tick), and manages the office.
 *
 * Flow per tick:
 *   - Only registered insurers work. Non-insurers honestly return home.
 *   - Walk to the office tile (deterministic, next to the bank branch).
 *   - Serve in rounds (human-paced 8s): each round the insurer is
 *     available for walk-in customers — sales and claims process on the
 *     slow tick through CitizenInsurance/CitizenInsuranceLife.
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

function insuranceApi() {
  try {
    return require("../../lib/CitizenInsurance");
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
      reason: "citizenInsurerWork",
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

function officeTileFor(player) {
  try {
    const Insurance = insuranceApi();
    if (!Insurance) return null;
    const kid = kingdomIdOf(player);
    return Insurance.officeTile(kid);
  } catch {
    return null;
  }
}

function isInsurer(player) {
  try {
    const Insurance = insuranceApi();
    if (!Insurance) return false;
    const username = player?.username ?? player?.getUsername?.();
    return !!Insurance.insurerFor(username);
  } catch {
    return false;
  }
}

function createCitizenInsurerWorkAction() {
  const factoryId = "citizenInsurerWork";

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
      return !!insuranceApi() && !!officeTileFor(player);
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

    // Only insurers work. Others go home honestly.
    if (!isInsurer(player)) {
      const home = homeTileFor(player);
      if (home && !atTile(player, home)) {
        walkTo(player, home);
        return "running";
      }
      stopWalking(player);
      return "success";
    }

    const office = officeTileFor(player);

    if (st.phase === "outbound") {
      if (!office) {
        stopWalking(player);
        return "success";
      }
      if (atTile(player, office)) {
        st.phase = "serving";
        stopWalking(player);
        return "running";
      }
      walkTo(player, office);
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
      // Serving is ambient — real policy sales and claim processing happen
      // through the CitizenInsurance data-tier API on the slow tick. The
      // insurer being present at the office is the visible signal.
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

module.exports = { createCitizenInsurerWorkAction };
