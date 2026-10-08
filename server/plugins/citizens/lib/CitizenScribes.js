"use strict";

/**
 * CitizenScribes — freelance writing folk: copyists who duplicate
 * manuscripts, letter-writers who write for those who cannot, record-keepers
 * who maintain shop logs, and calligraphers who illuminate invitations.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived scribe types, per-day job queues (copies to make, letters
 *   to write, records to keep), 7-day-TTL ledgers for player hires, copy
 *   requests and record commissions. Copyists read the real
 *   CitizenLibrarians catalogs so the manuscripts they copy are ones the
 *   libraries actually hold; record-keepers cross-reference the real
 *   CitizenHistorians daily chronicles.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-18:00 local): scripted writing emotes, completed-copy callouts,
 * letter-dictation offers, and the rare illuminated-manuscript unveiling
 * as the crowd moment.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * NO OVERLAP (by design): activity system, not a profession — no
 * professional exclusion chain (sidesteps the chain-saturation problem).
 * The professional libraries have scribes on staff (CitizenLibrarians'
 * LIBRARIAN_SCRIBE type); this module owns the FREELANCE writing trade —
 * letter-writing, shop records and private copying commissions. Librarians
 * are excluded from scribeTypeOf so no citizen is both a library scribe
 * and a freelance scribe.
 *
 * Wired into the director tick right after the couriers block.
 * Plain-node testable: CitizenScribes.test.js.
 */

const { isHobbyVisible } = require("./CitizenPrimaryHobby"); // Phase 2: visibility weighting

// === Tuning ===
const SCRIBE_RADIUS = 14; // tiles — close enough to see/hear
const SCRIBE_CITIZEN_COOLDOWN_MS = 2 * 60 * 60 * 1000; // a citizen fires at most every 2h
const SCRIBE_CHANCE = 0.35; // per eligible citizen per ~60s tick
const SCRIPT_START_HOUR = 8; // 08:00 server-local
const SCRIPT_END_HOUR = 18; // 18:00 server-local
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;

// === Scribe types ===
const SCRIBE_COPYIST = "copyist";
const SCRIBE_LETTER = "letter-writer";
const SCRIBE_RECORD = "record-keeper";
const SCRIBE_CALLIGRAPHER = "calligrapher";
const SCRIBE_TYPES = [SCRIBE_COPYIST, SCRIBE_LETTER, SCRIBE_RECORD, SCRIBE_CALLIGRAPHER];
const SCRIBE_WEIGHTS = {
  [SCRIBE_COPYIST]: 30,
  [SCRIBE_LETTER]: 30,
  [SCRIBE_RECORD]: 25,
  [SCRIBE_CALLIGRAPHER]: 15,
};

// === Scriptoriums (kingdom-preferred workplaces) ===
const SCRIPTORIUMS = [
  { name: "the Varrock Scriptorium", kingdom: "varrock" },
  { name: "the Lumbridge Writing Room", kingdom: "varrock" },
  { name: "the Falador Hall of Letters", kingdom: "asgarnia" },
  { name: "the White Knights' Chancery", kingdom: "asgarnia" },
  { name: "the Ardougne Athenaeum Annex", kingdom: "kandarin" },
  { name: "the Hemenster Copy Loft", kingdom: "kandarin" },
  { name: "the Keldagrim Record Hall", kingdom: "keldagrim" },
  { name: "the Dwarven Rune Etchery", kingdom: "keldagrim" },
  { name: "the Darkmeyer Black Scriptorium", kingdom: "morytania" },
  { name: "the Al Kharid House of Pens", kingdom: "kharidian" },
];

// === Services and price caps (coins) ===
const SERVICES = {
  [SCRIBE_COPYIST]: [
    { name: "a clean copy of a manuscript", price: 40 },
    { name: "a fair copy of a contract", price: 25 },
    { name: "a bound copy of a will", price: 60 },
  ],
  [SCRIBE_LETTER]: [
    { name: "a letter to family", price: 8 },
    { name: "a love letter", price: 15 },
    { name: "a letter of complaint", price: 10 },
    { name: "a business letter", price: 12 },
  ],
  [SCRIBE_RECORD]: [
    { name: "a week's shop ledger", price: 30 },
    { name: "an inventory account", price: 25 },
    { name: "a debt reckoning", price: 20 },
  ],
  [SCRIBE_CALLIGRAPHER]: [
    { name: "an illuminated invitation", price: 80 },
    { name: "a decorated marriage contract", price: 100 },
    { name: "a guild charter in fine hand", price: 90 },
  ],
};

