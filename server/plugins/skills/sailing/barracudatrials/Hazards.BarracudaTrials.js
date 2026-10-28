// The trial courses' waters, for any boat sailing them (rsprox; the rapids' and pools' locs are
// the cache map's, docs/barracuda-trials.md):
//   Rapids (gentle, strong, powerful, deadly: 5x5 locs 60352-60355): each one sailed through
//   (sound 10698 the tick after) adds half a tile a tick to the sails, a strong one a whole tile,
//   up to the hull's speed cap; 16 ticks after the last one the extra goes and the boat slows back
//   at its acceleration (rsprox 856, 3457, 907, 908). A helm whose rapid resistance is below the
//   rapids' tier gets no speed from them: "The boat's helm was not strong enough to safely
//   traverse the X rapids.", the boat hit for 15 with sound 10700 (907).
//   Fetid pools (locs 60358-60363, the Jubbly Jive) slow the boat to half a tile a tick for about 6
//   ticks: "The fetid pools significantly reduce the speed of the boat!", unless a burst of speed
//   (a trim, a wind mote) is up. A burst started on the course: "The burst of speed temporarily
//   protects the boat from the fetid pools effect." (rsprox 907, 908: 0-2 ticks after the burst).
//   Rocks kill all momentum (BoatMovement), and with it the rapids' extra.
// Ours: powerful and deadly rapids' extra (1.5 and 2 tiles), and the weak helm's 15 for every tier.
const common = require("./Common.BarracudaTrials");
const supplies = require("./Supplies.BarracudaTrials");

const RAPIDS = new Map([[60352, ["gentle", 1]], [60353, ["strong", 2]], [60354, ["powerful", 3]], [60355, ["deadly", 4]]]);
const FETID = new Set([60358, 60359, 60360, 60361, 60362, 60363]);
const SOUND_RAPIDS = 10698;
const SOUND_WEAK_HELM = 10700;
const WEAK_HELM_DAMAGE = 15;
/** Each rapid's extra by tier, in half-tile steps. */
const RAPID_STEPS = { 1: 1, 2: 2, 3: 3, 4: 4 };
const STEP = 64;
const RAPIDS_TICKS = 16;
const POOL_SPEED = 64;
const POOL_TICKS = 6;

/** Per boat: { stacks, lastRapid, rapidsUntil, inPool, poolUntil, boosted }. */
const states = new WeakMap();

function stateOf(boat) {
  let state = states.get(boat);
  if (!state) {
    state = { stacks: 0, lastRapid: undefined, rapidsUntil: 0, inPool: undefined, poolUntil: 0, boosted: false };
    states.set(boat, state);
  }
  return state;
}

function rapidsOf(trial) {
  return common.mapLocs(trial, "rapids", new Set(RAPIDS.keys()));
}

function poolsOf(trial) {
  return common.mapLocs(trial, "fetid", FETID);
}

function locUnder(locs, tiles) {
  return locs.find((loc) => tiles.some(([x, y]) => common.onLoc(loc, x, y)));
}

function rapidResistance(player) {
  const owned = common.core().Sailing.activeBoat(player);
  return owned ? require("../BoatParts.Sailing").boatStats(owned).rapidResistance : 0;
}

function applySpeed(boat, state) {
  const now = common.clock();
  if (state.stacks > 0 && now >= state.rapidsUntil) state.stacks = 0;
  if (state.stacks > 0) boat.speedBonuses.set("rapids", STEP * state.stacks);
  else boat.speedBonuses.delete("rapids");
  if (now < state.poolUntil && boat.boostSpeed === undefined) boat.speedLimits.set("fetid", POOL_SPEED);
  else boat.speedLimits.delete("fetid");
}

function rapids(player, boat, trial, state, tiles) {
  const rapid = locUnder(rapidsOf(trial), tiles);
  if (!rapid) {
    state.lastRapid = undefined;
    return;
  }
  if (rapid === state.lastRapid) return;
  state.lastRapid = rapid;
  const [name, tier] = RAPIDS.get(rapid.id);
  if (rapidResistance(player) < tier) {
    player.sendMessage(`The boat's helm was not strong enough to safely traverse the ${name} rapids.`);
    require("../ShipCombat.Sailing").damagePlayerBoat(player, WEAK_HELM_DAMAGE);
    player.getPacketSender().sendSoundEffect(SOUND_WEAK_HELM, 1, 0);
    state.stacks = 0;
    return;
  }
  // The cap holds the speed back; more steps than that don't count.
  state.stacks = Math.min(Math.ceil(boat.speedCap / STEP), state.stacks + RAPID_STEPS[tier]);
  state.rapidsUntil = common.clock() + RAPIDS_TICKS;
  const { CountdownTask, TaskManager } = common.core();
  TaskManager.submit(new CountdownTask(player, 1, () => player.getPacketSender().sendSoundEffect(SOUND_RAPIDS, 1, 0)));
}

function pools(player, boat, trial, state, tiles) {
  const boosted = boat.boostSpeed !== undefined;
  if (boosted && !state.boosted && poolsOf(trial).length > 0) {
    player.sendMessage("<col=229628>The burst of speed temporarily protects the boat from the fetid pools effect.");
  }
  state.boosted = boosted;
  const pool = locUnder(poolsOf(trial), tiles);
  if (!pool) {
    state.inPool = undefined;
    return;
  }
  if (state.inPool) return;
  state.inPool = pool;
  if (boosted) return;
  state.stacks = 0;
  state.poolUntil = common.clock() + POOL_TICKS;
  player.sendMessage("<col=ff3045>The fetid pools significantly reduce the speed of the boat!");
}

/** Off the courses (or nobody aboard): the waters' effects end with them. */
function leave(boat) {
  if (!states.has(boat)) return;
  states.delete(boat);
  boat.speedBonuses.delete("rapids");
  boat.speedLimits.delete("fetid");
}

/** Every player's boat on a trial course, each tick after the boats move. */
function tickHazards() {
  const { BoatManager, World, Sailing } = common.core();
  for (const boat of BoatManager.all()) {
    if (boat.static) continue;
    const trial = common.trials.find((candidate) => common.inBounds(candidate, boat.tileX, boat.tileY));
    const player = trial && World.getPlayers().get(boat.ownerPlayerId);
    if (!player || Sailing.instanceAboard(player) !== boat) {
      leave(boat);
      continue;
    }
    const state = stateOf(boat);
    if (boat.lastStep?.blocked) state.stacks = 0;
    const tiles = supplies.pathTiles(boat);
    rapids(player, boat, trial, state, tiles);
    pools(player, boat, trial, state, tiles);
    applySpeed(boat, state);
  }
}

function attach(api) {
  common.init(api);
  common.core().BoatManager.onAfterTick(tickHazards);
}

module.exports = attach;
module.exports.tickHazards = tickHazards;
module.exports.stateOf = stateOf;
module.exports.rapidsOf = rapidsOf;
module.exports.poolsOf = poolsOf;
