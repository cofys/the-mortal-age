/**
 * The Garden of Death (members).
 *
 * A dialogue-less exploration quest: every line is a search/read message from the
 * "The Garden of Death" transcript page (the page has no NPC speakers and no
 * default variant). The runtime plays it variant by variant, so this plugin
 * raises each variant itself from the scenery and item interactions and answers
 * the few prose conditions the page carries.
 *
 * Stages (varbit 14609 "tgod", varp 3713 bits 0-8): the cache's quest-tab helper
 * script 4024 maps db-table-0 row 180 ("Garden of Death, The") to varbit 14609
 * (`dump:cs2 4024`, case 180 -> get_varbit 14609; confirmed by name in
 * `lookup-gameval.ts varbit garden`). The stub's varp 554 is Garden of
 * Tranquillity's flower-patch varp, not this quest. The real stage values are
 * not published; this is the natural transcript order:
 *   0 not started, 1 journal found, 2 journal read (the campsite hole opens),
 *   3 first dungeon translated (Molch Island hole appears), 4 second dungeon
 *   translated (Xeric's Shrine hole appears), 5 third dungeon translated
 *   (Ruins of Morra hole appears), 6 fourth dungeon translated (the warning
 *   note can be taken), 7 complete.
 *
 * Rewards (OSRS Wiki): 1 Quest Point and 10,000 Farming XP, level 20 Farming
 * required to start (not boostable; checked against the base level).
 *
 * Gaps/approximations:
 * - The word-translation input interface does not exist here: reading the Word
 *   translations scroll translates every word of the current dungeon at once
 *   ("You've discovered a new translation: <meaning> = <word>"), and inspecting
 *   a wood carving or the compass discovers its word individually. The wiki's
 *   word pairs are in DUNGEON_WORDS; carvings carry a short discovery line
 *   instead of OSRS's illustration interface.
 * - The interactive scenery variants (46338/46340/46343/46345/46347 and the
 *   searchable stone tables 46362-46375) are not placed in the world maps, so
 *   the base rubble/chests/vases/mushrooms/tables are swapped for them on first
 *   login (tile, shape and face preserved). OSRS only makes each object
 *   searchable at the right quest step; here they are searchable from the start
 *   but every handler is stage-scoped.
 * - Three of the four entrance holes are not placed in the world maps (only the
 *   campsite hole 46326 at 1308,3467). The other three are spawned at the
 *   surface tiles above their dungeon exits once the previous dungeon's words
 *   are translated, matching the wiki's "the hole will not appear if any words
 *   are missing".
 * - The journal and the dirty notes open interfaces in OSRS; this plugin has no
 *   text for them, so Read only advances the journal stage.
 * - Reading stone tablets 2 and 3 has no transcript variant, so Read is silent.
 * - The "fully understand all of the stone tablets" line (L1cVhR) is raised once
 *   by the Word translations scroll when all four dungeons' words are known (a
 *   persisted flag), including after the fourth dungeon when currentDungeon is 0.
 *
 * Source: OSRS Wiki (The Garden of Death, Quick guide, Transcript:The Garden of
 * Death); ids from the cache identifier dumps.
 */
