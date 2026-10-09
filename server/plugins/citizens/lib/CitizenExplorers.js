"use strict";

/**
 * CitizenExplorers — adventurers who venture beyond the walls and return
 * with discoveries, treasures, and tales.
 *
 * Citizens hash into four explorer vocations (scout, treasure hunter,
 * naturalist, pathfinder). Expeditions form on a slow cadence per kingdom:
 * a leader musters a party at home, they journey into the wilderness
 * (abstracted, data-tier), and return with discoveries — new locations,
 * hidden treasures, rare creatures, ancient routes. Dangers (bandits,
 * storms, getting lost) can cut a journey short. Everything is journaled,
 * so the LLM mouth can riff truthfully later ("saw you return from the
 * misty valley").
 *
 * Two-tier by construction: the expedition simulation is the free
 * background tier (state machine, rng rolls, journal lines). The visible
 * part — muster shouts, departure calls, tavern tales — fires only when
 * a real player is near, as scripted forceChat. Zero LLM.
 *
 * Player hooks: players can join a mustering expedition (CitizenBonds
 * invite kind "expedition_join") or hire a pathfinder as a guide
 * ("expedition_guide") via hireExplorerGuide(). Player joins do not
 * change the simulation — the party abstract-travels the same way —
 * but the player's name is journaled with the expedition.
 *
 * Wired into the director tick right after the trade caravans block.
 * Plain-node testable: CitizenExplorers.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { normalizeName, sendInvite, getInvites } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const EXPLORER_BUCKET = 20; // hash(username) % 20 === 0 -> explorer (~5% of citizens)
const MUSTER_MS = 45 * 60 * 1000; // leader recruits at home for this long
const JOURNEY_BASE_MS = 4 * 60 * 60 * 1000; // abstracted wilderness travel ("days")
const JOURNEY_JITTER_MS = 2 * 60 * 60 * 1000;
const EXPEDITION_CADENCE_MS = 12 * 60 * 60 * 1000; // a new expedition forms per kingdom this often
const PARTY_MIN = 2; // leader + at least one companion
const PARTY_MAX = 4;
const SHOUT_RADIUS = 12; // tiles — earshot of the muster call
const SHOUT_COOLDOWN_MS = 20 * 60 * 1000; // per expedition per phase
const TALE_RADIUS = 14; // tiles — close enough to hear the tale
const TALE_CITIZEN_COOLDOWN_MS = 2 * 60 * 60 * 1000; // a tale is told at most this often
const TALE_FRESH_MS = 48 * 60 * 60 * 1000; // discoveries older than this are stale news
const INVITE_KIND_JOIN = "expedition_join";
const INVITE_KIND_GUIDE = "expedition_guide";
const MAX_PLAYER_MEMBERS = 2;

const EXPLORER_TYPES = Object.freeze(["scout", "treasure_hunter", "naturalist", "pathfinder"]);

// === Discovery pools: what each vocation can find ===
const DISCOVERIES = Object.freeze({
  scout: Object.freeze([
    "a hidden grove",
    "an uncharted mountain pass",
    "an ancient ford",
    "a forgotten watchtower",
    "a misty valley",
    "a crater lake",
  ]),
  treasure_hunter: Object.freeze([
    "a buried war-cache",
    "a sunken vault",
    "a lost tomb",
    "a dragon hoard remnant",
    "a smuggler's stash",
    "a sealed crypt",
  ]),
  naturalist: Object.freeze([
    "an albino basilisk",
    "a crystal-winged hawk",
    "an ember fox den",
    "a moonlit stag herd",
    "a singing cave-cricket colony",
    "a frostbloom meadow",
  ]),
  pathfinder: Object.freeze([
    "a secret shortcut",
    "a safe mountain pass",
    "a hidden river crossing",
    "a smuggler's trail",
    "a game trail through the wilds",
    "an old pilgrim road",
  ]),
});

const DANGERS = Object.freeze([
  "bandits ambushed the party",
  "a storm pinned the party down",
  "the party got lost for a day",
  "a rockslide blocked the trail",
  "a wounded member slowed the party",
]);

const MUSTER_LINES = Object.freeze([
  "Beyond the walls lies country no one has mapped — who's coming with me?",
  "I'm putting together an expedition. Real treasure, real danger. Any takers?",
  "The wilds are calling. I need brave souls for a journey.",
  "Heading out past the frontier soon — join me and see what no one has seen.",
]);

const DEPART_LINES = Object.freeze([
  "We're off! If we don't return, tell the tavern our story.",
  "The expedition leaves now — wish us luck!",
  "Into the wilds! We'll bring back wonders.",
]);

const RETURN_LINES = Object.freeze([
  "We're back! And you won't believe what we found.",
  "The expedition returns — gather round, this one's worth hearing.",
  "Back alive, and richer for it. Let me tell you everything.",
]);

const TALE_FRAMES = Object.freeze([
  "I swear on my boots, we found {discovery} out there.",
  "You should have seen it — {discovery}, untouched by anyone.",
  "They'll sing about this one: {discovery}. I was there.",
  "{discovery} — I saw it with my own eyes, friend.",
]);

// === Expedition state (in-memory; abstracts wilderness travel) ===
let nextExpeditionId = 1;
const expeditions = []; // { id, leader, members[], playerMembers[], type, phase, musterEndsAt, returnsAt, discoveries[], dangers[], kingdomId }
const awayUntil = new Map(); // username -> timestamp (out on expedition)
const lastExpeditionByKingdom = new Map(); // kingdomId -> timestamp
const lastShoutAt = new Map(); // expeditionId -> timestamp
const lastTaleByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune stale entries hourly.
let lastPruneAt = 0;
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of awayUntil) if (at < cutoff) awayUntil.delete(k);
  for (const [k, at] of lastExpeditionByKingdom) if (at < cutoff) lastExpeditionByKingdom.delete(k);
  for (const [k, at] of lastShoutAt) if (at < cutoff) lastShoutAt.delete(k);
  for (const [k, at] of lastTaleByCitizen) if (at < cutoff) lastTaleByCitizen.delete(k);
  // Drop finished expeditions older than a day.
  for (let i = expeditions.length - 1; i >= 0; i--) {
    if (expeditions[i].phase === "done" && nowMs - (expeditions[i].finishedAt ?? 0) > 24 * 3600 * 1000) {
      expeditions.splice(i, 1);
    }
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

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

/** Stable FNV-1a hash — explorer assignment is deterministic per username. */
function hashName(name) {
  let h = 2166136261;
  const s = String(name ?? "").toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** ~1 in EXPLORER_BUCKET citizens is an explorer. */
function isExplorer(username) {
  return hashName(username) % EXPLORER_BUCKET === 0;
}

/** Which kind of explorer: derived from the same hash, stable. */
function explorerTypeFor(username) {
  return EXPLORER_TYPES[hashName(username) % EXPLORER_TYPES.length];
}

/** True while the citizen is out in the wilderness on an expedition. */
function isAway(username, nowMs) {
  return (awayUntil.get(normalizeName(username)) ?? 0) > (nowMs ?? Date.now());
}

/**
 * Pick a discovery for the vocation. Pure.
 * @returns {{type: string, name: string}}
 */
function rollDiscovery(type, rng) {
  const pool = DISCOVERIES[type] ?? DISCOVERIES.scout;
  return { type, name: pickOne(rng, pool) };
}

/**
 * Resolve a journey: how many discoveries and dangers.
 * Pure: (rng) => { discoveryCount, dangerCount }.
 */
function journeyOutcome(rng) {
  const discoveryCount = rng() < 0.25 ? 2 : 1;
  const dangerCount = rng() < 0.4 ? 1 : 0;
  return { discoveryCount, dangerCount };
}

/**
 * Form an expedition party from eligible explorer candidates.
 * Pure: ({ leader, candidates, nowMs }) => expedition|null.
 * Leader is always the party head; companions are sampled up to PARTY_MAX.
 */
function formExpedition({ leader, candidates, nowMs }) {
  const pool = (candidates ?? []).filter(
    (c) => c && c !== leader && !isAway(c, nowMs)
  );
  const minCompanions = PARTY_MIN - 1;
  const maxCompanions = PARTY_MAX - 1;
  if (pool.length < minCompanions) return null;
  const members = [leader, ...pool.slice(0, maxCompanions)];
  const journeyMs = JOURNEY_BASE_MS + Math.floor(Math.random() * JOURNEY_JITTER_MS);
  return {
    id: nextExpeditionId++,
    leader,
    members,
    playerMembers: [],
    type: explorerTypeFor(leader),
    phase: "muster",
    musterEndsAt: nowMs + MUSTER_MS,
    returnsAt: nowMs + MUSTER_MS + journeyMs,
    discoveries: [],
    dangers: [],
    finishedAt: 0,
  };
}

function musterLine(rng) {
  return pickOne(rng, MUSTER_LINES);
}
function departLine(rng) {
  return pickOne(rng, DEPART_LINES);
}
function returnLine(rng) {
  return pickOne(rng, RETURN_LINES);
}

/** Scripted tale line naming the discovery. Pure. */
function taleLine(type, discoveryName, rng) {
  return pickOne(rng, TALE_FRAMES).replace("{discovery}", discoveryName);
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "exploration", text);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// Player hooks — join an expedition or hire a guide.
// ============================================================================

/**
 * A real player hires a pathfinder as a guide. Creates an invite the
 * player's client can accept; both sides journal the arrangement.
 * @returns {boolean} whether the hire was offered
 */
function hireExplorerGuide(playerName, explorerName, nowMs) {
  if (!playerName || !explorerName) return false;
  if (!isExplorer(explorerName)) return false;
  if (explorerTypeFor(explorerName) !== "pathfinder") return false;
  if (isAway(explorerName, nowMs ?? Date.now())) return false;
  try {
    const existing = getInvites(playerName).some(
      (i) => i.kind === INVITE_KIND_GUIDE && i.data?.explorer === normalizeName(explorerName)
    );
    if (existing) return false;
    sendInvite(explorerName, playerName, INVITE_KIND_GUIDE, {
      explorer: normalizeName(explorerName),
    });
    journalEvent(
      explorerName,
      `Hired as a guide by ${playerName}.`,
      "exploration"
    );
    journalEvent(playerName, `Hired ${explorerName} as a wilderness guide.`, "exploration");
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: state changes (cheap) → visible output (only near real players).
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickExplorers(director, nowMs) {
  pruneState(nowMs);
  try {
    const roster = [...(director.roster?.values?.() ?? [])];
    if (roster.length === 0) return;

    // 1. Advance existing expeditions (pure state machine).
    advanceExpeditions(director, roster, nowMs);

    // 2. Form new expeditions on cadence, per kingdom.
    formNewExpeditions(director, roster, nowMs);

    // 3. Visible output: muster shouts, departures, tavern tales — only
    //    when a real player is within earshot.
    visibleMoments(director, nowMs);
  } catch (e) {
    console.warn("[citizen-explorers] tick failed:", e?.message ?? e);
  }
}

function advanceExpeditions(director, roster, nowMs) {
  for (const exp of expeditions) {
    if (exp.phase === "muster" && nowMs >= exp.musterEndsAt) {
      exp.phase = "journey";
      const rng = agentRng(`expedition:${exp.id}:depart`);
      journalEvent(exp.leader, `Led an expedition into the wilderness (${exp.type}).`, "exploration");
      for (const m of exp.members) {
        if (m !== exp.leader) journalEvent(m, `Joined ${exp.leader}'s expedition (${exp.type}).`, "exploration");
        awayUntil.set(normalizeName(m), exp.returnsAt);
      }
      for (const p of exp.playerMembers) journalEvent(p, `Joined ${exp.leader}'s expedition into the wilderness.`, "exploration");
      shoutExpedition(director, exp, departLine(rng), nowMs);
    } else if (exp.phase === "journey" && nowMs >= exp.returnsAt) {
      resolveJourney(exp, nowMs);
    }
  }
}

function resolveJourney(exp, nowMs) {
  const rng = agentRng(`expedition:${exp.id}:return:${nowMs >> 16}`);
  const { discoveryCount: baseCount, dangerCount } = journeyOutcome(rng);
  // Sponsored expeditions (CitizenExplorers2 funding) return richer.
  const discoveryCount = baseCount + expeditionFundingBonus(exp.id);
  for (let i = 0; i < discoveryCount; i++) {
    const type = i === 0 ? exp.type : pickOne(rng, EXPLORER_TYPES);
    const d = rollDiscovery(type, rng);
    d.legend = false;
    exp.discoveries.push(d);
  }
  for (let i = 0; i < dangerCount; i++) {
    exp.dangers.push(pickOne(rng, DANGERS));
  }
  exp.phase = "done";
  exp.finishedAt = nowMs;

  const discoveryText = exp.discoveries.map((d) => d.name).join(", ");
  journalEvent(
    exp.leader,
    `Returned from expedition: discovered ${discoveryText}.`,
    "exploration"
  );
  for (const m of exp.members) {
    if (m !== exp.leader) journalEvent(m, `Returned from ${exp.leader}'s expedition (${discoveryText}).`, "exploration");
    awayUntil.delete(normalizeName(m));
  }
  for (const d of exp.dangers) {
    journalEvent(exp.leader, `On expedition: ${d}.`, "exploration");
  }
  for (const p of exp.playerMembers) {
    journalEvent(p, `Returned from ${exp.leader}'s expedition (${discoveryText}).`, "exploration");
  }
}

function formNewExpeditions(director, roster, nowMs) {
  const byKingdom = new Map();
  for (const record of roster) {
    const k = record.kingdomId ?? "unknown";
    if (!byKingdom.has(k)) byKingdom.set(k, []);
    byKingdom.get(k).push(record);
  }
  for (const [kingdomId, members] of byKingdom) {
    const last = lastExpeditionByKingdom.get(kingdomId) ?? 0;
    if (nowMs - last < EXPEDITION_CADENCE_MS) continue;
    // No expedition from this kingdom already mustering.
    if (expeditions.some((e) => e.kingdomId === kingdomId && e.phase !== "done")) continue;

    const explorers = members
      .filter((r) => r && r.username && isExplorer(r.username) && !isAway(r.username, nowMs))
      .map((r) => r.username);
    if (explorers.length < PARTY_MIN) continue;
    const rng = agentRng(`expedition:muster:${kingdomId}:${nowMs >> 16}`);
    const leader = pickOne(rng, explorers);
    const exp = formExpedition({ leader, candidates: explorers, nowMs });
    if (!exp) continue;
    exp.kingdomId = kingdomId;
    expeditions.push(exp);
    lastExpeditionByKingdom.set(kingdomId, nowMs);
    journalEvent(leader, `Mustering an expedition (${exp.type}).`, "exploration");
    shoutExpedition(director, exp, musterLine(rng), nowMs);
  }
}

function visibleMoments(director, nowMs) {
  for (const exp of expeditions) {
    if (exp.phase !== "muster") continue;
    if (nowMs - (lastShoutAt.get(exp.id) ?? 0) < SHOUT_COOLDOWN_MS) continue;
    const rng = agentRng(`expedition:shout:${exp.id}:${nowMs >> 16}`);
    if (!chance(rng, 0.4)) continue;
    shoutExpedition(director, exp, musterLine(rng), nowMs);
  }
  // Tavern tales: returned explorers share their newest discovery.
  for (const record of director.roster?.values?.() ?? []) {
    if (!record?.username || !isExplorer(record.username)) continue;
    const last = lastTaleByCitizen.get(normalizeName(record.username)) ?? 0;
    if (nowMs - last < TALE_CITIZEN_COOLDOWN_MS) continue;
    const fresh = recentDiscovery(record.username, nowMs);
    if (!fresh) continue;
    const bot = director.getBot?.(record);
    if (!bot) continue;
    let locals = [];
    try {
      locals = [...(bot.getLocalPlayers?.() ?? [])];
    } catch {
      continue;
    }
    if (!locals.some((p) => p !== bot && isRealPlayer(p) && withinTiles(bot, p, TALE_RADIUS))) continue;
    const rng = agentRng(`expedition:tale:${record.username}:${nowMs >> 16}`);
    const line = taleLine(fresh.type, fresh.name, rng).slice(0, 120);
    try {
      { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    } catch {
      continue;
    }
    lastTaleByCitizen.set(normalizeName(record.username), nowMs);
    journalEvent(record.username, `Told the tale of ${fresh.name} at the tavern.`, "social");
    markLegend(record.username, fresh, nowMs);
  }
}

/** Newest still-fresh discovery from this explorer's last expedition. */
function recentDiscovery(username, nowMs) {
  for (let i = expeditions.length - 1; i >= 0; i--) {
    const exp = expeditions[i];
    if (exp.phase !== "done") continue;
    if (!exp.members.includes(username)) continue;
    if (nowMs - (exp.finishedAt ?? 0) > TALE_FRESH_MS) continue;
    return exp.discoveries[0] ?? null;
  }
  return null;
}

/** Once a player hears the tale, the discovery becomes a legend. */
function markLegend(username, discovery, nowMs) {
  if (!discovery || discovery.legend) return;
  discovery.legend = true;
  discovery.legendAt = nowMs;
  journalEvent(username, `${discovery.name} is becoming legend.`, "exploration");
}

/**
 * Shout an expedition line if a real player is within earshot of the
 * leader's live bot. Data-tier invites go to nearby players regardless.
 */
function shoutExpedition(director, exp, line, nowMs) {
  lastShoutAt.set(exp.id, nowMs);
  try {
    const record = findRecord(director, exp.leader);
    const bot = record ? director.getBot?.(record) : null;
    if (!bot) return;
    const locals = [...(bot.getLocalPlayers?.() ?? [])];
    const realPlayers = locals.filter(
      (p) => p !== bot && isRealPlayer(p) && withinTiles(bot, p, SHOUT_RADIUS)
    );
    if (realPlayers.length === 0) return;
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [String(line).slice(0, 120)] })); }
    // Invite nearby players to join the muster.
    if (exp.phase === "muster" && exp.playerMembers.length < MAX_PLAYER_MEMBERS) {
      for (const p of realPlayers) {
        const name = p.getUsername?.();
        if (!name) continue;
        if (exp.playerMembers.includes(name)) continue;
        const existing = getInvites(name).some(
          (i) => i.kind === INVITE_KIND_JOIN && i.data?.expeditionId === exp.id
        );
        if (existing) continue;
        sendInvite(exp.leader, name, INVITE_KIND_JOIN, { expeditionId: exp.id });
        if (exp.playerMembers.length + countPendingJoins(exp) >= MAX_PLAYER_MEMBERS) break;
      }
    }
  } catch {
    // A shy leader.
  }
}

