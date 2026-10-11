"use strict";

// Maze (random event, Mysterious Old Man): reach the strange shrine before the reward
// potential drains, opening chests for loot at the cost of 1% each. The reward scales with
// total level and remaining potential. Varp 531 drives the cache's reward HUD (interface
// 209). See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const POTENTIAL_VARP = 531;
const DRAIN_MS = 3_000;
const CHEST_CLOSED = 14986;
const CHEST_OPEN = 14988;
const CHEST_LOOT = [
  [556, 15], [555, 10], [557, 10], [554, 10], [819, 20], [877, 10], [884, 15],
  [121, 1], [115, 1], [127, 1],
];
// Coins, feather, iron arrow, chaos rune, steel arrow, death rune, coal, mithril ore, nature rune.
const SHRINE_LOOT = [[995, 1], [314, 2], [884, 3], [562, 9], [886, 12], [560, 18],
  [453, 45], [447, 162], [561, 180]];

module.exports = function attach(api, Events) {
  const N = api.core.NpcIdentifiers;

  const definition = {
    id: N.MYSTERIOUS_OLD_MAN_4, // 6752, the maze invitation variant
    kind: "maze",
    greeting: "Hello?",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: definition.id,
        lines: [`Hey, ${player.getUsername()}, would you like to come and solve a maze for me?`],
        options: [
          ["Sure, I like exploring mazes.", () => teleport({
            kind: "maze",
            arrive: { x: 2898, y: 4595, z: 0 },
            teleportRefusal: "You need to reach the centre of the maze!",
            onStart: start,
          })],
          ["Sorry, I'm busy.", () => {}],
        ],
      });
    },
  };

  function start(session) {
    session.data.potential = 100;
    session.data.startedAt = Date.now();
    session.data.chests = new Map();
    session.tick = tick;
    const sender = session.player.getPacketSender();
    sender.sendConfig(POTENTIAL_VARP, 100);
    session.player.sendMessage("Reach the maze centre as fast as possible. The faster you are, the better your reward.");
  }

  function tick(session) {
    const potential = 100 - Math.floor((Date.now() - session.data.startedAt) / DRAIN_MS);
    if (potential <= 0) {
      session.player.getPacketSender().sendConfig(POTENTIAL_VARP, 0);
      Teleports.finish(session, { message: "You run out of time and the maze teleports you out." });
      return;
    }
    if (potential !== session.data.potential) {
      session.data.potential = potential;
      session.player.getPacketSender().sendConfig(POTENTIAL_VARP, potential);
    }
    for (const [key, chest] of session.data.chests) {
      if (Date.now() >= chest.closeAt) {
        Teleports.replaceObject(chest.object, CHEST_CLOSED);
        session.data.chests.delete(key);
      }
    }
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));

  api.onObjectInteraction("Chest", { Open: openChest });

  function openChest(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "maze") return false;
    event.handled = true;
    const object = event.object;
    if (object.getId() !== CHEST_CLOSED) return true;
    const player = event.player;
    const location = object.getLocation();
    const key = `${location.getX()},${location.getY()}`;
    const loot = CHEST_LOOT[Math.floor(Math.random() * CHEST_LOOT.length)];
    player.getInventory().addItem(new api.core.Item(loot[0], loot[1]));
    session.data.potential = Math.max(0, session.data.potential - 1);
    player.getPacketSender().sendConfig(POTENTIAL_VARP, session.data.potential);
    const replacement = Teleports.replaceObject(object, CHEST_OPEN);
    // The chest shuts again after a minute, as OSRS does; the maze tick closes it.
    session.data.chests.set(key, { object: replacement, closeAt: Date.now() + 60_000 });
    return true;
  }

  api.onObjectInteraction("Strange shrine", { Touch: touchShrine });

  function touchShrine(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "maze") return false;
    event.handled = true;
    const player = event.player;
    player.getPacketSender().sendConfig(POTENTIAL_VARP, 0);
    // Three rolls scaled by Total level x potential, as the OSRS formula does.
    const totalLevel = player.getSkillManager?.().getTotalLevel?.() ??
      player.getSkillManager().getTotalLevel?.() ?? 0;
    const scale = Math.max(0, Math.floor(totalLevel * (session.data.potential / 100) * (10 / 3)));
    const rewards = [];
    for (let roll = 0; roll < 3; roll++) {
      const [item, divisor] = SHRINE_LOOT[Math.floor(Math.random() * SHRINE_LOOT.length)];
      const amount = Math.max(1, Math.floor(scale / divisor));
      rewards.push({ id: item, amount });
    }
    player.sendMessage("You touch the strange shrine.");
    Teleports.finish(session, { reward: rewards });
    return true;
  }
};
