"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenEngineers2 — the engineerfolk: amateur engineering-life folk under
 * the professional engineers. Tinkers mend kettles, locks and tools on the
 * street corners, grease-monkeys run errands for the workshops (washers,
 * oil cans, lunch), rivet-hands do grunt machine repairs, and signalers
 * keep the flag/whistle patter going. Commoners who live off the informal
 * machine-and-mending economy — the scrappy amateur layer under the
 * professional kingdom machine workshops.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived engineerfolk types (~35% nominal share of commoners,
 *   post-exclusion), per-day street repair corners (kingdom-preferred,
 *   seeded per day), per-day mending cries and errand runs, per-kingdom-
 *   per-day gear-spill / whistle-gag set-pieces plus a once-per-corner-
 *   per-day fix-crowd moment (journaled + rumor-seeded), and a read-only
 *   pro-workshop bridge that lets engineerfolk small talk name the real
 *   CitizenEngineers kingdom machine workshops. Morning setup flavor
 *   before 10:00, midday mending and errands after, evening tinkering to
 *   20:00.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-20:00 local): scripted setup flavor, kettle-mending and lock-
 * picking emotes, mending cries, errand calls, rivet-hammering emotes,
 * flag-and-whistle signal gags, pro-workshop small talk, a crate of
 * spilled gears, a signaler confusing the watch with the wrong flag, a
 * tinker's mending drawing a small crowd. Real machines, devices,
 * commissions, great works and inventor breakthroughs are LLM tier —
 * this module only tracks state, timers and the visible scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the professional engineers
 * block.
 * Plain-node testable: CitizenEngineers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenEngineers (master) owns the PROFESSIONAL engineering trade:
 *     millwrights, siege engineers, aqueduct engineers and inventors with
 *     the named kingdom machine workshops, per-day device catalogs,
 *     6-9-day great works, inventor breakthroughs and the 7-day TTL
 *     commission ledger. The master's claim predicate is its real claim
 *     function, engineerTypeOf. This exclusion is checked via the real
 *     function BEFORE the share roll — a professional engineer is never
 *     engineerfolk. Engineerfolk never touch the master's workshops,
 *     devices, commissions, great works or breakthroughs: tinkers mend
 *     kettles and locks on corners (never build machines), grease-monkeys
 *     run errands TO the workshops (never work inside them), rivet-hands
 *     do grunt hand repairs (never millwright work), signalers keep
 *     flag/whistle patter (never siege signaling orders).
 *   - CitizenBlacksmiths2 owns the amateur smithfolk (village farrier,
 *     blade honer, implement tinkerer, forge apprentice) — excluded via
 *     the real claim function (smithfolkTypeOf) BEFORE the share roll:
 *     a smithfolk implement tinkerer mending tools at the village forge
 *     never also mends kettles on the street corners.
 *   - CitizenBuilders2 owns construction labor (hod carriers, mortar
 *     mixers, scaffold mates) — rivet-hands repair small machines and
 *     contraptions on corners, never buildings or scaffolds.
 *   - CitizenClockmakers2 owns amateur horologists — engineerfolk never
 *     touch timepieces; tinkers fix locks and kettles, not clocks.
 *   - CitizenArchitects2 owns amateur draftfolk — engineerfolk never
 *     draw up plans; they mend what already exists.
 */

// === Tuning: all magic numbers here ===
const FOLK_RADIUS = 40; // tiles — visible work range
const FIX_RADIUS = 14; // tiles — mending spot, close enough to hear the hammer
const FOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const FIX_COOLDOWN_MS = 4 * 60 * 60 * 1000; // mending-demos at most every 4h
const FOLK_CHANCE = 0.2; // per eligible citizen per tick
const FIX_CHANCE = 0.35;
const FOLK_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const GEAR_SPILL_CHANCE = 0.06; // ~6% per kingdom per day: a crate of gears spills
const WHISTLE_GAG_CHANCE = 0.07; // ~7% per kingdom per day: wrong flag, wrong whistle
const FIX_CROWD_CHANCE = 0.08; // ~8% per street corner per day: a mending draws a crowd
const WORK_START_HOUR = 8; // 08:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time (evening tinkering)
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday work
const FIX_START_HOUR = 17; // tinker demos gather in the evening
const FIX_END_HOUR = 20;

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProEng = safeRequire("./CitizenEngineers"); // master: real claim fn + read-only workshop bridge
const Smithfolk2 = safeRequire("./CitizenBlacksmiths2"); // village smithfolk: real claim fn, exclusion
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Engineerfolk types ===
const TINKER = "tinker"; // mends kettles, locks, tools on the corner
const GREASE_MONKEY = "grease-monkey"; // errand-runner for the workshops
const RIVET_HAND = "rivet-hand"; // grunt machine repairs
const SIGNALER = "signaler"; // flag/whistle patter
const FOLK_TYPES = [TINKER, GREASE_MONKEY, RIVET_HAND, SIGNALER];
const FOLK_WEIGHTS = {
  [TINKER]: 35,
  [GREASE_MONKEY]: 30,
  [RIVET_HAND]: 20,
  [SIGNALER]: 15,
};

