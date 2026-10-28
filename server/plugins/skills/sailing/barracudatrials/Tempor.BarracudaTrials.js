// The Tempor Tantrum's rum (rsprox, recordings 3457, 3461, 3578, 3579, 856): one shipment at a
// time, collected with op1 on the rum boat south of Tempoross Cove and delivered with op1 on
// Ralph's boat, from the player's own boat 10-15 tiles off.
//   collect: "You collect the rum shipment. Now you need to deliver it to Rum-dashed Ralph!",
//   sound 10696, the rum thrown to the player (3501), a crate on the player's deck 2 ticks later;
//   already holding one: "You already have some rum to deliver."
//   deliver: "You deliver the rum shipment to Rum-dashed Ralph (n/m)!" (no count when one is
//   needed), sound 10697, the rum thrown to Ralph's boat, the crate gone; none held: "You don't
//   have any rum to deliver."
// The hint arrow goes back to the rum boat after each collect and delivery, as captured.
const common = require("./Common.BarracudaTrials");
const ships = require("./Ships.BarracudaTrials");
const run = require("./Run.BarracudaTrials");

const LOC_DELIVER = 59237;
const LOC_COLLECT = 59240;
const PROJECTILE_RUM = 3501;
const SOUND_COLLECT = 10696;
const SOUND_DELIVER = 10697;
/** The rum crate on the player's own deck (rsprox: skiff and sloop alike). */
const DECK_CRATE = { id: 59243, x: 4, y: 4, level: 1, shape: 22, rotation: 2 };
const CRATE_DELAY_TICKS = 2;

function state(runState) {
  return runState.state;
}

function start(player, current) {
  Object.assign(state(current), { collected: 0, delivered: 0, holding: false });
}

function rootOf(player) {
  return common.core().BoatManager.rootLocation(player);
}

function shipTile(id) {
  const boat = ships.shipOf(id)?.boat;
  return boat && new (common.core().Location)(boat.tileX, boat.tileY, 0);
}

function placeCrate(player, place, boat = common.core().Sailing.instanceAboard(player)) {
  if (!boat) return;
  if (place) common.core().BoatManager.setDeckLoc(boat, DECK_CRATE);
  else common.core().BoatManager.removeDeckLoc(boat, DECK_CRATE);
}

function collect(player, current) {
  const rum = state(current);
  if (rum.holding) return player.sendMessage("<col=ff3045>You already have some rum to deliver.");
  if (rum.delivered >= current.rankData.objectives) return undefined;
  rum.holding = true;
  rum.collected++;
  player.sendMessage("<col=3366ff>You collect the rum shipment. Now you need to deliver it to Rum-dashed Ralph!</col>");
  const out = player.getPacketSender();
  out.sendSoundEffect(SOUND_COLLECT, 1, 0);
  const from = shipTile("bt_rum_boat");
  if (from) out.sendProjectile(from, rootOf(player), 0, 60, PROJECTILE_RUM, 5, 32, player, 0, 30, 10);
  run.sendHint(player, current);
  const { CountdownTask, TaskManager } = common.core();
  TaskManager.submit(new CountdownTask(player, CRATE_DELAY_TICKS, () => {
    if (common.runs.get(player) === current && rum.holding) placeCrate(player, true);
  }));
  return undefined;
}

function deliver(player, current) {
  const rum = state(current);
  if (!rum.holding) return player.sendMessage("<col=ff3045>You don't have any rum to deliver.");
  rum.holding = false;
  rum.delivered++;
  const required = current.rankData.objectives;
  player.sendMessage(required > 1
    ? `<col=3366ff>You deliver the rum shipment to Rum-dashed Ralph (${rum.delivered}/${required})!</col>`
    : "<col=3366ff>You deliver the rum shipment to Rum-dashed Ralph!</col>");
  const out = player.getPacketSender();
  out.sendSoundEffect(SOUND_DELIVER, 1, 0);
  const to = shipTile("bt_ralph");
  if (to) out.sendProjectile(rootOf(player), to, 0, 60, PROJECTILE_RUM, 5, 32, undefined, 0, 30, 10);
  placeCrate(player, false);
  if (rum.delivered < required) run.sendHint(player, current);
  else run.clearHint(player);
  return undefined;
}

function onLoc(event) {
  if (event.clickType !== 1 || (event.objectId !== LOC_COLLECT && event.objectId !== LOC_DELIVER)) return;
  const current = common.runs.get(event.player);
  if (current?.trial.key !== "tempor_tantrum" || current.finishing) return;
  event.handled = true;
  if (event.objectId === LOC_COLLECT) collect(event.player, current);
  else deliver(event.player, current);
}

const mechanic = {
  start,
  hud: (player, current) => {
    const rum = state(current);
    return [rum.delivered, rum.collected, rum.holding ? 1 : 0, ""];
  },
  done: (player, current) => state(current).delivered >= current.rankData.objectives,
  end: (player, current) => {
    // Off the deck even when the player has left the boat or logged out.
    if (state(current).holding) placeCrate(player, false, current.boat);
  },
};

function attach(api) {
  common.init(api);
  run.registerMechanic("tempor_tantrum", mechanic);
  api.onObjectInteraction(onLoc);
}

module.exports = attach;
module.exports.mechanic = mechanic;
module.exports.collect = collect;
module.exports.deliver = deliver;
