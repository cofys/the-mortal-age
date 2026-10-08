"use strict";

/**
 * CitizenGuards — the watch's deeper systems: guard types, shift changes,
 * crime reports, the wanted list, and arrests.
 *
 * WHAT IT DOES (data tier, free):
 *   Every guard citizen gets a hash-stable guard type (city-watch, gate-guard,
 *   royal-guard, investigator). The day/night shift rotates on the wall clock;
 *   shift changes are journaled. Theft/attack crimes journaled in CitizenJournal
 *   become wanted cases: investigators work cold cases (events older than the
 *   patrol's fresh window), gate-guards challenge wanted players at the gate,
 *   and arrested citizens serve their time and come off the list. Player crime
 *   reports (via the LLM dialogue tier) mark suspects wanted for 30 minutes.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Type-flavored lines: gate-guards challenge notorious arrivals ("Hold —
 *   state your business."), royal-guards bow to nearby courtiers, investigators
 *   question onlookers about cold cases, and scripted arrest scenes play out
 *   between a guard and a wanted citizen (surrender lines from the target).
 *   Shift changes are announced once per shift where players can hear them.
 *
 * Zero LLM: every line is scripted from pools; the LLM mouth only reads the
 * journal ("arrested last night for stealing bread"). Complements
 * CitizenGuardPatrols (checkpoint check-ins, fresh-disturbance response,
 * escorts, torch announcements, reassurance) — this module never repeats
 * those; it owns types, shifts, reports, wanted cases and arrests.
 *
 * Wired into the director tick in tickProximity(), right after the guard
 * patrols block. Plain-node testable: CitizenGuards.test.js.
 */

// === Tuning: all magic numbers here ===
const GUARD_RADIUS = 14; // tiles — a real player must be near to see/hear
const GUARD_COOLDOWN_MS = 20 * 60 * 1000; // per guard per flavor action
const GATE_CHALLENGE_COOLDOWN_MS = 10 * 60 * 1000;
const INVESTIGATOR_COOLDOWN_MS = 30 * 60 * 1000;
const ARREST_COOLDOWN_MS = 45 * 60 * 1000;
const ROYAL_COOLDOWN_MS = 30 * 60 * 1000;

const SHIFT_CHANGE_WINDOW_MS = 10 * 60 * 1000; // announce within 10 min of a shift change
const WANTED_TTL_MS = 30 * 60 * 1000; // a crime report lasts 30 minutes
const COLD_CASE_MIN_AGE_MS = 5 * 60 * 1000; // older than the patrol's fresh window
const COLD_CASE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const ARREST_RADIUS = 6; // guard must be close to the wanted citizen

const CRIME_KINDS = new Set(["theft", "attack"]);

// === Line pools (scripted, zero LLM) ===
const SHIFT_CHANGE_DAY = Object.freeze([
  "Day watch takes the walls — night shift, stand down.",
  "Sun's up. Day watch on the beat.",
  "Change of the watch! Day shift walks the streets.",
]);

const SHIFT_CHANGE_NIGHT = Object.freeze([
  "Night watch takes the walls — stay inside after dark.",
  "Change of the watch! Night shift — gates barred soon.",
  "Night watch on the beat. Mind the shadows.",
]);

const GATE_CHALLENGE_LINES = Object.freeze([
  "Hold — state your business, {name}. The watch is watching you.",
  "You there. The gate's open to honest folk. Prove you're one.",
  "{name}. We've heard about you. Keep your hands where we can see them.",
]);

const GATE_CLEAR_LINES = Object.freeze([
  "Gate's clear. Move along, {name}.",
  "Pass through. Stay out of trouble.",
]);

const ROYAL_GUARD_LINES = Object.freeze([
  "The crown's guard stands watch. All bow.",
  "Royal guard on duty — the {place} is protected.",
  "None shall pass the crown's guard.",
]);

const ROYAL_PLACES = Object.freeze([
  "palace gates",
  "throne steps",
  "royal chambers",
  "crown vault",
]);

const ROYAL_BOW_LINES = Object.freeze([
  "My lord {name}. The crown's guard stands at your service.",
  "Your grace. The guard is honored.",
]);

