"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");

/**
 * CitizenHistorians2 — the chroniclerfolk: the street-telling amateur
 * layer under the professional historians. Chronicle-readers read the
 * REAL citizen journal aloud to passersby (retelling only what was
 * actually logged — never invented), day-heralds call out the real day
 * count and the real headcount of souls abroad, tale-scribes offer their
 * jotter to any passerby with a story (amateur jotting, never a
 * commissioned history), and telling-runners work the street circuit
 * between telling spots. Commoners who live off the informal memory
 * trade — the scrappy amateur layer under the real archive system.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived chroniclerfolk types (~35% nominal share of commoners,
 *   post-exclusion), per-day street telling spots (kingdom-preferred,
 *   seeded per day), per-citizen cooldowns, work hours, scripted line
 *   pools, journal retells drawn ONLY from real journal entries, and
 *   rumors seeded from real journal events (CitizenRumors' real
 *   (rng, event) shape — "seed a rumor from a real journal event").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-20:00 server local): setup flavor before 10:00, street retells
 * of things that really happened, day heralds calling the real day
 * count, scribes offering their jotter, runners working the circuit.
 * Real chronicle-writing, record-keeping, commissioned histories,
 * legend preservation and ledger answers are historian tier — this
 * module only retells state, never records it.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the historians block.
 * Plain-node testable: CitizenHistorians2.test.js.
 *
 * No overlap (by design):
 *   - CitizenHistorians (master) owns the PROFESSIONAL history trade:
 *     chroniclers write daily chronicles, archivists keep the record
 *     halls, genealogists trace family lines, lorekeepers preserve
 *     fading legends, and the ledgers answer player requests. Its real
 *     claim predicate is historianTypeOf (CitizenHistorians.js:271) —
 *     an activity system claiming every commoner — whose OPERATIVE
 *     professional-work gate is the tick's own visibility check,
 *     isHobbyVisible(username, "historian") (CitizenHistorians.js:609).
 *     This module wires BOTH real functions via isProHistorian BEFORE
 *     the share roll — no invented criterion. A citizen visibly working
 *     as a professional historian is never chroniclerfolk.
 *     Chroniclerfolk never write chronicles, never keep records, never
 *     take commissioned histories, never preserve legends, never answer
 *     ledger requests. Readers RETELL the journal; they never write it.
 *   - CitizenStorytellers owns oral tales told as the teller's own.
 *     Chronicle-readers never tell tales — they frame every retell as
 *     second-hand and source it from the real journal ("Did you hear?").
 *     (Deliberately NOT included as folk types: tale-weavers, legend-
 *     tellers, epic reciters, memory-keepers of the old wars — those are
 *     storyteller turf.)
 *   - CitizenRetirement owns elders (60+) telling kingdom-history
 *     stories and giving wisdom. Chroniclerfolk are working street
 *     readers of any age — never elder wisdom, never kingdom history
 *     from memory.
 *   - CitizenBards2 owns songs. Chroniclerfolk never sing.
 *   - CitizenNewspaper owns the town criers shouting weekly news.
 *     Day-heralds herald the REAL day count and the real headcount —
 *     never news, never proclamations.
 *   - CitizenLibrarians2 owns bookfolk shelving and reading at the
 *     libraries. Telling-runners work the street telling circuit, never
 *     libraries, never shelves.
 *   - CitizenScribes owns professional scribes. Tale-scribes keep an
 *     amateur jotter — never professional copying, never commissions.
 *   - No other "2" module claims this concept: mentorfolk mentor,
 *     songfolk sing, bookfolk shelve, brewfolk brew, watchmen watch,
 *     fisherfolk fish, minerfolk mine, healers2 care.
 */

// === Tuning: all magic numbers here ===
const FOLK_RADIUS = 40; // tiles — visible work range
const READ_RADIUS = 14; // tiles — close enough to hear a telling
const FOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const FOLK_CHANCE = 0.2; // per eligible citizen per tick
const FOLK_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const WORK_START_HOUR = 8; // 08:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time
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
const ProHistorians = safeRequire("./CitizenHistorians"); // master: the REAL claim predicate (historianTypeOf)
const PrimaryHobby = safeRequire("./CitizenPrimaryHobby"); // the master's own operative work gate (isHobbyVisible)
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const JournalMod = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Chroniclerfolk types ===
const READER = "chronicle-reader"; // street readers: retell REAL journal entries, nothing invented
const HERALD = "day-herald"; // day heralds: real day count + real headcount
const SCRIBE = "tale-scribe"; // amateur jotters: offer to take down a passerby's story
const RUNNER = "telling-runner"; // work the street telling circuit between spots
const FOLK_TYPES = [READER, HERALD, SCRIBE, RUNNER];
const FOLK_WEIGHTS = {
  [READER]: 35,
  [HERALD]: 30,
  [SCRIBE]: 20,
  [RUNNER]: 15,
};

