"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenCartographers2 — the mapfolk: amateur map-scratchers under the
 * professional cartographers. Map-sketchers draw rough pencil copies on
 * street corners, chart-hawkers sell cheap hand-copies from corner kiosks,
 * and rough-drafters ink coarse route charts for departing travelers.
 * Commoners who live off the rough-copy map economy — the scrappy amateur
 * layer under the professional chart houses.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived mapfolk types (~35% nominal share of commoners,
 *   post-exclusion), per-day corner kiosks (kingdom-preferred, seeded per
 *   day), per-day rough sketches, per-kingdom-per-day ink-spill /
 *   wrong-way set-pieces plus a once-per-kiosk-per-day copy-dispute crowd
 *   moment (journaled + rumor-seeded), and a read-only pro-charts bridge
 *   that lets mapfolk small talk name the real CitizenCartographers
 *   studios and their charted discoveries. Morning setup flavor before
 *   10:00, midday hawking after.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 07:00-18:00 local): scripted setup flavor, sketch cries, pro-charts
 * small talk, the inkwell tipping over a corner copy, a wrong-way buyer
 * storming back, a copy dispute gathering round a kiosk. Real map sales
 * and commissions are LLM tier — this module only tracks state, timers
 * and the visible street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the professional cartographers
 * block.
 * Plain-node testable: CitizenCartographers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenCartographers (master) owns the PROFESSIONAL chart trade:
 *     surveyors pacing the field with chains, mapmakers drafting at chart
 *     desks, chart-explorers, the day's map catalogs, masterwork unveilings,
 *     commissions and survey hires. The master's claim predicate is its
 *     real claimed-type function, cartographerTypeFor (primary profession
 *     "cartographer" partition). This exclusion is checked via the real
 *     function BEFORE the share roll — a professional cartographer is never
 *     mapfolk. Mapfolk never touch the master's commissions / survey-hire
 *     / player-discovery ledgers or draft above "rough" quality: no fine
 *     charts, no masterworks, no professional survey work, no chart-house
 *     stalls — corner kiosks only.
 *   - CitizenHawkers2 owns amateur BASKET-cryers with no fixed pitch —
 *     excluded via the real claim function (hawkerTypeOf) BEFORE the share
 *     roll: a citizen who cries from a basket never also keeps a map kiosk.
 *     Chart-hawkers hawk from a kiosk corner; hawkers cry with no pitch.
 *   - CitizenScribes own professional copying and document work — mapfolk
 *     draw rough maps only, never letters, ledgers or scroll copies.
 *   - CitizenPainters own the fine art trade — a map sketch is a rough
 *     wayfinding copy, never a painting, portrait or mural.
 *   - CitizenMessengers own news proclamation — mapfolk cry their sketches
 *     only, never news or decrees.
 *   - CitizenGuards/CitizenWatchmen own the watch — mapfolk sell copies
 *     and get ink everywhere, never patrol or stand guard.
 */

// === Tuning: all magic numbers here ===
const MAPFOLK_RADIUS = 40; // tiles — visible work range
const OFFER_RADIUS = 14; // tiles — sketch offers, close enough to hear
const MAPFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const OFFER_COOLDOWN_MS = 4 * 60 * 60 * 1000; // sketch offers at most every 4h
const MAPFOLK_CHANCE = 0.2; // per eligible citizen per tick
const OFFER_CHANCE = 0.35;
const MAPFOLK_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const INK_SPILL_CHANCE = 0.06; // ~6% per kingdom per day: the inkwell tips over a corner copy
const WRONG_WAY_CHANCE = 0.07; // ~7% per kingdom per day: a buyer comes back fuming about a bad chart
const COPY_DISPUTE_CHANCE = 0.08; // ~8% per corner kiosk per day: a copy dispute gathers a crowd
const WORK_START_HOUR = 7; // 07:00 server local time (set up with the morning hawkers)
const WORK_END_HOUR = 18; // 18:00 server local time (pack before the chart houses wind down at 19)
const SETUP_CUTOFF_HOUR = 10; // before 10:00: setup flavor instead of midday hawking

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProCartos = safeRequire("./CitizenCartographers"); // master: real claim fn + read-only studio/discovery bridge
const Hawkers2 = safeRequire("./CitizenHawkers2"); // basket-cryers: real claim fn, exclusion
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Mapfolk types ===
const MAP_SKETCHER = "map-sketcher";
const CHART_HAWKER = "chart-hawker";
const ROUGH_DRAFTER = "rough-drafter";
const MAP_TYPES = [MAP_SKETCHER, CHART_HAWKER, ROUGH_DRAFTER];
const MAP_WEIGHTS = {
  [MAP_SKETCHER]: 40,
  [CHART_HAWKER]: 35,
  [ROUGH_DRAFTER]: 25,
};

