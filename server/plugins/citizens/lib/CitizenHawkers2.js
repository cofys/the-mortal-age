"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenHawkers2 — the hawkerfolk: amateur street hawkers and cryers who
 * walk the pitches crying their goods and drawing crowds. Fish-hawkers with
 * barrows of sardines, produce-hawkers with turnips and apples, trinket-hawkers
 * with ribbons and charms, flower-hawkers with fresh-cut bunches. Commoners
 * who live off the street economy of CRYING goods — the loudest amateur
 * sales layer in the city, under the professional market-stall merchants.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived hawker types (~35% nominal share, post-exclusion),
 *   per-day pitch spots and goods baskets, per-kingdom-per-day hoarse-crier /
 *   heckled-pitch set-pieces (journaled + rumor-seeded), and a once-per-pitch-
 *   per-day crowd-gathering moment. The market's real day wares are cross-read
 *   from CitizenMarketStalls so hawker small talk names what the stalls are
 *   actually selling. Claimed professional stall merchants (role "merchant")
 *   are excluded via the role gate ordered before the share roll.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 07:00-19:00 local): scripted hawking cries, the hoarse croak, heckled
 * pitches, the crowd gathering round a pitch. Actual haggling and purchases
 * are LLM tier — this module only tracks state, timers and the visible
 * street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the timefolk block.
 * Plain-node testable: CitizenHawkers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenMarketStalls + the stall merchants (role "merchant") own the
 *     PROFESSIONAL goods trade (stall pitches, day wares, shop trade,
 *     haggling, restock) — the claimed merchants are excluded via the role
 *     gate. Hawkerfolk own no stall and run no shop; they cry from a basket.
 *   - CitizenHawker's line pools serve the stall merchants; hawkers2 never
 *     claim the master hawker pools.
 *   - CitizenMessengers own PROCLAMATIONS of news (heralds crying decrees,
 *     event announcements, weather warnings) — hawkers cry GOODS only,
 *     never news or decrees.
 *   - CitizenBards/street performers own entertainment — a hawker crowd is
 *     commerce (buyers gathering), never a show.
 *   - CitizenWatchmen/CitizenGuards own the watch — hawkers cry and sell,
 *     never patrol or stand guard.
 */

// === Tuning: all magic numbers here ===
const HAWKER_RADIUS = 14; // tiles — close enough to see/hear
const HAWKER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const HAWKER_CHANCE = 0.15; // per eligible citizen per tick
const HAWKER_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const CROWD_CHANCE = 0.08; // ~8% per pitch per day: a crowd gathers round
const HOARSE_CHANCE = 0.06; // ~6% per kingdom per day: the crier lost their voice
const HECKLED_CHANCE = 0.08; // ~8% per kingdom per day: the pitch gets heckled
const WORK_START_HOUR = 7; // 07:00 server local time (the morning cry starts)
const WORK_END_HOUR = 19; // 19:00 server local time

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProMarket = safeRequire("./CitizenMarketStalls");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Hawker types ===
const PRODUCE_HAWKER = "produce-hawker";
const FISH_HAWKER = "fish-hawker";
const TRINKET_HAWKER = "trinket-hawker";
const FLOWER_HAWKER = "flower-hawker";
const HAWKER_TYPES = [
  PRODUCE_HAWKER,
  FISH_HAWKER,
  TRINKET_HAWKER,
  FLOWER_HAWKER,
];
const HAWKER_WEIGHTS = {
  [PRODUCE_HAWKER]: 30,
  [FISH_HAWKER]: 30,
  [TRINKET_HAWKER]: 25,
  [FLOWER_HAWKER]: 15,
};

// === Street pitches — corners, squares, market mouths and wharf steps where
// hawkers stand with their baskets. Not stalls: no awning, no counter. ===
const PITCHES = [
  { name: "Varrock market square", kingdom: "misthalin" },
  { name: "Lumbridge bridge corner", kingdom: "misthalin" },
  { name: "Falador park corner", kingdom: "asgarnia" },
  { name: "Port Sarim quayside", kingdom: "asgarnia" },
  { name: "Ardougne market mouth", kingdom: "kandarin" },
  { name: "Catherby beach steps", kingdom: "kandarin" },
  { name: "Keldagrim trading tier", kingdom: "keldagrim" },
  { name: "Dorgeshuun stair corner", kingdom: "keldagrim" },
  { name: "Canifis town square", kingdom: "morytania" },
  { name: "Burgh de Rott gate path", kingdom: "morytania" },
  { name: "Al Kharid bazaar mouth", kingdom: "kharidian" },
  { name: "Pollnivneach square", kingdom: "kharidian" },
];

