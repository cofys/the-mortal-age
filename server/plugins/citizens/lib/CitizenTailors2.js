"use strict";

/**
 * CitizenTailors2 — the sewing folk: home seamstresses, quilters,
 * pattern-sharers and plant dyers who sew for family and neighbors from
 * kitchen tables, quilting circles and garden-dye vats.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived sewing-folk types, per-day community sewing circles,
 *   per-day projects derived from date + hash, rare grand-quilt events
 *   (~8%/circle/day) seeded into CitizenRumors, 7-day-TTL player ledgers
 *   for commissioning garments, buying fabric and learning to sew.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-18:00 local): scripted stitching/quilting/dyeing emotes,
 * grand-quilt fanfare as the crowd moment, garment commission and
 * pattern-sharing offers.
 *
 * NO OVERLAP (by design):
 *   - CitizenTailors owns the PROFESSIONAL trade (clothiers, armorers,
 *     weavers, embroiderers, the named workshops, commercial hawking,
 *     commissions for coin). Professional tailors are EXCLUDED from
 *     sewfolkTypeOf.
 *   - CitizenMenders owns REPAIR; this module owns making, altering and
 *     sharing — seamstresses refer torn items to the menders.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Visibility throttle: chance + 3h cooldown (cookfolk/huntfolk/minerfolk/
 * fisherfolk/watchmen2/healers2 precedent) — deliberately NO new
 * primary-hobby key, so adding this module does not reshuffle every
 * citizen's primary hobby.
 *
 * Wired into the director tick right after the cookfolk block.
 * Plain-node testable: CitizenTailors2.test.js.
 */

const { normalizeName } = require("./CitizenBonds");

// Top-level safeRequire (potters perf lesson): the pro-tailor exclusion
// check runs per citizen per tick, so no lazy requires in that path.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProTailors = safeRequire("./CitizenTailors");
const Herbalists = safeRequire("./CitizenHerbalists");

const FALLBACK_GARMENTS = [
  "workaday tunics",
  "sturdy breeches",
  "everyday cloaks",
  "linen shirts",
  "aprons",
  "winter quilts",
  "patchwork blankets",
];
const FALLBACK_DYES = [
  { name: "madder red", plant: "madder root" },
  { name: "woad blue", plant: "woad leaves" },
  { name: "onion-skin gold", plant: "onion skins" },
  { name: "walnut brown", plant: "walnut husks" },
];

// === Tuning: all magic numbers here ===
const SEWFOLK_RADIUS = 14; // tiles — close enough to see/hear
const SEWFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const SEWFOLK_CHANCE = 0.15; // per eligible citizen per tick
// Nominal share of commoners who sew for the community.
const SEWFOLK_SHARE = 40;
const DAWN_HOUR = 8; // 08:00 local
const DUSK_HOUR = 18; // 18:00 local
const QUILT_CHANCE = 0.08; // grand-quilt event, per circle per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Sewing-folk types ===
const SEWFOLK_SEAMSTRESS = "home-seamstress";
const SEWFOLK_QUILTER = "quilter";
const SEWFOLK_PATTERN = "pattern-sharer";
const SEWFOLK_DYER = "dyer";
const SEWFOLK_TYPES = [
  SEWFOLK_SEAMSTRESS,
  SEWFOLK_QUILTER,
  SEWFOLK_PATTERN,
  SEWFOLK_DYER,
];
const SEWFOLK_WEIGHTS = {
  [SEWFOLK_SEAMSTRESS]: 30,
  [SEWFOLK_QUILTER]: 25,
  [SEWFOLK_PATTERN]: 25,
  [SEWFOLK_DYER]: 20,
};

// === Community sewing circles (kitchen tables, quilting frames, dye yards) ===
const SEWING_CIRCLES = [
  { name: "the Varrock kitchen-table circle", kingdom: "misthalin", kind: "table" },
  { name: "the Lumbridge quilting frame", kingdom: "misthalin", kind: "frame" },
  { name: "the Draynor dye yard", kingdom: "misthalin", kind: "yard" },
  { name: "the Falador stitchers' parlor", kingdom: "asgarnia", kind: "parlor" },
  { name: "the Rimmington patchwork hall", kingdom: "asgarnia", kind: "hall" },
  { name: "the Ardougne pattern-exchange", kingdom: "kandarin", kind: "hall" },
  { name: "the Hemenster garden-dye vats", kingdom: "kandarin", kind: "yard" },
  { name: "the Keldagrim miners' mending circle", kingdom: "keldagrim", kind: "hall" },
  { name: "the Darkmeyer night sewing circle", kingdom: "morytania", kind: "parlor" },
  { name: "the Al Kharid cloth market corner", kingdom: "kharidian", kind: "table" },
];

