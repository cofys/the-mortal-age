"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenArtisans2 — the woodfolk: bowl turners shaping green wood on pole
 * lathes, basket weavers working willow and rush, whittlers carving spoons,
 * pegs and toys, and timber hands hauling logs from the woodlots. Commoners
 * who live off the unglamorous side of the woodcraft trade — the street
 * economy of bowls, baskets and firewood that the master carpenters'
 * workshops depend on but never talk about.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived woodfolk types, per-day woodlots and wood kinds, timber
 *   sources, goods-order ledger with deterministic 1-3h completion, woodcraft
 *   lesson ledger, and timber-delay + windfall set-pieces (~8%/day each,
 *   journaled + rumor-seeded). The master carpenters' headline work is
 *   cross-read from CitizenArtisans so woodfolk small talk stays consistent
 *   with what the real workshops are actually building.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted turning/weaving/whittling/hauling emotes,
 * simple-goods hawking, ready-order callouts that name the nearby player
 * (interaction priority), showpiece unveilings as the crowd moment, and
 * master-carpenter small talk. Order/lesson dialogue itself is LLM tier —
 * this module only tracks state, timers and the visible street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the glassfolk block.
 * Plain-node testable: CitizenArtisans2.test.js.
 *
 * No overlap (by design):
 *   - CitizenArtisans owns the PROFESSIONAL woodcraft trade (master
 *     carpenters with named workshops, masterpieces, commissions, renown)
 *     — the claimed master artisans are excluded via the real module's
 *     null path (the _artisans roster map: unclaimed names read undefined).
 *   - CitizenMenders owns REPAIR of household goods (handyman: kettle,
 *     bucket, hinge, latch) — woodfolk make NEW simple wooden goods, never
 *     repair anything.
 *   - CitizenBuilders own construction — woodfolk never build structures;
 *     timber hands haul logs to the yard, full stop.
 *   - CitizenCooks own cooking — woodfolk sell wooden spoons and bowls,
 *     never food.
 *   - CitizenFarmers own farm fences and fields — woodfolk weave baskets,
 *     never fence a pasture.
 */

// === Tuning: all magic numbers here ===
const WOODFOLK_RADIUS = 14; // tiles — close enough to see/hear
const WOODFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const WOODFOLK_CHANCE = 0.15; // per eligible citizen per tick
const WOODFOLK_SHARE = 40; // ~40% nominal share of commoners (post-exclusion)
const TIMBER_DELAY_CHANCE = 0.08; // ~8% per kingdom per day: timber late
const WINDFALL_CHANCE = 0.08; // ~8% per kingdom per day: a storm-felled tree
const SHOWPIECE_CHANCE = 0.08; // showpiece unveiling, per woodlot per day
const WORK_START_HOUR = 6; // 06:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time
const ORDER_TTL_MS = 24 * 3600 * 1000; // goods orders linger a day
const LESSON_TTL_MS = 7 * 24 * 3600 * 1000; // lesson interest lingers a week

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProArtisans = safeRequire("./CitizenArtisans");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Woodfolk types ===
const BOWL_TURNER = "bowl-turner";
const BASKET_WEAVER = "basket-weaver";
const WHITTLER = "whittler";
const TIMBER_HAND = "timber-hand";
const WOODFOLK_TYPES = [
  BOWL_TURNER,
  BASKET_WEAVER,
  WHITTLER,
  TIMBER_HAND,
];
const WOODFOLK_WEIGHTS = {
  [BOWL_TURNER]: 30,
  [BASKET_WEAVER]: 30,
  [WHITTLER]: 25,
  [TIMBER_HAND]: 15,
};

// === Woods the turners shape — green and workable, never fine joinery
// stock. The master carpenters' seasoned hardwoods are their trade;
// woodfolk take what the woodlots hand them. ===
const WOOD_KINDS = [
  "green oak",
  "willow",
  "yew offcuts",
  "maple",
  "driftwood",
  "palm wood",
  "alder",
  "ash billets",
];