// === The goods baskets — what each hawker type cries. Plain street wares,
// deliberately coarse and cheap: nothing a stall merchant would stock. ===
const GOODS = {
  [PRODUCE_HAWKER]: [
    "fresh turnips",
    "green cabbages",
    "red apples",
    "white onions",
    "warm eggs",
    "stew-pots",
  ],
  [FISH_HAWKER]: [
    "sardines",
    "fresh shrimp",
    "river trout",
    "fat pike",
    "mussels",
    "cockles",
  ],
  [TRINKET_HAWKER]: [
    "ribbon bows",
    "wooden charms",
    "bone buttons",
    "carved whistles",
    "lucky stones",
    "brass trinkets",
  ],
  [FLOWER_HAWKER]: [
    "violets",
    "red roses",
    "lavender bundles",
    "moonflowers",
    "wild herbs",
    "daisies",
  ],
};

// === Line pools — all scripted, zero LLM. ===

// The cries: one pool per hawker type.
const HAWK_LINES = {
  [PRODUCE_HAWKER]: [
    "{goods}! Fresh from the field, friend!",
    "Get your {goods} — straight off the cart!",
    "Fresh {goods}, best at {pitch}!",
    "Turnips, apples, eggs! Who'll buy?",
    "Hungry? My {goods} won't wait — and neither will the crowd!",
  ],
  [FISH_HAWKER]: [
    "{goods}! Fresh off the boat!",
    "Fish! {goods}, still flapping!",
    "Sardines, shrimp, trout — who's hungry?",
    "Get your {goods}, caught this morning!",
    "{goods} at {pitch} — the gulls are already jealous!",
  ],
  [TRINKET_HAWKER]: [
    "{goods}! Charms and trinkets, pretty and cheap!",
    "Ribbons! Whistles! A lucky stone for your pocket!",
    "Trinkets, trinkets — {goods} for a coin!",
    "Fine {goods}, friend — a coin well spent!",
    "Come see the {goods} — every child at {pitch} wants one!",
  ],
  [FLOWER_HAWKER]: [
    "Flowers! {goods} for your sweetheart!",
    "{goods}, fresh-cut this morning!",
    "Roses and lavender — who'll take {goods}?",
    "Sweet {goods} — the finest scent at {pitch}!",
    "A bunch of {goods} for a coin — smell them, go on!",
  ],
};

// Hoarse set-piece: the crier lost their voice.
const HOARSE_LINES = [
  "(croak) ...{goods}... (cough) ...fresh... (croak)",
  "My voice is gone — you'll have to read the sign, friends.",
  "(hoarse whisper) {goods}... fresh {goods}... you'll have to take my word...",
];

// Heckled set-piece: the pitch turns sour and the crowd laughs.
const HECKLED_LINES = [
  "Oi! Your goods are rotten! — (the crowd laughs)",
  "My gran sells better wares than that!",
  "Cheap? I've seen cheaper in the gutter!",
  "(the crowd jeers) They say this hawker's goods went stale!",
  "Take your rubbish elsewhere! — (laughter from the crowd)",
];

// Crowd moment: once per pitch per day, buyers gather round.
const CROWD_LINES = [
  "Come one, come all — the crowd gathers round {pitch}!",
  "A crowd draws round the {goods} — elbow in, friend!",
  "Look at them gather — the crowd knows the finest pitch at {pitch} today!",
  "{goods} — get them while the crowd hasn't bought me out!",
];

// Market-bridge small talk — names the real market day wares, cross-read from
// CitizenMarketStalls so the hawkers' boasts stay consistent with the stalls.
const MARKET_LINES = [
  "The stalls are flush with {ware} today — but my {goods} are cheaper!",
  "Saw {ware} on the market stalls — aye, and I undercut them all!",
  "The market's selling {ware} dear — my {goods} won't break you!",
  "{ware} at the stalls, {goods} at my basket — your coin decides!",
];

// Today's task lines per type (for journals).
const DAILY_TASK_LINES = {
  [PRODUCE_HAWKER]: [
    "hawked {goods} at {place}",
    "cried produce through {place}",
    "worked the cart round {place}",
  ],
  [FISH_HAWKER]: [
    "hawked {goods} at {place}",
    "cried fish along {place}",
    "sold off the barrow at {place}",
  ],
  [TRINKET_HAWKER]: [
    "hawked {goods} at {place}",
    "cried trinkets through {place}",
    "tempted the children of {place}",
  ],
  [FLOWER_HAWKER]: [
    "hawked {goods} at {place}",
    "cried flowers through {place}",
    "sold fresh-cut bunches at {place}",
  ],
};

