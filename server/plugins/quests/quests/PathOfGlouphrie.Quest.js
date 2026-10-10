/**
 * The Path of Glouphrie (members).
 *
 * The words come from the "The Path of Glouphrie" transcript page. This plugin supplies
 * the variant selectors for the shared gnome NPCs (King Bolren, Golrie, Gianne jnr.,
 * Longramble), the Hazelmere Talk-to interception (Eyes of Glouphrie's variant selector
 * answers for him first), the prose-condition answers, the storeroom (monoliths, chests,
 * singing bowl, strongroom gate, diary lectern), Yewnock's machine and exchanger, the
 * Incomitatus spirit tree, the warped terrorbirds and the final cutscene/rewards.
 *
 * Stages (varbit 15288 "pog", varp 3992 bits 0-8; cache script 4024 quest id 3425):
 * 1 started, 2 Golrie told about the storeroom, 3 crystal chime made, 4 diary read,
 * 5 machine activated (Dumpling revealed), 6 evil creature killed, 7 told to find
 * Longramble, 8 Gianne gave the coordinates, 9 Longramble found, 10 Incomitatus healed,
 * 11 terrorbirds defeated, 12 complete. Sibling varbits are set alongside: 15289-15290
 * bowl/chime, 15291-15293 diary chapters, 15294 watcher reveal, 15295-15298 return
 * flags.
 *
 * Requirements per the wiki: The Eyes of Glouphrie, Waterfall Quest and Tree Gnome
 * Village complete, 60 Strength, 56 Slayer, 56 Thieving, 47 Ranged, 45 Agility (not
 * boostable). Rewards: 2 Quest points, four magic lamps (30,000 Strength, 20,000
 * Slayer, 5,000 Thieving, 5,000 Magic XP), the Poison Waste Dungeon and Incomitatus.
 *
 * Source: https://oldschool.runescape.wiki/w/The_Path_of_Glouphrie and
 * https://oldschool.runescape.wiki/w/Transcript:The_Path_of_Glouphrie.
 *
 * Gaps/approximations:
 * - the storeroom is not instanced: the tree/bowl swaps and one player's monolith
 *   pushes are shared world state. The monoliths push and reset but the chests are not
 *   gated on the puzzle. Unlocking the strongroom removes the gate loc (both cached
 *   gate states are solid walls) instead of swapping it.
 * - the chests hand out a fixed disc set instead of random discs, and Yewnock's machine
 *   wants two discs totalling 20 (the real interface is replaced by chatbox messages).
 *   The exchanger splits discs but the two-value random puzzle is not reproduced.
 * - Bolrie's diary chapters are read in order from the lectern instead of a chapter
 *   menu; the wiki's "chapter seen" markers (unavailable steps) are skipped.
 * - the warped depths are entered directly from the sewer entrance; three terrorbirds
 *   spawn in the first chamber and peeking through the heavy door plays the full
 *   cutscene. The long dungeon route and the warped tortoises are not walked/spawned.
 * - the crystal chime is not required to damage the terrorbirds, and the final teleport
 *   to Hazelmere's house is not replayed (cutscenes are chatbox text only). Destroyed
 *   magic lamps cannot be reclaimed from Hazelmere.
 */
