"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenFarmers2 — the farmfolk: farmhands, tenant farmers, seasonal
 * harvest crews, orchard keepers and market-garden sellers. Commoners who
 * live off the land without owning the farm: hired hands who hoe, dib and
 * cart; tenants working rented allotment plots; orchard keepers tending the
 * COMMUNITY orchards; market-garden sellers hawking allotment barrows;
 * seasonal harvest gangs who arrive for the hay and grain.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived farmfolk types, per-day task rotas, farmyard/allotment
 *   assignments, seasonal harvest set-pieces (harvest days, harvest feasts,
 *   orchard picking days), 7-day TTL ledgers for produce sales and harvest
 *   help signups. Produce lists read the REAL CitizenFarmers seasonal
 *   tables (wheat, apple, honey...) plus allotment extras, so sellers
 *   pitch what's genuinely in season.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted work emotes (hoeing, dibbing, pruning,
 * scything), market-garden pitches with real seasonal produce, harvest
 * crew callouts ("all hands to the sheaves!"), harvest-day and picking-day
 * fanfare.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the songfolk block. Plain-node
 * testable: CitizenFarmers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenFarmers owns the PROFESSIONAL trade (crop, livestock, orchard
 *     and apiary farmers with their own named holdings) — farmerTypeFor()
 *     citizens are excluded via the real module's null path.
 *   - CitizenMarketStalls owns the anchored market stalls — market-garden
 *     sellers hawk from ALLOTMENT BARROWS at the farmyard venues, never
 *     the market squares.
 *   - CitizenCooks/CitizenCooks2 own the kitchens; farmfolk only SUPPLY
 *     them (sellers name the community kitchens they supply; harvest
 *     feasts are announced, not cooked, here).
 *   - CitizenTradeCaravans own the trade roads; harvest crews stay in
 *     their home farmyard.
 */

// === Tuning: all magic numbers here ===
const FARMFOLK_RADIUS = 14; // tiles — close enough to see/hear
const FARMFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const FARMFOLK_CHANCE = 0.15; // per eligible citizen per tick
const FARMFOLK_SHARE = 45; // ~45% nominal share of commoners (post-exclusion)
const HARVEST_DAY_CHANCE = 0.12; // ~12% per farmyard per day (in harvest season)
const FESTIVAL_CHANCE = 0.05; // ~5% per kingdom per day (in autumn)
const PICKING_DAY_CHANCE = 0.08; // ~8% per farmyard per day (in autumn)
const WORK_START_HOUR = 6; // 06:00 server local time — dawn
const WORK_END_HOUR = 20; // 20:00 server local time — dusk
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const REQUEST_TTL_MS = 24 * 3600 * 1000;

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProFarmers = safeRequire("./CitizenFarmers");
const ProCookfolk = safeRequire("./CitizenCooks2");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");
const Memory = safeRequire("./CitizenMemory");

// === Farmfolk types ===
const FARMFOLK_FARMHAND = "farmhand";
const FARMFOLK_TENANT = "tenant-farmer";
const FARMFOLK_ORCHARD = "orchard-keeper";
const FARMFOLK_SELLER = "market-gardener";
const FARMFOLK_HARVEST = "harvest-crew";
const FARMFOLK_TYPES = [
  FARMFOLK_FARMHAND,
  FARMFOLK_TENANT,
  FARMFOLK_ORCHARD,
  FARMFOLK_SELLER,
  FARMFOLK_HARVEST,
];
const FARMFOLK_WEIGHTS = {
  [FARMFOLK_FARMHAND]: 35,
  [FARMFOLK_TENANT]: 25,
  [FARMFOLK_ORCHARD]: 15,
  [FARMFOLK_SELLER]: 15,
  [FARMFOLK_HARVEST]: 10,
};

// === Farmyards: allotments, smallholdings, community orchards and market
// gardens just outside the capitals — distinct from the pro holdings ===
const FARMYARDS = [
  { name: "the Varrock Outskirts Smallholdings", kingdom: "misthalin" },
  { name: "the Lumbridge Allotments", kingdom: "misthalin" },
  { name: "the Falador Farmyard", kingdom: "asgarnia" },
  { name: "the Rimmington Market Garden", kingdom: "asgarnia" },
  { name: "the Ardougne Orchards", kingdom: "kandarin" },
  { name: "the Hemenster Community Plots", kingdom: "kandarin" },
  { name: "the Keldagrim Terrace Gardens", kingdom: "keldagrim" },
  { name: "the Dorgesh Allotment Rows", kingdom: "keldagrim" },
  { name: "the Darkmeyer Orchard Rows", kingdom: "morytania" },
  { name: "the Al Kharid Date-Palm Grove", kingdom: "kharidian" },
];