const INVESTIGATOR_QUESTION_LINES = Object.freeze([
  "You there — did you see anything near the {site} last night? Talk.",
  "The watch is asking questions about a {kind} at the {site}. Speak up.",
  "Nobody saw anything? Somebody always sees something.",
]);

const INVESTIGATOR_FOUND_LINES = Object.freeze([
  "Found something. A {clue} — that puts {name} at the {site}.",
  "The pieces fit. {name} was at the {site} when it happened.",
]);

const ARREST_LINES = Object.freeze([
  "In the name of the watch — you're coming with me, {name}.",
  "Caught you at last. {name}, you're under arrest.",
  "The stocks await, {name}. Hands where I can see them.",
]);

const SURRENDER_LINES = Object.freeze([
  "Alright, alright! I yield — don't hurt me!",
  "It wasn't me, I swear — fine, fine, I'll come quietly.",
  "The watch got me. Tell my mother I behaved.",
]);

const REPORT_ACK_LINES = Object.freeze([
  "Noted, {reporter}. The watch will be looking for {suspect}.",
  "We'll keep an eye out for {suspect}. Thank you, citizen.",
]);

const JOIN_WATCH_LINES = Object.freeze([
  "Welcome to the watch, {name}. Walk tall, speak fair.",
  "A new blade for the watch! The streets are safer with you, {name}.",
]);

const CLUES = Object.freeze([
  "torn cloak-thread",
  "dropped coin-pouch",
  "muddy boot-print",
  "broken lock-pick",
  "singed sleeve",
]);

const SITES = Object.freeze([
  "market",
  "east gate",
  "docks",
  "tavern row",
  "temple steps",
  "granary",
]);

// === State ===
const lastFlavorByGuard = new Map(); // guard username -> timestamp (flavor lines)
const lastGateChallenge = new Map(); // guard username -> timestamp
const lastInvestigator = new Map(); // guard username -> timestamp
const lastArrest = new Map(); // guard username -> timestamp
const lastShiftAnnounce = new Map(); // guard username -> shift key announced
const wanted = new Map(); // normalized suspect name -> { suspect, kind, at, until, reporter }

let lastPruneAt = 0;
function pruneMaps(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastFlavorByGuard, lastGateChallenge, lastInvestigator, lastArrest]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
  for (const [k, w] of wanted) {
    if (!w || w.until <= nowMs) wanted.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
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

/** Cheap Chebyshev distance check between engine objects (same plane). */
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

/** Fill "{name}" style slots in a scripted line. */
function fillLine(line, vars) {
  let out = String(line ?? "");
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.split(`{${k}}`).join(String(v ?? ""));
  }
  return out;
}

/** FNV-1a hash of a string — stable guard-type assignment across restarts. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Guard type from username hash, stable across restarts, zero storage.
 * city-watch 45% / gate-guard 20% / royal-guard 15% / investigator 20%.
 */
function guardTypeFor(username) {
  const h = fnv1a(String(username ?? "").toLowerCase()) % 100;
  if (h < 45) return "city-watch";
  if (h < 65) return "gate-guard";
  if (h < 80) return "royal-guard";
  return "investigator";
}

/** Shift from the wall-clock hour: "day" 05:00–20:59, "night" 21:00–04:59. */
function shiftForHour(hour) {
  return hour >= 5 && hour < 21 ? "day" : "night";
}

/** Pure: is now within the shift-change announcement window?
 * dateLike: { hours, minutes, seconds } from the wall clock. Shifts change
 * at 05:00 and 21:00; announce only in the first 10 minutes after. */
function inShiftChangeWindow(dateLike) {
  const h = dateLike.hours;
  if (h !== 5 && h !== 21) return false;
  const sinceChangeMs = (dateLike.minutes ?? 0) * 60 * 1000 + (dateLike.seconds ?? 0) * 1000;
  return sinceChangeMs < SHIFT_CHANGE_WINDOW_MS;
}

/** Normalize a name for the wanted list (lowercase, trimmed). */
function normName(name) {
  return String(name ?? "").trim().toLowerCase();
}

/**
 * Mark a suspect as wanted. Called by the LLM dialogue tier when a player
 * reports a crime. Pure-ish: writes the module-level wanted map.
 * @returns {boolean} true if the report was recorded
 */
