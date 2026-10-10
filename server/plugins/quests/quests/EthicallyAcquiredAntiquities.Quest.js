/**
 * Ethically Acquired Antiquities (members).
 *
 * The words come from the "Ethically Acquired Antiquities" transcript page (OSRS
 * Wiki); this plugin supplies the NPC variant selectors, the prose-condition
 * answers, the object interactions (display, tools, storeroom door and crates),
 * the pickpocketing of Curator Haig Halen, the item hand-ins, the journal and the
 * completion reward.
 *
 * Stages live in varbit 11193 "eaa" (varp 4400, bits 0-6). Evidence:
 * `lookup-gameval.ts varbit eaa` -> "11193 eaa varp=4400 bits=0-6", `dump:cs2 4024`
 * maps quest index 3713 (RuneLite Quest.ETHICALLY_ACQUIRED_ANTIQUITIES) to it, and
 * Quest Helper's loadSteps() uses 0,2,...,36. The quest DB (table 0) row 197 for
 * EAA carries 38 as the quest list's completion value, so completion is 38:
 *
 *   0 not started (inspecting the empty display starts the quest)
 *   2 agreed to help; talk to Curator Herminius
 *   4 investigate the museum (tools, then the display again)
 *   6 clue found; question the visitors
 *   8 clue points at the landing site; talk to Regulus Cento
 *  10 Regulus points at the Cothon; ask a trader crewmember
 *  12 favour asked; have the tattered sails repaired by Artima
 *  14 sails returned; the man sailed to Port Sarim
 *  16 ask the Port Sarim trader crewmember
 *  18 ask Betty about the rune order
 *  20 read Betty's notes
 *  22 notes point to Varrock; ask Curator Haig Halen
 *  24 pickpocket Haig for the storeroom key
 *  26 search the crate in the museum storeroom
 *  28 diadem found; confront Haig
 *  30 shame Haig into admitting the theft
 *  32 interrogation passed (the explanation cutscene)
 *  34 cutscene ends
 *  36 return to Curator Herminius (completes at 38)
 *
 * Side flags live in one persisted bits attribute and are mirrored to the cache's
 * own varbits: 11194 investigated display, 11195 investigated tools, 11196-11198
 * questioned citizen/tourist/academic, 11199 shame meter (0-100), 11200 crewmember
 * favour asked, 11201 crafting favour asked, 11202 Betty told about the note,
 * 11204 given sails, 11205 fixed sails, 11206 given notes and 11207 diadem (which
 * drives the display multi-loc).
 *
 * The Grand Museum display and tools are multi-locs 55377/55378 placed at
 * (1721,3165) and (1722,3167) on plane 0: 55377 resolves to 54693 "Empty display"
 * / 54694 "Xerna's Diadem" by varbit 11207, and 55378 to 54700 "Tools" with
 * Investigate only while the stage varbit is exactly 4. The Varrock Museum
 * storeroom objects are map placed: door 54695 at (3266,3456), the diadem crate
 * 54697 and the flavour crates 54698 at (3266/3267,3458).
 *
 * Rewards per the OSRS Wiki: 1 Quest point, 6,000 Thieving XP and 5,000 coins.
 *
 * Source: https://oldschool.runescape.wiki/w/Ethically_Acquired_Antiquities and
 * /Quick_guide, /Transcript, plus the Xerna's Diadem transcript page. Stage values
 * cross-checked against Quest Helper
 * (helpers/quests/ethicallyacquiredantiquities/EthicallyAcquiredAntiquities.java).
 *
 * Gaps / approximations:
 *   - the cutscene stage directions are played as their transcript lines only; no
 *     camera or scene animation runs (stages 32/34 are set from the cutscene steps);
 *   - the exact shame-meter values are not public, so every wiki "increase" option
 *     adds 25 and every "decrease" option subtracts 25 (clamped 0-100); reaching
 *     100 passes the interrogation, and a failed attempt ends the chat so talking
 *     to Haig again continues the meter where it stopped;
 *   - the informant is chosen per player at random between a citizen and a tourist
 *     (OSRS picks one specific NPC) and all three visitor kinds are questioned;
 *   - the storeroom door is swung open with the Doors plugin's single-door maths and
 *     auto-closes after 500 ticks; without the key it answers "The door is locked."
 *     (that line is not in the transcript dump);
 *   - the two stacked crates replay the wiki random branch the parser reduced to its
 *     first alternative (the Academic lines);
 *   - a completed player inspecting the display gets the Xerna's Diadem wiki page
 *     text, as that page is not part of the quest transcript dump;
 *   - Haig, Betty and the crewmembers have no post-quest variants, so completed
 *     players replay the last applicable variant with state changes guarded;
 *   - Curator Herminius, the visitors, Regulus Cento, Artima and the two EAA trader
 *     crewmembers are per-player owner-only spawns (none are in npc-spawns.json).
 */