// === Allotment extras: what the gardens grow beyond the pro fields,
// by real season. Market-garden variety the pro tables don't list. ===
const GARDEN_EXTRAS = {
  spring: ["radish", "spring onion"],
  summer: ["strawberry", "runner bean", "courgette"],
  autumn: ["marrow", "turnip", "blackberry"],
  winter: ["kale", "swede"],
};

// === Scripted work emotes ===
const WORK_LINES = {
  [FARMFOLK_FARMHAND]: [
    "Working the fields.",
    "Farmhand here.",
    "Crops need tending.",
  ],
  [FARMFOLK_TENANT]: [
    "Tenant farming.",
    "Working my plot.",
    "Harvest coming.",
  ],
  [FARMFOLK_ORCHARD]: [
    "Orchard work.",
    "Picking fruit.",
    "Trees need pruning.",
  ],
  [FARMFOLK_SELLER]: [
    "Fresh produce!",
    "Veg for sale!",
    "Farm goods here.",
  ],
  [FARMFOLK_HARVEST]: [
    "Harvest time!",
    "Reaping today.",
    "Gathering crops.",
  ],
};

const HARVEST_OFFSEASON_LINES = [
  "Laying hedgerow for winter.",
  "Re-thatching before the rains.",
  "Sharpening scythes for next year.",
  "Mending ladders today.",
];

// Daily task rotas — the job of the day, stable per name+type+day.
const DAILY_TASKS = {
  [FARMFOLK_FARMHAND]: [
    "hoeing the back fields",
    "carting and spreading manure",
    "wall-mending on the far boundary",
    "watering the nursery beds",
    "greasing wheels and mending harness",
  ],
  [FARMFOLK_TENANT]: [
    "weeding the rented plot",
    "thinning the carrot drills",
    "tying up the bean rows",
    "chitting potatoes for sowing",
    "spreading compost on the tired beds",
  ],
  [FARMFOLK_ORCHARD]: [
    "pruning the apple boughs",
    "grafting new stock",
    "gathering windfalls",
    "oiling the shears and staking saplings",
    "pressing cider in the shed",
  ],
  [FARMFOLK_SELLER]: [
    "stocking the allotment barrow",
    "delivering to the community kitchen",
    "chalking barrow prices",
    "bunching onions and herbs",
    "weighing the day's picking",
  ],
  [FARMFOLK_HARVEST]: [
    "scything with the gang",
    "binding and stooking sheaves",
    "loading the hay wains",
    "stacking grain against the weather",
    "sharpening blades between cuts",
  ],
};

// === Scripted lines ===
const PITCH_LINES = [
  "Fresh {produce} from {yard} — picked this morning!",
  "{produce}! Best of the {yard} allotments!",
  "The {kitchen} buys our {produce} — but there's plenty left for you!",
  "Taste the season: {produce}, straight off the {yard} plots!",
];

const HARVEST_CALL_LINES = [
  "All hands to the sheaves! The weather's turning!",
  "Harvest crew out — grab a scythe if you've got the hands for it!",
  "The gang's in the field all day! Sing to keep the rhythm!",
];

const HARVEST_DAY_LINES = [
  "Harvest day at {yard}! The {crew} are out in force!",
  "The fields are full at {yard} — harvest day is on!",
  "{yard} works the harvest today! All hands, young and old!",
];

const FESTIVAL_LINES = [
  "The {kingdom} harvest feast is on! Grain gathered, ale flowing!",
  "Harvest home! {kingdom} eats well tonight — the sheaves are in!",
  "A harvest feast for {kingdom} at {yard} — bring your appetite!",
];

const PICKING_DAY_LINES = [
  "Orchard picking day at {yard}! The ladders are up, baskets out!",
  "Picking day at {yard} — the boughs are heavy, don't let them drop!",
  "The orchards call at {yard}! Every hand a picker today!",
];

const HELP_WELCOME_LINES = [
  "We've got spare gloves — want to lend a hand, {player}?",
  "Another pair of hands wouldn't hurt, {player}!",
  "The plot's big today, {player} — I'll show you the easy rows.",
];

