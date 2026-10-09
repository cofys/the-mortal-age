"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenHunters — hunter citizens who work the wilds: trackers read trails,
 * bowmen loose arrows, trappers set snares, beastmasters work with trained
 * animals.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a hunter trade (or none)
 *   from their username hash — no storage, stable across restarts. Hunting
 *   ground assignment prefers the citizen's kingdom; prey tables, trophy
 *   chances and danger levels are all derived from the date + hash, so the
 *   simulation runs with zero players online at zero token cost. Work
 *   events are journaled once per visible loop so the interaction-tier
 *   LLM answers "what have you been up to?" truthfully (and can riff on
 *   selling fresh meat and hides — buying dialogue is the LLM's job,
 *   journaled state is its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Hunters visibly work the wilds: bow draws, snare settings, trail
 *   readings. Trophy kills trigger celebrations; hunters hawk fresh meat
 *   and hides to passers-by. In dangerous grounds they warn of the beasts.
 *
 * Zero LLM: scripted emote pools, kill/hawk/warning lines, chance-gated.
 *
 * Wired into the director tick right after the fishers block.
 * Plain-node testable: CitizenHunters.test.js.
 */

// === Tuning: all magic numbers here ===
const HUNT_RADIUS = 40; // tiles — visible work range (same as fishers/miners/farmers)
const HAWK_RADIUS = 14; // tiles — meat/hide hawking, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const HAWK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // hawk meat/hides at most every 4h
const HAWK_CHANCE = 0.35;
const WARN_COOLDOWN_MS = 6 * 60 * 60 * 1000; // danger warnings at most every 6h
const WARN_CHANCE = 0.5; // when the ground is dangerous, warnings are common
const TROPHY_CHANCE = 0.08; // a visible loop bags a trophy this often
const INJURY_CHANCE = 0.06; // a visible loop in dangerous ground goes wrong this often

// Engine animations (verified from other work-loop features).
const ANIM_BOW = 624; // bow draw / arrow loose
const ANIM_TRAP = 620; // bending, setting snares
const ANIM_TRACK = 621; // crouching, reading the ground
const ANIM_BEAST = 625; // working with the animal

// === Hunter types ===
const HUNTER_TRACKER = "tracker";
const HUNTER_BOWMAN = "bowman";
const HUNTER_TRAPPER = "trapper";
const HUNTER_BEASTMASTER = "beastmaster";
const HUNTER_TYPES = Object.freeze([HUNTER_TRACKER, HUNTER_BOWMAN, HUNTER_TRAPPER, HUNTER_BEASTMASTER]);

// === Hunting grounds (names players recognise; kingdoms for derived
// assignment — we never need coordinates, only names) ===
const GROUNDS = Object.freeze([
  { name: "the Kandarin forest", short: "kandarin", kingdom: "kandarin", danger: "low" },
  { name: "the Seers' village woods", short: "seers", kingdom: "kandarin", danger: "low" },
  { name: "the Feldip jungle", short: "feldip", kingdom: "kandarin", danger: "high" },
  { name: "the Keldagrim foothills", short: "keldagrim", kingdom: "keldagrim", danger: "low" },
  { name: "the Fremennik tundra", short: "fremennik", kingdom: "keldagrim", danger: "medium" },
  { name: "the White Wolf Mountain passes", short: "wolfmountain", kingdom: "keldagrim", danger: "medium" },
  { name: "the Misthalin plains", short: "misthalin", kingdom: "misthalin", danger: "low" },
  { name: "the Varrock wilds edge", short: "varrock", kingdom: "misthalin", danger: "medium" },
  { name: "the Mort Myre swamps", short: "mortmyre", kingdom: "morytania", danger: "high" },
  { name: "the Haunted Woods", short: "haunted", kingdom: "morytania", danger: "high" },
  { name: "the Wilderness fringe", short: "wilderness", kingdom: "morytania", danger: "high" },
  { name: "the Asgarnian countryside", short: "asgarnia", kingdom: "asgarnia", danger: "low" },
  { name: "the Goblin Village marches", short: "goblin", kingdom: "asgarnia", danger: "medium" },
  { name: "the Taverley dungeon mouth", short: "taverley", kingdom: "asgarnia", danger: "high" },
]);

// === Prey by ground danger ===
const PREY = Object.freeze({
  low: ["rabbit", "pheasant", "squirrel", "partridge"],
  medium: ["deer", "boar", "fox", "badger"],
  high: ["giant boar", "dire wolf", "jungle panther", "swamp basilisk"],
});

// === Trophy prey (rare, celebrated) ===
const TROPHIES = Object.freeze({
  low: ["great grey owl", "albino rabbit"],
  medium: ["twelve-point stag", "black boar"],
  high: ["drake of the swamps", "jungle king panther"],
});

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastHawkByCitizen = new Map(); // username -> timestamp
const lastWarnByCitizen = new Map(); // username -> timestamp

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
  for (const [k, at] of lastWarnByCitizen) {
    if (at < cutoff) lastWarnByCitizen.delete(k);
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
 * Hunter trade for a username, or null for a non-hunter.
 * ~35% of commoners hunt; the trade is hash-derived and stable.
 */
function hunterTypeFor(username) {
  if (!username) return null;
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "hunter") return null;
  const h = hashStr("hunter|" + String(username).toLowerCase());
  return HUNTER_TYPES[h % HUNTER_TYPES.length];
}

/**
 * The ground this citizen hunts, preferring their kingdom (falls back to
 * all grounds). Beastmasters prefer low-danger ground — they work animals,
 * not ambushes.
 */
function groundFor(username, kingdom, type) {
  let pool = (GROUNDS || []).filter((g) => g.kingdom === kingdom);
  if (pool.length === 0) pool = GROUNDS;
  if (type === HUNTER_BEASTMASTER) {
    const calm = pool.filter((g) => g.danger === "low");
    pool = calm.length > 0 ? calm : (GROUNDS || []).filter((g) => g.danger === "low");
  }
  const h = hashStr("ground|" + String(username).toLowerCase());
  return pool[h % pool.length];
}

/** The prey this hunter bags today, from their ground's table. */
function preyFor(username, ground, dateMs) {
  const danger = (ground && ground.danger) || "low";
  const pool = PREY[danger] || PREY.low;
  const h = hashStr("prey|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return pool[h % pool.length];
}

/** The trophy this hunter bags on a trophy loop, from their ground. */
function trophyFor(username, ground, dateMs) {
  const danger = (ground && ground.danger) || "low";
  const pool = TROPHIES[danger] || TROPHIES.low;
  const h = hashStr("trophy|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return pool[h % pool.length];
}

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = {
  [HUNTER_TRACKER]: [
    "Tracking game.",
    "On the trail.",
    "Tracker working.",
  ],
  [HUNTER_BOWMAN]: [
    "Bow ready.",
    "Hunting today.",
    "Arrows nocked.",
  ],
  [HUNTER_TRAPPER]: [
    "Setting traps.",
    "Traps laid.",
    "Trapper at work.",
  ],
  [HUNTER_BEASTMASTER]: [
    "Working with beasts.",
    "Training today.",
    "Beastmaster here.",
  ],
};

/** Scripted visible work line for a hunter type, or null. */
function workLineFor(rng, type) {
  const pool = WORK_LINES[type];
  if (!pool) return null;
  return pickOne(rng, pool);
}

/** Trophy-kill celebration — the moment that draws a crowd. */
function trophyLineFor(rng, trophy, ground) {
  const groundName = ground && ground.name ? ground.name : "the wilds";
  return pickOne(rng, [
    `Look at this beauty! A ${trophy}, taken clean in ${groundName}!`,
    `HA! The ${trophy} is down! Twenty years hunting and this is the one!`,
    `A ${trophy}! Right out of ${groundName}! The lodge will want to see this!`,
    `That's the ${trophy} I've been tracking all month. What a beast!`,
  ]);
}

/** Fresh meat/hide hawking line for passers-by. */
function hawkLineFor(rng, prey, ground) {
  const groundName = ground && ground.name ? ground.name : "the wilds";
  return pickOne(rng, [
    `Fresh ${prey}, hunted this morning in ${groundName}! Good eating, fair price!`,
    `Who needs meat? ${prey.charAt(0).toUpperCase() + prey.slice(1)}, fresh off the hunt!`,
    `${prey.charAt(0).toUpperCase() + prey.slice(1)} hides for sale! Cured and ready, best in the city!`,
    `Dinner sorted, friend — fresh ${prey}, and the hide's yours too if you ask nice.`,
  ]);
}

/** Danger warning — hunters warn of the beasts in high-danger ground. */
function warnLineFor(rng, ground) {
  const groundName = ground && ground.name ? ground.name : "the wilds";
  return pickOne(rng, [
    `*grimaces* ${groundName} isn't safe today. The big ones are moving. Keep your eyes open.`,
    `*lowers voice* Something's stalking ${groundName}. Travel in pairs, friend.`,
    `*checks the treeline* The beasts are restless. I'd not go in unarmed.`,
    `*shakes head* Lost a good hound in ${groundName} yesterday. Mind yourself out there.`,
  ]);
}

/** Injury line — a hunt went wrong in dangerous ground (journaled, no real damage). */
function injuryLineFor(rng, ground) {
  const groundName = ground && ground.name ? ground.name : "the wilds";
  return pickOne(rng, [
    `*limps, clutching an arm* The thing in ${groundName} got me. I'll live. Mostly.`,
    `*presses a cloth to a bleeding leg* Careful out there — ${groundName} bit back today.`,
    `*sits down hard* Took a tusk to the shoulder in ${groundName}. The boar got the worse of it.`,
  ]);
}

/**
 * Decide whether this hunter should do visible work now.
 * Pure: (rng, lastWorkMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastWorkMs, nowMs) {
  if (nowMs - (lastWorkMs || 0) < WORK_COOLDOWN_MS) return false;
  return rng() < WORK_CHANCE;
}

/** Decide whether this hunter should hawk meat/hides now. Pure. */
function shouldHawk(rng, lastHawkMs, nowMs) {
  if (nowMs - (lastHawkMs || 0) < HAWK_COOLDOWN_MS) return false;
  return rng() < HAWK_CHANCE;
}

/** Decide whether a danger warning should fire now. Pure. */
function shouldWarn(rng, lastWarnMs, nowMs) {
  if (nowMs - (lastWarnMs || 0) < WARN_COOLDOWN_MS) return false;
  return rng() < WARN_CHANCE;
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

/** Play a hunting animation, best-effort. */
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

/** Animation for a hunter type. */
function animFor(type) {
  if (type === HUNTER_BOWMAN) return ANIM_BOW;
  if (type === HUNTER_TRAPPER) return ANIM_TRAP;
  if (type === HUNTER_TRACKER) return ANIM_TRACK;
  return ANIM_BEAST; // beastmasters work their animals
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → commoner → hunter type → materialized →
// real player near → chance → work. Three passes: work, meat/hide hawking,
// danger warnings.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickHunters(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners hunt (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = hunterTypeFor(record.username);
        if (!type) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        // 3. Citizen must be materialized (near a player already).
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. A real player must be within sight of the wilds.
        if (!anyRealPlayerNear(director, citizen, HUNT_RADIUS)) continue;

        // 5. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= WORK_CHANCE) continue;
        doHuntWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Meat/hide hawking: tighter radius, own cooldown. Players learn who
    // has the day's hunt.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = hunterTypeFor(record.username);
        if (!type) continue;
        const last = lastHawkByCitizen.get(record.username) || 0;
        if (nowMs - last < HAWK_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= HAWK_CHANCE) continue;
        doHuntHawk(director, citizen, record, nowMs);
        lastHawkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Danger warnings: in high-danger ground, hunters warn of the beasts
    // instead of just working. Trackers and beastmasters read the signs
    // first.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = hunterTypeFor(record.username);
        if (type !== HUNTER_TRACKER && type !== HUNTER_BEASTMASTER) continue;
        const ground = groundFor(record.username, record.kingdom, type);
        if (!ground || ground.danger !== "high") continue;
        const last = lastWarnByCitizen.get(record.username) || 0;
        if (nowMs - last < WARN_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= WARN_CHANCE) continue;
        doDangerWarning(citizen, record.username, ground);
        lastWarnByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-hunters] tick failed:", e?.message ?? e);
  }
}

/** The visible work: animation + emote line + journal line. */
function doHuntWork(director, record, citizen, type, nowMs) {
  const line = workLineFor(Math.random, type);
  if (!line) return;
  const ground = groundFor(record.username, record.kingdom, type);
  // Trophy loops are the crowd moment.
  if (Math.random() < TROPHY_CHANCE) {
    const trophy = trophyFor(record.username, ground, nowMs);
    try {
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [trophyLineFor(Math.random, trophy, ground)] })); }
    } catch {
      // forceChat is best-effort.
    }
    playAnim(director, citizen, animFor(type));
    journalEvent(record.username, `Bagged a trophy ${trophy} in ${ground ? ground.name : "the wilds"} — the crowd loved it.`);
    return;
  }
  // Dangerous ground can bite back (scripted injury, no real damage).
  if (ground && ground.danger === "high" && Math.random() < INJURY_CHANCE) {
    try {
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [injuryLineFor(Math.random, ground)] })); }
    } catch {
      // forceChat is best-effort.
    }
    playAnim(director, citizen, ANIM_TRACK);
    journalEvent(record.username, `Got mauled in ${ground.name} — hurt, but still hunting tomorrow.`);
    return;
  }
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  playAnim(director, citizen, animFor(type));
  // One journal line per loop — the LLM's source of truth. Includes the
  // ground and the prey, so "what have you been up to?" is answerable, and
  // a note that the meat and hides are for sale (buying dialogue is the
  // LLM tier).
  const prey = preyFor(record.username, ground, nowMs);
  journalEvent(
    record.username,
    `Hunted ${ground ? ground.name : "the wilds"} — bagged a ${prey}. Fresh meat and hides for sale.`
  );
}

