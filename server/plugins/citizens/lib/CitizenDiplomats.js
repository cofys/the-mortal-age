"use strict";

/**
 * CitizenDiplomats — envoys who travel between kingdoms, negotiate treaties,
 * and manage international relations.
 *
 * WHAT IT DOES (data tier, free, slow ~60s director tick):
 *   Each kingdom keeps up to 2 courtier-diplomats. Diplomats run missions
 *   through a phase machine: idle -> departing -> traveling -> negotiating
 *   -> returning -> debrief -> idle. Envoys carry trade and culture missions;
 *   negotiators work peace treaties and alliance proposals on hot borders.
 *   A diplomat who succeeds is stationed abroad as ambassador for a term,
 *   running cultural exchange from the foreign court.
 *   Mission resolution rolls a personality-weighted success chance. Peace
 *   successes ease real tension (KingdomStore); failures spike it through
 *   Tension.addTension — a failed negotiation is a genuine international
 *   incident. Outcomes are journaled (the free news source for gossip and
 *   the LLM mouth) and notable ones announced as kingdom:rumor.
 *
 * WHAT THE PLAYER SEES (interaction tier, fast proximity tick, real players):
 *   Departure and return announcements at the home court anchor, and escort
 *   invitations: a departing envoy asks nearby real players to ride escort
 *   (chat "yes"/"no", same keyword path as caravan invites). Player escorts
 *   earn a wage when the mission succeeds. Diplomats abroad surface through
 *   foreign-court rumors, not fake entities.
 *
 * Zero LLM: all lines are scripted pools; the journal carries the story for
 * the LLM to riff on later. Tension effects use the public KingdomStore /
 * Tension mutators only, wrapped in try/catch.
 *
 * Wiring: tickDiplomacy on the slow director tick next to caravans;
 * tickDiplomatShouts on the fast proximity tick next to caravan shouts.
 * Plain-node testable: CitizenDiplomats.test.js.
 *
 * DIPLOMATS2 RUNG (2026-10-08):
 *   - Envoy arrival ceremonies: when a mission reaches the foreign court,
 *     a materialized courtier at the TARGET court anchor heralds the envoy —
 *     LOD-gated (only when real players are near that anchor; simulated
 *     data tier carries the story otherwise, zero LLM).
 *   - Ambassador chatter: stationed ambassadors surface through hourly,
 *     budget-capped (2 lines) ceremony/cultural-exchange chatter at the
 *     foreign court anchor, only near real players.
 *   - Real rumor seeding: arrivals/treaties/collapses now ALSO seed the
 *     real CitizenRumors ledger (seedRumor(rng, event) with a real event —
 *     lineage and distortion, not console-only), alongside the street-talk
 *     kingdom:rumor custom event. Journal already used the real log().
 *   - Ledger acks: a nearby real player holding an unanswered escort
 *     invite gets a scripted in-world acknowledgment before routine flavor
 *     (mentors2/historians2 lesson: real requests get real answers).
 *   - Non-overlapping claim: isDiplomat(username) wires the REAL
 *     judge-claim predicate (CitizenJudges.isJudge) — a judge-claimed
 *     courtier is never also a diplomat. One citizen, one public office.
 */

const { getJournal } = require("./CitizenJournal");
const { normalizeName, sendInvite, getInvites, resolveInvite } = require("./CitizenBonds");
const { KINGDOM_IDS, siteTileByKingdom } = require("../brain/CitizenSites");
const { ROLE_COURTIER } = require("../constants");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// Kingdoms plugin is optional at require time (plain-node tests run without
// it); all live calls are guarded.
let KingdomStore = null;
let Tension = null;
try {
  KingdomStore = require("../../kingdoms/KingdomStore");
} catch {
  KingdomStore = null;
}
try {
  Tension = require("../../kingdoms/Tension.Kingdoms");
} catch {
  Tension = null;
}

// The judges tier's REAL claim predicate. A judge-claimed courtier is never
// also a diplomat — the non-overlapping claim lives here, not re-invented.
let Judges = null;
try {
  Judges = require("./CitizenJudges");
} catch {
  Judges = null;
}

// === Tuning: all magic numbers here ===
const MAX_DIPLOMATS_PER_KINGDOM = 2;
const MISSION_CADENCE_CHANCE = 0.06; // per idle kingdom per slow (~60s) tick
const DEPARTING_MS = 10 * 60 * 1000;
const JOURNEY_MS = 2 * 60 * 60 * 1000; // abstracted travel, each way
const NEGOTIATE_MS = 30 * 60 * 1000;
const DEBRIEF_MS = 15 * 60 * 1000;
const AMBASSADOR_TERM_MS = 12 * 60 * 60 * 1000;
const SHOUT_RADIUS = 12; // tiles — court anchor earshot
const ESCORT_WAGE = 250;
const MAX_PLAYER_ESCORTS = 2;
const COINS = 995;
const INVITE_KIND_ESCORT = "diplomat_escort";

