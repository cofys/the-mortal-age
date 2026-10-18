"use strict";

/**
 * The captains and first mates on the cove: Forfeit before a win, Leave after one.
 *
 * Wiki (Transcript:Captain Pudi, "I want to leave."): "Really? You will receive no reward if you
 * do." then "Yes, I really want to leave." / "No, I don't want to leave."; the captures' message
 * on the way back: "You sail back to the Ruins of Unkah.". After a win the hosts' Leave skips the
 * 20-second wait (Wiki).
 */

const Shared = require("./Shared.Tempoross");
const { coveOf, coveOfNpc } = require("./Cove.Tempoross");

const { JINGLE } = Shared;

function sailHome(player) {
  const cove = coveOf(player);
  if (!cove) return;
  player.getPacketSender().sendJingle(JINGLE.BOAT, 0);
  cove.leave(player);
  player.sendMessage("You sail back to the Ruins of Unkah.");
}

function forfeit(event) {
  const { player, npc } = event;
  const cove = coveOfNpc(npc);
  if (!cove) return false;
  if (coveOf(player) !== cove) return true;
  const { DialogueChainBuilder, NpcDialogue, OptionDialogue } = Shared.core();
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new NpcDialogue(0, event.npcId, "Really? You will receive no reward if you do."),
    new OptionDialogue(1, {
      executeOption(option) {
        player.getPacketSender().sendInterfaceRemoval();
        if (Number(option) === 1) sailHome(player);
      },
    }, "Yes, I really want to leave.", "No, I don't want to leave."),
  ));
  return true;
}

function leave(event) {
  const { player, npc } = event;
  const cove = coveOfNpc(npc);
  if (!cove) return false;
  if (coveOf(player) !== cove) return true;
  cove.fight?.sendHome(player, true);
  return true;
}

function attachHosts(api) {
  api.onNpcsInteraction(["Captain Pudi", "Captain Dudi", "First Mate Deri", "First Mate Peri"], { Forfeit: forfeit, Leave: leave });
}

module.exports = { attachHosts, sailHome };
