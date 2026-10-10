/**
 * Twilight's Promise (members).
 *
 * The words come from the "Twilight's Promise" transcript page (OSRS Wiki); this
 * plugin supplies the NPC variant selector, the start hook, the prose-condition
 * answers, the knight recruitment (bazaar amulet, cothon crate, colosseum spar,
 * pub escort), the crest hand-out, the Kualti Headquarters letter, the Regulus /
 * Renu quetzal travel and the Teomat cultist attack.
 *
 * The stage lives in varbit 9649 "vmq2" (varp 4076 "vmq2_primary", bits 0-6).
 * Evidence: scripts/lookup-gameval.ts varbit vmq2 -> varp=4076 bits=0-6; quest
 * dbrow 3512 ("Twilight's Promise", table 0) col 19 = 50 (completion stage) and
 * col 33 = [17, 30000] (Thieving, tenths); the cache's quest-transformer NPCs
 * 13372/13374 (Furia/Ennius) switch on varbit 9649 at 0-4 (outside the palace),
 * 13373/13375 at 12-38 (inside the palace), 13376 (Metzli, Civitas) at 4-8,
 * 13378/13381 (Itzla/Servius) at 8-12 and 13377 (Metzli, Teomat) at 24-44.
 * The sibling varbits are 9651 "vmq2_message_read", 9652 "vmq2_first_travel",
 * 9829 "vmq2_bazaar_knights", 9830 "vmq2_cothon_knight", 9831 "vmq2_pub_knights",
 * 9832 "vmq2_colosseum_knight", 9833 "vmq2_given_crest" and 9834 "vmq2_drunk_knight_vis".
 *
 * Stages (even checkpoints, aligned with the live quest's varbit values):
 *   0 not started, 2 started at the Tullus twins, 4 met Metzli (she is visible from 4;
 *   live checkpoint 6 "met, not asked" is not written by this plugin), 8 asked Metzli
 *   about the prince / crypt NPCs (13378/13381) and the crypt gate become available,
 *   10 heard the full plot, 12 return to the twins in the palace (palace NPCs 12-38),
 *   14 crest given / recruiting, 16-20 knight groups finished, 22 all six knights,
 *   24 search the Kualti Headquarters, 26 letter found, 28 judgement cutscene begins,
 *   30 cutscene ends, 32 Regulus Cento, 36 feed Renu, 38 travel to the Teomat,
 *   40 talk to prince Itzla, 42 talk to Metzli, 44 cultist attack, 46 cultists
 *   defeated, 50 complete.
 *
 * Source: OSRS Wiki "Twilight's Promise" page, quick guide, transcript and the cache
 * ids above. Rewards per the wiki: 1 Quest point, 3,000 Thieving XP, the Civitas illa
 * Fortis Teleport spell and the Quetzal Transport System.
 *
 * Gaps / approximations:
 *  - Quest-only NPC placements (the crypt prince/Servius, the inner-palace twins, the
 *    Teomat prince/Metzli, Mezan, Renu, the follower Azali and the 8 cultists) are
 *    per-player owner-only spawns (most have no npc-spawns.json entry, and the static
 *    ones sit at their non-quest spots). The field knights, Regulus, Metzli, Servius
 *    and the pickpocket citizen already have static spawns and are not respawned.
 *  - Cutscenes are dialogue only: no camera, no instancing, and multi-speaker lines
 *    (the knighting, the Teomat guards) share the chathead of the NPC being talked to.
 *    The two partial-cutscene relog variants are unreachable; the full judgement
 *    variant replays instead.
 *  - Azali's escort is a simplified owner-only follow (no follower-slot varp): she
 *    walks to the player, gives up when the player is more than 12 tiles away, and
 *    the "already has a follower" condition reads the Pets plugin's `pets:current`
 *    attribute. The "azali-occasionally" and "leaving-the-battle-area" flavour
 *    variants are unused.
 *  - The Quetzal Transport System interface (action step 0GSFPb) does not exist here;
 *    feeding Renu plays the wiki tail and Renu's Travel option teleports to the
 *    Teomat landing site (1440,3168,0), gated on stage 38+ (and kept after completion).
 *  - The letter's equal chance of being in either south-east chest is collapsed: both
 *    south-east chests (50865/50866) hand it over. Reading the letter sends a plain
 *    message (the transcript has no letter text) and sets varbit 9651.
 *  - Mezan's protection-prayer mechanic is not simulated; he is the cache's level 81
 *    12916 and simply has to be defeated.
 */
