"use strict";

/**
 * The Red Axe's Answer (members) — Red Axe vs Consortium, part 3 (finale).
 *
 * The Red Axe Warlord sits in his stronghold under Keldagrim and laughs at
 * the Consortium. The Guard's ask is simple: go down with a party, end him,
 * and settle the company's fate. The Warlord kill is the existing
 * RedAxeStronghold raid — this quest watches the `red-axe:warlord-slain`
 * event the raid emits per participant (shipped deeds, not quest copies).
 *
 * The finale is the Consortium's verdict: crush the remnants, or show
 * mercy to the city that has to keep working the forges. The choice closes
 * the `keldagrim:red-axe-threat` world flag to "broken".
 *
 * Stages (varp 5757): 0 unstarted, 5 the Warlord must die, 10 the Warlord
 * is dead (return to the Guard), 15 complete.
 */

const Store = require("../../kingdoms/KingdomStore");

const VARP_THE_RED_AXES_ANSWER = 5757;

const STAGE_UNSTARTED = 0;
const STAGE_STARTED = 5;
const STAGE_WARLORD_DEAD = 10;
const STAGE_COMPLETE = 15;

const PATH_ATTRIBUTE = "red-axe:q3-path"; // "crush" | "mercy"
const THREAT_ATTRIBUTE = "keldagrim:red-axe-threat";
const INFLUENCE_TASK = "red-axes-answer";

let api = null;
let quest = null;

// --- small helpers (the Words-in-the-Dark dialogue pattern) ----------------------------

function isRealPlayer(p) {
  return p?.isPlayer?.() === true && p?.isPlayerBot?.() !== true;
}

function prompt(player, title, pairs) {
  try {
    return api.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[the-red-axes-answer] prompt failed", error?.message ?? error);
    player.sendMessage("They're momentarily distracted. Try again.");
    return false;
  }
}

function prevQuestComplete(player) {
  try {
    const { getRegisteredQuests } = require("../QuestRuntime");
    const prev = (getRegisteredQuests() || []).find((q) => q.key === "hammers_in_the_dark");
    return !!prev && prev.isComplete(player) === true;
  } catch {
    return false;
  }
}

function addInfluence(player) {
  try {
    api.emitCustomEvent("kingdom:task-completed", {
      player,
      kingdomId: "keldagrim",
      task: INFLUENCE_TASK,
    });
  } catch {
    // best-effort
  }
}

function emitRumor(text) {
  try {
    api.emitCustomEvent("kingdom:rumor", { kingdomId: "keldagrim", text });
  } catch {
    // best-effort
  }
}

// --- the Guard's offer -----------------------------------------------------------------------

function offerDialogue(player) {
  player.sendMessage("The Black Guard's voice drops. \"The Warlord sits in his stronghold under the city and laughs at us. The directors finally agree on one thing — he has to fall.\"");
  prompt(player, "Black Guard", [
    "How do I get to the stronghold?",
    () => {
      player.sendMessage("The Black Guard: \"The tunnel mouth is open to any party with the steel for it. Take friends — the Warlord doesn't fight fair.\"");
      player.sendMessage("The Black Guard: \"End him, and the Consortium decides what's left of the Red Axe. That's the part you get a say in.\"");
      prompt(player, "Black Guard", [
        "The Warlord dies tonight.",
        () => {
          quest.setStage(player, STAGE_STARTED);
          player.sendMessage("The Black Guard: \"Then Keldagrim marches with you. Come back alive — the council's verdict needs your voice.\"");
        },
        "Not yet.",
        () => {},
      ]);
    },
    "Not now.",
    () => {},
  ]);
}

function verdictDialogue(player) {
  player.sendMessage("The Black Guard: \"The Warlord's dead. The stronghold's quiet. Now the directors ask — what do we do with what's left of the Red Axe?\"");
  prompt(player, "The Consortium's verdict", [
    "Crush them. Root out every cell.",
    () => {
      player.setAttribute(PATH_ATTRIBUTE, "crush");
      player.sendMessage("The Black Guard nods slowly. \"Steel, then. The Guard will sweep the tunnels and the quarters. It won't be gentle — but it will be over.\"");
      quest.complete(player);
    },
    "Show mercy. The city needs its workers.",
    () => {
      player.setAttribute(PATH_ATTRIBUTE, "mercy");
      player.sendMessage("The Black Guard is quiet for a long moment. \"Mercy. The forges keep their hands, the tunnels keep their secrets. I hope you're right.\"");
      quest.complete(player);
    },
  ]);
}

