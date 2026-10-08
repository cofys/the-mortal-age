"use strict";

/**
 * CitizenHealers — doctors, herbalists, surgeons, and midwives who treat the
 * sick and injured.
 *
 * WHAT IT DOES (data tier, free — runs with zero players online):
 *   - Citizens fall ill or get injured over time (tiny per-tick chance);
 *     minor ailments clear on their own after ~45 minutes.
 *   - Rare plague outbreaks strike a kingdom: several citizens fall ill at
 *     once, plague never self-clears, and only healer treatment ends it.
 *   - Midwives occasionally assist at births (rare, data-tier event).
 *   - All of it is journaled, so the foreground LLM answers "what have you
 *     been up to?" truthfully and gossip spreads word of plagues.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   - Healers keep a practice at the town square. When a patient is near,
 *     the healer walks over, plays a working animation, and emits an
 *     emote-style line ("*treats Mira's fever*").
 *   - Herbalists visibly gather and brew remedies on a loop.
 *   - A healer offers treatment to a hurt-looking player who lingers nearby.
 *   - Midwives announce deliveries ("*delivers a healthy baby!*").
 *
 * Zero LLM: every visible line comes from scripted pools below. The LLM
 * only ever reads the journals this module writes.
 *
 * Healer designation is deterministic: FNV-1a(username) % 25 === 0 makes a
 * citizen a healer (~4% of the roster), excluding guards. Specialty is a
 * further hash pick among doctor / herbalist / surgeon / midwife. Stable
 * across restarts, no storage, no config.
 *
 * Deliberately NOT player-HP manipulation: the engine exposes no verified
 * heal API to plugins, so treatment of real players is a scripted ritual
 * (approach + animation + emote + journal), never a guessed method call.
 * A future verified mechanic can hook into treatPlayer().
 *
 * Wiring: CitizenDirector.tickProximity() calls tickHealers(this, nowMs) on
 * the fast (~10s) visible-life tick, after the shopkeeping layer.
 * Per-citizen try/catch: one bad bot never breaks the tick.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { normalizeName } = require("./CitizenBonds");

// === Tuning: all magic numbers here ==========================================

const HEALER_MODULO = 25; // hash % 25 === 0 -> healer (~4% of roster)
const SPECIALTIES = Object.freeze(["doctor", "herbalist", "surgeon", "midwife"]);

const SICK_CHANCE = 0.0001; // per citizen per fast tick (~1 new case / 10 min / 170 citizens)
const INJURED_CHANCE = 0.00005; // accidents are rarer than illness
const BIRTH_CHANCE = 0.00002; // very rare
const RECOVERY_MS = 45 * 60 * 1000; // minor ailments clear on their own
const PLAGUE_SPREAD_CHANCE = 0.002; // per plague patient per tick: infect a housemate
const PLAGUE_COOLDOWN_MS = 3 * 24 * 3600 * 1000; // per kingdom
const PLAGUE_MIN_PATIENTS = 3;
const PLAGUE_MAX_PATIENTS = 6;

const TREAT_RADIUS = 12; // healer treats patients this close
const TREATMENT_MS = 25 * 1000; // one treatment takes ~25s
const TREAT_ANIM = 885; // crafting hands — verified in server/plugins/skills (mixing remedies, bandaging)
const PROXIMITY_TILES = 40; // a real player must be this close for visible work
const HEALER_IDLE_COOLDOWN_MS = 5 * 60 * 1000; // per healer between patient hunts

const GATHER_INTERVAL_MS = 8 * 60 * 1000; // herbalist remedy-brewing loop
const GATHER_DURATION_MS = 30 * 1000;
const GATHER_ANIM = 885;

const PLAYER_OFFER_RADIUS = 6; // hurt-looking player this close gets an offer
const PLAYER_OFFER_COOLDOWN_MS = 5 * 60 * 1000; // per player, so loiterers aren't spammed

// Clinic spots: town square + per-specialty offset so healers don't stack.
const CLINIC_OFFSETS = Object.freeze([
  [0, 0], // doctor: center
  [3, 1], // herbalist: herb garden corner
  [-3, 1], // surgeon: surgery tent
  [1, -3], // midwife: birthing hut
]);

// === Scripted lines (data tier — the LLM never writes these) =================

const TREAT_EMOTES = Object.freeze({
  doctor: Object.freeze([
    "*treats {patient}'s fever*",
    "*cools {patient}'s brow with a damp cloth*",
    "*administers a bitter tonic to {patient}*",
  ]),
  herbalist: Object.freeze([
    "*brews a remedy for {patient}*",
    "*applies a poultice to {patient}*",
    "*grinds herbs for {patient}'s cough*",
  ]),
  surgeon: Object.freeze([
    "*bandages {patient}'s wound*",
    "*stitches {patient}'s cut*",
    "*sets {patient}'s splint*",
  ]),
  midwife: Object.freeze([
    "*tends to {patient}*",
    "*wraps {patient} warmly*",
    "*checks {patient}'s breathing*",
  ]),
  plague: Object.freeze([
    "*quarantines {patient}*",
    "*burns cleansing herbs near {patient}*",
    "*treats {patient}'s plague sores*",
  ]),
});

const GATHER_EMOTES = Object.freeze([
  "*gathers healing herbs*",
  "*brews a batch of remedies*",
  "*dries medicinal herbs*",
]);

const PLAYER_OFFERS = Object.freeze([
  "You look hurt, friend. Let me see to that.",
  "Come here — I've got something for that.",
  "Sit down a moment. I'll patch you up.",
]);

const PLAYER_TREAT_EMOTES = Object.freeze([
  "*treats your wounds*",
  "*applies a soothing salve*",
  "*bandages you up*",
]);

const BIRTH_ANNOUNCE = "*delivers a healthy baby!*";

// === State (in-memory; journals are what persist) =============================

const ailments = new Map(); // normalized patient name -> { kind, since, kingdomId }
const activeTreatments = new Map(); // normalized healer name -> { patientName, kind, startedAt, tile }
const lastGatherAt = new Map(); // normalized herbalist name -> ms
const lastOfferAt = new Map(); // "healer>player" -> ms
const lastHuntAt = new Map(); // normalized healer name -> ms
const outbreaks = new Map(); // kingdomId -> { startedAt, patientNames: Set }
const lastOutbreakAt = new Map(); // kingdomId -> ms (cooldown)

let lastPruneAt = 0;

/** Memory-leak plug: prune stale maps hourly. */
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  for (const [k, t] of activeTreatments) {
    if (nowMs - t.startedAt > TREATMENT_MS + 10 * 60 * 1000) activeTreatments.delete(k);
  }
  for (const [k, ms] of lastGatherAt) {
    if (nowMs - ms > 24 * 3600 * 1000) lastGatherAt.delete(k);
  }
  for (const [k, ms] of lastOfferAt) {
    if (nowMs - ms > 24 * 3600 * 1000) lastOfferAt.delete(k);
  }
  for (const [k, ms] of lastHuntAt) {
    if (nowMs - ms > 24 * 3600 * 1000) lastHuntAt.delete(k);
  }
}