// === Corner kiosks — street corners, ferry steps, gate posts and waycorners.
// Amateur map pitches, deliberately OFF the professional chart-house studios:
// no chart room, no map desk, no market chart stall of the pro trade. ===
const KIOSKS = [
  { name: "the Varrock east-gate corner kiosk", kingdom: "misthalin" },
  { name: "the Lumbridge mud-track waycorner", kingdom: "misthalin" },
  { name: "the Falador west-wall steps kiosk", kingdom: "asgarnia" },
  { name: "the Port Sarim ferry-landing kiosk", kingdom: "asgarnia" },
  { name: "the East Ardougne market-fringe kiosk", kingdom: "kandarin" },
  { name: "the Catherby jetty-steps corner", kingdom: "kandarin" },
  { name: "the Keldagrim north-tier stair kiosk", kingdom: "keldagrim" },
  { name: "the Dorgeshuun torch-wall corner", kingdom: "keldagrim" },
  { name: "the Canifis fence-line kiosk", kingdom: "morytania" },
  { name: "the Burgh de Rott gate-post corner", kingdom: "morytania" },
  { name: "the Al Kharid souk-fringe kiosk", kingdom: "kharidian" },
  { name: "the Pollnivneach well-steps corner", kingdom: "kharidian" },
];

// === The rough sketches — cheap hand copies, deliberately nothing a
// professional chart house would draft. Everything is a rough sketch:
// amateurs never ink a fine chart or a masterwork. ===
const SKETCHES = {
  [MAP_SKETCHER]: [
    "a rough sketch of {region}",
    "a charcoal copy of the {region} coast",
    "a smudged pencil-map of {region}",
    "a wax-pencilled route through {region}",
    "a traveller's hand-sketch of {region}",
  ],
  [CHART_HAWKER]: [
    "a hand-copy of the {region} road chart",
    "a cheap copy of the {region} market chart",
    "a smudged hand-copy, {region} bound",
    "a corner-kiosk chart of {region}",
    "a folded copy-chart of {region}",
  ],
  [ROUGH_DRAFTER]: [
    "a coarse route-chart through {region}",
    "a rough traveller's chart of {region}",
    "an ink-stained way-chart for {region}",
    "a quick-drafted {region} route sketch",
    "a rough distance-chart of {region}",
  ],
};

// === Regions mapfolk sketch (kingdom-preferred subjects). ===
const MAPFOLK_REGIONS = [
  { name: "Misthalin", kingdom: "misthalin" },
  { name: "Asgarnia", kingdom: "asgarnia" },
  { name: "Kandarin", kingdom: "kandarin" },
  { name: "the Fremennik isles", kingdom: "keldagrim" },
  { name: "Morytania", kingdom: "morytania" },
  { name: "the Kharidian desert", kingdom: "kharidian" },
  { name: "the Wilderness borderlands", kingdom: "misthalin" },
  { name: "the southern coast", kingdom: "kandarin" },
];

// === Line pools — all scripted, zero LLM. ===

