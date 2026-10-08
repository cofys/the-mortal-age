"use strict";

/**
 * CitizenMessengers — citizens who carry letters, packages and news across
 * the kingdoms: couriers, heralds, runners and postmasters.
 *
 * WHAT IT DOES (data tier, free):
 *   Every messenger citizen gets a hash-stable messenger type. Per-day
 *   delivery routes (origin, destination, contents) are derived from hashes —
 *   zero disk state. Letters sent by real players live in an in-memory
 *   ledger (7-day TTL, pruned). Urgent deliveries resolve deterministically.
 *   Heralds seed the day's announcements into CitizenRumors (lazy require,
 *   best-effort) and read the latest CitizenNewspaper edition (lazy require,
 *   best-effort) so the town square hears the same news the paper prints.
 *   Everything is journaled so the LLM mouth can riff on it later
 *   ("your letter to Varrock went out with the morning post").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Couriers arrive with letter-delivery fanfare and offer to carry the
 *   player's mail; heralds climb the town-square steps to proclaim royal
 *   decrees, event announcements and weather warnings; runners sprint past
 *   with urgent dispatches; postmasters greet visitors at the post office
 *   and offer to send letters. The work is journaled once per loop.
 *
 * Zero LLM: every line is scripted from pools; the LLM mouth only reads
 * the journal and the public data API (sendLetter, letterFor). Complements
 * CitizenNewspaper (heralds echo printed editions) and CitizenRumors
 * (heralds seed announcements as rumors) — this module owns types, routes,
 * deliveries, proclamations and the letter ledger. No overlap.
 *
 * Wired into the director tick in tickProximity(), right after the tax
 * collectors block. Plain-node testable: CitizenMessengers.test.js.
 */

// === Tuning: all magic numbers here ===
const MESSENGER_RADIUS = 14; // tiles — a real player must be near to see/hear
const DELIVER_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a courier delivers at most this often
const HERALD_COOLDOWN_MS = 4 * 60 * 60 * 1000; // a herald proclaims at most this often
const RUNNER_COOLDOWN_MS = 2 * 60 * 60 * 1000; // a runner sprints an urgent dispatch at most this often
const POSTMASTER_COOLDOWN_MS = 5 * 60 * 60 * 1000; // a postmaster works the counter at most this often
const POST_HOUR_START = 7; // post offices open 07:00-19:00 server time
const POST_HOUR_END = 19;
const LETTER_LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // unclaimed letters linger a week
const MESSENGER_CHANCE = 0.35; // ~35% of commoners become messengers
const URGENT_CHANCE = 0.12; // ~12% of routes are urgent dispatches

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Messenger types and post offices ===
const MESSENGER_TYPES = Object.freeze(["courier", "herald", "runner", "postmaster"]);

const POST_OFFICES = Object.freeze([
  { name: "the Varrock post office", kingdom: "varrock" },
  { name: "the Lumbridge letter box", kingdom: "lumbridge" },
  { name: "the Falador mail hall", kingdom: "falador" },
  { name: "the Port Sarim packet office", kingdom: "portsarim" },
  { name: "the Ardougne post house", kingdom: "ardougne" },
  { name: "the Kandarin mail coach inn", kingdom: "kandarin" },
  { name: "the Keldagrim deep post", kingdom: "keldagrim" },
  { name: "the Dorgesh runner's burrow", kingdom: "dorgeshuun" },
  { name: "the Darkmeyer night post", kingdom: "morytania" },
  { name: "the Al Kharid desert post", kingdom: "alkharid" },
]);

const LETTER_KINDS = Object.freeze([
  "a sealed letter",
  "a wax-stamped letter",
  "a love letter",
  "a business contract",
  "a royal summons",
  "a merchant's invoice",
  "a family letter",
  "a coded dispatch",
]);

const PACKAGE_KINDS = Object.freeze([
  "a small parcel",
  "a bound bundle",
  "a sturdy crate",
  "a satchel of documents",
  "a padded box",
]);

const PROCLAMATION_KINDS = Object.freeze(["decree", "event", "warning"]);

// === Line pools (scripted, zero LLM) ===
const COURIER_ARRIVAL_LINES = Object.freeze([
  "{courier} the courier skids to a halt, {kind} in hand: \"Letter for {name}!\"",
  "{courier}: Special delivery! {kind} — sign here, {name}.",
  "{courier} holds up {kind} and scans the crowd. \"{name}? A letter for you.\"",
  "{courier}: From {origin} to {dest}, rain or shine — {kind} for {name}!",
]);

const COURIER_OFFER_LINES = Object.freeze([
  "{courier}: Need a letter carried, {name}? {office} delivers daily.",
  "{courier}: Post a letter with me — {kind} rates, {origin} to {dest} by tomorrow.",
  "{courier}: {name}, got someone far away? I can carry your words to {dest}.",
]);

