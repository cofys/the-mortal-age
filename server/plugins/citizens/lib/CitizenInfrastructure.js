"use strict";

/**
 * CitizenInfrastructure — persistent registry of REAL public-works infrastructure.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenEngineers owns the hash-derived flavor: millwright/siege/aqueduct
 *     engineer types, per-day device catalogs, great-work fiction, commission
 *     ledger. Fiction, not persistent game state.
 *   - CitizenArchitects owns the hash-derived blueprint flavor and
 *     grand-design fiction (surveyors, inspectors, in-memory ledgers).
 *   - CitizenConstruction owns REAL persistent BUILDINGS (granary, barracks,
 *     walls, aqueduct, lighthouse, monuments...): single structures with
 *     game effects, blueprints, districts.
 *   - CitizenInventions owns real invention research: blueprints, patents,
 *     royalties. Engineering PROJECTS may gate on invention blueprints.
 *   - THIS module owns REAL persistent INFRASTRUCTURE: networks that connect
 *     places and change how the world moves — bridges and roads on real
 *     travel routes (real journey-time effects), watchtowers and border forts
 *     (real defense effects), reservoirs (real farm effects). Funded by the
 *     real kingdom treasury as public works, or by private donation.
 *
 * Project types (type -> effect). Effects are read live by the modules that
 * care (defensive reads so a missing module degrades silently):
 *   - bridge:      spans a river on a travel route; 0.85x journey duration
 *                  on that route (CitizenTravel reads travelBonusFor).
 *   - road:        paved highway between capitals; 0.9x journey duration +
 *                  reduced bandit risk on that route.
 *   - watchtower:  border watchtower; +6 patrol effectiveness (new kind,
 *                  read by guard/militia modules via patrolBonusFor).
 *   - fort:        border fort; +8 siege defense (stacks with city walls).
 *   - reservoir:   water storage; +8 farm growth (stacks with aqueduct).
 *
 * Invention gate: advanced projects (stone_bridge, fort) require the
 * kingdom to hold the matching CitizenInventions blueprint completion
 * (defensive: missing invention module = unlocked).
 *
 * Zero LLM. Dirty-flag persistence. Plain-node testable.
 */

const MATERIALS = Object.freeze({
  plank: 960,
  oak_plank: 8778,
  nails: 4819,
  iron_bar: 2351,
  steel_bar: 2353,
  rope: 954,
  soft_clay: 1761,
  stone: 434, // limestone brick stand-in; resolved defensively
});

// Project catalog: label, workTicks (slow-tick cycles), materials,
// effect (machine-readable), needsInvention (CitizenInventions blueprint id).
const PROJECTS = Object.freeze({
  bridge: Object.freeze({
    label: "bridge",
    workTicks: 96,
    materials: Object.freeze({ [MATERIALS.plank]: 60, [MATERIALS.iron_bar]: 15, [MATERIALS.rope]: 30 }),
    effect: Object.freeze({ kind: "route_speed", amount: 15, route: true }),
    needsRoute: true,
    fame: 6,
  }),
  stone_bridge: Object.freeze({
    label: "stone bridge",
    workTicks: 144,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 120, [MATERIALS.iron_bar]: 25, [MATERIALS.rope]: 20 }),
    effect: Object.freeze({ kind: "route_speed", amount: 20, route: true }),
    needsRoute: true,
    needsInvention: "improved_pickaxe",
    fame: 8,
  }),
  road: Object.freeze({
    label: "paved road",
    workTicks: 120,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 100, [MATERIALS.plank]: 20 }),
    effect: Object.freeze({ kind: "route_speed", amount: 10, route: true, safer: true }),
    needsRoute: true,
    fame: 6,
  }),
  watchtower: Object.freeze({
    label: "watchtower",
    workTicks: 72,
    materials: Object.freeze({ [MATERIALS.plank]: 40, [MATERIALS.nails]: 40, [MATERIALS.rope]: 10 }),
    effect: Object.freeze({ kind: "patrol_range", amount: 6 }),
    fame: 5,
  }),
  fort: Object.freeze({
    label: "border fort",
    workTicks: 180,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 150, [MATERIALS.iron_bar]: 30, [MATERIALS.plank]: 40 }),
    effect: Object.freeze({ kind: "siege_defense", amount: 8 }),
    needsInvention: "reinforced_axe",
    fame: 9,
  }),
  reservoir: Object.freeze({
    label: "reservoir",
    workTicks: 120,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 140, [MATERIALS.iron_bar]: 10 }),
    effect: Object.freeze({ kind: "farm_growth", amount: 8 }),
    fame: 6,
  }),
});

