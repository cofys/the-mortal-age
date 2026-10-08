"use strict";

/**
 * CitizenStorytellers — keepers of tales, legends and oral history: elders,
 * travelers, grandparents and epic-performers who gather listeners and tell.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived storyteller types, per-day tales per gathering place derived
 *   from date + hash, legends that grow a new verse each day (real journaled
 *   events become legend material via a bounded journal scan, same pattern as
 *   the bards' ballad-of-the-week), and 7-day-TTL player ledgers for tale
 *   requests and contributed stories.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players, gathering
 * hours 10:00-22:00 server time): scripted storytelling emotes, tale opening
 * verses, legend-of-the-week fanfare as the crowd moment, story-request
 * offers, tale-sharing acknowledgments.
 *
 * Zero LLM: all lines from scripted pools; legends are assembled from
 * templates plus real journaled event descriptions; the journal feeds the
 * LLM mouth.
 *
 * ACTIVITY SYSTEM, not a profession: any commoner may be a storyteller — no
 * professional exclusion chain (see the chain-saturation warning in the
 * citizen-ai-builder skill). Distinct from CitizenBards (professional bards:
 * troupes, ballads, tips, commissions) and CitizenLibrarians (written
 * catalogs): this module owns ORAL tales and legends only. The
 * "epic-performer" type recites epics at gatherings; it is not a professional
 * bard and its identity is disjoint from the bards module's bardTypeOf.
 *
 * Wired into the director proximity tick right after the volunteers block.
 * Plain-node testable: CitizenStorytellers.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { isHobbyVisible } = require("./CitizenPrimaryHobby"); // Phase 2: visibility weighting

// === Tuning ===
const STORYTELLER_RADIUS = 14; // tiles — close enough to see/hear
const STORYTELLER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const STORYTELLER_CHANCE = 0.35; // per eligible citizen per proximity tick
const LEGEND_CHANCE = 0.08; // per gathering per day of a legend-growing moment
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const GATHER_START_HOUR = 10; // 10:00 server time
const GATHER_END_HOUR = 22; // 22:00 server time

// === Storyteller types ===
const STORYTELLER_ELDER = "elder";
const STORYTELLER_TRAVELER = "traveler";
const STORYTELLER_GRANDPARENT = "grandparent";
const STORYTELLER_EPIC = "epic-performer";
const STORYTELLER_TYPES = [
  STORYTELLER_ELDER,
  STORYTELLER_TRAVELER,
  STORYTELLER_GRANDPARENT,
  STORYTELLER_EPIC,
];
const STORYTELLER_WEIGHTS = {
  [STORYTELLER_ELDER]: 30,
  [STORYTELLER_TRAVELER]: 25,
  [STORYTELLER_GRANDPARENT]: 25,
  [STORYTELLER_EPIC]: 20,
};

// === Gathering places (kingdom-preferred) ===
const GATHERINGS = [
  { name: "the Varrock tavern corner", kingdom: "misthalin" },
  { name: "the Lumbridge village green", kingdom: "misthalin" },
  { name: "the Falador hearth circle", kingdom: "asgarnia" },
  { name: "the Taverley fire ring", kingdom: "asgarnia" },
  { name: "the Ardougne market steps", kingdom: "kandarin" },
  { name: "the Hemenster dock benches", kingdom: "kandarin" },
  { name: "the Keldagrim deep hearth", kingdom: "keldagrim" },
  { name: "the Dorgesh cave commons", kingdom: "keldagrim" },
  { name: "the Darkmeyer blood plaza", kingdom: "morytania" },
  { name: "the Al Kharid oasis shade", kingdom: "kharidian" },
];

// === Tale pools (opening verses — the LLM tier tells the full tale) ===
const HISTORY_TALES = [
  "The Founding of {kingdom}: how the first stones were laid and the first fires lit.",
  "The Siege of a Hundred Winters, when the granaries ran empty and the watch held the walls.",
  "How the Old Bridge was built stone by stone, and the name of the mason who fell into the river.",
  "The Year of Two Kings, when the crown changed hands and nobody would swear fealty.",
  "The Great Fire of the Lower Town, and the buckets that saved the granary.",
  "How the first road was cut through the wilderness, and what the surveyors found in the bog.",
];
const JOURNEY_TALES = [
  "The road to the White Wolf passes, where the snow hides wolves and the cairns hide coins.",
  "Crossing the Feldip jungle: leeches, parrots, and the parrot that repeated my last words.",
  "The ferry across the River Lum at flood — the boatman charged double and prayed the whole way.",
  "Three nights in the Wilderness fringe, where the campfire draws company you did not invite.",
  "The camel caravan to the desert gates, and the oasis that wasn't on any map.",
  "Sailing the storm season: how we tied the captain to the mast and let the helmsman steer blind.",
];
const FAMILY_TALES = [
  "My grandmother's stew recipe, and the one secret ingredient she took to the grave.",
  "How my father won my mother's hand: he carried a sheep across the ford in full armor.",
  "The winter my brother and I stole the mayor's goose — and the mayor who laughed.",
  "My grandfather's lucky hammer, which has fixed every roof in the village twice over.",
  "The lullaby my mother sang, the one with the verse about the fox and the moon.",
  "How our family came to this kingdom: one cart, two goats, and a stubborn goat.",
];
const EPICS = [
  "The Saga of the Nameless King, who ruled before the crowns were minted.",
  "How the Dragon of the Southern Fells was slain with a bent spear and a prayer.",
  "The Twelve Trials of the First Watch, from the drowned gate to the burning tower.",
  "The Ballad of the Sunken Fleet, and the bells that toll beneath the waves.",
  "The Fall of the Stone Giants, when the mountains walked and the plains shook.",
  "The Epic of the Last Lantern, which kept burning long after the city fell.",
];
const TALES_BY_TYPE = {
  [STORYTELLER_ELDER]: HISTORY_TALES,
  [STORYTELLER_TRAVELER]: JOURNEY_TALES,
  [STORYTELLER_GRANDPARENT]: FAMILY_TALES,
  [STORYTELLER_EPIC]: EPICS,
};

// === Scripted lines ===
const WORK_LINES = {
  [STORYTELLER_ELDER]: [
    "*settles into a chair by the fire*",
    "*raps a walking stick on the floor*",
    "Gather round, then — this one happened before your father was born.",
    "*smooths a white beard and begins*",
  ],
  [STORYTELLER_TRAVELER]: [
    "*unrolls a travel-stained map across a knee*",
    "*pats the dust from a cloak*",
    "You've never left the city, have you? Then listen.",
    "*leans forward, voice dropping*",
  ],
  [STORYTELLER_GRANDPARENT]: [
    "*chuckles, rocking back and forth*",
    "*taps a grandchild on the nose*",
    "Ah, you want a story? Sit. Sit.",
    "*wipes flour from an apron and begins*",
  ],
  [STORYTELLER_EPIC]: [
    "*rises to full height, arms spread*",
    "*claps twice for silence*",
    "Hearken! The old tales demand an audience!",
    "*drives a staff into the ground for emphasis*",
  ],
};

const REQUEST_LINES = [
  "Ask, and I shall tell — what kind of tale do you want?",
  "I know a hundred tales. Name your hunger and I will feed it.",
  "Histories, journeys, family lore, or an epic? Choose, friend.",
];

const LEGEND_LINES = [
  "They'll be telling this one for a hundred years: {legend}.",
  "Mark this day — the tale of {legend} grew a new verse today.",
  "The legend grows! Now they say: {legend}.",
];

const TALE_OF_DAY_LINES = [
  "Today's tale at {gathering}: {tale}",
  "*clears throat* Today's telling: {tale}",
];

const SHARE_LINES = [
  "A fine tale! I'll carry it with me — the kingdom will hear it.",
  "That's a keeper. I'll tell it at {gathering} tonight.",
  "Noted and remembered. Your story joins the others.",
];

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

// === Player ledgers (7-day TTL) ===
const requests = new Map(); // normName -> { tale, at }
const shared = new Map(); // normName -> { story, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const m of [requests, shared]) {
    for (const [k, v] of m) {
      if (nowMs - v.at > LEDGER_TTL_MS) m.delete(k);
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

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** Cheap rng from a seed (LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** True during gathering hours (10:00-22:00 server time). */
function isGatherHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= GATHER_START_HOUR && h < GATHER_END_HOUR;
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
// Storyteller identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * Weighted pick of a storyteller type from a 0..99 roll.
 */
