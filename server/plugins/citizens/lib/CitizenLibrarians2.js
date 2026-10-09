"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenLibrarians2 — the bookfolk: amateur reading-life folk under the
 * professional librarians. Reading-room helpers tidy the public reading
 * corners and fetch volumes for readers, pamphlet-sellers cry cheap
 * printed broadsides on the street, story-circle minders keep the
 * children's tale-circles on the corners, and book-swappers run
 * "leave-one-take-one" swap piles. Commoners who live off the informal
 * reading economy — the scrappy amateur layer under the professional
 * kingdom libraries.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived bookfolk types (~35% nominal share of commoners,
 *   post-exclusion), per-day street reading spots (kingdom-preferred,
 *   seeded per day), per-day pamphlet hawking and tale-circle keeping,
 *   per-kingdom-per-day rain-soak / bad-swap set-pieces plus a
 *   once-per-circle-per-day tale-crowd moment (journaled + rumor-seeded),
 *   and a read-only pro-library bridge that lets bookfolk small talk name
 *   the real CitizenLibrarians kingdom libraries and the real subjects
 *   their catalogs hold. Morning setup flavor before 10:00, midday
 *   work/hawking after, evening tale-circles 17:00-21:00.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-20:00 local): scripted setup flavor, re-shelving/fetching emotes,
 * pamphlet cries, story-circle verses, swap-pile banter, pro-library
 * small talk, a story minder settling the tale-circle, a swap pile getting
 * rained on, a fuming swapper returning a page-missing book, a tale-circle
 * drawing a crowd. Real cataloging, rare tomes and borrowing are LLM
 * tier — this module only tracks state, timers and the visible scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the professional librarians
 * block.
 * Plain-node testable: CitizenLibrarians2.test.js.
 *
 * No overlap (by design):
 *   - CitizenLibrarians (master) owns the PROFESSIONAL library trade:
 *     archivists (cataloguing), researchers, staff scribes, evening
 *     storytellers, the named kingdom libraries, daily collection
 *     catalogs (subject -> titles), rare-tome unveilings, and the
 *     borrowing/donation ledger. The master's claim predicate is its real
 *     claim function, isLibrarian. This exclusion is checked via the real
 *     function BEFORE the share roll — a professional librarian is never
 *     bookfolk. Bookfolk never touch the master's libraries, catalogs,
 *     rare tomes or borrowing ledger: reading-room helpers tidy public
 *     reading corners (never cataloguing, never the master shelves),
 *     swappers run unrecorded street swap piles (never loans, never the
 *     borrowed ledger), pamphlet-sellers sell printed broadsides (never
 *     manuscripts, never masterworks), story minders keep street
 *     tale-circles for children and idlers (never the evening library
 *     tales of the master storytellers).
 *   - CitizenScribes owns the FREELANCE writing trade (manuscript
 *     copyists, letter-writers, record-keepers, calligraphers) — a
 *     universal activity. Pamphlet-sellers SELL printed broadsides
 *     (commerce); they never copy manuscripts, write letters or keep
 *     records.
 *   - CitizenHawkers2 owns amateur street hawkers — excluded via the real
 *     claim function (hawkerTypeOf) BEFORE the share roll: a citizen
 *     hawking pies and boots never also hawks pamphlets.
 *   - CitizenTeachers2 owns educators and kingdom schools — story-circle
 *     minders keep informal street tale-circles (no curriculum, no
 *     teaching, no fees); minders never run a school.
 *   - CitizenScholars own published findings — bookfolk never research or
 *     publish; the master's researchers read the scholars' library.
 */

