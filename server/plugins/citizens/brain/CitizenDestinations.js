"use strict";

/**
 * CitizenDestinations — want-driven destination selection (slice 1 of
 * emergent citizen distribution, Jon 2026-10-13: citizens are players in a
 * sandbox, not anchored NPCs; distribution must emerge from what they do).
 *
 * The problem it solves: offline citizens never moved. record.position
 * started at home and only changed via live-movement sync or journey
 * arrival — so materialization (which spawns at record.position) piled
 * everyone on home tiles and the countryside sat empty.
 *
 * This module picks WHERE a citizen wants to be from their current wants
 * (role, goal, needs, personality) — never from an anchor assignment. The
 * data tier (lib/CitizenWhereaboutsLife) advances record.position toward
 * the picked destination; materialization follows for free.
 *
 * All tiles come from the existing data files (sites/towns/settlements
 * JSON + CitizenSites.GATHER_PLACES) — real engine tiles, zero fiction.
 * Deterministic per citizen per ~3h bucket (agentRng): a citizen keeps a
 * destination for a while, then drifts. Zero LLM, pure arithmetic.
 */

const {
  KINGDOM_IDS,
  TOWN_IDS,
  SETTLEMENT_IDS,
  siteTileByKingdom,
  siteTileByTown,
  siteTileBySettlement,
  kingdomIdOfTown,
  kingdomIdOfSettlement,
  GATHER_PLACES,
} = require("./CitizenSites");
const { agentRng } = require("../lib/humanizer");
const { needsFor, HURT_AT, WEARY_AT } = require("./CitizenNeeds");
const {
  GOAL_SAVE_GOLD,
  GOAL_RANK_UP,
  GOAL_MASTER_TRADE,
  GOAL_BOSS_SLAYER,
  GOAL_MAKE_FRIENDS,
} = require("../lib/goals");

// How long a citizen keeps one destination before re-deciding (~3h — a
// player doesn't change plans every 5 minutes).
const DEST_STICKY_MS = 3 * 60 * 60 * 1000;
// Locality weighting: nearer places are likelier, far ones still reachable.
// Explorers get a flatter curve (bigger divisor) so they actually travel.
const LOCALITY_DIVISOR = 60;
const EXPLORER_LOCALITY_DIVISOR = 180;
// Epsilon: this often the citizen just goes somewhere unplanned. Players do.
const EPSILON = 0.1;
// Inter-kingdom visits (slice 3): while a visit is active the citizen
// lingers — visited-kingdom places win more often, home-kingdom places lose
// their pull. Short visits keep record.kingdomId (visiting, not moving);
// the data tier matures long visits into relocation. Multipliers, not bans
// (Jon 2026-10-12: likes/dislikes are multipliers, never hard exclusions).
const VISIT_STAY_MULT = 1.6;
const VISIT_HOME_DAMP = 0.6;

/**
 * Resolve a candidate place to its kingdom/town/settlement placement, from
 * real data (towns.json / settlements.json kingdom links via CitizenSites;
 * capitals and gather places carry kingdomId directly). The picker returns
 * this on every destination so the data tier can run visit semantics
 * without re-deriving anything.
 */
function placementOf(place) {
  if (!place) return { kingdomId: null, townId: null, settlementId: null };
  if (place.settlementId) {
    return {
      kingdomId: kingdomIdOfSettlement(place.settlementId),
      townId: null,
      settlementId: place.settlementId,
    };
  }
  if (place.townId) {
    return {
      kingdomId: kingdomIdOfTown(place.townId),
      townId: place.townId,
      settlementId: null,
    };
  }
  return {
    kingdomId: place.kingdomId ?? null,
    townId: null,
    settlementId: null,
  };
}

/**
 * Visit bias multiplier for one candidate (slice 3). While a visit is
 * active, visited-kingdom candidates win more often (linger) and
 * home-kingdom candidates lose their pull (don't drift back early).
 * Everything else scores normally. Pure — tested directly.
 */
function visitBiasMult(candidateKingdomId, visit, homeKingdomId) {
  if (!visit || !candidateKingdomId) return 1;
  if (candidateKingdomId === visit.kingdomId) return VISIT_STAY_MULT;
  if (homeKingdomId && candidateKingdomId === homeKingdomId) return VISIT_HOME_DAMP;
  return 1;
}

/**
 * The visit the citizen is currently inside, or null. A visit is "active"
 * while now - since < len; expiry is handled by the data tier (it mutates
 * the record). Pure read — deterministic given the record.
 */
function activeVisit(record, now) {
  const v = record?.visit;
  if (!v || typeof v.kingdomId !== "string") return null;
  if (!Number.isFinite(v.since) || !Number.isFinite(v.len)) return null;
  const at = Number.isFinite(now) ? now : Date.now();
  return at - v.since < v.len ? v : null;
}

/**
 * All candidate destinations, built once from existing data. Kinds:
 * "square" (social hub), "market" (trade), "bank", "fish" (dock),
 * "tree"/"rock" (gather). Frozen — never mutated.
 */