const ENGINEER_MIN_CONSTRUCTION = 40;
const ROYAL_PROJECT_FEE = 8000; // coins from the real treasury per project
const SAVE_PATH = "data/saves/citizen-infrastructure.json";

// --- state -----------------------------------------------------------------

let cache = null; // { engineers, projects, built, seq }
let dirty = false;

function blankState() {
  return { engineers: {}, projects: {}, built: {}, seq: 1 };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), SAVE_PATH);
    if (fs.existsSync(full)) {
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      if (raw && typeof raw === "object") {
        cache = Object.assign(blankState(), raw);
      }
    }
  } catch {
    cache = blankState();
  }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), SAVE_PATH);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

function nextId(prefix) {
  const st = load();
  const id = `${prefix}_${st.seq++}`;
  markDirty();
  return id;
}

function _setSavePathForTests() {} // seam parity with siblings (unused)
function resetForTests() {
  cache = null;
  dirty = false;
}

// --- catalog ----------------------------------------------------------------

function catalog() {
  return Object.assign({}, PROJECTS);
}

function specFor(type) {
  return PROJECTS[type] || null;
}

// --- invention gate ----------------------------------------------------------

/**
 * Advanced projects need the kingdom to hold a completed invention.
 * Defensive: a missing/broken invention module means "unlocked".
 */
function inventionUnlocked(type, kingdomId) {
  const spec = specFor(type);
  if (!spec || !spec.needsInvention) return true;
  try {
    const Inventions = require("./CitizenInventions");
    return Inventions.isBlueprintUnlocked(spec.needsInvention, kingdomId);
  } catch {
    return true;
  }
}

// --- engineers ---------------------------------------------------------------

/**
 * Register an engineer (citizen with real Construction 40+).
 * Returns the engineer record.
 */
function registerEngineer(username, kingdomId, constructionLevel) {
  const st = load();
  const key = String(username).toLowerCase();
  if (!st.engineers[key]) {
    st.engineers[key] = {
      username: String(username),
      kingdomId: kingdomId || null,
      constructionLevel: constructionLevel || ENGINEER_MIN_CONSTRUCTION,
      projectsBuilt: 0,
      registeredAt: Date.now(),
    };
    markDirty();
  }
  return st.engineers[key];
}

function engineerFor(username) {
  const st = load();
  return st.engineers[String(username).toLowerCase()] || null;
}

function engineersFor(kingdomId) {
  const st = load();
  return Object.values(st.engineers).filter((e) => e.kingdomId === kingdomId);
}

// --- projects ----------------------------------------------------------------

/**
 * Commission an infrastructure project. options:
 *   - kingdomId (required)
 *   - commissionedBy (username or "crown")
 *   - from, to (required for route projects: bridge/stone_bridge/road)
 *   - royal (bool): funded by the real kingdom treasury.
 *     Returns { ok:false, reason:"insufficient-treasury" } when broke.
 *   - private: funded by real coin donations (funded starts at 0).
 */
