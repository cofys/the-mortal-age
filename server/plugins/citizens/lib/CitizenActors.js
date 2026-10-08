"use strict";

/**
 * CitizenActors — citizens who stage plays, dramas, and comedies at the
 * kingdom theaters and amphitheaters.
 *
 * WHAT IT DOES (data tier, free):
 *   Every theater runs a daily play schedule — play, genre, headliner —
 *   derived from date + hashes, zero storage. Premieres (~12%/theater/day)
 *   are announced and seeded into CitizenRumors. Troupe memberships and
 *   heckle tallies live in small in-memory ledgers with TTL pruning.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   During show hours (17:00-23:00) a materialized actor at a theater holds
 *   a scripted play scene — opening announcement, monologue lines
 *   (forceChat) from genre script pools, stagehands shifting scenes with
 *   emotes, the lead taking a bow. Premieres are the crowd moment.
 *   Lingering players get seat invitations and troupe-join offers.
 *   Coin tips via tipActor (wired into Citizens.plugin.js onTipSeen).
 *
 * Zero LLM: all lines are scripted pools; the LLM dialogue tier reads the
 * journals and ledgers.
 *
 * No overlap: street performers own the squares (performerTypeOf), bards
 * own music in the great halls (bardTypeOf), innkeepers own inn hospitality
 * (innTypeFor) — actors exclude all three. Festivals own festival events;
 * actors only play at them. Weddings own ceremonies.
 *
 * Wired into the director tick right after the bards block (proximity
 * tick), guarded try/catch, per-citizen try/catch, cooldown maps pruned
 * hourly, gate order cheapest-first. House rule 12: matches the established
 * citizen-module pattern, wired through the existing director plugin,
 * no new core hooks, no guessed anim IDs (emotes and forceChat only).
 * Plain-node testable: CitizenActors.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { chance } = require("./humanizer");

// === Tuning: all magic numbers here ===
const ACTOR_RADIUS = 14; // tiles — close enough to see the stage
const ACTOR_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const ACTOR_CHANCE = 0.35; // per eligible citizen per tick
const SHOW_START_HOUR = 17; // shows run 17:00-23:00 server time
const SHOW_END_HOUR = 23;
const PREMIERE_CHANCE_PER_DAY = 0.12; // ~12% per theater per day
const COINS_ID = 995;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip

const ACTOR_TRAGEDIAN = "tragedian";
const ACTOR_COMEDIAN = "comedian";
const ACTOR_LEAD = "lead";
const ACTOR_STAGEHAND = "stagehand";
const ACTOR_TYPES = Object.freeze([
  ACTOR_TRAGEDIAN,
  ACTOR_COMEDIAN,
  ACTOR_LEAD,
  ACTOR_STAGEHAND,
]);
const ACTOR_WEIGHTS = Object.freeze({
  [ACTOR_TRAGEDIAN]: 30,
  [ACTOR_COMEDIAN]: 30,
  [ACTOR_LEAD]: 20,
  [ACTOR_STAGEHAND]: 20,
});

// === Theaters: playhouses and amphitheaters, kingdom-preferred ===
const THEATERS = Object.freeze([
  { name: "the Globe of Varrock", kingdom: "varrock" },
  { name: "the Lumbridge Playhouse", kingdom: "varrock" },
  { name: "the Falador Amphitheatre", kingdom: "asgarnia" },
  { name: "the Taverley Round Stage", kingdom: "asgarnia" },
  { name: "the Ardougne Theatre Royal", kingdom: "kandarin" },
  { name: "the Hemenster Farce House", kingdom: "kandarin" },
  { name: "the Keldagrim Stone Stage", kingdom: "keldagrim" },
  { name: "the Dorgesh Amphitheatre", kingdom: "keldagrim" },
  { name: "the Canifis Gloom Stage", kingdom: "morytania" },
  { name: "the Meiyerditch Mask House", kingdom: "morytania" },
]);

// === Troupes: one named theater company per kingdom ===
const TROUPES = Object.freeze([
  { name: "the Varrock Players", kingdom: "varrock" },
  { name: "the Falador Thespians", kingdom: "asgarnia" },
  { name: "the Ardougne Stage Company", kingdom: "kandarin" },
  { name: "the Deep Delve Players", kingdom: "keldagrim" },
  { name: "the Masks of Darkmeyer", kingdom: "morytania" },
]);

// === Plays: named repertoire per genre ===
const GENRE_TRAGEDY = "tragedy";
const GENRE_COMEDY = "comedy";
const GENRE_HISTORY = "history";
const PLAYS = Object.freeze({
  [GENRE_TRAGEDY]: Object.freeze([
    "The Fall of the Nameless King",
    "Blood on the Battlements",
    "The Widow of Lumbridge",
    "A Crown of Thorns",
    "The Last Siege",
  ]),
  [GENRE_COMEDY]: Object.freeze([
    "The Tax Collector's Wedding",
    "Much Ado About Goblin",
    "The Drunken Knight",
    "A Midsummer Night's Brawl",
    "The Merchant of Varrock",
  ]),
  [GENRE_HISTORY]: Object.freeze([
    "The Founding of Falador",
    "How Ardougne Rose",
    "The Dwarven Exodus",
    "The Battle of the South Gate",
    "Kings of the Five Capitals",
  ]),
});
const GENRES = Object.freeze([GENRE_TRAGEDY, GENRE_COMEDY, GENRE_HISTORY]);

// === Scripted lines (data tier; the LLM riffs via the journal) ===
const OPENING_LINES = Object.freeze([
  "Ladies and gentlemen — {troupe} presents {play}!",
  "The candles are lit, the stage is set — {troupe} presents {play}!",
  "Take your seats! Tonight {troupe} performs {play}!",
  "Quiet please — {troupe} presents {play}, {genre} in three acts!",
]);

const MONOLOGUES = Object.freeze({
  [GENRE_TRAGEDY]: Object.freeze([
    "O cruel fate, that crowns the unworthy and buries the brave!",
    "What is a king but a man with heavier chains?",
    "I have seen the banners fall, and the trumpets turn to ash.",
    "Blood will have blood — so the old proverb runs, and so it runs true.",
    "The crown sits heavy on the head that schemed to wear it.",
  ]),
  [GENRE_COMEDY]: Object.freeze([
    "Marry me, they said — it'll be cheaper, they said!",
    "A goblin, a knight, and a tax collector walk into a tavern...",
    "I asked for a sword and they gave me a spoon. A SPOON!",
    "Love is blind, but my mother-in-law sees everything!",
    "To scheme, or not to scheme — that is the bookkeeping.",
  ]),
  [GENRE_HISTORY]: Object.freeze([
    "And so the founders raised the first stone upon this very ground!",
    "Hear now the tale our grandfathers' grandfathers told!",
    "Five capitals, one crown — and a thousand years of trouble.",
    "The chroniclers wrote it plain: no victory comes cheap.",
    "Remember the South Gate, and remember who held it!",
  ]),
});

const STAGEHAND_LINES = Object.freeze([
  "*hauls a painted backdrop into place*",
  "*lowers the moon prop on its rope*",
  "*sweeps the stage between acts*",
  "*whispers a forgotten line from the wings*",
  "*rings the act-change bell*",
]);

const BOW_LINES = Object.freeze([
  "*takes a deep bow to thunderous applause*",
  "*bows low, hand on heart*",
  "*takes a bow as roses sail onto the stage*",
]);

const PREMIERE_LINES = Object.freeze([
  "PREMIERE! Tonight {troupe} unveils {play} — never before performed!",
  "A first! {troupe} premieres {play} at {theater} — be there!",
  "Tonight only: the premiere of {play} by {troupe}!",
]);

const INVITE_LINES = Object.freeze([
  "The show starts soon — take a seat, the best ones are free!",
  "Evening, friend! {play} is on tonight — you'd love it.",
  "A seat with your name on it, friend — the curtain rises soon!",
]);

const JOIN_LINES = Object.freeze([
  "Ever fancied the stage? {troupe} is always looking for fresh faces!",
  "You've got the look of a born tragedian — join {troupe}, friend!",
  "The stage calls! {troupe} holds auditions every week.",
]);

const HECKLE_COMEBACKS = Object.freeze([
  "The groundlings speak! And yet the show goes on.",
  "A heckler! The finest compliment a small mind can pay.",
  "Boo all you like, friend — your seat was free.",
  "Even the pit has its poets. Sit down, poet.",
  "Your review is noted, and roundly ignored.",
]);

const TIP_THANKS = Object.freeze([
  "A patron of the arts! A thousand thanks!",
  "Your generosity outshines the footlights!",
  "Bravo yourself, friend — and thank you!",
  "The troupe thanks you! Drinks are on us after the show!",
]);

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastTroupeAnnounce = new Map(); // troupe name -> day number

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

/** Weighted pick of an actor type from a 0..99 roll. */
function actorTypeFromRoll(roll) {
  let acc = 0;
  for (const t of ACTOR_TYPES) {
    acc += ACTOR_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return ACTOR_TRAGEDIAN;
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

/** True during show hours (17:00-23:00 server time). */
function isShowHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= SHOW_START_HOUR && h < SHOW_END_HOUR;
}

function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/**
 * The actor type for a roster record, or null when this citizen is not an
 * actor. Hash-derived from the normalized username (~30% of commoners),
 * stable across restarts, zero storage. Excludes street performers, bards,
 * and inn bards so no citizen belongs to two performer systems.
 */
function actorTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No double-casting: street performers, bards, inn bards act elsewhere.
    try {
      const sp = require("./CitizenStreetPerformers");
      if (typeof sp.performerTypeOf === "function" && sp.performerTypeOf(record)) return null;
    } catch { /* module absent */ }
    try {
      const bards = require("./CitizenBards");
      if (typeof bards.bardTypeOf === "function" && bards.bardTypeOf(record)) return null;
    } catch { /* module absent */ }
    try {
      const inn = require("./CitizenInnkeepers");
      if (typeof inn.innTypeFor === "function" && inn.innTypeFor(name) === "bard") return null;
    } catch { /* module absent */ }
    const roll = hashStr("actor:" + name) % 100;
    if (roll >= 30) return null;
    // Name-first salt avoids FNV-1a prefix correlation with the "actor:" gate above.
    return actorTypeFromRoll(hashStr(name + "|actor-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred theater assignment, stable across restarts. */
function theaterFor(record) {
  const kid = record?.kingdomId;
  const local = THEATERS.filter((t) => t.kingdom === kid);
  const pool = local.length ? local : THEATERS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("theater:" + name) % pool.length];
}

/** The theater company of a kingdom. */
function troupeForKingdom(kingdomId) {
  const local = TROUPES.filter((t) => t.kingdom === kingdomId);
  return local.length ? local[0] : TROUPES[0];
}

/**
 * The play on at a theater on a given day — { title, genre, premiere }.
 * Deterministic per day, zero storage. Premieres ~12% of theater-days.
 */
function playFor(theater, nowMs = Date.now()) {
  try {
    const day = dayNumber(nowMs);
    const h = hashStr("play:" + theater.name + ":" + day);
    const genre = GENRES[h % GENRES.length];
    const titles = PLAYS[genre];
    const title = titles[(h >>> 3) % titles.length];
    const premiere = ((h >>> 11) % 100) < Math.round(PREMIERE_CHANCE_PER_DAY * 100);
    return { title, genre, premiere };
  } catch {
    return { title: PLAYS[GENRE_COMEDY][0], genre: GENRE_COMEDY, premiere: false };
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

// ============================================================================
// Troupe membership ledger (data tier, zero LLM) — 30-day TTL.
// ============================================================================
const TROUPE_TTL_MS = 30 * 24 * 3600 * 1000;
const troupeMembers = new Map(); // normName -> { troupe, joinedAt }

function joinTroupe(playerName, kingdomId, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  const troupe = troupeForKingdom(kingdomId);
  troupeMembers.set(name, { troupe: troupe.name, joinedAt: nowMs });
  return troupe;
}

function troupeMemberFor(playerName, nowMs = Date.now()) {
  const rec = troupeMembers.get(normalizeName(playerName));
  if (!rec) return null;
  if (nowMs - rec.joinedAt > TROUPE_TTL_MS) {
    troupeMembers.delete(normalizeName(playerName));
    return null;
  }
  return rec;
}

// ============================================================================
// Heckling (data tier, zero LLM): the LLM tier calls heckleSeen when a real
// player heckles a performance; the actor fires a scripted comeback.
// ============================================================================
function heckleSeen(actorCitizen, hecklerName) {
  try {
    const line = pickOne(Math.random, HECKLE_COMEBACKS);
    actorCitizen?.forceChat?.(line);
    journalize(actorCitizen, `heckled by ${hecklerName} and answered: "${line}"`);
    return line;
  } catch {
    return null;
  }
}

// ============================================================================
// Coin tips: "use coins on actor" (registered in Citizens.plugin.js onTipSeen
// alongside tipPerformer and tipBard). Each handler ignores non-own targets.
// ============================================================================
function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

function tipActor(event, deps = {}, nowMs = Date.now()) {
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
  const type = actorTypeOf(record);
  if (!type) return; // not an actor — let the next handler have it

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
// Gate order: cooldown (cheapest) → actor? → materialized → show hours →
// real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickActors(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < ACTOR_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be an actor (hash-derived, cheap)
        const type = actorTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Show hours only
        if (!isShowHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, ACTOR_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, ACTOR_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        performScene(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-actors] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-actors] tick failed:", e?.message ?? e);
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

/** A full scripted play scene. */
function performScene(director, record, citizen, type, nowMs) {
  const theater = theaterFor(record);
  const troupe = troupeForKingdom(record.kingdomId);
  const play = playFor(theater, nowMs);
  const slots = {
    troupe: troupe.name,
    play: play.title,
    genre: play.genre,
    theater: theater.name,
  };

  // Premiere announcements: once per theater per day, the crowd moment.
  const day = dayNumber(nowMs);
  if (play.premiere && (lastTroupeAnnounce.get(theater.name) ?? -1) < day) {
    lastTroupeAnnounce.set(theater.name, day);
    const line = fill(pickOne(Math.random, PREMIERE_LINES), slots);
    citizen.forceChat?.(line);
    journalize(citizen, `premiered "${play.title}" at ${theater.name}`);
    seedRumor(`Premiere tonight: "${play.title}" by ${troupe.name} at ${theater.name}!`);
    return;
  }

  if (type === ACTOR_STAGEHAND) {
    citizen.forceChat?.(pickOne(Math.random, STAGEHAND_LINES));
    return;
  }

  // Opening for leads; monologues for tragedians/comedians.
  if (type === ACTOR_LEAD) {
    citizen.forceChat?.(fill(pickOne(Math.random, OPENING_LINES), slots));
    journalize(citizen, `opened "${play.title}" at ${theater.name}`);
    return;
  }

  const line = pickOne(Math.random, MONOLOGUES[play.genre]);
  citizen.forceChat?.(line);
  journalize(citizen, `performed in "${play.title}" (${play.genre}) at ${theater.name}`);
}

/**
 * Invite a lingering real player to take a seat / join the troupe.
 * Called from the tick path; the LLM dialogue tier handles the reply.
 */
function maybeInvitePlayer(record, citizen, type) {
  const troupe = troupeForKingdom(record.kingdomId);
  const play = playFor(theaterFor(record));
  const line =
    type === ACTOR_STAGEHAND || type === ACTOR_LEAD
      ? fill(pickOne(Math.random, JOIN_LINES), { troupe: troupe.name })
      : fill(pickOne(Math.random, INVITE_LINES), { play: play.title });
  try {
    citizen.forceChat?.(line);
  } catch { /* cosmetic */ }
  return line;
}

module.exports = {
  tickActors,
  tipActor,
  heckleSeen,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  actorTypeOf,
  theaterFor,
  troupeForKingdom,
  playFor,
  joinTroupe,
  troupeMemberFor,
  maybeInvitePlayer,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  actorTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isShowHour,
  dayNumber,
  ACTOR_TYPES,
  ACTOR_TRAGEDIAN,
  ACTOR_COMEDIAN,
  ACTOR_LEAD,
  ACTOR_STAGEHAND,
  THEATERS,
  TROUPES,
  PLAYS,
  GENRES,
  GENRE_TRAGEDY,
  GENRE_COMEDY,
  GENRE_HISTORY,
};
