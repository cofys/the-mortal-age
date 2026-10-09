"use strict";

/**
 * CitizenTournaments — the data tier for participatory citizen tournaments.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Sport catalog: arena combat, foot races, archery contests (rating-based,
 *     from REAL skill levels), plus dice, cards, and board games (luck-based,
 *     tavern sports). No invented sports, no invented ratings.
 *   - Seasonal tournaments: one per kingdom per sport per season. Entry fees
 *     are REAL coins; the prize pool is the entry fees (champion 80%,
 *     runner-up 20%). Single-elimination brackets, seeded by rating.
 *   - Parimutuel betting: citizens and real players bet REAL coins on who
 *     wins a tournament. Winners split 90% of the pool proportionally;
 *     10% house cut feeds the kingdom purse. Zero house risk, never
 *     invented money.
 *   - Champions: per kingdom per sport, with a leaderboard. Champions earn
 *     real fame deeds via CitizenReputation.
 *   - Player challenges: citizens challenge nearby real players to
 *     exhibitions. If the player accepts in chat, the bout resolves by
 *     real ratings and the winner takes a purse prize (paid only if the
 *     kingdom purse covers it — honor otherwise).
 *   - Kingdom purse: accumulates betting house cuts; funds exhibition
 *     prizes. Never goes negative.
 *
 * NO OVERLAP: CitizenSports owns the year-round spectator leagues (football
 * tables, race meets, wrestling circuits — citizens watch and cheer).
 * This module owns PARTICIPATORY tournaments: citizens enter, compete,
 * and win. CitizenFestivalGames owns one-off festival competitions.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Tournament scheduling, ambient entries, bout
 *     resolution, bet settlement, and announcements live in
 *     lib/CitizenTournamentLife.js.
 *   - No LLM. Announcements are template + journal facts.
 *   - No invented money: every coin moved is real, or nothing happens.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-tournaments.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-tournaments.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const TAVERN_ENTRY_FEE = 10; // coins to enter a tavern sport
const ARENA_ENTRY_FEE = 25; // coins to enter a rating sport
const MAX_ENTRANTS = 8; // single-elimination bracket of 8
const MIN_ENTRANTS = 2; // fewer than this -> tournament cancelled, fees refunded
const ENTRY_WINDOW_MS = 24 * 60 * 60 * 1000; // entries open 24h
const MAX_BET = 200; // max single bet, coins
const HOUSE_CUT = 0.1; // 10% of betting pool -> kingdom purse
const CHAMPION_SHARE = 0.8; // 80% of entry pool
const RUNNERUP_SHARE = 0.2; // 20% of entry pool
const EXHIBITION_PRIZE = 50; // winner's purse for a player exhibition
const CHALLENGE_EXPIRY_MS = 10 * 60 * 1000; // challenges lapse after 10 min

// Sport catalog. kind "rating" resolves bouts from real skill levels;
// kind "luck" resolves 50/50 (tavern games). Venues are deterministic
// tiles near the kingdom market (same pattern as guild halls).
const SPORTS = Object.freeze({
  arena: Object.freeze({
    id: "arena", label: "Arena Combat", kind: "rating",
    skills: Object.freeze(["attack", "strength", "defence"]),
    venueName: "Arena",
    offset: Object.freeze({ dx: 10, dy: 0 }),
  }),
  race: Object.freeze({
    id: "race", label: "Foot Race", kind: "rating",
    skills: Object.freeze(["agility"]),
    venueName: "Race Track",
    offset: Object.freeze({ dx: -10, dy: 0 }),
  }),
  archery: Object.freeze({
    id: "archery", label: "Archery Contest", kind: "rating",
    skills: Object.freeze(["ranged"]),
    venueName: "Archery Butts",
    offset: Object.freeze({ dx: 0, dy: 10 }),
  }),
  dice: Object.freeze({
    id: "dice", label: "Dice Tournament", kind: "luck",
    skills: Object.freeze([]),
    venueName: "Tavern",
    offset: Object.freeze({ dx: 4, dy: 4 }),
  }),
  cards: Object.freeze({
    id: "cards", label: "Card Championship", kind: "luck",
    skills: Object.freeze([]),
    venueName: "Tavern",
    offset: Object.freeze({ dx: 4, dy: 4 }),
  }),
  boards: Object.freeze({
    id: "boards", label: "Board Game Masters", kind: "luck",
    skills: Object.freeze([]),
    venueName: "Tavern",
    offset: Object.freeze({ dx: 4, dy: 4 }),
  }),
});

// tsps skill order for the getLevel(index) API (same as CitizenGuilds).
const SKILL_ORDER = Object.freeze([
  "attack", "defence", "strength", "hitpoints", "ranged", "prayer", "magic",
  "cooking", "woodcutting", "fletching", "fishing", "firemaking", "crafting",
  "smithing", "mining", "herblore", "agility", "thieving", "slayer",
  "farming", "runecraft", "hunter", "construction",
]);

// --- seeded rng (deterministic bout resolution) --------------------------------

/** FNV-1a string hash — seeds the bout rng, nothing more. */
function hashStr(s) {
  let h = 2166136261;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small deterministic PRNG for bout resolution. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- state -------------------------------------------------------------------

let cache = null;
let dirty = false;

function blankState() {
  return { tournaments: [], challenges: [], purse: {}, champions: {} };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        if (Array.isArray(raw.tournaments)) cache.tournaments = raw.tournaments;
        if (Array.isArray(raw.challenges)) cache.challenges = raw.challenges;
        if (raw.purse && typeof raw.purse === "object") cache.purse = raw.purse;
        if (raw.champions && typeof raw.champions === "object") cache.champions = raw.champions;
      }
    }
  } catch {
    cache = blankState();
  }
  return cache;
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  cache = blankState();
  dirty = false;
}