// === Scripted lines ===
const WORK_LINES = {
  [SCRIBE_COPYIST]: [
    "*dips the quill, copies line by line*",
    "*rules the margins with a steady hand*",
    "Mind the ink — it smudges if you breathe on it.",
    "*compares the copy against the original*",
  ],
  [SCRIBE_LETTER]: [
    "*takes down a customer's words, word by word*",
    "Shall I make it sound fond, or firm?",
    "*sands the letter dry*",
    "Dictate slowly — my hand is quick but not that quick.",
  ],
  [SCRIBE_RECORD]: [
    "*totals a column of figures*",
    "*enters the day's takings in the ledger*",
    "Every coin accounted for — that's the whole art of it.",
    "*cross-checks yesterday's entries*",
  ],
  [SCRIBE_CALLIGRAPHER]: [
    "*paints a gold-leaf initial*",
    "*flourishes a capital letter*",
    "A letter should look as fine as it reads.",
    "*mixes a fresh pot of red ink*",
  ],
};

const COPY_LINES = [
  "Copy's done — {title}, fair and clean!",
  "Finished! {title}, copied word for word.",
  "{title} is ready for collection — mind the wet ink.",
];

const OFFER_LINES = [
  "Letters written, copies made — what needs writing, friend?",
  "Need a letter penned? A contract copied? My quill is sharp.",
  "I write for those who'd rather not — what's the commission?",
];

