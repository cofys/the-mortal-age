// The helm: taking and leaving it, the sidepanel sail buttons, and Escape. Ported from xrsps,
// which took it from rsmod's `SailingHelmActions.kt` and `BoatNavigation.kt`
// (https://github.com/rsmod/rsmod, ISC) and their live traces.
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { BoatManager } = require("../../../src/main/typescript/elvarg/game/content/sailing/BoatManager");
const { BoatMoveMode } = require("../../../src/main/typescript/elvarg/game/content/sailing/Boat");
const { Animation } = require("../../../src/main/typescript/elvarg/game/model/Animation");
const { Location } = require("../../../src/main/typescript/elvarg/game/model/Location");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const {
  VARBIT,
  MOVE_MODE,
  HELM_STATUS,
  SIDEPANEL_GROUP,
  SIDEPANEL_FACILITIES_CHILD,
  SCRIPT_HELM_UPDATE,
  SCRIPT_SIDEBUTTON_SWITCH,
  content,
  setVarbit,
  getVarbit,
  playSound,
  animateDeckLocs,
  animateSails,
  setSailClothOps,
  isHelm,
  boatAnim,
  boatType,
} = require("./sailingContent");
const { windFor, canTrim, trimSails, isTrimmed } = require("./trim");
const { Task } = require("../../../src/main/typescript/elvarg/game/task/Task");
const { TaskManager } = require("../../../src/main/typescript/elvarg/game/task/TaskManager");

const HELM_LOCKED_IN = 3;
/** While navigating, the helm and the helmsman replay their loop every 10 ticks (rsprox). */
const HELM_LOOP_TICKS = 10;
const SOUND_HELM_ENTER = 10792;
const SOUND_HELM_EXIT = 10793;
const SOUND_SAIL_RAISE = 10831;
const SOUND_SAIL_LOWER = 10833;

const SAIL_MODES = {
  full: { varbit: MOVE_MODE.FULL, boat: BoatMoveMode.Full },
  half: { varbit: MOVE_MODE.HALF, boat: BoatMoveMode.Half },
  reverse: { varbit: MOVE_MODE.REVERSE, boat: BoatMoveMode.Reverse },
  stop: { varbit: MOVE_MODE.STOPPED, boat: BoatMoveMode.Stopped },
};

/**
 * The helm facility's three sidepanel buttons (sailing facility dbrows 8121-8123). Each shows
 * one op whose label depends on the move mode, so the action depends on both:
 *
 * | mode        | button 0     | button 1     | button 2     |
 * | 0 stopped   | Set sails    | Reverse      | Set sails    |
 * | 1 slow      | Un-set sails | Un-set sails | Raise speed  |
 * | 2 fast      | Un-set sails | Lower speed  | Raise speed  |
 * | 3 reversing | Stop boat    | Reverse      | Stop boat    |
 * | 4 moored    | Set sails    | Reverse      | Set sails    |
 */
function sailButtonTransition(slot, moveMode) {
  const atRest = moveMode === MOVE_MODE.STOPPED || moveMode === MOVE_MODE.MOORED;
  switch (slot) {
    case 0:
      return atRest ? "full" : "stop";
    case 1:
      if (atRest) return "reverse";
      if (moveMode === MOVE_MODE.FULL) return "half";
      if (moveMode === MOVE_MODE.HALF) return "stop";
      return undefined; // already reversing
    case 2:
      if (atRest) return "half";
      if (moveMode === MOVE_MODE.HALF) return "full";
      if (moveMode === MOVE_MODE.REVERSE) return "stop";
      return undefined; // already at full speed
    default:
      return undefined;
  }
}

/**
 * Plays one of the boat type's loc animations (boats.json `anims`, per hull model) on its sails
 * or helm; one not captured for this boat is skipped rather than guessed from another model.
 */
/** The sails' state for a move mode: full and half are up; stopped, moored and reversing are down. */
function sailState(moveMode) {
  if (moveMode === MOVE_MODE.FULL) return "full";
  if (moveMode === MOVE_MODE.HALF) return "half";
  return "down";
}

