/**
 * Gusts of wind and trimming the sails, as live (rsprox captures; docs/sailing.md):
 * - while the sails are set (half or full), a gust comes when the boat's gust timer runs out:
 *   "You feel a gust of wind.", the sound and the gust's wind on the sail cloth, which shows Trim;
 * - Trim within 14 ticks catches it: the hull's speed cap for the sails' boost duration, the
 *   helm's trim animations, and the next gust 50 ticks after the trim;
 * - left alone, the gust dies down after 14 ticks and the next comes 49 ticks later;
 * - either way the end is "The wind dies down and your sails with it."
 * The timer keeps running while the sails are down, so raising them late can catch a gust at
 * once; a boat's first one comes 49 ticks after its sails are first set.
 */
const { BoatManager } = require("../../../src/main/typescript/elvarg/game/content/sailing/BoatManager");
const { BoatMoveMode } = require("../../../src/main/typescript/elvarg/game/content/sailing/Boat");
const { Animation } = require("../../../src/main/typescript/elvarg/game/model/Animation");
const { Graphic } = require("../../../src/main/typescript/elvarg/game/model/Graphic");
const { Location } = require("../../../src/main/typescript/elvarg/game/model/Location");
const { Task } = require("../../../src/main/typescript/elvarg/game/task/Task");
const { TaskManager } = require("../../../src/main/typescript/elvarg/game/task/TaskManager");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const {
  boatAnim,
  animateDeckLocs,
  animateSails,
  setSailClothOps,
  isHelm,
  isSailCloth,
  playSound,
} = require("./sailingContent");

const GUST_TICKS = 14;
const FIRST_GUST_DELAY = 49;
const GUST_DELAY_AFTER_LULL = 49;
const GUST_DELAY_AFTER_TRIM = 50;
/** The helm's trim loop plays every 4 ticks while trimmed. */
const TRIM_LOOP_TICKS = 4;
/** A hull without stats: the sails' shortest boost, and a fifth faster. */
const DEFAULT_BOOST_TICKS = 20;
const SOUND_GUST = 10839;
const SOUNDS_TRIM = [10842, 10841];

const GUST_MESSAGE = "You feel a gust of wind.";
const TRIM_MESSAGE = "You trim the sails, catching the wind for a burst of speed!";
const LULL_MESSAGE = "The wind dies down and your sails with it.";

/** Per boat: its clock (ticks since it was first set sailing) and the wind's state. */
const winds = new WeakMap();

function sailsUp(boat) {
  return boat.moveMode === BoatMoveMode.Full || boat.moveMode === BoatMoveMode.Half;
}

function sailState(boat) {
  if (boat.moveMode === BoatMoveMode.Full) return "full";
  if (boat.moveMode === BoatMoveMode.Half) return "half";
  return "down";
}

function helmsman(boat) {
  const player = boat.helmPlayerId === undefined ? undefined : World.getPlayers().get(boat.helmPlayerId);
  return player && player.isRegistered?.() !== false ? player : undefined;
}

/** A graphic on the sail cloth's tile, for the player and everyone who sees them. */
function windOnSails(player, boat, graphicId) {
  const spec = BoatManager.getSpec(boat);
  const viewers = [player, ...player.getLocalPlayers().filter((other) => other.getLocalPlayers().includes(player))];
  for (const loc of spec?.locs.filter(isSailCloth) ?? []) {
    const tile = new Location(boat.deckBaseX + loc.x, boat.deckBaseY + loc.y, loc.level);
    for (const viewer of viewers) viewer.getPacketSender().sendGraphic(new Graphic(graphicId), tile);
  }
}

/** Whether a gust is waiting to be caught: Trim shows on the sail cloth. */
function canTrim(boat) {
  const wind = winds.get(boat);
  return !!wind && wind.gustEnds !== undefined && sailsUp(boat);
}

function startGust(player, boat, wind) {
  const trim = boatAnim(boat, "trim");
  wind.gustEnds = wind.clock + GUST_TICKS;
  player.sendMessage(GUST_MESSAGE);
  setSailClothOps(player, boat, true, true);
  animateSails(player, boat, sailState(boat), sailState(boat));
  if (trim) windOnSails(player, boat, trim.gust);
  playSound(player, SOUND_GUST);
}

