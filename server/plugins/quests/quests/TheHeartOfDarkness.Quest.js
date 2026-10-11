/**
 * The Heart of Darkness (members).
 *
 * The words come from the "The Heart of Darkness" transcript page (OSRS Wiki); this
 * plugin supplies the NPC variant selector, the start hook, the prose-condition
 * answers, the pub/bed/shopkeeper infiltration, the four Tower of Ascension trials
 * (pickpocket, combat waves, traitor, Prince Itzla), the robes chest, the Twilight
 * Temple initiation, the Tapoyauik mining/statue puzzle and the Amoxliatl fight.
 *
 * The stage lives in varbit 11117 "vmq3" (varp 4386 "vmq3_primary", bits 0-6).
 * Evidence: scripts/lookup-gameval.ts varbit vmq3 -> varp=4386 bits=0-6; quest
 * dbrow 3710 ("Heart of Darkness, The", table 0) col 19 = 76 (completion stage),
 * col 25 = 3512 (prereq Twilight's Promise), col 33 = [14,80000,17,80000,
 * 18,80000,16,80000] (Mining/Thieving/Slayer/Agility, tenths). Sibling varbits in
 * the same varp: vmq3_itzla_vis (bits 11-14), vmq3_recruit_1..4 (bits 7-10),
 * vmq3_tower_trial_* / vmq3_ruins_* in varps 4387/4388/4396.
 *
 * Stages (even checkpoints, completion 76):
 *   0 not started, 2 started (undercover plan agreed), 4 queen cutscene done,
 *   6 slept at the Windbreaker (Itzla revealed), 8 shopkeeper will send word,
 *   10 reported back / Itzla departs for the temple, 12 met Itzla at the Tower,
 *   14 reported the Augur / Janus calls you in, 16 first trial: pickpocket,
 *   18 tower key held, 20 book + first scrap, 22 poem + second scrap,
 *   24 completed note, 26 passphrase accepted, 28 second trial ready,
 *   30 second trial fight, 32 second trial won, 34 third trial ready,
 *   36 questioning the four acolytes, 38 traitor executed, 40 final trial:
 *   fight Prince Itzla, 42 Itzla yielded, 44 back in the lobby, 46 claim the
 *   robes, 48 robed for the temple, 50 initiation ceremony seen, 52 tasked with
 *   Tapoyauik, 54 entered the ruins, 56 blockage cleared (nagua ambush),
 *   58 reunited with Itzla at the frozen door, 60 puzzle (statues touchable),
 *   62 statues solved / door open / Amoxliatl, 64 Amoxliatl defeated,
 *   66 banished to Civitas illa Fortis, 76 complete.
 *
 * Source: OSRS Wiki "The Heart of Darkness" page, quick guide, transcript and
 * journal, plus the cache ids above. Rewards per the wiki (8,000 XP in Mining,
 * Thieving, Slayer and Agility, 2 Quest points, access to Tapoyauik).
 *
 * Gaps / approximations:
 *  - The Tower trials and the Amoxliatl fight are instanced in live OSRS. Here the
 *    trial NPCs are per-player owner-only spawns placed on the real tower trial
 *    floor (z=1) next to the real chests (54372/54374/54376) and the lobby robes
 *    chest (54515). The second/fourth trial waves are condensed to the level-74
 *    brawlers and level-71 conjurers (13773/13777); bandages and medical boxes
 *    (54378+) are not simulated, and Itzla cannot actually lose the second trial.
 *  - Pickpocketing the Emissary Ascended (13706, Talk-to only in this cache) is a
 *    Talk-to that plays the pickpocket transcript variant and hands over the key.
 *    The south-west gate is not simulated: the tower key unlocks the chests directly.
 *  - The passphrase is fixed to "Chua Chaki Iknil" instead of being derived from
 *    the book/poem; the traitor is a per-player random pick (persisted attribute).
 *  - The statue puzzle skips the urn/icon stage (no urn or mural objects exist on
 *    the base map): the four west-room statues (base ids 54457/54463/54469/54475)
 *    are swapped for touchable ones (54456/54462/54468/54474) in the fixed order
 *    (1605,9627) -> (1608,9624) -> (1608,9638) -> (1605,9635); touching them in
 *    order opens the door. The mineable rocks (54501) and the frozen door (54451)
 *    are registered at (1695,9629,2) and (1602,9631,0) because the live puzzle room
 *    objects are instanced. The frost nagua already spawn on the base maps.
 *  - The Windbreaker bed (52453) has no actions, so it is swapped for the quest
 *    bed 54513 ("Rest"). Cutscenes are dialogue only: no camera, no instancing and
 *    multi-speaker lines share one chathead (the NPC being talked to).
 *  - Skill/quest requirements are checked at the start (55 Mining, 48 Thieving,
 *    48 Slayer, 46 Agility, Twilight's Promise and Children of the Sun complete).
 */
