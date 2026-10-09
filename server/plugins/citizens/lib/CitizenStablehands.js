"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenStablehands — stablehand citizens who care for horses, warhorses,
 * ponies and other beasts of burden: grooming, training, breeding, and
 * veterinary care.
 *
 * WHAT IT DOES (data tier, free):
 *   Every kingdom gets named stables with a mount roster (horses, warhorses,
 *   ponies, rare breeds) derived per-day from hashes — no disk storage.
 *   Foalings and rare-breed unveilings are journaled as the crowd moments.
 *   Feed comes from CitizenFarmers' real produce tables (lazy require,
 *   fallback), so "what do the horses eat?" answers from the same data the
 *   farmers grow. Player stabling is a small in-memory ledger (stableMount /
 *   releaseMount) with weekly TTL pruning, exported for the LLM tier.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Grooms brush, feed and muck out (engine-verified spade anim 830 for
 *   mucking; grooming/feeding are scripted *action* emotes). Trainers put
 *   mounts through their paces and offer riding lessons to lingering
 *   players. Breeders announce foalings and hawk rare breeds. Veterinarians
 *   treat lame mounts and warn owners. Work is journaled once per loop so
 *   the LLM tier answers "what have you been up to?" truthfully.
 *
 * Zero LLM: every forceChat line comes from the curated pools below.
 *
 * Integration: CitizenFarmers (produceFor feed), CitizenInnkeepers (inn
 * stables; this module owns dedicated stable yards, that one owns inn
 * hospitality — no overlap).
 *
 * Wired into tickProximity() right after the innkeepers block. Plain-node
 * testable: CitizenStablehands.test.js.
 */

// === Tuning: all magic numbers here ===
const STABLE_RADIUS = 14; // tiles — close enough to see/hear
const STABLE_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a stablehand fires at most every 3h
const STABLE_OFFER_COOLDOWN_MS = 60 * 60 * 1000; // offers/lessons at most hourly per citizen
const STABLE_CHANCE = 0.35; // per eligible citizen per ~60s tick
const STABLE_LEDGER_TTL_MS = 7 * 24 * 3600 * 1000; // stabled mounts expire after a week

// Mucking anim: engine-verified spade work (same as CitizenHerbalists' digging).
const MUCK_ANIM_ID = 830;

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastOfferByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastOfferByCitizen) {
    if (at < cutoff) lastOfferByCitizen.delete(k);
  }
  const ledgerCutoff = nowMs - STABLE_LEDGER_TTL_MS;
  for (const [k, v] of stabledMounts) {
    if (v.at < ledgerCutoff) stabledMounts.delete(k);
  }
}

// Player stabling ledger: "player|stable" -> { mount, at } (in-memory, TTL'd).
const stabledMounts = new Map();

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash, hex string. Deterministic across restarts. */
function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Deterministic 0..1 from one or more seed strings. */
function hashChance(...parts) {
  const h = parseInt(hashStr(parts.join("|")), 16);
  return (h % 100000) / 100000;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template. */
function fill(tpl, slots) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => slots[k] ?? `{${k}}`);
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

// === Stablehand types ===
const STABLE_TYPES = ["groom", "trainer", "breeder", "veterinarian"];
const STABLE_TYPE_WEIGHTS = { groom: 0.35, trainer: 0.25, breeder: 0.2, veterinarian: 0.2 };

/** Hash-derived stablehand type for a username (~35% of commoners). */
function stableTypeFor(username) {
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "stablehand") return null;
  const r = hashChance("stabletype", username);
  let acc = 0;
  for (const t of STABLE_TYPES) {
    acc += STABLE_TYPE_WEIGHTS[t];
    if (r < acc) return t;
  }
  return "groom";
}

// === Stables ===
const STABLES = [
  { name: "Varrock horse market", kingdom: "varrock", tier: "city" },
  { name: "Falador east stables", kingdom: "falador", tier: "city" },
  { name: "Ardougne paddocks", kingdom: "ardougne", tier: "city" },
  { name: "Keldagrim cavern stables", kingdom: "keldagrim", tier: "deep" },
  { name: "Darkmeyer bloodhorse yard", kingdom: "darkmeyer", tier: "dark" },
  { name: "Lumbridge livery", kingdom: "misthalin", tier: "village" },
  { name: "Taverley riding school", kingdom: "asgarnia", tier: "village" },
  { name: "Catherby shore stables", kingdom: "kandarin", tier: "port" },
  { name: "Mort'ton marsh stables", kingdom: "morytania", tier: "village" },
  { name: "Al Kharid camel and horse pens", kingdom: "kharidian", tier: "port" },
];