function commissionProject(type, kingdomId, commissionedBy, options = {}) {
  const st = load();
  const spec = specFor(type);
  if (!spec) return { ok: false, reason: "unknown-type" };
  if (!kingdomId) return { ok: false, reason: "no-kingdom" };
  if (spec.needsRoute && (!options.from || !options.to)) {
    return { ok: false, reason: "no-route" };
  }
  if (!inventionUnlocked(type, kingdomId)) {
    return { ok: false, reason: "invention-locked" };
  }

  const royal = !!options.royal;
  if (royal) {
    try {
      const KingdomStore = require("../../kingdoms/KingdomStore");
      const kingdom = KingdomStore.getKingdom?.(kingdomId);
      if (!kingdom || (kingdom.treasury ?? 0) < ROYAL_PROJECT_FEE) {
        return { ok: false, reason: "insufficient-treasury" };
      }
      const spent = KingdomStore.spendFromTreasury?.(kingdomId, ROYAL_PROJECT_FEE);
      if (spent === false) return { ok: false, reason: "insufficient-treasury" };
    } catch {
      return { ok: false, reason: "treasury-unavailable" };
    }
  }

  const id = nextId("infra");
  st.projects[id] = {
    id,
    type,
    kingdomId,
    from: options.from || null,
    to: options.to || null,
    commissionedBy: commissionedBy || "crown",
    royal,
    funded: royal ? ROYAL_PROJECT_FEE : 0,
    stockpile: {}, // itemId -> count (real donated materials)
    progress: 0,
    workTicks: spec.workTicks,
    createdAt: Date.now(),
  };
  markDirty();
  return { ok: true, project: st.projects[id] };
}

function project(id) {
  const st = load();
  return st.projects[id] || null;
}

function projectsFor(kingdomId) {
  const st = load();
  return Object.values(st.projects).filter((p) => p.kingdomId === kingdomId);
}

function activeProjectFor(kingdomId) {
  const list = projectsFor(kingdomId);
  return list.length ? list[0] : null;
}

/**
 * Donate real materials into a project stockpile.
 * materials: { itemId: count }. Returns { ok, stockpiled }.
 */
function donateMaterials(projectId, materials) {
  const st = load();
  const proj = st.projects[projectId];
  if (!proj) return { ok: false, reason: "no-project" };
  const spec = specFor(proj.type);
  const stockpiled = {};
  for (const [itemId, count] of Object.entries(materials || {})) {
    const need = spec.materials[itemId] ?? 0;
    const have = proj.stockpile[itemId] ?? 0;
    const room = Math.max(0, need - have);
    const give = Math.min(room, Math.max(0, count | 0));
    if (give > 0) {
      proj.stockpile[itemId] = have + give;
      stockpiled[itemId] = give;
    }
  }
  if (Object.keys(stockpiled).length) markDirty();
  return { ok: true, stockpiled };
}

/** Donate real coins toward a private project. */
function donateCoins(projectId, amount) {
  const st = load();
  const proj = st.projects[projectId];
  if (!proj) return { ok: false, reason: "no-project" };
  if (proj.royal) return { ok: false, reason: "royal-funded" };
  const give = Math.max(0, amount | 0);
  if (give <= 0) return { ok: false, reason: "no-amount" };
  proj.funded += give;
  markDirty();
  return { ok: true, funded: proj.funded };
}

function materialsComplete(proj) {
  const spec = specFor(proj.type);
  if (!spec) return false;
  return Object.entries(spec.materials).every(
    ([itemId, need]) => (proj.stockpile[itemId] ?? 0) >= need
  );
}

/** Advance a project by ticks (slow-tick progress). Only when materials are stocked. */
function progressProject(projectId, ticks = 1) {
  const st = load();
  const proj = st.projects[projectId];
  if (!proj) return { ok: false, reason: "no-project" };
  if (!materialsComplete(proj)) return { ok: false, reason: "awaiting-materials" };
  proj.progress += ticks;
  markDirty();
  if (proj.progress >= proj.workTicks) {
    return completeProject(projectId);
  }
  return { ok: true, progress: proj.progress, done: false };
}

