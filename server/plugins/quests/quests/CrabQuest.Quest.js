/**
 * Crab Quest (members).
 *
 * The words come from the "Crab Quest" transcript page (OSRS Wiki). This plugin
 * supplies the bottle start, the shell hand-in, the string-instrument chain, the
 * crab-hunting investigations, the ceremony and the completion reward.
 *
 * Stages (varbit 15842 "crab_main", varp 5739 bits 0-5; scripts/lookup-gameval.ts
 * varbit crab_main):
 *   0 not started, 1 drank from the bottle / gathering shells, 2 seven shells
 *   handed in / need the string instrument, 3 instrument given / recruiting
 *   leaders, 4 at least six leaders found (the crab offers to wait), 5 all eleven
 *   leaders found, 6 the dance lesson shown (the "crab rave"), 7 ceremony ready,
 *   8 complete.
 *
 * The main beach crab (16471) and the quest scenery (bottle 62439/62440, palms
 * 62470, magic tree 62473, trees 62475, plant 62477, bush 62478) are not placed
 * in this cache's maps or npc-spawns.json, so the crab is an owner-only spawn and
 * the scenery is registered at runtime (the A Ruff Situation pattern). The five
 * Floatsam NPCs (16475-16477) are world spawns and are used as-is.
 *
 * Source: OSRS Wiki "Crab Quest" page, quick guide and transcript; cache ids and
 * the varbit confirmed with scripts/lookup-gameval.ts and CacheDefinitions.
 *
 * Gaps: quest scenery has no map placements, so its tiles are the closest free
 * tiles to the island's known anchors. The wiki "sit down and wait" coax is
 * approximated by investigating a scared tree a second time. Cutscenes play as
 * transcript dialogue with no camera work. The dream/headache (boat and teleport
 * lock) and the shy crab's chest scene are not implemented; the eleven leaders
 * alone advance the ceremony. No post-quest beach-crab variant exists, so a
 * completed player replays "crab-hunting-talking-to-the-crab-again". The Crab
 * dance emote is not unlocked (the dance conditions answer "not unlocked"). The
 * requirement refusal is a plain system message because the transcript has none.
 */
