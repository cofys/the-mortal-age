"use strict";

/**
 * CitizenMenders — citizens who repair things: seamstresses mend clothes,
 * tinkers repair tools, cobblers fix shoes, and handymen handle everything
 * else. The repair folk keep the kingdoms running.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived mender types (stable across restarts, zero storage),
 *   per-day repair jobs derived from date + hash, and 7-day-TTL player
 *   ledgers for repair requests, pickups, and apprentice lessons.
 *   Seamstresses read the real CitizenTailors workshops (lazy require with
 *   fallback) so garment repairs happen in shops tailors actually run;
 *   tinkers read the real CitizenBlacksmiths forges the same way.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players, shop
 * hours 08:00-18:00 server time): scripted mending emotes, finished-repair
 * announcements, masterwork-restoration fanfare as the crowd moment,
 * apprentice invitations, paid-service acknowledgments.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * ACTIVITY SYSTEM, not a profession: any commoner may mend — no
 * professional exclusion chain (see the chain-saturation warning in the
 * citizen-ai-builder skill). Distinct from CitizenTailors (owns garment
 * MAKING; menders only repair) and CitizenBlacksmiths (owns metalwork;
 * tinkers only repair small tools). This module owns repair jobs, stalls,
 * and the three player ledgers.
 *
 * Wired into the director proximity tick right after the historians block.
 * Plain-node testable: CitizenMenders.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { isHobbyVisible } = require("./CitizenPrimaryHobby"); // Phase 2: visibility weighting
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning ===
const MENDER_RADIUS = 14; // tiles — close enough to see/hear
const MENDER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const MENDER_CHANCE = 0.35; // per eligible citizen per proximity tick
const MASTERWORK_CHANCE = 0.08; // of a finished repair being a masterwork restoration
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const SHOP_START_HOUR = 8; // 08:00 server time
const SHOP_END_HOUR = 18; // 18:00 server time
const MAX_REPAIR_PRICE = 200; // coins — the priciest standard repair

// === Mender types ===
const MENDER_SEAMSTRESS = "seamstress";
const MENDER_TINKER = "tinker";
const MENDER_COBBLER = "cobbler";
const MENDER_HANDYMAN = "handyman";
const MENDER_TYPES = [
  MENDER_SEAMSTRESS,
  MENDER_TINKER,
  MENDER_COBBLER,
  MENDER_HANDYMAN,
];
const MENDER_WEIGHTS = {
  [MENDER_SEAMSTRESS]: 30,
  [MENDER_TINKER]: 30,
  [MENDER_COBBLER]: 25,
  [MENDER_HANDYMAN]: 15,
};

// === Repair stalls (kingdom-preferred) ===
const STALLS = [
  { name: "the Varrock cloth market stall", kingdom: "misthalin" },
  { name: "the Lumbridge repair nook", kingdom: "misthalin" },
  { name: "the Falador east gate workshop", kingdom: "asgarnia" },
  { name: "the Dwarven repair bench", kingdom: "asgarnia" },
  { name: "the Ardougne mending shop", kingdom: "kandarin" },
  { name: "the Hemenster tinker cart", kingdom: "kandarin" },
  { name: "the Keldagrim forge-side stall", kingdom: "keldagrim" },
  { name: "the Dorgesh spare-parts cave", kingdom: "keldagrim" },
  { name: "the Darkmeyer cobbler corner", kingdom: "morytania" },
  { name: "the Al Kharid souk stall", kingdom: "kharidian" },
];

// === Repairable items by type ===
const REPAIRABLES = {
  [MENDER_SEAMSTRESS]: [
    { item: "a torn cloak", price: 12 },
    { item: "a split tunic", price: 10 },
    { item: "a frayed hem", price: 8 },
    { item: "a moth-eaten gown", price: 25 },
    { item: "a loose buttoned vest", price: 9 },
    { item: "a ripped seam", price: 7 },
  ],
  [MENDER_TINKER]: [
    { item: "a bent hatchet head", price: 15 },
    { item: "a cracked pickaxe handle", price: 18 },
    { item: "a broken tinderbox", price: 6 },
    { item: "a dulled knife", price: 8 },
    { item: "a split hammer haft", price: 14 },
    { item: "a rusty saw", price: 20 },
  ],
  [MENDER_COBBLER]: [
    { item: "a worn sole", price: 10 },
    { item: "a broken boot lace", price: 4 },
    { item: "a split boot", price: 16 },
    { item: "a scuffed shoe", price: 7 },
    { item: "a loose heel", price: 9 },
  ],
  [MENDER_HANDYMAN]: [
    { item: "a dented kettle", price: 11 },
    { item: "a loose hinge", price: 5 },
    { item: "a wobbly chair leg", price: 9 },
    { item: "a cracked bucket", price: 6 },
    { item: "a jammed latch", price: 8 },
    { item: "a warped wheel rim", price: 22 },
  ],
};

// === Scripted lines ===
const WORK_LINES = {
  [MENDER_SEAMSTRESS]: [
    "This cloak will outlive us all when I'm done with it.",
  ],
  [MENDER_TINKER]: [
    "Give it a day and it'll cut like new.",
  ],
  [MENDER_COBBLER]: [
    "These boots have another hundred miles in them.",
  ],
  [MENDER_HANDYMAN]: [
    "Nothing a bit of care won't fix.",
  ],
};

const FINISHED_LINES = [
  "All done — {item} is as good as new, {name}.",
  "{name}, your {item} is ready. Good as the day it was made.",
  "There — {item} fixed and fair. That'll be {price} coins, {name}.",
  "{item} sorted, {name}. Look after it this time!",
];

const MASTERWORK_LINES = [
  "Behold — {name}'s {item} restored to better than new! A true masterwork!",
  "Gather round! I've just finished a masterwork restoration of {name}'s {item}!",
  "They'll tell of this repair for years — {name}'s {item}, good as a king's!",
];

const INVITE_LINES = [
  "Want to learn a trade, friend? I teach mending on quiet afternoons.",
  "A steady hand and patience — that's all mending needs. Interested?",
  "I take apprentices. You'd learn a skill that never goes hungry.",
];

const THANKS_LINES = [
  "Much obliged, {name}. Your custom keeps the lamps lit.",
  "A fair price for honest work — thank you, {name}.",
  "{name}, you're a fine customer. Bring your broken things anytime.",
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
const requests = new Map(); // normName -> { item, price, type, at }
const pickups = new Map(); // normName -> { item, at }
const lessons = new Map(); // normName -> { type, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of requests) {
    if (nowMs - v.at > LEDGER_TTL_MS) requests.delete(k);
  }
  for (const [k, v] of pickups) {
    if (nowMs - v.at > LEDGER_TTL_MS) pickups.delete(k);
  }
  for (const [k, v] of lessons) {
    if (nowMs - v.at > LEDGER_TTL_MS) lessons.delete(k);
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

/** Weighted pick of a mender type from a 0..99 roll. */
function menderTypeFromRoll(roll) {
  let acc = 0;
  for (const t of MENDER_TYPES) {
    acc += MENDER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return MENDER_SEAMSTRESS;
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

/** True during shop hours (08:00-18:00 server time). */
function isShopHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= SHOP_START_HOUR && h < SHOP_END_HOUR;
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
// Mender identity — hash-derived, stable across restarts, no storage.
// ACTIVITY SYSTEM: no professional exclusions — any commoner may mend.
// ============================================================================

function menderTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    return menderTypeFromRoll(hashStr("mender:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred repair stall for a record. */
function stallFor(record) {
  const kid = record?.kingdomId;
  const local = STALLS.filter((a) => a.kingdom === kid);
  const pool = local.length ? local : STALLS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("menderstall:" + name) % pool.length];
}

/**
 * Today's repair job queue for a mender: 1-3 jobs { item, price }.
 * Derived from date + hash; zero storage.
 */
function jobsFor(username, kingdomId, dateMs) {
  const name = normalizeName(username);
  if (!name) return [];
  const type = menderTypeOf({ username: name, kingdomId });
  if (!type) return [];
  const pool = REPAIRABLES[type];
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("menderjobs:" + name + ":" + day));
  const count = 1 + Math.floor(rng() * 3);
  const jobs = [];
  for (let i = 0; i < count; i++) {
    jobs.push(pickOne(rng, pool));
  }
  return jobs;
}

/** The going price for a repair type (cheapest repairable in its pool). */
function basePriceFor(type) {
  const pool = REPAIRABLES[type];
  if (!pool || !pool.length) return 0;
  return Math.min(...pool.map((r) => r.price));
}

/**
 * Where a seamstress works: the real tailor workshops (lazy require,
 * fallback to the mender stall). Keeps repairs in shops tailors run.
 */
function tailorWorkshopFor(username, kingdomId) {
  try {
    const tailors = require("./CitizenTailors");
    if (typeof tailors.workshopFor === "function") {
      const w = tailors.workshopFor(username, kingdomId);
      if (w) return w;
    }
  } catch { /* tailors absent */ }
  return null;
}

/**
 * Where a tinker works: the real blacksmith forges (lazy require,
 * fallback to the mender stall).
 */
function smithForgeFor(username, kingdomId) {
  try {
    const smiths = require("./CitizenBlacksmiths");
    if (typeof smiths.forgeFor === "function") {
      const f = smiths.forgeFor(username, kingdomId);
      if (f) return f;
    }
  } catch { /* smiths absent */ }
  return null;
}

// ============================================================================
// Player participation (data tier, zero LLM).
// ============================================================================

/** A player leaves an item for repair with a mender. */
function requestRepair(playerName, itemName, type, price, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !itemName) return null;
  const amt = Math.max(0, Math.min(MAX_REPAIR_PRICE, Math.floor(price ?? 10)));
  pruneLedgers(nowMs);
  requests.set(name, { item: String(itemName), type: String(type ?? ""), price: amt, at: nowMs });
  return { item: String(itemName), price: amt };
}

/** The active repair request for a player, or null. */
function repairFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = requests.get(name);
  return rec ? { item: rec.item, price: rec.price, type: rec.type } : null;
}

