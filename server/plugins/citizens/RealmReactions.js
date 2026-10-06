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
const { ROLE_GUARD, ROLE_MERCHANT } = require("./constants");
const KingdomStore = require("../kingdoms/KingdomStore");
const {
  BREAD_ID,
  buyFood,
  eat,
  addMood,
  sellsFood,
} = require("./brain/CitizenNeeds");

const COINS_ID = 995;
// A guard keeps at most this many loaves; the rest of the wage is savings.
const GUARD_BREAD_HOARD = 4;
// One citizen won't parrot rumors more often than this.
const RUMOR_COOLDOWN_MS = 10 * 60 * 1000;
const lastRumorAt = new Map(); // username -> timestamp
// War news is rarer than gossip: one fearful outburst per border per while.
const FEAR_COOLDOWN_MS = 20 * 60 * 1000;
const lastFearAt = new Map(); // sorted "a:b" -> timestamp

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
 *
 * Wages cover food: after payday each guard buys up to two loaves from a
 * bread-selling merchant of the kingdom (real coin and bread transfers)
 * and eats one on the spot. A guard who can't afford bread goes hungry
 * and the street hears about it.
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
    for (const guard of guards) {
      addMood(guard, -10); // unpaid and unhappy
    }
    return;
  }
  const provisioners = onlineBots(kingdomId, ROLE_MERCHANT).filter((bot) => {
    try {
      return sellsFood(bot);
    } catch {
      return false;
    }
  });
  for (const guard of guards) {
    try {
      guard.getInventory?.()?.add?.(COINS_ID, perGuard);
    } catch {
      // One missed payday doesn't stop the rest.
    }
    addMood(guard, 6); // payday feels good
    // Spend some of it on food: two loaves from a bread merchant, one
    // eaten right away. Real transfers; the merchant's till grows.
    try {
      const loaves = guard.getInventory?.()?.getAmount?.(BREAD_ID) ?? 0;
      if (provisioners.length > 0 && loaves < GUARD_BREAD_HOARD) {
        const seller = provisioners[Math.floor(Math.random() * provisioners.length)];
        buyFood(guard, seller);
        buyFood(guard, seller);
        eat(guard);
      }
    } catch {
      // Dinner can wait; the wage itself landed.
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
  onSkirmish,
  onWarDeclaredFear,
  onWarEndedRelief,
};

/**
 * The powder keg hisses: border skirmishes, declarations, and peace all
 * play out in the streets. Citizens speak fear (and relief) out loud via
 * forceChat, throttled per border so one clash doesn't chain.
 */

function kingdomName(kingdomId) {
  return KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
}

/** One citizen of the involved kingdoms speaks a fear line, throttled. */
function speakFear(kingdomIds, lines) {
  const ids = [...new Set(kingdomIds)].filter(Boolean);
  if (ids.length === 0 || lines.length === 0) return;
  const now = Date.now();
  const key = ids.slice().sort().join(":");
  if (now - (lastFearAt.get(key) ?? 0) < FEAR_COOLDOWN_MS) return;
  const candidates = ids.flatMap((id) => onlineBots(id));
  if (candidates.length === 0) return;
  lastFearAt.set(key, now);
  const speaker = pick(candidates);
  try {
    speaker.forceChat?.(pick(lines).slice(0, 120));
  } catch {
    // A silent citizen is fine; the fear still happened.
  }
}

/** kingdom:skirmish — patrols clashed below the threshold of war. */
function onSkirmish(event) {
  const a = event?.attackerId;
  const b = event?.defenderId;
  if (!a || !b) return;
  const location = event?.location ?? "the border marches";
  const aName = kingdomName(a);
  const bName = kingdomName(b);
  speakFear(
    [a, b],
    [
      `Blood on ${location}! ${aName} and ${bName} patrols clashed!`,
      `Did you hear? Steel at ${location}. It's starting, I tell you.`,
      `Keep your head down — the border's gone hot.`,
      `Not war. Please, not war. Not again.`,
    ]
  );
}

/** kingdom:war-declared — the levy is raised and the streets know. */
function onWarDeclaredFear(event) {
  const a = event?.attackerId;
  const b = event?.defenderId;
  if (!a || !b) return;
  const aName = kingdomName(a);
  const bName = kingdomName(b);
  speakFear(
    [a, b],
    [
      `War! ${aName} marches on ${bName}!`,
      `The levy is raised — war with ${bName}! To the walls!`,
      `War with ${aName}. Hide the grain, hide the children.`,
      `They say the ${bName} dead already line the marches.`,
    ]
  );
}

/** kingdom:war-ended — peace, and the rebuilding. */
function onWarEndedRelief(event) {
  const a = event?.attackerId;
  const b = event?.defenderId;
  if (!a || !b) return;
  const aName = kingdomName(a);
  const bName = kingdomName(b);
  speakFear(
    [a, b],
    [
      `Peace! The war between ${aName} and ${bName} is over!`,
      `It's over. The levy stands down. We rebuild.`,
      `Peace at last — but the taxes won't unpay themselves.`,
      `The war's done. Now we count what it cost us.`,
    ]
  );
}
