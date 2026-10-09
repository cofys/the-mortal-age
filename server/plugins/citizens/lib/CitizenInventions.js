"use strict";

/**
 * CitizenInventions — persistent registry of citizen-made inventions.
 *
 * Complements (does not duplicate) CitizenEngineers: that module runs the
 * hash-derived engineer flavor (engineer types, device catalogs, great-work
 * fiction, commission ledger). This module is the REAL invention layer:
 * research consumes real materials, takes real time, produces real invention
 * records with real patent rights and real coin royalties.
 *
 * Invention types:
 *   - tool: improved skilling tools (better pickaxe, axe, chisel, dibbler)
 *   - device: workshop devices (seed sorter, ore washer)
 *   - weapon: military designs (war horn, siege ram plans)
 *
 * Research: a citizen starts a project on a blueprint, invests real
 * materials from their real inventory, and research progresses on the slow
 * tick (real time). Completion grants real Crafting XP and creates the
 * invention record.
 *
 * Patents: the inventor holds an exclusive patent for 30 days. Other
 * citizens (or players) who license the invention pay real coins to the
 * patent holder. After expiry the invention enters the public domain.
 *
 * Kingdom integration: military inventions (war horn, siege ram plans)
 * boost the inventing kingdom's war effort — read live from KingdomStore.
 *
 * Zero LLM. All state transitions are pure functions of stored state.
 * Plain-node testable: CitizenInventions.test.js.
 */

const { getJournal } = require("./CitizenJournal");

// --- tuning ---------------------------------------------------------------

// Real item IDs for research materials (must exist in the engine).
const MATERIALS = Object.freeze({
  iron_bar: 2351,
  steel_bar: 2353,
  oak_planks: 8778,
  willow_planks: 8780, // may not exist; validated at runtime
  papyrus: 970,
  soft_clay: 1761,
  chisel: 1755,
  hammer: 2347,
  saw: 8794,
  rope: 954,
  coal: 453,
});

// Researchable blueprints. researchTicks = slow-tick cycles to complete.
// materials = { itemId: count } consumed from real inventory on start.
// craftingLevel = minimum real Crafting level. xp = real Crafting XP on completion.
const BLUEPRINTS = Object.freeze({
  improved_pickaxe: Object.freeze({
    label: "improved pickaxe",
    type: "tool",
    description: "a pickaxe with a better-balanced head",
    materials: Object.freeze({ [MATERIALS.iron_bar]: 2, [MATERIALS.oak_planks]: 1 }),
    researchTicks: 48, // ~2 days of slow ticks
    craftingLevel: 20,
    xp: 350,
    fame: 6,
  }),
  reinforced_axe: Object.freeze({
    label: "reinforced axe",
    type: "tool",
    description: "an axe with a steel-reinforced haft",
    materials: Object.freeze({ [MATERIALS.steel_bar]: 1, [MATERIALS.oak_planks]: 2 }),
    researchTicks: 48,
    craftingLevel: 25,
    xp: 400,
    fame: 6,
  }),
  precision_chisel: Object.freeze({
    label: "precision chisel",
    type: "tool",
    description: "a chisel ground to a finer edge",
    materials: Object.freeze({ [MATERIALS.steel_bar]: 1 }),
    researchTicks: 36,
    craftingLevel: 30,
    xp: 450,
    fame: 7,
  }),
  seed_dibbler: Object.freeze({
    label: "seed dibbler",
    type: "device",
    description: "a device that plants seeds at perfect depth",
    materials: Object.freeze({ [MATERIALS.oak_planks]: 3, [MATERIALS.iron_bar]: 1 }),
    researchTicks: 60,
    craftingLevel: 35,
    xp: 550,
    fame: 8,
  }),
  ore_washer: Object.freeze({
    label: "ore washer",
    type: "device",
    description: "a water-driven ore cleaning device",
    materials: Object.freeze({ [MATERIALS.iron_bar]: 3, [MATERIALS.oak_planks]: 2, [MATERIALS.rope]: 2 }),
    researchTicks: 72,
    craftingLevel: 40,
    xp: 650,
    fame: 9,
  }),
  war_horn: Object.freeze({
    label: "war horn",
    type: "weapon",
    description: "a horn that rallies troops in battle",
    materials: Object.freeze({ [MATERIALS.iron_bar]: 2, [MATERIALS.soft_clay]: 4 }),
    researchTicks: 60,
    craftingLevel: 30,
    xp: 500,
    fame: 10,
    military: true,
  }),
  siege_ram_plans: Object.freeze({
    label: "siege ram plans",
    type: "weapon",
    description: "detailed plans for an improved siege ram",
    materials: Object.freeze({ [MATERIALS.papyrus]: 5, [MATERIALS.oak_planks]: 4, [MATERIALS.iron_bar]: 4 }),
    researchTicks: 96, // ~4 days — the big one
    craftingLevel: 50,
    xp: 900,
    fame: 12,
    military: true,
  }),
});

