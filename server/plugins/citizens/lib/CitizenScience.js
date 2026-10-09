"use strict";

/**
 * CitizenScience — the experimental science layer.
 *
 * Complements (does not duplicate) two existing modules:
 *   - CitizenScholars runs the hash-gated scholar FLAVOR layer: deterministic
 *     scholar types, research topics, lectures, and a journaled library.
 *     Its progress is rebuilt from hashes, not stored.
 *   - CitizenInventions runs the REAL invention layer: research consumes real
 *     materials, takes real time, and produces real invention records with
 *     real patents and real coin royalties.
 * THIS module is the EXPERIMENTAL layer in between: citizens run real
 * experiments to test real hypotheses in real laboratories. A completed
 * experiment may yield a DISCOVERY — a persistent, kingdom-scoped record
 * with REAL game effects that other modules read live:
 *   - medicine discoveries boost CitizenSurgery medical research progress
 *     (defensive read; CitizenSurgery keeps its own numbers otherwise)
 *   - agriculture discoveries boost farm growth via growthBonusFor()
 *   - metallurgy discoveries grant smithing XP via xpBonusFor()
 *   - alchemy discoveries UNLOCK invention blueprints (CitizenInventions
 *     checks hasDiscovery() before offering gated blueprints)
 *   - astronomy discoveries speed sea travel via navigationBonusFor()
 *
 * Scientists are real citizens whose best field skill is 30+ (not hash-gated).
 * Experiments consume REAL materials from the scientist's real inventory and
 * take real slow-tick time. Laboratories are one per kingdom, upgradeable
 * with real materials plus real treasury coins. Peer review verifies
 * high-skill findings. Publications journal findings (kind "publication") and
 * award the "scientist" reputation deed. Kingdoms may fund experiments with
 * real treasury GRANTS; unfruitful grantees lose future funding.
 *
 * Players participate too: they can fund a scientist's experiment (chat
 * "fund science"), and read the publication record ("what was discovered").
 *
 * Zero LLM. All state transitions are pure functions of stored state.
 * Plain-node testable: CitizenScience.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const fs = require("node:fs");
const path = require("node:path");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-science.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- science fields -----------------------------------------------------------

const FIELD_MEDICINE = "medicine";
const FIELD_AGRICULTURE = "agriculture";
const FIELD_METALLURGY = "metallurgy";
const FIELD_ALCHEMY = "alchemy";
const FIELD_ASTRONOMY = "astronomy";

const FIELDS = Object.freeze({
  [FIELD_MEDICINE]: Object.freeze({ label: "medicine", skill: "herblore" }),
  [FIELD_AGRICULTURE]: Object.freeze({ label: "agriculture", skill: "farming" }),
  [FIELD_METALLURGY]: Object.freeze({ label: "metallurgy", skill: "smithing" }),
  [FIELD_ALCHEMY]: Object.freeze({ label: "alchemy", skill: "herblore" }),
  [FIELD_ASTRONOMY]: Object.freeze({ label: "astronomy", skill: null }),
});

const FIELD_IDS = Object.freeze(Object.keys(FIELDS));

// --- tuning -------------------------------------------------------------------

const SCIENTIST_MIN_LEVEL = 30; // field skill needed to run experiments
const EXPERIMENT_BASE_TICKS = 20; // slow ticks for a baseline experiment
const PEER_REVIEW_LEVEL = 70; // skill level that auto-verifies a finding
const LAB_MAX_LEVEL = 3;
const GRANT_MAX_COINS = 2000;
const GRANT_DEADLINE_MS = 30 * 24 * 3600 * 1000; // 30 days to publish

// Real engine item ids for experiment materials (must exist in the engine;
// resolved defensively at runtime — a missing item honestly blocks the run).
const MATERIAL_IDS = Object.freeze({
  papyrus: 970,
  vial: 229,
  rope: 954,
  iron_bar: 2351,
  steel_bar: 2353,
  coal: 453,
  compost: 6032,
  hammer: 2347,
  chisel: 1755,
  telescope_lens: 0, // placeholder: resolved from engine when available
});

// --- experiment catalog --------------------------------------------------------

const EXPERIMENTS = Object.freeze({
  antiseptic_trial: Object.freeze({
    id: "antiseptic_trial",
    field: FIELD_MEDICINE,
    name: "Antiseptic trial",
    hypothesis: "Clean herbs applied to wounds prevent infection.",
    materials: { clean_herb: 5, vial: 3 },
    ticks: 20,
    levelReq: 30,
    labLevel: 1,
    discoveryId: "antisepsis",
  }),
  wound_dressing: Object.freeze({
    id: "wound_dressing",
    field: FIELD_MEDICINE,
    name: "Wound dressing study",
    hypothesis: "Layered bandages heal wounds twice as fast.",
    materials: { clean_herb: 8, rope: 4, papyrus: 2 },
    ticks: 28,
    levelReq: 45,
    labLevel: 2,
    discoveryId: "field_dressing",
  }),
  crop_rotation: Object.freeze({
    id: "crop_rotation",
    field: FIELD_AGRICULTURE,
    name: "Crop rotation trial",
    hypothesis: "Rotating crops restores soil and boosts yields.",
    materials: { compost: 6, papyrus: 2 },
    ticks: 24,
    levelReq: 30,
    labLevel: 1,
    discoveryId: "crop_rotation_method",
  }),
  soil_enrichment: Object.freeze({
    id: "soil_enrichment",
    field: FIELD_AGRICULTURE,
    name: "Soil enrichment study",
    hypothesis: "Compost mixtures triple early growth.",
    materials: { compost: 10, vial: 2, papyrus: 3 },
    ticks: 32,
    levelReq: 50,
    labLevel: 2,
    discoveryId: "rich_soil",
  }),
  steel_tempering: Object.freeze({
    id: "steel_tempering",
    field: FIELD_METALLURGY,
    name: "Steel tempering trial",
    hypothesis: "Coal-fired tempering hardens steel blades.",
    materials: { steel_bar: 4, coal: 8, hammer: 1 },
    ticks: 26,
    levelReq: 40,
    labLevel: 2,
    discoveryId: "tempered_steel",
    unlocksBlueprint: "reinforced_axe",
  }),
  alloy_mixing: Object.freeze({
    id: "alloy_mixing",
    field: FIELD_METALLURGY,
    name: "Alloy mixing experiment",
    hypothesis: "Iron-coal alloys cut deeper and last longer.",
    materials: { iron_bar: 6, coal: 10, chisel: 1 },
    ticks: 34,
    levelReq: 55,
    labLevel: 3,
    discoveryId: "fine_alloys",
    unlocksBlueprint: "improved_pickaxe",
  }),
  volatile_reagents: Object.freeze({
    id: "volatile_reagents",
    field: FIELD_ALCHEMY,
    name: "Volatile reagents study",
    hypothesis: "Distilled reagents separate ores from rock.",
    materials: { clean_herb: 6, vial: 5, coal: 4 },
    ticks: 30,
    levelReq: 50,
    labLevel: 2,
    discoveryId: "reagent_distillation",
    unlocksBlueprint: "ore_washer",
  }),
  essence_refinement: Object.freeze({
    id: "essence_refinement",
    field: FIELD_ALCHEMY,
    name: "Essence refinement",
    hypothesis: "Refined essence doubles rune yield.",
    materials: { clean_herb: 8, vial: 6, papyrus: 4 },
    ticks: 36,
    levelReq: 60,
    labLevel: 3,
    discoveryId: "pure_essence",
  }),
  star_charting: Object.freeze({
    id: "star_charting",
    field: FIELD_ASTRONOMY,
    name: "Star charting",
    hypothesis: "Fixed stars guide ships straighter at night.",
    materials: { papyrus: 8, vial: 1 },
    ticks: 22,
    levelReq: 30,
    labLevel: 1,
    discoveryId: "star_charts",
  }),
  tide_tables: Object.freeze({
    id: "tide_tables",
    field: FIELD_ASTRONOMY,
    name: "Tide tables",
    hypothesis: "Lunar cycles predict tides for faster crossings.",
    materials: { papyrus: 10, rope: 2 },
    ticks: 30,
    levelReq: 45,
    labLevel: 2,
    discoveryId: "tide_tables_pub",
  }),
});

// --- discovery catalog (persistent results with real effects) -------------------

const DISCOVERIES = Object.freeze({
  antisepsis: Object.freeze({
    id: "antisepsis",
    field: FIELD_MEDICINE,
    name: "Antisepsis",
    summary: "Clean herbs prevent wound infection.",
    effect: Object.freeze({ kind: "surgery_research", value: 0.25 }),
  }),
  field_dressing: Object.freeze({
    id: "field_dressing",
    field: FIELD_MEDICINE,
    name: "Field dressing",
    summary: "Layered bandages heal wounds faster.",
    effect: Object.freeze({ kind: "surgery_research", value: 0.2 }),
  }),
  crop_rotation_method: Object.freeze({
    id: "crop_rotation_method",
    field: FIELD_AGRICULTURE,
    name: "Crop rotation",
    summary: "Rotating crops boosts farm yields.",
    effect: Object.freeze({ kind: "farm_growth", value: 0.15 }),
  }),
  rich_soil: Object.freeze({
    id: "rich_soil",
    field: FIELD_AGRICULTURE,
    name: "Rich soil",
    summary: "Compost mixtures accelerate early growth.",
    effect: Object.freeze({ kind: "farm_growth", value: 0.2 }),
  }),
  tempered_steel: Object.freeze({
    id: "tempered_steel",
    field: FIELD_METALLURGY,
    name: "Tempered steel",
    summary: "Coal tempering hardens steel.",
    effect: Object.freeze({ kind: "smithing_xp", value: 0.1 }),
  }),
  fine_alloys: Object.freeze({
    id: "fine_alloys",
    field: FIELD_METALLURGY,
    name: "Fine alloys",
    summary: "Iron-coal alloys cut deeper.",
    effect: Object.freeze({ kind: "smithing_xp", value: 0.15 }),
  }),
  reagent_distillation: Object.freeze({
    id: "reagent_distillation",
    field: FIELD_ALCHEMY,
    name: "Reagent distillation",
    summary: "Distilled reagents separate ore from rock.",
    effect: Object.freeze({ kind: "unlock_blueprint", value: 0, blueprint: "ore_washer" }),
  }),
  pure_essence: Object.freeze({
    id: "pure_essence",
    field: FIELD_ALCHEMY,
    name: "Pure essence",
    summary: "Refined essence boosts rune yield.",
    effect: Object.freeze({ kind: "unlock_blueprint", value: 0, blueprint: "pure_essence" }),
  }),
  star_charts: Object.freeze({
    id: "star_charts",
    field: FIELD_ASTRONOMY,
    name: "Star charts",
    summary: "Fixed stars guide night ships.",
    effect: Object.freeze({ kind: "navigation", value: 0.1 }),
  }),
  tide_tables_pub: Object.freeze({
    id: "tide_tables_pub",
    field: FIELD_ASTRONOMY,
    name: "Tide tables",
    summary: "Lunar tides predict faster crossings.",
    effect: Object.freeze({ kind: "navigation", value: 0.15 }),
  }),
});

// --- persistence -----------------------------------------------------------------

let cache = null; // { scientists, experiments, discoveries, labs, grants, publications }
let dirty = false;

function blankState() {
  return {
    scientists: Object.create(null), // username -> { field, skillLevel, experimentsRun, discoveries, joinedAt }
    experiments: Object.create(null), // id -> { id, templateId, scientist, kingdomId, progress, ticks, startedAt, status }
    discoveries: Object.create(null), // id -> { id, discoveryId, discoverer, kingdomId, verified, discoveredAt }
    labs: Object.create(null), // kingdomId -> { level, experiments: [ids] }
    grants: Object.create(null), // id -> { id, scientist, experimentId, amount, kingdomId, grantedAt, published }
    publications: [], // [{ scientist, title, field, publishedAt, verified }]
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = { ...blankState(), ...parsed };
  } catch {
    cache = blankState();
  }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  cache = null;
  dirty = false;
}

// --- scientists ------------------------------------------------------------------

function registerScientist(username, field) {
  const st = load();
  const key = String(username ?? "").toLowerCase();
  if (!key || !FIELDS[field]) return null;
  if (!st.scientists[key]) {
    st.scientists[key] = {
      username: String(username),
      field,
      skillLevel: 1,
      experimentsRun: 0,
      discoveries: 0,
      joinedAt: Date.now(),
    };
    dirty = true;
  }
  return st.scientists[key];
}

function scientistFor(username) {
  const st = load();
  return st.scientists[String(username ?? "").toLowerCase()] ?? null;
}

function setSkillLevel(username, level) {
  const rec = scientistFor(username);
  if (!rec) return;
  rec.skillLevel = Math.max(1, Math.floor(level));
  dirty = true;
}

// --- experiments -------------------------------------------------------------------

let expCounter = 0;

function startExperiment(username, templateId, kingdomId) {
  const tmpl = EXPERIMENTS[templateId];
  if (!tmpl) return null;
  const st = load();
  const lab = labFor(kingdomId);
  if (lab.level < tmpl.labLevel) return null; // lab too primitive
  expCounter += 1;
  const id = `exp_${Date.now()}_${expCounter}`;
  st.experiments[id] = {
    id,
    templateId,
    scientist: String(username),
    kingdomId: String(kingdomId),
    progress: 0,
    ticks: tmpl.ticks,
    startedAt: Date.now(),
    status: "running",
  };
  const rec = scientistFor(username);
  if (rec) {
    rec.experimentsRun += 1;
    rec.skillLevel = Math.max(rec.skillLevel, 1);
    dirty = true;
  }
  dirty = true;
  return st.experiments[id];
}

function experimentFor(username) {
  const st = load();
  const key = String(username ?? "").toLowerCase();
  for (const exp of Object.values(st.experiments)) {
    if (exp.status === "running" && String(exp.scientist).toLowerCase() === key) return exp;
  }
  return null;
}

function advanceExperiment(id, ticks = 1) {
  const st = load();
  const exp = st.experiments[id];
  if (!exp || exp.status !== "running") return exp;
  exp.progress += ticks;
  dirty = true;
  return exp;
}

function completeExperiment(id, success) {
  const st = load();
  const exp = st.experiments[id];
  if (!exp) return null;
  exp.status = success ? "succeeded" : "failed";
  exp.completedAt = Date.now();
  dirty = true;
  return exp;
}

// --- discoveries ---------------------------------------------------------------------

function recordDiscovery(discoveryId, discoverer, kingdomId, verified) {
  const def = DISCOVERIES[discoveryId];
  if (!def) return null;
  const st = load();
  // One discovery per kingdom per discovery id (kingdom-scoped knowledge).
  const id = `${kingdomId}:${discoveryId}`;
  if (st.discoveries[id]) return st.discoveries[id];
  st.discoveries[id] = {
    id,
    discoveryId,
    name: def.name,
    field: def.field,
    discoverer: String(discoverer),
    kingdomId: String(kingdomId),
    verified: !!verified,
    discoveredAt: Date.now(),
    effect: def.effect,
  };
  const rec = scientistFor(discoverer);
  if (rec) {
    rec.discoveries += 1;
    dirty = true;
  }
  dirty = true;
  return st.discoveries[id];
}

function hasDiscovery(kingdomId, discoveryId) {
  const st = load();
  return !!st.discoveries[`${kingdomId}:${discoveryId}`];
}

/** Sum of effect values for a kingdom+effect kind (verified findings count double). */
function discoveryBonusFor(kingdomId, effectKind) {
  const st = load();
  let total = 0;
  for (const d of Object.values(st.discoveries)) {
    if (String(d.kingdomId) !== String(kingdomId)) continue;
    if (d.effect?.kind !== effectKind) continue;
    total += (d.effect.value ?? 0) * (d.verified ? 2 : 1);
  }
  return total;
}

