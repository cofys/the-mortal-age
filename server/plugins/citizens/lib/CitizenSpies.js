"use strict";

/**
 * CitizenSpies — covert intelligence rings, one per kingdom.
 *
 * WHAT IT DOES (data tier, free, slow ~60s director tick):
 *   Each kingdom keeps up to 2 operative citizens (informant / infiltrator /
 *   courier) under a handler. Operatives run covert missions through a phase
 *   machine: idle -> briefed -> operating -> debrief -> idle. Mission kinds:
 *   steal_documents, eavesdrop, sabotage, counter_intelligence. Every
 *   operative hides behind a cover identity (a codename) — journals and
 *   rumors name the cover, not the citizen. Each mission rolls detection
 *   risk, personality-weighted and worse on hot borders; a caught spy is a
 *   real diplomatic incident — tension spikes between the kingdoms, the same
 *   Tension mutators diplomats use. Successful intel missions accumulate
 *   intelligence for the home kingdom; at the warning threshold the network
 *   issues an early warning that eases the home court's hottest border —
 *   intelligence tangibly shaping kingdom decisions. Everything is
 *   journaled (the free news source for gossip and the LLM mouth) and
 *   notable events go out as kingdom:rumor.
 *
 * WHAT THE PLAYER SEES (interaction tier, fast proximity tick, real players):
 *   Handlers whisper recruitment offers to nearby real players — say "yes"
 *   to become a paid asset (same keyword-invite path as diplomat escorts).
 *   Assets earn a wage every time a home mission succeeds. Informants
 *   whisper gathered intel to passersby. Handlers sell foreign-court
 *   dossiers for coins ("yes" on the dossier invite).
 *
 * Zero LLM: all lines are scripted pools; the journal carries the story for
 * the LLM mouth to riff on later. Player chat dialogue ("why should I trust
 * you?") belongs to the LLM tier, which reads the journal — the mechanic
 * layer stays data-driven.
 *
 * Wiring: tickSpies on the slow director tick next to diplomats;
 * tickSpyShouts on the fast proximity tick next to diplomat shouts.
 * Plain-node testable: CitizenSpies.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { normalizeName, sendInvite, getInvites, resolveInvite } = require("./CitizenBonds");
const { KINGDOM_IDS } = require("../brain/CitizenSites");
const { ROLE_COURTIER } = require("../constants");

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

// === Tuning: all magic numbers here ===
const MAX_SPIES_PER_KINGDOM = 2;
const MISSION_CADENCE_CHANCE = 0.05; // per idle home kingdom per slow (~60s) tick
const BRIEFED_MS = 15 * 60 * 1000;
const OPERATING_MS = 2 * 60 * 60 * 1000; // abstracted travel + operation, data tier
const DEBRIEF_MS = 15 * 60 * 1000;
const LAY_LOW_MS = 3 * 60 * 60 * 1000; // a burned operative lies low this long
const SHOUT_RADIUS = 12; // tiles — handler earshot
const SHOUT_CHANCE = 0.35; // per eligible handler per proximity tick
const SHOUT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const INTEL_WARNING_THRESHOLD = 100; // intel points to trigger an early warning
const INTEL_RELIEF = 10; // tension eased by an early warning
const DETECTION_INCIDENT = 8; // tension spike when a spy is caught
const SABOTAGE_SUSPICION = 4; // unattributed tension spike on successful sabotage
const ASSET_WAGE = 150; // coins per successful home mission, per asset
const ASSET_SIGNING_WAGE = 100; // coins when a player accepts recruitment
const DOSSIER_PRICE = 500; // coins for a foreign-court dossier
const COINS = 995;
const INVITE_KIND_ASSET = "spy_asset";
const INVITE_KIND_DOSSIER = "spy_dossier";

const ROLE_INFORMANT = "informant";
const ROLE_INFILTRATOR = "infiltrator";
const ROLE_COURIER = "courier";
const ROLE_HANDLER = "handler";

const MISSION_STEAL = "steal_documents";
const MISSION_EAVESDROP = "eavesdrop";
const MISSION_SABOTAGE = "sabotage";
const MISSION_COUNTERINTEL = "counter_intelligence";

const PHASE_BRIEFED = "briefed";
const PHASE_OPERATING = "operating";
const PHASE_DEBRIEF = "debrief";

const BASE_SUCCESS = Object.freeze({
  [MISSION_STEAL]: 0.6,
  [MISSION_EAVESDROP]: 0.7,
  [MISSION_SABOTAGE]: 0.5,
  [MISSION_COUNTERINTEL]: 0.55,
});

const BASE_DETECTION = Object.freeze({
  [MISSION_STEAL]: 0.25,
  [MISSION_EAVESDROP]: 0.15,
  [MISSION_SABOTAGE]: 0.35,
  [MISSION_COUNTERINTEL]: 0.2,
});

const INTEL_YIELD = Object.freeze({
  [MISSION_STEAL]: 40,
  [MISSION_EAVESDROP]: 30,
  [MISSION_SABOTAGE]: 10,
  [MISSION_COUNTERINTEL]: 20,
});

// Traits that help a spy succeed / stay hidden, and traits that burn them.
const STEADY_TRAITS = ["methodical", "suspicious", "taciturn", "dutiful", "devout"];
const SLIPPERY_TRAITS = ["chatty", "clumsy", "fidgety", "cheerful", "proud"];
const TRAIT_WEIGHT = 0.07;
const TENSION_DETECTION_DIVISOR = 200; // detection += tension / 200 (hotter border, hotter risk)
const TENSION_SUCCESS_DIVISOR = 250;

// --- Cover identities: codenames, deterministic per citizen. ---
const CODENAME_ADJECTIVES = [
  "Ash", "Quiet", "Grey", "Sable", "Pale", "Hollow", "Copper", "Wren",
];
const CODENAME_NOUNS = [
  "Wren", "Ledger", "Thrush", "Lantern", "Fox", "Cipher", "Moth", "Quill",
];

function hashSeed(str) {
  let h = 2166136261;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Cover identity for a citizen. Pure: username -> codename, stable forever.
 * Journals and rumors name the cover, never the citizen.
 */
