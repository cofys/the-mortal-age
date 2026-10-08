"use strict";

/**
 * CitizenJewelers2 — the community gemfolk: hobby gem cutters, ring setters,
 * stone polishers and informal appraisers at community workshops.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived gemfolk types, per-day workshop projects (1-3 from date +
 *   hash), rare masterpiece unveilings (~8%/workshop/day), 7-day-TTL player
 *   ledgers for jewelry commissions, raw-gem sales and cutting lessons —
 *   exported for the LLM dialogue tier.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 08:00-18:00 server-local): scripted cutting/setting/polishing emotes
 * ("*holds the opal to the light*"), finished-piece callouts, commission
 * offers, appraisal opinions, and masterpiece unveiling fanfare as the
 * crowd moment.
 *
 * No overlap (by design):
 * - CitizenJewelers own the PROFESSIONAL side: gem cutter, goldsmith,
 *   appraiser, trader, workshops, the gem trade. Professional jewelers
 *   (CitizenJewelers.jewelerTypeFor) are EXCLUDED here.
 * - CitizenMiners2 gem hunters own RAW stone finds (prospecting, gem-find
 *   lines). Gemfolk here NEVER prospect — they buy raw stones, then cut,
 *   set, polish and appraise. Finding vs finishing, documented so the
 *   two never collide.
 * - Professional appraisers own CERTIFIED valuations (sealed scrolls,
 *   assay reports). Hobby appraisers give informal opinions only —
 *   "looks like a fine emerald to me" — never certificates.
 *
 * Zero LLM: scripted line pools; the journal feeds the LLM mouth.
 *
 * Activity system (no professional exclusion chain): any commoner may cut
 * gems. Deliberately NOT in HOBBY_KEYS: visibility is throttled via chance
 * + cooldown (the couriers precedent) instead of adding another hobby key.
 * Plain-node testable: CitizenJewelers2.test.js.
 *
 * Wired into the director tick right after the brewfolk block.
 */

const { normalizeName } = require("./CitizenBonds");

// Top-level requires (perf lesson from the artisan fix): the exclusion
// modules are linear deps with no back-references to this module, so
// hoisting is cycle-safe. safeRequire preserves the "module absent"
// fallback the lazy pattern had.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const JewelersPro = safeRequire("./CitizenJewelers");

// Gem names from the real pro tables (objects with {name, tier} — unwrapped
// per the healers2 lesson), with a static fallback when absent.
const GEMS = (() => {
  const g = JewelersPro && JewelersPro.GEMS;
  if (Array.isArray(g) && g.length) {
    return g.map((x) => (x && typeof x === "object" ? x.name : String(x))).filter(Boolean);
  }
  return ["opal", "jade", "red topaz", "sapphire", "emerald", "ruby", "diamond"];
})();

// === Tuning ===
const GEMFOLK_RADIUS = 14; // tiles — close enough to see/hear
const GEMFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const GEMFOLK_CHANCE = 0.15; // per eligible citizen per tick (couriers-style narrowing)
const GEMFOLK_SHARE = 40; // ~40% nominal share of commoners
const WORK_START_HOUR = 8; // 08:00 server-local
const WORK_END_HOUR = 18; // 18:00 server-local
const MASTERPIECE_CHANCE = 0.08; // per workshop per day: a masterpiece unveiling
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;

// === Gemfolk types ===
const GEMFOLK_CUTTER = "hobby-gem-cutter";
const GEMFOLK_SETTER = "ring-setter";
const GEMFOLK_POLISHER = "stone-polisher";
const GEMFOLK_APPRAISER = "stone-appraiser";
const GEMFOLK_TYPES = [
  GEMFOLK_CUTTER,
  GEMFOLK_SETTER,
  GEMFOLK_POLISHER,
  GEMFOLK_APPRAISER,
];
const GEMFOLK_WEIGHTS = {
  [GEMFOLK_CUTTER]: 30,
  [GEMFOLK_SETTER]: 25,
  [GEMFOLK_POLISHER]: 25,
  [GEMFOLK_APPRAISER]: 20,
};