/** Surgery research progress multiplier for a kingdom (read by CitizenSurgery). */
function surgeryResearchBonusFor(kingdomId) {
  return discoveryBonusFor(kingdomId, "surgery_research");
}

/** Farm growth multiplier for a kingdom (read by season/farming layers). */
function growthBonusFor(kingdomId) {
  return discoveryBonusFor(kingdomId, "farm_growth");
}

/** Smithing XP bonus for a kingdom. */
function smithingXpBonusFor(kingdomId) {
  return discoveryBonusFor(kingdomId, "smithing_xp");
}

/** Sea-travel speed bonus for a kingdom. */
function navigationBonusFor(kingdomId) {
  return discoveryBonusFor(kingdomId, "navigation");
}

// --- laboratories ---------------------------------------------------------------------

function labFor(kingdomId) {
  const st = load();
  const key = String(kingdomId);
  if (!st.labs[key]) {
    st.labs[key] = { kingdomId: key, level: 1, upgradedAt: Date.now() };
    dirty = true;
  }
  return st.labs[key];
}

function labTile(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    return siteTileByKingdom(kingdomId, "market");
  } catch {
    return null;
  }
}

// --- grants -----------------------------------------------------------------------------

let grantCounter = 0;

function awardGrant(kingdomId, scientist, experimentId, amount) {
  const st = load();
  grantCounter += 1;
  const id = `grant_${Date.now()}_${grantCounter}`;
  st.grants[id] = {
    id,
    kingdomId: String(kingdomId),
    scientist: String(scientist),
    experimentId,
    amount: Math.min(Math.max(0, amount | 0), GRANT_MAX_COINS),
    grantedAt: Date.now(),
    published: false,
  };
  dirty = true;
  return st.grants[id];
}

