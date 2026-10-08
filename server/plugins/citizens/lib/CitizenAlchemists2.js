"use strict";

/**
 * CitizenAlchemists2 — the village brewfolk: hedge-witches, community
 * potion-brewers, elixir-mixers and garden experimenters at community
 * stillrooms.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived brewfolk types, per-day brew lists (1-3 brews from date +
 *   hash), comic mishap events (~8%/stillroom/day), 7-day-TTL player ledgers
 *   for brew requests, potion buys and brewing lessons — exported for the
 *   LLM dialogue tier.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-20:00 server-local): scripted brewing emotes ("*stirs the pot and
 * the brew turns bright blue*"), elixir hawking with coin prices, lesson
 * offers, and mishap fanfare as the crowd moment ("*POOF* — green smoke!").
 *
 * No overlap (by design):
 * - CitizenAlchemists own the PROFESSIONAL side: potion-brewer, transmuter,
 *   scholar, apothecary, laboratories, the potion trade. Professional
 *   alchemists (CitizenAlchemists.alchemistTypeFor) are EXCLUDED here.
 * - CitizenHerbalists own the herb trade (gathering grounds, hawking).
 *   Professional herbalists are EXCLUDED here — brewfolk only buy or grow
 *   their own garden herbs, never gather or hawk.
 * - CitizenHealers2 remedy-brewers own HEALTH remedies (fever tea, wound
 *   salve). Brewfolk here NEVER brew health cures — their brews are
 *   alchemical fun: glow draughts, scent elixirs, dye tonics, festival
 *   fizz. Explicitly non-medical, documented so the two never collide.
 *
 * Zero LLM: scripted line pools; the journal feeds the LLM mouth.
 *
 * Activity system (no professional exclusion chain): any commoner may brew.
 * Deliberately NOT in HOBBY_KEYS: visibility is throttled via chance +
 * cooldown (the couriers precedent) instead of adding another hobby key.
 * Plain-node testable: CitizenAlchemists2.test.js.
 *
 * Wired into the director tick right after the smithfolk block.
 */

const { normalizeName } = require("./CitizenBonds");

// Top-level requires (perf lesson from the artisan fix): the exclusion
// modules are linear deps with no back-references to this module, so
// hoisting is cycle-safe. safeRequire preserves the "module absent"
// fallback the lazy pattern had.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const AlchemistsPro = safeRequire("./CitizenAlchemists");
const HerbalistsPro = safeRequire("./CitizenHerbalists");

// === Tuning ===
const BREW_RADIUS = 14; // tiles — close enough to see/hear
const BREW_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen brews this often
const BREW_CHANCE = 0.15; // per eligible citizen per tick (couriers-style narrowing)
const BREW_SHARE = 40; // ~40% nominal share of commoners
const BREW_START_HOUR = 8; // 08:00 server-local
const BREW_END_HOUR = 20; // 20:00 server-local
const MISHAP_CHANCE = 0.08; // per stillroom per day: a comic mishap
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;

// === Brewfolk types ===
const BREWFOLK_HEDGEWITCH = "hedge-witch";
const BREWFOLK_BREWER = "village-brewer";
const BREWFOLK_MIXER = "elixir-mixer";
const BREWFOLK_EXPERIMENTER = "garden-experimenter";
const BREWFOLK_TYPES = [
  BREWFOLK_HEDGEWITCH,
  BREWFOLK_BREWER,
  BREWFOLK_MIXER,
  BREWFOLK_EXPERIMENTER,
];
const BREWFOLK_WEIGHTS = {
  [BREWFOLK_HEDGEWITCH]: 30,
  [BREWFOLK_BREWER]: 30,
  [BREWFOLK_MIXER]: 25,
  [BREWFOLK_EXPERIMENTER]: 15,
};

