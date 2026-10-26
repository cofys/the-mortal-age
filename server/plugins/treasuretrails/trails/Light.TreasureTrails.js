"use strict";

// Light boxes (master; Wiki "Light box" and the light box guide): a 5x5 grid of lights and switches
// A-H, solved when every light is on. The client draws interface light_puzzle from varp
// trail_lights, one bit per light, a set bit drawn unlit, so 0 is solved (cs2 1339).
// Which lights a switch toggles is in neither the cache nor the Wiki. Live captures (rsprox.net,
// rev 227, nine boxes) show every box with its own masks, a switch toggling about 35% of the
// lights, so each box gets 8 random masks, and starts a few presses from solved, which keeps it
// solvable. The box keeps its masks and lights, so it resumes where it was left.
const Runtime = require("./Runtime.TreasureTrails");
const Dialogue = require("./Dialogue.TreasureTrails");
const { SOLVED, ALREADY_SOLVED } = require("./Puzzle.TreasureTrails");
const LIGHTS = 25;
const SWITCHES = 8;
const ALL = (1 << LIGHTS) - 1;
// Each light is on a switch's mask with this chance (captured switches average 8.7 of 25 lights).
const MASK_DENSITY = 0.35;
let api;
let core;

function randomMask(random) {
  let mask = 0;
  for (let light = 0; light < LIGHTS; light++) if (random() < MASK_DENSITY) mask |= 1 << light;
  return mask || 1 << Math.floor(random() * LIGHTS);
}

/** A fresh box: 8 distinct masks, and the lights a few presses from all lit (never already solved). */
function newBox(random = Math.random) {
  const masks = [];
  while (masks.length < SWITCHES) {
    const mask = randomMask(random);
    if (!masks.includes(mask)) masks.push(mask);
  }
  let unlit = 0;
  while (unlit === 0) for (const mask of masks) if (random() < 0.5) unlit ^= mask;
  return { masks, unlit };
}

function press(box, index) {
  return (box.unlit ^ box.masks[index]) & ALL;
}

function buttonIds() {
  return Array.from({ length: SWITCHES }, (_, index) => core.CacheDefinitions.getComponentId(`light_puzzle:button${index + 1}`));
}

function boxTrail(player, slot = null) {
  for (const trail of Runtime.trails(player)) {
    const boxSlot = Runtime.lightSlot(player, trail);
    if (boxSlot < 0 || slot != null && boxSlot !== slot) continue;
    const item = player.getInventory().getItems()[boxSlot];
    return { ...trail, item, slot: boxSlot, state: item.getMetaValue(Runtime.metaKey(trail.tier)) };
  }
  return null;
}

/** The box's lights, made on first opening; the box carries them from then on. */
function lightsOf(trail) {
  if (Array.isArray(trail.state.masks)) return trail.state;
  const state = { ...trail.state, ...newBox() };
  trail.item.setMetaValue(Runtime.metaKey(trail.tier), state);
  return state;
}

function open(event) {
  const { player } = event;
  const trail = boxTrail(player, event.slot);
  if (!trail) return false;
  if (trail.state.solved) { Dialogue.mesbox(player, ALREADY_SOLVED); return true; }
  const state = lightsOf(trail);
  const sender = player.getPacketSender();
  player.sendMessage("You open the light box's control panel.");
  sender.sendConfig(core.CacheDefinitions.getVarpId("trail_lights"), state.unlit);
  sender.sendInterface(core.CacheDefinitions.getInterfaceId("light_puzzle"));
  for (const button of buttonIds()) sender.sendInterfaceFlags(button, 1 << 1);
  return true;
}

function click({ player, buttonId }) {
  const trail = boxTrail(player);
  const index = buttonIds().indexOf(buttonId);
  if (!trail || index < 0 || !Array.isArray(trail.state.masks)) return;
  if (trail.state.solved) return;
  const unlit = press(trail.state, index);
  trail.item.setMetaValue(Runtime.metaKey(trail.tier), { ...trail.state, unlit, solved: unlit === 0 });
  player.getInventory().refreshItems();
  player.getPacketSender().sendConfig(core.CacheDefinitions.getVarpId("trail_lights"), unlit);
  if (unlit === 0) Dialogue.mesbox(player, SOLVED);
}

module.exports = function attachLights(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onItemAction("Light box", { Open: open });
  api.onInterfaceActionButton(buttonIds(), click);
};

Object.assign(module.exports, { LIGHTS, SWITCHES, ALL, newBox, press, open, click });
