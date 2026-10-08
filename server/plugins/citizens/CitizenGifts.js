// CitizenGifts.js â€” item-on-citizen gift moment handler.
//
// A player used an item on a citizen bot: the gift moment. Records the gift
// in citizen memory (so reciprocity and LLM context work) and has the citizen
// thank the giver with a scripted line. Zero LLM.
//
// This module was referenced by Citizens.plugin.js but the file was never
// created; this shim restores the boot and wires the moment properly.

const {
  giftAllowed,
  recordGift,
} = require("./lib/CitizenGiftGiving");

function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
  } catch {
    return false;
  }
  return typeof player.getUsername === "function";
}

function isCitizenBot(target) {
  if (!target) return false;
  try {
    if (target.isPlayerBot?.() === true) return true;
    if (target.getHostAddress?.() === "bot") return true;
  } catch {
    return false;
  }
  return false;
}

const THANK_LINES = [
  "{giver}? For me? You shouldn't have!",
  "Oh! Thank you, {giver}, that's kind of you.",
  "A gift? You're too generous, {giver}.",
  "Well now, what''s this? Thank you kindly, {giver}.",
];

function pickLine(giver) {
  const line = THANK_LINES[Math.floor(Math.random() * THANK_LINES.length)];
  return line.replace(/\{giver\}/g, giver);
}

/**
 * A player used an item on a citizen bot.
 * Event shape: { player, target, item, handled }.
 */
function onGiftGiven(event) {
  try {
    if (!event || event.handled) return;
    const { player, target, item } = event;
    if (!isRealPlayer(player)) return;
    if (!isCitizenBot(target)) return;
    if (!item) return;

    const giverName = player.getUsername?.() ?? "traveller";
    const citizenName = target.getUsername?.() ?? "someone";
    const nowMs = Date.now();

    // Cooldown: don''t spam gifts.
    if (!giftAllowed(citizenName, giverName, nowMs)) return;

    // Record the moment so reciprocity, memory, and the LLM pick it up.
    const itemName = item.getDefinition?.()?.getName?.() ?? "a gift";
    recordGift(citizenName, giverName, nowMs);

    // Thank the giver out loud.
    try {
      target.forceChat?.(pickLine(giverName));
    } catch {
      // Best-effort.
    }

    event.handled = true;
  } catch (e) {
    console.warn("[citizen-gifts] onGiftGiven failed:", e?.message ?? e);
  }
}

module.exports = { onGiftGiven };
