/**
 * The way to Mac (Wiki: Mac; rsprox captures 3143-3146), west of the Warriors' Guild basement
 * ladder. Each step needs a 99:
 *
 * - Evergreen tree (Woodcutting, an axe): "You swing your axe at the tree.", and two ticks
 *   later it is a stump for about ten ticks. The stump is jumped with 99 Agility (agility
 *   shortcut data).
 * - Rockslide (Mining, a pickaxe): "You swing your pick at the rock.", then the mined rockslide,
 *   jumped with 99 Defence (agility shortcut data).
 * - Boulder (Strength): "You push the boulder out of the way."; it can be walked around.
 * - Old log (Crafting and Construction): Make-raft, then Board the log raft: "You board the raft
 *   with trepidation...", the screen fades, and three ticks later "You fall off the raft, onto
 *   the beach of the little island, but the raft floats away."
 * - The row boat back: "Do you want to leave the island?", "You board the boat and wave to
 *   Mac.", and two ticks later "You row across the lake." on the far shore.
 *
 * The refusals for a missing 99 and the raft's making have no capture.
 */
const Capes = require("./Common.SkillCapes");

const OBSTACLE_TICKS = 2;
const STUMP_TICKS = 10;
const RAFT_VARBIT = "max_multi_log";
const ISLAND_BEACH = [2793, 3538, 0];
const FAR_SHORE = [2726, 3589, 0];
const RAFT_MOVE_TICKS = 3;
const BOAT_MOVE_TICKS = 2;
const CHOP_SPAM = "You swing your axe at the tree.";
const MINE_SPAM = "You swing your pick at the rock.";
const NO_AXE = "You need an axe to chop down this tree. You do not have an axe which you have the woodcutting level to use.";
const NO_PICKAXE = "You need a pickaxe to mine this rock. You do not have a pickaxe which you have the Mining level to use.";
const PUSH_SOUND = 69;

// The fade overlay, as the magic mushtrees play it.
const OVERLAY_ATMOSPHERE_UID = (161 << 16) | 1;
const FADE_OVERLAY = 174;
const FADE_SCRIPT = 948;
const FADE_CYCLES = 50;

let api;
const LOCS = {};
let BOULDER;

function fade(player, out) {
  const args = out ? [0, 255, 0, 0, FADE_CYCLES] : [0, 0, 0, 255, FADE_CYCLES];
  player.getPacketSender().sendSubInterface(OVERLAY_ATMOSPHERE_UID, FADE_OVERLAY, 1, { postScripts: [{ scriptId: FADE_SCRIPT, args }] });
}

function needs99(player, skillKey, verb) {
  const skill = Capes.core.Skill[skillKey];
  if (Capes.baseLevel(player, skill) >= Capes.MAX_LEVEL) return true;
  player.sendMessage(`You need a ${skill.getName()} level of 99 to ${verb}.`);
  return false;
}

/** Swaps the loc for another for a while, then puts it back (the stump, the mined rockslide). */
function swapFor(object, id, ticks) {
  const { GameObject, ObjectManager, Location } = Capes.core;
  const location = object.getLocation();
  const temp = new GameObject(id, new Location(location.getX(), location.getY(), location.getZ()), object.getType(), object.getFace(), object.getPrivateArea?.() ?? null);
  ObjectManager.deregister(object, false);
  ObjectManager.register(temp, true);
  Capes.later(null, ticks, () => {
    ObjectManager.deregister(temp, false);
    ObjectManager.register(object, true);
  });
}

function chopEvergreen(event) {
  const { player, object } = event;
  if (!needs99(player, "WOODCUTTING", "chop down this tree")) return true;
  const request = { player, axe: null };
  api.emitCustomEvent("woodcutting:axe", request);
  if (!request.axe) {
    Capes.messageBox(player, NO_AXE);
    return true;
  }
  player.performAnimation(new Capes.core.Animation(request.axe.animationId));
  player.sendMessage(CHOP_SPAM);
  Capes.later(player, OBSTACLE_TICKS, () => {
    player.performAnimation(Capes.core.Animation.DEFAULT_RESET_ANIMATION);
    swapFor(object, LOCS.stump, STUMP_TICKS);
  });
  return true;
}

