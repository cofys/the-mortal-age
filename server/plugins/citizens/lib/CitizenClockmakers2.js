"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenClockmakers2 — the timefolk: knocker-uppers tapping on shutters
 * before dawn, bell-tenders pulling the hour rope on the tower steps,
 * hour-callers crying the time in the squares, and sandglass-minders turning
 * the tavern and wharf glasses. Commoners who live off the street economy
 * of PUBLIC time — the announcement and keeping of the hours — under the
 * master clockmakers' guild workshops.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived timefolk types (~40% nominal share, post-exclusion),
 *   per-day knocker-up rounds, bell towers, calling squares and sandglass
 *   spots, a wake-up-call ledger (until the hour passes), and bell-rope-snap
 *   / hoarse-caller / clogged-sandglass set-pieces (~6-8%/kingdom/day,
 *   journaled + rumor-seeded). The masters' headline work is cross-read from
 *   CitizenClockmakers (workshopFor + greatWorkFor) so timefolk small talk
 *   names the real guild workshops. Claimed pro clockmakers are excluded via
 *   the real module's clockmakerTypeOf null path.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 04:00-21:00 local): scripted knock/ring/call/turn emotes, wake-up-call
 * offers that name the requesting player (interaction priority), the full
 * peal as the crowd moment, and guild-workshop small talk. Wake-up dialogue
 * itself is LLM tier — this module only tracks state, timers and the
 * visible street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the laborfolk block.
 * Plain-node testable: CitizenClockmakers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenClockmakers owns the PROFESSIONAL horology trade (horologists,
 *     assemblers, repairers, sellers; tower-clock escapements, marine
 *     chronometers, masterworks, commissions, great works) — the claimed
 *     master clockmakers are excluded via the real module's clockmakerTypeOf
 *     null path. Timefolk never build, repair, assemble or sell clockwork;
 *     they pull bell ropes, call hours and turn sandglasses.
 *   - CitizenEngineers own machines — timefolk never touch machinery.
 *   - CitizenMessengers own PROCLAMATIONS of news (heralds crying decrees,
 *     event announcements, weather warnings) — hour-callers cry the TIME
 *     only, never news or decrees.
 *   - CitizenStreetPerformers own entertainment — the full peal is a civic
 *     ritual, not a show.
 *   - CitizenHawker owns street HAWKING of goods — timefolk sell no goods.
 *   - CitizenWatchmen/CitizenGuards own the watch — timefolk wake sleepers
 *     by request, never patrol or stand guard.
 */

// === Tuning: all magic numbers here ===
const TIMEFOLK_RADIUS = 14; // tiles — close enough to see/hear
const TIMEFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const TIMEFOLK_CHANCE = 0.15; // per eligible citizen per tick
const TIMEFOLK_SHARE = 40; // ~40% nominal share of commoners (post-exclusion)
const PEAL_CHANCE = 0.08; // full peal at a bell, per bell per day
const ROPE_SNAP_CHANCE = 0.06; // ~6% per kingdom per day: bell rope snaps
const HOARSE_CHANCE = 0.08; // ~8% per kingdom per day: hour-caller loses their voice
const CLOGGED_CHANCE = 0.07; // ~7% per kingdom per day: a sandglass clogs
const WORK_START_HOUR = 4; // 04:00 server local time (knocker-uppers pre-dawn)
const WORK_END_HOUR = 21; // 21:00 server local time
const WAKEUP_GRACE_MS = 3 * 3600 * 1000; // wake-up calls stay due 3h past the hour

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProClockmakers = safeRequire("./CitizenClockmakers");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Timefolk types ===
const KNOCKER_UPPER = "knocker-upper";
const BELL_TENDER = "bell-tender";
const HOUR_CALLER = "hour-caller";
const SANDGLASS_MINDER = "sandglass-minder";
const TIMEFOLK_TYPES = [
  KNOCKER_UPPER,
  BELL_TENDER,
  HOUR_CALLER,
  SANDGLASS_MINDER,
];
const TIMEFOLK_WEIGHTS = {
  [KNOCKER_UPPER]: 25,
  [BELL_TENDER]: 25,
  [HOUR_CALLER]: 30,
  [SANDGLASS_MINDER]: 20,
};

