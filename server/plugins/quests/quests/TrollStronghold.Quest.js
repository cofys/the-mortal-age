/**
 * Troll Stronghold (members).
 *
 * The words come from the "Troll Stronghold" transcript page; this plugin
 * supplies the variant selector for Denulth, Tenzing, Dunstan, Eadgar, Godric,
 * Dad, Twig and Berry (all indexed), the start hook, the prose-condition
 * answers, the prison-key drops and the prison break that completes the quest.
 *
 * Stages (varp 317): 10 started, 20 Dad killed, 30 prison key looted, 40 both
 * cell keys, 45 Godric and Eadgar freed, 50 complete.
 *
 * Requires Death Plateau. Gaps (no dump/index support): the rock climb and
 * Dad's arena fight are not simulated (his death advances the stage) and the
 * Troll Generals are not transcript-indexed (the prison key is granted on any
 * general kill). Dad's arena menu has a missing first option in the dump
 * ("Why are you called Dad?"), so his Talk-to is replayed with that text
 * patched in. Twig and Berry are pickpocketed (30 Thieving) through their
 * transcript variants; the cell doors unlock with Cell key 1 (Godric) and
 * Cell key 2 (Eadgar).
 */
module.exports = function registerTrollStrongholdQuest(api) {
  const { Skill, Location, GameObject, ObjectManager, ItemIdentifiers, NpcIdentifiers, ObjectIdentifiers } = api.core;
  const { registerQuest, refreshQuestList, startTranscript, loadTranscripts } = require("../QuestRuntime");
  const { startDialogue } = require("../../npcs/NpcDialogues.plugin.js");

  const DENULTH_NPC_IDS = new Set([NpcIdentifiers.DENULTH, NpcIdentifiers.DENULTH_2]);
  const TENZING_NPC_ID = NpcIdentifiers.TENZING;
  const DUNSTAN_NPC_ID = NpcIdentifiers.DUNSTAN;
  const EADGAR_NPC_ID = NpcIdentifiers.EADGAR;
  const GODRIC_NPC_ID = NpcIdentifiers.GODRIC;
  const DAD_NPC_ID = NpcIdentifiers.DAD;
  const TWIG_NPC_IDS = new Set([NpcIdentifiers.TWIG_2, NpcIdentifiers.TWIG_3]);
  const BERRY_NPC_IDS = new Set([NpcIdentifiers.BERRY, NpcIdentifiers.BERRY_2]);
  const TROLL_GENERAL_NPC_IDS = new Set([
    NpcIdentifiers.TROLL_GENERAL,
    NpcIdentifiers.TROLL_GENERAL_2,
    NpcIdentifiers.TROLL_GENERAL_3,
  ]);

  const VARP_TROLL_STRONGHOLD = 317;
  const STAGE_STARTED = 10;
  const STAGE_DAD_KILLED = 20;
  const STAGE_HAS_PRISON_KEY = 30;
  const STAGE_HAS_CELL_KEYS = 40;
  const STAGE_GODRIC_FREED = 45;
  const STAGE_COMPLETE = 50;

  const PRISON_KEY_ITEM_ID = ItemIdentifiers.PRISON_KEY;
  const CELL_KEY_1_ITEM_ID = ItemIdentifiers.CELL_KEY_1;
  const CELL_KEY_2_ITEM_ID = ItemIdentifiers.CELL_KEY_2;
  const CLIMBING_BOOTS_ITEM_ID = ItemIdentifiers.CLIMBING_BOOTS;
  const SPIKED_BOOTS_ITEM_ID = ItemIdentifiers.SPIKED_BOOTS;
  const COINS_ITEM_ID = ItemIdentifiers.COINS;

  // Godric's locked cell door (3767) takes Cell key 1, Eadgar's (3765) Cell
  // key 2; unlocking swings the 3764 open door one tile west like the map's
  // other open cells.
  const CELL_DOOR_GODRIC_ID = ObjectIdentifiers.CELL_DOOR_5;
  const CELL_DOOR_EADGAR_ID = ObjectIdentifiers.CELL_DOOR_4;
  const CELL_DOOR_OPEN_ID = ObjectIdentifiers.CELL_DOOR_3;
  const GUARD_THIEVING_LEVEL = 30;

  const GODRIC_FREED_ATTRIBUTE = "troll-stronghold:godric-freed";
  const EADGAR_FREED_ATTRIBUTE = "troll-stronghold:eadgar-freed";

  const PAGE = "Troll Stronghold";
  const TWIG_KEY_VARIANT = "entering-the-prison-retrieving-the-keys-from-twig";
  const BERRY_KEY_VARIANT = "entering-the-prison-retrieving-the-keys-from-berry";
  const FREEING_VARIANT = "entering-the-prison-freeing-eadgar-and-godric";
  const DAD_ARENA_VARIANT = "getting-started-entering-dad-s-arena";
  // The dump lost the first arena option's text ({{topt||Why are you called Dad?}}).
  const DAD_MISSING_OPTION_TEXT = "Why are you called Dad?";

  const START_HOOK = "quest:troll-stronghold:start";
  /** Twig / Berry pocket messages that yield the cell keys. */
  const GIVE_TWIG_KEY_MESSAGE_ID = "UsQIS6";
  const GIVE_BERRY_KEY_MESSAGE_ID = "kUE-LP";
  /** Dunstan's family heirloom ("a Law talisman") ends the quest. */
  const COMPLETE_ACTION_ID = "GT_EpY";

  let quest;

  const held = (player, itemId, amount = 1) =>
    player.getInventory().getAmount(itemId) >= amount;
  const hasBothCellKeys = (player) =>
    held(player, CELL_KEY_1_ITEM_ID) && held(player, CELL_KEY_2_ITEM_ID);
  const agilityLevel = (player) => player.getSkillManager().getCurrentLevel(Skill.AGILITY);
  const godricFreed = (player) => player.getAttribute(GODRIC_FREED_ATTRIBUTE) === true;
  const eadgarFreed = (player) => player.getAttribute(EADGAR_FREED_ATTRIBUTE) === true;

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I entered the Troll Stronghold.</str>",
        "<str>I rescued Godric from the troll prison.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_GODRIC_FREED) {
      return [
        "I have freed <col=800000>Godric</col> and <col=800000>Eadgar</col>.",
        "I should return to <col=800000>Dunstan</col>.",
      ];
    }
    if (stage >= STAGE_HAS_CELL_KEYS) {
      return [
        "I have both cell keys.",
        "I should unlock <col=800000>Godric's</col> and <col=800000>Eadgar's</col> cells.",
      ];
    }
    if (stage >= STAGE_HAS_PRISON_KEY) {
      return [
        "I defeated a Troll General and found the prison key.",
        "I need the two cell keys carried by <col=800000>Twig and Berry</col>.",
      ];
    }
    if (stage >= STAGE_DAD_KILLED) {
      return [
        "I defeated Dad and may enter the stronghold.",
        "I should defeat a <col=800000>Troll General</col> for the prison key.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "Dunstan's son Godric is held in the Troll Stronghold.",
        "I must climb the mountain and defeat <col=800000>Dad</col>.",
      ];
    }
    return [
      "I must complete <col=800000>Death Plateau</col> first.",
      "It also requires 15 Agility.",
      "Speak to <col=800000>Denulth</col> after meeting the requirements.",
    ];
  }

  function grantReward(_player) {
    // Reward item (Law talisman) is granted by registerQuest.
  }

  /** Pockets hold one key each; once both keys and the prison key are held, the stage moves on. */
  function addCellKey(player, itemId) {
    if (!held(player, itemId)) player.getInventory().adds(itemId, 1);
    if (quest.getStage(player) >= STAGE_HAS_CELL_KEYS) return;
    if (held(player, PRISON_KEY_ITEM_ID) && hasBothCellKeys(player)) {
      quest.setStage(player, STAGE_HAS_CELL_KEYS);
    }
  }

  /** After a key/door interaction, stage 45 once both prisoners have been freed. */
  function updateFreedStage(player) {
    if (quest.getStage(player) >= STAGE_GODRIC_FREED) return;
    if (godricFreed(player) && eadgarFreed(player)) quest.setStage(player, STAGE_GODRIC_FREED);
  }

  /** Talking to a prisoner with all three keys frees both cells at once. */
  function freeBothCells(player) {
    player.getInventory().deleteNumber(PRISON_KEY_ITEM_ID, 1);
    player.getInventory().deleteNumber(CELL_KEY_1_ITEM_ID, 1);
    player.getInventory().deleteNumber(CELL_KEY_2_ITEM_ID, 1);
    player.setAttribute(GODRIC_FREED_ATTRIBUTE, true);
    player.setAttribute(EADGAR_FREED_ATTRIBUTE, true);
    player.sendMessage("You unlock the cells and free Godric and Eadgar.");
    updateFreedStage(player);
  }

  /** Wiki: 30 Thieving; the first successful pocket holds the key. */
  function pickpocketGuard(event, keyId, variant) {
    const { player, npcId } = event;
    if (player.getSkillManager().getCurrentLevel(Skill.THIEVING) < GUARD_THIEVING_LEVEL) {
      player.sendMessage(`You need a Thieving level of at least ${GUARD_THIEVING_LEVEL} to do this.`);
      return;
    }
    if (held(player, keyId)) {
      player.sendMessage("You pick the guard's pocket but find nothing.");
      return;
    }
    if (player.getInventory().isFull()) {
      player.getInventory().full();
      return;
    }
    startTranscript(api, player, npcId, PAGE, variant);
  }

  function pickpocketTwig(event) {
    pickpocketGuard(event, CELL_KEY_1_ITEM_ID, TWIG_KEY_VARIANT);
  }

  function pickpocketBerry(event) {
    pickpocketGuard(event, CELL_KEY_2_ITEM_ID, BERRY_KEY_VARIANT);
  }

  /** Swings the locked cell door open into the cell, clearing its blocked tile. */
  function openCellDoor(object) {
    const location = object.getLocation();
    ObjectManager.deregister(object, true);
    ObjectManager.register(
      new GameObject(
        CELL_DOOR_OPEN_ID,
        new Location(location.getX() - 1, location.getY(), location.getZ()),
        object.getType(),
        1,
        object.getPrivateArea() ?? null
      ),
      true
    );
  }

  /** Cell Door "Unlock": key 1 for Godric's cell, key 2 for Eadgar's. */
  function unlockCellDoor(event) {
    const { player, objectId } = event;
    const isGodric = objectId === CELL_DOOR_GODRIC_ID;
    const isEadgar = objectId === CELL_DOOR_EADGAR_ID;
    if (!isGodric && !isEadgar) return false;
    const keyId = isGodric ? CELL_KEY_1_ITEM_ID : CELL_KEY_2_ITEM_ID;
    const otherKeyId = isGodric ? CELL_KEY_2_ITEM_ID : CELL_KEY_1_ITEM_ID;
    const alreadyFreed = isGodric ? godricFreed(player) : eadgarFreed(player);
    const npcId = isGodric ? GODRIC_NPC_ID : EADGAR_NPC_ID;
    const prisoner = isGodric ? "Godric" : "Eadgar";

    if (alreadyFreed) {
      player.sendMessage("You have no need to do this.");
      return true;
    }
    if (!held(player, keyId)) {
      player.sendMessage(held(player, otherKeyId) || held(player, PRISON_KEY_ITEM_ID)
        ? "This key doesn't open this door."
        : "You need a key to unlock this door.");
      return true;
    }
    player.getInventory().deleteNumber(keyId, 1);
    player.setAttribute(isGodric ? GODRIC_FREED_ATTRIBUTE : EADGAR_FREED_ATTRIBUTE, true);
    openCellDoor(event.object);
    player.sendMessage(`You unlock the cell and free ${prisoner}.`);
    updateFreedStage(player);
    startTranscript(api, player, npcId, PAGE, FREEING_VARIANT);
    return true;
  }

  /**
   * The dump's arena menu dropped the first option's text, which makes the
   * multi-option prompt fail to send. Replay the variant with it restored.
   */
  function patchEmptyOptionText(steps) {
    return steps.map((step) => {
      const copy = { ...step };
      if (Array.isArray(copy.options)) {
        copy.options = copy.options.map((option) =>
          typeof option.text === "string" && option.text.trim()
            ? option
            : { ...option, text: DAD_MISSING_OPTION_TEXT }
        );
      }
      if (Array.isArray(copy.steps)) copy.steps = patchEmptyOptionText(copy.steps);
      return copy;
    });
  }

  function talkToDad(event) {
    const { player } = event;
    if (quest.getStage(player) >= STAGE_DAD_KILLED) return false; // after-defeated transcript handles it
    const record = loadTranscripts(api)?.[PAGE];
    const steps = record?.variants?.[DAD_ARENA_VARIANT];
    if (!Array.isArray(steps)) return false;
    startDialogue(api, event, patchEmptyOptionText(steps), record.branches, {
      player, npc: event.npc, npcId: event.npcId, definition: event.definition,
      pages: [{ page: PAGE, variants: [DAD_ARENA_VARIANT] }],
    });
    return true;
  }

  /** Which transcript variant each speaker plays, by quest stage. */
  function selectVariant({ npcId, player }) {
    const stage = quest.getStage(player);
    if (DENULTH_NPC_IDS.has(npcId)) {
      if (stage === 0) return { page: "Troll Stronghold", variant: "getting-started-talking-to-denulth" }; // also on the Death Plateau page
      if (stage < STAGE_STARTED) return "getting-started-talking-to-denulth-after-starting-the-quest";
      if (stage < STAGE_GODRIC_FREED) {
        return "entering-the-prison-talking-to-denulth-again-before-freeing-the-prisoners";
      }
      return "after-freeing-the-prisoners-talking-to-denulth";
    }
    if (npcId === TENZING_NPC_ID) return "getting-started-talking-to-tenzig";
    if (npcId === DUNSTAN_NPC_ID) {
      if (stage >= STAGE_GODRIC_FREED) return "after-freeing-the-prisoners-talking-to-dunstan";
      return "getting-started-talking-to-dunstan";
    }
    if (npcId === DAD_NPC_ID) {
      if (stage >= STAGE_DAD_KILLED) return "getting-started-after-dad-has-been-defeated";
      return DAD_ARENA_VARIANT;
    }
    if (TWIG_NPC_IDS.has(npcId)) return TWIG_KEY_VARIANT;
    if (BERRY_NPC_IDS.has(npcId)) return BERRY_KEY_VARIANT;
    if (npcId === GODRIC_NPC_ID || npcId === EADGAR_NPC_ID) {
      if (stage >= STAGE_HAS_PRISON_KEY && stage < STAGE_GODRIC_FREED && hasBothCellKeys(player)) {
        freeBothCells(player);
      }
      return FREEING_VARIANT;
    }
    return null;
  }

  /** Answer the page's prose conditions. */
  function answerCondition({ player, npcId, text }) {
    const value = String(text).toLowerCase();
    const has = (itemId, amount = 1) => held(player, itemId, amount);
    if (value.includes("combat level is lower than 50")) {
      return player.getSkillManager().getCurrentLevel(Skill.HITPOINTS) < 50;
    }
    if (value.includes("has 12 gp")) return has(COINS_ITEM_ID, 12);
    if (value.includes("does not have enough money")) return !has(COINS_ITEM_ID, 12);
    if (value.includes("does not have level 15 agility")) return agilityLevel(player) < 15;
    if (value.includes("does not have the climbing boots equipped")) {
      return agilityLevel(player) >= 15 && !has(CLIMBING_BOOTS_ITEM_ID) && !has(SPIKED_BOOTS_ITEM_ID);
    }
    if (value.includes("succeeds in climbing up the rocks")) return agilityLevel(player) >= 15;
    if (value.includes("slips whilst climbing up the rocks")) return agilityLevel(player) < 15;
    if (value.includes("attempts to attack dad again")) return true;
    if (value.includes("attempts to talk to dad")) return true;
    if (value.includes("chooses to pickpocket twig") || value.includes("chooses to pickpocket berry")) {
      return true;
    }
    if (value.includes("succeeds in pickpocketing twig")) return true;
    if (value.includes("succeeds in pickpocketing berry")) return true;
    if (value.includes("fails to pickpocket twig") || value.includes("fails to pickpocket berry")) {
      return false;
    }
    if (value.includes("pickpockets twig again") || value.includes("pickpockets berry again")) {
      return false;
    }
    if (value.includes("attempts to open the door without a key")) {
      return !has(PRISON_KEY_ITEM_ID) && !hasBothCellKeys(player) && !godricFreed(player) && !eadgarFreed(player);
    }
    if (value.includes("uses cell key 1 or 2 on either of the doors")) {
      return false; // wrong-key attempts are answered by the door itself
    }
    if (value.includes("opens eadgar's cell with cell key 2")) {
      return npcId === EADGAR_NPC_ID && eadgarFreed(player);
    }
    if (value.includes("opens godric's cell with cell key 1")) {
      return npcId === GODRIC_NPC_ID && godricFreed(player);
    }
    return null;
  }

  function handleStartHook({ player, npcId, hook }) {
    if (!DENULTH_NPC_IDS.has(npcId) || hook !== START_HOOK) return;
    if (quest.getStage(player) < STAGE_STARTED) quest.setStage(player, STAGE_STARTED);
  }

  /** Dad's death opens the stronghold; a Troll General drops the prison key. */
  function handleNpcDeath({ killer, npcId }) {
    if (!killer) return;
    if (npcId === DAD_NPC_ID && quest.getStage(killer) >= STAGE_STARTED) {
      if (quest.getStage(killer) < STAGE_DAD_KILLED) quest.setStage(killer, STAGE_DAD_KILLED);
      return;
    }
    if (TROLL_GENERAL_NPC_IDS.has(npcId) && quest.getStage(killer) >= STAGE_DAD_KILLED) {
      if (quest.getStage(killer) < STAGE_HAS_PRISON_KEY) {
        killer.getInventory().adds(PRISON_KEY_ITEM_ID, 1);
        quest.setStage(killer, STAGE_HAS_PRISON_KEY);
      }
      if (quest.getStage(killer) < STAGE_HAS_CELL_KEYS && hasBothCellKeys(killer)) {
        quest.setStage(killer, STAGE_HAS_CELL_KEYS);
      }
    }
  }

  function handleAction({ player, npcId, stepId }) {
    if (npcId === DUNSTAN_NPC_ID && stepId === COMPLETE_ACTION_ID) {
      if (quest.getStage(player) >= STAGE_GODRIC_FREED && !quest.isComplete(player)) {
        quest.complete(player);
      }
      return;
    }
    if (stepId === GIVE_TWIG_KEY_MESSAGE_ID) {
      addCellKey(player, CELL_KEY_1_ITEM_ID);
      return;
    }
    if (stepId === GIVE_BERRY_KEY_MESSAGE_ID) {
      addCellKey(player, CELL_KEY_2_ITEM_ID);
    }
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
  }

  quest = registerQuest(api, {
    key: "troll_stronghold",
    name: "Troll Stronghold",
    varpId: VARP_TROLL_STRONGHOLD,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [],
    rewardItemId: ItemIdentifiers.LAW_TALISMAN,
    rewardItemLabel: "Law talisman",
    otherRewards: ["Access to the Troll Stronghold"],
    buildJournal,
    onReward: grantReward,
  });

  api.persistAttribute(GODRIC_FREED_ATTRIBUTE);
  api.persistAttribute(EADGAR_FREED_ATTRIBUTE);

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onNpcInteraction("Dad", { "Talk-to": talkToDad });
  api.onNpcInteraction("Twig", { Pickpocket: pickpocketTwig });
  api.onNpcInteraction("Berry", { Pickpocket: pickpocketBerry });
  api.onObjectInteraction("Cell Door", { Unlock: unlockCellDoor });
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onNpcDeath(handleNpcDeath);
  api.onPlayerLogin(handleLogin);
};