// === Diplomats2 tuning ===
const CEREMONY_BUDGET = 2; // max spoken lines per mission per interaction tick
const AMBASSADOR_COOLDOWN_MS = 60 * 60 * 1000; // ambassador chatter at most hourly
const ESCORT_ACK_COOLDOWN_MS = 15 * 60 * 1000; // invite acks at most every 15 min
const LINE_MAX = 120; // filled dialogue lines are cut to engine chat length

const ARRIVAL_LINES = Object.freeze([
  "Make way! The envoy of {home} has arrived at the court of {target}.",
  "The court of {target} receives {name}, envoy of {home}, bearing a {mission}.",
  "Trumpets for the envoy of {home}! {name} seeks audience at {target}.",
]);

const AMBASSADOR_LINES = Object.freeze([
  "The {home} ambassador {name} shared songs of {home} at the {target} court today.",
  "{name} of {home} dined with the {target} court — the cups of friendship are deep.",
  "The ambassador {name} taught {target} children a {home} game of stones.",
  "Gifts from {home}: {name} presented {target} cloth to the court steward.",
  "{name} of {home} toasted the {target} harvest at tonight's feast.",
]);

const ESCORT_ACK_LINES = Object.freeze([
  "The offer to ride escort to {city} still stands, {name} — say 'yes' or 'no'.",
  "{name}, the road to {city} wants a guard. Say 'yes' or 'no' to ride escort.",
  "Still waiting on an escort to {city}, {name}. A simple 'yes' or 'no' will do.",
]);

const ROLE_ENVOY = "envoy";
const ROLE_NEGOTIATOR = "negotiator";
const ROLE_AMBASSADOR = "ambassador";

const MISSION_TRADE = "trade";
const MISSION_CULTURE = "culture";
const MISSION_PEACE = "peace";
const MISSION_ALLIANCE = "alliance";

const BASE_SUCCESS = Object.freeze({
  [MISSION_TRADE]: 0.65,
  [MISSION_CULTURE]: 0.7,
  [MISSION_PEACE]: 0.5,
  [MISSION_ALLIANCE]: 0.45,
});
const POSITIVE_TRAITS = Object.freeze(["cheerful", "easygoing", "methodical", "dutiful", "devout"]);
const NEGATIVE_TRAITS = Object.freeze(["gruff", "suspicious", "greedy", "proud"]);
const TRAIT_WEIGHT = 0.08;
const PEACE_TENSION_DIVISOR = 200; // hotter borders are harder to calm
const PEACE_RELIEF = 12; // tension points eased by a successful treaty
const PEACE_INCIDENT = 10; // tension spike when peace talks collapse
const ALLIANCE_INCIDENT = 6; // tension spike when alliance talks collapse
const DEFAULT_TENSION = 20; // matches Tension.Kingdoms TENSION_DEFAULT

const CITY_FALLBACK = Object.freeze({
  asgarnia: "Falador",
  kandarin: "Ardougne",
  keldagrim: "Keldagrim",
  misthalin: "Varrock",
  morytania: "Darkmeyer",
});

// === Module state (ephemeral; missions resume naturally on restart) ===
const missions = new Map(); // homeKingdomId -> mission
const lastShoutAt = new Map(); // missionId:phase -> timestamp (spam plug)
const lastAmbassadorChatterAt = new Map(); // mission.id -> timestamp (spam plug)
const lastEscortAckAt = new Map(); // mission.id -> timestamp (spam plug)

// Memory-leak plug: prune spam-plug maps hourly, drop entries older than a day.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastShoutAt, lastAmbassadorChatterAt, lastEscortAckAt]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

function _resetForTests() {
  missions.clear();
  lastShoutAt.clear();
  lastAmbassadorChatterAt.clear();
  lastEscortAckAt.clear();
  lastPruneAt = 0;
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {placeholders} in a template. Unknown keys are left as-is. Cut to engine chat length. */
function fillLine(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] !== undefined ? String(vars[k]) : m
  ).slice(0, LINE_MAX);
}

/** Deterministic PRNG from a seed (same shape as CitizenJudges.mulberry). Pure. */
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string — stable seed input across restarts. Pure. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The diplomat claim predicate. True when this citizen may serve as a
 * diplomat: wires the judges tier's REAL claim function
 * (CitizenJudges.isJudge, the same predicate the court tick drafts judges
 * with) so the ~35% of courtiers claimed as judges are never also
 * diplomats. Fail-open when the judges module is absent: a missing tier
 * cannot claim anyone. Never throws.
 */