// === Street repair corners — alley pitches, mill-race steps, market
// fringes. Amateur mending pitches, deliberately OFF the professional
// kingdom machine workshops: no Varrock Millworks, no Lumbridge
// Waterwheel Yard, no Falador Machine Hall, no White Knights' Siege
// Yard, no Ardougne Engine Works, no Hemenster Mill Race, no Keldagrim
// Deep Engine Hall, no Dorgesh Machine Caves, no Darkmeyer Bloodworks,
// no Al Kharid Windmill Row. ===
const CORNERS = [
  { name: "the Varrock alley mending-pitch", kingdom: "misthalin" },
  { name: "the Lumbridge mill-race steps", kingdom: "misthalin" },
  { name: "the Falador gate-approach repair corner", kingdom: "asgarnia" },
  { name: "the Port Sarim ropewalk fringe", kingdom: "asgarnia" },
  { name: "the East Ardougne market-corner oil-stall", kingdom: "kandarin" },
  { name: "the Catherby cliff-path mending nook", kingdom: "kandarin" },
  { name: "the Keldagrim south-tier gear-stall", kingdom: "keldagrim" },
  { name: "the Dorgeshuun torch-wall tinker's bench", kingdom: "keldagrim" },
  { name: "the Canifis gate-shed repair stoop", kingdom: "morytania" },
  { name: "the Mort'ton cart-corner oil-can pitch", kingdom: "morytania" },
  { name: "the Al Kharid souk-fringe mending mat", kingdom: "kharidian" },
  { name: "the Pollnivneach well-head gear bench", kingdom: "kharidian" },
];

// === The tinker's jobs — small street mends, never machine-building. ===
// (folded into the mending-call lines below)

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 10:00 the engineerfolk are still setting up.
const SETUP_LINES = [
  "Tools out, ready for mending.",
  "Setting up the workbench.",
  "Prices are on the slate.",
  "Just laying out my tools.",
];

// Work lines per type.
const WORK_LINES = {
  [TINKER]: [
    "Tinkering away.",
    "Fixing gadgets.",
    "Tinker at work.",
  ],
  [GREASE_MONKEY]: [
    "Oiling the gears.",
    "Grease monkey working.",
    "Machines maintained.",
  ],
  [RIVET_HAND]: [
    "Riveting today.",
    "Metalwork here.",
    "Rivets and steel.",
  ],
  [SIGNALER]: [
    "Signals ready.",
    "Signaling today.",
    "Flags up.",
  ],
};

// Tinkers cry their services.
const MEND_LINES = [
  "Kettles mended! {job}, done while you wait!",
  "Locks picked and mended! {job}, cheap as chips!",
  "Tinker! {job} — leave it, come back for supper!",
  "Pots patched, hinges trued! {job}, a copper!",
  "Bring your broken bits! {job}, no job too rusty!",
];

const MEND_JOBS = [
  "kettles a copper",
  "locks opened or mended",
  "handles reseated",
  "hinges trued",
  "pans re-blackened",
  "buckles fixed",
];

// Grease-monkeys call out their errands.
const ERRAND_LINES = [
  "Errands for the workshops! Carrying {cargo} — make way!",
  "{cargo} for {workshop} — mind the oil!",
  "Running {cargo} to the lads at {workshop}!",
  "Washers, oil, and lunch — {cargo} bound for {workshop}!",
];

// Signaler gags: flag-and-whistle bits (patter, never orders).
const SIGNAL_LINES = [
  "(green flag, red flag) That one means 'dinner's ready' — I think.",
  "(two short whistles, one long) That's 'the kettle's boiling'. Probably.",
  "*waves the checkered flag* That's for 'well done' — or 'stop'. One of those.",
  "(a flourish of flags) And THAT means 'mind the puddle'. Very useful code.",
];