/** The wind dies down: after an untrimmed gust, or at the end of a trim's boost. */
function lull(player, boat, wind) {
  const trim = boatAnim(boat, "trim");
  const trimmed = wind.boostEnds !== undefined;
  wind.gustEnds = undefined;
  wind.boostEnds = undefined;
  boat.boostSpeed = undefined;
  if (!trimmed) wind.nextGust = wind.clock + GUST_DELAY_AFTER_LULL;
  player.sendMessage(LULL_MESSAGE);
  if (trimmed && trim) {
    player.performAnimation(new Animation(trim.player.end));
    animateDeckLocs(player, boat, isHelm, trim.helm.end);
  }
  const set = boat.moveMode !== BoatMoveMode.Stopped;
  setSailClothOps(player, boat, set);
  if (set) animateSails(player, boat, sailState(boat), sailState(boat), { settle: false });
}

/**
 * Trim on the sail cloth: catches the waiting gust, for whoever is at the helm. Returns false
 * when there is none to catch.
 */
function trimSails(player, boat) {
  const wind = winds.get(boat);
  if (!wind || !canTrim(boat)) return false;
  const trim = boatAnim(boat, "trim");
  const spec = BoatManager.getSpec(boat);
  wind.gustEnds = undefined;
  wind.trimmedAt = wind.clock;
  wind.boostEnds = wind.clock + (spec?.stats?.speedBoostDuration ?? DEFAULT_BOOST_TICKS);
  wind.nextGust = wind.clock + GUST_DELAY_AFTER_TRIM;
  boat.boostSpeed = spec?.stats?.speedCap ?? Math.round(boat.baseSpeed * 1.2);
  player.sendMessage(TRIM_MESSAGE);
  if (trim) {
    player.performAnimation(new Animation(trim.player.trim));
    animateDeckLocs(player, boat, isHelm, trim.helm.trim);
  }
  setSailClothOps(player, boat, true);
  animateSails(player, boat, sailState(boat), sailState(boat));
  if (trim) windOnSails(player, boat, trim.boost);
  for (const sound of SOUNDS_TRIM) playSound(player, sound);
  return true;
}

function tickWind(boat, wind) {
  wind.clock++;
  const player = helmsman(boat);
  const trim = boatAnim(boat, "trim");
  if (!player) {
    // Nobody at the helm: the sails are down (leaving the helm lowers them); the wind just passes.
    if (wind.gustEnds !== undefined && wind.clock >= wind.gustEnds) {
      wind.gustEnds = undefined;
      wind.nextGust = wind.clock + GUST_DELAY_AFTER_LULL;
    }
    if (wind.boostEnds !== undefined && wind.clock >= wind.boostEnds) {
      wind.boostEnds = undefined;
      boat.boostSpeed = undefined;
    }
    return;
  }
  if (wind.boostEnds !== undefined) {
    if (wind.clock >= wind.boostEnds) return lull(player, boat, wind);
    if (trim) {
      // The wind shows on set sails only (rsprox: lowering them stops it at once).
      if (sailsUp(boat)) windOnSails(player, boat, trim.boost);
      if ((wind.clock - wind.trimmedAt) % TRIM_LOOP_TICKS === 0) {
        player.performAnimation(new Animation(trim.player.loop));
        animateDeckLocs(player, boat, isHelm, trim.helm.loop);
      }
    }
    return;
  }
  if (wind.gustEnds !== undefined) {
    if (wind.clock >= wind.gustEnds) return lull(player, boat, wind);
    if (trim && sailsUp(boat)) windOnSails(player, boat, trim.gust);
    return;
  }
  if (sailsUp(boat) && wind.clock >= wind.nextGust) startGust(player, boat, wind);
}

/** Sets the boat's wind going the first time its sails are set; it runs as long as the boat. */
function windFor(boat) {
  let wind = winds.get(boat);
  if (wind) return wind;
  wind = { clock: 0, nextGust: FIRST_GUST_DELAY, gustEnds: undefined, boostEnds: undefined, trimmedAt: 0 };
  winds.set(boat, wind);
  TaskManager.submit(new (class extends Task {
    constructor() { super(1, boat, false); }
    execute() {
      if (!BoatManager.getSpec(boat)) {
        winds.delete(boat);
        this.stop();
        return;
      }
      tickWind(boat, wind);
    }
  })());
  return wind;
}

/** Whether the sails are trimmed: the helm plays the trim's loop instead of its own. */
function isTrimmed(boat) {
  return winds.get(boat)?.boostEnds !== undefined;
}

module.exports = { windFor, canTrim, trimSails, isTrimmed, GUST_TICKS, GUST_DELAY_AFTER_TRIM, GUST_DELAY_AFTER_LULL, FIRST_GUST_DELAY };
