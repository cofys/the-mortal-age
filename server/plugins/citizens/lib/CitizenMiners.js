"use strict";

/**
 * CitizenMiners — miner citizens who work the mines: prospectors read the
 * rock and call rich veins, diggers swing pickaxes, smelters work furnaces,
 * gem cutters cut gems in town.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a miner trade (or none)
 *   from their username hash — no storage, stable across restarts. Mine
 *   assignment prefers the citizen's kingdom; vein richness, shift rhythm,
 *   and rich-vein windows are all derived from the date + hash, so the
 *   simulation runs with zero players online at zero token cost. Work
 *   events are journaled once per visible loop so the interaction-tier
 *   LLM answers "what have you been up to?" truthfully (and can riff on
 *   hire offers — hiring dialogue is the LLM's job, journaled state is
 *   its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Miners near mines visibly work: swinging pickaxes (engine animation
 *   625), calling out rich veins, warning of cave-ins and gas pockets.
 *   Smelters and gem cutters work in town at furnaces and gem stalls.
 *   Players can mine alongside them; lingering players get hire offers.
 *
 * Zero LLM: scripted emote pools and callout lines, chance-gated.
 *
 * Wired into the director tick right after the farmers block.
 * Plain-node testable: CitizenMiners.test.js.
 */

// === Tuning: all magic numbers here ===
const MINER_RADIUS = 40; // tiles — visible work range (same as work loops/farmers)
const CALLOUT_RADIUS = 14; // tiles — rich-vein callouts, close enough to hear
const MINER_WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const MINER_WORK_CHANCE = 0.4; // per eligible citizen per tick
const CALLOUT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // rich-vein call at most every 4h
const CALLOUT_CHANCE = 0.35;
const HAZARD_COOLDOWN_MS = 6 * 60 * 60 * 1000; // hazard warnings at most every 6h
const HAZARD_CHANCE = 0.12; // rare — the mine mostly behaves
const PICKAXE_ANIM = 625; // engine pickaxe swing (Mining.plugin.js, verified)

// === Miner types ===
const MINER_PROSPECTOR = "prospector";
const MINER_DIGGER = "digger";
const MINER_SMELTER = "smelter";
const MINER_GEMCUTTER = "gem cutter";
const MINER_TYPES = Object.freeze([MINER_PROSPECTOR, MINER_DIGGER, MINER_SMELTER, MINER_GEMCUTTER]);

// === Mines (names match the mining plugin; rectangles live there — we only
// need names + kingdoms for derived assignment, never coordinates) ===
const MINES = Object.freeze([
  { name: "the Dwarven Mine", short: "dwarven", kingdom: "asgarnia" },
  { name: "the Mining Guild", short: "guild", kingdom: "asgarnia" },
  { name: "the Al Kharid mine", short: "alkharid", kingdom: "misthalin" },
  { name: "the Keldagrim mines", short: "keldagrim", kingdom: "keldagrim" },
  { name: "the Deep Delve", short: "delve", kingdom: "keldagrim" },
]);

