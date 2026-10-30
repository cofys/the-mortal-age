// Repairing a boat with a repair kit (rsprox.net recording 3455, the inventory's Apply on a repair
// kit; Wiki: Repair kits): aboard their own damaged boat the player plays human_repairkit and
// sound 2101 three times (15, 30 and 45 cycles in), "You use the repair kit to fix up the boat.",
// the kit goes and the boat gets its hitpoints back (wooden 5 up to rosewood 50). Like eating, it
// holds off the player's next cannon shot (Wiki; ours: 3 ticks, as food).
const common = require("./Common.SeaCombat");
const cargo = require("../Cargo.Sailing");
const BoatHp = require("./BoatHp.SeaCombat");
const { playSound } = require("../SailingContent.Sailing");

const ANIM_REPAIR = 13252;
const SOUND_REPAIR = 2101;
const SOUND_DELAYS = [15, 30, 45];
const ATTACK_DELAY_TICKS = 3;
const REPAIRED = "You use the repair kit to fix up the boat.";
// Not captured: a kit used ashore or on a boat with nothing to repair (our wording).
const NOT_ABOARD = "You can only use a repair kit aboard your own boat.";
const UNDAMAGED = "Your boat doesn't need repairing.";
/** The repair kits by name (Cargo.Sailing.js REPAIR_KITS has what each repairs). */
const KIT_NAMES = Object.freeze([
  "Repair kit", "Oak repair kit", "Teak repair kit", "Mahogany repair kit", "Camphor repair kit",
  "Ironwood repair kit", "Rosewood repair kit",
]);

function apply(event) {
  const heals = cargo.REPAIR_KITS[event.itemId];
  if (heals === undefined) return false;
  event.handled = true;
  const { player } = event;
  const aboard = common.ownBoat(player);
  if (!aboard) {
    player.sendMessage(NOT_ABOARD);
    return true;
  }
  if ((aboard.owned.damage ?? 0) <= 0) {
    player.sendMessage(UNDAMAGED);
    return true;
  }
  const inventory = player.getInventory();
  if (!inventory.contains(event.itemId)) return true;
  inventory.deleteNumber(event.itemId, 1);
  player.performAnimation(new (common.core().Animation)(ANIM_REPAIR));
  for (const delay of SOUND_DELAYS) playSound(player, SOUND_REPAIR, delay);
  common.spam(player, REPAIRED);
  BoatHp.heal(player, aboard.owned, heals);
  const gunner = require("./Cannon.SeaCombat").mannedBy(player);
  if (gunner) {
    gunner.nextAttackTick = Math.max(gunner.nextAttackTick, common.core().World.getProcessCycle() + ATTACK_DELAY_TICKS);
  }
  return true;
}

function attach(api) {
  common.init(api);
  for (const name of KIT_NAMES) api.onItemAction(name, { Apply: apply });
}

module.exports = attach;
module.exports.apply = apply;
