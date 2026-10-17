"use strict";

/**
 * Each gorilla's fight: its attack style, missed hits, and the damage it has taken off-prayer.
 * Kept per NPC object, so a respawn (a new NPC) starts over.
 */
const { DEMONIC_FAMILIES, DEMONIC_IDS, TORTURED_IDS, STYLES, KINDS, STYLE_CHANGE_SHOUT } = require("./Data.DemonicGorillas");

const states = new WeakMap();

function kindOf(npcId) {
  if (DEMONIC_IDS.includes(npcId)) return "demonic";
  if (TORTURED_IDS.includes(npcId)) return "tortured";
  return null;
}

/** The demonic gorilla ids of this one's colour, by the style each protects against. */
function familyOf(npcId) {
  return DEMONIC_FAMILIES.find((family) => STYLES.some((style) => family[style] === npcId)) ?? null;
}

/** The style a demonic gorilla protects against: its id says it (and the cache draws the icon). */
function protecting(npc) {
  const family = familyOf(npc.getId());
  return family ? STYLES.find((style) => family[style] === npc.getId()) : null;
}

function randomStyle(random, except = null) {
  const choices = STYLES.filter((style) => style !== except);
  return choices[Math.floor(random() * choices.length)];
}

function stateOf(npc, random = Math.random) {
  let state = states.get(npc);
  if (!state) {
    state = { kind: kindOf(npc.getRealId()) ?? kindOf(npc.getId()), style: randomStyle(random), misses: 0, offPrayerHits: 0, offPrayerDamage: 0, unreachable: 0 };
    states.set(npc, state);
  }
  return state;
}

/** A missed hit in its current style: enough of them and it changes to one of the other two. */
function countMiss(npc, state, random = Math.random) {
  state.misses++;
  if (state.misses >= KINDS[state.kind].missesPerSwitch) changeStyle(npc, state, random);
}

/** Wiki: a new style, never the same one, with a scream. */
function changeStyle(npc, state, random = Math.random) {
  state.style = randomStyle(random, state.style);
  state.misses = 0;
  state.unreachable = 0;
  npc.forceChat(STYLE_CHANGE_SHOUT);
}

module.exports = { stateOf, kindOf, familyOf, protecting, randomStyle, countMiss, changeStyle };
