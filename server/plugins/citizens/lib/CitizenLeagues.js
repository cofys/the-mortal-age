"use strict";

/**
 * CitizenLeagues — the data tier for REAL persistent citizen team-sports leagues.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Team sports: football (5v5, attack/strength/defence), tug-of-war
 *     (team strength), relay races (team agility). Team ratings come from
 *     REAL member skill levels — never invented.
 *   - Persistent teams: 4 per kingdom per sport, named deterministically
 *     (e.g. "Varrock Vanguard"). Real rosters: citizens join/leave, real
 *     players can form their own teams or join citizen teams.
 *   - League organizers: citizens appointed per kingdom who schedule the
 *     season, resolve fixtures, and run the championship.
 *   - Seasons: 8-week round-robin schedules with real fixtures. Standings
 *     track wins/losses/draws and points (3 for a win, 1 for a draw).
 *     Top two teams contest the championship final; the winners take a
 *     real trophy record plus fame deeds.
 *   - Fan clubs: persistent memberships per team. Fans get a mood boost
 *     when their team wins a match they "attend".
 *   - Team merchandise: scarves and banners sold for REAL coins at the
 *     market stall; 70% to the team fund, 30% to the seller.
 *   - Match tickets: championship finals sell tickets (10 coins, real).
 *     Gate receipts split 50/50 between the two finalist team funds.
 *   - Team funds: persistent per-team coin pools funding entry fees and
 *     collecting merchandise/ticket shares. Never negative, never invented.
 *
 * NO OVERLAP (documented, following the codebase convention):
 *   - CitizenSports owns the HASH-DERIVED spectator layer: fixtures derived
 *     from week+kingdom hashes, zero storage, citizens watch and cheer.
 *   - CitizenTournaments owns PARTICIPATORY INDIVIDUAL tournaments:
 *     single-elimination brackets, citizens enter and compete alone.
 *   - CitizenFestivalGames owns one-off festival competitions.
 *   - THIS module owns REAL persistent TEAM leagues: real rosters, real
 *     results, real standings, real seasons, real trophies, organizers,
 *     fan clubs, merchandise, and player teams.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Season scheduling, fixture resolution, standings,
 *     finals, and announcements live in lib/CitizenLeagueLife.js.
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented money: every coin moved is real, or nothing happens.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-leagues.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-leagues.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const TEAMS_PER_KINGDOM_SPORT = 4; // teams per kingdom per sport
const SEASON_WEEKS = 8; // a season lasts 8 weeks
const TEAM_SIZE = 5; // players per team roster (citizens + real players)
const WIN_POINTS = 3;
const DRAW_POINTS = 1;
const REGISTRATION_FEE = 100; // coins per team per season (real, to league fund)
const FINAL_TICKET_PRICE = 10; // coins per championship ticket (real)
const MERCH_SCARF_PRICE = 15; // coins (real)
const MERCH_BANNER_PRICE = 40; // coins (real)
const MERCH_TEAM_SHARE = 0.7; // 70% of merch sale -> team fund
const TROPHY_LABEL = "League Champions Trophy";

// Team sports. ratingSkills resolve team strength from REAL member levels.
// kind "strength" sums strength levels; "agility" sums agility; "combat"
// sums attack+strength+defence.
const TEAM_SPORTS = Object.freeze({
  football: Object.freeze({
    id: "football", label: "Football", kind: "combat",
    skills: Object.freeze(["attack", "strength", "defence"]),
    venueName: "Sports Field",
  }),
  tugofwar: Object.freeze({
    id: "tugofwar", label: "Tug-of-War", kind: "strength",
    skills: Object.freeze(["strength"]),
    venueName: "Tug Field",
  }),
  relay: Object.freeze({
    id: "relay", label: "Relay Race", kind: "agility",
    skills: Object.freeze(["agility"]),
    venueName: "Race Track",
  }),
});

const KINGDOM_NAMES = Object.freeze({
  misthalin: "Misthalin",
  asgarnia: "Asgarnia",
  kandarin: "Kandarin",
  morytania: "Morytania",
  keldagrim: "Keldagrim",
});

const TEAM_NAME_PARTS = Object.freeze([
  "Vanguard", "Falcons", "Titans", "Wolves", "Dragons", "Lions",
  "Hawks", "Bears", "Stags", "Ravens", "Boars", "Sharks",
]);

// --- state -------------------------------------------------------------------

let cache = null; // { teams: {...}, seasons: {...}, organizers: {...}, fans: {...} }
let dirty = false;

function blankState() {
  return {
    teams: Object.create(null),      // teamId -> team record
    seasons: Object.create(null),    // "kingdomId:sportId" -> season record
    organizers: Object.create(null), // kingdomId -> organizer username
    fans: Object.create(null),       // normalized username -> teamId
  };
}

function state() {
  if (!cache) cache = load();
  return cache;
}

function load() {
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const s = blankState();
      if (parsed.teams && typeof parsed.teams === "object") s.teams = parsed.teams;
      if (parsed.seasons && typeof parsed.seasons === "object") s.seasons = parsed.seasons;
      if (parsed.organizers && typeof parsed.organizers === "object") s.organizers = parsed.organizers;
      if (parsed.fans && typeof parsed.fans === "object") s.fans = parsed.fans;
      return s;
    }
  } catch { /* missing or corrupt — start blank */ }
  return blankState();
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2), "utf8");
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

