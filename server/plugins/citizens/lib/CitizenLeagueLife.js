"use strict";

/**
 * CitizenLeagueLife — the slow-tick dynamics for real citizen team leagues.
 *
 * WHAT IT DOES (called from the director slow tick, never throws):
 *   - Appoints a league organizer per kingdom when none is set (picks a
 *     reputable, social citizen from the real roster — defensive: skips
 *     when the roster is unavailable).
 *   - Resolves due fixtures: for each kingdom+sport with fixtures whose
 *     week has arrived, resolves the match by real team ratings, records
 *     the result, and journals it.
 *   - Awards championships when a season's fixtures are all played: the
 *     top team takes the trophy, earns `league_champion` fame deeds for
 *     its roster, and the win is announced near real players.
 *   - Announces big match days near real players (derbies between the top
 *     two teams), journaled, cooldown-gated.
 *   - Fan mood: fans of a winning team get a mood bump the tick after a
 *     win (applied via the snapshot mood bonus in CitizenDecisions —
 *     this module only records the last-win tick per team).
 *
 * NO OVERLAP: CitizenSports owns hash-derived spectator fixtures;
 * CitizenTournamentLife owns individual tournament brackets. This module
 * owns real team-league seasons only.
 *
 * Zero LLM. Never throws. Never touches lib/*2 (frozen).
 */

const Leagues = require("./CitizenLeagues");
const { normalizeName } = require("./CitizenBonds");
const { sayPublic } = require("../chat/CitizenSayPublic");

const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // one league announcement per 6h per kingdom
const lastAnnounceByKingdom = new Map(); // kingdomId -> timestamp

function tickLeagues(director, nowMs = Date.now()) {
  try {
    const kingdoms = kingdomIds(director);
    for (const kingdomId of kingdoms) {
      try {
        ensureOrganizer(director, kingdomId);
        for (const sportId of Object.keys(Leagues.TEAM_SPORTS)) {
          try {
            resolveDueFixtures(director, kingdomId, sportId, nowMs);
            maybeAwardChampionship(director, kingdomId, sportId, nowMs);
          } catch { /* one sport never breaks the tick */ }
        }
        maybeAnnounce(director, kingdomId, nowMs);
      } catch { /* one kingdom never breaks the tick */ }
    }
  } catch { /* never throws */ }
}

/** Kingdom ids from the director roster (defensive). */
function kingdomIds(director) {
  const out = new Set();
  try {
    const roster = director?.roster;
    const values = typeof roster?.values === "function" ? roster.values() : [];
    for (const record of values) {
      if (record?.kingdomId) out.add(record.kingdomId);
    }
  } catch { /* empty */ }
  // Always cover the known kingdoms so leagues exist even with a thin roster.
  for (const k of Object.keys(kingdomNames())) out.add(k);
  return [...out];
}

function kingdomNames() {
  return {
    misthalin: 1, asgarnia: 1, kandarin: 1, morytania: 1, keldagrim: 1,
  };
}

/**
 * Appoint a league organizer when the kingdom has none. Picks the
 * highest-reputation social citizen on the roster (defensive: skips
 * when reputation or roster data is unavailable).
 */
function ensureOrganizer(director, kingdomId) {
  try {
    if (Leagues.organizerFor(kingdomId)) return;
    let best = null;
    let bestScore = -1;
    const roster = director?.roster;
    const values = typeof roster?.values === "function" ? roster.values() : [];
    for (const record of values) {
      try {
        if (record?.kingdomId !== kingdomId) continue;
        const rep = reputationOf(record);
        const social = socialOf(record);
        const score = rep + social;
        if (score > bestScore) {
          bestScore = score;
          best = record.username;
        }
      } catch { /* skip bad records */ }
    }
    if (best && bestScore >= 20) {
      Leagues.appointOrganizer(kingdomId, best);
      journal(director, kingdomId, "league_organizer", {
        organizer: best,
        kingdomId,
      });
    }
  } catch { /* never throws */ }
}

function reputationOf(record) {
  try {
    const Rep = require("./CitizenReputation");
    const rep = Rep.reputationOf?.(record.username);
    return typeof rep?.score === "number" ? rep.score : 0;
  } catch {
    return 0;
  }
}

function socialOf(record) {
  try {
    const p = record?.personality ?? {};
    return (p.sociable ?? p.social ?? p.extrovert ?? 0.5) * 100;
  } catch {
    return 50;
  }
}

/**
 * Resolve every due fixture for a kingdom+sport. Team ratings come from
 * REAL member skill levels via the engine-backed level reader.
 */
