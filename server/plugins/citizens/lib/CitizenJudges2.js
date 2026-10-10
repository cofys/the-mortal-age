"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenJudges2 — the justicefolk: the justice-and-disputes street layer
 * under the professional courts. Lay mediators talk neighbors out of
 * feuds over fences and debts (no gavel, no authority — talk first, court
 * last), amateur court ushers point folk at the hall and announce the
 * court's real session hours, law-clerks copy the REAL court ledger for
 * the crowd (fine counts, real outstanding fines, real pending appeals —
 * never invented), and dispute-watching bystanders (gawkers) gather where
 * trials draw a crowd. Commoners who live off the informal justice
 * economy — the scrappy amateur layer under the real court system.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived justicefolk types (~30% nominal share of commoners,
 *   post-exclusion), per-day street beats (kingdom-preferred, seeded per
 *   day, one per real court kingdom), court hours read live from the
 *   master's real session constants, and ledger reads through the
 *   master's REAL exports: fineCount, fineForPlayer, appealFor. Every
 *   visible verdict claim references real engine state — the clerk's
 *   lines only fire when the ledger has real fines or real pending
 *   appeals, and the gawker's gossip only names real outstanding fines.
 *   Morning setup flavor before 10:00, midday work after. 08:00-19:00.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-19:00 local): scripted setup flavor, mediators offering to talk
 * out a row, ushers announcing real court hours, clerks reading real
 * ledger outcomes to the crowd, gawkers gathering at session time. Real
 * verdicts, sentencing, summons and appeals are court tier — this module
 * only tracks state, timers and the visible scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the judges block.
 * Plain-node testable: CitizenJudges2.test.js.
 *
 * No overlap (by design):
 *   - CitizenJudges (court) owns the PROFESSIONAL justice system:
 *     magistrates, high judges, arbiters and bailiffs hold scripted
 *     trials, hand down verdicts, sentence (fines, jail, exile), serve
 *     summons, offer arbitration, and review appeals through the real
 *     fine/appeal ledgers. The master's real claim predicate is the
 *     tick gate itself: record.role === "courtier" && isJudge(username),
 *     the ~35% hash-stable courtiers. This module wires that ACTUAL
 *     claim as isProJudge BEFORE the share roll — no invented criterion.
 *     A claimed courtier is never justicefolk. Justicefolk never hold
 *     trials, never pass verdicts, never sentence, never serve summons,
 *     never claim judge titles: mediators talk rows out (never bind),
 *     ushers point at the hall (never preside), clerks copy the ledger
 *     (never write it), gawkers watch (never judge).
 *   - CitizenGuards owns arrests and the wanted list. Justicefolk never
 *     arrest, never name wanted players, never invent crimes — a clerk
 *     reads ONLY the court's own fine ledger; gawker gossip repeats ONLY
 *     real outstanding fines. No crime is ever named that the ledger did
 *     not record.
 *   - CitizenMentors2 owns oath-wardens and market-cross scenes.
 *     Mediators never run oath ceremonies or moralize from soapboxes —
 *     they talk out fence-and-debt rows, nothing grander.
 *   - CitizenNewspaper owns the town criers shouting weekly news. Clerks
 *     read ledger outcomes to the immediate crowd, never news or
 *     proclamations.
 *   - No other "2" module claims this concept: moneyfolk count coin
 *     (Bankers2), songfolk sing (Bards2), healers2 care, watchmen patrol
 *     (Guards2) — none of them mediate, usher, clerk or gawk.
 */

// === Tuning: all magic numbers here ===
const FOLK_RADIUS = 40; // tiles — visible work range
const LEDGER_RADIUS = 14; // tiles — clerk/gawker ledger talk, close enough to hear
const FOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const FOLK_CHANCE = 0.2; // per eligible citizen per tick
const FOLK_SHARE = 30; // ~30% nominal share of commoners (post-exclusion)
const WORK_START_HOUR = 8; // 08:00 server local time
const WORK_END_HOUR = 19; // 19:00 server local time
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday work

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProJudges = safeRequire("./CitizenJudges"); // court: the real claim predicate + real ledgers
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");

