"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenGuards2 — the citizen militia: gate wardens, wall walkers, night
 * sentries, and militiamen. Commoners who take turns standing the gates and
 * the walls, drill at the muster grounds, and form the levy when danger
 * comes — the armed conscience of the neighborhood, not professionals.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived militia types, per-day drill schedules, levy muster
 *   rosters, honor-guard ceremony days, per-day duty rotas, 7-day TTL
 *   ledgers for civic issue reports, levy sign-ups, and drill attendance.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted drill emotes, duty callouts, muster
 * announcements, honor-guard ceremony fanfare, militia offers.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the dockfolk block. Plain-node
 * testable: CitizenGuards2.test.js.
 *
 * No overlap (by design):
 *   - CitizenGuards owns the PROFESSIONAL watch (guard types, shifts, the
 *     wanted list, arrests, gate challenges) — citizens with role "guard"
 *     are excluded.
 *   - CitizenGuardPatrols owns checkpoint check-ins, fresh-disturbance
 *     response, escorts, torch announcements and reassurance — militia
 *     never responds to disturbances or escorts.
 *   - CitizenWatchmen2 owns the volunteer watch (night watchmen, day
 *     wardens, gate-minders, fire lookouts) — watchmanTypeOf() citizens
 *     are excluded so no one holds both posts.
 *   - Militia owns: citizen drill practice, levy muster rosters, honor-guard
 *     ceremonies, rotational gate/wall duty, civic issue reports.
 */

// === Tuning: all magic numbers here ===
const GUARDFOLK_RADIUS = 14; // tiles — close enough to see/hear
const GUARDFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const GUARDFOLK_CHANCE = 0.15; // per eligible citizen per tick
const GUARDFOLK_SHARE = 40; // ~40% nominal share of commoners
const CEREMONY_CHANCE = 0.08; // ~8% per muster ground per day
const DUTY_START_HOUR = 6; // 06:00 server local time
const DUTY_END_HOUR = 20; // 20:00 server local time
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The professional chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const Watchmen = safeRequire("./CitizenWatchmen2");
const Bonds = safeRequire("./CitizenBonds");

// === Guardfolk types ===
const GUARDFOLK_GATE = "gate-warden";
const GUARDFOLK_WALL = "wall-walker";
const GUARDFOLK_SENTRY = "night-sentry";
const GUARDFOLK_MILITIA = "militiaman";
const GUARDFOLK_TYPES = [
  GUARDFOLK_GATE,
  GUARDFOLK_WALL,
  GUARDFOLK_SENTRY,
  GUARDFOLK_MILITIA,
];
const GUARDFOLK_WEIGHTS = {
  [GUARDFOLK_GATE]: 30,
  [GUARDFOLK_WALL]: 25,
  [GUARDFOLK_SENTRY]: 20,
  [GUARDFOLK_MILITIA]: 25,
};

// === Muster grounds (kingdom-preferred) ===
const MUSTER_GROUNDS = [
  { name: "the Varrock Levy Field", kingdom: "misthalin" },
  { name: "the Lumbridge Muster Green", kingdom: "misthalin" },
  { name: "the Falador Parade Ground", kingdom: "asgarnia" },
  { name: "the White Knights' Drill Yard", kingdom: "asgarnia" },
  { name: "the Ardougne Militia Green", kingdom: "kandarin" },
  { name: "the Hemenster Training Field", kingdom: "kandarin" },
  { name: "the Keldagrim Assembly Square", kingdom: "keldagrim" },
  { name: "the Dorgesh Barracks Yard", kingdom: "keldagrim" },
  { name: "the Darkmeyer Night Watch Post", kingdom: "morytania" },
  { name: "the Al Kharid Guard Post", kingdom: "kharidian" },
];

// === Scripted lines ===
const DRILL_LINES = {
  [GUARDFOLK_GATE]: [
    "Papers? Name? Business inside?",
  ],
  [GUARDFOLK_WALL]: [
    "Wall's quiet today. Good. Quiet's the whole point.",
  ],
  [GUARDFOLK_SENTRY]: [
    "All's well on the east post.",
  ],
  [GUARDFOLK_MILITIA]: [
    "Shields up! Spears out! Hold the line!",
  ],
};

const MUSTER_LINES = [
  "Levy muster at {ground} — all able bodies, bring your boots!",
  "Drill's at {ground} today. Spears and shields.",
  "Militia forms up at {ground} — new recruits welcome!",
];

const CEREMONY_LINES = [
  "Honor guard forms up! Present arms!",
  "The honor guard marches at {ground} — come and watch!",
  "Stand tall, levy — the kingdom watches today!",
];

const ISSUE_ACK_LINES = [
  "I'll put it to the watch captain. {issue} — noted.",
  "Heard. The levy will keep an eye out for {issue}.",
];

const MILITIA_JOIN_LINES = [
  "The levy always needs strong arms. You're in.",
  "Welcome to the militia. Drill's at dawn — don't be late.",
];

// === Cooldown state ===
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

