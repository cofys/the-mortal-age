"use strict";

/**
 * Origins.Arrival — the welcome beat.
 *
 * Listens for the origins system's `origins:selected` { player, originId }
 * event (contract, origins plugin in parallel). The player arrives at their
 * home city and gets one short scripted beat: a guard's greeting naming the
 * local crisis, a townsfolk pointing at the tavern/market/bank, and one
 * gentle nudge toward the living world. No stages, no checklist, no quest
 * state — walk away at any point and the beat stops talking to you.
 *
 * Idempotent: `arrival:welcomed` is set before the beat runs, so a re-emit
 * never replays it.
 *
 * ASSUMPTION (origins system, parallel build): this module teleports the
 * player to the origin's arrival tile when they are far from it. If the
 * origins plugin takes over the teleport, this becomes a no-op naturally —
 * the player will already be standing there.
 */

const Common = require("./Common.Arrival");
const Rumors = require("./Rumors.Arrival");

const ORIGIN_ID_ATTRIBUTE = "origin:id";

let apiRef = null;
let core = null;

/**
 * originId -> welcome config. `greet` is flag-aware so the beat names the
 * CURRENT crisis, not a stale one. `nudge` aims the player at citizens'
 * live anchors (docks, work sites, markets) — see citizens data/sites.json.
 */
const ORIGINS = {
  asgarnia: {
    kingdomId: "asgarnia",
    city: "Falador",
    arrival: [2964, 3378, 0],
    greeterNames: ["Guard"],
    pointerNames: ["Man", "Woman"],
    greet: (flags) =>
      flags["asgarnia:regency"]
        ? "Welcome to Falador, traveller. Keep your head down — the regent's men are asking questions today."
        : "Welcome to Falador, traveller. The king's back on his throne — mind your manners in the square.",
    point: "Bank's east, market's south, and the Rising Sun pours the best ale this side of the wall.",
    nudge: "Fishing's decent off the south docks — the lads are usually down there casting.",
  },
  misthalin: {
    kingdomId: "misthalin",
    city: "Varrock",
    arrival: [3210, 3424, 0],
    greeterNames: ["Guard"],
    pointerNames: ["Man", "Woman"],
    greet: (flags) =>
      flags["misthalin:bastard-son-hidden"]
        ? "New in Varrock? Mind the gangs in the east alleys — and pray for the king. He's old, there's no heir, and everyone's nervous."
        : "New in Varrock? The succession's settled and the city's still buzzing about it. Mind the gangs in the east alleys.",
    point: "Bank's north of the square. The Blue Moon's south-east, if you need a drink and a rumor.",
    nudge: "The market's always hiring porters, and the fishers work the south docks. Pick a crowd, make yourself useful.",
  },
  kandarin: {
    kingdomId: "kandarin",
    city: "East Ardougne",
    arrival: [2662, 3305, 0],
    greeterNames: ["Guard"],
    pointerNames: ["Man", "Woman"],
    greet: (flags) =>
      flags["ardougne:plague-lie-active"]
        ? "Welcome to Ardougne. Stay EAST of the wall — the west side's quarantined. Plague, they say."
        : "Welcome to Ardougne. The wall's down, the west side breathes — the city's still catching its breath.",
    point: "Bank's north-east. The Flying Horse Inn's just there, if you need a bed or a whisper.",
    nudge: "The market square always needs hands. Or head south — the fishing boats pay in coin and gossip.",
  },
  morytania: {
    kingdomId: "morytania",
    city: "Burgh de Rott",
    arrival: [3770, 3238, 0],
    greeterNames: ["Man", "Woman"],
    pointerNames: ["Man", "Woman"],
    greet: () =>
      "You're new. Keep quiet, keep moving, and don't bleed where the vyres can smell it.",
    point: "Bank's by the market stalls. The tavern's the only warm building — you'll smell the smoke.",
    nudge: "The Myreque meet folk in the Hollows, if you've a conscience and a death wish. The rest of us chop deadwood and try to live.",
  },
  keldagrim: {
    kingdomId: "keldagrim",
    city: "Keldagrim",
    arrival: [2848, 10202, 0],
    greeterNames: ["Guard", "Dwarf"],
    pointerNames: ["Dwarf", "Man", "Woman"],
    greet: () =>
      "Hail, surfacer. Mind the Consortium's writs, keep your hands off other companies' claims. The city's jumpy.",
    point: "Bank's west, market's center. The Laughing Miner's got ale, if you've got coin.",
    nudge: "The east mines always need pickarms. Swing with the crews and you'll eat tonight.",
  },
  wanderer: {
    kingdomId: null,
    city: "Lumbridge",
    arrival: [3222, 3219, 0],
    greeterNames: ["Guard"],
    pointerNames: ["Man", "Woman"],
    greet: () =>
      "Welcome to Lumbridge, traveller. Goblins west, the Duke's men at the castle. You'll find your feet.",
    point: "Bank's on the hill by the castle, the market's by the river. The pub's warm.",
    nudge: "Fishing's good off the south docks — the lads are usually down there casting.",
  },
};

const ARRIVAL_TILE_RANGE = 40;
const BEAT_AUDIBLE_RANGE = 15;

function onOriginsSelected(event) {
  const player = event?.player;
  const originId = event?.originId;
  if (!player || !Common.isRealPlayer(player)) return;
  if (player.getAttribute(Common.ARRIVAL_WELCOMED_ATTRIBUTE)) return;

  const def = ORIGINS[originId] ?? ORIGINS.wanderer;
  const [ax, ay, az] = def.arrival;
  const arrivalTile = new core.Location(ax, ay, az);

  // The origins system may already have placed the player; only move them
  // when they are nowhere near home.
  if (player.getLocation().getDistance(arrivalTile) > ARRIVAL_TILE_RANGE) {
    player.moveTo(arrivalTile);
  }
  player.setAttribute(Common.ARRIVAL_WELCOMED_ATTRIBUTE, Date.now());
  if (originId && !ORIGINS[originId]) {
    player.setAttribute(ORIGIN_ID_ATTRIBUTE, "wanderer");
  }

  const flags = Rumors.flagsFor(def.kingdomId);
  const greeter = Common.npcNamedNear(core, arrivalTile, def.greeterNames);
  const pointer =
    Common.npcNamedNear(core, arrivalTile, def.pointerNames) ?? greeter;
  const anchor = greeter?.getLocation?.() ?? arrivalTile;
  const stillHere = () =>
    player.getLocation().getDistance(anchor) <= BEAT_AUDIBLE_RANGE;

  const say = (npc, text) => {
    if (npc) npc.forceChat(text);
    else player.sendMessage(text);
  };

  // Beat, one line at a time. Walking away cancels the rest — the beat is
  // skippable by construction.
  Common.later(core, 2, () => say(greeter, def.greet(flags)));
  Common.later(core, 16, () => {
    if (stillHere()) say(pointer, def.point);
  });
  Common.later(core, 30, () => {
    if (!stillHere()) return;
    say(pointer, def.nudge);
    // Hand-off to the citizens system: a new player just arrived at home.
    // Citizens may steer a nearby citizen to greet them — optional, ambient.
    apiRef.emitCustomEvent("arrival:player-arrived", {
      player,
      originId: ORIGINS[originId] ? originId : "wanderer",
      kingdomId: def.kingdomId,
    });
  });
}

module.exports = function attachOrigins(api) {
  apiRef = api;
  core = api.core;
  api.onCustomEvent("origins:selected", onOriginsSelected);
};

module.exports.ORIGINS = ORIGINS;
