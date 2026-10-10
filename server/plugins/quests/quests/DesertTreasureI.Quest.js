/**
 * Desert Treasure I (members).
 *
 * The words come from the "Desert Treasure I" transcript page. This plugin
 * supplies the variant selector for Asgarnia Smith, Terry Balando, the Bedabin
 * bartender, Eblis, Rasolo, Malak, Ruantun, the High Priest, the Troll child and
 * Azzanadra; the start hook; the prose-condition answers; the etchings /
 * translation hand-ins; the Eblis mirror materials; the garlic powder; the
 * shadow-diamond gilded cross trade; the bandit chest; the boss-diamond drops;
 * and the Azzanadra completion action.
 *
 * Stages (varp 440): 1 started, 2 translation received, 3 translation delivered,
 * 4 agreed to hunt, 6 learned of the bandits, 7 asked about the diamonds,
 * 8 Eblis found, 9 materials needed, 10/11 mirrors set up, 13 diamonds placed,
 * 15 complete.
 *
 * World wiring this plugin owns (map objects from the cache landscape):
 *  - Smoke Dungeon: Smokey well (climb-down), four standing torches (light with
 *    a tinderbox), burnt chest (warm key), east gate (warm key) and Fareed.
 *  - Ice Path: Troll child (sweet food), ice gate (squeeze through), ice ledge
 *    (spiked boots) and the frozen troll parents (smash the ice blocks).
 *  - Shadow Dungeon: Rasolo's gilded cross / ring of visibility trade and the
 *    ladder once the ring is worn.
 *  - Blood diamond: Malak's pot, Ruantun, the Entrana High Priest and Dessous's
 *    tomb in the Morytania graveyard.
 *  - Ancient Pyramid: the four obelisks, the entrance and Azzanadra.
 *
 * Gaps: the six prerequisite quests are enforced only through the registered
 * quest handles (their varps are not readable); the cold/smoke stat drain, the
 * torch burn-out timer and the pyramid's traps are not modelled.
 */
