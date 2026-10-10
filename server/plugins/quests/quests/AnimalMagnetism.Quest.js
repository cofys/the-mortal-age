/**
 * Animal Magnetism (members).
 *
 * The words come from the "Animal Magnetism" transcript page; this plugin supplies
 * the variant selector for Ava, Alice, Malcolm, the Old crone, the Witch and
 * Turael, the prose-condition answers, the item hand-ins, the crone-made-amulet
 * equip refusal, the Rimmington-mine hammer, the undead-tree chop and the
 * chicken-catching cutscene.
 *
 * Stage is varbit 3185 ("anma_main", varp 939 bits 0-7). Evidence: cache quest DB
 * table 0 row 0 ("Animal Magnetism", endstate column 240) and `yarn dump:cs2 4024`
 * case 0 -> `get_varbit 3185`; gamevals name 3185 `anma_main` on varp 939. The
 * values are the real OSRS stages: NPC 4415 (Malcolm) transforms into 4412 at
 * varbit 80, the undead tree 4418 gets its Chop option at varbit 150, and every
 * gap value in those transform tables is -1 (an invisible NPC), so the quest must
 * only ever sit on the values below:
 *
 *   0 not started, 10 Ava asks for chickens, 20 Malcolm told of love, 30 Alice
 *   hears it and mentions the savings, 40 Malcolm says the cash is in the bank,
 *   50 Alice wants the bank pass, 60 Malcolm refuses it, 70 Alice points to the
 *   crone, 73 crone took a hair, 76 crone-made amulet made (deliver to Malcolm),
 *   80 amulet delivered (cutscene), 90 chickens
 *   for sale, 100 chickens bought, 110 one handed to Ava, 120 Ava wants the
 *   magnet (talk to the Witch), 130 Witch asked for 5 iron bars, 140 selected
 *   iron/magnet, 150 magnet delivered (chop an undead tree), 160 tree bounce
 *   (Turael), 170 Turael told, 180 blessed axe (cut twigs), 190 twigs delivered
 *   (research notes), 200 notes translated, 210 notes delivered (pattern), 220
 *   pattern combined with hard leather and polished buttons, 230 container
 *   delivered, 240 complete.
 *
 * Rewards (OSRS Wiki): 1 Quest Point; 1,000 Crafting, 1,000 Fletching, 1,000
 * Slayer and 2,500 Woodcutting XP; Ava's attractor, or Ava's accumulator at
 * Ranged 50+ (the scroll icon is the attractor). 50 Crafting XP is also granted
 * when the magnet is handed to Ava. Requirements to start: The Restless Ghost,
 * Ernest the Chicken and Priest in Peril complete; Slayer 18, Crafting 19,
 * Ranged 30 and Woodcutting 35 (all base levels).
 *
 * Gaps/approximations:
 * - The research-notes translation is OSRS's orb puzzle interface, which this
 *   server has no widget for: Translate consumes the research notes and yields
 *   the translated notes at once (no puzzle).
 * - The Selected iron's "face north" check is not reproduced (the player entity
 *   tracks no facing); hammering anywhere in the Rimmington mine works, so the
 *   "You think that facing North might work better." line never plays.
 * - The chicken-catching cutscene plays through the transcript runtime with a
 *   speaker map (Alice/Cow31337Killer/Sneaky undead fowl get their own chatheads);
 *   Bessie and the cutscene props are not spawned.
 * - The burthorpe world spawn named "Turael" (id 401) resolves to a Light
 *   creature in this cache revision, so the quest spawns the real Turael (13618)
 *   owner-only at (2931,3537) while the varbit is 160-180.
 * - Ava with unmet requirements plays the busy line and the requirement
 *   messages, the closest transcript line for that state.
 * - The ecto-token shortfall, the silent container combine and the requirement
 *   warnings have no transcript variant, so they use plain game messages.
 * - A while-Guthix-Sleeps-completed player would meet Aya instead of Turael; WGS
 *   is not implemented here, so the Aya variants are unreachable.
 *
 * Source: OSRS Wiki (Animal Magnetism, Quick guide, Transcript:Animal Magnetism).
 */