const BASKET_LINES = [
  "'{produce}'? Aye, the barrow's full — take a basket!",
  "Ah, '{produce}' — best in the garden, friend. It's yours.",
  "'{produce}' it is! Fresh as the morning it was picked.",
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

// === Ledgers (TTL'd) ===
const helpSignups = new Map(); // normName -> { yard, at }
const basketRequests = new Map(); // normName -> { produce, at }
const saleRecords = new Map(); // normName -> { produce, coins, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of helpSignups) {
    if (nowMs - v.at > REQUEST_TTL_MS) helpSignups.delete(k);
  }
  for (const [k, v] of basketRequests) {
    if (nowMs - v.at > REQUEST_TTL_MS) basketRequests.delete(k);
  }
  for (const [k, v] of saleRecords) {
    if (nowMs - v.at > LEDGER_TTL_MS) saleRecords.delete(k);
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

/** Weighted pick of a farmfolk type from a 0..99 roll. */
function farmfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FARMFOLK_TYPES) {
    acc += FARMFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return FARMFOLK_FARMHAND;
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
// Farmfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The farmfolk type for a roster record, or null.
 * Excludes the professional trade (the real CitizenFarmers.farmerTypeFor —
 * it has a null path via the primary-profession partition, so it is a
 * valid eligibility gate). Uses name-first salts to avoid the FNV-1a
 * prefix-correlation bug.
 */
function farmfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the professional trade owns the holdings.
    if (ProFarmers && typeof ProFarmers.farmerTypeFor === "function") {
      try {
        if (ProFarmers.farmerTypeFor(record.username)) return null;
      } catch { /* farmer check failed */ }
    }
    const roll = hashStr(name + "|farmfolk") % 100;
    if (roll >= FARMFOLK_SHARE) return null;
    return farmfolkTypeFromRoll(hashStr(name + "|farmfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred farmyard assignment, stable across restarts. */
function farmyardFor(record) {
  const kid = record?.kingdomId;
  const local = FARMYARDS.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : FARMYARDS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|farmfolk-yard") % pool.length];
}

/** Today's task for a farmfolk citizen (1 task of the day). */
function taskForToday(username, type, dateMs) {
  const tasks = DAILY_TASKS[type] ?? DAILY_TASKS[FARMFOLK_FARMHAND];
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|farmfolk-task:" + day));
  return pickOne(rng, tasks);
}

/**
 * The real season — read from the actual CitizenFarmers season table
 * (static fallback) so harvest crews and sellers follow the farming year.
 */
function seasonNameFor(dateMs) {
  try {
    if (ProFarmers && typeof ProFarmers.seasonFor === "function") {
      return ProFarmers.seasonFor(new Date(dateMs).getMonth());
    }
  } catch { /* farmers absent */ }
  return "summer";
}

/**
 * The active harvest season, or null. Summer is hay harvest, autumn is
 * grain harvest — harvest crews only muster in force then.
 */
function harvestSeasonFor(dateMs) {
  const season = seasonNameFor(dateMs);
  if (season === "summer") return "hay-harvest";
  if (season === "autumn") return "grain-harvest";
  return null;
}

/**
 * Fresh produce available today — read from the REAL CitizenFarmers
 * seasonal tables (raw type strings; the module's named constants are not
 * exported) plus the allotment extras, so market-garden sellers pitch
 * what's genuinely in season. Static fallback when the pro module
 * is absent.
 */
function produceListFor(dateMs) {
  const season = seasonNameFor(dateMs);
  const out = [];
  try {
    if (ProFarmers && typeof ProFarmers.produceFor === "function") {
      for (const type of ["crop", "orchard", "livestock"]) {
        const items = ProFarmers.produceFor(type, season);
        if (Array.isArray(items)) out.push(...items);
      }
    }
  } catch { /* farmers absent */ }
  out.push(...(GARDEN_EXTRAS[season] ?? []));
  return [...new Set(out)];
}

/** The produce a market-garden seller is hawking today (stable per day). */
function produceForToday(username, dateMs) {
  const list = produceListFor(dateMs);
  if (!list.length) return "seasonal veg";
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|farmfolk-produce:" + day));
  return pickOne(rng, list);
}

/** A community kitchen the sellers supply (from the real Cooks2 table). */
function kitchenNameFor(username, dateMs) {
  const pool = ProCookfolk?.COMMUNITY_KITCHENS;
  const names = Array.isArray(pool) && pool.length
    ? pool.map((k) => k?.name ?? k).filter(Boolean)
    : ["the village hearth"];
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|farmfolk-kitchen:" + day));
  return pickOne(rng, names);
}

/**
 * Today's harvest day at a farmyard (~12%/day, harvest seasons only),
 * or null. Harvest crews muster; the whole yard works the harvest.
 */
function harvestDayFor(yard, dateMs) {
  if (!yard?.name) return null;
  const hs = harvestSeasonFor(dateMs);
  if (!hs) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(yard.name + "|harvest-day:" + day));
  if (rng() >= HARVEST_DAY_CHANCE) return null;
  return hs;
}

/**
 * Today's harvest feast for a kingdom (~5%/day, autumn only), or null.
 */
function festivalFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const season = seasonNameFor(dateMs);
  if (season !== "autumn") return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|harvest-feast:" + day));
  if (rng() >= FESTIVAL_CHANCE) return null;
  return true;
}

/**
 * Today's orchard picking day at a farmyard (~8%/day, autumn only),
 * or null.
 */
function pickingDayFor(yard, dateMs) {
  if (!yard?.name) return null;
  const season = seasonNameFor(dateMs);
  if (season !== "autumn") return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(yard.name + "|picking-day:" + day));
  if (rng() >= PICKING_DAY_CHANCE) return null;
  return true;
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** A player signs up to help with the harvest (24h TTL). */
function requestHelp(playerName, yardName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = { yard: String(yardName ?? ""), at: nowMs };
  helpSignups.set(name, rec);
  return rec;
}

/** The player's pending harvest-help signup, or null. */
function helpFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = helpSignups.get(name);
  if (!rec || nowMs - rec.at > REQUEST_TTL_MS) return null;
  return rec;
}