// === Ores by type ===
const ORES = Object.freeze(["copper", "tin", "iron", "coal", "silver", "gold", "mithril", "adamant"]);

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastCalloutByCitizen = new Map(); // username -> timestamp
const lastHazardByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWorkByCitizen) {
    if (at < cutoff) lastWorkByCitizen.delete(k);
  }
  for (const [k, at] of lastCalloutByCitizen) {
    if (at < cutoff) lastCalloutByCitizen.delete(k);
  }
  for (const [k, at] of lastHazardByCitizen) {
    if (at < cutoff) lastHazardByCitizen.delete(k);
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
 * Miner trade for a username, or null for a non-miner.
 * ~35% of commoners mine; the trade is hash-derived and stable.
 */
function minerTypeFor(username) {
  if (!username) return null;
  const h = hashStr("miner|" + String(username).toLowerCase());
  if (h % 20 >= 7) return null; // not a miner
  return MINER_TYPES[h % MINER_TYPES.length];
}

/**
 * The mine this citizen works, preferring their kingdom (falls back to the
 * nearest kingdom with a mine). Derived, stable, no storage.
 */
function mineFor(username, kingdom) {
  const home = (MINES || []).filter((m) => m.kingdom === kingdom);
  const pool = home.length > 0 ? home : MINES;
  const h = hashStr("mine|" + String(username).toLowerCase());
  return pool[h % pool.length];
}

/**
 * Shift for a time of day. Diggers swing day shifts; prospectors roam at
 * dawn; smelters and gem cutters keep town hours. Pure: (dateMs) => shift.
 */
function shiftFor(dateMs) {
  const hour = new Date(dateMs).getUTCHours();
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 18) return "day";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

/**
 * Vein richness for a miner today: derived per-day so rich seams open and
 * close on a rhythm players can learn. "rich" days are contested — the
 * callout pass advertises them.
 */
function veinStateFor(username, dateMs) {
  const d = new Date(dateMs);
  const dayKey = d.getUTCFullYear() + "|" + Math.floor(dateMs / 86400000);
  const h = hashStr("vein|" + String(username).toLowerCase() + "|" + dayKey);
  const roll = h % 100;
  if (roll < 12) return "rich";
  if (roll < 30) return "depleted";
  return "normal";
}

/** The ore this miner is working today, from their mine. */
function oreFor(username, dateMs) {
  const h = hashStr("ore|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return ORES[h % ORES.length];
}

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = {
  [MINER_PROSPECTOR]: [
    "*taps the rock wall, listening*",
    "*studies the stone face*",
    "*marks a promising seam with chalk*",
    "*sniffs the air for gas*",
  ],
  [MINER_DIGGER]: [
    "*swings the pickaxe*",
    "*chips at the rock face*",
    "*hauls a cart of ore*",
    "*wedges a timber prop into place*",
  ],
  [MINER_SMELTER]: [
    "*stokes the furnace*",
    "*pours the molten metal*",
    "*quenches the fresh ingots*",
    "*rakes the coals*",
  ],
  [MINER_GEMCUTTER]: [
    "*facets a gemstone*",
    "*polishes a sapphire*",
    "*examines a rough stone against the light*",
    "*sets a cut gem aside*",
  ],
};

/** Scripted visible work line for a miner type, or null. */
function workLineFor(rng, type) {
  const pool = WORK_LINES[type];
  if (!pool) return null;
  return pickOne(rng, pool);
}

/** Rich-vein callout line — advertises a contested seam to nearby players. */
function richVeinLineFor(rng, mine, ore) {
  const mineName = mine && mine.name ? mine.name : "the mine";
  return pickOne(rng, [
    `Rich ${ore} vein opening in ${mineName}! Get down here before it's gone!`,
    `I found it — a fat ${ore} seam! ${mineName}, follow my voice!`,
    `${ore.charAt(0).toUpperCase() + ore.slice(1)} running rich today, lads! ${mineName}!`,
    `Word is out — rich ${ore} in ${mineName}. Swing while you can!`,
  ]);
}

/** Hazard warning line — cave-ins and gas pockets, from the mining hazards. */
function hazardLineFor(rng) {
  return pickOne(rng, [
    "*backs away as dust falls from the ceiling* Rock's groaning. Easy, lads.",
    "*holds up a hand* Gas. I smell it. Nobody swing 'til it clears.",
    "*shouts* TIMBER'S CRACKING! Get clear of the face!",
    "*taps the wall, frowning* This section's about to drop. Work the other side.",
  ]);
}

/** Hire offer for a lingering player — the LLM takes it from here. */
function hireLineFor(rng, mine) {
  const mineName = mine && mine.name ? mine.name : "the mine";
  return pickOne(rng, [
    `Need an extra pick down ${mineName}? I know where the ore hides.`,
    `Heading to the face? I could show you the rich seams, for a share.`,
    `You look like you can swing a pick. Work alongside me a while?`,
  ]);
}

/**
 * Decide whether this miner should do visible work now.
 * Pure: (rng, lastWorkMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastWorkMs, nowMs) {
  if (nowMs - (lastWorkMs || 0) < MINER_WORK_COOLDOWN_MS) return false;
  return rng() < MINER_WORK_CHANCE;
}

/** Decide whether this miner should call a rich vein now. Pure. */
function shouldCallout(rng, lastCalloutMs, nowMs) {
  if (nowMs - (lastCalloutMs || 0) < CALLOUT_COOLDOWN_MS) return false;
  return rng() < CALLOUT_CHANCE;
}

/** Decide whether a hazard warning should fire now. Pure. */
function shouldWarnHazard(rng, lastHazardMs, nowMs) {
  if (nowMs - (lastHazardMs || 0) < HAZARD_COOLDOWN_MS) return false;
  return rng() < HAZARD_CHANCE;
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

/** Play the pickaxe swing animation, best-effort. */
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

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → commoner → miner type → materialized →
// real player near → chance → work. Three passes: work, rich-vein callouts,
// hazard warnings.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickMiners(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners mine (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = minerTypeFor(record.username);
        if (!type) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < MINER_WORK_COOLDOWN_MS) continue;

        // 3. Citizen must be materialized (near a player already).
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. A real player must be within sight of the work.
        if (!anyRealPlayerNear(director, citizen, MINER_RADIUS)) continue;

        // 5. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= MINER_WORK_CHANCE) continue;
        doMineWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Rich-vein callouts: tighter radius, own cooldown. This is how players
    // learn a contested seam has opened.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = minerTypeFor(record.username);
        if (!type) continue;
        if (veinStateFor(record.username, nowMs) !== "rich") continue;
        const last = lastCalloutByCitizen.get(record.username) || 0;
        if (nowMs - last < CALLOUT_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, CALLOUT_RADIUS)) continue;
        if (Math.random() >= CALLOUT_CHANCE) continue;
        doRichVeinCallout(director, citizen, record, nowMs);
        lastCalloutByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Hazard warnings: rare, atmospheric. Cave-ins and gas from the hazards
    // module, as scripted lines — never actual damage (that's the skill's
    // job). Prospectors are the ones who smell trouble first.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        if (minerTypeFor(record.username) !== MINER_PROSPECTOR) continue;
        const last = lastHazardByCitizen.get(record.username) || 0;
        if (nowMs - last < HAZARD_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, CALLOUT_RADIUS)) continue;
        if (Math.random() >= HAZARD_CHANCE) continue;
        doHazardWarning(citizen, record.username);
        lastHazardByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-miners] tick failed:", e?.message ?? e);
  }
}

