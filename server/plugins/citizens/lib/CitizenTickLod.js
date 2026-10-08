"use strict";

/**
 * CitizenTickLod — level-of-detail tick strides for citizens.
 *
 * Not every citizen needs a full brain tick every cycle. This module is the
 * citizen-side authority for who ticks how often, based on distance to the
 * nearest real (human) player:
 *
 *   band    distance (Chebyshev tiles)   stride   meaning
 *   ----    --------------------------   ------   -----------------------
 *   near    0..32                        1        full tick every cycle
 *   mid     33..96                       3        tick every 3rd cycle
 *   far     97..240                      12       tick every 12th cycle
 *   asleep  >240 (or nobody online)      0        no brain tick at all
 *
 * The near/mid distance edges (32/96) match the bot runtime's LOD defaults
 * (BotBehaviorTask nearDistanceTiles/mediumDistanceTiles) so both layers
 * agree on bands. The far/asleep edge (240) is citizen-specific: beyond it
 * a citizen is background population — the director's data-tier systems
 * (needs, journal, kinship, the slow 60s tick) keep simulating them, so
 * nothing about their life actually stops.
 *
 * Tick storms: within a band, citizens are spread across the stride's cycles
 * by their deterministic desync slot (CitizenTimingDesync.slotFor), so the
 * 1/12th of far citizens due on a cycle is an even slice, not a burst.
 * Stride 1 (near) is always due — a player standing next to a citizen sees
 * full-speed behavior, identical to today.
 *
 * Band changes toward the player apply instantly (a citizen Jon walks up to
 * must run at full speed on the very next cycle); changes away from the
 * player wait out a small hysteresis margin so citizens at a band edge don't
 * flap between strides every cycle.
 *
 * Zero LLM: pure distance math plus the deterministic desync hash. No I/O,
 * no stored state beyond the roster-bounded band map (pruned hourly).
 */

const { slotFor } = require("./CitizenTimingDesync");

// --- tuning ------------------------------------------------------------------

/** Chebyshev tiles: at or under this distance a citizen is fully live. */
const NEAR_DISTANCE_TILES = 32;
/** Chebyshev tiles: at or under this distance a citizen is mid-detail. */
const MID_DISTANCE_TILES = 96;
/** Chebyshev tiles: beyond this distance a citizen is fully asleep. */
const ASLEEP_DISTANCE_TILES = 240;
/** Downgrades wait for the distance to clear the band edge by this margin. */
const HYSTERESIS_TILES = 8;

/** Tick every cycle. */
const NEAR_STRIDE = 1;
/** Tick every 3rd cycle. */
const MID_STRIDE = 3;
/** Tick every 12th cycle. */
const FAR_STRIDE = 12;

const BAND_NEAR = "near";
const BAND_MID = "mid";
const BAND_FAR = "far";
const BAND_ASLEEP = "asleep";

/** Prune band entries for citizens that left the roster this often. */
const BAND_PRUNE_INTERVAL_MS = 3600 * 1000;

// --- bands -------------------------------------------------------------------

function isKnownBand(band) {
  return (
    band === BAND_NEAR ||
    band === BAND_MID ||
    band === BAND_FAR ||
    band === BAND_ASLEEP
  );
}

/** Ordering: nearer bands sort first. Unknown bands sort as far. */
function bandRank(band) {
  switch (band) {
    case BAND_NEAR:
      return 0;
    case BAND_MID:
      return 1;
    case BAND_FAR:
      return 2;
    case BAND_ASLEEP:
      return 3;
    default:
      return 2;
  }
}

/**
 * Classify a distance (Chebyshev tiles, same plane) into a band.
 * Infinity (no real player anywhere) -> asleep. NaN (unmeasurable) -> far:
 * the conservative middle — not full cost, not frozen either.
 */
