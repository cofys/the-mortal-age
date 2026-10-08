"use strict";

/**
 * CitizenSailors — sailor citizens who crew the ships: deckhands haul lines,
 * navigators chart courses, captains command vessels and offer passage,
 * dockworkers load and unload the quays.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a sailor trade (or none)
 *   from their username hash — no storage, stable across restarts. Home-port
 *   assignment prefers the citizen's kingdom. Captains' ships, routes and
 *   voyage rhythms are derived from the date + hash, so arrivals and
 *   departures are journaled events the simulation runs with zero players
 *   online at zero token cost. Work events are journaled once per visible
 *   loop so the interaction-tier LLM answers "what have you been up to?"
 *   truthfully (and can riff on passage and crewing — booking dialogue is
 *   the LLM's job, journaled state is its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Sailors visibly work the docks and decks: line casts (engine anim
 *   13576), cargo sorting (engine anim 13599), captains at the helm
 *   (engine anim 13340). Ship arrivals are the crowd moment. In storm
 *   weather everyone stays in port and battens down; deep-sea crews warn
 *   of the sea. Captains offer passage to lingering players.
 *
 * Zero LLM: scripted emote pools, work/offer/arrival/storm lines,
 * chance-gated.
 *
 * Wired into the director tick right after the jewelers block.
 * Plain-node testable: CitizenSailors.test.js.
 */

// === Tuning: all magic numbers here ===
const SAILOR_RADIUS = 40; // tiles — visible work range (same as fishers/miners)
const OFFER_RADIUS = 14; // tiles — passage offers, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const OFFER_COOLDOWN_MS = 4 * 60 * 60 * 1000; // passage offers at most every 4h
const OFFER_CHANCE = 0.35;
const ARRIVAL_COOLDOWN_MS = 6 * 60 * 60 * 1000; // ship arrivals at most every 6h
const ARRIVAL_CHANCE = 0.45; // arrivals are crowd moments, fire eagerly
const ARRIVAL_DAY_CHANCE = 0.3; // a captain's ship is in port this often

// Engine sailing animations (Sailing.plugin.js / Salvaging.plugin.js,
// verified from the sailing skill source).
const ANIM_HELM = 13340; // SEQ_HUMAN_HELM_ACTIVE — steering the helm
const ANIM_CAST = 13576; // SEQ_CAST — casting a line/hook
const ANIM_SORT = 13599; // SEQ_SORT — sorting cargo

// === Sailor types ===
const SAILOR_DECKHAND = "deckhand";
const SAILOR_NAVIGATOR = "navigator";
const SAILOR_CAPTAIN = "captain";
const SAILOR_DOCKWORKER = "dockworker";
const SAILOR_TYPES = Object.freeze([SAILOR_DECKHAND, SAILOR_NAVIGATOR, SAILOR_CAPTAIN, SAILOR_DOCKWORKER]);

// === Home ports (names players recognise; kingdoms for derived
// assignment — we never need coordinates, only names) ===
const PORTS = Object.freeze([
  { name: "the Catherby beach", short: "catherby", kingdom: "kandarin" },
  { name: "the Karamja docks", short: "karamja", kingdom: "kandarin" },
  { name: "the Ardougne docks", short: "ardougne", kingdom: "kandarin" },
  { name: "Port Khazard", short: "khazard", kingdom: "kandarin" },
  { name: "Port Sarim", short: "portsarim", kingdom: "misthalin" },
  { name: "the Rimmington docks", short: "rimmington", kingdom: "misthalin" },
  { name: "the Draynor riverside", short: "draynor", kingdom: "misthalin" },
  { name: "the Mos Le'Harmless docks", short: "mosleharmless", kingdom: "asgarnia" },
  { name: "the Entrana ferry", short: "entrana", kingdom: "asgarnia" },
  { name: "the Burgh de Rott docks", short: "burghderott", kingdom: "morytania" },
  { name: "the Mort'ton barge moorings", short: "mortton", kingdom: "morytania" },
  { name: "the Fremennik docks", short: "fremennik", kingdom: "keldagrim" },
  { name: "the Neitiznot docks", short: "neitiznot", kingdom: "keldagrim" },
]);

// === Ship types ===
const SHIP_TYPES = Object.freeze(["trading cog", "fishing smack", "war galley"]);

