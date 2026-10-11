"use strict";

/**
 * Hammers in the Dark (members) — Red Axe vs Consortium, part 2.
 *
 * The chit from The Empty Chair bears a recruiter's mark: the Red Axe is
 * buying off ex-company miners inside Keldagrim. The Black Guard can't move
 * without proof — the directors would call it a provocation — so the
 * outsider meets the recruiter as a sympathizer, then chooses: hand him to
 * the Guard, or warn him off and keep the city's peace.
 *
 * The choice is the quest's heart (like the Hollow's oath): report him and
 * earn the Consortium's trust, or show mercy and earn nothing but a rumor.
 * Either way the cell goes quiet.
 *
 * Stages (varp 5756): 0 unstarted, 5 met the recruiter, 10 reported to the
 * Guard (return), 15 complete; 20 warned him off (return to the Guard),
 * 25 complete.
 */

const Store = require("../../kingdoms/KingdomStore");

const VARP_HAMMERS_IN_THE_DARK = 5756;

const STAGE_UNSTARTED = 0;
const STAGE_STARTED = 5;
const STAGE_REPORTED = 10;
const STAGE_COMPLETE = 15;
const STAGE_WARNED = 20;
const STAGE_WARNED_RETURN = 25;

const PATH_ATTRIBUTE = "red-axe:q2-path"; // "consortium" | "mercy"

const RECRUITER_TILE = { x: 2866, y: 10126, z: 0 }; // among the east-quarter workers
const INFLUENCE_TASK = "hammers-in-the-dark";

let api = null;
let quest = null;
const recruiterByPlayer = new Map(); // player -> npc (owner-only)

// --- small helpers (the Words-in-the-Dark dialogue pattern) ----------------------------

function isRealPlayer(p) {
  return p?.isPlayer?.() === true && p?.isPlayerBot?.() !== true;
}

function prompt(player, title, pairs) {
  try {
    return api.sendMultiChatboxPrompt(player, title, ...pairs);
  } catch (error) {
    console.warn("[hammers-in-the-dark] prompt failed", error?.message ?? error);
    player.sendMessage("They're momentarily distracted. Try again.");
    return false;
  }
}