function reportCrime(reporterUsername, suspectUsername, kind, nowMs) {
  const suspect = normName(suspectUsername);
  const reporter = normName(reporterUsername);
  if (!suspect || !reporter || suspect === reporter) return false;
  if (!CRIME_KINDS.has(String(kind ?? "").toLowerCase())) return false;
  wanted.set(suspect, {
    suspect: String(suspectUsername ?? "").trim(),
    kind: String(kind).toLowerCase(),
    reporter: String(reporterUsername ?? "").trim(),
    at: nowMs,
    until: nowMs + WANTED_TTL_MS,
  });
  return true;
}

/** Pure: is this name currently wanted? Prunes expired entries on read. */
function isWanted(username, nowMs) {
  const key = normName(username);
  const w = wanted.get(key);
  if (!w) return false;
  if (w.until <= nowMs) {
    wanted.delete(key);
    return false;
  }
  return true;
}

/** Pure: record time served — removes a suspect from the wanted list. */
function serveSentence(username) {
  return wanted.delete(normName(username));
}

/** Pure: current wanted count (expired pruned). */
function wantedCount(nowMs) {
  let n = 0;
  for (const [k, w] of wanted) {
    if (!w || w.until <= nowMs) wanted.delete(k);
    else n++;
  }
  return n;
}

/**
 * Register a player as a watch volunteer. Called by the LLM dialogue tier.
 * Journaled by the caller-facing tick when the volunteer is near a guard.
 */
const watchVolunteers = new Set(); // normalized usernames
function joinWatch(playerUsername) {
  const key = normName(playerUsername);
  if (!key) return false;
  watchVolunteers.add(key);
  return true;
}

/** Pure: is this player a watch volunteer? */
function isWatchVolunteer(username) {
  return watchVolunteers.has(normName(username));
}

/** Safe notoriety read; 0 when memory is unavailable. */
function notorietyOf(username, nowMs, memory) {
  try {
    const mem = memory ?? require("./CitizenMemory").getMemory();
    const n = mem.notoriety?.(username, nowMs);
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

/** Generic cooldown + chance gate. Pure and testable. */
function shouldFire(rng, lastMs, nowMs, cooldownMs, chance) {
  if (nowMs - (lastMs || 0) < cooldownMs) return false;
  return rng() < chance;
}

/** Plain tile of an engine player, or null. */
function botTile(player) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ() ?? 0 };
  } catch {
    return null;
  }
}

function journal(director, name, kind, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(name, kind, text, data ? { data } : undefined);
  } catch {
    // Journal must never break the watch.
  }
}

function forceSay(bot, line) {
  try {
    bot.forceChat?.(String(line).slice(0, 120));
  } catch {
    // Cosmetic only.
  }
}

/**
 * The materialized bot for a roster record, or null.
 * Real director API: isOnline(record) + getBot(record)
 * (director/CitizenDirector.js:1374/1379). `director.playerFor` does not
 * exist — any call to it returns undefined forever, silently disabling the
 * whole interaction tier, so it is never used here.
 */
function materializedBot(director, record) {
  try {
    if (director.isOnline?.(record)) return director.getBot?.(record) ?? null;
    return null;
  } catch {
    return null;
  }
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me) return out;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || !isRealPlayer(p)) continue;
      const t = botTile(p);
      if (!t) continue;
      const d = Math.max(Math.abs(me.x - t.x), Math.abs(me.y - t.y));
      if (d <= tiles) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

// ============================================================================
// Per-type ticks.
// ============================================================================

function tickShiftChange(director, record, bot, nowMs, rng, seen) {
  if (!seen) return;
  const d = new Date(nowMs);
  const shift = shiftForHour(d.getHours());
  const announced = lastShiftAnnounce.get(record.username);
  if (announced === shift) return;
  if (
    !inShiftChangeWindow({ hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds() })
  ) {
    return;
  }
  const pool = shift === "day" ? SHIFT_CHANGE_DAY : SHIFT_CHANGE_NIGHT;
  forceSay(bot, pickOne(rng, pool));
  journal(director, record.username, "patrol", `Shift change: ${shift} watch takes the walls.`);
  lastShiftAnnounce.set(record.username, shift);
}

