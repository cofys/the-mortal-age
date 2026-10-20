"use strict";

const {
  Animation, CacheDefinitions, DialogueChainBuilder, Item, ItemIdentifiers, ItemStatementDialogue, MagicSpellbook,
  PluginManager, Skill, Sound, Sounds, Spell, Task, TaskManager,
} = require("./Core.Construction");
const Ids = require("./Ids.Construction");
const House = require("./House.Construction");
const LECTERN_DATA = require("./data/lectern.json");

// rsprox captures: Study opens teletabs_craft_if after setting teletab_enum (the lectern's tablet
// list) and makexcrafting (the quantity). A tab click sets tablet_to_make (the tab's 1-based
// slot); confirm closes the interface and makes one tablet every 4 ticks, the animation and
// sound on the first tick and the tablet the tick after.
const TELETABS_INTERFACE = Ids.iface("teletabs_craft_if");
const MAKE_BUTTONS = { 5: 1, 6: 5, 7: 10 };
const MAKE_X = 8;
const MAKE_ALL = 9;
const CONFIRM = 14;
const FIRST_TAB = 19;
const LAST_TAB = 39;
const TELETAB_ENUM_VARP = Ids.varp("teletab_enum");
const MAKE_AMOUNT_VARP = Ids.varp("makexcrafting");
const TABLET_VARBIT = Ids.varbit("tablet_to_make");
const CREATE_ANIMATION = Ids.seq("poh_create_magic_tablet");
const CREATE_SOUND = new Sound(228, 1, 0, 0);
const INTERVAL_TICKS = 4;
const NO_CLAY = "You need some soft clay to use this lectern.";
const TABLET_ATTRIBUTE = "construction:lectern-tablet";
const AMOUNT_ATTRIBUTE = "construction:lectern-amount";

const TABLETS = new Map(Object.entries(LECTERN_DATA.tablets).map(([id, tablet]) => [Number(id), {
  ...tablet,
  runes: tablet.runes.map(([name, amount]) => [ItemIdentifiers[name], amount]),
}]));
const openLecterns = new WeakMap();

function lecternAt(event) {
  const house = House.houseFor(event.player);
  const furniture = house?.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
  const enumId = furniture && LECTERN_DATA.lecterns[furniture.buildableKey];
  return enumId ? { enumId, tablets: [...CacheDefinitions.getEnumValues(enumId).values()] } : null;
}

/** The runes a tablet still needs from the inventory or a rune pouch once staves are counted. */
function runesNeeded(player, tablet, count) {
  return tablet.runes
    .filter(([id]) => PluginManager.emitSpellRuneBypass(player, MagicSpellbook.NORMAL, -1, id) !== true)
    .map(([id, amount]) => ({ id, amount: amount * count }));
}

function hasRunes(player, tablet, count) {
  const shortfall = Spell.inventoryShortfall(player, runesNeeded(player, tablet, count).map(({ id, amount }) => new Item(id, amount)));
  return shortfall.length === 0 || PluginManager.checkSpellRuneSource(player, shortfall);
}

function takeRunes(player, tablet) {
  const runes = runesNeeded(player, tablet, 1).map(({ id, amount }) => new Item(id, amount));
  const shortfall = Spell.inventoryShortfall(player, runes);
  for (const rune of runes) player.getInventory().delete(rune.getId(), Math.min(rune.getAmount(), player.getInventory().getAmount(rune.getId())));
  if (shortfall.length) PluginManager.consumeSpellRuneSource(player, shortfall);
}

/** How many of `tablet` the player could make now (soft clay and runes). */
function makeable(player, tablet) {
  let count = player.getInventory().getAmount(ItemIdentifiers.SOFT_CLAY);
  while (count > 0 && !hasRunes(player, tablet, count)) count--;
  return count;
}

function chosenTablet(player, lectern) {
  const slot = player.getPacketSender().getVarbit(TABLET_VARBIT);
  return slot > 0 ? lectern.tablets[slot - 1] ?? null : null;
}

function setAmount(player, amount) {
  player.setAttribute(AMOUNT_ATTRIBUTE, amount);
  player.getPacketSender().sendConfig(MAKE_AMOUNT_VARP, amount);
}

function study(event) {
  const lectern = lecternAt(event);
  if (!lectern) return false;
  const player = event.player;
  const sender = player.getPacketSender();
  sender.sendConfig(TELETAB_ENUM_VARP, lectern.enumId);
  sender.sendVarbit(TABLET_VARBIT, player.getAttribute(TABLET_ATTRIBUTE) ?? 0);
  sender.sendConfig(MAKE_AMOUNT_VARP, player.getAttribute(AMOUNT_ATTRIBUTE) ?? 1);
  sender.sendInterface(TELETABS_INTERFACE);
  openLecterns.set(player, lectern);
  return true;
}

