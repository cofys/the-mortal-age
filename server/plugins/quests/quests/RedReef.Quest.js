/**
 * The Red Reef (members).
 *
 * The words come from the "The Red Reef" transcript page (npc-dialogues.json); this
 * plugin supplies the variant selector for every quest NPC, the start hook, the prose
 * condition answers (diving gear/space/dragon scimitar), the display-case and coral
 * dredger actions, the Last Light/Zenith/Great Conch spawns and the reward.
 *
 * Stages (varbit 18335 "trr", varp 4962 bits 0-5; matches the cache transforms and
 * the OSRS stage values, evidence below):
 *   0  not started
 *   2  asked to look for Floopa (ask around town)
 *   4  told Floopa headed to the Sacred Grove (find Elder Katt)
 *   6  Elder Katt let you into the Grove (find Floopa)
 *   8  found Floopa (sail to Red Rock)
 *   10 arrived at Red Rock (talk to the receptionist)
 *   12 receptionist arranged a meeting (inspect the display cases)
 *   14 displays inspected (meet Theodore Paxton)
 *   16 tasked with Black Eye Bethel at Last Light
 *   20 docked at Last Light (the pirate ship fight is passed through, see gaps)
 *   22 pirates defeated (climb the lighthouse)
 *   24 Black Eye Bethel defeated (return to Paxton)
 *   26 Paxton sends you to the Zenith
 *   28 aboard the Zenith (talk to Spencer Brentwood)
 *   30 diving with Spencer on the seabed
 *   32 repair the northern coral dredger
 *   34 repair it again after the giant lobster
 *   36 report to Spencer at the eastern dredger
 *   38 hear Spencer's plan back on the surface
 *   40 report to Floopa and Elder Raley
 *   42 complete
 *
 * Varbit evidence: quest id 7107 -> varbit 18335 in cache script 4024 (the quest list
 * script); lookup-gameval names it "trr", varp 4962 bits 0-5; sibling varbits are the
 * display cases (18338-18341). Cache npc transforms align with the values above
 * (Floopa appears at >= 6, Bethel's four phases at >= 18, Spencer aboard at >= 28) and
 * loc 58497 gains its "Repair" option at 32-34.
 *
 * Source: OSRS Wiki (https://oldschool.runescape.wiki/w/The_Red_Reef,
 * /w/Transcript:The_Red_Reef and /w/Transcript:The_Red_Reef/Journal).
 * Rewards per the wiki: 2 Quest points, 15,000 Sailing XP, 5,000 Smithing XP, the
 * Bosun's workbench schematic (33423) and access to the Sacred Grove.
 *
 * Gaps/approximations:
 * - No boat travel or ship combat. Reaching Red Rock sets 10; entering Last Light
 *   plays the wiki's approach/sunk messages and advances to 20 (stage 18 is passed
 *   through). The six pirates and Black Eye Bethel are spawned as a stand-in fight;
 *   Bethel's scimitar phases, charge attack and prayer disable are not scripted, and
 *   she has no Talk-to so her transcript lines do not play.
 * - The display-case prose is "unavailable" in the transcript dump, so inspecting a
 *   case only marks its varbit (18338-18341).
 * - Diving is a teleport to the seabed rather than boat/sea travel; Spencer's gear
 *   items are granted by the transcript's "gives you some diving equipment" step.
 * - The camphor-tree shout and freeing the parrot are not implemented (the parrot
 *   free is optional in OSRS and its cage npc is not spawned).
 */