/** The visible work: pickaxe swing + emote line + journal line. */
function doMineWork(director, record, citizen, type, nowMs) {
  const line = workLineFor(Math.random, type);
  if (!line) return;
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  // Diggers and prospectors swing the pick; smelters and cutters work their
  // stations with the same swing motion.
  playAnim(director, citizen, PICKAXE_ANIM);
  // One journal line per loop — the LLM's source of truth. Includes the
  // mine and the ore, so "what have you been up to?" is answerable, and a
  // note that this miner could be hired (hiring dialogue is the LLM tier).
  const mine = mineFor(record.username, record.kingdom);
  const ore = oreFor(record.username, nowMs);
  const typeLabel = {
    [MINER_PROSPECTOR]: "prospecting rock",
    [MINER_DIGGER]: `digging ${ore}`,
    [MINER_SMELTER]: `smelting ${ore}`,
    [MINER_GEMCUTTER]: "cutting gems",
  }[type];
  journalEvent(
    record.username,
    `Worked ${mine ? mine.name : "the mine"} — ${typeLabel}. Available for hire as a ${type}.`
  );
}

/** Rich-vein callout: advertise the contested seam. */
function doRichVeinCallout(director, citizen, record, nowMs) {
  const mine = mineFor(record.username, record.kingdom);
  const ore = oreFor(record.username, nowMs);
  const line = richVeinLineFor(Math.random, mine, ore);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Called a rich ${ore} vein at ${mine ? mine.name : "the mine"}.`);
}

/** Hazard warning from a prospector. */
function doHazardWarning(citizen, username) {
  const line = hazardLineFor(Math.random);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(username, "Warned the crew about mine trouble (cave-in/gas).");
}

/**
 * Hire offer for a player who lingers. Called from chat-adjacent code paths;
 * returns the line or null. The LLM takes the conversation from here.
 */
function maybeHireOffer(rng, record) {
  const type = minerTypeFor(record && record.username);
  if (!type) return null;
  const mine = mineFor(record.username, record.kingdom);
  return hireLineFor(rng, mine);
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
  tickMiners,
  // Pure helpers for tests and integration:
  hashStr,
  minerTypeFor,
  mineFor,
  shiftFor,
  veinStateFor,
  oreFor,
  workLineFor,
  richVeinLineFor,
  hazardLineFor,
  hireLineFor,
  maybeHireOffer,
  shouldFire,
  shouldCallout,
  shouldWarnHazard,
  pickOne,
  isRealPlayer,
  withinTiles,
  MINER_TYPES,
  MINES,
  ORES,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastCalloutByCitizen.clear();
    lastHazardByCitizen.clear();
    lastPruneAt = 0;
  },
};