// === Community stillrooms (kingdom-preferred) ===
const COMMUNITY_STILLROOMS = [
  { name: "Widow Pimm's stillroom", kingdom: "misthalin" },
  { name: "the Lumbridge hedge still", kingdom: "misthalin" },
  { name: "the Falador community still", kingdom: "asgarnia" },
  { name: "the White Knights' brew shed", kingdom: "asgarnia" },
  { name: "the Ardougne market still", kingdom: "kandarin" },
  { name: "the Hemenster garden retort", kingdom: "kandarin" },
  { name: "the Keldagrim communal cauldron", kingdom: "keldagrim" },
  { name: "the Dorgesh kitchen still", kingdom: "keldagrim" },
  { name: "the Darkmeyer midnight still", kingdom: "morytania" },
  { name: "the Al Kharid courtyard alembic", kingdom: "kharidian" },
];

// === Community brews: alchemical fun, NEVER health cures ===
// (Health remedies belong to CitizenHealers2 remedy-brewers.)
const COMMUNITY_BREWS = [
  "a glow draught (lantern-bright)",
  "a rosewater scent elixir",
  "a color-shift dye tonic",
  "a festival fizz bottle",
  "a bubble-blowing potion",
  "a warm-hands winter draught",
  "a lemon-sparkle cordial",
  "a starlight shimmer tincture",
  "a honey-ginger fizz",
  "a mint-cool mouthwash",
  "a sunset-orange tint",
  "a soft-glow nightlight vial",
];

// === Garden herbs the brewfolk grow themselves (static fallback; the real
// CitizenHerbalists tables supply names when available) ===
const GARDEN_HERBS = [
  "garden mint",
  "backyard sage",
  "window-box thyme",
  "allotment chamomile",
  "hedgerow lavender",
  "kitchen-garden rosemary",
];

// === Scripted lines ===
const BREW_LINES = {
  [BREWFOLK_HEDGEWITCH]: [
    "*stirs the cottage pot, muttering old rhymes*",
    "*ties a bundle of dried herbs with twine*",
    "Come back at moonrise — the batch needs the night air.",
    "*pours the brew through muslin into a crock*",
  ],
  [BREWFOLK_BREWER]: [
    "*stirs the community cauldron, watching the colour turn*",
    "*skims the foam off the top — nearly ready*",
    "One more stir and she'll be bottled by noon.",
    "*labels the bottles with a charcoal stub*",
  ],
  [BREWFOLK_MIXER]: [
    "*blends two vials and watches them swirl*",
    "*measures drops from a tiny pipette*",
    "Half mint, half honey — the festival crowd loves this one.",
    "*seals the cork with a dab of wax*",
  ],
  [BREWFOLK_EXPERIMENTER]: [
    "*scribbles in a battered notebook*",
    "*adds a pinch of something purple — probably fine*",
    "If this works, it'll glow. If not, it'll smoke.",
    "*adjusts the flame under the retort*",
  ],
};

const HAWK_LINES = [
  "{brew} — brewed this morning, {price} coins!",
  "Fresh from the stillroom! {brew}, only {price} coins!",
  "{brew} — the festival batch. {price} coins, worth every one!",
];

const MISHAP_LINES = [
  "*POOF* — purple smoke everywhere! Stand back!*",
  "*the retort just spat green flames!*",
  "*cough* — open a window, that batch went wrong!*",
  "*a foul smell rolls out of the stillroom — hold your nose!*",
];

const LESSON_LINES = [
  "Want to learn brewing? Mind the stirring arm and you'll be fine.",
  "I teach the basics — pots, herbs, patience. Ask me sometime.",
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
const brewLedger = new Map(); // normName -> { brew, at }
const buyLedger = new Map(); // normName -> { brew, price, at }
const lessonLedger = new Map(); // normName -> { at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const map of [brewLedger, buyLedger, lessonLedger]) {
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

/** Weighted pick of a brewfolk type from a 0..99 roll. */
function brewfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of BREWFOLK_TYPES) {
    acc += BREWFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return BREWFOLK_HEDGEWITCH;
}

