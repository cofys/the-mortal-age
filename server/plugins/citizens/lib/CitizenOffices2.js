"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

/**
 * CitizenOffices2 — the clerk folk: the amateur street layer under the
 * professional kingdom offices (CitizenOffices).
 *
 * Notice-copiers chalk out copies of the offices' REAL notices at the
 * market crosses, office-seekers angle for vacant seals, petition-carriers
 * haul grievances toward the court, and vacancy gossips spread word of
 * which seals sit unclaimed. Commoners who live off the informal paper
 * economy around power — the scrappy amateur layer under the real
 * office-holders.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived clerkfolk types (~30% nominal share of commoners,
 *   post-exclusion), per-day seeded copy assignments, and reads of the
 *   REAL office state (CitizenOffices.officesOfKingdom) so every visible
 *   claim names real office-holders and real vacancies. Morning setup
 *   flavor before 10:00, midday notice-copies and petition-carrying after.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-20:00 local): scripted setup flavor, notice-copies naming the
 * REAL office-holder ("The Quartermaster's office — Aeliana has posted a
 * notice"), office-seekers naming REAL vacant seals, petition-carriers
 * hauling paper toward the court, vacancy gossips spreading real vacancy
 * news. Seating citizens, authority, decrees, duty refill and the
 * kingdom:office-* event contracts are professional tier — this module
 * only tracks state, timers and the visible scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 * Wired into the director tick right after the offices block.
 * Plain-node testable: CitizenOffices2.test.js.
 *
 * No overlap (by design):
 *   - CitizenOffices (professional) owns the REAL office-holding: seating
 *     citizens to the four offices (quartermaster, marshal, spymaster,
 *     steward), the bindings store, fillVacancy / kingdom:office-seeks-holder
 *     / kingdom:office-assigned, office duties (garrison musters, supply
 *     orders, ledger readings, spymaster rumors), announceSeating and
 *     officesOfKingdom / officeOfCitizen. Its real, exported professional
 *     claim predicate is officeOfCitizen(citizenName) -> binding | null
 *     (CitizenOffices.js:495), built on the persisted bindings the tick
 *     itself uses. This module wires that ACTUAL function via
 *     isProOfficeHolder BEFORE the share roll — no invented criterion.
 *     A claimed office-holder is never clerkfolk. Clerkfolk never seat
 *     citizens, never hold seals, never issue decrees, never perform
 *     duties, never answer seeks-holder.
 *   - CitizenJudges owns verdict rumors and appeals — clerkfolk never
 *     judge, never review cases.
 *   - CitizenDiplomats owns courtier drafting and court ceremonies —
 *     petition-carriers haul paper, never stage court ceremony.
 *   - CitizenNewspaper owns the town criers shouting weekly news —
 *     notice-copiers chalk office notices, never news or proclamations.
 *   - CitizenHawkers2 owns amateur hawkers selling goods and wares —
 *     nobody here sells anything.
 *   - No other "2" module claims this concept: mentorfolk recruit,
 *     taskmasters chore, soapbox preachers moralize, oath-wardens keep the
 *     oath book, bardfolk sing, moneyfolk count coin.
 */

// === Tuning: all magic numbers here ===
const FOLK_RADIUS = 40; // tiles — visible work range
const FOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const FOLK_CHANCE = 0.2; // per eligible citizen per tick
const FOLK_SHARE = 30; // ~30% nominal share of commoners (post-exclusion)
const WORK_START_HOUR = 8; // 08:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday work

// The four standard offices the kingdoms plugin defines (CitizenOffices
// binds these; clerkfolk read them read-only). Any seal not held in the
// bindings is genuinely vacant — never invented, computed from real state.
const STANDARD_OFFICES = Object.freeze([
  { office: "quartermaster", title: "Quartermaster" },
  { office: "marshal", title: "Marshal" },
  { office: "spymaster", title: "Spymaster" },
  { office: "steward", title: "Steward" },
]);

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProOffices = safeRequire("./CitizenOffices"); // professional: the REAL office claim predicate (officeOfCitizen)
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");

// === State: cooldown map (pruned hourly) ===
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

// === Clerkfolk types ===
const NOTICE_COPIER = "notice-copier"; // amateur clerks copying REAL office notices
const OFFICE_SEEKER = "office-seeker"; // angle for vacant seals, never hold them
const PETITION_CARRIER = "petition-carrier"; // haul petitions toward the court
const VACANCY_GOSSIP = "vacancy-gossip"; // spread real vacancy news
const FOLK_TYPES = [NOTICE_COPIER, OFFICE_SEEKER, PETITION_CARRIER, VACANCY_GOSSIP];
const FOLK_WEIGHTS = {
  [NOTICE_COPIER]: 35,
  [OFFICE_SEEKER]: 25,
  [PETITION_CARRIER]: 25,
  [VACANCY_GOSSIP]: 15,
};

