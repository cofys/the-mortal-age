/**
 * The Heirless Crown — quest 1 of "The Bastard of Varrock".
 *
 * A dying priest's confession, a palace that buries things, and two gangs
 * buying up old church records. The player hears the rumor (Blue Moon Inn
 * bartender), hears the confession (Father Lawrence, interrupted by a palace
 * guardsman), confronts the guard (inside Varrock Palace), and gets the name
 * that starts the whole arc: Elspeth.
 *
 * Custom dialogue throughout (QuestRuntime.startDialogue), not a wiki
 * transcript — there is no canon page for this story. Talk-to is intercepted
 * by NPC name (specific hooks run before the generic transcript player) and
 * only consumed when the quest actually wants the NPC; every other stage
 * falls through to the canon transcript so Romeo & Juliet, ale-buying and
 * the rest keep working.
 *
 * Stages (varp 13): 0 not started, 1 rumor heard, 2 confession heard
 * (interrupted), 3 guard confronted, 4 complete.
 *
 * On completion the kingdom story flag misthalin:succession-rumors flips to
 * true — the rumor is out in Varrock, though the claim itself stays hidden.
 */
"use strict";

const { registerQuest, refreshQuestList, startDialogue, startTranscript } = require("../../quests/QuestRuntime");
const KingdomStore = require("../../kingdoms/KingdomStore");

const QUEST_KEY = "the_heirless_crown";
const VARP_HEIRLESS_CROWN = 13;

const STAGE_NOT_STARTED = 0;
const STAGE_RUMOR = 1;
const STAGE_CONFESSION = 2;
const STAGE_GUARD = 3;
const STAGE_COMPLETE = 4;

const BLUE_MOON_BARTENDER_ID = 1312;
const FATHER_LAWRENCE_ID = 5038;

const BARTENDER_PAGE = "Bartender (Blue Moon Inn)";
const BARTENDER_STANDARD_VARIANT = "standard-dialogue";

/** Varrock Palace ground floor. Mirrors the reframe plugin's rect. */
const PALACE_X1 = 3215;
const PALACE_X2 = 3242;
const PALACE_Y1 = 3458;
const PALACE_Y2 = 3502;

let quest = null;
let apiRef = null;

function inPalace(location) {
  if (!location || typeof location.getX !== "function") return false;
  const x = location.getX();
  const y = location.getY();
  const z = location.getZ();
  return z === 0 && x >= PALACE_X1 && x <= PALACE_X2 && y >= PALACE_Y1 && y <= PALACE_Y2;
}

function npcLocation(event) {
  return event.npc?.getLocation?.() ?? event.npc?.getSpawnLocation?.() ?? null;
}

function buildJournal(player, questHandle) {
  const stage = questHandle.getStage(player);
  if (stage >= STAGE_COMPLETE) {
    return [
      "<str>The bartender told me Varrock has no heir.</str>",
      "<str>Father Lawrence confessed the king secretly fathered a son.</str>",
      "<str>A palace guard warned me off; both gangs are buying old church records.</str>",
      "<str>The boy's mother was Elspeth, a Varrock seamstress.</str>",
      "",
      "<str>If any proof survived, it's in the palace library's royal registry.</str>",
      "",
      "<col=ff0000>QUEST COMPLETE!</col>",
    ];
  }
  if (stage === STAGE_GUARD) {
    return [
      "The guard warned me off, but let slip that both gangs",
      "are buying old church records.",
      "Father Lawrence may tell me more now.",
    ];
  }
  if (stage === STAGE_CONFESSION) {
    return [
      "Father Lawrence confessed that <col=800000>King Roald</col> secretly fathered",
      "a son — but a palace guardsman interrupted him.",
      "I should confront a <col=800000>guard</col> inside <col=800000>Varrock Palace</col>.",
    ];
  }
  if (stage === STAGE_RUMOR) {
    return [
      "The bartender says old <col=800000>Father Lawrence</col> is desperate",
      "to confess something before he dies.",
      "I should speak to him at the church east of <col=800000>Varrock Palace</col>.",
    ];
  }
  return [
    "I can start this quest by speaking to the",
    "<col=800000>bartender</col> at the <col=800000>Blue Moon Inn</col> in Varrock.",
    "",
    "There aren't any requirements for this quest.",
  ];
}

function grantReward(player) {
  const { Skill } = apiRef.core;
  player.getSkillManager().addExperiences(Skill.PRAYER, 500);
}

function startQuest(player) {
  quest.setStage(player, STAGE_RUMOR);
}

/** Hands Talk-to back to the canon transcript (keeps ale-buying working). */
function playStandardBartender(player, npcId) {
  player.getDialogueManager().reset();
  startTranscript(apiRef, player, npcId, BARTENDER_PAGE, BARTENDER_STANDARD_VARIANT);
}

/** The rumor is out in Varrock — flip the kingdom story flag, then complete. */
function finishQuest(player) {
  KingdomStore.setFlag("misthalin", "misthalin:succession-rumors", true);
  KingdomStore.save();
  quest.complete(player);
}

// ---------------------------------------------------------------------------
// Dialogue scripts (QuestRuntime step format)
// ---------------------------------------------------------------------------