// === Street telling spots — market corners, well-heads, tavern stoops.
// Deliberately OFF the professional archive grounds: no chronicle
// vaults, no scriptoria, no record halls, no libraries. ===
const SPOTS = [
  { name: "the Varrock market-corner bench", kingdom: "misthalin" },
  { name: "the Lumbridge well-head steps", kingdom: "misthalin" },
  { name: "the Falador tavern stoop", kingdom: "asgarnia" },
  { name: "the Port Sarim dockside bench", kingdom: "asgarnia" },
  { name: "the East Ardougne crossroads post", kingdom: "kandarin" },
  { name: "the Catherby beach-path boulder", kingdom: "kandarin" },
  { name: "the Keldagrim plaza fountain rim", kingdom: "keldagrim" },
  { name: "the Dorgeshuun market arch", kingdom: "keldagrim" },
  { name: "the Canifis bridge-side stump", kingdom: "morytania" },
  { name: "the Mort'ton cart-park corner", kingdom: "morytania" },
  { name: "the Al Kharid souk gate bench", kingdom: "kharidian" },
  { name: "the Pollnivneach date-seller's shade", kingdom: "kharidian" },
];

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 10:00 the chroniclerfolk are still setting up.
const SETUP_LINES = [
  "Chalkboard's out.",
  "Setting up the telling corner.",
  "Jotter's open, board is up.",
  "Just getting the telling spot ready.",
];

// Work lines per type (generic flavor — never event claims).
const WORK_LINES = {
  [READER]: [
    "The chronicle grows by the day.",
    "Ask me what the streets remember.",
    "Every telling starts with a true word.",
  ],
  [HERALD]: [
    "Mark the day, friends!",
    "Another day for the telling.",
    "Hear the day's count!",
  ],
  [SCRIBE]: [
    "Jotter's open.",
    "Tell me your story.",
    "I keep the street's accounts.",
  ],
  [RUNNER]: [
    "Running the circuit.",
    "On my rounds.",
    "The telling must travel.",
  ],
};

// Chronicle-reader retell frames — filled ONLY from real journal
// entries ({who} = the logged citizen, {what} = the logged text).
const READ_LINES = [
  "Did you hear? {who}: {what}.",
  "The telling goes: {who} — {what}.",
  "Word from the streets — {who}: {what}.",
];

// Day-herald lines — filled ONLY from real engine state ({day} =
// dayNumber, {count} = real online roster count).
const HERALD_LINES = [
  "Day {day} of the mortal age — {count} souls walk the streets today!",
  "Hear it! Day {day}, and {count} of us are out and about!",
  "The {day}th day since the telling began — {count} souls abroad!",
];

// Tale-scribe offers — scripted invitations, never invented stories.
const SCRIBE_LINES = [
  "Tell me what happened and I'll jot it in my book — the street remembers.",
  "Give me your story, friend, and I'll keep it word for word.",
  "A passerby's tale is tomorrow's history. Tell me yours.",
  "The jotter's open — speak, and I'll write it down.",
];

// Telling-runner circuit lines — filled from the real spot assignment.
const RUNNER_LINES = [
  "Off to {spot2} — the evening telling gathers there.",
  "I run the telling circuit: {spot}, then {spot2}.",
  "The telling travels — {spot2} by dusk!",
];

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

/** Day number since epoch — for daily rhythms and the day herald. */
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

/** True during chroniclerfolk hours (08:00-20:00 server local time). */
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

/** Normalized username via CitizenBonds (fallback: lowercase). */
function normalizeName(name) {
  try {
    if (Bonds && typeof Bonds.normalizeName === "function") return Bonds.normalizeName(name);
  } catch { /* fall through */ }
  return String(name ?? "").toLowerCase();
}