// === Basket kinds the weavers work ===
const BASKET_KINDS = [
  "willow market baskets",
  "rush shopping baskets",
  "hazel wattle crates",
  "eel-pot baskets",
  "bread baskets",
  "foraging panniers",
];

// === Simple wooden goods — everyday things, never the masters' fine
// furniture (oak bookshelf, mahogany table: the carpenters' trade). ===
const WOODEN_GOODS = [
  "a turned oak bowl",
  "a willow basket",
  "a set of wooden spoons",
  "a carved toy horse",
  "a yew ladle",
  "a rush shopping basket",
  "a maple drinking cup",
  "a bundle of tent pegs",
];

// === Showpieces: the woodlot's proudest work (~8%/woodlot/day) ===
const SHOWPIECES = [
  "a salad bowl turned from a single oak burl",
  "a willow cradle woven without a single nail",
  "a yew longbow-stave, straight as a rule",
  "a nesting set of seven maple bowls",
  "a toy castle carved from one ash block",
];

// === Community woodlots and timber yards — not the masters' workshops. ===
const WOODLOTS = [
  { name: "the Varrock timber yard", kingdom: "misthalin" },
  { name: "the Lumbridge willow copse", kingdom: "misthalin" },
  { name: "the Falador woodlot", kingdom: "asgarnia" },
  { name: "the Port Sarim driftwood beach", kingdom: "asgarnia" },
  { name: "the Seers' oak grove", kingdom: "kandarin" },
  { name: "the Catherby willow stand", kingdom: "kandarin" },
  { name: "the Keldagrim timber racks", kingdom: "keldagrim" },
  { name: "the lower-city firewood yard", kingdom: "keldagrim" },
  { name: "the Mort Myre deadwood stand", kingdom: "morytania" },
  { name: "the Canifis firewood yard", kingdom: "morytania" },
  { name: "the Al Kharid palm grove", kingdom: "kharidian" },
  { name: "the Shantay date-palm stand", kingdom: "kharidian" },
];

// === Woodcraft lessons the whittlers and weavers offer ===
const LESSONS = [
  "spoon carving basics",
  "basket weaving first steps",
  "sharpening a whittling knife",
  "reading the grain",
  "pole-lathe footwork",
];

// === Scripted lines ===
const TURN_LINES = [
  "Green {wood} turns sweet — dry wood fights you.",
  "Another bowl for the pile — {wood} this time!",
];

const WEAVE_LINES = [
  "Soak the rush first or it snaps — that's the trick.",
  "Baskets for market day! {basket}, strong and light!",
];

const WHITTLE_LINES = [
  "Mind the grain — cut with it, never against.",
  "Spoons, pegs, toys — whittling's honest work.",
];

const HAUL_LINES = [
  "*shoulders a log* Timber for the yard! Out of the way!",
  "Hauling from {woodlot} — the carpenters' workshops never stop eating!",
  "*stacks logs, ends flush* That one's oak — heavy as sin.",
  "From {woodlot} to the yard — my back remembers every load.",
];

const GOODS_LINES = [
  "Wooden goods! {good} — turned and woven this very week!",
  "{good} for sale — woodlot-made, woodlot-priced!",
  "Bowls, baskets, spoons! {good} — take a look!",
];

const LESSON_LINES = [
  "Want to learn the knife? I'll teach you {lesson} — start slow.",
  "I teach {lesson} on market days. Bring a sharp knife and patience.",
];

const PRO_CRAFT_LINES = [
  "Master {master} is building {piece} at the workshop — my trade is bowls and baskets, mind!",
  "Leave the {piece} to Master {master}. You want a spoon? Ask me!",
  "The workshop's doing {piece} today — I only haul the timber, mind!",
];