// === Pure helpers =============================================================

/** FNV-1a, same as CitizenTimingDesync — deterministic per username. */
function hashUsername(username) {
  const s = String(username ?? "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** ~4% of citizens are healers, deterministically. Guards are too busy. */
function isHealer(record) {
  if (!record || !record.username) return false;
  if (record.role === "guard") return false;
  return hashUsername(record.username) % HEALER_MODULO === 0;
}

/** Which kind of healer: doctor | herbalist | surgeon | midwife. */
function healerSpecialty(record) {
  if (!isHealer(record)) return null;
  const h = hashUsername(record.username);
  return SPECIALTIES[Math.floor(h / HEALER_MODULO) % SPECIALTIES.length];
}

/** Can this specialty treat this ailment kind? */
function specialtyTreats(specialty, ailmentKind) {
  if (ailmentKind === "plague") return true; // all hands during an outbreak
  switch (specialty) {
    case "doctor":
      return ailmentKind === "sick";
    case "surgeon":
      return ailmentKind === "injured";
    case "herbalist":
      return ailmentKind === "sick";
    case "midwife":
      return ailmentKind === "sick"; // backup care
    default:
      return false;
  }
}

/** The clinic tile for a healer: town square + specialty offset. */
function clinicTile(kingdomId, specialty) {
  try {
    const square = siteTileByKingdom(kingdomId, "square");
    if (!square) return null;
    const idx = SPECIALTIES.indexOf(specialty);
    const off = CLINIC_OFFSETS[idx < 0 ? 0 : idx];
    return { x: square.x + off[0], y: square.y + off[1], z: square.z ?? 0 };
  } catch {
    return null;
  }
}

/** Pick a treatment emote for this specialty/kind, filling {patient}. */
function treatEmote(rng, specialty, ailmentKind, patientName) {
  const pool = ailmentKind === "plague" ? TREAT_EMOTES.plague : TREAT_EMOTES[specialty] ?? TREAT_EMOTES.doctor;
  const line = pool[Math.floor(rng() * pool.length)];
  return line.replace("{patient}", patientName);
}

// === Bot helpers (same shapes as CitizenShopkeeping) ==========================

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function isMoving(bot) {
  try {
    if (bot.getForceMovement?.() != null) return true;
    return (bot.getMovementQueue?.()?.size?.() ?? 0) > 0;
  } catch {
    return false;
  }
}

function faceToward(bot, targetTile) {
  try {
    if (!targetTile) return false;
    bot.face?.(targetTile.x, targetTile.y);
    return true;
  } catch {
    return false;
  }
}

function playAnim(director, bot, animId) {
  if (animId == null) return true;
  try {
    const Anim = director?.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(animId));
    return true;
  } catch {
    return false;
  }
}

function makeLocation(director, x, y, z) {
  try {
    const Loc = director?.api?.core?.Location;
    if (Loc) return new Loc(x, y, z ?? 0);
  } catch {
    // Non-fatal.
  }
  return null;
}

function walkTo(director, bot, tile) {
  try {
    const loc = makeLocation(director, tile.x, tile.y, tile.z);
    if (!loc) return false;
    bot.moveTo?.(loc);
    return true;
  } catch {
    return false;
  }
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me) return out;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || p?.isPlayerBot?.() === true) continue;
      if (chebyshev(me, botTile(p)) <= tiles) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function journalEvent(citizenName, text) {
  try {
    getJournal().log(citizenName, "health", text);
  } catch {
    // Non-fatal.
  }
}

