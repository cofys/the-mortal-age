"use strict";

/**
 * The Tithe's Ledgers (members) — Myreque rebellion, part 2.
 *
 * The sabotage run. After "Words in the Dark", the fence sends the player to
 * strike at Tithe-Officer Sarev's regime from three sides: burn the tithe
 * records in Canifis, free the Hollow's captive from the sunken hollow, and
 * bleed a vyre patrol in the streets. Three strikes, any order.
 *
 * Every objective is an existing shipped deed — the quest only watches for
 * the events Actors.Myreque, Danger.Myreque and SunkenHollow already emit
 * (plus the two new `myreque:*` event emissions added alongside this
 * questline) and records which strikes have landed in persisted attributes.
 * Completion moves the needle +200 through Rep.addStanding.
 *
 * Stages (varp 5743): 0 unstarted, 5 the three strikes, 40 all three landed
 * (return to the fence), 50 complete.
 */

const Rep = require("../../myreque/Reputation.Myreque");

const VARP_THE_TITHES_LEDGERS = 5743;

const STAGE_UNSTARTED = 0;
const STAGE_STARTED = 5;
const STAGE_STRIKES_DONE = 40;
const STAGE_COMPLETE = 50;

const FLAG_RECORDS = "quest.the_tithes_ledgers.records";
const FLAG_CAPTIVE = "quest.the_tithes_ledgers.captive";
const FLAG_PATROL = "quest.the_tithes_ledgers.patrol";

const COMPLETION_STANDING = 200;

let api = null;
let quest = null;

// --- small helpers ------------------------------------------------------------------

function prompt(player, title, pairs) {
  try {
    return api.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[the-tithes-ledgers] prompt failed", error?.message ?? error);
    player.sendMessage("They're momentarily distracted. Try again.");
    return false;
  }
}

function prevQuestComplete(player) {
  try {
    const { getRegisteredQuests } = require("../QuestRuntime");
    const prev = (getRegisteredQuests() || []).find((q) => q.key === "words_in_the_dark");
    return !!prev && prev.isComplete(player) === true;
  } catch {
    return false;
  }
}

function strikeDone(player, flag) {
  try {
    return player.getAttribute?.(flag) === true;
  } catch {
    return false;
  }
}

function markStrike(player, flag, line) {
  try {
    player.setAttribute(flag, true);
  } catch {
    // best-effort
  }
  player.sendMessage(line);
  if (
    strikeDone(player, FLAG_RECORDS) &&
    strikeDone(player, FLAG_CAPTIVE) &&
    strikeDone(player, FLAG_PATROL) &&
    quest.getStage(player) === STAGE_STARTED
  ) {
    quest.setStage(player, STAGE_STRIKES_DONE);
    player.sendMessage("[Myreque] Three strikes. The Hollow will want to hear this — return to the fence.");
  }
}

// --- the fence's offer --------------------------------------------------------------

function offerDialogue(player, reopen) {
  player.sendMessage("The fence: \"You've got the Hollow's trust. Now we spend it. Sarev's the tithe's hand in Canifis — we cut at him three ways.\"");
  prompt(player, "The fence", [
    "Three ways?",
    () => {
      player.sendMessage("The fence: \"His ledgers. Names, debts, blood-dues — every family in Canifis written down. Burn the chest by his post. You'll need a tinderbox.\"");
      player.sendMessage("The fence: \"The Hollow's captive, rotting in the sunken hollow past the old tunnel. Get them out.\"");
      player.sendMessage("The fence: \"And bleed a vyre patrol in the streets. They hunt ours at a glance now — give them something to fear back.\"");
      prompt(player, "The fence", [
        "Three strikes. I'm in.",
        () => {
          quest.setStage(player, STAGE_STARTED);
          player.sendMessage("[Myreque] Three strikes: burn the tithe records, free the captive, kill a vyre patrol. Any order.");
        },
        "Not yet.",
        () => reopen(),
      ]);
    },
    "Not now.",
    () => reopen(),
  ]);
}

function completeDialogue(player) {
  player.sendMessage("The fence: \"Sarev's ledgers are ash. The captive walks free. A patrol didn't come home.\"");
  player.sendMessage("The fence: \"Lowerniel felt that. The Hollow's done hiding, friend — and it's your doing.\"");
  quest.complete(player);
}

/**
 * The fence's menu entry for this quest (called lazily from
 * Actors.Myreque's showFenceMenu). Returns [label, handler] or null.
 */
function fenceEntry(player) {
  if (!quest || !Rep.isRealPlayer(player)) return null;
  const stage = quest.getStage(player);
  if (stage === STAGE_UNSTARTED) {
    if (!prevQuestComplete(player)) return null;
    if (Rep.myrequeLocked(player)) return null;
    return ["What does the Hollow need next?", (reopen) => offerDialogue(player, reopen)];
  }
  if (stage === STAGE_STRIKES_DONE) {
    return ["The strikes are done.", () => completeDialogue(player)];
  }
  return null;
}

// --- strike watchers ------------------------------------------------------------------