/** A player collects (and pays for) their finished repair. */
function collectRepair(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = requests.get(name);
  if (!rec) return null;
  requests.delete(name);
  pickups.set(name, { item: rec.item, at: nowMs });
  return { item: rec.item, price: rec.price };
}

/** The last pickup record for a player, or null. */
function pickupFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = pickups.get(name);
  return rec ? { item: rec.item } : null;
}

/** A player takes an apprentice mending lesson. */
function learnMending(playerName, type, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !type) return null;
  pruneLedgers(nowMs);
  lessons.set(name, { type: String(type), at: nowMs });
  return String(type);
}

/** The apprentice lesson a player took, or null. */
function lessonFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = lessons.get(name);
  return rec ? rec.type : null;
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
// Gate order: cooldown (cheapest) → mender? → materialized → shop hours →
// real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickMenders(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < MENDER_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a mender (hash-derived, cheap)
        const type = menderTypeOf(record);
        if (!type) continue;

        // 2b. Visibility weight (Phase 2 distribution fix): the primary hobby
        // always fires visibly; other hobbies fire 1/3 as often.
        if (!isHobbyVisible(record.username, "mender")) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Shop hours only
        if (!isShopHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, MENDER_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, MENDER_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doMenderWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-menders] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-menders] tick failed:", e?.message ?? e);
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

