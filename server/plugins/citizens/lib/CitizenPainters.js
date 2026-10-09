"use strict";

/**
 * CitizenPainters — citizens who paint portraits, landscapes, murals, and
 * miniatures at the kingdom studios and galleries.
 *
 * WHAT IT DOES (data tier, free):
 *   Every painter works a daily painting catalog (2-4 works with quality
 *   tiers sketch/study/finished/masterwork) derived from date + hashes,
 *   zero storage. Masterpiece unveilings (~8%/studio/day) are announced and
 *   seeded into CitizenRumors. Commission ledgers and painting catalogs live
 *   in small in-memory maps with TTL pruning. Muralists contribute to slow
 *   multi-day public murals, derived from hashes.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   During studio hours (08:00-17:00) a materialized painter at a studio
 *   holds scripted work — easel/studio emotes, painting hawking, masterpiece
 *   unveiling fanfare, commission offers for lingering players. Coin tips
 *   via tipPainter (wired into Citizens.plugin.js onTipSeen).
 *
 * Zero LLM: all lines are scripted pools; the LLM dialogue tier reads the
 * journals and ledgers.
 *
 * No overlap: street performers own the squares (performerTypeOf), bards
 * own music (bardTypeOf), actors own the theaters (actorTypeOf), innkeepers
 * own inn hospitality — painters exclude all four. Actors own theater
 * performances; painters only paint the backdrops they hang.
 *
 * Ties: painters read real CitizenActors theater schedules for backdrop
 * commissions and real CitizenBards song lists for inspiration (lazy
 * require, best-effort, never throws).
 *
 * Wired into the director tick right after the actors block (proximity
 * tick), guarded try/catch, per-citizen try/catch, cooldown maps pruned
 * hourly, gate order cheapest-first. House rule 12: matches the established
 * citizen-module pattern, wired through the existing director plugin,
 * no new core hooks, no guessed anim IDs (emotes and forceChat only).
 * Plain-node testable: CitizenPainters.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { chance } = require("./humanizer");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const PAINTER_RADIUS = 14; // tiles — close enough to see the easel
const PAINTER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const PAINTER_CHANCE = 0.35; // per eligible citizen per tick
const STUDIO_START_HOUR = 8; // painters work in daylight 08:00-17:00
const STUDIO_END_HOUR = 17;
const MASTERPIECE_CHANCE_PER_DAY = 0.08; // ~8% per studio per day
const COINS_ID = 995;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip
const PAINTER_SHARE = 30; // ~30% of commoners are painters

const PAINTER_PORTRAITIST = "portraitist";
const PAINTER_LANDSCAPIST = "landscapist";
const PAINTER_MURALIST = "muralist";
const PAINTER_MINIATURIST = "miniaturist";
const PAINTER_TYPES = Object.freeze([
  PAINTER_PORTRAITIST,
  PAINTER_LANDSCAPIST,
  PAINTER_MURALIST,
  PAINTER_MINIATURIST,
]);
const PAINTER_WEIGHTS = Object.freeze({
  [PAINTER_PORTRAITIST]: 30,
  [PAINTER_LANDSCAPIST]: 30,
  [PAINTER_MURALIST]: 20,
  [PAINTER_MINIATURIST]: 20,
});

// === Studios: easels, ateliers, and galleries, kingdom-preferred ===
const STUDIOS = Object.freeze([
  { name: "the Varrock Artists' Quarter", kingdom: "varrock" },
  { name: "the Lumbridge Studio Loft", kingdom: "varrock" },
  { name: "the Falador Gallery Hall", kingdom: "asgarnia" },
  { name: "the Taverley Painters' Lodge", kingdom: "asgarnia" },
  { name: "the Ardougne Atelier", kingdom: "kandarin" },
  { name: "the Hemenster Sketch Hall", kingdom: "kandarin" },
  { name: "the Keldagrim Fresco Vault", kingdom: "keldagrim" },
  { name: "the Dorgesh Color Burrow", kingdom: "keldagrim" },
  { name: "the Canifis Portrait House", kingdom: "morytania" },
  { name: "the Meiyerditch Mural Wall", kingdom: "morytania" },
]);

// === Painting subjects by type ===
const QUALITY_SKETCH = "sketch";
const QUALITY_STUDY = "study";
const QUALITY_FINISHED = "finished";
const QUALITY_MASTERWORK = "masterwork";
const QUALITIES = Object.freeze([
  QUALITY_SKETCH,
  QUALITY_STUDY,
  QUALITY_FINISHED,
  QUALITY_MASTERWORK,
]);

const SUBJECTS = Object.freeze({
  [PAINTER_PORTRAITIST]: Object.freeze([
    "the miller's daughter",
    "a weathered sea captain",
    "the guildmaster in his robes",
    "a laughing tavern wench",
    "an old knight in battered armor",
  ]),
  [PAINTER_LANDSCAPIST]: Object.freeze([
    "the mist over Lumbridge at dawn",
    "White Wolf Mountain in winter",
    "the Karamja coastline at dusk",
    "a wheat field before the harvest",
    "the haunted woods in moonlight",
  ]),
  [PAINTER_MURALIST]: Object.freeze([
    "the founding of the city",
    "the battle of the South Gate",
    "the five capitals united",
    "the harvest festival procession",
    "the king's coronation",
  ]),
  [PAINTER_MINIATURIST]: Object.freeze([
    "a robin on a winter branch",
    "a lady's locket portrait",
    "a beetle in iridescent detail",
    "a single rose, dew-covered",
    "a sailor's knot, perfectly tied",
  ]),
});

// === Scripted lines (data tier; the LLM riffs via the journal) ===
const WORK_EMOTES = Object.freeze([
]);

const HAWK_LINES = Object.freeze([
  "Fresh from the easel! {subject} — a {quality} piece!",
  "Come see today's work: {subject}, in {quality}!",
  "For sale: {subject}. Painted this very week!",
  "A {quality} {subject} — yours for a fair price!",
]);

const MASTERPIECE_LINES = Object.freeze([
  "BEHOLD! My masterpiece is unveiled — {subject}!",
  "Years of work, finished at last: {subject}, my masterpiece!",
  "Come, all of you — witness {subject}, my masterwork!",
]);

const COMMISSION_LINES = Object.freeze([
  "Ever wanted your portrait painted? I take commissions, friend!",
  "I paint portraits to order — sit for me sometime!",
  "Commissions open! Your face, immortalized in oils.",
]);

const MINIATURE_LINES = Object.freeze([
  "Miniatures painted to order — lockets, keepsakes, tiny wonders!",
  "I paint the small things beautifully. Commissions welcome!",
]);

const MURAL_LINES = Object.freeze([
  "The city wall will wear my mural for a hundred years!",
]);

const TIP_THANKS = Object.freeze([
  "A patron of the arts! My brushes thank you!",
  "Your generosity colors my day — thank you!",
  "For the love of art, and art lovers — thank you!",
  "The studio thanks you! Come see the next piece!",
]);

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastMasterpieceAnnounce = new Map(); // studio name -> day number

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

/** Weighted pick of a painter type from a 0..99 roll. */
function painterTypeFromRoll(roll) {
  let acc = 0;
  for (const t of PAINTER_TYPES) {
    acc += PAINTER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return PAINTER_PORTRAITIST;
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

/** True during studio hours (08:00-17:00 server time). */
function isStudioHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= STUDIO_START_HOUR && h < STUDIO_END_HOUR;
}

function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/**
 * The painter type for a roster record, or null when this citizen is not a
 * painter. Hash-derived from the normalized username (~30% of commoners),
 * stable across restarts, zero storage. Excludes street performers, bards,
 * actors, and inn bards so no citizen belongs to two performer systems.
 */
function painterTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No double-casting: street performers, bards, actors, inn bards
    // paint elsewhere (or nowhere at all).
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
    const roll = hashStr("painter:" + name) % 100;
    if (roll >= PAINTER_SHARE) return null;
    return painterTypeFromRoll(hashStr("paintertype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred studio assignment, stable across restarts. */
function studioFor(record) {
  const kid = record?.kingdomId;
  const local = STUDIOS.filter((s) => s.kingdom === kid);
  const pool = local.length ? local : STUDIOS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("studio:" + name) % pool.length];
}

/**
 * The day's painting catalog for a painter — 2-4 works with subjects and
 * quality tiers. Deterministic per day, zero storage. A masterwork appears
 * ~8% of painter-days (the crowd moment).
 */
function paintingsFor(record, nowMs = Date.now()) {
  try {
    const type = painterTypeOf(record);
    if (!type) return { works: [], masterpiece: false, type: null };
    const name = normalizeName(record?.username) || "anon";
    const day = dayNumber(nowMs);
    const h = hashStr("paintings:" + name + ":" + day);
    const count = 2 + (h % 3); // 2-4 works
    const subjects = SUBJECTS[type];
    const works = [];
    for (let i = 0; i < count; i++) {
      const sh = hashStr("work:" + name + ":" + day + ":" + i);
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
    // Canonical: journal.log(name, kind, text). The addEntry probe is dead —
    // CitizenJournal has no addEntry; the ?. made this a silent no-op.
    if (j && name) j.log?.(name, "work", text);
  } catch { /* cosmetic */ }
}

/** Best-effort rumor seed; never throws. */
// Canonical: CitizenRumors.seedRumor(rng, event) — the bare-string call is
// dead (returns null); pass an event object ({ kind, what, ... }).
function seedRumor(event) {
  try {
    const fn = seedRumorFn();
    if (fn) fn(Math.random, event);
  } catch { /* cosmetic */ }
}

// ============================================================================
// Commission ledger (data tier, zero LLM) — 7-day TTL.
// ============================================================================
const COMMISSION_TTL_MS = 7 * 24 * 3600 * 1000;
const commissions = new Map(); // normName -> { painter, subject, kind, commissionedAt }

function commissionPainting(playerName, painterUsername, subject, kind = "portrait", nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  commissions.set(name, {
    painter: normalizeName(painterUsername),
    subject: String(subject || "a portrait"),
    kind: String(kind || "portrait"),
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
// Backdrop commissions from the theaters (lazy require — actors may not
// load in tests). Painters paint the sets the actors hang.
// ============================================================================
function backdropFor(theaterName) {
  try {
    const actors = require("./CitizenActors");
    if (typeof actors.playFor !== "function") return null;
    const theater = { name: theaterName };
    const play = actors.playFor(theater);
    return play ? { title: play.title, genre: play.genre } : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Coin tips: "use coins on painter" (registered in Citizens.plugin.js
// onTipSeen alongside tipPerformer, tipBard, tipActor). Each handler
// ignores non-own targets.
// ============================================================================
function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

function tipPainter(event, deps = {}, nowMs = Date.now()) {
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
  const type = painterTypeOf(record);
  if (!type) return; // not a painter — let the next handler have it

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
    { const _cvp = target.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(target, voiceLine(voiceFor(_cvp), { plain: TIP_THANKS })); }
  } catch { /* cosmetic */ }
  journalize(target, `received a ${amount}-coin tip from ${player.getUsername?.() ?? "a patron"}`);
  return amount;
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → painter? → materialized → studio hours →
// real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickPainters(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < PAINTER_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a painter (hash-derived, cheap)
        const type = painterTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Studio hours only (painters need daylight)
        if (!isStudioHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, PAINTER_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, PAINTER_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        paintScene(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-painters] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-painters] tick failed:", e?.message ?? e);
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

/** A full scripted painting scene. */
function paintScene(director, record, citizen, type, nowMs) {
  const studio = studioFor(record);
  const catalog = paintingsFor(record, nowMs);
  const day = dayNumber(nowMs);

  // Masterpiece unveilings: once per studio per day, the crowd moment.
  if (catalog.masterpiece && (lastMasterpieceAnnounce.get(studio.name) ?? -1) < day) {
    lastMasterpieceAnnounce.set(studio.name, day);
    const work = catalog.works[0];
    const line = fill(pickOne(Math.random, MASTERPIECE_LINES), {
      subject: work ? `${work.subject} (${work.quality})` : "a new work",
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `unveiled a masterpiece at ${studio.name}`);
    seedRumor({ kind: "work", what: `A masterpiece unveiled at ${studio.name} — come see it!` });
    return;
  }

  if (type === PAINTER_MURALIST) {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: MURAL_LINES })); }
    journalize(citizen, `worked on the mural at ${studio.name}`);
    return;
  }

  // Hawking: sell today's catalog.
  if (catalog.works.length) {
    const work = pickOne(Math.random, catalog.works);
    const line = fill(pickOne(Math.random, HAWK_LINES), {
      subject: work.subject,
      quality: work.quality,
    });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `hawked "${work.subject}" (${work.quality}) at ${studio.name}`);
    return;
  }

  // Fallback: work emotes.
  { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: WORK_EMOTES })); }
}

/**
 * Offer a commission to a lingering real player.
 * Called from the tick path; the LLM dialogue tier handles the reply.
 */
function maybeOfferCommission(record, citizen, type) {
  const line =
    type === PAINTER_MINIATURIST
      ? pickOne(Math.random, MINIATURE_LINES)
      : pickOne(Math.random, COMMISSION_LINES);
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch { /* cosmetic */ }
  return line;
}

module.exports = {
  tickPainters,
  tipPainter,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  painterTypeOf,
  studioFor,
  paintingsFor,
  commissionPainting,
  commissionFor,
  backdropFor,
  maybeOfferCommission,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  painterTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isStudioHour,
  dayNumber,
  PAINTER_TYPES,
  PAINTER_PORTRAITIST,
  PAINTER_LANDSCAPIST,
  PAINTER_MURALIST,
  PAINTER_MINIATURIST,
  STUDIOS,
  SUBJECTS,
  QUALITIES,
  QUALITY_SKETCH,
  QUALITY_STUDY,
  QUALITY_FINISHED,
  QUALITY_MASTERWORK,
};
