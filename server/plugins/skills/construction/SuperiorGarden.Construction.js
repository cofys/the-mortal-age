"use strict";

const { api } = require("./Core.Construction");
const House = require("./House.Construction");

// The superior garden's spirit tree and fairy ring are the world networks' own: the furniture
// only hands the player to SpiritTrees / FairyRings (rsprox captures show the same menus and dials).

function inHouse(event) {
  return House.houseFor(event.player) !== null;
}

function forward(name) {
  return (event) => {
    if (!inHouse(event)) return false;
    api.emitCustomEvent(name, { player: event.player, location: event.location, ...event.location });
    return true;
  };
}

const SPIRIT_TREE = forward("spirit-trees:open");
const SPIRIT_TREE_LAST = forward("spirit-trees:last-destination");
const RING_ZANARIS = forward("fairy-rings:zanaris");
const RING_CONFIGURE = forward("fairy-rings:configure");
const RING_LAST = forward("fairy-rings:last-destination");

function attachSuperiorGarden(api) {
  api.onObjectInteraction("Spirit Tree", { Travel: SPIRIT_TREE, "Last-destination": SPIRIT_TREE_LAST });
  api.onObjectInteraction("Fairy Ring", { Zanaris: RING_ZANARIS, Configure: RING_CONFIGURE, "Last-destination": RING_LAST });
  api.onObjectInteraction("Spiritual Fairy Tree", {
    Tree: SPIRIT_TREE, "Ring-Zanaris": RING_ZANARIS, "Ring-configure": RING_CONFIGURE, "Ring-last-destination": RING_LAST,
  });
}

Object.assign(module.exports, { attachSuperiorGarden });