// === Data tier: ailment simulation (runs with zero players online) ============

/**
 * Roll for new illness/injury across the whole roster. Data tier: no player
 * needs to be near, no bot needs to be materialized. Cheap: one rng per
 * citizen, cheapest-first (healers never fall ill on duty — flavor).
 */
function tickAilmentSim(director, nowMs) {
  if (!director?.roster) return;
  const rng = agentRng(`healers:ail:${Math.floor(nowMs / 60000)}`);
  for (const record of director.roster.values()) {
    try {
      const name = normalizeName(record.username);
      if (!name || ailments.has(name) || isHealer(record)) continue;
      const roll = rng();
      if (roll < INJURED_CHANCE) {
        ailments.set(name, { kind: "injured", since: nowMs, kingdomId: record.kingdomId ?? "unknown" });
        journalEvent(record.username, "Was injured in an accident.");
      } else if (roll < INJURED_CHANCE + SICK_CHANCE) {
        ailments.set(name, { kind: "sick", since: nowMs, kingdomId: record.kingdomId ?? "unknown" });
        journalEvent(record.username, "Came down with a fever.");
      }
    } catch {
      // One bad record never breaks the sim.
    }
  }
  // Natural recovery: minor ailments clear on their own. Plague does not.
  for (const [name, a] of ailments) {
    if (a.kind !== "plague" && nowMs - a.since > RECOVERY_MS) {
      ailments.delete(name);
    }
  }
}

