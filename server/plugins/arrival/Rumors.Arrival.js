"use strict";

/**
 * Rumors.Arrival — the ambient rumor engine.
 *
 * Pools of short rumor lines per kingdom, gated on the LIVE story flags in
 * KingdomStore (read-only; never mutated here). When the world's state moves
 * — a flag flips, the Salve decays, the Red Axe escalates — the chatter
 * changes with it. No quest hooks, no stages: pure atmosphere.
 *
 * A rumor entry: { text, when? }. `when` is a flag condition:
 *   { flag: "asgarnia:regency", equals: true }
 *   { flag: "morytania:salve-integrity", lt: 50 }
 * Supported operators: equals, ne, lt, lte, gt, gte, oneOf.
 * An entry with no `when` is always live.
 */

const Store = require("../kingdoms/KingdomStore");

const RUMOR_POOLS = {
  asgarnia: [
    {
      text: "No one's seen King Vallance in years. The regent sits his chair and calls it stewardship.",
      when: { flag: "asgarnia:regency", equals: true },
    },
    {
      text: "Prince Anlaf won't leave Burthorpe. Says the walls have ears — says the Kinshra have knives.",
      when: { flag: "asgarnia:regency", equals: true },
    },
    {
      text: "Black Knights drilling in the Wilderness again. Arming for something, and it isn't goblins.",
      when: { flag: "asgarnia:regency", equals: true },
    },
    {
      text: "The king's back on his throne, they say. About time — the regent was getting comfortable.",
      when: { flag: "asgarnia:regency", equals: false },
    },
    { text: "Falador's walls have stood a thousand years. Pity about the men inside them." },
    { text: "The White Knights recruit at the castle. Good pay, if you don't mind the politics." },
  ],
  misthalin: [
    {
      text: "The king's got no heir and the Church knows it. Pray for Roald — the priests are counting the days.",
      when: { flag: "misthalin:bastard-son-hidden", equals: true },
    },
    {
      text: "Both gangs are buying old church records. Birth rolls, ledgers. Ask yourself why.",
      when: { flag: "misthalin:bastard-son-hidden", equals: true },
    },
    {
      text: "They found the king's heir! Some lost child of the blood, back to claim the crown.",
      when: { flag: "misthalin:bastard-son-hidden", equals: false },
    },
    { text: "Phoenix and Black Arm bled each other in the east alleys again last night. Steer clear." },
    { text: "The Shield of Arrav hangs in the museum. Some say whoever holds it holds Varrock." },
  ],
  kandarin: [
    // The plague LIE as ambient whisper — explicitly wanted. The lie is never
    // exposed here; the questline that topples Lathas is phase 10, not this.
    {
      text: "They say the west side's plague-ridden. But have you ever SEEN a sick man come out of there? …Me neither.",
      when: { flag: "ardougne:plague-lie-active", equals: true },
    },
    {
      text: "The mourners carry the dead out of West Ardougne every week. Same carts, same shrouds. Someone counted — the numbers don't change.",
      when: { flag: "ardougne:plague-lie-active", equals: true },
    },
    {
      text: "King Lathas sealed the wall 'for our safety'. Funny how the plague never crosses to the east side.",
      when: { flag: "ardougne:plague-lie-active", equals: true },
    },
    {
      text: "My cousin's a guard on the wall. Says his orders are to keep people IN, not sickness out.",
      when: { flag: "ardougne:plague-lie-active", equals: true },
    },
    {
      text: "The wall's down and the west side breathes again! Lathas is finished — the whole city's saying it.",
      when: { flag: "ardougne:plague-lie-active", equals: false },
    },
    { text: "The market in East Ardougne still runs. Coin doesn't quarantine." },
  ],
  morytania: [
    {
      text: "The Salve holds. Pray it keeps holding — it's the only thing between us and the dark.",
      when: { flag: "morytania:salve-integrity", gte: 50 },
    },
    {
      text: "The river's gone quiet in places. The old magic's thinning. If the Salve breaks, we all bleed.",
      when: { flag: "morytania:salve-integrity", lt: 50 },
    },
    {
      text: "The Salve's BROKEN. The war's coming west and no god's left to stop it. Run.",
      when: { flag: "morytania:salve-integrity", lte: 0 },
    },
    { text: "The Myreque are recruiting. Desperate folk, brave folk. Talk to them if you've a conscience and a death wish." },
    { text: "Don't bleed where the vyres can smell it. And don't go out after dark. Ever." },
    {
      text: "Word in the swamp: the Hollow's caches hunger — bread, swamp paste, planks. Leave them by the old tunnel and the Myreque remembers.",
      when: { flag: "morytania:myreque-resurgent", equals: true },
    },
    {
      text: "They say one of our own walks with the Myreque now — Sworn of the Hollow. Lowerniel will have their head for it.",
      when: { flag: "morytania:myreque-sworn-walks", equals: true },
    },
    {
      text: "The tithe-officer's got a new hound — one of ours, selling Myreque names for coin. Watch your tongue in Canifis.",
      when: { flag: "morytania:drakan-oathbound-walks", equals: true },
    },
  ],
  keldagrim: [
    {
      text: "Red Axe graffiti on the east tunnels again. The Consortium calls it vandalism. The miners call it a warning.",
      when: { flag: "keldagrim:red-axe-threat", oneOf: ["rising", "war"] },
    },
    {
      text: "The companies are hiring guards, not miners. Ask yourself what they're guarding against.",
      when: { flag: "keldagrim:red-axe-threat", oneOf: ["rising", "war"] },
    },
    {
      text: "It's WAR in the deep tunnels. Red Axe against the companies, and the city's caught between.",
      when: { flag: "keldagrim:red-axe-threat", equals: "war" },
    },
    {
      text: "The Red Axe are broken — scattered to the deep dark. The Consortium's already taxing the victory.",
      when: { flag: "keldagrim:red-axe-threat", equals: "defeated" },
    },
    { text: "Eight companies, one city, no king. The Consortium votes on everything and agrees on nothing." },
    { text: "The monarchy question's live again. Some dwarf wants a crown. Most dwarfs want paying." },
  ],
};

function matchesCondition(flags, when) {
  if (!when) return true;
  const value = flags?.[when.flag];
  if (when.equals !== undefined) return value === when.equals;
  if (when.ne !== undefined) return value !== when.ne;
  if (when.lt !== undefined) return typeof value === "number" && value < when.lt;
  if (when.lte !== undefined) return typeof value === "number" && value <= when.lte;
  if (when.gt !== undefined) return typeof value === "number" && value > when.gt;
  if (when.gte !== undefined) return typeof value === "number" && value >= when.gte;
  if (when.oneOf !== undefined) return Array.isArray(when.oneOf) && when.oneOf.includes(value);
  return true;
}

/** Live flag map for a kingdom, read-only. Missing kingdom -> {}. */
function flagsFor(kingdomId) {
  try {
    return Store.getKingdom(kingdomId)?.flags ?? {};
  } catch {
    return {};
  }
}

/** All currently-live rumor texts for a kingdom. */
function rumorsFor(kingdomId) {
  const pool = RUMOR_POOLS[kingdomId] ?? [];
  const flags = flagsFor(kingdomId);
  return pool.filter((entry) => matchesCondition(flags, entry.when)).map((entry) => entry.text);
}

/** One random live rumor for a kingdom, or null when the pool is empty. */
function drawRumor(kingdomId) {
  const live = rumorsFor(kingdomId);
  if (live.length === 0) return null;
  return live[Math.floor(Math.random() * live.length)];
}

module.exports = {
  RUMOR_POOLS,
  flagsFor,
  rumorsFor,
  drawRumor,
};
