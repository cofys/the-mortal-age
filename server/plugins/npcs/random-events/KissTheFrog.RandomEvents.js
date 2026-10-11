"use strict";

// Kiss the frog (random event), current OSRS behaviour: a group of frogs appears, the crowned
// royal asks for a touch, kiss or pat, and thanks the player with a frog token. Refusing
// rudely turns the player into a frog and sends them to Frogland, where the royal lets them
// leave. Tokens are traded with Thessalia for the frog mask, royal costume pieces or a lamp.
// See SOURCES.md.
const Flow = require("./DialogueFlow.RandomEvents");
const Teleports = require("./Teleports.RandomEvents");

const POSITIVE = ["Okay.", "Sure, I will.", "Very well, if a touch is all you need, I'll do it.",
  "Yes, I will touch you.", "How about if we kiss?", "May I kiss you instead?",
  "Would a kiss be acceptable?"];
const POLITE_REFUSALS = ["I would prefer not to, sorry.", "I'm sorry, I'd prefer not to do that."];
const RUDE_REFUSALS = ["No way, I'm not kissing you.", "Eww, no way!", "I'd rather become a frog too!"];

function pick(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

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
  const returnFrogs = new Map();

  function definition() {
    return {
      ids: [N.FROG_PRIN, N.FROG_PRIN_2, N.FROG_PRINCE, N.FROG_PRINCESS],
      kind: "frog",
      greeting: "Greetings from the royal frog,",
      stationary: true,
      onSpawn(active) {
        // A small chorus of uncrowned frogs, removed with the event.
        const { Location } = api.core;
        const at = active.npc.getLocation();
        active.chorus = [];
        for (const [dx, dy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
          const location = new Location(at.getX() + dx, at.getY() + dy, at.getZ());
          if (api.getRegionManager().blocked(location, active.player.getPrivateArea?.())) continue;
          const npc = api.spawnNpc({ id: N.FROG_6 + Math.floor(Math.random() * 3),
            x: location.getX(), y: location.getY(), z: location.getZ(), owner: active.player, wanderRadius: 0 });
          if (npc) active.chorus.push(npc);
        }
      },
      onFinish(active) {
        for (const npc of active.chorus ?? []) api.removeNpc(npc);
      },
      talk(active, helpers) {
        const options = [
          [pick(POSITIVE), () => accept(active, helpers)],
          [pick(POLITE_REFUSALS), () => refuse(active, helpers)],
          [pick(RUDE_REFUSALS), () => transform(active, helpers)],
        ];
        Flow.chat(api, {
          player: active.player,
          npcId: active.definition.id,
          lines: ["Please help me. I was transformed into a frog.",
            "Only your touch can turn me back. Will you help me?"],
          options: shuffled(options),
        });
      },
    };
  }

  function accept(active, { serve }) {
    if (serve(active, [I.FROG_TOKEN])) {
      active.player.sendMessage("The royal frog gives you a token of thanks.");
    }
  }

  function refuse(active, { finish }) {
    finish(active);
    active.player.sendMessage("The frogs hop away, looking a little disappointed.");
  }

  function transform(active, { teleport }) {
    const player = active.player;
    teleport({
      kind: "frogland",
      arrive: { x: 2464, y: 4780, z: 0 },
      teleportRefusal: "You'll have to talk to the royal frog first.",
      onStart(session) {
        player.setNpcTransformationId(N.FROG_6);
        player.forceChat("Ribbit!");
        player.sendMessage("You have been turned into a frog and taken to Frogland.");
        Teleports.onEnd(session, () => player.setNpcTransformationId(-1));
        const royal = Teleports.spawnNpc(session, { id: N.FROG_PRINCE, x: 2462, y: 4780, z: 0, wanderRadius: 0 });
        session.royal = royal;
        if (royal) returnFrogs.set(royal, session);
        Flow.chat(api, {
          player,
          npcId: N.FROG_PRINCE,
          lines: [`Welcome to Frogland, ${player.getUsername()}.`, "Are you ready to leave now?"],
          options: [
            ["Yes, I'd like to leave now.", () => leaveFrogland(session)],
            ["No, I'd rather stay.", () => {}],
          ],
        });
      },
    });
  }

  function leaveFrogland(session) {
    const { player } = session;
    returnFrogs.delete(session.royal);
    player.setNpcTransformationId(-1);
    Teleports.finish(session, { message: "You return to your normal self." });
  }

  api.onCustomEvent(Events.DEFINITIONS_EVENT, payload => payload.definitions.push(definition()));

  api.onNpcInteraction("Frog", {
    "Talk-to": event => {
      const session = returnFrogs.get(event.npc);
      if (!session || session.player !== event.player) return Events.talk(event);
      Flow.chat(api, {
        player: event.player,
        npcId: N.FROG_PRINCE,
        lines: ["Are you ready to leave now?"],
        options: [
          ["Yes, I'd like to leave now.", () => leaveFrogland(session)],
          ["No, I'd rather stay.", () => {}],
        ],
      });
      event.handled = true;
      return true;
    },
  });

  api.onNpcInteraction("Thessalia", { "Talk-to": thessalia });

  function thessalia(event) {
    const { player } = event;
    if (!player.getInventory().containsNumber(I.FROG_TOKEN)) return false;
    const exchange = (rewards, message) => {
      if (!player.getInventory().containsNumber(I.FROG_TOKEN)) return;
      player.getInventory().delete(I.FROG_TOKEN, 1);
      for (const reward of rewards) player.getInventory().addItem(new api.core.Item(reward.id, reward.amount ?? 1));
      player.sendMessage(message);
    };
    Flow.chat(api, {
      player,
      npcId: N.THESSALIA,
      lines: ["That entitles you to a free costume! What would you like?"],
      options: [
        ["A frog mask, please.", () => exchange([{ id: I.FROG_MASK }], "You receive a frog mask.")],
        ["The royal tunic and leggings.", () => exchange(
          [{ id: I.ROYAL_FROG_TUNIC }, { id: I.ROYAL_FROG_LEGGINGS }],
          "You receive the royal tunic and leggings.")],
        ["The royal blouse and skirt.", () => exchange(
          [{ id: I.ROYAL_FROG_BLOUSE }, { id: I.ROYAL_FROG_SKIRT }],
          "You receive the royal blouse and skirt.")],
        ["A lamp instead.", () => exchange([{ id: I.LAMP }], "You receive a lamp.")],
      ],
    });
    event.handled = true;
    return true;
  }
};
