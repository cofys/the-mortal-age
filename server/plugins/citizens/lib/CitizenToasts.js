"use strict";

/**
 * CitizenToasts — raised glasses at the tavern.
 *
 * Citizens linger at tavern hangouts (see CitizenHangouts). When a real
 * player is within earshot of one, a citizen may raise a toast: a public,
 * scripted overhead line celebrating a recent journal highlight from
 * someone present — a level-up, a finished skilling session, a favor done,
 * a lesson taught. Real players raise glasses to their friends; citizens
 * do the same, so a tavern full of bots reads like a tavern full of people.
 *
 * Two-tier by construction: the journal is the free background tier (every
 * module already logs highlights there for nothing); the toast — a
 * forceChat a player actually sees — fires only when a real player is near.
 * Zero LLM: the frames are scripted and the news is quoted journal text.
 *
 * Wired into the director tick right after the hangouts block, same as
 * StreetNotices and RealmReactions. Plain-node testable:
 * CitizenToasts.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { warmthOf } = require("../StreetNotices");
const { agentRng, chance } = require("./humanizer");
const { normalizeName } = require("./CitizenBonds");

const TOAST_RADIUS = 14; // tiles — close enough to hear the toast
const TOAST_FRESH_MS = 12 * 3600 * 1000; // journal news older than this is stale
const TOAST_CITIZEN_COOLDOWN_MS = 60 * 60 * 1000; // a citizen raises a glass at most this often
const TOAST_HANGOUT_COOLDOWN_MS = 30 * 60 * 1000; // per tavern cluster

let TOAST_CHANCE = 0.3; // per eligible tavern hangout per ~60s tick

// Journal kinds worth raising a glass to.
const TOASTABLE_KINDS = new Set(["work", "mentor", "favor", "earned", "social"]);
// Journaled toasts and hangout small-talk are not news.
const NOT_NEWS_RE = /^(raised a toast|started hanging out|chatted at the|hung out with)/i;

const lastToastByCitizen = new Map(); // username -> timestamp
const lastToastByHangout = new Map(); // kingdomId -> timestamp
const lastToastedEventAt = new Map(); // username -> newest journal at already toasted

// Cooldown entries for removed citizens/hangouts would linger forever.
// Prune entries older than a day, at most hourly. Memory-leak plug.
let lastToastPruneAt = 0;
function pruneToastCooldowns(nowMs) {
  if (nowMs - lastToastPruneAt < 3600 * 1000) return;
  lastToastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastToastByCitizen, lastToastByHangout, lastToastedEventAt]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

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

/** Cheap distance check between two entities (same plane, Chebyshev). */
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

