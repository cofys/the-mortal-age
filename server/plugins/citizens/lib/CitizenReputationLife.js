"use strict";

/**
 * CitizenReputationLife — the slow-tick dynamics for reputation and fame.
 *
 * WHAT IT DOES (director slow tick, data tier, zero LLM):
 *   - Fame decay: scores drift 1 point/day toward 0 (fame fades).
 *   - Crime sync: notorious citizens' negative reputation tracks their
 *     CitizenCrime notoriety (defensive — crime module missing = no-op).
 *   - Skill mastery: online citizens crossing skill level 50/70/99 earn
 *     reputation (real levels, real thresholds, announced once).
 *   - Fame announcements: crossing into famous/legendary (or sinking into
 *     notorious/infamous) is announced once via sayPublic where real
 *     players can hear, and journaled.
 *   - Bard songs: when a bard performs, they may sing of the kingdom's
 *     most famous citizen instead of a generic tune (reads the live
 *     leaderboard, defensive).
 *
 * WHAT IT DOES NOT DO:
 *   - No LLM. Facts are journaled; the chat layer riffs on them.
 *   - Never throws: one bad citizen never breaks the tick.
 */

const HOUR_MS = 3600 * 1000;
const SONG_CHANCE = 0.4; // a bard performance sings of a famous citizen this often
const MASTERY_LEVELS = Object.freeze([50, 70, 99]);

