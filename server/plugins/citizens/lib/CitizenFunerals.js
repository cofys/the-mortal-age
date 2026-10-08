"use strict";

/**
 * CitizenFunerals — death, funerals, grief, and remembrance.
 *
 * When a citizen dies, the community mourns: a funeral is scheduled and
 * held, close friends and family grieve for days, the deceased is journaled
 * into collective memory, memorials are visited, and anniversaries are
 * remembered in tavern stories. Players who attend a funeral are thanked.
 *
 * WHAT IT DOES (data tier, free — slow ~60s tick):
 *   mortality rolls (old age, accidents, battle), death bookkeeping, funeral
 *   scheduling and state, grief assignment/expiry, anniversary remembrance,
 *   newspaper obituary feed. If no player is near when a funeral comes due,
 *   it is held data-tier (journaled) so the world never stalls.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   the funeral ceremony (eulogist + mourners gather, scripted eulogies,
 *   burial), mourners' grief lines, memorial visits, remembrance stories,
 *   and thanks for attending.
 *
 * Zero LLM: every visible line is a scripted frame or pool pick. The LLM
 * handles deep eulogy dialogue in the chat layer; this module journals
 * everything so it can riff truthfully ("we buried Old Marta last week").
 *
 * Wired: tickMortality on the slow tick (after the newspaper block, so
 * obituaries read fresh deceased); tickFuneralRites on the proximity tick
 * after the retirement block. Plain-node testable: CitizenFunerals.test.js.
 */

const fs = require("fs");
const path = require("path");
const { getJournal } = require("./CitizenJournal");
const { normalizeName, isFriend } = require("./CitizenBonds");
const { agentRng, chance } = require("./humanizer");
const { brainTickDue } = require("./CitizenTickLod");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-funerals.json");

// === Tuning: all magic numbers here ===
const MORTALITY_AGE = 75; // natural-death rolls start at this age
const ELDER_MORTALITY_PER_TICK = 0.00001; // per elder (75+) per slow tick (~60s)
const VENERABLE_AGE = 85; // 85+ doubles the elder roll
const ACCIDENT_PER_TICK = 0.0000005; // any citizen, per slow tick
const BATTLE_PER_TICK = 0.00005; // guards only, per slow tick
const FUNERAL_DELAY_MS = 24 * 3600 * 1000; // funeral one day after death
const MOURNING_MS = 3 * 24 * 3600 * 1000; // base grief duration
const MOURNING_CLOSE_MS = 7 * 24 * 3600 * 1000; // close kin/friends grieve longer
const CEREMONY_RADIUS = 14; // tiles — close enough to witness the funeral
const GRIEF_RADIUS = 12; // mourning lines are overheard this far
const MEMORIAL_RADIUS = 10;
const MAX_DECEASED = 200; // registry bound — oldest fall off
const GRIEF_COOLDOWN_MS = 6 * 3600 * 1000; // per mourner grief-line throttle
const MEMORIAL_COOLDOWN_MS = 12 * 3600 * 1000; // per citizen memorial-visit throttle
const REMEMBRANCE_COOLDOWN_MS = 24 * 3600 * 1000; // per deceased anniversary throttle

// === State ===
const deceased = new Map(); // normalized username -> deceased record
const mourning = new Map(); // normalized username -> { deceased, until }
const lastGriefByCitizen = new Map(); // username -> timestamp
const lastMemorialByCitizen = new Map(); // username -> timestamp
const lastRemembranceByDeceased = new Map(); // deceased username -> timestamp
const lastCeremonyByDeceased = new Map(); // deceased username -> timestamp (visible ceremony)
let dirty = false;
let loaded = false;

// Memory-leak plug: prune entries older than the longest cooldown window,
// at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 8 * 24 * 3600 * 1000;
  for (const m of [
    lastGriefByCitizen,
    lastMemorialByCitizen,
    lastRemembranceByDeceased,
    lastCeremonyByDeceased,
  ]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
  for (const [k, m] of mourning) {
    if (m.until < nowMs) mourning.delete(k);
  }
}

// ============================================================================
// Persistence — same shape as citizen-memory.json (dirty flag, saveIfDirty).
// ============================================================================

function toJSON() {
  return {
    savedAt: Date.now(),
    deceased: [...deceased.values()],
  };
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    for (const d of parsed.deceased || []) {
      if (d && d.username) deceased.set(normalizeName(d.username), d);
    }
  } catch {
    // Corrupt or missing save — start empty, never crash.
  }
}