function storytellerTypeFromRoll(roll) {
  let acc = 0;
  for (const t of STORYTELLER_TYPES) {
    acc += STORYTELLER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return STORYTELLER_ELDER;
}

/**
 * The storyteller type for a roster record, or null.
 * ACTIVITY SYSTEM: no professional exclusion chain — any commoner may be a
 * storyteller. (Distinct from the bards module: its bardTypeOf identifies
 * professional bards; this module's types are amateur tellers.)
 */
function storytellerTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    const roll = hashStr("storyteller:" + name) % 100;
    return storytellerTypeFromRoll(roll);
  } catch {
    return null;
  }
}

/** Kingdom-preferred gathering-place assignment, stable across restarts. */
function gatheringFor(record) {
  const kid = record?.kingdomId;
  const local = GATHERINGS.filter((g) => g.kingdom === kid);
  const pool = local.length ? local : GATHERINGS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("storygathering:" + name) % pool.length];
}

/**
 * Today's tale at a gathering for a storyteller (derived, zero storage).
 * { tale, type, gathering }
 */
function taleFor(username, kingdomId, dateMs) {
  const name = normalizeName(username) || "anon";
  const type = storytellerTypeOf({ username: name, kingdomId }) || STORYTELLER_ELDER;
  const day = dayNumber(dateMs);
  const pool = TALES_BY_TYPE[type];
  const rng = seededRng(hashStr("storytale:" + name + ":" + day));
  const tale = fill(pickOne(rng, pool), { kingdom: kingdomName(kingdomId) });
  return { tale, type, gathering: gatheringFor({ username: name, kingdomId }).name };
}

