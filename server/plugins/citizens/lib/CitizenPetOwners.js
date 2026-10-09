"use strict";

/**
 * CitizenPetOwners — citizens who own pets: cats, dogs, birds, and exotic
 * companions like lizards and monkeys.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived pet-owner types, named pets with personalities and ages,
 *   per-day care routines (feeding, walking, training), weekly per-kingdom
 *   pet shows with derived winners, 7-day TTL player ledgers for adoptions,
 *   trades, and show entries.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   scripted pet-care emotes, pet show announcements and winner fanfare as
 *   the crowd moment, adoption and trade offers.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * ACTIVITY SYSTEM, not a profession: any commoner can own a pet — no
 * professional exclusion chain (see the chain-saturation warning in the
 * citizen-ai-builder skill). Distinct from CitizenHobbyists (leisure pursuits)
 * and CitizenStablehands (horse/mount care): this module owns companion
 * pets — cats, dogs, birds, exotics — their care, shows, adoption and trade.
 *
 * Wired into the director proximity tick right after the hobbyists block.
 * Plain-node testable: CitizenPetOwners.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { isHobbyVisible } = require("./CitizenPrimaryHobby"); // Phase 2: visibility weighting
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning ===
const PET_RADIUS = 14; // tiles — close enough to see/hear
const PET_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const PET_CHANCE = 0.35; // per eligible citizen per proximity tick
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Pet types ===
const PET_CAT = "cat";
const PET_DOG = "dog";
const PET_BIRD = "bird";
const PET_EXOTIC = "exotic";
const PET_TYPES = [PET_CAT, PET_DOG, PET_BIRD, PET_EXOTIC];
const PET_WEIGHTS = {
  [PET_CAT]: 30,
  [PET_DOG]: 30,
  [PET_BIRD]: 25,
  [PET_EXOTIC]: 15,
};

// === Pet names (kingdom-neutral; a pet is a pet everywhere) ===
const PET_NAMES = {
  [PET_CAT]: [
    "Whiskers", "Mittens", "Shadow", "Patches", "Smokey", "Ginger",
    "Boots", "Luna", "Felix", "Pepper", "Mischief", "Soot",
  ],
  [PET_DOG]: [
    "Rex", "Biscuit", "Scout", "Bramble", "Tilly", "Waffles",
    "Barnaby", "Nell", "Pickles", "Rusty", "Maple", "Duke",
  ],
  [PET_BIRD]: [
    "Pip", "Sunny", "Feathers", "Chirpy", "Skye", "Pudding",
    "Tweeter", "Clover", "Wren", "Doodle", "Saffron", "Beaky",
  ],
  [PET_EXOTIC]: [
    "Slinky", "Ziggy", "Pesto", "Noodles", "Kiwi", "Pickle",
    "Wiggles", "Tango", "Fig", "Mango", "Sprout", "Nibbles",
  ],
};

// === Pet personalities ===
const PET_PERSONALITIES = ["playful", "lazy", "mischievous", "loyal", "grumpy"];

// === Daily care routines per pet type ===
const CARE_ROUTINES = {
  [PET_CAT]: ["feeding the cat", "brushing the cat", "playing with a feather toy", "cleaning the litter tray"],
  [PET_DOG]: ["feeding the dog", "taking the dog for a walk", "training the dog to sit", "throwing a stick"],
  [PET_BIRD]: ["feeding the bird", "cleaning the cage", "teaching the bird a whistle", "letting the bird stretch its wings"],
  [PET_EXOTIC]: ["feeding the lizard", "misting the terrarium", "handling the monkey gently", "warming the heat rock"],
};

// === Pet show venues (kingdom-preferred) ===
const SHOW_VENUES = [
  { name: "the Varrock Pet Fair", kingdom: "misthalin" },
  { name: "the Lumbridge Showground", kingdom: "misthalin" },
  { name: "the Falador Animal Show", kingdom: "asgarnia" },
  { name: "the White Knights' Kennel Gala", kingdom: "asgarnia" },
  { name: "the Ardougne Pet Pageant", kingdom: "kandarin" },
  { name: "the Hemenster Hobby Show", kingdom: "kandarin" },
  { name: "the Keldagrim Beast Show", kingdom: "keldagrim" },
  { name: "the Dorgesh Critter Fair", kingdom: "keldagrim" },
  { name: "the Darkmeyer Night Menagerie", kingdom: "morytania" },
  { name: "the Al Kharid Desert Pets Expo", kingdom: "kharidian" },
];

// === Scripted lines ===
const CARE_LINES = {
  [PET_CAT]: [
    "Careful — {pet} bites when she's happy. It's a compliment, mostly.",
  ],
  [PET_DOG]: [
    "Who's a good boy? {pet} is. Yes he is.",
  ],
  [PET_BIRD]: [
    "{pet} learned a new tune this morning — listen!",
  ],
  [PET_EXOTIC]: [
    "Don't stare — {pet} gets shy. Or hungry. Hard to tell.",
  ],
};

const SHOWOFF_LINES = {
  [PET_CAT]: [
    "Isn't {pet} magnificent? {personality} as ever.",
    "*holds up {pet} proudly* — best mouser in the street.",
  ],
  [PET_DOG]: [
    "Look at {pet}! {personality} and twice as clever.",
    "*shows off {pet}'s new trick* — took all winter to teach.",
  ],
  [PET_BIRD]: [
    "{pet} can whistle the anthem. {personality}, that one.",
    "*perches {pet} on a finger* — isn't the plumage fine?",
  ],
  [PET_EXOTIC]: [
    "Meet {pet}. {personality} — and worth every coin.",
    "*shows off {pet}* — you won't see another like it.",
  ],
};

const SHOW_ANNOUNCE_LINES = [
  "The {venue} is this {weekday}! Bring your pets — {pet} will be there!",
  "Pet show at {venue} this {weekday}! {pet} has been practicing all week.",
  "Don't miss the {venue} — {weekday}, best in show, {pet} is entering!",
];

const WINNER_LINES = [
  "And the winner is... {pet}, owned by {owner}! {personality} to the very end!",
  "{pet} takes best in show at {venue}! Three cheers for {owner}!",
  "The judges have decided: {pet} is the finest pet in the kingdom! Well done, {owner}!",
];

const ADOPT_LINES = [
  "Thinking of a pet? {pet} came from the shelter — best decision I ever made.",
  "A {type} makes a fine companion. I can point you to a breeder.",
  "If you want one like {pet}, ask around — litters turn up most spring.",
];

const TRADE_LINES = [
  "I'd never part with {pet}... well, almost never. Make me an offer?",
  "Trading pets? {pet} stays, but I know a litter of {type}s looking for homes.",
];

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp

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

// === Player ledgers (7-day TTL) ===
const adoptions = new Map(); // normName -> { pet, type, at }
const trades = new Map(); // normName -> { offered, at }
const showEntries = new Map(); // normName -> { venue, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [k, v] of adoptions) {
    if (nowMs - v.at > LEDGER_TTL_MS) adoptions.delete(k);
  }
  for (const [k, v] of trades) {
    if (nowMs - v.at > LEDGER_TTL_MS) trades.delete(k);
  }
  for (const [k, v] of showEntries) {
    if (nowMs - v.at > LEDGER_TTL_MS) showEntries.delete(k);
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

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
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

/** Weighted pick of a pet type from a 0..99 roll. */
function petTypeFromRoll(roll) {
  let acc = 0;
  for (const t of PET_TYPES) {
    acc += PET_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return PET_CAT;
}

// ============================================================================
// Pet identity — hash-derived, stable across restarts, zero storage.
// ACTIVITY SYSTEM: no professional exclusion chain. Any commoner may own
// a pet. (See the chain-saturation warning in the citizen-ai-builder skill.)
// ============================================================================

/**
 * The pet type for a roster record, or null for non-commoners.
 * No exclusions — this is leisure, not a profession.
 */
function petTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    return petTypeFromRoll(hashStr("petowner:" + name) % 100);
  } catch {
    return null;
  }
}