function setSailMode(player, boat, mode) {
  const previous = getVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE);
  boat.moveMode = SAIL_MODES[mode].boat;
  setVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE, SAIL_MODES[mode].varbit);
  setVarbit(player, VARBIT.SIDEPANEL_SAIL_BUTTON_TOGGLED, mode === "stop" ? 0 : 1);
  if (mode === "full" || mode === "half") windFor(boat);
  setSailClothOps(player, boat, mode !== "stop", canTrim(boat));
  animateSails(player, boat, sailState(previous), sailState(SAIL_MODES[mode].varbit));
  if (mode === "full" || mode === "half") {
    playSound(player, SOUND_SAIL_RAISE);
  } else if (mode === "stop") {
    playSound(player, SOUND_SAIL_LOWER);
  }
}

/**
 * The helm's animations for the boat's size (boats.json `anims.helm`, as captured for the skiff
 * and sloop): taking it plays `active` on the helmsman and the helm loc, and every 10 ticks after
 * both replay `loop` for as long as they navigate, except while the sails are trimmed.
 */
function playHelm(player, boat, name) {
  const helm = boatAnim(boat, "helm");
  if (!helm) return;
  if (helm.player?.[name] !== undefined) player.performAnimation(new Animation(helm.player[name]));
  if (helm[name] !== undefined) animateDeckLocs(player, boat, isHelm, helm[name]);
}

function loopHelm(player, boat) {
  let ticks = 0;
  TaskManager.submit(new (class extends Task {
    constructor() { super(1, player, false); }
    execute() {
      if (boat.helmPlayerId !== player.getIndex() || !BoatManager.getSpec(boat) || Sailing.instanceAboard(player) !== boat) {
        this.stop();
        return;
      }
      if (++ticks % HELM_LOOP_TICKS === 0 && !isTrimmed(boat)) playHelm(player, boat, "loop");
    }
  })());
}

/**
 * At the helm the helmsman faces the bow, three tiles ahead (rsprox: on the skiff's helm tile
 * 4,5 the player faces 4,2), not the wheel they clicked.
 */
function faceBow(player) {
  const at = player.getLocation();
  player.setPositionToFace(new Location(at.getX(), at.getY() - 3, at.getZ()));
}

function takeHelm(player, boat) {
  boat.helmPlayerId = player.getIndex();
  boat.heading = boat.angle;
  const sender = player.getPacketSender();
  setVarbit(player, VARBIT.FACILITY_LOCKEDIN, HELM_LOCKED_IN);
  playHelm(player, boat, "active");
  faceBow(player);
  loopHelm(player, boat);
  sender.sendInterfaceScript(SCRIPT_SIDEBUTTON_SWITCH, [0]);
  playSound(player, SOUND_HELM_ENTER);
  if (getVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE) === MOVE_MODE.STOPPED) {
    setVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE, MOVE_MODE.MOORED);
  }
  setVarbit(player, VARBIT.SIDEPANEL_PLAYER_AT_HELM, 1);
  setVarbit(player, VARBIT.SIDEPANEL_HELM_STATUS, HELM_STATUS.NAVIGATING);
  sender.sendInterfaceScript(SCRIPT_HELM_UPDATE, ["", 0, player.getUsername(), 1]);
  player.sendMessage("You take the helm. Click the water to steer.");
}

function leaveHelm(player, boat) {
  const moveMode = getVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE);
  boat.helmPlayerId = undefined;
  boat.moveMode = BoatMoveMode.Stopped;
  boat.heading = boat.angle;
  setVarbit(player, VARBIT.FACILITY_LOCKEDIN, 0);
  const inactive = boatAnim(boat, "helm")?.inactive;
  if (inactive !== undefined) animateDeckLocs(player, boat, isHelm, inactive);
  setSailClothOps(player, boat, false);
  animateSails(player, boat, sailState(moveMode), "down");
  player.performAnimation(Animation.DEFAULT_RESET_ANIMATION);
  playSound(player, SOUND_HELM_EXIT);
  setVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE, MOVE_MODE.STOPPED);
  setVarbit(player, VARBIT.SIDEPANEL_PLAYER_AT_HELM, 0);
  setVarbit(player, VARBIT.SIDEPANEL_HELM_STATUS, HELM_STATUS.FREE);
  setVarbit(player, VARBIT.SIDEPANEL_SAIL_BUTTON_TOGGLED, 0);
  player.getPacketSender().sendInterfaceScript(SCRIPT_HELM_UPDATE, ["", 0, "", 1]);
}

