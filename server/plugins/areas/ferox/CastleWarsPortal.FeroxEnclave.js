/**
 * The Castle Wars portal just outside The Old Nite pub (Wiki: Castle Wars portal; OSRS Wiki,
 * Ferox Enclave; docs/ferox-enclave.md):
 *
 * - "Enter" warns that there is no return portal to Ferox Enclave from Castle Wars, and on "Yes."
 *   teleports a tick later to the Castle Wars lobby. Free-to-play worlds can come back through
 *   the lobby's double doors (not wired up here - "Not done" in docs/ferox-enclave.md).
 */
const { Location } = require("../../../src/main/typescript/elvarg/game/model/Location");
const Ferox = require("./Common.FeroxEnclave");

/** The lobby spot the ring of dueling's Castle Wars teleport uses (Teleports.Jewellery.js). */
const LOBBY = new Location(2440, 3090, 0);
// The Wiki names the warning only; the wording is ours.
const WARNING = "There is no return portal to Ferox Enclave from Castle Wars.";

function teleport(player) {
  Ferox.later(player, 1, () => {
    player.getPacketSender().sendVarbit(Ferox.BUSY_VARBIT, 0);
    player.moveTo(LOBBY.clone());
  });
}

function enter({ player }) {
  const sender = player.getPacketSender();
  const { DialogueChainBuilder, StatementDialogue, ActionDialogue } = Ferox.core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new StatementDialogue(0, WARNING),
    new ActionDialogue(1, {
      execute: () => {
        sender.sendVarbit(Ferox.BUSY_VARBIT, 1);
        Ferox.api.sendMultiChatboxPrompt(player, "Enter the Castle Wars portal?",
          "Yes.", teleport,
          "No.", () => sender.sendVarbit(Ferox.BUSY_VARBIT, 0));
      },
    }),
  ));
}

module.exports = function attachCastleWarsPortal(api) {
  api.onObjectInteraction("Castle Wars portal", { Enter: enter });
};

Object.assign(module.exports, { enter, teleport, LOBBY, WARNING });
