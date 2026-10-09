"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenHerbalists2 — the hedgerow herbfolk: amateur foragers who pick
 * kitchen weeds from the hedgerows, dry petals for potpourri, tend window
 * boxes, and weed garden beds for hire. Commoners who live off the
 * informal, non-potion side of the green trade — soup greens and scented
 * sachets under the professional herbalists' noses.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived herbfolk types, per-day baskets of hedgerow greens and
 *   petals, hedgerow-patch and window-box assignments, garden-weeder job
 *   lists, a 24h-TTL gather-request ledger with deterministic 1-3h
 *   completion, and hedgerow-glut + wasp-nest set-pieces (~8%/day each,
 *   journaled + rumor-seeded). The professionals' headline herb is
 *   cross-read from CitizenHerbalists so herbfolk can point players at the
 *   proper trade ("the proper herbalists are after {herb} today — I only
 *   pick kitchen weeds").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted foraging offers with today's greens, petal
 * and window-box lines, weeder-for-hire pitches, ready-gather callouts
 * that name the nearby player (interaction priority), and pro-herb small
 * talk. Gather dialogue itself is LLM tier — this module only tracks
 * state, timers and the visible street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the errand-runners block.
 * Plain-node testable: CitizenHerbalists2.test.js.
 *
 * No overlap (by design):
 *   - CitizenHerbalists owns the PROFESSIONAL herb trade (gathering
 *     grounds, potion herbs, herblore lessons, rare finds) — herbalists
 *     are excluded via the real module's null path (isHerbalist).
 *   - CitizenHealers own remedies and care — herbfolk never treat or
 *     dose anyone.
 *   - CitizenFarmers own crop growing — herbfolk weed and pick, never
 *     plant fields.
 *   - CitizenCooks own the cooking trade — herbfolk sell raw greens only.
 */

// === Tuning: all magic numbers here ===
const HERBFOLK_RADIUS = 14; // tiles — close enough to see/hear
const HERBFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const HERBFOLK_CHANCE = 0.15; // per eligible citizen per tick
const HERBFOLK_SHARE = 45; // ~45% nominal share of commoners (post-exclusion)
const GLUT_CHANCE = 0.08; // ~8% per patch per day: a hedgerow glut
const WASP_CHANCE = 0.08; // ~8% per kingdom per day: a disturbed wasp nest
const WORK_START_HOUR = 6; // 06:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time
const GATHER_TTL_MS = 24 * 3600 * 1000; // gather requests linger a day

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProHerbalists = safeRequire("./CitizenHerbalists");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Herbfolk types ===
const HEDGEROW_FORAGER = "hedgerow-forager";
const PETAL_DRIER = "petal-drier";
const WINDOW_TENDER = "window-tender";
const GARDEN_WEEDER = "garden-weeder";
const HERBFOLK_TYPES = [
  HEDGEROW_FORAGER,
  PETAL_DRIER,
  WINDOW_TENDER,
  GARDEN_WEEDER,
];
const HERBFOLK_WEIGHTS = {
  [HEDGEROW_FORAGER]: 35,
  [PETAL_DRIER]: 25,
  [WINDOW_TENDER]: 20,
  [GARDEN_WEEDER]: 20,
};

// === Kitchen greens the foragers pick — real hedgerow food, never potion
// herbs. The potion herbs (guam, marrentill, tarromin...) are the
// professionals' trade; herbfolk pick what goes in the soup pot. ===
const HEDGEROW_GREENS = [
  "nettles",
  "dandelion greens",
  "sorrel",
  "chickweed",
  "garlic mustard",
  "elderflower",
  "wild garlic",
  "plantain leaf",
];

// === Petals the driers turn into potpourri and sachets ===
const DRIED_PETALS = [
  "rose petals",
  "lavender sprigs",
  "marigold heads",
  "chamomile flowers",
  "violet petals",
  "honeysuckle",
  "elderflower heads",
  "mint bundles",
];

// === Weeding jobs the garden-weeders get asked for ===
const WEED_JOBS = [
  "clearing couch grass from the Widow Penn's garden",
  "weeding the chandler's herb bed",
  "pulling thistles behind the bakery",
  "tidying the priest's vegetable plot",
  "clearing docksides of bindweed",
  "weeding the apothecary's demonstration bed",
  "neat the inn's courtyard beds",
  "pulling nettles from the well square",
];

// === Where the herbfolk work: hedgerow patches, walls and window boxes —
// distinct from the professionals' gathering grounds ===
const HERB_PATCHES = [
  { name: "the Varrock hedgerows", kingdom: "misthalin" },
  { name: "Candle Lane's cottage walls", kingdom: "misthalin" },
  { name: "the Falador city walls", kingdom: "asgarnia" },
  { name: "the Rimmington cottage hedges", kingdom: "asgarnia" },
  { name: "the Ardougne kitchen gardens", kingdom: "kandarin" },
  { name: "the Hemenster allotments", kingdom: "kandarin" },
  { name: "the Keldagrim tenement window boxes", kingdom: "keldagrim" },
  { name: "the Dorgesh market hedges", kingdom: "keldagrim" },
  { name: "the Darkmeyer walled gardens", kingdom: "morytania" },
  { name: "the Al Kharid oasis hedges", kingdom: "kharidian" },
];

// === Scripted lines ===
const FORAGE_LINES = [
  "Greens! Fresh {greens} picked this morning — soup's own!",
  "{greens}, still dewy! Kitchen weeds, yes, but honest ones!",
  "Forager's basket today: {greens}. A copper the bundle!",
  "Picked before the dew was off — {greens}, straight from the hedgerow!",
];

const PETAL_LINES = [
  "Potpourri! Dried {petals} — make your linens smell like a garden!",
  "Scented sachets of {petals}, a copper each — moths hate them!",
  "Drying {petals} today. The whole street smells of it!",
  "Nothing cheers a room like dried {petals}. Copper a sachet!",
];

const WINDOW_LINES = [
  "Watering the window boxes — you'd be amazed what grows in a trough!",
  "Tending the boxes on {patch}. Even stone walls want green!",
  "Snip, snip — the window herbs on {patch} need their haircut!",
  "My window boxes beat the market stalls, and I'll tell anyone so!",
];

const WEEDER_LINES = [
  "Weeding for hire! {job} this morning — copper the hour!",
  "Hands in the dirt today — {job}.",
  "Your garden wants weeding and my hands want work — {job} first!",
  "No weed survives me! Currently: {job}.",
];

const PRO_HERB_LINES = [
  "The proper herbalists are after {herb} today — I only pick kitchen weeds!",
  "Leave the {herb} to the herbalists. My trade is soup greens and sachets!",
  "You want {herb}? Ask at the apothecary. You want supper greens? Ask me!",
];

const READY_GATHER_LINES = [
  "{player}! Your bundle of {green} — picked fresh, just as you asked!",
  "Back from the hedgerow, {player}! Here's your {green}, still dewy!",
  "{player} — got your {green}. A copper, as agreed!",
];

const GLUT_LINES = [
  "Hedgerow glut! {greens} everywhere at {patch} — take all you want!",
  "The hedges have gone mad at {patch} — {greens} by the armful!",
  "Too many greens! {patch} is bursting with {greens} — help me pick!",
];

const WASP_LINES = [
  "Wasp nest! I disturbed one at {patch} — run past quick and don't swat!",
  "Mind the hedgerow at {patch} — something with wings is angry in there!",
  "Got stung at {patch} — the wasps are defending their greens this morning!",
];

const DAILY_TASK_LINES = {
  [HEDGEROW_FORAGER]: [
    "scouting the hedgerows for new patches",
    "soaking nettles for soup",
    "waxing the gathering basket",
    "chalking the day's picking round on the doorpost",
  ],
  [PETAL_DRIER]: [
    "spreading petals on the drying racks",
    "sewing linen sachets",
    "grinding dried lavender",
    "sorting petals by color",
  ],
  [WINDOW_TENDER]: [
    "re-potting the window boxes",
    "pricking out seedlings",
    "watering the wall troughs",
    "tying back the trailing thyme",
  ],
  [GARDEN_WEEDER]: [
    "sharpening the weeding fork",
    "knocking on doors for weeding work",
    "stacking pulled weeds for the compost",
    "mending the kneeling pad",
  ],
};

// === Cooldown state ===
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

// === Ledgers (TTL'd) ===
const gatherRequests = new Map(); // normPlayerName -> { gather }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of gatherRequests) {
    if (v.gather.until <= nowMs) gatherRequests.delete(k);
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

/** Weighted pick of a herbfolk type from a 0..99 roll. */
function herbfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of HERBFOLK_TYPES) {
    acc += HERBFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return HEDGEROW_FORAGER;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during work hours (06:00-20:00 server local time). */
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
// Herbfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The herbfolk type for a roster record, or null.
 * Excludes the professional herbalists (the real CitizenHerbalists
 * isHerbalist — it has a null path, so it is a valid eligibility gate):
 * the pros own the potion-herb trade, herbfolk own kitchen weeds.
 * Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function herbfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the professional herbalists own the potion-herb trade.
    if (ProHerbalists && typeof ProHerbalists.isHerbalist === "function") {
      try {
        if (ProHerbalists.isHerbalist(record)) return null;
      } catch { /* pro check failed */ }
    }
    const roll = hashStr(name + "|herbfolk") % 100;
    if (roll >= HERBFOLK_SHARE) return null;
    return herbfolkTypeFromRoll(hashStr(name + "|herbfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred herb-patch assignment, stable across restarts. */
function patchFor(record) {
  const kid = record?.kingdomId ?? record?.kingdom;
  const local = HERB_PATCHES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : HERB_PATCHES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|herb-patch") % pool.length];
}

/** Today's hedgerow greens for a forager (stable per day). */
function greensForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|herb-greens:" + day));
  return pickOne(rng, HEDGEROW_GREENS);
}

/** Today's dried petals for a petal-drier (stable per day). */
function petalsForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|herb-petals:" + day));
  return pickOne(rng, DRIED_PETALS);
}

/** Today's weeding job for a garden-weeder (stable per day). */
function weedJobForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|herb-weed:" + day));
  return pickOne(rng, WEED_JOBS);
}

