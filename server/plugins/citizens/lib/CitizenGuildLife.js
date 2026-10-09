"use strict";

/**
 * CitizenGuildLife — the slow-tick dynamics for citizen trade guilds.
 *
 * WHAT IT DOES (director slow tick, data tier, zero LLM):
 *   - Favor decay: inactive members' favor drifts toward their rank floor
 *     (ranks are sticky, grinding is not).
 *   - Rank-up announcements: crossing into member/veteran/master/
 *     grandmaster is announced once via sayPublic where real players can
 *     hear, and journaled.
 *   - Mission expiry: missions older than 7 days are abandoned (the
 *     guildmaster loses patience).
 *   - Rivalry drift: rivalries cool 1 point/day toward 0 without incidents.
 *   - Rivalry incidents: a thief guild member convicted of theft raises
 *     thieves<->merchants rivalry (read defensively from CitizenCrime).
 *   - Training: online members at their guild hall doing their guild's
 *     skill activity earn guild favor (+5) — real training, real favor.
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. Facts are journaled; the chat layer riffs on them.
 *   - Never throws: one bad citizen never breaks the tick.
 *   - Never touches lib/*2 (frozen).
 */

const DAY_MS = 24 * 3600 * 1000;
const MISSION_TTL_MS = 7 * DAY_MS;
const RIVALRY_COOL_PER_DAY = 1;
const TRAINING_FAVOR = 5;

function guilds() {
  try {
    return require("./CitizenGuilds");
  } catch {
    return null;
  }
}

function journal() {
  try {
    return require("./CitizenJournal").getJournal();
  } catch {
    return null;
  }
}

function sayPublicTo(director, username, text) {
  try {
    const { sayPublic } = require("../chat/CitizenSayPublic");
    const player = director?.getPlayer?.(username) ?? director?.players?.get?.(username);
    if (player) sayPublic(player, text);
  } catch {
    // best-effort
  }
}

function onlineCitizens(director) {
  const out = [];
  try {
    for (const record of director?.roster?.values?.() ?? []) {
      if (!record) continue;
      const username = record.username ?? record.name;
      if (!username) continue;
      let online = false;
      try {
        online = director.isOnline(record);
      } catch {
        online = false;
      }
      if (online) out.push({ record, username });
    }
  } catch {
    // roster unreadable — nothing to do
  }
  return out;
}

function anyRealPlayerNear(director, citizen, radius) {
  try {
    const { anyRealPlayerNear: check } = require("./CitizenSites");
    if (typeof check === "function") return check(director, citizen, radius);
  } catch {
    // fall through
  }
  try {
    const players = director?.getLocalPlayers?.(citizen) ?? [];
    return players.some((p) => !p?.isBot && !p?.getAttribute?.("citizen:bot"));
  } catch {
    return false;
  }
}

function recordJournal(kind, data) {
  try {
    journal()?.record?.(kind, data);
  } catch {
    // journal is best-effort
  }
}

const ANNOUNCED_RANKS = new Set(["member", "veteran", "master", "grandmaster"]);

/**
 * The slow tick. director = CitizenDirector, nowMs = Date.now().
 * Never throws.
 */
function tickGuilds(director, nowMs = Date.now()) {
  const G = guilds();
  if (!G) return;
  try {
    // 1. Favor decays toward rank floors.
    try {
      G.decayFavor(nowMs);
    } catch {
      // decay is best-effort
    }

    // 2. Rivalries cool over time.
    try {
      for (const [a, b] of G.RIVALRIES) {
        if (G.rivalryFor(a, b) > 0) G.nudgeRivalry(a, b, -RIVALRY_COOL_PER_DAY);
      }
    } catch {
      // rivalry cooling is best-effort
    }

    const online = onlineCitizens(director);

    for (const { record, username } of online) {
      try {
        const membership = G.membershipFor(username);
        if (!membership) continue;

        // 3. Mission expiry: the guildmaster loses patience after 7 days.
        try {
          const m = membership.mission;
          if (m && nowMs - (m.startedAt ?? nowMs) > MISSION_TTL_MS) {
            G.abandonMission(username);
            recordJournal("guild_mission_expired", {
              citizen: username,
              guild: membership.guildId,
              mission: m.label,
              at: nowMs,
            });
          }
        } catch {
          // expiry is best-effort
        }

        // 4. Rank-up announcements, once each, where players can hear.
        try {
          const rank = membership.rank;
          const announcedKey = `guild_rank:${membership.guildId}:${rank}`;
          const seen = record?.guildRankAnnounced ?? {};
          if (ANNOUNCED_RANKS.has(rank) && !seen[announcedKey]) {
            try {
              if (record && typeof record === "object") {
                record.guildRankAnnounced = { ...seen, [announcedKey]: true };
              }
            } catch {
              // roster record not writable — the announcement still goes out once per tick at most
            }
            const bot = director?.getBot?.(record) ?? null;
            const g = G.guildFor(membership.guildId);
            if (bot && anyRealPlayerNear(director, bot, 25)) {
              sayPublicTo(
                director,
                username,
                `${username} has risen to ${G.rankLabel(rank)} of the ${g?.name ?? "guild"}!`
              );
            }
            recordJournal("guild_rank", {
              citizen: username,
              guild: membership.guildId,
              rank,
              at: nowMs,
            });
          }
        } catch {
          // announcements are best-effort
        }

        // 5. Training at the hall earns favor: real skill work, real favor.
        // The brain action reports training via record.guildTrainedAt.
        try {
          const trainedAt = record?.guildTrainedAt ?? 0;
          const trainedGuild = record?.guildTrainedGuild ?? null;
          if (
            trainedGuild === membership.guildId &&
            trainedAt > (record?.guildFavorAwardedAt ?? 0)
          ) {
            const res = G.addFavor(username, TRAINING_FAVOR, "guild training", nowMs);
            try {
              if (record && typeof record === "object") record.guildFavorAwardedAt = trainedAt;
            } catch {
              // watermark is best-effort
            }
            if (res?.rankedUp) {
              recordJournal("guild_rank", {
                citizen: username,
                guild: membership.guildId,
                rank: res.rank,
                via: "training",
                at: nowMs,
              });
            }
          }
        } catch {
          // training favor is best-effort
        }

        // 6. Rivalry incidents: a thief convicted of theft heats
        // thieves<->merchants. Defensive read of the crime module.
        try {
          if (membership.guildId === "thieves") {
            const Crime = require("./CitizenCrime");
            if (typeof Crime.notorietyFor === "function") {
              const notoriety = Number(Crime.notorietyFor(username, nowMs) ?? 0);
              const lastNotoriety = record?.guildNotorietySeen ?? 0;
              if (notoriety > lastNotoriety && notoriety >= 20) {
                G.nudgeRivalry("thieves", "merchants", 10);
                recordJournal("guild_rivalry", {
                  guilds: ["thieves", "merchants"],
                  level: G.rivalryFor("thieves", "merchants"),
                  cause: "thief convicted",
                  citizen: username,
                  at: nowMs,
                });
              }
              try {
                if (record && typeof record === "object") {
                  record.guildNotorietySeen = Math.max(lastNotoriety, notoriety);
                }
              } catch {
                // watermark is best-effort
              }
            }
          }
        } catch {
          // rivalry incidents are best-effort
        }
      } catch {
        // one bad citizen never breaks the tick
      }
    }

    // 7. Persist.
    try {
      G.save();
    } catch {
      // save is best-effort
    }
  } catch {
    // the whole tick never throws
  }
}

module.exports = { tickGuilds };