/** Kingdom-preferred stable for a username. */
function stableForUsername(username, kingdomId) {
  const preferred = STABLES.filter((s) => s.kingdom === kingdomId);
  const pool = preferred.length > 0 ? preferred : STABLES;
  const idx = Math.floor(hashChance("stablepick", username, kingdomId) * pool.length);
  return pool[idx];
}

// === Mounts ===
const MOUNT_TYPES = ["horse", "warhorse", "pony"];
const MOUNT_TYPE_WEIGHTS = { horse: 0.5, warhorse: 0.25, pony: 0.25 };

const COAT_COLORS = [
  "chestnut", "bay", "black", "grey", "dun", "palomino", "roan", "piebald",
];

const RARE_BREEDS = [
  { breed: "Kandarin grey", from: "Ardougne paddocks" },
  { breed: "Fremennik fjord pony", from: "Catherby shore stables" },
  { breed: "Kharidian arabian", from: "Al Kharid camel and horse pens" },
  { breed: "Asgarnian destrier", from: "Falador east stables" },
  { breed: "Misthalin courser", from: "Varrock horse market" },
  { breed: "Morytanian nightmare", from: "Darkmeyer bloodhorse yard" },
  { breed: "Keldagrim mountain pony", from: "Keldagrim cavern stables" },
];

/** Day key "YYYY-MM-DD" in UTC. */
function dayKey(dateMs) {
  const d = new Date(dateMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/** Mount roster for a stable on a given day — derived, no storage. */
function mountsFor(stable, dateMs) {
  const key = dayKey(dateMs);
  const count = 3 + Math.floor(hashChance("mountcount", stable.name, key) * 5); // 3-7
  const mounts = [];
  for (let i = 0; i < count; i++) {
    const r = hashChance("mounttype", stable.name, key, i);
    let acc = 0;
    let type = "horse";
    for (const t of MOUNT_TYPES) {
      acc += MOUNT_TYPE_WEIGHTS[t];
      if (r < acc) {
        type = t;
        break;
      }
    }
    const coat = COAT_COLORS[Math.floor(hashChance("coat", stable.name, key, i) * COAT_COLORS.length)];
    mounts.push({ type, coat });
  }
  return mounts;
}

/** Rare-breed foaling for a stable on a given day (~8% chance, one at most). */
function rareBreedFor(stable, dateMs) {
  const key = dayKey(dateMs);
  if (hashChance("rarefoal", stable.name, key) > 0.08) return null;
  const pick = RARE_BREEDS[Math.floor(hashChance("rarebreed", stable.name, key) * RARE_BREEDS.length)];
  const sex = hashChance("foalsex", stable.name, key) > 0.5 ? "colt" : "filly";
  return { breed: pick.breed, sex, stable: stable.name };
}

// === Feed (real tables from CitizenFarmers, lazy require with fallback) ===
let _farmers = null;
function farmers() {
  if (!_farmers) {
    try {
      _farmers = require("./CitizenFarmers");
    } catch {
      _farmers = {};
    }
  }
  return _farmers;
}

const FALLBACK_FEED = ["oats", "hay", "barley", "carrots", "apples"];

/** Season from month, same buckets as CitizenCooks. */
function seasonFor(dateMs) {
  const m = new Date(dateMs).getUTCMonth();
  if (m >= 2 && m <= 4) return "spring";
  if (m >= 5 && m <= 7) return "summer";
  if (m >= 8 && m <= 10) return "autumn";
  return "winter";
}

/** Feed the stables serve, from the farmers' real produce tables. */
function feedFor(dateMs) {
  const season = seasonFor(dateMs);
  try {
    const f = farmers();
    if (f && f.produceFor) {
      const got = new Set();
      for (const type of ["crop", "orchard"]) {
        const items = f.produceFor(type, season);
        if (Array.isArray(items)) items.forEach((i) => got.add(i));
      }
      if (got.size > 0) return Array.from(got);
    }
  } catch {
    // fall through to fallback
  }
  return FALLBACK_FEED;
}

// === Line pools ===
const GROOM_WORK = [
  "Grooming the {mount} now.",
  "Just brushing down.",
  "Mucking out the stall.",
  "Filling the trough.",
];

const TRAINER_WORK = [
  "Putting them through paces.",
  "Training the young one.",
  "Just adjusting tack.",
  "Working on the canter.",
];

const BREEDER_WORK = [
  "Checking the mare.",
  "Leading them to the paddock.",
  "Noting bloodlines.",
  "New foal doing well.",
];

const VET_WORK = [
  "Poulticing that leg.",
  "Checking teeth now.",
  "Mixing a mash.",
  "Bandaging up.",
];

const STABLE_OFFERS = [
  "Need a mount stabled? Clean stalls, fresh {feed}, honest prices.",
  "I'll look after your horse like it was my own. {stable} is the finest yard in the {kingdom}.",
  "Room in the stalls tonight — {feed} in the manger, water always fresh.",
  "Your horse will want for nothing here. Best-fed mounts in the {kingdom}.",
];

const LESSON_OFFERS = [
  "Want to learn the seat? First lesson's cheap, and you'll ride out straight-backed.",
  "I can teach you to ride in a week — a proper {kingdom} seat, mind.",
  "Your horse deserves a rider who knows what they're doing. Lessons daily.",
];

const BREED_HAWK = [
  "A {breed} {sex}! Finest bloodline you'll see this side of {stable}.",
  "Come see the new foal — a {breed}, strong as anything.",
];

const FOAL_LINES = [
  "She foaled in the night — a healthy {breed} {sex}!",
  "The mare dropped her foal at dawn. Come see the little {breed}!",
];

const VET_WARNING = [
  "Mind that mare — she's favoring her foreleg. I'll poultice her tonight.",
  "Your horse is coughing. Keep him warm and off the marsh roads.",
];

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
let _journal = null;
function journal() {
  if (!_journal) {
    try {
      _journal = require("./CitizenJournal").getJournal();
    } catch {
      _journal = { log() {} };
    }
  }
  return _journal;
}

function logWork(username, kind, text) {
  try {
    journal().log(username, kind, text);
  } catch {
    // Journal must never break the stable.
  }
}

function forceSay(bot, line) {
  try {
    { const _cvp = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [String(line).slice(0, 120)] })); }
  } catch {
    // Cosmetic only.
  }
}

