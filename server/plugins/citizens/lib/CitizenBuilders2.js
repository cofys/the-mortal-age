"use strict";

/**
 * CitizenBuilders2 — the hoddies: hod carriers ferrying bricks up the
 * ladders, mortar mixers working lime and sand, scaffolders' mates lashing
 * poles and fetching boards, day laborers hiring out a pair of hands, and
 * rubble clearers hauling away the broken bits. Commoners who live off the
 * unglamorous side of the building trade — the muscle and mortar under the
 * master builders' scaffold, never the trade itself.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived laborfolk types, per-day work sites, the day's master-
 *   builder project (cross-read from the real CitizenBuilders name pools so
 *   laborer small talk stays consistent with what the crews are building),
 *   a day-labor hire ledger, and scaffold-slip + supply-delay + topping-out
 *   set-pieces (~6-8%/day, journaled + rumor-seeded).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted hauling/mixing/lashing/clearing emotes,
 * day-labor hire offers, boss-callouts that name the nearby player who
 * hired them (interaction priority), topping-out celebrations as the crowd
 * moment, and master-builder small talk. Hire dialogue itself is LLM tier —
 * this module only tracks state, timers and the visible street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the woodfolk block.
 * Plain-node testable: CitizenBuilders2.test.js.
 *
 * No overlap (by design):
 *   - CitizenBuilders owns the PROFESSIONAL building trade (master masons,
 *     carpenters and architects with named projects, phases, celebrations)
 *     — the claimed pro builders are excluded via the real module's null
 *     path (getBuilderInfo returns null for unclaimed names, so it is a
 *     valid eligibility gate).
 *   - CitizenArchitects own design and plans — laborers never draw plans;
 *     they lash poles and carry hods, full stop.
 *   - CitizenEngineers own engines and machinery — hoddies move stone by
 *     muscle, never by crane.
 *   - CitizenMenders own household repair — laborers haul and mix for new
 *     construction, never fix a villager's roof latch.
 */

// === Tuning: all magic numbers here ===
const LABORFOLK_RADIUS = 14; // tiles — close enough to see/hear
const LABORFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const LABORFOLK_CHANCE = 0.15; // per eligible citizen per tick
const LABORFOLK_SHARE = 40; // ~40% nominal share of commoners (post-exclusion)
const TOPPING_OUT_CHANCE = 0.08; // topping-out celebration, per site per day
const SCAFFOLD_SLIP_CHANCE = 0.06; // ~6% per kingdom per day: a plank slips
const SUPPLY_DELAY_CHANCE = 0.08; // ~8% per kingdom per day: stone wagons late
const WORK_START_HOUR = 6; // 06:00 server local time
const WORK_END_HOUR = 20; // 20:00 server local time
const HIRE_TTL_MS = 24 * 3600 * 1000; // day-labor hires linger a day

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProBuilders = safeRequire("./CitizenBuilders");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Laborfolk types ===
const HOD_CARRIER = "hod-carrier";
const MORTAR_MIXER = "mortar-mixer";
const SCAFFOLD_MATE = "scaffold-mate";
const DAY_LABORER = "day-laborer";
const RUBBLE_CLEARER = "rubble-clearer";
const LABORFOLK_TYPES = [
  HOD_CARRIER,
  MORTAR_MIXER,
  SCAFFOLD_MATE,
  DAY_LABORER,
  RUBBLE_CLEARER,
];
const LABORFOLK_WEIGHTS = {
  [HOD_CARRIER]: 25,
  [MORTAR_MIXER]: 25,
  [SCAFFOLD_MATE]: 20,
  [DAY_LABORER]: 15,
  [RUBBLE_CLEARER]: 15,
};

// === Work sites — building works and scaffold yards, not the masters'
// named workshops. ===
const SITES = [
  { name: "the Varrock market-hall scaffold", kingdom: "misthalin" },
  { name: "the Lumbridge bridge repairs", kingdom: "misthalin" },
  { name: "the Falador east-wall works", kingdom: "asgarnia" },
  { name: "the Port Sarim dock repairs", kingdom: "asgarnia" },
  { name: "the Seers' hall scaffold", kingdom: "kandarin" },
  { name: "the Catherby harbor works", kingdom: "kandarin" },
  { name: "the lower-city tenement works", kingdom: "keldagrim" },
  { name: "the Keldagrim shaft-head works", kingdom: "keldagrim" },
  { name: "the Canifis palisade works", kingdom: "morytania" },
  { name: "the Mort Myre causeway repairs", kingdom: "morytania" },
  { name: "the Al Kharid wall repairs", kingdom: "kharidian" },
  { name: "the Shantay gatehouse scaffold", kingdom: "kharidian" },
];

