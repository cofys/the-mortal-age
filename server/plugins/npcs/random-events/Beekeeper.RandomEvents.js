"use strict";

// Beekeeper (random event): the player is taken to the beehive field and must rebuild the
// beehive from its four jumbled parts before the bees lose patience (six attempts). Always a
// lamp; until the beekeeper's outfit is complete one missing piece, then flax on members
// worlds or 30-99 coins on free worlds. Cache interface 420 shows the example and the slots.
// See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const GROUP = 420;
const CONFIRM = 22;
const SELECT_ACTION = 1;
const EXAMPLE = [5, 6, 7, 8];
const START = [10, 11, 12, 13];
const DEST = [15, 17, 19, 21];
const MAX_ATTEMPTS = 6;
// The cache's example models, one per part, top to bottom.
const PARTS = [
  { name: "Lid", model: 28806, piece: null },
  { name: "Body", model: 28428, piece: null },
  { name: "Entrance", model: 28803, piece: null },
  { name: "Legs", model: 28808, piece: null },
];
const OUTFIT = [25129, 25131, 25133, 25135, 25137];
const BEE_SWARM = 10444;

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
  const N = api.core.NpcIdentifiers;

  const definition = {
    id: N.BEE_KEEPER_2,
    kind: "beekeeper",
    greeting: "Hello,",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: active.definition.id,
        lines: [`I'm sorry to bother you, ${player.getUsername()}, but I need some help with a bee hive.`,
          "All the parts of the beehive are jumbled up. You've got to put them in the correct order."],
        options: [
          ["Ooh, a bee hive. I'll help you.", () => teleport({
            kind: "beekeeper",
            arrive: { x: 1926, y: 5044, z: 0 },
            onStart: start,
          })],
          ["Buzz off!", () => {}],
        ],
      });
    },
  };

  function start(session) {
    const { player } = session;
    const keeper = Teleports.spawnNpc(session, { id: N.BEE_KEEPER, x: session.player.getLocation().getX() + 1,
      y: session.player.getLocation().getY(), z: 0, face: 4, wanderRadius: 0 });
    session.keeper = keeper;
    session.data.scrambled = shuffled(PARTS);
    session.data.placed = [null, null, null, null];
    session.data.attempts = MAX_ATTEMPTS;
    player.sendMessage("Assemble the beehive parts in the order shown by the example.");
    openInterface(session);
    askSlot(session, 0);
  }

  function openInterface(session) {
    const { player } = session;
    const sender = player.getPacketSender();
    session.interfaceId = GROUP;
    sender.sendInterface(GROUP);
    EXAMPLE.forEach((component, index) => sender.sendInterfaceRawModel((GROUP << 16) | component, PARTS[index].model));
    const available = session.data.scrambled.filter(Boolean);
    START.forEach((component, index) => sender.sendInterfaceRawModel((GROUP << 16) | component,
      available[index]?.model ?? -1));
    DEST.forEach((component, index) => sender.sendInterfaceRawModel((GROUP << 16) | component,
      session.data.placed[index]?.model ?? -1));
    sender.sendInterfaceFlagsRange((GROUP << 16) | CONFIRM, -1, -1, 1 << SELECT_ACTION);
  }

  function refreshInterface(session) {
    const sender = session.player.getPacketSender();
    const available = session.data.scrambled.filter(Boolean);
    START.forEach((component, index) => sender.sendInterfaceRawModel((GROUP << 16) | component,
      available[index]?.model ?? -1));
    DEST.forEach((component, index) => sender.sendInterfaceRawModel((GROUP << 16) | component,
      session.data.placed[index]?.model ?? -1));
  }

  function askSlot(session, slot) {
    if (slot >= PARTS.length) { refreshInterface(session); return; }
    const available = session.data.scrambled.filter(Boolean);
    if (!available.length) return;
    Flow.chat(api, {
      player: session.player,
      npcId: N.BEE_KEEPER,
      lines: [`Which part goes in the ${PARTS[slot].name} position?`],
      options: available.map(part => [part.name, () => place(session, slot, part)]),
    });
  }

  function place(session, slot, part) {
    const index = session.data.scrambled.indexOf(part);
    if (index < 0) return;
    session.data.scrambled.splice(index, 1, null);
    session.data.placed[slot] = part;
    refreshInterface(session);
    askSlot(session, slot + 1);
  }

  function attempt(session) {
    const { player } = session;
    const placed = session.data.placed;
    if (placed.some(part => part === null)) {
      player.sendMessage("You still have parts to place.");
      return;
    }
    const correct = placed.every((part, index) => part === PARTS[index]);
    if (correct) {
      finish(session, true);
      return;
    }
    session.data.attempts--;
    if (session.data.attempts <= 0) {
      finish(session, false);
      return;
    }
    session.data.placed = [null, null, null, null];
    session.data.scrambled = shuffled(PARTS);
    refreshInterface(session);
    player.sendMessage(`No, that doesn't look right... I'll let you have ${session.data.attempts} more ` +
      `${session.data.attempts === 1 ? "try" : "tries"}.`);
    askSlot(session, 0);
  }

  function finish(session, success) {
    const { player } = session;
    if (success) {
      const rewards = [{ id: I.LAMP, amount: 1 }];
      const missing = OUTFIT.find(piece => !Teleports.owns(player, piece));
      if (missing !== undefined) {
        rewards.push({ id: missing, amount: 1 });
        player.sendMessage("The beekeeper gives you a piece of the beekeeper's outfit.");
      } else if (api.core.WorldDefinition.isMembersWorld()) {
        rewards.push({ id: I.FLAX, amount: 1 + Math.floor(Math.random() * 27) });
        player.sendMessage("The beekeeper gives you some flax.");
      } else {
        rewards.push({ id: I.COINS, amount: 30 + Math.floor(Math.random() * 70) });
        player.sendMessage("The beekeeper gives you some coins.");
      }
      Teleports.finish(session, { reward: rewards, message: "That's perfect! The beekeeper thanks you." });
      return;
    }
    player.forceChat("Aaaaargh - BEES!");
    player.sendMessage("Uh-oh, the bees are fed up...");
    const at = player.getLocation();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1]]) {
      Teleports.spawnNpc(session, { id: BEE_SWARM, x: at.getX() + dx, y: at.getY() + dy, z: at.getZ(),
        wanderRadius: 0 });
    }
    Teleports.finish(session, { message: "The beekeeper teleports you away before the bees can sting you." });
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));

  api.onNpcInteraction("Bee keeper", {
    "Talk-to": event => {
      const session = Teleports.sessionOf(event.player);
      if (!session || session.kind !== "beekeeper" || event.npc !== session.keeper) return false;
      Flow.chat(api, {
        player: event.player,
        npcId: N.BEE_KEEPER,
        lines: ["First remind me of what I'm doing.",
          "Drag the parts into the right slots and select confirm. The example shows the order."],
        options: [
          ["Yeah, let me get on with it.", () => openInterface(session)],
          ["I want to leave.", () => Teleports.finish(session, { message: "The beekeeper takes you back." })],
        ],
      });
      event.handled = true;
      return true;
    },
  });

  api.onInterfaceActionClick(event => {
    if ((event.buttonId >>> 16) !== GROUP || (event.buttonId & 0xffff) !== CONFIRM) return;
    event.handled = true;
    const session = Teleports.sessionOf(event.player);
    if (event.action !== SELECT_ACTION || !session || session.kind !== "beekeeper" ||
        session.data === undefined) return;
    attempt(session);
  });
};
