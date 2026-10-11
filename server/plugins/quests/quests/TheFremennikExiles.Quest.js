/**
 * The Fremennik Exiles (members, grandmaster).
 *
 * The words come from the "The Fremennik Exiles" transcript page; this plugin supplies the
 * variant selection for Brundt the Chieftain, Freygerd, Reeso, Bardur, Baba Yaga, Peer the
 * Seer, the exiled-phase Fremenniks and the quest objects, the prose-condition answers and the
 * item hand-ins/consumption the wiki marks with stage directions.
 *
 * Stage varbit: 9459 "vikingexile" (varp 2595, bits 0-8). The cache's own consumers pin the
 * values used here: cache dbTable 0 row 55 ("The Fremennik Exiles", quest id 157) stores
 * endstate 130; the Rellekka sand pit/rockslide/boxes multilocs (4373/20091/20092) gain their
 * Search option at varbit 9459 = 15; the Mountain Camp geysers (20093/20094) gain Inspect at
 * 50; the Rellekka Fremennik Boat (37432) gains Travel at 81; the island cave (37433) changes
 * at 96; the exile meeting-place Brundt spawn (7318) shows at 35-65 and the longhall spawn
 * (3926) hides at 81-119 and shows again at 120-130 (NPC transforms keyed on 9459).
 *
 * Stages (varbit 9459): 1 started, 15 investigating (Freygerd/Reeso told, clue objects
 * searchable), 30 evidence handed to Freygerd, 35 exiled (Brundt south-east), 50 V's shield
 * component hunt (Brundt's explanation heard), 60 V's shield assembled, 62 shield handed to
 * Brundt, 66 kegs delivered (basilisk invasion), 67 invasion started, 80 invasion survived,
 * 81 board the boat, 85 Island of Stone, 86 door explained, 96 combination solved, 100 inside
 * Jormungand's Prison, 116 Jormungand defeated, 120 back in Rellekka for the celebration,
 * 130 complete (cache dbTable 0 row 55 endstate).
 *
 * Rewards per the OSRS Wiki: 2 Quest points, 50,000 Slayer, 50,000 Crafting and 30,000
 * Runecraft XP, V's shield, access to the Island of Stone, Basilisk Knights as a Slayer task,
 * the Dräpare honorific.
 *
 * Sources: OSRS Wiki "The Fremennik Exiles" and its transcript, `Transcript:Unsealed letter`
 * for the letter body; the cache for every id, varbit and placement (scripts/lookup-gameval.ts
 * and the quest DB row).
 *
 * Gaps / approximations:
 *  - The door combination lock uses the cache interface 622 (puzzle_vikingexile), which a
 *    quest plugin cannot drive; it is reimplemented as a Mastermind chatbox prompt (six runes,
 *    four slots, eight attempts, then the solution rolls over, as the wiki describes).
 *  - The Waterbirth Island Dungeon route (pet-rock floor buttons, rune-thrownaxe doors) is not
 *    simulated: during the shield hunt the dungeon's Cave entrances (8929/8930) teleport
 *    straight to Bardur's chamber, and the way back out is the real ladders or a teleport.
 *  - The market fight is a per-player instance in OSRS; here owner-only basilisk waves spawn in
 *    the Rellekka market. Point values are scaled to the 6-bit varbit 9466: a basilisk is worth
 *    9 and a Monstrous Basilisk 21 (63 = 100%), so a wave or two ends the fight instead of the
 *    wiki's 30 basilisk kills. Leaving the market mid-fight is not tracked.
 *  - The Jormungand's glare/binding attacks and Typhor's magic are not simulated; their
 *    conditions (C6zHQ6/DLVETM) are answered false and the combat shout random (Qz4JMN) is
 *    replayed as transcript text only.
 *  - The Item Retrieval Service (qY-jfP, the island deathbank) has no interface hook here; the
 *    Collect dialogue is replayed but nothing opens.
 *  - "being-exiled-bjorn-eldgrim" and "being-exiled-any-other-fremennik-in-rellekka" are not
 *    indexed to any NPC id in the dump and cannot fire.
 *  - The unsealed letter has no Read transcript in the dump; its body is sent as game messages
 *    from Transcript:Unsealed letter.
 *  - Lunar ore smelting (60 Smithing) is missing from the Smithing plugin, so a quest-scoped
 *    fallback smelts one lunar ore into one lunar bar at any furnace (13 Smithing XP).
 *  - The Dräpare honorific and the Neitiznot faceguard unlock are mirrored to varbit 9472 only;
 *    the repo has no title/faceguard systems.
 */