function playAnim(bot, animId) {
  try {
    bot.performAnimation?.({ getId: () => animId });
  } catch {
    // Cosmetic only.
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

// === Player stabling ledger (data tier, in-memory, TTL'd) ===

/**
 * Stable a player's mount at a stable. Zero engine state — the LLM tier
 * confirms it in dialogue; the ledger is the source of truth.
 */
function stableMountFor(playerUsername, stableName, mountDesc, nowMs) {
  const key = `${String(playerUsername).toLowerCase()}|${stableName}`;
  stabledMounts.set(key, { mount: String(mountDesc).slice(0, 80), at: nowMs });
  return true;
}

/** Release a stabled mount. Returns the mount description or null. */
function releaseMountFor(playerUsername, stableName) {
  const key = `${String(playerUsername).toLowerCase()}|${stableName}`;
  const entry = stabledMounts.get(key);
  if (!entry) return null;
  stabledMounts.delete(key);
  return entry.mount;
}

/** All mounts currently stabled by a player. */
function stabledMountsFor(playerUsername) {
  const prefix = `${String(playerUsername).toLowerCase()}|`;
  const out = [];
  for (const [k, v] of stabledMounts) {
    if (k.startsWith(prefix)) out.push({ stable: k.slice(prefix.length), mount: v.mount });
  }
  return out;
}

// === Desync support (from tickProximity's desync helper shape) ===
function passesDesync(desync, username, nowMs) {
  if (!desync || typeof desync.pass !== "function") return true;
  try {
    return desync.pass(username, nowMs);
  } catch {
    return true;
  }
}

/**
 * Decide whether this citizen should fire now.
 * Pure: (rng, lastFiredMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < STABLE_CITIZEN_COOLDOWN_MS) return false;
  return rng() < STABLE_CHANCE;
}

/**
 * The tick function. Called from tickProximity.
 * Gate order: cooldown (cheapest) → stablehand → materialized → desync →
 * proximity → chance → work.
 *
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional desync helper from tickProximity
 */
function tickStablehands(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  const rng = Math.random;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < STABLE_CITIZEN_COOLDOWN_MS) continue;

        // 2. Only stablehands
        const type = stableTypeFor(record.username);
        if (!type) continue;

        // 3. Citizen must be materialized
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Desync gate (staggers citizens across ticks)
        if (!passesDesync(desync, record.username, nowMs)) continue;

        // 5. A real player must be within earshot/eyeshot
        if (!anyRealPlayerNear(director, citizen, STABLE_RADIUS)) continue;

        // 6. Chance gate + do the thing (scripted, zero LLM)
        if (rng() >= STABLE_CHANCE) continue;
        workTheStable(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch {
        // Per-citizen failure must never break the tick.
      }
    }
  } catch (e) {
    // Never let stablehands crash the director tick.
    console.warn("[citizen-stablehands] tick failed:", e?.message ?? e);
  }
}

