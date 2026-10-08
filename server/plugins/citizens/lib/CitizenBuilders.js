"use strict";

/**
 * CitizenBuilders — construction crews who build and maintain the city.
 *
 * WHAT IT DOES (data tier, free — runs on the 60s slow tick):
 *   Eligible commoners are deterministically assigned builder trades
 *   (mason, carpenter, architect, laborer) — stable across restarts via
 *   name hash, capped per trade per kingdom. Each kingdom has one active
 *   construction project at a time (new building, repair, expansion,
 *   decoration) that progresses on the slow tick through phases
 *   (scaffolding -> structure -> finishing -> complete). Completions are
 *   journaled and the next project starts automatically. Completed projects
 *   are tracked per kingdom so the LLM can answer "what's new in town?"
 *   truthfully.
 *
 * WHAT THE PLAYER SEES (interaction tier, fast ~10s tick, only near real
 * players): builders gather visibly at the construction site — walk to
 * trade-specific spots, face the site, play trade animations, emote work
 * lines. The architect supervises (stands apart, faces builders, reviews
 * plans). Lingering players get hire offers ("Need something built?").
 * Players who stick around an active site are thanked for helping.
 * Project completions trigger visible celebrations.
 *
 * Hiring dialogue itself is handled by the LLM chat layer, which reads the
 * journal and builder state via getBuilderInfo() — this module only tracks
 * builder identity, project state, and hire offers. Zero LLM anywhere here.
 *
 * Deliberately NOT CitizenWorkLoops:
 *   - WorkLoops assigns any idle commoner near a station to a generic
 *     ~60s micro-loop and never moves them.
 *   - Builders are a stable identity (the town mason, not "a commoner"),
 *     work at the kingdom's ACTIVE construction site, advance real project
 *     state over days, and take hire offers from players.
 * Deliberately NOT CitizenArtisans:
 *   - Artisans craft goods and take commissions at their own workshops.
 *   - Builders work as a CREW on shared city projects that visibly change
 *     the town (new buildings, repairs, expansions, decorations).
 *
 * Wiring: slow tick tickBuilders() next to CitizenArtisans in the
 * director's 60s tick; fast tick tickBuilderLife() in tickProximity()
 * after the artisans layer. Per-citizen try/catch: one bad bot never
 * breaks the tick. Plain-node testable: CitizenBuilders.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { normalizeName } = require("./CitizenBonds");
const TimingDesync = require("./CitizenTimingDesync");
const { brainTickDue } = require("./CitizenTickLod");

// === Tuning: all magic numbers here ===
const PROXIMITY_TILES = 40; // a real player must be this close for visible work
const WORK_COOLDOWN_MS = 8 * 60 * 1000; // visible work at most this often
const WORK_CHANCE = 0.5; // per eligible builder per fast tick (staggers starts)
const OFFER_COOLDOWN_MS = 25 * 60 * 1000; // hire offers throttled
const OFFER_CHANCE = 0.3;
const DWELL_TICKS = 6; // ~60s of lingering at ~10s ticks -> hire offered
const DWELL_RADIUS = 10; // lingering this close counts as hire interest
const HELP_RADIUS = 12; // standing this close to the site = helping
const HELP_THANKS_COOLDOWN_MS = 30 * 60 * 1000;
const PROJECT_WORK_PER_TICK = 1; // work units per slow tick (~60s)
const CELEBRATION_COOLDOWN_MS = 60 * 60 * 1000; // completion cheers throttled

// Builder slots per kingdom — scarcity keeps them memorable.
const SLOTS_PER_TRADE = Object.freeze({
  architect: 1,
  mason: 2,
  carpenter: 2,
  laborer: 3,
});

// === Builder trades ===
const TRADES = Object.freeze({
  mason: Object.freeze({
    label: "mason",
    anim: 898, // hammering — stonework
    verb: "*lays stone courses*",
    journal: "Laid stone at the construction site.",
    offer: "Need stonework done? Walls, foundations — I build things that last.",
  }),
  carpenter: Object.freeze({
    label: "carpenter",
    anim: 1248, // whittling — timber work
    verb: "*frames timber joints*",
    journal: "Raised timber framing at the construction site.",
    offer: "Need timber work? Beams, roofs, scaffolding — that's my trade.",
  }),
  architect: Object.freeze({
    label: "architect",
    anim: 885, // crafting — measuring, planning
    verb: "*checks the plans*",
    journal: "Reviewed the building plans at the site.",
    offer: "Planning something grand? I design buildings worthy of this city.",
  }),
  laborer: Object.freeze({
    label: "laborer",
    anim: 0, // hauling — movement + emote, no engine anim fits
    verb: "*hauls stone and timber*",
    journal: "Hauled materials at the construction site.",
    offer: "Need an extra pair of hands? I haul, dig, and carry.",
  }),
});
const TRADE_KEYS = Object.freeze(Object.keys(TRADES));

// === Construction projects ===
const PROJECT_TYPES = Object.freeze({
  "new-building": Object.freeze({
    label: "new building",
    work: 120, // ~2h of slow ticks
    names: [
      "a new granary",
      "a new guard barracks",
      "a new market hall",
      "a new chapel",
      "a new bathhouse",
      "a new library",
    ],
  }),
  repair: Object.freeze({
    label: "repair",
    work: 60, // ~1h
    names: [
      "the east wall",
      "the old bridge",
      "the well",
      "the gatehouse",
      "the watchtower",
    ],
  }),
  expansion: Object.freeze({
    label: "expansion",
    work: 90, // ~1.5h
    names: [
      "the market square",
      "the harbor docks",
      "the residential quarter",
      "the craft district",
    ],
  }),
  decoration: Object.freeze({
    label: "decoration",
    work: 45, // ~45min
    names: [
      "a statue of the founder",
      "a fountain for the square",
      "carved banners for the gate",
      "a memorial garden",
    ],
  }),
});
const PROJECT_TYPE_KEYS = Object.freeze(Object.keys(PROJECT_TYPES));

const PROJECT_PHASES = Object.freeze([
  "scaffolding",
  "structure",
  "finishing",
  "complete",
]);

// Celebration lines when a project completes near players.
const CELEBRATION_LINES = Object.freeze([
  "*raises a cheer* It's done!",
  "Another one for the city! *wipes brow*",
  "*steps back to admire the work* Beautiful.",
  "We built that. All of us. *grins*",
]);

// === State ===
const builders = new Map(); // normalizedName -> { trade, kingdomId, display }
const projects = new Map(); // kingdomId -> { type, name, work, total, phase }
const completedProjects = new Map(); // kingdomId -> [{ name, type, completedAt }]
const lastWorkedAt = new Map(); // normalizedName -> timestamp
const lastOfferAt = new Map(); // normalizedName -> timestamp
const lastThanksAt = new Map(); // normalizedName -> timestamp (help thanks)
const lastCelebrationAt = new Map(); // kingdomId -> timestamp
const dwellTicks = new Map(); // normalizedName -> { player, ticks } (hire interest)

// Memory-leak plug.
let lastPruneAt = 0;
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastWorkedAt, lastOfferAt, lastThanksAt, lastCelebrationAt]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
  for (const [k, v] of dwellTicks) {
    if (nowMs - (v.since ?? 0) > 3600 * 1000) dwellTicks.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. Deterministic trade assignment. */
