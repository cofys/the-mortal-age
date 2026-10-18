"use strict";

/**
 * The three levers, their mixers and the mixing vessel.
 *
 * rsprox captures (recordings 4184, 4186, 4187, 4191, 1107):
 * - A lever (Operate) pushes its paste into mixer slot 0 (varbit 11324; 1 mox, 2 aga, 3 lye),
 *   moving the older pulls along to slots 1 and 2: human_alchemy01_lever01_interact01,
 *   synth 2400 (delay 2), the lever's interact loop and a colour change on every mixer whose
 *   slot changed (machinery_alchemy01_mixer_clear_to_blue01, blue_to_green01 ...; mox is blue,
 *   aga green, lye red). With all three slots set, the vessel shows that potion (varbit 11339,
 *   enum 5542's index) and plays vessel01_filling01. A fourth pull just pushes the oldest out,
 *   so no paste is spent until the vessel is emptied (Wiki). The levers' idle loops follow on
 *   the next tick.
 * - The vessel (Take-from): human_pickuptable_walkmerge, then a tick later synth 2582,
 *   vessel01_emptying01, every set mixer back to clear, the slots and the vessel cleared, 10
 *   paste per letter taken from the hopper (one varbit change per letter), the unfinished
 *   potion and "You collect some <col=6800bf>Mammoth-might mix</col> from the mixing vessel."
 *   Short of paste, a message box lists what is missing: "You don't currently have enough
 *   reagents to mix that potion. You<br>are missing the following:<br>10 Mox<br>10 Aga".
 *   An empty vessel: "The mixing vessel is currently empty."
 */

const Shared = require("./Shared.Mixology");

const SLOT_COLOUR = ["clear", "blue", "green", "red"];
const REAGENT_SLOT = { mox: 1, aga: 2, lye: 3 };
const SOUND_LEVER = 2400;
const SOUND_LEVER_DELAY = 2;
const SOUND_COLLECT = 2582;
const LEVER_IDLE_FIELD = "leverIdleTick";
const MESSAGE = {
  EMPTY: "The mixing vessel is currently empty.",
  MISSING: "You don't currently have enough reagents to mix that potion. You<br>are missing the following:",
  /** Not captured. */
  LEVEL: (level) => `You need a Herblore level of ${level} to mix that potion.`,
  /** Not captured. */
  NO_SPACE: "You don't have enough inventory space.",
};

function slots(player) {
  return Shared.VARBIT.MIXER_SLOT.map((varbit) => Shared.get(player, varbit));
}

function counts(values) {
  const result = { mox: 0, aga: 0, lye: 0 };
  for (const value of values) {
    const reagent = Shared.REAGENTS[value - 1];
    if (reagent) result[reagent]++;
  }
  return result;
}

function mixerChange(player, slot, from, to) {
  if (from === to) return;
  Shared.animateLoc(player, Shared.LOC.MIXER[slot], `machinery_alchemy01_mixer_${SLOT_COLOUR[from]}_to_${SLOT_COLOUR[to]}01`);
}

function setSlots(player, next) {
  const previous = slots(player);
  next.forEach((value, slot) => {
    Shared.set(player, Shared.VARBIT.MIXER_SLOT[slot], value);
    mixerChange(player, slot, previous[slot], value);
  });
}

function pull(player, reagent) {
  if (!Shared.permitted(player)) return;
  const lever = Shared.LOC.LEVER[reagent];
  const [first, second] = slots(player);
  const next = [REAGENT_SLOT[reagent], first, second];
  Shared.animate(player, "human_alchemy01_lever01_interact01");
  Shared.sound(player, SOUND_LEVER, SOUND_LEVER_DELAY);
  Shared.animateLoc(player, lever, `machinery_alchemy01_${lever.anim}_interact01`);
  setSlots(player, next);
  if (next[2] !== 0) {
    const ready = Shared.potionFor(counts(next))?.index ?? 0;
    if (ready !== Shared.get(player, Shared.VARBIT.VESSEL_READY)) {
      Shared.set(player, Shared.VARBIT.VESSEL_READY, ready);
      Shared.animateLoc(player, Shared.LOC.VESSEL, "machinery_alchemy01_vessel01_filling01");
    }
  }
  Shared.setField(player, LEVER_IDLE_FIELD, Shared.tick() + 1);
}

