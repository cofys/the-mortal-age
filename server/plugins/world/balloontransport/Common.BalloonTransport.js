/**
 * The balloon transport system: what the units share - the plugin api, plugins/world/data/
 * balloon-transport.json with its gameval names resolved to cache ids, tick timing, the fade, the
 * routes a player has opened, and the quest check.
 */
const fs = require("fs");
const path = require("path");

/** Routes opened after the quest, one bit per station key (Entrana and Taverley come with it). */
const ROUTES_ATTRIBUTE = "balloon-transport:routes";

const OVERLAY_ATMOSPHERE_UID = (161 << 16) | 1;
const FADE_OVERLAY = 174;
const FADE_SCRIPT = 948;
/** The map's components the flight changes (rsprox 3225). */
const MAP_MARKERS = ["mod_ent", "mod_tav", "mod_craft", "mod_varr", "mod_cast", "mod_gno"];

let api = null;
let core = null;
let data = null;
let ids = null;

function resolve(names, lookup, kind) {
  const out = {};
  for (const [key, name] of Object.entries(names)) {
    const id = lookup(name);
    if (id === null || id === undefined || id < 0) throw new Error(`[BalloonTransport] unknown ${kind} ${name}`);
    out[key] = id;
  }
  return out;
}

/** Set once by the plugin before any unit attaches. */
function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "balloon-transport.json"), "utf8"));
  const cache = core.CacheDefinitions;
  const map = cache.getInterfaceId(data.names.interface);
  if (map === null) throw new Error(`[BalloonTransport] unknown interface ${data.names.interface}`);
  const buttons = new Map();
  const varbit = (name) => {
    const id = cache.getVarbitId(name);
    if (id === null || id === undefined) throw new Error(`[BalloonTransport] unknown varbit ${name}`);
    return id;
  };
  data.stations.forEach((station, bit) => {
    station.bit = 1 << bit;
    if (station.varbit) station.varbitId = varbit(station.varbit);
    if (station.pilotVarbit) station.pilotVarbitId = varbit(station.pilotVarbit);
    const uid = cache.getComponentId(`${data.names.interface}:${station.button}`);
    if (uid === null) throw new Error(`[BalloonTransport] unknown component ${station.button}`);
    buttons.set(uid & 0xffff, station);
  });
  const component = (name) => {
    const uid = cache.getComponentId(`${data.names.interface}:${name}`);
    if (uid === null || uid === undefined) throw new Error(`[BalloonTransport] unknown component ${name}`);
    return uid;
  };
  const journeys = new Map();
  for (const from of data.stations) {
    for (const to of data.stations) {
      if (from === to) continue;
      const seq = cache.getSeqId(`zep_balloon_journey_${from.journey}_${to.journey}`);
      if (seq !== null && seq !== undefined) journeys.set(`${from.key}>${to.key}`, seq);
    }
  }
  ids = {
    map, buttons, journeys,
    objs: resolve(data.names.objs, (name) => cache.getObjId(name), "obj"),
    closeButton: component("close_button"),
    markers: MAP_MARKERS.map(component),
    balloon: component("zep_interface_balloon"),
  };
}

/** Runs `action` once, `ticks` game ticks from now. */
function later(ticks, action) {
  const { Task, TaskManager } = core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(Math.max(1, ticks), null, false);
    }
    execute() {
      this.stop();
      action();
    }
  })());
}

/** The fade overlay with the recorded script arguments (flight.fadeStart / fadeEnd). */
function fade(player, args) {
  player.getPacketSender().sendSubInterface(OVERLAY_ATMOSPHERE_UID, FADE_OVERLAY, 1, { postScripts: [{ scriptId: FADE_SCRIPT, args }] });
}

function closeFade(player) {
  player.getPacketSender().closeSubInterface(OVERLAY_ATMOSPHERE_UID);
}

function questComplete(player) {
  const request = { player, key: data.quest, complete: null };
  api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

function routes(player) {
  return Number(player.getAttribute?.(ROUTES_ATTRIBUTE)) || 0;
}

/** Entrana and Taverley come with the quest; the rest once flown from Entrana. */
function opened(player, station) {
  return station.byQuest ? questComplete(player) : (routes(player) & station.bit) !== 0;
}

/** Each opened station's basket and assistant (their multilocs and multinpcs read these). */
function sendRoutes(player) {
  const sender = player.getPacketSender();
  const value = routes(player);
  for (const station of data.stations) {
    if (!station.varbit) continue;
    const open = (value & station.bit) !== 0 ? 1 : 0;
    sender.sendVarbit(station.varbitId, open);
    if (station.pilotVarbitId) sender.sendVarbit(station.pilotVarbitId, open);
  }
}

function openRoute(player, station) {
  player.setAttribute(ROUTES_ATTRIBUTE, routes(player) | station.bit);
  sendRoutes(player);
}

const tile = ([x, y]) => new core.Location(x, y, 0);

/** The station whose basket the player is by, or null. */
function stationAt(location) {
  let best = null;
  for (const station of data.stations) {
    const [x, y] = station.basket;
    const distance = Math.max(Math.abs(location.getX() - x), Math.abs(location.getY() - y));
    if (location.getZ() === 0 && distance <= data.stationReach && (!best || distance < best.distance)) best = { station, distance };
  }
  return best?.station ?? null;
}

module.exports = {
  init, later, fade, closeFade, questComplete, routes, opened, sendRoutes, openRoute, tile, stationAt, ROUTES_ATTRIBUTE,
  get api() { return api; },
  get core() { return core; },
  get data() { return data; },
  get ids() { return ids; },
};
