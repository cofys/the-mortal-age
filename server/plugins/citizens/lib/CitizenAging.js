"use strict";

/**
 * CitizenAging — the natural lifecycle: citizens age, slow down, grow wise,
 * retire from their careers, and new blood arrives to keep towns alive.
 *
 * WHAT IT DOES (data tier, free — slow ~60s tick):
 *   age advancement (1 game-year per real day), life-stage transitions
 *   (adult → middle-aged → elder, journaled), elder wisdom XP bonuses,
 *   career retirement for elders in working roles, and immigration when
 *   the roster thins (deaths outpace births).
 *
 * WHAT ALREADY EXISTED (wired in, not duplicated):
 *   - Death: tickMortality (CitizenFunerals) rolls natural death from 75+.
 *   - Funerals, grief, mourning: CitizenFunerals.
 *   - Inheritance: CitizenFamilyLife (homes + coins to heirs).
 *   - Retirement ceremony: CitizenRetirement (60+, scripted honors).
 *   - Slower movement: movementStyleFor (CitizenAlive) already walks
 *     60+ citizens as "ambler" — the honest expression of slower legs.
 *
 * WHAT THIS ADDS:
 *   1. Ages that actually advance. personality.age was read in three places
 *      but never incremented — no citizen ever reached 60, so retirement
 *      and old-age death could only fire via the "elderly" trait.
 *   2. Wisdom: elders +10% XP, middle-aged +5% XP (slower hands, deeper
 *      knowledge). Applied in CitizenSkilling.grantXpWithCelebration.
 *   3. Real retirement: elders in working roles stop earning wages and
 *      live off savings (CitizenCareerLife honors the retired flag).
 *   4. Immigration: newcomers arrive by caravan when the roster drops
 *      below target, so deaths don't hollow out towns.
 *
 * Persistence: ages live in data/saves/citizen-aging.json (dirty-flag
 * pattern, never committed) AND are written back onto record.personality.age
 * each tick so every existing reader (funerals, retirement, movement)
 * sees the truth without changes.
 *
 * Zero LLM: stage transitions and arrivals are scripted frames. The LLM
 * chat layer can riff on journaled facts ("I turned sixty last winter").
 *
 * Wired: tickAging on the director slow tick, after tickFamilies.
 * Plain-node testable: CitizenAging.test.js.
 */

const fs = require("fs");
const path = require("path");
const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");
const { agentRng, chance } = require("./humanizer");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-aging.json");

// === Tuning: all magic numbers here ===
const YEAR_MS = 24 * 3600 * 1000; // one game-year per real day
const MIDDLE_AGE_AT = 45; // adult → middle-aged
const ELDER_AT = 60; // middle-aged → elder (matches retirement + ambler cutoffs)
const ELDER_XP_BONUS = 0.1; // +10% XP — wiser
const MIDDLE_XP_BONUS = 0.05; // +5% XP
const IMMIGRATION_TARGET = 105; // below the 110 roster soft cap (room for grown children)
const IMMIGRANTS_PER_TICK = 2; // at most this many arrivals per slow tick
const RETIRABLE_ROLES = new Set(["guard", "merchant", "commoner"]); // courtiers advise for life

// Default per-kingdom role plan (mirrors the director's defaultPlan).
const PLAN_ROLES = { guard: 4, merchant: 3, commoner: 10, courtier: 3 };

// Caravan origins for arrival flavor — real places on the map.
const CARAVAN_ORIGINS = [
  "Varrock",
  "Falador",
  "Ardougne",
  "Keldagrim",
  "Canifis",
  "Lumbridge",
  "Draynor",
  "Port Sarim",
];

const KINGDOM_NAMES = {
  asgarnia: "Asgarnia",
  kandarin: "Kandarin",
  keldagrim: "Keldagrim",
  misthalin: "Misthalin",
  morytania: "Morytania",
};

// === State ===
let cache = null; // { citizens: { [normName]: { age, lastAgedAt } } }
let dirty = false;
let loaded = false;

function data() {
  if (!cache) {
    cache = { citizens: {} };
    load();
  }
  return cache;
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (parsed && typeof parsed.citizens === "object") {
      cache.citizens = parsed.citizens;
    }
  } catch {
    // Corrupt or missing save — start empty, never crash.
  }
}

