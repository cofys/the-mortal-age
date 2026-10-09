"use strict";

/**
 * CitizenSailors2 — the dockside folk: cargo dockhands, sail menders,
 * shore fishers and old salts spinning sea yarns at the community docks,
 * piers and quays.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived dockfolk types, per-day dock jobs (1-3 from date + hash),
 *   rare ship-arrival events (~8%/dock/day) seeded into CitizenRumors as
 *   the crowd moment, 7-day-TTL player ledgers for hiring hands, buying
 *   dock supplies and requesting sea yarns — exported for the LLM
 *   dialogue tier.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 server-local): scripted loading/mending/fishing emotes
 * ("*heaves a crate onto the cart*"), finished-job callouts, hire and
 * supply offers, and ship-arrival fanfare.
 *
 * No overlap (by design):
 * - CitizenSailors own the PROFESSIONAL side: captains, mates, deckhands,
 *   ships, voyages, trade routes. Professional sailors
 *   (CitizenSailors.sailorTypeFor) are EXCLUDED here.
 * - CitizenFishers2 own dockside fishing as a pastime: net casters, line
 *   anglers, crabbers and fishmongers. Dockfolk here never fish at all —
 *   the sail mender works canvas and rope, the dockhand works cargo.
 * - CitizenStorytellers own the formal gathering-place tales (activity
 *   system, universal). The old salt's yarns are dockside flavor only —
 *   short sea stories told between jobs, never the gathered crowd.
 *
 * Zero LLM: scripted line pools; the journal feeds the LLM mouth.
 *
 * Activity system (no professional exclusion chain): any commoner may work
 * the docks. Deliberately NOT in HOBBY_KEYS: visibility is throttled via
 * chance + cooldown (the couriers precedent) instead of adding another
 * hobby key. Plain-node testable: CitizenSailors2.test.js.
 *
 * Wired into the director tick right after the gemfolk block.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


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
const SailorsPro = safeRequire("./CitizenSailors");

// Real sailor data (ships in port, sea weather) with static fallbacks.
const SHIP_NAMES = ["the Swift Gull", "the Salty Wench", "the Tidecaller", "the Barnacle", "the Foamrunner", "the Grey Heron"];

// === Tuning ===
const DOCKFOLK_RADIUS = 14; // tiles — close enough to see/hear
const DOCKFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const DOCKFOLK_CHANCE = 0.15; // per eligible citizen per tick (couriers-style narrowing)
const DOCKFOLK_SHARE = 40; // ~40% nominal share of commoners
const DOCK_START_HOUR = 6; // 06:00 server-local
const DOCK_END_HOUR = 20; // 20:00 server-local
const ARRIVAL_CHANCE = 0.08; // per dock per day: a ship arrives (crowd moment)
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;

// === Dockfolk types ===
const DOCKFOLK_DOCKHAND = "dockhand";
const DOCKFOLK_MENDER = "sail-mender";
const DOCKFOLK_FISHER = "shore-fisher";
const DOCKFOLK_SALT = "old-salt";
const DOCKFOLK_TYPES = [DOCKFOLK_DOCKHAND, DOCKFOLK_MENDER, DOCKFOLK_FISHER, DOCKFOLK_SALT];
const DOCKFOLK_WEIGHTS = {
  [DOCKFOLK_DOCKHAND]: 30,
  [DOCKFOLK_MENDER]: 30,
  [DOCKFOLK_FISHER]: 25,
  [DOCKFOLK_SALT]: 15,
};

// === Community docks (kingdom-preferred) ===
const COMMUNITY_DOCKS = [
  { name: "the Port Sarim fish quay", kingdom: "misthalin" },
  { name: "the Rimmington jetty", kingdom: "misthalin" },
  { name: "the Draynor landing", kingdom: "misthalin" },
  { name: "the Mos Le'Harmless repair slip", kingdom: "asgarnia" },
  { name: "the Entrana ferry steps", kingdom: "asgarnia" },
  { name: "the Catherby beach winch", kingdom: "kandarin" },
  { name: "the Ardougne cargo quay", kingdom: "kandarin" },
  { name: "the Karamja banana jetty", kingdom: "kandarin" },
  { name: "the Fremennik longship beach", kingdom: "keldagrim" },
  { name: "the Burgh de Rott mooring posts", kingdom: "morytania" },
];

// === Jobs per type ===
const DOCK_JOBS = {
  [DOCKFOLK_DOCKHAND]: ["unload a grain barge", "load crates for Karamja", "haul rope coils to the chandlery", "stack fish boxes on the cart", "sweep the cargo quay", "mend a broken pallet"],
  [DOCKFOLK_MENDER]: ["patch a torn mainsail", "splice a frayed hawser", "tar a leaking rowboat", "stitch a fishing net", "re-caulk a jetty piling", "oil the winch gears"],
  [DOCKFOLK_FISHER]: ["hand-line off the pier end", "gather mussels at low tide", "dig lugworms for bait", "mend a hand-line", "salt the morning catch"],
  [DOCKFOLK_SALT]: ["spin a yarn for the idlers", "whittle a gull from driftwood", "tar old rope into oakum", "watch the gulls and judge the weather"],
};

// === Shore catches (hand-line only — small, for the family pot) ===
const SHORE_CATCHES = ["a silver minnow", "a fat mackerel", "a boot (again)", "a plump herring", "a tangle of seaweed", "a curious crab", "a small flounder"];

// === Sea yarns (short dockside flavor, never the gathered crowd) ===
const SEA_YARNS = [
  "I once saw a wave tall as the lighthouse at Pharos, and lived to lie about it.",
  "The captain swore the kraken owed him money. We never sailed that route again.",
  "Three weeks becalmed off Karamja. We ate the ship's cat's rations. The cat never forgave us.",
  "My grandfather sailed with a crew of ghosts. Or drunks. The distinction was thin.",
  "There's a wreck off Mos Le'Harmless full of gold, says every sailor who's never dived.",
  "I wrestled an eel for my dinner once. The eel won the first round.",
];

// === Scripted lines ===
const WORK_LINES = {
  [DOCKFOLK_DOCKHAND]: [
    "Mind your toes — this one's full of nails!",
  ],
  [DOCKFOLK_MENDER]: [
    "A sail's like a promise — keep it whole or don't make it.",
  ],
  [DOCKFOLK_FISHER]: [
    "Patience, patience — the sea pays those who wait.",
  ],
  [DOCKFOLK_SALT]: [
    "Sea's restless today. She'll blow by evening, mark me.",
  ],
};

const FINISH_LINES = [
  "Done! {job} — and no splinters this time.",
  "{job} — finished proper. The harbormaster can inspect all he likes.",
  "That's {job} ticked off. What's next, eh?",
];

const HIRE_LINES = [
  "Need an extra pair of hands on the quay? I'm for hire, reasonable rates.",
  "Strong back, weak purse — hire me for the loading and we'll both eat.",
];

const SUPPLY_LINES = [
  "Rope, tar, sailcloth, oakum — dock supplies, fair prices!",
  "Chandlery's shut? I keep a stock — rope, canvas, tar, what do you need?",
];

const YARN_LINES = [
  "Pull up a bollard, friend — I'll tell you of the wave at Pharos.",
  "You've the look of one who likes a sea story. Listen close...",
];

const ARRIVAL_LINES = [
  "Ship ho! {ship} makes harbor at {dock}!",
  "All hands — {ship} is coming in at {dock}! Clear the quay!",
];

// === Dock supplies (coin prices) ===
const SUPPLIES = [
  { name: "a coil of rope", price: 30 },
  { name: "a pot of tar", price: 25 },
  { name: "a bolt of sailcloth", price: 120 },
  { name: "a bundle of oakum", price: 15 },
  { name: "a tin of grease", price: 20 },
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
const hireLedger = new Map(); // normName -> { at }
const supplyLedger = new Map(); // normName -> { supply, at }
const yarnLedger = new Map(); // normName -> { at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [ledger] of [[hireLedger], [supplyLedger], [yarnLedger]]) {
    for (const [k, v] of ledger) {
      if (nowMs - v.at > LEDGER_TTL_MS) ledger.delete(k);
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

/** Weighted pick of a dockfolk type from a 0..99 roll. */
function dockfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of DOCKFOLK_TYPES) {
    acc += DOCKFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return DOCKFOLK_DOCKHAND;
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

/** True during dock working hours (06:00-20:00 server-local). */
function isDockHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= DOCK_START_HOUR && h < DOCK_END_HOUR;
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
// Dockfolk identity — hash-derived, stable across restarts, no storage.
// Name-first salts (the blacksmiths2 lesson): FNV-1a correlates when the
// salt is a shared prefix ("dockfolk:" / "dockfolktype:"), starving type
// buckets. Putting the name first breaks the correlation.
// ============================================================================

/**
 * The dockfolk type for a roster record, or null.
 * Excludes professional sailors (the trade owns ships and voyages).
 */
function dockfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const username = record?.username;
    const name = normalizeName(username);
    if (!name) return null;
    // No overlap: professional sailors own ships, voyages and the trade.
    try {
      if (SailorsPro && typeof SailorsPro.sailorTypeFor === "function" && SailorsPro.sailorTypeFor(username)) {
        return null;
      }
    } catch { /* pro module absent or threw — treat as non-pro */ }
    const roll = hashStr(name + "|dockfolk") % 100;
    if (roll >= DOCKFOLK_SHARE) return null;
    return dockfolkTypeFromRoll(hashStr(name + "|dockfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred community dock, stable across restarts. */
function dockFor(record) {
  const kid = record?.kingdomId;
  const local = COMMUNITY_DOCKS.filter((d) => d.kingdom === kid);
  const pool = local.length ? local : COMMUNITY_DOCKS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|dockfolk-dock") % pool.length];
}

/**
 * The day's dock jobs for a dockfolk citizen (1-3 jobs of their type).
 * Derived from date + hash; zero storage.
 */
function jobsFor(username, type, dateMs) {
  const name = normalizeName(username) || "anon";
  const pool = DOCK_JOBS[type] || DOCK_JOBS[DOCKFOLK_DOCKHAND];
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|dockfolk-jobs|" + day));
  const count = 1 + Math.floor(rng() * 3); // 1-3
  const out = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < pool.length; i++) {
    const j = pool[Math.floor(rng() * pool.length)];
    if (used.has(j)) continue;
    used.add(j);
    out.push(j);
  }
  return out;
}

/** Today's hand-line catch for a shore fisher (small, for the family pot). */
function catchFor(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|dockfolk-catch|" + day));
  return pickOne(rng, SHORE_CATCHES);
}

/**
 * Today's ship arrival at a dock (~8%/day), or null.
 * Uses the real sailors' ship names when available; the crowd moment.
 */
function arrivalFor(dock, dateMs) {
  if (!dock) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(dock.name + "|dockfolk-arrival|" + day));
  if (rng() >= ARRIVAL_CHANCE) return null;
  return pickOne(rng, SHIP_NAMES);
}

/** Sea weather flavor from the real sailors module, with a static fallback. */
function weatherFor(dateMs) {
  try {
    if (SailorsPro && typeof SailorsPro.weatherFor === "function") {
      return SailorsPro.weatherFor(dateMs);
    }
  } catch { /* fall through */ }
  const roll = hashStr("dockfolksea|" + dayNumber(dateMs)) % 100;
  if (roll < 22) return "storm";
  if (roll < 57) return "breezy";
  return "calm";
}

/** A sea yarn for an old salt — derived, so the day's yarn is stable. */
function yarnFor(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|dockfolk-yarn|" + day));
  return pickOne(rng, SEA_YARNS);
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Hire a dockhand for loading work: recorded; the LLM tier handles dialogue. */
function hireHand(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  hireLedger.set(name, { at: nowMs });
  return true;
}

/** True if the player has a recent dockhand hire. */
function handFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return hireLedger.has(name);
}

/** Buy dock supplies: recorded; the LLM tier handles dialogue. */
function buySupplies(playerName, supply, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !supply) return null;
  pruneLedgers(nowMs);
  supplyLedger.set(name, { supply: String(supply), at: nowMs });
  return supply;
}

