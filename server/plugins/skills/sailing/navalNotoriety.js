// Piracy notoriety: the 0-100 scale from the naval warfare design doc (Phase 1, "Sail & Shoot").
// Stored as a plain player attribute; decays 3 points a day on login.
const NOTORIETY_ATTRIBUTE = "naval:notoriety";
const LAST_DECAY_ATTRIBUTE = "naval:notoriety-decay";
const DECAY_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Thresholds that announce themselves when crossed upward. */
const THRESHOLDS = [
  [25, "Word spreads of your piracy. Pirate havens will fence your loot."],
  [50, "The navy has marked you a pirate. Their cutters will hunt you at sea."],
  [75, "You are a terror of the seas. Navy cutters hunt you on sight."],
  [100, "Your name is cursed in every port tavern. Maximum notoriety."],
];

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** The player's current notoriety, 0-100. */
function notorietyOf(player) {
  const raw = player.getAttribute(NOTORIETY_ATTRIBUTE);
  return typeof raw === "number" && Number.isFinite(raw) ? clamp(raw) : 0;
}

/** Adds `delta` (negative allowed), announcing crossed thresholds. Returns the new value. */
function addNotoriety(player, delta) {
  const before = notorietyOf(player);
  const after = clamp(before + delta);
  player.setAttribute(NOTORIETY_ATTRIBUTE, after);
  if (delta > 0) {
    for (const [at, message] of THRESHOLDS) {
      if (before < at && after >= at) player.sendMessage(message);
    }
  }
  return after;
}

/** Decays notoriety 3 points per full day since the last decay (runs on login). */
function decayNotoriety(player, now = Date.now()) {
  const last = player.getAttribute(LAST_DECAY_ATTRIBUTE);
  const lastTime = typeof last === "number" && Number.isFinite(last) ? last : now;
  const days = Math.floor((now - lastTime) / DAY_MS);
  if (days > 0) {
    const before = notorietyOf(player);
    const after = clamp(before - days * DECAY_PER_DAY);
    if (after !== before) {
      player.setAttribute(NOTORIETY_ATTRIBUTE, after);
      player.sendMessage(`Your notoriety fades with time. (${after})`);
    }
  }
  player.setAttribute(LAST_DECAY_ATTRIBUTE, now);
}

module.exports = { NOTORIETY_ATTRIBUTE, notorietyOf, addNotoriety, decayNotoriety };
