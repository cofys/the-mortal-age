/**
 * The Slug Menace (members).
 *
 * The words come from the "The Slug Menace" transcript page (npc-dialogues.json);
 * this plugin supplies the variant selectors for Sir Tiffy Cashien, Col. O'Niall,
 * Mayor Hobb, Brother Maledict, Jeb, Jorral, Ezekial and the Witchaven villagers,
 * the Talk-to claims for Holgart and Bailey (whose Sea Slug selectors would
 * otherwise win), the prose-condition answers, the Commorb v2 Scan/Contact/
 * Playback steps, the shrine false wall and imposing door, the three stolen
 * pages, the glue and rune-crafting chain, the Slug Prince fight and the
 * completion hand-in.
 *
 * Stages (varbit 2610 "slug2_main", bits 0-7 of varp 874 "quest_slug2";
 * confirmed with `ts-node scripts/lookup-gameval.ts varbit slug`):
 *   0 not started, 1 Sir Tiffy gave the Commorb v2 (see O'Niall),
 *   2 O'Niall briefed (talk to Hobb/Maledict/Holgart), 3 all three spoken
 *   (report back), 4 O'Niall points at the shrine, 5 door transcription
 *   obtained, 6 Jorral translated the glyphs, 7 Savant revealed Mother Mallum
 *   (tell O'Niall), 8 possessed Maledict asks for the three pages, 9 page 1,
 *   page 2 and the three fragments held, 10 Savant forbade swamp paste (get
 *   slug glue), 11 Bailey made the sea slug glue, 12 the page is reassembled,
 *   13 the Slug Prince is dead (tell Sir Tiffy), 14 complete.
 *
 * The Wiki does not publish the varp's values, so the boundaries were read off
 * the cache: varbits 2611-2631 carry the sub-steps (fixed page, savant info,
 * scan, the three investigation tracks, door/torn pages, the five used runes,
 * the dead slug) and NPCs 6242/6243/6244/6252 (the Witchaven "Chair", Mayor
 * Hobb, Brother Maledict and Jeb spawns) transform on varbit 2610 at stages
 * 1, 5, 8, 9, 12, 13 and 14 - the milestones above line up with every one of
 * those thresholds.
 *
 * Requirements (OSRS Wiki): Wanted! and Sea Slug completed, 30 Crafting,
 * 30 Runecraft, 30 Slayer, 30 Thieving and the Commorb in the inventory.
 * Rewards: 1 Quest point, 3,500 Crafting, Runecraft and Thieving XP and
 * access to Proselyte armour from Sir Tiffy.
 *
 * Gaps / approximations:
 *   - The mayor's Commorb scan (a Savant prompt before the shrine) has no
 *     transcript in the dump; only the Wiki-flow-critical shrine scan is wired.
 *   - The page-reassembly puzzle interface is not in the cache dump: using the
 *     sea slug glue on a fragment with all three held consumes them and yields
 *     Page 3 with a plain message.
 *   - The transcript has no water-rune enchanting variant; its success uses the
 *     same formulaic line as its siblings, and the shaping/enchanting success
 *     chance is Mod Ash's 43% at level 1 to 99% at 99 (Wiki).
 *   - The shared ClimbLinks pairs the "Old ruin entrance" with an unrelated
 *     Exit (2696,9682); this plugin claims the climb through the ladders:climb
 *     event and routes into the dungeon entry corridor instead, and back out.
 *   - The dungeon map's collision leaves the Exit object unreachable; leaving
 *     is best done through the claim's destination or a teleport.
 *   - Multi-speaker cutscenes (Mayor Hobb / Mother Mallum / Savant) render with
 *     one chathead, as in the other transcript-driven quests.
 *   - The Slug Prince only prohibits non-melee damage (onNpcHitModify); its
 *     prayer drain is combat-core behaviour and is not simulated.
 *   - Trying to open the imposing door before the runes burns the player, but the
 *     5 damage the Wiki mentions is not dealt (a message-only transcript step).
 *   - The post-quest Sir Tiffy page's "lost Commorb v2" receive step is left to
 *     the runtime; the item is not handed back.
 *
 * Source: https://oldschool.runescape.wiki/w/The_Slug_Menace and
 * https://oldschool.runescape.wiki/w/Transcript:The_Slug_Menace
 */