// === Materials the hoddies handle — the bulk stuff, never the masters'
// seasoned timber or dressed stone stock. ===
const MATERIALS = [
  "common brick",
  "rubble stone",
  "lime mortar",
  "sand",
  "scaffold poles",
  "roofing thatch",
  "clay daub",
  "gravel",
];

// === Scripted lines ===
const HOD_LINES = [
  "*hefts a loaded hod, brick dust in the air*",
  "Up the ladder with {material} — mind your head below!",
  "*balances the hod, step by steady step* Another load for the course!",
  "{material} for the bricklayers! Coming up!",
];

const MORTAR_LINES = [
  "*works the hoe through lime and sand* Mortar's ready — thick as porridge!",
  "Three of sand, one of lime — that's the mix that holds.",
  "*slakes lime, steam rising* Mind the lime, it bites!",
  "Mortar's up! Bricklayers, fetch it while it's fresh!",
];

const SCAFFOLD_LINES = [
  "*lashes a scaffold pole, testing the knot* That'll hold.",
  "Boards up, poles tied — mind the gap, lads!",
  "*hauls a board up the frame* The scaffold grows faster than the wall!",
  "Lashings checked! Nobody falls on my watch.",
];

const ODDJOB_LINES = [
  "Need a pair of hands? Hauling, digging, carrying — that's me!",
  "*leans on a shovel* Hire a laborer for the day — honest work, honest wage!",
  "Odd jobs done! Digging, carrying, clearing — ask about!",
  "I've a strong back and an empty purse. Put me to work!",
];

const RUBBLE_LINES = [
  "*heaves a barrow of broken brick* Rubble out — out of the way!",
  "Clearing the fallen bits from {site} — the masters hate tripping!",
  "*sorts salvageable brick from the dust* Waste not!",
  "Another barrowful! The works keep me fed.",
];

const HIRE_LINES = [
  "Need a pair of hands? Hire me for the day — hauling, digging, carrying!",
  "I've got the day free — put me to work, boss!",
  "*taps the shovel* Day labor! Strong back, fair price!",
];

const BOSS_LINES = [
  "{player}! Point me at the work, boss — I'm hired and ready!",
  "Boss {player}! Tell me what to carry!",
  "{player} — your laborer's here! What's first?",
];

const PRO_BUILD_LINES = [
  "The masters are on the {phase} of {project} — I just carry the hods!",
  "{project} is rising — the {phase} now. My back did half of it!",
  "Leave {project} to the master builders. You want carrying? That's me!",
];

const TOPPING_OUT_LINES = [
  "She's topped out! {project} — *waves a cap in the air*",
  "Topped out! {project} stands finished — drinks all round!",
  "{project}! We topped her out today — *cheers with the crew*",
];

const SLIP_LINES = [
  "*CRACK* — plank slipped on the scaffold! Nobody hurt — mind your footing!",
  "Plank went on the scaffold! *steadies the frame* All hands check your lashings!",
  "A board slipped at {site} — nobody fell, thank the light!",
];

const SUPPLY_DELAY_LINES = [
  "Stone wagons are late! No {material} today — we mix what we've got!",
  "No {material} from the yards — the masons are rationing!",
  "Wagons missed the road — the mortar tubs are running low!",
];

// === Daily tasks: 1 task of the day per laborer ===
const DAILY_TASK_LINES = {
  [HOD_CARRIER]: [
    "greasing the hod straps",
    "stacking brick at the lift point",
    "sweeping the ladder run",
    "sorting bricks by size",
  ],
  [MORTAR_MIXER]: [
    "sieving sand for the mortar",
    "wetting down the lime",
    "scraping out the mortar tubs",
    "fetching water for the mix",
  ],
  [SCAFFOLD_MATE]: [
    "checking every lashing on the frame",
    "oiling the block and tackle",
    "stacking spare boards",
    "re-tying the loose knots",
  ],
  [DAY_LABORER]: [
    "sharpening the shovel",
    "mending a barrow wheel",
    "sitting by the hiring stone",
    "fetching lunch for the crew",
  ],
  [RUBBLE_CLEARER]: [
    "raking the spoil heap",
    "sorting salvageable brick",
    "emptying the barrow runs",
    "clearing the scaffold footings",
  ],
};

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

// === Ledgers (TTL'd) ===
const hires = new Map(); // normPlayerName -> { hire }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of hires) {
    if (v.hire.until <= nowMs) hires.delete(k);
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

