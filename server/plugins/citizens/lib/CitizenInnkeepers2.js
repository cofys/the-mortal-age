"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenInnkeepers2 — the community hospitality folk: spare-room hosts,
 * home brewers, village feast organizers, and tavern regulars. Neighbors
 * who keep the spare bed made, the home brew flowing, the common room
 * lively, and the gossip fresh — hospitality as a way of life, not a trade.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived hostfolk types, per-day venue rotas, spare-room bookings,
 *   home-brew batches, feast-night schedules, 7-day TTL ledgers for room
 *   rentals, mug purchases, and feast attendance.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 10:00-23:00 local): scripted serving/hosting emotes, room and brew
 * callouts, feast-night fanfare, gossip traded for a drink.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the guardfolk block. Plain-node
 * testable: CitizenInnkeepers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenInnkeepers owns the PROFESSIONAL trade (named inns, host/cook/
 *     stablehand/bard staff, commercial service) — innTypeFor() citizens
 *     are excluded via the real module's null path.
 *   - CitizenCooks2 owns hearths, market stalls and charity kitchens —
 *     feast organizers here coordinate the *gathering*, and read real
 *     cookfolk dishes so the feast matches what's actually cooking.
 *   - CitizenVolunteers own charity drives — this module's spare rooms and
 *     feasts are paid community hospitality, not charity.
 */

// === Tuning: all magic numbers here ===
const HOSTFOLK_RADIUS = 14; // tiles — close enough to see/hear
const HOSTFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const HOSTFOLK_CHANCE = 0.15; // per eligible citizen per tick
const HOSTFOLK_SHARE = 40; // ~40% nominal share of commoners
const FEAST_CHANCE = 0.08; // ~8% per venue per day
const HOSPITALITY_START_HOUR = 10; // 10:00 server local time
const HOSPITALITY_END_HOUR = 23; // 23:00 server local time
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The professional chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProInnkeepers = safeRequire("./CitizenInnkeepers");
const Cooks2 = safeRequire("./CitizenCooks2");
const Bonds = safeRequire("./CitizenBonds");

// === Hostfolk types ===
const HOSTFOLK_HOST = "spare-room-host";
const HOSTFOLK_BREWER = "home-brewer";
const HOSTFOLK_FEASTER = "feast-organizer";
const HOSTFOLK_REGULAR = "tavern-regular";
const HOSTFOLK_TYPES = [
  HOSTFOLK_HOST,
  HOSTFOLK_BREWER,
  HOSTFOLK_FEASTER,
  HOSTFOLK_REGULAR,
];
const HOSTFOLK_WEIGHTS = {
  [HOSTFOLK_HOST]: 30,
  [HOSTFOLK_BREWER]: 30,
  [HOSTFOLK_FEASTER]: 25,
  [HOSTFOLK_REGULAR]: 15,
};

// === Community venues (kingdom-preferred; distinct from the pro named inns) ===
const VENUES = [
  { name: "the Varrock Common Room", kingdom: "misthalin" },
  { name: "the Lumbridge Village Hall", kingdom: "misthalin" },
  { name: "the Falador Long Table", kingdom: "asgarnia" },
  { name: "the White Knights' Feast Tent", kingdom: "asgarnia" },
  { name: "the Ardougne Community Hearth", kingdom: "kandarin" },
  { name: "the Hemenster Gathering Barn", kingdom: "kandarin" },
  { name: "the Keldagrim Mead Hall", kingdom: "keldagrim" },
  { name: "the Dorgesh Common Kettle", kingdom: "keldagrim" },
  { name: "the Darkmeyer Night Common Room", kingdom: "morytania" },
  { name: "the Al Kharid Hospitality Court", kingdom: "kharidian" },
];

// === Home brews (small-batch, community scale) ===
const BREWS = [
  "a mug of nut-brown home ale",
  "a cup of honey mead",
  "a tankard of small beer",
  "a mug of spiced winter ale",
  "a cup of applejack cider",
  "a tankard of porter",
];