function coverFor(username) {
  const h = hashSeed(String(username ?? "").toLowerCase());
  const adj = CODENAME_ADJECTIVES[h % CODENAME_ADJECTIVES.length];
  const noun = CODENAME_NOUNS[Math.floor(h / CODENAME_ADJECTIVES.length) % CODENAME_NOUNS.length];
  return `${adj} ${noun}`;
}

/** Operative role by slot index. Pure. */
function spyRole(index) {
  return [ROLE_INFORMANT, ROLE_INFILTRATOR, ROLE_COURIER][index % 3];
}

/** Missions each role can run. Pure. */
function missionsForRole(role) {
  switch (role) {
    case ROLE_INFORMANT:
      return [MISSION_EAVESDROP, MISSION_COUNTERINTEL, MISSION_STEAL];
    case ROLE_INFILTRATOR:
      return [MISSION_STEAL, MISSION_SABOTAGE, MISSION_COUNTERINTEL];
    case ROLE_COURIER:
      return [MISSION_EAVESDROP, MISSION_STEAL];
    default:
      return [MISSION_EAVESDROP];
  }
}

/**
 * Choose a mission target: the hottest border (highest tension).
 * Pure: (homeId, kingdomIds, tensionOf, rng) -> kingdomId.
 */
function missionTarget(homeId, kingdomIds, tensionOf, rng) {
  const others = (kingdomIds ?? []).filter((id) => id !== homeId);
  if (others.length === 0) return null;
  const scored = others.map((id) => ({ id, t: tensionOf(homeId, id) ?? 0 }));
  scored.sort((a, b) => b.t - a.t);
  const top = scored[0].t;
  const tied = scored.filter((s) => s.t === top);
  return tied[Math.floor(rng() * tied.length)].id;
}

/**
 * Mission success chance. Pure: (kind, traits[], tension) -> [0.05, 0.95].
 * Steady traits help; slippery traits hurt; hot borders are harder.
 */
function successChance(kind, traits, tension) {
  let chance = BASE_SUCCESS[kind] ?? 0.5;
  for (const trait of traits ?? []) {
    if (STEADY_TRAITS.includes(trait)) chance += TRAIT_WEIGHT;
    else if (SLIPPERY_TRAITS.includes(trait)) chance -= TRAIT_WEIGHT;
  }
  chance -= (tension ?? 0) / TENSION_SUCCESS_DIVISOR;
  return Math.min(0.95, Math.max(0.05, chance));
}

