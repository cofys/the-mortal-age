"use strict";

const { api, Skill, ItemIdentifiers, ItemDefinition, DialogueChainBuilder, StatementDialogue } = require("./Core.Construction");
const House = require("./House.Construction");
const WORKSHOP = require("./data/workshop.json");

const TOOL_STORES = new Map(Object.entries(WORKSHOP.toolStores)
  .map(([loc, tools]) => [Number(loc), tools.map(name => ({ id: ItemIdentifiers[name], name }))]));
const CLOCKMAKER = WORKSHOP.clockmaker;
const FURS = CLOCKMAKER.furs;

function say(player, text) {
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, text)));
}

/** A prompt of up to five labelled choices (the chatbox's own limit). */
function choose(player, title, labels, pick) {
  api.sendMultiChatboxPrompt(player, title, ...labels.flatMap(label => [label, () => pick(label)]));
}

// Tool stores: "Select a tool" lists the rack's tools; any number can be taken.
function searchTools(event) {
  const tools = House.houseFor(event.player) && TOOL_STORES.get(event.objectId);
  if (!tools) return false;
  const player = event.player;
  choose(player, "Select a tool", tools.map(tool => ItemDefinition.forId(tool.id).getName()), label => {
    const tool = tools.find(entry => ItemDefinition.forId(entry.id).getName() === label);
    if (!tool) return;
    if (player.getInventory().getFreeSlots() === 0) return player.sendMessage("You don't have enough inventory space.");
    player.getInventory().adds(tool.id, 1);
  });
  return true;
}

// Clockmaker's bench: the bench's menu, then the toy or horsey colour; one product per pick.
function craft(event) {
  const menu = House.houseFor(event.player) && CLOCKMAKER.menus[event.objectId];
  if (!menu) return false;
  openBenchMenu(event.player, menu);
  return true;
}

function openBenchMenu(player, menu) {
  choose(player, "Select an option", menu, label => {
    if (label === "More...") return openBenchMenu(player, CLOCKMAKER.more);
    if (label === "Clockwork toy") return choose(player, "Select a toy", CLOCKMAKER.toys, product => make(player, product));
    if (label === "Toy horsey") return choose(player, "Select a horsey colour", CLOCKMAKER.horseys, product => make(player, product));
    make(player, label);
  });
}

/** The inventory items a product's materials resolve to, or null when one is missing. */
function materialsFor(player, product) {
  const inventory = player.getInventory();
  const items = [];
  for (const [material, amount] of product.materials) {
    const id = material === "FUR" ? FURS.find(fur => inventory.getAmount(fur) >= amount) : material;
    if (id == null || inventory.getAmount(id) < amount) return null;
    items.push([id, amount]);
  }
  return items;
}

function make(player, label) {
  const product = CLOCKMAKER.products[label];
  if (!product || !House.houseFor(player)) return;
  if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < product.level) {
    return say(player, `You need a Crafting level of ${product.level} to make that.`);
  }
  const items = materialsFor(player, product);
  if (!items) return say(player, product.missing);
  for (const [id, amount] of items) player.getInventory().delete(id, amount);
  player.getInventory().adds(product.item, 1);
  player.getSkillManager().addExperiences(Skill.CRAFTING, CLOCKMAKER.experience);
}

// Armour repair stand: Bob's repair, cheaper with Smithing (Wiki: cost x (1 - Smithing / 200)).
function repairAtStand(event) {
  if (event.object?.getDefinition?.()?.getName() !== "Armour repair stand" || !House.houseFor(event.player)) return;
  const smithing = event.player.getSkillManager().getCurrentLevel(Skill.SMITHING);
  api.emitCustomEvent("barrows:repair", { player: event.player, itemId: event.itemId, costMultiplier: 1 - smithing / 200 });
  event.handled = true;
}

function attachWorkshop(api) {
  api.onObjectInteraction("Tools", { Search: searchTools });
  api.onObjectInteraction("Clockmaker's bench", { Craft: craft });
  api.onItemOnObject(repairAtStand, { noted: false });
}

Object.assign(module.exports, { attachWorkshop });
