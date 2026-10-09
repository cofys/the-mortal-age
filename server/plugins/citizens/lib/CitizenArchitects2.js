"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenArchitects2 — the draftfolk: amateur plan-scratchers under the
 * professional architects. Rough-drafters sketch wobbly plans on corner
 * drawing-boards, plan-copyists sell cheap hand-copies of simple rough
 * plans, and corner-advisers give free street-corner advice about sheds,
 * fences and leaky roofs. Commoners who live off the rough-copy plan
 * economy — the scrappy amateur layer under the professional drafting
 * studios.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived draftfolk types (~35% nominal share of commoners,
 *   post-exclusion), per-day corner draft boards (kingdom-preferred,
 *   seeded per day), per-day rough sketches, per-kingdom-per-day
 *   board-collapse / bad-measure set-pieces plus a once-per-board-per-day
 *   copy-dispute crowd moment (journaled + rumor-seeded), and a read-only
 *   pro-plans bridge that lets draftfolk small talk name the real
 *   CitizenArchitects drafting studios and their real plan subjects.
 *   Morning setup flavor before 10:00, midday sketching/hawking after.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-18:00 local): scripted setup flavor, sketch cries, pro-plans
 * small talk, a corner-adviser bending a traveler's ear about their shed,
 * a drawing-board collapsing in the wind, a buyer storming back over a
 * bad measurement, a copy dispute gathering round a board. Real plans,
 * commissions and approvals are LLM tier — this module only tracks state,
 * timers and the visible street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the professional architects
 * block.
 * Plain-node testable: CitizenArchitects2.test.js.
 *
 * No overlap (by design):
 *   - CitizenArchitects (master) owns the PROFESSIONAL drafting trade:
 *     master architects, draftsmen, surveyors, inspectors, the drafting
 *     studios, daily blueprint catalogs (sketch/study/finished/masterwork
 *     quality tiers), multi-day grand designs, commission ledgers and
 *     inspection sign-offs against the real CitizenBuilders works. The
 *     master's claim predicate is its real claimed-type function,
 *     architectTypeOf. This exclusion is checked via the real function
 *     BEFORE the share roll — a professional architect is never
 *     draftfolk. Draftfolk never touch the master's studios, catalogs,
 *     commissions or grand designs, and never APPROVE or BUILD anything:
 *     no approved plans, no commissioned buildings, no sign-offs —
 *     rough sketches, hand-copies and corner advice only.
 *   - CitizenBuilders2 owns amateur LABORFOLK who raise rough structures —
 *     excluded via the real claim function (laborfolkTypeOf) BEFORE the
 *     share roll: a citizen who carries timber and mortar never also
 *     keeps a drawing-board.
 *   - CitizenBuilders own actual construction projects — draftfolk never
 *     build, never supervise a site.
 *   - CitizenPainters own fine art — a rough plan sketch is a wobbly
 *     working drawing, never a painting or mural.
 *   - CitizenScribes own professional copying — draftfolk copy their own
 *     rough plans and simple public sketches only, never documents or
 *     ledgers.
 */

// === Tuning: all magic numbers here ===
const DRAFTFOLK_RADIUS = 40; // tiles — visible work range
const ADVICE_RADIUS = 14; // tiles — corner advice, close enough to hear
const DRAFTFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const ADVICE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // corner advice at most every 4h
const DRAFTFOLK_CHANCE = 0.2; // per eligible citizen per tick
const ADVICE_CHANCE = 0.35;
const DRAFTFOLK_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const BOARD_COLLAPSE_CHANCE = 0.06; // ~6% per kingdom per day: a draft board goes over in the wind
const BAD_MEASURE_CHANCE = 0.07; // ~7% per kingdom per day: a buyer storms back over a bad measurement
const COPY_DISPUTE_CHANCE = 0.08; // ~8% per corner board per day: a copy dispute gathers a crowd
const WORK_START_HOUR = 8; // 08:00 server local time (draft boards go up with the studios)
const WORK_END_HOUR = 18; // 18:00 server local time (pack before the evening rush)
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday sketching

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProArchs = safeRequire("./CitizenArchitects"); // master: real claim fn + read-only studio/subject bridge
const Builders2 = safeRequire("./CitizenBuilders2"); // laborfolk: real claim fn, exclusion
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Draftfolk types ===
const ROUGH_DRAFTER = "rough-drafter";
const PLAN_COPYIST = "plan-copyist";
const CORNER_ADVISER = "corner-adviser";
const DRAFT_TYPES = [ROUGH_DRAFTER, PLAN_COPYIST, CORNER_ADVISER];
const DRAFT_WEIGHTS = {
  [ROUGH_DRAFTER]: 40,
  [PLAN_COPYIST]: 35,
  [CORNER_ADVISER]: 25,
};

