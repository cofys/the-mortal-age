/**
 * At First Light (members).
 *
 * The words come from the "At First Light" transcript page (OSRS Wiki); this plugin
 * supplies the NPC variant selector, the start hook, the prose-condition answers,
 * the hand-ins (toy mouse, poultice, fur sample, trimmed fur, report), the bush
 * pickups, the cat-bed check/repair and Atza's equipment setup.
 *
 * Stage lives in varbit 9835 "afl" (varp 4151 "afl_main", bits 0-4). Evidence:
 * scripts/lookup-gameval.ts varbit afl -> varp=4151 bits=0-4; cs2 script 4024 maps
 * quest dbrow 3513 ("At First Light", table 0) -> get_varbit 9835, and script 4029
 * reads that dbrow's col 19 (=12) as the completion stage. The multi-loc transform
 * tables confirm the checkpoints: 50876/50877 (bushes) offer "Pick" only at varbit
 * 9835 == 5, 50878 (cat bed) offers "Check" at 3..10, and 52976 (equipment pile)
 * switches on varbit 9840 "afl_housetrapped" (1 = "Set-up", 2 = set up).
 *
 * Stages: 1 started, 2 spoke to Verity, 3 Wolf gave the toy mouse, 4 checked the
 * cat bed, 5 Wolf's pyre-fox hint (bushes pickable, Fox appears), 6 found Fox,
 * 7 gave Fox the poultice, 8 gave Atza the fur sample, 9 set up the equipment and
 * got the trimmed fur, 10 Fox's report, 11 report delivered, 12 complete. Intermediate
 * values 2-11 follow the wiki journal checkpoints; the cache only exposes the bounds
 * (1/12) and the checks above.
 *
 * Source: OSRS Wiki "At First Light", quick guide, transcript and journal transcript.
 * Rewards per the wiki: 1 Quest point, 4,500 Hunter, 800 Construction and 500 Herblore
 * XP, and access to Master Tier Hunters' Rumours.
 *
 * Gaps / approximations:
 *  - Apatura, Kiko, Atza and the injured Fox have no npc-spawns.json entries, so they
 *    are per-player owner-only spawns (as Children of the Sun does for its NPCs).
 *  - Catching embertailed jerboas is not implemented in the hunter skill (no creature
 *    data), and Varlamore has no ground-item spawns for the quest's hammer/needle, so
 *    a real player needs those from elsewhere; jerboa tails come only from ::item here.
 *  - SdFoGP answers from the catspeak amulet only; Dragon Slayer II is not implemented,
 *    so a DS2-completed account without the amulet still gets Kiko's plain pet message.
 *  - The lost-fur-sample replacement branches (obG97l/XRTAlW) are covered by the plain
 *    "before getting the fur sample" hand-out instead of their own lines.
 *  - Apatura completes the quest when the final variant is selected; the runtime defers
 *    the scroll until the chatbox closes. Verity and Wolf fall through to Hunter.plugin.js
 *    (their rumour hooks) once the quest no longer needs them; Atza replays her
 *    after-quest page variant (the dump has no post-quest Apatura/Fox ones).
 */
