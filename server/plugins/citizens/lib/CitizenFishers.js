"use strict";

/**
 * CitizenFishers — fisher citizens who work the waters: deep-sea fishers haul
 * nets, river fishers cast rods, ice fishers drill winter holes, pearl divers
 * dive the reefs.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a fisher trade (or none)
 *   from their username hash — no storage, stable across restarts. Fishing
 *   spot assignment prefers the citizen's kingdom; catch tables, seasonal
 *   rhythms, and weather are all derived from the date + hash, so the
 *   simulation runs with zero players online at zero token cost. Work
 *   events are journaled once per visible loop so the interaction-tier
 *   LLM answers "what have you been up to?" truthfully (and can riff on
 *   selling fresh catch — buying dialogue is the LLM's job, journaled
 *   state is its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Fishers visibly work the water: rod casts (engine animation 622),
 *   net hauls (621), harpoon strikes (618), cage traps (619). Big catches
 *   trigger celebrations; fishers hawk fresh catch to passers-by. In
 *   storm weather they stay ashore and warn of the sea.
 *
 * Zero LLM: scripted emote pools, catch/hawk/storm lines, chance-gated.
 *
 * Wired into the director tick right after the miners block.
 * Plain-node testable: CitizenFishers.test.js.
 */

// === Tuning: all magic numbers here ===
const FISHER_RADIUS = 40; // tiles — visible work range (same as miners/farmers)
const HAWK_RADIUS = 14; // tiles — fresh-catch hawking, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const HAWK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // hawk fresh catch at most every 4h
const HAWK_CHANCE = 0.35;
const STORM_COOLDOWN_MS = 6 * 60 * 60 * 1000; // storm warnings at most every 6h
const STORM_CHANCE = 0.5; // when it's storming, warnings are common
const BIG_CATCH_CHANCE = 0.1; // a visible loop lands a big one this often

// Engine fishing animations (Fishing.plugin.js, verified).
const ANIM_ROD = 622;
const ANIM_NET = 621;
const ANIM_HARPOON = 618;
const ANIM_CAGE = 619;

// === Fisher types ===
const FISHER_DEEPSEA = "deep-sea fisher";
const FISHER_RIVER = "river fisher";
const FISHER_ICE = "ice fisher";
const FISHER_DIVER = "pearl diver";
const FISHER_TYPES = Object.freeze([FISHER_DEEPSEA, FISHER_RIVER, FISHER_ICE, FISHER_DIVER]);

// === Fishing spots (names players recognise; kingdoms for derived
// assignment — we never need coordinates, only names) ===
const SPOTS = Object.freeze([
  { name: "the Catherby beach", short: "catherby", kingdom: "kandarin", kind: "sea" },
  { name: "the Karamja docks", short: "karamja", kingdom: "kandarin", kind: "sea" },
  { name: "the Ardougne docks", short: "ardougne", kingdom: "kandarin", kind: "sea" },
  { name: "Port Khazard", short: "khazard", kingdom: "kandarin", kind: "sea" },
  { name: "the Piscatoris fishing colony", short: "piscatoris", kingdom: "kandarin", kind: "sea" },
  { name: "the Hemenster falls", short: "hemenster", kingdom: "kandarin", kind: "river" },
  { name: "the Baxtorian Falls", short: "baxtorian", kingdom: "kandarin", kind: "river" },
  { name: "the Fremennik ice flats", short: "fremennik", kingdom: "keldagrim", kind: "ice" },
  { name: "the Neitiznot shallows", short: "neitiznot", kingdom: "keldagrim", kind: "ice" },
  { name: "the Al Kharid oasis pools", short: "alkharid", kingdom: "misthalin", kind: "river" },
  { name: "the Lumbridge riverbanks", short: "lumbridge", kingdom: "misthalin", kind: "river" },
  { name: "the Varrock sewers outflow", short: "varrock", kingdom: "misthalin", kind: "river" },
  { name: "the Burgh de Rott shallows", short: "morytania", kingdom: "morytania", kind: "sea" },
  { name: "the Mort Myre shallows", short: "mortmyre", kingdom: "morytania", kind: "river" },
  { name: "the Mos Le'Harmless reefs", short: "mosleharmless", kingdom: "asgarnia", kind: "sea" },
  { name: "the Entrana shallows", short: "entrana", kingdom: "asgarnia", kind: "sea" },
]);

