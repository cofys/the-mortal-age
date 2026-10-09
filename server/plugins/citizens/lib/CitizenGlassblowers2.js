"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenGlassblowers2 — the furnace-side glassfolk: bottle collectors
 * buying up empties for a copper, cullet sorters grading broken glass for
 * remelt, sand carriers hauling silica from the beaches, and bottle
 * washers cleaning returns for the taverns. Commoners who live off the
 * unglamorous side of the glass trade — the street economy the glasshouses
 * depend on but never talk about.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived glassfolk types, per-day bottle hauls and cullet bins,
 *   sand-source and tavern assignments, bottle-pickup request ledger with
 *   deterministic 1-3h completion, and sand-delay + tavern-smash set-pieces
 *   (~8%/day each, journaled + rumor-seeded). The professionals' headline
 *   glassware is cross-read from CitizenGlassblowers so glassfolk small
 *   talk stays consistent with what the real glasshouses are actually
 *   blowing.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted empty-bottle buying pitches, cullet-sorting
 * emotes, sand-carrier grunts, bottle-washer lines, ready-pickup callouts
 * that name the nearby player (interaction priority), and pro-glassware
 * small talk. Pickup dialogue itself is LLM tier — this module only tracks
 * state, timers and the visible street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the herbfolk block.
 * Plain-node testable: CitizenGlassblowers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenGlassblowers owns the PROFESSIONAL glass trade (glasshouses,
 *     vessel/window/ornament/furnace work, masterworks, great works,
 *     commissions, tips) — glassblowers are excluded via the real module's
 *     null path (glassblowerTypeOf).
 *   - CitizenAlchemists own glassware purchases and potion work — glassfolk
 *     never sell finished glassware, only sand, cullet and washed empties.
 *   - CitizenFarmers own crop growing; CitizenMiners own ore and stone —
 *     glassfolk haul sand only, never quarry or mine.
 *   - CitizenInnkeepers own the taverns — glassfolk wash and buy bottles,
 *     never serve drinks.
 */

// === Tuning: all magic numbers here ===
const GLASSFOLK_RADIUS = 14; // tiles — close enough to see/hear
const GLASSFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const GLASSFOLK_CHANCE = 0.15; // per eligible citizen per tick
const GLASSFOLK_SHARE = 45; // ~45% nominal share of commoners (post-exclusion)
const SAND_DELAY_CHANCE = 0.08; // ~8% per kingdom per day: sand barges late
const SMASH_CHANCE = 0.08; // ~8% per kingdom per day: a tavern drops a shelf
const WORK_START_HOUR = 6; // 06:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time
const PICKUP_TTL_MS = 24 * 3600 * 1000; // bottle pickups linger a day

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProGlass = safeRequire("./CitizenGlassblowers");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Glassfolk types ===
const BOTTLE_COLLECTOR = "bottle-collector";
const CULLET_SORTER = "cullet-sorter";
const SAND_CARRIER = "sand-carrier";
const BOTTLE_WASHER = "bottle-washer";
const GLASSFOLK_TYPES = [
  BOTTLE_COLLECTOR,
  CULLET_SORTER,
  SAND_CARRIER,
  BOTTLE_WASHER,
];
const GLASSFOLK_WEIGHTS = {
  [BOTTLE_COLLECTOR]: 35,
  [CULLET_SORTER]: 25,
  [SAND_CARRIER]: 20,
  [BOTTLE_WASHER]: 20,
};

// === Empty bottles the collectors buy up — tavern leavings, never finished
// glassware. The glasshouses' vessels and ornaments are the professionals'
// trade; glassfolk deal in what gets thrown away. ===
const EMPTY_BOTTLES = [
  "empty green wine bottles",
  "empty rum bottles",
  "cracked beer jugs",
  "chipped spirit measures",
  "smashed tavern mugs",
  "emptied olive-oil flasks",
  "bottomless schnapps bottles",
  "corkless cider jugs",
];

// === Cullet colors the sorters grade for remelt ===
const CULLET_COLORS = [
  "clear cullet",
  "green cullet",
  "blue cullet",
  "brown cullet",
  "smoky cullet",
  "milk-white cullet",
];

// === Sands the carriers haul — by grain, never quarry stone. Mining the
// rock face is the miners' trade; carriers take what the sea and dunes
// hand them. ===
const SAND_KINDS = [
  "coarse dune sand",
  "fine beach sand",
  "pale shell sand",
  "silt-heavy river sand",
  "crushed quartz grit",
];