// === Scripted lines ===
const WORK_LINES = {
  [HOSTFOLK_HOST]: [
    "Bed's made up, friend — the spare room's yours for the night.",
  ],
  [HOSTFOLK_BREWER]: [
    "Brew's ready — pull up a stool, the first mug's on me.",
  ],
  [HOSTFOLK_FEASTER]: [
    "Feast night's coming — bring an appetite and a story.",
  ],
  [HOSTFOLK_REGULAR]: [
    "Heard anything interesting lately? I trade gossip for drinks.",
  ],
};

const HAWK_LINES = [
  "Spare room going — warm bed, hot breakfast, fair price!",
  "{brew} — brewed right here, not an inn in sight!",
  "Feast night at {venue}! Long table, long tales!",
];

const FEAST_LINES = [
  "Feast night! {venue} — long table, long tales, come one and all!",
  "The long table's laid at {venue}! Feast night begins!",
  "Feast night at {venue} — bring an appetite and a story!",
];

const ROOM_OFFER_LINES = [
  "Need a bed? My spare room's warm and the breakfast's hot.",
  "Travelers welcome — spare room, fair price, no questions.",
];

const GOSSIP_LINES = [
  "Word around the common room: {rumor}",
  "Heard it here first: {rumor}",
  "Between you and me: {rumor}",
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
const roomRentals = new Map(); // normName -> { venue, at }
const mugPurchases = new Map(); // normName -> { brew, at }
const feastGuests = new Map(); // normName -> { venue, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of roomRentals) {
    if (nowMs - v.at > LEDGER_TTL_MS) roomRentals.delete(k);
  }
  for (const [k, v] of mugPurchases) {
    if (nowMs - v.at > LEDGER_TTL_MS) mugPurchases.delete(k);
  }
  for (const [k, v] of feastGuests) {
    if (nowMs - v.at > LEDGER_TTL_MS) feastGuests.delete(k);
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

/** Weighted pick of a hostfolk type from a 0..99 roll. */
function hostfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of HOSTFOLK_TYPES) {
    acc += HOSTFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return HOSTFOLK_HOST;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during hospitality hours (10:00-23:00 server local time). */
function isHospitalityHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= HOSPITALITY_START_HOUR && h < HOSPITALITY_END_HOUR;
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
// Hostfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The hostfolk type for a roster record, or null.
 * Excludes professional innkeepers (the real CitizenInnkeepers.innTypeFor —
 * it has a null path via the primary-profession partition, so it is a valid
 * eligibility gate) so the named inns and the community hearths never share
 * staff. Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function hostfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the professional trade owns the named inns.
    if (ProInnkeepers && typeof ProInnkeepers.innTypeFor === "function") {
      try {
        if (ProInnkeepers.innTypeFor(record?.username)) return null;
      } catch { /* innkeeper check failed */ }
    }
    const roll = hashStr(name + "|hostfolk") % 100;
    if (roll >= HOSTFOLK_SHARE) return null;
    return hostfolkTypeFromRoll(hashStr(name + "|hostfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred venue assignment, stable across restarts. */
function venueFor(record) {
  const kid = record?.kingdomId;
  const local = VENUES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : VENUES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|hostfolk-venue") % pool.length];
}

/** Today's home brew for a brewer (1 brew of the day). */
function brewForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|hostfolk-brew:" + day));
  return pickOne(rng, BREWS);
}

/**
 * Today's feast-night at a venue (~8%/day), or null.
 */
function feastFor(venue, dateMs) {
  if (!venue?.name) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(venue.name + "|feast-night:" + day));
  if (rng() >= FEAST_CHANCE) return null;
  return pickOne(rng, FEAST_LINES);
}

/**
 * The dish the real cookfolk are serving today — read from the actual
 * CitizenCooks2 tables (top-level safeRequire, never throws) so feast-night
 * callouts match what's really cooking. Static fallback when absent.
 */
function dishForFeast(username, kingdomId, dateMs) {
  try {
    if (Cooks2 && typeof Cooks2.dishForToday === "function") {
      const dish = Cooks2.dishForToday(username, kingdomId, dateMs);
      if (dish) return dish;
    }
  } catch { /* module absent */ }
  return "a hearty stew";
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Rent the spare room: recorded; the LLM tier handles dialogue. */
function rentRoom(playerName, venueName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !venueName) return null;
  pruneLedgers(nowMs);
  roomRentals.set(name, { venue: String(venueName), at: nowMs });
  return String(venueName);
}

/** The last spare room a player rented, or null. */
function roomFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = roomRentals.get(name);
  return rec ? rec.venue : null;
}

