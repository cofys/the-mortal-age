"use strict";

/**
 * Coalitions.Kingdoms — the COALITION LAYER. A coalition is not a new kind
 * of pact: it is what three or more kingdoms become when their bilateral
 * pacts link up into a connected component. No separate registry, no
 * second source of truth — the alliance graph IS the coalition map, and
 * this module just reads its shape.
 *
 * A component of the alliance graph with 3+ members is a coalition. When
 * one forms, the realm names it and announces it; when pacts break and
 * the component falls below three, the coalition dissolves. Names stick
 * to a coalition as membership drifts (a fourth crown joining doesn't
 * rename the league) via overlap matching.
 *
 * Driven by the AI diplomacy council (AiDiplomacy calls
 * reconcileCoalitions each tick); the WarTable reads coalitionsOf for
 * the realm map. Pure functions — pass a fixed rng for deterministic
 * names in tests.
 *
 * RuneScape grounding: coalitions are how the realm's map of friends
 * becomes a map of blocs. Three crowns signing pairwise pacts wake up
 * one morning to find they are a league — and everyone else has noticed.
 */

const COALITION_MIN_MEMBERS = 3;
/** A record survives membership drift while it still overlaps this much. */
const COALITION_OVERLAP_KEEP = 0.5;

function coalitionKey(members) {
  return [...members].map(String).sort().join("|");
}

function alliancesOf(store) {
  const alliances = store.load().alliances;
  return Array.isArray(alliances) ? alliances : [];
}

function coalitionRecords(store) {
  const state = store.load();
  if (!state.coalitionRecords || typeof state.coalitionRecords !== "object") {
    state.coalitionRecords = {};
  }
  return state.coalitionRecords;
}

function nameOf(kingdomId, store) {
  return store.getKingdom?.(kingdomId)?.name ?? String(kingdomId);
}

function capitalOf(kingdomId, store) {
  return store.getKingdom?.(kingdomId)?.capital ?? nameOf(kingdomId, store);
}

/**
 * Connected components of the alliance graph. Union-find over pact
 * pairs; components are returned sorted by size, largest first.
 */
function componentsOf(store) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const r of alliancesOf(store)) {
    if (!r || !r.a || !r.b) continue;
    union(String(r.a), String(r.b));
  }

  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()]
    .map((members) => members.sort())
    .sort((a, b) => b.length - a.length);
}

/** Pacts wholly inside a member set. */
function pactsWithin(members, store) {
  const set = new Set(members.map(String));
  return alliancesOf(store).filter((r) => r && set.has(String(r.a)) && set.has(String(r.b)));
}

function strengthOf(pacts) {
  return pacts.reduce((sum, r) => sum + (Number(r?.strength) || 1), 0);
}

function coalitionNameFor(members, store, rng) {
  const caps = [...members].map((m) => capitalOf(m, store)).sort();
  const [capA, capB] = caps;
  const names = [
    `the ${capA} League`,
    `the Grand ${capA} Compact`,
    `the ${capA} Concordat`,
    `the ${capA}-${capB} Alliance`,
  ];
  return names[Math.floor((rng ?? Math.random)() * names.length)];
}

/**
 * Every coalition in the realm right now: connected alliance components
 * of 3+ kingdoms, largest first. Each record: { key, members, name,
 * pactCount, totalStrength, formedAt }. Names come from the persisted
 * records so they survive membership drift; a component with no record
 * yet gets a provisional name (reconcileCoalitions persists it).
 */
function coalitionsOf(store, opts = {}) {
  const records = coalitionRecords(store);
  const out = [];
  for (const members of componentsOf(store)) {
    if (members.length < COALITION_MIN_MEMBERS) continue;
    const key = coalitionKey(members);
    const rec = records[key];
    const pacts = pactsWithin(members, store);
    out.push({
      key,
      members,
      name: rec?.name ?? coalitionNameFor(members, store, opts.rng),
      pactCount: pacts.length,
      totalStrength: strengthOf(pacts),
      formedAt: rec?.announcedAt ?? null,
    });
  }
  return out;
}

/** The coalition a kingdom belongs to, or null. */
function coalitionOf(kingdomId, store, opts = {}) {
  const id = String(kingdomId);
  return coalitionsOf(store, opts).find((c) => c.members.includes(id)) ?? null;
}

/** Jaccard overlap of two member sets. */
function overlap(a, b) {
  const setB = new Set(b.map(String));
  const inter = a.filter((m) => setB.has(String(m))).length;
  const unionSize = new Set([...a.map(String), ...b.map(String)]).size;
  return unionSize === 0 ? 0 : inter / unionSize;
}

/**
 * Reconcile persisted coalition records with the live alliance graph.
 * Emits:
 *   { type: "coalition-formed", coalition: { key, name, members } }
 *   { type: "coalition-dissolved", name, members }
 * Pure apart from the record writes; pass a fixed rng for tests.
 */
function reconcileCoalitions(store, opts = {}) {
  const rng = opts.rng ?? Math.random;
  const events = [];
  const records = coalitionRecords(store);
  const recordKeys = Object.keys(records);

  const matched = new Set();
  for (const members of componentsOf(store)) {
    if (members.length < COALITION_MIN_MEMBERS) continue;
    // Keep an existing record when the component still mostly overlaps
    // it — a fourth crown joining doesn't rename the league.
    let bestKey = null;
    let bestOverlap = 0;
    for (const key of recordKeys) {
      if (matched.has(key)) continue;
      const rec = records[key];
      if (!rec || !Array.isArray(rec.members)) continue;
      const ov = overlap(members, rec.members);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        bestKey = key;
      }
    }

    if (bestKey && bestOverlap >= COALITION_OVERLAP_KEEP) {
      const rec = records[bestKey];
      matched.add(bestKey);
      // Re-key when membership changed so lookups stay exact.
      const newKey = coalitionKey(members);
      rec.members = members;
      rec.pactCount = pactsWithin(members, store).length;
      rec.totalStrength = strengthOf(pactsWithin(members, store));
      if (newKey !== bestKey) {
        records[newKey] = rec;
        delete records[bestKey];
        matched.delete(bestKey);
        matched.add(newKey);
      }
    } else {
      const key = coalitionKey(members);
      const name = coalitionNameFor(members, store, rng);
      const pacts = pactsWithin(members, store);
      records[key] = {
        key,
        members,
        name,
        pactCount: pacts.length,
        totalStrength: strengthOf(pacts),
        announcedAt: Date.now(),
      };
      matched.add(key);
      events.push({
        type: "coalition-formed",
        coalition: { key, name, members: [...members] },
      });
    }
  }

  // Records with no live component: the coalition is gone.
  for (const key of recordKeys) {
    if (matched.has(key)) continue;
    const rec = records[key];
    delete records[key];
    if (rec && Array.isArray(rec.members) && rec.members.length >= COALITION_MIN_MEMBERS) {
      events.push({
        type: "coalition-dissolved",
        name: rec.name ?? "the coalition",
        members: [...rec.members],
      });
    }
  }

  return events;
}

module.exports = {
  coalitionsOf,
  coalitionOf,
  reconcileCoalitions,
  coalitionNameFor,
  COALITION_MIN_MEMBERS,
};