// === Scripted lines ===
const WORK_LINES = {
  [SEWFOLK_SEAMSTRESS]: [
    "*pins a seam with her teeth, hands full of pins*",
    "*stitches a hem in quick, even rows*",
    "Cut twice, measure once — grandmother's rule.",
    "*tries a sleeve against young Tomas's arm* Nearly fits!",
  ],
  [SEWFOLK_QUILTER]: [
    "*squares another patch — blue gingham, yellow calico*",
    "*rocks the quilting frame with three neighbors*",
    "Every patch is somebody's old dress. Nothing wasted.",
    "*knots off a thread and bites it free*",
  ],
  [SEWFOLK_PATTERN]: [
    "*chalk-marks a bodice pattern on brown paper*",
    "This bodice fits if you lengthen the dart — see?",
    "*pins pattern pieces to the cloth* Mind the grain!",
    "*copies a sleeve pattern for Widow Fern*",
  ],
  [SEWFOLK_DYER]: [
    "*stirs the dye vat with a long ash pole*",
    "*lifts dripping cloth from the madder bath* Red as a sunset!",
    "Woad for blue, madder for red — the garden gives it all.",
    "*hangs dyed skeins to dry in the sun*",
  ],
};

const SHARE_LINES = [
    "I don't sew for coin, love — but I can show you the stitch.",
    "Take the pattern home, bring it back when you're done.",
    "Neighbors sew for neighbors. That's how it works here.",
];

const QUILT_LINES = [
  "It's finished! {quilt} — sixty-four patches, every one with a story!",
  "Behold the {quilt}! The whole circle stitched a square!",
  "After {days} evenings at the frame — the {quilt} is done!",
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
const commissions = new Map(); // normName -> { garment, at }
const fabricBuys = new Map(); // normName -> { fabric, at }
const sewingLessons = new Map(); // normName -> { lesson, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [map] of [[commissions], [fabricBuys], [sewingLessons]]) {
    for (const [k, v] of map) {
      if (nowMs - v.at > LEDGER_TTL_MS) map.delete(k);
    }
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

/** Weighted pick of a sewing-folk type from a 0..99 roll. */
function sewfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of SEWFOLK_TYPES) {
    acc += SEWFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return SEWFOLK_SEAMSTRESS;
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

/** True during sewing-circle hours (08:00-18:00 server-local). */
function isSewHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= DAWN_HOUR && h < DUSK_HOUR;
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
// Sewing-folk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The sewing-folk type for a roster record, or null.
 * Excludes professional tailors (they own the trade) — the pro exclusion
 * runs through the top-level-required module, never lazily per tick.
 */
function sewfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const username = record?.username;
    const name = normalizeName(username);
    if (!name) return null;
    // No overlap: professional tailors own the trade.
    try {
      if (ProTailors && typeof ProTailors.tailorTypeFor === "function" && ProTailors.tailorTypeFor(username)) {
        return null;
      }
    } catch {
      /* pro module absent or threw — treat as non-pro */
    }
    const roll = hashStr("sewfolk:" + name) % 100;
    if (roll >= SEWFOLK_SHARE) return null;
    return sewfolkTypeFromRoll(hashStr("sewfolktype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred sewing circle, stable across restarts. */
function circleFor(record) {
  const kid = record?.kingdomId;
  const local = SEWING_CIRCLES.filter((c) => c.kingdom === kid);
  const pool = local.length ? local : SEWING_CIRCLES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("sewfolkcircle:" + name) % pool.length];
}

/**
 * The day's projects for a sewing-folk citizen (1-3 items from date + hash).
 * Garment names come from the real tailors module when available.
 */
function projectsFor(username, kingdomId, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("sewfolkprojects:" + name + ":" + day));
  const count = 1 + Math.floor(rng() * 3); // 1-3
  const garments = garmentPool();
  const out = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < garments.length; i++) {
    const g = garments[Math.floor(rng() * garments.length)];
    if (used.has(g)) continue;
    used.add(g);
    out.push(g);
  }
  return out;
}

/** Garment names — prefer the real tailors module, static fallback. */
function garmentPool() {
  try {
    const prods = ProTailors && ProTailors.waresFor
      ? [ProTailors.waresFor("sewfolk-pool", "clothier", Date.now()), ProTailors.waresFor("sewfolk-pool-b", "clothier", Date.now())]
      : [];
    const names = prods.filter((x) => typeof x === "string" && x.length);
    if (names.length) return [...names, ...FALLBACK_GARMENTS];
  } catch {
    /* fall through to static */
  }
  return FALLBACK_GARMENTS.slice();
}

/**
 * Today's dye color for a dyer — read from the real herbalists tables when
 * available (plant dyes come from garden herbs), static fallback.
 */