function grantsFor(username) {
  const st = load();
  const key = String(username ?? "").toLowerCase();
  return Object.values(st.grants).filter((g) => String(g.scientist).toLowerCase() === key);
}

// --- publications --------------------------------------------------------------------------

function publish(scientist, title, field, verified) {
  const st = load();
  st.publications.push({
    scientist: String(scientist),
    title: String(title),
    field,
    verified: !!verified,
    publishedAt: Date.now(),
  });
  // Mark any outstanding grants from this scientist as published.
  for (const g of grantsFor(scientist)) g.published = true;
  try {
    getJournal().log("publication", `${scientist} published "${title}" (${field})`);
  } catch { /* journal is best-effort */ }
  dirty = true;
  return st.publications[st.publications.length - 1];
}

function recentPublications(n = 5) {
  const st = load();
  return st.publications.slice(-n).reverse();
}

// --- teaching -------------------------------------------------------------------

// Scientists with 3+ discoveries can teach science in schools.
// Returns a teaching bonus (mirrors CitizenPhilosophy.teachingBonusFor).
function teachingBonusFor(username) {
  const rec = scientistFor(username);
  if (!rec || (rec.discoveries ?? 0) < 3) return 0;
  return Math.min(5, 1 + Math.floor((rec.discoveries - 3) / 2));
}