// === Knocker-up rounds — streets walked before dawn, not workshops. ===
const ROUNDS = [
  { name: "the Varrock eastgate shutters", kingdom: "misthalin" },
  { name: "the Lumbridge millers' row", kingdom: "misthalin" },
  { name: "the Falador artisans' quarter", kingdom: "asgarnia" },
  { name: "the Port Sarim dockers' tenements", kingdom: "asgarnia" },
  { name: "the Seers' village cottages", kingdom: "kandarin" },
  { name: "the Catherby fisher huts", kingdom: "kandarin" },
  { name: "the Keldagrim shaft-side lodgings", kingdom: "keldagrim" },
  { name: "the Dorgeshuun burrow doors", kingdom: "keldagrim" },
  { name: "the Canifis crofters' doors", kingdom: "morytania" },
  { name: "the Meiyerditch shutters", kingdom: "morytania" },
  { name: "the Al Kharid weavers' street", kingdom: "kharidian" },
  { name: "the Pollnivneach merchant row", kingdom: "kharidian" },
];

// === Bell towers — public hour bells, never the guilds' precision works. ===
const BELLS = [
  { name: "the Varrock square bell", kingdom: "misthalin" },
  { name: "the Lumbridge chapel bell", kingdom: "misthalin" },
  { name: "the Falador west-gate bell", kingdom: "asgarnia" },
  { name: "the Port Sarim tide bell", kingdom: "asgarnia" },
  { name: "the Seers' hall bell", kingdom: "kandarin" },
  { name: "the Ardougne market bell", kingdom: "kandarin" },
  { name: "the Keldagrim deep bell", kingdom: "keldagrim" },
  { name: "the Dorgeshuun cavern chime", kingdom: "keldagrim" },
  { name: "the Canifis gate bell", kingdom: "morytania" },
  { name: "the Burgh de Rott watch bell", kingdom: "morytania" },
  { name: "the Al Kharid palace bell", kingdom: "kharidian" },
  { name: "the Shantay pass bell", kingdom: "kharidian" },
];

// === Calling squares — where the hour-callers cry the time. ===
const SQUARES = [
  { name: "Varrock market square", kingdom: "misthalin" },
  { name: "Lumbridge town green", kingdom: "misthalin" },
  { name: "Falador park corner", kingdom: "asgarnia" },
  { name: "Port Sarim quayside", kingdom: "asgarnia" },
  { name: "Seers' village square", kingdom: "kandarin" },
  { name: "East Ardougne plaza", kingdom: "kandarin" },
  { name: "Keldagrim palace forecourt", kingdom: "keldagrim" },
  { name: "Dorgeshuun market tier", kingdom: "keldagrim" },
  { name: "Canifis town square", kingdom: "morytania" },
  { name: "the Myreque hideout steps", kingdom: "morytania" },
  { name: "Al Kharid duel arena gate", kingdom: "kharidian" },
  { name: "Pollnivneach bazaar mouth", kingdom: "kharidian" },
];

// === Sandglass spots — taverns, wharves and guild halls where the glasses
// are turned, never the masters' chronometers. ===
const GLASSES = [
  { name: "the Blue Moon Inn bar", kingdom: "misthalin" },
  { name: "the Lumbridge mill landing", kingdom: "misthalin" },
  { name: "the Rising Sun Inn common room", kingdom: "asgarnia" },
  { name: "the Port Sarim customs shed", kingdom: "asgarnia" },
  { name: "the Seers' pub snug", kingdom: "kandarin" },
  { name: "the Ardougne dock office", kingdom: "kandarin" },
  { name: "the Keldagrim consortium hall", kingdom: "keldagrim" },
  { name: "the Dorgeshuun food hall", kingdom: "keldagrim" },
  { name: "the Canifis tavern bar", kingdom: "morytania" },
  { name: "the Burgh de Rott inn", kingdom: "morytania" },
  { name: "the Al Kharid kebab shop counter", kingdom: "kharidian" },
  { name: "the Shantay pass toll booth", kingdom: "kharidian" },
];

// === Line pools — all scripted, zero LLM. ===

