// A crewmate on a cannon (rsprox: Jittery Jim on a skiff's adamant cannon, the user's crew-combat
// capture; Wiki: Boat combat). They need the cannon's Privateering ("Your crewmate requires 3
// Privateering to use that facility."), and the cannon must be free ("A player is already working
// at that facility."). They fire with ammunition from the cargo hold only ("Your crewmate on the
// cannon can't find any ammo in the cargo hold." and their line) by the captain's orders, the
// cannon row's buttons on the side panel (row 3 + hotspot, rsprox: slots 16 and 17 on a skiff's
// hotspot 1): the first cycles "Await further orders!", "Fire at will!" and "Attack my targets!"
// (sailing_sidepanel_weapon_n_following_target 1, 2, 0), the second is "Hold fire!".
const common = require("./Common.Crew");
const cannon = require("../seacombat/Cannon.SeaCombat");
const { SIDEPANEL_GROUP, SIDEPANEL_FACILITIES_CHILD, FACILITY_ROW_BUTTONS, FACILITY_ROW_HOTSPOT0 } = require("../SailingContent.Sailing");

const CREW_FACILITY_CANNON = 8;
const BUSY = "A player is already working at that facility.";
const ORDER_LINES = Object.freeze({
  [cannon.ORDER.CAPTAINS_TARGET]: "Attack my targets!",
  [cannon.ORDER.AWAIT]: "Await further orders!",
  [cannon.ORDER.FIRE_AT_WILL]: "Fire at will!",
});
const HOLD_FIRE = "Hold fire!";
const ORDER_BUTTON = 0;
const HOLD_FIRE_BUTTON = 1;

/** Mans the cannon on `hotspot` until the job stops. */
function work(player, boat, owned, member, hotspot) {
  return cannon.manByCrew(player, boat, owned, member, hotspot);
}

/** Whether the cannon on a hotspot is taken by the player, refusing the order if so. */
function refuseIfManned(player, boat, hotspot) {
  if (!cannon.playerAt(boat, hotspot)) return false;
  player.sendMessage(BUSY);
  return true;
}

/** The cannon row's order buttons (937:25, buttons 0 and 1 of row 3 + hotspot). */
function orderButton(event) {
  if (event.groupId !== SIDEPANEL_GROUP || event.childId !== SIDEPANEL_FACILITIES_CHILD) return;
  const slot = event.slot ?? -1;
  const row = Math.floor(slot / FACILITY_ROW_BUTTONS);
  const button = slot % FACILITY_ROW_BUTTONS;
  if (row < FACILITY_ROW_HOTSPOT0 || (button !== ORDER_BUTTON && button !== HOLD_FIRE_BUTTON)) return;
  const hotspot = row - FACILITY_ROW_HOTSPOT0;
  const { player } = event;
  const { Sailing } = common.core();
  const boat = Sailing.instanceAboard(player);
  if (!boat || !cannon.cannonOn(boat, hotspot)) return;
  event.handled = true;
  if (button === HOLD_FIRE_BUTTON) {
    player.forceChat(HOLD_FIRE);
    cannon.holdFire(boat, hotspot);
    return;
  }
  const next = { 0: cannon.ORDER.AWAIT, 1: cannon.ORDER.FIRE_AT_WILL, 2: cannon.ORDER.CAPTAINS_TARGET }[cannon.orderOf(boat, hotspot)];
  cannon.setOrder(player, boat, hotspot, next);
  player.forceChat(ORDER_LINES[next]);
}

function attach(api) {
  common.init(api);
  api.onInterfaceActionClick(orderButton);
}

module.exports = attach;
module.exports.work = work;
module.exports.refuseIfManned = refuseIfManned;
module.exports.CREW_FACILITY_CANNON = CREW_FACILITY_CANNON;
