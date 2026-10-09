"use strict";

/**
 * CitizenArchitects — citizens who design buildings, bridges, and city layouts
 * at the kingdom drafting studios.
 *
 * WHAT IT DOES (data tier, free):
 *   Every architect works a daily blueprint catalog (2-4 designs with quality
 *   tiers sketch/study/finished/masterwork) derived from date + hashes, zero
 *   storage. Master architects draft slow multi-day grand designs (bridges,
 *   great halls, aqueducts); when a grand design completes it is announced
 *   once and seeded into CitizenRumors. Surveyors mark out plots per day.
 *   Inspectors sign off the builders' real construction works by naming the
 *   actual project types the CitizenBuilders module builds (lazy require,
 *   best-effort, never throws). Commission ledgers live in small in-memory
 *   maps with TTL pruning.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   During studio hours (08:00-17:00) a materialized architect at a drafting
 *   studio holds scripted work — drafting emotes, blueprint hawking,
 *   grand-design unveiling fanfare, survey announcements, inspection
 *   sign-offs, commission offers for lingering players. Coin tips via
 *   tipArchitect (wired into Citizens.plugin.js onTipSeen).
 *
 * Zero LLM: all lines are scripted pools; the LLM dialogue tier reads the
 * journals and ledgers.
 *
 * No overlap: builders own construction projects and site supervision
 * (architects exclude actual builders via getBuilderInfo), sculptors own the
 * carving of monuments (architects only draw the plans), painters own the
 * studios, actors own the theaters, bards own music, street performers own
 * the squares, innkeepers own inn hospitality.
 *
 * Ties: inspectors read the real CitizenBuilders PROJECT_TYPES so "the new
 * granary" an inspector signs off is the same work the builders build.
 * blueprintsFor() is the producer hook for CitizenMarketStalls, same pattern
 * as the other producer modules. Grand-design completions seed rumors so the
 * sculptors' journal scans can pick up what the architects drew.
 *
 * Wired into the director tick right after the sculptors block (proximity
 * tick), guarded try/catch, per-citizen try/catch, cooldown maps pruned
 * hourly, gate order cheapest-first. House rule 12: matches the established
 * citizen-module pattern, wired through the existing director plugin,
 * no new core hooks, no guessed anim IDs (emotes and forceChat only).
 * Plain-node testable: CitizenArchitects.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { chance } = require("./humanizer");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const ARCHITECT_RADIUS = 14; // tiles — close enough to see the drafting table
const ARCHITECT_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const ARCHITECT_CHANCE = 0.35; // per eligible citizen per tick
const STUDIO_START_HOUR = 8; // architects work in daylight 08:00-17:00
const STUDIO_END_HOUR = 17;
const GRAND_DESIGN_MIN_DAYS = 6; // grand designs take 6-9 days to draw
const COINS_ID = 995;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip
const ARCHITECT_SHARE = 30; // ~30% of commoners are architects

const ARCHITECT_MASTER = "master-architect";
const ARCHITECT_DRAFTSMAN = "draftsman";
const ARCHITECT_SURVEYOR = "surveyor";
const ARCHITECT_INSPECTOR = "inspector";
const ARCHITECT_TYPES = Object.freeze([
  ARCHITECT_MASTER,
  ARCHITECT_DRAFTSMAN,
  ARCHITECT_SURVEYOR,
  ARCHITECT_INSPECTOR,
]);
const ARCHITECT_WEIGHTS = Object.freeze({
  [ARCHITECT_MASTER]: 30,
  [ARCHITECT_DRAFTSMAN]: 30,
  [ARCHITECT_SURVEYOR]: 20,
  [ARCHITECT_INSPECTOR]: 20,
});

// === Studios: drafting halls, ateliers, and survey offices, kingdom-preferred ===
const STUDIOS = Object.freeze([
  { name: "the Varrock Drafting Hall", kingdom: "varrock" },
  { name: "the Lumbridge Survey Office", kingdom: "varrock" },
  { name: "the Falador Atelier", kingdom: "asgarnia" },
  { name: "the Taverley Draughtsmen's Loft", kingdom: "asgarnia" },
  { name: "the Ardougne Plan House", kingdom: "kandarin" },
  { name: "the Kandarin Bridge Office", kingdom: "kandarin" },
  { name: "the Keldagrim Deep Plans Vault", kingdom: "keldagrim" },
  { name: "the Dorgesh Survey Burrow", kingdom: "keldagrim" },
  { name: "the Canifis Drafting Crypt", kingdom: "morytania" },
  { name: "the Darkmeyer Design Studio", kingdom: "morytania" },
]);

// === Blueprint subjects by type ===
const QUALITY_SKETCH = "sketch";
const QUALITY_STUDY = "study";
const QUALITY_FINISHED = "finished";
const QUALITY_MASTERWORK = "masterwork";
const QUALITIES = Object.freeze([
  QUALITY_SKETCH,
  QUALITY_STUDY,
  QUALITY_FINISHED,
  QUALITY_MASTERWORK,
]);

const SUBJECTS = Object.freeze({
  [ARCHITECT_MASTER]: Object.freeze([
    "a grand stone bridge",
    "a great feast hall",
    "a domed temple",
    "a city aqueduct",
    "a harbor lighthouse",
    "a royal palace wing",
  ]),
  [ARCHITECT_DRAFTSMAN]: Object.freeze([
    "a merchant's house",
    "a two-story shopfront",
    "a riverside warehouse",
    "a stable block",
    "a bakehouse",
    "a traveler inn",
  ]),
  [ARCHITECT_SURVEYOR]: Object.freeze([
    "the north field",
    "the river bend",
    "the old quarry",
    "the market green",
    "the harbor point",
    "the chapel hill",
  ]),
  [ARCHITECT_INSPECTOR]: Object.freeze([]), // inspectors sign off builders' real works
});

// Fallback works for inspectors when CitizenBuilders is absent.
const FALLBACK_WORKS = Object.freeze([
  "the rising wall",
  "the new granary",
  "the old bridge",
  "the gatehouse",
  "the watchtower",
  "the market hall",
]);

// === Scripted lines (data tier; the LLM riffs via the journal) ===
const WORK_EMOTES = Object.freeze([
]);

const SURVEY_EMOTES = Object.freeze([
]);

const HAWK_LINES = Object.freeze([
  "Blueprints! Today's designs: {design}, drawn to scale!",
  "Fresh off the drafting table: {design}, a {quality} plan!",
  "For sale: the plans for {design}. Build it true, build it once!",
  "A {quality} {design} — yours for a fair price!",
]);

const UNVEIL_LINES = Object.freeze([
  "BEHOLD! The plans are finished — {name}!",
  "It is drawn! {name} — come, all of you, and see the future!",
  "Years of dreaming, inked at last: {name}!",
]);

const DESIGN_WORK_LINES = Object.freeze([
  "The plans for {name} grow, line by line.",
  "When {name} rises, the whole city will marvel.",
]);

const SURVEY_LINES = Object.freeze([
  "Marked! {design} will hold a fine building.",
  "Surveyed and staked: {design}. True as a plumb line.",
  "*chalks the boundary of {design}* — measured thrice!",
]);

const INSPECT_LINES = Object.freeze([
  "The {work} rises true — I sign off on this course of stone.",
  "*raps the new-laid wall of {work}* Solid. The builders may continue.",
  "Plumb and level. The {work} passes inspection.",
  "That arch wants another day to settle — then we build on {work}.",
]);

const COMMISSION_LINES = Object.freeze([
  "Ever dreamed of raising a tower? I draw commissions, friend!",
  "I design commissions — halls, bridges, whole streets!",
  "Commissions open! Your vision, drawn to the inch.",
]);

const TIP_THANKS = Object.freeze([
  "A patron of fine lines! The studio thanks you!",
  "Your generosity keeps the ink flowing — thank you!",
  "For straight walls and true arches — thank you!",
  "The drafting table thanks you! Come see the next plan!",
]);

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastUnveilAnnounce = new Map(); // studio name -> day number

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** Weighted pick of an architect type from a 0..99 roll. */
function architectTypeFromRoll(roll) {
  let acc = 0;
  for (const t of ARCHITECT_TYPES) {
    acc += ARCHITECT_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return ARCHITECT_MASTER;
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** True when the player object is a citizen bot. */
function isCitizenBot(player) {
  try {
    return player?.isPlayerBot?.() === true || player?.getHostAddress?.() === "bot";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/** True during studio hours (08:00-17:00 server time). */
function isStudioHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= STUDIO_START_HOUR && h < STUDIO_END_HOUR;
}

function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/**
 * The architect type for a roster record, or null when this citizen is not
 * an architect. Hash-derived from the normalized username (~30% nominal,
 * ~8% effective after mutual exclusions), stable across restarts, zero
 * storage. Excludes actual builders (the builders module owns site
 * supervision and its own architect trade), street performers, bards,
 * actors, inn bards, painters, and sculptors so no citizen belongs to two
 * systems.
 */
function architectTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No double-casting: builders build, performers perform, artists carve.
    try {
      const builders = require("./CitizenBuilders");
      if (typeof builders.getBuilderInfo === "function" && builders.getBuilderInfo(name)) return null;
    } catch { /* module absent */ }
    try {
      const sp = require("./CitizenStreetPerformers");
      if (typeof sp.performerTypeOf === "function" && sp.performerTypeOf(record)) return null;
    } catch { /* module absent */ }
    try {
      const bards = require("./CitizenBards");
      if (typeof bards.bardTypeOf === "function" && bards.bardTypeOf(record)) return null;
    } catch { /* module absent */ }
    try {
      const actors = require("./CitizenActors");
      if (typeof actors.actorTypeOf === "function" && actors.actorTypeOf(record)) return null;
    } catch { /* module absent */ }
    try {
      const inn = require("./CitizenInnkeepers");
      if (typeof inn.innTypeFor === "function" && inn.innTypeFor(name) === "bard") return null;
    } catch { /* module absent */ }
    try {
      const painters = require("./CitizenPainters");
      if (typeof painters.painterTypeOf === "function" && painters.painterTypeOf(record)) return null;
    } catch { /* module absent */ }
    try {
      const sculptors = require("./CitizenSculptors");
      if (typeof sculptors.sculptorTypeOf === "function" && sculptors.sculptorTypeOf(record)) return null;
    } catch { /* module absent */ }
    const roll = hashStr("architect:" + name) % 100;
    if (roll >= ARCHITECT_SHARE) return null;
    return architectTypeFromRoll(hashStr("architecttype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred studio assignment, stable across restarts. */
function studioFor(record) {
  const kid = record?.kingdomId;
  const local = STUDIOS.filter((s) => s.kingdom === kid);
  const pool = local.length ? local : STUDIOS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("studio:" + name) % pool.length];
}

/**
 * The day's blueprint catalog for an architect — 2-4 designs with subjects
 * and quality tiers. Deterministic per day, zero storage.
 */
function blueprintsFor(record, nowMs = Date.now()) {
  try {
    const type = architectTypeOf(record);
    if (!type) return { works: [], type: null };
    const name = normalizeName(record?.username) || "anon";
    const day = dayNumber(nowMs);
    const h = hashStr("blueprints:" + name + ":" + day);
    const count = 2 + (h % 3); // 2-4 designs
    const works = [];
    if (type === ARCHITECT_INSPECTOR) {
      const targets = inspectionTargets();
      for (let i = 0; i < count; i++) {
        const sh = hashStr("inspect:" + name + ":" + day + ":" + i);
        works.push({
          subject: targets[sh % targets.length],
          quality: QUALITIES[sh % QUALITIES.length],
        });
      }
      return { works, type };
    }
    const subjects = SUBJECTS[type];
    for (let i = 0; i < count; i++) {
      const sh = hashStr("plan:" + name + ":" + day + ":" + i);
      works.push({
        subject: subjects[sh % subjects.length],
        quality: QUALITIES[sh % QUALITIES.length],
      });
    }
    return { works, type };
  } catch {
    return { works: [], type: null };
  }
}

/**
 * The real works an inspector can sign off: the project names the
 * CitizenBuilders module actually builds (lazy require, best-effort).
 * Falls back to a static list when builders are absent. Never throws.
 */
function inspectionTargets() {
  try {
    const builders = require("./CitizenBuilders");
    const types = builders.PROJECT_TYPES;
    if (types && typeof types === "object") {
      const names = [];
      for (const t of Object.values(types)) {
        for (const n of t?.names ?? []) names.push(n);
      }
      if (names.length) return names;
    }
  } catch { /* builders absent */ }
  return FALLBACK_WORKS.slice();
}

/**
 * The grand design a master architect is drafting — a slow multi-day
 * project derived from hashes, stable across restarts, zero storage.
 * Returns { name, dayInCycle, cycleDays, complete }.
 */
function grandDesignFor(record, nowMs = Date.now()) {
  try {
    if (architectTypeOf(record) !== ARCHITECT_MASTER) return null;
    const studio = studioFor(record);
    const h = hashStr("granddesign:" + studio.name);
    const cycleDays = GRAND_DESIGN_MIN_DAYS + (h % 4); // 6-9 days
    const startDay = h % 1000;
    const day = dayNumber(nowMs);
    const elapsed = day - startDay;
    const dayInCycle = ((elapsed % cycleDays) + cycleDays) % cycleDays;
    const subjects = SUBJECTS[ARCHITECT_MASTER];
    const name = subjects[(h >>> 7) % subjects.length];
    return {
      name,
      dayInCycle,
      cycleDays,
      complete: dayInCycle === cycleDays - 1,
      studio: studio.name,
    };
  } catch {
    return null;
  }
}

// --- Journal access (lazy require — CitizenJournal may not load in tests) ---
let _journalEvent = null;
function journalEvent() {
  if (_journalEvent !== null) return _journalEvent;
  try {
    _journalEvent = require("./CitizenJournal").getJournal() || false;
  } catch {
    _journalEvent = false;
  }
  return _journalEvent;
}

let _seedRumor = null;
function seedRumorFn() {
  if (_seedRumor !== null) return _seedRumor;
  try {
    _seedRumor = require("./CitizenRumors").seedRumor || false;
  } catch {
    _seedRumor = false;
  }
  return _seedRumor;
}

/** Best-effort journal write; never throws. */
function journalize(citizen, text) {
  try {
    const j = journalEvent();
    const name = citizen?.getUsername?.() ?? citizen?.username;
    if (j && name) j.addEntry?.(name, text);
  } catch { /* cosmetic */ }
}

/** Best-effort rumor seed; never throws. */
function seedRumor(text) {
  try {
    const fn = seedRumorFn();
    if (fn) fn(text);
  } catch { /* cosmetic */ }
}

// ============================================================================
// Commission ledger (data tier, zero LLM) — 7-day TTL.
// ============================================================================
const COMMISSION_TTL_MS = 7 * 24 * 3600 * 1000;
const commissions = new Map(); // normName -> { architect, subject, kind, commissionedAt }

function commissionDesign(playerName, architectUsername, subject, kind = "building", nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  commissions.set(name, {
    architect: normalizeName(architectUsername),
    subject: String(subject || "a building"),
    kind: String(kind || "building"),
    commissionedAt: nowMs,
  });
  return commissions.get(name);
}

function commissionFor(playerName, nowMs = Date.now()) {
  const rec = commissions.get(normalizeName(playerName));
  if (!rec) return null;
  if (nowMs - rec.commissionedAt > COMMISSION_TTL_MS) {
    commissions.delete(normalizeName(playerName));
    return null;
  }
  return rec;
}

function pruneCommissions(nowMs = Date.now()) {
  const cutoff = nowMs - COMMISSION_TTL_MS;
  for (const [k, v] of commissions) {
    if (v.commissionedAt < cutoff) commissions.delete(k);
  }
}

// ============================================================================
// Coin tips: "use coins on architect" (registered in Citizens.plugin.js
// onTipSeen alongside tipPerformer, tipBard, tipActor, tipPainter,
// tipSculptor). Each handler ignores non-own targets.
// ============================================================================
function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

function tipArchitect(event, deps = {}, nowMs = Date.now()) {
  const { player, target, item } = event ?? {};
  if (event?.handled) return;
  if (!isRealPlayer(player)) return;
  if (!isCitizenBot(target)) return;
  if (!item || item.getId?.() !== COINS_ID) return;

  const director = deps.director ?? getDirectorSafe();
  if (!director?.roster) return;
  const name = normalizeName(target.getUsername?.());
  if (!name) return;
  const record = director.roster.get(name);
  const type = architectTypeOf(record);
  if (!type) return; // not an architect — let the next handler have it

  const offered = Math.max(0, Math.floor(item.getAmount?.() ?? 0));
  if (offered <= 0) return;
  const amount = Math.min(offered, TIP_MAX_COINS);

  let moved = false;
  try {
    const playerInv = player.getInventory?.();
    const targetInv = target.getInventory?.();
    if (!playerInv || !targetInv) return;
    const held = playerInv.getAmount?.(COINS_ID) ?? 0;
    if (held < amount) {
      try {
        player.sendMessage?.("You don't have that many coins.");
      } catch { /* cosmetic */ }
      return;
    }
    playerInv.deleteNumber(COINS_ID, amount);
    try { playerInv.refreshItems?.(); } catch { /* cosmetic */ }
    targetInv.add?.(COINS_ID, amount);
    try { targetInv.refreshItems?.(); } catch { /* cosmetic */ }
    moved = true;
  } catch { /* bail silently */ }
  if (!moved) return;

  event.handled = true;
  try {
    { const _cvp = target.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(target, voiceLine(voiceFor(_cvp), { plain: TIP_THANKS })); }
  } catch { /* cosmetic */ }
  journalize(target, `received a ${amount}-coin tip from ${player.getUsername?.() ?? "a patron"}`);
  return amount;
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → architect? → materialized → studio
// hours → real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickArchitects(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < ARCHITECT_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be an architect (hash-derived, cheap)
        const type = architectTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Studio hours only (architects need daylight)
        if (!isStudioHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, ARCHITECT_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, ARCHITECT_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        architectScene(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-architects] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-architects] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** A full scripted architect scene. */
function architectScene(director, record, citizen, type, nowMs) {
  const studio = studioFor(record);
  const catalog = blueprintsFor(record, nowMs);
  const day = dayNumber(nowMs);

  // Grand-design unveilings: once per studio per day, the crowd moment.
  if (type === ARCHITECT_MASTER) {
    const design = grandDesignFor(record, nowMs);
    if (design) {
      if (design.complete && (lastUnveilAnnounce.get(studio.name) ?? -1) < day) {
        lastUnveilAnnounce.set(studio.name, day);
        const line = fill(pickOne(Math.random, UNVEIL_LINES), { name: design.name });
        { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
        journalize(citizen, `unveiled the plans for ${design.name} at ${studio.name}`);
        seedRumor(`Plans unveiled at ${studio.name}: ${design.name}!`);
        return;
      }
      const line = fill(pickOne(Math.random, DESIGN_WORK_LINES), { name: design.name });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(citizen, `drafted ${design.name} at ${studio.name}`);
      return;
    }
  }

  // Surveyors: stake out plots.
  if (type === ARCHITECT_SURVEYOR) {
    const work = catalog.works[0];
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: SURVEY_EMOTES })); }
    if (work) {
      const announce = fill(pickOne(Math.random, SURVEY_LINES), { design: work.subject });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [announce] })); }
    }
    journalize(citizen, `surveyed plots at ${studio.name}`);
    return;
  }

  // Inspectors: sign off the builders' works.
  if (type === ARCHITECT_INSPECTOR) {
    const work = catalog.works[0];
    const line = fill(pickOne(Math.random, INSPECT_LINES), {
      work: work ? work.subject : "the new works",
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `inspected construction for ${studio.name}`);
    return;
  }

  // Hawking: sell today's blueprints.
  if (catalog.works.length) {
    const work = pickOne(Math.random, catalog.works);
    const line = fill(pickOne(Math.random, HAWK_LINES), {
      design: work.subject,
      quality: work.quality,
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `hawked plans for "${work.subject}" (${work.quality}) at ${studio.name}`);
    return;
  }

  // Fallback: work emotes.
  { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: WORK_EMOTES })); }
}

/**
 * Offer a commission to a lingering real player.
 * Called from the tick path; the LLM dialogue tier handles the reply.
 */
function maybeOfferCommission(record, citizen, type) {
  const line = pickOne(Math.random, COMMISSION_LINES);
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch { /* cosmetic */ }
  return line;
}

module.exports = {
  tickArchitects,
  tipArchitect,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  architectTypeOf,
  studioFor,
  blueprintsFor,
  grandDesignFor,
  inspectionTargets,
  commissionDesign,
  commissionFor,
  maybeOfferCommission,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  architectTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isStudioHour,
  dayNumber,
  ARCHITECT_TYPES,
  ARCHITECT_MASTER,
  ARCHITECT_DRAFTSMAN,
  ARCHITECT_SURVEYOR,
  ARCHITECT_INSPECTOR,
  STUDIOS,
  SUBJECTS,
  QUALITIES,
  QUALITY_SKETCH,
  QUALITY_STUDY,
  QUALITY_FINISHED,
  QUALITY_MASTERWORK,
};
