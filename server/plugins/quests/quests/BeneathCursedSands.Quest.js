/**
 * Beneath Cursed Sands (members).
 *
 * The words come from the "Beneath Cursed Sands" transcript page; this plugin
 * supplies the variant selector for every quest NPC, the prose-condition
 * answers (requirements, inventory space, puzzle state), the stage-direction
 * handlers, the object/item interactions, the quest spawns and the reward.
 *
 * Stage varbit: 13841 "bcs" (varp 3421 "bcs_primary", bits 0-8). Evidence: the
 * cache's own BCS multi-locs and multi-NPCs are driven by this varbit and their
 * transform tables pin the values used here - the Maisa placeholders show her
 * at 4-10 (camp), 12-20 (necropolis), 22-24 (camp), 68-70 and 78-84 (Nardah),
 * 92-96 (necropolis) and 102-104 (Sophanem); the furnace is inspectable at 26,
 * refuels at 28, lights at 30 and is lit from 31; the pillar is inspectable
 * 26-36 and shows the emblem at 38; the well searches 26-38; the tomb entry
 * opens at 25/37; the key urn searches 54-56; the altar is usable at 63; the
 * chemistry table at 82; the lily shows at lily_type 1. Sibling varbits of varp
 * 3421 are written separately: 13850 bcs_lily_type, 13853 bcs_owed_partisan and
 * 13854 bcs_owed_circlet.
 *
 * Stages (varbit 13841): 0 not started, 1 message received, 4 Maisa met at the
 * camp, 5 leaving for the necropolis, 11 at the necropolis, 12 entry inspected,
 * 13 guard fight, 14 guard defeated, 22 back at the camp, 25 in the Ruins of
 * Ullek, 26 furnace inspected, 28 refuelled, 30 ready to light, 31 lit,
 * 32 stone tablet taken, 33 chest dug up, 34 chest opened (scarab mould),
 * 35 scarab emblem smelted, 37 tomb opened, 38 entered the tomb (Scarab
 * Mages), 39 mages defeated, 40 first lever, 41 second lever (door open),
 * 46 urn chamber, 47 urn puzzle solved,
 * 49 Mehhar named, 54 key known, 55 rusty key taken, 57 upper door open
 * (Champion), 58 Champion defeated, 63 upper chamber, 64 High Priest of
 * Scabaras freed, 68 Nardah, 70 lily hunt, 72 Roger met, 74 Roger fed,
 * 76 lily picked, 82 cure equipment started, 84 cure crate taken,
 * 85 crate delivered, 92 necropolis finale, 94 citizens freed, 98 Menaphite
 * Akh fight, 100 Akh defeated, 102 Sophanem finale, 105 complete.
 *
 * Rewards per the OSRS Wiki: 2 Quest points, 50,000 Agility XP, the Keris
 * partisan and the Circlet of water (if the inventory is full they are owed and
 * handed over later from the camp tent / the Sophanem High Priest). The message
 * and stone-tablet texts are the wiki item transcripts.
 *
 * Source: OSRS Wiki "Beneath Cursed Sands", its Quick guide and
 * Transcript:Beneath Cursed Sands; the cache for every id, varbit, transform
 * and placement.
 *
 * Gaps / approximations:
 *  - No cutscenes: the stage directions set stage/teleport/spawn and the
 *    transcript lines play in the chatbox.
 *  - This cache places no interactive Jaltevas Pyramid exterior, so the
 *    "inspect the blocked entry" beat is bound to the necropolis rubble
 *    (44003): climbing it plays the blocked-entry messages and sets the
 *    inspected flag. The Menaphite Guard variant is not indexed to a cache NPC,
 *    so the chapter-one beat uses the indexed Citizen (11533); the world-spawned
 *    Citizen 11540 also answers.
 *  - The cache's camp Maisa (11474) is a static world spawn, so she is visible
 *    before the quest starts and after she should have left; variant selection
 *    keeps her talk benign outside her chapters.
 *  - The chest's seven-digit lock and the pillar's rotation interface are not
 *    simulated: the chest always opens (passcode 1118513) and the emblem is
 *    placed facing down. The urn riddle is not enforced: any emblem may go in
 *    any urn and the lever accepts the puzzle once all four are slotted.
 *  - The two tomb levers must be within 60s in OSRS; here pulling both distinct
 *    levers (any order) opens the door and the dart trap never fires.
 *  - Combat is real NPC kills (Head Menaphite Guard 11529, Scarab Mage 11508 x2,
 *    Champion of Scabaras 11483, Menaphite Akh 11492) but boss specials (shadow
 *    rift, lightning, prayer punishment, shadow) are not scripted.
 *  - Roger is not talkable (no transcript page); the stepping stone runs the
 *    crossing conversation and Roger is scenery.
 *  - The post-quest Selim claim and the Pharaoh Kemesis cutscene are not
 *    implemented; the owed partisan comes from the camp tent and the owed
 *    circlet from the Sophanem High Priest.
 */