/** Weighted pick of a laborfolk type from a 0..99 roll. */
function laborfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of LABORFOLK_TYPES) {
    acc += LABORFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return HOD_CARRIER;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during work hours (06:00-20:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
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

/** Normalized username via CitizenBonds (fallback: lowercase). */
function normalizeName(name) {
  try {
    if (Bonds && typeof Bonds.normalizeName === "function") return Bonds.normalizeName(name);
  } catch { /* fall through */ }
  return String(name ?? "").toLowerCase();
}

// ============================================================================
// Laborfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The laborfolk type for a roster record, or null.
 * Excludes the claimed pro builders (the real CitizenBuilders getBuilderInfo
 * null path — unclaimed names read null, so it is a valid eligibility
 * gate): the masters own the projects and phases, laborers own the hods
 * and mortar tubs.
 * Uses name-first salts to avoid the FNV-1a prefix-correlation bug.
 */
function laborfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the claimed pro builders own the trade.
    try {
      if (ProBuilders && typeof ProBuilders.getBuilderInfo === "function" && ProBuilders.getBuilderInfo(name)) {
        return null;
      }
    } catch { /* pro check failed — treat as unclaimed */ }
    const roll = hashStr(name + "|laborfolk") % 100;
    if (roll >= LABORFOLK_SHARE) return null;
    return laborfolkTypeFromRoll(hashStr(name + "|laborfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred work site assignment, stable across restarts. */
function siteFor(record) {
  const kid = record?.kingdomId ?? record?.kingdom;
  const local = SITES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : SITES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|laborsite") % pool.length];
}

/** Today's task for a laborfolk citizen (1 task of the day). */
function taskForToday(username, type, dateMs) {
  const tasks = DAILY_TASK_LINES[type] ?? DAILY_TASK_LINES[HOD_CARRIER];
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(name + "|labor-task:" + day));
  return pickOne(rng, tasks);
}

/** Today's material on the site (stable per day). */
function materialForToday(site, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("laborfolkmat:" + site.name + ":" + day));
  return pickOne(rng, MATERIALS);
}

/**
 * A topping-out celebration at a site (~8%/day), or null: the crew's
 * proudest moment, { project }. Journaled + rumor-seeded by the tick.
 */
function toppingOutFor(site, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("laborfolktop:" + site.name + ":" + day));
  if (rng() >= TOPPING_OUT_CHANCE) return null;
  const proj = proProjectFor(site.kingdom, dateMs);
  return { project: proj ? proj.name : "the works" };
}

/**
 * A scaffold slip at a site (~6%/day), or null: a plank goes, nobody is
 * hurt, everyone checks their lashings. Journaled + rumor-seeded.
 */
function scaffoldSlipFor(site, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("laborfolkslip:" + site.name + ":" + day));
  if (rng() >= SCAFFOLD_SLIP_CHANCE) return null;
  return true;
}

/**
 * A supply delay in a kingdom (~8%/day), or null: the stone wagons are
 * late and the crews ration the mortar. Journaled + rumor-seeded.
 */
function supplyDelayFor(kingdomId, dateMs) {
  if (!kingdomId) return null;
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr(String(kingdomId) + "|supply-delay:" + day));
  if (rng() >= SUPPLY_DELAY_CHANCE) return null;
  return true;
}

// ============================================================================
// Real-data bridges — the master builders, cross-read.
// ============================================================================

/**
 * Read-only bridge: the kingdom's master-builder project of the day,
 * drawn from the real CitizenBuilders project name pools and phases, so
 * laborer small talk stays consistent with the trade's project names.
 * Returns { type, name, phase } or null. Never throws.
 */
function proProjectFor(kingdomId, nowMs = Date.now()) {
  try {
    if (!ProBuilders || !ProBuilders.PROJECT_TYPES || !ProBuilders.PROJECT_PHASES) return null;
    const kid = String(kingdomId ?? "");
    if (!kid) return null;
    const day = dayNumber(nowMs);
    const rng = seededRng(hashStr(kid + "|laborproj:" + day));
    const typeKeys = Object.keys(ProBuilders.PROJECT_TYPES);
    if (!typeKeys.length) return null;
    const type = pickOne(rng, typeKeys);
    const def = ProBuilders.PROJECT_TYPES[type] ?? {};
    const names = def.names ?? [];
    const name = names.length ? pickOne(rng, names) : type;
    const phases = (ProBuilders.PROJECT_PHASES ?? []).filter((p) => p !== "complete");
    const phase = phases.length ? pickOne(rng, phases) : "structure";
    return { type, name, phase };
  } catch {
    return null;
  }
}

// ============================================================================
// Day-labor hire ledger (data tier, zero LLM).
// ============================================================================