const HERALD_DECREE_LINES = Object.freeze([
  "{herald} climbs the steps, unrolls a scroll, and cries: \"Hear ye! By decree — {text}\"",
  "{herald}: \"Oyez, oyez! A royal decree from {origin}: {text}\"",
  "{herald} bangs the staff on the cobbles. \"Attention! A decree: {text}\"",
]);

const HERALD_EVENT_LINES = Object.freeze([
  "{herald}: \"Mark your calendars! {text}\"",
  "{herald} reads from the broadsheet: \"An announcement for all — {text}\"",
  "{herald}: \"Word from {origin}! {text}\"",
]);

const HERALD_WARNING_LINES = Object.freeze([
  "{herald}: \"Take heed, good people — {text}\"",
  "{herald} raises the warning bell. \"{text} — spread the word!\"",
  "{herald}: \"A warning from {origin}: {text}\"",
]);

const RUNNER_LINES = Object.freeze([
  "{runner} sprints past, leather satchel bouncing: \"Urgent dispatch for {dest} — make way!\"",
  "{runner} barely slows down. \"Important papers for {dest}! No time to talk!\"",
  "{runner}: \"Out of the way — {kind} for {dest}, and it cannot wait!\"",
]);

const POSTMASTER_GREET_LINES = Object.freeze([
  "{postmaster}: \"Welcome to {office}, {name}. Sending a letter today?\"",
  "{postmaster} stamps a stack of letters. \"Morning, {name}. Post to {dest} leaves at noon.\"",
  "{postmaster}: \"{office} at your service, {name}. Letters, parcels, urgent dispatches.\"",
]);

const POSTMASTER_COLLECT_LINES = Object.freeze([
  "{postmaster}: \"{name}! You've a {kind} waiting at {office}. Sign here.\"",
  "{postmaster} slides {kind} across the counter. \"For {name}, just arrived from {origin}.\"",
  "{postmaster}: \"Good news, {name} — {kind} came in on the morning post from {origin}.\"",
]);

const DECREE_TEXTS = Object.freeze([
  "the market tithe is lowered for the festival week",
  "all travelers must register at the gate by sundown",
  "the crown pardons all debtors under fifty coins",
  "new fishing rights are granted on the river",
  "the night watch is doubled until further notice",
]);

const EVENT_TEXTS = Object.freeze([
  "the grand tournament opens its gates on Saturday",
  "a new ship sails for the eastern isles at dawn",
  "the harvest fair seeks pie judges and strong arms",
  "a wandering troupe performs in the square tonight",
]);

const WARNING_TEXTS = Object.freeze([
  "storms are coming — secure your boats and shutters",
  "bandits were seen on the north road; travel in groups",
  "a strange fever spreads in the lower town; boil your water",
  "wolves press close to the farms; keep livestock penned",
]);

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Fill {slots} in a template line from a vars object. */
function fillLine(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (m, key) =>
    vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m
  );
}

/** FNV-1a 32-bit hash — stable across restarts for deterministic assignment. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Hash-stable messenger type, or null when this citizen is not a messenger. */
function messengerTypeFor(username) {
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "messenger") return null;
  const h = fnv1a("messenger:" + username);
  return MESSENGER_TYPES[h % MESSENGER_TYPES.length];
}

function isMessenger(username) {
  return messengerTypeFor(username) !== null;
}

/** Kingdom-preferred post office for this messenger. */
function officeFor(username, kingdomId) {
  const k = String(kingdomId ?? "").toLowerCase();
  const mine = POST_OFFICES.filter((o) => o.kingdom === k);
  if (mine.length > 0) return mine[fnv1a("office:" + username) % mine.length];
  return POST_OFFICES[fnv1a("office:" + username) % POST_OFFICES.length];
}

/** Per-day delivery route derived from hashes — no disk state. */
function routeFor(username, dayStamp) {
  const h = fnv1a(`route:${username}:${dayStamp}`);
  const dest = POST_OFFICES[h % POST_OFFICES.length];
  const origin = POST_OFFICES[(h >>> 8) % POST_OFFICES.length];
  const urgent = ((h >>> 16) % 100) / 100 < URGENT_CHANCE;
  const carries = urgent
    ? "an urgent dispatch"
    : (h >>> 24) % 2 === 0
      ? pickOne(() => ((h >>> 20) % 1000) / 1000, LETTER_KINDS)
      : pickOne(() => ((h >>> 20) % 1000) / 1000, PACKAGE_KINDS);
  return { origin: origin.name, dest: dest.name, carries, urgent };
}

/** True when the current hour is inside post-office hours. */
function inPostHours(hour) {
  return hour >= POST_HOUR_START && hour < POST_HOUR_END;
}

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

