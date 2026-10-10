"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenNewspaper2 — the pamphlet folk: the amateur street-news layer under
 * the professional CitizenNewspaper weekly paper. Pamphlet-sellers hawk
 * hand-copied sheets of the REAL weekly edition, street news-gossips repeat
 * REAL logged journal events as gossip, and poster-pasters put up posters
 * announcing the REAL latest edition at the street corners. Commoners who
 * live off the informal news economy — the scrappy amateur layer under the
 * real town-crier press.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived pamphletfolk types (~30% nominal share of commoners,
 *   post-exclusion), per-day seeded poster corners (kingdom-preferred), and
 *   real-state reads: the latest REAL edition (paper name + top headline via
 *   CitizenNewspaper.latestEdition) and the REAL journal (recent logged
 *   events via getJournal().entries). Morning setup flavor before 09:00,
 *   midday hawking/gossiping/pasting after, until 20:00.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 07:00-20:00 local): scripted setup flavor, pamphlet hawkers crying the
 * REAL paper's headline, news-gossips repeating REAL logged events, poster
 * pasters putting up REAL edition posters. The paper is compiled, town
 * criers shout, and editions are handed out in the master tier — this
 * module only tracks state, timers and the visible scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the newspaper block.
 * Plain-node testable: CitizenNewspaper2.test.js.
 *
 * No overlap (by design):
 *   - CitizenNewspaper (master) owns the PROFESSIONAL weekly paper: it
 *     compiles editions from the realm's data, designates one town crier
 *     per kingdom per week via its REAL claim function
 *     CitizenNewspaper.crierFor(kingdomId, records, editionIdFor(nowMs)) —
 *     the same predicate the crier tick uses to pick its criers — and the
 *     criers shout the headline and hand out the paper through the web
 *     overlay. This module wires that ACTUAL function via isProCrier
 *     BEFORE the share roll — no invented criterion. A claimed crier is
 *     never pamphletfolk. Pamphletfolk never shout as criers, never compile
 *     editions, never hand out the paper, never cry "extra! extra!" as
 *     criers do. The line is crisp: criers announce, pamphletfolk repeat.
 *   - CitizenBards2 owns songs; pamphleteers hawk paper, never sing.
 *   - CitizenHawkers2 owns amateur hawkers selling goods and wares.
 *     Pamphlet-sellers sell hand-copied sheets of the real paper, never
 *     goods; they never invent a headline.
 *   - No other "2" module claims this concept: mentorfolk recruit,
 *     songfolk sing, brewfolk brew, marketstallfolk stall.
 * HARD RULE: pamphletfolk NEVER invent news, headlines or events. Every
 * visible claim reads real engine state: the real journal entries, the
 * real latest edition (paper name + headlines), real roster/coordinate
 * facts. A gossip with no real event says the day is quiet — real state.
 */

// === Tuning: all magic numbers here ===
const FOLK_RADIUS = 40; // tiles — visible work range
const FOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const FOLK_CHANCE = 0.2; // per eligible citizen per tick
const FOLK_SHARE = 30; // ~30% nominal share of commoners (post-exclusion)
const WORK_START_HOUR = 7; // 07:00 server local time (early print runs)
const WORK_END_HOUR = 20; // 20:00 server local time
const SETUP_CUTOFF_HOUR = 9; // before 09:00: setup flavor instead of midday work
const MAX_EVENTS_READ = 40; // cap on real journal events scanned per pick

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProNewspaper = safeRequire("./CitizenNewspaper"); // master: the REAL crier-claim predicate (crierFor)
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");

// === Pamphletfolk types ===
const PAMPHLET_SELLER = "pamphlet-seller"; // hawk hand-copied sheets of the REAL weekly edition
const NEWS_GOSSIP = "news-gossip"; // repeat REAL logged journal events as street gossip
const POSTER_PASTER = "poster-paster"; // paste posters announcing the REAL latest edition
const FOLK_TYPES = [PAMPHLET_SELLER, NEWS_GOSSIP, POSTER_PASTER];
const FOLK_WEIGHTS = {
  [PAMPHLET_SELLER]: 40,
  [NEWS_GOSSIP]: 35,
  [POSTER_PASTER]: 25,
};