// Knocker-uppers: pre-dawn rounds, tapping shutters.
const KNOCK_LINES = [
  "Knock knock! Up you get — the mill won't wait!",
  "Fourth bell and all's well — rise and shine, {round}!",
  "Tap tap! Knocker-upper's rounds — don't sleep the morning away!",
  "Morning, morning! The shift starts at the fifth bell!",
  "Up you get! I'll be back this way at supper — the same knock!",
  "Wake, wake! The frost's on the shutters and the work's already started!",
];
// Knocker-uppers offering the service (the LLM tier does the actual booking).
const WAKEUP_OFFER_LINES = [
  "Want a knock at a chosen bell? Say the word — I'll tap your shutters!",
  "Knocker-upper's rounds! Name your bell and I'll not miss it!",
  "Sleep through the shift and the foreman docks you — want me to knock?",
  "A penny a week and I wake you true. Say the bell, I'll be there!",
];
// Wake-up callouts — interaction priority: they name the requesting player.
const WAKEUP_LINES = [
  "{player}! Up you get — you asked for the {hour} bell!",
  "Rise and shine, {player} — {hour} of the clock, as promised!",
  "Tap tap, {player}! The {hour} bell is yours — don't make me come back!",
  "{player}, up! The hour you named has struck — rise!",
];

// Bell-tenders: pulling the hour rope.
const BELL_LINES = [
  "Hear the bell — {hour} of the clock!",
  "The tower bell tolls {hour}! Mind the hour, friends!",
  "That's {bell} ringing {hour} — set your day by it!",
  "Up with the rope — {hour} bells for {bell}!",
  "Hear ye, hear ye — {hour} of the clock by the bell!",
];
// The full peal — the crowd moment, once per bell per day.
const PEAL_LINES = [
  "THE FULL PEAL at {bell}! Come hear the hours rung proper!",
  "A full peal for {bell} — the finest ringing this side of the {kingdom} hills!",
  "Gather round — {bell} rings the full peal, every rope pulled true!",
];
// Rope-snap set-piece: the bell-tender's tragedy.
const ROPE_SNAP_LINES = [
  "The rope's snapped at {bell}! No hours rung today — we're on guesswork!",
  "Snap! The bell rope's gone at {bell}. Somebody fetch the rigger!",
  "No bell today at {bell} — rope's snapped clean. Ask the sun, not me!",
];

// Hour-callers: crying the time in the squares.
const HOUR_CALL_LINES = [
  "{hour} of the clock! {hour} of the clock, all's well!",
  "Hear ye — {hour} bells! The day turns!",
  "It's {hour} by the tower — mind the hour, good folk!",
  "{hour}! The criers of {square} keep the time true!",
];
// Hoarse set-piece: the caller lost their voice.
const HOARSE_LINES = [
  "(croak) ...{hour}... of the... (cough) ...clock... (croak)",
  "Hear... (wheeze) ...{hour}... somebody bring me honey and hot ale...",
  "(hoarse whisper) it's {hour}, it is, you'll have to take my word for it...",
];

// Sandglass-minders: turning the tavern and wharf glasses.
const GLASS_LINES = [
  "Sandglass turned at {spot} — the round starts now!",
  "Glass is running at {spot} — mind the sand, lads!",
  "Turned and true at {spot} — the hourglass keeps honest time!",
  "Fresh turn on the glass at {spot} — nobody drinks past the sand!",
];
// Clogged set-piece: the glass lied all morning.
const CLOGGED_LINES = [
  "The glass at {spot} is clogged — half the tavern ate lunch an hour early!",
  "Sand's stuck at {spot}! We're all running late and nobody knows by how much!",
  "Clogged glass at {spot} — the wharf crew loaded the wrong tide. Chaos!",
];

// Pro-clock small talk — names the real guild workshops, cross-read.
const PRO_CLOCK_LINES = [
  "They say {workshop} is raising {work} — the masters never rest!",
  "Heard the guild talk: {workshop} has {work} on the bench!",
  "The clockmakers at {workshop} are fitting {work} — precision work, that!",
];

