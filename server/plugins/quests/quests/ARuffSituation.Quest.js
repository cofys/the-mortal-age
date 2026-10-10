/**
 * A Ruff Situation (members).
 *
 * The words come from the "A Ruff Situation" transcript page (OSRS Wiki). This
 * plugin supplies the Talk-to/Interact handlers for the quest NPCs, the prose
 * condition answers, the den/goblins/outlaws stage logic and the completion
 * reward.
 *
 * Stages (varbit 15889 "dogquest", varp 5742, bits 0-6; lookup-gameval.ts
 * "dogquest"):
 *   0 not started, 1 Talia asked for help, 2 Gertrude visited, 3 stray dog found
 *   (following her to the den), 4 all three den objects inspected, 5 first puppy
 *   rescued, 6 the goblins want a stuffed dog, 7 second puppy rescued (third
 *   puppy hunt), 8 outlaws cornering the third puppy, 9 all three puppies
 *   rescued, 10 complete.
 *
 * The stray dog (16504/16505), Talia/Chase (16486/16488), the quest guard
 * (16493), Gertrude (7284), Picklenose/Toetaller (16523/16524) and the quest
 * outlaws (16527 level 23 / 16528 level 22) are per-player owner-only spawns:
 * none of them are in npc-spawns.json. The torn newspaper (62488), chewed box
 * (62491) and rough bedding (62485) have no map placements in this cache, so
 * they are registered at the cache/wiki tiles (3197,3413), (3195,3413),
 * (3195,3416).
 *
 * Source: OSRS Wiki "A Ruff Situation" page, quick guide and transcript; varbit
 * 15889 and every cache id confirmed with scripts/lookup-gameval.ts and
 * CacheDefinitions.
 *
 * Gaps: the dog does not physically path-follow the player; each beat teleports
 * her to the next scene tile (bank -> den -> Cooks' Guild -> goblins -> outlaw
 * camp), which keeps the transcript order and the walk short. Cutscene and
 * multi-speaker lines share the chathead of the NPC being talked to. The banker
 * and Grand Exchange proximity lines, the "periodically"/"upon approaching"
 * ambient variants and the "interacting with the dog while following her"
 * lead-in (the cutscene plays on the next interaction instead) are not
 * triggered. The stuffed dog consumes grain, one fur
 * and thread; the needle is kept (a costume needle replaces needle and thread).
 * Puppies are tracked as quest state rather than spawned NPCs. The trailing
 * "Congratulations! Quest complete!" action after the wiki "end" marker is
 * unreachable during replay, so the quest completes on the guard's walk-in a few
 * lines earlier. No post-quest Chase variant exists on the page, so a completed
 * player gets the "Transcript:Chase" standard dialogue.
 */
