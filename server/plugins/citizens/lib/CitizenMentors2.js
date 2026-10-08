"use strict";

/**
 * CitizenMentors2 — the mentorfolk: the apprenticeship-and-morals street
 * layer under the professional masters. Guild apprentice recruiters hawk
 * indenture contracts to street lads, journeyman taskmasters set and
 * inspect apprentice day-chores, soapbox preachers scold the town's vices
 * (secular moralizers, never clergy), and oath-wardens keep the apprentice
 * oath book at the market crosses. Commoners who live off the informal
 * apprenticeship economy — the scrappy amateur layer under the real
 * master-apprentice trade system.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived mentorfolk types (~35% nominal share of commoners,
 *   post-exclusion), per-day street hiring pitches (kingdom-preferred,
 *   seeded per day), per-day recruitment targets, chore lists and vices,
 *   per-kingdom-per-day oath-ceremony / taskmaster-scene / soapbox-crowd
 *   / signing-haul set-pieces (journaled + rumor-seeded), and oath-warden
 *   evening oath recitals. Morning setup flavor before 10:00, midday
 *   pitches and chore-setting after, oath recitals to 20:00.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-20:00 local): scripted setup flavor, recruiter pitches,
 * taskmaster chore calls, soapbox moralizing, oath-book tending, a lad
 * swearing the apprentice oath at the market cross, a taskmaster catching
 * a skiving lad, a soapbox preacher drawing a heckling crowd, a recruiter
 * signing three lads in a day. Real master lessons, mentorship bonds,
 * apprentice XP and trade instruction are master/educator tier — this
 * module only tracks state, timers and the visible scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the educators block.
 * Plain-node testable: CitizenMentors2.test.js.
 *
 * No overlap (by design):
 *   - CitizenMentors (master) owns the PROFESSIONAL mentor trade: masters
 *     (level 60+ in a trade skill) give reactive level-up lessons, found
 *     mentorship bonds, and trade tips. CitizenMentors exports no claim
 *     predicate itself — its real, exported master-claim function is
 *     CitizenApprentices.eligibleMaster(record, masterNames,
 *     apprenticeNames), the same predicate the pair-formation tick uses
 *     to draft masters. This module wires that ACTUAL function via
 *     isProMentor BEFORE the share roll — no invented criterion. A
 *     claimed master is never mentorfolk. Mentorfolk never found
 *     mentorship bonds, never give skill tips, never claim master-titles:
 *     recruiters hawk contracts (never instruct), taskmasters set chores
 *     (never give trade lessons), soapbox preachers scold morals (never
 *     teach skills), oath-wardens witness oaths (never grade).
 *   - CitizenApprentices owns real master-apprentice pairs: level-60
 *     masters paired with low-skill apprentices gaining real XP via
 *     skillStore with follow bonds. The same 60+ exclusion covers it —
 *     mentorfolk never pair, never grant XP, never follow-bind.
 *   - CitizenTeachers2 owns the "2"-layer educators ("tutor", "mentor",
 *     "schoolmaster", "scholar" at 100% share): real lessons — slate
 *     literacy, trade instruction ("measure twice, cut once"), school
 *     venues, graduations. Mentorfolk never teach. The line is crisp:
 *     educators instruct, mentorfolk run the apprenticeship street
 *     economy around them. (Deliberately NOT included as folk types:
 *     hedge-school tutors, literacy corner-readers, craft-instruction
 *     journeymen, mother-hen advice elders, war-story elders — those are
 *     educator/retirement/storyteller turf.)
 *   - CitizenPriests owns professional clergy (high-priest, chaplain,
 *     monk, oracle): temple work, blessings, prophecy. Soapbox preachers
 *     never bless, never hold rites, never prophesy, never take offering
 *     coins — secular vice-scolding only.
 *   - CitizenGuards2 (militia) owns citizen drill practice and levy
 *     muster rosters — there is no drill-sergeant folk type by design;
 *     taskmasters run apprentice chore yards, never drills or musters.
 *   - CitizenRetirement owns elders (60+) telling kingdom-history stories
 *     and giving wisdom; CitizenStorytellers owns oral tales;
 *     CitizenBards2 owns songs. Oath-wardens recite oaths, never tales,
 *     songs or elder wisdom.
 *   - CitizenNewspaper owns the town criers shouting weekly news.
 *     Recruiters hawk apprenticeship contracts, never news or
 *     proclamations.
 *   - CitizenHawkers2 owns amateur hawkers selling goods and wares.
 *     Recruiters hawk apprenticeship contracts into trades, never goods.
 *   - No other "2" module claims this concept: smithfolk mend, engineerfolk
 *     tinker, bookfolk shelve, draftfolk draw, mapfolk map, moneyfolk
 *     count coin, songfolk sing, brewfolk brew, marketstallfolk stall,
 *     fisherfolk fish, minerfolk mine, watchmen patrol, healers2 care.
 */