// === Corner draft boards — market corners, bridge steps, tavern fringes.
// Amateur plan pitches, deliberately OFF the professional drafting studios:
// no drafting hall, no atelier, no plan house, no survey office of the pro
// trade. ===
const DRAFT_BOARDS = [
  { name: "the Varrock market-fringe draft board", kingdom: "misthalin" },
  { name: "the Lumbridge cart-track corner board", kingdom: "misthalin" },
  { name: "the Falador east-wall steps board", kingdom: "asgarnia" },
  { name: "the Port Sarim dock-fringe board", kingdom: "asgarnia" },
  { name: "the East Ardougne market-corner board", kingdom: "kandarin" },
  { name: "the Catherby jetty-steps board", kingdom: "kandarin" },
  { name: "the Keldagrim south-tier stair board", kingdom: "keldagrim" },
  { name: "the Dorgeshuun torch-wall corner board", kingdom: "keldagrim" },
  { name: "the Canifis fence-line board", kingdom: "morytania" },
  { name: "the Mort'ton cart-corner board", kingdom: "morytania" },
  { name: "the Al Kharid souk-fringe board", kingdom: "kharidian" },
  { name: "the Pollnivneach well-steps board", kingdom: "kharidian" },
];

// === The rough sketches — cheap hand drawings, deliberately nothing a
// professional drafting studio would approve. Everything is a rough plan:
// amateurs never draft an approved plan, a finished blueprint or a
// masterwork. ===
const SKETCHES = {
  [ROUGH_DRAFTER]: [
    "a wobbly plan for {subject}",
    "a charcoal sketch of {subject}",
    "a smudged rough-draft of {subject}",
    "a chalk-on-slate plan for {subject}",
    "a rough hand-drawing of {subject}",
  ],
  [PLAN_COPYIST]: [
    "a hand-copy of a plan for {subject}",
    "a cheap copy-sketch of {subject}",
    "a folded copy-plan for {subject}",
    "a smudged second copy for {subject}",
    "a quick copy of the {subject} sketch",
  ],
  [CORNER_ADVISER]: [
    "a chalked corner-diagram for {subject}",
    "a rough fix-it sketch of {subject}",
    "a scribbled advice-plan for {subject}",
    "a back-of-board drawing of {subject}",
    "a quick measure-sketch of {subject}",
  ],
};

// === Subjects draftfolk sketch (kingdom-preferred subjects). ===
const DRAFTFOLK_SUBJECTS = [
  { name: "a crooked fence run", kingdom: "misthalin" },
  { name: "a chicken-coop sketch", kingdom: "misthalin" },
  { name: "a leaky shed roof", kingdom: "asgarnia" },
  { name: "a pigsty wall repair", kingdom: "asgarnia" },
  { name: "an uneven garden wall", kingdom: "kandarin" },
  { name: "a wobbly stair run", kingdom: "kandarin" },
  { name: "a lopsided woodshed", kingdom: "keldagrim" },
  { name: "a drafty mine-shaft door", kingdom: "keldagrim" },
  { name: "a sagging coffin-lid shed", kingdom: "morytania" },
  { name: "a swamp-stilt outhouse", kingdom: "morytania" },
  { name: "a sun-baked mudbrick lean-to", kingdom: "kharidian" },
  { name: "a crooked market awning", kingdom: "kharidian" },
];

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 10:00 the draftfolk are still setting up.
const SETUP_LINES = [
  "Boards up, sketches out.",
  "Setting up for the day.",
  "Prices are chalked on the board.",
  "Just getting the stall ready.",
];