// === Where the carriers load: beaches, dunes and silt banks, kingdom
// preferred. Distinct from the miners' quarries. ===
const SAND_SOURCES = [
  { name: "the Draynor shallows", kingdom: "misthalin" },
  { name: "the Varrock city beach", kingdom: "misthalin" },
  { name: "the Port Sarim shallows", kingdom: "asgarnia" },
  { name: "the Mudskipper Point beach", kingdom: "asgarnia" },
  { name: "the Catherby sands", kingdom: "kandarin" },
  { name: "the Ardougne river silt banks", kingdom: "kandarin" },
  { name: "the Keldagrim quartz scree runs", kingdom: "keldagrim" },
  { name: "the Dorgesh dune vents", kingdom: "keldagrim" },
  { name: "the Mort Myre silt banks", kingdom: "morytania" },
  { name: "the Darkmeyer harbor shallows", kingdom: "morytania" },
  { name: "the Al Kharid dune flats", kingdom: "kharidian" },
  { name: "the Shantay dunes", kingdom: "kharidian" },
];

// === Taverns the washers serve: returns cleaned, never drinks poured. ===
const TAVERNS = [
  { name: "the Blue Moon Inn", kingdom: "misthalin" },
  { name: "the Jolly Boar Inn", kingdom: "misthalin" },
  { name: "the Rising Sun Inn", kingdom: "asgarnia" },
  { name: "the Dragon Inn", kingdom: "asgarnia" },
  { name: "the Flying Horse Inn", kingdom: "kandarin" },
  { name: "the Poison Arrow Inn", kingdom: "kandarin" },
  { name: "the King's Axe Inn", kingdom: "keldagrim" },
  { name: "the Dorgesh wine bar", kingdom: "keldagrim" },
  { name: "the Hair of the Dog", kingdom: "morytania" },
  { name: "the Canifis tavern", kingdom: "morytania" },
  { name: "the Shanty Pass tavern", kingdom: "kharidian" },
  { name: "the Oasis drink house", kingdom: "kharidian" },
];

// === Scripted lines ===
const COLLECT_LINES = [
  "Empties! Copper for your {bottles} — don't chuck them, sell them!",
  "Bottles bought! {bottles}, mugs, jugs — a copper each, no questions!",
  "Save me the walk — bring your empties! {bottles} pay a copper!",
  "{bottles}! The glasshouses melt them down and I pay for your trouble!",
];

const SORT_LINES = [
  "Clear with clear, green with green — the furnace hates surprises.",
  "Sorting {cullet} today. One wrong shard and the whole melt's ruined.",
  "Broken doesn't mean useless — {cullet} melts finer the second time!",
  "*picks shards into color bins* Mind your fingers, it's all teeth.",
];

const CARRY_LINES = [
  "Sand for the glasshouses! {sand} — a man's weight on my back!",
  "Hauling {sand} from {source} — the furnaces never stop eating!",
  "Eleven sacks of {sand} today. My shoulders remember every one.",
  "From {source} to the glasshouse — {sand}, the furnace's dinner!",
];

const WASH_LINES = [
  "Washing bottles for {tavern} — scrub, rinse, shine, repeat!",
  "The {tavern} drinks from clean glass or not at all — that's my doing!",
  "{tavern}'s returns, scrubbed and shining. Nobody likes a grimy bottle!",
  "Twenty bottles an hour at the {tavern} — hands like a fisherman's.",
];

const PRO_GLASS_LINES = [
  "The glasshouses are blowing {piece} today — I only carry the sand, mind!",
  "Leave the {piece} to the glassblowers. My trade is empties and cullet!",
  "You want {piece}? Ask at the glasshouse. You want your bottles gone? Ask me!",
];

const READY_PICKUP_LINES = [
  "{player}! Your {count} {bottles} — collected fresh, coppers counted!",
  "Back from the round, {player}! Here's the tally for your {bottles}!",
  "{player} — got your {bottles}. {count} of them, a copper each!",
];

const SAND_DELAY_LINES = [
  "Sand's late! The barges missed the tide — the glasshouse furnaces are idling!",
  "No sand from {source} today — the carriers are sitting on their sacks!",
  "Barges stuck at {source} — glassfolk are borrowing cullet to keep the melts going!",
];