// === Catches by spot kind ===
const CATCHES = Object.freeze({
  sea: ["cod", "bass", "mackerel", "tuna", "swordfish", "lobster", "shark"],
  river: ["trout", "salmon", "pike", "herring", "sardine", "eels"],
  ice: ["frozen bass", "ice cod", "polar cod"],
});

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastHawkByCitizen = new Map(); // username -> timestamp
const lastStormByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWorkByCitizen) {
    if (at < cutoff) lastWorkByCitizen.delete(k);
  }
  for (const [k, at] of lastHawkByCitizen) {
    if (at < cutoff) lastHawkByCitizen.delete(k);
  }
  for (const [k, at] of lastStormByCitizen) {
    if (at < cutoff) lastStormByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash — deterministic, stable across restarts. */
function hashStr(s) {
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
 * Fisher trade for a username, or null for a non-fisher.
 * ~35% of commoners fish; the trade is hash-derived and stable.
 */
function fisherTypeFor(username) {
  if (!username) return null;
  const h = hashStr("fisher|" + String(username).toLowerCase());
  if (h % 20 >= 7) return null; // not a fisher
  return FISHER_TYPES[h % FISHER_TYPES.length];
}

/**
 * The spot this citizen fishes, preferring their kingdom (falls back to all
 * spots). Ice fishers and pearl divers need the right kind of water.
 */
function spotFor(username, kingdom, type) {
  let pool = (SPOTS || []).filter((s) => s.kingdom === kingdom);
  if (pool.length === 0) pool = SPOTS;
  if (type === FISHER_ICE) {
    const ice = pool.filter((s) => s.kind === "ice");
    pool = ice.length > 0 ? ice : (SPOTS || []).filter((s) => s.kind === "ice");
  }
  if (type === FISHER_DEEPSEA) {
    const sea = pool.filter((s) => s.kind === "sea");
    pool = sea.length > 0 ? sea : (SPOTS || []).filter((s) => s.kind === "sea");
  }
  const h = hashStr("spot|" + String(username).toLowerCase());
  return pool[h % pool.length];
}

/** Season from month (UTC). */
function seasonFor(month) {
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

/**
 * Derived weather for fishing: calm, breezy, or storm. Storms send the
 * fishers ashore — they warn of the sea instead of working it. Derived
 * per-day from a hash so all fishers agree on the weather.
 */
function weatherFor(dateMs) {
  const d = new Date(dateMs);
  const season = seasonFor(d.getUTCMonth());
  const baseStorm = { spring: 18, summer: 10, autumn: 28, winter: 40 }[season];
  const roll = hashStr("seastorm|" + d.getUTCFullYear() + "|" + Math.floor(dateMs / 86400000)) % 100;
  if (roll < baseStorm) return "storm";
  if (roll < baseStorm + 35) return "breezy";
  return "calm";
}

/** The catch this fisher is landing today, from their spot's waters. */
function catchFor(username, spot, dateMs) {
  const kind = (spot && spot.kind) || "sea";
  const pool = CATCHES[kind] || CATCHES.sea;
  const h = hashStr("catch|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return pool[h % pool.length];
}

/** Ice fishers only work in winter; divers don't dive in storms. Pure. */
function canFish(type, weather, season) {
  if (type === FISHER_ICE && season !== "winter") return false;
  if (weather === "storm") return false;
  return true;
}

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = {
  [FISHER_DEEPSEA]: [
    "*hauls the net aboard*",
    "*heaves the big net*",
    "*throws the harpoon*",
    "*sorts the catch on deck*",
  ],
  [FISHER_RIVER]: [
    "*casts the line*",
    "*mends the fishing rod*",
    "*baits the hook*",
    "*reels in slowly*",
  ],
  [FISHER_ICE]: [
    "*drills the ice hole*",
    "*dangles the line through the ice*",
    "*clears slush from the hole*",
    "*wraps the hands against the cold*",
  ],
  [FISHER_DIVER]: [
    "*dives beneath the waves*",
    "*surfaces with a gasp*",
    "*checks the oyster beds*",
    "*pries open an oyster*",
  ],
};

/** Scripted visible work line for a fisher type, or null. */
function workLineFor(rng, type) {
  const pool = WORK_LINES[type];
  if (!pool) return null;
  return pickOne(rng, pool);
}

/** Big-catch celebration — the moment that draws a crowd. */
function bigCatchLineFor(rng, fish, spot) {
  const spotName = spot && spot.name ? spot.name : "these waters";
  return pickOne(rng, [
    `Look at the size of this ${fish}! Biggest I've pulled from ${spotName} in years!`,
    `HA! A ${fish}, and a beauty! This one's going on the board!`,
    `${fish.charAt(0).toUpperCase() + fish.slice(1)}! Right out of ${spotName}! Who wants to see?`,
    `That's the one I've been after all season — a proper ${fish}!`,
  ]);
}

/** Fresh-catch hawking line for passers-by. */
function hawkLineFor(rng, fish, spot) {
  const spotName = spot && spot.name ? spot.name : "these waters";
  return pickOne(rng, [
    `Fresh ${fish}, straight out of ${spotName}! Get it while it's flopping!`,
    `Who's hungry? ${fish.charAt(0).toUpperCase() + fish.slice(1)}, caught this very morning!`,
    `${fish.charAt(0).toUpperCase() + fish.slice(1)} for sale! Cheapest on the docks, freshest in the city!`,
    `Dinner sorted, friend — fresh ${fish}, and I won't see you go hungry on the price.`,
  ]);
}

/** Storm warning — fishers stay ashore and read the weather. */
function stormLineFor(rng) {
  return pickOne(rng, [
    "*squints at the blackening sky* Storm coming. Nobody's boat is leaving the harbour.",
    "*ties down the nets* Sea's turning ugly. Smart money stays on the shore today.",
    "*shakes head at the waves* I've seen this swell before. Fish can wait — lives can't.",
    "*calls out* Bat-ten down, lads! Storm's on us!",
  ]);
}

/**
 * Decide whether this fisher should do visible work now.
 * Pure: (rng, lastWorkMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastWorkMs, nowMs) {
  if (nowMs - (lastWorkMs || 0) < WORK_COOLDOWN_MS) return false;
  return rng() < WORK_CHANCE;
}

/** Decide whether this fisher should hawk fresh catch now. Pure. */
function shouldHawk(rng, lastHawkMs, nowMs) {
  if (nowMs - (lastHawkMs || 0) < HAWK_COOLDOWN_MS) return false;
  return rng() < HAWK_CHANCE;
}

/** Decide whether a storm warning should fire now. Pure. */
function shouldWarnStorm(rng, lastStormMs, nowMs) {
  if (nowMs - (lastStormMs || 0) < STORM_COOLDOWN_MS) return false;
  return rng() < STORM_CHANCE;
}

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

function journalEvent(citizenName, text) {
  try {
    journal()?.log(citizenName, "work", text);
  } catch {
    // Journal is best-effort; never break the tick.
  }
}

/** Play a fishing animation, best-effort. */
function playAnim(director, bot, animId) {
  try {
    if (!animId) return false;
    const Anim = director?.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(animId));
    return true;
  } catch {
    return false;
  }
}

/** Animation for a fisher type. */
function animFor(type) {
  if (type === FISHER_DEEPSEA) return ANIM_HARPOON;
  if (type === FISHER_DIVER) return ANIM_CAGE;
  if (type === FISHER_RIVER) return ANIM_ROD;
  return ANIM_NET; // ice fishers jig a line through the hole
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → commoner → fisher type → materialized →
// real player near → chance → work. Three passes: work, fresh-catch hawking,
// storm warnings.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickFishers(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners fish (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = fisherTypeFor(record.username);
        if (!type) continue;

        // 2. Weather gate: storms and off-season send fishers ashore.
        const weather = weatherFor(nowMs);
        const season = seasonFor(new Date(nowMs).getUTCMonth());
        if (!canFish(type, weather, season)) continue;

        // 3. Cooldown gate — O(1), skips almost everyone.
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        // 4. Citizen must be materialized (near a player already).
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 5. A real player must be within sight of the water.
        if (!anyRealPlayerNear(director, citizen, FISHER_RADIUS)) continue;

        // 6. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= WORK_CHANCE) continue;
        doFishWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Fresh-catch hawking: tighter radius, own cooldown. Players learn who
    // has the day's catch.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = fisherTypeFor(record.username);
        if (!type) continue;
        const weather = weatherFor(nowMs);
        const season = seasonFor(new Date(nowMs).getUTCMonth());
        if (!canFish(type, weather, season)) continue;
        const last = lastHawkByCitizen.get(record.username) || 0;
        if (nowMs - last < HAWK_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= HAWK_CHANCE) continue;
        doCatchHawk(director, citizen, record, nowMs);
        lastHawkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Storm warnings: when it's storming, fishers on shore warn of the sea
    // instead of working it. Deep-sea fishers read the weather first.
    if (weatherFor(nowMs) === "storm") {
      for (const record of director.roster?.values?.() ?? []) {
        try {
          if (!record || record.role !== "commoner") continue;
          if (fisherTypeFor(record.username) !== FISHER_DEEPSEA) continue;
          const last = lastStormByCitizen.get(record.username) || 0;
          if (nowMs - last < STORM_COOLDOWN_MS) continue;
          const citizen = director.playerFor?.(record);
          if (!citizen) continue;
          if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
          if (Math.random() >= STORM_CHANCE) continue;
          doStormWarning(citizen, record.username);
          lastStormByCitizen.set(record.username, nowMs);
        } catch {
          // One bad citizen never breaks the tick.
        }
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-fishers] tick failed:", e?.message ?? e);
  }
}

/** The visible work: cast/haul animation + emote line + journal line. */
function doFishWork(director, record, citizen, type, nowMs) {
  const line = workLineFor(Math.random, type);
  if (!line) return;
  // Sometimes the loop lands a big one — the crowd moment.
  const spot = spotFor(record.username, record.kingdom, type);
  const fish = catchFor(record.username, spot, nowMs);
  if (Math.random() < BIG_CATCH_CHANCE) {
    try {
      citizen.forceChat?.(bigCatchLineFor(Math.random, fish, spot));
    } catch {
      // forceChat is best-effort.
    }
    playAnim(director, citizen, animFor(type));
    journalEvent(record.username, `Landed a big ${fish} at ${spot ? spot.name : "the water"} — the crowd loved it.`);
    return;
  }
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  playAnim(director, citizen, animFor(type));
  // One journal line per loop — the LLM's source of truth. Includes the
  // spot and the catch, so "what have you been up to?" is answerable, and
  // a note that the catch is for sale (buying dialogue is the LLM tier).
  journalEvent(
    record.username,
    `Fished ${spot ? spot.name : "the water"} — landing ${fish}. Fresh catch for sale.`
  );
}

/** Fresh-catch hawking: advertise the day's catch to nearby players. */
function doCatchHawk(director, citizen, record, nowMs) {
  void director;
  const spot = spotFor(record.username, record.kingdom, fisherTypeFor(record.username));
  const fish = catchFor(record.username, spot, nowMs);
  const line = hawkLineFor(Math.random, fish, spot);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Hawking fresh ${fish} from ${spot ? spot.name : "the water"}.`);
}

/** Storm warning from a deep-sea fisher on shore. */
function doStormWarning(citizen, username) {
  const line = stormLineFor(Math.random);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(username, "Stayed ashore in the storm and warned others off the water.");
}

/**
 * Fresh catch for a fisher — exported so CitizenMarketStalls can stock
 * fisher wares later. Actual selling rides on the market-stall haggle
 * system; this is the supply-side hook.
 */
function fishCatchFor(username, kingdom, dateMs) {
  const type = fisherTypeFor(username);
  if (!type) return null;
  const spot = spotFor(username, kingdom, type);
  return { type, spot: spot ? spot.name : "the water", fish: catchFor(username, spot, dateMs) };
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

module.exports = {
  tickFishers,
  // Pure helpers for tests and integration:
  hashStr,
  fisherTypeFor,
  spotFor,
  seasonFor,
  weatherFor,
  catchFor,
  canFish,
  workLineFor,
  bigCatchLineFor,
  hawkLineFor,
  stormLineFor,
  fishCatchFor,
  animFor,
  shouldFire,
  shouldHawk,
  shouldWarnStorm,
  pickOne,
  isRealPlayer,
  withinTiles,
  FISHER_TYPES,
  SPOTS,
  CATCHES,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastHawkByCitizen.clear();
    lastStormByCitizen.clear();
    lastPruneAt = 0;
  },
};