function countPendingJoins() {
  return 0; // invites resolve async via the invite system; slots counted on accept
}

function findRecord(director, username) {
  try {
    for (const record of director.roster?.values?.() ?? []) {
      if (record?.username === username) return record;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Finished expeditions with their discoveries (newest last).
 * The frontier layer (CitizenExplorers2) reads these to found settlements,
 * sketch amateur maps and write naturalist field notes. Returns shallow
 * copies — mutate the copies, not the simulation.
 */
function finishedExpeditions(nowMs, maxAgeMs = 24 * 3600 * 1000) {
  const at = nowMs ?? Date.now();
  const age = maxAgeMs ?? 24 * 3600 * 1000;
  return expeditions
    .filter((e) => e.phase === "done" && at - (e.finishedAt ?? 0) <= age)
    .map((e) => ({
      id: e.id,
      leader: e.leader,
      members: [...e.members],
      type: e.type,
      kingdomId: e.kingdomId,
      finishedAt: e.finishedAt,
      discoveries: e.discoveries.map((d) => ({ ...d })),
      dangers: [...e.dangers],
    }));
}

/** Expeditions currently mustering — players may fund or join these. */
function musteringExpeditions() {
  return expeditions
    .filter((e) => e.phase === "muster")
    .map((e) => ({
      id: e.id,
      leader: e.leader,
      members: [...e.members],
      type: e.type,
      kingdomId: e.kingdomId,
      musterEndsAt: e.musterEndsAt,
    }));
}

/**
 * One-time funding bonus for a sponsored expedition, consumed on read.
 * Lazy require: CitizenExplorers2 requires this module at load time, so a
 * top-level require here would cycle.
 */
function expeditionFundingBonus(expeditionId) {
  try {
    const e2 = require("./CitizenExplorers2");
    return e2.fundingBonusFor?.(expeditionId) ?? 0;
  } catch {
    return 0;
  }
}

/** One-line status for debugging (mirrors toastStatus). */
function explorersStatus() {
  const out = [];
  for (const e of expeditions) {
    out.push(`${e.id}:${e.phase} leader=${e.leader} members=${e.members.length} discoveries=${e.discoveries.length}`);
  }
  return out;
}

/** Test seam: reset all module state. */
function resetForTests() {
  expeditions.length = 0;
  awayUntil.clear();
  lastExpeditionByKingdom.clear();
  lastShoutAt.clear();
  lastTaleByCitizen.clear();
  nextExpeditionId = 1;
}

module.exports = {
  tickExplorers,
  // Pure helpers (tested):
  pickOne,
  isRealPlayer,
  withinTiles,
  hashName,
  isExplorer,
  explorerTypeFor,
  isAway,
  rollDiscovery,
  journeyOutcome,
  formExpedition,
  musterLine,
  departLine,
  returnLine,
  taleLine,
  hireExplorerGuide,
  // Introspection:
  explorersStatus,
  finishedExpeditions,
  musteringExpeditions,
  resetForTests,
  INVITE_KIND_JOIN,
  INVITE_KIND_GUIDE,
  EXPLORER_TYPES,
  DISCOVERIES,
};
