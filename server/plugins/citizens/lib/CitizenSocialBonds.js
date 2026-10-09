"use strict";

/**
 * CitizenSocialBonds — persistent per-citizen relationship memory.
 *
 * CitizenBonds holds the binary graph (friend / enemy lists); CitizenMemory
 * remembers facts about players; brain/CitizenRelationships models
 * citizen<->citizen formation dynamics in memory. This module is the
 * *remembered score* underneath all of them: a directed -100..+100 score
 * from one citizen toward a specific citizen or player, built from REAL
 * events (conversations, help, gifts, trades, boss runs — and insults,
 * attacks, PK kills), decaying slowly toward indifference.
 *
 * Favors and grudges are stored with their story ("lent you 5k for the rune
 * scim", "killed you at the Giant Mole") so the LLM mouth can recall them
 * truthfully instead of inventing history.
 *
 * Threshold crossings promote into the CitizenBonds graph (friends/enemies)
 * with journal lines, so every existing consumer — invite targeting,
 * boss-run companion picks, clan growth, the chat context — feels the
 * relationship without new wiring. The brain layer's citizen<->citizen
 * rapport writes through here (quietly) so relationships survive restarts.
 *
 * Data tier, zero LLM. Persisted to data/saves/citizen-social-bonds.json
 * with a dirty flag; the director flushes on its slow tick. Tick-safe:
 * every external touch is wrapped.
 */

const fs = require("fs");
const path = require("path");
const { isFriend, isEnemy, addFriend, addEnemy } = require("./CitizenBonds");
const { getMemory, relativeTime } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-social-bonds.json");

// --- tuning -----------------------------------------------------------------
const SCORE_MIN = -100;
const SCORE_MAX = 100;
const FRIEND_AT = 40; // sustained warmth becomes friendship
const CLOSE_AT = 70; // deep friendship
const RIVAL_AT = -40; // sustained hostility becomes rivalry
const NEMESIS_AT = -70; // irreconcilable
const DECAY_PER_TICK = 1; // scores drift toward 0 each slow tick
const MAX_TARGETS_PER_CITIZEN = 40; // like CitizenMemory's cap
const MAX_FAVORS = 8;
const MAX_GRUDGES = 8;
const FAVOR_TTL_MS = 14 * 24 * 3600 * 1000;
const GRUDGE_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_OWNERS = 5000;

// Event weights. Shared vocabulary with brain/CitizenRelationships so the
// write-through speaks one language. Positive builds, negative burns.
const WEIGHTS = Object.freeze({
  met: 1,
  greeted: 1,
  chatted: 2,
  workedAlongside: 3,
  traded: 3,
  helped: 6,
  favor: 8,
  gift: 7,
  partied: 5,
  bossed: 8,
  befriended: 10,
  argued: -6,
  insulted: -12,
  stolen_from: -20,
  fought: -18,
  attacked: -25,
  killed_by: -60,
  betrayed: -30,
  unfriended: -15,
});

// Grudge-kind -> score-kind mapping for recordGrudge().
const GRUDGE_KINDS = Object.freeze({
  insult: "insulted",
  theft: "stolen_from",
  attack: "attacked",
  kill: "killed_by",
  betrayal: "betrayed",
});

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function clampScore(v) {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, v));
}

// --- persistent state ---------------------------------------------------------

let data = null; // { owners: { ownerKey: { targetKey: entry } } }
let dirty = false;

function blankEntry() {
  return { s: 0, f: [], g: [], u: 0 };
}

function load() {
  if (data) return data;
  data = { owners: {} };
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      data.owners = parsed.owners ?? {};
    }
  } catch {
    // First boot or corrupt save — start clean, never break the tick.
  }
  return data;
}

function markDirty() {
  dirty = true;
}

