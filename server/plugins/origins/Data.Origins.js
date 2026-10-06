"use strict";

/**
 * Data.Origins — the six homes a new life can begin in.
 *
 * Each origin carries:
 *   id         — kebab-case origin id, persisted as the `origin:id` attribute
 *   name       — display name of the home
 *   city       — the capital / anchor settlement
 *   kingdomId  — the great power this home belongs to (null for the Wanderer)
 *   spawn      — starting tile. Coordinates are VERIFIED, never guessed —
 *                see the verification note on each entry.
 *   kit        — starting items as [ItemIdentifiers key, amount] pairs.
 *                Deliberately modest: bronze/iron basics, food, a few coins,
 *                and one or two cosmetic/thematic flavor items. No power creep.
 *   lens       — one paragraph of "your lens": who you are and the word on
 *                the street, written from the world bible's great-power
 *                situations.
 *   icon       — ItemIdentifiers key for the realm card's emblem on the
 *                graphical creation screen (Gui.Origins). Thematic, from the
 *                kit where possible.
 *   epithet    — one short line under the city on the realm card.
 *
 * Item keys must exist on api.core.ItemIdentifiers; Selection.Origins resolves
 * them at grant time so a typo fails loudly at startup, not silently in-game.
 * Icon keys are validated the same way when the creation GUI registers.
 */

const BASE_KIT = [
  ["BRONZE_AXE", 1],
  ["BRONZE_PICKAXE", 1],
  ["TINDERBOX", 1],
  ["SMALL_FISHING_NET", 1],
  ["BRONZE_DAGGER", 1],
  ["BUCKET", 1],
  ["POT", 1],
  ["BREAD", 3],
  ["COINS", 25],
];