// Morning setup flavor: before 10:00 the mapfolk are still setting up.
const SETUP_LINES = [
  "Kiosk's open, maps for sale.",
  "Setting up the map stand.",
  "Prices chalked on the corner.",
  "Just pinning up today's copies.",
];

// Work lines per type.
const WORK_LINES = {
  [MAP_SKETCHER]: [
    "Sketching maps.",
    "Rough sketches here.",
    "Map sketcher working.",
    "Detailed sketches.",
    "Maps drawn to order.",
  ],
  [CHART_HAWKER]: [
    "Charts! Get your charts!",
    "Hawking maps here.",
    "Fresh charts!",
    "Best charts in town!",
    "Hawking daily.",
  ],
  [ROUGH_DRAFTER]: [
    "Rough drafts here.",
    "Drafting plans.",
    "Sketches cheap.",
    "Drafts cheap!",
    "Wobbly but works.",
  ],
};

// Chart-hawkers hawk the day's copies.
const HAWK_LINES = {
  [MAP_SKETCHER]: [
    "Sketches! Rough maps of {region}, drawn by my own hand!",
    "A rough sketch of {region} — cheap, and cheaper than getting lost!",
    "Traveller! Take a rough copy of {region}, mind the smudges!",
    "Detailed sketches.",
    "Maps drawn to order.",
  ],
  [CHART_HAWKER]: [
    "Hand-copies! {region} road charts, copied fair by my own hand!",
    "Copies of the {region} chart — a copper, take your pick!",
    "Cheap charts! {region}, smudged a little, priced a lot little!",
    "Best charts in town!",
    "Hawking daily.",
  ],
  [ROUGH_DRAFTER]: [
    "Route-charts! A rough draft of {region} for a copper or two!",
    "Heading out? A coarse chart of {region}, inked this morning!",
    "Rough charts for travellers — {region}, take one for the road!",
    "Drafts cheap!",
    "Wobbly but works.",
  ],
};

// Small talk that names the real professional chart trade (read-only
// bridge: pro studio names and discoveries from the master module).
const PRO_TALK_LINES = [
  "The {studio} sells proper charts — mine's the rough corner copy, friend.",
  "Heard the chart folk at {studio} inked {discovery} — my copy's still catching up!",
  "{discovery}, the pros call it — my sketch of it is honest guesswork!",
  "A masterwork at {studio}? Lovely. Mine's rough, and a tenth of the price.",
];

// Rough-drafter sketch offers for lingering travelers.
const OFFER_LINES = [
  "Heading somewhere? I'll rough you a route-chart for a copper or two.",
  "Tell me where you're bound and I'll sketch you the rough of it.",
  "Need a way-chart? My pen's quick and my prices quicker.",
];

// Ink-spill set-piece: the inkwell tips over a corner copy.
const INK_SPILL_LINES = [
  "The inkwell's tipped — the whole corner copy's ruined!",
  "(a black bloom spreads across the sketch) Oh no — not the good copy!",
  "Ink everywhere! The sketch's gone, the kiosk is gone, I'm gone!",
];

// Wrong-way set-piece: a buyer storms back about a bad chart.
const WRONG_WAY_LINES = [
  "A buyer came storming back — my rough chart sent them the wrong way up {region}!",
  "That fuming traveller? My copy-chart of {region} — wrong bend in the river!",
  "(a shouting match by the kiosk) — the copy of {region} had the ford backwards!",
];

// Copy-dispute crowd moment: once per kiosk per day, two buyers argue over
// a smudged copy.
const DISPUTE_LINES = [
  "Two buyers arguing over the same smudged copy at {place} — pass the ink!",
  "A dispute at {place} — both want the one legible chart of {region}!",
  "The crowd's gathering at {place} — a smudged copy and two angry travellers!",
];

