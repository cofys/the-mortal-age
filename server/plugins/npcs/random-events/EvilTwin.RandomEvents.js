"use strict";

// Evil twin (random event, Postie Pete / Molly): memorise Molly, then use the mechanical claw
// to grab her identical twin from a cage of innocents within two attempts. Success pays noted
// uncut gems; two wrong grabs teleport the player to a random spot instead. The claw's target
// rides on the cache's control interface 277. See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const MOLLY = 342; // Molly and her twins share these appearance ids.
const INNOCENTS = [338, 343, 353, 357];
const INNER_TILES = [[1866, 5130], [1866, 5131], [1867, 5132], [1866, 5133]];
const CONTROL_PANEL = 20813;
const DOOR = 20817;
const GROUP = 277;
const ARROWS = { right: 7, up: 8, left: 9, down: 10 };
const GRAB = 3;
const ATTEMPTS = 2;
// A few of the wiki's thirty-four destinations for a failed event.
const FAIL_SPOTS = [[3213, 3424], [3093, 3244], [2966, 3383], [2667, 3305], [3270, 3186],
  [3013, 3259], [3164, 3481], [2727, 3493]];

module.exports = function attach(api, Events) {
  const N = api.core.NpcIdentifiers;

  const definition = {
    id: N.POSTIE_PETE_2,
    kind: "eviltwin",
    greeting: "Message for you,",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: active.definition.id,
        lines: [`Hello ${player.getUsername()}. I've got a message for you from Molly.`,
          "She needs your help urgently. Will you assist her now?"],
        options: [
          ["Sure, anything for Molly.", () => teleport({
            kind: "eviltwin",
            arrive: { x: 1859, y: 5132, z: 0 },
            teleportRefusal: "Use the door to leave Molly's room!",
            onStart: start,
          })],
          ["Tell her to get stuffed.", () => {}],
        ],
      });
    },
  };

  function start(session) {
    session.data.attempts = ATTEMPTS;
    session.data.caught = false;
    session.data.innocents = 0;
    const molly = Teleports.spawnNpc(session, { id: MOLLY, x: 1857, y: 5131, z: 0, wanderRadius: 0 });
    session.molly = molly;
    const appearances = new Set([MOLLY]);
    session.data.suspects = [];
    INNER_TILES.forEach(([x, y], index) => {
      let id;
      if (index === 0) id = MOLLY;
      else {
        id = INNOCENTS[(index - 1) % INNOCENTS.length];
        while (appearances.has(id)) id = INNOCENTS[Math.floor(Math.random() * INNOCENTS.length)];
      }
      appearances.add(id);
      const npc = Teleports.spawnNpc(session, { id, x, y, z: 0, wanderRadius: 0 });
      if (npc) session.data.suspects.push({ npc, id });
    });
    session.data.twin = session.data.suspects.find(entry => entry.id === MOLLY);
    Flow.chat(api, {
      player: session.player,
      npcId: MOLLY,
      lines: ["Thanks for coming! It's my evil twin sister! She's been galavanting around",
        "committing crimes and now I'm getting the blame!",
        "She looks exactly like me, even her clothes. Use the claw to grab her - you have two attempts."],
      options: [
        ["Yes please.", () => {}],
        ["I want to leave.", () => Teleports.finish(session,
          { message: "Fine. And there I was thinking you'd help." })],
      ],
    });
  }

  function usePanel(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "eviltwin") return false;
    if (event.object.getId() !== CONTROL_PANEL) return false;
    event.handled = true;
    if (session.data.caught) {
      event.player.sendMessage("You already caught her - talk to Molly.");
      return true;
    }
    session.data.claw = 0;
    const sender = event.player.getPacketSender();
    session.interfaceId = GROUP;
    sender.sendInterface(GROUP);
    sender.sendInterfaceFlagsRange((GROUP << 16) | GRAB, -1, -1, 1 << 1);
    for (const component of Object.values(ARROWS)) {
      sender.sendInterfaceFlagsRange((GROUP << 16) | component, -1, -1, 1 << 1);
    }
    event.player.sendMessage("The claw hangs over suspect 1 of 4.");
    return true;
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));

  api.onObjectInteraction("Control panel", { Operate: usePanel, Use: usePanel });

  api.onInterfaceActionClick(event => {
    const { player, buttonId } = event;
    if ((buttonId >>> 16) !== GROUP) return;
    const child = buttonId & 0xffff;
    event.handled = true;
    const session = Teleports.sessionOf(player);
    if (event.action !== 1 || !session || session.kind !== "eviltwin" || session.data.claw === undefined) return;
    if (child === ARROWS.left || child === ARROWS.right || child === ARROWS.up || child === ARROWS.down) {
      const count = session.data.suspects.length;
      const step = child === ARROWS.right || child === ARROWS.down ? 1 : -1;
      session.data.claw = (session.data.claw + step + count) % count;
      player.sendMessage(`The claw hangs over suspect ${session.data.claw + 1} of ${count}.`);
      return;
    }
    if (child !== GRAB) return;
    grab(session);
  });

  function grab(session) {
    const player = session.player;
    const target = session.data.suspects[session.data.claw];
    const twin = session.data.twin;
    if (target && twin && target.npc === twin.npc) {
      session.data.caught = true;
      player.getPacketSender().sendInterfaceRemoval();
      player.sendMessage("Well done! You managed to catch my sister! Come next door and talk to me.");
      return;
    }
    session.data.attempts--;
    if (session.data.attempts <= 0) {
      player.getPacketSender().sendInterfaceRemoval();
      const [x, y] = FAIL_SPOTS[Math.floor(Math.random() * FAIL_SPOTS.length)];
      player.sendMessage("Such incompetence! I should never have asked a baboon like you to do a complex task!");
      Teleports.finish(session, { message: "Molly's twin magic flings you away." });
      player.moveTo(new api.core.Location(x, y, 0));
      return;
    }
    player.sendMessage("That was one of the innocent civilians! One attempt left.");
  }

  api.onNpcInteraction("Molly", {
    "Talk-to": event => {
      const session = Teleports.sessionOf(event.player);
      if (!session || session.kind !== "eviltwin" || event.npc !== session.molly) return false;
      event.handled = true;
      const player = event.player;
      if (session.data.caught) {
        const gems = [[1624, 2 + Math.floor(Math.random() * 3)], [1622, 2 + Math.floor(Math.random() * 3)],
          [1620, 2 + Math.floor(Math.random() * 3)], [1618, 2 + Math.floor(Math.random() * 3)]];
        const reward = gems[Math.floor(Math.random() * gems.length)];
        player.sendMessage("Fantastic! Thank you for all your help. Take this as a reward.");
        Teleports.finish(session, { reward: [{ id: reward[0], amount: reward[1] }] });
        return true;
      }
      Flow.chat(api, {
        player,
        npcId: MOLLY,
        lines: ["Use the control panel to move the claw over her and grab when you're ready."],
      });
      return true;
    },
  });

  api.onObjectInteraction("Door", { Open: leaveDoor });
  api.onObjectInteraction("Door", { Walk: leaveDoor });

  function leaveDoor(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "eviltwin") return false;
    if (event.object.getId?.() !== DOOR) return false;
    event.handled = true;
    Teleports.finish(session, { message: "Fine. And there I was thinking you'd help." });
    return true;
  }
};
