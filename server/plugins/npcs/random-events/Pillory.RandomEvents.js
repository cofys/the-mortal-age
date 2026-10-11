"use strict";

// Pillory (random event, Pillory Guard): locked in the pillory, pick the key that matches the
// large lock three times; a wrong key adds another lock (up to six) and resets progress. The
// cache's pillory interface 27 drives the locks and keys. See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const GROUP = 27;
const LOCK = 3;
const KEYS = [4, 5, 6];
const BUTTONS = [7, 8, 9];
const LOCKS = [10, 11, 12, 13, 14, 15];
const FLASHES = [16, 17, 18, 19, 20, 21];
const SELECT_ACTION = 1;
const LOCK_MODEL = 9757;
// The cache's pillory key models.
const KEY_MODELS = [13394, 13395, 4141, 13396];
// Varrock, Seers' Village and Yanille cages; free worlds only use Varrock.
const CAGES = [[3228, 3407, 0], [2683, 3489, 0], [2606, 3105, 0]];

module.exports = function attach(api, Events) {
  const I = api.core.ItemIdentifiers;
  const N = api.core.NpcIdentifiers;

  const definition = {
    id: N.PILLORY_GUARD,
    kind: "pillory",
    greeting: "You're under arrest,",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: active.definition.id,
        lines: ["You're under arrest! I've come to lock you up."],
        options: [
          ["Okay, guv, I'll come quietly.", () => {
            const members = api.core.WorldDefinition.isMembersWorld();
            const cage = members ? CAGES[Math.floor(Math.random() * CAGES.length)] : CAGES[0];
            teleport({
              kind: "pillory",
              arrive: { x: cage[0], y: cage[1], z: cage[2] },
              teleportRefusal: "You can't unlock the pillory, you'll let all the criminals out!",
              onStart: start,
            });
          }],
          ["I'm not coming.", () => {}],
        ],
      });
    },
  };

  function start(session) {
    session.data.locks = 3;
    session.data.opened = 0;
    session.interfaceId = GROUP;
    const player = session.player;
    const target = KEY_MODELS[Math.floor(Math.random() * KEY_MODELS.length)];
    session.data.target = target;
    const keys = shuffled([target, ...shuffled(KEY_MODELS.filter(model => model !== target)).slice(0, 2)]);
    session.data.keys = keys;
    const sender = player.getPacketSender();
    sender.sendInterface(GROUP);
    sender.sendInterfaceRawModel((GROUP << 16) | LOCK, target);
    KEYS.forEach((component, index) => sender.sendInterfaceRawModel((GROUP << 16) | component, keys[index]));
    for (const component of BUTTONS) {
      sender.sendInterfaceFlagsRange((GROUP << 16) | component, -1, -1, 1 << SELECT_ACTION);
    }
    drawLocks(session);
  }

  function drawLocks(session) {
    const sender = session.player.getPacketSender();
    const remaining = session.data.locks - session.data.opened;
    LOCKS.forEach((component, index) => {
      sender.sendInterfaceRawModel((GROUP << 16) | component, LOCK_MODEL);
      sender.sendInterfaceDisplayState((GROUP << 16) | component, index >= remaining);
    });
  }

  function shuffled(values) {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));

  api.onInterfaceActionClick(event => {
    const { player, buttonId } = event;
    if ((buttonId >>> 16) !== GROUP) return;
    const index = BUTTONS.indexOf(buttonId & 0xffff);
    if (index < 0) return;
    event.handled = true;
    const session = Teleports.sessionOf(player);
    if (event.action !== SELECT_ACTION || !session || session.kind !== "pillory" || !session.data.keys) return;
    if (session.data.keys[index] !== session.data.target) {
      session.data.locks = Math.min(6, session.data.locks + 1);
      session.data.opened = 0;
      const flash = FLASHES[Math.min(LOCKS.length - 1, session.data.locks - 1)];
      player.getPacketSender().sendInterfaceAnimation((GROUP << 16) | flash, 4134);
      drawLocks(session);
      player.sendMessage("That key doesn't fit. Another lock is added!");
      return;
    }
    session.data.opened++;
    if (session.data.opened >= session.data.locks) {
      if (player.getInterfaceId?.() === GROUP) player.getPacketSender().sendInterfaceRemoval();
      reward(session);
      return;
    }
    drawLocks(session);
    player.sendMessage(`The key turns with a click. ${session.data.locks - session.data.opened} locks to go.`);
  });

  function reward(session) {
    const player = session.player;
    const table = [[995, 20, 10], [995, 40, 10], [995, 80, 6], [995, 160, 10], [995, 320, 10], [995, 640, 10],
      [I.UNCUT_SAPPHIRE, 1, 32], [I.UNCUT_EMERALD, 1, 16], [I.UNCUT_RUBY, 1, 8], [I.UNCUT_DIAMOND, 1, 2]];
    if (api.core.WorldDefinition.isMembersWorld()) {
      table.push([I.COSMIC_TALISMAN, 1, 4], [I.TOOTH_HALF_OF_KEY, 1, 1], [I.LOOP_HALF_OF_KEY, 1, 1]);
    } else {
      table.push([995, 80, 4], [995, 640, 2]);
    }
    let choice = Math.floor(Math.random() * 120);
    let reward = table[0];
    for (const entry of table) {
      if (choice < entry[2]) { reward = entry; break; }
      choice -= entry[2];
    }
    player.sendMessage("You wriggle free of the pillory!");
    Teleports.finish(session, { reward: [{ id: reward[0], amount: reward[1] }] });
  }
};
