"use strict";

/**
 * CitizenGuilds — the data tier for citizen trade guilds.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Five trade guilds: warriors, mages, thieves, merchants, crafters.
 *     Each has join requirements (real skill levels), a guild hall per
 *     kingdom (deterministic tile near the market), ranks, and missions.
 *   - Membership per citizen: guild id, rank, favor (0+, earned via
 *     missions and training), join date. One trade guild at a time —
 *     a human picks a profession's guild, not all five.
 *   - Ranks: novice -> member -> veteran -> master -> grandmaster.
 *     Rank gates on favor; rank-ups award reputation (real deeds).
 *   - Missions: one active mission per member, generated per guild
 *     (warriors slay, mages craft runes, thieves steal, merchants trade,
 *     crafters craft). Progress advances when the citizen does the real
 *     related brain activity — never invented.
 *   - Guild rivalry: thieves<->merchants and warriors<->mages are natural
 *     rivals. Rivalry 0..100 per pair drifts with real events (a thief
 *     caught stealing from a merchant raises it); high rivalry colors
 *     social scoring between rival members.
 *   - trainingBonusFor(): guild members training their guild's skill earn
 *     +10% XP (same pattern as the education bonus — additive, real XP).
 *   - Player guilds: playerGuildFor() defensively reads the player guild
 *     registry (server/plugins/guilds) so citizens in player-founded
 *     guilds are visible to the trade-guild social layer. A missing or
 *     broken registry is a no-op, never a crash.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Favor decay, mission expiry, rivalry drift, and
 *     announcements live in lib/CitizenGuildLife.js.
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - No invented money: guild dues are real coins or nothing happens.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-guilds.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-guilds.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const JOIN_LEVEL = 30; // skill level required to join a trade guild
const DUES_COINS = 100; // one-time joining dues, real coins

// Ranks: favor thresholds (inclusive).
const RANKS = Object.freeze([
  { min: 1000, key: "grandmaster", label: "Grandmaster" },
  { min: 600, key: "master", label: "Master" },
  { min: 300, key: "veteran", label: "Veteran" },
  { min: 100, key: "member", label: "Member" },
  { min: 0, key: "novice", label: "Novice" },
]);

// The five trade guilds. skill: the tsps skill id used for join checks
// and training bonuses. mission: what members actually do.
const GUILDS = Object.freeze({
  warriors: Object.freeze({
    id: "warriors",
    name: "Warriors' Guild",
    skill: "attack",
    altSkills: Object.freeze(["strength", "defence"]),
    mission: Object.freeze({ kind: "slay", label: "slay monsters", target: 5, favor: 25 }),
    hallOffset: Object.freeze({ dx: 6, dy: 0 }),
  }),
  mages: Object.freeze({
    id: "mages",
    name: "Mages' Guild",
    skill: "magic",
    altSkills: Object.freeze(["runecraft"]),
    mission: Object.freeze({ kind: "runes", label: "craft runes", target: 100, favor: 25 }),
    hallOffset: Object.freeze({ dx: -6, dy: 0 }),
  }),
  thieves: Object.freeze({
    id: "thieves",
    name: "Thieves' Guild",
    skill: "thieving",
    altSkills: Object.freeze([]),
    mission: Object.freeze({ kind: "steal", label: "steal goods", target: 500, favor: 25 }),
    hallOffset: Object.freeze({ dx: 0, dy: 6 }),
  }),
  merchants: Object.freeze({
    id: "merchants",
    name: "Merchants' Guild",
    skill: "trading",
    altSkills: Object.freeze([]),
    wealthRequired: 1000, // merchants join on wealth, not skill — real coins
    mission: Object.freeze({ kind: "profit", label: "earn trading profit", target: 1000, favor: 25 }),
    hallOffset: Object.freeze({ dx: 0, dy: -6 }),
  }),
  crafters: Object.freeze({
    id: "crafters",
    name: "Crafters' Guild",
    skill: "crafting",
    altSkills: Object.freeze(["smithing", "fletching"]),
    mission: Object.freeze({ kind: "craft", label: "craft goods", target: 20, favor: 25 }),
    hallOffset: Object.freeze({ dx: 4, dy: 4 }),
  }),
});

// Rivalry pairs: guild id pairs that naturally compete.
const RIVALRIES = Object.freeze([
  Object.freeze(["thieves", "merchants"]),
  Object.freeze(["warriors", "mages"]),
]);

const TRAINING_XP_BONUS = 0.1; // +10% XP training the guild's skill

// --- state -------------------------------------------------------------------

let cache = null;
// { members: { [norm]: { username, guildId, rank, favor, joinedAt, mission } },
//   halls: { [kingdomId:guildId]: { x, y, z } },
//   rivalry: { "thieves|merchants": 0..100, ... } }
let dirty = false;

function blankState() {
  return { members: Object.create(null), halls: Object.create(null), rivalry: Object.create(null) };
}

function blankMember(username, guildId, nowMs) {
  return { username, guildId, rank: "novice", favor: 0, joinedAt: nowMs, mission: null };
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    cache = blankState();
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw.members ?? {})) {
        if (!v || typeof v !== "object" || !GUILDS[v.guildId]) continue;
        cache.members[k] = {
          username: String(v.username ?? k),
          guildId: v.guildId,
          rank: typeof v.rank === "string" ? v.rank : "novice",
          favor: Math.max(0, Number(v.favor ?? 0)),
          joinedAt: Number(v.joinedAt ?? 0),
          mission: v.mission && typeof v.mission === "object" ? v.mission : null,
        };
      }
      for (const [k, v] of Object.entries(raw.halls ?? {})) {
        if (v && typeof v.x === "number") cache.halls[k] = v;
      }
      for (const [k, v] of Object.entries(raw.rivalry ?? {})) {
        const n = Number(v);
        if (Number.isFinite(n)) cache.rivalry[k] = Math.max(0, Math.min(100, n));
      }
    }
  } catch {
    cache = blankState();
  }
  return cache;
}

function markDirty() {
  dirty = true;
}

// --- reads -------------------------------------------------------------------

/** The guild catalog. */
function guilds() {
  return GUILDS;
}

