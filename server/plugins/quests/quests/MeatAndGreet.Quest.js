/**
 * Meat and Greet (members).
 *
 * The words come from the "Meat and Greet" transcript page; this plugin supplies the
 * variant selectors for Emelio, the Spice Merchant, Alba, the three connoisseurs and
 * Lelia, the prose-condition answers for the wiki's inventory/recipe branches, the
 * spice-box PIN, the delivery/wolf flags, the recipe adjustment loop, the minotaur
 * fight and the completion reward.
 *
 * Stages (varbit 11182 "mag", varp 4399 "mag_primary", 7 bits):
 *   0 not started
 *   1 chasing the two missing deliveries
 *   2 both deliveries sorted; Emelio explains the recipe
 *   3 gathering the connoisseurs' opinions / adjusting the recipe
 *   4 the connoisseurs approved the recipe
 *   5 the two test kebabs are in hand; market them at the Colosseum
 *   6 the minotaur is defeated; report back to Lelia and Emelio
 *   7 complete
 * Evidence for the varbit: `lookup-gameval.ts varbit mag` prints 11182 "mag" varp=4399
 * bits=0-6; CS2 4024 (the quest DB status script) maps quest id 3712 to `get_varbit
 * 11182`; the sibling varbits on varp 4399 are mag_spice (11183), mag_meat (11184),
 * mag_portions_meat/salad/spice/sauce (11185-11188) and mag_testing_kebab (11189).
 * The stub's varp 7911 is a placeholder and is not used.
 *
 * Source: OSRS Wiki (Meat and Greet, Meat and Greet/Quick guide, Transcript:Meat and
 * Greet, Transcript:Meat and Greet/Journal). Rewards: 1 Quest point, 8,000 Cooking XP
 * and access to Emelio's Kebab Shop.
 *
 * Gaps/approximations: the wiki's spice-box keypad interface does not exist in this
 * server, so the box prompts for the PIN (2546) through the normal chatbox input and a
 * wrong entry gets a plain refusal message; the dump merged the "no room"/"gives you a
 * kebab" branches under the lost-kebab conditions, so this plugin gives the restock
 * kebabs from the condition event using the transcript's own messages; Lelia's repeat
 * variants and Emelio's "after a failed taste test" variant jump "above" by option text
 * the dump cannot resolve back into their own branch (both land in Emelio's recipe
 * menu), so repeat talks replay "guerilla-marketing" (kebab/condition handlers keep it
 * idempotent) and a failed taste test reopens the adjust menu; the alpha's
 * "Grrr!"/"Aarrooooo!" and the minotaur's "Moo!"/"Moooooo!" are overhead lines (not
 * talk transcripts) and the summoning/attack-speed mechanics they announce are not
 * simulated; Lelia is spawned by this plugin because she is missing from
 * npc-spawns.json; Emelio's post-quest kebab shop is not in shops.json so its "Yes
 * please." option falls through; the Children of the Sun requirement is enforced with a
 * message but the start branch still plays (the transcript has no refusal variant).
 */