/** A player asks a market-garden seller for a basket of produce (24h TTL). */
function requestBasket(playerName, produce, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !produce) return null;
  pruneLedgers(nowMs);
  const rec = { produce: String(produce), at: nowMs };
  basketRequests.set(name, rec);
  return rec;
}

/** The player's pending basket request, or null. */
function basketFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = basketRequests.get(name);
  if (!rec || nowMs - rec.at > REQUEST_TTL_MS) return null;
  return rec;
}

/** Record a produce sale from a seller to a player (7d TTL). */
function recordSale(playerName, produce, coins, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !produce) return null;
  pruneLedgers(nowMs);
  const rec = { produce: String(produce), coins: Math.max(0, Math.floor(coins ?? 0)), at: nowMs };
  saleRecords.set(name, rec);
  return rec;
}

/** The last produce sale to a player, or null. */
function saleFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = saleRecords.get(name);
  if (!rec || nowMs - rec.at > LEDGER_TTL_MS) return null;
  return rec;
}

/** Does the current produce list contain this produce name (case-insensitive)? */
function produceExists(produce, dateMs = Date.now()) {
  const want = String(produce).toLowerCase().trim();
  return produceListFor(dateMs).some((s) => s.toLowerCase() === want);
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
// Gate order: cooldown (cheapest) → LOD brain gate → farmfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickFarmfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < FARMFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible farmyard life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be farmfolk (hash-derived, cheap; exclusions inside)
        const type = farmfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. Dawn-to-dusk hours only
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, FARMFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, FARMFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doFarmfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-farmfolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: harvest days, feasts and picking days (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-farmfolk] tick failed:", e?.message ?? e);
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

function doFarmfolkWork(director, record, citizen, type, nowMs) {
  const yard = farmyardFor(record);
  const name = normalizeName(record.username);

  // A nearby player's pending basket request takes priority for sellers.
  if (type === FARMFOLK_SELLER) {
    const req = nearbyBasket(director, citizen, nowMs);
    if (req) {
      forceSay(citizen, fill(pickOne(Math.random, BASKET_LINES), { produce: req.produce }));
      journalize(citizen, `gave ${req.produce} to a traveler at ${yard.name}`);
      return;
    }
  }

  // Harvest crew: big harvest work in season / on harvest days, off-season
  // hedge-laying and barn work otherwise.
  if (type === FARMFOLK_HARVEST) {
    const hs = harvestSeasonFor(nowMs);
    const day = harvestDayFor(yard, nowMs);
    if (hs || day) {
      const roll = Math.random();
      if (roll < 0.55) {
        forceSay(citizen, pickOne(Math.random, WORK_LINES[FARMFOLK_HARVEST]));
      } else {
        forceSay(citizen, pickOne(Math.random, HARVEST_CALL_LINES));
      }
      journalize(citizen, `worked the ${hs || "harvest"} at ${yard.name}`);
    } else {
      forceSay(citizen, pickOne(Math.random, HARVEST_OFFSEASON_LINES));
      journalize(citizen, `did off-season work at ${yard.name}`);
    }
    return;
  }

  if (type === FARMFOLK_SELLER) {
    const produce = produceForToday(name, nowMs);
    const kitchen = kitchenNameFor(name, nowMs);
    forceSay(citizen, fill(pickOne(Math.random, PITCH_LINES), { produce, yard: yard.name, kitchen }));
    journalize(citizen, `pitched ${produce} from the barrow at ${yard.name}`);
    return;
  }

  // Farmhands, tenants, orchard keepers: work emotes; occasionally invite a
  // nearby player to lend a hand.
  const helper = nearbyHelperSignup(director, citizen, nowMs);
  if (helper && Math.random() < 0.4) {
    forceSay(citizen, fill(pickOne(Math.random, HELP_WELCOME_LINES), { player: helper }));
    journalize(citizen, `welcomed a helper at ${yard.name}`);
    return;
  }
  forceSay(citizen, pickOne(Math.random, WORK_LINES[type] ?? WORK_LINES[FARMFOLK_FARMHAND]));
  journalize(citizen, `${taskForToday(name, type, nowMs)} at ${yard.name}`);
}

/** A nearby real player with a pending basket request, if any. */
function nearbyBasket(director, citizen, nowMs) {
  try {
    for (const p of director.onlinePlayers?.() ?? []) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, FARMFOLK_RADIUS)) continue;
      const req = basketFor(p.getUsername?.() ?? "", nowMs);
      if (req && req.produce) return req;
    }
  } catch { /* best effort */ }
  return null;
}

