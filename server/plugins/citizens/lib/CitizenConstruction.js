"use strict";

/**
 * CitizenConstruction — persistent registry of REAL construction projects.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenArchitects owns the hash-derived flavor: daily blueprint
 *     catalogs (fiction), grand-design fiction, surveyor announcements,
 *     inspector sign-offs, in-memory commission ledgers.
 *   - CitizenBuilders owns the visible crew: one active flavored project
 *     per kingdom with phases, builder identities, site gatherings.
 *   - THIS module owns the REAL construction layer: persistent blueprints
 *     designed by real citizens/players, projects with real material
 *     costs, real donations from real inventories, real funding (kingdom
 *     treasury or private), real-time progress on the slow tick, and
 *     persistent BUILT records that carry REAL game effects
 *     (granaries boost food storage, walls boost siege defense, etc.).
 *
 * Building catalog (type -> effect). Effects are read live by the modules
 * that care (defensive reads so a missing module degrades silently):
 *   - granary:      +50 food storage capacity (economy)
 *   - barracks:     +4 guard capacity (militia)
 *   - market_hall:  +5% trade prices (merchants)
 *   - walls:        +10% siege defense (kingdoms)
 *   - temple:       +10% devotion gain (faith)
 *   - library:      +5% education XP (schools)
 *   - bathhouse:    +20% natural recovery (health)
 *   - aqueduct:     +10% farm growth (seasons)
 *   - lighthouse:   +10% ship travel speed (travel)
 *   - monument:     +kingdom prestige (reputation/fame)
 *
 * Landmarks (wonders) are royal-commission-only: bigger costs, bigger
 * effects, realm-wide announcement:
 *   - grand_temple:   +25% devotion, kingdom-wide
 *   - great_wall:     +25% siege defense, kingdom-wide
 *   - royal_palace:   +10% tax revenue, kingdom-wide
 *
 * Blueprints: a designer (citizen with real Construction 30+, or a real
 * player) creates a persistent blueprint record: type, size, style.
 * Costs 1 papyrus (real item) to draft.
 *
 * Projects: commissioned by the kingdom (royal — funded by the real
 * treasury via KingdomStore) or privately (funded by real coin donations).
 * Materials are real item donations from real inventories into the
 * project stockpile. Progress advances on the slow tick when materials
 * are stocked; builder-citizens working on site add hands-on progress.
 *
 * City planning: each kingdom has persistent districts; completed
 * buildings are assigned to districts.
 *
 * Zero LLM. All state transitions are pure functions of stored state.
 * Plain-node testable: CitizenConstruction.test.js.
 */

const { getJournal } = require("./CitizenJournal");

// --- tuning ---------------------------------------------------------------

// Real engine item IDs (must exist in the engine).
const MATERIALS = Object.freeze({
  plank: 960, // regular planks
  oak_plank: 8778,
  nails: 4819,
  iron_bar: 2351,
  steel_bar: 2353,
  rope: 954,
  soft_clay: 1761,
  papyrus: 970,
  hammer: 2347,
  saw: 8794,
});

const BLUEPRINT_COST_PAPYRUS = 1;
const BLUEPRINT_MIN_CONSTRUCTION = 30;

