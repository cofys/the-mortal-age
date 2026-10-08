"use strict";

/**
 * CitizenGifts — citizens react when a real player gives them something.
 *
 * Wiring: Citizens.plugin registers onGiftGiven on `api.onItemOnPlayer`.
 * When a player uses an item on a citizen bot's entity, the citizen accepts
 * it for real (the item moves into the bot's inventory — they are a person,
 * not a prop), thanks the player out loud in a personality-flavored voice,
 * and the moment lands in CitizenMemory (MOMENT_GIFT + tone) and the
 * citizen's journal so the LLM mouth can riff on the generosity later.
 *
 * All data tier: scripted forceChat lines, zero LLM. Gifts are still
 * accepted while the thank-you voice is cooling down — a real person
 * doesn't refuse a gift just because they already said thanks recently;
 * the voice just stays quiet.
 *
 * Undroppable items (bound gear, untradeable bonds) are politely declined
 * instead of vanishing into a bot's inventory. If another plugin already
 * claimed the event (event.handled), we stay out of it.
 *
 * Cooldowns are strict: giving is common, so the street thanks rarely and
 * it stays genuine.
 *
 * Plain-node testable: CitizenGifts.test.js.
 */

const { getMemory, MOMENT_GIFT } = require("./lib/CitizenMemory");
const { getJournal } = require("./lib/CitizenJournal");
const { normalizeName } = require("./lib/CitizenBonds");
const { warmthOf } = require("./StreetNotices");

const BOT_HOST_ADDRESS = "bot"; // set by bots/behaviours/spawn/BotPlayerFactory.js

// A citizen thanks a giver at most every 5 minutes; a player hears thanks
// at most every 2 minutes, so gift-spam stays a quiet transaction.
const THANKS_CITIZEN_COOLDOWN_MS = 5 * 60 * 1000;
const THANKS_PLAYER_COOLDOWN_MS = 2 * 60 * 1000;

const lastThanksByCitizen = new Map(); // username -> timestamp
const lastThanksToPlayer = new Map(); // player name -> timestamp

