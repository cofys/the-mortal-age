"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenJewelers — jeweler citizens who cut gems, craft jewelry, and trade
 * precious goods: gem cutters facet raw stones, goldsmiths work gold and
 * silver into jewelry, appraisers value gems for customers, and traders buy
 * and sell the finished wares.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a jeweler trade (or none)
 *   from their username hash — no storage, stable across restarts. Workshop
 *   assignment prefers the citizen's kingdom. Gem tables mirror the
 *   engine's gem-cutting tiers (Crafting.plugin.js), and the metal supply
 *   reads the real tables from CitizenMiners (gold/silver ore) and
 *   CitizenBlacksmiths (smelted metal) via lazy require with fallback, so
 *   the fiction stays consistent end to end. Piece-of-the-day rhythm,
 *   appraisals and trades are journaled once per visible loop so the
 *   interaction-tier LLM answers "what have you been up to?" truthfully
 *   (and can riff on selling today's jewels — buying dialogue is the
 *   LLM's job, journaled state is its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Jewelers visibly work their workshops: cutting gems at the bench,
 *   shaping gold, appraising stones, haggling over wares (engine-verified
 *   gem-cutting anims 885-892 from Crafting.plugin.js). Fresh wares are
 *   hawked, rare masterpiece unveilings are the crowd moment, and
 *   lingering players get commission offers (goldsmiths and gem cutters
 *   take custom work; traders buy and sell) — the commission dialogue is
 *   LLM, the journaled commission is its source of truth.
 *
 * Zero LLM: scripted emote pools, announcement/hawk/commission lines,
 * chance-gated.
 *
 * Ties into CitizenMiners (raw gems and ore from the mines),
 * CitizenBlacksmiths (smelted metal for settings), CitizenMarketStalls
 * (jewelsFor supply hook), CitizenWarfare (appraisers value war
 * spoils), CitizenWeddings (goldsmiths make wedding bands).
 *
 * Wired into the director tick right after the blacksmiths/alchemists/
 * herbalists block. Plain-node testable: CitizenJewelers.test.js.
 */

// === Tuning: all magic numbers here ===
const WORK_RADIUS = 40; // tiles — visible workshop work (same as the other work-loop features)
const HAWK_RADIUS = 14; // tiles — wares hawking / appraisal talk, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const HAWK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // hawk fresh jewels at most every 4h
const HAWK_CHANCE = 0.35;
const COMMISSION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // commission offers at most every 6h
const COMMISSION_CHANCE = 0.3;
const MASTERPIECE_CHANCE = 0.1; // a visible loop finishes a rare masterpiece this often

// Engine animations (from server/plugins/skills/Crafting.plugin.js — the
// engine's gem-cutting set; anim id varies by gem tier).
const ANIM_GEM_CUT = Object.freeze({
  opal: 890,
  jade: 891,
  "red topaz": 892,
  sapphire: 888,
  emerald: 889,
  ruby: 887,
  diamond: 886,
  dragonstone: 885,
  onyx: 2717,
  zenyte: 7185,
});

// === Jeweler types ===
const JEWELER_GEMCUTTER = "gem cutter";
const JEWELER_GOLDSMITH = "goldsmith";
const JEWELER_APPRAISER = "appraiser";
const JEWELER_TRADER = "trader";
const JEWELER_TYPES = Object.freeze([JEWELER_GEMCUTTER, JEWELER_GOLDSMITH, JEWELER_APPRAISER, JEWELER_TRADER]);

// === Workshops (names players recognise; kingdoms for derived assignment —
// we never need coordinates, only names) ===
const WORKSHOPS = Object.freeze([
  { name: "the Varrock jewelers' row", short: "varrockjewels", kingdom: "misthalin", kind: "shop" },
  { name: "the Lumbridge gem bench", short: "lumbridgegems", kingdom: "misthalin", kind: "bench" },
  { name: "the Ardougne jewel market", short: "ardougnejewels", kingdom: "kandarin", kind: "market" },
  { name: "the Seers' village lapidary", short: "seerslapidary", kingdom: "kandarin", kind: "atelier" },
  { name: "the Falador goldsmiths' hall", short: "faladorgoldsmiths", kingdom: "asgarnia", kind: "hall" },
  { name: "the Burthorpe appraisers' tent", short: "burthorpeappraise", kingdom: "asgarnia", kind: "tent" },
  { name: "the Keldagrim gem exchange", short: "keldagrimgems", kingdom: "keldagrim", kind: "exchange" },
  { name: "the Dwarven assay office", short: "dwarvenassay", kingdom: "keldagrim", kind: "office" },
  { name: "the Darkmeyer jewel house", short: "darkmeyerjewels", kingdom: "morytania", kind: "house" },
  { name: "the Meiyerditch stone cutters' den", short: "meiyerditchcutters", kingdom: "morytania", kind: "den" },
]);

// === Gems by tier (mirrors the engine's gem-cutting tiers) ===
const GEMS = Object.freeze([
  { name: "opal", tier: 1, anim: 890 },
  { name: "jade", tier: 2, anim: 891 },
  { name: "red topaz", tier: 3, anim: 892 },
  { name: "sapphire", tier: 4, anim: 888 },
  { name: "emerald", tier: 5, anim: 889 },
  { name: "ruby", tier: 6, anim: 887 },
  { name: "diamond", tier: 7, anim: 886 },
  { name: "dragonstone", tier: 8, anim: 885 },
  { name: "onyx", tier: 9, anim: 2717 },
  { name: "zenyte", tier: 10, anim: 7185 },
]);

// === Jewelry pieces by jeweler type ===
const GEMCUTTER_WARES = Object.freeze([
  "faceted sapphires",
  "polished emeralds",
  "brilliant-cut diamonds",
  "cabochon rubies",
  "star-cut opals",
]);

const GOLDSMITH_WARES = Object.freeze([
  "gold rings",
  "silver necklaces",
  "gem-set amulets",
  "golden bracelets",
  "silver tiaras",
]);

const APPRAISER_WARES = Object.freeze([
  "certified gem valuations",
  "sealed appraisal scrolls",
  "graded loose stones",
  "assay reports",
]);

const TRADER_WARES = Object.freeze([
  "loose diamonds",
  "gold chains",
  "sapphire amulets",
  "ruby rings",
  "pearl strands",
]);

// === Masterpieces (the rare crowd moment) ===
const MASTERPIECES = Object.freeze([
  "a diamond crown fit for a king",
  "an emerald necklace with a dragonstone centerpiece",
  "a wedding band of white gold and zenyte",
  "an onyx amulet carved with the kingdom's crest",
  "a sapphire circlet that catches the light like water",
]);

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = Object.freeze({
  "gem cutter": [
    "Cutting gems today.",
    "Facets and fire.",
    "Gemcutter at work.",
  ],
  goldsmith: [
    "Working gold.",
    "Goldsmith here.",
    "Shaping precious metals.",
  ],
  appraiser: [
    "Appraising valuables.",
    "What's it worth?",
    "Appraiser open.",
  ],
  trader: [
    "Trading gems.",
    "Jewels bought and sold.",
    "Trader here.",
  ],
});

const HAWK_LINES = Object.freeze({
  "gem cutter": [
    "Fresh-cut {wares} — cut this very morning!",
    "{Wares} — the facets catch every candle in the room!",
  ],
  goldsmith: [
    "{Wares} — forged in {gold}, fit for nobility!",
    "A new batch of {wares} — come and see the shine!",
  ],
  appraiser: [
    "Got a stone you're unsure of? I'll value it true — {wares}!",
    "Honest appraisals! {Wares}, sealed and certified!",
  ],
  trader: [
    "Deals on {wares} — today only!",
    "{Wares} at trader's prices — don't let them pass you by!",
  ],
});

const COMMISSION_LINES = Object.freeze({
  "gem cutter": [
    "Want a stone cut to your own design? I take commissions, friend.",
    "Bring me a rough gem and I'll facet it however you fancy.",
  ],
  goldsmith: [
    "A custom ring, perhaps? A band engraved with a name? I can make it.",
    "I take commissions — wedding bands, signet rings, whatever you dream up.",
  ],
  appraiser: [
    "Inherited something glittery? Let me appraise it properly for you.",
    "If you ever need a stone valued or certified, my loupe is ready.",
  ],
  trader: [
    "Looking to buy or sell? I deal in gems and gold, fair prices.",
    "Got stones to sell? I've got coin and an eye for quality.",
  ],
});

const MASTERPIECE_LINES = Object.freeze([
  "Behold — {masterpiece}! My finest work yet!",
  "It is done: {masterpiece}. Come and marvel!",
]);

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastHawkByCitizen = new Map(); // username -> timestamp
const lastCommissionByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWorkByCitizen) {
    if (at < cutoff) lastWorkByCitizen.delete(k);
  }
  for (const [k, at] of lastHawkByCitizen) {
    if (at < cutoff) lastHawkByCitizen.delete(k);
  }
  for (const [k, at] of lastCommissionByCitizen) {
    if (at < cutoff) lastCommissionByCitizen.delete(k);
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

/**
 * Which jeweler trade this citizen has (or null for ~65% of commoners).
 * Deterministic from the username hash — stable across restarts, no storage.
 */
function jewelerTypeFor(username) {
  if (!username) return null;
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "jeweler") return null;
  const h = hashStr("jeweler|" + String(username).toLowerCase());
  return JEWELER_TYPES[h % JEWELER_TYPES.length];
}