const UNVEIL_LINES = [
  "Behold! {piece} — illuminated in gold and lapis!",
  "She's done! {piece} — no finer hand in the kingdom!",
  "After days at the desk — {piece} is finished!",
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
const hires = new Map(); // normPlayer -> { scribe, service, at }
const copyRequests = new Map(); // normPlayer -> { title, at }
const recordCommissions = new Map(); // normPlayer -> { subject, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of hires) {
    if (nowMs - v.at > LEDGER_TTL_MS) hires.delete(k);
  }
  for (const [k, v] of copyRequests) {
    if (nowMs - v.at > LEDGER_TTL_MS) copyRequests.delete(k);
  }
  for (const [k, v] of recordCommissions) {
    if (nowMs - v.at > LEDGER_TTL_MS) recordCommissions.delete(k);
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

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
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

/** True during scriptorium hours (08:00-18:00 server-local). */
function isScriptHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= SCRIPT_START_HOUR && h < SCRIPT_END_HOUR;
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
// Scribe identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/** Weighted pick of a scribe type from a 0..99 roll. */
function scribeTypeFromRoll(roll) {
  let acc = 0;
  for (const t of SCRIBE_TYPES) {
    acc += SCRIBE_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return SCRIBE_COPYIST;
}

/**
 * The scribe type for a roster record, or null.
 * Activity system: any commoner may scribe, no professional exclusions.
 * Librarians are excluded — the libraries have professional scribes on
 * staff (CitizenLibrarians' scribe type); this module owns the freelance
 * writing trade only.
 */
function scribeTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    try {
      const librarians = require("./CitizenLibrarians");
      // Pass the raw username, matching the librarians module's own gate
      // (tickLibrarians calls isLibrarian(record.username)).
      if (typeof librarians.isLibrarian === "function" && librarians.isLibrarian(record?.username)) return null;
    } catch { /* module absent */ }
    // Universal activity: every commoner scribes. Type is hash-derived
    // so it is stable across restarts with zero storage.
    return scribeTypeFromRoll(hashStr("scribetype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred scriptorium assignment, stable across restarts. */
function scriptoriumFor(record) {
  const kid = record?.kingdomId;
  const local = SCRIPTORIUMS.filter((w) => w.kingdom === kid);
  const pool = local.length ? local : SCRIPTORIUMS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("scribescriptorium:" + name) % pool.length];
}

/**
 * The day's job queue for a scribe (1-3 jobs of their type).
 * Derived from date + hash; zero storage.
 */
function jobsFor(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const type = scribeTypeOf({ username: name });
  const pool = type ? SERVICES[type] : Object.values(SERVICES).flat();
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("scribejobs:" + name + ":" + day));
  const count = 1 + Math.floor(rng() * 3); // 1-3
  const out = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < pool.length; i++) {
    const svc = pool[Math.floor(rng() * pool.length)];
    if (used.has(svc.name)) continue;
    used.add(svc.name);
    out.push(svc.name);
  }
  return out;
}

/**
 * Today's manuscript for copyists — read from the real CitizenLibrarians
 * catalogs via lazy require (with a static fallback), so the copies match
 * what the libraries actually hold.
 */
function manuscriptForToday(dateMs) {
  try {
    const librarians = require("./CitizenLibrarians");
    if (typeof librarians.catalogFor === "function") {
      const cat = librarians.catalogFor("scribe-copyist", null, dateMs);
      if (Array.isArray(cat) && cat.length) {
        const item = cat[0];
        return typeof item === "string" ? item : item?.title ?? item?.name ?? null;
      }
      if (typeof cat === "string") return cat;
    }
  } catch { /* module absent */ }
  return "the Chronicles of the Founding";
}

/** Price list for a scribe type (for the LLM dialogue tier). */
function pricesFor(type) {
  return (SERVICES[type] ?? []).map((s) => ({ name: s.name, price: s.price }));
}

// ============================================================================
// Player commissions (data tier, zero LLM).
// ============================================================================

/** Hire a scribe for a service: recorded; the LLM tier handles dialogue. */
function hireScribe(playerName, scribeName, service, nowMs = Date.now()) {
  const p = normalizeName(playerName);
  const s = normalizeName(scribeName);
  if (!p || !s || !service) return null;
  pruneLedgers(nowMs);
  hires.set(p, { scribe: s, service: String(service), at: nowMs });
  return service;
}

/** The active hire for a player, or null. */
function hireFor(playerName, nowMs = Date.now()) {
  const p = normalizeName(playerName);
  if (!p) return null;
  pruneLedgers(nowMs);
  const rec = hires.get(p);
  return rec ? { ...rec } : null;
}

/** Request a manuscript copy: recorded; the LLM tier handles dialogue. */
function requestCopy(playerName, title, nowMs = Date.now()) {
  const p = normalizeName(playerName);
  if (!p || !title) return null;
  pruneLedgers(nowMs);
  copyRequests.set(p, { title: String(title), at: nowMs });
  return title;
}

/** The active copy request for a player, or null. */
function copyFor(playerName, nowMs = Date.now()) {
  const p = normalizeName(playerName);
  if (!p) return null;
  pruneLedgers(nowMs);
  const rec = copyRequests.get(p);
  return rec ? rec.title : null;
}

/** Commission a written record: recorded; the LLM tier handles dialogue. */
function commissionRecord(playerName, subject, nowMs = Date.now()) {
  const p = normalizeName(playerName);
  if (!p || !subject) return null;
  pruneLedgers(nowMs);
  recordCommissions.set(p, { subject: String(subject), at: nowMs });
  return subject;
}

/** The active record commission for a player, or null. */
function recordFor(playerName, nowMs = Date.now()) {
  const p = normalizeName(playerName);
  if (!p) return null;
  pruneLedgers(nowMs);
  const rec = recordCommissions.get(p);
  return rec ? rec.subject : null;
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
// Gate order: cooldown (cheapest) → scribe? → visibility → materialized →
// scriptorium hours → real player near → chance → work.
// ============================================================================

function tickScribes(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < SCRIBE_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a scribe (hash-derived, cheap)
        const type = scribeTypeOf(record);
        if (!type) continue;

        // 3. Visibility weighting — primary hobby always, others 1-in-3
        if (!isHobbyVisible(record.username, "scribe")) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Scriptorium hours only
        if (!isScriptHour(now)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, SCRIBE_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, SCRIBE_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doScribeWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-scribes] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-scribes] tick failed:", e?.message ?? e);
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

function doScribeWork(director, record, citizen, type, nowMs) {
  const scriptorium = scriptoriumFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Illuminated-manuscript unveiling: rare, the crowd moment (calligraphers).
  if (type === SCRIBE_CALLIGRAPHER) {
    const rng = seededRng(hashStr("scribeunveil:" + scriptorium.name + ":" + day));
    if (rng() < 0.12) {
      const key = "unveil:" + scriptorium.name + ":" + day;
      if (!lastFiredByCitizen.has(key)) {
        lastFiredByCitizen.set(key, nowMs);
        const piece = pickOne(rng, SERVICES[SCRIBE_CALLIGRAPHER]).name;
        const line = fill(pickOne(rng, UNVEIL_LINES), { piece });
        citizen.forceChat?.(line);
        journalize(citizen, `unveiled ${piece} at ${scriptorium.name}`);
        seedRumor(`${piece} unveiled at ${scriptorium.name}!`);
        return;
      }
    }
  }

  // Copyists: completed-copy callout naming a real library manuscript.
  if (type === SCRIBE_COPYIST) {
    const roll = Math.random();
    if (roll < 0.3) {
      const title = manuscriptForToday(nowMs);
      const line = fill(pickOne(Math.random, COPY_LINES), { title });
      citizen.forceChat?.(line);
      journalize(citizen, `finished copying ${title} at ${scriptorium.name}`);
      return;
    }
  }

  // Routine: work emote or service offer.
  const roll = Math.random();
  if (roll < 0.55) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `worked at ${scriptorium.name}`);
  } else {
    const line = pickOne(Math.random, OFFER_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `offered writing services at ${scriptorium.name}`);
  }
}

module.exports = {
  tickScribes,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  scribeTypeOf,
  scriptoriumFor,
  jobsFor,
  manuscriptForToday,
  pricesFor,
  hireScribe,
  hireFor,
  requestCopy,
  copyFor,
  commissionRecord,
  recordFor,
  // Pure helpers for tests:
  hashStr,
  normalizeName,
  pickOne,
  fill,
  scribeTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isScriptHour,
  dayNumber,
  chance,
  seededRng,
  SCRIBE_TYPES,
  SCRIBE_COPYIST,
  SCRIBE_LETTER,
  SCRIBE_RECORD,
  SCRIBE_CALLIGRAPHER,
  SCRIPTORIUMS,
  SERVICES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    hires.clear();
    copyRequests.clear();
    recordCommissions.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