/**
 * The citizen's pet: { name, type, personality, age }.
 * Derived from hashes — stable across restarts, zero storage.
 */
function petFor(record) {
  const type = petTypeOf(record);
  if (!type) return null;
  const name = normalizeName(record?.username) || "anon";
  const names = PET_NAMES[type];
  const petName = names[hashStr("petname:" + name) % names.length];
  const personality = PET_PERSONALITIES[hashStr("petpersonality:" + name) % PET_PERSONALITIES.length];
  const age = 1 + (hashStr("petage:" + name) % 12); // 1-12 years
  return { name: petName, type, personality, age };
}

/** Today's care task for a pet owner — derived from date + hash. */
function careFor(username, dateMs) {
  const name = normalizeName(username);
  if (!name) return null;
  const type = petTypeOf({ username: name });
  if (!type) return null;
  const routines = CARE_ROUTINES[type];
  const day = dayNumber(dateMs);
  return routines[hashStr("petcare:" + name + ":" + day) % routines.length];
}

// ============================================================================
// Pet shows — weekly per kingdom, derived, zero storage.
// ============================================================================

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Kingdom-preferred show venue for a citizen, stable across restarts. */
function venueFor(record) {
  const kid = record?.kingdomId;
  const local = SHOW_VENUES.filter((v) => v.kingdom === kid);
  const pool = local.length ? local : SHOW_VENUES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("petvenue:" + name) % pool.length];
}

/** The weekday (0-6) a venue holds its show — derived, stable. */
function showDay(venue) {
  return hashStr("petshowday:" + venue.name) % 7;
}

/**
 * This week's winner at a venue: { pet, owner, type, personality }.
 * Derived from the week's hash — zero storage, stable all week.
 */
function winnerFor(venue, nowMs) {
  const d = new Date(nowMs);
  const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  const weekKey = weekStart.toISOString().slice(0, 10);
  const rng = seededRng(hashStr("petshowwinner:" + venue.name + ":" + weekKey));
  const type = pickOne(rng, PET_TYPES);
  const pet = pickOne(rng, PET_NAMES[type]);
  const personality = pickOne(rng, PET_PERSONALITIES);
  // Winner owner: a plausible citizen name derived from the same seed.
  const owner = "Citizen" + (1000 + Math.floor(rng() * 9000));
  return { pet, owner, type, personality };
}

