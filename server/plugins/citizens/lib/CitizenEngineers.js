"use strict";

/**
 * CitizenEngineers — millwrights, siege engineers, aqueduct engineers and
 * inventors who build the kingdoms' machines.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived engineer types, per-day device catalogs, 6-9-day great works
 *   (mills, aqueducts, war engines), inventor breakthroughs, and a 7-day TTL
 *   commission ledger. Reads the real CitizenArchitects blueprints and the
 *   real CitizenBlacksmiths metal tables so the fiction is consistent.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players, 08:00-17:00):
 *   scripted machine-shop work emotes, device hawking, great-work unveiling
 *   fanfare, breakthrough announcements, commission offers, coin tips
 *   ("use coins on engineer").
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director proximity tick right after the architects block.
 * Plain-node testable: CitizenEngineers.test.js.
 */

const { normalizeName } = require("./CitizenBonds");

// === Tuning ===
const ENGINEER_RADIUS = 14; // tiles — close enough to see/hear
const ENGINEER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const ENGINEER_CHANCE = 0.35; // per eligible citizen per proximity tick
const ENGINEER_SHARE = 30; // nominal % of commoners
const WORKSHOP_START_HOUR = 8; // 08:00 server time
const WORKSHOP_END_HOUR = 17; // 17:00 server time
const GREAT_WORK_MIN_DAYS = 6;
const GREAT_WORK_MAX_DAYS = 9;
const COMMISSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COINS_ID = 995;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip

// === Engineer types ===
const ENGINEER_MILLWRIGHT = "millwright";
const ENGINEER_SIEGE = "siege-engineer";
const ENGINEER_AQUEDUCT = "aqueduct-engineer";
const ENGINEER_INVENTOR = "inventor";
const ENGINEER_TYPES = [
  ENGINEER_MILLWRIGHT,
  ENGINEER_SIEGE,
  ENGINEER_AQUEDUCT,
  ENGINEER_INVENTOR,
];
const ENGINEER_WEIGHTS = {
  [ENGINEER_MILLWRIGHT]: 35,
  [ENGINEER_SIEGE]: 25,
  [ENGINEER_AQUEDUCT]: 20,
  [ENGINEER_INVENTOR]: 20,
};

// === Workshops (kingdom-preferred) ===
const WORKSHOPS = [
  { name: "the Varrock Millworks", kingdom: "misthalin" },
  { name: "the Lumbridge Waterwheel Yard", kingdom: "misthalin" },
  { name: "the Falador Machine Hall", kingdom: "asgarnia" },
  { name: "the White Knights' Siege Yard", kingdom: "asgarnia" },
  { name: "the Ardougne Engine Works", kingdom: "kandarin" },
  { name: "the Hemenster Mill Race", kingdom: "kandarin" },
  { name: "the Keldagrim Deep Engine Hall", kingdom: "keldagrim" },
  { name: "the Dorgesh Machine Caves", kingdom: "keldagrim" },
  { name: "the Darkmeyer Bloodworks", kingdom: "morytania" },
  { name: "the Al Kharid Windmill Row", kingdom: "kharidian" },
];

// === Devices ===
const DEVICES = [
  { name: "a watermill gearbox", kinds: [ENGINEER_MILLWRIGHT] },
  { name: "a windmill sail-frame", kinds: [ENGINEER_MILLWRIGHT] },
  { name: "a grain-grinding millstone set", kinds: [ENGINEER_MILLWRIGHT] },
  { name: "a treadle lathe", kinds: [ENGINEER_MILLWRIGHT] },
  { name: "a catapult throwing arm", kinds: [ENGINEER_SIEGE] },
  { name: "a ballista torsion frame", kinds: [ENGINEER_SIEGE] },
  { name: "a battering ram head", kinds: [ENGINEER_SIEGE] },
  { name: "a siege tower winch", kinds: [ENGINEER_SIEGE] },
  { name: "an aqueduct arch section", kinds: [ENGINEER_AQUEDUCT] },
  { name: "a lead water pipe run", kinds: [ENGINEER_AQUEDUCT] },
  { name: "a cistern sluice gate", kinds: [ENGINEER_AQUEDUCT] },
  { name: "a wellhead pump", kinds: [ENGINEER_AQUEDUCT] },
  { name: "a clockwork orrery", kinds: [ENGINEER_INVENTOR] },
  { name: "a spring-driven clock", kinds: [ENGINEER_INVENTOR] },
  { name: "a signal-semaphore rig", kinds: [ENGINEER_INVENTOR] },
  { name: "a pressure bellows", kinds: [ENGINEER_INVENTOR] },
];