// Work lines per type.
const WORK_LINES = {
  [ROUGH_DRAFTER]: [
    "Rough drafts, cheap!",
    "Sketching wobbly plans here.",
    "Need a plan drawn up?",
    "Drafts while you wait.",
    "Fresh sketches, fresh ideas.",
  ],
  [PLAN_COPYIST]: [
    "Cheap copies, good as the original.",
    "Hand-copied plans here.",
    "Need a copy of that sketch?",
    "Copies while you wait.",
    "Plans copied neat and cheap.",
  ],
  [CORNER_ADVISER]: [
    "Free advice on your build.",
    "Ask me about your plans.",
    "Corner advice, no charge.",
    "I can look over your draft.",
    "Building tips here.",
  ],
};

// Drafters and copyists hawk the day's sketches.
const HAWK_LINES = {
  [ROUGH_DRAFTER]: [
    "Plans! Rough sketches of {subject}, drawn by my own hand!",
    "A rough plan for {subject} — cheap, and cheaper than guessing!",
    "Traveller! Take a rough sketch for {subject}, mind the smudges!",
  ],
  [PLAN_COPYIST]: [
    "Hand-copies! Cheap plan-copies for {subject}, copied fair!",
    "Copies of the {subject} sketch — a copper, take your pick!",
    "Plan copies! {subject}, smudged a little, priced a lot little!",
  ],
  [CORNER_ADVISER]: [
    "Free advice on {subject} — and rough sketches for a copper!",
    "Ask me about {subject}! First advice is free, sketches cost!",
    "Corner plans! {subject} sorted before your tea cools!",
  ],
};

// Corner-adviser street advice for lingering travelers.
const ADVICE_LINES = [
  "Your {subject}? Shore the low side first, then mind the drip-line.",
  "Seen a hundred {subject}s — yours wants new bracing and dry mortar.",
  "Advice is free: with {subject}, fix the water before the wood.",
  "That {subject} — take my sketch, and don't build past the lean.",
];

// Small talk that names the real professional drafting trade (read-only
// bridge: studio names and plan subjects from the master module).
const PRO_TALK_LINES = [
  "The {studio} draws proper plans for {subject} — mine's the rough corner sketch, friend.",
  "Heard the drafting folk at {studio} are drawing {subject} — my copy's still catching up!",
  "{subject}, the pros call it — my sketch of it is honest guesswork!",
  "A finished plan for {subject} at {studio}? Lovely. Mine's rough, and a tenth of the price.",
  "Someday my sketches will be fit for {studio}. Today: rough {subject} for a copper.",
  "The pros at {studio} sign off {subject} — I just sketch what I see from the corner.",
];

// Board-collapse set-piece: a draft board goes over in the wind.
const BOARD_COLLAPSE_LINES = [
  "The wind took the draft board — sketches everywhere, two in the gutter!",
  "(a clatter and a curse) The board's gone over — the whole pile's loose!",
  "Board down! The corner plans are blowing down the lane!",
];

// Bad-measure set-piece: a buyer storms back over a bad measurement.
const BAD_MEASURE_LINES = [
  "A buyer came storming back — my rough plan for {subject} was a foot short!",
  "That fuming builder? My sketch of {subject} — the measure was off by a span!",
  "(a shouting match by the board) — the {subject} plan had the door backwards!",
];

// Copy-dispute crowd moment: once per board per day, two buyers argue over
// a smudged copy.
const DISPUTE_LINES = [
  "Two buyers arguing over the same smudged copy at {place} — pass the chalk!",
  "A dispute at {place} — both want the one legible plan for {subject}!",
  "The crowd's gathering at {place} — a smudged copy and two angry builders!",
];

