"use strict";

/**
 * Getting in: the four "anonymous looking door" panels around the Jalsavrah pyramid
 * (ntk_pyramid_door_*_multi), the Guardian mummy and the start of a run.
 *
 * One panel leads to the Guardian mummy's antechamber; the other three to an abandoned one.
 * Which panel changes every 25 minutes (the Wiki's Pyramid Plunder article). The mummy (spawned
 * by npc-spawns.json at 1934,4427, level 3) plays
 * his transcript (first visit, later visits, after the time ran out) and puts the player in
 * room 1 at the transcript's "Player is put in the Pyramid Plunder minigame" steps, or straight
 * away from Start-minigame. A run needs 21 Thieving (unboosted) and Icthlarin's Little Helper
 * started, the quest that opens Sophanem.
 *
 * Wiki: https://oldschool.runescape.wiki/w/Guardian_mummy,
 * https://oldschool.runescape.wiki/w/Transcript:Guardian_mummy
 */

const Common = require("./Common.PyramidPlunder");

/** Transcript actions that start a run (npc-dialogues.json, Guardian mummy). */
const START_STEPS = new Set(["1Goj0e", "UxJQRF", "urxS_u"]);
const VARIANT = {
  first: "standard-dialogue-initial-dialogue",
  later: "standard-dialogue-subsequent-dialogue",
  timedOut: "standard-dialogue-after-time-runs-out",
};
const QUEST_KEY = "ictlharins_little_helper";
/**
 * Captured (rsprox, recordings 545, 549, 552, 1788, 1843, 1857): three pulls a tick apart, synth
 * 1220 with the first and third, `busy` from the second, and the door three ticks after the click,
 * its ntk_outside_doorN_state 2 when it is the way in.
 */
const SEARCH_TICKS = 3;
const PULLS = [0, 1, 2];
const PULL_SOUNDS = [0, 2];
const PANEL_OPEN = 2;

const isGuardian = (npcId) => npcId === Common.ids().npc.guardian;

// --- The outer panels

function searchPanel(event, random = Math.random) {
  const index = Common.ids().outerPanels.indexOf(event.objectId);
  if (index < 0) return false;
  const player = event.player;
  const correct = index === Common.currentEntrance(random);
  const at = player.getLocation();
  const from = { x: at.getX(), y: at.getY(), z: at.getZ() };
  // Walked off, teleported or logged out while searching: the panel stays shut.
  const still = () => {
    const now = player.getLocation();
    return now.getX() === from.x && now.getY() === from.y && now.getZ() === from.z && player.isRegistered?.() !== false;
  };
  const pull = (tick) => {
    player.performAnimation(new (Common.getCore().Animation)(Common.ids().anim.pick));
    if (PULL_SOUNDS.includes(tick)) Common.sound(player, Common.ids().sound.trapWork);
    if (tick === 1) Common.busy(player, true);
  };
  pull(0);
  Common.spam(player, Common.MESSAGES.panelSearch);
  for (const tick of PULLS.slice(1)) Common.later(tick, () => still() && pull(tick));
  Common.later(SEARCH_TICKS, () => {
    if (player.isRegistered?.() !== false) Common.busy(player, false);
    if (!still()) return;
    Common.spam(player, correct ? "You find a door! You open it successfully." : "You find a door! You open it.");
    if (correct) Common.send(player, Common.ids().varbit.outerPanels[index], PANEL_OPEN);
    player.moveTo(Common.location(correct ? Common.DATA.mummyLobby : Common.DATA.abandonedLobby));
  });
  return true;
}

// --- Starting

function questStarted(player) {
  const request = { player, key: QUEST_KEY, started: null };
  Common.getApi().emitCustomEvent("quest:is-started", request);
  return request.started === true;
}

/** The entry checks, then room 1. Returns false (and says why) when the player can't play. */
function tryStart(player, random = Math.random) {
  if (Common.baseThievingLevel(player) < Common.DATA.entryLevel) {
    player.sendMessage(Common.MESSAGES.entryLevel);
    return false;
  }
  if (!questStarted(player)) {
    player.sendMessage(Common.MESSAGES.quest);
    return false;
  }
  Common.startRun(player, random);
  return true;
}

// --- The Guardian mummy

/** First visit, after a timed-out run (played once), or the usual question. */
function variantFor(player) {
  if (player.getAttribute(Common.TIMED_OUT_ATTRIBUTE) === true) {
    player.setAttribute(Common.TIMED_OUT_ATTRIBUTE, false);
    return VARIANT.timedOut;
  }
  return player.getAttribute(Common.PLAYED_ATTRIBUTE) === true ? VARIANT.later : VARIANT.first;
}

function onDialogueVariant(context) {
  return isGuardian(context.npcId) ? variantFor(context.player) : null;
}

function talk({ player, npc, npcId }) {
  Common.getApi().emitCustomEvent("npc-dialogue:start", {
    player, npc, npcId, variant: variantFor(player), handled: false,
  });
}

function startMinigame({ player }) {
  tryStart(player);
}

function onDialogueAction(request) {
  if (!isGuardian(request.npcId) || !START_STEPS.has(request.stepId)) return;
  request.handled = true;
  request.end = true;
  tryStart(request.player);
}

module.exports = function registerEntrance(api) {
  Common.bind(api);
  api.onObjectInteraction("An anonymous looking door", { Search: searchPanel, Enter: searchPanel });
  api.onNpcInteraction("Guardian mummy", { "Talk-to": talk, "Start-minigame": startMinigame });
  api.onNpcDialogueVariant(onDialogueVariant);
  api.onCustomEvent("npc-dialogue:action", onDialogueAction);
};

module.exports._test = { START_STEPS, VARIANT, searchPanel, questStarted, tryStart, variantFor, onDialogueAction };