function resolveBand(distanceTiles) {
  const d = Number(distanceTiles);
  if (d === Number.POSITIVE_INFINITY) return BAND_ASLEEP;
  if (!Number.isFinite(d)) return BAND_FAR;
  const clamped = Math.max(0, d);
  if (clamped <= NEAR_DISTANCE_TILES) return BAND_NEAR;
  if (clamped <= MID_DISTANCE_TILES) return BAND_MID;
  if (clamped <= ASLEEP_DISTANCE_TILES) return BAND_FAR;
  return BAND_ASLEEP;
}

/** Tick stride for a band. 0 means "never due on the brain tick" (asleep). */
function strideForBand(band) {
  switch (band) {
    case BAND_NEAR:
      return NEAR_STRIDE;
    case BAND_MID:
      return MID_STRIDE;
    case BAND_FAR:
      return FAR_STRIDE;
    default:
      return 0;
  }
}

/** The outer distance edge of a band — used for downgrade hysteresis. */
function outerEdgeTiles(band) {
  switch (band) {
    case BAND_NEAR:
      return NEAR_DISTANCE_TILES;
    case BAND_MID:
      return MID_DISTANCE_TILES;
    case BAND_FAR:
      return ASLEEP_DISTANCE_TILES;
    default:
      return 0;
  }
}

/**
 * Apply hysteresis to a band transition. Upgrades (toward near) are instant;
 * downgrades (away) require the distance to clear the current band's outer
 * edge plus HYSTERESIS_TILES. First sighting (no previous band) resolves
 * directly.
 */
function updateBand(prevBand, distanceTiles) {
  const target = resolveBand(distanceTiles);
  if (!isKnownBand(prevBand)) return target;
  if (bandRank(target) <= bandRank(prevBand)) return target; // upgrade or same
  const d = Number(distanceTiles);
  if (!Number.isFinite(d)) return target; // Infinity -> asleep always applies
  if (d > outerEdgeTiles(prevBand) + HYSTERESIS_TILES) return target;
  return prevBand;
}

/**
 * Should this citizen's brain tick run on this cycle? Near citizens are
 * always due; mid/far citizens are due on their desync-phased slice of the
 * stride; asleep citizens never are.
 */
function isDueOnCycle(username, band, tickCount) {
  const stride = strideForBand(band);
  if (stride <= 0) return false;
  if (stride === 1) return true;
  const t = Math.floor(Number(tickCount));
  const tick = Number.isFinite(t) ? t : 0;
  return (tick + slotFor(username, stride)) % stride === 0;
}

/**
 * True when a band change should force an immediate catch-up tick — i.e. the
 * citizen moved to a nearer band (a player walked in) or was just seen for
 * the first time. Moving away never forces: the citizen simply coasts.
 */
function shouldForceTickOnBandChange(prevBand, nextBand) {
  if (!isKnownBand(prevBand)) return true;
  if (!isKnownBand(nextBand)) return false;
  return bandRank(nextBand) < bandRank(prevBand);
}

// --- distance helpers --------------------------------------------------------

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

/** Chebyshev distance in tiles on the same plane; Infinity otherwise. */
function chebyshevDistanceTiles(a, b) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return Number.POSITIVE_INFINITY;
    return Math.max(
      Math.abs(la.getX() - lb.getX()),
      Math.abs(la.getY() - lb.getY())
    );
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Distance from a citizen's bot player to the nearest real player in its
 * local viewport. Early-exits once near — a nearer result can't change the
 * band. Infinity when nobody real is around.
 */
function nearestRealPlayerDistance(bot) {
  let locals = [];
  try {
    locals = [...(bot.getLocalPlayers?.() ?? [])];
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const p of locals) {
    if (p === bot || !isRealPlayer(p)) continue;
    const d = chebyshevDistanceTiles(bot, p);
    if (d < best) best = d;
    if (best <= NEAR_DISTANCE_TILES) break;
  }
  return best;
}

