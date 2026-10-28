"use strict";

const Ids = require("./Ids.Construction");

// Cache241 script642 (poh_menagerie_drawpet) switches on these exact enum IDs.
// Their cache symbols are generated enum_N names. Item names cannot derive the
// selected varbit: several differ and two native names spell it "mutliform".
const MULTIFORM_VARBITS_BY_ENUM = new Map([
  [1686, "poh_menagerie_multiform_kqpet"],
  [1687, "poh_menagerie_multiform_snakepet"],
  [1688, "poh_menagerie_multiform_vetionpet"],
  [3733, "poh_menagerie_multiform_molepet"],
  [1691, "poh_menagerie_multiform_skillpetmining"],
  [1689, "poh_menagerie_multiform_skillpethunter"],
  [1690, "poh_menagerie_multiform_skillpetrunecrafting"],
  [2861, "poh_menagerie_multiform_skillpetagility_bigger"],
  [285, "poh_menagerie_multiform_corppet"],
  [1893, "poh_menagerie_multiform_infernopet"],
  [1711, "poh_menagerie_multiform_olmpet"],
  [3856, "poh_menagerie_multiform_verzikpet"],
  [995, "poh_menagerie_multiform_smokepet"],
  [2788, "poh_menagerie_mutliform_phoenixpet"],
  [2849, "poh_menagerie_mutliform_farmingpet"],
  [2946, "poh_menagerie_multiform_thievingpet"],
  [3554, "poh_menagerie_multiform_soulwarspet"],
  [3665, "poh_menagerie_multiform_jadpet"],
  [3713, "poh_menagerie_multiform_skillpetfishing"],
  [3938, "poh_menagerie_multiform_nightmarepet"],
  [3939, "poh_menagerie_multiform_sarachnispet"],
  [4802, "poh_menagerie_multiform_wardenpet"],
  [4918, "poh_menagerie_multiform_muspahpet"],
  [4904, "poh_menagerie_multiform_callistopet"],
  [4905, "poh_menagerie_multiform_venenatispet"],
  [3754, "poh_menagerie_multiform_skillpetwoodcutting"],
  [4823, "poh_menagerie_multiform_araxxorpet"],
  [3349, "poh_menagerie_multiform_royaltitanpet"],
  [5774, "poh_menagerie_multiform_gryphonbosspet"],
  [6016, "poh_menagerie_multiform_ocelluspet"],
]);

function varbitForEnum(enumId) {
  const name = MULTIFORM_VARBITS_BY_ENUM.get(enumId);
  // An unmatched enum leaves the base object unchanged in the client script.
  return name ? Ids.varbit(name) : undefined;
}

module.exports = { varbitForEnum };