// === Tuning: all magic numbers here ===
const FOLK_RADIUS = 40; // tiles — visible work range
const OATH_RADIUS = 14; // tiles — oath recital, close enough to hear the book
const FOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const OATH_COOLDOWN_MS = 4 * 60 * 60 * 1000; // oath recitals at most every 4h
const FOLK_CHANCE = 0.2; // per eligible citizen per tick
const OATH_CHANCE = 0.35;
const FOLK_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const OATH_CEREMONY_CHANCE = 0.08; // ~8% per kingdom per day: a lad swears the oath
const TASKMASTER_SCENE_CHANCE = 0.06; // ~6% per kingdom per day: a skiver is caught
const SOAPBOX_CROWD_CHANCE = 0.07; // ~7% per kingdom per day: heckling crowd
const SIGNING_HAUL_CHANCE = 0.06; // ~6% per kingdom per day: three lads signed
const WORK_START_HOUR = 8; // 08:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time (oath recitals to close)
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday work
const OATH_START_HOUR = 17; // oath-warden recitals gather in the evening
const OATH_END_HOUR = 20;

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProMentors = safeRequire("./CitizenMentors"); // master: the real MASTER_LEVEL export (60)
const Apprentices = safeRequire("./CitizenApprentices"); // master tier: the REAL master-claim predicate (eligibleMaster)
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Mentorfolk types ===
const RECRUITER = "recruiter"; // guild apprentice recruiters: hawk indenture contracts
const TASKMASTER = "taskmaster"; // journeyman chore-setters: day-chores, inspections
const SOAPBOX = "soapbox"; // moralizing street preachers: vice-scolding, never clergy
const OATH_WARDEN = "oath-warden"; // keep the apprentice oath book at the market crosses
const FOLK_TYPES = [RECRUITER, TASKMASTER, SOAPBOX, OATH_WARDEN];
const FOLK_WEIGHTS = {
  [RECRUITER]: 35,
  [TASKMASTER]: 30,
  [SOAPBOX]: 20,
  [OATH_WARDEN]: 15,
};

// === Street hiring pitches — market crosses, guild yards, hiring corners.
// Apprenticeship street pitches, deliberately OFF any professional
// school, academy, temple or master workshop ground: no kingdom schools,
// no temples, no machine workshops, no libraries. ===
const PITCHES = [
  { name: "the Varrock market-cross pitch", kingdom: "misthalin" },
  { name: "the Lumbridge guild-yard corner", kingdom: "misthalin" },
  { name: "the Falador trade-board steps", kingdom: "asgarnia" },
  { name: "the Port Sarim hiring quay", kingdom: "asgarnia" },
  { name: "the East Ardougne market-corner pitch", kingdom: "kandarin" },
  { name: "the Catherby cliff-path hiring bench", kingdom: "kandarin" },
  { name: "the Keldagrim consortium steps", kingdom: "keldagrim" },
  { name: "the Dorgeshuun torch-wall corner", kingdom: "keldagrim" },
  { name: "the Canifis gate-shed corner", kingdom: "morytania" },
  { name: "the Mort'ton cart-corner pitch", kingdom: "morytania" },
  { name: "the Al Kharid souk-fringe hiring mat", kingdom: "kharidian" },
  { name: "the Pollnivneach well-head steps", kingdom: "kharidian" },
];

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 10:00 the mentorfolk are still setting up.
const SETUP_LINES = [
  "*pins the guild hiring board to the post*",
  "*chalks the day's apprenticeship terms on a slate*",
  "*unrolls the oath book and finds the page*",
  "*sweeps the pitch clear of yesterday's straw*",
  "*counts the blank indenture forms, twice*",
  "*props the soapbox on its sturdy side*",
];

