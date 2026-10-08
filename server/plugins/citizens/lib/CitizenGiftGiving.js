"use strict";

/**
 * CitizenGiftGiving — citizens give gifts to real players.
 *
 * The reverse of CitizenGifts.js (which handles players giving TO citizens):
 * here the citizens are the generous ones.
 *
 * WHAT IT DOES (data tier, free):
 *   Occasion detection is pure date/math/memory math — birthdays (deterministic
 *   day-of-year per citizen), thank-you gifts after completed favors, holiday
 *   gifts during festivals, reciprocity (the player gave first), and rare
 *   spontaneous generosity from citizens who are fond of the player.
 *   Gift choice is personality-driven: practical citizens give useful goods,
 *   sentimental ones give keepsakes, generous ones give coin.
 *   A reciprocity ledger is derived from CitizenMemory moments, so gift
 *   debts persist across restarts without new save state.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   The citizen presents the gift with ceremony — a personality-flavored
 *   forceChat line, the item lands in the player's inventory, and a message
 *   confirms it. The gift is journaled so the LLM can riff on it later
 *   ("remember the logs I gave you for your birthday?").
 *
 * Zero LLM: all lines are scripted pools, all occasions are computed.
 * Economy is bounded: gifts are tiny quantities of cheap, fixed-catalog
 * goods (same house pattern as favor rewards), never GE-priced.
 *
 * Wired into the director's tickProximity next to rumors/mysteries.
 * Plain-node testable: CitizenGiftGiving.test.js.
 */

const { getMemory } = require("./CitizenMemory");
const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");
const { warmthOf } = require("../StreetNotices");
const { agentRng, chance } = require("./humanizer");

// === Tuning: all magic numbers here ===
const GIFT_RADIUS = 12; // tiles — close enough to hand something over
const GIFT_CITIZEN_COOLDOWN_MS = 4 * 3600 * 1000; // a citizen gives at most this often
const GIFT_PAIR_WINDOW_MS = 7 * 24 * 3600 * 1000; // same pair re-gifts at most weekly
const THANKYOU_WINDOW_MS = 24 * 3600 * 1000; // thank-you gift within a day of the favor
const RECIPROCITY_WINDOW_MS = 30 * 24 * 3600 * 1000; // gift debts expire after 30 days
const SPONTANEOUS_CHANCE = 0.05; // per eligible tick, when fond
const FOND_TONE_MIN = 3; // memory tone at/above this = fond enough for spontaneity
const MAX_GIFT_VALUE = 500; // safety ceiling on any single gift's value

const COINS = 995;

// Occasion ids.
const OCC_BIRTHDAY = "birthday";
const OCC_THANKYOU = "thankyou";
const OCC_RECIPROCITY = "reciprocity";
const OCC_FESTIVAL = "festival";
const OCC_SPONTANEOUS = "spontaneous";

// Gift catalog: id, qty range, fixed value, display name.
// Ids are all long-established engine ids (same set favors use).
const GIFT_POOLS = Object.freeze({
  practical: Object.freeze([
    { id: 1511, name: "logs", qty: [5, 10], value: 15 },
    { id: 440, name: "iron ore", qty: [3, 6], value: 18 },
    { id: 453, name: "coal", qty: [2, 4], value: 35 },
  ]),
  sentimental: Object.freeze([
    { id: 317, name: "fresh-caught shrimps", qty: [5, 10], value: 8 },
    { id: 436, name: "a lucky copper nugget", qty: [1, 2], value: 10 },
    { id: 438, name: "a lucky tin charm", qty: [1, 2], value: 10 },
  ]),
  generous: Object.freeze([
    { id: COINS, name: "coins", qty: [50, 150], value: 1 },
    { id: 1511, name: "a bundle of logs", qty: [8, 12], value: 15 },
  ]),
});

// === Cooldown state (memory-leak plugged) ===
const lastGiftByCitizen = new Map(); // username -> timestamp
const lastGiftPair = new Map(); // "citizen\x00player" -> timestamp
const birthdayGiftYears = new Map(); // username -> year last birthday-gifted
const festivalGifted = new Map(); // "citizen\x00player\x00festivalId" -> true
const thankedFavorIds = new Set(); // favor ids already thank-you-gifted