// === Line pools — all scripted, zero LLM. Slots filled from REAL state. ===

// Morning setup flavor: before 10:00 the clerkfolk are still setting up.
const SETUP_LINES = [
  "Getting the notices chalked up.",
  "Quills are sharpened.",
  "Just laying out the day's paper.",
  "Petitions stack themselves, apparently.",
];

// Work lines per type (state-free fallbacks).
const WORK_LINES = {
  [NOTICE_COPIER]: [
    "Copying notices.",
    "Chalking up the latest.",
    "Notice board's full.",
  ],
  [OFFICE_SEEKER]: [
    "A seal will want me some day.",
    "Watching the offices.",
    "My name's in every hat.",
  ],
  [PETITION_CARRIER]: [
    "Petitions to deliver.",
    "Carrying paper.",
    "The court's that way.",
  ],
  [VACANCY_GOSSIP]: [
    "Heard things.",
    "Know who's out?",
    "Offices change hands.",
  ],
};

// Notice-copies name the REAL office-holder and title (real engine state).
const NOTICE_LINES = [
  "The {title}'s office — {holder} has posted a notice! Copied here fair.",
  "Fresh from the {title}'s desk: {holder} wants it chalked up. Reading's free.",
  "The {title} {holder} has set a new notice — I've copied it below the old.",
  "Straight from {holder}, the {title}: the notice is up, the ink's still wet.",
];

// Office-seekers name REAL vacant seals (standard offices minus held).
const VACANCY_LINES = [
  "The {title}'s seal sits unclaimed! Some hand must take it.",
  "No {title} in this kingdom — now's the time for an honest hand.",
  "The {title}'s chair is empty. My petition's already written.",
  "They'll need a {title} soon. Mark my words.",
];

// Petition-carriers name the REAL court they haul toward.
const PETITION_LINES = [
  "A petition for the {title} — {holder} will hear this one, surely.",
  "Carrying grievances to the {title}'s court. Paper for {holder}.",
  "Sign the petition, friend! It goes to the {title}, {holder}.",
  "Three more signatures and this goes up to the {title}.",
];

// Vacancy gossips spread REAL vacancy news.
const GOSSIP_LINES = [
  "Psst — the {title}'s seal is vacant. Heard it from the cross.",
  "They say the {title} is unseated. Spread the word.",
  "No {title} to be found — the offices are short-handed.",
  "Word is the {title}'s chair waits on a hand. Pass it on.",
];

// The honest read-only bridge to the professional tier: clerkfolk small
// talk names the REAL office-holding facts (seals bind to living citizens
// by fit; the authority is the holders'). The seating, authority and
// decrees are the office-holders' — clerkfolk do notices, petitions,
// seekers and gossip.
const OFFICE_TALK_LINES = [
  "The seals bind to living citizens — the offices pick their own hands. I only copy the paper.",
  "A {title} gets seated by the offices themselves, fit to the job. I'm the one with the chalk.",
  "The {title}'s authority is real, friend — {holder} holds the seal. I hold a quill.",
  "Seating is the offices' doing, not mine. I carry petitions; the {title} answers them.",
  "The offices seat their own — guards lean marshal, merchants lean steward. I lean on this board.",
];

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

/** True during clerkfolk hours (08:00-20:00 server local time). */
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
// Clerkfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the professional offices tier
 * (CitizenOffices). CitizenOffices' real, exported professional claim
 * predicate is officeOfCitizen(citizenName) (CitizenOffices.js:495): the
 * same persisted-bindings lookup the tickOffices sweep itself uses —
 * non-null when the citizen holds a real seal. We wire that actual
 * function — no re-invented criterion. Claimed office-holders are seated,
 * bound and duty-bound — devices of the professional layer. The 2-layer
 * owns amateur clerkfolk only, so this exclusion runs BEFORE the share
 * roll. Fail-open when the offices module is absent: a missing office
 * tier cannot claim anyone. Never throws.
 */
function isProOfficeHolder(record) {
  try {
    if (!ProOffices || typeof ProOffices.officeOfCitizen !== "function") return false;
    const claimed = ProOffices.officeOfCitizen(record?.username);
    return claimed !== null && claimed !== undefined;
  } catch {
    return false;
  }
}

/** Weighted pick of a clerkfolk type from a 0..99 roll. */
function folkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FOLK_TYPES) {
    acc += FOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return NOTICE_COPIER;
}

/**
 * The clerkfolk type for a roster record, or null.
 * Excludes professional office-holders via the offices tier's REAL
 * exported claim predicate (CitizenOffices.officeOfCitizen, the same
 * function the duty tick uses to find holders) BEFORE the share roll, so
 * it holds regardless of the 30% draw. Uses name-first salts to avoid
 * the FNV-1a prefix-correlation bug.
 */
function clerkfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProOfficeHolder(record)) return null;
    const roll = hashStr(name + "|offices2") % 100;
    if (roll >= FOLK_SHARE) return null;
    return folkTypeFromRoll(hashStr(name + "|offices2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Real office state — read-only. Never invent holders or vacancies.
// ============================================================================

/**
 * The offices genuinely held in a kingdom right now, straight from the
 * professional tier's bindings: [{ office, title, citizenName }].
 * Never throws; empty when the tier is absent or the kingdom holds none.
 */
function heldOfficesOf(kingdomId) {
  try {
    if (!ProOffices || typeof ProOffices.officesOfKingdom !== "function") return [];
    const out = ProOffices.officesOfKingdom(kingdomId) ?? [];
    return out.filter((o) => o && o.citizenName);
  } catch {
    return [];
  }
}

/**
 * The seals genuinely vacant in a kingdom: the four standard offices the
 * kingdoms plugin defines, minus the ones really held in the bindings.
 * A computed read of real state — never invented, never assumed.
 */
function vacantOfficesOf(kingdomId) {
  try {
    const held = new Set(heldOfficesOf(kingdomId).map((o) => String(o.office).toLowerCase()));
    return STANDARD_OFFICES.filter((s) => !held.has(s.office));
  } catch {
    return [];
  }
}

// ============================================================================
// Journal (never throws). Canonical: getJournal().log(name, kind, text).
// ============================================================================

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

/** Say a line in chat (never throws). Mentors2 forceSay shape exactly. */
function forceSay(citizen, text) {
  try {
    if (citizen?.forceChat) { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
    else if (citizen?.say) citizen.say(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → clerkfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickClerkfolk(director, nowMs, desync) {
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

        // 3. Must be clerkfolk (hash-derived, cheap; exclusions inside)
        const type = clerkfolkTypeOf(record);
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
        console.warn("[citizen-offices2] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-offices2] tick failed:", e?.message ?? e);
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
  const kid = record?.kingdomId ?? record?.kingdom;
  const held = heldOfficesOf(kid);
  const vacant = vacantOfficesOf(kid);
  const heldOne = held.length ? pickOne(Math.random, held) : null;
  const vacantOne = vacant.length ? pickOne(Math.random, vacant) : null;
  const hour = new Date(nowMs).getHours();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, pickOne(Math.random, SETUP_LINES));
    journalize(record.username, "Set up the notice board for the day.");
    return;
  }

  // Midday: notice-copies, seal-seeking, petition-carrying, vacancy gossip
  // — every visible claim names a REAL holder or REAL vacancy. When the
  // real state has nothing to say, fall back to the state-free work lines.
  const workLines = WORK_LINES[type] ?? WORK_LINES[NOTICE_COPIER];
  const roll = Math.random();
  let line;
  if (type === NOTICE_COPIER && heldOne && roll < 0.6) {
    line = fill(pickOne(Math.random, NOTICE_LINES), { title: heldOne.title, holder: heldOne.citizenName });
  } else if (type === OFFICE_SEEKER && vacantOne && roll < 0.6) {
    line = fill(pickOne(Math.random, VACANCY_LINES), { title: vacantOne.title });
  } else if (type === PETITION_CARRIER && heldOne && roll < 0.6) {
    line = fill(pickOne(Math.random, PETITION_LINES), { title: heldOne.title, holder: heldOne.citizenName });
  } else if (type === VACANCY_GOSSIP && vacantOne && roll < 0.6) {
    line = fill(pickOne(Math.random, GOSSIP_LINES), { title: vacantOne.title });
  } else if (roll < 0.35 && heldOne) {
    // The honest office-holding bridge: names the real tier's criterion.
    line = fill(pickOne(Math.random, OFFICE_TALK_LINES), { title: heldOne.title, holder: heldOne.citizenName });
  } else {
    line = pickOne(Math.random, workLines);
  }
  forceSay(citizen, line);
  journalize(record.username, "Worked the " + type + " trade.");
}

module.exports = {
  tickClerkfolk,
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
  isProOfficeHolder,
  clerkfolkTypeOf,
  folkTypeFromRoll,
  heldOfficesOf,
  vacantOfficesOf,
  anyRealPlayerNear,
  NOTICE_COPIER,
  OFFICE_SEEKER,
  PETITION_CARRIER,
  VACANCY_GOSSIP,
  FOLK_TYPES,
  STANDARD_OFFICES,
  SETUP_LINES,
  WORK_LINES,
  NOTICE_LINES,
  VACANCY_LINES,
  PETITION_LINES,
  GOSSIP_LINES,
  OFFICE_TALK_LINES,
  // Test seams:
  _resetState() {
    lastFiredByCitizen.clear();
    lastPruneAt = 0;
    _journal = null;
  },
};