/**
 * Distance from a citizen's bot to the nearest real player using the
 * director's global positions list (World.players). This is the SAME data
 * source the director's spawn/despawn logic uses, so LOD classification
 * agrees with materialization. Prefer this over nearestRealPlayerDistance()
 * (bot viewport), which can be empty even with a player adjacent.
 */
function nearestRealPlayerDistanceFromPositions(bot, positions) {
  let bx, by, bz;
  try {
    const loc = bot.getLocation?.();
    if (!loc) return Number.POSITIVE_INFINITY;
    bx = loc.getX?.() ?? loc.x;
    by = loc.getY?.() ?? loc.y;
    bz = loc.getZ?.() ?? loc.z ?? 0;
    if (!Number.isFinite(bx) || !Number.isFinite(by)) {
      return Number.POSITIVE_INFINITY;
    }
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const p of positions ?? []) {
    try {
      if ((p.z ?? 0) !== (bz ?? 0)) continue;
      const d = Math.max(
        Math.abs((p.x ?? 0) - bx),
        Math.abs((p.y ?? 0) - by)
      );
      if (d < best) best = d;
      if (best <= NEAR_DISTANCE_TILES) break;
    } catch {
      // Skip unreadable positions.
    }
  }
  return best;
}

// --- per-tick driver -----------------------------------------------------------

const bandByCitizen = new Map(); // lowercased username -> band (roster-bounded)
let lastPruneAt = 0;

function normalizeKey(record) {
  return String(record?.username ?? record?.name ?? "").toLowerCase();
}

function pruneBands(rosterKeys, nowMs) {
  if (nowMs - lastPruneAt < BAND_PRUNE_INTERVAL_MS) return;
  lastPruneAt = nowMs;
  for (const key of bandByCitizen.keys()) {
    if (!rosterKeys.has(key)) bandByCitizen.delete(key);
  }
}

function bandOf(record) {
  return bandByCitizen.get(normalizeKey(record)) ?? null;
}

/** Test/maintenance hook: drop all cached bands. */
function clearBands() {
  bandByCitizen.clear();
}

/**
 * Gate for foreground per-citizen work in a feature tick.
 *
 * Returns true when this citizen's visible-life work should run this cycle:
 * - No band recorded (offline, or the LOD scan hasn't classified them yet):
 *   true — never gate blind. Newly spawned citizens (a player just walked
 *   into range) have no band until the next LOD scan, so spawn
 *   responsiveness is preserved by construction.
 * - Asleep band: false — no real player within 240 tiles, so nothing they
 *   do is visible. (The data tier — needs, journal, kinship, the slow tick —
 *   keeps simulating them; this gate is foreground-only.)
 * - Near band: always true — a player may be watching; identical to the
 *   pre-LOD desync gate.
 * - Mid/far band: true on the citizen's desync-phased slice of the band
 *   stride (every 3rd / 12th cycle). Slots spread the due citizens evenly
 *   so distant citizens don't pulse in lockstep.
 *
 * Compose with the feature's existing desync gate (LOD first — it's a single
 * Map lookup; the desync hash runs only for citizens the LOD keeps):
 *
 *   const { brainTickDue } = require("./CitizenTickLod");
 *   if (!brainTickDue(director, record, desync?.tick)) continue;
 *   if (desync && !isCitizenDue(record, desync.tick, desync.spread)) continue;
 *
 * tickCount should be the director's fast-tick counter (aiTickCount) — the
 * same counter the desync gate uses — so both gates advance together. When
 * omitted it falls back to director.aiTickCount.
 *
 * NOTE (band upgrades): a citizen that just upgraded toward near is always
 * LOD-due (stride 1), so no force-tick is needed here — the lodForceTickAt
 * stamp exists for the bot-brain layer, whose own observer scan can miss
 * web-client sessions.
 */
