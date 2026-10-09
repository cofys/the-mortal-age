"use strict";

/**
 * CitizenWatchmen2 — the volunteer watch: night watchmen who walk the lanes
 * with lanterns, day wardens who keep an eye on the markets, gate-minders
 * who watch shop and stall doorways, and fire lookouts who scan the
 * rooftops for smoke.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived watchman types, per-day patrol rotas (1-2 beats derived
 *   from date + hash), named beats per kingdom, and rare fire-scare events
 *   (~5%/kingdom/night). Watchmen reference the official guard shift (read
 *   from the real CitizenGuards.shiftForHour) so volunteer rounds line up
 *   with the professional watch's day/night changeover. 7-day TTL player
 *   ledgers for crime reports, volunteer sign-ups and warden hires —
 *   exported for the LLM dialogue tier.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   scripted patrol callouts ("All's well on the east lane."), lantern
 *   checks, gate-minder door-watching, and fire-alarm fanfare as the crowd
 *   moment when a lookout spots smoke (seeded into CitizenRumors).
 *   Night watch works 20:00-06:00 server-local, day wardens 08:00-18:00,
 *   gate-minders 08:00-20:00, fire lookouts 18:00-08:00.
 *
 * No overlap (by design):
 * - CitizenGuards own the PROFESSIONAL watch: guard types, shifts, the
 *   wanted list, arrests, gate challenges. Citizens with role "guard" are
 *   EXCLUDED here — this module owns the volunteer side only.
 * - CitizenGuardPatrols own official patrols: checkpoint check-ins,
 *   disturbance response, escorts, torch announcements. Watchmen here
 *   never respond to disturbances or escort — they watch, call out, and
 *   report to the real watch.
 *
 * Zero LLM: scripted line pools; the journal feeds the LLM mouth.
 *
 * Activity system (no professional exclusion chain): any commoner may
 * volunteer. Deliberately NOT in HOBBY_KEYS: visibility is throttled via
 * chance + cooldown (the couriers/healers2 precedent) instead of adding
 * another hobby key.
 * Plain-node testable: CitizenWatchmen2.test.js.
 *
 * Wired into the director tick right after the caregivers block.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// Top-level requires (perf lesson from the artisan fix): the tie-in modules
// are linear deps with no back-references to this module, so hoisting is
// cycle-safe. safeRequire preserves the "module absent" fallback.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const GuardsPro = safeRequire("./CitizenGuards");

// === Tuning ===
const WATCH_RADIUS = 14; // tiles — close enough to see/hear
const WATCH_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen watches this often
const WATCH_CHANCE = 0.15; // per eligible citizen per tick (couriers-style narrowing)
const GATE_START_HOUR = 8; // 08:00 server-local
const GATE_END_HOUR = 20; // 20:00 server-local
const DAY_START_HOUR = 8; // 08:00 server-local
const DAY_END_HOUR = 18; // 18:00 server-local
const NIGHT_START_HOUR = 20; // 20:00 server-local
const NIGHT_END_HOUR = 6; // 06:00 server-local (wraps midnight)
const FIRE_START_HOUR = 18; // 18:00 server-local
const FIRE_END_HOUR = 8; // 08:00 server-local (wraps midnight)
const FIRE_SCARE_CHANCE = 0.05; // per kingdom per night: a lookout spots smoke
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BEATS_PER_DAY = 2;

// === Watchman types ===
const WATCH_NIGHT = "night-watchman";
const WATCH_DAY = "day-warden";
const WATCH_GATE = "gate-minder";
const WATCH_FIRE = "fire-lookout";
const WATCH_TYPES = [WATCH_NIGHT, WATCH_DAY, WATCH_GATE, WATCH_FIRE];
const WATCH_WEIGHTS = {
  [WATCH_NIGHT]: 30,
  [WATCH_DAY]: 25,
  [WATCH_GATE]: 25,
  [WATCH_FIRE]: 20,
};

// === Patrol beats (kingdom-preferred) ===
const BEATS = [
  { name: "the east lane", kingdom: "misthalin" },
  { name: "the Varrock west wall", kingdom: "misthalin" },
  { name: "the Falador market row", kingdom: "asgarnia" },
  { name: "the White Knight barracks gate", kingdom: "asgarnia" },
  { name: "the Ardougne bazaar", kingdom: "kandarin" },
  { name: "the Hemenster docks", kingdom: "kandarin" },
  { name: "the Keldagrim deep gate", kingdom: "keldagrim" },
  { name: "the Dorgesh market burrow", kingdom: "keldagrim" },
  { name: "the Darkmeyer blood-alley", kingdom: "morytania" },
  { name: "the Al Kharid spice souk", kingdom: "kharidian" },
];

// === Scripted lines ===
const PATROL_LINES = {
  [WATCH_NIGHT]: [
    "All's well on the {beat}.",
    "Night watch! Show your face or keep moving.",
    "Quiet tonight. The {shift} watch holds the walls.",
  ],
  [WATCH_DAY]: [
    "Easy there — the warden's watching.",
    "Keep your hands to yourself on the {beat}.",
    "Peaceful morning on the {beat}. Good.",
  ],
  [WATCH_GATE]: [
    "Mind the door — I'll keep an eye on it.",
    "None pass without a nod on my beat.",
  ],
  [WATCH_FIRE]: [
    "No smoke on the horizon. Good.",
    "Dry night — mind your candles, all of you.",
  ],
};

const REPORT_ACK_LINES = [
  "Noted. I'll pass word to the watch.",
  "I'll keep an eye out for that. The watch thanks you.",
  "Heard. We'll double the rounds past the {beat}.",
];

const JOIN_WATCH_LINES = [
  "A volunteer! The {beat} needs eyes — take a lantern.",
  "Good. Report to the {beat} at dusk, and walk it slow.",
];

const HIRE_WARDEN_LINES = [
  "I'll watch your stall myself. Nothing walks off on my beat.",
  "Done. Your goods are safe while I stand here.",
];

const FIRE_ALARM_LINES = [
  "FIRE! Smoke over the {beat}! Fetch water!",
  "Smoke! The {beat} is burning — sound the alarm!",
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
const crimeReports = new Map(); // normName -> { details, at }
const watchVolunteers = new Map(); // normName -> { at }
const wardenHires = new Map(); // normName -> { at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of crimeReports) {
    if (nowMs - v.at > LEDGER_TTL_MS) crimeReports.delete(k);
  }
  for (const [k, v] of watchVolunteers) {
    if (nowMs - v.at > LEDGER_TTL_MS) watchVolunteers.delete(k);
  }
  for (const [k, v] of wardenHires) {
    if (nowMs - v.at > LEDGER_TTL_MS) wardenHires.delete(k);
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

/** Weighted pick of a watchman type from a 0..99 roll. */
function watchmanTypeFromRoll(roll) {
  let acc = 0;
  for (const t of WATCH_TYPES) {
    acc += WATCH_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return WATCH_NIGHT;
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

/** Hour in [start, end) server-local; wraps midnight when end < start. */
function hourInWindow(nowMs, start, end) {
  const h = new Date(nowMs).getHours();
  if (end > start) return h >= start && h < end;
  return h >= start || h < end;
}

/** The active hours for a watchman type, server-local. */
function isWatchHour(type, nowMs) {
  if (type === WATCH_NIGHT) return hourInWindow(nowMs, NIGHT_START_HOUR, NIGHT_END_HOUR);
  if (type === WATCH_DAY) return hourInWindow(nowMs, DAY_START_HOUR, DAY_END_HOUR);
  if (type === WATCH_GATE) return hourInWindow(nowMs, GATE_START_HOUR, GATE_END_HOUR);
  if (type === WATCH_FIRE) return hourInWindow(nowMs, FIRE_START_HOUR, FIRE_END_HOUR);
  return false;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
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

// ============================================================================
// Watchman identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The watchman type for a roster record, or null.
 * Excludes the professional watch (role "guard" — CitizenGuards owns
 * guard types, shifts, the wanted list and arrests) so no citizen belongs
 * to both the professional and the volunteer side of the watch.
 */
function watchmanTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    const roll = hashStr("watchman:" + name) % 100;
    // ~45% nominal: the volunteer watch is a visible minority, not everyone.
    if (roll >= 45) return null;
    return watchmanTypeFromRoll(hashStr("watchmantype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred beat assignment, stable across restarts. */
function beatFor(record) {
  const kid = record?.kingdomId;
  const local = BEATS.filter((b) => b.kingdom === kid);
  const pool = local.length ? local : BEATS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("watchbeat:" + name) % pool.length];
}

// (rotaFor removed 2026-10-08: hash-derived fabrication.)

// (fireScareFor removed 2026-10-08: hash-derived fabrication.)

/**
 * The official guard shift name right now, read from the real
 * CitizenGuards tables when available (static fallback). Watchmen
 * reference the professional shift so volunteer rounds line up with
 * the official day/night changeover.
 */
function officialShiftFor(nowMs) {
  try {
    if (GuardsPro && typeof GuardsPro.shiftForHour === "function") {
      const h = new Date(nowMs).getHours();
      return GuardsPro.shiftForHour(h);
    }
  } catch { /* module absent */ }
  const h = new Date(nowMs).getHours();
  return h >= 5 && h < 21 ? "day" : "night";
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Report trouble to the watch: recorded; the LLM tier handles dialogue. */
function reportCrime(playerName, details, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  crimeReports.set(name, { details: String(details ?? "trouble"), at: nowMs });
  return name;
}

/** The active crime report for a player, or null. */
function reportFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = crimeReports.get(name);
  return rec ? rec.details : null;
}

/** Volunteer for a watch shift. */
function joinWatch(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  watchVolunteers.set(name, { at: nowMs });
  return name;
}

/** Whether the player has an active volunteer sign-up. */
function watcherFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  return watchVolunteers.has(name);
}

/** Hire a warden to watch your stall. */
function hireWarden(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  wardenHires.set(name, { at: nowMs });
  return name;
}

/** Whether the player has an active warden hire. */
function wardenFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  return wardenHires.has(name);
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
// Gate order: cooldown (cheapest) → watchman? → materialized → watch
// hours → real player near → chance → work.
// ============================================================================

function tickWatchmen(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < WATCH_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a watchman (hash-derived, cheap; top-level requires)
        const type = watchmanTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Watch hours for this type only
        if (!isWatchHour(type, now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, WATCH_RADIUS)) continue;

        // 6. Chance gate (visibility throttle — no hobby key by design)
        if (!chance(Math.random, WATCH_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doWatchWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-watchmen2] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-watchmen2] tick failed:", e?.message ?? e);
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

function doWatchWork(director, record, citizen, type, nowMs) {
  const beat = beatFor(record);
  const shift = officialShiftFor(nowMs);

  // Fire-alarm fanfare: once per kingdom per night, the crowd moment.
  if (type === WATCH_FIRE) {
    // (Crowd-moment fabrication block removed 2026-10-08: fireScareFor was hash-derived.)
  }

  // Routine: honest patrol callout on the assigned beat.
  // (rotaFor removed 2026-10-08: hash-derived "today's rota" was fabrication.
  // The beat from beatFor(record) is the honest stable assignment.)
  const line = fill(pickOne(Math.random, PATROL_LINES[type]), {
    beat: beat.name,
    shift,
  });
  { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  journalize(citizen, `walked the watch on ${beat.name}`);
}

module.exports = {
  tickWatchmen,
  reportCrime,
  reportFor,
  joinWatch,
  watcherFor,
  hireWarden,
  wardenFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  watchmanTypeOf,
  beatFor,
  officialShiftFor,
  isWatchHour,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  watchmanTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  hourInWindow,
  dayNumber,
  chance,
  seededRng,
  WATCH_TYPES,
  WATCH_NIGHT,
  WATCH_DAY,
  WATCH_GATE,
  WATCH_FIRE,
  BEATS,
  REPORT_ACK_LINES,
  JOIN_WATCH_LINES,
  HIRE_WARDEN_LINES,
  FIRE_ALARM_LINES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    crimeReports.clear();
    watchVolunteers.clear();
    wardenHires.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