// === Cooldown state (monotonic Date.now() timestamps) ===
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

/** "IRON_SWORD" -> "iron sword". */
function prettyWare(s) {
  return String(s ?? "").toLowerCase().replace(/_/g, " ").trim();
}

/** Weighted pick of a hawker type from a 0..99 roll. */
function hawkerTypeFromRoll(roll) {
  let acc = 0;
  for (const t of HAWKER_TYPES) {
    acc += HAWKER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return PRODUCE_HAWKER;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during work hours (07:00-19:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
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
// Hawker identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The hawker type for a roster record, or null.
 * Excludes the claimed professional stall merchants (role "merchant", owned
 * by CitizenMarketStalls: they run real stalls, hawkers cry from baskets —
 * the same citizen must never be both). The role gate runs BEFORE the share
 * roll, so it holds regardless of the 35% draw. Note there is no separate
 * claimed-hawker type module: the master CitizenHawker is a pure line pool
 * for the stall merchants, not a citizen claim system.
 * Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function hawkerTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    const roll = hashStr(name + "|hawker") % 100;
    if (roll >= HAWKER_SHARE) return null;
    return hawkerTypeFromRoll(hashStr(name + "|hawker-type") % 100);
  } catch {
    return null;
  }
}

/** The day's street pitch for a hawker citizen: kingdom-preferred. */
function pitchFor(record, type, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid ? PITCHES.filter((s) => s.kingdom === kid) : [];
    const src = local.length ? local : PITCHES;
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|hawkerpitch:" + day));
    return pickOne(rng, src);
  } catch {
    return null;
  }
}

/** Today's goods basket for a hawker citizen: seeded per day, from the
 * type's wares — the same basket all day. */
function goodsFor(username, type, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const pool = GOODS[type] ?? GOODS[PRODUCE_HAWKER];
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|hawkergoods:" + day));
    return pickOne(rng, pool);
  } catch {
    return null;
  }
}

/** Today's task for a hawker citizen (1 task of the day, for journals). */
function taskForToday(username, type, dateMs) {
  const name = normalizeName(username) || "anon";
  const lines = DAILY_TASK_LINES[type] ?? DAILY_TASK_LINES[PRODUCE_HAWKER];
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|hawkertask:" + day));
  return pickOne(rng, lines);
}

// ============================================================================
// Daily set-pieces (seeded per kingdom per day / per pitch per day).
// ============================================================================

/** Hoarse crier: the kingdom's hawker lost their voice today (~6%). */
function hoarseFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("hawkerhoarse:" + kingdomId + ":" + day)), HOARSE_CHANCE);
}

/** Heckled pitch: the kingdom's crowd turns sour on a hawker (~8%). */
function heckledFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("hawkerheckled:" + kingdomId + ":" + day)), HECKLED_CHANCE);
}

/** Crowd moment: buyers gather round this pitch today (~8%/pitch/day). */
function crowdFor(pitch, dateMs) {
  if (!pitch) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("hawkercrowd:" + pitch.name + ":" + day)), CROWD_CHANCE);
}

// ============================================================================
// Real-data bridge — the market stalls, cross-read.
// ============================================================================

/**
 * Read-only bridge: what the professional market stalls are selling in this
 * kingdom today, drawn from the real CitizenMarketStalls day-wares pools
 * (seeded per stall; we read a stable per-kingdom representative draw), so
 * hawker small talk stays consistent with the actual market. Returns an
 * array of pretty ware names, or null. Never throws.
 */
