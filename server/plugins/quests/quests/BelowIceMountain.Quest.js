/**
 * Below Ice Mountain (free-to-play).
 *
 * The words come from the "Below Ice Mountain" transcript page; this plugin supplies
 * the variant selectors for Willow, Checkal, Atlas, Burntof, Marley and the shared
 * Blue Moon Inn cook and Charlie the Tramp, the wiki prose-condition answers, the
 * three recruitment errands (Atlas' strength training, Burntof's rock-paper-scissors,
 * Marley's steak sandwich), the entrance/ruins cutscene, the Ancient Guardian fight
 * (combat or the four structural pillars), Willow's bag hand-in and the reward.
 *
 * Stages (varbit 12063 "bim", varp 2951, bits 0-6; evidence: `lookup-gameval.ts varbit bim`
 * -> "12063 bim varp=2951 bits=0-6", siblings bim_marley 12064 / bim_checkal 12065 /
 * bim_burntof 12066 / bim_claimed_reward 12067):
 *   0 not started, 1 accepted (recruit the team), 2 all three recruited,
 *   3 cutscene done, Guardian awake, 4 Guardian defeated, 5 handed in / complete.
 * Per-member progress and side flags live in persisted quest.* attributes.
 *
 * Source: https://oldschool.runescape.wiki/w/Below_Ice_Mountain and
 * https://oldschool.runescape.wiki/w/Transcript:Below_Ice_Mountain
 * Rewards per the OSRS Wiki: 1 Quest point, 2,000 coins, access to the Ruins of
 * Camdozaal, the Flex emote and the ability to make a steak sandwich.
 *
 * Gaps / approximations:
 *   - npc-spawns.json points this quest's NPCs at ids the cache no longer has
 *     (10638-10649, 10701-10703 are nameless). The plugin spawns the real ids at the
 *     spawn-file coordinates: Willow 10655, Checkal 10657, Marley 10656 and Burntof
 *     10659; Atlas 10658, Cook 2895 and Charlie 5209 already spawn. Ramarno uses the
 *     world spawn 10702 at the big doors (its clicks resolve to 10685; the plugin
 *     accepts 10684/10685/10702 and no longer spawns a duplicate).
 *   - The map has no "Ruins Entrance"/"Blocked entry" placement, so "Ruins Entrance"
 *     (41439, op Enter) is registered at (2997,3492). Before all three recruits the
 *     Enter option answers the wiki examine line "The way is blocked.".
 *   - The crew never physically walks to the entrance; talking to them at their base
 *     spots plays their entrance/post-quest transcripts. Ramarno's departure to the
 *     workshop is cosmetic (he stays by the doors). The members-only Nardah gang is
 *     not spawned; post-quest words play at the Ice Mountain spots.
 *   - The four structural pillars (41458) are registered over the broken map pillars
 *     only while a Guardian fight is live; mining four times defeats it (no Mining
 *     xp, animation or pickaxe check). The big doors stay closed scenery.
 *   - Flex emote unlock is the wiki message only (this server's emotes are all
 *     available). The wiki's "<times done>" and RPS sign placeholders are filled
 *     from the session counter and the player's last pick.
 *   - The 16 Quest point requirement is not enforced (the transcript has no refusal
 *     lines); the quest is F2P but Quests.plugin.js does not yet list
 *     "BelowIceMountain" in F2P_QUESTS (shared change, not made here).
 */