function dyeForToday(username, kingdomId, dateMs) {
  try {
    if (Herbalists && typeof Herbalists.herbOfTheDay === "function") {
      const herb = Herbalists.herbOfTheDay(username, kingdomId, dateMs);
      const herbName = herb && typeof herb === "object" ? herb.name : herb;
      if (typeof herbName === "string" && herbName.length) {
        const h = hashStr("sewfolkdye:" + herbName + ":" + dayNumber(dateMs));
        const color = FALLBACK_DYES[h % FALLBACK_DYES.length];
        return { name: color.name, plant: herbName };
      }
    }
  } catch {
    /* fall through to static */
  }
  const h = hashStr("sewfolkdye:" + String(username) + ":" + dayNumber(dateMs));
  return FALLBACK_DYES[h % FALLBACK_DYES.length];
}

/** Today's grand-quilt at a circle (~8%/day), or null. */
function quiltFor(circle, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("sewfolkquilt:" + circle.name + ":" + day));
  if (rng() >= QUILT_CHANCE) return null;
  const quilts = [
    "wedding quilt",
    "harvest quilt",
    "new-baby quilt",
    "winter star quilt",
  ];
  const days = 6 + Math.floor(rng() * 6); // 6-11 evenings
  return { quilt: pickOne(rng, quilts), days };
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Commission a garment: recorded; the LLM tier handles dialogue. */
function commissionGarment(playerName, garment, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !garment) return null;
  pruneLedgers(nowMs);
  commissions.set(name, { garment: String(garment), at: nowMs });
  return garment;
}

/** The active garment commission for a player, or null. */
function commissionFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = commissions.get(name);
  return rec ? rec.garment : null;
}

/** Buy fabric: recorded; the LLM tier handles dialogue. */
function buyFabric(playerName, fabric, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !fabric) return null;
  pruneLedgers(nowMs);
  fabricBuys.set(name, { fabric: String(fabric), at: nowMs });
  return fabric;
}

/** The fabric a player bought, or null. */
function fabricFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = fabricBuys.get(name);
  return rec ? rec.fabric : null;
}

/** Learn sewing: recorded; the LLM tier handles dialogue. */
function learnSewing(playerName, lesson, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !lesson) return null;
  pruneLedgers(nowMs);
  sewingLessons.set(name, { lesson: String(lesson), at: nowMs });
  return lesson;
}

/** The sewing lesson a player learned, or null. */
function sewingFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = sewingLessons.get(name);
  return rec ? rec.lesson : null;
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
// Gate order: cooldown (cheapest) → sewfolk? → materialized → sewing
// hours → real player near → chance → work.
// ============================================================================

function tickSewfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < SEWFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be sewing folk (hash-derived, cheap)
        const type = sewfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Sewing hours only (server-local)
        if (!isSewHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, SEWFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, SEWFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doSewfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-sewfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-sewfolk] tick failed:", e?.message ?? e);
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

function doSewfolkWork(director, record, citizen, type, nowMs) {
  const circle = circleFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Grand-quilt unveiling: once per circle per day, the crowd moment.
  const q = quiltFor(circle, nowMs);
  if (q) {
    const key = "quilt:" + circle.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, QUILT_LINES), {
        quilt: q.quilt,
        days: q.days,
      });
      citizen.forceChat?.(line);
      journalize(citizen, `unveiled the ${q.quilt} at ${circle.name}`);
      seedRumor(`The ${q.quilt} is finished at ${circle.name}!`);
      return;
    }
  }

  // Routine: work emote, garment callout, pattern share, dye note.
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `sewed at ${circle.name}`);
  } else if (roll < 0.75) {
    const projects = projectsFor(name, record.kingdomId, nowMs);
    const garment = projects.length ? projects[0] : "a fine garment";
    citizen.forceChat?.(`Nearly done — ${garment} for little ${name}.`);
    journalize(citizen, `finished ${garment} at ${circle.name}`);
  } else {
    const line = pickOne(Math.random, SHARE_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `shared patterns at ${circle.name}`);
  }
}

module.exports = {
  tickSewfolk,
  commissionGarment,
  commissionFor,
  buyFabric,
  fabricFor,
  learnSewing,
  sewingFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  sewfolkTypeOf,
  circleFor,
  projectsFor,
  quiltFor,
  dyeForToday,
  garmentPool,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  sewfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isSewHour,
  dayNumber,
  chance,
  seededRng,
  SEWFOLK_TYPES,
  SEWFOLK_SEAMSTRESS,
  SEWFOLK_QUILTER,
  SEWFOLK_PATTERN,
  SEWFOLK_DYER,
  SEWING_CIRCLES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    commissions.clear();
    fabricBuys.clear();
    sewingLessons.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
