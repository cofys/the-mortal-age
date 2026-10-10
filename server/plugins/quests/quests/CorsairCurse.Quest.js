/**
 * The Corsair Curse (free-to-play).
 *
 * The words come from the "The Corsair Curse" transcript page (plus the
 * post-quest "Captain Tock", "Cabin Boy Colin", "Arsen the Thief" and
 * "Gnocci the Cook" pages); this plugin supplies the per-stage variant
 * selector, the prose-condition answers, the boat rides, the dungeon
 * entrance, the telescope/dig/driftwood investigations and the Ithoi fight.
 *
 * Stages (varp 1677 "corscurs", written through varbit 6071
 * "corscurs_progress", bits 0-5):
 *   0 not started, 1 agreed to help (meet the ship west of Rimmington),
 *   2 sailed to Corsair Cove (visit Ithoi first), 3 investigating the crew,
 *   4 Captain Tock explained the dinner, 5 Gnocci and Arsen questioned,
 *   6 Ithoi confessed, 7 Ithoi proved healthy (driftwood lit),
 *   8 Captain Tock asked for Ithoi's death, 9 Ithoi killed, 10 complete.
 *
 * Crew progress mirrors the cache's sibling bits of the same varp, cached in
 * persisted attributes: 6072 corcurs_cabinboy 0-3 (0 none, 1 heard, 2 used
 * telescope, 3 told), 6073 corcurs_cook 0-3 (0 none, 1 heard, 2 dug, 3 told),
 * 6074 corcurs_thief 0-4 (0 none, 1 heard, 2 has artefact, 3 returned relic,
 * 4 told), 6075 corcurs_navigator 0-1 (1 = the player challenged Ithoi to
 * prove he can get up).
 *
 * Source: OSRS Wiki (https://oldschool.runescape.wiki/w/The_Corsair_Curse and
 * its quick guide and transcript). Rewards per the wiki: 2 Quest points,
 * access to Yusuf's Corsair Cove bank and boat docking (neither simulated).
 *
 * Gaps: the "Wet driftwood" scenery (31723) has no map placement in this
 * cache, so the plugin spawns the dry driftwood (31721) itself and swaps it
 * for the burning/wet ids during the reveal; that swap is world-wide rather
 * than per-player. Ithoi's overhead fight lines ("traitor-in-the-midst-
 * killing-ithoi"), the cutscene camera work and Yusuf's bank gating are not
 * simulated; "Please take me back to Rimmington" is handled directly on the
 * choice. The journal text is adapted from the quick guide (the wiki has no
 * journal transcript).
 */