/** Workshop for this citizen, preferring their kingdom. */
function workshopFor(username, kingdom, type) {
  const own = WORKSHOPS.filter((w) => w.kingdom === kingdom);
  const pool = own.length > 0 ? own : WORKSHOPS;
  // Traders and appraisers prefer market/exchange/office workshops.
  if (type === JEWELER_TRADER || type === JEWELER_APPRAISER) {
    const tradeKinds = pool.filter((w) => w.kind === "market" || w.kind === "exchange" || w.kind === "office" || w.kind === "tent");
    if (tradeKinds.length > 0) {
      return tradeKinds[hashStr("workshop|" + String(username).toLowerCase()) % tradeKinds.length];
    }
  }
  return pool[hashStr("workshop|" + String(username).toLowerCase()) % pool.length];
}

/** The gem this gem cutter is working today (by gem name). */
function gemFor(username, dateMs) {
  const day = Math.floor(dateMs / 86400000);
  const h = hashStr("gem|" + String(username).toLowerCase() + "|" + day);
  return GEMS[h % GEMS.length];
}

/** The metal supply today, derived from the miners' and smiths' real tables. */
function metalsFor() {
  try {
    const miners = require("./CitizenMiners");
    const ores = miners.ORES || [];
    const metals = ores.filter((o) => o === "gold" || o === "silver");
    if (metals.length > 0) return metals;
  } catch {
    // Fall back below.
  }
  try {
    const smiths = require("./CitizenBlacksmiths");
    const metals = smiths.METALS || [];
    const precious = metals.filter((m) => /gold|silver/i.test(String(m)));
    if (precious.length > 0) return precious.map((m) => String(m).toLowerCase());
  } catch {
    // Fall back below.
  }
  return ["gold", "silver"];
}