// === Community workshops (kingdom-preferred; distinct names from the pro
// trade workshops so the two never share a room) ===
const COMMUNITY_WORKSHOPS = [
  { name: "the Varrock community gem bench", kingdom: "misthalin" },
  { name: "the Lumbridge hobby cutters' corner", kingdom: "misthalin" },
  { name: "the Falador neighborhood workshop", kingdom: "asgarnia" },
  { name: "the Burthorpe stone polishers' shed", kingdom: "asgarnia" },
  { name: "the Ardougne craft circle", kingdom: "kandarin" },
  { name: "the Hemenster lapidary club", kingdom: "kandarin" },
  { name: "the Keldagrim rockhounds' den", kingdom: "keldagrim" },
  { name: "the Dorgesh pebble polishers' nook", kingdom: "keldagrim" },
  { name: "the Darkmeyer night cutters' loft", kingdom: "morytania" },
  { name: "the Al Kharid desert stone circle", kingdom: "kharidian" },
];

// === Community projects: neighbor-grade pieces, NEVER trade wares ===
// (Trade wares — faceted sapphires, gold rings, certified valuations —
// belong to the professional jewelers.)
const COMMUNITY_PROJECTS = [
  "a polished opal pendant",
  "a jade bead bracelet",
  "a red topaz ring in a simple setting",
  "a sapphire-chip necklace",
  "an emerald bead anklet",
  "a ruby cabochon brooch",
  "a tumbled-stone collection",
  "a wire-wrapped quartz pendant",
  "a set of polished pebble buttons",
  "a simple silver-gilt ring",
  "a beaded gemstone necklace",
  "a carved soapstone charm",
];

// === Masterpieces (the rare crowd moment) ===
const MASTERPIECES = [
  "a flawless star-sapphire pendant",
  "an emerald-and-opal bridal set",
  "a ruby heart locket",
  "a diamond-chip mosaic brooch",
];

// === Scripted lines ===
const WORK_LINES = {
  [GEMFOLK_CUTTER]: [
    "*holds the stone to the light, squinting*",
    "*taps the chisel — tick — and a facet falls away*",
    "Cut along the grain and she'll shine; fight her and she'll split.",
    "*dops the stone and spins the lap*",
  ],
  [GEMFOLK_SETTER]: [
    "*bends the prongs down with tweezers*",
    "*sets the stone and checks it from every angle*",
    "A loose stone is a lost stone — prongs tight, always.",
    "*burnishes the bezel smooth*",
  ],
  [GEMFOLK_POLISHER]: [
    "*tumbles the stones in the barrel, listening to the rattle*",
    "*rubs the pebble with polishing compound*",
    "Patience, patience — shine comes to those who wait.",
    "*rinses the stones and lays them out to dry*",
  ],
  [GEMFOLK_APPRAISER]: [
    "*peers through the loupe, humming*",
    "*weighs the stone on the little brass scales*",
    "Mind — this is my opinion, not a certificate. The guild does those.",
    "*taps the stone and listens to the ring*",
  ],
};

const FINISH_LINES = [
  "Done! {piece} — come and have a look!",
  "{piece}, finished this morning. Not bad for a kitchen-table bench, eh?",
  "Just set the last stone — {piece} is ready for its owner!",
];

const COMMISSION_LINES = [
  "I cut and set for neighbors, friend — nothing fancy, but honest work.",
  "Got a stone needs cutting? Or a ring wants setting? Leave your name.",
];

const APPRAISE_LINES = [
  "Bring me your finds and I'll tell you what I think they're worth — informally, mind.",
  "Found something shiny? I'll have a look through the loupe for you.",
];

const LESSON_LINES = [
  "I teach cutting on rest days — start with quartz, it's forgiving.",
  "Want to learn the lap? First lesson's free, bring your own stone.",
];

const UNVEIL_LINES = [
  "Behold! {piece} — finished after weeks at the bench!",
  "She's done! {piece} — the finest thing this workshop has ever turned out!",
];

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

// === Ledgers (7-day TTL) ===
const commissionLedger = new Map(); // normName -> { piece, at }
const gemLedger = new Map(); // normName -> { gem, at }
const lessonLedger = new Map(); // normName -> { at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const map of [commissionLedger, gemLedger, lessonLedger]) {
    for (const [k, v] of map) {
      if (nowMs - v.at > LEDGER_TTL_MS) map.delete(k);
    }
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

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
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