const READY_ORDER_LINES = [
  "{player}! Your {good} — finished fresh, ready to collect!",
  "Back from the lathe, {player}! Here's your {good}!",
  "{player} — got your {good}. Turned it myself!",
];

const TIMBER_DELAY_LINES = [
  "Timber's late! The wagons missed the road — the yards are running on scraps!",
  "No logs from {woodlot} today — the hands are splitting firewood instead!",
  "Wagons stuck past {woodlot} — the turners are working down their piles!",
];

const WINDFALL_LINES = [
  "Storm-fall! A whole oak came down at {woodlot} — the yard's feasting!",
  "Wind took a yew at {woodlot} — turners, bring your lathes!",
  "{woodlot} lost a big one in the night — that's a month's turning for us!",
];

const SHOWPIECE_LINES = [
  "Behold! {piece} — the finest work to leave {woodlot}!",
  "Come see — {piece}! That's what a woodlot hand can do!",
  "{piece}! Took me a week at the lathe — worth every shaving!",
];

const DAILY_TASK_LINES = {
  [BOWL_TURNER]: [
    "sharpening the turning gouges",
    "stacking green billets to season",
    "oiling the pole-lathe cord",
    "sanding yesterday's bowls smooth",
  ],
  [BASKET_WEAVER]: [
    "soaking willow withies",
    "sorting rush by length",
    "re-bottoming a market basket",
    "drying finished baskets in the sun",
  ],
  [WHITTLER]: [
    "stropping the whittling knife",
    "splitting kindling for the fire",
    "sorting spoon blanks",
    "carving pegs for the basket weavers",
  ],
  [TIMBER_HAND]: [
    "sharpening the crosscut saw",
    "mending the log cart",
    "splitting firewood for the yard",
    "chalking the timber tally on the gate",
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
const goodsOrders = new Map(); // normPlayerName -> { order }
const lessonInterest = new Map(); // normPlayerName -> { lesson, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of goodsOrders) {
    if (v.order.until <= nowMs) goodsOrders.delete(k);
  }
  for (const [k, v] of lessonInterest) {
    if (nowMs - v.at > LESSON_TTL_MS) lessonInterest.delete(k);
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

/** Weighted pick of a woodfolk type from a 0..99 roll. */
function woodfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of WOODFOLK_TYPES) {
    acc += WOODFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return BOWL_TURNER;
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
// Woodfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The woodfolk type for a roster record, or null.
 * Excludes the claimed master artisans (the real CitizenArtisans _artisans
 * roster map — it has a null path: unclaimed names read undefined, so it is
 * a valid eligibility gate): the masters own the workshops and the fine
 * furniture trade, woodfolk own bowls, baskets and firewood.
 * Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function woodfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the claimed master artisans own the fine craft trade.
    try {
      if (ProArtisans && ProArtisans._artisans && ProArtisans._artisans.has(name)) return null;
    } catch { /* pro check failed — treat as unclaimed */ }
    const roll = hashStr(name + "|woodfolk") % 100;
    if (roll >= WOODFOLK_SHARE) return null;
    return woodfolkTypeFromRoll(hashStr(name + "|woodfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred woodlot assignment, stable across restarts. */
function woodlotFor(record) {
  const kid = record?.kingdomId ?? record?.kingdom;
  const local = WOODLOTS.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : WOODLOTS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|woodlot") % pool.length];
}

/** Today's wood kind for a turner (stable per day). */
function woodForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|wood-wood:" + day));
  return pickOne(rng, WOOD_KINDS);
}

/** Today's basket kind for a weaver (stable per day). */
function basketForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|wood-basket:" + day));
  return pickOne(rng, BASKET_KINDS);
}

/** Today's task for a woodfolk citizen (1 task of the day). */
function taskForToday(username, type, dateMs) {
  const tasks = DAILY_TASK_LINES[type] ?? DAILY_TASK_LINES[BOWL_TURNER];
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|wood-task:" + day));
  return pickOne(rng, tasks);
}

/** Today's featured good at a woodlot. */
function goodForToday(woodlot, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("woodfolkgood:" + woodlot.name + ":" + day));
  return pickOne(rng, WOODEN_GOODS);
}

/** A fair woodlot price for a simple wooden good (2-25 coins). */
function priceFor(good, dateMs) {
  const rng = seededRng(hashStr("woodfolkprice:" + good + ":" + dayNumber(dateMs)));
  return 2 + Math.floor(rng() * 24);
}

/**
 * Today's showpiece at a woodlot (~8%/day), or null.
 * { piece } — the crowd moment.
 */
function showpieceFor(woodlot, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("woodfolkshowpiece:" + woodlot.name + ":" + day));
  if (rng() >= SHOWPIECE_CHANCE) return null;
  return { piece: pickOne(rng, SHOWPIECES) };
}

