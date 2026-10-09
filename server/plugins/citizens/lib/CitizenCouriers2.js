"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenCouriers2 — the errand-runners: street errand boys, grocery
 * carriers, water fetchers and neighborhood note-lads. Commoners who live
 * off small fetch-and-carry work: the informal, same-street errand economy
 * under the private couriers' noses.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived errand types, per-day tasks, fees, baskets and wells,
 *   street-beat assignments, market-rush and spilled-basket set-pieces
 *   (~8%/day each, journaled + rumor-seeded), 24h-TTL fetch-request and
 *   7d-TTL short-note ledgers with deterministic completion times. The
 *   real courier's pickup corners and hired-delivery statuses are
 *   cross-read from CitizenCouriers so runners can point players at the
 *   proper trade ("for parcels, the runners wait at the market square —
 *   I only do the small stuff").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted errand offers with today's fee, basket and
 * water lines, note-lad pitches, ready-fetch and delivered-note callouts
 * that name the nearby player (interaction priority), and hired-delivery
 * status mentions. Fetch/note dialogue itself is LLM tier — this module
 * only tracks state, timers and the visible street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the moneyfolk block. Plain-node
 * testable: CitizenCouriers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenCouriers owns PRIVATE deliveries (pigeons, parcels, letters,
 *     urgent dispatches, player-hired deliveries) — courierTypeFor()
 *     citizens are excluded via the real module's null path.
 *   - CitizenMessengers owns the OFFICIAL post (messenger-primary
 *     citizens are excluded; errand-runners never carry official mail).
 *   - CitizenTradeCaravans owns the roads between cities — errand-runners
 *     stay in one city, on foot, same-day.
 *   - CitizenHawker owns street selling — runners carry for others, never
 *     sell goods.
 */

// === Tuning: all magic numbers here ===
const ERRAND_RADIUS = 14; // tiles — close enough to see/hear
const ERRAND_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const ERRAND_CHANCE = 0.15; // per eligible citizen per tick
const ERRAND_SHARE = 45; // ~45% nominal share of commoners (post-exclusion)
const RUSH_CHANCE = 0.08; // ~8% per beat per day: a market rush
const SPILL_CHANCE = 0.08; // ~8% per kingdom per day: a spilled basket
const WORK_START_HOUR = 6; // 06:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time
const FETCH_TTL_MS = 24 * 3600 * 1000; // fetch requests linger a day
const NOTE_TTL_MS = 7 * 24 * 3600 * 1000; // short notes linger a week

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProCouriers = safeRequire("./CitizenCouriers");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");
const Professions = safeRequire("./CitizenPrimaryProfession");

// === Errand types ===
const ERRAND_RUNNER = "errand-runner";
const GROCERY_CARRIER = "grocery-carrier";
const WATER_FETCHER = "water-fetcher";
const NOTE_LAD = "note-lad";
const ERRAND_TYPES = [
  ERRAND_RUNNER,
  GROCERY_CARRIER,
  WATER_FETCHER,
  NOTE_LAD,
];
const ERRAND_WEIGHTS = {
  [ERRAND_RUNNER]: 30,
  [GROCERY_CARRIER]: 30,
  [WATER_FETCHER]: 25,
  [NOTE_LAD]: 15,
};

// === Street beats: corners and nooks where the runners wait for work,
// distinct from the couriers' pickup points and the anchored stalls ===
const ERRAND_BEATS = [
  { name: "the Varrock north gate corner", kingdom: "misthalin" },
  { name: "Candle Lane's corner", kingdom: "misthalin" },
  { name: "the Falador west wall steps", kingdom: "asgarnia" },
  { name: "the Rimmington ferry corner", kingdom: "asgarnia" },
  { name: "the Ardougne east market corner", kingdom: "kandarin" },
  { name: "the Hemenster well square", kingdom: "kandarin" },
  { name: "the Keldagrim lower-city steps", kingdom: "keldagrim" },
  { name: "the Dorgesh market corner", kingdom: "keldagrim" },
  { name: "the Darkmeyer south gate corner", kingdom: "morytania" },
  { name: "the Al Kharid gate corner", kingdom: "kharidian" },
];

// === Wells the water fetchers draw from ===
const WELLS = [
  "the Candle Lane well",
  "the market well",
  "the temple well",
  "the dockside well",
  "the old stone well",
  "the baker's well",
];

// === What the grocery carriers are lugging today ===
const BASKET_GOODS = [
  "a basket of bread",
  "a basket of leeks and onions",
  "a basket of cheese",
  "a basket of apples",
  "a basket of fish",
  "a basket of eggs",
  "a basket of herbs",
  "a basket of pies",
];

// === Small jobs the errand-runners get asked for ===
const ERRAND_JOBS = [
  "fetching a parcel of mending from the tailor",
  "carrying the Widow Penn's market basket",
  "running a message to the docks",
  "fetching pipe-weed for the old sailor",
  "carrying lamp oil up to the tower",
  "fetching the midwife's herbs",
  "running spare keys to the chandler",
  "carrying coal to the smithy",
];

// === Scripted lines ===
const OFFER_LINES = [
  "Errands run! A copper a run, {fee} — quick feet, honest work!",
  "Need something fetched? I'm your lad — {fee} and I'm off!",
  "Baskets carried, notes run, water fetched — {fee}, no waiting!",
  "Too busy to run it yourself? That's what I'm for — {fee}!",
];

const BASKET_LINES = [
  "Baskets carried home! {basket} and I'll carry it steady, no spills!",
  "Market baskets, door to door — carrying {basket} right now, join the queue!",
  "Who's got a basket too heavy? I'm carrying {basket} and I've room for more!",
  "Steady hands! {basket} carried safe, copper a trip!",
];

const WATER_LINES = [
  "Water! Fresh from {well} — a copper the bucket, door to door!",
  "Carrying from {well} today. Buckets balanced, not a drop spilled!",
  "Who needs water? {well} runs clear this morning!",
  "Two buckets, one yoke, {well} to your door — water's up!",
];

const NOTE_LINES = [
  "Notes run across the square! A copper and your words get legs!",
  "Quick note for the neighbor? I'll run it — back before your tea cools!",
  "I run short notes, hand to hand — nothing official, just neighborly!",
  "Need a word carried two streets over? That's a note-lad's bread and butter!",
];

const READY_FETCH_LINES = [
  "{player}! Your {item} — fetched and ready, quick as promised!",
  "Back already, {player}! Here's your {item}, safe as houses!",
  "{player} — got your {item}. A copper, as agreed, and I'm off again!",
];

const NOTE_DONE_LINES = [
  "{player}! Your note for {to} got there — hand-delivered, like I said!",
  "Delivered, {player}! {to} got your words, straight from my mouth to their ears!",
];

const HIRE_STATUS_LINES = [
  "Waiting on a parcel? {courier}'s got it — it's {status}.",
  "Your hired runner {courier} is {status} — told you the small errands are mine, the big ones are theirs!",
  "Saw {courier} on the {status} run — parcels are their trade, errands are mine!",
];

const CORNER_LINES = [
  "For proper parcels, the runners wait at {corner} — I only do the small stuff!",
  "Big delivery? Ask at {corner}, that's the runners' corner. Me, I'm errands and fetchings!",
  "The couriers work from {corner}. I work wherever my feet take me!",
];

const RUSH_LINES = [
  "Market rush! Everyone needs a basket carried — line up, line up!",
  "Rush day! Baskets, bundles, buckets — I'm hiring my own legs out twice over!",
  "The whole market needs carrying today! Who's first?",
];

const SPILL_LINES = [
  "Clumsy morning — spilled {basket} all over the square! Anyone help me gather it?",
  "Dropped a basket — {basket} everywhere! The pigeons are having a feast!",
  "Mind the steps — someone's {basket} went everywhere this morning!",
];

const DAILY_TASK_LINES = {
  [ERRAND_RUNNER]: [
    "waiting on the corner for odd jobs",
    "running spare keys to the chandler",
    "fetching lamp oil for the tower",
    "practicing the sprint up the wall steps",
  ],
  [GROCERY_CARRIER]: [
    "balancing baskets on a shoulder yoke",
    "queuing at the market stalls",
    "waxing the basket handles",
    "counting the morning's basket coppers",
  ],
  [WATER_FETCHER]: [
    "mending a leaky bucket",
    "queuing at the well",
    "oiling the shoulder yoke",
    "chalking the water round on the doorposts",
  ],
  [NOTE_LAD]: [
    "memorizing the short cuts",
    "polishing the message satchel",
    "waiting by the fountain for note work",
    "learning the neighbors' names",
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
const fetches = new Map(); // normPlayerName -> { fetch }
const shortNotes = new Map(); // normPlayerName -> { note }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of fetches) {
    if (v.fetch.until <= nowMs) fetches.delete(k);
  }
  for (const [k, v] of shortNotes) {
    if (v.note.until <= nowMs) shortNotes.delete(k);
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

/** Weighted pick of an errand type from a 0..99 roll. */
function errandTypeFromRoll(roll) {
  let acc = 0;
  for (const t of ERRAND_TYPES) {
    acc += ERRAND_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return ERRAND_RUNNER;
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
// Errand-runner identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The errand type for a roster record, or null.
 * Excludes the professional trade (the real CitizenCouriers.courierTypeFor
 * — it has a null path, so it is a valid eligibility gate) and the
 * official post (messenger-primary citizens run the post, not errands).
 * Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function errandTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the professional couriers own private deliveries.
    if (ProCouriers && typeof ProCouriers.courierTypeFor === "function") {
      try {
        if (ProCouriers.courierTypeFor(record.username)) return null;
      } catch { /* courier check failed */ }
    }
    // No overlap: messengers own the official post.
    try {
      if (Professions && typeof Professions.primaryProfessionFor === "function") {
        if (Professions.primaryProfessionFor(name) === "messenger") return null;
      }
    } catch { /* profession check failed */ }
    const roll = hashStr(name + "|errandfolk") % 100;
    if (roll >= ERRAND_SHARE) return null;
    return errandTypeFromRoll(hashStr(name + "|errand-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred street-beat assignment, stable across restarts. */
function beatFor(record) {
  const kid = record?.kingdomId ?? record?.kingdom;
  const local = ERRAND_BEATS.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : ERRAND_BEATS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|errand-beat") % pool.length];
}

// (feeForToday removed 2026-10-08: hash-derived fabrication.)

// (errandJobForToday removed 2026-10-08: hash-derived fabrication.)

// (basketForToday removed 2026-10-08: hash-derived fabrication.)

// (wellForToday removed 2026-10-08: hash-derived fabrication.)

// (taskForToday removed 2026-10-08: hash-derived fabrication.)

// (marketRushFor removed 2026-10-08: hash-derived fabrication.)

/**
 * A spilled basket in a kingdom (~8%/day), or null: a runner dropped a
 * basket in the square. Journaled + rumor-seeded by dailyRhythms.
 */
function spilledBasketFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|spilled-basket:" + day));
  if (rng() >= SPILL_CHANCE) return null;
  const basket = BASKET_GOODS[rng() * BASKET_GOODS.length | 0];
  return { basket };
}

// ============================================================================
// Real-data bridges — the proper couriers, cross-read from CitizenCouriers.
// ============================================================================

/** Where the real couriers wait (pro PICKUP_POINTS), for flavor lines. */
function courierCorners() {
  try {
    if (ProCouriers && Array.isArray(ProCouriers.PICKUP_POINTS) && ProCouriers.PICKUP_POINTS.length) {
      return ProCouriers.PICKUP_POINTS.slice();
    }
  } catch { /* pro absent */ }
  return ["the market square"];
}

/**
 * Read-only bridge: the player's outstanding hired delivery from the pro
 * courier trade, or null. Errand-runners know the runners' corner gossip,
 * so they can tell a player where their parcel got to. Never throws.
 */
function hiredDeliveryStatus(playerName, nowMs = Date.now()) {
  try {
    if (!ProCouriers || typeof ProCouriers.hireFor !== "function") return null;
    const hire = ProCouriers.hireFor(playerName, nowMs);
    if (!hire) return null;
    const status = typeof ProCouriers.deliveryStatus === "function"
      ? ProCouriers.deliveryStatus(hire, nowMs)
      : "en route";
    return { courier: hire.courier, kind: hire.kind, status };
  } catch {
    return null;
  }
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** An errand-runner takes a fetch request: deterministic 1-3h completion. */
function requestFetch(playerName, runnerName, item, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const runner = String(runnerName ?? "").slice(0, 40);
  const i = String(item ?? "").slice(0, 60);
  if (!name || !runner || !i) return null;
  pruneLedgers(nowMs);
  const day = dayNumber(nowMs);
  const durationMs = (1 + hashStr(name + "|fetch-dur:" + i + ":" + day) % 3) * 3600 * 1000;
  const rec = {
    fetch: {
      player: String(playerName),
      runner,
      item: i,
      askedAt: nowMs,
      durationMs,
      readyAt: nowMs + durationMs,
      until: nowMs + FETCH_TTL_MS,
    },
  };
  fetches.set(name, rec);
  return rec.fetch;
}

/** The player's outstanding fetch request, or null. */
function fetchFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = fetches.get(name);
  if (!rec || rec.fetch.until <= nowMs) return null;
  return { ...rec.fetch };
}

/** True when the fetch is done (the runner is back with the goods). */
function fetchReady(fetch, nowMs = Date.now()) {
  if (!fetch) return false;
  return nowMs >= fetch.readyAt;
}

/** The player collects their fetched item (deletes the record). */
function completeFetch(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return fetches.delete(name);
}

/**
 * A note-lad takes a short note across the neighborhood: deterministic
 * 30-90min delivery. Not official post — neighborly words only.
 */
function sendShortNote(playerName, runnerName, toWhom, text, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const runner = String(runnerName ?? "").slice(0, 40);
  const to = String(toWhom ?? "").slice(0, 60);
  if (!name || !runner || !to) return null;
  pruneLedgers(nowMs);
  const day = dayNumber(nowMs);
  const durationMs = (30 + hashStr(name + "|note-dur:" + to + ":" + day) % 60) * 60 * 1000;
  const rec = {
    note: {
      player: String(playerName),
      runner,
      to,
      text: String(text || "").slice(0, 140),
      askedAt: nowMs,
      durationMs,
      readyAt: nowMs + durationMs,
      until: nowMs + NOTE_TTL_MS,
    },
  };
  shortNotes.set(name, rec);
  return rec.note;
}

/** The player's outstanding short note, or null. */
function shortNoteFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = shortNotes.get(name);
  if (!rec || rec.note.until <= nowMs) return null;
  return { ...rec.note };
}

/** True when the note has been delivered. */
function noteDelivered(note, nowMs = Date.now()) {
  if (!note) return false;
  return nowMs >= note.readyAt;
}

/** The player acknowledges the delivered note (deletes the record). */
function collectNote(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return shortNotes.delete(name);
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

// Canonical: getJournal().log(name, kind, text). The appendEntry/addEntry
// probe pattern is dead — CitizenJournal only exports getJournal() with a
// log() method.
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

function journalize(citizenName, text) {
  try {
    journal()?.log(citizenName, "work", text);
  } catch {
    /* journal is best-effort; never break the tick */
  }
}


/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → errand? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickErrandfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < ERRAND_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible errand life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be an errand-runner (hash-derived, cheap; exclusions inside)
        const type = errandTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Street hours only
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, ERRAND_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, ERRAND_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doErrandWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-errandfolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: market rushes and spilled baskets (cheap, day-gated).
    // (dailyRhythms removed 2026-10-08: hash-derived fake events.)
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-errandfolk] tick failed:", e?.message ?? e);
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

function doErrandWork(director, record, citizen, type, nowMs) {
  const beat = beatFor(record);

  // A nearby player's ready fetch request takes priority for errand-runners.
  if (type === ERRAND_RUNNER) {
    const ready = nearbyReadyFetch(director, citizen, nowMs);
    if (ready) {
      forceSay(citizen, fill(pickOne(Math.random, READY_FETCH_LINES), {
        player: ready.name,
        item: ready.fetch.item,
      }));
      journalize(citizen, `brought a fetched item back to a customer at ${beat.name}`);
      return;
    }
    // Second priority: the player's hired courier delivery status.
    const hire = nearbyPlayerHire(director, citizen, nowMs);
    if (hire && Math.random() < 0.5) {
      forceSay(citizen, fill(pickOne(Math.random, HIRE_STATUS_LINES), {
        courier: hire.hire.courier,
        status: hire.hire.status,
      }));
      journalize(citizen, `passed on runner-corner gossip at ${beat.name}`);
      return;
    }
  }

  // A nearby player's delivered short note takes priority for note-lads.
  if (type === NOTE_LAD) {
    const done = nearbyDeliveredNote(director, citizen, nowMs);
    if (done) {
      forceSay(citizen, fill(pickOne(Math.random, NOTE_DONE_LINES), {
        player: done.name,
        to: done.note.to,
      }));
      journalize(citizen, `reported a delivered note at ${beat.name}`);
      return;
    }
  }

  if (type === ERRAND_RUNNER) {
    // (feeForToday/errandJobForToday/taskForToday removed 2026-10-08: hash-derived
    // fabrication. The nearbyReadyFetch/nearbyPlayerHire branches above handle real jobs.)
    const roll = Math.random();
    if (roll < 0.6) {
      forceSay(citizen, pickOne(Math.random, OFFER_LINES));
    } else {
      forceSay(citizen, fill(pickOne(Math.random, CORNER_LINES), {
        corner: pickOne(Math.random, courierCorners()),
      }));
    }
    journalize(citizen, `worked the errand beat at ${beat.name}`);
    return;
  }

  if (type === GROCERY_CARRIER) {
    // (basketForToday/marketRushFor removed 2026-10-08: hash-derived fabrication.)
    forceSay(citizen, pickOne(Math.random, BASKET_LINES));
    journalize(citizen, `carried groceries at ${beat.name}`);
    return;
  }

  if (type === WATER_FETCHER) {
    // (wellForToday removed 2026-10-08: hash-derived well name was fabrication.)
    forceSay(citizen, pickOne(Math.random, WATER_LINES));
    journalize(citizen, `drew water at ${beat.name}`);
    return;
  }

  // Note-lad: short-note pitches.
  forceSay(citizen, pickOne(Math.random, NOTE_LINES));
  journalize(citizen, `ran short notes across the neighborhood at ${beat.name}`);
}

/** A nearby real player whose fetch request is ready, if any. */
function nearbyReadyFetch(director, citizen, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, ERRAND_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) continue;
      const f = fetchFor(pname, nowMs);
      if (f && fetchReady(f, nowMs)) return { name: pname, fetch: f };
    }
  } catch { /* best effort */ }
  return null;
}

/** A nearby real player whose short note has been delivered, if any. */
function nearbyDeliveredNote(director, citizen, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, ERRAND_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) continue;
      const n = shortNoteFor(pname, nowMs);
      if (n && noteDelivered(n, nowMs)) return { name: pname, note: n };
    }
  } catch { /* best effort */ }
  return null;
}

