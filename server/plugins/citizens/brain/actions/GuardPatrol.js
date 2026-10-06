"use strict";

/**
 * GuardPatrol — the guard's body. Walks a closed waypoint circuit in its
 * kingdom's territory (data/sites.json), lingers with log-normal human
 * timing, and challenges strangers: players who don't share its kingdom:id.
 *
 * War alert (kingdom:war-declared, tracked in CitizenEvents) shortens the
 * circuit pace and sharpens the challenge lines. Per-bot state lives in the
 * shared action-state map; the action instance itself is stateless.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { isKingdomAtWar, officesHeldBy } = require("../../CitizenEvents");
const { patrolCircuit, kingdomIdOf } = require("../CitizenSites");
const { ATTR_KINGDOM_ID, ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");
const { getMemory } = require("../../lib/CitizenMemory");

const ARRIVE_RADIUS = 2;
const SCAN_RADIUS_TILES = 12;
const STRANGER_CHALLENGE_COOLDOWN_MS = 60000;
const GLOBAL_CHALLENGE_COOLDOWN_MS = 20000;
const OFFICE_ACK_COOLDOWN_MS = 5 * 60 * 1000;

const CHALLENGE_LINES = Object.freeze([
  "Halt! State your business here.",
  "Hold it. You don't wear our colours — who sent you?",
  "Easy, traveller. This street is watched. Move along peaceful.",
  "Papers? No? Then keep your hands where I can see them.",
  "Nothing to fear if you've nothing to hide. Carry on.",
]);

const CHALLENGE_LINES_WAR = Object.freeze([
  "HALT! War is on — no strangers pass this line.",
  "Turn back, traveller. The city is sealed.",
  "You! Name yourself, quickly. We're at war.",
]);

const GREETING_LINES = Object.freeze([
  "Quiet watch today.",
  "All quiet on the walls.",
  "Mind the pickpockets near the market.",
]);

const WARNED_LINES = Object.freeze([
  "You again, {name}. The watch has been warned about you — move along, carefully.",
  "Hold it, {name}. We remember what you did here. One wrong move.",
  "I've heard your name, {name}, and not in a good way. Keep walking.",
]);

function pickWarnedLine(state, username) {
  return WARNED_LINES[Math.floor(state.rng() * WARNED_LINES.length)].replaceAll(
    "{name}",
    username
  );
}

function distanceTo(player, tile) {
  const loc = player.getLocation();
  return Math.max(
    Math.abs(loc.getX() - tile.x),
    Math.abs(loc.getY() - tile.y)
  );
}

function isStranger(self, other) {
  if (!other || other === self) {
    return false;
  }
  if (typeof other.isPlayerBot === "function" && other.isPlayerBot() === true) {
    // Fellow citizen bots are only strangers across kingdoms.
    return (
      other.getAttribute?.(ATTR_KINGDOM_ID) !== self.getAttribute?.(ATTR_KINGDOM_ID)
    );
  }
  const theirKingdom = other.getAttribute?.(ATTR_KINGDOM_ID);
  return theirKingdom !== self.getAttribute?.(ATTR_KINGDOM_ID);
}

function createGuardPatrolAction(spec, world) {
  const scanRadius = Math.max(1, Number(spec.scanRadius ?? SCAN_RADIUS_TILES));
  const waypointRadius = Math.max(1, Number(spec.waypointRadius ?? ARRIVE_RADIUS));
  const challengeCooldownMs = Math.max(
    1000,
    Number(spec.challengeCooldownMs ?? STRANGER_CHALLENGE_COOLDOWN_MS)
  );

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`guard:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        waypointIndex: 0,
        target: null,
        lingerUntil: 0,
        nextScanAt: 0,
        nextChallengeAt: 0,
        challengedAt: new Map(), // username -> timestamp
        nextAcknowledgeAt: 0,
        acknowledgedAt: new Map(), // username -> timestamp
      };
    });
  }

  function pickChallengeLine(state, atWar) {
    const pool = atWar ? CHALLENGE_LINES_WAR : CHALLENGE_LINES;
    return pool[Math.floor(state.rng() * pool.length)];
  }

  function maybeChallenge(ctx, state, kingdomId) {
    const { player, nowMs } = ctx;
    if (nowMs < state.nextScanAt) {
      return;
    }
    state.nextScanAt =
      nowMs + logNormalJitter(state.rng, 8000, state.human.tempoSigma);
    if (nowMs < state.nextChallengeAt) {
      return;
    }
    const locals = player.getLocalPlayers?.() ?? [];
    const selfLoc = player.getLocation();
    const atWar = isKingdomAtWar(kingdomId);
    for (const other of locals) {
      if (!isStranger(player, other)) {
        continue;
      }
      const otherLoc = other.getLocation?.();
      if (!otherLoc) {
        continue;
      }
      const dist = Math.max(
        Math.abs(selfLoc.getX() - otherLoc.getX()),
        Math.abs(selfLoc.getY() - otherLoc.getY())
      );
      if (dist > scanRadius) {
        continue;
      }
      const username = other.getUsername?.() ?? "?";
      if (nowMs - (state.challengedAt.get(username) ?? 0) < challengeCooldownMs) {
        continue;
      }
      // Grudges travel: if any citizen holds a grudge against this stranger
      // (or the street has been warned about them), the guard always
      // challenges and says so — no friendly pass.
      let warned = false;
      try {
        warned = getMemory().notoriety(username, nowMs) >= 0.5;
      } catch (error) {
        // Memory must never break the patrol.
      }
      if (!warned && !chance(state.rng, atWar ? 1 : state.human.challengeRate * 0.6)) {
        continue;
      }
      state.challengedAt.set(username, nowMs);
      state.nextChallengeAt = nowMs + GLOBAL_CHALLENGE_COOLDOWN_MS;
      try {
        player.forceChat?.(
          warned ? pickWarnedLine(state, username) : pickChallengeLine(state, atWar)
        );
      } catch (error) {
        // Cosmetic; never break the patrol.
      }
      world?.log?.("citizen_guard_challenge", {
        guard: player.getUsername?.(),
        stranger: username,
        kingdom: kingdomId,
        atWar,
        warned,
      });
      return;
    }
  }

  /**
   * A player holding office in the guard's kingdom gets addressed by title —
   * "Quartermaster." — not challenged. Same scan rhythm as challenges, with
   * its own per-player cooldown so the watch doesn't fawn every pass.
   */
  function maybeAcknowledgeOffice(ctx, state, kingdomId, scanRadius) {
    const { player, nowMs } = ctx;
    if (nowMs < state.nextAcknowledgeAt) {
      return;
    }
    const locals = player.getLocalPlayers?.() ?? [];
    const selfLoc = player.getLocation();
    for (const other of locals) {
      if (isStranger(player, other)) {
        continue;
      }
      const username = other.getUsername?.();
      if (!username) {
        continue;
      }
      const held = officesHeldBy(username, kingdomId);
      if (held.length === 0) {
        continue;
      }
      const otherLoc = other.getLocation?.();
      if (!otherLoc) {
        continue;
      }
      const dist = Math.max(
        Math.abs(selfLoc.getX() - otherLoc.getX()),
        Math.abs(selfLoc.getY() - otherLoc.getY())
      );
      if (dist > scanRadius) {
        continue;
      }
      if (nowMs - (state.acknowledgedAt.get(username) ?? 0) < OFFICE_ACK_COOLDOWN_MS) {
        continue;
      }
      state.acknowledgedAt.set(username, nowMs);
      state.nextAcknowledgeAt =
        nowMs + logNormalJitter(state.rng, 30000, state.human.tempoSigma);
      try {
        player.forceChat?.(pickOfficeAddressLine(state, held[0].title));
      } catch (error) {
        // Cosmetic; never break the patrol.
      }
      return;
    }
  }

  function pickOfficeAddressLine(state, title) {
    const pool = [
      `${title}.`,
      `My ${title.toLowerCase()}.`,
      `${title} — all quiet on the walls.`,
    ];
    return pool[Math.floor(state.rng() * pool.length)];
  }

  function advanceWaypoint(ctx, state, circuit) {
    const { player, nowMs } = ctx;
    state.waypointIndex = (state.waypointIndex + 1) % circuit.length;
    const waypoint = circuit[state.waypointIndex];
    // Misclicks: occasionally walk to a slightly wrong tile first, then
    // correct on the next decision — humans do this, scripts don't.
    const misclick = chance(state.rng, state.human.misclickRate);
    state.target = noisyTile(
      waypoint.x,
      waypoint.y,
      misclick ? waypointRadius + 2 : waypointRadius,
      state.rng
    );
    state.target.z = waypoint.z ?? 0;
    // Log-normal linger before moving off: the "look around" beat.
    const baseLinger = isKingdomAtWar(kingdomIdOf(player)) ? 1500 : 4500;
    state.lingerUntil =
      nowMs + logNormalJitter(state.rng, baseLinger, state.human.tempoSigma);
    if (chance(state.rng, state.human.pauseRate)) {
      state.lingerUntil += logNormalJitter(state.rng, 3000, 0.8);
    }
  }

  const action = {
    id: "guardPatrol",
    update(ctx) {
      const { player, nowMs } = ctx;
      const circuit = patrolCircuit(player);
      if (circuit.length === 0) {
        return "failed";
      }
      const state = botState(player);
      const kingdomId = kingdomIdOf(player);

      maybeChallenge(ctx, state, kingdomId);
      maybeAcknowledgeOffice(ctx, state, kingdomId, scanRadius);

      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }
      if (nowMs < state.lingerUntil) {
        return "running";
      }
      if (!state.target) {
        advanceWaypoint(ctx, state, circuit);
        return "running";
      }
      if (distanceTo(player, state.target) <= waypointRadius) {
        // Arrived: linger, sometimes mutter a watch-line.
        state.target = null;
        if (chance(state.rng, 0.12 * state.human.chatRate)) {
          try {
            player.forceChat?.(
              GREETING_LINES[Math.floor(state.rng() * GREETING_LINES.length)]
            );
          } catch (error) {
            // Cosmetic only.
          }
        }
        advanceWaypoint(ctx, state, circuit);
        return "running";
      }
      requestMovement(player, state.target.x, state.target.y, {
        reason: "citizen_guard_patrol",
        basicPather: true,
        z: state.target.z ?? 0,
      });
      return "running";
    },
    stop(ctx) {
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  return action;
}

module.exports = {
  createGuardPatrolAction,
};