/** Real online roster count (director.isOnline per record). */
function onlineCount(director) {
  try {
    let n = 0;
    for (const r of director.roster?.values?.() ?? []) {
      try {
        if (director.isOnline(r)) n++;
      } catch { /* skip hostile records */ }
    }
    return n;
  } catch {
    return 0;
  }
}

// ============================================================================
// Chroniclerfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the professional historian tier
 * (CitizenHistorians). The master's real claim predicate is
 * historianTypeOf (CitizenHistorians.js:271) — an activity system that
 * claims every commoner, so wiring it alone would zero the folk layer.
 * Its OPERATIVE professional-work gate is the master tick's own
 * visibility check, isHobbyVisible(username, "historian")
 * (CitizenHistorians.js:609): the actual predicate deciding who visibly
 * works as a professional historian. We wire BOTH real functions — no
 * invented criterion — and this exclusion runs BEFORE the share roll.
 * Fail-open when the master tier is absent: a missing master cannot
 * claim anyone. Never throws.
 */
function isProHistorian(record) {
  try {
    if (!ProHistorians || typeof ProHistorians.historianTypeOf !== "function") return false;
    if (!ProHistorians.historianTypeOf(record)) return false;
    if (!PrimaryHobby || typeof PrimaryHobby.isHobbyVisible !== "function") return false;
    return PrimaryHobby.isHobbyVisible(record?.username, "historian") === true;
  } catch {
    return false;
  }
}

/** Weighted pick of a chroniclerfolk type from a 0..99 roll. */
function folkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FOLK_TYPES) {
    acc += FOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return READER;
}

/**
 * The chroniclerfolk type for a roster record, or null.
 * Excludes citizens visibly working as professional historians via the
 * master tier's REAL claim path (historianTypeOf + the tick's own
 * isHobbyVisible "historian" gate) BEFORE the share roll, so it holds
 * regardless of the 35% draw. Uses name-first salts to avoid the
 * FNV-1a prefix-correlation bug.
 */
function chroniclerfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProHistorian(record)) return null;
    const roll = hashStr(name + "|historians2") % 100;
    if (roll >= FOLK_SHARE) return null;
    return folkTypeFromRoll(hashStr(name + "|historians2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Telling spots and per-day seeded assignments.
// ============================================================================

/** The day's street telling spot for a chroniclerfolk citizen: kingdom-preferred, seeded per day. */
function spotFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? SPOTS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : SPOTS;
    const rng = seededRng(hashStr("historian2spot:" + name + ":" + dayNumber(dateMs)));
    return pickOne(rng, src);
  } catch {
    return SPOTS[0];
  }
}

/** A second, distinct spot for the runner's circuit (never equal to the first). */
function secondSpotFor(record, first, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? SPOTS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : SPOTS;
    const rng = seededRng(hashStr("historian2spot2:" + name + ":" + dayNumber(dateMs)));
    let second = pickOne(rng, src);
    if (second === first) second = src[(src.indexOf(first) + 1) % src.length];
    return second;
  } catch {
    return SPOTS[1];
  }
}

// ============================================================================
// Journal + rumors (never throw).
// Canonical: lazy getJournal(), then log(name, kind, text).
// ============================================================================

let _journal = null;
function journal() {
  if (_journal === null) {
    try {
      _journal = (JournalMod && JournalMod.getJournal && JournalMod.getJournal()) || false;
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
 * Seed a rumor from a REAL journal event (CitizenRumors' real
 * (rng, event) shape — "seed a rumor from a real journal event").
 * Never invents content: kind/what/who all come from the journal.
 */
function seedRumorFromEntry(event, whoDisplay, where) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function" && event?.kind && event?.text) {
      Rumors.seedRumor(Math.random, {
        kind: event.kind,
        who: whoDisplay,
        whoDisplay,
        what: event.text,
        where,
      });
    }
  } catch { /* cosmetic */ }
}

/**
 * A real journal entry to retell: the newest recent entry of a nearby
 * materialized citizen (preferring someone else's over the reader's
 * own), or null when the journal is quiet. Every retold event is real
 * logged engine state — never invented.
 */