// === Ledgers (7-day TTL) ===
const issueReports = new Map(); // normName -> { issue, at }
const levyVolunteers = new Map(); // normName -> { at }
const drillAttendance = new Map(); // normName -> { ground, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of issueReports) {
    if (nowMs - v.at > LEDGER_TTL_MS) issueReports.delete(k);
  }
  for (const [k, v] of levyVolunteers) {
    if (nowMs - v.at > LEDGER_TTL_MS) levyVolunteers.delete(k);
  }
  for (const [k, v] of drillAttendance) {
    if (nowMs - v.at > LEDGER_TTL_MS) drillAttendance.delete(k);
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

/** Weighted pick of a guardfolk type from a 0..99 roll. */
function guardfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of GUARDFOLK_TYPES) {
    acc += GUARDFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return GUARDFOLK_GATE;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during duty hours (06:00-20:00 server local time). */
function isDutyHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= DUTY_START_HOUR && h < DUTY_END_HOUR;
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

/** True when the player object is a citizen bot. */
function isCitizenBot(player) {
  try {
    return player?.isPlayerBot?.() === true || player?.getHostAddress?.() === "bot";
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
// Guardfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The guardfolk type for a roster record, or null.
 * Excludes professional guards (role "guard" — CitizenGuards owns guard
 * types, shifts, the wanted list and arrests) and volunteer watchmen (the
 * real CitizenWatchmen2.watchmanTypeOf) so no citizen holds two posts.
 * Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function guardfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the volunteer watch owns night watchmen, day wardens,
    // gate-minders and fire lookouts.
    if (Watchmen && typeof Watchmen.watchmanTypeOf === "function") {
      try {
        if (Watchmen.watchmanTypeOf(record)) return null;
      } catch { /* watchman check failed */ }
    }
    const roll = hashStr(name + "|guardfolk") % 100;
    if (roll >= GUARDFOLK_SHARE) return null;
    return guardfolkTypeFromRoll(hashStr(name + "|guardfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred muster ground assignment, stable across restarts. */
function groundFor(record) {
  const kid = record?.kingdomId;
  const local = MUSTER_GROUNDS.filter((g) => g.kingdom === kid);
  const pool = local.length ? local : MUSTER_GROUNDS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|militia-ground") % pool.length];
}

// (drillsFor removed 2026-10-08: hash-derived fabrication.)

function DRILL_LINES_BY_TYPE(kinds) {
  const out = [];
  for (const k of kinds) {
    const lines = DRILL_LINES[k] ?? [];
    for (const l of lines) out.push(l);
  }
  return out;
}

// (ceremonyFor removed 2026-10-08: hash-derived fabrication.)

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Report a civic issue: recorded; the LLM tier handles dialogue. */
function reportIssue(playerName, issue, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !issue) return null;
  pruneLedgers(nowMs);
  issueReports.set(name, { issue: String(issue), at: nowMs });
  return String(issue);
}

/** The latest issue report from a player, or null. */
function issueFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = issueReports.get(name);
  return rec ? rec.issue : null;
}

/** Volunteer for the levy: recorded; the LLM tier handles dialogue. */
function joinMilitia(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  levyVolunteers.set(name, { at: nowMs });
  return name;
}

/** Whether a player volunteered for the levy (7-day TTL). */
function militiaFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return levyVolunteers.has(name);
}

/** Attend a drill: recorded; the LLM tier handles dialogue. */
function drillWith(playerName, groundName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !groundName) return null;
  pruneLedgers(nowMs);
  drillAttendance.set(name, { ground: String(groundName), at: nowMs });
  return String(groundName);
}

/** The last drill a player attended, or null. */
function drillFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = drillAttendance.get(name);
  return rec ? rec.ground : null;
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

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → guardfolk? → materialized → duty
// hours → real player near → chance → work.
// ============================================================================

function tickGuardfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < GUARDFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be guardfolk (hash-derived, cheap)
        const type = guardfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Duty hours only
        if (!isDutyHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, GUARDFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, GUARDFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doGuardfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-guardfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-guardfolk] tick failed:", e?.message ?? e);
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

function doGuardfolkWork(director, record, citizen, type, nowMs) {
  const ground = groundFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Honor-guard ceremony: once per ground per ceremony day, the crowd moment.
  // (Crowd-moment fabrication block removed 2026-10-08: ceremonyFor was hash-derived.)

  // Routine: drill emote, muster callout, militia offer.
  const roll = Math.random();
  if (roll < 0.45) {
    const line = pickOne(Math.random, DRILL_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    const journalEvent = journalize(record.username, "patrol", `drilled at ${ground.name}`);
    logGuardfolk(director, record, type, "drill", ground, journalEvent, null);
  } else if (roll < 0.75) {
    const line = fill(pickOne(Math.random, MUSTER_LINES), { ground: ground.name });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    const journalEvent = journalize(record.username, "patrol", `called the muster at ${ground.name}`);
    logGuardfolk(director, record, type, "muster", ground, journalEvent, null);
  } else {
    const line = pickOne(Math.random, MILITIA_JOIN_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    const journalEvent = journalize(record.username, "patrol", `recruited for the levy at ${ground.name}`);
    logGuardfolk(director, record, type, "recruit", ground, journalEvent, null);
  }
}

module.exports = {
  tickGuardfolk,
  guardfolkTypeOf,
  reportIssue,
  issueFor,
  joinMilitia,
  militiaFor,
  drillWith,
  drillFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  groundFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  guardfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isDutyHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  GUARDFOLK_TYPES,
  GUARDFOLK_GATE,
  GUARDFOLK_WALL,
  GUARDFOLK_SENTRY,
  GUARDFOLK_MILITIA,
  MUSTER_GROUNDS,
  DRILL_LINES,
  MUSTER_LINES,
  CEREMONY_LINES,
  ISSUE_ACK_LINES,
  MILITIA_JOIN_LINES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    issueReports.clear();
    levyVolunteers.clear();
    drillAttendance.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