/** Plague spreads between nearby patients (data tier). */
function tickPlagueSpread(director, nowMs) {
  if (outbreaks.size === 0) return;
  const rng = agentRng(`healers:spread:${Math.floor(nowMs / 60000)}`);
  for (const [kingdomId, outbreak] of outbreaks) {
    for (const patientName of [...outbreak.patientNames]) {
      if (!chance(rng, PLAGUE_SPREAD_CHANCE)) continue;
      // Infect a random roster-mate from the same kingdom.
      const candidates = [];
      try {
        for (const record of director.roster.values()) {
          const n = normalizeName(record.username);
          if (!n || ailments.has(n) || isHealer(record)) continue;
          if ((record.kingdomId ?? "unknown") === kingdomId) candidates.push(record);
        }
      } catch {
        continue;
      }
      if (candidates.length === 0) continue;
      const victim = candidates[Math.floor(rng() * candidates.length)];
      const vName = normalizeName(victim.username);
      ailments.set(vName, { kind: "plague", since: nowMs, kingdomId });
      outbreak.patientNames.add(vName);
      journalEvent(victim.username, "Caught the plague.");
    }
  }
}

/** Rare outbreak ignition, per kingdom with a long cooldown. */
function maybeStartOutbreak(director, nowMs) {
  const rng = agentRng(`healers:outbreak:${Math.floor(nowMs / 3600000)}`);
  // ~1 outbreak per kingdom per ~2 weeks of continuous ticks at this rate.
  if (!chance(rng, 0.00003)) return null;
  let kingdoms = [];
  try {
    const seen = new Set();
    for (const record of director.roster.values()) {
      const k = record.kingdomId ?? "unknown";
      if (seen.has(k) || outbreaks.has(k)) continue;
      if (nowMs - (lastOutbreakAt.get(k) ?? 0) < PLAGUE_COOLDOWN_MS) continue;
      seen.add(k);
      kingdoms.push(k);
    }
  } catch {
    return null;
  }
  if (kingdoms.length === 0) return null;
  const kingdomId = kingdoms[Math.floor(rng() * kingdoms.length)];
  const pool = [];
  try {
    for (const record of director.roster.values()) {
      const n = normalizeName(record.username);
      if (!n || ailments.has(n) || isHealer(record)) continue;
      if ((record.kingdomId ?? "unknown") === kingdomId) pool.push(record);
    }
  } catch {
    return null;
  }
  if (pool.length < PLAGUE_MIN_PATIENTS) return null;
  const count = Math.min(pool.length, PLAGUE_MIN_PATIENTS + Math.floor(rng() * (PLAGUE_MAX_PATIENTS - PLAGUE_MIN_PATIENTS + 1)));
  const patientNames = new Set();
  for (let i = 0; i < count; i++) {
    const pick = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    const n = normalizeName(pick.username);
    ailments.set(n, { kind: "plague", since: nowMs, kingdomId });
    patientNames.add(n);
    journalEvent(pick.username, "Caught the plague.");
  }
  outbreaks.set(kingdomId, { startedAt: nowMs, patientNames });
  lastOutbreakAt.set(kingdomId, nowMs);
  return kingdomId;
}

/** An outbreak ends when every plague patient in the kingdom is cured. */
function tickOutbreakContainment(nowMs) {
  for (const [kingdomId, outbreak] of outbreaks) {
    let remaining = 0;
    for (const name of outbreak.patientNames) {
      if (ailments.get(name)?.kind === "plague") remaining++;
    }
    if (remaining === 0) {
      outbreaks.delete(kingdomId);
      // Journal it on a random healer of that kingdom so the news has a mouth.
      journalEvent(`plague-${kingdomId}`, `The plague in ${kingdomId} has passed.`);
    }
  }
}