/** Today's task for an herbfolk citizen (1 task of the day). */
function taskForToday(username, type, dateMs) {
  const tasks = DAILY_TASK_LINES[type] ?? DAILY_TASK_LINES[HEDGEROW_FORAGER];
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|herb-task:" + day));
  return pickOne(rng, tasks);
}

/**
 * A hedgerow glut at a patch (~8%/day), or null: the hedges are bursting
 * and the foragers are selling off armfuls. Journaled + rumor-seeded by
 * dailyRhythms.
 */
function glutFor(patch, dateMs) {
  if (!patch?.name) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(patch.name + "|hedgerow-glut:" + day));
  if (rng() >= GLUT_CHANCE) return null;
  const greens = HEDGEROW_GREENS[rng() * HEDGEROW_GREENS.length | 0];
  return { greens };
}

/**
 * A disturbed wasp nest in a kingdom (~8%/day), or null: a forager found
 * the one patch nobody should pick today. Journaled + rumor-seeded by
 * dailyRhythms.
 */
function waspNestFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|wasp-nest:" + day));
  if (rng() >= WASP_CHANCE) return null;
  return true;
}

// ============================================================================
// Real-data bridges — the professional herbalists, cross-read.
// ============================================================================

/**
 * Read-only bridge: today's headline potion herb from the professional
 * trade, so herbfolk small talk stays consistent with what the real
 * herbalists are actually gathering. Never throws.
 */
