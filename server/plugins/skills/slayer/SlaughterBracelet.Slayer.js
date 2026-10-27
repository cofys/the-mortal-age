"use strict";

/** Shared player charges, not item metadata (Wiki: Bracelet of slaughter; docs/slayer.md). */
const CHARGES_ATTRIBUTE = "slayer:slaughter-charges";
const MAX_CHARGES = 30;
const ACTIVATION_CHANCE = 0.25;
const REGENERATION_CHANCE = 0.1;
const EXCLUDED_MONSTERS = new Set(["TzTok-Jad", "TzKal-Zuk"]);
const ACTIVATION_MESSAGE = "Your bracelet of slaughter prevents your slayer count from decreasing.";

let api = null;
let core = null;

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
}

function charges(player) {
  const saved = player.getAttribute(CHARGES_ATTRIBUTE);
  return Number.isInteger(saved) && saved > 0 && saved <= MAX_CHARGES ? saved : MAX_CHARGES;
}

/** 21184 and 21185 share the name, but the cache makes them the note and bank placeholder: neither is worn or used. */
function isBracelet(item) {
  return item?.getId() === core.ItemIdentifiers.BRACELET_OF_SLAUGHTER;
}

/** Called for an eligible task kill, after its Slayer XP, at the point the count would fall. */
function preventsDecrement(player, npc, random = Math.random) {
  const equipment = player.getEquipment();
  if (!isBracelet(equipment.getItems()[core.Equipment.HANDS_SLOT])) return false;
  const name = (npc.getCurrentDefinition?.() ?? npc.getDefinition()).getName();
  if (EXCLUDED_MONSTERS.has(name)) return false;
  // Content may change how often the bracelet works and whether it uses a charge ("slayer:bracelet", a league relic).
  const proc = { player, npc, bracelet: "slaughter", chance: ACTIVATION_CHANCE, consumeCharge: true };
  api.emitCustomEvent("slayer:bracelet", proc);
  if (random() >= (Number.isFinite(proc.chance) ? proc.chance : ACTIVATION_CHANCE)) return false;
  if (proc.consumeCharge === false) {
    player.getPacketSender().sendTypedMessage(core.ChatType.SPAM, ACTIVATION_MESSAGE);
    return true;
  }

  const remaining = charges(player) - 1;
  player.setAttribute(CHARGES_ATTRIBUTE, remaining || MAX_CHARGES);
  let suffix;
  if (remaining > 0) {
    suffix = `It has ${remaining} charge${remaining === 1 ? "" : "s"} left.`;
  } else {
    // Wiki (Bracelet of slaughter; Combat Achievements, Elite rewards): the claimed elite rewards
    // add a 10% chance to fully recharge instead of breaking. The wording is uncaptured.
    const reward = { player, tier: "Elite", claimed: false };
    api.emitCustomEvent("combat-achievements:tier", reward);
    if (reward.claimed && random() < REGENERATION_CHANCE) {
      suffix = "It then regenerates itself to full charge!";
    } else {
      equipment.set(core.Equipment.HANDS_SLOT, new core.Item(-1));
      equipment.refreshItems();
      suffix = "It then crumbles to dust.";
    }
  }
  // The supplied live capture sends this as message_game type=spam.
  player.getPacketSender().sendTypedMessage(core.ChatType.SPAM, `${ACTIVATION_MESSAGE} ${suffix}`);
  return true;
}

function check({ player, item }) {
  if (!isBracelet(item)) return false;
  const remaining = charges(player);
  player.sendMessage(`Your bracelet of slaughter has ${remaining} charge${remaining === 1 ? "" : "s"} left.`);
}

function breakBracelet({ player, item, slot, interfaceId }) {
  if (!isBracelet(item) || interfaceId === core.Equipment.INVENTORY_INTERFACE_ID) return false;
  const inventory = player.getInventory();
  if (!isBracelet(inventory.get(slot))) return false;
  inventory.deleteAtSlot(slot, 1);
  player.setAttribute(CHARGES_ATTRIBUTE, MAX_CHARGES);
  player.sendMessage(`You break the bracelet of slaughter. Your next bracelet will start with ${MAX_CHARGES} charges.`);
}

function attach(pluginApi) {
  pluginApi.persistAttribute(CHARGES_ATTRIBUTE, MAX_CHARGES);
  pluginApi.onItemAction("Bracelet of slaughter", { Check: check, Break: breakBracelet });
}

module.exports = { init, attach, preventsDecrement, charges, CHARGES_ATTRIBUTE };
