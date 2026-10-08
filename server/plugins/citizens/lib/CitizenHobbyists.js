"use strict";

/**
 * CitizenHobbyists — gardeners, birdwatchers, collectors and board-game
 * players who pursue personal hobbies in their free time.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived hobby types, per-day pursuits, collections that grow over
 *   time (derived, zero storage), weekly hobby-club meetups, 7-day TTL
 *   player ledgers for club membership, game challenges and collectible
 *   trades.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   scripted hobby emotes, collection show-offs, rare-bloom / rare-bird /
 *   rare-find unveilings as crowd moments, club meetup announcements,
 *   board-game challenges.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * ACTIVITY SYSTEM, not a profession: any citizen can have a hobby — no
 * professional exclusion chain (see the chain-saturation warning in the
 * citizen-ai-builder skill). Distinct from CitizenSports (year-round league
 * sports) and CitizenFestivalGames (festival-window competitions): this
 * module owns leisure-time hobbies — gardening, birdwatching, collecting,
 * board games.
 *
 * Wired into the director proximity tick right after the sports block.
 * Plain-node testable: CitizenHobbyists.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { isHobbyVisible } = require("./CitizenPrimaryHobby"); // Phase 2: visibility weighting

// === Tuning ===
const HOBBY_RADIUS = 14; // tiles — close enough to see/hear
const HOBBY_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const HOBBY_CHANCE = 0.35; // per eligible citizen per proximity tick
const RARE_FIND_CHANCE = 0.08; // per citizen per day — the crowd moment
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Hobby types ===
const HOBBY_GARDENER = "gardener";
const HOBBY_BIRDWATCHER = "birdwatcher";
const HOBBY_COLLECTOR = "collector";
const HOBBY_GAMER = "gamer";
const HOBBY_TYPES = [HOBBY_GARDENER, HOBBY_BIRDWATCHER, HOBBY_COLLECTOR, HOBBY_GAMER];
const HOBBY_WEIGHTS = {
  [HOBBY_GARDENER]: 30,
  [HOBBY_BIRDWATCHER]: 25,
  [HOBBY_COLLECTOR]: 25,
  [HOBBY_GAMER]: 20,
};

// === Hobby clubs (kingdom-preferred) ===
const CLUBS = [
  { name: "the Varrock Gardening Society", kingdom: "misthalin", hobby: HOBBY_GARDENER },
  { name: "the Falador Flower Club", kingdom: "asgarnia", hobby: HOBBY_GARDENER },
  { name: "the Ardougne Birdwatchers", kingdom: "kandarin", hobby: HOBBY_BIRDWATCHER },
  { name: "the Hemenster Fanciers", kingdom: "kandarin", hobby: HOBBY_BIRDWATCHER },
  { name: "the Keldagrim Collectors' Circle", kingdom: "keldagrim", hobby: HOBBY_COLLECTOR },
  { name: "the Dorgesh Curiosity Cabinet", kingdom: "keldagrim", hobby: HOBBY_COLLECTOR },
  { name: "the Darkmeyer Game Night", kingdom: "morytania", hobby: HOBBY_GAMER },
  { name: "the Meiyerditch Draughts Club", kingdom: "morytania", hobby: HOBBY_GAMER },
  { name: "the Al Kharid Runelink League", kingdom: "kharidian", hobby: HOBBY_GAMER },
  { name: "the Lumbridge Allotment Association", kingdom: "misthalin", hobby: HOBBY_GARDENER },
];

// === Hobby content ===
const PURSUITS = {
  [HOBBY_GARDENER]: [
    "tending the marigolds",
    "pruning the roses",
    "planting sweetpeas",
    "weeding the herb border",
    "deadheading the daisies",
    "mulching the beds",
  ],
  [HOBBY_BIRDWATCHER]: [
    "scanning the treeline",
    "noting a wren's call",
    "sketching a jay",
    "watching the swallows",
    "checking the nest boxes",
    "listening for owls",
  ],
  [HOBBY_COLLECTOR]: [
    "sorting stamps",
    "polishing old coins",
    "cataloguing shells",
    "arranging beetles",
    "pressing flowers",
    "filing postcards",
  ],
  [HOBBY_GAMER]: [
    "setting up the draughts board",
    "studying a runelink puzzle",
    "shuffling the tiles",
    "replaying last night's game",
    "chalking a new ladder",
    "teaching a beginner",
  ],
};

const SHOW_LINES = {
  [HOBBY_GARDENER]: [
    "*sniffs a prize rose*",
    "*holds up a perfect marigold*",
    "Smell that — three years of compost in one bloom.",
    "*ties up a leaning delphinium*",
  ],
  [HOBBY_BIRDWATCHER]: [
    "*raises the spyglass*",
    "*jots in a worn notebook*",
    "Shh — goldfinch, two o'clock, on the alder.",
    "*points excitedly at the sky*",
  ],
  [HOBBY_COLLECTOR]: [
    "*polishes a rare coin*",
    "*holds a stamp to the light*",
    "This one's from the first printing — see the misaligned frame?",
    "*lays out the collection in neat rows*",
  ],
  [HOBBY_GAMER]: [
    "*moves a draughts piece*",
    "*studies the board, chin in hand*",
    "Your move — and mind the trap on the left flank.",
    "*sets up the pieces for another round*",
  ],
};

const RARE_FINDS = {
  [HOBBY_GARDENER]: [
    "a black orchid, blooming out of season",
    "a golden rose with a perfect spiral",
    "a blue daisy nobody can name",
  ],
  [HOBBY_BIRDWATCHER]: [
    "a kingfisher diving at dawn",
    "a snowy owl far south of its range",
    "a phoenix feather, still warm",
  ],
  [HOBBY_COLLECTOR]: [
    "a first-edition stamp with the inverted frame",
    "an ancient coin from a fallen king's mint",
    "a shell no trader has ever seen",
  ],
  [HOBBY_GAMER]: [
    "a flawless victory in eleven moves",
    "a runelink solved blindfolded",
    "a comeback from three pieces down",
  ],
};

const RARE_LINES = [
  "You won't believe this — {find}!",
  "Come and look! {find}!",
  "Years I've waited — and today: {find}!",
];

const CLUB_LINES = [
  "{club} meets {day} — all welcome, bring your own {gear}!",
  "Don't forget: {club} gathers {day}!",
];

const CHALLENGE_LINES = [
  "Fancy a game of draughts? Loser buys the ale.",
  "I could use a worthier opponent — care for a round?",
  "Runelink, best of three? I'll go easy on you. Probably.",
];

const CLUB_GEAR = {
  [HOBBY_GARDENER]: "trowel",
  [HOBBY_BIRDWATCHER]: "spyglass",
  [HOBBY_COLLECTOR]: "album",
  [HOBBY_GAMER]: "board",
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

// === Ledgers (7-day TTL) ===
const clubMembers = new Map(); // normName -> { club, at }
const challenges = new Map(); // normName -> { challenger, game, at }
const trades = new Map(); // normName -> { item, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  const cutoff = nowMs - LEDGER_TTL_MS;
  for (const [k, v] of clubMembers) if (v.at < cutoff) clubMembers.delete(k);
  for (const [k, v] of challenges) if (v.at < cutoff) challenges.delete(k);
  for (const [k, v] of trades) if (v.at < cutoff) trades.delete(k);
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

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
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

/** Weighted pick of a hobby type from a 0..99 roll. */
function hobbyTypeFromRoll(roll) {
  let acc = 0;
  for (const t of HOBBY_TYPES) {
    acc += HOBBY_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return HOBBY_GARDENER;
}

// ============================================================================
// Hobby identity — hash-derived, stable across restarts, no storage.
// ACTIVITY SYSTEM: no professional exclusions. Any citizen may have a hobby.
// ============================================================================

/**
 * The hobby type for a roster record, or null for non-commoners.
 * No exclusion chain — hobbies are leisure, not profession.
 */
function hobbyTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    return hobbyTypeFromRoll(hashStr("hobby:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred hobby club for a record (may be a different hobby's club). */
function clubFor(record) {
  const kid = record?.kingdomId;
  const local = CLUBS.filter((c) => c.kingdom === kid);
  const pool = local.length ? local : CLUBS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("hobbyclub:" + name) % pool.length];
}

/** The weekly meetup day (0=Sunday..6=Saturday) for a club, derived. */
function clubDay(club) {
  return hashStr("clubday:" + club.name) % 7;
}

/** Today's pursuit for a hobbyist — derived from date + hash, zero storage. */
function pursuitFor(username, hobby, dateMs) {
  const name = normalizeName(username) || "anon";
  const pool = PURSUITS[hobby] ?? PURSUITS[HOBBY_GARDENER];
  const day = dayNumber(dateMs);
  return pool[hashStr("pursuit:" + name + ":" + day) % pool.length];
}

/**
 * Collection size for a collector — grows ~1 item per week, derived.
 * For other hobbies returns blooms spotted / birds logged / games won.
 */
function collectionCount(username, hobby, dateMs) {
  const name = normalizeName(username) || "anon";
  const days = dayNumber(dateMs);
  const start = hashStr("hobbystart:" + name) % 365;
  const weeks = Math.max(0, Math.floor((days - start) / 7));
  return 3 + (weeks % 200) + (hashStr("hobbybonus:" + name) % 5);
}

/** Today's rare find for a hobbyist (~8%/day), or null. */
function rareFindFor(username, hobby, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("rarefind:" + name + ":" + day));
  if (rng() >= RARE_FIND_CHANCE) return null;
  const pool = RARE_FINDS[hobby] ?? RARE_FINDS[HOBBY_GARDENER];
  return pickOne(rng, pool);
}

// ============================================================================
// Player ledgers (data tier, zero LLM).
// ============================================================================

/** Join a hobby club: recorded; the LLM tier handles the welcome dialogue. */
function joinClub(playerName, clubName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !clubName) return null;
  pruneLedgers(nowMs);
  clubMembers.set(name, { club: String(clubName), at: nowMs });
  return clubName;
}

