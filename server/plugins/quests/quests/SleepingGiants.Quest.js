/**
 * Sleeping Giants (members).
 *
 * The words come from the "Sleeping Giants" transcript page; this plugin
 * supplies the variant selector for Kovac, the Strike start on the Giants'
 * Plateau Hill Giant, the prose-condition answers, the tool-repair loop, the
 * crate/crucible/mould sword-making steps, the preform heat/quality working
 * loop and the hand-in reward.
 *
 * Stages (varbit 13902 "sleeping_giants", varp 3428 "giants_foundry_main",
 * bits 0-5; evidence: `server/scripts/lookup-gameval.ts varbit sleeping` ->
 * "13902 sleeping_giants varp=3428 bits=0-5" and cache script 4024 (the quest
 * list's varp getter) mapping quest #154 "Sleeping Giants" -> get_varbit
 * 13902): 1 accepted and repairing the tools, 2 all three tools repaired,
 * 3 Kovac gave the flat broad sword commission, 4 crate looted, 5 crucible
 * full, 6 mould set, 7 metal poured, 8 metal cooled, 9 preform taken,
 * 10 hammered enough (trip hammer), 11 ground enough (grindstone),
 * 12 polished (sword finished), 13 handed in (complete). No cache script reads
 * the value, so this 1..13 progression only has to fit the 6-bit varbit.
 *
 * Source: https://oldschool.runescape.wiki/w/Sleeping_Giants and
 * https://oldschool.runescape.wiki/w/Transcript:Sleeping_Giants
 * Rewards per the OSRS Wiki: 1 Quest point, 6,000 Smithing experience and
 * access to the Giants' Foundry.
 *
 * Gaps / approximations:
 *   - The tutorial's workshop is an instance in OSRS. Here the static
 *     Giants' Foundry room (region x3362 y11484, reached by the real 44635
 *     Cave Enter / 44636 Exit) is the workshop; the interactive objects the
 *     cache does not place there (crucible 43864, mould jig 43865, big chest
 *     43866, crate 44605, preform storage 44604) are registered once at the
 *     free tiles next to Kovac (see ..._TILE constants). They are world
 *     objects, not per-player, so they exist for every player (the open world
 *     has no PrivateArea); every handler scopes to this quest's state.
 *   - The broken tool ids (43857/43860/43862, "Repair") are not in the map
 *     either, so the static repaired tools' "Use" option (44619/44620/44621)
 *     runs the wiki repair transcript while a tool is unrepaired and works the
 *     preform afterwards.
 *   - The mould-selection interface does not exist in this cache; one Inspect
 *     on the mould jig sets the flat broad sword mould.
 *   - The tutorial's temperature/quality bars are approximated by persisted
 *     heat/quality numbers; using the wrong tool or the wrong heat plays the
 *     matching wiki "Stop!" variant and costs 10 quality (0 quality picks the
 *     hand-in's "quality is at 0" branch).
 *   - Each item used on the crucible loads all held items of that type (up to
 *     the 28-bar fill); the wiki's "different items are input separately" is
 *     approximated so the crate's 20 items need two interactions, not twenty.
 *   - "Obor kill count" is read from the GiantLairs plugin's persisted
 *     "giant-lairs:obor-chests-opened" attribute (no kill-count attribute
 *     exists); no Obor chests means the 0-kill branch.
 *   - 11467 (surface Kovac) and 11468 (foundry Kovac) are missing from
 *     npc-spawns.json, so the plugin spawns both once; after completion the
 *     foundry Kovac falls through to the post-quest "Kovac" transcript page.
 */