function tickGateGuard(director, record, bot, nowMs, rng, seen) {
  if (!seen) return;
  const username = record.username;
  const last = lastGateChallenge.get(username) || 0;
  if (nowMs - last < GATE_CHALLENGE_COOLDOWN_MS) return;
  const near = realPlayersWithin(bot, GUARD_RADIUS);
  if (near.length === 0) return;
  // Challenge a wanted or notorious player; otherwise a clear-pass line.
  let target = null;
  for (const p of near) {
    const pname = p.getUsername?.() ?? "?";
    if (isWanted(pname, nowMs) || notorietyOf(pname, nowMs) >= 0.5) {
      target = { player: p, name: pname, bad: true };
      break;
    }
  }
  if (!target) {
    if (rng() >= 0.4) return; // don't narrate every clean arrival
    const p = near[0];
    const pname = p.getUsername?.() ?? "?";
    forceSay(bot, fillLine(pickOne(rng, GATE_CLEAR_LINES), { name: pname }));
  } else {
    forceSay(bot, fillLine(pickOne(rng, GATE_CHALLENGE_LINES), { name: target.name }));
    journal(director, username, "patrol", `Gate challenge: ${target.name}.`);
  }
  lastGateChallenge.set(username, nowMs);
}

function tickRoyalGuard(director, record, bot, nowMs, rng, seen) {
  if (!seen) return;
  const username = record.username;
  const last = lastFlavorByGuard.get(username) || 0;
  if (nowMs - last < ROYAL_COOLDOWN_MS) return;
  if (rng() >= 0.4) return;
  // Bow to a nearby courtier/merchant citizen, else a standing line.
  let bowed = null;
  try {
    for (const other of director.roster?.values?.() ?? []) {
      if (other.username === username) continue;
      if (other.role !== "courtier" && other.role !== "merchant") continue;
      const otherBot = materializedBot(director, other);
      if (!otherBot || !withinTiles(bot, otherBot, 8)) continue;
      bowed = other.username;
      break;
    }
  } catch {
    // Non-fatal.
  }
  if (bowed) {
    forceSay(bot, fillLine(pickOne(rng, ROYAL_BOW_LINES), { name: bowed }));
    journal(director, username, "patrol", `Royal guard bowed to ${bowed}.`);
  } else {
    forceSay(bot, fillLine(pickOne(rng, ROYAL_GUARD_LINES), { place: pickOne(rng, ROYAL_PLACES) }));
    journal(director, username, "patrol", "Royal guard stands watch.");
  }
  lastFlavorByGuard.set(username, nowMs);
}

function tickInvestigator(director, record, bot, nowMs, rng, seen) {
  if (!seen) return;
  const username = record.username;
  const last = lastInvestigator.get(username) || 0;
  if (nowMs - last < INVESTIGATOR_COOLDOWN_MS) return;
  if (rng() >= 0.5) return;
  // Cold cases only: journaled crime events older than the patrol's fresh
  // window. (CitizenGuardPatrols handles fresh disturbances.)
  try {
    const { getJournal } = require("./CitizenJournal");
    for (const other of director.roster?.values?.() ?? []) {
      if (other.username === username) continue;
      const events = getJournal().recent(other.username, 5);
      for (const e of events) {
        if (!CRIME_KINDS.has(e.kind)) continue;
        const age = nowMs - e.at;
        if (age < COLD_CASE_MIN_AGE_MS || age > COLD_CASE_MAX_AGE_MS) continue;
        const site = pickOne(rng, SITES);
        const line =
          rng() < 0.5
            ? fillLine(pickOne(rng, INVESTIGATOR_QUESTION_LINES), {
                site,
                kind: e.kind,
              })
            : fillLine(pickOne(rng, INVESTIGATOR_FOUND_LINES), {
                clue: pickOne(rng, CLUES),
                name: other.username,
                site,
              });
        forceSay(bot, line);
        journal(director, username, "patrol", `Investigator working a cold ${e.kind} case.`);
        lastInvestigator.set(username, nowMs);
        return;
      }
    }
  } catch {
    // Cold-case scan must never break the tick.
  }
}

