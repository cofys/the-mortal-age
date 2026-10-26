/**
 * Recharge Dragonstone, the level 89 Lunar spell (Wiki): it "recharges any amulet of glory,
 * combat bracelet, and skills necklace with 4 charges", the latter two only after Legends'
 * Quest, across the whole inventory. It can't charge the ring of wealth, and casting it needs
 * the hard Fremennik Diary. The spell has no target: rsprox 4119 casts it straight from the
 * spellbook (op 1, Cast) and gets "You do not have enough Soul Runes to cast this spell.".
 */
const { JEWELLERY } = require("./Teleports.Jewellery");
const QuestRuntime = require("../quests/QuestRuntime");

const SPELL_NAME = "recharge dragonstone";
const LEVEL = 89;
const EXPERIENCE = 97.5;
const RUNES = [["WATER_RUNE", 4], ["ASTRAL_RUNE", 1], ["SOUL_RUNE", 1]];
const CHARGES = 4;
const LUNAR_DEFENCE_LEVEL = 40;
// The presentation every other Lunar spell here uses; the capture has no successful cast.
const CAST_ANIMATION = 4413;
const CAST_GRAPHIC = 747;
// Guessed wording: no capture or Wiki text for these refusals.
const DIARY_MESSAGE = "You need to complete the hard Fremennik Diary to cast this spell.";
const NOTHING_MESSAGE = "You have no dragonstone jewellery that this spell can recharge.";

/** itemId -> piece, for every charged or spent id the spell can recharge. */
const RECHARGEABLE = new Map();
for (const piece of JEWELLERY) {
  if (!piece.recharge) continue;
  for (const [itemId, charges] of piece.charged) {
    if (charges < CHARGES) RECHARGEABLE.set(itemId, piece);
  }
  RECHARGEABLE.set(piece.spent, piece);
}

const spells = new WeakMap();

function spellFor(core) {
  if (spells.has(core)) return spells.get(core);
  const widget = core.CacheDefinitions.getSpellByName(SPELL_NAME);
  if (!widget) throw new Error(`Missing cache spell: ${SPELL_NAME}`);
  class RechargeDragonstone extends core.Spell {
    constructor() { super(); this.members = true; }
    spellId() { return widget.widgetId; }
    levelRequired() { return LEVEL; }
    baseExperience() { return EXPERIENCE; }
    itemsRequired() { return RUNES.map(([key, amount]) => new core.Item(core.ItemIdentifiers[key], amount)); }
    equipmentRequired() { return []; }
    startCast() {}
    getSpellbook() { return core.MagicSpellbook.LUNAR; }
  }
  const spell = new RechargeDragonstone();
  spells.set(core, spell);
  return spell;
}

function questComplete(player, name) {
  return QuestRuntime.getRegisteredQuests().find((quest) => quest.name === name)?.isComplete(player) ?? false;
}

/** The inventory items the spell would recharge: glories always, the others after their quest. */
function rechargeableItems(player) {
  return player.getInventory().getItems().filter((item) => {
    const piece = item ? RECHARGEABLE.get(item.getId()) : null;
    return piece && (!piece.recharge.spellNeedsQuest || questComplete(player, piece.recharge.quest));
  });
}

function fremennikHardComplete(api, player) {
  const request = { player, diary: "fremennik", tier: "hard", complete: false };
  api.emitCustomEvent("diary:is-complete", request);
  return request.complete === true;
}

function castRechargeDragonstone(api, event) {
  if (event.handled || event.spellName?.trim().toLowerCase() !== SPELL_NAME) return;
  if (event.opId != null && event.opId !== 1) return;
  event.handled = true;
  const { core } = api;
  const { player } = event;
  if (player.getSkillManager().getMaxLevel(core.Skill.DEFENCE) < LUNAR_DEFENCE_LEVEL) {
    player.sendMessage("You need at least level 40 Defence to cast Lunar spells.");
    return;
  }
  const spell = spellFor(core);
  if (!spell.canCast(player, false)) return;
  if (!fremennikHardComplete(api, player)) {
    player.sendMessage(DIARY_MESSAGE);
    return;
  }
  const items = rechargeableItems(player);
  if (items.length === 0) {
    player.sendMessage(NOTHING_MESSAGE);
    return;
  }
  if (!spell.canCast(player, true)) return;
  player.performAnimation(new core.Animation(CAST_ANIMATION));
  player.performGraphic(new core.Graphic(CAST_GRAPHIC));
  for (const item of items) {
    const piece = RECHARGEABLE.get(item.getId());
    item.setId(piece.charged.find(([, charges]) => charges === CHARGES)[0]);
  }
  player.getInventory().refreshItems();
  player.getSkillManager().addExperiences(core.Skill.MAGIC, EXPERIENCE);
}

module.exports = { castRechargeDragonstone, RECHARGEABLE };