// --- coins (real, honest — same pattern as CitizenEntertainment) --------------

function coinCount(player) {
  try {
    const inv = player?.getInventory?.() ?? player?.inventory;
    if (inv?.count) return Number(inv.count(995) ?? 0);
    if (Array.isArray(inv)) {
      return inv.filter((i) => Number(i?.id) === 995)
        .reduce((n, i) => n + Number(i?.amount ?? 1), 0);
    }
  } catch { /* fall through */ }
  return 0;
}

function removeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.() ?? player?.inventory;
    if (inv?.remove) {
      inv.remove(995, amount);
      return true;
    }
    if (typeof player?.removeCoins === "function") {
      player.removeCoins(amount);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

function addCoins(player, amount) {
  try {
    if (typeof player?.addCoins === "function") {
      player.addCoins(amount);
      return true;
    }
    const inv = player?.getInventory?.() ?? player?.inventory;
    if (inv?.add) { inv.add(995, amount); return true; }
  } catch { /* fall through */ }
  return false;
}

// --- ratings (real skill levels, never invented) ------------------------------

function skillLevelFor(player, skill) {
  if (!player) return 1;
  try {
    const skills = player.getSkills?.() ?? player.skills;
    if (skills && typeof skills.getLevel === "function") {
      const idx = SKILL_ORDER.indexOf(String(skill ?? "").toLowerCase());
      if (idx >= 0) return Number(skills.getLevel(idx) ?? 1);
    }
  } catch { /* fall through */ }
  return 1;
}

/**
 * Athletic rating for a sport from the player's REAL skill levels.
 * Arena: attack+strength+defence. Race: agility. Archery: ranged.
 * Luck sports return null (no rating — 50/50).
 */
function athleticRatingFor(player, sportId) {
  const sport = SPORTS[sportId];
  if (!sport || sport.kind !== "rating") return null;
  let total = 0;
  for (const skill of sport.skills) total += skillLevelFor(player, skill);
  return Math.max(1, total);
}

// --- venues -------------------------------------------------------------------

/**
 * Deterministic venue tile for a sport in a kingdom: market tile plus the
 * sport's offset. Defensive: a missing market tile returns null rather
 * than inventing coordinates.
 */
function venueTile(kingdomId, sportId) {
  const sport = SPORTS[sportId];
  if (!sport || kingdomId == null) return null;
  try {
    const Sites = require("../brain/CitizenSites");
    const market = typeof Sites.siteTileByKingdom === "function"
      ? Sites.siteTileByKingdom(kingdomId, "market")
      : null;
    if (!market || typeof market.x !== "number") return null;
    return {
      x: market.x + sport.offset.dx,
      y: market.y + sport.offset.dy,
      z: market.z ?? 0,
      name: `${kingdomId} ${sport.venueName}`,
    };
  } catch {
    return null;
  }
}

// --- seasons (defensive read — tournaments degrade gracefully without it) -----

function currentSeason(nowMs = Date.now()) {
  try {
    const S = require("./CitizenSeasons");
    if (typeof S.seasonOf === "function") return S.seasonOf(nowMs) ?? "unknown";
  } catch { /* fall through */ }
  return "unknown";
}

// --- tournaments ---------------------------------------------------------------

function entryFeeFor(sportId) {
  const sport = SPORTS[sportId];
  if (!sport) return ARENA_ENTRY_FEE;
  return sport.kind === "luck" ? TAVERN_ENTRY_FEE : ARENA_ENTRY_FEE;
}

/**
 * Open a tournament. Returns the tournament, or the existing open one for
 * the same kingdom+sport (never two open at once).
 */
function openTournament(kingdomId, sportId, nowMs = Date.now()) {
  const sport = SPORTS[sportId];
  if (!sport || kingdomId == null) return null;
  const st = load();
  const existing = st.tournaments.find(
    (t) => t.kingdomId === String(kingdomId) && t.sportId === sportId && t.status === "open"
  );
  if (existing) return existing;
  const t = {
    id: `t-${String(kingdomId)}-${sportId}-${nowMs}`,
    kingdomId: String(kingdomId),
    sportId,
    season: currentSeason(nowMs),
    status: "open",
    entries: [],
    bets: [],
    openedAt: nowMs,
    closesAt: nowMs + ENTRY_WINDOW_MS,
    champion: null,
    runnerUp: null,
    pool: 0,
    settled: false,
  };
  st.tournaments.push(t);
  markDirty();
  return t;
}

function tournamentById(id) {
  return load().tournaments.find((t) => t.id === id) ?? null;
}

function openTournamentFor(kingdomId, sportId) {
  return load().tournaments.find(
    (t) => t.kingdomId === String(kingdomId) && t.sportId === sportId && t.status === "open"
  ) ?? null;
}

/** All open tournaments in a kingdom (for chat + brain). */
function openTournamentsFor(kingdomId) {
  return load().tournaments.filter(
    (t) => t.kingdomId === String(kingdomId) && t.status === "open"
  );
}

/**
 * Enter a tournament. The caller passes the entrant's real athletic rating
 * (computed from their real levels) — the data tier never invents one.
 * Returns { ok, reason }.
 */
function enterTournament(tournamentId, username, rating, nowMs = Date.now()) {
  const t = tournamentById(tournamentId);
  if (!t) return { ok: false, reason: "no-tournament" };
  if (t.status !== "open") return { ok: false, reason: "not-open" };
  if (nowMs > t.closesAt) return { ok: false, reason: "entries-closed" };
  const key = normalizeName(username);
  if (!key) return { ok: false, reason: "no-name" };
  if (t.entries.some((e) => normalizeName(e.username) === key)) {
    return { ok: false, reason: "already-entered" };
  }
  if (t.entries.length >= MAX_ENTRANTS) return { ok: false, reason: "full" };
  t.entries.push({ username, rating: rating ?? null, at: nowMs });
  t.pool += entryFeeFor(t.sportId);
  markDirty();
  return { ok: true };
}

/**
 * Resolve a single bout. Rating sports: weighted by real ratings.
 * Luck sports: 50/50. Deterministic from the seeded rng.
 */
function boutWinner(a, b, sportId, rng) {
  const sport = SPORTS[sportId];
  if (!sport || sport.kind === "luck") return rng() < 0.5 ? a : b;
  const ra = Math.max(1, Number(a.rating ?? 1));
  const rb = Math.max(1, Number(b.rating ?? 1));
  return rng() < ra / (ra + rb) ? a : b;
}

/**
 * Run a single-elimination bracket. Entries seeded by rating (luck sports:
 * shuffled by rng). Returns { rounds, champion, runnerUp }.
 */
function runBracket(entries, sportId, seedStr) {
  const rng = mulberry32(hashStr(seedStr));
  let fighters = entries.map((e) => ({ ...e }));
  const sport = SPORTS[sportId];
  if (sport?.kind === "luck") {
    for (let i = fighters.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [fighters[i], fighters[j]] = [fighters[j], fighters[i]];
    }
  } else {
    fighters.sort((x, y) => Number(y.rating ?? 1) - Number(x.rating ?? 1));
  }
  const rounds = [];
  let round = 1;
  while (fighters.length > 1) {
    const bouts = [];
    const next = [];
    while (fighters.length > 1) {
      const a = fighters.shift();
      const b = fighters.pop();
      const winner = boutWinner(a, b, sportId, rng);
      bouts.push({ a: a.username, b: b.username, winner: winner.username, round });
      next.push(winner);
    }
    if (fighters.length === 1) next.push(fighters.shift()); // bye
    rounds.push({ round, bouts });
    fighters = next;
    round += 1;
  }
  const champion = fighters[0] ?? null;
  const finalBout = rounds[rounds.length - 1]?.bouts?.[0];
  const runnerUp = finalBout
    ? (finalBout.winner === finalBout.a ? finalBout.b : finalBout.a)
    : null;
  return { rounds, champion: champion?.username ?? null, runnerUp };
}

/**
 * Close entries and run the tournament. Fewer than MIN_ENTRANTS ->
 * cancelled (the Life tick refunds real entry fees).
 * Returns the result record, or null if the tournament isn't open.
 */
function closeAndRun(tournamentId, nowMs = Date.now()) {
  const t = tournamentById(tournamentId);
  if (!t || t.status !== "open") return null;
  const st = load();
  if (t.entries.length < MIN_ENTRANTS) {
    t.status = "cancelled";
    t.closedAt = nowMs;
    markDirty();
    return { tournament: t, cancelled: true };
  }
  const { rounds, champion, runnerUp } = runBracket(t.entries, t.sportId, t.id);
  t.status = "closed";
  t.closedAt = nowMs;
  t.rounds = rounds;
  t.champion = champion;
  t.runnerUp = runnerUp;
  t.championPrize = Math.floor(t.pool * CHAMPION_SHARE);
  t.runnerUpPrize = t.pool - t.championPrize;
  if (champion) {
    st.champions[`${t.kingdomId}:${t.sportId}`] = {
      username: champion, season: t.season, at: nowMs, tournamentId: t.id,
    };
  }
  markDirty();
  return { tournament: t, cancelled: false, champion, runnerUp, rounds };
}

/** Reigning champion for a kingdom+sport (null if none). */
function championOf(kingdomId, sportId) {
  return load().champions[`${String(kingdomId)}:${sportId}`] ?? null;
}

/** Top champions across all kingdoms+sports, most recent first. */
function topChampions(limit = 10) {
  const rows = Object.entries(load().champions).map(([key, c]) => {
    const idx = key.indexOf(":");
    return { kingdomId: key.slice(0, idx), sportId: key.slice(idx + 1), ...c };
  });
  rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return rows.slice(0, Math.max(1, limit));
}

// --- betting (parimutuel — the house can never lose) ----------------------------

/**
 * Record a bet on a tournament winner. Real coins are deducted by the
 * CALLER (brain action / chat handler) — the data tier records the stake.
 * Returns { ok, reason }.
 */
function placeBet(tournamentId, bettorUsername, pickUsername, amount) {
  const t = tournamentById(tournamentId);
  if (!t) return { ok: false, reason: "no-tournament" };
  if (t.status !== "open") return { ok: false, reason: "not-open" };
  const bettor = normalizeName(bettorUsername);
  const pick = normalizeName(pickUsername);
  if (!bettor || !pick) return { ok: false, reason: "no-name" };
  if (!Number.isFinite(amount) || amount < 1) return { ok: false, reason: "bad-amount" };
  if (amount > MAX_BET) return { ok: false, reason: "too-big" };
  if (!t.entries.some((e) => normalizeName(e.username) === pick)) {
    return { ok: false, reason: "not-entered" };
  }
  t.bets.push({ bettor: bettorUsername, pick: pickUsername, amount: Math.floor(amount), at: Date.now() });
  markDirty();
  return { ok: true };
}

/**
 * Settle bets parimutuelly after the tournament closes. Winners split
 * 90% of the pool proportionally to stake; 10% house cut -> purse.
 * Returns { payouts: [{ bettor, amount }], houseCut, pool } or null.
 */
function settleBets(tournamentId) {
  const t = tournamentById(tournamentId);
  if (!t || t.status !== "closed" || t.settled) return null;
  const st = load();
  const pool = t.bets.reduce((n, b) => n + Number(b.amount ?? 0), 0);
  const houseCut = Math.floor(pool * HOUSE_CUT);
  const result = { payouts: [], houseCut: 0, pool };
  if (pool <= 0 || !t.champion) {
    t.settled = true;
    markDirty();
    return result;
  }
  const champKey = normalizeName(t.champion);
  const winning = t.bets.filter((b) => normalizeName(b.pick) === champKey);
  const winTotal = winning.reduce((n, b) => n + Number(b.amount ?? 0), 0);
  result.houseCut = houseCut;
  st.purse[t.kingdomId] = (st.purse[t.kingdomId] ?? 0) + houseCut;
  const distributable = pool - houseCut;
  if (winTotal > 0 && distributable > 0) {
    for (const b of winning) {
      const share = Math.floor((Number(b.amount) / winTotal) * distributable);
      if (share > 0) result.payouts.push({ bettor: b.bettor, amount: share });
    }
  }
  t.settled = true;
  markDirty();
  return result;
}

// --- kingdom purse ---------------------------------------------------------------

function purseFor(kingdomId) {
  return load().purse[String(kingdomId)] ?? 0;
}

function addToPurse(kingdomId, amount) {
  const st = load();
  const key = String(kingdomId);
  st.purse[key] = (st.purse[key] ?? 0) + Math.max(0, Math.floor(amount ?? 0));
  markDirty();
  return st.purse[key];
}

/** Spend from the purse. Returns true if covered, false (no spend) if not. */
function purseSpend(kingdomId, amount) {
  const st = load();
  const key = String(kingdomId);
  const have = st.purse[key] ?? 0;
  const need = Math.max(0, Math.floor(amount ?? 0));
  if (have < need) return false;
  st.purse[key] = have - need;
  markDirty();
  return true;
}

// --- player challenges ------------------------------------------------------------

/**
 * A citizen challenges a real player to an exhibition. Recorded + expires;
 * the chat layer resolves it when the player accepts.
 */
function issueChallenge(citizenUsername, playerUsername, sportId, nowMs = Date.now()) {
  const sport = SPORTS[sportId];
  if (!sport || !normalizeName(citizenUsername) || !normalizeName(playerUsername)) return null;
  const st = load();
  const existing = st.challenges.find(
    (c) => normalizeName(c.citizen) === normalizeName(citizenUsername) && c.status === "pending"
  );
  if (existing) return existing;
  const c = {
    id: `ch-${nowMs}-${st.challenges.length}`,
    citizen: citizenUsername,
    player: playerUsername,
    sportId,
    at: nowMs,
    expiresAt: nowMs + CHALLENGE_EXPIRY_MS,
    status: "pending",
  };
  st.challenges.push(c);
  if (st.challenges.length > 50) st.challenges = st.challenges.slice(-50);
  markDirty();
  return c;
}

/** Pending, unexpired challenge for a player (null if none). */
function pendingChallengeFor(playerUsername, nowMs = Date.now()) {
  const key = normalizeName(playerUsername);
  return load().challenges.find(
    (c) => c.status === "pending" && normalizeName(c.player) === key && c.expiresAt > nowMs
  ) ?? null;
}

/**
 * Resolve a challenge bout. Ratings are the real ratings for the sport
 * (computed by the caller from real levels). Returns { winner, citizenWon }
 * or null.
 */
function resolveChallenge(challengeId, citizenRating, playerRating, nowMs = Date.now()) {
  const st = load();
  const c = st.challenges.find((x) => x.id === challengeId);
  if (!c || c.status !== "pending") return null;
  const rng = mulberry32(hashStr(c.id));
  const a = { username: c.citizen, rating: citizenRating };
  const b = { username: c.player, rating: playerRating };
  const winner = boutWinner(a, b, c.sportId, rng);
  c.status = "resolved";
  c.winner = winner.username;
  c.resolvedAt = nowMs;
  markDirty();
  return { winner: winner.username, citizenWon: normalizeName(winner.username) === normalizeName(c.citizen) };
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  ARENA_ENTRY_FEE,
  TAVERN_ENTRY_FEE,
  MAX_ENTRANTS,
  MIN_ENTRANTS,
  ENTRY_WINDOW_MS,
  MAX_BET,
  HOUSE_CUT,
  CHAMPION_SHARE,
  RUNNERUP_SHARE,
  EXHIBITION_PRIZE,
  SPORTS,
  coinCount,
  removeCoins,
  addCoins,
  skillLevelFor,
  athleticRatingFor,
  venueTile,
  currentSeason,
  entryFeeFor,
  openTournament,
  tournamentById,
  openTournamentFor,
  openTournamentsFor,
  enterTournament,
  runBracket,
  closeAndRun,
  championOf,
  topChampions,
  placeBet,
  settleBets,
  purseFor,
  addToPurse,
  purseSpend,
  issueChallenge,
  pendingChallengeFor,
  resolveChallenge,
  hashStr,
  mulberry32,
};