/** The club a player belongs to, or null. */
function clubMemberFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = clubMembers.get(name);
  return rec ? rec.club : null;
}

/** Record a board-game challenge issued to a player. */
function challengePlayer(challengerName, playerName, game, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !challengerName) return null;
  pruneLedgers(nowMs);
  challenges.set(name, { challenger: normalizeName(challengerName), game: String(game || "draughts"), at: nowMs });
  return game;
}

/** The pending challenge for a player, or null. */
function challengeFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  return challenges.get(name) ?? null;
}

/** Record a collectible trade offer. */
function tradeCollectible(playerName, item, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !item) return null;
  pruneLedgers(nowMs);
  trades.set(name, { item: String(item), at: nowMs });
  return item;
}

/** The pending trade offer for a player, or null. */
function tradeFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  return trades.get(name) ?? null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

function journalize(citizen, text) {
  try {
    const journal = require("./CitizenJournal");
    if (typeof journal.appendEntry === "function") {
      journal.appendEntry(citizen, text);
    } else if (typeof journal.addEntry === "function") {
      journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(text) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(text);
  } catch { /* rumors absent */ }
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) → hobby? → materialized → real player
// near → chance → work.
// ============================================================================

function tickHobbyists(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < HOBBY_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must have a hobby (hash-derived, cheap)
        const hobby = hobbyTypeOf(record);
        if (!hobby) continue;

        // 2b. Visibility weight (Phase 2 distribution fix): the primary hobby
        // always fires visibly; other hobbies fire 1/3 as often. Data stays
        // universal — only the visible tick is gated.
        if (!isHobbyVisible(record.username, "hobbyist")) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, HOBBY_RADIUS)) continue;

        // 5. Chance gate
        if (!chance(Math.random, HOBBY_CHANCE)) continue;

        // 6. Do the thing (scripted, zero LLM)
        doHobbyWork(director, record, citizen, hobby, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-hobbyists] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-hobbyists] tick failed:", e?.message ?? e);
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