// Read-only pro-workshop small talk: names the master's REAL kingdom
// machine workshops via the real workshopFor helper. Errands go TO the
// workshops — engineerfolk never work inside them.
const PRO_TALK_LINES = [
  "The real machines? That's {workshop} — I only run their errands, friend.",
  "Carrying oil for {workshop}. The millwrights do the true work; I mind the cogs.",
  "{workshop} builds the great engines — I mend the kettles they boil water in.",
  "The pros at {workshop} wouldn't trust me with a gearbox. Errands, friend. Errands.",
  "Someday I'll work at {workshop}. Today: washers, oil, and this corner.",
  "The lads at {workshop} sent me for lunch — their machines eat better than I do.",
];

// Tinker demos in the evening: a tricky mend, narrated.
const FIX_DEMO_LINES = [
  "“...and the hinge was bent near through — one tap HERE, and she's true as a plumb-line!”",
  "“...the kettle leaked at the seam — see? A dab of solder, and she sings!”",
  "“...the lock was jammed with rust — listen. Click. Open. That's the tinkerer's touch.”",
  "“...the handle was hanging by a prayer — rivet, peen, and she's good for ten years!”",
];

// Gear-spill set-piece: a rivet-hand spills a crate of gears.
const GEAR_SPILL_LINES = [
  "A rivet-hand tripped and spilled a whole crate of gears — they're rolling down the street!",
  "(a crash and a clatter) The gear crate went over — cogs everywhere, children chasing them!",
  "Some poor grease-monkey dropped the washer poke — washers rolling into every drain!",
];

// Whistle-gag set-piece: a signaler confuses the watch with the wrong flag.
const WHISTLE_GAG_LINES = [
  "A signaler ran up the wrong flag and half the watch turned out for a dinner that wasn't ready!",
  "(the wrong whistle code) The signaler called 'fire' instead of 'all's well' — the bucket line formed and everything!",
  "The signaller flagged 'celebration' instead of 'caution' — the market cheered for nothing!",
];

// Fix-crowd moment: once per corner per day, a tinker's mending draws a crowd.
const FIX_CROWD_LINES = [
  "A crowd's gathered at {place} — the tinker's making a kettle sing and nobody can look away!",
  "Half the market's at {place} — the rivet-hand's hammering out a rhythm!",
  "The mending-pitch at {place} has drawn a crowd — even the guards are watching the solder flow!",
];

// === State: cooldown maps + once-per-day set-piece keys (pruned hourly) ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastFixByCitizen = new Map(); // username -> timestamp
// Once-per-day set-piece keys:
//   "spill:<kid>:<day>", "gag:<kid>:<day>", "fixcrowd:<corner-index>:<day>"
const firedDayKeys = new Set();
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastFixByCitizen) {
    if (at < cutoff) lastFixByCitizen.delete(k);
  }
  // Day keys expire on their own: drop everything when the day rolls over.
  if (firedDayKeys.size > 4096) firedDayKeys.clear();
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

/** True during engineerfolk hours (08:00-20:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

/** True during tinker-demo hours (17:00-20:00 server local time). */
function isFixHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= FIX_START_HOUR && h < FIX_END_HOUR;
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
// Engineerfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the MASTER CitizenEngineers
 * professional trade. The master's claim predicate is its real claim
 * function, engineerTypeOf (millwrights, siege/aqueduct engineers,
 * inventors — ~30% of commoners, on top of its own builder/smith/
 * architect/performer exclusions): those citizens run the real machine
 * workshops — devices, commissions, great works, breakthroughs. The
 * 2-layer owns amateur engineerfolk only, so this exclusion runs BEFORE
 * the share roll. Fail-open when the master is absent: a missing master
 * cannot claim anyone. Never throws.
 */
function isProEngineer(record) {
  try {
    if (!ProEng || typeof ProEng.engineerTypeOf !== "function") return false;
    return ProEng.engineerTypeOf(record) !== null;
  } catch {
    return false;
  }
}

/**
 * True when CitizenBlacksmiths2 claims this citizen — called through the
 * amateur smithfolk's real claim function (smithfolkTypeOf), i.e. its
 * null path, so a smithfolk implement tinkerer mending tools at the
 * village forge never also mends kettles on the street corners. Never
 * throws.
 */
function isSmithfolk(record) {
  try {
    if (!Smithfolk2 || typeof Smithfolk2.smithfolkTypeOf !== "function") return false;
    return Smithfolk2.smithfolkTypeOf(record) !== null;
  } catch {
    return false;
  }
}

/** Weighted pick of an engineerfolk type from a 0..99 roll. */
function folkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FOLK_TYPES) {
    acc += FOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return TINKER;
}

