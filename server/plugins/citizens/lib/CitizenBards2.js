"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenBards2 — the amateur songfolk: street buskers, tale-spinners,
 * amateur minstrels, and ballad-swappers. Commoners who play simple tunes
 * at campfire circles and community stages, spin two-minute verses, teach
 * their friends a jig, and trade ballad verses with travelers — music as
 * a way of life, not a trade.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived songfolk types, per-day tune rotas, campfire-circle and
 *   community-stage rotas, rival ballad-contest days, rare recovered
 *   legendary ballads, 7-day TTL ledgers for song requests, coin tips and
 *   tune lessons.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 10:00-23:00 local): scripted busking emotes, tune callouts, tune
 * requests honored, ballad-swap banter, contest fanfare, recovered-ballad
 * moments, lessons offered.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the hostfolk block. Plain-node
 * testable: CitizenBards2.test.js.
 *
 * No overlap (by design):
 *   - CitizenBards owns the PROFESSIONAL trade (hall minstrels with named
 *     repertoire, troupes, tours, commissions, premieres) — bardTypeOf()
 *     citizens are excluded via the real module's null path.
 *   - CitizenStreetPerformers owns anchored street busking (squares,
 *     markets, tavern entrances, 10:00-22:00, tips by tipPerformer) —
 *     performerTypeOf() citizens are excluded; songfolk buskers play the
 *     campfire circles and community stages, never the anchored spots.
 *   - CitizenInnkeepers' bards sing short verses in the inns — excluded
 *     via innTypeFor() === "bard"; songfolk never play the inns.
 *   - CitizenStorytellers owns LONG-form oral tales and legends (an
 *     activity every commoner holds, so it cannot be excluded). The line
 *     is by form: tale-spinners here do SHORT-form — quick rhymes,
 *     limericks, shanty choruses, two-minute campfire verses — never the
 *     full gathered-crowd epics.
 *   - CitizenFestivals owns festival events; songfolk only play at them.
 */

// === Tuning: all magic numbers here ===
const SONFOLK_RADIUS = 14; // tiles — close enough to see/hear
const SONFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const SONFOLK_CHANCE = 0.15; // per eligible citizen per tick
const SONFOLK_SHARE = 40; // ~40% nominal share of commoners (post-exclusion)
const CONTEST_CHANCE = 0.08; // ~8% per venue per day of a rival ballad contest
const LEGEND_CHANCE = 0.03; // ~3% per kingdom per day of a legendary ballad recovered
const SONG_START_HOUR = 10; // 10:00 server local time
const SONG_END_HOUR = 23; // 23:00 server local time
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;
const REQUEST_TTL_MS = 24 * 3600 * 1000;
const COINS_ID = 995;
const TIP_MAX_COINS = 5000; // buskers get coppers, not purses

// === Top-level safeRequires (potters perf lesson: no lazy requires in the
// per-citizen type path). The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProBards = safeRequire("./CitizenBards");
const StreetPerformers = safeRequire("./CitizenStreetPerformers");
const ProInnkeepers = safeRequire("./CitizenInnkeepers");
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");
const Memory = safeRequire("./CitizenMemory");

// === Songfolk types ===
const SONFOLK_BUSKER = "street-busker";
const SONFOLK_TALESPINNER = "tale-spinner";
const SONFOLK_MINSTREL = "amateur-minstrel";
const SONFOLK_SWAPPER = "ballad-swapper";
const SONFOLK_TYPES = [
  SONFOLK_BUSKER,
  SONFOLK_TALESPINNER,
  SONFOLK_MINSTREL,
  SONFOLK_SWAPPER,
];
const SONFOLK_WEIGHTS = {
  [SONFOLK_BUSKER]: 30,
  [SONFOLK_TALESPINNER]: 25,
  [SONFOLK_MINSTREL]: 25,
  [SONFOLK_SWAPPER]: 20,
};

// === Community venues: campfire circles and community stages, distinct
// from the pro halls, the street-performer spots and the named inns ===
const VENUES = [
  { name: "the Varrock Campfire Circle", kingdom: "misthalin" },
  { name: "the Lumbridge Green Stage", kingdom: "misthalin" },
  { name: "the Falador Common Stage", kingdom: "asgarnia" },
  { name: "the Remington Firepit", kingdom: "asgarnia" },
  { name: "the Ardougne Campfire Ring", kingdom: "kandarin" },
  { name: "the Hemenster Barn Stage", kingdom: "kandarin" },
  { name: "the Keldagrim Forge-Side Hearth", kingdom: "keldagrim" },
  { name: "the Dorgesh Hearth Circle", kingdom: "keldagrim" },
  { name: "the Darkmeyer Bonfire Ring", kingdom: "morytania" },
  { name: "the Al Kharid Oasis Campfire", kingdom: "kharidian" },
];

