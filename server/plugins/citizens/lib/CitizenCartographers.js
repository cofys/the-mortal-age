"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenCartographers — cartographer citizens who map the world: surveyors
 * pace the field with chains and theodolites, mapmakers draft at the chart
 * desk, chart-explorers return from the wilds with new coastlines, and
 * sellers hawk the day's maps from their stalls.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a cartographer trade (or
 *   none) from their username hash — no storage, stable across restarts.
 *   Studio assignment prefers the citizen's kingdom. Daily survey routes,
 *   map catalogs and charting discoveries are derived from date + hash, so
 *   the simulation runs with zero players online at zero token cost. Map
 *   sales, commissions and survey hires are recorded in an in-memory ledger
 *   (7-day TTL, pruned) that the interaction-tier LLM reads as its source
 *   of truth. Chart subjects are tied to the real CitizenExplorers
 *   discoveries and CitizenSailors ports via lazy require, so the fiction
 *   stays consistent end to end.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Cartographers visibly work their craft: surveyors pacing with chalked
 *   markers, mapmakers drafting at desks, sellers hawking the day's maps,
 *   rare masterwork unveilings and new-discovery announcements as the
 *   crowd moments. Sellers offer custom commissions to lingering players;
 *   surveyors offer to guide map buyers to the places they charted. Work
 *   is journaled once per loop so the LLM mouth answers "what are you
 *   working on?" truthfully.
 *
 * Zero LLM: scripted emote pools, work/hawk/announcement/commission lines,
 * chance-gated. No invented animation IDs — emotes and forceChat only.
 *
 * Wired into the director proximity tick right after the messengers block.
 * Plain-node testable: CitizenCartographers.test.js.
 */

// === Tuning: all magic numbers here ===
const CARTOGRAPHER_RADIUS = 40; // tiles — visible work range (same as sailors/messengers)
const OFFER_RADIUS = 14; // tiles — commission offers, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const OFFER_COOLDOWN_MS = 4 * 60 * 60 * 1000; // commission offers at most every 4h
const OFFER_CHANCE = 0.35;
const ANNOUNCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // discoveries at most every 6h
const ANNOUNCE_CHANCE = 0.45; // discoveries are crowd moments, fire eagerly
const DISCOVERY_DAY_CHANCE = 0.08; // a studio charts something new this often
const STUDIO_HOURS_OPEN = 7; // 07:00
const STUDIO_HOURS_CLOSE = 19; // 19:00

// === Cartographer types ===
const CARTO_SURVEYOR = "surveyor";
const CARTO_MAPMAKER = "mapmaker";
const CARTO_EXPLORER = "chart-explorer";
const CARTO_SELLER = "seller";
const CARTO_TYPES = Object.freeze([CARTO_SURVEYOR, CARTO_MAPMAKER, CARTO_EXPLORER, CARTO_SELLER]);

// === Studios (names players recognise; kingdoms for derived assignment) ===
const STUDIOS = Object.freeze([
  { name: "the Varrock chart house", short: "varrock", kingdom: "misthalin" },
  { name: "the Lumbridge map loft", short: "lumbridge", kingdom: "misthalin" },
  { name: "the Port Sarim chart room", short: "portsarim", kingdom: "misthalin" },
  { name: "the Falador surveyor's office", short: "falador", kingdom: "asgarnia" },
  { name: "the Port Sarim packet office map desk", short: "packetsarim", kingdom: "asgarnia" },
  { name: "the Ardougne map market", short: "ardougne", kingdom: "kandarin" },
  { name: "the Catherby chart stall", short: "catherby", kingdom: "kandarin" },
  { name: "the Keldagrim deep survey", short: "keldagrim", kingdom: "keldagrim" },
  { name: "the Darkmeyer night atlas", short: "darkmeyer", kingdom: "morytania" },
  { name: "the Al Kharid desert survey", short: "alkharid", kingdom: "kharidian" },
]);