function doHobbyWork(director, record, citizen, hobby, nowMs) {
  const name = normalizeName(record.username);
  const club = clubFor(record);
  const day = dayNumber(nowMs);

  // Rare find: the crowd moment, once per citizen per day.
  const rare = rareFindFor(name, hobby, nowMs);
  if (rare) {
    const key = "rare:" + name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, RARE_LINES), { find: rare });
      citizen.forceChat?.(line);
      journalize(citizen, `had a rare ${hobby} moment: ${rare}`);
      seedRumor(`${record.username} found ${rare}!`);
      return;
    }
  }

  // Club meetup announcement on the club's day.
  const today = new Date(nowMs).getDay();
  if (today === clubDay(club)) {
    const key = "club:" + club.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, CLUB_LINES), {
        club: club.name,
        day: "this " + DAY_NAMES[today],
        gear: CLUB_GEAR[club.hobby] ?? "kit",
      });
      citizen.forceChat?.(line);
      journalize(citizen, `announced the ${club.name} meetup`);
      return;
    }
  }

  // Gamers challenge lingering players to a board game.
  if (hobby === HOBBY_GAMER && Math.random() < 0.3) {
    const line = pickOne(Math.random, CHALLENGE_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, "challenged a passerby to a board game");
    return;
  }

  // Routine: hobby pursuit emote.
  const line = pickOne(Math.random, SHOW_LINES[hobby]);
  citizen.forceChat?.(line);
  journalize(citizen, `pursued a hobby: ${pursuitFor(name, hobby, nowMs)}`);
}

/**
 * Invite a lingering real player to join the hobby club.
 * Called from the tick path; the LLM dialogue tier handles the reply.
 */
function maybeInvitePlayer(record, citizen, hobby) {
  const club = clubFor(record);
  const line = fill("Ever thought of joining {club}? We meet {day}s.", {
    club: club.name,
    day: DAY_NAMES[clubDay(club)],
  });
  try {
    citizen.forceChat?.(line);
  } catch { /* cosmetic */ }
  return line;
}

module.exports = {
  tickHobbyists,
  joinClub,
  clubMemberFor,
  challengePlayer,
  challengeFor,
  tradeCollectible,
  tradeFor,
  rareFindFor,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  hobbyTypeOf,
  clubFor,
  clubDay,
  pursuitFor,
  collectionCount,
  maybeInvitePlayer,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  hobbyTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  dayNumber,
  chance,
  seededRng,
  HOBBY_TYPES,
  HOBBY_GARDENER,
  HOBBY_BIRDWATCHER,
  HOBBY_COLLECTOR,
  HOBBY_GAMER,
  CLUBS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    clubMembers.clear();
    challenges.clear();
    trades.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
