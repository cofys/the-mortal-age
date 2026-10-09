"use strict";

/**
 * CitizenDocent — the brain action for hosting public observatory visitors.
 *
 * Complements (does not duplicate):
 *   - CitizenObserve (brain): astronomers walk to the observatory at night to
 *     OBSERVE the sky and create star charts. This action never creates
 *     charts; it HOSTS — leading tours and welcoming visitors.
 *   - CitizenObservatoriesLife (slow tick): party hosting and tour lifecycle
 *     when nobody runs this action.
 *
 * Flow per tick:
 *   - Only registered astronomers (CitizenAstronomy) host. Others honestly
 *     return home.
 *   - Daytime → honest walk-home (observatories open at night only).
 *   - Walk to the kingdom observatory tile (read from CitizenAstronomy).
 *   - Host in rounds (human-paced 8s): lead the live tour if one is running,
 *     otherwise welcome visitors with the night's sky. Rounds are ambient —
 *     the real economics (fees, sales) happen in the data tier.
 *   - After HOST_ROUNDS or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { kingdomIdOf } = require("../CitizenSites");

const GIVE_UP_MS = 10 * 60 * 1000;
const HOST_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const HOST_COOLDOWN_MS = 8000; // human-paced hosting

function observatoriesApi() {
  try {
    return require("../../lib/CitizenObservatories");
  } catch {
    return null;
  }
}

function astronomyApi() {
  try {
    return require("../../lib/CitizenAstronomy");
  } catch {
    return null;
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? player?.username ?? "";
  } catch {
    return "";
  }
}

function createCitizenDocentAction() {
  const actionState = new Map(); // player -> { phase, rounds, startedAt, lastRound }

  function getSt(player, nowMs) {
    let st = actionState.get(player);
    if (!st) {
      st = { phase: "outbound", rounds: 0, startedAt: nowMs, lastRound: 0 };
      actionState.set(player, st);
    }
    return st;
  }

  function clearSt(player) {
    actionState.delete(player);
    try {
      clearMovementRequest(player);
    } catch { /* best-effort */ }
  }

  function walkHome(player) {
    try {
      const st = playerState(player);
      const home = st?.homeTile;
      if (home) requestMovement(player, home.x, home.y);
    } catch { /* best-effort */ }
    clearSt(player);
    return { done: true, reason: "walk-home" };
  }

  function isHost(player) {
    const Astro = astronomyApi();
    if (!Astro) return false;
    try {
      return !!Astro.astronomerFor(usernameOf(player));
    } catch {
      return false;
    }
  }

  function doHostRound(player, nowMs) {
    const Obs = observatoriesApi();
    if (!Obs) return false;
    const kid = kingdomIdOf(player);
    if (!kid) return false;
    // If a live tour is running, the docent leads it (ambient — the tour
    // record already exists; leading is presence, not economics).
    try {
      const tour = Obs.liveTourFor(kid, nowMs);
      if (tour) {
        // Announce the sky to tour attendees near the docent.
        const sky = Obs.describeSky(kid, nowMs);
        try {
          if (typeof player?.sayPublic === "function" && tour.attendees.length > 0) {
            player.sayPublic(`Tour group — look up: ${sky}.`);
          }
        } catch { /* speech is best-effort */ }
        return true;
      }
    } catch { /* tour reads are best-effort */ }
    return false;
  }

  function tick(player, nowMs = Date.now()) {
    const Obs = observatoriesApi();
    if (!Obs || !isHost(player)) {
      return walkHome(player);
    }
    // Daytime: the observatory is closed.
    try {
      if (!Obs.isNight(nowMs)) return walkHome(player);
    } catch { /* if we cannot tell the time, keep hosting */ }
    const st = getSt(player, nowMs);
    if (nowMs - st.startedAt > GIVE_UP_MS) {
      return walkHome(player);
    }
    const kid = kingdomIdOf(player);
    const tile = kid ? Obs.observatoryTile(kid) : null;
    if (!tile) return walkHome(player);

    if (st.phase === "outbound") {
      try {
        const p = player?.getPosition?.() ?? player?.position ?? {};
        const dx = (p.x ?? 0) - tile.x;
        const dy = (p.y ?? 0) - tile.y;
        if (Math.hypot(dx, dy) <= ARRIVE_RADIUS) {
          st.phase = "hosting";
          st.lastRound = nowMs;
        } else {
          requestMovement(player, tile.x, tile.y);
        }
      } catch {
        return walkHome(player);
      }
      return { done: false, phase: st.phase };
    }

    // hosting phase
    if (st.rounds >= HOST_ROUNDS) {
      return walkHome(player);
    }
    if (nowMs - st.lastRound >= HOST_COOLDOWN_MS) {
      st.lastRound = nowMs;
      st.rounds += 1;
      doHostRound(player, nowMs);
    }
    return { done: false, phase: "hosting", rounds: st.rounds };
  }

  function reset(player) {
    clearSt(player);
  }

  return { tick, reset };
}

module.exports = { createCitizenDocentAction };
