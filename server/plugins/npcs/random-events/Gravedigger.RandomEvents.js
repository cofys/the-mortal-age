"use strict";

// Gravedigger (random event, Leo): dig up the five coffins, read the gravestones and bury
// each coffin in the grave whose headstone names its profession. Zombie outfit pieces come in
// twos until the set is complete, then the zombie emotes and lamps. See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const PROFESSIONS = ["cook", "farmer", "lumberjack", "miner", "potter"];
const FILLED_GRAVES = [9364, 9365, 9366, 9367, 10049];
const EMPTY_GRAVE = 10050;
const GRAVE_TILES = [[1924, 4996], [1926, 4999], [1928, 4996], [1930, 4999], [1932, 4996]];
const STONE_TILES = [[1924, 4998], [1926, 5001], [1928, 4998], [1930, 5001], [1932, 4998]];
const COFFINS = [7587, 7588, 7589, 7590, 7591];
const ZOMBIE = [13283, 13284, 13285, 13286, 13287];
const MAUSOLEUM = 10055;
const LEO_TILE = [1928, 5008];

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
  const { GameObject, Location, ObjectManager } = api.core;

  const definition = {
    id: N.LEO_2,
    kind: "gravedigger",
    greeting: "Hello,",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: active.definition.id,
        lines: [`Can you come and help me, ${player.getUsername()}? I've got a problem with some graves.`],
        options: [
          ["Okay, I'll help with your graves.", () => teleport({
            kind: "gravedigger",
            arrive: { x: 1928, y: 5007, z: 0 },
            teleportRefusal: "Talk to Leo when you want to leave.",
            onStart: start,
          })],
          ["Sorry, I'm busy.", () => {}],
        ],
      });
    },
  };

  function start(session) {
    session.data.professions = shuffled(PROFESSIONS);
    session.data.buried = new Map();
    session.data.removed = new Set();
    session.leo = Teleports.spawnNpc(session, { id: N.LEO, x: LEO_TILE[0], y: LEO_TILE[1], z: 0,
      wanderRadius: 0 });
    session.player.sendMessage("Take the coffin from each grave, check it and bury it in the right grave.");
  }

  function graveIndex(location) {
    return GRAVE_TILES.findIndex(([x, y]) => x === location.getX() && y === location.getY());
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));

  api.onObjectInteraction("Grave", { "Take-Coffin": takeCoffin });

  function takeCoffin(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "gravedigger") return false;
    event.handled = true;
    const object = event.object;
    const index = graveIndex(object.getLocation());
    if (index < 0 || session.data.removed.has(index)) {
      event.player.sendMessage("There is nothing left in this grave.");
      return true;
    }
    session.data.removed.add(index);
    Teleports.replaceObject(object, EMPTY_GRAVE + index);
    const item = COFFINS[PROFESSIONS.indexOf(session.data.professions[index])];
    event.player.getInventory().addItem(new api.core.Item(item, 1));
    event.player.sendMessage("You dig up a coffin.");
    return true;
  }

  api.onObjectInteraction("Gravestone", { Read: readStone });

  function readStone(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "gravedigger") return false;
    event.handled = true;
    const index = STONE_TILES.findIndex(([x, y]) =>
      x === event.object.getLocation().getX() && y === event.object.getLocation().getY());
    if (index < 0) return true;
    event.player.sendMessage(`This grave is for a ${session.data.professions[index]}.`);
    return true;
  }

  api.onItemOnObject(itemOnGrave);

  function itemOnGrave(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "gravedigger") return false;
    const itemId = event.itemId ?? event.sourceItemId;
    const index = COFFINS.indexOf(itemId);
    if (index < 0) return false;
    const object = event.object;
    if (!object || !(object.getId() >= EMPTY_GRAVE && object.getId() <= EMPTY_GRAVE + 4)) return false;
    event.handled = true;
    const grave = graveIndex(object.getLocation());
    if (grave < 0) return true;
    if (session.data.professions[grave] !== PROFESSIONS[index]) {
      event.player.sendMessage("That doesn't seem right. Read the gravestone to check who belongs here.");
      return true;
    }
    session.player.getInventory().delete(itemId, 1);
    session.data.buried.set(grave, PROFESSIONS[index]);
    session.player.sendMessage("You bury the coffin in the correct grave.");
    return true;
  }

  api.onItemAction("Coffin", { Check: checkCoffin });

  function checkCoffin(event) {
    const index = COFFINS.indexOf(event.itemId);
    if (index < 0) return false;
    Flow.itemStatement(api, event.player, event.itemId,
      `The coffin holds the remains of a ${PROFESSIONS[index]}.`);
    return true;
  }

  api.onNpcInteraction("Leo", {
    "Talk-to": event => {
      const session = Teleports.sessionOf(event.player);
      if (!session || session.kind !== "gravedigger" || event.npc !== session.leo) return false;
      const player = event.player;
      const complete = session.data.buried.size === PROFESSIONS.length;
      Flow.chat(api, {
        player,
        npcId: N.LEO,
        lines: complete
          ? ["Wonderful! That's taken care of them. I'll take you back, and give you your reward."]
          : ["I need you to pick up the coffin from each grave, see who's inside it,",
            "and bury it in the grave with the correct gravestone."],
        options: [
          ["I think I've finished!", () => {
            if (!complete) {
              player.sendMessage("That's a good attempt, but it's just not right. Keep looking.");
              return;
            }
            reward(session);
          }],
          ["Remind me what I'm supposed to do.", () => Flow.chat(api, {
            player, npcId: N.LEO,
            lines: ["Pick up the coffins. Check the body inside. Find out where they need to be buried.",
              "Put all five coffins in the correct graves."],
          })],
          ["I want to leave now.", () => Teleports.finish(session,
            { message: "In that case, I'll take you back to where I found you." })],
        ],
      });
      event.handled = true;
      return true;
    },
  });

  function reward(session) {
    const player = session.player;
    const missing = ZOMBIE.filter(piece => !Teleports.owns(player, piece)).slice(0, 2);
    const rewards = missing.length
      ? missing.map(piece => ({ id: piece, amount: 1 }))
      : [{ id: I.LAMP, amount: 1 }];
    player.sendMessage(missing.length
      ? "Leo hands you some zombie outfit pieces."
      : "Leo hands you a lamp.");
    Teleports.finish(session, { reward: rewards });
  }
};
