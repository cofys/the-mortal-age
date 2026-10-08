"use strict";

/**
 * CitizenBards — professional minstrels of the kingdoms.
 *
 * WHAT IT DOES (data tier, free):
 *   Bard designation (hash-derived, stable across restarts), troupe
 *   membership and tour schedules, court-bard appointments, the daily
 *   repertoire, the ballad-of-the-week composed from real journaled
 *   events, commission and song-request ledgers, tip accounting.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Evening performances in great halls and feast halls — minstrels
 *   singing named songs, instrumentalists playing, storytellers telling
 *   epics, jesters working the court. Troupe arrivals are announced,
 *   new compositions premiere to fanfare, and players can request songs,
 *   tip the performers with "use coins on bard", or commission a troupe
 *   for a wedding or feast.
 *
 * Zero LLM: every performance line, verse, joke and ballad stanza is
 * scripted from pools; the ballad-of-the-week is assembled from
 * template slots filled with real journaled event words. The LLM
 * dialogue tier reads the journals and ledgers.
 *
 * NO OVERLAP:
 *   CitizenStreetPerformers owns amateur buskers (squares, markets,
 *   tavern entrances, 10:00-22:00, coin tips by tipPerformer). Bards
 *   are professionals: evening halls, repertoire, troupes, tours,
 *   commissions, premieres. Any citizen who is a street performer
 *   (performerTypeOf) or an inn bard (innTypeFor === "bard") is
 *   excluded here.
 *   CitizenInnkeepers owns inn hospitality (their bards sing short
 *   verses in the inn). CitizenFestivals owns festival events; bards
 *   only perform at them.
 *
 * Wired into the director proximity tick right after the street
 * performers block. Coin tips hook into Citizens.plugin.js onTipSeen
 * alongside tipPerformer. Plain-node testable: CitizenBards.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { getMemory } = require("./CitizenMemory");
const { normalizeName } = require("./CitizenBonds");
const { chance } = require("./humanizer");

// === Tuning: all magic numbers here ===
const BARD_FRACTION_PCT = 20; // ~20% of commoners are bards (after exclusions)
const PERFORMANCE_RADIUS = 14; // tiles — audience distance
const BARD_COOLDOWN_MS = 30 * 60 * 1000; // a bard performs at most every 30 min
const BARD_CHANCE = 0.5; // per eligible bard per proximity tick
const OPEN_HOUR = 17; // bards play the halls 17:00-23:00 server time
const CLOSE_HOUR = 23;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip
const TIP_MEMORY_TONE = 2; // generous tippers are remembered warmly
const COINS_ID = 995;
const COMMISSION_TTL_MS = 7 * 24 * 3600 * 1000;
const REQUEST_TTL_MS = 24 * 3600 * 1000;

// === Bard types ===
const BARD_MINSTREL = "minstrel";
const BARD_INSTRUMENTALIST = "instrumentalist";
const BARD_STORYTELLER = "storyteller";
const BARD_JESTER = "jester";
const BARD_TYPES = Object.freeze([
  BARD_MINSTREL,
  BARD_INSTRUMENTALIST,
  BARD_STORYTELLER,
  BARD_JESTER,
]);
const BARD_WEIGHTS = Object.freeze({
  [BARD_MINSTREL]: 35,
  [BARD_INSTRUMENTALIST]: 30,
  [BARD_STORYTELLER]: 20,
  [BARD_JESTER]: 15,
});

// === Venues: great halls and feast halls, kingdom-preferred ===
const VENUES = Object.freeze([
  { name: "the Grand Hall of Varrock", kingdom: "varrock" },
  { name: "the Longhall of Lumbridge", kingdom: "varrock" },
  { name: "the Feast Hall of Falador", kingdom: "asgarnia" },
  { name: "the White Knights' Banquet Hall", kingdom: "asgarnia" },
  { name: "the Palace of Ardougne", kingdom: "kandarin" },
  { name: "the Hemenster Feast Hall", kingdom: "kandarin" },
  { name: "the Grand Hall of Keldagrim", kingdom: "keldagrim" },
  { name: "the Deep Forge Feast Cavern", kingdom: "keldagrim" },
  { name: "the Blood Hall of Darkmeyer", kingdom: "morytania" },
  { name: "the Theatre of Canifis", kingdom: "morytania" },
]);

// === Troupes: named traveling companies, one per kingdom ===
const TROUPES = Object.freeze([
  { name: "the Gilded Lute", kingdom: "varrock" },
  { name: "the Silver Strings", kingdom: "asgarnia" },
  { name: "the Wandering Wyverns", kingdom: "kandarin" },
  { name: "the Deep Delvers", kingdom: "keldagrim" },
  { name: "the Nightingales of Darkmeyer", kingdom: "morytania" },
]);

// === Repertoire: named songs per type ===
const REPERTOIRE = Object.freeze({
  [BARD_MINSTREL]: Object.freeze([
    "The King's Road",
    "Lament of the Lost Sailor",
    "The Miller's Daughter",
    "Song of the Five Capitals",
    "The Drunken Dwarf",
    "Ashes of the Old War",
  ]),
  [BARD_INSTRUMENTALIST]: Object.freeze([
    "Dance of the River Nymphs",
    "The Forge-Fire Reel",
    "Moonlight on the Battlements",
    "The Merchant's Gallop",
    "Winter in the Passes",
  ]),
  [BARD_STORYTELLER]: Object.freeze([
    "The Saga of the Dragon-Bargain",
    "How the South Gate Fell",
    "The Twelve-Point Stag",
    "The Ballad of the Nameless King",
    "Tales of the Deep Delve",
  ]),
  [BARD_JESTER]: Object.freeze([
    "The Tax Collector's Lament (a comedy)",
    "Why the Troll Crossed the Bridge",
    "The Knight Who Feared Chickens",
    "Ode to an Empty Coin Purse",
  ]),
});

// === Scripted performance lines (data tier; the LLM riffs via the journal) ===
const PERFORMANCE_LINES = Object.freeze({
  [BARD_MINSTREL]: Object.freeze([
    "*draws a deep breath* ...and now, '{song}'!",
    "*sings a verse of '{song}', voice ringing off the rafters*",
    "They wept in Ardougne when I sang '{song}'. Wept, I tell you!",
    "'{song}' — as requested by the fine folk of the hall!",
    "*holds the final note of '{song}'* ...thank you, thank you!",
    "A love song next? Or shall we have '{song}' again?",
  ]),
  [BARD_INSTRUMENTALIST]: Object.freeze([
    "*tunes the lute, then launches into '{song}'*",
    "No words tonight — just the music. '{song}'.",
    "*fingers fly across the strings* ...'{song}', for the dancers!",
    "This one needs no singer. Listen — '{song}'.",
    "*the drum joins in, and the whole hall is tapping along to '{song}'*",
    "An old tune, '{song}', older than the stones of this hall.",
  ]),
  [BARD_STORYTELLER]: Object.freeze([
    "Hush, now. The saga of '{song}' begins...",
    "...and that is how the hero earned the name in '{song}'.",
    "You've heard the short version. Tonight: the FULL '{song}'.",
    "*lowers voice* ...this is the part of '{song}' they don't tell children.",
    "'{song}' — three hours, two battles, one dragon. Settle in.",
    "Every scar on this tongue is from telling '{song}' too loudly.",
  ]),
  [BARD_JESTER]: Object.freeze([
    "*tumbles across the floor* ...and THAT is '{song}'!",
    "A jest for the court! '{song}'!",
    "*juggles three apples while reciting '{song}' backwards*",
    "The king laughed at '{song}'. The king! Laughing!",
    "Don't try '{song}' at home. Especially the custard part.",
    "*bows so low the bells on his cap touch the floor* '{song}'!",
  ]),
});

const TROUPE_ARRIVAL_LINES = Object.freeze([
  "{troupe} have arrived in town! Tonight they play {venue}!",
  "Word spreads: {troupe} are in the city — the halls will be full tonight!",
  "The banners are hung: {troupe} perform at {venue} this evening!",
  "Minstrels on the road! {troupe} reached the city gates at dusk.",
]);

const PREMIERE_LINES = Object.freeze([
  "Tonight — a world premiere! '{song}', composed just this week!",
  "*unrolls a fresh manuscript* Behold: '{song}', never before performed!",
  "The hall holds its breath... the premiere of '{song}'!",
  "New from the quill of {bard}: '{song}'! Applaud the composer!",
]);

const BALLAD_TEMPLATES = Object.freeze([
  "They sing it in every hall now: '{ballad}' — of {event}.",
  "*sings* ...and so the bards made '{ballad}' of {event}.",
  "Have you heard '{ballad}'? It's all about {event}!",
  "The newest ballad, '{ballad}', tells of {event}. Chills, I tell you.",
]);

const BALLAD_TITLES = Object.freeze([
  "The Ballad of {subject}",
  "Song of {subject}",
  "The {subject} Lament",
  "{subject}'s Triumph",
  "The Lay of {subject}",
]);

const COMMISSION_LINES = Object.freeze([
  "{troupe} will play your {occasion}! The halls shall ring!",
  "A commission! {troupe} are yours for the {occasion}!",
  "Done — {troupe} shall grace your {occasion}. A night to remember!",
]);

const REQUEST_LINES = Object.freeze([
  "'{song}'? For you? Gladly!",
  "Ah, '{song}' — a fine choice. Coming right up!",
  "Someone with taste! '{song}', then!",
]);

const TIP_THANKS = Object.freeze([
  "A generous soul! The next one's for you!",
  "*bows deeply* Your coin sings sweeter than I do!",
  "Blessings on your purse! Another verse, in your honour!",
  "Ha! The hall's favourite patron!",
]);

const COMMISSION_OCCASIONS = Object.freeze([
  "wedding",
  "feast",
  "festival",
  "coronation",
  "name-day",
  "victory celebration",
]);

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastBalladByKingdom = new Map(); // kingdom -> dayNumber
const lastPremiereByKingdom = new Map(); // kingdom -> dayNumber
const lastTroupeAnnounce = new Map(); // troupeName -> dayNumber

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

// === Commissions / song-request ledgers (in-memory, TTL) ===
const commissions = new Map(); // key -> { player, troupe, occasion, at }
const songRequests = new Map(); // key -> { player, song, at }

let lastLedgerPruneAt = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPruneAt < 3600 * 1000) return;
  lastLedgerPruneAt = nowMs;
  for (const [k, c] of commissions) {
    if (nowMs - c.at > COMMISSION_TTL_MS) commissions.delete(k);
  }
  for (const [k, r] of songRequests) {
    if (nowMs - r.at > REQUEST_TTL_MS) songRequests.delete(k);
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

/** Weighted pick of a bard type from a 0..99 roll. */
function bardTypeFromRoll(roll) {
  let acc = 0;
  for (const t of BARD_TYPES) {
    acc += BARD_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return BARD_MINSTREL;
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
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

/** Server-time hour (0-23). */
function hourOf(nowMs) {
  return new Date(nowMs).getHours();
}

/** Day number for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** Bards play the halls in the evening. */
function isPerformanceHour(nowMs) {
  const h = hourOf(nowMs);
  return h >= OPEN_HOUR && h < CLOSE_HOUR;
}

/**
 * The bard type of a roster record, or null when not a bard.
 * Excludes street performers (they own the squares) and inn bards
 * (they own the inns). Lazy requires are best-effort: if the sibling
 * module cannot load, the exclusion is skipped rather than throwing.
 */
function bardTypeOf(record) {
  if (!record || record.role !== "commoner") return null;
  const name = normalizeName(record.username);
  if (!name) return null;
  try {
    const sp = require("./CitizenStreetPerformers");
    if (sp && typeof sp.performerTypeOf === "function" && sp.performerTypeOf(record)) {
      return null; // a busker — not a professional bard
    }
  } catch { /* sibling unavailable; continue */ }
  try {
    const inn = require("./CitizenInnkeepers");
    if (inn && typeof inn.innTypeFor === "function" && inn.innTypeFor(record.username) === "bard") {
      return null; // sings in the inn — not a hall bard
    }
  } catch { /* sibling unavailable; continue */ }
  const h = hashStr(name);
  if (h % 100 >= BARD_FRACTION_PCT) return null;
  return bardTypeFromRoll((h >>> 8) % 100);
}

/** Kingdom-preferred venue for a record. */
function venueFor(record) {
  const kid = record?.kingdomId;
  const local = VENUES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : VENUES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name) % pool.length];
}

