"use strict";

/**
 * CitizenHealers2 — community caregivers: neighbors who sit vigil with the
 * sick, bonesetters who splint breaks, midwives who tend new mothers, and
 * remedy-brewers who simmer household cures from garden herbs.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived caregiver types, per-day care rounds (1-3 visits derived
 *   from date + hash), household remedy recipes, and recovery events.
 *   Caregivers visit citizens who are REALLY sick or injured — the patient
 *   list is read from the actual CitizenHealers ailment map, so the fiction
 *   stays consistent. Remedy ingredients come from the real
 *   CitizenHerbalists herb tables when available.
 *   7-day TTL player ledgers for house-call requests, remedy purchases and
 *   first-aid lessons — exported for the LLM dialogue tier.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-20:00 server-local): scripted care emotes ("*changes Marta's
 * poultice*"), remedy-brewing lines, first-aid lesson offers, and recovery
 * fanfare as the crowd moment when a long-ill neighbor gets well.
 *
 * No overlap (by design):
 * - CitizenHealers own the PROFESSIONAL side: clinics, plague treatment,
 *   surgery, and birth announcements. Professional healers
 *   (CitizenHealers.isHealer) are EXCLUDED here — this module owns the
 *   informal community side: sitting vigil, home nursing, folk bonesetting,
 *   tending new mothers AFTER the birth.
 * - CitizenHerbalists own the professional herb trade (gathering grounds,
 *   hawking). Professional herbalists are EXCLUDED here — remedy-brewers
 *   only simmer household cures from garden herbs, never gather or hawk.
 * - CitizenAlchemists own potions; brewers here never touch the
 *   professional potion trade (their wares are only named in small talk).
 *
 * Zero LLM: scripted line pools; the journal feeds the LLM mouth.
 *
 * Activity system (no professional exclusion chain): any commoner may care.
 * Deliberately NOT in HOBBY_KEYS: visibility is throttled via chance +
 * cooldown (the couriers precedent) instead of adding another hobby key.
 * Plain-node testable: CitizenHealers2.test.js.
 *
 * Wired into the director tick right after the educators block.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// Top-level requires (perf lesson from the artisan fix): the exclusion
// chain modules are linear deps with no back-references to this module,
// so hoisting is cycle-safe. safeRequire preserves the "module absent"
// fallback the lazy pattern had.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const HealersPro = safeRequire("./CitizenHealers");
const HerbalistsPro = safeRequire("./CitizenHerbalists");
const AlchemistsPro = safeRequire("./CitizenAlchemists");

// === Tuning ===
const CARE_RADIUS = 14; // tiles — close enough to see/hear
const CARE_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen cares this often
const CARE_CHANCE = 0.15; // per eligible citizen per tick (couriers-style narrowing)
const CARE_START_HOUR = 8; // 08:00 server-local
const CARE_END_HOUR = 20; // 20:00 server-local
const RECOVERY_CHANCE = 0.1; // per kingdom per day: a long-ill neighbor recovers
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_ROUNDS_PER_DAY = 3;

// === Caregiver types ===
const CAREGIVER_NEIGHBOR = "neighbor";
const CAREGIVER_BONESETTER = "bonesetter";
const CAREGIVER_MIDWIFE = "midwife";
const CAREGIVER_BREWER = "remedy-brewer";
const CAREGIVER_TYPES = [
  CAREGIVER_NEIGHBOR,
  CAREGIVER_BONESETTER,
  CAREGIVER_MIDWIFE,
  CAREGIVER_BREWER,
];
const CAREGIVER_WEIGHTS = {
  [CAREGIVER_NEIGHBOR]: 30,
  [CAREGIVER_BONESETTER]: 25,
  [CAREGIVER_MIDWIFE]: 25,
  [CAREGIVER_BREWER]: 20,
};

// === Care houses (kingdom-preferred) ===
const CARE_HOUSES = [
  { name: "Widow Ansel's cottage", kingdom: "misthalin" },
  { name: "the Lumbridge almshouse", kingdom: "misthalin" },
  { name: "the Falador hospice ward", kingdom: "asgarnia" },
  { name: "the White Knights' infirmary", kingdom: "asgarnia" },
  { name: "the Ardougne lying-in house", kingdom: "kandarin" },
  { name: "the Hemenster sickroom", kingdom: "kandarin" },
  { name: "the Keldagrim stone sickbay", kingdom: "keldagrim" },
  { name: "the Dorgesh nursing burrow", kingdom: "keldagrim" },
  { name: "the Darkmeyer night ward", kingdom: "morytania" },
  { name: "the Al Kharid rest house", kingdom: "kharidian" },
];

// === Household remedy bases (static fallback; herbs come from the real tables) ===
const REMEDY_BASES = [
  "fever tea",
  "poultice",
  "cough syrup",
  "sleep draught",
  "wound salve",
  "stomach tonic",
];

// === Scripted lines ===
const CARE_LINES = {
  [CAREGIVER_NEIGHBOR]: [
    "Rest now. I'll keep the lamp lit.",
  ],
  [CAREGIVER_BONESETTER]: [
    "Hold still — this will ache, then mend.",
    "Keep weight off it a fortnight, mind.",
  ],
  [CAREGIVER_MIDWIFE]: [
    "The little one feeds well. You're doing fine.",
    "Rest, love. I'll watch them both.",
  ],
  [CAREGIVER_BREWER]: [
    "Three drops in hot water, morning and night.",
  ],
};

const LESSON_LINES = [
  "I can show you the basics of first aid, if you've a mind to learn.",
  "Every traveler should know how to bind a wound — want a quick lesson?",
];

const RECOVERY_LINES = [
  "{patient} is up and walking! The {house} rings with cheer!",
  "Good news — {patient} has turned the corner and is on the mend!",
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
const careRequests = new Map(); // normName -> { ailment, at }
const remedySales = new Map(); // normName -> { remedy, at }
const firstAidLessons = new Map(); // normName -> { at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of careRequests) {
    if (nowMs - v.at > LEDGER_TTL_MS) careRequests.delete(k);
  }
  for (const [k, v] of remedySales) {
    if (nowMs - v.at > LEDGER_TTL_MS) remedySales.delete(k);
  }
  for (const [k, v] of firstAidLessons) {
    if (nowMs - v.at > LEDGER_TTL_MS) firstAidLessons.delete(k);
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

/** Weighted pick of a caregiver type from a 0..99 roll. */
function caregiverTypeFromRoll(roll) {
  let acc = 0;
  for (const t of CAREGIVER_TYPES) {
    acc += CAREGIVER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return CAREGIVER_NEIGHBOR;
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

/** True during care hours (08:00-20:00 server-local). */
function isCareHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= CARE_START_HOUR && h < CARE_END_HOUR;
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
// Caregiver identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The caregiver type for a roster record, or null.
 * Excludes professional healers (CitizenHealers owns clinics, plague
 * treatment, surgery, birth announcements) and professional herbalists
 * (CitizenHerbalists owns the herb trade) so no citizen belongs to both
 * the professional and the community side of care.
 */
function caregiverTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: professional healers own the clinics...
    try {
      if (HealersPro && typeof HealersPro.isHealer === "function" && HealersPro.isHealer(record)) return null;
    } catch { /* module absent */ }
    // ...and professional herbalists own the herb trade.
    try {
      if (HerbalistsPro && typeof HerbalistsPro.isHerbalist === "function" && HerbalistsPro.isHerbalist(record)) return null;
    } catch { /* module absent */ }
    const roll = hashStr("caregiver:" + name) % 100;
    if (roll >= 100) return null;
    return caregiverTypeFromRoll(hashStr("caregivertype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred care house, stable across restarts. */
function careHouseFor(record) {
  const kid = record?.kingdomId;
  const local = CARE_HOUSES.filter((h) => h.kingdom === kid);
  const pool = local.length ? local : CARE_HOUSES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("carehouse:" + name) % pool.length];
}

/**
 * Citizens who are REALLY sick or injured right now, read from the actual
 * CitizenHealers ailment map. Best-effort: empty list when the module is
 * absent. Names are normalized patient names.
 */
function realPatientsFor(kingdomId, nowMs) {
  try {
    const ailments = HealersPro?._ailments;
    if (!ailments || typeof ailments.keys !== "function") return [];
    const out = [];
    for (const [patient, rec] of ailments) {
      if (kingdomId && rec?.kingdomId && rec.kingdomId !== kingdomId && rec.kingdomId !== "unknown") continue;
      out.push({ patient, kind: rec?.kind ?? "sick" });
    }
    return out;
  } catch {
    return [];
  }
}

// (roundsFor removed 2026-10-08: hash-derived fabrication.)

// (remediesFor removed 2026-10-08: hash-derived fabrication.)

// (herbOfTheDay removed 2026-10-08: hash-derived fabrication.)

// (potionNameForSmallTalk removed 2026-10-08: hash-derived fabrication.)

// (recoveryFor removed 2026-10-08: hash-derived fabrication.)

// ============================================================================
// Player ledgers (data tier, zero LLM). The LLM dialogue tier performs them.
// ============================================================================

/** Request a house call from a caregiver. */
function requestCare(playerName, ailment, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  careRequests.set(name, { ailment: String(ailment ?? "feeling poorly"), at: nowMs });
  return name;
}

/** The active house-call request for a player, or null. */
function careFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = careRequests.get(name);
  return rec ? rec.ailment : null;
}

/** Buy a household remedy. */
function buyRemedy(playerName, remedy, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !remedy) return null;
  pruneLedgers(nowMs);
  remedySales.set(name, { remedy: String(remedy), at: nowMs });
  return remedy;
}

/** The active remedy purchase for a player, or null. */
function remedyFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = remedySales.get(name);
  return rec ? rec.remedy : null;
}