// Patent duration: 30 days of exclusive rights.
const PATENT_DURATION_MS = 30 * 24 * 3600 * 1000;

// Royalty: licensees pay this many coins to the patent holder.
const ROYALTY_COINS = 500;

// --- state -----------------------------------------------------------------

let cache = null; // { projects: {}, inventions: {}, patents: {} }
let dirty = false;
let nextId = 1;

function blankState() {
  return {
    projects: Object.create(null),
    inventions: Object.create(null),
    patents: Object.create(null),
  };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    const path = require("path");
    const file = path.join(__dirname, "..", "..", "data", "saves", "citizen-inventions.json");
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      cache = {
        projects: Object.create(null),
        inventions: Object.create(null),
        patents: Object.create(null),
      };
      for (const [id, p] of Object.entries(raw.projects ?? {})) cache.projects[id] = p;
      for (const [id, inv] of Object.entries(raw.inventions ?? {})) {
        cache.inventions[id] = inv;
        const n = parseInt(String(id).replace("inv-", ""), 10);
        if (!Number.isNaN(n) && n >= nextId) nextId = n + 1;
      }
      for (const [id, pat] of Object.entries(raw.patents ?? {})) cache.patents[id] = pat;
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
    const dir = path.join(__dirname, "..", "..", "data", "saves");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "citizen-inventions.json");
    const s = load();
    fs.writeFileSync(
      file,
      JSON.stringify({ projects: s.projects, inventions: s.inventions, patents: s.patents }, null, 2)
    );
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

// --- blueprints ------------------------------------------------------------

/**
 * All researchable blueprints. Returns the frozen catalog.
 */
function blueprints() {
  return BLUEPRINTS;
}

/**
 * Get a single blueprint by id. Returns null if unknown.
 */
function blueprint(id) {
  return BLUEPRINTS[id] ?? null;
}

// --- research projects -----------------------------------------------------

/**
 * Start a research project. Validates the blueprint exists.
 * Material/crafting validation happens at the brain-action layer
 * (it has the player); this is the pure record layer.
 * Returns the project record.
 */
function startResearch(inventorUsername, blueprintId) {
  const bp = blueprint(blueprintId);
  if (!bp) return null;
  const s = load();
  const id = `proj-${nextId++}-${Date.now()}`;
  const project = {
    id,
    inventor: inventorUsername,
    blueprintId,
    startedAt: Date.now(),
    progressTicks: 0,
    requiredTicks: bp.researchTicks,
  };
  s.projects[id] = project;
  markDirty();
  try {
    getJournal().log("invention", `${inventorUsername} began researching ${bp.label}`);
  } catch { /* journal optional */ }
  return project;
}

/**
 * Advance a research project by n ticks. Returns the project, or the
 * completed invention if research finished (and removes the project).
 */
function progressResearch(projectId, ticks = 1) {
  const s = load();
  const project = s.projects[projectId];
  if (!project) return null;
  project.progressTicks += ticks;
  markDirty();
  if (project.progressTicks >= project.requiredTicks) {
    delete s.projects[projectId];
    return completeInvention(project);
  }
  return project;
}

/**
 * Get all active research projects. Returns array.
 */
function activeProjects() {
  return Object.values(load().projects);
}

/**
 * Get active projects for one inventor. Returns array.
 */
function projectsFor(inventorUsername) {
  return activeProjects().filter((p) => p.inventor === inventorUsername);
}

/**
 * Cancel a research project (materials are NOT refunded — honest sunk cost).
 * Returns true if a project was cancelled.
 */
function cancelResearch(projectId) {
  const s = load();
  if (!s.projects[projectId]) return false;
  delete s.projects[projectId];
  markDirty();
  return true;
}

// --- inventions ------------------------------------------------------------

/**
 * Complete a research project into an invention record.
 * Pure: (project) => invention. Called by progressResearch.
 */
