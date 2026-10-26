"use strict";

// Falo the Bard (master; Wiki "Falo the Bard", Transcript:Falo the Bard). "Falo the bard wants to
// see you." sends the player to him; he sings one of his songs (cluehelper_clue_falobard), and
// using the object it is about on him gives the next clue. The cache names the object as a list of
// items or a clue item group (item param 258). The Wiki doesn't say he keeps it, so he doesn't.
const Runtime = require("./Runtime.TreasureTrails");
const Dialogue = require("./Dialogue.TreasureTrails");
const Catalogue = require("./Catalogue.TreasureTrails");
const FIRST = "treasure-trails-master";
const AGAIN = "treasure-trails-master-when-talked-to-again";
const CORRECT = "treasure-trails-master-when-the-correct-item-is-used-on-him";
const WRONG = "treasure-trails-master-when-an-incorrect-item-is-used-on-him";
const OUTLANDER = "standard-dialogue-if-the-player-has-not-started-fremennik-trials";
// Wiki: he speaks only to players who have started The Fremennik Trials.
const FREMENNIK_TRIALS = "fremennik_trials";
// The transcripts' stand-in for the song he sings.
const SONG = /\[(?:one of his )?random songs?\]/i;
let api;
let core;

const pick = (entries, random = Math.random) => entries[Math.floor(random() * entries.length)];

function faloTrail(player, npcId) {
  return Runtime.startedTrails(player).find(entry => entry.step.falo && entry.step.npcIds.includes(npcId));
}

function songOf(trail) {
  return Runtime.data(trail.tier).songs.find(song => song.row === trail.state.song) ?? null;
}

function startedTrials(player) {
  const request = { player, key: FREMENNIK_TRIALS, started: null };
  api.emitCustomEvent("quest:is-started", request);
  return request.started !== false;
}

/** The transcript's lines with the song sung in place of its stand-in. */
function sung(steps, song) {
  return Dialogue.lines(steps).map(line => line.npc && SONG.test(line.npc) ? { npc: line.npc.replace(SONG, song.text) } : line);
}

function talk(event) {
  if (event.handled) return;
  const { player, npcId, npc } = event;
  const definition = event.definition ?? npc.getCurrentDefinition?.(player);
  if (definition?.getActions?.()[event.clickType - 1] !== "Talk-to") return;
  const trail = faloTrail(player, npcId);
  if (!trail) return;
  event.handled = true;
  if (!startedTrials(player)) {
    Dialogue.play(player, npcId, Dialogue.lines(Dialogue.transcript(player, npc, npcId, OUTLANDER)));
    return;
  }
  let song = songOf(trail);
  if (song) {
    Dialogue.play(player, npcId, sung(Dialogue.transcript(player, npc, npcId, AGAIN), song));
    return;
  }
  // The song stays with the clue, so he sings the same one until it is answered.
  song = pick(Runtime.data(trail.tier).songs);
  trail.item.setMetaValue(Runtime.metaKey(trail.tier), { ...trail.state, song: song.row });
  player.getInventory().refreshItems();
  Dialogue.play(player, npcId, sung(Dialogue.transcript(player, npc, npcId, FIRST), song));
}

function isAnswer(song, itemId) {
  const definition = core.ItemDefinition.forId(itemId);
  if (!definition || definition.isNoted()) return false;
  if (song.answer.anyOf) return song.answer.anyOf.includes(itemId);
  return core.CacheDefinitions.getItem(itemId)?.params?.get?.(Catalogue.TRAIL_ITEM_GROUP_PARAM) === song.answer.group;
}

function showItem(event) {
  if (event.handled) return;
  const { player, npcId, target: npc, itemId } = event;
  const trail = faloTrail(player, npcId);
  const song = trail && songOf(trail);
  if (!song) return;
  event.handled = true;
  const correct = isAnswer(song, itemId);
  const steps = Dialogue.transcript(player, npc, npcId, correct ? CORRECT : WRONG);
  // "You show your object to Falo." and how his eyes take it are game messages.
  for (const step of steps ?? []) if (step.type === "message" && /Falo/.test(step.text ?? "")) player.sendMessage(step.text);
  Dialogue.play(player, npcId, Dialogue.speech(steps).filter(line => line.npc), () => {
    if (!correct) return;
    const current = Runtime.stillHeld(player, trail);
    if (!current || current.state.song !== song.row) return;
    const casket = current.state.completed + 1 >= current.state.length;
    Runtime.advance(player, current, Math.random, casket ? { casket: "You've obtained a casket!" } : { clue: (steps ?? []).find(step => step.type === "message" && /clue/i.test(step.text ?? ""))?.text ?? "You've been given a new clue!" });
  });
}

module.exports = function attachFalo(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onBeforeNpcInteraction(talk);
  api.onItemOnNpc(showItem);
};

Object.assign(module.exports, { talk, showItem, isAnswer });