function markDirty() {
  dirty = true;
}

function save() {
  if (!dirty) return false;
  try {
    load();
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ savedAt: Date.now(), citizens: cache.citizens }));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/** Test seam. */
function resetForTests() {
  cache = null;
  dirty = false;
  loaded = false;
}

/** Test seam — redirect the save path. */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
  resetForTests();
}

// ============================================================================
// Pure helpers — testable with plain node.
// ============================================================================

/** Life stage for an age: adult (18-44), middle-aged (45-59), elder (60+). */
function ageStage(age) {
  const a = Number(age ?? 35);
  if (a >= ELDER_AT) return "elder";
  if (a >= MIDDLE_AGE_AT) return "middle-aged";
  return "adult";
}

/** True for citizens old enough to retire from working roles. */
function isElderAge(age) {
  return Number(age ?? 35) >= ELDER_AT;
}

/** True for roles citizens retire from (courtiers advise for life). */
function isRetirableRole(role) {
  return RETIRABLE_ROLES.has(String(role ?? "").toLowerCase());
}

/** XP multiplier bonus from life stage: elders +10%, middle-aged +5%. */
function xpBonusForAge(age) {
  const stage = ageStage(age);
  if (stage === "elder") return ELDER_XP_BONUS;
  if (stage === "middle-aged") return MIDDLE_XP_BONUS;
  return 0;
}

/** XP bonus for a roster record (reads the persisted/live age). */
function xpBonusForRecord(record) {
  return xpBonusForAge(ageOf(record));
}

/**
 * The citizen's current age. Reads the aging registry (persisted), falls
 * back to record.personality.age, then 35. Never throws.
 */
function ageOf(record) {
  try {
    const key = normalizeName(record?.username);
    const entry = key ? data().citizens[key] : null;
    if (entry && Number.isFinite(Number(entry.age))) return Number(entry.age);
  } catch {
    // Fall through to the record.
  }
  return Number(record?.personality?.age ?? 35);
}

/** Seed a starting age for a citizen with none (20-54, working-age spread). */
function seedAge(rng) {
  return 20 + Math.floor((rng ?? Math.random)() * 35);
}

// ============================================================================
// Journal — one line, never throws.
// ============================================================================

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// Aging — advance years on the slow tick.
// ============================================================================

const STAGE_LINES = {
  "middle-aged": [
    "{name} is feeling their years — the knees complain on cold mornings now.",
    "Some grey at the temples: {name} has joined the middle-aged ranks.",
  ],
  elder: [
    "{name} has seen sixty winters, and carries every one of them with grace.",
    "Elder {name} now — the town's newest old soul.",
  ],
};

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Advance one citizen's age. Returns the new age. Stage transitions are
 * journaled once (tracked via the stored stage).
 */
function ageCitizen(record, nowMs, rng) {
  const key = normalizeName(record.username);
  if (!key) return ageOf(record);
  const d = data();
  let entry = d.citizens[key];
  if (!entry) {
    // First sight: seed from the record or fresh.
    const startAge = Number.isFinite(Number(record?.personality?.age))
      ? Number(record.personality.age)
      : seedAge(rng);
    entry = { age: startAge, lastAgedAt: nowMs, stage: ageStage(startAge) };
    d.citizens[key] = entry;
    markDirty();
  }
  const years = Math.floor((nowMs - (entry.lastAgedAt || nowMs)) / YEAR_MS);
  if (years > 0) {
    entry.age += years;
    entry.lastAgedAt = (entry.lastAgedAt || nowMs) + years * YEAR_MS;
    markDirty();
  }
  // Keep the live record honest for every existing reader.
  try {
    if (record.personality) record.personality.age = entry.age;
  } catch {
    // Read-only record shape — the registry is still the source of truth.
  }
  // Stage transition, journaled once.
  const stage = ageStage(entry.age);
  if (entry.stage !== stage) {
    entry.stage = stage;
    markDirty();
    if (stage === "middle-aged" || stage === "elder") {
      const line = pickOne(rng ?? Math.random, STAGE_LINES[stage]).replace(
        "{name}",
        record.display || record.username
      );
      journalEvent(record.username, line, "social");
    }
  }
  return entry.age;
}

