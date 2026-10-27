/**
 * Total Recall (https://oldschool.runescape.wiki/w/Total_Recall_(Raging_Echoes_League)), Raging
 * Echoes' tier 6 relic: the Crystal of Echoes' Save-memory keeps one place with the Hitpoints
 * (up to 127, as live stored them), Prayer and special attack energy of the moment; Teleport-back
 * returns there from any Wilderness level, in unlocked areas, and sets those three back;
 * Check-memories says what is kept (the wording is ours). No cooldown; the memory outlasts death.
 * Not in an instance (Wiki), nor underwater at Fossil Island.
 */
const Common = require("./Common.LeagueRelics");
const Teleports = require("./Teleports.LeagueRelics");

const MEMORY_ATTRIBUTE = "league:total-recall";
const KEY = "crystal-of-echoes";
/** Live stored Hitpoints in 7 bits (Wiki). */
const HITPOINTS_CAP = 127;
/** Fossil Island's underwater area (plugins/areas/data/fossil-island-underwater.json). */
const UNDERWATER = { minX: 3712, maxX: 3839, minY: 10240, maxY: 10367, z: 1 };

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function underwater(location) {
  return location.getZ() === UNDERWATER.z && location.getX() >= UNDERWATER.minX && location.getX() <= UNDERWATER.maxX
    && location.getY() >= UNDERWATER.minY && location.getY() <= UNDERWATER.maxY;
}

function save(player) {
  const at = player.getLocation();
  if (player.getPrivateArea?.() || underwater(at)) {
    player.sendMessage(Common.message("recallCannotSave"));
    return;
  }
  player.setAttribute(MEMORY_ATTRIBUTE, {
    x: at.getX(), y: at.getY(), z: at.getZ(),
    hitpoints: Math.min(HITPOINTS_CAP, player.getHitpoints()),
    prayer: player.getSkillManager().getCurrentLevel(core.Skill.PRAYER),
    special: player.getSpecialPercentage(),
  });
  player.sendMessage(Common.message("recallSaved"));
}

function memory(player) {
  const saved = player.getAttribute(MEMORY_ATTRIBUTE);
  return saved && Number.isInteger(saved.x) ? saved : null;
}

function teleportBack(player) {
  const saved = memory(player);
  if (!saved) {
    player.sendMessage(Common.message("recallNothing"));
    return;
  }
  const location = new core.Location(saved.x, saved.y, saved.z);
  Teleports.go(player, KEY, { label: "Memory", location }, {
    onArrival: () => {
      player.getSkillManager().setCurrentLevel(core.Skill.HITPOINTS, Math.max(1, saved.hitpoints), true);
      player.getSkillManager().setCurrentLevel(core.Skill.PRAYER, saved.prayer, true);
      player.setSpecialPercentage(saved.special);
      core.CombatSpecial.updateBar(player);
    },
  });
}

function check(player) {
  const saved = memory(player);
  if (!saved) {
    player.sendMessage(Common.message("recallNothing"));
    return;
  }
  player.sendMessage(Common.message("recallMemory", { ...saved }));
}

/** An option's handler for the relic's owner; anyone else's click goes on to the game's own (false). */
function only(fn) {
  return (event) => {
    if (!active(event.player)) return false;
    event.handled = true;
    fn(event.player);
  };
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.totalRecall;
  api.persistAttribute(MEMORY_ATTRIBUTE, null);
  api.persistAttribute(Teleports.lastAttribute(KEY), null);
  api.onItemAction(effect.toolName, {
    "Save-memory": only(save),
    "Teleport-back": only(teleportBack),
    "Check-memories": only(check),
  });
};

module.exports.MEMORY_ATTRIBUTE = MEMORY_ATTRIBUTE;
