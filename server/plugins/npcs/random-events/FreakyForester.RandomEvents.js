"use strict";

// Freaky Forester (random event): kill a pheasant and bring the raw pheasant back, then leave
// through the portal for a lederhosen piece (hat, top, shorts), or a lamp once the outfit is
// complete. Since 2020 any pheasant carcass is accepted, so every pheasant drops the same
// item. See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const PHEASANTS = [373, 374, 5497, 5498, 5499, 5500, 5501, 5502];
const OUTFIT = [6182, 6180, 6181];
const PORTAL = 20843;

module.exports = function attach(api, Events) {
  const I = api.core.ItemIdentifiers;
  const N = api.core.NpcIdentifiers;

  const definition = {
    id: N.FREAKY_FORESTER_2,
    kind: "forester",
    greeting: "Hello?",
    talk(active, { teleport }) {
      const { player } = active;
      Flow.chat(api, {
        player,
        npcId: active.definition.id,
        lines: [`Hey, ${player.getUsername()}, can you come and help me with some pheasants?`],
        options: [
          ["Okay, I'll help with your pheasants.", () => teleport({
            kind: "forester",
            arrive: { x: 2599, y: 4775, z: 0 },
            teleportRefusal: "Use the portal to leave the forest!",
            onStart: start,
          })],
          ["Sorry, I'm busy.", () => {}],
        ],
      });
    },
  };

  function start(session) {
    const tails = [2, 3, 4][Math.floor(Math.random() * 3)];
    session.data.tails = tails;
    session.data.done = false;
    session.player.sendMessage(`Kill a pheasant with ${tails} tails, then bring the raw pheasant to the forester.`);
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition));

  api.onNpcClick(PHEASANTS, 1, attackPheasant);
  api.onNpcClick(PHEASANTS, 2, attackPheasant);

  function attackPheasant(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "forester") return false;
    if (session.data.done) {
      event.player.sendMessage("You don't need to attack any more pheasants. You're allowed to leave.");
      event.handled = true;
      return true;
    }
    if (session.player.getInventory().containsNumber(I.RAW_PHEASANT_3)) {
      event.player.sendMessage("You already have a pheasant carcass. You don't need to kill another.");
      event.handled = true;
      return true;
    }
    event.handled = true;
    const npc = event.npc;
    session.player.performAnimation(new api.core.Animation(422));
    npc.forceChat("Squawk!");
    npc.setHitpoints(0);
    const manager = api.getItemOnGroundManager();
    manager.registerLocation(session.player, new api.core.Item(I.RAW_PHEASANT_3, 1), npc.getLocation().clone());
    session.player.sendMessage("You kill the pheasant.");
    return true;
  }

  api.onNpcInteraction("Freaky Forester", {
    "Talk-to": event => {
      const session = Teleports.sessionOf(event.player);
      if (!session || session.kind !== "forester" || event.npc.getId?.() !== N.FREAKY_FORESTER) return false;
      const player = event.player;
      if (session.data.done) {
        Flow.chat(api, { player, npcId: N.FREAKY_FORESTER,
          lines: [`Okay, ${player.getUsername()}, you can leave the area now.`] });
        event.handled = true;
        return true;
      }
      if (player.getInventory().containsNumber(I.RAW_PHEASANT_3)) {
        player.getInventory().delete(I.RAW_PHEASANT_3, 1);
        session.data.done = true;
        Flow.chat(api, { player, npcId: N.FREAKY_FORESTER,
          lines: [`Thanks, ${player.getUsername()}, you may use the portal to leave the area now.`] });
        event.handled = true;
        return true;
      }
      Flow.chat(api, {
        player,
        npcId: N.FREAKY_FORESTER,
        lines: [`Could you kill a pheasant with ${session.data.tails} tails, please?`,
          "Bring me the raw pheasant when you're done."],
      });
      event.handled = true;
      return true;
    },
  });

  api.onObjectInteraction("Exit portal", { Use: usePortal });

  function usePortal(event) {
    const session = Teleports.sessionOf(event.player);
    if (!session || session.kind !== "forester") return false;
    event.handled = true;
    if (!session.data.done) {
      Teleports.finish(session, { message: "You leave the forest without helping the forester." });
      return true;
    }
    const rewards = [{ id: I.LAMP, amount: 1 }];
    const missing = OUTFIT.find(piece => !Teleports.owns(event.player, piece));
    if (missing !== undefined) {
      rewards.length = 0;
      rewards.push({ id: missing, amount: 1 });
      event.player.sendMessage("You get a piece of the lederhosen outfit for your help, many thanks!");
    } else {
      event.player.sendMessage("You get a lamp for your help, many thanks!");
    }
    Teleports.finish(session, { reward: rewards });
    return true;
  }
};
