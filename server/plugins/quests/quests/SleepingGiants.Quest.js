/**
 * Sleeping Giants (members).
 *
 * The words come from the "Sleeping Giants" transcript page; this plugin
 * supplies the variant selector for Kovac, the Strike start on the Giants'
 * Plateau Hill Giant, the prose-condition answers, the tool-repair loop, the
 * supply crate and the hand-in reward. The tutorial sword itself is made on
 * the Giants' Foundry plugin's crucible, mould jig, tools and HUD: this quest
 * hands out its Flat Broad commission ("giants-foundry:start-commission") and
 * follows the sword through "giants-foundry:step".
 *
 * Stages (attribute; the client sees them mapped to live OSRS's values of
 * varbit 13902 "sleeping_giants", varp 3428 bits 0-5, rsprox recording 96):
 * 1 accepted and repairing the tools (live 15), 2 all three tools repaired
 * (20), 3 Kovac gave the Flat Broad commission (25), 4 crate looted,
 * 5 crucible full, 6 mould set, 7 metal poured, 9 preform taken,
 * 10 hammered, 11 ground, 12 sword finished (all 25), 13 handed in (30).
 * Stage 8 (metal cooled) is no longer used: the preform is cooled as it is
 * picked up. The foundry's Kovac (cache NPC 11560, spawned by the Giants'
 * Foundry plugin) only shows Hand-in, Commission and Shop at 30.
 *
 * The tutorial's own steps are varbit 13903 "sleeping_giants_tutorial" (live:
 * 10 commission given, 15 crate looted, 20 first metal in, 25 crucible full,
 * 30 told about the mould, 35 mould set, 40 checked by Kovac, 45 poured,
 * 50 preform taken, 65 handed in). The supply crate (multiloc 44779) shows by
 * it: full up to 10, empty from 15. The repair varbits 13904-13906 read 2 once
 * a tool is repaired.
 *
 * Source: https://oldschool.runescape.wiki/w/Sleeping_Giants and
 * https://oldschool.runescape.wiki/w/Transcript:Sleeping_Giants
 * Rewards per the OSRS Wiki: 1 Quest point, 6,000 Smithing experience and
 * access to the Giants' Foundry.
 *
 * Gaps / approximations:
 *   - The tutorial's workshop is an instance in OSRS. Here the static
 *     Giants' Foundry room (reached by the real 44635 Cave Enter / 44636 Exit)
 *     is the workshop, with the minigame's own crucible, jig, storage and crate.
 *   - The broken tool ids (43857/43860/43862, "Repair") are not in the map
 *     either, so the static repaired tools' "Use" option (44619/44620/44621)
 *     runs the wiki repair transcript while a tool is unrepaired.
 *   - The transcript's "Stop!" lines for a wrong tool or heat are not played:
 *     the foundry's machines damage the preform as they do in the minigame.
 *   - "Obor kill count" is read from the GiantLairs plugin's persisted
 *     "giant-lairs:obor-chests-opened" attribute (no kill-count attribute
 *     exists); no Obor chests means the 0-kill branch.
 *   - 11467 (surface Kovac) is missing from npc-spawns.json, so the plugin
 *     spawns it once. The foundry Kovac is npc-spawns.json's 11560, which shows
 *     11470 during the quest and 11472 (the Giants' Foundry's Kovac) after it.
 */
