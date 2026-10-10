/**
 * X Marks the Spot (free-to-play; the wiki infobox says Members = No, despite the stub header).
 *
 * The words come from the "X Marks the Spot" transcript page (npc-dialogues.json).
 * Veos is played by the plain visible cache id 8484 (VEOS, "veos_visible") at both
 * the Sheared Ram and the Port Sarim dock while the quest runs, and by 10723
 * (VEOS_4, "veos_visible_amulet") at Port Sarim after the quest, when he wears the
 * casket's amulet. npc-spawns.json's three Veos entries (1063/2147/8632) do not
 * resolve in this cache revision (name "null", no options), so they are unusable;
 * this plugin spawns ownerOnly copies at the cache positions instead.
 *
 * Stages (varp 2111 "cluequest_main", varbit 8063 "cluequest" bits 0-5, from
 * `scripts/lookup-gameval.ts varbit cluequest`): 1 first clue scroll received, 2 second
 * (map) scroll, 3 mysterious orb, 4 third (cipher) scroll, 5 ancient casket dug up,
 * 6 complete. The wiki does not publish numeric stage values; the ordering is the
 * transcript's clue order (variants "after-receiving-the-first..fourth-clue") and the
 * cache item chain 23067 -> 23068 -> 23069 -> 23070 -> 23071, lamp 23072.
 *
 * Dig spots (OSRS Wiki "Map:X Marks the Spot" pins): 3230,3210 (Bob's Brilliant Axes
 * window), 3203,3212 (Lumbridge Castle kitchen), 3108,3264 (Draynor jail / 4 north of
 * Leela's bush), 3077,3260 (Draynor pig pen). The "Dig" option is matched by item name
 * "Spade" (952); the Eastfloor spade (27873) has a different name, and 953/13876 have
 * no Dig option, so the wiki's "Eastfloor spade does not work" holds.
 *
 * Rewards per the OSRS Wiki: 1 Quest point, 200 coins, an antique lamp (23072) for
 * 300 XP in a chosen skill, and a beginner scroll box (24361).
 *
 * Gaps/approximations:
 *  - "has visited Great Kourend before" is answered from varbit 4897
 *    (zeah_playerhasvisited); no travel script in this server sets it, so the
 *    first-time wording always plays in practice.
 *  - No Great Kourend travel: post-quest Veos plays the travel small talk but the
 *    travel ids/options (8630/10724, Port Piscarilius/Land's End) are not spawned.
 *  - The mysterious orb's Feel/hot-cold readings and the Step-2 map scroll's Read
 *    (an image interface) are not implemented; 23067/23070 Read show the wiki's
 *    published clue text, 23068 Read does nothing.
 *  - The beginner scroll box and the +1 clue cap are not usable (no clue system);
 *    the box item is still awarded.
 *  - Digging the first three spots only swaps the scroll, with no flavour message
 *    (none exists in any transcript).
 *  - The stage-0 shortcut "I'm looking for a quest." loops: its wiki jump (reference
 *    "above", id yEQ3ts) is resolved by NpcDialogues' resolveJump back into the option's
 *    own body, so Veos' two lines replay until the 100-jump cap closes the chat.
 *    Jump resolution is not plugin-reachable (line/choice events cannot change it);
 *    testers should use "Who are you?" -> "Can I help?". Fix belongs in resolveJump.
 *  - Quests.plugin.js F2P_QUESTS does not list XMarksTheSpot, so it only loads on
 *    members worlds here (shared change needed; this file cannot make it).
 */
