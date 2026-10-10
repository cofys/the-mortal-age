/**
 * The Ides of Milk (free-to-play).
 *
 * The words come from the "The Ides of Milk" transcript page; this plugin supplies
 * the variant selector for Cassius, Gillie Groats, Seth Groats and Duke Horacio,
 * the prose-condition answers, the shelf/book hand-in, the two milk samples, the
 * Duke permit errand, the bull-gate release and the post-quest Gillie rewards.
 *
 * Stage is varbit 20106 ("cowquest", bits 0-6 of varp 5412 "cowquest_main").
 * Evidence: quest DB table 0 row 9645 ("The Ides of Milk", id 212, endstate 22);
 * cache script 4024 (the quest-list varp map) maps row 9645 to a get_varbit 20106,
 * and script 2628 names the bull "Brutus" once varbit 20106 >= 22. No cache script
 * reads the intermediate values, so 1-12 are this plugin's milestone order:
 *
 *   1 started, 2 spoken to both Groatses, 3 book taken, 4 book given (first milk
 *   sample), 5 first sample drunk, 6 second sample obtained (Duke permit task),
 *   7 Duke spoken to, 8 Gillie asks the player to drink, 9 second sample drunk
 *   (bull task), 10 bull released, 11 Brutus killed, 12 Gillie told, 22 complete.
 *
 * Source: OSRS Wiki "The Ides of Milk", "The Ides of Milk/Quick guide" and
 * "Transcript:The Ides of Milk".
 *
 * Gaps (documented approximations):
 * - Brutus' fight is an instance in OSRS. Without instance support the pen gate's
 *   two leaves are deregistered while a bull is out (the Watchtower openGate
 *   pattern) so the pen is walkable, and re-registered as soon as no live quest
 *   bull (15627) remains or a login finds the gate open without one, so the next
 *   release can click the gate again. The gate is tied to the quest bull only: a
 *   live post-quest boss (15626) never keeps it open. The bull (BRUTUS_2, 15627)
 *   spawns owner-only at the boss pin (3263,3297) and is removed on death
 *   (one-time); the post-quest boss (BRUTUS, 15626) clears its skip-respawn flag
 *   so its owner-kept respawn clone keeps it repeatable. The pen is a 37-tile
 *   sliver; a player still inside when the gate closes is stepped out to
 *   (3263,3293).
 * - Brutus' telegraphed special attacks and the "cannot kill you" melee floor are
 *   not reproduced; the spawned NPC uses its cache combat stats.
 * - The milk sample's first drink applies 1 damage only when above 1 Hitpoint; the
 *   wiki's reaction lines play in the follow-up Cassius conversation instead.
 * - Destroying the first sample before tasting is refused with the wiki line, but
 *   the shared DestroyItem plugin owns the first confirmation, so the refusal
 *   shows after Yes and a second attempt lets the item go.
 * - The cowbell amulet's Charge/Ring/Teleport and the lamp's "combat skills only"
 *   restriction are not implemented; the lamp rubs through the shared xpreward
 *   interface, which offers every skill.
 */