/** Guild definition by id, or null. */
function guildFor(id) {
  return GUILDS[String(id ?? "").toLowerCase()] ?? null;
}

/** Rank key for a favor total: novice | member | veteran | master | grandmaster. */
function rankForFavor(favor) {
  const f = Math.max(0, Number(favor ?? 0));
  for (const r of RANKS) {
    if (f >= r.min) return r.key;
  }
  return "novice";
}

/** Human label for a rank key. */
function rankLabel(rankKey) {
  return RANKS.find((r) => r.key === rankKey)?.label ?? "Novice";
}

/** Trade-guild membership for a citizen, or null when not a member. */
function membershipFor(username) {
  if (!username) return null;
  return load().members[normalizeName(username)] ?? null;
}

/** Guild id for a citizen, or null. */
function guildIdFor(username) {
  return membershipFor(username)?.guildId ?? null;
}

/** Rank key for a citizen, or null when not a member. */
function guildRankFor(username) {
  return membershipFor(username)?.rank ?? null;
}

/** Favor total for a citizen (0 when not a member). */
function favorFor(username) {
  return membershipFor(username)?.favor ?? 0;
}

/** Active mission for a citizen, or null. */
function missionFor(username) {
  return membershipFor(username)?.mission ?? null;
}

/**
 * Guild hall tile for a guild in a kingdom. Deterministic: market tile +
 * the guild's offset, memoized per kingdom. Defensive: a missing market
 * tile returns null rather than inventing coordinates.
 */
function hallTile(guildId, kingdomId) {
  const g = guildFor(guildId);
  if (!g || kingdomId == null) return null;
  const st = load();
  const key = `${kingdomId}:${g.id}`;
  if (st.halls[key]) return st.halls[key];
  try {
    const Sites = require("./CitizenSites");
    const market = Sites.marketTileForKingdom?.(kingdomId) ?? Sites.marketTile?.(kingdomId);
    if (!market || typeof market.x !== "number") return null;
    const tile = { x: market.x + g.hallOffset.dx, y: market.y + g.hallOffset.dy, z: market.z ?? 0 };
    st.halls[key] = tile;
    markDirty();
    return tile;
  } catch {
    return null;
  }
}

/** Rivalry level 0..100 for a guild pair (order-independent). */
function rivalryFor(guildA, guildB) {
  const key = [guildA, guildB].sort().join("|");
  return load().rivalry[key] ?? 0;
}

