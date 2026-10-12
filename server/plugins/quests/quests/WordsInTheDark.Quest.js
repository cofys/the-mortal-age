"use strict";

/**
 * Words in the Dark (members) — Myreque rebellion, part 1.
 *
 * The on-ramp to the rebellion. After "In Search of the Myreque", the fence
 * in the Mort Myre needs a runner the patrols don't know yet: carry his
 * sealed word to Polmafi, leave supplies in the Hollow's caches, and get an
 * exposed runner to the old tunnel before the patrols take them.
 *
 * This quest pays off the shipped Myreque track instead of duplicating it:
 * the word run and the cache deliveries are the existing Actors.Myreque
 * deeds (they award their normal standing), and the quest listens for the
 * `myreque:*` events Actors/Danger emit. Completion moves the needle +150
 * through Rep.addStanding, so tier crossings fire their rumors and gossip.
 *
 * Stages (varp 5741): 0 unstarted, 5 word run accepted, 10 word delivered,
 * 20 cache supplied (runner exposed), 30 runner safe (return to the fence),
 * 40 complete.
 */

const Rep = require("../../myreque/Reputation.Myreque");

const VARP_WORDS_IN_THE_DARK = 5741;

const STAGE_UNSTARTED = 0;
const STAGE_STARTED = 5;
const STAGE_WORD_DELIVERED = 10;
const STAGE_CACHE_SUPPLIED = 20;
const STAGE_RUNNER_SAFE = 30;
const STAGE_COMPLETE = 40;

const RUNNER_TILE = { x: 3505, y: 3432, z: 0 }; // south of the old tunnel
const COMPLETION_STANDING = 150;

let api = null;
let quest = null;
const runnerByPlayer = new Map(); // player -> npc (owner-only)

// --- small helpers (the Actors.Myreque dialogue pattern) --------------------------

function prompt(player, title, pairs) {
  try {
    return api.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[words-in-the-dark] prompt failed", error?.message ?? error);
    player.sendMessage("They're momentarily distracted. Try again.");
    return false;
  }
}

function isRunner(npc, player) {
  try {
    return !!npc && runnerByPlayer.get(player) === npc;
  } catch {
    return false;
  }
}

function aliveNpc(npc) {
  try {
    return !!npc && npc.isDead?.() !== true && npc.isDying?.() !== true;
  } catch {
    return false;
  }
}

function prevQuestComplete(player) {
  try {
    const { getRegisteredQuests } = require("../QuestRuntime");
    const prev = (getRegisteredQuests() || []).find((q) => q.key === "in_search_of_the_myreque");
    return !!prev && prev.isComplete(player) === true;
  } catch {
    return false;
  }
}

// --- the exposed runner (owner-only) ------------------------------------------------