/** Flush to disk if dirty. Returns true when a write happened. */
function save() {
  load();
  if (!dirty) return false;
  try {
    const dir = path.dirname(SAVE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${SAVE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, SAVE_FILE);
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function entryFor(owner, target, create = false) {
  const owners = load().owners;
  const o = normalizeName(owner);
  const t = normalizeName(target);
  if (!o || !t || o === t) return null;
  if (!owners[o] && !create) return null;
  if (!owners[o]) {
    if (Object.keys(owners).length >= MAX_OWNERS) return null;
    owners[o] = {};
  }
  if (!owners[o][t] && !create) return null;
  if (!owners[o][t]) owners[o][t] = blankEntry();
  return owners[o][t];
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Never break the tick.
  }
}

// --- standing -----------------------------------------------------------------

/** Label for a score: close | friend | warm | neutral | cold | rival | nemesis. */
function standing(score) {
  if (score >= CLOSE_AT) return "close";
  if (score >= FRIEND_AT) return "friend";
  if (score >= 15) return "warm";
  if (score <= NEMESIS_AT) return "nemesis";
  if (score <= RIVAL_AT) return "rival";
  if (score <= -15) return "cold";
  return "neutral";
}

/** Current score from owner toward target (0 when they've never met). */
function scoreOf(owner, target) {
  const e = entryFor(owner, target, false);
  return e ? e.s : 0;
}

/** Standing label from owner toward target. */
function standingFor(owner, target) {
  return standing(scoreOf(owner, target));
}

/** True when owner treats target as a rival or worse (score or enemy list). */
function isRival(owner, target) {
  try {
    if (isEnemy(owner, target)) return true;
  } catch {
    // Fall through to the score.
  }
  return scoreOf(owner, target) <= RIVAL_AT;
}

// --- recording ------------------------------------------------------------------

/**
 * Record a real interaction. Moves the directed score by the kind's weight
 * (clamped ±100). Unless quiet, threshold crossings promote into the
 * CitizenBonds graph with journal lines: >=FRIEND_AT befriends, <=RIVAL_AT
 * makes an enemy. opts.mutual mirrors the change target->owner (for
 * citizen<->citizen events).
 *
 * @returns the new directed score (owner -> target).
 */
function recordInteraction(owner, target, kind, opts = {}) {
  const o = normalizeName(owner);
  const t = normalizeName(target);
  if (!o || !t || o === t) return 0;
  const weight = WEIGHTS[kind];
  if (!Number.isFinite(weight)) return scoreOf(o, t);

  const entry = entryFor(o, t, true);
  if (!entry) return 0;
  const before = entry.s;
  const after = clampScore(before + weight);
  entry.s = after;
  entry.u = opts.at ?? Date.now();
  markDirty();

  if (!opts.quiet) promote(o, t, before, after, kind);

  if (opts.mutual) {
    const back = entryFor(t, o, true);
    if (back) {
      const bBefore = back.s;
      const bAfter = clampScore(bBefore + weight);
      back.s = bAfter;
      back.u = entry.u;
      markDirty();
      if (!opts.quiet) promote(t, o, bBefore, bAfter, kind);
    }
  }
  return after;
}

/** Threshold-crossing side effects: friends/enemies graph, journal, memory. */
function promote(owner, target, before, after, kind) {
  const wasFriend = before >= FRIEND_AT;
  const isFriendNow = after >= FRIEND_AT;
  const wasRival = before <= RIVAL_AT;
  const isRivalNow = after <= RIVAL_AT;
  try {
    if (isFriendNow && !wasFriend) {
      if (addFriend(owner, target)) {
        journalEvent(owner, `Counts ${target} as a friend now.`);
        try {
          const mem = getMemory();
          mem.recordMeeting?.(owner, target);
          mem.recordTone?.(owner, target, 2);
        } catch {
          // Memory must never break promotion.
        }
      }
    } else if (isRivalNow && !wasRival) {
      if (addEnemy(owner, target)) {
        journalEvent(owner, `Considers ${target} a rival — bad blood.`, "enemy");
        try {
          const mem = getMemory();
          mem.recordMoment?.(
            owner,
            target,
            kind === "killed_by" ? "betrayed" : "insulted",
            `Fell out with ${target}.`,
            { pinned: kind === "killed_by" }
          );
        } catch {
          // Memory must never break promotion.
        }
      }
    }
  } catch {
    // Promotion must never break the tick.
  }
}

/**
 * Remember a favor: target did something kind for owner. Stored with its
 * story and a score bump.
 */
function recordFavor(owner, target, text, at = Date.now()) {
  const entry = entryFor(owner, target, true);
  if (!entry) return 0;
  entry.f.push({ text: String(text ?? "").slice(0, 200), at });
  while (entry.f.length > MAX_FAVORS) entry.f.shift();
  markDirty();
  return recordInteraction(owner, target, "favor", { at });
}

/**
 * Remember a grudge: target wronged owner. Stored with kind + story and a
 * score hit. Kinds: insult | theft | attack | kill | betrayal.
 */
function recordGrudge(owner, target, kind, text, at = Date.now()) {
  const entry = entryFor(owner, target, true);
  if (!entry) return 0;
  entry.g.push({
    kind: GRUDGE_KINDS[kind] ? kind : "insult",
    text: String(text ?? "").slice(0, 200),
    at,
  });
  while (entry.g.length > MAX_GRUDGES) entry.g.shift();
  markDirty();
  const scoreKind = GRUDGE_KINDS[kind] ?? "insulted";
  const after = recordInteraction(owner, target, scoreKind, { at });
  // Serious offenses get whispered about: the victim warns their friends.
  if ((kind === "attack" || kind === "kill") && after <= RIVAL_AT) {
    try {
      require("./CitizenRelationships").warnFriends(owner, target, "attack", 3, at);
    } catch {
      // Warnings must never break the offense path.
    }
  }
  return after;
}

/** Favors owner remembers target doing for them (newest last). */
function favors(owner, target) {
  const e = entryFor(owner, target, false);
  return e ? e.f.slice() : [];
}

/** Grudges owner holds against target (newest last). */
function grudges(owner, target) {
  const e = entryFor(owner, target, false);
  return e ? e.g.slice() : [];
}

// --- kill attribution -------------------------------------------------------------

/**
 * A citizen died with a killer attached (from the death event). Records a
 * grudge when the killer is a real player or a fellow citizen; NPC kills
 * (wolves, etc.) are not personal.
 */
function noteKill(victimName, killer, director, at = Date.now()) {
  try {
    const victim = normalizeName(victimName);
    if (!victim) return null;
    let killerName = null;
    let killerIsPlayer = false;
    try {
      killerName =
        killer?.getUsername?.() ?? killer?.username ?? killer?.name ?? null;
      if (typeof killer?.isPlayerBot === "function") {
        killerIsPlayer = killer.isPlayerBot() !== true && typeof killer.getUsername === "function";
      } else if (typeof killer === "string") {
        killerName = killer;
      }
      // NPC killers carry a definition name instead of a username.
      if (!killerName && typeof killer?.getDefinition === "function") return null;
    } catch {
      return null;
    }
    killerName = normalizeName(killerName);
    if (!killerName || killerName === victim) return null;
    let killerIsCitizen = false;
    try {
      killerIsCitizen = director?.roster?.has?.(killerName) === true;
    } catch {
      killerIsCitizen = false;
    }
    if (!killerIsPlayer && !killerIsCitizen) return null; // NPC or unknown — not personal
    const text = killerIsPlayer
      ? `${killerName} killed you. You haven't forgotten.`
      : `${killerName} killed you. Blood for blood.`;
    recordGrudge(victim, killerName, "kill", text, at);
    return { victim, killer: killerName, player: killerIsPlayer };
  } catch {
    return null;
  }
}

// --- LLM context --------------------------------------------------------------------

/**
 * One line for the chat context: how owner feels about target, with the
 * freshest favor/grudge as the WHY. Empty string when there's nothing to
 * say (neutral, no memories).
 */
function bondSummary(owner, target) {
  try {
    const o = normalizeName(owner);
    const t = normalizeName(target);
    if (!o || !t || o === t) return "";
    const entry = entryFor(o, t, false);
    const s = entry ? entry.s : 0;
    const label = standing(s);
    const display = String(target ?? "").trim().split(" ")[0] || target;
    const latestFavor = entry?.f?.[entry.f.length - 1];
    const latestGrudge = entry?.g?.[entry.g.length - 1];
    let line = "";
    if (label === "close") line = `${display} is one of your closest friends.`;
    else if (label === "friend") line = `${display} is a friend of yours.`;
    else if (label === "warm") line = `You like ${display}.`;
    else if (label === "cold") line = `You are wary of ${display}.`;
    else if (label === "rival") line = `${display} is your rival. You don't trust them.`;
    else if (label === "nemesis") line = `${display} is your nemesis. Be curt, give nothing away.`;
    if (latestGrudge && s < 0) {
      const when = relativeTime(latestGrudge.at);
      line += ` They ${grudgeVerb(latestGrudge.kind)} ${when}: ${latestGrudge.text}`;
    } else if (latestFavor && s > 0) {
      const when = relativeTime(latestFavor.at);
      line += ` They did you a favor ${when}: ${latestFavor.text}`;
    }
    return line.trim();
  } catch {
    return "";
  }
}

function grudgeVerb(kind) {
  switch (kind) {
    case "kill":
      return "killed you";
    case "attack":
      return "attacked you";
    case "theft":
      return "stole from you";
    case "betrayal":
      return "betrayed you";
    default:
      return "insulted you";
  }
}

/** Top bonds by |score|, for introductions / reminiscing. */
function topBonds(owner, n = 5, minAbs = FRIEND_AT) {
  const o = normalizeName(owner);
  const owners = load().owners;
  const map = owners[o] ?? {};
  return Object.entries(map)
    .filter(([, e]) => Math.abs(e.s) >= minAbs)
    .sort((a, b) => Math.abs(b[1].s) - Math.abs(a[1].s))
    .slice(0, n)
    .map(([name, e]) => ({ name, score: e.s, standing: standing(e.s) }));
}

// --- slow tick ------------------------------------------------------------------------

/**
 * Scores drift toward indifference; old favors/grudges are forgotten.
 * Called from the director's data tick. Returns { decayed, pruned }.
 */
function tickDecay(nowMs = Date.now()) {
  const owners = load().owners;
  let decayed = 0;
  let pruned = 0;
  for (const o of Object.keys(owners)) {
    const map = owners[o];
    const targets = Object.keys(map);
    // Bound: keep the strongest bonds, drop the indifferent.
    if (targets.length > MAX_TARGETS_PER_CITIZEN) {
      targets
        .sort((a, b) => Math.abs(map[a].s) - Math.abs(map[b].s))
        .slice(0, targets.length - MAX_TARGETS_PER_CITIZEN)
        .forEach((t) => {
          delete map[t];
          pruned += 1;
        });
    }
    for (const t of Object.keys(map)) {
      const e = map[t];
      if (e.s > 0) {
        e.s = Math.max(0, e.s - DECAY_PER_TICK);
        decayed += 1;
      } else if (e.s < 0) {
        e.s = Math.min(0, e.s + DECAY_PER_TICK);
        decayed += 1;
      }
      const fBefore = e.f.length;
      const gBefore = e.g.length;
      e.f = e.f.filter((x) => nowMs - x.at < FAVOR_TTL_MS);
      e.g = e.g.filter((x) => nowMs - x.at < GRUDGE_TTL_MS);
      pruned += fBefore - e.f.length + (gBefore - e.g.length);
      if (e.s === 0 && e.f.length === 0 && e.g.length === 0) {
        delete map[t];
        pruned += 1;
      }
    }
    if (Object.keys(map).length === 0) delete owners[o];
  }
  if (decayed > 0 || pruned > 0) markDirty();
  return { decayed, pruned };
}

// --- test seams -------------------------------------------------------------------------

function resetForTests() {
  data = { owners: {} };
  dirty = false;
}

function _setSavePathForTests(p) {
  SAVE_FILE = p;
  data = null;
  dirty = false;
}

module.exports = {
  WEIGHTS,
  FRIEND_AT,
  CLOSE_AT,
  RIVAL_AT,
  NEMESIS_AT,
  recordInteraction,
  recordFavor,
  recordGrudge,
  favors,
  grudges,
  scoreOf,
  standing,
  standingFor,
  isRival,
  bondSummary,
  topBonds,
  noteKill,
  tickDecay,
  save,
  load,
  markDirty,
  resetForTests,
  _setSavePathForTests,
  _saveFile: () => SAVE_FILE,
};