let lastPruneAt = 0;
function pruneGiftState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const dayCutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastGiftByCitizen, lastGiftPair]) {
    for (const [k, at] of m) {
      if (at < dayCutoff) m.delete(k);
    }
  }
  // Festival markers are keyed by festival cadence (annual); drop ones
  // not refreshed in a year so the map stays small.
  const yearCutoff = nowMs - 366 * 24 * 3600 * 1000;
  for (const [k, at] of festivalGifted) {
    if (at < yearCutoff) festivalGifted.delete(k);
  }
  // Birthday markers are year-keyed values, not timestamps; they overwrite
  // themselves annually and stay tiny by construction.
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a hash → deterministic day-of-year (1..366) for a citizen's birthday. */
function birthdayDayOfYear(username) {
  let h = 2166136261;
  const s = String(username ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (Math.abs(h) % 366) + 1;
}

/** Day-of-year (1..366) for a Date. */
function dayOfYear(date) {
  const d = date instanceof Date ? date : new Date(date);
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d - start) / 86400000) + 1;
}

/** True if today is this citizen's (derived) birthday. */
function isBirthdayToday(username, date = new Date()) {
  return birthdayDayOfYear(username) === dayOfYear(date);
}

/**
 * Which gift pool fits this personality?
 * Practical citizens give useful goods, sentimental ones give keepsakes,
 * generous ones (merchants, the proud) give coin.
 */
function poolFor(record) {
  const personality = record?.personality ?? null;
  const traits = new Set(personality?.traits ?? []);
  if (record?.role === "merchant" || traits.has("proud") || traits.has("greedy")) {
    return "generous";
  }
  const warmth = (() => {
    try {
      return warmthOf(personality);
    } catch {
      return "neutral";
    }
  })();
  if (warmth === "warm" || traits.has("devout") || traits.has("cheerful")) return "sentimental";
  return "practical";
}

/** Pick a gift entry + quantity from a pool with an injected rng. */
function pickGift(rng, poolName) {
  const pool = GIFT_POOLS[poolName] ?? GIFT_POOLS.practical;
  const entry = pool[Math.floor(rng() * pool.length)];
  const qty = entry.qty[0] + Math.floor(rng() * (entry.qty[1] - entry.qty[0] + 1));
  return { id: entry.id, name: entry.name, qty, value: entry.value * qty };
}

/** Small templating for ceremony lines. */
function fillLine(line, vars) {
  return String(line)
    .replace(/\{name\}/g, vars.name ?? "friend")
    .replace(/\{gift\}/g, vars.gift ?? "a little something")
    .replace(/\{festival\}/g, vars.festival ?? "the festival")
    .replace(/\{theirs\}/g, vars.theirs ?? "your gift");
}

const CEREMONY_LINES = Object.freeze({
  [OCC_BIRTHDAY]: Object.freeze([
    "Happy birthday, {name}! I got you {gift}.",
    "It's your birthday, {name} — {gift}, from me. Don't say I never give.",
    "Many happy returns, {name}! Take this {gift}.",
  ]),
  [OCC_THANKYOU]: Object.freeze([
    "For helping me earlier — {gift}, with thanks, {name}.",
    "You did me a real kindness, {name}. Take {gift}.",
    "{gift} for you, {name} — I don't forget a favor.",
  ]),
  [OCC_RECIPROCITY]: Object.freeze([
    "You gave me {theirs} — I couldn't let that go unanswered. Here's {gift}.",
    "{name}, a gift deserves a gift. {gift}, for yours.",
    "I still owed you for {theirs}. {gift} — we're square, {name}.",
  ]),
  [OCC_FESTIVAL]: Object.freeze([
    "Happy {festival}, {name}! Take this {gift}.",
    "{festival} blessings, {name} — {gift}, on the house.",
    "It's {festival}! Everyone gets {gift}. Even you, {name}.",
  ]),
  [OCC_SPONTANEOUS]: Object.freeze([
    "Saw this {gift} and thought of you, {name}.",
    "{name} — {gift}, just because. Don't make it weird.",
    "Here, {name}. {gift}. You've been good to this town.",
  ]),
});

