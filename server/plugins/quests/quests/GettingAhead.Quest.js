/**
 * Getting Ahead (members).
 *
 * The words come from the "Getting Ahead" transcript page, plus the completed
 * variants of the "Gordon" and "Mary (Getting Ahead)" pages (post-quest talk
 * and the 3,000-coin reclaim). This plugin supplies the variant selector for
 * Gordon/Mary/the Sergeant, the start hook, the prose-condition answers, the
 * gate flouring, the beast kill, the fake-head crafting/shows, the mounting
 * and the reward.
 *
 * Stage var: varbit 693 ("ga", varp 2851 "ga_main", bits 0-5). The quest DB
 * row "quest_gettingahead" resolves to get_varbit 693 in cache script 4024
 * (case 61); its "endstate" is 34. The gate leaves (40427/40428), the flour
 * trail (40429) and the mounted-head map loc (20858) are multi-locs on varbit
 * 693, so the even stage values below also drive their appearance: flour on
 * the gate at 8-12, flour trail at 10-12, Mounted Head Space at 30 and the
 * mounted head at 29/31+.
 *
 * Stages: 2 started, 4 Mary's flour idea, 8 flour on the gate, 10 came back
 * next day (trail), 14 beast killed, 16 Gordon refused, 18 Mary's clay idea,
 * 20 clay head made, 22 clay head shown, 24 fur head made, 26 fur head shown,
 * 28 bloody head made, 30 bloody head shown (mount it), 32 mounted (tell
 * Gordon), 34 complete.
 *
 * The Headless Beast (10506) has no static spawn, so the plugin spawns one in
 * the lair on login; the death task respawns it from its definition. The lair
 * cave (20852/20853), the skeleton (20855) and the quest scenery the walkthrough
 * depends on (flour barrel 40367, shelves 40362, workbench 40364, pickaxe rocks
 * 40365) are handled here.
 *
 * Source: OSRS Wiki (Getting Ahead, its Quick guide and Transcript), with the
 * even stage values from the cache's own loc transforms plus RuneLite
 * QuestHelper's state map. Rewards per the wiki: 1 Quest point, 3,000 coins
 * (reclaimable from Gordon if the inventory was full), 4,000 Crafting XP,
 * 3,200 Construction XP and tannery access.
 *
 * Gaps: using a fake head on Gordon plays the Talk-to variant (it carries the
 * same "You show ..." message but also Gordon's greeting); Mary's tanning
 * open_interface action has no interface in this server, so only its words
 * play; the Level-45 combat recommendation is not checked; the barrel empties
 * into an empty pot, keeping it (OSRS may consume the pot); mined clay has no
 * bucket-of-water softening handler in the server, so bring soft clay or add
 * the generic item combination.
 */
