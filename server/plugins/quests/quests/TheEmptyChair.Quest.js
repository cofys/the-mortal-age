"use strict";

/**
 * The Empty Chair (members) — Red Axe vs Consortium, part 1.
 *
 * Keldagrim's political story. The Red Axe company was expelled from the
 * Consortium; its empty council chair is a wound, and chaos dwarves stir in
 * the tunnels below (Forgettable Tale...). The eight remaining companies
 * "vote on everything and agree on nothing" (Arrival rumors), so the Black
 * Guard handles the Red Axe quietly — through an outsider the directors all
 * trust: the one who exposed the tunnel once before.
 *
 * This quest pays off the seeded company-conflict hooks instead of
 * duplicating them: it watches nothing the world doesn't already emit and
 * rewards in XP + Keldagrim influence (no coin minting), moving the needle
 * through the existing kingdom:task-completed track.
 *
 * Stages (varp 5755): 0 unstarted, 5 hired by the Guard, 10 chit recovered
 * (return to the Guard), 15 complete.
 */

const Store = require("../../kingdoms/KingdomStore");

const VARP_THE_EMPTY_CHAIR = 5755;

const STAGE_UNSTARTED = 0;
const STAGE_STARTED = 5;
const STAGE_CHIT_RECOVERED = 10;
const STAGE_COMPLETE = 15;

const STOKER_TILE = { x: 2835, y: 10160, z: 0 }; // among the east-quarter workers
const INFLUENCE_TASK = "empty-chair";

let api = null;
let quest = null;
const stokerByPlayer = new Map(); // player -> npc (owner-only)

// --- small helpers (the Words-in-the-Dark dialogue pattern) ----------------------------

function isRealPlayer(p) {
  return p?.isPlayer?.() === true && p?.isPlayerBot?.() !== true;
}

function prompt(player, title, pairs) {
  try {
    return api.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[the-empty-chair] prompt failed", error?.message ?? error);
    player.sendMessage("They're momentarily distracted. Try again.");
    return false;
  }
}