// ============================================================================
// Player letter ledger (data tier, in-memory, TTL-pruned).
// ============================================================================

const letters = new Map(); // normName -> { name, kind, from, text, sentAt, until }

let lastLedgerPruneAt = 0;
function pruneLetters(nowMs) {
  if (nowMs - lastLedgerPruneAt < 3600 * 1000) return;
  lastLedgerPruneAt = nowMs;
  for (const [k, e] of letters) {
    if (e.until <= nowMs) letters.delete(k);
  }
}

/**
 * Post a letter to a player (LLM dialogue tier reports the player's words;
 * this records the delivery deterministically).
 */
function sendLetter(toName, kind, fromName, text, nowMs) {
  pruneLetters(nowMs);
  const k = normName(toName);
  if (!k) return false;
  letters.set(k, {
    name: String(toName),
    kind: String(kind || "a sealed letter"),
    from: String(fromName || "a friend"),
    text: String(text || "").slice(0, 200),
    sentAt: nowMs,
    until: nowMs + LETTER_LEDGER_TTL_MS,
  });
  return true;
}

/** The waiting letter for a player, or null. */
function letterFor(playerName, nowMs) {
  pruneLetters(nowMs);
  const e = letters.get(normName(playerName));
  return e && e.until > nowMs ? { ...e } : null;
}

/** Mark a player's letter collected. */
function collectLetter(playerName) {
  return letters.delete(normName(playerName));
}

// ============================================================================
// Engine helpers (impure, guarded).
// ============================================================================

function journal(director, name, kind, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(name, kind, text, data ? { data } : undefined);
  } catch {
    // Journal must never break the mail.
  }
}

function forceSay(bot, line) {
  try {
    bot.forceChat?.(String(line).slice(0, 120));
  } catch {
    // Cosmetic only.
  }
}

function roleOf(record) {
  try {
    return String(record.attributes?.citizenRole ?? record.attributes?.role ?? "").toLowerCase();
  } catch {
    return "";
  }
}

function kingdomOf(record) {
  try {
    return record.attributes?.kingdomId ?? record.attributes?.kingdom ?? "varrock";
  } catch {
    return "varrock";
  }
}

/** Hour of day (0-23) in the server's local timezone. */
function hourOf(nowMs) {
  return new Date(nowMs).getHours();
}