const ORIGINS = [
  {
    id: "asgarnia",
    name: "Asgarnia",
    city: "Falador",
    demonym: "Faladorian",
    kingdomId: "asgarnia",
    // VERIFIED: "Standard: Falador" teleport destination in
    // plugins/interface/TeleportInterface.plugin.js — an in-game teleport the
    // server already uses.
    spawn: { x: 2964, y: 3378, z: 0 },
    kit: [...BASE_KIT, ["BRONZE_SWORD", 1], ["WOODEN_SHIELD", 1], ["RED_CAPE", 1], ["BREAD", 2]],
    icon: "RED_CAPE",
    epithet: "The kingdom with no king",
    welcome: "The white walls rise ahead of you. Make them proud.",
    lens:
      "You are Faladorian, raised in the shadow of the White Knights' walls — in the kingdom with no king. " +
      "Vallance has not been seen in years; Sir Amik Varze stewards the capital while Crown Prince Anlaf holds " +
      "Burthorpe with the Imperial Guard, jumping at shadows. Word on the street: the Kinshra are buying steel " +
      "out in the wilderness like a war is coming, and everyone is waiting for a king who may never return.",
  },
  {
    id: "misthalin",
    name: "Misthalin",
    city: "Varrock",
    demonym: "Varrockian",
    kingdomId: "misthalin",
    // VERIFIED: "Standard: Varrock" teleport destination in
    // plugins/interface/TeleportInterface.plugin.js.
    spawn: { x: 3213, y: 3424, z: 0 },
    kit: [...BASE_KIT, ["COINS", 25], ["BREAD", 2]],
    icon: "COINS",
    epithet: "The heirless crown",
    welcome: "The grand market hums. Everything here has a price — including crowns.",
    lens:
      "You are Varrockian, a child of the grand market and its grander politics — under the heirless crown. " +
      "Roald III grows older every winter and no heir has ever been named; the Church preaches louder than the " +
      "palace decrees, and the Phoenix and Black Arm gangs carve the alleys between them. Word on the street: " +
      "the Shield of Arrav is more than a relic — it is whoever holds it that the city will follow, and everyone " +
      "with ambition is doing the arithmetic.",
  },
  {
    id: "kandarin",
    name: "Kandarin",
    city: "Ardougne",
    demonym: "East Ardougnian",
    kingdomId: "kandarin",
    // VERIFIED: "Standard: Ardougne" teleport destination in
    // plugins/interface/TeleportInterface.plugin.js (East Ardougne market).
    spawn: { x: 2661, y: 3301, z: 0 },
    kit: [...BASE_KIT, ["SILK", 2], ["COINS", 15], ["BREAD", 2]],
    icon: "SILK",
    epithet: "The market and the lie",
    welcome: "The market stalls are loud and the palace is quiet. Both are lying about something.",
    lens:
      "You are East Ardougnian, raised in the market city under King Lathas — and under the lie. West Ardougne " +
      "rots behind its quarantine wall while the palace insists the plague is real, but you have watched the " +
      "years pass and the sickness never touches anyone who matters. Word on the street: the wall is not holding " +
      "a plague in, it is holding the truth out — and some in the west are done whispering.",
  },
  {
    id: "morytania",
    name: "Morytania",
    city: "Darkmeyer",
    demonym: "a child of Darkmeyer",
    kingdomId: "morytania",
    // VERIFIED (interpolated): sits inside Darkmeyer's bank square, between
    // verified adjacent spawns in data/definitions/npc-spawns.json — Bankers
    // at (3603-3607, 3369), a Vyrewatch Sentinel at (3605, 3360) and
    // Noctillion Lugosi at (3608, 3363) — with Darkmeyer ground-item tiles
    // nearby. NOTE: Darkmeyer is hostile to outsiders; this home is for
    // natives living under the vyre heel, and the lens says so plainly.
    spawn: { x: 3605, y: 3365, z: 0 },
    kit: [...BASE_KIT, ["GARLIC", 3], ["STAKE", 1]],
    icon: "GARLIC",
    epithet: "Under the vyre heel",
    welcome: "The vyres watch from the spires. Keep your garlic close and your head down.",
    lens:
      "You are of Darkmeyer — human, living under the vyre heel in the heart of the dark. Lowerniel Drakan's " +
      "tithe takes your neighbours' blood by right, the newly founded Myreque whispers rebellion in cellars, and " +
      "the ancient god-magic of the River Salve is the only wall between Morytania and the rest of the world. " +
      "Word on the street: the tithe grows heavier every season, the Salve will not hold forever, and everyone " +
      "here has lost someone.",
  },
  {
    id: "keldagrim",
    name: "Keldagrim",
    city: "Keldagrim",
    demonym: "a dwarf of Keldagrim",
    kingdomId: "keldagrim",
    // VERIFIED (interpolated): between two verified Dwarf NPC spawns in
    // data/definitions/npc-spawns.json at (2854, 10164) and (2861, 10167),
    // in central Keldagrim — inside the kingdom's territory rect
    // (2816-2944, 10112-10272) from kingdoms/Areas.Kingdoms.js.
    spawn: { x: 2857, y: 10166, z: 0 },
    kit: [...BASE_KIT, ["BRONZE_WARHAMMER", 1], ["BEER", 3], ["COINS", 25]],
    icon: "BEER",
    epithet: "The mountain's forges",
    welcome: "The forges never cool. Mind the companies — they own the mountain, not you.",
    lens:
      "You are a dwarf of Keldagrim, born under the mountain where eight companies rule as kings in all but " +
      "name. The Consortium counts its coins while the exiled Red Axe counts its axes in the dark, and the " +
      "forges have never burned hotter. Word on the street: the city has not had a true monarch in an age, the " +
      "companies like it that way, and something is stirring down in the deep tunnels.",
  },
  {
    id: "wanderer",
    name: "Wanderer",
    city: "Edgeville",
    demonym: "a wanderer",
    kingdomId: null,
    // VERIFIED: the world spawn in data/definitions/world.json — the exact
    // tile every new account (tutorial disabled) appears on today.
    spawn: { x: 3089, y: 3524, z: 0 },
    kit: [...BASE_KIT, ["ROPE", 1], ["COOKED_MEAT", 2]],
    icon: "ROPE",
    epithet: "No walls. No crown.",
    welcome: "No walls raised you. The road is yours — make it count.",
    lens:
      "You are a wanderer — no walls raised you and no banner claims you. The road is your hearth and your " +
      "history is yours to write. Word on the street: Edgeville is where the lost wash up, at the edge of the " +
      "wild, and a traveller with sharp eyes and no ties can go further than any prince. Gielinor does not care " +
      "where you are from. Neither do you.",
  },
];

const BY_ID = new Map(ORIGINS.map((origin) => [origin.id, origin]));

/** Assert every kit and GUI icon key exists on ItemIdentifiers — fail fast at startup. */
function validateItemKeys(Items) {
  for (const origin of ORIGINS) {
    for (const [key] of origin.kit) {
      if (!Number.isInteger(Items[key])) {
        throw new Error(`[origins] unknown item key '${key}' in kit for origin '${origin.id}'`);
      }
    }
    if (!Number.isInteger(Items[origin.icon])) {
      throw new Error(`[origins] unknown icon key '${origin.icon}' for origin '${origin.id}'`);
    }
  }
}

module.exports = { ORIGINS, BY_ID, validateItemKeys };