module.exports = function registerARuffSituationQuest(api) {
  const {
    GameObject,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    ObjectManager,
    Skill,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const PAGE = "A Ruff Situation";
  const START_HOOK = "quest:a-ruff-situation:start";

  // Varp 5742 "dogquest" (scripts/lookup-gameval.ts varbit dogquest).
  const VARP_DOGQUEST = 5742;
  const STAGE_VARBIT = 15889;

  const STAGE_STARTED = 1;
  const STAGE_GERTRUDE = 2;
  const STAGE_DOG = 3;
  const STAGE_DEN = 4;
  const STAGE_FIRST_PUPPY = 5;
  const STAGE_STUFFED_DOG = 6;
  const STAGE_SECOND_PUPPY = 7;
  const STAGE_OUTLAWS = 8;
  const STAGE_THIRD_PUPPY = 9;
  const STAGE_COMPLETE = 10;

  const CRAFTING_REQUIREMENT = 15;
  const GERTRUDES_CAT_KEY = "gertrudes_cat";

  const TALIA_NPC_ID = NpcIdentifiers.TALIA_2; // 16486
  const CHASE_NPC_ID = NpcIdentifiers.CHASE; // 16488
  const GERTRUDE_NPC_ID = NpcIdentifiers.GERTRUDE; // 7284
  const QUEST_GUARD_NPC_ID = NpcIdentifiers.GUARD_302; // 16493
  const STRAY_DOG_NPC_ID = NpcIdentifiers.STRAY_DOG_8; // 16504, Interact
  const STRAY_DOG_FOLLOWING_NPC_ID = NpcIdentifiers.STRAY_DOG_9; // 16505, Interact|Dismiss
  const PICKLENOSE_NPC_ID = NpcIdentifiers.PICKLENOSE; // 16523
  const TOETALLER_NPC_ID = NpcIdentifiers.TOETALLER; // 16524
  const OUTLAW_23_NPC_ID = NpcIdentifiers.OUTLAW_11; // 16527, level 23
  const OUTLAW_22_NPC_ID = NpcIdentifiers.OUTLAW_12; // 16528, level 22
  const STRAY_DOG_NPC_IDS = new Set([
    STRAY_DOG_NPC_ID,
    STRAY_DOG_FOLLOWING_NPC_ID,
    NpcIdentifiers.STRAY_DOG_10, // 16529
    NpcIdentifiers.STRAY_DOG_11, // 16530
  ]);

  const GRAIN_ITEM_ID = ItemIdentifiers.GRAIN; // 1947
  const FUR_ITEM_ID = ItemIdentifiers.FUR; // 6814
  const BEAR_FUR_ITEM_ID = ItemIdentifiers.BEAR_FUR; // 948
  const GREY_WOLF_FUR_ITEM_ID = ItemIdentifiers.GREY_WOLF_FUR; // 958
  const FOX_FUR_ITEM_ID = ItemIdentifiers.FOX_FUR; // 29163
  const JAGUAR_FUR_ITEM_ID = ItemIdentifiers.JAGUAR_FUR; // 29218
  const FUR_ITEM_IDS = new Set([
    FUR_ITEM_ID,
    BEAR_FUR_ITEM_ID,
    GREY_WOLF_FUR_ITEM_ID,
    FOX_FUR_ITEM_ID,
    JAGUAR_FUR_ITEM_ID,
  ]);
  const NEEDLE_ITEM_ID = ItemIdentifiers.NEEDLE; // 1733
  const THREAD_ITEM_ID = ItemIdentifiers.THREAD; // 1734
  const COSTUME_NEEDLE_ITEM_ID = ItemIdentifiers.COSTUME_NEEDLE; // 29920
  const STUFFED_DOG_ITEM_ID = ItemIdentifiers.STUFFED_DOG; // 34602

  const TORN_NEWSPAPER_OBJECT_ID = ObjectIdentifiers.TORN_NEWSPAPER_2; // 62488, Inspect
  const CHEWED_BOX_OBJECT_ID = ObjectIdentifiers.CHEWED_BOX_2; // 62491, Inspect
  const ROUGH_BEDDING_OBJECT_ID = ObjectIdentifiers.ROUGH_BEDDING_2; // 62485, Inspect

  const TALIA_TILE = { x: 3036, y: 3458 };
  const CHASE_TILE = { x: 3038, y: 3457 };
  const GERTRUDE_TILE = { x: 3151, y: 3410 };
  const GUARD_TILE = { x: 3180, y: 3424 };
  const BANK_DOG_TILE = { x: 3180, y: 3425 };
  const DEN_DOG_TILE = { x: 3196, y: 3414 };
  const COOK_DOG_TILE = { x: 3144, y: 3456 };
  const GOBLIN_DOG_TILE = { x: 3120, y: 3443 };
  const CAMP_DOG_TILE = { x: 3118, y: 3468 };
  const PICKLENOSE_TILE = { x: 3122, y: 3443 };
  const TOETALLER_TILE = { x: 3124, y: 3444 };
  const OUTLAW_TILES = new Map([
    [OUTLAW_23_NPC_ID, { x: 3115, y: 3468 }],
    [OUTLAW_22_NPC_ID, { x: 3121, y: 3468 }],
  ]);
  const TORN_NEWSPAPER_TILE = { x: 3197, y: 3413 };
  const CHEWED_BOX_TILE = { x: 3195, y: 3413 };
  const ROUGH_BEDDING_TILE = { x: 3195, y: 3416 };

  // Condition step ids on the "A Ruff Situation" page.
  const REQUIREMENTS_NOT_MET_CONDITION_ID = "L94gv4";
  const REQUIREMENTS_MET_CONDITION_ID = "HETyUu";
  const CAT_NOT_DONE_CONDITION_ID = "8Dawwp";
  const CAT_DONE_CONDITION_ID = "Kxe_wx";
  const GERTRUDE_CAT_DONE_CONDITION_ID = "uj8cWF";
  const GERTRUDE_CAT_NOT_DONE_CONDITION_ID = "K0h0go";
  const NO_SPACE_CUTSCENE_CONDITION_ID = "nBi_OT";
  const NO_FOLLOWER_CONDITION_ID = "HB4vku";
  const HAS_FOLLOWER_CONDITION_ID = "LSUSeA";
  const DOG_FOLLOWING_CONDITION_ID = "LCq_B6";
  const DOG_NOT_FOLLOWING_CONDITION_ID = "8YcOp_";
  const GOT_GRAIN_CONDITION_ID = "TmJIzl";
  const NO_GRAIN_CONDITION_ID = "t9Ur6J";
  const GOT_FUR_CONDITION_ID = "rVWHFC";
  const NO_FUR_CONDITION_ID = "1IDQ_T";
  const GOT_NEEDLE_CONDITION_ID = "sV_vTi";
  const NO_NEEDLE_CONDITION_ID = "h8Xi6t";
  const GOT_THREAD_CONDITION_ID = "zopo9g";
  const NO_THREAD_CONDITION_ID = "JRfGJi";
  const MISSING_ITEMS_CONDITION_ID = "tSYWmu";
  const HAS_ITEMS_CONDITION_ID = "o7fqus";
  const NO_SPACE_GOBLINS_CONDITION_ID = "yApHLl";
  const NO_SPACE_OUTLAWS_CONDITION_ID = "7ZjmSz";
  const MISSING_PUPPIES_CONDITION_ID = "38Af3Z";
  const HAS_PUPPIES_CONDITION_ID = "w58Zw0";
  const NO_SPACE_SPANIEL_CONDITION_ID = "2DRYza";
  const HAS_SPACE_SPANIEL_CONDITION_ID = "XjUT9d";

  // Action/message step ids on the page.
  const PUPPY_APPEARS_STEP = "FcFo5X";
  const PUPPY_APPROACHES_STEP = "0JYuUr";
  const GOBLIN_RUNS_STEP = "9rWUTo";
  const FIRST_PUPPY_PICKUP_STEP = "sZmmAX";
  const GIVE_STUFFED_DOG_STEP = "dsJOoa";
  const GOBLINS_LEAVE_STEP = "AsGBaf";
  const SECOND_PUPPY_PICKUP_STEP = "9aHrpW";
  const OUTLAWS_APPROACH_STEP = "WaE4-O";
  const OUTLAWS_CONTINUE_STEP = "VHbybd";
  const RUN_IN_STEP = "SwYquA";
  const THIRD_PUPPY_PICKUP_STEP = "61xr7U";
  const PLACE_PUPPIES_STEP = "9JXyoS";
  const DOG_LEAVES_STEP = "Darl0H";
  const GUARD_WALKS_IN_STEP = "XTGJ4B";
  const QUEST_COMPLETE_STEP = "sCG0ie";

  const ALWAYS_MESSAGE_STEPS = new Set([
    PUPPY_APPEARS_STEP,
    PUPPY_APPROACHES_STEP,
    GOBLIN_RUNS_STEP,
    OUTLAWS_CONTINUE_STEP,
    RUN_IN_STEP,
    PLACE_PUPPIES_STEP,
    DOG_LEAVES_STEP,
  ]);

  const TALIA_OFFERED_ATTRIBUTE = "quest.a_ruff_situation.talia-offered";
  const INSPECTED_ATTRIBUTE = "quest.a_ruff_situation.inspected";
  const DOG_WAITING_ATTRIBUTE = "quest.a_ruff_situation.dog-waiting";
  const THIRD_HUNT_ATTRIBUTE = "quest.a_ruff_situation.third-hunt";
  const GOBLINS_LEFT_ATTRIBUTE = "quest.a_ruff_situation.goblins-left";
  const OUTLAWS_KILLED_ATTRIBUTE = "quest.a_ruff_situation.outlaws-killed";
  const BIT_NEWSPAPER = 1 << 0;
  const BIT_CHEWED_BOX = 1 << 1;
  const BIT_BEDDING = 1 << 2;
  const ALL_INSPECTED = BIT_NEWSPAPER | BIT_CHEWED_BOX | BIT_BEDDING;
  const OUTLAW_BITS = new Map([
    [OUTLAW_23_NPC_ID, 1 << 0],
    [OUTLAW_22_NPC_ID, 1 << 1],
  ]);
  const ALL_OUTLAWS_KILLED = (1 << 0) | (1 << 1);

  /** Tracked per-player owner-only spawns, keyed by role. */
  const trackedNpcs = new WeakMap();

  let quest;
  let objectsInstalled = false;

  // ==========================================================================
  // State helpers
  // ==========================================================================

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

  function atTile(npc, tile) {
    const location = npc?.getLocation?.();
    return !!location && location.getX() === tile.x && location.getY() === tile.y && location.getZ() === 0;
  }

  function setStage(player, stage) {
    if (quest.getStage(player) === stage) return;
    quest.setStage(player, stage);
    syncNpcs(player);
  }

  function craftingLevel(player) {
    return player.getSkillManager().getMaxLevel(Skill.CRAFTING);
  }

  function freeSlots(player) {
    return player.getInventory().getFreeSlots();
  }

  function hasItem(player, itemId) {
    return player.getInventory().getAmount(itemId) > 0;
  }

  function hasAnyFur(player) {
    for (const itemId of FUR_ITEM_IDS) if (hasItem(player, itemId)) return true;
    return false;
  }

  function hasNeedle(player) {
    return hasItem(player, NEEDLE_ITEM_ID) || hasItem(player, COSTUME_NEEDLE_ITEM_ID);
  }

  function hasThreadOrCostumeNeedle(player) {
    return hasItem(player, THREAD_ITEM_ID) || hasItem(player, COSTUME_NEEDLE_ITEM_ID);
  }

  function hasCraftItems(player) {
    return hasItem(player, GRAIN_ITEM_ID) && hasAnyFur(player) && hasNeedle(player) && hasThreadOrCostumeNeedle(player);
  }

  function questComplete(player, key) {
    const request = { player, key };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function hasFollower(player) {
    const current = player.getAttribute?.("pets:current");
    return current?.isRegistered?.() === true;
  }

  function inspectedMask(player) {
    return Number(player.getAttribute(INSPECTED_ATTRIBUTE)) || 0;
  }

  function dogWaiting(player) {
    return player.getAttribute(DOG_WAITING_ATTRIBUTE) === true;
  }

  function thirdHunt(player) {
    return player.getAttribute(THIRD_HUNT_ATTRIBUTE) === true;
  }

  function isDogFollowing(player) {
    return !dogWaiting(player) && !quest.isComplete(player);
  }

  function isQuestPage(pages) {
    return Array.isArray(pages) && pages.some((page) => page?.page === PAGE);
  }

  // ==========================================================================
  // NPC spawns
  // ==========================================================================

  function dogTileFor(player, stage) {
    if (dogWaiting(player) && stage >= STAGE_DOG) return DEN_DOG_TILE;
    if (stage === STAGE_GERTRUDE) return BANK_DOG_TILE;
    if (stage === STAGE_DOG) return DEN_DOG_TILE;
    if (stage === STAGE_DEN) return COOK_DOG_TILE;
    if (stage >= STAGE_FIRST_PUPPY && stage <= STAGE_SECOND_PUPPY) {
      return thirdHunt(player) ? CAMP_DOG_TILE : GOBLIN_DOG_TILE;
    }
    if (stage === STAGE_OUTLAWS) return CAMP_DOG_TILE;
    return null;
  }

  function syncDog(player, stage) {
    const tile = dogTileFor(player, stage);
    if (!tile) {
      removeTracked(player, "dog");
      return;
    }
    const wantedId = stage === STAGE_GERTRUDE ? STRAY_DOG_NPC_ID : STRAY_DOG_FOLLOWING_NPC_ID;
    const existing = tracked(player).get("dog");
    if (existing && existing.getId() === wantedId && atTile(existing, tile)) return;
    removeTracked(player, "dog");
    spawnTracked(player, "dog", { id: wantedId, ...tile, z: 0, wanderRadius: 0 });
  }

  function outlawsKilledMask(player) {
    return Number(player.getAttribute(OUTLAWS_KILLED_ATTRIBUTE)) || 0;
  }

  function syncOutlaws(player, stage) {
    if (stage !== STAGE_OUTLAWS) {
      removeTracked(player, "outlaw-23");
      removeTracked(player, "outlaw-22");
      return;
    }
    const mask = outlawsKilledMask(player);
    for (const [npcId, bit] of OUTLAW_BITS) {
      const key = npcId === OUTLAW_23_NPC_ID ? "outlaw-23" : "outlaw-22";
      if (mask & bit) {
        removeTracked(player, key);
        continue;
      }
      spawnTracked(player, key, { id: npcId, ...OUTLAW_TILES.get(npcId), z: 0, wanderRadius: 0 });
    }
  }

  function syncGoblins(player, stage) {
    const wanted =
      stage >= STAGE_FIRST_PUPPY &&
      stage < STAGE_SECOND_PUPPY &&
      player.getAttribute(GOBLINS_LEFT_ATTRIBUTE) !== true;
    if (!wanted) {
      removeTracked(player, "picklenose");
      removeTracked(player, "toetaller");
      return;
    }
    spawnTracked(player, "picklenose", { id: PICKLENOSE_NPC_ID, ...PICKLENOSE_TILE, z: 0, wanderRadius: 0 });
    spawnTracked(player, "toetaller", { id: TOETALLER_NPC_ID, ...TOETALLER_TILE, z: 0, wanderRadius: 0 });
  }

  function syncNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    spawnTracked(player, "talia", { id: TALIA_NPC_ID, ...TALIA_TILE, z: 0, wanderRadius: 0 });
    spawnTracked(player, "chase", { id: CHASE_NPC_ID, ...CHASE_TILE, z: 0, wanderRadius: 0 });

    const stage = quest.getStage(player);
    if (stage >= STAGE_STARTED && stage <= STAGE_GERTRUDE) {
      spawnTracked(player, "gertrude", { id: GERTRUDE_NPC_ID, ...GERTRUDE_TILE, z: 0, wanderRadius: 0 });
    } else {
      removeTracked(player, "gertrude");
    }

    if (stage >= STAGE_GERTRUDE && stage < STAGE_COMPLETE) {
      spawnTracked(player, "guard", { id: QUEST_GUARD_NPC_ID, ...GUARD_TILE, z: 0, wanderRadius: 0 });
    } else {
      removeTracked(player, "guard");
    }

    syncDog(player, stage);
    syncGoblins(player, stage);
    syncOutlaws(player, stage);
  }

  // ==========================================================================
  // Runtime quest scenery (absent from this cache's maps)
  // ==========================================================================

  function installInspectObjects() {
    if (objectsInstalled) return;
    objectsInstalled = true;
    registerObject(TORN_NEWSPAPER_OBJECT_ID, TORN_NEWSPAPER_TILE);
    registerObject(CHEWED_BOX_OBJECT_ID, CHEWED_BOX_TILE);
    registerObject(ROUGH_BEDDING_OBJECT_ID, ROUGH_BEDDING_TILE);
  }

  function registerObject(objectId, tile) {
    const object = new GameObject(objectId, new Location(tile.x, tile.y, 0), 10, 0, null);
    ObjectManager.register(object, true);
  }

  // ==========================================================================
  // Talk-to handlers
  // ==========================================================================

  function talkTalia(event) {
    const { player, npcId } = event;
    if (npcId !== TALIA_NPC_ID) return false;
    if (quest.isComplete(player)) {
      startTranscript(api, player, npcId, PAGE, "post-quest-dialogue");
      return;
    }
    const stage = quest.getStage(player);
    if (stage === 0) {
      startTranscript(
        api,
        player,
        npcId,
        PAGE,
        player.getAttribute(TALIA_OFFERED_ATTRIBUTE) === true
          ? "starting-off-talking-to-talia-again"
          : "starting-off-talking-to-talia"
      );
      return;
    }
    if (stage === STAGE_STARTED) {
      startTranscript(api, player, npcId, PAGE, "starting-off-talking-to-talia-after-starting-the-quest");
      return;
    }
    if (stage === STAGE_GERTRUDE) {
      startTranscript(api, player, npcId, PAGE, "gertrude-talking-to-talia-again");
      return;
    }
    if (stage === STAGE_SECOND_PUPPY) {
      startTranscript(
        api,
        player,
        npcId,
        PAGE,
        "back-to-the-goblins-with-the-stuffed-dog-talking-to-talia-again-with-two-puppies"
      );
      return;
    }
    if (stage >= STAGE_THIRD_PUPPY) {
      startTranscript(api, player, npcId, PAGE, "looking-for-the-third-puppy-back-at-the-shelter");
      return;
    }
    startTranscript(api, player, npcId, PAGE, "cutscene-talking-to-talia-again");
  }

  function talkChase(event) {
    const { player, npcId } = event;
    if (npcId !== CHASE_NPC_ID) return false;
    if (quest.isComplete(player)) return false;
    startTranscript(
      api,
      player,
      npcId,
      PAGE,
      quest.getStage(player) === 0
        ? "starting-off-talking-to-chase"
        : "starting-off-talking-to-chase-after-starting-the-quest"
    );
  }

  function talkGertrude(event) {
    const { player, npcId } = event;
    if (npcId !== GERTRUDE_NPC_ID) return false;
    const stage = quest.getStage(player);
    if (stage !== STAGE_STARTED && stage !== STAGE_GERTRUDE) return false;
    if (stage === STAGE_STARTED) setStage(player, STAGE_GERTRUDE);
    startTranscript(
      api,
      player,
      npcId,
      PAGE,
      stage === STAGE_STARTED ? "gertrude" : "gertrude-talking-to-gertrude-again"
    );
  }

  function talkQuestGuard(event) {
    const { player, npcId } = event;
    if (npcId !== QUEST_GUARD_NPC_ID || quest.isComplete(player)) return false;
    const stage = quest.getStage(player);
    if (stage === STAGE_GERTRUDE) {
      setStage(player, STAGE_DOG);
      startTranscript(api, player, npcId, PAGE, "stray-dog-talking-to-the-guard-or-interacting-with-the-stray-dog");
      return;
    }
    if (stage === STAGE_DOG || stage === STAGE_DEN) {
      startTranscript(api, player, npcId, PAGE, "at-the-dog-s-house-talking-to-the-guard");
      return;
    }
    if (stage >= STAGE_FIRST_PUPPY && stage <= STAGE_SECOND_PUPPY) {
      startTranscript(
        api,
        player,
        npcId,
        PAGE,
        dogWaiting(player)
          ? "back-to-the-goblins-with-the-stuffed-dog-talking-to-the-guard-while-the-stray-dog-is-with-the-goblins"
          : "cutscene-talking-to-the-guard-again"
      );
      return;
    }
    return false;
  }

  function talkGoblins(event) {
    const { player, npcId } = event;
    if (npcId !== PICKLENOSE_NPC_ID && npcId !== TOETALLER_NPC_ID) return false;
    const stage = quest.getStage(player);
    if (stage === STAGE_FIRST_PUPPY) {
      setStage(player, STAGE_STUFFED_DOG);
      startTranscript(api, player, npcId, PAGE, "goblins");
      return;
    }
    if (stage === STAGE_STUFFED_DOG) {
      if (!hasItem(player, STUFFED_DOG_ITEM_ID)) {
        startTranscript(
          api,
          player,
          npcId,
          PAGE,
          "goblins-talking-to-the-goblins-again-or-trying-to-pick-up-the-stray-puppy-without-the-stuffed-dog"
        );
        return;
      }
      startTranscript(
        api,
        player,
        npcId,
        PAGE,
        dogWaiting(player)
          ? "back-to-the-goblins-with-the-stuffed-dog-talking-to-the-goblins-without-the-stray-dog"
          : "back-to-the-goblins-with-the-stuffed-dog-talking-to-the-goblins-with-the-stray-dog"
      );
      return;
    }
    return false;
  }

  function interactStrayDog(event) {
    const { player, npcId } = event;
    if (!STRAY_DOG_NPC_IDS.has(npcId) || quest.isComplete(player)) return false;
    const stage = quest.getStage(player);
    if (stage < STAGE_GERTRUDE) return false;

    if (dogWaiting(player) && stage >= STAGE_DOG) {
      player.setAttribute(DOG_WAITING_ATTRIBUTE, false);
      syncDog(player, stage);
      startTranscript(api, player, npcId, PAGE, "cutscene-returning-to-the-dog-after-leaving-her");
      return;
    }
    if (stage === STAGE_GERTRUDE) {
      setStage(player, STAGE_DOG);
      startTranscript(api, player, npcId, PAGE, "stray-dog-talking-to-the-guard-or-interacting-with-the-stray-dog");
      return;
    }
    if (stage === STAGE_DOG) {
      startTranscript(api, player, npcId, PAGE, "at-the-dog-s-house-interacting-with-the-dog");
      return;
    }
    if (stage === STAGE_DEN) {
      startTranscript(api, player, npcId, PAGE, "cutscene");
      return;
    }
    if (stage === STAGE_FIRST_PUPPY) {
      startTranscript(api, player, npcId, PAGE, "cutscene-after-the-cutscene");
      return;
    }
    if (stage === STAGE_STUFFED_DOG) {
      if (thirdHunt(player)) {
        startTranscript(api, player, npcId, PAGE, "looking-for-the-third-puppy-cutscene");
        return;
      }
      startTranscript(api, player, npcId, PAGE, "cutscene-interacting-with-the-stray-dog");
      return;
    }
    if (stage === STAGE_SECOND_PUPPY) {
      if (thirdHunt(player)) {
        startTranscript(api, player, npcId, PAGE, "looking-for-the-third-puppy-cutscene");
        return;
      }
      player.setAttribute(THIRD_HUNT_ATTRIBUTE, true);
      syncDog(player, stage);
      startTranscript(api, player, npcId, PAGE, "looking-for-the-third-puppy");
      return;
    }
    if (stage === STAGE_OUTLAWS) {
      startTranscript(api, player, npcId, PAGE, "looking-for-the-third-puppy-periodically-while-fighting");
      return;
    }
    if (stage === STAGE_THIRD_PUPPY) {
      startTranscript(api, player, npcId, PAGE, "looking-for-the-third-puppy-talking-to-the-stray-dog-with-the-puppies");
      return;
    }
    return false;
  }

  function dismissStrayDog(event) {
    const { player, npcId } = event;
    if (!STRAY_DOG_NPC_IDS.has(npcId) || quest.isComplete(player)) return false;
    const stage = quest.getStage(player);
    if (stage < STAGE_DOG) return false;
    player.setAttribute(DOG_WAITING_ATTRIBUTE, true);
    syncDog(player, stage);
    startTranscript(api, player, npcId, PAGE, "cutscene-dismissing-the-stray-dog");
  }

  // ==========================================================================
  // Den objects
  // ==========================================================================

  function inspectDenObject(event, objectId, variant, bit) {
    const { player } = event;
    if (event.objectId !== objectId) return false;
    const stage = quest.getStage(player);
    if (quest.isComplete(player) || stage < STAGE_DOG) return false;
    const mask = inspectedMask(player) | bit;
    player.setAttribute(INSPECTED_ATTRIBUTE, mask);
    if (stage === STAGE_DOG && (mask & ALL_INSPECTED) === ALL_INSPECTED) {
      startTranscript(api, player, STRAY_DOG_NPC_ID, PAGE, "at-the-dog-s-house-after-inspecting-all-three-objects");
      setStage(player, STAGE_DEN);
      return;
    }
    startTranscript(api, player, STRAY_DOG_NPC_ID, PAGE, variant);
  }

  function inspectNewspaper(event) {
    return inspectDenObject(event, TORN_NEWSPAPER_OBJECT_ID, "at-the-dog-s-house-inspecting-the-torn-newspaper", BIT_NEWSPAPER);
  }

  function inspectChewedBox(event) {
    return inspectDenObject(event, CHEWED_BOX_OBJECT_ID, "at-the-dog-s-house-inspecting-the-chewed-box", BIT_CHEWED_BOX);
  }

  function inspectRoughBedding(event) {
    return inspectDenObject(event, ROUGH_BEDDING_OBJECT_ID, "at-the-dog-s-house-inspecting-the-rough-bedding", BIT_BEDDING);
  }

  // ==========================================================================
  // Transcript conditions
  // ==========================================================================

  function answerCondition(event) {
    if (!isQuestPage(event.pages)) return null;
    const { player, stepId } = event;
    switch (stepId) {
      case REQUIREMENTS_NOT_MET_CONDITION_ID:
        return craftingLevel(player) < CRAFTING_REQUIREMENT;
      case REQUIREMENTS_MET_CONDITION_ID:
        return craftingLevel(player) >= CRAFTING_REQUIREMENT;
      case CAT_NOT_DONE_CONDITION_ID:
      case GERTRUDE_CAT_NOT_DONE_CONDITION_ID:
        return !questComplete(player, GERTRUDES_CAT_KEY);
      case CAT_DONE_CONDITION_ID:
      case GERTRUDE_CAT_DONE_CONDITION_ID:
        return questComplete(player, GERTRUDES_CAT_KEY);
      case NO_SPACE_CUTSCENE_CONDITION_ID:
      case NO_SPACE_GOBLINS_CONDITION_ID:
      case NO_SPACE_OUTLAWS_CONDITION_ID:
      case NO_SPACE_SPANIEL_CONDITION_ID:
        return freeSlots(player) === 0;
      case HAS_SPACE_SPANIEL_CONDITION_ID:
        return freeSlots(player) > 0;
      case NO_FOLLOWER_CONDITION_ID:
        return !hasFollower(player);
      case HAS_FOLLOWER_CONDITION_ID:
        return hasFollower(player);
      case DOG_FOLLOWING_CONDITION_ID:
        return isDogFollowing(player);
      case DOG_NOT_FOLLOWING_CONDITION_ID:
        return !isDogFollowing(player);
      case GOT_GRAIN_CONDITION_ID:
        return hasItem(player, GRAIN_ITEM_ID);
      case NO_GRAIN_CONDITION_ID:
        return !hasItem(player, GRAIN_ITEM_ID);
      case GOT_FUR_CONDITION_ID:
        return hasAnyFur(player);
      case NO_FUR_CONDITION_ID:
        return !hasAnyFur(player);
      case GOT_NEEDLE_CONDITION_ID:
        return hasNeedle(player);
      case NO_NEEDLE_CONDITION_ID:
        return !hasNeedle(player);
      case GOT_THREAD_CONDITION_ID:
        return hasThreadOrCostumeNeedle(player);
      case NO_THREAD_CONDITION_ID:
        return !hasThreadOrCostumeNeedle(player);
      case MISSING_ITEMS_CONDITION_ID:
        return !hasCraftItems(player);
      case HAS_ITEMS_CONDITION_ID:
        return hasCraftItems(player);
      case MISSING_PUPPIES_CONDITION_ID:
        return quest.getStage(player) < STAGE_SECOND_PUPPY;
      case HAS_PUPPIES_CONDITION_ID:
        return quest.getStage(player) >= STAGE_SECOND_PUPPY;
      default:
        return null;
    }
  }

  // ==========================================================================
  // Dialogue events
  // ==========================================================================

  function handleStartHook(event) {
    const { player, npcId, hook } = event;
    if (hook !== START_HOOK || npcId !== TALIA_NPC_ID) return;
    if (quest.getStage(player) !== 0) return;
    if (craftingLevel(player) < CRAFTING_REQUIREMENT) return;
    setStage(player, STAGE_STARTED);
  }

  function handleChoice(event) {
    const { player, npcId, option } = event;
    if (npcId !== TALIA_NPC_ID || option !== "No.") return;
    if (quest.getStage(player) !== 0) return;
    player.setAttribute(TALIA_OFFERED_ATTRIBUTE, true);
  }

  function handleAction(event) {
    const { player, stepId } = event;
    if (ALWAYS_MESSAGE_STEPS.has(stepId)) {
      event.handled = true;
      if (event.text) player.sendMessage(event.text);
      return;
    }
    switch (stepId) {
      case FIRST_PUPPY_PICKUP_STEP:
        event.handled = true;
        if (event.text) player.sendMessage(event.text);
        setStage(player, STAGE_FIRST_PUPPY);
        return;
      case GIVE_STUFFED_DOG_STEP:
        player.getInventory().deleteNumber(STUFFED_DOG_ITEM_ID, 1);
        player.setAttribute(GOBLINS_LEFT_ATTRIBUTE, true);
        return;
      case GOBLINS_LEAVE_STEP:
        event.handled = true;
        if (event.text) player.sendMessage(event.text);
        syncGoblins(player, quest.getStage(player));
        return;
      case SECOND_PUPPY_PICKUP_STEP:
        event.handled = true;
        if (event.text) player.sendMessage(event.text);
        setStage(player, STAGE_SECOND_PUPPY);
        return;
      case OUTLAWS_APPROACH_STEP:
        event.handled = true;
        if (event.text) player.sendMessage(event.text);
        setStage(player, STAGE_OUTLAWS);
        return;
      case THIRD_PUPPY_PICKUP_STEP:
        event.handled = true;
        if (event.text) player.sendMessage(event.text);
        return;
      case GUARD_WALKS_IN_STEP:
      case QUEST_COMPLETE_STEP:
        event.handled = true;
        if (event.text) player.sendMessage(event.text);
        if (!quest.isComplete(player)) {
          quest.complete(player);
          syncNpcs(player);
        }
        return;
      default:
        return;
    }
  }

  // ==========================================================================
  // Outlaw fight
  // ==========================================================================

  function handleNpcDeath(event) {
    const player = event?.killer?.isPlayer?.() ? event.killer : null;
    if (!player) return;
    const bit = OUTLAW_BITS.get(event.npcId);
    if (!bit || quest.getStage(player) !== STAGE_OUTLAWS) return;
    const mask = outlawsKilledMask(player) | bit;
    player.setAttribute(OUTLAWS_KILLED_ATTRIBUTE, mask);
    if (mask !== ALL_OUTLAWS_KILLED) return;
    setStage(player, STAGE_THIRD_PUPPY);
    startTranscript(api, player, STRAY_DOG_NPC_ID, PAGE, "looking-for-the-third-puppy-after-killing-the-outlaws");
  }

  // ==========================================================================
  // Stuffed dog crafting
  // ==========================================================================

  function handleItemOnItem(event) {
    const { player, usedItemId, usedWithItemId } = event;
    const pair = new Set([usedItemId, usedWithItemId]);
    if (!pair.has(GRAIN_ITEM_ID) || ![...pair].some((itemId) => FUR_ITEM_IDS.has(itemId))) return;
    event.handled = true;
    if (quest.getStage(player) < STAGE_STUFFED_DOG || quest.isComplete(player)) return;
    if (hasItem(player, STUFFED_DOG_ITEM_ID)) {
      startTranscript(api, player, STRAY_DOG_NPC_ID, PAGE, "stuffed-dog-trying-to-craft-another-stuffed-dog");
      return;
    }
    if (!hasCraftItems(player)) {
      startTranscript(
        api,
        player,
        STRAY_DOG_NPC_ID,
        PAGE,
        "stuffed-dog-trying-to-make-the-stuffed-dog-with-one-or-more-items-missing"
      );
      return;
    }
    const furId = [...pair].find((itemId) => FUR_ITEM_IDS.has(itemId));
    if (furId === FOX_FUR_ITEM_ID) {
      api.sendMultiChatboxPrompt(
        player,
        "Which item would you like to craft?",
        "Stuffed dog.",
        () => craftStuffedDog(player, furId),
        "Small meat pouch.",
        () => {}
      );
      return;
    }
    api.sendMultiChatboxPrompt(
      player,
      "Craft a stuffed dog?",
      "Yes.",
      () => craftStuffedDog(player, furId),
      "No.",
      () => {}
    );
  }

  function craftStuffedDog(player, furId) {
    if (!hasCraftItems(player)) {
      player.sendMessage(
        "You do not have the required items to make a stuffed dog. You need grain, some fur, a needle and some thread."
      );
      return;
    }
    player.getInventory().deleteNumber(GRAIN_ITEM_ID, 1);
    player.getInventory().deleteNumber(furId, 1);
    if (!hasItem(player, COSTUME_NEEDLE_ITEM_ID)) player.getInventory().deleteNumber(THREAD_ITEM_ID, 1);
    player.getInventory().adds(STUFFED_DOG_ITEM_ID, 1);
    player.sendMessage("You create a stuffed dog. It will probably convince the goblins.");
  }

  // ==========================================================================
  // Session lifecycle
  // ==========================================================================

  function handleLogin({ player }) {
    installInspectObjects();
    syncNpcs(player);
    refreshQuestList(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    removeAllTracked(player);
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Talia asked me to find stray dogs for the shelter and Gertrude pointed</str>",
        "<str>me to a stray dog in Varrock whose puppies had been stolen.</str>",
        "<str>I rescued all three puppies from the goblins and the outlaws and</str>",
        "<str>reunited them with their mother at the Dog Shelter.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_THIRD_PUPPY) {
      return [
        "I rescued the last of the stray dog's puppies from the outlaws.",
        "",
        "I should bring them to <col=800000>Talia</col> at the Dog Shelter.",
      ];
    }
    if (stage >= STAGE_OUTLAWS) {
      return [
        "The stray dog led me to the outlaw camp north of the Cooks' Guild,",
        "where outlaws have cornered her last puppy.",
        "",
        "I must defeat the <col=800000>outlaws</col>.",
      ];
    }
    if (stage >= STAGE_SECOND_PUPPY) {
      return [
        "<str>The goblins traded me the second puppy for a stuffed dog.</str>",
        "",
        "Follow the <col=800000>stray dog</col> to find her last puppy.",
      ];
    }
    if (stage >= STAGE_STUFFED_DOG) {
      return [
        "<str>The goblins west of the Cooks' Guild took a puppy and want a</str>",
        "<str>stuffed dog in exchange.</str>",
        "",
        "Make a <col=800000>stuffed dog</col> from grain, fur, a needle",
        "and thread, then show it to <col=800000>Picklenose</col>.",
      ];
    }
    if (stage >= STAGE_FIRST_PUPPY) {
      return [
        "<str>I rescued one of the stray dog's puppies from a goblin near the</str>",
        "<str>Cooks' Guild. The goblins have taken the others.</str>",
        "",
        "I should talk to <col=800000>Picklenose</col> west of the Cooks' Guild.",
      ];
    }
    if (stage >= STAGE_DEN) {
      return [
        "<str>I followed the stray dog to her den and found her puppies are</str>",
        "<str>missing. She has caught their scent.</str>",
        "",
        "Follow the <col=800000>stray dog</col> to find her puppies.",
      ];
    }
    if (stage >= STAGE_DOG) {
      return [
        "<str>The guard said I should follow the stray dog.</str>",
        "",
        "Follow the <col=800000>stray dog</col> from the Varrock west bank",
        "to her den, then inspect the mess she shows you.",
      ];
    }
    if (stage >= STAGE_GERTRUDE) {
      return [
        "Gertrude said there are stray dogs near the west entrance to Varrock.",
        "",
        "I should find one and see how I can help it.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "Talia asked me to find stray dogs for the shelter.",
        "",
        "She suggested I speak to <col=800000>Gertrude</col>, whose house is",
        "near the western entrance to Varrock.",
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Talia</col> at the",
      "<col=800000>Dog Shelter</col>, south-west of the Edgeville Monastery.",
      "I need 15 Crafting.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.CRAFTING, 1000);
  }

  api.persistAttribute(TALIA_OFFERED_ATTRIBUTE);
  api.persistAttribute(INSPECTED_ATTRIBUTE);
  api.persistAttribute(DOG_WAITING_ATTRIBUTE);
  api.persistAttribute(THIRD_HUNT_ATTRIBUTE);
  api.persistAttribute(GOBLINS_LEFT_ATTRIBUTE);
  api.persistAttribute(OUTLAWS_KILLED_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "a_ruff_situation",
    name: "A Ruff Situation",
    varpId: VARP_DOGQUEST,
    varbitId: STAGE_VARBIT,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.CRAFTING.getIndex(), amount: 1000, label: "Crafting" }],
    otherRewards: ["Access to puppies, which can be grown into dogs"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onNpcInteraction("Talia", { "Talk-to": talkTalia });
  api.onNpcInteraction("Chase", { "Talk-to": talkChase });
  api.onNpcInteraction("Gertrude", { "Talk-to": talkGertrude });
  api.onNpcInteraction("Guard", { "Talk-to": talkQuestGuard });
  api.onNpcInteraction("Picklenose", { "Talk-to": talkGoblins });
  api.onNpcInteraction("Toetaller", { "Talk-to": talkGoblins });
  api.onNpcInteraction("Stray dog", { Interact: interactStrayDog, Dismiss: dismissStrayDog });
  api.onObjectInteraction("Torn newspaper", { Inspect: inspectNewspaper });
  api.onObjectInteraction("Chewed box", { Inspect: inspectChewedBox });
  api.onObjectInteraction("Rough bedding", { Inspect: inspectRoughBedding });
  api.onItemOnItem(handleItemOnItem);
  api.onNpcDeath(handleNpcDeath);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