// === Justicefolk types ===
const MEDIATOR = "mediator"; // lay mediators: talk out fence-and-debt rows, no gavel
const USHER = "usher"; // amateur court ushers: point folk at the hall, announce real hours
const CLERK = "clerk"; // law-clerks: copy the REAL court ledger for the crowd
const GAWKER = "gawker"; // dispute-watching bystanders: gather where trials draw a crowd
const FOLK_TYPES = [MEDIATOR, USHER, CLERK, GAWKER];
const FOLK_WEIGHTS = {
  [MEDIATOR]: 30,
  [USHER]: 25,
  [CLERK]: 25,
  [GAWKER]: 20,
};

// === Street beats — public spots near (never inside) the courts.
// One per real court kingdom from the master's COURTS, on common ground:
// hall steps, market fountains, square benches. ===
const BEATS = [
  { name: "the Varrock court-steps bench", kingdom: "varrock" },
  { name: "the Lumbridge market-fountain bench", kingdom: "lumbridge" },
  { name: "the Falador tribunal-yard steps", kingdom: "falador" },
  { name: "the Port Sarim dockside bench", kingdom: "portsarim" },
  { name: "the Ardougne assizes square", kingdom: "ardougne" },
  { name: "the Seers' village green bench", kingdom: "kandarin" },
  { name: "the Keldagrim law-vault forecourt", kingdom: "keldagrim" },
  { name: "the Dorgesh market-well steps", kingdom: "dorgeshuun" },
  { name: "the Darkmeyer square shadows", kingdom: "morytania" },
  { name: "the Al Kharid qadi-court courtyard", kingdom: "alkharid" },
];

// === Line pools — all scripted, zero LLM. Every verdict claim reads real
// ledger state (fine counts, outstanding fines, pending appeals); generic
// flavor lines carry no claims at all. ===

// Morning setup flavor: before 10:00 the justicefolk are still setting up.
const SETUP_LINES = [
  "Setting out the mediation stool.",
  "Copying the docket for the crowd.",
  "Chalk up the court hours board.",
  "Morning quiet before the disputes.",
];

// Work lines per type (generic flavor, no outcome claims).
const WORK_LINES = {
  [MEDIATOR]: [
    "Talk it out, neighbors.",
    "No feud is worth a court day.",
    "I'll hear both sides.",
  ],
  [USHER]: [
    "Court's that way, friend.",
    "Mind the hall steps.",
    "Ushering folk to the court.",
  ],
  [CLERK]: [
    "Copying the docket for the crowd.",
    "Ink, parchment, patience.",
    "The ledger's open reading.",
  ],
  [GAWKER]: [
    "Watching the hall steps.",
    "Something's always brewing here.",
    "Crowd's gathering.",
  ],
};

// Mediators offer to talk rows out — never bind, never judge.
const MEDIATOR_LINES = [
  "Quarrel with your neighbor? No gavel here, friend — just talk. I mediate.",
  "I talk folk out of feuds over fences and debts. Cheaper than a magistrate.",
  "Bring me your row — I'll hear both sides before the court must.",
  "Loud roosters, borrowed tools, unpaid tabs: I talk, you listen, we settle.",
];

// Mediators point at the real court when talk fails — real hours, real court.
const MEDIATOR_COURT_LINES = [
  "If talk fails, {court} sits {start} to {end}. But talk first, friend.",
  "The magistrate at {court} keeps {start} to {end} hours — try me before them.",
];

// Ushers announce the real session state.
const USHER_SESSION_LINES = [
  "Court is sitting! Follow the bell to {court}.",
  "{court} is in session — mind your manners inside.",
  "The magistrate holds court now at {court}. In you go.",
];

const USHER_HOURS_LINES = [
  "Court sits {start} to {end}. Come back then.",
  "No session now — {court} opens at {start}.",
  "The hall is quiet till {start}. {court}, {start} to {end}.",
];

// Clerks read the REAL ledger — the {n} / {fine} / {kind} slots are filled
// ONLY from the master's fine ledger. Idle copy lines carry no claims.
const CLERK_COPY_LINES = [
  "Copying the docket for the crowd.",
  "Ink, parchment, patience — the clerk's tools.",
  "The court writes; I copy so the town can read.",
];