function brainTickDue(director, record, tickCount) {
  const band = bandOf(record);
  if (!isKnownBand(band)) return true;
  if (band === BAND_ASLEEP) return false;
  let t = tickCount;
  if (t == null) {
    t = Math.floor(Number(director?.aiTickCount));
    if (!Number.isFinite(t)) t = 0;
  }
  const username = record?.username ?? record?.name ?? "";
  return isDueOnCycle(username, band, t);
}

/**
 * Recompute LOD bands for every online citizen. Called once per director
 * proximity-tick cycle, before the feature ticks run. Stamps
 * state.lodBand / state.lodStride / state.lodForceTickAt on each citizen's
 * bot state so the brain and feature ticks can gate on them.
 *
 * Returns a { near, mid, far, asleep, forced } summary for diagnostics.
 * Never throws: a failed scan keeps the previous bands.
 */
function tickLodBands(director, nowMs) {
  const summary = { near: 0, mid: 0, far: 0, asleep: 0, forced: 0 };
  try {
    const roster = director.roster;
    const records = roster?.values ? [...roster.values()] : [];
    const rosterKeys = new Set(records.map(normalizeKey));
    pruneBands(rosterKeys, nowMs);

    // Use the director's global real-player positions (World.players), not
    // the bot's local viewport. Bot getLocalPlayers() can be empty even when
    // a real player is standing next to the citizen, which misclassifies
    // everyone as "asleep" and freezes all visible life. The director's
    // spawn logic already uses realPlayerPositions() — the LOD must agree.
    // Falls back to the bot viewport when the director doesn't provide
    // positions (e.g., in unit tests).
    let positions = [];
    try {
      positions = director.realPlayerPositions?.() ?? [];
    } catch {
      positions = [];
    }

    for (const record of records) {
      const key = normalizeKey(record);
      if (!key) continue;
      let bot = null;
      try {
        if (director.isOnline?.(record) !== true) {
          bandByCitizen.delete(key);
          continue;
        }
        bot = director.getBot?.(record) ?? null;
      } catch {
        continue;
      }
      if (!bot) continue;

      // Prefer the director's global positions; fall back to the bot's local
      // viewport when the director doesn't provide positions (unit tests).
      const distance =
        positions.length > 0
          ? nearestRealPlayerDistanceFromPositions(bot, positions)
          : nearestRealPlayerDistance(bot);
      const prev = bandByCitizen.get(key) ?? null;
      const next = updateBand(prev, distance);
      bandByCitizen.set(key, next);
      summary[next] = (summary[next] ?? 0) + 1;

      if (shouldForceTickOnBandChange(prev, next)) {
        summary.forced += 1;
      }

      try {
        const state = director.runtime?.()?.botStatesByName?.get(record.username);
        if (state) {
          state.lodBand = next;
          state.lodStride = strideForBand(next);
          if (shouldForceTickOnBandChange(prev, next)) {
            state.lodForceTickAt = nowMs;
          }
        }
      } catch {
        // Stamping is best-effort; the band map is the authority.
      }
    }
  } catch (e) {
    // Never let LOD classification crash the director tick.
    try {
      director.log?.("tick-lod failed", { error: String(e?.message ?? e) });
    } catch {
      /* ignore */
    }
  }
  return summary;
}

module.exports = {
  // tuning
  NEAR_DISTANCE_TILES,
  MID_DISTANCE_TILES,
  ASLEEP_DISTANCE_TILES,
  HYSTERESIS_TILES,
  NEAR_STRIDE,
  MID_STRIDE,
  FAR_STRIDE,
  BAND_NEAR,
  BAND_MID,
  BAND_FAR,
  BAND_ASLEEP,
  // pure classification
  isKnownBand,
  bandRank,
  resolveBand,
  strideForBand,
  updateBand,
  isDueOnCycle,
  shouldForceTickOnBandChange,
  // distance helpers
  isRealPlayer,
  chebyshevDistanceTiles,
  nearestRealPlayerDistance,
  // per-tick driver
  tickLodBands,
  bandOf,
  clearBands,
  // foreground gate for feature ticks
  brainTickDue,
};