function onRecordsBurned(event) {
  const { player } = event ?? {};
  if (!Rep.isRealPlayer(player)) return;
  if (quest.getStage(player) !== STAGE_STARTED || strikeDone(player, FLAG_RECORDS)) return;
  markStrike(player, FLAG_RECORDS, "[Myreque] The tithe records are ash. Sarev will be asking questions.");
}

function onTaskCompleted(event) {
  const { player, task } = event ?? {};
  if (!Rep.isRealPlayer(player)) return;
  if (quest.getStage(player) !== STAGE_STARTED) return;
  if (task === "sunken-hollow:captive-saved" && !strikeDone(player, FLAG_CAPTIVE)) {
    markStrike(player, FLAG_CAPTIVE, "[Myreque] The captive is free. Two strikes... or three.");
  }
}

function onPatrolSlain(event) {
  const { player } = event ?? {};
  if (!Rep.isRealPlayer(player)) return;
  if (quest.getStage(player) !== STAGE_STARTED || strikeDone(player, FLAG_PATROL)) return;
  markStrike(player, FLAG_PATROL, "[Myreque] A vyre patrol lies broken in the street. Let them fear the dark back.");
}

// --- journal ----------------------------------------------------------------------------

function strikeLine(player, flag, doneText, todoText) {
  return strikeDone(player, flag) ? `<str>${doneText}</str>` : todoText;
}

function buildJournal(player) {
  const stage = quest.getStage(player);
  if (stage >= STAGE_COMPLETE) {
    return [
      "<str>I struck at Sarev's regime three ways: I burned the tithe</str>",
      "<str>records in Canifis, freed the Hollow's captive from the sunken</str>",
      "<str>hollow, and slew a vyre patrol in the streets.</str>",
      "",
      "<col=ff0000>QUEST COMPLETE!</col>",
    ];
  }
  if (stage < STAGE_STARTED) {
    return [
      "I can start this quest by speaking to the <col=800000>fence</col>",
      "in the Mort Myre, south-west of Canifis.",
      "",
      "I need to have completed <col=800000>Words in the Dark</col>.",
    ];
  }
  const lines = ["<str>The fence wants three strikes against Sarev's regime, in any order:</str>"];
  lines.push(
    strikeLine(
      player,
      FLAG_RECORDS,
      "Burned the tithe records.",
      "Burn the <col=800000>tithe records</col> (the chest by Sarev's post in Canifis — bring a <col=800000>tinderbox</col>)."
    )
  );
  lines.push(
    strikeLine(
      player,
      FLAG_CAPTIVE,
      "Freed the Hollow's captive.",
      "Free the <col=800000>Hollow's captive</col> from the <col=800000>sunken hollow</col>, past the old tunnel."
    )
  );
  lines.push(
    strikeLine(
      player,
      FLAG_PATROL,
      "Slew a vyre patrol.",
      "Slay a <col=800000>vyre patrol</col> in the streets of <col=800000>Canifis</col>."
    )
  );
  if (stage >= STAGE_STRIKES_DONE) {
    lines.push("Return to the <col=800000>fence</col>.");
  }
  return lines;
}

function grantReward(player) {
  const skills = player.getSkillManager();
  skills.addExperiences(api.core.Skill.THIEVING, 4000);
  skills.addExperiences(api.core.Skill.AGILITY, 2000);
  Rep.addStanding(player, COMPLETION_STANDING, "quest:the-tithes-ledgers");
  player.sendMessage("[Myreque] The Hollow's debt to you grows. (+200 standing)");
}

// --- wiring -------------------------------------------------------------------------------

function handleLogin({ player }) {
  try {
    const { refreshQuestList } = require("../QuestRuntime");
    refreshQuestList(player);
  } catch {
    // best-effort
  }
}

function registerTheTithesLedgers(pluginApi) {
  api = pluginApi;
  const { registerQuest } = require("../QuestRuntime");

  for (const flag of [FLAG_RECORDS, FLAG_CAPTIVE, FLAG_PATROL]) api.persistAttribute(flag);

  quest = registerQuest(api, {
    key: "the_tithes_ledgers",
    name: "The Tithe's Ledgers",
    varpId: VARP_THE_TITHES_LEDGERS,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: api.core.Skill.THIEVING.getIndex(), amount: 4000, label: "Thieving" },
      { skillId: api.core.Skill.AGILITY.getIndex(), amount: 2000, label: "Agility" },
    ],
    otherRewards: ["Standing with the Myreque", "Sarev's enmity"],
    buildJournal,
    onReward: grantReward,
  });

  api.onCustomEvent("myreque:records-burned", onRecordsBurned);
  api.onCustomEvent("kingdom:task-completed", onTaskCompleted);
  api.onCustomEvent("myreque:patrol-slain", onPatrolSlain);
  api.onPlayerLogin(handleLogin);

  console.info("[the-tithes-ledgers] quest live — three strikes against the tithe");
}

module.exports = registerTheTithesLedgers;
module.exports.fenceEntry = fenceEntry;