/** The troupe of a kingdom. */
function troupeForKingdom(kingdomId) {
  const local = TROUPES.filter((t) => t.kingdom === kingdomId);
  return local.length ? local[0] : TROUPES[0];
}

/**
 * Which kingdom the troupe is touring this week. Troupes rotate one
 * kingdom per week in a fixed ring, announced on arrival.
 */
function tourKingdomFor(troupe, nowMs) {
  const kingdoms = ["varrock", "asgarnia", "kandarin", "keldagrim", "morytania"];
  const week = Math.floor(nowMs / (7 * 86400000));
  const idx = (kingdoms.indexOf(troupe.kingdom) + week) % kingdoms.length;
  return kingdoms[(idx + kingdoms.length) % kingdoms.length];
}

/** The daily song for a bard: repertoire pick derived from date + name. */
function songFor(username, type, nowMs) {
  const songs = REPERTOIRE[type] || REPERTOIRE[BARD_MINSTREL];
  const h = hashStr(normalizeName(username) + ":" + dayNumber(nowMs));
  return songs[h % songs.length];
}

/** The court bard of a kingdom: hash-picked, stable across restarts. */
function courtBardFor(kingdomId, roster) {
  let best = null;
  let bestH = -1;
  for (const record of roster?.values?.() ?? []) {
    if (record?.kingdomId !== kingdomId) continue;
    if (!bardTypeOf(record)) continue;
    const h = hashStr("court:" + normalizeName(record.username));
    if (h > bestH) { bestH = h; best = record; }
  }
  return best;
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

/**
 * Scan recent journal entries across the roster for newsworthy words
 * and return a short event description for the ballad-of-the-week, or
 * null when nothing sings-worthy turned up. Cheap: bounded scan,
 * at most once per kingdom per day (caller gates).
 */
function balladEventFor(director) {
  const keywords = [
    ["wedding", "a wedding"],
    ["married", "a wedding"],
    ["festival", "the festival"],
    ["election", "the election"],
    ["crowned", "a crowning"],
    ["victory", "a great victory"],
    ["dragon", "the dragon-slaying"],
    ["tournament", "the tournament"],
    ["treaty", "the treaty"],
  ];
  try {
    const j = journalEvent();
    if (!j || !j.entries) return null;
    let scanned = 0;
    for (const record of j.entries.values()) {
      for (const ev of record?.events ?? []) {
        const text = String(ev?.text ?? "").toLowerCase();
        for (const [word, desc] of keywords) {
          if (text.includes(word)) return desc;
        }
        if (++scanned > 400) return null;
      }
    }
  } catch { /* best effort */ }
  return null;
}

/** Compose the ballad-of-the-week title from an event description. */
function balladTitleFor(rng, eventDesc) {
  const subject = eventDesc.replace(/^a |^the /, "").replace(/^[a-z]/, (c) => c.toUpperCase());
  return fill(pickOne(rng, BALLAD_TITLES), { subject });
}

/**
 * Commission a troupe for an occasion (data tier, zero LLM).
 * Returns the commission record. Journaled so the LLM answers truthfully.
 */
function commissionTroup(playerName, kingdomId, occasion, nowMs = Date.now()) {
  const troupe = troupeForKingdom(kingdomId);
  const key = normalizeName(playerName) + ":" + dayNumber(nowMs);
  const rec = {
    player: playerName,
    troupe: troupe.name,
    occasion: occasion || pickOne(Math.random, COMMISSION_OCCASIONS),
    at: nowMs,
  };
  commissions.set(key, rec);
  const seed = seedRumorFn();
  try {
    seed?.(`{troupe} were commissioned for a {occasion}!`.replace("{troupe}", troupe.name).replace("{occasion}", rec.occasion));
  } catch { /* cosmetic */ }
  return rec;
}

/** Look up a player's active commission. */
function commissionFor(playerName, nowMs = Date.now()) {
  const key = normalizeName(playerName) + ":" + dayNumber(nowMs);
  const rec = commissions.get(key);
  if (!rec || nowMs - rec.at > COMMISSION_TTL_MS) return null;
  return rec;
}

/** A player requests a song by name (data tier, zero LLM). */
function requestSong(playerName, song, nowMs = Date.now()) {
  const key = normalizeName(playerName) + ":" + dayNumber(nowMs);
  const rec = { player: playerName, song, at: nowMs };
  songRequests.set(key, rec);
  return rec;
}

/** Look up a player's song request for today. */
function requestFor(playerName, nowMs = Date.now()) {
  const key = normalizeName(playerName) + ":" + dayNumber(nowMs);
  const rec = songRequests.get(key);
  if (!rec || nowMs - rec.at > REQUEST_TTL_MS) return null;
  return rec;
}

/** Does the repertoire contain this song name (case-insensitive)? */
function songExists(song) {
  const want = String(song).toLowerCase().trim();
  return Object.values(REPERTOIRE).some((songs) =>
    songs.some((s) => s.toLowerCase() === want)
  );
}

// ============================================================================
// Coin tips: "use coins on bard" (registered in Citizens.plugin.js onTipSeen
// alongside tipPerformer). Each handler ignores targets that are not its own.
// ============================================================================

/** True when the roster record is a citizen bot (not a real player). */
function isCitizenBot(player) {
  try {
    return player?.isPlayerBot?.() === true || player?.getHostAddress?.() === "bot";
  } catch {
    return false;
  }
}

function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

function tipBard(event, deps = {}, nowMs = Date.now()) {
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
  const type = bardTypeOf(record);
  if (!type) return; // not a bard — let the gift handler have it

  const playerName = player.getUsername?.() ?? "traveller";
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
  try {
    const mem = getMemory();
    mem?.remember?.(name, playerName, "tipped " + amount + " coins", TIP_MEMORY_TONE);
  } catch { /* cosmetic */ }
  journalize(target, `was tipped ${amount} coins by ${playerName} after a performance`);
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) -> is bard -> materialized -> real player
// near -> performance hours -> chance -> work.
// ============================================================================

function tickBards(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    const rng = desync?.rngFor?.("bards") ?? Math.random;
    for (const record of director.roster?.values?.() ?? []) {
      const last = lastFiredByCitizen.get(record.username) || 0;
      if (nowMs - last < BARD_COOLDOWN_MS) continue;

      let type;
      try {
        type = bardTypeOf(record);
      } catch {
        continue;
      }
      if (!type) continue;

      const citizen = (director.isOnline(record) ? director.getBot(record) : null);
      if (!citizen) continue;
      if (!anyRealPlayerNear(director, citizen, PERFORMANCE_RADIUS)) continue;
      if (!isPerformanceHour(nowMs)) continue;
      if (rng() > BARD_CHANCE) continue;

      try {
        performSet(director, record, citizen, type, nowMs, rng);
      } catch (e) {
        // Per-citizen try/catch: one bad bot never breaks the tick.
        console.warn("[citizen-bards] set failed:", e?.message ?? e);
      }
      lastFiredByCitizen.set(record.username, nowMs);
    }

    // Daily rhythms: troupe arrivals, premieres, ballads (cheap, day-gated).
    dailyRhythms(director, nowMs, rng);
  } catch (e) {
    console.warn("[citizen-bards] tick failed:", e?.message ?? e);
  }
}

