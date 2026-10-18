/**
 * What the rat bone weapon units share: the weapons and what they're made from, and which
 * monsters count as rats (Wiki: Rat bone weapons, Rat (attribute)). Facts in docs/scurrius.md.
 */
const fs = require("fs");
const path = require("path");

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "rat-bone-weapons.json"), "utf8"));
const RAT_NAMES = new Set(DATA.ratNames);

/** Wiki: +10 to the maximum hit against rats. */
const RAT_MAX_HIT_BONUS = 10;
const ONLY_RATS_MESSAGE = "You can only use this weapon against rats.";

let api = null;
let core = null;
let weapons = null;

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  const I = core.ItemIdentifiers;
  const { Skill } = core;
  /**
   * Each weapon, what it is made from and how (Wiki; captured animations and messages).
   * `tool` is the tool the player's own creation needs; Aldo needs none.
   */
  weapons = Object.freeze([
    Object.freeze({
      key: "mace", id: I.BONE_MACE, name: "Bone mace", base: I.RUNE_MACE, baseName: "Rune mace",
      skill: Skill.SMITHING, skillName: "Smithing", tool: I.HAMMER, toolName: "hammer", anim: 898,
    }),
    Object.freeze({
      key: "shortbow", id: I.BONE_SHORTBOW, name: "Bone shortbow", base: I.YEW_SHORTBOW, baseName: "Yew shortbow",
      skill: Skill.FLETCHING, skillName: "Fletching", tool: I.KNIFE, toolName: "Knife", anim: 6682,
    }),
    Object.freeze({
      key: "staff", id: I.BONE_STAFF, name: "Bone staff", base: I.BATTLESTAFF, baseName: "Battlestaff",
      skill: Skill.CRAFTING, skillName: "Crafting", tool: I.CHISEL, toolName: "Chisel", anim: 7531, gfx: 2637, sound: 2585,
      chaosRunes: 1000,
    }),
  ]);
}

function weaponIds() {
  return new Set(weapons.map((weapon) => weapon.id));
}

function wielded(player) {
  return player?.getEquipment?.()?.getItems?.()[core.Equipment.WEAPON_SLOT] ?? null;
}

function wieldsRatBone(player) {
  const id = wielded(player)?.getId?.();
  return id != null && weaponIds().has(id);
}

/** The Wiki's rat attribute: a future monster dump's "rat", or one of its listed names. */
function isRat(npc) {
  if (!npc?.isNpc?.()) return false;
  const definition = npc.getCurrentDefinition?.() ?? npc.getDefinition?.();
  if (definition?.hasAttribute?.("rat")) return true;
  return RAT_NAMES.has(definition?.getName?.());
}

module.exports = {
  RAT_MAX_HIT_BONUS, ONLY_RATS_MESSAGE, RAT_NAMES,
  init, weaponIds, wielded, wieldsRatBone, isRat,
  get weapons() { return weapons; },
  get api() { return api; },
  get core() { return core; },
};