// === Cooldown state (monotonic Date.now() timestamps) ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastOfferByCitizen = new Map(); // username -> timestamp
// Once-per-day set-piece keys:
//   "inkspill:<kid>:<day>", "wrongway:<kid>:<day>", "dispute:<kiosk-index>:<day>"
const firedDayKeys = new Set();
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastOfferByCitizen) {
    if (at < cutoff) lastOfferByCitizen.delete(k);
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

/** True during amateur map hours (07:00-18:00 server local time). */
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
// Mapfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when this citizen is claimed by the MASTER CitizenCartographers
 * professional trade. The master's claim predicate is its real
 * claimed-type function, cartographerTypeFor (primary profession
 * "cartographer" partition): those citizens run the real chart trade —
 * surveyors, mapmakers, chart-explorers, sellers with chart houses, day
 * catalogs, masterworks, commissions and survey hires. The 2-layer owns
 * amateur mapfolk only, so this exclusion runs BEFORE the share roll.
 * Fail-open when the master is absent: a missing master cannot claim
 * anyone. Never throws.
 */
function isProCartographer(username) {
  try {
    if (!ProCartos || typeof ProCartos.cartographerTypeFor !== "function") return false;
    return ProCartos.cartographerTypeFor(username) !== null;
  } catch {
    return false;
  }
}

/**
 * True when CitizenHawkers2 claims this citizen — called through the
 * hawkers' real claim function (hawkerTypeOf), i.e. its null path, so
 * basket-cryers with no pitch are never also mapfolk. Never throws.
 */
function isHawkerfolk(record) {
  try {
    if (!Hawkers2 || typeof Hawkers2.hawkerTypeOf !== "function") return false;
    return Hawkers2.hawkerTypeOf(record) !== null;
  } catch {
    return false;
  }
}

/** Weighted pick of a map type from a 0..99 roll. */
function mapTypeFromRoll(roll) {
  let acc = 0;
  for (const t of MAP_TYPES) {
    acc += MAP_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return MAP_SKETCHER;
}

/**
 * The map type for a roster record, or null.
 * Excludes the professional cartographers (master claim, checked via the
 * real cartographerTypeFor) and the hawkerfolk (basket-cryers have no
 * kiosk). Both exclusions run BEFORE the share roll, so they hold
 * regardless of the 35% draw. Uses name-first salts to avoid the FNV-1a
 * prefix-correlation bug.
 */
function mapfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isProCartographer(name)) return null;
    if (isHawkerfolk(record)) return null;
    const roll = hashStr(name + "|cartographers2") % 100;
    if (roll >= MAPFOLK_SHARE) return null;
    return mapTypeFromRoll(hashStr(name + "|cartographers2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Kiosks, sketches, and the read-only pro-charts bridge.
// ============================================================================

/** The day's corner kiosk for a mapfolk citizen: kingdom-preferred, seeded per day. */
function kioskFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? KIOSKS.filter((s) => String(s.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : KIOSKS;
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|mapkiosk:" + day));
    return pickOne(rng, src);
  } catch {
    return null;
  }
}

/** The day's sketched region for a mapfolk citizen: kingdom-preferred, stable per day. */
function regionFor(record, dateMs = Date.now()) {
  try {
    const kid = record?.kingdomId ?? record?.kingdom;
    const name = normalizeName(record?.username) || "anon";
    const local = kid
      ? MAPFOLK_REGIONS.filter((r) => String(r.kingdom).toLowerCase() === String(kid).toLowerCase())
      : [];
    const src = local.length ? local : MAPFOLK_REGIONS;
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|mapregion:" + day));
    return pickOne(rng, src);
  } catch {
    return null;
  }
}

/** Today's rough sketch for a mapfolk citizen: seeded per day — the same
 * copy all day. Amateurs only ever draft rough sketches. */
function sketchFor(username, type, kingdomId, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const pool = SKETCHES[type] ?? SKETCHES[MAP_SKETCHER];
    const region = regionFor({ username: name, kingdom: kingdomId }, dateMs);
    const regionName = region ? region.name : "Misthalin";
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|mapsketch:" + day));
    return fill(pickOne(rng, pool), { region: regionName });
  } catch {
    return null;
  }
}

/**
 * Pro-charts small talk that names the real professional chart trade.
 * Read-only bridge: studio names and discovery pool come from the master
 * module — mapfolk small talk stays consistent with the actual chart
 * houses, and the master's state is never touched. Never throws.
 */
function proChartsTalkFor(kingdomId, dateMs = Date.now()) {
  try {
    const studios = (ProCartos && Array.isArray(ProCartos.STUDIOS)) ? ProCartos.STUDIOS : [];
    const discoveries = (ProCartos && Array.isArray(ProCartos.DISCOVERIES)) ? ProCartos.DISCOVERIES : [];
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr("mapprotalk|" + String(kingdomId ?? "").toLowerCase() + ":" + day));
    const line = pickOne(rng, PRO_TALK_LINES);
    const pool = studios.length
      ? studios.filter((s) => String(s.kingdom).toLowerCase() === String(kingdomId ?? "").toLowerCase())
      : [];
    const studio = (pool.length ? pickOne(rng, pool) : pickOne(rng, studios)) || { name: "the chart house" };
    const discovery = discoveries.length ? pickOne(rng, discoveries) : "a new coastline";
    return fill(line, { studio: studio.name, discovery });
  } catch {
    return null;
  }
}

// === Journal + rumor wiring (best-effort, never throws) ===

// Master-pattern journal call: journals feed the LLM dialogue tier.
let _journalEvent = null;
function journalEvent() {
  if (_journalEvent === null) {
    try {
      _journalEvent = (Journal && Journal.journalEvent) || (require("./CitizenJournal").journalEvent || false);
    } catch {
      _journalEvent = false;
    }
  }
  return _journalEvent;
}

function journalize(username, text) {
  try {
    const j = journalEvent();
    if (j) j(username, text, "mapfolk");
  } catch {
    // best-effort
  }
}

function seedRumor(rng, event) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor(rng, event);
  } catch { /* rumors absent */ }
}