/** Take a first-aid lesson. */
function learnFirstAid(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  firstAidLessons.set(name, { at: nowMs });
  return name;
}

/** Whether the player has an active first-aid lesson. */
function firstAidFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  return firstAidLessons.has(name);
}

// ============================================================================
// Journal + rumor helpers.
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


// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → caregiver? → materialized → care
// hours → real player near → chance → work.
// ============================================================================

function tickCaregivers(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < CARE_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a caregiver (hash-derived, cheap; top-level requires)
        const type = caregiverTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Care hours only
        if (!isCareHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, CARE_RADIUS)) continue;

        // 6. Chance gate (visibility throttle — no hobby key by design)
        if (!chance(Math.random, CARE_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doCareWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-healers2] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-healers2] tick failed:", e?.message ?? e);
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

function doCareWork(director, record, citizen, type, nowMs) {
  const house = careHouseFor(record);

  // Recovery fanfare: once per kingdom per day, the crowd moment.
  // (Crowd-moment fabrication block removed 2026-10-08: recoveryFor was hash-derived.)

  // Routine: honest ambient chatter only.
  // (roundsFor/remediesFor branches removed 2026-10-08: hash-derived "today's
  // patient" and "today's remedies" were fabrication — no real patients treated.)
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, CARE_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `kept the care house at ${house.name}`);
  } else {
    // Lesson offer.
    const line = pickOne(Math.random, LESSON_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `offered first-aid lessons at ${house.name}`);
  }
}

module.exports = {
  tickCaregivers,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  caregiverTypeOf,
  careHouseFor,
  realPatientsFor,
  requestCare,
  careFor,
  buyRemedy,
  remedyFor,
  learnFirstAid,
  firstAidFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  caregiverTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isCareHour,
  dayNumber,
  chance,
  seededRng,
  CAREGIVER_TYPES,
  CAREGIVER_NEIGHBOR,
  CAREGIVER_BONESETTER,
  CAREGIVER_MIDWIFE,
  CAREGIVER_BREWER,
  CARE_HOUSES,
  REMEDY_BASES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    careRequests.clear();
    remedySales.clear();
    firstAidLessons.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