/** Test seam — drop the in-memory cache so the next read reloads from disk. */
function resetForTests() {
  cache = null;
  dirty = false;
}

// --- teams -------------------------------------------------------------------

function teamIdFor(kingdomId, sportId, index) {
  return `${kingdomId}:${sportId}:team${index}`;
}

function teamNameFor(kingdomId, sportId, index) {
  const kName = KINGDOM_NAMES[kingdomId] ?? kingdomId;
  const part = TEAM_NAME_PARTS[(index * 3 + sportId.length) % TEAM_NAME_PARTS.length];
  return `${kName} ${part}`;
}

/**
 * Get or create the 4 persistent teams for a kingdom+sport.
 * Returns an array of team records. Deterministic — stable across restarts.
 */
function teamsFor(kingdomId, sportId) {
  const s = state();
  const out = [];
  for (let i = 0; i < TEAMS_PER_KINGDOM_SPORT; i++) {
    const id = teamIdFor(kingdomId, sportId, i);
    if (!s.teams[id]) {
      s.teams[id] = {
        id,
        name: teamNameFor(kingdomId, sportId, i),
        kingdomId,
        sportId,
        roster: [], // normalized citizen usernames
        playerRoster: [], // real player usernames (display names)
        fund: 0, // real coins accumulated
        wins: 0, losses: 0, draws: 0, points: 0,
        trophies: 0,
        foundedAt: Date.now(),
      };
      markDirty();
    }
    out.push(s.teams[id]);
  }
  return out;
}

function teamById(teamId) {
  return state().teams[teamId] ?? null;
}

/**
 * A citizen joins a team roster. Returns true if joined (or already on it).
 * Rosters cap at TEAM_SIZE citizens; players have their own roster list.
 */
function joinTeam(username, teamId) {
  const s = state();
  const team = s.teams[teamId];
  if (!team) return false;
  const norm = normalizeName(username);
  if (team.roster.includes(norm)) return true;
  if (team.roster.length >= TEAM_SIZE) return false;
  // Leave any other team in the same sport first (one team per sport).
  for (const t of Object.values(s.teams)) {
    if (t.sportId === team.sportId && t.kingdomId === team.kingdomId) {
      const idx = t.roster.indexOf(norm);
      if (idx >= 0) { t.roster.splice(idx, 1); markDirty(); }
    }
  }
  team.roster.push(norm);
  markDirty();
  return true;
}

function leaveTeam(username, teamId) {
  const s = state();
  const team = s.teams[teamId];
  if (!team) return false;
  const idx = team.roster.indexOf(normalizeName(username));
  if (idx < 0) return false;
  team.roster.splice(idx, 1);
  markDirty();
  return true;
}

