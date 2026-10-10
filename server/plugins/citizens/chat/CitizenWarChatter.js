"use strict";

/**
 * CitizenWarChatter — citizens talk about REAL active wars in public chat.
 *
 * The human player model: real players talk about the big stuff happening in
 * the world ("did you hear we're at war with X?", "this territory war is
 * going badly"). Citizens are members of kingdoms; when their kingdom is at
 * war, they should talk about it. When tensions with a neighbor are boiling
 * over, they should rumor about that too.
 *
 * What this does (zero LLM, data tier only):
 *   1. War chatter — a citizen whose kingdom is in an ACTIVE war (per the
 *      kingdoms plugin's canonical war state) occasionally says a short
 *      informal line naming the REAL enemy kingdom and the war's REAL goal
 *      (Plunder / Territory / Vassalize, from WAR_GOAL_LABELS). Side-aware:
 *      attackers talk differently than defenders.
 *   2. Tension rumors — when border tension with a REAL kingdom is >= 80 and
 *      there is NO active war between them, a "war's coming" rumor may fire.
 *
 * What this does NOT do (anti-fiction guarantees):
 *   - getWars(kingdomId, store) returns empty -> absolute silence. No war in
 *     the store means no war in chat. Wars are never invented.
 *   - Every named kingdom comes from KingdomStore.getKingdom(id).name. If the
 *     enemy kingdom record is missing, the citizen stays silent.
 *   - Tension rumors only fire for tension pairs between two real kingdom
 *     records with no activeWarBetween(a, b, store). Hash-derived or cached
 *     fiction is never consulted.
 *   - No LLM in the tick path (scripted pools only, personality-scaled
 *     through citizenVoice).
 *   - Never speaks when no real player is nearby — chatter is FOR players.
 *   - Per-citizen cooldown (25-45 min, randomized): wars last a long time,
 *     so chatter must be rare, or one war dominates chat for a week.
 *   - Only citizens in the NEAR or MID LOD band chatter.
 *
 * Throttle math: wars are rare and chatter is per-citizen every ~35 min on
 * average, watched-only and personality-gated (~45% pass). Even during a big
 * war in a busy capital, expect a line every few minutes across the crowd —
 * flavor, not spam. sayPublic's own 8s chat-box throttle is the backstop.
 */

const { sayPublic } = require("./CitizenSayPublic");
const { voiceFor, voiceLine } = require("../lib/citizenVoice");
const { normalizeName } = require("../lib/CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY, ATTR_KINGDOM_ID } = require("../constants");
const { bandOf, BAND_NEAR, BAND_MID } = require("../lib/CitizenTickLod");
const { isKingdomAtWar } = require("../CitizenEvents");
const { getJournal } = require("../lib/CitizenJournal");
const Wars = require("../../kingdoms/Wars.Kingdoms");
const KingdomStore = require("../../kingdoms/KingdomStore");

// --- tuning -----------------------------------------------------------------
const WAR_CHATTER_MIN_MS = 25 * 60 * 1000; // fastest war-chatter cadence per citizen
const WAR_CHATTER_MAX_MS = 45 * 60 * 1000; // slowest; randomized, human pacing
const TENSION_RUMOR_THRESHOLD = 80; // tension >= 80 with no war = "war's coming"

// Per-citizen state (memory-leak plugs below).
const nextChatterAt = new Map(); // normalized username -> ms
let lastPruneAt = 0;

function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of nextChatterAt) {
    if (at < cutoff) nextChatterAt.delete(k);
  }
}

// --- line pools ----------------------------------------------------------------
// Short, informal, first-person. {enemy} = real enemy kingdom name from the
// store, {goal} = real war goal label (Plunder / Territory / Vassalize).
// Pools are explicit (not generated) so they read like a real player typed them.

const WAR_ATTACK_LINES = {
  plain: [
    "war with {enemy}... heard it's about {goal}",
    "{enemy} had it coming, honestly",
    "hope the {goal} business with {enemy} ends quick",
    "we're marching on {enemy}. {goal}, they say",
    "my cousin's off fighting {enemy} as we speak",
    "{enemy} won't know what hit them",
  ],
  terse: ["war with {enemy}.", "marching on {enemy}.", "{goal}. {enemy}."],
};