module.exports = function registerSleepingGiantsQuest(api) {
  const {
    Equipment,
    GameObject,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    ObjectManager,
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
  const CRUCIBLE_OBJECT_ID = ObjectIdentifiers.CRUCIBLE; // 43864, ops Inspect
  const MOULD_JIG_OBJECT_ID = ObjectIdentifiers.MOULD_JIG; // 43865, ops Inspect
  const BIG_CHEST_OBJECT_ID = ObjectIdentifiers.BIG_CHEST_3; // 43866, ops Use|Inspect|Collect
  const PREFORM_STORAGE_OBJECT_ID = ObjectIdentifiers.PREFORM_STORAGE; // 44604, ops Inspect
  const CRATE_OBJECT_ID = ObjectIdentifiers.CRATE_287; // 44605, ops Search

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
    CRUCIBLE_OBJECT_ID,
    MOULD_JIG_OBJECT_ID,
    BIG_CHEST_OBJECT_ID,
    PREFORM_STORAGE_OBJECT_ID,
    CRATE_OBJECT_ID,
  ]);

  const PREFORM_ITEM_ID = ItemIdentifiers.PREFORM; // 27010
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
  const BRONZE_BAR_ITEM_ID = ItemIdentifiers.BRONZE_BAR; // 2349, 1 bar worth
  const IRON_BAR_ITEM_ID = ItemIdentifiers.IRON_BAR; // 2351, 2 bars worth
  const ICE_GLOVES_ITEM_ID = ItemIdentifiers.ICE_GLOVES; // 1580

  const VARP_GIANTS_FOUNDRY = 3428; // "giants_foundry_main"
  const VARBIT_SLEEPING_GIANTS = 13902; // "sleeping_giants", bits 0-5

  const STAGE_STARTED = 1;
  const STAGE_TOOLS_REPAIRED = 2;
  const STAGE_COMMISSION = 3;
  const STAGE_CRATE_LOOTED = 4;
  const STAGE_CRUCIBLE_FULL = 5;
  const STAGE_MOULD_SET = 6;
  const STAGE_POURED = 7;
  const STAGE_COOLED = 8;
  const STAGE_PREFORM_TAKEN = 9;
  const STAGE_HAMMERED = 10;
  const STAGE_GROUND = 11;
  const STAGE_POLISHED = 12;
  const STAGE_COMPLETE = 13;

  const BIT_TRIP_REPAIRED = 1;
  const BIT_GRIND_REPAIRED = 2;
  const BIT_POLISH_REPAIRED = 4;
  const BIT_BRIEFED = 8; // heard "all the tools repaired / make a sword"
  const BIT_MOULD_BRIEFED = 16; // heard "set up a mould"
  const BIT_CRATE_LOOTED = 32;

  const BITS_ATTRIBUTE = "quest.sleeping_giants.bits";
  const METAL_ATTRIBUTE = "quest.sleeping_giants.metal";
  const HEAT_ATTRIBUTE = "quest.sleeping_giants.heat";
  const QUALITY_ATTRIBUTE = "quest.sleeping_giants.quality";
  const TRIP_USES_ATTRIBUTE = "quest.sleeping_giants.trip-uses";
  const GRIND_USES_ATTRIBUTE = "quest.sleeping_giants.grind-uses";
  const POLISH_USES_ATTRIBUTE = "quest.sleeping_giants.polish-uses";
  const OBOR_CHESTS_ATTRIBUTE = "giant-lairs:obor-chests-opened";

  const METAL_REQUIRED = 28; // "28 metal bars worth" (Kovac)
  const CRATE_IRON_BARS = 10;
  const CRATE_BRONZE_BARS = 10;
  const CRATE_SLOTS_REQUIRED = CRATE_IRON_BARS + CRATE_BRONZE_BARS; // the wiki's 20 slots
  const HEAT_MIN = -20;
  const HEAT_MAX = 100;
  const TRIP_MIN_HEAT = 70;
  const GRIND_MIN_HEAT = 30;
  const GRIND_MAX_HEAT = 95;
  const POLISH_MIN_HEAT = 0;
  const POLISH_MAX_HEAT = 30;
  const TRIP_HEAT_STEP = -10;
  const GRIND_HEAT_STEP = 10;
  const USES_REQUIRED = 3;
  const QUALITY_START = 100;
  const QUALITY_DAMAGE = 10;

  const OP_1 = 1;
  const OP_2 = 2;

  /** The free tiles next to Kovac's spawn in the static foundry room. */
  const HILL_GIANT_SPAWN_TILE = { x: 3362, y: 3146 };
  const KOVAC_SPAWN_TILE = { x: 3366, y: 11484 };
  const CRUCIBLE_TILE = { x: 3366, y: 11492 };
  const MOULD_JIG_TILE = { x: 3366, y: 11487 };
  const PREFORM_STORAGE_TILE = { x: 3368, y: 11494 };
  const CRATE_TILE = { x: 3365, y: 11483 };
  const BIG_CHEST_TILE = { x: 3368, y: 11484 };
  const FOUNDRY_LANDING_TILE = { x: 3364, y: 11483 };
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

  function metal(player) {
    return Number(player.getAttribute(METAL_ATTRIBUTE)) || 0;
  }

  function heat(player) {
    const value = Number(player.getAttribute(HEAT_ATTRIBUTE));
    return Number.isFinite(value) ? value : 0;
  }

  function quality(player) {
    const value = Number(player.getAttribute(QUALITY_ATTRIBUTE));
    return Number.isFinite(value) ? value : QUALITY_START;
  }

  function uses(player, attribute) {
    return Number(player.getAttribute(attribute)) || 0;
  }

  function held(player, itemId, amount = 1) {
    return player.getInventory().getAmount(itemId) >= amount;
  }

  function heldPreform(player) {
    return held(player, PREFORM_ITEM_ID);
  }

  function freeHands(player) {
    const equipment = player.getEquipment();
    return !equipment.get(Equipment.WEAPON_SLOT) && !equipment.get(Equipment.SHIELD_SLOT);
  }

  function wearingIceGloves(player) {
    const gloves = player.getEquipment().get(Equipment.HANDS_SLOT);
    return gloves?.getId?.() === ICE_GLOVES_ITEM_ID;
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
    if (
      hasBit(player, BIT_TRIP_REPAIRED)
      && hasBit(player, BIT_GRIND_REPAIRED)
      && hasBit(player, BIT_POLISH_REPAIRED)
    ) {
      quest.setStage(player, STAGE_TOOLS_REPAIRED);
    }
  }

  function allRepaired(player) {
    return hasBit(player, BIT_TRIP_REPAIRED)
      && hasBit(player, BIT_GRIND_REPAIRED)
      && hasBit(player, BIT_POLISH_REPAIRED);
  }

  function resetProgress(player) {
    player.setAttribute(BITS_ATTRIBUTE, 0);
    player.setAttribute(METAL_ATTRIBUTE, 0);
    player.setAttribute(HEAT_ATTRIBUTE, 0);
    player.setAttribute(QUALITY_ATTRIBUTE, QUALITY_START);
    player.setAttribute(TRIP_USES_ATTRIBUTE, 0);
    player.setAttribute(GRIND_USES_ATTRIBUTE, 0);
    player.setAttribute(POLISH_USES_ATTRIBUTE, 0);
  }

  // ==========================================================================
  // World setup (spawns the two quest NPCs and the quest scenery once)
  // ==========================================================================

  function registerObject(objectId, tile) {
    const object = new GameObject(objectId, new Location(tile.x, tile.y, 0), 10, 0, null);
    ObjectManager.register(object, true);
  }

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
    if (!ids.has(KOVAC_NPC_ID)) {
      api.spawnNpc({
        id: KOVAC_NPC_ID,
        x: KOVAC_SPAWN_TILE.x,
        y: KOVAC_SPAWN_TILE.y,
        z: 0,
        wanderRadius: 0,
      });
    }
  }

  function installWorld() {
    if (worldInstalled) return;
    worldInstalled = true;
    registerObject(CRUCIBLE_OBJECT_ID, CRUCIBLE_TILE);
    registerObject(MOULD_JIG_OBJECT_ID, MOULD_JIG_TILE);
    registerObject(PREFORM_STORAGE_OBJECT_ID, PREFORM_STORAGE_TILE);
    registerObject(CRATE_OBJECT_ID, CRATE_TILE);
    registerObject(BIG_CHEST_OBJECT_ID, BIG_CHEST_TILE);
    ensureQuestSpawns();
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
      quest.setStage(player, STAGE_COMMISSION);
      return "make-a-sword-talking-to-kovac";
    }
    if (stage === STAGE_COMMISSION) return "make-a-sword-talking-to-kovac";
    if (stage === STAGE_CRATE_LOOTED) {
      return metal(player) > 0
        ? "make-a-sword-talking-to-kovac-after-partially-filling-the-crucible"
        : "make-a-sword-talking-to-kovac-after-looting-the-crate";
    }
    if (stage === STAGE_CRUCIBLE_FULL) {
      if (!hasBit(player, BIT_MOULD_BRIEFED)) {
        setBit(player, BIT_MOULD_BRIEFED);
        return "make-a-sword-talking-to-kovac-after-filling-the-crucible";
      }
      return "make-a-sword-talking-to-kovac-before-setting-the-mould";
    }
    if (stage === STAGE_MOULD_SET) return "make-a-sword-talking-to-kovac-after-setting-the-mould";
    if (stage === STAGE_POURED) return "make-a-sword-before-picking-up-the-preform";
    if (stage === STAGE_COOLED) return "make-a-sword-talk-to-kovac-after-using-a-bucket-of-water";
    if (stage === STAGE_PREFORM_TAKEN) {
      return uses(player, TRIP_USES_ATTRIBUTE) > 0
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
        if (heldPreform(player)) player.getInventory().deleteNumber(PREFORM_ITEM_ID, 1);
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
    player.getInventory().adds(IRON_BAR_ITEM_ID, CRATE_IRON_BARS);
    player.getInventory().adds(BRONZE_BAR_ITEM_ID, CRATE_BRONZE_BARS);
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

  function inspectCrucible(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMMISSION && metal(player) >= METAL_REQUIRED) {
      if (stage < STAGE_MOULD_SET) {
        player.sendMessage("You should set up the mould before you pour.");
        return;
      }
      if (stage < STAGE_POURED) {
        player.setAttribute(METAL_ATTRIBUTE, 0);
        quest.setStage(player, STAGE_POURED);
        player.sendMessage("You pour the molten metal from the crucible into the mould.");
        return;
      }
    }
    if (stage < STAGE_COMMISSION) {
      inspectVariant(player, "what-is-this-a-workshop-for-giants-inspecting-objects-crucible");
      return;
    }
    player.sendMessage("The crucible is not full yet.");
  }

  function inspectMouldJig(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_MOULD_SET && stage <= STAGE_POURED) {
      player.sendMessage("The mould is set for a flat broad sword.");
      return;
    }
    if (stage >= STAGE_MOULD_SET) return;
    if (stage >= STAGE_COMMISSION && metal(player) >= METAL_REQUIRED) {
      quest.setStage(player, STAGE_MOULD_SET);
      player.sendMessage("You set up the mould for a flat broad sword.");
      return;
    }
    if (stage < STAGE_COMMISSION) {
      inspectVariant(player, "what-is-this-a-workshop-for-giants-inspecting-objects-mould-jig");
      return;
    }
    player.sendMessage("You need to fill the crucible first.");
  }

  function coolMetal(player) {
    quest.setStage(player, STAGE_COOLED);
    player.sendMessage("You pour the water over the molten metal, cooling it.");
  }

  function takePreform(player) {
    if (!freeHands(player)) {
      startKovacVariant(player, "make-a-sword-trying-to-pick-up-the-preform-with-a-weapon-or-shield-equipped");
      return;
    }
    if (player.getInventory().getFreeSlots() < 1) {
      player.sendMessage("You need some free inventory space for the preform.");
      return;
    }
    player.getInventory().adds(PREFORM_ITEM_ID, 1);
    quest.setStage(player, STAGE_PREFORM_TAKEN);
    player.sendMessage("You take the cooled preform from the mould.");
  }

  function inspectMouldJigAfterPour(player) {
    if (wearingIceGloves(player)) {
      quest.setStage(player, STAGE_COOLED);
      takePreform(player);
      return;
    }
    if (quest.getStage(player) >= STAGE_COOLED) {
      takePreform(player);
      return;
    }
    startKovacVariant(player, "make-a-sword-trying-to-pick-up-the-preform-before-cooling-it");
  }

  function applyHeat(player, amount) {
    player.setAttribute(HEAT_ATTRIBUTE, Math.max(HEAT_MIN, Math.min(HEAT_MAX, heat(player) + amount)));
  }

  function damagePreform(player) {
    player.setAttribute(QUALITY_ATTRIBUTE, Math.max(0, quality(player) - QUALITY_DAMAGE));
  }

  /** The preform on the repaired tools: progress, heat windows and warnings. */
  function usePreformOnTool(player, toolId) {
    if (quest.getStage(player) >= STAGE_POLISHED) {
      startKovacVariant(player, "make-a-sword-using-the-finished-sword-on-any-tool-after-its-finished");
      return;
    }
    if (!heldPreform(player) || quest.getStage(player) < STAGE_PREFORM_TAKEN) return;
    if (toolId === TRIP_HAMMER_OBJECT_ID) {
      if (uses(player, TRIP_USES_ATTRIBUTE) >= USES_REQUIRED) {
        damagePreform(player);
        startKovacVariant(player, "make-a-sword-using-a-preform-on-the-trip-hammer-after-its-been-hammered-enough");
        return;
      }
      if (heat(player) < TRIP_MIN_HEAT) {
        damagePreform(player);
        startKovacVariant(player, "make-a-sword-using-a-preform-that-is-too-cold-on-the-trip-hammer");
        return;
      }
      const next = uses(player, TRIP_USES_ATTRIBUTE) + 1;
      player.setAttribute(TRIP_USES_ATTRIBUTE, next);
      applyHeat(player, TRIP_HEAT_STEP);
      if (next >= USES_REQUIRED) quest.setStage(player, STAGE_HAMMERED);
      return;
    }
    if (toolId === GRINDSTONE_OBJECT_ID) {
      if (uses(player, TRIP_USES_ATTRIBUTE) < USES_REQUIRED) {
        damagePreform(player);
        startKovacVariant(player, "make-a-sword-using-a-preform-that-has-not-been-completely-hammered-on-the-grindstone-or-polishing-wheel");
        return;
      }
      if (uses(player, GRIND_USES_ATTRIBUTE) >= USES_REQUIRED) {
        damagePreform(player);
        startKovacVariant(player, "make-a-sword-using-a-preform-on-the-grindstone-after-its-been-ground-enough");
        return;
      }
      if (heat(player) > GRIND_MAX_HEAT) {
        damagePreform(player);
        startKovacVariant(player, "make-a-sword-using-a-preform-that-is-too-hot-on-the-grindstone");
        return;
      }
      if (heat(player) < GRIND_MIN_HEAT) {
        damagePreform(player);
        startKovacVariant(player, "make-a-sword-using-a-preform-that-is-too-cold-on-the-grindstone");
        return;
      }
      const next = uses(player, GRIND_USES_ATTRIBUTE) + 1;
      player.setAttribute(GRIND_USES_ATTRIBUTE, next);
      applyHeat(player, GRIND_HEAT_STEP);
      if (next >= USES_REQUIRED) quest.setStage(player, STAGE_GROUND);
      return;
    }
    if (uses(player, GRIND_USES_ATTRIBUTE) < USES_REQUIRED) {
      damagePreform(player);
      startKovacVariant(player, "make-a-sword-using-a-preform-that-has-not-been-completely-ground-on-the-grindstone-on-the-polishing-wheel");
      return;
    }
    if (heat(player) > POLISH_MAX_HEAT) {
      damagePreform(player);
      startKovacVariant(player, "make-a-sword-using-a-preform-that-is-too-hot-on-the-polishing-wheel");
      return;
    }
    if (heat(player) < POLISH_MIN_HEAT) {
      damagePreform(player);
      startKovacVariant(player, "make-a-sword-using-a-preform-that-is-too-cold-on-the-polishing-wheel");
      return;
    }
    const next = uses(player, POLISH_USES_ATTRIBUTE) + 1;
    player.setAttribute(POLISH_USES_ATTRIBUTE, next);
    if (next >= USES_REQUIRED) {
      quest.setStage(player, STAGE_POLISHED);
      startKovacVariant(player, "make-a-sword-after-polishing-it-enough");
    }
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
      const stage = quest.getStage(player);
      if (stage >= STAGE_PREFORM_TAKEN && stage < STAGE_COMPLETE && heldPreform(player)) {
        event.handled = true;
        usePreformOnTool(player, objectId);
        return;
      }
      if (quest.getStage(player) === STAGE_STARTED && !hasBit(player, REPAIR_BIT_BY_TOOL.get(objectId))) {
        event.handled = true;
        startRepair(player, objectId);
      }
      return;
    }
    if (objectId === LAVA_POOL_OBJECT_ID || objectId === WATERFALL_OBJECT_ID) {
      if (clickType !== OP_1 && clickType !== OP_2) return;
      const stage = quest.getStage(player);
      if (stage >= STAGE_POLISHED && heldPreform(player)) {
        event.handled = true;
        startKovacVariant(player, "make-a-sword-using-the-finished-sword-on-any-tool-after-its-finished");
        return;
      }
      if (!heldPreform(player) || stage < STAGE_PREFORM_TAKEN) {
        if (stage < STAGE_COMMISSION) {
          event.handled = true;
          const variant = objectId === LAVA_POOL_OBJECT_ID
            ? "what-is-this-a-workshop-for-giants-inspecting-objects-lava-pool"
            : "what-is-this-a-workshop-for-giants-inspecting-objects-waterfall";
          inspectVariant(player, variant);
        }
        return;
      }
      event.handled = true;
      if (objectId === LAVA_POOL_OBJECT_ID) {
        applyHeat(player, clickType === OP_2 ? HEAT_MAX : 30);
      } else {
        applyHeat(player, clickType === OP_2 ? -heat(player) : -30);
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
    if (objectId === CRUCIBLE_OBJECT_ID) {
      if (clickType !== OP_1) return;
      event.handled = true;
      inspectCrucible(player);
      return;
    }
    if (objectId === MOULD_JIG_OBJECT_ID) {
      if (clickType !== OP_1) return;
      event.handled = true;
      const stage = quest.getStage(player);
      if (stage === STAGE_POURED || stage === STAGE_COOLED) inspectMouldJigAfterPour(player);
      else inspectMouldJig(player);
      return;
    }
    if (objectId === PREFORM_STORAGE_OBJECT_ID) {
      if (clickType !== OP_1) return;
      event.handled = true;
      inspectVariant(player, "what-is-this-a-workshop-for-giants-inspecting-objects-preform-storage");
      return;
    }
    if (objectId === BIG_CHEST_OBJECT_ID) {
      if (clickType === OP_1) {
        event.handled = true;
        player.getBank(player.getCurrentBankTab()).open();
        return;
      }
      if (clickType === OP_2) {
        event.handled = true;
        inspectVariant(player, "what-is-this-a-workshop-for-giants-inspecting-objects-big-chest");
      }
      return;
    }
    if (objectId === CRATE_OBJECT_ID) {
      if (clickType !== OP_1) return;
      event.handled = true;
      searchCrate(player);
    }
  }

  function metalValue(itemId) {
    if (itemId === BRONZE_BAR_ITEM_ID) return 1;
    if (itemId === IRON_BAR_ITEM_ID) return 2;
    return 0;
  }

  /** One item load of a metal type fills the crucible up to the 28-bar mark. */
  function useMetalOnCrucible(player, itemId) {
    if (quest.getStage(player) < STAGE_COMMISSION) {
      player.sendMessage("You should speak to Kovac first.");
      return;
    }
    if (heldPreform(player)) {
      startKovacVariant(player, "make-a-sword-attempting-to-fill-the-crucible-before-handing-in-the-preform");
      return;
    }
    const value = metalValue(itemId);
    if (value <= 0) return;
    const current = metal(player);
    if (current >= METAL_REQUIRED) {
      player.sendMessage("The crucible is already full.");
      return;
    }
    const needed = Math.ceil((METAL_REQUIRED - current) / value);
    const take = Math.min(player.getInventory().getAmount(itemId), needed);
    player.getInventory().deleteNumber(itemId, take);
    const filled = current + take * value;
    player.setAttribute(METAL_ATTRIBUTE, filled);
    if (filled >= METAL_REQUIRED) {
      quest.setStage(player, STAGE_CRUCIBLE_FULL);
      player.sendMessage("The crucible is full.");
    }
  }

  function handleItemOnObject(event) {
    const { player, itemId, objectId } = event;
    if (!QUEST_OBJECT_IDS.has(objectId)) return;
    if (objectId === CRUCIBLE_OBJECT_ID) {
      event.handled = true;
      useMetalOnCrucible(player, itemId);
      return;
    }
    if (objectId === MOULD_JIG_OBJECT_ID) {
      if (itemId === BUCKET_OF_WATER_ITEM_ID && quest.getStage(player) === STAGE_POURED) {
        event.handled = true;
        player.getInventory().deleteNumber(BUCKET_OF_WATER_ITEM_ID, 1);
        player.getInventory().adds(BUCKET_ITEM_ID, 1);
        coolMetal(player);
      }
      return;
    }
    if (objectId === WATERFALL_OBJECT_ID) {
      if (itemId === BUCKET_ITEM_ID) {
        event.handled = true;
        player.getInventory().deleteNumber(BUCKET_ITEM_ID, 1);
        player.getInventory().adds(BUCKET_OF_WATER_ITEM_ID, 1);
        return;
      }
      if (itemId === PREFORM_ITEM_ID && quest.getStage(player) >= STAGE_PREFORM_TAKEN) {
        event.handled = true;
        applyHeat(player, -heat(player));
      }
      return;
    }
    if (objectId === LAVA_POOL_OBJECT_ID && itemId === PREFORM_ITEM_ID
      && quest.getStage(player) >= STAGE_PREFORM_TAKEN) {
      event.handled = true;
      applyHeat(player, HEAT_MAX - heat(player));
      return;
    }
    if (TOOL_OBJECT_IDS.has(objectId) && itemId === PREFORM_ITEM_ID) {
      event.handled = true;
      usePreformOnTool(player, objectId);
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
        lines.push("I should cool the metal with a <col=800000>bucket of water</col>.");
      } else if (stage === STAGE_COOLED) {
        lines.push("I should take the <col=800000>preform</col> from the mould.");
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

  function handleLogin({ player }) {
    refreshQuestList(player);
    installWorld();
  }

  quest = registerQuest(api, {
    key: "sleeping_giants",
    name: "Sleeping Giants",
    varpId: VARP_GIANTS_FOUNDRY,
    varbitId: VARBIT_SLEEPING_GIANTS,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.SMITHING.getIndex(), amount: 6000, label: "Smithing" }],
    otherRewards: ["Access to the Giants' Foundry"],
    buildJournal,
    onReward: grantRewards,
  });

  api.persistAttribute(BITS_ATTRIBUTE);
  api.persistAttribute(METAL_ATTRIBUTE);
  api.persistAttribute(HEAT_ATTRIBUTE);
  api.persistAttribute(QUALITY_ATTRIBUTE);
  api.persistAttribute(TRIP_USES_ATTRIBUTE);
  api.persistAttribute(GRIND_USES_ATTRIBUTE);
  api.persistAttribute(POLISH_USES_ATTRIBUTE);

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onNpcInteraction(handleNpcInteraction);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onObjectInteraction(handleObjectInteraction);
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onPlayerLogin(handleLogin);
};