function hashName(name) {
  const s = String(name ?? "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The builder trade for a citizen name — stable across restarts. */
function tradeFor(name) {
  return TRADE_KEYS[hashName(name) % TRADE_KEYS.length];
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

/** Cheap Chebyshev distance on plain {x,y,z} tiles. */
function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  if ((a.z ?? 0) !== (b.z ?? 0)) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX?.() ?? loc.x, y: loc.getY?.() ?? loc.y, z: loc.getZ?.() ?? loc.z ?? 0 };
  } catch {
    return null;
  }
}

/** Phase of a project from work fraction: scaffolding -> structure -> finishing -> complete. */
function phaseFor(work, total) {
  if (work >= total) return "complete";
  const frac = total > 0 ? work / total : 0;
  if (frac < 0.25) return "scaffolding";
  if (frac < 0.7) return "structure";
  return "finishing";
}

/** Generate a project for a kingdom — deterministic per kingdom + cycle. */
function generateProject(rng, kingdomId) {
  const type = pickOne(rng, PROJECT_TYPE_KEYS);
  const def = PROJECT_TYPES[type];
  const name = pickOne(rng, def.names);
  return {
    type,
    name,
    work: 0,
    total: def.work,
    phase: "scaffolding",
    kingdomId,
    startedAt: Date.now(),
  };
}

/** The construction site tile for a kingdom — anchored to the square. */
function siteTile(kingdomId) {
  const base = siteTileByKingdom(kingdomId, "square");
  if (!base) return null;
  return { x: base.x + 6, y: base.y - 6, z: base.z ?? 0 };
}