// === Poster corners — street notice boards, alley walls, market posts.
// Amateur posting spots, deliberately OFF any professional criers' bells,
// temple notice boards, academy walls or guild halls. ===
const CORNERS = [
  { name: "the Varrock fountain-side notice board", kingdom: "misthalin" },
  { name: "the Lumbridge alehouse back-alley wall", kingdom: "misthalin" },
  { name: "the Falador park gate posting post", kingdom: "asgarnia" },
  { name: "the Port Sarim dockside rope-coil board", kingdom: "asgarnia" },
  { name: "the East Ardougne market-alley corner", kingdom: "kandarin" },
  { name: "the Catherby cliff-path milepost", kingdom: "kandarin" },
  { name: "the Keldagrim south-street lamp post", kingdom: "keldagrim" },
  { name: "the Dorgeshuun lamp-lit corner wall", kingdom: "keldagrim" },
  { name: "the Canifis gate-side posting board", kingdom: "morytania" },
  { name: "the Mort'ton cart-yard fence", kingdom: "morytania" },
  { name: "the Al Kharid souk-fringe wall", kingdom: "kharidian" },
  { name: "the Pollnivneach well-head posting post", kingdom: "kharidian" },
];

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 09:00 the pamphletfolk are still setting up.
const SETUP_LINES = [
  "Paste's still wet.",
  "Setting up the poster corner.",
  "Just folding the sheets.",
  "Waiting on the fresh sheets.",
];

// Work lines per type (generic; never claim invented news).
const WORK_LINES = {
  [PAMPHLET_SELLER]: [
    "Pamphlets! Fresh sheets!",
    "Get your pamphlets here!",
    "Sheets fresh off the press!",
  ],
  [NEWS_GOSSIP]: [
    "Word on the street?",
    "Hear the latest?",
    "News travels fast here.",
  ],
  [POSTER_PASTER]: [
    "Poster's going up!",
    "Fresh paste, fresh poster!",
    "New sheets on the board!",
  ],
};

// Pamphlet hawkers crying for custom without naming news.
const HAWK_LINES = [
  "Read all about it — in the real paper, friend!",
  "Pamphlets! The week's news, proper and true!",
  "Get the paper's own words here — pamphlets!",
  "The week's happenings, copied fair — pamphlets!",
];

// Gossips on a quiet day (no real journal events to retell): real state,
// said plainly.
const GOSSIP_QUIET_LINES = [
  "Quiet day for news, friend.",
  "Nothing worth repeating today.",
  "The streets are holding their tongues.",
  "No word yet — check back later.",
];

// Poster-pasters with no edition to announce: real state, said plainly.
const POSTER_LINES = [
  "No new edition yet — the board waits.",
  "Paste's ready, but the week's paper isn't.",
  "Nothing to post today, friend.",
];

// Retell frames — filled ONLY from real engine state.
const GOSSIP_FRAME = "Heard tell — {who}: {text}"; // {who}/{text} from a real journal event
const PAPER_FRAME = "Fresh pamphlets! {paper} says: {top}"; // real paper name + real headline
const POSTER_FRAME = "Poster fresh up — {paper}: {top}"; // real paper name + real headline

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

/** True during pamphletfolk hours (07:00-20:00 server local time). */
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
// Pamphletfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the professional newspaper tier
 * (CitizenNewspaper). The master's real claim function is
 * CitizenNewspaper.crierFor(kingdomId, records, editionId), the same
 * predicate the crier tick uses to pick its town criers: deterministic
 * per kingdom + week, one crier per kingdom. We wire that actual
 * function — no re-invented criterion. Claimed criers shout the weekly
 * headline and hand out the paper through the web overlay — devices of
 * the master layer. The 2-layer owns amateur pamphletfolk only, so this
 * exclusion runs BEFORE the share roll. Fail-open when the master tier
 * module is absent: a missing paper cannot claim anyone. Never throws.
 */
function isProCrier(record, records, nowMs) {
  try {
    if (!ProNewspaper) return false;
    if (typeof ProNewspaper.crierFor !== "function") return false;
    if (typeof ProNewspaper.editionIdFor !== "function") return false;
    const kid = String(record?.kingdom ?? record?.kingdomId ?? "").toLowerCase();
    if (!kid) return false;
    const crier = ProNewspaper.crierFor(kid, records, ProNewspaper.editionIdFor(nowMs ?? Date.now()));
    return !!crier && String(crier.username) === String(record?.username);
  } catch {
    return false;
  }
}

