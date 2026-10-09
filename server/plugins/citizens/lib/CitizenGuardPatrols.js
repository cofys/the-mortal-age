"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenGuardPatrols — the visible watch: guards walk their beat like they
 * mean it.
 *
 * WHAT IT DOES (data tier, free):
 *   Guards on patrol pause at checkpoints and call out scripted check-ins,
 *   respond to disturbances (notorious players nearby, recent argued/attack
 *   journals with a tile), offer escorts to nearby players and walk with
 *   them a ways, light torches and double their rounds at night. Non-guard
 *   citizens near a patrolling guard occasionally say reassured lines.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   forceChat check-ins ("East wall checked — all quiet."), disturbance
 *   responses ("Stand down! The watch is here.") with the guard actually
 *   walking toward the trouble, escort offers ("Walk and I'll follow.")
 *   with the guard following for up to 2 minutes, night-watch torch
 *   announcements, and citizens saying they feel safer near the watch.
 *
 * Zero LLM: every line is scripted from pools; personalities only nudge
 * the pick via a seeded rng. Everything journaled so the LLM mouth can
 * riff on it later ("walked the east wall last night").
 *
 * The brain/action layer (GuardPatrol.js) owns the actual waypoint circuit;
 * this module is the visible story on top of it. Wired into the director
 * tick in tickProximity(), right after the market stalls block.
 * Plain-node testable: CitizenGuardPatrols.test.js.
 */

// === Tuning: all magic numbers here ===
const CHECKIN_RADIUS = 14; // tiles — a real player must be near to see a check-in
const CHECKIN_COOLDOWN_MS = 15 * 60 * 1000; // per guard (halved at night)
const CHECKIN_CHANCE = 0.25;

const RESPONSE_RADIUS = 12; // tiles — disturbance scan around the guard
const RESPONSE_COOLDOWN_MS = 5 * 60 * 1000;
const NOTORIETY_THRESHOLD = 0.5; // memory notoriety that draws the watch
const DISTURBANCE_FRESH_MS = 5 * 60 * 1000; // journaled fights this fresh count

const ESCORT_OFFER_RADIUS = 4; // tiles — player standing by the guard
const ESCORT_OFFER_COOLDOWN_MS = 30 * 60 * 1000;
const ESCORT_FOLLOW_MAX_TILES = 30; // from where the escort started
const ESCORT_FOLLOW_MAX_MS = 2 * 60 * 1000;

const REASSURE_RADIUS = 8; // tiles — citizen must be near a guard
const REASSURE_COOLDOWN_MS = 45 * 60 * 1000;
const REASSURE_CHANCE = 0.2;

const TORCH_ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // once per night-ish

// === Line pools (scripted, zero LLM) ===
const CHECKIN_DAY = Object.freeze([
  "East wall checked — all quiet.",
  "Market sweep done. Nothing to report.",
  "Gate's secure. The watch is on it.",
  "Quiet streets today. Good.",
  "Checked the {site} — peaceful.",
  "West wall walked. No trouble.",
]);

const CHECKIN_NIGHT = Object.freeze([
  "Night watch. Streets are quiet.",
  "Torches burning, gates barred. All's well.",
  "Mind the shadows near the {site} — I'll walk it twice tonight.",
  "Quiet night. The watch thanks you for staying in.",
  "Checked the {site} by torchlight — clear.",
]);

const SITES = Object.freeze([
  "market",
  "east gate",
  "docks",
  "west wall",
  "tavern row",
  "temple steps",
]);

const DISTURBANCE_LINES = Object.freeze([
  "Stand down! The watch is here.",
  "Break it up — now.",
  "Easy. Nobody bleeds on my beat.",
  "You, {name}. The watch has been warned about you — move along.",
]);

const DISTURBANCE_QUERY_LINES = Object.freeze([
  "What's going on over there?!",
  "Hold it — what happened here?",
  "I heard shouting. Talk.",
]);

const ESCORT_OFFER_LINES = Object.freeze([
  "Need an escort anywhere, friend? Walk and I'll follow.",
  "Heading somewhere dangerous? I'll walk with you a ways.",
  "The streets are safer with the watch beside you. Lead on.",
]);

const VIP_ESCORT_LINES = Object.freeze([
  "I'll walk with you a ways, master {name}.",
  "Right this way, {name}. The watch has your back.",
]);

const REASSURE_LINES = Object.freeze([
  "Glad the watch is about.",
  "Feel safer with the guards walking.",
  "The watch keeps these streets safe.",
  "Nothing bad happens when the guards are near.",
]);

