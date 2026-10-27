/**
 * Tai Bwo Wannai Cleanup: Safta Doc's gem machetes (https://oldschool.runescape.wiki/w/Safta_Doc).
 *
 * His transcript offers an opal (300 trading sticks), jade (600) or red topaz (1,200) machete,
 * each for 3 of the gem, cut or uncut, and a gout tuber. Its "has the required materials"
 * outcomes are empty in the dump, so the trade is played here as rsprox 227/01858 recorded it
 * (ticks 20577-20607): once his "Ok Bwana, if you want to order..." line is continued, the
 * materials go, the machete comes, the Karamja medium task completes ("Well done!..."), jingle 256
 * plays, he says "There you go Bwana, a nice new opal machete for you." and the item box "Safta
 * doc sells you an opal machete." follows. Without the materials his transcript plays on to
 * "I don't have enough trading sticks, sorry." (its own branch). Only the opal trade is
 * recorded; the jade and red topaz lines and boxes follow its wording. Gems are taken in
 * inventory order.
 */
const Common = require("./Common.TaiBwoWannaiCleanup");

const isSafta = (event) => event.definition?.getName?.() === "Safta Doc";
const safta = () => Common.data.safta;

/** The planned slots for `machete`: three gem slots, a tuber slot and the stick slots, or null. */
function plan(player, machete) {
  const items = player.getInventory().getItems();
  const gemIds = new Set(machete.gems.map(Common.objId));
  const tuber = Common.objId(safta().tuber);
  const sticks = Common.objId(Common.data.sticks.item);
  const gems = [];
  let tuberSlot = -1;
  let held = 0;
  items.forEach((item, slot) => {
    const id = item ? item.getId() : -1;
    if (gemIds.has(id) && gems.length < safta().gems) gems.push(slot);
    else if (id === tuber && tuberSlot < 0) tuberSlot = slot;
    else if (id === sticks) held += item.getAmount();
  });
  if (gems.length < safta().gems || tuberSlot < 0 || held < machete.sticks) return null;
  return { gems, tuberSlot, sticks };
}

const machetes = () => safta().machetes;
const hasMaterials = (player, machete) => plan(player, machete) !== null;

/** Takes the materials slot by slot (never by id), then gives the machete. */
function make(player, machete) {
  const planned = plan(player, machete);
  if (!planned) return false;
  const inventory = player.getInventory();
  for (const slot of [...planned.gems, planned.tuberSlot]) inventory.deleteAtSlot(slot, 1, false);
  let owed = machete.sticks;
  inventory.getItems().forEach((item, slot) => {
    if (owed <= 0 || !item || item.getId() !== planned.sticks) return;
    const taken = Math.min(owed, item.getAmount());
    inventory.deleteAtSlot(slot, taken, false);
    owed -= taken;
  });
  inventory.add(new Common.core.Item(Common.objId(machete.item), 1), false);
  inventory.refreshItems();
  Common.api.emitCustomEvent("diary:task", { player, ...safta().diary });
  player.getPacketSender().sendJingle(safta().jingle);
  const { DialogueChainBuilder, EndDialogue, ItemStatementDialogue, NpcDialogue } = Common.core;
  const npcId = Common.core.CacheDefinitions.getNpcId("tbwcu_safta_doc");
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new NpcDialogue(0, npcId, machete.done),
    new ItemStatementDialogue(1, Common.objId(machete.item), machete.box),
    new EndDialogue(2),
  ));
  return true;
}

const byOrderLine = (text) => machetes().find((machete) => text.toLowerCase().startsWith(machete.order.toLowerCase())) ?? null;

/**
 * His order line: continued with the materials, the trade happens (and his transcript stops).
 * The transcript's own "There you go Bwana..." (red topaz) is ours to say, so it is skipped.
 */
function onLine(event) {
  if (!isSafta(event)) return;
  const text = String(event.text ?? "");
  if (text.startsWith(safta().transcriptDone)) {
    event.skip = true;
    return;
  }
  const machete = byOrderLine(text);
  if (machete) event.after = () => make(event.player, machete);
}

/** "If the player has / does not have the required materials:", told apart by step id. */
function answerCondition(event) {
  if (!isSafta(event)) return undefined;
  for (const machete of machetes()) {
    if (event.stepId === machete.has) return hasMaterials(event.player, machete);
    if (event.stepId === machete.missing) return !hasMaterials(event.player, machete);
  }
  return undefined;
}

function attachMachetes(api) {
  api.onCustomEvent("npc-dialogue:line", onLine);
  api.onNpcDialogueCondition(answerCondition);
}

module.exports = { attachMachetes, plan, make, hasMaterials, answerCondition, onLine };
