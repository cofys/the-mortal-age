/**
 * The rest of the Abyssal Nexus (Wiki: Abyssal Nexus):
 * - the one-way passage in the south of the Abyss's outer ring leads in; its other side
 *   ("Passage", 27055) refuses, as captured: the player kneels (viking_drop_to_knee_and_backtoready)
 *   and "You can't get through from this side. You'll have to find another way out.";
 * - the appendage north of the Overseer pulls like a lever and teleports to Lumbridge (Wiki:
 *   Appendage);
 * - each chamber's eye answers Peek with who is inside, as captured with nobody there: "There are
 *   no adventurers in this chamber." and, once it has been empty a while, "The area feels like it's
 *   been empty for a while now." (Wiki: or how long it has been empty, "The area has been empty
 *   for: m:ss.").
 */
const Common = require("./Common.AbyssalSire");
const Lair = require("./Lair.AbyssalSire");

const PASSAGE_OUT = 27055;
const KNEEL_ANIM = 1332;
const KNEEL_TICKS = 1;
const NO_WAY_OUT = "You can't get through from this side.<br>You'll have to find another way out.";
/** Not captured: how long an empty chamber counts its time before it just "feels" empty. */
const EMPTY_FOR_A_WHILE_TICKS = 500;

function enterPassage({ player }) {
  player.moveTo(Common.toLocation(Common.data.nexus.passageArrival));
  return true;
}

function passageOut({ player }) {
  const { Animation, DialogueChainBuilder, StatementDialogue } = Common.core;
  Common.later(KNEEL_TICKS, () => {
    if (!player.isRegistered()) return;
    player.performAnimation(new Animation(KNEEL_ANIM, 10));
    Common.later(1, () => player.isRegistered()
      && player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, NO_WAY_OUT))));
  });
  return true;
}

function operateAppendage({ player }) {
  const { TeleportHandler, TeleportType } = Common.core;
  const destination = Common.toLocation(Common.data.nexus.appendageDestination);
  if (TeleportHandler.checkReqs(player, destination)) TeleportHandler.teleport(player, destination, TeleportType.LEVER, false);
  return true;
}

function clock(ticks) {
  const seconds = Math.floor((ticks * 600) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function peek({ player, npc }) {
  const { DialogueChainBuilder, StatementDialogue, World } = Common.core;
  const { eyes } = Common.data;
  const here = npc.getLocation();
  const lair = Lair.lairs.find((entry) => entry.def.eye[0] === here.getX() && entry.def.eye[1] === here.getY());
  if (!lair) return false;
  const inside = lair.players().length;
  const text = inside === 0 ? eyes.empty : eyes.occupied;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, text)));
  if (inside === 0) {
    const empty = World.getProcessCycle() - lair.lastOccupiedAt;
    player.sendMessage(!lair.lastOccupiedAt || empty >= EMPTY_FOR_A_WHILE_TICKS ? eyes.emptyForAWhile : `The area has been empty for: ${clock(empty)}.`);
  }
  return true;
}

function attachNexus(api) {
  const { locs } = Common.data;
  api.onObjectFirstClick(locs.passageIn, enterPassage);
  api.onObjectFirstClick(PASSAGE_OUT, passageOut);
  api.onObjectInteraction("Appendage", { Operate: operateAppendage });
  api.onNpcInteraction("<col=00ffff>Eye</col>", { Peek: peek });
}

module.exports = { attachNexus };