const TORCH_LINES = Object.freeze([
  "Torches lit — the night watch begins.",
  "Lighting the torches. Night watch — everyone inside soon.",
]);

const DISTURBANCE_KINDS = new Set(["argued", "attack", "theft", "combat"]);

// === State ===
const lastCheckIn = new Map(); // guard username -> timestamp
const lastResponse = new Map(); // guard username -> timestamp
const lastEscortOffer = new Map(); // guard username -> timestamp
const lastReassure = new Map(); // citizen username -> timestamp
const lastTorchAnnounce = new Map(); // guard username -> timestamp
const activeEscorts = new Map(); // guard username -> { target, startTile, until }

let lastPruneAt = 0;
function pruneMaps(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastCheckIn, lastResponse, lastEscortOffer, lastReassure, lastTorchAnnounce]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
  for (const [k, st] of activeEscorts) {
    if (!st || nowMs > st.until) activeEscorts.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

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

/** Pure Chebyshev distance on plain numbers. */
function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Cheap Chebyshev distance check between engine objects (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return chebyshev(la.getX(), la.getY(), lb.getX(), lb.getY()) <= radius;
  } catch {
    return false;
  }
}

/** Night on the wall clock: 21:00–04:59 server time. */
function isNightHour(hour) {
  return hour >= 21 || hour < 5;
}

/**
 * Generic cooldown + chance gate. Pure: (rng, lastMs, nowMs, cooldownMs, chance)
 * => boolean. Test this.
 */
function shouldFire(rng, lastMs, nowMs, cooldownMs, chance) {
  if (nowMs - (lastMs || 0) < cooldownMs) return false;
  return rng() < chance;
}

/** Fill "{name}" style slots in a scripted line. */
function fillLine(line, vars) {
  let out = String(line ?? "");
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.split(`{${k}}`).join(String(v ?? ""));
  }
  return out;
}

/** Safe notoriety read; 0 when memory is unavailable. */
function notorietyOf(username, nowMs, memory) {
  try {
    const mem = memory ?? require("./CitizenMemory").getMemory();
    const n = mem.notoriety?.(username, nowMs);
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

/** Pure: pick a check-in line for the time of day. */
function pickCheckInLine(rng, night) {
  const pool = night ? CHECKIN_NIGHT : CHECKIN_DAY;
  return fillLine(pickOne(rng, pool), { site: pickOne(rng, SITES) });
}

/** Pure: should this escort end? */
function escortShouldEnd(state, targetTile, nowMs) {
  if (!state || !targetTile) return true;
  if (nowMs > state.until) return true;
  if (chebyshev(state.startTile.x, state.startTile.y, targetTile.x, targetTile.y) > ESCORT_FOLLOW_MAX_TILES) {
    return true;
  }
  return false;
}

/** Find an online player by username (case-insensitive). */
function findPlayerByName(players, name) {
  const want = String(name ?? "").toLowerCase();
  for (const p of players ?? []) {
    try {
      if (String(p.getUsername?.() ?? "").toLowerCase() === want) return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Plain tile of an engine player, or null. */
function botTile(player) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ() ?? 0 };
  } catch {
    return null;
  }
}

function makeLocation(director, x, y, z) {
  try {
    const Loc = director?.api?.core?.Location;
    if (Loc) return new Loc(x, y, z ?? 0);
  } catch {
    // Non-fatal.
  }
  return null;
}

function walkTo(director, bot, tile) {
  try {
    const loc = makeLocation(director, tile.x, tile.y, tile.z);
    if (!loc) return false;
    bot.moveTo?.(loc);
    return true;
  } catch {
    return false;
  }
}

function journal(director, name, kind, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(name, kind, text, data ? { data } : undefined);
  } catch {
    // Journal must never break the patrol.
  }
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me) return out;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || !isRealPlayer(p)) continue;
      const t = botTile(p);
      if (t && chebyshev(me.x, me.y, t.x, t.y) <= tiles) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

// ============================================================================
// Per-guard tick.
// ============================================================================