module.exports = function registerGettingAheadQuest(api) {
  const {
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    Skill,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const PAGE = "Getting Ahead";
  const GORDON_PAGE = "Gordon";
  const MARY_PAGE = "Mary (Getting Ahead)";
  const START_HOOK = "quest:getting-ahead:start";

  const GORDON_NPC_ID = NpcIdentifiers.GORDON; // 10500
  const GORDON_NPC_IDS = new Set([NpcIdentifiers.GORDON, NpcIdentifiers.GORDON_2]);
  const MARY_NPC_IDS = new Set([
    NpcIdentifiers.MARY_2, // 10502, the spawned transform of 8597
    NpcIdentifiers.MARY_3,
    NpcIdentifiers.MARY_4,
  ]);
  const SERGEANT_NPC_IDS = new Set([
    NpcIdentifiers.SERGEANT_3, // 8600
    NpcIdentifiers.SERGEANT_4, // 10505
    NpcIdentifiers.SERGEANT_5, // 10725
  ]);
  const HEADLESS_BEAST_NPC_ID = NpcIdentifiers.HEADLESS_BEAST_2; // 10506, ga_beast

  const VARP_GETTING_AHEAD = 2851; // ga_main
  const VARBIT_GETTING_AHEAD = 693; // ga, bits 0-5

  const STAGE_STARTED = 2;
  const STAGE_MARY_TALK = 4;
  const STAGE_FLOUR_POURED = 8;
  const STAGE_FLOUR_TRAIL = 10;
  const STAGE_BEAST_KILLED = 14;
  const STAGE_GORDON_REFUSED = 16;
  const STAGE_MARY_FAKE = 18;
  const STAGE_CLAY_MADE = 20;
  const STAGE_CLAY_SHOWN = 22;
  const STAGE_FUR_MADE = 24;
  const STAGE_FUR_SHOWN = 26;
  const STAGE_BLOODY_MADE = 28;
  const STAGE_BLOODY_SHOWN = 30;
  const STAGE_MOUNTED = 32;
  const STAGE_COMPLETE = 34;

  const CRAFTING_LEVEL = 30;
  const CONSTRUCTION_LEVEL = 26;
  const CRAFTING_XP = 4000;
  const CONSTRUCTION_XP = 3200;
  const COINS_REWARD = 3000;

  const COINS_ITEM_ID = ItemIdentifiers.COINS; // 995
  const POT_OF_FLOUR_ITEM_ID = ItemIdentifiers.POT_OF_FLOUR; // 1933
  const POT_ITEM_ID = ItemIdentifiers.POT; // 1931
  const KNIFE_ITEM_ID = ItemIdentifiers.KNIFE; // 946
  const SOFT_CLAY_ITEM_ID = ItemIdentifiers.SOFT_CLAY; // 1761
  const RED_DYE_ITEM_ID = ItemIdentifiers.RED_DYE; // 1763
  const CLAY_HEAD_ITEM_ID = ItemIdentifiers.CLAY_HEAD; // 25145
  const FUR_HEAD_ITEM_ID = ItemIdentifiers.FUR_HEAD; // 25146
  const BLOODY_HEAD_ITEM_ID = ItemIdentifiers.BLOODY_HEAD; // 25147
  const NEILANS_JOURNAL_ITEM_ID = ItemIdentifiers.NEILANS_JOURNAL; // 25152
  const PLANK_ITEM_ID = ItemIdentifiers.PLANK; // 960
  const NEEDLE_ITEM_ID = ItemIdentifiers.NEEDLE; // 1733
  const THREAD_ITEM_ID = ItemIdentifiers.THREAD; // 1734

  const FUR_ITEM_IDS = [
    ItemIdentifiers.BEAR_FUR, // 948
    ItemIdentifiers.GREY_WOLF_FUR, // 958
    ItemIdentifiers.FUR, // 6814
  ];
  const BLOOD_ITEM_IDS = [ItemIdentifiers.VIAL_OF_BLOOD, ItemIdentifiers.BLOOD_PINT];
  const HAMMER_ITEM_IDS = [ItemIdentifiers.HAMMER, ItemIdentifiers.IMCANDO_HAMMER];
  const SAW_ITEM_IDS = [
    ItemIdentifiers.SAW,
    ItemIdentifiers.SAW_2,
    ItemIdentifiers.SAW_3,
    ItemIdentifiers.CRYSTAL_SAW,
  ];
  const NAIL_ITEM_IDS = [
    ItemIdentifiers.BRONZE_NAILS, // 4819
    ItemIdentifiers.IRON_NAILS, // 4820
    ItemIdentifiers.STEEL_NAILS, // 1539
    ItemIdentifiers.BLACK_NAILS, // 4821
    ItemIdentifiers.MITHRIL_NAILS, // 4822
    ItemIdentifiers.ADAMANTITE_NAILS, // 4823
    ItemIdentifiers.RUNE_NAILS, // 4824
  ];

  // ga_fencegate_l/r, the two leaves of the cattle gate (no generated constant).
  const FENCE_GATE_OBJECT_IDS = new Set([40427, 40428]);
  // ga_mounted_head, the map loc that transforms into the Mounted Head Space.
  const MOUNTED_HEAD_OBJECT_ID = 20858;

  const CAVE_ENTER_TILE = { x: 1211, y: 3646 };
  const CAVE_EXIT_TILE = { x: 1189, y: 10029 };
  const CAVE_INSIDE_TILE = { x: 1190, y: 10028, z: 0 };
  const CAVE_OUTSIDE_TILE = { x: 1212, y: 3648, z: 0 };
  const BEAST_TILE = { x: 1191, y: 10021, z: 0 };

  // Condition step ids on the "Getting Ahead" and "Gordon" pages.
  const REQUIREMENTS_MISSING_CONDITION_ID = "F1Rypv";
  const REQUIREMENTS_MET_CONDITION_ID = "-vnUdk";
  const COINS_RECEIVED_CONDITION_ID = "Ve-vo0";
  const COINS_MISSING_CONDITION_ID = "ybriIj";
  // Action/message step ids that move the stage.
  const COMPLETE_MESSAGE_ID = "ORkcay";
  const RECLAIM_COINS_ACTION_ID = "eJJth4";

  const STAGE_BY_STEP_ID = new Map([
    ["pL8hVR", STAGE_FLOUR_POURED], // You pour some flour over the gate.
    ["7aXCpS", STAGE_FLOUR_TRAIL], // You head off for the night and come back the next day.
    ["wT3s4c", STAGE_CLAY_MADE], // You sculpt the clay into the shape of a head.
    ["jl91sv", STAGE_CLAY_SHOWN], // You show the clay head to Gordon.
    ["w0k-Ii", STAGE_CLAY_SHOWN],
    ["9iNdir", STAGE_FUR_MADE], // You attach the fur to the clay head.
    ["o0A-RH", STAGE_FUR_SHOWN], // You show the fur head to Gordon.
    ["OPtAA-", STAGE_FUR_SHOWN],
    ["_RfAUL", STAGE_BLOODY_MADE], // You dye the fur head red.
    ["ILAeKi", STAGE_BLOODY_SHOWN], // You show the bloody head to Gordon.
    ["fvoksk", STAGE_BLOODY_SHOWN],
  ]);

  const SHOW_VARIANTS = new Map([
    [CLAY_HEAD_ITEM_ID, "a-strange-fake-talking-to-gordon-after-making-the-clay-head"],
    [FUR_HEAD_ITEM_ID, "a-strange-fake-talking-to-gordon-after-making-the-fur-head"],
    [BLOODY_HEAD_ITEM_ID, "a-strange-fake-talking-to-gordon-after-making-the-bloody-head"],
    [NEILANS_JOURNAL_ITEM_ID, "a-strange-beast-using-items-on-gordon-neilan-s-journal"],
    [ItemIdentifiers.NEILANS_JOURNAL_2, "a-strange-beast-using-items-on-gordon-neilan-s-journal"],
    [ItemIdentifiers.BIG_BONES, "a-strange-beast-using-items-on-gordon-big-bones"],
    [ItemIdentifiers.BIG_BONES_2, "a-strange-beast-using-items-on-gordon-big-bones"],
    [ItemIdentifiers.ENSOULED_BEAR_HEAD, "a-strange-beast-using-items-on-gordon-ensouled-bear-head"],
    [ItemIdentifiers.ENSOULED_BEAR_HEAD_2, "a-strange-beast-using-items-on-gordon-ensouled-bear-head"],
    [ItemIdentifiers.ENSOULED_BEAR_HEAD_3, "a-strange-beast-using-items-on-gordon-ensouled-bear-head"],
    [ItemIdentifiers.ENSOULED_BEAR_HEAD_4, "a-strange-beast-using-items-on-gordon-ensouled-bear-head"],
    [ItemIdentifiers.BEARHEAD, "a-strange-beast-using-items-on-gordon-bearhead"],
    [ItemIdentifiers.BEARHEAD_2, "a-strange-beast-using-items-on-gordon-bearhead"],
  ]);
  const HEAD_SHOW_WINDOW = new Map([
    [CLAY_HEAD_ITEM_ID, [STAGE_CLAY_MADE, STAGE_CLAY_SHOWN]],
    [FUR_HEAD_ITEM_ID, [STAGE_FUR_MADE, STAGE_FUR_SHOWN]],
    [BLOODY_HEAD_ITEM_ID, [STAGE_BLOODY_MADE, STAGE_BLOODY_SHOWN]],
  ]);

  const MET_GORDON_ATTRIBUTE = "quest.getting_ahead.met-gordon";
  const COINS_PENDING_ATTRIBUTE = "quest.getting_ahead.coins-pending";
  const PICKAXE_TAKEN_ATTRIBUTE = "quest.getting_ahead.pickaxe-taken";

  const pageVariant = (variant) => ({ page: PAGE, variant });

  let quest;

  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    return (
      skills.getMaxLevel(Skill.CRAFTING) >= CRAFTING_LEVEL &&
      skills.getMaxLevel(Skill.CONSTRUCTION) >= CONSTRUCTION_LEVEL
    );
  }

  function coinsPending(player) {
    return Number(player.getAttribute(COINS_PENDING_ATTRIBUTE)) === 1;
  }

  /** Monotonic stage advance; never moves a quest-complete player back. */
  function advanceTo(player, stage) {
    const current = quest.getStage(player);
    if (current < stage && current >= STAGE_STARTED && current < STAGE_COMPLETE) {
      quest.setStage(player, stage);
    }
  }

  const held = (player, itemId, amount = 1) =>
    player.getInventory().getAmount(itemId) >= amount;

  function hasTool(player, itemIds) {
    return itemIds.some((itemId) => held(player, itemId));
  }

  function nailCount(player) {
    const inventory = player.getInventory();
    return NAIL_ITEM_IDS.reduce((sum, itemId) => sum + inventory.getAmount(itemId), 0);
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Gordon asked me to kill the beast that was stealing his livestock.</str>",
        "<str>I killed the headless beast, then fooled Gordon with a fake head</str>",
        "<str>and mounted it in his house.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_STARTED) {
      const lines = [
        "Gordon asked me to kill the beast that has been stealing his livestock and bring him its head.",
      ];
      if (stage < STAGE_MARY_TALK) lines.push("", "I should ask his wife <col=800000>Mary</col> if she has seen anything.");
      else if (stage < STAGE_FLOUR_POURED) lines.push("", "Mary suggested pouring <col=800000>flour</col> over the cattle gate to track the beast.");
      else if (stage < STAGE_BEAST_KILLED) lines.push("", "I covered the gate in flour and followed the trail to the <col=800000>Headless Beast's lair</col>.");
      else if (stage < STAGE_GORDON_REFUSED) lines.push("", "I killed the headless beast. I should tell <col=800000>Gordon</col>.");
      else if (stage < STAGE_MARY_FAKE) lines.push("", "Gordon won't pay without a head. I should talk to <col=800000>Mary</col> again.");
      else if (stage < STAGE_CLAY_MADE) lines.push("", "Mary suggested making a fake head from <col=800000>soft clay</col> with a knife.");
      else if (stage < STAGE_CLAY_SHOWN) lines.push("", "I should show my clay head to <col=800000>Gordon</col>.");
      else if (stage < STAGE_FUR_MADE) lines.push("", "Gordon wasn't fooled. He said it needs fur.");
      else if (stage < STAGE_FUR_SHOWN) lines.push("", "I should show my fur head to <col=800000>Gordon</col>.");
      else if (stage < STAGE_BLOODY_MADE) lines.push("", "Gordon said the head needs blood on it.");
      else if (stage < STAGE_BLOODY_SHOWN) lines.push("", "I should show my bloody head to <col=800000>Gordon</col>.");
      else if (stage < STAGE_MOUNTED) lines.push("", "Gordon wants the head mounted in his house.");
      else lines.push("", "I should tell <col=800000>Gordon</col> the head is mounted.");
      return lines;
    }
    return [
      "I can start this quest by speaking to <col=800000>Gordon</col> on his farm",
      "south of the <col=800000>Farming Guild</col>.",
      "",
      "I need level 30 Crafting and level 26 Construction to start.",
    ];
  }

  function grantRewards(player) {
    const skills = player.getSkillManager();
    skills.addExperiences(Skill.CRAFTING, CRAFTING_XP);
    skills.addExperiences(Skill.CONSTRUCTION, CONSTRUCTION_XP);
    const inventory = player.getInventory();
    if (inventory.getFreeSlots() === 0 && inventory.getAmount(COINS_ITEM_ID) === 0) {
      player.setAttribute(COINS_PENDING_ATTRIBUTE, 1);
      return;
    }
    // registerQuest adds the rewardItemId (one coin) after this; top the stack up.
    inventory.adds(COINS_ITEM_ID, COINS_REWARD - 1);
    player.setAttribute(COINS_PENDING_ATTRIBUTE, 0);
  }

  function reclaimCoins(player) {
    if (!coinsPending(player)) return;
    const inventory = player.getInventory();
    if (inventory.getFreeSlots() === 0 && inventory.getAmount(COINS_ITEM_ID) === 0) {
      player.sendMessage("You need a free inventory slot to take the coins.");
      return;
    }
    inventory.adds(COINS_ITEM_ID, COINS_REWARD);
    player.setAttribute(COINS_PENDING_ATTRIBUTE, 0);
  }

  function selectGordonVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return { page: GORDON_PAGE, variant: "standard-dialogue-after-completing-getting-ahead" };
    }
    if (stage >= STAGE_MOUNTED) return pageVariant("a-strange-fake-talking-to-gordon-after-mounting-the-bloody-head");
    if (stage >= STAGE_BLOODY_SHOWN) {
      return pageVariant(
        "a-strange-fake-talking-to-gordon-after-making-the-bloody-head-talking-to-gordon-again-after-making-the-bloody-head"
      );
    }
    if (stage >= STAGE_BLOODY_MADE) return pageVariant("a-strange-fake-talking-to-gordon-after-making-the-bloody-head");
    if (stage >= STAGE_FUR_SHOWN) {
      return pageVariant(
        "a-strange-fake-talking-to-gordon-after-making-the-fur-head-talking-to-gordon-again-after-making-the-fur-head"
      );
    }
    if (stage >= STAGE_FUR_MADE) return pageVariant("a-strange-fake-talking-to-gordon-after-making-the-fur-head");
    if (stage >= STAGE_CLAY_SHOWN) {
      return pageVariant(
        "a-strange-fake-talking-to-gordon-after-making-the-clay-head-talking-to-gordon-again-after-making-the-clay-head"
      );
    }
    if (stage >= STAGE_CLAY_MADE) return pageVariant("a-strange-fake-talking-to-gordon-after-making-the-clay-head");
    if (stage >= STAGE_GORDON_REFUSED) {
      return pageVariant(
        "a-strange-beast-talking-to-gordon-after-killing-the-headless-beast-talking-to-gordon-again-after-killing-the-headless-beast"
      );
    }
    if (stage >= STAGE_BEAST_KILLED) {
      // No action step marks the refusal scene; the talk itself moves it on.
      advanceTo(player, STAGE_GORDON_REFUSED);
      return pageVariant("a-strange-beast-talking-to-gordon-after-killing-the-headless-beast");
    }
    if (stage >= STAGE_FLOUR_POURED) return pageVariant("a-strange-beast-talking-to-gordon-after-pouring-the-flour");
    if (stage >= STAGE_MARY_TALK) return pageVariant("a-strange-event-talking-to-gordon-after-talking-to-mary");
    if (stage >= STAGE_STARTED) {
      return pageVariant("a-strange-event-talking-to-gordon-talking-to-gordon-again-after-starting-the-quest");
    }
    if (Number(player.getAttribute(MET_GORDON_ATTRIBUTE)) === 1) {
      return pageVariant("a-strange-event-talking-to-gordon-talking-to-gordon-again-before-starting-the-quest");
    }
    player.setAttribute(MET_GORDON_ATTRIBUTE, 1);
    return pageVariant("a-strange-event-talking-to-gordon");
  }

  function selectMaryVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED) return null;
    if (stage >= STAGE_COMPLETE) {
      return { page: MARY_PAGE, variant: "standard-dialogue-after-completing-getting-ahead" };
    }
    if (stage >= STAGE_MOUNTED) return pageVariant("a-strange-fake-talking-to-mary-after-mounting-the-bloody-head");
    if (stage >= STAGE_BLOODY_SHOWN) {
      return pageVariant("a-strange-fake-talking-to-mary-after-showing-gordon-the-bloody-head");
    }
    if (stage >= STAGE_BLOODY_MADE) return pageVariant("a-strange-fake-talking-to-mary-after-making-the-bloody-head");
    if (stage >= STAGE_FUR_SHOWN) {
      return pageVariant("a-strange-fake-talking-to-mary-after-showing-gordon-the-fur-head");
    }
    if (stage >= STAGE_FUR_MADE) return pageVariant("a-strange-fake-talking-to-mary-after-making-the-fur-head");
    if (stage >= STAGE_CLAY_SHOWN) {
      return pageVariant("a-strange-fake-talking-to-mary-after-showing-gordon-the-clay-head");
    }
    if (stage >= STAGE_CLAY_MADE) return pageVariant("a-strange-fake-talking-to-mary-after-making-the-clay-head");
    if (stage >= STAGE_MARY_FAKE) {
      return pageVariant(
        "a-strange-fake-talking-to-mary-after-killing-the-beast-talking-to-mary-again-after-killing-the-beast"
      );
    }
    if (stage >= STAGE_GORDON_REFUSED) {
      // No action step marks the fake-head idea; the talk itself moves it on.
      advanceTo(player, STAGE_MARY_FAKE);
      return pageVariant("a-strange-fake-talking-to-mary-after-killing-the-beast");
    }
    if (stage >= STAGE_BEAST_KILLED) {
      return pageVariant("a-strange-beast-talking-to-mary-after-killing-the-beast-but-before-talking-to-gordon");
    }
    if (stage >= STAGE_FLOUR_POURED) return pageVariant("a-strange-beast-talking-to-mary-after-pouring-the-flour");
    if (stage >= STAGE_MARY_TALK) return pageVariant("a-strange-event-talking-to-mary-talking-to-mary-again");
    advanceTo(player, STAGE_MARY_TALK);
    return pageVariant("a-strange-event-talking-to-mary");
  }

  function selectSergeantVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_COMPLETE) return null;
    return pageVariant("a-strange-event-talking-to-the-sergeant");
  }

  function selectVariant({ npcId, player }) {
    if (GORDON_NPC_IDS.has(npcId)) return selectGordonVariant(player);
    if (MARY_NPC_IDS.has(npcId)) return selectMaryVariant(player);
    if (SERGEANT_NPC_IDS.has(npcId)) return selectSergeantVariant(player);
    return null;
  }

  function answerCondition({ npcId, player, stepId }) {
    if (!GORDON_NPC_IDS.has(npcId)) return null;
    if (stepId === REQUIREMENTS_MISSING_CONDITION_ID) return !meetsRequirements(player);
    if (stepId === REQUIREMENTS_MET_CONDITION_ID) return meetsRequirements(player);
    if (stepId === COINS_RECEIVED_CONDITION_ID) return !coinsPending(player);
    if (stepId === COINS_MISSING_CONDITION_ID) return coinsPending(player);
    return null;
  }

  function handleStartHook({ player, npcId, hook }) {
    if (!GORDON_NPC_IDS.has(npcId) || hook !== START_HOOK) return;
    if (quest.getStage(player) !== 0 || !meetsRequirements(player)) return;
    quest.setStage(player, STAGE_STARTED);
  }

  function handleDialogueAction(event) {
    const { player, stepId } = event;
    if (stepId === COMPLETE_MESSAGE_ID) {
      event.handled = true;
      if (quest.getStage(player) >= STAGE_MOUNTED) quest.complete(player);
      return;
    }
    if (stepId === RECLAIM_COINS_ACTION_ID) {
      event.handled = true;
      reclaimCoins(player);
      return;
    }
    const stage = STAGE_BY_STEP_ID.get(stepId);
    if (stage === undefined) return;
    event.handled = true;
    advanceTo(player, stage);
  }

  /** Pot of flour on a cattle-gate leaf; the transcript sets the flour stage. */
  function handleItemOnObject(event) {
    const { player, itemId, objectId } = event;
    if (itemId !== POT_OF_FLOUR_ITEM_ID || !FENCE_GATE_OBJECT_IDS.has(objectId)) return;
    const stage = quest.getStage(player);
    if (stage < STAGE_MARY_TALK || stage >= STAGE_BEAST_KILLED) return;
    event.handled = true;
    if (stage >= STAGE_FLOUR_POURED) return;
    const inventory = player.getInventory();
    inventory.deleteNumber(POT_OF_FLOUR_ITEM_ID, 1);
    inventory.adds(POT_ITEM_ID, 1);
    startTranscript(api, player, GORDON_NPC_ID, PAGE, "a-strange-event-pouring-the-flour-on-the-gate");
  }

  function deleteOneOf(inventory, itemIds) {
    for (const itemId of itemIds) {
      if (inventory.getAmount(itemId) > 0) {
        inventory.deleteNumber(itemId, 1);
        return;
      }
    }
  }

  function makeClayHead(player, inventory) {
    inventory.deleteNumber(SOFT_CLAY_ITEM_ID, 1);
    inventory.adds(CLAY_HEAD_ITEM_ID, 1);
    startTranscript(api, player, GORDON_NPC_ID, PAGE, "a-strange-fake-making-the-clay-head");
  }

  function makeFurHead(player, inventory) {
    if (!held(player, NEEDLE_ITEM_ID) || !held(player, THREAD_ITEM_ID)) {
      player.sendMessage("You need a needle and some thread to attach the fur.");
      return;
    }
    inventory.deleteNumber(CLAY_HEAD_ITEM_ID, 1);
    deleteOneOf(inventory, FUR_ITEM_IDS);
    inventory.deleteNumber(THREAD_ITEM_ID, 1);
    inventory.adds(FUR_HEAD_ITEM_ID, 1);
    startTranscript(api, player, GORDON_NPC_ID, PAGE, "a-strange-fake-making-the-fur-head");
  }

  function makeBloodyHead(player, inventory) {
    inventory.deleteNumber(FUR_HEAD_ITEM_ID, 1);
    inventory.deleteNumber(RED_DYE_ITEM_ID, 1);
    inventory.adds(BLOODY_HEAD_ITEM_ID, 1);
    startTranscript(api, player, GORDON_NPC_ID, PAGE, "a-strange-fake-making-the-bloody-head");
  }

  function handleItemOnItem(event) {
    const { player, usedItemId, usedWithItemId } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_COMPLETE) return;
    const ids = new Set([usedItemId, usedWithItemId]);
    const inventory = player.getInventory();

    if (ids.has(KNIFE_ITEM_ID) && ids.has(SOFT_CLAY_ITEM_ID)) {
      event.handled = true;
      if (stage < STAGE_MARY_FAKE || stage >= STAGE_CLAY_SHOWN) return;
      makeClayHead(player, inventory);
      return;
    }
    if (ids.has(CLAY_HEAD_ITEM_ID) && FUR_ITEM_IDS.some((itemId) => ids.has(itemId))) {
      event.handled = true;
      if (stage < STAGE_CLAY_SHOWN || stage >= STAGE_FUR_SHOWN) return;
      makeFurHead(player, inventory);
      return;
    }
    if (ids.has(FUR_HEAD_ITEM_ID) && ids.has(RED_DYE_ITEM_ID)) {
      event.handled = true;
      if (stage < STAGE_FUR_SHOWN || stage >= STAGE_BLOODY_SHOWN) return;
      makeBloodyHead(player, inventory);
      return;
    }
    if (ids.has(FUR_HEAD_ITEM_ID) && BLOOD_ITEM_IDS.some((itemId) => ids.has(itemId))) {
      event.handled = true;
      if (stage < STAGE_FUR_SHOWN || stage >= STAGE_BLOODY_SHOWN) return;
      startTranscript(
        api,
        player,
        GORDON_NPC_ID,
        PAGE,
        "a-strange-fake-using-a-vial-of-blood-or-a-blood-pint-on-the-fur-head"
      );
    }
  }

  function handleItemOnNpc(event) {
    const { player, npcId, itemId } = event;
    if (!GORDON_NPC_IDS.has(npcId)) return;
    const variant = SHOW_VARIANTS.get(itemId);
    if (!variant) return;
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_COMPLETE) return;
    const window = HEAD_SHOW_WINDOW.get(itemId);
    if (window && (stage < window[0] || stage >= window[1])) return;
    event.handled = true;
    startTranscript(api, player, GORDON_NPC_ID, PAGE, variant);
  }

  function handleBeastDeath({ killer, npcId, npc }) {
    if (npcId !== HEADLESS_BEAST_NPC_ID && npc?.getId?.() !== HEADLESS_BEAST_NPC_ID) return;
    if (!killer) return;
    const stage = quest.getStage(killer);
    if (stage < STAGE_FLOUR_POURED || stage >= STAGE_BEAST_KILLED) return;
    quest.setStage(killer, STAGE_BEAST_KILLED);
    startTranscript(api, killer, HEADLESS_BEAST_NPC_ID, PAGE, "a-strange-beast-upon-killing-the-headless-beast");
  }

  function ensureHeadlessBeast() {
    const world = api.getWorld();
    if (!world?.getNpcs) return;
    for (const npc of world.getNpcs()) {
      if (npc?.getId?.() === HEADLESS_BEAST_NPC_ID) return;
    }
    api.spawnNpc({
      id: HEADLESS_BEAST_NPC_ID,
      x: BEAST_TILE.x,
      y: BEAST_TILE.y,
      z: BEAST_TILE.z,
      wanderRadius: 2,
    });
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
    ensureHeadlessBeast();
  }

  function handleCaveClick(event) {
    const { player, objectId, location } = event;
    if (
      objectId === ObjectIdentifiers.CAVE_55 &&
      location?.x === CAVE_ENTER_TILE.x &&
      location?.y === CAVE_ENTER_TILE.y
    ) {
      event.handled = true;
      player.moveTo(new Location(CAVE_INSIDE_TILE.x, CAVE_INSIDE_TILE.y, CAVE_INSIDE_TILE.z));
      return;
    }
    if (
      objectId === ObjectIdentifiers.CAVE_56 &&
      location?.x === CAVE_EXIT_TILE.x &&
      location?.y === CAVE_EXIT_TILE.y
    ) {
      event.handled = true;
      player.moveTo(new Location(CAVE_OUTSIDE_TILE.x, CAVE_OUTSIDE_TILE.y, CAVE_OUTSIDE_TILE.z));
    }
  }

  function searchSkeleton(event) {
    const { player } = event;
    event.handled = true;
    const inventory = player.getInventory();
    if (held(player, NEILANS_JOURNAL_ITEM_ID) || held(player, ItemIdentifiers.NEILANS_JOURNAL_2)) {
      player.sendMessage("You have already taken the journal.");
      return;
    }
    if (inventory.getFreeSlots() < 1) {
      player.sendMessage("You don't have enough inventory space for the journal.");
      return;
    }
    inventory.adds(NEILANS_JOURNAL_ITEM_ID, 1);
    player.sendMessage("You search the skeleton and find a journal.");
  }

  /** ga_flourbarrel upstairs: fill an empty pot with flour. */
  function takeFlourFromBarrel(event) {
    const { player } = event;
    event.handled = true;
    if (!held(player, POT_ITEM_ID)) {
      player.sendMessage("You need an empty pot to hold the flour.");
      return;
    }
    const inventory = player.getInventory();
    inventory.deleteNumber(POT_ITEM_ID, 1);
    inventory.adds(POT_OF_FLOUR_ITEM_ID, 1);
    player.sendMessage("You fill the pot with flour.");
  }

  /** ga_shelves by the stairs: some red dye for the fake head. */
  function searchShelves(event) {
    const { player } = event;
    event.handled = true;
    if (player.getInventory().getFreeSlots() < 1) {
      player.sendMessage("You don't have enough inventory space.");
      return;
    }
    player.getInventory().adds(RED_DYE_ITEM_ID, 1);
    player.sendMessage("You find some red dye on the shelves.");
  }

  /** ga_workbench in the shed north of the house: nails for the mounting. */
  function searchWorkbench(event) {
    const { player } = event;
    event.handled = true;
    const inventory = player.getInventory();
    if (inventory.getAmount(ItemIdentifiers.IRON_NAILS) >= 20) {
      player.sendMessage("You have already taken all the nails here.");
      return;
    }
    if (inventory.getFreeSlots() < 1) {
      player.sendMessage("You don't have enough inventory space.");
      return;
    }
    inventory.adds(ItemIdentifiers.IRON_NAILS, 20);
    player.sendMessage("You take some nails from the workbench.");
  }

  /** ga_rocks_pickaxe at the Kebos mine: the stuck pickaxe, one per player. */
  function takePickaxe(event) {
    const { player } = event;
    event.handled = true;
    if (Number(player.getAttribute(PICKAXE_TAKEN_ATTRIBUTE)) === 1) return;
    if (player.getInventory().getFreeSlots() < 1) {
      player.sendMessage("You don't have enough inventory space.");
      return;
    }
    player.setAttribute(PICKAXE_TAKEN_ATTRIBUTE, 1);
    player.getInventory().adds(ItemIdentifiers.BRONZE_PICKAXE, 1);
    player.sendMessage("You take the pickaxe from the rocks.");
  }

  function canMountHead(player) {
    return (
      held(player, BLOODY_HEAD_ITEM_ID) &&
      held(player, PLANK_ITEM_ID, 2) &&
      nailCount(player) >= 6 &&
      hasTool(player, HAMMER_ITEM_IDS) &&
      hasTool(player, SAW_ITEM_IDS)
    );
  }

  function consumeNails(player, count) {
    const inventory = player.getInventory();
    let remaining = count;
    for (const itemId of NAIL_ITEM_IDS) {
      if (remaining <= 0) return;
      const have = inventory.getAmount(itemId);
      if (have <= 0) continue;
      const take = Math.min(have, remaining);
      inventory.deleteNumber(itemId, take);
      remaining -= take;
    }
  }

  function buildMountedHead(event) {
    const { player } = event;
    if (event.objectId !== MOUNTED_HEAD_OBJECT_ID) return;
    event.handled = true;
    const stage = quest.getStage(player);
    if (stage < STAGE_BLOODY_SHOWN || stage >= STAGE_MOUNTED) return;
    if (!canMountHead(player)) {
      player.sendMessage("You need the bloody head, two planks, six nails, a hammer and a saw.");
      return;
    }
    const inventory = player.getInventory();
    inventory.deleteNumber(BLOODY_HEAD_ITEM_ID, 1);
    inventory.deleteNumber(PLANK_ITEM_ID, 2);
    consumeNails(player, 6);
    quest.setStage(player, STAGE_MOUNTED);
    startTranscript(api, player, GORDON_NPC_ID, PAGE, "a-strange-fake-mounting-the-bloody-head");
  }

  api.persistAttribute(MET_GORDON_ATTRIBUTE);
  api.persistAttribute(COINS_PENDING_ATTRIBUTE);
  api.persistAttribute(PICKAXE_TAKEN_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "getting_ahead",
    name: "Getting Ahead",
    varpId: VARP_GETTING_AHEAD,
    varbitId: VARBIT_GETTING_AHEAD,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: Skill.CRAFTING.getIndex(), amount: CRAFTING_XP, label: "Crafting" },
      { skillId: Skill.CONSTRUCTION.getIndex(), amount: CONSTRUCTION_XP, label: "Construction" },
    ],
    rewardItemId: COINS_ITEM_ID,
    rewardItemLabel: "3,000 Coins",
    otherRewards: ["Access to a tannery in the Kebos Lowlands"],
    buildJournal,
    onReward: grantRewards,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onItemOnItem(handleItemOnItem);
  api.onItemOnNpc(handleItemOnNpc);
  api.onObjectFirstClick([ObjectIdentifiers.CAVE_55, ObjectIdentifiers.CAVE_56], handleCaveClick);
  api.onObjectFirstClick([ObjectIdentifiers.SKELETON_77], searchSkeleton);
  api.onObjectFirstClick([ObjectIdentifiers.BARREL_OF_FLOUR_3], takeFlourFromBarrel);
  api.onObjectFirstClick([ObjectIdentifiers.SHELVES_119], searchShelves);
  api.onObjectFirstClick([ObjectIdentifiers.WORKBENCH_19], searchWorkbench);
  api.onObjectFirstClick([ObjectIdentifiers.ROCKS_96], takePickaxe);
  api.onObjectInteraction("Mounted Head Space", { Build: buildMountedHead });
  api.onNpcDeath(handleBeastDeath);
  api.onPlayerLogin(handleLogin);
};
