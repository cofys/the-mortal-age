/**
 * Scrambled! (members).
 *
 * The words come from the "Scrambled!" transcript page (OSRS Wiki). The stage
 * lives in varbit 16758 ("scrambled", bits 0-6 of varp 4748 "scrambled_primary";
 * varp 4749 "scrambled_puzzle" is the unimplemented puzzle's own varp):
 *   0 not started, 1 Alan accepted (egg on the ground), 2 the broken egg
 *   inspected (go to town), 3 King briefed (rally her men), 4 all three men
 *   gathered at the temple, 5 the replacement-egg plan told (gather eggs),
 *   6 all three replacement eggs handed in, 7 the eggs judged (puzzle pending),
 *   8 complete (varbit checkpoints 16758 = 0,1,2,3,4,5,6,7,8).
 *
 * The three men each move from Tal Teklan to Tal Teok. The static spawns
 * (14506/14507/14508 and Alan 14476) are the cache's silent cutscene ids with no
 * options, so the plugin spawns owner-only talkable copies (14503-14505, Alan
 * 14475) at the same tiles. NPCs 14488 "Humphrey Dumphrey" (Inspect) and the
 * temple replacement eggs 14490-14495 are spawned owner-only too; the level-16
 * large chicken (14510), level-106 red dragon (14511) and level-88 black jaguar
 * (14512) guard owner-only egg-pile ground items because the cache does not place
 * the Egg Pile locs (56927-56934 are absent from every map region).
 *
 * The whetstone and the racing cart are proxied through the Blacksmith (use a
 * hammer on him) and Kauayotl (use a plank on him) because the Whetstone
 * (56937-56940) and Cart (56942-56944) locs are also unplaced. The egg-piece
 * puzzle (its interface does not exist here) is reduced to the wiki's
 * "attempts to put the eggs together" line, and the wiki's "That's the last one.
 * Let's get these eggs judged." transition line is skipped.
 *
 * Source: OSRS Wiki "Scrambled!" page, quick guide and transcript.
 * Rewards per the OSRS Wiki: 1 Quest point, 5,000 Construction, Cooking and
 * Smithing XP; the pet Egg from the egg on the wall and Alan's bones afterwards.
 */
