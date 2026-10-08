"use strict";

/**
 * CitizenNeeds — hp, run energy, mood for every citizen.
 *
 * Jon's correction (2026-10-08): "there is no hunger in runescape, there's
 * just hitpoints. you need food to restore your health/hp." The old
 * time-decay hunger was a generic life-sim import — wrong for this game.
 *
 * Each citizen carries three needs (0-100):
 *   hp     — percent of max hitpoints, synced from the real engine value.
 *            NEVER time-decays. Drops from combat/mishaps; restored by eating.
 *   energy — run energy (0-100), mirrored from player.getRunEnergy().
 *            Depleted by running; recovers when idle. The engine skips
 *            run-energy recovery for bots, so this module recovers it
 *            manually for citizens when they're not moving.
 *   mood   — flavor only (grumpy lines). Decays slowly, recovered by earning
 *            coins and rest. Deliberately affects nothing mechanical.
 *
 * Needs are VISIBLE, not mechanical: when a threshold trips, the citizen
 * says so overhead (forceChat) on a per-need cooldown. The DECISION LAYER
 * (brain/CitizenDecisions.js) reads these to choose activities — hurt
 * citizens eat, weary citizens rest.
 *
 * The registry is keyed by username so needs survive logout/login. The
 * director mirrors a rounded snapshot onto the citizens:needs attribute
 * for inspection.
 *
 * Food loop: bread (2309) is the staple, heals 5 HP (OSRS value). Citizens
 * eat from their own inventory first, then buy a loaf from a bread-selling
 * merchant (citizens:ware-item unset, or "BREAD") for 12 coins — real
 * inventory ops on both sides. A hurt citizen with no food and no coins
 * says so out loud.
 */

const { ATTR_CITIZEN_NEEDS, ATTR_WARE_ITEM, ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("../lib/citizenVoice");

const BREAD_ID = 2309; // ItemIds.BREAD
const BRONZE_SWORD_ID = 1277; // ItemIds.BRONZE_SWORD
const COINS_ID = 995; // ItemIds.COINS
const BREAD_PRICE = 12;
const BREAD_HEAL = 5; // OSRS bread heals 5 HP
const HITPOINTS_SKILL_INDEX = 3; // Skill.VALUES order: Attack, Defence, Strength, Hitpoints

const NEED_MAX = 100;
// Eat when HP drops below this percent — like a player topping up mid-fight.
const HURT_AT = 70;
// Rest when run energy drops below this.
const WEARY_AT = 25;
const GRUMPY_AT = 25;
// Run-energy recovery for citizens (bots don't get the engine's recovery).
const RUN_RECOVERY_PER_HOUR_IDLE = 30;

const MOOD_DECAY_PER_HOUR = 3;
const OFFLINE_ENERGY_RECOVERY_PER_HOUR = 25;
const OFFLINE_MOOD_RECOVERY_PER_HOUR = 3;

const LINE_COOLDOWN_MS = 20 * 60 * 1000;
const FEED_COOLDOWN_MS = 10 * 60 * 1000;
const BROKE_LINE_COOLDOWN_MS = 30 * 60 * 1000;

const HURT_LINES = Object.freeze({
  plain: Object.freeze([
    "I'm hurt... need a minute.",
    "That one stung.",
    "Patch me up... anyone got food?",
    "I'm not looking so good.",
  ]),
  terse: Object.freeze(["hurt.", "need food.", "patch me up.", "not good."]),
});

const ENERGY_LINES = Object.freeze({
  plain: Object.freeze([
    "Out of breath...",
    "Need to catch my breath.",
    "My legs are giving out.",
    "Can't keep running like this.",
  ]),
  terse: Object.freeze(["winded.", "need a sec.", "legs are gone.", "can't run."]),
});

const GRUMPY_LINES = Object.freeze({
  plain: Object.freeze([
    "Everything's gone wrong today.",
    "Bah. People.",
    "Not in the mood. Not ever, lately.",
    "Mind your own business.",
  ]),
  terse: Object.freeze(["bah.", "leave me be.", "not today.", "hmph."]),
});

const ATE_LINES = Object.freeze({
  plain: Object.freeze([
    "That hit the spot.",
    "Good bread. Good day.",
    "Mmm. Needed that.",
  ]),
  terse: Object.freeze(["better.", "needed that.", "good."]),
});

const BROKE_LINES = Object.freeze({
  plain: Object.freeze([
    "Can't even afford bread...",
    "Hurt and broke. Story of my life.",
    "My purse is as empty as my stomach.",
  ]),
  terse: Object.freeze(["broke.", "no coins.", "can't afford it."]),
});

/** username -> { hp, energy, mood, lastTickMs, lastLineAt, lastFeedAt } */
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
      hp: NEED_MAX,
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

/**
 * Drop needs data for a citizen who no longer exists (refugee column
 * stood down, war casualty). The registry is keyed by username and
 * never evicted otherwise. Memory-leak plug, 2026-10-07.
 */
function dropNeeds(playerOrName) {
  const username = usernameOf(playerOrName);
  if (username) registry.delete(username);
}

function clampNeeds(needs) {
  needs.hp = Math.min(NEED_MAX, Math.max(0, needs.hp));
  needs.energy = Math.min(NEED_MAX, Math.max(0, needs.energy));
  needs.mood = Math.min(NEED_MAX, Math.max(0, needs.mood));
  return needs;
}

function needsSnapshot(needs) {
  return {
    hp: Math.round(needs.hp),
    energy: Math.round(needs.energy),
    mood: Math.round(needs.mood),
  };
}

/** Current hitpoints as a 0-100 percent of max. */
function hpPercent(player) {
  try {
    const cur = player?.getHitpoints?.() ?? NEED_MAX;
    const max =
      player?.getSkillManager?.()?.getMaxLevel?.(HITPOINTS_SKILL_INDEX) ??
      NEED_MAX;
    if (!max || max <= 0) return NEED_MAX;
    return Math.min(100, Math.max(0, (cur / max) * 100));
  } catch (error) {
    return NEED_MAX;
  }
}

/** True when the citizen is currently moving (running down run energy). */
function isMoving(player) {
  try {
    if (player?.getForceMovement?.() != null) return true;
    return (player?.getMovementQueue?.()?.size?.() ?? 0) > 0;
  } catch (error) {
    return false;
  }
}

/** Overhead line, throttled per key so one citizen doesn't spam. Voice-aware:
 * the line is picked and styled for the citizen's personality. */
function say(player, key, pool, cooldownMs = LINE_COOLDOWN_MS) {
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
    const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    player.forceChat?.(voiceLine(voiceFor(personality), pool));
  } catch (error) {
    // Cosmetic only.
  }
}

