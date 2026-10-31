/**
 * Barbarian Assault reward hooks.
 *
 * The Pet Penance Queen (12703) is not a Queen drop: OSRS gives it from a high-level
 * gamble at Commander Connad, after the player has killed the Queen and paid 500
 * honour points, at 1/1000 (Wiki: Barbarian Assault/Gambles, Pet Penance Queen).
 *
 * The wave/role game itself is still tracked by issue #153. This plugin owns the
 * reward side so BA content can pay honour points and call the high gamble without
 * inventing a second pet source:
 *   api.emitCustomEvent("barbarian-assault:honour", { player, points })
 *   api.emitCustomEvent("barbarian-assault:queen-kill", { player })
 *   api.emitCustomEvent("barbarian-assault:gamble-high", { player, handled: false })
 * The Queen's own death sets the kill flag and pays its 80 honour points.
 */
const HONOUR_ATTRIBUTE = "barbarian-assault:honour";
const QUEEN_KILL_ATTRIBUTE = "barbarian-assault:queen-killed";
const HIGH_GAMBLE_COUNT_ATTRIBUTE = "barbarian-assault:high-gambles";
const HIGH_GAMBLE_COST = 500;
const QUEEN_KILL_HONOUR = 80;
const PENANCE_PET_ITEM_ID = 12703;
const PET_CHANCE = 1 / 1000;

/** The generated Commander Connad transcript stores the three gamble results by these step ids. */
const HIGH_GAMBLE_STEPS = new Set(["nlmkHE", "_is7KI", "WwL0Zn"]);

let api = null;
let queenId = null;
let commanderId = null;

const honourOf = (player) => Math.max(0, Math.trunc(Number(player?.getAttribute?.(HONOUR_ATTRIBUTE)) || 0));

function setHonour(player, value) {
  player?.setAttribute?.(HONOUR_ATTRIBUTE, Math.max(0, Math.trunc(value)));
}

const queenKilled = (player) => player?.getAttribute?.(QUEEN_KILL_ATTRIBUTE) === true;

function setQueenKilled(player, value) {
  player?.setAttribute?.(QUEEN_KILL_ATTRIBUTE, value === true);
}

function addHonour(request) {
  const player = request?.player;
  const points = Number(request?.points ?? request?.amount);
  if (!player || !Number.isFinite(points) || points <= 0) return;
  setHonour(player, honourOf(player) + Math.trunc(points));
}

function recordQueenKill(player) {
  if (!player) return false;
  setQueenKilled(player, true);
  setHonour(player, honourOf(player) + QUEEN_KILL_HONOUR);
  return true;
}

function queenDied({ npc, killer }) {
  if (!killer || npc?.getId?.() !== queenId) return;
  recordQueenKill(killer);
}

function queenKillRequest(request) {
  if (!request || request.handled) return;
  recordQueenKill(request.player);
  request.handled = true;
}

/**
 * One high-level gamble. The caller (the Queen's completion, or a future BA dialogue)
 * owns the other gamble loot; this only rolls the pet. Returns why it was refused, or
 * `{ allowed: true, pet, awarded }` after the roll.
 */
function highGamble(player, random = Math.random) {
  if (!player) return { allowed: false, reason: "player", pet: false, awarded: false };
  if (!queenKilled(player)) {
    player.sendMessage?.("You need to defeat the Penance Queen before you can take a high gamble, soldier.");
    return { allowed: false, reason: "queen", pet: false, awarded: false };
  }
  const honour = honourOf(player);
  if (honour < HIGH_GAMBLE_COST) {
    player.sendMessage?.(`You need ${HIGH_GAMBLE_COST} Honour Points for a high gamble.`);
    return { allowed: false, reason: "points", pet: false, awarded: false };
  }

  setHonour(player, honour - HIGH_GAMBLE_COST);
  player.setAttribute?.(
    HIGH_GAMBLE_COUNT_ATTRIBUTE,
    Math.max(0, Math.trunc(Number(player.getAttribute?.(HIGH_GAMBLE_COUNT_ATTRIBUTE)) || 0)) + 1,
  );

  const won = random() < PET_CHANCE;
  const request = {
    player,
    itemId: PENANCE_PET_ITEM_ID,
    source: "barbarian-assault:high-gamble",
    awarded: false,
  };
  if (won) api.emitCustomEvent("pets:award", request);
  return { allowed: true, pet: won, awarded: request.awarded === true };
}

function highGambleRequest(request) {
  if (!request || request.handled) return;
  request.result = highGamble(request.player);
  request.handled = true;
}

function highGambleDialogue(request) {
  if (!request || request.npcId !== commanderId || !HIGH_GAMBLE_STEPS.has(request.stepId)) return;
  request.handled = true;
  request.end = true;
  highGamble(request.player);
}

function highGambleOption(event) {
  if (!event || event.handled) return;
  highGamble(event.player);
  event.handled = true;
}

function attach(pluginApi) {
  api = pluginApi;
  queenId = pluginApi.core.NpcIdentifiers.PENANCE_QUEEN;
  commanderId = pluginApi.core.NpcIdentifiers.COMMANDER_CONNAD;
  pluginApi.persistAttribute(HONOUR_ATTRIBUTE, 0);
  pluginApi.persistAttribute(QUEEN_KILL_ATTRIBUTE, false);
  pluginApi.persistAttribute(HIGH_GAMBLE_COUNT_ATTRIBUTE, 0);
}

module.exports = {
  name: "BarbarianAssault",
  members: true,
  register(pluginApi) {
    attach(pluginApi);
    pluginApi.onNpcDeath(queenDied);
    pluginApi.onNpcInteraction("Commander Connad", { Gamble: highGambleOption });
    pluginApi.onCustomEvent("barbarian-assault:honour", addHonour);
    pluginApi.onCustomEvent("barbarian-assault:queen-kill", queenKillRequest);
    pluginApi.onCustomEvent("barbarian-assault:gamble-high", highGambleRequest);
    pluginApi.onCustomEvent("npc-dialogue:action", highGambleDialogue);
  },
  _test: {
    HONOUR_ATTRIBUTE,
    QUEEN_KILL_ATTRIBUTE,
    HIGH_GAMBLE_COUNT_ATTRIBUTE,
    HIGH_GAMBLE_COST,
    QUEEN_KILL_HONOUR,
    PENANCE_PET_ITEM_ID,
    PET_CHANCE,
    highGamble,
    recordQueenKill,
    addHonour,
    honourOf,
    queenKilled,
    queenDied,
  },
};