module.exports = function registerTheFremennikExilesQuest(api) {
  const {
    Bank,
    Equipment,
    ItemIdentifiers,
    Location,
    NpcDefinition,
    NpcIdentifiers,
    ObjectIdentifiers,
    Skill,
  } = api.core;
  const { loadTranscripts, registerQuest, startTranscript } = require("../QuestRuntime");
  const { startDialogue } = require("../../npcs/NpcDialogues.plugin.js");

  const PAGE = "The Fremennik Exiles";

  // ==========================================================================
  // Ids
  // ==========================================================================

  const BRUNDT_THE_CHIEFTAIN = NpcIdentifiers.BRUNDT_THE_CHIEFTAIN; // 8048
  const BRUNDT_LONGHALL = NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_6; // 9263, the longhall spawn's transform
  const BRUNDT_SOUTH_EAST = NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_8; // 9266, the exile meeting place
  const BRUNDT_ISLAND_DOOR = NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_9; // 9267
  const BRUNDT_ISLAND_PRISON = NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_10; // 9268
  const BRUNDT_NPC_IDS = new Set([
    BRUNDT_THE_CHIEFTAIN,
    NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_2, // 8145
    NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_3, // 8153
    NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_4, // 8161
    NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_5, // 8169
    BRUNDT_LONGHALL, // 9263
    NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_7, // 9265
    BRUNDT_SOUTH_EAST, // 9266
    BRUNDT_ISLAND_DOOR, // 9267
    BRUNDT_ISLAND_PRISON, // 9268
    NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_11, // 9278
    NpcIdentifiers.BRUNDT_THE_CHIEFTAIN_12, // 9279
  ]);

  const FREYGERD = NpcIdentifiers.FREYGERD_2; // 3942
  const REESO = NpcIdentifiers.REESO; // 5388
  const ASKELADDEN = NpcIdentifiers.ASKELADDEN; // 8402
  const ASKELADDEN_NPC_IDS = new Set([
    ASKELADDEN,
    NpcIdentifiers.ASKELADDEN_2, // 8403
    NpcIdentifiers.ASKELADDEN_3, // 8404
    NpcIdentifiers.ASKELADDEN_4, // 8405
  ]);
  const BARDUR = NpcIdentifiers.BARDUR; // 2263
  const BABA_YAGA = NpcIdentifiers.BABA_YAGA; // 3837
  const PEER_THE_SEER = NpcIdentifiers.PEER_THE_SEER; // 3895
  const PEER_THE_SEER_2 = NpcIdentifiers.PEER_THE_SEER_2; // 8147
  const PEER_NPC_IDS = new Set([PEER_THE_SEER, PEER_THE_SEER_2]);
  const FOSSEGRIMEN = NpcIdentifiers.FOSSEGRIMEN; // 808
  const JARVALD = NpcIdentifiers.JARVALD; // 5937, spawned by this plugin while exiled
  const JARVALD_2 = NpcIdentifiers.JARVALD_2; // 7205
  const JARVALD_3 = NpcIdentifiers.JARVALD_3; // 10407, the Waterbirth dock spawn
  const TORFINN = NpcIdentifiers.TORFINN; // 8131
  const TORFINN_NPC_IDS = new Set([
    TORFINN,
    NpcIdentifiers.TORFINN_2, // 10403
    NpcIdentifiers.TORFINN_3, // 10404
    NpcIdentifiers.TORFINN_4, // 10405
    NpcIdentifiers.TORFINN_5, // 10406
  ]);
  const THORODIN_NPC_IDS = new Set([NpcIdentifiers.THORODIN, NpcIdentifiers.THORODIN_2]); // 1094, 5526
  const FALO_THE_BARD = NpcIdentifiers.FALO_THE_BARD; // 7306
  const MARIA_GUNNARS_NPC_IDS = new Set([
    NpcIdentifiers.MARIA_GUNNARS, // 1882
    NpcIdentifiers.MARIA_GUNNARS_2, // 1883
  ]);
  const MORD_GUNNARS_NPC_IDS = new Set([
    NpcIdentifiers.MORD_GUNNARS, // 1900
    NpcIdentifiers.MORD_GUNNARS_2, // 1940
  ]);
  const OLAF_THE_BARD = NpcIdentifiers.OLAF_THE_BARD; // 802
  const SAILOR = NpcIdentifiers.SAILOR; // 3680, the Miscellania dock
  const SAILOR_2 = NpcIdentifiers.SAILOR_2; // 3936, the Rellekka dock
  const SAILOR_NPC_IDS = new Set([SAILOR, SAILOR_2]);
  const HASKELL_NPC_IDS = new Set([
    NpcIdentifiers.HASKELL, // 9270
    NpcIdentifiers.HASKELL_2, // 9271
    NpcIdentifiers.HASKELL_3, // 9272
  ]);
  const BASILISK_YOUNGLING = NpcIdentifiers.BASILISK_YOUNGLING; // 9282
  const MARKET_BASILISK_IDS = new Set([
    NpcIdentifiers.BASILISK, // 9283
    NpcIdentifiers.BASILISK_4, // 9284
    NpcIdentifiers.BASILISK_5, // 9285
    NpcIdentifiers.BASILISK_6, // 9286
  ]);
  const MARKET_MONSTROUS_IDS = new Set([
    NpcIdentifiers.MONSTROUS_BASILISK_2, // 9287
    NpcIdentifiers.MONSTROUS_BASILISK_3, // 9288
  ]);
  const TYPHOR = NpcIdentifiers.TYPHOR; // 9295
  const TYPHOR_2 = NpcIdentifiers.TYPHOR_2; // 9296
  const TYPHOR_NPC_IDS = new Set([TYPHOR, TYPHOR_2]);
  const THE_JORMUNGAND = NpcIdentifiers.THE_JORMUNGAND; // 9289
  const JORMUNGAND_NPC_IDS = new Set([
    THE_JORMUNGAND,
    NpcIdentifiers.THE_JORMUNGAND_2, // 9290
    NpcIdentifiers.THE_JORMUNGAND_3, // 9291
    NpcIdentifiers.THE_JORMUNGAND_4, // 9292
  ]);
  const BAKUNA = NpcIdentifiers.BAKUNA; // 9294
  const VRITRA = NpcIdentifiers.VRITRA; // 9297

  const DIALOGUE_NPC_IDS = new Set([
    ...BRUNDT_NPC_IDS,
    FREYGERD,
    REESO,
    ...ASKELADDEN_NPC_IDS,
    BARDUR,
    BABA_YAGA,
    ...PEER_NPC_IDS,
    FOSSEGRIMEN,
    JARVALD,
    JARVALD_2,
    JARVALD_3,
    ...TORFINN_NPC_IDS,
    ...THORODIN_NPC_IDS,
    FALO_THE_BARD,
    ...MARIA_GUNNARS_NPC_IDS,
    ...MORD_GUNNARS_NPC_IDS,
    OLAF_THE_BARD,
    ...SAILOR_NPC_IDS,
    NpcIdentifiers.HASKELL,
    NpcIdentifiers.HASKELL_2,
    NpcIdentifiers.HASKELL_3,
    THE_JORMUNGAND,
  ]);

  const FANG_ITEM = ItemIdentifiers.FANG; // 24254
  const VENOM_GLAND_ITEM = ItemIdentifiers.VENOM_GLAND; // 24255
  const UNSEALED_LETTER_ITEM = ItemIdentifiers.UNSEALED_LETTER; // 24256
  const UNSEALED_LETTER_2_ITEM = ItemIdentifiers.UNSEALED_LETTER_2; // 24257
  const V_SIGIL_ITEM = ItemIdentifiers.V_SIGIL; // 24258
  const V_SIGIL_E_ITEM = ItemIdentifiers.V_SIGIL_E_; // 24259
  const MOLTEN_GLASS_I_ITEM = ItemIdentifiers.MOLTEN_GLASS_I_; // 24260
  const LUNAR_GLASS_ITEM = ItemIdentifiers.LUNAR_GLASS; // 24261
  const POLISHING_ROCK_ITEM = ItemIdentifiers.POLISHING_ROCK; // 24262
  const VS_SHIELD_ITEM = ItemIdentifiers.VS_SHIELD_2; // 24266, the wieldable shield
  const PET_ROCK_ITEM = ItemIdentifiers.PET_ROCK; // 3695
  const FREMENNIK_SHIELD_ITEM = ItemIdentifiers.FREMENNIK_SHIELD; // 3758
  const FREMENNIK_SHIELD_2_ITEM = ItemIdentifiers.FREMENNIK_SHIELD_2; // 16759
  const MOLTEN_GLASS_ITEM = ItemIdentifiers.MOLTEN_GLASS; // 1775
  const GLASSBLOWING_PIPE_ITEM = ItemIdentifiers.GLASSBLOWING_PIPE; // 1785
  const LUNAR_BAR_ITEM = ItemIdentifiers.LUNAR_BAR; // 9077
  const LUNAR_ORE_ITEM = ItemIdentifiers.LUNAR_ORE; // 9076
  const ASTRAL_RUNE_ITEM = ItemIdentifiers.ASTRAL_RUNE; // 9075
  const ICE_GLOVES_ITEM = ItemIdentifiers.ICE_GLOVES; // 1580
  const SMITHS_GLOVES_I_ITEM = ItemIdentifiers.SMITHS_GLOVES_I_; // 27031
  const KEG_OF_BEER_ITEM = ItemIdentifiers.KEG_OF_BEER_2; // 3801, the tradeable keg
  const KEG_OF_BEER_2_ITEM = ItemIdentifiers.KEG_OF_BEER_3; // 3802
  const RING_OF_CHAROS_A_ITEM = ItemIdentifiers.RING_OF_CHAROS_A_; // 6465
  const COINS_ITEM = ItemIdentifiers.COINS; // 995

  const UNSEALED_LETTER_ITEMS = new Set([UNSEALED_LETTER_ITEM, UNSEALED_LETTER_2_ITEM]);
  const FREMENNIK_SHIELD_ITEMS = new Set([FREMENNIK_SHIELD_ITEM, FREMENNIK_SHIELD_2_ITEM]);
  const VS_SHIELD_ITEMS = new Set([
    ItemIdentifiers.VS_SHIELD, // 24265
    VS_SHIELD_ITEM, // 24266
    ItemIdentifiers.VS_SHIELD_3, // 24267
  ]);
  const KEG_ITEMS = new Set([KEG_OF_BEER_ITEM, KEG_OF_BEER_2_ITEM]);
  const FISHING_ROD_ITEMS = new Set([
    ItemIdentifiers.FISHING_ROD, // 307
    ItemIdentifiers.FISHING_ROD_2, // 308
    ItemIdentifiers.FLY_FISHING_ROD, // 309
    ItemIdentifiers.FLY_FISHING_ROD_2, // 310
    ItemIdentifiers.BARBARIAN_ROD, // 11323
  ]);

  const SAND_PIT_IDS = new Set([
    ObjectIdentifiers.SAND_PIT_3, // 37391, the searchable state
    ObjectIdentifiers.SAND_PIT_4, // 37392
  ]);
  const ROCKSLIDE_IDS = new Set([
    ObjectIdentifiers.ROCKSLIDE_53, // 37395
    ObjectIdentifiers.ROCKSLIDE_54, // 37396
  ]);
  const BOXES_IDS = new Set([
    ObjectIdentifiers.BOXES_37, // 37398
    ObjectIdentifiers.BOXES_38, // 37399
  ]);
  const SMALL_GEYSER_IDS = new Set([
    ObjectIdentifiers.SMALL_GEYSER_2, // 37400
    ObjectIdentifiers.SMALL_GEYSER_3, // 37401
  ]);
  const LARGE_GEYSER_IDS = new Set([
    ObjectIdentifiers.LARGE_GEYSER_3, // 37402
    ObjectIdentifiers.LARGE_GEYSER_4, // 37403
  ]);
  const FREMENNIK_BOAT_IDS = new Set([
    ObjectIdentifiers.FREMENNIK_BOAT_6, // 37406
    ObjectIdentifiers.FREMENNIK_BOAT_7, // 37407
    ObjectIdentifiers.FREMENNIK_BOAT_8, // 37408, the Island of Stone side
  ]);
  const CAVE_IDS = new Set([
    ObjectIdentifiers.CAVE_74, // 37409
    ObjectIdentifiers.CAVE_75, // 37410
  ]);
  const WATERBIRTH_DUNGEON_IDS = new Set([
    ObjectIdentifiers.CAVE_ENTRANCE_40, // 8929
    ObjectIdentifiers.CAVE_ENTRANCE_41, // 8930
  ]);
  // Nameless multiloc parents placed in the map; forPlayer resolves them to the 37391+ ids.
  const SAND_PIT_PARENT = 4373;
  const ROCKSLIDE_PARENT = 20091;
  const BOXES_PARENT = 20092;
  const SMALL_GEYSER_PARENT = 20093;
  const LARGE_GEYSER_PARENT = 20094;
  const FREMENNIK_BOAT_PARENT = 37432;
  const CAVE_PARENT = 37433;
  const STRANGE_ALTAR = ObjectIdentifiers.STRANGE_ALTAR; // 4141
  const ASTRAL_ALTAR = ObjectIdentifiers.ALTAR_57; // 34771, Lunar Isle
  const ANVIL_IDS = new Set([
    ObjectIdentifiers.ANVIL, // 2031
    ObjectIdentifiers.AN_EXPERIMENTAL_ANVIL, // 2672
  ]);
  const FURNACE_IDS = new Set([
    ObjectIdentifiers.FURNACE, // 2030
    ObjectIdentifiers.FURNACE_2, // 2966
    ObjectIdentifiers.FURNACE_3, // 3294
    ObjectIdentifiers.SMALL_FURNACE, // 3994
  ]);

  // ==========================================================================
  // Varbits / stages / attributes
  // ==========================================================================

  const VARP_FREMENNIK_EXILES = 2595; // "vikingexile" parent
  const VARBIT_STAGE = 9459; // vikingexile, bits 0-8
  const VARBIT_YOUNGLING_KILLED = 9460;
  const VARBIT_LETTER_READ = 9461;
  const VARBIT_SHIELD_INFO = 9462;
  const VARBIT_GLASS_INFO = 9463;
  const VARBIT_ROCK_INFO = 9464;
  const VARBIT_SIGIL_INFO = 9465;
  const VARBIT_BASILISK_KILLS = 9466;
  const VARBIT_FREYGERD_TOLD = 9467;
  const VARBIT_YOUNGLING_FOUND = 9468;
  const VARBIT_BALLAD = 9469;
  const VARBIT_ROCK_GONE = 9470;
  const VARBIT_SHIELD_GIVEN = 9471;
  const VARBIT_HELM_UNLOCK = 9472;

  const STAGE_STARTED = 1;
  const STAGE_INVESTIGATING = 15;
  const STAGE_REPORTED = 30;
  const STAGE_EXILED = 35;
  const STAGE_COMPONENTS = 50;
  const STAGE_SHIELD_MADE = 60;
  const STAGE_SHIELD_GIVEN = 62;
  const STAGE_MARKET = 66;
  const STAGE_MARKET_FIGHT = 67;
  const STAGE_MARKET_DONE = 80;
  const STAGE_BOAT = 81;
  const STAGE_ISLAND = 85;
  const STAGE_DOOR_TOLD = 86;
  const STAGE_DOOR_OPEN = 96;
  const STAGE_PRISON = 100;
  const STAGE_JORMUNGAND_DEAD = 116;
  const STAGE_CELEBRATION = 120;
  const STAGE_COMPLETE = 130;

  const BASILISK_POINTS = 9;
  const MONSTROUS_POINTS = 21;
  const BASILISK_TARGET = 63;

  const LETTER_READ_ATTRIBUTE = "quest.the_fremennik_exiles.letter-read";
  const FREYGERD_TOLD_ATTRIBUTE = "quest.the_fremennik_exiles.freygerd-told";
  const YOUNGLING_FOUND_ATTRIBUTE = "quest.the_fremennik_exiles.youngling-found";
  const YOUNGLING_KILLED_ATTRIBUTE = "quest.the_fremennik_exiles.youngling-killed";
  const SAND_SEARCHED_ATTRIBUTE = "quest.the_fremennik_exiles.sand-searched";
  const SHIELD_INFO_ATTRIBUTE = "quest.the_fremennik_exiles.shield-info";
  const GLASS_INFO_ATTRIBUTE = "quest.the_fremennik_exiles.glass-info";
  const ROCK_INFO_ATTRIBUTE = "quest.the_fremennik_exiles.rock-info";
  const SIGIL_INFO_ATTRIBUTE = "quest.the_fremennik_exiles.sigil-info";
  const BARDUR_GOT_ATTRIBUTE = "quest.the_fremennik_exiles.bardur-got";
  const ROCK_ATTEMPTED_ATTRIBUTE = "quest.the_fremennik_exiles.rock-attempted";
  const PEER_FORGOT_ATTRIBUTE = "quest.the_fremennik_exiles.peer-forgot";
  const ROCK_GONE_ATTRIBUTE = "quest.the_fremennik_exiles.rock-gone";
  const SHIELD_GIVEN_ATTRIBUTE = "quest.the_fremennik_exiles.shield-given";
  const BASILISK_KILLS_ATTRIBUTE = "quest.the_fremennik_exiles.basilisk-kills";
  const MARKET_STARTED_ATTRIBUTE = "quest.the_fremennik_exiles.market-started";
  const TYPHOR_DEAD_ATTRIBUTE = "quest.the_fremennik_exiles.typhor-dead";
  const JORMUNGAND_DEAD_ATTRIBUTE = "quest.the_fremennik_exiles.jormungand-dead";
  const PUZZLE_OPEN_ATTRIBUTE = "quest.the_fremennik_exiles.puzzle-open";
  const PUZZLE_SOLUTION_ATTRIBUTE = "quest.the_fremennik_exiles.puzzle-solution";
  const PUZZLE_ATTEMPTS_ATTRIBUTE = "quest.the_fremennik_exiles.puzzle-attempts";
  const PUZZLE_GUESS_ATTRIBUTE = "quest.the_fremennik_exiles.puzzle-guess";

  // Tiles (checked walkable against the cache map).
  const WATERBIRTH_LANDING = new Location(2545, 3760, 0);
  const RELLEKKA_JARVALD_PIER = new Location(2641, 3709, 0);
  const BARDUR_LANDING = new Location(1849, 4390, 1);
  const RELLEKKA_MARKET_TILES = [
    new Location(2660, 3648, 0),
    new Location(2665, 3652, 0),
    new Location(2670, 3648, 0),
    new Location(2655, 3655, 0),
    new Location(2675, 3658, 0),
    new Location(2668, 3658, 0),
  ];
  const PRISON_ENTRY = new Location(2455, 10390, 0);
  const PRISON_TYPHOR = new Location(2458, 10380, 0);
  const PRISON_JORMUNGAND = new Location(2456, 10370, 0);
  const LONGHALL_LANDING = new Location(2659, 3665, 0);
  const RELLEKKA_PORT = new Location(2625, 3692, 0);
  const ISLAND_LANDING = new Location(2470, 4010, 0);

  const RUNE_NAMES = ["Air", "Water", "Earth", "Fire", "Astral", "Cosmic"];
  const PUZZLE_SLOTS = 4;
  const PUZZLE_MAX_ATTEMPTS = 8;

  const QUEST_KEYS = {
    fremennik_trials: "fremennik_trials",
    the_fremennik_isles: "the_fremennik_isles",
    lunar_diplomacy: "lunar_diplomacy",
    mountain_daughter: "mountain_daughter",
    heroes_quest: "heroes_quest",
  };

  const startMenu = new WeakSet();
  const trackedNpcs = new Map();
  const marketNpcs = new Map();

  let quest;

  // ==========================================================================
  // Small state helpers
  // ==========================================================================

  function stageOf(player) {
    return quest.getStage(player);
  }

  function setStage(player, value) {
    if (quest.getStage(player) === value) return;
    quest.setStage(player, value);
    syncVarbits(player);
    syncQuestNpcs(player);
  }

  function hasItem(player, itemId, amount = 1) {
    return player.getInventory().getAmount(itemId) >= amount;
  }

  function hasAnyItem(player, itemIds, amount = 1) {
    for (const itemId of itemIds) {
      if (player.getInventory().getAmount(itemId) >= amount) return true;
    }
    return false;
  }

  function inBank(player, itemId) {
    for (let tab = 0; tab < Bank.TOTAL_BANK_TABS; tab++) {
      if (player.getBank(tab)?.contains?.(itemId)) return true;
    }
    return false;
  }

  function hasItemAnywhere(player, itemId) {
    return hasItem(player, itemId) || inBank(player, itemId);
  }

  function hasAnyItemAnywhere(player, itemIds) {
    for (const itemId of itemIds) {
      if (hasItemAnywhere(player, itemId)) return true;
    }
    return false;
  }

  function addItem(player, itemId, amount = 1) {
    player.getInventory().adds(itemId, amount);
  }

  function takeItem(player, itemId, amount = 1) {
    if (!hasItem(player, itemId)) return false;
    player.getInventory().deleteNumber(itemId, amount);
    return true;
  }

  function takeAnyItem(player, itemIds, amount = 1) {
    for (const itemId of itemIds) {
      if (player.getInventory().getAmount(itemId) >= amount) {
        player.getInventory().deleteNumber(itemId, amount);
        return true;
      }
    }
    return false;
  }

  function hasQuestCompleted(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    return (
      hasQuestCompleted(player, QUEST_KEYS.fremennik_trials) &&
      hasQuestCompleted(player, QUEST_KEYS.the_fremennik_isles) &&
      hasQuestCompleted(player, QUEST_KEYS.lunar_diplomacy) &&
      hasQuestCompleted(player, QUEST_KEYS.mountain_daughter) &&
      hasQuestCompleted(player, QUEST_KEYS.heroes_quest) &&
      skills.getMaxLevel(Skill.CRAFTING) >= 65 &&
      skills.getMaxLevel(Skill.SLAYER) >= 60 &&
      skills.getMaxLevel(Skill.SMITHING) >= 60 &&
      skills.getMaxLevel(Skill.FISHING) >= 60 &&
      skills.getMaxLevel(Skill.RUNECRAFTING) >= 55
    );
  }

  function hasLetter(player) {
    return hasAnyItem(player, UNSEALED_LETTER_ITEMS);
  }

  function letterRead(player) {
    return player.getAttribute(LETTER_READ_ATTRIBUTE) === true;
  }

  function younglingFound(player) {
    return player.getAttribute(YOUNGLING_FOUND_ATTRIBUTE) === true;
  }

  function younglingKilled(player) {
    return player.getAttribute(YOUNGLING_KILLED_ATTRIBUTE) === true;
  }

  function sandSearched(player) {
    return player.getAttribute(SAND_SEARCHED_ATTRIBUTE) === true;
  }

  function freygerdTold(player) {
    return Number(player.getAttribute(FREYGERD_TOLD_ATTRIBUTE)) || 0;
  }

  function hasFremennikShield(player) {
    return hasAnyItem(player, FREMENNIK_SHIELD_ITEMS);
  }

  function hasGlovesEquipped(player) {
    const gloves = player.getEquipment().get(Equipment.HANDS_SLOT);
    const id = gloves?.getId?.();
    return id === ICE_GLOVES_ITEM || id === SMITHS_GLOVES_I_ITEM;
  }

  function hasGlovesInInventory(player) {
    return hasItem(player, ICE_GLOVES_ITEM) || hasItem(player, SMITHS_GLOVES_I_ITEM);
  }

  function hasFishingRod(player) {
    return hasAnyItem(player, FISHING_ROD_ITEMS);
  }

  function hasPetRock(player) {
    return hasItem(player, PET_ROCK_ITEM);
  }

  function rockGone(player) {
    return player.getAttribute(ROCK_GONE_ATTRIBUTE) === true;
  }

  function rockAttempted(player) {
    return player.getAttribute(ROCK_ATTEMPTED_ATTRIBUTE) === true;
  }

  function peerForgot(player) {
    return player.getAttribute(PEER_FORGOT_ATTRIBUTE) === true;
  }

  function hasPolishingRockAnywhere(player) {
    return hasItemAnywhere(player, POLISHING_ROCK_ITEM);
  }

  function shieldMade(player) {
    return hasAnyItem(player, VS_SHIELD_ITEMS);
  }

  function hasVsShieldInBank(player) {
    for (const itemId of VS_SHIELD_ITEMS) {
      if (inBank(player, itemId)) return true;
    }
    return false;
  }

  function kegCount(player) {
    let count = 0;
    for (const itemId of KEG_ITEMS) count += player.getInventory().getAmount(itemId);
    return count;
  }

  function killPercent(player) {
    return Number(player.getAttribute(BASILISK_KILLS_ATTRIBUTE)) || 0;
  }

  function setKillPercent(player, value) {
    const capped = Math.max(0, Math.min(BASILISK_TARGET, value | 0));
    player.setAttribute(BASILISK_KILLS_ATTRIBUTE, capped);
    player.getPacketSender().sendVarbit(VARBIT_BASILISK_KILLS, capped);
    return capped;
  }

  function marketStarted(player) {
    return player.getAttribute(MARKET_STARTED_ATTRIBUTE) === true;
  }

  function setMarketStarted(player, value) {
    player.setAttribute(MARKET_STARTED_ATTRIBUTE, value === true);
  }

  function typhorDead(player) {
    return player.getAttribute(TYPHOR_DEAD_ATTRIBUTE) === true;
  }

  function jormungandDead(player) {
    return player.getAttribute(JORMUNGAND_DEAD_ATTRIBUTE) === true;
  }

  function puzzleOpen(player) {
    return player.getAttribute(PUZZLE_OPEN_ATTRIBUTE) === true;
  }

  function resolvedObjectId(event) {
    if (typeof event.definition?.getId === "function") {
      const resolved = api.core.ObjectDefinition.forPlayer(event.objectId, event.player);
      return resolved?.getId?.() ?? event.definition.getId();
    }
    return event.objectId;
  }

  function contentNpcId(event) {
    return event.npc?.getContentId?.(event.player) ?? event.npcId;
  }

  function isExiled(player) {
    const stage = stageOf(player);
    return stage >= STAGE_EXILED && stage < STAGE_MARKET;
  }

  // ==========================================================================
  // Varbit sync
  // ==========================================================================

  function syncVarbits(player) {
    const sender = player.getPacketSender();
    sender.sendVarbit(VARBIT_YOUNGLING_KILLED, younglingKilled(player) ? 1 : 0);
    sender.sendVarbit(VARBIT_LETTER_READ, letterRead(player) ? 1 : 0);
    sender.sendVarbit(VARBIT_SHIELD_INFO, Number(player.getAttribute(SHIELD_INFO_ATTRIBUTE)) || 0);
    sender.sendVarbit(VARBIT_GLASS_INFO, Number(player.getAttribute(GLASS_INFO_ATTRIBUTE)) || 0);
    sender.sendVarbit(VARBIT_ROCK_INFO, Number(player.getAttribute(ROCK_INFO_ATTRIBUTE)) || 0);
    sender.sendVarbit(VARBIT_SIGIL_INFO, Number(player.getAttribute(SIGIL_INFO_ATTRIBUTE)) || 0);
    sender.sendVarbit(VARBIT_BASILISK_KILLS, killPercent(player));
    sender.sendVarbit(VARBIT_FREYGERD_TOLD, freygerdTold(player));
    sender.sendVarbit(VARBIT_YOUNGLING_FOUND, younglingFound(player) ? 1 : 0);
    sender.sendVarbit(VARBIT_BALLAD, quest.isComplete(player) ? 1 : 0);
    sender.sendVarbit(VARBIT_ROCK_GONE, rockGone(player) ? 1 : 0);
    sender.sendVarbit(VARBIT_SHIELD_GIVEN, player.getAttribute(SHIELD_GIVEN_ATTRIBUTE) === true ? 1 : 0);
    sender.sendVarbit(VARBIT_HELM_UNLOCK, quest.isComplete(player) ? 1 : 0);
  }

  function handleLogin({ player }) {
    syncVarbits(player);
    syncQuestNpcs(player);
  }

  function handleBootstrap({ player }) {
    syncVarbits(player);
    syncQuestNpcs(player);
  }

  function handleStageChanged(event) {
    if (event?.key !== "the_fremennik_exiles" || !event.player) return;
    syncVarbits(event.player);
    syncQuestNpcs(event.player);
  }

  // ==========================================================================
  // Spawns
  // ==========================================================================

  function syncTracked(player, key, spawn) {
    const tracked = trackedNpcs.get(player) ?? new Map();
    trackedNpcs.set(player, tracked);
    const existing = tracked.get(key);
    if (!spawn) {
      if (existing?.isRegistered?.()) api.removeNpc(existing);
      if (existing) tracked.delete(key);
      return null;
    }
    if (existing?.isRegistered?.() && existing.getId?.() === spawn.id) return existing;
    if (existing?.isRegistered?.()) api.removeNpc(existing);
    const npc = api.spawnNpc({ ...spawn, owner: player, ownerOnly: true });
    if (npc) tracked.set(key, npc);
    return npc;
  }

  function tracked(player, key) {
    return trackedNpcs.get(player)?.get(key) ?? null;
  }

  function syncQuestNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = stageOf(player);
    syncTracked(player, "jarvald", isExiled(player)
      ? { id: JARVALD, ...RELLEKKA_JARVALD_PIER, z: 0, wanderRadius: 0 }
      : null);
    // Askeladden has no world spawn in this repo; the exiled player needs him for a pet rock.
    syncTracked(player, "askeladden", isExiled(player)
      ? { id: ASKELADDEN, x: 2663, y: 3654, z: 0, wanderRadius: 0 }
      : null);
    if (stage >= STAGE_MARKET_FIGHT && stage < STAGE_MARKET_DONE && !marketWaveAlive(player)) {
      spawnMarketWave(player);
    }
    if (stage >= STAGE_PRISON && stage < STAGE_JORMUNGAND_DEAD && !typhorDead(player)) {
      ensurePrisonScene(player);
    } else if (stage >= STAGE_PRISON && stage < STAGE_JORMUNGAND_DEAD && typhorDead(player) && !jormungandDead(player)) {
      ensureJormungand(player);
    }
  }

  function ensurePrisonScene(player) {
    syncTracked(player, "bakuna", { id: BAKUNA, x: 2458, y: 10385, z: 0, wanderRadius: 0 });
    syncTracked(player, "vritra", { id: VRITRA, x: 2452, y: 10380, z: 0, wanderRadius: 0 });
    // 9295 is the non-attackable Typhor; 9296 carries the Attack option.
    syncTracked(player, "typhor", { id: TYPHOR_2, ...PRISON_TYPHOR, z: 0, wanderRadius: 0 });
  }

  function ensureJormungand(player) {
    syncTracked(player, "bakuna", null);
    syncTracked(player, "vritra", null);
    syncTracked(player, "typhor", null);
    // 9289 is the non-attackable Jormungand; 9291 carries the Attack option.
    syncTracked(player, "jormungand", { id: NpcIdentifiers.THE_JORMUNGAND_3, ...PRISON_JORMUNGAND, z: 0, wanderRadius: 0 });
  }

  function clearMarketNpcs(player) {
    const wave = marketNpcs.get(player) ?? [];
    for (const npc of wave) {
      if (npc?.isRegistered?.()) api.removeNpc(npc);
    }
    marketNpcs.delete(player);
  }

  function marketWaveAlive(player) {
    const wave = marketNpcs.get(player) ?? [];
    return wave.some((npc) => npc?.isRegistered?.() && npc.getHitpoints?.() > 0);
  }

  function spawnMarketWave(player) {
    clearMarketNpcs(player);
    const wave = [];
    RELLEKKA_MARKET_TILES.forEach((tile, index) => {
      const isMonstrous = index === RELLEKKA_MARKET_TILES.length - 1;
      const npc = api.spawnNpc({
        id: isMonstrous ? NpcIdentifiers.MONSTROUS_BASILISK_2 : NpcIdentifiers.BASILISK,
        x: tile.getX(),
        y: tile.getY(),
        z: tile.getZ(),
        wanderRadius: 4,
        owner: player,
        ownerOnly: true,
      });
      if (npc) wave.push(npc);
    });
    marketNpcs.set(player, wave);
  }

  function startMarketFight(player) {
    setMarketStarted(player, true);
    setStage(player, STAGE_MARKET_FIGHT);
    spawnMarketWave(player);
    player.sendMessage("Basilisks pour into the Rellekka market!");
  }

  // ==========================================================================
  // Variant selection (transcript pages this plugin owns)
  // ==========================================================================

  function selectVariant(event) {
    const player = event?.player;
    if (!player) return null;
    const npcId = contentNpcId(event);
    const stage = stageOf(player);

    if (npcId === FREYGERD) return freygerdVariants(player, stage);
    if (npcId === REESO) return reesoVariants(player, stage);
    if (npcId === BARDUR) return bardurVariants(player, stage);
    if (npcId === BABA_YAGA) return babaYagaVariants(player, stage);
    if (npcId === JARVALD || npcId === JARVALD_2 || npcId === JARVALD_3) return jarvaldVariants(player, npcId, stage);
    if (TORFINN_NPC_IDS.has(npcId)) return exileOnly(player, "being-exiled-torfinn-before-dragon-slayer-ii", stage);
    if (THORODIN_NPC_IDS.has(npcId)) return exileOnly(player, "being-exiled-thorodin", stage);
    if (npcId === FALO_THE_BARD) return exileOnly(player, "being-exiled-falo-the-bard", stage);
    if (MARIA_GUNNARS_NPC_IDS.has(npcId)) return exileOnly(player, "being-exiled-maria-gunnars", stage);
    if (MORD_GUNNARS_NPC_IDS.has(npcId)) return exileOnly(player, "being-exiled-mord-gunnars", stage);
    if (HASKELL_NPC_IDS.has(npcId)) return haskellVariant(player, npcId, stage);
    return null;
  }

  function exileOnly(player, variant, stage) {
    return stage >= STAGE_EXILED && stage < STAGE_MARKET ? { page: PAGE, variant } : null;
  }

  function freygerdVariants(player, stage) {
    if (stage < STAGE_STARTED || stage >= STAGE_EXILED) return null;
    if (stage < STAGE_INVESTIGATING) {
      setStage(player, STAGE_INVESTIGATING);
      return "investigating-the-disturbance-freygerd";
    }
    if (stage < STAGE_REPORTED) {
      if (hasLetter(player)) {
        takeAnyItem(player, UNSEALED_LETTER_ITEMS);
        takeItem(player, VENOM_GLAND_ITEM);
        takeItem(player, FANG_ITEM);
        player.setAttribute(FREYGERD_TOLD_ATTRIBUTE, 1);
        setStage(player, STAGE_REPORTED);
        return "investigating-the-disturbance-after-acquiring-the-unsealed-letter-freygerd";
      }
      return "investigating-the-disturbance-freygerd-again";
    }
    if (freygerdTold(player) >= 2) {
      return "investigating-the-disturbance-after-acquiring-the-unsealed-letter-freygerd-again-freygerd-after-telling-her-about-the-basilisk";
    }
    return "investigating-the-disturbance-after-acquiring-the-unsealed-letter-freygerd-again";
  }

  function reesoVariants(player, stage) {
    if (stage < STAGE_STARTED || stage >= STAGE_EXILED) return null;
    if (stage < STAGE_INVESTIGATING) {
      setStage(player, STAGE_INVESTIGATING);
      return "investigating-the-disturbance-reeso";
    }
    if (stage >= STAGE_REPORTED) {
      return "investigating-the-disturbance-after-acquiring-the-unsealed-letter-reeso-again";
    }
    if (hasLetter(player)) {
      return "investigating-the-disturbance-after-acquiring-the-unsealed-letter-reeso";
    }
    return "investigating-the-disturbance-reeso-again";
  }

  function bardurVariants(player, stage) {
    if (stage < STAGE_EXILED || stage >= STAGE_MARKET) return null;
    if (stage < STAGE_COMPONENTS) return "being-exiled-bardur";
    if (player.getAttribute(BARDUR_GOT_ATTRIBUTE) === true) {
      return "making-v-s-shield-fremennik-shield-bardur-after-receiving-a-fremennik-shield-from-him";
    }
    return "making-v-s-shield-fremennik-shield-bardur";
  }

  function babaYagaVariants(player, stage) {
    if (stage < STAGE_COMPONENTS || stage >= STAGE_MARKET) return null;
    const info = Number(player.getAttribute(GLASS_INFO_ATTRIBUTE)) || 0;
    if (info >= 2) return "making-v-s-shield-lunar-glass-baba-yaga-again-after-she-imbues-the-molten-glass";
    if (info >= 1) return "making-v-s-shield-lunar-glass-baba-yaga-again";
    player.setAttribute(GLASS_INFO_ATTRIBUTE, 1);
    return "making-v-s-shield-lunar-glass-baba-yaga";
  }

  function jarvaldVariants(player, npcId, stage) {
    if (stage < STAGE_EXILED || stage >= STAGE_MARKET) return null;
    if (npcId === JARVALD) return "being-exiled-jarvald-rellekka";
    return "being-exiled-jarvald-waterbirth-island";
  }

  function haskellVariant(player, npcId, stage) {
    if (stage < STAGE_BOAT) return null;
    if (npcId === NpcIdentifiers.HASKELL) return "after-the-fremennik-exiles-rellekka";
    if (npcId === NpcIdentifiers.HASKELL_2) return "after-the-fremennik-exiles-rellekka";
    return "after-the-fremennik-exiles-island-of-stone";
  }

  // ==========================================================================
  // Prison scenes
  //
  // startTranscript flattens wiki speakers onto one chathead; the prison scenes
  // swap between Typhor/Bakuna/Vritra and the Jormungand, so play them through
  // NpcDialogues directly with the speaker -> NPC id map.
  // ==========================================================================

  const PRISON_SPEAKERS = new Map([
    ["Typhor", TYPHOR_2],
    ["Bakuna", BAKUNA],
    ["Vritra", VRITRA],
    ["The Jormungand", NpcIdentifiers.THE_JORMUNGAND_3],
    ["Brundt the Chieftain", BRUNDT_ISLAND_PRISON],
  ]);

  function playScene(player, npcId, variant) {
    const record = loadTranscripts(api)?.[PAGE];
    const steps = record?.variants?.[variant];
    if (!Array.isArray(steps) || steps.length === 0) return false;
    const definition = NpcDefinition.forId(npcId);
    const event = { player, npc: null, npcId, definition };
    startDialogue(api, event, steps, record.branches, {
      player,
      npc: null,
      npcId,
      definition,
      speakerIdByName: PRISON_SPEAKERS,
    });
    return true;
  }

  // ==========================================================================
  // Brundt / Peer / Askeladden / Sailor Talk-to overrides
  //
  // Fremennik Trials' variant selector claims these shared NPCs post-Trials, so the exiles
  // overrides them on the interaction hook and start the transcript themselves.
  // ==========================================================================

  function talksToMyQuest(event) {
    const player = event.player;
    if (!player) return false;
    const npcId = contentNpcId(event);
    const stage = stageOf(player);

    if (BRUNDT_NPC_IDS.has(npcId)) {
      const choice = brundtVariant(player, npcId, stage);
      const variant = typeof choice === "string" ? choice : choice?.variant;
      if (!variant) return false;
      event.handled = true;
      if (variant === "starting-out-brundt-the-chieftain") startMenu.add(player);
      // The prison scene swaps speakers, so give each line its own chathead.
      if (npcId === BRUNDT_ISLAND_PRISON) {
        playScene(player, npcId, variant);
        return true;
      }
      api.emitCustomEvent("npc-dialogue:start", {
        player,
        npc: event.npc,
        npcId,
        variant,
        select: typeof choice === "object" ? choice.select : undefined,
      });
      return true;
    }

    if (npcId === BABA_YAGA) {
      // Lunar Diplomacy's post-quest selector claims her; this specific hook runs
      // before the generic transcript resolver, so the shield hunt gets its menu.
      const variant = babaYagaVariants(player, stage);
      if (!variant) return false;
      event.handled = true;
      api.emitCustomEvent("npc-dialogue:start", { player, npc: event.npc, npcId, variant });
      return true;
    }

    if (PEER_NPC_IDS.has(npcId)) {
      if (!isExiled(player) || stage < STAGE_COMPONENTS) return false;
      if (!rockAttempted(player) || peerForgot(player)) return false;
      event.handled = true;
      api.emitCustomEvent("npc-dialogue:start", {
        player,
        npc: event.npc,
        npcId,
        variant: "making-v-s-shield-polishing-rock-peer-the-seer",
      });
      return true;
    }

    if (ASKELADDEN_NPC_IDS.has(npcId)) {
      if (!isExiled(player)) return false;
      event.handled = true;
      api.emitCustomEvent("npc-dialogue:start", {
        player,
        npc: event.npc,
        npcId,
        variant: "being-exiled-askeladden",
      });
      return true;
    }

    if (SAILOR_NPC_IDS.has(npcId)) {
      if (!isExiled(player)) return false;
      event.handled = true;
      api.emitCustomEvent("npc-dialogue:start", {
        player,
        npc: event.npc,
        npcId,
        variant: npcId === SAILOR_2 ? "being-exiled-sailor-rellekka" : "being-exiled-sailor-miscellania",
      });
      return true;
    }

    return false;
  }

  function brundtVariant(player, npcId, stage) {
    if (npcId === BRUNDT_SOUTH_EAST) {
      if (stage < STAGE_EXILED || stage >= STAGE_MARKET) return null;
      if (stage < STAGE_COMPONENTS) {
        setStage(player, STAGE_COMPONENTS);
        return "undoing-the-exilement-brundt";
      }
      if (stage < STAGE_SHIELD_MADE) return "undoing-the-exilement-brundt-again";
      if (stage === STAGE_SHIELD_MADE) {
        if (hasVsShieldInBank(player)) {
          return "making-v-s-shield-making-the-shield-brundt-with-v-s-shield-in-the-bank";
        }
        if (!shieldMade(player)) return "undoing-the-exilement-brundt-again";
        return "making-v-s-shield-making-the-shield-brundt-with-v-s-shield-without-two-kegs-of-beer";
      }
      if (kegCount(player) >= 2) {
        // The with-kegs variant opens and closes on "same as above" jumps into a
        // menu elsewhere on the page (the last one is Fossegrimen's); neither
        // resolves standalone, so drop them and let the beer hand-over play.
        return {
          variant: "making-v-s-shield-making-the-shield-brundt-with-v-s-shield-and-two-kegs-of-beer",
          select: (steps) => (Array.isArray(steps) ? steps.filter((step) => step.type !== "jump") : steps),
        };
      }
      return "making-v-s-shield-making-the-shield-brundt-with-v-s-shield-without-two-kegs-of-beer-bringing-the-kegs-afterwards";
    }
    if (npcId === BRUNDT_ISLAND_DOOR) {
      if (stage < STAGE_ISLAND || stage >= STAGE_PRISON) return null;
      if (stage < STAGE_DOOR_TOLD) {
        setStage(player, STAGE_DOOR_TOLD);
        return "island-of-stone-brundt";
      }
      if (stage < STAGE_DOOR_OPEN) return "island-of-stone-brundt-brundt-again";
      if (stage === STAGE_DOOR_OPEN) {
        setStage(player, STAGE_DOOR_OPEN + 1);
        return "island-of-stone-brundt-unlocking-the-door";
      }
      return "island-of-stone-brundt-again-after-unlocking-the-door";
    }
    if (npcId === BRUNDT_ISLAND_PRISON) {
      if (stage < STAGE_PRISON || stage >= STAGE_JORMUNGAND_DEAD) return null;
      return "island-of-stone-brundt-again-after-unlocking-the-door-going-into-jormungand-s-prison";
    }
    // The longhall Brundt.
    if (stage <= 0) {
      if (!meetsRequirements(player)) return null;
      return "starting-out-brundt-the-chieftain";
    }
    if (stage < STAGE_INVESTIGATING) {
      return "starting-out-brundt-the-chieftain-when-talked-to-again-before-going-to-investigate";
    }
    if (stage < STAGE_EXILED) {
      return "investigating-the-disturbance-after-acquiring-the-unsealed-letter-brundt";
    }
    if (stage < STAGE_MARKET) {
      return "being-exiled-brundt";
    }
    if (stage < STAGE_MARKET_DONE) {
      if (stage === STAGE_MARKET && !marketStarted(player)) {
        return "basilisks-in-the-market-brundt";
      }
      return "basilisks-in-the-market-brundt-again";
    }
    if (stage === STAGE_MARKET_DONE) {
      return "basilisks-in-the-market-brundt-again-after-killing-enough-basilisks";
    }
    if (stage >= STAGE_CELEBRATION && stage < STAGE_COMPLETE) {
      return "longhall-celebration";
    }
    if (stage >= STAGE_COMPLETE) {
      return "standard-dialogue-after-the-fremennik-exiles";
    }
    return null;
  }

  // ==========================================================================
  // Prose condition answers
  // ==========================================================================

  function answerCondition(event) {
    const { player, stepId } = event;
    if (!player || !stepId) return null;
    const freeSlot = player.getInventory().getFreeSlots() > 0;
    switch (stepId) {
      // Inventory space (boxes, rockslide, sand pit).
      case "GCFS54":
      case "8Q-E67":
        return !freeSlot;
      case "KGOb__":
      case "c5H4CI":
        return freeSlot;
      // The unsealed letter.
      case "1QUfx_":
        return hasLetter(player);
      case "DYv8e2":
        return !hasLetter(player) && !freeSlot;
      case "1STYgW":
        return !hasLetter(player);
      case "eFLDx5":
        return !letterRead(player);
      case "IRogRM":
        return !hasLetter(player);
      case "C5vRKR":
        return letterRead(player);
      // Fremennik shield.
      case "1dygsA":
        return hasFremennikShield(player);
      case "rNkcIz":
        return !hasFremennikShield(player);
      case "0Ac_mq":
        return hasAnyItemAnywhere(player, FREMENNIK_SHIELD_ITEMS);
      case "3ppJYa":
        return !hasAnyItemAnywhere(player, FREMENNIK_SHIELD_ITEMS);
      // Molten glass and molten glass (i).
      case "hia57h":
      case "L9f-vG":
      case "yj3IxO":
        return !hasItem(player, MOLTEN_GLASS_ITEM);
      case "ffjoLb":
      case "tEOn3E":
      case "OQRvzn":
        return hasItem(player, MOLTEN_GLASS_ITEM);
      case "wh85o9":
        return !hasItem(player, MOLTEN_GLASS_I_ITEM);
      case "HVD0O6":
        return hasItem(player, MOLTEN_GLASS_I_ITEM) && !hasItem(player, ASTRAL_RUNE_ITEM, 100);
      case "Bsq0Q6":
        return hasItem(player, MOLTEN_GLASS_I_ITEM) && hasItem(player, ASTRAL_RUNE_ITEM, 100);
      case "Mw2A_K":
        return hasItem(player, MOLTEN_GLASS_I_ITEM);
      case "puIcJz":
        return !hasItem(player, MOLTEN_GLASS_I_ITEM);
      case "7Qi3Ua":
        return hasItemAnywhere(player, LUNAR_GLASS_ITEM);
      // Pet rock and the geyser.
      case "4wwkfk":
      case "upcKPL":
        return !hasPetRock(player);
      case "mZk-yK":
      case "tOBGEa":
        return hasPetRock(player);
      case "pqQg4L":
        return !rockGone(player);
      case "k6qIvx":
        return rockGone(player);
      // Gloves.
      case "G99VCG":
        return !hasGlovesEquipped(player);
      case "cvO2CX":
        return !hasGlovesInInventory(player);
      case "k4hbGi":
        return hasGlovesInInventory(player);
      case "rrj50Q":
        return hasGlovesEquipped(player);
      // Polishing rock.
      case "O4HyUr":
        return hasItem(player, POLISHING_ROCK_ITEM);
      case "gsF60N":
        return inBank(player, POLISHING_ROCK_ITEM);
      // Lunar bars and the V sigil.
      case "Q7HhQQ":
        return player.getInventory().getAmount(LUNAR_BAR_ITEM) < 3;
      case "C4wsVN":
        return player.getInventory().getAmount(LUNAR_BAR_ITEM) >= 3;
      case "zuvNDl":
        return !hasItem(player, V_SIGIL_ITEM);
      case "-DcC04":
        return hasItem(player, V_SIGIL_ITEM);
      // The glassblowing pipe.
      case "wOTBii":
        return !hasItem(player, GLASSBLOWING_PIPE_ITEM);
      case "3gyYTy":
        return hasItem(player, GLASSBLOWING_PIPE_ITEM);
      // The Jormungand's specials are not simulated.
      case "C6zHQ6":
      case "DLVETM":
        return false;
      default:
        return null;
    }
  }

  // ==========================================================================
  // Transcript action/message handler
  // ==========================================================================

  function handleAction(event) {
    const { player } = event;
    if (!player) return;
    switch (event.stepId) {
      case "GlBLqd":
        if (!hasItem(player, VENOM_GLAND_ITEM)) addItem(player, VENOM_GLAND_ITEM);
        return;
      case "VS6v4T":
        if (!hasItem(player, FANG_ITEM)) addItem(player, FANG_ITEM);
        return;
      case "2ifb16":
        findYoungling(player);
        return;
      case "-FwZ36":
      case "7GSRhQ":
        if (!hasLetter(player)) addItem(player, UNSEALED_LETTER_ITEM);
        return;
      case "3GZ_6N":
        if (BRUNDT_NPC_IDS.has(event.npcId) && stageOf(player) < STAGE_EXILED) {
          setStage(player, STAGE_EXILED);
        }
        return;
      case "0vNIwJ":
        buyFremennikShield(player);
        return;
      case "rVPVWw":
        receiveCharmedShield(player);
        return;
      case "RavOEl":
        if (!hasPetRock(player) && !rockGone(player)) addItem(player, PET_ROCK_ITEM);
        return;
      case "jql-pN":
      case "GEaVzt":
      case "hsbo5w":
        if (takeItem(player, MOLTEN_GLASS_ITEM)) {
          addItem(player, MOLTEN_GLASS_I_ITEM);
          player.setAttribute(GLASS_INFO_ATTRIBUTE, 2);
          player.getPacketSender().sendVarbit(VARBIT_GLASS_INFO, 2);
        }
        return;
      case "ozZK9D":
        if (hasItem(player, ASTRAL_RUNE_ITEM, 100) && takeItem(player, MOLTEN_GLASS_I_ITEM)) {
          player.getInventory().deleteNumber(ASTRAL_RUNE_ITEM, 100);
          addItem(player, LUNAR_GLASS_ITEM);
        }
        return;
      case "E44eQ-":
        if (player.getInventory().getAmount(LUNAR_BAR_ITEM) >= 3) {
          player.getInventory().deleteNumber(LUNAR_BAR_ITEM, 3);
          if (!hasItem(player, V_SIGIL_ITEM)) addItem(player, V_SIGIL_ITEM);
        }
        return;
      case "6KqfTH":
      case "A8Q8So":
        dropPetRock(player);
        return;
      case "YkBPHX":
      case "RhgQ8J":
        collectPolishingRock(player);
        return;
      case "hneqPY":
        player.setAttribute(ROCK_INFO_ATTRIBUTE, 2);
        player.getPacketSender().sendVarbit(VARBIT_ROCK_INFO, 2);
        return;
      case "mOTzCI":
        makeShield(player);
        return;
      case "jcMyFM":
        handShieldToBrundt(player);
        return;
      case "CyJ-jx":
        drinkKegs(player);
        return;
      case "mSB9hO":
        if (!shieldMade(player)) addItem(player, VS_SHIELD_ITEM);
        return;
      case "M7J2_U":
        if (stageOf(player) === STAGE_MARKET) startMarketFight(player);
        return;
      case "GciOqM":
        clearMarketNpcs(player);
        return;
      case "DwWDam":
        if (player) syncTracked(player, "bakuna", null);
        return;
      case "qY-jfP":
        player.sendMessage("Brundt's item retrieval service isn't available here.");
        return;
      case "TxYAiw":
        player.getPacketSender().sendVarbit(VARBIT_BALLAD, 1);
        return;
      case "2pgrdA":
        if (!quest.isComplete(player)) quest.complete(player);
        return;
      default:
        return;
    }
  }

  function findYoungling(player) {
    if (tracked(player, "youngling")?.isRegistered?.()) return;
    syncTracked(player, "youngling", {
      id: BASILISK_YOUNGLING,
      x: 2668,
      y: 3706,
      z: 0,
      wanderRadius: 2,
    });
    player.setAttribute(YOUNGLING_FOUND_ATTRIBUTE, true);
    player.getPacketSender().sendVarbit(VARBIT_YOUNGLING_FOUND, 1);
  }

  function buyFremennikShield(player) {
    if (!hasItem(player, COINS_ITEM, 150000)) {
      player.sendMessage("You don't have 150,000 coins.");
      return;
    }
    player.getInventory().deleteNumber(COINS_ITEM, 150000);
    addItem(player, FREMENNIK_SHIELD_ITEM);
    player.setAttribute(BARDUR_GOT_ATTRIBUTE, true);
    player.setAttribute(SHIELD_INFO_ATTRIBUTE, 1);
    player.getPacketSender().sendVarbit(VARBIT_SHIELD_INFO, 1);
  }

  function receiveCharmedShield(player) {
    const ring = player.getEquipment().get(Equipment.RING_SLOT)?.getId?.();
    if (ring !== RING_OF_CHAROS_A_ITEM && !hasItem(player, RING_OF_CHAROS_A_ITEM)) {
      player.sendMessage("Bardur is not charmed - the Ring of Charos(a) would help.");
      return;
    }
    if (!hasFremennikShield(player)) addItem(player, FREMENNIK_SHIELD_ITEM);
    player.setAttribute(BARDUR_GOT_ATTRIBUTE, true);
    player.setAttribute(SHIELD_INFO_ATTRIBUTE, 1);
    player.getPacketSender().sendVarbit(VARBIT_SHIELD_INFO, 1);
  }

  function dropPetRock(player) {
    if (rockGone(player)) return;
    if (!takeItem(player, PET_ROCK_ITEM)) return;
    player.setAttribute(ROCK_GONE_ATTRIBUTE, true);
    player.getPacketSender().sendVarbit(VARBIT_ROCK_GONE, 1);
  }

  function collectPolishingRock(player) {
    if (rockGone(player)) {
      player.setAttribute(ROCK_GONE_ATTRIBUTE, false);
      player.getPacketSender().sendVarbit(VARBIT_ROCK_GONE, 0);
    }
    if (!hasItem(player, POLISHING_ROCK_ITEM)) addItem(player, POLISHING_ROCK_ITEM);
    player.setAttribute(ROCK_INFO_ATTRIBUTE, 3);
    player.getPacketSender().sendVarbit(VARBIT_ROCK_INFO, 3);
  }

  function makeShield(player) {
    if (!hasItem(player, FREMENNIK_SHIELD_ITEM) && !hasItem(player, FREMENNIK_SHIELD_2_ITEM)) return;
    if (!takeAnyItem(player, FREMENNIK_SHIELD_ITEMS)) return;
    takeItem(player, LUNAR_GLASS_ITEM);
    takeItem(player, POLISHING_ROCK_ITEM);
    takeItem(player, V_SIGIL_E_ITEM);
    if (!hasItem(player, PET_ROCK_ITEM)) addItem(player, PET_ROCK_ITEM);
    addItem(player, VS_SHIELD_ITEM);
    setStage(player, STAGE_SHIELD_MADE);
  }

  function handShieldToBrundt(player) {
    takeAnyItem(player, VS_SHIELD_ITEMS);
    player.setAttribute(SHIELD_GIVEN_ATTRIBUTE, true);
    player.getPacketSender().sendVarbit(VARBIT_SHIELD_GIVEN, 1);
    setStage(player, STAGE_SHIELD_GIVEN);
  }

  function drinkKegs(player) {
    if (kegCount(player) >= 2) {
      let remaining = 2;
      for (const itemId of KEG_ITEMS) {
        const take = Math.min(remaining, player.getInventory().getAmount(itemId));
        if (take > 0) {
          player.getInventory().deleteNumber(itemId, take);
          remaining -= take;
        }
      }
      setStage(player, STAGE_MARKET);
    }
  }

  // ==========================================================================
  // Transcript choice handler
  // ==========================================================================

  function handleChoice(event) {
    const { player, option } = event;
    if (!player) return;
    const npcId = contentNpcId(event);

    if (BRUNDT_NPC_IDS.has(npcId)) {
      if (startMenu.has(player)) {
        if (option === "Yes." || option === "No.") {
          startMenu.delete(player);
          if (option === "Yes.") {
            if (!meetsRequirements(player)) {
              player.sendMessage("You don't meet the requirements for this quest.");
            } else if (quest.getStage(player) === 0) {
              setStage(player, STAGE_STARTED);
            }
          }
        }
        return;
      }
      if (option === "Where can I find a Fremennik Shield?") {
        player.setAttribute(SHIELD_INFO_ATTRIBUTE, 1);
        player.getPacketSender().sendVarbit(VARBIT_SHIELD_INFO, 1);
        return;
      }
      if (option === "Where can I get Lunar Glass?") {
        player.setAttribute(GLASS_INFO_ATTRIBUTE, Math.max(1, Number(player.getAttribute(GLASS_INFO_ATTRIBUTE)) || 0));
        player.getPacketSender().sendVarbit(VARBIT_GLASS_INFO, Number(player.getAttribute(GLASS_INFO_ATTRIBUTE)) || 1);
        return;
      }
      if (option === "How do I make the Polishing Rock?") {
        player.setAttribute(ROCK_INFO_ATTRIBUTE, Math.max(1, Number(player.getAttribute(ROCK_INFO_ATTRIBUTE)) || 0));
        player.getPacketSender().sendVarbit(VARBIT_ROCK_INFO, Number(player.getAttribute(ROCK_INFO_ATTRIBUTE)) || 1);
        return;
      }
      if (option === "How do I make V's Sigil?") {
        player.setAttribute(SIGIL_INFO_ATTRIBUTE, 1);
        player.getPacketSender().sendVarbit(VARBIT_SIGIL_INFO, 1);
        return;
      }
      return;
    }

    if (npcId === FREYGERD) {
      if (option === "Terrify her with all the details.") {
        player.setAttribute(FREYGERD_TOLD_ATTRIBUTE, 2);
        player.getPacketSender().sendVarbit(VARBIT_FREYGERD_TOLD, 2);
        return;
      }
      if (option === "Spare her the truth.") {
        player.setAttribute(FREYGERD_TOLD_ATTRIBUTE, Math.max(1, freygerdTold(player)));
        player.getPacketSender().sendVarbit(VARBIT_FREYGERD_TOLD, freygerdTold(player));
        return;
      }
    }

    if ((npcId === JARVALD || npcId === JARVALD_2 || npcId === JARVALD_3)) {
      if (npcId === JARVALD && option === "Please Jarvald, it's really important!") {
        player.moveTo(WATERBIRTH_LANDING);
        return;
      }
      if (npcId !== JARVALD && option === "Yes please.") {
        player.moveTo(RELLEKKA_JARVALD_PIER);
        return;
      }
    }

    if (SAILOR_NPC_IDS.has(npcId)) {
      if (npcId === SAILOR_2 && option === "Please, I must get to Miscellania.") {
        player.moveTo(new Location(2581, 3847, 0));
        return;
      }
      if (npcId === SAILOR && option === "Let's go!") {
        player.moveTo(RELLEKKA_JARVALD_PIER);
        return;
      }
    }

    if (HASKELL_NPC_IDS.has(npcId) && option === "Yes please.") {
      if (npcId === NpcIdentifiers.HASKELL_3) {
        player.moveTo(RELLEKKA_PORT);
      } else {
        player.moveTo(ISLAND_LANDING);
      }
      return;
    }
  }

  // ==========================================================================
  // Transcript line handler
  // ==========================================================================

  function handleLine(event) {
    const { player, npcId } = event;
    if (!player || typeof event.text !== "string") return;
    const text = event.text;
    if (!DIALOGUE_NPC_IDS.has(npcId)) return;

    if (text.includes("[Fremennik name]")) {
      event.text = text.split("[Fremennik name]").join(player.getUsername?.() ?? "");
    }
    const gendered = [
      ["[He/She]", "He", "She"],
      ["[he/she]", "he", "she"],
      ["[him/her]", "him", "her"],
      ["[his/her]", "his", "her"],
    ];
    if (event.text.includes("[")) {
      const male = player.getAppearance?.()?.isMale?.() !== false;
      for (const [token, maleText, femaleText] of gendered) {
        if (event.text.includes(token)) {
          event.text = event.text.split(token).join(male ? maleText : femaleText);
        }
      }
    }

    if (npcId === FOSSEGRIMEN && text.startsWith("There you go! Go forth mighty warrior.")) {
      if (takeItem(player, V_SIGIL_ITEM)) {
        addItem(player, V_SIGIL_E_ITEM);
        player.setAttribute(SIGIL_INFO_ATTRIBUTE, 2);
        player.getPacketSender().sendVarbit(VARBIT_SIGIL_INFO, 2);
      }
      return;
    }

    if (PEER_NPC_IDS.has(npcId) && text.startsWith("Now be gone with you, exile!")) {
      player.setAttribute(PEER_FORGOT_ATTRIBUTE, true);
      player.setAttribute(ROCK_INFO_ATTRIBUTE, 2);
      player.getPacketSender().sendVarbit(VARBIT_ROCK_INFO, 2);
      return;
    }

    if (BRUNDT_NPC_IDS.has(npcId) && text.startsWith("Leave at once. Do not attempt")) {
      if (stageOf(player) < STAGE_EXILED) setStage(player, STAGE_EXILED);
      return;
    }

    // RoyalTrouble's line handler substitutes "[Fremennik name]" before this runs.
    if (BRUNDT_NPC_IDS.has(npcId) && text.includes("Get to the boat")) {
      if (stageOf(player) === STAGE_MARKET_DONE) setStage(player, STAGE_BOAT);
      return;
    }

    if (npcId === BRUNDT_ISLAND_PRISON && stageOf(player) >= STAGE_JORMUNGAND_DEAD && text.startsWith("You worry too much")) {
      handleJormungandFinish(player);
      return;
    }

    // The celebration ends on the player's "Uh oh..." line, spoken with Brundt's
    // npc id (the transcript's Olaf lines belong to the cutscene).
    if (stageOf(player) >= STAGE_CELEBRATION && text.startsWith("Uh oh")) {
      if (!quest.isComplete(player)) quest.complete(player);
      return;
    }
  }

  // ==========================================================================
  // Object interactions
  // ==========================================================================

  function handleObjectInteraction(event) {
    const { player } = event;
    if (!player) return;
    const objectId = resolvedObjectId(event);
    const rawId = event.objectId;

    if (SAND_PIT_IDS.has(objectId) || rawId === SAND_PIT_PARENT) {
      event.handled = true;
      searchSandPit(player);
      return;
    }
    if (ROCKSLIDE_IDS.has(objectId) || rawId === ROCKSLIDE_PARENT) {
      event.handled = true;
      searchRockslide(player);
      return;
    }
    if (BOXES_IDS.has(objectId) || rawId === BOXES_PARENT) {
      event.handled = true;
      searchBoxes(player);
      return;
    }
    if (SMALL_GEYSER_IDS.has(objectId) || rawId === SMALL_GEYSER_PARENT) {
      event.handled = true;
      inspectSmallGeyser(player);
      return;
    }
    if (LARGE_GEYSER_IDS.has(objectId) || rawId === LARGE_GEYSER_PARENT) {
      event.handled = true;
      inspectLargeGeyser(player);
      return;
    }
    if (FREMENNIK_BOAT_IDS.has(objectId) || rawId === FREMENNIK_BOAT_PARENT) {
      event.handled = true;
      travelFremennikBoat(player, objectId);
      return;
    }
    if (CAVE_IDS.has(objectId) || rawId === CAVE_PARENT) {
      event.handled = true;
      enterIslandCave(player);
      return;
    }
    if (WATERBIRTH_DUNGEON_IDS.has(objectId)) {
      if (isExiled(player) && stageOf(player) >= STAGE_COMPONENTS) {
        event.handled = true;
        enterWaterbirthDungeon(player);
      }
      return;
    }
    if (objectId === STRANGE_ALTAR || rawId === STRANGE_ALTAR) {
      if (isExiled(player) && stageOf(player) >= STAGE_COMPONENTS) {
        event.handled = true;
        summonFossegrimen(player);
      }
    }
  }

  function inInvestigationStage(player) {
    const stage = stageOf(player);
    return stage >= STAGE_STARTED && stage < STAGE_EXILED;
  }

  function searchSandPit(player) {
    if (!inInvestigationStage(player)) return;
    if (younglingKilled(player) && !sandSearched(player)) {
      player.setAttribute(SAND_SEARCHED_ATTRIBUTE, true);
      startTranscript(api, player, FREYGERD, PAGE, "investigating-the-disturbance-searching-outside-the-house-sand-pit-after-killing-the-basilisk-youngling");
      return;
    }
    if (younglingKilled(player)) {
      startTranscript(api, player, FREYGERD, PAGE, "investigating-the-disturbance-searching-outside-the-house-sand-pit-search-the-sandpit-again-after-killing-the-basilisk-youngling");
      return;
    }
    startTranscript(api, player, FREYGERD, PAGE, "investigating-the-disturbance-searching-outside-the-house-sand-pit");
  }

  function searchRockslide(player) {
    if (!inInvestigationStage(player)) return;
    const variant = hasItem(player, FANG_ITEM)
      ? "investigating-the-disturbance-searching-outside-the-house-rockslide-inspecting-the-fang"
      : "investigating-the-disturbance-searching-outside-the-house-rockslide";
    startTranscript(api, player, FREYGERD, PAGE, variant);
  }

  function searchBoxes(player) {
    if (!inInvestigationStage(player)) return;
    const variant = hasItem(player, VENOM_GLAND_ITEM)
      ? "investigating-the-disturbance-searching-outside-the-house-box-inspecting-the-gland"
      : "investigating-the-disturbance-searching-outside-the-house-box";
    startTranscript(api, player, FREYGERD, PAGE, variant);
  }

  function inspectSmallGeyser(player) {
    const stage = stageOf(player);
    if (stage < STAGE_COMPONENTS || stage >= STAGE_MARKET) return;
    startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-small-geyser");
  }

  function inspectLargeGeyser(player) {
    const stage = stageOf(player);
    if (stage < STAGE_COMPONENTS || stage >= STAGE_MARKET) return;
    if (hasPolishingRockAnywhere(player)) {
      startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-inspecting-either-geyser-with-a-polishing-rock-in-the-player-s-inventory-or-bank");
      return;
    }
    if (rockGone(player)) {
      if (hasFishingRod(player)) {
        startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-large-geyser-after-the-player-has-forgotten-their-memories-with-their-pet-rock-with-a-fishing-rod");
      } else if (hasPetRock(player)) {
        startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-large-geyser-after-the-player-has-forgotten-their-memories-with-their-pet-rock-without-a-fishing-rod-inspecting-again-with-another-pet-rock");
      } else {
        startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-large-geyser-after-the-player-has-forgotten-their-memories-with-their-pet-rock-without-a-fishing-rod-inspecting-again");
      }
      return;
    }
    if (!hasPetRock(player)) {
      startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-large-geyser");
      return;
    }
    if (!peerForgot(player)) {
      if (!rockAttempted(player)) {
        player.setAttribute(ROCK_ATTEMPTED_ATTRIBUTE, true);
        startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-large-geyser");
      } else {
        startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-large-geyser-when-tried-again");
      }
      return;
    }
    if (hasFishingRod(player)) {
      startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-large-geyser-after-the-player-has-forgotten-their-memories-with-their-pet-rock-with-a-fishing-rod");
      return;
    }
    startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-polishing-rock-large-geyser-after-the-player-has-forgotten-their-memories-with-their-pet-rock-without-a-fishing-rod");
  }

  function travelFremennikBoat(player, objectId) {
    const stage = stageOf(player);
    if (stage < STAGE_BOAT) return;
    if (objectId === ObjectIdentifiers.FREMENNIK_BOAT_8) {
      player.moveTo(RELLEKKA_PORT);
      return;
    }
    if (stage < STAGE_ISLAND) setStage(player, STAGE_ISLAND);
    player.moveTo(ISLAND_LANDING);
  }

  function enterIslandCave(player) {
    const stage = stageOf(player);
    if (stage < STAGE_ISLAND || stage >= STAGE_JORMUNGAND_DEAD) return;
    if (!puzzleOpen(player) && stage < STAGE_DOOR_OPEN) {
      startDoorPuzzle(player);
      return;
    }
    enterPrison(player);
  }

  function enterPrison(player) {
    if (stageOf(player) < STAGE_PRISON) setStage(player, STAGE_PRISON);
    player.moveTo(PRISON_ENTRY);
    if (!typhorDead(player)) {
      ensurePrisonScene(player);
    } else if (!jormungandDead(player)) {
      ensureJormungand(player);
    }
    playScene(player, BRUNDT_ISLAND_PRISON, "island-of-stone-brundt-again-after-unlocking-the-door-going-into-jormungand-s-prison");
  }

  function enterWaterbirthDungeon(player) {
    if (!isExiled(player) || stageOf(player) < STAGE_COMPONENTS) return;
    player.moveTo(BARDUR_LANDING);
    player.sendMessage("You climb down into the Waterbirth Island Dungeon and find Bardur's chamber.");
  }

  function summonFossegrimen(player) {
    if (!isExiled(player) || stageOf(player) < STAGE_COMPONENTS) return;
    if (!hasItem(player, V_SIGIL_ITEM) && !hasItem(player, V_SIGIL_E_ITEM)) return;
    startTranscript(api, player, FOSSEGRIMEN, PAGE, "making-v-s-shield-v-sigil-fossegrimen");
  }

  // ==========================================================================
  // Door combination puzzle (interface 622 is not drivable from a plugin)
  // ==========================================================================

  function startDoorPuzzle(player) {
    if (!player.getAttribute(PUZZLE_SOLUTION_ATTRIBUTE)) {
      newPuzzle(player);
    }
    player.sendMessage("The door bears a combination lock: four slots, six rune symbols.");
    choosePuzzleRune(player, 0);
  }

  function newPuzzle(player) {
    const solution = [];
    for (let i = 0; i < PUZZLE_SLOTS; i++) solution.push(Math.floor(Math.random() * RUNE_NAMES.length));
    player.setAttribute(PUZZLE_SOLUTION_ATTRIBUTE, solution.join(","));
    player.setAttribute(PUZZLE_ATTEMPTS_ATTRIBUTE, 0);
    player.setAttribute(PUZZLE_GUESS_ATTRIBUTE, "");
  }

  function puzzleSolution(player) {
    const raw = String(player.getAttribute(PUZZLE_SOLUTION_ATTRIBUTE) ?? "");
    const parts = raw.split(",").map((value) => Number(value));
    return parts.length === PUZZLE_SLOTS && parts.every((value) => Number.isInteger(value)) ? parts : null;
  }

  function choosePuzzleRune(player, slot, offset = 0) {
    const options = [];
    const end = Math.min(offset + 4, RUNE_NAMES.length);
    for (let index = offset; index < end; index++) {
      options.push(RUNE_NAMES[index], () => setPuzzleRune(player, slot, index));
    }
    if (end < RUNE_NAMES.length) {
      options.push("More...", () => choosePuzzleRune(player, slot, end));
    } else if (offset > 0) {
      options.push("Back...", () => choosePuzzleRune(player, slot, 0));
    }
    if (options.length < 8) options.push("Cancel", () => {});
    api.sendMultiChatboxPrompt(player, `Combination lock - slot ${slot + 1} of ${PUZZLE_SLOTS}`, ...options);
  }

  function setPuzzleRune(player, slot, runeIndex) {
    const guess = String(player.getAttribute(PUZZLE_GUESS_ATTRIBUTE) ?? "").split(",").filter(Boolean);
    const next = guess.slice(0, Math.min(slot, PUZZLE_SLOTS - 1));
    next[slot] = String(runeIndex);
    player.setAttribute(PUZZLE_GUESS_ATTRIBUTE, next.join(","));
    if (slot < PUZZLE_SLOTS - 1) {
      choosePuzzleRune(player, slot + 1);
      return;
    }
    evaluatePuzzle(player);
  }

  function evaluatePuzzle(player) {
    const solution = puzzleSolution(player);
    const rawGuess = String(player.getAttribute(PUZZLE_GUESS_ATTRIBUTE) ?? "").split(",").filter(Boolean);
    if (!solution || rawGuess.length < PUZZLE_SLOTS) return;
    const guess = rawGuess.slice(0, PUZZLE_SLOTS).map((value) => Number(value));
    player.setAttribute(PUZZLE_GUESS_ATTRIBUTE, "");

    let exact = 0;
    const remainingSolution = [];
    const remainingGuess = [];
    for (let i = 0; i < PUZZLE_SLOTS; i++) {
      if (guess[i] === solution[i]) {
        exact++;
      } else {
        remainingSolution.push(solution[i]);
        remainingGuess.push(guess[i]);
      }
    }
    let misplaced = 0;
    for (const rune of remainingGuess) {
      const at = remainingSolution.indexOf(rune);
      if (at !== -1) {
        misplaced++;
        remainingSolution.splice(at, 1);
      }
    }
    if (exact === PUZZLE_SLOTS) {
      player.setAttribute(PUZZLE_OPEN_ATTRIBUTE, true);
      setStage(player, STAGE_DOOR_OPEN);
      player.sendMessage("The runes lock into place and the door grinds open.");
      return;
    }
    player.sendMessage(`The lock rejects the combination: ${exact} correct, ${misplaced} rune${misplaced === 1 ? "" : "s"} in the wrong slot.`);
    const attempts = (Number(player.getAttribute(PUZZLE_ATTEMPTS_ATTRIBUTE)) || 0) + 1;
    if (attempts > PUZZLE_MAX_ATTEMPTS) {
      newPuzzle(player);
      player.sendMessage("The lock resets and the runes shuffle into a new combination.");
      return;
    }
    player.setAttribute(PUZZLE_ATTEMPTS_ATTRIBUTE, attempts);
    choosePuzzleRune(player, 0);
  }

  // ==========================================================================
  // Item interactions
  // ==========================================================================

  function readLetter(event) {
    const { player } = event;
    if (letterRead(player)) {
      player.sendMessage("You have already read the letter.");
      return false;
    }
    player.setAttribute(LETTER_READ_ATTRIBUTE, true);
    player.getPacketSender().sendVarbit(VARBIT_LETTER_READ, 1);
    player.sendMessage("You read the unsealed letter.");
    player.sendMessage("For years we have waited and at last, our time to rise has come. Soon, we will bring terror to the Fremennik Province.");
    player.sendMessage("Go forth brothers and sisters. Go forth and wreak havoc amongst their people. Once they are distracted, we will tear down the walls that hold our king.");
    player.sendMessage("We will finally free the Jormungand! The time is ours. They will be unprepared. Their ban on magic shall be their downfall.");
    player.sendMessage("They have no champion to defend them this time. No V.");
    player.sendMessage("- Bakuna");
    return true;
  }

  function interactPetRock(event) {
    const { player } = event;
    if (!isExiled(player)) return false;
    startTranscript(api, player, ASKELADDEN, PAGE, "being-exiled-pet-rock");
    return true;
  }

  function handleItemOnObject(event) {
    const { player, itemId } = event;
    if (!player) return;
    const objectId = resolvedObjectId(event);

    if (itemId === PET_ROCK_ITEM && (LARGE_GEYSER_IDS.has(objectId) || event.objectId === LARGE_GEYSER_PARENT)) {
      event.handled = true;
      inspectLargeGeyser(player);
      return;
    }
    if (itemId === MOLTEN_GLASS_I_ITEM && objectId === ASTRAL_ALTAR) {
      if (stageOf(player) < STAGE_COMPONENTS || stageOf(player) >= STAGE_MARKET) return;
      event.handled = true;
      startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-lunar-glass-enchanting-the-molten-glass-i");
      return;
    }
    if (itemId === LUNAR_BAR_ITEM && ANVIL_IDS.has(objectId)) {
      if (stageOf(player) < STAGE_COMPONENTS || stageOf(player) >= STAGE_MARKET) return;
      event.handled = true;
      startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-v-sigil-anvil");
      return;
    }
    if (itemId === LUNAR_ORE_ITEM && FURNACE_IDS.has(objectId)) {
      if (stageOf(player) < STAGE_COMPONENTS || stageOf(player) >= STAGE_MARKET) return;
      event.handled = true;
      smeltLunarOre(player);
      return;
    }
  }

  function smeltLunarOre(player) {
    if (player.getSkillManager().getMaxLevel(Skill.SMITHING) < 60) {
      player.sendMessage("You need a Smithing level of 60 to smelt lunar ore.");
      return;
    }
    if (!takeItem(player, LUNAR_ORE_ITEM)) return;
    addItem(player, LUNAR_BAR_ITEM);
    player.getSkillManager().addExperiences(Skill.SMITHING, 13);
    player.sendMessage("You smelt the lunar ore into a lunar bar.");
  }

  function handleItemOnItem(event) {
    const { player } = event;
    if (!player) return;
    const pair = new Set([event.usedItemId, event.usedWithItemId]);
    const hasSigil = pair.has(V_SIGIL_E_ITEM) || pair.has(V_SIGIL_ITEM);
    const hasShield = [...FREMENNIK_SHIELD_ITEMS].some((id) => pair.has(id));
    if (!hasSigil || !hasShield) return;
    if (!hasItem(player, LUNAR_GLASS_ITEM) || !hasItem(player, POLISHING_ROCK_ITEM)) {
      player.sendMessage("You need the lunar glass and the polishing rock as well.");
      return;
    }
    if (!hasItem(player, V_SIGIL_E_ITEM)) {
      player.sendMessage("The V sigil must be enchanted first.");
      return;
    }
    event.handled = true;
    startTranscript(api, player, BABA_YAGA, PAGE, "making-v-s-shield-making-the-shield-using-the-items-on-each-other");
  }

  // ==========================================================================
  // NPC deaths
  // ==========================================================================

  function handleNpcDeath(event) {
    const player = event?.killer?.isPlayer?.() ? event.killer : null;
    if (!player) return;
    const npcId = event.npcId;

    if (npcId === BASILISK_YOUNGLING) {
      if (!inInvestigationStage(player)) return;
      player.setAttribute(YOUNGLING_KILLED_ATTRIBUTE, true);
      player.getPacketSender().sendVarbit(VARBIT_YOUNGLING_KILLED, 1);
      // The youngling's drop table already always drops the unsealed letter.
      syncTracked(player, "youngling", null);
      return;
    }

    if (MARKET_BASILISK_IDS.has(npcId) || MARKET_MONSTROUS_IDS.has(npcId)) {
      const stage = stageOf(player);
      if (stage < STAGE_MARKET || stage >= STAGE_MARKET_DONE) return;
      const points = MARKET_MONSTROUS_IDS.has(npcId) ? MONSTROUS_POINTS : BASILISK_POINTS;
      const total = setKillPercent(player, killPercent(player) + points);
      if (total >= BASILISK_TARGET) {
        clearMarketNpcs(player);
        setStage(player, STAGE_MARKET_DONE);
        player.sendMessage("You have held back the basilisk invasion. Brundt waves you towards the boat.");
      } else if (!marketWaveAlive(player)) {
        spawnMarketWave(player);
      }
      return;
    }

    if (TYPHOR_NPC_IDS.has(npcId)) {
      if (stageOf(player) < STAGE_PRISON) return;
      player.setAttribute(TYPHOR_DEAD_ATTRIBUTE, true);
      ensureJormungand(player);
      playScene(player, THE_JORMUNGAND, "island-of-stone-the-jormungand");
      return;
    }

    if (JORMUNGAND_NPC_IDS.has(npcId)) {
      if (stageOf(player) < STAGE_PRISON) return;
      player.setAttribute(JORMUNGAND_DEAD_ATTRIBUTE, true);
      syncTracked(player, "jormungand", null);
      setStage(player, STAGE_JORMUNGAND_DEAD);
      startTranscript(api, player, BRUNDT_ISLAND_PRISON, PAGE, "island-of-stone-after-killing-the-jormungand");
      return;
    }
  }

  function handleJormungandFinish(player) {
    setStage(player, STAGE_CELEBRATION);
    player.moveTo(LONGHALL_LANDING);
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function buildJournal(player, handle) {
    const stage = handle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I investigated the disturbance, was exiled and remade V's Shield.</str>",
        "<str>I fought beside Brundt at the market and on the Island of Stone,</str>",
        "<str>where I defeated Typhor and the Jormungand.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_CELEBRATION) {
      return [
        "<str>The Jormungand is defeated and the End of Things averted.</str>",
        "I should celebrate with <col=800000>Brundt</col> in the Rellekka longhall.",
      ];
    }
    if (stage >= STAGE_JORMUNGAND_DEAD) {
      return [
        "<str>The Jormungand has been defeated in his prison.</str>",
        "I should speak to <col=800000>Brundt</col> and return to Rellekka.",
      ];
    }
    if (stage >= STAGE_PRISON) {
      return [
        "<str>I entered Jormungand's Prison with Brundt.</str>",
        "Defeat <col=800000>Typhor</col> and then <col=800000>the Jormungand</col>.",
      ];
    }
    if (stage >= STAGE_DOOR_OPEN) {
      return [
        "<str>I solved the door's combination lock.</str>",
        "Enter the <col=800000>cave</col> and stop the basilisks.",
      ];
    }
    if (stage >= STAGE_ISLAND) {
      return [
        "<str>I reached the Island of Stone with Brundt.</str>",
        "Solve the <col=800000>combination lock</col> on the cave door.",
      ];
    }
    if (stage >= STAGE_BOAT) {
      return [
        "<str>The basilisk invasion is broken; the council trusts me again.</str>",
        "Board the <col=800000>Fremennik boat</col> at the Rellekka dock and sail",
        "to the Island of Stone.",
      ];
    }
    if (stage === STAGE_MARKET_DONE) {
      return [
        "<str>I survived the basilisk invasion of the market.</str>",
        "Speak to <col=800000>Brundt</col> in the longhall.",
      ];
    }
    if (stage >= STAGE_MARKET) {
      return [
        "<str>The basilisks are invading Rellekka's market.</str>",
        "Wield <col=800000>V's shield</col> and fight beside Brundt until the",
        "invasion is broken.",
      ];
    }
    if (stage >= STAGE_SHIELD_GIVEN) {
      return [
        "<str>Brundt has V's Shield; he needs two kegs of beer for courage.</str>",
        "Bring him two <col=800000>kegs of beer</col>.",
      ];
    }
    if (stage >= STAGE_SHIELD_MADE) {
      return [
        "<str>I remade V's Shield from its four components.</str>",
        "Give it to <col=800000>Brundt</col> south-east of Rellekka.",
      ];
    }
    if (stage >= STAGE_COMPONENTS) {
      return [
        "<str>I must remake V's Shield to win back the council's trust.</str>",
        "Gather a <col=800000>Fremennik shield</col> (Bardur, Waterbirth Dungeon),",
        "<col=800000>lunar glass</col> (Baba Yaga, astral altar), a",
        "<col=800000>polishing rock</col> (Peer the Seer, Mountain Camp geyser)",
        "and an enchanted <col=800000>V sigil</col> (anvil, Fossegrimen).",
      ];
    }
    if (stage >= STAGE_EXILED) {
      return [
        "<str>I have been exiled from the Fremennik Province.</str>",
        "Meet <col=800000>Brundt</col> south-east of Rellekka.",
      ];
    }
    if (stage >= STAGE_REPORTED) {
      return [
        "<str>Freygerd sent the evidence ahead to Brundt.</str>",
        "Report to the <col=800000>Chieftain</col> in the longhall.",
      ];
    }
    if (stage >= STAGE_INVESTIGATING) {
      if (younglingKilled(player)) {
        return [
          "<str>I killed the basilisk youngling and found its letter.</str>",
          "Read the <col=800000>unsealed letter</col>, then take the evidence to",
          "<col=800000>Freygerd</col>.",
        ];
      }
      return [
        "<str>Something was seen outside Freygerd and Reeso's house.</str>",
        "Search the <col=800000>boxes</col>, the <col=800000>rockslide</col> and the",
        "<col=800000>sand pit</col> for clues.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "<str>Brundt asked me to look into a disturbance by the sand pit.</str>",
        "Speak to <col=800000>Freygerd</col> north of Rellekka.",
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Brundt the Chieftain</col>",
      "in the Rellekka longhall.",
    ];
  }

  function grantReward(player) {
    const skills = player.getSkillManager();
    skills.addExperiences(Skill.SLAYER, 50000);
    skills.addExperiences(Skill.CRAFTING, 50000);
    skills.addExperiences(Skill.RUNECRAFTING, 30000);
    if (!hasAnyItemAnywhere(player, VS_SHIELD_ITEMS)) addItem(player, VS_SHIELD_ITEM);
    player.getPacketSender().sendVarbit(VARBIT_BALLAD, 1);
    player.getPacketSender().sendVarbit(VARBIT_HELM_UNLOCK, 1);
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  api.persistAttribute(LETTER_READ_ATTRIBUTE);
  api.persistAttribute(FREYGERD_TOLD_ATTRIBUTE);
  api.persistAttribute(YOUNGLING_FOUND_ATTRIBUTE);
  api.persistAttribute(YOUNGLING_KILLED_ATTRIBUTE);
  api.persistAttribute(SAND_SEARCHED_ATTRIBUTE);
  api.persistAttribute(SHIELD_INFO_ATTRIBUTE);
  api.persistAttribute(GLASS_INFO_ATTRIBUTE);
  api.persistAttribute(ROCK_INFO_ATTRIBUTE);
  api.persistAttribute(SIGIL_INFO_ATTRIBUTE);
  api.persistAttribute(BARDUR_GOT_ATTRIBUTE);
  api.persistAttribute(ROCK_ATTEMPTED_ATTRIBUTE);
  api.persistAttribute(PEER_FORGOT_ATTRIBUTE);
  api.persistAttribute(ROCK_GONE_ATTRIBUTE);
  api.persistAttribute(SHIELD_GIVEN_ATTRIBUTE);
  api.persistAttribute(BASILISK_KILLS_ATTRIBUTE);
  api.persistAttribute(MARKET_STARTED_ATTRIBUTE);
  api.persistAttribute(TYPHOR_DEAD_ATTRIBUTE);
  api.persistAttribute(JORMUNGAND_DEAD_ATTRIBUTE);
  api.persistAttribute(PUZZLE_OPEN_ATTRIBUTE);
  api.persistAttribute(PUZZLE_SOLUTION_ATTRIBUTE);
  api.persistAttribute(PUZZLE_ATTEMPTS_ATTRIBUTE);
  api.persistAttribute(PUZZLE_GUESS_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "the_fremennik_exiles",
    name: "The Fremennik Exiles",
    varpId: VARP_FREMENNIK_EXILES,
    varbitId: VARBIT_STAGE,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [
      { skillId: Skill.SLAYER.getIndex(), amount: 50000, label: "Slayer" },
      { skillId: Skill.CRAFTING.getIndex(), amount: 50000, label: "Crafting" },
      { skillId: Skill.RUNECRAFTING.getIndex(), amount: 30000, label: "Runecraft" },
    ],
    scrollItemId: VS_SHIELD_ITEM,
    rewardItemLabel: "V's shield",
    otherRewards: [
      "Access to the Island of Stone",
      "Basilisk Knights as a Slayer task",
    ],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcInteraction("Brundt the Chieftain", { "Talk-to": talksToMyQuest });
  api.onNpcInteraction("Baba Yaga", { "Talk-to": talksToMyQuest });
  api.onNpcInteraction("Peer the Seer", { "Talk-to": talksToMyQuest });
  api.onNpcInteraction("Askeladden", { "Talk-to": talksToMyQuest });
  api.onNpcInteraction("Sailor", { "Talk-to": talksToMyQuest });
  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:line", handleLine);
  api.onObjectInteraction(handleObjectInteraction);
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onItemOnItem(handleItemOnItem);
  api.onItemAction("Unsealed letter", { Read: readLetter });
  api.onItemAction("Pet rock", { Interact: interactPetRock });
  api.onNpcDeath(handleNpcDeath);
  api.onPlayerLogin(handleLogin);
  api.onCustomEvent("player:bootstrap-complete", handleBootstrap);
  api.onCustomEvent("quest:stage-changed", handleStageChanged);
};
