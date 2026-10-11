/**
 * The Final Dawn (members).
 *
 * The words come from the "The Final Dawn" transcript page (OSRS Wiki); this
 * plugin supplies the variant selector for the quest's NPCs, the prose-condition
 * answers, the temple infiltration (robe check, sermon, passphrase, bed/drawer
 * key + canvas, painting passage, chest + Enforcer fight), the Janus safe-house
 * trap (dog, sack, blackjack), the Teumo basement drink puzzle, the Neypotzli
 * keystone hunt and twins fight, the Crypt of Tonali assault (cultists + Ennius),
 * the sun/moon chambers and the Mokhaiotl archive that completes the quest.
 *
 * Stage varbit: 16663 "vmq4" (varp 4737 "vmq4_primary", bits 0-6). Evidence:
 * scripts/lookup-gameval.ts varbit vmq4 -> varp=4737 bits=0-6; sibling varbits
 * (16664 temple_secret_room_found, 16666 canvas_drawer, 16667
 * temple_draw_unlocked, 16672 janus_sack_given, 16675 sun_puzzle_progress,
 * 16677 moon_puzzle_progress, 16694 lift_activated, 16695-16697 final-chamber
 * inspects) all live in varp 4737/4738, so quest progress is varbit 16663.
 * The stub varp 7945 was a placeholder and is not used.
 *
 * Stages (varbit 16663): 1 agreed to help Servius, 2 met Queen Zyanyi (tasked),
 * 3 watched the temple sermon, 4 passphrase given, 5 Metzli/Furia cutscene seen,
 * 6 bed key found, 7 canvas found, 8 chest picklocked (scroll), 9 Emissary
 * Enforcer defeated, 10 reported to the Queen, 11 safe house secured, 12 trap
 * ready (sack given, blackjack made), 13 Janus captured, 14 Cam Torum trip
 * agreed, 15 Cam Torum market met Attala, 16 Teumo's house entered, 17 basement
 * open (beer given to Galna), 18 basement puzzle solved (lever pulled), 19
 * eavesdropped/reported (go to Neypotzli), 20 Eyatlalli's fragment received,
 * 21 confronting the twins, 22 twins escaped (Lucius and Chimalli defeated),
 * 23 Crypt of Tonali under attack, 24 cultist wave cleared, 25 Ennius defeated,
 * 26 sun chamber finished, 27 moon chamber finished, 28 Metzli defeated,
 * 29 archive reached (Furia kills Metzli), 30 ruins fully explored, 31 complete.
 *
 * Rewards per the OSRS Wiki: 3 Quest points, Arkan blade, 55,000 Thieving,
 * 25,000 Runecraft, 25,000 Fletching XP, an antique lamp (55,000 XP in any
 * combat skill), access to the Crypt of Tonali and the Doom of Mokhaiotl boss.
 *
 * Gaps / approximations:
 *  - Cutscenes are dialogue only: no camera, no instancing, and multi-speaker
 *    lines share the chathead of the NPC the transcript is played on. Where the
 *    cache maps only a non-interactive variant of a quest loc (the bed's Search
 *    variant 56535, the open drawers 56532/56533, the painting 56526, the ralos
 *    memorial 56601, the sun altar 56688, the moon roots/tools 56694/56698,
 *    Teumo's shelf 56489 and the five basement barrels 56490-56494), the plugin
 *    registers the interactive object itself (ARuffSituation precedent), the
 *    barrels at free tiles next to the shelf.
 *  - The chest lockpick minigame is a single successful Open; the sun puzzle is
 *    urn -> Kuhu essence -> imbue the statue three times (no altar positioning
 *    for Itzla); the moon puzzle is old tools -> knife blade, roots -> ancient
 *    roots, blade on roots -> 4 kindling, then 3 kindling per offering (the
 *    braziers count is random per player live); the six cultist waves are one
 *    wave of two attackers; Enforcer/Metzli/Ennius special attacks are not
 *    simulated (ordinary spawned bosses).
 *  - The safe-house window force-open, the Enforcer patrol, the temple outer
 *    door and the Tonali cavern agility shortcuts are not simulated; the dog is
 *    calmed with any bones/raw or cooked meat, and quest transitions use direct
 *    moveTo.
 *  - Post-quest: Itzla's lost-blade repurchase checks the inventory (not the
 *    bank) for the Arkan blade and sells it back for 250,000 coins.
 *
 * Source: OSRS Wiki "The Final Dawn", its quick guide, transcript and journal;
 * every id via scripts/lookup-gameval.ts and the cache definitions.
 */
