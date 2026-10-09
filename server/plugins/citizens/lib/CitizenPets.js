"use strict";

/**
 * CitizenPets — the data tier for citizen pets and mounts.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Pet catalog: cats, dogs, birds — real pet ITEM ids from the engine's
 *     Pets.plugin.js. Citizens own real pets (item-backed followers), not
 *     hash-fiction. A pet item in the citizen's inventory IS the durable
 *     record; this module tracks care state (happiness, hunger, fed-at).
 *   - Mounts: horses. Ownable pets whose presence speeds travel. Mounted
 *     citizens get a travel-time multiplier via travelSpeedFor().
 *   - Pet care: happiness 0..100, hunger 0..100. Feeding consumes a REAL
 *     food item from the citizen's real inventory. Happy pets boost mood;
 *     hungry pets get sad. No food → no feeding — never invented.
 *   - Taming: hunters (real Hunter skill) can tame wild pets. Taming
 *     awards a real pet item via the Pets plugin's awardPet — the same
 *     path real players use.
 *   - Breeding: two same-type adult pets owned by citizens in the same
 *     kingdom can produce a kitten/baby (real pet item, kitten stage).
 *     Breeding has a cooldown and requires both pets happy (60+).
 *   - Mounted combat: citizens with a horse and real combat stats get a
 *     small attack bonus when fighting — cavalry, honest and simple.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Hunger/happiness decay, feeding checks, breeding,
 *     and announcements live in lib/CitizenPetLife.js.
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - No invented pets: every pet is a real engine pet item id.
 *   - Never touches lib/*2 (frozen).
 *
 * Persisted to data/saves/citizen-pets.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-pets.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const HUNGER_DECAY_PER_DAY = 25; // hunger 0..100, decays this much per day
const HAPPINESS_DECAY_PER_DAY = 15; // happiness 0..100, decays this much per day
const FEED_HUNGER_RESTORE = 40; // one feeding restores this much hunger
const FEED_HAPPINESS_BOOST = 10; // feeding also boosts happiness a little
const PLAY_HAPPINESS_BOOST = 20; // playing with a pet boosts happiness
const BREED_COOLDOWN_DAYS = 7; // per-pet breeding cooldown
const BREED_MIN_HAPPINESS = 60; // both pets must be this happy to breed
const MOOD_BONUS_PER_HAPPY_PET = 4; // mood points per happy (70+) pet
const MOUNT_TRAVEL_MULTIPLIER = 0.7; // mounted travel takes 70% of the time
const MOUNT_COMBAT_BONUS = 3; // attack levels while mounted (cavalry)
const TAME_HUNTER_LEVEL = 20; // minimum Hunter level to tame

// Real pet item ids from the engine's Pets.plugin.js (PETS catalog).
// Cats: kitten 1555-1560 grow into cat 1561-1566.
const PET_CATALOG = Object.freeze({
  kitten: Object.freeze({
    id: "kitten",
    label: "kitten",
    itemIds: [1555, 1556, 1557, 1558, 1559, 1560],
    adultItemIds: [1561, 1562, 1563, 1564, 1565, 1566],
    food: "fish", // cats eat fish — real raw fish items
    mount: false,
  }),
  cat: Object.freeze({
    id: "cat",
    label: "cat",
    itemIds: [1561, 1562, 1563, 1564, 1565, 1566],
    food: "fish",
    mount: false,
  }),
  dog: Object.freeze({
    id: "dog",
    label: "dog",
    itemIds: [19760, 19761], // puppy/dog pet items (engine ids)
    food: "meat", // dogs eat meat — real cooked meat items
    mount: false,
  }),
  bird: Object.freeze({
    id: "bird",
    label: "bird",
    itemIds: [19762, 19763], // bird pet items (engine ids)
    food: "seed", // birds eat seeds — real seed items
    mount: false,
  }),
  horse: Object.freeze({
    id: "horse",
    label: "horse",
    itemIds: [19764, 19765], // horse pet items (engine ids)
    food: "hay", // horses eat hay/grain — real farming produce
    mount: true,
  }),
});

const ALL_PET_ITEM_IDS = (() => {
  const ids = [];
  for (const pet of Object.values(PET_CATALOG)) {
    ids.push(...pet.itemIds, ...(pet.adultItemIds || []));
  }
  return Object.freeze(ids);
})();

// --- in-memory state -----------------------------------------------------------

let petsByOwner = {}; // normalized username -> [ petRecord ]
let dirty = false;

function petKey(username) {
  return normalizeName(username || "");
}

// --- persistence ---------------------------------------------------------------

function load() {
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const data = JSON.parse(raw);
    petsByOwner = data.petsByOwner || {};
    dirty = false;
  } catch {
    petsByOwner = {};
    dirty = false;
  }
}

function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(
      SAVE_FILE,
      JSON.stringify({ petsByOwner, savedAt: Date.now() }, null, 2)
    );
    dirty = false;
  } catch {
    // A failed save never breaks the tick.
  }
}

function markDirty() {
  dirty = true;
}

function resetForTests() {
  petsByOwner = {};
  dirty = false;
}

// --- pet records ---------------------------------------------------------------

/**
 * A pet record: { type, itemId, name, happiness, hunger, fedAt, bredAt,
 *   tamedBy, bornAt }. The itemId is a REAL engine pet item — the pet
 *   item in the citizen's inventory is the durable record; this tracks
 *   care state.
 */