/**
 * The helm is navigated from its boat type's stand tile (boats.json `helmStand`, from the wheel),
 * which its animations are made for (rsprox): the raft's own helm tile, the tile south of the
 * skiff's, and south-east of the sloop's. Walk there first.
 */
function routeToHelm(event) {
  const option = event.definition?.getInteractions()?.[event.clickType - 1];
  if (event.definition?.getName() !== "Helm" || option !== "Navigate") return;
  const boat = Sailing.instanceAboard(event.player);
  if (!boat) return;
  const type = boatType(BoatManager.getSpec(boat)?.type);
  const stand = type?.helmStand;
  if (!stand) return;
  const helm = event.object.getLocation();
  const x = helm.getX() + stand.x;
  const y = helm.getY() + stand.y;
  const walkable = type.walkableDeck.some((tile) => boat.deckBaseX + tile.x === x && boat.deckBaseY + tile.y === y);
  if (!walkable) return;
  event.destination = { x, y, z: helm.getZ() };
}

/**
 * The sail cloth is used from a deck tile beside it (live turns the player to face it), the
 * nearest one to the player; walking to the loc itself would stop on its tile, out of reach.
 * Whoever is steering uses it from the helm, without walking off it.
 */
function routeToSails(event) {
  const option = event.definition?.getInteractions()?.[event.clickType - 1];
  if (event.definition?.getName() !== "Sails" || !["Trim", "Set", "Un-set"].includes(option)) return;
  const boat = Sailing.instanceAboard(event.player);
  if (!boat) return;
  const sails = event.object.getLocation();
  if (boat.helmPlayerId === event.player.getIndex()) {
    event.destination = { ...event.sourceLocation };
    return;
  }
  const walkable = (boatType(BoatManager.getSpec(boat)?.type)?.walkableDeck ?? [])
    .map((tile) => ({ x: boat.deckBaseX + tile.x, y: boat.deckBaseY + tile.y }));
  const from = event.sourceLocation;
  const beside = walkable
    .filter((tile) => Math.abs(tile.x - sails.getX()) + Math.abs(tile.y - sails.getY()) === 1)
    .sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
  if (beside) event.destination = { x: beside.x, y: beside.y, z: sails.getZ() };
}

function routeOnDeck(event) {
  leaveHelmForOtherLoc(event);
  routeToHelm(event);
  routeToSails(event);
}

/**
 * Clicking any other loc from the helm leaves it, which stops the boat (rsprox, a salvaging hook's
 * Deploy from the helm: facility_lockedin 3->0, then at_helm 1->0 and the move mode to 0). The
 * helm itself and the sail cloth (Trim is captured from the helm) keep the helmsman there.
 */
function leaveHelmForOtherLoc(event) {
  const { player } = event;
  const boat = Sailing.instanceAboard(player);
  if (!boat || boat.helmPlayerId !== player.getIndex()) return;
  const name = event.definition?.getName();
  if (name === "Helm" || name === "Sails") return;
  leaveHelm(player, boat);
}

function toggleHelm({ player, object }) {
  const boat = Sailing.instanceAboard(player);
  if (!boat) return;
  if (boat.helmPlayerId === player.getIndex()) {
    leaveHelm(player, boat);
    // Live turns the helmsman to the wheel on the tick they let go (rsprox: face_angle 768 on the
    // sloop, 1024 on the skiff), with the helm animation's reset. Here the reset goes first and
    // the turn a tick later, so they don't spin round still holding the wheel.
    faceBow(player);
    const wheel = object?.getLocation?.();
    if (wheel) {
      TaskManager.submit(new (class extends Task {
        constructor() { super(1, player, false); }
        execute() {
          this.stop();
          if (Sailing.instanceAboard(player) === boat && boat.helmPlayerId !== player.getIndex()) player.setPositionToFace(wheel);
        }
      })());
    }
  } else if (boat.helmPlayerId === undefined) {
    takeHelm(player, boat);
  }
}