module.exports = function registerTheFinalDawnQuest(api) {
  const {
    CountdownTask,
    Equipment,
    GameObject,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectManager,
    Skill,
    TaskManager,
  } = api.core;
  const { registerQuest, startTranscript, refreshQuestList } = require("../QuestRuntime");

  const PAGE = "The Final Dawn";

  // Varp 4737 "vmq4_primary"; the stage is varbit 16663 "vmq4" (bits 0-6).
  const VARP_FINAL_DAWN = 4737;
  const STAGE_VARBIT = 16663;

  const STAGE_STARTED = 1;
  const STAGE_TASKED = 2;
  const STAGE_SERMON = 3;
  const STAGE_BASEMENT = 4;
  const STAGE_BACKROOM = 5;
  const STAGE_KEY = 6;
  const STAGE_CANVAS = 7;
  const STAGE_SCROLL = 8;
  const STAGE_ENFORCER = 9;
  const STAGE_REPORTED = 10;
  const STAGE_SAFEHOUSE = 11;
  const STAGE_TRAP = 12;
  const STAGE_JANUS = 13;
  const STAGE_CAM_TORUM = 14;
  const STAGE_MARKET = 15;
  const STAGE_TEUMO = 16;
  const STAGE_TEUMO_BASEMENT = 17;
  const STAGE_PUZZLE = 18;
  const STAGE_REPORT2 = 19;
  const STAGE_NEYPOTZLI = 20;
  const STAGE_TWINS_FIGHT = 21;
  const STAGE_TWINS = 22;
  const STAGE_CRYPT = 23;
  const STAGE_WAVES = 24;
  const STAGE_ENNIUS = 25;
  const STAGE_SUN = 26;
  const STAGE_MOON = 27;
  const STAGE_METZLI = 28;
  const STAGE_ARCHIVE = 29;
  const STAGE_EXPLORE = 30;
  const STAGE_COMPLETE = 31;

  const START_HOOK = "quest:the-final-dawn:start";

  const PHRASE_WORDS = new Set(["Suffering.", "Dark.", "Light.", "Final.", "Rise.", "Dawn.", "Sacrifice.", "Eclipse."]);

  // ==========================================================================
  // Ids
  // ==========================================================================

  const SERVIUS_IDS = new Set([
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS, // 12652
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_2, // 12899
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_3, // 12900
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_4, // 12901
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_5, // 13694
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_6, // 14307
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_7, // 14374
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_8, // 14377
  ]);
  const SERVIUS_TALK_ID = NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_2; // 12899
  const SERVIUS_BASEMENT_ID = NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_5; // 13694
  const SERVIUS_CRYPT_ID = NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_8; // 14377
  const QUEEN_IDS = new Set([
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN, // 11012
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_2, // 13695
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_3, // 14287
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_4, // 14288
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_5, // 14289
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_6, // 14290
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_7, // 14291
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_8, // 14292
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_9, // 14294
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_10, // 14296
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_11, // 14297
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_12, // 14373
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_13, // 14389
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_14, // 14396
    NpcIdentifiers.QUEEN_ZYANYI_ARKAN_15, // 14469
  ]);
  const QUEEN_TALK_ID = NpcIdentifiers.QUEEN_ZYANYI_ARKAN_10; // 14296 (palace)
  const ITZLA_IDS = new Set([
    NpcIdentifiers.PRINCE_ITZLA_ARKAN, // 12650
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_2, // 12651
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_3, // 12896
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_4, // 12897
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_5, // 12898
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_6, // 13690
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_7, // 13691
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_8, // 13692
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_9, // 13693
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_17, // 14277
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_19, // 14279
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_20, // 14280
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_21, // 14281
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_22, // 14282
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_24, // 14286
  ]);
  const ITZLA_QUEST_ID = NpcIdentifiers.PRINCE_ITZLA_ARKAN_19; // 14279
  const ATTALA_IDS = new Set([
    NpcIdentifiers.ATTALA, // 12861
    NpcIdentifiers.ATTALA_2, // 13099
    NpcIdentifiers.ATTALA_3, // 14336
    NpcIdentifiers.ATTALA_4, // 14339
  ]);
  const ATTALA_TALK_ID = NpcIdentifiers.ATTALA; // 12861
  const GALNA_ID = NpcIdentifiers.GALNA; // 14342
  const VIBIA_OUTSIDE_ID = 14302; // vmq4_captain_vibia_outside_house
  const VIBIA_INSIDE_ID = 14303; // vmq4_captain_vibia_inside_house
  const VIBIA_IDS = new Set([
    NpcIdentifiers.CAPTAIN_VIBIA, // 14298
    NpcIdentifiers.CAPTAIN_VIBIA_2, // 14299
    NpcIdentifiers.CAPTAIN_VIBIA_3, // 14301
    VIBIA_OUTSIDE_ID,
    VIBIA_INSIDE_ID,
  ]);
  const VIBIA_TALK_ID = NpcIdentifiers.CAPTAIN_VIBIA_3; // 14301
  const EYATLALLI_IDS = new Set([
    NpcIdentifiers.EYATLALLI, // 12869
    NpcIdentifiers.EYATLALLI_2, // 12870
    NpcIdentifiers.EYATLALLI_3, // 14355
  ]);
  const EYATLALLI_TALK_ID = NpcIdentifiers.EYATLALLI; // 12869
  const KATLO_IDS = new Set([
    NpcIdentifiers.HIGHLORD_KATLO, // 14346
    NpcIdentifiers.HIGHLORD_KATLO_2, // 14347
    NpcIdentifiers.HIGHLORD_KATLO_3, // 14348
  ]);
  const KATLO_TALK_ID = NpcIdentifiers.HIGHLORD_KATLO; // 14346
  const JANUS_TALK_ID = NpcIdentifiers.FOREBEARER_JANUS; // 13714
  const JANUS_UNCONSCIOUS_ID = NpcIdentifiers.FOREBEARER_JANUS_5; // 14243 [Search]
  const FURIA_TALK_ID = NpcIdentifiers.FURIA_TULLUS_10; // 14330 prisoner
  const EMISSARY_TEMPLE_ID = NpcIdentifiers.EMISSARY_ASCENDED; // 13706
  const GUARD_DOG_ID = NpcIdentifiers.DOG_5; // 14238 [Pet]
  const ENFORCER_ID = NpcIdentifiers.EMISSARY_ENFORCER_3; // 14268
  const CHIMALLI_ID = NpcIdentifiers.CHIMALLI; // 14362
  const LUCIUS_ID = NpcIdentifiers.LUCIUS; // 14363
  const ENNIUS_BOSS_ID = NpcIdentifiers.ENNIUS_TULLUS_5; // 14331
  const METZLI_BOSS_ID = NpcIdentifiers.AUGUR_METZLI_2; // 14313
  const CULTIST_MELEE_ID = 14401; // vmq4_crypt_attacker_melee_variant_1a
  const CULTIST_RANGED_ID = 14407; // vmq4_crypt_attacker_ranged_variant_1

  const EMISSARY_SCROLL_ITEM = ItemIdentifiers.EMISSARY_SCROLL; // 30949
  const CANVAS_PIECE_ITEM = ItemIdentifiers.CANVAS_PIECE; // 30950
  const DRAWER_KEY_ITEM = ItemIdentifiers.KEY_37; // 30951
  const KUHU_ESSENCE_ITEM = ItemIdentifiers.KUHU_ESSENCE; // 30962
  const KNIFE_BLADE_ITEM = ItemIdentifiers.KNIFE_BLADE; // 30965
  const ANCIENT_ROOTS_ITEM = ItemIdentifiers.ANCIENT_ROOTS; // 30963
  const ROOT_KINDLING_ITEM = ItemIdentifiers.ROOT_KINDLING; // 30964
  const KEYSTONE_FRAGMENT_ITEM = ItemIdentifiers.KEYSTONE_FRAGMENT; // 30961
  const ARKAN_BLADE_ITEM = ItemIdentifiers.ARKAN_BLADE; // 30955
  const ANTIQUE_LAMP_ITEM = ItemIdentifiers.ANTIQUE_LAMP_37; // 30960
  const SANDY_COIN_PURSE_ITEM = ItemIdentifiers.SANDY_COIN_PURSE; // 30943
  const EMPTY_COIN_PURSE_ITEM = ItemIdentifiers.EMPTY_COIN_PURSE; // 30942
  const MAKESHIFT_BLACKJACK_ITEM = ItemIdentifiers.MAKESHIFT_BLACKJACK; // 30944
  const BRANCH_ITEM = ItemIdentifiers.BRANCH_4; // 30945
  const ALANS_BONES_ITEM = ItemIdentifiers.ALANS_BONES; // 30973
  const BONES_ITEM = ItemIdentifiers.BONES; // 526
  const COOKED_MEAT_ITEM = ItemIdentifiers.COOKED_MEAT; // 2142
  const RAW_MEAT_IDS = new Set([
    ItemIdentifiers.RAW_BEEF, // 2132
    ItemIdentifiers.RAW_CHICKEN, // 2138
  ]);
  const KNIFE_ITEM = ItemIdentifiers.KNIFE; // 946
  const EMPTY_SACK_ITEM = ItemIdentifiers.EMPTY_SACK; // 5418
  const BEER_ITEM = ItemIdentifiers.BEER; // 1917
  const DWARVEN_STOUT_ITEM = ItemIdentifiers.DWARVEN_STOUT; // 1913
  const STEAMFORGE_BREW_ITEM = ItemIdentifiers.STEAMFORGE_BREW; // 29412
  const MIND_BOMB_ITEM = ItemIdentifiers.WIZARDS_MIND_BOMB; // 1907
  const BEER_GLASS_ITEM = ItemIdentifiers.BEER_GLASS; // 1919
  const COINS_ITEM = ItemIdentifiers.COINS; // 995
  const STONE_TABLET_ITEM = ItemIdentifiers.STONE_TABLET_12; // 30952
  const BLADE_PRICE = 250000;

  // Temple basement (region ~1706-1723, 9696-9714).
  const TEMPLE_BED_OBJECT = 56535; // vmq4_temple_bed_with_key_1_op [Search]
  const TEMPLE_DRAWER_NORTH_OBJECT = 56532; // vmq4_temple_canvas_draw_1_open [Search,Shut]
  const TEMPLE_DRAWER_SOUTH_OBJECT = 56533; // vmq4_temple_canvas_draw_2_open [Search,Shut]
  const TEMPLE_DRAWERS = new Set([TEMPLE_DRAWER_NORTH_OBJECT, TEMPLE_DRAWER_SOUTH_OBJECT]);
  const TEMPLE_PAINTING_OBJECT = 56526; // vmq4_temple_metzli_painting_wall_can_push
  const TEMPLE_CHEST_OBJECT = 56537; // vmq4_temple_metzli_chamber_chest_closed [Open]
  const TEMPLE_DOOR_OBJECT = 56539; // twilight_temple_door_closed [Open]
  // Teumo's basement (Cam Torum, region ~1463-1471, 9560-9573).
  const TEUMO_SHELF_OBJECT = 56489; // vmq4_teumo_basement_shelf_op [Search]
  const TEUMO_STAIRS_OBJECT = 56476; // vmq4_teumo_house_stairs_down [Climb-down]
  const TEUMO_BARRELS = new Set([56490, 56491, 56492, 56493, 56494]); // barrel_1..5 [Inspect]
  // Sun room (plane 1, ~1282-1339, 9435-9457).
  const SUN_STATUE_OBJECT = 56679; // vmq4_sun_puzzle_statue [Inspect]
  const SUN_URN_OBJECT = 56682; // vmq4_sun_puzzle_urn [Search]
  const SUN_ALTAR_OBJECT = 56688; // vmq4_sun_altar_ops [Imbue]
  // Moon room.
  const MOON_STATUE_OBJECT = 56690; // vmq4_moon_puzzle_statue [Inspect]
  const MOON_ROOTS_OBJECT = 56694; // vmq4_moon_puzzle_root_ops [Pull]
  const MOON_TOOLS_OBJECT = 56698; // vmq4_moon_puzzle_old_tools_op [Search]
  const MOON_PLATFORMS = new Set([56700, 56703]); // [Move-Itzla]
  // Neypotzli / Mokhaiotl.
  const GLOWING_SYMBOL_OBJECT = 56622; // vmq4_keystone_chamber_entrance_open [Touch]
  const CRYPT_ENTRY_OBJECT = 56636; // vmq4_crypt_of_tonali_entry [Enter]
  const CRYPT_DOOR_OBJECT = 56642; // vmq4_crypt_door_to_moki [Open]
  const RUINS_SKELETON_OBJECT = 56596; // vmq4_moki_skeleton_tablet_op [Search]
  const RUINS_RALOS_OBJECT = 56601; // vmq4_moki_memorial_ralos_op [Inspect]
  const RUINS_RANUL_OBJECT = 56603; // vmq4_moki_memorial_ranul_op [Inspect]

  const TEMPLE_BED_TILE = { x: 1712, y: 9696, z: 0 };
  const TEMPLE_CORRIDOR_TILE = { x: 1711, y: 9704, z: 0 };
  const TEMPLE_HIDDEN_ROOM_TILE = { x: 1723, y: 9708, z: 0 };
  const TEMPLE_ENFORCER_TILE = { x: 1723, y: 9707, z: 0 };
  const PALACE_TILE = { x: 1680, y: 3176, z: 0 };
  const CAM_TORUM_TILE = { x: 1440, y: 9560, z: 1 };
  const CAM_TORUM_MARKET_TILE = { x: 1441, y: 9550, z: 1 };
  const TEUMO_HOUSE_TILE = { x: 1466, y: 9571, z: 1 };
  const TEUMO_BASEMENT_TILE = { x: 1468, y: 9572, z: 0 };
  const TEUMO_PASSAGE_TILE = { x: 1470, y: 9565, z: 0 };
  const NEYPOTZLI_TILE = { x: 1508, y: 9578, z: 0 };
  const TWINS_ARENA_TILE = { x: 1362, y: 9520, z: 0 };
  const TONALI_CAVERN_TILE = { x: 1330, y: 9450, z: 1 };
  const MOON_ROOM_TILE = { x: 1290, y: 9447, z: 1 };
  const METZLI_CHAMBER_TILE = { x: 1310, y: 9520, z: 1 };
  const RUINS_TILE = { x: 1308, y: 9540, z: 0 };

  const BARREL_TILES = [
    { x: 1464, y: 9567 }, // north, smells like a pub -> beer
    { x: 1466, y: 9568 }, // east, empty -> beer glass
    { x: 1465, y: 9568 }, // centre, black liquid -> dwarven stout
    { x: 1463, y: 9568 }, // west, steam -> steamforge brew
    { x: 1464, y: 9566 }, // south, bubbling -> wizard's mind bomb
  ];
  const DRINK_BY_BARREL = new Map([
    [56490, BEER_ITEM],
    [56491, BEER_GLASS_ITEM],
    [56492, DWARVEN_STOUT_ITEM],
    [56493, STEAMFORGE_BREW_ITEM],
    [56494, MIND_BOMB_ITEM],
  ]);
  const BARREL_INSPECT_MESSAGES = new Map([
    [56490, "The barrel smells like a standard Gielinorian pub."],
    [56491, "The barrel seems to be empty."],
    [56492, "Parts of the barrel have been stained by some sort of black liquid."],
    [56493, "A very small amount of steam seems to be coming out of the barrel."],
    [56494, "It sounds like whatever is in the barrel is bubbling a fair bit."],
  ]);
  const PLACED_DRINK_MESSAGES = new Map([
    [BEER_ITEM, "You place a glass of beer on the barrel and hear a clicking sound as you do so."],
    [DWARVEN_STOUT_ITEM, "You place a glass of dwarven stout on the barrel and hear a clicking sound as you do so."],
    [STEAMFORGE_BREW_ITEM, "You place a glass of steamforge brew on the barrel and hear a clicking sound as you do so."],
    [MIND_BOMB_ITEM, "You place a glass of wizard's mind bomb on the barrel and hear a clicking sound as you do so."],
  ]);

  const BITS_ATTRIBUTE = "quest.the_final_dawn.bits";
  const SUN_ATTRIBUTE = "quest.the_final_dawn.sun";
  const MOON_ATTRIBUTE = "quest.the_final_dawn.moon";
  const FRAGMENT_ATTRIBUTE = "quest.the_final_dawn.fragment";
  const BARRELS_ATTRIBUTE = "quest.the_final_dawn.barrels";
  const SAFEHOUSE_ATTRIBUTE = "quest.the_final_dawn.safehouse-talked";
  const TEUMO_INTRO_ATTRIBUTE = "quest.the_final_dawn.teumo-intro";
  const POST_ATTALA_ATTRIBUTE = "quest.the_final_dawn.post-talk";
  const BIT_DOG_CALMED = 1 << 0;
  const BIT_SACK_GIVEN = 1 << 1;
  const BIT_JANUS_CAPTURED = 1 << 2;
  const BIT_LEVER = 1 << 3;
  const BIT_TABLET_ONE = 1 << 4;
  const BIT_TABLET_TWO = 1 << 5;
  const BIT_RALOS = 1 << 6;
  const BIT_RANUL = 1 << 7;
  const BIT_BLADE_PENDING = 1 << 8;
  const EXPLORE_BITS = BIT_TABLET_ONE | BIT_TABLET_TWO | BIT_RALOS | BIT_RANUL;

  // Condition step ids (page "The Final Dawn").
  const COND_NOT_ELIGIBLE = "8Zj1PE";
  const COND_ELIGIBLE = "K8OGHQ";
  const COND_NO_ROBES = "wxJxRs";
  const COND_ROBES = "wULtBo";
  const COND_BAD_PHRASE = "IeESHx";
  const COND_GOOD_PHRASE = "frNcbs";
  const COND_NO_SPACE_BRANCH = "5hwIng";
  const COND_SPACE_BRANCH = "GZ5Gg7";
  const COND_SACK_GIVEN = "9nEa5R";
  const COND_NO_SACK = "CBvjdi";
  const COND_HAS_EMPTY_SACK = "nT7qU3";
  const COND_HAS_BRANCH = "Sd5Thx";
  const COND_HAS_BLACKJACK = "Evghag";
  const COND_PUZZLE_UNSOLVED = "QMfGQr";
  const COND_PUZZLE_UNSOLVED_SERVIUS = "07bk2p";
  const COND_PUZZLE_SOLVED_SERVIUS = "_kun3N";
  const COND_LEVER_NOT_PULLED = "LrZDqN";
  const COND_LEVER_PULLED = "y941EW";
  const COND_SUN_FIRST = "52ox-c";
  const COND_SUN_PROGRESS = "QX5yBI";
  const COND_SUN_NO_ESSENCE = "SHgONb";
  const COND_SUN_ESSENCE = "7s3Ci4";
  const COND_SUN_OK = "fdj1r5";
  const COND_SUN_FIRST_OK = "aBwKM-";
  const COND_SUN_DONE_STEP = "6LdoIs";
  const COND_SUN_FAIL = "XtiIjZ";
  const COND_ONE_CHAMBER = "PZsbxy";
  const COND_BOTH_CHAMBERS = "2UJ3XG";
  const COND_ITZLA_IN_COMBAT = "FVFktT";
  const COND_ITZLA_IDLE = "C-MNGR";
  const COND_INV_FULL_BLADE = "B8vwDI";
  const COND_INV_SPACE_BLADE = "TIcAVX";
  const COND_BLADE_LOST = "W691bV";
  const COND_NOT_ENOUGH_MONEY = "eUjzBe";
  const COND_ENOUGH_MONEY = "bH7R4B";
  const COND_BLADE_STORED = "gx8OJj";
  const COND_AKD_NOT_DONE = "VHoYmf";
  const COND_AKD_DONE = "pNnvX8";

  // Action/message step ids.
  const ACTION_MEETING_OPENS = "8udrXG";
  const ACTION_MEETING_ENDS = "EPLBr8";
  const ACTION_SERMON_OPENS = "QNa_aF";
  const ACTION_BACKROOM_ENDS = "1cZjnd";
  const ACTION_CHEST_CUTSCENE = "eBkDUz";
  const ACTION_CHEST_FIGHT = "6XJh_e";
  const ACTION_SAFEHOUSE_ENTER = "y4Y42F";
  const ACTION_SACK_GIVEN = "pghDpt";
  const ACTION_JANUS_CAPTURE = "XR0VTA";
  const ACTION_INTERROGATE_ARRIVE = "ZWqy3O";
  const ACTION_TRAVEL_CAM_TORUM = "U0zok7";
  const ACTION_CAM_TORUM_ENDS = "_IdqnD";
  const ACTION_ATTALA_DEPART = "Suwm5i";
  const ACTION_BEER_GIVEN = "FvNbYY";
  const ACTION_HIDDEN_ENDS = "oo0Amt";
  const ACTION_REPORT2_DEPART = "AxIldc";
  const ACTION_FRAGMENT_GIVEN = "PEbJCo";
  const ACTION_TWINS_ENDS = "maos4n";
  const ACTION_TWINS_DEFEATED = "pLwSTY";
  const ACTION_WAVES_ENDS = "QwN4C2";
  const ACTION_DESCEND = "Lv4I-P";
  const ACTION_DOORS_OPEN = "Harl6K";
  const ACTION_COMPLETE = "P0uE8w";

  /** Transient passphrase selections, keyed per player. */
  const phraseWords = new WeakMap();
  /** Per-player owner-only quest NPCs. */
  const trackedNpcs = new Map();
  let sceneryInstalled = false;
  let quest;

  // ==========================================================================
  // Small helpers
  // ==========================================================================

  function bits(player) {
    return Number(player.getAttribute(BITS_ATTRIBUTE)) || 0;
  }

  function hasBit(player, bit) {
    return (bits(player) & bit) !== 0;
  }

  function setBit(player, bit, on = true) {
    player.setAttribute(BITS_ATTRIBUTE, on ? bits(player) | bit : bits(player) & ~bit);
  }

  function held(player, itemId) {
    return player.getInventory().getAmount(itemId) > 0;
  }

  function freeSlots(player) {
    return player.getInventory().getFreeSlots();
  }

  function give(player, itemId, fullMessage) {
    if (freeSlots(player) <= 0) {
      if (fullMessage) player.sendMessage(fullMessage);
      return false;
    }
    player.getInventory().adds(itemId, 1);
    return true;
  }

  function questActive(player) {
    return quest.getStage(player) >= STAGE_STARTED && !quest.isComplete(player);
  }

  function questComplete(player, key) {
    const request = { player, key, complete: null };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    return (
      skills.getCurrentLevel(Skill.THIEVING) >= 66 &&
      skills.getCurrentLevel(Skill.RUNECRAFTING) >= 52 &&
      skills.getCurrentLevel(Skill.FLETCHING) >= 52 &&
      questComplete(player, "the_heart_of_darkness") &&
      questComplete(player, "perilous_moons") &&
      questComplete(player, "twilights_promise")
    );
  }

  function wearingEmissaryRobes(player) {
    const equipment = player.getEquipment();
    const body = equipment.get(Equipment.BODY_SLOT)?.getId?.();
    const legs = equipment.get(Equipment.LEG_SLOT)?.getId?.();
    return body === ItemIdentifiers.EMISSARY_ROBE_TOP && legs === ItemIdentifiers.EMISSARY_ROBE_BOTTOM;
  }

  function play(player, npcId, variant) {
    return startTranscript(api, player, npcId, PAGE, variant);
  }

  /** Runs `action` once the player's chatbox is clear, so a closing transcript cannot wipe it. */
  function whenIdle(player, action) {
    if (!TaskManager || !CountdownTask) {
      action();
      return;
    }
    TaskManager.submit(
      new CountdownTask(player, 2, () => {
        if (player.isRegistered?.() === false) return;
        const chatting =
          player.getDialogueManager?.()?.isActive?.() === true ||
          api.core.MultiChatboxPrompt?.getPending?.(player) != null;
        if (chatting) {
          whenIdle(player, action);
          return;
        }
        action();
      })
    );
  }

  function npcIdOf(event) {
    return event.npcId ?? event.npc?.getId?.();
  }

  // ==========================================================================
  // Tracked owner-only NPC spawns
  // ==========================================================================

  function tracked(player, key) {
    return trackedNpcs.get(player)?.get(key) ?? null;
  }

  function syncTracked(player, key, definition) {
    const tracked = trackedNpcs.get(player) ?? new Map();
    trackedNpcs.set(player, tracked);
    const existing = tracked.get(key);
    if (!definition) {
      if (existing?.isRegistered?.()) api.removeNpc(existing);
      if (existing) tracked.delete(key);
      return null;
    }
    if (existing?.isRegistered?.() && existing.getId?.() === definition.id) return existing;
    if (existing?.isRegistered?.()) api.removeNpc(existing);
    const npc = api.spawnNpc({ ...definition, owner: player, ownerOnly: true });
    if (npc) tracked.set(key, npc);
    return npc;
  }

  function ensureQuestNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = quest.getStage(player);
    if (quest.isComplete(player)) {
      syncTracked(player, "servius-palace", { id: SERVIUS_TALK_ID, x: 1683, y: 3174, z: 0, wanderRadius: 0 });
      return;
    }
    const palacePhase = stage < STAGE_REPORTED;
    syncTracked(player, "servius-palace", palacePhase
      ? { id: SERVIUS_TALK_ID, x: 1683, y: 3174, z: 0, wanderRadius: 0 }
      : null);
    const templePhase = stage >= STAGE_TASKED && stage < STAGE_REPORTED;
    syncTracked(player, "emissary-temple", templePhase
      ? { id: EMISSARY_TEMPLE_ID, x: 1676, y: 3244, z: 0, wanderRadius: 0 }
      : null);
    const homeInvasion = stage >= STAGE_REPORTED && stage <= STAGE_JANUS;
    syncTracked(player, "vibia-house", homeInvasion
      ? { id: VIBIA_TALK_ID, x: 1650, y: 3096, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "guard-dog", homeInvasion
      ? { id: GUARD_DOG_ID, x: 1648, y: 3095, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "janus-captured", stage === STAGE_TRAP && hasBit(player, BIT_JANUS_CAPTURED)
      ? { id: JANUS_UNCONSCIOUS_ID, x: 1647, y: 3094, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "galna", stage >= STAGE_TEUMO && stage < STAGE_NEYPOTZLI
      ? { id: GALNA_ID, x: TEUMO_HOUSE_TILE.x, y: TEUMO_HOUSE_TILE.y, z: TEUMO_HOUSE_TILE.z, wanderRadius: 0 }
      : null);
    const inTeumoBasement = stage >= STAGE_TEUMO_BASEMENT && stage < STAGE_NEYPOTZLI;
    syncTracked(player, "attala-basement", inTeumoBasement
      ? { id: ATTALA_TALK_ID, x: 1466, y: 9567, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "servius-basement", inTeumoBasement
      ? { id: SERVIUS_BASEMENT_ID, x: 1467, y: 9567, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "servius-teklan", stage === STAGE_TWINS || stage === STAGE_CRYPT
      ? { id: SERVIUS_CRYPT_ID, x: 1301, y: 3029, z: 0, wanderRadius: 0 }
      : null);
    const itzlaTile = itzlaTileForStage(stage);
    syncTracked(player, "itzla", itzlaTile
      ? { id: ITZLA_QUEST_ID, x: itzlaTile.x, y: itzlaTile.y, z: itzlaTile.z, wanderRadius: 0 }
      : null);
  }

  function itzlaTileForStage(stage) {
    if (stage === STAGE_ENNIUS) return { x: 1332, y: 9450, z: 1 };
    if (stage === STAGE_SUN) return { x: 1329, y: 9448, z: 1 };
    if (stage === STAGE_MOON) return MOON_ROOM_TILE;
    if (stage === STAGE_METZLI || stage === STAGE_ARCHIVE) return { x: 1308, y: 9520, z: 1 };
    if (stage === STAGE_EXPLORE) return RUINS_TILE;
    return null;
  }

  function setStage(player, stage) {
    quest.setStage(player, stage);
    ensureQuestNpcs(player);
  }

  // ==========================================================================
  // Quest scenery the cache maps only in its non-interactive variant
  // ==========================================================================

  function installScenery() {
    if (sceneryInstalled) return;
    sceneryInstalled = true;
    registerObject(TEMPLE_BED_OBJECT, TEMPLE_BED_TILE);
    registerObject(TEMPLE_DRAWER_NORTH_OBJECT, { x: 1713, y: 9714, z: 0 });
    registerObject(TEMPLE_DRAWER_SOUTH_OBJECT, { x: 1709, y: 9700, z: 0 });
    // Shape 0 face 0: the cache's wall shape is only reachable from the unstandable
    // south tile, while a straight wall is reachable from the corridor west of it.
    registerObject(TEMPLE_PAINTING_OBJECT, { x: 1719, y: 9706, z: 0 }, 0, 0);
    registerObject(TEUMO_SHELF_OBJECT, { x: 1464, y: 9569, z: 0 });
    registerObject(SUN_ALTAR_OBJECT, { x: 1332, y: 9445, z: 1 });
    registerObject(MOON_ROOTS_OBJECT, { x: 1285, y: 9441, z: 1 });
    registerObject(MOON_TOOLS_OBJECT, { x: 1285, y: 9439, z: 1 });
    registerObject(RUINS_SKELETON_OBJECT, { x: 1307, y: 9532, z: 1 });
    registerObject(RUINS_RALOS_OBJECT, { x: 1304, y: 9527, z: 1 });
    registerObject(RUINS_RANUL_OBJECT, { x: 1317, y: 9527, z: 1 });
    let index = 0;
    for (const barrelId of TEUMO_BARRELS) {
      registerObject(barrelId, { ...BARREL_TILES[index], z: 0 });
      index++;
    }
  }

  function registerObject(objectId, tile, type = 10, face = 0) {
    const object = new GameObject(objectId, new Location(tile.x, tile.y, tile.z), type, face, null);
    ObjectManager.register(object, true);
  }

  // ==========================================================================
  // Talk-to handlers
  // ==========================================================================

  function talkServius(event) {
    const npcId = npcIdOf(event);
    if (!SERVIUS_IDS.has(npcId)) return false;
    const { player } = event;
    installScenery();
    if (quest.isComplete(player)) {
      play(player, npcId, "post-quest-dialogue-talking-to-servius");
      return true;
    }
    if (!questActive(player)) {
      if (npcId !== SERVIUS_TALK_ID) return false;
      play(player, npcId, "infiltration-ii-talking-to-servius");
      return true;
    }
    const stage = quest.getStage(player);
    if (stage === STAGE_STARTED) {
      play(player, npcId, "infiltration-ii-talking-to-servius-talking-to-servius-again-before-going-to-meet-with-queen-zyanyi");
      return true;
    }
    if (stage < STAGE_REPORTED) {
      play(player, npcId, "infiltration-ii-talking-to-servius-talking-to-servius-again-after-meeting-with-queen-zyanyi");
      return true;
    }
    if (stage >= STAGE_REPORTED && stage <= STAGE_JANUS) {
      play(player, npcId, "home-invasion-interrogating-janus-talking-to-servius-before-leaving-for-cam-torum");
      return true;
    }
    if (stage === STAGE_MARKET) {
      play(player, npcId, "dwarven-traitor-talking-to-servius-or-attala");
      return true;
    }
    if (stage === STAGE_TEUMO_BASEMENT || stage === STAGE_PUZZLE) {
      play(player, npcId, "dwarven-traitor-talking-to-servius-in-the-basement");
      return true;
    }
    if (stage === STAGE_TWINS) {
      play(player, npcId, "crypt-assault-talking-to-servius");
      setStage(player, STAGE_CRYPT);
      return true;
    }
    if (stage === STAGE_CRYPT) {
      play(player, npcId, "crypt-assault-talking-to-servius-talking-to-servius-again");
      return true;
    }
    return false;
  }

  function talkQueen(event) {
    const npcId = npcIdOf(event);
    if (!QUEEN_IDS.has(npcId)) return false;
    const { player } = event;
    if (quest.isComplete(player)) {
      play(player, npcId, "post-quest-dialogue-talking-to-queen-zyanyi");
      return true;
    }
    const stage = quest.getStage(player);
    if (stage >= STAGE_STARTED && stage < STAGE_ENFORCER) {
      play(player, npcId, "infiltration-ii-talking-to-servius-talking-to-queen-zyanyi-again");
      return true;
    }
    if (stage === STAGE_ENFORCER) {
      play(player, npcId, "home-invasion-talking-to-queen-zyanyi-or-servius");
      setStage(player, STAGE_REPORTED);
      return true;
    }
    if (stage >= STAGE_REPORTED && stage < STAGE_JANUS) {
      play(player, npcId, "home-invasion-talking-to-queen-zyanyi-or-servius-talking-to-queen-zyanyi-again");
      return true;
    }
    if (stage === STAGE_JANUS) {
      play(player, npcId, "home-invasion-interrogating-janus-talking-to-the-queen-again-after-refusing-her-offer-to-travel-to-cam-torum");
      return true;
    }
    return false;
  }

  function talkItzla(event) {
    const npcId = npcIdOf(event);
    if (!ITZLA_IDS.has(npcId)) return false;
    const { player } = event;
    if (quest.isComplete(player)) {
      play(player, npcId, "post-quest-dialogue-talking-to-prince-itzla");
      return true;
    }
    const stage = quest.getStage(player);
    if (stage === STAGE_ENNIUS) {
      play(player, npcId, "crypt-assault-upon-entering-the-southern-area-of-the-tonali-cavern-after-the-cutscene");
      return true;
    }
    if (stage === STAGE_SUN || stage === STAGE_MOON) {
      play(player, npcId, "crypt-assault-talking-to-prince-itzla-arkan-in-the-area-between-the-sun-and-moon-chambers");
      return true;
    }
    if (stage === STAGE_METZLI) {
      play(player, npcId, "crypt-assault-upon-defeating-metzli-talking-to-itzla-again");
      return true;
    }
    if (stage === STAGE_ARCHIVE) {
      play(player, npcId, "crypt-assault-entering-the-archive");
      return true;
    }
    if (stage === STAGE_EXPLORE && hasBit(player, BIT_BLADE_PENDING)) {
      play(player, npcId, "crypt-assault-upon-fully-exploring-the-area-talking-again-if-inventory-was-full");
      return true;
    }
    return false;
  }

  function talkAttala(event) {
    const npcId = npcIdOf(event);
    if (!ATTALA_IDS.has(npcId)) return false;
    const { player } = event;
    if (quest.isComplete(player)) {
      const talked = player.getAttribute(POST_ATTALA_ATTRIBUTE) === true;
      play(player, npcId, talked
        ? "post-quest-dialogue-talking-to-attala-subsequent-post-quest"
        : "post-quest-dialogue-talking-to-attala-initial-post-quest");
      player.setAttribute(POST_ATTALA_ATTRIBUTE, true);
      return true;
    }
    const stage = quest.getStage(player);
    if (stage === STAGE_CAM_TORUM || stage === STAGE_MARKET) {
      play(player, npcId, "dwarven-traitor-talking-to-servius-or-attala");
      return true;
    }
    if (stage === STAGE_TEUMO) {
      play(player, npcId, "dwarven-traitor-talking-to-attala-or-galna");
      return true;
    }
    if (stage === STAGE_TEUMO_BASEMENT) {
      play(player, npcId, "dwarven-traitor-talking-to-attala-in-the-basement");
      return true;
    }
    if (stage === STAGE_PUZZLE) {
      play(player, npcId, "dwarven-traitor-talking-to-servius-or-attala-2");
      return true;
    }
    return false;
  }

  function talkGalna(event) {
    if (npcIdOf(event) !== GALNA_ID) return false;
    const { player } = event;
    if (quest.getStage(player) !== STAGE_TEUMO) return false;
    if (player.getAttribute(TEUMO_INTRO_ATTRIBUTE) === true) {
      play(player, GALNA_ID, "dwarven-traitor-talking-to-attala-or-galna");
      return true;
    }
    play(player, GALNA_ID, "dwarven-traitor-entering-teumo-s-home");
    player.setAttribute(TEUMO_INTRO_ATTRIBUTE, true);
    if (!held(player, BEER_ITEM)) player.getInventory().adds(BEER_ITEM, 1);
    return true;
  }

  function talkVibia(event) {
    const npcId = npcIdOf(event);
    if (!VIBIA_IDS.has(npcId)) return false;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage === STAGE_REPORTED) {
      play(player, npcId, "home-invasion-talking-to-captain-vibia");
      return true;
    }
    if (stage === STAGE_SAFEHOUSE) {
      if (player.getAttribute(SAFEHOUSE_ATTRIBUTE) === true) {
        play(player, npcId, "home-invasion-talking-to-captain-vibia-2");
        return true;
      }
      play(player, npcId, "home-invasion-in-janus-safehouse");
      player.setAttribute(SAFEHOUSE_ATTRIBUTE, true);
      return true;
    }
    if (stage === STAGE_TRAP) {
      play(player, npcId, "home-invasion-interrogating-janus-talking-to-captain-vibia-before-leaving-for-cam-torum");
      return true;
    }
    if (stage === STAGE_JANUS) {
      play(player, npcId, "home-invasion-interrogating-janus-talking-to-captain-vibia-before-leaving-for-cam-torum");
      return true;
    }
    return false;
  }

  function talkEyatlalli(event) {
    const npcId = npcIdOf(event);
    if (!EYATLALLI_IDS.has(npcId)) return false;
    const { player } = event;
    if (quest.isComplete(player)) {
      const talked = player.getAttribute(POST_ATTALA_ATTRIBUTE) === true;
      play(player, npcId, talked
        ? "post-quest-dialogue-talking-to-eyatlalli-subsequent-post-quest"
        : "post-quest-dialogue-talking-to-eyatlalli-initial-post-quest");
      player.setAttribute(POST_ATTALA_ATTRIBUTE, true);
      return true;
    }
    const stage = quest.getStage(player);
    if (stage === STAGE_REPORT2) {
      play(player, EYATLALLI_TALK_ID, "interlopers-in-neypotzli-upon-entering-neypotzli");
      return true;
    }
    if (stage === STAGE_NEYPOTZLI) {
      play(player, EYATLALLI_TALK_ID, "interlopers-in-neypotzli-upon-entering-neypotzli-talking-to-eyatlalli-again");
      return true;
    }
    return false;
  }

  function talkKatlo(event) {
    if (!KATLO_IDS.has(npcIdOf(event))) return false;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage >= STAGE_CAM_TORUM && stage < STAGE_REPORT2) {
      play(player, KATLO_TALK_ID, "dwarven-traitor-talking-to-highlord-katlo-in-his-chamber");
      return true;
    }
    return false;
  }

  function talkJanus(event) {
    const npcId = npcIdOf(event);
    if (npcId !== JANUS_TALK_ID) return false;
    if (quest.getStage(event.player) !== STAGE_JANUS) return false;
    play(event.player, npcId, "home-invasion-interrogating-janus-talking-to-servius-before-leaving-for-cam-torum");
    return true;
  }

  function searchJanus(event) {
    if (npcIdOf(event) !== JANUS_UNCONSCIOUS_ID) return false;
    const { player } = event;
    if (quest.getStage(player) !== STAGE_TRAP || !hasBit(player, BIT_JANUS_CAPTURED)) return false;
    play(player, JANUS_UNCONSCIOUS_ID, "home-invasion-interrogating-janus");
    return true;
  }

  function talkFuria(event) {
    const npcId = npcIdOf(event);
    if (npcId !== FURIA_TALK_ID) return false;
    if (!quest.isComplete(event.player)) return false;
    play(event.player, npcId, "post-quest-dialogue-talking-to-furia");
    return true;
  }

  function talkEmissary(event) {
    const npcId = npcIdOf(event);
    if (npcId !== EMISSARY_TEMPLE_ID) return false;
    const { player } = event;
    if (quest.isComplete(player)) return false;
    const stage = quest.getStage(player);
    if (stage === STAGE_TASKED) {
      play(player, npcId, "infiltration-ii-entering-the-twilight-temple");
      return true;
    }
    if (stage === STAGE_SERMON) {
      play(player, npcId, "infiltration-ii-attempting-to-climb-downstairs");
      return true;
    }
    if (stage >= STAGE_BASEMENT && stage < STAGE_REPORTED) {
      play(player, npcId, "infiltration-ii-talking-to-an-emissary-ascended-chosen-or-acolyte");
      return true;
    }
    return false;
  }

  function petDog(event) {
    const npcId = npcIdOf(event);
    if (npcId !== GUARD_DOG_ID) return false;
    const { player } = event;
    if (!hasBit(player, BIT_DOG_CALMED)) {
      play(player, npcId, "home-invasion-attempting-to-open-the-safe-house-door-or-using-bones-raw-or-cooked-meat-on-the-guard-dog");
      return true;
    }
    play(player, npcId, "home-invasion-giving-the-dog-bones-petting-the-dog");
    setStage(player, STAGE_SAFEHOUSE);
    return true;
  }

  // ==========================================================================
  // Item interactions
  // ==========================================================================

  function handleItemOnNpc(event) {
    const npcId = npcIdOf(event);
    const { player, itemId } = event;
    if (npcId === GUARD_DOG_ID) {
      const stage = quest.getStage(player);
      if (stage < STAGE_REPORTED || stage > STAGE_JANUS) return;
      if (itemId !== BONES_ITEM && itemId !== COOKED_MEAT_ITEM && itemId !== ALANS_BONES_ITEM && !RAW_MEAT_IDS.has(itemId)) {
        return;
      }
      event.handled = true;
      if (hasBit(player, BIT_DOG_CALMED)) return;
      player.getInventory().deleteNumber(itemId, 1);
      setBit(player, BIT_DOG_CALMED);
      play(player, GUARD_DOG_ID, itemId === ALANS_BONES_ITEM
        ? "home-invasion-giving-the-dog-bones-giving-the-dog-alan-s-bones"
        : "home-invasion-giving-the-dog-bones");
      return;
    }
    if (npcId === GALNA_ID && itemId === BEER_ITEM && quest.getStage(player) === STAGE_TEUMO) {
      event.handled = true;
      player.getInventory().deleteNumber(BEER_ITEM, 1);
      play(player, GALNA_ID, "dwarven-traitor-using-beer-on-galna");
    }
  }

  function handleItemOnObject(event) {
    const { player, itemId, objectId } = event;
    installScenery();
    if (itemId === CANVAS_PIECE_ITEM && objectId === TEMPLE_PAINTING_OBJECT) {
      event.handled = true;
      if (quest.getStage(player) !== STAGE_CANVAS) return;
      player.getInventory().deleteNumber(CANVAS_PIECE_ITEM, 1);
      setStage(player, STAGE_SCROLL);
      play(player, EMISSARY_TEMPLE_ID, "infiltration-ii-entering-the-backroom-using-the-canvas-piece-on-the-drawing");
      return;
    }
    const wanted = DRINK_BY_BARREL.get(objectId);
    if (wanted === undefined) return;
    event.handled = true;
    if (wanted === BEER_GLASS_ITEM || wanted !== itemId || !held(player, itemId)) return;
    if (hasBit(player, BIT_LEVER)) return;
    player.getInventory().deleteNumber(itemId, 1);
    player.sendMessage(PLACED_DRINK_MESSAGES.get(itemId));
    const placed = (Number(player.getAttribute(BARRELS_ATTRIBUTE)) || 0) + 1;
    player.setAttribute(BARRELS_ATTRIBUTE, placed);
    if (placed >= 4) {
      setBit(player, BIT_LEVER);
      setStage(player, STAGE_PUZZLE);
      player.sendMessage("You pull the hidden lever and hear a clicking sound from elsewhere in the room.");
      play(player, ATTALA_TALK_ID, "dwarven-traitor-hidden-entrance");
    }
  }

  function handleItemOnItem(event) {
    const { player } = event;
    installScenery();
    const pair = new Set([event.usedItemId, event.usedWithItemId]);
    if (pair.has(BRANCH_ITEM) && pair.has(SANDY_COIN_PURSE_ITEM)) {
      event.handled = true;
      player.getInventory().deleteNumber(BRANCH_ITEM, 1);
      player.getInventory().deleteNumber(SANDY_COIN_PURSE_ITEM, 1);
      player.getInventory().adds(MAKESHIFT_BLACKJACK_ITEM, 1);
      player.sendMessage("You bind the sand-filled purse to the end of the springy branch, creating a makeshift blackjack.");
      return;
    }
    if (pair.has(KNIFE_BLADE_ITEM) && pair.has(ANCIENT_ROOTS_ITEM)) {
      event.handled = true;
      player.getInventory().deleteNumber(ANCIENT_ROOTS_ITEM, 1);
      player.getInventory().adds(ROOT_KINDLING_ITEM, 4);
      player.sendMessage("You fletch the ancient roots into root kindling.");
    }
  }

  function emptyCoinPurse(event) {
    const { player, itemId } = event;
    if (itemId !== SANDY_COIN_PURSE_ITEM) return;
    event.handled = true;
    player.getInventory().deleteNumber(SANDY_COIN_PURSE_ITEM, 1);
    player.getInventory().adds(EMPTY_COIN_PURSE_ITEM, 1);
    player.sendMessage("You empty the sand from the coin purse.");
  }

  // ==========================================================================
  // Object interactions
  // ==========================================================================

  function handleObject(event) {
    installScenery();
    const { player, objectId } = event;
    const stage = quest.getStage(player);

    if (objectId === TEMPLE_BED_OBJECT) {
      event.handled = true;
      if (stage < STAGE_BACKROOM) return;
      if (held(player, DRAWER_KEY_ITEM)) {
        player.sendMessage("You have already taken the key.");
        return;
      }
      if (!give(player, DRAWER_KEY_ITEM, "You search the bed and find a key under one of the pillows, but you don't have enough room to take it.")) return;
      player.sendMessage("You search the bed and find a key under one of the pillows.");
      setStage(player, STAGE_KEY);
      return;
    }

    if (TEMPLE_DRAWERS.has(objectId)) {
      event.handled = true;
      if (stage < STAGE_KEY || !held(player, DRAWER_KEY_ITEM)) {
        player.sendMessage("The drawers are locked.");
        return;
      }
      if (held(player, CANVAS_PIECE_ITEM) || stage >= STAGE_SCROLL) {
        player.sendMessage("The drawers are empty.");
        return;
      }
      if (!give(player, CANVAS_PIECE_ITEM, "You search the drawers and find a piece of canvas, but you don't have enough room to take it.")) return;
      player.sendMessage("You search the drawers and find a piece of canvas.");
      setStage(player, STAGE_CANVAS);
      return;
    }

    if (objectId === TEMPLE_CHEST_OBJECT) {
      event.handled = true;
      if (stage >= STAGE_ENFORCER || held(player, EMISSARY_SCROLL_ITEM)) {
        play(player, ENFORCER_ID, "infiltration-ii-entering-the-backroom-searching-the-chest-again");
        return;
      }
      if (stage !== STAGE_SCROLL) return;
      play(player, ENFORCER_ID, "infiltration-ii-entering-the-backroom-searching-the-chest");
      return;
    }

    if (objectId === TEMPLE_PAINTING_OBJECT) {
      // The canvas opened the passage; walking through it again re-enters.
      if (stage < STAGE_SCROLL || stage >= STAGE_ENFORCER) return;
      event.handled = true;
      player.moveTo(new Location(TEMPLE_HIDDEN_ROOM_TILE.x, TEMPLE_HIDDEN_ROOM_TILE.y, TEMPLE_HIDDEN_ROOM_TILE.z));
      return;
    }

    if (objectId === TEMPLE_DOOR_OBJECT) {
      if (stage !== STAGE_BASEMENT) return;
      event.handled = true;
      play(player, EMISSARY_TEMPLE_ID, "infiltration-ii-entering-the-backroom");
      player.moveTo(new Location(1712, 9703, 0));
      return;
    }

    if (objectId === TEUMO_STAIRS_OBJECT) {
      if (stage < STAGE_TEUMO_BASEMENT || stage >= STAGE_NEYPOTZLI) return;
      event.handled = true;
      player.moveTo(new Location(TEUMO_BASEMENT_TILE.x, TEUMO_BASEMENT_TILE.y, TEUMO_BASEMENT_TILE.z));
      return;
    }

    if (objectId === TEUMO_SHELF_OBJECT) {
      event.handled = true;
      if (stage < STAGE_TEUMO_BASEMENT || stage > STAGE_PUZZLE) return;
      for (const itemId of [BEER_ITEM, DWARVEN_STOUT_ITEM, STEAMFORGE_BREW_ITEM, MIND_BOMB_ITEM, BEER_GLASS_ITEM]) {
        if (!held(player, itemId)) player.getInventory().adds(itemId, 1);
      }
      player.sendMessage("You take a selection of drinks from the cabinet.");
      return;
    }

    if (TEUMO_BARRELS.has(objectId)) {
      event.handled = true;
      player.sendMessage(BARREL_INSPECT_MESSAGES.get(objectId));
      return;
    }

    if (objectId === SUN_URN_OBJECT) {
      event.handled = true;
      if (stage < STAGE_ENNIUS) return;
      if (held(player, KUHU_ESSENCE_ITEM)) {
        player.sendMessage("The urn appears to be empty.");
        return;
      }
      player.getInventory().adds(KUHU_ESSENCE_ITEM, 1);
      player.sendMessage("You find some strange essence inside the urn.");
      return;
    }

    if (objectId === SUN_STATUE_OBJECT) {
      event.handled = true;
      if (stage < STAGE_ENNIUS) return;
      const progress = Number(player.getAttribute(SUN_ATTRIBUTE)) || 0;
      if (progress === 0 && !held(player, KUHU_ESSENCE_ITEM)) {
        player.sendMessage("Light reflects off the statue, revealing some words engraved upon it: [Old Ones text]");
        player.sendMessage("Statue engraving: [Old Ones text]");
        play(player, ITZLA_QUEST_ID, "crypt-assault-sun-chamber-inspecting-the-sun-statue");
        return;
      }
      if (!held(player, KUHU_ESSENCE_ITEM)) {
        player.sendMessage("You have nothing to imbue the altar with.");
        return;
      }
      player.getInventory().deleteNumber(KUHU_ESSENCE_ITEM, 1);
      const next = progress + 1;
      player.setAttribute(SUN_ATTRIBUTE, next);
      if (next >= 3) {
        player.sendMessage("You imbue the altar and the central statue lights up with energy.");
        setStage(player, STAGE_SUN);
        return;
      }
      player.sendMessage("You imbue the altar, and hear a grinding sound coming from the central statue.");
      if (progress === 0) player.sendMessage("That seemed to do the trick! Keep it up.");
      return;
    }

    if (objectId === MOON_STATUE_OBJECT) {
      event.handled = true;
      if (stage < STAGE_SUN) return;
      const progress = Number(player.getAttribute(MOON_ATTRIBUTE)) || 0;
      if (progress >= 3) {
        player.sendMessage("There looks to be a small amount of burnt kindling around the statue.");
        return;
      }
      const kindling = player.getInventory().getAmount(ROOT_KINDLING_ITEM);
      if (kindling < 3) {
        if (kindling > 0) {
          player.getInventory().deleteNumber(ROOT_KINDLING_ITEM, kindling);
          player.sendMessage("The statue rejects the kindling and incinerates it.");
        } else {
          player.sendMessage("There looks to be a small amount of burnt kindling around the statue.");
        }
        return;
      }
      player.getInventory().deleteNumber(ROOT_KINDLING_ITEM, 3);
      const next = progress + 1;
      player.setAttribute(MOON_ATTRIBUTE, next);
      if (next >= 3) {
        player.sendMessage("The statue lights up with energy as it accepts your offering of kindling.");
        player.sendMessage("Nice work! I think you did it!");
        setStage(player, STAGE_MOON);
        return;
      }
      player.sendMessage("The statue seems to glow as it accepts your offering of kindling.");
      if (progress === 0) player.sendMessage("Whatever you're doing seems to be working. Keep at it!");
      return;
    }

    if (objectId === MOON_ROOTS_OBJECT) {
      event.handled = true;
      if (stage < STAGE_SUN) return;
      if (freeSlots(player) <= 0) {
        player.sendMessage("You need some space in your inventory to do that.");
        return;
      }
      player.getInventory().adds(ANCIENT_ROOTS_ITEM, 1);
      player.sendMessage("You pull up some roots.");
      return;
    }

    if (objectId === MOON_TOOLS_OBJECT) {
      event.handled = true;
      if (stage < STAGE_SUN) return;
      if (held(player, KNIFE_BLADE_ITEM)) return;
      if (freeSlots(player) <= 0) {
        player.sendMessage("You search the tools and find an old knife blade, but you don't have enough room to take it.");
        return;
      }
      player.getInventory().adds(KNIFE_BLADE_ITEM, 1);
      player.sendMessage("You search the tools and find an old knife blade.");
      return;
    }

    if (MOON_PLATFORMS.has(objectId)) {
      event.handled = true;
      if (stage < STAGE_SUN) return;
      play(player, ITZLA_QUEST_ID, "crypt-assault-moon-chamber-moving-prince-itzla");
      return;
    }

    if (objectId === RUINS_SKELETON_OBJECT) {
      event.handled = true;
      if (stage < STAGE_ARCHIVE) return;
      if (!hasBit(player, BIT_TABLET_ONE)) {
        if (!give(player, STONE_TABLET_ITEM, "You search the skeleton and find a tablet, but you don't have enough room to take it.")) return;
        player.sendMessage("You search the skeleton and find a tablet.");
        setBit(player, BIT_TABLET_ONE);
        return;
      }
      player.sendMessage("The skeleton has nothing else of note.");
      setBit(player, BIT_TABLET_TWO);
      checkRuinsExplored(player);
      return;
    }

    if (objectId === RUINS_RALOS_OBJECT) {
      event.handled = true;
      if (stage < STAGE_ARCHIVE) return;
      player.sendMessage("The statue has a single word engraved upon it: 'Ralos'");
      setBit(player, BIT_RALOS);
      checkRuinsExplored(player);
      return;
    }

    if (objectId === RUINS_RANUL_OBJECT) {
      event.handled = true;
      if (stage < STAGE_ARCHIVE) return;
      player.sendMessage("The statue has a single word engraved upon it: 'Ranul'");
      setBit(player, BIT_RANUL);
      checkRuinsExplored(player);
      return;
    }

    if (objectId === CRYPT_ENTRY_OBJECT) {
      event.handled = true;
      if (stage === STAGE_CRYPT) {
        play(player, QUEEN_TALK_ID, "crypt-assault-entering-the-temple");
        setStage(player, STAGE_WAVES);
        spawnCultistWave(player);
        return;
      }
      if (stage === STAGE_WAVES) spawnCultistWave(player);
    }
  }

  function handleGlowingSymbol(event) {
    if (event.objectId !== GLOWING_SYMBOL_OBJECT) return;
    const { player } = event;
    event.handled = true;
    const stage = quest.getStage(player);
    if (stage === STAGE_NEYPOTZLI) {
      const step = Number(player.getAttribute(FRAGMENT_ATTRIBUTE)) || 0;
      if (step === 0) {
        player.sendMessage("The fragment shakes and rises out of your hand, it them falls back into your palm, now pointing north.");
        player.setAttribute(FRAGMENT_ATTRIBUTE, 1);
        play(player, EYATLALLI_TALK_ID, "interlopers-in-neypotzli-the-first-fragment-checkpoint");
        return;
      }
      if (step === 1) {
        player.sendMessage("The fragment shakes and rises out of your hand, it them falls back into your palm, now pointing south.");
        player.setAttribute(FRAGMENT_ATTRIBUTE, 2);
        play(player, EYATLALLI_TALK_ID, "interlopers-in-neypotzli-the-second-fragment-checkpoint");
        return;
      }
      player.sendMessage("The fragment crumbles in your hand and the dust blows towards a nearby wall, causing a symbol to appear.");
      player.setAttribute(FRAGMENT_ATTRIBUTE, 0);
      player.getInventory().deleteNumber(KEYSTONE_FRAGMENT_ITEM, 1);
      setStage(player, STAGE_TWINS_FIGHT);
      play(player, ENNIUS_BOSS_ID, "interlopers-in-neypotzli-confronting-the-twins");
      return;
    }
    if (stage === STAGE_ARCHIVE && (bits(player) & EXPLORE_BITS) === EXPLORE_BITS) {
      setStage(player, STAGE_EXPLORE);
      play(player, ITZLA_QUEST_ID, "crypt-assault-upon-fully-exploring-the-area");
      return;
    }
    if (stage === STAGE_EXPLORE) {
      play(player, ITZLA_QUEST_ID, "crypt-assault-upon-interacting-with-the-entrance-to-the-ruins-of-mokhaiotl");
    }
  }

  function handleDoorToggle(request) {
    if (!request?.player) return;
    const { player, objectId } = request;
    if (objectId === TEMPLE_DOOR_OBJECT) {
      if (quest.getStage(player) === STAGE_BASEMENT) {
        play(player, EMISSARY_TEMPLE_ID, "infiltration-ii-entering-the-backroom");
      }
      return;
    }
    if (objectId !== CRYPT_DOOR_OBJECT) return;
    if ((Number(player.getAttribute(SUN_ATTRIBUTE)) || 0) < 3 || (Number(player.getAttribute(MOON_ATTRIBUTE)) || 0) < 3) return;
    request.handled = true;
    play(player, ITZLA_QUEST_ID, "crypt-assault-opening-the-final-doors");
  }

  function checkRuinsExplored(player) {
    if ((bits(player) & EXPLORE_BITS) === EXPLORE_BITS && quest.getStage(player) === STAGE_ARCHIVE) {
      player.sendMessage("Having discovered all that you can in the ruins, you return to the crypt...");
    }
  }

  // ==========================================================================
  // Combat progression
  // ==========================================================================

  function spawnCultistWave(player) {
    const tile = player.getLocation();
    api.spawnNpc({ id: CULTIST_MELEE_ID, x: tile.getX() + 1, y: tile.getY(), z: tile.getZ(), wanderRadius: 2, owner: player, ownerOnly: true });
    api.spawnNpc({ id: CULTIST_RANGED_ID, x: tile.getX() - 1, y: tile.getY(), z: tile.getZ(), wanderRadius: 2, owner: player, ownerOnly: true });
  }

  function spawnTwins(player) {
    api.spawnNpc({ id: CHIMALLI_ID, x: TWINS_ARENA_TILE.x - 1, y: TWINS_ARENA_TILE.y, z: TWINS_ARENA_TILE.z, wanderRadius: 0, owner: player, ownerOnly: true });
    api.spawnNpc({ id: LUCIUS_ID, x: TWINS_ARENA_TILE.x + 1, y: TWINS_ARENA_TILE.y, z: TWINS_ARENA_TILE.z, wanderRadius: 0, owner: player, ownerOnly: true });
  }

  function spawnEnforcer(player) {
    if (tracked(player, "enforcer")) return;
    syncTracked(player, "enforcer", {
      id: ENFORCER_ID,
      x: TEMPLE_ENFORCER_TILE.x,
      y: TEMPLE_ENFORCER_TILE.y,
      z: TEMPLE_ENFORCER_TILE.z,
      wanderRadius: 0,
    });
  }

  function spawnEnnius(player) {
    if (tracked(player, "ennius-boss")) return;
    const tile = player.getLocation();
    syncTracked(player, "ennius-boss", {
      id: ENNIUS_BOSS_ID,
      x: tile.getX(),
      y: tile.getY() + 2,
      z: tile.getZ(),
      wanderRadius: 0,
    });
    setStage(player, STAGE_ENNIUS);
  }

  function spawnMetzli(player) {
    if (tracked(player, "metzli-boss")) return;
    syncTracked(player, "metzli-boss", {
      id: METZLI_BOSS_ID,
      x: METZLI_CHAMBER_TILE.x + 1,
      y: METZLI_CHAMBER_TILE.y + 3,
      z: METZLI_CHAMBER_TILE.z,
      wanderRadius: 0,
    });
  }

  function ownedNpcAlive(player, ids) {
    const world = api.getWorld();
    if (!world?.getNpcs) return false;
    const username = player.getUsername?.();
    for (const npc of world.getNpcs()) {
      if (!ids.has(npc?.getId?.())) continue;
      // The death event fires while the corpse is still in the world: a dying npc
      // must not count, or the last kill never clears the wave.
      if (npc.isDyingFunction?.() === true || (npc.getHitpoints?.() ?? 1) <= 0) continue;
      // Identity fails after a relog recreates the Player, so match the name too.
      // An ownerless npc never belongs to this wave.
      const owner = npc.getOwner?.();
      if (owner === player || (username && owner?.getUsername?.() === username)) return true;
    }
    return false;
  }

  function handleNpcDeath(event) {
    const npcId = event.npcId ?? event.npc?.getId?.();
    const player = event.killer?.isPlayer?.() ? event.killer : event.player;
    if (!player) return;
    const stage = quest.getStage(player);
    if (npcId === ENFORCER_ID) {
      if (stage !== STAGE_SCROLL) return;
      syncTracked(player, "enforcer", null);
      setStage(player, STAGE_ENFORCER);
      give(player, EMISSARY_SCROLL_ITEM, "You pick up the emissary scroll.");
      player.sendMessage("You pick up the emissary scroll and read it.");
      // The fight happens in the walled-off room; leave it with the scroll.
      player.moveTo(new Location(TEMPLE_CORRIDOR_TILE.x, TEMPLE_CORRIDOR_TILE.y, TEMPLE_CORRIDOR_TILE.z));
      return;
    }
    if (npcId === CULTIST_MELEE_ID || npcId === CULTIST_RANGED_ID) {
      if (stage !== STAGE_WAVES) return;
      if (ownedNpcAlive(player, new Set([CULTIST_MELEE_ID, CULTIST_RANGED_ID]))) return;
      play(player, QUEEN_TALK_ID, "crypt-assault-upon-clearing-the-waves-of-cultists");
      return;
    }
    if (npcId === ENNIUS_BOSS_ID) {
      if (stage !== STAGE_ENNIUS) return;
      syncTracked(player, "ennius-boss", null);
      play(player, QUEEN_TALK_ID, "crypt-assault-upon-killing-ennius");
      return;
    }
    if (npcId === METZLI_BOSS_ID) {
      if (stage !== STAGE_METZLI) return;
      syncTracked(player, "metzli-boss", null);
      play(player, ITZLA_QUEST_ID, "crypt-assault-upon-defeating-metzli");
      setStage(player, STAGE_ARCHIVE);
      return;
    }
    if (npcId === CHIMALLI_ID || npcId === LUCIUS_ID) {
      if (stage !== STAGE_TWINS_FIGHT) return;
      if (ownedNpcAlive(player, new Set([CHIMALLI_ID, LUCIUS_ID]))) return;
      play(player, ATTALA_TALK_ID, "interlopers-in-neypotzli-upon-defeating-lucius-and-chimalli");
    }
  }

  // ==========================================================================
  // Transcript events
  // ==========================================================================

  function handleHook(event) {
    if (event.hook !== START_HOOK) return;
    const { player } = event;
    if (quest.getStage(player) !== 0) return;
    setStage(player, STAGE_STARTED);
  }

  function handleChoice(event) {
    const { player, npcId, option } = event;
    if (npcId === EMISSARY_TEMPLE_ID) {
      if (PHRASE_WORDS.has(option)) {
        const words = [...(phraseWords.get(player) ?? []), option].slice(-2);
        phraseWords.set(player, words);
        // The dump nests the phrase check under "Eclipse." only, so "Final." then
        // "Dawn." would close with no verdict; award the good branch here.
        if (words.length === 2 && words[0] === "Final." && words[1] === "Dawn.") {
          setStage(player, STAGE_BASEMENT);
          player.moveTo(new Location(TEMPLE_CORRIDOR_TILE.x, TEMPLE_CORRIDOR_TILE.y, TEMPLE_CORRIDOR_TILE.z));
        }
      }
      if (option === "Enter the passage.") {
        player.moveTo(new Location(TEMPLE_HIDDEN_ROOM_TILE.x, TEMPLE_HIDDEN_ROOM_TILE.y, TEMPLE_HIDDEN_ROOM_TILE.z));
      }
      return;
    }
    if (VIBIA_IDS.has(npcId) && option === "I'll get searching.") {
      if (!held(player, EMPTY_SACK_ITEM)) player.getInventory().adds(EMPTY_SACK_ITEM, 1);
      if (!held(player, SANDY_COIN_PURSE_ITEM) && !held(player, MAKESHIFT_BLACKJACK_ITEM)) player.getInventory().adds(SANDY_COIN_PURSE_ITEM, 1);
      if (!held(player, BRANCH_ITEM) && !held(player, MAKESHIFT_BLACKJACK_ITEM)) player.getInventory().adds(BRANCH_ITEM, 1);
      if (!held(player, KNIFE_ITEM)) player.getInventory().adds(KNIFE_ITEM, 1);
      return;
    }
    if (ITZLA_IDS.has(npcId) && quest.isComplete(player) && option === "Yes.") {
      if (held(player, ARKAN_BLADE_ITEM)) return;
      if (player.getInventory().getAmount(COINS_ITEM) < BLADE_PRICE) return;
      player.getInventory().deleteNumber(COINS_ITEM, BLADE_PRICE);
      player.getInventory().adds(ARKAN_BLADE_ITEM, 1);
      player.sendMessage("You give Itzla 250,000 coins and he gives you the Arkan Blade in return.");
    }
  }

  function answerCondition(event) {
    const { player, npcId, stepId } = event;
    if (SERVIUS_IDS.has(npcId) && quest.getStage(player) === 0) {
      if (stepId === COND_NOT_ELIGIBLE) return !meetsRequirements(player);
      if (stepId === COND_ELIGIBLE) return meetsRequirements(player);
    }
    if (npcId === EMISSARY_TEMPLE_ID) {
      if (stepId === COND_NO_ROBES) return !wearingEmissaryRobes(player);
      if (stepId === COND_ROBES) return wearingEmissaryRobes(player);
      if (stepId === COND_BAD_PHRASE || stepId === COND_GOOD_PHRASE) {
        const words = phraseWords.get(player) ?? [];
        const good = words.includes("Final.") && words.includes("Dawn.");
        return stepId === COND_GOOD_PHRASE ? good : !good;
      }
    }
    if (ATTALA_IDS.has(npcId)) {
      if (stepId === COND_PUZZLE_UNSOLVED) return !hasBit(player, BIT_LEVER);
      if (stepId === COND_LEVER_NOT_PULLED) return !hasBit(player, BIT_LEVER);
      if (stepId === COND_LEVER_PULLED) return hasBit(player, BIT_LEVER);
    }
    if (npcId === SERVIUS_BASEMENT_ID) {
      if (stepId === COND_PUZZLE_UNSOLVED_SERVIUS) return !hasBit(player, BIT_LEVER);
      if (stepId === COND_PUZZLE_SOLVED_SERVIUS) return hasBit(player, BIT_LEVER);
    }
    if (VIBIA_IDS.has(npcId)) {
      if (stepId === COND_NO_SPACE_BRANCH) return freeSlots(player) <= 0;
      if (stepId === COND_SPACE_BRANCH) return freeSlots(player) > 0;
      if (stepId === COND_SACK_GIVEN) return hasBit(player, BIT_SACK_GIVEN);
      if (stepId === COND_NO_SACK) return !hasBit(player, BIT_SACK_GIVEN);
      if (stepId === COND_HAS_EMPTY_SACK) return !hasBit(player, BIT_SACK_GIVEN) && held(player, EMPTY_SACK_ITEM);
      if (stepId === COND_HAS_BRANCH) return held(player, BRANCH_ITEM) && !held(player, MAKESHIFT_BLACKJACK_ITEM);
      if (stepId === COND_HAS_BLACKJACK) return held(player, MAKESHIFT_BLACKJACK_ITEM);
    }
    if (ITZLA_IDS.has(npcId)) {
      const sun = Number(player.getAttribute(SUN_ATTRIBUTE)) || 0;
      const moon = Number(player.getAttribute(MOON_ATTRIBUTE)) || 0;
      if (stepId === COND_SUN_FIRST) return sun === 0;
      if (stepId === COND_SUN_PROGRESS) return sun > 0;
      if (stepId === COND_SUN_NO_ESSENCE) return !held(player, KUHU_ESSENCE_ITEM);
      if (stepId === COND_SUN_ESSENCE) return held(player, KUHU_ESSENCE_ITEM);
      if (stepId === COND_SUN_OK) return true;
      if (stepId === COND_SUN_FIRST_OK) return sun === 1;
      if (stepId === COND_SUN_DONE_STEP) return sun >= 3;
      if (stepId === COND_SUN_FAIL) return false;
      if (stepId === COND_ONE_CHAMBER) return sun >= 3 && moon < 3;
      if (stepId === COND_BOTH_CHAMBERS) return sun >= 3 && moon >= 3;
      if (stepId === COND_ITZLA_IN_COMBAT) return false;
      if (stepId === COND_ITZLA_IDLE) return true;
      if (stepId === COND_INV_FULL_BLADE) return freeSlots(player) <= 0;
      if (stepId === COND_INV_SPACE_BLADE) return freeSlots(player) > 0;
      if (stepId === COND_BLADE_LOST) return !held(player, ARKAN_BLADE_ITEM);
      if (stepId === COND_BLADE_STORED) return false;
      if (stepId === COND_NOT_ENOUGH_MONEY) return player.getInventory().getAmount(COINS_ITEM) < BLADE_PRICE;
      if (stepId === COND_ENOUGH_MONEY) return player.getInventory().getAmount(COINS_ITEM) >= BLADE_PRICE;
    }
    if (QUEEN_IDS.has(npcId)) {
      if (stepId === COND_AKD_NOT_DONE) return !questComplete(player, "a_kingdom_divided");
      if (stepId === COND_AKD_DONE) return questComplete(player, "a_kingdom_divided");
    }
    return null;
  }

  /** The chosen condition branch; side effects only (the branch answer lives in answerCondition). */
  function handleCondition(event) {
    const { player, npcId, stepId } = event;
    if (npcId === EMISSARY_TEMPLE_ID && stepId === COND_GOOD_PHRASE) {
      setStage(player, STAGE_BASEMENT);
      player.moveTo(new Location(TEMPLE_CORRIDOR_TILE.x, TEMPLE_CORRIDOR_TILE.y, TEMPLE_CORRIDOR_TILE.z));
    }
  }

  function handleAction(event) {
    const { player, npcId, stepId } = event;
    switch (stepId) {
      case ACTION_MEETING_OPENS:
        if (!SERVIUS_IDS.has(npcId)) return;
        setStage(player, STAGE_TASKED);
        return;
      case ACTION_MEETING_ENDS:
        if (!SERVIUS_IDS.has(npcId)) return;
        if (quest.getStage(player) === STAGE_TASKED) {
          player.moveTo(new Location(PALACE_TILE.x, PALACE_TILE.y, PALACE_TILE.z));
        }
        return;
      case ACTION_SERMON_OPENS:
        if (npcId !== EMISSARY_TEMPLE_ID) return;
        setStage(player, STAGE_SERMON);
        return;
      case ACTION_CHEST_CUTSCENE:
      case ACTION_CHEST_FIGHT:
        if (npcId !== ENFORCER_ID) return;
        spawnEnforcer(player);
        return;
      case ACTION_BACKROOM_ENDS:
        if (npcId !== EMISSARY_TEMPLE_ID) return;
        setStage(player, STAGE_BACKROOM);
        return;
      case ACTION_SAFEHOUSE_ENTER:
        if (!VIBIA_IDS.has(npcId)) return;
        setStage(player, STAGE_SAFEHOUSE);
        return;
      case ACTION_SACK_GIVEN:
        if (!VIBIA_IDS.has(npcId)) return;
        setBit(player, BIT_SACK_GIVEN);
        return;
      case ACTION_JANUS_CAPTURE:
        if (!VIBIA_IDS.has(npcId)) return;
        setBit(player, BIT_JANUS_CAPTURED);
        setStage(player, STAGE_TRAP);
        return;
      case ACTION_INTERROGATE_ARRIVE:
        if (npcId !== JANUS_UNCONSCIOUS_ID) return;
        setStage(player, STAGE_JANUS);
        return;
      case ACTION_TRAVEL_CAM_TORUM:
        if (npcId !== JANUS_UNCONSCIOUS_ID && !QUEEN_IDS.has(npcId)) return;
        player.moveTo(new Location(CAM_TORUM_TILE.x, CAM_TORUM_TILE.y, CAM_TORUM_TILE.z));
        // The consent transcript's terminal close would wipe a scene played inline.
        whenIdle(player, () => play(player, KATLO_TALK_ID, "dwarven-traitor"));
        return;
      case ACTION_CAM_TORUM_ENDS:
        if (npcId !== KATLO_TALK_ID) return;
        setStage(player, STAGE_CAM_TORUM);
        player.moveTo(new Location(CAM_TORUM_MARKET_TILE.x, CAM_TORUM_MARKET_TILE.y, CAM_TORUM_MARKET_TILE.z));
        return;
      case ACTION_ATTALA_DEPART:
        if (!ATTALA_IDS.has(npcId)) return;
        setStage(player, STAGE_TEUMO);
        return;
      case ACTION_BEER_GIVEN:
        if (npcId !== GALNA_ID) return;
        setStage(player, STAGE_TEUMO_BASEMENT);
        player.moveTo(new Location(TEUMO_BASEMENT_TILE.x, TEUMO_BASEMENT_TILE.y, TEUMO_BASEMENT_TILE.z));
        return;
      case ACTION_HIDDEN_ENDS:
        if (!ATTALA_IDS.has(npcId)) return;
        setBit(player, BIT_LEVER);
        setStage(player, STAGE_PUZZLE);
        player.moveTo(new Location(TEUMO_PASSAGE_TILE.x, TEUMO_PASSAGE_TILE.y, TEUMO_PASSAGE_TILE.z));
        return;
      case ACTION_REPORT2_DEPART:
        if (!ATTALA_IDS.has(npcId)) return;
        setStage(player, STAGE_REPORT2);
        player.moveTo(new Location(NEYPOTZLI_TILE.x, NEYPOTZLI_TILE.y, NEYPOTZLI_TILE.z));
        return;
      case ACTION_FRAGMENT_GIVEN:
        if (!EYATLALLI_IDS.has(npcId)) return;
        give(player, KEYSTONE_FRAGMENT_ITEM);
        setStage(player, STAGE_NEYPOTZLI);
        return;
      case ACTION_TWINS_ENDS:
        if (npcId !== ENNIUS_BOSS_ID) return;
        spawnTwins(player);
        return;
      case ACTION_TWINS_DEFEATED:
        if (!ATTALA_IDS.has(npcId)) return;
        setStage(player, STAGE_TWINS);
        return;
      case ACTION_WAVES_ENDS:
        if (!QUEEN_IDS.has(npcId)) return;
        spawnEnnius(player);
        return;
      case ACTION_DESCEND:
        if (!QUEEN_IDS.has(npcId)) return;
        player.moveTo(new Location(TONALI_CAVERN_TILE.x, TONALI_CAVERN_TILE.y, TONALI_CAVERN_TILE.z));
        setStage(player, STAGE_ENNIUS);
        return;
      case ACTION_DOORS_OPEN:
        if (npcId !== ITZLA_QUEST_ID) return;
        player.moveTo(new Location(METZLI_CHAMBER_TILE.x, METZLI_CHAMBER_TILE.y, METZLI_CHAMBER_TILE.z));
        setStage(player, STAGE_METZLI);
        spawnMetzli(player);
        play(player, ITZLA_QUEST_ID, "crypt-assault-confronting-metzli");
        return;
      case ACTION_COMPLETE:
        if (npcId !== ITZLA_QUEST_ID) return;
        completeQuest(player);
        return;
      default:
        return;
    }
  }

  function completeQuest(player) {
    if (quest.isComplete(player)) return;
    if (freeSlots(player) <= 0) {
      setBit(player, BIT_BLADE_PENDING);
      return;
    }
    setBit(player, BIT_BLADE_PENDING, false);
    quest.complete(player);
  }

  // ==========================================================================
  // Login
  // ==========================================================================

  function handleLogin({ player }) {
    installScenery();
    ensureQuestNpcs(player);
    refreshQuestList(player);
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Servius asked for my help when the Twilight Emissaries</str>",
        "<str>took Prince Itzla, and Queen Zyanyi had me infiltrate</str>",
        "<str>the cult. I followed them through Civitas, Cam Torum,</str>",
        "<str>Neypotzli and the Crypt of Tonali, and Metzli fell at</str>",
        "<str>Mokhaiotl. Itzla gave me the Arkan blade.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage === 0) {
      return [
        "I can start this quest by talking to <col=800000>Servius, Teokan of Ralos</col>",
        "in the <col=800000>Sunrise Palace</col>.",
        "",
        "I need 66 Thieving, 52 Runecraft and 52 Fletching, and to",
        "have completed The Heart of Darkness, Perilous Moons and",
        "Twilight's Promise.",
      ];
    }
    const lines = [];
    if (stage < STAGE_REPORTED) {
      lines.push("I have agreed to infiltrate the <col=800000>Twilight Emissaries</col>");
      lines.push("for Queen Zyanyi and find out what they are doing with Itzla.");
      if (stage >= STAGE_SERMON) lines.push("I watched Metzli present Itzla at the Twilight Temple.");
      if (stage >= STAGE_BASEMENT) lines.push("I gave the passphrase and entered the temple basement.");
      if (stage >= STAGE_KEY) lines.push("I found a key under the pillows of the bed.");
      if (stage >= STAGE_CANVAS) lines.push("I found a canvas piece in the drawers.");
      if (stage >= STAGE_SCROLL) lines.push("I opened the hidden chest behind the painting.");
      if (stage >= STAGE_ENFORCER) lines.push("I defeated the Emissary Enforcer and have the scroll to report.");
    } else if (stage < STAGE_CAM_TORUM) {
      lines.push("The scroll reveals the cult is using a safe house by the western bank.");
      lines.push("Captain Vibia is waiting there to help me capture Forebearer Janus.");
      if (stage >= STAGE_SAFEHOUSE) lines.push("The house is secured and Vibia is inside.");
      if (stage >= STAGE_TRAP) lines.push("The trap is ready, we are waiting for Janus to return.");
      if (stage >= STAGE_JANUS) lines.push("Janus is captured. Next stop: Cam Torum.");
    } else if (stage < STAGE_NEYPOTZLI) {
      lines.push("I am in <col=800000>Cam Torum</col> hunting the cult's dwarven contact.");
      lines.push("Attala is helping with the investigation.");
      if (stage >= STAGE_MARKET) lines.push("Attala suspects Highseer Vandra's advisor, Teumo.");
      if (stage >= STAGE_TEUMO) lines.push("We are searching Teumo's house for clues.");
      if (stage >= STAGE_TEUMO_BASEMENT) lines.push("I befriended Galna and can search Teumo's basement.");
      if (stage >= STAGE_PUZZLE) lines.push("The basement puzzle is solved; the cult wants a Neypotzli keystone.");
      if (stage >= STAGE_REPORT2) lines.push("I should go to Neypotzli and stop the Tullus twins.");
    } else if (stage < STAGE_CRYPT) {
      lines.push("In <col=800000>Neypotzli</col> the Tullus twins are after the keystone.");
      if (stage >= STAGE_NEYPOTZLI) lines.push("Eyatlalli gave me a keystone fragment to track them.");
      if (stage >= STAGE_TWINS) lines.push("The twins escaped, but I defeated Lucius and Chimalli.");
      lines.push("I should report to the Queen at Tal Teklan.");
    } else if (stage < STAGE_SUN) {
      lines.push("The <col=800000>Crypt of Tonali</col> is under attack by the cult.");
      if (stage >= STAGE_WAVES) lines.push("I am holding the crypt against the cultists.");
      if (stage >= STAGE_ENNIUS) lines.push("Ennius is dead; Itzla and I are descending into the caverns.");
    } else if (stage < STAGE_METZLI) {
      lines.push("Itzla and I are solving the sun and moon chambers of the Tonali cavern.");
      lines.push("Sun chamber: " + ((Number(player.getAttribute(SUN_ATTRIBUTE)) || 0) >= 3 ? "done" : "not done") + ".");
      lines.push("Moon chamber: " + ((Number(player.getAttribute(MOON_ATTRIBUTE)) || 0) >= 3 ? "done" : "not done") + ".");
    } else {
      lines.push("Itzla and I are hunting Metzli through the Ruins of Mokhaiotl.");
      if (stage >= STAGE_ARCHIVE) lines.push("The archive is empty; Furia killed Metzli. I should explore the ruins.");
      if (stage >= STAGE_EXPLORE) lines.push("I have explored the ruins. I should return to the crypt.");
    }
    return lines;
  }

  function grantReward(player) {
    const skills = player.getSkillManager();
    skills.addExperiences(Skill.THIEVING, 55000);
    skills.addExperiences(Skill.RUNECRAFTING, 25000);
    skills.addExperiences(Skill.FLETCHING, 25000);
    if (freeSlots(player) > 0) player.getInventory().adds(ANTIQUE_LAMP_ITEM, 1);
  }

  api.persistAttribute(BITS_ATTRIBUTE);
  api.persistAttribute(SUN_ATTRIBUTE);
  api.persistAttribute(MOON_ATTRIBUTE);
  api.persistAttribute(FRAGMENT_ATTRIBUTE);
  api.persistAttribute(BARRELS_ATTRIBUTE);
  api.persistAttribute(SAFEHOUSE_ATTRIBUTE);
  api.persistAttribute(TEUMO_INTRO_ATTRIBUTE);
  api.persistAttribute(POST_ATTALA_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "the_final_dawn",
    name: "The Final Dawn",
    varpId: VARP_FINAL_DAWN,
    varbitId: STAGE_VARBIT,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 3,
    xpRewards: [
      { skillId: Skill.THIEVING.getIndex(), amount: 55000, label: "Thieving" },
      { skillId: Skill.RUNECRAFTING.getIndex(), amount: 25000, label: "Runecraft" },
      { skillId: Skill.FLETCHING.getIndex(), amount: 25000, label: "Fletching" },
    ],
    rewardItemId: ARKAN_BLADE_ITEM,
    rewardItemLabel: "Arkan blade, antique lamp",
    otherRewards: ["Access to the Crypt of Tonali", "Access to the Doom of Mokhaiotl"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcInteraction("Servius, Teokan of Ralos", { "Talk-to": talkServius });
  api.onNpcInteraction("Queen Zyanyi Arkan", { "Talk-to": talkQueen });
  api.onNpcInteraction("Prince Itzla Arkan", { "Talk-to": talkItzla });
  api.onNpcInteraction("Attala", { "Talk-to": talkAttala });
  api.onNpcInteraction("Galna", { "Talk-to": talkGalna });
  api.onNpcInteraction("Captain Vibia", { "Talk-to": talkVibia });
  api.onNpcInteraction("Eyatlalli", { "Talk-to": talkEyatlalli });
  api.onNpcInteraction("Highlord Katlo", { "Talk-to": talkKatlo });
  api.onNpcInteraction("Forebearer Janus", { "Talk-to": talkJanus, Search: searchJanus });
  api.onNpcInteraction("Furia Tullus", { "Talk-to": talkFuria });
  api.onNpcInteraction("Emissary Ascended", { "Talk-to": talkEmissary });
  api.onNpcInteraction("Dog", { Pet: petDog });
  api.onItemOnNpc(handleItemOnNpc, { noted: false });
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onItemOnItem(handleItemOnItem, { noted: false });
  api.onItemAction("Sandy coin purse", { Empty: emptyCoinPurse });
  api.onObjectInteraction(handleObject);
  api.onObjectInteraction(handleGlowingSymbol);
  api.onNpcDeath(handleNpcDeath);
  api.onPlayerLogin(handleLogin);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleHook);
  api.onCustomEvent("npc-dialogue:condition", handleCondition);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("door:toggle", handleDoorToggle);
};