/** Meat/hide hawking: advertise the day's hunt to nearby players. */
function doHuntHawk(director, citizen, record, nowMs) {
  void director;
  const ground = groundFor(record.username, record.kingdom, hunterTypeFor(record.username));
  const prey = preyFor(record.username, ground, nowMs);
  const line = hawkLineFor(Math.random, prey, ground);
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Hawking fresh ${prey} from ${ground ? ground.name : "the wilds"}.`);
}

/** Danger warning from a tracker or beastmaster in high-danger ground. */
function doDangerWarning(citizen, username, ground) {
  const line = warnLineFor(Math.random, ground);
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(username, `Warned others about the dangers in ${ground ? ground.name : "the wilds"}.`);
}

/**
 * Fresh hunt loot for a hunter — exported so CitizenMarketStalls can stock
 * hunter wares later. Actual selling rides on the market-stall haggle
 * system; this is the supply-side hook.
 */
function huntLootFor(username, kingdom, dateMs) {
  const type = hunterTypeFor(username);
  if (!type) return null;
  const ground = groundFor(username, kingdom, type);
  return { type, ground: ground ? ground.name : "the wilds", prey: preyFor(username, ground, dateMs) };
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
  tickHunters,
  // Pure helpers for tests and integration:
  hashStr,
  hunterTypeFor,
  groundFor,
  preyFor,
  trophyFor,
  workLineFor,
  trophyLineFor,
  hawkLineFor,
  warnLineFor,
  injuryLineFor,
  huntLootFor,
  animFor,
  shouldFire,
  shouldHawk,
  shouldWarn,
  pickOne,
  isRealPlayer,
  withinTiles,
  HUNTER_TYPES,
  GROUNDS,
  PREY,
  TROPHIES,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastHawkByCitizen.clear();
    lastWarnByCitizen.clear();
    lastPruneAt = 0;
  },
};