// === Charted regions (kingdom-preferred subjects for the day's maps) ===
const REGIONS = Object.freeze([
  { name: "Misthalin", kingdom: "misthalin" },
  { name: "Asgarnia", kingdom: "asgarnia" },
  { name: "Kandarin", kingdom: "kandarin" },
  { name: "the Fremennik isles", kingdom: "keldagrim" },
  { name: "Morytania", kingdom: "morytania" },
  { name: "the Kharidian desert", kingdom: "kharidian" },
  { name: "the Wilderness borderlands", kingdom: "misthalin" },
  { name: "the southern coast", kingdom: "kandarin" },
]);

// === Map qualities ===
const QUALITY_ROUGH = "rough sketch";
const QUALITY_FINE = "fine chart";
const QUALITY_MASTERWORK = "masterwork atlas";

// === Discoveries (the crowd moment) ===
const DISCOVERIES = Object.freeze([
  "an uncharted cove",
  "a hidden mountain pass",
  "an ancient ruin",
  "a new river ford",
  "a sheltered anchorage",
  "a lost watchtower",
  "a cave system",
  "a fresh water spring in the wastes",
]);

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastOfferByCitizen = new Map(); // username -> timestamp
const lastAnnounceByCitizen = new Map(); // username -> timestamp

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
  for (const [k, at] of lastAnnounceByCitizen) {
    if (at < cutoff) lastAnnounceByCitizen.delete(k);
  }
}

// === In-memory ledgers (7-day TTL, pruned) ===
const commissions = new Map(); // "buyer|seller" -> { region, quality, at }
const surveyHires = new Map(); // "player|surveyor" -> { region, at }
const playerDiscoveries = []; // [{ player, place, at }] — player contributions
let lastLedgerPruneAt = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPruneAt < 3600 * 1000) return;
  lastLedgerPruneAt = nowMs;
  const cutoff = nowMs - 7 * 24 * 3600 * 1000;
  for (const [k, v] of commissions) {
    if (v.at < cutoff) commissions.delete(k);
  }
  for (const [k, v] of surveyHires) {
    if (v.at < cutoff) surveyHires.delete(k);
  }
  for (let i = playerDiscoveries.length - 1; i >= 0; i--) {
    if (playerDiscoveries[i].at < cutoff) playerDiscoveries.splice(i, 1);
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
 * Cartographer trade for a username, or null for a non-cartographer.
 * ~35% of commoners chart; the trade is hash-derived and stable.
 */
function cartographerTypeFor(username) {
  if (!username) return null;
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "cartographer") return null;
  const h = hashStr("cartographer|" + String(username).toLowerCase());
  return CARTO_TYPES[h % CARTO_TYPES.length];
}

/**
 * The studio this citizen works from, preferring their kingdom (falls
 * back to all studios).
 */
function studioFor(username, kingdom) {
  let pool = (STUDIOS || []).filter((s) => s.kingdom === kingdom);
  if (pool.length === 0) pool = STUDIOS;
  const h = hashStr("cartostudio|" + String(username).toLowerCase());
  return pool[h % pool.length];
}

/**
 * The region this citizen is surveying/charting today — derived, so the
 * survey rhythm is stable per day and agrees across the simulation.
 */
