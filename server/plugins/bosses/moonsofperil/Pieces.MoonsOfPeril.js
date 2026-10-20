/**
 * The pieces a special puts in one player's arena (docs/moons-of-peril.md): NPCs and locs only
 * they see, cleared together when the special ends, and the captured knock-back that moves them
 * to the special's tile. Specials keep them in the fight's `state`.
 */
const Common = require("./Common.MoonsOfPeril");

/** An NPC only the fighter sees, at an offset from the Moon, kept for clean-up. */
function spawnNpc(fight, id, offset, { face = null, anim = null } = {}) {
  const at = Common.tileAt(fight.moon, offset);
  const npc = Common.api.spawnNpc({ id, x: at.getX(), y: at.getY(), z: at.getZ(), wanderRadius: 0, owner: fight.player, ownerOnly: true });
  if (!npc) return null;
  npc.__skipDefaultRespawn = true;
  npc.__moonFight = fight;
  npc.getMovementQueue().setBlockMovement(true);
  // Jaguars, blocks and the rest never turn to whoever hits them.
  npc.setFlag(KEEP_FACING_FLAG, true);
  if (face) npc.setPositionToFace(Common.tileAt(fight.moon, face));
  if (anim != null) Common.animate(npc, anim);
  (fight.state.npcs ??= new Set()).add(npc);
  return npc;
}

function removeNpc(fight, npc) {
  if (!npc) return;
  fight.state.npcs?.delete(npc);
  if (npc.isRegistered?.()) Common.api.removeNpc(npc);
}

/** A loc only the fighter sees, at an offset from the Moon, kept for clean-up. */
function addLoc(fight, id, offset, { shape = 10, rotation = 0, anim = null } = {}) {
  const loc = Common.personalLoc(id, Common.tileAt(fight.moon, offset), shape, rotation);
  Common.addLoc(fight.player, loc);
  if (anim != null) Common.locAnim(fight.player, loc, anim);
  (fight.state.locs ??= new Set()).add(loc);
  return loc;
}

function removeLoc(fight, loc) {
  if (!loc || !fight.state.locs?.has(loc)) return;
  fight.state.locs.delete(loc);
  if (fight.player.isRegistered()) Common.removeLoc(fight.player, loc);
}

/** Everything the special left: its NPCs and locs go. */
function clear(fight) {
  for (const npc of [...(fight.state.npcs ?? [])]) removeNpc(fight, npc);
  for (const loc of [...(fight.state.locs ?? [])]) removeLoc(fight, loc);
}

/** The captured knock-back: animation 9799, spotanim 245, sound 3201, an exact move over 60 cycles. */
function knockBack(fight, offset) {
  const { player } = fight;
  const { ForceMovement, ForceMovementTask, TaskManager, Location } = Common.core;
  const to = Common.tileAt(fight.moon, offset);
  const from = player.getLocation().clone();
  player.getMovementQueue().reset();
  player.performGraphic(Common.graphic(KNOCK.spot, { height: KNOCK.height }));
  Common.sound(player, KNOCK.sound);
  const dx = to.getX() - from.getX();
  const dy = to.getY() - from.getY();
  if (dx === 0 && dy === 0) return;
  const movement = new ForceMovement(from, new Location(dx, dy, 0), 0, KNOCK.cycles, direction(dx, dy), KNOCK.anim);
  TaskManager.submit(new ForceMovementTask(player, KNOCK.ticks, movement));
}

/** The way the player faces while thrown: the main axis of the move (0 north, 1 east, 2 south, 3 west). */
function direction(dx, dy) {
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 0 : 2;
  return dx > 0 ? 1 : 3;
}

const KEEP_FACING_FLAG = "combat:keep-facing";

const KNOCK = { anim: 9799, spot: 245, height: 124, sound: 3201, cycles: 60, ticks: 2 };

/** A tile offset [dx, dy] that the player is standing on now. */
const playerOffset = (fight) => Common.offsetOf(fight.moon, fight.player.getLocation());

module.exports = { KEEP_FACING_FLAG, spawnNpc, removeNpc, addLoc, removeLoc, clear, knockBack, playerOffset };
