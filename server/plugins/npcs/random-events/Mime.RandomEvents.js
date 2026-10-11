"use strict";

// Mime (random event, Mysterious Old Man): copy the mime's emote four times. The eight
// buttons of cache interface 188 (macro_mime_emotes) are built by the cache's own onLoad;
// the server only enables them and receives the "Perform" clicks. Outfit pieces in order,
// then lamps. See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const GROUP = 188;
const FIRST_BUTTON = 2;
// Component 2..9 in the order the cache's onLoad assigns them.
const EMOTES = [
  { name: "Think", animation: 857 },
  { name: "Laugh", animation: 861 },
  { name: "Climb rope", animation: 1130 },
  { name: "Glass box", animation: 1131 },
  { name: "Cry", animation: 860 },
  { name: "Dance", animation: 866 },
  { name: "Lean", animation: 1129 },
  { name: "Glass wall", animation: 1128 },
];
const CHEER = 862;
const CRY = 860;
const OUTFIT = [3057, 3058, 3059, 3060, 3061];
const NEEDED = 4;

module.exports = function attach(api, Events) {
  const I = api.core.ItemIdentifiers;
  const N = api.core.NpcIdentifiers;

  const definition = {
    id: N.MYSTERIOUS_OLD_MAN_5, // 6753, the mime invitation variant
    kind: "mime",
    greeting: "Hello?",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: definition.id,
        lines: [`Hey, ${player.getUsername()}, would you like to come and perform in a mime show?`],
        options: [
          ["Yeah, I'd love to do a mime show.", () => teleport({
            kind: "mime",
            arrive: { x: 2010, y: 4755, z: 0 },
            teleportRefusal: "I need to finish my performance!",
            onStart: start,
          })],
          ["Sorry, I'm busy.", () => {}],
        ],
      });
    },
  };

  function start(session) {
    session.data.correct = 0;
    const sender = session.player.getPacketSender();
    session.interfaceId = GROUP;
    sender.sendInterface(GROUP);
    for (let component = FIRST_BUTTON; component < FIRST_BUTTON + EMOTES.length; component++) {
      sender.sendInterfaceFlagsRange((GROUP << 16) | component, -1, -1, 1 << 1);
    }
    nextEmote(session);
  }

  function nextEmote(session) {
    const emote = EMOTES[Math.floor(Math.random() * EMOTES.length)];
    session.data.emote = emote;
    const mime = findMime(session);
    if (mime) mime.performAnimation(new api.core.Animation(emote.animation));
    else session.player.sendMessage(`The mime performs: ${emote.name}.`);
  }

  function findMime(session) {
    const player = session.player;
    const location = player.getLocation();
    const npcs = api.getWorld?.()?.getNpcsNear?.(location, 15, player.getPrivateArea?.() ?? null) ?? [];
    return npcs.find(npc => npc.getId?.() === N.MIME);
  }

  function choose(event) {
    const { player, buttonId } = event;
    if ((buttonId >>> 16) !== GROUP) return;
    const index = (buttonId & 0xffff) - FIRST_BUTTON;
    if (index < 0 || index >= EMOTES.length) return;
    event.handled = true;
    const session = Teleports.sessionOf(player);
    if (event.action !== 1 || !session || session.kind !== "mime" || !session.data.emote) return;
    if (EMOTES[index] !== session.data.emote) {
      player.performAnimation(new api.core.Animation(CRY));
      player.sendMessage("That's not the emote the mime is performing.");
      return;
    }
    player.performAnimation(new api.core.Animation(CHEER));
    session.data.correct++;
    if (session.data.correct >= NEEDED) {
      finish(session);
      return;
    }
    nextEmote(session);
  }

  function finish(session) {
    const player = session.player;
    const rewards = [];
    const missing = OUTFIT.find(piece => !Teleports.owns(player, piece));
    if (missing !== undefined) {
      rewards.push({ id: missing, amount: 1 });
      player.sendMessage("The mime gives you a piece of the mime outfit.");
    } else {
      rewards.push({ id: I.LAMP, amount: 1 });
      player.sendMessage("The mime gives you a lamp.");
    }
    if (player.getInterfaceId?.() === GROUP) player.getPacketSender().sendInterfaceRemoval();
    Teleports.finish(session, { reward: rewards });
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));
  api.onInterfaceActionClick(choose);

  api.onObjectInteraction("Large door", { Open: blockDoor, Close: blockDoor, Walk: blockDoor });

  function blockDoor(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "mime") return false;
    event.handled = true;
    event.player.sendMessage("I need to finish my performance!");
    return true;
  }
};