// Building catalog: label, workTicks (slow-tick cycles), materials,
// effect (machine-readable for live reads), district it belongs in.
const BUILDINGS = Object.freeze({
  granary: Object.freeze({
    label: "granary",
    workTicks: 72, // ~3 days of slow ticks
    materials: Object.freeze({ [MATERIALS.plank]: 40, [MATERIALS.nails]: 60 }),
    effect: Object.freeze({ kind: "food_storage", amount: 50 }),
    district: "market",
    fame: 5,
  }),
  barracks: Object.freeze({
    label: "guard barracks",
    workTicks: 72,
    materials: Object.freeze({ [MATERIALS.plank]: 30, [MATERIALS.iron_bar]: 10, [MATERIALS.nails]: 40 }),
    effect: Object.freeze({ kind: "guard_capacity", amount: 4 }),
    district: "military",
    fame: 5,
  }),
  market_hall: Object.freeze({
    label: "market hall",
    workTicks: 96,
    materials: Object.freeze({ [MATERIALS.oak_plank]: 40, [MATERIALS.nails]: 80, [MATERIALS.rope]: 10 }),
    effect: Object.freeze({ kind: "trade_prices", amount: 5 }),
    district: "market",
    fame: 6,
  }),
  walls: Object.freeze({
    label: "city walls",
    workTicks: 120,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 100, [MATERIALS.iron_bar]: 20, [MATERIALS.rope]: 20 }),
    effect: Object.freeze({ kind: "siege_defense", amount: 10 }),
    district: "military",
    fame: 7,
  }),
  temple: Object.freeze({
    label: "temple",
    workTicks: 96,
    materials: Object.freeze({ [MATERIALS.oak_plank]: 30, [MATERIALS.soft_clay]: 40, [MATERIALS.rope]: 10 }),
    effect: Object.freeze({ kind: "devotion_gain", amount: 10 }),
    district: "faith",
    fame: 6,
  }),
  library: Object.freeze({
    label: "library",
    workTicks: 96,
    materials: Object.freeze({ [MATERIALS.oak_plank]: 50, [MATERIALS.papyrus]: 20, [MATERIALS.nails]: 40 }),
    effect: Object.freeze({ kind: "education_xp", amount: 5 }),
    district: "civic",
    fame: 6,
  }),
  bathhouse: Object.freeze({
    label: "bathhouse",
    workTicks: 72,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 60, [MATERIALS.plank]: 20 }),
    effect: Object.freeze({ kind: "recovery_rate", amount: 20 }),
    district: "civic",
    fame: 5,
  }),
  aqueduct: Object.freeze({
    label: "aqueduct",
    workTicks: 120,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 120, [MATERIALS.iron_bar]: 15 }),
    effect: Object.freeze({ kind: "farm_growth", amount: 10 }),
    district: "civic",
    fame: 7,
  }),
  lighthouse: Object.freeze({
    label: "lighthouse",
    workTicks: 120,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 80, [MATERIALS.iron_bar]: 10, [MATERIALS.rope]: 30 }),
    effect: Object.freeze({ kind: "ship_speed", amount: 10 }),
    district: "harbor",
    fame: 7,
  }),
  monument: Object.freeze({
    label: "monument",
    workTicks: 60,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 50, [MATERIALS.iron_bar]: 5 }),
    effect: Object.freeze({ kind: "prestige", amount: 10 }),
    district: "civic",
    fame: 8,
  }),
});

// Landmarks: royal-commission only. cost = coins from the real treasury.
const LANDMARKS = Object.freeze({
  grand_temple: Object.freeze({
    label: "grand temple",
    workTicks: 240, // ~10 days
    materials: Object.freeze({ [MATERIALS.oak_plank]: 100, [MATERIALS.soft_clay]: 100, [MATERIALS.iron_bar]: 30 }),
    cost: 50000,
    effect: Object.freeze({ kind: "devotion_gain", amount: 25 }),
    district: "faith",
    fame: 15,
  }),
  great_wall: Object.freeze({
    label: "great wall",
    workTicks: 300,
    materials: Object.freeze({ [MATERIALS.soft_clay]: 300, [MATERIALS.iron_bar]: 50, [MATERIALS.rope]: 50 }),
    cost: 75000,
    effect: Object.freeze({ kind: "siege_defense", amount: 25 }),
    district: "military",
    fame: 15,
  }),
  royal_palace: Object.freeze({
    label: "royal palace",
    workTicks: 360,
    materials: Object.freeze({ [MATERIALS.oak_plank]: 150, [MATERIALS.iron_bar]: 40, [MATERIALS.soft_clay]: 80 }),
    cost: 100000,
    effect: Object.freeze({ kind: "tax_revenue", amount: 10 }),
    district: "royal",
    fame: 20,
  }),
});

const DISTRICTS = Object.freeze(["market", "military", "faith", "civic", "harbor", "royal", "residential"]);

const SAVE_PATH = "data/saves/citizen-construction.json";

// --- state -----------------------------------------------------------------

let cache = null; // { blueprints, projects, built, districts, seq }
let dirty = false;

