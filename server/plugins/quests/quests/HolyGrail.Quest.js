/**
 * Holy Grail (members).
 *
 * Every speaking NPC is indexed on the "Holy Grail" transcript page, so the ask
 * King Arthur -> Merlin -> High Priest chain, Galahad's napkin, the Fisher King
 * and Sir Percival's whistle hand-over are all transcript-driven. This plugin
 * selects the variant by stage, answers the page's prose conditions, gives the
 * quest items on the dump's receive actions and completes on King Arthur's
 * "Congratulations! Quest complete!" action.
 *
 * Stages (varp 5): 2 started, 3 spoken to Merlin, 4 spoken to the High Priest,
 * 7 failed the Black Knight Titan, 8 finding Percival, 9 gave Percival the
 * whistle, 10 complete. (There is no "quest:holy-grail:start" hook in the dump;
 * the quest starts on King Arthur's "Yes." choice.)
 *
 * Gaps (no dump support): Galahad's napkin receive also hands over a magic
 * whistle (the reference gets them from Draynor Manor) and reaching stage 9
 * grants the Holy Grail so King Arthur can finish. The magic-feather direction
 * puzzle points at Sir Percival's sacks, and the Black Knight Titan's
 * excalibur-only regeneration is not enforced (the test shortcut for the
 * Merlin's Crystal prerequisite does not hand out Excalibur) - he still plays
 * his quest dialogue.
 */