module.exports = function registerGardenOfDeathQuest(api) {
  const {
    Animation,
    GameObject,
    ItemIdentifiers,
    Location,
    MapObjects,
    NpcIdentifiers,
    ObjectIdentifiers,
    ObjectManager,
    RegionManager,
    Skill,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  // ==========================================================================
  // Ids and constants
  // ==========================================================================

  const PAGE = "The Garden of Death";
  // The page has no speakers, so the chathead id is inert: it only tags the
  // events this plugin raises through the transcript runtime.
  const TRANSCRIPT_NPC_ID = NpcIdentifiers.KASONDE;

  const VARP_ID = 3713; // "tgod" quest varp
  const VARBIT_ID = 14609; // "tgod", varp 3713 bits 0-8

  const STAGE_STARTED = 1;
  const STAGE_JOURNAL_READ = 2;
  const STAGE_DUNGEON_1_DONE = 3;
  const STAGE_DUNGEON_2_DONE = 4;
  const STAGE_DUNGEON_3_DONE = 5;
  const STAGE_DUNGEON_4_DONE = 6;
  const STAGE_COMPLETE = 7;

  const FARMING_REQUIREMENT = 20;

  const START_HOOK = "quest:the-garden-of-death:start";

  // Condition step ids.
  const CAMP_NO_SECATEURS_CONDITION = "OooLjQ";
  const CAMP_HAS_SECATEURS_CONDITION = "ChpYRu";
  const D4_FULL_INVENTORY_CONDITION = "98t8-D";
  const D4_HAS_SPACE_CONDITION = "Gy9FwW";
  // Message/action step ids the transcript runtime emits.
  const JOURNAL_FOUND_ACTION = "FLIJGW";
  const SECATEURS_FOUND_ACTION = "8YLvcl";
  const WORD_TRANSLATIONS_ACTION = "fBeqSs";
  const WARNING_NOTE_ACTION = "YBLHVE";
  const QUEST_COMPLETE_ACTION = "ZsMuIY";

  // Objects.
  const TENT = ObjectIdentifiers.TENT_19; // 46324
  const CAMPING_EQUIPMENT = ObjectIdentifiers.CAMPING_EQUIPMENT_6; // 46325
  const HOLE = ObjectIdentifiers.HOLE_64; // 46326
  const ROPE_CAMPSITE = ObjectIdentifiers.ROPE_46; // 46327 (dungeon 1 -> campsite)
  const ROPE_MOLCH = ObjectIdentifiers.ROPE_47; // 46330
  const ROPE_XERIC = ObjectIdentifiers.ROPE_48; // 46333
  const ROPE_MORRA = ObjectIdentifiers.ROPE_49; // 46336
  const TABLE_D1 = ObjectIdentifiers.STONE_TABLE_35; // 46376
  const TABLE_D2 = ObjectIdentifiers.STONE_TABLE_36; // 46377 (Molch Island)
  const TABLE_D3 = ObjectIdentifiers.STONE_TABLE_37; // 46378 (Xeric's Shrine)
  const TABLE_D4 = ObjectIdentifiers.STONE_TABLE_38; // 46379 (Ruins of Morra)
  const RUBBLE_SEARCH = ObjectIdentifiers.RUBBLE_71; // 46338
  const STONE_CHEST_SEARCH = ObjectIdentifiers.STONE_CHEST_26; // 46340
  const VASE_SEARCH = ObjectIdentifiers.VASE_5; // 46343
  const MUSHROOM_SEARCH = ObjectIdentifiers.HUGE_MUSHROOM_6; // 46345
  const MUSHROOM_SEARCH_2 = ObjectIdentifiers.HUGE_MUSHROOM_8; // 46347
  const TABLE_SEARCH_WIDE = ObjectIdentifiers.STONE_TABLE_21; // 46362 (1x2)
  const TABLE_SEARCH_BIG = ObjectIdentifiers.STONE_TABLE_29; // 46370 (2x2)
  const TABLE_SEARCH_SMALL = ObjectIdentifiers.STONE_TABLE_34; // 46375 (1x1)

  // Items.
  const SECATEURS = ItemIdentifiers.SECATEURS; // 5329
  const SECATEURS_2 = ItemIdentifiers.SECATEURS_2; // 5330
  const MAGIC_SECATEURS = ItemIdentifiers.MAGIC_SECATEURS; // 7409
  const KASONDES_JOURNAL = ItemIdentifiers.KASONDES_JOURNAL; // 27511
  const WORD_TRANSLATIONS = ItemIdentifiers.WORD_TRANSLATIONS; // 27513
  const DIRTY_NOTE = ItemIdentifiers.DIRTY_NOTE; // 27515
  const DIRTY_NOTE_3 = ItemIdentifiers.DIRTY_NOTE_3; // 27517
  const WARNING_NOTE = ItemIdentifiers.WARNING_NOTE; // 27518
  const STONE_TABLET_1 = ItemIdentifiers.STONE_TABLET_6; // 27519
  const STONE_TABLET_2 = ItemIdentifiers.STONE_TABLET_7; // 27520
  const STONE_TABLET_3 = ItemIdentifiers.STONE_TABLET_8; // 27521
  const STONE_TABLET_4 = ItemIdentifiers.STONE_TABLET_9; // 27522
  const COMPASS = ItemIdentifiers.COMPASS; // 27532

  const TABLET_BY_DUNGEON = [undefined, STONE_TABLET_1, STONE_TABLET_2, STONE_TABLET_3, STONE_TABLET_4];
  const TABLET_ITEMS = new Set(TABLET_BY_DUNGEON.slice(1));
  const PRIMARY_TABLE_BY_DUNGEON = new Map([
    [TABLE_D1, 1],
    [TABLE_D2, 2],
    [TABLE_D3, 3],
    [TABLE_D4, 4],
  ]);

  const CLIMB_UP_ANIMATION = 828;
  const CLIMB_DOWN_ANIMATION = 827;

  const WORDS_ATTRIBUTE = "quest.the_garden_of_death.words";
  const SEARCHED_ATTRIBUTE = "quest.the_garden_of_death.searched";
  const FULLY_TRANSLATED_ATTRIBUTE = "quest.the_garden_of_death.fully-translated";

  // ==========================================================================
  // Word data (OSRS Wiki translation table)
  // ==========================================================================

  const DUNGEON_WORDS = [
    [["Island", "Ikam"], ["Water", "Ates"], ["Time", "Miki"], ["Vessel", "Toka"], ["Garden", "Tlane"], ["North", "Makt"]],
    [["West", "Silam"], ["Poison", "Achi"], ["Animal", "Ayak"], ["Body", "Olkat"], ["Food", "Kualt"], ["Earth", "Xali"], ["Air", "Ehke"], ["Fire", "Tepat"]],
    [["Make", "Chua"], ["Yes", "Kemo"], ["No", "Ami"], ["Move", "Lini"], ["Arrive", "Xita"], ["East", "Takam"], ["South", "Uitt"]],
    [["Few", "Amok"], ["Big", "Siua"], ["Sun", "Ralo"], ["Moon", "Rani"], ["Life", "Tal"], ["Mind", "Yoka"], ["Home", "Antil"]],
  ];
  const WORD_BASE = [0, 6, 14, 21];

  const CARVING_WORD_INDEX = new Map([
    [ItemIdentifiers.WOOD_CARVING, 0], // Island
    [ItemIdentifiers.WOOD_CARVING_2, 1], // Water
    [ItemIdentifiers.WOOD_CARVING_3, 6], // West
    [ItemIdentifiers.WOOD_CARVING_4, 7], // Poison
    [ItemIdentifiers.WOOD_CARVING_5, 8], // Animal
    [ItemIdentifiers.WOOD_CARVING_6, 14], // Make
    [ItemIdentifiers.WOOD_CARVING_7, 15], // Yes
    [ItemIdentifiers.WOOD_CARVING_8, 16], // No
    [ItemIdentifiers.WOOD_CARVING_9, 17], // Move
    [ItemIdentifiers.WOOD_CARVING_10, 21], // Few
    [ItemIdentifiers.WOOD_CARVING_11, 22], // Big
    [ItemIdentifiers.WOOD_CARVING_12, 23], // Sun
    [ItemIdentifiers.WOOD_CARVING_13, 24], // Moon
  ]);
  const COMPASS_WORD_INDEXES = [5, 6, 19, 20]; // North, West, East, South

  // ==========================================================================
  // Searchable scenery (base map ids -> interactive variants)
  // ==========================================================================

  const BASE_SCENERY_IDS = new Set([
    ObjectIdentifiers.RUBBLE_70, // 46337
    ObjectIdentifiers.STONE_CHEST_25, // 46339
    ObjectIdentifiers.STONE_CHEST_27, // 46341
    ObjectIdentifiers.VASE_4, // 46342
    ObjectIdentifiers.HUGE_MUSHROOM_5, // 46344
    ObjectIdentifiers.HUGE_MUSHROOM_7, // 46346
    ObjectIdentifiers.STONE_TABLE_7, // 46348
    ObjectIdentifiers.STONE_TABLE_8, // 46349
    ObjectIdentifiers.STONE_TABLE_9, // 46350
    ObjectIdentifiers.STONE_TABLE_10, // 46351
    ObjectIdentifiers.STONE_TABLE_11, // 46352
    ObjectIdentifiers.STONE_TABLE_12, // 46353
    ObjectIdentifiers.STONE_TABLE_13, // 46354
    ObjectIdentifiers.STONE_TABLE_14, // 46355
    ObjectIdentifiers.STONE_TABLE_15, // 46356
    ObjectIdentifiers.STONE_TABLE_16, // 46357
    ObjectIdentifiers.STONE_TABLE_17, // 46358
    ObjectIdentifiers.STONE_TABLE_18, // 46359
    ObjectIdentifiers.STONE_TABLE_19, // 46360
    ObjectIdentifiers.STONE_TABLE_20, // 46361
  ]);

  // [replacementId, x, y, shape, face] for every placed base object, from
  // `yarn dump:loc` of the base ids. Sizes are preserved (1x2 -> 46362,
  // 2x2 -> 46370, 1x1 -> 46375).
  const SEARCHABLE_SCENERY = [
    [RUBBLE_SEARCH, 1433, 9812, 10, 1],
    [RUBBLE_SEARCH, 1419, 9814, 10, 3],
    [VASE_SEARCH, 1438, 9816, 10, 1],
    [VASE_SEARCH, 1439, 9816, 10, 0],
    [STONE_CHEST_SEARCH, 1442, 9816, 10, 2],
    [TABLE_SEARCH_WIDE, 1443, 9818, 10, 0],
    [RUBBLE_SEARCH, 1457, 9821, 10, 2],
    [RUBBLE_SEARCH, 1419, 9822, 10, 2],
    [TABLE_SEARCH_BIG, 1438, 9826, 10, 1],
    [RUBBLE_SEARCH, 1460, 9826, 10, 0],
    [VASE_SEARCH, 1443, 9831, 10, 3],
    [RUBBLE_SEARCH, 1419, 9832, 10, 0],
    [TABLE_SEARCH_SMALL, 1438, 9832, 10, 1],
    [RUBBLE_SEARCH, 1436, 9833, 10, 3],
    [RUBBLE_SEARCH, 1430, 9836, 10, 1],
    [VASE_SEARCH, 1304, 9882, 10, 1],
    [TABLE_SEARCH_SMALL, 1315, 9882, 10, 2],
    [VASE_SEARCH, 1316, 9882, 10, 3],
    [TABLE_SEARCH_BIG, 1312, 9884, 10, 0],
    [VASE_SEARCH, 1302, 9885, 10, 1],
    [STONE_CHEST_SEARCH, 1303, 9885, 10, 0],
    [STONE_CHEST_SEARCH, 1305, 9885, 10, 0],
    [VASE_SEARCH, 1317, 9885, 10, 2],
    [RUBBLE_SEARCH, 1302, 9887, 10, 3],
    [RUBBLE_SEARCH, 1315, 9887, 10, 2],
    [MUSHROOM_SEARCH_2, 1309, 9997, 10, 0],
    [MUSHROOM_SEARCH, 1298, 10004, 10, 2],
    [MUSHROOM_SEARCH_2, 1318, 10005, 10, 2],
    [TABLE_SEARCH_BIG, 1307, 10006, 10, 3],
    [MUSHROOM_SEARCH, 1317, 10012, 10, 2],
    [RUBBLE_SEARCH, 1384, 10012, 10, 0],
    [TABLE_SEARCH_SMALL, 1367, 10014, 10, 2],
    [STONE_CHEST_SEARCH, 1372, 10014, 10, 2],
    [TABLE_SEARCH_WIDE, 1377, 10014, 10, 3],
    [VASE_SEARCH, 1383, 10014, 10, 1],
    [MUSHROOM_SEARCH, 1301, 10016, 10, 0],
    [RUBBLE_SEARCH, 1302, 10016, 10, 3],
    [RUBBLE_SEARCH, 1304, 10016, 10, 1],
    [RUBBLE_SEARCH, 1313, 10016, 10, 3],
    [STONE_CHEST_SEARCH, 1304, 10018, 10, 2],
    [TABLE_SEARCH_SMALL, 1305, 10018, 10, 1],
    [STONE_CHEST_SEARCH, 1310, 10018, 10, 2],
    [VASE_SEARCH, 1367, 10018, 10, 2],
    [VASE_SEARCH, 1368, 10019, 10, 1],
    [STONE_CHEST_SEARCH, 1378, 10019, 10, 0],
    [TABLE_SEARCH_WIDE, 1379, 10019, 10, 3],
    [VASE_SEARCH, 1302, 10022, 10, 1],
    [TABLE_SEARCH_BIG, 1310, 10022, 10, 2],
    [VASE_SEARCH, 1313, 10022, 10, 2],
    [VASE_SEARCH, 1305, 10023, 10, 2],
  ];

  const SCENERY_TYPE_BY_ID = new Map([
    [RUBBLE_SEARCH, "rubble"],
    [STONE_CHEST_SEARCH, "chest"],
    [VASE_SEARCH, "vase"],
    [MUSHROOM_SEARCH, "mushroom"],
    [MUSHROOM_SEARCH_2, "mushroom"],
    [TABLE_SEARCH_WIDE, "table"],
    [TABLE_SEARCH_BIG, "table"],
    [TABLE_SEARCH_SMALL, "table"],
  ]);
  const SPOT_TYPE_BY_KEY = new Map(
    SEARCHABLE_SCENERY.map(([id, x, y]) => [`${x},${y}`, SCENERY_TYPE_BY_ID.get(id)])
  );

  // Exact transcript lines, per dungeon and object type, in the order a player
  // meets the objects. "item" is handed out with the line; index beyond the
  // list means that object has nothing more to give.
  const OTHER_REWARDS = {
    1: {
      table: [
        { text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING },
        { text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_2 },
      ],
      vase: [{ text: "You find a note next to the vase. You take it.", item: DIRTY_NOTE }],
      chest: [{ text: "The chest contains some hourglasses. A label on the chest reads 'Miki Toka'." }],
    },
    2: {
      table: [{ text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_3 }],
      vase: [
        { text: "You find a carving next to the vase. You take it.", item: ItemIdentifiers.WOOD_CARVING_4 },
        { text: "The vase seems to contain some very old compost. A label on the vase reads 'Tlane Kualt'." },
      ],
      chest: [{ text: "The chest contains some body runes. A label on the chest reads 'Olkat'." }],
      rubble: [{ text: "You search the rubble and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_5 }],
    },
    3: {
      table: [
        { text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_6 },
        { text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_7 },
      ],
      vase: [{ text: "You find a carving next to the vase. You take it.", item: ItemIdentifiers.WOOD_CARVING_8 }],
      chest: [{ text: "You search the chest and find a compass. You take it.", item: COMPASS }],
      mushroom: [{ text: "You find a carving next to the mushroom. You take it.", item: ItemIdentifiers.WOOD_CARVING_9 }],
    },
    4: {
      table: [
        { text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_10 },
        { text: "You search the table and find a stone tablet. You take it." },
      ],
      vase: [{ text: "You find a carving next to the vase. You take it.", item: ItemIdentifiers.WOOD_CARVING_11 }],
      chest: [
        { text: "You search the chest and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_12 },
        { text: "The chest contains what look to be home teleport tablets. A label on the chest reads 'Antil'." },
      ],
      rubble: [
        { text: "You search the rubble and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_13 },
        { text: "You search the rubble and find a note. You take it.", item: DIRTY_NOTE_3 },
      ],
    },
  };

  // Entrance holes: surface position and the stage that makes them appear.
  const ENTRANCES = [
    { stage: STAGE_DUNGEON_1_DONE, x: 1374, y: 3633, to: { x: 1374, y: 10032 } }, // Molch Island
    { stage: STAGE_DUNGEON_2_DONE, x: 1294, y: 3633, to: { x: 1295, y: 10032 } }, // Xeric's Shrine
    { stage: STAGE_DUNGEON_3_DONE, x: 1457, y: 3423, to: { x: 1455, y: 9822 } }, // Ruins of Morra
  ];
  const HOLE_EXITS = new Map([
    ["1308,3467", { stage: STAGE_JOURNAL_READ, to: { x: 1309, y: 9870 } }], // campsite
    ["1374,3633", { stage: STAGE_DUNGEON_1_DONE, to: { x: 1374, y: 10032 } }],
    ["1294,3633", { stage: STAGE_DUNGEON_2_DONE, to: { x: 1295, y: 10032 } }],
    ["1457,3423", { stage: STAGE_DUNGEON_3_DONE, to: { x: 1455, y: 9822 } }],
  ]);
  const ROPE_EXITS = new Map([
    [ROPE_CAMPSITE, { x: 1309, y: 3469 }],
    [ROPE_MOLCH, { x: 1374, y: 3635 }],
    [ROPE_XERIC, { x: 1294, y: 3635 }],
    [ROPE_MORRA, { x: 1457, y: 3425 }],
  ]);

  let quest;
  let sceneryInstalled = false;
  const spawnedEntrances = new Set();

  // ==========================================================================
  // State helpers
  // ==========================================================================

  const has = (player, itemId) => player.getInventory().getAmount(itemId) >= 1;

  function hasSecateurs(player) {
    return has(player, SECATEURS) || has(player, SECATEURS_2) || has(player, MAGIC_SECATEURS);
  }

  function words(player) {
    return Number(player.getAttribute(WORDS_ATTRIBUTE)) || 0;
  }

  function knowsWord(player, index) {
    return (words(player) & (1 << index)) !== 0;
  }

  function wordAt(index) {
    for (let dungeon = 0; dungeon < DUNGEON_WORDS.length; dungeon++) {
      const offset = index - WORD_BASE[dungeon];
      if (offset >= 0 && offset < DUNGEON_WORDS[dungeon].length) return DUNGEON_WORDS[dungeon][offset];
    }
    return undefined;
  }

  /** Discovers a word and shows the transcript's "new translation" line once. */
  function discoverWord(player, index) {
    if (knowsWord(player, index)) return false;
    player.setAttribute(WORDS_ATTRIBUTE, words(player) | (1 << index));
    const pair = wordAt(index);
    if (pair) player.sendMessage(`You've discovered a new translation: ${pair[0]} = ${pair[1]}`);
    return true;
  }

  function dungeonWordsDiscovered(player, dungeon) {
    const base = WORD_BASE[dungeon - 1];
    return DUNGEON_WORDS[dungeon - 1].every((_, index) => knowsWord(player, base + index));
  }

  function allWordsDiscovered(player) {
    return DUNGEON_WORDS.every((_, dungeon) => dungeonWordsDiscovered(player, dungeon + 1));
  }

  /** The wiki's "fully understand all of the stone tablets" line, once. */
  function maybePlayFullyTranslated(player) {
    if (!allWordsDiscovered(player) || player.getAttribute(FULLY_TRANSLATED_ATTRIBUTE)) return;
    player.setAttribute(FULLY_TRANSLATED_ATTRIBUTE, 1);
    startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "the-fourth-dungeon-fully-translating-stone-tablets");
  }

  /** The dungeon the player is currently solving; 0 when every dungeon is done. */
  function currentDungeon(stage) {
    if (stage === STAGE_JOURNAL_READ) return 1;
    if (stage === STAGE_DUNGEON_1_DONE) return 2;
    if (stage === STAGE_DUNGEON_2_DONE) return 3;
    if (stage === STAGE_DUNGEON_3_DONE) return 4;
    return 0;
  }

  /** Which of the four dungeons a tile belongs to (from the loc dump bounds). */
  function dungeonAt(x, y) {
    if (y < 9850) return 4; // Ruins of Morra
    if (y < 9950) return 1; // campsite
    return x >= 1340 ? 2 : 3; // Molch Island east, Xeric's Shrine west
  }

  // The four Garden of Death dungeons, from the loc dump bounds.
  const DUNGEON_BOUNDS = [
    { x1: 1289, x2: 1325, y1: 9859, y2: 9901 }, // campsite
    { x1: 1354, x2: 1401, y1: 9989, y2: 10039 }, // Molch Island
    { x1: 1289, x2: 1325, y1: 9989, y2: 10039 }, // Xeric's Shrine
    { x1: 1414, x2: 1461, y1: 9809, y2: 9841 }, // Ruins of Morra
  ];

  function inQuestDungeon(x, y) {
    return DUNGEON_BOUNDS.some((bound) => x >= bound.x1 && x <= bound.x2 && y >= bound.y1 && y <= bound.y2);
  }

  function searchedKeys(player) {
    return new Set(String(player.getAttribute(SEARCHED_ATTRIBUTE) || "").split("|").filter(Boolean));
  }

  function countSearched(keys, dungeon, type) {
    let count = 0;
    for (const key of keys) {
      const [x, y] = key.split(",").map(Number);
      if (dungeonAt(x, y) === dungeon && SPOT_TYPE_BY_KEY.get(key) === type) count++;
    }
    return count;
  }

  function clearRunState(player) {
    player.setAttribute(WORDS_ATTRIBUTE, 0);
    player.setAttribute(SEARCHED_ATTRIBUTE, "");
  }

  // ==========================================================================
  // Movement
  // ==========================================================================

  function climbTo(player, x, y, animation) {
    player.getMovementQueue().reset();
    player.performAnimation(new Animation(animation));
    player.moveTo(new Location(x, y, 0));
  }

  function spawnHole(x, y) {
    const key = `${x},${y}`;
    if (spawnedEntrances.has(key)) return;
    spawnedEntrances.add(key);
    const location = new Location(x, y, 0);
    if (MapObjects.get(HOLE, location, null)) return;
    ObjectManager.register(new GameObject(HOLE, location, 10, 0, null), true);
  }

  function ensureEntrances(player) {
    for (const entrance of ENTRANCES) {
      if (quest.getStage(player) >= entrance.stage) spawnHole(entrance.x, entrance.y);
    }
  }

  // ==========================================================================
  // Scenery: make the map's quest objects searchable
  // ==========================================================================

  function installSearchableScenery() {
    if (sceneryInstalled) return;
    sceneryInstalled = true;
    for (const [id, x, y, shape, face] of SEARCHABLE_SCENERY) {
      RegionManager.loadMapFiles(x, y);
      const tile = MapObjects.mapObjects.get(MapObjects.getHash(x, y, 0)) ?? [];
      for (const object of [...tile]) {
        if (BASE_SCENERY_IDS.has(object.getId())) ObjectManager.deregister(object, true);
      }
      ObjectManager.register(new GameObject(id, new Location(x, y, 0), shape, face, null), true);
    }
  }

  // ==========================================================================
  // Object interactions
  // ==========================================================================

  function searchTent(event) {
    const { player, location } = event;
    if (location.x !== 1313 || location.y !== 3469) return; // the other Tent 46324 placement
    event.handled = true;
    if (quest.isComplete(player) || quest.isStarted(player)) return;
    if (player.getSkillManager().getMaxLevel(Skill.FARMING) < FARMING_REQUIREMENT) {
      player.sendMessage("You need a Farming level of 20 to start this quest.");
      return;
    }
    clearRunState(player);
    startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "starting-the-quest-searching-the-tent");
  }

  function searchCampingEquipment(event) {
    const { player } = event;
    event.handled = true;
    startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "starting-the-quest-searching-the-camping-equipment");
  }

  function descendHole(event) {
    const { player, location } = event;
    const key = `${location.x},${location.y}`;
    const exit = HOLE_EXITS.get(key);
    if (!exit) return;
    event.handled = true;
    if (quest.getStage(player) < exit.stage) {
      // Before reading the journal there is no reason to go down (5DPM8u).
      if (key === "1308,3467") player.sendMessage("You have no reason to go down there.");
      return;
    }
    climbTo(player, exit.to.x, exit.to.y, CLIMB_DOWN_ANIMATION);
  }

  function searchPrimaryTable(event) {
    const { player, objectId } = event;
    const dungeon = PRIMARY_TABLE_BY_DUNGEON.get(objectId);
    if (dungeon === undefined) return;
    event.handled = true;
    if (quest.getStage(player) !== dungeon + 1) return; // only the active dungeon's table
    player.sendMessage("You search the table and find a stone tablet. You take it.");
    player.getInventory().adds(TABLET_BY_DUNGEON[dungeon], 1);
  }

  function searchOtherObject(event) {
    const { player, objectId, location } = event;
    const type = SCENERY_TYPE_BY_ID.get(objectId);
    if (!type) return;
    const key = `${location.x},${location.y}`;
    if (!SPOT_TYPE_BY_KEY.has(key)) return;
    event.handled = true;
    const seen = searchedKeys(player);
    if (seen.has(key)) return;
    seen.add(key);
    player.setAttribute(SEARCHED_ATTRIBUTE, [...seen].sort().join("|"));
    const dungeon = dungeonAt(location.x, location.y);
    const rewards = OTHER_REWARDS[dungeon]?.[type] ?? [];
    const reward = rewards[countSearched(seen, dungeon, type) - 1];
    if (!reward) return;
    player.sendMessage(reward.text);
    if (reward.item !== undefined) player.getInventory().adds(reward.item, 1);
  }

  function handleObjectInteraction(event) {
    const { objectId } = event;
    if (objectId === TENT) return searchTent(event);
    if (objectId === CAMPING_EQUIPMENT) return searchCampingEquipment(event);
    if (objectId === HOLE) return descendHole(event);
    if (PRIMARY_TABLE_BY_DUNGEON.has(objectId)) return searchPrimaryTable(event);
    if (SCENERY_TYPE_BY_ID.has(objectId)) return searchOtherObject(event);
  }

  /** Ropes are claimed from the shared Ladders plugin before it guesses a floor. */
  function claimRopeClimb(request) {
    const exit = ROPE_EXITS.get(request.objectId);
    if (!exit) return;
    request.handled = true;
    climbTo(request.player, exit.x, exit.y, CLIMB_UP_ANIMATION);
  }

  /** OSRS blocks teleports while inside the four ruins (7 December 2022 change). */
  function blockDungeonTeleport(event) {
    const location = event.player?.getLocation?.();
    if (!location || !inQuestDungeon(location.x, location.y)) return;
    event.allow = false;
    event.player.sendMessage("An ancient magical force blocks your teleport.");
  }

  // ==========================================================================
  // Item interactions
  // ==========================================================================

  function readJournal(event) {
    if (!quest.isStarted(event.player)) return;
    event.handled = true;
    if (quest.getStage(event.player) < STAGE_JOURNAL_READ) {
      quest.setStage(event.player, STAGE_JOURNAL_READ);
    }
  }

  function readWordTranslations(event) {
    const { player } = event;
    if (!quest.isStarted(player)) return;
    event.handled = true;
    const dungeon = currentDungeon(quest.getStage(player));
    if (dungeon) {
      const base = WORD_BASE[dungeon - 1];
      DUNGEON_WORDS[dungeon - 1].forEach((_, index) => discoverWord(player, base + index));
      if (!dungeonWordsDiscovered(player, dungeon)) return;
      player.sendMessage("You feel that you've translated enough words to read some of the text on the stone tablet.");
      if (quest.getStage(player) < STAGE_JOURNAL_READ + dungeon) {
        quest.setStage(player, STAGE_JOURNAL_READ + dungeon);
      }
      ensureEntrances(player);
    }
    maybePlayFullyTranslated(player);
  }

  function readTablet(event) {
    const { player, itemId } = event;
    if (!quest.isStarted(player)) return;
    event.handled = true;
    if (itemId === STONE_TABLET_1 && !has(player, WORD_TRANSLATIONS)) {
      startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "the-first-dungeon-reading-the-stone-tablet");
      return;
    }
    if (
      itemId === STONE_TABLET_4 &&
      !has(player, WARNING_NOTE) &&
      quest.getStage(player) === STAGE_DUNGEON_4_DONE
    ) {
      startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "the-fourth-dungeon-reading-the-stone-tablet-after-translating-it");
    }
  }

  function readWarningNote(event) {
    const { player } = event;
    if (!quest.isStarted(player) || quest.isComplete(player)) return;
    event.handled = true;
    startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "the-fourth-dungeon-reading-the-warning-note");
  }

  function inspectCarving(event) {
    event.handled = true;
    discoverWord(event.player, CARVING_WORD_INDEX.get(event.itemId));
  }

  function inspectCompass(event) {
    event.handled = true;
    event.player.sendMessage(
      "Rather than the usual labels, the compass points are instead marked as 'Makt', 'Uitt', 'Takam' and 'Silam'."
    );
    for (const index of COMPASS_WORD_INDEXES) discoverWord(event.player, index);
  }

  function handleItemAction(event) {
    const { itemId } = event;
    if (itemId === KASONDES_JOURNAL) return readJournal(event);
    if (itemId === WORD_TRANSLATIONS) return readWordTranslations(event);
    if (TABLET_ITEMS.has(itemId)) return readTablet(event);
    if (itemId === WARNING_NOTE) return readWarningNote(event);
    if (CARVING_WORD_INDEX.has(itemId)) return inspectCarving(event);
    if (itemId === COMPASS) return inspectCompass(event);
  }

  // ==========================================================================
  // Transcript events
  // ==========================================================================

  function handleStartHook({ player, npcId, hook }) {
    if (npcId !== TRANSCRIPT_NPC_ID || hook !== START_HOOK) return;
    if (quest.getStage(player) === 0) quest.setStage(player, STAGE_STARTED);
  }

  function answerCondition({ npcId, player, stepId }) {
    if (npcId !== TRANSCRIPT_NPC_ID) return null;
    if (stepId === CAMP_NO_SECATEURS_CONDITION) return !hasSecateurs(player);
    if (stepId === CAMP_HAS_SECATEURS_CONDITION) return hasSecateurs(player);
    if (stepId === D4_FULL_INVENTORY_CONDITION) return player.getInventory().isFull();
    if (stepId === D4_HAS_SPACE_CONDITION) return !player.getInventory().isFull();
    return null;
  }

  function handleTranscriptAction(event) {
    if (event.npcId !== TRANSCRIPT_NPC_ID) return;
    const { player, stepId } = event;
    if (stepId === JOURNAL_FOUND_ACTION) {
      event.handled = true;
      player.sendMessage(event.text);
      if (!has(player, KASONDES_JOURNAL)) player.getInventory().adds(KASONDES_JOURNAL, 1);
      return;
    }
    if (stepId === SECATEURS_FOUND_ACTION) {
      event.handled = true;
      player.sendMessage(event.text);
      if (!hasSecateurs(player)) player.getInventory().adds(SECATEURS, 1);
      return;
    }
    if (stepId === WORD_TRANSLATIONS_ACTION) {
      event.handled = true;
      player.sendMessage(event.text);
      if (!has(player, WORD_TRANSLATIONS)) player.getInventory().adds(WORD_TRANSLATIONS, 1);
      return;
    }
    if (stepId === WARNING_NOTE_ACTION) {
      event.handled = true;
      player.sendMessage(event.text);
      if (!has(player, WARNING_NOTE)) player.getInventory().adds(WARNING_NOTE, 1);
      return;
    }
    if (stepId === QUEST_COMPLETE_ACTION) {
      event.handled = true;
      if (!quest.isComplete(player)) quest.complete(player);
    }
  }

  // ==========================================================================
  // Journal and reward
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I explored the four ancient ruins and translated the Old Ones' language.</str>",
        "<str>I discovered their fate and Kasonde's warning about soul transference.</str>",
        "<str>I was rewarded with a Quest Point and 10,000 Farming experience.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage === STAGE_DUNGEON_4_DONE) {
      return [
        "<str>I explored the four ancient ruins and translated their words.</str>",
        "",
        "I should read the final stone tablet again, then the warning note.",
      ];
    }
    if (stage >= STAGE_JOURNAL_READ) {
      const dungeon = currentDungeon(stage);
      return [
        "<str>I found Kasonde's journal at the abandoned campsite.</str>",
        "<str>I read about the Old Ones and the ruins they left behind.</str>",
        "",
        `I am exploring the ancient ruins (${dungeon} of 4). I should translate`,
        "the words I find so I can read the stone tablets.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "<str>I searched the tent and found Kasonde's journal.</str>",
        "",
        "I should read the <col=800000>journal</col>.",
      ];
    }
    return [
      "I can start this quest by searching the <col=800000>Tent</col> at the",
      "campsite in the south of the <col=800000>Kebos Lowlands</col>.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.FARMING, 10000);
  }

  function handleLogin({ player }) {
    installSearchableScenery();
    ensureEntrances(player);
    refreshQuestList(player);
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  api.persistAttribute(WORDS_ATTRIBUTE);
  api.persistAttribute(SEARCHED_ATTRIBUTE);
  api.persistAttribute(FULLY_TRANSLATED_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "the_garden_of_death",
    name: "The Garden of Death",
    varpId: VARP_ID,
    varbitId: VARBIT_ID,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.FARMING.getIndex(), amount: 10000, label: "Farming" }],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:action", handleTranscriptAction);
  api.onItemAction(handleItemAction);
  api.onObjectInteraction(handleObjectInteraction);
  api.onCustomEvent("ladders:climb", claimRopeClimb);
  api.onCanTeleport(blockDungeonTeleport);
  api.onPlayerLogin(handleLogin);
};