module.exports = function registerDesertTreasureIQuest(api) {
  const {
    Skill, Equipment, Location, GameObject,
    ItemIdentifiers, NpcIdentifiers, ObjectIdentifiers,
    ObjectManager, MapObjects, RegionManager,
  } = api.core;
  const { registerQuest, refreshQuestList, getRegisteredQuests } = require("../QuestRuntime");

  const ASGARNIA_IDS = new Set([
    NpcIdentifiers.ASGARNIA_SMITH,
    NpcIdentifiers.ASGARNIA_SMITH_2,
    NpcIdentifiers.ASGARNIA_SMITH_3,
    684, // the Bedabin Camp spawn
  ]);
  const TERRY_NPC_ID = NpcIdentifiers.TERRY_BALANDO;
  const BARTENDER_NPC_ID = NpcIdentifiers.BARTENDER;
  const EBLIS_IDS = new Set([NpcIdentifiers.EBLIS, NpcIdentifiers.EBLIS_2, 1966, 1967]);
  const RASOLO_NPC_ID = NpcIdentifiers.RASOLO;
  const MALAK_NPC_ID = NpcIdentifiers.MALAK;
  const RUANTUN_NPC_ID = NpcIdentifiers.RUANTUN;
  const HIGH_PRIEST_IDS = new Set([NpcIdentifiers.HIGH_PRIEST, NpcIdentifiers.HIGH_PRIEST_3]);
  const TROLL_CHILD_IDS = new Set([NpcIdentifiers.TROLL_CHILD, NpcIdentifiers.TROLL_CHILD_2, 1968]);
  const TROLL_FATHER_ID = NpcIdentifiers.TROLL_FATHER;
  const TROLL_MOTHER_ID = NpcIdentifiers.TROLL_MOTHER;
  const AZZANADRA_IDS = new Set([
    NpcIdentifiers.AZZANADRA,
    NpcIdentifiers.AZZANADRA_2,
    NpcIdentifiers.AZZANADRA_3,
    NpcIdentifiers.AZZANADRA_4,
    NpcIdentifiers.AZZANADRA_5,
    1973,
  ]);

  /** NPCs whose transcripts this plugin owns; dialogue conditions from anyone else are not ours. */
  const DIALOGUE_NPC_IDS = new Set([
    ...ASGARNIA_IDS,
    TERRY_NPC_ID,
    BARTENDER_NPC_ID,
    ...EBLIS_IDS,
    RASOLO_NPC_ID,
    MALAK_NPC_ID,
    RUANTUN_NPC_ID,
    ...HIGH_PRIEST_IDS,
    ...TROLL_CHILD_IDS,
    TROLL_FATHER_ID,
    TROLL_MOTHER_ID,
    ...AZZANADRA_IDS,
  ]);

  const DAMIS_FIRST_NPC_ID = NpcIdentifiers.DAMIS;
  const DAMIS_SECOND_NPC_ID = NpcIdentifiers.DAMIS_2;
  const DESSOUS_NPC_ID = NpcIdentifiers.DESSOUS;
  const KAMIL_NPC_ID = NpcIdentifiers.KAMIL;
  const FAREED_NPC_ID = NpcIdentifiers.FAREED;
  const ICE_BLOCK_IDS = new Set([1969, 1970]);
  const ICE_TROLL_IDS = new Set([698, 699, 700, 701, 702, 703, 704, 705]);

  const BANDIT_CHEST_ID = ObjectIdentifiers.SECURE_CHEST;
  const SMOKEY_WELL_ID = ObjectIdentifiers.SMOKEY_WELL;
  const BURNT_CHEST_ID = ObjectIdentifiers.BURNT_CHEST;
  const SMOKE_GATE_IDS = new Set([6451, 6452]);
  const ICE_GATE_IDS = new Set([ObjectIdentifiers.ICE_GATE, ObjectIdentifiers.ICE_GATE_2]);
  const ICE_LEDGE_ID = ObjectIdentifiers.ICE_LEDGE;
  const ICE_LEDGE_TOP_ID = 6456;
  const PYRAMID_ENTRANCE_IDS = new Set([
    ObjectIdentifiers.PYRAMID_ENTRANCE,
    ObjectIdentifiers.PYRAMID_ENTRANCE_2,
  ]);
  const PYRAMID_OBELISK_IDS = new Set([6482, 6485, 6488, 6491]);
  const TORCH_IDS = new Set([6405, 6407, 6409, 6411]);
  const DESSOUS_TOMB_ID = 6437;

  const VARP_DESERT_TREASURE = 440;
  const STAGE_STARTED = 1;
  const STAGE_TRANSLATION_RECEIVED = 2;
  const STAGE_TRANSLATION_DELIVERED = 3;
  const STAGE_AGREED = 4;
  const STAGE_BANDITS = 6;
  const STAGE_ASKED = 7;
  const STAGE_EBLIS_FOUND = 8;
  const STAGE_MATERIALS = 9;
  const STAGE_MIRRORS = 10;
  const STAGE_HUNT = 11;
  const STAGE_PLACED = 13;
  const STAGE_COMPLETE = 15;

  const ETCHINGS = ItemIdentifiers.ETCHINGS;
  const TRANSLATION = ItemIdentifiers.TRANSLATION;
  const RING_OF_VISIBILITY = ItemIdentifiers.RING_OF_VISIBILITY;
  const SILVER_POT = ItemIdentifiers.SILVER_POT_3;
  const BLESSED_POT = ItemIdentifiers.BLESSED_POT_5;
  const BLESSED_POTS = new Set([
    ItemIdentifiers.BLESSED_POT,
    ItemIdentifiers.BLESSED_POT_2,
    ItemIdentifiers.BLESSED_POT_3,
    ItemIdentifiers.BLESSED_POT_4,
    ItemIdentifiers.BLESSED_POT_5,
  ]);
  const GARLIC = ItemIdentifiers.GARLIC;
  const GARLIC_POWDER = ItemIdentifiers.GARLIC_POWDER;
  const SPICE = ItemIdentifiers.SPICE;
  const PESTLE_AND_MORTAR = ItemIdentifiers.PESTLE_AND_MORTAR;
  const BLOOD_DIAMOND = ItemIdentifiers.BLOOD_DIAMOND;
  const ICE_DIAMOND = ItemIdentifiers.ICE_DIAMOND;
  const SMOKE_DIAMOND = ItemIdentifiers.SMOKE_DIAMOND;
  const SHADOW_DIAMOND = ItemIdentifiers.SHADOW_DIAMOND;
  const GILDED_CROSS = ItemIdentifiers.GILDED_CROSS;
  const ANCIENT_STAFF = ItemIdentifiers.ANCIENT_STAFF;
  const BANDITS_BREW = ItemIdentifiers.BANDITS_BREW;
  const WARM_KEY = ItemIdentifiers.WARM_KEY;
  const SILVER_BAR = ItemIdentifiers.SILVER_BAR;
  const COINS = ItemIdentifiers.COINS;
  const LOCKPICK = ItemIdentifiers.LOCKPICK;
  const TINDERBOX = ItemIdentifiers.TINDERBOX;
  const SPIKED_BOOTS = ItemIdentifiers.SPIKED_BOOTS;
  const SWEET_FOODS = new Set([
    ItemIdentifiers.CAKE,
    ItemIdentifiers._2_3_CAKE,
    ItemIdentifiers.SLICE_OF_CAKE,
    ItemIdentifiers.CHOCOLATE_CAKE,
    ItemIdentifiers._2_3_CHOCOLATE_CAKE,
    ItemIdentifiers.CHOCOLATE_SLICE,
    ItemIdentifiers.CHOCOLATE_BAR,
    ItemIdentifiers.COOKING_APPLE,
    ItemIdentifiers.PINEAPPLE_PIZZA,
    ItemIdentifiers._1_2_PINEAPPLE_PIZZA,
  ]);

  const DIAMOND_IDS = [BLOOD_DIAMOND, ICE_DIAMOND, SMOKE_DIAMOND, SHADOW_DIAMOND];
  const EBLIS_SUPPLIES = [
    { itemId: ItemIdentifiers.MAGIC_LOGS, quantity: 12, label: "12 magic logs" },
    { itemId: ItemIdentifiers.STEEL_BAR, quantity: 6, label: "6 steel bars" },
    { itemId: ItemIdentifiers.MOLTEN_GLASS, quantity: 6, label: "6 molten glass" },
    { itemId: ItemIdentifiers.ASHES, quantity: 1, label: "Ashes" },
    { itemId: ItemIdentifiers.CHARCOAL, quantity: 1, label: "Charcoal" },
    { itemId: ItemIdentifiers.BLOOD_RUNE, quantity: 1, label: "A blood rune" },
    { itemId: ItemIdentifiers.BONES, quantity: 1, label: "Bones" },
  ];

  const PREREQUISITE_KEYS = [
    "the_dig_site",
    "temple_of_ikov",
    "the_tourist_trap",
    "troll_stronghold",
    "priest_in_peril",
    "waterfall_quest",
  ];

  const START_HOOK = "quest:desert-treasure-i:start";
  const COMPLETE_ACTION_ID = "y8-TJV";

  // Pieces of world state the single quest varp cannot express.
  const ATTR_MALAK_MET = "desert-treasure-i:malak-met";
  const ATTR_POT_BLOODED = "desert-treasure-i:pot-blooded";
  const ATTR_POT_GARLIC = "desert-treasure-i:pot-garlic";
  const ATTR_POT_SPICE = "desert-treasure-i:pot-spice";
  const ATTR_ICE_SWEET = "desert-treasure-i:ice-sweet";
  const ATTR_ICE_AGREED = "desert-treasure-i:ice-agreed";
  const ATTR_ICE_TROLLS = "desert-treasure-i:ice-trolls";
  const ATTR_ICE_PARENTS = "desert-treasure-i:ice-parents";
  const ATTR_TORCHES = "desert-treasure-i:torches";
  const ATTR_PLACED = "desert-treasure-i:placed";

  // Static quest spawns / landings (checked walkable against the cache map).
  const SHADOW_LADDER_SURFACE = new Location(2547, 3421, 0);
  const SHADOW_LADDER_STAND = new Location(2547, 3420, 0);
  const SHADOW_DUNGEON_LANDING = new Location(2688, 5088, 0);
  const SHADOW_DUNGEON_EXIT = new Location(2705, 5088, 0);
  const SMOKE_DUNGEON_LANDING = new Location(3248, 9356, 0);
  const SMOKE_DUNGEON_EXIT = new Location(3253, 9364, 0);
  const SMOKE_SURFACE = new Location(3310, 2963, 0);
  const FAREED_ARENA = new Location(3310, 9375, 0);
  const ICE_LEDGE_LANDING = new Location(2849, 3809, 2);
  const ICE_LEDGE_BOTTOM = new Location(2838, 3804, 0);
  const PYRAMID_INTERIOR = new Location(3233, 9327, 0);
  const DESSOUS_SPAWN = new Location(3565, 3401, 0);

  /**
   * The cave mouth between the ice-troll room and the ice-wolf path. The cache
   * landscape seals this stretch of wall; killing five ice trolls thaws it open.
   * Verified walkable from the room (2868,3739) into the wolves once cleared.
   */
  const ICE_CAVE_TILES = [];
  for (let x = 2869; x <= 2876; x++) {
    for (let y = 3738; y <= 3741; y++) ICE_CAVE_TILES.push(new Location(x, y, 0));
  }

  const LADDER_OBJECT_ID = ObjectIdentifiers.LADDER_69; // "Ladder", Climb-down
  const LADDER_UP_OBJECT_ID = 16683; // "Ladder", Climb-up

  let quest;

  const has = (player, itemId, amount = 1) => player.getInventory().getAmount(itemId) >= amount;
  const give = (player, itemId, amount = 1) => player.getInventory().adds(itemId, amount);
  const take = (player, itemId, amount = 1) => player.getInventory().deleteNumber(itemId, amount);
  const hasAllSupplies = (player) => EBLIS_SUPPLIES.every((entry) => has(player, entry.itemId, entry.quantity));
  const hasAllDiamonds = (player) => DIAMOND_IDS.every((itemId) => has(player, itemId));
  const magicLevel = (player) => player.getSkillManager().getCurrentLevel(Skill.MAGIC);
  const attr = (player, key) => Number(player.getAttribute(key)) || 0;
  const setAttr = (player, key, value) => player.setAttribute(key, value | 0);
  const wearingRing = (player) =>
    player.getEquipment().get(Equipment.RING_SLOT)?.getId?.() === RING_OF_VISIBILITY;

  function questHandle(key) {
    return getRegisteredQuests().find((entry) => entry.key === key);
  }

  function meetsPrerequisites(player) {
    if (magicLevel(player) < 50) return false;
    return PREREQUISITE_KEYS.every((key) => {
      const other = questHandle(key);
      return !other || other.isComplete(player);
    });
  }

  function digSiteActive(player) {
    const digSite = questHandle("the_dig_site");
    return Boolean(digSite && digSite.isStarted(player) && !digSite.isComplete(player));
  }

  function holyGrailActive(player) {
    const holyGrail = questHandle("holy_grail");
    return Boolean(holyGrail && holyGrail.isStarted(player) && !holyGrail.isComplete(player));
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I freed Azzanadra from the desert pyramid.</str>",
        "<str>I can now use the Ancient Magicks spellbook.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_PLACED) {
      return [
        "I placed the four diamonds in their obelisks.",
        "I must reach <col=800000>Azzanadra</col> at the heart of the pyramid.",
      ];
    }
    if (stage >= STAGE_HUNT) {
      return [
        "I must recover the four Diamonds of Azzanadra:",
        `${has(player, BLOOD_DIAMOND) ? "<str>" : ""}Blood diamond${has(player, BLOOD_DIAMOND) ? "</str>" : ""}`,
        `${has(player, ICE_DIAMOND) ? "<str>" : ""}Ice diamond${has(player, ICE_DIAMOND) ? "</str>" : ""}`,
        `${has(player, SMOKE_DIAMOND) ? "<str>" : ""}Smoke diamond${has(player, SMOKE_DIAMOND) ? "</str>" : ""}`,
        `${has(player, SHADOW_DIAMOND) ? "<str>" : ""}Shadow diamond${has(player, SHADOW_DIAMOND) ? "</str>" : ""}`,
      ];
    }
    if (stage >= STAGE_MIRRORS) {
      return [
        "I gave Eblis the materials for the scrying glasses.",
        "I should meet him at the mirrors in the desert <col=800000>east of the Bandit Camp</col>.",
      ];
    }
    if (stage >= STAGE_MATERIALS) {
      return [
        "Eblis needs materials to make scrying mirrors:",
        ...EBLIS_SUPPLIES.map((entry) => (has(player, entry.itemId, entry.quantity) ? `<str>${entry.label}</str>` : entry.label)),
      ];
    }
    if (stage >= STAGE_EBLIS_FOUND) {
      return ["I found Eblis in the Bandit Camp.", "I should ask him how to locate Azzanadra's diamonds."];
    }
    if (stage >= STAGE_BANDITS) {
      return ["The translation points to the Bandit Camp.", "I should buy a <col=800000>Bandit's brew</col> and question the bartender."];
    }
    if (stage >= STAGE_AGREED) {
      return ["Asgarnia Smith and I agreed to hunt the treasure together.", "I should head to the <col=800000>Bandit Camp</col> south of the Bedabin Camp."];
    }
    if (stage >= STAGE_TRANSLATION_DELIVERED) {
      return ["I showed Asgarnia Smith the translation.", "I should speak to him again about the treasure."];
    }
    if (stage >= STAGE_TRANSLATION_RECEIVED) {
      return ["Terry Balando translated the desert etchings.", "I should show the translation to the <col=800000>Asgarnia Smith</col>."];
    }
    if (stage >= STAGE_STARTED) {
      return ["The Asgarnia Smith found ancient etchings in the desert.", "I should take them to <col=800000>Terry Balando</col> at the Dig Site."];
    }
    return [
      "Speak to the <col=800000>Asgarnia Smith</col> at the Bedabin Camp.",
      "I need 50 <col=800000>Magic</col> and six prerequisite quests.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.MAGIC, 20000);
  }

  // ==========================================================================
  // Variant selection
  // ==========================================================================

  function asgarniaVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return "after-desert-treasure-i";
    if (stage >= STAGE_PLACED) return "the-ancient-pyramid-after-replacing-the-diamonds-before-going-inside-asgarnia-smith";
    if (stage >= STAGE_EBLIS_FOUND) {
      return hasAllDiamonds(player)
        ? "the-ancient-pyramid-talking-to-asgarnia-with-all-the-diamonds"
        : "enchanting-the-mirrors-talking-to-asgarnia-after-learning-about-the-diamonds-of-azzanadra";
    }
    if (stage >= STAGE_AGREED) return "enchanting-the-mirrors-talking-to-asgarnia-after-agreeing-to-hunt-for-treasure";
    if (stage === STAGE_TRANSLATION_DELIVERED) return "enchanting-the-mirrors-talking-to-asgarnia-after-delivering-the-translation";
    if (stage === STAGE_TRANSLATION_RECEIVED) return "enchanting-the-mirrors-talking-to-asgarnia-after-receiving-the-translation";
    if (stage >= STAGE_STARTED) return "enchanting-the-mirrors-talking-to-asgarnia-after-starting-the-quest";
    return meetsPrerequisites(player)
      ? "enchanting-the-mirrors-talking-to-asgarnia-with-the-required-quests"
      : "enchanting-the-mirrors-talking-to-asgarnia-without-the-required-quests";
  }

  function terryVariant(player) {
    const stage = quest.getStage(player);
    // Terry is The Dig Site's expert until it is finished, and Desert Treasure
    // only needs him once its own etchings/translation chain has started.
    if (stage < STAGE_STARTED || digSiteActive(player)) return null;
    if (stage === STAGE_STARTED) {
      if (has(player, ETCHINGS)) return "enchanting-the-mirrors-talking-to-terry";
      return "enchanting-the-mirrors-talking-to-terry-after-delivering-the-etchings";
    }
    if (stage === STAGE_TRANSLATION_RECEIVED) {
      return has(player, TRANSLATION)
        ? "enchanting-the-mirrors-talking-to-terry-after-receiving-the-translation"
        : "enchanting-the-mirrors-talking-to-terry-after-losing-the-translation";
    }
    return "enchanting-the-mirrors-talking-to-terry-after-delivering-his-translation";
  }

  function bartenderVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_AGREED) return null;
    if (stage <= STAGE_BANDITS) {
      if (has(player, BANDITS_BREW)) {
        if (stage < STAGE_BANDITS) quest.setStage(player, STAGE_BANDITS);
        return "enchanting-the-mirrors-talking-to-the-bartender-after-buying-a-drink";
      }
      return "enchanting-the-mirrors-talking-to-the-bartender";
    }
    if (stage <= STAGE_MIRRORS) {
      return "enchanting-the-mirrors-talking-to-the-bartender-after-asking-about-the-diamonds-and-before-talking-to-eblis";
    }
    return "enchanting-the-mirrors-talking-to-the-bartender-after-buying-a-drink";
  }

  function eblisVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return "post-quest-eblis";
    if (stage >= STAGE_PLACED) return "the-ancient-pyramid-after-replacing-the-diamonds-before-going-inside-eblis";
    if (stage >= STAGE_HUNT) {
      if (hasAllDiamonds(player)) return "the-ancient-pyramid-talking-to-eblis-with-four-diamonds";
      const owned = DIAMOND_IDS.filter((itemId) => has(player, itemId)).length;
      if (owned === 1) return "the-ancient-pyramid-talking-to-eblis-with-one-diamond";
      if (owned === 2) return "the-ancient-pyramid-talking-to-eblis-with-two-diamonds";
      if (owned === 3) return "the-ancient-pyramid-talking-to-eblis-with-three-diamonds";
      return "enchanting-the-mirrors-talking-to-eblis-again-after-giving-all-ingredients";
    }
    if (stage === STAGE_MIRRORS) {
      quest.setStage(player, STAGE_HUNT);
      return "enchanting-the-mirrors-talking-to-eblis-at-the-mirrors";
    }
    if (stage === STAGE_MATERIALS) {
      if (hasAllSupplies(player)) {
        for (const entry of EBLIS_SUPPLIES) take(player, entry.itemId, entry.quantity);
        quest.setStage(player, STAGE_MIRRORS);
        return "enchanting-the-mirrors-talking-to-eblis-after-giving-all-ingredients";
      }
      return "enchanting-the-mirrors-talking-to-eblis-after-agreeing-to-get-ingredients";
    }
    if (stage === STAGE_ASKED) {
      quest.setStage(player, STAGE_EBLIS_FOUND);
      return "enchanting-the-mirrors-talking-to-eblis-after-asking-the-bartender-about-the-diamonds";
    }
    if (stage === STAGE_EBLIS_FOUND) {
      return "enchanting-the-mirrors-talking-to-eblis-after-asking-the-bartender-about-the-diamonds";
    }
    if (stage >= STAGE_BANDITS) {
      return "enchanting-the-mirrors-talking-to-eblis-before-asking-the-bartender-about-the-diamonds";
    }
    return null;
  }

  function rasoloVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_HUNT) return null;
    if (has(player, SHADOW_DIAMOND)) return "shadow-diamond-talking-to-rasolo-again";
    if (stage < STAGE_PLACED && has(player, GILDED_CROSS)) {
      take(player, GILDED_CROSS);
      if (!has(player, RING_OF_VISIBILITY)) give(player, RING_OF_VISIBILITY);
      player.sendMessage("Rasolo trades you the Ring of Visibility.");
      return "shadow-diamond-returning-to-rasolo";
    }
    if (has(player, RING_OF_VISIBILITY) || wearingRing(player)) return "shadow-diamond-talking-to-rasolo-again";
    return "shadow-diamond-talking-to-rasolo";
  }

  function malakVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_HUNT) return null;
    if (has(player, BLOOD_DIAMOND)) return "blood-diamond-talking-to-malak-after-obtaining-the-blood-diamond";
    if (has(player, BLESSED_POT) && !attr(player, ATTR_POT_BLOODED)) {
      setAttr(player, ATTR_POT_BLOODED, 1);
      player.sendMessage("Malak cuts you and pours some of your blood into the pot.");
      return "blood-diamond-talking-to-malak-with-the-blessed-pot";
    }
    if (attr(player, ATTR_MALAK_MET)) return "blood-diamond-talking-to-malak-after-agreeing-to-kill-dessous";
    setAttr(player, ATTR_MALAK_MET, 1);
    return "blood-diamond-talking-to-malak";
  }

  function highPriestVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_HUNT || holyGrailActive(player)) return null;
    if (has(player, SILVER_POT)) {
      take(player, SILVER_POT);
      if (!has(player, BLESSED_POT)) give(player, BLESSED_POT);
      setAttr(player, ATTR_POT_BLOODED, 0);
      setAttr(player, ATTR_POT_GARLIC, 0);
      setAttr(player, ATTR_POT_SPICE, 0);
      player.sendMessage("The High Priest blesses your silver pot.");
      return "blood-diamond-talking-to-the-high-priest-with-a-silver-pot-of-your-own-blood";
    }
    return "blood-diamond-talking-to-the-high-priest";
  }

  function trollChildVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_HUNT) return null;
    if (has(player, ICE_DIAMOND)) return "ice-diamond-talking-to-the-troll-child-after-receiving-the-ice-diamond";
    if (attr(player, ATTR_ICE_PARENTS)) {
      give(player, ICE_DIAMOND);
      player.sendMessage("The troll child gives you another Diamond of Ice.");
      return "ice-diamond-talking-to-the-troll-child-after-losing-the-ice-diamond";
    }
    if (attr(player, ATTR_ICE_AGREED)) return "ice-diamond-talking-to-the-troll-child-after-agreeing-to-help";
    if (attr(player, ATTR_ICE_SWEET)) return "ice-diamond-talking-to-the-troll-child-after-giving-them-sweet-food";
    return "ice-diamond-talking-to-the-troll-child";
  }

  function trollParentVariant(player) {
    if (quest.getStage(player) < STAGE_HUNT) return null;
    if (!attr(player, ATTR_ICE_PARENTS)) return null;
    if (!has(player, ICE_DIAMOND)) {
      give(player, ICE_DIAMOND);
      player.sendMessage("The troll parents give you the Diamond of Ice.");
    }
    return "ice-diamond-talking-to-the-troll-parents-after-freeing-them";
  }

  function selectVariant({ npcId, player }) {
    if (ASGARNIA_IDS.has(npcId)) return asgarniaVariant(player);
    if (npcId === TERRY_NPC_ID) return terryVariant(player);
    if (npcId === BARTENDER_NPC_ID) return bartenderVariant(player);
    if (EBLIS_IDS.has(npcId)) return eblisVariant(player);
    if (npcId === RASOLO_NPC_ID) return rasoloVariant(player);
    if (npcId === MALAK_NPC_ID) return malakVariant(player);
    if (npcId === RUANTUN_NPC_ID) return selectRuantunVariant(player);
    if (HIGH_PRIEST_IDS.has(npcId)) return highPriestVariant(player);
    if (TROLL_CHILD_IDS.has(npcId)) return trollChildVariant(player);
    if (npcId === TROLL_FATHER_ID || npcId === TROLL_MOTHER_ID) return trollParentVariant(player);
    if (AZZANADRA_IDS.has(npcId)) {
      return quest.getStage(player) >= STAGE_PLACED ? "the-ancient-pyramid-talking-to-azzanadra" : null;
    }
    return null;
  }

  function selectRuantunVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_HUNT) return null;
    if (!has(player, SILVER_POT) && !has(player, BLESSED_POT) && has(player, SILVER_BAR)) {
      take(player, SILVER_BAR);
      give(player, SILVER_POT);
      setAttr(player, ATTR_POT_BLOODED, 0);
      setAttr(player, ATTR_POT_GARLIC, 0);
      setAttr(player, ATTR_POT_SPICE, 0);
      player.sendMessage("Ruantun crafts you a silver pot.");
    }
    return "blood-diamond-talking-to-ruantun";
  }

  // ==========================================================================
  // Prose conditions, choices and transcript actions
  // ==========================================================================

  function answerCondition({ player, npcId, text }) {
    if (!DIALOGUE_NPC_IDS.has(npcId)) return null;
    const value = String(text).toLowerCase();
    if (value.includes("without the required skill levels")) return magicLevel(player) < 50;
    if (value.includes("650 coins")) {
      if (value.includes("doesn't")) return !has(player, COINS, 650);
      return has(player, COINS, 650);
    }
    if (value.includes("without all standing torches lit")) return (attr(player, ATTR_TORCHES) & 0xf) !== 0xf;
    if (value.includes("with all standing torches lit")) return (attr(player, ATTR_TORCHES) & 0xf) === 0xf;
    if (value.includes("without the warm key")) return !has(player, WARM_KEY);
    if (value.includes("with the warm key")) return has(player, WARM_KEY);
    if (value.includes("doesn't have the etchings") || value.includes("lost the etchings")) return !has(player, ETCHINGS);
    if (value.includes("etchings")) return has(player, ETCHINGS);
    if (value.includes("doesn't have the translation") || value.includes("lost the translation")) return !has(player, TRANSLATION);
    if (value.includes("translation")) return has(player, TRANSLATION);
    if (value.includes("has a silver bar")) return has(player, SILVER_BAR);
    if (value.includes("doesn't have a silver bar")) return !has(player, SILVER_BAR);
    if (value.includes("lost the ring")) return !has(player, RING_OF_VISIBILITY) && !wearingRing(player);
    if (value.includes("ring of charos")) return false;
    if (value.includes("blood moon rises")) return value.includes("not completed");
    if (value.includes("vampyre slayer")) {
      if (value.includes("not completed")) return !questComplete(player, "vampyre_slayer");
      return questComplete(player, "vampyre_slayer");
    }
    if (value.includes("full inventory")) return player.getInventory().isFull?.() === true;
    return null;
  }

  function questComplete(player, key) {
    const handle = questHandle(key);
    return Boolean(handle && handle.isComplete(player));
  }

  function handleChoice({ player, npcId, option }) {
    const label = String(option ?? "");
    if (ASGARNIA_IDS.has(npcId)) {
      if (quest.getStage(player) === STAGE_TRANSLATION_DELIVERED && /help him/i.test(label)) {
        quest.setStage(player, STAGE_AGREED);
      }
      return;
    }
    if (EBLIS_IDS.has(npcId)) {
      if (/will go get those/i.test(label) && quest.getStage(player) === STAGE_EBLIS_FOUND) {
        quest.setStage(player, STAGE_MATERIALS);
      }
      return;
    }
    if (BARTENDER_NPC_ID === npcId) {
      if (/four diamonds/i.test(label) && quest.getStage(player) === STAGE_BANDITS) {
        quest.setStage(player, STAGE_ASKED);
      }
      return;
    }
    if (TROLL_CHILD_IDS.has(npcId)) {
      if (/^yes/i.test(label) && attr(player, ATTR_ICE_SWEET) && quest.getStage(player) >= STAGE_HUNT) {
        setAttr(player, ATTR_ICE_AGREED, 1);
      }
      return;
    }
  }

  function handleStartHook({ player, npcId, hook }) {
    if (!ASGARNIA_IDS.has(npcId) || hook !== START_HOOK) return;
    if (quest.getStage(player) < STAGE_STARTED) quest.setStage(player, STAGE_STARTED);
  }

  /** A transcript condition was chosen: run the hand-in it represents. */
  function handleCondition({ player, npcId, text }) {
    if (npcId === TERRY_NPC_ID && /has the etchings/i.test(String(text ?? ""))) {
      take(player, ETCHINGS);
      return;
    }
    if (npcId === RASOLO_NPC_ID && /lost the ring/i.test(String(text ?? ""))) {
      if (!has(player, RING_OF_VISIBILITY)) give(player, RING_OF_VISIBILITY);
      player.sendMessage("Rasolo gives you another Ring of Visibility.");
    }
  }

  function handleAction(actionEvent) {
    const { player, npcId, stepId } = actionEvent;
    if (stepId === "n513zs" || stepId === "PoD0Nh") {
      if (!has(player, ETCHINGS)) give(player, ETCHINGS);
      actionEvent.handled = true;
      return;
    }
    if (stepId === "4k_Mh4" || stepId === "sAesSI") {
      if (!has(player, TRANSLATION)) give(player, TRANSLATION);
      if (quest.getStage(player) < STAGE_TRANSLATION_RECEIVED) {
        quest.setStage(player, STAGE_TRANSLATION_RECEIVED);
      }
      actionEvent.handled = true;
      return;
    }
    if (stepId === "SV5eWc" || stepId === "PGjjqb") {
      if (stepId === "PGjjqb") {
        player.sendMessage("You read the translation: 'The great Mahjarrat Azzanadra lies bound within the pyramid...'");
      }
      if (has(player, TRANSLATION)) take(player, TRANSLATION);
      if (quest.getStage(player) < STAGE_TRANSLATION_DELIVERED) {
        quest.setStage(player, STAGE_TRANSLATION_DELIVERED);
      }
      actionEvent.handled = true;
      return;
    }
    if (stepId === "sRlaoo") {
      if (!has(player, BANDITS_BREW)) give(player, BANDITS_BREW);
      if (quest.getStage(player) < STAGE_BANDITS) quest.setStage(player, STAGE_BANDITS);
      actionEvent.handled = true;
      return;
    }
    if (stepId === "vIMkMd") {
      take(player, COINS, 650);
      actionEvent.handled = true;
      return;
    }
    if (stepId === COMPLETE_ACTION_ID && AZZANADRA_IDS.has(npcId)) {
      if (!quest.isComplete(player)) quest.complete(player);
      actionEvent.handled = true;
    }
  }

  // ==========================================================================
  // Item hand-ins
  // ==========================================================================

  function handleItemOnNpc(event) {
    const { player, npcId, itemId } = event;
    if (EBLIS_IDS.has(npcId) && quest.getStage(player) >= STAGE_MATERIALS) {
      if (EBLIS_SUPPLIES.some((entry) => entry.itemId === itemId)) {
        event.handled = true;
        if (quest.getStage(player) === STAGE_MATERIALS && hasAllSupplies(player)) {
          for (const entry of EBLIS_SUPPLIES) take(player, entry.itemId, entry.quantity);
          quest.setStage(player, STAGE_MIRRORS);
          player.sendMessage("Eblis accepts the ingredients and begins enchanting the scrying glasses.");
        } else {
          const missing = EBLIS_SUPPLIES
            .filter((entry) => !has(player, entry.itemId, entry.quantity))
            .map((entry) => entry.label)
            .join(", ");
          player.sendMessage(`Eblis still needs: ${missing}.`);
        }
        return;
      }
    }
    if (TROLL_CHILD_IDS.has(npcId) && quest.getStage(player) >= STAGE_HUNT && SWEET_FOODS.has(itemId)) {
      take(player, itemId);
      setAttr(player, ATTR_ICE_SWEET, 1);
      player.sendMessage("You give the troll child some sweet food. He stops crying.");
      event.handled = true;
      return;
    }
    if (npcId === RUANTUN_NPC_ID && itemId === SILVER_BAR && quest.getStage(player) >= STAGE_HUNT
      && !has(player, SILVER_POT) && !has(player, BLESSED_POT)) {
      take(player, SILVER_BAR);
      give(player, SILVER_POT);
      setAttr(player, ATTR_POT_BLOODED, 0);
      setAttr(player, ATTR_POT_GARLIC, 0);
      setAttr(player, ATTR_POT_SPICE, 0);
      player.sendMessage("Ruantun crafts you a silver pot.");
      event.handled = true;
      return;
    }
    if (HIGH_PRIEST_IDS.has(npcId) && itemId === SILVER_POT && quest.getStage(player) >= STAGE_HUNT) {
      take(player, SILVER_POT);
      if (!has(player, BLESSED_POT)) give(player, BLESSED_POT);
      setAttr(player, ATTR_POT_BLOODED, 0);
      setAttr(player, ATTR_POT_GARLIC, 0);
      setAttr(player, ATTR_POT_SPICE, 0);
      player.sendMessage("The High Priest blesses your silver pot.");
      event.handled = true;
      return;
    }
    if (npcId === MALAK_NPC_ID && BLESSED_POTS.has(itemId) && quest.getStage(player) >= STAGE_HUNT
      && !attr(player, ATTR_POT_BLOODED)) {
      setAttr(player, ATTR_POT_BLOODED, 1);
      player.sendMessage("Malak cuts you and pours some of your blood into the pot.");
      event.handled = true;
    }
  }

  function torchBit(objectId) {
    return 1 << TORCH_BITS.indexOf(objectId);
  }

  const TORCH_BITS = [6405, 6407, 6409, 6411];

  function handleItemOnObject(event) {
    const { player, objectId, itemId } = event;
    if (TORCH_IDS.has(objectId) && itemId === TINDERBOX) {
      event.handled = true;
      if (quest.getStage(player) < STAGE_HUNT) return;
      const bit = torchBit(objectId);
      const mask = attr(player, ATTR_TORCHES) | bit;
      setAttr(player, ATTR_TORCHES, mask);
      player.sendMessage("You light the torch.");
      if ((mask & 0xf) === 0xf) player.sendMessage("The path is lit, now claim the key...");
      return;
    }
    if (PYRAMID_OBELISK_IDS.has(objectId) && DIAMOND_IDS.includes(itemId)) {
      event.handled = true;
      if (quest.getStage(player) < STAGE_HUNT) {
        player.sendMessage("The pillar seems to repel the diamond.");
        return;
      }
      take(player, itemId);
      const placed = attr(player, ATTR_PLACED) + 1;
      setAttr(player, ATTR_PLACED, placed);
      player.sendMessage("The diamond is absorbed into the pillar...");
      if (placed >= DIAMOND_IDS.length) {
        if (quest.getStage(player) < STAGE_PLACED) quest.setStage(player, STAGE_PLACED);
        player.sendMessage("The force preventing access to the Pyramid has now vanished.");
      }
      return;
    }
    if (objectId === DESSOUS_TOMB_ID && BLESSED_POTS.has(itemId)) {
      event.handled = true;
      if (quest.getStage(player) < STAGE_HUNT) return;
      player.sendMessage("You pour the blood from the pot onto the tomb. Dessous rises from his grave!");
      let alive = false;
      for (const npc of api.core.World.getNpcs()) {
        if (npc?.getId?.() !== DESSOUS_NPC_ID) continue;
        const location = npc.getLocation();
        if (Math.abs(location.getX() - DESSOUS_SPAWN.getX()) <= 10
          && Math.abs(location.getY() - DESSOUS_SPAWN.getY()) <= 10) alive = true;
      }
      if (!alive) {
        api.spawnNpc({
          id: DESSOUS_NPC_ID,
          x: DESSOUS_SPAWN.getX(),
          y: DESSOUS_SPAWN.getY(),
          z: DESSOUS_SPAWN.getZ(),
          owner: player,
          ownerOnly: true,
          wanderRadius: 0,
        });
      }
      return;
    }
    if (SMOKE_GATE_IDS.has(objectId) && itemId === WARM_KEY) {
      event.handled = true;
      if (quest.getStage(player) < STAGE_HUNT) return;
      player.sendMessage("You unlock the gate and enter the room.");
      player.moveTo(new Location(FAREED_ARENA.getX(), FAREED_ARENA.getY() + 2, FAREED_ARENA.getZ()));
    }
  }

  function handleItemOnItem(event) {
    const ids = [event.usedItemId, event.usedWithItemId];
    if (ids.includes(GARLIC) && ids.includes(PESTLE_AND_MORTAR)) {
      const { player } = event;
      take(player, GARLIC);
      give(player, GARLIC_POWDER);
      player.sendMessage("You grind the garlic into a fine powder.");
      event.handled = true;
      return;
    }
    if (!ids.some((id) => BLESSED_POTS.has(id))) return;
    const { player } = event;
    if (ids.includes(GARLIC_POWDER) && !attr(player, ATTR_POT_GARLIC)) {
      take(player, GARLIC_POWDER);
      setAttr(player, ATTR_POT_GARLIC, 1);
      player.sendMessage("You add some crushed garlic to the pot.");
      event.handled = true;
      return;
    }
    if (ids.includes(SPICE) && !attr(player, ATTR_POT_SPICE)) {
      take(player, SPICE);
      setAttr(player, ATTR_POT_SPICE, 1);
      player.sendMessage("You add some spices to the pot.");
      event.handled = true;
    }
  }

  // ==========================================================================
  // Object interactions
  // ==========================================================================

  function climbSmokeyWell({ player }) {
    if (quest.getStage(player) < STAGE_HUNT) {
      player.sendMessage("You can see a lot of foul looking smoke at the bottom of this well.");
      player.sendMessage("I don't think breathing it in directly would be very good for my health.");
      return false;
    }
    player.moveTo(SMOKE_DUNGEON_LANDING.clone());
    return true;
  }

  function openBurntChest({ player }) {
    if (quest.getStage(player) < STAGE_HUNT) return false;
    if ((attr(player, ATTR_TORCHES) & 0xf) !== 0xf) {
      player.sendMessage("There seems to be no way to open this chest. The torches must all be lit.");
      return true;
    }
    if (has(player, WARM_KEY)) {
      player.sendMessage("The chest is empty.");
      return true;
    }
    give(player, WARM_KEY);
    player.sendMessage("You open the chest and take a key.");
    return true;
  }

  function goThroughIceGate({ player }) {
    if (quest.getStage(player) < STAGE_HUNT) return false;
    if (!attr(player, ATTR_ICE_SWEET)) {
      player.sendMessage("The bars are frozen tightly shut and a sturdy layer of ice prevents you from slipping through.");
      return true;
    }
    if (!attr(player, ATTR_ICE_AGREED)) {
      player.sendMessage("Oh, I'm sorry. My mommy says that we ice trolls are so cold we can freeze the air around us.");
      player.sendMessage("I'm afraid I must have frozen those gates too much when I was crying.");
      return true;
    }
    const location = player.getLocation();
    if (location.getX() <= 2838) {
      player.moveTo(new Location(2843, 3736, 0));
    } else {
      player.moveTo(new Location(2835, 3736, 0));
    }
    return true;
  }

  function useIceLedge({ player }) {
    if (quest.getStage(player) < STAGE_HUNT) return false;
    const boots = player.getEquipment().get(Equipment.FEET_SLOT)?.getId?.();
    if (boots !== SPIKED_BOOTS) {
      player.sendMessage("I don't think I'll make much headway along that icy slope without some spiked boots...");
      return true;
    }
    if (player.getLocation().getZ() === 0) {
      player.moveTo(ICE_LEDGE_LANDING.clone());
    } else {
      player.moveTo(ICE_LEDGE_BOTTOM.clone());
    }
    return true;
  }

  function stepOffIceLedge({ player }) {
    player.moveTo(ICE_LEDGE_BOTTOM.clone());
    return true;
  }

  function openPyramidEntrance({ player }) {
    if (quest.getStage(player) < STAGE_PLACED) {
      player.sendMessage("A powerful force prevents you from entering the pyramid.");
      return false;
    }
    player.moveTo(PYRAMID_INTERIOR.clone());
    return true;
  }

  /** The Smoke Dungeon's east gate is named "Gate", so Doors asks quests first. */
  function handleDoorToggle(event) {
    if (!SMOKE_GATE_IDS.has(event.objectId)) return;
    event.handled = true;
    handleSmokeGate(event.player);
  }

  function handleSmokeGate(player) {
    if (quest.getStage(player) < STAGE_HUNT) return;
    if (!has(player, WARM_KEY)) {
      player.sendMessage("This gate is locked.");
      return;
    }
    player.sendMessage("You unlock the gate and enter the room.");
    if (player.getLocation().getX() <= 3305) {
      player.moveTo(new Location(3307, player.getLocation().getY(), player.getLocation().getZ()));
    } else {
      player.moveTo(new Location(3304, player.getLocation().getY(), player.getLocation().getZ()));
    }
  }

  function openSecureChest({ player }) {
    if (quest.getStage(player) < STAGE_HUNT || has(player, GILDED_CROSS)) return false;
    if (player.getSkillManager().getCurrentLevel(Skill.THIEVING) < 53 || !has(player, LOCKPICK)) {
      player.sendMessage("You need 53 Thieving and a lockpick to open this secure chest.");
      return true;
    }
    give(player, GILDED_CROSS);
    player.sendMessage("You pick the lock and find a gilded cross.");
    return true;
  }

  function climbShadowLadder({ player }) {
    if (wearingRing(player)) {
      player.moveTo(SHADOW_DUNGEON_LANDING.clone());
    } else {
      player.sendMessage("You cannot see a ladder there.");
    }
    return true;
  }

  function climbShadowExit({ player }) {
    player.moveTo(SHADOW_LADDER_STAND.clone());
    return true;
  }

  function climbSmokeExit({ player }) {
    player.moveTo(SMOKE_SURFACE.clone());
    return true;
  }

  function handleObjectInteraction(event) {
    const { player, objectId } = event;
    if (objectId === SMOKEY_WELL_ID) {
      event.handled = true;
      climbSmokeyWell(event);
      return;
    }
    if (objectId === BURNT_CHEST_ID) {
      event.handled = openBurntChest(event) === true;
      return;
    }
    if (SMOKE_GATE_IDS.has(objectId)) {
      event.handled = true;
      handleSmokeGate(player);
      return;
    }
    if (ICE_GATE_IDS.has(objectId)) {
      event.handled = goThroughIceGate(event) === true;
      return;
    }
    if (objectId === ICE_LEDGE_ID) {
      event.handled = useIceLedge(event) === true;
      return;
    }
    if (objectId === ICE_LEDGE_TOP_ID) {
      event.handled = stepOffIceLedge(event) === true;
      return;
    }
    if (PYRAMID_ENTRANCE_IDS.has(objectId)) {
      event.handled = true;
      openPyramidEntrance(event);
      return;
    }
    if (objectId === BANDIT_CHEST_ID) {
      event.handled = openSecureChest(event) === true;
      return;
    }
    if (objectId === LADDER_OBJECT_ID && event.location.x === SHADOW_LADDER_SURFACE.getX()
      && event.location.y === SHADOW_LADDER_SURFACE.getY()) {
      event.handled = climbShadowLadder(event) === true;
      return;
    }
    if (objectId === LADDER_UP_OBJECT_ID && event.location.x === SHADOW_DUNGEON_EXIT.getX()
      && event.location.y === SHADOW_DUNGEON_EXIT.getY()) {
      event.handled = climbShadowExit(event) === true;
      return;
    }
    if (objectId === LADDER_UP_OBJECT_ID && event.location.x === SMOKE_DUNGEON_EXIT.getX()
      && event.location.y === SMOKE_DUNGEON_EXIT.getY()) {
      event.handled = climbSmokeExit(event) === true;
    }
  }

  function smashIceBlock({ player, npc, npcId, definition }) {
    const blockId = npcId ?? npc?.getId?.();
    const name = definition?.getName?.() ?? npc?.getCurrentDefinition?.(player)?.getName?.();
    if (!ICE_BLOCK_IDS.has(blockId) && name !== "Ice block") return false;
    if (quest.getStage(player) < STAGE_HUNT) return false;
    api.removeNpc(npc);
    const lowerBlock = (npc?.getLocation?.().getY?.() ?? 0) <= 3809;
    const freed = attr(player, ATTR_ICE_PARENTS) | (lowerBlock ? 2 : 1);
    setAttr(player, ATTR_ICE_PARENTS, freed);
    player.sendMessage("You smash the ice block, freeing a troll!");
    if ((freed & 3) === 3) {
      let parentsAlive = false;
      for (const other of api.core.World.getNpcs()) {
        if (other?.getId?.() !== TROLL_FATHER_ID && other?.getId?.() !== TROLL_MOTHER_ID) continue;
        const at = other.getLocation();
        if (at.getZ() === 2 && Math.abs(at.getX() - 2830) <= 10 && Math.abs(at.getY() - 3809) <= 10) {
          parentsAlive = true;
        }
      }
      if (!parentsAlive) {
        api.spawnNpc({
          id: TROLL_FATHER_ID,
          x: 2830, y: 3807, z: 2,
          owner: player, ownerOnly: true, wanderRadius: 0,
        });
        api.spawnNpc({
          id: TROLL_MOTHER_ID,
          x: 2830, y: 3811, z: 2,
          owner: player, ownerOnly: true, wanderRadius: 0,
        });
      }
    }
    return true;
  }

  // ==========================================================================
  // NPC deaths
  // ==========================================================================

  /** Thaws the cave mouth open; safe to call more than once. */
  function openIceCave() {
    for (const location of ICE_CAVE_TILES) {
      const key = MapObjects.getHash(location.getX(), location.getY(), location.getZ());
      for (const object of [...(MapObjects.mapObjects.get(key) ?? [])]) {
        ObjectManager.deregister(object, true);
      }
      MapObjects.clear(location, -1);
    }
  }

  /** The four diamond drops. */
  function handleNpcDeath(event) {
    const player = event.killer ?? event.player;
    const { npcId } = event;
    if (!player || quest.getStage(player) < STAGE_HUNT) return;

    // The death event reports the player-resolved variant id; the spawned id is
    // matched too because rev-241 npc transforms can resolve some spawns elsewhere.
    if (ICE_TROLL_IDS.has(npcId) || ICE_TROLL_IDS.has(event.npc?.getId?.())) {
      const killed = attr(player, ATTR_ICE_TROLLS) + 1;
      setAttr(player, ATTR_ICE_TROLLS, killed);
      if (killed <= 5) player.sendMessage("A chunk of ice falls away from the cave entrance...");
      if (killed === 5) {
        player.sendMessage("The cave entrance has thawed open!");
        openIceCave();
      }
      return;
    }

    const drop = npcId === DAMIS_SECOND_NPC_ID ? SHADOW_DIAMOND
      : npcId === DESSOUS_NPC_ID ? BLOOD_DIAMOND
      : npcId === KAMIL_NPC_ID ? ICE_DIAMOND
      : npcId === FAREED_NPC_ID ? SMOKE_DIAMOND
      : undefined;
    if (drop === undefined) return;
    if (!has(player, drop) && !player.getInventory().isFull()) {
      give(player, drop);
      player.sendMessage("You take one of the Diamonds of Azzanadra.");
    }
  }

  /** Damis' first form splits into his second form, once. */
  function handleNpcBeforeDeath(event) {
    if (event.npc?.getId?.() !== DAMIS_FIRST_NPC_ID) return;
    const location = event.npc.getLocation();
    for (const npc of api.core.World.getNpcs()) {
      if (npc?.getId?.() !== DAMIS_SECOND_NPC_ID) continue;
      const other = npc.getLocation();
      if (Math.abs(other.getX() - location.getX()) <= 20 && Math.abs(other.getY() - location.getY()) <= 20) {
        return;
      }
    }
    const spots = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, -1]];
    const spot = spots.find(([dx, dy]) =>
      !RegionManager.blocked(new Location(location.getX() + dx, location.getY() + dy, location.getZ()), null)
    ) ?? [0, 1];
    api.spawnNpc({
      id: DAMIS_SECOND_NPC_ID,
      x: location.getX() + spot[0],
      y: location.getY() + spot[1],
      z: location.getZ(),
      wanderRadius: 0,
    });
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
    // The thaw is world state, lost on restart; reopen it for anyone past the count.
    if (quest.getStage(player) >= STAGE_HUNT && attr(player, ATTR_ICE_TROLLS) >= 5) openIceCave();
  }

  // ==========================================================================
  // World objects the cache map lacks
  // ==========================================================================

  function ensureObject(id, location, type, face) {
    for (const object of ObjectManager.objectsAt(location)) {
      if (object.getId() === id) return;
    }
    ObjectManager.register(new GameObject(id, location.clone(), type, face, null), true);
  }

  function installQuestObjects() {
    ensureObject(LADDER_OBJECT_ID, SHADOW_LADDER_SURFACE, 10, 0);
    ensureObject(LADDER_UP_OBJECT_ID, SHADOW_DUNGEON_EXIT, 10, 2);
    ensureObject(LADDER_UP_OBJECT_ID, SMOKE_DUNGEON_EXIT, 10, 0);
  }

  quest = registerQuest(api, {
    key: "desert_treasure_i",
    name: "Desert Treasure I",
    varpId: VARP_DESERT_TREASURE,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 3,
    xpRewards: [{ skillId: Skill.MAGIC.getIndex(), amount: 20000, label: "Magic" }],
    rewardItemId: ANCIENT_STAFF,
    rewardItemLabel: "An Ancient staff",
    otherRewards: [
      "Access to the Ancient Magicks spellbook",
      "The ability to purchase an Ancient staff",
      "Access to the Smoke Dungeon",
    ],
    buildJournal,
    onReward: grantReward,
  });

  api.persistAttribute(ATTR_MALAK_MET);
  api.persistAttribute(ATTR_POT_BLOODED);
  api.persistAttribute(ATTR_POT_GARLIC);
  api.persistAttribute(ATTR_POT_SPICE);
  api.persistAttribute(ATTR_ICE_SWEET);
  api.persistAttribute(ATTR_ICE_AGREED);
  api.persistAttribute(ATTR_ICE_TROLLS);
  api.persistAttribute(ATTR_ICE_PARENTS);
  api.persistAttribute(ATTR_TORCHES);
  api.persistAttribute(ATTR_PLACED);

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:condition", handleCondition);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("door:toggle", handleDoorToggle);
  api.onNpcDeath(handleNpcDeath);
  api.onNpcBeforeDeath(handleNpcBeforeDeath);
  api.onItemOnNpc(handleItemOnNpc);
  api.onItemOnItem(handleItemOnItem);
  api.onItemOnObject(handleItemOnObject);
  api.onAnyNpcInteraction({ "Smash-ice": smashIceBlock });
  api.onObjectInteraction(handleObjectInteraction);
  api.onServerStartup(installQuestObjects);
  api.onPlayerLogin(handleLogin);
};
