"use strict";

/**
 * CitizenInfrastructureLife — slow-tick dynamics for public-works infrastructure.
 *
 * Complements (does not duplicate) CitizenConstructionLife: that owns
 * buildings; this owns infrastructure networks (bridges, roads, watchtowers,
 * forts, reservoirs).
 *
 * Each tick:
 *   - advances material-stocked projects (real-time progress)
 *   - completes finished projects: built records, fame deeds, announcements
 *   - auto-commissions useful unbuilt infrastructure when the treasury
 *     affords it (public works program; skips road/bridge work during wars,
 *     forts are always welcome)
 *   - promotes engineer-career citizens with real Construction 40+
 *
 * Zero LLM. Never throws (every section is guarded).
 */

const { sayPublic } = require("../chat/CitizenSayPublic");

const AUTO_COMMISSION_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // one auto-project per week per kingdom
const ANNOUNCE_COOLDOWN_MS = 6 * 3600 * 1000;

let lastAutoCommission = {}; // kingdomId -> timestamp
let lastAnnounce = {}; // `${kingdomId}:${kind}` -> timestamp

function _now() {
  return Date.now();
}

function _throttled(map, key, cooldownMs, nowMs) {
  const last = map[key] || 0;
  if (nowMs - last < cooldownMs) return false;
  map[key] = nowMs;
  return true;
}

function _journal(director, text) {
  try {
    const j = director.getJournal ? director.getJournal() : null;
    if (j && typeof j.log === "function") j.log(text);
  } catch { /* journal unavailable */ }
}

function _sayNear(director, kingdomId, text) {
  try {
    const roster = director.roster;
    const recs = roster && roster.values ? Array.from(roster.values()) : [];
    const near = recs.find(
      (r) => r && r.kingdomId === kingdomId && director.isOnline && director.isOnline(r)
    );
    if (near) {
      const bot = director.getBot ? director.getBot(near) : null;
      if (bot) sayPublic(bot, text);
    }
  } catch { /* no audience */ }
}

function _awardFame(director, username, deed) {
  try {
    const Rep = require("./CitizenReputation");
    if (Rep && typeof Rep.awardDeed === "function") Rep.awardDeed(username, deed);
  } catch { /* reputation unavailable */ }
}

function tickInfrastructure(director, nowMs) {
  const now = nowMs || _now();
  let Infra;
  try {
    Infra = require("./CitizenInfrastructure");
  } catch {
    return; // data tier missing — nothing to do
  }

  // 1. Advance material-stocked projects; complete finished ones.
  try {
    const st = Infra.load();
    const ids = Object.keys(st.projects || {});
    for (const id of ids) {
      let res;
      try {
        res = Infra.progressProject(id, 1);
      } catch {
        continue;
      }
      if (res && res.done && res.built) {
        const b = res.built;
        const spec = Infra.specFor(b.type);
        _journal(director, `infrastructure: ${spec ? spec.label : b.type} completed in ${b.kingdomId}`);
        if (b.commissionedBy && b.commissionedBy !== "crown") {
          _awardFame(director, b.commissionedBy, "engineer");
        }
        if (_throttled(lastAnnounce, `${b.kingdomId}:built`, ANNOUNCE_COOLDOWN_MS, now)) {
          _sayNear(director, b.kingdomId, `The new ${spec ? spec.label : b.type} is finished — come and see it!`);
        }
      }
    }
  } catch { /* progress sweep failed */ }

  // 2. Public works: auto-commission one useful unbuilt project per kingdom
  //    per week when the treasury affords it.
  try {
    const kingdoms = _kingdomIds(director);
    for (const kingdomId of kingdoms) {
      if (!_throttled(lastAutoCommission, kingdomId, AUTO_COMMISSION_COOLDOWN_MS, now)) continue;
      const type = _nextUsefulProject(Infra, kingdomId, director);
      if (!type) continue;
      const opts = { royal: true };
      const spec = Infra.specFor(type);
      if (spec && spec.needsRoute) {
        const route = _bestRouteFor(director, kingdomId);
        if (!route) continue;
        opts.from = route.from;
        opts.to = route.to;
      }
      const res = Infra.commissionProject(type, kingdomId, "crown", opts);
      if (res && res.ok) {
        _journal(director, `infrastructure: crown commissioned ${type} in ${kingdomId} (public works)`);
        if (_throttled(lastAnnounce, `${kingdomId}:commission`, ANNOUNCE_COOLDOWN_MS, now)) {
          _sayNear(director, kingdomId, `The crown has commissioned a new ${spec.label} — engineers wanted!`);
        }
      }
    }
  } catch { /* public works sweep failed */ }

  // 3. Promote engineer-career citizens with real Construction 40+.
  try {
    const roster = director.roster;
    const recs = roster && roster.values ? Array.from(roster.values()) : [];
    for (const rec of recs) {
      try {
        if (!rec || !rec.username) continue;
        if (Infra.engineerFor(rec.username)) continue;
        const career = rec.career || rec.profession;
        if (career !== "engineer") continue;
        const level = _constructionLevel(rec);
        if (level >= Infra.ENGINEER_MIN_CONSTRUCTION) {
          Infra.registerEngineer(rec.username, rec.kingdomId, level);
          _journal(director, `infrastructure: ${rec.username} registered as engineer (${rec.kingdomId})`);
        }
      } catch { /* one bad record never breaks the tick */ }
    }
  } catch { /* promotion sweep failed */ }
}