// === Tuning: all magic numbers here ===
const BOOKFOLK_RADIUS = 40; // tiles — visible work range
const CIRCLE_RADIUS = 14; // tiles — tale-circle keeping, close enough to hear
const BOOKFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const CIRCLE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // tale-circle keeping at most every 4h
const BOOKFOLK_CHANCE = 0.2; // per eligible citizen per tick
const CIRCLE_CHANCE = 0.35;
const BOOKFOLK_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const RAIN_SOAK_CHANCE = 0.06; // ~6% per kingdom per day: rain gets the swap pile
const BAD_SWAP_CHANCE = 0.07; // ~7% per kingdom per day: a fuming swapper storms back
const TALE_CROWD_CHANCE = 0.08; // ~8% per street spot per day: a tale-circle draws a crowd
const WORK_START_HOUR = 8; // 08:00 server local time (reading corners open with the libraries)
const WORK_END_HOUR = 20; // 20:00 server local time (pack before night)
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday work
const CIRCLE_START_HOUR = 17; // tale-circles gather in the evening
const CIRCLE_END_HOUR = 21;

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProLibs = safeRequire("./CitizenLibrarians"); // master: real claim fn + read-only library/subject bridge
const Hawkers2 = safeRequire("./CitizenHawkers2"); // street hawkers: real claim fn, exclusion
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Bookfolk types ===
const READING_HELPER = "reading-helper";
const PAMPHLET_SELLER = "pamphlet-seller";
const STORY_MINDER = "story-minder";
const BOOK_SWAPPER = "book-swapper";
const BOOK_TYPES = [READING_HELPER, PAMPHLET_SELLER, STORY_MINDER, BOOK_SWAPPER];
const BOOK_WEIGHTS = {
  [READING_HELPER]: 35,
  [PAMPHLET_SELLER]: 30,
  [STORY_MINDER]: 20,
  [BOOK_SWAPPER]: 15,
};

// === Street reading spots — market corners, bridge steps, tavern fringes.
// Amateur reading pitches, deliberately OFF the professional kingdom
// libraries: no grand library, no athenaeum, no hall of records, no
// archive, no scriptorium of the pro trade. ===
const READING_SPOTS = [
  { name: "the Varrock market-fringe book-swap pile", kingdom: "misthalin" },
  { name: "the Lumbridge bridge-steps tale-circle", kingdom: "misthalin" },
  { name: "the Falador east-wall reading bench", kingdom: "asgarnia" },
  { name: "the Port Sarim dock-fringe pamphlet pitch", kingdom: "asgarnia" },
  { name: "the East Ardougne market-corner swap pile", kingdom: "kandarin" },
  { name: "the Catherby jetty-steps reading corner", kingdom: "kandarin" },
  { name: "the Keldagrim south-tier reading bench", kingdom: "keldagrim" },
  { name: "the Dorgeshuun torch-wall tale-circle", kingdom: "keldagrim" },
  { name: "the Canifis fence-line swap pile", kingdom: "morytania" },
  { name: "the Mort'ton cart-corner pamphlet pitch", kingdom: "morytania" },
  { name: "the Al Kharid souk-fringe reading bench", kingdom: "kharidian" },
  { name: "the Pollnivneach well-steps tale-circle", kingdom: "kharidian" },
];

// === The pamphlets — cheap printed broadsides, deliberately nothing a
// professional library would catalog. Amateur street print: news,
// cautionary verses, recipes, gossip. ===
const PAMPHLETS = [
  "the tale of the miller who outwitted a troll",
  "seven cures for a leaky thatch",
  "the broadsheet of yesterday's market gossip",
  "a cautionary verse about pickpockets",
  "the recipe for Aunt Berta's honey cakes",
  "the ballad of the drowned sailor",
  "twelve signs your hen is a witch",
  "the penny guide to mending boots",
  "a rhyme for remembering the moon's phases",
  "the story of the mayor's lost wig",
];

// === The swap books — well-thumbed cast-offs, never rare tomes. The
// master's rare tomes are never in a street pile. ===
const SWAP_BOOKS = [
  "a dog-eared romance",
  "a water-stained sailor's almanac",
  "a cookbook missing three pages",
  "a child's picture-book of beasts",
  "a travelogue of the Feldip Jungle",
  "a book of tavern songs",
  "a farmer's almanac, last year",
  "a slim volume of love poems",
  "a jest-book with a broken spine",
  "a hymnal with the choir parts inked in",
];

// === The day's swap pick — one book off the pile, seeded per day. See
// swapBookFor() below. ===

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 10:00 the bookfolk are still setting up.
const SETUP_LINES = [
  "Books out for swapping.",
  "Setting up the reading corner.",
  "Pamphlets priced on the slate.",
  "Just stacking the swap pile.",
];

// Work lines per type.
const WORK_LINES = {
  [READING_HELPER]: [
    "Helping readers.",
    "Find a book?",
    "Reading help here.",
  ],
  [PAMPHLET_SELLER]: [
    "Pamphlets here!",
    "News sheets!",
    "Fresh pamphlets!",
  ],
  [STORY_MINDER]: [
    "Minding the tales.",
    "Stories kept.",
    "Tale-keeper here.",
  ],
  [BOOK_SWAPPER]: [
    "Swapping books.",
    "Trade a tome?",
    "Book swap open.",
  ],
};

