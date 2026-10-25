"use strict";

/**
 * Corrupted Warriors (OSRS Wiki: Corrupted Warrior (Bounty Hunter) and its transcript).
 *
 * Talk-to plays the imported transcript; this unit picks the crater or Ferox Enclave version,
 * answers its conditions, and fills in the player's minimum coffer deposit and Earning Potential.
 * Using Ancient Warriors' (bh) armour on one swaps it between its regular and corrupted versions.
 */

const Coffer = require("./Coffer.BountyHunter");

const CRATER_VARIANT = "standard-dialogue-daimon-s-crater";
const FEROX_VARIANT = "standard-dialogue-ferox-enclave";
const EP_LINE = "Of course. Your current EP value is [number]%.";

let core;
let pluginApi;
let WARRIOR_IDS;
let FEROX_WARRIOR;
/** Item id -> its regular/corrupted counterpart. */
const counterparts = new Map();

/**
 * Pairs every "Corrupted X (bh)" with "X (bh)" through the cache-generated identifiers, so new
 * charge states come along without a list.
 */
function pairCorruptedArmour(identifiers) {
  for (const [name, corrupted] of Object.entries(identifiers)) {
    const regular = identifiers[name.replace(/^CORRUPTED_/, "")];
    if (!name.startsWith("CORRUPTED_") || !/_BH_/.test(name) || !Number.isInteger(regular)) continue;
    counterparts.set(corrupted, regular).set(regular, corrupted);
  }
}

function selectVariant({ npcId }) {
  if (!WARRIOR_IDS.includes(npcId)) return null;
  return npcId === FEROX_WARRIOR ? FEROX_VARIANT : CRATER_VARIANT;
}

function answerCondition({ npcId, text }) {
  if (!WARRIOR_IDS.includes(npcId)) return null;
  if (text === "If the player is on an official Bounty Hunter world:") return true;
  if (text === "If the player is not on an official Bounty Hunter world:") return false;
  return null;
}

function fillLine(request) {
  if (!WARRIOR_IDS.includes(request.npcId)) return;
  const { player, text } = request;
  if (text.includes("[x]")) {
    request.text = text.replace("[x]", Coffer.playerMinimumDeposit(player).toLocaleString());
  } else if (text === EP_LINE) {
    const query = { player, value: 0 };
    pluginApi.emitCustomEvent("bounty-hunter:earning-potential", query);
    request.text = EP_LINE.replace("[number]", query.value);
  }
}

// Best guess: the wiki has no transcript for the conversion itself.
function convertArmour(event) {
  const { player, itemId, slot } = event;
  const counterpart = counterparts.get(itemId);
  if (counterpart === undefined || !WARRIOR_IDS.includes(event.npcId)) return;
  event.handled = true;
  const inventory = player.getInventory();
  inventory.setItem(slot, new core.Item(counterpart, inventory.get(slot).getAmount()));
  inventory.refreshItems();
  player.getDialogueManager().startDialogues(new core.DialogueChainBuilder()
    .add(new core.ItemStatementDialogue(0, counterpart,
      `The Corrupted Warrior converts your armour into ${core.ItemDefinition.forId(counterpart).getName()}.`)));
}

module.exports = function attachBountyHunterCorruptedWarrior(api) {
  core = api.core;
  pluginApi = api;
  const Npcs = core.NpcIdentifiers;
  WARRIOR_IDS = [Npcs.CORRUPTED_WARRIOR, Npcs.CORRUPTED_WARRIOR_2, Npcs.CORRUPTED_WARRIOR_3];
  FEROX_WARRIOR = Npcs.CORRUPTED_WARRIOR_3;
  pairCorruptedArmour(core.ItemIdentifiers);
  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:line", fillLine);
  api.onItemOnNpc(convertArmour);
};
Object.assign(module.exports, { counterparts, pairCorruptedArmour });