// Today's task lines per type (for journals).
const DAILY_TASK_LINES = {
  [KNOCKER_UPPER]: [
    "walked the knocker-up round at {place}",
    "tapped the shutters along {place}",
    "woke the early shift on {place}",
  ],
  [BELL_TENDER]: [
    "pulled the hour rope at {place}",
    "rang the hours from {place}",
    "kept the bell true at {place}",
  ],
  [HOUR_CALLER]: [
    "cried the hours in {place}",
    "called the time through {place}",
    "kept the square honest at {place}",
  ],
  [SANDGLASS_MINDER]: [
    "turned the glasses at {place}",
    "minded the sand at {place}",
    "kept the tide-glasses flowing at {place}",
  ],
};
// === Cooldown state (monotonic Date.now() timestamps) ===
const lastFiredByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Wake-up ledger (TTL'd) ===
const wakeups = new Map(); // normPlayerName -> { wakeup }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of wakeups) {
    if (v.wakeup.until <= nowMs) wakeups.delete(k);
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

/** Weighted pick of a timefolk type from a 0..99 roll. */
function timefolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of TIMEFOLK_TYPES) {
    acc += TIMEFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return KNOCKER_UPPER;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during work hours (04:00-21:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
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

/** Cheap rng from a seed (mulberry-ish LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

/** Normalized username via CitizenBonds (fallback: lowercase). */
function normalizeName(name) {
  try {
    if (Bonds && typeof Bonds.normalizeName === "function") return Bonds.normalizeName(name);
  } catch { /* fall through */ }
  return String(name ?? "").toLowerCase();
}

// ============================================================================
// Timefolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The timefolk type for a roster record, or null.
 * Excludes the claimed pro clockmakers (the real CitizenClockmakers
 * clockmakerTypeOf null path — unclaimed names read null, so it is a valid
 * eligibility gate): the masters own the timepieces and tower-clock works,
 * timefolk own the ropes, rounds, calls and sandglasses.
 * Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function timefolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the claimed pro clockmakers own the trade.
    try {
      if (ProClockmakers && typeof ProClockmakers.clockmakerTypeOf === "function" && ProClockmakers.clockmakerTypeOf(record)) {
        return null;
      }
    } catch { /* pro check failed — treat as unclaimed */ }
    const roll = hashStr(name + "|timefolk") % 100;
    if (roll >= TIMEFOLK_SHARE) return null;
    return timefolkTypeFromRoll(hashStr(name + "|timefolk-type") % 100);
  } catch {
    return null;
  }
}

/** The day's spot for a timefolk citizen: round, bell, square or glass, by type. */
function spotFor(record, type, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const pool =
      type === KNOCKER_UPPER ? ROUNDS :
      type === BELL_TENDER ? BELLS :
      type === HOUR_CALLER ? SQUARES :
      type === SANDGLASS_MINDER ? GLASSES : SQUARES;
    const local = kid ? pool.filter((s) => s.kingdom === kid) : [];
    const src = local.length ? local : pool;
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|timefolkspot:" + day));
    return pickOne(rng, src);
  } catch {
    return null;
  }
}

// (taskForToday removed 2026-10-08: hash-derived fabrication.)

// ============================================================================
// Daily set-pieces (seeded per kingdom per day, ~6-8%/kingdom/day).
// ============================================================================

/** Bell-rope snap: the kingdom's bell rings no hours today. */
function ropeSnapFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("ropesnap:" + kingdomId + ":" + day)), ROPE_SNAP_CHANCE);
}

/** Hoarse hour-caller: the crier lost their voice today. */
function hoarseFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("hoarse:" + kingdomId + ":" + day)), HOARSE_CHANCE);
}

/** Clogged sandglass: the glasses lie all morning. */
function cloggedFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("clogged:" + kingdomId + ":" + day)), CLOGGED_CHANCE);
}

/** The full peal rings at this bell today (the crowd moment). */
function pealFor(bell, dateMs) {
  if (!bell) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("peal:" + bell.name + ":" + day)), PEAL_CHANCE);
}

// ============================================================================
// Real-data bridges — the master clockmakers, cross-read.
// ============================================================================

/**
 * Read-only bridge: the kingdom's guild workshop and its great work of the
 * day, drawn from the real CitizenClockmakers workshop pools, so timefolk
 * small talk stays consistent with what the guild is actually building.
 * Returns { workshop, work } or null. Never throws.
 */
function proClockFor(kingdomId, nowMs = Date.now()) {
  try {
    if (!ProClockmakers || typeof ProClockmakers.workshopFor !== "function") return null;
    if (typeof ProClockmakers.greatWorkFor !== "function") return null;
    const kid = String(kingdomId ?? "");
    if (!kid) return null;
    const workshop = ProClockmakers.workshopFor({ username: "timefolk:" + kid, kingdomId: kid });
    if (!workshop || !workshop.name) return null;
    const great = ProClockmakers.greatWorkFor(workshop, nowMs);
    return { workshop, work: great?.work ?? null };
  } catch {
    return null;
  }
}

// ============================================================================
// Wake-up-call ledger (data tier, zero LLM).
// ============================================================================

/**
 * A player books a knocker-upper for a chosen hour: the timefolk remembers
 * the request until a few hours past the hour. The LLM dialogue tier takes
 * the booking; this module only tracks state and fires the visible call.
 */