/**
 * A laborer is hired for the day: the player names a job, the laborer
 * remembers the boss until the hire expires (24h TTL).
 */
function hireLaborer(playerName, laborerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  const laborer = String(laborerName ?? "").slice(0, 40);
  if (!name || !laborer) return null;
  pruneLedgers(nowMs);
  const rec = {
    hire: {
      player: String(playerName),
      laborer,
      hiredAt: nowMs,
      until: nowMs + HIRE_TTL_MS,
    },
  };
  hires.set(name, rec);
  return rec.hire;
}

/** The player's outstanding day-labor hire, or null. */
function hireFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = hires.get(name);
  if (!rec || rec.hire.until <= nowMs) return null;
  return { ...rec.hire };
}

/** The player releases their hired laborer (deletes the record). */
function releaseLaborer(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return false;
  pruneLedgers(nowMs);
  return hires.delete(name);
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

function journalize(citizen, text) {
  try {
    if (Journal && typeof Journal.appendEntry === "function") {
      Journal.appendEntry(citizen, text);
    } else if (Journal && typeof Journal.addEntry === "function") {
      Journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(text) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor(text);
  } catch { /* rumors absent */ }
}

/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    citizen.forceChat?.(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → laborfolk? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickLaborfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < LABORFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible laborfolk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be laborfolk (hash-derived, cheap; exclusions inside)
        const type = laborfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Work hours only
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, LABORFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, LABORFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doLaborfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-laborfolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: topping-outs, scaffold slips and supply delays
    // (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-laborfolk] tick failed:", e?.message ?? e);
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

function doLaborfolkWork(director, record, citizen, type, nowMs) {
  const site = siteFor(record);
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const day = dayNumber(nowMs);

  // Topping-out celebration: once per site per day, the crowd moment.
  const top = toppingOutFor(site, nowMs);
  if (top) {
    const key = "labortopout:" + site.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      forceSay(citizen, fill(pickOne(Math.random, TOPPING_OUT_LINES), { project: top.project }));
      journalize(citizen, `topped out ${top.project} at ${site.name}`);
      seedRumor(`${top.project} topped out at ${site.name}!`);
      return;
    }
  }

  // A scaffold slip on the site: the lashing moment.
  if (scaffoldSlipFor(site, nowMs) && type === SCAFFOLD_MATE && Math.random() < 0.5) {
    forceSay(citizen, fill(pickOne(Math.random, SLIP_LINES), { site: site.name }));
    journalize(citizen, `checked lashings after a plank slipped at ${site.name}`);
    seedRumor(`A plank slipped at ${site.name} — nobody hurt!`);
    return;
  }

  // A nearby player's active hire takes priority: name the boss.
  const hired = nearbyActiveHire(director, citizen, name, nowMs);
  if (hired) {
    forceSay(citizen, fill(pickOne(Math.random, BOSS_LINES), { player: hired.name }));
    journalize(citizen, `reported to their boss near ${site.name}`);
    return;
  }

  const material = materialForToday(site, nowMs);
  const proj = kid ? proProjectFor(kid, nowMs) : null;

  if (type === HOD_CARRIER) {
    const roll = Math.random();
    if (roll < 0.6) {
      forceSay(citizen, fill(pickOne(Math.random, HOD_LINES), { material, site: site.name }));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
    } else if (proj) {
      forceSay(citizen, fill(pickOne(Math.random, PRO_BUILD_LINES), { phase: proj.phase, project: proj.name }));
      journalize(citizen, `talked trade with passers-by at ${site.name}`);
    } else {
      forceSay(citizen, fill(pickOne(Math.random, HOD_LINES), { material, site: site.name }));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
    }
    return;
  }

  if (type === MORTAR_MIXER) {
    const roll = Math.random();
    if (kid && supplyDelayFor(kid, nowMs) && roll < 0.4) {
      forceSay(citizen, fill(pickOne(Math.random, SUPPLY_DELAY_LINES), { material }));
      journalize(citizen, `rationed mortar on a supply delay at ${site.name}`);
    } else if (roll < 0.6) {
      forceSay(citizen, pickOne(Math.random, MORTAR_LINES));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
    } else if (proj) {
      forceSay(citizen, fill(pickOne(Math.random, PRO_BUILD_LINES), { phase: proj.phase, project: proj.name }));
      journalize(citizen, `talked trade with passers-by at ${site.name}`);
    } else {
      forceSay(citizen, pickOne(Math.random, MORTAR_LINES));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
    }
    return;
  }

  if (type === SCAFFOLD_MATE) {
    const roll = Math.random();
    if (roll < 0.6) {
      forceSay(citizen, pickOne(Math.random, SCAFFOLD_LINES));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
    } else if (proj) {
      forceSay(citizen, fill(pickOne(Math.random, PRO_BUILD_LINES), { phase: proj.phase, project: proj.name }));
      journalize(citizen, `talked trade with passers-by at ${site.name}`);
    } else {
      forceSay(citizen, pickOne(Math.random, SCAFFOLD_LINES));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
    }
    return;
  }

  if (type === DAY_LABORER) {
    const roll = Math.random();
    if (roll < 0.55) {
      forceSay(citizen, pickOne(Math.random, HIRE_LINES));
      journalize(citizen, `offered day labor at ${site.name}`);
    } else if (roll < 0.75) {
      forceSay(citizen, pickOne(Math.random, ODDJOB_LINES));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
    } else if (proj) {
      forceSay(citizen, fill(pickOne(Math.random, PRO_BUILD_LINES), { phase: proj.phase, project: proj.name }));
      journalize(citizen, `talked trade with passers-by at ${site.name}`);
    } else {
      forceSay(citizen, pickOne(Math.random, ODDJOB_LINES));
      journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
    }
    return;
  }

  // Rubble-clearer: hauling the broken bits.
  if (kid && supplyDelayFor(kid, nowMs) && Math.random() < 0.4) {
    forceSay(citizen, fill(pickOne(Math.random, SUPPLY_DELAY_LINES), { material }));
    journalize(citizen, `hauled rubble on a quiet site at ${site.name}`);
    return;
  }
  forceSay(citizen, fill(pickOne(Math.random, RUBBLE_LINES), { site: site.name }));
  journalize(citizen, `${taskForToday(name, type, nowMs)} at ${site.name}`);
}

/** A nearby real player whose active hire names this laborer, if any. */
function nearbyActiveHire(director, citizen, laborerName, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, LABORFOLK_RADIUS)) continue;
      const pname = p.getUsername?.() ?? "";
      if (!pname) return null;
      const ok = hireFor(pname, nowMs);
      if (ok && normalizeName(ok.laborer) === laborerName) return { name: pname, hire: ok };
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day kingdom rhythms: topping-outs, slips and supply delays. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
  try {
    for (const kid of kingdoms) {
      const sites = SITES.filter((s) => s.kingdom === kid);
      for (const site of sites) {
        if (toppingOutFor(site, nowMs)) {
          const key = "daily-labortopout:" + site.name + ":" + day;
          if (!lastFiredByCitizen.has(key)) {
            lastFiredByCitizen.set(key, nowMs);
            const proj = proProjectFor(kid, nowMs);
            const line = `${proj ? proj.name : "the works"} topped out at ${site.name} — the hoddies cheered.`;
            journalize({ username: "the laborers" }, line);
            seedRumor(line);
          }
        }
        if (scaffoldSlipFor(site, nowMs)) {
          const key = "daily-laborslip:" + site.name + ":" + day;
          if (!lastFiredByCitizen.has(key)) {
            lastFiredByCitizen.set(key, nowMs);
            const line = `A plank slipped on the scaffold at ${site.name} — nobody hurt, every lashing checked twice.`;
            journalize({ username: "the laborers" }, line);
            seedRumor(line);
          }
        }
      }
      if (supplyDelayFor(kid, nowMs)) {
        const key = "daily-labordelay:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const line = `Stone wagons missed the road in ${kid} — the laborers are rationing mortar and stacking rubble.`;
          journalize({ username: "the laborers" }, line);
          seedRumor(line);
        }
      }
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickLaborfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  laborfolkTypeOf,
  siteFor,
  taskForToday,
  materialForToday,
  toppingOutFor,
  scaffoldSlipFor,
  supplyDelayFor,
  proProjectFor,
  hireLaborer,
  hireFor,
  releaseLaborer,
  nearbyActiveHire,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  laborfolkTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  LABORFOLK_TYPES,
  HOD_CARRIER,
  MORTAR_MIXER,
  SCAFFOLD_MATE,
  DAY_LABORER,
  RUBBLE_CLEARER,
  SITES,
  MATERIALS,
  // Tuning (tests pin the documented behavior):
  LABORFOLK_RADIUS,
  LABORFOLK_CITIZEN_COOLDOWN_MS,
  LABORFOLK_CHANCE,
  LABORFOLK_SHARE,
  TOPPING_OUT_CHANCE,
  SCAFFOLD_SLIP_CHANCE,
  SUPPLY_DELAY_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  LABORFOLK_TYPES_WEIGHTS: LABORFOLK_WEIGHTS,
  HIRE_TTL_MS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    hires.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