module.exports = function registerSleepingGiantsQuest(api) {
  const {
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    Skill,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const PAGE = "Sleeping Giants";
  const START_HOOK = "quest:sleeping-giants:start";

  const HILL_GIANT_NPC_ID = NpcIdentifiers.HILL_GIANT_12; // 11467, "Strike" surface Kovac
  const KOVAC_NPC_ID = NpcIdentifiers.KOVAC; // 11468
  const KOVAC_NPC_IDS = new Set([
    NpcIdentifiers.KOVAC, // 11468
    NpcIdentifiers.KOVAC_2, // 11469
    NpcIdentifiers.KOVAC_3, // 11470
    NpcIdentifiers.KOVAC_4, // 11472
  ]);
  const DIALOGUE_NPC_ID = KOVAC_NPC_ID;

  const TRIP_HAMMER_OBJECT_ID = ObjectIdentifiers.TRIP_HAMMER; // 44619, ops Use
  const GRINDSTONE_OBJECT_ID = ObjectIdentifiers.GRINDSTONE; // 44620, ops Use
  const POLISHING_WHEEL_OBJECT_ID = ObjectIdentifiers.POLISHING_WHEEL; // 44621, ops Use
  const LAVA_POOL_OBJECT_ID = ObjectIdentifiers.LAVA_POOL_3; // 44631, ops Heat-preform|Dunk-preform
  const WATERFALL_OBJECT_ID = ObjectIdentifiers.WATERFALL_9; // 44632, ops Cool-preform|Quench-preform
  const PILE_OF_BUCKETS_OBJECT_ID = ObjectIdentifiers.PILE_OF_BUCKETS; // 33309, ops Take-from
  const CAVE_OBJECT_ID = ObjectIdentifiers.CAVE_93; // 44635, ops Enter
  const EXIT_OBJECT_ID = ObjectIdentifiers.EXIT_21; // 44636, ops Exit
  /** giants_foundry_supply_box_multi: a nameless multiloc, so no generated identifier. */
  const SUPPLY_BOX_OBJECT_ID = 44779;

  const TOOL_OBJECT_IDS = new Set([
    TRIP_HAMMER_OBJECT_ID,
    GRINDSTONE_OBJECT_ID,
    POLISHING_WHEEL_OBJECT_ID,
  ]);
  const QUEST_OBJECT_IDS = new Set([
    TRIP_HAMMER_OBJECT_ID,
    GRINDSTONE_OBJECT_ID,
    POLISHING_WHEEL_OBJECT_ID,
    LAVA_POOL_OBJECT_ID,
    WATERFALL_OBJECT_ID,
    PILE_OF_BUCKETS_OBJECT_ID,
    CAVE_OBJECT_ID,
    EXIT_OBJECT_ID,
    SUPPLY_BOX_OBJECT_ID,
  ]);

  const OAK_LOGS_ITEM_ID = ItemIdentifiers.OAK_LOGS; // 1521
  const WOOL_ITEM_ID = ItemIdentifiers.WOOL; // 1737 (a ball of wool will not do)
  const CHISEL_ITEM_ID = ItemIdentifiers.CHISEL; // 1755
  const HAMMER_ITEM_IDS = new Set([
    ItemIdentifiers.HAMMER, // 2347
    ItemIdentifiers.IMCANDO_HAMMER, // 25644
  ]);
  const NAIL_ITEM_IDS = [
    ItemIdentifiers.STEEL_NAILS, // 1539
    ItemIdentifiers.BRONZE_NAILS, // 4819
    ItemIdentifiers.IRON_NAILS, // 4820
    ItemIdentifiers.BLACK_NAILS, // 4821
    ItemIdentifiers.MITHRIL_NAILS, // 4822
    ItemIdentifiers.ADAMANTITE_NAILS, // 4823
    ItemIdentifiers.RUNE_NAILS, // 4824
  ];
  const BUCKET_ITEM_ID = ItemIdentifiers.BUCKET; // 1925
  const BUCKET_OF_WATER_ITEM_ID = ItemIdentifiers.BUCKET_OF_WATER; // 1929

  /**
   * The supply crate's metal (rsprox recording 96): 20 items worth the crucible's 28 bars,
   * 16 bronze and 12 iron.
   */
  const CRATE_ITEMS = [
    [ItemIdentifiers.BRONZE_BAR, 8],
    [ItemIdentifiers.IRON_BAR, 6],
    [ItemIdentifiers.BRONZE_BATTLEAXE, 2],
    [ItemIdentifiers.IRON_LONGSWORD, 2],
    [ItemIdentifiers.BRONZE_PLATEBODY, 1],
    [ItemIdentifiers.IRON_PLATEBODY, 1],
  ];
  const CRATE_SLOTS_REQUIRED = CRATE_ITEMS.reduce((sum, [, amount]) => sum + amount, 0);

  const VARP_GIANTS_FOUNDRY = 3428; // "giants_foundry_main"
  const VARBIT_SLEEPING_GIANTS = 13902; // "sleeping_giants", bits 0-5
  const VARBIT_TUTORIAL = 13903; // "sleeping_giants_tutorial", bits 6-15
  const VARBIT_REPAIRED = { hammer: 13904, grind: 13905, polish: 13906 };
  const REPAIRED = 2;
  /** The foundry's own varbits, as the Giants' Foundry plugin keeps them. */
  const VARBIT_METAL_FIRST = 13931; // bronze..rune counts, 13931-13936
  const VARBIT_PREFORM_QUALITY = 13939;
  const VARBIT_COMPLETION = 13949;

  const STAGE_STARTED = 1;
  const STAGE_TOOLS_REPAIRED = 2;
  const STAGE_COMMISSION = 3;
  const STAGE_CRATE_LOOTED = 4;
  const STAGE_CRUCIBLE_FULL = 5;
  const STAGE_MOULD_SET = 6;
  const STAGE_POURED = 7;
  const STAGE_PREFORM_TAKEN = 9;
  const STAGE_HAMMERED = 10;
  const STAGE_GROUND = 11;
  const STAGE_POLISHED = 12;
  const STAGE_COMPLETE = 13;

  /** What the client sees for a stage (live varbit 13902). */
  function liveStage(stage) {
    if (stage >= STAGE_COMPLETE) return 30;
    if (stage >= STAGE_COMMISSION) return 25;
    if (stage >= STAGE_TOOLS_REPAIRED) return 20;
    if (stage >= STAGE_STARTED) return 15;
    return 0;
  }

  const TUTORIAL = {
    COMMISSION: 10,
    CRATE_LOOTED: 15,
    FIRST_METAL: 20,
    CRUCIBLE_FULL: 25,
    MOULD_BRIEFED: 30,
    MOULD_SET: 35,
    MOULD_CHECKED: 40,
    POURED: 45,
    PREFORM_TAKEN: 50,
    HANDED_IN: 65,
  };

  /** The Flat Broad sword (commission words Broad 4 and Flat 3, enum 4372). */
  const TUTORIAL_COMMISSION = [4, 3];

  const BIT_TRIP_REPAIRED = 1;
  const BIT_GRIND_REPAIRED = 2;
  const BIT_POLISH_REPAIRED = 4;
  const BIT_BRIEFED = 8; // heard "all the tools repaired / make a sword"
  const BIT_MOULD_BRIEFED = 16; // heard "set up a mould"
  const BIT_CRATE_LOOTED = 32;
  const BIT_MOULD_CHECKED = 64; // Kovac looked over the mould

  const BITS_ATTRIBUTE = "quest.sleeping_giants.bits";
  const TUTORIAL_ATTRIBUTE = "quest.sleeping_giants.tutorial";
  const OBOR_CHESTS_ATTRIBUTE = "giant-lairs:obor-chests-opened";

  const OP_1 = 1;
  const OP_2 = 2;

  const HILL_GIANT_SPAWN_TILE = { x: 3362, y: 3146 };
  /** rsprox: entering the cave lands the player here. */
  const FOUNDRY_LANDING_TILE = { x: 3366, y: 11483 };
  const SURFACE_RETURN_TILE = { x: 3368, y: 3152 };

  const REPAIR_VARIANT_BY_TOOL = new Map([
    [TRIP_HAMMER_OBJECT_ID, "what-is-this-a-workshop-for-giants-reparing-the-trip-hammer"],
    [GRINDSTONE_OBJECT_ID, "what-is-this-a-workshop-for-giants-reparing-the-grindstone"],
    [POLISHING_WHEEL_OBJECT_ID, "what-is-this-a-workshop-for-giants-reparing-the-polishing-wheel"],
  ]);
  const REPAIR_BIT_BY_TOOL = new Map([
    [TRIP_HAMMER_OBJECT_ID, BIT_TRIP_REPAIRED],
    [GRINDSTONE_OBJECT_ID, BIT_GRIND_REPAIRED],
    [POLISHING_WHEEL_OBJECT_ID, BIT_POLISH_REPAIRED],
  ]);
  const REPAIR_VARBIT_BY_TOOL = new Map([
    [TRIP_HAMMER_OBJECT_ID, VARBIT_REPAIRED.hammer],
    [GRINDSTONE_OBJECT_ID, VARBIT_REPAIRED.grind],
    [POLISHING_WHEEL_OBJECT_ID, VARBIT_REPAIRED.polish],
  ]);

  /** Transient dialogue context (never persisted). */
  const repairTool = new WeakMap();
  const repairHadMaterials = new WeakMap();

  let quest;
  let worldInstalled = false;

  // ==========================================================================
  // Persisted state helpers
  // ==========================================================================

  function bits(player) {
    return Number(player.getAttribute(BITS_ATTRIBUTE)) || 0;
  }

  function hasBit(player, bit) {
    return (bits(player) & bit) !== 0;
  }

  function setBit(player, bit) {
    player.setAttribute(BITS_ATTRIBUTE, bits(player) | bit);
  }

  function tutorial(player) {
    return Number(player.getAttribute(TUTORIAL_ATTRIBUTE)) || 0;
  }

  /** The tutorial varbit only moves forward. */
  function setTutorial(player, value) {
    if (tutorial(player) >= value) return;
    player.setAttribute(TUTORIAL_ATTRIBUTE, value);
    player.getPacketSender().sendVarbit(VARBIT_TUTORIAL, value);
  }

  function foundryVarbit(player, varbit) {
    return player.getPacketSender().getVarbit(varbit) || 0;
  }

  function crucibleTotal(player) {
    let total = 0;
    for (let metal = 0; metal < 6; metal++) total += foundryVarbit(player, VARBIT_METAL_FIRST + metal);
    return total;
  }

  function quality(player) {
    return foundryVarbit(player, VARBIT_PREFORM_QUALITY);
  }

  function held(player, itemId, amount = 1) {
    return player.getInventory().getAmount(itemId) >= amount;
  }

  function hasHammer(player) {
    for (const itemId of HAMMER_ITEM_IDS) if (held(player, itemId)) return true;
    return false;
  }

  function nails(player) {
    return NAIL_ITEM_IDS.reduce((sum, itemId) => sum + player.getInventory().getAmount(itemId), 0);
  }

  function removeNails(player, amount) {
    let remaining = amount;
    for (const itemId of NAIL_ITEM_IDS) {
      if (remaining <= 0) return;
      const have = player.getInventory().getAmount(itemId);
      const take = Math.min(have, remaining);
      if (take > 0) {
        player.getInventory().deleteNumber(itemId, take);
        remaining -= take;
      }
    }
  }

  function hasRepairMaterials(player, toolId) {
    if (toolId === TRIP_HAMMER_OBJECT_ID) {
      return held(player, OAK_LOGS_ITEM_ID) && nails(player) >= 5 && hasHammer(player);
    }
    if (toolId === GRINDSTONE_OBJECT_ID) {
      return held(player, CHISEL_ITEM_ID);
    }
    return held(player, OAK_LOGS_ITEM_ID, 2) && nails(player) >= 5
      && held(player, WOOL_ITEM_ID) && hasHammer(player);
  }

  function consumeRepairMaterials(player, toolId) {
    if (toolId === TRIP_HAMMER_OBJECT_ID) {
      player.getInventory().deleteNumber(OAK_LOGS_ITEM_ID, 1);
      removeNails(player, 5);
      return;
    }
    if (toolId === GRINDSTONE_OBJECT_ID) {
      player.getInventory().deleteNumber(CHISEL_ITEM_ID, 1);
      return;
    }
    player.getInventory().deleteNumber(OAK_LOGS_ITEM_ID, 2);
    removeNails(player, 5);
    player.getInventory().deleteNumber(WOOL_ITEM_ID, 1);
  }

  function markRepaired(player, toolId) {
    setBit(player, REPAIR_BIT_BY_TOOL.get(toolId));
    player.getPacketSender().sendVarbit(REPAIR_VARBIT_BY_TOOL.get(toolId), REPAIRED);
    if (allRepaired(player)) quest.setStage(player, STAGE_TOOLS_REPAIRED);
  }

  function allRepaired(player) {
    return hasBit(player, BIT_TRIP_REPAIRED)
      && hasBit(player, BIT_GRIND_REPAIRED)
      && hasBit(player, BIT_POLISH_REPAIRED);
  }

  function resetProgress(player) {
    player.setAttribute(BITS_ATTRIBUTE, 0);
    player.setAttribute(TUTORIAL_ATTRIBUTE, 0);
  }

  // ==========================================================================
  // World setup (spawns the surface Hill Giant once)
  // ==========================================================================

  function ensureQuestSpawns() {
    const npcs = api.getWorld()?.getNpcs ? [...api.getWorld().getNpcs()] : [];
    const ids = new Set(npcs.map((npc) => npc?.getId?.()));
    if (!ids.has(HILL_GIANT_NPC_ID)) {
      api.spawnNpc({
        id: HILL_GIANT_NPC_ID,
        x: HILL_GIANT_SPAWN_TILE.x,
        y: HILL_GIANT_SPAWN_TILE.y,
        z: 0,
        wanderRadius: 0,
      });
    }
  }

  function installWorld() {
    if (worldInstalled) return;
    worldInstalled = true;
    ensureQuestSpawns();
  }

  // ==========================================================================
  // The tutorial sword, made on the Giants' Foundry
  // ==========================================================================

  function startTutorialSword(player) {
    quest.setStage(player, STAGE_COMMISSION);
    setTutorial(player, TUTORIAL.COMMISSION);
    api.emitCustomEvent("giants-foundry:start-commission", { player, words: TUTORIAL_COMMISSION, tutorial: true });
  }

  /** The foundry lets the player work once Kovac has given the Flat Broad commission. */
  function answerAccess(request) {
    if (request.player && quest.getStage(request.player) >= STAGE_COMMISSION) request.allowed = true;
  }

  /** The foundry's steps move the quest along. */
  function handleFoundryStep({ player, step }) {
    const stage = quest.getStage(player);
    if (stage < STAGE_COMMISSION || stage >= STAGE_COMPLETE) return;
    switch (step) {
      case "metal-added":
        setTutorial(player, TUTORIAL.FIRST_METAL);
        return;
      case "crucible-full":
        if (stage < STAGE_CRUCIBLE_FULL) quest.setStage(player, STAGE_CRUCIBLE_FULL);
        setTutorial(player, TUTORIAL.CRUCIBLE_FULL);
        return;
      case "mould-set":
        if (stage < STAGE_MOULD_SET) quest.setStage(player, STAGE_MOULD_SET);
        setTutorial(player, TUTORIAL.MOULD_SET);
        return;
      case "poured":
        if (stage < STAGE_POURED) quest.setStage(player, STAGE_POURED);
        setTutorial(player, TUTORIAL.POURED);
        return;
      case "preform-taken":
        if (stage < STAGE_PREFORM_TAKEN) quest.setStage(player, STAGE_PREFORM_TAKEN);
        setTutorial(player, TUTORIAL.PREFORM_TAKEN);
        return;
      case "hammered":
        if (stage < STAGE_HAMMERED) quest.setStage(player, STAGE_HAMMERED);
        return;
      case "ground":
        if (stage < STAGE_GROUND) quest.setStage(player, STAGE_GROUND);
        return;
      case "finished":
        if (stage < STAGE_POLISHED) quest.setStage(player, STAGE_POLISHED);
        return;
      default:
        return;
    }
  }

  // ==========================================================================
  // Transcript variant selection and condition answers
  // ==========================================================================

  /** Which Kovac transcript variant plays, by stage. */
  function selectVariant({ npcId, player }) {
    if (!KOVAC_NPC_IDS.has(npcId)) return null;
    const stage = quest.getStage(player);
    if (stage <= 0 || stage >= STAGE_COMPLETE) return null;
    if (stage === STAGE_STARTED) {
      return "what-is-this-a-workshop-for-giants-talking-to-kovac";
    }
    if (stage === STAGE_TOOLS_REPAIRED) {
      if (!hasBit(player, BIT_BRIEFED)) {
        setBit(player, BIT_BRIEFED);
        return "what-is-this-a-workshop-for-giants-talking-to-kovac-after-all-the-tools-are-repaired";
      }
      startTutorialSword(player);
      return "make-a-sword-talking-to-kovac";
    }
    if (stage === STAGE_COMMISSION) return "make-a-sword-talking-to-kovac";
    if (stage === STAGE_CRATE_LOOTED) {
      return crucibleTotal(player) > 0
        ? "make-a-sword-talking-to-kovac-after-partially-filling-the-crucible"
        : "make-a-sword-talking-to-kovac-after-looting-the-crate";
    }
    if (stage === STAGE_CRUCIBLE_FULL) {
      if (!hasBit(player, BIT_MOULD_BRIEFED)) {
        setBit(player, BIT_MOULD_BRIEFED);
        setTutorial(player, TUTORIAL.MOULD_BRIEFED);
        return "make-a-sword-talking-to-kovac-after-filling-the-crucible";
      }
      return "make-a-sword-talking-to-kovac-before-setting-the-mould";
    }
    if (stage === STAGE_MOULD_SET) {
      setBit(player, BIT_MOULD_CHECKED);
      setTutorial(player, TUTORIAL.MOULD_CHECKED);
      return "make-a-sword-talking-to-kovac-after-setting-the-mould";
    }
    if (stage === STAGE_POURED) return "make-a-sword-before-picking-up-the-preform";
    if (stage === STAGE_PREFORM_TAKEN) {
      return foundryVarbit(player, VARBIT_COMPLETION) > 0
        ? "make-a-sword-before-completing-the-use-of-the-trip-hammer"
        : "make-a-sword-after-picking-up-the-preform";
    }
    if (stage === STAGE_HAMMERED) return "make-a-sword-talking-to-him-after-hammering-the-preform-enough";
    if (stage === STAGE_GROUND) return "make-a-sword-talking-to-him-after-hammering-the-preform-enough-2";
    if (stage === STAGE_POLISHED) return "make-a-sword-handing-in-the-sword";
    return null;
  }

  function oborKills(player) {
    return Number(player.getAttribute(OBOR_CHESTS_ATTRIBUTE)) || 0;
  }

  function answerCondition({ npcId, player, stepId }) {
    if (!KOVAC_NPC_IDS.has(npcId) && npcId !== HILL_GIANT_NPC_ID) return null;
    switch (stepId) {
      case "FNsqM2": // trip hammer: if the player does not have the materials
      case "Vj9gMa": { // polishing wheel: if the player does not have the materials
        const had = repairHadMaterials.get(player);
        if (had !== undefined) {
          repairHadMaterials.delete(player);
          return !had;
        }
        const toolId = stepId === "FNsqM2" ? TRIP_HAMMER_OBJECT_ID : POLISHING_WHEEL_OBJECT_ID;
        return !hasRepairMaterials(player, toolId);
      }
      case "jYd0Ih": // crate: if the player does not have 20 open inventory spaces
        return player.getInventory().getFreeSlots() < CRATE_SLOTS_REQUIRED;
      case "qSPkVz": // hand-in: if the quality of the sword is at 0
        return quality(player) <= 0;
      case "z6vfKd": // hand-in: if the quality of the sword is above 0
        return quality(player) > 0;
      case "udi3Mo": // hand-in: if the player has 0 Obor kill count
        return oborKills(player) === 0;
      case "GTJR2P": // hand-in: if the player has at least 1 Obor kill count
        return oborKills(player) >= 1;
      default:
        return null;
    }
  }

  // ==========================================================================
  // NPC interaction: strike the surface Hill Giant
  // ==========================================================================

  function handleNpcInteraction(event) {
    const { player, npcId, clickType } = event;
    if (npcId !== HILL_GIANT_NPC_ID || clickType !== OP_1) return;
    event.handled = true;
    if (quest.getStage(player) !== 0) return;
    if (player.getSkillManager().getMaxLevel(Skill.SMITHING) < 15) {
      player.sendMessage("You need a Smithing level of 15 to help Kovac.");
      return;
    }
    startTranscript(api, player, HILL_GIANT_NPC_ID, PAGE, "starting-out-talking-to-kovac");
  }

  // ==========================================================================
  // Dialogue hooks: quest start, repair choices, stage directions
  // ==========================================================================

  function handleStartHook({ player, hook }) {
    if (hook !== START_HOOK) return;
    if (quest.getStage(player) !== 0) return;
    resetProgress(player);
    quest.setStage(player, STAGE_STARTED);
  }

  /** The wiki repair menus: "Yes." consumes the materials and repairs the tool. */
  function handleChoice(event) {
    const { player, npcId, option } = event;
    if (npcId !== DIALOGUE_NPC_ID && !KOVAC_NPC_IDS.has(npcId)) return;
    const toolId = repairTool.get(player);
    if (toolId === undefined) return;
    repairTool.delete(player);
    if (option !== "Yes.") return;
    const hadMaterials = hasRepairMaterials(player, toolId);
    repairHadMaterials.set(player, hadMaterials);
    if (!hadMaterials) return; // the transcript's condition message plays
    consumeRepairMaterials(player, toolId);
    markRepaired(player, toolId);
  }

  function startRepair(player, toolId) {
    repairTool.set(player, toolId);
    startTranscript(api, player, DIALOGUE_NPC_ID, PAGE, REPAIR_VARIANT_BY_TOOL.get(toolId));
  }

  function startKovacVariant(player, variant) {
    startTranscript(api, player, DIALOGUE_NPC_ID, PAGE, variant);
  }

  function handleDialogueAction(event) {
    const { player, npcId, stepId, kind } = event;
    if (!KOVAC_NPC_IDS.has(npcId) && npcId !== HILL_GIANT_NPC_ID) return;
    if (kind === "message") {
      // BkbGGN ("You take a selection of bars and weapons...") still shows the
      // transcript message; the items are the side effect.
      if (stepId === "BkbGGN") takeCrateItems(player);
      return;
    }
    switch (stepId) {
      case "Y4oYGg": // "A cutscene plays..." -> into the workshop
        event.handled = true;
        if (quest.getStage(player) >= STAGE_STARTED) {
          player.moveTo(new Location(FOUNDRY_LANDING_TILE.x, FOUNDRY_LANDING_TILE.y, 0));
        }
        return;
      case "Y7bMs-": // "Congratulations! Quest complete!"
        event.handled = true;
        event.end = true;
        api.emitCustomEvent("giants-foundry:discard-preform", { player });
        setTutorial(player, TUTORIAL.HANDED_IN);
        if (!quest.isComplete(player)) quest.complete(player);
        return;
      default:
        return;
    }
  }

  // ==========================================================================
  // Object interactions
  // ==========================================================================

  function inspectVariant(player, variant) {
    startKovacVariant(player, variant);
  }

  function pushThroughCave(player) {
    player.moveTo(new Location(FOUNDRY_LANDING_TILE.x, FOUNDRY_LANDING_TILE.y, 0));
  }

  function takeCrateItems(player) {
    if (hasBit(player, BIT_CRATE_LOOTED)) return;
    setBit(player, BIT_CRATE_LOOTED);
    for (const [itemId, amount] of CRATE_ITEMS) {
      for (let i = 0; i < amount; i++) player.getInventory().adds(itemId, 1);
    }
    player.getInventory().refreshItems();
    setTutorial(player, TUTORIAL.CRATE_LOOTED);
    if (quest.getStage(player) < STAGE_CRATE_LOOTED) quest.setStage(player, STAGE_CRATE_LOOTED);
  }

  function searchCrate(player) {
    if (hasBit(player, BIT_CRATE_LOOTED)) {
      player.sendMessage("The crate is empty.");
      return;
    }
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMMISSION) {
      startKovacVariant(player, "make-a-sword-searching-crate");
      return;
    }
    inspectVariant(player, "what-is-this-a-workshop-for-giants-inspecting-objects-crate");
  }

  function handleObjectInteraction(event) {
    const { player, objectId, clickType } = event;
    if (!QUEST_OBJECT_IDS.has(objectId)) return;
    if (objectId === CAVE_OBJECT_ID) {
      if (clickType !== OP_1) return;
      event.handled = true;
      if (quest.getStage(player) === 0) {
        startTranscript(api, player, HILL_GIANT_NPC_ID, PAGE, "starting-out-entering-the-cave-before-starting-the-quest");
        return;
      }
      pushThroughCave(player);
      return;
    }
    if (objectId === EXIT_OBJECT_ID) {
      if (clickType !== OP_1) return;
      event.handled = true;
      player.moveTo(new Location(SURFACE_RETURN_TILE.x, SURFACE_RETURN_TILE.y, 0));
      return;
    }
    if (TOOL_OBJECT_IDS.has(objectId)) {
      if (clickType !== OP_1) return;
      if (quest.getStage(player) === STAGE_STARTED && !hasBit(player, REPAIR_BIT_BY_TOOL.get(objectId))) {
        event.handled = true;
        startRepair(player, objectId);
      }
      return;
    }
    if (objectId === LAVA_POOL_OBJECT_ID || objectId === WATERFALL_OBJECT_ID) {
      if (clickType !== OP_1 && clickType !== OP_2) return;
      const stage = quest.getStage(player);
      if (stage > 0 && stage < STAGE_COMMISSION) {
        event.handled = true;
        const variant = objectId === LAVA_POOL_OBJECT_ID
          ? "what-is-this-a-workshop-for-giants-inspecting-objects-lava-pool"
          : "what-is-this-a-workshop-for-giants-inspecting-objects-waterfall";
        inspectVariant(player, variant);
      }
      return;
    }
    if (objectId === PILE_OF_BUCKETS_OBJECT_ID) {
      if (clickType !== OP_1) return;
      event.handled = true;
      if (player.getInventory().getFreeSlots() < 1) {
        player.sendMessage("You need some free inventory space for a bucket.");
        return;
      }
      player.getInventory().adds(BUCKET_ITEM_ID, 1);
      return;
    }
    if (objectId === SUPPLY_BOX_OBJECT_ID) {
      if (clickType !== OP_1 || quest.getStage(player) <= 0) return;
      event.handled = true;
      searchCrate(player);
    }
  }

  function handleItemOnObject(event) {
    const { player, itemId, objectId } = event;
    if (objectId === WATERFALL_OBJECT_ID && itemId === BUCKET_ITEM_ID) {
      event.handled = true;
      player.getInventory().deleteNumber(BUCKET_ITEM_ID, 1);
      player.getInventory().adds(BUCKET_OF_WATER_ITEM_ID, 1);
    }
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function repairLine(player, toolId, label) {
    return hasBit(player, REPAIR_BIT_BY_TOOL.get(toolId))
      ? `<str>I have repaired the ${label}.</str>`
      : `I should repair the <col=800000>${label}</col>.`;
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I struck a talking Hill Giant on the Giants' Plateau and met</str>",
        "<str>Kovac, who asked me to help restore the Giants' Foundry.</str>",
        "<str>I repaired the foundry tools and forged a giant sword for</str>",
        "<str>Kovac's old friend, Obor.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_STARTED) {
      const lines = [
        "<str>Kovac asked me to help him restore the Giants' Foundry so his</str>",
        "<str>kin remember what giants once were.</str>",
        "",
      ];
      if (stage < STAGE_TOOLS_REPAIRED) {
        if (!allRepaired(player)) {
          lines.push(repairLine(player, TRIP_HAMMER_OBJECT_ID, "trip hammer"));
          lines.push(repairLine(player, GRINDSTONE_OBJECT_ID, "grindstone"));
          lines.push(repairLine(player, POLISHING_WHEEL_OBJECT_ID, "polishing wheel"));
        }
      } else if (stage === STAGE_TOOLS_REPAIRED) {
        lines.push("I should speak to <col=800000>Kovac</col> about making a sword.");
      } else if (stage === STAGE_COMMISSION) {
        lines.push("I should search the <col=800000>crate</col> by the cave exit for metal.");
      } else if (stage === STAGE_CRATE_LOOTED) {
        lines.push("I should load the metal into the <col=800000>crucible</col>.");
      } else if (stage === STAGE_CRUCIBLE_FULL) {
        lines.push("I should set up the <col=800000>mould jig</col> for a flat broad sword.");
      } else if (stage === STAGE_MOULD_SET) {
        lines.push("I should pour the metal from the <col=800000>crucible</col> into the mould.");
      } else if (stage === STAGE_POURED) {
        lines.push("I should take the <col=800000>preform</col> from the mould jig.");
      } else if (stage < STAGE_POLISHED) {
        lines.push("I should work the <col=800000>preform</col> with the trip hammer,");
        lines.push("the grindstone and the polishing wheel.");
      } else {
        lines.push("I should give the finished sword to <col=800000>Kovac</col>.");
      }
      return lines;
    }
    return [
      "I can start this quest by striking the strange",
      "<col=800000>Hill Giant</col> on the <col=800000>Giants' Plateau</col>, east of Al Kharid.",
      "",
      "I need a Smithing level of 15 to help him.",
    ];
  }

  function grantRewards(player) {
    player.getSkillManager().addExperiences(Skill.SMITHING, 6000);
  }

  /** The tutorial and repair varbits share the quest's varp; the runtime sends only its stage. */
  function sendTutorialVarbits(player) {
    const sender = player.getPacketSender();
    sender.sendVarbit(VARBIT_TUTORIAL, tutorial(player));
    for (const [toolId, varbit] of REPAIR_VARBIT_BY_TOOL) {
      sender.sendVarbit(varbit, hasBit(player, REPAIR_BIT_BY_TOOL.get(toolId)) ? REPAIRED : 0);
    }
  }

  function handleLogin({ player }) {
    sendTutorialVarbits(player);
    refreshQuestList(player);
    installWorld();
  }

  quest = registerQuest(api, {
    key: "sleeping_giants",
    name: "Sleeping Giants",
    varpId: VARP_GIANTS_FOUNDRY,
    varbitId: VARBIT_SLEEPING_GIANTS,
    varpValue: liveStage,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.SMITHING.getIndex(), amount: 6000, label: "Smithing" }],
    otherRewards: ["Access to the Giants' Foundry"],
    buildJournal,
    onReward: grantRewards,
  });

  api.persistAttribute(BITS_ATTRIBUTE);
  api.persistAttribute(TUTORIAL_ATTRIBUTE);

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onNpcInteraction(handleNpcInteraction);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onCustomEvent("giants-foundry:access", answerAccess);
  api.onCustomEvent("giants-foundry:step", handleFoundryStep);
  api.onObjectInteraction(handleObjectInteraction);
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onPlayerLogin(handleLogin);
};