function createLast(event) {
  const lectern = lecternAt(event);
  if (!lectern) return false;
  const player = event.player;
  player.getPacketSender().sendVarbit(TABLET_VARBIT, player.getAttribute(TABLET_ATTRIBUTE) ?? 0);
  startMaking(player, lectern, player.getAttribute(AMOUNT_ATTRIBUTE) ?? 1);
  return true;
}

function startMaking(player, lectern, amount) {
  const itemId = chosenTablet(player, lectern);
  const tablet = TABLETS.get(itemId);
  if (!tablet || amount < 1) return;
  if (!player.getInventory().contains(ItemIdentifiers.SOFT_CLAY)) {
    player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, ItemIdentifiers.SOFT_CLAY, NO_CLAY)));
    return;
  }
  TaskManager.submit(new TabletTask(player, itemId, tablet, amount));
}

/** One tablet every INTERVAL_TICKS; keyed to the player, so their next walk or click stops it. */
class TabletTask extends Task {
  constructor(player, itemId, tablet, amount) {
    super(1, player.getIndex(), true);
    this.player = player;
    this.itemId = itemId;
    this.tablet = tablet;
    this.remaining = amount;
    this.step = 0;
  }

  execute() {
    const { player, tablet } = this;
    if (!player.isRegistered() || !House.houseFor(player)) return this.stop();
    if (this.step % INTERVAL_TICKS === 0) {
      if (!this.canMake()) return this.stop();
      player.performAnimation(new Animation(CREATE_ANIMATION));
      Sounds.sendSound(player, CREATE_SOUND);
    } else if (this.step % INTERVAL_TICKS === 1) {
      if (!this.canMake()) return this.stop();
      player.getInventory().delete(ItemIdentifiers.SOFT_CLAY, 1);
      takeRunes(player, tablet);
      player.getInventory().adds(this.itemId, 1);
      player.getSkillManager().addExperiences(Skill.MAGIC, tablet.experience);
      if (--this.remaining <= 0) return this.stop();
    }
    this.step++;
  }

  canMake() {
    const { player, tablet } = this;
    if (!player.getInventory().contains(ItemIdentifiers.SOFT_CLAY)) {
      player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, ItemIdentifiers.SOFT_CLAY, NO_CLAY)));
      return false;
    }
    if (player.getSkillManager().getCurrentLevel(Skill.MAGIC) < tablet.level) {
      player.sendMessage(`You need a Magic level of ${tablet.level} to make that tablet.`);
      return false;
    }
    if (!hasRunes(player, tablet, 1)) {
      player.sendMessage("You do not have enough runes to make that tablet.");
      return false;
    }
    return true;
  }
}

function interfaceClick(event) {
  if (event.groupId !== TELETABS_INTERFACE) return;
  const player = event.player;
  const lectern = openLecterns.get(player);
  if (!lectern || !House.houseFor(player)) return;
  event.handled = true;
  const child = event.childId;
  if (child >= FIRST_TAB && child <= LAST_TAB && child - FIRST_TAB < lectern.tablets.length) {
    const slot = child - FIRST_TAB + 1;
    player.setAttribute(TABLET_ATTRIBUTE, slot);
    player.getPacketSender().sendVarbit(TABLET_VARBIT, slot);
  } else if (MAKE_BUTTONS[child]) {
    setAmount(player, MAKE_BUTTONS[child]);
  } else if (child === MAKE_ALL || child === MAKE_X) {
    const tablet = TABLETS.get(chosenTablet(player, lectern));
    const most = tablet ? Math.max(1, makeable(player, tablet)) : 1;
    if (child === MAKE_ALL) return setAmount(player, most);
    player.getPacketSender().sendConfig(MAKE_AMOUNT_VARP, 0).sendEnterAmountPrompt(`Enter amount: (1-${most})`);
    player.setEnteredAmountAction({ execute: amount => setAmount(player, Math.max(1, Math.min(most, amount))) });
  } else if (child === CONFIRM) {
    openLecterns.delete(player);
    player.getPacketSender().sendInterfaceRemoval();
    startMaking(player, lectern, player.getAttribute(AMOUNT_ATTRIBUTE) ?? 1);
  }
}

function closeLectern({ player }) {
  openLecterns.delete(player);
}

function attachLecterns(api) {
  api.persistAttribute(TABLET_ATTRIBUTE, 0);
  api.persistAttribute(AMOUNT_ATTRIBUTE, 1);
  api.onObjectInteraction("Lectern", { Study: study, "Create-last": createLast });
  api.onInterfaceActionClick(interfaceClick);
  api.onCustomEvent("interface:close", closeLectern);
}

Object.assign(module.exports, { attachLecterns });
