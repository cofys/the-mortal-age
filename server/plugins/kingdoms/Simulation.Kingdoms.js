"use strict";

/**
 * Simulation.Kingdoms — the REALM TICK. Offices do things.
 *
 * Every ~10 minutes each great power's held offices act, and the results
 * are visible in the world — not just numbers in a store:
 *
 *   Steward      collects taxes into the treasury (war doubles the levy).
 *   Quartermaster keeps the war stockpile: skims tax revenue for supplies
 *                in peace, burns stockpile in war, and posts public war
 *                demands when the stores run low.
 *   Marshal      orders patrols (the citizens plugin hears
 *                kingdom:patrol-ordered); raises the levy in war.
 *   Spymaster    generates rumors (kingdom:rumor) that citizen
 *                townsfolk repeat in the streets.
 *
 * A vacant office does nothing — and the realm feels it: taxes go
 * uncollected, stockpiles rot, patrols thin. Vacancy notices are throttled
 * so they sting without spamming.
 *
 * Out (custom events, AGENTS.md: plugins talk through events):
 *   kingdom:tax-collected  { kingdomId, amount, wartime }      (existing)
 *   kingdom:rumor          { kingdomId, text }                 (citizens repeat)
 *   kingdom:patrol-ordered { kingdomId, level: "routine"|"doubled"|"war" }
 *   kingdom:war-demand     { kingdomId, need }                 (quartermaster)
 *
 * State: the war stockpile persists on the kingdom record via
 * KingdomStore flags (sim:stockpile). Announcement throttles are
 * in-memory — losing them on restart just means one extra notice.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");

// ~10 minutes at 600ms/tick.
const SIM_TICK_TICKS = 1000;
// Don't announce the same kind of office news more often than this.
const NOTICE_COOLDOWN_MS = 45 * 60 * 1000;

const STOCKPILE_PEACE_TARGET = 400;
const STOCKPILE_WAR_TARGET = 1200;
const WAR_BURN_PER_TICK = 60;
// What each online guard is paid from the treasury every realm tick.
const WAGE_PER_GUARD = 25;

let pluginApi = null;
const lastNoticeAt = new Map(); // `${kingdomId}:${kind}` -> timestamp

function noticeKey(kingdomId, kind) {
  return `${kingdomId}:${kind}`;
}

function noticeDue(kingdomId, kind) {
  const key = noticeKey(kingdomId, kind);
  const last = lastNoticeAt.get(key) ?? 0;
  if (Date.now() - last < NOTICE_COOLDOWN_MS) return false;
  lastNoticeAt.set(key, Date.now());
  return true;
}

/** Send a message to every online player. Cosmetic; never throws. */
function announceToRealm(message) {
  try {
    pluginApi.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        try {
          p.sendMessage(message);
        } catch {
          // One deaf player doesn't silence the realm.
        }
      });
  } catch {
    // World not ready: nothing to announce to.
  }
}