// === Ship names (derived per captain, stable across restarts) ===
const SHIP_NAMES = Object.freeze([
  "the Stormrunner",
  "the Salt Duchess",
  "the Grey Gull",
  "the Maiden's Wake",
  "the Iron Keel",
  "the Lucky Herring",
  "the Copper Wake",
  "the Sea Wraith",
  "the Gilded Tern",
  "the Briny Rose",
  "the Deep Venture",
  "the Pale Albatross",
]);

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastOfferByCitizen = new Map(); // username -> timestamp
const lastArrivalByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWorkByCitizen) {
    if (at < cutoff) lastWorkByCitizen.delete(k);
  }
  for (const [k, at] of lastOfferByCitizen) {
    if (at < cutoff) lastOfferByCitizen.delete(k);
  }
  for (const [k, at] of lastArrivalByCitizen) {
    if (at < cutoff) lastArrivalByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash — deterministic, stable across restarts. */
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

/** Materialized citizen bot for a roster record, or null when offline. */
function materializedBot(director, record) {
  try {
    if (!director?.isOnline?.(record)) return null;
    return director.getBot?.(record) ?? null;
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
 * Sailor trade for a username, or null for a non-sailor.
 * ~35% of commoners sail; the trade is hash-derived and stable.
 */
function sailorTypeFor(username) {
  if (!username) return null;
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "sailor") return null;
  const h = hashStr("sailor|" + String(username).toLowerCase());
  return SAILOR_TYPES[h % SAILOR_TYPES.length];
}

/**
 * The home port this citizen sails from, preferring their kingdom (falls
 * back to all ports).
 */
function portFor(username, kingdom) {
  let pool = (PORTS || []).filter((s) => s.kingdom === kingdom);
  if (pool.length === 0) pool = PORTS;
  const h = hashStr("port|" + String(username).toLowerCase());
  return pool[h % pool.length];
}

/** The ship a captain commands — name, type, and home port. Stable. */
function shipFor(username, kingdom) {
  const hn = hashStr("ship|" + String(username).toLowerCase());
  return {
    name: SHIP_NAMES[hn % SHIP_NAMES.length],
    type: SHIP_TYPES[hn % SHIP_TYPES.length],
    port: portFor(username, kingdom),
  };
}

/**
 * The port this captain is sailing to today — derived, so the voyage
 * rhythm is stable per day and agrees across the simulation.
 */
function destinationFor(username, kingdom, dateMs) {
  const home = portFor(username, kingdom);
  const pool = (PORTS || []).filter((p) => p.name !== home.name);
  const h = hashStr("dest|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return pool[h % pool.length];
}

/**
 * True if this captain's ship is in port today (arrived this morning or
 * sails at dawn). Derived per-day from a hash.
 */
function shipInPortFor(username, dateMs) {
  const h = hashStr("inport|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return h % 100 < ARRIVAL_DAY_CHANCE * 100;
}

// === Fishers' weather (lazy require — keeps the storm fiction consistent
// across modules; falls back to a derived rhythm if unavailable) ===
let _fishersWeather = null;
function fishersWeatherFor() {
  if (_fishersWeather === null) {
    try {
      _fishersWeather = require("./CitizenFishers").weatherFor;
    } catch {
      _fishersWeather = false;
    }
  }
  return _fishersWeather || null;
}

/** Derived sea weather for sailors: calm, breezy, or storm. Storms keep
 * everyone in port — they batten down instead of sailing. */
function weatherFor(dateMs) {
  const wf = fishersWeatherFor();
  if (wf) return wf(dateMs);
  const h = hashStr("seastorm|" + Math.floor(dateMs / 86400000));
  const roll = h % 100;
  if (roll < 22) return "storm";
  if (roll < 57) return "breezy";
  return "calm";
}

/** Storm keeps ships in port; all sailor work becomes batten-down work. */
function isStorm(weather) {
  return weather === "storm";
}

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = {
  [SAILOR_DECKHAND]: [
    "*hauls the mooring line*",
    "*swabs the deck*",
    "*climbs the rigging*",
    "*coils the rope*",
    "*scrapes the barnacles*",
  ],
  [SAILOR_NAVIGATOR]: [
    "*studies the charts*",
    "*sights the North Star*",
    "*plots the course*",
    "*checks the compass*",
    "*marks the tide table*",
  ],
  [SAILOR_CAPTAIN]: [
    "*paces the quarterdeck*",
    "*inspects the rigging*",
    "*checks the manifest*",
    "*tests the wind*",
    "*polishes the ship's bell*",
  ],
  [SAILOR_DOCKWORKER]: [
    "*hauls the cargo crate*",
    "*loads the barrel*",
    "*stacks the sacks*",
    "*rolls the cask down the gangplank*",
    "*tallies the cargo*",
  ],
};

/** Storm lines — everyone battens down in port. */
const STORM_LINES = [
  "*doubles the mooring lines* Storm coming — nothing sails today.",
  "*battens the hatches* Sea's turning ugly. Smart crews stay in port.",
  "*secures the cargo* I've seen this swell before. Ships can wait — lives can't.",
  "*calls out* All hands in! Storm's on us!",
];

/** Scripted visible work line for a sailor type (or storm lines), or null. */
function workLineFor(rng, type, weather) {
  if (isStorm(weather)) return pickOne(rng, STORM_LINES);
  const pool = WORK_LINES[type];
  if (!pool) return null;
  return pickOne(rng, pool);
}

/** Ship arrival — the crowd moment. */
function arrivalLineFor(rng, ship, port) {
  const portName = port && port.name ? port.name : "the harbour";
  return pickOne(rng, [
    `Sail ho! ${ship.name} sails into ${portName}!`,
    `Make way on the quay — ${ship.name}, a ${ship.type}, is coming in!`,
    `${ship.name} is home! Fresh from the open water — come see her colours!`,
    `Ring the bell! ${ship.name} returns to ${portName} safe and sound!`,
  ]);
}

/** Passage offer — captains take on passengers for lingering players. */
function offerLineFor(rng, ship, destination) {
  const destName = destination && destination.name ? destination.name : "the next port";
  return pickOne(rng, [
    `Need passage? ${ship.name} sails for ${destName} at dawn. Fair winds, fair price.`,
    `${ship.name} — a ${ship.type} — bound for ${destName}. Cabin or hammock, your coin your choice.`,
    `Going my way? We sail ${ship.name} to ${destName} when the tide turns.`,
    `Passage to ${destName} aboard ${ship.name}, friend. Fastest hull in the harbour.`,
  ]);
}

/**
 * Decide whether this sailor should do visible work now.
 * Pure: (rng, lastWorkMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastWorkMs, nowMs) {
  if (nowMs - (lastWorkMs || 0) < WORK_COOLDOWN_MS) return false;
  return rng() < WORK_CHANCE;
}

/** Decide whether this captain should offer passage now. Pure. */
function shouldOffer(rng, lastOfferMs, nowMs) {
  if (nowMs - (lastOfferMs || 0) < OFFER_COOLDOWN_MS) return false;
  return rng() < OFFER_CHANCE;
}

/** Decide whether a ship-arrival announcement should fire now. Pure. */
function shouldAnnounceArrival(rng, lastArrivalMs, nowMs) {
  if (nowMs - (lastArrivalMs || 0) < ARRIVAL_COOLDOWN_MS) return false;
  return rng() < ARRIVAL_CHANCE;
}

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
let _journal = null;
function journal() {
  if (_journal === null) {
    try {
      _journal = require("./CitizenJournal").getJournal();
    } catch {
      _journal = false;
    }
  }
  return _journal || null;
}

function journalEvent(citizenName, text) {
  try {
    journal()?.log(citizenName, "work", text);
  } catch {
    // Journal is best-effort; never break the tick.
  }
}

/** Play a sailing animation, best-effort. */
function playAnim(director, bot, animId) {
  try {
    if (!animId) return false;
    const Anim = director?.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(animId));
    return true;
  } catch {
    return false;
  }
}

/** Animation for a sailor type. */
function animFor(type) {
  if (type === SAILOR_CAPTAIN) return ANIM_HELM;
  if (type === SAILOR_DOCKWORKER) return ANIM_SORT;
  if (type === SAILOR_DECKHAND) return ANIM_CAST;
  return 0; // navigators work the charts, no anim
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → commoner → sailor type → materialized →
// real player near → chance → work. Three passes: work, passage offers,
// ship-arrival announcements.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickSailors(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners sail (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = sailorTypeFor(record.username);
        if (!type) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        // 3. Citizen must be materialized (near a player already).
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. A real player must be within sight of the docks.
        if (!anyRealPlayerNear(director, citizen, SAILOR_RADIUS)) continue;

        // 5. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= WORK_CHANCE) continue;
        doSailorWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Passage offers: captains only, tighter radius. The booking dialogue
    // is the LLM tier; the journaled voyage is its source of truth.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        if (sailorTypeFor(record.username) !== SAILOR_CAPTAIN) continue;
        const last = lastOfferByCitizen.get(record.username) || 0;
        if (nowMs - last < OFFER_COOLDOWN_MS) continue;
        const citizen = materializedBot(director, record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, OFFER_RADIUS)) continue;
        if (Math.random() >= OFFER_CHANCE) continue;
        doPassageOffer(director, citizen, record, nowMs);
        lastOfferByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Ship arrivals: captains whose ships are in port today announce the
    // return — the crowd moment that draws a gathering on the quay.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        if (sailorTypeFor(record.username) !== SAILOR_CAPTAIN) continue;
        if (!shipInPortFor(record.username, nowMs)) continue;
        const last = lastArrivalByCitizen.get(record.username) || 0;
        if (nowMs - last < ARRIVAL_COOLDOWN_MS) continue;
        const citizen = materializedBot(director, record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, SAILOR_RADIUS)) continue;
        if (Math.random() >= ARRIVAL_CHANCE) continue;
        doArrival(director, citizen, record, nowMs);
        lastArrivalByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-sailors] tick failed:", e?.message ?? e);
  }
}