const GREAT_WORKS = [
  "the Great Watermill of {kingdom}",
  "the Skywind Mill of {kingdom}",
  "the Grand Aqueduct of {kingdom}",
  "the Stoneheart Catapult of {kingdom}",
  "the Clocktower of {kingdom}",
  "the Great Cistern of {kingdom}",
];

const BREAKTHROUGHS = [
  "By the gears — I've done it! {device} that runs twice as true!",
  "It works! It actually works! {device} — come and see!",
  "The guild will want to hear of this: {device}, perfected!",
];

// === Scripted lines ===
const WORK_LINES = {
  [ENGINEER_MILLWRIGHT]: [
    "*trues the millstone edge*",
    "*fits the gearbox teeth*",
    "Mind the wheel — she turns whether you're ready or not.",
    "*oils the axle bearings*",
  ],
  [ENGINEER_SIEGE]: [
    "*winds the torsion skein*",
    "*sights down the throwing arm*",
    "She'll throw a stone clean over the wall, mark me.",
    "*checks the frame joints*",
  ],
  [ENGINEER_AQUEDUCT]: [
    "*levels the arch course*",
    "*seals the pipe joints with lead*",
    "Water always wins. We just give it somewhere to go.",
    "*tests the sluice gate*",
  ],
  [ENGINEER_INVENTOR]: [
    "*tweaks the escapement*",
    "*sketches a new gear train*",
    "If the spring holds, this changes everything.",
    "*polishes the brass fittings*",
  ],
};

const HAWK_LINES = [
  "Fine machines today! {device} — built to last a lifetime!",
  "Fresh from the works: {device}. Get them while the iron's hot!",
  "{device}, {device} — every workshop needs one!",
];

const UNVEIL_LINES = [
  "Behold! {work} stands complete! Three cheers for the works!",
  "She's done! {work} — come and marvel!",
  "After {days} days of labor — {work} is finished!",
];