function mineRockslide(event) {
  const { player, object } = event;
  if (!needs99(player, "MINING", "mine this rock")) return true;
  const request = { player, pickaxe: null };
  api.emitCustomEvent("mining:best-pickaxe", request);
  if (!request.pickaxe) {
    Capes.messageBox(player, NO_PICKAXE);
    return true;
  }
  player.performAnimation(request.pickaxe.animation);
  player.sendMessage(MINE_SPAM);
  Capes.later(player, OBSTACLE_TICKS + 1, () => {
    player.performAnimation(Capes.core.Animation.DEFAULT_RESET_ANIMATION);
    swapFor(object, LOCS.minedRockslide, STUMP_TICKS);
  });
  return true;
}

function pushBoulder(event) {
  const { player, npc } = event;
  if (!needs99(player, "STRENGTH", "push this boulder")) return true;
  player.setPositionToFace(npc.getLocation());
  player.performAnimation(new Capes.core.Animation(Capes.seqId("human_push")));
  player.getPacketSender().sendSound(PUSH_SOUND, 1, 0);
  player.sendMessage("You push the boulder out of the way.");
  return true;
}

function raftVarbit(player, value) {
  const id = Capes.core.CacheDefinitions.getVarbitId(RAFT_VARBIT);
  if (Number.isInteger(id)) player.getPacketSender().sendVarbit(id, value);
}

/** The ride: a fade out, the move, a fade back in. */
function cross(player, to, moveTicks, onArrival) {
  const movement = player.getMovementQueue();
  movement.setBlockMovement(true).reset();
  fade(player, true);
  Capes.later(player, moveTicks, () => {
    player.moveTo(new Capes.core.Location(...to));
    onArrival();
    fade(player, false);
    movement.setBlockMovement(false);
    Capes.later(player, 2, () => player.getPacketSender().closeSubInterface(OVERLAY_ATMOSPHERE_UID));
  });
}

function oldLog(event) {
  const { player } = event;
  const option = String(event.option ?? event.definition?.getInteractions?.()?.[event.clickType - 1] ?? "").toLowerCase();
  if (option === "make-raft") {
    if (!needs99(player, "CRAFTING", "make a raft") || !needs99(player, "CONSTRUCTION", "make a raft")) return true;
    raftVarbit(player, 1);
    player.sendMessage("You make a raft out of the old log.");
    return true;
  }
  if (option === "board") {
    player.sendMessage("You board the raft with trepidation...");
    cross(player, ISLAND_BEACH, RAFT_MOVE_TICKS, () => {
      raftVarbit(player, 0);
      player.sendMessage("You fall off the raft, onto the beach of the little island, but the raft floats away.");
    });
    return true;
  }
  return false;
}

function rowBoat({ player }) {
  api.sendMultiChatboxPrompt(player, "Do you want to leave the island?",
    "Yes", () => {
      player.sendMessage("You board the boat and wave to Mac.");
      cross(player, FAR_SHORE, BOAT_MOVE_TICKS, () => player.sendMessage("You row across the lake."));
    },
    "No", () => {});
  return true;
}

function resetRaft({ player }) {
  raftVarbit(player, 0);
}

function resolveIds() {
  Object.assign(LOCS, {
    evergreen: Capes.core.CacheDefinitions.getLocId("max_evergreen"),
    stump: Capes.core.CacheDefinitions.getLocId("max_treestump"),
    rockslide: Capes.core.CacheDefinitions.getLocId("max_rockslide"),
    minedRockslide: Capes.core.CacheDefinitions.getLocId("max_rockslide1"),
    log: Capes.core.CacheDefinitions.getLocId("max_log"),
    boat: Capes.core.CacheDefinitions.getLocId("max_boat"),
  });
  BOULDER = Capes.core.CacheDefinitions.getNpcId("max_boulder");
}

module.exports = function attachMacIsland(pluginApi) {
  api = pluginApi;
  resolveIds();
  api.onObjectFirstClick(LOCS.evergreen, chopEvergreen);
  api.onObjectFirstClick(LOCS.rockslide, mineRockslide);
  api.onObjectFirstClick(LOCS.log, oldLog);
  api.onObjectFirstClick(LOCS.boat, rowBoat);
  api.onNpcFirstClick(BOULDER, pushBoulder);
  api.onPlayerLogin(resetRaft);
};

module.exports._test = { LOCS, chopEvergreen, mineRockslide, oldLog, rowBoat, pushBoulder };