module.exports = function registerCorsairCurseQuest(api) {
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

  const VARP_CORSAIR_CURSE = 1677; // "corscurs"
  const VARBIT_PROGRESS = 6071; // "corscurs_progress", bits 0-5
  const VARBIT_CABINBOY = 6072; // "corscurs_cabinboy", bits 6-7
  const VARBIT_COOK = 6073; // "corscurs_cook", bits 8-9
  const VARBIT_THIEF = 6074; // "corscurs_thief", bits 10-12
  const VARBIT_NAVIGATOR = 6075; // "corscurs_navigator", bit 13

  const STAGE_NOT_STARTED = 0;
  const STAGE_STARTED = 1;
  const STAGE_ARRIVED = 2;
  const STAGE_INVESTIGATING = 3;
  const STAGE_TRAITOR_KNOWN = 4;
  const STAGE_FIRING_KNOWN = 5;
  const STAGE_CONFESSED = 6;
  const STAGE_PROVED = 7;
  const STAGE_KILL_ORDER = 8;
  const STAGE_KILLED = 9;
  const STAGE_COMPLETE = 10;

  const PAGE = "The Corsair Curse";

  const CAPTAIN_TOCK_START = NpcIdentifiers.CAPTAIN_TOCK; // 7956
  const CAPTAIN_TOCK_POST = NpcIdentifiers.CAPTAIN_TOCK_2; // 7957
  const CAPTAIN_TOCK_FERRY = NpcIdentifiers.CAPTAIN_TOCK_3; // 7958
  const ITHOI = NpcIdentifiers.ITHOI_THE_NAVIGATOR; // 7961
  const ITHOI_2 = NpcIdentifiers.ITHOI_THE_NAVIGATOR_2; // 7963
  const ITHOI_FIGHT = NpcIdentifiers.ITHOI_THE_NAVIGATOR_3; // 7964, level 35
  const COLIN = NpcIdentifiers.CABIN_BOY_COLIN; // 7965
  const COLIN_2 = NpcIdentifiers.CABIN_BOY_COLIN_2; // 7966
  const COLIN_POST = NpcIdentifiers.CABIN_BOY_COLIN_3; // 7967
  const GNOCCI = NpcIdentifiers.GNOCCI_THE_COOK; // 7970
  const GNOCCI_2 = NpcIdentifiers.GNOCCI_THE_COOK_2; // 7971
  const GNOCCI_3 = NpcIdentifiers.GNOCCI_THE_COOK_3; // 7972
  const ARSEN = NpcIdentifiers.ARSEN_THE_THIEF; // 7976

  const TOCK_NPC_IDS = new Set([CAPTAIN_TOCK_START, CAPTAIN_TOCK_POST, CAPTAIN_TOCK_FERRY]);
  const ITHOI_NPC_IDS = new Set([ITHOI, ITHOI_2, ITHOI_FIGHT]);
  const COLIN_NPC_IDS = new Set([COLIN, COLIN_2, COLIN_POST]);
  const GNOCCI_NPC_IDS = new Set([GNOCCI, GNOCCI_2, GNOCCI_3]);

  const OGRE_ARTEFACT_ITEM = ItemIdentifiers.OGRE_ARTEFACT_2; // 21837
  const TINDERBOX_ITEM = ItemIdentifiers.TINDERBOX; // 590
  const SPADE_ITEM = ItemIdentifiers.SPADE; // 952
  const FEATHER_ITEM = ItemIdentifiers.FEATHER; // 314
  const ABYSSAL_WHIP_ITEM = ItemIdentifiers.ABYSSAL_WHIP; // 4151

  const TELESCOPE_OBJECT = ObjectIdentifiers.TELESCOPE_10; // 31632, Observe
  const SPADE_OBJECT = ObjectIdentifiers.SPADE_2; // 31585, Take
  const TINDERBOX_OBJECT = ObjectIdentifiers.COL_FF9040_TINDERBOX_COL; // 31634, Take
  const DRIFTWOOD_OBJECT = ObjectIdentifiers.DRIFTWOOD_4; // 31721
  const BURNING_DRIFTWOOD_OBJECT = ObjectIdentifiers.BURNING_DRIFTWOOD; // 31722
  const WET_DRIFTWOOD_OBJECT = ObjectIdentifiers.WET_DRIFTWOOD; // 31723
  const DUNGEON_HOLE_OBJECT = ObjectIdentifiers.HOLE_54; // 31791, Enter (four pillars)
  const OGRE_CAVE_OBJECT = ObjectIdentifiers.CAVE_59; // 31766, Enter (west of the cove)
  const VINE_LADDER_OBJECT = ObjectIdentifiers.VINE_LADDER_2; // 31790, Climb

  // Prose conditions on the "The Corsair Curse" page.
  const COND_NO_TOCK_YET = "EXq6K1";
  const COND_NO_TESS_YET = "pEzzRs";
  const COND_NO_CHOMPY_TELESCOPE = "HqAI6F";
  const COND_CHOMPY_TELESCOPE = "_SmqOy";
  const COND_NO_CHOMPY_RETURN = "q6KWx3";
  const COND_CHOMPY_RETURN = "Kk6cWa";
  const COND_NO_CRAFTING = "k-Ae5A";
  const COND_CRAFTING = "gZdLev";
  const COND_SPOKEN_TO_ARSEN = "Sc-0qW";

  // Action / message stage directions on the same page.
  const ACTION_TOCK_LEAVES = "9srM-C";
  const ACTION_SAIL_TO_COVE = "GnY-u6";
  const ACTION_RECEIVE_ARTEFACT = "yRckkD";
  const ACTION_PRESENT_ARTEFACT = "wenZvG";
  const ACTION_ITHOI_EXTINGUISHES = "Qx1uew";
  const ACTION_QUEST_COMPLETE = "SaQ1Mg";

  // Tiles verified against the cache collision map.
  const TOCK_START_TILE = { x: 3030, y: 3273, z: 0 };
  const RIMMINGTON_TILE = { x: 2910, y: 3226, z: 0 };
  const RIMMINGTON_LANDING = { x: 2911, y: 3226, z: 0 };
  const COVE_TOCK_TILE = { x: 2574, y: 2836, z: 1 };
  const COVE_LANDING = { x: 2576, y: 2836, z: 1 };
  const ARSEN_TILE = { x: 2556, y: 2856, z: 1 };
  const COLIN_TILE = { x: 2559, y: 2856, z: 1 };
  const GNOCCI_TILE = { x: 2546, y: 2862, z: 1 };
  const ITHOI_TILE = { x: 2529, y: 2837, z: 1 };
  const POST_TOCK_TILE = { x: 2586, y: 2866, z: 0 };
  const DUNGEON_LANDING = { x: 2011, y: 9007, z: 1 };
  const CAVE_LANDING = { x: 2483, y: 2889, z: 0 };
  const DIG_TILE = { x: 2503, y: 2839, z: 0 };
  const DRIFTWOOD_TILE = { x: 2530, y: 2837, z: 0 };

  const CABINBOY_ATTRIBUTE = "quest.the_corsair_curse.cabinboy";
  const COOK_ATTRIBUTE = "quest.the_corsair_curse.cook";
  const THIEF_ATTRIBUTE = "quest.the_corsair_curse.thief";
  const NAVIGATOR_ATTRIBUTE = "quest.the_corsair_curse.navigator";
  const TRAITOR_ATTRIBUTE = "quest.the_corsair_curse.traitor";

  const CABINBOY_HEARD = 1;
  const CABINBOY_TELESCOPE = 2;
  const CABINBOY_TOLD = 3;
  const COOK_HEARD = 1;
  const COOK_DUG = 2;
  const COOK_TOLD = 3;
  const THIEF_HEARD = 1;
  const THIEF_HAS_ARTEFACT = 2;
  const THIEF_RETURNED_RELIC = 3;
  const THIEF_TOLD = 4;
  const NAVIGATOR_TOLD = 1;

  const TRAITOR_GNOCCI = 1 << 0;
  const TRAITOR_ARSEN = 1 << 1;
  const TRAITOR_COLIN = 1 << 2;

  const npcsByPlayer = new Map();
  let driftwoodObject = null;
  let quest;

  const sub = (player, attribute) => Number(player.getAttribute(attribute)) || 0;
  const cabinboy = (player) => sub(player, CABINBOY_ATTRIBUTE);
  const cook = (player) => sub(player, COOK_ATTRIBUTE);
  const thief = (player) => sub(player, THIEF_ATTRIBUTE);
  const navigator = (player) => sub(player, NAVIGATOR_ATTRIBUTE);
  const traitorFlags = (player) => sub(player, TRAITOR_ATTRIBUTE);

  function setSub(player, attribute, varbit, value) {
    player.setAttribute(attribute, value | 0);
    player.getPacketSender().sendVarbit(varbit, value | 0);
  }

  const setCabinboy = (player, value) => setSub(player, CABINBOY_ATTRIBUTE, VARBIT_CABINBOY, value);
  const setCook = (player, value) => setSub(player, COOK_ATTRIBUTE, VARBIT_COOK, value);
  const setThief = (player, value) => setSub(player, THIEF_ATTRIBUTE, VARBIT_THIEF, value);
  const setNavigator = (player, value) => setSub(player, NAVIGATOR_ATTRIBUTE, VARBIT_NAVIGATOR, value);

  function addTraitorFlag(player, flag) {
    player.setAttribute(TRAITOR_ATTRIBUTE, traitorFlags(player) | flag);
  }

  function maybeAdvanceTraitor(player) {
    const flags = traitorFlags(player);
    if ((flags & TRAITOR_GNOCCI) !== 0 && (flags & TRAITOR_ARSEN) !== 0) {
      advance(player, STAGE_FIRING_KNOWN);
    }
  }

  function anyTheoryHeard(player) {
    return thief(player) >= THIEF_HEARD || cabinboy(player) >= CABINBOY_HEARD || cook(player) >= COOK_HEARD;
  }

  function crewResolved(player) {
    return thief(player) >= THIEF_TOLD && cabinboy(player) >= CABINBOY_TOLD && cook(player) >= COOK_TOLD;
  }

  function bigChompyComplete(player) {
    const request = { player, key: "big_chompy_bird_hunting", complete: null };
    api.emitCustomEvent("quest:is-complete", request);
    return request.complete === true;
  }

  function craftingLevel(player) {
    return Number(player.getSkillManager().getCurrentLevel(Skill.CRAFTING)) || 0;
  }

  function nearRimmington(npc) {
    const location = npc?.getLocation?.();
    if (!location) return false;
    return Math.abs(location.getX() - RIMMINGTON_TILE.x) <= 8
      && Math.abs(location.getY() - RIMMINGTON_TILE.y) <= 8;
  }

  function near(player, tile, radius) {
    const location = player?.getLocation?.();
    if (!location) return false;
    return Math.abs(location.getX() - tile.x) <= radius
      && Math.abs(location.getY() - tile.y) <= radius;
  }

  function moveTo(player, tile) {
    player.moveTo(new Location(tile.x, tile.y, tile.z));
  }

  function advance(player, value) {
    if (quest.getStage(player) < value) quest.setStage(player, value);
    ensureNpcs(player);
  }

  // ==========================================================================
  // Spawned NPCs (owner-only; the crew exist in the world at every stage)
  // ==========================================================================

  function postColinTile(player) {
    return near(player, RIMMINGTON_TILE, 24) ? RIMMINGTON_TILE : COVE_TOCK_TILE;
  }

  function desiredNpcs(player) {
    const stage = quest.getStage(player);
    const list = [];
    if (stage === STAGE_NOT_STARTED) {
      list.push({ key: "tock", id: CAPTAIN_TOCK_START, ...TOCK_START_TILE });
    } else if (stage < STAGE_COMPLETE) {
      list.push({ key: "tock-rimmington", id: CAPTAIN_TOCK_FERRY, ...RIMMINGTON_TILE });
      list.push({ key: "tock-cove", id: CAPTAIN_TOCK_FERRY, ...COVE_TOCK_TILE });
    } else {
      list.push({ key: "tock", id: CAPTAIN_TOCK_POST, ...POST_TOCK_TILE });
    }
    if (stage < STAGE_COMPLETE) {
      list.push({ key: "arsen", id: ARSEN, ...ARSEN_TILE });
      list.push({ key: "colin", id: COLIN, ...COLIN_TILE });
      list.push({ key: "gnocci", id: GNOCCI, ...GNOCCI_TILE });
      if (stage < STAGE_KILL_ORDER) {
        list.push({ key: "ithoi", id: ITHOI, ...ITHOI_TILE });
      } else if (stage === STAGE_KILL_ORDER) {
        list.push({ key: "ithoi", id: ITHOI_FIGHT, ...ITHOI_TILE });
      }
    } else {
      list.push({ key: "arsen", id: ARSEN, ...ARSEN_TILE });
      list.push({ key: "gnocci", id: GNOCCI, ...GNOCCI_TILE });
      list.push({ key: "colin", id: COLIN_POST, ...postColinTile(player) });
    }
    return list;
  }

  function npcMatches(npc, want) {
    const location = npc?.getLocation?.();
    return npc?.getId?.() === want.id
      && location?.getX?.() === want.x
      && location?.getY?.() === want.y
      && location?.getZ?.() === want.z;
  }

  /** Spawns, moves and removes this player's quest NPCs to match the stage. */
  function ensureNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    const tracked = npcsByPlayer.get(player) ?? new Map();
    const desired = desiredNpcs(player);
    const wanted = new Map(desired.map((entry) => [entry.key, entry]));
    for (const [key, npc] of [...tracked]) {
      if (wanted.has(key) && npcMatches(npc, wanted.get(key))) continue;
      api.removeNpc(npc);
      tracked.delete(key);
    }
    for (const want of desired) {
      if (tracked.has(want.key)) continue;
      const npc = api.spawnNpc({
        id: want.id,
        x: want.x,
        y: want.y,
        z: want.z,
        wanderRadius: 0,
        owner: player,
        ownerOnly: true,
      });
      if (npc) tracked.set(want.key, npc);
    }
    if (tracked.size > 0) npcsByPlayer.set(player, tracked);
    else npcsByPlayer.delete(player);
  }

  // ==========================================================================
  // Travel
  // ==========================================================================

  function sailToCove(player) {
    moveTo(player, COVE_LANDING);
    advance(player, STAGE_ARRIVED);
  }

  function sailToRimmington(player) {
    moveTo(player, RIMMINGTON_LANDING);
    ensureNpcs(player);
  }

  function handleTravel(event) {
    const { player, npc } = event;
    if (!player || !npc) return false;
    if (quest.getStage(player) === STAGE_NOT_STARTED) return false;
    if (nearRimmington(npc)) sailToCove(player);
    else sailToRimmington(player);
    return true;
  }

  // ==========================================================================
  // The driftwood (no map placement in this cache - the plugin places it)
  // ==========================================================================

  function placeDriftwood(id) {
    if (driftwoodObject) {
      ObjectManager.deregister(driftwoodObject, true);
      driftwoodObject = null;
    }
    const object = new GameObject(
      id,
      new Location(DRIFTWOOD_TILE.x, DRIFTWOOD_TILE.y, DRIFTWOOD_TILE.z),
      10,
      0,
      null
    );
    ObjectManager.register(object, true);
    driftwoodObject = object;
  }

  // ==========================================================================
  // Transcript variant selection
  // ==========================================================================

  function selectTockVariant(player, npc) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return "after-corsair-curse";
    if (stage === STAGE_NOT_STARTED) return "the-cursed-crew-talking-to-captain-tock";
    if (nearRimmington(npc)) return "the-cursed-crew-talking-to-captain-tock-again";
    switch (stage) {
      case STAGE_INVESTIGATING:
        if (thief(player) === THIEF_HEARD) return "arsen-s-curse-talking-to-captain-tock";
        if (crewResolved(player)) return "traitor-in-the-midst-talking-to-captain-tock";
        if (anyTheoryHeard(player)) {
          return "gnocci-s-curse-talking-to-captain-tock-during-the-investigation-of-the-curses";
        }
        return "the-cursed-crew-talking-to-captain-tock-after-ithoi";
      case STAGE_TRAITOR_KNOWN:
        return "traitor-in-the-midst-talking-to-captain-tock-talking-to-captain-tock-again";
      case STAGE_FIRING_KNOWN:
        return "traitor-in-the-midst-talking-to-captain-tock-after-talking-to-everyone-else";
      case STAGE_CONFESSED:
        return "traitor-in-the-midst-talking-to-ithoi-after-talking-to-everyone-else-talking-to-captain-tock-after-ithoi-admits-he-poisoned-the-crew";
      case STAGE_PROVED:
      case STAGE_KILL_ORDER:
        return "traitor-in-the-midst-talking-to-captain-tock-after-proving-ithoi-poisoned-the-crew";
      case STAGE_KILLED:
        return "traitor-in-the-midst-talking-to-captain-tock-after-killing-ithoi";
      default:
        return "the-cursed-crew-talking-to-captain-tock-after-ithoi";
    }
  }

  function selectIthoiVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_KILL_ORDER) return null;
    if (stage >= STAGE_PROVED) {
      return "traitor-in-the-midst-attempting-to-light-the-the-driftwood-after-discovering-ithoi-s-lie-talking-to-ithoi-again";
    }
    if (stage === STAGE_CONFESSED) {
      return "traitor-in-the-midst-talking-to-ithoi-after-talking-to-everyone-else-talking-to-ithoi-again";
    }
    if (stage === STAGE_FIRING_KNOWN) {
      return "traitor-in-the-midst-talking-to-ithoi-after-talking-to-everyone-else";
    }
    if (stage === STAGE_TRAITOR_KNOWN) {
      return "traitor-in-the-midst-talking-to-ithoi-before-talking-to-everyone-else";
    }
    if (stage === STAGE_INVESTIGATING) {
      return anyTheoryHeard(player)
        ? "gnocci-s-curse-talking-to-ithoi-during-the-investigation-of-the-curses"
        : "the-cursed-crew-talking-to-ithoi";
    }
    if (stage === STAGE_ARRIVED) return "the-cursed-crew-talking-to-ithoi";
    return "before-the-corsair-curse";
  }

  function selectArsenVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return "after-the-corsair-curse";
    if (stage === STAGE_TRAITOR_KNOWN || stage === STAGE_FIRING_KNOWN) {
      return "traitor-in-the-midst-talking-to-arsen";
    }
    if (stage === STAGE_CONFESSED) {
      return "traitor-in-the-midst-talking-to-ithoi-after-talking-to-everyone-else-talking-to-arsen-after-ithoi-admits-he-poisoned-the-crew";
    }
    if (stage === STAGE_PROVED || stage === STAGE_KILL_ORDER) {
      return "traitor-in-the-midst-talking-to-arsen-after-proving-ithoi-poisoned-the-crew";
    }
    if (stage === STAGE_KILLED) return "traitor-in-the-midst-talking-to-arsen-after-killing-ithoi";
    if (stage < STAGE_INVESTIGATING) {
      return stage >= STAGE_ARRIVED
        ? "the-cursed-crew-talking-to-arsen-before-talking-to-ithoi"
        : "before-the-corsair-curse";
    }
    const progress = thief(player);
    if (progress === 0) return "arsen-s-curse-talking-to-arsen";
    if (progress <= THIEF_HAS_ARTEFACT) return "arsen-s-curse-talking-to-arsen-talking-to-arsen-again";
    if (progress === THIEF_RETURNED_RELIC) {
      setThief(player, THIEF_TOLD);
      return "arsen-s-curse-returning-to-arsen";
    }
    return "arsen-s-curse-returning-to-arsen";
  }

  function selectColinVariant(player, npc) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return nearRimmington(npc)
        ? "after-the-corsair-curse-rimmington"
        : "after-the-corsair-curse-corsair-cove";
    }
    if (stage === STAGE_TRAITOR_KNOWN) return "traitor-in-the-midst-talking-to-colin";
    if (stage === STAGE_FIRING_KNOWN) {
      return "traitor-in-the-midst-talking-to-colin-talking-to-colin-again";
    }
    if (stage === STAGE_CONFESSED) {
      return "traitor-in-the-midst-talking-to-ithoi-after-talking-to-everyone-else-talking-to-colin-after-ithoi-admits-he-poisoned-the-crew";
    }
    if (stage === STAGE_PROVED || stage === STAGE_KILL_ORDER) {
      return "traitor-in-the-midst-talking-to-colin-after-proving-ithoi-poisoned-the-crew";
    }
    if (stage === STAGE_KILLED) return "traitor-in-the-midst-talking-to-colin-after-killing-ithoi";
    if (stage < STAGE_INVESTIGATING) {
      return stage >= STAGE_ARRIVED
        ? "the-cursed-crew-talking-to-colin-before-talking-to-ithoi"
        : "before-the-corsair-curse";
    }
    const progress = cabinboy(player);
    if (progress === 0) return "colin-s-curse-talking-to-colin";
    if (progress === CABINBOY_HEARD) return "colin-s-curse-talking-to-colin-talking-to-colin-again";
    if (progress === CABINBOY_TELESCOPE) {
      setCabinboy(player, CABINBOY_TOLD);
      return "colin-s-curse-returning-to-colin";
    }
    return "colin-s-curse-returning-to-colin";
  }

  function selectGnocciVariant(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_COMPLETE) return "after-the-corsair-curse";
    if (stage === STAGE_TRAITOR_KNOWN) return "traitor-in-the-midst-talking-to-gnocchi";
    if (stage === STAGE_FIRING_KNOWN) {
      return "traitor-in-the-midst-talking-to-gnocchi-talking-to-gnocchi-again";
    }
    if (stage === STAGE_CONFESSED) {
      return "traitor-in-the-midst-talking-to-ithoi-after-talking-to-everyone-else-talking-to-gnocchi-after-ithoi-admits-he-poisoned-the-crew";
    }
    if (stage === STAGE_PROVED || stage === STAGE_KILL_ORDER) {
      return "traitor-in-the-midst-talking-to-gnocci-after-proving-ithoi-poisoned-the-crew";
    }
    if (stage === STAGE_KILLED) return "traitor-in-the-midst-talking-to-gnocci-after-killing-ithoi";
    if (stage < STAGE_INVESTIGATING) {
      return stage >= STAGE_ARRIVED
        ? "the-cursed-crew-talking-to-gnocci-before-talking-to-ithoi"
        : "before-the-corsair-curse";
    }
    const progress = cook(player);
    if (progress === 0) return "gnocci-s-curse-talking-to-gnocci";
    if (progress === COOK_HEARD) return "gnocci-s-curse-talking-to-gnocci-talking-to-gnocci-again";
    if (progress === COOK_DUG) {
      setCook(player, COOK_TOLD);
      return "gnocci-s-curse-returning-to-gnocci";
    }
    return "gnocci-s-curse-returning-to-gnocci";
  }

  function selectTessVariant(player) {
    if (quest.getStage(player) !== STAGE_INVESTIGATING) return null;
    if (thief(player) === THIEF_HEARD) {
      return "arsen-s-curse-talking-to-chief-tess-before-talking-to-captain-tock";
    }
    if (thief(player) === THIEF_HAS_ARTEFACT) {
      return "arsen-s-curse-talking-to-chief-tess-after-talking-to-captain-tock";
    }
    return null;
  }

  function selectVariant({ npcId, npc, player }) {
    if (!player) return null;
    if (TOCK_NPC_IDS.has(npcId)) return selectTockVariant(player, npc);
    if (ITHOI_NPC_IDS.has(npcId)) return selectIthoiVariant(player);
    if (npcId === ARSEN) return selectArsenVariant(player);
    if (COLIN_NPC_IDS.has(npcId)) return selectColinVariant(player, npc);
    if (GNOCCI_NPC_IDS.has(npcId)) return selectGnocciVariant(player);
    if (npcId === NpcIdentifiers.CHIEF_TESS) return selectTessVariant(player);
    return null;
  }

  // ==========================================================================
  // Prose conditions
  // ==========================================================================

  function answerCondition({ npcId, player, stepId }) {
    if (!player) return null;
    switch (stepId) {
      case COND_NO_TOCK_YET:
        if (npcId !== ARSEN) return null;
        return thief(player) < THIEF_HAS_ARTEFACT;
      case COND_NO_TESS_YET:
        if (npcId !== ARSEN) return null;
        return thief(player) < THIEF_RETURNED_RELIC;
      case COND_NO_CHOMPY_TELESCOPE:
      case COND_NO_CHOMPY_RETURN:
        if (!ITHOI_NPC_IDS.has(npcId) && !COLIN_NPC_IDS.has(npcId)) return null;
        return !bigChompyComplete(player);
      case COND_CHOMPY_TELESCOPE:
      case COND_CHOMPY_RETURN:
        if (!ITHOI_NPC_IDS.has(npcId) && !COLIN_NPC_IDS.has(npcId)) return null;
        return bigChompyComplete(player);
      case COND_NO_CRAFTING:
        if (!GNOCCI_NPC_IDS.has(npcId)) return null;
        return craftingLevel(player) < 18;
      case COND_CRAFTING:
        if (!GNOCCI_NPC_IDS.has(npcId)) return null;
        return craftingLevel(player) >= 18;
      case COND_SPOKEN_TO_ARSEN:
        if (!GNOCCI_NPC_IDS.has(npcId)) return null;
        return (traitorFlags(player) & TRAITOR_ARSEN) !== 0;
      default:
        return null;
    }
  }

  // ==========================================================================
  // Transcript actions and choices
  // ==========================================================================

  function handleDialogueAction(event) {
    const { player, stepId } = event;
    if (!player || !stepId) return;
    if (stepId === ACTION_TOCK_LEAVES) {
      event.handled = true;
      player.sendMessage(String(event.text ?? ""));
      advance(player, STAGE_STARTED);
      return;
    }
    if (stepId === ACTION_SAIL_TO_COVE) {
      event.handled = true;
      player.sendMessage(String(event.text ?? ""));
      sailToCove(player);
      return;
    }
    if (stepId === ACTION_RECEIVE_ARTEFACT) {
      event.handled = true;
      player.sendMessage(String(event.text ?? ""));
      if (thief(player) === THIEF_HEARD) {
        player.getInventory().adds(OGRE_ARTEFACT_ITEM, 1);
        setThief(player, THIEF_HAS_ARTEFACT);
      }
      return;
    }
    if (stepId === ACTION_PRESENT_ARTEFACT) {
      event.handled = true;
      player.sendMessage(String(event.text ?? ""));
      if (thief(player) === THIEF_HAS_ARTEFACT) {
        player.getInventory().deleteNumber(OGRE_ARTEFACT_ITEM, 1);
        setThief(player, THIEF_RETURNED_RELIC);
      }
      return;
    }
    if (stepId === ACTION_ITHOI_EXTINGUISHES) {
      event.handled = true;
      placeDriftwood(WET_DRIFTWOOD_OBJECT);
      return;
    }
    if (stepId === ACTION_QUEST_COMPLETE) {
      if (quest.getStage(player) >= STAGE_KILLED && !quest.isComplete(player)) {
        quest.complete(player);
        ensureNpcs(player);
      }
    }
  }

  function handleDialogueChoice(event) {
    const { player, npcId, option } = event;
    if (!player) return;
    const text = String(option ?? "");
    const stage = quest.getStage(player);

    if (TOCK_NPC_IDS.has(npcId)) {
      if (text === "Please take me back to Rimmington.") {
        sailToRimmington(player);
      } else if (
        text === "I've ruled out all the Corsairs' theories..."
        && stage === STAGE_INVESTIGATING
        && crewResolved(player)
      ) {
        advance(player, STAGE_TRAITOR_KNOWN);
      } else if (
        text === "I've seen Ithoi running around. He's not sick at all."
        && stage === STAGE_PROVED
      ) {
        advance(player, STAGE_KILL_ORDER);
      }
      return;
    }

    if (ITHOI_NPC_IDS.has(npcId)) {
      if (text === "I hear you've been cursed." && stage === STAGE_ARRIVED) {
        advance(player, STAGE_INVESTIGATING);
      } else if (
        text === "Maybe because the Captain's thinking of firing you."
        && stage === STAGE_FIRING_KNOWN
      ) {
        advance(player, STAGE_CONFESSED);
      } else if (
        text === "I bet I can prove you're well enough to get up."
        && stage === STAGE_CONFESSED
      ) {
        setNavigator(player, NAVIGATOR_TOLD);
      }
      return;
    }

    if (npcId === ARSEN) {
      if (text === "I hear you've been cursed." && stage === STAGE_INVESTIGATING && thief(player) === 0) {
        setThief(player, THIEF_HEARD);
      } else if (
        text === "I hear Ithoi cooked the meal you ate that night."
        && stage === STAGE_TRAITOR_KNOWN
      ) {
        addTraitorFlag(player, TRAITOR_ARSEN);
        maybeAdvanceTraitor(player);
      }
      return;
    }

    if (COLIN_NPC_IDS.has(npcId)) {
      if (npcId === COLIN_POST && quest.isComplete(player)) {
        if (text === "Please take me back to Rimmington.") sailToRimmington(player);
        else if (text === "Yes please.") sailToCove(player);
        return;
      }
      if (
        text === "I hear you've been cursed."
        && stage === STAGE_INVESTIGATING
        && cabinboy(player) === 0
      ) {
        setCabinboy(player, CABINBOY_HEARD);
      } else if (
        text === "I hear the Captain's thinking of firing Ithoi."
        && stage === STAGE_FIRING_KNOWN
      ) {
        addTraitorFlag(player, TRAITOR_COLIN);
      }
      return;
    }

    if (GNOCCI_NPC_IDS.has(npcId)) {
      if (
        text === "I hear you've been cursed."
        && stage === STAGE_INVESTIGATING
        && cook(player) === 0
      ) {
        setCook(player, COOK_HEARD);
      } else if (
        text === "I hear it happened straight after dinner."
        && stage === STAGE_TRAITOR_KNOWN
      ) {
        addTraitorFlag(player, TRAITOR_GNOCCI);
        maybeAdvanceTraitor(player);
      } else if (
        text === "Search for the possessed doll and face the consequences."
        && stage === STAGE_INVESTIGATING
        && cook(player) === COOK_HEARD
      ) {
        setCook(player, COOK_DUG);
      }
    }
  }

  // ==========================================================================
  // Object and item interactions
  // ==========================================================================

  function observeTelescope(player) {
    const stage = quest.getStage(player);
    if (stage === STAGE_INVESTIGATING) {
      const progress = cabinboy(player);
      if (progress === CABINBOY_HEARD) {
        setCabinboy(player, CABINBOY_TELESCOPE);
        startTranscript(api, player, ITHOI, PAGE, "colin-s-curse-using-ithoi-s-telescope");
        return true;
      }
      if (progress >= CABINBOY_TELESCOPE) {
        startTranscript(api, player, ITHOI, PAGE, "colin-s-curse-using-ithoi-s-telescope-again");
        return true;
      }
      return false;
    }
    if (stage >= STAGE_TRAITOR_KNOWN && stage < STAGE_COMPLETE) {
      startTranscript(api, player, ITHOI, PAGE, "traitor-in-the-midst-observing-the-telescope-again");
      return true;
    }
    return false;
  }

  function enterDungeon(player) {
    moveTo(player, DUNGEON_LANDING);
  }

  function leaveDungeon(player) {
    moveTo(player, CAVE_LANDING);
  }

  function handleObjectInteraction(event) {
    const { player, objectId } = event;
    if (!player) return;
    if (objectId === TELESCOPE_OBJECT) {
      if (observeTelescope(player)) event.handled = true;
      return;
    }
    if (objectId === DUNGEON_HOLE_OBJECT || objectId === OGRE_CAVE_OBJECT) {
      event.handled = true;
      enterDungeon(player);
      return;
    }
    if (objectId === VINE_LADDER_OBJECT) {
      event.handled = true;
      leaveDungeon(player);
      return;
    }
    if (objectId === SPADE_OBJECT) {
      event.handled = true;
      if (player.getInventory().getAmount(SPADE_ITEM) === 0) player.getInventory().adds(SPADE_ITEM, 1);
      return;
    }
    if (objectId === TINDERBOX_OBJECT) {
      event.handled = true;
      if (player.getInventory().getAmount(TINDERBOX_ITEM) === 0) player.getInventory().adds(TINDERBOX_ITEM, 1);
    }
  }

  /** The generic Ladders plugin asks "which way?" for a lone "Climb"; own that click. */
  function claimClimb(request) {
    if (!request || request.objectId !== VINE_LADDER_OBJECT || !request.player) return;
    request.handled = true;
    leaveDungeon(request.player);
  }

  function handleItemOnObject(event) {
    const { player, itemId, objectId } = event;
    if (!player || itemId !== TINDERBOX_ITEM) return;
    if (objectId === WET_DRIFTWOOD_OBJECT) {
      event.handled = true;
      player.sendMessage("The driftwood is too wet to light.");
      return;
    }
    if (objectId !== DRIFTWOOD_OBJECT) return;
    event.handled = true;
    const stage = quest.getStage(player);
    if (stage >= STAGE_PROVED) {
      player.sendMessage("The driftwood is too wet to light.");
      return;
    }
    if (stage === STAGE_CONFESSED && navigator(player) === NAVIGATOR_TOLD) {
      advance(player, STAGE_PROVED);
      placeDriftwood(BURNING_DRIFTWOOD_OBJECT);
      startTranscript(
        api,
        player,
        ITHOI,
        PAGE,
        "traitor-in-the-midst-attempting-to-light-the-the-driftwood-after-discovering-ithoi-s-lie"
      );
      return;
    }
    if (stage >= STAGE_INVESTIGATING) {
      startTranscript(
        api,
        player,
        ITHOI,
        PAGE,
        "traitor-in-the-midst-attempting-to-light-the-the-driftwood-before-discovering-ithoi-s-lie"
      );
    }
  }

  function handleDig(event) {
    const { player } = event;
    if (!player) return false;
    if (quest.getStage(player) !== STAGE_INVESTIGATING) return false;
    if (cook(player) !== COOK_HEARD) return false;
    if (!near(player, DIG_TILE, 3)) return false;
    startTranscript(api, player, GNOCCI, PAGE, "gnocci-s-curse-digging-for-her");
    return true;
  }

  function handleItemOnNpc(event) {
    const { player, target, itemId } = event;
    if (!player || !target || !ITHOI_NPC_IDS.has(target.getId?.())) return;
    if (itemId !== FEATHER_ITEM && itemId !== ABYSSAL_WHIP_ITEM) return;
    event.handled = true;
    startTranscript(api, player, ITHOI, PAGE, "traitor-in-the-midst-using-any-abyssal-whip-or-a-feather-on-him");
  }

  function handleNpcDeath(event) {
    const player = event?.killer?.isPlayer?.() ? event.killer : null;
    if (!player || event.npcId !== ITHOI_FIGHT) return;
    if (quest.getStage(player) !== STAGE_KILL_ORDER) return;
    const tracked = npcsByPlayer.get(player);
    if (tracked) {
      tracked.delete("ithoi");
      if (tracked.size === 0) npcsByPlayer.delete(player);
    }
    advance(player, STAGE_KILLED);
  }

  // ==========================================================================
  // Session lifecycle
  // ==========================================================================

  function sendProgress(player) {
    const packet = player.getPacketSender();
    packet.sendVarbit(VARBIT_PROGRESS, quest.getStage(player));
    packet.sendVarbit(VARBIT_CABINBOY, cabinboy(player));
    packet.sendVarbit(VARBIT_COOK, cook(player));
    packet.sendVarbit(VARBIT_THIEF, thief(player));
    packet.sendVarbit(VARBIT_NAVIGATOR, navigator(player));
  }

  function handleLogin({ player }) {
    if (!player) return;
    refreshQuestList(player);
    sendProgress(player);
    ensureNpcs(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    const tracked = npcsByPlayer.get(player);
    if (tracked) for (const npc of tracked.values()) api.removeNpc(npc);
    npcsByPlayer.delete(player);
  }

  // ==========================================================================
  // Journal
  // ==========================================================================

  function crewLine(progress, done, text) {
    return progress >= done ? `<str>${text}</str>` : text;
  }

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>Captain Tock asked me to help lift the curse on his crew.</str>",
        "<str>I looked into the crew's stories and found the curse was fake.</str>",
        "<str>Ithoi the Navigator had poisoned the crew to keep his place on</str>",
        "<str>the ship, and I dealt with him for Captain Tock.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_KILLED) {
      return [
        "<str>Ithoi had poisoned the crew and faked the curse.</str>",
        "<str>I killed Ithoi as Captain Tock asked.</str>",
        "",
        "I should tell <col=800000>Captain Tock</col> what has happened.",
      ];
    }
    if (stage >= STAGE_KILL_ORDER) {
      return [
        "<str>I proved Ithoi's curse was fake.</str>",
        "Captain Tock has asked me to kill <col=800000>Ithoi the Navigator</col>.",
      ];
    }
    if (stage >= STAGE_PROVED) {
      return [
        "<str>Ithoi confessed that he poisoned the crew and faked the curse.</str>",
        "<str>I lit the driftwood under his hut and he ran out to put it out,</str>",
        "<str>proving he was never sick.</str>",
        "",
        "I should tell <col=800000>Captain Tock</col>.",
      ];
    }
    if (stage >= STAGE_CONFESSED) {
      return [
        "<str>Ithoi admitted poisoning the crew to save his place on the ship.</str>",
        "",
        "He will not get up on his own, so I need to prove he is faking his illness.",
      ];
    }
    if (stage >= STAGE_FIRING_KNOWN) {
      return [
        "<str>Captain Tock says the crew fell ill after dinner, but Ithoi, who</str>",
        "<str>did not eat it, felt ill too.</str>",
        "",
        "<str>Gnocci says Ithoi cooked that meal, and Arsen says the Captain</str>",
        "<str>may dismiss Ithoi now the Corsairs no longer need a navigator.</str>",
        "",
        "I should confront <col=800000>Ithoi the Navigator</col>.",
      ];
    }
    if (stage >= STAGE_TRAITOR_KNOWN) {
      return [
        "<str>None of the crew's own theories could have caused the curse.</str>",
        "",
        "<str>Captain Tock says the crew fell ill after dinner, but Ithoi, who</str>",
        "<str>did not eat it, felt ill too.</str>",
        "",
        "I should ask the crew about <col=800000>that meal</col>.",
      ];
    }
    if (stage >= STAGE_INVESTIGATING) {
      return [
        "<str>Captain Tock asked me to help lift the curse on his crew.</str>",
        "<str>Ithoi the Navigator says the crew really are cursed.</str>",
        "",
        "I should investigate the crew's stories:",
        crewLine(thief(player), THIEF_TOLD, "Arsen's relic was only a tooth-pick."),
        crewLine(cabinboy(player), CABINBOY_TOLD, "The mermaid Colin saw was an ogre."),
        crewLine(cook(player), COOK_TOLD, "The possessed doll was clockwork."),
      ];
    }
    if (stage >= STAGE_ARRIVED) {
      return [
        "<str>Captain Tock asked me to help lift the curse on his crew.</str>",
        "<str>We sailed to Corsair Cove.</str>",
        "",
        "I should speak to <col=800000>Ithoi the Navigator</col>, whose hut is",
        "on the beach to the south-west, before the other crew members.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "Captain Tock asked me to help lift the curse on his crew.",
        "",
        "His ship is moored at the west end of <col=800000>Rimmington</col>.",
        "I should meet him on board and sail to <col=800000>Corsair Cove</col>.",
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Captain Tock</col>",
      "at the crossroads north of <col=800000>Port Sarim</col>.",
    ];
  }

  api.persistAttribute(CABINBOY_ATTRIBUTE);
  api.persistAttribute(COOK_ATTRIBUTE);
  api.persistAttribute(THIEF_ATTRIBUTE);
  api.persistAttribute(NAVIGATOR_ATTRIBUTE);
  api.persistAttribute(TRAITOR_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "the_corsair_curse",
    name: "The Corsair Curse",
    varpId: VARP_CORSAIR_CURSE,
    varbitId: VARBIT_PROGRESS,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [],
    otherRewards: [
      "Access to Yusuf's bank in the Corsair Cove",
      "The ability to dock your boat at the Corsair Cove Port",
    ],
    buildJournal,
  });

  placeDriftwood(DRIFTWOOD_OBJECT);

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:action", handleDialogueAction);
  api.onCustomEvent("npc-dialogue:choice", handleDialogueChoice);
  api.onNpcInteraction("Captain Tock", { Travel: handleTravel });
  api.onNpcInteraction("Cabin Boy Colin", { Travel: handleTravel });
  api.onObjectInteraction(handleObjectInteraction);
  api.onItemOnObject(handleItemOnObject);
  api.onItemAction("Spade", { Dig: handleDig });
  api.onItemOnNpc(handleItemOnNpc);
  api.onNpcDeath(handleNpcDeath);
  api.onCustomEvent("ladders:climb", claimClimb);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