function requestWakeup(playerName, timefolkName, hour, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const tname = normalizeName(timefolkName);
  const h = Math.max(0, Math.min(23, Math.floor(Number(hour))));
  if (!name || !tname || !Number.isFinite(h)) return null;
  const d = new Date(nowMs);
  d.setHours(h, 0, 0, 0);
  let wakeTime = d.getTime();
  if (wakeTime <= nowMs) wakeTime += 24 * 3600 * 1000; // next occurrence
  const wakeup = { player: name, timefolk: tname, hour: h, wakeTime, until: wakeTime + WAKEUP_GRACE_MS };
  wakeups.set(name, { wakeup });
  pruneLedgers(nowMs);
  return wakeup;
}

/** The player's outstanding wake-up call, or null. */
function wakeupFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = wakeups.get(name);
  if (!rec || rec.wakeup.until <= nowMs) return null;
  return rec.wakeup;
}

/** The player cancels their wake-up call. */
function cancelWakeup(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return wakeups.delete(name);
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

// Canonical: getJournal().log(name, kind, text). The appendEntry/addEntry
// probe pattern is dead — CitizenJournal only exports getJournal() with a
// log() method.
let _journal = null;
function journal() {
  if (_journal === null) {
    try {
      _journal = require("./CitizenJournal").getJournal();
    } catch {
      _journal = false;
    }
  }
  return _journal || null;
}

function journalize(citizenName, text) {
  try {
    journal()?.log(citizenName, "work", text);
  } catch {
    /* journal is best-effort; never break the tick */
  }
}

function seedRumor(event) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(Math.random, event);
  } catch {
    /* rumors absent */
  }
}