function ceremonyLine(rng, occasion, vars) {
  const pool = CEREMONY_LINES[occasion] ?? CEREMONY_LINES[OCC_SPONTANEOUS];
  return fillLine(pool[Math.floor(rng() * pool.length)], vars);
}

/** Read the tone this citizen holds toward the player (-10..10). */
function toneToward(citizenName, playerName, memory) {
  try {
    const entry = memory.getEntry(citizenName, playerName);
    return entry?.tone ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Count recent moments of a kind between the pair.
 * Used for reciprocity: has the player given (MOMENT_GIFT="gift") more than
 * the citizen has given back (kind "gifted")?
 */
function countRecentMoments(citizenName, playerName, kind, windowMs, memory, nowMs) {
  try {
    const entry = memory.getEntry(citizenName, playerName);
    const moments = entry?.moments ?? [];
    return moments.filter((m) => m.kind === kind && nowMs - m.at < windowMs).length;
  } catch {
    return 0;
  }
}

/**
 * Decide the gift occasion for this citizen/player pair, or null.
 * Priority: birthday > thankyou > reciprocity > festival > spontaneous.
 * Pure given deps — the tick supplies memory/favor/festival reads.
 */
function occasionFor(record, playerName, date, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  const citizenName = record?.username ?? "";
  const rng = deps.rng ?? Math.random;
  const memory = deps.memory ?? null;

  // 1. Birthday — once per calendar year.
  if (isBirthdayToday(citizenName, date)) {
    const year = (date instanceof Date ? date : new Date(date)).getFullYear();
    if ((deps.birthdayGiftYears?.get?.(citizenName) ?? -1) !== year) {
      return { occasion: OCC_BIRTHDAY, detail: "birthday" };
    }
  }

  // 2. Thank-you — a favor this citizen asked was completed recently.
  const doneFavor = deps.recentDoneFavor?.(citizenName, playerName) ?? null;
  if (doneFavor) {
    return { occasion: OCC_THANKYOU, detail: doneFavor };
  }

  // 3. Reciprocity — the player gave first and the citizen hasn't answered.
  if (memory) {
    const received = countRecentMoments(
      citizenName, playerName, "gift", RECIPROCITY_WINDOW_MS, memory, nowMs
    );
    const givenBack = countRecentMoments(
      citizenName, playerName, "gifted", RECIPROCITY_WINDOW_MS, memory, nowMs
    );
    if (received > givenBack) {
      return { occasion: OCC_RECIPROCITY, detail: "unanswered generosity" };
    }
  }

  // 4. Festival — holiday gift during an active festival, once per festival.
  const festival = deps.activeFestival?.(date) ?? null;
  if (festival) {
    const key = `${citizenName}\u0000${playerName}\u0000${festival.id}`;
    if (!deps.festivalGifted?.has?.(key)) {
      return { occasion: OCC_FESTIVAL, detail: festival.name, festivalId: festival.id };
    }
  }

  // 5. Spontaneous — fond citizens are randomly generous.
  if (memory && toneToward(citizenName, playerName, memory) >= FOND_TONE_MIN) {
    if (chance(rng, SPONTANEOUS_CHANCE)) {
      return { occasion: OCC_SPONTANEOUS, detail: "fondness" };
    }
  }

  return null;
}

/** Gate: may this citizen give to this player right now? */
function giftAllowed(citizenName, playerName, nowMs = Date.now()) {
  pruneGiftState(nowMs);
  if (nowMs - (lastGiftByCitizen.get(citizenName) ?? 0) < GIFT_CITIZEN_COOLDOWN_MS) return false;
  const pair = `${citizenName}\u0000${playerName}`;
  if (nowMs - (lastGiftPair.get(pair) ?? 0) < GIFT_PAIR_WINDOW_MS) return false;
  return true;
}

function recordGift(citizenName, playerName, nowMs = Date.now()) {
  lastGiftByCitizen.set(citizenName, nowMs);
  lastGiftPair.set(`${citizenName}\u0000${playerName}`, nowMs);
}

// --- engine helpers (same shapes as the template) ---

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

/** Nearest real player within radius of the citizen, or null. */
function nearestRealPlayer(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    let best = null;
    let bestD = Infinity;
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      try {
        const la = citizen.getLocation?.();
        const lb = p.getLocation?.();
        if (!la || !lb || la.getZ() !== lb.getZ()) continue;
        const d = Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY()));
        if (d <= radius && d < bestD) {
          best = p;
          bestD = d;
        }
      } catch {
        // Skip unreadable positions.
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Recently completed favor this citizen owes thanks for, or null. */
function recentDoneFavor(citizenName, playerName, nowMs = Date.now()) {
  try {
    const { getFavorStore, DONE } = require("./CitizenFavors");
    const store = getFavorStore();
    const favors = store.forCitizen?.(citizenName) ?? [];
    for (const f of favors) {
      if (f.state !== DONE) continue;
      if (normalizeName(f.player) !== normalizeName(playerName)) continue;
      if (thankedFavorIds.has(f.id)) continue;
      const doneAt = f.completedAt ?? f.doneAt ?? 0;
      if (nowMs - doneAt > THANKYOU_WINDOW_MS) continue;
      return f.id;
    }
    return null;
  } catch {
    return null;
  }
}

function activeFestivalNow(date) {
  try {
    return require("./CitizenFestivals").activeFestival(date);
  } catch {
    return null;
  }
}

function mem(citizenName, playerName, text, kind, toneDelta) {
  try {
    const memory = getMemory();
    memory.recordMeeting(citizenName, playerName);
    if (toneDelta) memory.recordTone(citizenName, playerName, toneDelta);
    memory.recordMoment(citizenName, playerName, kind, text, {});
  } catch {
    // Memory must never break the gift.
  }
}

function journal(citizenName, text, data) {
  try {
    getJournal().log(citizenName, "social", text, data);
  } catch {
    // The journal must never break the gift.
  }
}

/**
 * Present the gift: item into the player's inventory, ceremony line,
 * memory + journal. Returns true when the gift landed.
 */
function giveGift(citizen, player, record, occasion, gift, vars, nowMs = Date.now()) {
  const citizenName = record?.username ?? "someone";
  const playerName = player?.getUsername?.() ?? "traveller";
  if (gift.value > MAX_GIFT_VALUE) return false;

  // Inventory room: coins always stack; other goods need a free slot.
  let moved = false;
  try {
    const inv = player.getInventory?.();
    if (!inv) return false;
    if (gift.id !== COINS) {
      const free = inv.getFreeSlots?.() ?? 1;
      const has = inv.getAmount?.(gift.id) ?? 0;
      if (free < 1 && has === 0) {
        try {
          player.sendMessage?.(`${citizenName} wanted to give you something, but your hands are full.`);
        } catch {
          // Cosmetic.
        }
        return false;
      }
    }
    inv.adds(gift.id, gift.qty);
    moved = true;
  } catch {
    moved = false;
  }
  if (!moved) return false;

  const giftDesc = gift.qty > 1 ? `${gift.qty}x ${gift.name}` : gift.name;
  const line = ceremonyLine(agentRng(`${citizenName}:${occasion}:${nowMs}`), occasion, {
    ...vars,
    name: playerName,
    gift: giftDesc,
  });
  try {
    citizen.forceChat?.(line.slice(0, 120));
  } catch {
    // A shy citizen.
  }
  try {
    player.sendMessage?.(`${citizenName} gives you ${giftDesc}.`);
  } catch {
    // Cosmetic.
  }

  mem(
    citizenName,
    playerName,
    `Gave ${playerName} ${giftDesc} (${occasion}).`,
    "gifted",
    1
  );
  journal(citizenName, `Gave ${giftDesc} to ${playerName} (${occasion}).`, {
    with: playerName,
    data: { item: gift.name, qty: gift.qty, occasion },
  });

  // Mark occasion-specific bookkeeping.
  if (occasion === OCC_BIRTHDAY) {
    birthdayGiftYears.set(citizenName, new Date(nowMs).getFullYear());
  }
  if (occasion === OCC_FESTIVAL && vars.festivalId) {
    festivalGifted.set(`${citizenName}\u0000${playerName}\u0000${vars.festivalId}`, nowMs);
  }
  if (occasion === OCC_THANKYOU && vars.favorId) {
    thankedFavorIds.add(vars.favorId);
    // Favor ids are short-lived; keep the set bounded anyway.
    if (thankedFavorIds.size > 2000) {
      const oldest = thankedFavorIds.values().next().value;
      thankedFavorIds.delete(oldest);
    }
  }
  return true;
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → materialized → real player near → occasion.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickGiftGiving(director, nowMs) {
  pruneGiftState(nowMs);
  const date = new Date(nowMs);
  let memory = null;
  try {
    memory = getMemory();
  } catch {
    memory = null;
  }
  try {
    for (const record of director.roster?.values?.() ?? []) {
      // 1. Cooldown gate — O(1), skips almost everyone.
      const citizenName = record?.username;
      if (!citizenName) continue;
      if (nowMs - (lastGiftByCitizen.get(citizenName) ?? 0) < GIFT_CITIZEN_COOLDOWN_MS) continue;

      // 2. Citizen must be materialized (near a player already).
      const citizen = director.playerFor?.(record);
      if (!citizen) continue;

      // 3. A real player must be within handing distance.
      const player = nearestRealPlayer(director, citizen, GIFT_RADIUS);
      if (!player) continue;
      const playerName = player.getUsername?.() ?? "traveller";
      if (!giftAllowed(citizenName, playerName, nowMs)) continue;

      // 4. Is there an occasion?
      const occ = occasionFor(record, playerName, date, {
        nowMs,
        memory,
        rng: Math.random,
        birthdayGiftYears,
        festivalGifted,
        activeFestival: activeFestivalNow,
        recentDoneFavor: (c, p) => recentDoneFavor(c, p, nowMs),
      });
      if (!occ) continue;

      // 5. Choose the gift and present it.
      const gift = pickGift(Math.random, poolFor(record));
      const vars = { festival: occ.detail, festivalId: occ.festivalId, favorId: occ.detail };
      // For reciprocity, name what the player gave (best-effort from memory).
      if (occ.occasion === OCC_RECIPROCITY && memory) {
        try {
          const entry = memory.getEntry(citizenName, playerName);
          const last = (entry?.moments ?? [])
            .filter((m) => m.kind === "gift")
            .sort((a, b) => b.at - a.at)[0];
          if (last) vars.theirs = last.text.replace(/^.*?gave me /i, "").replace(/\.$/, "");
        } catch {
          // Best-effort.
        }
      }
      if (giveGift(citizen, player, record, occ.occasion, gift, vars, nowMs)) {
        recordGift(citizenName, playerName, nowMs);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-giftgiving] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickGiftGiving,
  giveGift,
  // Pure helpers for tests:
  occasionFor,
  pickGift,
  poolFor,
  fillLine,
  ceremonyLine,
  birthdayDayOfYear,
  dayOfYear,
  isBirthdayToday,
  giftAllowed,
  recordGift,
  toneToward,
  countRecentMoments,
  GIFT_POOLS,
  CEREMONY_LINES,
  OCC_BIRTHDAY,
  OCC_THANKYOU,
  OCC_RECIPROCITY,
  OCC_FESTIVAL,
  OCC_SPONTANEOUS,
  _test: {
    resetForTests() {
      lastGiftByCitizen.clear();
      lastGiftPair.clear();
      birthdayGiftYears.clear();
      festivalGifted.clear();
      thankedFavorIds.clear();
      lastPruneAt = 0;
    },
    lastGiftByCitizen,
    lastGiftPair,
    birthdayGiftYears,
    festivalGifted,
    thankedFavorIds,
  },
};