/** Forget a citizen's aging state (death, removal). */
function forgetCitizen(username) {
  const key = normalizeName(username);
  if (key && data().citizens[key]) {
    delete data().citizens[key];
    markDirty();
  }
}

// ============================================================================
// Retirement — elders in working roles stop earning, live off savings.
// ============================================================================

/**
 * Retire eligible elders: sets the career record's retired flag so
 * CitizenCareerLife stops wages, promotions, and re-assignment. Returns
 * the list of newly retired usernames.
 */
function processRetirements(director, nowMs) {
  const retired = [];
  let Careers = null;
  try {
    Careers = require("./CitizenCareers");
  } catch {
    return retired;
  }
  for (const record of director?.roster?.values?.() ?? []) {
    try {
      if (!isRetirableRole(record.role)) continue;
      if (!isElderAge(ageOf(record))) continue;
      if (Careers.isCareerRetired(record.username)) continue;
      Careers.retireCitizen(record.username, nowMs);
      retired.push(record.username);
      journalEvent(
        record.username,
        `Has retired from working life; living off savings now, an elder of the town.`,
        "career"
      );
    } catch {
      // One citizen's retirement must never break the loop.
    }
  }
  return retired;
}

// ============================================================================
// Immigration — newcomers arrive when deaths outpace births.
// ============================================================================

/** Per-kingdom role plan, honoring the CITIZEN_PLAN env override. */
function planRoles() {
  const raw = process.env.CITIZEN_PLAN ?? "";
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Fall through to the default.
    }
  }
  return null; // caller falls back to PLAN_ROLES
}

/** Count roster citizens per kingdom per role. */
function rosterCounts(director) {
  const counts = {};
  for (const record of director?.roster?.values?.() ?? []) {
    const k = record.kingdomId;
    if (!k) continue;
    counts[k] = counts[k] || {};
    const role = String(record.role || "commoner").toLowerCase();
    counts[k][role] = (counts[k][role] || 0) + 1;
  }
  return counts;
}

/**
 * Pick the (kingdomId, role) with the largest deficit against plan.
 * Pure-ish: takes counts + plan, returns { kingdomId, role, deficit }.
 */
function biggestDeficit(counts, plan) {
  let best = null;
  for (const [kingdomId, roles] of Object.entries(plan)) {
    for (const [role, wanted] of Object.entries(roles)) {
      const have = counts[kingdomId]?.[role] ?? 0;
      const deficit = wanted - have;
      if (deficit > 0 && (!best || deficit > best.deficit)) {
        best = { kingdomId, role, deficit };
      }
    }
  }
  return best;
}

function kingdomDisplay(kingdomId) {
  return KINGDOM_NAMES[kingdomId] || String(kingdomId);
}

/**
 * Bring in newcomers while the roster is below target. Each immigrant is a
 * real citizen via director.addCitizen, seeded as a working-age adult and
 * announced with caravan flavor. Returns the arrival records.
 */
function processImmigration(director, nowMs, rng) {
  const arrivals = [];
  try {
    const size = director?.roster?.size ?? IMMIGRATION_TARGET;
    if (size >= IMMIGRATION_TARGET) return arrivals;
    if (typeof director?.addCitizen !== "function") return arrivals;
    const random = rng ?? Math.random;
    const envPlan = planRoles();
    const kingdoms = new Set([
      ...Object.keys(envPlan || {}),
      ...Object.keys(rosterCounts(director)),
    ]);
    const plan = {};
    for (const k of kingdoms) {
      plan[k] = envPlan?.[k] || PLAN_ROLES;
    }
    const counts = rosterCounts(director);
    for (let i = 0; i < IMMIGRANTS_PER_TICK; i++) {
      if ((director?.roster?.size ?? IMMIGRATION_TARGET) >= IMMIGRATION_TARGET) break;
      const need = biggestDeficit(rosterCounts(director), plan);
      if (!need) break;
      const record = director.addCitizen(need.kingdomId, need.role);
      if (!record) continue;
      // Working-age adult, 20-40.
      const age = 20 + Math.floor(random() * 21);
      const key = normalizeName(record.username);
      data().citizens[key] = { age, lastAgedAt: nowMs, stage: ageStage(age) };
      try {
        if (record.personality) record.personality.age = age;
      } catch {
        // Registry is the source of truth.
      }
      markDirty();
      const origin = pickOne(random, CARAVAN_ORIGINS);
      const where = kingdomDisplay(need.kingdomId);
      journalEvent(
        record.username,
        `Arrived in ${where} on the ${origin} caravan, seeking work and a new life.`,
        "social"
      );
      arrivals.push({ record, origin, kingdomId: need.kingdomId });
    }
  } catch (e) {
    try {
      director?.log?.("immigration failed", { error: String(e?.message ?? e) });
    } catch {
      // Never break the tick.
    }
  }
  return arrivals;
}

