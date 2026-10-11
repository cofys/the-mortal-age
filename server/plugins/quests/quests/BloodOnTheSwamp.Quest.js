"use strict";

/**
 * Blood on the Swamp (members) — Myreque rebellion, part 3 (finale).
 *
 * The rebellion's payoff. After "The Tithe's Ledgers", the fence names the
 * price of the Hollow's freedom: Vost the Tithe-Taker, Lowerniel's hound in
 * the sunken hollow, dead by the player's hand. The kill is the existing
 * SunkenHollow raid — this quest watches for the `sunken-hollow:vost`
 * task-completed event the raid already emits (which the reputation track
 * already honors with +100 standing) and brings the player home for the
 * oath: swear to the Hollow and be counted among the Sworn, or keep your
 * blade free.
 *
 * A full run of the trilogy (deeds + quest completions) carries a player
 * from Unremarkable to Sworn of the Hollow — the rebellion arc pays off in
 * the track's own currency.
 *
 * Stages (varp 5744): 0 unstarted, 5 Vost must die, 10 Vost is dead (return
 * to the fence), 20 complete.
 */

const Rep = require("../../myreque/Reputation.Myreque");

const VARP_BLOOD_ON_THE_SWAMP = 5744;

const STAGE_UNSTARTED = 0;
const STAGE_STARTED = 5;
const STAGE_VOST_DEAD = 10;
const STAGE_COMPLETE = 20;

const SWORN_AT = 600;

let api = null;
let quest = null;

// --- small helpers ------------------------------------------------------------------

function prompt(player, title, pairs) {
  try {
    return api.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[blood-on-the-swamp] prompt failed", error?.message ?? error);
    player.sendMessage("They're momentarily distracted. Try again.");
    return false;
  }
}

function prevQuestComplete(player) {
  try {
    const { getRegisteredQuests } = require("../QuestRuntime");
    const prev = (getRegisteredQuests() || []).find((q) => q.key === "the_tithes_ledgers");
    return !!prev && prev.isComplete(player) === true;
  } catch {
    return false;
  }
}

// --- the fence's offer --------------------------------------------------------------

function offerDialogue(player, reopen) {
  player.sendMessage("The fence is quiet for a long moment. \"One name left. Vost. The Tithe-Taker.\"");
  prompt(player, "The fence", [
    "Who is Vost?",
    () => {
      player.sendMessage("The fence: \"Lowerniel's hound. He's bled this swamp for a decade — the purge wears his face. He dens in the sunken hollow, past the old tunnel.\"");
      player.sendMessage("The fence: \"End him, and the purge falters. The Hollow stops hiding. That's the price of everything we've built.\"");
      prompt(player, "The fence", [
        "Vost dies.",
        () => {
          quest.setStage(player, STAGE_STARTED);
          player.sendMessage("[Myreque] Kill Vost the Tithe-Taker in the sunken hollow, past the old tunnel.");
        },
        "Not yet.",
        () => reopen(),
      ]);
    },
    "Not now.",
    () => reopen(),
  ]);
}

function oathDialogue(player) {
  player.sendMessage("The fence: \"Vost is dead. The swamp already feels it.\" He holds out the worn silver sickle.");
  prompt(player, "The fence", [
    "Swear the oath.",
    () => {
      const current = Rep.getStanding(player);
      const delta = current < SWORN_AT ? SWORN_AT - current : 50;
      Rep.addStanding(player, delta, "oath-sworn");
      Rep.markDeed(
        player,
        `${player.getUsername?.() ?? "Someone"} swore the Hollow's oath — Sworn of the Hollow.`,
        "Word in the swamp: another blade has sworn to the Hollow. Lowerniel will have their head."
      );
      player.sendMessage("You kneel in the mud and speak the words. The Hollow has you now — all of you.");
      quest.complete(player);
    },
    "The Hollow has my blade, not my oath.",
    () => {
      Rep.addStanding(player, 100, "quest:blood-on-the-swamp");
      player.sendMessage("The fence nods slowly. \"Free blades cut deepest. The Hollow won't forget — oath or no.\"");
      quest.complete(player);
    },
  ]);
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
    return ["It's time to talk about Vost.", (reopen) => offerDialogue(player, reopen)];
  }
  if (stage === STAGE_VOST_DEAD) {
    return ["Vost is dead.", () => oathDialogue(player)];
  }
  return null;
}

// --- Vost watcher -----------------------------------------------------------------------

function onTaskCompleted(event) {
  const { player, task } = event ?? {};
  if (!Rep.isRealPlayer(player)) return;
  if (task !== "sunken-hollow:vost") return;
  if (quest.getStage(player) !== STAGE_STARTED) return;
  quest.setStage(player, STAGE_VOST_DEAD);
  player.sendMessage("[Myreque] Vost the Tithe-Taker is dead. The purge falters. Return to the fence.");
}

// --- journal ----------------------------------------------------------------------------

function buildJournal(player) {
  const stage = quest.getStage(player);
  if (stage >= STAGE_COMPLETE) {
    return [
      "<str>Vost the Tithe-Taker died in the sunken hollow, and the</str>",
      "<str>purge faltered. I stood before the fence and chose what</str>",
      "<str>the Hollow would have of me.</str>",
      "",
      "<col=ff0000>QUEST COMPLETE!</col>",
    ];
  }
  if (stage < STAGE_STARTED) {
    return [
      "I can start this quest by speaking to the <col=800000>fence</col>",
      "in the Mort Myre, south-west of Canifis.",
      "",
      "I need to have completed <col=800000>The Tithe's Ledgers</col>.",
    ];
  }
  const lines = ["<str>Vost the Tithe-Taker must die.</str>"];
  lines.push(
    stage >= STAGE_VOST_DEAD
      ? "<str>Slew Vost in the sunken hollow.</str>"
      : "Kill <col=800000>Vost the Tithe-Taker</col> in the <col=800000>sunken hollow</col>, past the old tunnel."
  );
  if (stage >= STAGE_VOST_DEAD) {
    lines.push("Return to the <col=800000>fence</col>.");
  }
  return lines;
}

function grantReward(player) {
  const skills = player.getSkillManager();
  skills.addExperiences(api.core.Skill.ATTACK, 4000);
  skills.addExperiences(api.core.Skill.STRENGTH, 4000);
  skills.addExperiences(api.core.Skill.HITPOINTS, 2000);
  // Standing is awarded by the oath choice, not here — the choice is the reward.
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

function registerBloodOnTheSwamp(pluginApi) {
  api = pluginApi;
  const { registerQuest } = require("../QuestRuntime");

  quest = registerQuest(api, {
    key: "blood_on_the_swamp",
    name: "Blood on the Swamp",
    varpId: VARP_BLOOD_ON_THE_SWAMP,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [
      { skillId: api.core.Skill.ATTACK.getIndex(), amount: 4000, label: "Attack" },
      { skillId: api.core.Skill.STRENGTH.getIndex(), amount: 4000, label: "Strength" },
      { skillId: api.core.Skill.HITPOINTS.getIndex(), amount: 2000, label: "Hitpoints" },
    ],
    otherRewards: ["The Hollow's oath", "Standing with the Myreque"],
    buildJournal,
    onReward: grantReward,
  });

  api.onCustomEvent("kingdom:task-completed", onTaskCompleted);
  api.onPlayerLogin(handleLogin);

  console.info("[blood-on-the-swamp] quest live — Vost must die");
}

module.exports = registerBloodOnTheSwamp;
module.exports.fenceEntry = fenceEntry;
