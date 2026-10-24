/**
 * Historian Aldo outside the lair (Wiki: Historian Aldo, Scurrius' spine), as captured
 * (docs/scurrius.md). Talk-to plays his Wiki transcript (NpcDialogues); this is the rest:
 * - Trade, or a spine used on him, swaps Scurrius' spines for his antique lamps: one asks
 *   "Trade Scurrius' spine for a combat lamp?", several "Trade ALL your Scurrius spines for combat
 *   lamps?", and the lamps come with an item box;
 * - the lamp gives 5,000 experience in Attack, Strength, Defence, Ranged, Magic or Hitpoints, or
 *   3,500 in Prayer, picked over two pages of options.
 *
 * Not here: Aldo making rat bone weapons, which needs the bone weapons themselves first.
 */
const LAMP_XP = 5000;
const PRAYER_LAMP_XP = 3500;
const LAMP_SOUND = 2655;

const NO_SPINE = "Ah, I'll need one of Scurrius' spines to do that. Perhaps you could fetch me one?";
const SPINE_USED = "Ah, a Scurrius spine! A captivating subject indeed. I'll eagerly take them off your hands, and rest assured, you will be well rewarded.";
const LAMP_PROMPT = "Choose the skill you wish to gain XP in.";

let api = null;
let core = null;

function spineCount(player) {
  return player.getInventory().getAmount(core.ItemIdentifiers.SCURRIUS_SPINE);
}

function itemBox(player, itemId, text) {
  const { DialogueChainBuilder, ItemStatementDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, itemId, text)));
}

function aldoSays(player, npc, text, then = null) {
  const { DialogueChainBuilder, NpcDialogue, ActionDialogue } = core;
  const chain = new DialogueChainBuilder().add(new NpcDialogue(0, npc.getId(), text));
  if (then) chain.add(new ActionDialogue(1, { execute: then }));
  player.getDialogueManager().startDialogues(chain);
}

function swapSpines(player) {
  const { ItemIdentifiers } = core;
  const count = spineCount(player);
  if (count <= 0) return;
  const inventory = player.getInventory();
  inventory.deleteNumber(ItemIdentifiers.SCURRIUS_SPINE, count);
  inventory.adds(ItemIdentifiers.ANTIQUE_LAMP_35, count);
  itemBox(player, ItemIdentifiers.ANTIQUE_LAMP_35, count === 1
    ? "Aldo gives you an Antique lamp for Scurrius' spine."
    : "Aldo gives you some Antique lamps for Scurrius' spines.");
}

function offerTrade(player, npc) {
  const count = spineCount(player);
  if (count <= 0) {
    aldoSays(player, npc, NO_SPINE);
    return;
  }
  const prompt = count === 1 ? "Trade Scurrius' spine for a combat lamp?" : "Trade ALL your Scurrius spines for combat lamps?";
  api.sendMultiChatboxPrompt(player, prompt,
    "Yes.", () => swapSpines(player),
    "No.", () => player.getPacketSender().sendInterfaceRemoval());
}

function trade({ player, npc }) {
  offerTrade(player, npc);
  return true;
}

function useSpine(event) {
  const { player, target, itemId } = event;
  if (itemId !== core.ItemIdentifiers.SCURRIUS_SPINE || (event.definition ?? target?.getDefinition?.())?.getName?.() !== "Historian Aldo") return;
  event.handled = true;
  aldoSays(player, target, SPINE_USED, () => offerTrade(player, target));
}

/** The lamp's two pages of skills. */
function lampSkills() {
  const { Skill } = core;
  return [
    [["Attack", Skill.ATTACK], ["Strength", Skill.STRENGTH], ["Defence", Skill.DEFENCE], ["Prayer", Skill.PRAYER]],
    [["Ranged", Skill.RANGED], ["Magic", Skill.MAGIC], ["Hitpoints", Skill.HITPOINTS]],
  ];
}

function showLampPage(player, request, page) {
  const pages = lampSkills();
  const options = pages[page].flatMap(([name, skill]) => [`${name}.`, () => grantLamp(player, request, skill, name)]);
  const other = page === 0 ? "More options..." : "Previous options...";
  api.sendMultiChatboxPrompt(player, LAMP_PROMPT, ...options, other, () => showLampPage(player, request, 1 - page));
}

function rubLamp({ player, item, itemId, slot }) {
  if (itemId !== core.ItemIdentifiers.ANTIQUE_LAMP_35) return false;
  showLampPage(player, { item, slot }, 0);
  return true;
}

function grantLamp(player, request, skill, name) {
  const inventory = player.getInventory();
  if (inventory.get(request.slot) !== request.item) return;
  const experience = skill === core.Skill.PRAYER ? PRAYER_LAMP_XP : LAMP_XP;
  const manager = player.getSkillManager();
  const before = manager.getExperience(skill);
  manager.addExperience(skill, experience, false);
  if (manager.getExperience(skill) === before) {
    player.sendMessage("You cannot gain experience in that skill right now.");
    return;
  }
  inventory.deleteAtSlot(request.slot, 1);
  player.getPacketSender().sendSound(LAMP_SOUND, 1, 0);
  itemBox(player, core.ItemIdentifiers.ANTIQUE_LAMP_35,
    `<col=0000ff>Your wish has been granted!</col><br>You have been awarded ${experience.toLocaleString("en-GB")} ${name} XP!`);
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  pluginApi.onNpcInteraction("Historian Aldo", { Trade: trade });
  pluginApi.onItemOnNpc(useSpine);
  pluginApi.onItemAction("Antique lamp", { Rub: rubLamp });
}

module.exports = { attach, _test: { swapSpines, offerTrade, useSpine, rubLamp, grantLamp, lampSkills, LAMP_XP, PRAYER_LAMP_XP } };