function doMenderWork(director, record, citizen, type, nowMs) {
  const stall = stallFor(record);
  const jobs = jobsFor(record.username, record.kingdomId, nowMs);
  const day = dayNumber(nowMs);

  // Masterwork restoration: the crowd moment (rare, once per kingdom per day).
  if (jobs.length && chance(Math.random, MASTERWORK_CHANCE)) {
    const job = jobs[0];
    const key = "masterwork:" + String(record.kingdomId) + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, MASTERWORK_LINES), {
        name: "Widow Hettie",
        item: job.item,
      });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(citizen, `finished a masterwork restoration of ${job.item}`);
      seedRumor(`A masterwork restoration at ${stall.name} — ${job.item} made better than new!`);
      return;
    }
  }

  // Routine: mending emote, finished-repair callout, or apprentice invite.
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `mending at ${stall.name}`);
  } else if (roll < 0.75 && jobs.length) {
    const job = pickOne(Math.random, jobs);
    const line = fill(pickOne(Math.random, FINISHED_LINES), {
      item: job.item,
      price: job.price,
      name: "young Pip",
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `finished repairing ${job.item} for ${job.price} coins`);
  } else {
    const line = pickOne(Math.random, INVITE_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `offered mending lessons at ${stall.name}`);
  }
}

/**
 * Thank a paying customer by name (called by the LLM dialogue tier after a
 * repair is collected and paid for).
 */
function thankCustomer(citizen, customerName) {
  try {
    const line = fill(pickOne(Math.random, THANKS_LINES), {
      name: String(customerName ?? "friend"),
    });
    { const _cvp = citizen?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `thanked ${customerName} for their custom`);
    return line;
  } catch {
    return null;
  }
}

module.exports = {
  tickMenders,
  thankCustomer,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  menderTypeOf,
  stallFor,
  jobsFor,
  basePriceFor,
  tailorWorkshopFor,
  smithForgeFor,
  requestRepair,
  repairFor,
  collectRepair,
  pickupFor,
  learnMending,
  lessonFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  menderTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isShopHour,
  dayNumber,
  chance,
  seededRng,
  MENDER_TYPES,
  MENDER_SEAMSTRESS,
  MENDER_TINKER,
  MENDER_COBBLER,
  MENDER_HANDYMAN,
  STALLS,
  REPAIRABLES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    requests.clear();
    pickups.clear();
    lessons.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