function retellEntryFor(director, citizen, radius, selfName) {
  try {
    const j = journal();
    if (!j || typeof j.recent !== "function") return null;
    const selfKey = normalizeName(selfName);
    const others = [];
    let own = null;
    for (const r of director.roster?.values?.() ?? []) {
      try {
        if (!director.isOnline(r)) continue;
        const bot = director.getBot(r);
        if (!bot || bot === citizen) continue;
        if (!withinTiles(citizen, bot, radius)) continue;
        const key = normalizeName(r?.username);
        if (!key || key === selfKey) continue;
        const ev = j.recent(key, 1)[0];
        if (!ev || !ev.text) continue;
        others.push({ who: String(r.username ?? key), text: ev.text, event: ev });
      } catch { /* skip hostile records */ }
    }
    if (!others.length && selfKey) {
      const ev = j.recent(selfKey, 1)[0];
      if (ev && ev.text) own = { who: String(selfName), text: ev.text, event: ev };
    }
    const pool = others.length ? others : own ? [own] : [];
    if (!pool.length) return null;
    return pickOne(Math.random, pool);
  } catch {
    return null;
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
// Gate order: cooldown (cheapest) → LOD brain gate → chroniclerfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickHistorianfolk(director, nowMs, desync) {
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

        // 3. Must be chroniclerfolk (hash-derived, cheap; exclusions inside)
        const type = chroniclerfolkTypeOf(record);
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
        console.warn("[citizen-historians2] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-historians2] tick failed:", e?.message ?? e);
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
  const spot2 = secondSpotFor(record, spot, nowMs);
  const place = spot ? spot.name : "the street telling spot";
  const hour = new Date(nowMs).getHours();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, pickOne(Math.random, SETUP_LINES));
    journalize(record.username, "Set up the telling spot at " + place + ".");
    return;
  }

  // Chronicle-reader: retell a REAL journal entry, nothing invented.
  if (type === READER) {
    const entry = retellEntryFor(director, citizen, READ_RADIUS, record.username);
    if (entry) {
      const line = fill(pickOne(Math.random, READ_LINES), {
        who: String(entry.who).slice(0, 24),
        what: String(entry.text).slice(0, 80),
      });
      forceSay(citizen, line);
      journalize(record.username, "Retold a street telling at " + place + ".");
      seedRumorFromEntry(entry.event, entry.who, place);
      return;
    }
    // Journal is quiet: fall back to generic work flavor.
    forceSay(citizen, pickOne(Math.random, WORK_LINES[READER]));
    journalize(record.username, "Kept the telling corner at " + place + ".");
    return;
  }

  // Day-herald: the REAL day count and the REAL headcount.
  if (type === HERALD) {
    const line = fill(pickOne(Math.random, HERALD_LINES), {
      day: dayNumber(nowMs),
      count: onlineCount(director),
    });
    forceSay(citizen, line);
    journalize(record.username, "Heralded the day at " + place + ".");
    return;
  }

  // Tale-scribe: scripted offer lines — never an invented story.
  if (type === SCRIBE) {
    const line = pickOne(Math.random, SCRIBE_LINES);
    forceSay(citizen, line);
    journalize(record.username, "Offered the jotter to passersby at " + place + ".");
    return;
  }

  // Telling-runner: the circuit between real street spots.
  if (type === RUNNER) {
    const line = fill(pickOne(Math.random, RUNNER_LINES), {
      spot: spot ? spot.name : "the telling spot",
      spot2: spot2 ? spot2.name : "the telling spot",
    });
    forceSay(citizen, line);
    journalize(record.username, "Ran the telling circuit at " + place + ".");
    return;
  }

  // Defensive: generic work flavor.
  forceSay(citizen, pickOne(Math.random, WORK_LINES[READER]));
  journalize(record.username, "Kept the telling corner at " + place + ".");
}

module.exports = {
  tickHistorianfolk,
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
  onlineCount,
  isProHistorian,
  chroniclerfolkTypeOf,
  folkTypeFromRoll,
  spotFor,
  secondSpotFor,
  retellEntryFor,
  anyRealPlayerNear,
  READER,
  HERALD,
  SCRIBE,
  RUNNER,
  FOLK_TYPES,
  FOLK_SHARE,
  FOLK_RADIUS,
  READ_RADIUS,
  FOLK_CHANCE,
  SPOTS,
  SETUP_LINES,
  WORK_LINES,
  READ_LINES,
  HERALD_LINES,
  SCRIBE_LINES,
  RUNNER_LINES,
  // Test seams:
  _resetState() {
    lastFiredByCitizen.clear();
    lastPruneAt = 0;
    _journal = null;
  },
};
