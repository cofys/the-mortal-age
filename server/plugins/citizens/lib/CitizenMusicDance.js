"use strict";

/**
 * CitizenMusicDance — the data tier for citizen orchestras, dance troupes,
 * concert halls, dance halls, ticketed concerts, and music/dance lessons.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   musician/dancer proficiency (earned, never hash-derived), real
 *   instrument item records, named ensembles and dance troupes, dance
 *   halls (one per kingdom), weekly ticketed concerts, festival grand
 *   concerts, paid lessons, ticket sales, and pure helpers.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Concert scheduling, rehearsals, payouts, and
 *     announcements live in lib/CitizenMusicDanceLife.js (the director
 *     ticks that).
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - Money is honest: tickets and lessons move REAL coins between real
 *     inventories. Broke citizens can't buy tickets or lessons.
 *   - Instruments are real engine items: lyre (3689), goat horn (9735),
 *     magic whistle (16), grail bell (17). Owning one boosts practice
 *     gains; it is never required.
 *
 * NO OVERLAP (documented boundary):
 *   CitizenBards owns professional solo/small-troupe minstrels: evening
 *   halls, repertoire, ballads, song requests, tips, commissions.
 *   CitizenStreetPerformers owns amateur buskers: daytime squares,
 *   markets, tavern entrances, coin tips.
 *   CitizenEntertainment owns taverns, dice, theater, arena, drinks,
 *   drunkenness, and bard performances at taverns.
 *   CitizenFestivals owns festival events; concerts only *appear* at
 *   them.
 *   THIS module owns: multi-musician ENSEMBLES (3-6 players), DANCE
 *   TROUPES, DANCE HALLS, ticketed CONCERTS, and music/dance LESSONS.
 *   Ensembles defensively exclude hash-derived bards/street performers
 *   so nobody double-books a stage.
 *
 * Persisted to data/saves/citizen-music-dance.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-music-dance.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
}

// === Tuning: all magic numbers here ===
const COINS_ID = 995;
const TICKET_PRICE = 25; // coins per concert ticket
const LESSON_PRICE = 30; // coins per music/dance lesson
const LESSON_GAIN = 5; // proficiency per lesson
const LESSON_TEACHER_GAIN = 2; // teacher keeps sharp
const TEACHER_MIN_SKILL = 60; // must be this good to teach
const PRACTICE_GAIN = 1; // proficiency per practice round
const PRACTICE_GAIN_INSTRUMENT = 2; // with a real instrument in hand
const REHEARSAL_GAIN = 1; // per rehearsal per member
const ENSEMBLE_MIN_SKILL = 40; // join threshold for ensembles
const TROUPE_MIN_SKILL = 40; // join threshold for troupes
const ENSEMBLE_MIN = 3;
const ENSEMBLE_MAX = 6;
const TROUPE_MIN = 3;
const TROUPE_MAX = 8;
const CONCERT_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // weekly concerts
const CONCERT_MOOD = 12; // audience mood boost
const CONCERT_MOOD_HEADLINER = 6; // performers' mood boost
const LESSON_COOLDOWN_MS = 24 * 3600 * 1000; // one lesson per pupil per day
const PRACTICE_COOLDOWN_MS = 4 * 3600 * 1000; // practice at most every 4h
const REHEARSAL_COOLDOWN_MS = 24 * 3600 * 1000; // daily rehearsals

// Real engine instrument item IDs (verified against item-gameplay.json).
const INSTRUMENTS = Object.freeze([
  Object.freeze({ id: "lyre", name: "lyre", itemId: 3689, kind: "strings" }),
  Object.freeze({ id: "horn", name: "goat horn", itemId: 9735, kind: "wind" }),
  Object.freeze({ id: "whistle", name: "magic whistle", itemId: 16, kind: "wind" }),
  Object.freeze({ id: "bell", name: "grail bell", itemId: 17, kind: "percussion" }),
]);

const KINGDOM_DANCE_HALLS = Object.freeze({
  misthalin: Object.freeze({ name: "The Velvet Step", kingdomId: "misthalin" }),
  asgarnia: Object.freeze({ name: "The Gilded Reel", kingdomId: "asgarnia" }),
  kandarin: Object.freeze({ name: "The Lantern Waltz", kingdomId: "kandarin" }),
  morytania: Object.freeze({ name: "The Pallid Masque", kingdomId: "morytania" }),
  keldagrim: Object.freeze({ name: "The Stone Rhythm", kingdomId: "keldagrim" }),
});

// Deterministic hall offsets from the market tile (spread, not stacked).
const HALL_OFFSET = Object.freeze({ dx: 6, dy: -4 });

const ENSEMBLE_ADJECTIVES = Object.freeze([
  "Gilded", "Ember", "Silver", "Thorned", "Amber", "Velvet", "Copper", "Misty",
]);
const ENSEMBLE_NOUNS = Object.freeze([
  "Strings", "Reeds", "Bells", "Chords", "Harmonies", "Melodies", "Tunes", "Chorales",
]);
const TROUPE_ADJECTIVES = Object.freeze([
  "Ember", "Willow", "Crimson", "Moonlit", "Storm", "Golden", "Silent", "Wild",
]);
const TROUPE_NOUNS = Object.freeze([
  "Dancers", "Footfalls", "Spinners", "Revelers", "Steppers", "Whirlers",
]);

// === FNV-1a (codebase convention: local copy per module) ===
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// === State ===
let cache = null; // { players: { [norm]: { music, dance, instrumentId, lastPractice, lastLesson } }, ensembles: [...], troupes: [...], halls: {...}, concerts: [...] }
let dirty = false;

function blankState() {
  return {
    players: Object.create(null),
    ensembles: [],
    troupes: [],
    halls: Object.create(null),
    concerts: [],
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = Object.assign(blankState(), parsed);
    if (!cache.players || typeof cache.players !== "object") cache.players = Object.create(null);
    if (!Array.isArray(cache.ensembles)) cache.ensembles = [];
    if (!Array.isArray(cache.troupes)) cache.troupes = [];
    if (!Array.isArray(cache.concerts)) cache.concerts = [];
  } catch {
    cache = blankState();
  }
  return cache;
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

/** Test/life-tier seam — mark state dirty so the next save() persists. */
function touch() {
  markDirty();
}

