/**
 * Shadow of the Storm (members).
 *
 * Words come from the "Shadow of the Storm" transcript page; the stage values,
 * NPC visibility varbits and incantation mechanics come from the cache (varp 602
 * "agrith_quest_varp") cross-checked against QuestHelper's ShadowOfTheStorm:
 *
 *   0  not started          40 Denath explained      90 Denath desummoned
 *   10 started (Reen)        50 Matthew told          100 first helper
 *   20 told to infiltrate    60 golem told            110 eight ready
 *   30 in the group          70 tome shown            120 Agrith-Naar summoned
 *                            80 first ritual          124 killed / reward
 *                                                     130 complete
 *
 * The stage is varbit 1372 "agrith_quest" (sibling bits hold the incantation
 * words 1373-1377, kiln 1378, golem 1379, Dave 1380, Badden 1381, Reen 1382).
 * Those siblings and 1381/1382 also drive the legacy Uzer spawns' transforms
 * (1984-1988 -> 893/895/902/912), so they are kept in step with player state.
 *
 * Sources: OSRS Wiki (quest/quick guide/transcript), cache varp dump, and
 * https://github.com/Zoinkwiz/quest-helper (stage values and incantation order).
 * Rewards: 1 Quest point, 10,000 XP in any combat skill but Prayer, and
 * Silverlight turns into Darklight.
 *
 * Gaps: the demon throne room is the Uzer underground room (the plane-2 room is
 * sealed), like The Golem; the broken-kiln objects carry no cache option, so the
 * plugin adds "Search" to their runtime definition (MCP sees it, a stock client
 * cache does not) and re-applies it after startup on login/bootstrap; the ritual
 * page's single 5-word menu is expanded into the wiki's five picks; the rug
 * merchant's sandstorm dialogue and reading the tome are not wired; "black"
 * clothing is recognised by item name rather than an exhaustive list; OSRS
 * randomises Denath's incantation, the wiki words are played instead; cancelling
 * the reward skill menu is recovered by talking to a surviving wizard; a relog
 * during the fight respawns Agrith-Naar.
 */