function activeHangouts() {
  try {
    return require("./CitizenHangouts")._test.active;
  } catch {
    return new Map();
  }
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

/** Is this journal entry worth raising a glass to? Pure — unit-tested. */
function isToastable(event, nowMs) {
  if (!event || !TOASTABLE_KINDS.has(event.kind)) return false;
  if (typeof event.at !== "number" || nowMs - event.at > TOAST_FRESH_MS) return false;
  const text = String(event.text ?? "").trim();
  if (text.length === 0) return false;
  if (NOT_NEWS_RE.test(text)) return false;
  return true;
}

function decapitalize(text) {
  if (!text) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// {subject} = the citizen being celebrated, {text} = the quoted highlight.
const TOAST_FRAMES = {
  warm: [
    "Raise your glasses! {subject} {text}",
    "A toast to {subject} — {text}!",
    "Everyone drink! {subject} {text}",
  ],
  neutral: [
    "Hear this! {subject} {text}",
    "Good news — {subject} {text}",
    "A toast — {subject} {text}.",
  ],
  wry: [
    "A toast — {subject} {text}. Try to keep up.",
    "Hear this: {subject} {text}. About time, eh?",
    "Drink up — {subject} {text}. Don't let it go to your head.",
  ],
};

/**
 * The per-tick evaluation. Called by the director right after the hangouts
 * block. Iterates active tavern hangouts; at most one toast per tavern per
 * cooldown window, and only when a real player is within earshot.
 */
function tickToasts(director, nowMs = Date.now()) {
  if (!director) return;
  pruneToastCooldowns(nowMs);
  const active = activeHangouts();
  if (!active || active.size === 0) return;
  for (const [kingdomId, hangout] of active) {
    try {
      tickTavernHangout(director, kingdomId, hangout, nowMs);
    } catch {
      // Non-fatal: keep other taverns healthy.
    }
  }
}

function tickTavernHangout(director, kingdomId, hangout, nowMs) {
  if (!hangout || hangout.anchorKind !== "tavern") return;
  if (nowMs - (lastToastByHangout.get(kingdomId) ?? 0) < TOAST_HANGOUT_COOLDOWN_MS) return;
  const arrived = (hangout.members ?? []).filter((m) => m && m.arrived && m.record);
  if (arrived.length === 0) return;
  const rng = agentRng(`toasts:${kingdomId}:${nowMs >> 16}`);
  if (!chance(rng, TOAST_CHANCE)) return;

  // The freshest toast-worthy journal highlight among the members.
  const journal = getJournal();
  let best = null; // { member, event }
  for (const m of arrived) {
    const username = m.record.username;
    const watermark = lastToastedEventAt.get(normalizeName(username)) ?? 0;
    for (const event of journal.recent(username, 5)) {
      if (event.at <= watermark) break; // recent() is newest-first
      if (!isToastable(event, nowMs)) continue;
      if (!best || event.at > best.event.at) best = { member: m, event };
      break; // one candidate per member: their newest eligible highlight
    }
  }
  if (!best) return;

  // Eligible toastmasters: arrived members with a live bot, off cooldown.
  const masters = arrived.filter((m) => {
    const username = m.record.username;
    if (nowMs - (lastToastByCitizen.get(normalizeName(username)) ?? 0) < TOAST_CITIZEN_COOLDOWN_MS) {
      return false;
    }
    return !!director.getBot?.(m.record);
  });
  if (masters.length === 0) return;
  const toastmaster = pickOne(rng, masters);

  // Two-tier gate: a real player must be within earshot of the toast.
  const bot = director.getBot(toastmaster.record);
  let locals = [];
  try {
    locals = [...(bot.getLocalPlayers?.() ?? [])];
  } catch {
    return;
  }
  if (!locals.some((p) => p !== bot && isRealPlayer(p) && withinTiles(bot, p, TOAST_RADIUS))) {
    return;
  }

  const subject = best.member.record.username;
  const text = decapitalize(String(best.event.text ?? "").trim());
  const warmth = warmthOf(toastmaster.record.personality);
  const frame = pickOne(rng, TOAST_FRAMES[warmth] ?? TOAST_FRAMES.neutral);
  const line = frame.replace("{subject}", subject).replace("{text}", text).slice(0, 120);

  lastToastByCitizen.set(normalizeName(toastmaster.record.username), nowMs);
  lastToastByHangout.set(kingdomId, nowMs);
  lastToastedEventAt.set(normalizeName(subject), best.event.at);
  journalEvent(
    toastmaster.record.username,
    `Raised a toast to ${subject} at the tavern.`,
    "social"
  );
  try {
    bot.forceChat?.(line);
  } catch {
    // A shy toastmaster.
  }
}

/** One-line status for debugging (mirrors mentorStatus). */
function toastStatus() {
  const out = [];
  for (const [name, at] of lastToastByCitizen) {
    out.push(`${name}: last toast ${new Date(at).toISOString()}`);
  }
  return out;
}

function resetForTests() {
  lastToastByCitizen.clear();
  lastToastByHangout.clear();
  lastToastedEventAt.clear();
  lastToastPruneAt = 0;
  TOAST_CHANCE = 0.3;
}

module.exports = {
  tickToasts,
  toastStatus,
  isToastable,
  TOAST_RADIUS,
  TOAST_FRESH_MS,
  TOAST_CITIZEN_COOLDOWN_MS,
  TOAST_HANGOUT_COOLDOWN_MS,
  TOASTABLE_KINDS,
  // exposed for tests
  _resetForTests: resetForTests,
  _test: {
    lastToastByCitizen,
    lastToastByHangout,
    lastToastedEventAt,
    setToastChance: (v) => {
      TOAST_CHANCE = v;
    },
  },
};