const DEST_PLACES = (() => {
  const out = [];
  const seen = new Set();
  const add = (id, kind, spot, extra = {}) => {
    if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return;
    const key = `${kind}|${spot.x}|${spot.y}|${spot.z ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id,
      kind,
      x: spot.x,
      y: spot.y,
      z: spot.z ?? 0,
      ...extra,
    });
  };
  for (const kid of KINGDOM_IDS) {
    add(`${kid}:square`, "square", siteTileByKingdom(kid, "square"), { kingdomId: kid });
    add(`${kid}:market`, "market", siteTileByKingdom(kid, "market"), { kingdomId: kid });
    add(`${kid}:bank`, "bank", siteTileByKingdom(kid, "bank"), { kingdomId: kid });
    add(`${kid}:dock`, "fish", siteTileByKingdom(kid, "dock"), { kingdomId: kid });
  }
  for (const tid of TOWN_IDS) {
    add(`${tid}:square`, "square", siteTileByTown(tid, "square"), { townId: tid });
    add(`${tid}:market`, "market", siteTileByTown(tid, "market"), { townId: tid });
    add(`${tid}:dock`, "fish", siteTileByTown(tid, "dock"), { townId: tid });
  }
  for (const sid of SETTLEMENT_IDS) {
    add(`${sid}:square`, "square", siteTileBySettlement(sid, "square"), { settlementId: sid });
    add(`${sid}:market`, "market", siteTileBySettlement(sid, "market"), { settlementId: sid });
  }
  // Gather places (tree/rock/fish) — already deduped in CitizenSites.
  for (const p of GATHER_PLACES) {
    out.push({
      id: p.id,
      kind: p.kind,
      x: p.x,
      y: p.y,
      z: p.z ?? 0,
      kingdomId: p.kingdomId,
      tier: p.tier,
    });
  }
  return Object.freeze(out);
})();

function cheby(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function traitSet(personality) {
  return new Set(personality?.traits ?? []);
}

/**
 * A citizen's favorite gather kind — stable per citizen (like a real
 * player's favorite training spot). Deterministic, not stored.
 */
function favoriteGatherKind(username) {
  const rng = agentRng(`favgather:${username ?? "unknown"}`);
  const roll = rng();
  if (roll < 0.35) return "tree";
  if (roll < 0.65) return "rock";
  return "fish";
}

function isExplorer(traits) {
  return traits.has("curious") || traits.has("daydreamer") || traits.has("adventurous");
}

/**
 * Base want score 0..100 for a candidate kind, from role + goal +
 * personality. This is the "why" — locality multiplies it later.
 */
function kindWantScore(kind, ctx) {
  const { role, goalType, traits, favKind } = ctx;
  const chatty = traits.has("chatty") || traits.has("cheerful");
  const loner = traits.has("taciturn") || traits.has("gruff") || traits.has("suspicious");
  const greedy = traits.has("greedy");

  const gather = kind === "tree" || kind === "rock" || kind === "fish";
  let s = 10; // every place is at least a place

  if (role === "merchant") {
    if (kind === "market") s = 90;
    else if (kind === "square") s = 70;
    else if (kind === "bank") s = 50;
    else if (gather) s = 12; // merchants buy stock, they don't chop it
  } else if (role === "guard") {
    if (kind === "square") s = 85; // the keep / town beat
    else if (kind === "market") s = 35;
    else if (kind === "bank") s = 30;
    else if (gather) s = 5;
  } else if (role === "courtier") {
    if (kind === "square") s = 90;
    else if (kind === "market") s = 60;
    else if (gather) s = 5;
  } else {
    // commoner (and anything else): the goal drives it
    if (goalType === GOAL_SAVE_GOLD) {
      if (gather) s = 85;
      else if (kind === "market") s = 70; // sell the haul
      else if (kind === "bank") s = 40;
      else if (kind === "square") s = 30;
    } else if (goalType === GOAL_MASTER_TRADE) {
      if (kind === favKind) s = 95; // their grind spot
      else if (gather) s = 40;
      else if (kind === "market") s = 30;
      else if (kind === "square") s = 25;
    } else if (goalType === GOAL_RANK_UP) {
      if (kind === "square") s = 80;
      else if (kind === "market") s = 40;
      else if (gather) s = 30;
    } else if (goalType === GOAL_MAKE_FRIENDS) {
      if (kind === "square") s = 90; // socializers hang at the hub
      else if (kind === "market") s = 60;
      else if (gather) s = 20;
    } else if (goalType === GOAL_BOSS_SLAYER) {
      if (kind === "square") s = 70; // muster point
      else if (kind === "market") s = 40;
      else if (gather) s = 25;
    } else {
      if (kind === "square") s = 60;
      else if (kind === "market") s = 50;
      else if (gather) s = 60;
      else if (kind === "bank") s = 35;
    }
  }

  // Personality shading (likes/dislikes are multipliers, not bans —
  // Jon 2026-10-12: "hates mining" means it lags, never a hard exclusion).
  if (chatty) {
    if (kind === "square") s += 20;
    if (gather) s -= 10;
  }
  if (loner) {
    if (kind === "square") s -= 20;
    if (gather) s += 15;
  }
  if (greedy && kind === "market") s += 15;
  return Math.max(1, s);
}

/** Short journal-friendly reason for the pick (a player would say this). */
function reasonFor(kind, goalType, favKind) {
  if (kind === favKind && (kind === "tree" || kind === "rock" || kind === "fish")) {
    const what = kind === "tree" ? "chop some logs" : kind === "rock" ? "mine some ore" : "catch some fish";
    return `to ${what}`;
  }
  switch (kind) {
    case "tree": return "to chop some logs";
    case "rock": return "to mine some ore";
    case "fish": return "to catch some fish";
    case "market": return goalType === GOAL_SAVE_GOLD ? "to sell the haul" : "to browse the market";
    case "square": return goalType === GOAL_MAKE_FRIENDS ? "to catch up with folks" : "to see what's going on";
    case "bank": return "to sort the bank";
    default: return "for a change of scenery";
  }
}

/**
 * Pick where this citizen wants to be right now. Returns
 * { x, y, z, placeId, kind, reason, kingdomId, townId, settlementId }.
 * Deterministic per citizen per DEST_STICKY_MS bucket — stable for hours,
 * then re-decided.
 */
function pickDestination(record, nowMs) {
  const now = nowMs ?? Date.now();
  const username = record?.username ?? "unknown";
  const rng = agentRng(`dest:${username}:${Math.floor(now / DEST_STICKY_MS)}`);
  const px = Number.isFinite(record?.position?.x) ? record.position.x : record?.home?.x ?? 3200;
  const py = Number.isFinite(record?.position?.y) ? record.position.y : record?.home?.y ?? 3200;
  const pz = Number.isFinite(record?.position?.z) ? record.position.z : record?.home?.z ?? 0;

  const homeTile = record?.home;
  const homeDest = (reason) => ({
    x: homeTile?.x ?? px,
    y: homeTile?.y ?? py,
    z: homeTile?.z ?? pz,
    placeId: "home",
    kind: "home",
    reason,
    kingdomId: record?.kingdomId ?? null,
    townId: record?.townId ?? null,
    settlementId: record?.settlementId ?? null,
  });

  // Needs first: hurt or weary citizens head home. There is no hunger in
  // RuneScape — the food need is HP-driven, and energy is run energy.
  try {
    const needs = needsFor(username);
    if (needs && (needs.hp < HURT_AT || needs.energy < WEARY_AT)) {
      return homeDest(needs.hp < HURT_AT ? "to rest up and heal" : "to rest weary legs");
    }
  } catch {
    // needs unreadable — decide from wants anyway
  }

  if (!DEST_PLACES.length) return homeDest("to rest up at home");

  const role = record?.role ?? "commoner";
  const goalType = record?.goal?.type ?? null;
  const traits = traitSet(record?.personality);
  const favKind = favoriteGatherKind(username);
  const explorer = isExplorer(traits);
  const localityDiv = explorer ? EXPLORER_LOCALITY_DIVISOR : LOCALITY_DIVISOR;

  const ctx = { role, goalType, traits, favKind };
  // A visit in progress: linger where you are, don't drift home early.
  const visit = activeVisit(record, now);
  const homeKid = record?.kingdomId ?? null;
  let best = null;
  let bestScore = -Infinity;
  for (const c of DEST_PLACES) {
    const want = kindWantScore(c.kind, ctx);
    const dist = cheby(px, py, c.x, c.y);
    const locality = 1 / (1 + dist / localityDiv);
    const planePenalty = c.z !== pz ? 0.05 : 1; // stay on this plane
    let score = want * locality * planePenalty;
    if (visit) {
      const ck = c.kingdomId ?? (c.townId ? kingdomIdOfTown(c.townId) : null)
        ?? (c.settlementId ? kingdomIdOfSettlement(c.settlementId) : null);
      score *= visitBiasMult(ck, visit, homeKid);
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  // Epsilon-greedy: sometimes a player just decides to go somewhere.
  if (rng() < EPSILON) {
    best = DEST_PLACES[Math.floor(rng() * DEST_PLACES.length)];
  }
  if (!best) return homeDest("to rest up at home");

  const place = placementOf(best);
  return {
    x: best.x,
    y: best.y,
    z: best.z,
    placeId: best.id,
    kind: best.kind,
    reason: reasonFor(best.kind, goalType, favKind),
    kingdomId: place.kingdomId,
    townId: place.townId,
    settlementId: place.settlementId,
  };
}

/** True when the citizen's position is at (within radius of) the destination. */
function arrivedAt(record, dest, radius = 6) {
  if (!record?.position || !dest) return false;
  return (
    (record.position.z ?? 0) === (dest.z ?? 0) &&
    cheby(record.position.x, record.position.y, dest.x, dest.y) <= radius
  );
}

module.exports = {
  DEST_PLACES,
  DEST_STICKY_MS,
  VISIT_STAY_MULT,
  VISIT_HOME_DAMP,
  pickDestination,
  arrivedAt,
  favoriteGatherKind,
  placementOf,
  activeVisit,
  visitBiasMult,
};