module.exports = function registerHolyGrailQuest(api) {
  const { Skill, ItemIdentifiers, NpcIdentifiers, Equipment, Location, RegionManager } = api.core;
  const { registerQuest, getRegisteredQuests, startTranscript } = require("../QuestRuntime");

  const KING_ARTHUR_NPC_IDS = new Set([
    NpcIdentifiers.KING_ARTHUR,
    NpcIdentifiers.ARTHUR,
    NpcIdentifiers.KING_ARTHUR_2,
    NpcIdentifiers.KING_ARTHUR_3,
  ]);
  const MERLIN_NPC_IDS = new Set([NpcIdentifiers.MERLIN, NpcIdentifiers.MERLIN_2]);
  const HIGH_PRIEST_NPC_IDS = new Set([
    NpcIdentifiers.HIGH_PRIEST,
    NpcIdentifiers.CRONE,
    NpcIdentifiers.HIGH_PRIEST_3,
  ]);
  const SIR_PERCIVAL_NPC_IDS = new Set([NpcIdentifiers.SIR_PERCIVAL, NpcIdentifiers.KING_PERCIVAL]);
  const GALAHAD_NPC_ID = NpcIdentifiers.GALAHAD;
  const FISHERMAN_NPC_ID = NpcIdentifiers.FISHERMAN_2;
  const FISHER_KING_NPC_ID = NpcIdentifiers.THE_FISHER_KING;
  const GRAIL_MAIDEN_NPC_ID = NpcIdentifiers.GRAIL_MAIDEN;
  const BLACK_KNIGHT_TITAN_NPC_ID = NpcIdentifiers.BLACK_KNIGHT_TITAN;

  const KNIGHT_VARIANTS = new Map([
    [NpcIdentifiers.SIR_LANCELOT, "asking-the-other-knights-talking-to-sir-lancelot"],
    [NpcIdentifiers.SIR_GAWAIN, "asking-the-other-knights-talking-to-sir-gawain"],
    [NpcIdentifiers.SIR_KAY, "asking-the-other-knights-talking-to-sir-kay"],
    [NpcIdentifiers.SIR_BEDIVERE, "asking-the-other-knights-talking-to-sir-bedivere"],
    [NpcIdentifiers.SIR_PELLEAS, "asking-the-other-knights-talking-to-sir-pellas"],
    [NpcIdentifiers.SIR_LUCAN, "asking-the-other-knights-talking-to-sir-lucan"],
    [NpcIdentifiers.SIR_PELLEAS_3, "asking-the-other-knights-talking-to-sir-pellas"],
    [NpcIdentifiers.SIR_GAWAIN_3, "asking-the-other-knights-talking-to-sir-gawain"],
    [NpcIdentifiers.SIR_KAY_3, "asking-the-other-knights-talking-to-sir-kay"],
  ]);
  const PEASANT_NPC_IDS = new Set([NpcIdentifiers.PEASANT, NpcIdentifiers.PEASANT_2]);

  /** NPCs whose transcripts this plugin owns; dialogue conditions from anyone else are not ours. */
  const DIALOGUE_NPC_IDS = new Set([
    ...KING_ARTHUR_NPC_IDS,
    ...MERLIN_NPC_IDS,
    ...HIGH_PRIEST_NPC_IDS,
    ...SIR_PERCIVAL_NPC_IDS,
    ...KNIGHT_VARIANTS.keys(),
    ...PEASANT_NPC_IDS,
    GALAHAD_NPC_ID,
    FISHERMAN_NPC_ID,
    FISHER_KING_NPC_ID,
    GRAIL_MAIDEN_NPC_ID,
    BLACK_KNIGHT_TITAN_NPC_ID,
  ]);

  const VARP_HOLY_GRAIL = 5;
  const STAGE_STARTED = 2;
  const STAGE_SPOKEN_MERLIN = 3;
  const STAGE_SPOKEN_CRONE = 4;
  const STAGE_FAILED_TITAN = 7;
  const STAGE_FINDING_PERCIVAL = 8;
  const STAGE_GIVEN_WHISTLE = 9;
  const STAGE_COMPLETE = 10;

  const NAPKIN_ITEM_ID = ItemIdentifiers.HOLY_TABLE_NAPKIN;
  const MAGIC_WHISTLE_ITEM_ID = ItemIdentifiers.MAGIC_WHISTLE;
  const GRAIL_BELL_ITEM_ID = ItemIdentifiers.GRAIL_BELL;
  const MAGIC_FEATHER_ITEM_ID = ItemIdentifiers.MAGIC_GOLD_FEATHER;
  const HOLY_GRAIL_ITEM_ID = ItemIdentifiers.HOLY_GRAIL;
  const EXCALIBUR_ITEM_ID = ItemIdentifiers.EXCALIBUR;

  // The whistle works on the north-western Brimhaven peninsula (the OSRS four
  // pillars north of the mysterious statue, and the gold-rock ground the guide
  // sends players to); the return trip lands on the pillar platform.
  const WHISTLE_TILE = { x: 2743, y: 3175, z: 0 };
  const WHISTLE_AREA = { minX: 2728, maxX: 2758, minY: 3145, maxY: 3245 };
  // Blowing the whistle inside the realm lands on the north bank, by the Titan's bridge.
  const FISHER_REALM_TILE = { x: 2793, y: 4724, z: 0 };
  const FISHER_REALM_BOUNDS = { minX: 2600, maxX: 2850, minY: 4650, maxY: 4790 };
  // The Grail bell lies by the dismantled bricks outside the castle; ringing it
  // there teleports the player inside.
  const BRICKS_TILE = { x: 2762, y: 4693, z: 0 };
  const CASTLE_INSIDE_TILE = { x: 2762, y: 4691, z: 0 };
  const BELL_RADIUS = 4;
  // Sir Percival is trapped in the sacks in the east house of Goblin Village.
  // He steps out on the open west side of the sacks (the east tile is a pocket).
  const SACKS_TILE = { x: 2962, y: 3506, z: 0 };
  const PERCIVAL_TILE = { x: 2960, y: 3506, z: 0 };
  const SACKS_REACH = 3;
  const FEATHER_RADIUS = 5;
  const PERCIVAL_REVEALED_ATTRIBUTE = "holy-grail:percival-revealed";

  const NAPKIN_ACTION_ID = "IWEKeT";
  const FEATHER_ACTION_ID = "QFSQAR";
  const WHISTLE_ACTION_IDS = new Set(["xUC5cW", "RwrmfE"]);
  const COMPLETE_ACTION_ID = "MtgzHp";
  const TELEPORT_ACTION_ID = "jbdCvp";

  let quest;

  const hasItem = (player, itemId) => player.getInventory().getAmount(itemId) > 0;
  const ownsGrail = (player) => hasItem(player, HOLY_GRAIL_ITEM_ID);

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I returned the Holy Grail to Camelot.</str>",
        "<str>Percival took his father's place in the Fisher Realm.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_GIVEN_WHISTLE) {
      return ["Percival has returned. I can revisit the restored realm", "and claim the Holy Grail."];
    }
    if (stage >= STAGE_FINDING_PERCIVAL) {
      return ["King Arthur's feather points to sacks in Goblin Village,", "where Percival is trapped."];
    }
    if (stage >= STAGE_SPOKEN_CRONE) {
      return ["Galahad can provide a Fisher Realm keepsake.", "Then I need to find Sir Percival."];
    }
    if (stage >= STAGE_SPOKEN_MERLIN) {
      return ["<str>King Arthur sent me to recover the Holy Grail.</str>", "I should speak to the High Priest on <col=800000>Entrana</col>."];
    }
    if (stage >= STAGE_STARTED) {
      return ["<str>King Arthur sent me to recover the Holy Grail.</str>", "I should speak to <col=800000>Merlin</col> in his Camelot workshop."];
    }
    return ["After Merlin's Crystal, I can ask <col=800000>King Arthur</col> for another quest."];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.PRAYER, 11000);
    player.getSkillManager().addExperiences(Skill.DEFENCE, 15300);
  }

  function arthurVariant(stage) {
    // Stage 9 means the whistle hand-over granted the Grail; do not gate on the
    // item itself, or a full inventory at that moment soft-locks the quest.
    if (stage >= STAGE_GIVEN_WHISTLE) return "talking-to-king-arthur-2";
    if (stage >= STAGE_FINDING_PERCIVAL) return "talking-to-king-arthur";
    if (stage >= STAGE_SPOKEN_MERLIN && stage < STAGE_SPOKEN_CRONE) {
      return "talking-to-merlin-updating-king-arthur";
    }
    if (stage >= STAGE_STARTED) return "starting-off-subsequent-dialogue-with-king-arthur";
    return "starting-off";
  }

  function merlinsCrystalIncomplete(player) {
    const merlinsCrystal = getRegisteredQuests().find((entry) => entry.key === "merlins_crystal");
    return Boolean(merlinsCrystal && !merlinsCrystal.isComplete(player));
  }

  function selectVariant({ npcId, player }) {
    const stage = quest.getStage(player);
    if (KING_ARTHUR_NPC_IDS.has(npcId)) {
      // Arthur's Merlin's Crystal start comes first; Holy Grail only opens once it is done.
      if (merlinsCrystalIncomplete(player)) return null;
      return arthurVariant(stage);
    }
    if (MERLIN_NPC_IDS.has(npcId)) {
      // Merlin's Crystal owns Merlin until it is finished; Holy Grail's chain only starts after Arthur.
      if (merlinsCrystalIncomplete(player) || stage < STAGE_STARTED) return null;
      if (stage === STAGE_STARTED) quest.setStage(player, STAGE_SPOKEN_MERLIN);
      return "talking-to-merlin";
    }
    if (HIGH_PRIEST_NPC_IDS.has(npcId)) {
      if (stage === STAGE_SPOKEN_MERLIN) quest.setStage(player, STAGE_SPOKEN_CRONE);
      return "talking-to-the-high-priest-of-entrana";
    }
    if (npcId === GALAHAD_NPC_ID) return "talking-to-sir-galahad";
    if (npcId === FISHERMAN_NPC_ID) return "talking-to-the-fisherman";
    if (npcId === FISHER_KING_NPC_ID) {
      if (stage === STAGE_SPOKEN_CRONE || stage === STAGE_FAILED_TITAN) {
        quest.setStage(player, STAGE_FINDING_PERCIVAL);
      }
      return "talking-to-the-fisher-king";
    }
    if (npcId === GRAIL_MAIDEN_NPC_ID) return "ringing-the-grail-bell-talking-to-a-grail-maiden";
    if (npcId === BLACK_KNIGHT_TITAN_NPC_ID) {
      if (stage < STAGE_STARTED) return null;
      return "encountering-the-black-knight-titan";
    }
    if (SIR_PERCIVAL_NPC_IDS.has(npcId)) {
      if (stage >= STAGE_COMPLETE) return "talking-to-sir-percival-talking-to-sir-percival-at-the-fisher-realm";
      if (stage >= STAGE_GIVEN_WHISTLE) return "talking-to-sir-percival-subsequent-dialogue-with-sir-percival";
      if (stage >= STAGE_FINDING_PERCIVAL) return "talking-to-sir-percival";
      return null;
    }
    if (KNIGHT_VARIANTS.has(npcId)) {
      // The Grail round-table talk is only Holy Grail's after Merlin's Crystal and its own start.
      if (merlinsCrystalIncomplete(player) || stage < STAGE_STARTED) return null;
      return KNIGHT_VARIANTS.get(npcId);
    }
    if (PEASANT_NPC_IDS.has(npcId)) return "talking-to-the-fisherman-peasant";
    return null;
  }

  function answerCondition({ player, npcId, text }) {
    if (!DIALOGUE_NPC_IDS.has(npcId)) return null;
    const value = String(text).toLowerCase();
    const skills = player.getSkillManager();
    const combat = typeof skills.getCombatLevel === "function" ? skills.getCombatLevel() : 999;
    const equipment = player.getEquipment();
    const wielded = equipment.get(Equipment.WEAPON_SLOT)?.getId?.();
    if (value.includes("combat level is less than 50")) return combat < 50;
    if (value.includes("combat level is more than 50")) return combat > 50;
    if (value.includes("talked to the high priest of entrana first")) return quest.getStage(player) >= STAGE_SPOKEN_CRONE;
    if (value.includes("without the excalibur")) return wielded !== EXCALIBUR_ITEM_ID;
    if (value.includes("uses the excalibur")) return wielded === EXCALIBUR_ITEM_ID;
    if (value.includes("does not have the whistle")) return !hasItem(player, MAGIC_WHISTLE_ITEM_ID);
    if (value.includes("has the magic whistle")) return hasItem(player, MAGIC_WHISTLE_ITEM_ID);
    if (value.includes("loses the feather")) return !hasItem(player, MAGIC_FEATHER_ITEM_ID);
    if (value.includes("does not have enough inventory space")) return player.getInventory().isFull();
    if (value.includes("has one free inventory space")) return !player.getInventory().isFull();
    if (value.includes("talks to him again")) return false;
    // Once the sacks are opened Percival is out, so the read-the-sack prose no longer applies.
    if (value.includes("prods at the sacks") || value.includes("attempts to open the sack")) {
      return percivalRevealed(player) ? false : null;
    }
    return null;
  }

  /**
   * King Arthur's "Yes." starts the quest. The same NPC and choice text accept
   * Merlin's Crystal's start while that quest is incomplete, and that choice is
   * not ours, so defer until the prerequisite is done.
   */
  function handleChoice({ player, npcId, option }) {
    if (!KING_ARTHUR_NPC_IDS.has(npcId)) return;
    if (quest.getStage(player) !== 0) return;
    if (merlinsCrystalIncomplete(player)) return;
    if (String(option ?? "").replace(/[^a-z]/gi, "").toLowerCase() !== "yes") return;
    quest.setStage(player, STAGE_STARTED);
  }

  function giveOnce(player, itemId, label) {
    if (hasItem(player, itemId) || player.getInventory().isFull()) return;
    player.getInventory().adds(itemId, 1);
    if (label) player.sendMessage(label);
  }

  /** Reads a Location or a plain { x, y, z } into tile numbers. */
  function coords(value) {
    return {
      x: typeof value?.getX === "function" ? value.getX() : value?.x,
      y: typeof value?.getY === "function" ? value.getY() : value?.y,
      z: typeof value?.getZ === "function" ? value.getZ() : value?.z ?? 0,
    };
  }

  function within(place, tile, radius) {
    const from = coords(place);
    return from.z === tile.z
      && Math.abs(from.x - tile.x) <= radius
      && Math.abs(from.y - tile.y) <= radius;
  }

  function inFisherRealm(location) {
    // The Grail castle's upper floor is plane 1, so ignore the plane: the map
    // region alone identifies the realm.
    const { x, y } = coords(location);
    return x >= FISHER_REALM_BOUNDS.minX && x <= FISHER_REALM_BOUNDS.maxX
      && y >= FISHER_REALM_BOUNDS.minY && y <= FISHER_REALM_BOUNDS.maxY;
  }

  function inWhistleArea(location) {
    const { x, y, z } = coords(location);
    return z === 0
      && x >= WHISTLE_AREA.minX && x <= WHISTLE_AREA.maxX
      && y >= WHISTLE_AREA.minY && y <= WHISTLE_AREA.maxY;
  }

  /** The whistle travels between north-west Brimhaven and the Fisher Realm. */
  function blowWhistle({ player }) {
    const location = player.getLocation();
    if (inFisherRealm(location)) {
      player.moveTo(new Location(WHISTLE_TILE.x, WHISTLE_TILE.y, WHISTLE_TILE.z));
      return;
    }
    if (!inWhistleArea(location)) {
      player.sendMessage("The whistle makes no noise. It will not work in this location.");
      return;
    }
    player.moveTo(new Location(FISHER_REALM_TILE.x, FISHER_REALM_TILE.y, FISHER_REALM_TILE.z));
  }

  /** Ringing the bell at the dismantled bricks opens the Grail castle. */
  function ringGrailBell({ player }) {
    const location = player.getLocation();
    player.sendMessage("Ting-a-ling-a-ling!");
    if (!within(location, BRICKS_TILE, BELL_RADIUS)) {
      player.sendMessage("Nothing happens.");
      return;
    }
    startTranscript(api, player, GRAIL_MAIDEN_NPC_ID, "Holy Grail", "ringing-the-grail-bell-talking-to-a-grail-maiden");
    player.sendMessage("Somehow you are now inside the castle.");
    player.moveTo(new Location(CASTLE_INSIDE_TILE.x, CASTLE_INSIDE_TILE.y, CASTLE_INSIDE_TILE.z));
  }

  /** Blowing the feather points the way to Percival's sacks in Goblin Village. */
  function blowFeather({ player }) {
    const location = coords(player.getLocation());
    const dx = SACKS_TILE.x - location.x;
    const dy = SACKS_TILE.y - location.y;
    if (Math.abs(dx) <= FEATHER_RADIUS && Math.abs(dy) <= FEATHER_RADIUS) {
      player.sendMessage("The feather points at the sacks.");
      return;
    }
    const northSouth = dy > 0 ? "north" : "south";
    const eastWest = dx > 0 ? "east" : "west";
    if (Math.abs(dx) === Math.abs(dy)) player.sendMessage(`The feather points to the ${northSouth}${eastWest}.`);
    else if (Math.abs(dx) > Math.abs(dy)) player.sendMessage(`The feather points to the ${eastWest}.`);
    else player.sendMessage(`The feather points to the ${northSouth}.`);
  }

  /** Owner-only Percival spawns when his sack is opened. */
  const percivalByPlayer = new Map();

  function percivalRevealed(player) {
    return player.getAttribute(PERCIVAL_REVEALED_ATTRIBUTE) === true;
  }

  function revealPercival(player) {
    player.setAttribute(PERCIVAL_REVEALED_ATTRIBUTE, true);
    if (percivalByPlayer.has(player)) return;
    const npc = api.spawnNpc({
      id: NpcIdentifiers.SIR_PERCIVAL,
      x: PERCIVAL_TILE.x,
      y: PERCIVAL_TILE.y,
      z: PERCIVAL_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (npc) percivalByPlayer.set(player, npc);
  }

  function clearPercival(player) {
    const npc = percivalByPlayer.get(player);
    if (npc) api.removeNpc(npc);
    percivalByPlayer.delete(player);
  }

  function handleLogout({ player }) {
    if (player) clearPercival(player);
  }

  function sacksHere(event) {
    return quest.getStage(event.player) >= STAGE_FINDING_PERCIVAL
      && within(event.location, SACKS_TILE, SACKS_REACH);
  }

  function prodSacks(event) {
    if (!sacksHere(event)) return false;
    event.player.sendMessage(percivalRevealed(event.player)
      ? "The sack is empty."
      : "You hear a muffled groan. The sack wriggles slightly.");
    event.handled = true;
    return true;
  }

  function openSacks(event) {
    if (!sacksHere(event)) return false;
    if (!percivalRevealed(event.player)) {
      event.player.sendMessage("You hear muffled noises from the sack. You open the sack.");
      revealPercival(event.player);
    } else {
      event.player.sendMessage("The sack is empty.");
    }
    event.handled = true;
    return true;
  }

  function handleAction(event) {
    const { player, stepId } = event;
    const stage = quest.getStage(player);
    if (stepId === COMPLETE_ACTION_ID) {
      if (!quest.isComplete(player) && stage >= STAGE_GIVEN_WHISTLE) quest.complete(player);
      event.handled = true;
      event.end = true;
      return;
    }
    if (stepId === NAPKIN_ACTION_ID) {
      giveOnce(player, NAPKIN_ITEM_ID);
      // The reference gets the whistles from Draynor Manor with the napkin.
      giveOnce(player, MAGIC_WHISTLE_ITEM_ID);
      event.handled = true;
      return;
    }
    if (stepId === FEATHER_ACTION_ID) {
      giveOnce(player, MAGIC_FEATHER_ITEM_ID);
      event.handled = true;
      return;
    }
    if (WHISTLE_ACTION_IDS.has(stepId)) {
      if (hasItem(player, MAGIC_WHISTLE_ITEM_ID)) {
        player.getInventory().deleteNumber(MAGIC_WHISTLE_ITEM_ID, 1);
      }
      if (!ownsGrail(player) && !player.getInventory().isFull()) {
        player.getInventory().adds(HOLY_GRAIL_ITEM_ID, 1);
      }
      if (stage < STAGE_GIVEN_WHISTLE) quest.setStage(player, STAGE_GIVEN_WHISTLE);
      event.handled = true;
      return;
    }
    if (stepId === TELEPORT_ACTION_ID) {
      player.moveTo(new Location(WHISTLE_TILE.x, WHISTLE_TILE.y, WHISTLE_TILE.z));
      event.handled = true;
    }
  }

  quest = registerQuest(api, {
    key: "holy_grail",
    name: "Holy Grail",
    varpId: VARP_HOLY_GRAIL,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [
      { skillId: Skill.PRAYER.getIndex(), amount: 11000, label: "Prayer" },
      { skillId: Skill.DEFENCE.getIndex(), amount: 15300, label: "Defence" },
    ],
    rewardItemId: HOLY_GRAIL_ITEM_ID,
    rewardItemLabel: "The Holy Grail",
    otherRewards: ["Access to the Fisher Realm"],
    buildJournal,
    onReward: grantReward,
  });

  // The cache flags the Fisher Realm bridge crossing (y=4722, x 2788-2793) as a
  // blocked tile and the realm has no other route past the Black Knight Titan,
  // so clear the clipping after each region load (cache clipping is rebuilt then).
  function openTitanBridge() {
    for (let x = 2788; x <= 2793; x++) {
      RegionManager.removeClipping(x, 4722, 0, RegionManager.BLOCKED_TILE, null);
    }
  }

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onItemAction("Magic whistle", { Blow: blowWhistle });
  api.onItemAction("Grail bell", { Ring: ringGrailBell });
  api.onItemAction("Magic gold feather", { "Blow-on": blowFeather });
  api.onObjectInteraction("Sacks", { Prod: prodSacks, Open: openSacks });
  api.onPlayerLogout(handleLogout);
  api.onRegionLoaded(openTitanBridge);
};