module.exports = function registerEthicallyAcquiredAntiquitiesQuest(api) {
  const {
    GameObject,
    ItemIdentifiers,
    Location,
    NpcIdentifiers,
    ObjectIdentifiers,
    ObjectManager,
    Skill,
    Sound,
    Sounds,
    Task,
  } = api.core;
  const { registerQuest, refreshQuestList, startTranscript } = require("../QuestRuntime");

  const PAGE = "Ethically Acquired Antiquities";
  const START_HOOK = "quest:ethically-acquired-antiquities:start";

  // Varp/varbits: lookup-gameval.ts varbit eaa -> "11193 eaa varp=4400 bits=0-6".
  const VARP_EAA = 4400;
  const STAGE_VARBIT = 11193;
  const INVESTIGATED_DISPLAY_VARBIT = 11194;
  const INVESTIGATED_TOOLS_VARBIT = 11195;
  const QUESTIONED_CITIZEN_VARBIT = 11196;
  const QUESTIONED_TOURIST_VARBIT = 11197;
  const QUESTIONED_ACADEMIC_VARBIT = 11198;
  const SHAME_VARBIT = 11199;
  const CREWMEMBER_FAVOUR_VARBIT = 11200;
  const CRAFTING_FAVOUR_VARBIT = 11201;
  const BETTY_TOLD_VARBIT = 11202;
  const GIVEN_SAILS_VARBIT = 11204;
  const FIXED_SAILS_VARBIT = 11205;
  const GIVEN_NOTES_VARBIT = 11206;
  const DIADEM_VARBIT = 11207;

  const STAGE_STARTED = 2;
  const STAGE_INVESTIGATE = 4;
  const STAGE_CLUE = 6;
  const STAGE_REGULUS = 8;
  const STAGE_CREW = 10;
  const STAGE_REPAIR = 12;
  const STAGE_RETURN_SAILS = 14;
  const STAGE_PORT_SARIM = 16;
  const STAGE_BETTY = 18;
  const STAGE_READ_NOTES = 20;
  const STAGE_HAIG = 22;
  const STAGE_STOREROOM = 24;
  const STAGE_SEARCH_CRATE = 26;
  const STAGE_CONFRONT = 28;
  const STAGE_SHAME = 30;
  const STAGE_CUTSCENE = 32;
  const STAGE_CUTSCENE_END = 34;
  const STAGE_RETURN = 36;
  const STAGE_COMPLETE = 38;

  const COINS_ITEM_ID = ItemIdentifiers.COINS; // 995
  const TATTERED_SAILS_ITEM_ID = ItemIdentifiers.TATTERED_SAILS; // 29903
  const SAILS_ITEM_ID = ItemIdentifiers.SAILS; // 29904
  const BETTYS_NOTES_ITEM_ID = ItemIdentifiers.BETTYS_NOTES; // 29905
  const STOREROOM_KEY_ITEM_ID = ItemIdentifiers.STOREROOM_KEY_3; // 29906

  const EMPTY_DISPLAY_OBJECT_ID = ObjectIdentifiers.EMPTY_DISPLAY_5; // 54693
  const DIADEM_DISPLAY_OBJECT_ID = ObjectIdentifiers.XERNAS_DIADEM; // 54694
  const TOOLS_OBJECT_ID = ObjectIdentifiers.TOOLS_13; // 54700, Investigate
  const STOREROOM_DOOR_OBJECT_ID = ObjectIdentifiers.DOOR_746; // 54695, Open
  const STOREROOM_DOOR_OPEN_OBJECT_ID = ObjectIdentifiers.DOOR_747; // 54696
  const DIADEM_CRATE_OBJECT_ID = ObjectIdentifiers.CRATE_340; // 54697, Search
  const FLAVOUR_CRATES_OBJECT_ID = ObjectIdentifiers.CRATES_107; // 54698, Search
  const STOREROOM_DOOR_TILE = { x: 3266, y: 3456 };

  const HERMINIUS_NPC_ID = NpcIdentifiers.CURATOR_HERMINIUS; // 13297
  const HAIG_NPC_ID = NpcIdentifiers.CURATOR_HAIG_HALEN; // 5214
  const REGULUS_NPC_ID = NpcIdentifiers.REGULUS_CENTO_2; // 12884
  const ARTIMA_NPC_ID = NpcIdentifiers.ARTIMA; // 13342
  const CITIZEN_NPC_ID = NpcIdentifiers.CITIZEN_48; // 13164
  const TOURIST_NPC_ID = NpcIdentifiers.TOURIST; // 13206
  const ACADEMIC_NPC_ID = NpcIdentifiers.ACADEMIC; // 13298
  const FORTIS_CREW_NPC_ID = NpcIdentifiers.TRADER_CREWMEMBER_49; // 9360
  const SARIM_CREW_NPC_ID = NpcIdentifiers.TRADER_CREWMEMBER_101; // 12799

  const VISITOR_IDS = new Set([CITIZEN_NPC_ID, TOURIST_NPC_ID, ACADEMIC_NPC_ID]);
  const FORTIS_CREW_IDS = new Set([FORTIS_CREW_NPC_ID]);
  const SARIM_CREW_IDS = new Set([SARIM_CREW_NPC_ID]);

  const FLAGS_ATTRIBUTE = "quest.ethically_acquired_antiquities.flags";
  const INFORMANT_ATTRIBUTE = "quest.ethically_acquired_antiquities.informant";
  const SHAME_ATTRIBUTE = "quest.ethically_acquired_antiquities.shame";
  const PENDING_SAILS_ATTRIBUTE = "quest.ethically_acquired_antiquities.pending-sails";
  const DECLINED_FAVOUR_ATTRIBUTE = "quest.ethically_acquired_antiquities.declined-favour";

  const BIT_INVESTIGATED_DISPLAY = 1 << 0;
  const BIT_INVESTIGATED_TOOLS = 1 << 1;
  const BIT_QUESTIONED_CITIZEN = 1 << 2;
  const BIT_QUESTIONED_TOURIST = 1 << 3;
  const BIT_QUESTIONED_ACADEMIC = 1 << 4;
  const BIT_CREWMEMBER_FAVOUR_ASKED = 1 << 5;
  const BIT_CRAFTING_FAVOUR_ASKED = 1 << 6;
  const BIT_BETTY_TOLD = 1 << 7;
  const BIT_GIVEN_SAILS = 1 << 8;
  const BIT_FIXED_SAILS = 1 << 9;
  const BIT_GIVEN_NOTES = 1 << 10;
  const BIT_DIADEM = 1 << 11;
  const FLAG_VARBITS = [
    [BIT_INVESTIGATED_DISPLAY, INVESTIGATED_DISPLAY_VARBIT],
    [BIT_INVESTIGATED_TOOLS, INVESTIGATED_TOOLS_VARBIT],
    [BIT_QUESTIONED_CITIZEN, QUESTIONED_CITIZEN_VARBIT],
    [BIT_QUESTIONED_TOURIST, QUESTIONED_TOURIST_VARBIT],
    [BIT_QUESTIONED_ACADEMIC, QUESTIONED_ACADEMIC_VARBIT],
    [BIT_CREWMEMBER_FAVOUR_ASKED, CREWMEMBER_FAVOUR_VARBIT],
    [BIT_CRAFTING_FAVOUR_ASKED, CRAFTING_FAVOUR_VARBIT],
    [BIT_BETTY_TOLD, BETTY_TOLD_VARBIT],
    [BIT_GIVEN_SAILS, GIVEN_SAILS_VARBIT],
    [BIT_FIXED_SAILS, FIXED_SAILS_VARBIT],
    [BIT_GIVEN_NOTES, GIVEN_NOTES_VARBIT],
    [BIT_DIADEM, DIADEM_VARBIT],
  ];

  const SHAME_MAX = 100;
  const SHAME_STEP = 25;
  const SHAME_INCREASE_OPTIONS = new Set([
    "A real historian would never steal!",
    "Are you even a real historian, or just a petty criminal?",
    "Aren't you embarrassed to have stolen items in your collection?",
    "Did you know Varlamore sends thieves to the Colosseum?",
    "Do you really think you did the right thing?",
    "Do your colleagues know what you've done? What do they think?",
    "Hand that artefact back this instant!",
    "How will Varlamorians learn their history now?",
    "How would you feel if someone came in here and stole all your stuff?",
    "I guess you were just in it for the glory, were you?",
    "I thought archaeology was cool. I didn't realise it was just thieving!",
    "If you're looking for stolen goods, I can get my hands on plenty.",
    "Is everything here stolen from other museums?",
    "Just give it back already!",
    "Look me in the eye and tell me you did the right thing.",
    "Nobody wants to see stolen goods on display!",
    "So can anyone just go around stealing and call it archaeology?",
    "Stealing is against the law!",
    "Stealing is stealing, no matter how you try to justify it.",
    "Think of the Varlamorian children who won't get to see this artefact.",
    "This is stealing! Thieving! Taking what's not yours!",
    "Varlamore might close their lands again after this.",
    "Varlamore might never let you and your colleagues visit again!",
    "You can't justify theft by saying it's for preservation.",
    "You could have damaged the artefact!",
    "You ought to be ashamed.",
    "You should give Varlamore a chance before stealing their stuff.",
    "You're a disgrace to your entire profession!",
    "You're a loose cannon.",
    "You're hoarding artefacts, but you should be sharing them!",
    "You're not above the law! You stole this stuff!",
    "You're setting a terrible example.",
    "You're supposed to protect history, not steal it!",
    "You've betrayed the trust of Varlamore.",
    "You've committed a crime.",
  ]);
  const SHAME_DECREASE_OPTIONS = new Set([
    "Do you even have room to display this artefact?",
    "Don't you have enough artefacts of your own?",
    "Have you no respect for your colleagues in Varlamore?",
    "How do you explain the other stolen artefacts you have in storage?",
    "How do you sleep at night?",
    "I'm sick of your excuses!",
    "Is the artefact really safer here?",
    "This artefact doesn't belong to you! It belongs to Varlamore!",
    "This could destroy your reputation! Everyone will think you're a thief!",
    "What if I came into your house and stole your stuff?",
    "What if it's cursed?! It could be dangerous!",
    "What if Varlamore finds out what you've done?",
    "What makes you think you know better?",
    "Why don't you just cooperate with Varlamore?",
    "Why should you decide who gets to keep their artefacts?",
    "You don't even have room to display it! It's just sitting in storage!",
    "You should be ashamed of yourself.",
    "You should return all these artefacts. It's the only right thing to do.",
    "You're not preserving anything. You're just a thief.",
    "You're nothing but a common thief!",
    "You've ruined Varlamore's museum.",
    "You've stolen from several other museums, too!",
  ]);

  const STOREROOM_DOOR_AUTO_CLOSE_TICKS = 500;
  const STOREROOM_DOOR_TASK_KEY = "eaa:storeroom-door";
  const DOOR_SWING_OFFSETS = [
    [-1, 0],
    [0, 1],
    [1, 0],
    [0, -1],
  ];

  // Variant keys on the "Ethically Acquired Antiquities" page.
  const V_DISPLAY_START = "xerna-s-stolen-diadem-inpecting-the-empty-display";
  const V_HERMINIUS_INTRO = "xerna-s-stolen-diadem-talking-to-curator-herminius";
  const V_HERMINIUS_CLUES = "clues-in-civitas-illa-fortis-talking-to-curator-herminius";
  const V_HERMINIUS_FINAL = "in-varrock-museum-talking-to-curator-herminius";
  const V_TOOLS = "clues-in-civitas-illa-fortis-investigating-the-tools-on-ground";
  const V_DISPLAY_AGAIN = "clues-in-civitas-illa-fortis-inpecting-the-empty-display-once-more";
  const V_VISITOR_NOTHING = "clues-in-civitas-illa-fortis-talking-to-an-academic-citizen-or-tourist-that-didn-t-see-anything";
  const V_VISITOR_CLUE = "clues-in-civitas-illa-fortis-talking-to-a-tourist";
  const V_REGULUS_FIRST = "clues-in-civitas-illa-fortis-talking-to-regulus-cento";
  const V_REGULUS_AGAIN = "clues-in-civitas-illa-fortis-talking-to-regulus-cento-again";
  const V_FORTIS_FIRST = "clues-in-civitas-illa-fortis-talking-to-a-trader-crewmember";
  const V_FORTIS_DECLINED = "clues-in-civitas-illa-fortis-talking-to-a-trader-crewmember-after-declining-doing-the-favour";
  const V_FORTIS_AGREED = "clues-in-civitas-illa-fortis-talking-to-trader-crewmember-after-agreeing-to-the-favour";
  const V_FORTIS_WITH_SAILS = "clues-in-civitas-illa-fortis-talking-to-a-trader-crewmember-with-the-sails";
  const V_FORTIS_RETURNED = "clues-in-civitas-illa-fortis-talking-to-a-trader-crewmember-after-having-returned-the-sails";
  const V_ARTIMA_FIRST = "clues-in-civitas-illa-fortis-talking-to-artima";
  const V_ARTIMA_DECLINED = "clues-in-civitas-illa-fortis-talking-to-artima-after-declining-doing-the-favour";
  const V_ARTIMA_LOST = "clues-in-civitas-illa-fortis-talking-to-artima-after-losing-the-repaired-sails";
  const V_SARIM_FIRST = "clues-in-port-sarim-talking-to-a-trader-crewmember-in-port-sarim";
  const V_SARIM_AGAIN = "clues-in-port-sarim-talking-to-a-trader-crewmember-in-port-sarim-again";
  const V_BETTY_FIRST = "clues-in-port-sarim-talking-to-betty";
  const V_BETTY_AGAIN = "clues-in-port-sarim-talking-to-betty-again";
  const V_BETTY_AFTER_HAIG = "clues-in-port-sarim-talking-to-betty-again-after-visiting-curator-haig-halen";
  const V_NOTES_FIRST = "clues-in-port-sarim-inspecting-betty-s-notes-for-the-first-time";
  const V_HAIG_FIRST = "in-varrock-museum-talking-to-curtor-haig-halen";
  const V_HAIG_AGAIN = "in-varrock-museum-talking-to-curtor-haig-halen-talking-to-haig-again";
  const V_HAIG_PICKPOCKET = "in-varrock-museum-pickpocketing-curator-haig-halen";
  const V_HAIG_CRATE = "in-varrock-museum-searching-the-crate";
  const V_HAIG_CRATES = "in-varrock-museum-searching-the-two-crates";
  const V_HAIG_FOUND = "in-varrock-museum-talking-to-curator-haig-halen-after-finding-the-diadem";
  const V_HAIG_RETURNED = "in-varrock-museum-talking-to-curator-haig-halen-after-arranging-the-diadem-s-return";

  // Action/message step ids handled with gameplay side effects.
  const SAILS_GIVEN_STEP_IDS = new Set(["1wx5TB", "-1DZ27", "123zW4"]);
  const SAILS_REPAIRED_STEP_IDS = new Set(["92E3NZ", "6yZD0M"]);
  const NOTES_GIVEN_STEP_IDS = new Set(["zLd3nC", "9CiLQ7"]);
  const CRATE_SEARCH_STEP = "XVW4Mv";
  const CUTSCENE_BEGIN_STEP = "xxhjn2";
  const CUTSCENE_END_STEP = "MC3wD2";
  const COMPLETE_STEP = "i2moAx";
  const VISITOR_SILENT_STEP_IDS = new Set(["YULuAF", "BBOzW9"]);

  const VISITOR_QUESTION_LINE = "I was wondering if you'd seen anything unusual around the museum lately?";
  const HERMINIUS_HANDOFF_LINE = "Thank you, iknami.";
  const CREW_FAVOUR_LINE = "Although, we could use a hand... Think you could do us a small favour?";
  const CREW_CASE_OPTION = "Have you seen a man with a case?";
  const CREW_ACCEPT_OPTION = "Sure. What do you need?";
  const NON_OSF_CONDITION_ID = "LgTVfY";
  const OSF_CONDITION_ID = "Vr0XnM";
  const ARTIMA_FAVOUR_LINE = "Oh, in that case, I'll help you out, just so long as you can do me a small favour.";
  const CREW_PORT_SARIM_LINE = "Well, we explained how it does work and he then asked us to take him to Port Sarim...";
  const SARIM_RUNES_LINE = "Wandered up north, I think. Said something about trying to get hold of some runes.";
  const HAIG_HANDOFF_LINE = "Thank you. I'll head over there and let them know.";

  /** Per-player owner-only quest spawns, keyed by role. */
  const trackedNpcs = new WeakMap();
  /** The storeroom door this plugin currently holds open, as { open, closed }. */
  let storeroomDoorOpen = null;

  let quest;

  // ==========================================================================
  // State helpers
  // ==========================================================================

  function flags(player) {
    return Number(player.getAttribute(FLAGS_ATTRIBUTE)) || 0;
  }

  function hasFlag(player, bit) {
    return (flags(player) & bit) !== 0;
  }

  function setFlag(player, bit, varbitId) {
    player.setAttribute(FLAGS_ATTRIBUTE, flags(player) | bit);
    player.getPacketSender().sendVarbit(varbitId, 1);
  }

  function shame(player) {
    return Math.max(0, Math.min(SHAME_MAX, Number(player.getAttribute(SHAME_ATTRIBUTE)) || 0));
  }

  function addShame(player, delta) {
    const value = Math.max(0, Math.min(SHAME_MAX, shame(player) + delta));
    player.setAttribute(SHAME_ATTRIBUTE, value);
    player.getPacketSender().sendVarbit(SHAME_VARBIT, value);
  }

  function held(player, itemId, amount = 1) {
    return player.getInventory().getAmount(itemId) >= amount;
  }

  function informantRole(player) {
    const stored = player.getAttribute(INFORMANT_ATTRIBUTE);
    if (stored === "citizen" || stored === "tourist") return stored;
    if (quest.getStage(player) !== STAGE_CLUE) return null;
    const role = Math.random() < 0.5 ? "citizen" : "tourist";
    player.setAttribute(INFORMANT_ATTRIBUTE, role);
    return role;
  }

  function visitorRole(npcId) {
    if (npcId === CITIZEN_NPC_ID) return "citizen";
    if (npcId === TOURIST_NPC_ID) return "tourist";
    if (npcId === ACADEMIC_NPC_ID) return "academic";
    return null;
  }

  function isQuestPage(pages) {
    return Array.isArray(pages) && pages.some((page) => page?.page === PAGE);
  }

  /** Another quest's completion through the runtime, with a stage>=2 fallback. */
  function isQuestComplete(player, key) {
    const request = { player, key, complete: null };
    api.emitCustomEvent("quest:is-complete", request);
    if (typeof request.complete === "boolean") return request.complete;
    const stage = Number(player.getAttribute(`quest.${key}.stage`));
    return Number.isFinite(stage) && stage >= 2;
  }

  function meetsRequirements(player) {
    if (player.getSkillManager().getCurrentLevel(Skill.THIEVING) < 25) return false;
    return isQuestComplete(player, "children_of_the_sun") && isQuestComplete(player, "shield_of_arrav");
  }

  function advanceStage(player, stage) {
    if (quest.getStage(player) < stage) quest.setStage(player, stage);
  }

  function maybeAdvanceInvestigation(player) {
    if (
      hasFlag(player, BIT_INVESTIGATED_TOOLS) &&
      hasFlag(player, BIT_INVESTIGATED_DISPLAY) &&
      quest.getStage(player) < STAGE_CLUE
    ) {
      quest.setStage(player, STAGE_CLUE);
    }
  }

  function maybeAdvanceVisitors(player) {
    if (quest.getStage(player) !== STAGE_CLUE) return;
    if (
      hasFlag(player, BIT_QUESTIONED_CITIZEN) &&
      hasFlag(player, BIT_QUESTIONED_TOURIST) &&
      hasFlag(player, BIT_QUESTIONED_ACADEMIC)
    ) {
      quest.setStage(player, STAGE_REGULUS);
    }
  }

  // ==========================================================================
  // NPC spawns
  // ==========================================================================

  function spawnTracked(player, key, definition) {
    const tracked = trackedNpcs.get(player) ?? new Map();
    trackedNpcs.set(player, tracked);
    if (tracked.get(key)) return tracked.get(key);
    const npc = api.spawnNpc({ ...definition, owner: player, ownerOnly: true });
    if (npc) tracked.set(key, npc);
    return npc;
  }

  function ensureQuestNpcs(player) {
    if (!player || player.isPlayerBot?.() === true) return;
    spawnTracked(player, "herminius", { id: HERMINIUS_NPC_ID, x: 1712, y: 3163, z: 0, wanderRadius: 0 });
    spawnTracked(player, "citizen", { id: CITIZEN_NPC_ID, x: 1708, y: 3160, z: 0, wanderRadius: 0 });
    spawnTracked(player, "tourist", { id: TOURIST_NPC_ID, x: 1712, y: 3160, z: 0, wanderRadius: 0 });
    spawnTracked(player, "academic", { id: ACADEMIC_NPC_ID, x: 1716, y: 3160, z: 0, wanderRadius: 0 });
    spawnTracked(player, "regulus", { id: REGULUS_NPC_ID, x: 1701, y: 3143, z: 0, wanderRadius: 0 });
    spawnTracked(player, "artima", { id: ARTIMA_NPC_ID, x: 1766, y: 3101, z: 0, wanderRadius: 0 });
    spawnTracked(player, "fortis-crew", { id: FORTIS_CREW_NPC_ID, x: 1742, y: 3135, z: 0, wanderRadius: 0 });
    spawnTracked(player, "sarim-crew", { id: SARIM_CREW_NPC_ID, x: 3037, y: 3194, z: 0, wanderRadius: 0 });
  }

  function removeQuestNpcs(player) {
    const tracked = trackedNpcs.get(player);
    if (!tracked) return;
    for (const npc of tracked.values()) api.removeNpc(npc);
    trackedNpcs.delete(player);
  }

  // ==========================================================================
  // Transcript wiring
  // ==========================================================================

  /** Which variant an NPC plays, by quest stage. Unrelated NPCs fall through. */
  function selectVariant({ npcId, player }) {
    if (npcId === HERMINIUS_NPC_ID) return selectHerminiusVariant(player);
    if (VISITOR_IDS.has(npcId)) return selectVisitorVariant(player, npcId);
    if (npcId === REGULUS_NPC_ID) return selectRegulusVariant(player);
    if (FORTIS_CREW_IDS.has(npcId)) return selectFortisCrewVariant(player);
    if (SARIM_CREW_IDS.has(npcId)) return selectSarimCrewVariant(player);
    if (npcId === ARTIMA_NPC_ID) return selectArtimaVariant(player);
    if (npcId === HAIG_NPC_ID) return selectHaigVariant(player);
    if (npcId === NpcIdentifiers.BETTY) return selectBettyVariant(player);
    return null;
  }

  function selectHerminiusVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_STARTED) return null;
    if (stage >= STAGE_RETURN) return V_HERMINIUS_FINAL;
    if (stage >= STAGE_INVESTIGATE) return V_HERMINIUS_CLUES;
    return V_HERMINIUS_INTRO;
  }

  function selectVisitorVariant(player, npcId) {
    if (quest.getStage(player) !== STAGE_CLUE) return null;
    const role = visitorRole(npcId);
    if (role !== null && role === informantRole(player)) return V_VISITOR_CLUE;
    return V_VISITOR_NOTHING;
  }

  function selectRegulusVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_REGULUS) return null;
    return stage >= STAGE_CREW ? V_REGULUS_AGAIN : V_REGULUS_FIRST;
  }

  function selectFortisCrewVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_CREW || quest.isComplete(player)) return null;
    if (stage >= STAGE_RETURN_SAILS) return V_FORTIS_RETURNED;
    if (stage >= STAGE_REPAIR) {
      return held(player, SAILS_ITEM_ID) ? V_FORTIS_WITH_SAILS : V_FORTIS_AGREED;
    }
    return player.getAttribute(DECLINED_FAVOUR_ATTRIBUTE) === true ? V_FORTIS_DECLINED : V_FORTIS_FIRST;
  }

  function selectSarimCrewVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_PORT_SARIM || quest.isComplete(player)) return null;
    return stage >= STAGE_BETTY ? V_SARIM_AGAIN : V_SARIM_FIRST;
  }

  function selectArtimaVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_REPAIR || stage >= STAGE_PORT_SARIM) return null;
    if (hasFlag(player, BIT_FIXED_SAILS)) return V_ARTIMA_LOST;
    if (hasFlag(player, BIT_CRAFTING_FAVOUR_ASKED)) return V_ARTIMA_DECLINED;
    return V_ARTIMA_FIRST;
  }

  function selectBettyVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_BETTY) return null;
    if (stage >= STAGE_STOREROOM) return V_BETTY_AFTER_HAIG;
    if (stage >= STAGE_READ_NOTES) return V_BETTY_AGAIN;
    return V_BETTY_FIRST;
  }

  function selectHaigVariant(player) {
    const stage = quest.getStage(player);
    if (stage < STAGE_HAIG) return null;
    if (stage >= STAGE_CUTSCENE) return V_HAIG_RETURNED;
    if (stage >= STAGE_CONFRONT) return V_HAIG_FOUND;
    return stage >= STAGE_STOREROOM ? V_HAIG_AGAIN : V_HAIG_FIRST;
  }

  /** Answers the wiki prose conditions from the player's quest state. */
  function answerCondition(event) {
    if (!isQuestPage(event.pages)) return null;
    const { player, stepId } = event;
    switch (stepId) {
      case "CAzpP4":
        return !meetsRequirements(player);
      case "MBl5US":
        return meetsRequirements(player);
      case "Qeeq6m":
        return quest.getStage(player) < STAGE_CLUE;
      case "UWPNbs":
        return quest.getStage(player) >= STAGE_CLUE && quest.getStage(player) < STAGE_REGULUS;
      case "SsFS8H":
        return quest.getStage(player) >= STAGE_REGULUS && !hasFlag(player, BIT_DIADEM);
      case "WPK1ZO":
        return hasFlag(player, BIT_DIADEM);
      case "ZSVQQP":
        return informantRole(player) === "citizen";
      case "HBhK3a":
        return informantRole(player) === "tourist";
      case "LgTVfY":
      case "jVFeXW":
        return !isQuestComplete(player, "one_small_favour");
      case "Vr0XnM":
      case "wQ6LNT":
        return isQuestComplete(player, "one_small_favour");
      case "1yeeSP":
      case "Y9Jo6i":
      case "2mcH7X":
      case "4TczKs":
        return player.getInventory().isFull();
      case "bnZg2R":
      case "94fUqn":
      case "pVAcnS":
        return !player.getInventory().isFull();
      case "t_CApx":
        return held(player, TATTERED_SAILS_ITEM_ID);
      case "QbESwT":
        return !held(player, TATTERED_SAILS_ITEM_ID) && !held(player, SAILS_ITEM_ID);
      case "jcDmva":
        return player.getAttribute(PENDING_SAILS_ATTRIBUTE) === true;
      case "zMEiLB":
        return held(player, BETTYS_NOTES_ITEM_ID);
      case "HItAxB":
        return !held(player, BETTYS_NOTES_ITEM_ID);
      case "f07S0F":
        return shame(player) < SHAME_MAX;
      case "ke5P0h":
        return shame(player) >= SHAME_MAX;
      case "krLq4g":
        return player.getInventory().isFull();
      default:
        return null;
    }
  }

  /** The quest-start slug on the display's "Yes." option. */
  function handleStartHook({ player, npcId, hook }) {
    if (hook !== START_HOOK || npcId !== HERMINIUS_NPC_ID) return;
    if (quest.getStage(player) === 0) quest.setStage(player, STAGE_STARTED);
  }

  /** Dialogue choices that move the state machine along. */
  function handleChoice(event) {
    const { player, npcId, option } = event;
    const stage = quest.getStage(player);
    if (npcId === HAIG_NPC_ID) {
      if (stage === STAGE_HAIG && option === "I'm looking for Xerna's Diadem.") {
        quest.setStage(player, STAGE_STOREROOM);
        return;
      }
      if (stage === STAGE_CONFRONT && option === "I found Xerna's Diadem...") {
        quest.setStage(player, STAGE_SHAME);
        player.setAttribute(SHAME_ATTRIBUTE, 0);
        player.getPacketSender().sendVarbit(SHAME_VARBIT, 0);
        return;
      }
      if (stage === STAGE_SHAME && SHAME_INCREASE_OPTIONS.has(option)) {
        addShame(player, SHAME_STEP);
        return;
      }
      if (stage === STAGE_SHAME && SHAME_DECREASE_OPTIONS.has(option)) {
        addShame(player, -SHAME_STEP);
      }
      return;
    }
    if (npcId === REGULUS_NPC_ID) {
      if (stage === STAGE_REGULUS && option === "Have you seen anybody suspicious around?") {
        quest.setStage(player, STAGE_CREW);
      }
      return;
    }
    if (FORTIS_CREW_IDS.has(npcId) && stage === STAGE_CREW && option === "Not right now.") {
      player.setAttribute(DECLINED_FAVOUR_ATTRIBUTE, true);
    }
  }

  /** Lines that mark a milestone (the wiki has no step ids for these). */
  function handleDialogueLine(event) {
    const { player, npcId, text } = event;
    if (npcId === HERMINIUS_NPC_ID) {
      if (quest.getStage(player) === STAGE_STARTED && text === HERMINIUS_HANDOFF_LINE) {
        quest.setStage(player, STAGE_INVESTIGATE);
      }
      return;
    }
    if (VISITOR_IDS.has(npcId)) {
      if (quest.getStage(player) !== STAGE_CLUE || text !== VISITOR_QUESTION_LINE) return;
      const role = visitorRole(npcId);
      if (role === "citizen") setFlag(player, BIT_QUESTIONED_CITIZEN, QUESTIONED_CITIZEN_VARBIT);
      else if (role === "tourist") setFlag(player, BIT_QUESTIONED_TOURIST, QUESTIONED_TOURIST_VARBIT);
      else if (role === "academic") setFlag(player, BIT_QUESTIONED_ACADEMIC, QUESTIONED_ACADEMIC_VARBIT);
      maybeAdvanceVisitors(player);
      return;
    }
    if (FORTIS_CREW_IDS.has(npcId)) {
      const stage = quest.getStage(player);
      if (stage === STAGE_CREW && text === CREW_FAVOUR_LINE) {
        setFlag(player, BIT_CREWMEMBER_FAVOUR_ASKED, CREWMEMBER_FAVOUR_VARBIT);
        return;
      }
      if (stage === STAGE_RETURN_SAILS && text === CREW_PORT_SARIM_LINE) {
        quest.setStage(player, STAGE_PORT_SARIM);
      }
      return;
    }
    if (npcId === ARTIMA_NPC_ID) {
      if (quest.getStage(player) === STAGE_REPAIR && text === ARTIMA_FAVOUR_LINE) {
        setFlag(player, BIT_CRAFTING_FAVOUR_ASKED, CRAFTING_FAVOUR_VARBIT);
      }
      return;
    }
    if (SARIM_CREW_IDS.has(npcId)) {
      if (quest.getStage(player) === STAGE_PORT_SARIM && text === SARIM_RUNES_LINE) {
        quest.setStage(player, STAGE_BETTY);
      }
      return;
    }
    if (npcId === HAIG_NPC_ID && quest.getStage(player) === STAGE_CUTSCENE_END && text === HAIG_HANDOFF_LINE) {
      quest.setStage(player, STAGE_RETURN);
    }
  }

  /**
   * Condition branches that carry side effects. The chosen-branch event has no
   * `pages` field, so these are scoped by the speaker and the page's step ids.
   */
  function handleChosenCondition(event) {
    const { player, npcId, stepId } = event;
    if (npcId === HAIG_NPC_ID && stepId === "ke5P0h") {
      advanceStage(player, STAGE_CUTSCENE);
      return;
    }
    if (!FORTIS_CREW_IDS.has(npcId)) return;
    if (stepId === "1yeeSP") {
      player.setAttribute(PENDING_SAILS_ATTRIBUTE, true);
      return;
    }
    if (stepId === "bnZg2R") {
      player.setAttribute(PENDING_SAILS_ATTRIBUTE, false);
    }
  }

  /** Action/message steps that hand items over or advance the cutscene. */
  function handleAction(event) {
    const { player, npcId, stepId } = event;
    if (FORTIS_CREW_IDS.has(npcId) && SAILS_GIVEN_STEP_IDS.has(stepId)) {
      if (!held(player, TATTERED_SAILS_ITEM_ID)) player.getInventory().adds(TATTERED_SAILS_ITEM_ID, 1);
      setFlag(player, BIT_GIVEN_SAILS, GIVEN_SAILS_VARBIT);
      player.setAttribute(PENDING_SAILS_ATTRIBUTE, false);
      advanceStage(player, STAGE_REPAIR);
      return;
    }
    if (npcId === ARTIMA_NPC_ID && SAILS_REPAIRED_STEP_IDS.has(stepId)) {
      if (held(player, TATTERED_SAILS_ITEM_ID)) {
        player.getInventory().deleteNumber(TATTERED_SAILS_ITEM_ID, 1);
        player.getInventory().adds(SAILS_ITEM_ID, 1);
      }
      setFlag(player, BIT_FIXED_SAILS, FIXED_SAILS_VARBIT);
      return;
    }
    if (FORTIS_CREW_IDS.has(npcId) && stepId === "7Wg9ig") {
      if (held(player, SAILS_ITEM_ID)) player.getInventory().deleteNumber(SAILS_ITEM_ID, 1);
      advanceStage(player, STAGE_RETURN_SAILS);
      return;
    }
    if (npcId === NpcIdentifiers.BETTY && NOTES_GIVEN_STEP_IDS.has(stepId)) {
      if (!held(player, BETTYS_NOTES_ITEM_ID)) player.getInventory().adds(BETTYS_NOTES_ITEM_ID, 1);
      setFlag(player, BIT_GIVEN_NOTES, GIVEN_NOTES_VARBIT);
      setFlag(player, BIT_BETTY_TOLD, BETTY_TOLD_VARBIT);
      advanceStage(player, STAGE_READ_NOTES);
      return;
    }
    if (npcId === HAIG_NPC_ID && stepId === CRATE_SEARCH_STEP) {
      setFlag(player, BIT_DIADEM, DIADEM_VARBIT);
      advanceStage(player, STAGE_CONFRONT);
      return;
    }
    if (npcId === HAIG_NPC_ID && stepId === CUTSCENE_BEGIN_STEP) {
      advanceStage(player, STAGE_CUTSCENE);
      return;
    }
    if (npcId === HAIG_NPC_ID && stepId === CUTSCENE_END_STEP) {
      advanceStage(player, STAGE_CUTSCENE_END);
      return;
    }
    if (npcId === HERMINIUS_NPC_ID && stepId === COMPLETE_STEP) {
      if (!quest.isComplete(player)) quest.complete(player);
      return;
    }
    if (VISITOR_IDS.has(npcId) && VISITOR_SILENT_STEP_IDS.has(stepId)) {
      const branch = event.step?.steps;
      if (Array.isArray(branch)) {
        event.handled = true;
        event.steps = branch;
      }
    }
  }

  // ==========================================================================
  // Objects and items
  // ==========================================================================

  function inspectEmptyDisplay(event) {
    if (event.definition?.id !== EMPTY_DISPLAY_OBJECT_ID) return false;
    event.handled = true;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage === 0) {
      startTranscript(api, player, HERMINIUS_NPC_ID, PAGE, V_DISPLAY_START);
      return true;
    }
    if (stage === STAGE_INVESTIGATE) {
      setFlag(player, BIT_INVESTIGATED_DISPLAY, INVESTIGATED_DISPLAY_VARBIT);
      startTranscript(api, player, HERMINIUS_NPC_ID, PAGE, V_DISPLAY_AGAIN);
      maybeAdvanceInvestigation(player);
      return true;
    }
    if (stage < STAGE_CLUE) {
      startTranscript(api, player, HERMINIUS_NPC_ID, PAGE, V_DISPLAY_START);
    }
    return true;
  }

  function inspectDiademDisplay(event) {
    if (event.definition?.id !== DIADEM_DISPLAY_OBJECT_ID) return false;
    event.handled = true;
    const { player } = event;
    if (quest.isComplete(player)) {
      player.sendMessage("The diadem on display here dates back to the earliest days of Varlamore. It was made for the hero Xerna and it is believed she wore it when she wed her long-time companion, Quoatlos.");
      player.sendMessage("While the diadem was safely displayed here for many years, it was recently stolen by an unknown party. However, thanks to a helpful adventurer, the diadem was quickly recovered.");
    } else {
      player.sendMessage("Be aware that the diadem normally displayed here was recently stolen. However, thanks to a helpful adventurer, the diadem has been recovered and will soon be back on display.");
    }
    return true;
  }

  function investigateTools(event) {
    if (event.definition?.id !== TOOLS_OBJECT_ID) return false;
    const { player } = event;
    if (quest.getStage(player) !== STAGE_INVESTIGATE || hasFlag(player, BIT_INVESTIGATED_TOOLS)) return false;
    event.handled = true;
    setFlag(player, BIT_INVESTIGATED_TOOLS, INVESTIGATED_TOOLS_VARBIT);
    startTranscript(api, player, HERMINIUS_NPC_ID, PAGE, V_TOOLS);
    maybeAdvanceInvestigation(player);
    return true;
  }

  function searchDiademCrate(event) {
    if (event.definition?.id !== DIADEM_CRATE_OBJECT_ID) return false;
    const { player } = event;
    if (quest.getStage(player) < STAGE_STOREROOM) return false;
    // Claim every later search too: the first one set the diadem flag, so repeat
    // clicks must not replay the transcript or set any state twice.
    event.handled = true;
    if (!hasFlag(player, BIT_DIADEM)) {
      startTranscript(api, player, HAIG_NPC_ID, PAGE, V_HAIG_CRATE);
    }
    return true;
  }

  function searchFlavourCrates(event) {
    if (event.definition?.id !== FLAVOUR_CRATES_OBJECT_ID) return false;
    const { player } = event;
    if (quest.getStage(player) < STAGE_STOREROOM) return false;
    event.handled = true;
    startTranscript(api, player, HAIG_NPC_ID, PAGE, V_HAIG_CRATES);
    return true;
  }

  /** The storeroom door is not in the Doors plugin's catalog, so swing it here. */
  function handleStoreroomDoor(request) {
    if (request.handled || request.objectId !== STOREROOM_DOOR_OBJECT_ID) return;
    const object = request.object;
    const location = object?.getLocation?.();
    if (!location || location.getX() !== STOREROOM_DOOR_TILE.x || location.getY() !== STOREROOM_DOOR_TILE.y) return;
    request.handled = true;
    if (!held(request.player, STOREROOM_KEY_ITEM_ID)) {
      request.player.sendMessage("The door is locked.");
      return;
    }
    openStoreroomDoor(request.player, object);
  }

  function openStoreroomDoor(player, object) {
    // A second toggle in the same tick (or a replayed door event) must not leak a
    // second open object or overwrite the tracked one.
    if (storeroomDoorOpen) return;
    const location = object.getLocation();
    const type = object.getType();
    const rotation = object.getFace() & 0x3;
    const openRotation = (rotation + 1) & 0x3;
    const [dx, dy] = DOOR_SWING_OFFSETS[openRotation];
    const open = new GameObject(
      STOREROOM_DOOR_OPEN_OBJECT_ID,
      new Location(location.getX() + dx, location.getY() + dy, location.getZ()),
      type,
      (rotation - 1) & 0x3,
      null
    );
    ObjectManager.register(open, true);
    ObjectManager.deregister(object, true);
    Sounds.sendSound(player, Sound.DOOR_OPEN);
    storeroomDoorOpen = {
      open,
      closed: { x: location.getX(), y: location.getY(), z: location.getZ(), type, rotation },
    };
    scheduleStoreroomDoorClose();
  }

  function scheduleStoreroomDoorClose() {
    const manager = api.getTaskManager();
    if (!manager || typeof Task !== "function") return;
    manager.cancelTasks(STOREROOM_DOOR_TASK_KEY);
    const task = new Task(STOREROOM_DOOR_AUTO_CLOSE_TICKS, STOREROOM_DOOR_TASK_KEY);
    task.execute = () => {
      task.stop();
      closeStoreroomDoor();
    };
    manager.submit(task);
  }

  function closeStoreroomDoor() {
    const state = storeroomDoorOpen;
    storeroomDoorOpen = null;
    if (!state) return;
    ObjectManager.deregister(state.open, true);
    ObjectManager.register(
      new GameObject(
        STOREROOM_DOOR_OBJECT_ID,
        new Location(state.closed.x, state.closed.y, state.closed.z),
        state.closed.type,
        state.closed.rotation,
        null
      ),
      true
    );
  }

  /** Pickpocketing Haig during the storeroom step always yields the key. */
  function pickCuratorPocket(event) {
    if (event.npcId !== HAIG_NPC_ID) return false;
    const { player } = event;
    if (quest.getStage(player) !== STAGE_STOREROOM) return false;
    if (!held(player, STOREROOM_KEY_ITEM_ID)) {
      player.getInventory().adds(STOREROOM_KEY_ITEM_ID, 1);
      startTranscript(api, player, HAIG_NPC_ID, PAGE, V_HAIG_PICKPOCKET);
    }
    quest.setStage(player, STAGE_SEARCH_CRATE);
    return true;
  }

  /**
   * Dig Site's variant hook owns Haig whenever its own quest has not started, so
   * the EAA variants would never be selected. Claim his Talk-to while the quest
   * needs him (stages 22-35) and play the page variant directly; every other Haig
   * talk (and Dig Site/The Golem players) falls through unchanged.
   */
  function talkToCuratorHaig(event) {
    if (event.npcId !== HAIG_NPC_ID) return false;
    const { player } = event;
    const stage = quest.getStage(player);
    if (stage < STAGE_HAIG || stage >= STAGE_RETURN) return false;
    const variant = selectHaigVariant(player);
    if (!variant) return false;
    event.handled = true;
    startTranscript(api, player, HAIG_NPC_ID, PAGE, variant);
    return true;
  }

  /**
   * The first-time Cothon variant nests the shared sails task only inside the
   * "has completed One Small Favour" condition (Vr0XnM); its sibling non-OSF
   * branch ("Sure. What do you need?") ends in a wiki "continues" jump the
   * runtime cannot resolve, so without One Small Favour the hand-over never
   * plays. Append the shared task (Vr0XnM's wiki wording after its own OSF
   * choice) to that option so its branch reaches the sails. The OSF-completed
   * branch is left exactly as the transcript ships it.
   */
  function withNonOsfCrewHandover(player, variant, steps) {
    if (variant !== V_FORTIS_FIRST || isQuestComplete(player, "one_small_favour")) return steps;
    if (!Array.isArray(steps)) return steps;
    const clone = JSON.parse(JSON.stringify(steps));
    const menu = clone.find(
      (step) => step.type === "choice" && step.options?.some((option) => option.text === CREW_CASE_OPTION)
    );
    const caseSteps = menu?.options.find((option) => option.text === CREW_CASE_OPTION)?.steps;
    const nonOsf = caseSteps?.find((step) => step.type === "condition" && step.id === NON_OSF_CONDITION_ID);
    const osf = caseSteps?.find((step) => step.type === "condition" && step.id === OSF_CONDITION_ID);
    const accept = nonOsf?.steps?.find((step) => step.type === "choice")
      ?.options?.find((option) => option.text === CREW_ACCEPT_OPTION);
    if (!accept || !Array.isArray(osf?.steps) || osf.steps.length < 2) return steps;
    accept.steps = [...(accept.steps ?? []), ...osf.steps.slice(1)];
    return clone;
  }

  /**
   * CharterShips claims Trader Crewmember Talk-to, so play the quest variant first
   * while EAA needs the crew (the Cothon crew through stage 15, the Port Sarim crew
   * at 16-17). Every other crewmember and completed quests fall through to the
   * charter menu. `npc-dialogue:start` keeps the page's jump context (needed by the
   * "after having returned the sails" variant) and lets the non-OSF hand-over be
   * spliced into the first-time variant.
   */
  function talkToTraderCrewmember(event) {
    const { player, npcId } = event;
    const variant = FORTIS_CREW_IDS.has(npcId)
      ? selectFortisCrewVariant(player)
      : SARIM_CREW_IDS.has(npcId)
        ? selectSarimCrewVariant(player)
        : null;
    if (!variant) return false;
    event.handled = true;
    api.emitCustomEvent("npc-dialogue:start", {
      player,
      npcId,
      variant,
      select: (steps) => withNonOsfCrewHandover(player, variant, steps),
    });
    return true;
  }

  /** Reading Betty's notes advances the clue hunt. */
  function readBettyNotes(event) {
    const { player } = event;
    if (quest.getStage(player) !== STAGE_READ_NOTES) return false;
    event.handled = true;
    startTranscript(api, player, NpcIdentifiers.BETTY, PAGE, V_NOTES_FIRST);
    quest.setStage(player, STAGE_HAIG);
    return true;
  }

  /** Using the repaired sails on a trader crewmember opens the hand-over. */
  function handleSailsOnCrewmember(event) {
    if (event.itemId !== SAILS_ITEM_ID || !FORTIS_CREW_IDS.has(event.npcId)) return;
    event.handled = true;
    if (quest.getStage(event.player) >= STAGE_RETURN_SAILS) return;
    startTranscript(api, event.player, event.npcId, PAGE, V_FORTIS_WITH_SAILS);
  }

  // ==========================================================================
  // Journal and reward
  // ==========================================================================

  function buildJournal(player, questHandle) {
    const stage = questHandle.getStage(player);
    if (stage >= STAGE_COMPLETE) {
      return [
        "<str>I investigated the theft of Xerna's Diadem from the Grand</str>",
        "<str>Museum in Civitas illa Fortis and traced it to Curator Haig</str>",
        "<str>Halen in Varrock. I confronted him and he agreed to have the</str>",
        "<str>diadem returned to the Grand Museum.</str>",
        "",
        "<col=ff0000>QUEST COMPLETE!</col>",
      ];
    }
    if (stage >= STAGE_RETURN) {
      return [
        "Haig Halen agreed to return Xerna's Diadem to the Grand Museum.",
        "",
        "I should tell <col=800000>Curator Herminius</col> in Civitas illa Fortis",
        "that the diadem is on its way back.",
      ];
    }
    if (stage >= STAGE_SHAME) {
      return [
        "I found Xerna's Diadem in the Varrock Museum storeroom.",
        "",
        "I should shame <col=800000>Curator Haig Halen</col> into admitting",
        "that he took it, until he agrees to return it.",
      ];
    }
    if (stage >= STAGE_CONFRONT) {
      return [
        "I found Xerna's Diadem in a crate in the Varrock Museum",
        "storeroom, along with other stolen artefacts.",
        "",
        "I should confront <col=800000>Curator Haig Halen</col> about it.",
      ];
    }
    if (stage >= STAGE_STOREROOM) {
      return [
        "Curator Haig Halen denied knowing anything about the diadem.",
        "",
        "I should pickpocket him for the storeroom key, then search the",
        "crate in the museum storeroom.",
      ];
    }
    if (stage >= STAGE_HAIG) {
      return [
        "The runes Betty's notes described are those for Varrock",
        "Teleport, and the grey-haired man matches <col=800000>Curator Haig",
        "Halen</col> of the Varrock Museum.",
        "",
        "I should ask him about Xerna's Diadem.",
      ];
    }
    if (stage >= STAGE_READ_NOTES) {
      return [
        "Betty in Port Sarim gave me notes on the strange rune order",
        "the grey-haired man asked about.",
        "",
        "I should read <col=800000>Betty's notes</col>.",
      ];
    }
    if (stage >= STAGE_BETTY) {
      return [
        "The trader crew in Port Sarim said the grey-haired man with",
        "the case headed north to buy runes.",
        "",
        "I should ask <col=800000>Betty</col> in her magic shop.",
      ];
    }
    if (stage >= STAGE_PORT_SARIM) {
      return [
        "The man with the case sailed to Port Sarim.",
        "",
        "I should ask the trader crew at the southern dock there where",
        "he went.",
      ];
    }
    if (stage >= STAGE_RETURN_SAILS) {
      return [
        "The trader crew told me the grey-haired man with the case",
        "chartered a ship to Port Sarim.",
        "",
        "I should make my way to Port Sarim and ask about him there.",
      ];
    }
    if (stage >= STAGE_REPAIR) {
      return [
        "The trader crew in the Fortis Cothon asked me to get their",
        "tattered sails repaired in return for information.",
        "",
        hasFlag(player, BIT_FIXED_SAILS)
          ? "I should return the <col=800000>repaired sails</col> to the crew."
          : "I should take the <col=800000>tattered sails</col> to Artima's crafting shop.",
      ];
    }
    if (stage >= STAGE_CREW) {
      return [
        "Regulus Cento said the suspicious man headed east to the",
        "Fortis Cothon.",
        "",
        "I should ask a <col=800000>trader crewmember</col> there about him.",
      ];
    }
    if (stage >= STAGE_REGULUS) {
      return [
        "Someone saw a shifty individual leave the Grand Museum and",
        "head towards the quetzal landing site.",
        "",
        "I should ask <col=800000>Regulus Cento</col> there.",
      ];
    }
    if (stage >= STAGE_CLUE) {
      return [
        "I found evidence the diadem was stolen by a professional",
        "thief and asked the museum visitors about it.",
        "",
        "I should follow the lead to the quetzal landing site.",
      ];
    }
    if (stage >= STAGE_INVESTIGATE) {
      return [
        "Curator Herminius asked me to look around the museum for",
        "anything he might have missed.",
        "",
        "I should investigate the tools behind the display and then",
        "inspect the empty display again.",
      ];
    }
    if (stage >= STAGE_STARTED) {
      return [
        "I inspected the empty display in the Grand Museum and spoke",
        "to <col=800000>Curator Herminius</col> about the stolen diadem.",
        "",
        "I should ask him how I can help.",
      ];
    }
    return [
      "I can start this quest by investigating the <col=800000>Empty Display</col>",
      "on the ground floor of the Grand Museum in Civitas illa Fortis.",
      "",
      "I need 25 Thieving, and to have completed Children of the Sun",
      "and Shield of Arrav.",
    ];
  }

  function grantReward(player) {
    player.getSkillManager().addExperiences(Skill.THIEVING, 6000);
    // registerQuest adds one coin; top the stack up to 5,000.
    player.getInventory().adds(COINS_ITEM_ID, 4999);
  }

  // ==========================================================================
  // Login / logout
  // ==========================================================================

  function syncSideVarbits({ player }) {
    if (!player || player.isPlayerBot?.() === true) return;
    const bits = flags(player);
    const sender = player.getPacketSender();
    for (const [bit, varbitId] of FLAG_VARBITS) {
      sender.sendVarbit(varbitId, (bits & bit) !== 0 ? 1 : 0);
    }
    sender.sendVarbit(SHAME_VARBIT, shame(player));
  }

  function handleLogin({ player }) {
    ensureQuestNpcs(player);
    refreshQuestList(player);
  }

  function handleLogout({ player }) {
    if (player) removeQuestNpcs(player);
  }

  api.persistAttribute(FLAGS_ATTRIBUTE);
  api.persistAttribute(INFORMANT_ATTRIBUTE);
  api.persistAttribute(SHAME_ATTRIBUTE);
  api.persistAttribute(PENDING_SAILS_ATTRIBUTE);
  api.persistAttribute(DECLINED_FAVOUR_ATTRIBUTE);

  quest = registerQuest(api, {
    key: "ethically_acquired_antiquities",
    name: "Ethically Acquired Antiquities",
    varpId: VARP_EAA,
    varbitId: STAGE_VARBIT,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: Skill.THIEVING.getIndex(), amount: 6000, label: "Thieving" }],
    rewardItemId: COINS_ITEM_ID,
    rewardItemLabel: "5,000 Coins",
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:hook", handleStartHook);
  api.onCustomEvent("npc-dialogue:choice", handleChoice);
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  api.onCustomEvent("npc-dialogue:condition", handleChosenCondition);
  api.onCustomEvent("npc-dialogue:action", handleAction);
  api.onObjectInteraction("Empty display", { Inspect: inspectEmptyDisplay });
  api.onObjectInteraction("Xerna's Diadem", { Inspect: inspectDiademDisplay });
  api.onObjectInteraction("Tools", { Investigate: investigateTools });
  api.onObjectInteraction("Crate", { Search: searchDiademCrate });
  api.onObjectInteraction("Crates", { Search: searchFlavourCrates });
  api.onCustomEvent("door:toggle", handleStoreroomDoor);
  api.onNpcInteraction("Curator Haig Halen", {
    "Talk-to": talkToCuratorHaig,
    Pickpocket: pickCuratorPocket,
  });
  api.onNpcInteraction("Trader Crewmember", { "Talk-to": talkToTraderCrewmember });
  // ItemIdentifiers.BETTYS_NOTES (29905): inventory option "Read".
  api.onItemAction("Betty's notes", { Read: readBettyNotes });
  api.onItemOnNpc(handleSailsOnCrewmember, { noted: false });
  api.onCustomEvent("player:bootstrap-complete", syncSideVarbits);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);
};