const COMMISSION_LINES = [
  "Need a machine built? I take commissions — mills, engines, waterworks.",
  "I build to order, friend. Tell me what you need turning, lifting, or throwing.",
];

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Commission ledger (7-day TTL) ===
const commissions = new Map(); // normName -> { device, at }
let lastCommissionPrune = 0;
function pruneCommissions(nowMs) {
  if (nowMs - lastCommissionPrune < 3600 * 1000) return;
  lastCommissionPrune = nowMs;
  for (const [k, v] of commissions) {
    if (nowMs - v.at > COMMISSION_TTL_MS) commissions.delete(k);
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

/** Weighted pick of an engineer type from a 0..99 roll. */
function engineerTypeFromRoll(roll) {
  let acc = 0;
  for (const t of ENGINEER_TYPES) {
    acc += ENGINEER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return ENGINEER_MILLWRIGHT;
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

/** True during workshop hours (08:00-17:00 server time). */
function isWorkshopHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORKSHOP_START_HOUR && h < WORKSHOP_END_HOUR;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** Cheap rng from a seed (mulberry-ish LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

// ============================================================================
// Engineer identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The engineer type for a roster record, or null.
 * Excludes builders, smiths, architects, performers and other artist systems
 * so no citizen belongs to two professional systems.
 */
function engineerTypeOf(record) {
  try {
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: builders own construction, smiths own metalwork.
    try {
      const builders = require("./CitizenBuilders");
      if (typeof builders.getBuilderInfo === "function" && builders.getBuilderInfo(name)) return null;
    } catch { /* module absent */ }
    try {
      const smiths = require("./CitizenBlacksmiths");
      if (typeof smiths.smithTypeFor === "function" && smiths.smithTypeFor({ username: name })) return null;
    } catch { /* module absent */ }
    try {
      const arch = require("./CitizenArchitects");
      if (typeof arch.architectTypeOf === "function" && arch.architectTypeOf(record)) return null;
    } catch { /* module absent */ }
    try {
      const perf = require("./CitizenStreetPerformers");
      if (typeof perf.performerTypeOf === "function" && perf.performerTypeOf(record)) return null;
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
    const roll = hashStr("engineer:" + name) % 100;
    if (roll >= ENGINEER_SHARE) return null;
    return engineerTypeFromRoll(hashStr("engineertype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred workshop assignment, stable across restarts. */
function workshopFor(record) {
  const kid = record?.kingdomId;
  const local = WORKSHOPS.filter((w) => w.kingdom === kid);
  const pool = local.length ? local : WORKSHOPS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("workshop:" + name) % pool.length];
}

/**
 * The day's device catalog for an engineer (2-3 devices of their type).
 * Derived from date + hash; zero storage.
 */
function devicesFor(username, kingdomId, dateMs) {
  const name = normalizeName(username) || "anon";
  const type = engineerTypeOf({ username: name, kingdomId });
  const kinds = type ? [type] : ENGINEER_TYPES;
  const pool = DEVICES.filter((d) => d.kinds.some((k) => kinds.includes(k)));
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("devices:" + name + ":" + day));
  const count = 2 + Math.floor(rng() * 2); // 2-3
  const out = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < pool.length; i++) {
    const d = pool[Math.floor(rng() * pool.length)];
    if (used.has(d.name)) continue;
    used.add(d.name);
    out.push(d.name);
  }
  return out;
}

/**
 * The great work under construction at a workshop: { work, startedDay,
 * lengthDays, doneDay }. Slow multi-day cycle, derived — zero storage.
 */
function greatWorkFor(workshop, dateMs) {
  const day = dayNumber(dateMs);
  const cycle = GREAT_WORK_MIN_DAYS + (hashStr("greatwork:" + workshop.name) % (GREAT_WORK_MAX_DAYS - GREAT_WORK_MIN_DAYS + 1));
  const epoch = hashStr("greatworkepoch:" + workshop.name) % cycle;
  const startedDay = day - ((day - epoch) % cycle);
  const work = fill(pickOne(seededRng(hashStr("greatworkname:" + workshop.name + ":" + startedDay)), GREAT_WORKS), {
    kingdom: kingdomName(workshop.kingdom),
  });
  return { work, startedDay, lengthDays: cycle, doneDay: startedDay + cycle };
}

/** Human-readable kingdom name for the great-work templates. */
function kingdomName(kid) {
  const names = {
    misthalin: "Misthalin",
    asgarnia: "Asgarnia",
    kandarin: "Kandarin",
    keldagrim: "Keldagrim",
    morytania: "Morytania",
    kharidian: "the Kharidian",
  };
  return names[kid] ?? "the kingdom";
}

/** Today's metal from the real blacksmith supply chain (lazy, with fallback). */
function metalForToday(dateMs) {
  try {
    const smiths = require("./CitizenBlacksmiths");
    if (typeof smiths.waresFor === "function") {
      const wares = smiths.waresFor("engineer-shop", null, dateMs);
      if (Array.isArray(wares) && wares.length) return wares[0];
    }
  } catch { /* module absent */ }
  return "iron";
}

/** Today's blueprint the engineers are building from (lazy, with fallback). */
function blueprintForToday(dateMs) {
  try {
    const arch = require("./CitizenArchitects");
    if (typeof arch.blueprintsFor === "function") {
      const plans = arch.blueprintsFor("engineer-shop", null, dateMs);
      if (Array.isArray(plans) && plans.length) return plans[0];
    }
  } catch { /* module absent */ }
  return "a drafted plan";
}

// ============================================================================
// Player commissions (data tier, zero LLM).
// ============================================================================

/** Commission a machine: recorded, journaled; the LLM tier handles dialogue. */
function commissionMachine(playerName, device, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !device) return null;
  pruneCommissions(nowMs);
  commissions.set(name, { device: String(device), at: nowMs });
  return device;
}

/** The active commission for a player, or null. */
function commissionFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneCommissions(nowMs);
  const rec = commissions.get(name);
  return rec ? rec.device : null;
}

/** Inventor breakthrough for today at a workshop (~1 in 8 days). */
function breakthroughFor(workshop, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("breakthrough:" + workshop.name + ":" + day));
  if (rng() >= 1 / 8) return null;
  const device = pickOne(rng, DEVICES).name;
  return fill(pickOne(rng, BREAKTHROUGHS), { device });
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

function journalize(citizen, text) {
  try {
    const journal = require("./CitizenJournal");
    if (typeof journal.appendEntry === "function") {
      journal.appendEntry(citizen, text);
    } else if (typeof journal.addEntry === "function") {
      journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(text) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(text);
  } catch { /* rumors absent */ }
}

// ============================================================================
// Coin tips: "use coins on engineer" (registered in Citizens.plugin.js
// onTipSeen after tipArchitect). Each handler ignores non-own targets.
// ============================================================================

function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

function tipEngineer(event, deps = {}, nowMs = Date.now()) {
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
  const type = engineerTypeOf(record);
  if (!type) return; // not an engineer — let the next handler have it

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
    target.forceChat?.("Much obliged! The gears turn smoother with coin in the till.");
  } catch { /* cosmetic */ }
  journalize(target, `received a ${amount}-coin tip from ${player.getUsername?.() ?? "a patron"}`);
  return amount;
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → engineer? → materialized → workshop
// hours → real player near → chance → work.
// ============================================================================

function tickEngineers(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < ENGINEER_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be an engineer (hash-derived, cheap)
        const type = engineerTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. Workshop hours only
        if (!isWorkshopHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, ENGINEER_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, ENGINEER_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doEngineerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-engineers] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-engineers] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doEngineerWork(director, record, citizen, type, nowMs) {
  const workshop = workshopFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Great-work unveiling: once per workshop per completion day, the crowd moment.
  const gw = greatWorkFor(workshop, nowMs);
  if (day === gw.doneDay) {
    const key = "unveil:" + workshop.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, UNVEIL_LINES), {
        work: gw.work,
        days: gw.lengthDays,
      });
      citizen.forceChat?.(line);
      journalize(citizen, `unveiled ${gw.work} at ${workshop.name}`);
      seedRumor(`${gw.work} stands complete at ${workshop.name}!`);
      return;
    }
  }

  // Inventor breakthrough: rare, the other crowd moment.
  if (type === ENGINEER_INVENTOR) {
    const bt = breakthroughFor(workshop, nowMs);
    if (bt) {
      const key = "breakthrough:" + workshop.name + ":" + day;
      if (!lastFiredByCitizen.has(key)) {
        lastFiredByCitizen.set(key, nowMs);
        citizen.forceChat?.(bt);
        journalize(citizen, `announced a breakthrough at ${workshop.name}: "${bt}"`);
        seedRumor(`An inventor at ${workshop.name} claims a breakthrough!`);
        return;
      }
    }
  }

  // Routine: work emote, hawking, or commission offer.
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `worked at ${workshop.name}`);
  } else if (roll < 0.8) {
    const devices = devicesFor(name, record.kingdomId, nowMs);
    const device = devices.length ? devices[0] : "a fine machine";
    citizen.forceChat?.(fill(pickOne(Math.random, HAWK_LINES), { device }));
    journalize(citizen, `hawked ${device} at ${workshop.name}`);
  } else {
    citizen.forceChat?.(pickOne(Math.random, COMMISSION_LINES));
    journalize(citizen, `offered commissions at ${workshop.name}`);
  }
}

module.exports = {
  tickEngineers,
  tipEngineer,
  commissionMachine,
  commissionFor,
  breakthroughFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  engineerTypeOf,
  workshopFor,
  devicesFor,
  greatWorkFor,
  metalForToday,
  blueprintForToday,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  engineerTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isWorkshopHour,
  dayNumber,
  chance,
  seededRng,
  kingdomName,
  ENGINEER_TYPES,
  ENGINEER_MILLWRIGHT,
  ENGINEER_SIEGE,
  ENGINEER_AQUEDUCT,
  ENGINEER_INVENTOR,
  WORKSHOPS,
  DEVICES,
  GREAT_WORKS,
};
