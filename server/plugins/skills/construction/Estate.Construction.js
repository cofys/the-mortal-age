"use strict";

const { Location, ItemIdentifiers } = require("./Core.Construction");

// Location keys are the native POH_HOUSE_LOCATION / house advertisement enum (252).
const HOUSE_LOCATIONS = require("./data/house-locations.json");

// Native template ordering: four themes per map column, one theme per source plane.
// Door leaves are ordered unmirrored/mirrored, closed then open.
const HOUSE_STYLES = require("./data/house-styles.json")
  .map(style => style.blueprint ? { ...style, blueprint: ItemIdentifiers[style.blueprint] } : style);

function houseLocation(save) {
  return HOUSE_LOCATIONS.find(location => location.id === save.location) ?? HOUSE_LOCATIONS[0];
}

function houseExit(save) {
  const { x, y } = houseLocation(save);
  return new Location(x, y, 0);
}

function houseStyleIndex(save) {
  return Number.isInteger(save.style) && HOUSE_STYLES[save.style] ? save.style : 0;
}

Object.assign(module.exports, { HOUSE_LOCATIONS, HOUSE_STYLES, houseLocation, houseExit, houseStyleIndex });