/**
 * A timber shipment delay in a kingdom (~8%/day), or null: the wagons
 * missed the road and the yards are running on scraps. Journaled +
 * rumor-seeded by dailyRhythms.
 */
function timberDelayFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|timber-delay:" + day));
  if (rng() >= TIMBER_DELAY_CHANCE) return null;
  return true;
}

/**
 * A storm-felled tree in a kingdom's woodlots (~8%/day), or null: the
 * yard feasts on windfall. Journaled + rumor-seeded by dailyRhythms.
 */
function windfallFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|windfall:" + day));
  if (rng() >= WINDFALL_CHANCE) return null;
  return true;
}

// ============================================================================
// Real-data bridges — the master artisans, cross-read.
// ============================================================================

/**
 * Read-only bridge: the kingdom's master carpenter (claimed by the real
 * CitizenArtisans roster), so woodfolk small talk names the actual master
 * whose workshop they haul timber to. Never throws.
 * Returns { display, masterpiece } or null.
 */
function proCarpenterFor(kingdomId, nowMs = Date.now()) {
  try {
    if (!ProArtisans || !ProArtisans._artisans) return null;
    const kid = String(kingdomId ?? "");
    for (const [name, info] of ProArtisans._artisans) {
      if (info?.trade !== "carpenter") continue;
      if (kid && String(info.kingdomId) !== kid) continue;
      let masterpiece = null;
      try {
        const pieces = ProArtisans._masterpieces?.get(name);
        if (pieces && pieces.length) masterpiece = pieces[pieces.length - 1]?.name ?? null;
      } catch { /* no masterpieces */ }
      return { display: info.display ?? name, masterpiece };
    }
  } catch { /* pro absent */ }
  return null;
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/**
 * A woodfolk citizen takes a goods order: make a count of a specific
 * wooden good for a player, deterministic 1-3h completion.
 */
function requestOrder(playerName, makerName, good, count, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const maker = String(makerName ?? "").slice(0, 40);
  const g = String(good ?? "").slice(0, 60);
  const n = Math.max(1, Math.floor(count ?? 1));
  if (!name || !maker || !g) return null;
  pruneLedgers(nowMs);
  const day = dayNumber(nowMs);
  const durationMs = (1 + hashStr(name + "|order-dur:" + g + ":" + day) % 3) * 3600 * 1000;
  const rec = {
    order: {
      player: String(playerName),
      maker,
      good: g,
      count: n,
      askedAt: nowMs,
      durationMs,
      readyAt: nowMs + durationMs,
      until: nowMs + ORDER_TTL_MS,
    },
  };
  goodsOrders.set(name, rec);
  return rec.order;
}

/** The player's outstanding goods order, or null. */
function orderFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = goodsOrders.get(name);
  if (!rec || rec.order.until <= nowMs) return null;
  return { ...rec.order };
}

/** True when the order is done (the maker is back from the lathe). */
function orderReady(order, nowMs = Date.now()) {
  if (!order) return false;
  return nowMs >= order.readyAt;
}

