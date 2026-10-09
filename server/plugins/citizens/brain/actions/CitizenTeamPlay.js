"use strict";

/**
 * CitizenTeamPlay — play for a real team in the citizen leagues.
 * The RuneScape way: athletes show up, train with their mates, and play.
 *
 * Flow per tick:
 *   - Find the citizen's team in their kingdom (best sport by real
 *     athletic rating). Not on a team: join the emptiest team with space.
 *   - Walk to the sport's venue (deterministic tile near the market).
 *   - At the venue: train with the team (human-paced, mood boost).
 *   - Done after a productive visit -> "success" (brain re-decides).
 *   - Give up after GIVE_UP_MS so a bad trip never stalls the day.
 *
 * Non-repeat: works one team visit, then the brain re-decides.
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

const GIVE_UP_MS = 10 * 60 * 1000;
const VENUE_ARRIVE_RADIUS = 4;
const TRAIN_COOLDOWN_MS = 90000;

function leaguesLib() {
  try {
    return require("../../lib/CitizenLeagues");
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

function siteTile(player, kind) {
  try {
    const Sites = require("../CitizenSites");
    if (typeof Sites.siteTile === "function") {
      const tile = Sites.siteTile(player, kind);
      if (tile && Number.isFinite(tile.x)) return tile;
    }
    if (typeof Sites.siteTileByKingdom === "function") {
      const tile = Sites.siteTileByKingdom(kingdomIdOf(player), kind);
      if (tile && Number.isFinite(tile.x)) return tile;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Athletic rating for a sport from real skill levels (defensive). */
function athleticRating(player, sportId) {
  try {
    const L = leaguesLib();
    const sport = L?.TEAM_SPORTS?.[sportId];
    if (!sport) return 1;
    let total = 0;
    for (const skill of sport.skills) {
      let lvl = 1;
      try {
        const v = player?.skills?.[skill]?.level ?? player?.getLevel?.(skill);
        if (typeof v === "number" && v >= 1) lvl = v;
      } catch { /* honest floor */ }
      total += lvl;
    }
    return total;
  } catch {
    return 1;
  }
}

function createCitizenTeamPlayAction(spec, world) {
  const username = usernameOf(spec?.citizen) || spec?.citizen?.username || "teamplay";
  const rng = agentRng(username);
  const profile = humanizerProfile(username);
  const startedAt = Date.now();
  let lastTrainAt = 0;
  let arrived = false;
  let targetTeamId = null;
  let targetSportId = null;

  function failFast() {
    return !leaguesLib();
  }

  return {
    id: "citizenTeamPlay",
    tick(player, ctx) {
      const L = leaguesLib();
      if (!L) return "success";
      if (!player) return "success"; // no player, nothing to do
      const name = usernameOf(player) || username;
      if (!name) return "success";

      if (Date.now() - startedAt > GIVE_UP_MS) {
        try { clearMovementRequest(player); } catch { /* best-effort */ }
        return "success";
      }

      const kingdomId = kingdomIdOf(player);
      if (!kingdomId) return "success";

      // Pick the team: the citizen's own team if they have one, else the
      // emptiest team in their best sport.
      if (!targetTeamId) {
        let bestSport = null;
        let bestRating = -1;
        for (const sportId of Object.keys(L.TEAM_SPORTS)) {
          const existing = L.teamOf(name, kingdomId, sportId);
          if (existing) {
            targetTeamId = existing.id;
            targetSportId = sportId;
            break;
          }
          const rating = athleticRating(player, sportId);
          if (rating > bestRating) {
            bestRating = rating;
            bestSport = sportId;
          }
        }
        if (!targetTeamId && bestSport) {
          // Join the emptiest team with space.
          const teams = L.teamsFor(kingdomId, bestSport);
          let emptiest = null;
          for (const t of teams) {
            if (t.roster.length >= L.TEAM_SIZE) continue;
            if (!emptiest || t.roster.length < emptiest.roster.length) emptiest = t;
          }
          if (emptiest && L.joinTeam(name, emptiest.id)) {
            targetTeamId = emptiest.id;
            targetSportId = bestSport;
          } else {
            return "success"; // no space anywhere — try later
          }
        }
        if (!targetTeamId) return "success";
      }

      const team = L.teamById(targetTeamId);
      if (!team) return "success";
      const venue = siteTile(player, "market");
      if (!venue) return "success";

      // Walk to the venue.
      const here = playerTile(player);
      if (!arrived && here && dist(here, venue) > VENUE_ARRIVE_RADIUS) {
        try {
          const spot = personalSpot(name, venue.x, venue.y, 3, 10);
          const tgt = spot ?? venue;
          requestMovement(player, tgt.x, tgt.y, { z: tgt.z ?? 0 });
        } catch { /* movement is best-effort */ }
        return "running";
      }
      arrived = true;
      try { clearMovementRequest(player); } catch { /* best-effort */ }

      const now = Date.now();

      // Train with the team (human-paced). A human athlete trains, chats
      // with teammates, and heads home — no endless grinding.
      if (now - lastTrainAt >= TRAIN_COOLDOWN_MS) {
        lastTrainAt = now;
        try {
          // Mood boost from team training (applied via snapshot).
          const st = playerState(player);
          if (st && typeof st === "object") {
            st.teamTrainingAt = now;
          }
        } catch { /* mood is best-effort */ }
        return "running";
      }

      // Trained and socialized — a productive visit. Brain re-decides.
      return "success";
    },
  };
}

module.exports = { createCitizenTeamPlayAction };