// Pamphlet-sellers hawk the day's print.
const HAWK_LINES = [
  "Pamphlets! {pamphlet} — a copper, and worth twice!",
  "Fresh print! {pamphlet}, read aloud free, take one home for a copper!",
  "Broadsides! {pamphlet} — the talk of the street!",
  "Take a pamphlet! {pamphlet}, and mind the ink, it's fresh!",
  "A copper for the printed word! {pamphlet}, get it here!",
];

// Book-swappers call the pile.
const SWAP_LINES = [
  "Leave one, take one! The swap pile is open — {book} went to a good home today!",
  "Swap pile! Bring a book, take a book — mind the damp ones!",
  "One for one! The pile's got {book} and a dozen more!",
  "Book swap! What have you finished with? The pile takes all!",
];

// Reading-helpers fetch for readers.
const FETCH_LINES = [
  "Back in a moment — I'll fetch {subject} for you from the pile.",
  "The {subject} shelf? That's the wobbly bench, third from the left.",
  "Looking for {subject}? I shelved a fine one this morning.",
  "Mind the returns pile — I'll have {subject} for you shortly.",
];

// Story-minders keep the circle with short verses (street verses, never the
// master's evening library tales).
const CIRCLE_VERSES = [
  "“...and the clever hen hid the witch's broom, and the witch swept on a stick...”",
  "“...the little boat sailed on a puddle, and the puddle became the sea...”",
  "“...the turnip grew so big the whole street had to pull, heave-ho!...”",
  "“...and the moon hid behind the chimney, and the children counted stars...”",
];

// Small talk that names the real professional libraries (read-only bridge:
// real library names and real catalog subjects from the master module).
const PRO_TALK_LINES = [
  "The real collection? That's {library} — I only mind the street pile, friend.",
  "If you want {subject} done proper, {library} holds the true volumes. Mine's the swap pile.",
  "The librarians at {library} catalog {subject} — I just keep the corner tidy.",
  "Heard {library} has the whole {subject} shelf — my pile's the thumbed copies.",
  "Someday I'll work at {library}. Today: street books and a copper pamphlet.",
  "The pros at {library} shelve {subject} — I fetch what the readers leave behind.",
];

// Rain-soak set-piece: the swap pile gets rained on.
const RAIN_SOAK_LINES = [
  "Rain took the swap pile — the pamphlets are pulp and the bindings are curling!",
  "(a downpour and a wail) The pile's soaked — every broadside bleeding ink!",
  "The sky opened over the reading bench — books everywhere, drying in the sun!",
];

// Bad-swap set-piece: a fuming swapper storms back over a page-missing book.
const BAD_SWAP_LINES = [
  "A customer came storming back — {book} is missing its last chapter!",
  "That fuming reader? Their swapped {book} had the middle pages torn out!",
  "(a shouting match by the pile) — the {book} they took was half-chewed by mice!",
];

// Tale-crowd moment: once per spot per day, a tale-circle draws a crowd.
const TALE_CROWD_LINES = [
  "A crowd's gathering at {place} — the tale-circle's verses are carrying down the street!",
  "Half the market's at {place} — the minder's got the circle spellbound!",
  "The tale-circle at {place} has drawn a crowd — even the guards are listening!",
];