/** A nearby real player signed up for harvest help, if any (returns the name). */
function nearbyHelperSignup(director, citizen, nowMs) {
  try {
    for (const p of director.onlinePlayers?.() ?? []) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, FARMFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (helpFor(pname, nowMs)) return pname;
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day farmyard/kingdom rhythms: harvest days, feasts, picking days. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  try {
    for (const yard of FARMYARDS) {
      const hs = harvestDayFor(yard, nowMs);
      if (hs) {
        const key = "harvest-day:" + yard.name + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const line = fill(pickOne(seededRng(hashStr(yard.name + "|harvest-day-line:" + day)), HARVEST_DAY_LINES), {
            yard: yard.name,
            crew: "harvest crews",
          });
          journalize({ username: yard.name }, line);
          seedRumor(line);
        }
      }
      if (pickingDayFor(yard, nowMs)) {
        const key = "picking-day:" + yard.name + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const line = fill(pickOne(seededRng(hashStr(yard.name + "|picking-day-line:" + day)), PICKING_DAY_LINES), {
            yard: yard.name,
          });
          journalize({ username: yard.name }, line);
          seedRumor(line);
        }
      }
    }
    const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
    for (const kid of kingdoms) {
      if (!festivalFor(kid, nowMs)) continue;
      const key = "feast:" + kid + ":" + day;
      if (lastFiredByCitizen.has(key)) continue;
      lastFiredByCitizen.set(key, nowMs);
      const yard = (FARMYARDS.filter((v) => v.kingdom === kid)[0] ?? FARMYARDS[0]).name;
      const line = fill(pickOne(seededRng(hashStr(kid + "|feast-line:" + day)), FESTIVAL_LINES), {
        kingdom: kid,
        yard,
      });
      journalize({ username: "the farmfolk" }, line);
      seedRumor(line);
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickFarmfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  farmfolkTypeOf,
  farmyardFor,
  taskForToday,
  seasonNameFor,
  harvestSeasonFor,
  produceListFor,
  produceForToday,
  kitchenNameFor,
  harvestDayFor,
  festivalFor,
  pickingDayFor,
  requestHelp,
  helpFor,
  requestBasket,
  basketFor,
  recordSale,
  saleFor,
  produceExists,
  nearbyBasket,
  nearbyHelperSignup,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  farmfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  FARMFOLK_TYPES,
  FARMFOLK_FARMHAND,
  FARMFOLK_TENANT,
  FARMFOLK_ORCHARD,
  FARMFOLK_SELLER,
  FARMFOLK_HARVEST,
  FARMYARDS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    helpSignups.clear();
    basketRequests.clear();
    saleRecords.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