function reputation() {
  try {
    return require("./CitizenReputation");
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

function normalizeNameOf(username) {
  try {
    return require("./CitizenBonds").normalizeName(username);
  } catch {
    return String(username ?? "").toLowerCase().trim();
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

/**
 * Highest combat/skill level across the standard skills. Defensive: reads
 * whatever the player object offers.
 */
function highestSkillLevel(player) {
  try {
    const skills = player?.getSkills?.() ?? player?.skills;
    if (!skills) return 0;
    let best = 0;
    if (typeof skills.getLevel === "function") {
      for (let i = 0; i < 25; i++) {
        try {
          best = Math.max(best, Number(skills.getLevel(i) ?? 0));
        } catch {
          // skip unreadable skill
        }
      }
    } else if (typeof skills === "object") {
      for (const v of Object.values(skills)) {
        const lvl = Number(v?.level ?? v ?? 0);
        if (Number.isFinite(lvl)) best = Math.max(best, lvl);
      }
    }
    return best;
  } catch {
    return 0;
  }
}

function masteryTierForLevel(level) {
  if (level >= 99) return 99;
  if (level >= 70) return 70;
  if (level >= 50) return 50;
  return 0;
}

const CELEBRATED_TIERS = new Set(["famous", "legendary", "notorious", "infamous"]);

/**
 * The slow tick. director = CitizenDirector, nowMs = Date.now().
 * Never throws.
 */
function tickReputation(director, nowMs = Date.now()) {
  const Rep = reputation();
  if (!Rep) return;
  try {
    // 1. Fame fades for everyone.
    try {
      Rep.decayAll(nowMs);
    } catch {
      // decay is best-effort
    }

    const online = onlineCitizens(director);

    for (const { record, username } of online) {
      try {
        // 2. Criminal infamy tracks notoriety.
        try {
          Rep.syncCrimeInfamy(username, nowMs);
        } catch {
          // crime sync is best-effort
        }

        // 3. Skill mastery earns renown (real levels, once per threshold).
        try {
          const bot = director?.getBot?.(record) ?? null;
          const level = highestSkillLevel(bot ?? record);
          const tier = masteryTierForLevel(level);
          if (tier > 0) {
            const key = `mastery:${tier}`;
            const seen = record?.reputationMasterySeen ?? {};
            if (!seen[key]) {
              Rep.awardDeed(username, "skill_mastery", nowMs);
              try {
                if (record && typeof record === "object") {
                  record.reputationMasterySeen = { ...seen, [key]: true };
                }
              } catch {
                // roster record not writable — the deed still landed
              }
              const j = journal();
              try {
                j?.record?.("reputation_mastery", { citizen: username, level: tier, at: nowMs });
              } catch {
                // journal is best-effort
              }
            }
          }
        } catch {
          // mastery check is best-effort
        }

        // 4. Fame-tier crossings get announced once, where players can hear.
        try {
          const tier = Rep.fameTierFor(username);
          const announced = Rep.announcedTierFor(username);
          if (tier !== announced && CELEBRATED_TIERS.has(tier)) {
            Rep.markTierAnnounced(username, tier);
            const bot = director?.getBot?.(record) ?? null;
            if (bot && anyRealPlayerNear(director, bot, 25)) {
              const label = Rep.tierLabel(tier);
              const rise = tier === "famous" || tier === "legendary";
              sayPublicTo(
                director,
                username,
                rise
                  ? `Word spreads through the streets: ${username} is ${label}! Songs will be sung of this one.`
                  : `Word spreads through the streets: ${username} has become ${label}. Best keep your distance.`
              );
            }
            const j = journal();
            try {
              j?.record?.("reputation_tier", { citizen: username, tier, at: nowMs });
            } catch {
              // journal is best-effort
            }
          } else if (tier !== announced) {
            // Quiet tiers still update the watermark so we don't re-check.
            Rep.markTierAnnounced(username, tier);
          }
        } catch {
          // announcements are best-effort
        }
      } catch {
        // one bad citizen never breaks the tick
      }
    }

    // 5. Bard songs of the famous. Bards are picked up in the entertainment
    // tick; here we give the reputation layer a voice when a bard performs.
    try {
      maybeBardSong(director, nowMs);
    } catch {
      // songs are best-effort
    }

    // 6. Persist.
    try {
      Rep.save();
    } catch {
      // save is best-effort
    }
  } catch {
    // the whole tick never throws
  }
}

/**
 * After a bard performance, the bard may sing of the kingdom's most famous
 * citizen. Called from the reputation tick (cheap) and exposed so the
 * entertainment tick can call it right after a performance.
 */
function maybeBardSong(director, nowMs = Date.now()) {
  const Rep = reputation();
  if (!Rep || Math.random() >= SONG_CHANCE) return false;
  let Entertain = null;
  try {
    Entertain = require("./CitizenEntertainment");
  } catch {
    return false;
  }
  const online = onlineCitizens(director);
  // Find a bard who performed recently (within the last hour).
  const bards = online.filter(({ record, username }) => {
    try {
      const career = record?.career ?? record?.job ?? "";
      if (!/bard/i.test(String(career))) return false;
      const last = Entertain.lastPerformanceAt?.(username) ?? 0;
      return nowMs - last < HOUR_MS;
    } catch {
      return false;
    }
  });
  if (!bards.length) return false;
  const board = Rep.topFamous(3);
  if (!board.length) return false;
  // Don't sing about the bard themselves when there's a choice.
  const bardNames = new Set(bards.map(({ username }) => normalizeNameOf(username)));
  const subject = board.find((r) => !bardNames.has(normalizeNameOf(r.username))) ?? board[0];
  const { username: bardName } = bards[Math.floor(Math.random() * bards.length)];
  const bot = director?.getBot?.(bards[0].record) ?? null;
  if (bot && !anyRealPlayerNear(director, bot, 25)) return false;
  const tierWord = Rep.tierLabel(subject.tier);
  sayPublicTo(
    director,
    bardName,
    `${bardName} sings a ballad of ${subject.username}, the ${tierWord} hero of the realm!`
  );
  const j = journal();
  try {
    j?.record?.("bard_song", { bard: bardName, subject: subject.username, tier: subject.tier, at: nowMs });
  } catch {
    // journal is best-effort
  }
  return true;
}

module.exports = { tickReputation, maybeBardSong };
