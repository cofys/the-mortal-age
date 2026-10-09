"use strict";

/**
 * CitizenCompete — enter tournaments, train, and challenge real players.
 * The RuneScape way: athletes show up, pay their entry, and compete.
 *
 * Flow per tick:
 *   - Find open tournaments in the citizen's kingdom; pick the sport with
 *     the citizen's best real athletic rating.
 *   - Not entered: walk to the venue, pay the REAL entry fee, enter.
 *     Broke citizens can't enter — no invented fees.
 *   - Entered: train at the venue (mood boost, human-paced). Competitive
 *     citizens occasionally challenge a nearby REAL player to an
 *     exhibition (recorded; the chat layer resolves it on accept).
 *   - No open tournament: train anyway (a human athlete stays sharp).
 *   - Done after a productive visit -> "success" (brain re-decides).
 *   - Give up after GIVE_UP_MS so a bad trip never stalls the day.
 *
 * Non-repeat: works one competition visit, then the brain re-decides.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

// If nothing happens in this long, the venue is empty — move on.
const GIVE_UP_MS = 10 * 60 * 1000;
const VENUE_ARRIVE_RADIUS = 4;
// Human pacing between training sessions.
const TRAIN_COOLDOWN_MS = 90000;
// Challenges are rare — a human doesn't badger every passerby.
const CHALLENGE_COOLDOWN_MS = 30 * 60 * 1000;
const CHALLENGE_CHANCE = 0.15;

function tournamentsLib() {
  try {
    return require("../../lib/CitizenTournaments");
  } catch {
    return null;
  }
}

function kingdomIdOf(player) {
  try {
    const Sites = require("../CitizenSites");
    if (typeof Sites.kingdomIdOf === "function") return Sites.kingdomIdOf(player);
  } catch {
    // fall through
  }
  return null;
}

function dist(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x ?? 0) - (b.x ?? 0);
  const dy = (a.y ?? 0) - (b.y ?? 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function playerTile(player) {
  try {
    const pos = player?.getPosition?.() ?? player?.getTile?.();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      return { x: pos.x, y: pos.y, z: pos.z ?? 0 };
    }
  } catch {
    // fall through
  }
  return null;
}

function usernameOf(player) {
  try {
    return player?.username ?? player?.getUsername?.() ?? "";
  } catch {
    return "";
  }
}

function competitiveOf(player) {
  try {
    const st = playerState(player);
    const p = st?.personality ?? st?.traits ?? {};
    return Number(p.competitive ?? p.driven ?? p.ambitious ?? 0);
  } catch {
    return 0;
  }
}

/** Nearby real (non-bot) players. */
function nearbyRealPlayers(player, ctx) {
  try {
    const director = ctx?.director;
    const players = director?.getLocalPlayers?.(player) ?? [];
    return players.filter((p) => {
      try {
        if (p?.isBot) return false;
        if (p?.getAttribute?.("citizen:bot")) return false;
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function createCitizenCompeteAction(spec, world) {
  const username = usernameOf(spec?.citizen) || spec?.citizen?.username || "compete";
  const rng = agentRng(username);
  const profile = humanizerProfile(username);
  const startedAt = Date.now();
  let lastTrainAt = 0;
  let lastChallengeAt = 0;
  let arrived = false;
  let targetSportId = null;
  let targetTournamentId = null;

  function failFast() {
    return !tournamentsLib();
  }

  return {
    id: "citizenCompete",
    tick(player, ctx) {
      const T = tournamentsLib();
      if (!T) return "success";
      const name = usernameOf(player) || username;

      if (Date.now() - startedAt > GIVE_UP_MS) {
        try {
          clearMovementRequest(player);
        } catch {
          // best-effort
        }
        return "success";
      }

      const kingdomId = kingdomIdOf(player);

      // Pick the tournament: best real rating among open tournaments.
      if (!targetTournamentId) {
        let best = null;
        let bestRating = -1;
        for (const t of T.openTournamentsFor(kingdomId)) {
          let rating = null;
          try {
            rating = T.athleticRatingFor(player, t.sportId);
          } catch {
            rating = null;
          }
          const score = rating ?? 50; // luck sports: everyone is even
          if (score > bestRating) {
            bestRating = score;
            best = t;
          }
        }
        if (best) {
          targetTournamentId = best.id;
          targetSportId = best.sportId;
        } else {
          // No open tournament — train at the arena anyway.
          targetSportId = "arena";
        }
      }

      const sport = T.SPORTS[targetSportId];
      if (!sport) return "success";
      const venue = T.venueTile(kingdomId, targetSportId);
      if (!venue) return "success";

      // Walk to the venue.
      const here = playerTile(player);
      if (!arrived && here && dist(here, venue) > VENUE_ARRIVE_RADIUS) {
        try {
          const spot = personalSpot(name, venue.x, venue.y, 3, 10);
          const tgt = spot ?? venue;
          requestMovement(player, tgt.x, tgt.y, { z: tgt.z ?? 0 });
        } catch {
          // movement is best-effort
        }
        return "running";
      }
      arrived = true;
      try {
        clearMovementRequest(player);
      } catch {
        // best-effort
      }

      const now = Date.now();

      // Enter the tournament if open and not entered (honest entry fee).
      const tournament = targetTournamentId ? T.tournamentById(targetTournamentId) : null;
      if (tournament && tournament.status === "open") {
        const entered = tournament.entries.some(
          (e) => String(e.username ?? "").toLowerCase() === String(name).toLowerCase()
        );
        if (!entered) {
          const fee = T.entryFeeFor(tournament.sportId);
          if (T.coinCount(player) < fee) return "success"; // broke — can't enter
          let rating = null;
          try {
            rating = T.athleticRatingFor(player, tournament.sportId);
          } catch {
            rating = null;
          }
          if (!T.removeCoins(player, fee)) return "success";
          const res = T.enterTournament(tournament.id, name, rating, now);
          if (!res.ok) {
            T.addCoins(player, fee); // refund — never eat real coins
            return "success";
          }
          return "success"; // entered — brain re-decides
        }
      }

      // Train at the venue (human-paced): mood boost, journaled presence.
      if (now - lastTrainAt > TRAIN_COOLDOWN_MS * (profile?.pace ?? 1)) {
        try {
          const { addMood } = require("../CitizenNeeds");
          if (typeof addMood === "function") addMood(player, 4);
        } catch {
          // mood is best-effort
        }
        lastTrainAt = now;
      }

      // Occasionally challenge a nearby real player to an exhibition.
      if (
        now - lastChallengeAt > CHALLENGE_COOLDOWN_MS &&
        competitiveOf(player) > 0.6 &&
        rng() < CHALLENGE_CHANCE
      ) {
        lastChallengeAt = now;
        try {
          const realPlayers = nearbyRealPlayers(player, ctx);
          if (realPlayers.length > 0) {
            const foe = realPlayers[Math.floor(rng() * realPlayers.length)];
            const foeName = usernameOf(foe);
            if (foeName) {
              const ch = T.issueChallenge(name, foeName, targetSportId, now);
              if (ch && ctx?.director) {
                const say = ctx.director.sayPublic ?? ctx.director.say ?? null;
                if (typeof say === "function") {
                  say(`${foeName}, I challenge you to ${sport.label}! Say "accept" if you've got the nerve.`);
                }
              }
            }
          }
        } catch {
          // challenges are best-effort
        }
        return "success";
      }

      return "running";
    },
  };
}

module.exports = { createCitizenCompeteAction };
