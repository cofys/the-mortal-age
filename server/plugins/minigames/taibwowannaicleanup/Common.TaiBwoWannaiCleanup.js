/**
 * Tai Bwo Wannai Cleanup: what the units share - the plugin api, the data from
 * plugins/minigames/data/tai-bwo-wannai-cleanup.json with its gameval names resolved from the cache,
 * the saved state, the machete and the chat helpers.
 */
const fs = require("fs");
const path = require("path");

/** Saved per player (the varbits are sent from them at login). */
const ATTR = Object.freeze({
  POINTS: "tai-bwo-wannai-cleanup:points",
  MAX: "tai-bwo-wannai-cleanup:max-points",
  PROGRESS: "tai-bwo-wannai-cleanup:progress",
  /** Murcaily's "First time after hacking away at jungle..." has been said. */
  HACK_TOLD: "tai-bwo-wannai-cleanup:hack-told",
  /** Each villager's stick cooldown (their chat_ varbit), by villager name. */
  COOLDOWNS: "tai-bwo-wannai-cleanup:cooldowns",
  /** The overlay is up (not saved: it is reopened from the area at login). */
  OVERLAY: "tai-bwo-wannai-cleanup:overlay",
});

let api = null;
let core = null;
let data = null;

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "tai-bwo-wannai-cleanup.json"), "utf8"));
}

const cache = () => core.CacheDefinitions;
const locId = (name) => cache().getLocId(name) ?? -1;
const objId = (name) => cache().getObjId(name) ?? -1;
const seqId = (name) => cache().getSeqId(data.seqs[name] ?? name) ?? -1;

/** Runs `action` `ticks` ticks from now (at least one), unless `player` has logged out; walking doesn't cancel it. */
function later(player, ticks, action) {
  const { Task, TaskManager } = core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(Math.max(1, ticks), null, false);
    }
    execute() {
      this.stop();
      if (player.isRegistered()) action();
    }
  })());
}

/** Runs `action` `ticks` ticks from now (at least one), whoever is logged in. */
function afterTicks(ticks, action) {
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

function varbit(player, name, value) {
  player.getPacketSender().sendVarbit(cache().getVarbitId(data.varbits[name] ?? name), value);
}

function animate(player, name, delay = 0) {
  const id = seqId(name);
  if (id >= 0) player.performAnimation(new core.Animation(id, delay));
}

function sound(player, id, delay = 0) {
  player.getPacketSender().sendSound(id, 1, delay);
}

function message(name, values = {}) {
  return String(data.messages[name]).replace(/\{(\w+)\}/g, (_, field) => String(values[field] ?? ""));
}

function spam(player, text) {
  player.getPacketSender().sendTypedMessage(core.ChatType.SPAM, text);
}

function statement(player, text) {
  const { DialogueChainBuilder, EndDialogue, StatementDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, text), new EndDialogue(1)));
}

const level = (player, skill) => player.getSkillManager().getCurrentLevel(core.Skill[skill]);

function xp(player, skill, amount) {
  if (amount > 0) player.getSkillManager().addExperience(core.Skill[skill], amount);
}

/** The wielded machete's data entry, or null. */
function wieldedMachete(player) {
  const weapon = player.getEquipment().getItems()[core.Equipment.WEAPON_SLOT];
  const id = weapon ? weapon.getId() : -1;
  return data.machetes.find((machete) => objId(machete.item) === id) ?? null;
}

/** Any machete, wielded or carried. */
function hasMachete(player) {
  return wieldedMachete(player) !== null || data.machetes.some((machete) => player.getInventory().contains(objId(machete.item)));
}

function questComplete(player) {
  const request = { player, key: data.quest };
  api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

/** Each unit's stop for its own action (hacking, repairing): starting one ends the others. */
const stops = [];

function onStop(stop) {
  stops.push(stop);
}

function stopActions(player) {
  for (const stop of stops) stop(player);
}

/**
 * "level-up:popup-opened" holds a session until the pop-up is continued (SkillLevelUp), as
 * Woodcutting's is; with no pause offered it ends.
 */
function pauseOnLevelUp(event, sessions, stop) {
  const { player } = event;
  const session = sessions.get(player);
  if (!session) return;
  if (!event.pause) return stop(player);
  session.paused = true;
  event.pause(session, () => {
    if (sessions.get(player) === session) session.paused = false;
  }, () => {
    if (sessions.get(player) === session) stop(player);
  });
}

/** Whether a session should end this tick: logged out, dead, walked or teleported off. */
function interrupted(player, location) {
  if (!player.isRegistered() || player.getHitpoints?.() <= 0) return true;
  if (player.getMovementQueue()?.size?.() > 0) return true;
  return !player.getLocation().isWithinInteractionDistance(location);
}

const progress = (player) => Number(player.getAttribute(ATTR.PROGRESS)) || 0;

/** Moves the progress on to `stage` (never back). */
function advance(player, stage) {
  if (progress(player) >= stage) return;
  player.setAttribute(ATTR.PROGRESS, stage);
  varbit(player, "progress", stage);
}

module.exports = {
  init, ATTR, later, afterTicks, varbit, animate, sound, message, spam, statement, level, xp, locId, objId, seqId,
  wieldedMachete, hasMachete, questComplete, progress, advance, onStop, stopActions, pauseOnLevelUp, interrupted,
  get api() { return api; },
  get core() { return core; },
  get data() { return data; },
};