function petsOf(username) {
  const key = petKey(username);
  return petsByOwner[key] || [];
}

function addPet(username, type, itemId, opts = {}) {
  const catalog = PET_CATALOG[type];
  if (!catalog) return null;
  if (!catalog.itemIds.includes(itemId) && !(catalog.adultItemIds || []).includes(itemId)) {
    return null; // not a real pet item for this type
  }
  const key = petKey(username);
  const record = {
    type,
    itemId,
    name: opts.name || catalog.label,
    happiness: opts.happiness ?? 70,
    hunger: opts.hunger ?? 70,
    fedAt: opts.fedAt || Date.now(),
    bredAt: opts.bredAt || 0,
    tamedBy: opts.tamedBy || null,
    bornAt: opts.bornAt || Date.now(),
  };
  if (!petsByOwner[key]) petsByOwner[key] = [];
  petsByOwner[key].push(record);
  markDirty();
  return record;
}

function removePet(username, itemId) {
  const key = petKey(username);
  const list = petsByOwner[key];
  if (!list) return false;
  const idx = list.findIndex((p) => p.itemId === itemId);
  if (idx < 0) return false;
  list.splice(idx, 1);
  markDirty();
  return true;
}

function hasMount(username) {
  return petsOf(username).some((p) => PET_CATALOG[p.type]?.mount);
}

/**
 * Travel speed multiplier for a citizen. Mounted citizens travel faster.
 * Returns 1.0 (no mount) or MOUNT_TRAVEL_MULTIPLIER. Read by the travel
 * system — defensive: unknown pets never slow anyone down.
 */
function travelSpeedFor(username) {
  return hasMount(username) ? MOUNT_TRAVEL_MULTIPLIER : 1.0;
}

/**
 * Mounted combat bonus. Citizens with a horse and real combat readiness
 * get a small attack bonus — cavalry. Returns 0 without a mount.
 */
function mountedCombatBonusFor(username) {
  return hasMount(username) ? MOUNT_COMBAT_BONUS : 0;
}

/**
 * Mood bonus from pets. Each happy (70+) pet adds a few mood points.
 * Sad pets (hunger < 30) subtract. A human with a happy dog feels
 * better; a human with a starving cat feels worse.
 */
function moodBonusFor(username) {
  let bonus = 0;
  for (const pet of petsOf(username)) {
    if (pet.happiness >= 70) bonus += MOOD_BONUS_PER_HAPPY_PET;
    else if (pet.hunger < 30) bonus -= MOOD_BONUS_PER_HAPPY_PET;
  }
  return bonus;
}

/**
 * Feed a pet. Consumes nothing here — the caller (brain action) removes
 * the real food item from the citizen's real inventory. This records
 * the care: restores hunger, boosts happiness.
 * Returns true if the pet was fed (record updated).
 */
function feedPet(username, itemId) {
  const key = petKey(username);
  const list = petsByOwner[key];
  if (!list) return false;
  const pet = list.find((p) => p.itemId === itemId);
  if (!pet) return false;
  pet.hunger = Math.min(100, pet.hunger + FEED_HUNGER_RESTORE);
  pet.happiness = Math.min(100, pet.happiness + FEED_HAPPINESS_BOOST);
  pet.fedAt = Date.now();
  markDirty();
  return true;
}

/**
 * Play with a pet. Boosts happiness. No items needed — just time,
 * like a human playing with their dog.
 */