module.exports = function registerBelowIceMountainQuest(api) {
  const {
    Animation,
    GameObject,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    ObjectManager,
    Skill,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const PAGE = "Below Ice Mountain";

  // NPCs.
  const WILLOW_NPC_ID = NpcIdentifiers.WILLOW; // 10655
  const MARLEY_NPC_ID = NpcIdentifiers.MARLEY; // 10656
  const CHECKAL_NPC_ID = NpcIdentifiers.CHECKAL; // 10657
  const ATLAS_NPC_ID = NpcIdentifiers.ATLAS; // 10658
  const BURNTOF_NPC_ID = NpcIdentifiers.BURNTOF; // 10659
  const BURNTOF_2_NPC_ID = NpcIdentifiers.BURNTOF_2; // 10660
  const RAMARNO_NPC_ID = NpcIdentifiers.RAMARNO_2; // 10684, named Ramarno chathead
  const RAMARNO_RESOLVED_NPC_ID = NpcIdentifiers.RAMARNO_3; // 10685, the world spawn's resolved click id
  const RAMARNO_WORLD_NPC_ID = 10702; // world spawn in npc-spawns.json at (2951,5779)
  const RAMARNO_WORLD_NPC_IDS = new Set([RAMARNO_WORLD_NPC_ID, RAMARNO_RESOLVED_NPC_ID]);
  const RAMARNO_NPC_IDS = new Set([RAMARNO_NPC_ID, ...RAMARNO_WORLD_NPC_IDS]);
  const ANCIENT_GUARDIAN_NPC_ID = NpcIdentifiers.ANCIENT_GUARDIAN; // 10654
  const COOK_NPC_ID = NpcIdentifiers.COOK_2; // 2895, Cook (Blue Moon Inn)
  const CHARLIE_NPC_ID = NpcIdentifiers.CHARLIE_THE_TRAMP; // 5209
  const DIALOGUE_NPC_IDS = new Set([
    WILLOW_NPC_ID,
    MARLEY_NPC_ID,
    CHECKAL_NPC_ID,
    ATLAS_NPC_ID,
    BURNTOF_NPC_ID,
    BURNTOF_2_NPC_ID,
    ...RAMARNO_NPC_IDS,
    COOK_NPC_ID,
    CHARLIE_NPC_ID,
  ]);

  // Items.
  const KNIFE_ITEM_ID = ItemIdentifiers.KNIFE; // 946 (all "Knife" variants share the name)
  const BREAD_ITEM_ID = ItemIdentifiers.BREAD; // 2309
  const COOKED_MEAT_ITEM_ID = ItemIdentifiers.COOKED_MEAT; // 2142
  const STEAK_SANDWICH_ITEM_ID = ItemIdentifiers.STEAK_SANDWICH; // 25631
  const COINS_ITEM_ID = ItemIdentifiers.COINS; // 995
  const BEER_ITEM_ID = ItemIdentifiers.BEER; // 1917
  const ASGARNIAN_ALE_ITEM_ID = ItemIdentifiers.ASGARNIAN_ALE; // 1905
  const DWARVEN_STOUT_ITEM_ID = ItemIdentifiers.DWARVEN_STOUT; // 1913
  const WIZARDS_MIND_BOMB_ITEM_ID = ItemIdentifiers.WIZARDS_MIND_BOMB; // 1907
  const ALCOHOL_ITEM_IDS = [
    BEER_ITEM_ID,
    ASGARNIAN_ALE_ITEM_ID,
    DWARVEN_STOUT_ITEM_ID,
    WIZARDS_MIND_BOMB_ITEM_ID,
  ];

  // Objects (cache names in brackets; "Enter"/"Exit"/"Investigate"/"Mine" ops from the
  // object definitions; placements dumped with output/scripts/dump-loc.ts).
  const RUINS_ENTRANCE_OBJECT_ID = ObjectIdentifiers.RUINS_ENTRANCE; // 41439 [bim_door]
  const RUINS_EXIT_OBJECT_ID = ObjectIdentifiers.RUINS_EXIT; // 41446 [bim_exit]
  const WILLOWS_BAG_OBJECT_ID = ObjectIdentifiers.WILLOWS_BAG; // 41448
  const STRUCTURAL_PILLAR_OBJECT_ID = ObjectIdentifiers.STRUCTURAL_PILLAR; // 41458 [bim_boss_rock]
  const BROKEN_PILLAR_OBJECT_ID = ObjectIdentifiers.BROKEN_PILLAR_3; // 41459 [bim_boss_rock_mined]

  // Flex emote: Emotes.plugin.js row { sequence: 8917, loop: 12064 } and cache seq
  // gameval 12064 "emote_flex_loop".
  const FLEX_ANIMATION_ID = 8917;

  // Stage values.
  const STAGE_STARTED = 1;
  const STAGE_RECRUITED = 2;
  const STAGE_GUARDIAN = 3;
  const STAGE_GUARDIAN_DEAD = 4;
  const STAGE_COMPLETE = 5;

  // Member sub-states.
  const MEMBER_NONE = 0;
  const MEMBER_IN_PROGRESS = 1;
  const MEMBER_RECRUITED = 2;

  // Persisted attributes.
  const CHECKAL_ATTRIBUTE = "quest.below_ice_mountain.checkal";
  const MARLEY_ATTRIBUTE = "quest.below_ice_mountain.marley";
  const BURNTOF_ATTRIBUTE = "quest.below_ice_mountain.burntof";
  const BURNTOF_ASKED_ATTRIBUTE = "quest.below_ice_mountain.burntof-asked";
  const ATLAS_SESSIONS_ATTRIBUTE = "quest.below_ice_mountain.atlas-sessions";
  const ATLAS_DECLINED_ATTRIBUTE = "quest.below_ice_mountain.atlas-declined";
  const FLEX_UNLOCKED_ATTRIBUTE = "quest.below_ice_mountain.flex-unlocked";
  const COOK_TALKED_ATTRIBUTE = "quest.below_ice_mountain.cook-talked";
  const SANDWICH_MADE_ATTRIBUTE = "quest.below_ice_mountain.sandwich-made";
  const MET_RAMARNO_ATTRIBUTE = "quest.below_ice_mountain.met-ramarno";
  const PILLARS_MINED_ATTRIBUTE = "quest.below_ice_mountain.pillars-mined";

  // Condition step ids on the "Below Ice Mountain" page.
  const CONDITION_STRENGTH_99 = "CdEohS";
  const CONDITION_STRENGTH_NOT_99 = "YEdgkU";
  const CONDITION_ATLAS_HAS_COINS = "-zuNtr";
  const CONDITION_ATLAS_NO_COINS = "Z_TXng";
  const CONDITION_NOT_LAST_RECRUIT = "p3MZVl";
  const CONDITION_LAST_RECRUIT = "RPjNZ9";
  const CONDITION_BURNTOF_NO_DRINK = "EX9T0U";
  const CONDITION_BURNTOF_HAS_DRINK = "L2PHG2";
  const CONDITION_BURNTOF_NO_DRINK_AGAIN = "CXxHKd";
  const CONDITION_BURNTOF_HAS_DRINK_AGAIN = "kZrigp";
  const CONDITION_BURNTOF_STOUT = "gHbQLF";
  const CONDITION_BURNTOF_ALE = "uzDIC-";
  const CONDITION_BURNTOF_BOMB = "OsDb1T";
  const CONDITION_BURNTOF_NOT_LAST = "h3U6R5";
  const CONDITION_BURNTOF_LAST = "_wuChA";
  const CONDITION_MARLEY_NOT_LAST = "Yky2FJ";
  const CONDITION_MARLEY_LAST = "mVCBES";

  // Action / message / branch step ids.
  const ACTION_TRAIN_START = "_RwWTk";
  const ACTION_FLEX_UNLOCK = "q4GQkU";
  const ACTION_TRAIN_END = "Ajwwje";
  const ACTION_ATLAS_PAY_PROMPT = "YGoPl5";
  const ACTION_ATLAS_PAY_PROMPT_2 = "isCXxq";
  const ACTION_ATLAS_REPLAY_TRAINING = "zwa0Ry";
  const ACTION_CHECKAL_FLEX = "pPaqOe";
  const ACTION_CHECKAL_FLEX_AGAIN = "7_PDqd";
  const ACTION_BURNTOF_DRINK = "vaTm6G";
  const ACTION_BURNTOF_DRINK_AGAIN = "EW_TIu";
  const ACTION_RPS_START = "Lv8k9i";
  const ACTION_RPS_ROUND_1 = "yRUinL";
  const ACTION_RPS_ROUND_2 = "jyevbC";
  const ACTION_RPS_ROUND_3 = "QWyd4M";
  const ACTION_RPS_CHEAT = "OMpRy5";
  const ACTION_RPS_TINA = "wuLdBo";
  const ACTION_RPS_END = "CU6FG0";
  const ACTION_MARLEY_HANDOVER = "jgz4nU";
  const ACTION_CUTSCENE_BEGIN = "fOQUgc";
  const ACTION_CUTSCENE_INSIDE = "1Pscfp";
  const ACTION_GUARDIAN_WAKES = "wWX1Ws";
  const ACTION_CUTSCENE_END = "6g-zlD";
  const ACTION_BAG_RUMMAGE = "zy3NHn";
  const ACTION_DOORS_OPEN = "D1Y7Rh";
  const ACTION_RAMARNO_DEPARTS = "i5wpmS";
  // Wiki "unavailable"/"{{tact|...}}" markers whose branch should simply carry on.
  const BRANCH_CONTINUE_IDS = new Set(["W0vwlg", "bEqDuA", "_siJEW"]);
  const DIALOGUE_STEP_IDS = new Set([
    ACTION_TRAIN_START,
    ACTION_FLEX_UNLOCK,
    ACTION_TRAIN_END,
    ACTION_ATLAS_PAY_PROMPT,
    ACTION_ATLAS_PAY_PROMPT_2,
    ACTION_ATLAS_REPLAY_TRAINING,
    ACTION_CHECKAL_FLEX,
    ACTION_CHECKAL_FLEX_AGAIN,
    ACTION_BURNTOF_DRINK,
    ACTION_BURNTOF_DRINK_AGAIN,
    ACTION_RPS_START,
    ACTION_RPS_ROUND_1,
    ACTION_RPS_ROUND_2,
    ACTION_RPS_ROUND_3,
    ACTION_RPS_CHEAT,
    ACTION_RPS_TINA,
    ACTION_RPS_END,
    ACTION_MARLEY_HANDOVER,
    ACTION_CUTSCENE_BEGIN,
    ACTION_CUTSCENE_INSIDE,
    ACTION_GUARDIAN_WAKES,
    ACTION_CUTSCENE_END,
    ACTION_BAG_RUMMAGE,
    ACTION_DOORS_OPEN,
    ACTION_RAMARNO_DEPARTS,
    ...BRANCH_CONTINUE_IDS,
  ]);

  // Tiles (npc-spawns.json coordinates and dump-loc.ts placements).
  const WILLOW_TILE = { x: 3003, y: 3435 };
  const CHECKAL_TILE = { x: 3087, y: 3415 };
  const MARLEY_TILE = { x: 3088, y: 3471 };
  const BURNTOF_TILE = { x: 2956, y: 3367 };
  const ENTRANCE_OBJECT_TILE = { x: 2997, y: 3492 };
  const ENTRANCE_ARRIVAL_TILE = { x: 2996, y: 3494 };
  const RUINS_ARRIVAL_TILE = { x: 2951, y: 5770 };
  const GUARDIAN_TILE = { x: 2952, y: 5775 };
  const PILLAR_TILES = [
    { x: 2947, y: 5771, face: 3 },
    { x: 2947, y: 5778, face: 3 },
    { x: 2958, y: 5771, face: 1 },
    { x: 2958, y: 5778, face: 1 },
  ];
  const MINED_PILLARS_TO_WIN = 4;

  // Rock-paper-scissors: the transcript script has Burntof declare the player the
  // winner and the player "cheat" on the last round; the wiki fills the sign
  // placeholders per pick, so they are resolved from the stored pick.
  const BEATS = { Rock: "Paper", Paper: "Scissors", Scissors: "Rock" };
  const LOSES = { Rock: "Scissors", Paper: "Rock", Scissors: "Paper" };
  const RPS_SIGNS = new Set(Object.keys(BEATS));

  const GAME_MESSAGE_START = "The Ancient Guardian crumbles into a pile of rocks.";

  const guardians = new Map(); // player -> owner-only Ancient Guardian
  const rpsPicks = new WeakMap(); // player -> "Rock" | "Paper" | "Scissors"
  let structuralPillars = [];
  let worldInstalled = false;
  let quest;

  // ==========================================================================
  // Small helpers
  // ==========================================================================

  function memberState(player, attribute) {
    return Number(player.getAttribute(attribute)) || 0;
  }

  function setMemberState(player, attribute, value) {
    player.setAttribute(attribute, value | 0);
  }

  function attrFlag(player, attribute) {
    return Number(player.getAttribute(attribute)) || 0;
  }

  function setFlag(player, attribute, on = true) {
    player.setAttribute(attribute, on ? 1 : 0);
  }

  function held(player, itemId, amount = 1) {
    return player.getInventory().getAmount(itemId) >= amount;
  }

  function coins(player) {
    return player.getInventory().getAmount(COINS_ITEM_ID);
  }

  function hasAlcohol(player) {
    return ALCOHOL_ITEM_IDS.some((itemId) => held(player, itemId));
  }

  function takeAlcohol(player) {
    for (const itemId of ALCOHOL_ITEM_IDS) {
      if (held(player, itemId)) {
        player.getInventory().deleteNumber(itemId, 1);
        return true;
      }
    }
    return false;
  }

  function strengthLevel(player) {
    return player.getSkillManager().getCurrentLevel(Skill.STRENGTH);
  }

  function allRecruited(player) {
    return memberState(player, CHECKAL_ATTRIBUTE) >= MEMBER_RECRUITED
      && memberState(player, MARLEY_ATTRIBUTE) >= MEMBER_RECRUITED
      && memberState(player, BURNTOF_ATTRIBUTE) >= MEMBER_RECRUITED;
  }

  function moveTo(player, tile) {
    player.moveTo(new Location(tile.x, tile.y, 0));
  }

  function resetQuestState(player) {
    setMemberState(player, CHECKAL_ATTRIBUTE, MEMBER_NONE);
    setMemberState(player, MARLEY_ATTRIBUTE, MEMBER_NONE);
    setMemberState(player, BURNTOF_ATTRIBUTE, MEMBER_NONE);
    setFlag(player, BURNTOF_ASKED_ATTRIBUTE, false);
    setFlag(player, ATLAS_DECLINED_ATTRIBUTE, false);
    setFlag(player, COOK_TALKED_ATTRIBUTE, false);
    setFlag(player, SANDWICH_MADE_ATTRIBUTE, false);
    setFlag(player, MET_RAMARNO_ATTRIBUTE, false);
    player.setAttribute(ATLAS_SESSIONS_ATTRIBUTE, 0);
    player.setAttribute(PILLARS_MINED_ATTRIBUTE, 0);
  }

  /** Third recruit in: the story moves to the ruins entrance. */
  function checkAllRecruited(player) {
    if (quest.getStage(player) === STAGE_STARTED && allRecruited(player)) {
      quest.setStage(player, STAGE_RECRUITED);
    }
  }

  // ==========================================================================
  // Transcript variant selection
  // ==========================================================================

  function selectVariant({ npcId, player }) {
    if (!DIALOGUE_NPC_IDS.has(npcId)) return null;
    if (npcId === WILLOW_NPC_ID) return selectWillowVariant(player);
    if (npcId === MARLEY_NPC_ID) return selectMarleyVariant(player);
    if (npcId === CHECKAL_NPC_ID) return selectCheckalVariant(player);
    if (npcId === ATLAS_NPC_ID) return selectAtlasVariant(player);
    if (npcId === BURNTOF_NPC_ID || npcId === BURNTOF_2_NPC_ID) return selectBurntofVariant(player);
    if (npcId === COOK_NPC_ID) return selectCookVariant(player);
    if (npcId === CHARLIE_NPC_ID) return selectCharlieVariant(player);
    if (RAMARNO_NPC_IDS.has(npcId)) return selectRamarnoVariant(player);
    return null;
  }

  function selectWillowVariant(player) {
    const stage = quest.getStage(player);
    if (stage === 0) return "willow-the-archaeologist-talking-to-willow";
    if (stage === STAGE_STARTED) return "willow-the-archaeologist-talking-to-willow-again";
    if (stage === STAGE_RECRUITED) return "the-ruins-of-camdozaal-talking-to-willow";
    if (stage >= STAGE_COMPLETE) return "post-quest-dialogue-willow";
    return null;
  }

  function selectMarleyVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED) return null;
    if (stage >= STAGE_COMPLETE) return "post-quest-dialogue-marley";
    const state = memberState(player, MARLEY_ATTRIBUTE);
    if (state === MEMBER_NONE) {
      setMemberState(player, MARLEY_ATTRIBUTE, MEMBER_IN_PROGRESS);
      return "marley-the-thief-talking-to-marley";
    }
    if (state === MEMBER_IN_PROGRESS && held(player, STEAK_SANDWICH_ITEM_ID)) {
      return "marley-the-thief-returning-to-marley";
    }
    if (state === MEMBER_IN_PROGRESS) return "marley-the-thief-talking-to-marley-talking-to-marley-again";
    return "marley-the-thief-returning-to-marley-talking-to-marley-at-ice-mountain";
  }

  function selectCheckalVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED) return null;
    if (stage >= STAGE_COMPLETE) return "post-quest-dialogue-checkal";
    const state = memberState(player, CHECKAL_ATTRIBUTE);
    if (state === MEMBER_NONE) {
      setMemberState(player, CHECKAL_ATTRIBUTE, MEMBER_IN_PROGRESS);
      return "checkal-the-strongman-talking-to-checkal";
    }
    if (state === MEMBER_IN_PROGRESS) {
      const sessions = attrFlag(player, ATLAS_SESSIONS_ATTRIBUTE);
      if (sessions === 0) return "checkal-the-strongman-talking-to-checkal-talking-to-checkal-again";
      return "checkal-the-strongman-talking-to-checkal-after-completing-atlas-training";
    }
    return "checkal-the-strongman-talking-to-checkal-again-before-showing-muscles-talking-to-checkal-at-ice-mountain";
  }

  function selectAtlasVariant(player) {
    const stage = quest.getStage(player);
    const sessions = attrFlag(player, ATLAS_SESSIONS_ATTRIBUTE);
    if (stage >= STAGE_COMPLETE) {
      if (sessions === 0) return null;
      if (sessions === 1) return "after-the-completion-of-below-ice-mountain-first-workout";
      if (sessions === 2) return "after-the-completion-of-below-ice-mountain-second-workout";
      return "after-the-completion-of-below-ice-mountain-subsequent-workouts";
    }
    if (stage < STAGE_STARTED || memberState(player, CHECKAL_ATTRIBUTE) === MEMBER_NONE) return null;
    const checkal = memberState(player, CHECKAL_ATTRIBUTE);
    if (checkal === MEMBER_IN_PROGRESS && sessions === 0) {
      if (attrFlag(player, ATLAS_DECLINED_ATTRIBUTE)) {
        return "checkal-the-strongman-talking-to-atlas-again-if-the-player-said-no-to-training-session";
      }
      return "checkal-the-strongman-talking-to-atlas";
    }
    if (sessions <= 1) return "checkal-the-strongman-talking-to-atlas-again-after-first-training-session";
    if (sessions === 2) return "checkal-the-strongman-talking-to-atlas-again-after-second-training-session";
    return "checkal-the-strongman-subsequent-training-sessions";
  }

  function selectBurntofVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED) return null;
    if (stage >= STAGE_COMPLETE) return "post-quest-dialogue-burntof";
    const state = memberState(player, BURNTOF_ATTRIBUTE);
    if (state === MEMBER_NONE) {
      if (attrFlag(player, BURNTOF_ASKED_ATTRIBUTE)) {
        return "burntof-master-of-explosives-talking-to-burntof-again-before-he-gets-a-beer";
      }
      setFlag(player, BURNTOF_ASKED_ATTRIBUTE, true);
      return "burntof-master-of-explosives-talking-to-burntof";
    }
    if (state === MEMBER_IN_PROGRESS) return "burntof-master-of-explosives-rock-paper-scissors";
    return "burntof-master-of-explosives-talking-to-burntof-at-ice-mountain";
  }

  function selectCookVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_COMPLETE) return null;
    if (memberState(player, MARLEY_ATTRIBUTE) !== MEMBER_IN_PROGRESS) return null;
    if (attrFlag(player, SANDWICH_MADE_ATTRIBUTE)) {
      return "marley-the-thief-making-the-steak-sandwich-talking-to-the-cook-after-managing-to-make-yourself-a-steak-sandwich";
    }
    if (attrFlag(player, COOK_TALKED_ATTRIBUTE)) {
      return "marley-the-thief-making-the-steak-sandwich-talking-to-the-cook-again";
    }
    setFlag(player, COOK_TALKED_ATTRIBUTE, true);
    return "marley-the-thief-making-the-steak-sandwich-talking-to-the-cook";
  }

  function selectCharlieVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_COMPLETE) return null;
    return "marley-the-thief-talking-to-charlie-the-tramp";
  }

  function selectRamarnoVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_COMPLETE) return null;
    if (!attrFlag(player, MET_RAMARNO_ATTRIBUTE)) return "post-quest-dialogue-ramarno";
    return null; // Own "Ramarno" page: subsequent/forge dialogue.
  }

  /**
   * The world spawn 10702 resolves its clicks to 10685, so route both through the
   * quest variant selector before NpcDialogues takes them, and play through the
   * named 10684 chathead (10702 has no name for its speaker head). Before
   * completion and after meeting him (null) the generic "Ramarno" page plays,
   * exactly as it does for 10684.
   */
  function handleRamarnoTalk(event) {
    if (!RAMARNO_WORLD_NPC_IDS.has(event.npcId) || event.clickType !== 1) return;
    const variant = selectRamarnoVariant(event.player);
    if (!variant) return;
    event.handled = true;
    startTranscript(api, event.player, RAMARNO_NPC_ID, PAGE, variant);
  }

  // ==========================================================================
  // Prose-condition answers
  // ==========================================================================

  function answerCondition({ npcId, player, stepId }) {
    if (!DIALOGUE_NPC_IDS.has(npcId)) return null;
    switch (stepId) {
      case CONDITION_STRENGTH_99:
        return strengthLevel(player) >= 99;
      case CONDITION_STRENGTH_NOT_99:
        return strengthLevel(player) < 99;
      case CONDITION_ATLAS_HAS_COINS:
        return coins(player) >= 25000;
      case CONDITION_ATLAS_NO_COINS:
        return coins(player) < 25000;
      case CONDITION_NOT_LAST_RECRUIT:
      case CONDITION_BURNTOF_NOT_LAST:
      case CONDITION_MARLEY_NOT_LAST:
        return !allRecruited(player);
      case CONDITION_LAST_RECRUIT:
      case CONDITION_BURNTOF_LAST:
      case CONDITION_MARLEY_LAST:
        return allRecruited(player);
      case CONDITION_BURNTOF_NO_DRINK:
      case CONDITION_BURNTOF_NO_DRINK_AGAIN:
        return !hasAlcohol(player);
      case CONDITION_BURNTOF_HAS_DRINK:
      case CONDITION_BURNTOF_HAS_DRINK_AGAIN:
        return hasAlcohol(player);
      case CONDITION_BURNTOF_STOUT:
        return held(player, DWARVEN_STOUT_ITEM_ID);
      case CONDITION_BURNTOF_ALE:
        return held(player, ASGARNIAN_ALE_ITEM_ID);
      case CONDITION_BURNTOF_BOMB:
        return held(player, WIZARDS_MIND_BOMB_ITEM_ID);
      default:
        return null;
    }
  }

  // ==========================================================================
  // Choice / line / action handling
  // ==========================================================================

  function normaliseOption(option) {
    return String(option ?? "").trim().toLowerCase().replace(/[.!]+$/, "");
  }

  function handleChoice({ player, npcId, option }) {
    const pick = normaliseOption(option);
    if (npcId === WILLOW_NPC_ID && pick === "yes" && quest.getStage(player) === 0) {
      resetQuestState(player);
      quest.setStage(player, STAGE_STARTED);
      return;
    }
    if (npcId === ATLAS_NPC_ID) {
      if (pick === "no" && memberState(player, CHECKAL_ATTRIBUTE) === MEMBER_IN_PROGRESS) {
        setFlag(player, ATLAS_DECLINED_ATTRIBUTE, true);
      }
      if (pick === "yes") setFlag(player, ATLAS_DECLINED_ATTRIBUTE, false);
      return;
    }
    if ((npcId === BURNTOF_NPC_ID || npcId === BURNTOF_2_NPC_ID)) {
      const sign = pick.charAt(0).toUpperCase() + pick.slice(1);
      if (RPS_SIGNS.has(sign)) rpsPicks.set(player, sign);
    }
  }

  function handleLine(event) {
    const { player, npcId, text } = event;
    if (typeof text !== "string") return;
    if (RAMARNO_NPC_IDS.has(npcId) && text.startsWith("The player will automatically speak")) {
      event.skip = true;
      return;
    }
    if (npcId === ATLAS_NPC_ID && text.includes("[times done]")) {
      event.text = text.replace("[times done]", String(attrFlag(player, ATLAS_SESSIONS_ATTRIBUTE)));
    }
    // Burntof's RPS lines carry "[chosen sign]"-style blanks; fill them too.
    event.text = fillRpsSigns(player, event.text);
  }

  function fillRpsSigns(player, text) {
    const pick = rpsPicks.get(player) ?? "Rock";
    // Burntof is too drunk to play properly, so the hand he actually shows is the
    // sign the player's pick beats; both "Burntof's" blanks resolve from that sign.
    const burntofs = LOSES[pick];
    return String(text)
      .replace(/\[winning sign\]/g, BEATS[pick])
      .replace(/\[losing sign\]/g, LOSES[pick])
      .replace(/\[chosen sign\]/g, pick)
      .replace(/\[sign that gets beaten by Burntof's\]/g, LOSES[burntofs])
      .replace(/\[sign that beats Burntof's\]/g, BEATS[burntofs]);
  }

  /** Fires for every quest step, scoped by the step ids on this quest's page. */
  function handleAction(event) {
    const { player, npcId, stepId } = event;
    if (typeof stepId !== "string" || !DIALOGUE_STEP_IDS.has(stepId)) return;
    if (stepId === ACTION_CHECKAL_FLEX || stepId === ACTION_CHECKAL_FLEX_AGAIN) {
      if (npcId !== CHECKAL_NPC_ID) return;
      event.handled = true;
      player.performAnimation(new Animation(FLEX_ANIMATION_ID));
      setFlag(player, FLEX_UNLOCKED_ATTRIBUTE, true);
      setMemberState(player, CHECKAL_ATTRIBUTE, MEMBER_RECRUITED);
      checkAllRecruited(player);
      return;
    }
    if (stepId === ACTION_TRAIN_START) {
      event.handled = true;
      return;
    }
    if (stepId === ACTION_FLEX_UNLOCK) {
      event.handled = true;
      setFlag(player, FLEX_UNLOCKED_ATTRIBUTE, true);
      player.sendMessage("You have unlocked the flex emote!");
      return;
    }
    if (stepId === ACTION_TRAIN_END) {
      event.handled = true;
      const sessions = attrFlag(player, ATLAS_SESSIONS_ATTRIBUTE);
      player.setAttribute(ATLAS_SESSIONS_ATTRIBUTE, Math.min(sessions + 1, 3));
      if (memberState(player, CHECKAL_ATTRIBUTE) === MEMBER_IN_PROGRESS) {
        setFlag(player, ATLAS_DECLINED_ATTRIBUTE, false);
      }
      return;
    }
    if (stepId === ACTION_ATLAS_PAY_PROMPT || stepId === ACTION_ATLAS_PAY_PROMPT_2) {
      event.handled = true; // The following Yes/No menu is the real prompt.
      return;
    }
    if (stepId === ACTION_ATLAS_REPLAY_TRAINING) {
      // The paid repeat: charge and count the session, then carry on (the "restart"
      // reference step cannot replay another variant from inside a live dialogue).
      event.handled = true;
      if (!held(player, COINS_ITEM_ID, 25000)) return;
      player.getInventory().deleteNumber(COINS_ITEM_ID, 25000);
      const sessions = attrFlag(player, ATLAS_SESSIONS_ATTRIBUTE);
      player.setAttribute(ATLAS_SESSIONS_ATTRIBUTE, Math.min(sessions + 1, 3));
      return;
    }
    if (stepId === ACTION_BURNTOF_DRINK || stepId === ACTION_BURNTOF_DRINK_AGAIN) {
      if (npcId !== BURNTOF_NPC_ID && npcId !== BURNTOF_2_NPC_ID) return;
      event.handled = true;
      if (takeAlcohol(player)) {
        setMemberState(player, BURNTOF_ATTRIBUTE, MEMBER_IN_PROGRESS);
      }
      return;
    }
    if (stepId === ACTION_RPS_START || stepId === ACTION_RPS_TINA) {
      event.handled = true;
      return;
    }
    if (stepId === ACTION_RPS_ROUND_1 || stepId === ACTION_RPS_ROUND_2
        || stepId === ACTION_RPS_ROUND_3 || stepId === ACTION_RPS_CHEAT) {
      event.handled = true;
      player.sendMessage(fillRpsSigns(player, event.text ?? ""));
      return;
    }
    if (stepId === ACTION_RPS_END) {
      event.handled = true;
      setMemberState(player, BURNTOF_ATTRIBUTE, MEMBER_RECRUITED);
      checkAllRecruited(player);
      return;
    }
    if (stepId === ACTION_MARLEY_HANDOVER) {
      if (npcId !== MARLEY_NPC_ID) return;
      event.handled = true;
      if (held(player, STEAK_SANDWICH_ITEM_ID)) {
        player.getInventory().deleteNumber(STEAK_SANDWICH_ITEM_ID, 1);
        setMemberState(player, MARLEY_ATTRIBUTE, MEMBER_RECRUITED);
        checkAllRecruited(player);
      }
      return;
    }
    if (stepId === ACTION_CUTSCENE_BEGIN) {
      event.handled = true;
      return;
    }
    if (stepId === ACTION_CUTSCENE_INSIDE) {
      event.handled = true;
      moveTo(player, RUINS_ARRIVAL_TILE);
      if (quest.getStage(player) === STAGE_RECRUITED) {
        quest.setStage(player, STAGE_GUARDIAN);
      }
      player.setAttribute(PILLARS_MINED_ATTRIBUTE, 0);
      return;
    }
    if (stepId === ACTION_GUARDIAN_WAKES) {
      event.handled = true;
      spawnGuardian(player);
      return;
    }
    if (stepId === ACTION_CUTSCENE_END) {
      event.handled = true;
      if (quest.getStage(player) === STAGE_RECRUITED) quest.setStage(player, STAGE_GUARDIAN);
      return;
    }
    if (stepId === ACTION_BAG_RUMMAGE) {
      event.handled = true;
      if (quest.getStage(player) === STAGE_GUARDIAN_DEAD) {
        quest.complete(player);
      }
      return;
    }
    if (stepId === ACTION_DOORS_OPEN) {
      event.handled = true;
      return;
    }
    if (stepId === ACTION_RAMARNO_DEPARTS) {
      event.handled = true;
      setFlag(player, MET_RAMARNO_ATTRIBUTE, true);
      return;
    }
    if (BRANCH_CONTINUE_IDS.has(stepId)) {
      // A wiki "unavailable" marker mid-scene (the entrance cutscene's, the bag's, the
      // cook's): let the branch carry on instead of closing.
      event.handled = true;
      return;
    }
  }

  // ==========================================================================
  // World: NPC/object spawns and the Guardian fight
  // ==========================================================================

  function installWorld() {
    if (worldInstalled) return;
    worldInstalled = true;

    ensureNpc(WILLOW_NPC_ID, WILLOW_TILE);
    ensureNpc(CHECKAL_NPC_ID, CHECKAL_TILE);
    ensureNpc(MARLEY_NPC_ID, MARLEY_TILE);
    ensureNpc(BURNTOF_NPC_ID, BURNTOF_TILE);

    ObjectManager.register(
      new GameObject(RUINS_ENTRANCE_OBJECT_ID, new Location(ENTRANCE_OBJECT_TILE.x, ENTRANCE_OBJECT_TILE.y, 0), 10, 0, null),
      true
    );
  }

  function ensureNpc(id, tile, radius = 0) {
    const world = api.getWorld();
    const npcs = world?.getNpcs ? [...world.getNpcs()] : [];
    if (npcs.some((npc) => npc?.getId?.() === id)) return;
    api.spawnNpc({ id, x: tile.x, y: tile.y, z: 0, wanderRadius: radius });
  }

  /** The owner-only Ancient Guardian and the mineable pillars it fights beside. */
  function spawnGuardian(player) {
    const existing = guardians.get(player);
    if (existing && existing.isRegistered?.() !== false) return existing;
    ensurePillars();
    const npc = api.spawnNpc({
      id: ANCIENT_GUARDIAN_NPC_ID,
      x: GUARDIAN_TILE.x,
      y: GUARDIAN_TILE.y,
      z: 0,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) guardians.set(player, npc);
    return npc;
  }

  function ensurePillars() {
    if (structuralPillars.length > 0) return;
    structuralPillars = PILLAR_TILES.map((tile) =>
      new GameObject(STRUCTURAL_PILLAR_OBJECT_ID, new Location(tile.x, tile.y, 0), 10, tile.face, null)
    );
    for (const pillar of structuralPillars) ObjectManager.register(pillar, true);
  }

  function restorePillars() {
    if (structuralPillars.length === 0) return;
    for (const pillar of structuralPillars) {
      ObjectManager.deregister(pillar, true);
      ObjectManager.register(
        new GameObject(BROKEN_PILLAR_OBJECT_ID, pillar.getLocation(), 10, pillar.getFace(), null),
        true
      );
    }
    structuralPillars = [];
  }

  function defeatGuardian(player) {
    if (quest.getStage(player) !== STAGE_GUARDIAN) return;
    quest.setStage(player, STAGE_GUARDIAN_DEAD);
    guardians.delete(player);
    if (guardians.size === 0) restorePillars();
    player.sendMessage(GAME_MESSAGE_START);
  }

  function handleNpcDeath(event) {
    if (event.npcId !== ANCIENT_GUARDIAN_NPC_ID) return;
    const player = event.killer?.isPlayer?.() ? event.killer : null;
    if (!player || !guardians.has(player)) return;
    defeatGuardian(player);
  }

  function handlePlayerLogout({ player }) {
    const npc = guardians.get(player);
    if (npc) {
      guardians.delete(player);
      api.removeNpc(npc);
    }
  }

  // ==========================================================================
  // Object interactions
  // ==========================================================================

  function handleEntrance(event) {
    if (event.objectId !== RUINS_ENTRANCE_OBJECT_ID) return;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_RECRUITED) {
      event.handled = true;
      player.sendMessage("The way is blocked.");
      return;
    }
    event.handled = true;
    if (stage === STAGE_RECRUITED) {
      startTranscript(api, player, WILLOW_NPC_ID, PAGE, "the-ruins-of-camdozaal-talking-to-willow");
      return;
    }
    moveTo(player, RUINS_ARRIVAL_TILE);
    if (stage === STAGE_GUARDIAN) {
      player.setAttribute(PILLARS_MINED_ATTRIBUTE, 0);
      spawnGuardian(player);
    }
  }

  function handleExit(event) {
    if (event.objectId !== RUINS_EXIT_OBJECT_ID) return;
    event.handled = true;
    moveTo(event.player, ENTRANCE_ARRIVAL_TILE);
  }

  function handleObjectInteraction(event) {
    if (event.clickType !== 1) return; // op 1: Enter / Exit / Mine; leave Examine alone
    if (event.objectId === RUINS_ENTRANCE_OBJECT_ID) return handleEntrance(event);
    if (event.objectId === RUINS_EXIT_OBJECT_ID) return handleExit(event);
    if (event.objectId === STRUCTURAL_PILLAR_OBJECT_ID) return handlePillarMine(event);
  }

  function handleWillowsBag(event) {
    if (event.objectId !== WILLOWS_BAG_OBJECT_ID || quest.getStage(event.player) !== STAGE_GUARDIAN_DEAD) {
      return;
    }
    event.handled = true;
    startTranscript(api, event.player, RAMARNO_NPC_ID, PAGE, "finishing-up");
  }

  function handlePillarMine(event) {
    if (event.objectId !== STRUCTURAL_PILLAR_OBJECT_ID) return;
    const { player } = event;
    if (quest.getStage(player) !== STAGE_GUARDIAN) return;
    event.handled = true;
    const mined = attrFlag(player, PILLARS_MINED_ATTRIBUTE) + 1;
    player.setAttribute(PILLARS_MINED_ATTRIBUTE, mined);
    if (mined < MINED_PILLARS_TO_WIN) return;
    const guardian = guardians.get(player);
    if (guardian) api.removeNpc(guardian);
    defeatGuardian(player);
  }

  // ==========================================================================
  // Items
  // ==========================================================================

  function handleKnifeSandwich(event) {
    const { player, usedItemId, usedWithItemId } = event;
    const pair = new Set([usedItemId, usedWithItemId]);
    if (!pair.has(KNIFE_ITEM_ID) || !pair.has(BREAD_ITEM_ID) && !pair.has(COOKED_MEAT_ITEM_ID)) return;
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_COMPLETE) return;
    if (memberState(player, MARLEY_ATTRIBUTE) !== MEMBER_IN_PROGRESS) return;
    if (!held(player, KNIFE_ITEM_ID) || !held(player, BREAD_ITEM_ID) || !held(player, COOKED_MEAT_ITEM_ID)) {
      return;
    }
    event.handled = true;
    player.getInventory().deleteNumber(BREAD_ITEM_ID, 1);
    player.getInventory().deleteNumber(COOKED_MEAT_ITEM_ID, 1);
    player.getInventory().adds(STEAK_SANDWICH_ITEM_ID, 1);
    setFlag(player, SANDWICH_MADE_ATTRIBUTE, true);
    player.sendMessage("You make a steak sandwich.");
  }

  function handleItemOnRamarno(event) {
    if (!RAMARNO_NPC_IDS.has(event.npcId)) return;
    const { player } = event;
    if (quest.getStage(player) < STAGE_COMPLETE || attrFlag(player, MET_RAMARNO_ATTRIBUTE)) return;
    event.handled = true;
    player.sendMessage("Ramarno still looks shocked. Perhaps you should talk to him first.");
  }

  // ==========================================================================
  // Journal and reward
  // ==========================================================================

  function memberLine(player, attribute, label) {
    return memberState(player, attribute) >= MEMBER_RECRUITED
      ? `<str>I recruited ${label}.</str>`
      : `I still need to convince <col=800000>${label}</col>.`;
  }

  function buildJournal(player, handle) {
    const stage = handle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Willow asked me to help her break into ancient ruins beneath</str>",
        "<str>Ice Mountain, and I recruited her old crew to do it.</str>",
        "<str>Inside we woke an Ancient Guardian, which I defeated.</str>",
        "<str>I met Ramarno, the last of the Imcando dwarves of Camdozaal.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage === 0) {
      return [
        "I can start this quest by talking to <col=800000>Willow</col>",
        "on the path south of <col=800000>Ice Mountain</col>.",
      ];
    }
    const lines = [
      "<str>Willow asked me to help her break into ancient ruins beneath</str>",
      "<str>Ice Mountain, and to recruit her old excavation team.</str>",
      "",
    ];
    if (stage === STAGE_STARTED) {
      lines.push(memberLine(player, BURNTOF_ATTRIBUTE, "Burntof"));
      lines.push(memberLine(player, CHECKAL_ATTRIBUTE, "Checkal"));
      lines.push(memberLine(player, MARLEY_ATTRIBUTE, "Marley"));
      return lines;
    }
    lines.push("<str>All three of the crew have agreed to help Willow.</str>");
    if (stage === STAGE_RECRUITED) {
      lines.push("");
      lines.push("I should meet Willow at the ruins entrance on the west");
      lines.push("side of <col=800000>Ice Mountain</col>.");
      return lines;
    }
    lines.push("<str>Burntof blew the rocks open and we entered the ruins.</str>");
    if (stage === STAGE_GUARDIAN) {
      lines.push("");
      lines.push("An <col=800000>Ancient Guardian</col> woke up and the crew ran off.");
      lines.push("I should defeat it, or mine the four structural pillars.");
      return lines;
    }
    lines.push("<str>I defeated the Ancient Guardian.</str>");
    lines.push("");
    lines.push("I should search <col=800000>Willow's bag</col> for anything useful.");
    return lines;
  }

  function grantReward(player) {
    // registerQuest hands out one coin with the scroll; the bag holds 2,000.
    player.getInventory().adds(COINS_ITEM_ID, 1999);
  }

  function handleLogin({ player }) {
    installWorld();
    refreshQuestList(player);
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  quest = registerQuest(api, {
    key: "below_ice_mountain",
    name: "Below Ice Mountain",
    varpId: 2951,
    varbitId: 12063,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    rewardItemId: COINS_ITEM_ID,
    rewardItemLabel: "2,000 Coins",
    otherRewards: [
      "Access to the Ruins of Camdozaal",
      "Flex emote",
      "The ability to make a steak sandwich",
    ],
    buildJournal,
    onReward: grantReward,
  });

  api.persistAttribute(CHECKAL_ATTRIBUTE);
  api.persistAttribute(MARLEY_ATTRIBUTE);
  api.persistAttribute(BURNTOF_ATTRIBUTE);
  api.persistAttribute(BURNTOF_ASKED_ATTRIBUTE);
  api.persistAttribute(ATLAS_SESSIONS_ATTRIBUTE);
  api.persistAttribute(ATLAS_DECLINED_ATTRIBUTE);
  api.persistAttribute(FLEX_UNLOCKED_ATTRIBUTE);
  api.persistAttribute(COOK_TALKED_ATTRIBUTE);
  api.persistAttribute(SANDWICH_MADE_ATTRIBUTE);
  api.persistAttribute(MET_RAMARNO_ATTRIBUTE);
  api.persistAttribute(PILLARS_MINED_ATTRIBUTE);

  api.onServerStartup(installWorld);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handlePlayerLogout);
  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onNpcInteraction(handleRamarnoTalk);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:line", handleLine);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onNpcDeath(handleNpcDeath);
  api.onObjectInteraction(handleObjectInteraction);
  api.onObjectInteraction("Willow's bag", { Investigate: handleWillowsBag });
  api.onItemOnItem("Knife", "Bread", handleKnifeSandwich);
  api.onItemOnItem("Knife", "Cooked meat", handleKnifeSandwich);
  api.onItemOnNpc(handleItemOnRamarno);
};