/** Escape sinks the boat, so it asks first; the choice is checked again in case they left. */
function escapeBoat(api, { player }) {
  if (!Sailing.instanceAboard(player)) return;
  api.sendMultiChatboxPrompt(
    player,
    "Escape? Your boat will sink until a shipwright recovers it.",
    "Yes, abandon ship.",
    () => {
      if (!Sailing.instanceAboard(player)) return;
      Sailing.escape(player);
      player.sendMessage("Your boat sinks, and you make it back to shore.");
    },
    "No.",
    () => {},
  );
}

function clickSailButton(event) {
  if (event.groupId !== SIDEPANEL_GROUP || event.childId !== SIDEPANEL_FACILITIES_CHILD) return;
  event.handled = true;
  const { player } = event;
  const boat = Sailing.instanceAboard(player);
  if (!boat || boat.helmPlayerId !== player.getIndex()) return;
  const moveMode = getVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE);
  const mode = sailButtonTransition(event.slot ?? -1, moveMode);
  if (mode) {
    setSailMode(player, boat, mode);
  } else if (event.slot === 2 && moveMode === MOVE_MODE.FULL) {
    player.sendMessage("The boat is already going as fast as it can.");
  }
}

/**
 * The sail cloth's Set and Un-set: the side panel's set (full sail) and un-set, for whoever is at
 * the helm, as live (rsprox); with nobody steering, the sails can't be adjusted.
 */
function adjustSails(mode) {
  return ({ player }) => {
    const boat = Sailing.instanceAboard(player);
    if (!boat) return;
    keepFacingBow(player, boat);
    const helmsman = boat.helmPlayerId === undefined ? undefined : World.getPlayers().get(boat.helmPlayerId);
    if (!helmsman || Sailing.instanceAboard(helmsman) !== boat) {
      player.sendMessage("You or a crewmate must be navigating at the helm to adjust the sails.");
      return;
    }
    const moveMode = getVarbit(helmsman, VARBIT.SIDEPANEL_BOAT_MOVE_MODE);
    const set = moveMode !== MOVE_MODE.STOPPED && moveMode !== MOVE_MODE.MOORED;
    if (set !== (mode === "stop")) return;
    setSailMode(helmsman, boat, mode);
  };
}

/**
 * The helmsman using the sail cloth from the helm keeps facing the bow (rsprox: Trim's face angle
 * 0 in 315 of 319 clicks), not the cloth the click turned them to, which on the sloop is behind.
 */
function keepFacingBow(player, boat) {
  if (boat.helmPlayerId === player.getIndex()) faceBow(player);
}

/** The sail cloth's Trim: catches a gust for whoever is at the helm (trim.js). */
function trim({ player }) {
  const boat = Sailing.instanceAboard(player);
  if (!boat) return;
  keepFacingBow(player, boat);
  const helmsman = boat.helmPlayerId === undefined ? undefined : World.getPlayers().get(boat.helmPlayerId);
  if (!helmsman || Sailing.instanceAboard(helmsman) !== boat) {
    player.sendMessage("You or a crewmate must be navigating at the helm to adjust the sails.");
    return;
  }
  if (!trimSails(helmsman, boat)) player.sendMessage("The sails are already catching the wind well.");
}

/** rsmod `enableSailIfNeededForHeading`: the first heading while moored raises full sail. */
function raiseSailForHeading(player, boat) {
  const moveMode = getVarbit(player, VARBIT.SIDEPANEL_BOAT_MOVE_MODE);
  if (moveMode === MOVE_MODE.MOORED || moveMode === MOVE_MODE.STOPPED) setSailMode(player, boat, "full");
}

module.exports = {
  name: "SailingHelm",
  members: true,
  sailButtonTransition,
  sailState,
  register(api) {
    content();
    api.onObjectInteraction("Helm", {
      Navigate: toggleHelm,
      "Stop-navigating": toggleHelm,
      Escape: (event) => escapeBoat(api, event),
    });
    api.onObjectInteraction("Sails", { Trim: trim, Set: adjustSails("full"), "Un-set": adjustSails("stop") });
    api.onObjectRoute(routeOnDeck);
    api.onInterfaceActionClick(clickSailButton);
    BoatManager.onHeadingSet(raiseSailForHeading);
  },
};