function blankState() {
  return { blueprints: {}, projects: {}, built: {}, districts: {}, seq: 1 };
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

// --- blueprints ------------------------------------------------------------

/** All building types (regular + landmarks). */
function catalog() {
  return Object.assign({}, BUILDINGS, LANDMARKS);
}

function isLandmark(type) {
  return Object.prototype.hasOwnProperty.call(LANDMARKS, type);
}

function specFor(type) {
  return catalog()[type] ?? null;
}

/**
 * Create a blueprint. designerUsername may be a citizen or a real player.
 * Requires the designer's real Construction level (defensive read) unless
 * isPlayer (players are trusted to have earned their levels — the engine
 * gates the action).
 */
function createBlueprint(designerUsername, type, size, style) {
  const spec = specFor(type);
  if (!spec) return { ok: false, reason: "unknown-type" };
  if (!designerUsername) return { ok: false, reason: "no-designer" };
  const st = load();
  const id = nextId("bp");
  st.blueprints[id] = {
    id,
    designer: designerUsername,
    type,
    size: size || "medium",
    style: style || "plain",
    createdAt: Date.now(),
  };
  markDirty();
  try {
    getJournal().log("construction", `${designerUsername} drafted a blueprint for ${spec.label}.`);
  } catch {}
  return { ok: true, id };
}

function blueprint(id) {
  return load().blueprints[id] ?? null;
}

function blueprintsFor(designerUsername) {
  const st = load();
  return Object.values(st.blueprints).filter((b) => b.designer === designerUsername);
}

// --- projects --------------------------------------------------------------

/**
 * Commission a project. options:
 *   - kingdomId (required)
 *   - blueprintId (required, must exist)
 *   - commissionedBy (username or "crown")
 *   - royal (bool): funded by the real kingdom treasury via KingdomStore.
 *     Returns { ok:false, reason:"insufficient-treasury" } when broke.
 *   - private: funded by real coin donations (funded starts at 0).
 */
function commissionProject(kingdomId, blueprintId, commissionedBy, options = {}) {
  const st = load();
  const bp = st.blueprints[blueprintId];
  if (!bp) return { ok: false, reason: "no-blueprint" };
  const spec = specFor(bp.type);
  if (!spec) return { ok: false, reason: "unknown-type" };
  if (!kingdomId) return { ok: false, reason: "no-kingdom" };

  const royal = !!options.royal;
  if (royal && isLandmark(bp.type)) {
    // Landmark: take real coins from the real treasury.
    try {
      const KingdomStore = require("../../kingdoms/KingdomStore");
      const cost = spec.cost ?? 0;
      const kingdom = KingdomStore.getKingdom?.(kingdomId);
      if (!kingdom || (kingdom.treasury ?? 0) < cost) {
        return { ok: false, reason: "insufficient-treasury" };
      }
      const spent = KingdomStore.spendFromTreasury?.(kingdomId, cost);
      if (spent === false) return { ok: false, reason: "insufficient-treasury" };
    } catch {
      return { ok: false, reason: "treasury-unavailable" };
    }
  } else if (royal) {
    // Regular royal building: modest fee from treasury.
    try {
      const KingdomStore = require("../../kingdoms/KingdomStore");
      const cost = 5000;
      const kingdom = KingdomStore.getKingdom?.(kingdomId);
      if (!kingdom || (kingdom.treasury ?? 0) < cost) {
        return { ok: false, reason: "insufficient-treasury" };
      }
      const spent = KingdomStore.spendFromTreasury?.(kingdomId, cost);
      if (spent === false) return { ok: false, reason: "insufficient-treasury" };
    } catch {
      return { ok: false, reason: "treasury-unavailable" };
    }
  }

  const id = nextId("proj");
  st.projects[id] = {
    id,
    kingdomId,
    blueprintId,
    type: bp.type,
    size: bp.size,
    style: bp.style,
    designer: bp.designer,
    commissionedBy: commissionedBy || "crown",
    royal,
    isLandmark: isLandmark(bp.type),
    materialsNeeded: Object.assign({}, spec.materials),
    materialsDonated: {},
    progress: 0,
    workTicks: spec.workTicks,
    status: "gathering", // gathering -> building -> complete
    createdAt: Date.now(),
    completedAt: null,
  };
  markDirty();
  try {
    getJournal().log("construction", `${commissionedBy || "the crown"} commissioned ${spec.label} in ${kingdomId}.`);
  } catch {}
  return { ok: true, id };
}

function project(id) {
  return load().projects[id] ?? null;
}

function projectsFor(kingdomId) {
  const st = load();
  return Object.values(st.projects).filter((p) => p.kingdomId === kingdomId && p.status !== "complete");
}

function activeProjectFor(kingdomId) {
  const list = projectsFor(kingdomId);
  return list.length ? list[0] : null;
}

/**
 * Donate real materials to a project stockpile. Returns { donated } with
 * the actual amounts accepted (capped at what's still needed).
 */
function donateMaterials(projectId, materials) {
  const st = load();
  const proj = st.projects[projectId];
  if (!proj || proj.status === "complete") return { ok: false, reason: "no-project" };
  const donated = {};
  for (const [itemId, amount] of Object.entries(materials ?? {})) {
    const need = (proj.materialsNeeded[itemId] ?? 0) - (proj.materialsDonated[itemId] ?? 0);
    if (need <= 0) continue;
    const take = Math.min(need, Math.max(0, Math.floor(amount)));
    if (take <= 0) continue;
    proj.materialsDonated[itemId] = (proj.materialsDonated[itemId] ?? 0) + take;
    donated[itemId] = take;
  }
  if (Object.keys(donated).length) {
    markDirty();
    // All materials stocked -> building phase.
    if (materialsComplete(proj)) proj.status = "building";
  }
  return { ok: true, donated };
}

function materialsComplete(proj) {
  for (const [itemId, need] of Object.entries(proj.materialsNeeded)) {
    if ((proj.materialsDonated[itemId] ?? 0) < need) return false;
  }
  return true;
}

/** Advance project progress by ticks (slow tick). Returns completed project or null. */
function progressProject(projectId, ticks = 1) {
  const st = load();
  const proj = st.projects[projectId];
  if (!proj || proj.status !== "building") return null;
  proj.progress += ticks;
  markDirty();
  if (proj.progress >= proj.workTicks) {
    return completeProject(projectId);
  }
  return null;
}

/** Hands-on work by a builder-citizen: extra progress. */
function workOnProject(projectId, ticks = 1) {
  return progressProject(projectId, ticks);
}

function completeProject(projectId) {
  const st = load();
  const proj = st.projects[projectId];
  if (!proj || proj.status === "complete") return null;
  proj.status = "complete";
  proj.completedAt = Date.now();
  const spec = specFor(proj.type);
  // Persistent built record with the real effect.
  const builtId = nextId("built");
  st.built[builtId] = {
    id: builtId,
    kingdomId: proj.kingdomId,
    type: proj.type,
    size: proj.size,
    style: proj.style,
    designer: proj.designer,
    district: spec.district,
    effect: Object.assign({}, spec.effect),
    completedAt: proj.completedAt,
    isLandmark: proj.isLandmark,
  };
  // Assign to district.
  const dKey = `${proj.kingdomId}:${spec.district}`;
  if (!st.districts[dKey]) {
    st.districts[dKey] = { kingdomId: proj.kingdomId, name: spec.district, buildings: [] };
  }
  st.districts[dKey].buildings.push(builtId);
  markDirty();
  try {
    getJournal().log("construction", `${spec.label} completed in ${proj.kingdomId}${proj.isLandmark ? " — a new landmark!" : ""}`);
  } catch {}
  return proj;
}

// --- built records & effects ------------------------------------------------

function builtFor(kingdomId) {
  const st = load();
  return Object.values(st.built).filter((b) => b.kingdomId === kingdomId);
}

function landmarksFor(kingdomId) {
  return builtFor(kingdomId).filter((b) => b.isLandmark);
}

/**
 * Live effect read: total bonus of an effect kind for a kingdom.
 * Defensive — returns 0 when nothing is built.
 */
function effectBonus(kingdomId, kind) {
  let total = 0;
  for (const b of builtFor(kingdomId)) {
    if (b.effect && b.effect.kind === kind) total += b.effect.amount ?? 0;
  }
  return total;
}

// --- districts --------------------------------------------------------------

function districtsFor(kingdomId) {
  const st = load();
  return Object.values(st.districts).filter((d) => d.kingdomId === kingdomId);
}

function ensureDistrict(kingdomId, name) {
  const st = load();
  const key = `${kingdomId}:${name}`;
  if (!st.districts[key]) {
    st.districts[key] = { kingdomId, name, buildings: [] };
    markDirty();
  }
  return st.districts[key];
}

// --- construction site tile --------------------------------------------------

const SITE_OFFSETS = [
  { dx: 6, dy: 4 },
  { dx: -5, dy: 6 },
  { dx: 8, dy: -3 },
];

/** Deterministic construction-site tile per kingdom (near the market). */
function siteTile(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const base = siteTileByKingdom(kingdomId, "market");
    if (base && typeof base.x === "number") {
      const o = SITE_OFFSETS[hashCode(kingdomId) % SITE_OFFSETS.length];
      return { x: base.x + o.dx, y: base.y + o.dy, z: base.z ?? 0 };
    }
  } catch {}
  return null;
}

function hashCode(str) {
  let h = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// --- test seams --------------------------------------------------------------

function resetForTests() {
  cache = blankState();
  dirty = false;
}

module.exports = {
  MATERIALS,
  BUILDINGS,
  LANDMARKS,
  DISTRICTS,
  catalog,
  isLandmark,
  specFor,
  createBlueprint,
  blueprint,
  blueprintsFor,
  commissionProject,
  project,
  projectsFor,
  activeProjectFor,
  donateMaterials,
  materialsComplete,
  progressProject,
  workOnProject,
  builtFor,
  landmarksFor,
  effectBonus,
  districtsFor,
  ensureDistrict,
  siteTile,
  load,
  save,
  resetForTests,
};
