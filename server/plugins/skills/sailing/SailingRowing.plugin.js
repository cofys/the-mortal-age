// Rowing: the level-1 Sailing XP loop. Aboard your own raft with the sails down, the helm's
// Row sets off rowing on the boat's current heading at a slow fixed stroke; every tile rowed
// trains Sailing. Raising the sails (a gust catches them), leaving the helm, beaching or
// logging out ships the oars. Sailing before the wind adds the usual XP bonus.
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { BoatManager } = require("../../../src/main/typescript/elvarg/game/content/sailing/BoatManager");
const { BoatMoveMode } = require("../../../src/main/typescript/elvarg/game/content/sailing/Boat");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { VARBIT, MOVE_MODE, boatType, getVarbit, setVarbit } = require("./sailingContent");
const { currentWind, windXpFactor } = require("./SailingWind.plugin");

/** Fine units (1/128 tile) per tick while rowing: a slow stroke next to full sail. */
const ROW_SPEED = 48;
/** Sailing XP per tile rowed (~8k/hr at rowing speed). */
const XP_PER_TILE = 6;

const NEED_RAFT = "You need to be aboard your own raft to row.";
const NEED_HELM = "You must be at the helm to row.";
const NEED_SAILS_DOWN = "Ship the oars first — lower the sails before rowing.";
const START = "You dip the oars and start rowing.";
const STOP = "You ship the oars.";
const STOP_WIND = "The wind catches your sails; you ship the oars.";
const STOP_BEACHED = "The raft runs aground; you ship the oars.";

/** Per player: their rowing session, if they are rowing. */
const sessions = new Map();

/** The player's rowing session, if they have one. */
function sessionOf(player) {
  return sessions.get(player);
}

function setSession(player, session) {
  if (session) sessions.set(player, session);
  else sessions.delete(player);
}

/** Starts rowing: fixed slow speed on the boat's current heading. */
function startRowing({ player }) {
  const boat = Sailing.instanceAboard(player);
  const type = boat && BoatManager.getSpec(boat)?.type;
  if (!boat || type !== "raft") {
    player.sendMessage(NEED_RAFT);
    return;
  }
  if (boat.helmPlayerId !== player.getIndex()) {
    player.sendMessage(NEED_HELM);
    return;
  }
  if (sessionOf(player)) {
    player.sendMessage(STOP);
    stopRowing(player, boat);
    return;
  }
  const moveMode = getVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE);
  if (moveMode !== MOVE_MODE.STOPPED && moveMode !== MOVE_MODE.MOORED) {
    player.sendMessage(NEED_SAILS_DOWN);
    return;
  }
  boat.heading = boat.angle;
  boat.rowingBase = boat.baseSpeed;
  boat.baseSpeed = ROW_SPEED;
  boat.moveMode = BoatMoveMode.Full;
  boat.rowing = true;
  setVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE, MOVE_MODE.FULL);
  setSession(player, { lastX: boat.fineX, lastY: boat.fineY, remainder: 0 });
  player.sendMessage(START);
}

/** Stops rowing and restores the boat's speed, with an optional message. */
function stopRowing(player, boat, message = STOP) {
  const session = sessionOf(player);
  if (!session) return;
  setSession(player, undefined);
  if (boat) {
    boat.rowing = false;
    if (boat.rowingBase !== undefined) {
      boat.baseSpeed = boat.rowingBase;
      boat.rowingBase = undefined;
    }
    if (boat.moveMode === BoatMoveMode.Full && boat.helmPlayerId === player.getIndex()) {
      boat.moveMode = BoatMoveMode.Stopped;
      setVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE, MOVE_MODE.STOPPED);
    }
  }
  if (message) player.sendMessage(message);
}

/** Awards XP for the tiles rowed since the last tick. */
function rowTick(player, boat, session) {
  const dx = boat.fineX - session.lastX;
  const dy = boat.fineY - session.lastY;
  session.lastX = boat.fineX;
  session.lastY = boat.fineY;
  const tiles = Math.hypot(dx, dy) / 128 + session.remainder;
  const whole = Math.floor(tiles);
  session.remainder = tiles - whole;
  if (whole <= 0) return;
  const xp = Math.round(whole * XP_PER_TILE * windXpFactor(boat.heading, currentWind()));
  if (xp > 0) player.getSkillManager().addExperience(Skill.SAILING, xp, true);
  setSession(player, session);
}

/** Each tick: rowing boats train, and anything that ends rowing ships the oars. */
function tickRowing() {
  for (const player of World.getPlayers()) {
    const session = player && sessionOf(player);
    if (!session) continue;
    const boat = Sailing.instanceAboard(player);
    if (!boat || !boat.rowing) {
      stopRowing(player, boat, undefined);
      continue;
    }
    if (boat.boostSpeed !== undefined) {
      // A trimmed gust caught the sails: the wind takes over.
      stopRowing(player, boat, STOP_WIND);
      continue;
    }
    if (boat.moveMode !== BoatMoveMode.Full) {
      stopRowing(player, boat, undefined);
      continue;
    }
    rowTick(player, boat, session);
  }
}

function forgetRowing({ player }) {
  const session = sessionOf(player);
  if (session) setSession(player, undefined);
}

/** The helm's Stop-rowing: ships the oars if they are out. */
function stopRowingOp({ player }) {
  const boat = Sailing.instanceAboard(player);
  stopRowing(player, boat);
}

module.exports = {
  name: "SailingRowing",
  members: true,
  ROW_SPEED,
  XP_PER_TILE,
  startRowing,
  stopRowing,
  register(api) {
    api.onObjectInteraction("Helm", { Row: startRowing, "Stop-rowing": stopRowingOp });
    api.onPlayerLogout(forgetRowing);
    BoatManager.onAfterTick(tickRowing);
  },
};