const WAR_DEFEND_LINES = {
  plain: [
    "{enemy} declared on us over {goal}, can you believe it",
    "if {enemy} wants {goal} they'll have to take it from us",
    "war with {enemy}. stay sharp out there",
    "heard the {enemy} are coming. gods help us",
    "{enemy} picked a fight over {goal}. we'll finish it",
  ],
  terse: ["war with {enemy}.", "stay sharp. {enemy}.", "{enemy} is coming."],
};

const TENSION_LINES = {
  plain: [
    "tension with {enemy} is getting bad. feels like war's coming",
    "word is things with {enemy} are about to blow up",
    "if {enemy} keeps pushing us we'll have war on our hands",
    "everyone's saying war with {enemy} is just a matter of time",
  ],
  terse: ["tension with {enemy}.", "war's coming with {enemy}.", "{enemy} is pushing it."],
};

// --- helpers -------------------------------------------------------------------

function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function personalityOf(bot) {
  try {
    return bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    return {};
  }
}

function kingdomIdOf(bot) {
  try {
    const id = bot.getAttribute?.(ATTR_KINGDOM_ID);
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function usernameOf(bot) {
  try {
    return bot.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function fillTemplate(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

/** Chatty citizens chatter more; taciturn ones mostly stay quiet. */
function chatterChance(personality) {
  try {
    const traits = new Set(personality?.traits ?? []);
    if (traits.has("chatty")) return 0.8;
    if (traits.has("cheerful") || traits.has("easygoing")) return 0.6;
    if (traits.has("taciturn") || traits.has("gruff") || traits.has("suspicious"))
      return 0.2;
    return 0.45;
  } catch {
    return 0.45;
  }
}

/** Real kingdom name from the store, or null — never invent one. */
function kingdomNameOf(getKingdom, kingdomId) {
  try {
    const name = getKingdom?.(kingdomId)?.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Pick a war-chatter line.
 *
 * `war` is a real war record exactly as Wars.getWars(kingdomId, store)
 * returns it: { attackerId, defenderId, goal, goalLabel, declaredAt,
 * declaredBy }. `enemyName` is the real enemy kingdom's name. Nothing is
 * invented here: no war, no enemy name -> null.
 */
function pickWarLine(war, kingdomId, enemyName, personality, rng = Math.random) {
  if (!war || !enemyName) return null;
  const isAttacker = war.attackerId === kingdomId;
  const pool = isAttacker ? WAR_ATTACK_LINES : WAR_DEFEND_LINES;
  const goal =
    (war.goal && Wars.WAR_GOAL_LABELS[war.goal]) ??
    war.goalLabel ??
    (typeof war.goal === "string" && war.goal.length > 0 ? war.goal : "war");
  const voice = voiceFor(personality);
  const raw = voiceLine(voice, pool, rng);
  return fillTemplate(raw, { enemy: enemyName, goal });
}

/**
 * Pick a "war's coming" tension rumor line. `enemyName` is the real other
 * kingdom's name; null -> null.
 */
function pickTensionLine(enemyName, personality, rng = Math.random) {
  if (!enemyName) return null;
  const voice = voiceFor(personality);
  const raw = voiceLine(voice, TENSION_LINES, rng);
  return fillTemplate(raw, { enemy: enemyName });
}

/**
 * Find a high-tension neighbor: a tension pair involving kingdomId with
 * score >= TENSION_RUMOR_THRESHOLD where the other side is a REAL kingdom
 * and there is NO active war between them. Returns { enemyId, score } or
 * null. Never invents kingdoms.
 */
function highTensionNeighbor(kingdomId, getKingdom, getTensionMap, hasActiveWar) {
  let map;
  try {
    map = getTensionMap() ?? {};
  } catch {
    return null;
  }
  let best = null;
  for (const [key, score] of Object.entries(map)) {
    try {
      if (!Number.isFinite(score) || score < TENSION_RUMOR_THRESHOLD) continue;
      const parts = String(key).split(":");
      if (parts.length !== 2 || !parts.includes(kingdomId)) continue;
      const enemyId = parts[0] === kingdomId ? parts[1] : parts[0];
      if (!enemyId) continue;
      if (!kingdomNameOf(getKingdom, enemyId)) continue; // not a real kingdom
      if (hasActiveWar(kingdomId, enemyId)) continue; // already at war -> war lines instead
      if (!best || score > best.score) best = { enemyId, score };
    } catch {
      // One bad tension entry never breaks the scan.
    }
  }
  return best;
}

// --- main tick ------------------------------------------------------------------

/**
 * Director tick entry. For each online citizen in the NEAR/MID LOD band:
 *   - if their kingdom is at war (cheap CitizenEvents gate), read the real
 *     war records from the store and chatter about one of them;
 *   - else if border tension with a real kingdom is >= 80 with no active war,
 *     chatter a "war's coming" rumor.
 * Empty getWars -> silence. Missing kingdom names -> silence. Zero LLM.
 */
function tickWarChatter(director, overrides = {}) {
  const nowMs = overrides.nowMs ?? Date.now();
  // Production data sources (verified APIs); tests inject fakes here.
  const getWars = overrides.getWars ?? ((kid) => Wars.getWars(kid, KingdomStore));
  const atWar = overrides.isAtWar ?? isKingdomAtWar;
  const getKingdom = overrides.getKingdom ?? ((id) => KingdomStore.getKingdom(id));
  const readTensionMap = overrides.readTensionMap ?? (() => KingdomStore.getTensionMap());
  const warBetween =
    overrides.warBetween ?? ((a, b) => Wars.activeWarBetween(a, b, KingdomStore));
  const bandFor = overrides.bandFor ?? ((record) => bandOf(record));
  const journal = overrides.journal ?? getJournal();
  pruneState(nowMs);

  let roster = [];
  try {
    roster = [...(director.roster?.values?.() ?? [])];
  } catch {
    return;
  }

  for (const record of roster) {
    try {
      if (!record || !director.isOnline(record)) continue;
      const bot = director.getBot(record);
      if (!bot) continue;
      const username = usernameOf(bot) ?? record.username;
      if (!username) continue;
      const key = normalizeName(username);

      // LOD gate: only near/mid citizens talk (asleep/far are unwatched).
      const band = bandFor(record);
      if (band !== BAND_NEAR && band !== BAND_MID) continue;

      // Watched-only: chatter is for players.
      if (realPlayersNear(bot).length === 0) continue;

      const kingdomId = kingdomIdOf(bot);
      if (!kingdomId) continue; // no kingdom — nothing to be at war about

      // Throttled: wars last weeks; chatter must stay rare.
      if (nowMs < (nextChatterAt.get(key) ?? 0)) continue;

      const personality = personalityOf(bot);
      let line = null;

      if (atWar(kingdomId)) {
        // Cheap gate says at war — but the store is truth. Empty -> silent.
        let wars = [];
        try {
          wars = getWars(kingdomId) ?? [];
        } catch {
          wars = [];
        }
        if (!Array.isArray(wars) || wars.length === 0) continue; // never invent
        const war = wars[Math.floor(Math.random() * wars.length)];
        if (!war) continue;
        const enemyId = war.attackerId === kingdomId ? war.defenderId : war.attackerId;
        const enemyName = kingdomNameOf(getKingdom, enemyId);
        if (!enemyName) continue; // enemy not a real kingdom -> silent
        if (Math.random() >= chatterChance(personality)) continue;
        line = pickWarLine(war, kingdomId, enemyName, personality);
      } else {
        // No active war: only a real >=80 tension pair earns a rumor.
        const hot = highTensionNeighbor(kingdomId, getKingdom, readTensionMap, (a, b) => {
          try {
            return warBetween(a, b) != null;
          } catch {
            return false;
          }
        });
        if (!hot) continue;
        if (Math.random() >= chatterChance(personality)) continue;
        const enemyName = kingdomNameOf(getKingdom, hot.enemyId);
        if (!enemyName) continue;
        line = pickTensionLine(enemyName, personality);
      }

      if (!line) continue;
      nextChatterAt.set(
        key,
        nowMs + WAR_CHATTER_MIN_MS + Math.random() * (WAR_CHATTER_MAX_MS - WAR_CHATTER_MIN_MS)
      );
      try {
        sayPublic(bot, line);
      } catch {
        // Cosmetic only.
      }
      try {
        journal?.log(username, "chatted", line);
      } catch {
        // Journal is best-effort.
      }
    } catch {
      // Per-citizen isolation — one bad citizen never breaks the tick.
    }
  }
}

module.exports = {
  tickWarChatter,
  // exposed for tests
  _resetForTests() {
    nextChatterAt.clear();
    lastPruneAt = 0;
  },
  _pickWarLine: pickWarLine,
  _pickTensionLine: pickTensionLine,
  _highTensionNeighbor: highTensionNeighbor,
  _chatterChance: chatterChance,
  _nextChatterAt: nextChatterAt,
  WAR_CHATTER_MIN_MS,
  WAR_CHATTER_MAX_MS,
  TENSION_RUMOR_THRESHOLD,
};
