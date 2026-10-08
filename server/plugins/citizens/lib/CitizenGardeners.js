"use strict";

/**
 * CitizenGardeners — caretakers of the public gardens, parks and green
 * spaces of the kingdoms.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived gardener types, seasonal bloom calendars read from the real
 *   CitizenFarmers season table (lazy require with fallback), per-day garden
 *   tasks derived from date + hash, rare-bloom unveilings, and 7-day-TTL
 *   player ledgers for volunteer shifts, garden tours and produce donations.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players, garden
 * hours 07:00-19:00 server time): scripted tending emotes, bloom show-offs,
 * rare-bloom fanfare as the crowd moment, volunteer invitations, tour
 * offers, produce donation announcements.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * ACTIVITY SYSTEM, not a profession: any citizen may tend the public green
 * — no professional exclusion chain (see the chain-saturation warning in
 * the citizen-ai-builder skill). Distinct from CitizenHobbyists (whose
 * "gardener" hobby tends a private allotment) — this module owns the PUBLIC
 * gardens and parks. Distinct from CitizenFarmers (commercial food
 * production) — public plots are ornamental or charitable, never sold.
 *
 * Wired into the director proximity tick right after the pet owners block.
 * Plain-node testable: CitizenGardeners.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { isHobbyVisible } = require("./CitizenPrimaryHobby"); // Phase 2: visibility weighting

// === Tuning ===
const GARDEN_RADIUS = 14; // tiles — close enough to see/hear
const GARDEN_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const GARDEN_CHANCE = 0.35; // per eligible citizen per proximity tick
const RARE_BLOOM_CHANCE = 0.08; // per garden per day — the crowd moment
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const GARDEN_START_HOUR = 7; // 07:00 server time
const GARDEN_END_HOUR = 19; // 19:00 server time

// === Gardener types ===
const GARDENER_FLOWER = "flower-tender";
const GARDENER_VEGETABLE = "vegetable-grower";
const GARDENER_TREE = "tree-keeper";
const GARDENER_PARK = "park-keeper";
const GARDENER_TYPES = [
  GARDENER_FLOWER,
  GARDENER_VEGETABLE,
  GARDENER_TREE,
  GARDENER_PARK,
];
const GARDENER_WEIGHTS = {
  [GARDENER_FLOWER]: 30,
  [GARDENER_VEGETABLE]: 25,
  [GARDENER_TREE]: 25,
  [GARDENER_PARK]: 20,
};

// === Public gardens (kingdom-preferred) ===
const GARDENS = [
  { name: "the Varrock Palace Gardens", kingdom: "misthalin" },
  { name: "the Lumbridge Green", kingdom: "misthalin" },
  { name: "the Falador Park", kingdom: "asgarnia" },
  { name: "the White Knights' Rose Walk", kingdom: "asgarnia" },
  { name: "the Ardougne Market Planters", kingdom: "kandarin" },
  { name: "the Hemenster Herb Beds", kingdom: "kandarin" },
  { name: "the Keldagrim Stone Garden", kingdom: "keldagrim" },
  { name: "the Dorgesh Greenhalls", kingdom: "keldagrim" },
  { name: "the Darkmeyer Night Garden", kingdom: "morytania" },
  { name: "the Al Kharid Palm Court", kingdom: "kharidian" },
];

// === Seasonal blooms (keyed by the farmers' season calendar) ===
const BLOOMS = {
  spring: [
    "daffodils",
    "tulips",
    "cherry blossom",
    "bluebells",
    "primroses",
  ],
  summer: [
    "roses",
    "sunflowers",
    "lavender",
    "lilies",
    "wild poppies",
  ],
  autumn: [
    "chrysanthemums",
    "asters",
    "goldenrod",
    "heather",
    "autumn crocus",
  ],
  winter: [
    "hellebores",
    "winter jasmine",
    "snowdrops",
    "holly berries",
    "evergreen topiary",
  ],
};

const RARE_BLOOMS = {
  spring: [
    "a black tulip, blooming weeks early",
    "a cherry tree flowering twice in one year",
    "a bluebell field glowing at dusk",
  ],
  summer: [
    "a golden rose with a perfect spiral",
    "a sunflower taller than a troll",
    "a night-blooming jasmine in full perfume",
  ],
  autumn: [
    "a chrysanthemum with seven colors in one head",
    "an aster nobody can name",
    "a heather bed humming with ten thousand bees",
  ],
  winter: [
    "a hellebore blooming through the frost",
    "a snowdrop field under a full moon",
    "a topiary dragon, pruned by a master",
  ],
};

// === Garden tasks ===
const TASKS = {
  [GARDENER_FLOWER]: [
    "deadheading the roses",
    "planting marigold borders",
    "tying up the delphiniums",
    "mulching the flower beds",
    "edging the lawn",
  ],
  [GARDENER_VEGETABLE]: [
    "earthing up the potatoes",
    "picking beans for the poor",
    "watering the tomato rows",
    "sowing winter greens",
    "boxing up cabbages for the tavern",
  ],
  [GARDENER_TREE]: [
    "pruning the old oaks",
    "planting a sapling row",
    "checking the grafts",
    "coppicing the hazel",
    "banding the apple trunks",
  ],
  [GARDENER_PARK]: [
    "sweeping the paths",
    "oiling the bench hinges",
    "raking the gravel walks",
    "mending the park fence",
    "hanging the lantern garlands",
  ],
};

const WORK_LINES = {
  [GARDENER_FLOWER]: [
    "*sniffs a prize rose*",
    "*ties up a leaning delphinium*",
    "These beds have bloomed since my grandmother's day.",
    "*deadheads a spent bloom*",
  ],
  [GARDENER_VEGETABLE]: [
    "*lifts a basket of fresh beans*",
    "*earths up the potato rows*",
    "The poor get the first picking — the crown's own rule.",
    "*waters the tomato rows*",
  ],
  [GARDENER_TREE]: [
    "*runs a hand along the bark*",
    "*saws a dead branch cleanly*",
    "This oak was a sapling when the palace was built.",
    "*tamps the soil around a new sapling*",
  ],
  [GARDENER_PARK]: [
    "*sweeps the path in long strokes*",
    "*oils a creaking bench hinge*",
    "A tidy park keeps a tidy town, I always say.",
    "*rakes the gravel into neat lines*",
  ],
};

const SHOW_LINES = {
  [GARDENER_FLOWER]: [
    "Come and see — the {bloom} are at their peak!",
    "The flower beds have never looked finer.",
  ],
  [GARDENER_VEGETABLE]: [
    "Fresh {bloom} from the public plots — the poor eat first!",
    "The vegetable beds are overflowing this week.",
  ],
  [GARDENER_TREE]: [
    "The old trees are thriving — come walk the avenue.",
    "We planted twelve saplings this spring alone.",
  ],
  [GARDENER_PARK]: [
    "The park is at its best — lanterns up, benches oiled.",
    "Bring a picnic. The green is waiting.",
  ],
};

const RARE_LINES = [
  "You won't believe this — {bloom}!",
  "Come and look! {bloom}, right here in the public garden!",
  "Thirty years I've tended these beds — and today: {bloom}!",
];

const VOLUNTEER_LINES = [
  "Fancy lending a hand? The beds could use another trowel.",
  "Volunteers welcome — an hour in the garden does wonders.",
  "Come help with the planting, and I'll show you the old oak.",
];

const TOUR_LINES = [
  "I give garden tours at noon — the old trees, the rose walk, all of it.",
  "Want to see the gardens properly? Walk with me a while.",
];

const DONATION_LINES = [
    "The poor get the first picking — take a basket, friend.",
  "Fresh from the public plots, for anyone with an empty pot.",
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
const volunteers = new Map(); // normName -> { garden, at }
const tours = new Map(); // normName -> { garden, at }
const donations = new Map(); // normName -> { produce, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  const cutoff = nowMs - LEDGER_TTL_MS;
  for (const [k, v] of volunteers) if (v.at < cutoff) volunteers.delete(k);
  for (const [k, v] of tours) if (v.at < cutoff) tours.delete(k);
  for (const [k, v] of donations) if (v.at < cutoff) donations.delete(k);
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

/** True during garden hours (07:00-19:00 server time). */
function isGardenHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= GARDEN_START_HOUR && h < GARDEN_END_HOUR;
}