function spawnRunner(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  const existing = runnerByPlayer.get(player);
  if (aliveNpc(existing)) return;
  try {
    const npc = api.spawnNpc({
      id: api.core.NpcIdentifiers.MAN,
      x: RUNNER_TILE.x,
      y: RUNNER_TILE.y,
      z: RUNNER_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (!npc) return;
    runnerByPlayer.set(player, npc);
    try {
      npc.forceChat("Please... the patrols are everywhere...");
    } catch {
      // best-effort
    }
  } catch (error) {
    console.warn("[words-in-the-dark] runner spawn failed", error?.message);
  }
}

function despawnRunner(player) {
  const npc = runnerByPlayer.get(player);
  if (npc) {
    try {
      api.removeNpc(npc);
    } catch {
      // best-effort
    }
  }
  runnerByPlayer.delete(player);
}

function onRunnerTalk(event) {
  const { player, npc } = event ?? {};
  if (!Rep.isRealPlayer(player)) return false;
  if (!isRunner(npc, player)) return false;
  if (quest.getStage(player) !== STAGE_CACHE_SUPPLIED) return false;
  // Claim the interaction: Actors.Myreque's Man handler runs first (alphabetical
  // plugin load) and returns false for our owner-only runner, but without
  // event.handled the engine's default Man Talk-to dialogue would fire after
  // our quest prompt.
  event.handled = true;
  player.sendMessage("The runner looks up at you, wild-eyed. \"Please... the patrols are everywhere...\"");
  prompt(player, "The runner", [
    "Get to the tunnel. Now.",
    () => {
      despawnRunner(player);
      quest.setStage(player, STAGE_RUNNER_SAFE);
      player.sendMessage("You pull the runner into the reeds and point them at the old tunnel. \"The Hollow remembers,\" they breathe, and they're gone.");
      player.sendMessage("The Hollow will want to hear this. Return to the fence.");
    },
    "Stay hidden here.",
    () => {
      player.sendMessage("The runner nods shakily and sinks back into the reeds.");
    },
  ]);
  return undefined; // our runner; event.handled is set above
}

// --- the fence's offer --------------------------------------------------------------

function offerDialogue(player, reopen) {
  player.sendMessage("The fence: \"You're the one Polmafi vouched for. The Hollow's moving, and we need legs the patrols don't know yet.\"");
  prompt(player, "The fence", [
    "What's the work?",
    () => {
      player.sendMessage("The fence: \"Three things. Carry my words to Polmafi at the old tunnel — sealed, don't read them.\"");
      player.sendMessage("The fence: \"Leave supplies in the caches by the tunnel — bread, swamp paste, planks, whatever you can spare.\"");
      player.sendMessage("The fence: \"And there's a runner gone to ground south of here. Get them to the tunnel before the patrols do.\"");
      prompt(player, "The fence", [
        "I'm in.",
        () => {
          let wordGiven = false;
          try {
            const Actors = require("../../myreque/Actors.Myreque");
            wordGiven = Actors.carryWordQuest ? Actors.carryWordQuest(player) !== false : false;
          } catch {
            wordGiven = false; // the track works without the quest handoff
          }
          if (!wordGiven) {
            reopen();
            return;
          }
          quest.setStage(player, STAGE_STARTED);
          player.sendMessage("The fence presses a sealed note into your hand. \"Polmafi, by the old tunnel. Walk like you've somewhere to be.\"");
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
  player.sendMessage("The fence: \"The runner's in the Hollow. The word's with Polmafi. The caches are filling.\"");
  player.sendMessage("The fence: \"You did the Hollow's work tonight. It won't forget.\"");
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
    return ["The Hollow needs a runner?", (reopen) => offerDialogue(player, reopen)];
  }
  if (stage === STAGE_RUNNER_SAFE) {
    return ["It's done. The runner's safe.", () => completeDialogue(player)];
  }
  return null;
}

// --- quest events ---------------------------------------------------------------------

function onWordDelivered(event) {
  const { player } = event ?? {};
  if (!Rep.isRealPlayer(player)) return;
  if (quest.getStage(player) !== STAGE_STARTED) return;
  quest.setStage(player, STAGE_WORD_DELIVERED);
  player.sendMessage("[Myreque] Word delivered. Now the caches by the old tunnel — bread, swamp paste, planks.");
}

function onSupplyDelivered(event) {
  const { player } = event ?? {};
  if (!Rep.isRealPlayer(player)) return;
  if (quest.getStage(player) !== STAGE_WORD_DELIVERED) return;
  quest.setStage(player, STAGE_CACHE_SUPPLIED);
  spawnRunner(player);
  player.sendMessage("[Myreque] Supplies cached. A ragged runner is gone to ground south of the tunnel — get them to safety before the patrols do.");
}

// --- journal ----------------------------------------------------------------------------

function buildJournal(player) {
  const stage = quest.getStage(player);
  if (stage >= STAGE_COMPLETE) {
    return [
      "<str>I ran the Hollow's errands in the Mort Myre: I carried the</str>",
      "<str>fence's sealed word to Polmafi, left supplies in the caches,</str>",
      "<str>and got an exposed runner to the old tunnel.</str>",
      "",
      "<col=ff0000>QUEST COMPLETE!</col>",
    ];
  }
  if (stage < STAGE_STARTED) {
    return [
      "I can start this quest by speaking to the <col=800000>fence</col>",
      "in the Mort Myre, south-west of Canifis.",
      "",
      "I need to have completed <col=800000>In Search of the Myreque</col>.",
    ];
  }
  const lines = ["<str>The fence in the Mort Myre needs a runner the patrols don't know.</str>"];
  lines.push(
    stage >= STAGE_WORD_DELIVERED
      ? "<str>Carried the fence's sealed word to Polmafi.</str>"
      : "Carry the fence's <col=800000>sealed word</col> to <col=800000>Polmafi</col> at the old tunnel."
  );
  if (stage >= STAGE_WORD_DELIVERED) {
    lines.push(
      stage >= STAGE_CACHE_SUPPLIED
        ? "<str>Left supplies in a cache by the old tunnel.</str>"
        : "Leave <col=800000>supplies</col> (bread, swamp paste or planks) in a <col=800000>cache</col> by the old tunnel."
    );
  }
  if (stage >= STAGE_CACHE_SUPPLIED) {
    lines.push(
      stage >= STAGE_RUNNER_SAFE
        ? "<str>Got the exposed runner to the tunnel.</str>"
        : "Find the <col=800000>exposed runner</col> south of the tunnel and get them to safety."
    );
  }
  if (stage >= STAGE_RUNNER_SAFE) {
    lines.push("Return to the <col=800000>fence</col>.");
  }
  return lines;
}

function grantReward(player) {
  const skills = player.getSkillManager();
  skills.addExperiences(api.core.Skill.AGILITY, 2000);
  skills.addExperiences(api.core.Skill.THIEVING, 2000);
  Rep.addStanding(player, COMPLETION_STANDING, "quest:words-in-the-dark");
  player.sendMessage("[Myreque] The Hollow trusts you a little more. (+150 standing)");
}

// --- wiring -------------------------------------------------------------------------------

function handleLogin({ player }) {
  handleLogin.refresh(player);
  if (quest.getStage(player) === STAGE_CACHE_SUPPLIED) spawnRunner(player);
  else despawnRunner(player);
}

function handleLogout({ player }) {
  if (player) despawnRunner(player);
}

function registerWordsInTheDark(pluginApi) {
  api = pluginApi;
  const { registerQuest, refreshQuestList } = require("../QuestRuntime");
  handleLogin.refresh = refreshQuestList;

  quest = registerQuest(api, {
    key: "words_in_the_dark",
    name: "Words in the Dark",
    varpId: VARP_WORDS_IN_THE_DARK,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [
      { skillId: api.core.Skill.AGILITY.getIndex(), amount: 2000, label: "Agility" },
      { skillId: api.core.Skill.THIEVING.getIndex(), amount: 2000, label: "Thieving" },
    ],
    otherRewards: ["Standing with the Myreque", "The Hollow's trust"],
    buildJournal,
    onReward: grantReward,
  });

  // Registered after Actors' and Danger's "Man"/"Talk-to" hooks; both return
  // false for our owner-only runner, so this runs. Identity-checked, so the
  // fence, Sarev and the courier are never affected.
  api.onNpcInteraction("Man", { "Talk-to": onRunnerTalk });
  api.onCustomEvent("myreque:word-delivered", onWordDelivered);
  api.onCustomEvent("myreque:supply-delivered", onSupplyDelivered);
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);

  console.info("[words-in-the-dark] quest live — the Hollow needs a runner");
}

module.exports = registerWordsInTheDark;
module.exports.fenceEntry = fenceEntry;