const SMASH_LINES = [
  "Tavern smash! {tavern} dropped a whole shelf — the cullet bins are full!",
  "Heard it three streets away — {tavern} smashed a shelf! Scavengers, go!",
  "{tavern} lost a shelf of bottles — that's a week's sorting for us!",
];

const DAILY_TASK_LINES = {
  [BOTTLE_COLLECTOR]: [
    "rattling the bottle cart along the tavern row",
    "counting yesterday's empties",
    "oiling the cart wheels",
    "chalking the day's tavern round on the doorpost",
  ],
  [CULLET_SORTER]: [
    "sharpening the sorting tweezers",
    "weighing the cullet bins",
    "sweeping the sorting yard",
    "melting a test bead to check a color batch",
  ],
  [SAND_CARRIER]: [
    "patching the sand sacks",
    "oiling the shoulder pole",
    "resting a bad ankle",
    "chalking the sack tally on the wall",
  ],
  [BOTTLE_WASHER]: [
    "changing the wash water",
    "boiling the bottle brushes",
    "stacking washed bottles for the tavern run",
    "scrubbing the drying racks",
  ],
};

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

// === Ledgers (TTL'd) ===
const bottlePickups = new Map(); // normPlayerName -> { pickup }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of bottlePickups) {
    if (v.pickup.until <= nowMs) bottlePickups.delete(k);
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

/** Weighted pick of a glassfolk type from a 0..99 roll. */
function glassfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of GLASSFOLK_TYPES) {
    acc += GLASSFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return BOTTLE_COLLECTOR;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during work hours (06:00-20:00 server local time). */
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
// Glassfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The glassfolk type for a roster record, or null.
 * Excludes the professional glassblowers (the real CitizenGlassblowers
 * glassblowerTypeOf — it has a null path, so it is a valid eligibility
 * gate): the pros own the glasshouses and the fine trade, glassfolk own
 * the street economy of empties, cullet and sand.
 * Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function glassfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the professional glassblowers own the glasshouses.
    if (ProGlass && typeof ProGlass.glassblowerTypeOf === "function") {
      try {
        if (ProGlass.glassblowerTypeOf(record)) return null;
      } catch { /* pro check failed */ }
    }
    const roll = hashStr(name + "|glassfolk") % 100;
    if (roll >= GLASSFOLK_SHARE) return null;
    return glassfolkTypeFromRoll(hashStr(name + "|glassfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred glasshouse assignment via the professional trade. */
function workshopFor(record) {
  try {
    if (ProGlass && typeof ProGlass.workshopFor === "function") {
      const w = ProGlass.workshopFor(record);
      if (w?.name) return w;
    }
  } catch { /* fall through */ }
  return { name: "the glasshouse", kingdom: "unknown" };
}

/** Kingdom-preferred sand-source assignment, stable across restarts. */
function sandSourceFor(record) {
  const kid = record?.kingdomId ?? record?.kingdom;
  const local = SAND_SOURCES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : SAND_SOURCES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|sand-source") % pool.length];
}

/** Kingdom-preferred tavern assignment, stable across restarts. */
function tavernFor(record) {
  const kid = record?.kingdomId ?? record?.kingdom;
  const local = TAVERNS.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : TAVERNS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|bottle-tavern") % pool.length];
}

/** Today's bottle haul for a collector (stable per day). */
function bottlesForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|glass-bottles:" + day));
  return pickOne(rng, EMPTY_BOTTLES);
}

/** Today's cullet color for a sorter (stable per day). */
function culletForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|glass-cullet:" + day));
  return pickOne(rng, CULLET_COLORS);
}

/** Today's sand kind for a carrier (stable per day). */
function sandForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|glass-sand:" + day));
  return pickOne(rng, SAND_KINDS);
}

/** Today's task for a glassfolk citizen (1 task of the day). */
function taskForToday(username, type, dateMs) {
  const tasks = DAILY_TASK_LINES[type] ?? DAILY_TASK_LINES[BOTTLE_COLLECTOR];
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|glass-task:" + day));
  return pickOne(rng, tasks);
}

/**
 * A sand-shipment delay in a kingdom (~8%/day), or null: the barges missed
 * the tide and the glasshouse furnaces are idling. Journaled + rumor-seeded
 * by dailyRhythms.
 */
function sandDelayFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|sand-delay:" + day));
  if (rng() >= SAND_DELAY_CHANCE) return null;
  return true;
}

