// Waypoints: port-to-port auto-sailing. A port master's Set-course plots a course for one of
// the nearest ports; while the helmsman sails with the sails up, the boat steers itself towards
// the destination's buoy. Clicking the water to steer takes manual control and clears the
// course. Arriving earns Sailing XP and the boat drifts to a stop.
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { BoatManager } = require("../../../src/main/typescript/elvarg/game/content/sailing/BoatManager");
const { BoatMoveMode } = require("../../../src/main/typescript/elvarg/game/content/sailing/Boat");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { VARBIT, MOVE_MODE, content, setVarbit } = require("./sailingContent");
const { currentWind, windXpFactor } = require("./SailingWind.plugin");

const WAYPOINT_ATTRIBUTE = "sailing:waypoint";
/** How many of the nearest ports Set-course offers. */
const COURSE_CHOICES = 8;
/** Tiles from a port's buoy that count as arrived. */
const ARRIVAL_TILES = 10;
/** Sailing XP for completing a plotted course. */
const ARRIVAL_XP = 100;

let pluginApi = null;

function waypointOf(player) {
  return player.getAttribute(WAYPOINT_ATTRIBUTE);
}

function setWaypoint(player, waypoint) {
  player.setAttribute(WAYPOINT_ATTRIBUTE, waypoint ?? null);
}

function portById(id) {
  return content().docks.find((dock) => dock.id === id);
}

function sailingLevel(player) {
  return player.getSkillManager().getMaxLevel(Skill.SAILING);
}

/** The nearest ports the player may sail to, closest first. */
function nearestPorts(player) {
  const here = player.getLocation();
  const level = sailingLevel(player);
  return content().docks
    .filter((dock) => dock.buoy && dock.level <= level)
    .map((dock) => ({
      dock,
      distance: Math.hypot(dock.buoy.x - here.getX(), dock.buoy.y - here.getY()),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, COURSE_CHOICES)
    .map(({ dock }) => dock);
}

/** A port master's Set-course: plot a course for one of the nearest ports. */
function setCourse({ player }) {
  const ports = nearestPorts(player);
  if (ports.length === 0) {
    player.sendMessage("There are no ports in sailing range of your level.");
    return;
  }
  const options = ports.flatMap((dock) => [
    dock.name,
    () => {
      setWaypoint(player, { port: dock.id });
      player.sendMessage(`Course plotted for ${dock.name}. Take the helm and raise the sails.`);
    },
  ]);
  const current = waypointOf(player);
  if (current) options.push("Clear course", () => {
    setWaypoint(player, null);
    player.sendMessage("Your course is cleared.");
  });
  options.push("Never mind", () => {});
  pluginApi.sendMultiChatboxPrompt(player, "Set course for which port?", ...options);
}

/** A manual heading (a water click) overrides a plotted course. */
function manualSteer(player) {
  if (waypointOf(player)) {
    setWaypoint(player, null);
    player.sendMessage("You take manual control of the helm; your course is cleared.");
  }
}

function boatTile(boat) {
  return { x: Math.floor(boat.fineX / 128), y: Math.floor(boat.fineY / 128) };
}

/** Sails up and steering: point the boat at the waypoint's buoy, direct (no heading event). */
function steerWaypoint(player, boat, dock) {
  const heading = boat.helmHeadingToward(dock.buoy.x, dock.buoy.y);
  if (heading !== undefined) boat.heading = heading;
}

function arrive(player, boat, dock) {
  setWaypoint(player, null);
  boat.moveMode = BoatMoveMode.Stopped;
  setVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE, MOVE_MODE.STOPPED);
  player.sendMessage(`You arrive at ${dock.name}. The boat drifts to a stop.`);
  const xp = Math.round(ARRIVAL_XP * windXpFactor(boat.heading, currentWind()));
  player.getSkillManager().addExperience(Skill.SAILING, xp, true);
}

/** Each tick: boats with a plotted course steer themselves while under sail. */
function tickWaypoints() {
  for (const player of World.getPlayers()) {
    const waypoint = player && waypointOf(player);
    if (!waypoint) continue;
    const boat = Sailing.instanceAboard(player);
    const dock = waypoint && portById(waypoint.port);
    if (!boat || !dock?.buoy || boat.helmPlayerId !== player.getIndex()) continue;
    if (boat.moveMode !== BoatMoveMode.Full && boat.moveMode !== BoatMoveMode.Half) continue;
    const at = boatTile(boat);
    if (Math.hypot(dock.buoy.x - at.x, dock.buoy.y - at.y) <= ARRIVAL_TILES) {
      arrive(player, boat, dock);
      continue;
    }
    steerWaypoint(player, boat, dock);
  }
}

function forgetWaypoint({ player }) {
  if (waypointOf(player)) setWaypoint(player, null);
}

module.exports = {
  name: "SailingWaypoints",
  members: true,
  WAYPOINT_ATTRIBUTE,
  nearestPorts,
  register(api) {
    pluginApi = api;
    content();
    api.onNpcInteraction("Port master", { "Set-course": setCourse });
    api.onPlayerLogout(forgetWaypoint);
    BoatManager.onHeadingSet(manualSteer);
    BoatManager.onAfterTick(tickWaypoints);
  },
};
