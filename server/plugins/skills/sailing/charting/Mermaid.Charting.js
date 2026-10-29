// Mermaid guides (rsprox 944 and others; the Wiki for what no recording has): the five Kebbit-Monkfish
// sisters, one at each diving task's spot, take a diver down for the answer to a riddle; the dive
// charts the task (175 XP).
//   Dive: without diving gear worn: "You need to be wearing diving equipment to dive with me!";
//   under 38 Sailing (the Wiki): "I don't think you are practised enough to dive here. I don't
//   want you getting swept away!" and "You need a Sailing level of 38 to dive here.". Otherwise
//   "I want something in return if you're going to dive with me...", her riddle, and the item
//   search: "Submit your answer to the mermaid's puzzle:" (or "your first answer", "second" ...
//   for each of several answers).
//   Right: the box "The mermaid, satisfied with your answer, escorts you to the bottom of the
//   sea...", her dive animation and sounds 10797/10798, the screen fading out; 8 ticks later it
//   fades back in, 2 later the charting, and her "There you go. Hope the dive got you everything
//   you needed!". Wrong (the Wiki): "I don't think that's right... You should try again." and the
//   riddle again.
const common = require("./Common.Charting");

const NPC_FIRST = 15155; // sailing_charting_mermaid_guide_1 (Victoria) .. _5 (Christina)
const NAMES = ["Victoria", "Marina", "Selina", "Gloria", "Christina"].map((name) => `${name} Kebbit-Monkfish`);
const DIVING_GEAR = Object.freeze([7534, 7535]); // fishbowl helmet, diving apparatus
const LEVEL = 38;
const SEQ_DIVE = 13191; // mermaid_dive
const SOUNDS = Object.freeze([10797, 10798]);
const SCRIPT_ITEM_SEARCH = 750; // meslayer_mode14
const FADE_IN_TICKS = 8;
const CHART_TICKS = 10;
/** From the deck to a mermaid in the water: the deck's usual reach (ours). */
const DECK_REACH = 12;
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

const NO_GEAR = "You need to be wearing diving equipment to dive with me!";
const TOO_LOW = "I don't think you are practised enough to dive here. I don't want you getting swept away!";
const TOO_LOW_BOX = `You need a Sailing level of ${LEVEL} to dive here.`;
const PRICE = "I want something in return if you're going to dive with me...";
const WRONG = "I don't think that's right... You should try again.";
const DIVED = "The mermaid, satisfied with your answer, escorts you to the bottom of the sea. You take some depth readings from your diving equipment and note down the interesting local flora and fauna.";
const THERE_YOU_GO = "There you go. Hope the dive got you everything you needed!";

function isMermaid(id) {
  return id >= NPC_FIRST && id < NPC_FIRST + NAMES.length;
}

/** The diving task a mermaid stands at: hers (the task's guide) within a few tiles. */
function taskOf(npc) {
  const guide = npc.getId() - NPC_FIRST + 1;
  const at = npc.getLocation();
  return common.spotsOfType("mermaid_guide").find((spot) => spot.mermaid?.guide === guide
    && Math.max(Math.abs(spot.mermaid.at[0] - at.getX()), Math.abs(spot.mermaid.at[1] - at.getY())) <= 3);
}

function say(player, npcId, lines, then) {
  const { DialogueChainBuilder, NpcDialogue, StatementDialogue, PlayerDialogue, ActionDialogue } = common.core();
  const name = NAMES[npcId - NPC_FIRST];
  const chain = new DialogueChainBuilder();
  lines.forEach((line, i) => chain.add(line.box ? new StatementDialogue(i, line.box)
    : line.player ? new PlayerDialogue(i, line.player) : new NpcDialogue(i, npcId, line, name)));
  if (then) chain.add(new ActionDialogue(lines.length, { execute: then }));
  player.getDialogueManager().startDialogues(chain);
}

function wearsDivingGear(player) {
  const equipment = player.getEquipment();
  return DIVING_GEAR.every((id) => equipment.contains(id));
}

