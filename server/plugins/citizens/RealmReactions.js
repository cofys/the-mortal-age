"use strict";

/**
 * RealmReactions — citizens react to the realm tick.
 *
 * The kingdoms plugin's simulation makes offices act (taxes, stockpiles,
 * patrols, rumors). This module is the citizens' half: living reactions
 * in the streets instead of silent numbers.
 *
 *   kingdom:rumor          -> a townsfolk repeats it (forceChat), throttled
 *   kingdom:patrol-ordered -> a guard acknowledges the order out loud
 *   kingdom:wage-day       -> guards get paid from the treasury; when the
 *                             coffers are empty, payday fails and they say so
 *
 * Listeners are pure functions over the director; wiring lives in
 * Citizens.plugin.js (register is attach-only, AGENTS.md).
 */

const { getDirector } = require("./director/CitizenDirector");
const { ROLE_GUARD } = require("./constants");
const KingdomStore = require("../kingdoms/KingdomStore");

const COINS_ID = 995;
// One citizen won't parrot rumors more often than this.
const RUMOR_COOLDOWN_MS = 10 * 60 * 1000;
const lastRumorAt = new Map(); // username -> timestamp

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function onlineBots(kingdomId, role = null) {
  try {
    return getDirector()?.onlineBotsForKingdom(kingdomId, role) ?? [];
  } catch {
    return [];
  }
}

/** A townsfolk repeats the spymaster's rumor where players can hear it. */
function onKingdomRumor(event) {
  const kingdomId = event?.kingdomId;
  const text = event?.text;
  if (!kingdomId || !text) return;
  const now = Date.now();
  const candidates = onlineBots(kingdomId).filter((bot) => {
    const name = bot.getUsername?.() ?? "";
    return now - (lastRumorAt.get(name) ?? 0) >= RUMOR_COOLDOWN_MS;
  });
  if (candidates.length === 0) return;
  const speaker = pick(candidates);
  lastRumorAt.set(speaker.getUsername?.() ?? "", now);
  try {
    speaker.forceChat?.(String(text).slice(0, 120));
  } catch {
    // A silent citizen is fine; the rumor still happened.
  }
}

const PATROL_LINES = {
  routine: [
    "Patrols as usual. The Marshal's orders.",
    "Walking the walls. Quiet shift, so far.",
  ],
  doubled: [
    "Doubled patrols, by the Marshal's order! Eyes open.",
    "The Marshal wants every street watched. Stay sharp.",
  ],
  war: [
    "WAR! The levy is raised — to arms!",
    "The Marshal calls every able blade. To the walls!",
  ],
};

/** A guard acknowledges the marshal's patrol order out loud. */
function onPatrolOrdered(event) {
  const kingdomId = event?.kingdomId;
  if (!kingdomId) return;
  const level = event?.level ?? "routine";
  if (level === "routine" && Math.random() > 0.4) return; // routine is usually quiet
  const guards = onlineBots(kingdomId, ROLE_GUARD);
  if (guards.length === 0) return;
  const speaker = pick(guards);
  try {
    speaker.forceChat?.(pick(PATROL_LINES[level] ?? PATROL_LINES.routine));
  } catch {
    // Silence is acceptable.
  }
}

const GRUMBLE_LINES = [
  "No pay again. The treasury's as empty as my purse.",
  "They ask for loyalty but the coins never come.",
  "A guard's wage, they promised. Still waiting.",
];

/**
 * Payday: every online guard gets perGuard coins from the treasury.
 * All-or-nothing — when the coffers can't cover the garrison, nobody
 * gets paid and the guards say so in the street.
 */
function onWageDay(event) {
  const kingdomId = event?.kingdomId;
  const perGuard = Math.floor(event?.perGuard ?? 0);
  if (!kingdomId || perGuard <= 0) return;
  const guards = onlineBots(kingdomId, ROLE_GUARD);
  if (guards.length === 0) return;
  const total = perGuard * guards.length;
  if (!KingdomStore.spendTax(kingdomId, total)) {
    const speaker = pick(guards);
    try {
      speaker.forceChat?.(pick(GRUMBLE_LINES));
    } catch {
      // Silent resentment.
    }
    return;
  }
  for (const guard of guards) {
    try {
      guard.getInventory?.()?.add?.(COINS_ID, perGuard);
    } catch {
      // One missed payday doesn't stop the rest.
    }
  }
}

/**
 * A new player just arrived home: steer a nearby citizen to greet them.
 * The nearest online citizen of the kingdom says hello — the first living
 * face of the world. Throttled per citizen so one arrival doesn't chain.
 */
function onPlayerArrived(event) {
  const player = event?.player;
  const kingdomId = event?.kingdomId;
  if (!player || !kingdomId) return;
  let playerLoc;
  try {
    playerLoc = player.getLocation?.();
  } catch {
    return;
  }
  if (!playerLoc) return;
  const now = Date.now();
  const candidates = onlineBots(kingdomId).filter((bot) => {
    const name = bot.getUsername?.() ?? "";
    if (now - (lastRumorAt.get(name) ?? 0) < RUMOR_COOLDOWN_MS) return false;
    try {
      const loc = bot.getLocation?.();
      return loc && loc.getDistance?.(playerLoc) <= 20;
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) return;
  // Nearest greets.
  candidates.sort((a, b) => {
    const da = a.getLocation().getDistance(playerLoc);
    const db = b.getLocation().getDistance(playerLoc);
    return da - db;
  });
  const greeter = candidates[0];
  lastRumorAt.set(greeter.getUsername?.() ?? "", now);
  try {
    greeter.forceChat?.(
      pick([
        "New face! Welcome home, traveller.",
        "Well met! Just arrived, have you?",
        "Welcome! Mind the streets after dark.",
      ])
    );
  } catch {
    // A shy citizen.
  }
}

module.exports = {
  onKingdomRumor,
  onPatrolOrdered,
  onWageDay,
  onPlayerArrived,
};