/**
 * The engineerfolk type for a roster record, or null.
 * Excludes the professional engineers (master claim, checked via the
 * real engineerTypeOf) and the amateur smithfolk (Blacksmiths2 claim,
 * checked via the real smithfolkTypeOf). Both exclusions run BEFORE the
 * share roll, so they hold regardless of the 35% draw. Uses name-first
 * salts to avoid the FNV-1a prefix-correlation bug. The master claim
 * check gets the record as-is: its own normalizeName applies inside, so
 * the exclusion is exact by construction.
 */
function engineerfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProEngineer(record)) return null;
    if (isSmithfolk(record)) return null;
    const roll = hashStr(name + "|engineers2") % 100;
    if (roll >= FOLK_SHARE) return null;
    return folkTypeFromRoll(hashStr(name + "|engineers2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Repair corners and the read-only pro-workshop bridge.
// ============================================================================

/** The day's street repair corner for an engineerfolk citizen: kingdom-preferred, seeded per day. */
function cornerFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? CORNERS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : CORNERS;
    const rng = seededRng(hashStr("engcorners2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, src);
  } catch {
    return CORNERS[0];
  }
}

/** The day's errand cargo for a grease-monkey: seeded per day. */
function cargoFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("engcargo2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, ERRAND_CARGO);
  } catch {
    return ERRAND_CARGO[0];
  }
}

const ERRAND_CARGO = [
  "a poke of washers",
  "a can of oil",
  "a lunch parcel",
  "a coil of wire",
  "a bundle of rags",
  "a box of spare bolts",
];

/** The day's mending cry job for a tinker: seeded per day. */
function mendJobFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("engmend2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, MEND_JOBS);
  } catch {
    return MEND_JOBS[0];
  }
}

/**
 * Read-only bridge to the master's REAL kingdom machine workshops —
 * engineerfolk small talk and errand calls stay consistent with the
 * actual pro trade. Reads only the master's real workshop helper
 * (workshopFor): never touches the device catalogs, the commission
 * ledger, the great works or the breakthroughs. Fail-open (null) when
 * the master is absent.
 */
function proWorkshopFor(record) {
  try {
    if (!ProEng || typeof ProEng.workshopFor !== "function") return null;
    const w = ProEng.workshopFor(record);
    return w && w.name ? w.name : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Journal + rumors (never throw).
// ============================================================================

let _journalEvent = null;
function journalEvent() {
  if (!_journalEvent) {
    try {
      _journalEvent = Journal && Journal.journalEvent ? Journal.journalEvent : null;
    } catch {
      _journalEvent = null;
    }
  }
  return _journalEvent;
}

function journalize(username, text) {
  try {
    const je = journalEvent();
    if (je) je("engineers2", username, text);
  } catch { /* cosmetic */ }
}

function seedRumor(rng, text) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor("engineers2", text);
  } catch { /* cosmetic */ }
}

