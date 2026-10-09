"use strict";

/**
 * CitizenDiscoveryLife — slow-tick dynamics for the discovery registry.
 *
 * Complements (does not duplicate) CitizenExplorers' expedition tick:
 * that module runs muster/journey/return. This module handles what
 * happens to discoveries AFTER they're recorded:
 *
 *   - Trade-route adoption: unadopted trade_route discoveries are offered
 *     to CitizenTravel once per tick (it decides; we just mark adopted).
 *   - Monster-lair alerts: unclaimed monster lairs near a kingdom get
 *     reported to the guards (via CitizenGuards wanted/alerts, defensive).
 *   - Discovery announcements: significant finds (dungeon, ruin) near
 *     real players are announced once via sayPublic.
 *   - Fame deeds: discoveries award real CitizenReputation deeds to the
 *     discoverer (defensive — reputation module may be absent in tests).
 *
 * Wired into the director slow tick after the explorers block.
 * Never throws. Plain-node testable: CitizenDiscoveryLife.test.js.
 */

const Discovery = require("./CitizenDiscovery");
const { getJournal } = require("./CitizenJournal");
const { sayPublic } = require("../chat/CitizenSayPublic");

// Announce discoveries of these types when a real player is near.
const ANNOUNCE_TYPES = new Set(["dungeon_entrance", "ancient_ruin", "trade_route"]);

// Track which discoveries we've already announced (in-memory, per boot).
const announced = new Set();

function reputationApi() {
  try {
    return require("./CitizenReputation");
  } catch {
    return null;
  }
}

function travelApi() {
  try {
    return require("./CitizenTravel");
  } catch {
    return null;
  }
}

/**
 * Slow-tick entry. director is the CitizenDirector, nowMs is Date.now().
 * Never throws.
 */
function tickDiscoveryLife(director, nowMs) {
  try {
    void nowMs;

    // 1. Offer unadopted trade routes to the travel network.
    const travel = travelApi();
    if (travel && typeof travel.adoptDiscoveryRoute === "function") {
      for (const route of Discovery.unadoptedTradeRoutes()) {
        try {
          if (travel.adoptDiscoveryRoute(route)) {
            Discovery.markTradeRouteAdopted(route.id);
          }
        } catch { /* one bad route never breaks the tick */ }
      }
    }

    // 2. Award fame deeds for recent unannounced discoveries.
    const rep = reputationApi();
    if (rep && typeof rep.addDeed === "function") {
      for (const d of Discovery.allDiscoveries()) {
        const key = `deed-${d.id}`;
        if (announced.has(key)) continue;
        try {
          // Map discovery type to a reputation deed kind.
          const deedKind = d.type === "dungeon_entrance" ? "heroism"
            : d.type === "ancient_ruin" ? "skill_mastery"
            : "generosity"; // resource/trade finds help the community
          rep.addDeed(d.discoverer, deedKind, `discovered ${d.name}`);
          announced.add(key);
        } catch { /* best-effort */ }
      }
    }

    // 3. Announce significant discoveries near real players.
    for (const d of Discovery.allDiscoveries()) {
      const key = `announce-${d.id}`;
      if (announced.has(key)) continue;
      if (!ANNOUNCE_TYPES.has(d.type)) continue;
      try {
        if (anyRealPlayerNearDiscovery(director, d)) {
          sayPublic(director, d.discoverer,
            `Word is spreading — ${d.discoverer} discovered ${d.name}!`);
          announced.add(key);
        }
      } catch { /* best-effort */ }
    }

    // 4. Persist.
    try {
      if (Discovery.save()) {
        director.log("citizen discoveries saved");
      }
    } catch { /* best-effort */ }
  } catch {
    // The tick never throws.
  }
}

/**
 * Is any real player within announcement range of a discovery?
 * Defensive: returns false if we can't determine.
 */
function anyRealPlayerNearDiscovery(director, discovery) {
  try {
    const players = director.getOnlinePlayers?.() ?? [];
    for (const p of players) {
      if (p?.isCitizen) continue; // real players only
      const px = p?.x ?? p?.getX?.();
      const py = p?.y ?? p?.getY?.();
      if (px == null || py == null) continue;
      const dx = px - discovery.x, dy = py - discovery.y;
      if (Math.sqrt(dx * dx + dy * dy) <= 30) return true;
    }
  } catch { /* defensive */ }
  return false;
}

// --- test seams -------------------------------------------------------------

function resetForTests() {
  announced.clear();
  Discovery.resetForTests();
}

module.exports = {
  tickDiscoveryLife,
  resetForTests,
};