/**
 * Sync needs from the real engine state.
 * `player` is the live bot or null when logged out.
 *
 * hp: synced from real hitpoints — NEVER time-decays. A citizen standing
 * in Lumbridge for 10 hours stays at full HP, like a player.
 * energy: mirrored from real run energy. The engine skips run-energy
 * recovery for bots, so citizens recover it manually when idle.
 * mood: slow flavor decay, recovered offline.
 *
 * Emits visible threshold lines for online citizens and mirrors the
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
    // HP is real and event-driven (combat/mishaps), never a timer.
    needs.hp = hpPercent(player);
    // Run energy: read the real value; recover manually when idle
    // (the engine only auto-recovers non-bots).
    try {
      const moving = isMoving(player);
      let runEnergy = player.getRunEnergy?.() ?? NEED_MAX;
      if (!moving && runEnergy < NEED_MAX) {
        const recovered = Math.min(
          NEED_MAX,
          runEnergy + RUN_RECOVERY_PER_HOUR_IDLE * elapsedH
        );
        try {
          player.setRunEnergy?.(Math.floor(recovered));
        } catch (error) {
          // Read-only fallback below.
        }
        runEnergy = player.getRunEnergy?.() ?? recovered;
      }
      needs.energy = Math.min(NEED_MAX, Math.max(0, runEnergy));
    } catch (error) {
      // Engine read failed — keep last known energy.
    }
    needs.mood -= MOOD_DECAY_PER_HOUR * elapsedH;
  } else {
    // Offline: HP stays as it was (no combat while logged out), run energy
    // and mood recover.
    needs.energy += OFFLINE_ENERGY_RECOVERY_PER_HOUR * elapsedH;
    needs.mood += OFFLINE_MOOD_RECOVERY_PER_HOUR * elapsedH;
  }
  clampNeeds(needs);
  if (player) {
    if (needs.hp < HURT_AT) {
      say(player, "hurt", HURT_LINES);
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

/**
 * Eat one bread from the citizen's own inventory: real item removal and
 * real HP restore via player.heal(). Returns true when they ate.
 */
function eat(player) {
  const needs = ensureNeeds(player);
  const inventory = player?.getInventory?.();
  if (!needs || !inventory || breadCount(player) <= 0) {
    return false;
  }
  inventory.deleteNumber(BREAD_ID, 1);
  try {
    player.heal?.(BREAD_HEAL);
  } catch (error) {
    // Item consumed; HP restore is best-effort.
  }
  needs.hp = hpPercent(player);
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
 * Feed attempt for a hurt citizen: own bread first, then buy from one of
 * the given sellers. Only fires when HP is actually low — there is no
 * hunger timer. A citizen who can't afford bread says so out loud.
 */
function attemptFeed(player, sellers = []) {
  const needs = needsFor(player);
  if (!needs || hpPercent(player) >= HURT_AT) {
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
  // Mirror onto real run energy so the engine and the need agree.
  try {
    player?.setRunEnergy?.(Math.floor(needs.energy));
  } catch (error) {
    // Best effort.
  }
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
  BREAD_HEAL,
  HURT_AT,
  WEARY_AT,
  GRUMPY_AT,
  ensureNeeds,
  needsFor,
  dropNeeds,
  needsSnapshot,
  tickNeeds,
  hpPercent,
  eat,
  buyFood,
  attemptFeed,
  breadCount,
  addMood,
  addEnergy,
  sellsFood,
  say,
};