module.exports = function registerXMarksTheSpotQuest(api) {
  const { Animation, ItemIdentifiers, NpcIdentifiers } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const VEOS_NPC_ID = NpcIdentifiers.VEOS; // 8484, "veos_visible"
  const VEOS_POST_QUEST_NPC_ID = NpcIdentifiers.VEOS_4; // 10723, "veos_visible_amulet"

  const VARP_X_MARKS = 2111; // "cluequest_main"
  const VARBIT_X_MARKS = 8063; // "cluequest", bits 0-5
  const ZEAH_VISITED_VARBIT = 4897; // "zeah_playerhasvisited"

  const STAGE_FIRST_CLUE = 1;
  const STAGE_SECOND_CLUE = 2;
  const STAGE_THIRD_CLUE = 3;
  const STAGE_FOURTH_CLUE = 4;
  const STAGE_CASKET = 5;
  const STAGE_COMPLETE = 6;

  const TREASURE_SCROLL_1 = ItemIdentifiers.TREASURE_SCROLL; // 23067
  const TREASURE_SCROLL_2 = ItemIdentifiers.TREASURE_SCROLL_2; // 23068
  const MYSTERIOUS_ORB = ItemIdentifiers.MYSTERIOUS_ORB_2; // 23069
  const TREASURE_SCROLL_3 = ItemIdentifiers.TREASURE_SCROLL_3; // 23070
  const ANCIENT_CASKET = ItemIdentifiers.ANCIENT_CASKET; // 23071
  const ANTIQUE_LAMP = ItemIdentifiers.ANTIQUE_LAMP_21; // 23072
  const BEGINNER_SCROLL_BOX = ItemIdentifiers.SCROLL_BOX_BEGINNER_; // 24361
  const SPADE = ItemIdentifiers.SPADE; // 952
  const COINS = ItemIdentifiers.COINS; // 995

  const LAMP_XP = 300;
  const DIG_ANIMATION = 830;

  const PAGE = "X Marks the Spot";
  const FIRST_CLUE_TEXT =
    "Within the town of Lumbridge lives a man named Bob. He walks out of his door and takes 1 step east, 7 steps north, 5 steps west and 1 step south. Once he arrives, he digs a hole and buries his treasure.";
  const CIPHER_TEXT = "ESBZOPS QJH QFO";

  const START_VARIANT_NOT_VISITED = "starting-off-if-the-player-has-not-visited-great-kourend-before";
  const START_VARIANT_VISITED = "starting-off-if-the-player-has-visited-great-kourend-before";
  const RETAKE_SCROLL_VARIANT =
    "starting-off-talking-to-veos-again-if-the-player-previously-did-not-have-inventory-space-for-the-treasure-scroll";
  const LOST_ITEM_VARIANT = "talking-to-veos-after-losing-an-item";
  // "finishing-up" is also a variant on the "Client of Kourend",
  // "Client of Kourend/Historical" and "Dragon Slayer II" pages, all of which the
  // Veos id index lists before X Marks, so it must name its page.
  const FINISHING_VARIANT = { page: PAGE, variant: "finishing-up" };
  const POST_QUEST_VARIANT = "standard-dialogue-at-port-sarim-subsequent-dialogue";
  const CASKET_REFUSAL_VARIANT = "attempting-to-open-the-ancient-casket";
  const LAST_DIG_VARIANT = "digging-the-last-clue";

  const CLUE_VARIANT_BY_STAGE = new Map([
    [STAGE_FIRST_CLUE, "talking-to-veos-after-receiving-the-first-clue"],
    [STAGE_SECOND_CLUE, "talking-to-veos-after-receiving-the-second-clue"],
    [STAGE_THIRD_CLUE, "talking-to-veos-after-receiving-the-third-clue"],
    [STAGE_FOURTH_CLUE, "talking-to-veos-after-receiving-the-fourth-clue"],
  ]);
  const CLUE_ITEM_BY_STAGE = new Map([
    [STAGE_FIRST_CLUE, TREASURE_SCROLL_1],
    [STAGE_SECOND_CLUE, TREASURE_SCROLL_2],
    [STAGE_THIRD_CLUE, MYSTERIOUS_ORB],
    [STAGE_FOURTH_CLUE, TREASURE_SCROLL_3],
  ]);

  // Condition step ids on the "X Marks the Spot" page.
  const NO_SPACE_CONDITION_IDS = new Set(["eWfCON", "mr8wL6", "72KzXR"]);
  // Action/message step ids.
  const RECEIVE_SCROLL_ACTION_ID = "vNA0zu";
  const RECEIVE_SCROLL_MESSAGE_ID = "6c4VUj";
  const LOST_ITEM_MESSAGE_ID = "dwNSh0";
  const HAND_IN_CASKET_MESSAGE_ID = "HSuTNF";
  const COMPLETE_ACTION_ID = "03vD77";

  const AWAITING_SCROLL_ATTRIBUTE = "x-marks-the-spot:awaiting-scroll";

  const LUMBRIDGE_NPC_TILE = { x: 3228, y: 3242 }; // The Sheared Ram (wiki map + npc-spawns)
  const SARIM_NPC_TILE = { x: 3054, y: 3245 }; // northernmost Port Sarim dock

  // Wiki Map:X Marks the Spot pins.
  const DIG_SPOTS = new Map([
    [STAGE_FIRST_CLUE, { x: 3230, y: 3210 }],
    [STAGE_SECOND_CLUE, { x: 3203, y: 3212 }],
    [STAGE_THIRD_CLUE, { x: 3108, y: 3264 }],
    [STAGE_FOURTH_CLUE, { x: 3077, y: 3260 }],
  ]);
  const CASKET_DIG_SPOT = { x: 3077, y: 3260 };

  /** Per-player ownerOnly Veos spawns: { lumbridge?: {npc,id}, sarim?: {npc,id} }. */
  const veosSpawns = new WeakMap();
  const lampPending = new WeakMap();

  let quest;

  const held = (player, itemId) => player.getInventory().getAmount(itemId) > 0;

  const onTile = (player, tile) => {
    const location = player.getLocation();
    return location.getX() === tile.x && location.getY() === tile.y && location.getZ() === 0;
  };

  function awaitingScroll(player) {
    return Number(player.getAttribute(AWAITING_SCROLL_ATTRIBUTE)) === 1;
  }

  function hasVisitedKourend(player) {
    return (player.getPacketSender().getVarbit?.(ZEAH_VISITED_VARBIT) ?? 0) > 0;
  }

  function isLumbridgeNpc(npc) {
    const location = npc?.getLocation?.();
    return location ? location.getX() >= 3150 : null;
  }

  // ==========================================================================
  // Veos spawns
  // ==========================================================================

  function spawnVeos(player, key, npcId, tile) {
    const npc = api.spawnNpc({
      id: npcId,
      x: tile.x,
      y: tile.y,
      z: 0,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (!npc) return;
    const tracked = veosSpawns.get(player) ?? {};
    tracked[key] = { npc, id: npcId };
    veosSpawns.set(player, tracked);
  }

  function reconcileVeos(player, key, wantedId, tile) {
    const tracked = veosSpawns.get(player) ?? {};
    // Store before spawning: spawnVeos mutates the same map.
    veosSpawns.set(player, tracked);
    const current = tracked[key];
    if (current && current.id === wantedId) return;
    if (current) {
      api.removeNpc(current.npc);
      delete tracked[key];
    }
    if (wantedId !== null) spawnVeos(player, key, wantedId, tile);
  }

  /** Lumbridge until the casket is dug up; Port Sarim from the first scroll on. */
  function ensureVeos(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = quest.getStage(player);
    reconcileVeos(
      player,
      "lumbridge",
      stage < STAGE_CASKET ? VEOS_NPC_ID : null,
      LUMBRIDGE_NPC_TILE
    );
    reconcileVeos(
      player,
      "sarim",
      stage >= STAGE_FIRST_CLUE
        ? quest.isComplete(player)
          ? VEOS_POST_QUEST_NPC_ID
          : VEOS_NPC_ID
        : null,
      SARIM_NPC_TILE
    );
  }

  function clearVeos(player) {
    const tracked = veosSpawns.get(player);
    if (!tracked) return;
    for (const entry of Object.values(tracked)) api.removeNpc(entry.npc);
    veosSpawns.delete(player);
  }

  // ==========================================================================
  // Stage / item flow
  // ==========================================================================

  function giveStartScroll(player) {
    if (quest.getStage(player) > 0) return;
    if (player.getInventory().getFreeSlots() < 1) return;
    player.getInventory().adds(TREASURE_SCROLL_1, 1);
    player.setAttribute(AWAITING_SCROLL_ATTRIBUTE, 0);
    quest.setStage(player, STAGE_FIRST_CLUE);
    ensureVeos(player);
  }

  /** The scroll/orb Veos hands back for the stage the player is on. */
  function lostItemId(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_CASKET) return TREASURE_SCROLL_3;
    return CLUE_ITEM_BY_STAGE.get(stage) ?? TREASURE_SCROLL_1;
  }

  function handleAction(event) {
    const { player, npcId, stepId } = event;
    if (npcId !== VEOS_NPC_ID && npcId !== VEOS_POST_QUEST_NPC_ID) return;
    if (stepId === RECEIVE_SCROLL_ACTION_ID) {
      event.handled = true;
      giveStartScroll(player);
      return;
    }
    if (stepId === RECEIVE_SCROLL_MESSAGE_ID) {
      giveStartScroll(player);
      return;
    }
    if (stepId === LOST_ITEM_MESSAGE_ID) {
      event.handled = true;
      const itemId = lostItemId(player);
      const name = itemId === MYSTERIOUS_ORB ? "a mysterious orb" : "a treasure scroll";
      if (!held(player, itemId) && player.getInventory().getFreeSlots() >= 1) {
        player.getInventory().adds(itemId, 1);
      }
      player.sendMessage(`Veos has given you ${name}.`);
      return;
    }
    if (stepId === HAND_IN_CASKET_MESSAGE_ID) {
      if (held(player, ANCIENT_CASKET)) player.getInventory().deleteNumber(ANCIENT_CASKET, 1);
      return;
    }
    if (stepId === COMPLETE_ACTION_ID) {
      event.handled = true;
      // No re-spawn here: the dock Veos swaps to the amulet id on the next login,
      // not while the player is still talking to him.
      if (quest.getStage(player) >= STAGE_CASKET && !quest.isComplete(player)) {
        quest.complete(player);
      }
      return;
    }
  }

  /** Remember a turned-away start so Veos offers the scroll again next time. */
  function handleCondition({ player, npcId, stepId }) {
    if (npcId !== VEOS_NPC_ID && npcId !== VEOS_POST_QUEST_NPC_ID) return;
    if (NO_SPACE_CONDITION_IDS.has(stepId)) {
      player.setAttribute(AWAITING_SCROLL_ATTRIBUTE, 1);
    }
  }

  // ==========================================================================
  // Dialogue
  // ==========================================================================

  function selectVariant({ npcId, player }) {
    if (npcId !== VEOS_NPC_ID && npcId !== VEOS_POST_QUEST_NPC_ID) return null;
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      // Both ids answer, so the dock Veos keeps working until the next login swaps
      // him to the amulet id.
      return POST_QUEST_VARIANT;
    }
    if (stage >= STAGE_CASKET) {
      if (held(player, ANCIENT_CASKET)) return FINISHING_VARIANT;
      if (held(player, TREASURE_SCROLL_3)) return CLUE_VARIANT_BY_STAGE.get(STAGE_FOURTH_CLUE);
      return LOST_ITEM_VARIANT;
    }
    if (stage <= 0) {
      if (awaitingScroll(player)) return RETAKE_SCROLL_VARIANT;
      return hasVisitedKourend(player) ? START_VARIANT_VISITED : START_VARIANT_NOT_VISITED;
    }
    const clueItem = CLUE_ITEM_BY_STAGE.get(stage);
    if (clueItem !== undefined && !held(player, clueItem)) return LOST_ITEM_VARIANT;
    return CLUE_VARIANT_BY_STAGE.get(stage) ?? null;
  }

  function answerCondition({ npcId, npc, player, text }) {
    if (npcId !== VEOS_NPC_ID && npcId !== VEOS_POST_QUEST_NPC_ID) return null;
    const value = String(text).toLowerCase();
    if (value.includes("does not have any free inventory space")) {
      return player.getInventory().getFreeSlots() <= 0;
    }
    if (value.includes("has a free inventory space")) {
      return player.getInventory().getFreeSlots() >= 1;
    }
    if (value.includes("talks to veos in lumbridge")) return isLumbridgeNpc(npc);
    if (value.includes("talks to veos in port sarim")) {
      const lumbridge = isLumbridgeNpc(npc);
      return lumbridge === null ? null : !lumbridge;
    }
    // Travel small talk on the Veos page; this plugin only runs on members worlds.
    if (value.includes("free-to-play world")) return false;
    if (value.includes("members' world")) return true;
    return null;
  }

  /** Fill the wiki's "[player name]" / "[scroll/orb]" placeholders. */
  function fillTranscriptBlanks(request) {
    if (!request?.player || typeof request.text !== "string") return;
    if (request.npcId !== VEOS_NPC_ID && request.npcId !== VEOS_POST_QUEST_NPC_ID) return;
    let text = request.text;
    if (text.includes("[player name]")) {
      text = text.replace(/\[player name\]/gi, String(request.player.getUsername()));
    }
    if (text.includes("[scroll/orb]")) {
      text = text.replace(
        /\[scroll\/orb\]/gi,
        lostItemId(request.player) === MYSTERIOUS_ORB ? "orb" : "scroll"
      );
    }
    if (text !== request.text) request.text = text;
  }

  // ==========================================================================
  // Interactions
  // ==========================================================================

  /** Spade right-click Dig on the four wiki spots. */
  function handleDig(event) {
    if (event.itemId !== SPADE) return false;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_FIRST_CLUE || quest.isComplete(player)) return false;

    const spot = DIG_SPOTS.get(stage);
    if (spot && onTile(player, spot) && held(player, CLUE_ITEM_BY_STAGE.get(stage))) {
      event.handled = true;
      player.performAnimation(new Animation(DIG_ANIMATION));
      player.getInventory().deleteNumber(CLUE_ITEM_BY_STAGE.get(stage), 1);
      if (stage < STAGE_FOURTH_CLUE) {
        player.getInventory().adds(CLUE_ITEM_BY_STAGE.get(stage + 1), 1);
        quest.setStage(player, stage + 1);
        ensureVeos(player);
        return;
      }
      player.getInventory().adds(ANCIENT_CASKET, 1);
      quest.setStage(player, STAGE_CASKET);
      ensureVeos(player);
      startTranscript(api, player, VEOS_NPC_ID, PAGE, LAST_DIG_VARIANT);
      return;
    }
    // Lost casket: dig the pig pen again.
    if (stage === STAGE_CASKET && onTile(player, CASKET_DIG_SPOT) && !held(player, ANCIENT_CASKET)) {
      event.handled = true;
      player.performAnimation(new Animation(DIG_ANIMATION));
      player.getInventory().adds(ANCIENT_CASKET, 1);
      startTranscript(api, player, VEOS_NPC_ID, PAGE, LAST_DIG_VARIANT);
      return;
    }
    return false;
  }

  /** The scrolls' Read; the map scroll (23068) is an image and is left alone. */
  function handleReadScroll(event) {
    if (event.itemId === TREASURE_SCROLL_1) {
      event.player.sendMessage(FIRST_CLUE_TEXT);
      return true;
    }
    if (event.itemId === TREASURE_SCROLL_3) {
      event.player.sendMessage(CIPHER_TEXT);
      return true;
    }
    return false;
  }

  function handleOpenCasket(event) {
    if (event.itemId !== ANCIENT_CASKET) return false;
    const { player } = event;
    if (quest.getStage(player) < STAGE_CASKET || quest.isComplete(player)) return false;
    startTranscript(api, player, VEOS_NPC_ID, PAGE, CASKET_REFUSAL_VARIANT);
    return true;
  }

  /** The quest lamp (23072) rubs through the shared xpreward interface. */
  function handleLampRub(event) {
    if (event.itemId !== ANTIQUE_LAMP) return false;
    const { player, item, slot } = event;
    lampPending.set(player, { item, slot });
    api.emitCustomEvent("xpreward:open", {
      player,
      title: "Choose the stat you wish to be advanced!",
      onConfirm: (skill, name) => confirmLamp(player, item, slot, skill, name),
    });
    return true;
  }

  function confirmLamp(player, item, slot, skill, name) {
    if (lampPending.get(player)?.item !== item) return null;
    lampPending.delete(player);
    const inventory = player.getInventory();
    if (inventory.get(slot) !== item) return null;
    const manager = player.getSkillManager();
    const before = manager.getExperience(skill);
    manager.addExperience(skill, LAMP_XP, false);
    if (manager.getExperience(skill) === before) return null;
    inventory.deleteAtSlot(slot, 1);
    return `You have been awarded ${LAMP_XP} ${name ?? skill.getName()} XP!`;
  }

  // ==========================================================================
  // Login / logout / journal / rewards
  // ==========================================================================

  function handleLogin({ player }) {
    ensureVeos(player);
    refreshQuestList(player);
  }

  function handleLogout({ player }) {
    clearVeos(player);
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I met Veos in The Sheared Ram and agreed to help him</str>",
        "<str>hunt for treasure.</str>",
        "",
        "<str>I followed the treasure scroll's clues and dug up the</str>",
        "<str>ancient casket, then gave it to Veos at Port Sarim.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_CASKET) {
      return [
        "<str>I met Veos in The Sheared Ram and agreed to help him</str>",
        "<str>hunt for treasure.</str>",
        "",
        "<str>I followed the treasure scroll's clues and dug up the</str>",
        "<str>ancient casket.</str>",
        "",
        "I should take the <col=800000>ancient casket</col> to <col=800000>Veos</col> at",
        "the northernmost pier in <col=800000>Port Sarim</col>.",
      ];
    }
    if (stage >= STAGE_FIRST_CLUE) {
      const lines = [
        "<str>I met Veos in The Sheared Ram and agreed to help him</str>",
        "<str>hunt for treasure.</str>",
        "",
      ];
      if (stage === STAGE_FIRST_CLUE) {
        lines.push(
          "The first clue says to dig north of the north-westernmost",
          "window of the house attached to <col=800000>Bob's Brilliant Axes</col>."
        );
      } else if (stage === STAGE_SECOND_CLUE) {
        lines.push(
          "The second clue is a map. I should dig behind",
          "<col=800000>Lumbridge Castle</col>, south-west of the kitchen's",
          "large crate."
        );
      } else if (stage === STAGE_THIRD_CLUE) {
        lines.push(
          "The mysterious orb shows how close the next clue is.",
          "The clue is <col=800000>east of Draynor Village</col>, north-west",
          "of the jail and four steps north of the bush near Leela."
        );
      } else {
        lines.push(
          "The cipher reads <col=800000>ESBZOPS QJH QFO</col>, which means",
          "<col=800000>DRAYNOR PIG PEN</col>. I should dig in the centre of",
          "the pig pen north of Draynor market."
        );
      }
      return lines;
    }
    return [
      "I can start this quest by speaking to <col=800000>Veos</col> in",
      "<col=800000>The Sheared Ram</col> in Lumbridge.",
      "",
      "There aren't any requirements for this quest.",
    ];
  }

  function grantReward(player) {
    // registerQuest adds the first coin; top the stack up to 200.
    player.getInventory().adds(COINS, 199);
    player.getInventory().adds(ANTIQUE_LAMP, 1);
    if (!held(player, BEGINNER_SCROLL_BOX)) player.getInventory().adds(BEGINNER_SCROLL_BOX, 1);
  }

  api.persistAttribute(AWAITING_SCROLL_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "x_marks_the_spot",
    name: "X Marks the Spot",
    varpId: VARP_X_MARKS,
    varbitId: VARBIT_X_MARKS,
    startedValue: STAGE_FIRST_CLUE,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    rewardItemId: COINS,
    rewardItemLabel: "200 Coins",
    otherRewards: ["Antique lamp", "Beginner scroll box"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:line", fillTranscriptBlanks);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:condition", handleCondition);
  api.onItemAction("Spade", { Dig: handleDig });
  api.onItemAction("Treasure scroll", { Read: handleReadScroll });
  api.onItemAction("Ancient casket", { Open: handleOpenCasket });
  api.onItemAction("Antique lamp", { Rub: handleLampRub });
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
