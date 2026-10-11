// The global wind: direction + strength, shifting every ~30 minutes. With the wind a boat
// sails 50% faster and trains 25% faster; against it 30% slower. The shift is broadcast to
// everyone at sea, and taking the helm reports the current wind. Other sailing plugins read
// the wind through currentWind() / windXpFactor() and the "sailing:wind-shift" custom event.
//
// The wind multiplies the boat's base speed (stashed on first touch); a trimmed gust's
// boostSpeed still overrides it while it lasts, and rowing boats are left alone.
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { BoatManager } = require("../../../src/main/typescript/elvarg/game/content/sailing/BoatManager");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const { Task } = require("../../../src/main/typescript/elvarg/game/task/Task");
const { TaskManager } = require("../../../src/main/typescript/elvarg/game/task/TaskManager");
const {
  WIND_SHIFT_TICKS,
  rollWind,
  describeWind,
  windSpeedFactor,
  windXpFactor,
  windAspect,
} = require("./sailingWind");

let pluginApi = null;
/** The current wind, rolled at startup and re-rolled every WIND_SHIFT_TICKS. */
let wind = rollWind();

/** The wind every sailing plugin reads. */
function currentWind() {
  return wind;
}

/** Applies the current wind to one boat's base speed (skips rowing boats). */
function applyWindToBoat(boat) {
  if (!boat || boat.rowing) return;
  if (boat.sailingWindBase === undefined) boat.sailingWindBase = boat.baseSpeed;
  boat.baseSpeed = Math.max(1, Math.round(boat.sailingWindBase * windSpeedFactor(boat.heading, wind)));
}

/** Every player-owned boat currently at sea. */
function* boatsAtSea() {
  for (const player of World.getPlayers()) {
    const boat = player && Sailing.instanceAboard(player);
    if (boat) yield { player, boat };
  }
}

function broadcastShift() {
  const seen = new Set();
  for (const { player, boat } of boatsAtSea()) {
    if (seen.has(boat)) continue;
    seen.add(boat);
    applyWindToBoat(boat);
    player.sendMessage(`The wind shifts: now ${describeWind(wind)}.`);
  }
  pluginApi?.emitCustomEvent("sailing:wind-shift", { wind });
}

/** Rolls a new wind, re-applies it to every boat at sea and tells their crews. */
function shiftWind() {
  wind = rollWind();
  broadcastShift();
}

/** A new heading re-rates the boat against the wind at once. */
function retrimForHeading(player, boat) {
  applyWindToBoat(boat);
}

/** Taking the helm reports the wind, so the helmsman can plan around it. */
function reportWind(player) {
  player.sendMessage(`The wind is ${describeWind(wind)}.`);
}

/** A boat leaving the wind system (sunk, disposed) sheds its stash. */
function forgetBoat(boat) {
  if (boat) {
    if (boat.sailingWindBase !== undefined) boat.baseSpeed = boat.sailingWindBase;
    boat.sailingWindBase = undefined;
  }
}

function startWind() {
  wind = rollWind();
  // Never stopped: repeats every WIND_SHIFT_TICKS.
  TaskManager.submit(new (class extends Task {
    constructor() { super(WIND_SHIFT_TICKS); }
    execute() {
      shiftWind();
    }
  })());
  BoatManager.onHeadingSet(retrimForHeading);
}

module.exports = {
  name: "SailingWind",
  members: true,
  currentWind,
  applyWindToBoat,
  reportWind,
  forgetBoat,
  windXpFactor,
  windAspect,
  describeWind,
  register(api) {
    pluginApi = api;
    api.onServerStartup(startWind);
  },
};