const BARTENDER_START_STEPS = [
  { npc: ["What can I do yer for?"] },
  { player: ["What's the talk of the town?"] },
  {
    npc: [
      "Talk? It's all anyone does these days. The king's not been seen in weeks, and there's not a soul in this city who can tell you who'd wear the crown if he dropped.",
    ],
  },
  { player: ["No heir at all?"] },
  {
    npc: [
      "Not a one. No son, no daughter, no nephew twice removed. Old Roald's the last of the line, and the line's looking... thin.",
    ],
  },
  {
    npc: [
      "Old Father Lawrence has been carrying something heavy, mind. Keeps saying he needs to confess before Saradomin takes him. If you want to know what's really eating this city, start at the church, east of the palace.",
    ],
  },
  {
    options: [
      {
        text: "I'll go and see him.",
        next: [
          { exec: (player) => startQuest(player) },
          { npc: ["Good. And keep it to yourself - walls have ears in this city."] },
        ],
      },
      {
        text: "Not my business.",
        next: [{ npc: ["Suit yourself. Another round for the regulars, then."] }],
      },
      {
        text: "Actually, I'd like a drink.",
        echo: false,
        next: [{ exec: (player, context) => playStandardBartender(player, context.npcId) }],
      },
    ],
  },
];

const LAWRENCE_CONFESSION_STEPS = [
  { player: ["The bartender said you were looking to unburden yourself, Father."] },
  {
    npc: [
      "Did he now. Aye, well... these old bones won't see another winter. There's a thing I've carried near forty years, and it gets heavier every day.",
    ],
  },
  { player: ["What is it?"] },
  {
    npc: [
      "When Roald was a young prince - before the crown, before all of it - I wed him to a common girl. A seamstress. In secret, at his begging.",
    ],
  },
  { player: ["The king was married?"] },
  {
    npc: [
      "For a season. When his father found out, it was struck from every record. The girl was sent away. But there was a child, you see. A son.",
    ],
  },
  { npc: ["The Church buried it. I buried it. Saradomin forgive me, I buried a boy's whole life."] },
  {
    npc: [
      "Wait - that guardsman by the door. He's been watching the church all week. Forget I said anything. Please. Just... forget it.",
    ],
  },
  { exec: (player) => quest.setStage(player, STAGE_CONFESSION) },
];

const GUARD_CONFRONT_STEPS = [
  { npc: ["State your business."] },
  { player: ["You've been watching Father Lawrence. Why?"] },
  { npc: ["I watch who the captain tells me to watch. The king's peace, that's all."] },
  {
    options: [
      {
        text: "The king's peace? Or the king's secrets?",
        next: [{ npc: ["Careful. Men get hurt asking about the palace's business."] }],
      },
      {
        text: "I'm not looking for trouble.",
        next: [{ npc: ["Then stop looking for it."] }],
      },
    ],
  },
  {
    npc: [
      "Look. Whatever the old priest told you, the palace wants it buried and the gangs want it bought. Both gangs are paying coin for old church records - ledgers, birth rolls, anything with a name on it.",
    ],
  },
  { npc: ["Walk careful, adventurer. Some stories get people killed."] },
  { exec: (player) => quest.setStage(player, STAGE_GUARD) },
];

const LAWRENCE_RETURN_STEPS = [
  { player: ["The guard's gone, Father. Tell me the rest."] },
  {
    npc: [
      "Her name was Elspeth. A seamstress from the east end. The boy would be... thirty now. Maybe more. I never learned what became of them.",
    ],
  },
  {
    npc: [
      "If any record survived the burning, it's in the palace library. The royal registry - Reldo keeps the keys, and he'd die before he showed them to you.",
    ],
  },
  {
    npc: [
      "Go careful, child. The Church buried this once. It'll bury it again - and anyone digging.",
    ],
  },
  { exec: (player) => finishQuest(player) },
];

// ---------------------------------------------------------------------------
// Talk-to interception (named hooks run before the generic transcript player)
// ---------------------------------------------------------------------------

function talkToBartender(event) {
  if (event.npcId !== BLUE_MOON_BARTENDER_ID) return false;
  if (quest.getStage(event.player) !== STAGE_NOT_STARTED) return false;
  startDialogue(apiRef, event.player, { npcId: event.npcId }, BARTENDER_START_STEPS);
  return true;
}

function talkToLawrence(event) {
  if (event.npcId !== FATHER_LAWRENCE_ID) return false;
  const stage = quest.getStage(event.player);
  if (stage === STAGE_RUMOR) {
    startDialogue(apiRef, event.player, { npcId: event.npcId }, LAWRENCE_CONFESSION_STEPS);
    return true;
  }
  if (stage === STAGE_GUARD) {
    startDialogue(apiRef, event.player, { npcId: event.npcId }, LAWRENCE_RETURN_STEPS);
    return true;
  }
  return false;
}

function talkToPalaceGuard(event) {
  if (quest.getStage(event.player) !== STAGE_CONFESSION) return false;
  if (!inPalace(npcLocation(event))) return false;
  startDialogue(apiRef, event.player, { npcId: event.npcId }, GUARD_CONFRONT_STEPS);
  return true;
}

function refreshListOnLogin({ player }) {
  refreshQuestList(player);
}

module.exports = {
  name: "TheHeirlessCrown",
  register(api) {
    apiRef = api;
    const { Skill } = api.core;

    quest = registerQuest(api, {
      key: QUEST_KEY,
      name: "The Heirless Crown",
      varpId: VARP_HEIRLESS_CROWN,
      startedValue: STAGE_RUMOR,
      completionValue: STAGE_COMPLETE,
      questPoints: 1,
      xpRewards: [{ skillId: Skill.PRAYER.getIndex(), amount: 500, label: "Prayer" }],
      buildJournal,
      onReward: grantReward,
    });

    api.onNpcInteraction("Bartender", { "Talk-to": talkToBartender });
    api.onNpcInteraction("Father Lawrence", { "Talk-to": talkToLawrence });
    api.onNpcInteraction("Guard", { "Talk-to": talkToPalaceGuard });
    api.onPlayerLogin(refreshListOnLogin);
  },
};