/**
 * Detection chance. Pure: (kind, traits[], tension) -> [0.02, 0.8].
 * Steady traits hide you; slippery traits expose you; hot borders are
 * watched closely.
 */
function detectionChance(kind, traits, tension) {
  let chance = BASE_DETECTION[kind] ?? 0.2;
  for (const trait of traits ?? []) {
    if (STEADY_TRAITS.includes(trait)) chance -= TRAIT_WEIGHT;
    else if (SLIPPERY_TRAITS.includes(trait)) chance += TRAIT_WEIGHT;
  }
  chance += (tension ?? 0) / TENSION_DETECTION_DIVISOR;
  return Math.min(0.8, Math.max(0.02, chance));
}

/** Roll the mission. Pure: returns "success" | "detected" | "failed". */
function resolveMission(rng, success, detection) {
  if (rng() < detection) return "detected";
  return rng() < success ? "success" : "failed";
}

/**
 * Decide whether a handler should whisper recruitment now.
 * Pure: (rng, lastWhisperMs, nowMs) => boolean. Test this.
 */
function shouldWhisper(rng, lastWhisperMs, nowMs) {
  if (nowMs - (lastWhisperMs || 0) < SHOUT_COOLDOWN_MS) return false;
  return rng() < SHOUT_CHANCE;
}

// ============================================================================
// Live helpers (guarded; safe when the kingdoms plugin is absent)
// ============================================================================

function tensionOf(a, b) {
  try {
    return Tension?.getTension?.(a, b) ?? 0;
  } catch {
    return 0;
  }
}

function easeTension(a, b, relief) {
  try {
    const t = Tension?.getTension?.(a, b) ?? 0;
    KingdomStore?.setRawTension?.(a, b, Math.max(0, t - relief));
    KingdomStore?.save?.();
  } catch {
    // Non-fatal.
  }
}

function spikeTension(a, b, delta) {
  try {
    Tension?.addTension?.(a, b, delta);
  } catch {
    // Non-fatal.
  }
}