function playerRec(username) {
  const st = load();
  const key = normalizeName(username);
  if (!key) return null;
  if (!st.players[key]) {
    st.players[key] = { music: 0, dance: 0, instrumentId: null, lastPractice: 0, lastLesson: 0 };
    markDirty();
  }
  return st.players[key];
}

// === Instruments ===
function instruments() {
  return INSTRUMENTS;
}

function instrumentById(id) {
  return INSTRUMENTS.find((i) => i.id === id) ?? null;
}

/** Real-inventory check: does this player hold the instrument item? (defensive) */
function playerHasInstrument(player, instrumentId) {
  try {
    const inst = instrumentById(instrumentId);
    if (!inst) return false;
    const inv = player?.inventory ?? player?.inv ?? null;
    if (!inv) return false;
    if (typeof inv.count === "function") return inv.count(inst.itemId) > 0;
    if (typeof inv.has === "function") return !!inv.has(inst.itemId);
    if (Array.isArray(inv)) return inv.some((s) => s && (s.id === inst.itemId || s.itemId === inst.itemId));
    return false;
  } catch {
    return false;
  }
}

/** Assign/claim an instrument for a musician (cosmetic preference; real item checked separately). */
function setInstrument(username, instrumentId) {
  const inst = instrumentById(instrumentId);
  if (!inst) return false;
  const rec = playerRec(username);
  if (!rec) return false;
  rec.instrumentId = inst.id;
  markDirty();
  return true;
}

function instrumentOf(username) {
  const rec = playerRec(username);
  return rec ? instrumentById(rec.instrumentId) : null;
}

// === Proficiency ===
function musicOf(username) {
  const rec = playerRec(username);
  return rec ? rec.music : 0;
}

function danceOf(username) {
  const rec = playerRec(username);
  return rec ? rec.dance : 0;
}

function addMusic(username, amount) {
  const rec = playerRec(username);
  if (!rec) return 0;
  rec.music = Math.max(0, Math.min(100, rec.music + amount));
  markDirty();
  return rec.music;
}

function addDance(username, amount) {
  const rec = playerRec(username);
  if (!rec) return 0;
  rec.dance = Math.max(0, Math.min(100, rec.dance + amount));
  markDirty();
  return rec.dance;
}

/** True when this citizen is a busker or bard (excluded from ensembles so nobody double-books). Defensive. */
function isStageProfessional(username) {
  try {
    const SP = require("./CitizenStreetPerformers");
    if (typeof SP.performerTypeOf === "function" && SP.performerTypeOf(username)) return true;
  } catch { /* module absent — no exclusion */ }
  try {
    const B = require("./CitizenBards");
    if (typeof B.bardTypeOf === "function" && B.bardTypeOf(username)) return true;
  } catch { /* module absent — no exclusion */ }
  return false;
}