function tickGuard(director, record, bot, nowMs, night, rng) {
  const username = record.username;
  const me = botTile(bot);
  if (!me) return;

  const playersNear = realPlayersWithin(bot, CHECKIN_RADIUS);
  const seen = playersNear.length > 0;

  // --- Night watch: torch announcement (once per night-ish) ---
  if (night && seen) {
    const last = lastTorchAnnounce.get(username) || 0;
    if (nowMs - last >= TORCH_ANNOUNCE_COOLDOWN_MS) {
      const line = pickOne(rng, TORCH_LINES);
      try {
        { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      } catch { /* cosmetic */ }
      journal(director, username, "patrol", "Lit the torches — the night watch begins.");
      lastTorchAnnounce.set(username, nowMs);
    }
  }

  // --- Checkpoint check-ins ---
  if (seen) {
    const cooldown = night ? CHECKIN_COOLDOWN_MS / 2 : CHECKIN_COOLDOWN_MS;
    const last = lastCheckIn.get(username) || 0;
    if (shouldFire(rng, last, nowMs, cooldown, CHECKIN_CHANCE)) {
      const line = pickCheckInLine(rng, night);
      try {
        { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line.slice(0, 120)] })); }
      } catch { /* cosmetic */ }
      journal(director, username, "patrol", `Beat check-in: ${line}`);
      lastCheckIn.set(username, nowMs);
    }
  }

  // --- Disturbance response ---
  tickDisturbance(director, record, bot, me, nowMs, rng, seen);

  // --- Escort duty ---
  tickEscort(director, record, bot, me, nowMs, rng);

  // --- VIP citizen escorts (merchants, courtiers) ---
  tickVipEscort(director, record, bot, me, nowMs, rng, seen);
}

function tickDisturbance(director, record, bot, me, nowMs, rng, seen) {
  const username = record.username;
  const last = lastResponse.get(username) || 0;
  if (nowMs - last < RESPONSE_COOLDOWN_MS) return;
  if (!seen) return; // only respond where a real player can see it

  // 1. Notorious players nearby.
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || !isRealPlayer(p)) continue;
      const t = botTile(p);
      if (!t || chebyshev(me.x, me.y, t.x, t.y) > RESPONSE_RADIUS) continue;
      const pname = p.getUsername?.() ?? "?";
      if (notorietyOf(pname, nowMs) >= NOTORIETY_THRESHOLD) {
        const line = fillLine(pickOne(rng, DISTURBANCE_LINES), { name: pname });
        try {
          { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line.slice(0, 120)] })); }
        } catch { /* cosmetic */ }
        walkTo(director, bot, t);
        journal(director, username, "patrol", `Responded to disturbance: ${pname}.`, { target: pname });
        lastResponse.set(username, nowMs);
        return;
      }
    }
  } catch { /* scan must never break the tick */ }

  // 2. Recent journaled fights/arguments with a tile near the guard.
  try {
    const { getJournal } = require("./CitizenJournal");
    for (const other of director.roster?.values?.() ?? []) {
      if (other.username === username) continue;
      const events = getJournal().recent(other.username, 3);
      for (const e of events) {
        if (!DISTURBANCE_KINDS.has(e.kind)) continue;
        if (nowMs - e.at > DISTURBANCE_FRESH_MS) continue;
        const tile = e.data?.tile;
        if (!tile) continue;
        if (chebyshev(me.x, me.y, tile.x, tile.y) > RESPONSE_RADIUS) continue;
        const line = pickOne(rng, DISTURBANCE_QUERY_LINES);
        try {
          { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line.slice(0, 120)] })); }
        } catch { /* cosmetic */ }
        walkTo(director, bot, tile);
        journal(director, username, "patrol", `Responded to shouting near ${other.username}.`);
        lastResponse.set(username, nowMs);
        return;
      }
    }
  } catch { /* scan must never break the tick */ }
}

function tickEscort(director, record, bot, me, nowMs, rng) {
  const username = record.username;

  // Continue an active escort first.
  const escort = activeEscorts.get(username);
  if (escort) {
    const players = director.onlinePlayers?.() ?? [];
    const target = findPlayerByName(players, escort.target);
    const targetTile = target ? botTile(target) : null;
    if (escortShouldEnd(escort, targetTile, nowMs)) {
      activeEscorts.delete(username);
    } else {
      walkTo(director, bot, targetTile);
    }
    return; // escorting guards don't also offer
  }

  // Offer: a real player standing by the guard.
  const last = lastEscortOffer.get(username) || 0;
  if (nowMs - last < ESCORT_OFFER_COOLDOWN_MS) return;
  const near = realPlayersWithin(bot, ESCORT_OFFER_RADIUS);
  if (near.length === 0) return;
  if (rng() >= 0.5) return; // don't pester every pass

  const player = near[0];
  const pname = player.getUsername?.() ?? "?";
  const line = pickOne(rng, ESCORT_OFFER_LINES);
  try {
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line.slice(0, 120)] })); }
  } catch { /* cosmetic */ }
  journal(director, username, "patrol", `Offered ${pname} an escort.`);
  lastEscortOffer.set(username, nowMs);
  activeEscorts.set(username, {
    target: pname,
    startTile: { x: me.x, y: me.y, z: me.z },
    until: nowMs + ESCORT_FOLLOW_MAX_MS,
  });
}