/** Weighted pick of a pamphletfolk type from a 0..99 roll. */
function folkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FOLK_TYPES) {
    acc += FOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return PAMPHLET_SELLER;
}

/**
 * The pamphletfolk type for a roster record, or null.
 * Excludes professional town criers via the master tier's REAL exported
 * claim predicate (CitizenNewspaper.crierFor, the same function the crier
 * tick picks criers with) BEFORE the share roll, so it holds regardless
 * of the 30% draw. The caller supplies proCriers — the set of usernames
 * the real predicate claimed this tick. Uses name-first salts to avoid
 * the FNV-1a prefix-correlation bug.
 */
function pamphleteerfolkTypeOf(record, proCriers) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (proCriers instanceof Set && proCriers.has(record?.username)) return null;
    const roll = hashStr(name + "|newspaper2") % 100;
    if (roll >= FOLK_SHARE) return null;
    return folkTypeFromRoll(hashStr(name + "|newspaper2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Poster corners — per-day seeded, kingdom-preferred.
// ============================================================================

/** The day's poster corner for a pamphletfolk citizen: kingdom-preferred, seeded per day. */
function cornerFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? CORNERS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : CORNERS;
    const rng = seededRng(hashStr("pamphletcorners2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, src);
  } catch {
    return CORNERS[0];
  }
}

// ============================================================================
// Journal (canonical lazy pattern) + real-state reads. Never throw.
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

/**
 * The most recent REAL journal events across all citizens, newest first.
 * Real engine state: each entry is a real logged event (kind, text, who,
 * with, at) from the shared journal — never invented. Reads only.
 */
function recentEvents(maxCount = MAX_EVENTS_READ) {
  const out = [];
  try {
    const j = journal();
    if (!j) return out;
    for (const record of j.entries?.values?.() ?? []) {
      for (const ev of record?.events ?? []) {
        if (!ev || !ev.kind || !ev.text) continue;
        out.push({
          who: record?.display || record?.username || "A citizen",
          kind: String(ev.kind),
          text: String(ev.text),
          with: ev.with ?? null,
          at: ev.at ?? 0,
        });
        if (out.length >= maxCount) break;
      }
      if (out.length >= maxCount) break;
    }
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
  } catch {
    /* real-state read is best-effort */
  }
  return out.slice(0, maxCount);
}

/** The day's real event for a news-gossip to retell: seeded per day, real only. */
function pickEventFor(username, dateMs = Date.now()) {
  try {
    const events = recentEvents();
    if (events.length === 0) return null;
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("newsgossip2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, events);
  } catch {
    return null;
  }
}

/**
 * A news-gossip's retell line for a REAL journal event. Template filled
 * from real state only; capped at 120 chars. Never invents.
 */
function retellFrame(ev) {
  try {
    const who = String(ev?.who || "A citizen").slice(0, 40);
    const text = String(ev?.text || "").slice(0, 90);
    return fill(GOSSIP_FRAME, { who, text }).slice(0, 120);
  } catch {
    return "";
  }
}

/** The real latest edition (paper name + headlines) from the master tier. */
function latestEdition() {
  try {
    if (ProNewspaper && typeof ProNewspaper.latestEdition === "function") {
      return ProNewspaper.latestEdition();
    }
  } catch {
    /* master read is best-effort */
  }
  return null;
}

/**
 * A pamphlet-seller's / poster-paster's shout line for the REAL latest
 * edition: real paper name + real top headline, templated. Never invents.
 */
function paperShoutLine(edition, frame = PAPER_FRAME) {
  try {
    const paper = String(edition?.paper || "the weekly paper").slice(0, 40);
    const top = String((edition?.headlines ?? [])[0] || "news from across the realm").slice(0, 80);
    return fill(frame, { paper, top }).slice(0, 120);
  } catch {
    return "";
  }
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
// Gate order: cooldown (cheapest) → LOD brain gate → crier exclusion +
// pamphletfolk? → materialized → work hours → real player near → chance → work.
// ============================================================================

// === State: cooldown maps (pruned hourly) ===
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

/** The set of usernames the master tier's real claim predicate picks this tick. */
function proCriersFor(records, nowMs) {
  const out = new Set();
  try {
    if (!ProNewspaper || typeof ProNewspaper.crierFor !== "function") return out;
    if (typeof ProNewspaper.editionIdFor !== "function") return out;
    const editionId = ProNewspaper.editionIdFor(nowMs);
    const kids = new Set();
    for (const r of records ?? []) {
      const kid = String(r?.kingdom ?? r?.kingdomId ?? "").toLowerCase();
      if (kid) kids.add(kid);
    }
    for (const kid of kids) {
      const crier = ProNewspaper.crierFor(kid, records, editionId);
      if (crier?.username) out.add(String(crier.username));
    }
  } catch {
    /* exclusion is best-effort; fail-open */
  }
  return out;
}

function tickPamphleteers(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    const records = [...(director?.roster?.values?.() ?? [])];
    // The real claim predicate runs ONCE per tick, before any share roll.
    const proCriers = proCriersFor(records, nowMs);

    for (const record of records) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < FOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible folk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be pamphletfolk (hash-derived, cheap; crier exclusion
        // via the master tier's REAL predicate runs BEFORE the share roll)
        const type = pamphleteerfolkTypeOf(record, proCriers);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Work hours only (07:00-20:00 server local)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within visible range
        if (!anyRealPlayerNear(director, citizen, FOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, FOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM; claims read real state only)
        doFolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-newspaper2] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-newspaper2] tick failed:", e?.message ?? e);
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
  const corner = cornerFor(record, nowMs);
  const place = corner ? corner.name : "the street poster corner";
  const hour = new Date(nowMs).getHours();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, pickOne(Math.random, SETUP_LINES));
    journalize(record.username, "Set up the poster corner at " + place + ".");
    return;
  }

  // Midday: hawking, gossiping, pasting. Every news claim reads real
  // state (the real journal, the real latest edition); with nothing to
  // read, folk say the day is quiet — real state, said plainly.
  const edition = latestEdition();
  const workLines = WORK_LINES[type] ?? WORK_LINES[PAMPHLET_SELLER];
  const roll = Math.random();
  let line;
  let journalText = null;

  if (type === NEWS_GOSSIP) {
    const ev = pickEventFor(name, nowMs);
    if (ev) {
      line = retellFrame(ev);
      journalText = "Repeated word of " + ev.who + " on the street.";
    } else {
      line = pickOne(Math.random, GOSSIP_QUIET_LINES);
      journalText = "Gossiped at " + place + " — a quiet day for news.";
    }
  } else if (type === PAMPHLET_SELLER) {
    if (edition && (edition.headlines ?? []).length > 0) {
      line = paperShoutLine(edition, PAPER_FRAME);
      journalText = "Hawked pamphlets of " + edition.paper + ".";
    } else {
      line = pickOne(Math.random, HAWK_LINES);
      journalText = "Hawked pamphlets at " + place + ".";
    }
  } else {
    // POSTER_PASTER
    if (edition && (edition.headlines ?? []).length > 0) {
      line = paperShoutLine(edition, POSTER_FRAME);
      journalText = "Pasted " + edition.paper + " posters at " + place + ".";
    } else {
      line = pickOne(Math.random, POSTER_LINES);
      journalText = "Pasted posters at " + place + ".";
    }
  }

  // Sometimes fall back to generic per-type work flavor (never news).
  if (journalText !== null && roll < 0.25) {
    line = pickOne(Math.random, workLines);
    journalText = "Worked the " + type + " trade at " + place + ".";
  }

  if (line) forceSay(citizen, line);
  if (journalText) journalize(record.username, journalText);
}

module.exports = {
  tickPamphleteers,
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
  isProCrier,
  proCriersFor,
  pamphleteerfolkTypeOf,
  folkTypeFromRoll,
  cornerFor,
  recentEvents,
  pickEventFor,
  retellFrame,
  latestEdition,
  paperShoutLine,
  anyRealPlayerNear,
  PAMPHLET_SELLER,
  NEWS_GOSSIP,
  POSTER_PASTER,
  FOLK_TYPES,
  FOLK_SHARE,
  FOLK_RADIUS,
  FOLK_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  CORNERS,
  SETUP_LINES,
  WORK_LINES,
  HAWK_LINES,
  GOSSIP_QUIET_LINES,
  POSTER_LINES,
  GOSSIP_FRAME,
  PAPER_FRAME,
  POSTER_FRAME,
  // Test seams:
  _resetState() {
    lastFiredByCitizen.clear();
    lastPruneAt = 0;
    _journal = null;
  },
};