/**
 * A tavern drops a shelf of bottles in a kingdom (~8%/day), or null: the
 * cullet bins overflow and the sorters feast. Journaled + rumor-seeded by
 * dailyRhythms.
 */
function tavernSmashFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|tavern-smash:" + day));
  if (rng() >= SMASH_CHANCE) return null;
  return true;
}

// ============================================================================
// Real-data bridges — the professional glassblowers, cross-read.
// ============================================================================

/**
 * Read-only bridge: today's headline glassware from the professional
 * trade, so glassfolk small talk stays consistent with what the real
 * glasshouses are actually blowing. Never throws.
 */
function proHeadlinePiece(username, kingdom, nowMs = Date.now()) {
  try {
    if (!ProGlass || typeof ProGlass.glasswareForToday !== "function") return null;
    const w = ProGlass.glasswareForToday(nowMs);
    return typeof w === "string" ? w : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/**
 * A bottle collector takes a pickup request: collect a count of a specific
 * empty bottle type from a player, deterministic 1-3h completion.
 */
function requestPickup(playerName, collectorName, bottles, count, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const collector = String(collectorName ?? "").slice(0, 40);
  const b = String(bottles ?? "").slice(0, 60);
  const n = Math.max(1, Math.floor(count ?? 1));
  if (!name || !collector || !b) return null;
  pruneLedgers(nowMs);
  const day = dayNumber(nowMs);
  const durationMs = (1 + hashStr(name + "|pickup-dur:" + b + ":" + day) % 3) * 3600 * 1000;
  const rec = {
    pickup: {
      player: String(playerName),
      collector,
      bottles: b,
      count: n,
      askedAt: nowMs,
      durationMs,
      readyAt: nowMs + durationMs,
      until: nowMs + PICKUP_TTL_MS,
    },
  };
  bottlePickups.set(name, rec);
  return rec.pickup;
}

/** The player's outstanding bottle pickup, or null. */
function pickupFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = bottlePickups.get(name);
  if (!rec || rec.pickup.until <= nowMs) return null;
  return { ...rec.pickup };
}

/** True when the pickup is done (the collector is back from the round). */
function pickupReady(pickup, nowMs = Date.now()) {
  if (!pickup) return false;
  return nowMs >= pickup.readyAt;
}

/** The player collects their pickup payout (deletes the record). */
function completePickup(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return bottlePickups.delete(name);
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
// Gate order: cooldown (cheapest) → LOD brain gate → glassfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickGlassfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < GLASSFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible glassfolk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be a glassfolk (hash-derived, cheap; exclusions inside)
        const type = glassfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Work hours only
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, GLASSFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, GLASSFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doGlassfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-glassfolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: sand delays and tavern smashes (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-glassfolk] tick failed:", e?.message ?? e);
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

function doGlassfolkWork(director, record, citizen, type, nowMs) {
  const workshop = workshopFor(record);
  const name = normalizeName(record.username);

  // A nearby player's ready pickup takes priority for collectors.
  if (type === BOTTLE_COLLECTOR) {
    const ready = nearbyReadyPickup(director, citizen, nowMs);
    if (ready) {
      forceSay(citizen, fill(pickOne(Math.random, READY_PICKUP_LINES), {
        player: ready.name,
        bottles: ready.pickup.bottles,
        count: ready.pickup.count,
      }));
      journalize(citizen, `brought a bottle pickup back to a customer near ${workshop.name}`);
      return;
    }
    const roll = Math.random();
    if (roll < 0.45) {
      const bottles = bottlesForToday(name, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, COLLECT_LINES), { bottles }));
      journalize(citizen, `${taskForToday(name, type, nowMs)} near ${workshop.name}`);
    } else if (roll < 0.7) {
      const piece = proHeadlinePiece(name, record?.kingdom, nowMs);
      if (piece) {
        forceSay(citizen, fill(pickOne(Math.random, PRO_GLASS_LINES), { piece }));
        journalize(citizen, `talked trade with passers-by near ${workshop.name}`);
      } else {
        const bottles = bottlesForToday(name, nowMs);
        forceSay(citizen, fill(pickOne(Math.random, COLLECT_LINES), { bottles }));
        journalize(citizen, `${taskForToday(name, type, nowMs)} near ${workshop.name}`);
      }
    } else {
      const bottles = bottlesForToday(name, nowMs);
      forceSay(citizen, `Off on the tavern round — ${bottles} won't collect themselves!`);
      journalize(citizen, `${taskForToday(name, type, nowMs)} near ${workshop.name}`);
    }
    return;
  }

  if (type === CULLET_SORTER) {
    // A tavern smash in the kingdom takes priority while it's active.
    const kid = record?.kingdomId ?? record?.kingdom;
    if (kid && tavernSmashFor(kid, nowMs) && Math.random() < 0.4) {
      const tavern = tavernFor(record);
      forceSay(citizen, fill(pickOne(Math.random, SMASH_LINES), { tavern: tavern.name }));
      journalize(citizen, `worked a tavern smash at ${tavern.name}`);
      return;
    }
    const cullet = culletForToday(name, nowMs);
    forceSay(citizen, fill(pickOne(Math.random, SORT_LINES), { cullet }));
    journalize(citizen, `${taskForToday(name, type, nowMs)} near ${workshop.name}`);
    return;
  }

  if (type === SAND_CARRIER) {
    // A sand delay in the kingdom takes priority while it's active.
    const kid = record?.kingdomId ?? record?.kingdom;
    if (kid && sandDelayFor(kid, nowMs) && Math.random() < 0.4) {
      const source = sandSourceFor(record);
      forceSay(citizen, fill(pickOne(Math.random, SAND_DELAY_LINES), { source: source.name }));
      journalize(citizen, `sat idle on a sand delay at ${workshop.name}`);
      return;
    }
    const sand = sandForToday(name, nowMs);
    const source = sandSourceFor(record);
    forceSay(citizen, fill(pickOne(Math.random, CARRY_LINES), { sand, source: source.name }));
    journalize(citizen, `${taskForToday(name, type, nowMs)} near ${workshop.name}`);
    return;
  }

  // Bottle-washer: the tavern rounds.
  const tavern = tavernFor(record);
  forceSay(citizen, fill(pickOne(Math.random, WASH_LINES), { tavern: tavern.name }));
  journalize(citizen, `${taskForToday(name, type, nowMs)} at ${tavern.name}`);
}

