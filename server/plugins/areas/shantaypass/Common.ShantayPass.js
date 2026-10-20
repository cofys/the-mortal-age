/**
 * What the Shantay Pass units share: the plugin api, tick-delayed actions, forced steps and the
 * attributes that say where a player stands with Shantay.
 */

/** Set once Shantay has introduced himself ("Hello effendi, I am Shantay."). */
const MET_ATTRIBUTE = "shantay-pass:met";
/** In Shantay's cell until the fine is paid. */
const JAILED_ATTRIBUTE = "shantay-pass:jailed";
/** Got out of a jail without paying (Shantay's or Port Sarim's): Shantay no longer chats. */
const ESCAPED_ATTRIBUTE = "shantay-pass:escaped";

const SHANTAY = 4642;
const FINE = 5;

let api;
let core;

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  api.persistAttribute(MET_ATTRIBUTE, false);
  api.persistAttribute(JAILED_ATTRIBUTE, false);
  api.persistAttribute(ESCAPED_ATTRIBUTE, false);
}

const getApi = () => api;
const getCore = () => core;

/** Runs `action` after `ticks` ticks, unless the player has gone by then. */
function later(player, ticks, action) {
  core.TaskManager.submit(new (class extends core.Task {
    constructor() {
      super(ticks, false);
    }

    execute() {
      this.stop();
      if (player.isRegistered?.() === false) return;
      action();
    }
  })());
}

/** A forced walking step onto `[x, y]`, as live moves a player through a gate or a cell door. */
function step(player, [x, y]) {
  const at = player.getLocation();
  const dx = Math.sign(x - at.getX());
  const dy = Math.sign(y - at.getY());
  if (dx === 0 && dy === 0) return;
  player.setLocation(new core.Location(at.getX() + dx, at.getY() + dy, at.getZ()));
  player.setWalkingDirection(core.Direction.fromDeltas(dx, dy));
  player.getMovementQueue().handleRegionChange();
}

function tile(x, y, z = 0) {
  return new core.Location(x, y, z);
}

function coins(player) {
  return player.getInventory().getAmount(core.ItemIdentifiers.COINS);
}

function bankedCoins(player) {
  return player.getBanks()
    .filter((bank, tab) => bank && tab !== core.Bank.BANK_SEARCH_TAB_INDEX)
    .reduce((sum, bank) => sum + bank.getAmount(core.ItemIdentifiers.COINS), 0);
}

function questComplete(player, key) {
  const request = { player, key, complete: null };
  api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

function questStarted(player, key) {
  const request = { player, key, started: null };
  api.emitCustomEvent("quest:is-started", request);
  return request.started === true;
}

function diaryComplete(player, tier) {
  const request = { player, diary: "desert", tier, complete: null };
  api.emitCustomEvent("diary:is-complete", request);
  return request.complete === true;
}

function isUltimateIronman(player) {
  const query = { player, mode: "none" };
  api.emitCustomEvent("ironman:mode", query);
  return query.mode === "ultimate";
}

/** A one-off chat line from an NPC, ending the conversation. */
function npcLine(player, npcId, text) {
  const { DialogueChainBuilder, NpcDialogue, EndDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new NpcDialogue(0, npcId, text),
    new EndDialogue(1),
  ));
}

/** Plays one variant of Shantay's transcript (npc-dialogues.json) outside Talk-to. */
function shantaySays(player, variant, npc = null) {
  api.emitCustomEvent("npc-dialogue:start", { player, npc, npcId: SHANTAY, variant });
}

module.exports = {
  MET_ATTRIBUTE,
  JAILED_ATTRIBUTE,
  ESCAPED_ATTRIBUTE,
  SHANTAY,
  FINE,
  init,
  getApi,
  getCore,
  later,
  step,
  tile,
  coins,
  bankedCoins,
  questComplete,
  questStarted,
  diaryComplete,
  isUltimateIronman,
  npcLine,
  shantaySays,
};