function regionFor(username, kingdom, dateMs) {
  let pool = (REGIONS || []).filter((r) => r.kingdom === kingdom);
  if (pool.length === 0) pool = REGIONS;
  const h = hashStr("cartoregion|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return pool[h % pool.length];
}

/**
 * The day's map catalog for this citizen: 2-4 maps of their kingdom's
 * regions with derived qualities. Stable per day.
 */
function mapsFor(username, kingdom, dateMs) {
  const day = Math.floor(dateMs / 86400000);
  const h = hashStr("cartomaps|" + String(username).toLowerCase() + "|" + day);
  const count = 2 + (h % 3);
  const maps = [];
  for (let i = 0; i < count; i++) {
    const region = regionFor(username + "#" + i, kingdom, dateMs);
    const qh = hashStr("cartoqual|" + String(username).toLowerCase() + "|" + day + "|" + i);
    const quality = qh % 20 === 0 ? QUALITY_MASTERWORK : qh % 4 === 0 ? QUALITY_FINE : QUALITY_ROUGH;
    maps.push({ region: region.name, quality });
  }
  return maps;
}

/**
 * True if this citizen's studio charts a new discovery today (~8%).
 * Derived per-day from a hash.
 */
function discoveryFor(username, dateMs) {
  const h = hashStr("cartodisc|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  if (h % 100 >= DISCOVERY_DAY_CHANCE * 100) return null;
  return DISCOVERIES[h % DISCOVERIES.length];
}

/**
 * True during studio hours (07:00-19:00 server time).
 */
function isStudioOpen(dateMs) {
  const d = new Date(dateMs);
  const h = d.getHours();
  return h >= STUDIO_HOURS_OPEN && h < STUDIO_HOURS_CLOSE;
}

// === Lazy cross-module ties (best-effort, never throw) ===
let _explorersDiscoveries = null;
function explorersDiscoveries() {
  if (_explorersDiscoveries === null) {
    try {
      _explorersDiscoveries = require("./CitizenExplorers").DISCOVERIES || false;
    } catch {
      _explorersDiscoveries = false;
    }
  }
  return _explorersDiscoveries || DISCOVERIES;
}

let _sailorPorts = null;
function sailorPorts() {
  if (_sailorPorts === null) {
    try {
      _sailorPorts = require("./CitizenSailors").PORTS || false;
    } catch {
      _sailorPorts = false;
    }
  }
  return _sailorPorts;
}

// === Line pools ===
const WORK_LINES = Object.freeze({
  [CARTO_SURVEYOR]: [
    "Surveying the land.",
    "Mapping the terrain.",
    "Surveyor at work.",
  ],
  [CARTO_MAPMAKER]: [
    "Drawing up maps.",
    "Fresh charts here.",
    "Mapmaker working.",
  ],
  [CARTO_EXPLORER]: [
    "Charting new lands.",
    "Explorer mapping.",
    "New territories drawn.",
  ],
  [CARTO_SELLER]: [
    "Maps for sale!",
    "Charts here, cheap!",
    "Need a map?",
  ],
});

const HAWK_LINES = [
  "Maps! Fresh charts of {region}, drawn this very week!",
  "Don't travel blind — a {quality} of {region}, going cheap!",
  "Charts! Know where you're going before you get there!",
  "The finest maps in the kingdom — {region}, {quality}!",
];

const OFFER_LINES = [
  "Looking for something custom? I can chart any corner of {region} you name.",
  "A personal commission, friend? My pen is at your service.",
  "Tell me where you're headed and I'll draft you a proper chart.",
];

const ANNOUNCE_LINES = [
  "Hear this! We've charted {discovery} — come see the new lines!",
  "News from the survey! {discovery} is on the maps at last!",
  "Fresh ink, friends! {discovery} now sits where the blank space was!",
];

const HIRE_LINES = [
  "Heading into {region}? I know every fold of it — hire me as your guide.",
  "I've walked {region} end to end. Take me along and you won't get lost.",
];

function renderLine(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

// === Journal (best-effort, never throws) ===
let _journalEvent = null;
function journalEvent() {
  if (_journalEvent === null) {
    try {
      _journalEvent = require("./CitizenJournal").getJournal() || false;
    } catch {
      _journalEvent = false;
    }
  }
  return _journalEvent;
}

// Canonical: getJournal().log(name, kind, text). The journalEvent export
// probe is dead — CitizenJournal only exports getJournal(); calling the
// journal object as a function never worked (caught by the try/catch).
function journal(username, text, kind) {
  try {
    const j = journalEvent();
    if (j) j.log?.(username, kind || "cartography", text);
  } catch {
    // best-effort
  }
}

// === Rumor seeding (best-effort, never throws) ===
let _seedRumor = null;
function seedRumor() {
  if (_seedRumor === null) {
    try {
      _seedRumor = require("./CitizenRumors").seedRumor || false;
    } catch {
      _seedRumor = false;
    }
  }
  return _seedRumor;
}

function seedDiscoveryRumor(discovery, studio) {
  try {
    const s = seedRumor();
    // Canonical: seedRumor(rng, event) — the bare-string call is dead
    // (returns null); pass an event object.
    if (s) s(Math.random, { kind: "work", what: `The cartographers at ${studio} have charted ${discovery}.` });
  } catch {
    // best-effort
  }
}

// ============================================================================
// Public API for the LLM dialogue tier (data access, no ticking here).
// ============================================================================

/**
 * Record a player commissioning a custom map from a seller.
 * Returns true on success.
 */
function commissionMap(buyerName, sellerName, region, quality, nowMs) {
  if (!buyerName || !sellerName || !region) return false;
  if (cartographerTypeFor(sellerName) !== CARTO_SELLER) return false;
  pruneLedgers(nowMs ?? Date.now());
  const key = String(buyerName).toLowerCase() + "|" + String(sellerName).toLowerCase();
  commissions.set(key, { region, quality: quality || QUALITY_FINE, at: nowMs ?? Date.now() });
  journal(sellerName, `Took a commission from ${buyerName}: ${quality || QUALITY_FINE} of ${region}.`);
  journal(buyerName, `Commissioned a ${quality || QUALITY_FINE} of ${region} from ${sellerName}.`);
  return true;
}

/**
 * Look up a commission for a buyer/seller pair, or null.
 */
function commissionFor(buyerName, sellerName, nowMs) {
  pruneLedgers(nowMs ?? Date.now());
  const key = String(buyerName).toLowerCase() + "|" + String(sellerName).toLowerCase();
  return commissions.get(key) || null;
}

/**
 * Record a player hiring a surveyor as a guide to a region.
 * Returns true on success.
 */
function hireSurveyor(playerName, surveyorName, region, nowMs) {
  if (!playerName || !surveyorName || !region) return false;
  if (cartographerTypeFor(surveyorName) !== CARTO_SURVEYOR) return false;
  pruneLedgers(nowMs ?? Date.now());
  const key = String(playerName).toLowerCase() + "|" + String(surveyorName).toLowerCase();
  surveyHires.set(key, { region, at: nowMs ?? Date.now() });
  journal(surveyorName, `Hired as a guide by ${playerName} for ${region}.`);
  journal(playerName, `Hired ${surveyorName} as a survey guide for ${region}.`);
  return true;
}

/**
 * Look up a survey hire for a player/surveyor pair, or null.
 */
function surveyHireFor(playerName, surveyorName, nowMs) {
  pruneLedgers(nowMs ?? Date.now());
  const key = String(playerName).toLowerCase() + "|" + String(surveyorName).toLowerCase();
  return surveyHires.get(key) || null;
}

/**
 * Record a player contributing a discovery (a place they found).
 * Returns true on success.
 */
function contributeDiscovery(playerName, place, nowMs) {
  if (!playerName || !place) return false;
  pruneLedgers(nowMs ?? Date.now());
  playerDiscoveries.push({ player: playerName, place, at: nowMs ?? Date.now() });
  journal(playerName, `Reported a discovery to the cartographers: ${place}.`);
  return true;
}

/**
 * Recent player-contributed discoveries (newest first), up to `limit`.
 */
function recentDiscoveries(limit, nowMs) {
  pruneLedgers(nowMs ?? Date.now());
  return playerDiscoveries.slice(-(limit || 5)).reverse();
}

// ============================================================================
// Chance gates — pure, testable.
// ============================================================================

function shouldWork(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < WORK_COOLDOWN_MS) return false;
  return rng() < WORK_CHANCE;
}

function shouldOffer(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < OFFER_COOLDOWN_MS) return false;
  return rng() < OFFER_CHANCE;
}

function shouldAnnounce(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < ANNOUNCE_COOLDOWN_MS) return false;
  return rng() < ANNOUNCE_CHANCE;
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

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → cartographer? → materialized →
// real player near → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickCartographers(director, nowMs) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        // 2. Must be a cartographer (hash-derived, cheap)
        const type = cartographerTypeFor(record.username);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. A real player must be within visible range
        if (!anyRealPlayerNear(director, citizen, CARTOGRAPHER_RADIUS)) continue;

        // 5. Chance gate + do the thing (scripted, zero LLM)
        if (Math.random() >= WORK_CHANCE) continue;

        const kingdom = record.kingdom || record[Object.keys(record).find((k) => k.toLowerCase().includes("kingdom")) || ""] || "misthalin";
        const studio = studioFor(record.username, kingdom);
        const region = regionFor(record.username, kingdom, nowMs);
        const lines = WORK_LINES[type] || [];
        const line = lines.length > 0 ? pickOne(Math.random, lines) : null;

        if (type === CARTO_SELLER) {
          // Sellers hawk the day's maps
          const maps = mapsFor(record.username, kingdom, nowMs);
          const featured = maps[0];
          const hawkVars = { region: featured ? featured.region : region.name, quality: featured ? featured.quality : QUALITY_FINE };
          const hawk = renderLine(pickOne(Math.random, HAWK_LINES), hawkVars);
          try {
            { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [hawk] })); }
          } catch {
            // engine call failed — skip silently
          }
          journal(record.username, `Hawked maps at ${studio.name}: ${maps.map((m) => `${m.quality} of ${m.region}`).join(", ")}.`);
        } else {
          // Surveyors, mapmakers, chart-explorers work visibly
          if (line) {
            try {
              { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [renderLine(line, { their: "their" })] })); }
            } catch {
              // engine call failed — skip silently
            }
          }
          journal(record.username, `Worked the ${type} trade at ${studio.name}, charting ${region.name}.`);
        }

        // 6. Rare discovery announcement (crowd moment)
        const discovery = discoveryFor(record.username, nowMs);
        const lastAnn = lastAnnounceByCitizen.get(record.username) || 0;
        if (discovery && shouldAnnounce(Math.random, lastAnn, nowMs)) {
          const announce = renderLine(pickOne(Math.random, ANNOUNCE_LINES), { discovery });
          try {
            { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [announce] })); }
          } catch {
            // engine call failed — skip silently
          }
          journal(record.username, `Announced a new charting: ${discovery}, from ${studio.name}.`);
          seedDiscoveryRumor(discovery, studio.name);
          lastAnnounceByCitizen.set(record.username, nowMs);
        }

        // 7. Commission/guide offers for lingering players (close range)
        const lastOff = lastOfferByCitizen.get(record.username) || 0;
        if (shouldOffer(Math.random, lastOff, nowMs) && anyRealPlayerNear(director, citizen, OFFER_RADIUS)) {
          let offer = null;
          if (type === CARTO_SELLER) {
            offer = renderLine(pickOne(Math.random, OFFER_LINES), { region: region.name });
          } else if (type === CARTO_SURVEYOR) {
            offer = renderLine(pickOne(Math.random, HIRE_LINES), { region: region.name });
          }
          if (offer) {
            try {
              { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [offer] })); }
            } catch {
              // engine call failed — skip silently
            }
            lastOfferByCitizen.set(record.username, nowMs);
          }
        }

        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // Per-citizen failure must never break the loop.
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-cartographers] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickCartographers,
  // Pure helpers for tests and integration:
  hashStr,
  cartographerTypeFor,
  studioFor,
  regionFor,
  mapsFor,
  discoveryFor,
  isStudioOpen,
  renderLine,
  commissionMap,
  commissionFor,
  hireSurveyor,
  surveyHireFor,
  contributeDiscovery,
  recentDiscoveries,
  explorersDiscoveries,
  sailorPorts,
  shouldWork,
  shouldOffer,
  shouldAnnounce,
  pickOne,
  isRealPlayer,
  withinTiles,
  CARTO_TYPES,
  CARTO_SURVEYOR,
  CARTO_MAPMAKER,
  CARTO_EXPLORER,
  CARTO_SELLER,
  STUDIOS,
  REGIONS,
  DISCOVERIES,
  QUALITY_ROUGH,
  QUALITY_FINE,
  QUALITY_MASTERWORK,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastOfferByCitizen.clear();
    lastAnnounceByCitizen.clear();
    commissions.clear();
    surveyHires.clear();
    playerDiscoveries.length = 0;
    lastPruneAt = 0;
    lastLedgerPruneAt = 0;
    _explorersDiscoveries = null;
    _sailorPorts = null;
    _journalEvent = null;
    _seedRumor = null;
  },
};