function isDiplomat(username) {
  try {
    if (!normalizeName(username)) return false;
    if (Judges && typeof Judges.isJudge === "function" && Judges.isJudge(username)) {
      return false;
    }
    return true;
  } catch {
    return true; // fail-open: claim checks must never break the tick
  }
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

/**
 * Pick a kingdom's diplomats: up to MAX courtiers, deterministic by seed so
 * the same citizens are chosen after every restart. Pure.
 * courtiers: [{ username, seed }]
 */
function pickDiplomats(courtiers) {
  return [...courtiers]
    .sort((a, b) => String(a.seed ?? "").localeCompare(String(b.seed ?? "")))
    .slice(0, MAX_DIPLOMATS_PER_KINGDOM);
}

/** Diplomat role by roster index: the first is the envoy, the second the negotiator. Pure. */
function diplomatRole(index) {
  return index === 0 ? ROLE_ENVOY : ROLE_NEGOTIATOR;
}

/** Mission kinds each role carries. Pure. */
function kindsForRole(role) {
  return role === ROLE_NEGOTIATOR
    ? [MISSION_PEACE, MISSION_ALLIANCE]
    : [MISSION_TRADE, MISSION_CULTURE];
}

/**
 * Choose a mission target. Pure: tensionOf(a, b) -> number is injected.
 * peace   -> the hottest border (needs calming)
 * trade   -> the calmest border (safe roads)
 * alliance -> the border closest to median tension (a plausible partner)
 * culture  -> any other kingdom, at random
 */
function missionTarget(homeId, kind, kingdomIds, tensionOf, rng) {
  const others = kingdomIds.filter((id) => id !== homeId);
  if (others.length === 0) return null;
  const scored = others.map((id) => ({ id, t: tensionOf(homeId, id) }));
  if (kind === MISSION_PEACE) {
    return scored.reduce((a, b) => (b.t > a.t ? b : a)).id;
  }
  if (kind === MISSION_TRADE) {
    return scored.reduce((a, b) => (b.t < a.t ? b : a)).id;
  }
  if (kind === MISSION_ALLIANCE) {
    const sorted = [...scored].sort((a, b) => a.t - b.t);
    return sorted[Math.floor(sorted.length / 2)].id;
  }
  return pickOne(rng, others);
}

/**
 * Personality-weighted success chance. Peace gets harder on hot borders.
 * Pure: (kind, traits[], tension) -> [0.05, 0.95].
 */
function successChance(kind, traits, tension) {
  let chance = BASE_SUCCESS[kind] ?? 0.5;
  for (const trait of traits ?? []) {
    if (POSITIVE_TRAITS.includes(trait)) chance += TRAIT_WEIGHT;
    else if (NEGATIVE_TRAITS.includes(trait)) chance -= TRAIT_WEIGHT;
  }
  if (kind === MISSION_PEACE) chance -= (tension ?? 0) / PEACE_TENSION_DIVISOR;
  return Math.min(0.95, Math.max(0.05, chance));
}

/** Roll the mission outcome. Pure. */
function resolveMission(rng, chance) {
  return rng() < chance ? "success" : "failure";
}

// ============================================================================
// Live helpers (guarded; safe when the kingdoms plugin is absent)
// ============================================================================

function tensionOf(a, b) {
  try {
    return Tension?.getTension?.(a, b) ?? DEFAULT_TENSION;
  } catch {
    return DEFAULT_TENSION;
  }
}

function kingdomName(kingdomId) {
  try {
    return KingdomStore?.getKingdom?.(kingdomId)?.name ?? CITY_FALLBACK[kingdomId] ?? kingdomId;
  } catch {
    return CITY_FALLBACK[kingdomId] ?? kingdomId;
  }
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "diplomacy", text);
  } catch {
    // Non-fatal.
  }
}

function emitRumor(director, kingdomId, text) {
  try {
    director?.api?.emitCustomEvent?.("kingdom:rumor", { kingdomId, text });
  } catch {
    // Non-fatal.
  }
}

/**
 * Seed into the REAL rumor ledger (CitizenRumors.seedRumor with a real
 * event — lineage and distortion, not console-only). The real signature is
 * seedRumor(rng, { kind, who, what, where, holder }); anything else is a
 * silent no-op, so build the event here. Returns the rumor or null.
 * Never throws.
 */
function seedDiplomatRumor(rng, event) {
  try {
    const { seedRumor } = require("./CitizenRumors");
    if (!event || !event.kind || !event.what || !event.holder) return null;
    return seedRumor(rng, {
      kind: String(event.kind),
      who: String(event.who ?? event.holder),
      whoDisplay: String(event.whoDisplay ?? event.who ?? event.holder),
      what: String(event.what),
      where: String(event.where ?? ""),
      whereDisplay: String(event.whereDisplay ?? event.where ?? ""),
      holder: String(event.holder),
    }) ?? null;
  } catch {
    return null;
  }
}

/** Ease tension after a successful peace treaty. Never below zero. */
function easeTension(a, b, relief) {
  try {
    const t = Tension?.getTension?.(a, b) ?? DEFAULT_TENSION;
    KingdomStore?.setRawTension?.(a, b, Math.max(0, t - relief));
    KingdomStore?.save?.();
  } catch {
    // Non-fatal.
  }
}