// Player-name-keyed cooldowns would grow with player churn. Prune
// entries older than a day, at most hourly. (Same pattern as StreetNotices.)
let lastGiftPruneAt = 0;
function pruneGiftCooldowns(nowMs) {
  if (nowMs - lastGiftPruneAt < 3600 * 1000) return;
  lastGiftPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastThanksByCitizen, lastThanksToPlayer]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function fillLine(line, { name, item }) {
  return String(line)
    .replace(/\{name\}/g, name)
    .replace(/\{item\}/g, item);
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

function isCitizenBot(entity) {
  try {
    return entity?.getHostAddress?.() === BOT_HOST_ADDRESS;
  } catch {
    return false;
  }
}

function getDirectorSafe() {
  try {
    return require("./director/CitizenDirector").getDirector();
  } catch {
    return null;
  }
}

/**
 * Classify the offered item without touching inventories.
 *   "accept"  — moves into the citizen's inventory, thanks given.
 *   "decline" — bound/undroppable: politely refused, nothing moves.
 *   null      — not a gift at all (no item / handled elsewhere).
 */
function classifyGift(item, event) {
  if (event?.handled) return null;
  if (!item) return null;
  let dropable = true;
  try {
    if (typeof item.isDropable === "function") dropable = item.isDropable() !== false;
  } catch {
    dropable = true;
  }
  return dropable ? "accept" : "decline";
}

function resolveItemName(item, deps) {
  const itemId = item?.getId?.();
  try {
    const fromDeps = deps?.itemName?.(itemId);
    if (fromDeps) return String(fromDeps);
  } catch {
    // Fall through.
  }
  try {
    const named = item?.getDefinition?.()?.getName?.();
    if (named) return String(named);
  } catch {
    // Fall through.
  }
  return itemId != null ? `item ${itemId}` : "something";
}

function citizenPersonality(bot) {
  try {
    const username = bot?.getUsername?.();
    const director = getDirectorSafe();
    const record = username ? director?.roster?.get(normalizeName(username)) : null;
    return record?.personality ?? null;
  } catch {
    return null;
  }
}

/** Whether the thank-you voice is off cooldown for this pair. */
function isThanksAllowed(citizenName, playerName, nowMs = Date.now()) {
  pruneGiftCooldowns(nowMs);
  if (nowMs - (lastThanksByCitizen.get(citizenName) ?? 0) < THANKS_CITIZEN_COOLDOWN_MS) return false;
  if (nowMs - (lastThanksToPlayer.get(playerName) ?? 0) < THANKS_PLAYER_COOLDOWN_MS) return false;
  return true;
}

function recordThanks(citizenName, playerName, nowMs = Date.now()) {
  lastThanksByCitizen.set(citizenName, nowMs);
  lastThanksToPlayer.set(playerName, nowMs);
}

const THANKS_LINES = {
  warm: [
    "Oh! {item} — for me? You're too kind, {name}!",
    "Thank you, {name}! {item} — I'll put it to good use.",
    "What a lovely surprise. Thank you for the {item}, {name}!",
  ],
  neutral: [
    "Thanks for the {item}, {name}.",
    "Much appreciated, {name}.",
    "A gift? Thank you, {name}.",
  ],
  wry: [
    "{item}, eh? ...Thanks, {name}. Don't expect me to get sentimental.",
    "Hm. {item}. Fine — thank you, {name}.",
    "You didn't have to, {name}. (But I won't say no to {item}.)",
  ],
};

const DECLINE_LINES = [
  "That's bound to you, {name} — I couldn't take it if I tried.",
  "I can't accept that one, {name}. It's tied to its owner.",
  "Kind of you, {name}, but that won't leave your hands.",
];

/**
 * A player used an item on a citizen bot: the gift moment.
 *
 * The item moves into the citizen's inventory for real; the citizen thanks
 * the player (voice-gated); memory records the gift and warms the tone;
 * the journal notes it for the LLM mouth.
 *
 * `deps.itemName(itemId)` optionally resolves names in tests; production
 * falls back to the item definition.
 */
function onGiftGiven(event, deps = {}, nowMs = Date.now()) {
  const { player, target, item } = event ?? {};
  const verdict = classifyGift(item, event);
  if (verdict === null) return;
  if (!isRealPlayer(player)) return;
  if (!isCitizenBot(target)) return;

  const playerName = player.getUsername?.() ?? "traveller";
  const citizenName = target.getUsername?.() ?? "someone";
  const itemName = resolveItemName(item, deps);

  if (verdict === "decline") {
    // Bound gear stays with its owner; the refusal is the whole moment.
    try {
      target.forceChat?.(fillLine(pick(DECLINE_LINES), { name: playerName, item: itemName }).slice(0, 120));
    } catch {
      // A silent citizen.
    }
    try {
      player.sendMessage?.(`${citizenName} can't accept the ${itemName}.`);
    } catch {
      // Cosmetic.
    }
    try {
      getJournal().log(citizenName, "social", `Declined ${playerName}'s ${itemName} — bound to its owner.`, {
        with: playerName,
      });
    } catch {
      // The journal must never break the gift.
    }
    event.handled = true;
    return;
  }

  // Accept: the item genuinely changes hands.
  let moved = false;
  try {
    const itemId = item.getId();
    const amount = Math.max(1, item.getAmount?.() ?? 1);
    const playerInv = player.getInventory?.();
    const targetInv = target.getInventory?.();
    if (!playerInv || !targetInv) return; // no silent voiding: nothing moves, nothing claimed
    if (targetInv.getFreeSlots?.() < 1 && (targetInv.getAmount?.(itemId) ?? 0) === 0) {
      try {
        player.sendMessage?.(`${citizenName}'s hands are full.`);
      } catch {
        // Cosmetic.
      }
      event.handled = true;
      return;
    }
    playerInv.deleteNumber(itemId, amount).refreshItems();
    targetInv.adds(itemId, amount);
    moved = true;
  } catch {
    moved = false;
  }
  if (!moved) return; // transfer failed: leave the event unclaimed
  event.handled = true;

  // The thanks: voice-gated, so generosity spam stays quiet.
  if (isThanksAllowed(citizenName, playerName, nowMs)) {
    recordThanks(citizenName, playerName, nowMs);
    let warmth = "neutral";
    try {
      warmth = warmthOf(deps.personality ?? citizenPersonality(target));
    } catch {
      warmth = "neutral";
    }
    const line = fillLine(pick(THANKS_LINES[warmth] ?? THANKS_LINES.neutral), {
      name: playerName,
      item: itemName,
    });
    try {
      target.forceChat?.(line.slice(0, 120));
    } catch {
      // A shy citizen.
    }
    try {
      player.sendMessage?.(`You give ${citizenName} ${itemName}.`);
    } catch {
      // Cosmetic.
    }
  }

  // Remember it: generosity warms the street's memory of this player.
  try {
    const memory = getMemory();
    memory.recordMeeting(citizenName, playerName);
    memory.recordTone(citizenName, playerName, 1);
    memory.recordMoment(citizenName, playerName, MOMENT_GIFT, `${playerName} gave me ${itemName}.`, {});
  } catch {
    // Memory must never break the gift.
  }
  try {
    getJournal().log(citizenName, "social", `Accepted ${itemName} as a gift from ${playerName}.`, {
      with: playerName,
      data: { item: itemName },
    });
  } catch {
    // The journal must never break the gift.
  }
}

module.exports = {
  onGiftGiven,
  // Pure helpers for the unit test.
  classifyGift,
  isThanksAllowed,
  fillLine,
  THANKS_LINES,
  DECLINE_LINES,
};
