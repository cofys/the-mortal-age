"use strict";

/**
 * TitheCollection — the collector's round. Morytanian guards walk a beat
 * between Sarev's tithe office (Canifis) and the Darkmeyer anchor, calling
 * debtors to account with a single demand line and moving on.
 *
 * Design law (human player model): collectors are social pressure, NOT
 * purse-touchers. Actual collection is the engine's BloodTithe round
 * (per-purse debits) and the debtor's own utility decision (pay_blood_tithe
 * at Sarev, flee, refuse). A citizen who seizes coins off a player's purse
 * would be both a bot tell and a grief vector. Demand scenes are
 * interruptible social events, never unskippable scripts.
 *
 * All debt reads go to the REAL engine ledger (KingdomStore flags written
 * by BloodTithe.Kingdoms) — never hashes, never invented amounts.
 */

const { playerState } = require("../../../bots/brain/ActionState.PlayerBots.js");
const { requestMovement } = require("../../../bots/behaviours/navigation/Navigation.PlayerBots.js");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
  personalSpot,
} = require("../../lib/humanizer");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");

// Sarev's tithe office (Canifis) — the regime's face, owned by the Myreque
// plugin; collectors start and end the beat here.
const TITHE_OFFICE = { x: 3496, y: 3472, z: 0 };
// Darkmeyer anchor — the far end of the beat.
const DARKMEYER = { x: 3495, y: 3235, z: 0 };

const DEBT_FLAG_PREFIX = "morytania:blood-tithe:debt:";
const ROUND_ACTIVE_FLAG = "morytania:blood-tithe:round-active";

const SCAN_RADIUS_TILES = 12;
const DEMAND_COOLDOWN_MS = 5 * 60 * 1000;
const GLOBAL_SCAN_MS = 8000;
const ARRIVE_RADIUS = 3;
const BEAT_GIVE_UP_MS = 30 * 60 * 1000;

const DEMAND_LINES = Object.freeze({
  plain: Object.freeze([
    "The court's due, {name}. The blood tithe doesn't collect itself.",
    "{name}. Lowerniel's ledger has your name in it. Settle at the tithe office.",
    "You owe the tithe, {name}. Pay it before the collectors stop asking nicely.",
    "The tithe round's on, {name}. Sarev's office, before nightfall.",
  ]),
  terse: Object.freeze([
    "tithe's due, {name}. office. now.",
    "{name}. ledger's got you. pay up.",
    "the round's on, {name}. don't make this worse.",
  ]),
});

function titheFlags() {
  try {
    const KingdomStore = require("../../../kingdoms/KingdomStore");
    return KingdomStore.getKingdom?.("morytania")?.flags ?? {};
  } catch {
    return {};
  }
}

function debtOf(username, flags) {
  if (!username) return 0;
  // The engine keys debt flags by lowercased username — match it exactly.
  return Math.max(
    0,
    Math.floor(Number(flags[DEBT_FLAG_PREFIX + String(username).toLowerCase()] ?? 0))
  );
}

function distanceTo(player, tile) {
  try {
    const loc = player.getLocation?.();
    if (!loc || !tile) return Number.MAX_SAFE_INTEGER;
    const dx = loc.getX() - tile.x;
    const dy = loc.getY() - tile.y;
    return Math.sqrt(dx * dx + dy * dy);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function createTitheCollectionAction(spec, world) {
  const scanRadius = Math.max(1, Number(spec.scanRadius ?? SCAN_RADIUS_TILES));

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const username = player.getUsername?.() ?? "unknown";
      return {
        rng: agentRng(`tithe:${username}`),
        human: humanizerProfile(personality),
        waypointIndex: 0,
        target: null,
        lingerUntil: 0,
        nextScanAt: 0,
        demandedAt: new Map(), // username -> timestamp
        startedAt: 0,
      };
    });
  }

  function beatWaypoints(player) {
    // Canifis office <-> Darkmeyer: the oppression made visible. Spread each
    // collector's personal spot so they don't stack on identical tiles.
    const username = player.getUsername?.() ?? "collector";
    return [
      personalSpot(username, TITHE_OFFICE.x, TITHE_OFFICE.y, 4, 5),
      personalSpot(username, DARKMEYER.x, DARKMEYER.y, 20, 5),
    ];
  }

  function advanceWaypoint(ctx, state, waypoints) {
    const { player, nowMs } = ctx;
    const next = waypoints[state.waypointIndex % waypoints.length];
    state.waypointIndex += 1;
    state.target = next;
    try {
      requestMovement(player, next.x, next.y, {
        reason: "tithe_collection_round",
        basicPather: true,
        z: next.z ?? 0,
      });
    } catch {
      // Movement unavailable — the beat continues on scan alone.
    }
    state.lingerUntil =
      nowMs + logNormalJitter(state.rng, 20000, state.human.tempoSigma);
  }

  function maybeDemand(ctx, state, flags) {
    const { player, nowMs } = ctx;
    if (nowMs < state.nextScanAt) return;
    state.nextScanAt = nowMs + logNormalJitter(state.rng, GLOBAL_SCAN_MS, state.human.tempoSigma);
    const locals = player.getLocalPlayers?.() ?? [];
    const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    for (const other of locals) {
      if (other === player) continue;
      const username = other.getUsername?.();
      if (!username) continue;
      const debt = debtOf(username, flags);
      if (debt <= 0) continue;
      const last = state.demandedAt.get(username) ?? 0;
      if (nowMs - last < DEMAND_COOLDOWN_MS) continue;
      state.demandedAt.set(username, nowMs);
      // One line, then the round moves on. The debtor's choice (pay at the
      // office, flee, refuse) is their own utility decision — the collector
      // never blocks or follows them off the beat.
      try {
        const line = voiceLine(voiceFor(personality), DEMAND_LINES, state.rng);
        sayPublic(player, line.replace("{name}", username));
      } catch {
        // Speech is flavor; the round never breaks on it.
      }
      if (!chance(state.rng, 0.25 * state.human.chatRate)) break;
    }
  }

  const action = {
    id: "titheCollection",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      if (!state.startedAt) state.startedAt = nowMs;
      if (nowMs - state.startedAt > BEAT_GIVE_UP_MS) {
        return "success"; // the round ends; the engine runs the next one
      }
      const flags = titheFlags();
      maybeDemand(ctx, state, flags);

      if (player.getForceMovement?.() != null) return "running";
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";
      if (nowMs < state.lingerUntil) return "running";

      const waypoints = beatWaypoints(player);
      if (!state.target) {
        advanceWaypoint(ctx, state, waypoints);
        return "running";
      }
      if (distanceTo(player, state.target) <= ARRIVE_RADIUS) {
        state.target = null;
        return "running";
      }
      return "running";
    },
  };

  return action;
}

module.exports = {
  createTitheCollectionAction,
};