/** True when the player object is a citizen bot. */
function isCitizenBot(player) {
  try {
    return player?.isPlayerBot?.() === true || player?.getHostAddress?.() === "bot";
  } catch {
    return false;
  }
}

/**
 * The materialized bot for a roster record, or null.
 * Canonical replacement for the dead director.playerFor: only materialize
 * when the director says the citizen is online.
 */
function materializedBot(director, record) {
  try {
    return director?.isOnline?.(record) ? director.getBot?.(record) ?? null : null;
  } catch {
    return null;
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

/** True during workshop hours (08:00-18:00 server-local). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

/** Weighted pick of a gemfolk type from a 0..99 roll. */
function gemfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of GEMFOLK_TYPES) {
    acc += GEMFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return GEMFOLK_CUTTER;
}

// ============================================================================
// Gemfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The gemfolk type for a roster record, or null.
 * Excludes professional jewelers (CitizenJewelers owns the gem trade),
 * so no citizen belongs to both systems.
 */
function gemfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: professional jewelers own the gem trade.
    try {
      if (JewelersPro && typeof JewelersPro.jewelerTypeFor === "function" && JewelersPro.jewelerTypeFor(name)) return null;
    } catch { /* module absent */ }
    const roll = hashStr("gemfolk:" + name) % 100;
    if (roll >= GEMFOLK_SHARE) return null;
    // Name-first salt: avoids the FNV-1a prefix-correlation bug where
    // "gemfolk:"/"gemfolktype:" shared prefixes starved middle buckets.
    return gemfolkTypeFromRoll(hashStr(name + "|gemfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred workshop assignment, stable across restarts. */
function workshopFor(record) {
  const kid = record?.kingdomId;
  const local = COMMUNITY_WORKSHOPS.filter((w) => w.kingdom === kid);
  const pool = local.length ? local : COMMUNITY_WORKSHOPS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("gemfolkworkshop:" + name) % pool.length];
}

/**
 * Today's projects for a gemfolk citizen (1-3 pieces).
 * Derived from date + hash; zero storage.
 */
function projectsFor(username, kingdomId, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("gemfolkprojects:" + name + ":" + day));
  const count = 1 + Math.floor(rng() * 3); // 1-3
  const out = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < COMMUNITY_PROJECTS.length; i++) {
    const p = COMMUNITY_PROJECTS[Math.floor(rng() * COMMUNITY_PROJECTS.length)];
    if (used.has(p)) continue;
    used.add(p);
    out.push(p);
  }
  return out;
}

/**
 * The gem a cutter is working today — read from the real pro GEMS table
 * (static fallback when absent). Community cutters work the same stones,
 * at neighbor grade.
 */
function gemForToday(username, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  return GEMS[hashStr("gemfolkgem:" + name + ":" + day) % GEMS.length];
}

/** Today's masterpiece at a workshop (~8%/day), or null. */
function masterpieceFor(workshop, dateMs) {
  if (!workshop) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("gemfolkmasterpiece:" + workshop.name + ":" + day));
  if (rng() >= MASTERPIECE_CHANCE) return null;
  return pickOne(rng, MASTERPIECES);
}

/** Coin price for a commissioned community piece (soup-kitchen precedent: fair, capped). */
function priceFor(piece) {
  const h = hashStr("gemfolkprice:" + String(piece));
  return 25 + (h % 176); // 25-200 coins
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Commission a jewelry piece: recorded; the LLM tier handles dialogue. */
function commissionPiece(playerName, piece, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !piece) return null;
  pruneLedgers(nowMs);
  commissionLedger.set(name, { piece: String(piece), at: nowMs });
  return piece;
}

/** The active commission for a player, or null. */
function pieceFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = commissionLedger.get(name);
  return rec ? rec.piece : null;
}

/** Sell a raw gem to a gemfolk cutter: recorded; the LLM tier handles dialogue. */
function sellGem(playerName, gem, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !gem) return null;
  pruneLedgers(nowMs);
  gemLedger.set(name, { gem: String(gem), at: nowMs });
  return gem;
}