module.exports = function registerRedReefQuest(api) {
  const { Equipment, ItemIdentifiers, Location, NpcIdentifiers, ObjectIdentifiers, Skill } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  // ==========================================================================
  // Ids
  // ==========================================================================

  const ELDER_RALEY_NPC_ID = NpcIdentifiers.ELDER_RALEY; // 15002
  const ELDER_KATT_NPC_ID = NpcIdentifiers.ELDER_KATT; // 14846
  const GUPPA_NPC_ID = NpcIdentifiers.GUPPA; // 15064
  const FLOOPA_GROVE_NPC_ID = NpcIdentifiers.FLOOPA_4; // 15012 (appears at stage >= 6)
  const FLOOPA_HOUSE_NPC_ID = NpcIdentifiers.FLOOPA_3; // 14994
  const RECEPTIONIST_NPC_ID = NpcIdentifiers.RECEPTIONIST; // 15013
  const THEODORE_PAXTON_NPC_ID = NpcIdentifiers.THEODORE_PAXTON; // 15015
  const SPENCER_BRENTWOOD_NPC_ID = NpcIdentifiers.SPENCER_BRENTWOOD; // 15017
  // Spencer's diving parents are nameless in NpcIdentifiers (cache 15018/15019).
  const SPENCER_DIVING_A_NPC_ID = 15018; // TRR_SPENCER_BRENTWOOD_DIVING_A
  const SPENCER_DIVING_B_NPC_ID = 15020; // SPENCER_BRENTWOOD_2, TRR_SPENCER_BRENTWOOD_DIVING_VIS
  const BLACK_EYE_BETHEL_NPC_ID = NpcIdentifiers.BLACK_EYE_BETHEL; // 15025
  const GIANT_LOBSTER_NPC_ID = NpcIdentifiers.GIANT_LOBSTER_4; // 15034
  const PIRATE_NPC_IDS = [
    NpcIdentifiers.PIRATE_53, // 15021
    NpcIdentifiers.PIRATE_54, // 15022
    NpcIdentifiers.PIRATE_55, // 15023
    NpcIdentifiers.PIRATE_56, // 15024
  ];

  /** The tortugans that tell you Floopa went to the Sacred Grove (page variants). */
  const FLOOPA_SEARCH_VARIANTS = new Map([
    [NpcIdentifiers.ELDER_COCO, "the-search-for-floopa-talking-to-elder-coco"], // 14828
    [NpcIdentifiers.ELDER_COCO_2, "the-search-for-floopa-talking-to-elder-coco"], // 14829
    [NpcIdentifiers.ELDER_STROM, "the-search-for-floopa-talking-to-elder-strom"], // 14831
    [NpcIdentifiers.ELDER_STROM_2, "the-search-for-floopa-talking-to-elder-strom"], // 14832
    [NpcIdentifiers.ELDER_KRILL, "the-search-for-floopa-talking-to-elder-krill"], // 14834
    [NpcIdentifiers.ELDER_KRILL_2, "the-search-for-floopa-talking-to-elder-krill"], // 14835
    [NpcIdentifiers.ELDER_BLUNN, "the-search-for-floopa-talking-to-elder-blunn"], // 14837
    [NpcIdentifiers.ELDER_BLUNN_2, "the-search-for-floopa-talking-to-elder-blunn"], // 14838
    [NpcIdentifiers.MAG, "the-search-for-floopa-talking-to-mag"], // 14840
    [NpcIdentifiers.MAG_2, "the-search-for-floopa-talking-to-mag"], // 14841
    [NpcIdentifiers.ELDER_TORGAN, "the-search-for-floopa-talking-to-elder-torgan"], // 14845
    [NpcIdentifiers.LEFF, "the-search-for-floopa-talking-to-leff"], // 14848
    [NpcIdentifiers.DALNA, "the-search-for-floopa-talking-to-dalna"], // 14849
    [NpcIdentifiers.FINN_2, "the-search-for-floopa-talking-to-finn"], // 14850
    [NpcIdentifiers.AMMA, "the-search-for-floopa-talking-to-amma"], // 14851
    [GUPPA_NPC_ID, "the-search-for-floopa-talking-to-guppa"],
  ]);

  const DEEP_SEA_HELMET_ITEM_ID = ItemIdentifiers.DEEP_SEA_HELMET_4; // 31401
  const DEEP_SEA_APPARATUS_ITEM_ID = ItemIdentifiers.DEEP_SEA_APPARATUS_4; // 31403
  const MEDALLION_OF_THE_DEEP_ITEM_ID = ItemIdentifiers.MEDALLION_OF_THE_DEEP; // 32386
  const BOSUNS_WORKBENCH_SCHEMATIC_ITEM_ID = ItemIdentifiers.BOSUNS_WORKBENCH_SCHEMATIC; // 33423
  const DRAGON_SCIMITAR_ITEM_ID = ItemIdentifiers.DRAGON_SCIMITAR; // 4587

  /** Deep-sea gear and the medallion all satisfy the wiki's diving conditions. */
  const DIVING_ITEM_IDS = new Set([
    DEEP_SEA_HELMET_ITEM_ID,
    DEEP_SEA_APPARATUS_ITEM_ID,
    MEDALLION_OF_THE_DEEP_ITEM_ID,
  ]);

  /** Display case object -> its varbit (cache loc 58491-58494). */
  const DISPLAY_CASE_VARBITS = new Map([
    [ObjectIdentifiers.DISPLAY, 18338], // 58491
    [ObjectIdentifiers.DISPLAY_2, 18339], // 58492
    [ObjectIdentifiers.DISPLAY_3, 18340], // 58493
    [ObjectIdentifiers.DISPLAY_4, 18341], // 58494
  ]);
  const CORAL_DREDGER_REPAIR_OBJECT_ID = ObjectIdentifiers.CORAL_DREDGER_2; // 58500

  // ==========================================================================
  // Stages, page and step ids
  // ==========================================================================

  const VARBIT_THE_RED_REEF = 18335; // "trr"
  const VARP_THE_RED_REEF = 4962;

  const STAGE_STARTED = 2;
  const STAGE_GROVE_KNOWN = 4;
  const STAGE_GROVE_ACCESS = 6;
  const STAGE_FLOOPA_FOUND = 8;
  const STAGE_RED_ROCK = 10;
  const STAGE_MEETING_READY = 12;
  const STAGE_MEETING_ARRANGED = 14;
  const STAGE_PAXTON_TASKED = 16;
  const STAGE_REACH_LAST_LIGHT = 20;
  const STAGE_KILL_PIRATES = 22;
  const STAGE_BETHEL_DEAD = 24;
  const STAGE_ZENITH_KNOWN = 26;
  const STAGE_ABOARD_ZENITH = 28;
  const STAGE_DIVING = 30;
  const STAGE_FIXING_DREDGER = 32;
  const STAGE_DREDGER_AGAIN = 34;
  const STAGE_REPORT_EAST = 36;
  const STAGE_SURFACE_PLAN = 38;
  const STAGE_RETURN_FLOOPA = 40;
  const STAGE_COMPLETE = 42;

  const SAILING_REQUIREMENT = 52;
  const SMITHING_REQUIREMENT = 48;
  const SAILING_XP = 15000;
  const SMITHING_XP = 5000;

  const PAGE = "The Red Reef";
  const START_HOOK = "quest:the-red-reef:start";

  // Condition step ids (research pack).
  const NO_DIVING_GEAR_CONDITION_IDS = new Set(["x3HLXd", "BOlODW", "VE5dY_"]);
  const HAS_DIVING_GEAR_CONDITION_IDS = new Set(["tBtk3j", "_LVHD3"]);
  const GEAR_IN_INVENTORY_CONDITION_ID = "UAR3gf";
  const WEARING_GEAR_CONDITION_ID = "x_TGNS";
  const NO_GEAR_NO_SPACE_CONDITION_IDS = new Set(["wBzwEY", "SPJpPe"]);
  const FINALE_NO_SPACE_CONDITION_ID = "HJgzIM";
  const NO_DRAGON_SCIMITAR_CONDITION_ID = "OkLA-m";
  const HAS_DRAGON_SCIMITAR_CONDITION_ID = "cfTVSP";

  // Action/message step ids (research pack).
  const GIVE_DIVING_GEAR_ACTION_IDS = new Set(["Wq1UDW", "pHjCEB"]);
  const DREDGER_REPAIRED_ACTION_ID = "XpLPqf";
  const REPAIR_DREDGER_MESSAGE_ID = "A1Ua7w";
  const SURFACE_RETURN_MESSAGE_ID = "NpiI3y";
  const SHIPS_SUNK_MESSAGE_ID = "58k-ri";
  const COMPLETE_ACTION_ID = "vNjARR";

  const APPROACHING_LAST_LIGHT_VARIANT = "the-pirates-of-last-light-when-approaching-the-island";
  const SHIPS_SUNK_VARIANT = "the-pirates-of-last-light-after-sinking-the-pirate-ships";
  const REPAIR_DREDGER_VARIANT = "underwater-repairing-the-dredger";
  const SURFACE_PLAN_LAST_LINE = "Thank you. I'd best be on my way.";
  const FINALE_GIFT_LINE = "Now, before you go I had something to give you that you might find useful.";
  const DIVE_CONFIRM_OPTION = "Let's go.";

  // ==========================================================================
  // Zones and spawn points
  // ==========================================================================

  const RED_ROCK_ZONE = { minX: 2780, maxX: 2815, minY: 2497, maxY: 2535, levels: [0] };
  const LAST_LIGHT_ZONE = { minX: 2845, maxX: 2872, minY: 2316, maxY: 2336, levels: [0, 1, 2] };

  const FLOOPA_GROVE_TILE = { x: 3194, y: 2490, z: 0 };
  const FLOOPA_HOUSE_TILE = { x: 3186, y: 2405, z: 0 };
  const SPENCER_SURFACE_TILE = { x: 2878, y: 2505, z: 0 };
  const SPENCER_DIVING_A_TILE = { x: 2837, y: 8922, z: 1 };
  const SPENCER_DIVING_B_TILE = { x: 2857, y: 8915, z: 1 };
  const SEABED_DIVE_TILE = { x: 2836, y: 8922, z: 1 };
  const BETHEL_TILE = { x: 2862, y: 2323, z: 2 };
  const LOBSTER_TILE = { x: 2841, y: 8946, z: 1 };
  // Walkable (object-free) tiles on the Last Light isle from the loc dump.
  const PIRATE_TILES = [
    { x: 2849, y: 2324 },
    { x: 2852, y: 2321 },
    { x: 2852, y: 2325 },
    { x: 2856, y: 2321 },
    { x: 2847, y: 2326 },
    { x: 2855, y: 2333 },
  ];

  let quest;
  /** Per-player quest NPCs (owner-only spawns, resynced on stage changes/login). */
  const questSpawns = new Map();
  /**
   * The finale's reward is an action step after the wiki's `end` marker: the
   * runtime closes on `end` before reaching it, so completion is armed by Raley's
   * gift line (only with a free slot) and fired on that end step.
   */
  const finaleRewardPending = new WeakSet();

  // ==========================================================================
  // Helpers
  // ==========================================================================

  const held = (player, itemId) => player.getInventory().getAmount(itemId) > 0;
  const freeSlots = (player) => player.getInventory().getFreeSlots();

  function wearing(player, itemIds) {
    for (const item of player.getEquipment().getItems()) {
      if (item && itemIds.has(item.getId())) return true;
    }
    return false;
  }

  const wearingDivingGear = (player) => wearing(player, DIVING_ITEM_IDS);
  const carryingDivingGear = (player) =>
    [...DIVING_ITEM_IDS].some((itemId) => held(player, itemId));
  const hasDivingGear = (player) => wearingDivingGear(player) || carryingDivingGear(player);

  function wearingDragonScimitar(player) {
    return player.getEquipment().get(Equipment.WEAPON_SLOT)?.getId?.() === DRAGON_SCIMITAR_ITEM_ID;
  }

  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    if (skills.getMaxLevel(Skill.SAILING) < SAILING_REQUIREMENT) return false;
    if (skills.getMaxLevel(Skill.SMITHING) < SMITHING_REQUIREMENT) return false;
    const request = { player, key: "troubled_tortugans", complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function grantDivingEquipment(player) {
    if (freeSlots(player) < 2) return;
    player.getInventory().adds(DEEP_SEA_HELMET_ITEM_ID, 1);
    player.getInventory().adds(DEEP_SEA_APPARATUS_ITEM_ID, 1);
  }

  function displayCasesDone(player) {
    const sender = player.getPacketSender();
    return [...DISPLAY_CASE_VARBITS.values()].every((varbit) => sender.getVarbit(varbit) === 1);
  }

  function sendDisplayCaseVarps(player) {
    const sender = player.getPacketSender();
    for (const varbit of DISPLAY_CASE_VARBITS.values()) sender.sendVarbit(varbit, 1);
  }

  // ==========================================================================
  // Spawns
  // ==========================================================================

  function matchesSpawn(npc, spec) {
    const location = npc?.getLocation?.();
    return (
      npc?.getId?.() === spec.id &&
      location?.getX?.() === spec.x &&
      location?.getY?.() === spec.y &&
      location?.getZ?.() === spec.z
    );
  }

  function syncSpawn(player, state, key, spec) {
    const current = state[key];
    if (!spec) {
      if (current) api.removeNpc(current);
      state[key] = null;
      return;
    }
    if (current && matchesSpawn(current, spec)) return;
    if (current) api.removeNpc(current);
    state[key] = api.spawnNpc({ ...spec, wanderRadius: 0, owner: player, ownerOnly: true }) ?? null;
  }

  function syncPirates(player, state, stage) {
    const wanted = stage >= STAGE_REACH_LAST_LIGHT && stage < STAGE_KILL_PIRATES;
    if (!wanted) {
      for (const npc of state.pirates) api.removeNpc(npc);
      state.pirates = [];
      return;
    }
    if (state.pirates.length === PIRATE_TILES.length) return;
    for (const npc of state.pirates) api.removeNpc(npc);
    state.pirates = PIRATE_TILES.map((tile, index) =>
      api.spawnNpc({
        id: PIRATE_NPC_IDS[index % PIRATE_NPC_IDS.length],
        x: tile.x,
        y: tile.y,
        z: 0,
        wanderRadius: 0,
        owner: player,
        ownerOnly: true,
      })
    ).filter(Boolean);
  }

  /** Keeps each player's quest NPCs in step with their stage (call on change/login). */
  function ensureSpawns(player) {
    if (!player || player.isPlayerBot?.() === true || !quest) return;
    const stage = quest.getStage(player);
    const state = questSpawns.get(player) ?? {
      floopa: null,
      spencer: null,
      pirates: [],
      bethel: null,
      lobster: null,
    };
    questSpawns.set(player, state);

    let floopa = null;
    if (stage >= STAGE_GROVE_ACCESS && stage < STAGE_RED_ROCK) {
      floopa = { id: FLOOPA_GROVE_NPC_ID, ...FLOOPA_GROVE_TILE };
    } else if (stage >= STAGE_RETURN_FLOOPA && stage < STAGE_COMPLETE) {
      floopa = { id: FLOOPA_HOUSE_NPC_ID, ...FLOOPA_HOUSE_TILE };
    }
    syncSpawn(player, state, "floopa", floopa);

    let spencer = null;
    if (stage >= STAGE_ZENITH_KNOWN && stage < STAGE_DIVING) {
      spencer = { id: SPENCER_BRENTWOOD_NPC_ID, ...SPENCER_SURFACE_TILE };
    } else if (stage >= STAGE_DIVING && stage < STAGE_FIXING_DREDGER) {
      spencer = { id: SPENCER_DIVING_A_NPC_ID, ...SPENCER_DIVING_A_TILE };
    } else if (stage >= STAGE_FIXING_DREDGER && stage < STAGE_SURFACE_PLAN) {
      spencer = { id: SPENCER_DIVING_B_NPC_ID, ...SPENCER_DIVING_B_TILE };
    } else if (stage >= STAGE_SURFACE_PLAN && stage < STAGE_RETURN_FLOOPA) {
      spencer = { id: SPENCER_BRENTWOOD_NPC_ID, ...SPENCER_SURFACE_TILE };
    }
    syncSpawn(player, state, "spencer", spencer);

    syncPirates(player, state, stage);

    const bethel =
      stage >= STAGE_KILL_PIRATES && stage < STAGE_BETHEL_DEAD
        ? { id: BLACK_EYE_BETHEL_NPC_ID, ...BETHEL_TILE }
        : null;
    syncSpawn(player, state, "bethel", bethel);
  }

  function spawnLobster(player) {
    const state = questSpawns.get(player);
    if (!state || state.lobster) return;
    state.lobster = api.spawnNpc({
      id: GIANT_LOBSTER_NPC_ID,
      x: LOBSTER_TILE.x,
      y: LOBSTER_TILE.y,
      z: LOBSTER_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
  }

  function clearSpawns(player) {
    const state = questSpawns.get(player);
    if (!state) return;
    for (const key of ["floopa", "spencer", "bethel", "lobster"]) {
      if (state[key]) api.removeNpc(state[key]);
    }
    for (const npc of state.pirates) api.removeNpc(npc);
    questSpawns.delete(player);
  }

  // ==========================================================================
  // Variant selection
  // ==========================================================================

  function raleyVariant(player) {
    const stage = quest.getStage(player);
    if (stage <= 0) {
      return meetsRequirements(player) ? "starting-out-talking-to-elder-raley" : null;
    }
    if (stage < STAGE_FLOOPA_FOUND) return "the-search-for-floopa-talking-to-elder-raley-again";
    if (stage >= STAGE_RETURN_FLOOPA && stage < STAGE_COMPLETE) {
      return "back-on-the-great-conch-talking-to-floopa-and-elder-raley";
    }
    if (stage < STAGE_COMPLETE) return "the-search-for-floopa-talking-to-elder-raley-after-finding-floopa";
    return null; // post-quest: the Elder Raley page's standard dialogue
  }

  function floopaVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_GROVE_ACCESS && stage < STAGE_FLOOPA_FOUND) {
      if (stage === STAGE_GROVE_ACCESS) quest.setStage(player, STAGE_FLOOPA_FOUND);
      return "the-search-for-floopa-talking-to-floopa";
    }
    if (stage >= STAGE_FLOOPA_FOUND && stage < STAGE_RED_ROCK) {
      return "the-search-for-floopa-talking-to-floopa-again";
    }
    if (stage >= STAGE_RETURN_FLOOPA && stage < STAGE_COMPLETE) {
      return "back-on-the-great-conch-talking-to-floopa-and-elder-raley";
    }
    return null;
  }

  function receptionistVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_FLOOPA_FOUND && stage < STAGE_MEETING_READY) {
      if (stage < STAGE_RED_ROCK) quest.setStage(player, STAGE_RED_ROCK);
      quest.setStage(player, STAGE_MEETING_READY);
      return "on-red-rock-talking-to-the-receptionist";
    }
    if (stage < STAGE_MEETING_ARRANGED) {
      return "on-red-rock-before-looking-at-all-four-display-cases";
    }
    if (stage < STAGE_COMPLETE) {
      return "on-red-rock-after-looking-at-all-four-display-cases";
    }
    return null;
  }

  function paxtonVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_MEETING_ARRANGED) {
      return stage >= STAGE_RED_ROCK
        ? "on-red-rock-talking-to-theodore-paxton-before-talking-to-the-receptionist"
        : null;
    }
    if (stage === STAGE_MEETING_ARRANGED) {
      quest.setStage(player, STAGE_PAXTON_TASKED);
      return "on-red-rock-talking-to-theodore-paxton";
    }
    if (stage < STAGE_BETHEL_DEAD) {
      return "on-red-rock-talking-to-theodore-paxton-again";
    }
    if (stage < STAGE_ZENITH_KNOWN) {
      quest.setStage(player, STAGE_ZENITH_KNOWN);
      return "back-on-red-rock-talking-to-theodore-paxton";
    }
    if (stage < STAGE_ABOARD_ZENITH) {
      return "back-on-red-rock-talking-to-theodore-paxton-again";
    }
    return null;
  }

  function spencerVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_ZENITH_KNOWN && stage < STAGE_ABOARD_ZENITH) {
      quest.setStage(player, STAGE_ABOARD_ZENITH);
      return "aboard-the-zenith-talking-to-spencer-brentwood";
    }
    if (stage === STAGE_ABOARD_ZENITH) {
      return "aboard-the-zenith-talking-to-spencer-again";
    }
    if (stage >= STAGE_SURFACE_PLAN && stage < STAGE_RETURN_FLOOPA) {
      return "back-on-the-surface-talking-to-spencer";
    }
    return null;
  }

  function divingSpencerVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_DIVING || stage >= STAGE_SURFACE_PLAN) return null;
    if (stage < STAGE_FIXING_DREDGER) return "underwater-talking-to-spencer";
    if (stage < STAGE_REPORT_EAST) return "underwater-talking-to-spencer-again-before-fixing-the-dredger";
    return "underwater-returning-to-spencer";
  }

  function selectVariant({ npcId, player }) {
    if (npcId === ELDER_RALEY_NPC_ID) return raleyVariant(player);
    if (npcId === ELDER_KATT_NPC_ID) {
      const stage = quest.getStage(player);
      if (stage >= STAGE_GROVE_KNOWN && stage < STAGE_GROVE_ACCESS) {
        quest.setStage(player, STAGE_GROVE_ACCESS);
        return "the-search-for-floopa-talking-to-elder-katt";
      }
      return null;
    }
    if (npcId === FLOOPA_GROVE_NPC_ID || npcId === FLOOPA_HOUSE_NPC_ID) return floopaVariant(player);
    if (npcId === RECEPTIONIST_NPC_ID) return receptionistVariant(player);
    if (npcId === THEODORE_PAXTON_NPC_ID) return paxtonVariant(player);
    if (npcId === SPENCER_BRENTWOOD_NPC_ID) return spencerVariant(player);
    if (npcId === SPENCER_DIVING_A_NPC_ID || npcId === SPENCER_DIVING_B_NPC_ID) {
      return divingSpencerVariant(player);
    }
    if (FLOOPA_SEARCH_VARIANTS.has(npcId)) {
      const stage = quest.getStage(player);
      if (stage >= STAGE_STARTED && stage < STAGE_GROVE_KNOWN) {
        if (stage === STAGE_STARTED) quest.setStage(player, STAGE_GROVE_KNOWN);
        return FLOOPA_SEARCH_VARIANTS.get(npcId);
      }
      return null;
    }
    return null;
  }

  // ==========================================================================
  // Prose conditions
  // ==========================================================================

  function answerCondition(event) {
    const { player, stepId, pages } = event;
    if (Array.isArray(pages) && pages.length > 0 && !pages.some((entry) => entry.page === PAGE)) {
      return null;
    }
    if (NO_DIVING_GEAR_CONDITION_IDS.has(stepId)) {
      // BOlODW/VE5dY_ give the equipment: only when there is room for both items.
      if (stepId === "x3HLXd") return !hasDivingGear(player);
      return !hasDivingGear(player) && freeSlots(player) >= 2;
    }
    if (HAS_DIVING_GEAR_CONDITION_IDS.has(stepId)) return hasDivingGear(player);
    if (stepId === GEAR_IN_INVENTORY_CONDITION_ID) {
      return carryingDivingGear(player) && !wearingDivingGear(player);
    }
    if (stepId === WEARING_GEAR_CONDITION_ID) return wearingDivingGear(player);
    if (NO_GEAR_NO_SPACE_CONDITION_IDS.has(stepId)) {
      if (!hasDivingGear(player) && freeSlots(player) < 2) {
        player.sendMessage("You need two free inventory slots to take the diving equipment.");
      }
      return false;
    }
    if (stepId === FINALE_NO_SPACE_CONDITION_ID) return freeSlots(player) < 1;
    if (stepId === NO_DRAGON_SCIMITAR_CONDITION_ID) return !wearingDragonScimitar(player);
    if (stepId === HAS_DRAGON_SCIMITAR_CONDITION_ID) return wearingDragonScimitar(player);
    return null;
  }

  // ==========================================================================
  // Dialogue events
  // ==========================================================================

  function handleStartHook({ player, npcId, hook }) {
    if (npcId !== ELDER_RALEY_NPC_ID || hook !== START_HOOK) return;
    if (quest.getStage(player) !== 0) return;
    if (!meetsRequirements(player)) {
      player.sendMessage(
        "You need level 52 Sailing, level 48 Smithing and completion of Troubled Tortugans to start this quest."
      );
      return;
    }
    quest.setStage(player, STAGE_STARTED);
  }

  function handleChoice(event) {
    if (event.npcId !== SPENCER_BRENTWOOD_NPC_ID) return;
    if (String(event.option ?? "").trim() !== DIVE_CONFIRM_OPTION) return;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_ABOARD_ZENITH || stage >= STAGE_DIVING) return;
    player.moveTo(new Location(SEABED_DIVE_TILE.x, SEABED_DIVE_TILE.y, SEABED_DIVE_TILE.z));
    quest.setStage(player, STAGE_DIVING);
  }

  function handleDialogueLine(event) {
    const { player } = event;
    if (event.npcId === SPENCER_BRENTWOOD_NPC_ID) {
      if (event.text === SURFACE_PLAN_LAST_LINE && quest.getStage(player) === STAGE_SURFACE_PLAN) {
        quest.setStage(player, STAGE_RETURN_FLOOPA);
      }
      return;
    }
    if (event.npcId !== ELDER_RALEY_NPC_ID && event.npcId !== FLOOPA_HOUSE_NPC_ID) return;
    if (event.text !== FINALE_GIFT_LINE) return;
    if (quest.getStage(player) === STAGE_RETURN_FLOOPA && freeSlots(player) >= 1) {
      finaleRewardPending.add(player);
    }
  }

  function handleAction(event) {
    const { player, npcId, stepId, step } = event;
    if (!player) return;
    if (
      step?.type === "end" &&
      finaleRewardPending.has(player) &&
      quest.getStage(player) === STAGE_RETURN_FLOOPA &&
      (npcId === ELDER_RALEY_NPC_ID || npcId === FLOOPA_HOUSE_NPC_ID)
    ) {
      finaleRewardPending.delete(player);
      event.handled = true;
      event.end = true;
      if (!quest.isComplete(player)) quest.complete(player);
      return;
    }
    if (!stepId) return;
    if (GIVE_DIVING_GEAR_ACTION_IDS.has(stepId)) {
      if (npcId !== SPENCER_BRENTWOOD_NPC_ID) return;
      grantDivingEquipment(player);
      return;
    }
    if (stepId === SHIPS_SUNK_MESSAGE_ID) {
      if (quest.getStage(player) >= STAGE_PAXTON_TASKED && quest.getStage(player) < STAGE_REACH_LAST_LIGHT) {
        quest.setStage(player, STAGE_REACH_LAST_LIGHT);
      }
      return;
    }
    if (stepId === DREDGER_REPAIRED_ACTION_ID) {
      if (npcId !== SPENCER_DIVING_A_NPC_ID) return;
      if (quest.getStage(player) === STAGE_DIVING) quest.setStage(player, STAGE_FIXING_DREDGER);
      return;
    }
    if (stepId === REPAIR_DREDGER_MESSAGE_ID) {
      const stage = quest.getStage(player);
      if (stage === STAGE_FIXING_DREDGER) {
        spawnLobster(player);
        quest.setStage(player, STAGE_DREDGER_AGAIN);
      } else if (stage === STAGE_DREDGER_AGAIN) {
        const state = questSpawns.get(player);
        if (state?.lobster) {
          api.removeNpc(state.lobster);
          state.lobster = null;
        }
        quest.setStage(player, STAGE_REPORT_EAST);
      }
      return;
    }
    if (stepId === SURFACE_RETURN_MESSAGE_ID) {
      if (quest.getStage(player) !== STAGE_REPORT_EAST) return;
      player.moveTo(
        new Location(SPENCER_SURFACE_TILE.x, SPENCER_SURFACE_TILE.y, SPENCER_SURFACE_TILE.z)
      );
      quest.setStage(player, STAGE_SURFACE_PLAN);
      return;
    }
    if (stepId === COMPLETE_ACTION_ID) {
      if (npcId !== ELDER_RALEY_NPC_ID && npcId !== FLOOPA_HOUSE_NPC_ID) return;
      event.handled = true;
      event.end = true;
      if (!quest.isComplete(player)) quest.complete(player);
    }
  }

  // ==========================================================================
  // World interactions
  // ==========================================================================

  function handleObjectInteraction(event) {
    const { player, objectId } = event;
    const varbit = DISPLAY_CASE_VARBITS.get(objectId);
    if (varbit !== undefined) {
      event.handled = true;
      const stage = quest.getStage(player);
      if (stage < STAGE_MEETING_READY || stage >= STAGE_MEETING_ARRANGED) return;
      player.getPacketSender().sendVarbit(varbit, 1);
      if (displayCasesDone(player)) quest.setStage(player, STAGE_MEETING_ARRANGED);
      return;
    }
    if (objectId !== CORAL_DREDGER_REPAIR_OBJECT_ID) return;
    event.handled = true;
    const stage = quest.getStage(player);
    if (stage < STAGE_FIXING_DREDGER || stage > STAGE_DREDGER_AGAIN) return;
    startTranscript(api, player, SPENCER_BRENTWOOD_NPC_ID, PAGE, REPAIR_DREDGER_VARIANT);
  }

  function handleNpcDeath(event) {
    const { npc, killer } = event;
    if (!npc || !killer || killer.isPlayer?.() !== true) return;
    const state = questSpawns.get(killer);
    if (!state) return;
    if (state.bethel && state.bethel === npc) {
      state.bethel = null;
      if (quest.getStage(killer) === STAGE_KILL_PIRATES) {
        quest.setStage(killer, STAGE_BETHEL_DEAD);
      }
      return;
    }
    const index = state.pirates.indexOf(npc);
    if (index !== -1) {
      state.pirates.splice(index, 1);
      if (state.pirates.length === 0 && quest.getStage(killer) === STAGE_REACH_LAST_LIGHT) {
        quest.setStage(killer, STAGE_KILL_PIRATES);
      }
      return;
    }
    if (state.lobster && state.lobster === npc) state.lobster = null;
  }

  function handleRedRockEnter({ player }) {
    if (!quest || quest.getStage(player) !== STAGE_FLOOPA_FOUND) return;
    quest.setStage(player, STAGE_RED_ROCK);
    ensureSpawns(player);
  }

  function handleLastLightEnter({ player }) {
    if (!quest || quest.isComplete(player)) return;
    const stage = quest.getStage(player);
    if (stage >= STAGE_PAXTON_TASKED && stage < STAGE_REACH_LAST_LIGHT) {
      startTranscript(api, player, BLACK_EYE_BETHEL_NPC_ID, PAGE, APPROACHING_LAST_LIGHT_VARIANT);
      startTranscript(api, player, BLACK_EYE_BETHEL_NPC_ID, PAGE, SHIPS_SUNK_VARIANT);
      if (quest.getStage(player) < STAGE_REACH_LAST_LIGHT) {
        quest.setStage(player, STAGE_REACH_LAST_LIGHT);
      }
    }
    ensureSpawns(player);
  }

  function handleStageChanged(event) {
    if (!event || event.key !== "the_red_reef" || !event.player) return;
    ensureSpawns(event.player);
  }

  function handleLogin({ player }) {
    if (quest.getStage(player) >= STAGE_MEETING_ARRANGED) sendDisplayCaseVarps(player);
    ensureSpawns(player);
    refreshQuestList(player);
  }

  function handleLogout({ player }) {
    finaleRewardPending.delete(player);
    clearSpawns(player);
  }

  // ==========================================================================
  // Journal and reward
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Floopa had wandered off from the Great Conch and I found her in the Sacred Grove.</str>",
        "<str>I infiltrated the Red Reef Trading Company and dealt with Black Eye Bethel.</str>",
        "<str>I helped Spencer Brentwood repair his coral dredgers and learned of his plans for the Pearl Bank.</str>",
        "<str>I told Floopa and Elder Raley what I had learned so we can plan our next move.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_RETURN_FLOOPA) {
      return [
        "Spencer wants the Tortugans off the Little Pearl so he can harvest a reef in the Pearl Bank.",
        "I should return to the <col=800000>Great Conch</col> and tell <col=800000>Floopa</col> and",
        "<col=800000>Elder Raley</col> what I have learned.",
      ];
    }
    if (stage >= STAGE_SURFACE_PLAN) {
      return [
        "Spencer revealed that the Red Reef is running out of red coral and that he plans to",
        "harvest a reef in the <col=800000>Pearl Bank</col> near the Little Pearl.",
        "I should report back to <col=800000>Red Rock</col> once I have a plan.",
      ];
    }
    if (stage >= STAGE_FIXING_DREDGER) {
      return [
        "I dived to the seabed with <col=800000>Spencer</col> and helped repair the coral dredgers.",
        "A <col=800000>giant lobster</col> appeared while I worked on the northern dredger.",
        stage >= STAGE_REPORT_EAST
          ? "I should speak to <col=800000>Spencer</col> at the eastern dredger."
          : "I should repair the northern <col=800000>coral dredger</col>.",
      ];
    }
    if (stage >= STAGE_DIVING) {
      return [
        "<str>I sailed to the Zenith and met Spencer Brentwood.</str>",
        "I am diving on the seabed with <col=800000>Spencer</col>.",
        "I should listen to what he has to say.",
      ];
    }
    if (stage >= STAGE_ZENITH_KNOWN) {
      return [
        "<str>I dealt with Black Eye Bethel for Theodore Paxton.</str>",
        "Paxton's boss, <col=800000>Spencer Brentwood</col>, has work for me aboard his ship,",
        "the <col=800000>Zenith</col>, somewhere in the middle of the Red Reef.",
      ];
    }
    if (stage >= STAGE_BETHEL_DEAD) {
      return [
        "<str>I defeated the pirates and Black Eye Bethel at Last Light.</str>",
        "I should return to <col=800000>Theodore Paxton</col> on <col=800000>Red Rock</col>.",
      ];
    }
    if (stage >= STAGE_KILL_PIRATES) {
      return [
        "<str>I docked at Last Light and defeated the pirates.</str>",
        "I should climb the lighthouse and deal with <col=800000>Black Eye Bethel</col>.",
      ];
    }
    if (stage >= STAGE_REACH_LAST_LIGHT) {
      return [
        "<str>Theodore Paxton asked me to deal with Black Eye Bethel.</str>",
        "<str>The pirate ships were destroyed when I approached Last Light.</str>",
        "I should defeat the <col=800000>pirates</col> on the island and then Bethel.",
      ];
    }
    if (stage >= STAGE_PAXTON_TASKED) {
      return [
        "<str>I infiltrated the Red Reef Trading Company on Red Rock.</str>",
        "I spoke to <col=800000>Theodore Paxton</col>, who asked me to sail to",
        "<col=800000>Last Light</col> to deal with the pirate <col=800000>Black Eye Bethel</col>.",
      ];
    }
    if (stage >= STAGE_MEETING_ARRANGED) {
      return [
        "<str>I infiltrated the Red Reef Trading Company on Red Rock.</str>",
        "<str>The receptionist inspected my credentials and arranged a meeting with Theodore Paxton.</str>",
        "I should speak to <col=800000>Theodore Paxton</col> in his office.",
      ];
    }
    if (stage >= STAGE_MEETING_READY) {
      return [
        "The receptionist arranged a meeting with her superior, <col=800000>Theodore Paxton</col>.",
        "While I wait, I should inspect the <col=800000>display cases</col> around the room.",
      ];
    }
    if (stage >= STAGE_RED_ROCK) {
      return [
        "<str>Floopa asked me to investigate the Red Reef Trading Company.</str>",
        "I have arrived at <col=800000>Red Rock</col>. I should talk to the",
        "<col=800000>receptionist</col> and offer my services to the company.",
      ];
    }
    if (stage >= STAGE_FLOOPA_FOUND) {
      return [
        "<str>I found Floopa in the Sacred Grove and learned of her past with the Red Reef Trading Company.</str>",
        "I should sail to <col=800000>Red Rock</col>, west of the Great Conch, and investigate the company.",
      ];
    }
    if (stage >= STAGE_GROVE_ACCESS) {
      return [
        "<str>I asked around town and learned Floopa was heading to the Sacred Grove.</str>",
        "<str>Elder Katt let me into the Grove to look for her.</str>",
        "I should find <col=800000>Floopa</col> inside the <col=800000>Sacred Grove</col>.",
      ];
    }
    if (stage >= STAGE_GROVE_KNOWN) {
      return [
        "<str>Elder Raley asked me to find Floopa, who has wandered off.</str>",
        "I asked around town and was told she was heading towards the",
        "<col=800000>Sacred Grove</col> in the middle of the island.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "<str>Elder Raley asked me to find Floopa, who has wandered off.</str>",
        "I should ask around town and see if anyone has seen her.",
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Elder Raley</col>",
      "at his home on the <col=800000>Great Conch</col>.",
      "",
      "I will need level 52 Sailing, level 48 Smithing and to have",
      "completed <col=800000>Troubled Tortugans</col>.",
    ];
  }

  function grantReward(player) {
    const skills = player.getSkillManager();
    skills.addExperiences(Skill.SAILING, SAILING_XP);
    skills.addExperiences(Skill.SMITHING, SMITHING_XP);
  }

  quest = registerQuest(api, {
    key: "the_red_reef",
    name: "The Red Reef",
    varpId: VARP_THE_RED_REEF,
    varbitId: VARBIT_THE_RED_REEF,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [
      { skillId: Skill.SAILING.getIndex(), amount: SAILING_XP, label: "Sailing" },
      { skillId: Skill.SMITHING.getIndex(), amount: SMITHING_XP, label: "Smithing" },
    ],
    rewardItemId: BOSUNS_WORKBENCH_SCHEMATIC_ITEM_ID,
    rewardItemLabel: "Bosun's workbench schematic",
    otherRewards: ["Access to the Sacred Grove", "Access to Red Rock (partial completion)"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  api.onCustomEvent("quest:stage-changed", handleStageChanged);
  api.onObjectInteraction(handleObjectInteraction);
  api.onNpcDeath(handleNpcDeath);
  api.onZoneEnter(RED_ROCK_ZONE, handleRedRockEnter);
  api.onZoneEnter(LAST_LIGHT_ZONE, handleLastLightEnter);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
