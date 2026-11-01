/**
 * Enter the Abyss (miniquest).
 *
 * Quest Helper (helpers/quests/entertheabyss/EnterTheAbyss.java, pinned
 * 06da90f982518a093f2fe1c9cfac5547fa7053d3) drives varp 492 through:
 *   0  speak to the Mage of Zamorak in the Wilderness north of Edgeville
 *   1  meet him at the Chaos Temple in south-east Varrock
 *   2  carry the scrying orb into the Rune Essence Mine from three different wizards
 *   3  return the charged orb to the Chaos Temple
 *   4  complete (cache quest DB row 43, column 19)
 *
 * The five teleports it records are cache varbits rcu_essencespot_* (2314-2318),
 * which live in varp 491 (abyssal_warp), separate from the miniquest varp. The
 * orb is SCRYING_ORB_2 (5519) empty and SCRYING_ORB (5518) charged; the rewards
 * are 1,000 Runecraft experience, ABYSSAL_BOOK (5520) and SMALL_POUCH (5509).
 *
 * The Rune Essence teleports themselves belong to plugins/skills/Runecrafting:
 * its travel emits "teleport:landed" with where the player cast from, which is
 * how a reading is attributed to Aubury, Sedridor, Cromperty, Brimstail or
 * Distentor. The same plugin gates the Abyss teleport on this miniquest.
 */