module.exports = function registerShadowOfTheStormQuest(api) {
  const {
    CountdownTask,
    Flag,
    Item,
    ItemDefinition,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectDefinition,
    ObjectIdentifiers,
    Skill,
    TaskManager,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const PAGE = "Shadow of the Storm";
  const GOLEM_PAGE = "Clay golem";
  const START_HOOK = "quest:shadow-of-the-storm:start";

  // ============================================================================
  // Ids
  // ============================================================================

  const VARP_SHADOW_OF_THE_STORM = 602; // agrith_quest_varp
  const VARBIT_AGRITH_QUEST = 1372; // agrith_quest (stage)
  const VARBIT_INCANTATION_WORDS = [1373, 1374, 1375, 1376, 1377]; // agrith_incantation_1..5
  const VARBIT_AGRITH_KILN = 1378;
  const VARBIT_CONVINCED_GOLEM = 1379;
  const VARBIT_CONVINCED_DAVE = 1380;
  const VARBIT_BADDEN_UZER = 1381;
  const VARBIT_REEN_UZER = 1382;

  // Legacy world spawns (npc-spawns.json) whose transforms resolve to the ids above.
  const REEN_ALKHARID_NPC_ID = 1984; // agrith_reen_alkharid -> 893
  const REEN_UZER_NPC_ID = 1985; // agrith_reen_uzer -> 893
  const BADDEN_UZER_NPC_ID = 1986; // agrith_badden_uzer -> 895
  const DAVE_AT_PORTAL_NPC_ID = 1987; // agrith_dave_at_portal -> 902
  const DAVE_IN_PASSAGE_NPC_ID = 913; // agrith_dave_in_passage -> 902
  /** The world's Uzer golem placeholder (varbit 348 -> 5134/5135/5136). */
  const GOLEM_PLACEHOLDER_NPC_ID = 6277;

  const REEN_NPC_IDS = new Set([
    NpcIdentifiers.FATHER_REEN, // 893
    NpcIdentifiers.FATHER_REEN_2, // 894
    REEN_ALKHARID_NPC_ID,
    REEN_UZER_NPC_ID,
  ]);
  const BADDEN_NPC_IDS = new Set([
    NpcIdentifiers.FATHER_BADDEN, // 895
    NpcIdentifiers.FATHER_BADDEN_2, // 896
    BADDEN_UZER_NPC_ID,
  ]);
  const DAVE_NPC_IDS = new Set([
    NpcIdentifiers.EVIL_DAVE, // 901
    NpcIdentifiers.EVIL_DAVE_2, // 902
    DAVE_AT_PORTAL_NPC_ID,
    DAVE_IN_PASSAGE_NPC_ID,
  ]);
  const DENATH_NPC_IDS = new Set([NpcIdentifiers.DENATH, NpcIdentifiers.DENATH_2]); // 897/898
  const ERIC_NPC_IDS = new Set([NpcIdentifiers.ERIC, NpcIdentifiers.ERIC_2]); // 899/900
  const MATTHEW_NPC_IDS = new Set([NpcIdentifiers.MATTHEW, NpcIdentifiers.MATTHEW_2]); // 903/904
  const JENNIFER_NPC_IDS = new Set([NpcIdentifiers.JENNIFER_2, NpcIdentifiers.JENNIFER_3]); // 905/906
  const TANYA_NPC_IDS = new Set([NpcIdentifiers.TANYA, NpcIdentifiers.TANYA_2]); // 907/908
  const PATRICK_NPC_IDS = new Set([NpcIdentifiers.PATRICK, NpcIdentifiers.PATRICK_2]); // 909/910
  const GOLEM_NPC_IDS = new Set([
    NpcIdentifiers.CLAY_GOLEM, // 917
    NpcIdentifiers.CLAY_GOLEM_2, // 918
    NpcIdentifiers.BROKEN_CLAY_GOLEM, // 5134
    NpcIdentifiers.DAMAGED_CLAY_GOLEM, // 5135
    NpcIdentifiers.CLAY_GOLEM_3, // 5136
    GOLEM_PLACEHOLDER_NPC_ID,
  ]);
  const OWN_NPC_IDS = new Set([
    ...REEN_NPC_IDS,
    ...BADDEN_NPC_IDS,
    ...DAVE_NPC_IDS,
    ...DENATH_NPC_IDS,
    ...ERIC_NPC_IDS,
    ...MATTHEW_NPC_IDS,
    ...JENNIFER_NPC_IDS,
    ...TANYA_NPC_IDS,
    ...PATRICK_NPC_IDS,
    ...GOLEM_NPC_IDS,
  ]);
  /** Legacy ids whose chathead should show the resolved variant. */
  const LEGACY_NPC_CHAT_HEAD = new Map([
    [REEN_ALKHARID_NPC_ID, NpcIdentifiers.FATHER_REEN],
    [REEN_UZER_NPC_ID, NpcIdentifiers.FATHER_REEN],
    [BADDEN_UZER_NPC_ID, NpcIdentifiers.FATHER_BADDEN],
    [DAVE_AT_PORTAL_NPC_ID, NpcIdentifiers.EVIL_DAVE_2],
    [DAVE_IN_PASSAGE_NPC_ID, NpcIdentifiers.EVIL_DAVE_2],
  ]);

  const SILVERLIGHT_ITEM_ID = ItemIdentifiers.SILVERLIGHT; // 2402
  const DYED_SILVERLIGHT_ITEM_ID = ItemIdentifiers.SILVERLIGHT_2; // 6745
  const DARKLIGHT_ITEM_ID = ItemIdentifiers.DARKLIGHT; // 6746
  const DEMONIC_SIGIL_MOULD_ITEM_ID = ItemIdentifiers.DEMONIC_SIGIL_MOULD; // 6747
  const DEMONIC_SIGIL_ITEM_ID = ItemIdentifiers.DEMONIC_SIGIL; // 6748
  const DEMONIC_TOME_ITEM_ID = ItemIdentifiers.DEMONIC_TOME; // 6749
  const STRANGE_IMPLEMENT_ITEM_ID = ItemIdentifiers.STRANGE_IMPLEMENT; // 4619
  const BLACK_MUSHROOM_ITEM_ID = ItemIdentifiers.BLACK_MUSHROOM; // 4620
  const BLACK_DYE_ITEM_ID = ItemIdentifiers.BLACK_DYE; // 4622 "Black mushroom ink"
  const SILVER_BAR_ITEM_ID = ItemIdentifiers.SILVER_BAR; // 2355

  const BLACK_MUSHROOM_OBJECT_ID = ObjectIdentifiers.BLACK_MUSHROOMS; // 6311
  const KILN_OBJECT_IDS = new Set([
    ObjectIdentifiers.BROKEN_KILN, // 6327
    ObjectIdentifiers.BROKEN_KILN_2, // 6328
    ObjectIdentifiers.BROKEN_KILN_3, // 6329
    ObjectIdentifiers.BROKEN_KILN_4, // 6330
  ]);
  /** The kiln Josef hid the tome in (east side of the Uzer underground). */
  const CORRECT_KILN_TILE = { x: 2733, y: 4904 };

  // ============================================================================
  // Stages and state
  // ============================================================================

  const STAGE_NOT_STARTED = 0;
  const STAGE_STARTED = 10;
  const STAGE_INFILTRATE = 20;
  const STAGE_IN_GROUP = 30;
  const STAGE_DENATH_TOLD = 40;
  const STAGE_MATTHEW_TOLD = 50;
  const STAGE_GOLEM_TOLD = 60;
  const STAGE_BOOK_SHOWN = 70;
  const STAGE_RITUAL = 80;
  const STAGE_RITUAL_DONE = 90;
  const STAGE_PREPARE = 100;
  const STAGE_READY = 110;
  const STAGE_SUMMONED = 120;
  const STAGE_KILLED = 124;
  const STAGE_COMPLETE = 130;

  const CRAFTING_REQUIREMENT = 30;
  const COMBAT_XP = 10000;
  const DEMON_HP_ON_REGEN = 12;

  const HELPERS_ATTRIBUTE = "quest.shadow_of_the_storm.helpers";
  const KILN_ATTRIBUTE = "quest.shadow_of_the_storm.kiln";
  const INCANTATION_ATTRIBUTE = "quest.shadow_of_the_storm.incantation";
  const REWARD_ATTRIBUTE = "quest.shadow_of_the_storm.reward";

  const BIT_DAVE = 1 << 0;
  const BIT_BADDEN = 1 << 1;
  const BIT_REEN = 1 << 2;
  const BIT_GOLEM = 1 << 3;
  const BIT_GOLEM_REPROGRAMMED = 1 << 4;
  const BIT_TANYA = 1 << 5;
  const ALL_HELPERS_MASK = BIT_DAVE | BIT_BADDEN | BIT_REEN | BIT_GOLEM;

  /** Uzer underground (the room The Golem's temple lives in). */
  const UNDERGROUND_ZONE = { minX: 2700, maxX: 2745, minY: 4875, maxY: 4925, levels: [0] };
  const RITUAL_TILE = { x: 2721, y: 4900, z: 0 };
  const THRONE_ENTRY_TILE = { x: 2721, y: 4895, z: 0 };
  const DEMON_TILE = { x: 2721, y: 4904, z: 0 };

  /** Owner-only throne-room wizards; removed once the story moves past each. */
  const WIZARD_SPAWNS = [
    { key: "denath", id: NpcIdentifiers.DENATH, x: 2720, y: 4913, untilStage: STAGE_RITUAL_DONE },
    { key: "eric", id: NpcIdentifiers.ERIC, x: 2733, y: 4905, untilStage: STAGE_RITUAL_DONE },
    { key: "tanya", id: NpcIdentifiers.TANYA, x: 2730, y: 4911, untilStage: STAGE_RITUAL_DONE },
    { key: "matthew", id: NpcIdentifiers.MATTHEW, x: 2723, y: 4910, untilStage: STAGE_SUMMONED },
    { key: "jennifer", id: NpcIdentifiers.JENNIFER_2, x: 2712, y: 4910, untilStage: STAGE_COMPLETE },
    { key: "patrick", id: NpcIdentifiers.PATRICK, x: 2710, y: 4906, untilStage: STAGE_COMPLETE },
  ];

  const INCANTATION_WORDS = ["Caldar", "Nahudu", "Agrith-Naar", "Camerinthum", "Tarren"];
  const WORD_INDEX = new Map(INCANTATION_WORDS.map((word, index) => [word.toLowerCase(), index]));
  /**
   * Denath's order as the transcript speaks it ("Nahudu Camerinthum Caldar
   * Agrith-Naar Tarren"); OSRS randomises it per player, the wiki words do not,
   * and the dialogue must match the words the player has to pick.
   */
  const DENATH_ORDER = [1, 3, 0, 2, 4];
  const FIRST_RITUAL_VARIANT = "performing-the-ritual-getting-in-place";
  const SECOND_RITUAL_VARIANT = "summoning-agrith-naar-in-position";

  const SKILL_BY_OPTION = new Map([
    ["Strength *", Skill.STRENGTH],
    ["Attack *", Skill.ATTACK],
    ["Defence *", Skill.DEFENCE],
    ["Hitpoints *", Skill.HITPOINTS],
    ["Magic *", Skill.MAGIC],
    ["Ranged *", Skill.RANGED],
  ]);
  const SKILL_BY_INDEX = new Map(
    [...SKILL_BY_OPTION.values()].map((skill) => [skill.getIndex(), skill])
  );

  // Condition step ids on the "Shadow of the Storm" page.
  const COND_REEN_START = "svZZrt"; // still has Silverlight at the start
  const COND_REEN_AGAIN_START = "_Q8pfm"; // still has Silverlight, talking to Reen again
  const COND_BADDEN_SILVERLIGHT_PRESENT = "A17tY2"; // still has Silverlight for Badden
  const COND_BADDEN_SILVERLIGHT_LOST = "JkC4Vq"; // lost Silverlight before Badden
  const COND_REF_START = new Set([COND_REEN_START, COND_REEN_AGAIN_START, COND_BADDEN_SILVERLIGHT_PRESENT]);
  const COND_REEN_LOST = new Set(["fllvV0", "X3Ql5k"]); // Reen can hand Silverlight back
  const COND_REF_LOST = new Set([...COND_REEN_LOST, COND_BADDEN_SILVERLIGHT_LOST]);
  const COND_NOT_ENOUGH_BLACK = "JikimW";
  const COND_BLACK_UNDYED = "4k0GUd";
  const COND_BLACK_DYED = "4Y24pa";
  const COND_THRONE_GEMS_REMOVED = "7wLvM8";
  const COND_THRONE_GEMS_PRESENT = "rioSQu";
  const COND_MOULD_FREE = "lfudoK";
  const COND_MOULD_NO_SPACE = "FCmkX6";
  const COND_MOULD_HELD = "k9kfs8";
  const COND_ERIC_WALKED_AWAY = "VYAAJ_";
  const COND_KILN_WRONG = "uo9abT";
  const COND_KILN_BOOK = "3DMFjV";
  const COND_KILN_BOOK_HELD = "qgKzKk";
  const COND_MATTHEW_NO_BOOK = "UiRe9o";
  const COND_MATTHEW_BOOK = "6Gz0Kx";
  const COND_MATTHEW_UNDYED = "Gf2Mqg";
  const COND_MATTHEW_DYED = "ayHNXA";
  const COND_RITUAL_WRONG = "U6mX5q";
  const COND_RITUAL_CORRECT = "q1RJ9d";
  const COND_PEOPLE_FOUR = "PEnb-0";
  const COND_PEOPLE_THREE = "t5gSPE";
  const COND_PEOPLE_TWO = "piK4Mv";
  const COND_PEOPLE_ONE = "NHy6EJ";
  const COND_BADDEN_NO_SIGIL = "3fuR91";
  const COND_BADDEN_SIGIL = "qv5YFB";
  const COND_REEN_NO_SIGIL = "9PtqFf";
  const COND_REEN_SIGIL = "Aw3U2E";
  const COND_GOLEM_NO_SIGIL = "gI6c58";
  const COND_GOLEM_SIGIL = "AWNaLn";
  const COND_SUMMON_NO_SIGIL = "no5_C7";
  const COND_SUMMON_NO_SWORD = "az5CGG";
  const COND_SUMMON_READY = "pblmt4";
  const COND_SUMMON_BACKWARDS = "bAuvv8";
  const COND_SUMMON_CORRECT = "P8GKUN";

  // Action/message step ids.
  const MSG_REEN_GIVES_SWORD = "Kh2EP0";
  const MSG_ESCORT_THRONE = "SzrKim";
  const MSG_DAVE_RETURNS = "vzuhlL";
  const MSG_TANYA_KILLED = "iWR7Wz";
  const ACTION_RITUAL_ASSEMBLES = "FK8qAZ";
  const ACTION_MATTHEW_KILLED = "X9FA-a";
  const ACTION_DEMON_ATTACKS = "YKZEof";
  const ACTION_GOLEM_REPROGRAMMED = "Aha_-j";
  const ACTION_QUEST_COMPLETE = "EDRKBv";

  // ============================================================================
  // State
  // ============================================================================

  let quest;
  let itemOnGroundManager;

  /** player -> Map of wizard key -> spawned npc (owner-only throne room). */
  const wizardNpcs = new WeakMap();
  /** player -> their Agrith-Naar. */
  const demonNpcs = new WeakMap();
  /** player -> incantation words picked this run. */
  const ritualPicks = new WeakMap();
  /** player -> whether the kiln last searched is the correct one. */
  const kilnSearchCorrect = new WeakMap();

  const hasItem = (player, itemId) => player.getInventory().getAmount(itemId) > 0;

  const ownsItem = (player, itemId) =>
    hasItem(player, itemId) ||
    (player.getEquipment().getItems() || []).some((item) => item && item.getId?.() === itemId);

  const hasSilverlight = (player) =>
    ownsItem(player, SILVERLIGHT_ITEM_ID) || ownsItem(player, DYED_SILVERLIGHT_ITEM_ID);
  const hasDyedSilverlight = (player) => ownsItem(player, DYED_SILVERLIGHT_ITEM_ID);

  function silverlightEquipped(player) {
    return (player.getEquipment().getItems() || []).some(
      (item) =>
        item &&
        (item.getId?.() === DYED_SILVERLIGHT_ITEM_ID || item.getId?.() === SILVERLIGHT_ITEM_ID)
    );
  }

  function questComplete(player, key) {
    const request = { player, key, complete: null };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function helperBits(player) {
    return Number(player.getAttribute(HELPERS_ATTRIBUTE)) || 0;
  }

  function setHelperBits(player, bits) {
    player.setAttribute(HELPERS_ATTRIBUTE, bits);
  }

  function kilnProgress(player) {
    return Number(player.getAttribute(KILN_ATTRIBUTE)) || 0;
  }

  function packedIncantation(player) {
    return Number(player.getAttribute(INCANTATION_ATTRIBUTE)) || 0;
  }

  function chosenSkill(player) {
    const index = Number(player.getAttribute(REWARD_ATTRIBUTE));
    return Number.isFinite(index) ? SKILL_BY_INDEX.get(index) : undefined;
  }

  function wordAt(player, index) {
    return (packedIncantation(player) >> (index * 3)) & 7;
  }

  function giveItem(player, itemId, message) {
    if (player.getInventory().isFull()) {
      player.sendMessage("You don't have enough inventory space for that.");
      return false;
    }
    player.getInventory().adds(itemId, 1);
    if (message) player.sendMessage(message);
    return true;
  }

  function chatboxOpen(player) {
    const prompt = api.core.MultiChatboxPrompt?.getPending?.(player) ?? null;
    return player.getDialogueManager?.()?.isActive?.() === true || prompt !== null;
  }

  /** Runs `fn` once the current dialogue has fully closed (a chat menu is a tick). */
  function afterDialogue(player, fn) {
    TaskManager.submit(
      new CountdownTask(player, 1, () => {
        if (player.isRegistered?.() === false) return;
        if (chatboxOpen(player)) {
          afterDialogue(player, fn);
          return;
        }
        fn();
      })
    );
  }

  // ============================================================================
  // Varbits and spawns
  // ============================================================================

  /** Re-sends the sibling varbits the stage and helper bits imply. */
  function syncShadowVarbits(player) {
    const packet = player.getPacketSender();
    const stage = quest.getStage(player);
    const bits = helperBits(player);
    // 1381/1382 also choose the Uzer Badden/Reen transform; 2 hides them, so put
    // them back to 1 once the quest is done and their after-killing lines matter.
    const post = stage >= STAGE_COMPLETE;
    packet.sendVarbit(
      VARBIT_BADDEN_UZER,
      stage >= STAGE_STARTED ? (post || !(bits & BIT_BADDEN) ? 1 : 2) : 0
    );
    packet.sendVarbit(
      VARBIT_REEN_UZER,
      stage >= STAGE_STARTED ? (post || !(bits & BIT_REEN) ? 1 : 2) : 0
    );
    // 1372 no longer maps the portal Dave past stage 110, so keep the passage
    // spawn (varbit 1380) visible through the stage-90 recruitment and after.
    packet.sendVarbit(VARBIT_CONVINCED_DAVE, stage >= STAGE_IN_GROUP ? 1 : 0);
    packet.sendVarbit(
      VARBIT_CONVINCED_GOLEM,
      bits & BIT_GOLEM ? 3 : bits & BIT_GOLEM_REPROGRAMMED ? 2 : 0
    );
    packet.sendVarbit(VARBIT_AGRITH_KILN, kilnProgress(player));
    for (let index = 0; index < VARBIT_INCANTATION_WORDS.length; index++) {
      packet.sendVarbit(VARBIT_INCANTATION_WORDS[index], wordAt(player, index));
    }
  }

  function setStage(player, value) {
    quest.setStage(player, value);
    syncShadowVarbits(player);
    ensureWizardNpcs(player);
  }

  function ensureWizardNpcs(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_IN_GROUP || stage >= STAGE_COMPLETE) {
      removeAllWizards(player);
      return;
    }
    let tracked = wizardNpcs.get(player);
    if (!tracked) {
      tracked = new Map();
      wizardNpcs.set(player, tracked);
    }
    for (const spawn of WIZARD_SPAWNS) {
      const wanted = stage < spawn.untilStage;
      const existing = tracked.get(spawn.key);
      if (wanted && !existing) {
        const npc = api.spawnNpc({
          id: spawn.id,
          x: spawn.x,
          y: spawn.y,
          z: 0,
          wanderRadius: 0,
          owner: player,
          ownerOnly: true,
        });
        if (npc) tracked.set(spawn.key, npc);
      } else if (!wanted && existing) {
        api.removeNpc(existing);
        tracked.delete(spawn.key);
      }
    }
  }

  function removeWizard(player, key) {
    const tracked = wizardNpcs.get(player);
    const npc = tracked?.get(key);
    if (!npc) return;
    api.removeNpc(npc);
    tracked.delete(key);
  }

  function removeAllWizards(player) {
    const tracked = wizardNpcs.get(player);
    if (!tracked) return;
    for (const npc of tracked.values()) api.removeNpc(npc);
    tracked.clear();
  }

  function removeDemon(player) {
    const npc = demonNpcs.get(player);
    if (!npc) return;
    api.removeNpc(npc);
    demonNpcs.delete(player);
  }

  // ============================================================================
  // Black clothing (Evil Dave's gate)
  // ============================================================================

  /** Names the wiki says Dave does not accept even though they read "black". */
  const BLACK_ITEM_EXCEPTIONS = new Set([
    "black beret",
    "black boater",
    "black cavalier",
    "black defender",
    "black headband",
    "black knife",
    "black leprechaun hat",
    "black mask",
    "black satchel",
    "black spiky vambraces",
  ]);

  function isBlackClothing(name) {
    const value = String(name ?? "").toLowerCase();
    if (!value) return false;
    if (value === "darklight") return true;
    if (value === "priest gown" || value === "priest robe") return true;
    if (value.startsWith("ghostly ") || value.startsWith("shade robe")) return true;
    if (value.includes("mystic") && value.includes("(dark)")) return true;
    if (value.includes("graceful") && value.includes("hallowed")) return true;
    if (!value.startsWith("black ")) return false;
    if (value.startsWith("black naval") || value.startsWith("black elegant")) return false;
    if (value.startsWith("black mask")) return false;
    return !BLACK_ITEM_EXCEPTIONS.has(value);
  }

  function countBlackClothing(player) {
    let count = 0;
    for (const item of player.getEquipment().getItems() || []) {
      if (!item) continue;
      const id = item.getId?.();
      if (isBlackClothing(ItemDefinition.forId(id)?.getName?.())) count++;
    }
    return count;
  }

  // ============================================================================
  // Dialogue variant selection
  // ============================================================================

  function selectVariant({ npcId, player }) {
    const stage = quest.getStage(player);

    if (stage >= STAGE_KILLED && stage < STAGE_COMPLETE) {
      // The reward skill menu can be escaped; let a surviving wizard replay it.
      if (MATTHEW_NPC_IDS.has(npcId) || JENNIFER_NPC_IDS.has(npcId) || PATRICK_NPC_IDS.has(npcId)) {
        return "summoning-agrith-naar-killing-agrith-naar";
      }
    }

    if (stage >= STAGE_COMPLETE) {
      if (REEN_NPC_IDS.has(npcId)) return "after-killing-agrith-naar-father-reen";
      if (BADDEN_NPC_IDS.has(npcId)) return "after-killing-agrith-naar-father-badden";
      if (DAVE_NPC_IDS.has(npcId)) return "after-killing-agrith-naar-evil-dave";
      if (JENNIFER_NPC_IDS.has(npcId)) return "after-killing-agrith-naar-jennifer";
      if (PATRICK_NPC_IDS.has(npcId)) return "after-killing-agrith-naar-patrick";
      if (GOLEM_NPC_IDS.has(npcId)) {
        return { page: GOLEM_PAGE, variant: "standard-dialogue-after-completion-of-shadow-of-the-storm" };
      }
      return null;
    }

    if (REEN_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_RITUAL_DONE) return "performing-the-ritual-talking-to-father-reen";
      if (stage >= STAGE_INFILTRATE) return "infiltrating-the-wizards-talking-to-father-reen-at-uzer";
      if (stage >= STAGE_STARTED) return "starting-off-talking-to-father-reen-again";
      return "starting-off";
    }

    if (BADDEN_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_RITUAL_DONE) return "performing-the-ritual-talking-to-father-badden";
      if (stage >= STAGE_DENATH_TOLD) return "infiltrating-the-wizards-talking-to-father-badden";
      if (stage >= STAGE_IN_GROUP) {
        return stage >= STAGE_MATTHEW_TOLD
          ? "infiltrating-the-wizards-asking-around-about-last-night-father-badden"
          : "infiltrating-the-wizards-reporting-back-to-father-badden";
      }
      if (stage >= STAGE_INFILTRATE) return "to-uzer-talking-to-father-badden-again";
      if (stage >= STAGE_STARTED) return "to-uzer-talking-to-father-badden";
      return null;
    }

    if (DAVE_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_SUMMONED) {
        return "summoning-agrith-naar-talking-to-everyone-after-summoning-agrith-naar-evil-dave";
      }
      if (stage >= STAGE_READY) return "summoning-agrith-naar-talking-to-everyone-in-the-ritual-evil-dave";
      if (stage >= STAGE_RITUAL_DONE) return "performing-the-ritual-talking-to-evil-dave-2";
      if (stage >= STAGE_IN_GROUP) return "infiltrating-the-wizards-talking-to-the-dark-wizards-evil-dave";
      if (stage >= STAGE_INFILTRATE) return "infiltrating-the-wizards";
      return "to-uzer-talking-to-evil-dave";
    }

    if (DENATH_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_BOOK_SHOWN) return "performing-the-ritual";
      if (stage >= STAGE_IN_GROUP) return "infiltrating-the-wizards-talking-to-the-dark-wizards-denath";
      return null;
    }

    if (MATTHEW_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_SUMMONED) return null; // killed by Agrith-Naar
      if (stage >= STAGE_READY) return "summoning-agrith-naar";
      if (stage >= STAGE_RITUAL_DONE) return "performing-the-ritual-talking-to-matthew-again";
      if (stage >= STAGE_RITUAL) return "performing-the-ritual-talking-to-matthew";
      if (stage >= STAGE_BOOK_SHOWN) {
        return "infiltrating-the-wizards-talking-to-matthew-again-after-showing-him-the-book";
      }
      if (stage >= STAGE_MATTHEW_TOLD) return "infiltrating-the-wizards-returning-to-matthew";
      if (stage >= STAGE_IN_GROUP) return "infiltrating-the-wizards-talking-to-the-dark-wizards-matthew";
      return null;
    }

    if (JENNIFER_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_SUMMONED) {
        return "summoning-agrith-naar-talking-to-everyone-after-summoning-agrith-naar-jennifer";
      }
      if (stage >= STAGE_READY) return "summoning-agrith-naar-talking-to-everyone-in-the-ritual-jennifer";
      if (stage >= STAGE_RITUAL_DONE) return "performing-the-ritual-talking-to-jennifer-2";
      if (stage >= STAGE_RITUAL) return "performing-the-ritual-talking-to-jennifer";
      if (stage >= STAGE_IN_GROUP) return "infiltrating-the-wizards-talking-to-the-dark-wizards-jennifer";
      return null;
    }

    if (PATRICK_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_SUMMONED) {
        return "summoning-agrith-naar-talking-to-everyone-after-summoning-agrith-naar-patrick";
      }
      if (stage >= STAGE_READY) return "summoning-agrith-naar-talking-to-everyone-in-the-ritual-patrick";
      if (stage >= STAGE_RITUAL_DONE) return "performing-the-ritual-talking-to-patrick-2";
      if (stage >= STAGE_RITUAL) return "performing-the-ritual-talking-to-patrick";
      if (stage >= STAGE_IN_GROUP) return "infiltrating-the-wizards-talking-to-the-dark-wizards-patrick";
      return null;
    }

    if (TANYA_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_RITUAL) return "performing-the-ritual-talking-to-tanya";
      if (stage >= STAGE_IN_GROUP) return "infiltrating-the-wizards-talking-to-the-dark-wizards-tanya";
      return null;
    }

    if (ERIC_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_RITUAL) return "performing-the-ritual-talking-to-eric";
      if (stage >= STAGE_IN_GROUP) return "infiltrating-the-wizards-talking-to-the-dark-wizards-eric";
      return null;
    }

    if (GOLEM_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_RITUAL_DONE) {
        return helperBits(player) & BIT_GOLEM_REPROGRAMMED
          ? "performing-the-ritual-talking-to-the-golem-after-reprogramming"
          : "performing-the-ritual-talking-to-the-clay-golem";
      }
      if (stage >= STAGE_GOLEM_TOLD) return "to-uzer-talking-to-the-clay-golem";
      if (stage >= STAGE_MATTHEW_TOLD) {
        return "infiltrating-the-wizards-asking-around-about-last-night-clay-golem";
      }
      if (stage >= STAGE_IN_GROUP) return "to-uzer-talking-to-the-clay-golem";
      return null;
    }

    return null;
  }

  // ============================================================================
  // Condition answers
  // ============================================================================

  function peopleLeft(player) {
    return 4 - popcount(helperBits(player) & ALL_HELPERS_MASK);
  }

  function popcount(value) {
    let count = 0;
    let bits = value;
    while (bits) {
      count += bits & 1;
      bits >>= 1;
    }
    return count;
  }

  function firstRitualCorrect(player) {
    const picks = ritualPicks.get(player);
    if (!Array.isArray(picks) || picks.length !== INCANTATION_WORDS.length) return false;
    return picks.every((word, index) => word === wordAt(player, index));
  }

  function secondRitualCorrect(player) {
    const picks = ritualPicks.get(player);
    if (!Array.isArray(picks) || picks.length !== INCANTATION_WORDS.length) return false;
    return picks.every((word, index) => word === wordAt(player, INCANTATION_WORDS.length - 1 - index));
  }

  function answerCondition({ player, npcId, stepId, text }) {
    if (!stepId) return null;

    if (COND_REF_START.has(stepId)) return hasSilverlight(player);
    if (COND_REF_LOST.has(stepId)) return !hasSilverlight(player);

    if (stepId === COND_NOT_ENOUGH_BLACK) return countBlackClothing(player) < 3;
    if (stepId === COND_BLACK_UNDYED) {
      return countBlackClothing(player) >= 3 && !hasDyedSilverlight(player);
    }
    if (stepId === COND_BLACK_DYED) {
      return countBlackClothing(player) >= 3 && hasDyedSilverlight(player);
    }

    if (stepId === COND_THRONE_GEMS_REMOVED) return throneGemsRemoved(player);
    if (stepId === COND_THRONE_GEMS_PRESENT) return !throneGemsRemoved(player);

    if (stepId === COND_MOULD_FREE) {
      return !hasItem(player, DEMONIC_SIGIL_MOULD_ITEM_ID) && !player.getInventory().isFull();
    }
    if (stepId === COND_MOULD_NO_SPACE) {
      return !hasItem(player, DEMONIC_SIGIL_MOULD_ITEM_ID) && player.getInventory().isFull();
    }
    if (stepId === COND_MOULD_HELD) return hasItem(player, DEMONIC_SIGIL_MOULD_ITEM_ID);

    if (stepId === COND_ERIC_WALKED_AWAY) return false;

    if (stepId === COND_KILN_WRONG) return kilnSearchCorrect.get(player) === false;
    if (stepId === COND_KILN_BOOK) {
      return (
        kilnSearchCorrect.get(player) === true &&
        !hasItem(player, DEMONIC_TOME_ITEM_ID) &&
        quest.getStage(player) < STAGE_BOOK_SHOWN
      );
    }
    if (stepId === COND_KILN_BOOK_HELD) {
      return hasItem(player, DEMONIC_TOME_ITEM_ID) || quest.getStage(player) >= STAGE_BOOK_SHOWN;
    }

    if (stepId === COND_MATTHEW_NO_BOOK) return !hasItem(player, DEMONIC_TOME_ITEM_ID);
    if (stepId === COND_MATTHEW_BOOK) return hasItem(player, DEMONIC_TOME_ITEM_ID);
    if (stepId === COND_MATTHEW_UNDYED) return !hasDyedSilverlight(player);
    if (stepId === COND_MATTHEW_DYED) return hasDyedSilverlight(player);

    const left = peopleLeft(player);
    if (stepId === COND_PEOPLE_FOUR) return left === 4;
    if (stepId === COND_PEOPLE_THREE) return left === 3;
    if (stepId === COND_PEOPLE_TWO) return left === 2;
    if (stepId === COND_PEOPLE_ONE) return left === 1;

    const bits = helperBits(player);
    if (stepId === COND_BADDEN_NO_SIGIL) return !(bits & BIT_BADDEN) && !hasItem(player, DEMONIC_SIGIL_ITEM_ID);
    if (stepId === COND_BADDEN_SIGIL) return (bits & BIT_BADDEN) !== 0 || hasItem(player, DEMONIC_SIGIL_ITEM_ID);
    if (stepId === COND_REEN_NO_SIGIL) return !(bits & BIT_REEN) && !hasItem(player, DEMONIC_SIGIL_ITEM_ID);
    if (stepId === COND_REEN_SIGIL) return (bits & BIT_REEN) !== 0 || hasItem(player, DEMONIC_SIGIL_ITEM_ID);
    if (stepId === COND_GOLEM_NO_SIGIL) return !(bits & BIT_GOLEM) && !hasItem(player, DEMONIC_SIGIL_ITEM_ID);
    if (stepId === COND_GOLEM_SIGIL) return (bits & BIT_GOLEM) !== 0 || hasItem(player, DEMONIC_SIGIL_ITEM_ID);

    if (stepId === COND_SUMMON_NO_SIGIL) return !hasItem(player, DEMONIC_SIGIL_ITEM_ID);
    if (stepId === COND_SUMMON_NO_SWORD) {
      return hasItem(player, DEMONIC_SIGIL_ITEM_ID) && !hasSilverlight(player);
    }
    if (stepId === COND_SUMMON_READY) {
      return hasItem(player, DEMONIC_SIGIL_ITEM_ID) && hasSilverlight(player);
    }

    return null;
  }

  /** The Golem's throne gems flag (shared, persisted attribute of that quest). */
  function throneGemsRemoved(player) {
    return Boolean(player.getAttribute("quest.the_golem.throne_gems"));
  }

  // ============================================================================
  // Dialogue events
  // ============================================================================

  function restoreSilverlight(player) {
    if (hasSilverlight(player)) return;
    giveItem(player, SILVERLIGHT_ITEM_ID, "Reen hands you a shining silver sword.");
  }

  function recruitHelper(player, bit) {
    const bits = helperBits(player);
    if (bits & bit) return;
    if (!hasItem(player, DEMONIC_SIGIL_ITEM_ID)) return;
    player.getInventory().deleteNumber(DEMONIC_SIGIL_ITEM_ID, 1);
    finishRecruit(player, bits | bit);
  }

  function recruitEvilDave(player) {
    const bits = helperBits(player);
    if (bits & BIT_DAVE) return;
    if (!giveItem(player, DEMONIC_SIGIL_ITEM_ID, "Evil Dave gives you Eric's demonic sigil.")) return;
    finishRecruit(player, bits | BIT_DAVE);
  }

  function finishRecruit(player, bits) {
    setHelperBits(player, bits);
    const stage = quest.getStage(player);
    if (stage < STAGE_PREPARE) {
      setStage(player, STAGE_PREPARE);
      return;
    }
    if ((bits & ALL_HELPERS_MASK) === ALL_HELPERS_MASK) setStage(player, STAGE_READY);
    else syncShadowVarbits(player);
  }

  function dropDenathsSigil(player) {
    const tile = new Location(RITUAL_TILE.x, RITUAL_TILE.y, RITUAL_TILE.z);
    if (itemOnGroundManager.getGroundItem(player.getUsername(), DEMONIC_SIGIL_ITEM_ID, tile)) return;
    itemOnGroundManager.registerLocation(player, new Item(DEMONIC_SIGIL_ITEM_ID, 1), tile);
  }

  function onFirstRitualComplete(player) {
    setStage(player, STAGE_RITUAL_DONE);
    dropDenathsSigil(player);
  }

  function startFirstIncantation(player) {
    const stage = quest.getStage(player);
    if (stage !== STAGE_BOOK_SHOWN && stage !== STAGE_RITUAL) return;
    if (!hasItem(player, DEMONIC_SIGIL_ITEM_ID)) {
      player.sendMessage("You need a demonic sigil to lead the ritual.");
      return;
    }
    if (!hasDyedSilverlight(player)) {
      player.sendMessage("You need Silverlight with you to face Agrith-Naar.");
      return;
    }
    if (!packedIncantation(player)) assignIncantation(player);
    ritualPicks.delete(player);
    setStage(player, STAGE_RITUAL);
    playRitualMenus(player, NpcIdentifiers.DENATH, FIRST_RITUAL_VARIANT, () =>
      resolveFirstIncantation(player)
    );
  }

  function startSecondIncantation(player) {
    if (quest.getStage(player) !== STAGE_READY) return;
    if (!hasItem(player, DEMONIC_SIGIL_ITEM_ID) || !hasSilverlight(player)) return;
    ritualPicks.delete(player);
    playRitualMenus(player, NpcIdentifiers.MATTHEW, SECOND_RITUAL_VARIANT, () =>
      resolveSecondIncantation(player)
    );
  }

  /**
   * The incantation variants hold one 5-word menu followed by five "[Word N]"
   * echo pairs and the two outcome conditions. Conditions resolve when the
   * dialogue is built, i.e. before any word is picked, so expand the single menu
   * into the wiki's five selections, drop the outcomes, and evaluate afterwards.
   */
  function ritualMenuSteps(steps, outcomeIds) {
    const queue = withoutConditions(steps, outcomeIds);
    const choiceIndex = queue.findIndex((step) => step.type === "choice");
    if (choiceIndex === -1) return queue;
    const choice = queue[choiceIndex];
    const echoes = [];
    const after = [];
    for (const step of queue.slice(choiceIndex + 1)) {
      const text = typeof step.player === "string" ? step.player : step.type === "line" ? step.text : "";
      if (/\[Word \d/.test(String(text ?? "")) && echoes.length < 10) echoes.push(step);
      else after.push(step);
    }
    if (echoes.length < 10) return queue;
    const expanded = [];
    for (let pick = 0; pick < 5; pick++) {
      expanded.push({ ...choice, options: choice.options.map((option) => ({ ...option })) });
      expanded.push(echoes[pick * 2], echoes[pick * 2 + 1]);
    }
    return [...queue.slice(0, choiceIndex), ...expanded, ...after];
  }

  function playRitualMenus(player, npcId, variant, onDone) {
    const outcomeIds = new Set([COND_RITUAL_WRONG, COND_RITUAL_CORRECT, COND_SUMMON_BACKWARDS, COND_SUMMON_CORRECT]);
    if (!startTranscript(api, player, npcId, PAGE, variant, (steps) => ritualMenuSteps(steps, outcomeIds))) {
      return;
    }
    afterDialogue(player, onDone);
  }

  function playOutcome(player, npcId, variant, conditionId) {
    startTranscript(api, player, npcId, PAGE, variant, (steps) =>
      conditionSteps(steps, conditionId).filter(
        (step) => step.type !== "unavailable" && step.type !== "reference"
      )
    );
  }

  function resolveFirstIncantation(player) {
    if (quest.getStage(player) !== STAGE_RITUAL) return;
    const correct = firstRitualCorrect(player);
    ritualPicks.delete(player);
    if (correct) {
      onFirstRitualComplete(player);
      playOutcome(player, NpcIdentifiers.DENATH, FIRST_RITUAL_VARIANT, COND_RITUAL_CORRECT);
    } else {
      playOutcome(player, NpcIdentifiers.DENATH, FIRST_RITUAL_VARIANT, COND_RITUAL_WRONG);
    }
  }

  function resolveSecondIncantation(player) {
    if (quest.getStage(player) !== STAGE_READY) return;
    const correct = secondRitualCorrect(player);
    ritualPicks.delete(player);
    if (correct) {
      setStage(player, STAGE_SUMMONED);
      playOutcome(player, NpcIdentifiers.MATTHEW, SECOND_RITUAL_VARIANT, COND_SUMMON_CORRECT);
    } else {
      playOutcome(player, NpcIdentifiers.MATTHEW, SECOND_RITUAL_VARIANT, COND_SUMMON_BACKWARDS);
    }
  }

  function assignIncantation(player) {
    let packed = 0;
    for (let i = 0; i < DENATH_ORDER.length; i++) packed |= (DENATH_ORDER[i] & 7) << (i * 3);
    player.setAttribute(INCANTATION_ATTRIBUTE, packed);
    for (let i = 0; i < VARBIT_INCANTATION_WORDS.length; i++) {
      player.getPacketSender().sendVarbit(VARBIT_INCANTATION_WORDS[i], DENATH_ORDER[i]);
    }
  }

  /** A variant without the given condition wrappers (the ritual outcome tails). */
  function withoutConditions(steps, conditionIds) {
    return steps.filter((step) => !(step.type === "condition" && conditionIds.has(step.id)));
  }

  /** The body of one condition step, anywhere in the given steps. */
  function conditionSteps(steps, conditionId) {
    for (const step of steps ?? []) {
      if (step.type === "condition" && step.id === conditionId) return step.steps ?? [];
      if (Array.isArray(step.steps)) {
        const found = conditionSteps(step.steps, conditionId);
        if (found.length) return found;
      }
    }
    return [];
  }

  function spawnAgrithNaar(player) {
    if (demonNpcs.has(player)) return;
    removeWizard(player, "matthew");
    const npc = api.spawnNpc({
      id: NpcIdentifiers.AGRITH_NAAR,
      x: DEMON_TILE.x,
      y: DEMON_TILE.y,
      z: DEMON_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) demonNpcs.set(player, npc);
  }

  function convertSilverlightToDarklight(player) {
    const equipment = player.getEquipment();
    const slot = (equipment.getItems() || []).findIndex(
      (item) =>
        item &&
        (item.getId?.() === DYED_SILVERLIGHT_ITEM_ID || item.getId?.() === SILVERLIGHT_ITEM_ID)
    );
    if (slot >= 0) {
      equipment.set(slot, new Item(DARKLIGHT_ITEM_ID, 1)).refreshItems();
      player.getUpdateFlag?.().flag?.(Flag.APPEARANCE);
      return;
    }
    const inventory = player.getInventory();
    if (inventory.getAmount(DYED_SILVERLIGHT_ITEM_ID) > 0) {
      inventory.deleteNumber(DYED_SILVERLIGHT_ITEM_ID, 1);
    } else if (inventory.getAmount(SILVERLIGHT_ITEM_ID) > 0) {
      inventory.deleteNumber(SILVERLIGHT_ITEM_ID, 1);
    }
    inventory.adds(DARKLIGHT_ITEM_ID, 1);
  }

  function completeQuest(player) {
    if (quest.isComplete(player)) return;
    const skill = chosenSkill(player);
    if (skill) {
      quest.xpRewards = [{ skillId: skill.getIndex(), amount: COMBAT_XP, label: skill.getName() }];
    }
    quest.complete(player);
    // complete() sets the stage itself, so repair the sibling varbits here:
    // the post-quest Reen/Badden transforms need to come back.
    syncShadowVarbits(player);
    removeAllWizards(player);
    removeDemon(player);
  }

  function handleConditionEvent(event) {
    const { player, stepId } = event;
    if (!player || !stepId) return;

    if (COND_REEN_LOST.has(stepId)) {
      restoreSilverlight(player);
      return;
    }
    if (stepId === COND_BADDEN_SILVERLIGHT_PRESENT || stepId === COND_BADDEN_SILVERLIGHT_LOST) {
      if (quest.getStage(player) === STAGE_STARTED) setStage(player, STAGE_INFILTRATE);
      return;
    }
    if (stepId === COND_BLACK_DYED) {
      if (quest.getStage(player) === STAGE_INFILTRATE) setStage(player, STAGE_IN_GROUP);
      return;
    }
    if (stepId === COND_MOULD_FREE) {
      if (!hasItem(player, DEMONIC_SIGIL_MOULD_ITEM_ID)) {
        giveItem(player, DEMONIC_SIGIL_MOULD_ITEM_ID, "Jennifer gives you the demonic sigil mould.");
      }
      return;
    }
    if (stepId === COND_KILN_BOOK) {
      if (!hasItem(player, DEMONIC_TOME_ITEM_ID)) {
        giveItem(player, DEMONIC_TOME_ITEM_ID, "You find a demonic tome in the kiln.");
      }
      return;
    }
    if (stepId === COND_MATTHEW_UNDYED || stepId === COND_MATTHEW_DYED) {
      if (quest.getStage(player) < STAGE_BOOK_SHOWN) setStage(player, STAGE_BOOK_SHOWN);
      return;
    }
    if (stepId === COND_GOLEM_NO_SIGIL) {
      player.getPacketSender().sendVarbit(VARBIT_CONVINCED_GOLEM, 1);
      return;
    }
    if (stepId === COND_BADDEN_SIGIL) {
      recruitHelper(player, BIT_BADDEN);
      return;
    }
    if (stepId === COND_REEN_SIGIL) {
      recruitHelper(player, BIT_REEN);
      return;
    }
    if (stepId === COND_GOLEM_SIGIL) {
      recruitHelper(player, BIT_GOLEM);
      return;
    }
    if (stepId === COND_SUMMON_READY) {
      afterDialogue(player, () => startSecondIncantation(player));
      return;
    }
  }

  function handleAction(event) {
    const { player, stepId } = event;
    if (!player || !stepId) return;

    if (stepId === MSG_REEN_GIVES_SWORD) {
      restoreSilverlight(player);
      return; // leave the wiki message to play
    }
    if (stepId === MSG_ESCORT_THRONE) {
      if (quest.getStage(player) === STAGE_INFILTRATE) setStage(player, STAGE_IN_GROUP);
      player.moveTo(new Location(THRONE_ENTRY_TILE.x, THRONE_ENTRY_TILE.y, THRONE_ENTRY_TILE.z));
      return; // leave the wiki message to play
    }
    if (stepId === MSG_DAVE_RETURNS) {
      recruitEvilDave(player);
      return; // leave the wiki message to play
    }
    if (stepId === MSG_TANYA_KILLED) {
      const bits = helperBits(player);
      if (!(bits & BIT_TANYA) && giveItem(player, DEMONIC_SIGIL_ITEM_ID, "You take Tanya's demonic sigil.")) {
        setHelperBits(player, bits | BIT_TANYA);
      }
      return; // leave the wiki message to play
    }
    if (stepId === ACTION_RITUAL_ASSEMBLES) {
      event.handled = true;
      afterDialogue(player, () => startFirstIncantation(player));
      return;
    }
    if (stepId === ACTION_MATTHEW_KILLED) {
      event.handled = true;
      removeWizard(player, "matthew");
      return;
    }
    if (stepId === ACTION_DEMON_ATTACKS) {
      event.handled = true;
      spawnAgrithNaar(player);
      return;
    }
    if (stepId === ACTION_GOLEM_REPROGRAMMED) {
      const bits = helperBits(player);
      if (!(bits & BIT_GOLEM_REPROGRAMMED)) {
        setHelperBits(player, bits | BIT_GOLEM_REPROGRAMMED);
        player.getPacketSender().sendVarbit(VARBIT_CONVINCED_GOLEM, 2);
      }
      return; // leave the wiki messages to play
    }
    if (stepId === ACTION_QUEST_COMPLETE) {
      event.handled = true;
      event.end = true;
      completeQuest(player);
      return;
    }
  }

  function handleChoice({ player, npcId, option }) {
    if (!player) return;
    const text = String(option ?? "");

    const wordIndex = WORD_INDEX.get(text.toLowerCase());
    if (wordIndex !== undefined) {
      let picks = ritualPicks.get(player);
      if (!Array.isArray(picks) || picks.length >= INCANTATION_WORDS.length) picks = [];
      picks.push(wordIndex);
      ritualPicks.set(player, picks);
      return;
    }

    const skill = SKILL_BY_OPTION.get(text);
    if (skill) {
      player.setAttribute(REWARD_ATTRIBUTE, skill.getIndex());
      return;
    }

    const stage = quest.getStage(player);
    // "What do I have to do?" is asked of Denath during Evil Dave's escort, so it can
    // arrive with Dave's id; "I forgot the incantation." lets Denath's own talk catch up.
    if (stage === STAGE_IN_GROUP && (text === "What do I have to do?" || text === "I forgot the incantation.")) {
      if (!packedIncantation(player)) assignIncantation(player);
      setStage(player, STAGE_DENATH_TOLD);
      return;
    }
    if (MATTHEW_NPC_IDS.has(npcId) && text === "Do you know what happened to Josef?" && stage === STAGE_DENATH_TOLD) {
      setStage(player, STAGE_MATTHEW_TOLD);
      return;
    }
    if (GOLEM_NPC_IDS.has(npcId) && text === "Did you see anything happen last night?" && stage === STAGE_MATTHEW_TOLD) {
      setStage(player, STAGE_GOLEM_TOLD);
    }
  }

  /** Fills the wiki placeholders and echoes the incantation words chosen. */
  function fillTranscriptText(event) {
    if (!event?.player || typeof event.text !== "string") return;
    if (!OWN_NPC_IDS.has(event.npcId)) return;
    let text = event.text;
    if (text.includes("[player name]")) {
      text = text.replace(/\[player name\]/gi, String(event.player.getUsername()));
    }
    if (text.includes("[him/her]") || text.includes("[his/her]") || text.includes("[He/She]")) {
      const male = event.player.getAppearance?.().isMale?.() !== false;
      text = text
        .replace(/\[him\/her\]/g, male ? "him" : "her")
        .replace(/\[his\/her\]/g, male ? "his" : "her")
        .replace(/\[He\/She\]/g, male ? "He" : "She");
    }
    if (text.includes("[Word ")) {
      const picks = ritualPicks.get(event.player) ?? [];
      text = text.replace(/\[Word (\d)\]/g, (match, number) => {
        const pick = picks[Number(number) - 1];
        return pick === undefined ? match : INCANTATION_WORDS[pick];
      });
    }
    event.text = text;
  }

  function handleStartHook({ player, npcId, hook }) {
    if (hook !== START_HOOK || !REEN_NPC_IDS.has(npcId)) return;
    if (quest.getStage(player) !== STAGE_NOT_STARTED) return;
    if (!questComplete(player, "the_golem") || !questComplete(player, "demon_slayer")) {
      player.sendMessage("You must complete The Golem and Demon Slayer before starting this quest.");
      return;
    }
    // A reset re-runs the start: drop the progress that lives outside the stage.
    player.setAttribute(HELPERS_ATTRIBUTE, 0);
    player.setAttribute(KILN_ATTRIBUTE, 0);
    player.setAttribute(INCANTATION_ATTRIBUTE, 0);
    player.setAttribute(REWARD_ATTRIBUTE, 0);
    setStage(player, STAGE_STARTED);
  }

  // ============================================================================
  // Interactions
  // ============================================================================

  function dyeSilverlight(player, reagentId) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_RITUAL_DONE) {
      player.sendMessage("You have no reason to do that.");
      return;
    }
    if (!hasItem(player, SILVERLIGHT_ITEM_ID)) return;
    if (reagentId !== undefined && !hasItem(player, reagentId)) return;
    player.getInventory().deleteNumber(SILVERLIGHT_ITEM_ID, 1);
    if (reagentId !== undefined) player.getInventory().deleteNumber(reagentId, 1);
    player.getInventory().adds(DYED_SILVERLIGHT_ITEM_ID, 1);
    startTranscript(api, player, NpcIdentifiers.FATHER_REEN, PAGE, "to-uzer-dyeing-silverlight-black");
  }

  function handleItemOnObject(event) {
    const { player, itemId, objectId } = event;
    if (objectId !== BLACK_MUSHROOM_OBJECT_ID || itemId !== SILVERLIGHT_ITEM_ID) return;
    event.handled = true;
    dyeSilverlight(player);
  }

  function handleItemOnItem(event) {
    const { player, usedItemId, usedWithItemId } = event;
    const ids = [usedItemId, usedWithItemId];
    if (!ids.includes(SILVERLIGHT_ITEM_ID)) return;
    const reagentId = ids.includes(BLACK_MUSHROOM_ITEM_ID)
      ? BLACK_MUSHROOM_ITEM_ID
      : ids.includes(BLACK_DYE_ITEM_ID)
        ? BLACK_DYE_ITEM_ID
        : undefined;
    if (reagentId === undefined) return;
    event.handled = true;
    dyeSilverlight(player, reagentId);
  }

  function smeltDemonicSigil(event) {
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_IN_GROUP || stage >= STAGE_COMPLETE) return false;
    if (!hasItem(player, DEMONIC_SIGIL_MOULD_ITEM_ID)) return false;
    event.handled = true;
    if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < CRAFTING_REQUIREMENT) {
      player.sendMessage(`You need a Crafting level of ${CRAFTING_REQUIREMENT} to cast a demonic sigil.`);
      return;
    }
    if (!hasItem(player, SILVER_BAR_ITEM_ID)) {
      player.sendMessage("You need a silver bar to cast a demonic sigil.");
      return;
    }
    player.getInventory().deleteNumber(SILVER_BAR_ITEM_ID, 1);
    player.getInventory().adds(DEMONIC_SIGIL_ITEM_ID, 1);
    player.sendMessage("You pour the molten silver into the demonic sigil mould.");
  }

  function handleItemOnNpc(event) {
    const npcId = event.npcId ?? event.target?.getId?.();
    if (!GOLEM_NPC_IDS.has(npcId)) return;
    if (event.itemId !== STRANGE_IMPLEMENT_ITEM_ID) return;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_RITUAL_DONE || stage >= STAGE_COMPLETE) return; // The Golem owns the implement otherwise
    event.handled = true;
    if (helperBits(player) & BIT_GOLEM_REPROGRAMMED) return;
    setHelperBits(player, helperBits(player) | BIT_GOLEM_REPROGRAMMED);
    player.getPacketSender().sendVarbit(VARBIT_CONVINCED_GOLEM, 2);
    startTranscript(api, player, npcId, PAGE, "performing-the-ritual-reprogramming-the-golem");
  }

  function handleObjectInteraction(event) {
    const { player, objectId, location } = event;
    if (!KILN_OBJECT_IDS.has(objectId)) return;
    ensureKilnSearchActions();
    event.handled = true;
    const stage = quest.getStage(player);
    if (stage < STAGE_GOLEM_TOLD || stage >= STAGE_RITUAL) {
      player.sendMessage("You don't know what you are looking for.");
      return;
    }
    const correct = location?.x === CORRECT_KILN_TILE.x && location?.y === CORRECT_KILN_TILE.y;
    kilnSearchCorrect.set(player, correct);
    if (!correct && kilnProgress(player) < 3) {
      const progress = kilnProgress(player) + 1;
      player.setAttribute(KILN_ATTRIBUTE, progress);
      player.getPacketSender().sendVarbit(VARBIT_AGRITH_KILN, progress);
    }
    startTranscript(api, player, NpcIdentifiers.MATTHEW, PAGE, "infiltrating-the-wizards-searching-kilns");
  }

  function handleNpcInteraction(event) {
    const { player } = event;
    if (!player) return;
    const actions = event.definition?.getActions?.() ?? [];
    const action = String(actions[event.clickType - 1] ?? "").toLowerCase();
    const talk = action === "talk-to" || (action === "" && event.clickType === 1);
    if (!talk) return;

    if (GOLEM_NPC_IDS.has(event.npcId)) {
      const selected = selectVariant({ npcId: event.npcId, player });
      if (!selected) return; // let The Golem's plugin run its own dialogue
      const page = typeof selected === "string" ? PAGE : selected.page ?? PAGE;
      const variant = typeof selected === "string" ? selected : selected.variant;
      event.handled = true;
      startTranscript(api, player, event.npcId, page, variant);
      return;
    }

    const chatHead = LEGACY_NPC_CHAT_HEAD.get(event.npcId);
    if (chatHead === undefined) return;
    syncShadowVarbits(player);
    const variant = selectVariant({ npcId: event.npcId, player });
    if (!variant) return;
    event.handled = true;
    startTranscript(api, player, chatHead, PAGE, typeof variant === "string" ? variant : variant.variant);
  }

  function handleUndergroundExit({ player }) {
    if (!player) return;
    const stage = quest.getStage(player);
    if (stage < STAGE_RITUAL_DONE || stage >= STAGE_COMPLETE) return;
    if (helperBits(player) & BIT_TANYA) return;
    startTranscript(api, player, NpcIdentifiers.MATTHEW, PAGE, "performing-the-ritual-walking-out-of-the-portal");
  }

  function handleAgrithNaarBeforeDeath(event) {
    const npc = event.npc;
    if (!npc || npc.getId?.() !== NpcIdentifiers.AGRITH_NAAR) return;
    const killer = npc.getCombat?.().getKiller?.(false);
    if (!killer || killer.isPlayer?.() !== true) return;
    if (demonNpcs.get(killer) !== npc) return;
    if (silverlightEquipped(killer)) return;
    npc.setHitpoints(DEMON_HP_ON_REGEN);
    killer.sendMessage("Agrith-Naar's wounds close. You must strike the final blow with Silverlight!");
    event.preventDeath = true;
  }

  function handleAgrithNaarDeath(event) {
    const killer = event.killer;
    const npc = event.npc;
    if (!killer?.isPlayer?.() || !npc) return;
    if (demonNpcs.get(killer) !== npc) return;
    demonNpcs.delete(killer);
    convertSilverlightToDarklight(killer);
    setStage(killer, STAGE_KILLED);
    startTranscript(api, killer, NpcIdentifiers.MATTHEW, PAGE, "summoning-agrith-naar-killing-agrith-naar");
  }

  // ============================================================================
  // Session lifecycle
  // ============================================================================

  function handleZoneEnter({ player }) {
    if (!player) return;
    ensureWizardNpcs(player);
    ensureDemon(player);
  }

  /** Re-tracks, or respawns, the fight after a relog. */
  function ensureDemon(player) {
    if (demonNpcs.has(player) || quest.getStage(player) !== STAGE_SUMMONED) return;
    for (const npc of api.getWorld?.().getNpcs?.() ?? []) {
      if (npc?.getId?.() === NpcIdentifiers.AGRITH_NAAR && npc.getOwner?.() === player) {
        demonNpcs.set(player, npc);
        return;
      }
    }
    spawnAgrithNaar(player);
  }

  function handleLogin({ player }) {
    if (!player) return;
    ensureKilnSearchActions();
    refreshQuestList(player);
    syncShadowVarbits(player);
    ensureWizardNpcs(player);
    ensureDemon(player);
  }

  function handleBootstrapComplete({ player }) {
    if (!player) return;
    ensureKilnSearchActions();
    syncShadowVarbits(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    removeAllWizards(player);
    removeDemon(player);
  }

  // ============================================================================
  // Journal
  // ============================================================================

  function helperLine(done, doneText, pendingText) {
    return done ? `<str>${doneText}</str>` : pendingText;
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Father Reen sent me to Uzer, where the dark wizard Denath was</str>",
        "<str>trying to summon the demon Agrith-Naar.</str>",
        "<str>Denath was Agrith-Naar all along. With the priests and a clay</str>",
        "<str>golem I summoned him again and slew him with Silverlight, which</str>",
        "<str>became the mighty sword Darklight.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_RITUAL_DONE) {
      const bits = helperBits(player);
      return [
        "<str>Denath was Agrith-Naar all along, and the ritual sent him back</str>",
        "<str>to his own dimension.</str>",
        "",
        "I must gather eight people to summon him again and slay him with",
        "<col=800000>Silverlight</col>. I need a <col=800000>demonic sigil</col> for each helper.",
        helperLine(bits & BIT_DAVE, "Evil Dave will return to the throne room.", "I must convince <col=800000>Evil Dave</col> to return."),
        helperLine(bits & BIT_BADDEN, "Father Badden will help.", "Father Badden needs a <col=800000>demonic sigil</col>."),
        helperLine(bits & BIT_REEN, "Father Reen will help.", "Father Reen needs a <col=800000>demonic sigil</col>."),
        helperLine(
          bits & BIT_GOLEM,
          "The clay golem will help.",
          bits & BIT_GOLEM_REPROGRAMMED
            ? "The clay golem needs a <col=800000>demonic sigil</col>."
            : "I should reprogram the <col=800000>clay golem</col> with the <col=800000>strange implement</col>."
        ),
      ];
    }
    if (stage >= STAGE_BOOK_SHOWN) {
      return [
        "<str>I infiltrated Denath's group and made a demonic sigil.</str>",
        "<str>I found Josef's demonic tome and showed it to Matthew.</str>",
        "",
        "I should stand ready for the ritual to summon Agrith-Naar.",
      ];
    }
    if (stage >= STAGE_GOLEM_TOLD) {
      return [
        "<str>I infiltrated Denath's group and made a demonic sigil.</str>",
        "<str>The clay golem told me Josef hid a book in one of the broken</str>",
        "<str>kilns in Uzer.</str>",
        "",
        hasItem(player, DEMONIC_TOME_ITEM_ID)
          ? "I have the <col=800000>demonic tome</col>; I should show it to <col=800000>Matthew</col>."
          : "I should search the <col=800000>broken kilns</col> for the tome.",
      ];
    }
    if (stage >= STAGE_MATTHEW_TOLD) {
      return [
        "<str>I infiltrated Denath's group and made a demonic sigil.</str>",
        "<str>Matthew told me Josef hid a book he had read somewhere in the</str>",
        "<str>ruins, and that the <col=800000>clay golem</col> saw what happened.</str>",
        "",
        "I should ask the <col=800000>clay golem</col> about last night.",
      ];
    }
    if (stage >= STAGE_DENATH_TOLD) {
      return [
        "<str>I infiltrated Denath's group and made a demonic sigil.</str>",
        "<str>Denath taught me the incantation that will summon Agrith-Naar.</str>",
        "",
        "I should get a <col=800000>demonic sigil mould</col> from <col=800000>Jennifer</col>",
        "and speak to <col=800000>Matthew</col>.",
      ];
    }
    if (stage >= STAGE_IN_GROUP) {
      return [
        "<str>Father Badden sent me to infiltrate Denath's group in Uzer.</str>",
        "<str>Evil Dave let me into the demon's throne room.</str>",
        "",
        "I should speak to <col=800000>Denath</col>.",
      ];
    }
    if (stage >= STAGE_INFILTRATE) {
      return [
        "<str>Father Reen told me to help kill the demon Agrith-Naar when</str>",
        "<str>Denath summons it in Uzer.</str>",
        "<str>Father Badden told me to infiltrate the group of dark wizards.</str>",
        "",
        "I need to look evil: wear three black items and dye my",
        "<col=800000>Silverlight</col> black with a <col=800000>black mushroom</col>.",
        "I will need level 30 Crafting to make a demonic sigil.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "<str>Father Reen told me the dark wizard Denath plans to summon</str>",
        "<str>the demon Agrith-Naar in the lost city of Uzer.</str>",
        "",
        "I should take <col=800000>Silverlight</col> and find <col=800000>Father Badden</col>",
        "at the <col=800000>ruins of Uzer</col>.",
      ];
    }
    return [
      "I can start this quest by speaking to <col=800000>Father Reen</col>",
      "south of the <col=800000>Al Kharid</col> bank.",
      "",
      "I must have completed <col=800000>The Golem</col> and <col=800000>Demon Slayer</col>,",
      "and I should be able to defeat a level 100 demon.",
    ];
  }

  function grantReward(player) {
    const skill = chosenSkill(player) ?? Skill.STRENGTH;
    player.getSkillManager().addExperiences(skill, COMBAT_XP);
  }

  /** The broken kilns have no cache option; give them the wiki's "Search". */
  function ensureKilnSearchActions() {
    for (const objectId of KILN_OBJECT_IDS) {
      const definition = ObjectDefinition.forId(objectId);
      if (!definition) continue;
      const actions = definition.getInteractions?.();
      if (Array.isArray(actions) && actions.includes("Search")) continue;
      definition.interactions = ["Search"];
    }
  }

  // ============================================================================
  // Registration
  // ============================================================================

  itemOnGroundManager = api.getItemOnGroundManager();

  quest = registerQuest(api, {
    key: "shadow_of_the_storm",
    name: "Shadow of the Storm",
    varpId: VARP_SHADOW_OF_THE_STORM,
    varbitId: VARBIT_AGRITH_QUEST,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [],
    scrollItemId: DARKLIGHT_ITEM_ID,
    rewardItemLabel: "Darklight",
    buildJournal,
    onReward: grantReward,
  });

  ensureKilnSearchActions();

  api.persistAttribute(HELPERS_ATTRIBUTE);
  api.persistAttribute(KILN_ATTRIBUTE);
  api.persistAttribute(INCANTATION_ATTRIBUTE);
  api.persistAttribute(REWARD_ATTRIBUTE);

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:condition", handleConditionEvent);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:line", fillTranscriptText);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("player:bootstrap-complete", handleBootstrapComplete);
  api.onItemOnObject(handleItemOnObject, { noted: false });
  api.onItemOnObject("Silver bar", "Furnace", smeltDemonicSigil, { noted: false });
  api.onItemOnItem(handleItemOnItem, { noted: false });
  api.onItemOnNpc(handleItemOnNpc);
  api.onObjectInteraction(handleObjectInteraction);
  api.onNpcInteraction(handleNpcInteraction);
  api.onZoneEnter(UNDERGROUND_ZONE, handleZoneEnter);
  api.onZoneExit(UNDERGROUND_ZONE, handleUndergroundExit);
  api.onNpcBeforeDeath(handleAgrithNaarBeforeDeath);
  api.onNpcDeath(handleAgrithNaarDeath);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