module.exports = function registerAtFirstLightQuest(api) {
  const { ObjectDefinition, Skill, ItemIdentifiers, NpcIdentifiers, ObjectIdentifiers } =
    api.core;
  const { registerQuest, refreshQuestList, startTranscript, startDialogue } =
    require("../QuestRuntime");

  // Varp 4151 "afl_main"; the stage is varbit 9835 "afl" (bits 0-4).
  const VARP_AT_FIRST_LIGHT = 4151;
  const STAGE_VARBIT = 9835;
  const HOUSETRAPPED_VARBIT = 9840; // "afl_housetrapped", bits 9-10 of the same varp

  const PAGE = "At First Light";
  const START_HOOK = "quest:at-first-light:start";

  const STAGE_STARTED = 1;
  const STAGE_VERITY = 2;
  const STAGE_WOLF = 3;
  const STAGE_BED_CHECKED = 4;
  const STAGE_WOLF_HINT = 5;
  const STAGE_FOX_FOUND = 6;
  const STAGE_POULTICE = 7;
  const STAGE_SAMPLE_GIVEN = 8;
  const STAGE_EQUIPMENT = 9;
  const STAGE_REPORT = 10;
  const STAGE_REPORT_DELIVERED = 11;
  const STAGE_COMPLETE = 12;

  const APATURA_NPC_ID = NpcIdentifiers.GUILDMASTER_APATURA; // 13120
  const WOLF_NPC_ID = NpcIdentifiers.GUILD_HUNTER_WOLF_MASTER_; // 13126
  const VERITY_NPC_ID = NpcIdentifiers.GUILD_SCRIBE_VERITY; // 13127
  const KIKO_NPC_ID = NpcIdentifiers.GUILD_HUNTER_KIKO; // 12934
  const ATZA_NPC_ID = NpcIdentifiers.ATZA; // 12933
  const FOX_NPC_ID = NpcIdentifiers.GUILD_HUNTER_FOX; // 12932, the injured Fox (wiki "Injured")
  const ATZA_NPC_NAME = "Atza";
  const KIKO_NPC_NAME = "Guild Hunter Kiko";
  const VERITY_NPC_NAME = "Guild Scribe Verity";
  const WOLF_NPC_NAME = "Guild Hunter Wolf (Master)";

  const TOY_MOUSE_ITEM_ID = ItemIdentifiers.TOY_MOUSE; // 7767
  const WOUND_TOY_MOUSE_ITEM_ID = ItemIdentifiers.TOY_MOUSE_WOUND_; // 7769
  const SMOOTH_LEAF_ITEM_ID = ItemIdentifiers.SMOOTH_LEAF; // 28978
  const STICKY_LEAF_ITEM_ID = ItemIdentifiers.STICKY_LEAF; // 28979
  const MAKESHIFT_POULTICE_ITEM_ID = ItemIdentifiers.MAKESHIFT_POULTICE; // 28980
  const FUR_SAMPLE_ITEM_ID = ItemIdentifiers.FUR_SAMPLE; // 28981
  const TRIMMED_FUR_ITEM_ID = ItemIdentifiers.TRIMMED_FUR; // 28982
  const FOXS_REPORT_ITEM_ID = ItemIdentifiers.FOXS_REPORT; // 28983
  const JERBOA_TAIL_ITEM_ID = ItemIdentifiers.JERBOA_TAIL; // 29166
  const HAMMER_ITEM_ID = ItemIdentifiers.HAMMER; // 2347
  const NEEDLE_ITEM_ID = ItemIdentifiers.NEEDLE; // 1733
  const COSTUME_NEEDLE_ITEM_ID = ItemIdentifiers.COSTUME_NEEDLE; // 29920
  const CATSPEAK_AMULET_ITEM_IDS = [
    ItemIdentifiers.CATSPEAK_AMULET, // 4677
    ItemIdentifiers.CATSPEAK_AMULET_E_, // 6544
  ];

  // Loc 53011 "Cat bed" (Check), 53012 the no-op sibling at stage 11+.
  const CAT_BED_CHECK_OBJECT_ID = ObjectIdentifiers.CAT_BED; // 53011
  const CAT_BED_NOOP_OBJECT_ID = ObjectIdentifiers.CAT_BED_2; // 53012
  const LEAFY_BUSH_PICK_OBJECT_ID = ObjectIdentifiers.LEAFY_BUSH; // 53020
  const ROUGH_BUSH_PICK_OBJECT_ID = ObjectIdentifiers.ROUGH_LOOKING_BUSH; // 53022
  const EQUIPMENT_SETUP_OBJECT_ID = ObjectIdentifiers.PILE_OF_EQUIPMENT_2; // 50880

  // Per-player spawns: none of these exist in npc-spawns.json.
  const APATURA_SPAWN = { id: APATURA_NPC_ID, x: 1555, y: 3035, z: 0, wanderRadius: 0 };
  const KIKO_SPAWN = { id: KIKO_NPC_ID, x: 1552, y: 9460, z: 0, wanderRadius: 0 };
  const ATZA_SPAWN = { id: ATZA_NPC_ID, x: 1697, y: 3064, z: 0, wanderRadius: 0 };
  const FOX_SPAWN = { id: FOX_NPC_ID, x: 1623, y: 2982, z: 0, wanderRadius: 0 };

  const FLAGS_ATTRIBUTE = "quest.at_first_light.flags";
  const BIT_BED_REPAIRED = 1 << 0;
  const BIT_CAT_DISTRACTED = 1 << 1;

  // "If the player has no inventory space:" and its friends.
  const NO_SPACE_CONDITION_IDS = new Set([
    "e8Gw-V",
    "nG-8od",
    "I-q-Xd",
    "6bjit4",
    "44YziC",
    "etZ1L7",
  ]);

  const spawnedNpcs = new WeakMap();
  let quest;

  const held = (player, itemId, amount = 1) =>
    player.getInventory().getAmount(itemId) >= amount;
  const inventoryFull = (player) => player.getInventory().isFull();
  const holdsMouse = (player) =>
    held(player, TOY_MOUSE_ITEM_ID) || held(player, WOUND_TOY_MOUSE_ITEM_ID);

  function flags(player) {
    return Number(player.getAttribute(FLAGS_ATTRIBUTE)) || 0;
  }

  function hasFlag(player, bit) {
    return (flags(player) & bit) !== 0;
  }

  function setFlag(player, bit) {
    player.setAttribute(FLAGS_ATTRIBUTE, flags(player) | bit);
  }

  /** The equipment pile's multi-loc state, derived from the stage (varbit 9840). */
  function housetrappedValue(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_EQUIPMENT) return 2;
    if (stage >= STAGE_SAMPLE_GIVEN) return 1;
    return 0;
  }

  function syncHousetrapped(player) {
    player.getPacketSender().sendVarbit(HOUSETRAPPED_VARBIT, housetrappedValue(player));
  }

  function isQuestComplete(player, key) {
    const request = { player, key };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    return (
      skills.getMaxLevel(Skill.HUNTER) >= 46 &&
      skills.getMaxLevel(Skill.HERBLORE) >= 30 &&
      skills.getMaxLevel(Skill.CONSTRUCTION) >= 27 &&
      isQuestComplete(player, "children_of_the_sun") &&
      isQuestComplete(player, "eagles_peak")
    );
  }

  function hasCatspeakAmulet(player) {
    return CATSPEAK_AMULET_ITEM_IDS.some((itemId) => held(player, itemId));
  }

  function canRepairBed(player) {
    return (
      held(player, TRIMMED_FUR_ITEM_ID) &&
      held(player, JERBOA_TAIL_ITEM_ID) &&
      (held(player, NEEDLE_ITEM_ID) || held(player, COSTUME_NEEDLE_ITEM_ID))
    );
  }

  /** Advances the stage (and syncs spawns/varbits) without ever regressing. */
  function advance(player, stage) {
    if (quest.getStage(player) >= stage) return;
    quest.setStage(player, stage);
    ensureQuestNpcs(player);
    syncHousetrapped(player);
  }

  // ==========================================================================
  // Variant selection
  // ==========================================================================

  function selectVariant({ npcId, player }) {
    if (!player) return null;
    if (npcId === APATURA_NPC_ID) return selectApaturaVariant(player);
    if (npcId === VERITY_NPC_ID) return selectVerityVariant(player);
    if (npcId === WOLF_NPC_ID) return selectWolfVariant(player);
    if (npcId === FOX_NPC_ID) return selectFoxVariant(player);
    return null;
  }

  function selectApaturaVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return null; // her standard-dialogue-subsequent-dialogue
    if (stage >= STAGE_REPORT_DELIVERED) {
      if (hasFlag(player, BIT_BED_REPAIRED)) {
        quest.complete(player);
        return "finishing-up-talking-to-apatura";
      }
      return null; // nothing to report until the bed is fixed
    }
    if (stage >= STAGE_POULTICE) {
      return "fox-tracking-talking-to-guildmaster-apatura-after-giving-guild-hunter-fox-the-poultice";
    }
    if (stage >= STAGE_FOX_FOUND) {
      return "fox-tracking-talking-to-guildmaster-apatura-after-finding-guild-hunter-fox";
    }
    if (stage >= STAGE_WOLF) {
      return "a-missing-fox-talking-to-guildmaster-apatura-after-checking-the-cat-bed";
    }
    if (stage >= STAGE_VERITY) {
      return "a-missing-fox-talking-to-guildmaster-apatura-after-talking-to-verity";
    }
    if (stage >= STAGE_STARTED) {
      return "a-missing-fox-talking-to-guildmaster-apatura-talking-to-apatura-again";
    }
    return "a-missing-fox-talking-to-guildmaster-apatura";
  }

  function selectVerityVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return null; // her standard-dialogue
    if (stage >= STAGE_REPORT_DELIVERED) {
      return hasFlag(player, BIT_BED_REPAIRED)
        ? "finishing-up-talking-to-guild-scribe-verity-after-repairing-the-bed"
        : "finishing-up-talking-to-verity-before-repairing-the-bed";
    }
    if (stage >= STAGE_REPORT) {
      return held(player, FOXS_REPORT_ITEM_ID) ? "finishing-up-talking-to-verity" : null;
    }
    if (stage >= STAGE_POULTICE) {
      return "fox-tracking-talking-to-guild-scribe-verity-after-giving-fox-the-poultice";
    }
    if (stage >= STAGE_FOX_FOUND) {
      return "fox-tracking-talking-to-guild-scribe-verity-after-talking-to-fox";
    }
    if (stage >= STAGE_WOLF) return "a-missing-fox-talking-to-verity-after-speaking-to-wolf";
    if (stage >= STAGE_VERITY) {
      return "a-missing-fox-talking-to-guild-scribe-verity-talking-to-verity-again";
    }
    if (stage >= STAGE_STARTED) return "a-missing-fox-talking-to-guild-scribe-verity";
    return null;
  }

  function selectWolfVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return { page: "Guild Hunter Wolf (Master)", variant: "standard-dialogue-after-talking-to-verity" };
    }
    if (stage >= STAGE_REPORT_DELIVERED) {
      return hasFlag(player, BIT_BED_REPAIRED)
        ? "finishing-up-talking-to-guild-hunter-wolf-after-repairing-the-bed"
        : "finishing-up-talking-to-guild-hunter-wolf-after-turning-in-the-report";
    }
    if (stage >= STAGE_POULTICE) {
      return "fox-tracking-talking-to-guild-hunter-wolf-after-giving-fox-the-poultice";
    }
    if (stage >= STAGE_FOX_FOUND) {
      return "fox-tracking-talking-to-guild-hunter-wolf-after-talking-to-fox";
    }
    if (stage >= STAGE_WOLF_HINT) {
      return "a-missing-fox-talking-to-wolf-after-inspecting-the-cat-bed-talking-to-wolf-again";
    }
    if (stage >= STAGE_BED_CHECKED) {
      advance(player, STAGE_WOLF_HINT);
      return "a-missing-fox-talking-to-wolf-after-inspecting-the-cat-bed";
    }
    if (stage >= STAGE_WOLF) return "a-missing-fox-talking-to-guild-hunter-wolf-talking-to-wolf-again";
    if (stage >= STAGE_VERITY) return "a-missing-fox-talking-to-guild-hunter-wolf";
    return null;
  }

  function selectFoxVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return null;
    if (stage >= STAGE_REPORT_DELIVERED) {
      return "finishing-up-talking-to-guild-hunter-fox-after-turning-in-the-report";
    }
    if (stage >= STAGE_REPORT) {
      return "fox-tracking-reading-fox-s-report-talking-to-fox-again";
    }
    if (stage >= STAGE_EQUIPMENT) return "fox-tracking-talking-to-fox";
    if (stage >= STAGE_SAMPLE_GIVEN) {
      return "fox-tracking-talking-to-fox-after-giving-atza-the-material";
    }
    if (stage >= STAGE_POULTICE) {
      if (!held(player, FUR_SAMPLE_ITEM_ID) && !inventoryFull(player)) {
        return "fox-tracking-talking-to-fox-before-getting-the-fur-sample-with-inventory-space";
      }
      return "fox-tracking-talking-to-fox-before-getting-the-fur-sample-with-inventory-space-talking-to-fox-again";
    }
    if (stage >= STAGE_FOX_FOUND) {
      return held(player, MAKESHIFT_POULTICE_ITEM_ID)
        ? "fox-tracking-talking-to-fox-with-the-makeshift-poultice"
        : "fox-tracking-talking-to-guild-hunter-fox-talking-to-fox-again";
    }
    if (stage >= STAGE_WOLF_HINT) {
      advance(player, STAGE_FOX_FOUND);
      return "fox-tracking-talking-to-guild-hunter-fox";
    }
    return null;
  }

  // ==========================================================================
  // Prose conditions
  // ==========================================================================

  function answerCondition({ player, stepId }) {
    const stage = quest.getStage(player);
    if (NO_SPACE_CONDITION_IDS.has(stepId)) return inventoryFull(player);
    switch (stepId) {
      case "X-9CI3": // does not meet the quest's requirements
        return !meetsRequirements(player);
      case "2AzwyN": // never talked to Verity
        return stage <= STAGE_STARTED;
      case "dgY8x-": // previously talked to Verity
        return stage > STAGE_STARTED;
      case "iOxnjg": // space and has not yet gotten the mouse
        return !inventoryFull(player) && stage < STAGE_WOLF;
      case "SHkSHB": // has the toy mouse in their inventory
        return holdsMouse(player);
      case "vL-AZN": // lost the toy mouse
        return stage >= STAGE_WOLF && !holdsMouse(player);
      case "SdFoGP": // no catspeak amulet or Dragon Slayer II
        return !hasCatspeakAmulet(player);
      case "xAmw_A": // has a toy mouse (wound)
        return held(player, WOUND_TOY_MOUSE_ITEM_ID) || hasFlag(player, BIT_CAT_DISTRACTED);
      case "aXen1A": // already has a smooth leaf
        return held(player, SMOOTH_LEAF_ITEM_ID);
      case "DM1ufw": // already has a sticky leaf
        return held(player, STICKY_LEAF_ITEM_ID);
      case "W8dord": // still has the fur sample, or full and not yet received
        return held(player, FUR_SAMPLE_ITEM_ID) || inventoryFull(player);
      case "XRTAlW": // lost the fur sample and has a full inventory
        return !held(player, FUR_SAMPLE_ITEM_ID) && inventoryFull(player);
      case "obG97l": // lost the fur sample
        return !held(player, FUR_SAMPLE_ITEM_ID);
      case "SVFxAS": // Atza: lost the sample
        return stage >= STAGE_POULTICE && !held(player, FUR_SAMPLE_ITEM_ID);
      case "t0t5aX": // lost the trimmed fur
        return stage >= STAGE_EQUIPMENT && !held(player, TRIMMED_FUR_ITEM_ID) &&
          !hasFlag(player, BIT_BED_REPAIRED);
      case "zL_kax": // still has the trimmed fur
        return held(player, TRIMMED_FUR_ITEM_ID);
      case "z0q-oA": // lost Fox's report
        return stage >= STAGE_REPORT && stage < STAGE_REPORT_DELIVERED &&
          !held(player, FOXS_REPORT_ITEM_ID);
      case "PUZnFQ": // still has Fox's report
        return held(player, FOXS_REPORT_ITEM_ID);
      case "cAMLzj": // does not have the items to repair the bed
        return !canRepairBed(player);
      case "QfBega": // has the items to repair the bed
        return canRepairBed(player);
      default:
        return null;
    }
  }

  // ==========================================================================
  // Dialogue side effects
  // ==========================================================================

  function handleStartHook({ player, npcId, hook }) {
    if (npcId !== APATURA_NPC_ID || hook !== START_HOOK) return;
    if (quest.getStage(player) !== 0) return;
    player.setAttribute(FLAGS_ATTRIBUTE, 0); // a ::quest reset keeps stale flags otherwise
    advance(player, STAGE_STARTED);
  }

  /** Verity's first-time/previously-talked branch marks the stage advance. */
  function handleConditionChosen(event) {
    const { player, npcId, stepId } = event;
    if (npcId !== VERITY_NPC_ID) return;
    if (stepId !== "2AzwyN" && stepId !== "dgY8x-") return;
    if (quest.getStage(player) < STAGE_VERITY) advance(player, STAGE_VERITY);
  }

  function handleDialogueAction(event) {
    const { player, stepId } = event;
    switch (stepId) {
      case "NIGwV0": // Wolf hands you a small toy mouse.
      case "FAtnvh":
        if (!holdsMouse(player) && !inventoryFull(player)) {
          player.getInventory().adds(TOY_MOUSE_ITEM_ID, 1);
        }
        advance(player, STAGE_WOLF);
        return;
      case "MdlNBh": // You check the cat's bed...
        if (held(player, WOUND_TOY_MOUSE_ITEM_ID)) {
          player.getInventory().deleteNumber(WOUND_TOY_MOUSE_ITEM_ID, 1);
        }
        setFlag(player, BIT_CAT_DISTRACTED);
        advance(player, STAGE_BED_CHECKED);
        return;
      case "LNk3X1": // Kiko happily starts playing with the toy mouse.
        if (held(player, WOUND_TOY_MOUSE_ITEM_ID)) {
          player.getInventory().deleteNumber(WOUND_TOY_MOUSE_ITEM_ID, 1);
        }
        setFlag(player, BIT_CAT_DISTRACTED);
        return;
      case "EU-hSW": // You give the poultice to Fox.
        if (held(player, MAKESHIFT_POULTICE_ITEM_ID)) {
          player.getInventory().deleteNumber(MAKESHIFT_POULTICE_ITEM_ID, 1);
        }
        advance(player, STAGE_POULTICE);
        return;
      case "PGRj0H": // Fox gives you a fur sample.
      case "rc_N8o":
      case "-cQ3L8":
        if (!held(player, FUR_SAMPLE_ITEM_ID) && !inventoryFull(player)) {
          player.getInventory().adds(FUR_SAMPLE_ITEM_ID, 1);
        }
        return;
      case "a-lgm5": // You give the fur sample to Atza.
        if (held(player, FUR_SAMPLE_ITEM_ID)) {
          player.getInventory().deleteNumber(FUR_SAMPLE_ITEM_ID, 1);
        }
        advance(player, STAGE_SAMPLE_GIVEN);
        return;
      case "CTBIaF": // Atza gives you some trimmed fur (equipment set up).
      case "KG819o":
      case "DbDMlx":
        if (!held(player, TRIMMED_FUR_ITEM_ID) && !inventoryFull(player)) {
          player.getInventory().adds(TRIMMED_FUR_ITEM_ID, 1);
        }
        advance(player, STAGE_EQUIPMENT);
        return;
      case "L7f8Yj": // Fox gives you a report.
      case "LUIK9t": // Fox writes up another report...
        if (!held(player, FOXS_REPORT_ITEM_ID) && !inventoryFull(player)) {
          player.getInventory().adds(FOXS_REPORT_ITEM_ID, 1);
        }
        if (stepId === "L7f8Yj") advance(player, STAGE_REPORT);
        return;
      case "qTFJ7n": // You give Fox's report to Guild Scribe Verity.
        if (held(player, FOXS_REPORT_ITEM_ID)) {
          player.getInventory().deleteNumber(FOXS_REPORT_ITEM_ID, 1);
        }
        advance(player, STAGE_REPORT_DELIVERED);
        return;
      case "fZnlnI": // You carefully fix up Kiko's bed.
        if (held(player, TRIMMED_FUR_ITEM_ID)) {
          player.getInventory().deleteNumber(TRIMMED_FUR_ITEM_ID, 1);
        }
        if (held(player, JERBOA_TAIL_ITEM_ID)) {
          player.getInventory().deleteNumber(JERBOA_TAIL_ITEM_ID, 1);
        }
        setFlag(player, BIT_BED_REPAIRED);
        return;
      default:
        return;
    }
  }

  // ==========================================================================
  // Kiko (Pet) and Atza (Talk-to); Atza is not indexed to this transcript page.
  // Verity and Wolf are claimed back from Hunter.plugin.js's rumour Talk-to
  // hooks while the quest needs them (this plugin registers before Hunter).
  // ==========================================================================

  function playAtza(player, variant) {
    startTranscript(api, player, ATZA_NPC_ID, PAGE, variant);
  }

  function handleAtzaTalk(event) {
    const { player, npcId } = event;
    if (npcId !== ATZA_NPC_ID) return;
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      startTranscript(api, player, ATZA_NPC_ID, "Atza", "standard-dialogue-after-finishing-at-first-light");
      return;
    }
    if (stage < STAGE_POULTICE) {
      startTranscript(api, player, ATZA_NPC_ID, "Atza", "standard-dialogue-before-at-first-light");
      return;
    }
    if (stage >= STAGE_EQUIPMENT) {
      if (held(player, TRIMMED_FUR_ITEM_ID)) {
        playAtza(player, "fox-tracking-talking-to-atza-after-setting-up-the-equipment-talking-to-atza-again");
      } else {
        playAtza(player, "fox-tracking-talking-to-atza-after-setting-up-the-equipment");
      }
      return;
    }
    if (stage >= STAGE_SAMPLE_GIVEN) {
      playAtza(player, "fox-tracking-talking-to-atza-after-she-asks-to-set-up-the-equipment");
      return;
    }
    playAtza(player, "fox-tracking-talking-to-atza");
  }

  function handlePetKiko(event) {
    const { player, npcId } = event;
    if (npcId !== KIKO_NPC_ID) return;
    const stage = quest.getStage(player);
    if (stage >= STAGE_WOLF && stage < STAGE_COMPLETE) {
      startTranscript(api, player, KIKO_NPC_ID, PAGE, "a-missing-fox-petting-kiko");
      return;
    }
    startTranscript(api, player, KIKO_NPC_ID, "Guild Hunter Kiko", "petting-kiko-without-a-catspeak-amulet");
  }

  /**
   * Hunter.plugin.js claims Verity's and Wolf's Talk-to for rumours and always
   * handles the click, which starves this quest's variant selector. Claim it
   * first while a quest stage has a variant; return false on every other stage
   * (not started, complete, stage 10 without the report) so Hunter still runs.
   */
  function handleVerityTalk(event) {
    const { player, npcId } = event;
    if (npcId !== VERITY_NPC_ID) return false;
    const variant = selectVerityVariant(player);
    if (typeof variant !== "string") return false;
    startTranscript(api, player, VERITY_NPC_ID, PAGE, variant);
    return true;
  }

  function handleWolfTalk(event) {
    const { player, npcId } = event;
    if (npcId !== WOLF_NPC_ID) return false;
    const variant = selectWolfVariant(player);
    if (typeof variant !== "string") return false;
    startTranscript(api, player, WOLF_NPC_ID, PAGE, variant);
    return true;
  }

  // ==========================================================================
  // Objects
  // ==========================================================================

  function pickLeaf(player, itemId, message) {
    if (quest.getStage(player) !== STAGE_WOLF_HINT) return;
    if (held(player, itemId)) {
      startDialogue(api, player, { npcId: FOX_NPC_ID }, [
        { player: ["I don't think I need any more leaves from this bush."] },
      ]);
      return;
    }
    if (inventoryFull(player)) {
      player.sendMessage("You don't have enough inventory space.");
      return;
    }
    player.getInventory().adds(itemId, 1);
    player.sendMessage(message);
  }

  function checkCatBed(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_WOLF || stage > STAGE_REPORT) return;
    if (stage >= STAGE_BED_CHECKED) {
      startTranscript(
        api,
        player,
        KIKO_NPC_ID,
        PAGE,
        "a-missing-fox-using-a-wound-toy-mouse-on-kiko-or-the-cat-bed-checking-the-bed-again"
      );
      return;
    }
    // The xAmw_A answer decides whether Kiko lets the player look.
    startTranscript(api, player, KIKO_NPC_ID, PAGE, "a-missing-fox-checking-the-cat-bed");
  }

  function setUpEquipment(player) {
    if (quest.getStage(player) !== STAGE_SAMPLE_GIVEN) return;
    if (!held(player, HAMMER_ITEM_ID)) {
      player.sendMessage("You need a hammer to set up this equipment.");
      return;
    }
    startTranscript(api, player, ATZA_NPC_ID, PAGE, "fox-tracking-setting-up-the-pile-of-equipment");
  }

  function handleObjectInteraction(event) {
    const { player } = event;
    const definition = event.definition ?? ObjectDefinition.forPlayer(event.objectId, player);
    const resolvedId = definition?.id ?? event.objectId;
    const action = String((definition?.getActions?.() ?? [])[event.clickType - 1] ?? "");
    if (resolvedId === LEAFY_BUSH_PICK_OBJECT_ID && action === "Pick") {
      event.handled = true;
      pickLeaf(player, SMOOTH_LEAF_ITEM_ID, "You pull a smooth leaf off the bush.");
      return;
    }
    if (resolvedId === ROUGH_BUSH_PICK_OBJECT_ID && action === "Pick") {
      event.handled = true;
      pickLeaf(player, STICKY_LEAF_ITEM_ID, "You pull a sticky leaf off the bush.");
      return;
    }
    const isCatBed = resolvedId === CAT_BED_CHECK_OBJECT_ID || resolvedId === CAT_BED_NOOP_OBJECT_ID;
    if (isCatBed && action === "Check") {
      event.handled = true;
      checkCatBed(player);
      return;
    }
    if (resolvedId === EQUIPMENT_SETUP_OBJECT_ID && action === "Set-up") {
      event.handled = true;
      setUpEquipment(player);
    }
  }

  // ==========================================================================
  // Items
  // ==========================================================================

  function handleItemOnObject(event) {
    const { player, itemId } = event;
    const definition = ObjectDefinition.forPlayer(event.objectId, player);
    const resolvedId = definition?.id ?? event.objectId;
    const isCatBed = resolvedId === CAT_BED_CHECK_OBJECT_ID || resolvedId === CAT_BED_NOOP_OBJECT_ID;
    if (!isCatBed) return;
    if (itemId === TRIMMED_FUR_ITEM_ID) {
      event.handled = true;
      if (quest.getStage(player) < STAGE_EQUIPMENT) return;
      if (hasFlag(player, BIT_BED_REPAIRED)) {
        player.sendMessage("You have already repaired this bed.");
        return;
      }
      startTranscript(api, player, KIKO_NPC_ID, PAGE, "finishing-up-repairing-kiko-s-bed");
      return;
    }
    if (itemId === WOUND_TOY_MOUSE_ITEM_ID && quest.getStage(player) === STAGE_WOLF) {
      event.handled = true;
      startTranscript(
        api,
        player,
        KIKO_NPC_ID,
        PAGE,
        "a-missing-fox-using-a-wound-toy-mouse-on-kiko-or-the-cat-bed"
      );
    }
  }

  function handleItemOnItem(event) {
    const { player, usedItemId, usedWithItemId } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_WOLF_HINT || stage >= STAGE_POULTICE) return;
    if (held(player, MAKESHIFT_POULTICE_ITEM_ID)) return;
    const pair = new Set([usedItemId, usedWithItemId]);
    const ingredients = [SMOOTH_LEAF_ITEM_ID, STICKY_LEAF_ITEM_ID, JERBOA_TAIL_ITEM_ID];
    if (ingredients.filter((itemId) => pair.has(itemId)).length < 2) return;
    event.handled = true;
    if (!ingredients.every((itemId) => held(player, itemId))) {
      player.sendMessage(
        "You need leaves from two different plants along with an embertailed jerboa tail " +
          "to make the poultice Fox asked for."
      );
      return;
    }
    for (const itemId of ingredients) player.getInventory().deleteNumber(itemId, 1);
    player.getInventory().adds(MAKESHIFT_POULTICE_ITEM_ID, 1);
    player.sendMessage("You craft a makeshift poultice. It looks like it should just about do the job.");
  }

  function handleItemOnNpc(event) {
    const { player, itemId } = event;
    const npcId = event.npcId ?? event.target?.getId?.();
    const stage = quest.getStage(player);
    if (npcId === FOX_NPC_ID) {
      if (itemId === MAKESHIFT_POULTICE_ITEM_ID && stage === STAGE_FOX_FOUND) {
        event.handled = true;
        startTranscript(api, player, FOX_NPC_ID, PAGE, "fox-tracking-talking-to-fox-with-the-makeshift-poultice");
        return;
      }
      if (itemId === TRIMMED_FUR_ITEM_ID && stage === STAGE_EQUIPMENT) {
        event.handled = true;
        startTranscript(api, player, FOX_NPC_ID, PAGE, "fox-tracking-talking-to-fox");
      }
      return;
    }
    if (npcId === ATZA_NPC_ID && itemId === FUR_SAMPLE_ITEM_ID && stage === STAGE_POULTICE) {
      event.handled = true;
      playAtza(player, "fox-tracking-talking-to-atza");
      return;
    }
    if (npcId === VERITY_NPC_ID && itemId === FOXS_REPORT_ITEM_ID && held(player, FOXS_REPORT_ITEM_ID)) {
      event.handled = true;
      startTranscript(api, player, VERITY_NPC_ID, PAGE, "finishing-up-talking-to-verity");
      return;
    }
    if (npcId === KIKO_NPC_ID) {
      if (itemId === TOY_MOUSE_ITEM_ID) {
        event.handled = true;
        startTranscript(api, player, KIKO_NPC_ID, PAGE, "a-missing-fox-using-an-unwound-toy-mouse-on-kiko");
      } else if (itemId === WOUND_TOY_MOUSE_ITEM_ID) {
        event.handled = true;
        startTranscript(
          api,
          player,
          KIKO_NPC_ID,
          PAGE,
          "a-missing-fox-using-a-wound-toy-mouse-on-kiko-or-the-cat-bed"
        );
      }
    }
  }

  function handleWindToyMouse(event) {
    if (event.itemId !== TOY_MOUSE_ITEM_ID) return;
    event.handled = true;
    event.player.getInventory().deleteNumber(TOY_MOUSE_ITEM_ID, 1);
    event.player.getInventory().adds(WOUND_TOY_MOUSE_ITEM_ID, 1);
  }

  function handleReadReport(event) {
    if (event.itemId !== FOXS_REPORT_ITEM_ID) return;
    event.handled = true;
    startTranscript(api, event.player, FOX_NPC_ID, PAGE, "fox-tracking-reading-fox-s-report");
  }

  // ==========================================================================
  // Spawns, login/logout and journal
  // ==========================================================================

  function spawnTracked(player, key, definition) {
    const tracked = spawnedNpcs.get(player) ?? new Map();
    spawnedNpcs.set(player, tracked);
    const existing = tracked.get(key);
    if (existing) return existing;
    const npc = api.spawnNpc({ ...definition, owner: player, ownerOnly: true });
    if (npc) tracked.set(key, npc);
    return npc;
  }

  function removeTracked(player, key) {
    const tracked = spawnedNpcs.get(player);
    const npc = tracked?.get(key);
    if (npc) {
      api.removeNpc(npc);
      tracked.delete(key);
    }
  }

  function ensureQuestNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    spawnTracked(player, "apatura", APATURA_SPAWN);
    spawnTracked(player, "kiko", KIKO_SPAWN);
    spawnTracked(player, "atza", ATZA_SPAWN);
    const stage = quest.getStage(player);
    if (stage >= STAGE_WOLF_HINT && stage < STAGE_COMPLETE) {
      spawnTracked(player, "fox", FOX_SPAWN);
    } else {
      removeTracked(player, "fox");
    }
  }

  function handleLogin({ player }) {
    ensureQuestNpcs(player);
    syncHousetrapped(player);
    refreshQuestList(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    const tracked = spawnedNpcs.get(player);
    if (!tracked) return;
    for (const npc of tracked.values()) api.removeNpc(npc);
    spawnedNpcs.delete(player);
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Guildmaster Apatura asked me to help Guild Scribe Verity,</str>",
        "<str>who was worried about the missing Guild Hunter Fox.</str>",
        "<str>I found Fox, delivered his report and repaired Kiko's bed.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_REPORT_DELIVERED) {
      const lines = ["I delivered Fox's report to Guild Scribe Verity."];
      if (hasFlag(player, BIT_BED_REPAIRED)) {
        lines.push("I repaired Kiko's bed with the trimmed fur.");
        lines.push("");
        lines.push("I should speak to <col=800000>Guildmaster Apatura</col>.");
      } else {
        lines.push("");
        lines.push("I should use the trimmed fur along with a jerboa tail to");
        lines.push("repair <col=800000>Kiko's bed</col>, then speak to Apatura.");
      }
      return lines;
    }
    if (stage >= STAGE_REPORT) {
      return [
        "Fox gave me a report to take back to the guild.",
        "",
        "I should deliver it to <col=800000>Guild Scribe Verity</col> in the",
        "Burrow, then repair Kiko's bed with the trimmed fur and a tail.",
      ];
    }
    if (stage >= STAGE_EQUIPMENT) {
      return [
        "I set up Atza's equipment and she gave me the trimmed fur.",
        "",
        "I should take it back to <col=800000>Fox</col> in the savannah.",
      ];
    }
    if (stage >= STAGE_SAMPLE_GIVEN) {
      return [
        "I gave Atza the fur sample. She asked me to set up the",
        "<col=800000>pile of equipment</col> on her floor first.",
      ];
    }
    if (stage >= STAGE_POULTICE) {
      if (held(player, FUR_SAMPLE_ITEM_ID)) {
        return [
          "I gave Fox the poultice and he gave me a fur sample.",
          "",
          "I should take it to <col=800000>Atza</col> near the south western",
          "gate of Civitas illa Fortis.",
        ];
      }
      return [
        "I gave Fox the poultice but still need his sample of the",
        "fur from <col=800000>Kiko's bed</col>.",
      ];
    }
    if (stage >= STAGE_FOX_FOUND) {
      return held(player, MAKESHIFT_POULTICE_ITEM_ID)
        ? [
            "I found <col=800000>Fox</col> injured in the savannah.",
            "",
            "I should give him the makeshift poultice.",
          ]
        : [
            "I found <col=800000>Fox</col> injured in the savannah.",
            "",
            "He needs a poultice of two kinds of leaves tied together",
            "with an embertailed jerboa tail.",
          ];
    }
    if (stage >= STAGE_WOLF_HINT) {
      return [
        "Wolf thinks Fox stopped to hunt <col=800000>pyre foxes</col> on his way",
        "to the Locus Oasis. I should look for him in the savannah",
        "and pick the leaves he needs for a poultice.",
      ];
    }
    if (stage >= STAGE_BED_CHECKED) {
      return [
        "I distracted <col=800000>Kiko</col> and checked his bed.",
        "",
        "Some of the fur was deliberately cut off. I should tell",
        "<col=800000>Wolf</col> about it.",
      ];
    }
    if (stage >= STAGE_WOLF) {
      return [
        "Wolf explained Fox was repairing <col=800000>Kiko's bed</col>.",
        "",
        "I should wind up the <col=800000>toy mouse</col> and distract Kiko",
        "so I can check the bed.",
      ];
    }
    if (stage >= STAGE_VERITY) {
      return [
        "Guild Scribe Verity is worried about Guild Hunter Fox.",
        "",
        "She suggested I speak to <col=800000>Guild Hunter Wolf</col>.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "Guildmaster Apatura asked me to help Guild Scribe Verity",
        "in <col=800000>The Burrow</col> below the Hunter Guild.",
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Guildmaster",
      "Apatura</col> in the <col=800000>Hunter Guild</col>.",
      "",
      "I need level 46 Hunter, 30 Herblore and 27 Construction, and",
      "the Children of the Sun and Eagles' Peak quests.",
    ];
  }

  function grantReward(player) {
    const skills = player.getSkillManager();
    skills.addExperiences(Skill.HUNTER, 4500);
    skills.addExperiences(Skill.CONSTRUCTION, 800);
    skills.addExperiences(Skill.HERBLORE, 500);
  }

  api.persistAttribute(FLAGS_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "at_first_light",
    name: "At First Light",
    varpId: VARP_AT_FIRST_LIGHT,
    varbitId: STAGE_VARBIT,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: Skill.HUNTER.getIndex(), amount: 4500, label: "Hunter" },
      { skillId: Skill.CONSTRUCTION.getIndex(), amount: 800, label: "Construction" },
      { skillId: Skill.HERBLORE.getIndex(), amount: 500, label: "Herblore" },
    ],
    otherRewards: ["Access to Master Tier Hunters' Rumours"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:condition", handleConditionChosen);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onNpcInteraction(ATZA_NPC_NAME, { "Talk-to": handleAtzaTalk });
  api.onNpcInteraction(KIKO_NPC_NAME, { Pet: handlePetKiko });
  api.onNpcInteraction(VERITY_NPC_NAME, { "Talk-to": handleVerityTalk });
  api.onNpcInteraction(WOLF_NPC_NAME, { "Talk-to": handleWolfTalk });
  api.onObjectInteraction(handleObjectInteraction);
  api.onItemOnObject(handleItemOnObject);
  api.onItemOnItem(handleItemOnItem);
  api.onItemOnNpc(handleItemOnNpc);
  api.onItemAction("Toy mouse", { Wind: handleWindToyMouse });
  api.onItemAction("Fox's report", { Read: handleReadReport });
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
