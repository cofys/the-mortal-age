/**
 * Wanted! (members).
 *
 * The words come from the "Wanted!" transcript page (npc-dialogues.json); this
 * plugin supplies the variant selectors for Sir Tiffy Cashien (4687), Sir Amik
 * Varze (4771, shared) and Lord Daquarius (4929), the prose-condition answers,
 * the CommOrb (item 6635) Contact/Scan/Playback actions, the seven-stop trail,
 * the Solus fight and the completion hand-in. Sir Amik, Sir Tiffy and Lord
 * Daquarius are all Talk-to'd through quest-scoped name hooks (the same pattern
 * My Arm's Big Adventure uses for Burntmeat): while this quest is active the
 * Wanted page is played explicitly with startTranscript so Black Knights'
 * Fortress / Recruitment Drive selectors and the shared id-index pages cannot
 * shadow it; when the quest is not active the hooks return false and those
 * other conversations run untouched.
 *
 * Stages (varbit 1051 "wanted_main", bits 0-10 of varp 571 "quest_wanted";
 * confirmed with `ts-node scripts/lookup-gameval.ts varbit wanted`):
 *   0 not started, 1 Sir Tiffy briefed (see Sir Amik),
 *   2 squireship offer answered (see Tiffy for a crisis), 3 crisis arranged,
 *   4 deputised (see Tiffy for equipment), 5 CommOrb obtained (contact Savant),
 *   6 Savant briefed (see Lord Daquarius), 7 Daquarius refuses (kill a Black
 *   Knight), 8 fur clue (see the Zamorakian mage), 9 the mage's price (20
 *   essence), 10 Solus went east (go to Canifis), 11 scanning the trail,
 *   12 Solus defeated (take his hat to Sir Amik), 13 complete.
 *
 * The trail (persisted "quest.wanted.mission"): 1 Canifis, 2 Rellekka,
 * 3 Champions' Guild, 4 Wizards' Tower, 5 Dorgesh-Kaan mine, 6 Castle Wars,
 * 7 rune essence mine. OSRS picks missions 2, 4 and 6 at random from fifteen
 * locations; this implementation fixes them to Rellekka (Fremennik cloak),
 * Wizards' Tower (blue wizard hat) and Castle Wars (Castle Wars ticket) so the
 * trail is deterministic, with the fixed blue cape/bone spear/essence clues
 * landing on the Champions' Guild, Dorgesh-Kaan and rune essence mine stops as
 * on the wiki.
 *
 * Source: OSRS Wiki "Wanted!" and "Transcript:Wanted!"; cache ids from the
 * generated identifiers and scripts/lookup-gameval.ts. Rewards per the Wiki:
 * 1 Quest point, 5,000 Slayer XP and access to the White Knights' armoury.
 *
 * Gaps / approximations:
 *   - Missions 2, 4 and 6 are fixed rather than randomly picked (above).
 *   - The CommOrb "Playback" log plays only the two Solus observation records;
 *     the dossiers are wiki sub-pages the transcript dump could not expand.
 *   - The Black Knight kill that intimidates Daquarius counts anywhere, not
 *     only inside his Taverley room (the wiki's leave-the-room rule is not
 *     modelled).
 *   - The second and fourth scans teleport the player to Camelot / outside
 *     Falador Castle but Solus deals no damage (no death edge case).
 *   - Solus's hat is only received when there is inventory room, per the wiki.
 *   - OSRS loops Asgarnian ale if the player accepts the squireship; here either
 *     reply ("Yes please!" / "No, not right now...") at the offer advances to
 *     the crisis plan, with Tiffy playing his "after agreeing to be Amik's
 *     squire" variant when the player accepted. A completed player falls
 *     through to Sir Tiffy's own transcript page.
 */
