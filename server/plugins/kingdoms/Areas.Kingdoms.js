"use strict";

/**
 * Areas.Kingdoms — one Area per great power, so kingdom territory is a real
 * mechanic: per-tick process() for actors inside only, postEnter/postLeave
 * edges, and rule overrides (all stubbed to null in v1 — see DESIGN.md).
 *
 * Boundaries are v1 APPROXIMATIONS: rectangles around each capital region,
 * one Boundary per height level (Boundary.inside requires an exact z match, so
 * z 0-3 covers castles and towers on the surface kingdoms; Keldagrim is a
 * single underground level for now). Refine against the cache map later.
 * Asgarnia's rect stops at the Wilderness ditch (y 3519); the Wilderness area
 * registers first at startup and wins the sliver anyway.
 */

const Membership = require("./Membership.Kingdoms");

const KINGDOM_TERRITORIES = [
  {
    id: "asgarnia",
    name: "Asgarnia",
    blurb: "the kingdom with no king",
    rects: [[2880, 3040, 3280, 3519]], // Falador, Burthorpe, Taverley
    heights: [0, 1, 2, 3],
  },
  {
    id: "misthalin",
    name: "Misthalin",
    blurb: "the heirless crown",
    rects: [[3072, 3296, 3168, 3512]], // Varrock, Edgeville, Draynor, Lumbridge
    heights: [0, 1, 2, 3],
  },
  {
    id: "kandarin",
    name: "Kandarin",
    blurb: "the lie holds — for now",
    rects: [[2432, 2656, 3072, 3360]], // East and West Ardougne, Yanille
    heights: [0, 1, 2, 3],
  },
  {
    id: "morytania",
    name: "Morytania",
    blurb: "the dark",
    rects: [[3408, 3776, 3264, 3536]], // Canifis, Port Phasmatys, Burgh de Rott
    heights: [0, 1, 2, 3],
  },
  {
    id: "keldagrim",
    name: "Keldagrim",
    blurb: "the company war brews below",
    rects: [[2816, 2944, 10112, 10272]], // the dwarven city, underground
    heights: [0],
  },
];

function isRealPlayer(mobile) {
  return mobile?.isPlayer?.() === true && mobile?.isPlayerBot?.() !== true;
}

function boundariesOf(api, def) {
  const list = [];
  for (const [x1, x2, y1, y2] of def.rects) {
    for (const z of def.heights) {
      list.push(new api.core.Boundary(x1, x2, y1, y2, z));
    }
  }
  return list;
}

function enterKingdom(api, def, player) {
  api.emitCustomEvent("kingdom:territory-entered", {
    player,
    kingdomId: def.id,
    name: def.name,
  });
  const home = player.getAttribute?.(Membership.KINGDOM_ID_ATTRIBUTE) === def.id;
  player.sendMessage(
    home ? `Welcome home to ${def.name}.` : `You enter ${def.name} — ${def.blurb}.`
  );
}

function leaveKingdom(api, def, player) {
  api.emitCustomEvent("kingdom:territory-left", {
    player,
    kingdomId: def.id,
    name: def.name,
  });
  player.sendMessage(`You leave ${def.name}.`);
}

function createKingdomArea(api, def) {
  class KingdomArea extends api.core.Area {
    postEnter(mobile) {
      if (isRealPlayer(mobile)) enterKingdom(api, def, mobile);
    }

    postLeave(mobile, logout) {
      if (isRealPlayer(mobile)) leaveKingdom(api, def, mobile);
    }

    // v1: no per-tick work; kingdom laws (guard aggression, wartime PvP rules,
    // the Salve's decay) are stubbed in DESIGN.md. Territory edges carry v1.
    canAttack() {
      return null;
    }

    canTeleport() {
      return null;
    }

    npcAggressionTolerance() {
      return null;
    }
  }
  return new KingdomArea(boundariesOf(api, def));
}

function registerKingdomAreas(api) {
  for (const def of KINGDOM_TERRITORIES) {
    api.registerArea(createKingdomArea(api, def));
  }
}

module.exports = function attachAreas(api) {
  // Broad map-wide zones register at startup, after the specific areas (dungeons,
  // minigames) that registered at load: an actor holds the first matching area.
  api.onServerStartup(() => registerKingdomAreas(api));
};

module.exports.KINGDOM_TERRITORIES = KINGDOM_TERRITORIES;