/** Materialized citizen bot for a roster record, or null when offline. */
function materializedBot(director, record) {
  try {
    if (!director?.isOnline?.(record)) return null;
    return director.getBot?.(record) ?? null;
  } catch {
    return null;
  }
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

/** True during stillroom hours (08:00-20:00 server-local). */
function isBrewHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= BREW_START_HOUR && h < BREW_END_HOUR;
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
// Brewfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The brewfolk type for a roster record, or null.
 * Excludes professional alchemists (the trade owns potions, transmutation,
 * laboratories) and professional herbalists (the trade owns gathering and
 * hawking). Uses the name-first salt pattern to avoid the FNV-1a
 * prefix-correlation bug (see the CitizenActors fix).
 */
function brewfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: professional alchemists own the potion trade.
    try {
      if (AlchemistsPro && typeof AlchemistsPro.alchemistTypeFor === "function" && AlchemistsPro.alchemistTypeFor(name)) return null;
    } catch { /* module absent */ }
    // Professional herbalists own the herb trade.
    try {
      if (HerbalistsPro && typeof HerbalistsPro.isHerbalist === "function" && HerbalistsPro.isHerbalist(record)) return null;
    } catch { /* module absent */ }
    const roll = hashStr("alchfolk:" + name) % 100;
    if (roll >= BREW_SHARE) return null;
    return brewfolkTypeFromRoll(hashStr(name + "|alchfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred stillroom assignment, stable across restarts. */
function stillroomFor(record) {
  const kid = record?.kingdomId;
  const local = COMMUNITY_STILLROOMS.filter((s) => s.kingdom === kid);
  const pool = local.length ? local : COMMUNITY_STILLROOMS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("alchfolkstill:" + name) % pool.length];
}

/**
 * The day's brews for a brewfolk (1-3 from the community brew pool).
 * Derived from date + hash; zero storage.
 */
function brewsFor(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("alchfolkbrews:" + name + ":" + day));
  const count = 1 + Math.floor(rng() * 3); // 1-3
  const out = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < COMMUNITY_BREWS.length; i++) {
    const b = COMMUNITY_BREWS[Math.floor(rng() * COMMUNITY_BREWS.length)];
    if (used.has(b)) continue;
    used.add(b);
    out.push(b);
  }
  return out;
}

/**
 * A garden herb for today's batch — prefers the real CitizenHerbalists
 * tables (unwrapping the {name, rarity} objects), falls back to the static
 * garden list. Never gathers or hawks.
 */
function herbForToday(username, kingdomId, dateMs) {
  try {
    if (HerbalistsPro && typeof HerbalistsPro.herbOfTheDay === "function") {
      const herb = HerbalistsPro.herbOfTheDay(username, kingdomId, dateMs);
      if (herb) {
        const nm = typeof herb === "object" ? herb.name : String(herb);
        if (nm && nm !== "[object Object]") return nm;
      }
    }
  } catch { /* module absent */ }
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  return GARDEN_HERBS[hashStr("alchfolkherb:" + name + ":" + day) % GARDEN_HERBS.length];
}

/**
 * Today's comic mishap at a stillroom (~8%/day), or null.
 * Purely cosmetic — nobody is hurt.
 */
function mishapFor(stillroom, dateMs) {
  const sname = stillroom?.name;
  if (!sname) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("alchfolkmishap:" + sname + ":" + day));
  if (rng() >= MISHAP_CHANCE) return null;
  return pickOne(rng, MISHAP_LINES);
}

/** Sane coin price for a community brew (hedge-witch wares stay cheap). */
function priceFor(brew) {
  const h = hashStr("alchfolkprice:" + brew);
  return 15 + (h % 60); // 15-74 coins
}

// ============================================================================
// Player ledgers (data tier, zero LLM) — exported for the LLM dialogue tier.
// ============================================================================

/** Record that a player requested a brew. */
function requestBrew(playerName, brew, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !brew) return null;
  pruneLedgers(nowMs);
  brewLedger.set(name, { brew: String(brew), at: nowMs });
  return brew;
}

/** The brew a player last requested, or null. */
function brewForPlayer(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = brewLedger.get(name);
  return rec ? rec.brew : null;
}

/** Record that a player bought a potion. */
function buyPotion(playerName, brew, price, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !brew) return null;
  pruneLedgers(nowMs);
  buyLedger.set(name, { brew: String(brew), price: Number(price) || 0, at: nowMs });
  return brew;
}