/** Buy a mug of home brew: recorded; the LLM tier handles dialogue. */
function buyMug(playerName, brew, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !brew) return null;
  pruneLedgers(nowMs);
  mugPurchases.set(name, { brew: String(brew), at: nowMs });
  return String(brew);
}

/** The last brew a player bought, or null. */
function mugFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = mugPurchases.get(name);
  return rec ? rec.brew : null;
}

/** Join the feast night: recorded; the LLM tier handles dialogue. */
function joinFeast(playerName, venueName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !venueName) return null;
  pruneLedgers(nowMs);
  feastGuests.set(name, { venue: String(venueName), at: nowMs });
  return String(venueName);
}

/** The last feast night a player joined, or null. */
function feastForPlayer(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = feastGuests.get(name);
  return rec ? rec.venue : null;
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

/** A fresh-ish rumor for the tavern regular to trade, or null. */
function gossipFor(citizen) {
  try {
    const rumors = require("./CitizenRumors");
    const active = rumors._activeRumors;
    if (active && typeof active.values === "function") {
      const all = [...active.values()];
      if (all.length) {
        const seed = hashStr(normalizeName(citizen?.getUsername?.()) || "anon");
        const rumor = all[seed % all.length];
        if (typeof rumors.rumorLine === "function") {
          const line = rumors.rumorLine(seededRng(seed), rumor);
          if (line) return String(line);
        }
        const c = rumor?.claim;
        if (c) return `${c.what} — ${c.where}`;
      }
    }
  } catch { /* rumors absent */ }
  return null;
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → hostfolk? → materialized → hospitality
// hours → real player near → chance → work.
// ============================================================================

function tickHostfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < HOSTFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be hostfolk (hash-derived, cheap)
        const type = hostfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Hospitality hours only
        if (!isHospitalityHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, HOSTFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, HOSTFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doHostfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-hostfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-hostfolk] tick failed:", e?.message ?? e);
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

function doHostfolkWork(director, record, citizen, type, nowMs) {
  const venue = venueFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Feast night: once per venue per feast day, the crowd moment.
  const feast = feastFor(venue, nowMs);
  if (feast) {
    const key = "feast:" + venue.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(feast, { venue: venue.name });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      const dish = dishForFeast(name, record.kingdomId, nowMs);
      journalize(citizen, `hosted feast night at ${venue.name} (serving ${dish})`);
      seedRumor(`Feast night at ${venue.name}! Long table, long tales!`);
      return;
    }
  }

  // Tavern regular: trade gossip for a drink.
  if (type === HOSTFOLK_REGULAR) {
    const rumor = gossipFor(citizen);
    if (rumor) {
      const line = fill(pickOne(Math.random, GOSSIP_LINES), { rumor: rumor.slice(0, 120) });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(citizen, "traded gossip at the common room");
      return;
    }
  }

  // Routine: work emote, hawking, room offer.
  const roll = Math.random();
  if (roll < 0.45) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `worked the ${venue.name}`);
  } else if (roll < 0.75) {
    const brew = brewForToday(name, nowMs);
    const line = fill(pickOne(Math.random, HAWK_LINES), {
      brew,
      venue: venue.name,
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `called out ${brew} at ${venue.name}`);
  } else {
    const line = pickOne(Math.random, ROOM_OFFER_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `offered the spare room near ${venue.name}`);
  }
}

module.exports = {
  tickHostfolk,
  hostfolkTypeOf,
  rentRoom,
  roomFor,
  buyMug,
  mugFor,
  joinFeast,
  feastForPlayer,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  venueFor,
  brewForToday,
  feastFor,
  dishForFeast,
  gossipFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  hostfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isHospitalityHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  HOSTFOLK_TYPES,
  HOSTFOLK_HOST,
  HOSTFOLK_BREWER,
  HOSTFOLK_FEASTER,
  HOSTFOLK_REGULAR,
  VENUES,
  BREWS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    roomRentals.clear();
    mugPurchases.clear();
    feastGuests.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