function isRecruiter(npc, player) {
  try {
    return !!npc && recruiterByPlayer.get(player) === npc;
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
    const prev = (getRegisteredQuests() || []).find((q) => q.key === "the_empty_chair");
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

// --- the recruiter (owner-only) ----------------------------------------------------------

function spawnRecruiter(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  const existing = recruiterByPlayer.get(player);
  if (aliveNpc(existing)) return;
  try {
    const npc = api.spawnNpc({
      id: api.core.NpcIdentifiers.DWARF,
      x: RECRUITER_TILE.x,
      y: RECRUITER_TILE.y,
      z: RECRUITER_TILE.z,
      wanderRadius: 0,
      owner: player,
      ownerOnly: true,
    });
    if (!npc) return;
    recruiterByPlayer.set(player, npc);
    try {
      npc.forceChat("Psst. Over here, friend of the Axe...");
    } catch {
      // best-effort
    }
  } catch (error) {
    console.warn("[hammers-in-the-dark] recruiter spawn failed", error?.message);
  }
}

function despawnRecruiter(player) {
  const npc = recruiterByPlayer.get(player);
  if (npc) {
    try {
      api.removeNpc(npc);
    } catch {
      // best-effort
    }
  }
  recruiterByPlayer.delete(player);
}

function onRecruiterTalk(event) {
  const { player, npc } = event ?? {};
  if (!isRealPlayer(player)) return false;
  if (!isRecruiter(npc, player)) return false;
  if (quest.getStage(player) !== STAGE_STARTED) return false;
  // Claim the interaction before the engine's default Dwarf dialogue.
  event.handled = true;
  player.sendMessage("The dwarf's eyes light up. \"A new face! The Axe grows, friend. The Consortium threw us out — but the tunnels remember. Are you with us?\"");
  prompt(player, "Red Axe recruiter", [
    "Show me the mark. Who do you answer to?",
    () => {
      player.sendMessage("The recruiter flashes a red-axe chit. \"The Warlord, under the city. Join us — the forges will burn for the Axe again.\"");
      prompt(player, "Red Axe recruiter", [
        "I'll take that chit — for the Black Guard.",
        () => {
          player.setAttribute(PATH_ATTRIBUTE, "consortium");
          despawnRecruiter(player);
          quest.setStage(player, STAGE_REPORTED);
          player.sendMessage("You seize the chit. The recruiter's grin dies. \"You... you were never one of us.\" Guards are already coming — you made sure of that.");
          player.sendMessage("[Red Axe] The recruiter is in chains. Return to the Black Guard.");
        },
        "Run. If the Guard finds you here, they'll hang you.",
        () => {
          player.setAttribute(PATH_ATTRIBUTE, "mercy");
          despawnRecruiter(player);
          quest.setStage(player, STAGE_WARNED);
          player.sendMessage("The recruiter stares, then nods once — and is gone into the crowd. The cell will scatter. The city won't burn tonight.");
          player.sendMessage("[Red Axe] The recruiter fled. Tell the Black Guard the trail went cold.");
        },
      ]);
    },
    "I was never with you.",
    () => {
      player.sendMessage("The recruiter's smile fades. \"Then walk away, friend. The Axe forgets nothing.\"");
    },
  ]);
  return undefined; // our recruiter; event.handled is set above
}

// --- the Black Guard's offer -----------------------------------------------------------------

function offerDialogue(player) {
  player.sendMessage("The Black Guard studies the chit you brought. \"This mark — it's a recruiter's seal. The Red Axe is buying miners back, right under the directors' noses.\"");
  prompt(player, "Black Guard", [
    "How do we catch him?",
    () => {
      player.sendMessage("The Black Guard: \"He thinks you're one of his. Go as a sympathizer. Get his seal — then decide what kind of justice Keldagrim gets tonight.\"");
      prompt(player, "Black Guard", [
        "I'll play the sympathizer.",
        () => {
          quest.setStage(player, STAGE_STARTED);
          spawnRecruiter(player);
          player.sendMessage("The Black Guard: \"East quarter, among the workers. And whatever you choose — the Guard will back your word.\"");
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
  const path = player.getAttribute(PATH_ATTRIBUTE);
  if (path === "mercy") {
    player.sendMessage("The Black Guard frowns. \"The trail went cold? Pity. But the cell's gone quiet — maybe quieter than chains would have made it.\"");
    player.sendMessage("The Black Guard: \"I don't know what you did out there, and I won't ask. Keldagrim owes you anyway.\"");
  } else {
    player.sendMessage("The Black Guard takes the recruiter's seal. \"In chains by dawn. The directors will never admit it happened — but the Guard knows who did it.\"");
    player.sendMessage("The Black Guard: \"You chose the Consortium tonight. It won't forget.\"");
  }
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
  if (stage === STAGE_REPORTED || stage === STAGE_WARNED) {
    event.handled = true;
    completeDialogue(player);
    return undefined;
  }
  return false;
}

// --- journal -----------------------------------------------------------------------------------

function buildJournal(player) {
  const stage = quest.getStage(player);
  const path = player.getAttribute(PATH_ATTRIBUTE);
  if (stage === STAGE_COMPLETE || stage === STAGE_WARNED_RETURN) {
    const lines = [
      "<str>The Black Guard had me meet a Red Axe recruiter in the east</str>",
      "<str>quarter, posing as a sympathizer.</str>",
    ];
    if (path === "mercy") {
      lines.push("<str>I warned him off instead of handing him to the Guard.</str>");
      lines.push("<str>The cell scattered. The city stays quiet — for now.</str>");
    } else {
      lines.push("<str>I took his seal and handed him to the Black Guard.</str>");
      lines.push("<str>He's in chains. The Consortium won't forget.</str>");
    }
    lines.push("", "<col=ff0000>QUEST COMPLETE!</col>");
    return lines;
  }
  if (stage < STAGE_STARTED) {
    return [
      "I can start this quest by speaking to a <col=800000>Black Guard</col>",
      "in Keldagrim.",
      "",
      "I need to have completed <col=800000>The Empty Chair</col>.",
    ];
  }
  const lines = ["<str>Meet the Red Axe recruiter in the east quarter, as a sympathizer.</str>"];
  if (stage === STAGE_STARTED) {
    lines.push("Talk to the <col=800000>recruiter</col> among the east-quarter workers.");
  }
  if (stage === STAGE_REPORTED) {
    lines.push("<str>Seized the recruiter's seal. He's in chains.</str>");
    lines.push("Return to the <col=800000>Black Guard</col>.");
  }
  if (stage === STAGE_WARNED) {
    lines.push("<str>Warned the recruiter off. The cell scattered.</str>");
    lines.push("Tell the <col=800000>Black Guard</col> the trail went cold.");
  }
  return lines;
}

function grantReward(player) {
  const path = player.getAttribute(PATH_ATTRIBUTE);
  const skills = player.getSkillManager();
  if (path === "mercy") {
    skills.addExperiences(api.core.Skill.AGILITY, 3000);
    emitRumor("A Red Axe cell in Keldagrim has gone silent — scattered, not broken. The Guard is watching the tunnels.");
    player.sendMessage("[Red Axe] The city stays quiet. No influence earned — mercy doesn't pay in coin or favor.");
  } else {
    skills.addExperiences(api.core.Skill.THIEVING, 3000);
    addInfluence(player);
    emitRumor("The Black Guard has chained a Red Axe recruiter in Keldagrim. The Consortium's enemies are quieter tonight.");
    player.sendMessage("[Keldagrim] The Consortium will remember this. (+Keldagrim influence)");
  }
}

// --- wiring ---------------------------------------------------------------------------------------

function handleLogin({ player }) {
  if (quest.getStage(player) === STAGE_STARTED) spawnRecruiter(player);
  else despawnRecruiter(player);
}

function handleLogout({ player }) {
  if (player) despawnRecruiter(player);
}

function registerHammersInTheDark(pluginApi) {
  api = pluginApi;
  const { registerQuest } = require("../QuestRuntime");

  quest = registerQuest(api, {
    key: "hammers_in_the_dark",
    name: "Hammers in the Dark",
    varpId: VARP_HAMMERS_IN_THE_DARK,
    startedValue: STAGE_STARTED,
    completionValue: STAGE_COMPLETE,
    questPoints: 2,
    xpRewards: [
      { skillId: api.core.Skill.THIEVING.getIndex(), amount: 3000, label: "Thieving (Consortium path)" },
      { skillId: api.core.Skill.AGILITY.getIndex(), amount: 3000, label: "Agility (mercy path)" },
    ],
    otherRewards: ["Keldagrim influence (Consortium path)", "The Consortium's trust — or the Red Axe's debt"],
    buildJournal,
    onReward: grantReward,
  });

  api.onNpcInteraction("Black Guard", { "Talk-to": onGuardTalk });
  api.onNpcInteraction("Dwarf", { "Talk-to": onRecruiterTalk });
  api.onPlayerLogin(handleLogin);
  api.onPlayerLogout(handleLogout);

  console.info("[hammers-in-the-dark] quest live — the Red Axe is recruiting in Keldagrim");
}

module.exports = registerHammersInTheDark;
