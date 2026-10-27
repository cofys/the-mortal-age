/**
 * Lumberjack (https://oldschool.runescape.wiki/w/Lumberjack_(Raging_Echoes_League)), Raging
 * Echoes' tier 1 relic: the Echo axe (a crystal axe with no requirement, in Woodcutting's own
 * table), a failed chop's second 50% chance, logs straight to the bank, the axe's toggles (logs
 * burnt for their Firemaking XP, the default, or fletched into arrow shafts for the Fletching XP,
 * whatever the level), and fires that never fail to light.
 */
const Common = require("./Common.LeagueRelics");
const EchoTool = require("./EchoTool.LeagueRelics");

let api;
let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

/** The axe's effects need the axe, carried or wielded (Wiki); the sure fires do not. */
function withTool(player) {
  return active(player) && EchoTool.holdsTool(core, player, effect);
}

function secondChance(request) {
  if (!request.success && withTool(request.player) && Math.random() < effect.secondChance) request.success = true;
}

/** A chopped log is burnt, fletched into shafts for the bank, or banked as it is. */
function gather(request) {
  const { player, itemId, amount } = request;
  if (request.stored >= amount || request.skill !== core.Skill.WOODCUTTING || !withTool(player)) return;
  const logs = amount - request.stored;
  const current = EchoTool.mode(player, effect);
  if (current === "burn") {
    const fire = { logId: itemId, xp: null };
    api.emitCustomEvent("firemaking:log-xp", fire);
    if (fire.xp > 0) {
      player.getSkillManager().addExperiences(core.Skill.FIREMAKING, fire.xp * logs);
      request.stored = amount;
      return;
    }
  }
  if (current === "fletch") {
    const shafts = { logId: itemId, itemId: null, amount: 0, xp: null };
    api.emitCustomEvent("fletching:shafts", shafts);
    if (shafts.itemId && Common.bank(player, shafts.itemId, shafts.amount * logs)) {
      player.getSkillManager().addExperiences(core.Skill.FLETCHING, shafts.xp * logs);
      request.stored = amount;
      return;
    }
  }
  if (Common.bank(player, itemId, logs)) request.stored = amount;
}

/** Woodcutting's room (`storage:room` for Woodcutting only): burnt logs need none; fletched ones the shafts' or the logs'. */
function room(request) {
  const { player, itemId } = request;
  if (request.room || request.skill !== core.Skill.WOODCUTTING || !withTool(player)) return;
  const current = EchoTool.mode(player, effect);
  if (current === "burn") {
    const fire = { logId: itemId, xp: null };
    api.emitCustomEvent("firemaking:log-xp", fire);
    if (fire.xp > 0) {
      request.room = true;
      return;
    }
  }
  if (current === "fletch") {
    const shafts = { logId: itemId, itemId: null, amount: 0, xp: null };
    api.emitCustomEvent("fletching:shafts", shafts);
    if (shafts.itemId && Common.bankHasRoom(player, shafts.itemId)) {
      request.room = true;
      return;
    }
  }
  if (Common.bankHasRoom(player, itemId)) request.room = true;
}

function lights(request) {
  if (active(request.player)) request.success = true;
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  effect = Common.data.effects.lumberjack;
  EchoTool.attach(api, effect);
  api.onCustomEvent("woodcutting:attempt", secondChance);
  api.onCustomEvent("storage:gather", gather);
  api.onCustomEvent("storage:room", room);
  api.onCustomEvent("firemaking:light-roll", lights);
};
