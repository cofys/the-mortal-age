"use strict";

/**
 * CitizenNeeds — hunger, energy, mood for every citizen.
 *
 * Each citizen carries three visible needs (0-100):
 *   hunger — decays through the day, recovered by eating bread
 *   energy — decays while awake, recovered by sleeping (offline) and meals
 *   mood   — decays slowly, recovered by earning coins and rest
 *
 * Needs are VISIBLE, not mechanical: when a threshold trips, the citizen
 * says so overhead (forceChat — the existing chat system) on a per-need
 * cooldown. Mood deliberately affects nothing mechanical yet.
 *
 * The registry is keyed by username so needs survive logout/login (the
 * director ticks offline citizens too — they sleep off the day). The
 * director mirrors a rounded snapshot onto the citizens:needs attribute
 * for inspection.
 *
 * Food loop: bread (2309) is the staple. Citizens eat from their own
 * inventory first, then buy a loaf from a bread-selling merchant
 * (citizens:ware-item unset, or "BREAD") for 12 coins — real inventory
 * ops on both sides. A citizen who can't afford bread goes hungry and
 * says so, visibly grumpy.
 */

const { ATTR_CITIZEN_NEEDS, ATTR_WARE_ITEM } = require("../constants");

const BREAD_ID = 2309; // ItemIds.BREAD
const BRONZE_SWORD_ID = 1277; // ItemIds.BRONZE_SWORD
const COINS_ID = 995; // ItemIds.COINS
const BREAD_PRICE = 12;

const NEED_MAX = 100;
const HUNGER_DECAY_PER_HOUR = 8;
const ENERGY_DECAY_PER_HOUR = 10;
const MOOD_DECAY_PER_HOUR = 3;
const OFFLINE_HUNGER_DECAY_PER_HOUR = 2;
const OFFLINE_ENERGY_RECOVERY_PER_HOUR = 25;
const OFFLINE_MOOD_RECOVERY_PER_HOUR = 3;

const HUNGRY_AT = 35;
const WEARY_AT = 25;
const GRUMPY_AT = 25;

const LINE_COOLDOWN_MS = 20 * 60 * 1000;
const FEED_COOLDOWN_MS = 10 * 60 * 1000;
const BROKE_LINE_COOLDOWN_MS = 30 * 60 * 1000;

const HUNGER_LINES = Object.freeze([
  "I'm starving...",
  "My belly's gnawing at my backbone.",
  "Haven't eaten since yesterday, I swear.",
  "Is that bread I smell? Tell me that's bread.",
]);

const ENERGY_LINES = Object.freeze([
  "Dead on my feet...",
  "I could sleep standing up, I really could.",
  "My eyes won't stay open.",
  "Need... rest... just a minute...",
]);

const GRUMPY_LINES = Object.freeze([
  "Everything's gone wrong today.",
  "Bah. People.",
  "Not in the mood. Not ever, lately.",
  "Mind your own business.",
]);

const ATE_LINES = Object.freeze([
  "That hit the spot.",
  "Good bread. Good day.",
  "Mmm. Needed that.",
]);

const BROKE_LINES = Object.freeze([
  "Can't even afford bread...",
  "Hungry again. Story of my life.",
  "My purse is as empty as my stomach.",
]);

/** username -> { hunger, energy, mood, lastTickMs, lastLineAt, lastFeedAt } */
const registry = new Map();

function usernameOf(playerOrName) {
  if (typeof playerOrName === "string") {
    return playerOrName;
  }
  try {
    return playerOrName?.getUsername?.() ?? null;
  } catch (error) {
    return null;
  }
}

function ensureNeeds(playerOrName) {
  const username = usernameOf(playerOrName);
  if (!username) {
    return null;
  }
  let needs = registry.get(username);
  if (!needs) {
    needs = {
      hunger: NEED_MAX,
      energy: NEED_MAX,
      mood: 80,
      lastTickMs: Date.now(),
      lastLineAt: {},
      lastFeedAt: 0,
    };
    registry.set(username, needs);
  }
  return needs;
}

function needsFor(playerOrName) {
  const username = usernameOf(playerOrName);
  return (username && registry.get(username)) || null;
}

function clampNeeds(needs) {
  needs.hunger = Math.min(NEED_MAX, Math.max(0, needs.hunger));
  needs.energy = Math.min(NEED_MAX, Math.max(0, needs.energy));
  needs.mood = Math.min(NEED_MAX, Math.max(0, needs.mood));
  return needs;
}

function needsSnapshot(needs) {
  return {
    hunger: Math.round(needs.hunger),
    energy: Math.round(needs.energy),
    mood: Math.round(needs.mood),
  };
}

/** Overhead line, throttled per key so one citizen doesn't spam. */
function say(player, key, lines, cooldownMs = LINE_COOLDOWN_MS) {
  const needs = needsFor(player);
  if (!needs || !player) {
    return;
  }
  const now = Date.now();
  if (now - (needs.lastLineAt[key] ?? 0) < cooldownMs) {
    return;
  }
  needs.lastLineAt[key] = now;
  try {
    player.forceChat?.(lines[Math.floor(Math.random() * lines.length)]);
  } catch (error) {
    // Cosmetic only.
  }
}

/**
 * Decay/recover one citizen's needs over elapsed wall-clock time.
 * `player` is the live bot or null when logged out (sleep recovery).
 * Emits the visible threshold lines for online citizens and mirrors the
 * snapshot onto the citizens:needs attribute.
 */
