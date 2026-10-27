/**
 * Fairy's Flight (https://oldschool.runescape.wiki/w/Fairy's_Flight_(Raging_Echoes_League)),
 * Trailblazer Reloaded's tier 2 and Raging Echoes' tier 3 relic: the fairy mushroom teleports to
 * any fairy ring (by its code), spirit tree (those the character could travel to by tree) or tool
 * leprechaun, in unlocked areas, from the Wilderness too except to a spirit tree (Wiki, Fairy
 * mushroom); Last-destination repeats the last. The cache's options: Teleport and
 * Last-destination carried; Fairy-Ring, Spirit-tree, Tool-leprechauns and Last-destination worn.
 * Not here: the Tree Gnome Village autocompletion (the quests' own completion, not a relic's).
 */
const Common = require("./Common.LeagueRelics");
const Teleports = require("./Teleports.LeagueRelics");

const KEY = "fairy-mushroom";
/** Spirit trees keep their own Wilderness rule (Wiki: "except spirit tree locations"). */
const SPIRIT_TREE_WILDERNESS_LEVEL = 20;

let effect;
let leprechauns = null;

function active(player) {
  return Common.effectActive(player, effect);
}

function rings(player) {
  const list = Teleports.ask("fairy-rings:destinations").sort((a, b) => a.code.localeCompare(b.code));
  const letters = [...new Set(list.map((ring) => ring.code[0]))];
  Teleports.menu(player, Common.message("fairyRingsTitle"), letters.map((letter) => [`${letter}...`, () => {
    const codes = list.filter((ring) => ring.code[0] === letter).map((ring) => ({ label: `${ring.code} ${ring.name}`.trim(), location: ring.location }));
    Teleports.destinations(player, KEY, Common.message("fairyRingsTitle"), codes);
  }]));
}

function trees(player) {
  const list = Teleports.ask("spirit-trees:destinations", { player }).map((tree) => ({ label: tree.name, location: tree.location, wildernessLevel: SPIRIT_TREE_WILDERNESS_LEVEL }));
  Teleports.destinations(player, KEY, Common.message("spiritTreesTitle"), list);
}

/** The tool leprechauns, each named after the nearest fairy ring (ours: they have no names of their own). */
function leprechaunList() {
  if (leprechauns) return leprechauns;
  const { Location } = Common.core;
  const ringList = Teleports.ask("fairy-rings:destinations");
  leprechauns = Teleports.spawnsNamed("Tool Leprechaun").map((spawn) => {
    const location = new Location(spawn.x, spawn.y, spawn.level ?? 0);
    const nearest = ringList.reduce((best, ring) => {
      const distance = Math.hypot(ring.location.getX() - spawn.x, ring.location.getY() - spawn.y);
      return !best || distance < best.distance ? { ring, distance } : best;
    }, null);
    const place = nearest?.ring.name.split(":").pop().trim() || `${spawn.x}, ${spawn.y}`;
    return { label: Common.message("leprechaunNear", { place }), location };
  }).sort((a, b) => a.label.localeCompare(b.label));
  return leprechauns;
}

function tools(player) {
  Teleports.destinations(player, KEY, Common.message("leprechaunsTitle"), leprechaunList());
}

function teleport({ player }) {
  if (!active(player)) return;
  Teleports.menu(player, Common.message("fairyMushroomTitle"), [
    ["Fairy rings", () => rings(player)],
    ["Spirit trees", () => trees(player)],
    ["Tool leprechauns", () => tools(player)],
  ]);
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
  effect = Common.data.effects.fairysFlight;
  api.persistAttribute(Teleports.lastAttribute(KEY), null);
  api.onItemAction(effect.toolName, {
    Teleport: only((player) => teleport({ player })),
    "Last-destination": only((player) => Teleports.goLast(player, KEY)),
    "Fairy-Ring": only(rings),
    "Spirit-tree": only(trees),
    "Tool-leprechauns": only(tools),
  });
};