// === State: cooldown maps + once-per-day set-piece keys (pruned hourly) ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastAdviceByCitizen = new Map(); // username -> timestamp
// Once-per-day set-piece keys:
//   "collapse:<kid>:<day>", "measure:<kid>:<day>", "dispute:<board-index>:<day>"
const firedDayKeys = new Set();
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastAdviceByCitizen) {
    if (at < cutoff) lastAdviceByCitizen.delete(k);
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

/** True during amateur draft hours (08:00-18:00 server local time). */
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
// Draftfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the MASTER CitizenArchitects
 * professional trade. The master's claim predicate is its real
 * claimed-type function, architectTypeOf (role partition + its own
 * mutual exclusions + ~30% roll of the commoner pool): those citizens run
 * the real drafting trade — master architects, draftsmen, surveyors,
 * inspectors with drafting studios, blueprint catalogs, grand designs,
 * commissions and inspection sign-offs. The 2-layer owns amateur
 * draftfolk only, so this exclusion runs BEFORE the share roll. Fail-open
 * when the master is absent: a missing master cannot claim anyone.
 * Never throws.
 */
function isProArchitect(record) {
  try {
    if (!ProArchs || typeof ProArchs.architectTypeOf !== "function") return false;
    return ProArchs.architectTypeOf(record) !== null;
  } catch {
    return false;
  }
}

/**
 * True when CitizenBuilders2 claims this citizen — called through the
 * amateur builders' real claim function (laborfolkTypeOf), i.e. its null
 * path, so a citizen who carries timber and mortar never also keeps a
 * drawing-board. Never throws.
 */
function isLaborfolk(record) {
  try {
    if (!Builders2 || typeof Builders2.laborfolkTypeOf !== "function") return false;
    return Builders2.laborfolkTypeOf(record) !== null;
  } catch {
    return false;
  }
}

/** Weighted pick of a draft type from a 0..99 roll. */
function draftTypeFromRoll(roll) {
  let acc = 0;
  for (const t of DRAFT_TYPES) {
    acc += DRAFT_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return ROUGH_DRAFTER;
}

/**
 * The draft type for a roster record, or null.
 * Excludes the professional architects (master claim, checked via the
 * real architectTypeOf) and the laborfolk (Builders2 claim, checked via
 * the real laborfolkTypeOf). Both exclusions run BEFORE the share roll,
 * so they hold regardless of the 35% draw. Uses name-first salts to avoid
 * the FNV-1a prefix-correlation bug.
 */
function draftfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProArchitect(record)) return null;
    if (isLaborfolk(record)) return null;
    const roll = hashStr(name + "|architects2") % 100;
    if (roll >= DRAFTFOLK_SHARE) return null;
    return draftTypeFromRoll(hashStr(name + "|architects2-type") % 100);
  } catch {
    return null;
  }
}
// ============================================================================
// Boards, sketches, and the read-only pro-plans bridge.
// ============================================================================

/** The day's corner draft board for a draftfolk citizen: kingdom-preferred, seeded per day. */
function boardFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? DRAFT_BOARDS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : DRAFT_BOARDS;
    const rng = seededRng(hashStr("archboards2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, src);
  } catch {
    return DRAFT_BOARDS[0];
  }
}

/** The day's rough sketch for a draftfolk citizen: kingdom-preferred, seeded per day. */
function sketchFor(username, type, kingdomId, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const pools = SKETCHES[type] ?? SKETCHES[ROUGH_DRAFTER];
    const subjects = DRAFTFOLK_SUBJECTS.filter(
      (s) => String(s.kingdom).toLowerCase() === String(kingdomId).toLowerCase()
    );
    const subjectPool = subjects.length ? subjects : DRAFTFOLK_SUBJECTS;
    const rng = seededRng(hashStr("archsketch2:" + name + ":" + type + ":" + dayNumber(dateMs)));
    const sketch = pickOne(rng, pools);
    const subject = pickOne(rng, subjectPool);
    return fill(sketch, { subject: subject.name });
  } catch {
    return null;
  }
}