module.exports = function registerCrabQuestQuest(api) {
  const {
    GameObject,
    Item,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectManager,
    Skill,
  } = api.core;
  const { loadTranscripts, registerQuest, refreshQuestList, startTranscript } =
    require("../QuestRuntime");
  const { startDialogue } = require("../../npcs/NpcDialogues.plugin.js");

  const PAGE = "Crab Quest";
  const START_HOOK = "quest:crab-quest:start";

  const STAGE_VARBIT = 15842; // "crab_main"
  const STAGE_NOT_STARTED = 0;
  const STAGE_SHELLS = 1;
  const STAGE_INSTRUMENT = 2;
  const STAGE_RECRUITING = 3;
  const STAGE_SIX_LEADERS = 4;
  const STAGE_ALL_LEADERS = 5;
  const STAGE_DANCE_READY = 6;
  const STAGE_CEREMONY = 7;
  const STAGE_COMPLETE = 8;

  const SAILING_REQUIREMENT = 40;
  const FISHING_REQUIREMENT = 30;
  const WOODCUTTING_LEADER_REQUIREMENT = 75;
  const ALL_LEADER_COUNT = 11;
  const SIX_LEADER_COUNT = 6;
  const REQUIREMENTS_MESSAGE =
    "You need a Sailing level of 40 and a Fishing level of 30 to start this quest.";

  const MAIN_CRAB_NPC_ID = NpcIdentifiers.CRAB_9; // 16471, "Crab", Talk-to
  const PENGUIN_CRAB_NPC_ID = NpcIdentifiers.CRAB_18; // 16485, "'Crab'"
  const CRAB_NPC_IDS = new Set([MAIN_CRAB_NPC_ID, PENGUIN_CRAB_NPC_ID]);
  const FLOATSAM_NPC_IDS = new Set([
    NpcIdentifiers.FLOATSAM, // 16475, "Net"
    NpcIdentifiers.FLOATSAM_2, // 16476
    NpcIdentifiers.FLOATSAM_3, // 16477
  ]);

  // Items from the 2026 quest, absent from the generated ItemIdentifiers.
  const SHELL_ITEM_IDS = [34575, 34576, 34577, 34578, 34579, 34580, 34581];
  const BAD_SHELL_ITEM_IDS = [34582, 34583];
  const ALL_SHELL_ITEM_IDS = [...SHELL_ITEM_IDS, ...BAD_SHELL_ITEM_IDS];
  const SHELL_COUNT = SHELL_ITEM_IDS.length;
  const PLANK_ITEM_ID = 34584; // Weathered rosewood plank
  const BARREL_ITEM_ID = 34585; // Battered barrel
  const BOWSTRING_ITEM_ID = 34586; // Sea-soaked bowstring
  const INSTRUMENT_ITEM_ID = 34587; // Instrument
  const SHELL_COLLECTION_ITEM_ID = 34589; // Shell collection
  const BIG_FISHING_NET_ITEM_ID = ItemIdentifiers.BIG_FISHING_NET; // 305
  const LYRE_ITEM_ID = ItemIdentifiers.LYRE; // 3689
  const ENCHANTED_LYRE_ITEM_IDS = new Set([
    ItemIdentifiers.ENCHANTED_LYRE, // 3690
    ItemIdentifiers.ENCHANTED_LYRE_1_, // 3691
    ItemIdentifiers.ENCHANTED_LYRE_2_, // 6125
    ItemIdentifiers.ENCHANTED_LYRE_3_, // 6126
    ItemIdentifiers.ENCHANTED_LYRE_4_, // 6127
  ]);

  // Objects from the 2026 quest, absent from the generated ObjectIdentifiers.
  const CRAB_BOTTLE_OBJECT_ID = 62439; // "Bottle", Drink
  const CRAB_BOTTLE_POST_OBJECT_ID = 62440; // "Bottle", Reminisce
  const CRAB_PALM_OBJECT_ID = 62470; // "Palm", Investigate
  const CRAB_MAGIC_TREE_OBJECT_ID = 62473; // "Magic tree", Investigate
  const CRAB_TREE_OBJECT_ID = 62475; // "Tree", Investigate
  const CRAB_PLANT_OBJECT_ID = 62477; // "Plant", Investigate
  const CRAB_BUSH_OBJECT_ID = 62478; // "Bush", Investigate

  const BOTTLE_TILE = { x: 3055, y: 2639 };
  const MAIN_CRAB_TILE = { x: 3052, y: 2640 };
  const NET_TILE = { x: 3052, y: 2636 };
  const SHELL_TILES = [
    { x: 3022, y: 2631 },
    { x: 3026, y: 2634 },
    { x: 3031, y: 2633 },
    { x: 3036, y: 2632 },
    { x: 3040, y: 2637 },
    { x: 3047, y: 2631 },
    { x: 3051, y: 2633 },
    { x: 3057, y: 2632 },
    { x: 3060, y: 2634 },
  ];

  // Message step ids that mean "this crab joined the practice" and its bit.
  const JOINED_STEP_BITS = new Map([
    ["5WiO-g", 1 << 0], // magic tree
    ["OrHsAs", 1 << 1], // palm south of the magic tree
    ["uxsvrh", 1 << 2], // quiz tree, "101"
    ["NQTJwM", 1 << 2], // quiz tree, "210"
    ["pyykYg", 1 << 2], // quiz tree, "I don't know"
    ["XBEBvy", 1 << 3], // western-most palm
    ["XffNTB", 1 << 4], // palm directly east
    ["MVf-5E", 1 << 5], // palm directly north-east
    ["yUuVKM", 1 << 6], // northern-most palm ("'Crab'" penguin)
    ["nJXHcW", 1 << 7], // north-western-most tree
    ["ByoUzK", 1 << 8], // plant
    ["UtfH3c", 1 << 9], // western bush
    ["beb_BL", 1 << 10], // eastern bush ("Dipper")
  ]);

  const MAGIC_TREE_STEP = "5WiO-g";
  const DIPPER_STEP = "beb_BL";
  const KID_CRAB_STEP = "ByoUzK";
  const DANCE_BEGINS_STEP = "uZozUI";
  const DANCE_ENDS_STEP = "UOa-Sd";
  const CEREMONY_COMPLETE_STEP = "Wk9imR";
  const SHELL_COLLECTION_MESSAGE_STEP = "Uf9RIo";

  const DISASTER_NAME = "A disaster.";
  const BASS_NAME = "A bass.";
  const BANJO_NAME = "I don't actually know.";
  const PLAY_STYLE_OPTIONS = new Set(["Let me show you!", "I can try and explain.", BANJO_NAME]);

  const DONE_JOINED_VARIANT = "crab-hunting-investigating-a-tree-plant-or-bush-after-the-crab-goes-to-practice";
  const WHILE_OUT_VARIANT = "crab-hunting-investigating-a-tree-plant-or-bush-while-the-crab-is-out";
  const NO_CRAB_TEXT = "No crab is coming out of the tree. Maybe they are too scared?";
  const NEED_NET_TEXT = "You need a big net to gather items from this floatsam.";
  const NO_SPACE_TEXT = "You can't carry any more floatsam.";
  const NOTHING_LEFT_TEXT = "There is nothing left here.";
  const CRAFT_MESSAGE_TEXT = "You fashion a makeshift string instrument out of the flotsam.";
  const SHELL_COLLECTION_RECOVERY_TEXT =
    "As you look at the bottle, you notice familiar shells nearby. You collect them.";
  const NEED_MATERIALS_TEXT =
    "To make a string instrument, you'll also need a sound box to amplify the sound and a frame or fretboard to tense the string.";

  const RECRUITED_ATTRIBUTE = "quest.crab_quest.recruited";
  const SCARED_ATTRIBUTE = "quest.crab_quest.scared";
  const MET_ATTRIBUTE = "quest.crab_quest.met";
  const SHELLS_HANDED_ATTRIBUTE = "quest.crab_quest.shells-handed";
  const SHELLS_PICKED_ATTRIBUTE = "quest.crab_quest.shells-picked";
  const NET_PICKED_ATTRIBUTE = "quest.crab_quest.net-picked";
  const MATERIALS_FISHED_ATTRIBUTE = "quest.crab_quest.materials-fished";
  const INSTRUMENT_MADE_ATTRIBUTE = "quest.crab_quest.instrument-made";
  const INSTRUMENT_NAME_ATTRIBUTE = "quest.crab_quest.instrument-name";
  const MAGIC_TREE_MET_ATTRIBUTE = "quest.crab_quest.magic-tree-met";
  const DIPPER_MET_ATTRIBUTE = "quest.crab_quest.dipper-met";
  const KID_CRAB_MET_ATTRIBUTE = "quest.crab_quest.kid-crab-met";

  // Correct shell item -> the transcript message the crab hands it over with.
  const SHELL_MESSAGE_VARIANTS = new Map([
    [34575, "handing-in-seashells-large-rose-shell"],
    [34576, "handing-in-seashells-black-and-white-shell"],
    [34577, "handing-in-seashells-vivid-orange-shell"],
    [34578, "handing-in-seashells-bright-yellow-shell"],
    [34579, "handing-in-seashells-exotic-looking-shell"],
    [34580, "handing-in-seashells-unassuming-cream-shell"],
    [34581, "handing-in-seashells-tiny-white-shell"],
  ]);
  const SHELL_REACTION_VARIANTS = [
    "handing-in-seashells-first-correct-shell",
    "handing-in-seashells-second-correct-shell",
    "handing-in-seashells-third-correct-shell",
    "handing-in-seashells-fourth-correct-shell",
    "handing-in-seashells-fifth-correct-shell",
    "handing-in-seashells-sixth-correct-shell",
  ];
  const LAST_SHELL_VARIANT = "handing-in-seashells-last-correct-shell";

  const MATERIAL_ITEM_IDS = new Set([PLANK_ITEM_ID, BARREL_ITEM_ID, BOWSTRING_ITEM_ID]);

  /**
   * The fourteen investigation spots. `first` is the "too scared" line (missing
   * when the crab comes straight out), `variant` is the conversation, and
   * `joinBit` marks a spot whose end message recruits a band member.
   */
  const SPOTS = [
    {
      objectId: CRAB_MAGIC_TREE_OBJECT_ID,
      x: 3042,
      y: 2639,
      first: "crab-hunting-investigating-the-magic-tree",
      variant: "crab-hunting-investigating-the-magic-tree-sitting-by-the-magic-tree",
      joinBit: 1 << 0,
    },
    {
      objectId: CRAB_PALM_OBJECT_ID,
      x: 3044,
      y: 2646,
      first: "crab-hunting-investigating-the-palm-south-of-the-magic-tree",
      variant: "crab-hunting-investigating-the-palm-south-of-the-magic-tree-sitting-by-the-palm",
      joinBit: 1 << 1,
    },
    {
      objectId: CRAB_PALM_OBJECT_ID,
      x: 3039,
      y: 2644,
      variant: "crab-hunting-investigating-the-palm-south-west-of-the-magic-tree",
    },
    {
      objectId: CRAB_TREE_OBJECT_ID,
      x: 3034,
      y: 2634,
      first: "crab-hunting-investigating-the-tree-north-west-of-the-magic-tree",
      variant: "crab-hunting-investigating-the-tree-north-west-of-the-magic-tree-sitting-by-the-palm",
      joinBit: 1 << 2,
    },
    {
      objectId: CRAB_PALM_OBJECT_ID,
      x: 3032,
      y: 2648,
      variant: "crab-hunting-investigating-the-western-most-palm",
      joinBit: 1 << 3,
    },
    {
      objectId: CRAB_PALM_OBJECT_ID,
      x: 3038,
      y: 2647,
      variant: "crab-hunting-investigating-the-palm-directly-east-of-the-western-most-palm",
      joinBit: 1 << 4,
    },
    {
      objectId: CRAB_PALM_OBJECT_ID,
      x: 3041,
      y: 2645,
      variant: "crab-hunting-investigating-the-palm-directly-north-east-of-the-western-most-palm",
      joinBit: 1 << 5,
    },
    {
      objectId: CRAB_PALM_OBJECT_ID,
      x: 3054,
      y: 2663,
      variant: "crab-hunting-investigating-the-northern-most-palm",
      joinBit: 1 << 6,
      chathead: PENGUIN_CRAB_NPC_ID,
    },
    {
      objectId: CRAB_PALM_OBJECT_ID,
      x: 3040,
      y: 2636,
      variant: "crab-hunting-investigating-the-palm-directly-north-of-the-magic-tree",
    },
    {
      objectId: CRAB_TREE_OBJECT_ID,
      x: 3028,
      y: 2655,
      first: "crab-hunting-investigating-the-north-western-most-tree",
      variant: "crab-hunting-investigating-the-north-western-most-tree-sitting-by-the-tree",
      joinBit: 1 << 7,
    },
    {
      objectId: CRAB_TREE_OBJECT_ID,
      x: 3063,
      y: 2653,
      first: "crab-hunting-investigating-the-north-eastern-most-tree",
      variant: "crab-hunting-investigating-the-north-eastern-most-tree-sitting-by-the-tree",
    },
    {
      objectId: CRAB_PLANT_OBJECT_ID,
      x: 3053,
      y: 2655,
      variant: "crab-hunting-investigating-the-plant",
      joinBit: 1 << 8,
    },
    {
      objectId: CRAB_BUSH_OBJECT_ID,
      x: 3048,
      y: 2633,
      variant: "crab-hunting-investigating-the-western-bush",
      joinBit: 1 << 9,
    },
    {
      objectId: CRAB_BUSH_OBJECT_ID,
      x: 3058,
      y: 2642,
      variant: "crab-hunting-investigating-the-eastern-bush",
      joinBit: 1 << 10,
    },
  ];

  /** Tracked per-player owner-only spawns, keyed by role. */
  const trackedNpcs = new WeakMap();

  let quest;
  let objectsInstalled = false;

  // ==========================================================================
  // State helpers
  // ==========================================================================

  function flags(player, attribute) {
    return Number(player.getAttribute(attribute)) || 0;
  }

  function hasFlag(player, attribute, bit) {
    return (flags(player, attribute) & bit) !== 0;
  }

  function setFlag(player, attribute, bit) {
    player.setAttribute(attribute, flags(player, attribute) | bit);
  }

  function popcount(mask) {
    let count = 0;
    let value = mask;
    while (value) {
      count += value & 1;
      value >>>= 1;
    }
    return count;
  }

  function hasItem(player, itemId) {
    return player.getInventory().getAmount(itemId) > 0;
  }

  function grantShellCollection(player) {
    player.getInventory().adds(SHELL_COLLECTION_ITEM_ID, 1);
  }

  function hasAnyShell(player) {
    for (const itemId of ALL_SHELL_ITEM_IDS) if (hasItem(player, itemId)) return true;
    return false;
  }

  function shellCount(player) {
    let count = 0;
    for (const itemId of ALL_SHELL_ITEM_IDS) count += player.getInventory().getAmount(itemId);
    return count;
  }

  function handedShellCount(player) {
    return Number(player.getAttribute(SHELLS_HANDED_ATTRIBUTE)) || 0;
  }

  function hasAllMaterials(player) {
    return (
      hasItem(player, PLANK_ITEM_ID) &&
      hasItem(player, BARREL_ITEM_ID) &&
      hasItem(player, BOWSTRING_ITEM_ID)
    );
  }

  function materialsFished(player) {
    return player.getAttribute(MATERIALS_FISHED_ATTRIBUTE) === true;
  }

  function instrumentMade(player) {
    return player.getAttribute(INSTRUMENT_MADE_ATTRIBUTE) === true;
  }

  function instrumentName(player) {
    return player.getAttribute(INSTRUMENT_NAME_ATTRIBUTE) ?? null;
  }

  function leaderCount(player) {
    return popcount(flags(player, RECRUITED_ATTRIBUTE));
  }

  function meetsRequirements(player) {
    const skills = player.getSkillManager();
    return (
      skills.getMaxLevel(Skill.SAILING) >= SAILING_REQUIREMENT &&
      skills.getMaxLevel(Skill.FISHING) >= FISHING_REQUIREMENT
    );
  }

  function setStage(player, stage) {
    if (quest.getStage(player) >= stage) return;
    quest.setStage(player, stage);
    syncNpcs(player);
  }

  function recountLeaders(player) {
    if (quest.isComplete(player)) return;
    const count = leaderCount(player);
    if (count >= ALL_LEADER_COUNT) setStage(player, STAGE_ALL_LEADERS);
    else if (count >= SIX_LEADER_COUNT) setStage(player, STAGE_SIX_LEADERS);
  }

  // ==========================================================================
  // Transcript helpers
  // ==========================================================================

  function transcriptRecord() {
    return loadTranscripts(api)?.[PAGE] ?? null;
  }

  function variantSteps(name) {
    const raw = transcriptRecord()?.variants?.[name];
    return Array.isArray(raw) ? raw : [];
  }

  function conditionSteps(variantName, conditionId) {
    const raw = variantSteps(variantName);
    const found = raw.find((step) => step.type === "condition" && step.id === conditionId);
    return Array.isArray(found?.steps) ? found.steps : [];
  }

  /** Wiki multi-speaker lines -> generic NPC lines so one chathead renders them. */
  function flattenSpeakers(steps) {
    if (!Array.isArray(steps)) return [];
    return steps.map((step) => {
      const copy = { ...step };
      if (copy.type === "line" && typeof copy.speaker === "string") {
        copy.npc = copy.text;
        delete copy.speaker;
      }
      if (Array.isArray(copy.steps)) copy.steps = flattenSpeakers(copy.steps);
      if (Array.isArray(copy.options)) {
        copy.options = copy.options.map((option) => ({
          ...option,
          steps: flattenSpeakers(option.steps),
        }));
      }
      return copy;
    });
  }

  /** Plays a composed list of raw transcript steps with one NPC's chathead. */
  function playSteps(player, npcId, steps) {
    if (!Array.isArray(steps) || steps.length === 0) return false;
    const { NpcDefinition } = api.core;
    const definition = NpcDefinition.forId(npcId);
    const event = { player, npcId, npc: null, definition };
    const context = { player, npc: null, npcId, definition, pages: [{ page: PAGE, variants: [] }] };
    startDialogue(api, event, flattenSpeakers(steps), transcriptRecord()?.branches, context);
    return true;
  }

  // ==========================================================================
  // World setup
  // ==========================================================================

  function registerObject(objectId, tile, rotation = 0) {
    const object = new GameObject(objectId, new Location(tile.x, tile.y, 0), 10, rotation, null);
    ObjectManager.register(object, true);
  }

  function installObjects() {
    if (objectsInstalled) return;
    objectsInstalled = true;
    registerObject(CRAB_BOTTLE_OBJECT_ID, BOTTLE_TILE);
    for (const spot of SPOTS) registerObject(spot.objectId, spot, spot.rotation ?? 0);
  }

  function swapBottleToPost() {
    registerObject(CRAB_BOTTLE_POST_OBJECT_ID, BOTTLE_TILE);
  }

  function tracked(player) {
    let map = trackedNpcs.get(player);
    if (!map) {
      map = new Map();
      trackedNpcs.set(player, map);
    }
    return map;
  }

  function spawnTracked(player, key, definition) {
    const map = tracked(player);
    if (map.get(key)) return map.get(key);
    const npc = api.spawnNpc({ ...definition, owner: player, ownerOnly: true });
    if (npc) map.set(key, npc);
    return npc;
  }

  function removeTracked(player, key) {
    const map = trackedNpcs.get(player);
    const npc = map?.get(key);
    if (npc) {
      api.removeNpc(npc);
      map.delete(key);
    }
  }

  function removeAllTracked(player) {
    const map = trackedNpcs.get(player);
    if (!map) return;
    for (const npc of map.values()) api.removeNpc(npc);
    trackedNpcs.delete(player);
  }

  function syncGroundItems(player) {
    const manager = api.getItemOnGroundManager();
    if (!manager?.registerLocation || !manager?.getGroundItem) return;
    const stage = quest.getStage(player);
    const privateArea = player.getPrivateArea?.() ?? null;
    if (stage === STAGE_SHELLS) {
      for (let index = 0; index < SHELL_TILES.length; index++) {
        if (hasFlag(player, SHELLS_PICKED_ATTRIBUTE, 1 << index)) continue;
        const itemId = ALL_SHELL_ITEM_IDS[index];
        if (hasItem(player, itemId)) continue;
        const tile = SHELL_TILES[index];
        const position = new Location(tile.x, tile.y, 0);
        if (manager.getGroundItem(player.getUsername(), itemId, position, privateArea)) continue;
        manager.registerLocation(player, new Item(itemId, 1), position);
      }
    }
    if (stage === STAGE_INSTRUMENT && !hasFlag(player, NET_PICKED_ATTRIBUTE, 1)) {
      const position = new Location(NET_TILE.x, NET_TILE.y, 0);
      if (!manager.getGroundItem(player.getUsername(), BIG_FISHING_NET_ITEM_ID, position, privateArea)) {
        manager.registerLocation(player, new Item(BIG_FISHING_NET_ITEM_ID, 1), position);
      }
    }
  }

  function syncNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = quest.getStage(player);
    if (stage >= STAGE_SHELLS) {
      spawnTracked(player, "main-crab", {
        id: MAIN_CRAB_NPC_ID,
        ...MAIN_CRAB_TILE,
        z: 0,
        wanderRadius: 0,
      });
    } else {
      removeTracked(player, "main-crab");
    }
    syncGroundItems(player);
  }

  // ==========================================================================
  // Start, bottle and reminiscing
  // ==========================================================================

  function handleStartHook(event) {
    if (event.hook !== START_HOOK) return;
    const { player } = event;
    if (quest.isComplete(player) || quest.getStage(player) !== STAGE_NOT_STARTED) return;
    if (!meetsRequirements(player)) return;
    setStage(player, STAGE_SHELLS);
  }

  function drinkFromBottle(player) {
    if (quest.isComplete(player)) {
      // The collection has no Drop option, so reclaiming it must not depend on
      // dropping it: a missing collection is handed back on the bottle itself.
      if (!hasItem(player, SHELL_COLLECTION_ITEM_ID)) {
        player.sendMessage(SHELL_COLLECTION_RECOVERY_TEXT);
        grantShellCollection(player);
        return;
      }
      startTranscript(api, player, MAIN_CRAB_NPC_ID, PAGE, "crab-rave-reminiscing-at-the-bottle");
      return;
    }
    if (quest.getStage(player) === STAGE_NOT_STARTED) {
      if (!meetsRequirements(player)) {
        player.sendMessage(REQUIREMENTS_MESSAGE);
        return;
      }
      startTranscript(api, player, MAIN_CRAB_NPC_ID, PAGE, "drinking-from-bottle");
      return;
    }
    startTranscript(
      api,
      player,
      MAIN_CRAB_NPC_ID,
      PAGE,
      "drinking-from-bottle-drinking-from-the-bottle-again-to-go-back-to-the-dream"
    );
  }

  // ==========================================================================
  // Main crab
  // ==========================================================================

  function shellHandInSteps(player) {
    const shells = ALL_SHELL_ITEM_IDS.filter((itemId) => hasItem(player, itemId));
    if (shells.length === 0) return null;
    const steps = [];
    steps.push(...conditionSteps("handing-in-seashells", shells.length === 1 ? "mp1abt" : "6eoFGP"));
    let correct = handedShellCount(player);
    for (const itemId of shells) {
      if (SHELL_ITEM_IDS.includes(itemId)) {
        steps.push(...variantSteps(SHELL_MESSAGE_VARIANTS.get(itemId)));
        correct += 1;
        if (correct >= SHELL_COUNT) steps.push(...variantSteps(LAST_SHELL_VARIANT));
        else steps.push(...variantSteps(SHELL_REACTION_VARIANTS[correct - 1]));
      } else {
        steps.push(...variantSteps("handing-in-seashells-bad-shell"));
      }
      player.getInventory().deleteNumber(itemId, 1);
    }
    player.setAttribute(SHELLS_HANDED_ATTRIBUTE, correct);
    return steps;
  }

  function playShellHandIn(player) {
    const steps = shellHandInSteps(player);
    if (!steps) return false;
    if (handedShellCount(player) >= SHELL_COUNT) setStage(player, STAGE_INSTRUMENT);
    return playSteps(player, MAIN_CRAB_NPC_ID, steps);
  }

  function talkToMainCrab(player) {
    if (quest.isComplete(player)) {
      startTranscript(api, player, MAIN_CRAB_NPC_ID, PAGE, "crab-hunting-talking-to-the-crab-again");
      return;
    }
    const stage = quest.getStage(player);
    if (stage < STAGE_RECRUITING && hasAnyShell(player)) {
      playShellHandIn(player);
      return;
    }
    if (stage === STAGE_SHELLS) {
      startTranscript(api, player, MAIN_CRAB_NPC_ID, PAGE, "handing-in-seashells");
      return;
    }
    if (stage === STAGE_INSTRUMENT) {
      startTranscript(
        api,
        player,
        MAIN_CRAB_NPC_ID,
        PAGE,
        "making-the-string-instrument-handing-in-the-instrument"
      );
      return;
    }
    if (stage === STAGE_RECRUITING) {
      startTranscript(api, player, MAIN_CRAB_NPC_ID, PAGE, "crab-hunting-talking-to-the-crab-again");
      return;
    }
    if (stage === STAGE_SIX_LEADERS) {
      startTranscript(
        api,
        player,
        MAIN_CRAB_NPC_ID,
        PAGE,
        "crab-hunting-after-finding-all-six-leaders-to-join-practise-talking-to-the-main-crab"
      );
      return;
    }
    if (stage === STAGE_ALL_LEADERS) {
      startTranscript(
        api,
        player,
        MAIN_CRAB_NPC_ID,
        PAGE,
        "crab-hunting-after-finding-every-crab-to-join-practise-talking-to-the-main-crab"
      );
      return;
    }
    if (stage === STAGE_DANCE_READY) {
      startTranscript(api, player, MAIN_CRAB_NPC_ID, PAGE, "crab-rave");
      return;
    }
    if (stage === STAGE_CEREMONY) {
      startTranscript(api, player, MAIN_CRAB_NPC_ID, PAGE, "crab-rave-the-ceremony");
      return;
    }
    startTranscript(api, player, MAIN_CRAB_NPC_ID, PAGE, "drinking-from-bottle");
  }

  function handleNpcInteraction(event) {
    const { player, npcId, clickType, definition } = event;
    const action = definition?.getActions?.()[clickType - 1];
    if (npcId === MAIN_CRAB_NPC_ID) {
      if (action !== "Talk-to") return;
      event.handled = true;
      talkToMainCrab(player);
      return;
    }
    if (FLOATSAM_NPC_IDS.has(npcId)) {
      if (action !== "Net") return;
      event.handled = true;
      netFloatsam(player);
    }
  }

  function netFloatsam(player) {
    if (quest.getStage(player) !== STAGE_INSTRUMENT) {
      playSteps(player, MAIN_CRAB_NPC_ID, variantSteps("drinking-from-bottle-interacting-with-the-floatsam"));
      return;
    }
    if (!hasItem(player, BIG_FISHING_NET_ITEM_ID)) {
      player.sendMessage(NEED_NET_TEXT);
      return;
    }
    const missing = [PLANK_ITEM_ID, BARREL_ITEM_ID, BOWSTRING_ITEM_ID].filter(
      (itemId) => !hasItem(player, itemId)
    );
    if (missing.length === 0 || hasItem(player, INSTRUMENT_ITEM_ID)) {
      player.sendMessage(NOTHING_LEFT_TEXT);
      return;
    }
    if (player.getInventory().getFreeSlots() < missing.length) {
      player.sendMessage(NO_SPACE_TEXT);
      return;
    }
    for (const itemId of missing) player.getInventory().adds(itemId, 1);
    player.setAttribute(MATERIALS_FISHED_ATTRIBUTE, true);
    startTranscript(
      api,
      player,
      MAIN_CRAB_NPC_ID,
      PAGE,
      "making-the-string-instrument-fishing-up-floatsam",
      (steps) => steps.filter((step) => step.id !== "Euz0TY")
    );
  }

  // ==========================================================================
  // Conditions, choices and stage directions
  // ==========================================================================

  function answerCondition(event) {
    const { player, npcId, stepId } = event;
    if (!CRAB_NPC_IDS.has(npcId)) return null;
    switch (stepId) {
      case "xfDRD_":
        return true; // this server has no attack-options setting; play the enabled branch
      case "l8tRCh":
        return false;
      case "K-qe1w":
        return !hasAnyShell(player);
      case "mp1abt":
        return shellCount(player) === 1;
      case "6eoFGP":
        return shellCount(player) > 1;
      case "TuN4Gx":
      case "389Shq":
        return false;
      case "iDnqb8":
        return hasItem(player, LYRE_ITEM_ID);
      case "0nXch7":
        for (const itemId of ENCHANTED_LYRE_ITEM_IDS) if (hasItem(player, itemId)) return true;
        return false;
      case "rpY0DE":
        return !hasItem(player, BIG_FISHING_NET_ITEM_ID);
      case "6SReDK":
        return player.getInventory().getFreeSlots() === 0;
      case "N8bbIk":
        return !materialsFished(player) && !hasAllMaterials(player) && !instrumentMade(player);
      case "6TbVF9":
        return hasAllMaterials(player);
      case "OmiT2d":
        return materialsFished(player) && !hasAllMaterials(player) && !instrumentMade(player);
      case "YefR4I":
        return instrumentMade(player) && !hasItem(player, INSTRUMENT_ITEM_ID);
      case "58Th_3":
        return hasAllMaterials(player);
      case "_-d3Em":
        return !hasAllMaterials(player);
      case "Mu0yhy":
        return hasItem(player, INSTRUMENT_ITEM_ID);
      case "rjtSkq":
        return player.getSkillManager().getMaxLevel(Skill.WOODCUTTING) >= WOODCUTTING_LEADER_REQUIREMENT;
      case "8TCO7P":
        return player.getSkillManager().getMaxLevel(Skill.WOODCUTTING) < WOODCUTTING_LEADER_REQUIREMENT;
      case "rXHyu1":
        return player.getAttribute(KID_CRAB_MET_ATTRIBUTE) === true;
      case "suOAJW":
        return instrumentName(player) === "disaster";
      case "_VgJ7G":
        return instrumentName(player) === "bass";
      case "Bb9j57":
        return instrumentName(player) === "banjo";
      case "mLyYVn":
        return player.getAttribute(DIPPER_MET_ATTRIBUTE) === true;
      case "Cx3vIK":
        return player.getAttribute(MAGIC_TREE_MET_ATTRIBUTE) === true;
      case "aBWf-c":
        return player.getAttribute(MAGIC_TREE_MET_ATTRIBUTE) !== true;
      case "xTNJly":
        return leaderCount(player) >= ALL_LEADER_COUNT;
      case "Z9b5Dj":
        return leaderCount(player) < ALL_LEADER_COUNT;
      case "U-Ic3c":
      case "sL_fYT":
        return false;
      case "foHwur":
        return true;
      case "hdDZkC":
        return quest.isComplete(player) && !hasItem(player, SHELL_COLLECTION_ITEM_ID);
      default:
        return null;
    }
  }

  function handleChoice(event) {
    const { player, npcId, option } = event;
    if (npcId !== MAIN_CRAB_NPC_ID) return;
    if (option === DISASTER_NAME) {
      player.setAttribute(INSTRUMENT_NAME_ATTRIBUTE, "disaster");
      return;
    }
    if (option === BASS_NAME) {
      player.setAttribute(INSTRUMENT_NAME_ATTRIBUTE, "bass");
      return;
    }
    if (option === BANJO_NAME && instrumentName(player) === null) {
      player.setAttribute(INSTRUMENT_NAME_ATTRIBUTE, "banjo");
      return;
    }
    if (!PLAY_STYLE_OPTIONS.has(option)) return;
    if (hasItem(player, INSTRUMENT_ITEM_ID)) {
      player.getInventory().deleteNumber(INSTRUMENT_ITEM_ID, 1);
    }
    setStage(player, STAGE_RECRUITING);
  }

  function handleAction(event) {
    const { player, npcId, stepId } = event;
    if (!CRAB_NPC_IDS.has(npcId) || !stepId) return;
    const joinedBit = JOINED_STEP_BITS.get(stepId);
    if (joinedBit !== undefined) {
      if (!hasFlag(player, RECRUITED_ATTRIBUTE, joinedBit)) {
        setFlag(player, RECRUITED_ATTRIBUTE, joinedBit);
        if (stepId === MAGIC_TREE_STEP) player.setAttribute(MAGIC_TREE_MET_ATTRIBUTE, true);
        if (stepId === DIPPER_STEP) player.setAttribute(DIPPER_MET_ATTRIBUTE, true);
        if (stepId === KID_CRAB_STEP) player.setAttribute(KID_CRAB_MET_ATTRIBUTE, true);
        recountLeaders(player);
      }
      return;
    }
    if (stepId === DANCE_BEGINS_STEP) {
      event.handled = true;
      setStage(player, STAGE_DANCE_READY);
      return;
    }
    if (stepId === DANCE_ENDS_STEP) {
      event.handled = true;
      setStage(player, STAGE_CEREMONY);
      return;
    }
    if (stepId === CEREMONY_COMPLETE_STEP) {
      event.handled = true;
      swapBottleToPost();
      if (!quest.isComplete(player)) quest.complete(player);
      return;
    }
    if (stepId === SHELL_COLLECTION_MESSAGE_STEP) {
      if (quest.isComplete(player) && !hasItem(player, SHELL_COLLECTION_ITEM_ID)) {
        grantShellCollection(player);
      } else {
        // The words say you collect shells you are not actually missing.
        event.handled = true;
      }
      return;
    }
  }

  // ==========================================================================
  // Investigations
  // ==========================================================================

  function spotAt(objectId, location) {
    return (
      SPOTS.find(
        (spot) => spot.objectId === objectId && spot.x === location.x && spot.y === location.y
      ) ?? null
    );
  }

  function spotBit(spot) {
    return 1 << SPOTS.indexOf(spot);
  }

  function chatheadFor(spot) {
    return spot.chathead ?? MAIN_CRAB_NPC_ID;
  }

  function investigateSpot(player, spot) {
    const stage = quest.getStage(player);
    const bit = spotBit(spot);
    if (quest.isComplete(player)) {
      startTranscript(api, player, chatheadFor(spot), PAGE, DONE_JOINED_VARIANT);
      return;
    }
    if (stage < STAGE_RECRUITING) {
      if (spot.first) startTranscript(api, player, chatheadFor(spot), PAGE, spot.first);
      else player.sendMessage(NO_CRAB_TEXT);
      return;
    }
    if (spot.joinBit !== undefined && hasFlag(player, RECRUITED_ATTRIBUTE, spot.joinBit)) {
      startTranscript(api, player, chatheadFor(spot), PAGE, DONE_JOINED_VARIANT);
      return;
    }
    if (spot.joinBit === undefined && hasFlag(player, MET_ATTRIBUTE, bit)) {
      startTranscript(api, player, chatheadFor(spot), PAGE, WHILE_OUT_VARIANT);
      return;
    }
    if (spot.first && !hasFlag(player, SCARED_ATTRIBUTE, bit)) {
      setFlag(player, SCARED_ATTRIBUTE, bit);
      startTranscript(api, player, chatheadFor(spot), PAGE, spot.first);
      return;
    }
    setFlag(player, MET_ATTRIBUTE, bit);
    startTranscript(api, player, chatheadFor(spot), PAGE, spot.variant);
  }

  // ==========================================================================
  // Items, ground items and interactions
  // ==========================================================================

  function handleItemOnItem(event) {
    const { player, usedItemId, usedWithItemId } = event;
    if (!MATERIAL_ITEM_IDS.has(usedItemId) || !MATERIAL_ITEM_IDS.has(usedWithItemId)) return;
    event.handled = true;
    if (quest.getStage(player) !== STAGE_INSTRUMENT) return;
    if (!hasAllMaterials(player)) {
      player.sendMessage(NEED_MATERIALS_TEXT);
      return;
    }
    player.getInventory().deleteNumber(PLANK_ITEM_ID, 1);
    player.getInventory().deleteNumber(BARREL_ITEM_ID, 1);
    player.getInventory().deleteNumber(BOWSTRING_ITEM_ID, 1);
    player.getInventory().adds(INSTRUMENT_ITEM_ID, 1);
    player.setAttribute(INSTRUMENT_MADE_ATTRIBUTE, true);
    player.sendMessage(CRAFT_MESSAGE_TEXT);
  }

  function handleObjectInteraction(event) {
    const { player, objectId, clickType, location, definition } = event;
    if (objectId === CRAB_BOTTLE_OBJECT_ID || objectId === CRAB_BOTTLE_POST_OBJECT_ID) {
      const action = definition?.getActions?.()[clickType - 1];
      if (objectId === CRAB_BOTTLE_OBJECT_ID && action !== "Drink") return;
      if (objectId === CRAB_BOTTLE_POST_OBJECT_ID && action !== "Reminisce") return;
      event.handled = true;
      drinkFromBottle(player);
      return;
    }
    const spot = spotAt(objectId, location);
    if (!spot) return;
    if (definition?.getActions?.()[clickType - 1] !== "Investigate") return;
    event.handled = true;
    investigateSpot(player, spot);
  }

  function handleGroundItemPickup(event) {
    const { player, groundItemId, location } = event;
    const shellIndex = ALL_SHELL_ITEM_IDS.indexOf(groundItemId);
    if (shellIndex >= 0) {
      const tile = SHELL_TILES[shellIndex];
      if (tile && tile.x === location.x && tile.y === location.y) {
        setFlag(player, SHELLS_PICKED_ATTRIBUTE, 1 << shellIndex);
      }
      return;
    }
    if (
      groundItemId === BIG_FISHING_NET_ITEM_ID &&
      location.x === NET_TILE.x &&
      location.y === NET_TILE.y
    ) {
      setFlag(player, NET_PICKED_ATTRIBUTE, 1);
    }
  }

  function handleLogin({ player }) {
    installObjects();
    refreshQuestList(player);
    syncNpcs(player);
  }

  function handleLogout({ player }) {
    removeAllTracked(player);
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I drank from the strange bottle on Dognose Island and met a</str>",
        "<str>crab who wanted to become a ceremonial leader.</str>",
        "<str>I gathered shells, built him an instrument and recruited</str>",
        "<str>eleven crabs for the ceremony.</str>",
        "",
        "<str>The crabs danced and I woke up with a shell collection.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage === STAGE_NOT_STARTED) {
      return [
        "I can start this quest by drinking from the",
        "strange <col=800000>bottle</col> on <col=800000>Dognose Island</col>.",
        "",
        "I need <col=800000>40 Sailing</col> and <col=800000>30 Fishing</col>.",
      ];
    }
    const lines = [
      "I drank from the strange bottle on Dognose Island and met a crab who",
      "wants to be a ceremonial leader at the crab ceremony.",
      "",
    ];
    if (stage === STAGE_SHELLS) {
      lines.push("I should gather seashells from around the island and bring");
      lines.push("them to the crab. I have handed in " + handedShellCount(player) + "/7 good shells.");
    } else if (stage === STAGE_INSTRUMENT) {
      lines.push("The crab can't play 7 shells at once, so I agreed to make him");
      lines.push("a string instrument from the flotsam on the beach.");
    } else if (stage < STAGE_ALL_LEADERS) {
      lines.push("The crab is practising his instrument while I recruit more crabs");
      lines.push("to become ceremonial leaders. Leaders found: " + leaderCount(player) + "/11.");
    } else if (stage === STAGE_ALL_LEADERS) {
      lines.push("All eleven ceremonial leaders have gathered on the beach.");
      lines.push("I should talk to the crab about the ceremony.");
    } else {
      lines.push("The ceremony is about to begin on the beach.");
    }
    return lines;
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.SAILING, 10000);
    player.getSkillManager().addExperiences(Skill.FISHING, 3000);
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  api.persistAttribute(RECRUITED_ATTRIBUTE);
  api.persistAttribute(SCARED_ATTRIBUTE);
  api.persistAttribute(MET_ATTRIBUTE);
  api.persistAttribute(SHELLS_HANDED_ATTRIBUTE);
  api.persistAttribute(SHELLS_PICKED_ATTRIBUTE);
  api.persistAttribute(NET_PICKED_ATTRIBUTE);
  api.persistAttribute(MATERIALS_FISHED_ATTRIBUTE);
  api.persistAttribute(INSTRUMENT_MADE_ATTRIBUTE);
  api.persistAttribute(INSTRUMENT_NAME_ATTRIBUTE);
  api.persistAttribute(MAGIC_TREE_MET_ATTRIBUTE);
  api.persistAttribute(DIPPER_MET_ATTRIBUTE);
  api.persistAttribute(KID_CRAB_MET_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "crab_quest",
    name: "Crab Quest",
    varpId: 5739,
    varbitId: STAGE_VARBIT,
    startedValue: STAGE_SHELLS,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: Skill.SAILING.getIndex(), amount: 10000, label: "Sailing" },
      { skillId: Skill.FISHING.getIndex(), amount: 3000, label: "Fishing" },
    ],
    rewardItemId: SHELL_COLLECTION_ITEM_ID,
    rewardItemLabel: "A shell collection",
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onNpcInteraction(handleNpcInteraction);
  api.onObjectInteraction(handleObjectInteraction);
  api.onItemOnItem(handleItemOnItem);
  api.onGroundItemPickup(handleGroundItemPickup);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