function onGuardTalk(event) {
  const { player } = event ?? {};
  if (!isRealPlayer(player)) return false;
  const stage = quest.getStage(player);
  if (stage === STAGE_UNSTARTED) {
    if (!prevQuestComplete(player)) return false;
    event.handled = true;
    offerDialogue(player);
    return undefined;
  }
  if (stage === STAGE_WARLORD_DEAD) {
    event.handled = true;
    verdictDialogue(player);
    return undefined;
  }
  return false;
}

// --- Warlord watcher ------------------------------------------------------------------------------

function onWarlordSlain(event) {
  const { player } = event ?? {};
  if (!isRealPlayer(player)) return;
  if (quest.getStage(player) !== STAGE_STARTED) return;
  quest.setStage(player, STAGE_WARLORD_DEAD);
  player.sendMessage("[Red Axe] The Warlord is dead. Return to the Black Guard in Keldagrim — the Consortium's verdict needs your voice.");
}

// --- journal ------------------------------------------------------------------------------------------

function buildJournal(player) {
  const stage = quest.getStage(player);
  const path = player.getAttribute(PATH_ATTRIBUTE);
  if (stage >= STAGE_COMPLETE) {
    const lines = [
      "<str>The Black Guard sent me to slay the Red Axe Warlord in his</str>",
      "<str>stronghold under Keldagrim. He fell.</str>",
    ];
    if (path === "mercy") {
      lines.push("<str>I argued for mercy. The forges keep their workers;</str>");
      lines.push("<str>the Red Axe is broken, not buried.</str>");
    } else {
      lines.push("<str>I backed the crackdown. The Black Guard swept the</str>");
      lines.push("<str>tunnels and the quarters. The Red Axe is finished.</str>");
    }
    lines.push("", "<col=ff0000>QUEST COMPLETE!</col>");
    return lines;
  }
  if (stage < STAGE_STARTED) {
    return [
      "I can start this quest by speaking to a <col=800000>Black Guard</col>",
      "in Keldagrim.",
      "",
      "I need to have completed <col=800000>Hammers in the Dark</col>.",
    ];
  }
  if (stage === STAGE_STARTED) {
    return [
      "<str>The Warlord laughs at the Consortium from his stronghold.</str>",
      "Slay the <col=800000>Red Axe Warlord</col> in the stronghold under",
      "Keldagrim. Take a party — he doesn't fight fair.",
    ];
  }
  return [
    "<str>The Red Axe Warlord is dead.</str>",
    "Return to the <col=800000>Black Guard</col> for the Consortium's verdict.",
  ];
}

function grantReward(player) {
  const path = player.getAttribute(PATH_ATTRIBUTE);
  const skills = player.getSkillManager();
  if (path === "mercy") {
    skills.addExperiences(api.core.Skill.HITPOINTS, 5000);
    emitRumor("The Consortium answers the Red Axe with restraint — the forges hum on, and the tunnels fall silent.");
    player.sendMessage("[Red Axe] Mercy doesn't earn influence — but the city keeps its workers.");
  } else {
    skills.addExperiences(api.core.Skill.ATTACK, 5000);
    addInfluence(player);
    emitRumor("The Consortium answers the Red Axe with steel — the Black Guard sweeps the tunnels and the quarters.");
    player.sendMessage("[Keldagrim] The Consortium will remember this. (+Keldagrim influence)");
  }
  try {
    Store.setFlag("keldagrim", THREAT_ATTRIBUTE, "broken");
    Store.save();
  } catch {
    // best-effort
  }
}

// --- wiring ---------------------------------------------------------------------------------------------

function registerTheRedAxesAnswer(pluginApi) {
  api = pluginApi;
  const { registerQuest } = require("../QuestRuntime");

  quest = registerQuest(api, {
    key: "the_red_axes_answer",
    name: "The Red Axe's Answer",
    varpId: VARP_THE_RED_AXES_ANSWER,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [
      { skillId: api.core.Skill.ATTACK.getIndex(), amount: 5000, label: "Attack (crush path)" },
      { skillId: api.core.Skill.HITPOINTS.getIndex(), amount: 5000, label: "Hitpoints (mercy path)" },
    ],
    otherRewards: ["Keldagrim influence (crush path)", "The Consortium's verdict"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcInteraction("Black Guard", { "Talk-to": onGuardTalk });
  api.onCustomEvent("red-axe:warlord-slain", onWarlordSlain);

  console.info("[the-red-axes-answer] quest live — the Warlord must fall");
}

module.exports = registerTheRedAxesAnswer;
