"use strict";

/**
 * CitizenSculptors — citizens who carve stone, wood, and metal into statues
 * and monuments at the kingdom quarries, foundries, and studios.
 *
 * WHAT IT DOES (data tier, free):
 *   Every sculptor works a daily sculpture catalog (2-4 works with quality
 *   tiers rough/hewn/finished/masterwork) derived from date + hashes, zero
 *   storage. Stone carvers and metalworkers contribute to slow multi-day
 *   public monuments whose dedications honor real journaled events; when a
 *   monument completes it is announced once and seeded into CitizenRumors.
 *   Commission ledgers live in small in-memory maps with TTL pruning.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   During workshop hours (08:00-17:00) a materialized sculptor at a quarry,
 *   foundry, or studio holds scripted work — carving emotes, sculpture
 *   hawking, masterpiece unveiling fanfare, monument-progress updates,
 *   commission offers for lingering players. Coin tips via tipSculptor
 *   (wired into Citizens.plugin.js onTipSeen).
 *
 * Zero LLM: all lines are scripted pools; the LLM dialogue tier reads the
 * journals and ledgers.
 *
 * No overlap: street performers own the squares (performerTypeOf), bards own
 * music (bardTypeOf), actors own the theaters (actorTypeOf), innkeepers own
 * inn hospitality (inn bards), painters own the studios (painterTypeOf) —
 * sculptors exclude all five. Builders own construction projects; sculptors
 * only carve the monuments they dedicate.
 *
 * Ties: metalworkers read the real CitizenMiners ore tables (lazy require,
 * best-effort, never throws) so "today's bronze" matches the miners' pull.
 *
 * Wired into the director tick right after the painters block (proximity
 * tick), guarded try/catch, per-citizen try/catch, cooldown maps pruned
 * hourly, gate order cheapest-first. House rule 12: matches the established
 * citizen-module pattern, wired through the existing director plugin,
 * no new core hooks, no guessed anim IDs (emotes and forceChat only).
 * Plain-node testable: CitizenSculptors.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { chance } = require("./humanizer");

// === Tuning: all magic numbers here ===
const SCULPTOR_RADIUS = 14; // tiles — close enough to hear the chisel
const SCULPTOR_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const SCULPTOR_CHANCE = 0.35; // per eligible citizen per tick
const WORKSHOP_START_HOUR = 8; // sculptors work in daylight 08:00-17:00
const WORKSHOP_END_HOUR = 17;
const MASTERPIECE_CHANCE_PER_DAY = 0.08; // ~8% per workshop per day
const MONUMENT_MIN_DAYS = 6; // public monuments take 6-9 days to complete
const COINS_ID = 995;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip
const SCULPTOR_SHARE = 30; // ~30% of commoners are sculptors

const SCULPTOR_STONE = "stone-carver";
const SCULPTOR_WOOD = "wood-carver";
const SCULPTOR_METAL = "metalworker";
const SCULPTOR_RESTORER = "restorer";
const SCULPTOR_TYPES = Object.freeze([
  SCULPTOR_STONE,
  SCULPTOR_WOOD,
  SCULPTOR_METAL,
  SCULPTOR_RESTORER,
]);
const SCULPTOR_WEIGHTS = Object.freeze({
  [SCULPTOR_STONE]: 30,
  [SCULPTOR_WOOD]: 30,
  [SCULPTOR_METAL]: 20,
  [SCULPTOR_RESTORER]: 20,
});

// === Workshops: quarries, foundries, yards, and studios, kingdom-preferred ===
const WORKSHOPS = Object.freeze([
  { name: "the Varrock Marble Quarry", kingdom: "varrock" },
  { name: "the Lumbridge Riverside Studio", kingdom: "varrock" },
  { name: "the Falador Stone Yard", kingdom: "asgarnia" },
  { name: "the Taverley Woodcarvers' Shed", kingdom: "asgarnia" },
  { name: "the Ardougne Bronze Foundry", kingdom: "kandarin" },
  { name: "the Kandarin Timber Works", kingdom: "kandarin" },
  { name: "the Keldagrim Deep Carve", kingdom: "keldagrim" },
  { name: "the Dorgesh Stone Burrow", kingdom: "keldagrim" },
  { name: "the Canifis Gargoyle Yard", kingdom: "morytania" },
  { name: "the Darkmeyer Obsidian Works", kingdom: "morytania" },
]);

// === Sculpture subjects by type ===
const QUALITY_ROUGH = "rough";
const QUALITY_HEWN = "hewn";
const QUALITY_FINISHED = "finished";
const QUALITY_MASTERWORK = "masterwork";
const QUALITIES = Object.freeze([
  QUALITY_ROUGH,
  QUALITY_HEWN,
  QUALITY_FINISHED,
  QUALITY_MASTERWORK,
]);

const SUBJECTS = Object.freeze({
  [SCULPTOR_STONE]: Object.freeze([
    "a marble lion",
    "a granite knight",
    "the founder's likeness",
    "a gargoyle for the gatehouse",
    "a veined-marble goddess",
  ]),
  [SCULPTOR_WOOD]: Object.freeze([
    "an oak falcon",
    "a willow dancer",
    "a ship's figurehead",
    "a carved toy horse",
    "a yew archer",
  ]),
  [SCULPTOR_METAL]: Object.freeze([
    "a bronze bull",
    "an iron golem miniature",
    "a brass bell",
    "a copper sun-disc",
    "a steel rose",
  ]),
  [SCULPTOR_RESTORER]: Object.freeze([
    "the weathered war memorial",
    "the cracked fountain nymph",
    "the moss-eaten king",
    "the headless sentinel",
    "the pitted bronze horse",
  ]),
});

const MATERIALS = Object.freeze({
  [SCULPTOR_STONE]: Object.freeze(["marble", "granite"]),
  [SCULPTOR_WOOD]: Object.freeze(["oak", "willow", "yew"]),
  [SCULPTOR_METAL]: Object.freeze(["bronze", "iron"]),
  [SCULPTOR_RESTORER]: Object.freeze(["plaster", "bronze polish", "stone sealant"]),
});

const MONUMENT_DEDICATIONS = Object.freeze([
  "the founders",
  "the fallen of the South Gate",
  "the great harvest",
  "the five capitals",
  "the dragon-slayers",
  "the first treaty",
]);

// === Scripted lines (data tier; the LLM riffs via the journal) ===
const WORK_EMOTES = Object.freeze([
  "*taps the chisel, stone chips fly*",
  "*steps back to judge the proportions*",
  "*files a rough edge smooth*",
  "*blows dust from the carving*",
  "*hefts the mallet and strikes true*",
  "*traces the grain with a fingertip*",
]);

const HAWK_LINES = Object.freeze([
  "Fresh off the bench! {subject} — a {quality} piece!",
  "Come see today's carving: {subject}, in {quality}!",
  "For sale: {subject}. Carved this very week!",
  "A {quality} {subject} — yours for a fair price!",
]);

const MASTERPIECE_LINES = Object.freeze([
  "BEHOLD! My masterpiece is unveiled — {subject}!",
  "Years at the bench, finished at last: {subject}, my masterpiece!",
  "Come, all of you — witness {subject}, my masterwork!",
]);

const COMMISSION_LINES = Object.freeze([
  "Ever wanted your likeness in stone? I take commissions, friend!",
  "I carve commissions — statues, busts, garden pieces!",
  "Commissions open! Your face, immortalized in marble.",
]);

const RESTORE_LINES = Object.freeze([
  "*patches a crack with fresh plaster*",
  "*scrubs moss from the old stone*",
  "Another winter, another crack — she'll stand a century more.",
  "*polishes the bronze back to a shine*",
]);

const MONUMENT_WORK_LINES = Object.freeze([
  "*raises another block onto the monument*",
  "The monument to {dedication} grows, stone by stone.",
  "*checks the plumb line on the monument*",
  "Come the dedication day, the whole city will gather.",
]);

const MONUMENT_COMPLETE_LINES = Object.freeze([
  "IT IS FINISHED! The monument to {dedication} stands complete!",
  "The monument to {dedication} is done — come, all of you, and see!",
  "Years of work, and there it stands — the monument to {dedication}!",
]);

const TIP_THANKS = Object.freeze([
  "A patron of the arts! My chisels thank you!",
  "Your generosity gives my work weight — thank you!",
  "For the love of stone, and stone-lovers — thank you!",
  "The workshop thanks you! Come see the next piece!",
]);

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastMasterpieceAnnounce = new Map(); // workshop name -> day number
const lastMonumentAnnounce = new Map(); // workshop name -> day number

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

/** Weighted pick of a sculptor type from a 0..99 roll. */
function sculptorTypeFromRoll(roll) {
  let acc = 0;
  for (const t of SCULPTOR_TYPES) {
    acc += SCULPTOR_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return SCULPTOR_STONE;
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

function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/**
 * The sculptor type for a roster record, or null when this citizen is not a
 * sculptor. Hash-derived from the normalized username (~30% of commoners),
 * stable across restarts, zero storage. Excludes street performers, bards,
 * actors, inn bards, and painters so no citizen belongs to two
 * artist/performer systems.
 */
function sculptorTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No double-casting: performers and painters carve elsewhere
    // (or nowhere at all).
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
    const roll = hashStr("sculptor:" + name) % 100;
    if (roll >= SCULPTOR_SHARE) return null;
    return sculptorTypeFromRoll(hashStr("sculptortype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred workshop assignment, stable across restarts. */
function workshopFor(record) {
  const kid = record?.kingdomId;
  const local = WORKSHOPS.filter((s) => s.kingdom === kid);
  const pool = local.length ? local : WORKSHOPS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("workshop:" + name) % pool.length];
}

/**
 * The day's sculpture catalog for a sculptor — 2-4 works with subjects and
 * quality tiers. Deterministic per day, zero storage. A masterwork appears
 * ~8% of sculptor-days (the crowd moment).
 */
function sculpturesFor(record, nowMs = Date.now()) {
  try {
    const type = sculptorTypeOf(record);
    if (!type) return { works: [], masterpiece: false, type: null };
    const name = normalizeName(record?.username) || "anon";
    const day = dayNumber(nowMs);
    const h = hashStr("sculptures:" + name + ":" + day);
    const count = 2 + (h % 3); // 2-4 works
    const subjects = SUBJECTS[type];
    const works = [];
    for (let i = 0; i < count; i++) {
      const sh = hashStr("piece:" + name + ":" + day + ":" + i);
      works.push({
        subject: subjects[sh % subjects.length],
        quality: QUALITIES[sh % QUALITIES.length],
      });
    }
    const masterpiece = ((h >>> 11) % 100) < Math.round(MASTERPIECE_CHANCE_PER_DAY * 100);
    return { works, masterpiece, type };
  } catch {
    return { works: [], masterpiece: false, type: null };
  }
}

/**
 * Today's working material for a sculptor type. Metalworkers read the real
 * CitizenMiners ore tables (lazy require, best-effort) so "today's bronze"
 * matches what the miners actually pulled; everyone else works a static
 * material list. Never throws.
 */
function materialsFor(record, nowMs = Date.now()) {
  try {
    const type = sculptorTypeOf(record);
    if (!type) return [];
    if (type !== SCULPTOR_METAL) return MATERIALS[type].slice();
    try {
      const miners = require("./CitizenMiners");
      if (typeof miners.oreFor === "function") {
        const ore = miners.oreFor(normalizeName(record?.username) || "anon", nowMs);
        if (ore === "copper" || ore === "tin") return ["bronze (from today's " + ore + ")"];
        if (ore === "iron") return ["iron (from today's pull)"];
        if (ore === "silver" || ore === "gold" || ore === "mithril" || ore === "adamant") {
          return [ore + " (from today's pull)", "bronze"];
        }
      }
    } catch { /* miners absent */ }
    return MATERIALS[type].slice();
  } catch {
    return [];
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

/**
 * Scan recent journal entries for newsworthy words and return a short
 * dedication for the public monument, or null. Bounded scan, best-effort,
 * never throws.
 */
function dedicationEventFor() {
  const keywords = [
    ["wedding", "the wedding"],
    ["married", "the wedding"],
    ["festival", "the festival"],
    ["election", "the election"],
    ["crowned", "the crowning"],
    ["victory", "the great victory"],
    ["tournament", "the tournament"],
    ["treaty", "the treaty"],
    ["dragon", "the dragon-slaying"],
  ];
  try {
    const j = journalEvent();
    if (!j || !j.entries) return null;
    let scanned = 0;
    for (const record of j.entries.values()) {
      if (++scanned > 60) break;
      const text = String(record?.text ?? record ?? "").toLowerCase();
      for (const [word, label] of keywords) {
        if (text.includes(word)) return label;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The public monument a workshop is raising — a slow multi-day project
 * derived from hashes, stable across restarts, zero storage. Returns
 * { name, dedication, dayInCycle, cycleDays, complete }.
 */
function monumentFor(record, nowMs = Date.now()) {
  try {
    const type = sculptorTypeOf(record);
    if (type !== SCULPTOR_STONE && type !== SCULPTOR_METAL) return null;
    const workshop = workshopFor(record);
    const h = hashStr("monument:" + workshop.name);
    const cycleDays = MONUMENT_MIN_DAYS + (h % 4); // 6-9 days
    const startDay = h % 1000;
    const day = dayNumber(nowMs);
    const elapsed = day - startDay;
    const dayInCycle = ((elapsed % cycleDays) + cycleDays) % cycleDays;
    const dedication =
      dedicationEventFor() ?? MONUMENT_DEDICATIONS[h % MONUMENT_DEDICATIONS.length];
    return {
      name: "the monument to " + dedication,
      dedication,
      dayInCycle,
      cycleDays,
      complete: dayInCycle === cycleDays - 1,
      workshop: workshop.name,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Commission ledger (data tier, zero LLM) — 7-day TTL.
// ============================================================================
const COMMISSION_TTL_MS = 7 * 24 * 3600 * 1000;
const commissions = new Map(); // normName -> { sculptor, subject, kind, commissionedAt }

function commissionSculpture(playerName, sculptorUsername, subject, kind = "statue", nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  commissions.set(name, {
    sculptor: normalizeName(sculptorUsername),
    subject: String(subject || "a statue"),
    kind: String(kind || "statue"),
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
// Coin tips: "use coins on sculptor" (registered in Citizens.plugin.js
// onTipSeen alongside tipPerformer, tipBard, tipActor, tipPainter). Each
// handler ignores non-own targets.
// ============================================================================
function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

function tipSculptor(event, deps = {}, nowMs = Date.now()) {
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
  const type = sculptorTypeOf(record);
  if (!type) return; // not a sculptor — let the next handler have it

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
    target.forceChat?.(pickOne(Math.random, TIP_THANKS));
  } catch { /* cosmetic */ }
  journalize(target, `received a ${amount}-coin tip from ${player.getUsername?.() ?? "a patron"}`);
  return amount;
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → sculptor? → materialized → workshop
// hours → real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickSculptors(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < SCULPTOR_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a sculptor (hash-derived, cheap)
        const type = sculptorTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. Workshop hours only (sculptors need daylight)
        if (!isWorkshopHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, SCULPTOR_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, SCULPTOR_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        sculptScene(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-sculptors] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-sculptors] tick failed:", e?.message ?? e);
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

/** A full scripted sculpting scene. */
function sculptScene(director, record, citizen, type, nowMs) {
  const workshop = workshopFor(record);
  const catalog = sculpturesFor(record, nowMs);
  const day = dayNumber(nowMs);

  // Masterpiece unveilings: once per workshop per day, the crowd moment.
  if (catalog.masterpiece && (lastMasterpieceAnnounce.get(workshop.name) ?? -1) < day) {
    lastMasterpieceAnnounce.set(workshop.name, day);
    const work = catalog.works[0];
    const line = fill(pickOne(Math.random, MASTERPIECE_LINES), {
      subject: work ? `${work.subject} (${work.quality})` : "a new work",
    });
    citizen.forceChat?.(line);
    journalize(citizen, `unveiled a masterpiece at ${workshop.name}`);
    seedRumor(`A masterpiece unveiled at ${workshop.name} — come see it!`);
    return;
  }

  // Public monuments: the slow work of stone carvers and metalworkers.
  if (type === SCULPTOR_STONE || type === SCULPTOR_METAL) {
    const monument = monumentFor(record, nowMs);
    if (monument) {
      if (monument.complete && (lastMonumentAnnounce.get(workshop.name) ?? -1) < day) {
        lastMonumentAnnounce.set(workshop.name, day);
        const line = fill(pickOne(Math.random, MONUMENT_COMPLETE_LINES), {
          dedication: monument.dedication,
        });
        citizen.forceChat?.(line);
        journalize(citizen, `completed ${monument.name} at ${workshop.name}`);
        seedRumor(`${monument.name} stands complete at ${workshop.name}!`);
        return;
      }
      const line = fill(pickOne(Math.random, MONUMENT_WORK_LINES), {
        dedication: monument.dedication,
      });
      citizen.forceChat?.(line);
      journalize(citizen, `worked on ${monument.name} at ${workshop.name}`);
      return;
    }
  }

  // Restorers: tend the weathered statues of the city.
  if (type === SCULPTOR_RESTORER) {
    const work = catalog.works[0];
    const emote = pickOne(Math.random, RESTORE_LINES);
    const line = !emote.startsWith("*") && work ? `Restoring ${work.subject} — ${emote}` : emote;
    citizen.forceChat?.(line);
    journalize(citizen, `restored statuary at ${workshop.name}`);
    return;
  }

  // Hawking: sell today's catalog.
  if (catalog.works.length) {
    const work = pickOne(Math.random, catalog.works);
    const line = fill(pickOne(Math.random, HAWK_LINES), {
      subject: work.subject,
      quality: work.quality,
    });
    citizen.forceChat?.(line);
    journalize(citizen, `hawked "${work.subject}" (${work.quality}) at ${workshop.name}`);
    return;
  }

  // Fallback: work emotes.
  citizen.forceChat?.(pickOne(Math.random, WORK_EMOTES));
}

/**
 * Offer a commission to a lingering real player.
 * Called from the tick path; the LLM dialogue tier handles the reply.
 */
function maybeOfferCommission(record, citizen, type) {
  const line = pickOne(Math.random, COMMISSION_LINES);
  try {
    citizen.forceChat?.(line);
  } catch { /* cosmetic */ }
  return line;
}

module.exports = {
  tickSculptors,
  tipSculptor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  sculptorTypeOf,
  workshopFor,
  sculpturesFor,
  monumentFor,
  materialsFor,
  commissionSculpture,
  commissionFor,
  maybeOfferCommission,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  sculptorTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isWorkshopHour,
  dayNumber,
  SCULPTOR_TYPES,
  SCULPTOR_STONE,
  SCULPTOR_WOOD,
  SCULPTOR_METAL,
  SCULPTOR_RESTORER,
  WORKSHOPS,
  SUBJECTS,
  MATERIALS,
  QUALITIES,
  QUALITY_ROUGH,
  QUALITY_HEWN,
  QUALITY_FINISHED,
  QUALITY_MASTERWORK,
};
