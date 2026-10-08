"use strict";

/**
 * CitizenVolunteers — citizens who give their time: street cleaners, helpers,
 * charity workers and event helpers who keep the kingdoms kind.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived volunteer types, per-day service shifts derived from date +
 *   hash, weekly charity drives derived per kingdom, and 7-day-TTL player
 *   ledgers for volunteer sign-ups, donations and player-organized drives.
 *   Event helpers read the real CitizenFestivals calendar (lazy require with
 *   fallback) so festival help only happens during actual festivals.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players, service
 * hours 07:00-19:00 server time): scripted service emotes, good-deed
 * announcements, charity-drive fanfare as the crowd moment, volunteer
 * invitations, donation acknowledgments.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * ACTIVITY SYSTEM, not a profession: any commoner may volunteer — no
 * professional exclusion chain (see the chain-saturation warning in the
 * citizen-ai-builder skill). Distinct from CitizenGardeners (owns public
 * gardens; volunteers may help there but the gardens module owns them) and
 * CitizenFestivals (owns the festivals; event helpers only assist during
 * them).
 *
 * Wired into the director proximity tick right after the gardeners block.
 * Plain-node testable: CitizenVolunteers.test.js.
 */

const { normalizeName } = require("./CitizenBonds");

// === Tuning ===
const VOLUNTEER_RADIUS = 14; // tiles — close enough to see/hear
const VOLUNTEER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const VOLUNTEER_CHANCE = 0.35; // per eligible citizen per proximity tick
const DRIVE_ANNOUNCE_CHANCE = 0.5; // of a drive day being announced per kingdom per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const SERVICE_START_HOUR = 7; // 07:00 server time
const SERVICE_END_HOUR = 19; // 19:00 server time

// === Volunteer types ===
const VOLUNTEER_CLEANER = "street-cleaner";
const VOLUNTEER_HELPER = "helper";
const VOLUNTEER_CHARITY = "charity-worker";
const VOLUNTEER_EVENT = "event-helper";
const VOLUNTEER_TYPES = [
  VOLUNTEER_CLEANER,
  VOLUNTEER_HELPER,
  VOLUNTEER_CHARITY,
  VOLUNTEER_EVENT,
];
const VOLUNTEER_WEIGHTS = {
  [VOLUNTEER_CLEANER]: 30,
  [VOLUNTEER_HELPER]: 30,
  [VOLUNTEER_CHARITY]: 25,
  [VOLUNTEER_EVENT]: 15,
};

// === Service areas (kingdom-preferred) ===
const SERVICE_AREAS = [
  { name: "the Varrock market square", kingdom: "misthalin" },
  { name: "the Lumbridge riverside", kingdom: "misthalin" },
  { name: "the Falador high street", kingdom: "asgarnia" },
  { name: "the White Knights' courtyard", kingdom: "asgarnia" },
  { name: "the Ardougne east market", kingdom: "kandarin" },
  { name: "the Hemenster lanes", kingdom: "kandarin" },
  { name: "the Keldagrim trade floor", kingdom: "keldagrim" },
  { name: "the Dorgesh market caves", kingdom: "keldagrim" },
  { name: "the Darkmeyer blood plaza", kingdom: "morytania" },
  { name: "the Al Kharid bazaar", kingdom: "kharidian" },
];

// === Charity drives (derived weekly per kingdom) ===
const DRIVE_KINDS = [
  { id: "food-drive", label: "a food drive", need: "bread and stew for the hungry" },
  { id: "clothing-drive", label: "a clothing drive", need: "warm cloaks for winter" },
  { id: "orphan-fund", label: "an orphan fund", need: "coins for the orphanage" },
  { id: "shelter-drive", label: "a shelter drive", need: "blankets for the poor" },
];

// === Scripted lines ===
const WORK_LINES = {
  [VOLUNTEER_CLEANER]: [
    "*sweeps the gutter with long strokes*",
    "*picks up litter and drops it in a sack*",
    "Mind the wet cobbles — just washed them.",
    "*scrubs a market stall clean*",
  ],
  [VOLUNTEER_HELPER]: [
    "*helps an elder up the steps*",
    "*carries a parcel for a neighbor*",
    "Need a hand with that? It's no trouble.",
    "*mends a loose shutter for a shopkeeper*",
  ],
  [VOLUNTEER_CHARITY]: [
    "*ladles stew into a bowl for a hungry child*",
    "*folds donated cloaks into neat piles*",
    "Everyone eats tonight — that's the rule.",
    "*hands out bread at the charity kitchen*",
  ],
  [VOLUNTEER_EVENT]: [
    "*hangs bunting across the square*",
    "*stacks benches for the festival crowd*",
    "Festival won't set itself up, friend!",
    "*tests the lantern strings one by one*",
  ],
};