/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → timefolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickTimefolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < TIMEFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible timefolk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be timefolk (hash-derived, cheap; exclusions inside)
        const type = timefolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Work hours only (priority-branch ticks inside work hours)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, TIMEFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, TIMEFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doTimefolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-timefolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: peals, rope snaps, hoarse callers and clogged glasses
    // (cheap, day-gated).
    // (dailyRhythms removed 2026-10-08: hash-derived fake events.)
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-timefolk] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doTimefolkWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const day = dayNumber(nowMs);
  const hour = new Date(nowMs).getHours();
  const spot = spotFor(record, type, nowMs);
  const place = spot ? spot.name : "the town square";

  // A due wake-up call naming THIS timefolk takes priority: name the player.
  if (type === KNOCKER_UPPER) {
    const due = nearbyDueWakeup(director, citizen, name, nowMs);
    if (due) {
      forceSay(citizen, fill(pickOne(Math.random, WAKEUP_LINES), { player: due.player, hour: due.hour }));
      journalize(citizen, `knocked up ${due.player} for the ${due.hour} bell`);
      return;
    }
  }

  // The full peal: once per bell per day, the crowd moment.
  if (type === BELL_TENDER && spot && pealFor(spot, nowMs)) {
    const key = "timepeal:" + spot.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, PEAL_LINES), { bell: spot.name, kingdom: kid ?? "the kingdom" }));
      journalize(citizen, `rang the full peal at ${spot.name}`);
      seedRumor({ kind: "work", what: `A full peal rang out at ${spot.name}!` });
      return;
    }
  }

  const proj = kid ? proClockFor(kid, nowMs) : null;

  if (type === KNOCKER_UPPER) {
    const roll = Math.random();
    if (roll < 0.5) {
      forceSay(citizen, fill(pickOne(Math.random, KNOCK_LINES), { round: place }));
      journalize(citizen, `worked at ${place} — knocked the rounds`);
    } else if (roll < 0.75) {
      forceSay(citizen, pickOne(Math.random, WAKEUP_OFFER_LINES));
      journalize(citizen, `offered wake-up calls on the round at ${place}`);
    } else if (proj && proj.work) {
      forceSay(citizen, fill(pickOne(Math.random, PRO_CLOCK_LINES), { workshop: proj.workshop.name, work: proj.work }));
      journalize(citizen, `talked guild news on the round at ${place}`);
    } else {
      forceSay(citizen, fill(pickOne(Math.random, KNOCK_LINES), { round: place }));
      journalize(citizen, `walked the knocker-up round at ${place}`);
    }
    return;
  }

  if (type === BELL_TENDER) {
    if (kid && ropeSnapFor(kid, nowMs)) {
      forceSay(citizen, fill(pickOne(Math.random, ROPE_SNAP_LINES), { bell: place }));
      journalize(citizen, `mourned the snapped rope at ${place}`);
      return;
    }
    const roll = Math.random();
    if (roll < 0.65) {
      forceSay(citizen, fill(pickOne(Math.random, BELL_LINES), { hour, bell: place }));
      journalize(citizen, `worked at ${place}`);
    } else if (proj && proj.work) {
      forceSay(citizen, fill(pickOne(Math.random, PRO_CLOCK_LINES), { workshop: proj.workshop.name, work: proj.work }));
      journalize(citizen, `talked guild news between bells at ${place}`);
    } else {
      forceSay(citizen, fill(pickOne(Math.random, BELL_LINES), { hour, bell: place }));
      journalize(citizen, `rang ${hour} of the clock at ${place}`);
    }
    return;
  }

  if (type === HOUR_CALLER) {
    if (kid && hoarseFor(kid, nowMs)) {
      forceSay(citizen, fill(pickOne(Math.random, HOARSE_LINES), { hour }));
      journalize(citizen, `croaked the hours hoarsely in ${place}`);
      return;
    }
    const roll = Math.random();
    if (roll < 0.65) {
      forceSay(citizen, fill(pickOne(Math.random, HOUR_CALL_LINES), { hour, square: place }));
      journalize(citizen, `worked at ${place}`);
    } else if (proj && proj.work) {
      forceSay(citizen, fill(pickOne(Math.random, PRO_CLOCK_LINES), { workshop: proj.workshop.name, work: proj.work }));
      journalize(citizen, `talked guild news while calling hours in ${place}`);
    } else {
      forceSay(citizen, fill(pickOne(Math.random, HOUR_CALL_LINES), { hour, square: place }));
      journalize(citizen, `cried ${hour} of the clock in ${place}`);
    }
    return;
  }

  // Sandglass-minder.
  if (kid && cloggedFor(kid, nowMs) && Math.random() < 0.5) {
    forceSay(citizen, fill(pickOne(Math.random, CLOGGED_LINES), { spot: place }));
    journalize(citizen, `unclogged the sandglass at ${place}`);
    return;
  }
  {
    const roll = Math.random();
    if (roll < 0.65) {
      forceSay(citizen, fill(pickOne(Math.random, GLASS_LINES), { spot: place }));
      journalize(citizen, `worked at ${place}`);
    } else if (proj && proj.work) {
      forceSay(citizen, fill(pickOne(Math.random, PRO_CLOCK_LINES), { workshop: proj.workshop.name, work: proj.work }));
      journalize(citizen, `talked guild news over the glasses at ${place}`);
    } else {
      forceSay(citizen, fill(pickOne(Math.random, GLASS_LINES), { spot: place }));
      journalize(citizen, `turned the sandglass at ${place}`);
    }
  }
}

/** A nearby real player whose wake-up call is due and names this timefolk. */
function nearbyDueWakeup(director, citizen, timefolkName, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, TIMEFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) return null;
      const w = wakeupFor(pname, nowMs);
      if (w && w.timefolk === timefolkName && nowMs >= w.wakeTime) return w;
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day kingdom rhythms: peals, rope snaps, hoarse callers, clogs. */
// (function dailyRhythms removed 2026-10-08: hash-derived fake events.)

module.exports = {
  tickTimefolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  timefolkTypeOf,
  spotFor,
  ropeSnapFor,
  hoarseFor,
  cloggedFor,
  pealFor,
  proClockFor,
  requestWakeup,
  wakeupFor,
  cancelWakeup,
  nearbyDueWakeup,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  timefolkTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  TIMEFOLK_TYPES,
  KNOCKER_UPPER,
  BELL_TENDER,
  HOUR_CALLER,
  SANDGLASS_MINDER,
  ROUNDS,
  BELLS,
  SQUARES,
  GLASSES,
  // Tuning (tests pin the documented behavior):
  TIMEFOLK_RADIUS,
  TIMEFOLK_CITIZEN_COOLDOWN_MS,
  TIMEFOLK_CHANCE,
  TIMEFOLK_SHARE,
  PEAL_CHANCE,
  ROPE_SNAP_CHANCE,
  HOARSE_CHANCE,
  CLOGGED_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  TIMEFOLK_TYPES_WEIGHTS: TIMEFOLK_WEIGHTS,
  WAKEUP_GRACE_MS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    wakeups.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