/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → mapfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickMapfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < MAPFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible map life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be mapfolk (hash-derived, cheap; exclusions inside)
        const type = mapfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. Work hours only (amateur map hours: 7 to 18)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within visible range
        if (!anyRealPlayerNear(director, citizen, MAPFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, MAPFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doMapWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-cartographers2] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: ink-spills, wrong-ways, copy disputes (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-cartographers2] tick failed:", e?.message ?? e);
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

function doMapWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const kiosk = kioskFor(record, nowMs);
  const place = kiosk ? kiosk.name : "the corner kiosk";
  const region = regionFor(record, nowMs);
  const regionName = region ? region.name : "Misthalin";
  const sketch = sketchFor(name, type, kid, nowMs) ?? "a rough sketch";
  const hour = new Date(nowMs).getHours();

  if (hour < SETUP_CUTOFF_HOUR) {
    // Morning setup flavor.
    forceSay(citizen, pickOne(Math.random, SETUP_LINES));
    journalize(record.username, "Set up the map kiosk at " + place + ".");
    return;
  }

  // Midday: visible work emotes, hawking cries, plus pro-charts small talk.
  const vars = { region: regionName, place, sketch, their: "their" };
  const workLines = WORK_LINES[type] ?? WORK_LINES[MAP_SKETCHER];
  const cries = HAWK_LINES[type] ?? HAWK_LINES[MAP_SKETCHER];
  const roll = Math.random();
  let line;
  if (roll < 0.35) {
    line = fill(pickOne(Math.random, workLines), vars);
  } else if (roll < 0.65) {
    line = fill(pickOne(Math.random, cries), vars);
  } else {
    line = proChartsTalkFor(kid, nowMs) || fill(pickOne(Math.random, cries), vars);
  }
  forceSay(citizen, line);
  journalize(record.username, "Worked the " + type + " trade at " + place + ": " + sketch + ".");

  // Rough-drafters offer sketch commissions to lingering travelers.
  const lastOff = lastOfferByCitizen.get(record.username) || 0;
  if (type === ROUGH_DRAFTER && nowMs - lastOff >= OFFER_COOLDOWN_MS && Math.random() < OFFER_CHANCE) {
    if (anyRealPlayerNear(director, citizen, OFFER_RADIUS)) {
      forceSay(citizen, fill(pickOne(Math.random, OFFER_LINES), vars));
      journalize(record.username, "Offered a rough route-chart to a traveller at " + place + ".");
      lastOfferByCitizen.set(record.username, nowMs);
    }
  }
}