/** A bard performs a set for the nearby audience. */
function performSet(director, record, citizen, type, nowMs, rng) {
  const venue = venueFor(record);
  const troupe = troupeForKingdom(record.kingdomId);
  const req = nearbyRequest(director, citizen, nowMs);
  const song = req ? req.song : songFor(record.username, type, nowMs);

  if (req) {
    forceSay(citizen, fill(pickOne(rng, REQUEST_LINES), { song }));
  }
  forceSay(citizen, fill(pickOne(rng, PERFORMANCE_LINES[type]), { song }));

  journalize(citizen, `performed ${song} at ${venue.name} for ${troupe.name}'s evening crowd`);
}

/** A nearby real player with a pending song request, if any. */
function nearbyRequest(director, citizen, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, PERFORMANCE_RADIUS)) continue;
      const req = requestFor(p.getUsername?.() ?? "", nowMs);
      if (req && songExists(req.song)) return req;
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day per-kingdom rhythms: arrivals, premieres, ballads. */
function dailyRhythms(director, nowMs, rng) {
  const day = dayNumber(nowMs);
  try {
    for (const troupe of TROUPES) {
      const touring = tourKingdomFor(troupe, nowMs);
      if ((lastTroupeAnnounce.get(troupe.name) ?? -1) < day && touring !== troupe.kingdom) {
        lastTroupeAnnounce.set(troupe.name, day);
        const venue = VENUES.find((v) => v.kingdom === touring) ?? VENUES[0];
        const line = fill(pickOne(rng, TROUPE_ARRIVAL_LINES), { troupe: troupe.name, venue: venue.name });
        journalize({ username: troupe.name }, `${troupe.name} arrived in ${touring}: ${line}`);
        const seed = seedRumorFn();
        try { seed?.(line); } catch { /* cosmetic */ }
      }
      if ((lastPremiereByKingdom.get(troupe.kingdom) ?? -1) < day && chance(rng, 15)) {
        lastPremiereByKingdom.set(troupe.kingdom, day);
        const song = "New " + pickOne(rng, ["Reel", "Lament", "Ballad", "Round"]) + " in " + pickOne(rng, ["G", "D", "A", "C"]);
        const line = fill(pickOne(rng, PREMIERE_LINES), { song, bard: troupe.name });
        journalize({ username: troupe.name }, line);
        const seed = seedRumorFn();
        try { seed?.(line); } catch { /* cosmetic */ }
      }
      if ((lastBalladByKingdom.get(troupe.kingdom) ?? -1) < day) {
        const eventDesc = balladEventFor(director);
        if (eventDesc) {
          lastBalladByKingdom.set(troupe.kingdom, day);
          const title = balladTitleFor(rng, eventDesc);
          const line = fill(pickOne(rng, BALLAD_TEMPLATES), { ballad: title, event: eventDesc });
          journalize({ username: troupe.name }, `composed ${title}: ${line}`);
          const seed = seedRumorFn();
          try { seed?.(line); } catch { /* cosmetic */ }
        }
      }
    }
  } catch { /* daily rhythms are best-effort */ }
}

/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    citizen.forceChat?.(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
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

module.exports = {
  tickBards,
  tipBard,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  bardTypeOf,
  venueFor,
  troupeForKingdom,
  tourKingdomFor,
  songFor,
  songExists,
  courtBardFor,
  commissionTroup,
  commissionFor,
  requestSong,
  requestFor,
  nearbyRequest,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  bardTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isPerformanceHour,
  balladTitleFor,
  BARD_TYPES,
  BARD_MINSTREL,
  BARD_INSTRUMENTALIST,
  BARD_STORYTELLER,
  BARD_JESTER,
  REPERTOIRE,
  VENUES,
  TROUPES,
};
