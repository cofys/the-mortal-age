"use strict";

/**
 * CitizenHerbalists — citizens who gather herbs, study plants, and supply
 * healers and alchemists.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived herbalist types (~35% of commoners, stable across restarts,
 *   zero storage) are assigned gathering grounds (10 named forests and
 *   fields, kingdom-preferred). Seasonal herb availability comes from the
 *   farmers' season calendar; a daily herb-of-the-day rhythm decides which
 *   herbs each herbalist gathers. Rare herb finds are crowd moments. Work is
 *   journaled once per loop so the LLM dialogue tier can answer "what have
 *   you been up to?" truthfully.
 *   Supplies the supply chain: healers (remedies) and alchemists
 *   (ingredients) read the same herb tables through `herbsFor` — the fiction
 *   is consistent end to end.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Herbalists gather with the spade/digging animation (engine-verified 830
 *   from Tithe.Farming.js), prepare and dry herbs with the herblore
 *   animation (engine-verified 363), hawk fresh herbs and remedies, offer
 *   herblore lessons to lingering players (botanists only — gardeners and
 *   wildcrafters guard their best spots), and announce rare finds.
 *
 * Ties into CitizenHealers (remedies — the healers' herbalists gather the
 * herbs the healers need), CitizenAlchemists (botanical ingredients), and
 * CitizenFarmers (season calendar + produce overlap for gardeners).
 *
 * Zero LLM: all visible output is scripted from template pools and the
 * season tables. The LLM mouth reads the journal.
 *
 * Wired into the director tick in tickProximity right after the alchemists
 * block, same as the other trade modules. Plain-node testable:
 * CitizenHerbalists.test.js.
 */

// === Tuning: all magic numbers here ===
const HERBALIST_RADIUS = 14; // tiles — close enough to see/hear
const HERBALIST_CITIZEN_COOLDOWN_MS = 60 * 60 * 1000; // a citizen fires at most this often
const HERBALIST_CHANCE = 0.3; // per eligible citizen per ~60s tick
const HERBALIST_SHARE = 0.35; // ~35% of commoners become herbalists