function kingdomName(kid) {
  const names = {
    misthalin: "Misthalin",
    asgarnia: "Asgarnia",
    kandarin: "Kandarin",
    keldagrim: "Keldagrim",
    morytania: "Morytania",
    kharidian: "the Kharidian",
  };
  return names[kid] ?? "the kingdom";
}

// --- Journal access (lazy require — CitizenJournal may not load in tests) ---
let _journalEvent = null;
function journalEvent() {
  if (_journalEvent !== null) return _journalEvent;
  try {
    _journalEvent = require("./CitizenJournal").getJournal() || false;
  } catch {
    _journalEvent = false;
  }
  return _journalEvent;
}

let _seedRumor = null;
function seedRumorFn() {
  if (_seedRumor !== null) return _seedRumor;
  try {
    _seedRumor = require("./CitizenRumors").seedRumor || false;
  } catch {
    _seedRumor = false;
  }
  return _seedRumor;
}

/** Best-effort journal write; never throws. */
function journalize(citizen, text) {
  try {
    const j = journalEvent();
    const name = citizen?.getUsername?.() ?? citizen?.username;
    if (j && name) j.addEntry?.(name, text);
  } catch { /* cosmetic */ }
}

/** Best-effort rumor seed; never throws. */
function seedRumor(text) {
  try {
    const fn = seedRumorFn();
    if (fn) fn(text);
  } catch { /* cosmetic */ }
}

/**
 * Scan recent journal entries across the roster for newsworthy words and
 * return a short event description for legend-growing, or null. Cheap:
 * bounded scan, caller gates to at most once per gathering per day.
 * Same keyword pattern as the bards' ballad-of-the-week.
 */
function legendEventFor() {
  const keywords = [
    ["wedding", "a wedding"],
    ["married", "a wedding"],
    ["festival", "the festival"],
    ["election", "the election"],
    ["crowned", "a crowning"],
    ["victory", "a great victory"],
    ["dragon", "the dragon-slaying"],
    ["tournament", "the tournament"],
    ["treaty", "the treaty"],
    ["funeral", "the farewell"],
    ["ship", "the great voyage"],
    ["storm", "the great storm"],
  ];
  try {
    const j = journalEvent();
    if (!j || !j.entries) return null;
    let scanned = 0;
    for (const record of j.entries.values()) {
      for (const ev of record?.events ?? []) {
        const text = String(ev?.text ?? "").toLowerCase();
        for (const [word, desc] of keywords) {
          if (text.includes(word)) return desc;
        }
        if (++scanned > 400) return null;
      }
    }
  } catch { /* best effort */ }
  return null;
}

/**
 * Today's growing legend at a gathering: { verse, event, gathering }.
 * Assembles a legend verse from the event description plus a scripted frame
 * (derived, zero storage). The storyteller then tells it aloud.
 */
function legendFor(gathering, dateMs) {
  const day = dayNumber(dateMs);
  const eventDesc = legendEventFor() || "an old deed half-forgotten";
  const rng = seededRng(hashStr("storylegend:" + gathering.name + ":" + day));
  const frame = pickOne(rng, [
    "the {n}th verse of the legend of {event}",
    "a new telling of {event}, kept alive at {gathering}",
    "the latest verse of the {gathering} legend: {event}",
  ]);
  const n = (hashStr("legendn:" + gathering.name) % 12) + 3;
  return {
    verse: fill(frame, { n, event: eventDesc, gathering: gathering.name }),
    event: eventDesc,
    gathering: gathering.name,
  };
}

/**
 * An oral retelling of a real tale from the librarians' catalogs (lazy
 * require with fallback) — keeps oral and written lore consistent.
 */