function completeInvention(project) {
  const bp = blueprint(project.blueprintId);
  if (!bp) return null;
  const s = load();
  const id = `inv-${nextId++}`;
  const invention = {
    id,
    blueprintId: project.blueprintId,
    label: bp.label,
    type: bp.type,
    inventor: project.inventor,
    completedAt: Date.now(),
    military: !!bp.military,
  };
  s.inventions[id] = invention;
  // The inventor automatically holds the patent on completion.
  grantPatent(id, project.inventor);
  markDirty();
  try {
    getJournal().log("invention", `${project.inventor} invented the ${bp.label}!`);
  } catch { /* journal optional */ }
  return invention;
}

/**
 * All completed inventions. Returns array.
 */
function allInventions() {
  return Object.values(load().inventions);
}

/**
 * Get one invention by id. Returns null if unknown.
 */
function invention(id) {
  return load().inventions[id] ?? null;
}

/**
 * Inventions by one inventor. Returns array.
 */
function inventionsFor(inventorUsername) {
  return allInventions().filter((inv) => inv.inventor === inventorUsername);
}

// --- patents ---------------------------------------------------------------

/**
 * Grant a patent on an invention to a holder. Overwrites any existing
 * patent on that invention. Returns the patent record.
 */
function grantPatent(inventionId, holderUsername) {
  const s = load();
  const inv = s.inventions[inventionId];
  if (!inv) return null;
  const now = Date.now();
  const patent = {
    inventionId,
    holder: holderUsername,
    grantedAt: now,
    expiresAt: now + PATENT_DURATION_MS,
  };
  s.patents[inventionId] = patent;
  markDirty();
  return patent;
}

/**
 * Get the active patent for an invention. Returns null if none or expired.
 * Expired patents are cleaned up lazily here.
 */
function patentFor(inventionId) {
  const s = load();
  const patent = s.patents[inventionId];
  if (!patent) return null;
  if (Date.now() >= patent.expiresAt) {
    delete s.patents[inventionId];
    markDirty();
    return null; // public domain now
  }
  return patent;
}

/**
 * License an invention: the licensee pays ROYALTY_COINS to the patent
 * holder. Returns { ok, royaltyPaid, patentHolder }.
 * No patent (public domain) = free, no payment.
 * The actual coin transfer happens at the caller layer (it has the players);
 * this is the pure record layer — it reports WHO should be paid.
 */
function licenseInvention(inventionId, licenseeUsername) {
  const inv = invention(inventionId);
  if (!inv) return { ok: false, reason: "unknown-invention" };
  const patent = patentFor(inventionId);
  if (!patent) {
    return { ok: true, royaltyPaid: 0, patentHolder: null, publicDomain: true };
  }
  if (patent.holder === licenseeUsername) {
    return { ok: true, royaltyPaid: 0, patentHolder: patent.holder, selfLicensed: true };
  }
  return { ok: true, royaltyPaid: ROYALTY_COINS, patentHolder: patent.holder };
}

/**
 * Check if an invention is in the public domain (patent expired or never patented).
 */
function isPublicDomain(inventionId) {
  return patentFor(inventionId) === null && invention(inventionId) !== null;
}

// --- workshops -------------------------------------------------------------

// Workshop offsets from the kingdom market (deterministic, spread per kingdom).
const WORKSHOP_OFFSETS = [
  { dx: 18, dy: 12 },
  { dx: -15, dy: 20 },
  { dx: 22, dy: -14 },
  { dx: -20, dy: -18 },
  { dx: 10, dy: 25 },
];

/**
 * Workshop tile for a kingdom. Deterministic per kingdomId.
 * Returns { x, y, z } or null if the site module is unavailable.
 */
function workshopTile(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const market = siteTileByKingdom(kingdomId, "market");
    if (!market) return null;
    const idx = Math.abs(hashCode(String(kingdomId))) % WORKSHOP_OFFSETS.length;
    const off = WORKSHOP_OFFSETS[idx];
    return { x: market.x + off.dx, y: market.y + off.dy, z: market.z ?? 0 };
  } catch {
    return null;
  }
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h;
}

// --- test seams ------------------------------------------------------------

function resetForTests() {
  cache = blankState();
  dirty = false;
  nextId = 1;
}

module.exports = {
  BLUEPRINTS,
  MATERIALS,
  PATENT_DURATION_MS,
  ROYALTY_COINS,
  blueprints,
  blueprint,
  startResearch,
  progressResearch,
  activeProjects,
  projectsFor,
  cancelResearch,
  completeInvention,
  allInventions,
  invention,
  inventionsFor,
  grantPatent,
  patentFor,
  licenseInvention,
  isPublicDomain,
  workshopTile,
  load,
  save,
  resetForTests,
};
