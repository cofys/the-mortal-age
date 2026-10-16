/** The Garden of Death: recorded stages, native language puzzle and reading interfaces.
* Source: RSProx capture1692 (rev226), with ids checked against the current cache.
* See docs/p2p-kourend-parity.md for coverage and remaining unrecorded branches.
*/
module.exports = function registerGardenOfDeathQuest(api) {
  const { Animation, Area, Boundary, CountdownTask, TaskManager, DialogueChainBuilder, ActionDialogue, StatementDialogue, ItemStatementDialogue, GameObject, ItemIdentifiers, Location, NpcIdentifiers, ObjectIdentifiers, ObjectManager, Skill, Equipment } = api.core;
  const { registerQuest, refreshQuestList, startTranscript, openBook } = require("../QuestRuntime");
  const reading = require("../data/garden-of-death.json");
  const PAGE = "The Garden of Death", TRANSCRIPT_NPC_ID = NpcIdentifiers.KASONDE;
  const VARP_ID = 3713, VARBIT_ID = 14609, FULLY_TRANSLATED_VARBIT = 14675;
  const FARMING_REQUIREMENT = 20;
  const TENT = ObjectIdentifiers.TENT_19, CAMPING_EQUIPMENT = ObjectIdentifiers.CAMPING_EQUIPMENT_6;
  const SECATEURS = ItemIdentifiers.SECATEURS, MAGIC_SECATEURS = ItemIdentifiers.MAGIC_SECATEURS;
  const KASONDES_JOURNAL = ItemIdentifiers.KASONDES_JOURNAL, WORD_TRANSLATIONS = ItemIdentifiers.WORD_TRANSLATIONS;
  const DIRTY_NOTE = ItemIdentifiers.DIRTY_NOTE, DIRTY_NOTE_2 = ItemIdentifiers.DIRTY_NOTE_2, DIRTY_NOTE_3 = ItemIdentifiers.DIRTY_NOTE_3;
  const WARNING_NOTE = ItemIdentifiers.WARNING_NOTE, COMPASS = ItemIdentifiers.COMPASS;
  const TABLETS = [ItemIdentifiers.STONE_TABLET_6, ItemIdentifiers.STONE_TABLET_7, ItemIdentifiers.STONE_TABLET_8, ItemIdentifiers.STONE_TABLET_9];
  const TABLES = [ObjectIdentifiers.STONE_TABLE_35, ObjectIdentifiers.STONE_TABLE_36, ObjectIdentifiers.STONE_TABLE_37, ObjectIdentifiers.STONE_TABLE_38];
  const RUBBLE_SEARCH = ObjectIdentifiers.RUBBLE_71, STONE_CHEST_SEARCH = ObjectIdentifiers.STONE_CHEST_26;
  const VASE_SEARCH = ObjectIdentifiers.VASE_5, MUSHROOM_SEARCH = ObjectIdentifiers.HUGE_MUSHROOM_6, MUSHROOM_SEARCH_2 = ObjectIdentifiers.HUGE_MUSHROOM_8;
  const TABLE_SEARCH_WIDE = ObjectIdentifiers.STONE_TABLE_21, TABLE_SEARCH_BIG = ObjectIdentifiers.STONE_TABLE_29, TABLE_SEARCH_SMALL = ObjectIdentifiers.STONE_TABLE_34;
  const VINES_TRANSFORM = 46437, MOLCH_HOLE_TRANSFORM = 46434, XERIC_HOLE_TRANSFORM = 46435, MORRA_HOLE_TRANSFORM = 46436;
  const VINES = new Set([VINES_TRANSFORM, ObjectIdentifiers.VINES_23, ObjectIdentifiers.VINES_24, ObjectIdentifiers.VINES_25]); // cache tgod_vines multi-loc
  const TRANSLATIONS_GROUP = 804, TABLET_GROUP = 748, NOTE_GROUP = 625;
  const WORDS_ATTRIBUTE = "garden-of-death:translations", SEEN_WORDS_ATTRIBUTE = "garden-of-death:seen-words";
  const VERSION_ATTRIBUTE = "garden-of-death:stage-version";
  const LEGACY_WORDS_ATTRIBUTE = "quest.the_garden_of_death.words";
  const FULLY_TRANSLATED_ATTRIBUTE = "garden-of-death:fully-translated";
  const READ_STAGES = [10, 28, 38, 48], FOUND_STAGES = [8, 26, 36, 46], ENTERED_STAGES = [6, 20, 34, 44], SOLVED_STAGES = [16, 30, 40, 50];
  const TABLE_COORDS = [[1306, 9885], [1373, 10014], [1311, 10018], [1440, 9816]];
  const DUNGEONS = [
    { bounds: [1289, 1325, 9859, 9901, 0], hole: [1308, 3467], ids: [ObjectIdentifiers.HOLE_64], inside: [1309, 9869], outside: [1309, 3469], rope: ObjectIdentifiers.ROPE_46, required: 4 },
    { bounds: [1354, 1401, 9989, 10039, 0], hole: [1364, 3637], ids: [MOLCH_HOLE_TRANSFORM, ObjectIdentifiers.HOLE_65], inside: [1375, 10032], outside: [1364, 3636], rope: ObjectIdentifiers.ROPE_47, required: 16 },
    { bounds: [1289, 1325, 9989, 10039, 0], hole: [1314, 3617], ids: [XERIC_HOLE_TRANSFORM, ObjectIdentifiers.HOLE_66], inside: [1296, 10033], outside: [1315, 3617], rope: ObjectIdentifiers.ROPE_48, required: 30 },
    { bounds: [1414, 1461, 9809, 9841, 0], hole: [1450, 3511], ids: [MORRA_HOLE_TRANSFORM, ObjectIdentifiers.HOLE_67], inside: [1456, 9824], outside: [1449, 3511], rope: ObjectIdentifiers.ROPE_49, required: 40 },
  ];
  const TABLET_TEXT = [
    "Amok miki. Tal toka kemo. Lini toka makt. Tal tlane osto ates ikam.",
    "Siua olkat moki. Olkat moki tal. Kualt olkat tal toka. Moki yoka tlane lini kamat. Silam osto achi ates xali.",
    "Lini kamat kemo. Olkat kemo. Tal toka kemo. Miki xita. Miki achi moki. Miki chua tal. Miki tlane lini. Uitt takam osto tlane tasol.",
    "Miki achi ami. Tlane chua rani miki. Lini antil. Antil tepat. Ami tal. Tal toka ami. Zema-Tal tepat.",
  ];
  // Each accepted meaning is independent: Miki can mean both Time and Death.
  const WORDS = [
    ["Osto", "Below/Under/Beneath"], ["Tlane", "Garden/Plant/Tree/Forest/Wood"], ["Tasol", "Structure/Building"], ["Kamat", "Method/Process"], ["Moki", "Need/Require"],
    ["Amok", "Little/Small/Few"], ["Miki", "Time/Death/Die/Kill"], ["Tal", "Life/Soul"], ["Toka", "Vessel/Container/Holder"], ["Kemo", "Yes/Success/Right/Correct"], ["Lini", "Move/Transfer/Send/Deliver"],
    ["Makt", "North"], ["Ates", "Lake/Pond/Water"], ["Ikam", "Island"], ["Siua", "Big/Many/Lots/Plenty"], ["Olkat", "Body"], ["Kualt", "Feed/Food/Eat"], ["Yoka", "Knowledge/Mind"], ["Silam", "West"], ["Achi", "Poison"], ["Xali", "Earth/Land/Ground"],
    ["Xita", "Arrive/Here"], ["Chua", "Create/Build/Make"], ["Uitt", "South"], ["Takam", "East"], ["Ami", "No/Failure/Wrong/Incorrect"], ["Rani", "Dark/Moon"], ["Antil", "Home"], ["Tepat", "Fire/Destroy/Break"], ["Ehke", "Air/Wind"], ["Ayak", "Animal/Creature"], ["Ralo", "Light/Sun"],
  ];
  const INITIAL_WORDS = ["below", "under", "garden", "structure", "building", "method", "process", "need", "require"];
  const REQUIRED = [["Ikam", "Ates", "Miki", "Toka", "Makt"], ["Silam", "Achi", "Olkat", "Kualt", "Xali"], ["Chua", "Kemo", "Ami", "Lini", "Xita", "Takam", "Uitt"], ["Amok", "Siua", "Ralo", "Rani", "Tal", "Miki", "Yoka", "Antil", "Ehke", "Tepat"]];
  const CONTEXT_WORDS = [
    ["Little", "time", "Soul", "vessel", "success", "Send", "vessel", "north", "Life", "garden", "below", "water", "island"],
    ["Many", "body", "needed", "Body", "need", "life", "Feed", "body", "soul", "vessel", "Need", "knowledge", "garden", "transfer", "method", "West", "below", "poison", "water", "land"],
    ["Transfer", "method", "success", "Body", "success", "Soul", "vessel", "success", "Time", "arrived", "Death", "poison", "needed", "Death", "create", "life", "Death", "garden", "deliver", "South", "east", "below", "forest", "building"],
    ["Death", "poison", "fail", "Plant", "create", "dark", "death", "Send", "home", "Home", "destroyed", "No", "life", "Soul", "vessel", "fail", "Zema-Tal", "destroyed"],
  ];
  const CARVINGS = [105, 803, 800, 793, 797, 795, 801, 802, 792, 794, 799, 796, 791, 798];
  const CLUE_HOURGLASS = 27538, CLUE_HOME_TABLET = 27539, CLUE_BODY_RUNE = 27541, CLUE_COMPOST = 27542; // Cache tgod_* display-only items.
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
  const SPOT_TYPE_BY_KEY = new Map(SEARCHABLE_SCENERY.map(([id, x, y]) => [`${x},${y}`, SCENERY_TYPE_BY_ID.get(id)]));
  // Clues are tied to a fixed scenery placement, independent of search order.
  const OTHER_REWARDS = {
    1: {
      table: [
        { text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING },
        { text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_2 },
      ],
      vase: [{ text: "You find a note next to the vase. You take it.", item: DIRTY_NOTE }],
      chest: [{ text: "The chest contains some hourglasses. A label on the chest reads 'Miki Toka'.", model: CLUE_HOURGLASS }],
    },
    2: {
      table: [{ text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_3 }],
      vase: [
        { text: "You find a carving next to the vase. You take it.", item: ItemIdentifiers.WOOD_CARVING_4 },
        { text: "The vase seems to contain some very old compost. A label on the vase reads 'Tlane Kualt'.", model: CLUE_COMPOST },
      ],
      chest: [{ text: "The chest contains some body runes. A label on the chest reads 'Olkat'.", model: CLUE_BODY_RUNE }],
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
        { text: "You search the table and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_13 },
      ],
      vase: [{ text: "You find a carving next to the vase. You take it.", item: ItemIdentifiers.WOOD_CARVING_14 }],
      chest: [
        { text: "You search the chest and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_12,
          contents: { text: "The chest contains what look to be home teleport tablets. A label on the chest reads 'Antil'.", model: CLUE_HOME_TABLET } },
      ],
      rubble: [
        { text: "You search the rubble and find a carving. You take it.", item: ItemIdentifiers.WOOD_CARVING_11 },
        { text: "You search the rubble and find a note. You take it.", item: DIRTY_NOTE_3 },
      ],
    },
  };
  let quest;
  const opened = new WeakMap(), ownedScenery = new WeakMap(), pending = new WeakMap();
  const has = (player, id) => player.getInventory().getAmount(id) > 0;
  const hasSecateurs = player => [SECATEURS, MAGIC_SECATEURS].some(id => has(player, id)) || player.getEquipment().get(Equipment.WEAPON_SLOT)?.getId() === MAGIC_SECATEURS;
  const later = (key, ticks, fn) => TaskManager.submit(new CountdownTask(key, ticks, fn));

  function advance(player, stage) {
    if (quest.getStage(player) < stage) {
      quest.setStage(player, stage);
    }
  }

  function translations(player) {
    return new Set(INITIAL_WORDS.concat(String(player.getAttribute(WORDS_ATTRIBUTE) || "").split("|").filter(Boolean)));
  }

  function meaningFor(word, known) {
    return word[1].split("/").filter(meaning => known.has(meaning.toLowerCase()));
  }

  function statement(player, text, item, after) {
    const chain = new DialogueChainBuilder().add(item === undefined ? new StatementDialogue(0, text) : new ItemStatementDialogue(0, item, text));
    if (after) {
      chain.add(new ActionDialogue(1, { execute: after }));
    }
    // Capture1692 sends message_game(type=mesbox) as well as the native dialogue text.
    player.sendMessage(text.replace(/<br>/g, " "));
    player.getDialogueManager().startDialogues(chain);
  }

  function give(player, id, text, after) {
    if (has(player, id)) {
      statement(player, "You search, but find nothing of interest.");
      return false;
    }
    if (player.getInventory().getFreeSlots() < 1) {
      statement(player, "You don't have enough room to take it.");
      return false;
    }
    player.getInventory().adds(id, 1);
    player.getPacketSender().sendSoundEffect(2582, 1, 0);
    statement(player, text, id, after);
    return true;
  }

  function clearScenery(player) {
    for (const object of ownedScenery.get(player) || [])
      ObjectManager.deregister(object, true);
    ownedScenery.delete(player);
  }

  function syncScenery(player) {
    clearScenery(player);
    const stage = quest.getStage(player), objects = [];
    for (const [id, x, y, shape, face] of SEARCHABLE_SCENERY) {
      const dungeon = DUNGEONS.findIndex(d => x >= d.bounds[0] && x <= d.bounds[1] && y >= d.bounds[2] && y <= d.bounds[3]);
      if (dungeon < 0 || stage < READ_STAGES[dungeon]) {
        continue;
      }
      const object = new GameObject(id, new Location(x, y, 0), shape, face, null).setOwner(player);
      ObjectManager.register(object, true);
      objects.push(object);
    }
    ownedScenery.set(player, objects);
  }

  function travel(player, to, animation, after) {
    if (pending.has(player)) {
      return;
    }
    const token = {};
    pending.set(player, token);
    player.getMovementQueue().reset().setBlockMovement(true);
    player.performAnimation(new Animation(animation));
    later(token, 1, () => {
      if (pending.get(player) !== token) {
        return;
      }
      pending.delete(player);
      player.moveTo(new Location(...to, 0));
      player.getMovementQueue().setBlockMovement(false);
      after?.();
    });
  }

  function handleObject(event) {
    const { player, objectId, location } = event, stage = quest.getStage(player), option = String(event.option || "").toLowerCase();
    if (objectId === TENT && location?.x === 1313 && location?.y === 3469) {
      event.handled = true;
      if (!quest.isStarted(player)) {
        if (player.getSkillManager().getMaxLevel(Skill.FARMING) < FARMING_REQUIREMENT) {
          player.sendMessage("You need a Farming level of 20 to start this quest.");
          return;
        }
        if (player.getInventory().getFreeSlots() < 1) {
          statement(player, "You don't have enough inventory space.");
          return;
        }
        startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "starting-the-quest-searching-the-tent");
      }
      else if (!has(player, KASONDES_JOURNAL)) {
        give(player, KASONDES_JOURNAL, "You search the tent and find a journal. You take it.");
      }
      return;
    }
    if (objectId === CAMPING_EQUIPMENT && location?.x >= 1300 && location?.x <= 1320 && location?.y >= 3460 && location?.y <= 3480) {
      event.handled = true;
      startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "starting-the-quest-searching-the-camping-equipment");
      return;
    }
    const dungeon = DUNGEONS.findIndex(d => d.ids.includes(objectId) && location?.x === d.hole[0] && location?.y === d.hole[1]);
    if (dungeon >= 0) {
      event.handled = true;
      if (stage < DUNGEONS[dungeon].required) {
        player.sendMessage("You have no reason to go down there.");
        return;
      }
      if (dungeon > 0 && stage < ENTERED_STAGES[dungeon]) {
        advance(player, ENTERED_STAGES[dungeon] - 2);
      }
      travel(player, DUNGEONS[dungeon].inside, 827, () => advance(player, ENTERED_STAGES[dungeon]));
      return;
    }
    if (VINES.has(objectId) && location?.x === 1375 && location?.y === 10024) {
      event.handled = true;
      if (stage < 20) {
        return;
      }
      if (option === "inspect" || option === "search") {
        if (!has(player, DIRTY_NOTE_2)) {
          if (give(player, DIRTY_NOTE_2, "You spot a note on the floor near the vines. You take it.")) {
            advance(player, 22);
          }
        }
        else {
          statement(player, "You search, but find nothing of interest.");
        }
        return;
      }
      if (stage < 24) {
        cutVines(player);
        return;
      }
      player.sendMessage("You squeeze through the vines.");
      const to = player.getLocation().getY() > 10024 ? [1375, 10023] : [1375, 10025];
      travel(player, to, 839);
      return;
    }
    const table = TABLES.indexOf(objectId);
    if (table >= 0 && location?.x === TABLE_COORDS[table][0] && location?.y === TABLE_COORDS[table][1]) {
      event.handled = true;
      if (stage < ENTERED_STAGES[table]) {
        return;
      }
      if (give(player, TABLETS[table], "You search the table and find a stone tablet. You take it.")) {
        advance(player, FOUND_STAGES[table]);
      }
      return;
    }
    const key = `${location?.x},${location?.y}`, type = SPOT_TYPE_BY_KEY.get(key);
    if (!type || !SCENERY_TYPE_BY_ID.has(objectId)) {
      return;
    }
    const area = DUNGEONS.findIndex(d => location.x >= d.bounds[0] && location.x <= d.bounds[1] && location.y >= d.bounds[2] && location.y <= d.bounds[3]);
    if (area < 0 || stage < READ_STAGES[area]) {
      return;
    }
    event.handled = true;
    const siblings = SEARCHABLE_SCENERY.filter(([id, x, y]) => SCENERY_TYPE_BY_ID.get(id) === type && x >= DUNGEONS[area].bounds[0] && x <= DUNGEONS[area].bounds[1] && y >= DUNGEONS[area].bounds[2] && y <= DUNGEONS[area].bounds[3]);
    const index = siblings.findIndex(([, x, y]) => x === location.x && y === location.y), reward = OTHER_REWARDS[area + 1]?.[type]?.[index];
    if (!reward) {
      statement(player, "You search, but find nothing of interest.");
      return;
    }
    if (reward.item !== undefined) {
      const contents = reward.contents;
      const inspectContents = contents ? () => statement(player, contents.text, contents.model) : undefined;
      if (has(player, reward.item) && inspectContents) inspectContents();
      else give(player, reward.item, reward.text, inspectContents);
    }
    else {
      statement(player, reward.text, reward.model);
    }
  }

  function cutVines(player) {
    if (quest.getStage(player) < 22 || quest.getStage(player) >= 24) {
      return;
    }
    if (!hasSecateurs(player)) {
      player.sendMessage("You need some secateurs to cut through these vines.");
      return;
    }
    if (pending.has(player)) {
      return;
    }
    const token = {};
    pending.set(player, token);
    player.performAnimation(new Animation(2275));
    player.getPacketSender().sendSoundEffect(2440, 1, 0);
    later(token, 3, () => {
      if (pending.get(player) !== token) {
        return;
      }
      pending.delete(player);
      advance(player, 24);
      statement(player, "You cut through the vines.");
    });
  }

  function handleItemOnObject(event) {
    if (VINES.has(event.objectId) && [SECATEURS, MAGIC_SECATEURS].includes(event.itemId)) {
      event.handled = true;
      cutVines(event.player);
    }
  }

  function rope(event) {
    const dungeon = DUNGEONS.find(d => d.rope === event.objectId);
    if (!dungeon) {
      return;
    }
    event.handled = true;
    travel(event.player, dungeon.outside, 828);
  }

  function visibleWords(player) {
    const dungeon = READ_STAGES.findLastIndex(stage => quest.getStage(player) >= stage);
    const seen = new Set(String(player.getAttribute(SEEN_WORDS_ATTRIBUTE) || "").split("|"));
    return WORDS.filter((word, index) => index < [0, 14, 21, 29, 32][dungeon + 1] || seen.has(word[0]));
  }

  function openTranslations(player) {
    if (!has(player, WORD_TRANSLATIONS)) {
      return;
    }
    advance(player, 14);
    opened.set(player, "translations");
    const known = translations(player), text = visibleWords(player).map(word => `${word[0]} - ${meaningFor(word, known).join("/") || "???"}<br>`).join("");
    player.getPacketSender().sendInterface(TRANSLATIONS_GROUP).sendClientScript(6945, text);
  }

  function promptTranslation(player) {
    if (!has(player, WORD_TRANSLATIONS) || quest.getStage(player) < 14) {
      return;
    }
    opened.delete(player);
    player.getPacketSender().sendInterfaceRemoval();
    player.setEnteredSyntaxAction({ execute: input => translate(player, input) });
    player.getPacketSender().sendEnterInputPrompt("Enter a possible translation for a word you've found:");
  }

  function translate(player, input) {
    if (!has(player, WORD_TRANSLATIONS) || quest.getStage(player) < 14) {
      return;
    }
    const answer = String(input || "").trim().toLowerCase(), word = WORDS.find(([, meanings]) => meanings.toLowerCase().split("/").includes(answer));
    if (!word) {
      statement(player, "You can't think of any suitable translations for that word.", undefined, () => askAgain(player));
      return;
    }
    if (!visibleWords(player).includes(word)) {
      statement(player, "You feel like that word has potential, but you can't think of any suitable translations for it at the moment.", undefined, () => askAgain(player));
      return;
    }
    const known = translations(player);
    if (known.has(answer)) {
      statement(player, "You've already discovered that translation.", undefined, () => askAgain(player));
      return;
    }
    known.add(answer);
    player.setAttribute(WORDS_ATTRIBUTE, [...known].sort().join("|"));
    const dungeon = READ_STAGES.findLastIndex(s => quest.getStage(player) >= s);
    const solved = dungeon >= 0 && quest.getStage(player) < SOLVED_STAGES[dungeon] && REQUIRED[dungeon].every(name => meaningFor(WORDS.find(([word]) => word === name), known).length);
    if (solved) {
      advance(player, SOLVED_STAGES[dungeon]);
    }
    player.getPacketSender().sendSoundEffect(2671, 1, 0);
    const label = answer[0].toUpperCase() + answer.slice(1);
    statement(player, `You've discovered a new translation:<br>${label} = ${word[0]}`, undefined, () => {
      if (solved) {
        player.getPacketSender().sendSoundEffect(2655, 1, 0);
        statement(player, "You feel that you've translated enough words to read some of the text on the stone tablet.");
      }
      else if (!fullyTranslated(player)) {
        askAgain(player);
      }
    });
  }

  function askAgain(player) {
    api.sendMultiChatboxPrompt(player, "Attempt another translation?", "Yes.", () => promptTranslation(player), "No.", () => player.getPacketSender().sendInterfaceRemoval());
  }
  const CONTEXT_BASE = { needed: "need", arrived: "arrive", destroyed: "destroy", fail: "failure" };

  function fullyTranslated(player) {
    if (player.getAttribute(FULLY_TRANSLATED_ATTRIBUTE)) {
      return false;
    }
    const known = translations(player);
    const complete = CONTEXT_WORDS.flat().every(word => word === "Zema-Tal" || known.has(CONTEXT_BASE[word.toLowerCase()] || word.toLowerCase()));
    if (!complete) {
      return false;
    }
    player.setAttribute(FULLY_TRANSLATED_ATTRIBUTE, 1);
    player.getPacketSender().sendVarbit(FULLY_TRANSLATED_VARBIT, 1);
    statement(player, "You feel that you've translated enough words to fully understand all of the stone tablets!");
    return true;
  }

  function translatedTablet(index, known) {
    let position = 0;
    return TABLET_TEXT[index].replace(/[A-Za-z]+(?:-[A-Za-z]+)?/g, token => {
      const expected = CONTEXT_WORDS[index][position++], word = WORDS.find(([word]) => word.toLowerCase() === token.toLowerCase());
      if (!word) {
        return token;
      }
      const meanings = meaningFor(word, known);
      if (!meanings.length) {
        return token;
      }
      const base = CONTEXT_BASE[String(expected).toLowerCase()] || String(expected).toLowerCase();
      const correct = meanings.some(m => m.toLowerCase() === base), text = correct ? expected : meanings[0];
      return `<col=${correct ? "33cc59" : "32b5ff"}>${token[0] === token[0].toUpperCase() ? text[0].toUpperCase() + text.slice(1) : text.toLowerCase()}</col>`;
    });
  }

  function readTablet(player, index) {
    if (quest.getStage(player) < FOUND_STAGES[index] || !has(player, TABLETS[index])) {
      return;
    }
    advance(player, READ_STAGES[index]);
    if (index === 3 && quest.getStage(player) >= 50) {
      advance(player, 52);
    }
    syncScenery(player);
    opened.set(player, index === 0 && !has(player, WORD_TRANSLATIONS) ? "first-tablet"
      : index === 3 && quest.getStage(player) >= 52 && !has(player, WARNING_NOTE) ? "last-tablet" : "tablet");
    const packet = player.getPacketSender(), known = translations(player);
    packet.sendInterface(TABLET_GROUP);
    const learned = [...known].filter(word => !INITIAL_WORDS.includes(word));
    const captured = reading.tabletLayouts.find(layout => layout.tablet === index && learned.length === layout.answers.length && layout.answers.every(answer => known.has(answer)));
    if (captured) {
      for (const [child, text] of Object.entries(captured.lines))
        packet.sendString(text, (TABLET_GROUP << 16) | Number(child));
    }
    else {
      for (let child = 3; child <= 13; child++)
        packet.sendString("", (TABLET_GROUP << 16) | child);
      const original = wrapTablet(TABLET_TEXT[index]), translated = quest.getStage(player) >= 12 ? wrapTablet(translatedTablet(index, known)) : [];
      const start = 3 + Math.floor((11 - original.length - translated.length - (translated.length ? 1 : 0)) / 2);
      original.forEach((text, line) => packet.sendString(text, (TABLET_GROUP << 16) | (start + line)));
      translated.forEach((text, line) => packet.sendString(text, (TABLET_GROUP << 16) | (start + original.length + 1 + line)));
    }
  }

  // shortcut: unrecorded answer combinations wrap at75 visible characters; add their native layouts when captured.
  function wrapTablet(text) {
    const lines = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (`${line} ${word}`.replace(/<[^>]*>/g, "").trim().length > 75) {
        lines.push(line);
        line = "";
      }
      line += (line ? " " : "") + word;
    }
    if (line) {
      lines.push(line);
    }
    return lines;
  }

  function handleItem(event) {
    const { player, itemId } = event;
    if (!quest.isStarted(player)) {
      return;
    }
    if (itemId === KASONDES_JOURNAL) {
      event.handled = true;
      advance(player, 4);
      openBook(player, "Kasonde's Journal", reading.journalPages);
      return;
    }
    if (itemId === WORD_TRANSLATIONS) {
      event.handled = true;
      openTranslations(player);
      return;
    }
    const index = TABLETS.indexOf(itemId);
    if (index >= 0) {
      event.handled = true;
      readTablet(player, index);
      return;
    }
    if (itemId === WARNING_NOTE) {
      event.handled = true;
      if (quest.getStage(player) < 54 || !has(player, WARNING_NOTE)) {
        return;
      }
      opened.set(player, "warning");
      player.getPacketSender().sendInterface(NOTE_GROUP).sendClientScript(418, "", reading.warningNote);
      return;
    }
    const note = [DIRTY_NOTE, DIRTY_NOTE_2, DIRTY_NOTE_3].indexOf(itemId);
    if (note >= 0) {
      event.handled = true;
      if (!has(player, itemId)) return;
      opened.set(player, "dirty-note");
      player.getPacketSender().sendInterface(NOTE_GROUP).sendClientScript(418, "", reading.dirtyNotes[note]);
      return;
    }
    const carving = Array.from({ length: 14 }, (_, i) => i ? ItemIdentifiers[`WOOD_CARVING_${i + 1}`] : ItemIdentifiers.WOOD_CARVING).indexOf(itemId);
    if (carving >= 0) {
      event.handled = true;
      const seen = new Set(String(player.getAttribute(SEEN_WORDS_ATTRIBUTE) || "").split("|"));
      for (const word of [["Ikam"], ["Ates"], ["Silam"], ["Achi"], ["Ayak", "Ehke", "Tepat"], ["Chua"], ["Kemo"], ["Ami"], ["Lini"], ["Amok"], ["Siua"], ["Ralo", "Rani"], ["Ehke", "Tepat"], ["Tal", "Miki", "Yoka"]][carving])
        seen.add(word);
      player.setAttribute(SEEN_WORDS_ATTRIBUTE, [...seen].join("|"));
      player.getPacketSender().sendInterface(CARVINGS[carving]);
      return;
    }
    if (itemId === COMPASS) {
      event.handled = true;
      statement(player, "Rather than the usual labels, the compass points are instead marked as 'Makt', 'Uitt', 'Takam' and 'Silam'.", COMPASS);
    }
  }

  function closed({ player, interfaceId }) {
    const open = opened.get(player);
    if (!open) {
      return;
    }
    if (interfaceId === TABLET_GROUP) {
      opened.delete(player);
      if (open === "first-tablet" && !has(player, WORD_TRANSLATIONS)) {
        startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "the-first-dungeon-reading-the-stone-tablet");
      }
      else if (open === "last-tablet" && !has(player, WARNING_NOTE)) {
        startTranscript(api, player, TRANSCRIPT_NPC_ID, PAGE, "the-fourth-dungeon-reading-the-stone-tablet-after-translating-it");
      }
    }
    else if (interfaceId === NOTE_GROUP) {
      opened.delete(player);
      if (open === "warning" && quest.getStage(player) === 54) {
        quest.complete(player);
        later(player, 3, () => statement(player, "Although you've now discovered the fate of the Old Ones, you feel that there could be more to find. Perhaps you should continue exploring and see if you can fully translate the stone tablets."));
      }
    }
  }

  function button(event) {
    if (event.buttonId === (TRANSLATIONS_GROUP << 16 | 5)) {
      if (opened.get(event.player) !== "translations") {
        return;
      }
      event.handled = true;
      promptTranslation(event.player);
    }
  }

  function condition({ npcId, player, stepId }) {
    if (npcId !== TRANSCRIPT_NPC_ID) {
      return null;
    }
    if (stepId === "OooLjQ") {
      return !hasSecateurs(player);
    }
    if (stepId === "ChpYRu") {
      return hasSecateurs(player);
    }
    if (stepId === "98t8-D") {
      return player.getInventory().getFreeSlots() < 1;
    }
    if (stepId === "Gy9FwW") {
      return player.getInventory().getFreeSlots() > 0;
    }
    return null;
  }

  function start({ player, npcId, hook }) {
    if (npcId === TRANSCRIPT_NPC_ID && hook === "quest:the-garden-of-death:start" && quest.getStage(player) === 0) {
      quest.setStage(player, 2);
    }
  }

  function action(event) {
    if (event.npcId !== TRANSCRIPT_NPC_ID) {
      return;
    }
    const { player, stepId } = event;
    const items = { FLIJGW: KASONDES_JOURNAL, "8YLvcl": SECATEURS, fBeqSs: WORD_TRANSLATIONS, YBLHVE: WARNING_NOTE }, item = items[stepId];
    if (item === undefined) {
      return;
    }
    event.handled = true;
    if (give(player, item, event.text)) {
      if (item === WORD_TRANSLATIONS) {
        advance(player, 12);
      }
      if (item === WARNING_NOTE) {
        advance(player, 54);
      }
    }
  }

  class Ruins extends Area {
    getName() {
      return "The Garden of Death ruins";
    }
    canTeleport(player) {
      player.sendMessage("An ancient magical force blocks your teleport.");
      return false;
    }
  }

  function login({ player }) {
    const legacy = player.getAttribute(LEGACY_WORDS_ATTRIBUTE);
    if (!player.getAttribute(VERSION_ATTRIBUTE)) {
      const stage = quest.getStage(player);
      if (stage > 0 && stage <= 7 && (stage % 2 === 1 || legacy !== undefined && legacy !== null)) {
        quest.setStage(player, [0, 2, 4, 16, 30, 40, 50, 56][stage]);
      }
      if (Number(legacy) > 0) {
        const oldWords = ["island", "water", "time", "vessel", "garden", "north", "west", "poison", "animal", "body", "food", "earth", "air", "fire", "make", "yes", "no", "move", "arrive", "east", "south", "few", "big", "sun", "moon", "life", "mind", "home"];
        player.setAttribute(WORDS_ATTRIBUTE, oldWords.filter((_, index) => (Number(legacy) & (1 << index)) !== 0).join("|"));
      }
      player.setAttribute(VERSION_ATTRIBUTE, 1);
    }
    syncScenery(player);
    player.getPacketSender().sendVarbit(FULLY_TRANSLATED_VARBIT, Number(player.getAttribute(FULLY_TRANSLATED_ATTRIBUTE) || 0));
    refreshQuestList(player);
  }

  function logout({ player }) {
    clearScenery(player);
    opened.delete(player);
    const token = pending.get(player);
    if (token) {
      TaskManager.cancelTasks(token);
    }
    pending.delete(player);
    player.getMovementQueue().setBlockMovement(false);
  }

  function buildJournal(player) {
    const stage = quest.getStage(player);
    if (stage >= 56) {
      return ["<str>I discovered the fate of the Old Ones and Kasonde's warning.</str>", "", "<col=ff0000>QUEST COMPLETE!</col>"];
    }
    if (stage >= 4) {
      return ["I found and read Kasonde's journal.", "I should explore the ancient ruins and translate the stone tablets."];
    }
    if (stage >= 2) {
      return ["I found Kasonde's journal. I should read it."];
    }
    return ["I can start this quest by searching the Tent at the campsite in the southern Kebos Lowlands.", "I need level 20 Farming."];
  }
  api.persistAttribute(LEGACY_WORDS_ATTRIBUTE);
  api.persistAttribute(VERSION_ATTRIBUTE, 0);
  api.persistAttribute(WORDS_ATTRIBUTE, "");
  api.persistAttribute(SEEN_WORDS_ATTRIBUTE, "");
  api.persistAttribute(FULLY_TRANSLATED_ATTRIBUTE, 0);
  quest = registerQuest(api, { key: "the_garden_of_death", name: PAGE, varpId: VARP_ID, varbitId: VARBIT_ID, startedValue: 2, completionValue: 56, questPoints: 1, xpRewards: [{ skillId: Skill.FARMING.getIndex(), amount: 10000, label: "Farming" }], buildJournal, onReward: player => player.getSkillManager().addExperiences(Skill.FARMING, 10000) });
  api.onNpcDialogueCondition(condition);
  api.onCustomEvent("npc-dialogue:hook", start);
  api.onCustomEvent("npc-dialogue:action", action);
  api.onObjectInteraction(handleObject);
  api.onItemOnObject(handleItemOnObject);
  api.onItemAction(handleItem);
  api.onCustomEvent("ladders:climb", rope);
  api.onInterfaceActionButton([(TRANSLATIONS_GROUP << 16) | 5], button);
  api.onCustomEvent("interface:closed", closed);
  api.registerArea(new Ruins(DUNGEONS.map(d => new Boundary(...d.bounds))));
  api.onPlayerLogin(login);
  api.onPlayerLogout(logout);
};