function tickVipEscort(director, record, bot, me, nowMs, rng, seen) {
  if (!seen) return;
  if (activeEscorts.has(record.username)) return; // busy with a player
  const last = lastEscortOffer.get(`${record.username}:vip`) || 0;
  if (nowMs - last < ESCORT_OFFER_COOLDOWN_MS) return;
  if (rng() >= 0.1) return;

  // Find a nearby merchant/courtier citizen to walk with.
  for (const other of director.roster?.values?.() ?? []) {
    if (other.username === record.username) continue;
    if (other.role !== "merchant" && other.role !== "courtier") continue;
    const otherBot = director.playerFor?.(other);
    if (!otherBot) continue;
    const t = botTile(otherBot);
    if (!t || chebyshev(me.x, me.y, t.x, t.y) > 6) continue;
    const line = fillLine(pickOne(rng, VIP_ESCORT_LINES), { name: other.username });
    try {
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line.slice(0, 120)] })); }
    } catch { /* cosmetic */ }
    walkTo(director, bot, { x: t.x + 1, y: t.y, z: t.z });
    journal(director, record.username, "patrol", `Escorting ${other.username} a ways.`);
    lastEscortOffer.set(`${record.username}:vip`, nowMs);
    return;
  }
}

// ============================================================================
// Reassured citizens: the watch makes the streets feel safe.
// ============================================================================

function tickReassured(director, others, guards, nowMs, rng) {
  if (guards.length === 0) return;
  for (const { record, bot } of others) {
    const last = lastReassure.get(record.username) || 0;
    if (nowMs - last < REASSURE_COOLDOWN_MS) continue;
    if (rng() >= REASSURE_CHANCE) continue;
    const me = botTile(bot);
    if (!me) continue;
    // A guard nearby?
    let guardNear = false;
    for (const g of guards) {
      const gt = botTile(g.bot);
      if (gt && chebyshev(me.x, me.y, gt.x, gt.y) <= REASSURE_RADIUS) {
        guardNear = true;
        break;
      }
    }
    if (!guardNear) continue;
    // Only speak where a real player can hear.
    if (realPlayersWithin(bot, CHECKIN_RADIUS).length === 0) continue;
    const line = pickOne(rng, REASSURE_LINES);
    try {
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line.slice(0, 120)] })); }
    } catch { /* cosmetic */ }
    journal(director, record.username, "social", "Feels safer with the watch about.");
    lastReassure.set(record.username, nowMs);
  }
}

// ============================================================================
// Main tick — called from CitizenDirector.tickProximity() (~10s).
// Gate order: cooldown (cheapest) → materialized → real player near → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} [rng] - injected rng for tests (defaults to Math.random)
 */
function tickGuardPatrols(director, nowMs, rng) {
  pruneMaps(nowMs);
  const rand = rng ?? Math.random;
  try {
    const guards = [];
    const others = [];
    for (const record of director.roster?.values?.() ?? []) {
      const bot = director.playerFor?.(record);
      if (!bot) continue;
      if (record.role === "guard") guards.push({ record, bot });
      else others.push({ record, bot });
    }
    if (guards.length === 0 && others.length === 0) return;
    const night = isNightHour(new Date(nowMs).getHours());
    for (const { record, bot } of guards) {
      try {
        tickGuard(director, record, bot, nowMs, night, rand);
      } catch {
        // One bad guard never breaks the watch.
      }
    }
    try {
      tickReassured(director, others, guards, nowMs, rand);
    } catch {
      // Reassurance must never break the tick.
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-guard-patrols] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickGuardPatrols,
  // Export pure helpers for tests:
  pickOne,
  isRealPlayer,
  chebyshev,
  withinTiles,
  isNightHour,
  shouldFire,
  fillLine,
  notorietyOf,
  pickCheckInLine,
  escortShouldEnd,
  findPlayerByName,
  // Tuning (tests pin the documented behavior):
  CHECKIN_RADIUS,
  RESPONSE_RADIUS,
  NOTORIETY_THRESHOLD,
  ESCORT_OFFER_RADIUS,
  ESCORT_FOLLOW_MAX_TILES,
  REASSURE_RADIUS,
  // Line pools (non-empty checks):
  CHECKIN_DAY,
  CHECKIN_NIGHT,
  DISTURBANCE_LINES,
  DISTURBANCE_QUERY_LINES,
  ESCORT_OFFER_LINES,
  REASSURE_LINES,
  TORCH_LINES,
};