function dive(event) {
  const { player, npc } = event;
  const spot = taskOf(npc);
  if (!spot) return false;
  const npcId = npc.getId();
  if (player.getSkillManager().getCurrentLevel(common.core().Skill.SAILING) < LEVEL) {
    say(player, npcId, [TOO_LOW, { box: TOO_LOW_BOX }]);
    return true;
  }
  if (!wearsDivingGear(player)) {
    say(player, npcId, [NO_GEAR]);
    return true;
  }
  say(player, npcId, [PRICE, ...spot.mermaid.riddle], () => ask(player, npc, spot, []));
  return true;
}

/** The item search, once per answer; all of them right (in any order) and she dives. */
function ask(player, npc, spot, given) {
  const answers = spot.mermaid.answers;
  const prompt = answers.length === 1
    ? "Submit your answer to the mermaid's puzzle:"
    : `Submit your ${ORDINALS[given.length] ?? "next"} answer to the mermaid's puzzle:`;
  player.setEnteredSyntaxAction({ execute: (input) => {
    const id = Number(input);
    if (!Number.isInteger(id)) return;
    const next = [...given, id];
    if (next.length < answers.length) {
      ask(player, npc, spot, next);
      return;
    }
    const right = answers.every((answer) => next.includes(answer));
    if (!right) {
      say(player, npc.getId(), [WRONG, ...spot.mermaid.riddle], () => ask(player, npc, spot, []));
      return;
    }
    escort(player, npc, spot);
  } });
  player.getPacketSender().sendInterfaceScript(SCRIPT_ITEM_SEARCH, [prompt, 1, -1, 0]);
}

function escort(player, npc, spot) {
  const { Animation, CountdownTask, TaskManager } = common.core();
  const content = require("../SailingContent.Sailing");
  common.leaveHelm(player);
  npc.performAnimation(new Animation(SEQ_DIVE));
  for (const sound of SOUNDS) player.getPacketSender().sendSoundEffect(sound, 1, 0);
  content.fade(player, true);
  say(player, npc.getId(), [{ box: DIVED }]);
  // Not keyed to the player: a click mustn't cut the dive short.
  TaskManager.submit(new CountdownTask(null, FADE_IN_TICKS, () => content.fade(player, false)));
  TaskManager.submit(new CountdownTask(null, CHART_TICKS, () => {
    if (player.isRegistered?.() === false) return;
    common.complete(player, spot, { lines: [] });
    say(player, npc.getId(), [THERE_YOU_GO]);
  }));
}

/** Talk-to (the Wiki's transcript; rsprox 944: "Hello, land dweller."). */
function talk(event) {
  const { player, npc } = event;
  if (!isMermaid(npc.getId())) return false;
  const npcId = npc.getId();
  say(player, npcId, ["Hello, land dweller.", { player: "Hello, sea dweller." }], () => {
    common.api().sendMultiChatboxPrompt(player, "Select an option",
      "What are you doing here?", () => say(player, npcId, [
        { player: "What are you doing here?" },
        "The sea has been getting quite busy all of a sudden. I surfaced to see what the fuss was about and found that lots of you seem interested in diving down to the sea floor.",
        "I'm offering my services as a guide, for a price. The price in this case, is knowledge!",
        { player: "Interesting... It might be good to add some data about the depth of the sea to my charts." },
      ]),
      "Can I dive to the sea floor with you?", () => {
        say(player, npcId, [{ player: "Can I dive to the sea floor with you?" }], () => dive({ player, npc }));
      },
      "Goodbye.", () => say(player, npcId, [{ player: "Goodbye." }, "Goodbye, land dweller."]));
  });
  return true;
}

/** The mermaids are in the water: from a deck they're spoken to across it. */
function widenRange(event) {
  if (!isMermaid(event.npcId) || !common.core().BoatManager.getBoatAboard(event.player)) return;
  event.range = DECK_REACH;
}

function attach(api) {
  common.init(api);
  api.onNpcRoute(widenRange);
  for (const name of NAMES) api.onNpcInteraction(name, { Dive: dive, "Talk-to": talk });
}

module.exports = attach;
module.exports.dive = dive;
module.exports.taskOf = taskOf;
module.exports.NAMES = NAMES;