/** Hands-on work by an engineer citizen: extra progress + returns ticks applied. */
function workOnProject(projectId, ticks = 1) {
  return progressProject(projectId, ticks);
}

function completeProject(projectId) {
  const st = load();
  const proj = st.projects[projectId];
  if (!proj) return { ok: false, reason: "no-project" };
  const spec = specFor(proj.type);
  delete st.projects[projectId];
  const builtId = nextId("built");
  st.built[builtId] = {
    id: builtId,
    type: proj.type,
    kingdomId: proj.kingdomId,
    from: proj.from,
    to: proj.to,
    commissionedBy: proj.commissionedBy,
    builtAt: Date.now(),
    effect: spec ? spec.effect : null,
    fame: spec ? spec.fame : 0,
  };
  markDirty();
  return { ok: true, done: true, built: st.built[builtId] };
}

// --- built infrastructure ------------------------------------------------------

function builtFor(kingdomId) {
  const st = load();
  return Object.values(st.built).filter((b) => b.kingdomId === kingdomId);
}

function allBuilt() {
  const st = load();
  return Object.values(st.built);
}

/**
 * Live effect read: sum of built effect amounts for a kingdom + kind.
 * Defensive: returns 0 when nothing is built.
 */
function effectBonus(kingdomId, kind) {
  const st = load();
  return Object.values(st.built)
    .filter((b) => b.kingdomId === kingdomId && b.effect && b.effect.kind === kind)
    .reduce((sum, b) => sum + (b.effect.amount || 0), 0);
}

/**
 * Route travel bonus: total route_speed % on a from->to route
 * (bridge + road stack). Returns 0 when nothing built.
 */
function travelBonusFor(from, to) {
  const st = load();
  return Object.values(st.built)
    .filter(
      (b) =>
        b.effect && b.effect.kind === "route_speed" && b.effect.route &&
        ((b.from === from && b.to === to) || (b.from === to && b.to === from))
    )
    .reduce((sum, b) => sum + (b.effect.amount || 0), 0);
}

/** Is a route made safer by a built road? */
function routeSafer(from, to) {
  const st = load();
  return Object.values(st.built).some(
    (b) =>
      b.effect && b.effect.kind === "route_speed" && b.effect.safer &&
      ((b.from === from && b.to === to) || (b.from === to && b.to === from))
  );
}

function describe() {
  const st = load();
  const n = Object.keys(st.projects).length;
  const b = Object.keys(st.built).length;
  const e = Object.keys(st.engineers).length;
  return `${n} active project${n === 1 ? "" : "s"}, ${b} built, ${e} engineer${e === 1 ? "" : "s"}`;
}

const SITE_OFFSETS = [
  { dx: 10, dy: -6 },
  { dx: -8, dy: -9 },
  { dx: 6, dy: 10 },
];

/** Deterministic infrastructure-site tile per kingdom (near the market). */
function siteTile(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const base = siteTileByKingdom(kingdomId, "market");
    if (base && typeof base.x === "number") {
      const o = SITE_OFFSETS[hashCode(String(kingdomId)) % SITE_OFFSETS.length];
      return { x: base.x + o.dx, y: base.y + o.dy, z: base.z ?? 0 };
    }
  } catch {}
  return null;
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

module.exports = {
  MATERIALS,
  ENGINEER_MIN_CONSTRUCTION,
  ROYAL_PROJECT_FEE,
  catalog,
  specFor,
  inventionUnlocked,
  registerEngineer,
  engineerFor,
  engineersFor,
  commissionProject,
  project,
  projectsFor,
  activeProjectFor,
  donateMaterials,
  donateCoins,
  materialsComplete,
  progressProject,
  workOnProject,
  completeProject,
  builtFor,
  allBuilt,
  effectBonus,
  travelBonusFor,
  routeSafer,
  describe,
  siteTile,
  load,
  save,
  resetForTests,
};