module.exports = function registerEnterTheAbyssQuest(api) {
  const {
    DialogueChainBuilder,
    Item,
    ItemIdentifiers: Items,
    ItemStatementDialogue,
    NpcIdentifiers: Npcs,
    Skill,
    StatementDialogue,
  } = api.core;
  const { openBook, registerQuest, startDialogue } = require("../QuestRuntime");
  const abyssalBook = require("../data/abyssal-book");

  const VARP_ABYSSAL_MINQUEST = 492;
  const STAGE_NOT_STARTED = 0;
  const STAGE_MEET_IN_VARROCK = 1;
  const STAGE_COLLECTING = 2;
  const STAGE_READY = 3;
  const STAGE_COMPLETE = 4;

  const ORB_EMPTY = Items.SCRYING_ORB_2; // 5519
  const ORB_FULL = Items.SCRYING_ORB; // 5518
  const ABYSSAL_BOOK = Items.ABYSSAL_BOOK; // 5520
  const SMALL_POUCH = Items.SMALL_POUCH; // 5509
  const RUNECRAFT_XP = 1000;

  const READINGS_ATTRIBUTE = "enter-the-abyss:readings";
  const OFFER_MADE_ATTRIBUTE = "enter-the-abyss:offer-made";
  const PENDING_REWARDS_ATTRIBUTE = "enter-the-abyss:pending-rewards";

  // The cache's quest row is "Enter the Abyss"; Rune Mysteries is quest 125.
  const RUNE_MYSTERIES_KEY = "rune_mysteries";

  // Cache NPCs: 2580/2581 and the spawned 3228 are the Wilderness mage;
  // 2582 and the spawned 3229 are the Chaos Temple mage. 7425 is the unrelated
  // Mage of Zamorak at the Ourania Cave and must not be claimed.
  const WILDERNESS_MAGE_IDS = new Set([
    Npcs.MAGE_OF_ZAMORAK, // 2580
    Npcs.MAGE_OF_ZAMORAK_2, // 2581
    3228,
  ]);
  const VARROCK_MAGE_IDS = new Set([
    Npcs.MAGE_OF_ZAMORAK_3, // 2582
    3229,
  ]);
  // Temple of the Eye spawns its own private 2580 at the chapel; the same cache
  // id as the Wilderness mage, so the tiles distinguish the two.
  const WILDERNESS_MAGE_TILE = { x: 3106, y: 3558 };
  const CHAPEL_MAGE_TILE = { x: 3260, y: 3383 };
  const MAGE_TILE_RADIUS = 8;

  // Varbit ids are the cache's rcu_essencespot_* bits (varp 491).
  const ESSENCE_SPOTS = [
    { key: "wizardstower", varbit: 2314, x: 3103, y: 9571, label: "Archmage Sedridor" },
    { key: "aubury", varbit: 2315, x: 3253, y: 3402, label: "Aubury" },
    { key: "cromperty", varbit: 2316, x: 2683, y: 3326, label: "Wizard Cromperty" },
    { key: "brimstail", varbit: 2317, x: 2409, y: 9817, label: "Brimstail" },
    { key: "wizardsguild", varbit: 2318, x: 2594, y: 3089, label: "Wizard Distentor" },
  ];
  const ESSENCE_MINE = { x: 2913, y: 4832 };
  const SOURCE_RADIUS = 8;
  const DESTINATION_RADIUS = 4;

  let quest;

  const inventory = (player) => player.getInventory();
  const has = (player, itemId) => inventory(player).getAmount(itemId) > 0;
  const banked = (player, itemId) => {
    const banks = player.getBanks?.() ?? (player.getBank ? [player.getBank()] : []);
    return banks.some((bank) => Number(bank?.getAmount?.(itemId) ?? 0) > 0);
  };
  const owns = (player, itemId) => has(player, itemId) || banked(player, itemId);

  function questComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function coord(location) {
    if (!location) return null;
    const x = typeof location.getX === "function" ? location.getX() : location.x;
    const y = typeof location.getY === "function" ? location.getY() : location.y;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function near(location, point, radius) {
    const at = coord(location);
    return at !== null && Math.abs(at.x - point.x) <= radius && Math.abs(at.y - point.y) <= radius;
  }

  /** `varrock` or `wilderness` for a Mage of Zamorak, by where the NPC stands. */
  function mageKind(event) {
    const at = event?.npc?.getLocation?.() ?? event?.player?.getLocation?.() ?? null;
    if (near(at, CHAPEL_MAGE_TILE, MAGE_TILE_RADIUS)) return "varrock";
    if (near(at, WILDERNESS_MAGE_TILE, MAGE_TILE_RADIUS)) return "wilderness";
    if (VARROCK_MAGE_IDS.has(event?.npcId)) return "varrock";
    if (WILDERNESS_MAGE_IDS.has(event?.npcId)) return "wilderness";
    return null;
  }

  function readings(player) {
    const value = player.getAttribute(READINGS_ATTRIBUTE);
    if (!Array.isArray(value)) return [];
    return ESSENCE_SPOTS.filter((spot) => value.includes(spot.key)).map((spot) => spot.key);
  }

  /** A worn Saradomin or Guthix item stops both mages talking (Wiki). */
  function wornGodItem(player) {
    const items = player.getEquipment?.()?.getItems?.() ?? [];
    for (const item of items) {
      const id = item?.getId?.() ?? -1;
      if (!(id > 0)) continue;
      const name = String(api.core.ItemDefinition?.forId(id)?.getName?.() ?? "");
      if (/saradomin/i.test(name) || /^holy book$/i.test(name) || /^staff of light$/i.test(name)) {
        return "saradomin";
      }
      if (/guthix/i.test(name) || /^book of balance$/i.test(name)) return "guthix";
    }
    return null;
  }

  function showStatement(player, text) {
    player.getDialogueManager().startDialogues(
      new DialogueChainBuilder().add(new StatementDialogue(0, text))
    );
  }

  function showItemStatement(player, itemId, text) {
    player.getDialogueManager().startDialogues(
      new DialogueChainBuilder().add(new ItemStatementDialogue(0, itemId, text))
    );
  }

  function itemName(itemId) {
    return String(api.core.ItemDefinition?.forId(itemId)?.getName?.() ?? "item").toLowerCase();
  }

  function givePendingRewards(player) {
    const pending = Array.isArray(player.getAttribute(PENDING_REWARDS_ATTRIBUTE))
      ? player.getAttribute(PENDING_REWARDS_ATTRIBUTE)
      : [];
    const remaining = [];
    const given = [];
    for (const itemId of pending) {
      if (itemId !== ABYSSAL_BOOK && itemId !== SMALL_POUCH) continue;
      if (inventory(player).getFreeSlots() > 0) {
        inventory(player).adds(itemId, 1);
        given.push(itemId);
      } else {
        remaining.push(itemId);
      }
    }
    player.setAttribute(PENDING_REWARDS_ATTRIBUTE, remaining);
    return { given, remaining };
  }

  function reward(player) {
    player.getSkillManager().addExperiences(Skill.RUNECRAFTING, RUNECRAFT_XP);
    const pending = [];
    for (const itemId of [ABYSSAL_BOOK, SMALL_POUCH]) {
      if (inventory(player).getFreeSlots() > 0) inventory(player).adds(itemId, 1);
      else pending.push(itemId);
    }
    if (pending.length > 0) {
      player.setAttribute(PENDING_REWARDS_ATTRIBUTE, pending);
      player.sendMessage("You do not have enough inventory space for all of the Mage's rewards.");
      player.sendMessage("Speak to the Mage of Zamorak again when you have some free space.");
    }
  }

  /** Turns the carried empty orb into the charged one, in the same slot. */
  function chargeOrb(player) {
    const items = inventory(player).getItems();
    const slot = items.findIndex((item) => item?.getId?.() === ORB_EMPTY);
    if (slot < 0) return false;
    inventory(player).setItem(slot, new Item(ORB_FULL, 1));
    return true;
  }

  function recordReading(player, spot) {
    const current = readings(player);
    if (current.includes(spot.key)) return;
    const next = [...current, spot.key];
    player.setAttribute(READINGS_ATTRIBUTE, next);
    player.getPacketSender().sendVarbit(spot.varbit, 1);
    if (next.length >= 3) {
      if (quest.getStage(player) < STAGE_READY) quest.setStage(player, STAGE_READY);
      chargeOrb(player);
    }
  }

  function acceptOffer(player) {
    if (owns(player, ORB_EMPTY) || owns(player, ORB_FULL)) {
      if (quest.getStage(player) < STAGE_COLLECTING) quest.setStage(player, STAGE_COLLECTING);
      return;
    }
    if (inventory(player).getFreeSlots() < 1) {
      showStatement(player, "The Mage of Zamorak tries to hand you an orb, but you don't have enough room to take it.");
      return;
    }
    inventory(player).adds(ORB_EMPTY, 1);
    if (quest.getStage(player) < STAGE_COLLECTING) quest.setStage(player, STAGE_COLLECTING);
    showItemStatement(player, ORB_EMPTY, "The Mage of Zamorak hands you an orb.");
  }

  function replaceOrb(player) {
    const itemId = readingCount(player) >= 3 ? ORB_FULL : ORB_EMPTY;
    if (readingCount(player) >= 3 && quest.getStage(player) < STAGE_READY) quest.setStage(player, STAGE_READY);
    if (inventory(player).getFreeSlots() < 1) {
      showStatement(player, "You don't have enough room to take another orb.");
      return;
    }
    inventory(player).adds(itemId, 1);
    showItemStatement(player, itemId, "The Mage of Zamorak hands you an orb.");
  }

  function readingCount(player) {
    return readings(player).length;
  }

  // --------------------------------------------------------------------------
  // Dialogue
  // --------------------------------------------------------------------------

  const GREETING = "You again. Have you managed to use that scrying orb to obtain the information I need?";
  const NOT_YET =
    "You must carry it with you and teleport to the Rune Essence Mine from three different locations. Return to me once you have done so.";

  const ACCEPT_DEAL = [
    { npc: ["Good. Now, all I need from you is the spell that will teleport me to the Rune Essence Mine."] },
    { player: ["Err... I don't actually know the spell."] },
    { npc: ["What? Then how do you get there."] },
    { player: ["Oh, well the people who do know the spell just teleport me there directly."] },
    {
      npc: [
        "Hmm... I see. That makes this slightly more complex, but no matter. You can still help us.",
        "I'll give you a scrying orb with a standard cypher spell cast upon it. The orb will absorb mystical energies that it is exposed to.",
        "If you teleport to the Rune Essence Mine from three different locations, the orb will absorb the energies of the spell and allow us to reverse-engineer the magic behind it.",
        "Do you know of three different people who can teleport you there?",
      ],
    },
    { player: ["Maybe?"] },
    { npc: ["Well if not, I'm sure one of those fools in the Order of Wizards can tell you. Now, here's the orb."] },
    { exec: (player) => acceptOffer(player) },
  ];

  /** The agreement's follow-up menu, as the transcript and Quest Helper list "Deal." */
  const DEAL_CHOICES = {
    options: [
      { text: "Deal.", next: ACCEPT_DEAL },
      { text: "No deal.", next: [{ npc: ["Fine. I will find another way."] }] },
      { text: "I need to think about it.", next: [{ npc: ["I will be here once you have decided."] }] },
    ],
  };

  const AGREEMENT = [
    { exec: (player) => player.setAttribute(OFFER_MADE_ATTRIBUTE, 1) },
    { npc: ["Alright, if you help us access the Rune Essence Mine, we will share our runecrafting secrets with you in return."] },
    DEAL_CHOICES,
  ];

  const OFFER = [
    {
      npc: [
        "Until recently, our runecrafting secrets allowed us to produce runes at a far superior rate compared to the inept Order of Wizards, but something has changed.",
        "From what we can gather, they've somehow rediscovered how to access the lost Rune Essence Mine.",
      ],
    },
    { player: ["Ah, well I know all about that. I was actually the one to help them do it!"] },
    { npc: ["You did what? You helped the Order of Wizards?"] },
    { player: ["Err..."] },
    {
      options: [
        { text: "Yes, but I can still help you as well.", next: [
          { npc: ["So you're a mercenary with no allegiance? Not the type I like working with, but if you have knowledge of the Rune Essence Mine, I seemingly have little choice."] },
          ...AGREEMENT,
        ] },
        { text: "I did it so that I could then steal their secrets.", next: [
          { npc: ["You did? Perhaps I underestimated you."] },
          ...AGREEMENT,
        ] },
        { text: "Okay, fine. I don't really serve Zamorak.", next: [
          { npc: ["Then give me one good reason why I shouldn't have you teleported into the depths of a volcano!"] },
          {
            options: [
              { text: "Because I can still help you.", next: [
                { npc: ["You would help both sides for your own gain? I suppose as a Zamorakian, I can respect that, even if I don't like it."] },
                ...AGREEMENT,
              ] },
              { text: "Alright, I'll leave. Just don't go teleporting me anywhere.", next: [
                { npc: ["Be glad that I am merciful! Now go!"] },
              ] },
            ],
          },
        ] },
        { text: "Alright, I'll leave. Just don't go teleporting me anywhere.", next: [
          { npc: ["Be glad that I am merciful! Now go!"] },
        ] },
      ],
    },
  ];

  const REQUEST_SHARE = [
    {
      npc: [
        "Why would I? You are not a member of our institute. How do I know you won't just go and share all of our secrets with those Saradominist fools in the Order of Wizards.",
      ],
    },
    {
      options: [
        { text: "Maybe I could make it worth your while?", next: [
          { npc: ["How? What do you have to offer?"] },
          { player: ["Well what is it you want?"] },
          ...OFFER,
        ] },
        { text: "But I'm a loyal servant of Zamorak as well!", next: [
          { npc: ["Even if you speak the truth, it takes more than just being a follower of Zamorak to gain the secrets of the institute. You would need to offer something in return."] },
          { player: ["Like what?"] },
          ...OFFER,
        ] },
        { text: "You're right. I'm a faithful follower of Saradomin.", next: [
          { npc: ["Then you have no place here! Leave, before I make you!"] },
        ] },
        { text: "Actually, I'm not interested.", next: [
          { npc: ["Then you should be gone, for I am very busy."] },
        ] },
      ],
    },
  ];

  const RUNE_EXPLANATION = [
    {
      npc: [
        "Well we craft them of course.",
        "My associates and I. Despite the best attempts of the Saradominists, there's still more of us around than they'd like.",
      ],
    },
    { player: ["I can't imagine they like you crafting runes much. Do they not try and stop you?"] },
    { npc: ["Ha! I'm sure they'd love to, but we have methods of runecrafting that they can only dream of!"] },
    {
      options: [
        { text: "Care to share?", next: REQUEST_SHARE },
        { text: "Interesting. Thanks for the information." },
      ],
    },
  ];

  const VARROCK_INTRO = [
    { npc: ["Ah, you again. The Wilderness is hardly the appropriate place for a conversation now, is it? What was it you wanted?"] },
    { player: ["Err... I didn't really want anything."] },
    { npc: ["So why did you approach me?"] },
    { player: ["I was just wondering why you sell runes in the Wilderness?"] },
    {
      npc: ["Well I can't go doing it in the middle of Varrock, can I? In case you hadn't noticed, I'm a servant of Zamorak. The Saradominists have made sure that people like me are not welcome in these parts."],
    },
    {
      options: [
        { text: "Where do you get your runes from?", next: RUNE_EXPLANATION },
        { text: "Interesting. Thanks for the information." },
      ],
    },
  ];

  const SHORT_OFFER = [
    {
      npc: ["You again. Have you considered my offer? If you help us access the Rune Essence Mine, we will share our runecrafting secrets with you in return."],
    },
    DEAL_CHOICES,
  ];

  const HAND_IN = [
    { npc: [GREETING] },
    { player: ["Here you go."] },
    {
      npc: [
        "Right, let's take a look at this orb...",
        "Yes, this will do nicely. Once again, the Zamorak Magical Institute has overcome the Order of Wizards!",
        "You have done well. Now, time for us to uphold our end of the bargin.",
        "The reason we are able to craft so many runes is because we do not visit the runic altars in the traditional way. Instead, we have found a way to teleport to them directly.",
      ],
    },
    { player: ["How?"] },
    {
      npc: [
        "Via another plane known as the Abyss. It is a complex place that cannot be easily explained, but I will share our research notes with you so you may better understand it.",
        "Visit me in the Wilderness whenever you wish to be teleported there. Just be careful, for it is a dangerous place.",
      ],
    },
    { player: ["How is it dangerous?"] },
    {
      npc: [
        "There are creatures there that will hunt and attack any visitors on sight. The magic we use for teleporting there can also be a bit... unstable.",
        "Just don't expect to be using any prayers in there.",
        "Anyway, you may also have this pouch as well. I'm sure you will find it useful. Now, we're done here.",
      ],
    },
    {
      exec: (player) => {
        if (!has(player, ORB_FULL)) return;
        inventory(player).deleteNumber(ORB_FULL, 1);
        quest.complete(player);
      },
    },
  ];

  function talkWildernessMage(player, npcId) {
    const god = wornGodItem(player);
    if (god === "saradomin") {
      startDialogue(api, player, { npcId }, [{ npc: ["I don't speak to Saradominist filth."] }]);
      return true;
    }
    if (god === "guthix") {
      startDialogue(api, player, { npcId }, [{ npc: ["Pathetic Guthixian... Don't bother me."] }]);
      return true;
    }
    const stage = quest.getStage(player);
    if (stage === STAGE_NOT_STARTED) {
      if (!questComplete(player, RUNE_MYSTERIES_KEY)) return false;
      if (quest.getStage(player) === STAGE_NOT_STARTED) quest.setStage(player, STAGE_MEET_IN_VARROCK);
      startDialogue(api, player, { npcId }, [
        { npc: ["If you want to talk, this isn't the place for it. Meet me in Varrock's Chaos Temple, by the rune shop. Unless you're here to buy something?"] },
      ]);
      return true;
    }
    if (stage < STAGE_COMPLETE) {
      startDialogue(api, player, { npcId }, [
        { npc: ["I already told you to meet me in Varrock's Chaos Temple, by the rune shop. Unless you're here to buy something?"] },
      ]);
      return true;
    }
    // After the miniquest the generic Wilderness page owns the shop and Abyss teleport.
    return false;
  }

  function talkVarrockMage(player, npcId) {
    const god = wornGodItem(player);
    if (god) {
      startDialogue(api, player, { npcId }, [
        { npc: ["How dare you wear such disrespectful attire in this holy place? Remove those immediately if you wish to speak to me."] },
      ]);
      return true;
    }

    const stage = quest.getStage(player);
    if (stage === STAGE_NOT_STARTED) {
      startDialogue(api, player, { npcId }, [
        { npc: ["Ah, you again. What do you want?"] },
        { player: ["Nothing. I'm just looking around."] },
        { npc: ["Very well."] },
      ]);
      return true;
    }

    if (stage === STAGE_MEET_IN_VARROCK) {
      if (!questComplete(player, RUNE_MYSTERIES_KEY)) {
        startDialogue(api, player, { npcId }, [
          { npc: ["Ah, you again. What do you want?"] },
          { player: ["Nothing. I'm just looking around."] },
          { npc: ["Very well."] },
        ]);
        return true;
      }
      if (player.getAttribute(OFFER_MADE_ATTRIBUTE)) {
        startDialogue(api, player, { npcId }, SHORT_OFFER);
      } else {
        startDialogue(api, player, { npcId }, VARROCK_INTRO);
      }
      return true;
    }

    if (stage === STAGE_COLLECTING) {
      if (has(player, ORB_FULL)) {
        startDialogue(api, player, { npcId }, HAND_IN);
        return true;
      }
      if (has(player, ORB_EMPTY)) {
        startDialogue(api, player, { npcId }, [
          { npc: [GREETING] },
          { player: ["Not yet."] },
          { npc: [NOT_YET] },
        ]);
        return true;
      }
      if (banked(player, ORB_FULL)) {
        startDialogue(api, player, { npcId }, [
          { npc: [GREETING] },
          { player: ["Yes, but it's in my bank."] },
          { npc: ["Well it is of no use there. Bring it to me."] },
        ]);
        return true;
      }
      if (banked(player, ORB_EMPTY)) {
        startDialogue(api, player, { npcId }, [
          { npc: [GREETING] },
          { player: ["It's in my bank."] },
          { npc: ["Well it is of no use there. Bring it to me."] },
        ]);
        return true;
      }
      startDialogue(api, player, { npcId }, [
        { npc: [GREETING] },
        {
          options: [
            { text: "I lost it. Could I have another?", next: [{ exec: (who) => replaceOrb(who) }] },
            { text: "Not yet.", next: [{ npc: [NOT_YET] }] },
          ],
        },
      ]);
      return true;
    }

    if (stage === STAGE_READY) {
      if (has(player, ORB_EMPTY) && readingCount(player) >= 3) chargeOrb(player);
      if (has(player, ORB_FULL)) {
        startDialogue(api, player, { npcId }, HAND_IN);
        return true;
      }
      if (banked(player, ORB_FULL)) {
        startDialogue(api, player, { npcId }, [
          { npc: [GREETING] },
          { player: ["Yes, but it's in my bank."] },
          { npc: ["Well it is of no use there. Bring it to me."] },
        ]);
        return true;
      }
      if (banked(player, ORB_EMPTY)) {
        startDialogue(api, player, { npcId }, [
          { npc: [GREETING] },
          { player: ["It's in my bank."] },
          { npc: ["Well it is of no use there. Bring it to me."] },
        ]);
        return true;
      }
      startDialogue(api, player, { npcId }, [
        { npc: [GREETING] },
        {
          options: [
            { text: "I lost it. Could I have another?", next: [{ exec: (who) => replaceOrb(who) }] },
            { text: "Not yet.", next: [{ npc: ["Bring it to me when you are ready."] }] },
          ],
        },
      ]);
      return true;
    }

    // Completed: quietly hand over any reward the player had no room for.
    const pending = player.getAttribute(PENDING_REWARDS_ATTRIBUTE);
    if (Array.isArray(pending) && pending.length > 0) {
      startDialogue(api, player, { npcId }, [
        { npc: ["Ah, you again. I believe I still have something for you."] },
        {
          exec: (who) => {
            const { given, remaining } = givePendingRewards(who);
            for (const itemId of given) who.sendMessage(`The Mage of Zamorak hands you the ${itemName(itemId)}.`);
            if (remaining.length > 0) who.sendMessage("You still don't have enough room for the rest. Come back when you do.");
          },
        },
      ]);
      return true;
    }
    return false;
  }

  function talkToMage(event) {
    const { player, npcId } = event;
    const kind = mageKind(event);
    if (kind === "wilderness") return talkWildernessMage(player, npcId);
    if (kind === "varrock") return talkVarrockMage(player, npcId);
    return false;
  }

  // The generic picker takes the first "standard" variant for every Mage of
  // Zamorak, which is the Wilderness page. The Chaos Temple mage needs the
  // post-miniquest branch once there is nothing left for this plugin to say.
  function selectVariant({ npcId, player, npc }) {
    if (quest.isComplete(player) && mageKind({ npcId, player, npc }) === "varrock") {
      return { page: "Mage of Zamorak", variant: "standard-dialogue-after-completing-enter-the-abyss" };
    }
    return null;
  }

  function handleTeleportLanded(event) {
    const { player } = event;
    if (!player || player.isPlayerBot?.() || event.fromInstance) return;
    if (quest.getStage(player) !== STAGE_COLLECTING) return;
    if (!inventory(player).contains(ORB_EMPTY)) return;
    if (!near(event.to, ESSENCE_MINE, DESTINATION_RADIUS)) return;
    const spot = ESSENCE_SPOTS.find((candidate) => near(event.from, candidate, SOURCE_RADIUS));
    if (!spot) return;
    recordReading(player, spot);
  }

  function restoreReadings({ player }) {
    const known = new Set(readings(player));
    for (const spot of ESSENCE_SPOTS) {
      player.getPacketSender().sendVarbit(spot.varbit, known.has(spot.key) ? 1 : 0);
    }
    if (quest.getStage(player) === STAGE_COLLECTING && readingCount(player) >= 3) {
      quest.setStage(player, STAGE_READY);
      chargeOrb(player);
    }
  }

  function readAbyssalBook(event) {
    if (event.itemId !== ABYSSAL_BOOK && event.itemId !== Items.ABYSSAL_BOOK_2) return false;
    openBook(event.player, abyssalBook.title, abyssalBook.pages);
    return true;
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I helped the Zamorak Magical Institute access the</str>",
        "<str>Rune Essence Mine.</str>",
        "<str>In return, I can now enter the Abyss.</str>",
        "",
        "<col=ff0000>MINIQUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_READY) {
      return [
        "<str>I have filled the scrying orb with the magic of three</str>",
        "<str>different teleports.</str>",
        "",
        "I should return the <col=800000>scrying orb</col> to the",
        "<col=800000>Mage of Zamorak</col> in south-east <col=800000>Varrock</col>.",
      ];
    }
    if (stage >= STAGE_COLLECTING) {
      const taken = readingCount(player);
      return [
        `I have taken the scrying orb to ${taken} of the three`,
        "locations the Mage of Zamorak needs.",
        "",
        "I should carry it to the <col=800000>Rune Essence Mine</col>",
        "from three different wizards, then return it to the",
        "<col=800000>Mage of Zamorak</col> in south-east <col=800000>Varrock</col>.",
      ];
    }
    if (stage >= STAGE_MEET_IN_VARROCK) {
      return [
        "<str>The Mage of Zamorak asked me to meet him at the</str>",
        "<str>Chaos Temple in south-east Varrock.</str>",
      ];
    }
    return [
      "I can start this miniquest by speaking to the",
      "<col=800000>Mage of Zamorak</col> in the <col=800000>Wilderness</col>",
      "north of <col=800000>Edgeville</col>.",
      "",
      "I must have completed <col=800000>Rune Mysteries</col>.",
    ];
  }

  api.persistAttribute(READINGS_ATTRIBUTE, []);
  api.persistAttribute(OFFER_MADE_ATTRIBUTE, 0);
  api.persistAttribute(PENDING_REWARDS_ATTRIBUTE, []);

  quest = registerQuest(api, {
    key: "enter_the_abyss",
    name: "Enter the Abyss",
    varpId: VARP_ABYSSAL_MINQUEST,
    startedValue: STAGE_MEET_IN_VARROCK,
    completionValue: STAGE_COMPLETE,
    questPoints: 0,
    xpRewards: [{ skillId: Skill.RUNECRAFTING.getIndex(), amount: RUNECRAFT_XP, label: "Runecraft" }],
    scrollItemId: SMALL_POUCH,
    otherRewards: ["Abyssal book", "Small pouch", "Ability to enter the Abyss"],
    buildJournal,
    onReward: reward,
  });

  api.onNpcInteraction("Mage of Zamorak", { "Talk-to": talkToMage });
  api.onNpcDialogueVariant(selectVariant);
  api.onCustomEvent("teleport:landed", handleTeleportLanded);
  api.onPlayerLogin(restoreReadings);
  api.onItemAction("Abyssal book", { Read: readAbyssalBook });
};
