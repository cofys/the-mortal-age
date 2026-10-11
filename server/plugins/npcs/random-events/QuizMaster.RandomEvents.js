"use strict";

// Quiz Master (random event): "Odd One Out". Four correct answers in a row wins 1,000 coins
// or a mystery box. Wrong answers only restart the streak. The three items are shown on a
// server-defined interface (the cache's macro_quizshow has no item components); the quiz
// holds the player until it is completed. See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");
const MysteryBox = require("./MysteryBox.RandomEvents");
const { FLAG_OP1, TYPE_RECTANGLE, TYPE_TEXT, TYPE_MODEL, createWidgetGroup } =
  require("../../interface/widgetGroup");

const GROUP = 30012;
const MAIN_MODAL_UID = (161 << 16) | 16;
const COMPONENT = { ROOT: 0, BACKGROUND: 1, TITLE: 2, ITEM_0: 3, ITEM_1: 4, ITEM_2: 5 };
const GEMS = [6189, 6190, 6191, 6192, 6193, 6194, 6195, 6196, 6197, 6198];
const CATEGORY = new Map([[6189, "food"], [6190, "food"], [6191, "weapon"], [6192, "weapon"],
  [6193, "armour"], [6194, "armour"], [6195, "tool"], [6196, "tool"], [6197, "jewellery"]]);
const WINS_NEEDED = 4;

const WRONG = ["WRONG! That's just WRONG!", "BZZZZZZZ! WRONG!", "No! That is not the odd one out!",
  "Wrong! Are you even trying?"];
const RIGHT = ["DING DING DING! That's RIGHT!", "COR-RECT!", "Yes! That's the odd one out!",
  "Correct! Keep it up!"];

function shuffledPool(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildInterface() {
  const { widgets, add } = createWidgetGroup(GROUP);
  const root = add(COMPONENT.ROOT, -1, {
    rawWidth: 18, rawHeight: 18, widthMode: 1, heightMode: 1,
    width: 512, height: 334, xPositionMode: 1, yPositionMode: 1,
  });
  add(COMPONENT.BACKGROUND, root, {
    type: TYPE_RECTANGLE, widthMode: 1, heightMode: 1, width: 512, height: 334,
    filled: true, color: 0x1a1a2e,
  });
  add(COMPONENT.TITLE, root, {
    type: TYPE_TEXT, rawX: 0, rawY: 40, rawWidth: 512, rawHeight: 24, width: 512, height: 24,
    text: "Pick the odd one out.", fontId: 495, textColor: 0xffffff, textShadowed: true,
    xTextAlignment: 1, yTextAlignment: 1,
  });
  [[COMPONENT.ITEM_0, 96], [COMPONENT.ITEM_1, 224], [COMPONENT.ITEM_2, 352]].forEach(([component, x]) => {
    add(component, root, {
      type: TYPE_MODEL, rawX: x, rawY: 120, rawWidth: 64, rawHeight: 64, width: 64, height: 64,
      actions: ["Select"], flags: FLAG_OP1,
    });
  });
  return { groupId: GROUP, widgets };
}

module.exports = function attach(api, Events) {
  const I = api.core.ItemIdentifiers;
  const N = api.core.NpcIdentifiers;
  const itemWidgets = [COMPONENT.ITEM_0, COMPONENT.ITEM_1, COMPONENT.ITEM_2];

  const definition = {
    id: N.QUIZ_MASTER_2,
    kind: "quiz",
    greeting: "Hey",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: active.definition.id,
        lines: [`It's your lucky day, ${player.getUsername()}! You've got a chance to win big prizes in my quiz show.`,
          "Would you like to play?"],
        options: [
          ["Yes please, I'm so excited!", () => teleport({
            kind: "quiz",
            arrive: { x: 1952, y: 4774, z: 0 },
            teleportRefusal: "The quiz isn't over yet!",
            onStart: start,
          })],
          ["Quiz shows are stupid. Go away.", () => {}],
        ],
      });
    },
  };

  function start(session) {
    session.data.streak = 0;
    openInterface(session);
    question(session);
  }

  function openInterface(session) {
    const { player } = session;
    session.interfaceId = GROUP;
    player.setInterfaceId(GROUP);
    player.getPacketSender().sendSubInterface(MAIN_MODAL_UID, GROUP, 0, {});
    player.getPacketSender().sendString("Pick the odd one out.", (GROUP << 16) | COMPONENT.TITLE);
  }

  function question(session) {
    const odd = GEMS[Math.floor(Math.random() * GEMS.length)];
    const majority = shuffledPool(GEMS.filter(item => CATEGORY.get(item) !== CATEGORY.get(odd))).slice(0, 2);
    const items = [odd, ...majority];
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    session.data.odd = odd;
    session.data.items = items;
    const sender = session.player.getPacketSender();
    items.forEach((item, index) => sender.sendItemOnInterfaces((GROUP << 16) | itemWidgets[index], item, 1));
  }

  function choose(event) {
    const { player, buttonId } = event;
    if ((buttonId >>> 16) !== GROUP) return;
    const index = itemWidgets.indexOf(buttonId & 0xffff);
    if (index < 0) return;
    event.handled = true;
    if (event.action !== 1) return;
    const session = Teleports.sessionOf(player);
    if (!session || session.kind !== "quiz" || !session.data.items) return;
    const correct = session.data.items[index] === session.data.odd;
    player.sendMessage(correct ? RIGHT[Math.floor(Math.random() * RIGHT.length)]
      : WRONG[Math.floor(Math.random() * WRONG.length)]);
    if (correct) session.data.streak++;
    else session.data.streak = 0;
    if (session.data.streak >= WINS_NEEDED) {
      player.getPacketSender().sendString("CONGRATULATIONS! You are a WINNER!", (GROUP << 16) | COMPONENT.TITLE);
      Flow.chat(api, {
        player,
        npcId: N.QUIZ_MASTER,
        lines: ["CONGRATULATIONS! You are a WINNER!", "Please choose your PRIZE!"],
        options: [
          ["1,000 coins, please.", () => finish(session, [{ id: I.COINS, amount: 1000 }],
            "You win 1,000 coins!")],
          ["A mystery box, please.", () => finish(session, [{ id: I.MYSTERY_BOX, amount: 1 }],
            "You win a mystery box!")],
        ],
      });
      return;
    }
    question(session);
  }

  function finish(session, rewards, message) {
    if (session.player.getInterfaceId?.() === GROUP) session.player.getPacketSender().sendInterfaceRemoval();
    Teleports.finish(session, { reward: rewards, message });
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));
  api.onInterfaceActionClick(choose);
  api.registerCustomInterface(buildInterface());
  api.onItemAction("Mystery box", { Open: openBox });
  api.onItemAction("MysteryBox", { Open: openBox });

  function openBox(event) {
    const { player } = event;
    if (!player.getInventory().containsNumber(I.MYSTERY_BOX)) return false;
    player.getInventory().delete(I.MYSTERY_BOX, 1);
    const rewards = MysteryBox.roll(api);
    for (const reward of rewards) player.getInventory().addItem(new api.core.Item(reward.id, reward.amount));
    player.sendMessage("You open the mystery box.");
    return true;
  }
};