function workTheStable(director, record, citizen, type, nowMs) {
  const kingdom = record.kingdom ?? record.kingdomId ?? "misthalin";
  const stable = stableForUsername(record.username, kingdom);
  const mounts = mountsFor(stable, nowMs);
  const mount = mounts[Math.floor(hashChance("workmount", record.username, dayKey(nowMs)) * mounts.length)];
  const feed = pickOne(Math.random, feedFor(nowMs));
  const slots = {
    stable: stable.name,
    kingdom,
    feed,
    coat: mount?.coat ?? "bay",
    mount: mount?.type ?? "horse",
  };

  if (type === "groom") {
    const line = fill(pickOne(Math.random, GROOM_WORK), slots);
    forceSay(citizen, line);
    if (line.includes("mucks")) playAnim(citizen, MUCK_ANIM_ID);
    logWork(record.username, "stablehand", `Groomed and fed the mounts at ${stable.name}.`);
  } else if (type === "trainer") {
    const line = fill(pickOne(Math.random, TRAINER_WORK), slots);
    forceSay(citizen, line);
    logWork(record.username, "stablehand", `Put the mounts through their paces at ${stable.name}.`);
    offerLesson(director, record, citizen, slots, nowMs);
  } else if (type === "breeder") {
    const rare = rareBreedFor(stable, nowMs);
    if (rare && hashChance("foalannounce", record.username, dayKey(nowMs)) > 0.5) {
      const line = fill(pickOne(Math.random, FOAL_LINES), {
        breed: rare.breed,
        sex: rare.sex,
        stable: stable.name,
      });
      forceSay(citizen, line);
      logWork(record.username, "stablehand", `Announced a ${rare.breed} ${rare.sex} foaled at ${stable.name}.`);
    } else {
      const line = fill(pickOne(Math.random, BREEDER_WORK), slots);
      forceSay(citizen, line);
      logWork(record.username, "stablehand", `Tended the breeding stock at ${stable.name}.`);
    }
    hawkBreed(citizen, stable, rare, nowMs, record, slots);
  } else {
    // veterinarian
    const line = fill(pickOne(Math.random, VET_WORK), slots);
    forceSay(citizen, line);
    logWork(record.username, "stablehand", `Treated the mounts at ${stable.name}.`);
    if (hashChance("vetwarn", record.username, dayKey(nowMs)) > 0.6) {
      forceSay(citizen, fill(pickOne(Math.random, VET_WARNING), slots));
    }
  }

  // Grooms and hosts offer stabling to lingering players (hourly per citizen).
  if ((type === "groom" || type === "breeder") && hashChance("offer", record.username) > 0.4) {
    offerStabling(record, citizen, slots, nowMs);
  }
}

function offerStabling(record, citizen, slots, nowMs) {
  const last = lastOfferByCitizen.get(record.username) || 0;
  if (nowMs - last < STABLE_OFFER_COOLDOWN_MS) return;
  forceSay(citizen, fill(pickOne(Math.random, STABLE_OFFERS), slots));
  lastOfferByCitizen.set(record.username, nowMs);
}

function offerLesson(director, record, citizen, slots, nowMs) {
  const last = lastOfferByCitizen.get(record.username) || 0;
  if (nowMs - last < STABLE_OFFER_COOLDOWN_MS) return;
  // Only when a real player lingers nearby.
  if (!anyRealPlayerNear(director, citizen, 6)) return;
  forceSay(citizen, fill(pickOne(Math.random, LESSON_OFFERS), slots));
  logWork(record.username, "stablehand", `Offered riding lessons at ${slots.stable}.`);
  lastOfferByCitizen.set(record.username, nowMs);
}

function hawkBreed(citizen, stable, rare, nowMs, record, slots) {
  if (!rare) return;
  if (hashChance("hawkbreed", record.username, dayKey(nowMs)) > 0.5) return;
  forceSay(
    citizen,
    fill(pickOne(Math.random, BREED_HAWK), {
      breed: rare.breed,
      sex: rare.sex,
      stable: stable.name,
    })
  );
  logWork(record.username, "stablehand", `Hawked the ${rare.breed} ${rare.sex} at ${stable.name}.`);
}

module.exports = {
  tickStablehands,
  // Pure helpers for tests and LLM-tier integration:
  hashStr,
  hashChance,
  pickOne,
  fill,
  stableTypeFor,
  stableForUsername,
  mountsFor,
  rareBreedFor,
  feedFor,
  seasonFor,
  dayKey,
  stableMountFor,
  releaseMountFor,
  stabledMountsFor,
  shouldFire,
  isRealPlayer,
  withinTiles,
  STABLES,
  STABLE_TYPES,
  RARE_BREEDS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    lastOfferByCitizen.clear();
    stabledMounts.clear();
    lastPruneAt = 0;
    _journal = null;
    _farmers = null;
  },
};