module.exports = function registerTheHeartOfDarknessQuest(pluginApi) {
  const {
    Equipment,
    GameObject,
    ItemIdentifiers,
    Location,
    MapObjects,
    NpcIdentifiers,
    ObjectIdentifiers,
    ObjectManager,
    RegionManager,
    Skill,
  } = pluginApi.core;
  const runtime = require("../QuestRuntime");
  const { registerQuest, startTranscript } = runtime;

  // Varp 4386 "vmq3_primary"; the stage is varbit 11117 "vmq3" (bits 0-6).
  const VARP_HEART_OF_DARKNESS = 4386;
  const STAGE_VARBIT = 11117;

  const PAGE = "The Heart of Darkness";
  const QUEST_KEY = "the_heart_of_darkness";
  const START_HOOK = "quest:the-heart-of-darkness:start";
  const TWILIGHTS_PROMISE_KEY = "twilights_promise";
  const CHILDREN_OF_THE_SUN_KEY = "children_of_the_sun";
  const PERILOUS_MOONS_KEY = "perilous_moons";

  const STAGE = {
    STARTED: 2,
    QUEEN_DONE: 4,
    AT_PUB: 6,
    SHOP_AGREED: 8,
    AT_TOWER: 10,
    MINGLED: 12,
    RECRUITED_INFO: 14,
    TRIAL1_KEY: 16,
    TRIAL1_BOOK: 18,
    TRIAL1_POEM: 20,
    TRIAL1_SCRAP3: 22,
    TRIAL1_NOTE: 24,
    TRIAL1_DONE: 26,
    TRIAL2_READY: 28,
    TRIAL2_FIGHT: 30,
    TRIAL2_DONE: 32,
    TRIAL3_READY: 34,
    TRIAL3_ACTIVE: 36,
    TRIAL4_READY: 38,
    TRIAL4_FIGHT: 40,
    TRIAL4_DONE: 42,
    LOBBY: 44,
    ROBES: 46,
    ROBED: 48,
    INITIATED: 50,
    DUTIES: 52,
    RUINS_ENTERED: 54,
    BLOCKAGE_CLEARED: 56,
    DOOR_MET: 58,
    PUZZLE: 60,
    DOOR_OPEN: 62,
    AMOX_DEFEATED: 64,
    BANISHED: 66,
    COMPLETE: 76,
  };
  STAGE.TRIAL3_DONE = STAGE.TRIAL4_READY;

  const V = {
    START: "starting-the-quest-talking-to-prince-itzla-arkan",
    QUEEN: "meeting-with-queen-zyani-arkan-to-begin-planning-the-infiltration",
    AFTER_MEETING:
      "meeting-with-queen-zyani-arkan-to-begin-planning-the-infiltration-talking-to-prince-itzla-arkan-after-meeting-with-queen-zyani-arkan",
    AFTER_MEETING_AGAIN:
      "meeting-with-queen-zyani-arkan-to-begin-planning-the-infiltration-talking-to-prince-itzla-arkan-after-meeting-with-queen-zyani-arkan-talking-to-itzla-again",
    BARTENDER: "visiting-the-windbreaker-bar-talking-to-the-bartender-at-quetzacalli-gorge",
    BED: "visiting-the-windbreaker-bar-resting-in-the-bed",
    PUB_ITZLA: "visiting-the-windbreaker-bar-resting-in-the-bed-talking-to-itzla-again",
    SHOP: "talking-to-the-quetzacalli-gorge-shopkeeper",
    SHOP_AGAIN:
      "talking-to-the-quetzacalli-gorge-shopkeeper-talking-to-him-again-after-getting-directions-to-the-twilight-temple",
    REPORT: "talking-to-the-quetzacalli-gorge-shopkeeper-reporting-back-to-prince-itzla-arkan",
    TOWER: "talking-to-prince-itzla-arkan",
    TOWER_AGAIN: "talking-to-prince-itzla-arkan-talking-to-itzla-again",
    NOVA: "talking-to-prince-itzla-arkan-talking-to-nova",
    CARITTA: "talking-to-prince-itzla-arkan-talking-to-caritta",
    FELIUS: "talking-to-prince-itzla-arkan-talking-to-felius",
    SERGIUS: "talking-to-prince-itzla-arkan-talking-to-sergius",
    REPORT_AUGUR: "talking-to-prince-itzla-arkan-reporting-back-to-prince-itzla-arkan",
    JANUS_INTRO: "descending-into-the-tower-of-ascension",
    JANUS_FIRST: "descending-into-the-tower-of-ascension-first-trial",
    PICKPOCKET: "descending-into-the-tower-of-ascension-first-trial-pickpocketing-a-cultist",
    GATE_CHEST:
      "descending-into-the-tower-of-ascension-first-trial-unlocking-the-south-west-gate-and-chest",
    POEM_CHEST: "descending-into-the-tower-of-ascension-first-trial-unlocking-the-south-west-chest",
    ITZLA_POEM_PRE:
      "descending-into-the-tower-of-ascension-first-trial-talking-to-prince-itzla-arkan-before-receiving-the-poem",
    ITZLA_POEM:
      "descending-into-the-tower-of-ascension-first-trial-talking-to-prince-itzla-arkan-after-reading-the-poem",
    ITZLA_NOTE:
      "descending-into-the-tower-of-ascension-first-trial-talking-to-prince-itzla-arkan-with-the-completed-note",
    JANUS_NOTE:
      "descending-into-the-tower-of-ascension-first-trial-talking-to-forebearer-janus-with-the-completed-note",
    JANUS_CHEST: "descending-into-the-tower-of-ascension-attempting-to-open-the-chest-in-the-lobby-without-permission",
    EMISSARY_BEFORE: "descending-into-the-tower-of-ascension-first-trial-talking-to-an-emissary-ascended-before-completing-the-first-trial",
    EMISSARY_AFTER: "descending-into-the-tower-of-ascension-talking-to-an-emissary-ascended-after-completing-the-first-trial",
    JANUS_AFTER_T1: "descending-into-the-tower-of-ascension-talking-to-forebearer-janus-after-completing-the-first-trial",
    TRIAL2: "descending-into-the-tower-of-ascension-second-trial-talking-to-forebearer-janus",
    ITZLA_T2: "descending-into-the-tower-of-ascension-second-trial-talking-to-itzla-before-beginning-the-fight",
    T2_AFTER: "descending-into-the-tower-of-ascension-second-trial-after-the-fight",
    ITZLA_T2_AFTER: "descending-into-the-tower-of-ascension-second-trial-after-the-fight-talking-to-itzla",
    TRIAL3: "descending-into-the-tower-of-ascension-third-trial",
    T3_ITZLA: "descending-into-the-tower-of-ascension-third-trial-talking-to-prince-itzla-again",
    TENOCH: "descending-into-the-tower-of-ascension-third-trial-questioning-tenoch",
    SILIA: "descending-into-the-tower-of-ascension-third-trial-questioning-silia",
    ADRIUS: "descending-into-the-tower-of-ascension-third-trial-questioning-adrius",
    ELEUIA: "descending-into-the-tower-of-ascension-third-trial-questioning-eleuia",
    CHOOSE: "descending-into-the-tower-of-ascension-third-trial-choosing-the-traitor",
    T3_ITZLA_EXEC: "descending-into-the-tower-of-ascension-third-trial-talking-to-prince-itzla-arkan-after-the-execution",
    TRIAL4: "descending-into-the-tower-of-ascension-fourth-trial",
    T4_ITZLA_FINAL: "descending-into-the-tower-of-ascension-during-the-fight-against-prince-itzla-after-dealing-the-final-blow",
    JANUS_AFTER_T4: "descending-into-the-tower-of-ascension-speaking-to-forebearer-janus-after-defeating-prince-itzla",
    ITZLA_LOBBY: "descending-into-the-tower-of-ascension-speaking-to-prince-itzla-in-the-lobby",
    JANUS_LOBBY: "descending-into-the-tower-of-ascension-speaking-to-forebearer-janus-in-the-lobby",
    JANUS_LOBBY_AGAIN:
      "descending-into-the-tower-of-ascension-speaking-to-forebearer-janus-in-the-lobby-speaking-to-forebearer-janus-again",
    ITZLA_AFTER_JANUS: "descending-into-the-tower-of-ascension-talking-to-prince-itzla-after-talking-to-forebearer-janus",
    ITZLA_ROBES: "descending-into-the-tower-of-ascension-talking-to-prince-itzla-after-getting-the-robes",
    JANUS_ROBES: "descending-into-the-tower-of-ascension-talking-to-forebearer-janus-after-getting-the-robes",
    CHEST: "descending-into-the-tower-of-ascension-searching-the-chest",
    CHEST_FULL: "descending-into-the-tower-of-ascension-searching-the-chest-without-enough-inventory-space",
    CHEST_RECLAIM: "descending-into-the-tower-of-ascension-reclaiming-the-robes-if-they-re-lost",
    CHEST_ROBED: "descending-into-the-tower-of-ascension-searching-the-chest-with-the-robes",
    NO_ROBES: "descending-into-the-tower-of-ascension-attempting-to-enter-the-twilight-temple-without-the-robes-on",
    INITIATION: "initiation",
    ITZLA_AFTER_INIT: "initiation-talking-to-prince-itzla-after-the-initiation",
    ITZLA_BEFORE_FIDES: "initiation-talking-to-prince-itzla-after-the-initiation-talking-to-itzla-again-before-fides",
    FIDES: "initiation-talking-to-forebearer-fides",
    FIDES_AGAIN: "initiation-talking-to-forebearer-fides-talking-to-fides-again",
    ITZLA_FIDES_AFTER: "initiation-talking-to-forebearer-fides-talking-to-prince-itzla-after-fides",
    RUINS: "initiation-entering-tapoyauik",
    VULCAN: "initiation-talking-to-forebearer-vulcan",
    ROCKS: "initiation-after-clearing-the-rocks",
    ITZLA_DOOR: "initiation-talking-to-prince-itzla-by-the-frozen-door",
    ITZLA_WORDS: "initiation-talking-to-prince-itzla-again",
    DOOR_FROZEN: "initiation-solving-the-puzzle-checking-the-frozen-door",
    DOOR_OPEN: "initiation-after-opening-the-door",
    AMOX: "heart-of-the-ruins",
    AMOX_DONE: "heart-of-the-ruins-after-defeating-amoxliatl",
    SERVIUS: "heart-of-the-ruins-talking-to-servius-teokan-of-ralos",
  };

  // Prose condition step ids on "The Heart of Darkness" page.
  const C = {
    REQS_NO: "PeHbKF",
    REQS_YES: "Ulgxje",
    BARTENDER_FIRST: "MYC58N",
    BARTENDER_AGAIN: "mIUNoa",
    BARTENDER_POOR: "pJ0LFe",
    PICKPOCKET_AGAIN: "H00jBZ",
    CHEST_AGAIN: "-CGqda",
    POEM_OK: "LKAMzW",
    POEM_BAD: "g-PPxM",
    ITZLA_NO_KEY: "pI4GD8",
    ITZLA_KEY: "EgeN2l",
    ITZLA_BOOK: "vl7lj7",
    SCRAP_CHEST: "-TiHOM",
    COMBO_WRONG: "xOxc9n",
    COMBO_RIGHT: "QtU6YH",
    NO_BANDAGE: "sWx0Gp",
    BANDAGE: "QK5TP0",
    WAVES_DEAD: "428YHT",
    JANUS_DURING_TRIAL: "axmZBm",
    NO_SCRAPS: "HrF8WL",
    TWO_SCRAPS: "fiET8W",
    ACCUSED_INNOCENT: "4c5cRY",
    ACCUSED_TRAITOR: "LdzHnw",
    FOLLOWED_A: "J075SG",
    NOT_FOLLOWED_A: "pIohia",
    FOLLOWED_B: "B4AnfO",
    NOT_FOLLOWED_B: "suZuGU",
    FOLLOWED_C: "IouwJx",
    NOT_FOLLOWED_C: "Cwnadj",
    FOLLOWED_D: "JSXbIW",
    NOT_FOLLOWED_D: "AObNnk",
    HOLDING_ICON: "ZdBNNm",
    WATER_STATUE: "9iqI2Q",
    EARTH_STATUE: "C5cbbI",
    FIRE_STATUE: "XpTrfZ",
    NO_ICON: "T_rLes",
    PERILOUS_NO: "KHOHrE",
    PERILOUS_YES: "MlylVV",
  };

  // Action / message step ids on the page.
  const A = {
    PAY: "j4EUkz",
    KEY: "aTKPX4",
    RECEIVE_BOOK: "ae317n",
    RECEIVE_POEM: "84RaFI",
    RECEIVE_SCRAP3: "jVGiue",
    RECEIVE_NOTE: "Sy4-hH",
    ROBES: "ZDjr4J",
    ROBES_RECLAIM: "eXuLCT",
    NAGUA_APPEAR: "ncfvjP",
    VULCAN_DIES: "NekRFe",
    BANISH: "RO257s",
  };

  const FLAG_RENTED = 1 << 0;
  const FLAG_AUGUR = 1 << 1;
  const FLAG_PUB_TOLD = 1 << 2;
  const COMBO_STEP_1 = new Set(["Chua", "Moki", "Lini", "Kualt"]);
  const COMBO_STEP_2 = new Set(["Chaki", "Koma", "Ueai", "Huka"]);
  const COMBO_STEP_3 = new Set(["Iknil", "Kemo", "Ami", "Ikam"]);
  const COMBO_CORRECT = ["Chua", "Chaki", "Iknil"];

  const FLAGS_ATTRIBUTE = "quest.the_heart_of_darkness.flags";
  const TRAITOR_ATTRIBUTE = "quest.the_heart_of_darkness.traitor";
  const ACCUSED_ATTRIBUTE = "quest.the_heart_of_darkness.accused";
  const STATUE_ATTRIBUTE = "quest.the_heart_of_darkness.statues";

  // Named cache ids. Filled from api.core in register().
  const ID = {};

  // Fixed tiles (validated against the cache clipping).
  const TEOMAT_TILE = { x: 1454, y: 3176, z: 0 };
  const PUB_ITZLA_TILE = { x: 1500, y: 3226, z: 1 };
  const PUB_BED_TILE = { x: 1501, y: 3226, z: 1 };
  const TOWER_ITZLA_TILE = { x: 1660, y: 3219, z: 0 };
  const TOWER_JANUS_TILE = { x: 1656, y: 3219, z: 0 };
  const TRIAL_ITZLA_TILE = { x: 1640, y: 3224, z: 1 };
  const TRIAL_JANUS_TILE = { x: 1646, y: 3216, z: 1 };
  const LOBBY_ITZLA_TILE = { x: 1638, y: 3219, z: 1 };
  const LOBBY_JANUS_TILE = { x: 1656, y: 3219, z: 0 };
  const ASCENDED_TILES = [
    { x: 1640, y: 3220, z: 1 },
    { x: 1642, y: 3223, z: 1 },
    { x: 1644, y: 3222, z: 1 },
  ];
  const ACOLYTE_TILES = [
    { x: 1636, y: 3220, z: 1 },
    { x: 1638, y: 3220, z: 1 },
    { x: 1642, y: 3219, z: 1 },
    { x: 1644, y: 3219, z: 1 },
  ];
  const TEMPLE_ITZLA_TILE = { x: 1680, y: 3248, z: 0 };
  const TEMPLE_LEAVE_TILE = { x: 1680, y: 3258, z: 0 };
  const RUINS_ITZLA_TILE = { x: 1695, y: 9630, z: 2 };
  const VULCAN_TILE = { x: 1698, y: 9633, z: 2 };
  const ROCKS_TILE = { x: 1695, y: 9629, z: 2 };
  const DOOR_TILE = { x: 1602, y: 9631, z: 0 };
  const DOOR_ITZLA_TILE = { x: 1607, y: 9631, z: 0 };
  const AMOX_TILE = { x: 1600, y: 9631, z: 0 };
  const BANISH_TILE = { x: 1450, y: 3174, z: 0 };
  const SCRAP_CHEST_TILE = { x: 1644, y: 3217, z: 1 };
  const SCRAP_CHEST_OPEN_TILE = { x: 1646, y: 3216, z: 1 };
  const TRIAL2_OFFSETS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const STATUE_SWAPS = [
    { baseId: 54457, touchId: 54456, x: 1605, y: 9627 },
    { baseId: 54463, touchId: 54462, x: 1608, y: 9624 },
    { baseId: 54469, touchId: 54468, x: 1608, y: 9638 },
    { baseId: 54475, touchId: 54474, x: 1605, y: 9635 },
  ];
  const TOUCH_ORDER = STATUE_SWAPS.map((entry) => entry.touchId);

  const RUINS_ZONE = { minX: 1590, maxX: 1730, minY: 9590, maxY: 9680, levels: [0, 1, 2, 3] };
  const TEMPLE_ZONE = { minX: 1666, maxX: 1698, minY: 3241, maxY: 3254, levels: [0] };

  let quest;
  const trackedNpcs = new WeakMap();
  const waveNpcs = new WeakMap();
  const comboPicks = new WeakMap();
  const scrapChestPending = new WeakSet();
  const amoxTalked = new WeakSet();
  const pendingServiusReport = new WeakSet();
  let objectsPlaced = false;
  let statuesSwapped = false;
  let bedSwapped = false;
  let chestMoved = false;

  // ==========================================================================
  // State helpers
  // ==========================================================================

  const held = (player, itemId, amount = 1) => player.getInventory().getAmount(itemId) >= amount;
  const inventoryFull = (player) => player.getInventory().isFull();

  function flags(player) {
    return Number(player.getAttribute(FLAGS_ATTRIBUTE)) || 0;
  }

  function hasFlag(player, flag) {
    return (flags(player) & flag) !== 0;
  }

  function setFlag(player, flag) {
    player.setAttribute(FLAGS_ATTRIBUTE, flags(player) | flag);
  }

  function hasAnyScrap(player) {
    return held(player, ID.SCRAP_1) || held(player, ID.SCRAP_2) || held(player, ID.SCRAP_3);
  }

  function hasRobes(player) {
    return ID.ROBES.every((itemId) => held(player, itemId));
  }

  function wearingRobes(player) {
    const equipment = player.getEquipment();
    return equipment.get(Equipment.HEAD_SLOT)?.getId?.() === ID.ROBE_HOOD
      && equipment.get(Equipment.BODY_SLOT)?.getId?.() === ID.ROBE_TOP
      && equipment.get(Equipment.LEG_SLOT)?.getId?.() === ID.ROBE_BOTTOM
      && equipment.get(Equipment.FEET_SLOT)?.getId?.() === ID.ROBE_SANDALS;
  }

  function isQuestComplete(player, key) {
    const request = { player, key };
    pluginApi.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    return skills.getMaxLevel(Skill.MINING) >= 55
      && skills.getMaxLevel(Skill.THIEVING) >= 48
      && skills.getMaxLevel(Skill.SLAYER) >= 48
      && skills.getMaxLevel(Skill.AGILITY) >= 46
      && isQuestComplete(player, TWILIGHTS_PROMISE_KEY)
      && isQuestComplete(player, CHILDREN_OF_THE_SUN_KEY);
  }

  function playTranscript(player, npcId, variant, select) {
    return startTranscript(pluginApi, player, npcId, PAGE, variant, select);
  }

  function giveItem(player, itemId, amount = 1) {
    if (inventoryFull(player)) {
      player.sendMessage("You need more inventory space.");
      return false;
    }
    player.getInventory().adds(itemId, amount);
    return true;
  }

  function advance(player, stage) {
    if (quest.getStage(player) >= stage) return;
    quest.setStage(player, stage);
    ensureQuestNpcs(player);
  }

  // ==========================================================================
  // Per-player quest NPC spawns
  // ==========================================================================

  function syncTracked(player, key, definition) {
    const tracked = trackedNpcs.get(player) ?? new Map();
    trackedNpcs.set(player, tracked);
    const existing = tracked.get(key);
    if (!definition) {
      if (existing?.isRegistered?.()) pluginApi.removeNpc(existing);
      if (existing) tracked.delete(key);
      return null;
    }
    const location = existing?.getLocation?.();
    if (
      existing?.isRegistered?.()
      && existing.getId?.() === definition.id
      && location?.getX?.() === definition.x
      && location?.getY?.() === definition.y
      && location?.getZ?.() === (definition.z ?? 0)
    ) return existing;
    if (existing?.isRegistered?.()) pluginApi.removeNpc(existing);
    const npc = pluginApi.spawnNpc({ ...definition, owner: player, ownerOnly: true });
    if (npc) tracked.set(key, npc);
    return npc;
  }

  function removeTracked(player, key) {
    return syncTracked(player, key, null);
  }

  function removeAllTracked(player) {
    const tracked = trackedNpcs.get(player);
    if (!tracked) return;
    for (const npc of tracked.values()) if (npc?.isRegistered?.()) pluginApi.removeNpc(npc);
    trackedNpcs.delete(player);
  }

  function itzlaSpawn(stage) {
    if (stage >= STAGE.TRIAL4_FIGHT && stage < STAGE.TRIAL4_DONE) return null;
    if (stage < STAGE.AT_PUB) return { ...TEOMAT_TILE };
    if (stage < STAGE.AT_TOWER) return { ...PUB_ITZLA_TILE };
    if (stage < STAGE.TRIAL1_KEY) return { ...TOWER_ITZLA_TILE };
    if (stage < STAGE.TRIAL4_DONE) return { ...TRIAL_ITZLA_TILE };
    if (stage < STAGE.ROBES) return { ...LOBBY_ITZLA_TILE };
    if (stage < STAGE.DUTIES) return { ...TEMPLE_ITZLA_TILE };
    if (stage < STAGE.BLOCKAGE_CLEARED) return { ...RUINS_ITZLA_TILE };
    if (stage < STAGE.DOOR_OPEN) return { ...DOOR_ITZLA_TILE };
    return null;
  }

  function janusSpawn(stage) {
    if (stage < STAGE.RECRUITED_INFO || stage >= STAGE.ROBED) return null;
    if (stage < STAGE.TRIAL1_KEY) return { ...TOWER_JANUS_TILE };
    if (stage < STAGE.TRIAL4_DONE) return { ...TRIAL_JANUS_TILE };
    return { ...LOBBY_JANUS_TILE };
  }

  function ensureQuestNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = quest.getStage(player);
    if (quest.isComplete(player)) {
      removeAllTracked(player);
      return;
    }

    const itzla = itzlaSpawn(stage);
    syncTracked(player, "itzla", itzla ? { id: ID.ITZLA, ...itzla, wanderRadius: 0 } : null);

    const janus = janusSpawn(stage);
    syncTracked(player, "janus", janus ? { id: ID.JANUS, ...janus, wanderRadius: 0 } : null);

    const trial1 = stage >= STAGE.TRIAL1_KEY && stage < STAGE.TRIAL1_DONE;
    for (let index = 0; index < ASCENDED_TILES.length; index++) {
      syncTracked(player, `ascended-${index}`, trial1
        ? { id: ID.ASCENDED[index % ID.ASCENDED.length], ...ASCENDED_TILES[index], wanderRadius: 0 }
        : null);
    }

    const trial3 = stage >= STAGE.TRIAL3_ACTIVE && stage < STAGE.TRIAL3_DONE;
    for (let index = 0; index < ID.ACOLYTES.length; index++) {
      syncTracked(player, `acolyte-${index}`, trial3
        ? { id: ID.ACOLYTES[index], ...ACOLYTE_TILES[index], wanderRadius: 0 }
        : null);
    }

    syncTracked(player, "vulcan", stage >= STAGE.RUINS_ENTERED && stage < STAGE.BLOCKAGE_CLEARED
      ? { id: ID.VULCAN, ...VULCAN_TILE, wanderRadius: 0 }
      : null);

    syncTracked(player, "amox", stage >= STAGE.DOOR_OPEN && stage < STAGE.BANISHED
      ? { id: ID.AMOX, ...AMOX_TILE, wanderRadius: 0 }
      : null);

    if (stage >= STAGE.BANISHED) pendingServiusReport.add(player);

    if (stage === STAGE.TRIAL2_FIGHT && !hasWaves(player)) spawnWaves(player);
    if (stage === STAGE.TRIAL4_FIGHT && !trackedNpcs.get(player)?.get("itzla-fight")?.isRegistered?.()) {
      spawnItzlaFight(player);
    }
    placePuzzleObjects();
  }

  // ==========================================================================
  // World object swaps and quest-only objects
  // ==========================================================================

  function swapPubBed() {
    if (bedSwapped) return;
    bedSwapped = true;
    RegionManager.loadMapFiles(PUB_BED_TILE.x, PUB_BED_TILE.y);
    const objects = MapObjects.mapObjects.get(MapObjects.getHash(PUB_BED_TILE.x, PUB_BED_TILE.y, PUB_BED_TILE.z)) ?? [];
    for (const object of [...objects]) {
      if (object.getId() !== ID.BED_BASE) continue;
      ObjectManager.deregister(object, true);
      ObjectManager.register(
        new GameObject(ID.BED_REST, new Location(PUB_BED_TILE.x, PUB_BED_TILE.y, PUB_BED_TILE.z),
          object.getType?.() ?? 10, object.getFace?.() ?? 0, null),
        true
      );
    }
  }

  function moveScrapChest() {
    if (chestMoved) return;
    chestMoved = true;
    RegionManager.loadMapFiles(SCRAP_CHEST_TILE.x, SCRAP_CHEST_TILE.y);
    const objects = MapObjects.mapObjects.get(MapObjects.getHash(SCRAP_CHEST_TILE.x, SCRAP_CHEST_TILE.y, SCRAP_CHEST_TILE.z)) ?? [];
    for (const object of [...objects]) {
      if (object.getId() !== ID.CHEST_SCRAP) continue;
      ObjectManager.deregister(object, true);
      ObjectManager.register(
        new GameObject(ID.CHEST_SCRAP,
          new Location(SCRAP_CHEST_OPEN_TILE.x, SCRAP_CHEST_OPEN_TILE.y, SCRAP_CHEST_OPEN_TILE.z),
          object.getType?.() ?? 10, object.getFace?.() ?? 0, null),
        true
      );
    }
  }

  function swapStatues() {
    if (statuesSwapped) return;
    statuesSwapped = true;
    for (const swap of STATUE_SWAPS) {
      RegionManager.loadMapFiles(swap.x, swap.y);
      const objects = MapObjects.mapObjects.get(MapObjects.getHash(swap.x, swap.y, 0)) ?? [];
      for (const object of [...objects]) {
        if (object.getId() !== swap.baseId) continue;
        ObjectManager.deregister(object, true);
        ObjectManager.register(
          new GameObject(swap.touchId, new Location(swap.x, swap.y, 0), object.getType?.() ?? 10, object.getFace?.() ?? 0, null),
          true
        );
      }
    }
  }

  function placePuzzleObjects() {
    if (objectsPlaced) return;
    objectsPlaced = true;
    ObjectManager.register(new GameObject(ID.ROCKS, new Location(ROCKS_TILE.x, ROCKS_TILE.y, ROCKS_TILE.z), 10, 0, null), true);
    ObjectManager.register(new GameObject(ID.FROZEN_DOOR, new Location(DOOR_TILE.x, DOOR_TILE.y, DOOR_TILE.z), 0, 1, null), true);
    moveScrapChest();
  }

  function removeFrozenDoor() {
    const objects = MapObjects.mapObjects.get(MapObjects.getHash(DOOR_TILE.x, DOOR_TILE.y, DOOR_TILE.z)) ?? [];
    for (const object of [...objects]) {
      if (object.getId() !== ID.FROZEN_DOOR) continue;
      ObjectManager.deregister(object, true);
    }
  }

  // ==========================================================================
  // Variant selection for the statically spawned quest NPCs
  // ==========================================================================

  function selectVariant({ npcId, player }) {
    if (!player || !npcId) return null;
    if (quest.isComplete(player)) return null;
    if (npcId === ID.BARTENDER) return selectBartenderVariant(player);
    if (npcId === ID.SHOPKEEPER) return selectShopkeeperVariant(player);
    if (ID.RECRUITS.has(npcId)) return selectRecruitVariant(npcId, player);
    if (npcId === ID.FIDES) return selectFidesVariant(player);
    return null;
  }

  function selectBartenderVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE.QUEEN_DONE || stage >= STAGE.AT_TOWER) return null;
    return V.BARTENDER;
  }

  function selectShopkeeperVariant(player) {
    const stage = quest.getStage(player);
    if (stage === STAGE.AT_PUB) return V.SHOP;
    if (stage === STAGE.SHOP_AGREED) return V.SHOP_AGAIN;
    return null;
  }

  function selectRecruitVariant(npcId, player) {
    const stage = quest.getStage(player);
    if (stage < STAGE.MINGLED || stage > STAGE.RECRUITED_INFO) return null;
    if (npcId === ID.NOVA || npcId === ID.NOVA_2) {
      setFlag(player, FLAG_AUGUR);
      return V.NOVA;
    }
    if (npcId === ID.CARITTA) return V.CARITTA;
    if (npcId === ID.FELIUS) return V.FELIUS;
    if (npcId === ID.SERGIUS || npcId === ID.SERGIUS_2) return V.SERGIUS;
    return null;
  }

  function selectFidesVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE.INITIATED) return null;
    if (stage === STAGE.INITIATED) {
      ID.FIDES_TALKED.add(player);
      advance(player, STAGE.DUTIES);
      return V.FIDES;
    }
    return V.FIDES_AGAIN;
  }

  // ==========================================================================
  // Prose conditions
  // ==========================================================================

  function traitorIndex(player) {
    return Number(player.getAttribute(TRAITOR_ATTRIBUTE)) || 0;
  }

  function accusedIndex(player) {
    const value = player.getAttribute(ACCUSED_ATTRIBUTE);
    if (value === null || value === undefined) return -1;
    const index = Number(value);
    return Number.isFinite(index) ? index : -1;
  }

  /** The 8 traitor knowledge conditions per member (question text -> traitor answer). */
  function answerCondition(event) {
    const { player, stepId } = event;
    if (!player || !stepId) return null;
    switch (stepId) {
      case C.REQS_NO:
        return !meetsRequirements(player);
      case C.REQS_YES:
        return meetsRequirements(player);
      case C.BARTENDER_FIRST:
        return !hasFlag(player, FLAG_RENTED);
      case C.BARTENDER_AGAIN:
        return hasFlag(player, FLAG_RENTED);
      case C.BARTENDER_POOR:
        return !held(player, ID.COINS, 30);
      case C.PICKPOCKET_AGAIN:
        return held(player, ID.TOWER_KEY);
      case C.CHEST_AGAIN:
        return held(player, ID.BOOK);
      case C.POEM_OK:
        return held(player, ID.BOOK);
      case C.POEM_BAD:
        return !held(player, ID.BOOK);
      case C.ITZLA_NO_KEY:
        return !held(player, ID.TOWER_KEY);
      case C.ITZLA_KEY:
        return held(player, ID.TOWER_KEY) && !held(player, ID.BOOK);
      case C.ITZLA_BOOK:
        return held(player, ID.BOOK) && !held(player, ID.POEM);
      case C.SCRAP_CHEST:
        return scrapChestPending.has(player);
      case C.COMBO_WRONG:
        return isComboComplete(player) && !isComboCorrect(player);
      case C.COMBO_RIGHT:
        return isComboCorrect(player);
      case C.NO_BANDAGE:
        return !held(player, ID.BANDAGES);
      case C.BANDAGE:
        return held(player, ID.BANDAGES);
      case C.WAVES_DEAD:
        return quest.getStage(player) >= STAGE.TRIAL2_DONE;
      case C.JANUS_DURING_TRIAL:
        return true;
      case C.NO_SCRAPS:
        return !hasAnyScrap(player) && !held(player, ID.NOTE);
      case C.TWO_SCRAPS:
        return held(player, ID.SCRAP_1) && held(player, ID.SCRAP_2) && !held(player, ID.NOTE);
      case C.ACCUSED_INNOCENT:
        return accusedIndex(player) !== traitorIndex(player);
      case C.ACCUSED_TRAITOR:
        return accusedIndex(player) === traitorIndex(player);
      case C.FOLLOWED_A:
      case C.FOLLOWED_B:
      case C.FOLLOWED_C:
      case C.FOLLOWED_D:
        return true;
      case C.NOT_FOLLOWED_A:
      case C.NOT_FOLLOWED_B:
      case C.NOT_FOLLOWED_C:
      case C.NOT_FOLLOWED_D:
        return false;
      case C.HOLDING_ICON:
      case C.WATER_STATUE:
      case C.EARTH_STATUE:
      case C.FIRE_STATUE:
        return false;
      case C.NO_ICON:
        return true;
      case C.PERILOUS_NO:
        return !isQuestComplete(player, PERILOUS_MOONS_KEY);
      case C.PERILOUS_YES:
        return isQuestComplete(player, PERILOUS_MOONS_KEY);
      case "DFyb_t":
      case "rgz6SK":
        return traitorIndex(player) !== 0;
      case "eXupGb":
      case "-Kj4rx":
        return traitorIndex(player) === 0;
      case "LX4ceH":
      case "W981Jm":
        return traitorIndex(player) !== 1;
      case "rTbiB-":
      case "eHBR0T":
        return traitorIndex(player) === 1;
      case "gA4fIP":
      case "V9XCM3":
        return traitorIndex(player) !== 2;
      case "xfk_Av":
      case "JQsjvj":
        return traitorIndex(player) === 2;
      case "ahMG0V":
      case "Rp_XWa":
        return traitorIndex(player) !== 3;
      case "BoafeO":
      case "F-P-z3":
        return traitorIndex(player) === 3;
      default:
        return null;
    }
  }

  function comboPicksFor(player) {
    return comboPicks.get(player) ?? [];
  }

  function isComboComplete(player) {
    return comboPicksFor(player).length >= 3;
  }

  function isComboCorrect(player) {
    const picks = comboPicksFor(player);
    return picks.length >= 3 && COMBO_CORRECT.every((word, index) => picks[index] === word);
  }

  function recordComboChoice(player, option) {
    const word = String(option ?? "").replace(/\.$/, "");
    if (COMBO_STEP_1.has(word)) {
      comboPicks.set(player, [word]);
      return;
    }
    const picks = comboPicksFor(player);
    if (!picks.length) return;
    if (COMBO_STEP_2.has(word) && picks.length === 1) picks.push(word);
    else if (COMBO_STEP_3.has(word) && picks.length === 2) picks.push(word);
  }

  /** The steps of a nested transcript condition (searched through steps and options). */
  function findConditionSteps(steps, stepId) {
    for (const step of steps ?? []) {
      if (step.type === "condition" && step.id === stepId) return step.steps ?? [];
      const nested = findConditionSteps(step.steps, stepId)
        ?? (step.options ?? []).map((option) => findConditionSteps(option.steps, stepId)).find(Boolean);
      if (nested) return nested;
    }
    return null;
  }

  /** The first choice step with an option from `words` (searched recursively). */
  function findChoice(steps, words) {
    const hasWord = (option) => words.has(String(option?.text ?? "").replace(/\.$/, ""));
    for (const step of steps ?? []) {
      if (step.type === "choice" && (step.options ?? []).some(hasWord)) return step;
      const nested = findChoice(step.steps, words)
        ?? (step.options ?? []).map((option) => findChoice(option.steps, words)).find(Boolean);
      if (nested) return nested;
    }
    return null;
  }

  /**
   * Repairs the passphrase menu the transcript dump mangled: only "Kualt." carries
   * a second menu and only "Huka." a third, so the right "Chua Chaki Iknil" combo
   * can never be picked. Rebuilds every word option with the full ladder and hangs
   * the right-combo branch (buried inside the wrong-combo condition) off every
   * third word, so its condition resolves when the third correct word is chosen.
   */
  function withComboMenus(steps) {
    const top = findChoice(steps, COMBO_STEP_1);
    const second = findChoice(steps, COMBO_STEP_2);
    const third = findChoice(steps, COMBO_STEP_3);
    const right = findConditionSteps(steps, C.COMBO_RIGHT);
    if (!top || !second || !third || !right?.length) return steps;
    const thirdStep = {
      ...third,
      options: (third.options ?? []).map((option) => ({
        ...option,
        steps: [{ type: "condition", id: C.COMBO_RIGHT, steps: right }],
      })),
    };
    const secondStep = {
      ...second,
      options: (second.options ?? []).map((option) => ({
        ...option,
        steps: [{ ...thirdStep }],
      })),
    };
    const rebuilt = {
      ...top,
      options: (top.options ?? []).map((option) => ({
        ...option,
        steps: [{ ...secondStep }],
      })),
    };
    return steps.map((step) => (step === top ? rebuilt : step));
  }

  // ==========================================================================
  // Dialogue hooks / actions / choices / condition events
  // ==========================================================================

  function handleDialogueHook(event) {
    const { player, npcId, hook } = event;
    if (hook !== START_HOOK || npcId !== ID.ITZLA || !player) return;
    if (quest.getStage(player) !== 0) return;
    if (!meetsRequirements(player)) return;
    player.setAttribute(FLAGS_ATTRIBUTE, 0);
    player.setAttribute(TRAITOR_ATTRIBUTE, Math.floor(Math.random() * 4));
    comboPicks.set(player, []);
    advance(player, STAGE.STARTED);
  }

  function handleDialogueAction(event) {
    const { player, stepId } = event;
    if (!player || !stepId) return;
    switch (stepId) {
      case A.PAY:
        if (held(player, ID.COINS, 30)) {
          player.getInventory().deleteNumber(ID.COINS, 30);
          setFlag(player, FLAG_RENTED);
          swapPubBed();
        }
        return;
      case A.KEY:
        if (!held(player, ID.TOWER_KEY) && !inventoryFull(player)) player.getInventory().adds(ID.TOWER_KEY, 1);
        if (quest.getStage(player) === STAGE.TRIAL1_KEY) advance(player, STAGE.TRIAL1_BOOK);
        return;
      case A.RECEIVE_BOOK:
        if (!held(player, ID.BOOK)) giveItem(player, ID.BOOK);
        if (!held(player, ID.SCRAP_1)) giveItem(player, ID.SCRAP_1);
        advance(player, STAGE.TRIAL1_POEM);
        event.handled = true;
        return;
      case A.RECEIVE_POEM:
        if (!held(player, ID.POEM)) giveItem(player, ID.POEM);
        if (!held(player, ID.SCRAP_2)) giveItem(player, ID.SCRAP_2);
        advance(player, STAGE.TRIAL1_SCRAP3);
        event.handled = true;
        return;
      case A.RECEIVE_SCRAP3:
        if (!held(player, ID.SCRAP_3)) giveItem(player, ID.SCRAP_3);
        event.handled = true;
        return;
      case A.RECEIVE_NOTE:
        for (const scrap of ID.SCRAPS) if (held(player, scrap)) player.getInventory().deleteNumber(scrap, 1);
        if (!held(player, ID.NOTE)) giveItem(player, ID.NOTE);
        advance(player, STAGE.TRIAL1_NOTE);
        event.handled = true;
        return;
      case A.ROBES:
      case A.ROBES_RECLAIM:
        for (const itemId of ID.ROBES) if (!held(player, itemId)) giveItem(player, itemId);
        advance(player, STAGE.ROBED);
        return;
      case A.NAGUA_APPEAR:
        spawnNagua(player);
        event.handled = true;
        return;
      case A.VULCAN_DIES:
        removeTracked(player, "vulcan");
        event.handled = true;
        return;
      case A.BANISH:
        player.moveTo(new Location(BANISH_TILE.x, BANISH_TILE.y, BANISH_TILE.z));
        advance(player, STAGE.BANISHED);
        event.handled = true;
        return;
      default:
        return;
    }
  }

  function handleDialogueConditionEvent(event) {
    const { player, stepId } = event;
    if (!player || !stepId) return;
    if (stepId === C.COMBO_RIGHT) {
      comboPicks.set(player, []);
      advance(player, STAGE.TRIAL1_DONE);
      return;
    }
    if (stepId === C.COMBO_WRONG) {
      comboPicks.set(player, []);
      return;
    }
    if (stepId === C.ACCUSED_TRAITOR) {
      const index = traitorIndex(player);
      removeTracked(player, `acolyte-${index}`);
      for (let slot = 0; slot < ID.ACOLYTES.length; slot++) removeTracked(player, `acolyte-${slot}`);
      advance(player, STAGE.TRIAL3_DONE);
      return;
    }
  }

  function handleDialogueChoice(event) {
    const { player, npcId, option } = event;
    if (!player) return;
    const stage = quest.getStage(player);
    if (option === "I hear you can offer help to those in need." && npcId === ID.SHOPKEEPER) {
      if (stage === STAGE.AT_PUB) advance(player, STAGE.SHOP_AGREED);
      return;
    }
    if (npcId === ID.JANUS) {
      if (option === "Yes! I'm ready." && stage === STAGE.TRIAL2_READY) {
        spawnWaves(player);
        advance(player, STAGE.TRIAL2_FIGHT);
        return;
      }
      if (option === "Yes." && stage === STAGE.TRIAL1_DONE) {
        advance(player, STAGE.TRIAL2_READY);
        return;
      }
      if (option === "Yes." && stage === STAGE.TRIAL3_READY) {
        advance(player, STAGE.TRIAL3_ACTIVE);
        return;
      }
      if (option === "Yes." && stage === STAGE.TRIAL4_READY) {
        spawnItzlaFight(player);
        advance(player, STAGE.TRIAL4_FIGHT);
        return;
      }
      recordComboChoice(player, option);
      if (isComboComplete(player) && !isComboCorrect(player)) comboPicks.set(player, []);
      return;
    }
    if ((option === "Yes." || option === "No.") && npcId === ID.SERVIUS && stage === STAGE.BANISHED) {
      quest.complete(player);
      pendingServiusReport.delete(player);
    }
  }

  /** True while a dialogue or multi-option prompt owns the chatbox. */
  function chatboxOpen(player) {
    return player.getDialogueManager?.()?.isActive?.() === true
      || pluginApi.core.MultiChatboxPrompt?.getPending?.(player) != null;
  }

  /**
   * The two Perilous Moons conditional branches in the Servius report end with the
   * dump's `end` marker, which closes the chatbox before the Final Dawn Yes./No.
   * choice; the auto-played report would then restart from the top forever. Drop
   * those branch terminators so the transcript flows on to the choice.
   */
  function withoutBranchEnds(steps) {
    const strip = (list) => (list ?? [])
      .filter((step) => step?.type !== "end")
      .map((step) => {
        const copy = { ...step };
        if (Array.isArray(step.steps)) copy.steps = strip(step.steps);
        if (Array.isArray(step.options)) {
          copy.options = step.options.map((option) => ({ ...option, steps: strip(option.steps) }));
        }
        return copy;
      });
    return strip(steps);
  }

  /**
   * The shared Servius (12652) is owned by The Final Dawn's Talk-to hook, so the
   * completion report is auto-played once the chatbox is clear and retried if dismissed.
   */
  function handlePlayerProcess({ player }) {
    if (!player || player.isPlayerBot?.() === true) return;
    if (!pendingServiusReport.has(player)) return;
    if (quest.isComplete(player) || quest.getStage(player) < STAGE.BANISHED) {
      pendingServiusReport.delete(player);
      return;
    }
    if (chatboxOpen(player)) return;
    startTranscript(pluginApi, player, ID.SERVIUS, PAGE, V.SERVIUS, withoutBranchEnds);
  }

  /** Arms the report the moment the quest reaches BANISHED, whatever set the stage. */
  function handleStageChanged({ player, key, stage }) {
    if (!player || player.isPlayerBot?.() === true || key !== QUEST_KEY) return;
    if (stage >= STAGE.COMPLETE) pendingServiusReport.delete(player);
    else if (stage >= STAGE.BANISHED) pendingServiusReport.add(player);
  }

  // ==========================================================================
  // NPC talk routing for the quest's own spawns
  // ==========================================================================

  function handleNpcTalk(event) {
    const { player, npcId } = event;
    if (!player || !npcId) return;
    const action = event.definition?.getActions?.()[event.clickType - 1];
    const clickType = event.clickType;
    if (npcId === ID.AMOX && clickType === 2) {
      if (quest.getStage(player) === STAGE.DOOR_OPEN && !amoxTalked.has(player)) {
        amoxTalked.add(player);
        playTranscript(player, ID.AMOX, V.AMOX);
      }
      return;
    }
    if (action !== "Talk-to") return;
    if (!ID.OWN_TALK.has(npcId)) return;
    if (event.npc?.getOwner?.() !== player) return;
    if (npcId === ID.ITZLA) itzlaTalk(player);
    else if (npcId === ID.ITZLA_LOBBY) playTranscript(player, npcId, V.ITZLA_LOBBY);
    else if (npcId === ID.JANUS) janusTalk(player);
    else if (npcId === ID.VULCAN) playTranscript(player, npcId, V.VULCAN);
    else if (ID.ASCENDED.includes(npcId)) ascendedTalk(player, npcId);
    else if (ID.ACOLYTES.includes(npcId)) memberTalk(player, npcId);
    event.handled = true;
  }

  function itzlaTalk(player) {
    const stage = quest.getStage(player);
    if (stage === 0) return playTranscript(player, ID.ITZLA, V.START);
    if (stage === STAGE.STARTED) {
      playTranscript(player, ID.ITZLA, V.QUEEN);
      advance(player, STAGE.QUEEN_DONE);
      return;
    }
    if (stage === STAGE.QUEEN_DONE) {
      if (!hasFlag(player, FLAG_PUB_TOLD)) {
        setFlag(player, FLAG_PUB_TOLD);
        playTranscript(player, ID.ITZLA, V.AFTER_MEETING);
      } else {
        playTranscript(player, ID.ITZLA, V.AFTER_MEETING_AGAIN);
      }
      return;
    }
    if (stage < STAGE.AT_TOWER) {
      if (stage === STAGE.SHOP_AGREED) {
        playTranscript(player, ID.ITZLA, V.REPORT);
        advance(player, STAGE.AT_TOWER);
        return;
      }
      return playTranscript(player, ID.ITZLA, V.PUB_ITZLA);
    }
    if (stage < STAGE.MINGLED) {
      playTranscript(player, ID.ITZLA, V.TOWER);
      advance(player, STAGE.MINGLED);
      return;
    }
    if (stage === STAGE.MINGLED) {
      if (hasFlag(player, FLAG_AUGUR)) {
        playTranscript(player, ID.ITZLA, V.REPORT_AUGUR);
        advance(player, STAGE.RECRUITED_INFO);
      } else {
        playTranscript(player, ID.ITZLA, V.TOWER_AGAIN);
      }
      return;
    }
    if (stage < STAGE.TRIAL1_KEY) return playTranscript(player, ID.ITZLA, V.TOWER_AGAIN);
    if (stage < STAGE.TRIAL1_DONE) {
      if (held(player, ID.NOTE)) {
        playTranscript(player, ID.ITZLA, V.ITZLA_NOTE);
      } else if (held(player, ID.BOOK)) {
        playTranscript(player, ID.ITZLA, V.ITZLA_POEM);
      } else {
        playTranscript(player, ID.ITZLA, V.ITZLA_POEM_PRE);
      }
      return;
    }
    if (stage < STAGE.TRIAL2_DONE) return playTranscript(player, ID.ITZLA, V.ITZLA_T2);
    if (stage < STAGE.TRIAL3_ACTIVE) return playTranscript(player, ID.ITZLA, V.ITZLA_T2_AFTER);
    if (stage < STAGE.TRIAL4_READY) return playTranscript(player, ID.ITZLA, V.T3_ITZLA);
    if (stage < STAGE.TRIAL4_FIGHT) return playTranscript(player, ID.ITZLA, V.T3_ITZLA_EXEC);
    if (stage < STAGE.LOBBY) return playTranscript(player, ID.ITZLA, V.ITZLA_LOBBY);
    if (stage < STAGE.ROBES) return playTranscript(player, ID.ITZLA, V.ITZLA_AFTER_JANUS);
    if (stage < STAGE.INITIATED) return playTranscript(player, ID.ITZLA, V.ITZLA_ROBES);
    if (stage === STAGE.INITIATED) return playTranscript(player, ID.ITZLA, V.ITZLA_AFTER_INIT);
    if (stage === STAGE.DUTIES) {
      return playTranscript(player, ID.ITZLA, ID.FIDES_TALKED.has(player) ? V.ITZLA_FIDES_AFTER : V.ITZLA_BEFORE_FIDES);
    }
    if (stage < STAGE.BLOCKAGE_CLEARED) return undefined;
    if (stage === STAGE.BLOCKAGE_CLEARED) {
      playTranscript(player, ID.ITZLA, V.ITZLA_DOOR);
      advance(player, STAGE.DOOR_MET);
      return;
    }
    if (stage === STAGE.DOOR_MET) {
      playTranscript(player, ID.ITZLA, V.ITZLA_WORDS);
      advance(player, STAGE.PUZZLE);
      swapStatues();
      return;
    }
    if (stage < STAGE.DOOR_OPEN) return playTranscript(player, ID.ITZLA, V.ITZLA_WORDS);
    return undefined;
  }

  function janusTalk(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE.RECRUITED_INFO && stage < STAGE.TRIAL1_KEY) {
      playTranscript(player, ID.JANUS, V.JANUS_INTRO);
      advance(player, STAGE.TRIAL1_KEY);
      return;
    }
    if (stage < STAGE.TRIAL1_NOTE) return playTranscript(player, ID.JANUS, V.JANUS_FIRST);
    if (stage < STAGE.TRIAL1_DONE) return playTranscript(player, ID.JANUS, V.JANUS_NOTE, withComboMenus);
    if (stage === STAGE.TRIAL1_DONE) return playTranscript(player, ID.JANUS, V.JANUS_AFTER_T1);
    if (stage < STAGE.TRIAL2_DONE) return playTranscript(player, ID.JANUS, V.TRIAL2);
    if (stage === STAGE.TRIAL2_DONE) {
      playTranscript(player, ID.JANUS, V.T2_AFTER);
      advance(player, STAGE.TRIAL3_READY);
      return;
    }
    if (stage === STAGE.TRIAL3_READY || stage === STAGE.TRIAL3_ACTIVE) {
      return playTranscript(player, ID.JANUS, V.TRIAL3);
    }
    if (stage === STAGE.TRIAL4_READY) return playTranscript(player, ID.JANUS, V.TRIAL4);
    if (stage === STAGE.TRIAL4_FIGHT) return playTranscript(player, ID.JANUS, V.JANUS_LOBBY_AGAIN);
    if (stage === STAGE.TRIAL4_DONE) {
      playTranscript(player, ID.JANUS, V.JANUS_AFTER_T4);
      advance(player, STAGE.LOBBY);
      return;
    }
    if (stage < STAGE.ROBES) {
      playTranscript(player, ID.JANUS, V.JANUS_LOBBY);
      advance(player, STAGE.ROBES);
      return;
    }
    return playTranscript(player, ID.JANUS, hasRobes(player) ? V.JANUS_ROBES : V.JANUS_LOBBY_AGAIN);
  }

  function ascendedTalk(player, npcId) {
    const stage = quest.getStage(player);
    if (stage >= STAGE.TRIAL1_DONE) return playTranscript(player, npcId, V.EMISSARY_AFTER);
    if (held(player, ID.TOWER_KEY)) return playTranscript(player, npcId, V.EMISSARY_BEFORE);
    playTranscript(player, npcId, V.PICKPOCKET);
  }

  function memberTalk(player, npcId) {
    if (npcId === ID.TENOCH) return playTranscript(player, npcId, V.TENOCH);
    if (npcId === ID.SILIA) return playTranscript(player, npcId, V.SILIA);
    if (npcId === ID.ADRIUS) return playTranscript(player, npcId, V.ADRIUS);
    return playTranscript(player, npcId, V.ELEUIA);
  }

  function accuse(player, index) {
    if (quest.getStage(player) !== STAGE.TRIAL3_ACTIVE) return false;
    player.setAttribute(ACCUSED_ATTRIBUTE, index);
    playTranscript(player, ID.JANUS, V.CHOOSE);
    return true;
  }

  function chooseTenoch({ player }) {
    return accuse(player, 0);
  }

  function chooseSilia({ player }) {
    return accuse(player, 1);
  }

  function chooseAdrius({ player }) {
    return accuse(player, 2);
  }

  function chooseEleuia({ player }) {
    return accuse(player, 3);
  }

  // ==========================================================================
  // Combat spawns
  // ==========================================================================

  function spawnNpcAt(player, key, id, x, y, z) {
    const tracked = trackedNpcs.get(player) ?? new Map();
    trackedNpcs.set(player, tracked);
    const npc = pluginApi.spawnNpc({ id, x, y, z, wanderRadius: 0, owner: player, ownerOnly: true });
    if (npc) tracked.set(key, npc);
    return npc;
  }

  function spawnWaves(player) {
    removeWaves(player);
    const here = player.getLocation();
    const list = [];
    for (let index = 0; index < TRIAL2_OFFSETS.length; index++) {
      const id = index % 2 === 0 ? ID.BRAWLER : ID.CONJURER;
      const [dx, dy] = TRIAL2_OFFSETS[index];
      const npc = spawnNpcAt(player, `wave-${index}`, id, here.getX() + dx, here.getY() + dy, here.getZ());
      if (npc) list.push(npc);
    }
    waveNpcs.set(player, list);
  }

  function removeWaves(player) {
    const list = waveNpcs.get(player);
    if (Array.isArray(list)) for (const npc of list) if (npc?.isRegistered?.()) pluginApi.removeNpc(npc);
    waveNpcs.delete(player);
    const tracked = trackedNpcs.get(player);
    if (tracked) {
      for (const key of [...tracked.keys()]) if (key.startsWith("wave-")) removeTracked(player, key);
    }
  }

  function hasWaves(player) {
    const list = waveNpcs.get(player);
    return Array.isArray(list) && list.some((npc) => npc?.isRegistered?.());
  }

  function removeWave(player, npc) {
    const list = waveNpcs.get(player);
    if (!Array.isArray(list)) return;
    const index = list.indexOf(npc);
    if (index >= 0) list.splice(index, 1);
    const tracked = trackedNpcs.get(player);
    if (tracked) {
      for (const [key, value] of [...tracked.entries()]) {
        if (value === npc) tracked.delete(key);
      }
    }
  }

  function spawnItzlaFight(player) {
    const here = player.getLocation();
    spawnNpcAt(player, "itzla-fight", ID.ITZLA_FIGHT, here.getX() + 1, here.getY(), here.getZ());
  }

  function spawnNagua(player) {
    const here = player.getLocation();
    spawnNpcAt(player, "nagua-1", ID.NAGUA, here.getX() + 1, here.getY(), here.getZ());
    spawnNpcAt(player, "nagua-2", ID.NAGUA, here.getX() - 1, here.getY(), here.getZ());
  }

  function handleNpcDeath(event) {
    const killer = event?.killer?.isPlayer?.() ? event.killer : null;
    if (!killer || !event.npc) return;
    const owner = event.npc.getOwner?.();
    if (owner && owner !== killer) return;

    const list = waveNpcs.get(killer);
    if (Array.isArray(list) && list.includes(event.npc)) {
      removeWave(killer, event.npc);
      if (!hasWaves(killer) && quest.getStage(killer) === STAGE.TRIAL2_FIGHT) {
        advance(killer, STAGE.TRIAL2_DONE);
      }
      return;
    }

    if (event.npcId === ID.ITZLA_FIGHT && quest.getStage(killer) === STAGE.TRIAL4_FIGHT) {
      removeTracked(killer, "itzla-fight");
      advance(killer, STAGE.TRIAL4_DONE);
      playTranscript(killer, ID.ITZLA_FIGHT, V.T4_ITZLA_FINAL);
      return;
    }

    if (event.npcId === ID.AMOX) {
      const stage = quest.getStage(killer);
      if (stage === STAGE.DOOR_OPEN) {
        removeTracked(killer, "amox");
        advance(killer, STAGE.AMOX_DEFEATED);
        playTranscript(killer, ID.AMOX, V.AMOX_DONE);
      } else if (stage === STAGE.AMOX_DEFEATED) {
        playTranscript(killer, ID.AMOX, V.AMOX_DONE);
      }
    }
  }

  // ==========================================================================
  // Object interactions
  // ==========================================================================

  function isAt(location, tile) {
    return location && location.x === tile.x && location.y === tile.y;
  }

  function handleObjectInteraction(event) {
    const { player, objectId } = event;
    if (!player || !objectId) return;
    const location = event.location;
    const stage = quest.getStage(player);

    if (objectId === ID.BED_REST && isAt(location, PUB_BED_TILE)) {
      event.handled = true;
      if (stage !== STAGE.QUEEN_DONE && stage !== STAGE.AT_PUB) return;
      if (stage === STAGE.QUEEN_DONE) advance(player, STAGE.AT_PUB);
      playTranscript(player, ID.ITZLA, V.BED);
      return;
    }

    if (objectId === ID.BARREL && isAt(location, { x: 1696, y: 9633 })) {
      event.handled = true;
      if (stage < STAGE.RUINS_ENTERED) return;
      if (!held(player, ID.PICKAXE)) giveItem(player, ID.PICKAXE);
      return;
    }

    if (objectId === ID.ROCKS && isAt(location, ROCKS_TILE)) {
      event.handled = true;
      if (stage !== STAGE.RUINS_ENTERED) return;
      if (!held(player, ID.PICKAXE) || player.getSkillManager().getMaxLevel(Skill.MINING) < 55) {
        playTranscript(player, ID.VULCAN, V.VULCAN);
        return;
      }
      playTranscript(player, ID.VULCAN, V.ROCKS);
      advance(player, STAGE.BLOCKAGE_CLEARED);
      return;
    }

    if (objectId === ID.FROZEN_DOOR && isAt(location, DOOR_TILE)) {
      event.handled = true;
      if (stage < STAGE.DOOR_OPEN) playTranscript(player, ID.ITZLA, V.DOOR_FROZEN);
      return;
    }

    if (TOUCH_ORDER.includes(objectId) && STATUE_SWAPS.some((swap) => isAt(location, swap))) {
      event.handled = true;
      touchStatue(player, objectId);
      return;
    }

    if (ID.TOWER_CHESTS.has(objectId) && location && location.z === 1) {
      event.handled = true;
      openTrialChest(player, objectId);
      return;
    }

    if (objectId === ID.ROBES_CHEST && isAt(location, { x: 1638, y: 3217 })) {
      event.handled = true;
      openRobesChest(player);
    }
  }

  function touchStatue(player, objectId) {
    if (quest.getStage(player) !== STAGE.PUZZLE) return;
    const progress = Number(player.getAttribute(STATUE_ATTRIBUTE)) || 0;
    if (TOUCH_ORDER[progress] !== objectId) {
      player.setAttribute(STATUE_ATTRIBUTE, 0);
      player.setHitpoints(Math.max(1, player.getHitpoints() - 5));
      return;
    }
    const next = progress + 1;
    player.setAttribute(STATUE_ATTRIBUTE, next);
    if (next < TOUCH_ORDER.length) return;
    removeFrozenDoor();
    advance(player, STAGE.DOOR_OPEN);
    playTranscript(player, ID.ITZLA, V.DOOR_OPEN);
  }

  function openTrialChest(player, objectId) {
    const stage = quest.getStage(player);
    if (stage >= STAGE.TRIAL1_DONE) {
      playTranscript(player, ID.JANUS, V.JANUS_CHEST);
      return;
    }
    if (!held(player, ID.TOWER_KEY)) {
      playTranscript(player, ID.JANUS, V.JANUS_CHEST);
      return;
    }
    if (objectId === ID.CHEST_BOOK && stage >= STAGE.TRIAL1_BOOK && !held(player, ID.BOOK)) {
      if (inventoryFull(player)) return player.sendMessage("You need more inventory space.");
      playTranscript(player, ID.ASCENDED[0], V.GATE_CHEST);
      return;
    }
    if (objectId === ID.CHEST_POEM && held(player, ID.BOOK) && !held(player, ID.POEM)) {
      if (inventoryFull(player)) return player.sendMessage("You need more inventory space.");
      playTranscript(player, ID.ASCENDED[0], V.POEM_CHEST);
      return;
    }
    if (objectId === ID.CHEST_SCRAP && held(player, ID.POEM) && !held(player, ID.NOTE)) {
      if (inventoryFull(player)) return player.sendMessage("You need more inventory space.");
      scrapChestPending.add(player);
      playTranscript(player, ID.ASCENDED[0], V.ITZLA_POEM, (steps) =>
        steps.filter((step) => step?.type === "condition" && step?.id === C.SCRAP_CHEST)
      );
      scrapChestPending.delete(player);
      return;
    }
    playTranscript(player, ID.ASCENDED[0], V.GATE_CHEST);
  }

  function openRobesChest(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE.ROBES) {
      playTranscript(player, ID.JANUS, V.JANUS_CHEST);
      return;
    }
    if (hasRobes(player)) {
      playTranscript(player, ID.ITZLA, V.CHEST_ROBED);
      return;
    }
    if (inventoryFull(player)) {
      playTranscript(player, ID.ITZLA, V.CHEST_FULL);
      return;
    }
    if (ID.ROBES.some((itemId) => held(player, itemId))) {
      playTranscript(player, ID.ITZLA, V.CHEST_RECLAIM);
      return;
    }
    playTranscript(player, ID.ITZLA, V.CHEST);
  }

  // ==========================================================================
  // Zones
  // ==========================================================================

  function handleRuinsZoneEnter({ player }) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = quest.getStage(player);
    if (stage !== STAGE.DUTIES) return;
    advance(player, STAGE.RUINS_ENTERED);
    playTranscript(player, ID.ITZLA, V.RUINS);
  }

  function handleTempleZoneEnter({ player }) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = quest.getStage(player);
    if (stage !== STAGE.ROBED) return;
    if (!wearingRobes(player)) {
      playTranscript(player, ID.ASCENDED[0], V.NO_ROBES);
      player.moveTo(new Location(TEMPLE_LEAVE_TILE.x, TEMPLE_LEAVE_TILE.y, TEMPLE_LEAVE_TILE.z));
      return;
    }
    playTranscript(player, ID.FIDES, V.INITIATION);
    advance(player, STAGE.INITIATED);
  }

  // ==========================================================================
  // Login / logout
  // ==========================================================================

  function handleLogin({ player }) {
    if (!player || player.isPlayerBot?.() === true) return;
    ensureQuestNpcs(player);
    runtime.refreshQuestList(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    removeAllTracked(player);
    waveNpcs.delete(player);
    comboPicks.delete(player);
    scrapChestPending.delete(player);
    amoxTalked.delete(player);
    pendingServiusReport.delete(player);
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE.COMPLETE) {
      return [
        "<str>Itzla and I infiltrated the Twilight Emissaries and passed the</str>",
        "<str>trials of the Tower of Ascension.</str>",
        "<str>At the initiation we learned the Augur is Metzli, with Ennius and</str>",
        "<str>Furia at her side. In the ruins of Tapoyauik we opened the frozen</str>",
        "<str>door and fought Amoxliatl, who banished me from the ruins.</str>",
        "<str>I reported the attack to Servius at the Sunrise Palace.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE.BANISHED) {
      return [
        "Amoxliatl banished me from Tapoyauik.",
        "",
        "I should head to the <col=800000>Sunrise Palace</col> in Civitas illa Fortis",
        "and report to <col=800000>Servius</col>.",
      ];
    }
    if (stage >= STAGE.DOOR_OPEN) {
      return [
        "I progressed through the Ruins of Tapoyauik and met up with Itzla.",
        "We opened the door and found a nagua called Amoxliatl beyond it.",
        "",
        "I must fight <col=800000>Amoxliatl</col>.",
      ];
    }
    if (stage >= STAGE.PUZZLE) {
      return [
        "I met up with Itzla again in the Ruins of Tapoyauik.",
        "",
        "The door is frozen shut. I should touch the four",
        "<col=800000>statues</col> in the right order to open it.",
      ];
    }
    if (stage >= STAGE.DOOR_MET) {
      return [
        "I met up with Itzla again in the Ruins of Tapoyauik.",
        "",
        "We found a <col=800000>frozen door</col> blocking the way and",
        "I should look around for a way to open it.",
      ];
    }
    if (stage >= STAGE.BLOCKAGE_CLEARED) {
      return [
        "I mined through the blockage in the Ruins of Tapoyauik, but nagua",
        "ambushed us, killing Forebearer Vulcan and separating me from Itzla.",
        "",
        "I should progress through the ruins and meet up with <col=800000>Itzla</col>.",
      ];
    }
    if (stage >= STAGE.RUINS_ENTERED) {
      return [
        "Fides tasked me with clearing a path into the Old One ruins of",
        "Tapoyauik beneath the Temple.",
        "",
        "I should mine the <col=800000>blockage</col> in the ruins.",
      ];
    }
    if (stage >= STAGE.DUTIES) {
      return [
        "Itzla and I attended our initiation. The Augur is Metzli, with",
        "Ennius and Furia claiming to be Ralos and Ranul reborn.",
        "",
        "I should speak to <col=800000>Forebearer Fides</col> about our duties.",
      ];
    }
    if (stage >= STAGE.INITIATED) {
      return [
        "Itzla and I attended our initiation ceremony in the Temple.",
        "",
        "We should wear our <col=800000>cultist robes</col> for the ceremony.",
      ];
    }
    if (stage >= STAGE.ROBES) {
      return [
        "We completed all four trials. Forebearer Janus invited us to",
        "the initiation ceremony.",
        "",
        "I should collect our robes from the <col=800000>chest</col> in the tower lobby.",
      ];
    }
    if (stage >= STAGE.LOBBY) {
      return [
        "We completed all four trials. I should speak to",
        "<col=800000>Forebearer Janus</col> in the lobby.",
      ];
    }
    if (stage >= STAGE.TRIAL4_DONE) {
      return [
        "I defeated Prince Itzla in the final trial.",
        "",
        "I should speak to <col=800000>Forebearer Janus</col>.",
      ];
    }
    if (stage >= STAGE.TRIAL4_FIGHT) {
      return ["It is my turn to face <col=800000>Prince Itzla</col> in the final trial."];
    }
    if (stage >= STAGE.TRIAL3_DONE) {
      return ["We found the traitor. One more trial remains.",
        "", "I should speak to <col=800000>Forebearer Janus</col>."];
    }
    if (stage >= STAGE.TRIAL3_ACTIVE) {
      return [
        "One of the four acolytes is a traitor. I should question",
        "<col=800000>Tenoch</col>, <col=800000>Silia</col>, <col=800000>Adrius</col> and <col=800000>Eleuia</col>.",
        "",
        "Use the <col=800000>Choose</col> option on the one I believe is the traitor.",
      ];
    }
    if (stage >= STAGE.TRIAL2_DONE) {
      return ["We survived the second trial. Two more remain."];
    }
    if (stage >= STAGE.TRIAL2_FIGHT) {
      return ["Itzla and I must survive the second trial."];
    }
    if (stage >= STAGE.TRIAL1_DONE) {
      return ["We completed the first trial. Three more remain.",
        "", "I should speak to <col=800000>Forebearer Janus</col>."];
    }
    if (stage >= STAGE.TRIAL1_NOTE) {
      return ["I have the completed note with the passphrase.",
        "", "I should say it to <col=800000>Forebearer Janus</col>."];
    }
    if (stage >= STAGE.TRIAL1_KEY) {
      return [
        "The first trial needs the correct pass phrase.",
        "I should pickpocket a cultist for the key, open the chests and",
        "combine what I find.",
      ];
    }
    if (stage >= STAGE.RECRUITED_INFO) {
      return ["Itzla and I were called into the Tower of Ascension by",
        "<col=800000>Forebearer Janus</col>."];
    }
    if (stage >= STAGE.MINGLED) {
      return ["I met Itzla outside the Tower of Ascension.",
        "", "I should speak to the other <col=800000>recruits</col>."];
    }
    if (stage >= STAGE.AT_TOWER) {
      return ["I met with Itzla at the Twilight Temple east of Quetzacalli Gorge,",
        "outside the Tower of Ascension."];
    }
    if (stage >= STAGE.SHOP_AGREED) {
      return ["The Quetzacalli Gorge Shopkeeper agreed to send word to the",
        "Emissaries. I should let <col=800000>Itzla</col> know."];
    }
    if (stage >= STAGE.AT_PUB) {
      return ["I met Itzla's contact, who turned out to be Itzla himself.",
        "",
        "I should speak to the <col=800000>Shopkeeper</col> about joining the Emissaries."];
    }
    if (stage >= STAGE.QUEEN_DONE) {
      return ["Itzla asked me to rent the basement room in the Quetzacalli Gorge",
        "Pub. His contact will meet me there."];
    }
    if (stage >= STAGE.STARTED) {
      return ["Queen Zyanyi Arkan arrived and admonished Itzla for failing to",
        "stop the attack on the Teomat.",
        "",
        "I should discuss this with <col=800000>Itzla</col>."];
    }
    return ["I can start this quest by talking to <col=800000>Prince Itzla Arkan</col>",
      "in the Teomat atop Ralos' Rise."];
  }

  function grantReward(player) {
    const skills = player.getSkillManager();
    skills.addExperiences(Skill.MINING, 8000);
    skills.addExperiences(Skill.THIEVING, 8000);
    skills.addExperiences(Skill.SLAYER, 8000);
    skills.addExperiences(Skill.AGILITY, 8000);
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  Object.assign(ID, {
    ITZLA: NpcIdentifiers.PRINCE_ITZLA_ARKAN_24, // 14286
    ITZLA_FIGHT: NpcIdentifiers.PRINCE_ITZLA_ARKAN_13, // 13784
    ITZLA_LOBBY: NpcIdentifiers.PRINCE_ITZLA_ARKAN_15, // 13786
    JANUS: NpcIdentifiers.FOREBEARER_JANUS, // 13714
    FIDES: NpcIdentifiers.FOREBEARER_FIDES, // 13715
    VULCAN: NpcIdentifiers.FOREBEARER_VULCAN, // 13726
    AMOX: NpcIdentifiers.AMOXLIATL, // 13685
    NAGUA: NpcIdentifiers.FROST_NAGUA_2, // 13787
    BRAWLER: NpcIdentifiers.EMISSARY_BRAWLER, // 13773, level 74
    CONJURER: NpcIdentifiers.EMISSARY_CONJURER, // 13777
    SERVIUS: NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS, // 12652
    BARTENDER: NpcIdentifiers.BARTENDER_17, // 14020
    SHOPKEEPER: NpcIdentifiers.SHOPKEEPER_7, // 14021
    NOVA: NpcIdentifiers.NOVA, // 13704
    NOVA_2: NpcIdentifiers.NOVA_2, // 13705
    CARITTA: NpcIdentifiers.CARITTA, // 13701
    FELIUS: NpcIdentifiers.FELIUS, // 13700
    SERGIUS: NpcIdentifiers.SERGIUS, // 13702
    SERGIUS_2: NpcIdentifiers.SERGIUS_2, // 13703
    TENOCH: NpcIdentifiers.TENOCH, // 13780
    SILIA: NpcIdentifiers.SILIA, // 13781
    ADRIUS: NpcIdentifiers.ADRIUS, // 13782
    ELEUIA: NpcIdentifiers.ELEUIA, // 13783
    ASCENDED: [
      NpcIdentifiers.EMISSARY_ASCENDED, // 13706
      NpcIdentifiers.EMISSARY_ASCENDED_2, // 13707
      NpcIdentifiers.EMISSARY_ASCENDED_3, // 13708
    ],
    ACOLYTES: [
      NpcIdentifiers.TENOCH, // 13780
      NpcIdentifiers.SILIA, // 13781
      NpcIdentifiers.ADRIUS, // 13782
      NpcIdentifiers.ELEUIA, // 13783
    ],
    TOWER_KEY: ItemIdentifiers.TOWER_KEY_3, // 29877
    BOOK: ItemIdentifiers.BOOK_7, // 29878
    POEM: ItemIdentifiers.POEM, // 29879
    SCRAP_1: ItemIdentifiers.SCRAP_OF_PAPER, // 29880
    SCRAP_2: ItemIdentifiers.SCRAP_OF_PAPER_2, // 29881
    SCRAP_3: ItemIdentifiers.SCRAP_OF_PAPER_3, // 29882
    SCRAPS: [
      ItemIdentifiers.SCRAP_OF_PAPER,
      ItemIdentifiers.SCRAP_OF_PAPER_2,
      ItemIdentifiers.SCRAP_OF_PAPER_3,
    ],
    NOTE: ItemIdentifiers.COMPLETED_NOTE, // 29883
    BANDAGES: ItemIdentifiers.BANDAGES_5, // 29884
    ROBE_HOOD: ItemIdentifiers.EMISSARY_HOOD, // 29868
    ROBE_TOP: ItemIdentifiers.EMISSARY_ROBE_TOP, // 29870
    ROBE_BOTTOM: ItemIdentifiers.EMISSARY_ROBE_BOTTOM, // 29872
    ROBE_SANDALS: ItemIdentifiers.EMISSARY_SANDALS, // 29874
    ROBES: [
      ItemIdentifiers.EMISSARY_HOOD,
      ItemIdentifiers.EMISSARY_ROBE_TOP,
      ItemIdentifiers.EMISSARY_ROBE_BOTTOM,
      ItemIdentifiers.EMISSARY_SANDALS,
    ],
    COINS: ItemIdentifiers.COINS, // 995
    PICKAXE: ItemIdentifiers.BRONZE_PICKAXE, // 1265
    BED_BASE: ObjectIdentifiers.BED_224, // 52453
    BED_REST: ObjectIdentifiers.BED_231, // 54513
    CHEST_BOOK: ObjectIdentifiers.CHEST_261, // 54376
    CHEST_POEM: ObjectIdentifiers.CHEST_259, // 54374
    CHEST_SCRAP: ObjectIdentifiers.CHEST_257, // 54372
    ROBES_CHEST: ObjectIdentifiers.CHEST_263, // 54515
    ROCKS: ObjectIdentifiers.ROCKS_160, // 54501
    FROZEN_DOOR: ObjectIdentifiers.FROZEN_DOOR_5, // 54451
    BARREL: ObjectIdentifiers.BARREL_200, // 54517
  });

  ID.OWN_TALK = new Set([ID.ITZLA, ID.ITZLA_LOBBY, ID.JANUS, ID.VULCAN, ...ID.ASCENDED, ...ID.ACOLYTES]);
  ID.TOWER_CHESTS = new Set([ID.CHEST_BOOK, ID.CHEST_POEM, ID.CHEST_SCRAP]);
  ID.RECRUITS = new Set([ID.NOVA, ID.NOVA_2, ID.CARITTA, ID.FELIUS, ID.SERGIUS, ID.SERGIUS_2]);
  ID.FIDES_TALKED = new WeakSet();

  pluginApi.persistAttribute(FLAGS_ATTRIBUTE);
  pluginApi.persistAttribute(TRAITOR_ATTRIBUTE);
  pluginApi.persistAttribute(ACCUSED_ATTRIBUTE);
  pluginApi.persistAttribute(STATUE_ATTRIBUTE);

  quest = registerQuest(pluginApi, {
    key: QUEST_KEY,
    name: "The Heart of Darkness",
    varpId: VARP_HEART_OF_DARKNESS,
    varbitId: STAGE_VARBIT,
    startedValue: STAGE.STARTED,
    completionValue: STAGE.COMPLETE,
    questPoints: 2,
    xpRewards: [
      { skillId: Skill.MINING.getIndex(), amount: 8000, label: "Mining" },
      { skillId: Skill.THIEVING.getIndex(), amount: 8000, label: "Thieving" },
      { skillId: Skill.SLAYER.getIndex(), amount: 8000, label: "Slayer" },
      { skillId: Skill.AGILITY.getIndex(), amount: 8000, label: "Agility" },
    ],
    otherRewards: ["Access to Tapoyauik"],
    buildJournal,
    onReward: grantReward,
  });

  pluginApi.onNpcInteraction(handleNpcTalk);
  pluginApi.onNpcDialogueVariant(selectVariant);
  pluginApi.onNpcDialogueCondition(answerCondition);
  pluginApi.onCustomEvent("npc-dialogue:hook", handleDialogueHook);
  pluginApi.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  pluginApi.onCustomEvent("npc-dialogue:condition", handleDialogueConditionEvent);
  pluginApi.onCustomEvent("npc-dialogue:choice", handleDialogueChoice);
  pluginApi.onCustomEvent("quest:stage-changed", handleStageChanged);
  pluginApi.onNpcInteraction("Tenoch", { Choose: chooseTenoch });
  pluginApi.onNpcInteraction("Silia", { Choose: chooseSilia });
  pluginApi.onNpcInteraction("Adrius", { Choose: chooseAdrius });
  pluginApi.onNpcInteraction("Eleuia", { Choose: chooseEleuia });
  pluginApi.onObjectInteraction(handleObjectInteraction);
  pluginApi.onNpcDeath(handleNpcDeath);
  pluginApi.onZoneEnter(RUINS_ZONE, handleRuinsZoneEnter);
  pluginApi.onZoneEnter(TEMPLE_ZONE, handleTempleZoneEnter);
  pluginApi.onPlayerLogin(handleLogin);
  pluginApi.onPlayerLogout(handleLogout);
  pluginApi.onPlayerProcess(handlePlayerProcess);
};