function proHeadlineHerb(username, kingdom, nowMs = Date.now()) {
  try {
    if (!ProHerbalists || typeof ProHerbalists.herbOfTheDay !== "function") return null;
    const h = ProHerbalists.herbOfTheDay(username, kingdom, nowMs);
    return h?.name ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/**
 * A forager takes a gather request: pick a bundle of a specific hedgerow
 * green, deterministic 1-3h completion.
 */
function requestGather(playerName, foragerName, green, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const forager = String(foragerName ?? "").slice(0, 40);
  const g = String(green ?? "").slice(0, 60);
  if (!name || !forager || !g) return null;
  pruneLedgers(nowMs);
  const day = dayNumber(nowMs);
  const durationMs = (1 + hashStr(name + "|gather-dur:" + g + ":" + day) % 3) * 3600 * 1000;
  const rec = {
    gather: {
      player: String(playerName),
      forager,
      green: g,
      askedAt: nowMs,
      durationMs,
      readyAt: nowMs + durationMs,
      until: nowMs + GATHER_TTL_MS,
    },
  };
  gatherRequests.set(name, rec);
  return rec.gather;
}

/** The player's outstanding gather request, or null. */
function gatherFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = gatherRequests.get(name);
  if (!rec || rec.gather.until <= nowMs) return null;
  return { ...rec.gather };
}

/** True when the gather is done (the forager is back from the hedgerow). */
function gatherReady(gather, nowMs = Date.now()) {
  if (!gather) return false;
  return nowMs >= gather.readyAt;
}

/** The player collects their gathered greens (deletes the record). */
function completeGather(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return gatherRequests.delete(name);
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

function journalize(citizen, text) {
  try {
    if (Journal && typeof Journal.appendEntry === "function") {
      Journal.appendEntry(citizen, text);
    } else if (Journal && typeof Journal.addEntry === "function") {
      Journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(text) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor(text);
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
// Gate order: cooldown (cheapest) → LOD brain gate → herbfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickHerbfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < HERBFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible herbfolk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be an herbfolk (hash-derived, cheap; exclusions inside)
        const type = herbfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Foraging hours only
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, HERBFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, HERBFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doHerbfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-herbfolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: hedgerow gluts and wasp nests (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-herbfolk] tick failed:", e?.message ?? e);
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

function doHerbfolkWork(director, record, citizen, type, nowMs) {
  const patch = patchFor(record);
  const name = normalizeName(record.username);

  // A nearby player's ready gather request takes priority for foragers.
  if (type === HEDGEROW_FORAGER) {
    const ready = nearbyReadyGather(director, citizen, nowMs);
    if (ready) {
      forceSay(citizen, fill(pickOne(Math.random, READY_GATHER_LINES), {
        player: ready.name,
        green: ready.gather.green,
      }));
      journalize(citizen, `brought a gathered bundle back to a customer at ${patch.name}`);
      return;
    }
    // Second priority: a wasp-nest warning if one is active in the kingdom.
    const kid = record?.kingdomId ?? record?.kingdom;
    if (kid && waspNestFor(kid, nowMs) && Math.random() < 0.4) {
      forceSay(citizen, fill(pickOne(Math.random, WASP_LINES), { patch: patch.name }));
      journalize(citizen, `warned travelers about wasps at ${patch.name}`);
      return;
    }
    const roll = Math.random();
    if (roll < 0.45) {
      const glut = glutFor(patch, nowMs);
      if (glut && Math.random() < 0.5) {
        forceSay(citizen, fill(pickOne(Math.random, GLUT_LINES), {
          greens: glut.greens,
          patch: patch.name,
        }));
        journalize(citizen, `worked a hedgerow glut at ${patch.name}`);
      } else {
        const greens = greensForToday(name, nowMs);
        forceSay(citizen, fill(pickOne(Math.random, FORAGE_LINES), { greens }));
        journalize(citizen, `${taskForToday(name, type, nowMs)} at ${patch.name}`);
      }
    } else if (roll < 0.7) {
      const herb = proHeadlineHerb(name, record?.kingdom, nowMs);
      if (herb) {
        forceSay(citizen, fill(pickOne(Math.random, PRO_HERB_LINES), { herb }));
        journalize(citizen, `talked trade with passers-by at ${patch.name}`);
      } else {
        const greens = greensForToday(name, nowMs);
        forceSay(citizen, fill(pickOne(Math.random, FORAGE_LINES), { greens }));
        journalize(citizen, `${taskForToday(name, type, nowMs)} at ${patch.name}`);
      }
    } else {
      const greens = greensForToday(name, nowMs);
      forceSay(citizen, `Off picking ${greens} — back before the dew dries!`);
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${patch.name}`);
    }
    return;
  }

  if (type === PETAL_DRIER) {
    const petals = petalsForToday(name, nowMs);
    forceSay(citizen, fill(pickOne(Math.random, PETAL_LINES), { petals }));
    journalize(citizen, `${taskForToday(name, type, nowMs)} at ${patch.name}`);
    return;
  }

  if (type === WINDOW_TENDER) {
    forceSay(citizen, fill(pickOne(Math.random, WINDOW_LINES), { patch: patch.name }));
    journalize(citizen, `${taskForToday(name, type, nowMs)} at ${patch.name}`);
    return;
  }

  // Garden-weeder: weeding jobs for hire.
  const job = weedJobForToday(name, nowMs);
  forceSay(citizen, fill(pickOne(Math.random, WEEDER_LINES), { job }));
  journalize(citizen, `${taskForToday(name, type, nowMs)} at ${patch.name}`);
}

/** A nearby real player whose gather request is ready, if any. */
function nearbyReadyGather(director, citizen, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, HERBFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) return null;
      const g = gatherFor(pname, nowMs);
      if (g && gatherReady(g, nowMs)) return { name: pname, gather: g };
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day patch/kingdom rhythms: hedgerow gluts and wasp nests. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  try {
    for (const patch of HERB_PATCHES) {
      const glut = glutFor(patch, nowMs);
      if (!glut) continue;
      const key = "hedgerow-glut:" + patch.name + ":" + day;
      if (lastFiredByCitizen.has(key)) continue;
      lastFiredByCitizen.set(key, nowMs);
      const line = `Hedgerow glut at ${patch.name} — ${glut.greens} by the armful, the herbfolk are selling it off cheap.`;
      journalize({ username: patch.name }, line);
      seedRumor(line);
    }
    const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
    for (const kid of kingdoms) {
      if (!waspNestFor(kid, nowMs)) continue;
      const key = "wasp-nest:" + kid + ":" + day;
      if (lastFiredByCitizen.has(key)) continue;
      lastFiredByCitizen.set(key, nowMs);
      const patch = (HERB_PATCHES.filter((v) => v.kingdom === kid)[0] ?? HERB_PATCHES[0]).name;
      const line = `A forager disturbed a wasp nest at ${patch} — travelers are giving that hedgerow a wide berth.`;
      journalize({ username: "the herbfolk" }, line);
      seedRumor(line);
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickHerbfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  herbfolkTypeOf,
  patchFor,
  greensForToday,
  petalsForToday,
  weedJobForToday,
  taskForToday,
  glutFor,
  waspNestFor,
  proHeadlineHerb,
  requestGather,
  gatherFor,
  gatherReady,
  completeGather,
  nearbyReadyGather,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  herbfolkTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  HERBFOLK_TYPES,
  HEDGEROW_FORAGER,
  PETAL_DRIER,
  WINDOW_TENDER,
  GARDEN_WEEDER,
  HERB_PATCHES,
  // Tuning (tests pin the documented behavior):
  HERBFOLK_RADIUS,
  HERBFOLK_CITIZEN_COOLDOWN_MS,
  HERBFOLK_CHANCE,
  HERBFOLK_SHARE,
  GLUT_CHANCE,
  WASP_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  GATHER_TTL_MS,
  HEDGEROW_GREENS,
  DRIED_PETALS,
  WEED_JOBS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    gatherRequests.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
