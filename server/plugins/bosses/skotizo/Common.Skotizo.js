/**
 * Skotizo: what the units share - the plugin api, plugins/bosses/data/skotizo.json, tick timing,
 * the captured fade and the saved attributes.
 */
const DATA = require("../data/skotizo.json");

const KILLS_ATTRIBUTE = "skotizo:kills";
/** Set while the player is in their lair, so a login there puts them back by the altar. */
const INSIDE_ATTRIBUTE = "skotizo:inside";

const OVERLAY_ATMOSPHERE_UID = (161 << 16) | 1;
const OVERLAY_HUD_UID = (161 << 16) | 8;
const FADE_OVERLAY = 174;
const FADE_SCRIPT = 948;
const FADE_CYCLES = 50;

let api = null;
let core = null;

/** Set once by the plugin before any unit attaches. */
function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
}

/** Runs `action` `ticks` ticks from now (at least one). */
function later(ticks, action) {
  const { Task, TaskManager } = core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(Math.max(1, ticks), null, false);
    }
    execute() {
      this.stop();
      action();
    }
  })());
}

/**
 * Runs `steps` (ticks from now -> actions) while the player stays logged in; tick 0 runs now.
 * Movement is blocked until the last step, as it is through the captured fade.
 */
function sequence(player, steps) {
  const movement = player.getMovementQueue();
  const last = Math.max(...steps.keys());
  const run = (tick) => (steps.get(tick) ?? []).forEach((step) => step());
  movement.setBlockMovement(true).reset();
  run(0);
  for (let tick = 1; tick <= last; tick++) {
    later(tick, () => {
      if (!player.isRegistered()) return;
      run(tick);
      if (tick === last) movement.setBlockMovement(false);
    });
  }
}

const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const toLocation = ([x, y, z]) => new core.Location(x, y, z ?? 0);

function fade(player, out) {
  const args = out ? [0, 255, 0, 0, FADE_CYCLES] : [0, 0, 0, 255, FADE_CYCLES];
  player.getPacketSender().sendSubInterface(OVERLAY_ATMOSPHERE_UID, FADE_OVERLAY, 1, {
    postScripts: [{ scriptId: FADE_SCRIPT, args }],
  });
}

function closeFade(player) {
  player.getPacketSender().closeSubInterface(OVERLAY_ATMOSPHERE_UID);
}

/** The lair's track, unlocked and played. */
function playMusic(player) {
  api.emitCustomEvent("music:unlock-track", { player, trackId: DATA.music });
  player.getPacketSender().sendSong(DATA.music);
}

const npcName = (npc) => String((npc?.getCurrentDefinition?.() ?? npc?.getDefinition?.())?.getName?.() ?? "");

function weaponName(player) {
  const weapon = player.getEquipment().getItems()[core.Equipment.WEAPON_SLOT];
  return weapon?.isValid?.() ? String(weapon.getDefinition().getName() ?? "") : "";
}

module.exports = {
  init, later, sequence, randomInt, toLocation, fade, closeFade, playMusic, npcName, weaponName,
  DATA, KILLS_ATTRIBUTE, INSIDE_ATTRIBUTE, OVERLAY_HUD_UID,
  get api() { return api; },
  get core() { return core; },
};