/** Day stamp YYYY-MM-DD for route derivation. */
function dayStampOf(nowMs) {
  const d = new Date(nowMs);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Seed the day's proclamation into CitizenRumors (best-effort, never throws). */
function seedProclamationRumor(kind, text, where) {
  try {
    const { seedRumor } = require("./CitizenRumors");
    seedRumor(Math.random, {
      kind: "proclamation",
      what: `${kind}: ${text}`,
      who: "the town herald",
      where,
    });
  } catch {
    // Rumors must never break proclamations.
  }
}

/** Read the latest newspaper edition for herald echo lines (best-effort). */
function latestEdition() {
  try {
    const { latestEdition } = require("./CitizenNewspaper");
    return latestEdition() ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: role → type → cooldown (cheapest) → materialized → real player
// near → work. Never throws.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickMessengers(director, nowMs) {
  pruneCooldowns(nowMs);
  pruneLetters(nowMs);
  try {
    const hour = hourOf(nowMs);
    const inHours = inPostHours(hour);
    const day = dayStampOf(nowMs);

    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 0. Only commoners may be messengers.
        if (roleOf(record) !== "commoner") continue;
        const type = messengerTypeFor(record.username);
        if (!type) continue;

        // 1. Cooldown gate — O(1), skips almost everyone.
        const cooldown =
          type === "herald" ? HERALD_COOLDOWN_MS
          : type === "runner" ? RUNNER_COOLDOWN_MS
          : type === "postmaster" ? POSTMASTER_COOLDOWN_MS
          : DELIVER_COOLDOWN_MS;
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < cooldown) continue;

        // 2. Citizen must be materialized (near a player already).
        const bot = director.playerFor?.(record);
        if (!bot) continue;

        // 3. A real player must be within earshot.
        const players = director.onlinePlayers?.() ?? [];
        let near = null;
        for (const p of players) {
          if (!isRealPlayer(p)) continue;
          if (withinTiles(bot, p, MESSENGER_RADIUS)) { near = p; break; }
        }
        if (!near) continue;

        const office = officeFor(record.username, kingdomOf(record));
        const route = routeFor(record.username, day);
        const rng = Math.random;
        const pname = near.getUsername?.() ?? "traveler";

        if (type === "courier") {
          const waiting = letterFor(pname, nowMs);
          if (waiting) {
            forceSay(bot, fillLine(pickOne(rng, COURIER_ARRIVAL_LINES), {
              courier: record.username,
              name: pname,
              kind: waiting.kind,
              origin: waiting.from,
              dest: office.name,
            }));
            journal(director, record.username, "mail",
              `delivered ${waiting.kind} to ${pname} from ${waiting.from}`);
          } else {
            forceSay(bot, fillLine(pickOne(rng, COURIER_OFFER_LINES), {
              courier: record.username,
              name: pname,
              kind: "post-haste",
              office: office.name,
              origin: route.origin,
              dest: route.dest,
            }));
            journal(director, record.username, "mail",
              `ran the ${route.origin} to ${route.dest} route carrying ${route.carries}`);
          }
        } else if (type === "herald" && inHours) {
          const roll = fnv1a(`herald:${record.username}:${day}`) % 100;
          let pool, kind, text;
          if (roll < 34) {
            pool = HERALD_DECREE_LINES; kind = "decree";
            text = pickOne(rng, DECREE_TEXTS);
          } else if (roll < 67) {
            pool = HERALD_EVENT_LINES; kind = "event";
            text = pickOne(rng, EVENT_TEXTS);
          } else {
            pool = HERALD_WARNING_LINES; kind = "warning";
            text = pickOne(rng, WARNING_TEXTS);
          }
          // Echo the printed paper when one exists so square and paper agree.
          const edition = latestEdition();
          if (edition && edition.headline && roll < 12) {
            text = String(edition.headline).slice(0, 90);
            kind = "event";
            pool = HERALD_EVENT_LINES;
          }
          forceSay(bot, fillLine(pickOne(rng, pool), {
            herald: record.username,
            text,
            origin: route.origin,
          }));
          seedProclamationRumor(kind, text, office.name);
          journal(director, record.username, "mail",
            `proclaimed ${kind} at ${office.name}: ${text}`);
        } else if (type === "runner") {
          if (!route.urgent) {
            // Not an urgent day — the runner just stretches and waits.
            journal(director, record.username, "mail", "stood ready at the post for urgent work");
            lastFiredByCitizen.set(record.username, nowMs);
            continue;
          }
          forceSay(bot, fillLine(pickOne(rng, RUNNER_LINES), {
            runner: record.username,
            kind: route.carries,
            dest: route.dest,
          }));
          journal(director, record.username, "mail",
            `sprinted an urgent dispatch to ${route.dest}`);
        } else if (type === "postmaster" && inHours) {
          const waiting = letterFor(pname, nowMs);
          if (waiting) {
            forceSay(bot, fillLine(pickOne(rng, POSTMASTER_COLLECT_LINES), {
              postmaster: record.username,
              name: pname,
              kind: waiting.kind,
              office: office.name,
              origin: waiting.from,
            }));
            journal(director, record.username, "mail",
              `handed ${pname} their waiting ${waiting.kind} at ${office.name}`);
          } else {
            forceSay(bot, fillLine(pickOne(rng, POSTMASTER_GREET_LINES), {
              postmaster: record.username,
              name: pname,
              office: office.name,
              dest: route.dest,
            }));
            journal(director, record.username, "mail",
              `worked the counter at ${office.name}`);
          }
        } else if (!inHours && (type === "herald" || type === "postmaster")) {
          // Outside hours the office is quiet.
          journal(director, record.username, "mail", `closed ${office.name} for the night`);
        }

        lastFiredByCitizen.set(record.username, nowMs);
      } catch {
        // One bad messenger never breaks the tick.
      }
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-messengers] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickMessengers,
  sendLetter,
  letterFor,
  collectLetter,
  // Export pure helpers for tests:
  pickOne,
  isRealPlayer,
  withinTiles,
  fillLine,
  fnv1a,
  normName,
  messengerTypeFor,
  isMessenger,
  officeFor,
  routeFor,
  inPostHours,
  // Tuning (tests pin the documented behavior):
  MESSENGER_RADIUS,
  DELIVER_COOLDOWN_MS,
  HERALD_COOLDOWN_MS,
  RUNNER_COOLDOWN_MS,
  POSTMASTER_COOLDOWN_MS,
  POST_HOUR_START,
  POST_HOUR_END,
  LETTER_LEDGER_TTL_MS,
  MESSENGER_CHANCE,
  URGENT_CHANCE,
  // Data (non-empty checks):
  MESSENGER_TYPES,
  POST_OFFICES,
  // Line pools (non-empty checks):
  COURIER_ARRIVAL_LINES,
  COURIER_OFFER_LINES,
  HERALD_DECREE_LINES,
  HERALD_EVENT_LINES,
  HERALD_WARNING_LINES,
  RUNNER_LINES,
  POSTMASTER_GREET_LINES,
  POSTMASTER_COLLECT_LINES,
  DECREE_TEXTS,
  EVENT_TEXTS,
  WARNING_TEXTS,
};
