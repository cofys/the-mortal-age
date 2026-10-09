"use strict";

/**
 * CitizenSports — citizens play year-round league sports: football, racing,
 * wrestling, and archery.
 *
 * WHAT IT DOES (data tier, free):
 *   Weekly match day (Saturday) with per-kingdom football fixtures derived
 *   from week + kingdom hashes, a 12-week season with deterministic league
 *   tables, a championship decided in the final week, horse race cards with
 *   runners derived from the real CitizenStablehands mount rosters, and
 *   wrestling/archery league circuits with a holder's belt carried across
 *   weeks. Zero storage, stable across restarts, zero LLM.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   On match day, citizens announce the day's matches, cheer for their teams
 *   with scripted lines, call out scores, and celebrate champions with
 *   fanfare. Players can join a team's supporters, place bets, or compete
 *   (the join dialogue is LLM; this module tracks the ledgers).
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 * This is an ACTIVITY system, not a profession — any citizen can play,
 * no exclusions (chain saturation does not apply).
 * No overlap: CitizenFestivalGames owns one-off festival competitions
 * (festival windows only); this module owns year-round leagues, teams,
 * tables, seasons, and championships.
 *
 * Wired into the director tick right after CitizenFestivalGames. Plain-node
 * testable: CitizenSports.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const SPORTS_RADIUS = 14; // tiles — close enough to see/hear
const SPORTS_CITIZEN_COOLDOWN_MS = 2 * 60 * 60 * 1000; // a citizen fires at most every 2h
const SPORTS_CHANCE = 0.35; // per eligible citizen per tick
const SEASON_WEEKS = 12; // a season lasts 12 weeks
const TEAMS_PER_KINGDOM = 4;
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BET = 25000; // fat-finger guard per bet

// === Sports ===
const SPORT_FOOTBALL = "football";
const SPORT_RACING = "racing";
const SPORT_WRESTLING = "wrestling";
const SPORT_ARCHERY = "archery";
const SPORT_TYPES = [SPORT_FOOTBALL, SPORT_RACING, SPORT_WRESTLING, SPORT_ARCHERY];

const SPORT_NAMES = {
  [SPORT_FOOTBALL]: "the football league",
  [SPORT_RACING]: "the race meet",
  [SPORT_WRESTLING]: "the wrestling circuit",
  [SPORT_ARCHERY]: "the archery league",
};

// === Teams: 4 per kingdom, stable across restarts ===
const TEAM_NAMES = {
  misthalin: ["the Varrock Vanguards", "the Lumbridge Lions", "the Draynor Dragons", "the Edgeville Eagles"],
  asgarnia: ["the Falador Falcons", "the White Knights", "the Port Sarim Sailors", "the Taverley Treemen"],
  kandarin: ["the Ardougne Arrows", "the Catherby Crabs", "the Hemenster Hounds", "the Seers' Sages"],
  keldagrim: ["the Deep Delvers", "the Granite Guard", "the Consortium Crew", "the Lava Lakers"],
  morytania: ["the Darkmeyer Drakes", "the Canifis Curs", "the Mort'ton Marauders", "the Burgh Bats"],
  kharidian: ["the Al Kharid Scimitars", "the Pollnivneach Panthers", "the Sophanem Sphinxes", "the Menaphos Jackals"],
};
const FALLBACK_TEAMS = ["the Wanderers", "the Rovers", "the Nomads", "the Drifters"];

function teamsForKingdom(kingdomId) {
  return TEAM_NAMES[kingdomId] ?? FALLBACK_TEAMS;
}

// === Race meets ===
const RACE_NAMES = [
  "the King's Cup",
  "the Spring Handicap",
  "the Gallop Stakes",
  "the Meadow Mile",
  "the Dusk Derby",
  "the River Run",
];

// === Scripted lines ===
const MATCH_LINES = [
  "Match day! {home} face {away} at the {venue} — come and watch!",
  "Today's fixture: {home} versus {away}! Kick-off at noon!",
  "{home} take on {away} this {day} — {sport} at its finest!",
  "The {sport} is on! {home} against {away} at the {venue}!",
];

const CHEER_LINES = {
  [SPORT_FOOTBALL]: [
    "Come on {team}! Into them!",
    "What a strike! The crowd goes wild!",
    "Defence! Defence! Hold the line!",
  ],
  [SPORT_RACING]: [
    "They're off! And {name} takes the lead!",
    "Down the straight they come — {name} by a nose!",
    "What a finish! Photo finish at the line!",
  ],
  [SPORT_WRESTLING]: [
    "Throw him! Throw him!",
    "What a suplex! The mat shakes!",
    "He's got the hold! Don't let go!",
  ],
  [SPORT_ARCHERY]: [
    "Bullseye! Straight through the gold!",
    "Steady... loose! A perfect hit!",
    "The crowd holds its breath — another ten!",
  ],
};

const SCORE_LINES = [
  "Full time! {home} {hs} — {as} {away}!",
  "The score: {home} {hs}, {away} {as}!",
  "{winner} take it {hs}-{as}! What a match!",
];

const CHAMPION_LINES = [
  "Champions! {team} lift the {sport} crown for {kingdom}!",
  "The season is decided! {team} are champions of {sport}!",
  "Huzzah! {team} take the {sport} championship!",
];

const PLAYER_INVITE_LINES = [
  "Fancy a kickabout? {team} could use a player like you!",
  "You look quick — ever thought of racing for {team}?",
  "The {sport} needs competitors — how about you?",
];

const BET_LINES = [
  "Five coins on {team} to win the {sport}!",
  "The smart money's on {team} this week!",
  "I'll wager {team} take the championship!",
];

const RIVALRY_LINES = [
  "{home} against {away} — the oldest rivalry in {kingdom}!",
  "Derby day! {home} versus {away} — the town is split!",
];

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const announcedToday = new Map(); // "kingdom:sport:day" -> true

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of announcedToday) {
    if (at < cutoff) announcedToday.delete(k);
  }
}

// === Player ledgers (data tier, zero LLM) ===
const supporters = new Map(); // normName -> { team, kingdom, at }
const bets = new Map(); // normName -> { on, amount, at }

let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of supporters) {
    if (nowMs - v.at > LEDGER_TTL_MS) supporters.delete(k);
  }
  for (const [k, v] of bets) {
    if (nowMs - v.at > LEDGER_TTL_MS) bets.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** Cheap rng from a seed (LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** Week number since epoch. */