/** The visible work: animation + emote line + journal line. */
function doSailorWork(director, record, citizen, type, nowMs) {
  const weather = weatherFor(nowMs);
  const line = workLineFor(Math.random, type, weather);
  if (!line) return;
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  playAnim(director, citizen, animFor(type));
  const port = portFor(record.username, record.kingdomId ?? record.kingdom);
  // One journal line per loop — the LLM's source of truth. Includes the
  // port and the ship, so "what have you been up to?" is answerable, and
  // a note that deckhands look for ships to crew (the sailing design's
  // crew bonus — hiring dialogue is the LLM tier).
  journalEvent(
    record.username,
    isStorm(weather)
      ? `Battened down at ${port ? port.name : "the harbour"} — storm, nothing sailing.`
      : `Worked ${port ? port.name : "the docks"} as a ${type}. Looking for a ship to crew.`
  );
}

/** Passage offer from a captain to a lingering player. */
function doPassageOffer(director, citizen, record, nowMs) {
  void director;
  const ship = shipFor(record.username, record.kingdomId ?? record.kingdom);
  const dest = destinationFor(record.username, record.kingdomId ?? record.kingdom, nowMs);
  const line = offerLineFor(Math.random, ship, dest);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(
    record.username,
    `Offering passage on ${ship.name} (${ship.type}) to ${dest ? dest.name : "the next port"} — sails at dawn.`
  );
}