function kingdomName(id) {
  return String(id ?? "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "espionage", text);
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

/** Operatives: deterministic courtier picks per kingdom, like diplomats. */
function pickSpies(courtiers, homeId) {
  const sorted = [...courtiers].sort(
    (a, b) => hashSeed(`${homeId}:${a.username}`) - hashSeed(`${homeId}:${b.username}`)
  );
  return sorted.slice(0, MAX_SPIES_PER_KINGDOM).map((r, i) => ({
    record: r,
    role: spyRole(i),
    cover: coverFor(r.username),
    traits: r.personality?.traits ?? [],
  }));
}

function courtiersOf(director, homeId) {
  try {
    return [...(director.roster?.values?.() ?? [])].filter(
      (r) =>
        normalizeName(r.kingdomId ?? "") === normalizeName(homeId) &&
        r.role === ROLE_COURTIER
    );
  } catch {
    return [];
  }
}

let CitizenOffices = null;
try {
  CitizenOffices = require("./CitizenOffices");
} catch {
  CitizenOffices = null;
}

/** Normalized name of the bound spymaster for a kingdom, or null. */
function spymasterName(director, kingdomId) {
  try {
    const offices = CitizenOffices?.officesOfKingdom?.(kingdomId) ?? [];
    const seat = offices.find((o) => o?.office === "spymaster" && o?.citizenName);
    return seat ? normalizeName(seat.citizenName) : null;
  } catch {
    return null;
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

// ============================================================================
// Mission state — data tier, module-local. Never persisted mid-flight; a
// restart just ends missions (operatives return to idle, burned ones lie low).
// ============================================================================

const missions = new Map(); // missionId -> mission
const burnedUntil = new Map(); // normalized username -> timestamp (caught, lying low)
const intelByKingdom = new Map(); // kingdomId -> intel points
const assets = new Map(); // normalized player name -> { homeId, owed }
let missionSeq = 0;

function missionActiveFor(homeId) {
  for (const m of missions.values()) {
    if (m.homeId === homeId) return true;
  }
  return false;
}

function startMission(director, homeId, nowMs) {
  const courtiers = courtiersOf(director, homeId);
  if (courtiers.length === 0) return null;
  const spies = pickSpies(courtiers, homeId).filter(
    (s) => (burnedUntil.get(normalizeName(s.record.username)) ?? 0) < nowMs
  );
  if (spies.length === 0) return null;
  const spy = spies[Math.floor(Math.random() * spies.length)];
  const kinds = missionsForRole(spy.role);
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  const targetId = missionTarget(homeId, KINGDOM_IDS, tensionOf, Math.random);
  if (!targetId) return null;
  const mission = {
    id: `spy_${nowMs}_${++missionSeq}`,
    homeId,
    targetId,
    operative: spy.record.username,
    cover: spy.cover,
    role: spy.role,
    kind,
    traits: spy.traits,
    phase: PHASE_BRIEFED,
    phaseUntil: nowMs + BRIEFED_MS,
  };
  missions.set(mission.id, mission);
  journalEvent(
    spy.record.username,
    `${spy.cover} leaves the capital on quiet business.`,
    "espionage"
  );
  return mission;
}

function advanceMission(director, mission, nowMs) {
  if (mission.phase === PHASE_BRIEFED && nowMs >= mission.phaseUntil) {
    mission.phase = PHASE_OPERATING;
    mission.phaseUntil = nowMs + OPERATING_MS;
    journalEvent(mission.operative, `${mission.cover} slips across the border.`, "espionage");
  } else if (mission.phase === PHASE_OPERATING && nowMs >= mission.phaseUntil) {
    resolveOutcome(director, mission, nowMs);
    mission.phase = PHASE_DEBRIEF;
    mission.phaseUntil = nowMs + DEBRIEF_MS;
  } else if (mission.phase === PHASE_DEBRIEF && nowMs >= mission.phaseUntil) {
    missions.delete(mission.id);
  }
}

/** Resolve an operating mission: roll detection then success, apply effects. */
function resolveOutcome(director, mission, nowMs) {
  const tension = tensionOf(mission.homeId, mission.targetId);
  const success = successChance(mission.kind, mission.traits, tension);
  const detection = detectionChance(mission.kind, mission.traits, tension);
  const outcome = resolveMission(Math.random, success, detection);
  const homeName = kingdomName(mission.homeId);
  const targetName = kingdomName(mission.targetId);

  if (outcome === "detected") {
    // A caught spy is a real diplomatic incident.
    spikeTension(mission.homeId, mission.targetId, DETECTION_INCIDENT);
    burnedUntil.set(normalizeName(mission.operative), nowMs + LAY_LOW_MS);
    journalEvent(
      mission.operative,
      `${mission.cover} was caught in ${targetName} and expelled in disgrace.`,
      "espionage"
    );
    emitRumor(
      director,
      mission.homeId,
      `Scandal at court: ${homeName}'s agent "${mission.cover}" was caught spying in ${targetName} and expelled.`
    );
    emitRumor(
      director,
      mission.targetId,
      `The court of ${targetName} caught a ${homeName} spy and threw them out — tensions rise.`
    );
    return outcome;
  }

  if (outcome === "failed") {
    journalEvent(mission.operative, `${mission.cover} returned empty-handed.`, "espionage");
    return outcome;
  }

  // Success.
  const yield_ = INTEL_YIELD[mission.kind] ?? 20;
  intelByKingdom.set(mission.homeId, (intelByKingdom.get(mission.homeId) ?? 0) + yield_);

  if (mission.kind === MISSION_SABOTAGE) {
    // Unattributed sabotage: quiet suspicion, not a proven act.
    spikeTension(mission.homeId, mission.targetId, SABOTAGE_SUSPICION);
    journalEvent(
      mission.operative,
      `${mission.cover} reports the job in ${targetName} is done — no one suspects a thing.`,
      "espionage"
    );
    emitRumor(
      director,
      mission.targetId,
      `Strange accidents plague ${targetName}'s workshops — some whisper of foreign saboteurs.`
    );
  } else if (mission.kind === MISSION_COUNTERINTEL) {
    // Uncover a foreign mission targeting home, if any.
    let uncovered = null;
    for (const m of missions.values()) {
      if (m.id !== mission.id && m.targetId === mission.homeId) {
        uncovered = m;
        break;
      }
    }
    if (uncovered) {
      missions.delete(uncovered.id);
      journalEvent(
        mission.operative,
        `${mission.cover} uncovered a ${kingdomName(uncovered.homeId)} agent ("${uncovered.cover}") and had them quietly arrested.`,
        "espionage"
      );
      emitRumor(
        director,
        mission.homeId,
        `The spymaster's people caught a foreign agent in ${homeName} — a ${kingdomName(uncovered.homeId)} plot foiled.`
      );
    } else {
      journalEvent(
        mission.operative,
        `${mission.cover} swept the capital for foreign agents — the streets are clean.`,
        "espionage"
      );
    }
  } else {
    journalEvent(
      mission.operative,
      `${mission.cover} returns with ${mission.kind === MISSION_STEAL ? "stolen documents" : "overheard secrets"} from ${targetName}.`,
      "espionage"
    );
  }

  // Pay the ring's assets.
  payAssets(director, mission.homeId);

  // Early warning: enough intel eases the home court's hottest border.
  const intel = intelByKingdom.get(mission.homeId) ?? 0;
  if (intel >= INTEL_WARNING_THRESHOLD) {
    intelByKingdom.set(mission.homeId, 0);
    const hot = missionTarget(mission.homeId, KINGDOM_IDS, tensionOf, Math.random);
    if (hot) {
      easeTension(mission.homeId, hot, INTEL_RELIEF);
      emitRumor(
        director,
        mission.homeId,
        `The spymaster's warning reaches the ${homeName} court in time — war with ${kingdomName(hot)} is averted, for now.`
      );
    }
  }
  return outcome;
}

/** Credit assets of a kingdom; payout happens on the proximity tick. */
function payAssets(director, homeId) {
  for (const [name, asset] of assets) {
    if (normalizeName(asset.homeId) === normalizeName(homeId)) {
      asset.owed = (asset.owed ?? 0) + ASSET_WAGE;
    }
  }
}

/**
 * Slow-tick entry: start missions for idle kingdoms, advance running ones.
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickSpies(director, nowMs) {
  try {
    for (const homeId of KINGDOM_IDS) {
      if (!missionActiveFor(homeId) && Math.random() < MISSION_CADENCE_CHANCE) {
        startMission(director, homeId, nowMs);
      }
    }
    for (const mission of [...missions.values()]) {
      advanceMission(director, mission, nowMs);
    }
  } catch (e) {
    console.warn("[citizen-spies] tick failed:", e?.message ?? e);
  }
}

// ============================================================================
// Player opt-in (chat keyword path, mirrors diplomat escort invites)
// ============================================================================

function pendingInviteFor(citizenName, playerName, kind) {
  try {
    return (
      getInvites(playerName).find(
        (i) => i.kind === kind && normalizeName(i.from) === normalizeName(citizenName)
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Player said "yes" to a spy invite.
 * Routes by invite kind: spy_asset (become an asset) or spy_dossier (buy
 * intel — charged in coins). Called from the chat keyword path, which should
 * pass the player object so dossiers can be charged. Returns the invite or
 * null.
 */
function acceptSpyInvite(playerName, citizenName, player = null) {
  const assetInvite = pendingInviteFor(citizenName, playerName, INVITE_KIND_ASSET);
  const dossierInvite = assetInvite
    ? null
    : pendingInviteFor(citizenName, playerName, INVITE_KIND_DOSSIER);
  const invite = assetInvite ?? dossierInvite;
  if (!invite) return null;

  if (invite.kind === INVITE_KIND_ASSET) {
    try {
      resolveInvite(playerName, invite.id, true);
    } catch {
      // Non-fatal — still record the join.
    }
    const norm = normalizeName(playerName);
    if (!assets.has(norm)) {
      assets.set(norm, { homeId: invite.data?.homeId ?? null, owed: ASSET_SIGNING_WAGE });
    } else {
      assets.get(norm).owed = (assets.get(norm).owed ?? 0) + ASSET_SIGNING_WAGE;
    }
    journalEvent(
      citizenName,
      `${playerName} joined the network as an asset — ${ASSET_SIGNING_WAGE} coins signing wage.`,
      "espionage"
    );
    return invite;
  }

  // Dossier purchase: charge coins first; only resolve on payment.
  const price = invite.data?.price ?? DOSSIER_PRICE;
  if (!player || !chargeCoins(player, price)) {
    try {
      player?.sendMessage?.(`The dossier costs ${price} coins — come back with the coin.`);
    } catch {
      // Non-fatal.
    }
    return null;
  }
  try {
    resolveInvite(playerName, invite.id, true);
  } catch {
    // Non-fatal.
  }
  const about = invite.data?.about;
  try {
    player.sendMessage?.(
      `The handler slides you a sealed dossier: ${pickOne(Math.random, DOSSIER_INTEL)}${
        about ? ` — all about ${kingdomName(about)}'s court.` : ""
      }`
    );
  } catch {
    // Non-fatal.
  }
  journalEvent(citizenName, `${playerName} bought a dossier on ${kingdomName(about)}.`, "espionage");
  return invite;
}

/**
 * Player said "no" to a spy invite. Returns the invite or null.
 */
function declineSpyInvite(playerName, citizenName) {
  for (const kind of [INVITE_KIND_ASSET, INVITE_KIND_DOSSIER]) {
    const invite = pendingInviteFor(citizenName, playerName, kind);
    if (!invite) continue;
    try {
      resolveInvite(playerName, invite.id, false);
    } catch {
      // Non-fatal.
    }
    return invite;
  }
  return null;
}

/**
 * Attempt to charge a player coins. Defensive: the engine container API is
 * checked at call time, never assumed.
 */
function chargeCoins(player, amount) {
  try {
    const inv = player.getInventory?.();
    if (!inv) return false;
    const have = inv.getAmount?.(COINS) ?? 0;
    if (have < amount) return false;
    if (typeof inv.removes === "function") inv.removes(COINS, amount);
    else if (typeof inv.remove === "function") inv.remove(COINS, amount);
    else if (typeof inv.delete === "function") inv.delete(COINS, amount);
    else return false;
    return true;
  } catch {
    return false;
  }
}

/** Pay a player coins, guarded. */
function payCoins(player, amount) {
  try {
    player.getInventory?.()?.adds?.(COINS, amount);
    return true;
  } catch {
    return false;
  }
}

// --- Interaction tier: whispers on the proximity tick ---

const lastWhisperByCitizen = new Map(); // username -> timestamp
let lastWhisperPruneAt = 0;

function pruneWhispers(nowMs) {
  if (nowMs - lastWhisperPruneAt < 3600 * 1000) return;
  lastWhisperPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWhisperByCitizen) {
    if (at < cutoff) lastWhisperByCitizen.delete(k);
  }
}

const RECRUIT_LINES = [
  `The spymaster pays for sharp eyes and sealed lips — say "yes" to join the network.`,
  `Psst. We could use someone like you — say "yes" and earn coin for the crown's quiet work.`,
  `Loose tongues sink courts, friend. Ours pays well. Say "yes" if you want in.`,
];

const INFORMANT_WHISPERS = [
  "Word from across the border: their granaries are half-empty this season.",
  "I heard their marshal drills the guard double-time at night.",
  "The foreign court argues over taxes — the commons are restless.",
  "Their spymaster's couriers ride for the border again.",
  "A merchant swears their king dines alone these days. Trouble at court.",
];

const DOSSIER_INTEL = [
  "Their court's favor-trade runs through the harbormaster — gold opens every door there.",
  "The marshal's new levies are green conscripts; their veterans grumble unpaid.",
  "Their spymaster recruits from the dock taverns — watch the quiet drinkers.",
];

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
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

/**
 * Fast-tick entry: spymaster-handlers whisper recruitment/dossier offers,
 * informants whisper gathered intel — only where real players can hear.
 * Asset wage payouts go out whenever an asset is online.
 */
function tickSpyShouts(director, nowMs) {
  pruneWhispers(nowMs);
  try {
    for (const homeId of KINGDOM_IDS) {
      const handler = spymasterName(director, homeId);
      const spies = pickSpies(courtiersOf(director, homeId), homeId);
      for (const spy of spies) {
        const citizen = (director.isOnline(spy.record) ? director.getBot(spy.record) : null);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, SHOUT_RADIUS)) continue;
        const last = lastWhisperByCitizen.get(spy.record.username) || 0;
        if (!shouldWhisper(Math.random, last, nowMs)) continue;

        const isHandler = handler && normalizeName(spy.record.username) === handler;
        if (isHandler) {
          recruitOrSell(director, spy.record, citizen, homeId);
        } else if (spy.role === ROLE_INFORMANT) {
          whisperIntel(director, spy.record, citizen, nowMs);
        }
        lastWhisperByCitizen.set(spy.record.username, nowMs);
      }
    }

    // Asset wage payouts: scan online real players for owed wages.
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      const key = normalizeName(p.getUsername?.() ?? "");
      const asset = assets.get(key);
      if (asset && (asset.owed ?? 0) > 0) {
        if (payCoins(p, asset.owed)) {
          try {
            p.sendMessage?.(`The network pays its debts: ${asset.owed} coins for your quiet work.`);
          } catch {
            // Non-fatal.
          }
          asset.owed = 0;
        }
      }
    }
  } catch (e) {
    console.warn("[citizen-spies] shouts failed:", e?.message ?? e);
  }
}

/**
 * A spymaster-handler whispers to a nearby real player: recruit them as an
 * asset, or sell them a foreign-court dossier.
 */
function recruitOrSell(director, record, citizen, homeId) {
  try {
    const players = ([...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)).filter(
      (p) => isRealPlayer(p) && withinTiles(citizen, p, SHOUT_RADIUS)
    );
    if (players.length === 0) return;
    const player = players[0];
    const name = player.getUsername?.() ?? "traveler";

    const already = assets.has(normalizeName(name));
    if (!already && Math.random() < 0.6) {
      if (getInvites(name).some((i) => i.kind === INVITE_KIND_ASSET)) return;
      sendInvite(record.username, name, INVITE_KIND_ASSET, {
        homeId: record.kingdomId ?? homeId ?? null,
      });
      try {
        player.sendMessage?.(pickOne(Math.random, RECRUIT_LINES));
      } catch {
        // Non-fatal.
      }
    } else {
      if (getInvites(name).some((i) => i.kind === INVITE_KIND_DOSSIER)) return;
      const targetId = missionTarget(record.kingdomId ?? homeId, KINGDOM_IDS, tensionOf, Math.random);
      sendInvite(record.username, name, INVITE_KIND_DOSSIER, {
        price: DOSSIER_PRICE,
        about: targetId,
      });
      try {
        player.sendMessage?.(
          `A sealed dossier on ${kingdomName(targetId)}'s court — ${DOSSIER_PRICE} coins. Say "yes" and it's yours.`
        );
      } catch {
        // Non-fatal.
      }
    }
  } catch {
    // Non-fatal.
  }
}

/**
 * Informants whisper gathered intel to nearby players. Called from
 * tickSpyShouts' citizen loop in the real wiring; exported pure-ish helper
 * for tests.
 */
function whisperIntel(director, record, citizen, nowMs) {
  try {
    const players = ([...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)).filter(
      (p) => isRealPlayer(p) && withinTiles(citizen, p, SHOUT_RADIUS)
    );
    if (players.length === 0) return false;
    const target = players[0];
    const intel = intelByKingdom.get(record.kingdomId) ?? 0;
    const line =
      intel >= 30
        ? pickOne(Math.random, INFORMANT_WHISPERS)
        : "Nothing worth selling today, friend. The streets are quiet.";
    try {
      citizen.forceChat?.(line);
    } catch {
      // Non-fatal.
    }
    return true;
  } catch {
    return false;
  }
}

// --- Test seam: reset module-local state between tests ---
function _resetForTests() {
  missions.clear();
  burnedUntil.clear();
  intelByKingdom.clear();
  assets.clear();
  lastWhisperByCitizen.clear();
  missionSeq = 0;
}

module.exports = {
  tickSpies,
  tickSpyShouts,
  acceptSpyInvite,
  declineSpyInvite,
  // Pure helpers for tests:
  coverFor,
  spyRole,
  missionsForRole,
  missionTarget,
  successChance,
  detectionChance,
  resolveMission,
  shouldWhisper,
  withinTiles,
  isRealPlayer,
  whisperIntel,
  chargeCoins,
  payCoins,
  _resetForTests,
  // Read-only state accessors for tests:
  _missions: missions,
  _assets: assets,
  _intel: intelByKingdom,
  _burned: burnedUntil,
};
