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
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const Influence = require("../../../kingdoms/Influence.Kingdoms");

// Hatred: lines for confronting hated/enemy players. {name} is filled at speak time.
const HATRED_HARASS_LINES = Object.freeze([
  "You. {name}. The court hasn't forgotten what you did — keep walking.",
  "{name}. We see you. Don't think the street forgets.",
  "Traitor's shadow. {name} — you'd best not linger here.",
]);

const ARRIVE_RADIUS = 2;
const SCAN_RADIUS_TILES = 12;
const STRANGER_CHALLENGE_COOLDOWN_MS = 60000;
const GLOBAL_CHALLENGE_COOLDOWN_MS = 20000;
const OFFICE_ACK_COOLDOWN_MS = 5 * 60 * 1000;
// Kingdom-choice slice phase 1: a home greeting is a rare kindness, never
// spam — one per player per five minutes, on the guard's own scan rhythm.
const HOME_GREET_COOLDOWN_MS = 5 * 60 * 1000;

const CHALLENGE_LINES = Object.freeze({
  plain: Object.freeze([
    "Halt! State your business here.",
    "Hold it. You don't wear our colours — who sent you?",
    "Easy, traveller. This street is watched. Move along peaceful.",
    "Papers? No? Then keep your hands where I can see them.",
    "Nothing to fear if you've nothing to hide. Carry on.",
  ]),
  terse: Object.freeze([
    "halt. business?",
    "hold it. who sent you?",
    "easy. move along.",
    "hands where i can see em.",
    "nothing to hide, move on.",
  ]),
});

const CHALLENGE_LINES_WAR = Object.freeze([
  "HALT! War is on — no strangers pass this line.",
  "Turn back, traveller. The city is sealed.",
  "You! Name yourself, quickly. We're at war.",
  "The levy's raised — every able blade to the walls. That may mean you, if it comes to it.",
  "Press-gangs walk tonight. You look able-bodied... move along, citizen, and stay out of sight.",
]);

const GREETING_LINES = Object.freeze({
  plain: Object.freeze([
    "Quiet watch today.",
    "All quiet on the walls.",
    "Mind the pickpockets near the market.",
  ]),
  terse: Object.freeze(["quiet today.", "all quiet.", "watch yer purse."]),
});

const WARNED_LINES = Object.freeze({
  plain: Object.freeze([
    "You again, {name}. The watch has been warned about you — move along, carefully.",
    "Hold it, {name}. We remember what you did here. One wrong move.",
    "I've heard your name, {name}, and not in a good way. Keep walking.",
  ]),
  terse: Object.freeze([
    "you again, {name}. warned about you. move along.",
    "hold it, {name}. we remember. one wrong move.",
    "{name}. heard things. keep walking.",
  ]),
});

// Kingdom-choice slice phase 1: fellow-kingdom players get a rare warm word
// in their home capital — the choice is welcomed, not just policed.
// {capital} is filled with the guard's capital at speak time.
const HOME_GREET_LINES = Object.freeze({
  plain: Object.freeze([
    "Hail, and welcome back to {capital}.",
    "Welcome home, brother.",
    "Good to see one of our own on the streets.",
  ]),
  terse: Object.freeze([
    "back in {capital}, eh.",
    "welcome home.",
  ]),
});

function pickHatredLine(state, username, player) {
  const personality = player?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  return voiceLine(voiceFor(personality), HATRED_HARASS_LINES, state.rng).replaceAll(
    "{name}",
    username
  );
}