/** Spike tension after a collapsed negotiation — a real incident. */
function spikeTension(a, b, delta) {
  try {
    Tension?.addTension?.(a, b, delta);
  } catch {
    // Non-fatal.
  }
}

function missionLabel(mission) {
  const kindNames = {
    [MISSION_TRADE]: "trade agreement",
    [MISSION_CULTURE]: "cultural exchange",
    [MISSION_PEACE]: "peace treaty",
    [MISSION_ALLIANCE]: "alliance proposal",
  };
  return kindNames[mission.kind] ?? mission.kind;
}

// ============================================================================
// Mission lifecycle (data tier)
// ============================================================================

const DEPART_LINES = Object.freeze([
  "I ride for {city} on the crown's business — a {mission} to settle!",
  "The court sends me to {city}. Wish me a silver tongue — I carry a {mission}.",
  "Envoys ride at dawn! {city} awaits, and I bear a {mission}.",
]);

const RETURN_LINES = Object.freeze([
  "I have returned from {city} — the {mission} is concluded.",
  "Back from {city}, and I bring news of the {mission}.",
]);

const TRADE_SUCCESS_RUMOR = "{name} of {home} has signed a trade agreement with {target} — expect {target} goods in the market soon.";
const PEACE_SUCCESS_RUMOR = "A peace treaty! {name} of {home} has calmed the {target} border. The streets breathe easier.";
const ALLIANCE_SUCCESS_RUMOR = "{name} of {home} returns from {target} with an alliance proposal on the table.";
const PEACE_INCIDENT_RUMOR = "Talks collapse in {target}! {name} of {home} was rebuffed — the border seethes.";
const ALLIANCE_INCIDENT_RUMOR = "{name} of {home} returns from {target} empty-handed. The {target} court would not hear of an alliance.";