/**
 * Read-only bridge to the master's REAL drafting studios and plan
 * subjects — draftfolk small talk stays consistent with the actual pro
 * trade. Reads only exported constants (STUDIOS, SUBJECTS): never touches
 * the master's commissions, catalogs or grand designs. Fail-open (null)
 * when the master is absent.
 */
function proPlansTalkFor(kingdomId, dateMs = Date.now()) {
  try {
    if (!ProArchs) return null;
    const studios = ProArchs.STUDIOS;
    const subjects = ProArchs.SUBJECTS;
    if (!Array.isArray(studios) || !studios.length || !subjects) return null;
    const pool = subjects[ProArchs.ARCHITECT_DRAFTSMAN] ?? subjects[ProArchs.ARCHITECT_MASTER];
    if (!Array.isArray(pool) || !pool.length) return null;
    const kid = String(kingdomId ?? "").toLowerCase();
    const local = studios.filter((s) => String(s.kingdom).toLowerCase() === kid);
    const src = local.length ? local : studios;
    const rng = seededRng(hashStr("archprotalk2:" + kid + ":" + dayNumber(dateMs)));
    const studio = pickOne(rng, src).name;
    const subject = pickOne(rng, pool);
    return fill(pickOne(rng, PRO_TALK_LINES), { studio, subject });
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
    if (je) je("architects2", username, text);
  } catch { /* cosmetic */ }
}

function seedRumor(rng, text) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor("architects2", text);
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
// Gate order: cooldown (cheapest) → LOD brain gate → draftfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickDraftfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < DRAFTFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible draft life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be draftfolk (hash-derived, cheap; exclusions inside)
        const type = draftfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. Work hours only (amateur draft hours: 8 to 18)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within visible range
        if (!anyRealPlayerNear(director, citizen, DRAFTFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, DRAFTFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doDraftWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-architects2] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: board-collapses, bad-measures, copy disputes (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-architects2] tick failed:", e?.message ?? e);
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

function doDraftWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const board = boardFor(record, nowMs);
  const place = board ? board.name : "the corner draft board";
  const sketch = sketchFor(name, type, kid, nowMs) ?? "a rough sketch";
  const hour = new Date(nowMs).getHours();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, pickOne(Math.random, SETUP_LINES));
    journalize(record.username, "Set up the draft board at " + place + ".");
    return;
  }

  // Midday: visible work emotes, sketch hawking, plus pro-plans small talk.
  const vars = { place, sketch, their: "their" };
  const workLines = WORK_LINES[type] ?? WORK_LINES[ROUGH_DRAFTER];
  const cries = HAWK_LINES[type] ?? HAWK_LINES[ROUGH_DRAFTER];
  const roll = Math.random();
  let line;
  if (roll < 0.35) {
    line = fill(pickOne(Math.random, workLines), vars);
  } else if (roll < 0.65) {
    line = fill(pickOne(Math.random, cries), vars);
  } else {
    line = proPlansTalkFor(kid, nowMs) || fill(pickOne(Math.random, cries), vars);
  }
  forceSay(citizen, line);
  journalize(record.username, "Worked the " + type + " trade at " + place + ": " + sketch + ".");

  // Corner advisers bend lingering travelers' ears about their sheds and fences.
  const lastAdv = lastAdviceByCitizen.get(record.username) || 0;
  if (type === CORNER_ADVISER && nowMs - lastAdv >= ADVICE_COOLDOWN_MS && Math.random() < ADVICE_CHANCE) {
    if (anyRealPlayerNear(director, citizen, ADVICE_RADIUS)) {
      forceSay(citizen, fill(pickOne(Math.random, ADVICE_LINES), vars));
      journalize(record.username, "Gave free corner advice at " + place + ": " + sketch + ".");
      lastAdviceByCitizen.set(record.username, nowMs);
    }
  }
}