/** True if a show is happening at the venue today (local time). */
function isShowDay(venue, nowMs) {
  return new Date(nowMs).getDay() === showDay(venue);
}

// ============================================================================
// Player ledgers (data tier, zero LLM) — adoption, trade, show entry.
// ============================================================================

/** Record that a player adopted a pet. The LLM dialogue tier handles the chat. */
function adoptPet(playerName, petName, petType, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !petName) return null;
  pruneLedgers(nowMs);
  adoptions.set(name, { pet: String(petName), type: petType ?? PET_CAT, at: nowMs });
  return petName;
}

/** The active adoption for a player, or null. */
function adoptionFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = adoptions.get(name);
  return rec ? { pet: rec.pet, type: rec.type } : null;
}

/** Record a pet-trade offer from a player. */
function tradePet(playerName, offered, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !offered) return null;
  pruneLedgers(nowMs);
  trades.set(name, { offered: String(offered), at: nowMs });
  return offered;
}

/** The active trade offer for a player, or null. */
function tradeFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = trades.get(name);
  return rec ? rec.offered : null;
}

/** Enter a player's pet in the kingdom show. */
function enterShow(playerName, venueName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !venueName) return null;
  pruneLedgers(nowMs);
  showEntries.set(name, { venue: String(venueName), at: nowMs });
  return venueName;
}

/** The active show entry for a player, or null. */
function showEntryFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = showEntries.get(name);
  return rec ? rec.venue : null;
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
// Gate order: cooldown (cheapest) → pet owner? → materialized →
// real player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {number} desync - per-tick desync offset (0-59s) to spread load
 */
function tickPetOwners(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < PET_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be a pet owner (hash-derived, cheap — no exclusion chain)
        const type = petTypeOf(record);
        if (!type) continue;

        // 2b. Visibility weight (Phase 2 distribution fix): the primary hobby
        // always fires visibly; other hobbies fire 1/3 as often.
        if (!isHobbyVisible(record.username, "pet_owner")) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, PET_RADIUS)) continue;

        // 5. Chance gate
        if (!chance(Math.random, PET_CHANCE)) continue;

        // 6. Do the thing (scripted, zero LLM)
        doPetOwnerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-petowners] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-petowners] tick failed:", e?.message ?? e);
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

function doPetOwnerWork(director, record, citizen, type, nowMs) {
  const pet = petFor(record);
  if (!pet) return;
  const venue = venueFor(record);
  const slots = {
    pet: pet.name,
    type: pet.type,
    personality: pet.personality,
    venue: venue.name,
    weekday: WEEKDAYS[showDay(venue)],
    owner: record.username,
  };

  // Pet show winner: once per venue per show day, the crowd moment.
  if (isShowDay(venue, nowMs)) {
    const day = dayNumber(nowMs);
    const key = "show:" + venue.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const winner = winnerFor(venue, nowMs);
      const line = fill(pickOne(Math.random, WINNER_LINES), {
        pet: winner.pet,
        owner: winner.owner,
        personality: winner.personality,
        venue: venue.name,
      });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(citizen, `saw ${winner.pet} win best in show at ${venue.name}`);
      seedRumor(`${winner.pet} won best in show at ${venue.name}!`);
      return;
    }
  }

  // Routine: care emote, show-off, show announcement, adoption/trade offer.
  const roll = Math.random();
  if (roll < 0.4) {
    const line = fill(pickOne(Math.random, CARE_LINES[type]), slots);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `cared for ${pet.name} the ${pet.type}`);
  } else if (roll < 0.6) {
    const line = fill(pickOne(Math.random, SHOWOFF_LINES[type]), slots);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `showed off ${pet.name} the ${pet.type}`);
  } else if (roll < 0.8) {
    const line = fill(pickOne(Math.random, SHOW_ANNOUNCE_LINES), slots);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `announced the ${venue.name} pet show`);
  } else if (roll < 0.9) {
    const line = fill(pickOne(Math.random, ADOPT_LINES), slots);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `talked about pet adoption`);
  } else {
    const line = fill(pickOne(Math.random, TRADE_LINES), slots);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `talked about pet trading`);
  }
}

module.exports = {
  tickPetOwners,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  petTypeOf,
  petFor,
  careFor,
  venueFor,
  showDay,
  winnerFor,
  isShowDay,
  adoptPet,
  adoptionFor,
  tradePet,
  tradeFor,
  enterShow,
  showEntryFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  petTypeFromRoll,
  seededRng,
  chance,
  dayNumber,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  PET_TYPES,
  PET_CAT,
  PET_DOG,
  PET_BIRD,
  PET_EXOTIC,
  PET_NAMES,
  PET_PERSONALITIES,
  SHOW_VENUES,
  WEEKDAYS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    adoptions.clear();
    trades.clear();
    showEntries.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