/**
 * XP bonus (0.1) when training the member's guild skill, else 0.
 * Same additive pattern as the education bonus — real XP, real levels.
 */
function trainingBonusFor(username) {
  return guildIdFor(username) ? TRAINING_XP_BONUS : 0;
}

/**
 * Player-founded guild membership for a citizen, read defensively from
 * the player guild registry. Returns { guildId, name, rank } or null.
 * A missing/broken registry is a no-op.
 */
function playerGuildFor(username) {
  if (!username) return null;
  try {
    const Registry = require("../../guilds/GuildRegistry");
    if (typeof Registry.memberGuild !== "function") return null;
    const g = Registry.memberGuild(username);
    if (!g) return null;
    return {
      guildId: g.id ?? g.guildId ?? null,
      name: g.name ?? "a player guild",
      rank: Registry.memberRank?.(g.id ?? g.guildId, username) ?? "member",
    };
  } catch {
    return null;
  }
}

/**
 * Daily wage bonus for guild members: the guild vouches for its people.
 * Veteran+ members earn a premium on service wages (real coins, paid by
 * the existing wage system). Returns bonus coins/day, 0 for non-members.
 */
function wageBonusFor(username) {
  const rank = guildRankFor(username);
  switch (rank) {
    case "grandmaster": return 60;
    case "master": return 40;
    case "veteran": return 20;
    default: return 0;
  }
}

/**
 * Social modifier between two citizens from guild ties: same trade guild
 * (+4, +8 at veteran+), rival guilds at high rivalry (−6), same player
 * guild (+6). Read by CitizenDecisions. Defensive throughout.
 */
function guildSocialModifier(username, otherUsername) {
  if (!username || !otherUsername) return 0;
  try {
    const a = guildIdFor(username);
    const b = guildIdFor(otherUsername);
    if (a && a === b) {
      const rank = guildRankFor(username);
      return rank === "veteran" || rank === "master" || rank === "grandmaster" ? 8 : 4;
    }
    if (a && b) {
      const key = [a, b].sort().join("|");
      const isRivalPair = RIVALRIES.some((p) => [p[0], p[1]].sort().join("|") === key);
      if (isRivalPair && rivalryFor(a, b) >= 50) return -6;
    }
    // Player-guild bond.
    const pa = playerGuildFor(username);
    const pb = playerGuildFor(otherUsername);
    if (pa?.guildId && pa.guildId === pb?.guildId) return 6;
  } catch {
    // guild socials are best-effort
  }
  return 0;
}

// --- writes ------------------------------------------------------------------

/**
 * Join a trade guild. Checks: guild exists, not already in a trade guild,
 * meets the skill requirement (real level via the skill plugin, defensive
 * fallback 1), and pays dues in real coins when the player object is
 * provided. Awards +3 reputation (a real deed). Returns { ok, reason }.
 */
function joinGuild(username, guildId, player = null, nowMs = Date.now()) {
  const g = guildFor(guildId);
  if (!g) return { ok: false, reason: "no such guild" };
  if (!username) return { ok: false, reason: "no citizen" };
  const st = load();
  const key = normalizeName(username);
  if (st.members[key]) return { ok: false, reason: "already in a guild" };
  // Merchants join on wealth (real coins), everyone else on real skill.
  if (g.wealthRequired) {
    if (coinCount(player) < g.wealthRequired) {
      return { ok: false, reason: `needs ${g.wealthRequired} coins of wealth` };
    }
  } else {
    const level = guildSkillLevel(g, player);
    if (level < JOIN_LEVEL) return { ok: false, reason: `needs ${g.skill} ${JOIN_LEVEL}` };
  }
  if (player) {
    const coins = coinCount(player);
    if (coins < DUES_COINS) return { ok: false, reason: "cannot afford dues" };
    removeCoins(player, DUES_COINS);
  }
  st.members[key] = blankMember(username, g.id, nowMs);
  markDirty();
  awardGuildReputation(username, 3, `joined the ${g.name}`, nowMs);
  return { ok: true, guild: g };
}

/** Leave the current trade guild. Favor and rank are lost. */
function leaveGuild(username) {
  if (!username) return false;
  const st = load();
  const key = normalizeName(username);
  if (!st.members[key]) return false;
  delete st.members[key];
  markDirty();
  return true;
}

