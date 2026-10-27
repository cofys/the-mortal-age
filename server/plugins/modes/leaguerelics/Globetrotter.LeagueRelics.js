/**
 * Globetrotter (https://oldschool.runescape.wiki/w/Globetrotter), Trailblazer Reloaded's tier 2
 * relic: the Globetrotter pendant's Nexus teleports to the spellbooks' teleport spells (the four
 * books', and the house when the character has one), its Jewellery to the ornate jewellery box's
 * destinations, both in unlocked areas, no higher than level 20 Wilderness (30 for a dragonstone
 * piece's destination, its last destination included: Wiki, 6 December 2023); Last-destination
 * repeats the last. No runes, charges or cooldown.
 */
const Common = require("./Common.LeagueRelics");
const Teleports = require("./Teleports.LeagueRelics");

const KEY = "globetrotter-pendant";
const WILDERNESS_LEVEL = 20;
const BOOKS = [["SpellTeleports", null], ["LunarSpells", "Lunar"], ["ArceuusSpells", "Arceuus"]];

let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function title(name) {
  return name.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** The teleport spells by book: [book, [{ label, location }]]. */
function spellBooks(player) {
  const books = new Map();
  for (const [unit, fallback] of BOOKS) {
    const spells = Common.core[unit]?.getTeleportDestinations?.() ?? [];
    for (const spell of spells) {
      if (!spell.destination || spell.name === "teleport to house") continue;
      const label = fallback ?? (spell.spellbook === Common.core.MagicSpellbook?.ANCIENT ? "Ancient" : "Standard");
      if (!books.has(label)) books.set(label, []);
      books.get(label).push({ label: title(spell.name), location: spell.destination });
    }
  }
  const owns = { player, owns: false };
  Common.api.emitCustomEvent("construction:owns-house", owns);
  const house = { player, option: "inside", destination: null, onArrival: null };
  if (owns.owns === true) Common.api.emitCustomEvent("construction:house-tablet", house);
  if (house.destination) books.get("Standard")?.unshift({ label: "Teleport To House", location: house.destination, onArrival: house.onArrival, remember: false });
  return books;
}

function nexus(player) {
  const books = spellBooks(player);
  Teleports.menu(player, Common.message("nexusTitle"), [...books].map(([book, spells]) => [book, () => {
    Teleports.menu(player, Common.message("nexusTitle"), spells.map((spell) => [spell.label, () => Teleports.go(player, KEY, spell, { wildernessLevel: WILDERNESS_LEVEL, onArrival: spell.onArrival })]));
  }]));
}

function jewellery(player) {
  const list = Teleports.ask("construction:jewellery-box-destinations", { player });
  Teleports.destinations(player, KEY, Common.message("jewelleryTitle"), list, { wildernessLevel: WILDERNESS_LEVEL });
}

/** An option's handler for the relic's owner; anyone else's click goes on to the game's own (false). */
function only(fn) {
  return (event) => {
    if (!active(event.player)) return false;
    event.handled = true;
    fn(event.player);
  };
}

module.exports = function attach(api) {
  effect = Common.data.effects.globetrotter;
  api.persistAttribute(Teleports.lastAttribute(KEY), null);
  api.onItemAction(effect.toolName, {
    Nexus: only(nexus),
    Jewellery: only(jewellery),
    "Last-destination": only((player) => Teleports.goLast(player, KEY)),
  });
};
