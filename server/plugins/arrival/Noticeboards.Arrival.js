"use strict";

/**
 * Noticeboards.Arrival — the rumor broadsheet.
 *
 * Reading any Noticeboard in a capital pins the world's current state to the
 * chatbox: a civic notice plus the live rumors for that kingdom, drawn from
 * the same flag-driven engine as the street chatter. A player who reads the
 * board gets the kingdom's situation in one glance — no quest, no checklist.
 */

const Common = require("./Common.Arrival");
const Rumors = require("./Rumors.Arrival");

const PINNED_NOTICES = {
  asgarnia:
    "BY ORDER OF THE REGENT: the crown's business is the crown's business. Curfew bells at dusk. Report Kinshra sympathisers to the castle guard.",
  misthalin:
    "BY ORDER OF THE PALACE: His Majesty King Roald III is indisposed. Prayers for the king's health daily at the cathedral. Gang brawling is punishable by the stocks.",
  kandarin:
    "BY ORDER OF KING LATHAS: the West Ardougne quarantine holds. No crossing the wall without a mourner's writ. The plague does not forgive.",
  morytania:
    "NO PROCLAMATIONS. The board in Burgh de Rott is nailed up by whoever dared. Vyre patrols doubled. Stay inside after dark.",
  keldagrim:
    "BY ORDER OF THE CONSORTIUM, IN COUNCIL: all mining claims are company property. Red Axe agitation is treason. Report strangers in the east tunnels.",
};

function readBoard(event) {
  const player = event?.player;
  if (!player || !Common.isRealPlayer(player)) return;

  const object = event?.object;
  const location = object?.getLocation?.() ?? player.getLocation();
  const kingdomId = Common.kingdomAt(location);

  if (!kingdomId) {
    player.sendMessage("The board is covered in old, rain-blurred notices. Nothing worth reading.");
    return;
  }

  const rumors = Rumors.rumorsFor(kingdomId);
  player.sendMessage("You read the notice board:");
  player.sendMessage(`--- ${PINNED_NOTICES[kingdomId] ?? ""}`);
  const shown = rumors.slice(0, 3);
  for (const rumor of shown) {
    player.sendMessage(`* ${rumor}`);
  }
  if (shown.length === 0) {
    player.sendMessage("* The streets are quiet. Too quiet.");
  }
}

module.exports = function attachNoticeboards(api) {
  api.onObjectInteraction("Noticeboard", { Read: readBoard });
};