/** Say a line in chat (never throws). */
function forceSay(citizen, text) {
  try {
    if (citizen?.forceChat) { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
    else if (citizen?.say) citizen.say(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → engineerfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickEngineerfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < FOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible folk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be engineerfolk (hash-derived, cheap; exclusions inside)
        const type = engineerfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. Work hours only (08:00-20:00 server local)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within visible range
        if (!anyRealPlayerNear(director, citizen, FOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, FOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doFolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-engineers2] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: gear-spills, whistle-gags, fix-crowds (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-engineers2] tick failed:", e?.message ?? e);
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

function doFolkWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const corner = cornerFor(record, nowMs);
  const place = corner ? corner.name : "the street repair corner";
  const cargo = cargoFor(name, nowMs);
  const job = mendJobFor(name, nowMs);
  const workshop = proWorkshopFor(record) || "the machine workshop";
  const hour = new Date(nowMs).getHours();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, fill(pickOne(Math.random, SETUP_LINES), { their: "their" }));
    journalize(record.username, "Set up the mending pitch at " + place + ".");
    return;
  }

  // Midday: visible work emotes, mending cries, errand calls, signal gags,
  // plus pro-workshop small talk.
  const vars = { place, cargo, job, workshop, their: "their" };
  const workLines = WORK_LINES[type] ?? WORK_LINES[TINKER];
  const roll = Math.random();
  let line;
  if (type === TINKER && roll < 0.5) {
    line = fill(pickOne(Math.random, MEND_LINES), vars);
  } else if (type === GREASE_MONKEY && roll < 0.5) {
    line = fill(pickOne(Math.random, ERRAND_LINES), vars);
  } else if (type === SIGNALER && roll < 0.5) {
    line = pickOne(Math.random, SIGNAL_LINES);
  } else if (roll < 0.35) {
    line = fill(pickOne(Math.random, workLines), vars);
  } else {
    const talk = fill(pickOne(Math.random, PRO_TALK_LINES), vars);
    line = talk.includes("{") ? fill(pickOne(Math.random, workLines), vars) : talk;
  }
  forceSay(citizen, line);
  journalize(record.username, "Worked the " + type + " trade at " + place + ".");

  // Tinker evening demos: a tricky mend, narrated to the corner.
  const lastF = lastFixByCitizen.get(record.username) || 0;
  if (type === TINKER && isFixHour(nowMs) && nowMs - lastF >= FIX_COOLDOWN_MS && Math.random() < FIX_CHANCE) {
    if (anyRealPlayerNear(director, citizen, FIX_RADIUS)) {
      forceSay(citizen, pickOne(Math.random, FIX_DEMO_LINES));
      journalize(record.username, "Narrated a tinker demo at " + place + ".");
      lastFixByCitizen.set(record.username, nowMs);
    }
  }
}

/**
 * Daily set-pieces, once per kingdom/corner per day:
 *   - gear-spill: a crate of gears goes everywhere (~6%)
 *   - whistle-gag: a signaler confuses the watch with the wrong flag
 *     (~7%, rumor-seeded)
 *   - fix-crowd: a tinker's mending draws a crowd (~8%)
 * Day-gated keys, cheap to evaluate. Never throws.
 */
function dailyRhythms(director, nowMs) {
  try {
    const day = dayNumber(nowMs);
    const rng = seededRng(hashStr("engineerfolk-day:" + day));
    const online = typeof director.onlinePlayers === "function" ? director.onlinePlayers() : [];
    const realNearSpot = online.some((p) => isRealPlayer(p));
    if (!realNearSpot) return; // no audience — skip the whole street scene
    const kids = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];

    for (const kid of kids) {
      const spillKey = "spill:" + kid + ":" + day;
      if (!firedDayKeys.has(spillKey) && rng() < GEAR_SPILL_CHANCE) {
        firedDayKeys.add(spillKey);
        const event = pickOne(rng, GEAR_SPILL_LINES);
        journalize("engineerfolk-" + kid, event + " (" + kid + " corner)");
        seedRumor(rng, event);
      }
      const gagKey = "gag:" + kid + ":" + day;
      if (!firedDayKeys.has(gagKey) && rng() < WHISTLE_GAG_CHANCE) {
        firedDayKeys.add(gagKey);
        const event = pickOne(rng, WHISTLE_GAG_LINES);
        journalize("engineerfolk-" + kid, event);
        seedRumor(rng, event);
      }
    }

    for (let i = 0; i < CORNERS.length; i++) {
      const key = "fixcrowd:" + i + ":" + day;
      if (firedDayKeys.has(key) || rng() >= FIX_CROWD_CHANCE) continue;
      firedDayKeys.add(key);
      const corner = CORNERS[i];
      journalize(
        "engineerfolk-" + corner.kingdom,
        fill(pickOne(rng, FIX_CROWD_LINES), { place: corner.name })
      );
    }
  } catch {
    // set-pieces are cosmetic
  }
}

module.exports = {
  tickEngineerfolk,
  // Pure helpers for tests and integration:
  hashStr,
  pickOne,
  fill,
  dayNumber,
  seededRng,
  chance,
  isWorkHour,
  isFixHour,
  isRealPlayer,
  withinTiles,
  normalizeName,
  isProEngineer,
  isSmithfolk,
  engineerfolkTypeOf,
  folkTypeFromRoll,
  cornerFor,
  cargoFor,
  mendJobFor,
  proWorkshopFor,
  anyRealPlayerNear,
  TINKER,
  GREASE_MONKEY,
  RIVET_HAND,
  SIGNALER,
  FOLK_TYPES,
  ERRAND_CARGO,
  MEND_JOBS,
  CORNERS,
  SETUP_LINES,
  WORK_LINES,
  MEND_LINES,
  ERRAND_LINES,
  SIGNAL_LINES,
  PRO_TALK_LINES,
  FIX_DEMO_LINES,
  GEAR_SPILL_LINES,
  WHISTLE_GAG_LINES,
  FIX_CROWD_LINES,
  // Test seams:
  _firedDayKeys: firedDayKeys,
  _resetState() {
    lastFiredByCitizen.clear();
    lastFixByCitizen.clear();
    firedDayKeys.clear();
    lastPruneAt = 0;
    _journalEvent = null;
  },
};