function tickNeeds(username, player, nowMs) {
  const needs = ensureNeeds(username);
  if (!needs) {
    return null;
  }
  const elapsedH = Math.min(
    4,
    Math.max(0, (nowMs - (needs.lastTickMs ?? nowMs)) / 3600000)
  );
  needs.lastTickMs = nowMs;
  if (player) {
    needs.hunger -= HUNGER_DECAY_PER_HOUR * elapsedH;
    needs.energy -= ENERGY_DECAY_PER_HOUR * elapsedH;
    needs.mood -= MOOD_DECAY_PER_HOUR * elapsedH;
  } else {
    // Asleep: hunger still gnaws a little, energy and mood recover.
    needs.hunger -= OFFLINE_HUNGER_DECAY_PER_HOUR * elapsedH;
    needs.energy += OFFLINE_ENERGY_RECOVERY_PER_HOUR * elapsedH;
    needs.mood += OFFLINE_MOOD_RECOVERY_PER_HOUR * elapsedH;
  }
  clampNeeds(needs);
  if (player) {
    if (needs.hunger < HUNGRY_AT) {
      say(player, "hunger", HUNGER_LINES);
    }
    if (needs.energy < WEARY_AT) {
      say(player, "energy", ENERGY_LINES);
    }
    if (needs.mood < GRUMPY_AT) {
      say(player, "mood", GRUMPY_LINES);
    }
    try {
      player.setAttribute?.(ATTR_CITIZEN_NEEDS, needsSnapshot(needs));
    } catch (error) {
      // Inspection-only; never break the tick.
    }
  }
  return needs;
}

function coinCount(player) {
  return player?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0;
}

function breadCount(player) {
  return player?.getInventory?.()?.getAmount?.(BREAD_ID) ?? 0;
}

/** Eat one bread from the citizen's own inventory. */
function eat(player) {
  const needs = ensureNeeds(player);
  const inventory = player?.getInventory?.();
  if (!needs || !inventory || breadCount(player) <= 0) {
    return false;
  }
  inventory.deleteNumber(BREAD_ID, 1);
  needs.hunger = NEED_MAX;
  needs.energy = Math.min(NEED_MAX, needs.energy + 5);
  needs.mood = Math.min(NEED_MAX, needs.mood + 4);
  say(player, "ate", ATE_LINES, BROKE_LINE_COOLDOWN_MS);
  return true;
}

/**
 * Buy one loaf from a bread-selling merchant: real coin and item transfer.
 * Returns true when the loaf changed hands.
 */
function buyFood(player, seller) {
  if (!player || !seller || seller === player) {
    return false;
  }
  const buyerInv = player.getInventory?.();
  const sellerInv = seller.getInventory?.();
  if (!buyerInv || !sellerInv) {
    return false;
  }
  if (breadCount(seller) <= 0 || coinCount(player) < BREAD_PRICE) {
    return false;
  }
  buyerInv.deleteNumber(COINS_ID, BREAD_PRICE);
  sellerInv.adds(COINS_ID, BREAD_PRICE);
  sellerInv.deleteNumber(BREAD_ID, 1);
  buyerInv.adds(BREAD_ID, 1);
  return true;
}

/**
 * Feed attempt for a hungry citizen: own bread first, then buy from one of
 * the given sellers. A citizen who can't afford bread goes visibly hungry.
 */
function attemptFeed(player, sellers = []) {
  const needs = needsFor(player);
  if (!needs || needs.hunger >= HUNGRY_AT) {
    return false;
  }
  const now = Date.now();
  if (now - (needs.lastFeedAt ?? 0) < FEED_COOLDOWN_MS) {
    return false;
  }
  needs.lastFeedAt = now;
  if (eat(player)) {
    return true;
  }
  for (const seller of sellers) {
    if (buyFood(player, seller)) {
      eat(player);
      return true;
    }
  }
  say(player, "broke", BROKE_LINES, BROKE_LINE_COOLDOWN_MS);
  return false;
}

function addMood(player, delta) {
  const needs = needsFor(player);
  if (!needs) {
    return;
  }
  needs.mood = Math.min(NEED_MAX, Math.max(0, needs.mood + delta));
}

function addEnergy(player, delta) {
  const needs = needsFor(player);
  if (!needs) {
    return;
  }
  needs.energy = Math.min(NEED_MAX, Math.max(0, needs.energy + delta));
}

/**
 * Does this merchant sell food? Unset citizens:ware-item means the default
 * bread stall; an explicit ware only counts when it is bread.
 */
function sellsFood(player) {
  let ware = null;
  try {
    ware = player?.getAttribute?.(ATTR_WARE_ITEM);
  } catch (error) {
    return true;
  }
  if (ware === undefined || ware === null || ware === "") {
    return true;
  }
  if (typeof ware === "number") {
    return ware === BREAD_ID;
  }
  return String(ware).trim().toUpperCase().replace(/[\s-]+/g, "_") === "BREAD";
}

module.exports = {
  BREAD_ID,
  BRONZE_SWORD_ID,
  COINS_ID,
  BREAD_PRICE,
  HUNGRY_AT,
  WEARY_AT,
  GRUMPY_AT,
  ensureNeeds,
  needsFor,
  needsSnapshot,
  tickNeeds,
  eat,
  buyFood,
  attemptFeed,
  addMood,
  addEnergy,
  sellsFood,
  say,
};