module.exports = function registerSlugMenaceQuest(api) {
  const {
    CombatType,
    CountdownTask,
    Item,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    Skill,
    TaskManager,
  } = api.core;
  const { refreshQuestList, registerQuest, startTranscript } = require("../QuestRuntime");

  const PAGE = "The Slug Menace";
  const TIFFY_PAGE = "Sir Tiffy Cashien";

  // Cache varbits (`lookup-gameval varbit slug`).
  const VARP_SLUG_MENACE = 874; // "quest_slug2"
  const VARBIT_SLUG_MAIN = 2610; // "slug2_main", bits 0-7
  const VARBIT_FIXED_PAGE = 2611; // "slug2_fixed_page"
  const VARBIT_SAVANT_GOTINFO = 2612; // "slug2_savant_gotinfo"
  const VARBIT_SAVANT_SCAN = 2613; // "slug2_savant_scan"
  const VARBIT_TRACK_1 = 2614; // "slug2_npc_track1" (Holgart/boat)
  const VARBIT_TRACK_2 = 2615; // "slug2_npc_track2" (Hobb)
  const VARBIT_TRACK_3 = 2616; // "slug2_npc_track3" (Maledict)
  const VARBIT_DOORBIT = 2618; // "slug2_doorbit"
  const VARBIT_TORNPAGES = 2619; // "slug2_tornpages"
  const VARBIT_DOORSCAN = 2620; // "slug2_doorscan"
  const VARBIT_USED_EARTH = 2622; // "slug2_used_earth_rune"
  const VARBIT_USED_AIR = 2623; // "slug2_used_air_rune"
  const VARBIT_USED_FIRE = 2624; // "slug2_used_fire_rune"
  const VARBIT_USED_WATER = 2625; // "slug2_used_water_rune"
  const VARBIT_USED_MIND = 2626; // "slug2_used_mind_rune"
  const VARBIT_HAVESLUG = 2631; // "slug2_haveslug"

  // Quest NPCs (transformed content ids on the spawned "Chair"/villager ids).
  const SIR_TIFFY_NPC_IDS = new Set([
    NpcIdentifiers.SIR_TIFFY_CASHIEN, // 4687
    NpcIdentifiers.SIR_TIFFY_CASHIEN_2, // 8045
    NpcIdentifiers.SIR_TIFFY_CASHIEN_3, // 8157
    NpcIdentifiers.SIR_TIFFY_CASHIEN_4, // 8165
    NpcIdentifiers.SIR_TIFFY_CASHIEN_5, // 8173
    NpcIdentifiers.SIR_TIFFY_CASHIEN_6, // 11021
  ]);
  const COL_ONIALL_NPC_IDS = new Set([NpcIdentifiers.COL_ONIALL, NpcIdentifiers.COL_ONIALL_2]);
  const MAYOR_HOBB_NPC_IDS = new Set([NpcIdentifiers.MAYOR_HOBB, NpcIdentifiers.MAYOR_HOBB_2]);
  const BROTHER_MALEDICT_NPC_IDS = new Set([
    NpcIdentifiers.BROTHER_MALEDICT,
    NpcIdentifiers.BROTHER_MALEDICT_2,
  ]);
  const VILLAGER_NPC_IDS = new Set([
    NpcIdentifiers.WITCHAVEN_VILLAGER, // 4790
    NpcIdentifiers.WITCHAVEN_VILLAGER_2, // 4791
    NpcIdentifiers.WITCHAVEN_VILLAGER_3, // 4792
    NpcIdentifiers.WITCHAVEN_VILLAGER_4, // 4793
    NpcIdentifiers.WITCHAVEN_VILLAGER_5, // 4794
    NpcIdentifiers.WITCHAVEN_VILLAGER_6, // 4795
  ]);
  const SLUG_PRINCE_NPC_IDS = new Set([NpcIdentifiers.SLUG_PRINCE, NpcIdentifiers.SLUG_PRINCE_2]);

  const EZEKIAL_NPC_ID = NpcIdentifiers.EZEKIAL_LOVECRAFT; // 4789
  const JORRAL_NPC_ID = NpcIdentifiers.JORRAL; // 3490
  const SAVANT_NPC_ID = NpcIdentifiers.SAVANT; // 4931
  const JEB_NPC_IDS = new Set([NpcIdentifiers.JEB, NpcIdentifiers.JEB_2]);
  const MAYOR_HOBB_NPC_ID = NpcIdentifiers.MAYOR_HOBB; // 4783, cutscene chathead

  const COMMORB_ITEM_ID = ItemIdentifiers.COMMORB; // 6635
  const COMMORB_V2_ITEM_ID = ItemIdentifiers.COMMORB_V2; // 9681
  const DOOR_TRANSCRIPTION_ITEM_ID = ItemIdentifiers.DOOR_TRANSCRIPTION; // 9682
  const DEAD_SEA_SLUG_ITEM_ID = ItemIdentifiers.DEAD_SEA_SLUG; // 9683
  const PAGE_1_ITEM_ID = ItemIdentifiers.PAGE_1; // 9684
  const PAGE_2_ITEM_ID = ItemIdentifiers.PAGE_2; // 9685
  const PAGE_3_ITEM_ID = ItemIdentifiers.PAGE_3; // 9686
  const FRAGMENT_1_ITEM_ID = ItemIdentifiers.FRAGMENT_1; // 9687
  const FRAGMENT_2_ITEM_ID = ItemIdentifiers.FRAGMENT_2; // 9688
  const FRAGMENT_3_ITEM_ID = ItemIdentifiers.FRAGMENT_3; // 9689
  const SEA_SLUG_GLUE_ITEM_ID = ItemIdentifiers.SEA_SLUG_GLUE; // 9680
  const SWAMP_PASTE_ITEM_ID = ItemIdentifiers.SWAMP_PASTE;
  const CHISEL_ITEM_IDS = new Set([
    ItemIdentifiers.CHISEL, // 1755
    ItemIdentifiers.CHISEL_2, // 1756
    ItemIdentifiers.CHISEL_3, // 5601
  ]);
  const RUNE_ESSENCE_ITEM_ID = ItemIdentifiers.RUNE_ESSENCE; // 1436
  const PURE_ESSENCE_ITEM_ID = ItemIdentifiers.PURE_ESSENCE; // 7936
  const FRAGMENT_ITEM_IDS = new Set([FRAGMENT_1_ITEM_ID, FRAGMENT_2_ITEM_ID, FRAGMENT_3_ITEM_ID]);
  const PAGE_ITEM_IDS = new Set([PAGE_1_ITEM_ID, PAGE_2_ITEM_ID, PAGE_3_ITEM_ID]);

  const BLANK_AIR_RUNE_ITEM_ID = ItemIdentifiers.BLANK_AIR_RUNE; // 9692
  const BLANK_WATER_RUNE_ITEM_ID = ItemIdentifiers.BLANK_WATER_RUNE; // 9690
  const BLANK_EARTH_RUNE_ITEM_ID = ItemIdentifiers.BLANK_EARTH_RUNE; // 9694
  const BLANK_FIRE_RUNE_ITEM_ID = ItemIdentifiers.BLANK_FIRE_RUNE; // 9698
  const BLANK_MIND_RUNE_ITEM_ID = ItemIdentifiers.BLANK_MIND_RUNE; // 9696
  const AIR_RUNE_ITEM_ID = ItemIdentifiers.AIR_RUNE_6; // 9693
  const WATER_RUNE_ITEM_ID = ItemIdentifiers.WATER_RUNE_6; // 9691
  const EARTH_RUNE_ITEM_ID = ItemIdentifiers.EARTH_RUNE_4; // 9695
  const FIRE_RUNE_ITEM_ID = ItemIdentifiers.FIRE_RUNE_6; // 9699
  const MIND_RUNE_ITEM_ID = ItemIdentifiers.MIND_RUNE_4; // 9697
  const COMPLETE_RUNE_ITEM_IDS = new Set([
    AIR_RUNE_ITEM_ID,
    WATER_RUNE_ITEM_ID,
    EARTH_RUNE_ITEM_ID,
    FIRE_RUNE_ITEM_ID,
    MIND_RUNE_ITEM_ID,
  ]);
  const RUNE_BIT_BY_ITEM = new Map([
    [AIR_RUNE_ITEM_ID, 1 << 0],
    [WATER_RUNE_ITEM_ID, 1 << 1],
    [EARTH_RUNE_ITEM_ID, 1 << 2],
    [FIRE_RUNE_ITEM_ID, 1 << 3],
    [MIND_RUNE_ITEM_ID, 1 << 4],
  ]);
  const RUNE_VARBIT_BY_ITEM = new Map([
    [AIR_RUNE_ITEM_ID, VARBIT_USED_AIR],
    [WATER_RUNE_ITEM_ID, VARBIT_USED_WATER],
    [EARTH_RUNE_ITEM_ID, VARBIT_USED_EARTH],
    [FIRE_RUNE_ITEM_ID, VARBIT_USED_FIRE],
    [MIND_RUNE_ITEM_ID, VARBIT_USED_MIND],
  ]);
  const ALL_RUNES_USED = 0x1f;

  // Shrine / dungeon objects (ids confirmed with `dump-loc`).
  const OLD_RUIN_ENTRANCE_OBJECT_ID = ObjectIdentifiers.OLD_RUIN_ENTRANCE; // 18270
  const DUNGEON_EXIT_OBJECT_ID = ObjectIdentifiers.EXIT_16; // 18354
  const FALSE_WALL_OBJECT_ID = ObjectIdentifiers.WALL_100; // 18359, Push
  const WALL_PASSAGE_OBJECT_ID = ObjectIdentifiers.PASSAGE_3; // 18412, Enter
  const IMPOSING_DOOR_OBJECT_IDS = new Set([
    ObjectIdentifiers.IMPOSING_DOORS, // 18413
    ObjectIdentifiers.IMPOSING_DOORS_2, // 18414
    ObjectIdentifiers.IMPOSING_DOORS_3, // 18415
  ]);
  const STUDY_DESK_OBJECT_ID = ObjectIdentifiers.STUDY_DESK_8; // 18224, Mayor's house

  // Runic altars (same ids the Runecrafting plugin uses).
  const ALTAR_BY_OBJECT = new Map([
    [ObjectIdentifiers.ALTAR_33, { blank: BLANK_AIR_RUNE_ITEM_ID, complete: AIR_RUNE_ITEM_ID, variant: "crafting-the-runes-enchanting-the-air-rune" }],
    [ObjectIdentifiers.ALTAR_34, { blank: BLANK_MIND_RUNE_ITEM_ID, complete: MIND_RUNE_ITEM_ID, variant: "crafting-the-runes-enchanting-the-mind-rune" }],
    // The dump has no water-rune enchanting variant; its success uses the
    // formulaic line its siblings share (noted in the header gaps).
    [ObjectIdentifiers.ALTAR_35, { blank: BLANK_WATER_RUNE_ITEM_ID, complete: WATER_RUNE_ITEM_ID, variant: null, message: "You manage to empower the required water rune." }],
    [ObjectIdentifiers.ALTAR_36, { blank: BLANK_EARTH_RUNE_ITEM_ID, complete: EARTH_RUNE_ITEM_ID, variant: "crafting-the-runes-enchanting-the-earth-rune" }],
    [ObjectIdentifiers.ALTAR_37, { blank: BLANK_FIRE_RUNE_ITEM_ID, complete: FIRE_RUNE_ITEM_ID, variant: "crafting-the-runes-enchanting-the-fire-rune" }],
  ]);

  const OLD_RUIN_ENTRANCE_TILE = { x: 2696, y: 3283, z: 0 };
  const DUNGEON_ENTRY_TILE = { x: 2323, y: 5104, z: 0 };
  const DUNGEON_EXIT_TILE = { x: 2315, y: 5098, z: 0 };
  const SURFACE_LANDING_TILE = { x: 2697, y: 3283, z: 0 };
  const DEAD_SLUG_TILE = { x: 2334, y: 5093, z: 0 };
  const PRINCE_TILE = { x: 2336, y: 5093, z: 0 };
  const FALADOR_PARK_TILE = { x: 2997, y: 3375, z: 0 };
  const PLATFORM_TILE = { x: 2784, y: 3276, z: 0 };
  const SHORE_TILE = { x: 2720, y: 3305, z: 0 };
  const PLATFORM_MIN_X = 2750;

  const DOOR_ZONE = { minX: 2328, maxX: 2354, minY: 5086, maxY: 5100, levels: [0] };
  const DOOR_SCAN_RADIUS = 12;

  // Stages.
  const STAGE_NOT_STARTED = 0;
  const STAGE_STARTED = 1;
  const STAGE_BRIEFED = 2;
  const STAGE_INVESTIGATED = 3;
  const STAGE_REPORTED = 4;
  const STAGE_DOOR_SCANNED = 5;
  const STAGE_JORRAL_TRANSLATED = 6;
  const STAGE_SAVANT_INFO = 7;
  const STAGE_MALEDICT_PAGES = 8;
  const STAGE_PAGES_GATHERED = 9;
  const STAGE_PASTE_REFUSED = 10;
  const STAGE_GLUE_OBTAINED = 11;
  const STAGE_FRAGMENTS_JOINED = 12;
  const STAGE_PRINCE_KILLED = 13;
  const STAGE_COMPLETE = 14;

  // Transcript variants on the "The Slug Menace" page.
  const V_TIFFY_NO_REQS = "starting-off-talking-to-sir-tiffy-cashien-without-the-requirements";
  const V_TIFFY_START = "starting-off-talking-to-sir-tiffy-cashien-to-start-the-quest";
  const V_TIFFY_LOST_ORB = "starting-off-talking-to-sir-tiffy-cashien-after-losing-the-commorb";
  const V_TIFFY_STARTED = "starting-off-talking-to-sir-tiffy-cashien-after-starting-the-quest";
  const V_TIFFY_COMPLETE =
    "the-imposing-door-talking-to-sir-tiffy-cashien-after-killing-the-slug-prince";
  const V_TIFFY_POST = "after-slug-menace";
  const V_COMMORB_CONTACT = "starting-off-contact-with-commorb-v2";
  const V_COMMORB_PLAYBACK = "starting-off-playback-with-commorb-v2";
  const V_HOBB = "witchaven-talking-to-mayor-hobb";
  const V_HOBB_2 = "witchaven-talking-to-mayor-hobb-2";
  const V_HOBB_AGAIN = "witchaven-talking-to-mayor-hobb-again";
  const V_MALEDICT = "witchaven-talking-to-brother-maledict";
  const V_MALEDICT_2 = "witchaven-talking-to-brother-maledict-2";
  const V_MALEDICT_AGAIN = "witchaven-talking-to-brother-maledict-again";
  const V_MALEDICT_PAGES = "the-pages-talking-to-maledict-after-learning-about-mother-mallum";
  const V_MALEDICT_PAGES_AGAIN = "the-pages-talking-to-brother-maledict-again";
  const V_ONIALL_INTRO = "witchaven-talking-to-col-o-niall";
  const V_ONIALL_QUESTIONS = "witchaven-talking-to-col-o-niall-before-getting-all-the-information";
  const V_ONIALL_REPORT = "witchaven-talking-to-col-o-niall-after-talking-to-mayor-hobb";
  const V_ONIALL_MOTHER = "the-pages-talking-to-col-o-niall-after-learning-abotu-mother-mallum";
  const V_ONIALL_AGAIN = "the-pages-talking-to-col-o-niall-again";
  const V_ONIALL_FINAL_PAGE = "the-pages-talking-to-col-o-niall-while-looking-for-the-final-page";
  const V_ONIALL_LOST_ORB = "crafting-the-runes-talking-to-col-o-niall-after-losing-the-commorb";
  const V_JEB = "witchaven-talking-to-jeb";
  const V_JEB_BOAT = "witchaven-talking-to-jeb-after-holgart-says-to-ask-him-about-a-boat";
  const V_JEB_PLATFORM = "witchaven-talking-to-jeb-at-the-fishing-platform";
  const V_HOLGART = "witchaven-talking-to-holgart";
  const V_HOLGART_AGAIN = "witchaven-talking-to-holgart-again";
  const V_BAILEY = "witchaven-talking-to-bailey-at-the-fishing-platform";
  const V_BAILEY_GLUE = "the-pages-talking-to-bailey-after-learning-about-the-glue";
  const V_WALL_BEFORE = "the-shrine-attempting-to-push-the-wall-before-talking-about-the-shrine";
  const V_WALL_NO_ORB = "the-shrine-pushing-the-wall-without-the-commorb";
  const V_PASSAGE_NO_ORB = "the-shrine-attempting-to-enter-the-open-wall-without-the-commorb";
  const V_COMMORB_BEFORE_SCAN = "the-shrine-contacting-commorb-before-scanning-the-shrine";
  const V_SCAN_WRONG = "the-shrine-scanning-the-commorb-in-the-wrong-place";
  const V_SCAN_COMBAT = "the-shrine-scanning-the-commorb-while-in-combat";
  const V_SCAN_ASK = "the-shrine-scanning-the-commorb-near-the-door";
  const V_SCAN_RESULT = "the-shrine-scanning-commorb-near-the-door";
  const V_DOOR_ATTEMPT = "the-shrine-attempting-to-open-the-door";
  const V_DOOR_NO_ORB = "the-shrine-approaching-door-without-commorb";
  const V_COMMORB_AFTER_SCAN = "the-shrine-contacting-the-commorb-after-scanning-the-doors";
  const V_COMMORB_LOST_TRANSCRIPTION =
    "the-shrine-contacting-commorb-after-losing-door-transcription";
  const V_JORRAL = "the-pages-talking-to-jorral";
  const V_SAVANT_AFTER_JORRAL = "the-pages-after-talking-to-jorral";
  const V_COMMORB_MOTHER = "the-pages-contacting-the-commorb-after-learning-about-mother-mallum";
  const V_DESK = "the-pages-opening-maledict-s-desk";
  const V_EZEKIAL = "the-pages-talking-to-ezekial-lovecraft-after-brother-maledict-asks-about-the-pages";
  const V_PASTE = "the-pages-using-swamp-paste-on-the-pages";
  const V_SHAPE = "crafting-the-runes-shaping-a-rune";
  const V_ENCHANT_FAIL = "crafting-the-runes-failing-to-enchant-a-rune";
  const V_DOOR_RUNES_NO_ORB = "the-imposing-door-opening-the-door-without-the-commorb";
  const V_DOOR_OPEN = "the-imposing-door-opening-the-door-with-the-runes-and-commorb";
  const V_DOOR_FIGHT = "the-imposing-door-reentering-the-fight";
  const V_DOOR_KILLED = "the-imposing-door-after-killing-the-slug-prince";
  const V_VILLAGER_PRE = "pre-quest-dialogue";
  const V_VILLAGER_POST = "post-quest-dialogue";

  const START_HOOK = "quest:the-slug-menace:start";

  // Prose condition step ids.
  const COND_NO_ORB = "QCYHeQ";
  const COND_HAS_ORB = "Z3OYJz";
  const COND_NO_SPACE_ORB = "qD7fRj";
  const COND_SPACE_ORB = "M3YJU2";
  const COND_NO_SPACE_SCAN = "NBrQCq";
  const COND_NO_SPACE_TRANSCRIPTION = "vfZW8h";
  const COND_NO_TRANSCRIPTION = "5dYBrz";
  const COND_NO_SPACE_DESK = "dEd0U2";
  const COND_NO_SPACE_EZEKIAL = "efYvu4";
  const COND_NO_SPACE_FRAGMENTS = "X95XqV";
  const COND_NO_SLUG = "xSBg2p";
  const COND_NO_CHISEL = "oj0WZU";
  const COND_NO_ESSENCE = "7GC2LN";
  const COND_SHAPE_FAIL = "3Dotry";
  const COND_SHAPE_SUCCESS = "ypS1Qi";

  // Action / message step ids.
  const MSG_TRAVEL_PLATFORM = "dEwoRO"; // "You arrive at the fishing platform."
  const MSG_TRAVEL_SHORE = "j6g4Cr"; // "The boat arrives at Witchaven."
  const MSG_WALL_OPENED = "BlbTdL"; // "The wall creaks open to reveal a hidden entrance!"
  const ACTION_RECEIVE_TRANSCRIPTION = "3Tep8t"; // receive "Door transcription"
  const MSG_DESK_PAGE = "4vSdlY"; // "You open the locked  drawer..."
  const ACTION_SHAPE_FAIL = "IE1248"; // "...destroying the essence."
  const ACTION_SHAPE_SUCCESS = "0thYWr"; // "You managed to shape the rune essence..."
  const ACTION_COMPLETE = "YMQ0V4"; // "Congratulations! Quest complete!"

  const MSG_SAVANT_TRANSCRIPTION =
    "I have added a transcript of the runes into your pack.";
  const MSG_EZEKIAL_PAGE = "Sure, here you go.";
  const MSG_ONIALL_FRAGMENTS =
    "It has been torn into three pieces. You will need to stick them back together before you can use them.";
  const MSG_BAILEY_GLUE = "That should do the trick.";
  const MSG_TIFFY_ORB = "Here, take another, but be careful of this one!";
  const MSG_ONIALL_ORB = "Here, take another, but be careful with this one!";
  const MSG_JORRAL_GOODBYE = "Uh, right. Goodbye.";
  const MSG_PRINCE_REVEAL = "Sadly for you, this will be the last thing you ever see.";
  const MSG_TELL_TIFFY = "I think you'd better talk to Sir Tiffy about this.";
  const GLUE_JOINED_MESSAGE =
    "You glue the fragments of the page back together."; // no transcript exists for the puzzle

  // Persisted attributes (varps are not saved; attributes are).
  const TRACKS_ATTRIBUTE = "quest.the_slug_menace.tracks";
  const USED_RUNES_ATTRIBUTE = "quest.the_slug_menace.used-runes";
  const WALL_OPEN_ATTRIBUTE = "quest.the_slug_menace.wall-open";
  const DOOR_REVEALED_ATTRIBUTE = "quest.the_slug_menace.door-revealed";
  const MALEDICT_ASKED_ATTRIBUTE = "quest.the_slug_menace.maledict-asked";
  const TRACK_HOLGART = 1 << 0;
  const TRACK_HOBB = 1 << 1;
  const TRACK_MALEDICT = 1 << 2;
  const ALL_TRACKS = TRACK_HOLGART | TRACK_HOBB | TRACK_MALEDICT;

  const WANTED_QUEST_KEY = "wanted";
  const SEA_SLUG_QUEST_KEY = "sea_slug";
  const DEVIOUS_MINDS_QUEST_KEY = "devious_minds";
  const CRAFTING_LEVEL = 30;
  const RUNECRAFT_LEVEL = 30;
  const SLAYER_LEVEL = 30;
  const THIEVING_LEVEL = 30;

  let quest;
  let groundItems;
  const pendingShape = new WeakMap();
  const princeByPlayer = new Map();
  const promptedDoorScan = new Set();

  const held = (player, itemId, amount = 1) => player.getInventory().getAmount(itemId) >= amount;
  const heldAny = (player, itemIds) => [...itemIds].some((itemId) => held(player, itemId));
  const hasChisel = (player) => [...CHISEL_ITEM_IDS].some((itemId) => held(player, itemId));
  const hasAnyCommorb = (player) =>
    held(player, COMMORB_ITEM_ID) || held(player, COMMORB_V2_ITEM_ID);
  const hasFragments = (player) => heldAny(player, FRAGMENT_ITEM_IDS);
  const hasJoinedPage = (player) => held(player, PAGE_3_ITEM_ID) || quest.getStage(player) >= STAGE_FRAGMENTS_JOINED;

  function essenceAmount(player) {
    return (
      player.getInventory().getAmount(RUNE_ESSENCE_ITEM_ID) +
      player.getInventory().getAmount(PURE_ESSENCE_ITEM_ID)
    );
  }

  function consumeEssence(player) {
    if (held(player, RUNE_ESSENCE_ITEM_ID)) {
      player.getInventory().deleteNumber(RUNE_ESSENCE_ITEM_ID, 1);
    } else if (held(player, PURE_ESSENCE_ITEM_ID)) {
      player.getInventory().deleteNumber(PURE_ESSENCE_ITEM_ID, 1);
    }
  }

  function questComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function questActive(player, key) {
    const request = { player, key, started: false };
    api.emitCustomEvent("quest:is-started", request);
    return request.started === true && !questComplete(player, key);
  }

  function meetsSkillRequirements(player) {
    const skills = player.getSkillManager();
    // The Wiki marks all four as not boostable, so check the base level.
    return (
      skills.getMaxLevel(Skill.CRAFTING) >= CRAFTING_LEVEL &&
      skills.getMaxLevel(Skill.RUNECRAFTING) >= RUNECRAFT_LEVEL &&
      skills.getMaxLevel(Skill.SLAYER) >= SLAYER_LEVEL &&
      skills.getMaxLevel(Skill.THIEVING) >= THIEVING_LEVEL
    );
  }

  function meetsQuestRequirements(player) {
    return questComplete(player, WANTED_QUEST_KEY) && questComplete(player, SEA_SLUG_QUEST_KEY);
  }

  function canStart(player) {
    return meetsQuestRequirements(player) && meetsSkillRequirements(player) && hasAnyCommorb(player);
  }

  function getTracks(player) {
    return Number(player.getAttribute(TRACKS_ATTRIBUTE)) || 0;
  }

  function trackSet(player, bit) {
    return (getTracks(player) & bit) !== 0;
  }

  function setTrack(player, bit) {
    const tracks = getTracks(player) | bit;
    player.setAttribute(TRACKS_ATTRIBUTE, tracks);
    sendTrackVarps(player);
    if (tracks === ALL_TRACKS && quest.getStage(player) === STAGE_BRIEFED) {
      quest.setStage(player, STAGE_INVESTIGATED);
    }
  }

  function allTracks(player) {
    return (getTracks(player) & ALL_TRACKS) === ALL_TRACKS;
  }

  function getUsedRunes(player) {
    return Number(player.getAttribute(USED_RUNES_ATTRIBUTE)) || 0;
  }

  function wallOpen(player) {
    return Number(player.getAttribute(WALL_OPEN_ATTRIBUTE)) === 1;
  }

  function doorRevealed(player) {
    return Number(player.getAttribute(DOOR_REVEALED_ATTRIBUTE)) === 1;
  }

  function maledictAsked(player) {
    return Number(player.getAttribute(MALEDICT_ASKED_ATTRIBUTE)) === 1;
  }

  function sendTrackVarps(player) {
    const sender = player.getPacketSender();
    sender.sendVarbit(VARBIT_TRACK_1, trackSet(player, TRACK_HOLGART) ? 1 : 0);
    sender.sendVarbit(VARBIT_TRACK_2, trackSet(player, TRACK_HOBB) ? 1 : 0);
    sender.sendVarbit(VARBIT_TRACK_3, trackSet(player, TRACK_MALEDICT) ? 1 : 0);
  }

  /** Re-send every sub-varbit the client reads; the login bootstrap clobbers varps. */
  function sendSlugVarps(player) {
    const sender = player.getPacketSender();
    const stage = quest.getStage(player);
    sender.sendVarbit(VARBIT_FIXED_PAGE, stage >= STAGE_FRAGMENTS_JOINED ? 1 : 0);
    sender.sendVarbit(VARBIT_SAVANT_GOTINFO, stage >= STAGE_SAVANT_INFO ? 1 : 0);
    sender.sendVarbit(VARBIT_SAVANT_SCAN, stage >= STAGE_DOOR_SCANNED ? 1 : 0);
    sender.sendVarbit(VARBIT_DOORBIT, wallOpen(player) ? 1 : 0);
    sender.sendVarbit(VARBIT_TORNPAGES, hasFragments(player) ? 1 : 0);
    sender.sendVarbit(VARBIT_DOORSCAN, stage >= STAGE_DOOR_SCANNED ? 1 : 0);
    sender.sendVarbit(VARBIT_HAVESLUG, held(player, DEAD_SEA_SLUG_ITEM_ID) ? 1 : 0);
    for (const [itemId, varbit] of RUNE_VARBIT_BY_ITEM) {
      const used = (getUsedRunes(player) & RUNE_BIT_BY_ITEM.get(itemId)) !== 0;
      sender.sendVarbit(varbit, used ? 1 : 0);
    }
    sendTrackVarps(player);
  }

  function isTile(location, tile) {
    if (!location) return false;
    const x = location.getX?.() ?? location.x;
    const y = location.getY?.() ?? location.y;
    const z = location.getZ?.() ?? location.z;
    return Number(x) === tile.x && Number(y) === tile.y && Number(z) === tile.z;
  }

  function nearImposingDoors(player) {
    const location = player.getLocation();
    if (location.getZ() !== 0) return false;
    const dx = Math.abs(location.getX() - 2348);
    const dy = Math.abs(location.getY() - 5093);
    return Math.max(dx, dy) <= DOOR_SCAN_RADIUS;
  }

  function inCombat(player) {
    return player.getCombat?.()?.getTarget?.() != null;
  }

  function shapeChance(player) {
    const level = Math.max(1, Math.min(99, player.getSkillManager().getCurrentLevel(Skill.RUNECRAFTING)));
    return Math.min(0.99, 0.43 + ((level - 1) * 0.56) / 98);
  }

  function teleport(player, tile) {
    player.moveTo(new Location(tile.x, tile.y, tile.z));
  }

  function ensurePrince(player) {
    if (princeByPlayer.has(player)) return;
    if (quest.getStage(player) >= STAGE_PRINCE_KILLED || quest.isComplete(player)) return;
    const npc = api.spawnNpc({
      id: NpcIdentifiers.SLUG_PRINCE,
      x: PRINCE_TILE.x,
      y: PRINCE_TILE.y,
      z: PRINCE_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) princeByPlayer.set(player, npc);
  }

  function clearPrince(player) {
    const npc = princeByPlayer.get(player);
    if (npc) {
      api.removeNpc(npc);
      princeByPlayer.delete(player);
    }
  }

  function syncDeadSlug(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_REPORTED || stage >= STAGE_FRAGMENTS_JOINED) return;
    if (held(player, DEAD_SEA_SLUG_ITEM_ID) || held(player, SEA_SLUG_GLUE_ITEM_ID)) return;
    if (quest.isComplete(player)) return;
    const position = new Location(DEAD_SLUG_TILE.x, DEAD_SLUG_TILE.y, DEAD_SLUG_TILE.z);
    const existing = groundItems.getGroundItem(
      player.getUsername(),
      DEAD_SEA_SLUG_ITEM_ID,
      position,
      player.getPrivateArea()
    );
    if (!existing) groundItems.registerLocation(player, new Item(DEAD_SEA_SLUG_ITEM_ID, 1), position);
  }

  // ==========================================================================
  // Variant selection
  // ==========================================================================

  function tiffyVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return { page: TIFFY_PAGE, variant: V_TIFFY_POST };
    if (stage === STAGE_NOT_STARTED) {
      if (questActive(player, DEVIOUS_MINDS_QUEST_KEY)) return null;
      if (!meetsQuestRequirements(player)) return null;
      return canStart(player) ? V_TIFFY_START : V_TIFFY_NO_REQS;
    }
    if (stage >= STAGE_PRINCE_KILLED) return V_TIFFY_COMPLETE;
    if (!hasAnyCommorb(player)) return V_TIFFY_LOST_ORB;
    return V_TIFFY_STARTED;
  }

  function oniallVariant(player) {
    const stage = quest.getStage(player);
    if (quest.isComplete(player) || !quest.isStarted(player)) return V_ONIALL_INTRO;
    if (!hasAnyCommorb(player)) return V_ONIALL_LOST_ORB;
    if (stage === STAGE_STARTED) {
      quest.setStage(player, STAGE_BRIEFED);
      if (allTracks(player)) quest.setStage(player, STAGE_INVESTIGATED);
      return V_ONIALL_INTRO;
    }
    if (stage <= STAGE_INVESTIGATED) {
      if (allTracks(player)) {
        quest.setStage(player, STAGE_REPORTED);
        return V_ONIALL_REPORT;
      }
      return V_ONIALL_QUESTIONS;
    }
    if (stage <= STAGE_JORRAL_TRANSLATED) return V_ONIALL_QUESTIONS;
    if (stage === STAGE_SAVANT_INFO) {
      quest.setStage(player, STAGE_MALEDICT_PAGES);
      return V_ONIALL_MOTHER;
    }
    if (stage < STAGE_PRINCE_KILLED && !hasJoinedPage(player) && !hasFragments(player)) {
      return V_ONIALL_FINAL_PAGE;
    }
    return V_ONIALL_AGAIN;
  }

  function hobbVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_BRIEFED) return V_HOBB;
    if (stage >= STAGE_INVESTIGATED) return V_HOBB_AGAIN;
    if (trackSet(player, TRACK_HOBB)) return V_HOBB_AGAIN;
    setTrack(player, TRACK_HOBB);
    return V_HOBB_2;
  }

  function maledictVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_MALEDICT_PAGES) {
      if (!maledictAsked(player)) {
        player.setAttribute(MALEDICT_ASKED_ATTRIBUTE, 1);
        return V_MALEDICT_PAGES;
      }
      return V_MALEDICT_PAGES_AGAIN;
    }
    if (stage < STAGE_BRIEFED) return V_MALEDICT;
    if (stage >= STAGE_INVESTIGATED) return V_MALEDICT_AGAIN;
    if (trackSet(player, TRACK_MALEDICT)) return V_MALEDICT_AGAIN;
    setTrack(player, TRACK_MALEDICT);
    return V_MALEDICT_2;
  }

  function jebVariant(player) {
    if (!quest.isStarted(player) || quest.isComplete(player)) return V_JEB;
    const location = player.getLocation();
    if (location.getX() >= PLATFORM_MIN_X && location.getZ() <= 1) return V_JEB_PLATFORM;
    return V_JEB_BOAT;
  }

  function jorralVariant(player) {
    const stage = quest.getStage(player);
    if (stage !== STAGE_DOOR_SCANNED && stage !== STAGE_JORRAL_TRANSLATED) return null;
    if (stage === STAGE_DOOR_SCANNED) quest.setStage(player, STAGE_JORRAL_TRANSLATED);
    return V_JORRAL;
  }

  function ezekialVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_MALEDICT_PAGES || stage >= STAGE_FRAGMENTS_JOINED) return null;
    if (held(player, PAGE_2_ITEM_ID) || held(player, PAGE_3_ITEM_ID)) return null;
    return V_EZEKIAL;
  }

  function selectVariant({ npcId, player }) {
    if (!player) return null;
    if (SIR_TIFFY_NPC_IDS.has(npcId)) return tiffyVariant(player);
    if (COL_ONIALL_NPC_IDS.has(npcId)) return oniallVariant(player);
    if (MAYOR_HOBB_NPC_IDS.has(npcId)) return hobbVariant(player);
    if (BROTHER_MALEDICT_NPC_IDS.has(npcId)) return maledictVariant(player);
    if (JEB_NPC_IDS.has(npcId)) return jebVariant(player);
    if (VILLAGER_NPC_IDS.has(npcId)) {
      return quest.isComplete(player) ? V_VILLAGER_POST : V_VILLAGER_PRE;
    }
    if (npcId === JORRAL_NPC_ID) return jorralVariant(player);
    if (npcId === EZEKIAL_NPC_ID) return ezekialVariant(player);
    return null;
  }

  // ==========================================================================
  // Prose conditions
  // ==========================================================================

  function answerCondition({ player, stepId }) {
    if (!player) return null;
    const inventory = player.getInventory();
    if (stepId === COND_NO_ORB) return !hasAnyCommorb(player);
    if (stepId === COND_HAS_ORB) return hasAnyCommorb(player);
    if (stepId === COND_NO_SPACE_ORB) return inventory.isFull();
    if (stepId === COND_SPACE_ORB) return !inventory.isFull();
    if (stepId === COND_NO_SPACE_SCAN) return inventory.isFull() && !held(player, DOOR_TRANSCRIPTION_ITEM_ID);
    if (stepId === COND_NO_SPACE_TRANSCRIPTION) return inventory.isFull();
    if (stepId === COND_NO_TRANSCRIPTION) return !held(player, DOOR_TRANSCRIPTION_ITEM_ID);
    if (stepId === COND_NO_SPACE_DESK) return inventory.isFull();
    if (stepId === COND_NO_SPACE_EZEKIAL) return inventory.isFull();
    if (stepId === COND_NO_SPACE_FRAGMENTS) return inventory.getFreeSlots() < 3;
    if (stepId === COND_NO_SLUG) return !held(player, DEAD_SEA_SLUG_ITEM_ID);
    if (stepId === COND_NO_CHISEL) return !hasChisel(player);
    if (stepId === COND_NO_ESSENCE) return essenceAmount(player) === 0;
    if (stepId === COND_SHAPE_FAIL) {
      const shape = pendingShape.get(player);
      return shape ? !shape.success : false;
    }
    if (stepId === COND_SHAPE_SUCCESS) {
      const shape = pendingShape.get(player);
      return shape ? shape.success : false;
    }
    return null;
  }

  // ==========================================================================
  // Dialogue side effects
  // ==========================================================================

  function handleStartHook(event) {
    const { player, npcId, hook } = event;
    if (!player || hook !== START_HOOK || !SIR_TIFFY_NPC_IDS.has(npcId)) return;
    if (quest.getStage(player) !== STAGE_NOT_STARTED) return;
    if (!canStart(player)) return;
    quest.setStage(player, STAGE_STARTED);
  }

  function handleChosenCondition({ player, npcId, stepId }) {
    if (!player) return;
    if (stepId === COND_HAS_ORB && SIR_TIFFY_NPC_IDS.has(npcId)) {
      if (held(player, COMMORB_ITEM_ID)) {
        player.getInventory().deleteNumber(COMMORB_ITEM_ID, 1);
        if (!held(player, COMMORB_V2_ITEM_ID)) player.getInventory().adds(COMMORB_V2_ITEM_ID, 1);
      }
      return;
    }
    if (stepId === COND_SPACE_ORB && SIR_TIFFY_NPC_IDS.has(npcId) && !hasAnyCommorb(player)) {
      player.getInventory().adds(COMMORB_V2_ITEM_ID, 1);
    }
  }

  function handleDialogueAction(event) {
    const { player, npcId, stepId } = event;
    if (!player || typeof stepId !== "string") return;
    if (stepId === MSG_TRAVEL_PLATFORM) {
      setTrack(player, TRACK_HOLGART);
      teleport(player, PLATFORM_TILE);
      return;
    }
    if (stepId === MSG_TRAVEL_SHORE) {
      teleport(player, SHORE_TILE);
      return;
    }
    if (stepId === MSG_WALL_OPENED) {
      openShrineWall(player);
      return;
    }
    if (stepId === ACTION_RECEIVE_TRANSCRIPTION) {
      event.handled = true;
      if (!held(player, DOOR_TRANSCRIPTION_ITEM_ID) && !player.getInventory().isFull()) {
        player.getInventory().adds(DOOR_TRANSCRIPTION_ITEM_ID, 1);
      }
      if (quest.getStage(player) === STAGE_REPORTED) quest.setStage(player, STAGE_DOOR_SCANNED);
      return;
    }
    if (stepId === MSG_DESK_PAGE) {
      if (
        quest.getStage(player) >= STAGE_MALEDICT_PAGES &&
        quest.getStage(player) < STAGE_FRAGMENTS_JOINED &&
        !held(player, PAGE_1_ITEM_ID) &&
        !player.getInventory().isFull()
      ) {
        player.getInventory().adds(PAGE_1_ITEM_ID, 1);
      }
      return;
    }
    if (stepId === ACTION_SHAPE_FAIL) {
      consumeEssence(player);
      pendingShape.delete(player);
      return;
    }
    if (stepId === ACTION_SHAPE_SUCCESS) {
      const shape = pendingShape.get(player);
      consumeEssence(player);
      if (shape && !player.getInventory().isFull()) player.getInventory().adds(shape.blank, 1);
      pendingShape.delete(player);
      return;
    }
    if (stepId === ACTION_COMPLETE) {
      event.handled = true;
      event.end = true;
      if (SIR_TIFFY_NPC_IDS.has(npcId) && quest.getStage(player) >= STAGE_PRINCE_KILLED) {
        quest.complete(player);
      }
    }
  }

  function handleDialogueLine(event) {
    const { player, npcId, text } = event;
    if (!player || typeof text !== "string") return;
    if (text === MSG_SAVANT_TRANSCRIPTION) {
      if (!held(player, DOOR_TRANSCRIPTION_ITEM_ID) && !player.getInventory().isFull()) {
        player.getInventory().adds(DOOR_TRANSCRIPTION_ITEM_ID, 1);
      }
      if (quest.getStage(player) === STAGE_REPORTED) quest.setStage(player, STAGE_DOOR_SCANNED);
      return;
    }
    if (npcId === EZEKIAL_NPC_ID && text === MSG_EZEKIAL_PAGE) {
      if (
        quest.getStage(player) >= STAGE_MALEDICT_PAGES &&
        quest.getStage(player) < STAGE_FRAGMENTS_JOINED &&
        !held(player, PAGE_2_ITEM_ID) &&
        !held(player, PAGE_3_ITEM_ID) &&
        player.getInventory().getFreeSlots() >= 1
      ) {
        player.getInventory().adds(PAGE_2_ITEM_ID, 1);
      }
      return;
    }
    if (COL_ONIALL_NPC_IDS.has(npcId) && text === MSG_ONIALL_FRAGMENTS) {
      if (
        quest.getStage(player) >= STAGE_MALEDICT_PAGES &&
        quest.getStage(player) < STAGE_FRAGMENTS_JOINED &&
        !hasFragments(player) &&
        !held(player, PAGE_3_ITEM_ID) &&
        player.getInventory().getFreeSlots() >= 3
      ) {
        player.getInventory().adds(FRAGMENT_1_ITEM_ID, 1);
        player.getInventory().adds(FRAGMENT_2_ITEM_ID, 1);
        player.getInventory().adds(FRAGMENT_3_ITEM_ID, 1);
        quest.setStage(player, STAGE_PAGES_GATHERED);
        player.getPacketSender().sendVarbit(VARBIT_TORNPAGES, 1);
      }
      return;
    }
    if (npcId === NpcIdentifiers.BAILEY && text === MSG_BAILEY_GLUE) {
      if (quest.getStage(player) === STAGE_PASTE_REFUSED && held(player, DEAD_SEA_SLUG_ITEM_ID)) {
        player.getInventory().deleteNumber(DEAD_SEA_SLUG_ITEM_ID, 1);
        player.getInventory().adds(SEA_SLUG_GLUE_ITEM_ID, 1);
        quest.setStage(player, STAGE_GLUE_OBTAINED);
        player.getPacketSender().sendVarbit(VARBIT_HAVESLUG, 0);
      }
      return;
    }
    if (text.includes(MSG_TIFFY_ORB) && SIR_TIFFY_NPC_IDS.has(npcId)) {
      grantReplacementCommorb(player);
      return;
    }
    if (text.includes(MSG_ONIALL_ORB) && COL_ONIALL_NPC_IDS.has(npcId)) {
      grantReplacementCommorb(player);
      return;
    }
    if (npcId === JORRAL_NPC_ID && text === MSG_JORRAL_GOODBYE) {
      armSavantReveal(player);
      return;
    }
    if (MAYOR_HOBB_NPC_IDS.has(npcId) && text === MSG_PRINCE_REVEAL) {
      ensurePrince(player);
      return;
    }
    if (MAYOR_HOBB_NPC_IDS.has(npcId) && text === MSG_TELL_TIFFY) {
      waitForChatbox(player, () => teleport(player, FALADOR_PARK_TILE));
    }
  }

  function grantReplacementCommorb(player) {
    if (quest.getStage(player) === STAGE_NOT_STARTED || quest.isComplete(player)) return;
    if (!hasAnyCommorb(player)) player.getInventory().adds(COMMORB_V2_ITEM_ID, 1);
  }

  // ==========================================================================
  // Commorb v2
  // ==========================================================================

  function handleCommorbScan(player) {
    if (!quest.isStarted(player) || quest.isComplete(player)) return;
    if (inCombat(player)) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SCAN_COMBAT);
      return;
    }
    const stage = quest.getStage(player);
    if (nearImposingDoors(player)) {
      if (stage === STAGE_REPORTED || stage === STAGE_DOOR_SCANNED) {
        startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SCAN_RESULT);
        return;
      }
    }
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SCAN_WRONG);
  }

  function handleCommorbContact(player) {
    if (!quest.isStarted(player) || quest.isComplete(player)) return;
    const stage = quest.getStage(player);
    if (stage === STAGE_STARTED) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_COMMORB_CONTACT);
      return;
    }
    if (stage <= STAGE_REPORTED) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_COMMORB_BEFORE_SCAN);
      return;
    }
    if (stage === STAGE_DOOR_SCANNED) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_COMMORB_AFTER_SCAN);
      return;
    }
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_COMMORB_MOTHER);
  }

  function handleCommorbPlayback(player) {
    if (!quest.isStarted(player) || quest.isComplete(player)) return;
    if (
      quest.getStage(player) >= STAGE_DOOR_SCANNED &&
      !held(player, DOOR_TRANSCRIPTION_ITEM_ID)
    ) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_COMMORB_LOST_TRANSCRIPTION);
      return;
    }
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_COMMORB_PLAYBACK);
  }

  function handleItemAction(event) {
    const { player, itemId, option } = event;
    if (!player) return;
    if (itemId === COMMORB_V2_ITEM_ID) {
      const action = String(option ?? "").toLowerCase();
      if (action.includes("scan")) {
        event.handled = true;
        handleCommorbScan(player);
        return;
      }
      if (action.includes("contact")) {
        event.handled = true;
        handleCommorbContact(player);
        return;
      }
      if (action.includes("playback")) {
        event.handled = true;
        handleCommorbPlayback(player);
      }
      return;
    }
    if (!PAGE_ITEM_IDS.has(itemId)) return;
    const shape = shapeForOption(option);
    if (!shape) return;
    if (quest.getStage(player) < STAGE_FRAGMENTS_JOINED || quest.isComplete(player)) return;
    event.handled = true;
    pendingShape.set(player, { blank: shape, success: Math.random() < shapeChance(player) });
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SHAPE);
  }

  function shapeForOption(option) {
    const value = String(option ?? "").toLowerCase();
    if (value === "shape-air") return BLANK_AIR_RUNE_ITEM_ID;
    if (value === "shape-water") return BLANK_WATER_RUNE_ITEM_ID;
    if (value === "shape-earth") return BLANK_EARTH_RUNE_ITEM_ID;
    if (value === "shape-fire") return BLANK_FIRE_RUNE_ITEM_ID;
    if (value === "shape-mind") return BLANK_MIND_RUNE_ITEM_ID;
    return null;
  }

  // ==========================================================================
  // Items on objects and each other
  // ==========================================================================

  function handleItemOnObject(event) {
    const { player, itemId, objectId } = event;
    if (!player) return;
    const altar = ALTAR_BY_OBJECT.get(objectId);
    if (altar && itemId === altar.blank) {
      event.handled = true;
      if (!quest.isStarted(player) || quest.isComplete(player)) return;
      player.getInventory().deleteNumber(altar.blank, 1);
      if (Math.random() < shapeChance(player)) {
        player.getInventory().adds(altar.complete, 1);
        if (altar.variant) {
          startTranscript(api, player, SAVANT_NPC_ID, PAGE, altar.variant);
        } else {
          player.sendMessage(altar.message);
        }
      } else {
        startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_ENCHANT_FAIL);
      }
      return;
    }
    if (IMPOSING_DOOR_OBJECT_IDS.has(objectId) && COMPLETE_RUNE_ITEM_IDS.has(itemId)) {
      event.handled = true;
      useRuneOnDoor(player, itemId);
    }
  }

  function useRuneOnDoor(player, itemId) {
    if (quest.getStage(player) < STAGE_FRAGMENTS_JOINED || quest.isComplete(player)) return;
    if (!hasAnyCommorb(player)) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_DOOR_RUNES_NO_ORB);
      return;
    }
    const bit = RUNE_BIT_BY_ITEM.get(itemId);
    if (bit === undefined) return;
    if ((getUsedRunes(player) & bit) !== 0) return;
    player.getInventory().deleteNumber(itemId, 1);
    const used = getUsedRunes(player) | bit;
    player.setAttribute(USED_RUNES_ATTRIBUTE, used);
    const varbit = RUNE_VARBIT_BY_ITEM.get(itemId);
    if (varbit !== undefined) player.getPacketSender().sendVarbit(varbit, 1);
    if ((used & ALL_RUNES_USED) === ALL_RUNES_USED) openImposingDoor(player);
  }

  function openImposingDoor(player) {
    if (doorRevealed(player)) {
      ensurePrince(player);
      startTranscript(api, player, MAYOR_HOBB_NPC_ID, PAGE, V_DOOR_FIGHT);
      return;
    }
    player.setAttribute(DOOR_REVEALED_ATTRIBUTE, 1);
    player.getPacketSender().sendVarbit(VARBIT_DOORSCAN, 1);
    startTranscript(api, player, MAYOR_HOBB_NPC_ID, PAGE, V_DOOR_OPEN);
  }

  function handleItemOnItem(event) {
    const { player, usedItemId, usedWithItemId } = event;
    if (!player) return;
    const pairs = [
      [usedItemId, usedWithItemId],
      [usedWithItemId, usedItemId],
    ];
    for (const [itemId, otherId] of pairs) {
      if (itemId === SWAMP_PASTE_ITEM_ID && FRAGMENT_ITEM_IDS.has(otherId)) {
        const stage = quest.getStage(player);
        if (stage < STAGE_PAGES_GATHERED || stage >= STAGE_FRAGMENTS_JOINED) return;
        event.handled = true;
        quest.setStage(player, STAGE_PASTE_REFUSED);
        startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_PASTE);
        return;
      }
      if (itemId === SEA_SLUG_GLUE_ITEM_ID && FRAGMENT_ITEM_IDS.has(otherId)) {
        if (quest.getStage(player) !== STAGE_GLUE_OBTAINED) return;
        event.handled = true;
        if (!hasFragments(player) || !held(player, SEA_SLUG_GLUE_ITEM_ID)) return;
        player.getInventory().deleteNumber(FRAGMENT_1_ITEM_ID, 1);
        player.getInventory().deleteNumber(FRAGMENT_2_ITEM_ID, 1);
        player.getInventory().deleteNumber(FRAGMENT_3_ITEM_ID, 1);
        player.getInventory().deleteNumber(SEA_SLUG_GLUE_ITEM_ID, 1);
        player.getInventory().adds(PAGE_3_ITEM_ID, 1);
        player.getPacketSender().sendVarbit(VARBIT_FIXED_PAGE, 1);
        player.getPacketSender().sendVarbit(VARBIT_TORNPAGES, 0);
        player.sendMessage(GLUE_JOINED_MESSAGE);
        quest.setStage(player, STAGE_FRAGMENTS_JOINED);
        return;
      }
    }
  }

  // ==========================================================================
  // Objects
  // ==========================================================================

  function openShrineWall(player) {
    player.setAttribute(WALL_OPEN_ATTRIBUTE, 1);
    player.getPacketSender().sendVarbit(VARBIT_DOORBIT, 1);
  }

  function pushShrineWall(player) {
    if (quest.isComplete(player)) return;
    const stage = quest.getStage(player);
    if (stage < STAGE_REPORTED) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_WALL_BEFORE);
      return;
    }
    if (!hasAnyCommorb(player)) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_WALL_NO_ORB);
      return;
    }
    openShrineWall(player);
    player.sendMessage("The wall creaks open to reveal a hidden entrance!");
  }

  function handleObjectInteraction(event) {
    const { player, objectId, location } = event;
    if (!player) return;
    if (objectId === FALSE_WALL_OBJECT_ID) {
      event.handled = true;
      pushShrineWall(player);
      return;
    }
    if (objectId === WALL_PASSAGE_OBJECT_ID) {
      event.handled = true;
      if (!wallOpen(player)) {
        pushShrineWall(player);
        return;
      }
      if (!hasAnyCommorb(player)) {
        startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_PASSAGE_NO_ORB);
      }
      return;
    }
    if (IMPOSING_DOOR_OBJECT_IDS.has(objectId)) {
      event.handled = true;
      if (!quest.isStarted(player) || quest.isComplete(player)) return;
      const used = getUsedRunes(player);
      if ((used & ALL_RUNES_USED) === ALL_RUNES_USED) {
        openImposingDoor(player);
        return;
      }
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_DOOR_ATTEMPT);
      return;
    }
    if (objectId === STUDY_DESK_OBJECT_ID && isTile(location, { x: 2708, y: 3294, z: 0 })) {
      const stage = quest.getStage(player);
      if (stage < STAGE_MALEDICT_PAGES || stage >= STAGE_FRAGMENTS_JOINED) return;
      if (held(player, PAGE_1_ITEM_ID) || held(player, PAGE_3_ITEM_ID)) return;
      event.handled = true;
      startTranscript(api, player, MAYOR_HOBB_NPC_ID, PAGE, V_DESK);
    }
  }

  /** ClimbLinks mispairs the Old ruin entrance; claim both ends of the shrine. */
  function handleLadderClaim(event) {
    const location = event.object?.getLocation?.();
    if (!location) return;
    if (
      event.objectId === OLD_RUIN_ENTRANCE_OBJECT_ID &&
      isTile(location, OLD_RUIN_ENTRANCE_TILE)
    ) {
      event.handled = true;
      api.emitCustomEvent("ladders:climbDown", {
        player: event.player,
        object: event.object,
        destination: new Location(DUNGEON_ENTRY_TILE.x, DUNGEON_ENTRY_TILE.y, DUNGEON_ENTRY_TILE.z),
      });
      return;
    }
    if (event.objectId === DUNGEON_EXIT_OBJECT_ID && isTile(location, DUNGEON_EXIT_TILE)) {
      event.handled = true;
      api.emitCustomEvent("ladders:climbUp", {
        player: event.player,
        object: event.object,
        destination: new Location(
          SURFACE_LANDING_TILE.x,
          SURFACE_LANDING_TILE.y,
          SURFACE_LANDING_TILE.z
        ),
      });
    }
  }

  function handleDoorZoneEnter({ player }) {
    if (!player || !quest.isStarted(player) || quest.isComplete(player)) return;
    if (quest.getStage(player) !== STAGE_REPORTED || promptedDoorScan.has(player)) return;
    promptedDoorScan.add(player);
    if (!hasAnyCommorb(player)) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_DOOR_NO_ORB);
      return;
    }
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SCAN_ASK);
  }

  // ==========================================================================
  // NPC conversations claimed by name (Sea Slug shares Holgart and Bailey)
  // ==========================================================================

  function talkToHolgart(event) {
    const { player, npcId } = event;
    if (!quest.isStarted(player) || quest.isComplete(player)) return false;
    const stage = quest.getStage(player);
    const variant = trackSet(player, TRACK_HOLGART) || stage >= STAGE_REPORTED ? V_HOLGART_AGAIN : V_HOLGART;
    if (variant === V_HOLGART) setTrack(player, TRACK_HOLGART);
    startTranscript(api, player, npcId, PAGE, variant);
    return undefined;
  }

  function talkToBailey(event) {
    const { player, npcId } = event;
    if (!quest.isStarted(player) || quest.isComplete(player)) return false;
    const stage = quest.getStage(player);
    const variant =
      stage === STAGE_PASTE_REFUSED || stage === STAGE_GLUE_OBTAINED ? V_BAILEY_GLUE : V_BAILEY;
    startTranscript(api, player, npcId, PAGE, variant);
    return undefined;
  }

  function talkToJeb(event) {
    const { player, npcId } = event;
    if (!quest.isStarted(player) || quest.isComplete(player)) return false;
    const variant = jebVariant(player);
    startTranscript(api, player, npcId, PAGE, variant);
    return undefined;
  }

  function travelWithJeb(event) {
    const { player } = event;
    if (!quest.isStarted(player) || quest.isComplete(player)) return false;
    const location = player.getLocation();
    if (location.getX() >= PLATFORM_MIN_X) {
      teleport(player, SHORE_TILE);
      player.sendMessage("The boat arrives at Witchaven.");
    } else {
      setTrack(player, TRACK_HOLGART);
      teleport(player, PLATFORM_TILE);
      player.sendMessage("You arrive at the fishing platform.");
    }
    return undefined;
  }

  // ==========================================================================
  // Combat
  // ==========================================================================

  function handleNpcDeath(event) {
    const killer = event?.killer?.isPlayer?.() ? event.killer : null;
    if (!killer) return;
    const npc = event.npc;
    if (!npc || princeByPlayer.get(killer) !== npc) return;
    princeByPlayer.delete(killer);
    if (quest.getStage(killer) >= STAGE_PRINCE_KILLED) return;
    quest.setStage(killer, STAGE_PRINCE_KILLED);
    startTranscript(api, killer, MAYOR_HOBB_NPC_ID, PAGE, V_DOOR_KILLED);
  }

  /** Only melee can hurt the Slug Prince (Wiki); zero every other combat type. */
  function handleNpcHitModify({ npc, hit }) {
    if (!npc || !SLUG_PRINCE_NPC_IDS.has(npc.getId?.())) return;
    if (hit?.getCombatType?.() === CombatType.MELEE) return;
    if (hit.isAccurate?.() !== true || hit.getTotalDamage?.() <= 0) return;
    for (const damage of hit.getHits?.() ?? []) damage.setDamage(0);
    hit.updateTotalDamage?.();
  }

  // ==========================================================================
  // Lifecycle / journal / rewards
  // ==========================================================================

  function waitForChatbox(player, done) {
    if (player.isRegistered?.() === false) return;
    if (!CountdownTask || !TaskManager) {
      done();
      return;
    }
    TaskManager.submit(
      new CountdownTask(player, 1, () => {
        if (player.isRegistered?.() === false) return;
        if (player.getDialogueManager?.()?.isActive?.() === true) {
          waitForChatbox(player, done);
          return;
        }
        done();
      })
    );
  }

  function armSavantReveal(player) {
    waitForChatbox(player, () => {
      if (!quest.isStarted(player) || quest.isComplete(player)) return;
      if (quest.getStage(player) === STAGE_JORRAL_TRANSLATED) {
        quest.setStage(player, STAGE_SAVANT_INFO);
        player.getPacketSender().sendVarbit(VARBIT_SAVANT_GOTINFO, 1);
      }
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_AFTER_JORRAL);
    });
  }

  function handleStageChanged({ player, key }) {
    if (key !== "the_slug_menace" || !player) return;
    syncDeadSlug(player);
  }

  function handleLogin({ player }) {
    if (!player) return;
    refreshQuestList(player);
    sendSlugVarps(player);
    syncDeadSlug(player);
    if (quest.getStage(player) >= STAGE_PRINCE_KILLED || quest.isComplete(player)) clearPrince(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    clearPrince(player);
    promptedDoorScan.delete(player);
    pendingShape.delete(player);
  }

  function handlePlayerDeath({ player }) {
    if (!player) return;
    clearPrince(player);
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I was recruited by the Temple Knights to investigate the strange",
        "<str>goings-on in Witchaven.</str>",
        "<str>I uncovered the sea slug plot and slew the Slug Prince, but the</str>",
        "<str>Mother Mallum escaped her prison.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_PRINCE_KILLED) {
      return [
        "<str>I confronted Mayor Hobb at the imposing door and slew the Slug Prince.</str>",
        "<str>Mother Mallum was awakened, but Savant teleported me to safety.</str>",
        "",
        "I should report to <col=800000>Sir Tiffy Cashien</col> in Falador Park.",
      ];
    }
    if (stage >= STAGE_FRAGMENTS_JOINED) {
      return [
        "The page is whole. Its runes must be shaped and empowered.",
        "",
        "Use a <col=800000>chisel</col> and rune essence on the page to carve the",
        "five blank runes, then take each rune to its matching <col=800000>runic altar</col>.",
        "",
        "Then use the finished runes on the <col=800000>imposing door</col>",
        "deep under Witchaven.",
      ];
    }
    if (stage >= STAGE_GLUE_OBTAINED) {
      return [
        "Bailey rendered the dead sea slug into a clear glue.",
        "",
        "Use the <col=800000>sea slug glue</col> on one of the page fragments.",
      ];
    }
    if (stage >= STAGE_PASTE_REFUSED) {
      return [
        "Savant stopped me from ruining the parchment with swamp paste.",
        "",
        "The glue must be made by an expert in aquatic cooking -",
        "<col=800000>Bailey</col> on the <col=800000>Fishing Platform</col>.",
      ];
    }
    if (stage >= STAGE_PAGES_GATHERED) {
      return [
        "I have the stolen pages and the final page torn into three pieces.",
        held(player, SWAMP_PASTE_ITEM_ID)
          ? "I should try using my <col=800000>swamp paste</col> on a fragment."
          : "I should find something to glue the fragments back together.",
      ];
    }
    if (stage >= STAGE_MALEDICT_PAGES) {
      return [
        "Maledict is possessed too. He needs the three stolen pages of his",
        "holy book to reveal the shrine's history.",
        "",
        stage >= STAGE_MALEDICT_PAGES && held(player, PAGE_1_ITEM_ID)
          ? "<str>I found a page in the Mayor's study desk.</str>"
          : "Search the <col=800000>study desk</col> in the Mayor's house.",
        held(player, PAGE_2_ITEM_ID)
          ? "<str>Ezekial Lovecraft gave me a page.</str>"
          : "The shopkeeper <col=800000>Ezekial Lovecraft</col> may have one.",
        hasFragments(player)
          ? "<str>Col. O'Niall gave me the final page, torn in three.</str>"
          : "<col=800000>Col. O'Niall</col> may know about the last page.",
      ];
    }
    if (stage >= STAGE_SAVANT_INFO) {
      return [
        "Savant pieced together the old temple records: the shrine imprisons",
        "the <col=800000>Mother Mallum</col>, an ancient sea slug queen.",
        "",
        "I should warn <col=800000>Col. O'Niall</col> in Witchaven.",
      ];
    }
    if (stage >= STAGE_JORRAL_TRANSLATED) {
      return [
        "Jorral translated the glyphs on the imposing door; Savant is",
        "cross-referencing them with the Temple Knights' records.",
      ];
    }
    if (stage >= STAGE_DOOR_SCANNED) {
      return [
        "I have a <col=800000>door transcription</col> of the strange glyphs.",
        "",
        "I should take it to <col=800000>Jorral</col> at the outpost north-west",
        "of Ardougne.",
      ];
    }
    if (stage >= STAGE_REPORTED) {
      return [
        "Col. O'Niall believes the Mayor's shrine work is behind the town's",
        "troubles. The shrine lies west of Witchaven.",
        "",
        "Push the <col=800000>false wall</col> inside and scan the strange door",
        "with my <col=800000>CommOrb</col>.",
      ];
    }
    if (stage >= STAGE_INVESTIGATED) {
      return [
        "<str>I have questioned the townsfolk about the strange goings-on.</str>",
        "",
        "Report back to <col=800000>Col. O'Niall</col> on the Witchaven dock.",
      ];
    }
    if (stage >= STAGE_BRIEFED) {
      return [
        "Col. O'Niall told me about the Mayor's suspicious behaviour.",
        "",
        "Speak to <col=800000>Mayor Hobb</col>, <col=800000>Brother Maledict</col>",
        "and <col=800000>Holgart</col> around the village.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "Sir Tiffy Cashien gave me a <col=800000>Commorb v2</col> and sent me to",
        "Witchaven to report to <col=800000>Col. O'Niall</col>.",
        "",
        "The CommOrb's <col=800000>Contact</col> option reaches Savant.",
      ];
    }
    return [
      "I can start this quest by speaking to <col=800000>Sir Tiffy Cashien</col>",
      "in <col=800000>Falador Park</col> with my <col=800000>Commorb</col>.",
      "",
      "I need to have completed <col=800000>Wanted!</col> and <col=800000>Sea Slug</col>",
      "and have 30 Crafting, Runecraft, Slayer and Thieving.",
    ];
  }

  function grantReward(player) {
    const manager = player.getSkillManager();
    manager.addExperiences(Skill.CRAFTING, 3500);
    manager.addExperiences(Skill.RUNECRAFTING, 3500);
    manager.addExperiences(Skill.THIEVING, 3500);
  }

  api.persistAttribute(TRACKS_ATTRIBUTE);
  api.persistAttribute(USED_RUNES_ATTRIBUTE);
  api.persistAttribute(WALL_OPEN_ATTRIBUTE);
  api.persistAttribute(DOOR_REVEALED_ATTRIBUTE);
  api.persistAttribute(MALEDICT_ASKED_ATTRIBUTE);

  groundItems = api.getItemOnGroundManager();

  quest = registerQuest(api, {
    key: "the_slug_menace",
    name: "The Slug Menace",
    varpId: VARP_SLUG_MENACE,
    varbitId: VARBIT_SLUG_MAIN,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: Skill.CRAFTING.getIndex(), amount: 3500, label: "Crafting" },
      { skillId: Skill.RUNECRAFTING.getIndex(), amount: 3500, label: "Runecraft" },
      { skillId: Skill.THIEVING.getIndex(), amount: 3500, label: "Thieving" },
    ],
    otherRewards: ["Access to Proselyte armour from Sir Tiffy Cashien"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:condition", handleChosenCondition);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  api.onCustomEvent("quest:stage-changed", handleStageChanged);
  api.onNpcInteraction("Holgart", { "Talk-to": talkToHolgart });
  api.onNpcInteraction("Bailey", { "Talk-to": talkToBailey });
  api.onNpcInteraction("Jeb", { "Talk-to": talkToJeb, Travel: travelWithJeb });
  api.onItemAction(handleItemAction);
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onItemOnItem(handleItemOnItem, { noted: false });
  api.onObjectInteraction(handleObjectInteraction);
  api.onNpcDeath(handleNpcDeath);
  api.onNpcHitModify(handleNpcHitModify);
  api.onCustomEvent("ladders:climb", handleLadderClaim);
  api.onZoneEnter(DOOR_ZONE, handleDoorZoneEnter);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
  api.onPlayerDeath(handlePlayerDeath);
};