/** A nearby real player whose bottle pickup is ready, if any. */
function nearbyReadyPickup(director, citizen, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, GLASSFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) return null;
      const pk = pickupFor(pname, nowMs);
      if (pk && pickupReady(pk, nowMs)) return { name: pname, pickup: pk };
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day kingdom rhythms: sand delays and tavern smashes. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
  try {
    for (const kid of kingdoms) {
      if (sandDelayFor(kid, nowMs)) {
        const key = "sand-delay:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const line = `Sand barges missed the tide in ${kid} — the glasshouse furnaces are idling and the carriers are sitting on their sacks.`;
          journalize({ username: "the glassfolk" }, line);
          seedRumor(line);
        }
      }
      if (tavernSmashFor(kid, nowMs)) {
        const key = "tavern-smash:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const pool = TAVERNS.filter((v) => v.kingdom === kid);
          const tavern = (pool.length ? pool[0] : TAVERNS[0]).name;
          const line = `A tavern in ${kid} dropped a whole shelf of bottles at ${tavern} — the cullet bins are overflowing.`;
          journalize({ username: "the glassfolk" }, line);
          seedRumor(line);
        }
      }
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickGlassfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  glassfolkTypeOf,
  workshopFor,
  sandSourceFor,
  tavernFor,
  bottlesForToday,
  culletForToday,
  sandForToday,
  taskForToday,
  sandDelayFor,
  tavernSmashFor,
  proHeadlinePiece,
  requestPickup,
  pickupFor,
  pickupReady,
  completePickup,
  nearbyReadyPickup,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  glassfolkTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  GLASSFOLK_TYPES,
  BOTTLE_COLLECTOR,
  CULLET_SORTER,
  SAND_CARRIER,
  BOTTLE_WASHER,
  SAND_SOURCES,
  TAVERNS,
  // Tuning (tests pin the documented behavior):
  GLASSFOLK_RADIUS,
  GLASSFOLK_CITIZEN_COOLDOWN_MS,
  GLASSFOLK_CHANCE,
  GLASSFOLK_SHARE,
  SAND_DELAY_CHANCE,
  SMASH_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  PICKUP_TTL_MS,
  EMPTY_BOTTLES,
  CULLET_COLORS,
  SAND_KINDS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    bottlePickups.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
