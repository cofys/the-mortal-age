"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenDiplomats2 — the envoyfolk: the court-fringe street layer under
 * the professional diplomats. Envoy well-wishers gather at the court
 * anchor with garlands and cheers, rumor-carriers repeat REAL kingdom
 * news from running diplomat missions, bannermen fly the court colors,
 * and guest-scribes keep the visitors' ledger. Commoners who live off
 * the informal diplomacy-adjacent street life — the scrappy amateur
 * layer under the real envoy trade.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived envoyfolk types (~30% nominal share of commoners,
 *   post-exclusion), per-day court-fringe spots (kingdom-preferred,
 *   seeded per day), per-day mission-news picks parsed from the
 *   professional tier's live mission summary, per-citizen cooldowns,
 *   and evening send-off cheers when a REAL mission is departing.
 *   Morning setup flavor before 10:00, midday well-wishing, news
 *   carrying, banner and guest-book work after, send-offs to 20:00.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-20:00 local): scripted setup flavor, well-wishers cheering at
 * the court steps, rumor-carriers quoting REAL running missions ("word
 * from the court: X of Y — a trade agreement with Z"), bannermen with
 * the court colors, guest-scribes with the visitors' ledger, and a
 * send-off cheer when a real envoy actually departs. Real missions,
 * treaty outcomes, and escort invitations are diplomat tier — this
 * module only tracks state, timers and the visible scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the diplomats block.
 * Plain-node testable: CitizenDiplomats2.test.js.
 *
 * No overlap (by design):
 *   - CitizenDiplomats (master) owns the PROFESSIONAL diplomat trade:
 *     envoys, negotiators and ambassadors drafted from courtiers; real
 *     diplomatic missions (departing -> traveling -> negotiating ->
 *     stationed -> returning -> debrief); treaty authority (trade,
 *     culture, peace, alliance outcomes and border-tension effects);
 *     escort invitations (diplomat_escort, wage-paid). Its real,
 *     exported claim predicate is CitizenDiplomats.isDiplomat(username)
 *     (CitizenDiplomats.js:234), applied to courtiers by courtiersOf
 *     (CitizenDiplomats.js:454). This module wires that ACTUAL
 *     predicate via isProDiplomat BEFORE the share roll — no invented
 *     criterion. A citizen the professional tier may draft is never
 *     envoyfolk. Envoyfolk never run missions, never negotiate, never
 *     sign or claim treaties, never invite escorts, never speak for a
 *     kingdom: well-wishers cheer departures (never escort), rumor-
 *     carriers repeat REAL running-mission news (never invent treaties,
 *     missions, wars or peace deals), bannermen fly colors (never
 *     heraldic authority), guest-scribes keep the visitors' ledger
 *     (never treaty minutes).
 *   - CitizenJudges owns judges: the professional diplomat tier already
 *     rejects judge-claimed courtiers through the same isDiplomat
 *     predicate this module wires, so the ~35% judge-claimed are out
 *     of both tiers. One citizen, one public office.
 *   - CitizenNewspaper owns the town criers shouting weekly news.
 *     Rumor-carriers quote court mission state only, never news or
 *     proclamations.
 *   - CitizenBards2 owns songs; CitizenStorytellers owns oral tales.
 *     Guest-scribes write names in the ledger, never songs or tales.
 *   - No other "2" module claims this concept: mentorfolk run the
 *     apprenticeship street, hawkers2 sell goods, guardfolk drill.
 */

// === Tuning: all magic numbers here ===
const FOLK_RADIUS = 40; // tiles — visible work range
const WISH_RADIUS = 14; // tiles — send-off cheers, close enough to be heard
const FOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const WISH_COOLDOWN_MS = 4 * 60 * 60 * 1000; // send-offs at most every 4h
const FOLK_CHANCE = 0.2; // per eligible citizen per tick
const WISH_CHANCE = 0.35;
const FOLK_SHARE = 30; // ~30% nominal share of commoners (post-exclusion)
const WORK_START_HOUR = 8; // 08:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time (send-offs to close)
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday work
const WISH_START_HOUR = 17; // send-off cheers gather in the evening
const WISH_END_HOUR = 20;

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProDiplomats = safeRequire("./CitizenDiplomats"); // master tier: the REAL claim predicate (isDiplomat)
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");

// === Envoyfolk types ===
const WELL_WISHER = "well-wisher"; // garlands and cheers at the court anchor
const RUMOR_CARRIER = "rumor-carrier"; // repeats REAL kingdom news from running missions
const BANNERMAN = "bannerman"; // flies and minds the court colors
const GUEST_SCRIBE = "guest-scribe"; // keeps the visitors' ledger (never treaty minutes)
const FOLK_TYPES = [WELL_WISHER, RUMOR_CARRIER, BANNERMAN, GUEST_SCRIBE];
const FOLK_WEIGHTS = {
  [WELL_WISHER]: 35,
  [RUMOR_CARRIER]: 30,
  [BANNERMAN]: 20,
  [GUEST_SCRIBE]: 15,
};

// === Court-fringe spots — the public edge of the court anchor.
// Envoyfolk work the public fringe, never inside the professional
// court itself: steps, benches, flagstones, rails, arches. City names
// mirror the professional tier's CITY_FALLBACK (CitizenDiplomats.js),
// the same five kingdoms the diplomat tier drafts from. ===
const COURT_SPOTS = [
  { name: "the Varrock court-steps crowd", kingdom: "misthalin" },
  { name: "the Varrock envoy-yard bench", kingdom: "misthalin" },
  { name: "the Falador court-fringe benches", kingdom: "asgarnia" },
  { name: "the Falador banner-post corner", kingdom: "asgarnia" },
  { name: "the Ardougne court-gate flagstones", kingdom: "kandarin" },
  { name: "the Ardougne visitors' arch", kingdom: "kandarin" },
  { name: "the Keldagrim court-rail fringe", kingdom: "keldagrim" },
  { name: "the Keldagrim torch-wall corner", kingdom: "keldagrim" },
  { name: "the Darkmeyer court-crowd steps", kingdom: "morytania" },
  { name: "the Darkmeyer visitor's ledge", kingdom: "morytania" },
];

// City per kingdom — mirrors CitizenDiplomats CITY_FALLBACK, the real
// display names the professional tier itself uses.
const KINGDOM_CITY = {
  misthalin: "Varrock",
  asgarnia: "Falador",
  kandarin: "Ardougne",
  keldagrim: "Keldagrim",
  morytania: "Darkmeyer",
};

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 10:00 the envoyfolk are still setting up.
const SETUP_LINES = [
  "Setting up at the court steps.",
  "Banners need straightening.",
  "Guest book's out, quills ready.",
  "Just getting the welcome ready.",
];

// Work lines per type.
const WORK_LINES = {
  [WELL_WISHER]: [
    "Safe roads to the envoy!",
    "Cheers for the court!",
    "Wave them off, friends!",
  ],
  [RUMOR_CARRIER]: [
    "Word travels fast here.",
    "Heard it at the court steps.",
    "News comes to those who wait.",
  ],
  [BANNERMAN]: [
    "Banners flying today.",
    "The court colors are up.",
    "Polishing the banner staves.",
  ],
  [GUEST_SCRIBE]: [
    "Sign the guest book.",
    "Names in the ledger.",
    "The visitor's book is open.",
  ],
};

// Rumor-carriers quoting REAL running missions — every slot is parsed
// from the professional tier's live mission summary. Never invented.
const NEWS_LINES = [
  "Word from the court: {name} of {home} — a {label} with {target}!",
  "They say {name} rides for {home} on a {label} to {target}.",
  "Court gossip: {name} of {home} seeks a {label} with {target}.",
];

// Rumor-carrier fallback when no mission is running anywhere.
// Makes NO claims — the tier never invents envoy news.
const NO_NEWS_LINES = [
  "No word from the envoys today.",
  "The court is quiet on the envoy front.",
  "Nothing riding out that I've heard.",
];

// Well-wishers cheering a REAL departing mission.
const DEPARTING_LINES = [
  "Ride safe, {name}! Bring {target} home a friend!",
  "Off they go — {name} for {target}, and the court's hopes with them!",
  "Cheer for {name}, friends! {target} awaits!",
];

// Generic well-wishing when no mission is departing: ambiance only,
// no claims about envoys or missions.
const WISH_LINES = [
  "The court steps are lively today.",
  "Garlands for the envoys!",
  "A fine day to wave someone off.",
];

// Bannermen with the court colors.
const BANNER_LINES = [
  "The {city} banners are flying at {place}!",
  "Colors of {city}, straight and true!",
  "A banner for every envoy who rides!",
];

// Guest-scribes with the visitors' ledger (names only — never minutes).
const GUEST_LINES = [
  "Sign the guest book of {city}, friend!",
  "The visitor's ledger of {city} is open!",
  "Your name in the book, traveler?",
];

// The honest read-only bridge to the professional diplomats: envoyfolk
// small talk names the professional tier's REAL claim (courtiers,
// hand-picked at court). The missions and treaties are the envoys' —
// envoyfolk cheer, carry word, fly colors and keep the guest book.
const DIPLOMAT_TALK_LINES = [
  "The envoys are the court's own courtiers, hand-picked — I only wave them off.",
  "Treaties are the envoys' business. I cheer, I carry word, I mind the colors.",
  "Courtier-folk, chosen at court, do the riding and the talking. I'm the welcome party.",
  "Don't ask me about treaties — ask an envoy of the court. I wave banners.",
  "The missions belong to the envoys; the cheering belongs to us.",
];

// === State: cooldown maps (pruned hourly) ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastWishByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastWishByCitizen) {
    if (at < cutoff) lastWishByCitizen.delete(k);
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

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during envoyfolk hours (08:00-20:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

/** True during send-off hours (17:00-20:00 server local time). */
function isWishHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WISH_START_HOUR && h < WISH_END_HOUR;
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
// Envoyfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the professional diplomat tier
 * (CitizenDiplomats). CitizenDiplomats' real, exported claim predicate is
 * isDiplomat(username) (CitizenDiplomats.js:234) — true when the citizen
 * may serve as a diplomat (it wires the judges tier's real predicate so
 * judge-claimed courtiers are never diplomats). The professional tier
 * drafts courtiers through that predicate (courtiersOf,
 * CitizenDiplomats.js:454: role === ROLE_COURTIER && isDiplomat). We
 * wire that ACTUAL predicate — no re-invented criterion. A claimed
 * citizen carries real missions, negotiates real treaties and invites
 * real escorts — devices of the diplomat layer. The 2-layer owns
 * amateur envoyfolk only, so this exclusion runs BEFORE the share
 * roll. Fail-open when the diplomat tier module is absent: a missing
 * tier cannot claim anyone. Never throws.
 */
function isProDiplomat(record) {
  try {
    if (!ProDiplomats || typeof ProDiplomats.isDiplomat !== "function") return false;
    const role = record?.role ?? record?.attributes?.role;
    // The professional tier drafts courtiers (see courtiersOf) — a
    // commoner is never in its draft pool, so only courtiers can be
    // claimed out from under the share roll.
    if (role !== "courtier" && role !== "COURTIER") return false;
    return ProDiplomats.isDiplomat(record?.username) === true;
  } catch {
    return false;
  }
}

/** Weighted pick of an envoyfolk type from a 0..99 roll. */
function folkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FOLK_TYPES) {
    acc += FOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return WELL_WISHER;
}

/**
 * The envoyfolk type for a roster record, or null.
 * Excludes citizens the professional diplomat tier may draft via the
 * tier's REAL exported claim predicate (CitizenDiplomats.isDiplomat,
 * the same function the professional draft uses) BEFORE the share
 * roll, so it holds regardless of the 30% draw. Uses name-first salts
 * to avoid the FNV-1a prefix-correlation bug.
 */
function envoyfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProDiplomat(record)) return null;
    const roll = hashStr(name + "|diplomats2") % 100;
    if (roll >= FOLK_SHARE) return null;
    return folkTypeFromRoll(hashStr(name + "|diplomats2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Court spots: kingdom-preferred, seeded per day.
// ============================================================================

/** The day's court-fringe spot for an envoyfolk citizen: kingdom-preferred, seeded per day. */
function spotFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? COURT_SPOTS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : COURT_SPOTS;
    const rng = seededRng(hashStr("diplospots2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, src);
  } catch {
    return COURT_SPOTS[0];
  }
}

/** Display city for a kingdom id (mirrors the professional tier's CITY_FALLBACK). */
function cityFor(kingdomId) {
  try {
    return KINGDOM_CITY[String(kingdomId ?? "").toLowerCase()] ?? "the city";
  } catch {
    return "the city";
  }
}

// ============================================================================
// The honest read-only bridge to the professional tier: real mission
// state. diplomatStatus() is the professional tier's LIVE mission
// summary (CitizenDiplomats.js), one line per running mission:
//   "<name> (<role>) of <home>: <phase> — <label> with <target>."
// Rumor-carriers quote this and nothing else — every visible claim
// reads real engine state. Never throws.
// ============================================================================

/** Live mission summary lines from the professional tier, or []. */
function liveMissions() {
  try {
    if (ProDiplomats && typeof ProDiplomats.diplomatStatus === "function") {
      const s = ProDiplomats.diplomatStatus();
      return Array.isArray(s) ? s : [];
    }
  } catch { /* fall through */ }
  return [];
}

/** Parse one diplomatStatus() line into {name, role, home, phase, label, target}, or null. */
const STATUS_RE = /^(.+?)\s+\((envoy|negotiator|ambassador)\)\s+of\s+(.+?):\s*(\S+)\s*[—–-]\s*(.+?)\s+with\s+(.+?)\.\s*$/;
function parseMissionStatus(line) {
  try {
    const m = String(line ?? "").match(STATUS_RE);
    if (!m) return null;
    return { name: m[1], role: m[2], home: m[3], phase: m[4], label: m[5], target: m[6] };
  } catch {
    return null;
  }
}

/**
 * The real mission news a rumor-carrier may quote today: seeded per day
 * from the professional tier's LIVE missions. Returns null when no
 * mission is running anywhere — the carrier then says nothing claimed.
 */
function newsFor(username, dateMs, statusLines) {
  try {
    const parsed = (statusLines ?? []).map(parseMissionStatus).filter(Boolean);
    if (!parsed.length) return null;
    const name = normalizeName(username) || "anon";
    const rng = seededRng(hashStr("diplonews2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, parsed);
  } catch {
    return null;
  }
}

/** The first currently-departing mission (real state), or null. */
function departingMission(statusLines) {
  try {
    for (const line of statusLines ?? []) {
      const p = parseMissionStatus(line);
      if (p && p.phase === "departing") return p;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Journal (canonical: getJournal().log — never journalize/appendEntry).
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

/** Say a line in chat (never throws). */
function forceSay(citizen, text) {
  try {
    if (citizen?.forceChat) { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
    else if (citizen?.say) citizen.say(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → envoyfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickEnvoyfolk(director, nowMs, desync) {
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

        // 3. Must be envoyfolk (hash-derived, cheap; exclusions inside)
        const type = envoyfolkTypeOf(record);
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
        console.warn("[citizen-diplomats2] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-diplomats2] tick failed:", e?.message ?? e);
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
  const spot = spotFor(record, nowMs);
  const place = spot ? spot.name : "the court fringe";
  const city = cityFor(record?.kingdomId ?? record?.kingdom ?? spot?.kingdom);
  const hour = new Date(nowMs).getHours();
  // Real engine state, read once per work cycle: the professional
  // tier's live missions. Rumor-carriers and send-offs quote this.
  const status = liveMissions();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, fill(pickOne(Math.random, SETUP_LINES), { their: "their" }));
    journalize(record.username, "Set up at " + place + ".");
    return;
  }

  // Midday: well-wishing, REAL news carrying, banners, guest-book work,
  // plus the honest diplomat small talk.
  const news = newsFor(name, nowMs, status);
  const dep = departingMission(status);
  const vars = { place, city, name, home: news?.home, label: news?.label, target: dep?.target ?? news?.target, their: "their" };
  const workLines = WORK_LINES[type] ?? WORK_LINES[WELL_WISHER];
  const roll = Math.random();
  let line;
  if (type === RUMOR_CARRIER && roll < 0.5) {
    if (news) {
      const nvars = { name: news.name, home: news.home, label: news.label, target: news.target };
      line = fill(pickOne(Math.random, NEWS_LINES), nvars);
      journalize(record.username, "Carried word of " + news.name + "'s " + news.label + " with " + news.target + " at " + place + ".");
    } else {
      line = pickOne(Math.random, NO_NEWS_LINES);
      journalize(record.username, "Kept the court-fringe post at " + place + " (no envoy news).");
    }
    forceSay(citizen, line);
    return;
  } else if (type === WELL_WISHER && roll < 0.5) {
    line = dep
      ? fill(pickOne(Math.random, DEPARTING_LINES), { name: dep.name, target: dep.target })
      : fill(pickOne(Math.random, WISH_LINES), vars);
  } else if (type === BANNERMAN && roll < 0.5) {
    line = fill(pickOne(Math.random, BANNER_LINES), vars);
  } else if (type === GUEST_SCRIBE && roll < 0.5) {
    line = fill(pickOne(Math.random, GUEST_LINES), vars);
  } else if (roll < 0.35) {
    line = fill(pickOne(Math.random, workLines), vars);
  } else {
    const talk = fill(pickOne(Math.random, DIPLOMAT_TALK_LINES), vars);
    line = talk.includes("{") ? fill(pickOne(Math.random, workLines), vars) : talk;
  }
  forceSay(citizen, line);
  journalize(record.username, "Worked the " + type + " post at " + place + ".");

  // Evening send-off cheers: well-wishers wave off a REAL departing
  // mission — never an invented one.
  const lastW = lastWishByCitizen.get(record.username) || 0;
  if (type === WELL_WISHER && isWishHour(nowMs) && nowMs - lastW >= WISH_COOLDOWN_MS && Math.random() < WISH_CHANCE) {
    if (dep && anyRealPlayerNear(director, citizen, WISH_RADIUS)) {
      forceSay(citizen, fill(pickOne(Math.random, DEPARTING_LINES), { name: dep.name, target: dep.target }));
      journalize(record.username, "Waved " + dep.name + " off to " + dep.target + " from " + place + ".");
      lastWishByCitizen.set(record.username, nowMs);
    }
  }
}

module.exports = {
  tickEnvoyfolk,
  // Pure helpers for tests and integration:
  hashStr,
  pickOne,
  fill,
  dayNumber,
  seededRng,
  chance,
  isWorkHour,
  isWishHour,
  isRealPlayer,
  withinTiles,
  normalizeName,
  isProDiplomat,
  envoyfolkTypeOf,
  folkTypeFromRoll,
  spotFor,
  cityFor,
  liveMissions,
  parseMissionStatus,
  newsFor,
  departingMission,
  anyRealPlayerNear,
  WELL_WISHER,
  RUMOR_CARRIER,
  BANNERMAN,
  GUEST_SCRIBE,
  FOLK_TYPES,
  KINGDOM_CITY,
  COURT_SPOTS,
  SETUP_LINES,
  WORK_LINES,
  NEWS_LINES,
  NO_NEWS_LINES,
  DEPARTING_LINES,
  WISH_LINES,
  BANNER_LINES,
  GUEST_LINES,
  DIPLOMAT_TALK_LINES,
  // Test seams:
  _resetState() {
    lastFiredByCitizen.clear();
    lastWishByCitizen.clear();
    lastPruneAt = 0;
    _journal = null;
  },
};
