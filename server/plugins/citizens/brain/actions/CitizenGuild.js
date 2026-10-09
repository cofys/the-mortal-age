"use strict";

/**
 * CitizenGuild — visit the guild hall, train, and work guild missions.
 * The RuneScape way: guilds are where professionals gather, train, and
 * earn their rank.
 *
 * Flow per tick:
 *   - Non-members: walk to the nearest guild hall they qualify for and
 *     consider joining (joinGuild handles dues + requirements honestly).
 *   - Members: walk to their guild hall, train (marks the roster record
 *     so the slow tick awards favor), and pick up a mission if none active.
 *   - Done after a productive visit -> "success" (brain re-decides).
 *   - Give up after GIVE_UP_MS so a bad trip never stalls the day.
 *
 * Non-repeat: works one guild visit, then the brain re-decides.
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

// If nothing happens in this long, the hall is empty — move on.
const GIVE_UP_MS = 10 * 60 * 1000;
const HALL_ARRIVE_RADIUS = 4;
// Human pacing between training sessions.
const TRAIN_COOLDOWN_MS = 90000;

function guildsLib() {
  try {
    return require("../../lib/CitizenGuilds");
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

function createCitizenGuildAction(spec, world) {
  const username = usernameOf(spec?.citizen) || spec?.citizen?.username || "guild";
  const rng = agentRng(username);
  const profile = humanizerProfile(username);
  const startedAt = Date.now();
  let lastTrainAt = 0;
  let arrived = false;
  let targetGuildId = null;

  function failFast() {
    return !guildsLib();
  }

  return {
    id: "citizenGuild",
    tick(player, ctx) {
      const st = playerState(player);
      const G = guildsLib();
      if (!G) return "success";
      const name = usernameOf(player) || username;

      // Give up after a bad trip.
      if (Date.now() - startedAt > GIVE_UP_MS) {
        try {
          clearMovementRequest(player);
        } catch {
          // best-effort
        }
        return "success";
      }

      const membership = G.membershipFor(name);
      const kingdomId = kingdomIdOf(player);

      // Pick the hall: own guild's hall, or the first hall the citizen
      // qualifies for (so non-members can go join).
      let hall = null;
      if (membership) {
        targetGuildId = membership.guildId;
        hall = G.hallTile(membership.guildId, kingdomId);
      } else if (!targetGuildId) {
        // Find a guild hall to visit — prefer one we could join.
        for (const id of Object.keys(G.guilds())) {
          const h = G.hallTile(id, kingdomId);
          if (h) {
            targetGuildId = id;
            hall = h;
            break;
          }
        }
      } else {
        hall = G.hallTile(targetGuildId, kingdomId);
      }
      if (!hall) return "success";

      // Walk to the hall.
      const here = playerTile(player);
      if (!arrived && here && dist(here, hall) > HALL_ARRIVE_RADIUS) {
        try {
          const spot = personalSpot(name, hall.x, hall.y, 3, 10);
          const tgt = spot ?? hall;
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

      // Non-members: try to join (dues and requirements are honest).
      if (!membership && targetGuildId) {
        const res = G.joinGuild(name, targetGuildId, player, now);
        if (res.ok) {
          // Joined! Start the signature mission.
          G.startMission(name, now);
          return "success";
        }
        // Can't join (skill too low, broke) — don't retry this visit.
        return "success";
      }

      if (!membership) return "success";

      // Members: pick up a mission if none active.
      if (!G.missionFor(name)) {
        G.startMission(name, now);
      }

      // Train at the hall (human-paced). The slow tick converts recent
      // training into guild favor — real presence, real favor.
      if (now - lastTrainAt > TRAIN_COOLDOWN_MS * (profile?.pace ?? 1)) {
        try {
          const record = ctx?.director?.roster?.get?.(name) ?? null;
          if (record && typeof record === "object") {
            record.guildTrainedAt = now;
            record.guildTrainedGuild = membership.guildId;
          }
        } catch {
          // training mark is best-effort
        }
        lastTrainAt = now;
        // One good session is enough — the brain re-decides.
        return "success";
      }

      return "running";
    },
  };
}

module.exports = { createCitizenGuildAction };