/** The last potion a player bought, or null. */
function potionFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = buyLedger.get(name);
  return rec ? { brew: rec.brew, price: rec.price } : null;
}

/** Record that a player asked for a brewing lesson. */
function learnBrewing(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  lessonLedger.set(name, { at: nowMs });
  return true;
}

/** True when the player asked for a brewing lesson within TTL. */
function brewingLessonFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = lessonLedger.get(name);
  return rec ? true : null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

// Journal access (lazy require — CitizenJournal may not load in tests).
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

/** Journal a brewfolk event — best-effort, never breaks the tick. */
function journalize(citizenName, text) {
  try {
    // Canonical journal API (CitizenJournal.js:79): getJournal().log(name, kind, text).
    journal()?.log(citizenName, "work", text);
  } catch { /* journal absent */ }
}

/** Seed a stillroom-mishap rumor into the real rumor graph — best-effort. */
function seedBrewRumor(who, what, where) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") {
      // Canonical seedRumor shape: (rng, { kind, who, what, where }).
      // Without `what` the seed is silently dropped (CitizenRumors.js:102).
      rumors.seedRumor(Math.random, { kind: "brewfolk", who, what, where });
    }
  } catch { /* rumors absent */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → brewfolk? → materialized → brew
// hours → real player near → chance → work.
// ============================================================================

function tickBrewfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < BREW_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be village brewfolk (hash-derived, cheap)
        const type = brewfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. Stillroom hours only
        if (!isBrewHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, BREW_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, BREW_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doBrewfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-brewfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-brewfolk] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  void director;
  try {
    // Canonical real-player proximity: bot-local players from the engine
    // Player API (Player.ts:796), filtered for real players.
    const players = citizen?.getLocalPlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doBrewfolkWork(director, record, citizen, type, nowMs) {
  const stillroom = stillroomFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Comic mishap: once per stillroom per mishap day, the crowd moment.
  const mishap = mishapFor(stillroom, nowMs);
  if (mishap) {
    const key = "mishap:" + stillroom.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      citizen.forceChat?.(mishap);
      journalize(name, `had a stillroom mishap at ${stillroom.name} (nobody hurt)`);
      seedBrewRumor(name, `A stillroom mishap at ${stillroom.name} — green smoke everywhere!`, stillroom.name);
      return;
    }
  }

  // Routine: brew emote, hawking, lesson offer.
  const roll = Math.random();
  if (roll < 0.45) {
    const line = pickOne(Math.random, BREW_LINES[type]);
    citizen.forceChat?.(line);
    journalize(name, `brewed at ${stillroom.name}`);
  } else if (roll < 0.75) {
    const brews = brewsFor(name, nowMs);
    const brew = brews.length ? brews[0] : "a small vial of something fizzy";
    const line = fill(pickOne(Math.random, HAWK_LINES), {
      brew,
      price: priceFor(brew),
    });
    citizen.forceChat?.(line);
    journalize(name, `hawked ${brew} at ${stillroom.name}`);
  } else {
    const line = pickOne(Math.random, LESSON_LINES);
    citizen.forceChat?.(line);
    journalize(name, `offered brewing lessons at ${stillroom.name}`);
  }
}

module.exports = {
  tickBrewfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  brewfolkTypeOf,
  stillroomFor,
  brewsFor,
  herbForToday,
  mishapFor,
  priceFor,
  requestBrew,
  brewForPlayer,
  buyPotion,
  potionFor,
  learnBrewing,
  brewingLessonFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  brewfolkTypeFromRoll,
  seededRng,
  chance,
  dayNumber,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isBrewHour,
  BREWFOLK_TYPES,
  BREWFOLK_HEDGEWITCH,
  BREWFOLK_BREWER,
  BREWFOLK_MIXER,
  BREWFOLK_EXPERIMENTER,
  COMMUNITY_STILLROOMS,
  COMMUNITY_BREWS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    brewLedger.clear();
    buyLedger.clear();
    lessonLedger.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