const CLERK_LEDGER_LINES = [
  "The court ledger shows {n} unpaid fines. Pay the clerk, not me!",
  "{n} fines still unpaid on the court's ledger — the magistrate remembers.",
];

const CLERK_FINE_LINES = [
  "The ledger says {name} owes {fine} coins for {kind}. Pay up, friend!",
  "{name}, the court ledger names you: {fine} coins for {kind}.",
];

const CLERK_APPEAL_LINES = [
  "An appeal sits on the ledger for {name} — the court's own review.",
  "{name}'s appeal is on the books. The ledger will decide.",
];

// Gawkers gossip ONLY about real outcomes: real fines from the ledger, or
// real session state. No invented crimes, ever.
const GAWKER_CROWD_LINES = [
  "Court's sitting — come watch justice get done.",
  "Something's brewing in the hall. Crowd's gathering.",
  "Nothing draws a crowd like a trial. Come see.",
];

const GAWKER_FINE_LINES = [
  "They say {name} got {fine} coins of fine for {kind}!",
  "Word is {name} owes the court {fine} coins. Ouch.",
];

const GAWKER_IDLE_LINES = [
  "Watching the hall steps. Quiet day.",
  "No trials on — the crowd will have to gossip instead.",
];

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

/** True during justicefolk hours (08:00-19:00 server local time). */
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
// Justicefolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the professional court tier
 * (CitizenJudges). The master exports no standalone "claim predicate",
 * but its real claim is the exact gate its own tick uses to draft judges:
 * record.role === "courtier" && isJudge(username) — the ~35% hash-stable
 * courtiers who hold scripted trials, pass verdicts, sentence, serve
 * summons and review appeals. We wire that ACTUAL claim via the real
 * exported isJudge — no re-invented criterion. The 2-layer owns amateur
 * justicefolk only, so this exclusion runs BEFORE the share roll.
 * Fail-open when the court tier module is absent: a missing court cannot
 * claim anyone. Never throws.
 */
function isProJudge(record) {
  try {
    if (!ProJudges || typeof ProJudges.isJudge !== "function") return false;
    const username = record?.username;
    if (!username) return false;
    return record.role === "courtier" && ProJudges.isJudge(username) === true;
  } catch {
    return false;
  }
}

/** Weighted pick of a justicefolk type from a 0..99 roll. */
function folkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FOLK_TYPES) {
    acc += FOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return MEDIATOR;
}

/**
 * The justicefolk type for a roster record, or null.
 * Excludes professional judges via the court tier's REAL claim
 * (role "courtier" + CitizenJudges.isJudge, the same gate the master
 * tick drafts judges with) BEFORE the share roll, so it holds
 * regardless of the 30% draw. Uses name-first salts to avoid the
 * FNV-1a prefix-correlation bug.
 */
function justicefolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProJudge(record)) return null;
    const roll = hashStr(name + "|judges2") % 100;
    if (roll >= FOLK_SHARE) return null;
    return folkTypeFromRoll(hashStr(name + "|judges2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Street beats: per-day seeded, kingdom-preferred.
// ============================================================================

/** The day's street beat for a justicefolk citizen: kingdom-preferred, seeded per day. */
function beatFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? BEATS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : BEATS;
    const rng = seededRng(hashStr("justicebeats2:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, src);
  } catch {
    return BEATS[0];
  }
}

// ============================================================================
// The honest read-only bridge to the professional court: real session
// hours, real court names, real fine/appeal ledger state. Nothing here
// invents crimes, verdicts or sentences — every field comes from the
// master's own exports.
// ============================================================================

/** The court's real session hours, read from the master's own tuning. */
function sessionHours() {
  try {
    return {
      start: ProJudges && typeof ProJudges.SESSION_HOUR_START === "number" ? ProJudges.SESSION_HOUR_START : 9,
      end: ProJudges && typeof ProJudges.SESSION_HOUR_END === "number" ? ProJudges.SESSION_HOUR_END : 16,
    };
  } catch {
    return { start: 9, end: 16 };
  }
}

/** True when the professional court is actually in session right now. */
function inSessionNow(nowMs) {
  try {
    if (ProJudges && typeof ProJudges.inSessionAtHour === "function") {
      return ProJudges.inSessionAtHour(new Date(nowMs).getHours());
    }
  } catch { /* fall through */ }
  return false;
}

/** The real court name for a citizen, from the master's courtFor. */
function courtNameFor(record) {
  try {
    if (ProJudges && typeof ProJudges.courtFor === "function") {
      return ProJudges.courtFor(record?.username, record?.kingdomId ?? record?.kingdom);
    }
  } catch { /* fall through */ }
  return "the court hall";
}

/**
 * Read-only summary of the real court ledgers for one username:
 * { fine, fineKind, appeal, fineCount }.
 * fine/fineKind come from the master's REAL fine ledger (fines its
 * trials actually recorded); appeal from its REAL appeal ledger;
 * fineCount is the real outstanding fine count. All zeros/false when
 * the court tier is absent or the ledgers are empty. Never throws.
 */
function ledgerSummaryFor(username, nowMs) {
  const empty = { fine: 0, fineKind: null, appeal: false, fineCount: 0 };
  try {
    if (!ProJudges) return empty;
    const fine = typeof ProJudges.fineForPlayer === "function"
      ? ProJudges.fineForPlayer(username, nowMs)
      : null;
    const appeal = typeof ProJudges.appealFor === "function"
      ? ProJudges.appealFor(username, nowMs)
      : null;
    const fineCount = typeof ProJudges.fineCount === "function"
      ? ProJudges.fineCount(nowMs)
      : 0;
    return {
      fine: fine ? fine.amount : 0,
      fineKind: fine ? fine.kind : null,
      appeal: !!appeal,
      fineCount,
    };
  } catch {
    return empty;
  }
}

// ============================================================================
// Journal (canonical: getJournal().log(name, kind, text)).
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

/** Say a line in chat (never throws). */
function forceSay(citizen, text) {
  try {
    if (citizen?.forceChat) { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
    else if (citizen?.say) citizen.say(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → justicefolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickJusticefolk(director, nowMs, desync) {
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

        // 3. Must be justicefolk (hash-derived, cheap; exclusions inside)
        const type = justicefolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Work hours only (08:00-19:00 server local)
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
        console.warn("[citizen-judges2] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-judges2] tick failed:", e?.message ?? e);
  }
}

/** Real (non-bot) players within radius tiles of the citizen. */
function realPlayersNear(director, citizen, radius) {
  const out = [];
  try {
    for (const r of director.roster?.values?.() ?? []) {
      if (!r) continue;
      if (typeof director.isOnline !== "function" || !director.isOnline(r)) continue;
      const p = typeof director.getBot === "function" ? director.getBot(r) : null;
      if (!p || !isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) out.push(p);
    }
  } catch {
    /* never break */
  }
  return out;
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  return realPlayersNear(director, citizen, radius).length > 0;
}

function doFolkWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const beat = beatFor(record, nowMs);
  const place = beat ? beat.name : "the court steps";
  const court = courtNameFor(record);
  const { start, end } = sessionHours();
  const session = inSessionNow(nowMs);
  const hour = new Date(nowMs).getHours();
  const near40 = realPlayersNear(director, citizen, FOLK_RADIUS);
  // Close-range players for ledger talk (fine/appeal gossip is earshot-only).
  const near14 = near40.filter((p) => withinTiles(citizen, p, LEDGER_RADIUS));

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, pickOne(Math.random, SETUP_LINES));
    journalize(record.username, "Set up the justice beat at " + place + ".");
    return;
  }

  const vars = { place, court, start, end, their: "their" };
  const workLines = WORK_LINES[type] ?? WORK_LINES[MEDIATOR];
  const roll = Math.random();
  let line = null;

  if (type === CLERK) {
    // Law-clerks read the REAL ledger: a nearby real player's real
    // outstanding fine, their real pending appeal, or the real count.
    const fined = near14.map((p) => ({ p, s: ledgerSummaryFor(p.getUsername?.(), nowMs) }))
      .find((x) => x.s.fine > 0);
    const appealed = near14.map((p) => ({ p, s: ledgerSummaryFor(p.getUsername?.(), nowMs) }))
      .find((x) => x.s.appeal);
    const count = ledgerSummaryFor(name, nowMs).fineCount;
    if (fined) {
      line = fill(pickOne(Math.random, CLERK_FINE_LINES), {
        ...vars, name: fined.p.getUsername(), fine: fined.s.fine, kind: fined.s.fineKind,
      });
    } else if (appealed) {
      line = fill(pickOne(Math.random, CLERK_APPEAL_LINES), {
        ...vars, name: appealed.p.getUsername(),
      });
    } else if (count > 0) {
      line = fill(pickOne(Math.random, CLERK_LEDGER_LINES), { ...vars, n: count });
    } else {
      line = pickOne(Math.random, CLERK_COPY_LINES);
    }
    journalize(record.username, "Clerked the court ledger at " + place + ".");
  } else if (type === USHER) {
    if (session) {
      line = fill(pickOne(Math.random, USHER_SESSION_LINES), vars);
      journalize(record.username, "Ushered folk to the session at " + court + ".");
    } else {
      line = fill(pickOne(Math.random, USHER_HOURS_LINES), vars);
      journalize(record.username, "Announced court hours at " + place + ".");
    }
  } else if (type === MEDIATOR) {
    if (roll < 0.4) {
      line = fill(pickOne(Math.random, MEDIATOR_LINES), vars);
    } else if (roll < 0.7) {
      line = fill(pickOne(Math.random, MEDIATOR_COURT_LINES), vars);
    } else {
      line = fill(pickOne(Math.random, workLines), vars);
    }
    journalize(record.username, "Offered mediation at " + place + ".");
  } else { // GAWKER
    // Gawker gossip names ONLY real outstanding fines; crowd lines read
    // ONLY real session state. Never invented.
    const fined = near14.map((p) => ({ p, s: ledgerSummaryFor(p.getUsername?.(), nowMs) }))
      .find((x) => x.s.fine > 0);
    if (fined) {
      line = fill(pickOne(Math.random, GAWKER_FINE_LINES), {
        ...vars, name: fined.p.getUsername(), fine: fined.s.fine, kind: fined.s.fineKind,
      });
    } else if (session) {
      line = fill(pickOne(Math.random, GAWKER_CROWD_LINES), vars);
    } else {
      line = pickOne(Math.random, GAWKER_IDLE_LINES);
    }
    journalize(record.username, "Watched the court crowd at " + place + ".");
  }

  if (!line) line = fill(pickOne(Math.random, workLines), vars);
  forceSay(citizen, line);
}

module.exports = {
  tickJusticefolk,
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
  isProJudge,
  justicefolkTypeOf,
  folkTypeFromRoll,
  beatFor,
  sessionHours,
  inSessionNow,
  courtNameFor,
  ledgerSummaryFor,
  realPlayersNear,
  anyRealPlayerNear,
  MEDIATOR,
  USHER,
  CLERK,
  GAWKER,
  FOLK_TYPES,
  BEATS,
  SETUP_LINES,
  WORK_LINES,
  MEDIATOR_LINES,
  MEDIATOR_COURT_LINES,
  USHER_SESSION_LINES,
  USHER_HOURS_LINES,
  CLERK_COPY_LINES,
  CLERK_LEDGER_LINES,
  CLERK_FINE_LINES,
  CLERK_APPEAL_LINES,
  GAWKER_CROWD_LINES,
  GAWKER_FINE_LINES,
  GAWKER_IDLE_LINES,
  // Tuning:
  FOLK_RADIUS,
  LEDGER_RADIUS,
  FOLK_CITIZEN_COOLDOWN_MS,
  FOLK_CHANCE,
  FOLK_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  SETUP_CUTOFF_HOUR,
  // Test seams:
  _resetState() {
    lastFiredByCitizen.clear();
    lastPruneAt = 0;
    _journal = null;
  },
};