// === State: cooldown maps + once-per-day set-piece keys (pruned hourly) ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastCircleByCitizen = new Map(); // username -> timestamp
// Once-per-day set-piece keys:
//   "soak:<kid>:<day>", "badswap:<kid>:<day>", "talecrowd:<spot-index>:<day>"
const firedDayKeys = new Set();
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastCircleByCitizen) {
    if (at < cutoff) lastCircleByCitizen.delete(k);
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

/** True during bookfolk hours (08:00-20:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

/** True during tale-circle hours (17:00-21:00 server local time). */
function isCircleHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= CIRCLE_START_HOUR && h < CIRCLE_END_HOUR;
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
// Bookfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the MASTER CitizenLibrarians
 * professional trade. The master's claim predicate is its real claim
 * function, isLibrarian (username-gated, ~35% of commoners): those
 * citizens run the real libraries — archivists, researchers, staff
 * scribes, evening storytellers with the named kingdom libraries,
 * collection catalogs, rare-tome unveilings and the borrowing ledger. The
 * 2-layer owns amateur bookfolk only, so this exclusion runs BEFORE the
 * share roll. Fail-open when the master is absent: a missing master
 * cannot claim anyone. Never throws.
 */
function isProLibrarian(record) {
  try {
    if (!ProLibs || typeof ProLibs.isLibrarian !== "function") return false;
    return ProLibs.isLibrarian(record?.username) === true;
  } catch {
    return false;
  }
}

/**
 * True when CitizenHawkers2 claims this citizen — called through the
 * amateur hawkers' real claim function (hawkerTypeOf), i.e. its null
 * path, so a citizen who hawks pies and boots never also hawks
 * pamphlets. Never throws.
 */
function isHawker(record) {
  try {
    if (!Hawkers2 || typeof Hawkers2.hawkerTypeOf !== "function") return false;
    return Hawkers2.hawkerTypeOf(record) !== null;
  } catch {
    return false;
  }
}

/** Weighted pick of a bookfolk type from a 0..99 roll. */
function bookTypeFromRoll(roll) {
  let acc = 0;
  for (const t of BOOK_TYPES) {
    acc += BOOK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return READING_HELPER;
}

/**
 * The bookfolk type for a roster record, or null.
 * Excludes the professional librarians (master claim, checked via the
 * real isLibrarian) and the street hawkers (Hawkers2 claim, checked via
 * the real hawkerTypeOf). Both exclusions run BEFORE the share roll, so
 * they hold regardless of the 35% draw. Uses name-first salts to avoid
 * the FNV-1a prefix-correlation bug.
 */
function bookfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProLibrarian(record)) return null;
    if (isHawker(record)) return null;
    const roll = hashStr(name + "|librarians2") % 100;
    if (roll >= BOOKFOLK_SHARE) return null;
    return bookTypeFromRoll(hashStr(name + "|librarians2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Reading spots, pamphlets, and the read-only pro-library bridge.
// ============================================================================

/** The day's street reading spot for a bookfolk citizen: kingdom-preferred, seeded per day. */
function spotFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? READING_SPOTS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : READING_SPOTS;
    const rng = seededRng(hashStr("libspots2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, src);
  } catch {
    return READING_SPOTS[0];
  }
}

/** The day's pamphlet for a pamphlet-seller: seeded per day. */
function pamphletFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("libpamphlet2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, PAMPHLETS);
  } catch {
    return PAMPHLETS[0];
  }
}

/** The day's swap-pile highlight for a book-swapper: seeded per day. */
function swapBookFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("libswap2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, SWAP_BOOKS);
  } catch {
    return SWAP_BOOKS[0];
  }
}

/**
 * Read-only bridge to the master's REAL kingdom libraries and collection
 * subjects — bookfolk small talk stays consistent with the actual pro
 * trade. Reads only the master's real claim-adjacent helpers (libraryFor,
 * catalogFor): never touches the borrowing ledger, the rare tomes or the
 * master shelves. Fail-open (null) when the master is absent.
 */
function proLibraryTalkFor(kingdomId, username, dateMs = Date.now()) {
  try {
    if (!ProLibs) return null;
    if (typeof ProLibs.libraryFor !== "function" || typeof ProLibs.catalogFor !== "function") return null;
    const name = normalizeName(username) || "anon";
    const lib = ProLibs.libraryFor(name, kingdomId);
    const cat = ProLibs.catalogFor(name, kingdomId, dateMs);
    const subjects = cat && cat.catalog ? Object.keys(cat.catalog) : [];
    if (!lib?.name || !subjects.length) return null;
    const rng = seededRng(hashStr("libprotalk2:" + String(kingdomId ?? "") + ":" + dayNumber(dateMs)));
    const library = lib.name;
    const subject = pickOne(rng, subjects);
    return fill(pickOne(rng, PRO_TALK_LINES), { library, subject });
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
    if (je) je("librarians2", username, text);
  } catch { /* cosmetic */ }
}

function seedRumor(rng, text) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor("librarians2", text);
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
// Gate order: cooldown (cheapest) → LOD brain gate → bookfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickBookfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < BOOKFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible book life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be bookfolk (hash-derived, cheap; exclusions inside)
        const type = bookfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Work hours only (08:00-20:00 server local)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within visible range
        if (!anyRealPlayerNear(director, citizen, BOOKFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, BOOKFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doBookWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-librarians2] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: rain-soaks, bad-swaps, tale-crowds (cheap, day-gated).
    // (dailyRhythms removed 2026-10-08: hash-derived fake events.)
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-librarians2] tick failed:", e?.message ?? e);
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

function doBookWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const spot = spotFor(record, nowMs);
  const place = spot ? spot.name : "the street reading spot";
  const pamphlet = pamphletFor(name, nowMs);
  const book = swapBookFor(name, nowMs);
  const hour = new Date(nowMs).getHours();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, fill(pickOne(Math.random, SETUP_LINES), { their: "their" }));
    journalize(record.username, "Set up the reading spot at " + place + ".");
    return;
  }

  // Midday: visible work emotes, pamphlet hawking, swap calls, plus
  // pro-library small talk.
  const vars = { place, pamphlet, book, their: "their" };
  const workLines = WORK_LINES[type] ?? WORK_LINES[READING_HELPER];
  const roll = Math.random();
  let line;
  if (type === PAMPHLET_SELLER && roll < 0.5) {
    line = fill(pickOne(Math.random, HAWK_LINES), vars);
  } else if (type === BOOK_SWAPPER && roll < 0.5) {
    line = fill(pickOne(Math.random, SWAP_LINES), vars);
  } else if (type === READING_HELPER && roll < 0.4) {
    const subjects = proSubjectsFor(kid, nowMs);
    line = fill(pickOne(Math.random, FETCH_LINES), { ...vars, subject: subjects });
  } else if (roll < 0.35) {
    line = fill(pickOne(Math.random, workLines), vars);
  } else {
    line = proLibraryTalkFor(kid, name, nowMs) || fill(pickOne(Math.random, workLines), vars);
  }
  forceSay(citizen, line);
  journalize(record.username, "Worked the " + type + " trade at " + place + ".");

  // Story-minders settle the tale-circle in the evening.
  const lastC = lastCircleByCitizen.get(record.username) || 0;
  if (type === STORY_MINDER && isCircleHour(nowMs) && nowMs - lastC >= CIRCLE_COOLDOWN_MS && Math.random() < CIRCLE_CHANCE) {
    if (anyRealPlayerNear(director, citizen, CIRCLE_RADIUS)) {
      forceSay(citizen, pickOne(Math.random, CIRCLE_VERSES));
      journalize(record.username, "Kept the tale-circle at " + place + ".");
      lastCircleByCitizen.set(record.username, nowMs);
    }
  }
}

