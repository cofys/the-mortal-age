"use strict";

/**
 * Chatter.Arrival — NPC idle rumor chatter.
 *
 * Every few minutes a townsfolk somewhere in a capital mutters a rumor drawn
 * from the live rumor engine — overhead forceChat, for whoever is standing
 * nearby. The lines change when the story flags change: the world's state is
 * readable in the street, with no quest attached.
 *
 * Token-lean by design: one chatter event per cycle across ALL capitals (not
 * one per city), only when a real player is near enough to hear it, and the
 * Task scans NPCs only on the cycle it might speak.
 */

const Common = require("./Common.Arrival");
const Rumors = require("./Rumors.Arrival");

let core = null;

// Names allowed to carry street rumors. Guards mutter about the crown;
// townsfolk mutter about everything else.
const CHATTER_NAMES = ["Man", "Woman", "Guard", "Dwarf", "Town crier"];

// The task ticks every CHATTER_CHECK_TICKS; a chatter event fires when the
// countdown hits zero, then resets to a fresh random window (~2-4 minutes).
const CHATTER_CHECK_TICKS = 20;
const CHATTER_MIN_WINDOW = 6;
const CHATTER_MAX_WINDOW = 12;

let countdown = 4;

function candidatesIn(zone) {
  const found = [];
  for (const npc of core.World.getNpcs()) {
    if (!npc) continue;
    const name = npc.getDefinition?.()?.getName?.();
    if (!CHATTER_NAMES.includes(name)) continue;
    const loc = npc.getLocation?.();
    if (loc && Common.inRect(loc, zone.rect)) found.push(npc);
  }
  return found;
}

function chatterTick() {
  if (--countdown > 0) return;
  countdown =
    CHATTER_MIN_WINDOW +
    Math.floor(Math.random() * (CHATTER_MAX_WINDOW - CHATTER_MIN_WINDOW + 1));

  const zone = Common.pick(Common.CAPITAL_ZONES);
  const candidates = candidatesIn(zone);
  if (candidates.length === 0) return;

  const speaker = Common.pick(candidates);
  const loc = speaker.getLocation();
  // Only mutter when someone is actually there to hear it.
  if (!Common.realPlayerNear(core, loc, 18)) return;

  const rumor = Rumors.drawRumor(zone.kingdomId);
  if (rumor) speaker.forceChat(rumor);
}

function start() {
  core.TaskManager.submit(
    new (class extends core.Task {
      constructor() {
        super(CHATTER_CHECK_TICKS, undefined, false);
      }
      execute() {
        chatterTick();
      }
    })()
  );
}

module.exports = function attachChatter(api) {
  core = api.core;
  api.onServerStartup(start);
};