// === Ensembles ===
function pickName(poolA, poolB, seedStr) {
  const h = fnv1a(seedStr);
  const a = poolA[h % poolA.length];
  const b = poolB[(h >>> 8) % poolB.length];
  return `The ${a} ${b}`;
}

function ensembles() {
  return load().ensembles;
}

function ensembleOf(username) {
  const key = normalizeName(username);
  return load().ensembles.find((e) => e.members.some((m) => normalizeName(m) === key)) ?? null;
}

/**
 * Form an ensemble around a leader. Returns the ensemble or null.
 * Leader + members need music >= ENSEMBLE_MIN_SKILL; stage professionals excluded.
 */
function formEnsemble(leaderUsername, memberUsernames) {
  const st = load();
  const leader = normalizeName(leaderUsername);
  if (!leader) return null;
  if (ensembleOf(leaderUsername)) return null; // one ensemble per citizen
  const members = [];
  const seen = new Set();
  const candidates = [leaderUsername, ...(memberUsernames ?? [])];
  for (const c of candidates) {
    const key = normalizeName(c);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (musicOf(c) < ENSEMBLE_MIN_SKILL) continue;
    if (isStageProfessional(c)) continue;
    members.push(key);
    if (members.length >= ENSEMBLE_MAX) break;
  }
  if (members.length < ENSEMBLE_MIN) return null;
  const ensemble = {
    id: `ens-${fnv1a(leader + Date.now()).toString(36)}`,
    name: pickName(ENSEMBLE_ADJECTIVES, ENSEMBLE_NOUNS, leader),
    leader: leader,
    members,
    formedAt: Date.now(),
    lastRehearsal: 0,
    concertsPlayed: 0,
  };
  st.ensembles.push(ensemble);
  markDirty();
  return ensemble;
}

function disbandEnsemble(ensembleId) {
  const st = load();
  const i = st.ensembles.findIndex((e) => e.id === ensembleId);
  if (i < 0) return false;
  st.ensembles.splice(i, 1);
  markDirty();
  return true;
}

// === Dance troupes ===
function troupes() {
  return load().troupes;
}

function troupeOf(username) {
  const key = normalizeName(username);
  if (!key) return null;
  return load().troupes.find((t) => (t.members ?? []).includes(key)) ?? null;
}

function formTroupe(leaderUsername, memberUsernames) {
  const st = load();
  const leader = normalizeName(leaderUsername);
  if (!leader) return null;
  if (troupeOf(leaderUsername)) return null;
  const members = [];
  const seen = new Set();
  const candidates = [leaderUsername, ...(memberUsernames ?? [])];
  for (const c of candidates) {
    const key = normalizeName(c);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (danceOf(c) < TROUPE_MIN_SKILL) continue;
    if (isStageProfessional(c)) continue;
    members.push(key);
    if (members.length >= TROUPE_MAX) break;
  }
  if (members.length < TROUPE_MIN) return null;
  const troupe = {
    id: `trp-${fnv1a(leader + Date.now()).toString(36)}`,
    name: pickName(TROUPE_ADJECTIVES, TROUPE_NOUNS, leader),
    leader: leader,
    members,
    formedAt: Date.now(),
    lastRehearsal: 0,
    concertsPlayed: 0,
  };
  st.troupes.push(troupe);
  markDirty();
  return troupe;
}

// === Dance halls ===
function danceHallOfKingdom(kingdomId) {
  if (!kingdomId) return null;
  return KINGDOM_DANCE_HALLS[String(kingdomId).toLowerCase()] ?? null;
}

/** Deterministic hall tile near the kingdom market (same pattern as guild halls). */
function hallTile(kingdomId) {
  const hall = danceHallOfKingdom(kingdomId);
  if (!hall) return null;
  const st = load();
  const key = String(kingdomId).toLowerCase();
  if (st.halls[key]) return st.halls[key];
  try {
    const Sites = require("./CitizenSites");
    const market = Sites.marketTileForKingdom?.(kingdomId) ?? Sites.marketTile?.(kingdomId);
    if (!market || typeof market.x !== "number") return null;
    const tile = { x: market.x + HALL_OFFSET.dx, y: market.y + HALL_OFFSET.dy, z: market.z ?? 0 };
    st.halls[key] = tile;
    markDirty();
    return tile;
  } catch {
    return null;
  }
}