function oralTaleForToday(dateMs) {
  try {
    const librarians = require("./CitizenLibrarians");
    if (typeof librarians.catalogFor === "function") {
      const day = dayNumber(dateMs);
      const cat = librarians.catalogFor("tale-teller", null, day * 86400000);
      if (cat && (cat.titles?.length || cat.title)) {
        const title = cat.titles?.length ? cat.titles[0] : cat.title;
        return String(title);
      }
    }
  } catch { /* module absent */ }
  return "the old tales of the founding";
}

// ============================================================================
// Player requests and contributed stories (data tier, zero LLM).
// ============================================================================

/** Request a tale: recorded; the LLM tier tells it. */
function requestStory(playerName, kind, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const tale = String(kind || "any");
  requests.set(name, { tale, at: nowMs });
  return tale;
}

/** The active tale request for a player, or null. */
function requestFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = requests.get(name);
  return rec ? rec.tale : null;
}

/** Contribute a story: recorded; storytellers will retell it. */
function shareStory(playerName, story, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !story) return null;
  pruneLedgers(nowMs);
  shared.set(name, { story: String(story).slice(0, 280), at: nowMs });
  return shared.get(name).story;
}

/** The contributed story for a player, or null. */
function storyFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = shared.get(name);
  return rec ? rec.story : null;
}

/**
 * Recent legends (last few days' legend verses) — for the LLM tier to quote
 * what the storytellers have been telling lately. Derived, zero storage.
 */
function recentLegends(gathering, dateMs) {
  const out = [];
  for (let d = 0; d < 3; d++) {
    out.push(legendFor(gathering, dateMs - d * 86400000).verse);
  }
  return out;
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → storyteller? → materialized → gather
// hours → real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickStorytellers(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < STORYTELLER_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a storyteller (hash-derived, cheap)
        const type = storytellerTypeOf(record);
        if (!type) continue;

        // 2b. Visibility weight (Phase 2 distribution fix): the primary hobby
        // always fires visibly; other hobbies fire 1/3 as often.
        if (!isHobbyVisible(record.username, "storyteller")) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Gathering hours only
        if (!isGatherHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, STORYTELLER_RADIUS)) continue;

        // 6. Chance gate
        if (Math.random() >= STORYTELLER_CHANCE) continue;

        // 7. Do the thing (scripted, zero LLM)
        doStorytellerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-storytellers] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-storytellers] tick failed:", e?.message ?? e);
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

function doStorytellerWork(director, record, citizen, type, nowMs) {
  const gathering = gatheringFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Legend-grows moment: once per gathering per day, the crowd moment.
  const legendKey = "legend:" + gathering.name + ":" + day;
  const rng = seededRng(hashStr(legendKey));
  if (rng() < LEGEND_CHANCE && !lastFiredByCitizen.has(legendKey)) {
    lastFiredByCitizen.set(legendKey, nowMs);
    const legend = legendFor(gathering, nowMs);
    const line = fill(pickOne(Math.random, LEGEND_LINES), { legend: legend.verse });
    citizen.forceChat?.(line);
    journalize(citizen, `grew the legend at ${gathering.name}: ${legend.verse}`);
    seedRumor(`The storytellers at ${gathering.name} have grown a new verse: ${legend.verse}`);
    return;
  }

  // Routine: work emote, tale of the day, request offer.
  const roll = Math.random();
  if (roll < 0.45) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `settled in to tell tales at ${gathering.name}`);
  } else if (roll < 0.75) {
    const t = taleFor(name, record.kingdomId, nowMs);
    const line = fill(pickOne(Math.random, TALE_OF_DAY_LINES), {
      gathering: gathering.name,
      tale: t.tale,
    });
    citizen.forceChat?.(line);
    journalize(citizen, `told a ${type} tale at ${gathering.name}: ${t.tale}`);
  } else {
    const line = pickOne(Math.random, REQUEST_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `offered tales to listeners at ${gathering.name} (the oral version of ${oralTaleForToday(nowMs)})`);
  }
}

module.exports = {
  tickStorytellers,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  storytellerTypeOf,
  storytellerTypeFromRoll,
  gatheringFor,
  taleFor,
  legendFor,
  legendEventFor,
  oralTaleForToday,
  requestStory,
  requestFor,
  shareStory,
  storyFor,
  recentLegends,
  anyRealPlayerNear,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  dayNumber,
  seededRng,
  isGatherHour,
  isRealPlayer,
  withinTiles,
  STORYTELLER_TYPES,
  STORYTELLER_ELDER,
  STORYTELLER_TRAVELER,
  STORYTELLER_GRANDPARENT,
  STORYTELLER_EPIC,
  GATHERINGS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    requests.clear();
    shared.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
    _journalEvent = null;
    _seedRumor = null;
  },
};