module.exports = function registerBeneathCursedSandsQuest(api) {
  const {
    GameObject,
    ItemIdentifiers,
    Location,
    MapObjects,
    NpcIdentifiers,
    ObjectDefinition,
    ObjectIdentifiers,
    ObjectManager,
    Skill,
  } = api.core;
  const { registerQuest, startTranscript } = require("../QuestRuntime");

  const PAGE = "Beneath Cursed Sands";
  const START_HOOK = "quest:beneath-cursed-sands:start";

  // ==========================================================================
  // Stage values / varbits
  // ==========================================================================

  const VARBIT_LILY = 13850; // bcs_lily_type
  const VARBIT_OWED_PARTISAN = 13853; // bcs_owed_partisan
  const VARBIT_OWED_CIRCLET = 13854; // bcs_owed_circlet

  const STAGE_NOT_STARTED = 0;
  const STAGE_STARTED = 1;
  const STAGE_CAMP = 4;
  const STAGE_DEPARTING = 5;
  const STAGE_NECROPOLIS = 11;
  const STAGE_ENTRY_INSPECTED = 12;
  const STAGE_GUARD_FIGHT = 13;
  const STAGE_GUARD_DEFEATED = 14;
  const STAGE_CAMP_LEADS = 22;
  const STAGE_RUINS = 25;
  const STAGE_FURNACE_INSPECTED = 26;
  const STAGE_FURNACE_REFUELLED = 28;
  const STAGE_FURNACE_TO_LIGHT = 30;
  const STAGE_FURNACE_LIT = 31;
  const STAGE_TABLET = 32;
  const STAGE_CHEST_DUG = 33;
  const STAGE_MOULD = 34;
  const STAGE_EMBLEM = 35;
  const STAGE_TOMB_OPEN = 37;
  const STAGE_TOMB_ENTERED = 38;
  const STAGE_MAGES_DEAD = 39;
  const STAGE_LEVER_ONE = 40;
  const STAGE_LEVERS_DONE = 41;
  const STAGE_URN_CHAMBER = 46;
  const STAGE_URN_PUZZLE = 47;
  const STAGE_SPIRIT_MET = 49;
  const STAGE_KEY_KNOWN = 54;
  const STAGE_KEY_TAKEN = 55;
  const STAGE_UPPER_OPEN = 57;
  const STAGE_CHAMPION_DEAD = 58;
  const STAGE_ALTAR = 63;
  const STAGE_PRIEST_FREED = 64;  const STAGE_NARDAH = 68;
  const STAGE_LILY_HUNT = 70;
  const STAGE_CROC_MET = 72;
  const STAGE_ROGER_FED = 74;
  const STAGE_LILY_PICKED = 76;
  const STAGE_EQUIPMENT = 82;
  const STAGE_CURE_TAKEN = 84;
  const STAGE_CRATE_DELIVERED = 85;
  const STAGE_FINALE = 92;
  const STAGE_CITIZENS_FREED = 94;
  const STAGE_AKH_FIGHT = 98;
  const STAGE_AKH_DEAD = 100;
  const STAGE_SOPHANEM = 102;
  const STAGE_COMPLETE = 105;

  // ==========================================================================
  // Ids
  // ==========================================================================

  const JAMILA = NpcIdentifiers.JAMILA; // 3892
  const MAISA_CAMP = NpcIdentifiers.MAISA_2; // 11474, the BCS Maisa content id
  const MAISA_IDS = new Set([
    NpcIdentifiers.MAISA_2, // 11474
    NpcIdentifiers.MAISA_3, // 11475
    NpcIdentifiers.MAISA_4, // 11476
    NpcIdentifiers.MAISA_5, // 11477
  ]);
  const ZAHUR = NpcIdentifiers.ZAHUR; // 4753
  const MEHHAR = NpcIdentifiers.MEHHAR; // 11479
  const HIGH_PRIEST_OF_SCABARAS = NpcIdentifiers.HIGH_PRIEST_OF_SCABARAS; // 11480
  const HIGH_PRIEST_IDS = new Set([
    NpcIdentifiers.HIGH_PRIEST_2, // 4206, the town High Priest (cache transform)
    NpcIdentifiers.HIGH_PRIEST_4, // 11502
  ]);
  const OSMAN = NpcIdentifiers.OSMAN; // 1809, the indexed Osman; 11486 has no dialogue index entry
  const MENAPHITE_AKH = NpcIdentifiers.MENAPHITE_AKH_3; // 11492, level 351
  const SCARAB_MAGE = NpcIdentifiers.SCARAB_MAGE_3; // 11508, level 119
  const CHAMPION_OF_SCABARAS = NpcIdentifiers.CHAMPION_OF_SCABARAS_2; // 11483, level 379
  const HEAD_MENAPHITE_GUARD = NpcIdentifiers.HEAD_MENAPHITE_GUARD_2; // 11529, level 174
  const CITIZEN = NpcIdentifiers.CITIZEN; // 11533
  const WORLD_CITIZEN = 11540; // the Citizen spawned by npc-spawns.json
  const ROGER = 11514; // bcs_crocodile_named, "Roger"

  const MESSAGE_ITEM = ItemIdentifiers.MESSAGE_8; // 26942
  const STONE_TABLET_ITEM = ItemIdentifiers.STONE_TABLET_5; // 26954
  const CHEST_ITEM = ItemIdentifiers.CHEST_3; // 26955
  const SCARAB_MOULD_ITEM = ItemIdentifiers.SCARAB_MOULD; // 26952
  const SCARAB_EMBLEM_ITEM = ItemIdentifiers.SCARAB_EMBLEM; // 26953
  const HUMAN_EMBLEM_ITEM = ItemIdentifiers.HUMAN_EMBLEM; // 26957
  const BABOON_EMBLEM_ITEM = ItemIdentifiers.BABOON_EMBLEM; // 26958
  const CROCODILE_EMBLEM_ITEM = ItemIdentifiers.CROCODILE_EMBLEM; // 26959
  const RUSTY_KEY_ITEM = ItemIdentifiers.RUSTY_KEY; // 26960
  const LILY_ITEM = ItemIdentifiers.LILY_OF_THE_ELID; // 26961
  const CURE_CRATE_ITEM = ItemIdentifiers.CURE_CRATE; // 26962
  const KERIS_PARTISAN_ITEM = ItemIdentifiers.KERIS_PARTISAN; // 25979
  const CIRCLET_OF_WATER_ITEM = ItemIdentifiers.CIRCLET_OF_WATER; // 26969
  const COAL_ITEM = ItemIdentifiers.COAL; // 453
  const IRON_BAR_ITEM = ItemIdentifiers.IRON_BAR; // 2351
  const TINDERBOX_ITEM = ItemIdentifiers.TINDERBOX; // 590
  const SPADE_ITEM = ItemIdentifiers.SPADE; // 952
  const MEAT_ITEM_IDS = new Set([
    ItemIdentifiers.RAW_BEEF, // 2132
    ItemIdentifiers.RAW_BEEF_2, // 2133
    ItemIdentifiers.RAW_BEEF_3, // 4287
    ItemIdentifiers.RAW_BEEF_4, // 4288
    ItemIdentifiers.COOKED_MEAT, // 2142
    ItemIdentifiers.COOKED_MEAT_2, // 2143
    ItemIdentifiers.COOKED_MEAT_3, // 4293
    ItemIdentifiers.COOKED_MEAT_4, // 4294
  ]);
  const RAW_MEAT_ITEM_IDS = new Set([
    ItemIdentifiers.RAW_BEEF,
    ItemIdentifiers.RAW_BEEF_2,
    ItemIdentifiers.RAW_BEEF_3,
    ItemIdentifiers.RAW_BEEF_4,
  ]);
  const COOKED_MEAT_ITEM_IDS = new Set([
    ItemIdentifiers.COOKED_MEAT,
    ItemIdentifiers.COOKED_MEAT_2,
    ItemIdentifiers.COOKED_MEAT_3,
    ItemIdentifiers.COOKED_MEAT_4,
  ]);
  const EMBLEM_ITEM_IDS = new Set([
    SCARAB_EMBLEM_ITEM,
    HUMAN_EMBLEM_ITEM,
    BABOON_EMBLEM_ITEM,
    CROCODILE_EMBLEM_ITEM,
  ]);

  const CAMP_TENT = ObjectIdentifiers.TENT_13; // 43887, searchable for the owed partisan
  const CAMP_EQUIPMENT = ObjectIdentifiers.CAMPING_EQUIPMENT_4; // 43889
  const CAMP_SPADE = ObjectIdentifiers.SPADE_3; // 43884
  const FURNACE_UNLIT = ObjectIdentifiers.FURNACE_32; // 43891
  const FURNACE_INSPECT = ObjectIdentifiers.FURNACE_33; // 43892
  const FURNACE_REFUEL = ObjectIdentifiers.FURNACE_34; // 43893
  const FURNACE_LIGHT = ObjectIdentifiers.FURNACE_35; // 43894
  const FURNACE_LIT = ObjectIdentifiers.FURNACE_36; // 43895
  const FURNACE_IDS = new Set([
    FURNACE_UNLIT,
    FURNACE_INSPECT,
    FURNACE_REFUEL,
    FURNACE_LIGHT,
    FURNACE_LIT,
  ]);
  const PILLAR_INSPECT = ObjectIdentifiers.PILLAR_81; // 43898
  const PILLAR_EMBLEM = ObjectIdentifiers.PILLAR_83; // 43900, emblem slotted
  const WELL_SEARCH = ObjectIdentifiers.WELL_23; // 43903
  const ENTRY_SEALED = ObjectIdentifiers.ENTRY_4; // 43953, Inspect
  const ENTRY_OPEN = ObjectIdentifiers.ENTRY_5; // 43954, Enter
  const DOOR_CHAMPION = ObjectIdentifiers.DOOR_658; // 43960, z2
  const DOOR_LEVERS_A = ObjectIdentifiers.DOOR_659; // 43961, z0
  const DOOR_LEVERS_B = ObjectIdentifiers.DOOR_660; // 43962, z0
  const DOOR_UPPER = ObjectIdentifiers.DOOR_661; // 43963, z2, rusty key
  const LEVER_TOMB_ON = ObjectIdentifiers.LEVER_58; // 43967
  const LEVER_TOMB_OFF = ObjectIdentifiers.LEVER_59; // 43968
  const LEVER_URN = ObjectIdentifiers.LEVER_60; // 43969
  const LEVER_URN_ON = ObjectIdentifiers.LEVER_61; // 43970
  const RIDDLE_PLAQUE = ObjectIdentifiers.PLAQUE_27; // 43971
  const EMBLEM_PLAQUE = ObjectIdentifiers.PLAQUE_29; // 43973
  const URN_INSPECT = ObjectIdentifiers.URN_42; // 43979
  const KEY_URN = ObjectIdentifiers.URN_44; // 43981
  const LILY = ObjectIdentifiers.LILY; // 43984, lily present
  const LILY_PICKED = ObjectIdentifiers.LILY_3; // 43986, already picked
  const STEPPING_STONE = ObjectIdentifiers.STEPPING_STONE_48; // 43988
  const CHEMISTRY_TABLE = ObjectIdentifiers.CHEMISTRY_TABLE_3; // 43991
  const NECROPOLIS_RUBBLE = ObjectIdentifiers.RUBBLE_60; // 44003, climbable
  const DIG_PILLARS = new Set([
    ObjectIdentifiers.PILLAR_86, // 43994
    ObjectIdentifiers.PILLAR_87, // 43995
    ObjectIdentifiers.PILLAR_88, // 43996
    ObjectIdentifiers.PILLAR_89, // 43997
  ]);
  // Both tomb levers are placed as 43968, which has no actions in this cache;
  // swap in the "Pull" loc (43967) so they can actually be clicked.
  const TOMB_LEVER_TILES = [
    [3439, 9225, 0],
    [3439, 9271, 0],
  ];
  let tombLeversInstalled = false;

  // ==========================================================================
  // Attributes
  // ==========================================================================

  const INTRO_ATTRIBUTE = "beneath-cursed-sands:maisa-intro";
  const ENTRY_INSPECTED_ATTRIBUTE = "beneath-cursed-sands:entry-inspected";
  const TALKED_CITIZEN_ATTRIBUTE = "beneath-cursed-sands:talked-citizen";
  const URNS_ATTRIBUTE = "beneath-cursed-sands:urns";
  const LEVERS_ATTRIBUTE = "beneath-cursed-sands:levers";
  const EMBLEMS_TAKEN_ATTRIBUTE = "beneath-cursed-sands:emblems-taken";
  const OWED_PARTISAN_ATTRIBUTE = "beneath-cursed-sands:owed-partisan";
  const OWED_CIRCLET_ATTRIBUTE = "beneath-cursed-sands:owed-circlet";

  // Urn slots 1 (northernmost) .. 4 (southernmost); emblem types 1..4.
  const EMBLEM_TYPE_BABOON = 1;
  const EMBLEM_TYPE_HUMAN = 2;
  const EMBLEM_TYPE_CROCODILE = 3;
  const EMBLEM_TYPE_SCARAB = 4;
  const EMBLEM_NAME_BY_TYPE = {
    1: "baboon",
    2: "human",
    3: "crocodile",
    4: "scarab",
  };
  const EMBLEM_ITEM_BY_TYPE = {
    1: BABOON_EMBLEM_ITEM,
    2: HUMAN_EMBLEM_ITEM,
    3: CROCODILE_EMBLEM_ITEM,
    4: SCARAB_EMBLEM_ITEM,
  };
  const URN_NAME_BY_SLOT = {
    1: "northernmost",
    2: "centre-north",
    3: "centre-south",
    4: "southernmost",
  };

  // ==========================================================================
  // State helpers
  // ==========================================================================

  /** Transient: which urn the player is inspecting (message ids carry no slot). */
  const urnSlotByPlayer = new WeakMap();
  /** Transient: the upper door tile an action opens (messages carry no location). */
  const doorLocationByPlayer = new WeakMap();
  /** Per-player quest spawns, keyed by a role name. */
  const trackedNpcs = new Map();

  let quest;

  function hasItem(player, itemId, amount = 1) {
    return player.getInventory().getAmount(itemId) >= amount;
  }

  function hasAnyOf(player, itemIds) {
    for (const itemId of itemIds) {
      if (hasItem(player, itemId)) return true;
    }
    return false;
  }

  function freeSlots(player) {
    return player.getInventory().getFreeSlots();
  }

  function isQuestComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    return (
      skills.getMaxLevel(Skill.AGILITY) >= 62 &&
      skills.getMaxLevel(Skill.CRAFTING) >= 55 &&
      skills.getMaxLevel(Skill.FIREMAKING) >= 55 &&
      isQuestComplete(player, "contact") &&
      isQuestComplete(player, "ictlharins_little_helper")
    );
  }

  function flag(player, key, value) {
    player.setAttribute(key, value === true);
  }

  function hasFlag(player, key) {
    return player.getAttribute(key) === true;
  }

  function setStage(player, value) {
    if (quest.getStage(player) === value) return;
    quest.setStage(player, value);
    syncNpcs(player);
    // Lily/owed varbits live in the same parent varp as the stage.
    sendQuestBits(player);
  }

  function introDone(player) {
    return hasFlag(player, INTRO_ATTRIBUTE);
  }

  function entryInspected(player) {
    return hasFlag(player, ENTRY_INSPECTED_ATTRIBUTE);
  }

  function talkedCitizen(player) {
    return hasFlag(player, TALKED_CITIZEN_ATTRIBUTE);
  }

  function urnState(player) {
    return Number(player.getAttribute(URNS_ATTRIBUTE)) || 0;
  }

  function urnEmblem(player, slot) {
    return (urnState(player) >> ((slot - 1) * 4)) & 0xf;
  }

  function setUrnEmblem(player, slot, type) {
    const next = urnState(player) | (type << ((slot - 1) * 4));
    player.setAttribute(URNS_ATTRIBUTE, next | 0);
  }

  function urnPuzzleComplete(player) {
    for (let slot = 1; slot <= 4; slot++) {
      if (urnEmblem(player, slot) === 0) return false;
    }
    return true;
  }

  function leverBits(player) {
    return Number(player.getAttribute(LEVERS_ATTRIBUTE)) || 0;
  }

  function setLeverBits(player, value) {
    player.setAttribute(LEVERS_ATTRIBUTE, value | 0);
  }

  function emblemsTaken(player) {
    return hasFlag(player, EMBLEMS_TAKEN_ATTRIBUTE);
  }

  function owedPartisan(player) {
    return hasFlag(player, OWED_PARTISAN_ATTRIBUTE);
  }

  function setOwedPartisan(player, value) {
    flag(player, OWED_PARTISAN_ATTRIBUTE, value);
    player.getPacketSender().sendVarbit(VARBIT_OWED_PARTISAN, value ? 1 : 0);
  }

  function owedCirclet(player) {
    return hasFlag(player, OWED_CIRCLET_ATTRIBUTE);
  }

  function setOwedCirclet(player, value) {
    flag(player, OWED_CIRCLET_ATTRIBUTE, value);
    player.getPacketSender().sendVarbit(VARBIT_OWED_CIRCLET, value ? 1 : 0);
  }

  function lilyType(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_LILY_PICKED) return 2;
    if (stage >= STAGE_ROGER_FED) return 1;
    return 0;
  }

  function hasMeat(player) {
    return hasAnyOf(player, MEAT_ITEM_IDS);
  }

  function hasAnyEmblem(player) {
    return hasAnyOf(player, EMBLEM_ITEM_IDS);
  }

  function takeAnyMeat(player) {
    for (const itemId of MEAT_ITEM_IDS) {
      if (hasItem(player, itemId)) {
        player.getInventory().deleteNumber(itemId, 1);
        return itemId;
      }
    }
    return null;
  }

  function sendQuestBits(player) {
    const sender = player.getPacketSender();
    sender.sendVarbit(VARBIT_LILY, lilyType(player));
    sender.sendVarbit(VARBIT_OWED_PARTISAN, owedPartisan(player) ? 1 : 0);
    sender.sendVarbit(VARBIT_OWED_CIRCLET, owedCirclet(player) ? 1 : 0);
  }

  // ==========================================================================
  // Spawns
  // ==========================================================================

  function trackedFor(player) {
    let tracked = trackedNpcs.get(player);
    if (!tracked) {
      tracked = new Map();
      trackedNpcs.set(player, tracked);
    }
    return tracked;
  }

  /** Drops this player's own same-id NPC copies on a tile (relog leaves them behind). */
  function cullOwnedNpcs(player, npcId, x, y, z) {
    for (const other of api.getWorld?.()?.getNpcs?.() ?? []) {
      if (other?.getOwner?.() !== player || other.getId?.() !== npcId) continue;
      const at = other.getLocation?.();
      if (at && (at.getX?.() !== x || at.getY?.() !== y || at.getZ?.() !== z)) continue;
      api.removeNpc(other);
    }
  }

  function spawnTracked(player, key, npcId, x, y, z, wanderRadius = 0) {
    const tracked = trackedFor(player);
    const existing = tracked.get(key);
    if (existing?.isRegistered?.()) return existing;
    // A relog empties the tracked map but owner-only NPCs stay in the world;
    // drop same-id copies on this tile so login cannot stack duplicates.
    cullOwnedNpcs(player, npcId, x, y, z);
    const npc = api.spawnNpc({
      id: npcId,
      x,
      y,
      z,
      wanderRadius,
      owner: player,
      ownerOnly: true,
    });
    if (npc) tracked.set(key, npc);
    return npc;
  }

  function removeTracked(player, key) {
    const tracked = trackedNpcs.get(player);
    const npc = tracked?.get(key);
    if (!npc) return;
    api.removeNpc(npc);
    tracked.delete(key);
  }

  function ensureNpc(player, key, npcId, x, y, z, wanted) {
    if (wanted) spawnTracked(player, key, npcId, x, y, z);
    else {
      cullOwnedNpcs(player, npcId, x, y, z);
      removeTracked(player, key);
    }
  }

  function installTombLevers() {
    if (tombLeversInstalled) return;
    tombLeversInstalled = true;
    for (const [x, y, z] of TOMB_LEVER_TILES) {
      const location = new Location(x, y, z);
      const placed = MapObjects.get(LEVER_TOMB_OFF, location.clone(), null);
      if (placed) ObjectManager.deregister(placed, true);
      ObjectManager.register(new GameObject(LEVER_TOMB_ON, location, 10, 3, null), true);
    }
  }

  /** Keeps the per-player quest NPCs in step with the stage. */
  function syncNpcs(player) {
    const stage = quest.getStage(player);
    ensureNpc(player, "citizen", CITIZEN, 3344, 2736, 0, stage >= STAGE_NECROPOLIS && stage <= STAGE_CAMP_LEADS);
    ensureNpc(
      player,
      "necropolis-maisa",
      MAISA_CAMP,
      3345,
      2745,
      0,
      (stage >= STAGE_GUARD_FIGHT && stage <= STAGE_CAMP_LEADS) ||
        (stage >= STAGE_FINALE && stage <= STAGE_AKH_DEAD + 1)
    );
    ensureNpc(player, "nardah-maisa", MAISA_CAMP, 3421, 2906, 0, stage >= STAGE_NARDAH && stage <= STAGE_CRATE_DELIVERED);
    ensureNpc(player, "roger", ROGER, 3353, 2920, 0, stage >= STAGE_LILY_HUNT && stage <= STAGE_ROGER_FED);
    ensureNpc(player, "mehhar", MEHHAR, 3372, 9248, 0, stage >= STAGE_URN_PUZZLE && stage <= STAGE_PRIEST_FREED + 3);
    ensureNpc(
      player,
      "scabaras-priest",
      HIGH_PRIEST_OF_SCABARAS,
      3405,
      9250,
      2,
      stage >= STAGE_UPPER_OPEN && stage <= STAGE_PRIEST_FREED + 3
    );
    ensureNpc(player, "osman", OSMAN, 3380, 2789, 0, stage >= STAGE_AKH_DEAD && stage <= STAGE_AKH_DEAD + 1);
    ensureNpc(player, "guard", HEAD_MENAPHITE_GUARD, 3348, 2740, 0, stage === STAGE_GUARD_FIGHT);
    ensureNpc(player, "mage1", SCARAB_MAGE, 3434, 9245, 0, stage === STAGE_TOMB_ENTERED);
    ensureNpc(player, "mage2", SCARAB_MAGE, 3434, 9251, 0, stage === STAGE_TOMB_ENTERED);
    ensureNpc(player, "champion", CHAMPION_OF_SCABARAS, 3436, 9248, 2, stage === STAGE_UPPER_OPEN);
    ensureNpc(player, "akh", MENAPHITE_AKH, 3378, 2786, 0, stage === STAGE_AKH_FIGHT);
  }

  // ==========================================================================
  // Transcripts
  // ==========================================================================

  /** Starts a transcript a tick later, after a running dialogue has closed. */
  function startTranscriptDeferred(player, npcId, variant, select) {
    const { CountdownTask, TaskManager } = api.core;
    if (!CountdownTask || !TaskManager) {
      startTranscript(api, player, npcId, PAGE, variant, select);
      return;
    }
    TaskManager.submit(
      new CountdownTask(player, 1, () => {
        if (player.isRegistered?.() === false) return;
        startTranscript(api, player, npcId, PAGE, variant, select);
      })
    );
  }

  /** A variant narrowed to the run starting at a top-level condition id. */
  function sliceFromCondition(steps, conditionId) {
    if (!Array.isArray(steps)) return steps;
    const index = steps.findIndex((step) => step?.type === "condition" && step.id === conditionId);
    return index === -1 ? steps : steps.slice(index);
  }

  /** A variant narrowed to the prose before its first choice menu. */
  function sliceBeforeChoice(steps) {
    if (!Array.isArray(steps)) return steps;
    const index = steps.findIndex((step) => step?.type === "choice");
    return index === -1 ? steps : steps.slice(0, index);
  }

  // ==========================================================================
  // Variant selection
  // ==========================================================================

  function selectJamilaVariant(stage, player) {
    if (stage === STAGE_NOT_STARTED) return "starting-off-talking-to-jamila";
    if (stage >= STAGE_NECROPOLIS) return "starting-off-talking-to-jamila-after-talking-to-maisa";
    return hasItem(player, MESSAGE_ITEM)
      ? "starting-off-talking-to-jamila-talking-to-jamila-after-getting-the-message-once"
      : "starting-off-talking-to-jamila-talking-to-jamilia-again-before-trying-on-the-ring";
  }

  function selectMaisaVariant(stage, player) {
    if (stage < STAGE_NECROPOLIS) {
      return introDone(player)
        ? "starting-off-talking-to-maisa-talking-to-maisa-again-before-the-cutscene"
        : "starting-off-talking-to-maisa";
    }
    if (stage === STAGE_GUARD_DEFEATED) {
      return "starting-off-talking-to-maisa-after-defeating-the-head-menaphite-guard";
    }
    // 22 is the camp-leads conversation whose last step (Jpi6NF) sends the player
    // to the ruins, so it must play the Ruins variant, not the "still looking" line.
    if (stage <= STAGE_CAMP_LEADS - 1) return "starting-off-talking-to-maisa-at-the-necropolis";
    if (stage <= STAGE_PRIEST_FREED + 3) return "the-ruins-of-ullek-talking-to-maisa";
    if (stage <= STAGE_LILY_PICKED + 5) return "cure-me-pox-talking-to-maisa-or-zahur";
    if (stage <= STAGE_CURE_TAKEN) {
      return "cure-me-pox-talking-to-maisa-after-zahur-explains-the-equipment";
    }
    if (stage < STAGE_FINALE) {
      // After the crate is delivered she waits at the necropolis for the finale.
      setStage(player, STAGE_FINALE);
      return "fight-with-the-menaphite-akh-talking-to-maisa-at-the-necropolis";
    }
    if (stage <= STAGE_AKH_FIGHT - 1) return "fight-with-the-menaphite-akh-talking-to-maisa-at-the-necropolis";
    if (stage <= STAGE_AKH_DEAD + 1) {
      return "fight-with-the-menaphite-akh-talking-to-maisa-at-the-necropolis-escape-fire-during-the-fight-with-the-menaphite-akh";
    }
    return "fight-with-the-menaphite-akh-talking-to-maisa-or-the-high-priest";
  }

  function selectZahurVariant(stage, player) {
    if (stage < STAGE_PRIEST_FREED || stage >= STAGE_COMPLETE) return null;
    if (stage >= STAGE_CURE_TAKEN) return "cure-me-pox-warming-up-the-equipment-talking-to-zahur-again";
    if (stage === STAGE_EQUIPMENT) return "cure-me-pox-warming-up-the-equipment-talking-to-zahur-before-getting-the-crate";
    if (stage >= STAGE_LILY_PICKED) return "cure-me-pox-returning-to-zahur";
    if (stage >= STAGE_NARDAH) return "cure-me-pox-talking-to-maisa-or-zahur-talking-to-zahur-again";
    // 64-67: first arrival in Nardah, which reveals Maisa at her side.
    setStage(player, STAGE_NARDAH);
    return "cure-me-pox-talking-to-maisa-or-zahur";
  }

  function selectMehharVariant(stage) {
    if (stage < STAGE_SPIRIT_MET) return "the-ruins-of-ullek-talking-to-the-spirit";
    if (stage < STAGE_KEY_KNOWN) return "the-ruins-of-ullek-talking-to-the-spirit-talking-to-mehhar-again";
    if (stage < STAGE_PRIEST_FREED) return "the-ruins-of-ullek-talking-to-mehhar-after-killing-the-high-priest-of-scabaras";
    return "the-ruins-of-ullek-talking-to-mehhar-after-saying-the-incantation";
  }

  function selectScabarasPriestVariant(stage) {
    if (stage < STAGE_CHAMPION_DEAD) return "the-ruins-of-ullek-the-champion-of-scabaras";
    if (stage < STAGE_PRIEST_FREED) return "the-ruins-of-ullek-talking-to-the-high-priest-of-scabaras";
    return "the-ruins-of-ullek-talking-to-the-high-priest-of-scabaras-talking-to-the-high-priest-again";
  }

  function selectHighPriestVariant(stage, player) {
    if (stage >= STAGE_COMPLETE) {
      return owedCirclet(player)
        ? "fight-with-the-menaphite-akh-talking-to-maisa-or-the-high-priest-talking-to-high-priest-before-getting-the-reward"
        : null;
    }
    if (stage === STAGE_SOPHANEM) return "fight-with-the-menaphite-akh-talking-to-maisa-or-the-high-priest";
    if (stage >= STAGE_CURE_TAKEN) {
      return hasItem(player, CURE_CRATE_ITEM)
        ? "cure-me-pox-talking-to-the-high-priest-of-sophanem"
        : "cure-me-pox-talking-to-the-high-priest-of-sophanem-talking-to-the-high-priest-again";
    }
    return null;
  }

  function selectOsmanVariant(stage) {
    if (stage >= STAGE_AKH_DEAD && stage <= STAGE_AKH_DEAD + 1) {
      return "fight-with-the-menaphite-akh-defeating-the-menaphite-akh";
    }
    return null;
  }

  function selectCitizenVariant(stage) {
    if (stage >= STAGE_NECROPOLIS && stage <= STAGE_GUARD_FIGHT) return "starting-off-talking-to-a-citizen";
    // The BCS page default is Jamila, so never leave a citizen unanswered.
    return "starting-off-talking-to-maisa-after-defeating-the-head-menaphite-guard-talking-to-citizen-after-killing-the-head-menaphite-guard";
  }

  function selectVariant({ npcId, player }) {
    const stage = quest.getStage(player);
    if (npcId === JAMILA) return selectJamilaVariant(stage, player);
    if (MAISA_IDS.has(npcId)) return selectMaisaVariant(stage, player);
    if (npcId === ZAHUR) return selectZahurVariant(stage, player);
    if (npcId === MEHHAR) return selectMehharVariant(stage);
    if (npcId === HIGH_PRIEST_OF_SCABARAS) return selectScabarasPriestVariant(stage);
    if (HIGH_PRIEST_IDS.has(npcId)) return selectHighPriestVariant(stage, player);
    if (npcId === OSMAN) return selectOsmanVariant(stage);
    if (npcId === CITIZEN || npcId === WORLD_CITIZEN) return selectCitizenVariant(stage);
    return null;
  }

  // ==========================================================================
  // Condition answers
  // ==========================================================================

  function answerCondition({ player, text, stepId }) {
    const value = String(text ?? "").toLowerCase();
    switch (stepId) {
      case "EG72ae": // requirements not met
        return !meetsRequirements(player);
      case "176ymE": // no inventory space
      case "aflncp":
      case "Ht5ARY":
      case "JIC2N1":
      case "7ccfXt":
      case "XKu47B":
      case "ua-ZfM":
      case "AWKbyb":
      case "7q3z7C":
      case "m--_AB":
      case "SgNX8k":
      case "XDgX9t":
      case "lIK3NS":
      case "C_iYsX":
      case "HwxhdO":
      case "ay1nNZ":
      case "a3FBE8":
      case "cAYF2b":
      case "hdWHUJ":
        return freeSlots(player) === 0;
      case "XRq9X9": // has inventory space
      case "OUV0Vd":
      case "nZBmJn":
      case "sg2p6r":
      case "GOB2aj":
      case "8u604D":
      case "9hvCES":
      case "RUKNjm":
        return freeSlots(player) > 0;
      case "0aobeO": // lower than level 85 combat
        return player.getSkillManager().getCombatLevel() < 85;
      case "M6NQTY": // lost the message
        return !hasItem(player, MESSAGE_ITEM);
      case "DR6Lnb": // did not lose the message
        return hasItem(player, MESSAGE_ITEM);
      case "pweUPy": // already talked to a citizen or guard
      case "EwD3ed":
      case "cXwwUr":
        return talkedCitizen(player);
      case "6GtkAE": // has not inspected the blocked entry
      case "Y9BVuZ":
        return !entryInspected(player);
      case "otoVHH": // has already inspected the blocked entry
      case "csB9eU":
        return entryInspected(player);
      case "l_rzqL": // already has a tinderbox
      case "4rYAMe": // has a tinderbox
        return hasItem(player, TINDERBOX_ITEM);
      case "YRqiPW": // does not have a tinderbox
        return !hasItem(player, TINDERBOX_ITEM);
      case "cWPPhg": // has coal
        return hasItem(player, COAL_ITEM);
      case "9x3Scj": // does not have coal
        return !hasItem(player, COAL_ITEM);
      case "CxM9SO": // has the mould and no iron bar
        return hasItem(player, SCARAB_MOULD_ITEM) && !hasItem(player, IRON_BAR_ITEM);
      case "KjOFbT": // has the mould and an iron bar
        return hasItem(player, SCARAB_MOULD_ITEM) && hasItem(player, IRON_BAR_ITEM);
      case "1trNvq": // does not have the mould
        return !hasItem(player, SCARAB_MOULD_ITEM);
      case "J92bm-": // already has the tablet
        return hasItem(player, STONE_TABLET_ITEM);
      case "Kk61U_": // chest entry incorrect
        return false;
      case "9yObmB": // chest entry correct
        return true;
      case "jQruRe": // rotation incorrect
        return false;
      case "Svxtqy": // rotation correct
        return true;
      case "GFogDe": // no emblems
        return !hasAnyEmblem(player);
      case "Ux0IjG": // puzzle incomplete
        return !urnPuzzleComplete(player);
      case "vpecUI": // puzzle complete
        return urnPuzzleComplete(player);
      case "-7Dfe4": // does not have the rusty key
        return !hasItem(player, RUSTY_KEY_ITEM);
      case "xRL6nI": // has the rusty key
        return hasItem(player, RUSTY_KEY_ITEM);
      case "JJI9Wx": // completed Making Friends with My Arm
        return isQuestComplete(player, "making_friends_with_my_arm");
      case "snpALd": // has meat
        return hasMeat(player);
      case "2DTyEf": // uses raw beef
        return hasAnyOf(player, RAW_MEAT_ITEM_IDS);
      case "6qxKzP": // uses cooked meat
        return hasAnyOf(player, COOKED_MEAT_ITEM_IDS);
      case "eAnITS": // already picked the lily
        return lilyType(player) >= 2;
      case "1ER9T9": // does not have the lily
        return !hasItem(player, LILY_ITEM);
      case "INWKVN": // does not have the crate
        return !hasItem(player, CURE_CRATE_ITEM);
      case "7LNV6Q": // urn option: baboon emblem
      case "LML8SH":
        return hasItem(player, BABOON_EMBLEM_ITEM);
      case "mFLiCX": // urn option: human emblem
      case "r2KX-h":
        return hasItem(player, HUMAN_EMBLEM_ITEM);
      case "j9c5d8": // urn option: crocodile emblem
      case "7ODbS0":
        return hasItem(player, CROCODILE_EMBLEM_ITEM);
      case "thAUeM": // urn option: scarab emblem
      case "AM3YM7":
        return hasItem(player, SCARAB_EMBLEM_ITEM);
      default:
        break;
    }
    if (value.includes("does not meet all of the requirements")) return !meetsRequirements(player);
    return null;
  }

  // ==========================================================================
  // Action / message handling
  // ==========================================================================

  function handleAction(event) {
    const { player, stepId } = event;
    switch (stepId) {
      // Wiki "unavailable" continuation markers that sit before a branch's tail;
      // letting them end the chat would strand the stage update after them.
      case "POwEyB": // Zahur: before the equipment talk
      case "93LAJP": // Sophanem High Priest: before the crate hand-in
        event.handled = true;
        return;
      // Chapter 1 - Jamila and the necropolis.
      case "BJhYfb": // Jamila slips you a message
      case "L-uj6w":
        if (!hasItem(player, MESSAGE_ITEM)) player.getInventory().adds(MESSAGE_ITEM, 1);
        return;
      case "xBeK96": // cutscene: arriving at the necropolis
        setStage(player, STAGE_DEPARTING);
        return;
      case "jclHjw": // cutscene ends
        setStage(player, STAGE_NECROPOLIS);
        player.moveTo(new Location(3348, 2763, 0));
        return;
      case "fyqclq": // guard cutscene begins (entry inspect path)
      case "QG4tPj": // guard cutscene begins (citizen path)
      case "tpcVMZ": // guard cutscene begins (guard path)
        event.handled = true;
        flag(player, TALKED_CITIZEN_ATTRIBUTE, true);
        startTranscriptDeferred(player, MAISA_CAMP, "starting-off-guard-cutscene");
        return;
      case "V9HUjH": // the fight begins
        event.handled = true;
        setStage(player, STAGE_GUARD_FIGHT);
        return;
      case "IDLAQq": // flee from the fight
        removeTracked(player, "guard");
        return;

      // Chapter 2 - camp and ruins.
      case "Jpi6NF": // Maisa leaves the camp
        if (quest.getStage(player) < STAGE_RUINS) setStage(player, STAGE_RUINS);
        return;
      case "LFeGB9": // tinderbox found
        if (!hasItem(player, TINDERBOX_ITEM)) player.getInventory().adds(TINDERBOX_ITEM, 1);
        return;
      case "C4FAas": // furnace: continues with refuel dialogue
        event.handled = true;
        startTranscriptDeferred(player, MAISA_CAMP, "the-ruins-of-ullek-interacting-with-objects-furnace-refuel-furnace");
        return;
      case "g3vgUM": // furnace refuelled
        if (hasItem(player, COAL_ITEM)) player.getInventory().deleteNumber(COAL_ITEM, 1);
        if (quest.getStage(player) < STAGE_FURNACE_TO_LIGHT) setStage(player, STAGE_FURNACE_TO_LIGHT);
        return;
      case "sY4_lV": // furnace: continues with light dialogue
        event.handled = true;
        startTranscriptDeferred(player, MAISA_CAMP, "the-ruins-of-ullek-interacting-with-objects-furnace-light-furnace");
        return;
      case "e40eIt": // furnace lit
        if (quest.getStage(player) < STAGE_FURNACE_LIT) setStage(player, STAGE_FURNACE_LIT);
        return;
      case "_1f0Kx": // scarab emblem crafted
        if (hasItem(player, SCARAB_MOULD_ITEM)) player.getInventory().deleteNumber(SCARAB_MOULD_ITEM, 1);
        if (hasItem(player, IRON_BAR_ITEM)) player.getInventory().deleteNumber(IRON_BAR_ITEM, 1);
        if (!hasItem(player, SCARAB_EMBLEM_ITEM)) player.getInventory().adds(SCARAB_EMBLEM_ITEM, 1);
        if (quest.getStage(player) < STAGE_EMBLEM) setStage(player, STAGE_EMBLEM);
        return;
      case "PCiLey": // well: stone tablet found
        if (!hasItem(player, STONE_TABLET_ITEM)) player.getInventory().adds(STONE_TABLET_ITEM, 1);
        if (quest.getStage(player) < STAGE_TABLET) setStage(player, STAGE_TABLET);
        return;
      case "D9NBz-": // dig up an old chest
        if (!hasItem(player, CHEST_ITEM)) player.getInventory().adds(CHEST_ITEM, 1);
        if (quest.getStage(player) < STAGE_CHEST_DUG) setStage(player, STAGE_CHEST_DUG);
        return;
      case "aCMKC-": // scarab emblem placed in the pillar
        if (hasItem(player, SCARAB_EMBLEM_ITEM)) player.getInventory().deleteNumber(SCARAB_EMBLEM_ITEM, 1);
        setStage(player, STAGE_TOMB_OPEN);
        startTranscriptDeferred(player, MAISA_CAMP, "the-ruins-of-ullek-confirming-the-scarab-emblem-in-the-pillar");
        return;

      // Chapter 2 - the tomb.
      case "KgmAbA": // four emblems taken from the plaque
        if (freeSlots(player) < 4) {
          player.sendMessage("There are four emblems slotted into the plaque, but you don't have enough room to take them.");
          return;
        }
        player.getInventory().adds(HUMAN_EMBLEM_ITEM, 1);
        player.getInventory().adds(BABOON_EMBLEM_ITEM, 1);
        player.getInventory().adds(CROCODILE_EMBLEM_ITEM, 1);
        player.getInventory().adds(SCARAB_EMBLEM_ITEM, 1);
        flag(player, EMBLEMS_TAKEN_ATTRIBUTE, true);
        return;
      case "Gu8Ien": // urn: baboon emblem placed
        placeUrnEmblem(event, EMBLEM_TYPE_BABOON);
        return;
      case "1VnAt1": // urn: human emblem placed
        placeUrnEmblem(event, EMBLEM_TYPE_HUMAN);
        return;
      case "itrHbI": // urn: crocodile emblem placed
        placeUrnEmblem(event, EMBLEM_TYPE_CROCODILE);
        return;
      case "s3vs8q": // urn: scarab emblem placed
        placeUrnEmblem(event, EMBLEM_TYPE_SCARAB);
        return;
      case "RpCul3": // urn is empty
        event.handled = true;
        player.sendMessage(`The ${urnName(player)} urn is empty.`);
        return;
      case "vRtBKz": // lever by the urns: puzzle solved
        event.handled = true;
        player.sendMessage("As you pull the lever, you hear a loud click from the door.");
        if (quest.getStage(player) < STAGE_URN_PUZZLE) setStage(player, STAGE_URN_PUZZLE);
        return;
      case "MQFYdD": // rusty key opens the upper door
        event.handled = true;
        stepThrough(player, doorLocationByPlayer.get(player));
        doorLocationByPlayer.delete(player);
        if (quest.getStage(player) < STAGE_UPPER_OPEN) setStage(player, STAGE_UPPER_OPEN);
        return;
      case "ppIMnm": // rusty key found in the urn
        if (!hasItem(player, RUSTY_KEY_ITEM)) player.getInventory().adds(RUSTY_KEY_ITEM, 1);
        if (quest.getStage(player) < STAGE_KEY_TAKEN) setStage(player, STAGE_KEY_TAKEN);
        return;

      // Chapter 3 - cure me pox.
      case "7-ND2G": // Roger: continues with the meat dialogue
        event.handled = true;
        startTranscriptDeferred(
          player,
          MAISA_CAMP,
          "cure-me-pox-crossing-the-river-to-the-island-crossing-river-while-holding-meat"
        );
        return;
      case "V1ApkO": // Roger fed raw meat
      case "kg3k8k": // Roger fed cooked meat
        takeAnyMeat(player);
        removeTracked(player, "roger");
        if (quest.getStage(player) < STAGE_ROGER_FED) setStage(player, STAGE_ROGER_FED);
        player.moveTo(new Location(3353, 2926, 0));
        return;
      case "L2Rz7X": // lily picked
        if (!hasItem(player, LILY_ITEM)) player.getInventory().adds(LILY_ITEM, 1);
        if (quest.getStage(player) < STAGE_LILY_PICKED) setStage(player, STAGE_LILY_PICKED);
        sendQuestBits(player);
        return;
      case "EHRsdS": // Maisa departs to get the venom
        removeTracked(player, "nardah-maisa");
        if (quest.getStage(player) < STAGE_LILY_HUNT) setStage(player, STAGE_LILY_HUNT);
        return;
      case "sL-wqm": // Zahur gives you the first crate
      case "K9LyD1":
      case "qV0q-G":
        if (!hasItem(player, CURE_CRATE_ITEM)) player.getInventory().adds(CURE_CRATE_ITEM, 1);
        if (quest.getStage(player) < STAGE_CURE_TAKEN) setStage(player, STAGE_CURE_TAKEN);
        return;

      // Chapter 4 - the finale.
      case "PZPIrV": // cutscene: walking to the citizens
        if (quest.getStage(player) < STAGE_CITIZENS_FREED) setStage(player, STAGE_CITIZENS_FREED);
        return;
      case "31LmTQ": // scene pans to Maisa's camp
        player.moveTo(new Location(3378, 2790, 0));
        return;
      case "VNowdJ": // the Akh fight begins
        event.handled = true;
        player.moveTo(new Location(3378, 2790, 0));
        setStage(player, STAGE_AKH_FIGHT);
        return;
      case "1WDBi3": // Osman departs
        removeTracked(player, "osman");
        if (quest.getStage(player) < STAGE_SOPHANEM) setStage(player, STAGE_SOPHANEM);
        return;
      case "aHisly": // Maisa shows you a spear with a keris on the end
        if (freeSlots(player) > 0) {
          if (!hasItem(player, KERIS_PARTISAN_ITEM)) player.getInventory().adds(KERIS_PARTISAN_ITEM, 1);
        } else {
          setOwedPartisan(player, true);
        }
        return;
      case "VenWhi": // Maisa shows you an enchanted circlet
        if (freeSlots(player) > 0) {
          if (!hasItem(player, CIRCLET_OF_WATER_ITEM)) player.getInventory().adds(CIRCLET_OF_WATER_ITEM, 1);
        } else {
          setOwedCirclet(player, true);
        }
        return;
      case "MCAnTF": // the High Priest hands you a Circlet of Water
        event.handled = true;
        if (freeSlots(player) > 0 && !hasItem(player, CIRCLET_OF_WATER_ITEM)) {
          player.getInventory().adds(CIRCLET_OF_WATER_ITEM, 1);
          player.sendMessage("The High Priest hands you a Circlet of Water.");
          setOwedCirclet(player, false);
        } else {
          player.sendMessage("The High Priest tries to hand you a Circlet of Water, but you don't have enough room for it.");
        }
        return;
      case "eRrcx2": // Keris partisan found in the tent
        if (freeSlots(player) > 0 && !hasItem(player, KERIS_PARTISAN_ITEM)) {
          player.getInventory().adds(KERIS_PARTISAN_ITEM, 1);
          player.sendMessage("You find a Keris partisan in the tent.");
          setOwedPartisan(player, false);
        } else {
          player.sendMessage("You find a Keris partisan in the tent, but you don't have enough room to take it.");
        }
        return;
      case "oyt_LF": // Congratulations! Quest complete!
      case "am2Oh5":
        event.handled = true;
        if (!quest.isComplete(player)) quest.complete(player);
        return;
      default:
        return;
    }
  }

  function urnName(player) {
    const slot = urnSlotByPlayer.get(player);
    return URN_NAME_BY_SLOT[slot] ?? "northernmost";
  }

  function placeUrnEmblem(event, type) {
    const { player } = event;
    const slot = urnSlotByPlayer.get(player);
    const itemId = EMBLEM_ITEM_BY_TYPE[type];
    event.handled = true;
    if (!slot || !hasItem(player, itemId) || urnEmblem(player, slot) !== 0) return;
    player.getInventory().deleteNumber(itemId, 1);
    setUrnEmblem(player, slot, type);
    player.sendMessage(`You put the ${EMBLEM_NAME_BY_TYPE[type]} emblem in the ${URN_NAME_BY_SLOT[slot]} urn.`);
  }

  // ==========================================================================
  // Dialogue lines (end-of-conversation stage beats)
  // ==========================================================================

  function handleLine(event) {
    const { player, npcId, text } = event;
    const stage = quest.getStage(player);
    if (text === "Well let me know when you're ready, and I'll take you down there.") {
      flag(player, INTRO_ATTRIBUTE, true);
      setStage(player, STAGE_CAMP);
      return;
    }
    if (text === "Hmm... this seems familiar..." || text === "Hmm... this seems familiar... I'd better report back to Maisa.") {
      if (npcId === CITIZEN || npcId === WORLD_CITIZEN) flag(player, TALKED_CITIZEN_ATTRIBUTE, true);
      return;
    }
    if (MAISA_IDS.has(npcId) && text === "Will do." && stage === STAGE_GUARD_DEFEATED) {
      setStage(player, STAGE_CAMP_LEADS);
      return;
    }
    if (npcId === MEHHAR) {
      if (
        text === "You will find a key to the upper chamber in an urn to the back of this room. Now go, with the blessing of Scabaras." &&
        stage < STAGE_SPIRIT_MET
      ) {
        setStage(player, STAGE_SPIRIT_MET);
        return;
      }
      if (text === "You will find a key in an urn at the back of this room. May Scabaras guide you to success." && stage < STAGE_KEY_KNOWN) {
        setStage(player, STAGE_KEY_KNOWN);
        return;
      }
    }
    if (npcId === HIGH_PRIEST_OF_SCABARAS && text === "Good luck in your fight, adventurer. May Scabaras guide you.") {
      if (stage < STAGE_PRIEST_FREED) setStage(player, STAGE_PRIEST_FREED);
      return;
    }
    if (
      npcId === ZAHUR &&
      text === "Just adjust the individual heats until the overall temperature is at the marked level. Be warned, the equipment can be a bit temperamental sometimes." &&
      stage >= STAGE_LILY_HUNT &&
      stage < STAGE_EQUIPMENT &&
      hasItem(player, LILY_ITEM)
    ) {
      setStage(player, STAGE_EQUIPMENT);
      return;
    }
    if (HIGH_PRIEST_IDS.has(npcId) && text === "Thank you, friend. You are once again our saviour!") {
      if (hasItem(player, CURE_CRATE_ITEM)) player.getInventory().deleteNumber(CURE_CRATE_ITEM, 1);
      if (stage < STAGE_CRATE_DELIVERED) setStage(player, STAGE_CRATE_DELIVERED);
      return;
    }
  }

  // ==========================================================================
  // Quest start hook, item handlers
  // ==========================================================================

  function handleHook({ player, hook }) {
    if (hook !== START_HOOK) return;
    if (quest.getStage(player) !== STAGE_NOT_STARTED) return;
    setStage(player, STAGE_STARTED);
  }

  function handleItemAction(event) {
    const { player, itemId, option } = event;
    if (itemId === MESSAGE_ITEM && option === "Read") {
      event.handled = true;
      player.sendMessage("Head east from Sophanem and you'll find a camp by the cliffs. Meet me there as soon as you can.");
      return;
    }
    if (itemId === STONE_TABLET_ITEM && option === "Read") {
      event.handled = true;
      player.sendMessage("Akhem, the Zamorakians are coming. We have no quarrel with them, but they won't care.");
      player.sendMessage("We are already preparing our defences, but should Ullek fall, we can't let them defile Scabaras' precious artefacts.");
      player.sendMessage("I've locked what I can in a chest and buried it to the south. If I don't make it through the coming storm, you'll find the chest under the southernmost ritual pillar. Your name hides the code to unlock it.");
      player.sendMessage("With love, Sethos");
      return;
    }
    if (itemId === CHEST_ITEM && option === "Open") {
      event.handled = true;
      openChest(player);
    }
  }

  function openChest(player) {
    if (!hasItem(player, CHEST_ITEM)) return;
    player.getInventory().deleteNumber(CHEST_ITEM, 1);
    if (!hasItem(player, SCARAB_MOULD_ITEM)) player.getInventory().adds(SCARAB_MOULD_ITEM, 1);
    player.sendMessage("You unlock the chest and recover a scarab mould from within.");
    if (quest.getStage(player) < STAGE_MOULD) setStage(player, STAGE_MOULD);
  }

  function handleItemOnObject(event) {
    const { player, itemId } = event;
    const { objectId } = resolveObject(event);

    if (FURNACE_IDS.has(objectId)) {
      if (itemId === COAL_ITEM) {
        event.handled = true;
        startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-furnace-refuel-furnace");
        return;
      }
      if (itemId === TINDERBOX_ITEM) {
        event.handled = true;
        startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-furnace-light-furnace");
        return;
      }
      if (itemId === SCARAB_MOULD_ITEM) {
        event.handled = true;
        if (!hasItem(player, IRON_BAR_ITEM)) {
          player.sendMessage("You need an iron bar to use the scarab mould.");
          return;
        }
        player.getInventory().deleteNumber(SCARAB_MOULD_ITEM, 1);
        player.getInventory().deleteNumber(IRON_BAR_ITEM, 1);
        if (!hasItem(player, SCARAB_EMBLEM_ITEM)) player.getInventory().adds(SCARAB_EMBLEM_ITEM, 1);
        player.sendMessage("You craft a scarab emblem.");
        if (quest.getStage(player) < STAGE_EMBLEM) setStage(player, STAGE_EMBLEM);
        return;
      }
    }
    if (itemId === SPADE_ITEM && DIG_PILLARS.has(objectId)) {
      event.handled = true;
      if (freeSlots(player) === 0) {
        player.sendMessage("Your spade hits an old chest, but you don't have enough room to take it.");
        return;
      }
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-digging-under-the-ritual-pillar");
    }
  }

  // ==========================================================================
  // Object interactions
  // ==========================================================================

  function resolveObject(event) {
    // The interaction event already carries the player-resolved multi-loc
    // definition; fall back to resolving it for item-on-object events.
    const definition = event.definition ?? ObjectDefinition.forPlayer?.(event.objectId, event.player) ?? null;
    const objectId = definition?.id ?? event.objectId;
    const option = String(definition?.getInteractions?.()?.[event.clickType - 1] ?? "");
    return { definition, objectId, option };
  }

  function handleObjectInteraction(event) {
    const { player } = event;
    const { objectId, option } = resolveObject(event);
    const stage = quest.getStage(player);

    if (FURNACE_IDS.has(objectId)) {
      event.handled = true;
      if (option === "Inspect") {
        if (stage < STAGE_FURNACE_REFUELLED) setStage(player, STAGE_FURNACE_REFUELLED);
        startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-furnace-inspect-furnace");
        return;
      }
      if (option === "Refuel") {
        startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-furnace-refuel-furnace");
        return;
      }
      if (option === "Light") {
        startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-furnace-light-furnace");
        return;
      }
      if (option === "Smelt") {
        startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-furnace-smelt-furnace");
        return;
      }
      return;
    }

    if (objectId === PILLAR_INSPECT) {
      event.handled = true;
      if (stage < STAGE_RUINS) return;
      if (hasItem(player, SCARAB_EMBLEM_ITEM)) {
        startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-pillar");
      } else {
        startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-pillar", sliceBeforeChoice);
      }
      return;
    }
    if (objectId === PILLAR_EMBLEM) {
      event.handled = true;
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-confirming-the-scarab-emblem-in-the-pillar");
      return;
    }
    if (objectId === WELL_SEARCH) {
      event.handled = true;
      if (stage < STAGE_RUINS) return;
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-well");
      return;
    }
    if (objectId === ENTRY_SEALED) {
      event.handled = true;
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-entry");
      return;
    }
    if (objectId === ENTRY_OPEN) {
      event.handled = true;
      enterTomb(player);
      return;
    }
    if (objectId === CAMP_EQUIPMENT) {
      event.handled = true;
      if (stage < STAGE_CAMP_LEADS) return;
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-talking-to-maisa-searching-the-camping-equipment");
      return;
    }
    if (objectId === CAMP_TENT) {
      event.handled = true;
      if (!owedPartisan(player)) return;
      startTranscript(api, player, MAISA_CAMP, PAGE, "fight-with-the-menaphite-akh-talking-to-maisa-or-the-high-priest-search-tent-before-getting-the-reward");
      return;
    }
    if (objectId === CAMP_SPADE) {
      event.handled = true;
      if (!hasItem(player, SPADE_ITEM)) player.getInventory().adds(SPADE_ITEM, 1);
      return;
    }
    if (objectId === NECROPOLIS_RUBBLE) {
      event.handled = true;
      climbNecropolisRubble(player);
      return;
    }
    if (objectId === LEVER_TOMB_ON || objectId === LEVER_TOMB_OFF) {
      event.handled = true;
      pullTombLever(player, event.location);
      return;
    }
    if (objectId === LEVER_URN || objectId === LEVER_URN_ON) {
      event.handled = true;
      if (stage < STAGE_URN_CHAMBER) return;
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-pulling-the-lever-by-the-urns");
      return;
    }
    if (objectId === DOOR_LEVERS_A || objectId === DOOR_LEVERS_B) {
      event.handled = true;
      openLeversDoor(player, event.location);
      return;
    }
    if (objectId === DOOR_UPPER) {
      event.handled = true;
      openUpperDoor(player, event.location);
      return;
    }
    if (objectId === DOOR_CHAMPION) {
      event.handled = true;
      openChampionDoor(player, event.location);
      return;
    }
    if (objectId === EMBLEM_PLAQUE) {
      event.handled = true;
      if (stage < STAGE_URN_CHAMBER || emblemsTaken(player)) return;
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-taking-emblems-from-the-plaque");
      return;
    }
    if (objectId === RIDDLE_PLAQUE) {
      event.handled = true;
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-inspecting-the-south-west-plaque");
      return;
    }
    if (objectId === URN_INSPECT) {
      event.handled = true;
      urnInspect(player, event.location);
      return;
    }
    if (objectId === KEY_URN) {
      event.handled = true;
      if (stage < STAGE_KEY_KNOWN) return;
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-searching-the-urn-by-mehhar");
      return;
    }
    if (objectId === LILY) {
      event.handled = true;
      pickLily(player);
      return;
    }
    if (objectId === LILY_PICKED) {
      event.handled = true;
      startTranscript(
        api,
        player,
        MAISA_CAMP,
        PAGE,
        "cure-me-pox-crossing-the-river-to-the-island-picking-the-lily",
        (steps) => sliceFromCondition(steps, "eAnITS")
      );
      return;
    }
    if (objectId === STEPPING_STONE) {
      event.handled = true;
      crossSteppingStone(player);
      return;
    }
    if (objectId === CHEMISTRY_TABLE) {
      event.handled = true;
      useChemistryTable(player);
      return;
    }
  }

  // ==========================================================================
  // Object behaviours
  // ==========================================================================

  function climbNecropolisRubble(player) {
    if (quest.getStage(player) < STAGE_NECROPOLIS) return;
    player.moveTo(new Location(3348, 2755, 0));
    if (!entryInspected(player)) {
      flag(player, ENTRY_INSPECTED_ATTRIBUTE, true);
      if (quest.getStage(player) < STAGE_ENTRY_INSPECTED) setStage(player, STAGE_ENTRY_INSPECTED);
      startTranscript(api, player, MAISA_CAMP, PAGE, "starting-off-inspecting-the-blocked-entry-after-finishing-the-cutscene");
    }
  }

  function enterTomb(player) {
    const stage = quest.getStage(player);
    if (stage === STAGE_RUINS) {
      // The first entry opens the upper ruins; the scabarites are already below.
      setStage(player, STAGE_FURNACE_INSPECTED);
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-entering-the-ruins");
      return;
    }
    if (stage < STAGE_TOMB_OPEN) {
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-interacting-with-objects-entry");
      return;
    }
    player.moveTo(new Location(3438, 9248, 0));
    if (stage < STAGE_TOMB_ENTERED) setStage(player, STAGE_TOMB_ENTERED);
  }

  function pullTombLever(player, location) {
    const stage = quest.getStage(player);
    if (stage < STAGE_MAGES_DEAD || stage > STAGE_LEVERS_DONE) return;
    const bit = location && location.y <= 9248 ? 1 : 2;
    const was = leverBits(player);
    const next = was | bit;
    if (next === was) {
      startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-pulling-levers-when-the-lever-resets");
      return;
    }
    setLeverBits(player, next);
    const done = (next & 3) === 3;
    setStage(player, done ? STAGE_LEVERS_DONE : STAGE_LEVER_ONE);
    startTranscript(
      api,
      player,
      MAISA_CAMP,
      PAGE,
      done
        ? "the-ruins-of-ullek-pulling-levers-pulling-the-second-lever"
        : "the-ruins-of-ullek-pulling-levers-pulling-the-first-lever"
    );
  }

  function urnInspect(player, location) {
    if (quest.getStage(player) < STAGE_URN_CHAMBER) return;
    const y = location?.y ?? 0;
    const slot = y >= 9251 ? 1 : y >= 9249 ? 2 : y >= 9247 ? 3 : 4;
    urnSlotByPlayer.set(player, slot);
    startTranscript(
      api,
      player,
      MAISA_CAMP,
      PAGE,
      urnEmblem(player, slot)
        ? "the-ruins-of-ullek-urns-inspecting-a-full-urn"
        : "the-ruins-of-ullek-urns-inspecting-an-empty-urn"
    );
  }

  function openUpperDoor(player, location) {
    doorLocationByPlayer.set(player, location ?? player.getLocation());
    startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-opening-the-upstairs-locked-door");
  }

  /** The lever-opened downstairs door (43961/43962); both leaves route here. */
  function openLeversDoor(player, location) {
    if (quest.getStage(player) >= STAGE_LEVERS_DONE) {
      stepThrough(player, location);
      if (quest.getStage(player) < STAGE_URN_CHAMBER) setStage(player, STAGE_URN_CHAMBER);
      return;
    }
    startTranscript(api, player, MAISA_CAMP, PAGE, "the-ruins-of-ullek-opening-the-downstairs-locked-door");
  }

  /** The Champion door (43960) beyond the altar. */
  function openChampionDoor(player, location) {
    stepThrough(player, location);
    const stage = quest.getStage(player);
    if (stage >= STAGE_CHAMPION_DEAD && stage < STAGE_ALTAR) setStage(player, STAGE_ALTAR);
  }

  /**
   * Doors.plugin.js claims every "Door" and swaps 43960/43961/43962/43963 before
   * this plugin's object hook runs. It emits door:toggle first, so claim the
   * quest doors here and run the quest's own logic.
   */
  function claimQuestDoor(request) {
    if (request.handled) return;
    const { player, objectId, location } = request;
    if (objectId === DOOR_LEVERS_A || objectId === DOOR_LEVERS_B) {
      request.handled = true;
      openLeversDoor(player, location);
      return;
    }
    if (objectId === DOOR_CHAMPION) {
      request.handled = true;
      openChampionDoor(player, location);
      return;
    }
    if (objectId === DOOR_UPPER) {
      request.handled = true;
      openUpperDoor(player, location);
    }
  }

  function crossSteppingStone(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_LILY_HUNT) {
      startTranscript(api, player, MAISA_CAMP, PAGE, "cure-me-pox-crossing-the-river-to-the-island-crossing-river-again-without-meat");
      return;
    }
    if (stage >= STAGE_ROGER_FED) {
      player.moveTo(new Location(3353, 2926, 0));
      return;
    }
    if (!hasMeat(player)) {
      startTranscript(api, player, MAISA_CAMP, PAGE, "cure-me-pox-crossing-the-river-to-the-island-crossing-river-again-without-meat");
      return;
    }
    if (stage < STAGE_CROC_MET) setStage(player, STAGE_CROC_MET);
    startTranscript(
      api,
      player,
      MAISA_CAMP,
      PAGE,
      "cure-me-pox-crossing-the-river-to-the-island-crossing-river-while-holding-meat"
    );
  }

  function pickLily(player) {
    if (quest.getStage(player) < STAGE_ROGER_FED) return;
    startTranscript(api, player, MAISA_CAMP, PAGE, "cure-me-pox-crossing-the-river-to-the-island-picking-the-lily");
  }

  function useChemistryTable(player) {
    if (quest.getStage(player) < STAGE_EQUIPMENT) return;
    startTranscript(api, player, MAISA_CAMP, PAGE, "cure-me-pox-warming-up-the-equipment");
  }

  /** Mirror the player to the tile past a blocking object tile. */
  function stepThrough(player, location) {
    if (!location) return;
    const current = player.getLocation();
    const dx = current.getX() - location.x;
    const dy = current.getY() - location.y;
    const destination =
      Math.abs(dx) >= Math.abs(dy)
        ? new Location(location.x - (dx >= 0 ? 1 : -1), location.y, current.getZ())
        : new Location(location.x, location.y - (dy >= 0 ? 1 : -1), current.getZ());
    player.moveTo(destination);
  }

  // ==========================================================================
  // Deaths
  // ==========================================================================

  function handleNpcDeath(event) {
    const { killer, npc } = event;
    if (!killer || !npc) return;
    const tracked = trackedNpcs.get(killer);
    if (!tracked) return;
    const stage = quest.getStage(killer);
    if (tracked.get("guard") === npc) {
      tracked.delete("guard");
      if (stage === STAGE_GUARD_FIGHT) setStage(killer, STAGE_GUARD_DEFEATED);
      return;
    }
    if (tracked.get("mage1") === npc || tracked.get("mage2") === npc) {
      tracked.delete(tracked.get("mage1") === npc ? "mage1" : "mage2");
      if (!tracked.get("mage1") && !tracked.get("mage2") && stage === STAGE_TOMB_ENTERED) {
        setStage(killer, STAGE_MAGES_DEAD);
      }
      return;
    }
    if (tracked.get("champion") === npc) {
      tracked.delete("champion");
      if (stage === STAGE_UPPER_OPEN) setStage(killer, STAGE_CHAMPION_DEAD);
      return;
    }
    if (tracked.get("akh") === npc) {
      tracked.delete("akh");
      if (stage === STAGE_AKH_FIGHT) setStage(killer, STAGE_AKH_DEAD);
    }
  }

  // ==========================================================================
  // Lifecycle, journal, reward
  // ==========================================================================

  function handleLogin({ player }) {
    installTombLevers();
    syncNpcs(player);
    sendQuestBits(player);
  }

  function handleBootstrap({ player }) {
    sendQuestBits(player);
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Jamila slipped me a message from Maisa and I met her camp</str>",
        "<str>east of Sophanem. Together we uncovered Amascut's plot.</str>",
        "<str>I freed the High Priest of Scabaras and helped Zahur cure</str>",
        "<str>the pox, then defeated the Menaphite Akh.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_FINALE) {
      return [
        "<str>Jamila slipped me a message from Maisa and I met her camp</str>",
        "<str>east of Sophanem. Together we uncovered Amascut's plot.</str>",
        "<str>I freed the High Priest of Scabaras and helped Zahur cure</str>",
        "<str>the pox, and delivered the cure to Sophanem.</str>",
        "",
        "I should speak to <col=800000>Maisa</col> at the necropolis.",
      ];
    }
    if (stage >= STAGE_NARDAH) {
      return [
        "<str>Jamila slipped me a message from Maisa and I met her camp</str>",
        "<str>east of Sophanem. Together we uncovered Amascut's plot.</str>",
        "",
        "I should help <col=800000>Zahur</col> in Nardah cure the pox.",
        stage >= STAGE_LILY_PICKED
          ? "I have the <col=800000>Lily of the Elid</col>; I should take it to Zahur."
          : "I need a <col=800000>Lily of the Elid</col> from the island west of Nardah.",
      ];
    }
    if (stage >= STAGE_PRIEST_FREED) {
      return [
        "<str>Jamila slipped me a message from Maisa and I met her camp</str>",
        "<str>east of Sophanem. Together we uncovered Amascut's plot.</str>",
        "<str>I freed the High Priest of Scabaras from Amascut's control.</str>",
        "",
        "He told me to meet <col=800000>Maisa</col> in <col=800000>Nardah</col>.",
      ];
    }
    if (stage >= STAGE_URN_PUZZLE) {
      return [
        "<str>Jamila slipped me a message from Maisa and I met her camp</str>",
        "<str>east of Sophanem. Together we uncovered Amascut's plot.</str>",
        "",
        "I should free the <col=800000>High Priest of Scabaras</col>",
        "from Amascut's control in the upper chamber.",
      ];
    }
    if (stage >= STAGE_RUINS) {
      return [
        "<str>Jamila slipped me a message from Maisa and I met her camp</str>",
        "<str>east of Sophanem. Together we uncovered Amascut's plot.</str>",
        "",
        "I should explore the <col=800000>Ruins of Ullek</col> east of the",
        "necropolis and find out what the scabarites are doing.",
      ];
    }
    if (stage >= STAGE_NECROPOLIS) {
      return [
        "<str>Jamila slipped me a message from Maisa and I met her camp</str>",
        "<str>east of Sophanem.</str>",
        "",
        "I should inspect the blocked entry at the necropolis and",
        "question a <col=800000>citizen</col> or <col=800000>guard</col>.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "<str>Jamila slipped me a message from Maisa.</str>",
        "",
        "I should read the <col=800000>message</col> and meet Maisa at",
        "her camp by the cliffs east of Sophanem.",
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Jamila</col>",
      "at her stall in <col=800000>Sophanem</col>.",
      "",
      "I must have completed Contact! and Icthlarin's Little Helper",
      "and have 62 Agility, 55 Crafting and 55 Firemaking.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.AGILITY, 50000);
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  api.persistAttribute(INTRO_ATTRIBUTE);
  api.persistAttribute(ENTRY_INSPECTED_ATTRIBUTE);
  api.persistAttribute(TALKED_CITIZEN_ATTRIBUTE);
  api.persistAttribute(URNS_ATTRIBUTE);
  api.persistAttribute(LEVERS_ATTRIBUTE);
  api.persistAttribute(EMBLEMS_TAKEN_ATTRIBUTE);
  api.persistAttribute(OWED_PARTISAN_ATTRIBUTE);
  api.persistAttribute(OWED_CIRCLET_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "beneath_cursed_sands",
    name: "Beneath Cursed Sands",
    varpId: 3421, // bcs_primary
    varbitId: 13841, // bcs, bits 0-8
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [{ skillId: Skill.AGILITY.getIndex(), amount: 50000, label: "Agility" }],
    scrollItemId: KERIS_PARTISAN_ITEM,
    otherRewards: ["Keris partisan", "Circlet of water"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleHook);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:line", handleLine);
  api.onCustomEvent("door:toggle", claimQuestDoor);
  api.onItemAction(handleItemAction);
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onObjectInteraction(handleObjectInteraction);
  api.onNpcDeath(handleNpcDeath);
  api.onPlayerLogin(handleLogin);
  api.onCustomEvent("player:bootstrap-complete", handleBootstrap);
};