module.exports = function registerAnimalMagnetismQuest(api) {
  const {
    Equipment,
    ItemIdentifiers,
    NpcDefinition,
    NpcIdentifiers,
    Skill,
  } = api.core;
  const {
    loadTranscripts,
    refreshQuestList,
    registerQuest,
    startTranscript,
  } = require("../QuestRuntime");
  const { startDialogue } = require("../../npcs/NpcDialogues.plugin.js");

  const PAGE = "Animal Magnetism";

  // ==========================================================================
  // Stages (varbit 3185 anma_main)
  // ==========================================================================

  const VARP_ANMA_MAIN = 939;
  const VARBIT_ANMA_MAIN = 3185;

  const STAGE_NOT_STARTED = 0;
  const STAGE_STARTED = 10;
  const STAGE_MALCOLM_LOVE = 20;
  const STAGE_ALICE_LOVE = 30;
  const STAGE_MALCOLM_SAVINGS = 40;
  const STAGE_ALICE_SAVINGS = 50;
  const STAGE_MALCOLM_BANK = 60;
  const STAGE_CRONE = 70;
  const STAGE_CRONE_HAIR = 73;
  const STAGE_AMULET = 76;
  const STAGE_MALCOLM_AMULET = 80;
  const STAGE_CUTSCENE = 90;
  const STAGE_CHICKENS = 100;
  const STAGE_CHICKEN_ONE = 110;
  const STAGE_WITCH = 120;
  const STAGE_WITCH_BARS = 130;
  const STAGE_MAGNET = 140;
  const STAGE_TREE = 150;
  const STAGE_TURAEL = 160;
  const STAGE_TURAEL_AXE = 170;
  const STAGE_TWIGS = 180;
  const STAGE_NOTES = 190;
  const STAGE_TRANSLATE = 200;
  const STAGE_GIVE_NOTES = 210;
  const STAGE_BUILD = 220;
  const STAGE_CONTAINER = 230;
  const STAGE_COMPLETE = 240;

  // ==========================================================================
  // NPCs
  // ==========================================================================

  const AVA_NPC_ID = NpcIdentifiers.AVA; // 4407 (spawn 4408 resolves here after Ernest)
  const ALICE_NPC_ID = NpcIdentifiers.ALICE; // 504
  const ALICE_2_NPC_ID = NpcIdentifiers.ALICE_2; // 4422, a transform variant
  const OLD_CRONE_NPC_ID = NpcIdentifiers.OLD_CRONE; // 2996
  const WITCH_NPC_ID = NpcIdentifiers.WITCH_4; // 4409 (spawn 4410 resolves here after Ernest)
  const MALCOLM_NPC_ID = NpcIdentifiers.MALCOLM; // 4411
  const MALCOLM_2_NPC_ID = NpcIdentifiers.MALCOLM_2; // 4412, wearing the crone-made amulet
  const TURAEL_NPC_ID = NpcIdentifiers.TURAEL_4; // 13618
  const UNDEAD_TREE_NPC_ID = NpcIdentifiers.UNDEAD_TREE; // 4417 (spawn 4418 resolves here at stage 150+)
  const COW31337KILLER_NPC_ID = NpcIdentifiers.COW31337KILLER; // 4420, cutscene only
  const SNEAKY_UNDEAD_FOWL_NPC_ID = NpcIdentifiers.SNEAKY_UNDEAD_FOWL; // 4419, cutscene only

  const ALICE_NPC_IDS = new Set([ALICE_NPC_ID, ALICE_2_NPC_ID]);
  const MALCOLM_NPC_IDS = new Set([MALCOLM_NPC_ID, MALCOLM_2_NPC_ID]);

  const TURAEL_SPAWN = { x: 2931, y: 3537, z: 0 };

  // ==========================================================================
  // Items
  // ==========================================================================

  const UNDEAD_CHICKEN_ITEM_ID = ItemIdentifiers.UNDEAD_CHICKEN; // 10487
  const SELECTED_IRON_ITEM_ID = ItemIdentifiers.SELECTED_IRON; // 10488
  const BAR_MAGNET_ITEM_ID = ItemIdentifiers.BAR_MAGNET; // 10489
  const UNDEAD_TWIGS_ITEM_ID = ItemIdentifiers.UNDEAD_TWIGS; // 10490
  const BLESSED_AXE_ITEM_ID = ItemIdentifiers.BLESSED_AXE; // 10491
  const RESEARCH_NOTES_ITEM_ID = ItemIdentifiers.RESEARCH_NOTES; // 10492
  const TRANSLATED_NOTES_ITEM_ID = ItemIdentifiers.TRANSLATED_NOTES; // 10493
  const A_PATTERN_ITEM_ID = ItemIdentifiers.A_PATTERN; // 10494
  const A_CONTAINER_ITEM_ID = ItemIdentifiers.A_CONTAINER; // 10495
  const POLISHED_BUTTONS_ITEM_ID = ItemIdentifiers.POLISHED_BUTTONS; // 10496
  const AVAS_ATTRACTOR_ITEM_ID = ItemIdentifiers.AVAS_ATTRACTOR; // 10498
  const AVAS_ACCUMULATOR_ITEM_ID = ItemIdentifiers.AVAS_ACCUMULATOR; // 10499
  const CRONE_MADE_AMULET_ITEM_ID = ItemIdentifiers.CRONE_MADE_AMULET; // 10500
  const CRONE_MADE_AMULET_ITEM_ID_2 = ItemIdentifiers.CRONE_MADE_AMULET_2; // 17110
  const ECTO_TOKEN_ITEM_ID = ItemIdentifiers.ECTO_TOKEN; // 4278
  const HAMMER_ITEM_ID = ItemIdentifiers.HAMMER; // 2347
  const IRON_BAR_ITEM_ID = ItemIdentifiers.IRON_BAR; // 2351
  const MITHRIL_AXE_ITEM_ID = ItemIdentifiers.MITHRIL_AXE; // 1355
  const HOLY_SYMBOL_ITEM_ID = ItemIdentifiers.HOLY_SYMBOL; // 1718
  const HARD_LEATHER_ITEM_ID = ItemIdentifiers.HARD_LEATHER; // 1743
  const FEATHER_ITEM_ID = ItemIdentifiers.FEATHER; // 314
  const RAW_CHICKEN_ITEM_ID = ItemIdentifiers.RAW_CHICKEN; // 2138
  const COOKED_CHICKEN_ITEM_ID = ItemIdentifiers.COOKED_CHICKEN; // 2140

  const GHOSTSPEAK_AMULET_ITEM_IDS = new Set([
    ItemIdentifiers.GHOSTSPEAK_AMULET, // 552
    ItemIdentifiers.GHOSTSPEAK_AMULET_2, // 4250
    ItemIdentifiers.GHOSTSPEAK_AMULET_3, // 16918
    ItemIdentifiers.GHOSTSPEAK_AMULET_4, // 17771
  ]);
  /** Axes the undead wood refuses before Turael's blessed one (mithril or better). */  const GOOD_AXE_ITEM_IDS = new Set([
    MITHRIL_AXE_ITEM_ID, // 1355
    ItemIdentifiers.ADAMANT_AXE, // 1357
    ItemIdentifiers.RUNE_AXE, // 1359
    ItemIdentifiers.DRAGON_AXE, // 6739
    ItemIdentifiers.CRYSTAL_AXE, // 23673
  ]);
  const CONTAINER_PART_ITEM_IDS = new Set([
    A_PATTERN_ITEM_ID,
    HARD_LEATHER_ITEM_ID,
    POLISHED_BUTTONS_ITEM_ID,
  ]);

  // ==========================================================================
  // Dialogue variants
  // ==========================================================================

  const AVA_START_VARIANT = "starting-out-talking-to-ava";
  const AVA_BUSY_VARIANT = "starting-out-trying-to-trade-ava";
  const AVA_AGAIN_VARIANT = "starting-out-talking-to-ava-again";
  const AVA_CHICKENS_VARIANT = "magnetism-the-next-task";
  const AVA_NO_CHICKENS_VARIANT = "magnetism-the-next-task-speaking-to-ava-without-undead-chickens";
  const AVA_WIELDING_CHICKEN_VARIANT =
    "magnetism-the-next-task-speaking-to-ava-while-wielding-an-undead-chicken";
  const AVA_ONE_CHICKEN_VARIANT = "magnetism-the-next-task-speaking-to-ava-with-one-undead-chicken";
  const AVA_NEED_ANOTHER_VARIANT =
    "magnetism-the-next-task-speaking-to-ava-before-giving-her-another-chicken";
  const AVA_SECOND_CHICKEN_VARIANT =
    "magnetism-the-next-task-handing-over-the-second-chicken-to-ava";
  const AVA_BEFORE_WITCH_VARIANT =
    "magnetism-the-next-task-talking-to-ava-again-before-talking-to-the-witch";
  const AVA_BEFORE_BARS_VARIANT =
    "magnetism-helpful-witch-talking-to-ava-before-giving-the-iron-bars-to-the-witch";
  const AVA_BEFORE_MAGNET_VARIANT = "magnetism-helpful-witch-talking-to-ava-before-making-the-magnet";
  const AVA_GIVE_MAGNET_VARIANT = "the-bark-has-bite-handing-the-magnet-to-ava";
  const AVA_BEFORE_CHOPPING_VARIANT =
    "the-bark-has-bite-handing-the-magnet-to-ava-talking-to-ava-before-chopping-at-undead-trees";
  const AVA_AFTER_BOUNCE_VARIANT = "the-bark-has-bite-returning-to-ava";
  const AVA_BEFORE_BLESSED_AXE_VARIANT =
    "the-bark-has-bite-a-slayer-s-perspective-talking-to-ava-before-obtaining-a-blessed-axe";
  const AVA_AFTER_BLESSED_AXE_VARIANT =
    "the-bark-has-bite-a-slayer-s-perspective-talking-to-ava-after-obtaining-a-blessed-axe";
  const AVA_GIVE_TWIGS_VARIANT = "research-and-development-delivering-the-twigs";
  const AVA_GIVE_NOTES_VARIANT = "research-and-development-talking-to-ava-again";
  const AVA_LOST_NOTES_VARIANT =
    "research-and-development-talking-to-ava-again-talking-to-ava-after-losing-the-research-notes";
  const AVA_HAS_NOTES_VARIANT =
    "research-and-development-talking-to-ava-again-talking-to-ava-with-the-notes";
  const AVA_GIVE_TRANSLATED_VARIANT = "the-final-component-handing-in-the-notes";
  const AVA_HAS_PATTERN_VARIANT =
    "the-final-component-handing-in-the-notes-talking-to-ava-again-with-the-pattern";
  const AVA_LOST_PATTERN_VARIANT =
    "the-final-component-handing-in-the-notes-talking-to-ava-after-losing-the-pattern";
  const AVA_LOST_CONTAINER_VARIANT =
    "the-final-component-handing-in-the-notes-talking-to-ava-having-lost-the-container-or-having-it-in-the-bank";
  const AVA_GIVE_CONTAINER_VARIANT = "the-final-component-delivering-the-container";

  const ALICE_LOVE_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-love-talking-to-alice";
  const ALICE_LOVE_AGAIN_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-love-talking-to-alice-again";
  const ALICE_REPEAT_LOVE_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-love-talking-to-alice-again-before-talking-to-her-husband-again";
  const ALICE_SAVINGS_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-savings-talking-to-alice";
  const ALICE_REPEAT_SAVINGS_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-savings-talking-to-alice-again-before-talking-to-her-husband-again";
  const ALICE_BANK_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-bank-accounts-talking-to-alice-again";
  const ALICE_BEFORE_AMULET_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-bank-accounts-talking-to-alice-before-obtaining-the-amulet";
  const ALICE_RETURNING_VARIANT = "the-alive-undead-chickens-returning-to-alice-speaking-to-alice";

  const MALCOLM_LOVE_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-love-talking-to-malcolm";
  const MALCOLM_REPEAT_LOVE_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-love-talking-to-malcolm-again-before-talking-to-alice";
  const MALCOLM_SAVINGS_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-savings-talking-to-malcolm";
  const MALCOLM_REPEAT_SAVINGS_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-savings-talking-to-malcolm-before-talking-to-alice-again";
  const MALCOLM_BANK_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-bank-accounts-talking-to-malcolm-again";
  const MALCOLM_REPEAT_BANK_VARIANT =
    "the-alive-undead-chickens-the-problem-a-matter-of-bank-accounts-talking-to-malcolm-again-before-talking-to-alice-again";
  const MALCOLM_GIVE_AMULET_VARIANT = "the-alive-undead-chickens-returning-to-alice-speaking-to-malcolm";
  const MALCOLM_CUTSCENE_SETUP_VARIANT =
    "the-alive-undead-chickens-returning-to-alice-speaking-to-malcolm-again";
  const MALCOLM_CUTSCENE_VARIANT = "the-alive-undead-chickens-returning-to-alice-catching-the-chicken";
  const MALCOLM_SELLS_VARIANT =
    "the-alive-undead-chickens-returning-to-alice-speaking-to-malcolm-after-catching-the-chicken";

  const CRONE_FIRST_VARIANT =
    "the-alive-undead-chickens-obtaining-the-amulet-speaking-to-the-old-crone";
  const CRONE_NO_AMULET_VARIANT =
    "the-alive-undead-chickens-obtaining-the-amulet-speaking-to-the-old-crone-without-a-ghostspeak-amulet";
  const CRONE_NO_SPACE_VARIANT =
    "the-alive-undead-chickens-obtaining-the-amulet-speaking-to-the-old-crone-without-inventory-space";
  const CRONE_AGAIN_VARIANT =
    "the-alive-undead-chickens-obtaining-the-amulet-speaking-to-the-old-crone-again";
  const CRONE_LOST_AMULET_VARIANT =
    "the-alive-undead-chickens-obtaining-the-amulet-speaking-to-the-old-crone-after-losing-the-ghostspeak-amulet";
  const CRONE_BEFORE_DELIVERY_VARIANT =
    "the-alive-undead-chickens-obtaining-the-amulet-speaking-to-the-old-crone-before-delivering-the-amulet-to-alice";

  const WITCH_FIRST_VARIANT = "magnetism-helpful-witch";
  const WITCH_GIVE_IRON_VARIANT = "magnetism-helpful-witch-talking-to-the-witch-again";
  const WITCH_NO_IRON_VARIANT =
    "magnetism-helpful-witch-talking-to-the-witch-again-without-iron-bars";
  const WITCH_SOME_IRON_VARIANT =
    "magnetism-helpful-witch-talking-to-the-witch-with-less-than-five-iron-bars";
  const WITCH_LOST_IRON_VARIANT =
    "magnetism-helpful-witch-talking-to-the-witch-after-losing-the-selected-iron";
  const WITCH_BEFORE_MAGNET_VARIANT =
    "magnetism-helpful-witch-talking-to-the-witch-before-making-the-magnet";
  const WITCH_AFTER_MAGNET_VARIANT =
    "magnetism-helpful-witch-talking-to-the-witch-after-creating-the-magnet";

  const TURAEL_FIRST_VARIANT = "the-bark-has-bite-a-slayer-s-perspective-turael";
  const TURAEL_AGAIN_VARIANT =
    "the-bark-has-bite-a-slayer-s-perspective-talking-to-turael-or-aya-again";

  const HAMMER_OUTSIDE_MINE_VARIANT =
    "magnetism-helpful-witch-using-hammer-on-selected-iron-without-being-in-rimmington-mine";
  const HAMMER_IN_MINE_VARIANT = "magnetism-helpful-witch-using-hammer-on-selected-iron-as-intended";

  const TREE_NO_AXE_VARIANT =
    "the-bark-has-bite-handing-the-magnet-to-ava-trying-to-chop-an-undead-tree-without-mithril-axe-or-better-or-without-carrying-an-axe";
  const TREE_BOUNCE_VARIANT =
    "the-bark-has-bite-handing-the-magnet-to-ava-trying-to-chop-an-undead-tree-with-mithril-axe-or-better";
  const TREE_FAIL_VARIANT = "the-bark-has-bite-a-slayer-s-perspective-failing-to-chop-an-undead-tree";
  const TREE_SUCCESS_VARIANT =
    "the-bark-has-bite-a-slayer-s-perspective-successfully-chopping-an-undead-tree";

  const COMBINE_NO_PATTERN_VARIANT =
    "the-final-component-handing-in-the-notes-trying-to-combine-buttons-and-leather-without-a-pattern";
  const COMBINE_NO_LEATHER_VARIANT =
    "the-final-component-handing-in-the-notes-trying-to-combine-buttons-with-pattern-without-hard-leather";
  const COMBINE_NO_BUTTONS_VARIANT =
    "the-final-component-handing-in-the-notes-trying-to-combine-hard-leather-with-pattern-without-buttons";

  const EQUIP_CRONE_AMULET_VARIANT =
    "the-alive-undead-chickens-obtaining-the-amulet-trying-to-equip-the-crone-made-amulet";

  const AVA_ITEM_VARIANTS = new Map([
    [FEATHER_ITEM_ID, "starting-out-using-items-on-ava-feather"],
    [RAW_CHICKEN_ITEM_ID, "starting-out-using-items-on-ava-raw-chicken"],
    [COOKED_CHICKEN_ITEM_ID, "starting-out-using-items-on-ava-cooked-chicken"],
    [UNDEAD_CHICKEN_ITEM_ID, "starting-out-using-items-on-ava-raw-chicken-undead"],
  ]);
  const AVA_OTHER_ITEM_VARIANT = "starting-out-using-items-on-ava-other-items";

  const CUTSCENE_SPEAKERS = new Map([
    ["Alice", ALICE_NPC_ID],
    ["Cow31337Killer", COW31337KILLER_NPC_ID],
    ["Sneaky undead fowl", SNEAKY_UNDEAD_FOWL_NPC_ID],
  ]);

  // ==========================================================================
  // Condition step ids
  // ==========================================================================

  const CONDITION_NO_GHOSTSPEAK_ID = "ja2aUm";
  const CONDITION_GHOSTSPEAK_ID = "11YShB";
  const CONDITION_GHOSTS_AHOY_ID = "ZI3Id0";
  const CONDITION_AXE_AND_SYMBOL_ID = "PTKy3J";
  const CONDITION_ONLY_AXE_ID = "BLdtuR";
  const CONDITION_ONLY_SYMBOL_ID = "hzUTkI";
  const CONDITION_NEITHER_ID = "xPbdc5";
  const CONDITION_RANGED_50_ID = "uU4Wlj";

  // Action/message step ids.
  const ACTION_RECEIVE_ONE_CHICKEN_ID = "mK7Q-a";
  const ACTION_RECEIVE_TWO_CHICKENS_ID = "haQZnJ";
  const ACTION_CONTINUE_SUCCESS_ID = "b_F1lm";
  const ACTION_CRONE_HAIR_ID = "-6EpYR";

  // ==========================================================================
  // Requirements
  // ==========================================================================

  const REQUIRED_QUESTS = [
    { key: "the_restless_ghost", name: "The Restless Ghost" },
    { key: "ernest_the_chicken", name: "Ernest the Chicken" },
    { key: "priest_in_peril", name: "Priest in Peril" },
  ];
  const REQUIRED_SKILLS = [
    { skill: Skill.SLAYER, level: 18, label: "Slayer" },
    { skill: Skill.CRAFTING, level: 19, label: "Crafting" },
    { skill: Skill.RANGED, level: 30, label: "Ranged" },
    { skill: Skill.WOODCUTTING, level: 35, label: "Woodcutting" },
  ];

  /** QuestHelper's Rimmington mine zone (2971..2987 x, 3234..3248 y). */
  const RIMMINGTON_MINE = { minX: 2971, maxX: 2987, minY: 3234, maxY: 3248, levels: [0] };

  let quest;
  /** Owner-only Turael spawn per player, present only while the varbit sits at 160-170. */
  const turaelSpawns = new Map();

  // ==========================================================================
  // Helpers
  // ==========================================================================

  const has = (player, itemId, amount = 1) => player.getInventory().getAmount(itemId) >= amount;

  function hasCroneAmulet(player) {
    return has(player, CRONE_MADE_AMULET_ITEM_ID) || has(player, CRONE_MADE_AMULET_ITEM_ID_2);
  }

  function deleteCroneAmulet(player) {
    if (has(player, CRONE_MADE_AMULET_ITEM_ID)) {
      player.getInventory().deleteNumber(CRONE_MADE_AMULET_ITEM_ID, 1);
    } else {
      player.getInventory().deleteNumber(CRONE_MADE_AMULET_ITEM_ID_2, 1);
    }
  }

  function wearingGhostspeak(player) {
    const amulet = player.getEquipment().get(Equipment.AMULET_SLOT);
    return GHOSTSPEAK_AMULET_ITEM_IDS.has(amulet?.getId?.());
  }

  function wieldingChicken(player) {
    const weapon = player.getEquipment().get(Equipment.WEAPON_SLOT);
    return weapon?.getId?.() === UNDEAD_CHICKEN_ITEM_ID;
  }

  function hasGoodAxe(player) {
    for (const axeId of GOOD_AXE_ITEM_IDS) if (has(player, axeId)) return true;
    return false;
  }

  /** Raw steps of a page variant, for chaining inside the running transcript. */
  function variantSteps(variant) {
    const record = loadTranscripts(api)?.[PAGE];
    const steps = record?.variants?.[variant];
    return Array.isArray(steps) ? steps : [];
  }

  function inZone(location, zone) {
    if (!location) return false;
    if (zone.levels && !zone.levels.includes(location.getZ())) return false;
    return (
      location.getX() >= zone.minX &&
      location.getX() <= zone.maxX &&
      location.getY() >= zone.minY &&
      location.getY() <= zone.maxY
    );
  }

  function questComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsRequirements(player) {
    for (const requirement of REQUIRED_QUESTS) {
      if (!questComplete(player, requirement.key)) return false;
    }
    for (const requirement of REQUIRED_SKILLS) {
      if (player.getSkillManager().getMaxLevel(requirement.skill) < requirement.level) return false;
    }
    return true;
  }

  function notifyRequirements(player) {
    for (const requirement of REQUIRED_QUESTS) {
      if (!questComplete(player, requirement.key)) {
        player.sendMessage(`You must have completed ${requirement.name} to start this quest.`);
      }
    }
    for (const requirement of REQUIRED_SKILLS) {
      if (player.getSkillManager().getMaxLevel(requirement.skill) < requirement.level) {
        player.sendMessage(
          `You need a ${requirement.label} level of at least ${requirement.level} to start this quest.`
        );
      }
    }
  }

  // ==========================================================================
  // Stage / Turael spawn
  // ==========================================================================

  function syncTurael(player) {
    const stage = quest.getStage(player);
    const needed = stage >= STAGE_TURAEL && stage <= STAGE_TURAEL_AXE;
    let npc = turaelSpawns.get(player);
    if (needed) {
      if (npc?.isRegistered?.()) return;
      // Owner-only spawns no longer respawn; clear a stale duplicate first.
      for (const worldNpc of api.getWorld()?.getNpcs?.() ?? []) {
        if (worldNpc?.getOwner?.() === player && worldNpc.getId?.() === TURAEL_NPC_ID) api.removeNpc(worldNpc);
      }
      npc = api.spawnNpc({
        id: TURAEL_NPC_ID,
        x: TURAEL_SPAWN.x,
        y: TURAEL_SPAWN.y,
        z: TURAEL_SPAWN.z,
        wanderRadius: 0,
        owner: player,
        ownerOnly: true,
      });
      if (npc) turaelSpawns.set(player, npc);
      return;
    }
    if (npc) {
      if (npc.isRegistered?.()) api.removeNpc(npc);
      turaelSpawns.delete(player);
    }
  }

  function setStage(player, value) {
    const current = quest.getStage(player);
    if (value < current) return;
    if (value !== current) quest.setStage(player, value);
    syncTurael(player);
  }

  // ==========================================================================
  // Variant selection
  // ==========================================================================

  function selectAvaVariant(player, stage) {
    if (stage >= STAGE_COMPLETE) return null; // the "Ava" page's standard dialogue
    if (stage <= STAGE_NOT_STARTED) return AVA_START_VARIANT;
    if (stage < STAGE_CHICKENS) return AVA_AGAIN_VARIANT;
    if (stage <= STAGE_CHICKEN_ONE) {
      const chickens = player.getInventory().getAmount(UNDEAD_CHICKEN_ITEM_ID);
      if (chickens >= 2) return AVA_CHICKENS_VARIANT;
      if (chickens === 1 && wieldingChicken(player)) return AVA_WIELDING_CHICKEN_VARIANT;
      if (chickens === 1) {
        return stage === STAGE_CHICKENS ? AVA_ONE_CHICKEN_VARIANT : AVA_SECOND_CHICKEN_VARIANT;
      }
      return stage === STAGE_CHICKENS ? AVA_NO_CHICKENS_VARIANT : AVA_NEED_ANOTHER_VARIANT;
    }
    if (stage === STAGE_WITCH) return AVA_BEFORE_WITCH_VARIANT;
    if (stage === STAGE_WITCH_BARS) return AVA_BEFORE_BARS_VARIANT;
    if (stage === STAGE_MAGNET) {
      return has(player, BAR_MAGNET_ITEM_ID) ? AVA_GIVE_MAGNET_VARIANT : AVA_BEFORE_MAGNET_VARIANT;
    }
    if (stage === STAGE_TREE) return AVA_BEFORE_CHOPPING_VARIANT;
    if (stage === STAGE_TURAEL) return AVA_AFTER_BOUNCE_VARIANT;
    if (stage === STAGE_TURAEL_AXE) {
      return has(player, BLESSED_AXE_ITEM_ID) ? AVA_AFTER_BLESSED_AXE_VARIANT : AVA_BEFORE_BLESSED_AXE_VARIANT;
    }
    if (stage === STAGE_TWIGS) {
      if (has(player, UNDEAD_TWIGS_ITEM_ID)) return AVA_GIVE_TWIGS_VARIANT;
      return AVA_AFTER_BLESSED_AXE_VARIANT;
    }
    if (stage === STAGE_NOTES) return AVA_GIVE_NOTES_VARIANT;
    if (stage === STAGE_TRANSLATE) {
      if (has(player, TRANSLATED_NOTES_ITEM_ID)) return AVA_GIVE_TRANSLATED_VARIANT;
      if (has(player, RESEARCH_NOTES_ITEM_ID)) return AVA_HAS_NOTES_VARIANT;
      return AVA_LOST_NOTES_VARIANT;
    }
    if (stage === STAGE_GIVE_NOTES) return AVA_GIVE_TRANSLATED_VARIANT;
    if (stage === STAGE_BUILD) {
      if (has(player, A_CONTAINER_ITEM_ID)) return AVA_GIVE_CONTAINER_VARIANT;
      if (has(player, A_PATTERN_ITEM_ID)) return AVA_HAS_PATTERN_VARIANT;
      return AVA_LOST_PATTERN_VARIANT;
    }
    if (stage === STAGE_CONTAINER) {
      if (has(player, A_CONTAINER_ITEM_ID)) return AVA_GIVE_CONTAINER_VARIANT;
      return AVA_LOST_CONTAINER_VARIANT;
    }
    return null;
  }

  function selectAliceVariant(player, stage) {
    if (stage <= STAGE_NOT_STARTED) return null; // the "Alice" page's standard dialogue
    if (stage >= STAGE_COMPLETE) {
      return { page: "Alice", variant: "after-completion-of-animal-magnetism" };
    }
    if (stage <= STAGE_STARTED) return ALICE_LOVE_VARIANT;
    if (stage === STAGE_MALCOLM_LOVE) return ALICE_LOVE_AGAIN_VARIANT;
    if (stage === STAGE_ALICE_LOVE) return ALICE_REPEAT_LOVE_VARIANT;
    if (stage === STAGE_MALCOLM_SAVINGS) return ALICE_SAVINGS_VARIANT;
    if (stage === STAGE_ALICE_SAVINGS) return ALICE_REPEAT_SAVINGS_VARIANT;
    if (stage === STAGE_MALCOLM_BANK) return ALICE_BANK_VARIANT;
    if (stage <= STAGE_MALCOLM_AMULET) return ALICE_BEFORE_AMULET_VARIANT;
    return ALICE_RETURNING_VARIANT;
  }

  function selectMalcolmVariant(player, stage) {
    if (stage <= STAGE_NOT_STARTED) return null; // the "Malcolm" page's standard dialogue
    if (stage <= STAGE_STARTED) return MALCOLM_LOVE_VARIANT;
    if (stage === STAGE_MALCOLM_LOVE) return MALCOLM_REPEAT_LOVE_VARIANT;
    if (stage === STAGE_ALICE_LOVE) return MALCOLM_SAVINGS_VARIANT;
    if (stage === STAGE_MALCOLM_SAVINGS) return MALCOLM_REPEAT_SAVINGS_VARIANT;
    if (stage === STAGE_ALICE_SAVINGS) return MALCOLM_BANK_VARIANT;
    if (stage === STAGE_MALCOLM_BANK) return MALCOLM_REPEAT_BANK_VARIANT;
    if (stage < STAGE_AMULET) return MALCOLM_REPEAT_BANK_VARIANT;
    if (stage === STAGE_AMULET) {
      return hasCroneAmulet(player) ? MALCOLM_GIVE_AMULET_VARIANT : MALCOLM_REPEAT_BANK_VARIANT;
    }
    if (stage === STAGE_MALCOLM_AMULET) return MALCOLM_CUTSCENE_SETUP_VARIANT;
    return MALCOLM_SELLS_VARIANT;
  }

  function selectCroneVariant(player, stage) {
    if (stage < STAGE_CRONE) return null; // the "Old crone" page's standard dialogue
    if (stage === STAGE_CRONE) return CRONE_FIRST_VARIANT;
    if (stage === STAGE_CRONE_HAIR) {
      if (!wearingGhostspeak(player)) return CRONE_NO_AMULET_VARIANT;
      if (player.getInventory().isFull()) return CRONE_NO_SPACE_VARIANT;
      return CRONE_AGAIN_VARIANT;
    }
    if (stage === STAGE_AMULET) {
      return hasCroneAmulet(player) ? CRONE_BEFORE_DELIVERY_VARIANT : CRONE_LOST_AMULET_VARIANT;
    }
    return { page: "Old crone", variant: "standard-dialogue-after-animal-magnetism-and-ghosts-ahoy" };
  }

  function selectWitchVariant(player, stage) {
    if (stage < STAGE_WITCH) return null; // the "Witch" page's after-Ernest dialogue
    if (stage === STAGE_WITCH) return WITCH_FIRST_VARIANT;
    if (stage === STAGE_WITCH_BARS) {
      if (has(player, IRON_BAR_ITEM_ID, 5)) return WITCH_GIVE_IRON_VARIANT;
      if (has(player, IRON_BAR_ITEM_ID)) return WITCH_SOME_IRON_VARIANT;
      return WITCH_NO_IRON_VARIANT;
    }
    if (stage === STAGE_MAGNET) {
      if (has(player, BAR_MAGNET_ITEM_ID)) return WITCH_AFTER_MAGNET_VARIANT;
      if (has(player, SELECTED_IRON_ITEM_ID)) return WITCH_BEFORE_MAGNET_VARIANT;
      return WITCH_LOST_IRON_VARIANT;
    }
    return { page: "Witch", variant: "standard-dialogue-after-the-completion-of-animal-magnetism" };
  }

  function selectTuraelVariant(player, stage) {
    if (stage === STAGE_TURAEL) return TURAEL_FIRST_VARIANT;
    if (stage === STAGE_TURAEL_AXE) return { page: PAGE, variant: TURAEL_AGAIN_VARIANT };
    return null; // the "Turael" page's standard dialogue
  }

  function selectVariant({ npcId, player }) {
    if (!quest) return null;
    const stage = quest.getStage(player);
    if (npcId === AVA_NPC_ID) return selectAvaVariant(player, stage);
    if (ALICE_NPC_IDS.has(npcId)) return selectAliceVariant(player, stage);
    if (MALCOLM_NPC_IDS.has(npcId)) return selectMalcolmVariant(player, stage);
    if (npcId === OLD_CRONE_NPC_ID) return selectCroneVariant(player, stage);
    if (npcId === WITCH_NPC_ID) return selectWitchVariant(player, stage);
    if (npcId === TURAEL_NPC_ID) return selectTuraelVariant(player, stage);
    return null;
  }

  // ==========================================================================
  // Prose conditions
  // ==========================================================================

  function answerCondition({ npcId, player, stepId }) {
    if (MALCOLM_NPC_IDS.has(npcId)) {
      if (stepId === CONDITION_NO_GHOSTSPEAK_ID) return !wearingGhostspeak(player);
      if (stepId === CONDITION_GHOSTSPEAK_ID) return wearingGhostspeak(player);
      return null;
    }
    if (npcId === OLD_CRONE_NPC_ID) {
      if (stepId === CONDITION_GHOSTS_AHOY_ID) return questComplete(player, "ghosts_ahoy");
      return null;
    }
    if (npcId === TURAEL_NPC_ID) {
      const axe = has(player, MITHRIL_AXE_ITEM_ID);
      const symbol = has(player, HOLY_SYMBOL_ITEM_ID);
      if (stepId === CONDITION_AXE_AND_SYMBOL_ID) return axe && symbol;
      if (stepId === CONDITION_ONLY_AXE_ID) return axe && !symbol;
      if (stepId === CONDITION_ONLY_SYMBOL_ID) return !axe && symbol;
      if (stepId === CONDITION_NEITHER_ID) return !axe && !symbol;
      return null;
    }
    if (npcId === AVA_NPC_ID && stepId === CONDITION_RANGED_50_ID) {
      return player.getSkillManager().getMaxLevel(Skill.RANGED) >= 50;
    }
    return null;
  }

  // ==========================================================================
  // Dialogue side effects
  // ==========================================================================

  /** Ava's start choice and Malcolm's amulet hand-over. */
  function handleChoice(event) {
    const { player, npcId, option } = event;
    if (npcId === AVA_NPC_ID && quest.getStage(player) === STAGE_NOT_STARTED) {
      if (option !== "I would be happy to make your home a better place.") return;
      if (!meetsRequirements(player)) {
        notifyRequirements(player);
        return;
      }
      setStage(player, STAGE_STARTED);
      return;
    }
    if (MALCOLM_NPC_IDS.has(npcId) && quest.getStage(player) === STAGE_AMULET) {
      if (option !== "Okay, you need it more than I do, I suppose.") return;
      if (!hasCroneAmulet(player)) return;
      deleteCroneAmulet(player);
      setStage(player, STAGE_MALCOLM_AMULET);
    }
  }

  /** Conditions whose chosen branch has a gameplay effect. */
  function handleConditionChosen(event) {
    const { player, npcId, stepId } = event;
    if (MALCOLM_NPC_IDS.has(npcId) && stepId === CONDITION_GHOSTSPEAK_ID) {
      if (quest.getStage(player) === STAGE_STARTED) setStage(player, STAGE_MALCOLM_LOVE);
      return;
    }
    if (npcId === TURAEL_NPC_ID && stepId === CONDITION_AXE_AND_SYMBOL_ID) {
      if (quest.getStage(player) !== STAGE_TURAEL_AXE) return;
      if (!has(player, MITHRIL_AXE_ITEM_ID) || !has(player, HOLY_SYMBOL_ITEM_ID)) return;
      player.getInventory().deleteNumber(MITHRIL_AXE_ITEM_ID, 1);
      player.getInventory().deleteNumber(HOLY_SYMBOL_ITEM_ID, 1);
      player.getInventory().adds(BLESSED_AXE_ITEM_ID, 1);
      setStage(player, STAGE_TWIGS);
    }
  }

  /** Chicken purchases and the "Amazing! Success!" continuation. */
  function handleAction(event) {
    const { player, npcId, stepId } = event;
    if (MALCOLM_NPC_IDS.has(npcId)) {
      if (stepId === ACTION_RECEIVE_ONE_CHICKEN_ID) {
        event.handled = true;
        buyUndeadChickens(player, 1);
        return;
      }
      if (stepId === ACTION_RECEIVE_TWO_CHICKENS_ID) {
        event.handled = true;
        buyUndeadChickens(player, 2);
        return;
      }
    }
    if (npcId === AVA_NPC_ID && stepId === ACTION_CONTINUE_SUCCESS_ID) {
      // The second chicken's hand-in continues straight into the "Amazing!
      // Success!" variant; hand the runtime its steps so it keeps the chatbox
      // open instead of starting a second, competing conversation.
      event.handled = true;
      setStage(player, STAGE_WITCH);
      event.steps = variantSteps(AVA_CHICKENS_VARIANT);
      return;
    }
    if (stepId === ACTION_CRONE_HAIR_ID && npcId === OLD_CRONE_NPC_ID) {
      // The message is the transcript's own; only the stage moves.
      if (quest.getStage(player) === STAGE_CRONE) setStage(player, STAGE_CRONE_HAIR);
    }
  }

  function buyUndeadChickens(player, count) {
    const stage = quest.getStage(player);
    if (stage < STAGE_CUTSCENE || stage > STAGE_CHICKEN_ONE) return;
    const cost = count * 10;
    if (!has(player, ECTO_TOKEN_ITEM_ID, cost)) {
      player.sendMessage(`You need ${cost} ecto-tokens to buy ${count === 1 ? "a chicken" : "two chickens"}.`);
      return;
    }
    player.getInventory().deleteNumber(ECTO_TOKEN_ITEM_ID, cost);
    player.getInventory().adds(UNDEAD_CHICKEN_ITEM_ID, count);
    if (stage === STAGE_CUTSCENE) setStage(player, STAGE_CHICKENS);
  }

  /**
   * The transcript hands items over in prose, so the hand-ins are keyed off the
   * exact lines of the variant the selector chose.
   */
  function handleLine(event) {
    const { player, npcId, text } = event;
    const stage = quest.getStage(player);

    if (npcId === AVA_NPC_ID) {
      // While Guthix Sleeps is not implemented, so the wiki's Turael/Aya
      // alternatives always resolve to Turael.
      if (text.includes("[Turael/Aya]") || text.includes("[he's/she's]")) {
        event.text = text
          .replace(/\[Turael\/Aya\]/g, "Turael")
          .replace(/\[He's\/She's\]/g, "He's")
          .replace(/\[he's\/she's\]/g, "he's")
          .replace(/\[his\/her\]/g, "his")
          .replace(/\[him\/her\]/g, "him")
          .replace(/\[he\/she\]/g, "he");
        return;
      }
      if (text === "Here they are." && stage >= STAGE_CHICKENS && stage <= STAGE_CHICKEN_ONE) {
        if (has(player, UNDEAD_CHICKEN_ITEM_ID, 2)) {
          player.getInventory().deleteNumber(UNDEAD_CHICKEN_ITEM_ID, 2);
          setStage(player, STAGE_WITCH);
        }
        return;
      }
      if (text === "Here's one." && stage === STAGE_CHICKENS) {
        if (has(player, UNDEAD_CHICKEN_ITEM_ID)) {
          player.getInventory().deleteNumber(UNDEAD_CHICKEN_ITEM_ID, 1);
          setStage(player, STAGE_CHICKEN_ONE);
        }
        return;
      }
      if (text === "Here's the second one for my reward." && stage === STAGE_CHICKEN_ONE) {
        if (has(player, UNDEAD_CHICKEN_ITEM_ID)) {
          player.getInventory().deleteNumber(UNDEAD_CHICKEN_ITEM_ID, 1);
        }
        return;
      }
      if (text === "I've manufactured the magnet; here it is." && stage === STAGE_MAGNET) {
        if (has(player, BAR_MAGNET_ITEM_ID)) {
          player.getInventory().deleteNumber(BAR_MAGNET_ITEM_ID, 1);
          player.getSkillManager().addExperiences(Skill.CRAFTING, 50);
          setStage(player, STAGE_TREE);
        }
        return;
      }
      if (
        text === "I have that undead wood at last. Well, twigs anyway." &&
        stage === STAGE_TWIGS
      ) {
        if (has(player, UNDEAD_TWIGS_ITEM_ID)) {
          player.getInventory().deleteNumber(UNDEAD_TWIGS_ITEM_ID, 1);
          setStage(player, STAGE_NOTES);
        }
        return;
      }
      if (
        text ===
          "They are still stumping me. Here are the notes; I really hope your head doesn't explode from reading them." &&
        stage === STAGE_NOTES
      ) {
        if (!has(player, RESEARCH_NOTES_ITEM_ID)) player.getInventory().adds(RESEARCH_NOTES_ITEM_ID, 1);
        setStage(player, STAGE_TRANSLATE);
        return;
      }
      if (
        text ===
          "Don't tell me, your cat ate them? You won't get out of the job that easily; here are some copies I made." &&
        stage === STAGE_TRANSLATE
      ) {
        if (!has(player, RESEARCH_NOTES_ITEM_ID)) player.getInventory().adds(RESEARCH_NOTES_ITEM_ID, 1);
        return;
      }
      if (
        text ===
          "I've given you a pattern for the container; you'll need to combine them with some polished buttons and hard leather. Then we're almost done. Good news, eh?" &&
        stage === STAGE_GIVE_NOTES
      ) {
        player.getInventory().deleteNumber(TRANSLATED_NOTES_ITEM_ID, 1);
        if (!has(player, A_PATTERN_ITEM_ID)) player.getInventory().adds(A_PATTERN_ITEM_ID, 1);
        setStage(player, STAGE_BUILD);
        return;
      }
      if (
        text === "Here's a replacement; perhaps if I charged for them, you'd be more careful." &&
        stage === STAGE_BUILD
      ) {
        if (!has(player, A_PATTERN_ITEM_ID)) player.getInventory().adds(A_PATTERN_ITEM_ID, 1);
        return;
      }
      if (
        text ===
          "It's only the final, vital step in your quest that you decided to leave who-knows-where. Don't worry, I have plenty of spares." &&
        stage === STAGE_CONTAINER
      ) {
        if (!has(player, A_PATTERN_ITEM_ID)) player.getInventory().adds(A_PATTERN_ITEM_ID, 1);
        return;
      }
      if (
        text ===
          "Wow, great, now the arrow manufacturer is ready for use...there you are! Talk to me if you need more information later." &&
        stage === STAGE_CONTAINER
      ) {
        if (has(player, A_CONTAINER_ITEM_ID)) {
          player.getInventory().deleteNumber(A_CONTAINER_ITEM_ID, 1);
          quest.complete(player);
        }
      }
      return;
    }

    if (ALICE_NPC_IDS.has(npcId)) {
      if (
        text ===
          "I have a message from your husband. He wants you to know that he still loves you, despite his ghostly state." &&
        stage === STAGE_MALCOLM_LOVE
      ) {
        setStage(player, STAGE_ALICE_LOVE);
        return;
      }
      if (text === "Your husband says he put the cash in the bank." && stage === STAGE_MALCOLM_SAVINGS) {
        setStage(player, STAGE_ALICE_SAVINGS);
        return;
      }
      if (
        text === "What if I gave some sort of altered ghostspeak amulet to him - surely that would work?" &&
        stage === STAGE_MALCOLM_BANK
      ) {
        setStage(player, STAGE_CRONE);
      }
      return;
    }

    if (MALCOLM_NPC_IDS.has(npcId)) {
      if (
        text === "Your wife says she needs the family cash and wants to know what you did with it." &&
        stage === STAGE_ALICE_LOVE
      ) {
        setStage(player, STAGE_MALCOLM_SAVINGS);
        return;
      }
      if (
        text === "You may not believe me, but she wants me to find your bank pass now." &&
        stage === STAGE_ALICE_SAVINGS
      ) {
        setStage(player, STAGE_MALCOLM_BANK);
      }
      return;
    }

    if (npcId === OLD_CRONE_NPC_ID) {
      if (text === "I most certainly am; there you go." && stage === STAGE_CRONE_HAIR) {
        if (!hasCroneAmulet(player) && !player.getInventory().isFull()) {
          player.getInventory().adds(CRONE_MADE_AMULET_ITEM_ID, 1);
        }
        setStage(player, STAGE_AMULET);
        return;
      }
      if (
        text ===
          "Here you are; lucklily, I saved some of Alice's hair in case you were careless. Which you were." &&
        stage === STAGE_AMULET
      ) {
        if (!hasCroneAmulet(player) && !player.getInventory().isFull()) {
          player.getInventory().adds(CRONE_MADE_AMULET_ITEM_ID, 1);
        }
      }
      return;
    }

    if (npcId === WITCH_NPC_ID) {
      if (text === "I'll be back." && stage === STAGE_WITCH) {
        setStage(player, STAGE_WITCH_BARS);
        return;
      }
      if (
        text === "Great, you'll go far! I made some nice painted metal toys for you, snookums." &&
        stage === STAGE_WITCH_BARS
      ) {
        if (has(player, IRON_BAR_ITEM_ID, 5)) {
          player.getInventory().deleteNumber(IRON_BAR_ITEM_ID, 5);
          if (!has(player, SELECTED_IRON_ITEM_ID)) player.getInventory().adds(SELECTED_IRON_ITEM_ID, 1);
          setStage(player, STAGE_MAGNET);
        }
        return;
      }
      if (
        text ===
          "I can't say that I didn't expect this; you'd lose your head if it weren't glued on. Lucky I made some replacements. Take this one and leave me in peace." &&
        stage === STAGE_MAGNET
      ) {
        if (!has(player, SELECTED_IRON_ITEM_ID)) player.getInventory().adds(SELECTED_IRON_ITEM_ID, 1);
      }
      return;
    }

    if (npcId === TURAEL_NPC_ID) {
      if (
        text === "Okay, so I'll see whether I can spare an axe and a symbol. Thanks." &&
        stage === STAGE_TURAEL
      ) {
        setStage(player, STAGE_TURAEL_AXE);
      }
    }
  }

  // ==========================================================================
  // Interactions
  // ==========================================================================

  /** Ava's requirements refusal and the cutscene that starts at varbit 80. */
  function handleNpcInteraction(event) {
    const { player, npcId, clickType } = event;
    if (npcId === AVA_NPC_ID && quest.getStage(player) === STAGE_NOT_STARTED && !meetsRequirements(player)) {
      if (event.definition?.getActions?.()[clickType - 1] !== "Talk-to") return;
      event.handled = true;
      notifyRequirements(player);
      startTranscript(api, player, AVA_NPC_ID, PAGE, AVA_BUSY_VARIANT);
      return;
    }
    if (!MALCOLM_NPC_IDS.has(npcId)) return;
    if (quest.getStage(player) !== STAGE_MALCOLM_AMULET) return;
    if (event.definition?.getActions?.()[clickType - 1] !== "Talk-to") return;
    event.handled = true;
    setStage(player, STAGE_CUTSCENE);
    playCutscene(player, npcId);
  }

  /** Malcolm's catch-the-chicken conversation and cutscene, with real chatheads. */
  function playCutscene(player, npcId) {
    const data = loadTranscripts(api);
    const record = data?.[PAGE];
    const setup = record?.variants?.[MALCOLM_CUTSCENE_SETUP_VARIANT];
    const cutscene = record?.variants?.[MALCOLM_CUTSCENE_VARIANT];
    if (!Array.isArray(setup) || !Array.isArray(cutscene)) {
      startTranscript(api, player, npcId, PAGE, MALCOLM_CUTSCENE_SETUP_VARIANT);
      return;
    }
    const definition = NpcDefinition.forId(npcId);
    startDialogue(
      api,
      { player, npc: null, npcId, definition },
      [...setup, ...cutscene],
      record.branches,
      {
        player,
        npc: null,
        npcId,
        definition,
        speakerIdByName: CUTSCENE_SPEAKERS,
      }
    );
  }

  /** Exotic items Ava has opinions about. */
  function handleItemOnNpc(event) {
    const npcId = event.npcId ?? event.target?.getId?.();
    if (npcId !== AVA_NPC_ID) return;
    if (quest.getStage(event.player) >= STAGE_WITCH) return;
    event.handled = true;
    const variant = AVA_ITEM_VARIANTS.get(event.itemId) ?? AVA_OTHER_ITEM_VARIANT;
    startTranscript(api, event.player, AVA_NPC_ID, PAGE, variant);
  }

  /** Hammer + selected iron in the Rimmington mine, and the container's three parts. */
  function handleItemOnItem(event) {
    const { player, usedItemId, usedWithItemId } = event;
    const ids = new Set([usedItemId, usedWithItemId]);

    if (ids.has(HAMMER_ITEM_ID) && ids.has(SELECTED_IRON_ITEM_ID)) {
      if (quest.getStage(player) !== STAGE_MAGNET) return;
      if (!has(player, SELECTED_IRON_ITEM_ID)) return;
      event.handled = true;
      if (!inZone(player.getLocation(), RIMMINGTON_MINE)) {
        startTranscript(api, player, WITCH_NPC_ID, PAGE, HAMMER_OUTSIDE_MINE_VARIANT);
        return;
      }
      player.getInventory().deleteNumber(SELECTED_IRON_ITEM_ID, 1);
      player.getInventory().adds(BAR_MAGNET_ITEM_ID, 1);
      startTranscript(api, player, WITCH_NPC_ID, PAGE, HAMMER_IN_MINE_VARIANT);
      return;
    }

    if (!CONTAINER_PART_ITEM_IDS.has(usedItemId) || !CONTAINER_PART_ITEM_IDS.has(usedWithItemId)) return;
    if (quest.getStage(player) !== STAGE_BUILD) return;
    event.handled = true;
    const hasPattern = has(player, A_PATTERN_ITEM_ID);
    const hasLeather = has(player, HARD_LEATHER_ITEM_ID);
    const hasButtons = has(player, POLISHED_BUTTONS_ITEM_ID);
    if (hasPattern && hasLeather && hasButtons) {
      player.getInventory().deleteNumber(A_PATTERN_ITEM_ID, 1);
      player.getInventory().deleteNumber(HARD_LEATHER_ITEM_ID, 1);
      player.getInventory().deleteNumber(POLISHED_BUTTONS_ITEM_ID, 1);
      player.getInventory().adds(A_CONTAINER_ITEM_ID, 1);
      setStage(player, STAGE_CONTAINER);
      return;
    }
    const variant = !hasPattern
      ? COMBINE_NO_PATTERN_VARIANT
      : !hasLeather
        ? COMBINE_NO_LEATHER_VARIANT
        : COMBINE_NO_BUTTONS_VARIANT;
    startTranscript(api, player, AVA_NPC_ID, PAGE, variant);
  }

  /** The crone's notes are a puzzle interface in OSRS; here they translate at once. */
  function handleTranslateNotes(event) {
    const { player, itemId } = event;
    if (itemId !== RESEARCH_NOTES_ITEM_ID) return;
    if (quest.getStage(player) !== STAGE_TRANSLATE) return;
    if (!has(player, RESEARCH_NOTES_ITEM_ID)) return;
    event.handled = true;
    player.getInventory().deleteNumber(RESEARCH_NOTES_ITEM_ID, 1);
    player.getInventory().adds(TRANSLATED_NOTES_ITEM_ID, 1);
    setStage(player, STAGE_GIVE_NOTES);
  }

  /** The crone-made amulet is ghost-only wear. */
  function handleCanEquip(event) {
    const itemId = event.item?.getId?.();
    if (itemId !== CRONE_MADE_AMULET_ITEM_ID && itemId !== CRONE_MADE_AMULET_ITEM_ID_2) return;
    event.allow = false;
    startTranscript(api, event.player, OLD_CRONE_NPC_ID, PAGE, EQUIP_CRONE_AMULET_VARIANT);
  }

  /** The undead tree: inert wood until the blessed axe is in the pack. */
  function handleChopUndeadTree(event) {
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_TREE || stage >= STAGE_NOTES) return;
    event.handled = true;
    if (stage >= STAGE_TWIGS && has(player, BLESSED_AXE_ITEM_ID)) {
      if (Math.random() < 0.5) {
        if (!has(player, UNDEAD_TWIGS_ITEM_ID)) player.getInventory().adds(UNDEAD_TWIGS_ITEM_ID, 1);
        startTranscript(api, player, UNDEAD_TREE_NPC_ID, PAGE, TREE_SUCCESS_VARIANT);
      } else {
        startTranscript(api, player, UNDEAD_TREE_NPC_ID, PAGE, TREE_FAIL_VARIANT);
      }
      return;
    }
    if (stage === STAGE_TREE) setStage(player, STAGE_TURAEL);
    startTranscript(
      api,
      player,
      UNDEAD_TREE_NPC_ID,
      PAGE,
      hasGoodAxe(player) ? TREE_BOUNCE_VARIANT : TREE_NO_AXE_VARIANT
    );
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
    syncTurael(player);
  }

  // ==========================================================================
  // Journal / reward
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I fetched two undead chickens for Ava and helped Malcolm</str>",
        "<str>and Alice talk again with a crone-made amulet.</str>",
        "<str>I built her arrow-making device and she rewarded me.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage <= STAGE_NOT_STARTED) {
      return [
        "I can start this quest by speaking to <col=800000>Ava</col> in the",
        "<col=800000>Draynor Manor</col> west wing.",
        "",
        "I must have completed <col=800000>The Restless Ghost</col>,",
        "<col=800000>Ernest the Chicken</col> and <col=800000>Priest in Peril</col>.",
      ];
    }
    if (stage <= STAGE_CRONE_HAIR) {
      return [
        "Ava wants two <col=800000>undead chickens</col> from the farm west",
        "of the Ectofuntus. Alice said to speak to her dead husband",
        "<col=800000>Malcolm</col>, and Alice now wants a witch to make",
        "an amulet so she can speak to him herself.",
      ];
    }
    if (stage <= STAGE_MALCOLM_AMULET) {
      return [
        "The <col=800000>Old crone</col> made a <col=800000>crone-made amulet</col> from",
        "Alice's hair. I should give it to <col=800000>Malcolm</col>.",
      ];
    }
    if (stage <= STAGE_CHICKEN_ONE) {
      return [
        "Malcolm can talk to Alice now. I should buy two",
        "<col=800000>undead chickens</col> from him for 10 ecto-tokens each",
        "and take them to <col=800000>Ava</col>.",
      ];
    }
    if (stage <= STAGE_WITCH_BARS) {
      return [
        "Ava needs a <col=800000>magnet</col> next. She told me to ask the",
        "<col=800000>Witch</col> in Draynor Manor, who wants 5 iron bars.",
      ];
    }
    if (stage <= STAGE_MAGNET) {
      return [
        "The Witch gave me a <col=800000>selected iron</col>. I must hammer it",
        "in the <col=800000>Rimmington mine</col> to make a magnet, then",
        "give it to <col=800000>Ava</col>.",
      ];
    }
    if (stage <= STAGE_TURAEL_AXE) {
      return [
        "Ava needs <col=800000>undead twigs</col> from the trees around the",
        "manor. My axe bounces off, so I should ask",
        "<col=800000>Turael</col> in Burthorpe for a blessed axe.",
      ];
    }
    if (stage <= STAGE_NOTES) {
      return [
        "I have the <col=800000>blessed axe</col>. I should cut an",
        "<col=800000>undead tree</col> and bring the twigs to <col=800000>Ava</col>.",
      ];
    }
    if (stage <= STAGE_TRANSLATE) {
      return [
        "Ava gave me <col=800000>research notes</col>. I should translate them.",
      ];
    }
    if (stage <= STAGE_GIVE_NOTES) {
      return [
        "I translated the notes. I should take them back to <col=800000>Ava</col>.",
      ];
    }
    if (stage <= STAGE_BUILD) {
      return [
        "Ava gave me a <col=800000>pattern</col>. I should combine it with",
        "<col=800000>hard leather</col> and <col=800000>polished buttons</col>.",
      ];
    }
    return [
      "I have made <col=800000>a container</col>. I should give it to",
      "<col=800000>Ava</col> to finish her device.",
    ];
  }

  function grantReward(player) {
    const itemId =
      player.getSkillManager().getMaxLevel(Skill.RANGED) >= 50
        ? AVAS_ACCUMULATOR_ITEM_ID
        : AVAS_ATTRACTOR_ITEM_ID;
    player.getSkillManager().addExperiences(Skill.CRAFTING, 1000);
    player.getSkillManager().addExperiences(Skill.FLETCHING, 1000);
    player.getSkillManager().addExperiences(Skill.SLAYER, 1000);
    player.getSkillManager().addExperiences(Skill.WOODCUTTING, 2500);
    player.getInventory().adds(itemId, 1);
  }

  quest = registerQuest(api, {
    key: "animal_magnetism",
    name: "Animal Magnetism",
    varpId: VARP_ANMA_MAIN,
    varbitId: VARBIT_ANMA_MAIN,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: Skill.CRAFTING.getIndex(), amount: 1000, label: "Crafting" },
      { skillId: Skill.FLETCHING.getIndex(), amount: 1000, label: "Fletching" },
      { skillId: Skill.SLAYER.getIndex(), amount: 1000, label: "Slayer" },
      { skillId: Skill.WOODCUTTING.getIndex(), amount: 2500, label: "Woodcutting" },
    ],
    scrollItemId: AVAS_ATTRACTOR_ITEM_ID,
    rewardItemLabel: "Ava's attractor (or accumulator at 50 Ranged)",
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onNpcInteraction(handleNpcInteraction);
  api.onNpcInteraction("Undead tree", { Chop: handleChopUndeadTree });
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:condition", handleConditionChosen);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:line", handleLine);
  api.onItemOnNpc(handleItemOnNpc);
  api.onItemOnItem(handleItemOnItem);
  api.onItemAction("Research notes", { Translate: handleTranslateNotes });
  api.onCanEquip(handleCanEquip);
  api.onPlayerLogin(handleLogin);
};