function resolveDueFixtures(director, kingdomId, sportId, nowMs) {
  const due = Leagues.dueFixtures(kingdomId, sportId, nowMs);
  if (!due.length) return;
  const levelReader = makeLevelReader(director);
  for (const fixture of due) {
    try {
      const home = Leagues.teamById(fixture.homeId);
      const away = Leagues.teamById(fixture.awayId);
      if (!home || !away) continue;
      const seed = fixtureSeed(fixture);
      const { homeScore, awayScore } = Leagues.resolveFixture(home, away, levelReader, seed);
      Leagues.recordResult(kingdomId, sportId, fixture.homeId, fixture.awayId, homeScore, awayScore);
      journal(director, kingdomId, "league_result", {
        sport: sportId,
        home: home.name,
        away: away.name,
        homeScore,
        awayScore,
      });
      // Fans of the winner get a mood bump (recorded on the team; the
      // decision snapshot reads it).
      if (homeScore !== awayScore) {
        recordFanWin(homeScore > awayScore ? home.id : away.id, nowMs);
      }
    } catch { /* one fixture never breaks the tick */ }
  }
}

/** Deterministic seed from fixture ids + week (stable across restarts). */
function fixtureSeed(fixture) {
  let h = 0;
  const s = `${fixture.homeId}|${fixture.awayId}|${fixture.week}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Build a level reader backed by the real engine. Falls back to null
 * (teamRating treats missing levels as the honest floor of 1).
 */
function makeLevelReader(director) {
  return (username, skill) => {
    try {
      const bot = director?.getBot?.({ username });
      const lvl = bot?.skills?.[skill]?.level ?? bot?.getLevel?.(skill);
      return typeof lvl === "number" && lvl >= 1 ? lvl : 1;
    } catch {
      return 1;
    }
  };
}

/** Record when a team last won, for the fan mood bump. */
const lastWinByTeam = new Map(); // teamId -> timestamp

function recordFanWin(teamId, nowMs) {
  lastWinByTeam.set(teamId, nowMs);
}

/** Ticks since the fan's team last won (for the decision snapshot). */
function fanWinRecency(teamId, nowMs = Date.now()) {
  const t = lastWinByTeam.get(teamId);
  if (!t) return Infinity;
  return nowMs - t;
}

/**
 * Award the championship when the season is complete. The champion roster
 * earns real fame deeds; the win is announced near real players.
 */
function maybeAwardChampionship(director, kingdomId, sportId, nowMs) {
  const champion = Leagues.awardChampionship(kingdomId, sportId);
  if (!champion) return;
  try {
    const Rep = require("./CitizenReputation");
    for (const member of champion.roster) {
      try {
        Rep.awardDeed?.(member, "league_champion", nowMs);
      } catch { /* one deed never breaks the tick */ }
    }
  } catch { /* reputation unavailable — skip deeds */ }
  journal(director, kingdomId, "league_champions", {
    sport: sportId,
    team: champion.name,
    trophies: champion.trophies,
  });
  announceNearPlayers(director, kingdomId,
    `${champion.name} are the ${labelFor(sportId)} champions!`);
}

/** Announce the week's big derby near real players (cooldown-gated). */
function maybeAnnounce(director, kingdomId, nowMs) {
  try {
    const last = lastAnnounceByKingdom.get(kingdomId) || 0;
    if (nowMs - last < ANNOUNCE_COOLDOWN_MS) return;
    // Find the most interesting upcoming fixture: top-two derby.
    let best = null;
    for (const sportId of Object.keys(Leagues.TEAM_SPORTS)) {
      const table = Leagues.standings(kingdomId, sportId);
      if (table.length >= 2) {
        const [first, second] = table;
        if (!best || first.table.pts + second.table.pts > best.pts) {
          best = {
            sportId,
            home: first.team.name,
            away: second.team.name,
            pts: first.table.pts + second.table.pts,
          };
        }
      }
    }
    if (!best) return;
    lastAnnounceByKingdom.set(kingdomId, nowMs);
    announceNearPlayers(director, kingdomId,
      `Big match this week: ${best.home} vs ${best.away} in ${labelFor(best.sportId)}!`);
    journal(director, kingdomId, "league_derby", best);
  } catch { /* never throws */ }
}

function labelFor(sportId) {
  return Leagues.TEAM_SPORTS[sportId]?.label ?? sportId;
}

/**
 * Say something near real players via the first online roster bot in the
 * kingdom (defensive: silently skips when nobody is around).
 */
function announceNearPlayers(director, kingdomId, text) {
  try {
    const roster = director?.roster;
    const values = typeof roster?.values === "function" ? roster.values() : [];
    for (const record of values) {
      try {
        if (record?.kingdomId !== kingdomId) continue;
        if (!director.isOnline?.(record)) continue;
        const bot = director.getBot?.(record);
        if (!bot) continue;
        sayPublic(bot, text);
        return;
      } catch { /* try the next citizen */ }
    }
  } catch { /* silent */ }
}

function journal(director, kingdomId, kind, data) {
  try {
    const journal = director?.getJournal?.();
    journal?.log?.(`citizens:league:${kind}`, { kingdomId, ...data });
  } catch { /* journal unavailable */ }
}

module.exports = {
  tickLeagues,
  fanWinRecency,
  // test seams
  _resetAnnounceForTests() { lastAnnounceByKingdom.clear(); },
  _resetWinsForTests() { lastWinByTeam.clear(); },
};