module.exports = function registerIdesOfMilkQuest(api) {
  const {
    HitDamage,
    HitMask,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const PAGE = "The Ides of Milk";
  const START_HOOK = "quest:the-ides-of-milk:start";

  const CASSIUS_NPC_ID = NpcIdentifiers.CASSIUS_2; // 15632
  const GILLIE_NPC_ID = NpcIdentifiers.GILLIE_GROATS; // 4628
  const SETH_NPC_ID = NpcIdentifiers.SETH_GROATS; // 1351
  const DUKE_NPC_ID = NpcIdentifiers.DUKE_HORACIO; // 815
  const BULL_NPC_ID = NpcIdentifiers.BULL; // 15625, the pre-reveal "Bull"
  const QUEST_BRUTUS_NPC_ID = NpcIdentifiers.BRUTUS_2; // 15627, the quest fight
  const BOSS_BRUTUS_NPC_ID = NpcIdentifiers.BRUTUS; // 15626, the post-quest boss

  const SHELVES_OBJECT_ID = ObjectIdentifiers.SHELVES_180; // 60785, "Shelves" Search
  // The pen gate's two leaves ("Gate" Release) at the north-east of the cow field.
  const BULL_GATE_LEAVES = [
    { id: ObjectIdentifiers.GATE_319, x: 3263, y: 3294 }, // 60760
    { id: ObjectIdentifiers.GATE_322, x: 3262, y: 3294 }, // 60763
  ];
  const BULL_GATE_OBJECT_IDS = new Set(BULL_GATE_LEAVES.map((leaf) => leaf.id));

  const BOOK_ITEM_ID = ItemIdentifiers.THE_GROATS_PRINCIPLES; // 33126
  const FIRST_SAMPLE_ITEM_ID = ItemIdentifiers.MILK_SAMPLE; // 33128
  const SECOND_SAMPLE_ITEM_ID = ItemIdentifiers.MILK_SAMPLE_3; // 33130
  const COWBELL_AMULET_ITEM_ID = ItemIdentifiers.COWBELL_AMULET; // 33103
  const CHARGED_COWBELL_AMULET_ITEM_ID = ItemIdentifiers.COWBELL_AMULET_2; // 33104
  const MAGIC_LAMP_ITEM_ID = ItemIdentifiers.MAGIC_LAMP; // 33117
  const LAMP_XP = 1000;

  const VARP_COWQUEST = 5412; // "cowquest_main"
  const VARBIT_COWQUEST = 20106; // "cowquest"

  const STAGE_STARTED = 1;
  const STAGE_GROATS = 2;
  const STAGE_BOOK = 3;
  const STAGE_SAMPLE = 4;
  const STAGE_SAMPLED = 5;
  const STAGE_PERMIT = 6;
  const STAGE_DUKE = 7;
  const STAGE_GILLIE_SAMPLE = 8;
  const STAGE_BULL_TASK = 9;
  const STAGE_BULL_RELEASED = 10;
  const STAGE_BRUTUS_DEAD = 11;
  const STAGE_GILLIE_TOLD = 12;
  const STAGE_COMPLETE = 22;

  // Cassius and the Groatses are spawned by the world; Cassius is not in
  // npc-spawns.json, so the plugin places him by the Lumbridge pond.
  const CASSIUS_TILE = { x: 3170, y: 3279, z: 0 };
  const BULL_TILE = { x: 3263, y: 3297, z: 0 }; // wiki boss pin, north of the gate
  const BULL_PEN_RETURN = { x: 3263, y: 3293, z: 0 }; // free tile south of the gate
  const GILLIE_TILE = { x: 3254, y: 3274, z: 0 };
  const GILLIE_TALK_RANGE = 3;

  // Cassius/Seth flags the wiki conditions branch on.
  const SETH_TALKED_ATTRIBUTE = "quest.the_ides_of_milk.seth";
  const GILLIE_TALKED_ATTRIBUTE = "quest.the_ides_of_milk.gillie";
  const REWARD_ATTRIBUTE = "quest.the_ides_of_milk.reward";
  const LAMP_USED_ATTRIBUTE = "quest.the_ides_of_milk.lamp";

  // Condition step ids on the "The Ides of Milk" page.
  const CONDITION_IDS = new Set([
    "nFcTGN", "UGwoXz", "P1dfHS", "iRWhJf", "3dp-G-", "MeCHpF", "g99Opl", "Si4XUQ",
    "aOfzEg", "iVxuGF", "8iIMZ6", "1qWPVz", "Q-sZIb", "mn6454", "wgvV7v", "CltN0x",
    "bo0hmW", "jS5Ned", "gROlcY", "rQeSSv", "m2cjiq", "0MczJn", "eeHo4c",
  ]);

  const DUKE_FINAL_LINE = "Entirely. Completely reasonable.";
  const GILLIE_CONFRONT_PREFIX = "Why don't you go and talk to him about it";

  let quest;
  let bullGateOpened = false;
  let removedGateLeaves = [];

  const bullsByPlayer = new WeakMap();
  const warnedBeforeTasting = new WeakSet();
  const lampPending = new WeakMap();

  const held = (player, itemId) => player.getInventory().getAmount(itemId) > 0;

  function freeSlots(player) {
    const inventory = player.getInventory();
    return typeof inventory.getFreeSlots === "function"
      ? inventory.getFreeSlots()
      : inventory.isFull()
        ? 0
        : 28;
  }

  function grantItem(player, itemId) {
    if (held(player, itemId) || freeSlots(player) < 1) return;
    player.getInventory().adds(itemId, 1);
  }

  function hasAmulet(player) {
    return held(player, COWBELL_AMULET_ITEM_ID) || held(player, CHARGED_COWBELL_AMULET_ITEM_ID);
  }

  function sethTalked(player) {
    return Boolean(player.getAttribute(SETH_TALKED_ATTRIBUTE));
  }

  function gillieTalked(player) {
    return Boolean(player.getAttribute(GILLIE_TALKED_ATTRIBUTE));
  }

  function nearGillie(player) {
    const location = player.getLocation();
    return (
      Math.max(Math.abs(location.getX() - GILLIE_TILE.x), Math.abs(location.getY() - GILLIE_TILE.y)) <=
      GILLIE_TALK_RANGE
    );
  }

  /** Both Groatses spoken to: Cassius' report (and the book) unlock. */
  function advanceToGroats(player) {
    if (sethTalked(player) && gillieTalked(player) && quest.getStage(player) < STAGE_GROATS) {
      quest.setStage(player, STAGE_GROATS);
    }
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Cassius asked me to research the Groats family's milk</str>",
        "<str>methods so he could start a milk empire of his own.</str>",
        "<str>His milk came from the Groats herd and tasted awful, and</str>",
        "<str>I slew the bull Brutus to save Gillie's herd.</str>",
        "<str>Cassius cut ties with me, but Gillie rewarded my help.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage <= 0) {
      return [
        "I can start this quest by speaking to <col=800000>Cassius</col>",
        "by the <col=800000>Lumbridge pond</col>, south of the windmill.",
        "",
        "There are no requirements for this quest.",
      ];
    }
    const lines = [
      "Cassius wants me to learn how the <col=800000>Groats</col> family",
      "make their animals so productive.",
      "",
    ];
    lines.push(
      sethTalked(player)
        ? "<str>I spoke to Seth Groats about his principles.</str>"
        : "I should speak to <col=800000>Seth Groats</col> in the farmhouse north of the cow field."
    );
    lines.push(
      gillieTalked(player)
        ? "<str>I spoke to Gillie Groats about keeping her cows happy.</str>"
        : "I should speak to <col=800000>Gillie Groats</col> in the cow field."
    );
    if (stage >= STAGE_BOOK && stage < STAGE_SAMPLE) {
      lines.push("<str>I found Seth's book of principles on the shelves.</str>");
      lines.push("I should take the <col=800000>book</col> to <col=800000>Cassius</col>.");
    } else if (stage >= STAGE_GROATS && stage < STAGE_BOOK) {
      lines.push("I should search the <col=800000>shelves</col> for Seth's book.");
    }
    if (stage >= STAGE_SAMPLE && stage < STAGE_PERMIT) {
      lines.push("<str>Cassius gave me a sample of his milk to try.</str>");
      if (stage >= STAGE_SAMPLED) lines.push("<str>The milk was awful and made me cough.</str>");
    }
    if (stage >= STAGE_PERMIT && stage < STAGE_DUKE) {
      lines.push("I should take <col=800000>Cassius' sample</col> to the <col=800000>Duke</col>.");
    }
    if (stage >= STAGE_DUKE && stage < STAGE_BULL_TASK) {
      lines.push("<str>The Duke said to speak to Gillie Groats about the permit.</str>");
      lines.push("I should drink the sample in front of <col=800000>Gillie Groats</col>.");
    }
    if (stage >= STAGE_BULL_TASK && stage < STAGE_BULL_RELEASED) {
      lines.push("<str>Gillie asked me to deal with the aggressive bull.</str>");
      lines.push("I should open the <col=800000>gate</col> north-east of Gillie.");
    }
    if (stage >= STAGE_BULL_RELEASED && stage < STAGE_BRUTUS_DEAD) {
      lines.push("<str>I released the bull into the field.</str>");
      lines.push("I should defeat the <col=800000>bull</col>.");
    }
    if (stage >= STAGE_BRUTUS_DEAD && stage < STAGE_COMPLETE) {
      lines.push("<str>I defeated the bull, which turned out to be Brutus.</str>");
      lines.push("I should tell <col=800000>Gillie Groats</col>.");
    }
    if (stage >= STAGE_GILLIE_TOLD) {
      lines.push("<str>Gillie told me to confront Cassius about the bull.</str>");
      lines.push("I should speak to <col=800000>Cassius</col>.");
    }
    return lines;
  }

  /** Which transcript variant each speaker plays, by stage. */
  function selectVariant({ npcId, player }) {
    const stage = quest.getStage(player);
    if (npcId === CASSIUS_NPC_ID) {
      if (stage >= STAGE_COMPLETE) return "post-quest-talking-to-cassius";
      if (stage >= STAGE_BRUTUS_DEAD) return "facing-the-bull-returning-to-cassius";
      if (stage >= STAGE_DUKE) {
        return held(player, SECOND_SAMPLE_ITEM_ID)
          ? "talking-to-the-duke-talking-to-cassius"
          : "returning-to-cassius-talking-to-cassius-again";
      }
      if (stage === STAGE_PERMIT) return "returning-to-cassius-talking-to-cassius-again";
      if (stage === STAGE_SAMPLED) return "returning-to-cassius-after-sampling-the-milk";
      if (stage === STAGE_SAMPLE) {
        return held(player, FIRST_SAMPLE_ITEM_ID)
          ? "returning-to-cassius-talking-to-cassius-before-sampling-the-milk"
          : "returning-to-cassius-reclaiming-the-milk-sample";
      }
      if (stage >= STAGE_GROATS) return "returning-to-cassius";
      if (stage >= STAGE_STARTED) {
        return "starting-off-talking-to-cassius-again-before-talking-to-both-gillie-and-seth";
      }
      return null;
    }
    if (npcId === GILLIE_NPC_ID) {
      if (stage >= STAGE_COMPLETE) return selectPostQuestGillieVariant(player);
      if (stage >= STAGE_GILLIE_TOLD) return "facing-the-bull-talking-to-gillie-again";
      if (stage >= STAGE_BRUTUS_DEAD) return "facing-the-bull-talking-to-gillie";
      if (stage >= STAGE_BULL_TASK) return "talking-to-the-duke-talking-to-gillie-again-2";
      if (stage === STAGE_GILLIE_SAMPLE) return "talking-to-the-duke-talking-to-gillie-again";
      if (stage === STAGE_DUKE) return "talking-to-the-duke-talking-to-gillie";
      if (stage === STAGE_STARTED) return "starting-off-talking-to-gillie";
      return null;
    }
    if (npcId === SETH_NPC_ID) {
      if (stage <= 0 || stage >= STAGE_COMPLETE) return null;
      return sethTalked(player) ? "starting-off-talking-to-seth-again" : "starting-off-talking-to-seth";
    }
    if (npcId === DUKE_NPC_ID) {
      if (stage >= STAGE_COMPLETE) return null;
      if (stage === STAGE_PERMIT) return "talking-to-the-duke";
      if (stage >= STAGE_DUKE) return "talking-to-the-duke-talking-to-the-duke-again";
      return null;
    }
    return null;
  }

  /** Post-quest Gillie: the amulet and lamp hand-outs, and reclaims. */
  function selectPostQuestGillieVariant(player) {
    if (!player.getAttribute(REWARD_ATTRIBUTE)) return "post-quest-talking-to-gillie";
    if (!player.getAttribute(LAMP_USED_ATTRIBUTE) && !held(player, MAGIC_LAMP_ITEM_ID)) {
      return "post-quest-talking-to-gillie-again-if-the-player-doesn-t-have-the-lamp-and-hasn-t-used-it-yet";
    }
    if (!hasAmulet(player)) return "post-quest-talking-to-gillie-without-a-cowbell-amulet";
    return null;
  }

  /** Answer the page's prose conditions (all identified by step id). */
  function answerCondition({ player, stepId }) {
    if (!CONDITION_IDS.has(stepId)) return null;
    if (stepId === "nFcTGN") return false; // no quest speedrunning worlds here
    if (stepId === "UGwoXz") return !sethTalked(player);
    if (stepId === "P1dfHS") return sethTalked(player);
    if (stepId === "iRWhJf") return false; // no ironman mode on this server
    if (stepId === "3dp-G-") return true;
    if (stepId === "MeCHpF") return !sethTalked(player) || held(player, BOOK_ITEM_ID);
    if (stepId === "aOfzEg" || stepId === "8iIMZ6") return !held(player, BOOK_ITEM_ID);
    if (stepId === "iVxuGF") return held(player, BOOK_ITEM_ID);
    if (stepId === "mn6454" || stepId === "jS5Ned") return !held(player, SECOND_SAMPLE_ITEM_ID);
    if (stepId === "bo0hmW" || stepId === "gROlcY") return held(player, SECOND_SAMPLE_ITEM_ID);
    if (stepId === "g99Opl" || stepId === "1qWPVz" || stepId === "wgvV7v") return freeSlots(player) < 1;
    if (stepId === "Si4XUQ" || stepId === "Q-sZIb" || stepId === "CltN0x") return freeSlots(player) >= 1;
    if (stepId === "rQeSSv" || stepId === "m2cjiq" || stepId === "eeHo4c") {
      return player.getInventory().isFull();
    }
    if (stepId === "0MczJn") return !player.getInventory().isFull();
    return null;
  }

  /** Condition branch picked: record the Groats visit and the Gillie agreement. */
  function handleConditionStep({ player, stepId }) {
    if (stepId === "UGwoXz" || stepId === "P1dfHS") {
      player.setAttribute(GILLIE_TALKED_ATTRIBUTE, 1);
      advanceToGroats(player);
      return;
    }
    if (stepId === "iRWhJf" || stepId === "3dp-G-") {
      player.setAttribute(SETH_TALKED_ATTRIBUTE, 1);
      advanceToGroats(player);
      return;
    }
    if (stepId === "gROlcY" && quest.getStage(player) === STAGE_DUKE) {
      quest.setStage(player, STAGE_GILLIE_SAMPLE);
    }
  }

  /** Lines that mark the end of a milestone conversation (no action id exists). */
  function handleDialogueLine({ npcId, player, text }) {
    if (npcId === DUKE_NPC_ID && quest.getStage(player) === STAGE_PERMIT && text === DUKE_FINAL_LINE) {
      quest.setStage(player, STAGE_DUKE);
      return;
    }
    if (
      npcId === GILLIE_NPC_ID &&
      quest.getStage(player) === STAGE_BRUTUS_DEAD &&
      String(text).startsWith(GILLIE_CONFRONT_PREFIX)
    ) {
      quest.setStage(player, STAGE_GILLIE_TOLD);
    }
  }

  function handleStartHook({ player, npcId, hook }) {
    if (npcId !== CASSIUS_NPC_ID || hook !== START_HOOK) return;
    if (quest.getStage(player) === 0) quest.setStage(player, STAGE_STARTED);
  }

  /** The transcript's item/stage side effects, keyed by message/action id. */
  function handleAction(event) {
    const { player, stepId } = event;
    if (stepId === "y7Vpgm") {
      grantItem(player, BOOK_ITEM_ID);
      if (quest.getStage(player) >= STAGE_GROATS && quest.getStage(player) < STAGE_BOOK) {
        quest.setStage(player, STAGE_BOOK);
      }
      return;
    }
    if (stepId === "CPf4Gm") {
      player.getInventory().deleteNumber(BOOK_ITEM_ID, 1);
      return;
    }
    if (stepId === "Z5eNNH") {
      grantItem(player, FIRST_SAMPLE_ITEM_ID);
      if (quest.getStage(player) === STAGE_BOOK) quest.setStage(player, STAGE_SAMPLE);
      return;
    }
    if (stepId === "HHZ-6k") {
      grantItem(player, FIRST_SAMPLE_ITEM_ID);
      return;
    }
    if (stepId === "gAirRb") {
      grantItem(player, SECOND_SAMPLE_ITEM_ID);
      if (quest.getStage(player) === STAGE_SAMPLED) quest.setStage(player, STAGE_PERMIT);
      return;
    }
    if (stepId === "4bCa8j") {
      grantItem(player, SECOND_SAMPLE_ITEM_ID);
      return;
    }
    if (stepId === "mKQNRL" || stepId === "kaznTu") {
      openBullGate();
      spawnBull(player);
      return;
    }
    if (stepId === "K6Gvs6") {
      grantItem(player, COWBELL_AMULET_ITEM_ID);
      player.setAttribute(REWARD_ATTRIBUTE, 1);
      return;
    }
    if (stepId === "YGE9x4" || stepId === "hoJ1qn") {
      grantItem(player, MAGIC_LAMP_ITEM_ID);
      return;
    }
    if (stepId === "2ePb5b") {
      grantItem(player, COWBELL_AMULET_ITEM_ID);
      return;
    }
    if (stepId === "O4owU9") {
      event.handled = true;
      event.end = true;
      if (!quest.isComplete(player) && quest.getStage(player) >= STAGE_BRUTUS_DEAD) {
        quest.complete(player);
      }
      return;
    }
    if (stepId === "9FVdU5") {
      // The 1-damage cough is applied when the sample is drunk, not here.
      event.handled = true;
    }
  }

  /** One milk sample is enough; the bull pair is tracked per player. */
  function spawnBull(player) {
    const tracked = bullsByPlayer.get(player);
    if (tracked && tracked.isRegistered?.() !== false) return;
    const id = quest.isComplete(player) ? BOSS_BRUTUS_NPC_ID : QUEST_BRUTUS_NPC_ID;
    if (hasOwnBull(player, id)) return;
    const npc = api.spawnNpc({
      id,
      x: BULL_TILE.x,
      y: BULL_TILE.y,
      z: BULL_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) bullsByPlayer.set(player, npc);
    if (npc && id === BOSS_BRUTUS_NPC_ID) {
      // Owner spawns skip the default respawn centrally; the post-quest boss
      // wants its owner-kept respawn clone back so it stays repeatable.
      npc.__skipDefaultRespawn = false;
    }
    if (!quest.isComplete(player) && quest.getStage(player) === STAGE_BULL_TASK) {
      quest.setStage(player, STAGE_BULL_RELEASED);
    }
  }

  /** True when the player already has that bull in the world (a boss respawn). */
  function hasOwnBull(player, id) {
    const npcs = api.getWorld()?.getNpcs?.();
    if (!npcs) return false;
    for (const npc of npcs) {
      if (npc?.getId?.() === id && npc.getOwner?.() === player) return true;
    }
    return false;
  }

  /**
   * True while any quest bull (15627) is alive, optionally ignoring one. The gate
   * is tied to the quest bull only: another player's live post-quest boss (15626)
   * must never keep it open.
   */
  function worldHasLiveQuestBull(exclude) {
    const npcs = api.getWorld()?.getNpcs?.();
    if (!npcs) return false;
    for (const npc of npcs) {
      if (npc === exclude) continue;
      if (npc?.getId?.() === QUEST_BRUTUS_NPC_ID) return true;
    }
    return false;
  }

  /** The enclosed sliver north of the gate (flood-filled with the gate shut). */
  function insideBullPen(player) {
    const location = player.getLocation();
    return (
      location.getZ() === 0 &&
      location.getX() >= 3259 &&
      location.getX() <= 3267 &&
      location.getY() >= 3295 &&
      location.getY() <= 3300
    );
  }

  /**
   * Opens the two-leaf pen gate for the released bull: deregistering the leaves
   * clears their clipping so the pen is walkable (Watchtower's openGate pattern).
   * The leaves are kept so the same instances can be re-registered later.
   */
  function openBullGate() {
    if (bullGateOpened) return;
    removedGateLeaves = [];
    let opened = false;
    for (const leaf of BULL_GATE_LEAVES) {
      const object = api.core.MapObjects.get(leaf.id, new Location(leaf.x, leaf.y, 0), null);
      if (!object) continue;
      api.core.ObjectManager.deregister(object, true);
      removedGateLeaves.push(object);
      opened = true;
    }
    if (opened) bullGateOpened = true;
  }

  /**
   * Puts the two gate leaves back through the same MapObjects/ObjectManager path
   * and clears the open flag, so the next release can click the gate again.
   * A player still in the pen is stepped out first (closing would seal it in).
   */
  function closeBullGate(player) {
    if (!bullGateOpened) return;
    if (player && insideBullPen(player)) {
      player.moveTo(new Location(BULL_PEN_RETURN.x, BULL_PEN_RETURN.y, BULL_PEN_RETURN.z));
    }
    for (const object of removedGateLeaves) {
      api.core.ObjectManager.register(object, true);
    }
    removedGateLeaves = [];
    bullGateOpened = false;
  }

  /** Login repair: a release whose quest bull is gone should leave the gate clickable. */
  function restoreBullGateIfIdle(player) {
    if (!bullGateOpened || worldHasLiveQuestBull()) return;
    closeBullGate(player);
  }

  function handleNpcDeath({ killer, npc, npcId }) {
    if (!killer || !npc) return;
    const tracked = bullsByPlayer.get(killer);
    const isTracked = Boolean(tracked && tracked === npc);
    const isBull = npcId === QUEST_BRUTUS_NPC_ID || npcId === BOSS_BRUTUS_NPC_ID;
    if (!isTracked && !isBull) return;
    // The gate is tied to the quest bull only: close it whenever no live quest
    // bull remains, even when the death was untracked (a respawned boss clone) or
    // another player's post-quest boss is still alive.
    if (!worldHasLiveQuestBull(npc)) closeBullGate(killer);
    if (!isTracked) return;
    bullsByPlayer.delete(killer);
    if (npcId !== QUEST_BRUTUS_NPC_ID) {
      // The post-quest boss keeps its default respawn (the clone keeps its owner),
      // so it stays repeatable at the pen.
      return;
    }
    // The quest Brutus is a one-time kill: suppress the default respawn.
    api.removeNpc(npc);
    if (quest.getStage(killer) === STAGE_BULL_RELEASED) {
      quest.setStage(killer, STAGE_BRUTUS_DEAD);
      startTranscript(api, killer, BULL_NPC_ID, PAGE, "facing-the-bull-after-killing-brutus");
    }
  }

  /** The first sample's "that's not good milk" damage (never below 1 Hitpoint). */
  function damageFromSample(player) {
    if (Number(player.getHitpoints?.() ?? 2) <= 1) return;
    player.getCombat().getHitQueue().addPendingDamage([new HitDamage(1, HitMask.GREEN)]);
  }

  function drinkFirstSample(player) {
    if (quest.getStage(player) !== STAGE_SAMPLE) return;
    if (!held(player, FIRST_SAMPLE_ITEM_ID)) return;
    player.getInventory().deleteNumber(FIRST_SAMPLE_ITEM_ID, 1);
    damageFromSample(player);
    quest.setStage(player, STAGE_SAMPLED);
  }

  function drinkSecondSample(player) {
    const stage = quest.getStage(player);
    if (!held(player, SECOND_SAMPLE_ITEM_ID)) return;
    if (stage === STAGE_GILLIE_SAMPLE && nearGillie(player)) {
      player.getInventory().deleteNumber(SECOND_SAMPLE_ITEM_ID, 1);
      quest.setStage(player, STAGE_BULL_TASK);
      startTranscript(api, player, GILLIE_NPC_ID, PAGE, "talking-to-the-duke-drinking-the-second-sample");
      return;
    }
    if (stage === STAGE_GILLIE_SAMPLE) {
      startTranscript(
        api,
        player,
        GILLIE_NPC_ID,
        PAGE,
        "talking-to-the-duke-talking-to-gillie-again-attempting-to-drink-the-sample-while-not-next-to-gillie"
      );
      return;
    }
    if (stage === STAGE_PERMIT || stage === STAGE_DUKE) {
      startTranscript(
        api,
        player,
        CASSIUS_NPC_ID,
        PAGE,
        "returning-to-cassius-attempting-to-drink-the-second-sample"
      );
    }
  }

  function handleItemAction(event) {
    const { player, itemId, option } = event;
    if (itemId === FIRST_SAMPLE_ITEM_ID && option === "Drink") {
      event.handled = true;
      drinkFirstSample(player);
      return;
    }
    if (itemId === SECOND_SAMPLE_ITEM_ID && option === "Drink") {
      event.handled = true;
      drinkSecondSample(player);
      return;
    }
    if (itemId === MAGIC_LAMP_ITEM_ID && option === "Rub") {
      event.handled = true;
      rubLamp(player, event.item, event.slot);
    }
  }

  /** The lamp rubs through the shared stat-advance interface (XpReward.plugin.js). */
  function rubLamp(player, item, slot) {
    lampPending.set(player, item);
    api.emitCustomEvent("xpreward:open", {
      player,
      title: "Choose the stat you wish to be advanced!",
      onConfirm: (skill, name) => confirmLamp(player, item, slot, skill, name),
    });
  }

  function confirmLamp(player, item, slot, skill, name) {
    if (lampPending.get(player) !== item) return null;
    lampPending.delete(player);
    const inventory = player.getInventory();
    if (inventory.get(slot) !== item) return null;
    const manager = player.getSkillManager();
    const before = manager.getExperience(skill);
    manager.addExperience(skill, LAMP_XP, false);
    if (manager.getExperience(skill) === before) return null;
    inventory.deleteAtSlot(slot, 1);
    player.setAttribute(LAMP_USED_ATTRIBUTE, 1);
    return `You have been awarded ${LAMP_XP} ${name ?? skill.getName()} XP!`;
  }

  function searchShelves(player) {
    startTranscript(api, player, SETH_NPC_ID, PAGE, "starting-off-searching-the-shelf");
  }

  function useBullGate(player) {
    const stage = quest.getStage(player);
    if (quest.isComplete(player)) {
      startTranscript(api, player, BULL_NPC_ID, PAGE, "facing-the-bull");
      return;
    }
    if (stage >= STAGE_BRUTUS_DEAD) {
      startTranscript(api, player, BULL_NPC_ID, PAGE, "facing-the-bull-attempting-to-open-the-gate-again");
      return;
    }
    if (stage >= STAGE_BULL_TASK) {
      startTranscript(api, player, BULL_NPC_ID, PAGE, "facing-the-bull");
      return;
    }
    startTranscript(api, player, BULL_NPC_ID, PAGE, "starting-off-attempting-to-release-the-bull-early");
  }

  /**
   * Doors.plugin.js also registers the "Release" gate and emits door:toggle
   * before it acts, so the quest claims the two bull-pen gates there.
   */
  function claimBullGate(request) {
    if (request.handled) return;
    if (!BULL_GATE_OBJECT_IDS.has(request.objectId)) return;
    request.handled = true;
    useBullGate(request.player);
  }

  function handleObjectInteraction(event) {
    if (event.objectId === SHELVES_OBJECT_ID) {
      event.handled = true;
      searchShelves(event.player);
      return;
    }
    if (BULL_GATE_OBJECT_IDS.has(event.objectId)) {
      event.handled = true;
      useBullGate(event.player);
    }
  }

  /**
   * Destroying the first sample before tasting is refused. The shared DestroyItem
   * plugin owns the first policy pass (it opens the confirmation), so the refusal
   * runs on the confirmation re-run; a second attempt lets the item go.
   */
  function handleItemDropPolicy(event) {
    if (event.itemId !== FIRST_SAMPLE_ITEM_ID) return;
    if (quest.getStage(event.player) !== STAGE_SAMPLE) return;
    if (warnedBeforeTasting.has(event.player)) {
      warnedBeforeTasting.delete(event.player);
      return;
    }
    event.handled = true;
    event.dropToGround = false;
    warnedBeforeTasting.add(event.player);
    event.player.sendMessage(
      "Why would you want to destroy such good milk? Do you not wish to taste it?"
    );
  }

  function spawnStaticNpcs() {
    const world = api.getWorld();
    const npcs = world?.getNpcs?.();
    if (npcs) {
      for (const npc of npcs) if (npc?.getId?.() === CASSIUS_NPC_ID) return;
    }
    api.spawnNpc({ id: CASSIUS_NPC_ID, ...CASSIUS_TILE, wanderRadius: 0 });
  }

  function handleLogout({ player }) {
    const bull = bullsByPlayer.get(player);
    if (bull) api.removeNpc(bull);
    bullsByPlayer.delete(player);
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
    restoreBullGateIfIdle(player);
  }

  api.persistAttribute(SETH_TALKED_ATTRIBUTE);
  api.persistAttribute(GILLIE_TALKED_ATTRIBUTE);
  api.persistAttribute(REWARD_ATTRIBUTE);
  api.persistAttribute(LAMP_USED_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "the_ides_of_milk",
    name: "The Ides of Milk",
    varpId: VARP_COWQUEST,
    varbitId: VARBIT_COWQUEST,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [],
    otherRewards: [
      "Access to Brutus, the cow boss",
      "Rewards from Gillie Groats: a cowbell amulet and a magic lamp",
    ],
    buildJournal,
  });

  api.onServerStartup(spawnStaticNpcs);
  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onCustomEvent("npc-dialogue:condition", handleConditionStep);
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  api.onCustomEvent("door:toggle", claimBullGate);
  api.onObjectInteraction(handleObjectInteraction);
  api.onItemAction(handleItemAction);
  api.onItemDropPolicy(handleItemDropPolicy);
  api.onNpcDeath(handleNpcDeath);
  api.onPlayerLogout(handleLogout);
  api.onPlayerLogin(handleLogin);
};