const DEED_LINES = [
  "Just helped {name} carry their parcels all the way home.",
  "Spent the morning with {name} — their roof is patched now.",
  "Saw {name} through a hard day. We look after our own.",
  "{name} needed a friend today, so I was one.",
];

const DRIVE_LINES = [
  "Hear ye! {drive} at {area} — they need {need}!",
  "This week: {drive}! Bring what you can to {area}.",
  "{drive} is on at {area}. {need} — every bit helps.",
];

const INVITE_LINES = [
  "We could use another pair of hands, friend — care to volunteer?",
  "The rota's short today. Join us for an hour?",
  "Volunteering suits everyone. Will you lend a hand?",
];

const THANKS_LINES = [
  "The kingdom thanks you, {name}. That's a kindness remembered.",
  "Bless you, {name} — the poor will eat because of you.",
  "{name}, your generosity does you credit.",
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

// === Player ledgers (7-day TTL) ===
const signups = new Map(); // normName -> { area, at }
const donations = new Map(); // normName -> { kind, amount, at }
const drives = new Map(); // normName -> { drive, area, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of signups) {
    if (nowMs - v.at > LEDGER_TTL_MS) signups.delete(k);
  }
  for (const [k, v] of donations) {
    if (nowMs - v.at > LEDGER_TTL_MS) donations.delete(k);
  }
  for (const [k, v] of drives) {
    if (nowMs - v.at > LEDGER_TTL_MS) drives.delete(k);
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

/** Weighted pick of a volunteer type from a 0..99 roll. */
function volunteerTypeFromRoll(roll) {
  let acc = 0;
  for (const t of VOLUNTEER_TYPES) {
    acc += VOLUNTEER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return VOLUNTEER_CLEANER;
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

/** True during service hours (07:00-19:00 server time). */
function isServiceHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= SERVICE_START_HOUR && h < SERVICE_END_HOUR;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** Week number since epoch — for weekly rhythms. */
function weekNumber(nowMs) {
  return Math.floor(nowMs / (7 * 86400000));
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
// Volunteer identity — hash-derived, stable across restarts, no storage.
// ACTIVITY SYSTEM: no professional exclusions — any commoner may volunteer.
// ============================================================================

/**
 * The volunteer type for a roster record, or null.
 * Event helpers only "exist" during actual festivals (checked at tick time
 * via activeFestival, not here, so the type stays stable).
 */
function volunteerTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    return volunteerTypeFromRoll(hashStr("volunteer:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred service area for a record. */
function areaFor(record) {
  const kid = record?.kingdomId;
  const local = SERVICE_AREAS.filter((a) => a.kingdom === kid);
  const pool = local.length ? local : SERVICE_AREAS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("volunteerarea:" + name) % pool.length];
}

/**
 * The charity drive running in a kingdom this week (or null).
 * Derived from week + kingdom — zero storage, stable all week.
 */
function driveForKingdom(kingdomId, nowMs) {
  const week = weekNumber(nowMs);
  const rng = seededRng(hashStr("volunteerdrive:" + String(kingdomId) + ":" + week));
  if (rng() >= DRIVE_ANNOUNCE_CHANCE) return null;
  return pickOne(rng, DRIVE_KINDS);
}

/**
 * Today's service shift for a volunteer: { area, task }.
 * Derived from date + hash; zero storage.
 */
function shiftFor(username, kingdomId, dateMs) {
  const name = normalizeName(username) || "anon";
  const type = volunteerTypeOf({ username: name, kingdomId });
  if (!type) return null;
  const area = areaFor({ username: name, kingdomId });
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("volunteershift:" + name + ":" + day));
  const task = pickOne(rng, WORK_LINES[type]);
  return { area, task, type };
}

/**
 * A good deed done by a volunteer today (or null).
 * Derived — gives the LLM mouth something truthful to say.
 */
function deedFor(username, nowMs) {
  const name = normalizeName(username);
  if (!name) return null;
  const day = dayNumber(nowMs);
  const rng = seededRng(hashStr("volunteerde:" + name + ":" + day));
  if (rng() >= 0.6) return null; // not every day is a deed day
  const neighbor = pickOne(rng, NEIGHBOR_NAMES);
  return fill(pickOne(rng, DEED_LINES), { name: neighbor });
}

const NEIGHBOR_NAMES = [
  "Widow Hettie",
  "old Tam",
  "Goodwife Bess",
  "young Pip",
  "the cobbler's lad",
  "Mistress Wren",
];

/**
 * True when an event-helper should be working now: a festival is active.
 * Reads the real CitizenFestivals calendar (lazy require, fallback false).
 */
function isFestivalNow(nowMs) {
  try {
    const festivals = require("./CitizenFestivals");
    if (typeof festivals.activeFestival === "function") {
      return festivals.activeFestival(nowMs) != null;
    }
  } catch { /* module absent */ }
  return false;
}

// ============================================================================
// Player participation (data tier, zero LLM).
// ============================================================================

/** Sign a player up for a volunteer shift at an area. */
function signUpFor(playerName, areaName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !areaName) return null;
  pruneLedgers(nowMs);
  signups.set(name, { area: String(areaName), at: nowMs });
  return String(areaName);
}

/** The active volunteer sign-up for a player, or null. */
function signupFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = signups.get(name);
  return rec ? rec.area : null;
}

/** Record a player donation to a charity drive. */
function donateTo(playerName, kind, amount, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !kind) return null;
  const amt = Math.max(0, Math.floor(amount ?? 0));
  pruneLedgers(nowMs);
  donations.set(name, { kind: String(kind), amount: amt, at: nowMs });
  return { kind: String(kind), amount: amt };
}

/** The active donation record for a player, or null. */
function donationFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = donations.get(name);
  return rec ? { kind: rec.kind, amount: rec.amount } : null;
}