// Work lines per type.
const WORK_LINES = {
  [RECRUITER]: [
    "*waves an indenture form at a passing lad*",
    "*thumps the hiring board for attention*",
    "*reads the contract terms aloud, slowly*",
    "*dabs the guild seal in wax, ready*",
    "*counts the day's signed forms, grinning*",
  ],
  [TASKMASTER]: [
    "*inspects a lad's sweeping with a frown*",
    "*counts nails into a tin, one by one*",
    "*runs a thumb along a polished hinge*",
    "*taps the chore slate with a stick*",
    "*checks the water buckets are full*",
  ],
  [SOAPBOX]: [
    "*climbs onto the soapbox, clears {their} throat*",
    "*shakes a fist at a passing drunk*",
    "*wags a finger at the dice players*",
    "*unfurls a scroll of homely proverbs*",
    "*points sternly at a yawning apprentice*",
  ],
  [OATH_WARDEN]: [
    "*polishes the oath book's brass clasp*",
    "*dips a quill for the signing*",
    "*smooths the oath page flat*",
    "*reads a past oath under {their} breath*",
    "*blots a fresh signature carefully*",
  ],
};

// Recruiters cry their contracts.
const PITCH_LINES = [
  "Seven years and a trade for life! {trade} apprentices — sign here, lads!",
  "The {trade} need strong backs and honest hands! Who's for an indenture?",
  "Learn a trade, earn a wage! {trade} apprenticeships — terms on the board!",
  "Your mother wants you out of the house, lad? The {trade} will take you!",
  "Sign with the {trade} and eat every day! Indentures here!",
];

const RECRUIT_TRADES = [
  "the woodcutters' guild",
  "the fishers' guild",
  "the miners' guild",
  "the cooks' guild",
  "the masons' lodge",
  "the weavers' hall",
];

// Taskmasters set the day's chores.
const CHORE_LINES = [
  "You! Lad! {chore} — and do it properly this time!",
  "Apprentices! Today's list: {chore}, then {chore2}!",
  "{chore}, lad. If I find a speck of dust, we start again!",
  "Skivers get the latrines. Workers get {chore} — choose wisely!",
];

const DAY_CHORES = [
  "sweep the guild yard",
  "count the nail barrels",
  "polish the brass fittings",
  "fetch water for the mortar",
  "stack the firewood",
  "muck out the stable",
  "oil the door hinges",
  "beat the dust from the rugs",
];

// Soapbox preachers scold the town's vices.
const MORAL_LINES = [
  "Repent, I say! {vice} will be the ruin of this town!",
  "The young waste their days on {vice} while honest folk work!",
  "I have seen good men destroyed by {vice} — mark my words!",
  "{vice}, {vice}! The town drowns in it and calls it pleasure!",
  "A lad with {vice} on his breath has no business calling himself honest!",
];

const DAY_VICES = [
  "strong drink before noon",
  "dicing away a week's wages",
  "idleness at the market fountain",
  "cheating at stones",
  "late nights and later mornings",
  "gossiping instead of working",
];

// Oath-wardens recite oath bits (never tales, never songs).
const OATH_LINES = [
  "“...by hammer and by hearth, by honest measure — the apprentice's oath!”",
  "“...seven years' service, true and faithful — sign the book, lad!”",
  "“...neither waste nor wanton, neither skive nor steal — so swear the lads!”",
  "“...the guild feeds you, the guild clothes you — and the guild owns your mornings!”",
];

// The honest read-only bridge to the professional masters: mentorfolk
// small talk names the master's REAL master criterion (level sixty in a
// trade skill). The teaching is the masters' — mentorfolk do contracts,
// chores, morals and oaths.
const MASTER_TALK_LINES = [
  "The {trade} masters do the teaching — sixty levels in the trade, mind you. I only sign the contracts.",
  "Sixty levels in the trade, that's what makes a master. Me? I'm the one with the forms.",
  "The teaching's for the masters of {trade} — sixty levels or nothing. The contracts are mine, friend.",
  "A master of {trade} has sixty levels and the patience of stone. I have a quill and a loud voice.",
  "Don't ask me to teach the trade — ask a master of {trade}, sixty levels strong. I sign, they know.",
];

// Oath-warden evening recitals: a past oath, narrated to the pitch.
const OATH_RECITAL_LINES = [
  "“...and young Tam signed the book with a shaking hand — seven years later he keeps the guildhall keys!”",
  "“...the oath was sworn in the rain, and the ink ran — but the lad kept every word of it!”",
  "“...three brothers signed on one page, and all three made master — the book remembers!”",
  "“...she couldn't spell her name, so she made her mark — and that mark now seals the guild's letters!”",
];