/** The supplies a player bought, or null. */
function suppliesFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = supplyLedger.get(name);
  return rec ? rec.supply : null;
}

/** Request a sea yarn: recorded; the LLM tier handles dialogue. */
function hearTale(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  yarnLedger.set(name, { at: nowMs });
  return true;
}

/** True if the player recently requested a yarn. */
function taleFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return yarnLedger.has(name);
}

// ============================================================================
// Journal + rumor helpers.
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


// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → dockfolk? → materialized → dock hours
// → real player near → chance → work.
// ============================================================================

function tickDockfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < DOCKFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be dockfolk (hash-derived, cheap)
        const type = dockfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. Dock hours only
        if (!isDockHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, DOCKFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, DOCKFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doDockfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-dockfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-dockfolk] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  void director;
  try {
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

function doDockfolkWork(director, record, citizen, type, nowMs) {
  const dock = dockFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Ship arrival: rare, the crowd moment — once per dock per day.
  // (Crowd-moment fabrication block removed 2026-10-08: arrivalFor was hash-derived.)

  // Routine: work emote, finished-job callout, hire/supply/yarn offer.
  const roll = Math.random();
  if (roll < 0.4) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(name, `worked at ${dock.name}`);
  } else if (roll < 0.6) {
    // (catchFor/jobsFor branches removed 2026-10-08: hash-derived fabrication.
    // yarnFor kept: spinning a sea-yarn is storytelling, not a false claim.)
    if (type === DOCKFOLK_SALT) {
      const line = yarnFor(name, nowMs);
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [`"${line}"`] })); }
      journalize(name, `spun a yarn at ${dock.name}`);
    } else {
      const line = pickOne(Math.random, WORK_LINES[type]);
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(name, `kept working at ${dock.name}`);
    }
  } else if (roll < 0.8) {
    if (type === DOCKFOLK_DOCKHAND) {
      const line = pickOne(Math.random, HIRE_LINES);
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    } else if (type === DOCKFOLK_MENDER) {
      const line = pickOne(Math.random, SUPPLY_LINES);
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    } else if (type === DOCKFOLK_SALT) {
      const line = pickOne(Math.random, YARN_LINES);
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    } else {
      const line = `*baits the hook* — the sea's in a ${weatherFor(nowMs)} mood today.`;
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    }
    journalize(name, `offered services at ${dock.name}`);
  } else {
    const line = `*looks out past the breakwater* — ${weatherFor(nowMs)} seas and a fair tide.`;
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(name, `read the weather at ${dock.name}`);
  }
}

module.exports = {
  tickDockfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  dockfolkTypeOf,
  dockFor,
  jobsFor,
  catchFor,
  arrivalFor,
  weatherFor,
  yarnFor,
  hireHand,
  handFor,
  buySupplies,
  suppliesFor,
  hearTale,
  taleFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  dockfolkTypeFromRoll,
  seededRng,
  chance,
  dayNumber,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isDockHour,
  DOCKFOLK_TYPES,
  DOCKFOLK_DOCKHAND,
  DOCKFOLK_MENDER,
  DOCKFOLK_FISHER,
  DOCKFOLK_SALT,
  COMMUNITY_DOCKS,
  DOCK_JOBS,
  SHORE_CATCHES,
  SEA_YARNS,
  SUPPLIES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    hireLedger.clear();
    supplyLedger.clear();
    yarnLedger.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