// Engine animation (verified in server/plugins/skills/farming/Tithe.Farming.js:
// plot digging/plant work uses new core.Animation(830) — spade work).
// Used for gathering wild herbs and tending herb beds.
const ANIM_DIG = 830;
// Engine animation (verified in server/plugins/skills/Herblore.plugin.js:
// HERBLORE_ANIM = new Animation(363) — potion brewing/preparation).
// Used for drying, grinding and preparing herbs.
const ANIM_PREP = 363;

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
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
// Lazy access to CitizenFarmers (season calendar tie-in; may not load in tests)
// ============================================================================
let _farmers = null;
let _farmersAttempted = false;
function farmersModule() {
  if (!_farmersAttempted) {
    _farmersAttempted = true;
    try {
      _farmers = require("./CitizenFarmers");
    } catch {
      _farmers = null;
    }
  }
  return _farmers;
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string — stable assignment across restarts. */
function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Season name for a timestamp, via the farmers' season calendar (fallback: summer). */
function seasonFor(dateMs) {
  const f = farmersModule();
  try {
    if (f && f.seasonFor) return f.seasonFor(new Date(dateMs).getUTCMonth());
  } catch { /* fall through */ }
  return "summer";
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

/**
 * Decide whether this citizen should fire now.
 * Pure: (rng, lastFiredMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < HERBALIST_CITIZEN_COOLDOWN_MS) return false;
  return rng() < HERBALIST_CHANCE;
}

/** True when any real (human) player is near this citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.world?.getPlayers?.() ?? director.getPlayers?.() ?? [];
    for (const p of players) {
      if (p === citizen) continue;
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ============================================================================
// Herbalist types, grounds, herbs
// ============================================================================

const HERBALIST_TYPES = [
  { id: "wildcrafter", label: "wildcrafter", verb: "forages", anim: ANIM_DIG },
  { id: "gardener", label: "gardener", verb: "tends", anim: ANIM_DIG },
  { id: "botanist", label: "botanist", verb: "studies", anim: ANIM_PREP },
  { id: "supplier", label: "apothecary supplier", verb: "dries", anim: ANIM_PREP },
];

// Herbs by rarity tier (classic grimy-herb names the engine knows).
const HERBS = {
  common: ["guam leaf", "marrentill", "tarromin"],
  uncommon: ["harralander", "ranarr weed", "irit leaf"],
  rare: ["avantoe", "kwuarm", "cadantine"],
  exotic: ["lantadyme", "dwarf weed", "torstol"],
};

// Which rarity tiers are available in each season (seasonal scarcity).
const SEASON_TIERS = {
  spring: ["common", "uncommon", "rare"],
  summer: ["common", "uncommon", "rare", "exotic"],
  autumn: ["common", "uncommon", "rare"],
  winter: ["common", "uncommon"],
};

// Gathering grounds — forests and fields, kingdom-preferred assignment.
const GROUNDS = [
  { name: "the Lumbridge woodland", kingdom: "asgarnia" },
  { name: "the Falador meadows", kingdom: "asgarnia" },
  { name: "the Ardougne herb gardens", kingdom: "kandarin" },
  { name: "the Feldip fern beds", kingdom: "kandarin" },
  { name: "the Varrock wilds", kingdom: "misthalin" },
  { name: "the Mort Myre fringes", kingdom: "morytania" },
  { name: "the Darkmeyer nightshade beds", kingdom: "morytania" },
  { name: "the Keldagrim cavern moss shelves", kingdom: "keldagrim" },
  { name: "the Fremennik tundra moss flats", kingdom: "fremennik" },
  { name: "the Piscatoris reed marshes", kingdom: "kandarin" },
];

/** Herbalist type for a username — hash-derived, stable across restarts. */
function typeFor(username) {
  return HERBALIST_TYPES[hashStr(username) % HERBALIST_TYPES.length];
}

/** Whether this roster record is an herbalist (~35% of commoners). */
function isHerbalist(record) {
  try {
    const role = String(record?.role ?? record?.attributes?.role ?? "").toLowerCase();
    if (role === "guard" || role === "merchant") return false;
    return hashStr(record?.username ?? "") % 100 < HERBALIST_SHARE * 100;
  } catch {
    return false;
  }
}

/** Gathering ground for a username + kingdom — prefers the citizen's kingdom. */
function groundFor(username, kingdom) {
  const k = String(kingdom ?? "").toLowerCase();
  const preferred = GROUNDS.filter((g) => g.kingdom === k);
  const pool = preferred.length > 0 ? preferred : GROUNDS;
  return pool[hashStr(username + "|ground") % pool.length];
}

/**
 * Herbs available this season. Exported so CitizenHealers and
 * CitizenAlchemists can read the same tables — the supply chain fiction
 * stays consistent.
 * @param {string} username - deterministic rare-find assignment
 * @param {string} kingdom
 * @param {number} dateMs
 */
function herbsFor(username, kingdom, dateMs) {
  const season = seasonFor(dateMs);
  const tiers = SEASON_TIERS[season] || SEASON_TIERS.summer;
  const out = [];
  for (const tier of tiers) {
    const names = HERBS[tier] || [];
    // Availability rotates daily by hash: not every herb every day.
    for (let i = 0; i < names.length; i++) {
      if ((hashStr(username + names[i] + Math.floor(dateMs / 86400000)) + i) % 3 !== 0) {
        out.push({ name: names[i], rarity: tier });
      }
    }
  }
  return out;
}

/** The day's headline herb for this herbalist — drives lines and journaling. */
function herbOfTheDay(username, kingdom, dateMs) {
  const available = herbsFor(username, kingdom, dateMs);
  if (available.length === 0) return { name: "guam leaf", rarity: "common" };
  return available[hashStr(username + "headline" + Math.floor(dateMs / 86400000)) % available.length];
}

// === Scripted lines (all data, zero LLM) ===

const GATHER_EMOTES = [
  "*crouches to inspect a patch of green*",
  "*plucks leaves with practiced fingers*",
  "*brushes soil from a fresh root*",
  "*sniffs a crushed leaf, nodding*",
  "*fills a woven basket with cuttings*",
  "*trims stems with a small sickle*",
];

const PREP_EMOTES = [
  "*spreads leaves on a drying rack*",
  "*grinds dried herbs with a mortar*",
  "*ties bundles of herbs with twine*",
  "*labels jars of powdered leaf*",
  "*weighs out dried portions*",
];

function hawkLine(type, herb) {
  return [
    `Fresh ${herb}, gathered this very morning!`,
    `${herb} — still green, still potent!`,
    `You won't find cleaner ${herb} in the market!`,
  ][hashStr(herb + type.id) % 3];
}

function rareFindLine(herb) {
  return [
    `By the roots — a patch of ${herb}, and nobody else knows!`,
    `Look at this! Wild ${herb}, the first I've seen all season!`,
    `Careful now... this ${herb} is worth more than gold to the right healer.`,
  ];
}

const LESSON_OFFER = [
  "If you've a mind to learn the green craft, I'll show you which leaves heal and which kill.",
  "Fancy learning herblore? Start with guam — every master started with guam.",
  "I could teach you to tell tarromin from poison ivy. It matters more than you'd think.",
];

// ============================================================================
// Engine actions (best-effort, never throw)
// ============================================================================

/** Play an animation on the citizen bot, best-effort. */
function playAnim(citizen, animId) {
  try {
    citizen.performAnimation?.({ getId: () => animId });
  } catch { /* cosmetic only */ }
}

/** Force a chat line above the citizen's head, best-effort. */
function forceChat(citizen, line) {
  try {
    citizen.forceChat?.(line);
  } catch { /* cosmetic only */ }
}

/** Journal one line so the LLM dialogue tier has truthful source material. */
function journal(director, record, text) {
  try {
    director.journal?.addEntry?.(record.username, text);
  } catch { /* journaling must never break the tick */ }
}

// ============================================================================
// The visible work
// ============================================================================

/** The gathering pass: animation + emote + journal line. */
function doGather(director, record, citizen, nowMs) {
  const type = typeFor(record.username);
  const ground = groundFor(record.username, record.kingdom);
  const herb = herbOfTheDay(record.username, record.kingdom, nowMs);
  const rng = (() => {
    let s = hashStr(record.username + nowMs);
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  })();
  playAnim(citizen, type.anim);
  const emotes = type.anim === ANIM_PREP ? PREP_EMOTES : GATHER_EMOTES;
  forceChat(citizen, pickOne(rng, emotes));
  journal(
    director,
    record,
    `${type.verb === "forages" ? "Foraging" : type.verb === "tends" ? "Tending" : type.verb === "studies" ? "Studying" : "Drying"} at ${ground.name} — gathering ${herb.name} for the healers and brewers.`
  );
}

/** Hawking: only wildcrafters and suppliers sell over the counter. */
function maybeHawk(director, record, citizen, nowMs) {
  const type = typeFor(record.username);
  if (type.id !== "wildcrafter" && type.id !== "supplier") return false;
  const herb = herbOfTheDay(record.username, record.kingdom, nowMs);
  forceChat(citizen, hawkLine(type, herb.name));
  journal(director, record, `Hawking fresh ${herb.name} to passers-by.`);
  return true;
}

/** Rare finds are the crowd moment — scripted, announced, journaled. */
function maybeRareFind(director, record, citizen, nowMs) {
  const herb = herbOfTheDay(record.username, record.kingdom, nowMs);
  if (herb.rarity !== "rare" && herb.rarity !== "exotic") return false;
  // Rare enough to feel special: ~1 in 8 firings on a rare-herb day.
  if (hashStr(record.username + "rare" + Math.floor(nowMs / 86400000)) % 8 !== 0) return false;
  const line = rareFindLine(herb.name)[hashStr(record.username) % 3];
  forceChat(citizen, line);
  journal(director, record, `Rare find: ${herb.name} (${herb.rarity}) — a valuable harvest.`);
  return true;
}

/** Lesson offers for lingering players — botanists teach, others guard spots. */
function maybeLessonOffer(director, record, citizen, nowMs) {
  const type = typeFor(record.username);
  if (type.id !== "botanist") return false;
  // Lingering = this citizen already fired recently (cooldown map warm).
  const line = LESSON_OFFER[hashStr(record.username + Math.floor(nowMs / 86400000)) % LESSON_OFFER.length];
  forceChat(citizen, line);
  journal(director, record, "Offered a herblore lesson to a lingering traveler.");
  return true;
}

// ============================================================================
// The tick
// ============================================================================

/**
 * The tick function. Called from the director tick.
 * Data tier is free; the visible part fires only when a real player is near.
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} desync - timing-desync gate (may be undefined in tests)
 */
function tickHerbalists(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cheapest gates first: cooldown, then herbalist eligibility.
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < HERBALIST_CITIZEN_COOLDOWN_MS) continue;
        if (!isHerbalist(record)) continue;

        // 2. Materialized citizen required, then proximity to a real player.
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (desync && !desync(record.username, nowMs)) continue;
        if (!anyRealPlayerNear(director, citizen, HERBALIST_RADIUS)) continue;

        // 3. Chance gate after all cheap gates.
        const rng = (() => {
          let s = hashStr(record.username + nowMs);
          return () => {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            return s / 4294967296;
          };
        })();
        if (!shouldFire(rng, last, nowMs)) continue;

        // 4. Do the visible work (scripted, zero LLM).
        doGather(director, record, citizen, nowMs);
        maybeRareFind(director, record, citizen, nowMs);
        if (!maybeHawk(director, record, citizen, nowMs)) {
          maybeLessonOffer(director, record, citizen, nowMs);
        }
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen guard: never let one herbalist break the tick.
        console.warn("[citizen-herbalists] citizen failed:", record?.username ?? "?", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-herbalists] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickHerbalists,
  herbsFor,
  herbOfTheDay,
  seasonFor,
  typeFor,
  isHerbalist,
  groundFor,
  hawkLine,
  rareFindLine,
  shouldFire,
  isRealPlayer,
  withinTiles,
  hashStr,
  HERBALIST_RADIUS,
};
