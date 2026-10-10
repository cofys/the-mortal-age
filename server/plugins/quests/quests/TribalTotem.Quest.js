/**
 * Tribal Totem (members).
 *
 * Words come from the "Tribal Totem" transcript page:
 *   Kangai Mau, not started -> getting-started-talking-to-kangai-mau
 *   Kangai Mau, carrying the totem -> returning-back-to-kangai-mau
 *   GPDT employee, crate relabelled -> investigating-the-gpdt-depot-talking-to-gpdt-employee-after-using-the-address-label-on-the-crate
 *   Horacio -> getting-started-talking-to-horacio
 *   Wizard Cromperty -> investigating-the-gpdt-depot-talking-to-wizard-cromperty
 *
 * This plugin supplies the variant selector, the prose-condition answers, the
 * start hook, the totem hand-in (transcript action), the guide-book read and the
 * object chain: the GPDT address label, the relabelled crate, the locked mansion
 * front door, the KURT combination door, the trapped stairs and the upstairs
 * chest.
 *
 * Known gap: the starting branch "I'm in search of adventure!" loops on itself in
 * the imported transcript (the "above" jump resolves back to the same branch), so
 * only the "And what are you doing in Brimhaven?" branch reaches the start prompt.
 */
module.exports = function registerTribalTotemQuest(api) {
  const { Skill, Location, ItemIdentifiers, NpcIdentifiers, ObjectIdentifiers } = api.core;
  const { registerQuest, refreshQuestList } = require("../QuestRuntime");

  const PAGE = "Tribal Totem";
  const VARP_TRIBAL_TOTEM = 200;

  const STAGE_STARTED = 1;
  const STAGE_CRATE_MARKED = 2;
  const STAGE_COMPLETE = 5;

  const START_HOOK = "quest:tribal-totem:start";
  /** Transcript action that ends the "returning back to Kangai Mau" branch. */
  const COMPLETE_ACTION_ID = "WkVGYP";
  /** Transcript action after Cromperty's teleport incantation. */
  const TELEPORT_ACTION_ID = "bCwZ9I";

  const KANGAI_MAU_NPC_ID = NpcIdentifiers.KANGAI_MAU;
  const GPDT_EMPLOYEE_NPC_ID = NpcIdentifiers.GPDT_EMPLOYEE;
  const HORACIO_NPC_ID = NpcIdentifiers.HORACIO;
  const WIZARD_CROMPERTY_NPC_IDS = new Set([
    NpcIdentifiers.WIZARD_CROMPERTY,
    NpcIdentifiers.WIZARD_CROMPERTY_2,
  ]);

  const TRIBAL_TOTEM_ITEM_ID = ItemIdentifiers.TOTEM;
  const ADDRESS_LABEL_ITEM_ID = ItemIdentifiers.ADDRESS_LABEL;
  const GUIDE_BOOK_ITEM_ID = ItemIdentifiers.GUIDE_BOOK;
  const SWORDFISH_ITEM_ID = ItemIdentifiers.SWORDFISH;

  const CRATE_WITH_LABEL_ID = ObjectIdentifiers.CRATE_20; // 2708, north-east GPDT crate
  const CRATE_TARGET_ID = ObjectIdentifiers.CRATE_19; // 2707, the crate two tiles south
  const MANSION_CHEST_ID = ObjectIdentifiers.CHEST_21; // 2709
  const MANSION_DOOR_ID = ObjectIdentifiers.DOOR_100; // 2705, south wall front door
  const COMBINATION_DOOR_ID = ObjectIdentifiers.DOOR_101; // 2706, KURT lock
  const TRAP_STAIRS_ID = ObjectIdentifiers.STAIRS_13; // 2711

  // The same ids are also placed in a second mansion copy around (3340,5945);
  // every handler is pinned to the real Ardougne tiles so that copy is untouched.
  const CRATE_WITH_LABEL_TILE = { x: 2650, y: 3271, z: 0 };
  const CRATE_TARGET_TILE = { x: 2650, y: 3273, z: 0 };
  const MANSION_CHEST_TILE = { x: 2638, y: 3324, z: 1 };
  const MANSION_DOOR_TILE = { x: 2634, y: 3323, z: 0 };
  const COMBINATION_DOOR_TILE = { x: 2635, y: 3321, z: 0 };
  const TRAP_STAIRS_TILE = { x: 2631, y: 3322, z: 0 };
  const TELEPORT_TILE = { x: 2638, y: 3322, z: 0 };
  const SEWER_FALL_TILE = { x: 2566, y: 9641, z: 0 };

  const STAIRS_INVESTIGATED_ATTRIBUTE = "quest.tribal_totem.stairs_investigated";
  const GUIDE_READ_ATTRIBUTE = "quest.tribal_totem.guide_read";

  const page = (variant) => ({ page: PAGE, variant });
  const has = (player, itemId) => player.getInventory().getAmount(itemId) > 0;
  const take = (player, itemId, amount = 1) => player.getInventory().deleteNumber(itemId, amount);
  const actionOf = (event) =>
    String(event.definition?.getInteractions?.()?.[event.clickType - 1] ?? "").toLowerCase();
  const atTile = (location, tile) =>
    location && location.x === tile.x && location.y === tile.y && (tile.z === undefined || location.z === tile.z);

  let quest;

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I recovered the Rantuki tribe's totem from</str>",
        "<str>Lord Handelmort's mansion in Ardougne.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_CRATE_MARKED) {
      return [
        "<str>I relabelled Wizard Cromperty's crate so the GPDT</str>",
        "<str>would deliver it into Handelmort Mansion.</str>",
        "I must get inside and take the <col=800000>tribal totem</col>.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "Kangai Mau asked me to recover the Rantuki tribe's",
        "<col=800000>tribal totem</col> from <col=800000>Lord Handelmort's</col>",
        "mansion in East Ardougne.",
      ];
    }
    return [
      "I can start this quest by speaking to <col=800000>Kangai Mau</col>",
      "in the Shrimp & Parrot in Brimhaven.",
      "",
      "I need level 21 <col=800000>Thieving</col>.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.THIEVING, 1775);
    player.getInventory().adds(SWORDFISH_ITEM_ID, 4);
  }

  function kangaiVariant(player, stage) {
    if (stage >= STAGE_COMPLETE) {
      return { page: "Kangai Mau", variant: "standard-dialogue-after-the-completion-of-the-quest" };
    }
    if (has(player, TRIBAL_TOTEM_ITEM_ID)) return page("returning-back-to-kangai-mau");
    return page("getting-started-talking-to-kangai-mau");
  }

  /** Which transcript variant the clicked NPC plays. */
  function selectVariant({ npcId, player }) {
    const stage = quest.getStage(player);
    if (npcId === KANGAI_MAU_NPC_ID) return kangaiVariant(player, stage);
    if (npcId === GPDT_EMPLOYEE_NPC_ID) {
      return page(
        stage >= STAGE_CRATE_MARKED
          ? "investigating-the-gpdt-depot-talking-to-gpdt-employee-after-using-the-address-label-on-the-crate"
          : "investigating-the-gpdt-depot-talking-to-a-gpdt-employee"
      );
    }
    if (npcId === HORACIO_NPC_ID) return page("getting-started-talking-to-horacio");
    if (WIZARD_CROMPERTY_NPC_IDS.has(npcId)) {
      return page("investigating-the-gpdt-depot-talking-to-wizard-cromperty");
    }
    return null;
  }

  /** Answer the page's prose conditions. */
  function answerCondition({ player, text }) {
    const value = String(text).toLowerCase();
    if (value.includes("does not have the totem")) return !has(player, TRIBAL_TOTEM_ITEM_ID);
    if (value.includes("has the totem")) return has(player, TRIBAL_TOTEM_ITEM_ID);
    return null;
  }

  function handleStartHook({ player, npcId, hook }) {
    if (npcId !== KANGAI_MAU_NPC_ID || hook !== START_HOOK) return;
    if (quest.getStage(player) < STAGE_STARTED) quest.setStage(player, STAGE_STARTED);
  }

  /** The transcript's "Quest complete!" action consumes the totem and finishes. */
  function handleAction(event) {
    const { player, npcId, stepId } = event;
    if (stepId === TELEPORT_ACTION_ID && WIZARD_CROMPERTY_NPC_IDS.has(npcId)) {
      player.moveTo(new Location(TELEPORT_TILE.x, TELEPORT_TILE.y, TELEPORT_TILE.z));
      player.sendMessage("You find yourself inside Handelmort Mansion.");
      event.handled = true;
      return;
    }
    if (npcId !== KANGAI_MAU_NPC_ID || stepId !== COMPLETE_ACTION_ID) return;
    if (quest.isComplete(player)) return;
    if (has(player, TRIBAL_TOTEM_ITEM_ID)) take(player, TRIBAL_TOTEM_ITEM_ID);
    quest.complete(player);
  }

  /** The north-east GPDT crate holds the address label. */
  function investigateCrate(event) {
    if (event.objectId !== CRATE_WITH_LABEL_ID || !atTile(event.location, CRATE_WITH_LABEL_TILE)) return;
    if (!actionOf(event).includes("investigate")) return;
    event.handled = true;
    if (quest.getStage(event.player) < STAGE_STARTED) return;
    if (has(event.player, ADDRESS_LABEL_ITEM_ID)) {
      event.player.sendMessage("You search the crate but find nothing else.");
      return;
    }
    event.player.getInventory().adds(ADDRESS_LABEL_ITEM_ID, 1);
    event.player.sendMessage("You find a delivery label addressed to Lord Handelmort.");
  }

  /** Using the address label on Cromperty's crate relabels it for delivery. */
  function relabelCrate(event) {
    const { player } = event;
    if (event.itemId !== ADDRESS_LABEL_ITEM_ID || event.objectId !== CRATE_TARGET_ID) return;
    if (!atTile(event.location, CRATE_TARGET_TILE)) return;
    if (quest.getStage(player) < STAGE_STARTED || !has(player, ADDRESS_LABEL_ITEM_ID)) return;
    take(player, ADDRESS_LABEL_ITEM_ID);
    quest.setStage(player, STAGE_CRATE_MARKED);
    player.sendMessage("You carefully place the delivery address label over the existing label, covering it completely.");
    player.sendMessage("Now I just need someone to deliver it for me.");
    event.handled = true;
  }

  /**
   * The front door is securely locked from the outside until Cromperty teleports
   * the player in; the Doors plugin would otherwise swing it open for free.
   */
  function lockMansionDoor(request) {
    if (request.objectId !== MANSION_DOOR_ID) return;
    if (!atTile(request.location, MANSION_DOOR_TILE)) return;
    if (request.player.getLocation().getY() <= MANSION_DOOR_TILE.y) return;
    request.player.sendMessage("This door is securely locked.");
    request.handled = true;
  }

  /**
   * The inner door is opened with the KURT combination; there is no keypad
   * interface, so the guide book stands in for entering the combination.
   */
  function openCombinationDoor(event) {
    if (event.objectId !== COMBINATION_DOOR_ID || !atTile(event.location, COMBINATION_DOOR_TILE)) return;
    if (!actionOf(event).includes("open")) return;
    event.handled = true;
    event.player.sendMessage(
      Number(event.player.getAttribute(GUIDE_READ_ATTRIBUTE)) === 1
        ? "The combination seems correct!"
        : "This combination is incorrect."
    );
  }

  /** Investigating the stairs reveals the trap; climbing before that drops you. */
  function investigateStairs(event) {
    if (event.objectId !== TRAP_STAIRS_ID || !atTile(event.location, TRAP_STAIRS_TILE)) return;
    if (!actionOf(event).includes("investigate")) return;
    event.player.setAttribute(STAIRS_INVESTIGATED_ATTRIBUTE, 1);
    event.player.sendMessage(
      "Your trained senses as a thief enable you to see that there is a trap in these stairs. " +
        "You make a note of its location for future reference when using these stairs."
    );
    event.handled = true;
  }

  /** Claim the Climb-up of the trapped stairs before the generic ladder handler. */
  function claimTrapStairs(request) {
    if (request.handled || request.objectId !== TRAP_STAIRS_ID) return;
    const location = request.object?.getLocation?.();
    if (!location || location.getX() !== TRAP_STAIRS_TILE.x || location.getY() !== TRAP_STAIRS_TILE.y) return;
    if (Number(request.player.getAttribute(STAIRS_INVESTIGATED_ATTRIBUTE)) === 1) return;
    request.player.sendMessage("As you climb the stairs you hear a click...");
    request.player.sendMessage("You have fallen through a trap!");
    request.player.moveTo(new Location(SEWER_FALL_TILE.x, SEWER_FALL_TILE.y, SEWER_FALL_TILE.z));
    request.handled = true;
  }

  /** The upstairs chest holds the totem. */
  function openMansionChest(event) {
    if (event.objectId !== MANSION_CHEST_ID || !atTile(event.location, MANSION_CHEST_TILE)) return;
    const option = actionOf(event);
    if (!option.includes("open") && !option.includes("search")) return;
    if (quest.getStage(event.player) < STAGE_CRATE_MARKED) return;
    event.handled = true;
    const player = event.player;
    if (quest.isComplete(player) || has(player, TRIBAL_TOTEM_ITEM_ID)) {
      player.sendMessage("The chest is empty.");
      return;
    }
    player.getInventory().adds(TRIBAL_TOTEM_ITEM_ID, 1);
    player.sendMessage("You open the chest.");
    player.sendMessage("Inside the chest you find the tribal totem.");
  }

  function readGuideBook(event) {
    if (event.itemId !== GUIDE_BOOK_ITEM_ID) return;
    if (!String(event.option ?? "").toLowerCase().includes("read")) return;
    event.player.setAttribute(GUIDE_READ_ATTRIBUTE, 1);
    event.player.sendMessage("The guide lists the owner as Lord Francis Kurt Handelmort.");
    event.handled = true;
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
  }

  quest = registerQuest(api, {
    key: "tribal_totem",
    name: "Tribal Totem",
    varpId: VARP_TRIBAL_TOTEM,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.THIEVING.getIndex(), amount: 1775, label: "Thieving" }],
    rewardItemId: SWORDFISH_ITEM_ID,
    rewardItemLabel: "5 Swordfish",
    buildJournal,
    onReward: grantReward,
  });

  api.persistAttribute(STAIRS_INVESTIGATED_ATTRIBUTE);
  api.persistAttribute(GUIDE_READ_ATTRIBUTE);
  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("door:toggle", lockMansionDoor);
  api.onCustomEvent("ladders:climb", claimTrapStairs);
  api.onObjectInteraction(investigateCrate);
  api.onObjectInteraction(openCombinationDoor);
  api.onObjectInteraction(investigateStairs);
  api.onObjectInteraction(openMansionChest);
  api.onItemOnObject(relabelCrate, { noted: false });
  api.onItemAction(readGuideBook);
  api.onPlayerLogin(handleLogin);
};