function marketWaresFor(kingdomId, nowMs = Date.now()) {
  try {
    if (!ProMarket || typeof ProMarket.dailyWaresFor !== "function") return null;
    if (typeof ProMarket.dateKeyFor !== "function") return null;
    const kid = String(kingdomId ?? "");
    if (!kid) return null;
    const key = ProMarket.dateKeyFor(new Date(nowMs));
    const wares = ProMarket.dailyWaresFor("hawkerfolk:" + kid, "prime", key);
    if (!Array.isArray(wares) || wares.length === 0) return null;
    return wares.map(prettyWare).filter(Boolean);
  } catch {
    return null;
  }
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

function journalize(citizen, text) {
  try {
    if (Journal && typeof Journal.appendEntry === "function") {
      Journal.appendEntry(citizen, text);
    } else if (Journal && typeof Journal.addEntry === "function") {
      Journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(text) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor(text);
  } catch { /* rumors absent */ }
}

/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → hawker? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickHawker(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < HAWKER_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible hawker life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be a hawker (hash-derived, cheap; exclusions inside)
        const type = hawkerTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. Work hours only (market hours: the morning cry starts at 7)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, HAWKER_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, HAWKER_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doHawkerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-hawker] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: hoarse criers and heckled pitches (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-hawker] tick failed:", e?.message ?? e);
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

function doHawkerWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const day = dayNumber(nowMs);
  const spot = pitchFor(record, type, nowMs);
  const place = spot ? spot.name : "the town square";
  const goods = goodsFor(name, type, nowMs) ?? "wares";

  // Hoarse set-piece: the kingdom's crier lost their voice today.
  if (kid && hoarseFor(kid, nowMs)) {
    forceSay(citizen, fill(pickOne(Math.random, HOARSE_LINES), { goods }));
    journalize(citizen, `croaked hoarsely hawking ${goods} at ${place}`);
    return;
  }

  // Heckled set-piece: the crowd turns sour on the pitch.
  if (kid && heckledFor(kid, nowMs) && Math.random() < 0.5) {
    forceSay(citizen, fill(pickOne(Math.random, HECKLED_LINES), {}));
    journalize(citizen, `was heckled while hawking ${goods} at ${place}`);
    seedRumor(`A hawker was heckled at ${place} — the crowd laughed at the ${goods}.`);
    return;
  }

  // The crowd moment: once per pitch per day, buyers gather round.
  if (spot && crowdFor(spot, nowMs)) {
    const key = "hawkercrowd:" + spot.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, CROWD_LINES), { goods, pitch: place }));
      journalize(citizen, `drew a crowd hawking ${goods} at ${place}`);
      seedRumor(`A crowd gathered round a hawker at ${place}!`);
      return;
    }
  }

  const wares = kid ? marketWaresFor(kid, nowMs) : null;
  const lines = HAWK_LINES[type] ?? HAWK_LINES[PRODUCE_HAWKER];
  const roll = Math.random();
  if (roll < 0.6) {
    forceSay(citizen, fill(pickOne(Math.random, lines), { goods, pitch: place }));
    journalize(citizen, `${taskForToday(name, type, nowMs).replace("{place}", place).replace("{goods}", goods)} — cried the basket`);
  } else if (wares && wares.length) {
    const ware = pickOne(Math.random, wares);
    forceSay(citizen, fill(pickOne(Math.random, MARKET_LINES), { ware, goods }));
    journalize(citizen, `talked market wares while hawking ${goods} at ${place}`);
  } else {
    forceSay(citizen, fill(pickOne(Math.random, lines), { goods, pitch: place }));
    journalize(citizen, `hawked ${goods} at ${place}`);
  }
}

/** Once-per-day kingdom rhythms: hoarse criers and heckled pitches. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
  try {
    for (const kid of kingdoms) {
      if (hoarseFor(kid, nowMs)) {
        const key = "daily-hawkerhoarse:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const pitch = PITCHES.find((p) => p.kingdom === kid);
          const line = `The hawker crier in ${kid} lost their voice — today's cries at ${pitch ? pitch.name : kid} come out as a croak.`;
          journalize({ username: "the hawkerfolk" }, line);
          seedRumor(line);
        }
      }
      if (heckledFor(kid, nowMs)) {
        const key = "daily-hawkerheckled:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const pitch = PITCHES.find((p) => p.kingdom === kid);
          const line = `A hawker was heckled at ${pitch ? pitch.name : kid} — the crowd laughed the pitch off.`;
          journalize({ username: "the hawkerfolk" }, line);
          seedRumor(line);
        }
      }
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickHawker,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  hawkerTypeOf,
  pitchFor,
  goodsFor,
  taskForToday,
  hoarseFor,
  heckledFor,
  crowdFor,
  marketWaresFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  prettyWare,
  hawkerTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  HAWKER_TYPES,
  PRODUCE_HAWKER,
  FISH_HAWKER,
  TRINKET_HAWKER,
  FLOWER_HAWKER,
  PITCHES,
  GOODS,
  // Tuning (tests pin the documented behavior):
  HAWKER_RADIUS,
  HAWKER_CITIZEN_COOLDOWN_MS,
  HAWKER_CHANCE,
  HAWKER_SHARE,
  CROWD_CHANCE,
  HOARSE_CHANCE,
  HECKLED_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  HAWKER_TYPES_WEIGHTS: HAWKER_WEIGHTS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    lastPruneAt = 0;
  },
};
