/**
 * Pandemonium (members).
 *
 * The words come from the "Pandemonium" transcript page; this plugin supplies the
 * variant selector for 'Squawking' Steve Beanie, Ribs, Junior Jim and the port
 * masters, the Talk-to takeover for Will and Anne (their spawned cache ids are not
 * the indexed ones, so the NpcDialogues id lookup cannot reach the quest page), the
 * prose-condition answers, the cached boat scene and shipyard interactions, the
 * ledger hand-ins, the journal and the rewards.
 *
 * Stages (varbit 18314 "sailing_intro", varp 4959 bits 0-5). The Wiki lists no
 * stage values; the cache's own complete value is 50 (docs/sailing-osrs-reference.md
 * records the shipyard Build scripts and the tools table needing 18314 >= 50, and
 * sailing/cargo.js unlocks the captain's log tool at 50), so 50 is complete and the
 * intermediate values are this plugin's own:
 *   1 started (interview accepted)
 *   2 boarded the ship
 *   3 set-sail talk heard (before-sailing-off reminder)
 *   4 back at Port Sarim (used the "Actually, I want to go back" option)
 *   5 "Okay, I'll get to it." (sailing to the wreck)
 *   6 arrived at the salvaging point
 *   7 salvaged the cup and medallion, washed up at the Pandemonium
 *   8 asked Steve about Will and Anne (he points to Ribs)
 *   9 heard Ribs's tale (he points back to Steve)
 *  10 Steve suggested Junior Jim (a boat of my own)
 *  11 old cup handed to Junior Jim (at the shipyard)
 *  12 cargo hold built
 *  13 captain's log received
 *  14 crate of ship parts taken at Port Sarim
 *  15 crate delivered at the Pandemonium
 *  16 Junior Jim told the cargo is delivered
 *  50 complete
 * Sibling bits of the same varp, re-sent on login: 18315 reached-wreck,
 * 18316 received-repair-kits.
 *
 * Rewards (OSRS Wiki): 1 Quest point, 300 Sailing XP (plus 100 on delivering the
 * cargo), access to Sailing and The Pandemonium, a raft, 25 sawmill coupon (wood
 * plank), 2 repair kits and a spyglass. XP and the items are granted in onReward.
 *
 * Gaps/approximations:
 * - There is no Sailing API in api.core, so Will and Anne's ship and the raft are
 *   approximated. Boarding teleports the player to the quest's own cached boat deck
 *   (z=1 at 1498,4510: `sailing_intro_salvaging_hook` 60480, Sails 59553, Helm
 *   59621, with the Wreck 58208 below), where the pair are owner-spawned; sailing
 *   to the wreck is represented by talking to them again, and arrival/deploy use the
 *   real Deploy salvaging hook. The ambient "sailing-the-boat-*" variants are not
 *   played (no moving boat to trigger them).
 * - The shipyard build is represented by a Board `Gangplank` (59721) this plugin
 *   places at (2086,2723) beside the shipyard's own berth; with hammer and saw the
 *   Board plays the wiki's cargo-hold build. The raft, cargo hold and hold contents
 *   do not exist, so the crate of ship parts goes straight from the Port Sarim ledger
 *   table to the Pandemonium one (as Prying Times does), and the goods "left in the
 *   hold" are granted with the completion rewards.
 * - Old Grog has no transcript page in npc-dialogues.json, so his lines in the
 *   finale borrow the talking NPC's (Steve's) chathead; he is owner-spawned for the
 *   scene and removed on "Old Grog departs.".
 * - Will and Anne have no post-quest variant in the dump, so a completed player
 *   falls through to their standard page. Their short "after starting the quest"
 *   variants lost their jump targets (and the offer variant its boarding action), so
 *   the full interview is replayed while the quest is at stage 1. startTranscript has
 *   no speaker index, so a transcript's typed lines all use the talked-to NPC's
 *   chathead (Will/Anne swap heads between conversations).
 * - SailingShipyard.plugin.js resets varbit 18314 to 0 when a shipyard visit ends,
 *   clobbering the mirrored stage until the next login re-sends it (the persisted
 *   stage attribute keeps the real value). Restoring it needs a shared change.
 */