function courtiersOf(director, kingdomId) {
  const out = [];
  try {
    for (const record of director.roster?.values?.() ?? []) {
      // Non-overlapping claim: judge-claimed courtiers are never drafted
      // as diplomats (isDiplomat wires the judges tier's real predicate).
      if (record?.kingdomId === kingdomId && record?.role === ROLE_COURTIER && isDiplomat(record.username)) {
        out.push({
          username: record.username,
          seed: record.seed ?? record.username,
          traits: record.personality?.traits ?? [],
        });
      }
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function startMission(director, homeId, nowMs, rng) {
  const diplomats = pickDiplomats(courtiersOf(director, homeId));
  if (diplomats.length === 0) return null;
  const index = Math.floor(rng() * diplomats.length);
  const diplomat = diplomats[index];
  const role = diplomatRole(index);
  const kind = pickOne(rng, kindsForRole(role));
  const targetId = missionTarget(
    homeId,
    kind,
    KINGDOM_IDS,
    tensionOf,
    rng
  );
  if (!targetId) return null;
  const mission = {
    id: `${homeId}:${diplomat.username}:${Math.floor(nowMs / 1000)}`,
    homeId,
    diplomat: diplomat.username,
    traits: diplomat.traits,
    role,
    kind,
    targetId,
    phase: "departing",
    phaseAt: nowMs,
    playerEscorts: [],
    shouted: {},
  };
  missions.set(homeId, mission);
  journalEvent(
    diplomat.username,
    `Departs for ${kingdomName(targetId)} to negotiate a ${missionLabel(mission)}.`,
    "diplomacy"
  );
  return mission;
}

/** Advance one mission through its phase machine. Returns true if it changed phase. */
function advanceMission(director, mission, nowMs) {
  const elapsed = nowMs - mission.phaseAt;
  switch (mission.phase) {
    case "departing":
      if (elapsed >= DEPARTING_MS) {
        mission.phase = "traveling";
        mission.phaseAt = nowMs;
        return true;
      }
      return false;
    case "traveling":
      if (elapsed >= JOURNEY_MS) {
        mission.phase = "negotiating";
        mission.phaseAt = nowMs;
        const homeName = kingdomName(mission.homeId);
        const targetName = kingdomName(mission.targetId);
        emitRumor(
          director,
          mission.targetId,
          `An envoy of ${homeName} has arrived at court, seeking audience.`
        );
        // Real rumor ledger: the envoy's arrival enters gossip with lineage.
        seedDiplomatRumor(mulberry(fnv1a("envoy:" + mission.id)), {
          kind: "envoy",
          who: mission.diplomat,
          what: `arrived at the court of ${targetName}, seeking audience for a ${missionLabel(mission)}`,
          where: targetName,
          holder: mission.diplomat,
        });
        journalEvent(
          mission.diplomat,
          `Arrived at the court of ${targetName} — negotiations begin.`,
          "diplomacy"
        );
        return true;
      }
      return false;
    case "negotiating":
      if (elapsed >= NEGOTIATE_MS) {
        resolveOutcome(director, mission, nowMs);
        return true;
      }
      return false;
    case "stationed": {
      if (elapsed >= AMBASSADOR_TERM_MS) {
        // Ambassador's term ends with a cultural exchange.
        const ok = resolveMission(Math.random, 0.6);
        journalEvent(
          mission.diplomat,
          ok
            ? `Concludes the ambassador's term in ${kingdomName(mission.targetId)} — a cultural exchange of songs and stories.`
            : `The ambassador's term in ${kingdomName(mission.targetId)} ends quietly; the court seemed distracted.`,
          "diplomacy"
        );
        mission.phase = "returning";
        mission.phaseAt = nowMs;
        return true;
      }
      return false;
    }
    case "returning":
      if (elapsed >= JOURNEY_MS) {
        mission.phase = "debrief";
        mission.phaseAt = nowMs;
        journalEvent(
          mission.diplomat,
          `Returned to ${kingdomName(mission.homeId)} and debriefs the court.`,
          "diplomacy"
        );
        return true;
      }
      return false;
    case "debrief":
      if (elapsed >= DEBRIEF_MS) {
        missions.delete(mission.homeId);
        return true;
      }
      return false;
    default:
      missions.delete(mission.homeId);
      return true;
  }
}

/** Resolve a negotiation: roll, apply effects, pay escorts, maybe station an ambassador. */
function resolveOutcome(director, mission, nowMs) {
  const tension = tensionOf(mission.homeId, mission.targetId);
  const chance = successChance(mission.kind, mission.traits, tension);
  const outcome = resolveMission(Math.random, chance);
  const homeName = kingdomName(mission.homeId);
  const targetName = kingdomName(mission.targetId);
  const label = missionLabel(mission);

  if (outcome === "success") {
    if (mission.kind === MISSION_PEACE) {
      easeTension(mission.homeId, mission.targetId, PEACE_RELIEF);
      emitRumor(
        director,
        mission.homeId,
        fillLine(PEACE_SUCCESS_RUMOR, { name: mission.diplomat, home: homeName, target: targetName })
      );
    } else if (mission.kind === MISSION_TRADE) {
      emitRumor(
        director,
        mission.homeId,
        fillLine(TRADE_SUCCESS_RUMOR, { name: mission.diplomat, home: homeName, target: targetName })
      );
    } else if (mission.kind === MISSION_ALLIANCE) {
      emitRumor(
        director,
        mission.homeId,
        fillLine(ALLIANCE_SUCCESS_RUMOR, { name: mission.diplomat, home: homeName, target: targetName })
      );
    }
    // Real rumor ledger: the treaty enters gossip with lineage.
    seedDiplomatRumor(mulberry(fnv1a("treaty:" + mission.id)), {
      kind: "treaty",
      who: mission.diplomat,
      what: `concluded a ${label} with ${targetName}`,
      where: homeName,
      holder: mission.diplomat,
    });
    journalEvent(
      mission.diplomat,
      `The ${label} with ${targetName} succeeds.`,
      "diplomacy"
    );
    payEscorts(director, mission);
    // Success earns a resident ambassadorship at the foreign court.
    mission.phase = "stationed";
    mission.role = ROLE_AMBASSADOR;
    mission.phaseAt = nowMs;
    journalEvent(
      mission.diplomat,
      `Takes up residence as ambassador to the court of ${targetName}.`,
      "diplomacy"
    );
  } else {
    if (mission.kind === MISSION_PEACE) {
      spikeTension(mission.homeId, mission.targetId, PEACE_INCIDENT);
      emitRumor(
        director,
        mission.homeId,
        fillLine(PEACE_INCIDENT_RUMOR, { name: mission.diplomat, home: homeName, target: targetName })
      );
    } else if (mission.kind === MISSION_ALLIANCE) {
      spikeTension(mission.homeId, mission.targetId, ALLIANCE_INCIDENT);
      emitRumor(
        director,
        mission.homeId,
        fillLine(ALLIANCE_INCIDENT_RUMOR, { name: mission.diplomat, home: homeName, target: targetName })
      );
    }
    // Real rumor ledger: the collapse enters gossip with lineage.
    seedDiplomatRumor(mulberry(fnv1a("incident:" + mission.id)), {
      kind: "incident",
      who: mission.diplomat,
      what: `the ${label} with ${targetName} collapsed — talks are dead`,
      where: homeName,
      holder: mission.diplomat,
    });
    journalEvent(
      mission.diplomat,
      `The ${label} with ${targetName} collapses.`,
      "diplomacy"
    );
    mission.phase = "returning";
    mission.phaseAt = nowMs;
  }
}

/** Pay player escorts their wage on a successful mission. */
function payEscorts(director, mission) {
  if (!mission.playerEscorts.length) return;
  let players = [];
  try {
    players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
  } catch {
    return;
  }
  for (const escortName of mission.playerEscorts) {
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      let name = "";
      try {
        name = p.getUsername?.() ?? "";
      } catch {
        continue;
      }
      if (normalizeName(name) !== normalizeName(escortName)) continue;
      try {
        p.getInventory?.()?.adds?.(COINS, ESCORT_WAGE);
        p.sendMessage?.(
          `The ${missionLabel(mission)} succeeded — you are paid ${ESCORT_WAGE} coins for riding escort.`
        );
      } catch {
        // Non-fatal.
      }
      journalEvent(
        mission.diplomat,
        `${name} rode escort faithfully — paid ${ESCORT_WAGE} coins.`,
        "diplomacy"
      );
    }
  }
}

/**
 * The data-tier tick. Called from the slow director tick.
 * Gate order: prune -> per-kingdom mission advance (cheap map ops) ->
 * cadence roll for idle kingdoms.
 */
function tickDiplomacy(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    for (const homeId of KINGDOM_IDS) {
      const mission = missions.get(homeId);
      if (mission) {
        try {
          advanceMission(director, mission, nowMs);
        } catch {
          // One broken mission never sinks the board.
        }
        continue;
      }
      try {
        if (Math.random() < MISSION_CADENCE_CHANCE) {
          startMission(director, homeId, nowMs, Math.random);
        }
      } catch {
        // Non-fatal.
      }
    }
  } catch (e) {
    console.warn("[citizen-diplomats] tick failed:", e?.message ?? e);
  }
}

// ============================================================================
// Interaction tier: shouts and escort invites (fast proximity tick)
// ============================================================================

function courtAnchor(kingdomId) {
  try {
    return siteTileByKingdom(kingdomId, "court");
  } catch {
    return null;
  }
}

/** Real players near a tile anchor. */
function realPlayersNearTile(director, tile, radius) {
  const out = [];
  if (!tile) return out;
  let players = [];
  try {
    players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
  } catch {
    return out;
  }
  const anchor = {
    getLocation: () => ({
      getX: () => tile.x,
      getY: () => tile.y,
      getZ: () => tile.z ?? 0,
    }),
  };
  for (const p of players) {
    if (!isRealPlayer(p)) continue;
    if (withinTiles(anchor, p, radius)) out.push(p);
  }
  return out;
}

/** The diplomat's materialized bot, if any. */
function diplomatBot(director, mission) {
  try {
    const record = director.roster?.get?.(normalizeName(mission.diplomat));
    if (!record) return null;
    return (director.isOnline(record) ? director.getBot(record) : null) ?? null;
  } catch {
    return null;
  }
}

/** Scripted line from a materialized citizen. Cosmetic, never throws. */
function forceSay(bot, line) {
  try {
    { const _cvp = bot?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [String(line).slice(0, LINE_MAX)] })); }
  } catch {
    // Non-fatal.
  }
}