/** Weighted pick of a gardener type from a 0..99 roll. */
function gardenerTypeFromRoll(roll) {
  let acc = 0;
  for (const t of GARDENER_TYPES) {
    acc += GARDENER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return GARDENER_FLOWER;
}

// ============================================================================
// Gardener identity — hash-derived, stable across restarts, no storage.
// ACTIVITY SYSTEM: no professional exclusions. Any commoner may tend the
// public green.
// ============================================================================

/**
 * The gardener type for a roster record, or null for non-commoners.
 * No exclusion chain — public gardening is community care, not profession.
 */
function gardenerTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    return gardenerTypeFromRoll(hashStr("gardener:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred public garden for a record. */
function gardenFor(record) {
  const kid = record?.kingdomId;
  const local = GARDENS.filter((g) => g.kingdom === kid);
  const pool = local.length ? local : GARDENS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("gardengarden:" + name) % pool.length];
}

/**
 * The current season, read from the real CitizenFarmers season calendar via
 * lazy require (with a static fallback), so blooms match the farmers' world.
 */
function currentSeason(dateMs) {
  try {
    const farmers = require("./CitizenFarmers");
    if (typeof farmers.seasonFor === "function") {
      return farmers.seasonFor(new Date(dateMs).getUTCMonth());
    }
  } catch { /* module absent */ }
  const m = new Date(dateMs).getUTCMonth();
  if (m >= 2 && m <= 4) return "spring";
  if (m >= 5 && m <= 7) return "summer";
  if (m >= 8 && m <= 10) return "autumn";
  return "winter";
}

/** Today's bloom for a garden — derived from date + garden + season. */
function bloomFor(garden, dateMs) {
  const season = currentSeason(dateMs);
  const pool = BLOOMS[season] ?? BLOOMS.spring;
  const day = dayNumber(dateMs);
  return pool[hashStr("bloom:" + garden.name + ":" + day) % pool.length];
}

/** Today's rare bloom at a garden (~8%/day), or null. */
function rareBloomFor(garden, dateMs) {
  const season = currentSeason(dateMs);
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("rarebloom:" + garden.name + ":" + day));
  if (rng() >= RARE_BLOOM_CHANCE) return null;
  const pool = RARE_BLOOMS[season] ?? RARE_BLOOMS.spring;
  return pickOne(rng, pool);
}

/** Today's task for a gardener — derived from date + hash, zero storage. */
function taskFor(username, type, dateMs) {
  const name = normalizeName(username) || "anon";
  const pool = TASKS[type] ?? TASKS[GARDENER_FLOWER];
  const day = dayNumber(dateMs);
  return pool[hashStr("gardentask:" + name + ":" + day) % pool.length];
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Volunteer for a shift in the public garden: recorded for the LLM tier. */
function volunteerFor(playerName, gardenName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !gardenName) return null;
  pruneLedgers(nowMs);
  volunteers.set(name, { garden: String(gardenName), at: nowMs });
  return gardenName;
}

/** The garden a player volunteered at, or null. */
function volunteerShiftFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = volunteers.get(name);
  return rec ? rec.garden : null;
}