function isStoker(npc, player) {
  try {
    return !!npc && stokerByPlayer.get(player) === npc;
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
    const prev = (getRegisteredQuests() || []).find((q) => q.key === "forgettable_tale");
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

// --- the missing stoker (owner-only) -----------------------------------------------------

function spawnStoker(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  const existing = stokerByPlayer.get(player);
  if (aliveNpc(existing)) return;
  try {
    const npc = api.spawnNpc({
      id: api.core.NpcIdentifiers.DWARF,
      x: STOKER_TILE.x,
      y: STOKER_TILE.y,
      z: STOKER_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (!npc) return;
    stokerByPlayer.set(player, npc);
    try {
      npc.forceChat("Please... I didn't mean for any of this...");
    } catch {
      // best-effort
    }
  } catch (error) {
    console.warn("[the-empty-chair] stoker spawn failed", error?.message);
  }
}

function despawnStoker(player) {
  const npc = stokerByPlayer.get(player);
  if (npc) {
    try {
      api.removeNpc(npc);
    } catch {
      // best-effort
    }
  }
  stokerByPlayer.delete(player);
}

function onStokerTalk(event) {
  const { player, npc } = event ?? {};
  if (!isRealPlayer(player)) return false;
  if (!isStoker(npc, player)) return false;
  if (quest.getStage(player) !== STAGE_STARTED) return false;
  // Claim the interaction before the engine's default Dwarf dialogue.
  event.handled = true;
  player.sendMessage("The stoker looks up, soot-stained and shaking. \"You... you're not one of them. I can tell.\"");
  prompt(player, "The missing stoker", [
    "Who's 'them'? And why did you run?",
    () => {
      player.sendMessage("The stoker: \"A hooded dwarf. Red axe mark on his chit. Said my family burns if the crucibles keep running clean.\"");
      player.sendMessage("The stoker: \"I fouled the ore carts — just enough to look like accidents. He paid me in these.\" He presses a marked Red Axe chit into your hand.");
      player.sendMessage("The stoker: \"Tell the Guard. And tell them I'm sorry. I'm done — Keldagrim will never see me again.\"");
      despawnStoker(player);
      quest.setStage(player, STAGE_CHIT_RECOVERED);
      player.sendMessage("[Red Axe] Chit recovered. Take it to the Black Guard in Keldagrim.");
    },
    "Stay hidden. I'll tell no one.",
    () => {
      player.sendMessage("The stoker nods shakily and melts back among the workers.");
    },
  ]);
  return undefined; // our stoker; event.handled is set above
}

// --- the Black Guard's offer ---------------------------------------------------------------

function offerDialogue(player) {
  player.sendMessage("The Black Guard glances at the empty council chair across the hall. \"The Red Axe's chair. It's been empty since they were expelled — and the tunnels below aren't as empty as the directors pretend.\"");
  prompt(player, "Black Guard", [
    "What's the work?",
    () => {
      player.sendMessage("The Black Guard: \"Furnace output's been fouled for weeks. The eight companies blame each other — they agree on nothing.\"");
      player.sendMessage("The Black Guard: \"But one of our mine stokers vanished the night before it started. A frightened dwarf among the east-quarter workers. Find him — find out who got to him.\"");
      prompt(player, "Black Guard", [
        "I'll find your stoker.",
        () => {
          quest.setStage(player, STAGE_STARTED);
          spawnStoker(player);
          player.sendMessage("The Black Guard: \"Quietly. If the Red Axe hears the Guard asking questions, the stoker's a dead dwarf.\"");
        },
        "Not yet.",
        () => {},
      ]);
    },
    "Not now.",
    () => {},
  ]);
}

function completeDialogue(player) {
  player.sendMessage("The Black Guard turns the chit over, jaw tight. \"The Red Axe's mark. They're inside the city — not just the tunnels.\"");
  player.sendMessage("The Black Guard: \"The directors will argue about this for a month. We'll act tonight. You did the Consortium a service the council can't admit it needs.\"");
  quest.complete(player);
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
  if (stage === STAGE_CHIT_RECOVERED) {
    event.handled = true;
    completeDialogue(player);
    return undefined;
  }
  return false;
}

// --- journal ---------------------------------------------------------------------------------

function buildJournal(player) {
  const stage = quest.getStage(player);
  if (stage >= STAGE_COMPLETE) {
    return [
      "<str>The Black Guard asked me to find their missing mine stoker</str>",
      "<str>in Keldagrim. He'd been threatened by a Red Axe agent and was</str>",
      "<str>fouling the furnace ore carts. I recovered the marked chit</str>",
      "<str>and brought it to the Guard.</str>",
      "",
      "<col=ff0000>QUEST COMPLETE!</col>",
    ];
  }
  if (stage < STAGE_STARTED) {
    return [
      "I can start this quest by speaking to a <col=800000>Black Guard</col>",
      "in Keldagrim.",
      "",
      "I need to have completed <col=800000>Forgettable Tale...</col>.",
    ];
  }
  const lines = ["<str>The Black Guard suspects Red Axe sabotage in the forges.</str>"];
  lines.push(
    stage >= STAGE_CHIT_RECOVERED
      ? "<str>Recovered the marked Red Axe chit from the stoker.</str>"
      : "Find the <col=800000>missing stoker</col> among the east-quarter workers."
  );
  if (stage >= STAGE_CHIT_RECOVERED) {
    lines.push("Return to the <col=800000>Black Guard</col> with the chit.");
  }
  return lines;
}

function grantReward(player) {
  const skills = player.getSkillManager();
  skills.addExperiences(api.core.Skill.SMITHING, 2000);
  addInfluence(player);
  emitRumor("The Guard moves quietly in Keldagrim: furnace sabotage, a Red Axe chit, and an outsider asking questions the directors won't.");
  player.sendMessage("[Keldagrim] The Consortium will remember this. (+Keldagrim influence)");
}

// --- wiring --------------------------------------------------------------------------------------

function handleLogin({ player }) {
  if (quest.getStage(player) === STAGE_STARTED) spawnStoker(player);
  else despawnStoker(player);
}

function handleLogout({ player }) {
  if (player) despawnStoker(player);
}

function registerTheEmptyChair(pluginApi) {
  api = pluginApi;
  const { registerQuest } = require("../QuestRuntime");

  quest = registerQuest(api, {
    key: "the_empty_chair",
    name: "The Empty Chair",
    varpId: VARP_THE_EMPTY_CHAIR,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 1,
    xpRewards: [{ skillId: api.core.Skill.SMITHING.getIndex(), amount: 2000, label: "Smithing" }],
    otherRewards: ["Keldagrim influence", "The Consortium's quiet gratitude"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcInteraction("Black Guard", { "Talk-to": onGuardTalk });
  api.onNpcInteraction("Dwarf", { "Talk-to": onStokerTalk });
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);

  console.info("[the-empty-chair] quest live — the Red Axe's chair sits empty in Keldagrim");
}

module.exports = registerTheEmptyChair;