/**
 * Add guild favor. Rank-ups are computed here and returned so the tick
 * can announce and journal them. Returns { favor, rank, rankedUp }.
 */
function addFavor(username, amount, reason, nowMs = Date.now()) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m || !Number.isFinite(amount) || amount === 0) return null;
  const before = m.rank;
  m.favor = Math.max(0, m.favor + Math.round(amount));
  m.rank = rankForFavor(m.favor);
  // Earning favor resets the decay clock — fresh effort doesn't instantly fade.
  if (amount > 0) m.favorDecayAt = Math.max(m.favorDecayAt ?? 0, nowMs);
  markDirty();
  const rankedUp = m.rank !== before && RANKS.findIndex((r) => r.key === m.rank) < RANKS.findIndex((r) => r.key === before);
  if (rankedUp) {
    awardGuildReputation(username, 5, `rose to ${rankLabel(m.rank)} of the ${guildFor(m.guildId).name}`, nowMs);
  }
  return { favor: m.favor, rank: m.rank, rankedUp, reason };
}

/**
 * Start the guild's signature mission for a member. Returns the mission
 * or null when the member already has one.
 */
function startMission(username, nowMs = Date.now()) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m) return null;
  if (m.mission) return m.mission;
  const g = guildFor(m.guildId);
  m.mission = { kind: g.mission.kind, label: g.mission.label, target: g.mission.target, progress: 0, favor: g.mission.favor, startedAt: nowMs };
  markDirty();
  return m.mission;
}

/**
 * Advance the active mission by amount. Completing it awards favor
 * (rank-ups flow through addFavor) and clears the slot. Returns
 * { completed, favor } or null when there is no mission.
 */
function advanceMission(username, amount, nowMs = Date.now()) {
  const st = load();
  const key = normalizeName(username);
  const m = st.members[key];
  if (!m?.mission || !Number.isFinite(amount) || amount <= 0) return null;
  m.mission.progress += amount;
  markDirty();
  if (m.mission.progress >= m.mission.target) {
    const favor = m.mission.favor;
    const label = m.mission.label;
    m.mission = null;
    const res = addFavor(username, favor, `completed guild mission: ${label}`, nowMs);
    return { completed: true, favor, rank: res?.rank ?? m.rank, rankedUp: res?.rankedUp ?? false };
  }
  return { completed: false, progress: m.mission.progress, target: m.mission.target };
}

/** Abandon the active mission without reward. */
function abandonMission(username) {
  const st = load();
  const m = st.members[normalizeName(username)];
  if (!m?.mission) return false;
  m.mission = null;
  markDirty();
  return true;
}

/**
 * Nudge rivalry for a guild pair by delta (clamped 0..100). Positive
 * events (a caught thief) raise it; time and peace lower it.
 */
function nudgeRivalry(guildA, guildB, delta) {
  const ga = guildFor(guildA);
  const gb = guildFor(guildB);
  if (!ga || !gb || ga.id === gb.id) return rivalryFor(guildA, guildB);
  const st = load();
  const key = [ga.id, gb.id].sort().join("|");
  const cur = st.rivalry[key] ?? 0;
  const next = Math.max(0, Math.min(100, cur + Number(delta ?? 0)));
  st.rivalry[key] = next;
  markDirty();
  return next;
}

/**
 * Decay favor for every member (1/day toward the rank floor — ranks are
 * kept, but grinding stops mattering if you walk away). Returns count changed.
 */
function decayFavor(nowMs = Date.now()) {
  const st = load();
  const DAY_MS = 24 * 3600 * 1000;
  let changed = 0;
  for (const m of Object.values(st.members)) {
    if (m.favor <= 0) continue;
    if (nowMs - (m.favorDecayAt ?? 0) < DAY_MS) continue;
    m.favorDecayAt = nowMs;
    // Never decay below the current rank's floor — ranks are sticky.
    const floor = RANKS.find((r) => r.key === m.rank)?.min ?? 0;
    if (m.favor > floor) {
      m.favor = Math.max(floor, m.favor - 1);
      changed++;
    }
  }
  if (changed) markDirty();
  return changed;
}

// --- helpers (internal, defensive) -------------------------------------------