/** A real catalog subject from the master's library, for fetch lines. */
function proSubjectsFor(kingdomId, nowMs) {
  try {
    if (!ProLibs || typeof ProLibs.catalogFor !== "function") return "the old wars";
    const cat = ProLibs.catalogFor("bookfolk-fetch", kingdomId, nowMs);
    const subjects = cat && cat.catalog ? Object.keys(cat.catalog) : [];
    if (!subjects.length) return "the old wars";
    return pickOne(seededRng(hashStr("libfetch2:" + String(kingdomId ?? ""))), subjects);
  } catch {
    return "the old wars";
  }
}

/**
 * Daily set-pieces, once per kingdom/spot per day:
 *   - rain-soak: rain gets the swap pile (~6%)
 *   - bad-swap: a fuming swapper storms back over a page-missing book
 *     (~7%, rumor-seeded)
 *   - tale-crowd: a tale-circle draws a crowd (~8%)
 * Day-gated keys, cheap to evaluate. Never throws.
 */
// (function dailyRhythms removed 2026-10-08: hash-derived fake events.)

module.exports = {
  tickBookfolk,
  // Pure helpers for tests and integration:
  hashStr,
  pickOne,
  fill,
  dayNumber,
  seededRng,
  chance,
  isWorkHour,
  isCircleHour,
  isRealPlayer,
  withinTiles,
  normalizeName,
  isProLibrarian,
  isHawker,
  bookfolkTypeOf,
  bookTypeFromRoll,
  spotFor,
  pamphletFor,
  swapBookFor,
  proLibraryTalkFor,
  proSubjectsFor,
  anyRealPlayerNear,
  READING_HELPER,
  PAMPHLET_SELLER,
  STORY_MINDER,
  BOOK_SWAPPER,
  BOOK_TYPES,
  READING_SPOTS,
  PAMPHLETS,
  SWAP_BOOKS,
  SETUP_LINES,
  WORK_LINES,
  HAWK_LINES,
  SWAP_LINES,
  FETCH_LINES,
  CIRCLE_VERSES,
  PRO_TALK_LINES,
  RAIN_SOAK_LINES,
  BAD_SWAP_LINES,
  TALE_CROWD_LINES,
  // Test seams:
  _firedDayKeys: firedDayKeys,
  _resetState() {
    lastFiredByCitizen.clear();
    lastCircleByCitizen.clear();
    firedDayKeys.clear();
    lastPruneAt = 0;
    _journalEvent = null;
  },
};