// Oath-ceremony set-piece: a lad swears the apprentice oath at the cross.
const OATH_CEREMONY_LINES = [
  "At {place}, a lad has sworn the apprentice's oath before the guild — the oath book has a new name!",
  "(a cheer at {place}) The oath is sworn — another lad bound to the {trade} for seven years!",
  "The oath-warden's quill scratched at {place} — a new apprentice signed, sealed and sworn!",
];

// Taskmaster-scene set-piece: a skiving lad is caught.
const TASKMASTER_SCENE_LINES = [
  "The taskmaster caught a lad skiving at {place} — the whole pitch heard about it!",
  "(a bollocking at {place}) The taskmaster found dust on the swept yard — the lad is sweeping it again!",
  "A taskmaster's stick tapped a dozing apprentice at {place} — the chores continue apace!",
];

// Soapbox-crowd set-piece: a heckling crowd gathers.
const SOAPBOX_CROWD_LINES = [
  "A heckling crowd has gathered at {place} — the soapbox preacher is giving as good as they get!",
  "The soapbox at {place} has drawn a crowd — half cheer the preacher, half cheer the hecklers!",
  "(roars of laughter at {place}) The soapbox preacher called the dice-men sinners — the dice-men called him worse!",
];

// Signing-haul set-piece: a recruiter signs three lads in a day.
const SIGNING_HAUL_LINES = [
  "The recruiter at {place} has signed three lads to the {trade} in a single day!",
  "Three indentures in one day at {place} — the {trade} will eat well this winter!",
  "The hiring board at {place} is bare of forms — the recruiter signed every last lad!",
];

// === State: cooldown maps + once-per-day set-piece keys (pruned hourly) ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastOathByCitizen = new Map(); // username -> timestamp
// Once-per-day set-piece keys:
//   "oath:<kid>:<day>", "scene:<kid>:<day>", "crowd:<kid>:<day>", "haul:<kid>:<day>"
const firedDayKeys = new Set();
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastOathByCitizen) {
    if (at < cutoff) lastOathByCitizen.delete(k);
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

/** True during mentorfolk hours (08:00-20:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

/** True during oath-recital hours (17:00-20:00 server local time). */
function isOathHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= OATH_START_HOUR && h < OATH_END_HOUR;
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
// Mentorfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/** The master's professional-master level (level 60 in a trade skill). */
function masterLevel() {
  try {
    if (ProMentors && typeof ProMentors.MASTER_LEVEL === "number") return ProMentors.MASTER_LEVEL;
  } catch { /* fall through */ }
  return 60;
}

// Module-level empty sets for the real claim call — eligibleMaster only
// reads them (never mutates), so sharing one instance is safe.
const EMPTY_MASTER_NAMES = new Set();
const EMPTY_APPRENTICE_NAMES = new Set();

/**
 * True when this citizen is claimed by the professional master tier
 * (CitizenMentors / CitizenApprentices). CitizenMentors itself exports no
 * claim predicate — its real, exported master-claim function is
 * CitizenApprentices.eligibleMaster(record, masterNames, apprenticeNames),
 * the same predicate the pair-formation tick uses to draft masters:
 * working-role citizen with level >= MASTER_LEVEL (60) in a trade skill,
 * checked through the real skill store. We wire that actual function —
 * no re-invented criterion. Claimed masters give reactive level-up
 * lessons and take on real apprentices — devices of the master layer.
 * The 2-layer owns amateur mentorfolk only, so this exclusion runs
 * BEFORE the share roll. Fail-open when the master tier module is
 * absent: a missing master cannot claim anyone. Never throws.
 */
function isProMentor(record) {
  try {
    if (!Apprentices || typeof Apprentices.eligibleMaster !== "function") return false;
    const claimed = Apprentices.eligibleMaster(record, EMPTY_MASTER_NAMES, EMPTY_APPRENTICE_NAMES);
    return claimed !== null && claimed !== undefined;
  } catch {
    return false;
  }
}

/** Weighted pick of a mentorfolk type from a 0..99 roll. */
function folkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FOLK_TYPES) {
    acc += FOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return RECRUITER;
}

/**
 * The mentorfolk type for a roster record, or null.
 * Excludes professional masters via the master tier's REAL exported
 * claim predicate (CitizenApprentices.eligibleMaster, the same function
 * the pair-formation tick drafts masters with) BEFORE the share roll, so
 * it holds regardless of the 35% draw. Uses name-first salts to avoid
 * the FNV-1a prefix-correlation bug.
 */
function mentorfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProMentor(record)) return null;
    const roll = hashStr(name + "|mentors2") % 100;
    if (roll >= FOLK_SHARE) return null;
    return folkTypeFromRoll(hashStr(name + "|mentors2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Hiring pitches and per-day seeded assignments.
// ============================================================================

/** The day's street hiring pitch for a mentorfolk citizen: kingdom-preferred, seeded per day. */
function pitchFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? PITCHES.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : PITCHES;
    const rng = seededRng(hashStr("mentorpitches2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, src);
  } catch {
    return PITCHES[0];
  }
}

/** The day's recruitment target trade for a recruiter: seeded per day. */
function tradeFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("mentortrade2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, RECRUIT_TRADES);
  } catch {
    return RECRUIT_TRADES[0];
  }
}

/** The day's chore pair for a taskmaster: seeded per day. */
function choresFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("mentorchores2:" + name + ":" + dayNumber(dateMs)));
    const first = pickOne(rng, DAY_CHORES);
    let second = pickOne(rng, DAY_CHORES);
    if (second === first) second = DAY_CHORES[(DAY_CHORES.indexOf(first) + 1) % DAY_CHORES.length];
    return { chore: first, chore2: second };
  } catch {
    return { chore: DAY_CHORES[0], chore2: DAY_CHORES[1] };
  }
}

/** The day's scolded vice for a soapbox preacher: seeded per day. */
function viceFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("mentorvice2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, DAY_VICES);
  } catch {
    return DAY_VICES[0];
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
    if (je) je("mentors2", username, text);
  } catch { /* cosmetic */ }
}

function seedRumor(rng, text) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor("mentors2", text);
  } catch { /* cosmetic */ }
}