// === Amateur tunes: simple vernacular pieces, never hall repertoire ===
const AMATEUR_SONGS = [
  "The Mill-Turner's Jig",
  "Cooper's Reel",
  "The Sheep-Shearer's Round",
  "Hearthfire Lullaby",
  "The Turnip-Digger's Song",
  "The Tinker's Trail",
  "Moon Over the Fens",
  "The Cobbler's Clog-Dance",
];

// Fallback ballad names when the real pro repertoire can't be read.
const FALLBACK_BALLADS = [
  "The King's Road",
  "The Drunken Dwarf",
  "The Miller's Daughter",
  "The Ballad of the Nameless King",
];

// === Scripted lines ===
const WORK_LINES = {
  [SONFOLK_BUSKER]: [
    "Tunes for coppers, friends — toss one in the hat!",
  ],
  [SONFOLK_TALESPINNER]: [
    "*clears throat* ...a quick verse, then, if you'll have it!",
    "Here's a two-minute tale — hold the fire while I spin it.",
  ],
  [SONFOLK_MINSTREL]: [
    "*tunes the old lute* ...right, this one's for the circle.",
    "Know this one? Sing along if you do!",
  ],
  [SONFOLK_SWAPPER]: [
    "Heard this one up north — listen, then tell me if I got it right.",
    "A verse for a verse, friend — that's the swapper's rule.",
  ],
};

// (HAWK_LINES removed 2026-10-08 with fabrication branches.)

const REQUEST_LINES = [
  "'{tune}'? Aye, I know that one! *plays*",
  "Ah, '{tune}' — for you, gladly! *strikes it up*",
  "'{tune}' it is! Sing the chorus with me!",
];

// (SWAP_LINES removed 2026-10-08 with fabrication branches.)

const LESSON_LINES = [
  "Want to learn '{tune}'? Three chords and a chorus — I'll show you.",
  "I'll teach you '{tune}' — bring your own lute and patience.",
  "Lessons are free for neighbors. '{tune}' first, then something harder.",
];

const CONTEST_LINES = [
  "Rival ballad contest at {venue}! {a} faces {b} — the circle picks the winner!",
  "The circle gathers at {venue}: {a} against {b} for the ballad crown!",
  "A contest of verses at {venue}! {a} and {b}, sing for your supper!",
];

const CONTEST_RESULT_LINES = [
  "The circle roars for {winner}! A new ballad champion at {venue}!",
  "{winner} takes the contest! {venue} will hum that chorus all week!",
];

const LEGEND_LINES = [
  "A lost verse resurfaces! '{ballad}' — thought gone for a generation — sung again at {venue}!",
  "By the firelight: '{ballad}', the legendary ballad, remembered whole at {venue}!",
  "The old ones wept — '{ballad}' lives again, sung true at {venue}!",
];