/** Request a guided garden tour: recorded for the LLM tier. */
function requestTour(playerName, gardenName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !gardenName) return null;
  pruneLedgers(nowMs);
  tours.set(name, { garden: String(gardenName), at: nowMs });
  return gardenName;
}

/** The garden a player requested a tour of, or null. */
function tourFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = tours.get(name);
  return rec ? rec.garden : null;
}

/** Record a produce donation to the poor from the public plots. */
function donateProduce(playerName, produce, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !produce) return null;
  pruneLedgers(nowMs);
  donations.set(name, { produce: String(produce), at: nowMs });
  return produce;
}

/** The produce a player donated, or null. */
function donationFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = donations.get(name);
  return rec ? rec.produce : null;
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
// Gate order: cooldown (cheapest) → gardener? → materialized → garden
// hours → real player near → chance → work.
// ============================================================================

function tickGardeners(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < GARDEN_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a gardener (hash-derived, cheap)
        const type = gardenerTypeOf(record);
        if (!type) continue;

        // 2b. Visibility weight (Phase 2 distribution fix): the primary hobby
        // always fires visibly; other hobbies fire 1/3 as often.
        if (!isHobbyVisible(record.username, "gardener")) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Garden hours only
        if (!isGardenHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, GARDEN_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, GARDEN_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doGardenerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-gardeners] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-gardeners] tick failed:", e?.message ?? e);
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

function doGardenerWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const garden = gardenFor(record);
  const day = dayNumber(nowMs);
  const bloom = bloomFor(garden, nowMs);

  // Rare bloom: the crowd moment, once per garden per day.
  const rare = rareBloomFor(garden, nowMs);
  if (rare) {
    const key = "rare:" + garden.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, RARE_LINES), { bloom: rare });
      citizen.forceChat?.(line);
      journalize(citizen, `unveiled a rare bloom at ${garden.name}: ${rare}`);
      seedRumor(`${rare} — right here at ${garden.name}!`);
      return;
    }
  }

  // Vegetable growers announce donations from the public plots.
  if (type === GARDENER_VEGETABLE && Math.random() < 0.25) {
    const line = pickOne(Math.random, DONATION_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `offered public-plot produce at ${garden.name}`);
    return;
  }

  // Volunteer invitations for lingering players.
  if (Math.random() < 0.2) {
    const line = pickOne(Math.random, VOLUNTEER_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `invited volunteers at ${garden.name}`);
    return;
  }

  // Garden tour offers (tree keepers and flower tenders).
  if ((type === GARDENER_TREE || type === GARDENER_FLOWER) && Math.random() < 0.15) {
    const line = pickOne(Math.random, TOUR_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `offered a garden tour at ${garden.name}`);
    return;
  }

  // Routine: task emote + bloom show-off.
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `tended ${garden.name}: ${taskFor(name, type, nowMs)}`);
  } else {
    const line = fill(pickOne(Math.random, SHOW_LINES[type]), { bloom });
    citizen.forceChat?.(line);
    journalize(citizen, `showed off the ${bloom} at ${garden.name}`);
  }
}

/**
 * Invite a lingering real player to volunteer in the garden.
 * Called from the tick path; the LLM dialogue tier handles the reply.
 */
function maybeInvitePlayer(record, citizen, type) {
  const garden = gardenFor(record);
  const line = fill(pickOne(Math.random, VOLUNTEER_LINES) + " ({garden})", {
    garden: garden.name,
  });
  try {
    citizen.forceChat?.(line);
  } catch { /* cosmetic */ }
  return line;
}

module.exports = {
  tickGardeners,
  volunteerFor,
  volunteerShiftFor,
  requestTour,
  tourFor,
  donateProduce,
  donationFor,
  rareBloomFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  gardenerTypeOf,
  gardenFor,
  currentSeason,
  bloomFor,
  taskFor,
  maybeInvitePlayer,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  gardenerTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isGardenHour,
  dayNumber,
  chance,
  seededRng,
  GARDENER_TYPES,
  GARDENER_FLOWER,
  GARDENER_VEGETABLE,
  GARDENER_TREE,
  GARDENER_PARK,
  GARDENS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    volunteers.clear();
    tours.clear();
    donations.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