/** The team a citizen currently plays for in a sport (or null). */
function teamOf(username, kingdomId, sportId) {
  const norm = normalizeName(username);
  for (const t of teamsFor(kingdomId, sportId)) {
    if (t.roster.includes(norm)) return t;
  }
  return null;
}

/**
 * A real player joins a citizen team (player roster, separate cap).
 * Returns true on success.
 */
function playerJoinTeam(playerName, teamId) {
  const s = state();
  const team = s.teams[teamId];
  if (!team) return false;
  if (team.playerRoster.includes(playerName)) return true;
  if (team.playerRoster.length >= TEAM_SIZE) return false;
  team.playerRoster.push(playerName);
  markDirty();
  return true;
}

/**
 * Team rating from REAL member skill levels. The caller supplies a
 * levelReader(username, skillName) -> level function backed by the real
 * engine. Citizens without readable levels count as level 1 (honest
 * floor, never invented).
 */
function teamRating(team, levelReader) {
  const sport = TEAM_SPORTS[team.sportId];
  if (!sport) return 0;
  let total = 0;
  for (const member of team.roster) {
    for (const skill of sport.skills) {
      let lvl = 1;
      try {
        const v = levelReader ? levelReader(member, skill) : 1;
        if (typeof v === "number" && v >= 1) lvl = v;
      } catch { /* honest floor */ }
      total += lvl;
    }
  }
  return total;
}

// --- organizers --------------------------------------------------------------

/**
 * Appoint (or read) the league organizer for a kingdom. Organizers run
 * seasons: they schedule fixtures and resolve matches on the slow tick.
 */
function organizerFor(kingdomId) {
  return state().organizers[kingdomId] ?? null;
}

function appointOrganizer(kingdomId, username) {
  state().organizers[normalizeName(kingdomId)] = normalizeName(username);
  // NOTE: kingdomId keys are stored raw; normalize only the username.
  state().organizers[kingdomId] = normalizeName(username);
  delete state().organizers[normalizeName(kingdomId)];
  markDirty();
}

// --- seasons -----------------------------------------------------------------

function seasonKey(kingdomId, sportId) {
  return `${kingdomId}:${sportId}`;
}

/**
 * Get or create the current season for a kingdom+sport. A season holds
 * the round-robin fixture list and per-team standings for that season.
 */
function seasonFor(kingdomId, sportId, nowMs = Date.now()) {
  const s = state();
  const key = seasonKey(kingdomId, sportId);
  let season = s.seasons[key];
  const seasonStart = seasonStartFor(nowMs);
  if (!season || season.seasonStart !== seasonStart) {
    const teams = teamsFor(kingdomId, sportId);
    season = {
      key,
      kingdomId,
      sportId,
      seasonStart,
      fixtures: buildFixtures(teams, seasonStart),
      standings: Object.create(null), // teamId -> { w, l, d, pts }
      finalPlayed: false,
      championTeamId: null,
    };
    for (const t of teams) {
      season.standings[t.id] = { w: 0, l: 0, d: 0, pts: 0 };
      // Reset persistent season tallies on the team records too.
      t.wins = 0; t.losses = 0; t.draws = 0; t.points = 0;
    }
    s.seasons[key] = season;
    markDirty();
  }
  return season;
}

/** Seasons align to 8-week blocks from the unix epoch (deterministic). */
function seasonStartFor(nowMs) {
  const SEASON_MS = SEASON_WEEKS * 7 * 24 * 60 * 60 * 1000;
  return Math.floor(nowMs / SEASON_MS) * SEASON_MS;
}

/**
 * Round-robin fixtures: every team plays every other team once.
 * Fixtures spread one per week across the season. Deterministic order.
 */
function buildFixtures(teams, seasonStart) {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const fixtures = [];
  let week = 0;
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      fixtures.push({
        homeId: teams[i].id,
        awayId: teams[j].id,
        week,
        scheduledAt: seasonStart + week * WEEK_MS,
        played: false,
        homeScore: 0,
        awayScore: 0,
      });
      week = (week + 1) % SEASON_WEEKS;
    }
  }
  return fixtures;
}