/** Wares of the day for this jeweler type. */
function waresFor(username, type, dateMs) {
  const day = Math.floor(dateMs / 86400000);
  const h = hashStr("wares|" + String(username).toLowerCase() + "|" + day);
  switch (type) {
    case JEWELER_GEMCUTTER: return GEMCUTTER_WARES[h % GEMCUTTER_WARES.length];
    case JEWELER_GOLDSMITH: return GOLDSMITH_WARES[h % GOLDSMITH_WARES.length];
    case JEWELER_APPRAISER: return APPRAISER_WARES[h % APPRAISER_WARES.length];
    default: return TRADER_WARES[h % TRADER_WARES.length];
  }
}

/** Rare masterpiece finished today (or null). */
function masterpieceFor(username, dateMs) {
  const day = Math.floor(dateMs / 86400000);
  const h = hashStr("masterpiece|" + String(username).toLowerCase() + "|" + day);
  if (h % 10 !== 0) return null; // only some days produce masterpieces
  return MASTERPIECES[h % MASTERPIECES.length];
}

function workLineFor(rng, type) {
  return pickOne(rng, WORK_LINES[type] || WORK_LINES[JEWELER_TRADER]);
}

function hawkLineFor(rng, type, wares, metals) {
  const line = pickOne(rng, HAWK_LINES[type] || HAWK_LINES[JEWELER_TRADER]);
  const gold = metals.length > 0 ? pickOne(rng, metals) : "gold";
  return line
    .replace("{wares}", wares)
    .replace("{Wares}", wares.charAt(0).toUpperCase() + wares.slice(1))
    .replace("{gold}", gold);
}

function commissionLineFor(rng, type) {
  return pickOne(rng, COMMISSION_LINES[type] || COMMISSION_LINES[JEWELER_TRADER]);
}

function masterpieceLineFor(rng, masterpiece) {
  return pickOne(rng, MASTERPIECE_LINES).replace("{masterpiece}", masterpiece);
}

/**
 * Supply hook for CitizenMarketStalls: the jewels this jeweler has on hand
 * today. Same pattern as the other producer hooks (farmers' farmProduceFor,
 * fishers' fishCatchFor, cooks' mealOfTheDayFor).
 */
function jewelsFor(username, kingdom, dateMs) {
  const type = jewelerTypeFor(username);
  if (!type) return [];
  return [waresFor(username, type, dateMs)];
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

/** Chance-gate helpers, pure for tests. */
function shouldFire(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < WORK_COOLDOWN_MS) return false;
  return rng() < WORK_CHANCE;
}
function shouldHawk(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < HAWK_COOLDOWN_MS) return false;
  return rng() < HAWK_CHANCE;
}
function shouldOfferCommission(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < COMMISSION_COOLDOWN_MS) return false;
  return rng() < COMMISSION_CHANCE;
}

// === Journal access (lazy, best-effort) ===
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