function pickWarnedLine(state, username, player) {
  const personality = player?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  return voiceLine(voiceFor(personality), WARNED_LINES, state.rng).replaceAll(
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
        assaultAt: new Map(), // username -> timestamp (assault witnessed)
        nextAcknowledgeAt: 0,
        acknowledgedAt: new Map(), // username -> timestamp
        nextGreetAt: 0,
        greetedAt: new Map(), // username -> timestamp (home greetings)
      };
    });
  }

  function pickChallengeLine(state, atWar, player) {
    const pool = atWar ? CHALLENGE_LINES_WAR : CHALLENGE_LINES;
    // War lines stay as-is (urgency overrides voice); peacetime challenges
    // go through the citizen's voice.
    if (atWar || !pool.plain) {
      const flat = atWar ? pool : pool.plain;
      return flat[Math.floor(state.rng() * flat.length)];
    }
    const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    return voiceLine(voiceFor(personality), pool, state.rng);
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
      // Hatred: checked before stranger status — an enemy of this kingdom is
      // attacked on sight, a hated one harassed, even if they hold citizenship.
      let tier = null;
      try {
        tier = Influence.hatredTier(Influence.effectiveInfluence(other, kingdomId));
      } catch (error) {
        tier = null;
      }
      if (tier === "enemy" || tier === "hated") {
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
        state.challengedAt.set(username, nowMs);
        state.nextChallengeAt = nowMs + GLOBAL_CHALLENGE_COOLDOWN_MS;
        if (tier === "enemy") {
          try {
            sayPublic(player, `${pickHatredLine(state, username, player)} Seize them!`);
          } catch (error) {
            // Cosmetic; never break the patrol.
          }
          try {
            player.getCombat?.()?.attack?.(other);
          } catch (error) {
            // Combat engine decides legality; never break the patrol.
          }
          world?.log?.("citizen_guard_hatred_attack", {
            guard: player.getUsername?.(),
            target: username,
            kingdom: kingdomId,
          });
        } else {
          try {
            sayPublic(player, pickHatredLine(state, username, player));
          } catch (error) {
            // Cosmetic; never break the patrol.
          }
          world?.log?.("citizen_guard_hatred_harass", {
            guard: player.getUsername?.(),
            target: username,
            kingdom: kingdomId,
          });
        }
        return;
      }
      // Assault witnessed: a real player fighting a citizen of this kingdom
      // earns hatred with the kingdom. Once per cooldown per player.
      // Checked before stranger status — citizens answer for their own too.
      try {
        if (typeof other.isPlayerBot !== "function" || other.isPlayerBot() !== true) {
          const target = other.getCombat?.()?.getTarget?.() ?? null;
          const victimKingdom =
            target?.isPlayerBot?.() === true
              ? target.getAttribute?.(ATTR_KINGDOM_ID) ?? null
              : null;
          if (victimKingdom === kingdomId) {
            const vUsername = other.getUsername?.() ?? "?";
            if (nowMs - (state.assaultAt.get(vUsername) ?? 0) >= challengeCooldownMs) {
              state.assaultAt.set(vUsername, nowMs);
              Influence.addInfluence(other, kingdomId, -10, "assault");
              // The court posts a bounty on a witnessed assailant, and a
              // foreign assailant's crime chills their home court's
              // standing here (Jobs/Bounties phase 3). Lazy + fail-safe:
              // the hatred above stands even if the board is unavailable.
              try {
                const KingdomStore = require("../../../kingdoms/KingdomStore");
                require("../../../kingdoms/Bounties.Kingdoms").markWanted(
                  vUsername,
                  kingdomId,
                  "assault",
                  KingdomStore
                );
                const assailantKingdom = other.getAttribute?.(ATTR_KINGDOM_ID) ?? null;
                if (assailantKingdom && assailantKingdom !== kingdomId) {
                  const Relations = require("../../../kingdoms/Relations.Kingdoms");
                  Relations.addGoodwill(
                    assailantKingdom,
                    kingdomId,
                    Relations.GOODWILL_CRIME,
                    KingdomStore
                  );
                  KingdomStore.save();
                }
              } catch {
                // Bounty/goodwill are consequences, not the patrol.
              }
              world?.log?.("citizen_guard_assault_witnessed", {
                guard: player.getUsername?.(),
                assailant: vUsername,
                kingdom: kingdomId,
              });
            }
          }
        }
      } catch (error) {
        // Witnessing must never break the patrol.
      }
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
        sayPublic(player,
          warned ? pickWarnedLine(state, username, player) : pickChallengeLine(state, atWar, player)
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
        sayPublic(player, pickOfficeAddressLine(state, held[0].title));
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

  /** Capital display name for {capital} lines; falls back to the kingdom id. */
  function capitalName(kingdomId) {
    try {
      const Store = require("../../../kingdoms/KingdomStore");
      return Store.getKingdom?.(kingdomId)?.capital ?? kingdomId;
    } catch {
      return kingdomId;
    }
  }

  function isRealPlayer(other) {
    if (!other || typeof other.getUsername !== "function") {
      return false;
    }
    return !(typeof other.isPlayerBot === "function" && other.isPlayerBot() === true);
  }

  function notorietyOf(username, nowMs) {
    try {
      return getMemory().notoriety(username, nowMs) ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Kingdom-choice slice phase 1: home-ground welcome. A real player who
   * shares the guard's kingdom (and isn't notorious) gets an occasional warm
   * line — the same jittered scan rhythm as challenges, personality-scaled,
   * 5-minute per-player cooldown, peacetime only (at war the watch has no
   * kind words). Zero new tick cost: piggybacks the existing scan cadence.
   */
  function maybeGreetHome(ctx, state, kingdomId, scanRadius) {
    const { player, nowMs } = ctx;
    if (isKingdomAtWar(kingdomId)) {
      return;
    }
    if (nowMs < state.nextGreetAt) {
      return;
    }
    const locals = player.getLocalPlayers?.() ?? [];
    const selfLoc = player.getLocation();
    for (const other of locals) {
      if (!isRealPlayer(other)) {
        continue;
      }
      if (isStranger(player, other)) {
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
      const username = other.getUsername();
      if (nowMs - (state.greetedAt.get(username) ?? 0) < HOME_GREET_COOLDOWN_MS) {
        continue;
      }
      // Notorious "fellows" get the watch's suspicion, not its warmth.
      if (notorietyOf(username, nowMs) >= 0.5) {
        continue;
      }
      if (!chance(state.rng, state.human.chatRate * 0.3)) {
        continue;
      }
      state.greetedAt.set(username, nowMs);
      state.nextGreetAt =
        nowMs + logNormalJitter(state.rng, 45000, state.human.tempoSigma);
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const line = voiceLine(voiceFor(personality), HOME_GREET_LINES, state.rng)
        .replaceAll("{capital}", capitalName(kingdomId));
      try {
        sayPublic(player, line);
      } catch (error) {
        // Cosmetic; never break the patrol.
      }
      world?.log?.("citizen_guard_home_greet", {
        guard: player.getUsername?.(),
        greeted: username,
        kingdom: kingdomId,
      });
      return;
    }
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
      maybeGreetHome(ctx, state, kingdomId, scanRadius);

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
            const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
            sayPublic(player, voiceLine(voiceFor(personality), GREETING_LINES, state.rng));
          } catch (error) {
            // Cosmetic only.
          }
        }
        advanceWaypoint(ctx, state, circuit);
        return "running";
      }
      // Personality movement style: guards walk their beat differently.
      let patrolTarget = { x: state.target.x, y: state.target.y };
      try {
        const { styleWalkTarget } = require("../../lib/CitizenAlive");
        const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
        const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
        const username = player.getUsername?.() ?? "unknown";
        patrolTarget = styleWalkTarget({ username, personality }, state.target.x, state.target.y);
      } catch {
        // Fall back to the unstyled target.
      }
      requestMovement(player, patrolTarget.x, patrolTarget.y, {
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