/**
 * Visible arrival greetings — only where a real player can hear. Called
 * from the proximity tick path by the caller (kept separate so the data
 * tick stays player-free).
 */
function announceArrivals(director, arrivals) {
  if (!arrivals || !arrivals.length) return;
  let sayPublic = null;
  let voiceFor = null;
  let voiceLine = null;
  try {
    ({ sayPublic } = require("../chat/CitizenSayPublic"));
    ({ voiceFor, voiceLine } = require("./citizenVoice"));
  } catch {
    return;
  }
  for (const { record, origin, kingdomId } of arrivals) {
    try {
      const bot = director?.getBot ? director.getBot(record) : null;
      if (!bot) continue;
      const locals = [...(bot.getLocalPlayers?.() ?? [])];
      const watched = locals.some((p) => {
        try {
          return p !== bot && p.isPlayerBot?.() !== true && p.getHostAddress?.() !== "bot";
        } catch {
          return false;
        }
      });
      if (!watched) continue;
      const name = record.display || record.username;
      const line = `New in town! ${name}, fresh off the ${origin} caravan — be kind, ${kingdomDisplay(kingdomId)} is home now.`;
      const cvp = bot.getAttribute?.("citizen-personality") ?? {};
      sayPublic(bot, voiceLine(voiceFor(cvp), { plain: [line.slice(0, 140)] }));
    } catch {
      // A shy arrival.
    }
  }
}

// ============================================================================
// The tick — called from the director slow tick (~60s), data tier.
// Gate order: retirements → aging → immigration.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} [rng] - optional rng (test seam)
 */
function tickAging(director, nowMs, rng) {
  const random = rng ?? agentRng("aging");
  try {
    // 1. Elders in working roles retire (before aging advances anyone).
    processRetirements(director, nowMs);
    // 2. Advance everyone's age; journal stage transitions.
    for (const record of director?.roster?.values?.() ?? []) {
      try {
        ageCitizen(record, nowMs, random);
      } catch {
        // One citizen's birthday must never break the loop.
      }
    }
    // 3. Replenish the roster when deaths outpace births.
    const arrivals = processImmigration(director, nowMs, random);
    // Stash arrivals for the proximity tick to announce (data tick is silent).
    try {
      director._pendingArrivals = (director._pendingArrivals || []).concat(arrivals);
    } catch {
      // Non-fatal.
    }
  } catch (e) {
    try {
      director?.log?.("aging tick failed", { error: String(e?.message ?? e) });
    } catch {
      // Last resort.
    }
  }
}

/** One-line status for debugging. */
function agingStatus() {
  const d = data();
  const n = Object.keys(d.citizens).length;
  let elders = 0;
  let middle = 0;
  for (const e of Object.values(d.citizens)) {
    const s = ageStage(e.age);
    if (s === "elder") elders++;
    else if (s === "middle-aged") middle++;
  }
  return `${n} tracked, ${elders} elders, ${middle} middle-aged`;
}

module.exports = {
  tickAging,
  announceArrivals,
  agingStatus,
  // Data tier:
  ageOf,
  ageCitizen,
  forgetCitizen,
  processRetirements,
  processImmigration,
  biggestDeficit,
  rosterCounts,
  // Pure helpers for tests:
  ageStage,
  isElderAge,
  isRetirableRole,
  xpBonusForAge,
  xpBonusForRecord,
  seedAge,
  save,
  // Test seams:
  resetForTests,
  _setSavePathForTests,
  _data: data,
};
