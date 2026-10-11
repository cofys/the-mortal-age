"use strict";

// Capt' Arnav's Chest (random event): a three-column combination lock. Each column shows a
// cylinder of four pictures; the arrow buttons roll it and the picture in the middle must
// match the word under the column. Two attempts, then Arnav gives up. One 1/4 roll of
// coins/gold ring/gold necklace/gold bar. Interface 26 (pirate_combilock) drives the lock.
// See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");

const GROUP = 26;
const UP = { left: 5, centre: 8, right: 11 };
const DOWN = { left: 6, centre: 9, right: 12 };
const COLUMNS = ["left", "centre", "right"];
const TEXT = { left: 22, centre: 23, right: 24 };
const TOP = { left: 13, centre: 14, right: 15 };
const MIDDLE = { left: 16, centre: 17, right: 18 };
const BOTTOM = { left: 19, centre: 20, right: 21 };
const CONFIRM = 25;
const SELECT_ACTION = 1;

// The cache's macro quiz pictures: two per category, used here as the lock's pictures.
const PICTURES = [
  [6189, "food"], [6190, "food"], [6191, "weapon"], [6192, "weapon"],
  [6193, "armour"], [6194, "armour"], [6195, "tool"], [6196, "tool"],
  [6197, "jewellery"], [6198, "jewellery"],
];
const WORDS = { food: "Food", weapon: "Weapon", armour: "Armour", tool: "Tool", jewellery: "Jewellery" };

function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

module.exports = function attach(api, Events) {
  const I = api.core.ItemIdentifiers;

  function definition() {
    return {
      id: api.core.NpcIdentifiers.CAPT_ARNAV,
      kind: "arnav",
      greeting: "Avast there,",
      talk: talk,
    };
  }

  function rollLock() {
    return COLUMNS.map(column => {
      const word = shuffled(Object.keys(WORDS))[0];
      const matching = PICTURES.filter(picture => picture[1] === word);
      const others = PICTURES.filter(picture => picture[1] !== word);
      const cylinder = shuffled([...matching, ...shuffled(others).slice(0, 2)]);
      return { word, cylinder, offset: Math.floor(Math.random() * cylinder.length) };
    });
  }

  function open(active) {
    active.lock ??= rollLock();
    active.attempts ??= 0;
    const lock = active.lock;
    active.interfaceId = GROUP;
    const sender = active.player.getPacketSender();
    sender.sendInterface(GROUP);
    COLUMNS.forEach((column, index) => {
      const state = lock[index];
      const length = state.cylinder.length;
      sender.sendString(WORDS[state.word], (GROUP << 16) | TEXT[column]);
      const visible = [0, 1, 2].map(offset => state.cylinder[(state.offset + offset) % length][0]);
      sender.sendItemOnInterfaces((GROUP << 16) | TOP[column], visible[0], 1);
      sender.sendItemOnInterfaces((GROUP << 16) | MIDDLE[column], visible[1], 1);
      sender.sendItemOnInterfaces((GROUP << 16) | BOTTOM[column], visible[2], 1);
    });
    sender.sendInterfaceFlagsRange((GROUP << 16) | UP.left, -1, -1, 1 << SELECT_ACTION);
    sender.sendInterfaceFlagsRange((GROUP << 16) | UP.centre, -1, -1, 1 << SELECT_ACTION);
    sender.sendInterfaceFlagsRange((GROUP << 16) | UP.right, -1, -1, 1 << SELECT_ACTION);
    sender.sendInterfaceFlagsRange((GROUP << 16) | DOWN.left, -1, -1, 1 << SELECT_ACTION);
    sender.sendInterfaceFlagsRange((GROUP << 16) | DOWN.centre, -1, -1, 1 << SELECT_ACTION);
    sender.sendInterfaceFlagsRange((GROUP << 16) | DOWN.right, -1, -1, 1 << SELECT_ACTION);
    sender.sendInterfaceFlagsRange((GROUP << 16) | CONFIRM, -1, -1, 1 << SELECT_ACTION);
  }

  function talk(active, { valid }) {
    const player = active.player;
    if (active.attempts > 0) {
      Flow.chat(api, {
        player,
        npcId: active.definition.id,
        lines: ["Arrr! That be nowhere near close! Did ye not listen the first time around?",
          "Click the arrows to roll the cylinders round to the different items.",
          "When the items in the middle row all match the words under the column, you'll have solved the lock!"],
        onEnd: () => valid(active, player) && open(active),
      });
      return;
    }
    Flow.chat(api, {
      player,
      npcId: active.definition.id,
      lines: [`Ah, hello there, ${player.getUsername()}! I've just dug up an old treasure chest of mine.`,
        "Could you help me out?",
        "There are three columns. Match each picture with the word under its column, then unlock the chest."],
      options: [
        ["Yes, I'll help you unlock your chest.", () => valid(active, player) && open(active)],
        ["No, sorry.", () => {}],
      ],
    });
  }

  function roll(active, column, direction) {
    const state = active.lock[COLUMNS.indexOf(column)];
    const length = state.cylinder.length;
    state.offset = (state.offset + direction + length) % length;
    const sender = active.player.getPacketSender();
    const visible = [0, 1, 2].map(offset => state.cylinder[(state.offset + offset) % length][0]);
    sender.sendItemOnInterfaces((GROUP << 16) | TOP[column], visible[0], 1);
    sender.sendItemOnInterfaces((GROUP << 16) | MIDDLE[column], visible[1], 1);
    sender.sendItemOnInterfaces((GROUP << 16) | BOTTOM[column], visible[2], 1);
  }

  function choose(event) {
    const { player, buttonId } = event;
    if ((buttonId >>> 16) !== GROUP) return;
    const child = buttonId & 0xffff;
    event.handled = true;
    if (event.action !== SELECT_ACTION || !player.getDialogueManager?.()) return;
    const active = Events.activeFor(player);
    if (!active || active.definition.kind !== "arnav" || active.session || !active.lock ||
        player.getInterfaceId() !== GROUP) return;
    const column = COLUMNS.find(name => UP[name] === child || DOWN[name] === child);
    if (column) {
      roll(active, column, UP[column] === child ? -1 : 1);
      return;
    }
    if (child !== CONFIRM) return;
    const solved = active.lock.every(state =>
      state.cylinder[(state.offset + 1) % state.cylinder.length][1] === state.word);
    if (!solved) {
      active.attempts++;
      player.sendMessage("The chest stays firmly locked.");
      if (active.attempts >= 2) {
        player.sendMessage("Arrr! I'd better find someone else.");
        Events.finish(active);
      }
      return;
    }
    const reward = [[I.COINS, 125], [I.GOLD_RING, 1], [I.GOLD_NECKLACE, 1], [I.GOLD_BAR, 1]]
      [Math.floor(Math.random() * 4)];
    // Finish clears the interface; grant through the shared reward path.
    active.gift = { id: reward[0], amount: reward[1] };
    if (Events.serve(active, [active.gift])) {
      player.sendMessage("You unlock the chest and find a reward inside!");
    }
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition()));
  api.onInterfaceActionClick(choose);
  return { open };
};