/** Say a line in chat (never throws). */
function forceSay(citizen, text) {
  try {
    if (citizen?.forceChat) citizen.forceChat(String(text).slice(0, 120));
    else if (citizen?.say) citizen.say(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → mentorfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickMentorfolk(director, nowMs, desync) {
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

        // 3. Must be mentorfolk (hash-derived, cheap; exclusions inside)
        const type = mentorfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
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
        console.warn("[citizen-mentors2] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: oath ceremonies, taskmaster scenes, soapbox crowds,
    // signing hauls (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-mentors2] tick failed:", e?.message ?? e);
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

function doFolkWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const pitch = pitchFor(record, nowMs);
  const place = pitch ? pitch.name : "the street hiring pitch";
  const trade = tradeFor(name, nowMs);
  const { chore, chore2 } = choresFor(name, nowMs);
  const vice = viceFor(name, nowMs);
  const hour = new Date(nowMs).getHours();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, fill(pickOne(Math.random, SETUP_LINES), { their: "their" }));
    journalize(record.username, "Set up the hiring pitch at " + place + ".");
    return;
  }

  // Midday: recruitment pitches, chore calls, moralizing, oath-book
  // tending, plus the honest master small talk.
  const vars = { place, trade, chore, chore2, vice, their: "their" };
  const workLines = WORK_LINES[type] ?? WORK_LINES[RECRUITER];
  const roll = Math.random();
  let line;
  if (type === RECRUITER && roll < 0.5) {
    line = fill(pickOne(Math.random, PITCH_LINES), vars);
  } else if (type === TASKMASTER && roll < 0.5) {
    line = fill(pickOne(Math.random, CHORE_LINES), vars);
  } else if (type === SOAPBOX && roll < 0.5) {
    line = fill(pickOne(Math.random, MORAL_LINES), vars);
  } else if (type === OATH_WARDEN && roll < 0.5) {
    line = pickOne(Math.random, OATH_LINES);
  } else if (roll < 0.35) {
    line = fill(pickOne(Math.random, workLines), vars);
  } else {
    const talk = fill(pickOne(Math.random, MASTER_TALK_LINES), vars);
    line = talk.includes("{") ? fill(pickOne(Math.random, workLines), vars) : talk;
  }
  forceSay(citizen, line);
  journalize(record.username, "Worked the " + type + " trade at " + place + ".");

  // Oath-warden evening recitals: a past oath, narrated to the pitch.
  const lastO = lastOathByCitizen.get(record.username) || 0;
  if (type === OATH_WARDEN && isOathHour(nowMs) && nowMs - lastO >= OATH_COOLDOWN_MS && Math.random() < OATH_CHANCE) {
    if (anyRealPlayerNear(director, citizen, OATH_RADIUS)) {
      forceSay(citizen, pickOne(Math.random, OATH_RECITAL_LINES));
      journalize(record.username, "Narrated an oath recital at " + place + ".");
      lastOathByCitizen.set(record.username, nowMs);
    }
  }
}

/**
 * Daily set-pieces, once per kingdom per day:
 *   - oath-ceremony: a lad swears the apprentice oath (~8%, rumor-seeded)
 *   - taskmaster-scene: a skiving lad is caught (~6%)
 *   - soapbox-crowd: a heckling crowd gathers (~7%, rumor-seeded)
 *   - signing-haul: three lads signed in a day (~6%)
 * Day-gated keys, cheap to evaluate. Never throws.
 */
function dailyRhythms(director, nowMs) {
  try {
    const day = dayNumber(nowMs);
    const rng = seededRng(hashStr("mentorfolk-day:" + day));
    const online = typeof director.onlinePlayers === "function" ? director.onlinePlayers() : [];
    const realNearSpot = online.some((p) => isRealPlayer(p));
    if (!realNearSpot) return; // no audience — skip the whole street scene
    const kids = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
    const trade = pickOne(rng, RECRUIT_TRADES);

    for (const kid of kids) {
      const oathKey = "oath:" + kid + ":" + day;
      if (!firedDayKeys.has(oathKey) && rng() < OATH_CEREMONY_CHANCE) {
        firedDayKeys.add(oathKey);
        const event = fill(pickOne(rng, OATH_CEREMONY_LINES), { place: "the market cross", trade });
        journalize("mentorfolk-" + kid, event + " (" + kid + " pitch)");
        seedRumor(rng, event);
      }
      const sceneKey = "scene:" + kid + ":" + day;
      if (!firedDayKeys.has(sceneKey) && rng() < TASKMASTER_SCENE_CHANCE) {
        firedDayKeys.add(sceneKey);
        const event = fill(pickOne(rng, TASKMASTER_SCENE_LINES), { place: "the guild yard" });
        journalize("mentorfolk-" + kid, event);
      }
      const crowdKey = "crowd:" + kid + ":" + day;
      if (!firedDayKeys.has(crowdKey) && rng() < SOAPBOX_CROWD_CHANCE) {
        firedDayKeys.add(crowdKey);
        const event = fill(pickOne(rng, SOAPBOX_CROWD_LINES), { place: "the soapbox corner" });
        journalize("mentorfolk-" + kid, event);
        seedRumor(rng, event);
      }
      const haulKey = "haul:" + kid + ":" + day;
      if (!firedDayKeys.has(haulKey) && rng() < SIGNING_HAUL_CHANCE) {
        firedDayKeys.add(haulKey);
        const event = fill(pickOne(rng, SIGNING_HAUL_LINES), { place: "the hiring pitch", trade });
        journalize("mentorfolk-" + kid, event);
      }
    }
  } catch {
    // set-pieces are cosmetic
  }
}

module.exports = {
  tickMentorfolk,
  // Pure helpers for tests and integration:
  hashStr,
  pickOne,
  fill,
  dayNumber,
  seededRng,
  chance,
  isWorkHour,
  isOathHour,
  isRealPlayer,
  withinTiles,
  normalizeName,
  masterLevel,
  isProMentor,
  mentorfolkTypeOf,
  folkTypeFromRoll,
  pitchFor,
  tradeFor,
  choresFor,
  viceFor,
  anyRealPlayerNear,
  RECRUITER,
  TASKMASTER,
  SOAPBOX,
  OATH_WARDEN,
  FOLK_TYPES,
  RECRUIT_TRADES,
  DAY_CHORES,
  DAY_VICES,
  PITCHES,
  SETUP_LINES,
  WORK_LINES,
  PITCH_LINES,
  CHORE_LINES,
  MORAL_LINES,
  OATH_LINES,
  MASTER_TALK_LINES,
  OATH_RECITAL_LINES,
  OATH_CEREMONY_LINES,
  TASKMASTER_SCENE_LINES,
  SOAPBOX_CROWD_LINES,
  SIGNING_HAUL_LINES,
  // Test seams:
  _firedDayKeys: firedDayKeys,
  _resetState() {
    lastFiredByCitizen.clear();
    lastOathByCitizen.clear();
    firedDayKeys.clear();
    lastPruneAt = 0;
    _journalEvent = null;
  },
};
