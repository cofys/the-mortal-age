"use strict";

/**
 * Areas.Kingdoms — one Area per great power, so kingdom territory is a real
 * mechanic: per-tick process() for actors inside only, postEnter/postLeave
 * edges, and rule overrides. Wartime PvP law lives here (canAttack +
 * the client Attack option, both delegated to WartimePvp.Kingdoms, the
 * rule's one home); guard aggression and the Salve's decay remain
 * stubbed to null — see DESIGN.md.
 *
 * Boundaries are v2 NATURAL borders: multiple rects per kingdom following
 * rivers (the Salve), mountain ranges (White Wolf), the Wilderness line, and
 * coastlines instead of ocean-spanning boxes. Rects are still approximations
 * (Boundary is rect-only), but they hug the political regions now.
 * Asgarnia's north edge stops at the Wilderness pvp zone (x 2940+, y 3525+);
 * Burthorpe sits west of that zone, so it gets its own rect. The Wilderness
 * area registers first at startup and wins any sliver anyway.
 */

const Membership = require("./Membership.Kingdoms");
const Store = require("./KingdomStore");
const WartimePvp = require("./WartimePvp.Kingdoms");

const KINGDOM_TERRITORIES = [
  {
    id: "asgarnia",
    name: "Asgarnia",
    blurb: "the kingdom with no king",
    rects: [
      [2820, 3060, 3215, 3519], // Falador, Port Sarim, Rimmington, Taverley, White Wolf Mountain
      [2790, 2820, 3420, 3470], // Catherby coastal strip
      [2800, 2940, 3519, 3590], // Burthorpe + Warriors' Guild, west of the Wilderness pvp zone
    ],
    heights: [0, 1, 2, 3],
  },
  {
    id: "misthalin",
    name: "Misthalin",
    blurb: "the heirless crown",
    rects: [
      [3060, 3400, 3170, 3519], // Edgeville, Grand Exchange, Varrock, Draynor, Lumbridge; east edge at the Salve
    ],
    heights: [0, 1, 2, 3],
  },
  {
    id: "kandarin",
    name: "Kandarin",
    blurb: "the lie holds — for now",
    rects: [
      [2420, 2800, 3360, 3500], // Seers' Village, Camelot, Tree Gnome Stronghold
      [2300, 2745, 3250, 3360], // Ardougne, Witchaven (east edge at the coast)
      [2300, 2700, 3150, 3250], // Tower of Life area (east edge at the coast)
      [2350, 2700, 3000, 3150], // Yanille, Tree Gnome Village, Observatory, Castle Wars, Port Khazard
    ],
    heights: [0, 1, 2, 3],
  },
  {
    id: "morytania",
    name: "Morytania",
    blurb: "the dark",
    rects: [
      [3395, 3760, 3260, 3530], // Canifis, Port Phasmatys, Darkmeyer — east of the Salve
      [3440, 3720, 3130, 3260], // Burgh de Rott, Meiyerditch south
    ],
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

function warFoeOf(kingdomId) {
  try {
    const war = Store.getActiveWars().find(
      (w) => w.attackerId === kingdomId || w.defenderId === kingdomId
    );
    if (!war) return null;
    const foeId = war.attackerId === kingdomId ? war.defenderId : war.attackerId;
    return Store.getKingdom(foeId)?.name ?? foeId;
  } catch {
    return null;
  }
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
  const foe = warFoeOf(def.id);
  if (foe) {
    player.sendMessage(
      `[Warning] ${def.name} is at war with ${foe}. The roads are not safe — travel armed, or not at all.`
    );
  }
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
      if (isRealPlayer(mobile)) {
        WartimePvp.clearWartimeUi(mobile, logout);
        leaveKingdom(api, def, mobile);
      }
    }

    // Per-tick, actors in this territory only: keep a real player's
    // Attack option honest — shown on wartime ground (their kingdom at
    // war with this one, or their own ground while it is at war), gone
    // everywhere else, and never inside a town safe zone. Sends happen
    // only when the answer flips.
    process(mobile) {
      if (isRealPlayer(mobile)) {
        WartimePvp.syncWartimeUi(mobile, WartimePvp.isHotGround(mobile, def.id));
      }
    }

    // Wartime PvP law: enemy subjects of two kingdoms at war may fight
    // on either's territory, outside the town safe zones. Everything
    // else is no opinion — peacetime player pairs fall through to the
    // engine default, which refuses the attack.
    canAttack(attacker, target) {
      return WartimePvp.wartimeCanAttack(attacker, target, def.id);
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