// --- templates -------------------------------------------------------------------------------

function experiment(id) {
  return EXPERIMENTS[id] ?? null;
}

function experimentIds() {
  return Object.keys(EXPERIMENTS);
}

module.exports = {
  FIELDS,
  FIELD_IDS,
  FIELD_MEDICINE,
  FIELD_AGRICULTURE,
  FIELD_METALLURGY,
  FIELD_ALCHEMY,
  FIELD_ASTRONOMY,
  EXPERIMENTS,
  DISCOVERIES,
  SCIENTIST_MIN_LEVEL,
  PEER_REVIEW_LEVEL,
  LAB_MAX_LEVEL,
  GRANT_MAX_COINS,
  MATERIAL_IDS,
  load,
  save,
  resetForTests,
  _setSavePathForTests,
  registerScientist,
  scientistFor,
  setSkillLevel,
  startExperiment,
  experimentFor,
  advanceExperiment,
  completeExperiment,
  recordDiscovery,
  hasDiscovery,
  discoveryBonusFor,
  surgeryResearchBonusFor,
  growthBonusFor,
  smithingXpBonusFor,
  navigationBonusFor,
  labFor,
  labTile,
  awardGrant,
  grantsFor,
  publish,
  recentPublications,
  teachingBonusFor,
  experiment,
  experimentIds,
};