function weekNumber(nowMs) {
  return Math.floor(dayNumber(nowMs) / 7);
}

/** The season index and the week within the season. */
function seasonInfo(nowMs) {
  const w = weekNumber(nowMs);
  return { season: Math.floor(w / SEASON_WEEKS), weekInSeason: w % SEASON_WEEKS };
}

/** True on match day (Saturday, server-local time). */
function isMatchDay(nowMs) {
  return new Date(nowMs).getDay() === 6;
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

// ============================================================================
// League simulation — deterministic, zero storage.
// ============================================================================

/**
 * The football fixture for a kingdom in a given season week: two matches
 * (4 teams, round-robin pairing derived from the week).
 */
function fixturesFor(kingdomId, season, weekInSeason) {
  const teams = teamsForKingdom(kingdomId);
  const rng = seededRng(hashStr("fixtures:" + (kingdomId || "none") + ":" + season + ":" + weekInSeason));
  const order = [...teams];
  // Deterministic rotation of the round-robin order.
  for (let i = 0; i < weekInSeason % teams.length; i++) {
    order.push(order.shift());
  }
  // Shuffle once more by the seed so weeks differ.
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return [
    { home: order[0], away: order[1] },
    { home: order[2], away: order[3] },
  ];
}

/**
 * The result of a football match: { homeGoals, awayGoals }.
 * Derived deterministically from season + week + teams.
 */
function resultFor(home, away, season, weekInSeason) {
  const rng = seededRng(hashStr("result:" + home + ":" + away + ":" + season + ":" + weekInSeason));
  return {
    homeGoals: Math.floor(rng() * 5),
    awayGoals: Math.floor(rng() * 5),
  };
}

/**
 * The league table for a kingdom: points for every week played so far this
 * season (win 3, draw 1). Returns sorted [{ team, points, played }].
 */
function tableFor(kingdomId, season, weekInSeason) {
  const table = new Map();
  for (const t of teamsForKingdom(kingdomId)) table.set(t, { team: t, points: 0, played: 0 });
  for (let w = 0; w <= weekInSeason; w++) {
    for (const f of fixturesFor(kingdomId, season, w)) {
      const r = resultFor(f.home, f.away, season, w);
      const h = table.get(f.home);
      const a = table.get(f.away);
      h.played += 1;
      a.played += 1;
      if (r.homeGoals > r.awayGoals) h.points += 3;
      else if (r.awayGoals > r.homeGoals) a.points += 3;
      else {
        h.points += 1;
        a.points += 1;
      }
    }
  }
  return [...table.values()].sort((x, y) => y.points - x.points || x.team.localeCompare(y.team));
}

/** The champion of a kingdom's season (decided in the final week). */
function championFor(kingdomId, season) {
  const table = tableFor(kingdomId, season, SEASON_WEEKS - 1);
  return table.length ? table[0].team : null;
}

/**
 * The race card for a kingdom on a match day: 3 races, 6 runners each.
 * Horse names come from the real CitizenStablehands mount rosters via lazy
 * require (with a static fallback), so the fiction stays consistent.
 */
function raceCardFor(kingdomId, dateMs) {
  const day = dayNumber(dateMs);
  const runners = horseNamesFor(kingdomId, dateMs);
  const races = [];
  for (let r = 0; r < 3; r++) {
    const rng = seededRng(hashStr("racecard:" + (kingdomId || "none") + ":" + day + ":" + r));
    const name = pickOne(rng, RACE_NAMES);
    const field = [];
    const pool = [...runners];
    for (let i = 0; i < 6 && pool.length; i++) {
      field.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
    const winner = field.length ? field[Math.floor(seededRng(hashStr("racewinner:" + name + ":" + day))() * field.length)] : null;
    races.push({ name, field, winner });
  }
  return races;
}

/** Horse names for a kingdom: real stable rosters, static fallback. */
function horseNamesFor(kingdomId, dateMs) {
  try {
    const stablehands = require("./CitizenStablehands");
    if (typeof stablehands.mountsFor === "function" && Array.isArray(stablehands.STABLES)) {
      const names = [];
      const stables = stablehands.STABLES.filter((s) => !kingdomId || s.kingdom === kingdomId);
      for (const s of stables.length ? stables : stablehands.STABLES) {
        const mounts = stablehands.mountsFor(s, dateMs) || [];
        for (const m of mounts) {
          names.push(capitalize(m.coat) + " " + m.type);
        }
      }
      if (names.length >= 6) return names;
    }
  } catch { /* module absent */ }
  return FALLBACK_HORSES;
}

const FALLBACK_HORSES = [
  "Bay mare", "Chestnut stallion", "Grey gelding", "Black mare",
  "Dun pony", "Roan stallion", "Palomino mare", "White gelding",
];

function capitalize(s) {
  s = String(s ?? "");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The wrestling/archery league bout for a kingdom this week: two named
 * contenders and a holder's belt carried from last week's winner.
 */
function boutFor(sport, kingdomId, season, weekInSeason, rosterNames) {
  const rng = seededRng(hashStr("bout:" + sport + ":" + (kingdomId || "none") + ":" + season + ":" + weekInSeason));
  const pool = [...(rosterNames || [])];
  const contenders = [];
  for (let i = 0; i < 2 && pool.length; i++) {
    contenders.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  const winner = contenders.length
    ? contenders[Math.floor(seededRng(hashStr("boutwinner:" + sport + ":" + (kingdomId || "none") + ":" + season + ":" + weekInSeason))() * contenders.length)]
    : null;
  return { contenders, winner };
}

// ============================================================================
// Player participation (data tier, zero LLM).
// ============================================================================

/** Support a team: recorded; the LLM tier handles dialogue. */
function joinTeam(playerName, team, kingdomId, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !team) return null;
  pruneLedgers(nowMs);
  supporters.set(name, { team: String(team), kingdom: kingdomId || null, at: nowMs });
  return team;
}

/** The team a player supports, or null. */
function teamFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = supporters.get(name);
  return rec ? rec.team : null;
}

/** Place a bet on a team: capped, recorded; the LLM tier handles dialogue. */
function placeBet(playerName, on, amount, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !on) return null;
  pruneLedgers(nowMs);
  const stake = Math.min(Math.max(0, Math.floor(amount ?? 0)), MAX_BET);
  bets.set(name, { on: String(on), amount: stake, at: nowMs });
  return stake;
}

/** The active bet for a player, or null. */
function betFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  return bets.get(name) ?? null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

function journalize(citizen, text) {
  try {
    const journal = require("./CitizenJournal");
    if (typeof journal.appendEntry === "function") {
      journal.appendEntry(citizen, text);
    } else if (typeof journal.addEntry === "function") {
      journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(text) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(text);
  } catch { /* rumors absent */ }
}

function kingdomName(kid) {
  const names = {
    misthalin: "Misthalin",
    asgarnia: "Asgarnia",
    kandarin: "Kandarin",
    keldagrim: "Keldagrim",
    morytania: "Morytania",
    kharidian: "the Kharidian",
  };
  return names[kid] ?? "the kingdom";
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: match day (cheapest) → cooldown → materialized →
// real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickSports(director, nowMs) {
  pruneCooldowns(nowMs);
  // Match day only: the cheapest possible gate.
  if (!isMatchDay(nowMs)) return;
  const { season, weekInSeason } = seasonInfo(nowMs);
  const day = dayNumber(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < SPORTS_CITIZEN_COOLDOWN_MS) continue;

        // 2. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 3. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, SPORTS_RADIUS)) continue;

        // 4. Chance gate
        if (!chance(Math.random, SPORTS_CHANCE)) continue;

        // 5. Do the thing (scripted, zero LLM)
        doSportsWork(director, record, citizen, season, weekInSeason, day, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-sports] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-sports] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doSportsWork(director, record, citizen, season, weekInSeason, day, nowMs) {
  const kingdomId = record.kingdomId;
  const kingdom = kingdomName(kingdomId);
  const rng = Math.random;

  // Championship week: the crowd moment, once per kingdom per season.
  if (weekInSeason === SEASON_WEEKS - 1) {
    const key = "champion:" + (kingdomId || "none") + ":" + season;
    if (!announcedToday.has(key)) {
      announcedToday.set(key, nowMs);
      const champ = championFor(kingdomId, season);
      if (champ) {
        const line = fill(pickOne(rng, CHAMPION_LINES), {
          team: champ,
          sport: "football",
          kingdom,
        });
        { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
        journalize(citizen, "celebrated " + champ + " winning the football championship");
        seedRumor(champ + " are champions of the football league in " + kingdom + "!");
      }
      return;
    }
  }

  const roll = rng();
  if (roll < 0.35) {
    // Announce today's fixtures (once per kingdom per sport per day).
    const key = "announce:football:" + (kingdomId || "none") + ":" + day;
    if (announcedToday.has(key)) return;
    announcedToday.set(key, nowMs);
    const fixtures = fixturesFor(kingdomId, season, weekInSeason);
    const f = fixtures[Math.floor(rng() * fixtures.length)];
    const line = fill(pickOne(rng, MATCH_LINES), {
      home: f.home,
      away: f.away,
      venue: "the " + kingdom + " sports ground",
      sport: "football",
      day: "Saturday",
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, "announced " + f.home + " vs " + f.away);
  } else if (roll < 0.6) {
    // Call out a result.
    const fixtures = fixturesFor(kingdomId, season, weekInSeason);
    const f = fixtures[Math.floor(rng() * fixtures.length)];
    const r = resultFor(f.home, f.away, season, weekInSeason);
    const winner = r.homeGoals > r.awayGoals ? f.home : r.awayGoals > r.homeGoals ? f.away : "Neither side";
    const line = fill(pickOne(rng, SCORE_LINES), {
      home: f.home,
      away: f.away,
      hs: r.homeGoals,
      as: r.awayGoals,
      winner,
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, "called the score: " + f.home + " " + r.homeGoals + "-" + r.awayGoals + " " + f.away);
  } else if (roll < 0.75) {
    // Racing: cheer a runner.
    const card = raceCardFor(kingdomId, nowMs);
    const race = card.length ? card[Math.floor(rng() * card.length)] : null;
    if (!race || !race.field.length) return;
    const horse = race.field[Math.floor(rng() * race.field.length)];
    const line = fill(pickOne(rng, CHEER_LINES[SPORT_RACING]), { name: horse });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, "cheered the racing at " + race.name);
  } else if (roll < 0.9) {
    // Cheer a team.
    const teams = teamsForKingdom(kingdomId);
    const team = teams[Math.floor(rng() * teams.length)];
    const sport = pickOne(rng, [SPORT_FOOTBALL, SPORT_WRESTLING, SPORT_ARCHERY]);
    const line = fill(pickOne(rng, CHEER_LINES[sport]), { team, name: team });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, "cheered for " + team);
  } else {
    // Invite the player.
    const teams = teamsForKingdom(kingdomId);
    const team = teams[Math.floor(rng() * teams.length)];
    const sport = pickOne(rng, SPORT_TYPES);
    const line = fill(pickOne(rng, PLAYER_INVITE_LINES), { team, sport: SPORT_NAMES[sport] });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  }
}

module.exports = {
  tickSports,
  joinTeam,
  teamFor,
  placeBet,
  betFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  teamsForKingdom,
  fixturesFor,
  resultFor,
  tableFor,
  championFor,
  raceCardFor,
  horseNamesFor,
  boutFor,
  seasonInfo,
  isMatchDay,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  seededRng,
  dayNumber,
  weekNumber,
  chance,
  isRealPlayer,
  withinTiles,
  kingdomName,
  SPORT_TYPES,
  SPORT_FOOTBALL,
  SPORT_RACING,
  SPORT_WRESTLING,
  SPORT_ARCHERY,
  SPORT_NAMES,
  SEASON_WEEKS,
  TEAMS_PER_KINGDOM,
  MAX_BET,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    announcedToday.clear();
    supporters.clear();
    bets.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