/**
 * Daily set-pieces, once per kingdom/kiosk per day:
 *   - ink-spill: a sketcher's inkwell tips over a corner copy (~6%)
 *   - wrong-way: a fuming buyer storms back about a bad chart (~7%, rumor-seeded)
 *   - copy dispute: two buyers argue over a smudged copy at a kiosk (~8%)
 * Day-gated keys, cheap to evaluate. Never throws.
 */
function dailyRhythms(director, nowMs) {
  try {
    const day = dayNumber(nowMs);
    const rng = seededRng(hashStr("mapfolk-day:" + day));
    const online = typeof director.onlinePlayers === "function" ? director.onlinePlayers() : [];
    const realNearKiosk = online.some((p) => isRealPlayer(p));
    if (!realNearKiosk) return; // no audience — skip the whole street scene
    const kids = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];

    for (const kid of kids) {
      const spillKey = "inkspill:" + kid + ":" + day;
      if (!firedDayKeys.has(spillKey) && rng() < INK_SPILL_CHANCE) {
        firedDayKeys.add(spillKey);
        const event = pickOne(rng, INK_SPILL_LINES);
        journalize("mapfolk-" + kid, event + " (" + kid + " kiosk)");
        seedRumor(rng, event);
      }
      const wrongKey = "wrongway:" + kid + ":" + day;
      if (!firedDayKeys.has(wrongKey) && rng() < WRONG_WAY_CHANCE) {
        firedDayKeys.add(wrongKey);
        const region = pickOne(rng, MAPFOLK_REGIONS);
        const event = fill(pickOne(rng, WRONG_WAY_LINES), { region: region.name });
        journalize("mapfolk-" + kid, event);
        seedRumor(rng, event);
      }
    }

    for (let i = 0; i < KIOSKS.length; i++) {
      const key = "dispute:" + i + ":" + day;
      if (firedDayKeys.has(key) || rng() >= COPY_DISPUTE_CHANCE) continue;
      firedDayKeys.add(key);
      const kiosk = KIOSKS[i];
      const region = pickOne(rng, MAPFOLK_REGIONS);
      journalize(
        "mapfolk-" + kiosk.kingdom,
        fill(pickOne(rng, DISPUTE_LINES), { place: kiosk.name, region: region.name })
      );
    }
  } catch {
    // set-pieces are cosmetic
  }
}

module.exports = {
  tickMapfolk,
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
  isProCartographer,
  isHawkerfolk,
  mapfolkTypeOf,
  mapTypeFromRoll,
  kioskFor,
  regionFor,
  sketchFor,
  proChartsTalkFor,
  anyRealPlayerNear,
  MAP_SKETCHER,
  CHART_HAWKER,
  ROUGH_DRAFTER,
  MAP_TYPES,
  KIOSKS,
  SKETCHES,
  MAPFOLK_REGIONS,
  SETUP_LINES,
  WORK_LINES,
  HAWK_LINES,
  PRO_TALK_LINES,
  OFFER_LINES,
  INK_SPILL_LINES,
  WRONG_WAY_LINES,
  DISPUTE_LINES,
  // Test seams:
  _firedDayKeys: firedDayKeys,
  _resetState() {
    lastFiredByCitizen.clear();
    lastOfferByCitizen.clear();
    firedDayKeys.clear();
    lastPruneAt = 0;
    _journalEvent = null;
  },
};