/** Fixtures whose week has arrived and which have not been played yet. */
function dueFixtures(kingdomId, sportId, nowMs = Date.now()) {
  const season = seasonFor(kingdomId, sportId, nowMs);
  return season.fixtures.filter((f) => !f.played && f.scheduledAt <= nowMs);
}

/**
 * Record a played fixture result. Updates season standings and the
 * persistent team tallies. Scores are non-negative integers.
 */
function recordResult(kingdomId, sportId, homeId, awayId, homeScore, awayScore) {
  const s = state();
  const season = seasonFor(kingdomId, sportId);
  const fixture = season.fixtures.find(
    (f) => f.homeId === homeId && f.awayId === awayId && !f.played
  );
  if (!fixture) return false;
  fixture.played = true;
  fixture.homeScore = Math.max(0, Math.floor(homeScore));
  fixture.awayScore = Math.max(0, Math.floor(awayScore));

  const home = s.teams[homeId];
  const away = s.teams[awayId];
  const hs = season.standings[homeId];
  const as = season.standings[awayId];
  if (fixture.homeScore > fixture.awayScore) {
    hs.w++; hs.pts += WIN_POINTS;
    as.l++;
    if (home) { home.wins++; home.points += WIN_POINTS; }
    if (away) away.losses++;
  } else if (fixture.homeScore < fixture.awayScore) {
    as.w++; as.pts += WIN_POINTS;
    hs.l++;
    if (away) { away.wins++; away.points += WIN_POINTS; }
    if (home) home.losses++;
  } else {
    hs.d++; hs.pts += DRAW_POINTS;
    as.d++; as.pts += DRAW_POINTS;
    if (home) { home.draws++; home.points += DRAW_POINTS; }
    if (away) { away.draws++; away.points += DRAW_POINTS; }
  }
  markDirty();
  return true;
}

/** Standings sorted by points desc, then wins desc. Returns team records. */
function standings(kingdomId, sportId) {
  const season = seasonFor(kingdomId, sportId);
  const teams = teamsFor(kingdomId, sportId);
  return teams
    .map((t) => ({ team: t, table: season.standings[t.id] ?? { w: 0, l: 0, d: 0, pts: 0 } }))
    .sort((a, b) => b.table.pts - a.table.pts || b.table.w - a.table.w);
}

/**
 * Resolve a fixture between two teams by rating. Higher rating wins;
 * close ratings can draw. Deterministic given the same ratings and a
 * seed (no Math.random in the data tier — the Life module supplies a
 * seeded roll). Returns { homeScore, awayScore }.
 */
function resolveFixture(homeTeam, awayTeam, levelReader, seed = 0) {
  const hr = teamRating(homeTeam, levelReader);
  const ar = teamRating(awayTeam, levelReader);
  // Seeded pseudo-random from the fixture seed (deterministic).
  const roll = seededRoll(seed);
  const diff = hr - ar;
  if (Math.abs(diff) < Math.max(4, (hr + ar) * 0.05) && roll < 0.25) {
    const s = 1 + Math.floor(roll * 4) % 3;
    return { homeScore: s, awayScore: s };
  }
  if (diff >= 0) {
    return { homeScore: 2 + Math.floor(roll * 3), awayScore: Math.floor(roll * 2) };
  }
  return { homeScore: Math.floor(roll * 2), awayScore: 2 + Math.floor(roll * 3) };
}