/** Ship-arrival announcement — the crowd moment. */
function doArrival(director, citizen, record, nowMs) {
  void director;
  const ship = shipFor(record.username, record.kingdomId ?? record.kingdom);
  const line = arrivalLineFor(Math.random, ship, ship.port);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `${ship.name} (${ship.type}) arrived at ${ship.port ? ship.port.name : "the harbour"}.`);
}

/**
 * Today's voyage for a captain — exported so sailing/quest systems can
 * offer real passage later. Actual booking rides on the dialogue/LLM
 * tier; this is the schedule-side hook.
 */
function voyageFor(username, kingdom, dateMs) {
  const type = sailorTypeFor(username);
  if (type !== SAILOR_CAPTAIN) return null;
  const ship = shipFor(username, kingdom);
  return {
    ship: ship.name,
    shipType: ship.type,
    from: ship.port ? ship.port.name : "the harbour",
    to: (destinationFor(username, kingdom, dateMs) || {}).name || "the next port",
    inPort: shipInPortFor(username, dateMs),
  };
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  void director;
  try {
    const players = citizen?.getLocalPlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  tickSailors,
  // Pure helpers for tests and integration:
  hashStr,
  sailorTypeFor,
  portFor,
  shipFor,
  destinationFor,
  shipInPortFor,
  weatherFor,
  isStorm,
  workLineFor,
  arrivalLineFor,
  offerLineFor,
  voyageFor,
  animFor,
  shouldFire,
  shouldOffer,
  shouldAnnounceArrival,
  pickOne,
  isRealPlayer,
  withinTiles,
  SAILOR_TYPES,
  PORTS,
  SHIP_TYPES,
  SHIP_NAMES,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastOfferByCitizen.clear();
    lastArrivalByCitizen.clear();
    lastPruneAt = 0;
  },
};