function tickArrest(director, record, bot, nowMs, rng, seen) {
  if (!seen) return;
  const username = record.username;
  const last = lastArrest.get(username) || 0;
  if (nowMs - last < ARREST_COOLDOWN_MS) return;
  if (rng() >= 0.5) return;
  // Arrest a wanted *citizen* bot near the guard (players are warned, not seized).
  try {
    const me = botTile(bot);
    if (!me) return;
    for (const other of director.roster?.values?.() ?? []) {
      if (other.username === username) continue;
      if (!isWanted(other.username, nowMs)) continue;
      const otherBot = materializedBot(director, other);
      if (!otherBot || !withinTiles(bot, otherBot, ARREST_RADIUS)) continue;
      forceSay(bot, fillLine(pickOne(rng, ARREST_LINES), { name: other.username }));
      forceSay(otherBot, pickOne(rng, SURRENDER_LINES));
      journal(director, username, "patrol", `Arrested ${other.username} — time served.`);
      journal(director, other.username, "social", "Arrested by the watch — time served.");
      serveSentence(other.username);
      lastArrest.set(username, nowMs);
      return;
    }
  } catch {
    // Arrest drama must never break the tick.
  }
}

function tickJoinWatchWelcome(director, record, bot, nowMs, rng, seen) {
  if (!seen) return;
  const username = record.username;
  const key = `welcome:${username}`;
  const last = lastFlavorByGuard.get(key) || 0;
  if (nowMs - last < ROYAL_COOLDOWN_MS) return;
  const near = realPlayersWithin(bot, GUARD_RADIUS);
  for (const p of near) {
    const pname = p.getUsername?.() ?? "?";
    if (!isWatchVolunteer(pname)) continue;
    forceSay(bot, fillLine(pickOne(rng, JOIN_WATCH_LINES), { name: pname }));
    journal(director, username, "patrol", `Welcomed watch volunteer ${pname}.`);
    lastFlavorByGuard.set(key, nowMs);
    return;
  }
}

function tickGuard(director, record, bot, nowMs, rng, seen) {
  const type = guardTypeFor(record.username);
  try {
    tickShiftChange(director, record, bot, nowMs, rng, seen);
  } catch {
    // One bad shift never breaks the watch.
  }
  try {
    if (type === "gate-guard") tickGateGuard(director, record, bot, nowMs, rng, seen);
    else if (type === "royal-guard") tickRoyalGuard(director, record, bot, nowMs, rng, seen);
    else if (type === "investigator") tickInvestigator(director, record, bot, nowMs, rng, seen);
  } catch {
    // One bad guard never breaks the watch.
  }
  try {
    tickArrest(director, record, bot, nowMs, rng, seen);
    tickJoinWatchWelcome(director, record, bot, nowMs, rng, seen);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// Main tick — called from CitizenDirector.tickProximity(), right after the
// guard patrols block. Gate order: guard exists → real player near → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} [rng] - injected rng for tests (defaults to Math.random)
 */
function tickGuards(director, nowMs, rng) {
  pruneMaps(nowMs);
  const rand = rng ?? Math.random;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      if (record.role !== "guard") continue;
      let bot = null;
      try {
        bot = materializedBot(director, record);
      } catch {
        continue;
      }
      if (!bot) continue;
      const seen = realPlayersWithin(bot, GUARD_RADIUS).length > 0;
      if (!seen) continue;
      try {
        tickGuard(director, record, bot, nowMs, rand, seen);
      } catch {
        // One bad guard never breaks the watch.
      }
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-guards] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickGuards,
  reportCrime,
  joinWatch,
  isWanted,
  serveSentence,
  wantedCount,
  isWatchVolunteer,
  // Export pure helpers for tests:
  pickOne,
  isRealPlayer,
  withinTiles,
  fillLine,
  fnv1a,
  guardTypeFor,
  shiftForHour,
  inShiftChangeWindow,
  notorietyOf,
  shouldFire,
  normName,
  // Tuning (tests pin the documented behavior):
  GUARD_RADIUS,
  ARREST_RADIUS,
  WANTED_TTL_MS,
  COLD_CASE_MIN_AGE_MS,
  // Line pools (non-empty checks):
  SHIFT_CHANGE_DAY,
  SHIFT_CHANGE_NIGHT,
  GATE_CHALLENGE_LINES,
  GATE_CLEAR_LINES,
  ROYAL_GUARD_LINES,
  INVESTIGATOR_QUESTION_LINES,
  INVESTIGATOR_FOUND_LINES,
  ARREST_LINES,
  SURRENDER_LINES,
  REPORT_ACK_LINES,
  JOIN_WATCH_LINES,
};
