"use strict";

/**
 * CitizenArtisans — master craftspeople with workshops, masterpieces,
 * commissions, apprentices, and renown.
 *
 * WHAT IT DOES (data tier, free — runs on the 60s slow tick):
 *   Eligible commoners are deterministically assigned one of five artisan
 *   trades (blacksmith, jeweler, carpenter, tailor, alchemist) — stable
 *   across restarts via name hash, capped at one per trade per kingdom.
 *   Artisans slowly accumulate renown: completing masterpieces (+2) and
 *   player commissions (+3). Masterpieces get generated unique names.
 *   Commissions progress on timers and complete on their own.
 *
 * WHAT THE PLAYER SEES (interaction tier, fast ~10s tick, only near real
 * players): the artisan works visibly at their workshop (walk to the spot,
 * face it, play the trade animation, emote the work), reveals finished
 * masterpieces with a flourish, announces completed commissions by name,
 * offers commissions to lingering players, and teaches their apprentice
 * when they have one (ties into CitizenApprentices' pair data).
 *
 * Commission dialogue itself is handled by the LLM chat layer, which reads
 * the journal — this module only tracks commission state, timers, and
 * completion. Zero LLM anywhere in here.
 *
 * Deliberately NOT CitizenWorkLoops:
 *   - WorkLoops assigns any idle commoner near a station to a generic
 *     ~60s micro-loop and never moves them.
 *   - Artisans are a stable identity (the town blacksmith, not "a
 *     commoner"), work at their OWN workshop spots, take commissions,
 *     make named masterpieces, and build renown over days.
 * Deliberately NOT CitizenCrafting:
 *   - CitizenCrafting is the supply-chain root (suppliers producing goods
 *     on wall-clock time). This module is the visible master craftsperson
 *     — the personality players meet, commission from, and remember.
 *
 * Wiring: slow tick tickArtisans() next to CitizenApprentices in the
 * director's 60s tick; fast tick tickArtisanLife() in tickProximity() after
 * the shopkeeping layer. Per-citizen try/catch: one bad bot never breaks
 * the tick. Plain-node testable: CitizenArtisans.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { agentRng, chance } = require("./humanizer");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { normalizeName } = require("./CitizenBonds");

// === Tuning: all magic numbers here ===
const ARTISANS_PER_TRADE_PER_KINGDOM = 1; // scarcity: one master per trade per town
const PROXIMITY_TILES = 40; // a real player must be this close for visible work
const DWELL_RADIUS = 10; // lingering this close counts as commission interest
const DWELL_TICKS = 6; // ~60s of lingering at ~10s ticks -> commission offered
const WORK_COOLDOWN_MS = 8 * 60 * 1000; // visible work at most this often
const WORK_CHANCE = 0.5; // per eligible artisan per fast tick (staggers starts)
const OFFER_COOLDOWN_MS = 20 * 60 * 1000; // commission offers throttled
const OFFER_CHANCE = 0.3;
const MASTERPIECE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // one masterpiece per 6h max
const MASTERPIECE_CHANCE = 0.15; // per due artisan per slow tick
const COMMISSION_MS = 2 * 60 * 60 * 1000; // commissions take ~2h of uptime
const COMMISSION_COOLDOWN_MS = 30 * 60 * 1000; // between new commissions
const MAX_ACTIVE_COMMISSIONS = 3; // per artisan
const TEACH_COOLDOWN_MS = 45 * 60 * 1000; // apprentice teaching flavor
const TEACH_CHANCE = 0.3;
const RENOWN_MASTERPIECE = 2;
const RENOWN_COMMISSION = 3;

// === Trades ===
const TRADES = Object.freeze({
  blacksmith: Object.freeze({
    label: "blacksmith",
    anim: 898, // anvil hammering (server/plugins/skills)
    anchor: "square",
    offset: [8, -4],
    verb: "*hammers a glowing blade*",
    journal: "Hammered steel at the forge.",
    items: ["rune longsword", "steel platebody", "mithril warhammer", "adamant dagger"],
  }),
  jeweler: Object.freeze({
    label: "jeweler",
    anim: 885, // crafting — fine hand work
    anchor: "market",
    offset: [-3, 2],
    verb: "*sets a gem with delicate tools*",
    journal: "Cut and set gemstones.",
    items: ["diamond ring", "dragonstone amulet", "sapphire necklace", "onyx bracelet"],
  }),
  carpenter: Object.freeze({
    label: "carpenter",
    anim: 1248, // whittling — fiddly hand work
    anchor: "square",
    offset: [-5, 5],
    verb: "*planes a length of oak*",
    journal: "Shaped timber at the workbench.",
    items: ["oak bookshelf", "mahogany table", "willow rocking chair", "teak wardrobe"],
  }),
  tailor: Object.freeze({
    label: "tailor",
    anim: 885, // crafting — needlework reads fine
    anchor: "market",
    offset: [3, -2],
    verb: "*stitches fine cloth*",
    journal: "Sewed garments at the stall.",
    items: ["silk robe", "wool cloak", "linen tunic", "velvet doublet"],
  }),
  alchemist: Object.freeze({
    label: "alchemist",
    anim: 885, // crafting — mixing and measuring
    anchor: "tavern",
    offset: [2, 3],
    verb: "*stirs a bubbling flask*",
    journal: "Brewed tinctures and tonics.",
    items: ["greater healing draught", "swiftness tonic", "stoneskin elixir", "clarity philtre"],
  }),
});
const TRADE_KEYS = Object.freeze(Object.keys(TRADES));

// Masterpiece name parts — generated unique names, data tier.
const MASTERPIECE_PREFIXES = Object.freeze([
  "Dawnbringer", "Oathkeeper", "Thornwhisper", "Emberfall", "Mooncarved",
  "Stormforged", "Giltleaf", "Ravensong", "Kingsbane", "Softlight",
  "Ironbloom", "Wintersmith", "Cinderheart", "Oakenshield", "Starstitched",
]);

const COMMISSION_DETAILS = Object.freeze([
  "balanced for your grip",
  "inlaid with your family crest",
  "sized to your exact measure",
  "etched with protective runes",
  "finished in your house colors",
]);

const COMMISSION_OFFERS = Object.freeze([
  "I take commissions, friend — something made to your measure.",
  "Looking for something special? I craft to order.",
  "A blade, a jewel, a chair — tell me what you dream of, I'll make it real.",
]);

// === State (in-memory; the journal is what persists) ===
const artisans = new Map(); // normalized name -> { trade, kingdomId }
const renown = new Map(); // normalized name -> score
const masterpieces = new Map(); // normalized name -> [{ name, item, trade, createdAt, revealed }]
const commissions = new Map(); // id -> { artisan, commissioner, item, detail, createdAt, dueAt, announced }
const dwell = new Map(); // artisan name -> Map(playerName -> { ticks, lastSeen })
const lastWorkAt = new Map(); // normalized name -> ms
const lastOfferAt = new Map(); // normalized name -> ms
const lastMasterpieceAt = new Map(); // normalized name -> ms
const lastCommissionAt = new Map(); // normalized name -> ms (new commissions)
const lastTeachAt = new Map(); // normalized name -> ms
let commissionSeq = 0;

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. Deterministic trade assignment. */
function hashName(name) {
  const s = String(name ?? "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The artisan trade for a citizen name — stable across restarts. */
function tradeFor(name) {
  return TRADE_KEYS[hashName(name) % TRADE_KEYS.length];
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Generate a masterpiece: a unique name for an item of this trade. */
function masterpieceName(rng, trade) {
  const def = TRADES[trade];
  if (!def) return null;
  return `${pickOne(rng, MASTERPIECE_PREFIXES)}, a masterwork ${pickOne(rng, def.items)}`;
}

/** Generate a commission spec: item + custom detail. */
function commissionSpec(rng, trade) {
  const def = TRADES[trade];
  if (!def) return null;
  return {
    item: pickOne(rng, def.items),
    detail: pickOne(rng, COMMISSION_DETAILS),
  };
}

/** Renown title thresholds. */
function renownTitle(score) {
  if (score >= 30) return "master";
  if (score >= 15) return "renowned";
  if (score >= 5) return "known";
  return "";
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

// Memory-leak plug: prune all cooldown/state maps hourly, drop stale entries.
let lastPruneAt = 0;
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const dayAgo = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWorkAt) if (at < dayAgo) lastWorkAt.delete(k);
  for (const [k, at] of lastOfferAt) if (at < dayAgo) lastOfferAt.delete(k);
  for (const [k, at] of lastMasterpieceAt) if (at < dayAgo) lastMasterpieceAt.delete(k);
  for (const [k, at] of lastCommissionAt) if (at < dayAgo) lastCommissionAt.delete(k);
  for (const [k, at] of lastTeachAt) if (at < dayAgo) lastTeachAt.delete(k);
  // Drop dwell entries for artisans no longer assigned.
  for (const k of dwell.keys()) if (!artisans.has(k)) dwell.delete(k);
  // Drop completed + announced commissions older than a day.
  for (const [id, c] of commissions) {
    if (c.announced && nowMs - c.dueAt > 24 * 3600 * 1000) commissions.delete(id);
  }
}

function journalEvent(citizenName, text) {
  try {
    getJournal().log(citizenName, "craft", text);
  } catch {
    // Non-fatal.
  }
}

// === bot helpers (same shapes as CitizenAlive / CitizenShopkeeping) ===

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

// === workshop anchors ===

function workshopTile(kingdomId, trade) {
  try {
    const def = TRADES[trade];
    if (!def) return null;
    const anchor = siteTileByKingdom(kingdomId, def.anchor);
    if (!anchor) return null;
    return {
      x: anchor.x + def.offset[0],
      y: anchor.y + def.offset[1],
      z: anchor.z ?? 0,
    };
  } catch {
    return null;
  }
}

// === eligibility ===

/** Never poach citizens claimed by CitizenSkilling's sessions. */
function skillingBusy(record) {
  try {
    const sk = require("./CitizenSkilling");
    const name = normalizeName(record.username);
    const sessions = sk._sessions;
    if (!sessions) return false;
    if (sessions.has(name)) return true;
    for (const s of sessions.values()) {
      if (
        (s.members ?? []).some((m) => normalizeName(m) === name) ||
        normalizeName(s.leader) === name
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Never poach citizens in a party or being followed. */
function socialBusy(record) {
  try {
    const { getParty, getFollow } = require("./CitizenBonds");
    return !!(getParty(record.username) || getFollow(record.username));
  } catch {
    return false;
  }
}

/**
 * Artisans are commoners with a craft — never merchants (they run shops),
 * guards, courtiers, or refugees. Must not be claimed by skilling
 * sessions, parties, or follows.
 */
function eligibleArtisan(record) {
  if (!record || record.role !== "commoner") return false;
  const name = normalizeName(record.username);
  if (!name) return false;
  if (skillingBusy(record)) return false;
  if (socialBusy(record)) return false;
  return true;
}

/**
 * Rebuild the artisan roster: one artisan per trade per kingdom, chosen
 * deterministically (sorted by username) so the town blacksmith is always
 * the same person. Data tier — no player needs to be near.
 */
function rebuildArtisans(director) {
  artisans.clear();
  if (!director?.roster) return;
  const bySlot = new Map(); // "kingdomId:trade" -> name (first sorted wins)
  const eligible = [];
  for (const record of director.roster.values()) {
    if (!eligibleArtisan(record)) continue;
    eligible.push(record);
  }
  eligible.sort((a, b) =>
    normalizeName(a.username) < normalizeName(b.username) ? -1 : 1
  );
  for (const record of eligible) {
    const name = normalizeName(record.username);
    const trade = tradeFor(record.username);
    const kingdomId = record.kingdomId ?? "unknown";
    const slot = `${kingdomId}:${trade}`;
    const taken = bySlot.get(slot) ?? 0;
    if (taken >= ARTISANS_PER_TRADE_PER_KINGDOM) continue;
    bySlot.set(slot, taken + 1);
    artisans.set(name, { trade, kingdomId, display: record.username });
  }
}

// === renown ===

function addRenown(name, amount, nowMs) {
  const before = renown.get(name) ?? 0;
  const after = before + amount;
  renown.set(name, after);
  const beforeTitle = renownTitle(before);
  const afterTitle = renownTitle(after);
  if (afterTitle && afterTitle !== beforeTitle) {
    const info = artisans.get(name);
    journalEvent(
      info?.display ?? name,
      `Word spreads: ${info?.display ?? name} is now a ${afterTitle} ${info?.trade ?? "artisan"}.`
    );
  }
  return after;
}

// === masterpieces (slow tick) ===

function maybeMasterpiece(director, name, info, nowMs) {
  if (nowMs - (lastMasterpieceAt.get(name) ?? 0) < MASTERPIECE_COOLDOWN_MS) return;
  const rng = agentRng(`artisan:masterpiece:${name}:${Math.floor(nowMs / 3600000)}`);
  if (!chance(rng, MASTERPIECE_CHANCE)) return;
  const pieceName = masterpieceName(rng, info.trade);
  if (!pieceName) return;
  lastMasterpieceAt.set(name, nowMs);
  const list = masterpieces.get(name) ?? [];
  list.push({ name: pieceName, trade: info.trade, createdAt: nowMs, revealed: false });
  masterpieces.set(name, list);
  addRenown(name, RENOWN_MASTERPIECE, nowMs);
  journalEvent(info.display, `Completed a masterpiece: ${pieceName}.`);
}

// === commissions (slow tick progress + fast tick reveals) ===

function activeCommissionsFor(name) {
  let n = 0;
  for (const c of commissions.values()) {
    if (normalizeName(c.artisan) === name && !c.announced) n++;
  }
  return n;
}

/** Complete due commissions on the slow tick (data tier). */
function progressCommissions(nowMs) {
  for (const c of commissions.values()) {
    if (c.announced || nowMs < c.dueAt) continue;
    c.completedAt = nowMs;
    const name = normalizeName(c.artisan);
    addRenown(name, RENOWN_COMMISSION, nowMs);
    journalEvent(
      c.artisanDisplay ?? c.artisan,
      `Finished a commission for ${c.commissioner}: ${c.item} (${c.detail}).`
    );
  }
}

/**
 * Register a commission. Exported so the chat layer (or a future UI) can
 * record one when a player actually asks; the dwell tracker below also
 * calls it for implied interest. Pure mechanics — zero LLM.
 */
function commissionItem(artisanName, commissionerName, trade, item, detail, nowMs = Date.now()) {
  const name = normalizeName(artisanName);
  const info = artisans.get(name);
  if (!info || info.trade !== trade) return null;
  if (activeCommissionsFor(name) >= MAX_ACTIVE_COMMISSIONS) return null;
  if (nowMs - (lastCommissionAt.get(name) ?? 0) < COMMISSION_COOLDOWN_MS) return null;
  lastCommissionAt.set(name, nowMs);
  const id = `c${++commissionSeq}:${name}`;
  const spec = item && detail ? { item, detail } : commissionSpec(agentRng(id), trade);
  commissions.set(id, {
    artisan: name,
    artisanDisplay: info.display,
    commissioner: commissionerName,
    item: spec.item,
    detail: spec.detail,
    createdAt: nowMs,
    dueAt: nowMs + COMMISSION_MS,
    announced: false,
  });
  journalEvent(info.display, `Took a commission from ${commissionerName}: ${spec.item} (${spec.detail}).`);
  return id;
}

/**
 * Dwell tracking: a real player lingering near an artisan's workshop is
 * treated as commission interest. After DWELL_TICKS consecutive sightings,
 * a commission is registered and announced visibly.
 */
function tickDwell(director, name, info, bot, nowMs) {
  const nearby = realPlayersWithin(bot, DWELL_RADIUS);
  let seen = dwell.get(name);
  if (!seen) {
    seen = new Map();
    dwell.set(name, seen);
  }
  const present = new Set();
  for (const p of nearby) {
    const pname = normalizeName(p.getUsername?.() ?? "");
    if (!pname) continue;
    present.add(pname);
    const entry = seen.get(pname) ?? { ticks: 0, lastSeen: 0 };
    // Count consecutive sightings; reset if they wandered off between ticks.
    entry.ticks = nowMs - entry.lastSeen < 30000 ? entry.ticks + 1 : 1;
    entry.lastSeen = nowMs;
    seen.set(pname, entry);
    if (entry.ticks >= DWELL_TICKS) {
      seen.delete(pname);
      const id = commissionItem(name, p.getUsername(), info.trade, null, null, nowMs);
      if (id) {
        try {
          bot.forceChat?.(`A commission for ${p.getUsername()}! I'll have it ready soon.`);
        } catch {
          // Cosmetic.
        }
      }
      return; // one commission per tick per artisan
    }
  }
  // Drop players who left.
  for (const pname of [...seen.keys()]) {
    if (!present.has(pname)) seen.delete(pname);
  }
}

// === apprentice tie-in ===

/** The apprentice paired with this artisan, if any (CitizenApprentices data). */
function apprenticeOf(name) {
  try {
    const { _pairs } = require("./CitizenApprentices");
    if (!_pairs) return null;
    for (const [apprentice, pair] of _pairs) {
      if (normalizeName(pair.master) === name) return apprentice;
    }
    return null;
  } catch {
    return null;
  }
}

// === fast tick: visible life ===

function tickArtisanCitizen(director, record, nowMs) {
  const name = normalizeName(record.username);
  const info = artisans.get(name);
  if (!info) return;
  const bot = director.getBot?.(record);
  if (!bot) return;

  // Proximity gate: nobody watching, nothing visible. No wasted ticks.
  const audience = realPlayersWithin(bot, PROXIMITY_TILES);
  if (audience.length === 0) return;
  if (isMoving(bot)) return;

  const def = TRADES[info.trade];

  // 1. Reveal unrevealed masterpieces — the flourish moment.
  const pieces = masterpieces.get(name) ?? [];
  const unrevealed = pieces.find((p) => !p.revealed);
  if (unrevealed) {
    unrevealed.revealed = true;
    try {
      bot.forceChat?.(`Behold — ${unrevealed.name}!`);
    } catch {
      // Cosmetic.
    }
    faceToward(bot, botTile(audience[0]));
    return;
  }

  // 2. Announce completed commissions by name.
  for (const c of commissions.values()) {
    if (normalizeName(c.artisan) === name && c.completedAt && !c.announced) {
      c.announced = true;
      try {
        bot.forceChat?.(`${c.commissioner}, your commission is ready — ${c.item}, ${c.detail}!`);
      } catch {
        // Cosmetic.
      }
      faceToward(bot, botTile(audience[0]));
      return;
    }
  }

  // 3. Dwell -> implied commission interest.
  tickDwell(director, name, info, bot, nowMs);

  // 4. Commission offers (throttled).
  if (nowMs - (lastOfferAt.get(name) ?? 0) >= OFFER_COOLDOWN_MS) {
    const rng = agentRng(`artisan:offer:${name}:${Math.floor(nowMs / 60000)}`);
    if (chance(rng, OFFER_CHANCE)) {
      lastOfferAt.set(name, nowMs);
      try {
        bot.forceChat?.(pickOne(rng, COMMISSION_OFFERS));
      } catch {
        // Cosmetic.
      }
      faceToward(bot, botTile(audience[0]));
      return;
    }
  }

  // 5. Teaching flavor when they have an apprentice.
  if (nowMs - (lastTeachAt.get(name) ?? 0) >= TEACH_COOLDOWN_MS) {
    const apprentice = apprenticeOf(name);
    if (apprentice) {
      const rng = agentRng(`artisan:teach:${name}:${Math.floor(nowMs / 60000)}`);
      if (chance(rng, TEACH_CHANCE)) {
        lastTeachAt.set(name, nowMs);
        try {
          bot.forceChat?.(`*shows ${apprentice} the ${def.label}'s trade*`);
        } catch {
          // Cosmetic.
        }
        return;
      }
    }
  }

  // 6. Visible workshop work (throttled, staggered).
  if (nowMs - (lastWorkAt.get(name) ?? 0) < WORK_COOLDOWN_MS) return;
  const rng = agentRng(`artisan:work:${name}:${Math.floor(nowMs / 60000)}`);
  if (!chance(rng, WORK_CHANCE)) return;
  const tile = workshopTile(info.kingdomId, info.trade);
  if (!tile) return;
  lastWorkAt.set(name, nowMs);
  walkTo(director, bot, tile);
  try {
    bot.forceChat?.(def.verb);
  } catch {
    // Cosmetic.
  }
  faceToward(bot, tile);
  playAnim(director, bot, def.anim);
  journalEvent(info.display, def.journal);
}

/**
 * Fast-tick entry. Called from CitizenDirector.tickProximity() (~10s),
 * after the shopkeeping layer. Wraps every citizen in try/catch.
 */
function tickArtisanLife(director, nowMs = Date.now()) {
  if (!director?.roster) return;
  for (const record of director.roster.values()) {
    try {
      tickArtisanCitizen(director, record, nowMs);
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
}

/**
 * Slow-tick entry. Called from the director's ~60s tick, next to
 * CitizenApprentices. Data tier: roster rebuild, masterpiece creation,
 * commission progress, renown milestones. Zero LLM.
 */
function tickArtisans(director, nowMs = Date.now()) {
  try {
    pruneState(nowMs);
  } catch {
    // Non-fatal.
  }
  try {
    rebuildArtisans(director);
  } catch (e) {
    console.warn("[citizen-artisans] roster rebuild failed:", e?.message ?? e);
    return;
  }
  try {
    progressCommissions(nowMs);
  } catch (e) {
    console.warn("[citizen-artisans] commission progress failed:", e?.message ?? e);
  }
  for (const [name, info] of artisans) {
    try {
      maybeMasterpiece(director, name, info, nowMs);
    } catch {
      // One bad artisan never breaks the tick.
    }
  }
}

module.exports = {
  // ticks
  tickArtisans,
  tickArtisanLife,
  // mechanics (for the chat layer / future UI)
  commissionItem,
  // pure helpers (for tests)
  hashName,
  tradeFor,
  pickOne,
  masterpieceName,
  commissionSpec,
  renownTitle,
  isRealPlayer,
  withinTiles,
  eligibleArtisan,
  // tuning (for tests)
  TRADES,
  TRADE_KEYS,
  DWELL_TICKS,
  DWELL_RADIUS,
  MAX_ACTIVE_COMMISSIONS,
  COMMISSION_MS,
  RENOWN_MASTERPIECE,
  RENOWN_COMMISSION,
  // exposed for tests
  _artisans: artisans,
  _renown: renown,
  _masterpieces: masterpieces,
  _commissions: commissions,
  _dwell: dwell,
};