/** Rare births; a midwife assists if one is materialized nearby. */
function tickBirths(director, nowMs) {
  if (!director?.roster) return;
  const rng = agentRng(`healers:birth:${Math.floor(nowMs / 60000)}`);
  for (const record of director.roster.values()) {
    try {
      if (!chance(rng, BIRTH_CHANCE)) continue;
      const name = normalizeName(record.username);
      if (!name || isHealer(record)) continue;
      // Find a materialized midwife in the same kingdom to assist.
      let midwife = null;
      for (const r2 of director.roster.values()) {
        if (healerSpecialty(r2) !== "midwife") continue;
        if ((r2.kingdomId ?? "unknown") !== (record.kingdomId ?? "unknown")) continue;
        const bot = director.getBot?.(r2);
        if (bot) {
          midwife = { record: r2, bot };
          break;
        }
      }
      if (midwife) {
        const rng2 = agentRng(`healers:delivery:${name}:${Math.floor(nowMs / 60000)}`);
        void rng2;
        try {
          midwife.bot.forceChat?.(BIRTH_ANNOUNCE);
        } catch {
          // Cosmetic.
        }
        journalEvent(midwife.record.username, `Delivered ${record.username}'s baby.`);
        journalEvent(record.username, `Gave birth to a healthy baby, delivered by ${midwife.record.username}.`);
      } else {
        journalEvent(record.username, "Gave birth to a healthy baby.");
      }
      return; // at most one birth per tick — they're rare enough
    } catch {
      // Non-fatal.
    }
  }
}

// === Interaction tier: visible treatment =======================================

/**
 * Nearest treatable patient within TREAT_RADIUS of the healer bot.
 * Returns { name, ailment } or null.
 */
function nearestPatient(director, record, bot, specialty) {
  const me = botTile(bot);
  if (!me) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [name, ailment] of ailments) {
    if (!specialtyTreats(specialty, ailment.kind)) continue;
    let patientBot = null;
    try {
      // Find the patient's materialized bot via roster lookup.
      for (const r of director.roster.values()) {
        if (normalizeName(r.username) === name) {
          patientBot = director.getBot?.(r);
          break;
        }
      }
    } catch {
      continue;
    }
    if (!patientBot) continue; // patient not materialized — nothing visible to do
    const pt = botTile(patientBot);
    const d = chebyshev(me, pt);
    if (d <= TREAT_RADIUS && d < bestDist) {
      best = { name, ailment, tile: pt };
      bestDist = d;
    }
  }
  return best;
}

function startTreatment(director, record, bot, specialty, patient, nowMs) {
  const healerName = normalizeName(record.username);
  const rng = agentRng(`healers:treat:${healerName}:${Math.floor(nowMs / 60000)}`);
  activeTreatments.set(healerName, {
    patientName: patient.name,
    kind: patient.ailment.kind,
    startedAt: nowMs,
    tile: patient.tile,
  });
  walkTo(director, bot, patient.tile);
  faceToward(bot, patient.tile);
  playAnim(director, bot, TREAT_ANIM);
  try {
    bot.forceChat?.(treatEmote(rng, specialty, patient.ailment.kind, patient.name));
  } catch {
    // Cosmetic.
  }
  journalEvent(record.username, `Began treating ${patient.name}'s ${patient.ailment.kind}.`);
}