module.exports = function registerPathOfGlouphrieQuest(api) {
  const {
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

  const PAGE = "The Path of Glouphrie";
  const HAZELMERE_PAGE = "Hazelmere";
  const GOLRIE_PAGE = "Golrie";
  const START_HOOK = "quest:the-path-of-glouphrie:start";

  const VARP_POG = 3992;
  const VARBIT_POG_STAGE = 15288; // "pog", varp 3992 bits 0-8
  const VARBIT_BOWL_EXAMINED = 15289;
  const VARBIT_BOWL_CHIME = 15290;
  const VARBIT_DIARY_1 = 15291;
  const VARBIT_DIARY_2 = 15292;
  const VARBIT_DIARY_3 = 15293;
  const VARBIT_WATCHER = 15294; // "pog_watcher_multivar"
  const VARBIT_GOLRIE_RETURN = 15295;
  const VARBIT_LONGRAMBLE_DONE = 15296;
  const VARBIT_LONGRAMBLE_DELIVERY = 15297;
  const VARBIT_KING_BOLREN_DONE = 15298;

  const STAGE_NOT_STARTED = 0;
  const STAGE_STARTED = 1;
  const STAGE_GOLRIE_TOLD = 2;
  const STAGE_CHIME_MADE = 3;
  const STAGE_DIARY_READ = 4;
  const STAGE_MACHINE_ACTIVATED = 5;
  const STAGE_CREATURE_KILLED = 6;
  const STAGE_SENT_FOR_LONGRAMBLE = 7;
  const STAGE_HAS_COORDINATES = 8;
  const STAGE_LONGRAMBLE_MET = 9;
  const STAGE_TREE_HEALED = 10;
  const STAGE_BIRDS_DEAD = 11;
  const STAGE_COMPLETE = 12;

  const STRENGTH_REQUIREMENT = 60;
  const SLAYER_REQUIREMENT = 56;
  const THIEVING_REQUIREMENT = 56;
  const RANGED_REQUIREMENT = 47;
  const AGILITY_REQUIREMENT = 45;

  const KING_BOLREN_NPC_ID = NpcIdentifiers.KING_BOLREN; // 4963
  const GOLRIE_NPC_IDS = new Set([NpcIdentifiers.GOLRIE, NpcIdentifiers.GOLRIE_2]); // 892, 4183
  const GIANNE_JNR_NPC_ID = NpcIdentifiers.GIANNE_JNR_; // 2547
  const LONGRAMBLE_NPC_ID = NpcIdentifiers.LONGRAMBLE; // 12466
  const HAZELMERE_NPC_ID = NpcIdentifiers.HAZELMERE; // 1422
  const HAZELMERE_NPC_IDS = new Set([NpcIdentifiers.HAZELMERE, NpcIdentifiers.HAZELMERE_2]); // 1422, 4647
  const KING_BOLRIE_NPC_ID = NpcIdentifiers.KING_BOLRIE; // 12471
  const CUTE_CREATURE_NPC_ID = NpcIdentifiers.CUTE_CREATURE_7; // 12476
  const EVIL_CREATURE_NPC_ID = NpcIdentifiers.EVIL_CREATURE_7; // 12477
  const BIG_MONOLITH_NPC_ID = NpcIdentifiers.COL_00FFFF_BIG_MONOLITH_COL; // 12486
  const SMALL_MONOLITH_NPC_ID = NpcIdentifiers.COL_00FFFF_SMALL_MONOLITH_COL; // 12487
  const WARPED_TERRORBIRD_NPC_IDS = [
    NpcIdentifiers.WARPED_TERRORBIRD, // 12491
    NpcIdentifiers.WARPED_TERRORBIRD_2, // 12492
    NpcIdentifiers.WARPED_TERRORBIRD_3, // 12493
  ];

  const TANGLED_TOADS_LEGS_ITEM_ID = ItemIdentifiers.TANGLED_TOADS_LEGS; // 2187
  const MINT_CAKE_ITEM_ID = ItemIdentifiers.MINT_CAKE; // 9475
  const CHEST_KEY_ITEM_ID = ItemIdentifiers.CHEST_KEY_9; // 28573
  const STRONGROOM_KEY_ITEM_ID = ItemIdentifiers.STRONGROOM_KEY; // 28574
  const CRYSTAL_CHIME_SEED_ITEM_ID = ItemIdentifiers.CRYSTAL_CHIME_SEED; // 28575
  const CRYSTAL_CHIME_ITEM_ID = ItemIdentifiers.CRYSTAL_CHIME; // 28577
  const YEWNOCKS_NOTES_ITEM_ID = ItemIdentifiers.YEWNOCKS_NOTES; // 28579
  const RED_CIRCLE_ITEM_ID = ItemIdentifiers.RED_CIRCLE; // 9597
  const RED_TRIANGLE_ITEM_ID = ItemIdentifiers.RED_TRIANGLE; // 9598
  const RED_SQUARE_ITEM_ID = ItemIdentifiers.RED_SQUARE; // 9599
  const ORANGE_SQUARE_ITEM_ID = ItemIdentifiers.ORANGE_SQUARE; // 9603
  const YELLOW_TRIANGLE_ITEM_ID = ItemIdentifiers.YELLOW_TRIANGLE; // 9606
  const GREEN_SQUARE_ITEM_ID = ItemIdentifiers.GREEN_SQUARE; // 9611
  const FIRST_DISC_ITEM_ID = RED_CIRCLE_ITEM_ID; // 9597
  const LAST_DISC_ITEM_ID = ItemIdentifiers.VIOLET_PENTAGON; // 9624
  const LAMP_ITEM_IDS = [
    ItemIdentifiers.MAGIC_LAMP_STRENGTH_, // 28587
    ItemIdentifiers.MAGIC_LAMP_SLAYER_, // 28588
    ItemIdentifiers.MAGIC_LAMP_THIEVING_, // 28589
    ItemIdentifiers.MAGIC_LAMP_MAGIC_, // 28590
  ];
  const LAMP_XP = new Map([
    [ItemIdentifiers.MAGIC_LAMP_STRENGTH_, { skill: Skill.STRENGTH, amount: 30000, label: "Strength" }],
    [ItemIdentifiers.MAGIC_LAMP_SLAYER_, { skill: Skill.SLAYER, amount: 20000, label: "Slayer" }],
    [ItemIdentifiers.MAGIC_LAMP_THIEVING_, { skill: Skill.THIEVING, amount: 5000, label: "Thieving" }],
    [ItemIdentifiers.MAGIC_LAMP_MAGIC_, { skill: Skill.MAGIC, amount: 5000, label: "Magic" }],
  ]);

  const DYING_SPIRIT_TREE_OBJECT_ID = ObjectIdentifiers.SPIRIT_TREE_24; // 49592
  const HEALTHY_SPIRIT_TREE_OBJECT_ID = ObjectIdentifiers.SPIRIT_TREE_27; // 49595
  const SINGING_BOWL_INSPECT_OBJECT_ID = ObjectIdentifiers.SINGING_BOWL_5; // 49610
  const SINGING_BOWL_SING_OBJECT_ID = ObjectIdentifiers.SINGING_BOWL_6; // 49611
  const WOOD_CHEST_OBJECT_ID = ObjectIdentifiers.CHEST_230; // 49612
  const SEARCH_CHEST_OBJECT_ID = ObjectIdentifiers.CHEST_235; // 49617
  const STOREROOM_TUNNEL_ENTRY_OBJECT_ID = ObjectIdentifiers.TUNNEL_59; // 49619
  const STOREROOM_TUNNEL_EXIT_OBJECT_ID = ObjectIdentifiers.TUNNEL_61; // 49623
  const STRONGROOM_GATE_OBJECT_ID = ObjectIdentifiers.GATE_283; // 49657
  const STRONGROOM_GATE_OPEN_OBJECT_ID = ObjectIdentifiers.GATE_284; // 49658
  const MACHINE_OBJECT_ID = ObjectIdentifiers.YEWNOCKS_MACHINE_2; // 49662
  const EXCHANGER_OBJECT_ID = ObjectIdentifiers.YEWNOCKS_EXCHANGER; // 49663
  const LECTERN_OBJECT_ID = ObjectIdentifiers.LECTERN_16; // 49673
  const HEAVY_DOOR_OBJECT_ID = ObjectIdentifiers.HEAVY_DOOR_10; // 49600
  const SEWER_ENTRANCE_OBJECT_ID = ObjectIdentifiers.SEWER_ENTRANCE; // 49868

  const BOLREN_START_VARIANT = "the-king-s-little-dumpling-talking-to-king-bolren";
  const GOLRIE_DEVICE_CHOICE = "i need your help with a device";
  const GIANNE_LONGRAMBLE_CHOICE = "i need your help finding a certain gnome";
  const TREE_FIRST_VARIANT = "arbor-incomitata-talking-to-the-spirit-tree-after-talking-to-longramble";
  const TREE_AGAIN_VARIANT = `${TREE_FIRST_VARIANT}-talking-to-the-spirit-tree-again`;
  const TREE_CHIME_VARIANT = "arbor-incomitata-using-the-crystal-chime-on-the-spirit-tree";
  const HAZELMERE_HOUSE_VARIANT = "arbor-incomitata-talking-to-hazelmere-at-his-house-after-talking-to-the-spirit-tree";
  const HAZELMERE_LAMPS_VARIANT =
    "post-quest-talking-to-hazelmere-to-receive-unused-lamps-if-the-player-has-sufficient-inventory-space";
  const HAZELMERE_POST_VARIANT = "post-quest-talking-to-hazelmere-after-the-quest";
  const HAZELMERE_STANDARD_VARIANT = "standard-dialogue-after-the-path-of-glouphrie";
  const FINAL_VARIANT = "the-warped-depths";
  const DIARY_VARIANTS = [
    "yewnock-s-legacy-bolrie-s-diary-chapter-1-bad-advice",
    "yewnock-s-legacy-bolrie-s-diary-chapter-2-the-king-is-dead",
    "yewnock-s-legacy-bolrie-s-diary-chapter-3-eyes-opened",
  ];

  const CONTINUE_STEP_IDS = new Set([
    "5lkTkp", // diary chapter 1 seen marker
    "0wqCOz", // diary chapter 2 seen marker
    "UoUSjz", // diary chapter 3 seen markers
    "GcmILY",
    "QyHx26", // tree talk: never carried a chime
    "AocdR6", // post-quest lamp hand-out preamble
    "3ZrkVR", // post-quest Longramble tail
  ]);
  const COMPLETE_STEP_ID = "Lv5xyo";
  const TREE_CHIME_ACTION_ID = "QJ5K9p";
  const TOADS_GIVE_STEP_ID = "fVX5us";
  const CAKE_RECEIVE_STEP_ID = "HDplvK";
  const LAMPS_MULTIPLE_STEP_ID = "sQ9r5K";
  const LAMP_SINGLE_STEP_ID = "BCME6O";

  const CONDITION_HAS_TOADS = "f30JUB";
  const CONDITION_HAS_CHIME = "0ge934";
  const CONDITION_HAD_CHIME = "f37U6O";
  const CONDITION_NEVER_CHIME = "tsyuaC";
  const CONDITION_NO_CHIME = "vbBzqR";
  const CONDITION_HOLDING_CHIME = "SGuWuR";
  const CONDITION_MULTIPLE_LAMPS = "7wS26R";
  const CONDITION_ONE_LAMP = "801q-d";

  const BITS_ATTRIBUTE = "quest.the_path_of_glouphrie.bits";
  const LAMPS_ATTRIBUTE = "quest.the_path_of_glouphrie.lamps";
  const BIRD_ATTRIBUTE = "the-path-of-glouphrie:terrorbird";
  const LAMP_VARBITS = [15305, 15306, 15307, 15308]; // pog_strength/slayer/thieving/magic_lamp
  const BIT_BOWL_EXAMINED = 1 << 0;
  const BIT_CHIME = 1 << 1;
  const BIT_GATE = 1 << 2;
  const BIT_TREE_SPOKEN = 1 << 3;
  const BIT_TREE_HEALED = 1 << 4;
  const BIT_LONGRAMBLE_MET = 1 << 5;
  const BIT_LONGRAMBLE_TRADED = 1 << 6;
  const BIT_BOLREN_DONE = 1 << 7;
  const DIARY_BITS = [1 << 8, 1 << 9, 1 << 10];
  const CHEST_BITS = {
    "2789,4258": 1 << 11,
    "2788,4262": 1 << 12,
    "2791,4249": 1 << 13,
    "2793,4253": 1 << 14,
  };
  const MONOLITH_BITS = [1 << 15, 1 << 16, 1 << 17, 1 << 18];
  const BIRD_BITS = [1 << 19, 1 << 20, 1 << 21];
  const BIT_MACHINE = 1 << 22;
  const BIT_CREATURE_KILLED = 1 << 23;

  const MACHINE_SLOTS = 2;
  const MACHINE_TARGET_VALUE = 20;
  const SHAPE_VALUES = [1, 3, 4, 5];

  const STOREROOM_LANDING = new Location(2789, 4243, 0);
  const TUNNEL_BACK_LANDING = new Location(2544, 9570, 0);
  const BOWL_TILE = new Location(2790, 4260, 0);
  const GATE_TILE = new Location(2782, 4255, 0);
  const SPIRIT_TREE_TILE = new Location(2339, 3111, 0);
  const LONGRAMBLE_TILE = new Location(2339, 3107, 0);
  const CUTE_CREATURE_TILE = new Location(2541, 3169, 0);
  const DUNGEON_LANDING = new Location(2328, 3148, 1);
  const HEAVY_DOOR_TILE = new Location(2345, 3152, 1);
  const TERRORBIRD_TILES = [
    new Location(2326, 3150, 1),
    new Location(2330, 3151, 1),
    new Location(2334, 3152, 1),
  ];
  const MONOLITH_SPAWNS = [
    { id: BIG_MONOLITH_NPC_ID, x: 2788, y: 4245, destX: 2788, destY: 4244 },
    { id: BIG_MONOLITH_NPC_ID, x: 2788, y: 4250, destX: 2788, destY: 4252 },
    { id: SMALL_MONOLITH_NPC_ID, x: 2787, y: 4247, destX: 2791, destY: 4247 },
    { id: SMALL_MONOLITH_NPC_ID, x: 2792, y: 4252, destX: 2792, destY: 4260 },
  ];

  // Owner-scoped NPCs must exist as soon as their stage/area is reached, not only after a
  // relog: each zone ensures the NPCs it gates.
  const VILLAGE_ZONE = { minX: 2530, maxX: 2560, minY: 3155, maxY: 3185, levels: [0] };
  const LONGRAMBLE_ZONE = { minX: 2320, maxX: 2360, minY: 3095, maxY: 3125, levels: [0] };
  const STOREROOM_ZONE = { minX: 2770, maxX: 2805, minY: 4235, maxY: 4275, levels: [0] };
  const WARPED_DEPTHS_ZONE = { minX: 2310, maxX: 2360, minY: 3140, maxY: 3165, levels: [1] };

  let quest;
  let treeObject = null;
  let bowlObject = null;
  let heavyDoorObject = null;
  let treeHealed = false;
  let bowlSung = false;
  let gateUnlocked = false;
  let heavyDoorInstalled = false;
  const cuteByPlayer = new Map();
  const evilByPlayer = new Map();
  const monolithsByPlayer = new Map();
  const birdsByPlayer = new Map();
  const longrambleByPlayer = new Map();
  const machineProgress = new WeakMap();

  const held = (player, itemId) => player.getInventory().getAmount(itemId) > 0;
  const isGolrie = (npcId) => GOLRIE_NPC_IDS.has(npcId);
  const isHazelmere = (npcId) => HAZELMERE_NPC_IDS.has(npcId);

  function bits(player) {
    return Number(player.getAttribute(BITS_ATTRIBUTE)) || 0;
  }

  function hasBit(player, bit) {
    return (bits(player) & bit) !== 0;
  }

  function setBit(player, bit) {
    player.setAttribute(BITS_ATTRIBUTE, bits(player) | bit);
  }

  function lampCount(player) {
    return Number(player.getAttribute(LAMPS_ATTRIBUTE)) || 0;
  }

  function setLampCount(player, count) {
    player.setAttribute(LAMPS_ATTRIBUTE, count | 0);
  }

  function lampsRemaining(player) {
    return Math.max(0, LAMP_ITEM_IDS.length - lampCount(player));
  }

  function sendVarbit(player, varbitId, value) {
    player.getPacketSender().sendVarbit(varbitId, value);
  }

  function questComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsStartRequirements(player) {
    const skills = player.getSkillManager();
    return (
      questComplete(player, "the_eyes_of_glouphrie") &&
      questComplete(player, "waterfall_quest") &&
      questComplete(player, "tree_gnome_village") &&
      skills.getMaxLevel(Skill.STRENGTH) >= STRENGTH_REQUIREMENT &&
      skills.getMaxLevel(Skill.SLAYER) >= SLAYER_REQUIREMENT &&
      skills.getMaxLevel(Skill.THIEVING) >= THIEVING_REQUIREMENT &&
      skills.getMaxLevel(Skill.RANGED) >= RANGED_REQUIREMENT &&
      skills.getMaxLevel(Skill.AGILITY) >= AGILITY_REQUIREMENT
    );
  }

  function playVariant(player, npcId, variant) {
    startTranscript(api, player, npcId, PAGE, variant);
  }

  function grantItem(player, itemId, amount = 1) {
    if (player.getInventory().getFreeSlots() < amount) {
      player.sendMessage("You need more inventory space.");
      return false;
    }
    player.getInventory().adds(itemId, amount);
    return true;
  }

  function discValue(itemId) {
    if (itemId < FIRST_DISC_ITEM_ID || itemId > LAST_DISC_ITEM_ID) return 0;
    const offset = itemId - FIRST_DISC_ITEM_ID;
    return ((offset >> 2) + 1) * SHAPE_VALUES[offset & 3];
  }

  const DISC_ITEM_BY_VALUE = new Map();
  for (let itemId = FIRST_DISC_ITEM_ID; itemId <= LAST_DISC_ITEM_ID; itemId++) {
    const value = discValue(itemId);
    if (!DISC_ITEM_BY_VALUE.has(value)) DISC_ITEM_BY_VALUE.set(value, itemId);
  }
  const DISC_VALUES_DESCENDING = [...DISC_ITEM_BY_VALUE.keys()].sort((a, b) => b - a);

  function splitDisc(value) {
    for (const high of DISC_VALUES_DESCENDING) {
      if (high >= value) continue;
      const low = value - high;
      if (DISC_ITEM_BY_VALUE.has(low)) {
        return [DISC_ITEM_BY_VALUE.get(high), DISC_ITEM_BY_VALUE.get(low)];
      }
    }
    return null;
  }

  function ensureObject(objectId, location, type = 10, face = 0) {
    for (const object of ObjectManager.objectsAt(location)) {
      if (object.getId() === objectId) return object;
    }
    const object = new GameObject(objectId, location.clone(), type, face, null);
    ObjectManager.register(object, true);
    return object;
  }

  function ensureTree() {
    if (treeObject) return;
    const id = treeHealed ? HEALTHY_SPIRIT_TREE_OBJECT_ID : DYING_SPIRIT_TREE_OBJECT_ID;
    treeObject = ensureObject(id, SPIRIT_TREE_TILE, 10, 0);
  }

  function replaceTree() {
    if (treeObject) ObjectManager.deregister(treeObject, true);
    treeObject = null;
    treeHealed = true;
    treeObject = ensureObject(HEALTHY_SPIRIT_TREE_OBJECT_ID, SPIRIT_TREE_TILE, 10, 0);
  }

  function ensureBowl() {
    if (bowlObject) return;
    const id = bowlSung ? SINGING_BOWL_SING_OBJECT_ID : SINGING_BOWL_INSPECT_OBJECT_ID;
    bowlObject = ensureObject(id, BOWL_TILE, 10, 0);
  }

  function replaceBowl() {
    if (bowlObject) ObjectManager.deregister(bowlObject, true);
    bowlObject = null;
    bowlSung = true;
    bowlObject = ensureObject(SINGING_BOWL_SING_OBJECT_ID, BOWL_TILE, 10, 0);
  }

  function ensureHeavyDoor() {
    if (heavyDoorInstalled) return;
    heavyDoorInstalled = true;
    heavyDoorObject = ensureObject(HEAVY_DOOR_OBJECT_ID, HEAVY_DOOR_TILE, 0, 0);
  }

  function ensureQuestObjects() {
    ensureTree();
    ensureBowl();
  }

  function syncVarbits(player) {
    sendVarbit(player, VARBIT_BOWL_EXAMINED, hasBit(player, BIT_BOWL_EXAMINED) ? 1 : 0);
    sendVarbit(player, VARBIT_BOWL_CHIME, hasBit(player, BIT_CHIME) ? 1 : 0);
    DIARY_BITS.forEach((bit, index) => sendVarbit(player, VARBIT_DIARY_1 + index, hasBit(player, bit) ? 1 : 0));
    sendVarbit(player, VARBIT_WATCHER, hasBit(player, BIT_MACHINE) ? 1 : 0);
    sendVarbit(player, VARBIT_GOLRIE_RETURN, hasBit(player, BIT_GATE) ? 1 : 0);
    sendVarbit(player, VARBIT_LONGRAMBLE_DONE, hasBit(player, BIT_LONGRAMBLE_MET) ? 1 : 0);
    sendVarbit(player, VARBIT_LONGRAMBLE_DELIVERY, hasBit(player, BIT_LONGRAMBLE_TRADED) ? 1 : 0);
    sendVarbit(player, VARBIT_KING_BOLREN_DONE, hasBit(player, BIT_BOLREN_DONE) ? 1 : 0);
    LAMP_VARBITS.forEach((varbitId, index) => sendVarbit(player, varbitId, lampCount(player) > index ? 1 : 0));
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>King Bolren's new pet was another of Glouphrie's spies.</str>",
        "<str>I unmasked it with Yewnock's machine, healed the spirit</str>",
        "<str>tree Incomitatus, and was rescued from the sewers beneath</str>",
        "<str>Arposandra by Hazelmere.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_BIRDS_DEAD) {
      return ["The terrorbirds are dead. I should look beyond the heavy door to the east."];
    }
    if (stage >= STAGE_TREE_HEALED) {
      return [
        "Incomitatus is healed. I should find the source of the",
        "poison in the <col=800000>Poison Waste Dungeon</col>.",
      ];
    }
    if (stage >= STAGE_LONGRAMBLE_MET) {
      return [
        "I found <col=800000>Longramble</col> by the Poison Waste. He told me of",
        "a waste outlet patrolled by a warped creature, and a sick",
        "spirit tree, <col=800000>Incomitatus</col>, needs my crystal chime.",
      ];
    }
    if (stage >= STAGE_HAS_COORDINATES) {
      return ["<col=800000>Gianne jnr.</col> gave me Longramble's coordinates; I should find him."];
    }
    if (stage >= STAGE_SENT_FOR_LONGRAMBLE) {
      return [
        "King Bolren asked me to find the explorer <col=800000>Longramble</col>.",
        "Aluft <col=800000>Gianne jnr.</col> at the Grand Tree knows where he is.",
      ];
    }
    if (stage >= STAGE_CREATURE_KILLED) {
      return ["I killed the evil creature. I should speak to <col=800000>King Bolren</col>."];
    }
    if (stage >= STAGE_MACHINE_ACTIVATED) {
      return ["<col=800000>Dumpling</col> was revealed as an evil creature. I must kill it."];
    }
    if (stage >= STAGE_DIARY_READ) {
      return ["I read Bolrie's diary. I should operate <col=800000>Yewnock's machine</col>."];
    }
    if (stage >= STAGE_CHIME_MADE) {
      return ["I made the <col=800000>crystal chime</col>. I should read Bolrie's diary on the lectern."];
    }
    if (stage >= STAGE_GOLRIE_TOLD) {
      return [
        "Golrie told me to search the storeroom past the small tunnel",
        "in the eastern chamber of the village dungeon.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "King Bolren has another of Glouphrie's spies for a pet.",
        "I need an anti-illusion device; Golrie may know of one.",
      ];
    }
    return [
      "I can start this quest by speaking to <col=800000>King Bolren</col>",
      "in the <col=800000>Tree Gnome Village</col>.",
      "",
      "Requirements: The Eyes of Glouphrie, Waterfall Quest, Tree",
      "Gnome Village, 60 Strength, 56 Slayer, 56 Thieving, 47",
      "Ranged, 45 Agility.",
    ];
  }

  function grantLamps(player) {
    const inventory = player.getInventory();
    let granted = lampCount(player);
    while (granted < LAMP_ITEM_IDS.length) {
      if (inventory.getFreeSlots() < 1) {
        player.sendMessage("You have no room for all the magic lamps; speak to Hazelmere to claim the rest.");
        break;
      }
      inventory.adds(LAMP_ITEM_IDS[granted], 1);
      sendVarbit(player, LAMP_VARBITS[granted], 1);
      granted += 1;
      setLampCount(player, granted);
    }
  }

  function handleLampAction(event) {
    const { player, itemId, slot } = event;
    const reward = LAMP_XP.get(itemId);
    if (!reward) return false;
    event.handled = true;
    const manager = player.getSkillManager();
    const before = manager.getExperience(reward.skill);
    manager.addExperiences(reward.skill, reward.amount);
    if (manager.getExperience(reward.skill) === before) {
      player.sendMessage("Your experience cannot be increased right now.");
      return true;
    }
    player.getInventory().deleteAtSlot(slot, 1);
    player.sendMessage(`You rub the lamp and gain ${reward.amount.toLocaleString("en-US")} ${reward.label} experience.`);
    return true;
  }

  // ==========================================================================
  // Dialogue: variant selection
  // ==========================================================================

  function bolrenVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return "post-quest-talking-to-king-bolren-after-the-quest";
    if (stage >= STAGE_LONGRAMBLE_MET) {
      return "arbor-incomitata-talking-to-king-bolren-after-talking-to-longramble";
    }
    if (stage >= STAGE_SENT_FOR_LONGRAMBLE) {
      return "yewnock-s-legacy-talking-to-king-bolren-after-killing-the-evil-creature-talking-to-king-bolren-again";
    }
    if (stage === STAGE_CREATURE_KILLED) {
      return "yewnock-s-legacy-talking-to-king-bolren-after-killing-the-evil-creature";
    }
    if (stage === STAGE_MACHINE_ACTIVATED) {
      return "yewnock-s-legacy-talking-to-king-bolren-after-activating-yewnock-s-machine";
    }
    if (stage >= STAGE_GOLRIE_TOLD) {
      return "the-king-s-little-dumpling-talking-to-king-bolren-after-talking-to-golrie";
    }
    if (stage >= STAGE_STARTED) {
      return "the-king-s-little-dumpling-talking-to-king-bolren-talking-to-bolren-again";
    }
    return meetsStartRequirements(player) ? BOLREN_START_VARIANT : null;
  }

  function golrieVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return { page: GOLRIE_PAGE, variant: "standard-dialogue-after-the-path-of-glouphrie" };
    }
    if (stage >= STAGE_MACHINE_ACTIVATED) {
      return "yewnock-s-legacy-talking-to-golrie-after-activating-yewnock-s-machine";
    }
    if (stage >= STAGE_DIARY_READ) {
      return "yewnock-s-legacy-talking-to-golrie-after-telling-him-you-found-the-device";
    }
    if (stage >= STAGE_GOLRIE_TOLD) {
      return "the-king-s-little-dumpling-talking-to-golrie-talking-to-golrie-again";
    }
    if (stage >= STAGE_STARTED) return "the-king-s-little-dumpling-talking-to-golrie";
    return null;
  }

  function gianneVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_HAS_COORDINATES && stage < STAGE_COMPLETE) {
      return "yewnock-s-legacy-talking-to-gianne-jnr-again";
    }
    if (stage === STAGE_SENT_FOR_LONGRAMBLE) return "yewnock-s-legacy-talking-to-gianne-jnr";
    return null;
  }

  function longrambleVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return "post-quest-talking-to-longramble-after-the-quest";
    if (stage >= STAGE_TREE_HEALED) {
      return "arbor-incomitata-talking-to-longramble-after-healing-the-spirit-tree";
    }
    if (stage >= STAGE_HAS_COORDINATES && hasBit(player, BIT_LONGRAMBLE_MET)) {
      return "arbor-incomitata-talking-to-longramble-talking-to-longramble-again";
    }
    if (stage >= STAGE_HAS_COORDINATES) return "arbor-incomitata-talking-to-longramble";
    return null;
  }

  /** Which transcript variant the clicked NPC plays. Side-effect free. */
  function selectVariant({ npcId, player }) {
    if (npcId === KING_BOLREN_NPC_ID) return bolrenVariant(player);
    if (isGolrie(npcId)) return golrieVariant(player);
    if (npcId === GIANNE_JNR_NPC_ID) return gianneVariant(player);
    if (npcId === LONGRAMBLE_NPC_ID) return longrambleVariant(player);
    return null;
  }

  /** Answer the page's prose conditions. */
  function answerCondition({ player, text, stepId }) {
    switch (stepId) {
      case CONDITION_HAS_TOADS:
        return held(player, TANGLED_TOADS_LEGS_ITEM_ID);
      case CONDITION_HAS_CHIME:
        return held(player, CRYSTAL_CHIME_ITEM_ID);
      case CONDITION_HAD_CHIME:
        return !held(player, CRYSTAL_CHIME_ITEM_ID) && hasBit(player, BIT_CHIME);
      case CONDITION_NEVER_CHIME:
        return !held(player, CRYSTAL_CHIME_ITEM_ID) && !hasBit(player, BIT_CHIME);
      case CONDITION_NO_CHIME:
        return !held(player, CRYSTAL_CHIME_ITEM_ID);
      case CONDITION_HOLDING_CHIME:
        return held(player, CRYSTAL_CHIME_ITEM_ID);
      case CONDITION_MULTIPLE_LAMPS:
        return lampsRemaining(player) > 1;
      case CONDITION_ONE_LAMP:
        return lampsRemaining(player) === 1;
      default:
        break;
    }
    return null;
  }

  function handleStartHook({ player, npcId, hook }) {
    if (npcId !== KING_BOLREN_NPC_ID || hook !== START_HOOK) return;
    if (quest.getStage(player) !== STAGE_NOT_STARTED) return;
    if (!meetsStartRequirements(player)) return;
    quest.setStage(player, STAGE_STARTED);
    ensureCuteCreature(player);
  }

  function handleChoice({ player, npcId, option }) {
    const choice = String(option ?? "").toLowerCase();
    if (isGolrie(npcId) && choice.includes(GOLRIE_DEVICE_CHOICE)) {
      if (quest.getStage(player) === STAGE_STARTED) quest.setStage(player, STAGE_GOLRIE_TOLD);
      ensureMonoliths(player);
      return;
    }
    if (npcId === GIANNE_JNR_NPC_ID && choice.includes(GIANNE_LONGRAMBLE_CHOICE)) {
      if (quest.getStage(player) === STAGE_SENT_FOR_LONGRAMBLE) quest.setStage(player, STAGE_HAS_COORDINATES);
      ensureLongramble(player);
    }
  }

  /** Stage transitions only the wiki's prose lines carry (no choice/action step). */
  function handleLine(event) {
    const { player, npcId, text } = event;
    if (!player || typeof text !== "string") return;
    if (text.includes("[player name]")) {
      event.text = text.replace(/\[player name\]/gi, String(player.getUsername()));
    }
    if (npcId === LONGRAMBLE_NPC_ID && text.startsWith("Mr Longramble, I presume?")) {
      if (quest.getStage(player) === STAGE_HAS_COORDINATES) quest.setStage(player, STAGE_LONGRAMBLE_MET);
      setBit(player, BIT_LONGRAMBLE_MET);
      sendVarbit(player, VARBIT_LONGRAMBLE_DONE, 1);
      return;
    }
    if (npcId === KING_BOLREN_NPC_ID && text.startsWith("Thank you for dealing with that")) {
      if (quest.getStage(player) === STAGE_CREATURE_KILLED) quest.setStage(player, STAGE_SENT_FOR_LONGRAMBLE);
      setBit(player, BIT_BOLREN_DONE);
      sendVarbit(player, VARBIT_KING_BOLREN_DONE, 1);
      ensureLongramble(player);
    }
  }

  function handleAction(event) {
    const { player, stepId } = event;
    if (CONTINUE_STEP_IDS.has(stepId)) {
      event.handled = true;
      return;
    }
    if (stepId === TOADS_GIVE_STEP_ID) {
      event.handled = true;
      if (!held(player, TANGLED_TOADS_LEGS_ITEM_ID)) return;
      player.getInventory().deleteNumber(TANGLED_TOADS_LEGS_ITEM_ID, 1);
      setBit(player, BIT_LONGRAMBLE_TRADED);
      sendVarbit(player, VARBIT_LONGRAMBLE_DELIVERY, 1);
      return;
    }
    if (stepId === CAKE_RECEIVE_STEP_ID) {
      event.handled = true;
      if (held(player, MINT_CAKE_ITEM_ID) || !hasBit(player, BIT_LONGRAMBLE_TRADED)) return;
      grantItem(player, MINT_CAKE_ITEM_ID, 1);
      return;
    }
    if (stepId === TREE_CHIME_ACTION_ID) {
      event.handled = true;
      healTree(player);
      return;
    }
    if (stepId === LAMPS_MULTIPLE_STEP_ID || stepId === LAMP_SINGLE_STEP_ID) {
      event.handled = true;
      grantLamps(player);
      return;
    }
    if (stepId === COMPLETE_STEP_ID) {
      event.handled = true;
      event.end = true;
      if (!quest.isComplete(player) && quest.getStage(player) >= STAGE_BIRDS_DEAD) quest.complete(player);
    }
  }

  // ==========================================================================
  // Hazelmere (Eyes of Glouphrie and The Grand Tree answer for him first)
  // ==========================================================================

  function talkToHazelmere(event) {
    const { player, npcId } = event;
    if (!isHazelmere(npcId)) return false;
    const stage = quest.getStage(player);
    if (stage < STAGE_LONGRAMBLE_MET) return false;
    if (stage >= STAGE_COMPLETE) {
      if (lampsRemaining(player) > 0 && !player.getInventory().isFull()) {
        playVariant(player, npcId, HAZELMERE_LAMPS_VARIANT);
      } else if (lampsRemaining(player) > 0) {
        player.sendMessage("You need more inventory space for Hazelmere's lamps.");
        playVariant(player, npcId, HAZELMERE_POST_VARIANT);
      } else {
        startTranscript(api, player, npcId, HAZELMERE_PAGE, HAZELMERE_STANDARD_VARIANT);
      }
      return true;
    }
    playVariant(player, npcId, HAZELMERE_HOUSE_VARIANT);
    return true;
  }

  // ==========================================================================
  // Spirit tree, singing bowl and the storeroom
  // ==========================================================================

  function healTree(player) {
    if (!treeHealed) replaceTree();
    if (quest.getStage(player) < STAGE_TREE_HEALED) quest.setStage(player, STAGE_TREE_HEALED);
    setBit(player, BIT_TREE_HEALED);
    ensureBirds(player);
  }

  function handleTreeTalk(event) {
    const { player, objectId } = event;
    if (objectId !== DYING_SPIRIT_TREE_OBJECT_ID) return false;
    const stage = quest.getStage(player);
    if (stage < STAGE_LONGRAMBLE_MET) {
      player.sendMessage("The tree doesn't look very well, or talkative.");
      return true;
    }
    if (stage >= STAGE_TREE_HEALED) return false;
    if (hasBit(player, BIT_TREE_SPOKEN)) {
      playVariant(player, HAZELMERE_NPC_ID, TREE_AGAIN_VARIANT);
    } else {
      setBit(player, BIT_TREE_SPOKEN);
      playVariant(player, HAZELMERE_NPC_ID, TREE_FIRST_VARIANT);
    }
    return true;
  }

  function useChimeOnTree(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_LONGRAMBLE_MET) {
      player.sendMessage("The tree doesn't look very well, or talkative.");
      return;
    }
    if (stage >= STAGE_TREE_HEALED) return;
    playVariant(player, HAZELMERE_NPC_ID, TREE_CHIME_VARIANT);
  }

  function handleBowlInspect(event) {
    if (event.objectId !== SINGING_BOWL_INSPECT_OBJECT_ID) return false;
    const { player } = event;
    setBit(player, BIT_BOWL_EXAMINED);
    sendVarbit(player, VARBIT_BOWL_EXAMINED, 1);
    player.sendMessage("The singing bowl hums faintly. Perhaps a crystal seed could be sung into it.");
    return true;
  }

  function makeChime(player) {
    if (!held(player, CRYSTAL_CHIME_SEED_ITEM_ID)) {
      player.sendMessage("You have nothing to sing into the bowl.");
      return;
    }
    player.getInventory().deleteNumber(CRYSTAL_CHIME_SEED_ITEM_ID, 1);
    player.getInventory().adds(CRYSTAL_CHIME_ITEM_ID, 1);
    setBit(player, BIT_CHIME);
    sendVarbit(player, VARBIT_BOWL_CHIME, 1);
    if (!bowlSung) replaceBowl();
    if (quest.getStage(player) === STAGE_GOLRIE_TOLD) quest.setStage(player, STAGE_CHIME_MADE);
    advanceToMachineReady(player);
    player.sendMessage("You sing to the crystal seed and it forms into a crystal chime.");
  }

  function handleBowlSing(event) {
    if (event.objectId !== SINGING_BOWL_SING_OBJECT_ID) return false;
    makeChime(event.player);
    return true;
  }

  function handleChestSearch(event) {
    const { player, objectId, location } = event;
    if (objectId !== WOOD_CHEST_OBJECT_ID && objectId !== SEARCH_CHEST_OBJECT_ID) return false;
    const key = `${location.x},${location.y}`;
    const bit = CHEST_BITS[key];
    if (bit === undefined) return false;
    if (quest.getStage(player) === STAGE_NOT_STARTED) {
      player.sendMessage("The chest is empty.");
      return true;
    }
    if (hasBit(player, bit)) {
      player.sendMessage("The chest is empty.");
      return true;
    }
    const loot = CHEST_LOOT.get(key);
    if (player.getInventory().getFreeSlots() < loot.length) {
      player.sendMessage("You need more inventory space.");
      return true;
    }
    for (const itemId of loot) player.getInventory().adds(itemId, 1);
    setBit(player, bit);
    player.sendMessage("You search the chest and find some old elven artefacts.");
    return true;
  }

  const CHEST_LOOT = new Map([
    [
      "2789,4258",
      [RED_CIRCLE_ITEM_ID, RED_TRIANGLE_ITEM_ID, RED_SQUARE_ITEM_ID],
    ],
    [
      "2788,4262",
      [GREEN_SQUARE_ITEM_ID, ORANGE_SQUARE_ITEM_ID, YELLOW_TRIANGLE_ITEM_ID],
    ],
    ["2791,4249", [CHEST_KEY_ITEM_ID, YEWNOCKS_NOTES_ITEM_ID]],
    ["2793,4253", [STRONGROOM_KEY_ITEM_ID, CRYSTAL_CHIME_SEED_ITEM_ID]],
  ]);

  function unlockGate(player) {
    if (gateUnlocked) {
      player.sendMessage("The strongroom gate is already open.");
      return;
    }
    if (!held(player, STRONGROOM_KEY_ITEM_ID)) {
      player.sendMessage("The gate is locked; you need a key.");
      return;
    }
    setBit(player, BIT_GATE);
    sendVarbit(player, VARBIT_GOLRIE_RETURN, 1);
    gateUnlocked = true;
    // The gate is a base-map loc, so it is not in ObjectManager.objectsAt (which only holds
    // runtime objects). Pull it out of MapObjects and deregister it: that removes its wall
    // clipping, sends the DESPAWN removal to nearby scenes, and records it in
    // World.getRemovedObjects so ObjectManager.onRegionChange re-sends the removal on scene
    // rebuilds (the same pattern DesertTreasureI uses for its ice cave).
    RegionManager.loadMapFiles(GATE_TILE.getX(), GATE_TILE.getY());
    const gateHash = MapObjects.getHash(GATE_TILE.getX(), GATE_TILE.getY(), GATE_TILE.getZ());
    for (const object of [...(MapObjects.mapObjects.get(gateHash) ?? [])]) {
      if (
        object.getId() === STRONGROOM_GATE_OBJECT_ID ||
        object.getId() === STRONGROOM_GATE_OPEN_OBJECT_ID
      ) {
        ObjectManager.deregister(object, true);
      }
    }
    MapObjects.clear(GATE_TILE, -1);
    player.sendMessage("You unlock the strongroom gate.");
  }

  function handleGateToggle(event) {
    if (event.objectId !== STRONGROOM_GATE_OBJECT_ID) return;
    const { player } = event;
    if (!held(player, STRONGROOM_KEY_ITEM_ID)) return;
    unlockGate(player);
    event.handled = true;
  }

  function advanceToMachineReady(player) {
    if (quest.getStage(player) > STAGE_CHIME_MADE) return;
    if (hasBit(player, BIT_CHIME) && hasBit(player, DIARY_BITS[2])) quest.setStage(player, STAGE_DIARY_READ);
  }

  function handleLecternRead(event) {
    if (event.objectId !== LECTERN_OBJECT_ID) return false;
    const { player } = event;
    for (let chapter = 0; chapter < DIARY_BITS.length; chapter++) {
      if (hasBit(player, DIARY_BITS[chapter])) continue;
      setBit(player, DIARY_BITS[chapter]);
      sendVarbit(player, VARBIT_DIARY_1 + chapter, 1);
      if (chapter === DIARY_BITS.length - 1) advanceToMachineReady(player);
      playVariant(player, KING_BOLRIE_NPC_ID, DIARY_VARIANTS[chapter]);
      return true;
    }
    player.sendMessage("You have already read Bolrie's diary.");
    return true;
  }

  function handleTunnelEnter(event) {
    const { player, objectId } = event;
    if (objectId === STOREROOM_TUNNEL_ENTRY_OBJECT_ID) {
      event.player.moveTo(STOREROOM_LANDING);
      return true;
    }
    if (objectId === STOREROOM_TUNNEL_EXIT_OBJECT_ID) {
      event.player.moveTo(TUNNEL_BACK_LANDING);
      return true;
    }
    return false;
  }

  function handleSewerEnter(event) {
    if (event.objectId !== SEWER_ENTRANCE_OBJECT_ID) return false;
    const { player } = event;
    if (quest.getStage(player) < STAGE_LONGRAMBLE_MET) {
      player.sendMessage("It wouldn't be wise to go wandering into strange tunnels without some idea of what's inside.");
      return true;
    }
    player.moveTo(DUNGEON_LANDING);
    if (quest.getStage(player) === STAGE_TREE_HEALED) ensureBirds(player);
    return true;
  }

  // ==========================================================================
  // Yewnock's machine
  // ==========================================================================

  function handleMachineOperate(event) {
    if (event.objectId !== MACHINE_OBJECT_ID) return false;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_DIARY_READ) {
      player.sendMessage("The machine sits dormant.");
      return true;
    }
    if (stage >= STAGE_MACHINE_ACTIVATED) {
      player.sendMessage("The machine is already working.");
      return true;
    }
    player.sendMessage(`The machine shows the value ${MACHINE_TARGET_VALUE} and ${MACHINE_SLOTS} empty slots.`);
    return true;
  }

  function insertDisc(player, itemId) {
    const stage = quest.getStage(player);
    if (stage < STAGE_DIARY_READ) {
      player.sendMessage("The machine doesn't seem to be ready yet.");
      return;
    }
    if (stage >= STAGE_MACHINE_ACTIVATED) {
      player.sendMessage("The machine is already working.");
      return;
    }
    const progress = machineProgress.get(player) ?? [];
    progress.push(itemId);
    if (progress.length < MACHINE_SLOTS) {
      machineProgress.set(player, progress);
      player.sendMessage("You slot the disc into the machine.");
      return;
    }
    const total = progress.reduce((sum, id) => sum + discValue(id), 0);
    machineProgress.delete(player);
    if (total !== MACHINE_TARGET_VALUE) {
      player.sendMessage("The discs clunk back out of the machine.");
      return;
    }
    for (const id of progress) player.getInventory().deleteNumber(id, 1);
    activateMachine(player);
  }

  function exchangeDisc(player, itemId) {
    const parts = splitDisc(discValue(itemId));
    if (!parts) {
      player.sendMessage("The exchanger can't break that disc down any further.");
      return;
    }
    if (player.getInventory().getFreeSlots() < 1) {
      player.sendMessage("You need a free inventory slot for the exchange.");
      return;
    }
    player.getInventory().deleteNumber(itemId, 1);
    player.getInventory().adds(parts[0], 1);
    player.getInventory().adds(parts[1], 1);
    player.sendMessage("The exchanger hums and returns two smaller discs.");
  }

  function handleExchangerUse(event) {
    if (event.objectId !== EXCHANGER_OBJECT_ID) return false;
    event.player.sendMessage("Use a crystal disc on the exchanger.");
    return true;
  }

  function handleItemOnObject(event) {
    const { player, itemId, objectId } = event;
    if (objectId === SINGING_BOWL_INSPECT_OBJECT_ID || objectId === SINGING_BOWL_SING_OBJECT_ID) {
      if (itemId !== CRYSTAL_CHIME_SEED_ITEM_ID) return;
      makeChime(player);
      return;
    }
    if (objectId === DYING_SPIRIT_TREE_OBJECT_ID) {
      if (itemId !== CRYSTAL_CHIME_ITEM_ID) return;
      useChimeOnTree(player);
      return;
    }
    if (objectId === STRONGROOM_GATE_OBJECT_ID) {
      if (itemId !== STRONGROOM_KEY_ITEM_ID) return;
      unlockGate(player);
      return;
    }
    if (objectId === MACHINE_OBJECT_ID) {
      if (discValue(itemId) === 0) return;
      insertDisc(player, itemId);
      return;
    }
    if (objectId === EXCHANGER_OBJECT_ID && discValue(itemId) > 0) {
      exchangeDisc(player, itemId);
    }
  }

  // ==========================================================================
  // Dumpling and the monoliths
  // ==========================================================================

  function ensureCuteCreature(player) {
    if (cuteByPlayer.has(player) || evilByPlayer.has(player)) return;
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_MACHINE_ACTIVATED) return;
    const npc = api.spawnNpc({
      id: CUTE_CREATURE_NPC_ID,
      x: CUTE_CREATURE_TILE.x,
      y: CUTE_CREATURE_TILE.y,
      z: CUTE_CREATURE_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) cuteByPlayer.set(player, npc);
  }

  function removeCuteCreature(player) {
    const npc = cuteByPlayer.get(player);
    if (!npc) return;
    cuteByPlayer.delete(player);
    api.removeNpc(npc);
  }

  function revealCreature(player) {
    removeCuteCreature(player);
    if (evilByPlayer.has(player)) return;
    const npc = api.spawnNpc({
      id: EVIL_CREATURE_NPC_ID,
      x: CUTE_CREATURE_TILE.x,
      y: CUTE_CREATURE_TILE.y,
      z: CUTE_CREATURE_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) evilByPlayer.set(player, npc);
  }

  function activateMachine(player) {
    if (quest.getStage(player) < STAGE_DIARY_READ || hasBit(player, BIT_MACHINE)) return;
    quest.setStage(player, STAGE_MACHINE_ACTIVATED);
    setBit(player, BIT_MACHINE);
    sendVarbit(player, VARBIT_WATCHER, 1);
    revealCreature(player);
    player.sendMessage("The machine shudders into life and Dumpling is revealed for what it is!");
  }

  function ensureMonoliths(player) {
    if (monolithsByPlayer.has(player)) return;
    const entries = [];
    MONOLITH_SPAWNS.forEach((spot, index) => {
      if (hasBit(player, MONOLITH_BITS[index])) return;
      const npc = api.spawnNpc({
        id: spot.id,
        x: spot.x,
        y: spot.y,
        z: 0,
        wanderRadius: 0,
        owner: player,
        ownerOnly: true,
      });
      if (npc) {
        entries.push({
          index,
          npc,
          homeX: spot.x,
          homeY: spot.y,
          destX: spot.destX,
          destY: spot.destY,
          pushed: false,
        });
      }
    });
    monolithsByPlayer.set(player, entries);
  }

  function pushMonolith(player, entry) {
    if (entry.pushed) {
      player.sendMessage("The monolith is already out of the way.");
      return;
    }
    entry.pushed = true;
    entry.npc.exactMove(new Location(entry.destX, entry.destY, 0));
    setBit(player, MONOLITH_BITS[entry.index]);
    const entries = monolithsByPlayer.get(player) ?? [];
    if (entries.length > 0 && entries.every((candidate) => candidate.pushed)) {
      player.sendMessage("The last monolith grinds aside, opening the way through the storeroom.");
    } else {
      player.sendMessage("You push the monolith out of the way.");
    }
  }

  function resetMonoliths(player, entries) {
    api.sendMultiChatboxPrompt(
      player,
      "Reset all the monoliths?",
      "Yes.",
      () => {
        for (const entry of entries) {
          entry.pushed = false;
          entry.npc.exactMove(new Location(entry.homeX ?? entry.destX, entry.homeY ?? entry.destY, 0));
        }
      },
      "No.",
      () => {}
    );
  }

  function handleMonolithInteraction(event) {
    const { player, npcId, clickType } = event;
    if (npcId !== BIG_MONOLITH_NPC_ID && npcId !== SMALL_MONOLITH_NPC_ID) return;
    const entries = monolithsByPlayer.get(player);
    if (!entries) return;
    const entry = entries.find((candidate) => candidate.npc === event.npc);
    if (!entry) return;
    const option = event.definition?.getActions?.()?.[clickType - 1];
    if (option === "Push") {
      event.handled = true;
      pushMonolith(player, entry);
    } else if (option === "Reset") {
      event.handled = true;
      resetMonoliths(player, entries);
    }
  }

  // ==========================================================================
  // Warped depths
  // ==========================================================================

  function ensureLongramble(player) {
    if (longrambleByPlayer.has(player)) return;
    const npc = api.spawnNpc({
      id: LONGRAMBLE_NPC_ID,
      x: LONGRAMBLE_TILE.x,
      y: LONGRAMBLE_TILE.y,
      z: LONGRAMBLE_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) longrambleByPlayer.set(player, npc);
  }

  /** The player's own still-alive bird for `index`, tagged on spawn (adopt after a relog). */
  function findOwnedBird(player, index) {
    const world = api.getWorld?.();
    if (!world?.getNpcs) return null;
    for (const npc of world.getNpcs()) {
      if (npc?.getOwner?.() !== player) continue;
      if (!WARPED_TERRORBIRD_NPC_IDS.includes(npc.getId?.())) continue;
      if (Number(npc.getAttribute?.(BIRD_ATTRIBUTE)) === index) return npc;
    }
    return null;
  }

  function ensureBirds(player) {
    let entries = birdsByPlayer.get(player);
    if (!entries) {
      entries = [];
      birdsByPlayer.set(player, entries);
    }
    TERRORBIRD_TILES.forEach((tile, index) => {
      if (hasBit(player, BIRD_BITS[index])) return;
      if (entries.some((entry) => entry.index === index)) return;
      const adopted = findOwnedBird(player, index);
      if (adopted) {
        entries.push({ index, npc: adopted });
        return;
      }
      const npc = api.spawnNpc({
        id: WARPED_TERRORBIRD_NPC_IDS[index],
        x: tile.x,
        y: tile.y,
        z: tile.z,
        wanderRadius: 0,
        owner: player,
        ownerOnly: true,
      });
      if (npc) {
        npc.setAttribute?.(BIRD_ATTRIBUTE, index);
        entries.push({ index, npc });
      }
    });
  }

  function birdKillCount(player) {
    return BIRD_BITS.reduce((count, bit) => count + (hasBit(player, bit) ? 1 : 0), 0);
  }

  function handleHeavyDoorPeek(event) {
    const { player, objectId } = event;
    if (objectId !== HEAVY_DOOR_OBJECT_ID) return false;
    const stage = quest.getStage(player);
    if (stage < STAGE_BIRDS_DEAD) {
      player.sendMessage("You can hear muffled squawking beyond the heavy door.");
      return true;
    }
    if (!quest.isComplete(player)) playVariant(player, HAZELMERE_NPC_ID, FINAL_VARIANT);
    return true;
  }

  function handleNpcDeath(event) {
    const { npc, killer } = event;
    let owner = killer?.isPlayer?.() ? killer : null;
    if (!owner && npc?.getOwner?.()?.isPlayer?.()) owner = npc.getOwner();
    if (!owner) return;
    const evil = evilByPlayer.get(owner);
    if (evil === npc || (npc?.getOwner?.() === owner && npc?.getId?.() === EVIL_CREATURE_NPC_ID)) {
      evilByPlayer.delete(owner);
      if (!hasBit(owner, BIT_CREATURE_KILLED)) {
        setBit(owner, BIT_CREATURE_KILLED);
        if (quest.getStage(owner) === STAGE_MACHINE_ACTIVATED) quest.setStage(owner, STAGE_CREATURE_KILLED);
      }
      return;
    }
    if (!WARPED_TERRORBIRD_NPC_IDS.includes(npc?.getId?.())) return;
    // The death payload can be a different instance of the NPC (clones/new indices), so
    // match on the tag set at spawn (and identity) instead of the object reference alone.
    const entries = birdsByPlayer.get(owner) ?? [];
    const tag = Number(npc.getAttribute?.(BIRD_ATTRIBUTE));
    let position = entries.findIndex((entry) => entry.npc === npc);
    if (position === -1 && Number.isInteger(tag)) {
      position = entries.findIndex((entry) => entry.index === tag);
    }
    if (position !== -1) entries.splice(position, 1);
    let index = Number.isInteger(tag) && tag >= 0 && tag < BIRD_BITS.length ? tag : -1;
    if (index === -1) index = BIRD_BITS.findIndex((bit) => !hasBit(owner, bit));
    if (index === -1 || hasBit(owner, BIRD_BITS[index])) return;
    setBit(owner, BIRD_BITS[index]);
    const count = birdKillCount(owner);
    if (count >= TERRORBIRD_TILES.length) {
      const stage = quest.getStage(owner);
      if (stage >= STAGE_TREE_HEALED && stage < STAGE_COMPLETE) quest.setStage(owner, STAGE_BIRDS_DEAD);
      ensureHeavyDoor();
      owner.sendMessage("The last terrorbird falls. The heavy door to the east is unguarded.");
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  function despawnQuestNpcs(player) {
    removeCuteCreature(player);
    const evil = evilByPlayer.get(player);
    if (evil) {
      evilByPlayer.delete(player);
      api.removeNpc(evil);
    }
    const monoliths = monolithsByPlayer.get(player);
    if (monoliths) {
      monolithsByPlayer.delete(player);
      for (const entry of monoliths) api.removeNpc(entry.npc);
    }
    const birds = birdsByPlayer.get(player);
    if (birds) {
      birdsByPlayer.delete(player);
      for (const entry of birds) api.removeNpc(entry.npc);
    }
    const longramble = longrambleByPlayer.get(player);
    if (longramble) {
      longrambleByPlayer.delete(player);
      api.removeNpc(longramble);
    }
  }

  function handleVillageZone({ player }) {
    if (quest.getStage(player) < STAGE_MACHINE_ACTIVATED) ensureCuteCreature(player);
  }

  function handleLongrambleZone({ player }) {
    if (quest.getStage(player) >= STAGE_SENT_FOR_LONGRAMBLE) ensureLongramble(player);
  }

  function handleStoreroomZone({ player }) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_GOLRIE_TOLD && stage < STAGE_MACHINE_ACTIVATED) ensureMonoliths(player);
  }

  function handleWarpedDepthsZone({ player }) {
    const stage = quest.getStage(player);
    if (stage === STAGE_TREE_HEALED) ensureBirds(player);
    if (stage >= STAGE_BIRDS_DEAD) ensureHeavyDoor();
  }

  function handleLogin({ player }) {
    const stage = quest.getStage(player);
    if (hasBit(player, BIT_CHIME)) bowlSung = true;
    if (hasBit(player, BIT_GATE)) gateUnlocked = true;
    if (stage >= STAGE_TREE_HEALED) treeHealed = true;
    ensureQuestObjects();
    refreshQuestList(player);
    syncVarbits(player);
    if (stage >= STAGE_STARTED && stage < STAGE_MACHINE_ACTIVATED) ensureCuteCreature(player);
    if (stage >= STAGE_MACHINE_ACTIVATED && stage < STAGE_COMPLETE && !hasBit(player, BIT_CREATURE_KILLED)) {
      revealCreature(player);
    }
    if (stage >= STAGE_GOLRIE_TOLD && stage < STAGE_MACHINE_ACTIVATED) ensureMonoliths(player);
    if (stage >= STAGE_SENT_FOR_LONGRAMBLE) ensureLongramble(player);
    if (stage === STAGE_TREE_HEALED) ensureBirds(player);
    if (stage >= STAGE_BIRDS_DEAD) ensureHeavyDoor();
  }

  function handleLogout({ player }) {
    despawnQuestNpcs(player);
  }

  quest = registerQuest(api, {
    key: "the_path_of_glouphrie",
    name: "The Path of Glouphrie",
    varpId: VARP_POG,
    varbitId: VARBIT_POG_STAGE,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [],
    scrollItemId: ItemIdentifiers.MAGIC_LAMP_STRENGTH_,
    otherRewards: [
      "Four magic lamps (30,000 Strength, 20,000 Slayer,",
      "5,000 Thieving and 5,000 Magic XP)",
      "Access to the Poison Waste Dungeon",
      "Access to Incomitatus, a new spirit tree destination",
    ],
    buildJournal,
    onReward: grantLamps,
  });

  api.persistAttribute(BITS_ATTRIBUTE);
  api.persistAttribute(LAMPS_ATTRIBUTE);

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onNpcInteraction("Hazelmere", { "Talk-to": talkToHazelmere });
  api.onNpcInteraction(handleMonolithInteraction);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:line", handleLine);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("door:toggle", handleGateToggle);
  api.onObjectInteraction("Tunnel", { Enter: handleTunnelEnter });
  api.onObjectInteraction("Sewer entrance", { Enter: handleSewerEnter });
  api.onObjectInteraction("Spirit Tree", { "Talk-to": handleTreeTalk });
  api.onObjectInteraction("Singing bowl", {
    Inspect: handleBowlInspect,
    "Sing-crystal": handleBowlSing,
  });
  api.onObjectInteraction("Chest", { Open: handleChestSearch, Search: handleChestSearch });
  api.onObjectInteraction("Lectern", { Read: handleLecternRead });
  api.onObjectInteraction("Yewnock's machine", { Operate: handleMachineOperate });
  api.onObjectInteraction("Yewnock's exchanger", { Use: handleExchangerUse });
  api.onObjectInteraction("Heavy door", { Peek: handleHeavyDoorPeek, Open: handleHeavyDoorPeek });
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onItemFirstAction(handleLampAction);
  api.onNpcDeath(handleNpcDeath);
  api.onZoneEnter(VILLAGE_ZONE, handleVillageZone);
  api.onZoneEnter(LONGRAMBLE_ZONE, handleLongrambleZone);
  api.onZoneEnter(STOREROOM_ZONE, handleStoreroomZone);
  api.onZoneEnter(WARPED_DEPTHS_ZONE, handleWarpedDepthsZone);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