/** Test seam. */
function resetForTests() {
  deceased.clear();
  mourning.clear();
  lastGriefByCitizen.clear();
  lastMemorialByCitizen.clear();
  lastRemembranceByDeceased.clear();
  lastCeremonyByDeceased.clear();
  dirty = false;
  loaded = true;
  lastPruneAt = 0;
}

function saveIfDirty() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(toJSON(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

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

/** Journal one line, never throw. */
function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

/** The citizen's age from personality data (default 35). */
function ageOf(record) {
  return Number(record?.personality?.age ?? 35);
}

/**
 * Per-slow-tick death probability for a roster record. Pure.
 * Elders die of old age; anyone can die in an accident; guards can fall
 * in battle. Tuned for ~1-3 deaths/week across a ~170-citizen realm.
 */
function mortalityChanceFor(record) {
  const age = ageOf(record);
  const role = String(record?.role ?? "").toLowerCase();
  let p = ACCIDENT_PER_TICK;
  if (age >= MORTALITY_AGE) {
    p += ELDER_MORTALITY_PER_TICK * (age >= VENERABLE_AGE ? 2 : 1);
  }
  if (role === "guard") {
    p += BATTLE_PER_TICK;
  }
  return p;
}

const CAUSES_OLD_AGE = [
  "passed peacefully in their sleep",
  "died of old age, surrounded by kin",
  "succumbed to a winter fever",
  "their heart gave out at the market",
];
const CAUSES_ACCIDENT = [
  "fell from the rooftops",
  "drowned in the river",
  "was kicked by a mule",
  "died in a workshop fire",
  "was lost in a storm at sea",
];
const CAUSES_BATTLE = [
  "fell in battle defending the walls",
  "died of wounds from the border skirmish",
  "fell holding the gate",
];

/**
 * Pick a cause of death consistent with the citizen. Pure.
 * Guards may fall in battle; elders mostly die of age; anyone can
 * have an accident.
 */
function causeOfDeath(rng, record) {
  const age = ageOf(record);
  const role = String(record?.role ?? "").toLowerCase();
  if (role === "guard" && rng() < 0.45) return pickOne(rng, CAUSES_BATTLE);
  if (age >= MORTALITY_AGE && rng() < 0.8) return pickOne(rng, CAUSES_OLD_AGE);
  return pickOne(rng, CAUSES_ACCIDENT);
}

/** Pull a few proud moments from the journal as the citizen's legacy. Pure-ish. */
function legacyOf(username) {
  try {
    const events = getJournal().recent(username, 30) || [];
    const proud = events
      .filter((e) => /earned|mastered|graduated|promoted|won|built|taught|saved|married/i.test(e.text || ""))
      .slice(0, 3)
      .map((e) => e.text);
    return proud;
  } catch {
    return [];
  }
}

/**
 * Find the deceased's close circle: kin + friends still on the roster.
 * Returns up to 8 normalized usernames. Pure-ish (reads kinship/bonds).
 */
function selectMourners(director, deceasedRecord) {
  const out = [];
  const seen = new Set();
  const name = deceasedRecord.username;
  const add = (u) => {
    const k = normalizeName(u);
    if (!k || k === normalizeName(name) || seen.has(k)) return;
    if (!director.roster?.has?.(k)) return;
    seen.add(k);
    out.push(k);
  };
  try {
    const kin = require("./CitizenKinship").getKinship().of(name) || [];
    for (const k of kin) add(k.name ?? k.username ?? k);
  } catch {
    // No kin — fall through to friends.
  }
  try {
    for (const record of director?.roster?.values?.() ?? []) {
      if (out.length >= 8) break;
      try {
        if (isFriend(name, record.username)) add(record.username);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return out.slice(0, 8);
}

// --- Scripted lines (zero LLM) ---

const EULOGY_FRAMES = [
  "{eulogist}: We gather to remember {name}, {role} of this town for {years} years. {causeLine} We will not forget them.",
  "{eulogist}: {name} is gone. {causeLine} They gave this town {years} years of honest work as a {role}. Rest now, friend.",
  "{eulogist}: I have known {name} since we were both young. {legacyLine} {causeLine} The town is poorer today.",
  "{eulogist}: Say what you will, {name} lived. {legacyLine} {causeLine} We bury them with honor.",
];

const GRIEF_LINES = [
  "*wipes their eyes* I still expect to see {name} at the {place}.",
  "I can't believe {name} is gone. It doesn't feel real.",
  "*stares at the ground* {name} deserved more years.",
  "The town feels emptier without {name}.",
  "I keep thinking I'll run into {name} at the market. Then I remember.",
];

const GRIEF_CLOSE_LINES = [
  "*voice breaking* {name} was like family to me. I don't know what to do with myself.",
  "I was supposed to grow old with {name}. This isn't right.",
  "*clutches a keepsake* {name} gave me this. I'll keep it always.",
  "Every corner of this town reminds me of {name}.",
];

const MEMORIAL_LINES = [
  "*lays flowers at the memorial* Rest well, {name}.",
  "*bows head at the memorial* We remember you, {name}.",
  "*traces {name}'s name on the memorial stone* Gone, not forgotten.",
];

const REMEMBRANCE_LINES = [
  "A year ago we lost {name}. {legacyLine} Raise a cup to them.",
  "Do you remember {name}? {legacyLine} Gone, but the stories stay.",
  "They say {name} still watches over the {place}. {legacyLine}",
];

const THANKS_LINES = [
  "Thank you for coming to honor {name}. It means everything.",
  "{name} would have been glad you came. Thank you.",
  "Not everyone stops for the dead. Thank you for stopping for {name}.",
];

const PLACES = ["market", "tavern", "square", "docks", "forge", "chapel"];

function eulogyFor(rng, deceasedRec, eulogistName) {
  const years = Math.max(1, Math.round((deceasedRec.age ?? 40) / 2));
  const legacy = (deceasedRec.legacy || [])[0];
  const frame = pickOne(rng, EULOGY_FRAMES);
  return frame
    .replace("{eulogist}", eulogistName)
    .replace("{name}", deceasedRec.display)
    .replace("{role}", deceasedRec.role || "citizen")
    .replace("{years}", String(years))
    .replace("{causeLine}", `They ${deceasedRec.cause}.`)
    .replace("{legacyLine}", legacy ? `Remember: ${legacy}` : "They lived well and worked hard.");
}

function griefLineFor(rng, deceasedRec, close) {
  const pool = close ? GRIEF_CLOSE_LINES : GRIEF_LINES;
  return pickOne(rng, pool)
    .replace("{name}", deceasedRec.display)
    .replace("{place}", pickOne(rng, PLACES));
}

function memorialLineFor(rng, deceasedRec) {
  return pickOne(rng, MEMORIAL_LINES).replace("{name}", deceasedRec.display);
}

function remembranceLineFor(rng, deceasedRec) {
  const legacy = (deceasedRec.legacy || [])[0];
  return pickOne(rng, REMEMBRANCE_LINES)
    .replace("{name}", deceasedRec.display)
    .replace("{legacyLine}", legacy ? legacy : "They lived well and worked hard.")
    .replace("{place}", pickOne(rng, PLACES));
}

function thanksLineFor(rng, deceasedRec) {
  return pickOne(rng, THANKS_LINES).replace("{name}", deceasedRec.display);
}

/** True if this citizen is currently grieving. */
function isMourning(username, nowMs) {
  const m = mourning.get(normalizeName(username));
  return !!m && m.until > nowMs;
}

/** Chance gate on top of a cooldown: pure (rng, lastMs, nowMs, cooldown, p). */
function shouldFire(rng, lastMs, nowMs, cooldownMs, fireChance) {
  if (nowMs - (lastMs || 0) < cooldownMs) return false;
  return rng() < fireChance;
}

// ============================================================================
// Death — data tier. Snapshot, journal, grieve, schedule, remove.
// ============================================================================

/**
 * Record a citizen's death. Snapshots everything the community will need
 * (the roster record is about to be removed), journals the loss, assigns
 * grief to the close circle, schedules the funeral, and removes the citizen
 * via the director's own cleanup path.
 * @returns the deceased record, or null if it failed.
 */
function recordDeath(director, record, cause, nowMs) {
  load();
  try {
    const username = record.username;
    const display = record.display || username;
    const legacy = legacyOf(username);
    const deceasedRec = {
      username: normalizeName(username),
      display,
      kingdomId: record.kingdomId,
      role: String(record.role || "citizen").toLowerCase(),
      age: ageOf(record),
      cause,
      diedAt: nowMs,
      legacy,
      home: record.home ? { x: record.home.x, y: record.home.y, z: record.home.z ?? 0 } : null,
      funeralAt: nowMs + FUNERAL_DELAY_MS,
      funeralHeld: false,
      funeralHeldAt: null,
      eulogist: null,
      mourners: [],
    };
    // The close circle, before the roster changes.
    const mourners = selectMourners(director, deceasedRec);
    deceasedRec.mourners = mourners;
    const closeSet = new Set(mourners.slice(0, 3));
    for (const m of mourners) {
      mourning.set(m, {
        deceased: deceasedRec.username,
        until: nowMs + (closeSet.has(m) ? MOURNING_CLOSE_MS : MOURNING_MS),
      });
      journalEvent(m, `Grieving ${display}, who ${cause}.`, "social");
    }
    // The town hears. Gossip will walk it along real social ties.
    journalEvent(display, `${cause}. The town mourns.`, "social");
    try {
      const mem = require("./CitizenMemory").getMemory();
      mem?.addGossip?.(deceasedRec.kingdomId, "death", `${display} ${cause}.`, nowMs);
    } catch {
      // Gossip is best-effort.
    }
    deceased.set(deceasedRec.username, deceasedRec);
    if (deceased.size > MAX_DECEASED) {
      const oldest = [...deceased.values()].sort((a, b) => a.diedAt - b.diedAt)[0];
      if (oldest) deceased.delete(oldest.username);
    }
    dirty = true;
    // Remove via the director's own cleanup (kinship, needs, chat, roster).
    try {
      director.removeCitizen?.(username);
    } catch {
      // If removal fails, the death is still recorded; next tick retries.
      return deceasedRec;
    }
    return deceasedRec;
  } catch {
    return null;
  }
}

/**
 * Advance funeral state data-tier: when a funeral comes due, hold it
 * (journaled, eulogist named, attendees recorded). The visible ceremony
 * fires separately on the proximity tick if a player is near.
 */
function advanceFunerals(nowMs) {
  load();
  for (const d of deceased.values()) {
    if (d.funeralHeld || d.funeralAt > nowMs) continue;
    d.funeralHeld = true;
    d.funeralHeldAt = nowMs;
    const eulogist = d.mourners[0] || null;
    d.eulogist = eulogist;
    journalEvent(
      d.display,
      `Laid to rest. ${eulogist ? `${eulogist} spoke the eulogy` : "The town gathered"}; ${d.mourners.length} mourners attended.`,
      "social"
    );
    for (const m of d.mourners) {
      journalEvent(m, `Attended ${d.display}'s funeral.`, "social");
    }
    dirty = true;
  }
}

/**
 * Anniversary remembrance: once a day at most per deceased, on monthly
 * anniversaries of the death, journal a remembrance so tavern stories
 * and the LLM can reference it.
 */
function advanceRemembrance(nowMs, rng) {
  load();
  const MONTH_MS = 30 * 24 * 3600 * 1000;
  for (const d of deceased.values()) {
    const months = Math.floor((nowMs - d.diedAt) / MONTH_MS);
    if (months < 1) continue;
    const last = lastRemembranceByDeceased.get(d.username) || 0;
    if (nowMs - last < REMEMBRANCE_COOLDOWN_MS) continue;
    // Fire near the anniversary day (within 2 days of the monthly mark).
    const anniversary = d.diedAt + months * MONTH_MS;
    if (Math.abs(nowMs - anniversary) > 2 * 24 * 3600 * 1000) continue;
    lastRemembranceByDeceased.set(d.username, nowMs);
    journalEvent(
      d.display,
      `${months === 1 ? "A month" : `${months} months`} since ${d.display} ${d.cause}. The town remembers.`,
      "social"
    );
    dirty = true;
  }
}

// ============================================================================
// tickMortality — slow tick (~60s). Data tier, zero LLM.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} rng - injectable rng (defaults to agentRng("funerals"))
 */
function tickMortality(director, nowMs, rng) {
  load();
  pruneCooldowns(nowMs);
  const r = rng || agentRng("funerals");
  try {
    // 1. Mortality rolls — collect first, mutate after (roster changes).
    const deaths = [];
    for (const record of director?.roster?.values?.() ?? []) {
      if (isDeceased(record.username)) continue;
      const p = mortalityChanceFor(record);
      if (chance(r, p)) {
        deaths.push({ record, cause: causeOfDeath(r, record) });
      }
    }
    for (const { record, cause } of deaths) {
      recordDeath(director, record, cause, nowMs);
    }
    // 2. Funerals come due.
    advanceFunerals(nowMs);
    // 3. Anniversaries.
    advanceRemembrance(nowMs, r);
  } catch (e) {
    console.warn("[citizen-funerals] mortality tick failed:", e?.message ?? e);
  }
}

// ============================================================================
// tickFuneralRites — proximity tick. Visible only near real players.
// ============================================================================

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

function forceChat(citizen, text) {
  try {
    citizen.forceChat?.(String(text).slice(0, 120));
  } catch {
    // Non-fatal.
  }
}

/**
 * The visible funeral ceremony: the eulogist and mourners gather at the
 * deceased's home and speak. Fires once per funeral, only while a real
 * player is near to witness. The data-tier funeral already happened;
 * this is the reenactment the player sees.
 */
function maybeHoldCeremony(director, d, nowMs, rng) {
  const last = lastCeremonyByDeceased.get(d.username) || 0;
  if (nowMs - last < 7 * 24 * 3600 * 1000) return false; // once per funeral
  if (!d.home) return false;
  // Need the eulogist (or any mourner) materialized near the home.
  const hostName = d.eulogist || d.mourners[0];
  if (!hostName) return false;
  const hostRecord = director.roster?.get?.(normalizeName(hostName));
  if (!hostRecord) return false;
  const host = (director.isOnline(hostRecord) ? director.getBot(hostRecord) : null) ?? director.getBot?.(hostRecord);
  if (!host) return false;
  if (!anyRealPlayerNear(director, host, CEREMONY_RADIUS)) return false;
  const hostDisplay = hostRecord.display || hostName;
  forceChat(host, eulogyFor(rng, d, hostDisplay));
  journalEvent(hostDisplay, `Spoke the eulogy at ${d.display}'s funeral.`, "social");
  // Mourners present murmur.
  let murmured = 0;
  for (const mName of d.mourners.slice(1, 4)) {
    const mRecord = director.roster?.get?.(normalizeName(mName));
    const mBot = mRecord ? (director.isOnline(mRecord) ? director.getBot(mRecord) : null) ?? director.getBot?.(mRecord) : null;
    if (mBot && withinTiles(host, mBot, CEREMONY_RADIUS)) {
      forceChat(mBot, griefLineFor(rng, d, true));
      murmured++;
    }
  }
  // A real player attended — thank them.
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (isRealPlayer(p) && withinTiles(host, p, CEREMONY_RADIUS)) {
        forceChat(host, thanksLineFor(rng, d));
        journalEvent(hostDisplay, `Thanked ${p.getUsername?.()} for attending ${d.display}'s funeral.`, "social");
        break;
      }
    }
  } catch {
    // Non-fatal.
  }
  lastCeremonyByDeceased.set(d.username, nowMs);
  dirty = true;
  return murmured >= 0;
}

/** Mourners near players occasionally voice their grief. */
function maybeGrieve(director, nowMs, rng, desync) {
  const desyncGate = desync ? require("./CitizenTimingDesync").isCitizenDue : null;
  for (const [username, m] of mourning) {
    if (m.until <= nowMs) continue;
    const record = director.roster?.get?.(username);
    if (!record) continue;
    // LOD brain gate: distant mourners voice grief less often (near-band
    // and unclassified citizens always due: unchanged).
    if (!brainTickDue(director, record, desync?.tick)) continue;
    if (desyncGate && !desyncGate(record, desync.tick, desync.spread)) continue;
    const last = lastGriefByCitizen.get(username) || 0;
    if (!shouldFire(rng, last, nowMs, GRIEF_COOLDOWN_MS, 0.4)) continue;
    const citizen = (director.isOnline(record) ? director.getBot(record) : null) ?? director.getBot?.(record);
    if (!citizen) continue;
    if (!anyRealPlayerNear(director, citizen, GRIEF_RADIUS)) continue;
    const d = deceased.get(normalizeName(m.deceased));
    if (!d) continue;
    const close = m.until - nowMs > MOURNING_MS; // close circle grieves longer
    forceChat(citizen, griefLineFor(rng, d, close));
    lastGriefByCitizen.set(username, nowMs);
  }
}

/** Citizens visit the memorial (the town square) to pay respects. */
function maybeVisitMemorial(director, nowMs, rng, desync) {
  const desyncGate = desync ? require("./CitizenTimingDesync").isCitizenDue : null;
  // The most recent dead per kingdom is "the memorial" focus.
  const latestByKingdom = new Map();
  for (const d of deceased.values()) {
    const cur = latestByKingdom.get(d.kingdomId);
    if (!cur || d.diedAt > cur.diedAt) latestByKingdom.set(d.kingdomId, d);
  }
  for (const record of director?.roster?.values?.() ?? []) {
    // LOD brain gate: distant citizens visit the memorial less often
    // (near-band and unclassified always due: unchanged).
    if (!brainTickDue(director, record, desync?.tick)) continue;
    if (desyncGate && !desyncGate(record, desync.tick, desync.spread)) continue;
    const last = lastMemorialByCitizen.get(record.username) || 0;
    if (!shouldFire(rng, last, nowMs, MEMORIAL_COOLDOWN_MS, 0.25)) continue;
    const d = latestByKingdom.get(record.kingdomId);
    if (!d) continue;
    const citizen = (director.isOnline(record) ? director.getBot(record) : null) ?? director.getBot?.(record);
    if (!citizen) continue;
    if (!anyRealPlayerNear(director, citizen, MEMORIAL_RADIUS)) continue;
    forceChat(citizen, memorialLineFor(rng, d));
    journalEvent(record.display || record.username, `Paid respects to ${d.display} at the memorial.`, "social");
    lastMemorialByCitizen.set(record.username, nowMs);
  }
}

/** Tavern remembrance: stories about the dead, on anniversaries. */
function maybeRemember(director, nowMs, rng, desync) {
  const desyncGate = desync ? require("./CitizenTimingDesync").isCitizenDue : null;
  for (const record of director?.roster?.values?.() ?? []) {
    // LOD brain gate: distant citizens share remembrances less often
    // (near-band and unclassified always due: unchanged).
    if (!brainTickDue(director, record, desync?.tick)) continue;
    if (desyncGate && !desyncGate(record, desync.tick, desync.spread)) continue;
    const d = [...deceased.values()].find(
      (x) => x.kingdomId === record.kingdomId && nowMs - x.diedAt > 30 * 24 * 3600 * 1000
    );
    if (!d) continue;
    const last = lastRemembranceByDeceased.get(d.username) || 0;
    if (!shouldFire(rng, last, nowMs, REMEMBRANCE_COOLDOWN_MS, 0.3)) continue;
    const citizen = (director.isOnline(record) ? director.getBot(record) : null) ?? director.getBot?.(record);
    if (!citizen) continue;
    if (!anyRealPlayerNear(director, citizen, GRIEF_RADIUS)) continue;
    forceChat(citizen, remembranceLineFor(rng, d));
    lastRemembranceByDeceased.set(d.username, nowMs);
  }
}

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} desync - { tick, spread } from the director (optional)
 * @param {function} rng - injectable rng
 */
function tickFuneralRites(director, nowMs, desync, rng) {
  load();
  pruneCooldowns(nowMs);
  const r = rng || agentRng("funerals");
  try {
    for (const d of deceased.values()) {
      if (!d.funeralHeld) continue;
      maybeHoldCeremony(director, d, nowMs, r);
    }
  } catch (e) {
    console.warn("[citizen-funerals] ceremony failed:", e?.message ?? e);
  }
  try {
    maybeGrieve(director, nowMs, r, desync);
  } catch (e) {
    console.warn("[citizen-funerals] grief failed:", e?.message ?? e);
  }
  try {
    maybeVisitMemorial(director, nowMs, r, desync);
  } catch (e) {
    console.warn("[citizen-funerals] memorial failed:", e?.message ?? e);
  }
  try {
    maybeRemember(director, nowMs, r, desync);
  } catch (e) {
    console.warn("[citizen-funerals] remembrance failed:", e?.message ?? e);
  }
}

// ============================================================================
// Public API
// ============================================================================

/** True if this username is recorded as deceased. */
function isDeceased(username) {
  load();
  return deceased.has(normalizeName(username));
}

/** All deceased records, newest first. For the newspaper obituaries. */
function getDeceased() {
  load();
  return [...deceased.values()].sort((a, b) => b.diedAt - a.diedAt);
}

/** Mourning info for a citizen, or null. */
function griefOf(username, nowMs) {
  const m = mourning.get(normalizeName(username));
  if (!m || m.until <= (nowMs ?? Date.now())) return null;
  return m;
}

module.exports = {
  tickMortality,
  tickFuneralRites,
  recordDeath,
  isDeceased,
  isMourning,
  getDeceased,
  griefOf,
  saveIfDirty,
  resetForTests,
  // Pure helpers for tests:
  mortalityChanceFor,
  causeOfDeath,
  eulogyFor,
  griefLineFor,
  memorialLineFor,
  remembranceLineFor,
  thanksLineFor,
  selectMourners,
  shouldFire,
  isRealPlayer,
  withinTiles,
  pickOne,
  ageOf,
};