function finishTreatment(director, record, nowMs) {
  const healerName = normalizeName(record.username);
  const t = activeTreatments.get(healerName);
  if (!t) return;
  activeTreatments.delete(healerName);
  const wasPlague = t.kind === "plague";
  ailments.delete(t.patientName);
  journalEvent(record.username, `Cured ${t.patientName}'s ${t.kind}.`);
  journalEvent(t.patientName, `Was cured of ${t.kind} by ${record.username}.`);
  // Return to the clinic.
  const specialty = healerSpecialty(record);
  const clinic = clinicTile(record.kingdomId ?? "unknown", specialty);
  const bot = director.getBot?.(record);
  if (bot && clinic) {
    const me = botTile(bot);
    if (!me || chebyshev(me, clinic) > 1) walkTo(director, bot, clinic);
  }
  void wasPlague;
  void nowMs;
}

/** Continue an in-progress treatment: re-face, re-play anim, finish on time. */
function tickActiveTreatment(director, record, bot, nowMs) {
  const healerName = normalizeName(record.username);
  const t = activeTreatments.get(healerName);
  if (!t) return false;
  if (nowMs - t.startedAt >= TREATMENT_MS) {
    finishTreatment(director, record, nowMs);
    return true;
  }
  if (isMoving(bot)) return true; // still walking to the patient
  faceToward(bot, t.tile);
  playAnim(director, bot, TREAT_ANIM);
  return true;
}

/** Herbalist remedy-brewing loop at the clinic. */
function tickGather(director, record, bot, nowMs) {
  if (healerSpecialty(record) !== "herbalist") return;
  const name = normalizeName(record.username);
  if (nowMs - (lastGatherAt.get(name) ?? 0) < GATHER_INTERVAL_MS) return;
  if (isMoving(bot)) return;
  const rng = agentRng(`healers:gather:${name}:${Math.floor(nowMs / 60000)}`);
  const clinic = clinicTile(record.kingdomId ?? "unknown", "herbalist");
  if (clinic) {
    const spot = { x: clinic.x + 1, y: clinic.y + 1, z: clinic.z };
    const me = botTile(bot);
    if (!me || chebyshev(me, spot) > 1) walkTo(director, bot, spot);
    faceToward(bot, spot);
  }
  playAnim(director, bot, GATHER_ANIM);
  try {
    bot.forceChat?.(GATHER_EMOTES[Math.floor(rng() * GATHER_EMOTES.length)]);
  } catch {
    // Cosmetic.
  }
  journalEvent(record.username, "Brewed a batch of remedies.");
  lastGatherAt.set(name, nowMs);
}

/**
 * Offer treatment to a lingering real player. Scripted ritual only — no
 * engine HP API exists for plugins to call safely, so this is approach +
 * animation + emote + journal, never a guessed method.
 */
function tickPlayerOffer(director, record, bot, nowMs) {
  const healerName = normalizeName(record.username);
  const players = realPlayersWithin(bot, PLAYER_OFFER_RADIUS);
  if (players.length === 0) return;
  const player = players[0];
  let playerName = "traveler";
  try {
    playerName = player.getUsername?.() ?? playerName;
  } catch {
    // Non-fatal.
  }
  const key = `${healerName}>${String(playerName).toLowerCase()}`;
  if (nowMs - (lastOfferAt.get(key) ?? 0) < PLAYER_OFFER_COOLDOWN_MS) return;
  const rng = agentRng(`healers:offer:${key}:${Math.floor(nowMs / 60000)}`);
  faceToward(bot, botTile(player));
  playAnim(director, bot, TREAT_ANIM);
  try {
    bot.forceChat?.(PLAYER_OFFERS[Math.floor(rng() * PLAYER_OFFERS.length)]);
  } catch {
    // Cosmetic.
  }
  // A beat later the ritual completes — same tick is fine for scripted flavor.
  try {
    bot.forceChat?.(PLAYER_TREAT_EMOTES[Math.floor(rng() * PLAYER_TREAT_EMOTES.length)]);
  } catch {
    // Cosmetic.
  }
  journalEvent(record.username, `Treated a traveler's wounds.`);
  lastOfferAt.set(key, nowMs);
}