/**
 * The first materialized citizen bot within radius of a tile anchor, or
 * null. LOD gating for third-person ceremony lines: someone real must be
 * there to speak, and the data tier stays silent otherwise.
 */
function botNearTile(director, tile, radius) {
  try {
    if (!tile) return null;
    const anchor = {
      getLocation: () => ({
        getX: () => tile.x,
        getY: () => tile.y,
        getZ: () => tile.z ?? 0,
      }),
    };
    for (const record of director.roster?.values?.() ?? []) {
      try {
        const bot = (director.isOnline(record) ? director.getBot(record) : null);
        if (bot && withinTiles(anchor, bot, radius)) return bot;
      } catch { /* skip */ }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Envoy arrival ceremony at the TARGET court. LOD-gated: a materialized
 * citizen at the target court anchor heralds the envoy only when real
 * players are near enough to hear it. Fires once per mission, then the
 * data tier's seeded rumor carries the story. Dialogue budget: at most
 * CEREMONY_BUDGET lines.
 */
function arrivalCeremony(director, mission, nowMs) {
  if (mission.shouted.arrival) return;
  const anchor = courtAnchor(mission.targetId);
  const nearby = realPlayersNearTile(director, anchor, SHOUT_RADIUS);
  if (!nearby.length) return; // no audience: the rumor ledger speaks instead
  const herald = botNearTile(director, anchor, SHOUT_RADIUS);
  const rng = mulberry(fnv1a("ceremony:" + mission.id));
  const vars = {
    home: kingdomName(mission.homeId),
    target: kingdomName(mission.targetId),
    name: mission.diplomat,
    mission: missionLabel(mission),
  };
  const n = 1 + Math.floor(rng() * CEREMONY_BUDGET); // 1..budget lines
  for (let i = 0; i < n; i++) {
    forceSay(herald, fillLine(pickOne(rng, ARRIVAL_LINES), vars));
  }
  mission.shouted.arrival = true;
  journalEvent(
    mission.diplomat,
    `The court of ${vars.target} received the envoy of ${vars.home} in ceremony.`,
    "diplomacy"
  );
}

/**
 * Stationed ambassador chatter at the foreign court. LOD-gated and
 * hourly-capped: a materialized citizen at the target court anchor speaks
 * at most CEREMONY_BUDGET scripted lines about the ambassador's cultural
 * exchange. Simulated data tier when no player is near.
 */
function ambassadorChatter(director, mission, nowMs) {
  const last = lastAmbassadorChatterAt.get(mission.id) || 0;
  if (nowMs - last < AMBASSADOR_COOLDOWN_MS) return;
  const anchor = courtAnchor(mission.targetId);
  const nearby = realPlayersNearTile(director, anchor, SHOUT_RADIUS);
  if (!nearby.length) return;
  const herald = botNearTile(director, anchor, SHOUT_RADIUS);
  if (!herald) return;
  const rng = mulberry(fnv1a("ambassador:" + mission.id + ":" + Math.floor(nowMs / 3600000)));
  const vars = {
    home: kingdomName(mission.homeId),
    target: kingdomName(mission.targetId),
    name: mission.diplomat,
  };
  const n = 1 + Math.floor(rng() * CEREMONY_BUDGET); // 1..budget lines
  for (let i = 0; i < n; i++) {
    forceSay(herald, fillLine(pickOne(rng, AMBASSADOR_LINES), vars));
  }
  lastAmbassadorChatterAt.set(mission.id, nowMs);
}

/**
 * Ledger ack: a nearby real player holding an unanswered escort invite
 * from this diplomat. Returns the player or null. Checked before routine
 * flavor so real requests get real answers; does not consume the invite.
 */
function pendingEscortAck(director, mission, nowMs) {
  try {
    const last = lastEscortAckAt.get(mission.id) || 0;
    if (nowMs - last < ESCORT_ACK_COOLDOWN_MS) return null;
    const anchor = courtAnchor(mission.homeId);
    const nearby = realPlayersNearTile(director, anchor, SHOUT_RADIUS);
    for (const p of nearby) {
      let name = "";
      try {
        name = p.getUsername?.() ?? "";
      } catch { continue; }
      if (!name) continue;
      if (pendingInviteFor(mission.diplomat, name)) return p;
    }
  } catch { /* fall through */ }
  return null;
}

/** Acknowledge the pending escort invite in-world (scripted, zero LLM). */
function ackEscortInvite(director, mission, player, nowMs) {
  const bot = diplomatBot(director, mission);
  if (!bot) return;
  let name = "";
  try {
    name = player.getUsername?.() ?? "traveler";
  } catch { /* fall through */ }
  const rng = mulberry(fnv1a("ack:" + mission.id + ":" + Math.floor(nowMs / 900000)));
  forceSay(
    bot,
    fillLine(pickOne(rng, ESCORT_ACK_LINES), {
      name,
      city: kingdomName(mission.targetId),
    })
  );
  lastEscortAckAt.set(mission.id, nowMs);
}

/**
 * Departure/return announcements at the home court + escort invites,
 * plus ledger acks for nearby players holding unanswered escort invites.
 * One announcement shout per phase per mission (spam plug); acks are
 * separately cooldown-capped and fire before routine flavor.
 */
function homeCourtShouts(director, mission, nowMs) {
  const anchor = courtAnchor(mission.homeId);
  const nearby = realPlayersNearTile(director, anchor, SHOUT_RADIUS);
  if (nearby.length === 0) return;

  // Ledger ack first: a real unanswered invite beats routine flavor.
  if (mission.phase === "departing") {
    const pending = pendingEscortAck(director, mission, nowMs);
    if (pending) ackEscortInvite(director, mission, pending, nowMs);
  }

  if (mission.shouted[mission.phase]) return;
  const bot = diplomatBot(director, mission);
  const targetName = kingdomName(mission.targetId);
  const label = missionLabel(mission);
  const lines = mission.phase === "departing" ? DEPART_LINES : RETURN_LINES;
  forceSay(bot, fillLine(pickOne(Math.random, lines), { city: targetName, mission: label }));
  mission.shouted[mission.phase] = true;

  // A departing envoy invites nearby real players to ride escort.
  if (mission.phase === "departing") {
    inviteEscorts(director, mission, nearby);
  }
}

/**
 * The interaction-tier tick: LOD-gated chatter, real players only.
 * Gate order: per-mission try/catch — one broken mission never sinks the
 * tick. Phase dispatch: departing/returning at the home court, arrival
 * ceremonies and ambassador chatter at the foreign court.
 */
function tickDiplomatShouts(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    for (const mission of missions.values()) {
      try {
        if (mission.phase === "departing" || mission.phase === "returning") {
          homeCourtShouts(director, mission, nowMs);
        } else if (mission.phase === "negotiating") {
          arrivalCeremony(director, mission, nowMs);
        } else if (mission.phase === "stationed") {
          ambassadorChatter(director, mission, nowMs);
        }
      } catch { /* per-mission: never break the loop */ }
    }
  } catch (e) {
    console.warn("[citizen-diplomats] shout tick failed:", e?.message ?? e);
  }
}

function inviteEscorts(director, mission, nearbyPlayers) {
  for (const p of nearbyPlayers) {
    if (mission.playerEscorts.length >= MAX_PLAYER_ESCORTS) break;
    let name = "";
    try {
      name = p.getUsername?.() ?? "";
    } catch {
      continue;
    }
    if (!name) continue;
    try {
      const existing = getInvites(name).some(
        (i) => i.kind === INVITE_KIND_ESCORT && i.data?.missionId === mission.id
      );
      if (existing) continue;
      sendInvite(mission.diplomat, name, INVITE_KIND_ESCORT, {
        missionId: mission.id,
        wage: ESCORT_WAGE,
      });
      try {
        p.sendMessage?.(
          `${mission.diplomat} seeks an escort to ${kingdomName(mission.targetId)} — say "yes" to ride along for ${ESCORT_WAGE} coins.`
        );
      } catch {
        // Non-fatal.
      }
    } catch {
      // Non-fatal.
    }
  }
}

// ============================================================================
// Player opt-in (chat keyword path, mirrors CitizenTradeCaravans)
// ============================================================================

function pendingInviteFor(citizenName, playerName) {
  try {
    return (
      getInvites(playerName).find(
        (i) =>
          i.kind === INVITE_KIND_ESCORT &&
          normalizeName(i.from) === normalizeName(citizenName)
      ) ?? null
    );
  } catch {
    return null;
  }
}

function missionById(missionId) {
  for (const m of missions.values()) {
    if (m.id === missionId) return m;
  }
  return null;
}

/**
 * Player said "yes" to a diplomat escort invite.
 * Called from the chat keyword path. Returns the invite or null.
 */
function acceptDiplomatInvite(playerName, citizenName) {
  const invite = pendingInviteFor(citizenName, playerName);
  if (!invite) return null;
  const mission = missionById(invite.data?.missionId);
  if (!mission || mission.phase !== "departing") return null;
  try {
    resolveInvite(playerName, invite.id, true);
  } catch {
    // Non-fatal — still record the join.
  }
  const norm = normalizeName(playerName);
  if (mission.playerEscorts.length >= MAX_PLAYER_ESCORTS) return null;
  if (!mission.playerEscorts.includes(norm)) mission.playerEscorts.push(norm);
  journalEvent(
    citizenName,
    `${playerName} signed on as escort — ${ESCORT_WAGE} coins on a successful mission.`,
    "diplomacy"
  );
  return invite;
}

/**
 * Player said "no" to a diplomat escort invite. Records the decline.
 * Called from the chat keyword path. Returns the invite or null.
 */
function declineDiplomatInvite(playerName, citizenName) {
  const invite = pendingInviteFor(citizenName, playerName);
  if (!invite) return null;
  try {
    resolveInvite(playerName, invite.id, false);
  } catch {
    // Non-fatal.
  }
  journalEvent(citizenName, `${playerName} turned down the escort work.`, "diplomacy");
  return invite;
}

/**
 * Live mission summary for the chat/LLM layer to quote.
 * Returns null when nothing is running.
 */
function diplomatStatus() {
  const out = [];
  for (const m of missions.values()) {
    out.push(
      `${m.diplomat} (${m.role}) of ${kingdomName(m.homeId)}: ${m.phase} — ` +
        `${missionLabel(m)} with ${kingdomName(m.targetId)}.`
    );
  }
  return out.length ? out : null;
}

module.exports = {
  tickDiplomacy,
  tickDiplomatShouts,
  acceptDiplomatInvite,
  declineDiplomatInvite,
  diplomatStatus,
  // The diplomat claim predicate: wires the judges tier's REAL claim
  // function so judge-claimed courtiers are never also diplomats.
  isDiplomat,
  // Real rumor ledger seeding (seedRumor with a real event).
  seedDiplomatRumor,
  // Pure helpers for tests:
  pickDiplomats,
  diplomatRole,
  kindsForRole,
  missionTarget,
  successChance,
  resolveMission,
  fillLine,
  mulberry,
  fnv1a,
  isRealPlayer,
  withinTiles,
  pickOne,
  _resetForTests,
  // Tuning (tests pin these):
  MISSION_TRADE,
  MISSION_CULTURE,
  MISSION_PEACE,
  MISSION_ALLIANCE,
  ROLE_ENVOY,
  ROLE_NEGOTIATOR,
  ROLE_AMBASSADOR,
  INVITE_KIND_ESCORT,
  CEREMONY_BUDGET,
  AMBASSADOR_COOLDOWN_MS,
  ESCORT_ACK_COOLDOWN_MS,
  LINE_MAX,
  // Line pools (non-empty checks):
  ARRIVAL_LINES,
  AMBASSADOR_LINES,
  ESCORT_ACK_LINES,
};