const TIP_THANKS = [
  "*grins, tipping the hat* A copper for the songfolk! Many thanks!",
  "Bless your pocket! The next verse is for you!",
  "*bows to the tipper* Coin in the hat, song in the air!",
  "Ha! Coppers keep the strings fresh — thank you, friend!",
];

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Ledgers (TTL'd) ===
const songRequests = new Map(); // normName -> { tune, at }
const tipRecords = new Map(); // normName -> { amount, at }
const lessonRecords = new Map(); // normName -> { tune, teacher, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of songRequests) {
    if (nowMs - v.at > REQUEST_TTL_MS) songRequests.delete(k);
  }
  for (const [k, v] of tipRecords) {
    if (nowMs - v.at > LEDGER_TTL_MS) tipRecords.delete(k);
  }
  for (const [k, v] of lessonRecords) {
    if (nowMs - v.at > LEDGER_TTL_MS) lessonRecords.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
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

/** Weighted pick of a songfolk type from a 0..99 roll. */
function songfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of SONFOLK_TYPES) {
    acc += SONFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return SONFOLK_BUSKER;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during song hours (10:00-23:00 server local time). */
function isSongHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= SONG_START_HOUR && h < SONG_END_HOUR;
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

/** Cheap rng from a seed (mulberry-ish LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

/** Normalized username via CitizenBonds (fallback: lowercase). */
function normalizeName(name) {
  try {
    if (Bonds && typeof Bonds.normalizeName === "function") return Bonds.normalizeName(name);
  } catch { /* fall through */ }
  return String(name ?? "").toLowerCase();
}

// ============================================================================
// Songfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The songfolk type for a roster record, or null.
 * Excludes professional bards (the real CitizenBards.bardTypeOf — it has a
 * null path via the profession partition, so it is a valid eligibility
 * gate), anchored street performers (CitizenStreetPerformers.performerTypeOf
 * — they own the squares/markets/tavern spots), and inn bards
 * (innTypeFor() === "bard" — they own the inns). Uses name-first salts to
 * avoid the FNV-1a prefix-correlation bug.
 */
function songfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    // No overlap: the professional trade owns the halls.
    if (ProBards && typeof ProBards.bardTypeOf === "function") {
      try {
        if (ProBards.bardTypeOf(record)) return null;
      } catch { /* bard check failed */ }
    }
    // No overlap: street performers own the anchored busking spots.
    if (StreetPerformers && typeof StreetPerformers.performerTypeOf === "function") {
      try {
        if (StreetPerformers.performerTypeOf(record)) return null;
      } catch { /* performer check failed */ }
    }
    // No overlap: inn bards own the inns.
    if (ProInnkeepers && typeof ProInnkeepers.innTypeFor === "function") {
      try {
        if (ProInnkeepers.innTypeFor(record.username) === "bard") return null;
      } catch { /* innkeeper check failed */ }
    }
    const roll = hashStr(name + "|songfolk") % 100;
    if (roll >= SONFOLK_SHARE) return null;
    return songfolkTypeFromRoll(hashStr(name + "|songfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred venue assignment, stable across restarts. */
function venueFor(record) {
  const kid = record?.kingdomId;
  const local = VENUES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : VENUES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr(name + "|songfolk-venue") % pool.length];
}

// (tuneForToday removed 2026-10-08: hash-derived fabrication.)

/**
 * The REAL named ballads circulating the world — read from the actual
 * professional repertoire table (top-level safeRequire, never throws) so
 * ballad-swappers trade songs the halls genuinely know. Static fallback
 * when the pro module is absent.
 */
function knownBallads() {
  try {
    const rep = ProBards?.REPERTOIRE;
    if (rep && typeof rep === "object") {
      const all = [];
      for (const songs of Object.values(rep)) {
        if (Array.isArray(songs)) all.push(...songs);
      }
      if (all.length) return all;
    }
  } catch { /* module absent */ }
  return FALLBACK_BALLADS.slice();
}

// (swappedBalladFor removed 2026-10-08: hash-derived fabrication.)

/** A short traveler epithet for contest challengers (stable per venue+day). */
const CONTEST_CHALLENGERS = [
  "a one-eyed luter from Remington",
  "a pipe-player off the trade roads",
  "a weaver's lad with a drum",
  "a charcoal-burner's daughter with a harp",
  "a retired sailor with a concertina",
];

// (contestFor removed 2026-10-08: hash-derived fabrication, no production callers.)

// (legendFor removed 2026-10-08: hash-derived fabrication, no production callers.)

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Request a tune by name: recorded; the songfolk perform it when near. */
function requestTune(playerName, tune, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !tune) return null;
  pruneLedgers(nowMs);
  const rec = { tune: String(tune), at: nowMs };
  songRequests.set(name, rec);
  return rec;
}

/** The player's pending tune request, or null. */
function requestFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = songRequests.get(name);
  if (!rec || nowMs - rec.at > REQUEST_TTL_MS) return null;
  return rec;
}

/** Record a tune lesson a songfolk taught a player (mentor-style ledger). */
function giveLesson(playerName, tune, teacherName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !tune) return null;
  pruneLedgers(nowMs);
  const rec = { tune: String(tune), teacher: String(teacherName ?? ""), at: nowMs };
  lessonRecords.set(name, rec);
  return rec;
}

/** The last tune lesson a player received, or null. */
function lessonFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = lessonRecords.get(name);
  if (!rec || nowMs - rec.at > LEDGER_TTL_MS) return null;
  return rec;
}

/** Does the amateur songbook contain this tune name (case-insensitive)? */
function tuneExists(tune) {
  const want = String(tune).toLowerCase().trim();
  return AMATEUR_SONGS.some((s) => s.toLowerCase() === want);
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

// Canonical: getJournal().log(name, kind, text). The appendEntry/addEntry
// probe pattern is dead — CitizenJournal only exports getJournal() with a
// log() method.
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

function journalize(citizenName, text) {
  try {
    journal()?.log(citizenName, "work", text);
  } catch {
    /* journal is best-effort; never break the tick */
  }
}


/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
  } catch { /* cosmetic */ }
}