module.exports = function registerPandemoniumQuest(api) {
  const {
    GameObject,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    ObjectManager,
    ShopManager,
    Skill,
    TeleportHandler,
    TeleportType,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  // NPCs (cache ids; NpcIdentifiers comments).
  const WILL_NPC_ID = NpcIdentifiers.WILL; // 14959, the cached boat scene's Will
  const ANNE_NPC_ID = NpcIdentifiers.ANNE_3; // 14964, the cached boat scene's Anne
  const STEVE_NPC_ID = NpcIdentifiers.SQUAWKING_STEVE_BEANIE; // 14968
  const STEVE_NPC_ID_2 = NpcIdentifiers.SQUAWKING_STEVE_BEANIE_2; // 14969
  const RIBS_NPC_ID = NpcIdentifiers.RIBS; // 14971
  const JIM_NPC_ID = NpcIdentifiers.JUNIOR_JIM_2; // 14975, Junior Jim on the docks
  const OLD_GROG_NPC_ID = NpcIdentifiers.OLD_GROG; // 14977
  const PORT_MASTER_SARIM_NPC_ID = NpcIdentifiers.PORT_MASTER; // 15459, Port Sarim
  const PORT_MASTER_PANDEMONIUM_NPC_ID = NpcIdentifiers.PORT_MASTER_3; // 15461, The Pandemonium
  const STEVE_NPC_IDS = new Set([STEVE_NPC_ID, STEVE_NPC_ID_2]);
  const JIM_NPC_IDS = new Set([
    NpcIdentifiers.JUNIOR_JIM, // 14974
    JIM_NPC_ID,
    NpcIdentifiers.JUNIOR_JIM_3, // 15238
  ]);

  // Items (cache ids; ItemIdentifiers comments).
  const OLD_CUP_ITEM_ID = ItemIdentifiers.OLD_CUP; // 31338
  const HAMMER_ITEM_ID = ItemIdentifiers.HAMMER; // 2347
  const SAW_ITEM_ID = ItemIdentifiers.SAW; // 8794
  const CAPTAINS_LOG_ITEM_ID = ItemIdentifiers.CAPTAINS_LOG; // 31985
  const CRATE_OF_SHIP_PARTS_ITEM_ID = ItemIdentifiers.CRATE_OF_SHIP_PARTS; // 32514
  const SAWMILL_COUPON_ITEM_ID = ItemIdentifiers.SAWMILL_COUPON_WOOD_PLANK_; // 32083
  const REPAIR_KIT_ITEM_ID = ItemIdentifiers.REPAIR_KIT; // 31964
  const SPYGLASS_ITEM_ID = ItemIdentifiers.SPYGLASS; // 31803

  // The quest's own salvaging hook: cache `sailing_intro_salvaging_hook`, unnamed in this
  // revision (60481/60482 are its named no-op/ops twins, not the placed loc).
  const SALVAGING_HOOK_OBJECT_ID = 60480;

  const VARP_SAILING_INTRO = 4959; // "sailing_intro_primary"
  const VARBIT_SAILING_INTRO = 18314; // sailing_intro, varp 4959 bits 0-5
  const VARBIT_REACHED_WRECK = 18315; // sailing_intro_reached_wreck, bit 6
  const VARBIT_RECEIVED_REPAIR_KITS = 18316; // sailing_intro_received_repairkits, bit 7
  const SHOP_PANDEMONIUM_PUB = 1415; // shops.json "The Pandemonium (pub)"

  const STAGE_STARTED = 1;
  const STAGE_BOARDED = 2;
  const STAGE_SAILING = 3;
  const STAGE_PORT_SARIM_RETURN = 4;
  const STAGE_SAIL_ACCEPTED = 5;
  const STAGE_ARRIVED = 6;
  const STAGE_SALVAGED = 7;
  const STAGE_STEVE_ASKED = 8;
  const STAGE_RIBS_DONE = 9;
  const STAGE_JIM_TOLD = 10;
  const STAGE_CUP_GIVEN = 11;
  const STAGE_HOLD_BUILT = 12;
  const STAGE_LOG_GIVEN = 13;
  const STAGE_CARGO_TAKEN = 14;
  const STAGE_CARGO_DELIVERED = 15;
  const STAGE_JIM_DONE = 16;
  const STAGE_COMPLETE = 50;

  const SAILING_XP = 300;
  const CARGO_DELIVERY_XP = 100;
  const SAWMILL_COUPONS = 25;
  const REPAIR_KITS = 2;

  const PAGE = "Pandemonium";
  const START_HOOK = "quest:pandemonium:start";

  // Variant names (npc-dialogues.json, "Pandemonium" page).
  const WILL_START_VARIANT = "starting-off-talking-to-anne-or-will";
  const WILL_ABOARD_VARIANT = "at-the-boat-talking-to-anne-or-will";
  const WILL_SAIL_OFF_VARIANT = "at-the-boat-talking-to-will-or-anne-before-sailing-off";
  const WILL_DEPLOY_EARLY_VARIANT = "at-the-boat-deploying-the-salvaging-hook-before-sailing-off";
  const WILL_BACK_AT_PORT_VARIANT = "at-the-boat-talking-to-will-or-anne-back-at-port-sarim";
  const WILL_ARRIVAL_VARIANT = "reaching-the-salvaging-point";
  const WILL_ARRIVAL_AGAIN_VARIANT =
    "reaching-the-salvaging-point-talking-to-anne-or-will-after-they-explain-salvaging-or-interacting-with-the-helm-or-sails";
  const WILL_DEPLOY_VARIANT = "reaching-the-salvaging-point-deploying-the-salvaging-hook";
  const WILL_SWIM_VARIANT = "reaching-the-salvaging-point-swimming-to-shore";
  const STEVE_FIRST_VARIANT = "at-the-pandemonium-talking-to-squawking-steve-beanie";
  const STEVE_ASKED_AGAIN_VARIANT = "at-the-pandemonium-talking-to-squaking-steve-beanie-again";
  const STEVE_AFTER_RIBS_VARIANT = "at-the-pandemonium-talking-to-squawking-steve-beanie-again";
  const STEVE_SUBSEQUENT_VARIANT = "at-the-pandemonium-subsequent-dialogue-with-squawking-steve-beanie";
  const STEVE_FINALE_VARIANT = "talking-to-steve";
  const STEVE_POST_QUEST_VARIANT = "talking-to-steve-talking-to-steve-again-after-old-grog-departs";
  const RIBS_FIRST_VARIANT = "at-the-pandemonium-talking-to-ribs";
  const RIBS_AGAIN_VARIANT = "at-the-pandemonium-talking-to-ribs-again";
  const JIM_TRADE_VARIANT = "talking-to-junior-jim";
  const JIM_NO_CUP_VARIANT =
    "talking-to-junior-jim-talking-to-junior-jim-again-before-showing-him-the-cup-or-using-the-cup-on-him";
  const JIM_SHIPYARD_AGAIN_VARIANT = "the-shipyard-talking-to-junior-jim-again";
  const JIM_SHIPYARD_RETURN_VARIANT = "the-shipyard-talking-to-junior-jim-again-2";
  const JIM_CARGO_PROGRESS_VARIANT = "at-the-pandemonium-talking-to-junior-jim-after-he-asks-for-the-cargo";
  const JIM_DELIVERED_VARIANT = "at-the-pandemonium-talking-to-junior-jim-after-depositing-the-cargo";
  const JIM_CRATE_HAMMERS_VARIANT = "the-shipyard-taking-from-the-crate-of-hammers";
  const JIM_CRATE_SAWS_VARIANT = "the-shipyard-taking-from-the-crate-of-saws";
  const JIM_SCHEMATICS_BEFORE_VARIANT = "the-shipyard-modify-boat-schematics-before-building-the-cargo-hold";
  const JIM_SCHEMATICS_AFTER_VARIANT = "the-shipyard-attempting-to-modify-the-cargo-hold";
  const JIM_BUILD_VARIANT = "the-shipyard-building-the-cargo-hold";
  const PORT_MASTER_SARIM_VARIANT = "at-port-sarim-talking-to-the-port-master";
  const PORT_MASTER_TAKE_VARIANT = "at-port-sarim-taking-cargo-from-the-ledger-table";
  const PORT_MASTER_PANDEMONIUM_VARIANT = "at-the-pandemonium-talking-to-the-port-master";
  const PORT_MASTER_DROP_VARIANT = "at-the-pandemonium-dropping-off-the-cargo-on-the-ledger-table";
  const PORT_MASTER_DONE_VARIANT = "at-the-pandemonium-talking-to-the-port-master-after-dropping-off-the-cargo";

  // Condition step ids on the "Pandemonium" page (research pack).
  const CANNOT_START_CONDITION_ID = "W3C3C9";
  const INTERVIEW_NO_SPACE_CONDITION_ID = "CCJ1aq";
  const BACK_NO_SPACE_CONDITION_ID = "jS98T4";
  const DEPLOY_NO_SPACE_CONDITION_ID = "XUpDAq";
  const STEVE_NOT_ASKED_CONDITION_ID = "CNjUL8";
  const CUP_RECOVERY_NO_SPACE_CONDITION_ID = "43Ms0-";
  const LOST_OLD_CUP_CONDITION_ID = "A7s0Gf";
  const LOST_CUP_CONDITION_ID = "hf2_5G";
  const HAS_CUP_CONDITION_ID = "a8695u";
  const NO_BOTH_TOOLS_CONDITION_ID = "WjitRI";
  const HAS_BOTH_TOOLS_CONDITION_ID = "3rjK-a";
  const NO_HAMMER_CONDITION_ID = "Q7H8oK";
  const HAS_HAMMER_CONDITION_ID = "xuFc3_";
  const NO_SAW_CONDITION_ID = "N0YXhs";
  const HAS_SAW_CONDITION_ID = "VWaptx";
  const LOG_NO_SPACE_CONDITION_ID = "K30w8b";
  const LOG_AGAIN_NO_SPACE_CONDITION_ID = "JFe9GO";
  const SARIM_HAS_CARGO_CONDITION_ID = "abPgqO";
  const JIM_NO_CARGO_CONDITION_ID = "dnoJFg";
  const JIM_HAS_CARGO_CONDITION_ID = "p6q3K5";
  const PAN_NO_CARGO_CONDITION_ID = "ypYvbi";
  const PAN_HAS_CARGO_CONDITION_ID = "TpqvDF";

  // Message/action step ids whose side effects this plugin performs.
  const BOARD_SHIP_ACTION_ID = "BDfVg8";
  const GO_BACK_TO_PORT_ACTION_ID = "VuZpfc";
  const GO_BACK_TO_SHIP_ACTION_ID = "Nm7LVw";
  const SALVAGE_MESSAGE_ID = "p40qKY";
  const PUSH_OVERBOARD_ACTION_ID = "hQBGdU";
  const WALK_TO_PANDEMONIUM_ACTION_ID = "dpOs4I";
  const CUP_RECOVERY_MESSAGE_ID = "P7HYtI";
  const GIVE_CUP_MESSAGE_ID = "jkS3Ej";
  const GO_TO_SHIPYARD_ACTION_ID = "TIfJ86";
  const TAKE_HAMMER_MESSAGE_ID = "niwCRR";
  const TAKE_SAW_MESSAGE_ID = "CnlEDp";
  const BUILD_HOLD_MESSAGE_ID = "bu1EIn";
  const BACK_TO_PANDEMONIUM_ACTION_ID = "HrNl3J";
  const LOG_GIVEN_MESSAGE_ID = "7jgwOg";
  const LOG_AGAIN_GIVEN_MESSAGE_ID = "g4CUrq";
  const TAKE_CARGO_MESSAGE_ID = "8bdD6i";
  const DELIVER_CARGO_MESSAGE_ID = "Bvs9Sf";
  const OLD_GROG_DEPARTS_MESSAGE_ID = "C5l2Ww";
  const QUEST_COMPLETE_ACTION_ID = "SJ3WVd";
  const OPEN_SHOP_ACTION_ID = "n-AhO0";

  // Option and line texts the stage changes key on.
  const GET_TO_IT_OPTION = "Okay, I'll get to it.";
  const STEVE_RIBS_LINE = "speak to Ribs";
  const STEVE_JIM_LINE = "speak with Junior Jim";
  const JIM_FAREWELL_LINE = "Don't mention it, mate.";

  // Quest-only scenery and teleport tiles (quest-helper/cache positions; the ledgers and
  // gangplank are absent from this world's maps, the boat deck is the cache's own scene).
  const BOAT_DECK_TILE = { x: 1498, y: 4511, z: 1 };
  const BOAT_WILL_TILE = { x: 1498, y: 4512, z: 1 };
  const BOAT_ANNE_TILE = { x: 1499, y: 4512, z: 1 };
  const PORT_SARIM_TILE = { x: 3025, y: 3209, z: 0 };
  const PANDEMONIUM_LANDING_TILE = { x: 3069, y: 2987, z: 0 };
  const PANDEMONIUM_PUB_TILE = { x: 3050, y: 2967, z: 0 };
  const SHIPYARD_TILE = { x: 2084, y: 2730, z: 0 };
  const SHIPYARD_JIM_TILE = { x: 2085, y: 2730, z: 0 };
  const STEVE_SPAWN_TILE = { x: 3050, y: 2966, z: 0 };
  const RIBS_SPAWN_TILE = { x: 3051, y: 2974, z: 0 };
  const OLD_GROG_SPAWN_TILE = { x: 3049, y: 2966, z: 0 };
  const PORT_SARIM_LEDGER_TILE = { x: 3049, y: 3193 };
  const PANDEMONIUM_LEDGER_TILE = { x: 3068, y: 2987 };
  const SHIPYARD_GANGPLANK_TILE = { x: 2086, y: 2723 };
  // The shipyard map square (SailingShipyard bounds), for the login recovery.
  const SHIPYARD_BOUNDS = { minX: 2048, maxX: 2111, minY: 2688, maxY: 2751 };

  let quest;
  let questObjectsInstalled = false;
  const steveByPlayer = new WeakMap();
  const ribsByPlayer = new WeakMap();
  const boatCrewByPlayer = new WeakMap();
  const shipyardJimByPlayer = new WeakMap();
  const oldGrogByPlayer = new WeakMap();

  const held = (player, itemId, amount = 1) => player.getInventory().getAmount(itemId) >= amount;
  const freeSlots = (player) => player.getInventory().getFreeSlots();
  const isSteve = (npcId) => STEVE_NPC_IDS.has(npcId);
  const isJim = (npcId) => JIM_NPC_IDS.has(npcId);

  function teleport(player, tile, onArrival) {
    TeleportHandler.teleport(player, new Location(tile.x, tile.y, tile.z), TeleportType.NORMAL, false, onArrival);
  }

  /**
   * Moves the player once the dialogue has closed. A step's teleport closes the chatbox
   * (TeleportHandler.onTeleporting), which would cut off the lines that follow it in the
   * transcript (TIfJ86, HrNl3J, dpOs4I), so those wait for the chatbox to be gone.
   */
  function teleportAfterDialogue(player, tile, onArrival) {
    const { CountdownTask, TaskManager, MultiChatboxPrompt } = api.core;
    TaskManager.submit(
      new CountdownTask(player, 1, () => {
        if (player.isRegistered?.() === false) return;
        const chatbox = player.getDialogueManager?.()?.isActive?.() === true
          || (MultiChatboxPrompt?.getPending?.(player) ?? null) !== null;
        if (chatbox) {
          teleportAfterDialogue(player, tile, onArrival);
          return;
        }
        teleport(player, tile);
        onArrival?.();
      })
    );
  }

  function removeTracked(player, map) {
    const npc = map.get(player);
    if (npc) api.removeNpc(npc);
    map.delete(player);
  }

  function hasNpcNear(player, npcId, tile, range = 10) {
    for (const npc of api.getWorld().getNpcs()) {
      if (npc.getId?.() !== npcId) continue;
      // Another player's owner-only spawn is invisible here and must not stand in for ours.
      if (npc.isOwnerOnly?.() && npc.getOwner?.() !== player) continue;
      const location = npc.getLocation?.();
      if (!location || location.getZ() !== tile.z) continue;
      if (Math.max(Math.abs(location.getX() - tile.x), Math.abs(location.getY() - tile.y)) <= range) {
        return true;
      }
    }
    return false;
  }

  function spawnOwnerNpc(npcId, tile, owner) {
    return api.spawnNpc({
      id: npcId,
      x: tile.x,
      y: tile.y,
      z: tile.z,
      wanderRadius: 0,
      owner,
      ownerOnly: true,
    });
  }

  function ensureBoatCrew(player) {
    const existing = boatCrewByPlayer.get(player);
    if (existing?.will?.isRegistered?.() && existing?.anne?.isRegistered?.()) return;
    const will = spawnOwnerNpc(WILL_NPC_ID, BOAT_WILL_TILE, player);
    const anne = spawnOwnerNpc(ANNE_NPC_ID, BOAT_ANNE_TILE, player);
    if (will || anne) boatCrewByPlayer.set(player, { will, anne });
  }

  function removeBoatCrew(player) {
    removeTracked(player, boatCrewByPlayer);
  }

  function ensureShipyardJim(player) {
    if (shipyardJimByPlayer.get(player)?.isRegistered?.()) return;
    const npc = spawnOwnerNpc(JIM_NPC_ID, SHIPYARD_JIM_TILE, player);
    if (npc) shipyardJimByPlayer.set(player, npc);
  }

  function removeShipyardJim(player) {
    removeTracked(player, shipyardJimByPlayer);
  }

  function ensureOldGrog(player) {
    if (oldGrogByPlayer.get(player)?.isRegistered?.()) return;
    const npc = spawnOwnerNpc(OLD_GROG_NPC_ID, OLD_GROG_SPAWN_TILE, player);
    if (npc) oldGrogByPlayer.set(player, npc);
  }

  function removeOldGrog(player) {
    removeTracked(player, oldGrogByPlayer);
  }

  function ensureRibs(player) {
    if (ribsByPlayer.get(player)?.isRegistered?.()) return;
    const npc = spawnOwnerNpc(RIBS_NPC_ID, RIBS_SPAWN_TILE, player);
    if (npc) ribsByPlayer.set(player, npc);
  }

  /**
   * Steve is spawned one tick late: Prying Times owner-spawns him at the same tile in
   * its own login hook, so waiting a tick lets this plugin find and keep that one
   * instead of putting two Steves on top of each other.
   */
  function scheduleEnsureSteve(player) {
    const { CountdownTask, TaskManager } = api.core;
    TaskManager.submit(new CountdownTask(player, 1, () => ensureSteve(player)));
  }

  function ensureSteve(player) {
    if (steveByPlayer.get(player)?.isRegistered?.()) return;
    if (hasNpcNear(player, STEVE_NPC_ID, STEVE_SPAWN_TILE)) return;
    const npc = spawnOwnerNpc(STEVE_NPC_ID, STEVE_SPAWN_TILE, player);
    if (npc) steveByPlayer.set(player, npc);
  }

  function openPandemoniumShop(player) {
    const { CountdownTask, TaskManager } = api.core;
    TaskManager.submit(new CountdownTask(player, 1, () => ShopManager.open(player, SHOP_PANDEMONIUM_PUB)));
  }

  // ==========================================================================
  // Variant selection and condition answers
  // ==========================================================================

  function jimVariant(player, stage) {
    if (quest.isComplete(player)) return null; // his standard page takes over
    switch (stage) {
      case STAGE_JIM_TOLD:
        return held(player, OLD_CUP_ITEM_ID) ? JIM_TRADE_VARIANT : JIM_NO_CUP_VARIANT;
      case STAGE_CUP_GIVEN:
        return JIM_SHIPYARD_AGAIN_VARIANT;
      case STAGE_HOLD_BUILT:
        return JIM_SHIPYARD_RETURN_VARIANT;
      case STAGE_LOG_GIVEN:
      case STAGE_CARGO_TAKEN:
        return JIM_CARGO_PROGRESS_VARIANT;
      case STAGE_CARGO_DELIVERED:
        return JIM_DELIVERED_VARIANT;
      default:
        return null;
    }
  }

  /** Which transcript variant the NPC plays, scoped to the quest's own NPCs and stages. */
  function selectVariant({ npcId, player }) {
    const complete = quest.isComplete(player);
    const stage = quest.getStage(player);
    if (isSteve(npcId)) {
      if (complete) return STEVE_POST_QUEST_VARIANT;
      if (stage >= STAGE_JIM_DONE) {
        ensureOldGrog(player);
        return STEVE_FINALE_VARIANT;
      }
      removeOldGrog(player);
      if (stage >= STAGE_JIM_TOLD) return STEVE_SUBSEQUENT_VARIANT;
      if (stage >= STAGE_RIBS_DONE) return STEVE_AFTER_RIBS_VARIANT;
      if (stage >= STAGE_STEVE_ASKED) return STEVE_ASKED_AGAIN_VARIANT;
      if (stage >= STAGE_SALVAGED) return STEVE_FIRST_VARIANT;
      return null;
    }
    if (npcId === RIBS_NPC_ID) {
      if (complete || stage >= STAGE_RIBS_DONE) return RIBS_AGAIN_VARIANT;
      if (stage >= STAGE_STEVE_ASKED) return RIBS_FIRST_VARIANT;
      return null;
    }
    if (isJim(npcId)) return jimVariant(player, stage);
    if (npcId === PORT_MASTER_SARIM_NPC_ID) {
      return stage >= STAGE_LOG_GIVEN && stage <= STAGE_CARGO_TAKEN ? PORT_MASTER_SARIM_VARIANT : null;
    }
    if (npcId === PORT_MASTER_PANDEMONIUM_NPC_ID) {
      if (stage === STAGE_CARGO_TAKEN) return PORT_MASTER_PANDEMONIUM_VARIANT;
      if (stage >= STAGE_CARGO_DELIVERED && stage < STAGE_JIM_DONE) return PORT_MASTER_DONE_VARIANT;
      return null;
    }
    return null;
  }

  /** Answers the wiki prose conditions, scoped by the page's own step ids. */
  function answerCondition({ player, stepId }) {
    switch (stepId) {
      case CANNOT_START_CONDITION_ID:
        return false; // no requirements
      case INTERVIEW_NO_SPACE_CONDITION_ID:
      case BACK_NO_SPACE_CONDITION_ID:
      case DEPLOY_NO_SPACE_CONDITION_ID:
      case CUP_RECOVERY_NO_SPACE_CONDITION_ID:
      case LOG_NO_SPACE_CONDITION_ID:
      case LOG_AGAIN_NO_SPACE_CONDITION_ID:
        return freeSlots(player) < 1;
      case STEVE_NOT_ASKED_CONDITION_ID:
        return quest.getStage(player) < STAGE_STEVE_ASKED;
      case LOST_OLD_CUP_CONDITION_ID:
      case LOST_CUP_CONDITION_ID:
        return !held(player, OLD_CUP_ITEM_ID);
      case HAS_CUP_CONDITION_ID:
        return held(player, OLD_CUP_ITEM_ID);
      case NO_BOTH_TOOLS_CONDITION_ID:
        return !(held(player, HAMMER_ITEM_ID) && held(player, SAW_ITEM_ID));
      case HAS_BOTH_TOOLS_CONDITION_ID:
        return held(player, HAMMER_ITEM_ID) && held(player, SAW_ITEM_ID);
      case NO_HAMMER_CONDITION_ID:
        return !held(player, HAMMER_ITEM_ID);
      case HAS_HAMMER_CONDITION_ID:
        return held(player, HAMMER_ITEM_ID);
      case NO_SAW_CONDITION_ID:
        return !held(player, SAW_ITEM_ID);
      case HAS_SAW_CONDITION_ID:
        return held(player, SAW_ITEM_ID);
      case SARIM_HAS_CARGO_CONDITION_ID:
      case JIM_HAS_CARGO_CONDITION_ID:
      case PAN_HAS_CARGO_CONDITION_ID:
        return held(player, CRATE_OF_SHIP_PARTS_ITEM_ID);
      case JIM_NO_CARGO_CONDITION_ID:
      case PAN_NO_CARGO_CONDITION_ID:
        return !held(player, CRATE_OF_SHIP_PARTS_ITEM_ID);
      default:
        return null;
    }
  }

  // ==========================================================================
  // Talk-to: Will and Anne are not in npc-dialogue-index.json under their spawned
  // ids, so their whole conversation is replayed through startTranscript.
  // ==========================================================================

  function willAnneTalkTo(event) {
    const { player, npcId, definition } = event;
    const name = definition?.getName?.();
    if (name !== "Will" && name !== "Anne") return false;
    if (quest.isComplete(player)) return false; // no post-quest variant in the dump
    const stage = quest.getStage(player);
    if (stage === 0) {
      startTranscript(api, player, npcId, PAGE, WILL_START_VARIANT);
      return true;
    }
    if (stage === STAGE_STARTED) {
      // The two short "after starting"/"after being offered" variants lose their jump
      // targets (and the offer variant its boarding action) in the dump, so the full
      // interview is replayed; it reaches the boarding action reliably.
      startTranscript(api, player, npcId, PAGE, WILL_START_VARIANT);
      return true;
    }
    if (stage === STAGE_BOARDED) {
      startTranscript(api, player, npcId, PAGE, WILL_ABOARD_VARIANT);
      quest.setStage(player, STAGE_SAILING);
      return true;
    }
    if (stage === STAGE_SAILING) {
      startTranscript(api, player, npcId, PAGE, WILL_SAIL_OFF_VARIANT);
      return true;
    }
    if (stage === STAGE_PORT_SARIM_RETURN) {
      startTranscript(api, player, npcId, PAGE, WILL_BACK_AT_PORT_VARIANT);
      return true;
    }
    if (stage === STAGE_SAIL_ACCEPTED) {
      startTranscript(api, player, npcId, PAGE, WILL_ARRIVAL_VARIANT);
      quest.setStage(player, STAGE_ARRIVED);
      player.getPacketSender().sendVarbit(VARBIT_REACHED_WRECK, 1);
      return true;
    }
    if (stage === STAGE_ARRIVED) {
      startTranscript(api, player, npcId, PAGE, WILL_ARRIVAL_AGAIN_VARIANT);
      return true;
    }
    return false;
  }

  // ==========================================================================
  // Dialogue side effects
  // ==========================================================================

  function handleStartHook({ player, hook }) {
    if (hook !== START_HOOK) return;
    if (quest.getStage(player) === 0) quest.setStage(player, STAGE_STARTED);
  }

  function handleChoice(event) {
    const { player, npcId, definition, option } = event;
    if (typeof option !== "string") return;
    const name = definition?.getName?.();
    if (name === "Will" || name === "Anne") {
      if (option === GET_TO_IT_OPTION && quest.getStage(player) === STAGE_SAILING) {
        quest.setStage(player, STAGE_SAIL_ACCEPTED);
      }
      return;
    }
    if (npcId === RIBS_NPC_ID && quest.getStage(player) === STAGE_STEVE_ASKED) {
      quest.setStage(player, STAGE_RIBS_DONE);
    }
  }

  /** The transcript has no end-of-branch action for these; their lines carry the stage. */
  function handleDialogueLine(event) {
    const { player, npcId, text } = event;
    if (typeof text !== "string") return;
    if (isSteve(npcId) && text.includes(STEVE_RIBS_LINE)) {
      if (quest.getStage(player) === STAGE_SALVAGED) quest.setStage(player, STAGE_STEVE_ASKED);
      return;
    }
    if (isSteve(npcId) && text.includes(STEVE_JIM_LINE)) {
      if (quest.getStage(player) < STAGE_JIM_TOLD && quest.getStage(player) >= STAGE_RIBS_DONE) {
        quest.setStage(player, STAGE_JIM_TOLD);
      }
      return;
    }
    if (isJim(npcId) && text === JIM_FAREWELL_LINE && quest.getStage(player) === STAGE_CARGO_DELIVERED) {
      quest.setStage(player, STAGE_JIM_DONE);
    }
  }

  function boardShip(player) {
    teleport(player, BOAT_DECK_TILE);
    ensureBoatCrew(player);
    if (quest.getStage(player) < STAGE_BOARDED) quest.setStage(player, STAGE_BOARDED);
  }

  /** Drops a trailing wiki "the conversation continues below" jump (the cutscene tail). */
  function dropJumps(steps) {
    return steps.filter((step) => step.type !== "jump");
  }

  function pushOverboard(player) {
    removeBoatCrew(player);
    teleport(player, PANDEMONIUM_LANDING_TILE, () => {
      if (player.isRegistered?.() === false) return;
      startTranscript(api, player, STEVE_NPC_ID, PAGE, WILL_SWIM_VARIANT, dropJumps);
    });
  }

  function completeQuest(player) {
    if (!quest.isComplete(player) && quest.getStage(player) >= STAGE_JIM_DONE) {
      quest.complete(player);
    }
    removeOldGrog(player);
  }

  function handleAction(event) {
    const { player, npcId, stepId } = event;
    switch (stepId) {
      case BOARD_SHIP_ACTION_ID:
        event.handled = true;
        boardShip(player);
        return;
      case GO_BACK_TO_PORT_ACTION_ID:
        event.handled = true;
        removeBoatCrew(player);
        teleport(player, PORT_SARIM_TILE);
        quest.setStage(player, STAGE_PORT_SARIM_RETURN);
        return;
      case GO_BACK_TO_SHIP_ACTION_ID:
        event.handled = true;
        teleport(player, BOAT_DECK_TILE);
        ensureBoatCrew(player);
        quest.setStage(player, STAGE_SAILING);
        return;
      case PUSH_OVERBOARD_ACTION_ID:
        event.handled = true;
        event.end = true;
        pushOverboard(player);
        return;
      case WALK_TO_PANDEMONIUM_ACTION_ID:
        event.handled = true;
        teleportAfterDialogue(player, PANDEMONIUM_PUB_TILE);
        return;
      case GO_TO_SHIPYARD_ACTION_ID:
        event.handled = true;
        ensureShipyardJim(player);
        teleportAfterDialogue(player, SHIPYARD_TILE);
        return;
      case BACK_TO_PANDEMONIUM_ACTION_ID:
        event.handled = true;
        teleportAfterDialogue(player, PANDEMONIUM_LANDING_TILE, () => removeShipyardJim(player));
        return;
      case OPEN_SHOP_ACTION_ID:
        if (!isSteve(npcId)) return;
        event.handled = true;
        event.end = true;
        openPandemoniumShop(player);
        return;
      case QUEST_COMPLETE_ACTION_ID:
        event.handled = true;
        event.end = true;
        completeQuest(player);
        return;
      case SALVAGE_MESSAGE_ID:
        if (!held(player, OLD_CUP_ITEM_ID)) player.getInventory().adds(OLD_CUP_ITEM_ID, 1);
        if (quest.getStage(player) < STAGE_SALVAGED) quest.setStage(player, STAGE_SALVAGED);
        return;
      case CUP_RECOVERY_MESSAGE_ID:
        if (!held(player, OLD_CUP_ITEM_ID)) player.getInventory().adds(OLD_CUP_ITEM_ID, 1);
        return;
      case GIVE_CUP_MESSAGE_ID:
        if (held(player, OLD_CUP_ITEM_ID)) player.getInventory().deleteNumber(OLD_CUP_ITEM_ID, 1);
        if (quest.getStage(player) < STAGE_CUP_GIVEN) quest.setStage(player, STAGE_CUP_GIVEN);
        return;
      case TAKE_HAMMER_MESSAGE_ID:
        if (!held(player, HAMMER_ITEM_ID)) player.getInventory().adds(HAMMER_ITEM_ID, 1);
        return;
      case TAKE_SAW_MESSAGE_ID:
        if (!held(player, SAW_ITEM_ID)) player.getInventory().adds(SAW_ITEM_ID, 1);
        return;
      case BUILD_HOLD_MESSAGE_ID:
        if (quest.getStage(player) < STAGE_HOLD_BUILT) quest.setStage(player, STAGE_HOLD_BUILT);
        return;
      case LOG_GIVEN_MESSAGE_ID:
      case LOG_AGAIN_GIVEN_MESSAGE_ID:
        if (!held(player, CAPTAINS_LOG_ITEM_ID)) player.getInventory().adds(CAPTAINS_LOG_ITEM_ID, 1);
        if (quest.getStage(player) < STAGE_LOG_GIVEN) quest.setStage(player, STAGE_LOG_GIVEN);
        return;
      case TAKE_CARGO_MESSAGE_ID:
        if (!held(player, CRATE_OF_SHIP_PARTS_ITEM_ID)) {
          if (freeSlots(player) < 1) {
            player.sendMessage("You don't have enough inventory space.");
            return;
          }
          player.getInventory().adds(CRATE_OF_SHIP_PARTS_ITEM_ID, 1);
        }
        if (quest.getStage(player) < STAGE_CARGO_TAKEN) quest.setStage(player, STAGE_CARGO_TAKEN);
        return;
      case DELIVER_CARGO_MESSAGE_ID:
        if (held(player, CRATE_OF_SHIP_PARTS_ITEM_ID)) {
          player.getInventory().deleteNumber(CRATE_OF_SHIP_PARTS_ITEM_ID, 1);
        }
        player.getSkillManager().addExperiences(Skill.SAILING, CARGO_DELIVERY_XP);
        if (quest.getStage(player) < STAGE_CARGO_DELIVERED) quest.setStage(player, STAGE_CARGO_DELIVERED);
        return;
      case OLD_GROG_DEPARTS_MESSAGE_ID:
        removeOldGrog(player);
        return;
      default:
    }
  }

  // ==========================================================================
  // Objects: the boat's salvaging hook, the shipyard crates/schematics/gangplank and
  // the two ledger tables. Each case no-ops (leaving `handled` false) when the quest
  // is not in the stage that owns it, so PortTasks/Prying Times still see the click.
  // ==========================================================================

  function deploySalvagingHook(event) {
    const { player } = event;
    event.handled = true;
    const stage = quest.getStage(player);
    if (stage >= STAGE_ARRIVED && !quest.isComplete(player)) {
      startTranscript(api, player, WILL_NPC_ID, PAGE, WILL_DEPLOY_VARIANT);
    } else if (stage >= STAGE_BOARDED) {
      startTranscript(api, player, WILL_NPC_ID, PAGE, WILL_DEPLOY_EARLY_VARIANT);
    }
  }

  function takeFromCrate(event, variant) {
    if (quest.getStage(event.player) !== STAGE_CUP_GIVEN) return;
    event.handled = true;
    startTranscript(api, event.player, JIM_NPC_ID, PAGE, variant);
  }

  function modifySchematics(event) {
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage === STAGE_CUP_GIVEN) {
      event.handled = true;
      startTranscript(api, player, JIM_NPC_ID, PAGE, JIM_SCHEMATICS_BEFORE_VARIANT);
      return;
    }
    if (stage >= STAGE_HOLD_BUILT && !quest.isComplete(player)) {
      event.handled = true;
      startTranscript(api, player, JIM_NPC_ID, PAGE, JIM_SCHEMATICS_AFTER_VARIANT);
    }
  }

  function boardQuestRaft(event) {
    const { player } = event;
    if (quest.getStage(player) !== STAGE_CUP_GIVEN) return;
    if (!held(player, HAMMER_ITEM_ID) || !held(player, SAW_ITEM_ID)) return;
    event.handled = true;
    startTranscript(api, player, JIM_NPC_ID, PAGE, JIM_BUILD_VARIANT);
  }

  function takeCargoAtPortSarim(event) {
    const { player } = event;
    const stage = quest.getStage(player);
    if ((stage !== STAGE_LOG_GIVEN && stage !== STAGE_CARGO_TAKEN) || held(player, CRATE_OF_SHIP_PARTS_ITEM_ID)) {
      return;
    }
    event.handled = true;
    startTranscript(api, player, PORT_MASTER_SARIM_NPC_ID, PAGE, PORT_MASTER_TAKE_VARIANT);
  }

  function depositCargoAtPandemonium(event) {
    const { player } = event;
    if (quest.getStage(player) !== STAGE_CARGO_TAKEN || !held(player, CRATE_OF_SHIP_PARTS_ITEM_ID)) return;
    event.handled = true;
    startTranscript(api, player, PORT_MASTER_PANDEMONIUM_NPC_ID, PAGE, PORT_MASTER_DROP_VARIANT);
  }

  function handleObjectInteraction(event) {
    if (event.clickType !== 1) return;
    switch (event.objectId) {
      case SALVAGING_HOOK_OBJECT_ID:
        deploySalvagingHook(event);
        return;
      case ObjectIdentifiers.CRATE_OF_HAMMERS:
        takeFromCrate(event, JIM_CRATE_HAMMERS_VARIANT);
        return;
      case ObjectIdentifiers.CRATE_OF_SAWS:
        takeFromCrate(event, JIM_CRATE_SAWS_VARIANT);
        return;
      case ObjectIdentifiers.BOAT_SCHEMATICS:
        modifySchematics(event);
        return;
      case ObjectIdentifiers.GANGPLANK_84:
        boardQuestRaft(event);
        return;
      case ObjectIdentifiers.LEDGER_TABLE_2:
        takeCargoAtPortSarim(event);
        return;
      case ObjectIdentifiers.LEDGER_TABLE_3:
        depositCargoAtPandemonium(event);
        return;
      default:
    }
  }

  function registerQuestObject(objectId, tile) {
    const object = new GameObject(objectId, new Location(tile.x, tile.y, 0), 10, 0, null);
    ObjectManager.register(object, true);
    return object;
  }

  /** Objects the world's maps lack: the two ledger tables and the quest gangplank. */
  function installQuestObjects() {
    if (questObjectsInstalled) return;
    questObjectsInstalled = true;
    registerQuestObject(ObjectIdentifiers.LEDGER_TABLE_2, PORT_SARIM_LEDGER_TILE);
    registerQuestObject(ObjectIdentifiers.LEDGER_TABLE_3, PANDEMONIUM_LEDGER_TILE);
    registerQuestObject(ObjectIdentifiers.GANGPLANK_84, SHIPYARD_GANGPLANK_TILE);
  }

  /** The quest's sibling varbits in varp 4959 are not stage-writable, so re-send them. */
  function sendIntroVarbits(player) {
    const stage = quest.getStage(player);
    if (stage >= STAGE_ARRIVED) player.getPacketSender().sendVarbit(VARBIT_REACHED_WRECK, 1);
    if (stage >= STAGE_COMPLETE) player.getPacketSender().sendVarbit(VARBIT_RECEIVED_REPAIR_KITS, 1);
  }

  /** The login bootstrap's all-spells-unlocked send clobbers shared varps; re-send ours. */
  function handleBootstrap({ player }) {
    if (player) sendIntroVarbits(player);
  }

  // ==========================================================================
  // Session lifecycle
  // ==========================================================================

  function inShipyard(location) {
    return location.getX() >= SHIPYARD_BOUNDS.minX && location.getX() <= SHIPYARD_BOUNDS.maxX
      && location.getY() >= SHIPYARD_BOUNDS.minY && location.getY() <= SHIPYARD_BOUNDS.maxY;
  }

  function handleLogin({ player }) {
    refreshQuestList(player);
    installQuestObjects();
    ensureRibs(player);
    scheduleEnsureSteve(player);
    const stage = quest.getStage(player);
    if (stage >= STAGE_BOARDED && stage <= STAGE_ARRIVED && stage !== STAGE_PORT_SARIM_RETURN) {
      ensureBoatCrew(player);
    }
    if (stage === STAGE_CUP_GIVEN || stage === STAGE_HOLD_BUILT) ensureShipyardJim(player);
    if (stage === STAGE_JIM_DONE) ensureOldGrog(player);
    // Logged out at the shipyard after the return teleport could not run: back to port.
    if (stage >= STAGE_LOG_GIVEN && inShipyard(player.getLocation())) {
      player.moveTo(new Location(PANDEMONIUM_LANDING_TILE.x, PANDEMONIUM_LANDING_TILE.y, 0));
    }
    sendIntroVarbits(player);
  }

  function handleLogout({ player }) {
    if (!player) return;
    removeBoatCrew(player);
    removeShipyardJim(player);
    removeOldGrog(player);
    removeTracked(player, steveByPlayer);
    removeTracked(player, ribsByPlayer);
  }

  // ==========================================================================
  // Journal and rewards
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I returned to Steve and he introduced me to Old Grog, a</str>",
        "<str>privateer hunting Will and Anne. Old Grog agreed to let me</str>",
        "<str>join him once I get more experience out at sea.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_JIM_DONE) {
      return [
        "<str>I sailed to Port Sarim and collected Jim's Cargo before</str>",
        "<str>delivering it to The Pandemonium. I should now check back in</str>",
        "with <col=800000>Steve</col> and see if he has an update on Will and Anne.",
      ];
    }
    if (stage >= STAGE_CARGO_DELIVERED) {
      return [
        "<str>I sailed to Port Sarim and collected Jim's Cargo before</str>",
        "<str>delivering it to The Pandemonium.</str>",
        "",
        "I should let <col=800000>Jim</col> know.",
      ];
    }
    if (stage >= STAGE_CARGO_TAKEN) {
      return [
        "<str>For my first adventure on my new Raft, Junior Jim</str>",
        "<str>suggested I pick up some Cargo from Port Sarim for him.</str>",
        "<str>I sailed there and collected the Cargo.</str>",
        "",
        "I should now deliver it to the <col=800000>Port Master</col> on",
        "<col=800000>The Pandemonium</col>.",
      ];
    }
    if (stage >= STAGE_LOG_GIVEN) {
      return [
        "<str>Junior Jim traded the Cup I found for a Raft, helped me</str>",
        "<str>build a Cargo Hold on it and gave me a Captain's Log.</str>",
        "",
        "I should board my <col=800000>Raft</col> at The Pandemonium and sail",
        "to <col=800000>Port Sarim</col> to collect Jim's Cargo.",
      ];
    }
    if (stage >= STAGE_HOLD_BUILT) {
      return [
        "<str>Junior Jim traded the Cup I found for a Raft and helped me</str>",
        "<str>build a Cargo Hold on it.</str>",
        "",
        "I should speak to <col=800000>Jim</col> again about heading out to sea.",
      ];
    }
    if (stage >= STAGE_CUP_GIVEN) {
      return [
        "<str>I traded the Cup I found in exchange for a Raft.</str>",
        "",
        "I should gather a <col=800000>hammer</col> and a <col=800000>saw</col>,",
        "board my Raft and build a <col=800000>Cargo Hold</col>.",
      ];
    }
    if (stage >= STAGE_JIM_TOLD) {
      return [
        "<str>Steve told me I'd need a Boat of my own and directed me to</str>",
        "<str>Junior Jim on the docks of The Pandemonium.</str>",
        "",
        "I should speak to <col=800000>Junior Jim</col>.",
      ];
    }
    if (stage >= STAGE_RIBS_DONE) {
      return [
        "<str>At Steve's suggestion I spoke with Ribs, the previous owner</str>",
        "<str>of the Map. He believed the Medallion taken by Will and Anne</str>",
        "<str>to be cursed.</str>",
        "",
        "I should discuss this with <col=800000>Steve</col>.",
      ];
    }
    if (stage >= STAGE_STEVE_ASKED) {
      return [
        "<str>I spoke to Steve Beanie, who told me Will and Anne stole a</str>",
        "<str>Map from The Pandemonium and it led them to the Medallion.</str>",
        "",
        "He suggested I discuss the Map with <col=800000>Ribs</col>.",
      ];
    }
    if (stage >= STAGE_SALVAGED) {
      return [
        "<str>I manned the Salvaging Hook and collected a Cup and a</str>",
        "<str>Medallion. Will and Anne betrayed me and pushed me overboard,</str>",
        "<str>but I washed up on a nearby island.</str>",
        "",
        "I should discuss my situation with <col=800000>Steve Beanie</col>.",
      ];
    }
    if (stage >= STAGE_ARRIVED) {
      return [
        "<str>I joined Will and Anne on their Boat and sailed them to a</str>",
        "<str>spot east of the Karamja Shipyard to gather some salvage.</str>",
        "",
        "I should man the <col=800000>Salvaging Hook</col> when ready.",
      ];
    }
    if (stage >= STAGE_SAILING) {
      return [
        "<str>I joined Will and Anne on their Boat and they asked me to</str>",
        "<str>sail them to a spot east of the Karamja Shipyard to gather</str>",
        "<str>some salvage.</str>",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "<str>I spoke to Will and Anne on the Port Sarim docks. They</str>",
        "<str>offered me a job and asked me to join them on their Boat to</str>",
        "<str>discuss the details.</str>",
        "",
        "I should let them know when I'm ready to board the Boat.",
      ];
    }
    return [
      "I can start this quest by talking to <col=800000>Will</col> and",
      "<col=800000>Anne</col> on the docks of <col=800000>Port Sarim</col>.",
    ];
  }

  function grantReward(player) {
    const skills = player.getSkillManager();
    skills.addExperiences(Skill.SAILING, SAILING_XP);
    // registerQuest adds the first coupon; top the stack up to 25.
    if (freeSlots(player) >= 1) {
      player.getInventory().adds(SAWMILL_COUPON_ITEM_ID, SAWMILL_COUPONS - 1);
    }
    if (freeSlots(player) >= 1) player.getInventory().adds(REPAIR_KIT_ITEM_ID, REPAIR_KITS);
    if (freeSlots(player) >= 1) player.getInventory().adds(SPYGLASS_ITEM_ID, 1);
    player.getPacketSender().sendVarbit(VARBIT_RECEIVED_REPAIR_KITS, 1);
  }

  quest = registerQuest(api, {
    key: "pandemonium",
    name: "Pandemonium",
    varpId: VARP_SAILING_INTRO,
    varbitId: VARBIT_SAILING_INTRO,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.SAILING.getIndex(), amount: SAILING_XP, label: "Sailing" }],
    rewardItemId: SAWMILL_COUPON_ITEM_ID,
    rewardItemLabel: "25 x Sawmill coupon (wood plank)",
    otherRewards: ["Access to the Sailing skill", "Access to The Pandemonium", "A raft"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onNpcInteraction("Will", { "Talk-to": willAnneTalkTo });
  api.onNpcInteraction("Anne", { "Talk-to": willAnneTalkTo });
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onObjectInteraction(handleObjectInteraction);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
  api.onCustomEvent("player:bootstrap-complete", handleBootstrap);
};