module.exports = function registerMeatAndGreetQuest(api) {
  const { ItemIdentifiers, Location, NpcIdentifiers, Skill } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const EMELIO_NPC_ID = NpcIdentifiers.EMELIO; // 13804
  const SPICE_MERCHANT_NPC_ID = NpcIdentifiers.SPICE_MERCHANT; // 13337
  const ALBA_NPC_ID = NpcIdentifiers.ALBA; // 13807
  const LUCAS_NPC_ID = NpcIdentifiers.LUCAS; // 13808
  const RENATA_NPC_ID = NpcIdentifiers.RENATA; // 13809
  const VINCENS_NPC_ID = NpcIdentifiers.VINCENS; // 13810
  const LELIA_NPC_ID = NpcIdentifiers.LELIA; // 13806, missing from npc-spawns.json
  const DIRE_WOLF_ALPHA_NPC_ID = NpcIdentifiers.DIRE_WOLF_ALPHA; // 13812
  const MINOTAUR_NPC_ID = NpcIdentifiers.MINOTAUR_7; // 13815 (has cache combat stats)
  const MINOTAUR_NPC_IDS = new Set([NpcIdentifiers.MINOTAUR_6, MINOTAUR_NPC_ID]);

  const CONNOISSEUR_NPC_IDS = new Set([LUCAS_NPC_ID, RENATA_NPC_ID, VINCENS_NPC_ID]);
  const CONNOISSEUR_VARIANT_NAMES = new Map([
    [LUCAS_NPC_ID, "lucas"],
    [RENATA_NPC_ID, "renata"],
    [VINCENS_NPC_ID, "vincens"],
  ]);

  const TEST_KEBAB_ITEM_ID = ItemIdentifiers.TEST_KEBAB; // 29898, connoisseur version
  const LELIA_KEBAB_ITEM_ID = ItemIdentifiers.TEST_KEBAB_2; // 29899, Lelia/marketing version

  const PAGE = "Meat and Greet";
  const START_HOOK = "quest:meat-and-greet:start";
  const CHILDREN_OF_THE_SUN_KEY = "children_of_the_sun";
  const SPICE_BOX_PIN = "2546";

  const VARP_MAG_PRIMARY = 4399;
  const VARBIT_MAG_STAGE = 11182; // "mag" bits 0-6

  const STAGE_STARTED = 1;
  const STAGE_DELIVERIES = 2;
  const STAGE_RECIPE = 3;
  const STAGE_TESTED = 4;
  const STAGE_MARKETING = 5;
  const STAGE_MINOTAUR = 6;
  const STAGE_COMPLETE = 7;

  // Wired around the Colosseum map (plugins/minigames/colosseum/ColosseumShared.js).
  const LELIA_SPAWN = { x: 1820, y: 9485 }; // Wiki map pin for Lelia
  const COLOSSEUM_ARENA = { x: 1824, y: 3094 }; // ARENA_START
  const MINOTAUR_SPAWN = { x: 1832, y: 3100 };

  const BITS_ATTRIBUTE = "quest.meat_and_greet.bits";
  const RECIPE_ATTRIBUTE = "quest.meat_and_greet.recipe";

  const BIT_SPICE_TALKED = 1 << 0;
  const BIT_SPICE_UNLOCKED = 1 << 1;
  const BIT_ALBA_TALKED = 1 << 2;
  const BIT_WOLF_KILLED = 1 << 3;
  const BIT_MEAT_DELIVERED = 1 << 4;
  const BIT_LELIA_MET = 1 << 5;
  const BIT_FIGHT_STARTED = 1 << 6;
  const BIT_LELIA_TOLD = 1 << 7;
  const BIT_TASTE_KEBAB_GIVEN = 1 << 8;

  // Condition step ids on the "Meat and Greet" page.
  const INVENTORY_FULL_CONDITION_ID = "VVK8P_";
  const INVENTORY_SPACE_CONDITION_ID = "PNqiJZ";
  const LOST_TEST_KEBAB_CONDITION_ID = "xP8rLp";
  const HAS_TEST_KEBAB_CONDITION_ID = "yUPGB0";
  const RESTOCK_FULL_CONDITION_ID = "QCbFCI";
  const RESTOCK_SPACE_CONDITION_ID = "pt89vQ";
  const BAD_RATIO_CONDITION_ID = "nfs5Ro";
  const GOOD_RATIO_CONDITION_ID = "qy1Uj2";
  const TWO_KEBABS_NO_SPACE_CONDITION_ID = "3_tkee";
  const TWO_KEBABS_SPACE_CONDITION_ID = "r0O40y";
  const LOST_ONE_CONDITION_ID = "V-2FC1";
  const ONE_KEBAB_NO_SLOT_CONDITION_ID = "G_sGI4";
  const LOST_BOTH_CONDITION_ID = "cL9ltx";
  const TWO_KEBABS_NO_ROOM_CONDITION_ID = "iIEWvT";
  const TWO_KEBABS_ROOM_CONDITION_ID = "pii5SL";
  const BOTH_KEBABS_CONDITION_ID = "iOngTK";
  const LELIA_MISSING_CONDITION_ID = "t1LsOv";
  const LELIA_HAS_CONDITION_ID = "1Ji6Ve";
  const LELIA_MISSING_AGAIN_CONDITION_ID = "TK2D06";
  const LELIA_HAS_AGAIN_CONDITION_ID = "6jK71j";
  const EMELIO_MISSING_CONDITION_ID = "Nf11kS";
  const EMELIO_HAS_CONDITION_ID = "6-kSjK";

  // Action/message step ids on the "Meat and Greet" page.
  const RECEIVE_TEST_KEBAB_ACTION_ID = "7WnuHP";
  const RECEIVE_TEST_KEBAB_AGAIN_ACTION_ID = "CNNvQb";
  const TASTE_TEST_ACTION_ID = "Zu920h";
  const RECEIVE_TWO_KEBABS_ACTION_ID = "_LMMpb";
  const LELIA_EATS_KEBAB_ACTION_ID = "rFr1Qu";
  const EATS_KEBAB_ACTION_ID = "SnagHV";
  const ENTER_ARENA_LINE = "Oh boy...";

  const RECIPE_WORDS = ["one", "two", "three", "four"];

  let quest;

  /** The quest minotaur spawn per owner, removed on death or logout. */
  const minotaurs = new WeakMap();

  const held = (player, itemId) => player.getInventory().getAmount(itemId) > 0;
  const heldCount = (player, itemId) => player.getInventory().getAmount(itemId);
  const freeSlots = (player) => player.getInventory().getFreeSlots();

  function bits(player) {
    return Number(player.getAttribute(BITS_ATTRIBUTE)) || 0;
  }

  function hasBit(player, bit) {
    return (bits(player) & bit) !== 0;
  }

  function setBit(player, bit) {
    player.setAttribute(BITS_ATTRIBUTE, bits(player) | bit);
  }

  function clearBits(player, mask) {
    player.setAttribute(BITS_ATTRIBUTE, bits(player) & ~mask);
  }

  function isQuestComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  /** Portions are four 3-bit fields, each 1-4, defaulting to 1. */
  function recipe(player) {
    const packed = Number(player.getAttribute(RECIPE_ATTRIBUTE)) || 0;
    const portion = (shift) => ((packed >> shift) & 7) || 1;
    return { meat: portion(0), salad: portion(3), spice: portion(6), sauce: portion(9) };
  }

  function setPortion(player, ingredient, amount) {
    const shifts = { meat: 0, salad: 3, spice: 6, sauce: 9 };
    const current = recipe(player);
    current[ingredient] = amount;
    const packed =
      current.meat | (current.salad << 3) | (current.spice << 6) | (current.sauce << 9);
    player.setAttribute(RECIPE_ATTRIBUTE, packed);
  }

  function resetRecipe(player) {
    player.setAttribute(RECIPE_ATTRIBUTE, 1 | (1 << 3) | (1 << 6) | (1 << 9));
  }

  function recipeCorrect(player) {
    const value = recipe(player);
    return value.meat === 4 && value.salad === 2 && value.spice === 1 && value.sauce === 3;
  }

  /** Fill the wiki's "[number] portion[s]" blanks with the current recipe. */
  function fillPortions(player, text) {
    const value = recipe(player);
    const order = [value.meat, value.salad, value.spice, value.sauce];
    let index = 0;
    return text.replace(/\[number\] portion\[s\]/g, () => {
      const amount = order[index++] ?? 1;
      return `${amount} portion${amount === 1 ? "" : "s"}`;
    });
  }

  function maybeAdvanceDeliveries(player) {
    if (quest.getStage(player) !== STAGE_STARTED) return;
    if (hasBit(player, BIT_SPICE_UNLOCKED) && hasBit(player, BIT_MEAT_DELIVERED)) {
      quest.setStage(player, STAGE_DELIVERIES);
    }
  }

  // ==========================================================================
  // Variant selection (one branch per stage/sub-state)
  // ==========================================================================

  function selectEmelio(player, stage) {
    if (stage === 0) return "starting-out-talking-to-emelio";
    if (stage === STAGE_STARTED) {
      if (hasBit(player, BIT_SPICE_UNLOCKED)) {
        return "searching-for-spices-talking-to-emelio-after-unlocking-the-box-before-taking-care-of-the-buffalo-meat";
      }
      if (hasBit(player, BIT_MEAT_DELIVERED)) {
        return "browsing-for-buffalo-meat-talking-to-emelio-after-taking-care-of-the-buffalo-meat-before-unlocking-the-spice-box";
      }
      return "starting-out-talking-to-emelio-again";
    }
    if (stage === STAGE_DELIVERIES) return "making-the-ultimate-kebab-talking-to-emelio";
    if (stage === STAGE_RECIPE) {
      if (held(player, TEST_KEBAB_ITEM_ID)) return "making-the-ultimate-kebab-talking-to-emelio-again";
      if (hasBit(player, BIT_TASTE_KEBAB_GIVEN)) {
        return "making-the-ultimate-kebab-talking-to-emilio-before-getting-a-connoisseur-to-taste-test-the-current-test-kebab";
      }
      // A failed taste test re-enters the adjust menu: the wiki's "after a failed
      // taste test" variant's "above" jump lost its target in the dump.
      return "making-the-ultimate-kebab-talking-to-emelio-again";
    }
    if (stage === STAGE_TESTED) {
      return "making-the-ultimate-kebab-talking-to-emelio-after-a-successful-taste-test";
    }
    if (stage === STAGE_MARKETING) {
      if (hasBit(player, BIT_FIGHT_STARTED)) {
        return "guerilla-marketing-talking-to-emilio-after-leaving-the-fortis-colosseum-but-before-killing-the-minotaur";
      }
      if (hasBit(player, BIT_LELIA_MET)) {
        return "guerilla-marketing-talking-to-emilio-after-giving-leila-a-test-kebab";
      }
      return "making-the-ultimate-kebab-talking-to-emelio-after-receiving-the-two-test-kebabs";
    }
    if (stage === STAGE_MINOTAUR) return "wrapping-up";
    return { page: "Emelio", variant: "standard-dialogue-after-meat-and-greet" };
  }

  function selectSpiceMerchant(player, stage) {
    if (stage !== STAGE_STARTED) return null; // standard spice-stall dialogue
    if (hasBit(player, BIT_SPICE_UNLOCKED)) {
      return "searching-for-spices-talking-to-the-spice-merchant-after-unlocking-the-box";
    }
    return hasBit(player, BIT_SPICE_TALKED)
      ? "searching-for-spices-talking-to-the-spice-merchant-again"
      : "searching-for-spices";
  }

  function selectAlba(player, stage) {
    if (stage >= STAGE_DELIVERIES) return { page: "Alba", variant: "after-meat-and-greet" };
    if (stage !== STAGE_STARTED) return { page: "Alba", variant: "before-meat-and-greet" };
    if (hasBit(player, BIT_WOLF_KILLED)) {
      return "browsing-for-buffalo-meat-talking-to-alba-after-killing-the-dire-wolf-alpha";
    }
    if (hasBit(player, BIT_ALBA_TALKED)) {
      return "browsing-for-buffalo-meat-talking-to-alba-talking-to-alba-again";
    }
    return "browsing-for-buffalo-meat-talking-to-alba";
  }

  function selectConnoisseur(player, stage, suffix) {
    if (stage >= STAGE_TESTED) {
      return `making-the-ultimate-kebab-talking-to-${suffix}-after-a-successful-taste-test`;
    }
    if (stage === STAGE_RECIPE) {
      if (held(player, TEST_KEBAB_ITEM_ID)) {
        return "making-the-ultimate-kebab-getting-the-connoisseurs-to-taste-test-the-current-test-kebab";
      }
      return `making-the-ultimate-kebab-talking-to-${suffix}`;
    }
    if (stage === STAGE_DELIVERIES) {
      return `making-the-ultimate-kebab-talking-to-${suffix}-before-emelio`;
    }
    return null;
  }

  function selectLelia(player, stage) {
    // The dedicated repeat variants jump "above" by shared option text, which the
    // dump cannot resolve back to Lelia's branch (it lands in Emelio's menu), so
    // every marketing-stage talk replays her first-meeting conversation. The
    // kebab/condition handlers below make the replay idempotent.
    if (stage === STAGE_MARKETING) return "guerilla-marketing";
    if (stage === STAGE_MINOTAUR && !quest.isComplete(player)) {
      return hasBit(player, BIT_LELIA_TOLD)
        ? "guerilla-marketing-talking-to-lelia-again-after-killing-the-minotaur"
        : "guerilla-marketing-talking-to-lelia-after-killing-the-minotaur";
    }
    return null; // no pre-quest/post-quest variant on the page beyond her standard one
  }

  function selectVariant({ npcId, player }) {
    if (!quest || !player) return null;
    const stage = quest.getStage(player);
    if (npcId === EMELIO_NPC_ID) return selectEmelio(player, stage);
    if (npcId === SPICE_MERCHANT_NPC_ID) return selectSpiceMerchant(player, stage);
    if (npcId === ALBA_NPC_ID) return selectAlba(player, stage);
    if (npcId === LELIA_NPC_ID) return selectLelia(player, stage);
    // Their page defaults to the whole marketing conversation; scope Talk-to to their shouts.
    if (npcId === DIRE_WOLF_ALPHA_NPC_ID) {
      return "browsing-for-buffalo-meat-upon-entering-the-dire-wolf-cave";
    }
    if (MINOTAUR_NPC_IDS.has(npcId)) {
      return "guerilla-marketing-minotaur-launching-a-magic-attack";
    }
    if (CONNOISSEUR_NPC_IDS.has(npcId)) {
      return selectConnoisseur(player, stage, CONNOISSEUR_VARIANT_NAMES.get(npcId));
    }
    return null;
  }

  // ==========================================================================
  // Condition answers and their side effects
  // ==========================================================================

  function answerCondition({ npcId, player, stepId }) {
    if (npcId === EMELIO_NPC_ID) {
      switch (stepId) {
        case INVENTORY_FULL_CONDITION_ID:
        case RESTOCK_FULL_CONDITION_ID:
          return freeSlots(player) === 0;
        case INVENTORY_SPACE_CONDITION_ID:
        case RESTOCK_SPACE_CONDITION_ID:
          return freeSlots(player) > 0;
        case LOST_TEST_KEBAB_CONDITION_ID:
          return !held(player, TEST_KEBAB_ITEM_ID);
        case HAS_TEST_KEBAB_CONDITION_ID:
          return held(player, TEST_KEBAB_ITEM_ID);
        case TWO_KEBABS_NO_SPACE_CONDITION_ID:
          return freeSlots(player) < 2;
        case TWO_KEBABS_SPACE_CONDITION_ID:
          return freeSlots(player) >= 2;
        case LOST_ONE_CONDITION_ID:
          return heldCount(player, LELIA_KEBAB_ITEM_ID) === 1;
        case LOST_BOTH_CONDITION_ID:
          return heldCount(player, LELIA_KEBAB_ITEM_ID) === 0;
        case BOTH_KEBABS_CONDITION_ID:
          return heldCount(player, LELIA_KEBAB_ITEM_ID) >= 2;
        // The dump merged the "no room" and "gives you a kebab" lines under one
        // condition; the restock is handled in the condition event instead.
        case ONE_KEBAB_NO_SLOT_CONDITION_ID:
        case TWO_KEBABS_NO_ROOM_CONDITION_ID:
        case TWO_KEBABS_ROOM_CONDITION_ID:
          return false;
        case EMELIO_MISSING_CONDITION_ID:
          return !held(player, LELIA_KEBAB_ITEM_ID);
        case EMELIO_HAS_CONDITION_ID:
          return held(player, LELIA_KEBAB_ITEM_ID);
        default:
          return null;
      }
    }
    if (CONNOISSEUR_NPC_IDS.has(npcId)) {
      if (stepId === BAD_RATIO_CONDITION_ID) return !recipeCorrect(player);
      if (stepId === GOOD_RATIO_CONDITION_ID) return recipeCorrect(player);
      return null;
    }
    if (npcId === LELIA_NPC_ID) {
      // The first meeting's conditions resolve before Lelia eats one of the two
      // kebabs; a replay (BIT_LELIA_MET) only needs the kebab for the arena.
      const required = hasBit(player, BIT_LELIA_MET) ? 1 : 2;
      if (stepId === LELIA_MISSING_CONDITION_ID || stepId === LELIA_MISSING_AGAIN_CONDITION_ID) {
        return heldCount(player, LELIA_KEBAB_ITEM_ID) < required;
      }
      if (stepId === LELIA_HAS_CONDITION_ID || stepId === LELIA_HAS_AGAIN_CONDITION_ID) {
        return heldCount(player, LELIA_KEBAB_ITEM_ID) >= required;
      }
      return null;
    }
    return null;
  }

  /** Restock the Lelia kebabs the dump branch cannot deliver (merged wiki lines). */
  function restockKebabs(player, target) {
    const missing = Math.max(0, target - heldCount(player, LELIA_KEBAB_ITEM_ID));
    if (missing === 0) return;
    if (freeSlots(player) < missing) {
      player.sendMessage(missing === 1
        ? "Emelio tries to give you a kebab, but you don't have enough room for it."
        : "Emelio tries to give you some kebabs, but you don't have enough room for them.");
      return;
    }
    player.getInventory().adds(LELIA_KEBAB_ITEM_ID, missing);
    player.sendMessage(missing === 1 ? "Emelio gives you a kebab." : "Emelio gives you some kebabs.");
  }

  function handleDialogueCondition(event) {
    const { player, npcId, stepId } = event;
    if (npcId === EMELIO_NPC_ID) {
      if (stepId === LOST_ONE_CONDITION_ID || stepId === LOST_BOTH_CONDITION_ID) {
        restockKebabs(player, 2);
      } else if (stepId === EMELIO_MISSING_CONDITION_ID) {
        restockKebabs(player, 1);
      }
      return;
    }
    if (!CONNOISSEUR_NPC_IDS.has(npcId) || quest.getStage(player) !== STAGE_RECIPE) return;
    if (stepId === GOOD_RATIO_CONDITION_ID) quest.setStage(player, STAGE_TESTED);
  }

  // ==========================================================================
  // Actions: kebabs, the spice-box PIN, the arena fight, completion
  // ==========================================================================

  function promptSpiceBoxPin(player) {
    if (quest.getStage(player) !== STAGE_STARTED || hasBit(player, BIT_SPICE_UNLOCKED)) return;
    player.setEnteredSyntaxAction({ execute: (input) => submitSpiceBoxPin(player, input) });
    player.getPacketSender().sendEnterInputPrompt("Enter the 4-digit PIN");
  }

  function submitSpiceBoxPin(player, input) {
    if (quest.getStage(player) !== STAGE_STARTED || hasBit(player, BIT_SPICE_UNLOCKED)) return;
    if (String(input ?? "").trim() !== SPICE_BOX_PIN) {
      player.sendMessage("The box remains locked.");
      return;
    }
    setBit(player, BIT_SPICE_UNLOCKED);
    maybeAdvanceDeliveries(player);
    startTranscript(api, player, SPICE_MERCHANT_NPC_ID, PAGE, "searching-for-spices-unlocking-the-box");
  }

  function openSpiceBox(player) {
    const { CountdownTask, TaskManager } = api.core;
    TaskManager.submit(new CountdownTask(player, 1, () => {
      if (player.isRegistered?.() === false) return;
      promptSpiceBoxPin(player);
    }));
  }

  function beginArenaFight(player) {
    if (quest.getStage(player) !== STAGE_MARKETING) return;
    setBit(player, BIT_FIGHT_STARTED);
    const { CountdownTask, TaskManager } = api.core;
    TaskManager.submit(new CountdownTask(player, 1, () => {
      if (player.isRegistered?.() === false) return;
      player.moveTo(new Location(COLOSSEUM_ARENA.x, COLOSSEUM_ARENA.y, 0));
      spawnQuestMinotaur(player);
    }));
  }

  function spawnQuestMinotaur(player) {
    if (minotaurs.has(player)) return;
    const npc = api.spawnNpc({
      id: MINOTAUR_NPC_ID,
      x: MINOTAUR_SPAWN.x,
      y: MINOTAUR_SPAWN.y,
      z: 0,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (!npc) return;
    npc.__meatAndGreetOwner = player;
    minotaurs.set(player, npc);
  }

  function handleDialogueAction(event) {
    const { player, npcId, stepId, step, action, target } = event;
    if (npcId === EMELIO_NPC_ID) {
      if (step?.type === "end" && quest.getStage(player) === STAGE_MINOTAUR) {
        event.handled = true;
        quest.complete(player);
        return;
      }
      if (stepId === RECEIVE_TEST_KEBAB_ACTION_ID) {
        event.handled = true;
        setBit(player, BIT_TASTE_KEBAB_GIVEN);
        if (!held(player, TEST_KEBAB_ITEM_ID)) player.getInventory().adds(TEST_KEBAB_ITEM_ID, 1);
        return;
      }
      if (stepId === RECEIVE_TEST_KEBAB_AGAIN_ACTION_ID) {
        event.handled = true;
        setBit(player, BIT_TASTE_KEBAB_GIVEN);
        if (!held(player, TEST_KEBAB_ITEM_ID) && freeSlots(player) > 0) {
          player.getInventory().adds(TEST_KEBAB_ITEM_ID, 1);
        }
        return;
      }
      if (stepId === RECEIVE_TWO_KEBABS_ACTION_ID) {
        event.handled = true;
        if (freeSlots(player) >= 2) player.getInventory().adds(LELIA_KEBAB_ITEM_ID, 2);
        clearBits(player, BIT_LELIA_MET | BIT_FIGHT_STARTED | BIT_LELIA_TOLD);
        quest.setStage(player, STAGE_MARKETING);
        return;
      }
      return;
    }
    if (npcId === SPICE_MERCHANT_NPC_ID) {
      if (action === "open_interface" && target === "Box") {
        event.handled = true;
        event.end = true;
        openSpiceBox(player);
      }
      return;
    }
    if (CONNOISSEUR_NPC_IDS.has(npcId)) {
      if (stepId !== TASTE_TEST_ACTION_ID) return;
      event.handled = true;
      if (held(player, TEST_KEBAB_ITEM_ID)) player.getInventory().deleteNumber(TEST_KEBAB_ITEM_ID, 1);
      clearBits(player, BIT_TASTE_KEBAB_GIVEN);
      return;
    }
    if (npcId !== LELIA_NPC_ID) return;
    if (stepId === LELIA_EATS_KEBAB_ACTION_ID) {
      if (!hasBit(player, BIT_LELIA_MET) && held(player, LELIA_KEBAB_ITEM_ID)) {
        player.getInventory().deleteNumber(LELIA_KEBAB_ITEM_ID, 1);
      }
      setBit(player, BIT_LELIA_MET);
      return;
    }
    if (stepId === EATS_KEBAB_ACTION_ID) {
      if (held(player, LELIA_KEBAB_ITEM_ID)) player.getInventory().deleteNumber(LELIA_KEBAB_ITEM_ID, 1);
    }
  }

  function handleDialogueChoice({ player, npcId, option }) {
    if (npcId !== SPICE_MERCHANT_NPC_ID || option !== "I'm here about a missing delivery.") return;
    setBit(player, BIT_SPICE_TALKED);
  }

  // ==========================================================================
  // Lines: dynamic recipe text, stage transitions, the arena trigger
  // ==========================================================================

  function handleDialogueLine(event) {
    const { player, npcId } = event;
    if (typeof event.text !== "string") return;

    if (npcId === EMELIO_NPC_ID) {
      if (event.text.includes("[number] portion[s]")) {
        event.text = fillPortions(player, event.text);
        return;
      }
      const pick = /^Let's try (one|two|three|four) portions? of (meat|salad|spice|sauce)\./.exec(event.text);
      if (pick) {
        setPortion(player, pick[2], RECIPE_WORDS.indexOf(pick[1]) + 1);
        return;
      }
      if (event.text.includes("all the ingredients have now arrived") && quest.getStage(player) === STAGE_DELIVERIES) {
        resetRecipe(player);
        clearBits(player, BIT_TASTE_KEBAB_GIVEN);
        quest.setStage(player, STAGE_RECIPE);
      }
      return;
    }

    if (npcId === ALBA_NPC_ID) {
      if (event.text.includes("The wolves have a den directly west of here")) {
        setBit(player, BIT_ALBA_TALKED);
        return;
      }
      if (event.text.includes("I was able to get Emelio's order finished") && !hasBit(player, BIT_MEAT_DELIVERED)) {
        setBit(player, BIT_MEAT_DELIVERED);
        maybeAdvanceDeliveries(player);
      }
      return;
    }

    if (npcId !== LELIA_NPC_ID) return;
    if (event.text === ENTER_ARENA_LINE) {
      beginArenaFight(player);
      return;
    }
    if (event.text.includes("tell Emelio about the good impression his kebabs made")) {
      setBit(player, BIT_LELIA_TOLD);
    }
  }

  // ==========================================================================
  // Start hook, death handling, spawns, login
  // ==========================================================================

  function handleStartHook({ player, npcId, hook }) {
    if (npcId !== EMELIO_NPC_ID || hook !== START_HOOK) return;
    if (quest.getStage(player) !== 0) return;
    if (!isQuestComplete(player, CHILDREN_OF_THE_SUN_KEY)) {
      player.sendMessage("You must complete Children of the Sun before starting this quest.");
      return;
    }
    player.setAttribute(BITS_ATTRIBUTE, 0);
    resetRecipe(player);
    quest.setStage(player, STAGE_STARTED);
  }

  function handleNpcDeath(event) {
    const killer = event.killer?.isPlayer?.() ? event.killer : null;
    if (event.npcId === DIRE_WOLF_ALPHA_NPC_ID) {
      if (!killer || quest.getStage(killer) !== STAGE_STARTED || hasBit(killer, BIT_WOLF_KILLED)) return;
      setBit(killer, BIT_WOLF_KILLED);
      startTranscript(api, killer, DIRE_WOLF_ALPHA_NPC_ID, PAGE, "browsing-for-buffalo-meat-upon-killing-the-dire-wolf-alpha");
      return;
    }
    if (event.npcId !== MINOTAUR_NPC_ID) return;
    const owner = event.npc?.__meatAndGreetOwner;
    if (!owner || owner !== killer || quest.getStage(owner) !== STAGE_MARKETING) return;
    minotaurs.delete(owner);
    quest.setStage(owner, STAGE_MINOTAUR);
    const { CountdownTask, TaskManager } = api.core;
    TaskManager.submit(new CountdownTask(owner, 3, () => {
      if (owner.isRegistered?.() === false) return;
      owner.moveTo(new Location(LELIA_SPAWN.x, LELIA_SPAWN.y, 0));
    }));
  }

  function despawnQuestMinotaur({ player }) {
    const npc = minotaurs.get(player);
    if (!npc) return;
    minotaurs.delete(player);
    api.removeNpc(npc);
  }

  /** Lelia has no row in npc-spawns.json; she always waits in the lobby. */
  function spawnLelia() {
    const npcs = api.getWorld?.()?.getNpcs?.() ?? [];
    for (const npc of npcs) {
      if (npc?.getId?.() === LELIA_NPC_ID) return;
    }
    api.spawnNpc({ id: LELIA_NPC_ID, x: LELIA_SPAWN.x, y: LELIA_SPAWN.y, z: 0, wanderRadius: 0 });
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
  }

  // ==========================================================================
  // Journal and reward
  // ==========================================================================

  function deliveryLines(player) {
    const lines = [];
    if (hasBit(player, BIT_SPICE_UNLOCKED)) {
      lines.push("I spoke to the Spice Merchant in the Bazaar and sorted out a missing Spice Delivery.");
    } else if (hasBit(player, BIT_SPICE_TALKED)) {
      lines.push("The Spice Merchant told me the Spice Delivery had arrived, but asked me to help open it.");
    } else {
      lines.push("I need to speak to the Spice Merchant in the Bazaar about a missing Spice Delivery.");
    }
    if (hasBit(player, BIT_MEAT_DELIVERED)) {
      lines.push("I spoke to Alba at Ortus Farm and sorted out a missing Meat Delivery.");
    } else if (hasBit(player, BIT_WOLF_KILLED)) {
      lines.push("I dealt with the Wolves at the Den west of Ortus Farm. I should ask Alba to send the Meat Delivery.");
    } else if (hasBit(player, BIT_ALBA_TALKED)) {
      lines.push("Alba asked me to head to the Den west of the Farm and kill the Largest Wolf.");
    } else {
      lines.push("I need to speak to Alba at Ortus Farm about a missing Meat Delivery.");
    }
    return lines;
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I spoke to Emelio in Outer Fortis and helped him set up</str>",
        "<str>Varlamore's first Kebab Shop. I sorted out the missing</str>",
        "<str>deliveries, perfected the recipe with the Connoisseurs and</str>",
        "<str>advertised the Kebabs at the Fortis Colosseum.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_MINOTAUR) {
      return [
        "I spoke to Emelio in Outer Fortis. He asked me for some help in",
        "setting up Varlamore's first Kebab Shop. To do so, I chased up",
        "some Missing Deliveries for him.",
        "With the Missing Deliveries sorted, Emelio and I needed to",
        "perfect the recipe for the Kebabs with the help of some",
        "'Connoisseurs'.",
        "Lelia arranged a slot for me to enter the Fortis Colosseum and",
        "advertise the Kebabs. A Minotaur went rogue and I had to defeat",
        "it, but the crowd was still impressed.",
        "I should let Emelio know.",
      ];
    }
    if (stage >= STAGE_MARKETING) {
      const lines = [
        "I spoke to Emelio in Outer Fortis. He asked me for some help in",
        "setting up Varlamore's first Kebab Shop. To do so, I chased up",
        "some Missing Deliveries for him.",
        "With the Missing Deliveries sorted, Emelio and I needed to",
        "perfect the recipe for the Kebabs with the help of some",
        "'Connoisseurs'.",
      ];
      if (hasBit(player, BIT_FIGHT_STARTED)) {
        lines.push(
          "Lelia arranged a slot for me to enter the Fortis Colosseum and",
          "advertise the Kebabs. However, a Minotaur involved in the",
          "advertisement went rogue. I'll need to defeat it."
        );
      } else if (hasBit(player, BIT_LELIA_MET)) {
        lines.push(
          "Lelia at the Fortis Colosseum has arranged a slot for me to",
          "enter the Colosseum and advertise the Kebabs. I should speak",
          "to her when I'm ready to do so."
        );
      } else {
        lines.push(
          "Before we can start selling the Kebabs, Emelio wants us to",
          "market them to the people of Varlamore. He's asked me to take",
          "some to Lelia in the Fortis Colosseum."
        );
      }
      return lines;
    }
    if (stage >= STAGE_TESTED) {
      return [
        "I spoke to Emelio in Outer Fortis. He asked me for some help in",
        "setting up Varlamore's first Kebab Shop. To do so, I chased up",
        "some Missing Deliveries for him.",
        "With the Missing Deliveries sorted, Emelio and I needed to",
        "perfect the recipe for the Kebabs with the help of some",
        "'Connoisseurs'. I should see what Emelio needs now.",
      ];
    }
    if (stage >= STAGE_RECIPE) {
      return [
        "I spoke to Emelio in Outer Fortis. He asked me for some help in",
        "setting up Varlamore's first Kebab Shop. To do so, I chased up",
        "some Missing Deliveries for him.",
        "With the Missing Deliveries sorted, Emelio now needs me to help",
        "perfect the recipe for the Kebabs. He's gathered a selection of",
        "'Connoisseurs' to help with this. I'll need to get their opinions",
        "on the right ratio of Ingredients to create the perfect Kebab.",
      ];
    }
    if (stage >= STAGE_DELIVERIES) {
      return [
        "I spoke to Emelio in Outer Fortis. He asked me for some help in",
        "setting up Varlamore's first Kebab Shop. To do so, I chased up",
        "some Missing Deliveries for him. I should see what he needs now.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "I spoke to Emelio in Outer Fortis. He asked me for help in",
        "setting up Varlamore's first Kebab Shop. To do so, he needs me",
        "to chase up some Missing Deliveries.",
        "",
        ...deliveryLines(player),
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Emelio</col> at his home",
      "in <col=800000>Outer Fortis</col>.",
      "",
      "I must have completed <col=800000>Children of the Sun</col> first.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.COOKING, 8000);
  }

  api.persistAttribute(BITS_ATTRIBUTE);
  api.persistAttribute(RECIPE_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "meat_and_greet",
    name: "Meat and Greet",
    varpId: VARP_MAG_PRIMARY,
    varbitId: VARBIT_MAG_STAGE,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.COOKING.getIndex(), amount: 8000, label: "Cooking" }],
    otherRewards: ["Access to Emelio's Kebab Shop"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:condition", handleDialogueCondition);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  api.onCustomEvent("npc-dialogue:choice", handleDialogueChoice);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onNpcDeath(handleNpcDeath);
  api.onServerStartup(spawnLelia);
  api.onPlayerLogout(despawnQuestMinotaur);
  api.onPlayerLogin(handleLogin);
};