function stockpileOf(kingdomId) {
  const kingdom = Store.getKingdom(kingdomId);
  const raw = kingdom?.flags?.["sim:stockpile"];
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

function setStockpile(kingdomId, value) {
  Store.setFlag(kingdomId, "sim:stockpile", Math.max(0, Math.floor(value)));
}

function holderKind(kingdomId, office) {
  const holder = Offices.holderOf(Offices.officeIdFor(kingdomId, office));
  return holder?.kind ?? null; // "ai" | "player" | null (vacant)
}

function atWarWith(kingdomId, wars) {
  return wars.filter((w) => w.attackerId === kingdomId || w.defenderId === kingdomId);
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

/** Steward: taxes in. Returns the amount collected (0 when vacant). */
function stewardTick(kingdom, warsHere) {
  if (!holderKind(kingdom.id, "steward")) {
    if (noticeDue(kingdom.id, "steward-vacant")) {
      announceToRealm(
        `[Realm] Taxes go uncollected in ${kingdom.name} — the Steward's seat sits empty.`
      );
    }
    return 0;
  }
  const wartime = warsHere.length > 0;
  const base = 180 + Math.floor(Math.random() * 240);
  const amount = wartime ? Math.floor(base * 1.6) : base;
  const treasury = Store.grantTax(kingdom.id, amount);
  pluginApi.emitCustomEvent("kingdom:tax-collected", {
    kingdomId: kingdom.id,
    amount,
    wartime,
    treasury,
  });
  if (noticeDue(kingdom.id, "tax")) {
    announceToRealm(
      `[Realm] The Steward of ${kingdom.name} has collected ${amount} coins in taxes` +
        (wartime ? " — the war levy weighs heavy." : ".")
    );
  }
  return amount;
}

/** Quartermaster: the war stockpile. Skims revenue in peace, burns in war. */
function quartermasterTick(kingdom, warsHere, taxRevenue) {
  const held = holderKind(kingdom.id, "quartermaster");
  let stockpile = stockpileOf(kingdom.id);
  if (!held) {
    // Unmanaged stores rot.
    if (stockpile > 0) setStockpile(kingdom.id, stockpile - 10);
    if (noticeDue(kingdom.id, "quartermaster-vacant")) {
      announceToRealm(
        `[Realm] The stores of ${kingdom.name} go unmanaged — the Quartermaster's seat sits empty.`
      );
    }
    return;
  }
  const wartime = warsHere.length > 0;
  const target = wartime ? STOCKPILE_WAR_TARGET : STOCKPILE_PEACE_TARGET;
  if (wartime) {
    stockpile = Math.max(0, stockpile - WAR_BURN_PER_TICK);
    setStockpile(kingdom.id, stockpile);
  } else if (taxRevenue > 0 && stockpile < target) {
    const skim = Math.min(Math.floor(taxRevenue * 0.3), target - stockpile);
    if (skim > 0) {
      setStockpile(kingdom.id, stockpile + skim);
      stockpile += skim;
    }
  }
  if (stockpile < target * 0.5) {
    const need = target - stockpile;
    pluginApi.emitCustomEvent("kingdom:war-demand", { kingdomId: kingdom.id, need });
    if (noticeDue(kingdom.id, "war-demand")) {
      announceToRealm(
        wartime
          ? `[Realm] The Quartermaster of ${kingdom.name} posts an URGENT war demand: ` +
            `the stores run low and the war eats everything — suppliers and sellswords wanted NOW.`
          : `[Realm] The Quartermaster of ${kingdom.name} posts a war demand: ` +
            `the stores run low — suppliers and sellswords wanted.`
      );
    }
  }
}

/** Marshal: patrols in peace, the levy in war. */
function marshalTick(kingdom, warsHere) {
  if (!holderKind(kingdom.id, "marshal")) {
    if (noticeDue(kingdom.id, "marshal-vacant")) {
      announceToRealm(
        `[Realm] Patrols thin on the ${kingdom.name} roads — the Marshal's seat sits empty.`
      );
    }
    return;
  }
  const wartime = warsHere.length > 0;
  const level = wartime ? "war" : Math.random() < 0.25 ? "doubled" : "routine";
  pluginApi.emitCustomEvent("kingdom:patrol-ordered", { kingdomId: kingdom.id, level });
  if (wartime && noticeDue(kingdom.id, "levy")) {
    const foe = warsHere[0].attackerId === kingdom.id ? warsHere[0].defenderId : warsHere[0].attackerId;
    const foeName = Store.getKingdom(foe)?.name ?? foe;
    announceToRealm(
      `[Realm] The Marshal of ${kingdom.name} has raised the war levy against ${foeName}. ` +
        `Every able blade is wanted.`
    );
  } else if (level === "doubled" && noticeDue(kingdom.id, "patrol")) {
    announceToRealm(
      `[Realm] The Marshal of ${kingdom.name} has ordered doubled patrols. ` +
        `The roads will be safer — and watched.`
    );
  }
}

/** Spymaster: someone always knows something. */
function spymasterTick(kingdom, warsHere) {
  if (!holderKind(kingdom.id, "spymaster")) return; // spies leave no vacancy notice
  const wartime = warsHere.length > 0;
  let text;
  if (wartime) {
    const foe = warsHere[0].attackerId === kingdom.id ? warsHere[0].defenderId : warsHere[0].attackerId;
    const foeName = Store.getKingdom(foe)?.name ?? foe;
    text = pick([
      `They say ${foeName} raiders were seen probing the border marches.`,
      `Word is the ${kingdom.name} watch has doubled — something moves in the dark.`,
      `A courier rode hard for the ${kingdom.capital ?? "capital"} at dawn. War news, they say.`,
      `They say ${foeName} pays sellswords in gold now. Times are desperate.`,
      // Conscription: press gangs, levies, deserters.
      `They say the press-gangs walk ${kingdom.name}'s streets at dusk — strong backs wanted for the levy.`,
      `Word is ${foeName} deserters beg bread at the crossroads, speaking of empty bellies and emptier promises.`,
      `They say the ${kingdom.name} levy-masters pay a bounty for every deserter dragged back in chains.`,
      `They say the levy lists are nailed to the ${kingdom.capital ?? "capital"} gates — every third name a boy not yet shaving.`,
    ]);
  } else {
    text = pick([
      `They say the court of ${kingdom.name} argues late into the night.`,
      `Word in the market is grain prices climb while the great powers stir.`,
      `They say a stranger asked questions about the ${kingdom.capital ?? "capital"} guard rotations.`,
      `They say the gods are silent, but the tax collectors are not.`,
      `A sailor swears he saw strange sails off the coast. Probably drank.`,
    ]);
  }
  pluginApi.emitCustomEvent("kingdom:rumor", { kingdomId: kingdom.id, text });
}

function simTick() {
  let kingdoms;
  try {
    kingdoms = Store.getKingdoms();
  } catch {
    return;
  }
  const wars = Store.getActiveWars();
  for (const kingdom of kingdoms) {
    if (!kingdom?.id) continue;
    try {
      const warsHere = atWarWith(kingdom.id, wars);
      const tax = stewardTick(kingdom, warsHere);
      quartermasterTick(kingdom, warsHere, tax);
      marshalTick(kingdom, warsHere);
      spymasterTick(kingdom, warsHere);
      // Payday is separate from collection: the treasury pays the garrison
      // even when the steward's seat is vacant — until it runs dry.
      pluginApi.emitCustomEvent("kingdom:wage-day", {
        kingdomId: kingdom.id,
        perGuard: WAGE_PER_GUARD,
      });
    } catch (error) {
      pluginApi?.log?.("[kingdoms] sim tick failed", {
        kingdom: kingdom.id,
        error: String(error?.message ?? error),
      });
    }
  }
  pluginApi?.log?.("[kingdoms] realm tick", {
    kingdoms: kingdoms.length,
    activeWars: wars.length,
  });
}

function startSimTask(api) {
  class RealmTask extends Task {
    execute() {
      try {
        simTick();
      } catch (error) {
        api.log?.("[kingdoms] realm tick failed", {
          error: String(error?.message ?? error),
        });
      }
    }
  }
  api.getTaskManager()?.submit(new RealmTask(SIM_TICK_TICKS));
  api.log?.("[kingdoms] realm simulation started", { tickTicks: SIM_TICK_TICKS });
}

module.exports = function attachSimulation(api) {
  pluginApi = api;
  startSimTask(api);
};

// Test seams.
module.exports.simTick = simTick;
module.exports.stockpileOf = stockpileOf;