function pullMox({ player }) { pull(player, "mox"); }

function pullAga({ player }) { pull(player, "aga"); }

function pullLye({ player }) { pull(player, "lye"); }

/** What the hopper lacks for a potion, per reagent. */
function shortfall(player, entry) {
  const missing = [];
  for (const reagent of Shared.REAGENTS) {
    const need = entry.paste[reagent] * Shared.PASTE_PER_LETTER;
    const short = need - Shared.get(player, Shared.VARBIT.AVAILABLE[reagent]);
    if (short > 0) missing.push(`${Shared.formatNumber(short)} ${Shared.REAGENT_NAME[reagent]}`);
  }
  return missing;
}

function collect(player, entry) {
  if (Shared.get(player, Shared.VARBIT.VESSEL_READY) !== entry.index || shortfall(player, entry).length) return;
  const inventory = player.getInventory();
  if (inventory.getFreeSlots() < 1) {
    player.sendMessage(MESSAGE.NO_SPACE);
    return;
  }
  Shared.sound(player, SOUND_COLLECT);
  Shared.animateLoc(player, Shared.LOC.VESSEL, "machinery_alchemy01_vessel01_emptying01");
  setSlots(player, [0, 0, 0]);
  Shared.set(player, Shared.VARBIT.VESSEL_READY, 0);
  for (const reagent of Shared.REAGENTS) {
    const varbit = Shared.VARBIT.AVAILABLE[reagent];
    for (let letter = 0; letter < entry.paste[reagent]; letter++) {
      Shared.set(player, varbit, Shared.get(player, varbit) - Shared.PASTE_PER_LETTER);
    }
  }
  inventory.adds(entry.unfinished, 1);
  inventory.refreshItems();
  player.sendMessage(`You collect some ${Shared.coloured(player, entry.name)} from the mixing vessel.`);
}

function takeFrom({ player }) {
  if (!Shared.permitted(player)) return;
  const entry = Shared.potion(Shared.get(player, Shared.VARBIT.VESSEL_READY));
  if (!entry) {
    Shared.statement(player, MESSAGE.EMPTY);
    return;
  }
  if (Shared.herbloreLevel(player) < entry.level) {
    Shared.statement(player, MESSAGE.LEVEL(entry.level));
    return;
  }
  const missing = shortfall(player, entry);
  if (missing.length) {
    Shared.statement(player, [MESSAGE.MISSING, ...missing].join("<br>"));
    return;
  }
  if (player.getInventory().getFreeSlots() < 1) {
    player.sendMessage(MESSAGE.NO_SPACE);
    return;
  }
  Shared.animate(player, "human_pickuptable_walkmerge");
  Shared.later(1, () => collect(player, entry));
}

/** The mixers as the player enters: empty ones settle on their clear loop. */
function showMixers(player) {
  slots(player).forEach((value, slot) => {
    if (value === 0) Shared.animateLoc(player, Shared.LOC.MIXER[slot], "machinery_alchemy01_mixer_clear_idle01");
  });
}

function tick(player, now) {
  const due = Shared.field(player, LEVER_IDLE_FIELD);
  if (due === null || now < due) return;
  Shared.setField(player, LEVER_IDLE_FIELD, null);
  for (const lever of Object.values(Shared.LOC.LEVER)) {
    Shared.animateLoc(player, lever, `machinery_alchemy01_${lever.anim}_idle01`);
  }
}

/**
 * The vessel shows eleven names (one per potion), so it is matched by its multiloc's id; its
 * one option is Take-from (op1).
 */
function vessel(event) {
  if (event.handled || event.objectId !== Shared.OBJECT.VESSEL_MULTI || event.clickType !== 1) return;
  event.handled = true;
  takeFrom(event);
}

module.exports = function attachMixer(api) {
  api.onObjectInteraction(Shared.OBJECT.MOX_LEVER, { Operate: pullMox });
  api.onObjectInteraction(Shared.OBJECT.AGA_LEVER, { Operate: pullAga });
  api.onObjectInteraction(Shared.OBJECT.LYE_LEVER, { Operate: pullLye });
  api.onObjectInteraction(vessel);
};

Object.assign(module.exports, { showMixers, tick, slots, counts });
