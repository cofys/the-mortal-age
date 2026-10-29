/**
 * Animation stall exceptions (https://oldschool.runescape.wiki/w/Animation_stall).
 *
 * Core measures every swing from the cache itself: NpcAnimationScanner.getSequenceStall reads
 * the seq config the client uses to decide whether it withholds the actor's steps while the
 * animation plays, so a stalling attack animation needs no row here. This plugin is the layer
 * for the attacks that config cannot express — the Wiki's own list is explicitly not
 * exhaustive, and a weapon whose seq carries masks looks free to the client even when live
 * locks the player.
 *
 * Rows live in data/animation-stalls.json, keyed by animation id or by wielded weapon id.
 *
 * Not `members: true`: this tunes a mechanic rather than adding content, and the members
 * weapons it names cannot be wielded on a free-to-play world anyway.
 */
const STALLS = require("./data/animation-stalls.json");

let core = null;

/** The row that governs this swing: the animation's own, else the wielded weapon's. */
function stallRow(event) {
  const byAnimation = STALLS.animations[event.animationId];
  if (byAnimation) return byAnimation;
  const weaponId = event.player.getEquipment().get(core.Equipment.WEAPON_SLOT)?.getId?.();
  return STALLS.weapons[weaponId] ?? null;
}

function applyStallDefinition(event) {
  const row = stallRow(event);
  if (row === null) return;
  if (row.kind) event.kind = row.kind;
  if (Number.isInteger(row.ticks)) event.ticks = row.ticks;
  if (typeof row.holdsHits === "boolean") event.holdsHits = row.holdsHits;
}

module.exports = {
  name: "AnimationStalls",
  register(api) {
    core = api.core;
    api.onAnimationStall(applyStallDefinition);
  },
};