function seededRoll(seed) {
  let x = (seed * 2654435761) >>> 0;
  x ^= x >>> 15; x = (x * 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/**
 * Award the championship to the top team once all fixtures are played.
 * Returns the champion team record, or null if the season is incomplete
 * or the final was already played.
 */
function awardChampionship(kingdomId, sportId) {
  const s = state();
  const season = seasonFor(kingdomId, sportId);
  if (season.finalPlayed) return null;
  if (season.fixtures.some((f) => !f.played)) return null;
  const table = standings(kingdomId, sportId);
  if (!table.length) return null;
  const champion = table[0].team;
  champion.trophies++;
  season.finalPlayed = true;
  season.championTeamId = champion.id;
  markDirty();
  return champion;
}

// --- fan clubs ---------------------------------------------------------------

/** A citizen becomes a fan of a team. One team per citizen (latest wins). */
function joinFanClub(username, teamId) {
  const s = state();
  if (!s.teams[teamId]) return false;
  s.fans[normalizeName(username)] = teamId;
  markDirty();
  return true;
}

function fanTeamOf(username) {
  const teamId = state().fans[normalizeName(username)];
  return teamId ? teamById(teamId) : null;
}

function fanCount(teamId) {
  const s = state();
  let n = 0;
  for (const tid of Object.values(s.fans)) {
    if (tid === teamId) n++;
  }
  return n;
}

// --- economy: funds, merchandise, tickets ------------------------------------

/**
 * Credit real coins to a team fund. Amount must be positive; returns the
 * new fund balance. All coin movement is validated by the caller — this
 * only tracks the ledger.
 */
function creditFund(teamId, amount) {
  const team = teamById(teamId);
  if (!team || !(amount > 0)) return team ? team.fund : 0;
  team.fund += Math.floor(amount);
  markDirty();
  return team.fund;
}

/** Debit real coins from a team fund. Fails honestly when insufficient. */
function debitFund(teamId, amount) {
  const team = teamById(teamId);
  if (!team || !(amount > 0)) return false;
  const cost = Math.floor(amount);
  if (team.fund < cost) return false;
  team.fund -= cost;
  markDirty();
  return true;
}

/**
 * Price a merchandise sale. Returns { ok, teamShare, sellerShare, price }
 * — the caller moves the real coins; this only computes the split.
 */
function priceMerchandise(kind) {
  const price = kind === "banner" ? MERCH_BANNER_PRICE : MERCH_SCARF_PRICE;
  const teamShare = Math.floor(price * MERCH_TEAM_SHARE);
  return { ok: true, price, teamShare, sellerShare: price - teamShare };
}

/** Championship final ticket price (real coins, caller moves them). */
function ticketPrice() {
  return FINAL_TICKET_PRICE;
}

// --- chat helpers ------------------------------------------------------------

function describeTeam(team) {
  if (!team) return null;
  return {
    id: team.id,
    name: team.name,
    sport: TEAM_SPORTS[team.sportId]?.label ?? team.sportId,
    rosterSize: team.roster.length,
    playerCount: team.playerRoster.length,
    record: `${team.wins}W-${team.draws}D-${team.losses}L`,
    points: team.points,
    trophies: team.trophies,
    fans: fanCount(team.id),
    fund: team.fund,
  };
}

function leagueSummary(kingdomId, sportId) {
  const table = standings(kingdomId, sportId);
  const season = seasonFor(kingdomId, sportId);
  return {
    sport: TEAM_SPORTS[sportId]?.label ?? sportId,
    table: table.map((row) => ({
      name: row.team.name,
      w: row.table.w, d: row.table.d, l: row.table.l, pts: row.table.pts,
    })),
    fixturesPlayed: season.fixtures.filter((f) => f.played).length,
    fixturesTotal: season.fixtures.length,
    champion: season.championTeamId ? teamById(season.championTeamId)?.name ?? null : null,
    organizer: organizerFor(kingdomId),
  };
}

module.exports = {
  // test seams
  _setSavePathForTests,
  resetForTests,
  save,
  // catalog
  TEAM_SPORTS,
  TEAM_SIZE,
  SEASON_WEEKS,
  WIN_POINTS,
  DRAW_POINTS,
  REGISTRATION_FEE,
  TROPHY_LABEL,
  // teams
  teamsFor,
  teamById,
  teamIdFor,
  joinTeam,
  leaveTeam,
  teamOf,
  playerJoinTeam,
  teamRating,
  // organizers
  organizerFor,
  appointOrganizer,
  // seasons
  seasonFor,
  seasonStartFor,
  buildFixtures,
  dueFixtures,
  recordResult,
  standings,
  resolveFixture,
  awardChampionship,
  // fans
  joinFanClub,
  fanTeamOf,
  fanCount,
  // economy
  creditFund,
  debitFund,
  priceMerchandise,
  ticketPrice,
  // chat helpers
  describeTeam,
  leagueSummary,
};