function _kingdomIds(director) {
  try {
    const KingdomStore = require("../../kingdoms/KingdomStore");
    const list = KingdomStore.listKingdoms ? KingdomStore.listKingdoms() : [];
    return list.map((k) => k.id || k.kingdomId).filter(Boolean);
  } catch {
    return [];
  }
}

function _warring(director, kingdomId) {
  try {
    const KingdomStore = require("../../kingdoms/KingdomStore");
    const wars = KingdomStore.getActiveWars ? KingdomStore.getActiveWars() : [];
    return wars.some((w) => w.a === kingdomId || w.b === kingdomId || w.attacker === kingdomId || w.defender === kingdomId);
  } catch {
    return false;
  }
}

/** Pick the most useful unbuilt project type for a kingdom. */
function _nextUsefulProject(Infra, kingdomId, director) {
  const built = Infra.builtFor(kingdomId);
  const kinds = new Set(built.map((b) => b.type));
  const atWar = _warring(director, kingdomId);

  // Priority: forts in wartime, watchtowers, roads, bridges, reservoirs.
  if (atWar && !kinds.has("fort") && Infra.inventionUnlocked("fort", kingdomId)) return "fort";
  if (!kinds.has("watchtower")) return "watchtower";
  if (!kinds.has("road")) return "road";
  if (!kinds.has("bridge") && Infra.inventionUnlocked("bridge", kingdomId)) return "bridge";
  if (!kinds.has("reservoir")) return "reservoir";
  if (!kinds.has("stone_bridge") && Infra.inventionUnlocked("stone_bridge", kingdomId)) return "stone_bridge";
  if (!kinds.has("fort") && Infra.inventionUnlocked("fort", kingdomId)) return "fort";
  return null;
}

/** Pick a travel route from this kingdom that lacks a built bridge/road. */
function _bestRouteFor(director, kingdomId) {
  try {
    const Travel = require("./CitizenTravel");
    const Infra = require("./CitizenInfrastructure");
    const routes = Travel.routesFrom ? Travel.routesFrom(kingdomId) : [];
    for (const r of routes) {
      const bonus = Infra.travelBonusFor(r.from, r.to);
      if (bonus <= 0) return { from: r.from, to: r.to };
    }
    return routes.length ? { from: routes[0].from, to: routes[0].to } : null;
  } catch {
    return null;
  }
}

function _constructionLevel(rec) {
  try {
    if (rec.skills && typeof rec.skills.construction === "number") return rec.skills.construction;
    if (typeof rec.constructionLevel === "number") return rec.constructionLevel;
  } catch { /* ignore */ }
  return 1;
}

function resetForTests() {
  lastAutoCommission = {};
  lastAnnounce = {};
}

module.exports = {
  tickInfrastructure,
  resetForTests,
};