/** The raw gem a player offered, or null. */
function gemFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = gemLedger.get(name);
  return rec ? rec.gem : null;
}

/** Sign up for a cutting lesson: recorded; the LLM tier handles dialogue. */
function learnCutting(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  lessonLedger.set(name, { at: nowMs });
  return true;
}

/** True if the player has a recent lesson signup. */
function cuttingFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return lessonLedger.has(name);
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
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

/**
 * Journal a gemfolk work event. Canonical: getJournal().log(citizenName,
 * "work", text) — the old helper probed appendEntry/addEntry, which don't
 * exist, so all 5 call sites silently dropped. Journal is best-effort.
 */
function journalize(citizenName, text) {
  try {
    journal()?.log(citizenName, "work", text);
  } catch {
    /* journal absent — never break the tick */
  }
}

/** Seed a masterpiece-unveiling rumor into the real CitizenRumors system. */
function seedMasterpieceRumor(who, piece, workshopName) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") {
      rumors.seedRumor(Math.random, {
        kind: "gem-masterpiece",
        who,
        what: `a masterpiece ${piece} unveiled at ${workshopName}`,
        where: workshopName,
      });
    }
  } catch {
    /* rumors absent */
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → gemfolk? → materialized → work hours
// → real player near → chance → work.
// ============================================================================

function tickGemfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < GEMFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be gemfolk (hash-derived, cheap)
        const type = gemfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. Workshop hours only
        if (!isWorkHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, GEMFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, GEMFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doGemfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-gemfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-gemfolk] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  void director; // director.playerFor/onlinePlayers are dead; proximity comes from the bot.
  try {
    const players = citizen.getLocalPlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doGemfolkWork(director, record, citizen, type, nowMs) {
  const workshop = workshopFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Masterpiece unveiling: rare, the crowd moment.
  const mp = masterpieceFor(workshop, nowMs);
  if (mp) {
    const key = "masterpiece:" + workshop.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, UNVEIL_LINES), { piece: mp });
      citizen.forceChat?.(line);
      journalize(name, `unveiled a masterpiece at ${workshop.name}: ${mp}`);
      seedMasterpieceRumor(name, mp, workshop.name);
      return;
    }
  }

  // Routine: work emote, finished-piece callout, commission/appraisal/lesson offer.
  const roll = Math.random();
  if (roll < 0.4) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(name, `worked at ${workshop.name}`);
  } else if (roll < 0.65) {
    const projects = projectsFor(name, record.kingdomId, nowMs);
    const piece = projects.length ? projects[0] : "a polished stone";
    const line = fill(pickOne(Math.random, FINISH_LINES), { piece });
    citizen.forceChat?.(line);
    journalize(name, `finished ${piece} at ${workshop.name}`);
  } else if (roll < 0.8) {
    if (type === GEMFOLK_APPRAISER) {
      const line = pickOne(Math.random, APPRAISE_LINES);
      citizen.forceChat?.(line);
    } else {
      const line = pickOne(Math.random, COMMISSION_LINES);
      citizen.forceChat?.(line);
    }
    journalize(name, `offered services at ${workshop.name}`);
  } else {
    const line = pickOne(Math.random, LESSON_LINES);
    citizen.forceChat?.(line);
    journalize(name, `offered cutting lessons at ${workshop.name}`);
  }
}

module.exports = {
  tickGemfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  gemfolkTypeOf,
  workshopFor,
  projectsFor,
  gemForToday,
  masterpieceFor,
  priceFor,
  commissionPiece,
  pieceFor,
  sellGem,
  gemFor,
  learnCutting,
  cuttingFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  gemfolkTypeFromRoll,
  seededRng,
  chance,
  dayNumber,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isWorkHour,
  GEMFOLK_TYPES,
  GEMFOLK_CUTTER,
  GEMFOLK_SETTER,
  GEMFOLK_POLISHER,
  GEMFOLK_APPRAISER,
  COMMUNITY_WORKSHOPS,
  COMMUNITY_PROJECTS,
  MASTERPIECES,
  GEMS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    commissionLedger.clear();
    gemLedger.clear();
    lessonLedger.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