module.exports = function registerWantedQuest(api) {
  const { ItemIdentifiers, Location, NpcIdentifiers, Skill } = api.core;
  const { loadTranscripts, refreshQuestList, registerQuest, startTranscript } = require("../QuestRuntime");

  const PAGE = "Wanted!";
  const VARP_WANTED = 571; // "quest_wanted"
  const VARBIT_WANTED_MAIN = 1051; // "wanted_main", varp 571 bits 0-10

  const LOST_TRIBE_QUEST_KEY = "the_lost_tribe";
  const RECRUITMENT_DRIVE_QUEST_KEY = "recruitment_drive";

  const STAGE_STARTED = 1;
  const STAGE_DECLINED = 2;
  const STAGE_CRISIS = 3;
  const STAGE_MISSION = 4;
  const STAGE_COMMORB = 5;
  const STAGE_CONTACTED = 6;
  const STAGE_DAQUARIUS = 7;
  const STAGE_FUR = 8;
  const STAGE_MAGE_DEAL = 9;
  const STAGE_EAST = 10;
  const STAGE_HUNT = 11;
  const STAGE_DEFEATED = 12;
  const STAGE_COMPLETE = 13;

  const MISSION_CANIFIS = 1;
  const MISSION_RELLEKKA = 2;
  const MISSION_CHAMPIONS_GUILD = 3;
  const MISSION_WIZARDS_TOWER = 4;
  const MISSION_DORGESHUUN_MINE = 5;
  const MISSION_CASTLE_WARS = 6;
  const MISSION_RUNE_ESSENCE_MINE = 7;

  const SIR_TIFFY_CASHIEN_NPC_ID = NpcIdentifiers.SIR_TIFFY_CASHIEN; // 4687
  const SIR_AMIK_VARZE_NPC_ID = NpcIdentifiers.SIR_AMIK_VARZE_4; // 4771
  const LORD_DAQUARIUS_NPC_ID = NpcIdentifiers.LORD_DAQUARIUS; // 4929
  const MAGE_OF_ZAMORAK_NPC_ID = NpcIdentifiers.MAGE_OF_ZAMORAK; // 2580
  const SAVANT_NPC_ID = NpcIdentifiers.SAVANT; // 4931
  const SOLUS_DELLAGAR_NPC_ID = NpcIdentifiers.SOLUS_DELLAGAR; // 4930
  const SOLUS_DELLAGAR_FIGHT_NPC_ID = NpcIdentifiers.SOLUS_DELLAGAR_3; // 4962
  const BLACK_KNIGHT_SUMMONED_NPC_ID = NpcIdentifiers.BLACK_KNIGHT_6; // 4959
  const TAVERLEY_BLACK_KNIGHT_IDS = new Set([
    NpcIdentifiers.BLACK_KNIGHT_2, // 516
    NpcIdentifiers.BLACK_KNIGHT_3, // 517
    NpcIdentifiers.BLACK_KNIGHT_4, // 4331
  ]);

  const COMMORB_ITEM_ID = ItemIdentifiers.COMMORB; // 6635
  const SOLUSS_HAT_ITEM_ID = ItemIdentifiers.SOLUSS_HAT; // 6636
  const COINS_ITEM_ID = ItemIdentifiers.COINS; // 995
  const LAW_RUNE_ITEM_ID = ItemIdentifiers.LAW_RUNE; // 563
  const ENCHANTED_GEM_ITEM_ID = ItemIdentifiers.ENCHANTED_GEM; // 4155
  const MOLTEN_GLASS_ITEM_ID = ItemIdentifiers.MOLTEN_GLASS; // 1775
  const RUNE_ESSENCE_ITEM_ID = ItemIdentifiers.RUNE_ESSENCE; // 1436
  const PURE_ESSENCE_ITEM_ID = ItemIdentifiers.PURE_ESSENCE; // 7936
  const NOTED_RUNE_ESSENCE_ITEM_ID = ItemIdentifiers.RUNE_ESSENCE_2; // 1437, noted
  const FREMENNIK_PURPLE_CLOAK_ITEM_ID = ItemIdentifiers.FREMENNIK_PURPLE_CLOAK; // 3785
  const BLUE_CAPE_ITEM_ID = ItemIdentifiers.BLUE_CAPE; // 1021
  const BLUE_WIZARD_HAT_ITEM_ID = ItemIdentifiers.BLUE_WIZARD_HAT; // 579
  const BONE_SPEAR_ITEM_ID = ItemIdentifiers.BONE_SPEAR; // 5016
  const CASTLE_WARS_TICKET_ITEM_ID = ItemIdentifiers.CASTLE_WARS_TICKET; // 4067
  const INITIATE_ARMOUR_ITEM_IDS = new Set([
    ItemIdentifiers.INITIATE_SALLET, // 5574
    ItemIdentifiers.INITIATE_HAUBERK, // 5575
    ItemIdentifiers.INITIATE_CUISSE, // 5576
  ]);

  // Transcript variants on the "Wanted!" page.
  const V_TIFFY_START = "starting-off";
  const V_TIFFY_CONTINUE = "starting-off-continuing-the-dialogue";
  const V_TIFFY_SQUIRE_FIX = "falador-park-the-crisis-talking-to-sir-tiffy-after-agreeing-to-be-amik-s-squire";
  const V_TIFFY_CRISIS = "falador-park-the-crisis-talking-to-sir-tiffy-after-declining-to-be-amik-s-squire";
  const V_TIFFY_BEFORE_AMIK = "falador-park-the-crisis-talking-to-sir-tiffy-before-revisiting-sir-amik";
  const V_TIFFY_MISSION = "falador-park-mission-details";
  const V_TIFFY_BEFORE_USE = "falador-park-mission-details-talking-to-tiffy-before-using-the-communication-orb";
  const V_TIFFY_ORB_LOST = "falador-park-mission-details-claiming-another-communication-orb-from-tiffy";
  const V_TIFFY_DONE = "completing-the-quest-talking-to-tiffy";
  const V_AMIK_FIRST = "falador-castle-first-visit-to-sir-amik";
  const V_AMIK_REFUSED = "falador-castle-first-visit-to-sir-amik-talking-to-sir-amik-after-refusing-to-become-his-squire";
  const V_AMIK_SECOND = "falador-castle-second-visit-to-sir-amik";
  const V_AMIK_MISSION = "falador-castle-second-visit-to-sir-amik-talking-to-sir-amik-after-agreeing-to-go-after-solus";
  const V_AMIK_DONE = "completing-the-quest-talking-to-sir-amik";
  const V_SAVANT_FIRST = "falador-park-mission-details-contacting-savant";
  const V_SAVANT_AGAIN = "falador-park-mission-details-contacting-savant-again";
  const V_SAVANT_PLAYBACK = "commorb-files-playback";
  const V_RECORD_1 = "commorb-files-playback-solus-observation-record-1";
  const V_RECORD_2 = "commorb-files-playback-solus-observation-record-2";
  const V_RECORD_DOSSIER = "commorb-files-playback-dossier-of-solus-dellagar";
  const V_SAVANT_CANIFIS_CALL = "approaching-canifis";
  const V_SAVANT_FAILING = "approaching-canifis-failing-scans";
  const V_SAVANT_HINT = "approaching-canifis-talking-to-savant-again";
  const V_SCAN_CANIFIS = "approaching-canifis-scanning-in-canifis";
  const V_SCAN_SECOND = "scanning-the-second-location";
  const V_SCAN_CHAMPIONS = "scanning-at-champion-s-guild";
  const V_SCAN_FOURTH = "scanning-the-fourth-location";
  const V_SCAN_DORGESHUUN = "scanning-in-dorgeshuun-mines";
  const V_SCAN_SIXTH = "scanning-the-sixth-location";
  const V_SCAN_SIXTH_DONE = "scanning-the-sixth-location-after-the-black-knight-is-defeated";
  const V_SCAN_FINAL = "rune-essence-mine-ending-the-hunt";
  const V_SCAN_FINAL_DONE = "rune-essence-mine-ending-the-hunt-after-defeating-solus";
  const V_SAVANT_HAT = "rune-essence-mine-ending-the-hunt-communicating-with-savant-after-defeating-solus";
  const V_DAQUARIUS = "lord-daquarius";
  const V_DAQUARIUS_BEFORE = "lord-daquarius-talking-to-lord-daquarius-again-before-killing-any-knights";
  const V_DAQUARIUS_STOP = "lord-daquarius-after-killing-a-black-knight";
  const V_DAQUARIUS_AFTER = "lord-daquarius-talking-to-lord-daquarius-after-killing-a-black-knight";
  const V_DAQUARIUS_LEARNED = "lord-daquarius-talking-to-lord-daquarius-after-learning-about-solus";
  const V_MAGE = "zamorakian-mage";
  const V_MAGE_DEAL = "zamorakian-mage-the-essence-deal";
  const V_MAGE_AGAIN = "zamorakian-mage-talking-to-the-mage-of-zamorak-again";

  const START_HOOK = "quest:wanted:start";

  const ZONE_LEVEL_0_ONLY = [0];
  const CANIFIS_ZONE = { minX: 3455, maxX: 3530, minY: 3455, maxY: 3520, levels: ZONE_LEVEL_0_ONLY };
  const RELLEKKA_ZONE = { minX: 2630, maxX: 2700, minY: 3635, maxY: 3690, levels: ZONE_LEVEL_0_ONLY };
  const CHAMPIONS_GUILD_ZONE = { minX: 3185, maxX: 3206, minY: 3351, maxY: 3371, levels: ZONE_LEVEL_0_ONLY };
  const WIZARDS_TOWER_ZONE = { minX: 3098, maxX: 3120, minY: 3153, maxY: 3178, levels: [0, 1, 2] };
  const DORGESHUUN_MINE_ZONE = { minX: 3280, maxX: 3390, minY: 9580, maxY: 9660, levels: ZONE_LEVEL_0_ONLY };
  const CASTLE_WARS_ZONE = { minX: 2420, maxX: 2460, minY: 3075, maxY: 3105, levels: ZONE_LEVEL_0_ONLY };
  const RUNE_ESSENCE_MINE_ZONE = { minX: 2880, maxX: 2950, minY: 4800, maxY: 4865, levels: ZONE_LEVEL_0_ONLY };
  const WHITE_KNIGHTS_CASTLE_ZONE = { minX: 2964, maxX: 2997, minY: 3333, maxY: 3356, levels: [0, 1, 2] };

  const CAMELOT_TILE = { x: 2757, y: 3477, z: 0 };
  const FALADOR_CASTLE_OUTSIDE_TILE = { x: 2977, y: 3338, z: 0 };
  const CHAPEL_TILE = { x: 3259, y: 3383, z: 0 };

  const MISSION_ZONE = {
    [MISSION_CANIFIS]: CANIFIS_ZONE,
    [MISSION_RELLEKKA]: RELLEKKA_ZONE,
    [MISSION_CHAMPIONS_GUILD]: CHAMPIONS_GUILD_ZONE,
    [MISSION_WIZARDS_TOWER]: WIZARDS_TOWER_ZONE,
    [MISSION_DORGESHUUN_MINE]: DORGESHUUN_MINE_ZONE,
    [MISSION_CASTLE_WARS]: CASTLE_WARS_ZONE,
    [MISSION_RUNE_ESSENCE_MINE]: RUNE_ESSENCE_MINE_ZONE,
  };

  // The clue Savant pulls off Solus at the end of each stop (mission N's clue
  // points at mission N+1; stop 7 has no next clue).
  const CLUE_BY_MISSION = {
    [MISSION_CANIFIS]: FREMENNIK_PURPLE_CLOAK_ITEM_ID,
    [MISSION_RELLEKKA]: BLUE_CAPE_ITEM_ID,
    [MISSION_CHAMPIONS_GUILD]: BLUE_WIZARD_HAT_ITEM_ID,
    [MISSION_WIZARDS_TOWER]: BONE_SPEAR_ITEM_ID,
    [MISSION_DORGESHUUN_MINE]: CASTLE_WARS_TICKET_ITEM_ID,
    [MISSION_CASTLE_WARS]: NOTED_RUNE_ESSENCE_ITEM_ID,
  };

  // Item condition id -> the mission whose clue that branch describes. Every
  // other clue condition on the page answers false so only the right branch shows.
  const TRUE_CONDITION_MISSION = new Map([
    ["Xhbln-", MISSION_CANIFIS],
    ["z3YtI9", MISSION_CANIFIS],
    ["Nx6niM", MISSION_RELLEKKA],
    ["YnbS1i", MISSION_CHAMPIONS_GUILD],
    ["A8CgM8", MISSION_CHAMPIONS_GUILD],
    ["pLYUGv", MISSION_WIZARDS_TOWER],
    ["DPRk5N", MISSION_DORGESHUUN_MINE],
    ["DjhHrd", MISSION_DORGESHUUN_MINE],
    ["lTnXsm", MISSION_CASTLE_WARS],
  ]);
  const ALL_CLUE_CONDITION_IDS = new Set([
    // First-run branches in "approaching-canifis-scanning-in-canifis".
    "WhEdiy", "YnbS1i", "jdDxg7", "xsrPZk", "HZgS0z", "TgXuG7", "CAIvwn",
    "ORbz7w", "DPRk5N", "Xhbln-", "fvpmF5", "2ZR-Ny", "A4f-N_", "ErFows", "j5Pacg",
    // "Current Assignment" recap branches in "approaching-canifis-talking-to-savant-again".
    "4znMoL", "A8CgM8", "wtbH4I", "VfLdkk", "7vXk1y", "CXVORn", "ISP8Fl",
    "54UVrf", "DjhHrd", "z3YtI9", "LDNa0G", "JAC5WU", "ZjlBeQ", "bUhFQQ",
    "HFiKqm", "uEBRbB", "Nx6niM", "pLYUGv", "lTnXsm",
  ]);
  const CLUE_MESSAGE_STEP_IDS = new Set([
    "sH7QJd", "VTgt8I", "Cv9NjI", "s_gm2c", "X-jLCw", "sjgyQZ", "yzrPqL",
    "YCBBF7", "yCYScL", "WB1yMP", "DjOVBv", "idUV-w", "f3dlmQ", "o_opbE", "NZOIUt",
  ]);

  const MISSION_ATTRIBUTE = "quest.wanted.mission";
  const SQUIRE_ATTRIBUTE = "quest.wanted.squire";
  const BLACK_KNIGHT_DEAD_ATTRIBUTE = "quest.wanted.black-knight-dead";

  let quest;
  /** Player -> owner-only quest spawns. */
  const mageByPlayer = new Map();
  const summonedKnightByPlayer = new Map();
  const solusByPlayer = new Map();
  /** Player -> "buy" | "make" for the current CommOrb purchase conversation. */
  const orbPathByPlayer = new Map();
  /** Players whose squireship entail branch still needs the Yes/No offer. */
  const squirePromptPlayers = new Set();
  let clueTailCache = null;

  function wantedVariant(variant) {
    return { page: PAGE, variant };
  }

  function hasItem(player, itemId, amount = 1) {
    return player.getInventory().getAmount(itemId) >= amount;
  }

  function hasHat(player) {
    return hasItem(player, SOLUSS_HAT_ITEM_ID);
  }

  function bankHasHat(player) {
    return Number(player.getBank?.()?.getAmount?.(SOLUSS_HAT_ITEM_ID) ?? 0) > 0;
  }

  function wearsInitiateArmour(player) {
    return player
      .getEquipment()
      .getValidItems()
      .some((item) => INITIATE_ARMOUR_ITEM_IDS.has(item.getId?.()));
  }

  function commorbComponents(player) {
    let count = 0;
    if (hasItem(player, LAW_RUNE_ITEM_ID)) count++;
    if (hasItem(player, ENCHANTED_GEM_ITEM_ID)) count++;
    if (hasItem(player, MOLTEN_GLASS_ITEM_ID)) count++;
    return count;
  }

  function essenceAmount(player) {
    return (
      player.getInventory().getAmount(RUNE_ESSENCE_ITEM_ID) +
      player.getInventory().getAmount(PURE_ESSENCE_ITEM_ID)
    );
  }

  function hasEssenceStack(player) {
    return hasItem(player, RUNE_ESSENCE_ITEM_ID, 20) || hasItem(player, PURE_ESSENCE_ITEM_ID, 20);
  }

  function getMission(player) {
    return Number(player.getAttribute(MISSION_ATTRIBUTE)) || 0;
  }

  function setMission(player, value) {
    player.setAttribute(MISSION_ATTRIBUTE, value | 0);
  }

  function squireJoke(player) {
    return Number(player.getAttribute(SQUIRE_ATTRIBUTE)) === 1;
  }

  function setSquireJoke(player, value) {
    player.setAttribute(SQUIRE_ATTRIBUTE, value ? 1 : 0);
  }

  function blackKnightDead(player) {
    return Number(player.getAttribute(BLACK_KNIGHT_DEAD_ATTRIBUTE)) === 1;
  }

  function setBlackKnightDead(player, value) {
    player.setAttribute(BLACK_KNIGHT_DEAD_ATTRIBUTE, value ? 1 : 0);
  }

  function questComplete(player, key) {
    const request = { player, key, complete: false };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function meetsRequirements(player) {
    return (
      questComplete(player, LOST_TRIBE_QUEST_KEY) &&
      questComplete(player, RECRUITMENT_DRIVE_QUEST_KEY)
    );
  }

  function inZone(player, zone) {
    const location = player.getLocation();
    return (
      zone.levels.includes(location.getZ()) &&
      location.getX() >= zone.minX &&
      location.getX() <= zone.maxX &&
      location.getY() >= zone.minY &&
      location.getY() <= zone.maxY
    );
  }

  function teleport(player, tile) {
    player.moveTo(new Location(tile.x, tile.y, tile.z));
  }

  /** Gives one clue and moves the trail on; a full inventory still advances. */
  function grantClue(player, itemId, mission, amount = 1) {
    if (getMission(player) !== mission) return;
    const inventory = player.getInventory();
    if (inventory.isFull() && inventory.getAmount(itemId) === 0) {
      player.sendMessage("Savant transfers the item, but you have no room for it.");
    } else {
      inventory.adds(itemId, amount);
    }
    setMission(player, mission + 1);
  }

  /** The item-branch list (conditions onward) of the Canifis scan variant. */
  function clueBranchSteps() {
    if (clueTailCache) return clueTailCache;
    const data = loadTranscripts(api);
    const raw = data?.[PAGE]?.variants?.[V_SCAN_CANIFIS];
    if (!Array.isArray(raw)) return [];
    const index = raw.findIndex((step) => step.type === "condition");
    clueTailCache = index >= 0 ? raw.slice(index) : [];
    return clueTailCache;
  }

  function ensureMageSpawned(player) {
    if (mageByPlayer.has(player)) return;
    const npc = api.spawnNpc({
      id: MAGE_OF_ZAMORAK_NPC_ID,
      x: CHAPEL_TILE.x,
      y: CHAPEL_TILE.y,
      z: CHAPEL_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) mageByPlayer.set(player, npc);
  }

  function clearMageSpawn(player) {
    const npc = mageByPlayer.get(player);
    if (npc) {
      api.removeNpc(npc);
      mageByPlayer.delete(player);
    }
  }

  function clearFightSpawns(player) {
    const knight = summonedKnightByPlayer.get(player);
    if (knight) {
      api.removeNpc(knight);
      summonedKnightByPlayer.delete(player);
    }
    const solus = solusByPlayer.get(player);
    if (solus) {
      api.removeNpc(solus);
      solusByPlayer.delete(player);
    }
  }

  function spawnSummonedKnight(player) {
    if (summonedKnightByPlayer.has(player)) return;
    const location = player.getLocation();
    const npc = api.spawnNpc({
      id: BLACK_KNIGHT_SUMMONED_NPC_ID,
      x: location.getX() + 1,
      y: location.getY(),
      z: location.getZ(),
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) summonedKnightByPlayer.set(player, npc);
  }

  function spawnSolus(player) {
    if (solusByPlayer.has(player)) return;
    const location = player.getLocation();
    const npc = api.spawnNpc({
      id: SOLUS_DELLAGAR_FIGHT_NPC_ID,
      x: location.getX() + 1,
      y: location.getY(),
      z: location.getZ(),
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) solusByPlayer.set(player, npc);
  }

  // ==========================================================================
  // Conversation selectors and Talk-to name hooks
  //
  // Sir Amik, Sir Tiffy and Lord Daquarius are shared NPCs: their id-index
  // pages and the earlier-loading Black Knights' Fortress / Recruitment Drive
  // selectors can otherwise win. Their Talk-to is claimed by name while this
  // quest is active and the Wanted variant is played explicitly, so the other
  // quests' pages cannot intercept; inactive players fall through to those
  // conversations untouched.
  // ==========================================================================

  function amikVariantKey(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED || stage >= STAGE_COMPLETE) return null;
    if (stage === STAGE_STARTED) return V_AMIK_FIRST;
    if (stage === STAGE_DECLINED) return V_AMIK_REFUSED;
    if (stage === STAGE_CRISIS) return V_AMIK_SECOND;
    if (stage < STAGE_DEFEATED) return V_AMIK_MISSION;
    return V_AMIK_DONE;
  }

  function selectAmik(player) {
    const variant = amikVariantKey(player);
    return variant ? wantedVariant(variant) : null;
  }

  function tiffyVariantKey(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return null;
    if (stage === 0) return meetsRequirements(player) ? V_TIFFY_START : null;
    if (stage === STAGE_STARTED) return V_TIFFY_CONTINUE;
    if (stage === STAGE_DECLINED) {
      quest.setStage(player, STAGE_CRISIS);
      if (squireJoke(player)) {
        setSquireJoke(player, false);
        return V_TIFFY_SQUIRE_FIX;
      }
      return V_TIFFY_CRISIS;
    }
    if (stage === STAGE_CRISIS) return V_TIFFY_BEFORE_AMIK;
    if (stage === STAGE_MISSION) {
      return hasItem(player, COMMORB_ITEM_ID) ? V_TIFFY_BEFORE_USE : V_TIFFY_MISSION;
    }
    if (!hasItem(player, COMMORB_ITEM_ID)) return V_TIFFY_ORB_LOST;
    return stage >= STAGE_DEFEATED ? V_TIFFY_DONE : V_TIFFY_BEFORE_USE;
  }

  function selectTiffy(player) {
    const variant = tiffyVariantKey(player);
    return variant ? wantedVariant(variant) : null;
  }

  function daquariusVariantKey(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_CONTACTED || stage >= STAGE_COMPLETE) return null;
    if (stage === STAGE_CONTACTED) {
      quest.setStage(player, STAGE_DAQUARIUS);
      return V_DAQUARIUS;
    }
    if (stage === STAGE_DAQUARIUS) {
      if (blackKnightDead(player)) {
        ensureMageSpawned(player);
        quest.setStage(player, STAGE_FUR);
        return V_DAQUARIUS_AFTER;
      }
      return V_DAQUARIUS_BEFORE;
    }
    return V_DAQUARIUS_LEARNED;
  }

  function selectDaquarius(player) {
    const variant = daquariusVariantKey(player);
    return variant ? wantedVariant(variant) : null;
  }

  function selectMage(player, stage) {
    if (stage === STAGE_FUR) return wantedVariant(V_MAGE);
    if (stage === STAGE_MAGE_DEAL) return wantedVariant(V_MAGE_DEAL);
    if (stage >= STAGE_EAST) return wantedVariant(V_MAGE_AGAIN);
    return null;
  }

  /** Plays a claimed Talk-to; false leaves the NPC to the other plugins. */
  function playClaimedVariant(player, npcId, variant) {
    if (!variant) return false;
    if (!startTranscript(api, player, npcId, PAGE, variant)) return false;
    return undefined;
  }

  function talkToAmik(event) {
    const { player, npcId } = event;
    if (!quest.isStarted(player) || quest.isComplete(player)) return false;
    return playClaimedVariant(player, npcId, amikVariantKey(player));
  }

  function talkToTiffy(event) {
    const { player, npcId } = event;
    if (quest.isComplete(player)) return false;
    if (quest.getStage(player) === 0 && !meetsRequirements(player)) return false;
    return playClaimedVariant(player, npcId, tiffyVariantKey(player));
  }

  function talkToDaquarius(event) {
    const { player, npcId } = event;
    return playClaimedVariant(player, npcId, daquariusVariantKey(player));
  }

  function selectVariant({ npcId, player }) {
    if (!player) return null;
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return null;
    if (npcId === SIR_AMIK_VARZE_NPC_ID) return selectAmik(player);
    if (npcId === SIR_TIFFY_CASHIEN_NPC_ID) return selectTiffy(player);
    if (npcId === LORD_DAQUARIUS_NPC_ID) return selectDaquarius(player);
    if (npcId === MAGE_OF_ZAMORAK_NPC_ID) return selectMage(player, stage);
    return null;
  }

  // ==========================================================================
  // Prose conditions
  // ==========================================================================

  function answerCondition({ npcId, player, stepId }) {
    if (!player || typeof stepId !== "string") return null;
    if (npcId === SIR_AMIK_VARZE_NPC_ID) {
      if (stepId === "ANzKYK") return false; // only routed here after asking Tiffy
      if (stepId === "w_d7ap") return wearsInitiateArmour(player);
      if (stepId === "OUdNKz") return hasHat(player);
      if (stepId === "T0nCk0") return !hasHat(player) && bankHasHat(player);
      if (stepId === "bv_oxV") return !hasHat(player) && !bankHasHat(player);
      return null;
    }
    if (npcId === SIR_TIFFY_CASHIEN_NPC_ID) {
      const components = commorbComponents(player);
      if (stepId === "Pih8D4") return player.getInventory().isFull();
      if (stepId === "vV_n5V") return !player.getInventory().isFull() && hasItem(player, COINS_ITEM_ID, 10000);
      if (stepId === "MklfQk") return components === 0;
      if (stepId === "r7GxEv") return components > 0 && components < 3;
      if (stepId === "WCsTWQ") return components === 3;
      if (stepId === "bre0MU") return components > 0 && components < 3;
      return null;
    }
    if (npcId === MAGE_OF_ZAMORAK_NPC_ID) {
      const essence = essenceAmount(player);
      if (stepId === "_jNeLm") return essence === 0;
      if (stepId === "7EAVsM") return essence > 0 && !hasEssenceStack(player);
      if (stepId === "V6Gbp-") return hasEssenceStack(player);
      return null;
    }
    if (npcId === SAVANT_NPC_ID && stepId === "6G5sML") {
      return !hasHat(player) && !bankHasHat(player);
    }
    if ((npcId === SOLUS_DELLAGAR_NPC_ID || npcId === SAVANT_NPC_ID) && ALL_CLUE_CONDITION_IDS.has(stepId)) {
      return TRUE_CONDITION_MISSION.get(stepId) === getMission(player);
    }
    return null;
  }

  // ==========================================================================
  // Dialogue side effects
  // ==========================================================================

  function handleHook({ player, npcId, hook }) {
    if (!player || npcId !== SIR_TIFFY_CASHIEN_NPC_ID) return;
    if (hook !== START_HOOK || quest.getStage(player) !== 0) return;
    if (!meetsRequirements(player)) return;
    quest.setStage(player, STAGE_STARTED);
  }

  function grantCommorbFromTiffy(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_MISSION || quest.isComplete(player) || hasItem(player, COMMORB_ITEM_ID)) return;
    if (stage === STAGE_MISSION) {
      const path = orbPathByPlayer.get(player);
      orbPathByPlayer.delete(player);
      if (path === "make") {
        player.getInventory().deleteNumber(LAW_RUNE_ITEM_ID, 1);
        player.getInventory().deleteNumber(ENCHANTED_GEM_ITEM_ID, 1);
        player.getInventory().deleteNumber(MOLTEN_GLASS_ITEM_ID, 1);
      } else if (hasItem(player, COINS_ITEM_ID, 10000)) {
        player.getInventory().deleteNumber(COINS_ITEM_ID, 10000);
      }
    }
    player.getInventory().adds(COMMORB_ITEM_ID, 1);
    if (stage === STAGE_MISSION) quest.setStage(player, STAGE_COMMORB);
  }

  function grantLostHat(player) {
    if (quest.getStage(player) !== STAGE_DEFEATED || hasHat(player) || bankHasHat(player)) return;
    if (!player.getInventory().isFull()) player.getInventory().adds(SOLUSS_HAT_ITEM_ID, 1);
  }

  function takeEssencePrice(player) {
    if (quest.getStage(player) !== STAGE_MAGE_DEAL) return;
    if (hasItem(player, PURE_ESSENCE_ITEM_ID, 20)) {
      player.getInventory().deleteNumber(PURE_ESSENCE_ITEM_ID, 20);
    } else if (hasItem(player, RUNE_ESSENCE_ITEM_ID, 20)) {
      player.getInventory().deleteNumber(RUNE_ESSENCE_ITEM_ID, 20);
    }
    quest.setStage(player, STAGE_EAST);
  }

  function handleLine(event) {
    const { player, npcId, text } = event;
    if (!player || typeof text !== "string") return;
    if (
      text.includes("Here, take this Communications Orb") ||
      text.includes("Here, take another")
    ) {
      grantCommorbFromTiffy(player);
      return;
    }
    if (npcId === SAVANT_NPC_ID && text.includes("I have sent you a duplicate")) {
      grantLostHat(player);
      return;
    }
    if (npcId === MAGE_OF_ZAMORAK_NPC_ID && text.includes("I have your essences right here")) {
      takeEssencePrice(player);
    }
  }

  /**
   * The entail branch of the squireship offer is parser-split from the Yes/No
   * node (a "shows other options" marker sits between them). The central runtime
   * now skips that marker, but if the flattened queue ever ends before the node
   * this fallback re-offers it once the chatbox is clear, so stage 1 -> 2 is
   * always reachable. Picking either reply (transcript node or fallback prompt)
   * runs through applySquireReply.
   */
  function applySquireReply(player, accepted) {
    squirePromptPlayers.delete(player);
    if (quest.getStage(player) !== STAGE_STARTED) return;
    setSquireJoke(player, accepted);
    quest.setStage(player, STAGE_DECLINED);
  }

  function openSquirePrompt(player) {
    if (quest.getStage(player) !== STAGE_STARTED) return;
    api.sendMultiChatboxPrompt(
      player,
      "Select an Option",
      "Yes please!",
      () => applySquireReply(player, true),
      "No, not right now...",
      () => applySquireReply(player, false)
    );
  }

  /** Runs done once the player's chatbox is clear (no dialogue, no prompt). */
  function waitForChatbox(player, done) {
    if (player.isRegistered?.() === false) return;
    const { CountdownTask, TaskManager, MultiChatboxPrompt } = api.core;
    if (!CountdownTask || !TaskManager) {
      done();
      return;
    }
    TaskManager.submit(
      new CountdownTask(player, 1, () => {
        if (player.isRegistered?.() === false) return;
        const prompt = MultiChatboxPrompt?.getPending?.(player) ?? null;
        if (player.getDialogueManager?.()?.isActive?.() === true || prompt !== null) {
          waitForChatbox(player, done);
          return;
        }
        done();
      })
    );
  }

  function armSquireFallback(player) {
    squirePromptPlayers.add(player);
    waitForChatbox(player, () => {
      if (!squirePromptPlayers.has(player)) return;
      squirePromptPlayers.delete(player);
      openSquirePrompt(player);
    });
  }

  function handleChoice(event) {
    const { player, npcId, option } = event;
    if (!player || typeof option !== "string") return;
    const text = option.toLowerCase();
    if (npcId === SIR_AMIK_VARZE_NPC_ID) {
      if (quest.getStage(player) === STAGE_STARTED) {
        if (text.includes("what does being a squire entail")) {
          armSquireFallback(player);
          return;
        }
        // The squireship offer: either reply moves on to the crisis plan (OSRS
        // loops Asgarnian ale for "Yes please!"; see the header gap).
        if (text.includes("yes please")) {
          applySquireReply(player, true);
        } else if (text.includes("no, not right now")) {
          applySquireReply(player, false);
        }
        return;
      }
      if (quest.getStage(player) === STAGE_CRISIS && text.includes("sure, i'll help you")) {
        quest.setStage(player, STAGE_MISSION);
      }
      return;
    }
    if (npcId === SIR_TIFFY_CASHIEN_NPC_ID && quest.getStage(player) === STAGE_MISSION) {
      if (text.includes("buy one")) {
        orbPathByPlayer.set(player, "buy");
        return;
      }
      if (text.includes("have one made")) {
        orbPathByPlayer.set(player, "make");
        return;
      }
      // The transcript's "Yes" branches jump around the page; grant the orb from
      // the choices themselves so the purchase does not depend on jump resolution.
      if (text.startsWith("yes")) {
        const path = orbPathByPlayer.get(player);
        if (path === "make") grantCommorbFromTiffy(player);
        else if (path === "buy") orbPathByPlayer.set(player, "buy-confirm");
        else if (path === "buy-confirm") grantCommorbFromTiffy(player);
      }
      return;
    }
    if (npcId === MAGE_OF_ZAMORAK_NPC_ID && text.includes("solus dellagar") && quest.getStage(player) === STAGE_FUR) {
      quest.setStage(player, STAGE_MAGE_DEAL);
    }
  }

  function handleClueReference(event) {
    const { player, stepId } = event;
    if (stepId !== "BO-ZlI" && stepId !== "WF7PuA") return;
    const mission = getMission(player);
    if (quest.getStage(player) !== STAGE_HUNT) return;
    if (mission !== MISSION_CHAMPIONS_GUILD && mission !== MISSION_DORGESHUUN_MINE) return;
    const tail = clueBranchSteps();
    if (!tail.length) return;
    event.handled = true;
    event.steps = tail;
  }

  function handleDialogueAction(event) {
    const { player, npcId, stepId } = event;
    if (!player) return;
    if (stepId === "WqZIre") { // "The player is teleported to Camelot."
      event.handled = true;
      teleport(player, CAMELOT_TILE);
      return;
    }
    if (stepId === "uq8DV_") { // "The player wakes up outside Falador Castle."
      event.handled = true;
      teleport(player, FALADOR_CASTLE_OUTSIDE_TILE);
      return;
    }
    if (stepId === "CfRFgE") { // "A Black Knight appears."
      event.handled = true;
      spawnSummonedKnight(player);
      return;
    }
    if (stepId === "UK6zld") { // the rangers fall; the weakened Solus turns on the player
      event.handled = true;
      spawnSolus(player);
      return;
    }
    if (stepId === "BO-ZlI" || stepId === "WF7PuA") {
      handleClueReference(event);
      return;
    }
    if (npcId === SIR_AMIK_VARZE_NPC_ID && stepId === "iDVsvn") { // "Congratulations! Quest complete!"
      event.handled = true;
      if (quest.getStage(player) >= STAGE_DEFEATED && hasHat(player) && !quest.isComplete(player)) {
        player.getInventory().deleteNumber(SOLUSS_HAT_ITEM_ID, 1);
        quest.complete(player);
      }
      return;
    }
    if (CLUE_MESSAGE_STEP_IDS.has(stepId)) {
      if (quest.getStage(player) !== STAGE_HUNT) return;
      const mission = getMission(player);
      const clue = CLUE_BY_MISSION[mission];
      if (clue !== undefined) grantClue(player, clue, mission);
      return;
    }
    if (stepId === "qUGLsM") { // second stop: the blue cape
      if (quest.getStage(player) === STAGE_HUNT && getMission(player) === MISSION_RELLEKKA) {
        grantClue(player, BLUE_CAPE_ITEM_ID, MISSION_RELLEKKA);
      }
      return;
    }
    if (stepId === "mdADDD") { // fourth stop: the bone spear
      if (quest.getStage(player) === STAGE_HUNT && getMission(player) === MISSION_WIZARDS_TOWER) {
        grantClue(player, BONE_SPEAR_ITEM_ID, MISSION_WIZARDS_TOWER);
      }
      return;
    }
    if (stepId === "3AZ4ZV") { // sixth stop: 20 noted rune essence
      if (quest.getStage(player) === STAGE_HUNT && getMission(player) === MISSION_CASTLE_WARS) {
        grantClue(player, NOTED_RUNE_ESSENCE_ITEM_ID, MISSION_CASTLE_WARS, 20);
      }
    }
  }

  // ==========================================================================
  // CommOrb (Scan / Contact / Playback)
  // ==========================================================================

  function beginHunt(player) {
    if (quest.getStage(player) !== STAGE_EAST) return;
    quest.setStage(player, STAGE_HUNT);
    setMission(player, MISSION_CANIFIS);
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_CANIFIS_CALL);
  }

  function triggerMission(player, mission) {
    if (mission === MISSION_CANIFIS) {
      startTranscript(api, player, SOLUS_DELLAGAR_NPC_ID, PAGE, V_SCAN_CANIFIS);
      return;
    }
    if (mission === MISSION_RELLEKKA) {
      startTranscript(api, player, SOLUS_DELLAGAR_NPC_ID, PAGE, V_SCAN_SECOND);
      return;
    }
    if (mission === MISSION_CHAMPIONS_GUILD) {
      startTranscript(api, player, SOLUS_DELLAGAR_NPC_ID, PAGE, V_SCAN_CHAMPIONS);
      return;
    }
    if (mission === MISSION_WIZARDS_TOWER) {
      startTranscript(api, player, SOLUS_DELLAGAR_NPC_ID, PAGE, V_SCAN_FOURTH);
      return;
    }
    if (mission === MISSION_DORGESHUUN_MINE) {
      startTranscript(api, player, SOLUS_DELLAGAR_NPC_ID, PAGE, V_SCAN_DORGESHUUN);
      return;
    }
    if (mission === MISSION_CASTLE_WARS) {
      startTranscript(api, player, SOLUS_DELLAGAR_NPC_ID, PAGE, V_SCAN_SIXTH);
      return;
    }
    if (mission === MISSION_RUNE_ESSENCE_MINE) {
      if (solusByPlayer.has(player)) {
        player.sendMessage("Solus is right here - finish him!");
        return;
      }
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SCAN_FINAL);
    }
  }

  function handleScan(player) {
    const stage = quest.getStage(player);
    if (stage === STAGE_EAST) {
      if (inZone(player, CANIFIS_ZONE)) beginHunt(player);
      else startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_FAILING);
      return;
    }
    if (stage !== STAGE_HUNT) {
      player.sendMessage("You have no Solus trail to scan for right now.");
      return;
    }
    const mission = getMission(player);
    const zone = MISSION_ZONE[mission];
    if (zone && inZone(player, zone)) {
      triggerMission(player, mission);
      return;
    }
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_FAILING);
  }

  function handleContact(player) {
    const stage = quest.getStage(player);
    if (quest.isComplete(player)) return;
    if (stage < STAGE_MISSION) {
      player.sendMessage("You have no Temple Knight contact to reach yet.");
      return;
    }
    if (stage === STAGE_MISSION) {
      player.sendMessage("You should ask Sir Tiffy Cashien about your equipment first.");
      return;
    }
    if (stage === STAGE_COMMORB) {
      quest.setStage(player, STAGE_CONTACTED);
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_FIRST);
      return;
    }
    if (stage < STAGE_HUNT) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_AGAIN);
      return;
    }
    if (stage === STAGE_HUNT) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_HINT);
      return;
    }
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_HAT);
  }

  function replayRecord(player, variant) {
    startTranscript(api, player, SAVANT_NPC_ID, PAGE, variant);
  }

  function handlePlayback(player) {
    if (quest.getStage(player) < STAGE_COMMORB) {
      player.sendMessage("There is nothing recorded on the CommOrb yet.");
      return;
    }
    if (!inZone(player, WHITE_KNIGHTS_CASTLE_ZONE)) {
      startTranscript(api, player, SAVANT_NPC_ID, PAGE, V_SAVANT_PLAYBACK, () => [
        { type: "call", branch: "gqybR2" },
      ]);
      return;
    }
    api.sendMultiChatboxPrompt(
      player,
      "Select Information",
      "Dossier on Solus Dellagar",
      () => replayRecord(player, V_RECORD_DOSSIER),
      "Solus Observation Record 1",
      () => replayRecord(player, V_RECORD_1),
      "Solus Observation Record 2",
      () => replayRecord(player, V_RECORD_2),
      "Cancel",
      () => player.getPacketSender().sendInterfaceRemoval()
    );
  }

  function handleCommorbAction(event) {
    if (!event.player || event.itemId !== COMMORB_ITEM_ID) return;
    if (event.clickType === 1) {
      event.handled = true;
      handleScan(event.player);
      return;
    }
    if (event.clickType === 2) {
      event.handled = true;
      handleContact(event.player);
      return;
    }
    if (event.clickType === 4) {
      event.handled = true;
      handlePlayback(event.player);
    }
  }

  // ==========================================================================
  // World events
  // ==========================================================================

  function handleNpcDeath(event) {
    const killer = event?.killer?.isPlayer?.() ? event.killer : null;
    if (!killer) return;
    const npc = event.npc;
    if (npc === summonedKnightByPlayer.get(killer)) {
      summonedKnightByPlayer.delete(killer);
      if (quest.getStage(killer) === STAGE_HUNT && getMission(killer) === MISSION_CASTLE_WARS) {
        startTranscript(api, killer, SAVANT_NPC_ID, PAGE, V_SCAN_SIXTH_DONE);
      }
      return;
    }
    if (npc === solusByPlayer.get(killer)) {
      solusByPlayer.delete(killer);
      if (quest.getStage(killer) === STAGE_HUNT && getMission(killer) === MISSION_RUNE_ESSENCE_MINE) {
        if (killer.getInventory().isFull()) {
          killer.sendMessage("You have no room for Solus's hat.");
        } else {
          killer.getInventory().adds(SOLUSS_HAT_ITEM_ID, 1);
        }
        quest.setStage(killer, STAGE_DEFEATED);
        startTranscript(api, killer, SAVANT_NPC_ID, PAGE, V_SCAN_FINAL_DONE);
      }
      return;
    }
    if (TAVERLEY_BLACK_KNIGHT_IDS.has(event.npcId) && quest.getStage(killer) === STAGE_DAQUARIUS && !blackKnightDead(killer)) {
      setBlackKnightDead(killer, true);
      startTranscript(api, killer, LORD_DAQUARIUS_NPC_ID, PAGE, V_DAQUARIUS_STOP);
    }
  }

  function handleCanifisZoneEnter({ player }) {
    if (!player) return;
    if (quest.getStage(player) === STAGE_EAST) beginHunt(player);
  }

  function handleLogin({ player }) {
    if (!player) return;
    const stage = quest.getStage(player);
    if (stage >= STAGE_FUR && stage < STAGE_DEFEATED) ensureMageSpawned(player);
    else clearMageSpawn(player);
    refreshQuestList(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    clearFightSpawns(player);
    clearMageSpawn(player);
    orbPathByPlayer.delete(player);
    squirePromptPlayers.delete(player);
  }

  function handlePlayerDeath({ player }) {
    clearFightSpawns(player);
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function huntJournal(player) {
    const mission = getMission(player);
    const stops = [
      [MISSION_CANIFIS, "Canifis"],
      [MISSION_RELLEKKA, "Rellekka"],
      [MISSION_CHAMPIONS_GUILD, "Champions' Guild"],
      [MISSION_WIZARDS_TOWER, "Wizards' Tower"],
      [MISSION_DORGESHUUN_MINE, "Dorgesh-Kaan mine"],
      [MISSION_CASTLE_WARS, "Castle Wars"],
      [MISSION_RUNE_ESSENCE_MINE, "Rune essence mine"],
    ];
    const lines = ["I am chasing Solus Dellagar across Gielinor:"];
    for (const [index, label] of stops) {
      const line = `- Scan for Solus at ${label}`;
      if (index < mission) lines.push(`<str>${line}</str>`);
      else if (index === mission) lines.push(`<col=800000>${line}</col>`);
      else lines.push(line);
    }
    return lines;
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I was deputised into the White Knights and tracked down the</str>",
        "<str>murder-mage Solus Dellagar.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_DEFEATED) {
      return [
        "I have defeated Solus Dellagar and taken his hat.",
        "",
        "I should take <col=800000>Solus's hat</col> to <col=800000>Sir Amik Varze</col>",
        "in the <col=800000>White Knights' Castle</col> to become a",
        "White Knight.",
      ];
    }
    if (stage >= STAGE_HUNT) return huntJournal(player);
    if (stage >= STAGE_EAST) {
      return [
        "Solus Dellagar went east, and the fur clue points to the werewolves.",
        "",
        "I should search for him in <col=800000>Canifis</col> and use the",
        "<col=800000>Scan</col> option of my CommOrb.",
      ];
    }
    if (stage >= STAGE_MAGE_DEAL) {
      return [
        "The Mage of Zamorak in Varrock will sell me information about",
        "Solus for <col=800000>20 unnoted rune or pure essence</col>.",
      ];
    }
    if (stage >= STAGE_FUR) {
      return [
        "Lord Daquarius told me Solus left some fur behind, but it was",
        "not bear fur.",
        "",
        "Savant suggests the <col=800000>Zamorakian mage</col> in south-east",
        "<col=800000>Varrock</col> may know more.",
      ];
    }
    if (stage >= STAGE_DAQUARIUS) {
      return [
        "Lord Daquarius refuses to talk.",
        "",
        "Kill one of his <col=800000>Black Knights</col> in the",
        "<col=800000>Taverley Dungeon</col> to make him bargain.",
      ];
    }
    if (stage >= STAGE_CONTACTED) {
      return [
        "Savant sent me two observation records through the CommOrb.",
        "",
        "Investigate <col=800000>Lord Daquarius</col> in the",
        "<col=800000>Taverley Dungeon</col> and the <col=800000>Zamorakian",
        "mage</col> in south-east Varrock.",
      ];
    }
    if (stage >= STAGE_COMMORB) {
      return [
        "Sir Tiffy gave me a <col=800000>CommOrb</col>.",
        "",
        "Use its <col=800000>Contact</col> option to speak to",
        "<col=800000>Savant</col>.",
      ];
    }
    if (stage >= STAGE_MISSION) {
      return [
        "Sir Amik deputised me to hunt Solus Dellagar.",
        "",
        "I should ask <col=800000>Sir Tiffy Cashien</col> in",
        "<col=800000>Falador Park</col> for my equipment.",
      ];
    }
    if (stage >= STAGE_CRISIS) {
      return [
        "Sir Tiffy has arranged a crisis to force Sir Amik's hand.",
        "",
        "Report to <col=800000>Sir Amik Varze</col> in the",
        "<col=800000>White Knights' Castle</col>.",
      ];
    }
    if (stage >= STAGE_DECLINED) {
      return [
        "<str>I told Sir Amik Varze I have quit the Temple Knights.</str>",
        "",
        "Report back to <col=800000>Sir Tiffy Cashien</col> in",
        "<col=800000>Falador Park</col>.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "Sir Tiffy wants me to tell Sir Amik that I have quit the",
        "Temple Knights and to decline his offer of a squireship.",
        "",
        "Speak to <col=800000>Sir Amik Varze</col> in the",
        "<col=800000>White Knights' Castle</col>.",
      ];
    }
    return [
      "I can start this quest by speaking to <col=800000>Sir Tiffy Cashien</col>",
      "in <col=800000>Falador Park</col>.",
      "",
      "I need to have completed <col=800000>The Lost Tribe</col> and",
      "<col=800000>Recruitment Drive</col>.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.SLAYER, 5000);
  }

  api.persistAttribute(MISSION_ATTRIBUTE);
  api.persistAttribute(SQUIRE_ATTRIBUTE);
  api.persistAttribute(BLACK_KNIGHT_DEAD_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "wanted",
    name: "Wanted!",
    varpId: VARP_WANTED,
    varbitId: VARBIT_WANTED_MAIN,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.SLAYER.getIndex(), amount: 5000, label: "Slayer" }],
    otherRewards: ["Access to the White Knights' armoury (white equipment from Sir Vyvin)"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onNpcInteraction("Sir Tiffy Cashien", { "Talk-to": talkToTiffy });
  api.onNpcInteraction("Sir Amik Varze", { "Talk-to": talkToAmik });
  api.onNpcInteraction("Lord Daquarius", { "Talk-to": talkToDaquarius });
  api.onCustomEvent("npc-dialogue:hook", handleHook);
  api.onCustomEvent("npc-dialogue:line", handleLine);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onItemAction(handleCommorbAction);
  api.onNpcDeath(handleNpcDeath);
  api.onZoneEnter(CANIFIS_ZONE, handleCanifisZoneEnter);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
  api.onPlayerDeath(handlePlayerDeath);
};