/** Per-trade work spot near the site — crews spread out naturally. */
function tradeSpot(site, trade) {
  const offsets = {
    mason: [-2, 1],
    carpenter: [2, 1],
    architect: [0, -3],
    laborer: [1, 3],
  };
  const [dx, dy] = offsets[trade] ?? [0, 0];
  return { x: site.x + dx, y: site.y + dy, z: site.z ?? 0 };
}

function journalEvent(citizenName, text) {
  try {
    getJournal().log(citizenName, "work", text);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// Data tier — slow tick (~60s). Runs free, zero players needed.
// ============================================================================

/** Never poach citizens claimed by other systems. */
function systemBusy(record) {
  try {
    const sk = require("./CitizenSkilling");
    const name = normalizeName(record.username);
    const sessions = sk._sessions;
    if (sessions) {
      if (sessions.has(name)) return true;
      for (const s of sessions.values()) {
        if (
          (s.members ?? []).some((m) => normalizeName(m) === name) ||
          normalizeName(s.leader) === name
        ) {
          return true;
        }
      }
    }
  } catch {
    // Non-fatal.
  }
  try {
    const { getParty, getFollow } = require("./CitizenBonds");
    if (getParty(record.username) || getFollow(record.username)) return true;
  } catch {
    // Non-fatal.
  }
  return false;
}

function eligibleBuilder(record) {
  if (!record || record.role !== "commoner") return false;
  if (!normalizeName(record.username)) return false;
  if (systemBusy(record)) return false;
  return true;
}

/**
 * Rebuild the builder roster: capped builders per trade per kingdom,
 * chosen deterministically (sorted by username) so the town mason is
 * always the same person. Data tier — no player needs to be near.
 */
function rebuildBuilders(director) {
  builders.clear();
  if (!director?.roster) return;
  const bySlot = new Map(); // "kingdomId:trade" -> count
  const eligible = [];
  for (const record of director.roster.values()) {
    if (!eligibleBuilder(record)) continue;
    eligible.push(record);
  }
  eligible.sort((a, b) =>
    normalizeName(a.username) < normalizeName(b.username) ? -1 : 1
  );
  for (const record of eligible) {
    const name = normalizeName(record.username);
    const trade = tradeFor(record.username);
    const kingdomId = record.kingdomId ?? "unknown";
    const slot = `${kingdomId}:${trade}`;
    const taken = bySlot.get(slot) ?? 0;
    if (taken >= (SLOTS_PER_TRADE[trade] ?? 1)) continue;
    bySlot.set(slot, taken + 1);
    builders.set(name, { trade, kingdomId, display: record.username });
  }
}

/** Advance construction projects — one per kingdom, phases from work. */
function advanceProjects(director, nowMs) {
  try {
    const rng = agentRng(`builders:projects:${Math.floor(nowMs / 3600000)}`);
    const kingdomIds = new Set();
    for (const b of builders.values()) kingdomIds.add(b.kingdomId);
    for (const kingdomId of kingdomIds) {
      let proj = projects.get(kingdomId);
      if (!proj) {
        proj = generateProject(rng, kingdomId);
        projects.set(kingdomId, proj);
      }
      const before = proj.phase;
      proj.work += PROJECT_WORK_PER_TICK;
      proj.phase = phaseFor(proj.work, proj.total);
      if (before !== proj.phase && proj.phase === "complete") {
        completeProject(kingdomId, proj, nowMs);
        projects.set(kingdomId, generateProject(rng, kingdomId));
      }
    }
  } catch (e) {
    console.warn("[citizen-builders] advanceProjects failed:", e?.message ?? e);
  }
}

function completeProject(kingdomId, proj, nowMs) {
  const list = completedProjects.get(kingdomId) ?? [];
  list.push({ name: proj.name, type: proj.type, completedAt: nowMs });
  completedProjects.set(kingdomId, list.slice(-20)); // keep last 20
  // Journal the crew — the LLM reads this to describe what was built.
  for (const [name, b] of builders) {
    if (b.kingdomId !== kingdomId) continue;
    journalEvent(
      b.display,
      `Finished ${proj.name} (${proj.type}) — the city grows.`
    );
  }
}

/**
 * Slow tick entry — rebuild roster + advance projects.
 * Called from the director's 60s tick.
 */
function tickBuilders(director, nowMs = Date.now()) {
  pruneState(nowMs);
  try {
    rebuildBuilders(director);
    advanceProjects(director, nowMs);
  } catch (e) {
    console.warn("[citizen-builders] tickBuilders failed:", e?.message ?? e);
  }
}

// ============================================================================
// Interaction tier — fast tick (~10s). Only near real players.
// ============================================================================

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

function faceToward(bot, targetTile) {
  try {
    if (!targetTile) return false;
    bot.face?.(targetTile.x, targetTile.y);
    return true;
  } catch {
    return false;
  }
}

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

function isMoving(bot) {
  try {
    if (bot.getForceMovement?.() != null) return true;
    return (bot.getMovementQueue?.()?.size?.() ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me) return out;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || p?.isPlayerBot?.() === true) continue;
      if (chebyshev(me, botTile(p)) <= tiles) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/** Visible construction work: walk to the trade spot, face the site, work. */
function doVisibleWork(director, name, info, bot, nowMs) {
  try {
    const site = siteTile(info.kingdomId);
    if (!site) return;
    const spot = tradeSpot(site, info.trade);
    const trade = TRADES[info.trade];
    if (!trade) return;

    // Walk to the spot if not there yet.
    const me = botTile(bot);
    if (me && chebyshev(me, spot) > 2 && !isMoving(bot)) {
      walkTo(director, bot, spot);
      return; // moving — work next tick
    }
    faceToward(bot, site);
    playAnim(director, bot, trade.anim);
    if (chance(Math.random, 0.4)) {
      bot.forceChat?.(trade.verb.slice(0, 120));
    }
    journalEvent(info.display, trade.journal);
    lastWorkedAt.set(name, nowMs);
  } catch (e) {
    console.warn("[citizen-builders] doVisibleWork failed:", e?.message ?? e);
  }
}

/** Architect supervision: stands apart, reviews the crew. */
function doSupervise(director, name, info, bot, nowMs) {
  try {
    const site = siteTile(info.kingdomId);
    if (!site) return;
    const spot = tradeSpot(site, "architect");
    const me = botTile(bot);
    if (me && chebyshev(me, spot) > 2 && !isMoving(bot)) {
      walkTo(director, bot, spot);
      return;
    }
    // Face the busiest part of the site.
    faceToward(bot, site);
    playAnim(director, bot, TRADES.architect.anim);
    if (chance(Math.random, 0.3)) {
      const lines = ["*checks the plans*", "*marks a correction*", "*nods approvingly*"];
      bot.forceChat?.(lines[Math.floor(Math.random() * lines.length)]);
    }
    journalEvent(info.display, TRADES.architect.journal);
    lastWorkedAt.set(name, nowMs);
  } catch (e) {
    console.warn("[citizen-builders] doSupervise failed:", e?.message ?? e);
  }
}

/** Offer construction services to a lingering player. */
function maybeOfferHire(director, name, info, bot, nowMs) {
  try {
    const last = lastOfferAt.get(name) ?? 0;
    if (nowMs - last < OFFER_COOLDOWN_MS) return;
    const nearby = realPlayersWithin(bot, DWELL_RADIUS);
    if (nearby.length === 0) {
      dwellTicks.delete(name);
      return;
    }
    const player = nearby[0];
    const key = `${name}:${player.getUsername?.() ?? "?"}`;
    const dwell = dwellTicks.get(key) ?? { ticks: 0, since: nowMs };
    dwell.ticks += 1;
    dwell.since = dwell.since ?? nowMs;
    dwellTicks.set(key, dwell);
    if (dwell.ticks < DWELL_TICKS) return;
    if (!chance(Math.random, OFFER_CHANCE)) return;
    const trade = TRADES[info.trade];
    bot.forceChat?.(trade.offer.slice(0, 120));
    journalEvent(info.display, `Offered ${info.trade} work to a passerby.`);
    lastOfferAt.set(name, nowMs);
    dwellTicks.delete(key);
  } catch (e) {
    console.warn("[citizen-builders] maybeOfferHire failed:", e?.message ?? e);
  }
}

/** Thank players who stick around an active site (helping). */
function maybeThankHelpers(director, name, info, bot, nowMs) {
  try {
    const last = lastThanksAt.get(name) ?? 0;
    if (nowMs - last < HELP_THANKS_COOLDOWN_MS) return;
    const helpers = realPlayersWithin(bot, HELP_RADIUS);
    if (helpers.length === 0) return;
    const thanks = [
      "Thanks for the help, friend!",
      "Many hands make light work — appreciate it!",
      "*grins* You work like one of the crew.",
    ];
    bot.forceChat?.(thanks[Math.floor(Math.random() * thanks.length)]);
    const helper = helpers[0].getUsername?.() ?? "a passerby";
    journalEvent(info.display, `${helper} helped with the construction.`);
    lastThanksAt.set(name, nowMs);
  } catch (e) {
    console.warn("[citizen-builders] maybeThankHelpers failed:", e?.message ?? e);
  }
}

/** Celebrate a just-completed project near players. */
function maybeCelebrate(director, info, bot, nowMs) {
  try {
    const last = lastCelebrationAt.get(info.kingdomId) ?? 0;
    if (nowMs - last < CELEBRATION_COOLDOWN_MS) return;
    // Only celebrate if a project completed very recently.
    const list = completedProjects.get(info.kingdomId) ?? [];
    const latest = list[list.length - 1];
    if (!latest || nowMs - latest.completedAt > 10 * 60 * 1000) return;
    const nearby = realPlayersWithin(bot, PROXIMITY_TILES);
    if (nearby.length === 0) return;
    bot.forceChat?.(
      pickOne(Math.random, CELEBRATION_LINES).slice(0, 120)
    );
    lastCelebrationAt.set(info.kingdomId, nowMs);
  } catch (e) {
    console.warn("[citizen-builders] maybeCelebrate failed:", e?.message ?? e);
  }
}

/**
 * Fast tick entry — visible construction life.
 * Called from CitizenDirector.tickProximity() after the artisans layer.
 * Gate order: cooldown -> materialized -> real player near -> work.
 */
function tickBuilderLife(director, nowMs = Date.now(), desync) {
  pruneState(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      const name = normalizeName(record.username);
      const info = builders.get(name);
      if (!info) continue;
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastWorkedAt.get(name) ?? 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible builder life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (!brainTickDue(director, record, desync?.tick)) {
          continue;
        }

        // 3. Desync gate — stagger the visible-life wave
        if (
          desync &&
          !TimingDesync.isCitizenDue({ username: name }, desync.tick, desync.spread)
        ) {
          continue;
        }

        // 4. Citizen must be materialized (near a player already)
        const bot = director.getBot?.(record);
        if (!bot) continue;

        // 5. A real player must be close enough to see the work
        if (realPlayersWithin(bot, PROXIMITY_TILES).length === 0) continue;

        // 6. Chance gate + do the thing (scripted, zero LLM)
        if (!chance(Math.random, WORK_CHANCE)) continue;
        if (info.trade === "architect") {
          doSupervise(director, name, info, bot, nowMs);
        } else {
          doVisibleWork(director, name, info, bot, nowMs);
        }
        maybeOfferHire(director, name, info, bot, nowMs);
        maybeThankHelpers(director, name, info, bot, nowMs);
        maybeCelebrate(director, info, bot, nowMs);
      } catch (e) {
        console.warn("[citizen-builders] citizen failed:", name, e?.message ?? e);
      }
    }
  } catch (e) {
    console.warn("[citizen-builders] tickBuilderLife failed:", e?.message ?? e);
  }
}

/**
 * Builder state for the LLM chat layer — what this builder does,
 * what project their kingdom is working on, what's been completed.
 * Zero LLM here; the chat layer reads this.
 */
function getBuilderInfo(username) {
  const name = normalizeName(username);
  const info = builders.get(name);
  if (!info) return null;
  const proj = projects.get(info.kingdomId);
  const done = completedProjects.get(info.kingdomId) ?? [];
  return {
    trade: info.trade,
    kingdomId: info.kingdomId,
    activeProject: proj
      ? { name: proj.name, type: proj.type, phase: proj.phase }
      : null,
    recentCompletions: done.slice(-3).map((d) => d.name),
  };
}

module.exports = {
  tickBuilders,
  tickBuilderLife,
  getBuilderInfo,
  // Export pure helpers for tests:
  hashName,
  tradeFor,
  pickOne,
  isRealPlayer,
  chebyshev,
  phaseFor,
  generateProject,
  siteTile,
  tradeSpot,
  eligibleBuilder,
  rebuildBuilders,
  advanceProjects,
  SLOTS_PER_TRADE,
  TRADES,
  PROJECT_TYPES,
  PROJECT_PHASES,
};
