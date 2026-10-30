// RSProx 235/941: a disembodied Quiz Master asks five questions after the drink.
const common = require("./Common.Charting");
const REWARD_ATTRIBUTE = "charting:poteen-reward";
const REWARD_VARBIT = "sailing_charting_drink_crate_puzzlers_poteen_reward";
const QUESTIONS = [
  ["Which of these is bigger: The things there are or the things there are not?", ["The things there are.", "The things there are not."], 0],
  ["If a tree falls in the forest, does it make a sound?", ["Yes.", "No."], 0],
  ["If up is down and down is up, how would you go west?", ["Go north.", "Go east.", "Go south.", "Go west."], 3],
  ["Is redacted?", ["Pass.", "Yes it is.", "No it isn't.", "Answer 4 is redacted."], 2],
  ["What's wrong?", ["This quiz.", "Who is what and where is his wrong?", "What is always wrong.", "Oh, I'm sorry that is incorrect..."], 3],
];
const sessions = new WeakMap();

function speak(player, entries, done) {
  const { DialogueChainBuilder, NpcDialogue, PlayerDialogue, ActionDialogue, CacheDefinitions } = common.core();
  const chain = new DialogueChainBuilder();
  const id = CacheDefinitions.getNpcId("macro_magneson");
  entries.forEach(([speaker, text], index) => chain.add(speaker === "player"
    ? new PlayerDialogue(index, text) : new NpcDialogue(index, id, text, "Quiz Master")));
  chain.add(new ActionDialogue(entries.length, { execute: done }));
  player.getDialogueManager().startDialogues(chain);
}

function question(player, session, index) {
  if (sessions.get(player) !== session || !player.isRegistered()) return;
  const [text, options, correct] = QUESTIONS[index];
  speak(player, [["npc", `Question ${index + 1}: ${text}`]], () => {
    if (sessions.get(player) !== session) return;
    common.api().sendMultiChatboxPrompt(player, "Select an option", ...options.flatMap((option, choice) => [option, () => {
      if (sessions.get(player) !== session || !player.isRegistered()) return;
      if (choice !== correct) return wrong(player, session);
      if (index + 1 < QUESTIONS.length) question(player, session, index + 1);
      else win(player, session);
    }]));
  });
}

function wrong(player, session) {
  speak(player, [["npc", "Oh, I'm sorry that is incorrect..."]], () => {
    if (sessions.get(player) !== session) return;
    sessions.delete(player);
    player.getPacketSender().sendInterfaceRemoval();
    player.sendMessage("Your head aches violently as you feel braincells dying.");
    const { HitDamage, HitMask } = common.core();
    player.getCombat().getHitQueue().addPendingDamage([new HitDamage(Math.floor(player.getHitpoints() / 10), HitMask.RED)]);
  });
}

function win(player, session) {
  speak(player, [["npc", "Oh, I'm sorry that is incorrect..."], ["npc", "What an inspired answer! First prize for you!"]], () => {
    if (sessions.get(player) !== session) return;
    sessions.delete(player);
    if (player.getAttribute(REWARD_ATTRIBUTE) !== true) {
      const { CacheDefinitions, Item, StatementDialogue, DialogueChainBuilder, ActionDialogue } = common.core();
      const boxes = new Item(CacheDefinitions.getObjId("macro_quiz_mystery_box"), 5);
      if (player.getInventory().getAddableAmount(boxes) < 5) {
        player.sendMessage("You don't have enough inventory space.");
        player.getPacketSender().sendInterfaceRemoval();
        return;
      }
      player.getInventory().add(boxes, true);
      player.setAttribute(REWARD_ATTRIBUTE, true);
      player.getPacketSender().sendVarbit(CacheDefinitions.getVarbitId(REWARD_VARBIT), 1);
      player.getDialogueManager().startDialogues(new DialogueChainBuilder()
        .add(new StatementDialogue(0, "Some boxes appear in your inventory."))
        .add(new ActionDialogue(1, { execute: () => speak(player, [["npc", "Thanks for playing!"]], () => player.getPacketSender().sendInterfaceRemoval()) })));
      return;
    }
    speak(player, [["npc", "Thanks for playing!"]], () => player.getPacketSender().sendInterfaceRemoval());
  });
}

function start(player) {
  const session = {};
  sessions.set(player, session);
  speak(player, [
    ["npc", "Welcome to the quiz!"], ["player", "What on Gielinor is going on?"],
    ["npc", "It's quiz time!"], ["player", "Where are you? Who is this?"],
    ["npc", "It's quiz time!!!"], ["player", "Alright then, what's the question..."],
    ["npc", "It's! Quiz! Time!"], ["player", "Please..."],
  ], () => question(player, session, 0));
}

function onLogin({ player }) {
  player.getPacketSender().sendVarbit(common.core().CacheDefinitions.getVarbitId(REWARD_VARBIT), player.getAttribute(REWARD_ATTRIBUTE) === true ? 1 : 0);
}
function onLogout({ player }) { sessions.delete(player); }
function attach(api) {
  common.init(api);
  api.persistAttribute(REWARD_ATTRIBUTE, false);
  api.onPlayerLogin(onLogin);
  api.onPlayerLogout(onLogout);
}
module.exports = { attach, start, REWARD_ATTRIBUTE };
