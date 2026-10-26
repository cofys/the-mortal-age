"use strict";

// Growth/owned picking adapted from LostCity macro_event_triffid.rs2 (MIT).
// Current OSRS keeps dismissal and removes the old hostile stage. See SOURCES.md.
const GROW_ANIMATION = 348;
const GROWTH_MS = 45 * 600;

function addDefinition(api, { definitions }) {
  definitions.push({ id: api.core.NpcIdentifiers.STRANGE_PLANT, kind: "plant", stationary: true,
    onSpawn: grow.bind(null, api), talk: pick.bind(null, api) });
}

function grow(api, active) {
  active.npc.performAnimation(new api.core.Animation(GROW_ANIMATION));
}

function pick(api, active, { valid, serve }) {
  const player = active.player;
  if (!valid(active, player)) return;
  if (Date.now() - active.startedAt < GROWTH_MS) {
    player.sendMessage("The fruit isn't ready to be picked yet...");
    return;
  }
  // The Wiki keeps a dropped fruit visible only to its picker, though it is tradeable.
  if (serve(active, [api.core.ItemIdentifiers.STRANGE_FRUIT], null, { alwaysPrivate: true })) {
    player.sendMessage("You pick the fruit from the plant.");
  }
}

module.exports = { addDefinition };