/** A nearby real player with an outstanding hired courier delivery, if any. */
function nearbyPlayerHire(director, citizen, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, ERRAND_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) continue;
      const h = hiredDeliveryStatus(pname, nowMs);
      if (h) return { name: pname, hire: h };
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day beat/kingdom rhythms: market rushes and spilled baskets. */
// (function dailyRhythms removed 2026-10-08: hash-derived fake events.)

module.exports = {
  tickErrandfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  errandTypeOf,
  beatFor,
  spilledBasketFor,
  courierCorners,
  hiredDeliveryStatus,
  requestFetch,
  fetchFor,
  fetchReady,
  completeFetch,
  sendShortNote,
  shortNoteFor,
  noteDelivered,
  collectNote,
  nearbyReadyFetch,
  nearbyDeliveredNote,
  nearbyPlayerHire,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  errandTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  ERRAND_TYPES,
  ERRAND_RUNNER,
  GROCERY_CARRIER,
  WATER_FETCHER,
  NOTE_LAD,
  ERRAND_BEATS,
  // Tuning (tests pin the documented behavior):
  ERRAND_RADIUS,
  ERRAND_CITIZEN_COOLDOWN_MS,
  ERRAND_CHANCE,
  ERRAND_SHARE,
  RUSH_CHANCE,
  SPILL_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  FETCH_TTL_MS,
  NOTE_TTL_MS,
  WELLS,
  BASKET_GOODS,
  ERRAND_JOBS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    fetches.clear();
    shortNotes.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