/** One healer's visible tick: treatment, gathering, or player offer. */
function tickCitizenHealer(director, record, bot, nowMs) {
  const specialty = healerSpecialty(record);
  if (!specialty) return;

  // Finish or continue an in-progress treatment first.
  if (tickActiveTreatment(director, record, bot, nowMs)) return;
  if (isMoving(bot)) return;

  // Patients first.
  const name = normalizeName(record.username);
  if (nowMs - (lastHuntAt.get(name) ?? 0) >= HEALER_IDLE_COOLDOWN_MS) {
    const patient = nearestPatient(director, record, bot, specialty);
    if (patient) {
      lastHuntAt.set(name, nowMs);
      startTreatment(director, record, bot, specialty, patient, nowMs);
      return;
    }
  }

  // Herbalists brew between patients.
  tickGather(director, record, bot, nowMs);

  // Then check for hurt-looking players nearby.
  tickPlayerOffer(director, record, bot, nowMs);
}

/**
 * Healer eligibility for visible work: designated healer, materialized,
 * not mid-treatment, not claimed by skilling sessions.
 */
function eligibleHealer(record, director) {
  if (!isHealer(record)) return false;
  const name = normalizeName(record.username);
  if (!name) return false;
  if (!director?.isOnline?.(record)) return false;
  if (activeTreatments.has(name)) return false;
  try {
    const sk = require("./CitizenSkilling");
    const sessions = sk._sessions;
    if (sessions?.has(name)) return false;
  } catch {
    // Non-fatal.
  }
  return true;
}

// === Main tick =================================================================

/**
 * Fast-tick entry. Called from CitizenDirector.tickProximity() (~10s),
 * after the shopkeeping layer.
 *
 * Data tier first (ailment sim, plague, births — free, always runs), then
 * the interaction tier (visible treatment — only while a real player is
 * within PROXIMITY_TILES of the healer).
 */
function tickHealers(director, nowMs = Date.now()) {
  if (!director?.roster) return;
  pruneState(nowMs);
  try {
    tickAilmentSim(director, nowMs);
  } catch {
    // Non-fatal.
  }
  try {
    tickPlagueSpread(director, nowMs);
  } catch {
    // Non-fatal.
  }
  try {
    maybeStartOutbreak(director, nowMs);
  } catch {
    // Non-fatal.
  }
  try {
    tickOutbreakContainment(nowMs);
  } catch {
    // Non-fatal.
  }
  try {
    tickBirths(director, nowMs);
  } catch {
    // Non-fatal.
  }
  // Interaction tier: visible healing work.
  for (const record of director.roster.values()) {
    try {
      if (!eligibleHealer(record, director)) continue;
      const bot = director.getBot(record);
      if (!bot) continue;
      if (realPlayersWithin(bot, PROXIMITY_TILES).length === 0) continue;
      tickCitizenHealer(director, record, bot, nowMs);
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
}

module.exports = {
  // tuning
  HEALER_MODULO,
  SPECIALTIES,
  SICK_CHANCE,
  INJURED_CHANCE,
  BIRTH_CHANCE,
  RECOVERY_MS,
  PLAGUE_COOLDOWN_MS,
  TREAT_RADIUS,
  TREATMENT_MS,
  PROXIMITY_TILES,
  PLAYER_OFFER_RADIUS,
  PLAYER_OFFER_COOLDOWN_MS,
  // data
  TREAT_EMOTES,
  GATHER_EMOTES,
  PLAYER_OFFERS,
  CLINIC_OFFSETS,
  BIRTH_ANNOUNCE,
  // pure/testable
  hashUsername,
  isHealer,
  healerSpecialty,
  specialtyTreats,
  clinicTile,
  treatEmote,
  eligibleHealer,
  // lifecycle
  tickHealers,
  startTreatment,
  finishTreatment,
  // seams (tests)
  _ailments: ailments,
  _activeTreatments: activeTreatments,
  _outbreaks: outbreaks,
  _lastOutbreakAt: lastOutbreakAt,
};