// ============================================================================
// Coin tips: "use coins on busker" (registered in Citizens.plugin.js
// onTipSeen after tipPotter). Each handler ignores non-own targets.
// ============================================================================

function getDirectorSafe() {
  try {
    return require("../director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

function tipBusker(event, deps = {}, nowMs = Date.now()) {
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
  if (!record) return;
  // Only songfolk buskers take busker tips — pro bards, street performers
  // and everyone else fall through to their own handlers.
  let type;
  try {
    type = songfolkTypeOf(record);
  } catch {
    return;
  }
  if (type !== SONFOLK_BUSKER) return;

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
  tipRecords.set(name, { amount, at: nowMs });
  forceSay(target, pickOne(Math.random, TIP_THANKS));
  try {
    Memory?.remember?.(name, playerName, "tipped " + amount + " coins", 1);
  } catch { /* cosmetic */ }
  journalize(target, `was tipped ${amount} coins by ${playerName} while busking`);
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → songfolk? →
// materialized → song hours → real player near → chance → work.
// ============================================================================

function tickSongfolk(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  pruneLedgers(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < SONFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible songfolk life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be songfolk (hash-derived, cheap; exclusions inside)
        const type = songfolkTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Song hours only
        if (!isSongHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, SONFOLK_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, SONFOLK_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doSongfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-songfolk] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: rival contests and recovered legends (cheap, day-gated).
    // (dailyRhythms removed 2026-10-08: hash-derived fake events.)
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-songfolk] tick failed:", e?.message ?? e);
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

function doSongfolkWork(director, record, citizen, type, nowMs) {
  const venue = venueFor(record);
  // (tuneForToday removed 2026-10-08: hash-derived "today's tune" was fabrication.)

  // A nearby player's pending tune request takes priority.
  const req = nearbyRequest(director, citizen, nowMs);
  if (req && (type === SONFOLK_BUSKER || type === SONFOLK_MINSTREL)) {
    forceSay(citizen, fill(pickOne(Math.random, REQUEST_LINES), { tune: req.tune }));
    journalize(citizen, `played requested tune '${req.tune}' at ${venue.name}`);
    return;
  }

  // Routine: honest ambient performance chatter only.
  // (tuneForToday/swappedBalladFor removed 2026-10-08: hash-derived tune titles
  // were fabrication — the bard performs, but specific titles were invented.)
  if (type === SONFOLK_BUSKER) {
    forceSay(citizen, pickOne(Math.random, WORK_LINES[SONFOLK_BUSKER]));
    journalize(citizen, `busked at ${venue.name}`);
  } else if (type === SONFOLK_TALESPINNER) {
    forceSay(citizen, pickOne(Math.random, WORK_LINES[SONFOLK_TALESPINNER]));
    journalize(citizen, `spun a verse at ${venue.name}`);
  } else if (type === SONFOLK_MINSTREL) {
    forceSay(citizen, pickOne(Math.random, WORK_LINES[SONFOLK_MINSTREL]));
    journalize(citizen, `played for the circle at ${venue.name}`);
  } else {
    // ballad-swapper
    forceSay(citizen, pickOne(Math.random, WORK_LINES[SONFOLK_SWAPPER]));
    journalize(citizen, `swapped verses at ${venue.name}`);
  }
}

/** A nearby real player with a pending tune request, if any. */
function nearbyRequest(director, citizen, nowMs) {
  try {
    for (const p of [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean)) {
      if (!isRealPlayer(p)) continue;
      if (!withinTiles(citizen, p, SONFOLK_RADIUS)) continue;
      const req = requestFor(p.getUsername?.() ?? "", nowMs);
      if (req && req.tune) return req;
    }
  } catch { /* best effort */ }
  return null;
}

/** Once-per-day venue/kingdom rhythms: contests and recovered legends. */
// (function dailyRhythms removed 2026-10-08: hash-derived fake events.)

module.exports = {
  tickSongfolk,
  tipBusker,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  songfolkTypeOf,
  venueFor,
  knownBallads,
  requestTune,
  requestFor,
  giveLesson,
  lessonFor,
  tuneExists,
  nearbyRequest,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  songfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isSongHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  SONFOLK_TYPES,
  SONFOLK_BUSKER,
  SONFOLK_TALESPINNER,
  SONFOLK_MINSTREL,
  SONFOLK_SWAPPER,
  VENUES,
  AMATEUR_SONGS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    songRequests.clear();
    tipRecords.clear();
    lessonRecords.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