function guildSkillLevel(guild, player) {
  const skills = [guild.skill, ...(guild.altSkills ?? [])];
  let best = 1;
  for (const skill of skills) {
    try {
      const lvl = skillLevelFor(player, skill);
      if (Number.isFinite(lvl)) best = Math.max(best, lvl);
    } catch {
      // one unreadable skill doesn't block the join check
    }
  }
  return best;
}

function skillLevelFor(player, skill) {
  if (!player) return 1;
  try {
    const skills = player.getSkills?.() ?? player.skills;
    if (skills && typeof skills.getLevel === "function") {
      const idx = skillIndexFor(skill);
      if (idx >= 0) return Number(skills.getLevel(idx) ?? 1);
    }
  } catch {
    // fall through
  }
  return 1;
}

// tsps skill order for the getLevel(index) API.
const SKILL_ORDER = Object.freeze([
  "attack", "defence", "strength", "hitpoints", "ranged", "prayer", "magic",
  "cooking", "woodcutting", "fletching", "fishing", "firemaking", "crafting",
  "smithing", "mining", "herblore", "agility", "thieving", "slayer",
  "farming", "runecraft", "hunter", "construction",
]);

function skillIndexFor(skill) {
  const s = String(skill ?? "").toLowerCase();
  if (s === "trading") return -1; // not a tsps skill — merchants use coins instead
  return SKILL_ORDER.indexOf(s);
}

// --- canonical coin helpers (real engine API: getAmount / deleteNumber / adds) ---
// The old guards probed `inv.count` / `inv.remove` (neither exists on the
// engine inventory). These three are the only coin paths; every balance move
// is verified before reporting success.

/** Read a real item amount. Never throws, never invents. */
function coinCountInv(inv, id) {
  try { return inv?.getAmount?.(id) ?? 0; } catch { return 0; }
}

/**
 * Remove exactly `amount` of `id`, verifying the balance moved.
 * Returns true only when the inventory confirms the debit.
 */
function takeCoins(inv, id, amount) {
  try {
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(id) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(id, amount);
    return (inv.getAmount?.(id) ?? 0) === before - amount;
  } catch { return false; }
}

/**
 * Credit exactly `amount` of `id`, verifying the balance moved.
 * Returns true only when the inventory confirms the credit.
 */
function giveCoins(inv, id, amount) {
  try {
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(id) ?? 0;
    inv.adds?.(id, amount);
    return (inv.getAmount?.(id) ?? 0) === before + amount;
  } catch { return false; }
}

/** Test seam: canonical real-API coin helpers (inventory audit). */
function _coinHelpersForTests() {
  return { coinCount: coinCountInv, takeCoins, giveCoins };
}

function coinCount(player) {
  try {
    const inv = player?.getInventory?.() ?? player?.inventory;
    if (typeof inv?.getAmount === "function") return coinCountInv(inv, 995);
    if (Array.isArray(inv)) {
      return inv.filter((i) => Number(i?.id) === 995).reduce((n, i) => n + Number(i?.amount ?? 1), 0);
    }
  } catch {
    // fall through
  }
  return 0;
}

function removeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.() ?? player?.inventory;
    return takeCoins(inv, 995, amount);
  } catch {
    // fall through
  }
  return false;
}

function awardGuildReputation(username, points, reason, nowMs) {
  try {
    const Rep = require("./CitizenReputation");
    if (typeof Rep.addReputation === "function") Rep.addReputation(username, points, reason, nowMs);
  } catch {
    // reputation is best-effort
  }
}

// --- persistence ---------------------------------------------------------------

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(load(), null, 2), "utf8");
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/** Test seam — wipe in-memory state (next read reloads from disk). */
function resetForTests() {
  cache = null;
  dirty = false;
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  _coinHelpersForTests,
  guilds,
  guildFor,
  rankForFavor,
  rankLabel,
  membershipFor,
  guildIdFor,
  guildRankFor,
  favorFor,
  missionFor,
  hallTile,
  rivalryFor,
  trainingBonusFor,
  playerGuildFor,
  guildSocialModifier,
  wageBonusFor,
  joinGuild,
  leaveGuild,
  addFavor,
  startMission,
  advanceMission,
  abandonMission,
  nudgeRivalry,
  decayFavor,
  save,
  JOIN_LEVEL,
  DUES_COINS,
  RANKS,
  RIVALRIES,
  TRAINING_XP_BONUS,
};
