"use strict";

/**
 * WarTableApi — HTTP data layer for the web client's war table overlay.
 *
 * The war table is studied diegetically (a table object in each capital's
 * war room); the overlay itself is a React HTML/CSS panel in the TMA
 * heraldic style, fed by this endpoint:
 *
 *   GET /api/wartable-status?player=<username>
 *     -> { open, playerKingdom, kingdoms, wars, endedWars, alliances, relations }
 *
 *   ...&action=open    — mark the table open for this player
 *   ...&action=close   — mark the table closed for this player
 *
 * The engine-widget war table (WarTable.Kingdoms, group 30015) sets the
 * open flag instead of opening the widget; this endpoint is the data side.
 * Read-heavy by design: all writes are the open/close flag.
 */

const Store = require("./KingdomStore");

const WARTABLE_OPEN_ATTRIBUTE = "wartable:open";

function kingdomName(id) {
  const k = Store.getKingdom(id);
  return k ? k.name : String(id);
}

function kingdomPayload(k) {
  return {
    id: k.id,
    name: k.name,
    capital: k.capital ?? null,
    ruler: k.ruler ?? null,
    rulerTitle: k.rulerTitle ?? null,
    treasury: k.treasury ?? 0,
    situation: k.situation ?? null,
  };
}

function statusPayload(player) {
  const kingdoms = Store.getKingdoms().map(kingdomPayload);
  const byId = new Map(kingdoms.map((k) => [k.id, k]));

  const wars = Store.getActiveWars().map((w) => ({
    attacker: w.attackerId,
    defender: w.defenderId,
    attackerName: kingdomName(w.attackerId),
    defenderName: kingdomName(w.defenderId),
    reason: w.reason ?? null,
    declaredAt: w.declaredAt ?? null,
  }));

  const endedWars = Store.getEndedWars()
    .slice(-6)
    .reverse()
    .map((w) => ({
      attackerName: kingdomName(w.attackerId),
      defenderName: kingdomName(w.defenderId),
      outcome: w.outcome ?? "unknown",
      endedAt: w.endedAt ?? null,
    }));

  const alliances = Store.getAlliances().map((a) => ({
    a: a.a,
    b: a.b,
    aName: kingdomName(a.a),
    bName: kingdomName(a.b),
    pactName: a.pactName ?? null,
    strength: a.strength ?? 1,
    formedAt: a.formedAt ?? null,
  }));

  // Pairwise relations across every great power: tension 0-100 + allied flag.
  const relations = [];
  for (let i = 0; i < kingdoms.length; i++) {
    for (let j = i + 1; j < kingdoms.length; j++) {
      const a = kingdoms[i].id;
      const b = kingdoms[j].id;
      relations.push({
        a,
        b,
        tension: Store.getRawTension(a, b),
        allied: Store.isAllied(a, b),
      });
    }
  }

  let playerKingdom = null;
  if (player) {
    const kid = player.getAttribute("kingdom:id") || null;
    const rank = player.getAttribute("kingdom:rank") || null;
    if (kid && byId.has(kid)) {
      playerKingdom = { id: kid, name: byId.get(kid).name, rank };
    }
  }

  return {
    open: player ? player.getAttribute(WARTABLE_OPEN_ATTRIBUTE) === "1" : false,
    playerKingdom,
    kingdoms,
    wars,
    endedWars,
    alliances,
    relations,
  };
}

function findPlayer(api, username) {
  const name = (username || "").trim();
  if (!name) return null;
  try {
    return api.core.World.getPlayerByName(name) || null;
  } catch {
    return null;
  }
}

function attach(api) {
  console.info("[wartable-api] registering wartable-status endpoint");
  api.registerContentEndpoint("wartable-status", (query) => {
    const player = findPlayer(api, query.get("player"));
    const action = (query.get("action") || "").trim().toLowerCase();
    if (player && (action === "open" || action === "close")) {
      try {
        player.setAttribute(WARTABLE_OPEN_ATTRIBUTE, action === "open" ? "1" : "0");
      } catch (e) {
        console.warn("[wartable-api] flag update failed", e?.message ?? e);
      }
    }
    return statusPayload(player);
  });
}

module.exports = attach;
module.exports.attach = attach;
module.exports.WARTABLE_OPEN_ATTRIBUTE = WARTABLE_OPEN_ATTRIBUTE;
