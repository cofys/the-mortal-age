/**
 * Death Plateau (members).
 *
 * The words come from the "Death Plateau" transcript page; this plugin supplies
 * the variant selector for Denulth, Eohric, Harold, Saba, Tenzing, Dunstan and
 * the castle archers (all indexed), the start hook, the prose-condition answers,
 * the item hand-outs keyed off transcript message ids, and the final map +
 * combination hand-in that completes the quest.
 *
 * Stages (varp 314): 10 started, 20 spoken to Eohric, 60 decoded Harold's IOU,
 * 70 Saba's directions, 72 Tenzing's map/boots, 75 Dunstan's spiked boots,
 * 80 complete.
 *
 * Gaps (no dump/index support): reading the IOU item and the stone-ball
 * combination puzzle are not simulated; the IOU message grants the combination
 * directly, and the unimplemented "Enter amount:" gamble resolves at the
 * Gambling interface line as a straight win (the wiki's 60-coin stake). The
 * Transcendent archer detour is not wired.
 */
module.exports = function registerDeathPlateauQuest(api) {
  const { Skill, ItemIdentifiers, NpcIdentifiers } = api.core;
  const { registerQuest, refreshQuestList, getRegisteredQuests } = require("../QuestRuntime");

  const DENULTH_NPC_IDS = new Set([NpcIdentifiers.DENULTH, NpcIdentifiers.DENULTH_2]);
  const EOHRIC_NPC_ID = NpcIdentifiers.EOHRIC;
  const HAROLD_NPC_ID = NpcIdentifiers.HAROLD;
  const SABA_NPC_ID = NpcIdentifiers.SABA;
  const TENZING_NPC_ID = NpcIdentifiers.TENZING;
  const DUNSTAN_NPC_ID = NpcIdentifiers.DUNSTAN;
  const ARCHER_NPC_IDS = new Set([
    NpcIdentifiers.ARCHER_3,
    NpcIdentifiers.ARCHER_4,
    NpcIdentifiers.ARCHER_5,
  ]);

  const VARP_DEATH_PLATEAU = 314;
  const STAGE_STARTED = 10;
  const STAGE_EOHRIC = 20;
  const STAGE_COMBINATION = 60;
  const STAGE_SABA = 70;
  const STAGE_MAP = 72;
  const STAGE_BOOTS = 75;
  const STAGE_COMPLETE = 80;

  const BREAD_ITEM_ID = ItemIdentifiers.BREAD;
  const TROUT_ITEM_ID = ItemIdentifiers.TROUT;
  const IRON_BAR_ITEM_ID = ItemIdentifiers.IRON_BAR;
  const ASGARNIAN_ALE_ITEM_ID = ItemIdentifiers.ASGARNIAN_ALE;
  const BLURBERRY_SPECIAL_ITEM_ID = ItemIdentifiers.BLURBERRY_SPECIAL;
  const COMBINATION_ITEM_ID = ItemIdentifiers.COMBINATION;
  const IOU_ITEM_ID = ItemIdentifiers.IOU;
  const SECRET_WAY_MAP_ITEM_ID = ItemIdentifiers.SECRET_WAY_MAP;
  const CLIMBING_BOOTS_ITEM_ID = ItemIdentifiers.CLIMBING_BOOTS;
  const SPIKED_BOOTS_ITEM_ID = ItemIdentifiers.SPIKED_BOOTS;
  const CERTIFICATE_ITEM_ID = ItemIdentifiers.CERTIFICATE_2;
  const COINS_ITEM_ID = ItemIdentifiers.COINS;

  const START_HOOK = "quest:death-plateau:start";

  const COMPLETE_ACTION_IDS = new Set(["-0mf7N", "IRymYG"]);

  /** Transcript message ids that hand the player a key item (the dump repeats each line). */
  const GIVE_IOU_IDS = new Set(["4p9H2-", "MBm6Sz", "mhKulF", "wAz_jn", "23tpMt"]);
  const GIVE_MAP_IDS = new Set(["yDYvE0", "MtULDz"]);
  const GIVE_CLIMBING_BOOTS_IDS = new Set(["aZ5-DY", "FG69_B"]);
  const GIVE_SPIKED_BOOTS_IDS = new Set(["AuWfYt", "MKP0WU", "1TFYaK", "WryBLk"]);
  const GIVE_CERTIFICATE_IDS = new Set(["KZG0PG", "VuuQKK"]);

  /** Hand-over lines that consume what the transcript says the player gives. */
  const GIVE_ALE_STEP_ID = "_ELP6x";
  const GIVE_BLURBERRY_STEP_ID = "VZS4Rq";
  const GIVE_CERTIFICATE_STEP_ID = "jmuuX8";
  const GIVE_SPIKED_MATERIALS_STEP_ID = "kH8gZk";
  const GIVE_TENZING_BOOTS_STEP_ID = "_ZbFCb";
  const GIVE_TENZING_SUPPLIES_STEP_ID = "JM8S8J";

  /** The transcript's gamble stake (wiki: 60-1000 coins) and its missing interface. */
  const GAMBLE_STAKE = 60;
  const GAMBLING_INTERFACE = "Gambling";
  const TENZING_SUPPLY_AMOUNT = 10;

  let quest;

  const held = (player, itemId, amount = 1) =>
    player.getInventory().getAmount(itemId) >= amount;
  const hasBoots = (player) =>
    held(player, CLIMBING_BOOTS_ITEM_ID) || held(player, SPIKED_BOOTS_ITEM_ID);
  const hasMap = (player) => held(player, SECRET_WAY_MAP_ITEM_ID);
  const hasCombination = (player) => held(player, COMBINATION_ITEM_ID);
  const hasCertificate = (player) => held(player, CERTIFICATE_ITEM_ID);

  /** The IOU is the combination: this plugin hands both over together, idempotently. */
  function giveIou(player) {
    if (!held(player, IOU_ITEM_ID)) player.getInventory().adds(IOU_ITEM_ID, 1);
    if (!held(player, COMBINATION_ITEM_ID)) player.getInventory().adds(COMBINATION_ITEM_ID, 1);
    if (quest.getStage(player) < STAGE_COMBINATION) quest.setStage(player, STAGE_COMBINATION);
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I found a secret route to Death Plateau.</str>",
        "<str>The Burthorpe Imperial Guard can use the route.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_BOOTS) {
      return [
        "I have the map and Harold's combination.",
        "I should report back to <col=800000>Denulth</col>.",
      ];
    }
    if (stage >= STAGE_SABA) {
      return [
        "Tenzing showed me the secret route.",
        "I need <col=800000>Dunstan</col> to add spikes to the climbing boots.",
      ];
    }
    if (stage >= STAGE_COMBINATION) {
      return [
        "I decoded Harold's gambling IOU.",
        "I should ask <col=800000>Saba</col> about another route.",
      ];
    }
    if (stage >= STAGE_EOHRIC) {
      return [
        "Harold may know how the trolls reach the plateau.",
        "He drinks in the <col=800000>Toad and Chicken</col> in Burthorpe.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "<col=800000>Denulth</col> needs a secret route to Death Plateau.",
        "I should speak to <col=800000>Eohric</col> in Burthorpe Castle.",
      ];
    }
    return [
      "I can start this quest by speaking to",
      "<col=800000>Denulth</col> in the Burthorpe training camp.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.ATTACK, 3000);
  }

  /** Denulth, Tenzing and Dunstan also front Troll Stronghold once Death Plateau is done. */
  function trollStrongholdActive(player) {
    const trollStronghold = getRegisteredQuests().find((entry) => entry.key === "troll_stronghold");
    return Boolean(trollStronghold && trollStronghold.isStarted(player) && !trollStronghold.isComplete(player));
  }

  function sharedWithTrollStronghold(npcId) {
    return DENULTH_NPC_IDS.has(npcId) || npcId === TENZING_NPC_ID || npcId === DUNSTAN_NPC_ID;
  }

  /** Which transcript variant each speaker plays, by quest stage. */
  function selectVariant({ npcId, player }) {
    const stage = quest.getStage(player);
    if (sharedWithTrollStronghold(npcId) && (quest.isComplete(player) || trollStrongholdActive(player))) {
      return null;
    }
    if (DENULTH_NPC_IDS.has(npcId)) {
      if (stage === 0) return "getting-started-talking-to-denulth";
      if (stage < STAGE_STARTED) return "getting-started-talking-to-denulth-again";
      if (stage >= STAGE_BOOTS) {
        if (hasMap(player) && hasCombination(player)) {
          return "finishing-up-talking-to-denulth-after-opening-the-equipment-room-and-exploring-the-path";
        }
        if (hasMap(player)) {
          return "finishing-up-talking-to-denulth-after-giving-him-the-map-but-not-the-combination";
        }
        if (hasCombination(player)) {
          return "finishing-up-talking-to-denulth-after-giving-him-the-combination-but-not-the-map";
        }
        return "new-route-up-death-plateau-talking-to-denulth-after-talking-to-dunstan";
      }
      if (stage >= STAGE_MAP && !hasCertificate(player)) {
        return "new-route-up-death-plateau-talking-to-denulth-after-talking-to-dunstan";
      }
      return "new-route-up-death-plateau-talking-to-denulth-after-opening-the-equipment-room";
    }
    if (npcId === EOHRIC_NPC_ID) {
      if (stage === STAGE_STARTED) quest.setStage(player, STAGE_EOHRIC);
      if (stage >= STAGE_COMBINATION) {
        return "finding-the-combination-talking-to-eohric-after-opening-the-equipment-room";
      }
      if (stage >= STAGE_EOHRIC) return "finding-the-combination-talking-to-eohric-after-talking-to-harold";
      return "finding-the-combination-talking-to-eohric";
    }
    if (npcId === HAROLD_NPC_ID) {
      if (stage >= STAGE_COMBINATION) return "finding-the-combination-talking-to-harold-after-losing-the-iou";
      // After Eohric's hint Harold asks for the Asgarnian ale straight away. The
      // pre-hint "talking-to-harold" page option jumps "below" into the later
      // Blurberry branch, so the ale route is only reachable through this variant.
      if (stage >= STAGE_EOHRIC) return "finding-the-combination-talking-to-harold-after-learning-his-weakness";
      return "finding-the-combination-talking-to-harold-again";
    }
    if (npcId === SABA_NPC_ID) {
      if (stage === STAGE_COMBINATION) quest.setStage(player, STAGE_SABA);
      if (stage >= STAGE_SABA) return "new-route-up-death-plateau-talking-to-saba-after-getting-the-map";
      if (stage >= STAGE_COMBINATION) return "new-route-up-death-plateau-talking-to-saba";
      return "new-route-up-death-plateau-talking-to-saba-before-visiting-tenzing";
    }
    if (npcId === TENZING_NPC_ID) {
      if (hasMap(player)) return "new-route-up-death-plateau-talking-to-tenzing-while-holding-the-map";
      if (stage >= STAGE_SABA) {
        if (!hasBoots(player)) return "new-route-up-death-plateau-talking-to-tenzing";
        return "new-route-up-death-plateau-talking-to-tenzing-while-holding-climbing-or-spiked-boots";
      }
      return "new-route-up-death-plateau-talking-to-tenzing-before-fixing-the-boots";
    }
    if (npcId === DUNSTAN_NPC_ID) {
      if (stage >= STAGE_BOOTS) return "new-route-up-death-plateau-talking-to-dunstan-2";
      if (stage >= STAGE_SABA) {
        if (!hasBoots(player)) return "new-route-up-death-plateau-talking-to-dunstan";
        if (hasCertificate(player)) return "new-route-up-death-plateau-talking-to-dunstan-while-holding-the-certificate";
        return "new-route-up-death-plateau-talking-to-dunstan-again";
      }
      return "new-route-up-death-plateau-talking-to-dunstan";
    }
    if (ARCHER_NPC_IDS.has(npcId)) {
      return "finding-the-combination-talking-to-archer-upstairs-in-the-equipment-room";
    }
    return null;
  }

  /** Answer the page's prose conditions. */
  function answerCondition({ player, npcId, text }) {
    // Same shared speakers as selectVariant: once Troll Stronghold owns them, its conditions are not ours.
    if (sharedWithTrollStronghold(npcId) && (quest.isComplete(player) || trollStrongholdActive(player))) {
      return null;
    }
    const value = String(text).toLowerCase();
    const has = (itemId, amount = 1) => held(player, itemId, amount);
    if (value.includes("does not have an asgarnian ale")) return !has(ASGARNIAN_ALE_ITEM_ID);
    if (value.includes("has an asgarnian ale")) return has(ASGARNIAN_ALE_ITEM_ID);
    if (value.includes("does not have a blurberry special")) return !has(BLURBERRY_SPECIAL_ITEM_ID);
    // The gamble's amount dialogue is unimplemented (see handleAction): the plugin
    // stakes the wiki minimum, so the three "enters N" guards never apply.
    if (value.includes("if the player enters 0")) return false;
    if (value.includes("if the player enters more than they are holding")) return false;
    if (value.includes("if the player enters more than 1000")) return false;
    // The plugin's IOU grants the combination, so a held IOU has effectively been read.
    if (value.includes("has not yet read the iou")) return false;
    if (value.includes("has read the iou")) return true;
    if (value.includes("has the boots and an iron bar")) return hasBoots(player) && has(IRON_BAR_ITEM_ID);
    if (value.includes("neither climbing boots nor iron bar"))
      return !hasBoots(player) && !has(IRON_BAR_ITEM_ID);
    if (value.includes("does not have the climbing boots")) return !hasBoots(player);
    if (value.includes("does not have an iron bar")) return !has(IRON_BAR_ITEM_ID);
    if (value.includes("missing spiked boots, bread, and trout"))
      return !has(SPIKED_BOOTS_ITEM_ID) && !has(BREAD_ITEM_ID, TENZING_SUPPLY_AMOUNT) && !has(TROUT_ITEM_ID, TENZING_SUPPLY_AMOUNT);
    if (value.includes("missing spiked boots and bread"))
      return !has(SPIKED_BOOTS_ITEM_ID) && !has(BREAD_ITEM_ID, TENZING_SUPPLY_AMOUNT);
    if (value.includes("missing spiked boots and trout"))
      return !has(SPIKED_BOOTS_ITEM_ID) && !has(TROUT_ITEM_ID, TENZING_SUPPLY_AMOUNT);
    if (value.includes("missing bread and trout"))
      return !has(BREAD_ITEM_ID, TENZING_SUPPLY_AMOUNT) && !has(TROUT_ITEM_ID, TENZING_SUPPLY_AMOUNT);
    if (value.includes("missing spiked boots")) return !has(SPIKED_BOOTS_ITEM_ID);
    if (value.includes("missing bread")) return !has(BREAD_ITEM_ID, TENZING_SUPPLY_AMOUNT);
    if (value.includes("missing trout")) return !has(TROUT_ITEM_ID, TENZING_SUPPLY_AMOUNT);
    if (value.includes("doesn't have the map")) return !hasMap(player);
    if (value.includes("has the map")) return hasMap(player);
    if (value.includes("doesn't have the combination")) return !hasCombination(player);
    if (value.includes("has the combination")) return hasCombination(player);
    if (value.startsWith("If the player has not turned in all the items"))
      return !(hasMap(player) && hasCombination(player));
    if (value.startsWith("If the player has turned in all the items"))
      return hasMap(player) && hasCombination(player);
    return null;
  }

  function handleStartHook({ player, npcId, hook }) {
    if (!DENULTH_NPC_IDS.has(npcId) || hook !== START_HOOK) return;
    if (quest.getStage(player) < STAGE_STARTED) quest.setStage(player, STAGE_STARTED);
  }

  /** Transcript message hand-outs and the final hand-in. */
  function handleAction(request) {
    const { player, npcId, stepId, step, action, target, kind } = request;

    // The wiki "Enter amount:" step has no input dialogue in this server; the
    // gamble is resolved a few lines later, so let the branch carry on.
    if (step?.type === "input") {
      request.handled = true;
      return;
    }
    // No Gambling interface exists: a player covering the minimum stake wins the
    // dice game outright and Harold writes the IOU (which grants the combination).
    if (action === "open_interface" && target === GAMBLING_INTERFACE) {
      if (player.getInventory().getAmount(COINS_ITEM_ID) >= GAMBLE_STAKE) {
        player.getInventory().deleteNumber(COINS_ITEM_ID, GAMBLE_STAKE);
        player.sendMessage("Harold has given you an IOU scribbled on some paper.");
        giveIou(player);
      } else {
        player.sendMessage("You do no have that much money!");
      }
      request.handled = true;
      request.end = true;
      return;
    }
    if (DENULTH_NPC_IDS.has(npcId) && COMPLETE_ACTION_IDS.has(stepId)) {
      if (quest.getStage(player) >= STAGE_BOOTS && hasMap(player) && hasCombination(player)) {
        player.getInventory().deleteNumber(SECRET_WAY_MAP_ITEM_ID, 1);
        player.getInventory().deleteNumber(COMBINATION_ITEM_ID, 1);
        quest.complete(player);
      }
      return;
    }
    // Message steps are emitted twice (an action event and a kind "message" one):
    // consume and hand out only on the message event so nothing runs twice.
    if (kind !== "message") return;
    if (stepId === GIVE_ALE_STEP_ID) {
      player.getInventory().deleteNumber(ASGARNIAN_ALE_ITEM_ID, 1);
      return;
    }
    if (stepId === GIVE_BLURBERRY_STEP_ID) {
      player.getInventory().deleteNumber(BLURBERRY_SPECIAL_ITEM_ID, 1);
      return;
    }
    if (stepId === GIVE_CERTIFICATE_STEP_ID) {
      player.getInventory().deleteNumber(CERTIFICATE_ITEM_ID, 1);
      return;
    }
    if (stepId === GIVE_SPIKED_MATERIALS_STEP_ID) {
      player.getInventory().deleteNumber(IRON_BAR_ITEM_ID, 1);
      player.getInventory().deleteNumber(CLIMBING_BOOTS_ITEM_ID, 1);
      return;
    }
    if (stepId === GIVE_TENZING_BOOTS_STEP_ID) {
      player.getInventory().deleteNumber(SPIKED_BOOTS_ITEM_ID, 1);
      return;
    }
    if (stepId === GIVE_TENZING_SUPPLIES_STEP_ID) {
      player.getInventory().deleteNumber(BREAD_ITEM_ID, TENZING_SUPPLY_AMOUNT);
      player.getInventory().deleteNumber(TROUT_ITEM_ID, TENZING_SUPPLY_AMOUNT);
      return;
    }
    if (GIVE_IOU_IDS.has(stepId)) {
      giveIou(player);
      return;
    }
    if (GIVE_CLIMBING_BOOTS_IDS.has(stepId)) {
      if (!hasBoots(player)) player.getInventory().adds(CLIMBING_BOOTS_ITEM_ID, 1);
      if (quest.getStage(player) < STAGE_MAP) quest.setStage(player, STAGE_MAP);
      return;
    }
    if (GIVE_MAP_IDS.has(stepId)) {
      if (!hasMap(player)) player.getInventory().adds(SECRET_WAY_MAP_ITEM_ID, 1);
      if (quest.getStage(player) < STAGE_MAP) quest.setStage(player, STAGE_MAP);
      return;
    }
    if (GIVE_SPIKED_BOOTS_IDS.has(stepId)) {
      if (!held(player, SPIKED_BOOTS_ITEM_ID)) player.getInventory().adds(SPIKED_BOOTS_ITEM_ID, 1);
      if (quest.getStage(player) < STAGE_BOOTS) quest.setStage(player, STAGE_BOOTS);
      return;
    }
    if (GIVE_CERTIFICATE_IDS.has(stepId)) {
      if (!hasCertificate(player)) player.getInventory().adds(CERTIFICATE_ITEM_ID, 1);
    }
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
  }

  quest = registerQuest(api, {
    key: "death_plateau",
    name: "Death Plateau",
    varpId: VARP_DEATH_PLATEAU,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.ATTACK.getIndex(), amount: 3000, label: "Attack" }],
    rewardItemId: ItemIdentifiers.STEEL_CLAWS,
    rewardItemLabel: "Steel claws",
    otherRewards: ["The ability to make climbing boots and steel claws"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onPlayerLogin(handleLogin);
};