module.exports = function registerScrambledQuest(api) {
  const {
    Item,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    Skill,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const PAGE = "Scrambled!";
  const START_HOOK = "quest:scrambled:start";

  // Varp 4748 "scrambled_primary"; the stage is varbit 16758 "scrambled".
  const VARP_SCRAMBLED = 4748;
  const VARBIT_SCRAMBLED_STAGE = 16758;

  const STAGE_NOT_STARTED = 0;
  const STAGE_STARTED = 1;
  const STAGE_INSPECTED = 2;
  const STAGE_MEN = 3;
  const STAGE_GATHERED = 4;
  const STAGE_PLAN = 5;
  const STAGE_GIVEN = 6;
  const STAGE_JUDGED = 7;
  const STAGE_COMPLETE = 8;

  // ==========================================================================
  // NPCs
  // ==========================================================================

  const ALAN_NPC_ID = NpcIdentifiers.ALAN_2; // 14475, Talk-to (static 14476 is silent)
  const CITIZEN_NPC_IDS = new Set([
    NpcIdentifiers.CITIZEN_125, // 14763
    NpcIdentifiers.CITIZEN_126, // 14764
    NpcIdentifiers.CITIZEN_127, // 14765
    NpcIdentifiers.CITIZEN_128, // 14766
    NpcIdentifiers.CITIZEN_129, // 14767
    NpcIdentifiers.CITIZEN_130, // 14768
    NpcIdentifiers.CITIZEN_131, // 14769
    NpcIdentifiers.CITIZEN_132, // 14770
    NpcIdentifiers.FARMER_34, // 14773
  ]);
  const KING_NPC_ID = NpcIdentifiers.KING; // 14496
  const JATZIRI_NPC_ID = NpcIdentifiers.JATZIRI_TEOKI_OF_RALOS; // 14726
  const ACATZIN_NPC_ID = NpcIdentifiers.ACATZIN; // 14505
  const NEZKETI_NPC_ID = NpcIdentifiers.NEZKETI; // 14503
  const KAUAYOTL_NPC_ID = NpcIdentifiers.KAUAYOTL; // 14504
  const BLACKSMITH_NPC_ID = NpcIdentifiers.BLACKSMITH_4; // 14509
  const EGG_INSPECT_NPC_ID = NpcIdentifiers.HUMPHREY_DUMPHREY_2; // 14488, Inspect
  const PET_EGG_NPC_ID = NpcIdentifiers.HUMPHREY_DUMPHREY; // 14487, Talk-to
  const CHICKEN_EGG_NPC_ID = NpcIdentifiers.COL_00FFFF_CHICKEN_EGG_COL; // 14490
  const DRAGON_EGG_NPC_ID = NpcIdentifiers.COL_00FFFF_DRAGON_EGG_COL; // 14492
  const JAGUAR_EGG_NPC_ID = NpcIdentifiers.COL_00FFFF_JAGUAR_EGG_COL; // 14494
  const LARGE_CHICKEN_NPC_ID = NpcIdentifiers.LARGE_CHICKEN; // 14510
  const RED_DRAGON_NPC_ID = NpcIdentifiers.RED_DRAGON_9; // 14511
  const BLACK_JAGUAR_NPC_ID = NpcIdentifiers.BLACK_JAGUAR_2; // 14512
  const GUARDIAN_NPC_IDS = new Set([LARGE_CHICKEN_NPC_ID, RED_DRAGON_NPC_ID, BLACK_JAGUAR_NPC_ID]);

  const ALAN_TILE = { x: 1247, y: 3167 };
  const TOWN_TILES = {
    acatzin: { x: 1226, y: 3118 },
    nezketi: { x: 1226, y: 3104 },
    kauayotl: { x: 1250, y: 3106 },
  };
  const TEMPLE_TILES = {
    acatzin: { x: 1244, y: 3168 },
    nezketi: { x: 1250, y: 3168 },
    kauayotl: { x: 1247, y: 3169 },
  };
  const EGG_NPC_TILE = { x: 1246, y: 3164 };
  const CHICKEN_EGG_TILE = { x: 1244, y: 3166 };
  const JAGUAR_EGG_TILE = { x: 1250, y: 3166 };
  const DRAGON_EGG_TILE = { x: 1247, y: 3165 };
  const BONES_TILE = new Location(1247, 3163, 0);
  const BOWL_TILE = new Location(1219, 3120, 0);

  // ==========================================================================
  // Items
  // ==========================================================================

  const LARGE_EGG_ITEM_ID = ItemIdentifiers.LARGE_EGG; // 30967
  const DRAGON_EGG_ITEM_ID = ItemIdentifiers.DRAGON_EGG; // 30968
  const JAGUAR_EGG_ITEM_ID = ItemIdentifiers.JAGUAR_EGG; // 30969
  const PET_EGG_ITEM_ID = ItemIdentifiers.EGG_4; // 30970
  const ALANS_BONES_ITEM_ID = ItemIdentifiers.ALANS_BONES; // 30973
  const DAMIANA_LEAVES_ITEM_ID = ItemIdentifiers.DAMIANA_LEAVES; // 30977
  const DAMIANA_WATER_ITEM_ID = ItemIdentifiers.DAMIANA_WATER; // 30979
  const DAMIANA_TEA_BOWL_ITEM_ID = ItemIdentifiers.DAMIANA_TEA; // 30981
  const DAMIANA_TEA_CUP_ITEM_ID = ItemIdentifiers.CUP_OF_TEA_22; // 30985
  const DAMAGED_AXE_ITEM_ID = ItemIdentifiers.ACATZINS_AXE; // 30989
  const FIXED_AXE_ITEM_ID = ItemIdentifiers.ACATZINS_AXE_2; // 30990
  const EMPTY_CUP_ITEM_ID = ItemIdentifiers.EMPTY_CUP; // 1980
  const BOWL_ITEM_ID = ItemIdentifiers.BOWL; // 1923
  const BOWL_OF_WATER_ITEM_ID = ItemIdentifiers.BOWL_OF_WATER; // 1921
  const BOWL_OF_HOT_WATER_ITEM_ID = ItemIdentifiers.BOWL_OF_HOT_WATER; // 4456
  const CUP_OF_TEA_ITEM_ID = ItemIdentifiers.CUP_OF_TEA; // 712
  const HAMMER_ITEM_ID = ItemIdentifiers.HAMMER; // 2347
  const SAW_ITEM_ID = ItemIdentifiers.SAW; // 8794
  const PLANK_ITEM_ID = ItemIdentifiers.PLANK; // 960
  const IRON_NAILS_ITEM_ID = ItemIdentifiers.IRON_NAILS; // 4820

  const CART_TOOL_ITEM_IDS = new Set([HAMMER_ITEM_ID, SAW_ITEM_ID, PLANK_ITEM_ID, IRON_NAILS_ITEM_ID]);

  // ==========================================================================
  // Objects
  // ==========================================================================

  const DAMIANA_OBJECT_ID = ObjectIdentifiers.DAMIANA; // 56935, Pick
  const WORKBENCH_OBJECT_ID = ObjectIdentifiers.WORKBENCH_28; // 56945, Search

  // ==========================================================================
  // State bits (persisted "quest.scrambled.bits")
  // ==========================================================================

  const BITS_ATTRIBUTE = "quest.scrambled.bits";

  const BIT_ACATZIN_ASKED = 1 << 0;
  const BIT_ACATZIN_REFUSED = 1 << 1;
  const BIT_ACATZIN_DEPARTED = 1 << 2;
  const BIT_NEZKETI_ASKED = 1 << 3;
  const BIT_NEZKETI_REFUSED = 1 << 4;
  const BIT_NEZKETI_DEPARTED = 1 << 5;
  const BIT_KAUAYOTL_ASKED = 1 << 6;
  const BIT_KAUAYOTL_REFUSED = 1 << 7;
  const BIT_KAUAYOTL_FIXED = 1 << 8;
  const BIT_KAUAYOTL_DEPARTED = 1 << 9;
  const BIT_CITIZEN_MET = 1 << 10;
  const BIT_BLACKSMITH_TOLD = 1 << 11;
  const BIT_WHETSTONE_FIXED = 1 << 12;
  const BIT_AXE_RECEIVED = 1 << 13;
  const BIT_PLAN_TOLD = 1 << 14;
  const BIT_CHICKEN_TAKEN = 1 << 15;
  const BIT_JAGUAR_TAKEN = 1 << 16;
  const BIT_DRAGON_TAKEN = 1 << 17;
  const BIT_CHICKEN_DEAD = 1 << 18;
  const BIT_JAGUAR_DEAD = 1 << 19;
  const BIT_DRAGON_DEAD = 1 << 20;
  const BIT_CHICKEN_GIVEN = 1 << 21;
  const BIT_JAGUAR_GIVEN = 1 << 22;
  const BIT_DRAGON_GIVEN = 1 << 23;
  const BIT_PET_EGG_RECEIVED = 1 << 24;
  const BIT_WORKBENCH_SEARCHED = 1 << 25;

  const EGG_BITS = new Set([
    BIT_CHICKEN_TAKEN, BIT_JAGUAR_TAKEN, BIT_DRAGON_TAKEN,
    BIT_CHICKEN_DEAD, BIT_JAGUAR_DEAD, BIT_DRAGON_DEAD,
    BIT_CHICKEN_GIVEN, BIT_JAGUAR_GIVEN, BIT_DRAGON_GIVEN,
  ]);

  // ==========================================================================
  // Transcript variants
  // ==========================================================================

  const V_START = "starting-off";
  const V_EGG_INSPECT = "starting-off-the-great-fall";
  const V_JATZIRI = "starting-off-the-great-fall-talking-to-jatziri";
  const V_CITIZEN = "starting-off-the-great-fall-talking-to-the-nearby-farmer-or-citizen";
  const V_KING_CITIZEN = "starting-off-the-great-fall-talking-to-the-king-the-bartender";
  const V_KING_DIRECT = "starting-off-the-great-fall-talking-to-king-first-without-talking-to-anyone-else";
  const V_KING_AGAIN = "starting-off-the-great-fall-talking-to-king-again";
  const V_KING_MEN = "talking-to-king-after-gathering-all-her-men";
  const V_KING_POST = "post-quest-dialogue-king";

  const V_ACATZIN_INTRO = "all-the-king-s-men-talking-to-acatzin";
  const V_ACATZIN_REFUSED = "all-the-king-s-men-talking-to-acatzin-talking-to-acatzin-after-refusing-to-talk-to-the-blacksmith";
  const V_ACATZIN_AGAIN = "all-the-king-s-men-talking-to-acatzin-subsequent-dialogue-with-acatzin";
  const V_ACATZIN_AXE = "all-the-king-s-men-talking-to-the-blacksmith-talking-to-acatzin-after-receiving-the-axe";
  const V_ACATZIN_POST = "post-quest-dialogue-acatzin";

  const V_BS_INTRO = "all-the-king-s-men-talking-to-the-blacksmith";
  const V_BS_AGAIN = "all-the-king-s-men-talking-to-the-blacksmith-talking-to-the-blacksmith-again-before-repairing-the-whetstone";
  const V_BS_REPAIR = "all-the-king-s-men-talking-to-the-blacksmith-repairing-the-whetstone";
  const V_BS_AFTER = "all-the-king-s-men-talking-to-the-blacksmith-talking-to-the-blacksmith-after-repairing-the-whetstone";

  const V_NEZKETI_INTRO = "all-the-king-s-men-talking-to-nezketi";
  const V_NEZKETI_REFUSED = "all-the-king-s-men-talking-to-nezketi-talking-to-nezketi-after-refusing-to-give-him-tea";
  const V_NEZKETI_AGAIN = "all-the-king-s-men-talking-to-nezketi-subsequent-dialogue-with-nezketi";
  const V_NEZKETI_MAKING_TEA = "all-the-king-s-men-talking-to-nezketi-making-the-tea";
  const V_NEZKETI_TEA = "all-the-king-s-men-talking-to-nezketi-talking-to-nezketi-with-brewed-tea";
  const V_NEZKETI_POST = "post-quest-dialogue-nezketi";

  const V_KAUAYOTL_INTRO = "all-the-king-s-men-talking-to-kauayotl";
  const V_KAUAYOTL_REFUSED = "all-the-king-s-men-talking-to-kauayotl-talking-to-kauayotl-again-after-refusing-to-help";
  const V_KAUAYOTL_AGAIN = "all-the-king-s-men-talking-to-kauayotl-subsequent-dialogue-with-kauayotl";
  const V_KAUAYOTL_REPAIR = "all-the-king-s-men-talking-to-kauayotl-fixing-the-cart";
  const V_KAUAYOTL_AFTER = "all-the-king-s-men-talking-to-kauayotl-talking-to-kauayotl-after-fixing-the-cart";
  const V_KAUAYOTL_POST = "post-quest-dialogue-kauayotl";

  const V_TEMPLE_PLAN = "talking-to-king-after-gathering-all-her-men-talking-to-any-of-king-s-men-at-the-temple";
  const V_REMIND_ACATZIN = "talking-to-king-after-gathering-all-her-men-talking-to-king-s-men-again-talking-to-acatzin";
  const V_REMIND_NEZKETI = "talking-to-king-after-gathering-all-her-men-talking-to-king-s-men-again-talking-to-nezketi";
  const V_REMIND_KAUAYOTL = "talking-to-king-after-gathering-all-her-men-talking-to-king-s-men-again-talking-to-kauayotl";

  const V_GIVE_CHICKEN = "after-collecting-the-three-eggs-talking-to-acatzin";
  const V_GIVE_CHICKEN_AGAIN = "after-collecting-the-three-eggs-talking-to-acatzin-talking-to-acatzin-again";
  const V_GIVE_DRAGON = "after-collecting-the-three-eggs-kauayotl";
  const V_GIVE_DRAGON_AGAIN = "after-collecting-the-three-eggs-kauayotl-talking-to-kauayotl-again";
  const V_GIVE_JAGUAR = "after-collecting-the-three-eggs-nezketi";
  const V_GIVE_JAGUAR_AGAIN = "after-collecting-the-three-eggs-nezketi-talking-to-nezketi-again";
  const V_JUDGE = "judging-the-eggs";
  const V_FIX = "judging-the-eggs-talking-to-any-of-king-s-men-before-putting-humphrey-dumphrey-back-together";

  const V_PILE_CHICKEN = "talking-to-king-after-gathering-all-her-men-interacting-with-the-pile-of-eggs-large-chicken-s-egg-pile";
  const V_PILE_JAGUAR = "talking-to-king-after-gathering-all-her-men-interacting-with-the-pile-of-eggs-jaguar-s-egg-pile";
  const V_PILE_DRAGON = "talking-to-king-after-gathering-all-her-men-interacting-with-the-pile-of-eggs-red-dragon-s-egg-pile";

  // ==========================================================================
  // Condition step ids
  // ==========================================================================

  const PROFANITY_ON_IDS = new Set(["XIV3xs", "8wyNJx", "HpBDKB"]);
  const PROFANITY_OFF_IDS = new Set(["31iRqs", "7O2bIU", "4D6mHx"]);
  const EGG_INTERACT_CONDITION_ID = "nqU4Qn";

  const NO_SMITHING_CONDITION_ID = "jd3uiy";
  const SMITHING_CONDITION_ID = "sX4CDu";
  const NO_HAMMER_CONDITION_ID = "iqpELc";
  const HAMMER_CONDITION_ID = "81aaOL";

  const NO_SPACE_AXE_CONDITION_ID = "wJL8nr";
  const SPACE_AXE_CONDITION_ID = "bq8dgW";
  const HAS_BROKEN_AXE_CONDITION_ID = "DRj_is";
  const HAS_FIXED_AXE_CONDITION_ID = "j7DTpN";

  const NO_SPACE_CUP_CONDITION_ID = "m0_j_t";
  const HAS_CUP_CONDITION_ID = "0GmlhG";
  const NO_CUP_CONDITION_ID = "nFi8iD";
  const NO_SPACE_REGIVE_CONDITION_ID = "WjYKqn";

  const LEAVES_ON_CUP_CONDITION_ID = "1cNTsz";
  const LEAVES_ON_BOWL_CONDITION_ID = "oZjb1-";
  const LEAVES_ON_WATER_CONDITION_ID = "jHtr8H";
  const LEAVES_ON_HOT_CONDITION_ID = "_4z3lk";
  const BOIL_CONDITION_ID = "SINu3i";
  const TEA_BOWL_CONDITION_ID = "aLq4lu";
  const TEA_OTHER_CONDITION_ID = "2Lt2Ms";
  const TEA_CUP_CONDITION_ID = "Xng0jB";

  const NO_CONSTRUCTION_CONDITION_ID = "SAFyQ6";
  const CONSTRUCTION_CONDITION_ID = "YBtv6Z";
  const NO_CART_ITEMS_CONDITION_ID = "L_ogIR";
  const CART_ITEMS_CONDITION_ID = "5uVvuD";

  const PILE_CONDITION_IDS = new Set([
    "spety9", "2UjyxQ", "-HzjUb",
    "JuFOIQ", "470ssp", "4Gi17J",
    "tGBrGi", "Q8GqFE", "CWV8aX",
  ]);

  // ==========================================================================
  // Action / message step ids
  // ==========================================================================

  const WHETSTONE_FIXED_STEP = "RjBq3R";
  const AXE_RECEIVE_STEP = "cXz59o";
  const AXE_HANDED_STEP = "vP_T1a";
  const CUP_GIVEN_1_STEP = "MKmsN9";
  const CUP_GIVEN_2_STEP = "GZ5xmp";
  const TEA_LEAVES_ADDED_STEP = "Q7zTx5";
  const TEA_BREWED_STEP = "8UQD6q";
  const TEA_XP_STEP = "EQiiPp";
  const TEA_HANDED_STEP = "mLipel";
  const CART_FIXED_STEP = "hRq_q5";
  const KAUAYOTL_DEPARTED_STEP = "i-UzgE";
  const EGG_BROKEN_STEP = "pR1dDX";
  const ALL_EGGS_FALL_STEP = "dPmRwZ";
  const FIX_ATTEMPT_STEP = "QzLEE2";
  const MEN_LEAVE_STEP = "R85gy5";
  const ALAN_DIES_STEP = "Txl_sf";
  const CHICKEN_SETUP_STEP = "0pMMZD";
  const JAGUAR_SETUP_STEP = "NXRXMq";
  const DRAGON_SETUP_STEP = "teOflj";

  // ==========================================================================
  // Pile table
  // ==========================================================================

  const PILES = [
    {
      itemId: LARGE_EGG_ITEM_ID,
      tile: { x: 1241, y: 3141 },
      guardianId: LARGE_CHICKEN_NPC_ID,
      guardianTile: { x: 1242, y: 3142 },
      variant: V_PILE_CHICKEN,
      key: "chicken",
      deadBit: BIT_CHICKEN_DEAD,
      takenBit: BIT_CHICKEN_TAKEN,
      givenBit: BIT_CHICKEN_GIVEN,
      attemptId: "spety9",
      takeId: "2UjyxQ",
      noSpaceId: "-HzjUb",
    },
    {
      itemId: JAGUAR_EGG_ITEM_ID,
      tile: { x: 1332, y: 3121 },
      guardianId: BLACK_JAGUAR_NPC_ID,
      guardianTile: { x: 1336, y: 3121 },
      variant: V_PILE_JAGUAR,
      key: "jaguar",
      deadBit: BIT_JAGUAR_DEAD,
      takenBit: BIT_JAGUAR_TAKEN,
      givenBit: BIT_JAGUAR_GIVEN,
      attemptId: "JuFOIQ",
      takeId: "470ssp",
      noSpaceId: "4Gi17J",
    },
    {
      itemId: DRAGON_EGG_ITEM_ID,
      tile: { x: 1258, y: 9482 },
      guardianId: RED_DRAGON_NPC_ID,
      guardianTile: { x: 1255, y: 9482 },
      variant: V_PILE_DRAGON,
      key: "dragon",
      deadBit: BIT_DRAGON_DEAD,
      takenBit: BIT_DRAGON_TAKEN,
      givenBit: BIT_DRAGON_GIVEN,
      attemptId: "tGBrGi",
      takeId: "Q8GqFE",
      noSpaceId: "CWV8aX",
    },
  ];
  const PILE_BY_ITEM = new Map(PILES.map((pile) => [pile.itemId, pile]));

  /** The tea-making condition matching a just-performed item use. */
  const teaAction = new WeakMap();
  /** Tracked owner-only spawns, keyed by role tag. */
  const trackedNpcs = new WeakMap();

  let quest;
  let groundItems;

  // ==========================================================================
  // State helpers
  // ==========================================================================

  function bits(player) {
    return Number(player.getAttribute(BITS_ATTRIBUTE)) || 0;
  }

  function hasBit(player, bit) {
    return (bits(player) & bit) !== 0;
  }

  function setBit(player, bit) {
    player.setAttribute(BITS_ATTRIBUTE, bits(player) | bit);
  }

  function clearBit(player, bit) {
    player.setAttribute(BITS_ATTRIBUTE, bits(player) & ~bit);
  }

  const held = (player, itemId, amount = 1) => player.getInventory().getAmount(itemId) >= amount;
  const full = (player) => player.getInventory().getFreeSlots() < 1;

  function hasAnyBowl(player) {
    return (
      held(player, BOWL_ITEM_ID) ||
      held(player, BOWL_OF_WATER_ITEM_ID) ||
      held(player, BOWL_OF_HOT_WATER_ITEM_ID) ||
      held(player, DAMIANA_WATER_ITEM_ID) ||
      held(player, DAMIANA_TEA_BOWL_ITEM_ID)
    );
  }

  function hasAnyTea(player) {
    return (
      held(player, DAMIANA_TEA_BOWL_ITEM_ID) ||
      held(player, DAMIANA_TEA_CUP_ITEM_ID) ||
      held(player, CUP_OF_TEA_ITEM_ID)
    );
  }

  function hasAllCartItems(player) {
    return (
      held(player, PLANK_ITEM_ID, 2) &&
      held(player, IRON_NAILS_ITEM_ID, 6) &&
      held(player, HAMMER_ITEM_ID) &&
      held(player, SAW_ITEM_ID)
    );
  }

  function questComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsRequirements(player) {
    if (!questComplete(player, "children_of_the_sun")) return false;
    const skills = player.getSkillManager();
    return (
      skills.getMaxLevel(Skill.CONSTRUCTION) >= 38 &&
      skills.getMaxLevel(Skill.COOKING) >= 36 &&
      skills.getMaxLevel(Skill.SMITHING) >= 35
    );
  }

  function notifyRequirements(player) {
    if (!questComplete(player, "children_of_the_sun")) {
      player.sendMessage("You must have completed Children of the Sun to start this quest.");
    }
    const skills = player.getSkillManager();
    if (skills.getMaxLevel(Skill.CONSTRUCTION) < 38) {
      player.sendMessage("You need a Construction level of at least 38 to start this quest.");
    }
    if (skills.getMaxLevel(Skill.COOKING) < 36) {
      player.sendMessage("You need a Cooking level of at least 36 to start this quest.");
    }
    if (skills.getMaxLevel(Skill.SMITHING) < 35) {
      player.sendMessage("You need a Smithing level of at least 35 to start this quest.");
    }
  }

  // ==========================================================================
  // Owner-only NPC spawns
  // ==========================================================================

  function tracked(player) {
    let map = trackedNpcs.get(player);
    if (!map) {
      map = new Map();
      trackedNpcs.set(player, map);
    }
    return map;
  }

  function spawnTracked(player, key, definition) {
    const map = tracked(player);
    if (map.has(key)) return map.get(key);
    const npc = api.spawnNpc({ ...definition, owner: player, ownerOnly: true });
    if (npc) map.set(key, npc);
    return npc;
  }

  function removeTracked(player, key) {
    const map = trackedNpcs.get(player);
    const npc = map?.get(key);
    if (npc) {
      api.removeNpc(npc);
      map.delete(key);
    }
  }

  function removeAllTracked(player) {
    const map = trackedNpcs.get(player);
    if (map) {
      for (const npc of map.values()) api.removeNpc(npc);
      trackedNpcs.delete(player);
    }
  }

  function ensureMan(player, key, npcId) {
    if (hasBit(player, manDepartedBit(key))) {
      removeTracked(player, `${key}-town`);
      const temple = TEMPLE_TILES[key];
      spawnTracked(player, `${key}-temple`, { id: npcId, x: temple.x, y: temple.y, z: 0, wanderRadius: 0 });
    } else {
      removeTracked(player, `${key}-temple`);
      const town = TOWN_TILES[key];
      spawnTracked(player, `${key}-town`, { id: npcId, x: town.x, y: town.y, z: 0, wanderRadius: 0 });
    }
  }

  function manDepartedBit(key) {
    if (key === "acatzin") return BIT_ACATZIN_DEPARTED;
    if (key === "nezketi") return BIT_NEZKETI_DEPARTED;
    return BIT_KAUAYOTL_DEPARTED;
  }

  function ensureQuestNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = quest.getStage(player);
    if (quest.isComplete(player)) {
      removeTracked(player, "alan");
      removeTracked(player, "egg");
      removeTracked(player, "chicken-egg");
      removeTracked(player, "jaguar-egg");
      removeTracked(player, "dragon-egg");
      for (const key of ["acatzin", "nezketi", "kauayotl"]) {
        removeTracked(player, `${key}-temple`);
        ensureManAtTown(player, key);
      }
      spawnTracked(player, "pet-egg", { id: PET_EGG_NPC_ID, ...EGG_NPC_TILE, z: 0, wanderRadius: 0 });
      return;
    }
    if (stage === STAGE_NOT_STARTED) {
      spawnTracked(player, "alan", { id: ALAN_NPC_ID, ...ALAN_TILE, z: 0, wanderRadius: 0 });
    } else {
      removeTracked(player, "alan");
    }
    if (stage >= STAGE_STARTED) {
      spawnTracked(player, "egg", { id: EGG_INSPECT_NPC_ID, ...EGG_NPC_TILE, z: 0, wanderRadius: 0 });
    }
    if (stage >= STAGE_MEN) {
      ensureMan(player, "acatzin", ACATZIN_NPC_ID);
      ensureMan(player, "nezketi", NEZKETI_NPC_ID);
      ensureMan(player, "kauayotl", KAUAYOTL_NPC_ID);
    }
    if (hasBit(player, BIT_CHICKEN_GIVEN)) {
      spawnTracked(player, "chicken-egg", { id: CHICKEN_EGG_NPC_ID, ...CHICKEN_EGG_TILE, z: 0, wanderRadius: 0 });
    }
    if (hasBit(player, BIT_JAGUAR_GIVEN)) {
      spawnTracked(player, "jaguar-egg", { id: JAGUAR_EGG_NPC_ID, ...JAGUAR_EGG_TILE, z: 0, wanderRadius: 0 });
    }
    if (hasBit(player, BIT_DRAGON_GIVEN)) {
      spawnTracked(player, "dragon-egg", { id: DRAGON_EGG_NPC_ID, ...DRAGON_EGG_TILE, z: 0, wanderRadius: 0 });
    }
  }

  function ensureManAtTown(player, key) {
    const npcId = key === "acatzin" ? ACATZIN_NPC_ID : key === "nezketi" ? NEZKETI_NPC_ID : KAUAYOTL_NPC_ID;
    const town = TOWN_TILES[key];
    spawnTracked(player, `${key}-town`, { id: npcId, x: town.x, y: town.y, z: 0, wanderRadius: 0 });
  }

  function ensureGroundItems(player) {
    if (!player || quest.isComplete(player)) return;
    const stage = quest.getStage(player);
    if (stage >= STAGE_MEN && stage <= STAGE_PLAN && !hasAnyBowl(player)) {
      if (!groundItems.getGroundItem(player.getUsername(), BOWL_ITEM_ID, BOWL_TILE)) {
        groundItems.registerLocation(player, new Item(BOWL_ITEM_ID, 1), BOWL_TILE);
      }
    }
    if (stage >= STAGE_PLAN && hasBit(player, BIT_PLAN_TOLD)) {
      for (const pile of PILES) {
        if (hasBit(player, pile.takenBit) || hasBit(player, pile.givenBit)) continue;
        const tile = new Location(pile.tile.x, pile.tile.y, 0);
        if (!groundItems.getGroundItem(player.getUsername(), pile.itemId, tile)) {
          groundItems.registerLocation(player, new Item(pile.itemId, 1), tile);
        }
      }
    }
  }

  // ==========================================================================
  // Transcript wiring
  // ==========================================================================

  /** Which transcript variant an NPC plays, by stage and per-man state. */
  function selectVariant({ npcId, player }) {
    if (npcId === ALAN_NPC_ID) {
      return quest.getStage(player) === STAGE_NOT_STARTED ? V_START : null;
    }
    if (npcId === JATZIRI_NPC_ID) {
      const stage = quest.getStage(player);
      return stage >= STAGE_STARTED && stage < STAGE_MEN ? V_JATZIRI : null;
    }
    if (npcId === KING_NPC_ID) return selectKingVariant(player);
    if (npcId === BLACKSMITH_NPC_ID) return selectBlacksmithVariant(player);
    if (npcId === ACATZIN_NPC_ID) return selectAcatzinVariant(player);
    if (npcId === NEZKETI_NPC_ID) return selectNezketiVariant(player);
    if (npcId === KAUAYOTL_NPC_ID) return selectKauayotlVariant(player);
    return null;
  }

  function selectKingVariant(player) {
    const stage = quest.getStage(player);
    if (quest.isComplete(player)) return V_KING_POST;
    if (stage >= STAGE_GATHERED) return V_KING_MEN;
    if (stage >= STAGE_MEN) return V_KING_AGAIN;
    if (stage >= STAGE_INSPECTED) {
      return hasBit(player, BIT_CITIZEN_MET) ? V_KING_CITIZEN : V_KING_DIRECT;
    }
    return null;
  }

  function selectBlacksmithVariant(player) {
    if (!hasBit(player, BIT_ACATZIN_ASKED) || quest.isComplete(player)) return null;
    if (hasBit(player, BIT_AXE_RECEIVED)) return null;
    if (hasBit(player, BIT_WHETSTONE_FIXED)) return V_BS_AFTER;
    if (hasBit(player, BIT_BLACKSMITH_TOLD)) return V_BS_AGAIN;
    return V_BS_INTRO;
  }

  function selectAcatzinVariant(player) {
    const stage = quest.getStage(player);
    if (quest.isComplete(player)) return V_ACATZIN_POST;
    if (hasBit(player, BIT_ACATZIN_DEPARTED)) return selectGatherVariant(player, "chicken", V_GIVE_CHICKEN, V_GIVE_CHICKEN_AGAIN, V_REMIND_ACATZIN);
    if (!hasBit(player, BIT_ACATZIN_ASKED)) {
      return hasBit(player, BIT_ACATZIN_REFUSED) ? V_ACATZIN_REFUSED : V_ACATZIN_INTRO;
    }
    if (held(player, DAMAGED_AXE_ITEM_ID) || held(player, FIXED_AXE_ITEM_ID)) return V_ACATZIN_AXE;
    if (stage >= STAGE_GATHERED) return null;
    return V_ACATZIN_AGAIN;
  }

  function selectNezketiVariant(player) {
    if (quest.isComplete(player)) return V_NEZKETI_POST;
    if (hasBit(player, BIT_NEZKETI_DEPARTED)) return selectGatherVariant(player, "jaguar", V_GIVE_JAGUAR, V_GIVE_JAGUAR_AGAIN, V_REMIND_NEZKETI);
    if (!hasBit(player, BIT_NEZKETI_ASKED)) {
      return hasBit(player, BIT_NEZKETI_REFUSED) ? V_NEZKETI_REFUSED : V_NEZKETI_INTRO;
    }
    if (hasAnyTea(player)) return V_NEZKETI_TEA;
    return V_NEZKETI_AGAIN;
  }

  function selectKauayotlVariant(player) {
    if (quest.isComplete(player)) return V_KAUAYOTL_POST;
    if (hasBit(player, BIT_KAUAYOTL_DEPARTED)) return selectGatherVariant(player, "dragon", V_GIVE_DRAGON, V_GIVE_DRAGON_AGAIN, V_REMIND_KAUAYOTL);
    if (!hasBit(player, BIT_KAUAYOTL_ASKED)) {
      return hasBit(player, BIT_KAUAYOTL_REFUSED) ? V_KAUAYOTL_REFUSED : V_KAUAYOTL_INTRO;
    }
    return hasBit(player, BIT_KAUAYOTL_FIXED) ? V_KAUAYOTL_AFTER : V_KAUAYOTL_AGAIN;
  }

  /** The temple conversation: plan, hand-ins, judging and the egg fix. */
  function selectGatherVariant(player, key, give, giveAgain, remind) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_JUDGED) return V_FIX;
    if (stage >= STAGE_GIVEN) return V_JUDGE;
    if (stage < STAGE_PLAN) return V_TEMPLE_PLAN;
    const given = key === "chicken"
      ? BIT_CHICKEN_GIVEN
      : key === "jaguar" ? BIT_JAGUAR_GIVEN : BIT_DRAGON_GIVEN;
    if (hasBit(player, given)) return giveAgain;
    const eggId = key === "chicken"
      ? LARGE_EGG_ITEM_ID
      : key === "jaguar" ? JAGUAR_EGG_ITEM_ID : DRAGON_EGG_ITEM_ID;
    return held(player, eggId) ? give : remind;
  }

  /** Answers the wiki prose conditions with live state. */
  function answerCondition({ player, stepId }) {
    if (!stepId) return null;
    if (PROFANITY_ON_IDS.has(stepId)) return false;
    if (PROFANITY_OFF_IDS.has(stepId)) return true;
    if (stepId === EGG_INTERACT_CONDITION_ID) return true;
    if (stepId === NO_SMITHING_CONDITION_ID) return player.getSkillManager().getMaxLevel(Skill.SMITHING) < 35;
    if (stepId === SMITHING_CONDITION_ID) return player.getSkillManager().getMaxLevel(Skill.SMITHING) >= 35;
    if (stepId === NO_HAMMER_CONDITION_ID) return !held(player, HAMMER_ITEM_ID);
    if (stepId === HAMMER_CONDITION_ID) return held(player, HAMMER_ITEM_ID);
    if (stepId === NO_SPACE_AXE_CONDITION_ID) return full(player);
    if (stepId === SPACE_AXE_CONDITION_ID) return !full(player);
    if (stepId === HAS_BROKEN_AXE_CONDITION_ID) return held(player, DAMAGED_AXE_ITEM_ID);
    if (stepId === HAS_FIXED_AXE_CONDITION_ID) return held(player, FIXED_AXE_ITEM_ID);
    if (stepId === NO_SPACE_CUP_CONDITION_ID) return full(player);
    if (stepId === HAS_CUP_CONDITION_ID) return held(player, EMPTY_CUP_ITEM_ID);
    if (stepId === NO_CUP_CONDITION_ID) return !held(player, EMPTY_CUP_ITEM_ID);
    if (stepId === NO_SPACE_REGIVE_CONDITION_ID) return full(player);
    if (stepId === LEAVES_ON_CUP_CONDITION_ID) return teaAction.get(player) === "leaves-on-cup";
    if (stepId === LEAVES_ON_BOWL_CONDITION_ID) return teaAction.get(player) === "leaves-on-bowl";
    if (stepId === LEAVES_ON_WATER_CONDITION_ID) return teaAction.get(player) === "leaves-on-water";
    if (stepId === LEAVES_ON_HOT_CONDITION_ID) return teaAction.get(player) === "leaves-on-hot";
    if (stepId === BOIL_CONDITION_ID) return teaAction.get(player) === "boil";
    if (stepId === TEA_BOWL_CONDITION_ID) return held(player, DAMIANA_TEA_BOWL_ITEM_ID);
    if (stepId === TEA_OTHER_CONDITION_ID) return held(player, CUP_OF_TEA_ITEM_ID);
    if (stepId === TEA_CUP_CONDITION_ID) return held(player, DAMIANA_TEA_CUP_ITEM_ID);
    if (stepId === NO_CONSTRUCTION_CONDITION_ID) return player.getSkillManager().getMaxLevel(Skill.CONSTRUCTION) < 38;
    if (stepId === CONSTRUCTION_CONDITION_ID) return player.getSkillManager().getMaxLevel(Skill.CONSTRUCTION) >= 38;
    if (stepId === NO_CART_ITEMS_CONDITION_ID) return !hasAllCartItems(player);
    if (stepId === CART_ITEMS_CONDITION_ID) return hasAllCartItems(player);
    if (PILE_CONDITION_IDS.has(stepId)) return answerPileCondition(player, stepId);
    return null;
  }

  function answerPileCondition(player, stepId) {
    const pile = pileForStep(stepId);
    if (!pile) return null;
    const dead = hasBit(player, pile.deadBit);
    const space = !full(player);
    if (stepId === pile.attemptId) return !dead;
    if (stepId === pile.takeId) return dead && space;
    if (stepId === pile.noSpaceId) return dead && !space;
    return null;
  }

  function pileForStep(stepId) {
    return PILES.find((pile) => pile.attemptId === stepId || pile.takeId === stepId || pile.noSpaceId === stepId) ?? null;
  }

  function handleStartHook({ player, npcId, hook }) {
    if (hook !== START_HOOK || npcId !== ALAN_NPC_ID) return;
    if (quest.getStage(player) !== STAGE_NOT_STARTED) return;
    if (!meetsRequirements(player)) {
      notifyRequirements(player);
      return;
    }
    quest.setStage(player, STAGE_STARTED);
    removeTracked(player, "alan");
    spawnTracked(player, "egg", { id: EGG_INSPECT_NPC_ID, ...EGG_NPC_TILE, z: 0, wanderRadius: 0 });
  }

  /** Stage moves carried by exact transcript lines (prose has no ids for them). */
  function handleDialogueLine(event) {
    const { player, npcId, text } = event;
    if (npcId === KING_NPC_ID && quest.getStage(player) === STAGE_INSPECTED && String(text).includes("Nezketi should be in the temple just south of here")) {
      quest.setStage(player, STAGE_MEN);
      ensureQuestNpcs(player);
      return;
    }
    if (npcId === BLACKSMITH_NPC_ID && String(text).includes("try and fix the whetstone")) {
      setBit(player, BIT_BLACKSMITH_TOLD);
      return;
    }
    if (
      (npcId === ACATZIN_NPC_ID || npcId === NEZKETI_NPC_ID || npcId === KAUAYOTL_NPC_ID) &&
      String(text).includes("I'll be back once I have some eggs")
    ) {
      setBit(player, BIT_PLAN_TOLD);
      if (quest.getStage(player) === STAGE_GATHERED) quest.setStage(player, STAGE_PLAN);
      ensureGroundItems(player);
    }
  }

  /** Quest-gated menu options that carry no action step. */
  function handleChoice({ player, npcId, option }) {
    if (npcId === ACATZIN_NPC_ID) {
      if (option === "I can talk to the blacksmith.") {
        clearBit(player, BIT_ACATZIN_REFUSED);
        setBit(player, BIT_ACATZIN_ASKED);
      } else if (option === "There's no time for this!") {
        setBit(player, BIT_ACATZIN_REFUSED);
      }
      return;
    }
    if (npcId === NEZKETI_NPC_ID) {
      if (option === "I can get you some tea.") {
        clearBit(player, BIT_NEZKETI_REFUSED);
      } else if (option === "Now's not the time for tea!") {
        setBit(player, BIT_NEZKETI_REFUSED);
      }
      return;
    }
    if (npcId === KAUAYOTL_NPC_ID) {
      if (option === "I see. Well, maybe I can help out with that?") {
        clearBit(player, BIT_KAUAYOTL_REFUSED);
        setBit(player, BIT_KAUAYOTL_ASKED);
      } else if (option === "We have bigger problems right now!") {
        setBit(player, BIT_KAUAYOTL_REFUSED);
      }
    }
  }

  /** Chosen condition branches with gameplay meaning. */
  function handleCondition({ player, stepId }) {
    if (stepId === EGG_INTERACT_CONDITION_ID && quest.getStage(player) === STAGE_STARTED) {
      quest.setStage(player, STAGE_INSPECTED);
    }
  }

  /** The transcript's item hand-outs, scene messages and completion. */
  function handleAction(event) {
    const { player, stepId } = event;
    if (!stepId) return;
    if (stepId === WHETSTONE_FIXED_STEP) {
      setBit(player, BIT_WHETSTONE_FIXED);
      return;
    }
    if (stepId === AXE_RECEIVE_STEP) {
      event.handled = true;
      if (!held(player, DAMAGED_AXE_ITEM_ID)) player.getInventory().adds(DAMAGED_AXE_ITEM_ID, 1);
      setBit(player, BIT_AXE_RECEIVED);
      return;
    }
    if (stepId === AXE_HANDED_STEP) {
      player.getInventory().deleteNumber(FIXED_AXE_ITEM_ID, 1);
      setBit(player, BIT_ACATZIN_DEPARTED);
      advanceIfAllMenDeparted(player);
      ensureQuestNpcs(player);
      return;
    }
    if (stepId === CUP_GIVEN_1_STEP || stepId === CUP_GIVEN_2_STEP) {
      setBit(player, BIT_NEZKETI_ASKED);
      if (!full(player) && !held(player, EMPTY_CUP_ITEM_ID)) player.getInventory().adds(EMPTY_CUP_ITEM_ID, 1);
      return;
    }
    if (stepId === TEA_LEAVES_ADDED_STEP) {
      player.getInventory().deleteNumber(DAMIANA_LEAVES_ITEM_ID, 1);
      player.getInventory().deleteNumber(BOWL_OF_WATER_ITEM_ID, 1);
      player.getInventory().adds(DAMIANA_WATER_ITEM_ID, 1);
      return;
    }
    if (stepId === TEA_BREWED_STEP) {
      player.getInventory().deleteNumber(DAMIANA_WATER_ITEM_ID, 1);
      player.getInventory().adds(DAMIANA_TEA_BOWL_ITEM_ID, 1);
      return;
    }
    if (stepId === TEA_XP_STEP) {
      player.getSkillManager().addExperiences(Skill.COOKING, 68);
      return;
    }
    if (stepId === TEA_HANDED_STEP) {
      player.getInventory().deleteNumber(DAMIANA_TEA_CUP_ITEM_ID, 1);
      setBit(player, BIT_NEZKETI_DEPARTED);
      advanceIfAllMenDeparted(player);
      ensureQuestNpcs(player);
      return;
    }
    if (stepId === CART_FIXED_STEP) {
      player.getInventory().deleteNumber(PLANK_ITEM_ID, 2);
      player.getInventory().deleteNumber(IRON_NAILS_ITEM_ID, 6);
      setBit(player, BIT_KAUAYOTL_FIXED);
      return;
    }
    if (stepId === KAUAYOTL_DEPARTED_STEP) {
      setBit(player, BIT_KAUAYOTL_DEPARTED);
      advanceIfAllMenDeparted(player);
      ensureQuestNpcs(player);
      return;
    }
    if (stepId === EGG_BROKEN_STEP) {
      if (quest.getStage(player) === STAGE_STARTED) quest.setStage(player, STAGE_INSPECTED);
      return;
    }
    if (stepId === CHICKEN_SETUP_STEP) {
      finishEggHandIn(player, "chicken");
      return;
    }
    if (stepId === JAGUAR_SETUP_STEP) {
      finishEggHandIn(player, "jaguar");
      return;
    }
    if (stepId === DRAGON_SETUP_STEP) {
      finishEggHandIn(player, "dragon");
      return;
    }
    if (stepId === ALL_EGGS_FALL_STEP) {
      removeTracked(player, "chicken-egg");
      removeTracked(player, "jaguar-egg");
      removeTracked(player, "dragon-egg");
      if (quest.getStage(player) === STAGE_GIVEN) quest.setStage(player, STAGE_JUDGED);
      return;
    }
    if (stepId === FIX_ATTEMPT_STEP) return;
    if (stepId === MEN_LEAVE_STEP) {
      removeTracked(player, "acatzin-temple");
      removeTracked(player, "nezketi-temple");
      removeTracked(player, "kauayotl-temple");
      return;
    }
    if (stepId === ALAN_DIES_STEP) {
      if (!quest.isComplete(player)) {
        removeTracked(player, "egg");
        if (!groundItems.getGroundItem(player.getUsername(), ALANS_BONES_ITEM_ID, BONES_TILE)) {
          groundItems.registerLocation(player, new Item(ALANS_BONES_ITEM_ID, 1), BONES_TILE);
        }
        quest.complete(player);
        spawnTracked(player, "pet-egg", { id: PET_EGG_NPC_ID, ...EGG_NPC_TILE, z: 0, wanderRadius: 0 });
      }
    }
  }

  function allMenDeparted(player) {
    return (
      hasBit(player, BIT_ACATZIN_DEPARTED) &&
      hasBit(player, BIT_NEZKETI_DEPARTED) &&
      hasBit(player, BIT_KAUAYOTL_DEPARTED)
    );
  }

  function advanceIfAllMenDeparted(player) {
    if (allMenDeparted(player) && quest.getStage(player) === STAGE_MEN) {
      quest.setStage(player, STAGE_GATHERED);
    }
  }

  function finishEggHandIn(player, key) {
    const eggId = key === "chicken"
      ? LARGE_EGG_ITEM_ID
      : key === "jaguar" ? JAGUAR_EGG_ITEM_ID : DRAGON_EGG_ITEM_ID;
    const givenBit = key === "chicken"
      ? BIT_CHICKEN_GIVEN
      : key === "jaguar" ? BIT_JAGUAR_GIVEN : BIT_DRAGON_GIVEN;
    player.getInventory().deleteNumber(eggId, 1);
    setBit(player, givenBit);
    ensureQuestNpcs(player);
    if (
      hasBit(player, BIT_CHICKEN_GIVEN) &&
      hasBit(player, BIT_JAGUAR_GIVEN) &&
      hasBit(player, BIT_DRAGON_GIVEN) &&
      quest.getStage(player) === STAGE_PLAN
    ) {
      quest.setStage(player, STAGE_GIVEN);
    }
  }

  /** Farmer/Citizen point the player at King after the egg breaks. */
  function handleCitizenTalk(event) {
    const { player, npcId } = event;
    if (!CITIZEN_NPC_IDS.has(npcId)) return false;
    if (quest.getStage(player) !== STAGE_INSPECTED || hasBit(player, BIT_CITIZEN_MET)) return false;
    event.handled = true;
    setBit(player, BIT_CITIZEN_MET);
    startTranscript(api, player, npcId, PAGE, V_CITIZEN);
    return true;
  }

  /** The broken egg is the quest's Inspect NPC (14488). */
  function inspectEgg(event) {
    const { player, npcId } = event;
    if (npcId !== EGG_INSPECT_NPC_ID) return false;
    if (quest.getStage(player) < STAGE_STARTED || quest.isComplete(player)) return false;
    event.handled = true;
    startTranscript(api, player, EGG_INSPECT_NPC_ID, PAGE, V_EGG_INSPECT);
    return true;
  }

  /** The egg on the wall hands out the pet egg after the quest. */
  function petEggTalk(event) {
    const { player, npcId } = event;
    if (npcId !== PET_EGG_NPC_ID || !quest.isComplete(player)) return false;
    event.handled = true;
    if (!hasBit(player, BIT_PET_EGG_RECEIVED)) {
      setBit(player, BIT_PET_EGG_RECEIVED);
      player.getInventory().adds(PET_EGG_ITEM_ID, 1);
      player.sendMessage("The egg wibbles fondly. You gain an egg.");
    }
    return true;
  }

  /** Whetstone and axe repair through the Blacksmith; the cart through Kauayotl. */
  function handleItemOnNpc(event) {
    const { player, npcId, itemId } = event;
    if (npcId === BLACKSMITH_NPC_ID) {
      if (itemId === HAMMER_ITEM_ID && hasBit(player, BIT_BLACKSMITH_TOLD) && !hasBit(player, BIT_WHETSTONE_FIXED)) {
        event.handled = true;
        startTranscript(api, player, BLACKSMITH_NPC_ID, PAGE, V_BS_REPAIR);
        return;
      }
      if (itemId === DAMAGED_AXE_ITEM_ID && hasBit(player, BIT_WHETSTONE_FIXED)) {
        event.handled = true;
        player.getInventory().deleteNumber(DAMAGED_AXE_ITEM_ID, 1);
        player.getInventory().adds(FIXED_AXE_ITEM_ID, 1);
        player.sendMessage("You repair Acatzin's axe using the whetstone.");
        return;
      }
      return;
    }
    if (npcId === KAUAYOTL_NPC_ID && CART_TOOL_ITEM_IDS.has(itemId) && hasBit(player, BIT_KAUAYOTL_ASKED) && !hasBit(player, BIT_KAUAYOTL_FIXED)) {
      event.handled = true;
      startTranscript(api, player, KAUAYOTL_NPC_ID, PAGE, V_KAUAYOTL_REPAIR);
    }
  }

  /** Damiana tea making, leaf by leaf, from the transcript's own messages. */
  function handleItemOnItem(event) {
    const { player, usedItemId, usedWithItemId } = event;
    const ids = new Set([usedItemId, usedWithItemId]);
    if (ids.has(DAMIANA_LEAVES_ITEM_ID)) {
      const other = usedItemId === DAMIANA_LEAVES_ITEM_ID ? usedWithItemId : usedItemId;
      let action;
      if (other === EMPTY_CUP_ITEM_ID) action = "leaves-on-cup";
      else if (other === BOWL_ITEM_ID) action = "leaves-on-bowl";
      else if (other === BOWL_OF_WATER_ITEM_ID) action = "leaves-on-water";
      else if (other === BOWL_OF_HOT_WATER_ITEM_ID) action = "leaves-on-hot";
      if (!action) return;
      event.handled = true;
      teaAction.set(player, action);
      startTranscript(api, player, NEZKETI_NPC_ID, PAGE, V_NEZKETI_MAKING_TEA);
      teaAction.delete(player);
      return;
    }
    if (ids.has(DAMIANA_TEA_BOWL_ITEM_ID) && ids.has(EMPTY_CUP_ITEM_ID)) {
      event.handled = true;
      player.getInventory().deleteNumber(DAMIANA_TEA_BOWL_ITEM_ID, 1);
      player.getInventory().deleteNumber(EMPTY_CUP_ITEM_ID, 1);
      player.getInventory().adds(DAMIANA_TEA_CUP_ITEM_ID, 1);
      player.getInventory().adds(BOWL_ITEM_ID, 1);
      player.sendMessage("You pour the damiana tea into the cup.");
    }
  }

  /** Boiling the damiana water on a cooking oven. */
  function handleDamianaWaterOnOven(event) {
    const { player } = event;
    if (!held(player, DAMIANA_WATER_ITEM_ID)) return false;
    event.handled = true;
    teaAction.set(player, "boil");
    startTranscript(api, player, NEZKETI_NPC_ID, PAGE, V_NEZKETI_MAKING_TEA);
    teaAction.delete(player);
    return true;
  }

  /** Filling an empty bowl at a fountain. */
  function handleBowlOnFountain(event) {
    const { player, itemId } = event;
    if (itemId !== BOWL_ITEM_ID) return false;
    event.handled = true;
    player.getInventory().deleteNumber(BOWL_ITEM_ID, 1);
    player.getInventory().adds(BOWL_OF_WATER_ITEM_ID, 1);
    player.sendMessage("You fill the bowl with water.");
    return true;
  }

  /** Damiana leaves from the shrubs outside Tal Teklan. */
  function pickDamiana(event) {
    const { player, objectId } = event;
    if (objectId !== DAMIANA_OBJECT_ID) return;
    event.handled = true;
    if (full(player)) {
      player.sendMessage("You don't have enough inventory space.");
      return;
    }
    player.getInventory().adds(DAMIANA_LEAVES_ITEM_ID, 1);
    player.sendMessage("You pick some damiana leaves.");
  }

  /** Twenty iron nails from the blacksmith's workbench. */
  function searchWorkbench(event) {
    const { player, objectId } = event;
    if (objectId !== WORKBENCH_OBJECT_ID) return;
    event.handled = true;
    if (hasBit(player, BIT_WORKBENCH_SEARCHED)) {
      player.sendMessage("You have already taken the nails from the workbench.");
      return;
    }
    if (player.getInventory().getFreeSlots() < 1) {
      player.sendMessage("You don't have enough inventory space.");
      return;
    }
    setBit(player, BIT_WORKBENCH_SEARCHED);
    player.getInventory().adds(IRON_NAILS_ITEM_ID, 20);
    player.sendMessage("You take some iron nails from the workbench.");
  }

  /** Egg piles: the guardian interrupts the first take; the second one succeeds. */
  function handleGroundItemPickup(event) {
    const { player, groundItemId, location } = event;
    const pile = PILE_BY_ITEM.get(groundItemId);
    if (!pile || !location) return;
    if (location.x !== pile.tile.x || location.y !== pile.tile.y) return;
    if (quest.isComplete(player) || quest.getStage(player) < STAGE_PLAN) return;
    if (!hasBit(player, BIT_PLAN_TOLD)) return;
    if (hasBit(player, pile.takenBit) || hasBit(player, pile.givenBit)) return;
    if (hasBit(player, pile.deadBit)) {
      if (full(player)) event.handled = true;
      else setBit(player, pile.takenBit);
      startTranscript(api, player, pile.guardianId, PAGE, pile.variant);
      return;
    }
    event.handled = true;
    spawnTracked(player, `guardian-${pile.key}`, {
      id: pile.guardianId,
      x: pile.guardianTile.x,
      y: pile.guardianTile.y,
      z: 0,
      wanderRadius: 0,
    });
    startTranscript(api, player, pile.guardianId, PAGE, pile.variant);
  }

  /** Killing a pile guardian opens its egg pile. */
  function handleNpcDeath(event) {
    const { npcId, killer, npc } = event;
    if (!GUARDIAN_NPC_IDS.has(npcId) || !killer?.setAttribute) return;
    const pile = PILES.find((entry) => entry.guardianId === npcId);
    if (!pile) return;
    setBit(killer, pile.deadBit);
    const map = trackedNpcs.get(killer);
    if (map) {
      for (const [key, trackedNpc] of map) {
        if (trackedNpc === npc) map.delete(key);
      }
    }
  }

  function handleLogin({ player }) {
    ensureQuestNpcs(player);
    ensureGroundItems(player);
    refreshQuestList(player);
  }

  function handleLogout({ player }) {
    if (player) removeAllTracked(player);
  }

  // ==========================================================================
  // Journal
  // ==========================================================================

  function manLine(player, bit, label) {
    return hasBit(player, bit)
      ? `<str>${label} has gone to the temple.</str>`
      : `${label} still needs my help.`;
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Alan left me to look after his egg while he gathered food,</str>",
        "<str>but it fell from the wall and smashed. I rallied King's men,</str>",
        "<str>gathered replacement eggs and put Alan's egg back together.</str>",
        "<str>Alan finally found himself, then had a great fall of his own.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_JUDGED) {
      return [
        "<str>I rallied King's men and gathered eggs from a large chicken,</str>",
        "<str>a red dragon and a jaguar, but every replacement broke too.</str>",
        "",
        "I must help put <col=800000>Humphrey Dumphrey</col> back together again.",
      ];
    }
    if (stage >= STAGE_GIVEN) {
      return [
        "<str>I found a large chicken egg, a dragon egg and a jaguar egg</str>",
        "<str>and King's men have prepared all three to be judged.</str>",
        "",
        "I should speak to one of <col=800000>King's men</col> at the temple.",
      ];
    }
    if (stage >= STAGE_PLAN) {
      return [
        "<str>There is no way to put the broken egg back together, so King's</str>",
        "<str>men want to find a replacement egg to judge.</str>",
        "",
        hasBit(player, BIT_CHICKEN_TAKEN) || hasBit(player, BIT_CHICKEN_GIVEN)
          ? "<str>A large chicken egg.</str>"
          : "A large chicken egg from the farm south of <col=800000>Tal Teok</col>.",
        hasBit(player, BIT_DRAGON_TAKEN) || hasBit(player, BIT_DRAGON_GIVEN)
          ? "<str>A dragon egg.</str>"
          : "A dragon egg from the <col=800000>Dragon Nest</col> to the east.",
        hasBit(player, BIT_JAGUAR_TAKEN) || hasBit(player, BIT_JAGUAR_GIVEN)
          ? "<str>A jaguar egg.</str>"
          : "A jaguar egg from the campsite by the mine east of town.",
      ];
    }
    if (stage >= STAGE_GATHERED) {
      return [
        "<str>King's men have all agreed to help.</str>",
        "",
        "I should meet them at the temple of <col=800000>Tal Teok</col>.",
      ];
    }
    if (stage >= STAGE_MEN) {
      return [
        "King asked me to rally her men to help the broken egg:",
        "",
        manLine(player, BIT_ACATZIN_DEPARTED, "Acatzin (in the inn)"),
        manLine(player, BIT_NEZKETI_DEPARTED, "Nezketi (in the temple south of the inn)"),
        manLine(player, BIT_KAUAYOTL_DEPARTED, "Kauayotl (at the eastern entrance)"),
      ];
    }
    if (stage >= STAGE_INSPECTED) {
      return [
        "<str>Alan left me to look after his egg while he gathered food,</str>",
        "<str>but it fell from the wall and smashed.</str>",
        "",
        "I should look for help in <col=800000>Tal Teklan</col>.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "<str>Alan left me to look after his egg while he gathered food,</str>",
        "<str>but it fell from the wall and smashed.</str>",
        "",
        "I should inspect the <col=800000>broken egg</col>.",
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Alan</col> at the",
      "temple of <col=800000>Tal Teok</col>, north of Tal Teklan.",
    ];
  }

  api.persistAttribute(BITS_ATTRIBUTE);

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.CONSTRUCTION, 5000);
    player.getSkillManager().addExperiences(Skill.COOKING, 5000);
    player.getSkillManager().addExperiences(Skill.SMITHING, 5000);
  }

  quest = registerQuest(api, {
    key: "scrambled",
    name: "Scrambled!",
    varpId: VARP_SCRAMBLED,
    varbitId: VARBIT_SCRAMBLED_STAGE,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: Skill.CONSTRUCTION.getIndex(), amount: 5000, label: "Construction" },
      { skillId: Skill.COOKING.getIndex(), amount: 5000, label: "Cooking" },
      { skillId: Skill.SMITHING.getIndex(), amount: 5000, label: "Smithing" },
    ],
    scrollItemId: PET_EGG_ITEM_ID,
    rewardItemLabel: "An egg (talk to the egg on the wall)",
    otherRewards: ["Alan's bones can be picked up south of the temple"],
    buildJournal,
    onReward: grantReward,
  });

  groundItems = api.getItemOnGroundManager();

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:condition", handleCondition);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onNpcInteraction("Citizen", { "Talk-to": handleCitizenTalk });
  api.onNpcInteraction("Farmer", { "Talk-to": handleCitizenTalk });
  api.onNpcInteraction("Humphrey Dumphrey", { Inspect: inspectEgg, "Talk-to": petEggTalk });
  api.onItemOnNpc(handleItemOnNpc);
  api.onItemOnItem(handleItemOnItem);
  api.onItemOnObject("Damiana water", "Oven", handleDamianaWaterOnOven);
  api.onItemOnObject("Bowl", "Fountain", handleBowlOnFountain);
  api.onObjectInteraction("Damiana", { Pick: pickDamiana });
  api.onObjectInteraction("Workbench", { Search: searchWorkbench });
  api.onGroundItemPickup(handleGroundItemPickup);
  api.onNpcDeath(handleNpcDeath);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