function playWithPet(username, itemId) {
  const key = petKey(username);
  const list = petsByOwner[key];
  if (!list) return false;
  const pet = list.find((p) => p.itemId === itemId);
  if (!pet) return false;
  pet.happiness = Math.min(100, pet.happiness + PLAY_HAPPINESS_BOOST);
  markDirty();
  return true;
}

/**
 * Decay hunger and happiness by elapsed days. Called by the slow tick.
 * Returns the list of pets that became critically hungry (< 20) — the
 * tick journals those so the LLM mouth can mention them.
 */
function decayPets(username, daysElapsed) {
  const key = petKey(username);
  const list = petsByOwner[key];
  if (!list || !list.length) return [];
  const critical = [];
  for (const pet of list) {
    pet.hunger = Math.max(0, pet.hunger - HUNGER_DECAY_PER_DAY * daysElapsed);
    pet.happiness = Math.max(0, pet.happiness - HAPPINESS_DECAY_PER_DAY * daysElapsed);
    // Hungry pets get sad faster.
    if (pet.hunger < 30) {
      pet.happiness = Math.max(0, pet.happiness - HAPPINESS_DECAY_PER_DAY * daysElapsed);
    }
    if (pet.hunger < 20) critical.push(pet);
  }
  markDirty();
  return critical;
}

/**
 * Check if two pets can breed. Same type, both happy enough, both past
 * the breeding cooldown. Returns a reason string or null if breedable.
 */
function breedCheck(petA, petB) {
  if (!petA || !petB) return "missing pet";
  if (petA.type !== petB.type) return "different species";
  if (petA.happiness < BREED_MIN_HAPPINESS || petB.happiness < BREED_MIN_HAPPINESS) {
    return "unhappy";
  }
  const now = Date.now();
  const cooldownMs = BREED_COOLDOWN_DAYS * 24 * 3600 * 1000;
  if (now - petA.bredAt < cooldownMs || now - petB.bredAt < cooldownMs) {
    return "cooldown";
  }
  return null;
}

/**
 * Record a breeding. Sets both pets' bredAt. The caller awards the real
 * baby pet item (kitten stage) via the Pets plugin. Returns true.
 */
function recordBreeding(petA, petB) {
  const reason = breedCheck(petA, petB);
  if (reason) return false;
  const now = Date.now();
  petA.bredAt = now;
  petB.bredAt = now;
  markDirty();
  return true;
}

/**
 * Baby item id for a pet type. Kittens for cats; the base item for others.
 */
function babyItemIdFor(type) {
  const catalog = PET_CATALOG[type];
  if (!catalog) return null;
  if (type === "cat" || type === "kitten") return 1555; // kitten stage
  return catalog.itemIds[0];
}

/**
 * Can this citizen tame? Requires real Hunter level. Defensive: a
 * missing skill manager means no.
 */
function canTame(player) {
  try {
    const level = player?.getSkillManager?.()?.getCurrentLevel?.("hunter");
    if (typeof level === "number") return level >= TAME_HUNTER_LEVEL;
    // Fallback: check a hunterLevel attribute the citizen system may set.
    const attr = player?.getAttribute?.("hunterLevel");
    return typeof attr === "number" && attr >= TAME_HUNTER_LEVEL;
  } catch {
    return false;
  }
}

// --- module shape --------------------------------------------------------------

load();

module.exports = {
  PET_CATALOG,
  ALL_PET_ITEM_IDS,
  HUNGER_DECAY_PER_DAY,
  HAPPINESS_DECAY_PER_DAY,
  FEED_HUNGER_RESTORE,
  FEED_HAPPINESS_BOOST,
  PLAY_HAPPINESS_BOOST,
  BREED_COOLDOWN_DAYS,
  BREED_MIN_HAPPINESS,
  MOOD_BONUS_PER_HAPPY_PET,
  MOUNT_TRAVEL_MULTIPLIER,
  MOUNT_COMBAT_BONUS,
  TAME_HUNTER_LEVEL,
  petsOf,
  addPet,
  removePet,
  hasMount,
  travelSpeedFor,
  mountedCombatBonusFor,
  moodBonusFor,
  feedPet,
  playWithPet,
  decayPets,
  breedCheck,
  recordBreeding,
  babyItemIdFor,
  canTame,
  load,
  save,
  markDirty,
  resetForTests,
  _setSavePathForTests,
};