/** The player collects their order (deletes the record). */
function completeOrder(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return goodsOrders.delete(name);
}

/** Record that a player asked about a woodcraft lesson. */
function learnWoodcraft(playerName, lesson, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !lesson) return null;
  pruneLedgers(nowMs);
  lessonInterest.set(name, { lesson: String(lesson), at: nowMs });
  return lesson;
}

/** The lesson a player last asked about, or null. */
function woodcraftFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = lessonInterest.get(name);
  return rec ? rec.lesson : null;
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
// Gate order: cooldown (cheapest) → LOD brain gate → woodfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickWoodfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < WOODFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible woodfolk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be a woodfolk (hash-derived, cheap; exclusions inside)
        const type = woodfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. Work hours only
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, WOODFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, WOODFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doWoodfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-woodfolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: timber delays and windfalls (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-woodfolk] tick failed:", e?.message ?? e);
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

function doWoodfolkWork(director, record, citizen, type, nowMs) {
  const woodlot = woodlotFor(record);
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const day = dayNumber(nowMs);

  // Showpiece unveiling: once per woodlot per day, the crowd moment.
  const sp = showpieceFor(woodlot, nowMs);
  if (sp) {
    const key = "woodshowpiece:" + woodlot.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, SHOWPIECE_LINES), {
        piece: sp.piece,
        woodlot: woodlot.name,
      }));
      journalize(citizen, `unveiled ${sp.piece} at ${woodlot.name}`);
      seedRumor(`${sp.piece} unveiled at ${woodlot.name}!`);
      return;
    }
  }

  // A nearby player's ready order takes priority for turners/weavers/whittlers.
  if (type !== TIMBER_HAND) {
    const ready = nearbyReadyOrder(director, citizen, nowMs);
    if (ready) {
      forceSay(citizen, fill(pickOne(Math.random, READY_ORDER_LINES), {
        player: ready.name,
        good: ready.order.good,
      }));
      journalize(citizen, `handed a finished order to a customer near ${woodlot.name}`);
      return;
    }
  }

  if (type === BOWL_TURNER) {
    const roll = Math.random();
    if (roll < 0.55) {
      const wood = woodForToday(name, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, TURN_LINES), { wood }));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${woodlot.name}`);
    } else if (roll < 0.75) {
      const good = goodForToday(woodlot, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, GOODS_LINES), { good }));
      journalize(citizen, `hawked ${good} at ${woodlot.name}`);
    } else {
      const carp = kid ? proCarpenterFor(kid, nowMs) : null;
      if (carp && carp.masterpiece) {
        forceSay(citizen, fill(pickOne(Math.random, PRO_CRAFT_LINES), {
          master: carp.display,
          piece: carp.masterpiece,
        }));
        journalize(citizen, `talked trade with passers-by at ${woodlot.name}`);
      } else {
        const wood = woodForToday(name, nowMs);
        forceSay(citizen, fill(pickOne(Math.random, TURN_LINES), { wood }));
        journalize(citizen, `${taskForToday(name, type, nowMs)} at ${woodlot.name}`);
      }
    }
    return;
  }

  if (type === BASKET_WEAVER) {
    const roll = Math.random();
    if (roll < 0.6) {
      const basket = basketForToday(name, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, WEAVE_LINES), { basket }));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${woodlot.name}`);
    } else if (roll < 0.8) {
      const good = goodForToday(woodlot, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, GOODS_LINES), { good }));
      journalize(citizen, `hawked ${good} at ${woodlot.name}`);
    } else {
      const lesson = pickOne(Math.random, LESSONS);
      forceSay(citizen, fill(pickOne(Math.random, LESSON_LINES), { lesson }));
      journalize(citizen, `offered woodcraft lessons at ${woodlot.name}`);
    }
    return;
  }

  if (type === WHITTLER) {
    const roll = Math.random();
    if (roll < 0.6) {
      forceSay(citizen, pickOne(Math.random, WHITTLE_LINES));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${woodlot.name}`);
    } else if (roll < 0.8) {
      const good = goodForToday(woodlot, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, GOODS_LINES), { good }));
      journalize(citizen, `hawked ${good} at ${woodlot.name}`);
    } else {
      const lesson = pickOne(Math.random, LESSONS);
      forceSay(citizen, fill(pickOne(Math.random, LESSON_LINES), { lesson }));
      journalize(citizen, `offered woodcraft lessons at ${woodlot.name}`);
    }
    return;
  }

  // Timber-hand: the yard work.
  if (kid && timberDelayFor(kid, nowMs) && Math.random() < 0.4) {
    forceSay(citizen, fill(pickOne(Math.random, TIMBER_DELAY_LINES), { woodlot: woodlot.name }));
    journalize(citizen, `sat idle on a timber delay at ${woodlot.name}`);
    return;
  }
  if (kid && windfallFor(kid, nowMs) && Math.random() < 0.4) {
    forceSay(citizen, fill(pickOne(Math.random, WINDFALL_LINES), { woodlot: woodlot.name }));
    journalize(citizen, `worked storm windfall at ${woodlot.name}`);
    return;
  }
  forceSay(citizen, fill(pickOne(Math.random, HAUL_LINES), { woodlot: woodlot.name }));
  journalize(citizen, `${taskForToday(name, type, nowMs)} at ${woodlot.name}`);
}

/** A nearby real player whose goods order is ready, if any. */
function nearbyReadyOrder(director, citizen, nowMs) {
  try {
    for (const p of director.onlinePlayers?.() ?? []) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, WOODFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) return null;
      const ok = orderFor(pname, nowMs);
      if (ok && orderReady(ok, nowMs)) return { name: pname, order: ok };
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day kingdom rhythms: timber delays and windfalls. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
  try {
    for (const kid of kingdoms) {
      if (timberDelayFor(kid, nowMs)) {
        const key = "timber-delay:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const line = `Timber wagons missed the road in ${kid} — the woodlots are running on scraps and the hands are splitting firewood.`;
          journalize({ username: "the woodfolk" }, line);
          seedRumor(line);
        }
      }
      if (windfallFor(kid, nowMs)) {
        const key = "windfall:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const pool = WOODLOTS.filter((v) => v.kingdom === kid);
          const woodlot = (pool.length ? pool[0] : WOODLOTS[0]).name;
          const line = `A storm dropped a whole tree at ${woodlot} in ${kid} — the woodfolk are feasting on windfall.`;
          journalize({ username: "the woodfolk" }, line);
          seedRumor(line);
        }
      }
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickWoodfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  woodfolkTypeOf,
  woodlotFor,
  woodForToday,
  basketForToday,
  taskForToday,
  goodForToday,
  priceFor,
  showpieceFor,
  timberDelayFor,
  windfallFor,
  proCarpenterFor,
  requestOrder,
  orderFor,
  orderReady,
  completeOrder,
  learnWoodcraft,
  woodcraftFor,
  nearbyReadyOrder,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  woodfolkTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  WOODFOLK_TYPES,
  BOWL_TURNER,
  BASKET_WEAVER,
  WHITTLER,
  TIMBER_HAND,
  WOODLOTS,
  WOOD_KINDS,
  BASKET_KINDS,
  WOODEN_GOODS,
  LESSONS,
  // Tuning (tests pin the documented behavior):
  WOODFOLK_RADIUS,
  WOODFOLK_CITIZEN_COOLDOWN_MS,
  WOODFOLK_CHANCE,
  WOODFOLK_SHARE,
  TIMBER_DELAY_CHANCE,
  WINDFALL_CHANCE,
  SHOWPIECE_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  ORDER_TTL_MS,
  LESSON_TTL_MS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    goodsOrders.clear();
    lessonInterest.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