// === Lessons ===
/**
 * Paid lesson. Moves REAL coins pupil -> teacher (caller performs the move
 * via transferCoins; this records skill + cooldown). Returns { ok, reason }.
 */
function giveLesson(teacherUsername, pupilUsername, kind, nowMs) {
  const st = load();
  const teacher = normalizeName(teacherUsername);
  const pupil = normalizeName(pupilUsername);
  if (!teacher || !pupil || teacher === pupil) return { ok: false, reason: "invalid" };
  if (kind !== "music" && kind !== "dance") return { ok: false, reason: "bad-kind" };
  const tRec = playerRec(teacherUsername);
  const pRec = playerRec(pupilUsername);
  if (!tRec || !pRec) return { ok: false, reason: "unknown" };
  const skill = kind === "music" ? tRec.music : tRec.dance;
  if (skill < TEACHER_MIN_SKILL) return { ok: false, reason: "not-skilled" };
  if ((pRec.lastLesson || 0) > 0 && nowMs - pRec.lastLesson < LESSON_COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  pRec.lastLesson = nowMs;
  if (kind === "music") pRec.music = Math.min(100, pRec.music + LESSON_GAIN);
  else pRec.dance = Math.min(100, pRec.dance + LESSON_GAIN);
  if (kind === "music") tRec.music = Math.min(100, tRec.music + LESSON_TEACHER_GAIN);
  else tRec.dance = Math.min(100, tRec.dance + LESSON_TEACHER_GAIN);
  markDirty();
  return { ok: true, price: LESSON_PRICE };
}

function canTeach(username, kind) {
  const rec = playerRec(username);
  if (!rec) return false;
  return (kind === "dance" ? rec.dance : rec.music) >= TEACHER_MIN_SKILL;
}

// === Practice ===
function practice(username, player, kind, nowMs) {
  const rec = playerRec(username);
  if (!rec) return { ok: false, reason: "unknown" };
  if ((rec.lastPractice || 0) > 0 && nowMs - rec.lastPractice < PRACTICE_COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  rec.lastPractice = nowMs;
  const withInstrument = kind === "music" && rec.instrumentId && playerHasInstrument(player, rec.instrumentId);
  const gain = withInstrument ? PRACTICE_GAIN_INSTRUMENT : PRACTICE_GAIN;
  if (kind === "dance") rec.dance = Math.min(100, rec.dance + gain);
  else rec.music = Math.min(100, rec.music + gain);
  markDirty();
  return { ok: true, gain, withInstrument: !!withInstrument };
}

// === Coins (honest, real inventories) ===
function coinCount(player) {
  try {
    const inv = player?.inventory ?? player?.inv ?? null;
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(COINS_ID) | 0;
    if (Array.isArray(inv)) {
      return inv.reduce((n, s) => n + (s && (s.id === COINS_ID || s.itemId === COINS_ID) ? (s.amount ?? s.qty ?? 1) : 0), 0);
    }
    return 0;
  } catch {
    return 0;
  }
}

function takeCoins(player, amount) {
  try {
    const inv = player?.inventory ?? player?.inv ?? null;
    if (!inv || typeof inv.remove !== "function") return false;
    if (coinCount(player) < amount) return false;
    inv.remove(COINS_ID, amount);
    return true;
  } catch {
    return false;
  }
}

function giveCoins(player, amount) {
  try {
    const inv = player?.inventory ?? player?.inv ?? null;
    if (!inv || typeof inv.add !== "function") return false;
    inv.add(COINS_ID, amount);
    return true;
  } catch {
    return false;
  }
}

// === Concerts ===
function concerts() {
  return load().concerts;
}

function concertFor(kingdomId) {
  const key = String(kingdomId ?? "").toLowerCase();
  return load().concerts.find((c) => c.kingdomId === key && c.status === "scheduled") ?? null;
}

/**
 * Schedule a concert in a kingdom. Picks the most-played ensemble available;
 * a troupe joins when one exists. Returns the concert or null.
 */
function scheduleConcert(kingdomId, nowMs, opts) {
  const st = load();
  const key = String(kingdomId ?? "").toLowerCase();
  if (!key || !danceHallOfKingdom(key)) return null;
  if (concertFor(key)) return null;
  const last = st.concerts.filter((c) => c.kingdomId === key).sort((a, b) => b.at - a.at)[0];
  if (last && nowMs - last.at < CONCERT_COOLDOWN_MS && !(opts && opts.force)) return null;
  const ensemble = st.ensembles
    .filter((e) => !e.kingdomId || e.kingdomId === key)
    .sort((a, b) => (b.concertsPlayed | 0) - (a.concertsPlayed | 0))[0] ?? null;
  if (!ensemble) return null;
  const troupe = st.troupes[0] ?? null;
  const festival = !!(opts && opts.festival);
  const concert = {
    id: `con-${fnv1a(key + nowMs).toString(36)}`,
    kingdomId: key,
    ensembleId: ensemble.id,
    ensembleName: ensemble.name,
    troupeId: troupe ? troupe.id : null,
    troupeName: troupe ? troupe.name : null,
    at: nowMs,
    ticketPrice: festival ? 0 : TICKET_PRICE,
    festival: festival,
    status: "scheduled",
    attendees: [],
    revenue: 0,
  };
  st.concerts.push(concert);
  markDirty();
  return concert;
}

/**
 * Buy a concert ticket. Moves REAL coins from the buyer (caller resolves the
 * player object; this validates). Returns { ok, reason }.
 */
function buyTicket(username, concertId, player, nowMs) {
  const st = load();
  const concert = st.concerts.find((c) => c.id === concertId && c.status === "scheduled");
  if (!concert) return { ok: false, reason: "no-concert" };
  const key = normalizeName(username);
  if (!key) return { ok: false, reason: "invalid" };
  if (concert.attendees.some((a) => a === key)) return { ok: false, reason: "already" };
  if (concert.ticketPrice > 0) {
    if (!takeCoins(player, concert.ticketPrice)) return { ok: false, reason: "broke" };
    concert.revenue += concert.ticketPrice;
  }
  concert.attendees.push(key);
  markDirty();
  return { ok: true, price: concert.ticketPrice };
}

/** Resolve a concert: split revenue, return payout records. Caller moves coins. */
function resolveConcert(concertId, nowMs) {
  const st = load();
  const concert = st.concerts.find((c) => c.id === concertId && c.status === "scheduled");
  if (!concert) return null;
  concert.status = "played";
  concert.resolvedAt = nowMs;
  const ensemble = st.ensembles.find((e) => e.id === concert.ensembleId);
  const troupe = concert.troupeId ? st.troupes.find((t) => t.id === concert.troupeId) : null;
  if (ensemble) ensemble.concertsPlayed = (ensemble.concertsPlayed | 0) + 1;
  if (troupe) troupe.concertsPlayed = (troupe.concertsPlayed | 0) + 1;
  const revenue = concert.revenue | 0;
  // 50% ensemble (split among members), 25% troupe, 25% hall/kingdom.
  const payouts = [];
  if (ensemble && revenue > 0) {
    const share = Math.floor((revenue * 0.5) / Math.max(1, ensemble.members.length));
    for (const m of ensemble.members) payouts.push({ username: m, amount: share, kind: "ensemble" });
  }
  if (troupe && revenue > 0) {
    const share = Math.floor((revenue * 0.25) / Math.max(1, troupe.members.length));
    for (const m of troupe.members) payouts.push({ username: m, amount: share, kind: "troupe" });
  }
  markDirty();
  return { concert, payouts, hallShare: Math.floor(revenue * 0.25) };
}

function recentConcerts(n) {
  return load().concerts
    .filter((c) => c.status === "played")
    .sort((a, b) => (b.resolvedAt | 0) - (a.resolvedAt | 0))
    .slice(0, n);
}

module.exports = {
  // tuning
  TICKET_PRICE,
  LESSON_PRICE,
  LESSON_GAIN,
  TEACHER_MIN_SKILL,
  ENSEMBLE_MIN_SKILL,
  TROUPE_MIN_SKILL,
  CONCERT_MOOD,
  CONCERT_MOOD_HEADLINER,
  COINS_ID,
  // instruments
  instruments,
  instrumentById,
  playerHasInstrument,
  setInstrument,
  instrumentOf,
  // proficiency
  musicOf,
  danceOf,
  addMusic,
  addDance,
  isStageProfessional,
  // ensembles & troupes
  ensembles,
  ensembleOf,
  formEnsemble,
  disbandEnsemble,
  troupes,
  troupeOf,
  formTroupe,
  // halls
  danceHallOfKingdom,
  hallTile,
  // lessons & practice
  giveLesson,
  canTeach,
  practice,
  // concerts
  concerts,
  concertFor,
  scheduleConcert,
  buyTicket,
  resolveConcert,
  recentConcerts,
  // honest coins
  coinCount,
  takeCoins,
  giveCoins,
  // persistence
  load,
  save,
  touch,
  resetForTests,
  _setSavePathForTests,
};