/** Play the gem-cutting animation, best-effort (engine-verified anims). */
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

// ============================================================================
// Visible work loops — three passes, all gated.
// ============================================================================

function doJewelerWork(director, record, citizen, type, nowMs) {
  const line = workLineFor(Math.random, type);
  if (!line) return;
  const workshop = workshopFor(record.username, record.kingdom, type);
  // Rare masterpiece unveilings are the crowd moment.
  if (Math.random() < MASTERPIECE_CHANCE) {
    const masterpiece = masterpieceFor(record.username, nowMs);
    if (masterpiece) {
      try {
        { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [masterpieceLineFor(Math.random, masterpiece)] })); }
      } catch {
        // forceChat is best-effort.
      }
      const gem = type === JEWELER_GEMCUTTER ? gemFor(record.username, nowMs) : null;
      playAnim(director, citizen, gem ? gem.anim : 887);
      journalEvent(record.username, `Finished a masterpiece at ${workshop ? workshop.name : "the workshop"}: ${masterpiece}. The crowd gathered round.`);
      return;
    }
  }
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  // Gem cutters cut today's gem with its engine-verified anim.
  if (type === JEWELER_GEMCUTTER) {
    playAnim(director, citizen, gemFor(record.username, nowMs).anim);
  } else {
    playAnim(director, citizen, 887); // fine hand work
  }
  // One journal line per loop — the LLM's source of truth. Includes the
  // workshop, the wares, and where the materials came from (the miners
  // and the smiths), so "what have you been up to?" is answerable.
  const wares = waresFor(record.username, type, nowMs);
  const metals = metalsFor();
  const metal = metals.length > 0 ? metals[hashStr(record.username) % metals.length] : "gold";
  const material =
    type === JEWELER_GEMCUTTER
      ? `raw ${gemFor(record.username, nowMs).name} from the miners`
      : type === JEWELER_GOLDSMITH
        ? `${metal} from the miners' and smiths' tables`
        : "stones and coin passing over the counter";
  journalEvent(
    record.username,
    `Jewelcraft at ${workshop ? workshop.name : "the workshop"} — working ${material} into ${wares}.`
  );
}

function doJewelerHawk(director, citizen, record, type, nowMs) {
  const wares = waresFor(record.username, type, nowMs);
  const line = hawkLineFor(Math.random, type, wares, metalsFor());
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Hawking fresh wares: ${wares}.`);
}

function doJewelerCommission(director, citizen, record, type) {
  const line = commissionLineFor(Math.random, type);
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Offered ${type} services to a lingering customer.`);
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → commoner → jeweler type → materialized →
// real player near → chance → work. Three passes: workshop work, wares
// hawking, commission offers.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickJewelers(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners jewelcraft (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = jewelerTypeFor(record.username);
        if (!type) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        // 3. Citizen must be materialized (near a player already).
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. A real player must be within sight of the workshop.
        if (!anyRealPlayerNear(director, citizen, WORK_RADIUS)) continue;

        // 5. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= WORK_CHANCE) continue;
        doJewelerWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Wares hawking: tighter radius, own cooldown. Players learn who has
    // the fresh-cut stones and goldwork.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = jewelerTypeFor(record.username);
        if (!type) continue;
        const last = lastHawkByCitizen.get(record.username) || 0;
        if (nowMs - last < HAWK_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= HAWK_CHANCE) continue;
        doJewelerHawk(director, citizen, record, type, nowMs);
        lastHawkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Commission offers: goldsmiths and gem cutters take custom work;
    // appraisers value stones; traders buy and sell.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = jewelerTypeFor(record.username);
        if (!type) continue;
        const last = lastCommissionByCitizen.get(record.username) || 0;
        if (nowMs - last < COMMISSION_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= COMMISSION_CHANCE) continue;
        doJewelerCommission(director, citizen, record, type);
        lastCommissionByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-jewelers] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickJewelers,
  // Pure helpers for tests and integration:
  hashStr,
  jewelerTypeFor,
  workshopFor,
  gemFor,
  waresFor,
  metalsFor,
  masterpieceFor,
  workLineFor,
  hawkLineFor,
  commissionLineFor,
  masterpieceLineFor,
  jewelsFor,
  shouldFire,
  shouldHawk,
  shouldOfferCommission,
  pickOne,
  isRealPlayer,
  withinTiles,
  JEWELER_TYPES,
  WORKSHOPS,
  GEMS,
  GEMCUTTER_WARES,
  GOLDSMITH_WARES,
  APPRAISER_WARES,
  TRADER_WARES,
  MASTERPIECES,
  ANIM_GEM_CUT,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastHawkByCitizen.clear();
    lastCommissionByCitizen.clear();
    lastPruneAt = 0;
  },
};