module.exports = function registerTwilightPromiseQuest(api) {
  const {
    GameObject,
    ItemIdentifiers,
    Location,
    MapObjects,
    NpcIdentifiers,
    ObjectDefinition,
    ObjectIdentifiers,
    ObjectManager,
    RegionManager,
    Skill,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  // Varp 4076 "vmq2_primary"; the stage is varbit 9649 "vmq2" (bits 0-6).
  const VARP_TWILIGHTS_PROMISE = 4076;
  const STAGE_VARBIT = 9649;
  const MESSAGE_READ_VARBIT = 9651;
  const FIRST_TRAVEL_VARBIT = 9652;
  const BAZAAR_VARBIT = 9829;
  const COTHON_VARBIT = 9830;
  const PUB_VARBIT = 9831;
  const COLOSSEUM_VARBIT = 9832;
  const CREST_VARBIT = 9833;
  const DRUNK_VIS_VARBIT = 9834;

  const PAGE = "Twilight's Promise";
  const START_HOOK = "quest:twilight-s-promise:start";
  const CHILDREN_OF_THE_SUN_KEY = "children_of_the_sun";
  const GARDEN_OF_DEATH_KEY = "the_garden_of_death";

  const STAGE_STARTED = 2;
  const STAGE_METZLI = 4;
  const STAGE_METZLI_ASKED = 6;
  const STAGE_CRYPT = 8;
  const STAGE_PRINCE = 10;
  const STAGE_TWINS = 12;
  const STAGE_RECRUIT = 14;
  const STAGE_KNIGHTS_1 = 16;
  const STAGE_KNIGHTS_2 = 18;
  const STAGE_KNIGHTS_3 = 20;
  const STAGE_JUDGEMENT = 22;
  const STAGE_HQ = 24;
  const STAGE_LETTER = 26;
  const STAGE_CUTSCENE = 28;
  const STAGE_CUTSCENE_DONE = 30;
  const STAGE_REGULUS = 32;
  const STAGE_FEED = 36;
  const STAGE_TRAVEL = 38;
  const STAGE_TEOMAT = 40;
  const STAGE_LIBRARY = 42;
  const STAGE_CULTISTS = 44;
  const STAGE_FINISH = 46;
  const STAGE_COMPLETE = 50;

  const FURIA_IDS = new Set([
    NpcIdentifiers.FURIA_TULLUS, // 12653
    NpcIdentifiers.FURIA_TULLUS_2, // 12890
    NpcIdentifiers.FURIA_TULLUS_3, // 12891
    NpcIdentifiers.FURIA_TULLUS_4, // 13718
    NpcIdentifiers.FURIA_TULLUS_10, // 14330
  ]);
  const ENNIUS_IDS = new Set([
    NpcIdentifiers.ENNIUS_TULLUS, // 12654
    NpcIdentifiers.ENNIUS_TULLUS_2, // 12892
    NpcIdentifiers.ENNIUS_TULLUS_3, // 12893
  ]);
  const TWIN_IDS = new Set([...FURIA_IDS, ...ENNIUS_IDS]);
  const METZLI_IDS = new Set([NpcIdentifiers.METZLI_TEOKAN_OF_RANUL]); // 12894
  const ITZLA_IDS = new Set([
    NpcIdentifiers.PRINCE_ITZLA_ARKAN, // 12650
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_2, // 12651
    NpcIdentifiers.PRINCE_ITZLA_ARKAN_24, // 14286
  ]);
  const SERVIUS_IDS = new Set([
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS, // 12652
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_2, // 12899
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_3, // 12900
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_4, // 12901
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_5, // 13694
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_6, // 14307
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_7, // 14374
    NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_8, // 14377
  ]);
  const BAZAAR_KNIGHT_IDS = new Set([
    NpcIdentifiers.KNIGHT_OF_VARLAMORE_3, // 12655
    NpcIdentifiers.KNIGHT_OF_VARLAMORE_4, // 12656
  ]);
  const COTHON_KNIGHT_IDS = new Set([NpcIdentifiers.KNIGHT_OF_VARLAMORE_5]); // 12657
  const PUB_KNIGHT_IDS = new Set([
    NpcIdentifiers.KNIGHT_OF_VARLAMORE_6, // 12658
    NpcIdentifiers.KNIGHT_OF_VARLAMORE_7, // 12659
  ]);
  const MEZAN_TALK_IDS = new Set([NpcIdentifiers.KNIGHT_OF_VARLAMORE_8]); // 12660, spawned
  const AZALI_DRUNK_NPC_ID = NpcIdentifiers.KNIGHT_OF_VARLAMORE_19; // 12912
  const AZALI_SOBER_NPC_ID = NpcIdentifiers.KNIGHT_OF_VARLAMORE_17; // 12910
  const MEZAN_FIGHT_NPC_ID = NpcIdentifiers.KNIGHT_OF_VARLAMORE_23; // 12916
  const CITIZEN_NPC_ID = NpcIdentifiers.CITIZEN_27; // 12929
  const REGULUS_IDS = new Set([
    NpcIdentifiers.REGULUS_CENTO_2, // 12884
    NpcIdentifiers.REGULUS_CENTO_3, // 12885
  ]);
  const RENU_IDS = new Set([
    NpcIdentifiers.RENU, // 13348
    NpcIdentifiers.RENU_2, // 13349
    NpcIdentifiers.RENU_3, // 13350
  ]);
  const RENU_FEED_NPC_ID = NpcIdentifiers.RENU_2; // 13349
  const RENU_TRAVEL_NPC_ID = NpcIdentifiers.RENU_3; // 13350
  const CULTIST_IDS = new Set([
    NpcIdentifiers.CULTIST, // 12918
    NpcIdentifiers.CULTIST_2, // 12919
    NpcIdentifiers.CULTIST_3, // 12920
    NpcIdentifiers.CULTIST_4, // 12921
    NpcIdentifiers.CULTIST_5, // 12922
    NpcIdentifiers.CULTIST_6, // 12923
  ]);

  const CREST_ITEM_ID = ItemIdentifiers.VARLAMORE_CREST; // 28973
  const LETTER_ITEM_ID = ItemIdentifiers.INCRIMINATING_LETTER; // 28974
  const FEED_ITEM_ID = ItemIdentifiers.QUETZAL_FEED; // 28975
  const AMULET_ITEM_ID = ItemIdentifiers.STOLEN_AMULET; // 28976
  const LETTER_ITEM_NAME = "Incriminating letter";

  const TEMPLE_GATE_OBJECT_ID = ObjectIdentifiers.GATE_295; // 50861 at 1698,9496
  const TEMPLE_GATE_OPEN_OBJECT_ID = ObjectIdentifiers.GATE_296; // 50862
  const HQ_CHEST_OBJECT_IDS = new Set([
    ObjectIdentifiers.CHEST_239, // 50863
    ObjectIdentifiers.CHEST_240, // 50864
    ObjectIdentifiers.CHEST_241, // 50865
    ObjectIdentifiers.CHEST_242, // 50866
    ObjectIdentifiers.CHEST_243, // 50867
    ObjectIdentifiers.CHEST_244, // 50868
  ]);
  const CORRECT_CHEST_OBJECT_IDS = new Set([
    ObjectIdentifiers.CHEST_241, // 50865
    ObjectIdentifiers.CHEST_242, // 50866
  ]);
  const COTHON_CRATE_OBJECT_ID = ObjectIdentifiers.CRATE_323; // 50870
  const COTHON_CRATES_OBJECT_ID = ObjectIdentifiers.CRATES_106; // 52432
  const COTHON_CRATE_TILE = { x: 1778, y: 3149 };
  const TEMPLE_GATE_TILE = { x: 1698, y: 9496 };
  const RENU_TILE = { x: 1703, y: 3139 };
  const SOBER_AZALI_TILE = { x: 1756, y: 3069 };
  const TEOMAT_LANDING = { x: 1440, y: 3168, z: 0 };
  const CRYPT_PRINCE_TILE = { x: 1685, y: 9514 };
  const CRYPT_SERVIUS_TILE = { x: 1686, y: 9514 };
  const TEOMAT_PRINCE_TILE = { x: 1454, y: 3173 };
  const TEOMAT_METZLI_TILE = { x: 1448, y: 3196 };
  const INNER_ENNIUS_TILE = { x: 1684, y: 3156 };
  const INNER_FURIA_TILE = { x: 1686, y: 3156 };
  const MEZAN_TILE = { x: 1805, y: 9522 };
  const CULTIST_TILES = [
    { x: 1443, y: 3196 },
    { x: 1444, y: 3194 },
    { x: 1448, y: 3194 },
    { x: 1449, y: 3193 },
    { x: 1450, y: 3194 },
    { x: 1454, y: 3195 },
    { x: 1454, y: 3196 },
    { x: 1455, y: 3196 },
  ];
  const CULTIST_SPAWN_IDS = [
    NpcIdentifiers.CULTIST,
    NpcIdentifiers.CULTIST_2,
    NpcIdentifiers.CULTIST_3,
    NpcIdentifiers.CULTIST_4,
    NpcIdentifiers.CULTIST_5,
    NpcIdentifiers.CULTIST_6,
    NpcIdentifiers.CULTIST,
    NpcIdentifiers.CULTIST_2,
  ];

  const FOUNTAIN_ZONE = { minX: 1754, maxX: 1760, minY: 3066, maxY: 3072, levels: [0] };

  const V_TWINS_START = "with-friends-like-these-talking-to-either-ennius-or-furia-tullus";
  const V_TWINS_STARTED =
    "with-friends-like-these-talking-to-either-ennius-or-furia-tullus-talking-to-either-again-after-starting-the-quest";
  const V_TWINS_WAIT = "with-friends-like-these-talking-to-either-ennius-or-furia-tullus-talking-to-either-again";
  const V_GATE_LOCKED =
    "with-friends-like-these-attempting-to-open-the-gate-in-the-temple-basement-before-talking-to-metzli";
  const V_METZLI_INTRO = "with-friends-like-these-talking-to-metzli-teokan-of-ranul";
  const V_METZLI_RETURN =
    "with-friends-like-these-talking-to-metzli-teokan-of-ranul-talking-to-metzli-before-asking-about-prince-itzla";
  const V_METZLI_AGAIN =
    "with-friends-like-these-talking-to-metzli-teokan-of-ranul-talking-to-metzli-again";
  const V_PRINCE = "with-friends-like-these-talking-to-prince-itzla-or-servius";
  const V_PRINCE_AGAIN =
    "with-friends-like-these-talking-to-prince-itzla-or-servius-talking-to-either-after-hearing-about-the-assassination-attempt";
  const V_PRINCE_TWINS =
    "with-friends-like-these-talking-to-prince-itzla-or-servius-talking-to-either-again";
  const V_TWINS_CREST = "oh-brother-talking-to-the-tullus-twins";
  const V_TWINS_RECRUITING = "oh-brother-talking-to-the-tullus-twins-talking-to-either-again";
  const V_BAZAAR = "oh-brother-arrun-and-claudia";
  const V_BAZAAR_PICKPOCKET = "oh-brother-arrun-and-claudia-pickpocketing-the-citizen";
  const V_BAZAAR_AGAIN =
    "oh-brother-arrun-and-claudia-talking-to-arrun-or-claudia-after-speaking-to-them-once";
  const V_BAZAAR_DONE = "oh-brother-arrun-and-claudia-talking-to-either-again-after-giving-the-amulet";
  const V_COTHON = "oh-brother-nel";
  const V_COTHON_BEFORE = "oh-brother-nel-searching-the-correct-crate-before-talking-to-nel";
  const V_COTHON_WRONG = "oh-brother-nel-searching-an-incorrect-crate";
  const V_COTHON_WRONG_PLURAL = "oh-brother-nel-searching-incorrect-crates";
  const V_COTHON_FOUND = "oh-brother-nel-searching-the-correct-crate";
  const V_COTHON_AGAIN = "oh-brother-nel-talking-to-nel-after-speaking-to-her-once";
  const V_COTHON_DONE = "oh-brother-nel-talking-to-her-again-after-finding-the-crate";
  const V_COTHON_ANY = "oh-brother-nel-searching-any-crate-after-nel-s-work-is-done";
  const V_COTHON_ANY_PLURAL = "oh-brother-nel-searching-any-crates-after-nel-s-work-is-done";
  const V_MEZAN = "oh-brother-mezan";
  const V_MEZAN_AGAIN = "oh-brother-mezan-talking-to-mezan-again";
  const V_MEZAN_FIGHT = "oh-brother-mezan-while-fighting-mezan";
  const V_MEZAN_DONE = "oh-brother-mezan-after-defeating-mezan";
  const V_PUB = "oh-brother-velam-and-azali";
  const V_PUB_FOLLOWING = "oh-brother-velam-and-azali-talking-to-velam-while-azali-is-following";
  const V_AZALI_FOLLOWING = "oh-brother-velam-and-azali-talking-to-azali-while-she-s-following-you";
  const V_AZALI_FOUNTAIN = "oh-brother-velam-and-azali-after-leading-azali-to-the-fountain";
  const V_AZALI_SOBER = "oh-brother-velam-and-azali-talking-to-azali-after-sobering-up";
  const V_VELAM_SOBER = "oh-brother-velam-and-azali-talking-to-velam-after-azali-sobered-up";
  const V_TWINS_JUDGEMENT = "oh-brother-judgement";
  const V_TWINS_HQ_REMIND = "oh-brother-judgement-talking-to-the-twins-again";
  const V_TWINS_LETTER = "oh-brother-judgement-talking-to-the-tullus-twins";
  const V_TWINS_REGULUS = "oh-brother-judgement-talking-to-either-again";
  const V_CHEST_WRONG =
    "oh-brother-judgement-searching-a-wrong-chest-or-the-correct-chest-before-and-after-the-quest";
  const V_CHEST = "oh-brother-judgement-searching-the-correct-chest";
  const V_REGULUS = "the-twilight-emissaries-talking-to-regulus";
  const V_REGULUS_AGAIN = "the-twilight-emissaries-talking-to-regulus-talking-to-regulus-again";
  const V_REGULUS_FED = "the-twilight-emissaries-talking-to-regulus-talking-to-regulus-after-feeding-renu";
  const V_METZLI_TEOMAT_WAIT = "the-twilight-emissaries-talking-to-metzli-before-speaking-to-the-prince";
  const V_METZLI_TEOMAT = "the-twilight-emissaries-talking-to-metzli";
  const V_PRINCE_TEOMAT_EARLY = "the-twilight-emissaries-talking-to-prince-itzla-without-speaking-to-regulus";
  const V_PRINCE_TEOMAT = "the-twilight-emissaries-talking-to-prince-itzla";
  const V_PRINCE_TEOMAT_AGAIN =
    "the-twilight-emissaries-talking-to-prince-itzla-talking-to-prince-itzla-or-servius-again";
  const V_AFTER_CULTISTS = "the-twilight-emissaries-after-defeating-the-cultists";
  const V_POST_QUEST = "post-quest-dialogue-talking-to-prince-itzla-arkan";

  const RECRUITS_ATTRIBUTE = "quest.twilights_promise.recruits";
  const FLAGS_ATTRIBUTE = "quest.twilights_promise.flags";
  const CULTIST_KILLS_ATTRIBUTE = "quest.twilights_promise.cultist-kills";
  const FLAG_MESSAGE_READ = 1 << 0;
  const FLAG_FIRST_TRAVEL = 1 << 1;
  const FLAG_FOLLOWING = 1 << 2;
  const FLAG_SOBERED = 1 << 3;
  const FLAG_TOO_FAST = 1 << 4;
  const FOLLOW_GIVE_UP_DISTANCE = 12;
  const METZLI_TEOMAT_MAX_X = 1600;

  const trackedNpcs = new WeakMap();
  const mezanFights = new WeakSet();
  const pendingVictory = new WeakSet();
  let gateOpened = false;
  let quest;

  // ==========================================================================
  // State helpers
  // ==========================================================================

  const held = (player, itemId) => player.getInventory().getAmount(itemId) >= 1;
  const inventoryFull = (player) => player.getInventory().isFull();

  function flags(player) {
    return Number(player.getAttribute(FLAGS_ATTRIBUTE)) || 0;
  }

  function hasFlag(player, flag) {
    return (flags(player) & flag) !== 0;
  }

  function setFlag(player, flag) {
    player.setAttribute(FLAGS_ATTRIBUTE, flags(player) | flag);
  }

  function clearFlag(player, flag) {
    player.setAttribute(FLAGS_ATTRIBUTE, flags(player) & ~flag);
  }

  function recruits(player) {
    return Number(player.getAttribute(RECRUITS_ATTRIBUTE)) || 0;
  }

  function recruit(player, index) {
    return (recruits(player) >> (2 * index)) & 3;
  }

  function setRecruit(player, index, value) {
    const shift = 2 * index;
    const packed = recruits(player);
    player.setAttribute(RECRUITS_ATTRIBUTE, (packed & ~(3 << shift)) | ((value & 3) << shift));
    player.getPacketSender().sendVarbit(
      [BAZAAR_VARBIT, COTHON_VARBIT, PUB_VARBIT, COLOSSEUM_VARBIT][index],
      value & 3
    );
    syncRecruitStage(player);
  }

  function finishedRecruits(player) {
    let count = 0;
    for (let index = 0; index < 4; index++) if (recruit(player, index) >= 3) count++;
    return count;
  }

  function syncRecruitStage(player) {
    const finished = finishedRecruits(player);
    if (finished === 0) return;
    if (finished === 4) advance(player, STAGE_JUDGEMENT);
    else advance(player, STAGE_RECRUIT + finished * 2);
  }

  function isQuestComplete(player, key) {
    const request = { player, key };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function hasFollower(player) {
    const current = player.getAttribute?.("pets:current");
    return current?.isRegistered?.() === true;
  }

  function isFollowing(player) {
    return hasFlag(player, FLAG_FOLLOWING);
  }

  function isQuestPage(pages) {
    return Array.isArray(pages) && pages.some((page) => page?.page === PAGE);
  }

  function playTranscript(player, npcId, variant) {
    startTranscript(api, player, npcId, PAGE, variant);
  }

  function syncSelfVarbits(player) {
    const sender = player.getPacketSender();
    sender.sendVarbit(BAZAAR_VARBIT, recruit(player, 0));
    sender.sendVarbit(COTHON_VARBIT, recruit(player, 1));
    sender.sendVarbit(PUB_VARBIT, recruit(player, 2));
    sender.sendVarbit(COLOSSEUM_VARBIT, recruit(player, 3));
    sender.sendVarbit(CREST_VARBIT, quest.getStage(player) >= STAGE_RECRUIT ? 1 : 0);
    sender.sendVarbit(MESSAGE_READ_VARBIT, hasFlag(player, FLAG_MESSAGE_READ) ? 1 : 0);
    sender.sendVarbit(FIRST_TRAVEL_VARBIT, hasFlag(player, FLAG_FIRST_TRAVEL) ? 1 : 0);
    sender.sendVarbit(
      DRUNK_VIS_VARBIT,
      isFollowing(player) ? 1 : hasFlag(player, FLAG_SOBERED) ? 2 : 0
    );
  }

  function advance(player, stage) {
    if (quest.getStage(player) >= stage) return;
    quest.setStage(player, stage);
    syncSelfVarbits(player);
    ensureQuestNpcs(player);
  }

  // ==========================================================================
  // Spawns
  // ==========================================================================

  function syncTracked(player, key, definition) {
    const tracked = trackedNpcs.get(player) ?? new Map();
    trackedNpcs.set(player, tracked);
    const existing = tracked.get(key);
    if (!definition) {
      if (existing?.isRegistered?.()) api.removeNpc(existing);
      if (existing) tracked.delete(key);
      return null;
    }
    if (existing?.isRegistered?.() && existing.getId?.() === definition.id) return existing;
    if (existing?.isRegistered?.()) api.removeNpc(existing);
    const npc = api.spawnNpc({ ...definition, owner: player, ownerOnly: true });
    if (npc) tracked.set(key, npc);
    return npc;
  }

  function removeTracked(player, key) {
    return syncTracked(player, key, null);
  }

  function tracked(player, key) {
    return trackedNpcs.get(player)?.get(key) ?? null;
  }

  function ensureQuestNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    const stage = quest.getStage(player);

    // The twins hand out the job from the palace at (1688/1686, 3139/3141);
    // the world shells there carry no Talk-to, so spawn owner-only copies.
    const palaceTwins = stage < STAGE_TWINS;
    syncTracked(player, "ennius-palace", palaceTwins
      ? { id: NpcIdentifiers.ENNIUS_TULLUS_2, x: 1688, y: 3139, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "furia-palace", palaceTwins
      ? { id: NpcIdentifiers.FURIA_TULLUS_2, x: 1686, y: 3141, z: 0, wanderRadius: 0 }
      : null);

    // The twins move inside the palace from stage 12 until the Teomat trip.
    const innerTwins = stage >= STAGE_TWINS && stage < STAGE_TRAVEL;
    syncTracked(player, "ennius-inner", innerTwins
      ? { id: NpcIdentifiers.ENNIUS_TULLUS_2, ...INNER_ENNIUS_TILE, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "furia-inner", innerTwins
      ? { id: NpcIdentifiers.FURIA_TULLUS_2, ...INNER_FURIA_TILE, z: 0, wanderRadius: 0 }
      : null);

    // Prince Itzla and Servius wait in the temple crypt for stages 8-11.
    const inCrypt = stage >= STAGE_CRYPT && stage < STAGE_TWINS;
    syncTracked(player, "itzla-crypt", inCrypt
      ? { id: NpcIdentifiers.PRINCE_ITZLA_ARKAN, ...CRYPT_PRINCE_TILE, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "servius-crypt", inCrypt
      ? { id: NpcIdentifiers.SERVIUS_TEOKAN_OF_RALOS_2, ...CRYPT_SERVIUS_TILE, z: 0, wanderRadius: 0 }
      : null);

    // The Teomat hosts the prince and Metzli from the travel onwards (post-quest too).
    const atTeomat = stage >= STAGE_TRAVEL;
    syncTracked(player, "itzla-teomat", atTeomat
      ? { id: NpcIdentifiers.PRINCE_ITZLA_ARKAN, ...TEOMAT_PRINCE_TILE, z: 0, wanderRadius: 0 }
      : null);
    syncTracked(player, "metzli-teomat", atTeomat
      ? { id: NpcIdentifiers.METZLI_TEOKAN_OF_RANUL, ...TEOMAT_METZLI_TILE, z: 0, wanderRadius: 0 }
      : null);

    // Mezan spars in the colosseum training room.
    const mezanStage = stage >= STAGE_RECRUIT && stage <= STAGE_KNIGHTS_3;
    const mezanValue = recruit(player, 3);
    if (!mezanStage || mezanValue >= 3) {
      removeTracked(player, "mezan");
      removeTracked(player, "mezan-fight");
    } else if (mezanValue === 2) {
      removeTracked(player, "mezan-fight");
      syncTracked(player, "mezan", { id: NpcIdentifiers.KNIGHT_OF_VARLAMORE_8, ...MEZAN_TILE, z: 0, wanderRadius: 0 });
    } else if (mezanFights.has(player)) {
      removeTracked(player, "mezan");
      syncTracked(player, "mezan-fight", { id: MEZAN_FIGHT_NPC_ID, ...MEZAN_TILE, z: 0, wanderRadius: 0 });
    } else {
      removeTracked(player, "mezan-fight");
      syncTracked(player, "mezan", { id: NpcIdentifiers.KNIGHT_OF_VARLAMORE_8, ...MEZAN_TILE, z: 0, wanderRadius: 0 });
    }

    // Renu is fed at stage 36 and offers travel from 38 on.
    const renuId = stage >= STAGE_TRAVEL ? RENU_TRAVEL_NPC_ID : stage >= STAGE_FEED ? RENU_FEED_NPC_ID : null;
    syncTracked(player, "renu", renuId ? { id: renuId, ...RENU_TILE, z: 0, wanderRadius: 0 } : null);

    // Drunk Azali follows during the escort, then waits sober at the fountain.
    if (isFollowing(player) && stage >= STAGE_RECRUIT && stage <= STAGE_KNIGHTS_3) {
      const here = player.getLocation();
      syncTracked(player, "azali-follow", {
        id: AZALI_DRUNK_NPC_ID,
        x: here.getX(),
        y: here.getY(),
        z: here.getZ(),
        wanderRadius: 0,
      });
    } else {
      removeTracked(player, "azali-follow");
    }
    const sober = recruit(player, 2) === 2;
    syncTracked(player, "azali-sober", sober
      ? { id: AZALI_SOBER_NPC_ID, ...SOBER_AZALI_TILE, z: 0, wanderRadius: 0 }
      : null);

    if (stage === STAGE_CULTISTS) ensureCultists(player);
    else clearCultists(player);
  }

  // ==========================================================================
  // Cultist attack
  // ==========================================================================

  function cultistKills(player) {
    return Number(player.getAttribute(CULTIST_KILLS_ATTRIBUTE)) || 0;
  }

  function ensureCultists(player) {
    const kills = cultistKills(player);
    const tracked = trackedNpcs.get(player) ?? new Map();
    trackedNpcs.set(player, tracked);
    let list = tracked.get("cultists");
    if (!Array.isArray(list)) {
      list = [];
      tracked.set("cultists", list);
    }
    for (let index = list.length; index < 8 - kills; index++) {
      const spot = CULTIST_TILES[kills + index];
      const npc = api.spawnNpc({
        id: CULTIST_SPAWN_IDS[kills + index],
        x: spot.x,
        y: spot.y,
        z: 0,
        wanderRadius: 0,
        owner: player,
        ownerOnly: true,
      });
      if (npc) list.push(npc);
    }
  }

  function clearCultists(player) {
    const tracked = trackedNpcs.get(player);
    const list = tracked?.get("cultists");
    if (!Array.isArray(list)) return;
    for (const npc of list) if (npc?.isRegistered?.()) api.removeNpc(npc);
    tracked.delete("cultists");
  }

  function removeCultist(player, npc) {
    const list = trackedNpcs.get(player)?.get("cultists");
    if (!Array.isArray(list)) return;
    const index = list.indexOf(npc);
    if (index >= 0) list.splice(index, 1);
  }

  function startCultistAttack(player) {
    if (quest.getStage(player) >= STAGE_CULTISTS) return;
    player.setAttribute(CULTIST_KILLS_ATTRIBUTE, 0);
    advance(player, STAGE_CULTISTS);
    ensureCultists(player);
  }

  function handleCultistDeath(event, killer) {
    if (event.npc?.getOwner?.() !== killer) return;
    removeCultist(killer, event.npc);
    const kills = cultistKills(killer) + 1;
    killer.setAttribute(CULTIST_KILLS_ATTRIBUTE, kills);
    if (kills >= 8) {
      advance(killer, STAGE_FINISH);
      clearCultists(killer);
      pendingVictory.add(killer);
    } else {
      ensureQuestNpcs(killer);
    }
  }

  // ==========================================================================
  // Variant selection
  // ==========================================================================

  function selectVariant(context) {
    const { npcId, player } = context;
    if (!player || !npcId) return null;
    if (TWIN_IDS.has(npcId)) return selectTwinVariant(player);
    if (METZLI_IDS.has(npcId)) return selectMetzliVariant(context, player);
    if (SERVIUS_IDS.has(npcId)) return selectServiusVariant(player);
    if (BAZAAR_KNIGHT_IDS.has(npcId)) return selectBazaarVariant(player);
    if (COTHON_KNIGHT_IDS.has(npcId)) return selectCothonVariant(player);
    if (MEZAN_TALK_IDS.has(npcId)) return selectMezanVariant(player);
    if (AZALI_DRUNK_NPC_ID === npcId) return selectAzaliVariant(player);
    if (AZALI_SOBER_NPC_ID === npcId) {
      finishPub(player);
      return V_AZALI_SOBER;
    }
    if (PUB_KNIGHT_IDS.has(npcId)) return selectPubVariant(player);
    if (REGULUS_IDS.has(npcId)) return selectRegulusVariant(player);
    return null;
  }

  function selectTwinVariant(player) {
    const stage = quest.getStage(player);
    if (stage === STAGE_JUDGEMENT) {
      advance(player, STAGE_HQ);
      return V_TWINS_JUDGEMENT;
    }
    if (stage >= STAGE_REGULUS) return V_TWINS_REGULUS;
    if (stage >= STAGE_HQ) {
      if (held(player, LETTER_ITEM_ID) || hasFlag(player, FLAG_MESSAGE_READ)) return V_TWINS_LETTER;
      return V_TWINS_HQ_REMIND;
    }
    if (stage >= STAGE_RECRUIT) return V_TWINS_RECRUITING;
    if (stage >= STAGE_TWINS) return V_TWINS_CREST;
    if (stage >= STAGE_STARTED) return V_TWINS_WAIT;
    return V_TWINS_START;
  }

  function selectMetzliVariant(context, player) {
    const stage = quest.getStage(player);
    const location = context.npc?.getLocation?.();
    const atTeomat = location ? location.getX() < METZLI_TEOMAT_MAX_X : false;
    if (atTeomat) return stage >= STAGE_LIBRARY ? V_METZLI_TEOMAT : V_METZLI_TEOMAT_WAIT;
    if (stage >= STAGE_METZLI_ASKED) return V_METZLI_AGAIN;
    if (stage === STAGE_STARTED) {
      advance(player, STAGE_METZLI);
      return V_METZLI_INTRO;
    }
    if (stage >= STAGE_METZLI) return V_METZLI_RETURN;
    return V_METZLI_INTRO;
  }

  function selectServiusVariant(player) {
    if (!quest.isStarted(player)) return null; // the standard "Servius, Teokan of Ralos" page
    const stage = quest.getStage(player);
    if (quest.isComplete(player)) return V_POST_QUEST;
    if (stage >= STAGE_TEOMAT) return V_PRINCE_TEOMAT_AGAIN;
    if (stage >= STAGE_TWINS) return V_PRINCE_TWINS;
    return V_PRINCE;
  }

  function selectBazaarVariant(player) {
    const value = recruit(player, 0);
    if (value >= 3) return V_BAZAAR_DONE;
    if (value >= 1) return V_BAZAAR_AGAIN;
    return V_BAZAAR;
  }

  function selectCothonVariant(player) {
    const value = recruit(player, 1);
    if (value >= 3) return V_COTHON_DONE;
    if (value === 2) {
      // Nel agrees to return once told about the Fortis Spark.
      setRecruit(player, 1, 3);
      return V_COTHON_AGAIN;
    }
    if (value === 1) return V_COTHON_AGAIN;
    return V_COTHON;
  }

  function selectMezanVariant(player) {
    const value = recruit(player, 3);
    if (value === 2) {
      // "You fought well in there... I'll head over there shortly."
      setRecruit(player, 3, 3);
      return V_MEZAN_DONE;
    }
    if (value === 1) return V_MEZAN_AGAIN;
    return V_MEZAN;
  }

  function selectAzaliVariant(player) {
    const value = recruit(player, 2);
    if (value >= 2) {
      finishPub(player);
      return V_AZALI_SOBER;
    }
    return V_AZALI_FOLLOWING;
  }

  function selectPubVariant(player) {
    const value = recruit(player, 2);
    if (value >= 2) {
      finishPub(player);
      return V_VELAM_SOBER;
    }
    if (value === 1 && isFollowing(player)) return V_PUB_FOLLOWING;
    return V_PUB;
  }

  function selectRegulusVariant(player) {
    if (!quest.isStarted(player)) return null; // the standard "Regulus Cento" quetzal dialogue
    const stage = quest.getStage(player);
    if (stage >= STAGE_TRAVEL || quest.isComplete(player)) return V_REGULUS_FED;
    if (stage >= STAGE_FEED) return V_REGULUS_AGAIN;
    return V_REGULUS;
  }

  function finishPub(player) {
    if (recruit(player, 2) === 2) {
      setRecruit(player, 2, 3);
      clearFlag(player, FLAG_SOBERED);
      removeTracked(player, "azali-sober");
      removeTracked(player, "azali-follow");
      syncSelfVarbits(player);
    }
  }

  // ==========================================================================
  // Prose conditions
  // ==========================================================================

  function answerCondition(event) {
    const { player, stepId } = event;
    if (!isQuestPage(event.pages)) return null;
    switch (stepId) {
      // "If the player has no inventory space:" (crest, letter, feed)
      case "Jwc6oN":
      case "UpukqI":
      case "3-gual":
      case "HtVsID":
      case "YcOYw7":
      case "ICTu93":
        return inventoryFull(player);
      case "zxDa7F":
      case "fFIaV6":
        return !inventoryFull(player);
      case "e6vbnR": // lost the Varlamore crest
        return quest.getStage(player) >= STAGE_RECRUIT && !held(player, CREST_ITEM_ID);
      case "CPKPtM":
      case "H6QjGy":
      case "8SXxJI":
      case "P67pO2":
        return !held(player, CREST_ITEM_ID);
      case "dzUYzM":
      case "vPKkGs":
      case "wdwt5t":
      case "8fYJOI":
        return held(player, CREST_ITEM_ID);
      case "MN8Uyn": // does not have the amulet
        return !held(player, AMULET_ITEM_ID);
      case "ufM8D1": // has the amulet
        return held(player, AMULET_ITEM_ID);
      case "OQXGae": // did not find the weapons crate
        return recruit(player, 1) < 2;
      case "A3sZDd": // found the weapons crate
        return recruit(player, 1) >= 2;
      case "1sNdXO": // already has a follower (a pet)
        return hasFollower(player);
      case "o4HOCh": // does not have a follower
        return !hasFollower(player);
      case "3coEs9": // Azali fell too far behind
        return hasFlag(player, FLAG_TOO_FAST);
      case "fXNTWu": // already holding the letter
        return held(player, LETTER_ITEM_ID);
      case "H8ndzT": // hasn't read the letter
        return !hasFlag(player, FLAG_MESSAGE_READ);
      case "EFAiy1": // no feed and has not fed Renu yet
        return !held(player, FEED_ITEM_ID) && !hasFlag(player, FLAG_FIRST_TRAVEL);
      case "NPlTJc": // no feed after feeding Renu once: Regulus replaces it
        return !held(player, FEED_ITEM_ID) && hasFlag(player, FLAG_FIRST_TRAVEL);
      case "Al2qgC": // has not completed The Garden of Death
        return !isQuestComplete(player, GARDEN_OF_DEATH_KEY);
      case "kmDUvy": // has completed The Garden of Death
        return isQuestComplete(player, GARDEN_OF_DEATH_KEY);
      default:
        return null;
    }
  }

  // ==========================================================================
  // Dialogue hooks
  // ==========================================================================

  function handleStartHook({ player, npcId, hook }) {
    if (hook !== START_HOOK || !TWIN_IDS.has(npcId)) return;
    if (quest.getStage(player) !== 0) return;
    if (!isQuestComplete(player, CHILDREN_OF_THE_SUN_KEY)) {
      player.sendMessage("You must have completed Children of the Sun to start this quest.");
      return;
    }
    player.setAttribute(RECRUITS_ATTRIBUTE, 0);
    player.setAttribute(FLAGS_ATTRIBUTE, 0);
    player.setAttribute(CULTIST_KILLS_ATTRIBUTE, 0);
    advance(player, STAGE_STARTED);
  }

  /** The prince's second conversation is a shortcut tail the engine's "above" jump cannot reach. */
  function handlePrinceTalk(event) {
    const { player, npcId } = event;
    if (!ITZLA_IDS.has(npcId)) return false;
    const stage = quest.getStage(player);
    if (stage === STAGE_CRYPT) {
      playTranscript(player, npcId, V_PRINCE);
      return true;
    }
    if (stage === STAGE_PRINCE) {
      playTranscript(player, npcId, V_PRINCE_AGAIN);
      advance(player, STAGE_TWINS);
      return true;
    }
    if (stage >= STAGE_TRAVEL) {
      const variant = stage === STAGE_TEOMAT ? V_PRINCE_TEOMAT : quest.isComplete(player) ? V_POST_QUEST : V_PRINCE_TEOMAT_AGAIN;
      playTranscript(player, npcId, variant);
      return true;
    }
    return false;
  }

  function handleDialogueChoice(event) {
    const { player, npcId, option } = event;
    if (METZLI_IDS.has(npcId) && option === "I'm meant to be meeting Prince Itzla here.") {
      if (quest.getStage(player) >= STAGE_STARTED && quest.getStage(player) < STAGE_CRYPT) {
        advance(player, STAGE_CRYPT);
      }
      return;
    }
    if (MEZAN_TALK_IDS.has(npcId) && option === "I'm ready. Let's do this.") {
      if (quest.getStage(player) >= STAGE_RECRUIT && quest.getStage(player) <= STAGE_KNIGHTS_3 && recruit(player, 3) === 1) {
        startMezanFight(player);
      }
    }
  }

  function handleDialogueLine(event) {
    const { player, npcId, text } = event;
    if (!player || !npcId) return;
    const line = String(text ?? "");
    if (line === "Timoiva, my child." && (ITZLA_IDS.has(npcId) || SERVIUS_IDS.has(npcId))) {
      if (quest.getStage(player) === STAGE_CRYPT) advance(player, STAGE_PRINCE);
      return;
    }
    if (line === "Right, I'll go and see if she can help me." && ITZLA_IDS.has(npcId)) {
      if (quest.getStage(player) === STAGE_TEOMAT) advance(player, STAGE_LIBRARY);
      return;
    }
    if (line.includes("I need you outside, now!") && METZLI_IDS.has(npcId)) {
      if (quest.getStage(player) >= STAGE_LIBRARY && quest.getStage(player) < STAGE_CULTISTS) {
        startCultistAttack(player);
      }
      return;
    }
    if (line === "Alright, I'll go and see Regulus." && TWIN_IDS.has(npcId)) {
      if (quest.getStage(player) === STAGE_CUTSCENE_DONE) advance(player, STAGE_REGULUS);
    }
  }

  function handleDialogueAction(event) {
    const { player, stepId } = event;
    switch (stepId) {
      // Furia hands over the Varlamore crest.
      case "Ev2lHZ":
      case "wqRY6L":
      case "xxd9qj":
        if (!held(player, CREST_ITEM_ID) && !inventoryFull(player)) {
          player.getInventory().adds(CREST_ITEM_ID, 1);
        }
        advance(player, STAGE_RECRUIT);
        return;
      // Knights show the crest; record the first contact.
      case "o6WA7o":
        if (recruit(player, 0) === 0) setRecruit(player, 0, 1);
        return;
      case "MvE-PO":
        if (recruit(player, 1) === 0) setRecruit(player, 1, 1);
        return;
      case "IsCa0z":
        if (recruit(player, 3) === 0) setRecruit(player, 3, 1);
        return;
      case "ZdVwjS":
        if (recruit(player, 2) === 0) setRecruit(player, 2, 1);
        if (recruit(player, 2) === 1 && !isFollowing(player) && !hasFollower(player)) startAzaliFollow(player);
        return;
      // Bazaar: pickpocket the amulet, give it back.
      case "D0l_R6":
        if (!held(player, AMULET_ITEM_ID) && !inventoryFull(player)) {
          player.getInventory().adds(AMULET_ITEM_ID, 1);
        }
        setRecruit(player, 0, 2);
        return;
      case "VgHiDe":
        if (held(player, AMULET_ITEM_ID)) player.getInventory().deleteNumber(AMULET_ITEM_ID, 1);
        setRecruit(player, 0, 3);
        return;
      // Cothon crate.
      case "ibPuw6":
        if (recruit(player, 1) < 2) setRecruit(player, 1, 2);
        return;
      // Azali escort.
      case "sqN3PN":
        clearFlag(player, FLAG_FOLLOWING);
        return;
      case "M9yTX1":
        setFlag(player, FLAG_FOLLOWING);
        clearFlag(player, FLAG_TOO_FAST);
        return;
      case "ktO5Kb":
        clearFlag(player, FLAG_FOLLOWING);
        setFlag(player, FLAG_SOBERED);
        clearFlag(player, FLAG_TOO_FAST);
        if (recruit(player, 2) < 2) setRecruit(player, 2, 2);
        removeTracked(player, "azali-follow");
        ensureQuestNpcs(player);
        return;
      // Kualti Headquarters chest.
      case "nUVL01":
        if (!held(player, LETTER_ITEM_ID) && !inventoryFull(player)) {
          player.getInventory().adds(LETTER_ITEM_ID, 1);
        }
        advance(player, STAGE_LETTER);
        return;
      // The judgement cutscene.
      case "yqVhSV":
        advance(player, STAGE_CUTSCENE);
        return;
      case "T86ZS5":
        advance(player, STAGE_CUTSCENE_DONE);
        return;
      // Regulus hands over the quetzal feed.
      case "V6x6Qr":
      case "2fRkv2":
        if (!held(player, FEED_ITEM_ID) && !inventoryFull(player)) {
          player.getInventory().adds(FEED_ITEM_ID, 1);
        }
        advance(player, STAGE_FEED);
        return;
      // Renu takes the feed; the transport system is not an interface here.
      case "OlyLnC":
        if (held(player, FEED_ITEM_ID)) player.getInventory().deleteNumber(FEED_ITEM_ID, 1);
        setFlag(player, FLAG_FIRST_TRAVEL);
        advance(player, STAGE_TRAVEL);
        ensureQuestNpcs(player);
        return;
      case "0GSFPb":
        event.handled = true;
        event.end = true;
        player.sendMessage("Renu is ready to take you to the Teomat.");
        return;
      case "NyygQH":
        quest.complete(player);
        return;
      default:
        return;
    }
  }

  // ==========================================================================
  // NPC interactions
  // ==========================================================================

  function startAzaliFollow(player) {
    setFlag(player, FLAG_FOLLOWING);
    clearFlag(player, FLAG_TOO_FAST);
    const here = player.getLocation();
    syncTracked(player, "azali-follow", {
      id: AZALI_DRUNK_NPC_ID,
      x: here.getX(),
      y: here.getY(),
      z: here.getZ(),
      wanderRadius: 0,
    });
    syncSelfVarbits(player);
  }

  function startMezanFight(player) {
    if (recruit(player, 3) !== 1) return;
    mezanFights.add(player);
    ensureQuestNpcs(player);
  }

  function handleCitizenPickpocket(event) {
    if (event.npcId !== CITIZEN_NPC_ID) return false;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_RECRUIT || stage > STAGE_KNIGHTS_3) return false;
    if (recruit(player, 0) < 1 || recruit(player, 0) >= 3) return false;
    event.handled = true;
    playTranscript(player, CITIZEN_NPC_ID, V_BAZAAR_PICKPOCKET);
    return true;
  }

  function handleFeedRenu(event) {
    const { player } = event;
    if (quest.getStage(player) !== STAGE_FEED) return;
    event.handled = true;
    if (!held(player, FEED_ITEM_ID)) {
      player.sendMessage("You need quetzal feed to do that.");
      return;
    }
    playFeedTail(player);
  }

  function playFeedTail(player) {
    startTranscript(api, player, RENU_FEED_NPC_ID, PAGE, V_REGULUS_AGAIN, (steps) => {
      const index = steps.findIndex((step) => step?.type === "unavailable");
      return index === -1 ? steps : steps.slice(index + 1);
    });
  }

  function handleTravelRenu(event) {
    const { player, npcId } = event;
    if (!RENU_IDS.has(npcId)) return;
    if (!quest.isComplete(player) && quest.getStage(player) < STAGE_TRAVEL) return;
    event.handled = true;
    player.moveTo(new Location(TEOMAT_LANDING.x, TEOMAT_LANDING.y, TEOMAT_LANDING.z));
    advance(player, STAGE_TEOMAT);
  }

  function handleNpcDeath(event) {
    const killer = event?.killer?.isPlayer?.() ? event.killer : null;
    if (!killer) return;
    if (event.npcId === MEZAN_FIGHT_NPC_ID) {
      if (event.npc?.getOwner?.() !== killer) return;
      mezanFights.delete(killer);
      if (recruit(killer, 3) !== 1) return;
      setRecruit(killer, 3, 2);
      removeTracked(killer, "mezan-fight");
      ensureQuestNpcs(killer);
      return;
    }
    if (CULTIST_IDS.has(event.npcId)) handleCultistDeath(event, killer);
  }

  function handlePlayerProcess({ player }) {
    if (!player || player.isPlayerBot?.() === true) return;
    if (pendingVictory.has(player)) {
      pendingVictory.delete(player);
      if (quest.getStage(player) >= STAGE_FINISH && !quest.isComplete(player)) {
        startTranscript(api, player, NpcIdentifiers.PRINCE_ITZLA_ARKAN, PAGE, V_AFTER_CULTISTS);
      }
      return;
    }
    if (!isFollowing(player)) return;
    const follower = tracked(player, "azali-follow");
    if (!follower?.isRegistered?.()) return;
    const here = player.getLocation();
    const there = follower.getLocation();
    const distance = Math.max(Math.abs(here.getX() - there.getX()), Math.abs(here.getY() - there.getY()));
    if (distance > FOLLOW_GIVE_UP_DISTANCE) {
      clearFlag(player, FLAG_FOLLOWING);
      setFlag(player, FLAG_TOO_FAST);
      removeTracked(player, "azali-follow");
      syncSelfVarbits(player);
      return;
    }
    const movement = follower.getMovementQueue();
    if (distance > 1 && !movement.hasPendingWork()) movement.addFirstStep(here);
  }

  function handleZoneEnter(event) {
    const { player } = event;
    if (!player || player.isPlayerBot?.() === true) return;
    if (!isFollowing(player)) return;
    if (quest.getStage(player) < STAGE_RECRUIT || quest.getStage(player) > STAGE_KNIGHTS_3) return;
    if (recruit(player, 2) !== 1) return;
    const follower = tracked(player, "azali-follow");
    if (!follower?.isRegistered?.()) return;
    playTranscript(player, AZALI_DRUNK_NPC_ID, V_AZALI_FOUNTAIN);
  }

  // ==========================================================================
  // Objects and items
  // ==========================================================================

  /** The crypt gate's open loc (50862) has no actions, so Doors cannot pair it. */
  function openTempleGate() {
    if (gateOpened) return;
    gateOpened = true;
    RegionManager.loadMapFiles(TEMPLE_GATE_TILE.x, TEMPLE_GATE_TILE.y);
    const objects = MapObjects.mapObjects.get(MapObjects.getHash(TEMPLE_GATE_TILE.x, TEMPLE_GATE_TILE.y, 0)) ?? [];
    for (const object of [...objects]) {
      if (object.getId() !== TEMPLE_GATE_OBJECT_ID) continue;
      ObjectManager.deregister(object, true);
      // The open loc is the same model turned a quarter; the closed face (3) blocks
      // the tile, the turned one (0) does not.
      ObjectManager.register(
        new GameObject(
          TEMPLE_GATE_OPEN_OBJECT_ID,
          new Location(TEMPLE_GATE_TILE.x, TEMPLE_GATE_TILE.y, 0),
          object.getType?.() ?? 0,
          ((object.getFace?.() ?? 0) + 1) & 3,
          null
        ),
        true
      );
    }
  }

  function handleGateOpen(event) {
    const location = event.location;
    if (event.objectId !== TEMPLE_GATE_OBJECT_ID) return false;
    if (!location || location.x !== TEMPLE_GATE_TILE.x || location.y !== TEMPLE_GATE_TILE.y) return false;
    event.handled = true;
    if (quest.getStage(event.player) < STAGE_METZLI) {
      startTranscript(
        api,
        event.player,
        NpcIdentifiers.ENNIUS_TULLUS,
        PAGE,
        V_GATE_LOCKED
      );
      return true;
    }
    openTempleGate();
    return true;
  }

  function handleDoorToggle(request) {
    if (request.handled) return;
    if (request.objectId !== TEMPLE_GATE_OBJECT_ID) return;
    const location = request.location;
    if (!location || location.x !== TEMPLE_GATE_TILE.x || location.y !== TEMPLE_GATE_TILE.y) return;
    request.handled = true;
    if (quest.getStage(request.player) < STAGE_METZLI) {
      startTranscript(api, request.player, NpcIdentifiers.ENNIUS_TULLUS, PAGE, V_GATE_LOCKED);
      return;
    }
    openTempleGate();
  }

  function handleCrateSearch(player, objectId, location) {
    const stage = quest.getStage(player);
    if (stage < STAGE_RECRUIT || stage > STAGE_KNIGHTS_3) return;
    const plural = objectId === COTHON_CRATES_OBJECT_ID;
    const correct =
      objectId === COTHON_CRATE_OBJECT_ID &&
      location &&
      location.x === COTHON_CRATE_TILE.x &&
      location.y === COTHON_CRATE_TILE.y;
    const value = recruit(player, 1);
    if (value >= 3) {
      playTranscript(player, NpcIdentifiers.KNIGHT_OF_VARLAMORE_5, plural ? V_COTHON_ANY_PLURAL : V_COTHON_ANY);
      return;
    }
    if (correct && value < 1) {
      playTranscript(player, NpcIdentifiers.KNIGHT_OF_VARLAMORE_5, V_COTHON_BEFORE);
      return;
    }
    if (correct && value < 2) {
      playTranscript(player, NpcIdentifiers.KNIGHT_OF_VARLAMORE_5, V_COTHON_FOUND);
      return;
    }
    if (correct) {
      playTranscript(player, NpcIdentifiers.KNIGHT_OF_VARLAMORE_5, V_COTHON_ANY);
      return;
    }
    playTranscript(player, NpcIdentifiers.KNIGHT_OF_VARLAMORE_5, plural ? V_COTHON_WRONG_PLURAL : V_COTHON_WRONG);
  }

  function handleChestOpen(player, objectId) {
    const stage = quest.getStage(player);
    if (stage < STAGE_HQ || stage >= STAGE_CUTSCENE) {
      playTranscript(player, NpcIdentifiers.ENNIUS_TULLUS, V_CHEST_WRONG);
      return;
    }
    if (CORRECT_CHEST_OBJECT_IDS.has(objectId)) {
      playTranscript(player, NpcIdentifiers.ENNIUS_TULLUS, V_CHEST);
      return;
    }
    playTranscript(player, NpcIdentifiers.ENNIUS_TULLUS, V_CHEST_WRONG);
  }

  function handleObjectInteraction(event) {
    const { player } = event;
    const definition = event.definition ?? ObjectDefinition.forPlayer(event.objectId, player);
    const objectId = definition?.id ?? event.objectId;
    if (objectId === COTHON_CRATE_OBJECT_ID || objectId === COTHON_CRATES_OBJECT_ID) {
      const stage = quest.getStage(player);
      if (stage < STAGE_RECRUIT || stage > STAGE_KNIGHTS_3) return;
      event.handled = true;
      handleCrateSearch(player, objectId, event.location);
      return;
    }
    if (HQ_CHEST_OBJECT_IDS.has(objectId)) {
      event.handled = true;
      handleChestOpen(player, objectId);
    }
  }

  function handleItemOnNpc(event) {
    const { player, itemId } = event;
    const npcId = event.npcId ?? event.target?.getId?.();
    if (!RENU_IDS.has(npcId) || itemId !== FEED_ITEM_ID) return;
    if (quest.getStage(player) !== STAGE_FEED) return;
    event.handled = true;
    playFeedTail(player);
  }

  function handleReadLetter(event) {
    if (event.itemId !== LETTER_ITEM_ID) return;
    event.handled = true;
    if (hasFlag(event.player, FLAG_MESSAGE_READ)) return;
    setFlag(event.player, FLAG_MESSAGE_READ);
    event.player.getPacketSender().sendVarbit(MESSAGE_READ_VARBIT, 1);
    event.player.sendMessage("You read the incriminating letter.");
  }

  // ==========================================================================
  // Login / logout
  // ==========================================================================

  function handleLogin({ player }) {
    ensureQuestNpcs(player);
    syncSelfVarbits(player);
    refreshQuestList(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    const tracked = trackedNpcs.get(player);
    if (tracked) {
      for (const npc of tracked.values()) {
        if (Array.isArray(npc)) {
          for (const entry of npc) if (entry?.isRegistered?.()) api.removeNpc(entry);
        } else if (npc?.isRegistered?.()) {
          api.removeNpc(npc);
        }
      }
      trackedNpcs.delete(player);
    }
    mezanFights.delete(player);
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Prince Itzla asked me to investigate the knights who plotted</str>",
        "<str>against Servius, and I found Velam's incriminating letter.</str>",
        "<str>At the Teomat the cultists attacked and gravely wounded Servius.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_CULTISTS) {
      return [
        "The Twilight Emissaries attacked the Teomat.",
        "",
        "I must defeat the eight <col=800000>cultists</col> outside.",
      ];
    }
    if (stage >= STAGE_LIBRARY) {
      return ["I should speak to <col=800000>Metzli</col> in the northern building", "of the Teomat."];
    }
    if (stage >= STAGE_TEOMAT) {
      return ["I travelled to the Teomat with Renu.",
        "", "I should speak to <col=800000>Prince Itzla Arkan</col> in the temple."];
    }
    if (stage >= STAGE_TRAVEL) {
      return ["Renu is fed and ready.", "",
        "I should travel to the <col=800000>Teomat</col> and speak to the prince."];
    }
    if (stage >= STAGE_FEED) {
      return ["Regulus Cento gave me some <col=800000>quetzal feed</col>.",
        "", "I should feed it to <col=800000>Renu</col> outside the palace."];
    }
    if (stage >= STAGE_REGULUS) {
      return ["Ennius killed Velam before he could be questioned.",
        "", "I should speak to <col=800000>Regulus Cento</col> about travelling to the Teomat."];
    }
    if (stage >= STAGE_CUTSCENE) {
      return ["A cutscene played out at the palace and Velam was executed.",
        "", "I should finish speaking to the <col=800000>Tullus twins</col>."];
    }
    if (stage >= STAGE_LETTER) {
      const lines = ["I found an incriminating letter in the Kualti Headquarters."];
      if (!hasFlag(player, FLAG_MESSAGE_READ)) lines.push("", "I should read it.");
      else lines.push("", "I should take it to <col=800000>Ennius and Furia</col> in the palace.");
      return lines;
    }
    if (stage >= STAGE_HQ) {
      return ["The twins told me the knights stayed in the <col=800000>Kualti",
        "Headquarters</col> west of the palace.",
        "", "I should search the chests on the top floor for evidence."];
    }
    if (stage >= STAGE_JUDGEMENT) {
      return ["All six knights have agreed to return to the palace.",
        "", "I should speak to <col=800000>Ennius and Furia</col>."];
    }
    if (stage >= STAGE_RECRUIT) {
      return [
        `I have returned ${finishedRecruits(player)} of the four groups of knights:`,
        "<col=800000>Arrun and Claudia</col> (bazaar), <col=800000>Nel</col> (cothon),",
        "<col=800000>Mezan</col> (colosseum) and <col=800000>Velam and Azali</col> (pub).",
      ];
    }
    if (stage >= STAGE_TWINS) {
      return ["The prince suspects one of the delegation's knights.",
        "", "I should speak to the <col=800000>Tullus twins</col> in the palace."];
    }
    if (stage >= STAGE_CRYPT) {
      return ["I met the prince in the temple crypt.",
        "", "I should speak to <col=800000>Prince Itzla</col> about the investigation."];
    }
    if (stage >= STAGE_METZLI_ASKED) {
      return ["Metzli said the prince is in the crypt below the temple.",
        "", "I should enter the crypt and find <col=800000>Prince Itzla</col>."];
    }
    if (stage >= STAGE_METZLI) {
      return ["I should speak to <col=800000>Metzli</col> in the temple about",
        "the prince."];
    }
    if (stage >= STAGE_STARTED) {
      return ["The Tullus twins told me the prince is waiting at the temple",
        "beyond the bazaar in Civitas illa Fortis."];
    }
    return [
      "I can start this quest by talking to <col=800000>Ennius</col> or",
      "<col=800000>Furia Tullus</col> in front of the Sunrise Palace.",
      "",
      "I need to have completed Children of the Sun.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.THIEVING, 3000);
  }

  api.persistAttribute(RECRUITS_ATTRIBUTE);
  api.persistAttribute(FLAGS_ATTRIBUTE);
  api.persistAttribute(CULTIST_KILLS_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "twilights_promise",
    name: "Twilight's Promise",
    varpId: VARP_TWILIGHTS_PROMISE,
    varbitId: STAGE_VARBIT,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.THIEVING.getIndex(), amount: 3000, label: "Thieving" }],
    otherRewards: [
      "Ability to use the Civitas illa Fortis Teleport spell",
      "Ability to use the Quetzal Transport System",
    ],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleDialogueChoice);
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onCustomEvent("door:toggle", handleDoorToggle);
  api.onNpcInteraction("Prince Itzla Arkan", { "Talk-to": handlePrinceTalk });
  api.onNpcInteraction("Citizen", { Pickpocket: handleCitizenPickpocket });
  api.onNpcInteraction("Renu", { Feed: handleFeedRenu, Travel: handleTravelRenu });
  api.onObjectInteraction("Gate", { Open: handleGateOpen });
  api.onObjectInteraction(handleObjectInteraction);
  api.onItemOnNpc(handleItemOnNpc);
  api.onItemAction(LETTER_ITEM_NAME, { Read: handleReadLetter });
  api.onNpcDeath(handleNpcDeath);
  api.onPlayerProcess(handlePlayerProcess);
  api.onZoneEnter(FOUNTAIN_ZONE, handleZoneEnter);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