/**
 * Daily set-pieces, once per kingdom/board per day:
 *   - board-collapse: a draft board goes over in the wind (~6%)
 *   - bad-measure: a fuming buyer storms back over a bad measurement (~7%, rumor-seeded)
 *   - copy dispute: two buyers argue over a smudged copy at a board (~8%)
 * Day-gated keys, cheap to evaluate. Never throws.
 */
function dailyRhythms(director, nowMs) {
  try {
    const day = dayNumber(nowMs);
    const rng = seededRng(hashStr("draftfolk-day:" + day));
    const online = typeof director.onlinePlayers === "function" ? director.onlinePlayers() : [];
    const realNearBoard = online.some((p) => isRealPlayer(p));
    if (!realNearBoard) return; // no audience — skip the whole street scene
    const kids = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];

    for (const kid of kids) {
      const collapseKey = "collapse:" + kid + ":" + day;
      if (!firedDayKeys.has(collapseKey) && rng() < BOARD_COLLAPSE_CHANCE) {
        firedDayKeys.add(collapseKey);
        const event = pickOne(rng, BOARD_COLLAPSE_LINES);
        journalize("draftfolk-" + kid, event + " (" + kid + " board)");
        seedRumor(rng, event);
      }
      const measureKey = "measure:" + kid + ":" + day;
      if (!firedDayKeys.has(measureKey) && rng() < BAD_MEASURE_CHANCE) {
        firedDayKeys.add(measureKey);
        const subjects = DRAFTFOLK_SUBJECTS.filter((s) => s.kingdom === kid);
        const subject = subjects.length ? pickOne(rng, subjects).name : "a rough plan";
        const event = fill(pickOne(rng, BAD_MEASURE_LINES), { subject });
        journalize("draftfolk-" + kid, event);
        seedRumor(rng, event);
      }
    }

    for (let i = 0; i < DRAFT_BOARDS.length; i++) {
      const key = "dispute:" + i + ":" + day;
      if (firedDayKeys.has(key) || rng() >= COPY_DISPUTE_CHANCE) continue;
      firedDayKeys.add(key);
      const board = DRAFT_BOARDS[i];
      const subjects = DRAFTFOLK_SUBJECTS.filter((s) => s.kingdom === board.kingdom);
      const subject = subjects.length ? pickOne(rng, subjects).name : "a rough plan";
      journalize(
        "draftfolk-" + board.kingdom,
        fill(pickOne(rng, DISPUTE_LINES), { place: board.name, subject })
      );
    }
  } catch {
    // set-pieces are cosmetic
  }
}

module.exports = {
  tickDraftfolk,
  // Pure helpers for tests and integration:
  hashStr,
  pickOne,
  fill,
  dayNumber,
  seededRng,
  chance,
  isWorkHour,
  isRealPlayer,
  withinTiles,
  normalizeName,
  isProArchitect,
  isLaborfolk,
  draftfolkTypeOf,
  draftTypeFromRoll,
  boardFor,
  sketchFor,
  proPlansTalkFor,
  anyRealPlayerNear,
  ROUGH_DRAFTER,
  PLAN_COPYIST,
  CORNER_ADVISER,
  DRAFT_TYPES,
  DRAFT_BOARDS,
  SKETCHES,
  DRAFTFOLK_SUBJECTS,
  SETUP_LINES,
  WORK_LINES,
  HAWK_LINES,
  ADVICE_LINES,
  PRO_TALK_LINES,
  BOARD_COLLAPSE_LINES,
  BAD_MEASURE_LINES,
  DISPUTE_LINES,
  // Test seams:
  _firedDayKeys: firedDayKeys,
  _resetState() {
    lastFiredByCitizen.clear();
    lastAdviceByCitizen.clear();
    firedDayKeys.clear();
    lastPruneAt = 0;
    _journalEvent = null;
  },
};