/** A player organizes their own charity drive. */
function organizeDrive(playerName, driveLabel, areaName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !driveLabel || !areaName) return null;
  pruneLedgers(nowMs);
  drives.set(name, { drive: String(driveLabel), area: String(areaName), at: nowMs });
  return { drive: String(driveLabel), area: String(areaName) };
}

/** The drive a player organized, or null. */
function driveFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = drives.get(name);
  return rec ? { drive: rec.drive, area: rec.area } : null;
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
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → volunteer? → materialized → service
// hours → real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickVolunteers(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < VOLUNTEER_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a volunteer (hash-derived, cheap)
        const type = volunteerTypeOf(record);
        if (!type) continue;

        // 3. Event helpers only work during festivals
        if (type === VOLUNTEER_EVENT && !isFestivalNow(now)) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. Service hours only
        if (!isServiceHour(now)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, VOLUNTEER_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, VOLUNTEER_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doVolunteerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-volunteers] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-volunteers] tick failed:", e?.message ?? e);
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

function doVolunteerWork(director, record, citizen, type, nowMs) {
  const area = areaFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Charity drive announcement: the crowd moment (charity workers only).
  if (type === VOLUNTEER_CHARITY) {
    const drive = driveForKingdom(record.kingdomId, nowMs);
    if (drive) {
      const key = "drive:" + String(record.kingdomId) + ":" + day;
      if (!lastFiredByCitizen.has(key)) {
        lastFiredByCitizen.set(key, nowMs);
        const line = fill(pickOne(Math.random, DRIVE_LINES), {
          drive: drive.label,
          area: area.name,
          need: drive.need,
        });
        citizen.forceChat?.(line);
        journalize(citizen, `announced ${drive.label} at ${area.name}`);
        seedRumor(`${drive.label} this week at ${area.name} — ${drive.need}!`);
        return;
      }
    }
  }

  // Routine: work emote, good deed, or volunteer invitation.
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `volunteered at ${area.name}`);
  } else if (roll < 0.75) {
    const deed = deedFor(name, nowMs);
    if (deed) {
      citizen.forceChat?.(deed);
      journalize(citizen, deed);
    } else {
      const line = pickOne(Math.random, WORK_LINES[type]);
      citizen.forceChat?.(line);
      journalize(citizen, `volunteered at ${area.name}`);
    }
  } else {
    const line = pickOne(Math.random, INVITE_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `invited a player to volunteer at ${area.name}`);
  }
}

/**
 * Thank a donating player by name (called by the LLM dialogue tier after a
 * donation is recorded).
 */
function thankDonor(citizen, donorName) {
  try {
    const line = fill(pickOne(Math.random, THANKS_LINES), {
      name: String(donorName ?? "friend"),
    });
    citizen?.forceChat?.(line);
    journalize(citizen, `thanked ${donorName} for a donation`);
    return line;
  } catch {
    return null;
  }
}

module.exports = {
  tickVolunteers,
  thankDonor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  volunteerTypeOf,
  areaFor,
  shiftFor,
  deedFor,
  driveForKingdom,
  isFestivalNow,
  signUpFor,
  signupFor,
  donateTo,
  donationFor,
  organizeDrive,
  driveFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  volunteerTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isServiceHour,
  dayNumber,
  weekNumber,
  chance,
  seededRng,
  VOLUNTEER_TYPES,
  VOLUNTEER_CLEANER,
  VOLUNTEER_HELPER,
  VOLUNTEER_CHARITY,
  VOLUNTEER_EVENT,
  SERVICE_AREAS,
  DRIVE_KINDS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    signups.clear();
    donations.clear();
    drives.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
