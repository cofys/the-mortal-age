"use strict";

/**
 * MyKingdomApi — HTTP data layer for the web client's "My Kingdom" overlay.
 *
 * The origins kingdom pick is beautiful and then leads nowhere. This panel
 * is the follow-through: after character creation (and any time after, via
 * the Town crier), the player sees their kingdom, their standing in it,
 * what's happening in the realm, and the other great powers.
 *
 *   GET /api/mykingdom-status?player=<username>
 *     -> { open, kingdom, standing, news, realms }
 *
 *   ...&action=open    — mark the panel open for this player
 *   ...&action=close   — mark the panel closed for this player
 *
 * Read-only by design: treasury is shown but never spent from here.
 * All data comes from the real kingdom store — nothing is invented.
 */

const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");
const Relations = require("./Relations.Kingdoms");
const Coalitions = require("./Coalitions.Kingdoms");

const MYKINGDOM_OPEN_ATTRIBUTE = "mykingdom:open";

function findPlayer(api, name) {
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function kingdomName(id) {
  const k = Store.getKingdom(id);
  return k ? k.name : String(id);
}

/** The player's standing: rank + any office held. */
function standingPayload(player, kingdomId) {
  let rank = null;
  try {
    rank = player.getAttribute("kingdom:rank") || null;
  } catch {
    rank = null;
  }

  let office = null;
  if (kingdomId) {
    try {
      const username = player.getUsername ? player.getUsername() : null;
      const offices = Offices.getOffices(kingdomId) || [];
      for (const o of offices) {
        const officeId = Offices.officeIdFor(kingdomId, o.office || o);
        const holder = Offices.holderOf(officeId);
        if (holder && username && String(holder).toLowerCase() === String(username).toLowerCase()) {
          office = {
            office: o.office || o,
            title: o.title || o.office || String(o),
            description: o.description || null,
          };
          break;
        }
      }
    } catch {
      office = null;
    }
  }

  return { rank, office };
}

/** Realm status: what's happening to the player's kingdom right now. */
function realmStatusPayload(kingdomId) {
  const state = Store.load();
  const sieges = Object.values(state.sieges ?? {});
  const wars = Store.getActiveWars ? Store.getActiveWars() : [];

  const atWar = wars.some((w) => w.attackerId === kingdomId || w.defenderId === kingdomId);
  const underSiege = sieges.some(
    (s) => s && s.status === "active" && s.defenderKingdomId === kingdomId
  );

  let inCivilWar = false;
  let inSuccessionCrisis = false;
  try {
    const SuccessionCrisis = require("./SuccessionCrisis.Kingdoms");
    inCivilWar = SuccessionCrisis.inCivilWar(kingdomId, state);
    inSuccessionCrisis = SuccessionCrisis.inSuccessionCrisis(kingdomId, state);
  } catch {
    inCivilWar = false;
    inSuccessionCrisis = false;
  }

  const vassals = state.vassals ?? {};
  const vassalRecord = vassals[kingdomId];
  const vassalOf = vassalRecord?.overlordId ?? null;

  let coalition = null;
  try {
    const c = Coalitions.coalitionOf(kingdomId, Store);
    coalition = c ? { name: c.name } : null;
  } catch {
    coalition = null;
  }

  return {
    atWar,
    underSiege,
    inCivilWar,
    inSuccessionCrisis,
    vassalOf,
    vassalOfName: vassalOf ? kingdomName(vassalOf) : null,
    coalition,
  };
}

/** Realm news: royal events + wars + alliances, newest first, sliced. */
function newsPayload(kingdomId) {
  const items = [];

  // Royal events (marriages, births, deaths, coronations) — last 3.
  try {
    const k = Store.getKingdom(kingdomId);
    const log = Array.isArray(k?.flags?.["royals:log"]) ? k.flags["royals:log"] : [];
    for (const e of log.slice(0, 3)) {
      items.push({ at: e.at ?? null, type: e.type ?? "royal", text: e.text ?? "" });
    }
  } catch {
    // No royal log — skip.
  }

  // Active wars involving this kingdom.
  try {
    const wars = Store.getActiveWars ? Store.getActiveWars() : [];
    for (const w of wars.slice(0, 3)) {
      if (w.attackerId !== kingdomId && w.defenderId !== kingdomId) continue;
      const other = w.attackerId === kingdomId ? w.defenderId : w.attackerId;
      const role = w.attackerId === kingdomId ? "declared war on" : "was invaded by";
      items.push({
        at: w.declaredAt ?? null,
        type: "war",
        text: `${kingdomName(kingdomId)} ${role} ${kingdomName(other)}.`,
      });
    }
  } catch {
    // No war data — skip.
  }

  // Sort newest first; items without timestamps go last.
  items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return items.slice(0, 6);
}

/** Other great powers, brief: name + relation + conflict flags. */
function realmsPayload(homeId) {
  const out = [];
  try {
    const state = Store.load();
    const sieges = Object.values(state.sieges ?? {});
    const wars = Store.getActiveWars ? Store.getActiveWars() : [];
    for (const k of Store.getKingdoms()) {
      if (k.id === homeId) continue;
      let relation = null;
      try {
        relation = homeId ? Relations.relationOf(homeId, k.id, Store) : null;
      } catch {
        relation = null;
      }
      out.push({
        id: k.id,
        name: k.name,
        ruler: k.ruler ?? null,
        relation,
        atWar: wars.some((w) => w.attackerId === k.id || w.defenderId === k.id),
        underSiege: sieges.some(
          (s) => s && s.status === "active" && s.defenderKingdomId === k.id
        ),
      });
    }
  } catch {
    // Return what we have.
  }
  return out.slice(0, 8);
}

function statusPayload(player) {
  let homeId = null;
  try {
    homeId = player ? player.getAttribute("kingdom:id") || null : null;
  } catch {
    homeId = null;
  }

  if (!homeId) {
    return { open: true, kingdom: null, standing: null, news: [], realms: [] };
  }

  const k = Store.getKingdom(homeId);
  if (!k) {
    return { open: true, kingdom: null, standing: null, news: [], realms: [] };
  }

  const status = realmStatusPayload(homeId);
  return {
    open: true,
    kingdom: {
      id: k.id,
      name: k.name,
      capital: k.capital ?? null,
      ruler: k.ruler ?? null,
      rulerTitle: k.rulerTitle ?? null,
      treasury: k.treasury ?? 0,
      situation: k.situation ?? null,
      ...status,
    },
    standing: standingPayload(player, homeId),
    news: newsPayload(homeId),
    realms: realmsPayload(homeId),
  };
}

function attach(api) {
  console.info("[mykingdom-api] registering mykingdom-status endpoint");
  api.registerContentEndpoint("mykingdom-status", (query) => {
    const player = findPlayer(api, query.get("player"));
    const action = (query.get("action") || "").trim().toLowerCase();

    if (player && (action === "open" || action === "close")) {
      try {
        player.setAttribute(MYKINGDOM_OPEN_ATTRIBUTE, action === "open" ? "1" : "");
      } catch (e) {
        console.warn("[mykingdom-api] flag update failed", e?.message ?? e);
      }
      if (action === "close") return { open: false };
      return statusPayload(player);
    }

    if (!player) return { open: false };
    let open = "";
    try {
      open = String(player.getAttribute(MYKINGDOM_OPEN_ATTRIBUTE) || "").trim();
    } catch {
      return { open: false };
    }
    if (!open) return { open: false };

    try {
      return statusPayload(player);
    } catch (e) {
      console.warn("[mykingdom-api] payload failed", e?.message ?? e);
      return { open: false };
    }
  });
}

module.exports = attach;
module.exports.attach = attach;
module.exports.MYKINGDOM_OPEN_ATTRIBUTE = MYKINGDOM_OPEN_ATTRIBUTE;
// Test seams.
module.exports._test = { statusPayload, standingPayload, newsPayload, realmsPayload };
