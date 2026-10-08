"use strict";

/**
 * CitizenBlacksmiths — blacksmith citizens who forge the cities' weapons,
 * armor and tools: weaponsmiths hammer out swords and axes, armorsmiths
 * raise plate and chain, farriers shoe horses and forge tools, bladesmiths
 * fold fine blades for lords and sellswords.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a smith trade (or none)
 *   from their username hash — no storage, stable across restarts. Forge
 *   assignment prefers the citizen's kingdom. Metals come from the real
 *   miner tables (CitizenMiners.oreFor, lazy require with fallback), so
 *   the smith's stock is consistent with what the miners pull from the
 *   ground. Items are completed on a daily rhythm; masterworks are rare
 *   (derived per day). Work events are journaled once per visible loop
 *   so the interaction-tier LLM answers "what have you been up to?"
 *   truthfully (and can riff on commissions and today's wares — buying
 *   dialogue is the LLM's job, journaled state is its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Smiths visibly work their forges: hammering at the anvil, smelting at
 *   the furnace (engine-verified smithing animation 898, smelting 899).
 *   Fresh wares are hawked, masterworks are unveiled with a crowd moment,
 *   and lingering players get offered a custom commission by the
 *   weaponsmiths and bladesmiths — the commission dialogue is LLM, the
 *   journaled commission is its source of truth.
 *
 * Zero LLM: scripted emote pools, announcement/hawk/commission lines,
 * chance-gated.
 *
 * Ties into CitizenMiners (metals from oreFor — smelted into the bars the
 * smith works), CitizenBuilders (farriers forge the builders' tools),
 * CitizenMarketStalls (waresFor supply hook), CitizenWarfare (weaponsmiths
 * and armorsmiths arm the kingdoms' soldiers).
 *
 * Wired into the director tick right after the tailors block.
 * Plain-node testable: CitizenBlacksmiths.test.js.
 */

// === Tuning: all magic numbers here ===
const WORK_RADIUS = 40; // tiles — visible forge work (same as the other work-loop features)
const HAWK_RADIUS = 14; // tiles — wares hawking / announcements, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const HAWK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // hawk fresh wares at most every 4h
const HAWK_CHANCE = 0.35;
const COMMISSION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // commission offers at most every 6h
const COMMISSION_CHANCE = 0.3;
const MASTERWORK_CHANCE = 0.08; // a visible loop finishes a rare masterwork this often

// Engine animations — from server/plugins/skills/Smithing.plugin.js:
// SMITH_ANIMATION = Animation(898), SMELT_ANIMATION = Animation(899).
const ANIM_SMITH = 898;
const ANIM_SMELT = 899;

// === Smith types ===
const SMITH_WEAPONSMITH = "weaponsmith";
const SMITH_ARMORSMITH = "armorsmith";
const SMITH_FARRIER = "farrier";
const SMITH_BLADESMITH = "bladesmith";
const SMITH_TYPES = Object.freeze([SMITH_WEAPONSMITH, SMITH_ARMORSMITH, SMITH_FARRIER, SMITH_BLADESMITH]);

// === Forges (names players recognise; kingdoms for derived assignment —
// we never need coordinates, only names) ===
const FORGES = Object.freeze([
  { name: "the Varrock west forge", short: "varrockforge", kingdom: "misthalin" },
  { name: "the Lumbridge furnace", short: "lumbridgefurnace", kingdom: "misthalin" },
  { name: "the Falador forge", short: "faladorforge", kingdom: "asgarnia" },
  { name: "the White Knights' smithy", short: "whiteknightssmithy", kingdom: "asgarnia" },
  { name: "the Ardougne forge", short: "ardougneforge", kingdom: "kandarin" },
  { name: "the Catherby anvil house", short: "catherbyanvil", kingdom: "kandarin" },
  { name: "the Keldagrim grand forge", short: "keldagrimforge", kingdom: "keldagrim" },
  { name: "the Dwarven weaponsmiths' hall", short: "dwarvenweaponsmiths", kingdom: "keldagrim" },
  { name: "the Darkmeyer forge", short: "darkmeyerforge", kingdom: "morytania" },
  { name: "the Meiyerditch anvil den", short: "meiyerditchanvil", kingdom: "morytania" },
]);

// === Metals (mirrors the miners' ore table; smiths work bars smelted
// from whatever the miners are pulling out of the ground) ===
const METALS = Object.freeze([
  "bronze",
  "iron",
  "steel",
  "mithril",
  "adamant",
  "rune",
]);

/** Rough bar tiers — bladesmiths and weaponsmiths favor finer metals. */
const METAL_TIER = Object.freeze({
  bronze: 1,
  iron: 2,
  steel: 3,
  mithril: 4,
  adamant: 5,
  rune: 6,
});

// === Wares by smith type ===
const WEAPONSMITH_WARES = Object.freeze([
  "shortswords",
  "battleaxes",
  "war hammers",
  "scimitars",
  "spearheads",
  "maces",
]);

const ARMORSMITH_WARES = Object.freeze([
  "breastplates",
  "full helms",
  "chainbodies",
  "plated skirts",
  "shield bosses",
  "gauntlets",
]);

const FARRIER_WARES = Object.freeze([
  "horseshoes",
  "nail spikes",
  "farrier's rasps",
  "builder's claw hammers",
  "carpenter's adzes",
  "mason's chisels",
]);

const BLADESMITH_WARES = Object.freeze([
  "folded daggers",
  "dueling rapiers",
  "ceremonial blades",
  "fine longswords",
  "court knives",
  "damascened sabres",
]);

// === Masterwork unveilings — the crowd moment ===
const MASTERWORKS = Object.freeze([
  "a dragonforged warhammer",
  "a rune full helm with the royal crest",
  "a mithril greatsword with a folded core",
  "an adamant breastplate that rang like a bell",
  "a damascened sabre that caught the light like water",
  "a war saddle of steel and oiled leather",
]);

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a hash of a string, unsigned 32-bit. */
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

/**
 * True if any real (non-bot) player is within radius tiles of the citizen.
 */
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

/**
 * Decide whether this citizen should fire now.
 * Pure: (rng, lastFiredMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < WORK_COOLDOWN_MS) return false;
  return rng() < WORK_CHANCE;
}

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
  for (const map of [lastWorkByCitizen, lastHawkByCitizen, lastCommissionByCitizen]) {
    for (const [k, at] of map) {
      if (at < cutoff) map.delete(k);
    }
  }
}

/**
 * Smith trade for this citizen, or null if they are not a smith.
 * Hash-derived from username — ~35% of commoners, stable across restarts,
 * no storage. The "smith|" salt keeps the trade independent from other
 * features' hash assignments.
 */
function smithTypeFor(username) {
  if (!username) return null;
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "blacksmith") return null;
  const h = hashStr("smith|" + String(username).toLowerCase());
  return SMITH_TYPES[h % SMITH_TYPES.length];
}

/** The forge this citizen works at, preferring their kingdom. */
function forgeFor(username, kingdom) {
  let pool = (FORGES || []).filter((f) => f.kingdom === kingdom);
  if (pool.length === 0) pool = FORGES;
  const h = hashStr("forge|" + String(username || "").toLowerCase());
  return pool[h % pool.length];
}

/** The metal this smith works today, consistent with what the miners pull. */
function metalFor(username, dateMs) {
  try {
    const m = miners();
    if (m && m.oreFor) {
      const ore = String(m.oreFor(String(username), dateMs) || "").toLowerCase();
      // Map the miners' ore table onto the smiths' metal table.
      const oreToMetal = {
        copper: "bronze",
        tin: "bronze",
        iron: "iron",
        coal: "steel",
        silver: "steel",
        gold: "steel",
        mithril: "mithril",
        adamant: "adamant",
      };
      const metal = oreToMetal[ore];
      if (metal) return metal;
    }
  } catch {
    // fall through to derived default
  }
  const metals = METALS.slice(0, 4); // bronze..mithril default spread
  return metals[hashStr("metal|" + String(username || "").toLowerCase()) % metals.length];
}

/** A ware this smith makes, in today's metal. */
function wareFor(username, type, dateMs) {
  const metal = metalFor(username, dateMs);
  const pool =
    type === SMITH_WEAPONSMITH
      ? WEAPONSMITH_WARES
      : type === SMITH_ARMORSMITH
        ? ARMORSMITH_WARES
        : type === SMITH_FARRIER
          ? FARRIER_WARES
          : BLADESMITH_WARES;
  const item = pool[hashStr("ware|" + String(username || "").toLowerCase()) % pool.length];
  return { metal, item, label: `${metal} ${item}` };
}

/** Today's forging job description for the visible work. */
function jobFor(username, type, dateMs) {
  const { label } = wareFor(username, type, dateMs);
  const forge = forgeFor(username, null);
  return { label, forge: forge.name };
}

/** Whether today's visible loop finishes a masterwork (rare, derived per day). */
function masterworkFor(username, dateMs) {
  const d = new Date(dateMs);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000;
  const h = hashStr("master|" + String(username || "").toLowerCase() + "|" + day);
  if (h % 1000 < MASTERWORK_CHANCE * 1000) {
    return MASTERWORKS[h % MASTERWORKS.length];
  }
  return null;
}

// === Lazy access to CitizenMiners (metal tie-in; may not load in tests) ===
let _miners = null;
function miners() {
  if (_miners === null) {
    try {
      _miners = require("./CitizenMiners");
    } catch {
      _miners = false;
    }
  }
  return _miners || null;
}

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
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

/** Play a smithing animation, best-effort (engine-verified anims 898/899). */
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

/** Say a line over the citizen's head, best-effort. */
function sayLine(citizen, line) {
  try {
    if (!line || !citizen?.forceChat) return false;
    citizen.forceChat(String(line));
    return true;
  } catch {
    return false;
  }
}

// === Line pools (scripted, zero LLM) ===

const WORK_EMOTES = Object.freeze([
  "*hammers the glowing metal*",
  "*shapes the bar on the anvil*",
  "*quenches the hot steel*",
  "*folds the metal over itself*",
  "*grinds an edge on the wheel*",
  "*stokes the furnace coals*",
]);

const WORK_LINES = Object.freeze([
  "Mind the sparks — hot work today.",
  "This {label} will be ready by sundown.",
  "The forge never cools in this town.",
  "Good steel, good day.",
  "Another {label}, hot off the anvil.",
]);

const SMELT_LINES = Object.freeze([
  "Smelting down today's ore — the miners delivered well.",
  "Watch the crucible, lad. Molten {metal} waits for no one.",
  "Purity is everything. Skim the slag twice.",
]);

const HAWK_LINES = Object.freeze([
  "Fresh-forged {label} — come see the work!",
  "{label}, made right here at {forge}!",
  "Buy a blade before the soldiers take them all.",
  "{label} — guaranteed not to bend on the first goblin.",
  "Hot off the anvil: {label}!",
]);

const COMMISSION_LINES = Object.freeze([
  "Need something made to order? I take commissions — tell me what you need.",
  "Custom blades, my specialty. Ask and I'll forge it.",
  "You look like you need a blade that fits your hand. Commission one.",
  "Made-to-order weapons — better than anything on the rack.",
]);

const READYMADE_LINES = Object.freeze([
  "Ready-made {label} — no waiting, take it today.",
  "Today's rack: {label}. All work, no waiting.",
  "The rack's full of {label}. Come choose.",
]);

const MASTERWORK_LINES = Object.freeze([
  "Behold — {piece}! My finest work, ever.",
  "Finished at last: {piece}. Come see it before some lord claims it.",
  "*holds up a masterpiece* {piece} — this is why I smith.",
]);

const BATTLE_LINES = Object.freeze([
  "The army needs {label} — king's order comes first.",
  "Sharpening the guard's blades. {forge} serves the city.",
  "War means work. {label} for the front.",
]);

// ============================================================================
// The tick function — called from the director tick.
// Gate order: commoner → smith type (cheapest) → cooldown → materialized →
// real player near → chance → work. Three passes: forge work, wares hawking,
// commission offers.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickSmiths(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    // Pass 1: visible forge work — hammering, smelting, shaping.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = smithTypeFor(record.username);
        if (!type) continue;

        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, WORK_RADIUS)) continue;
        if (Math.random() >= WORK_CHANCE) continue;

        doForgeWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Pass 2: wares hawking — tighter radius, own cooldown. Smiths announce
    // today's wares; bladesmiths with masterworks unveil them instead.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = smithTypeFor(record.username);
        if (!type) continue;
        const last = lastHawkByCitizen.get(record.username) || 0;
        if (nowMs - last < HAWK_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= HAWK_CHANCE) continue;
        doWaresHawk(director, citizen, record, type, nowMs);
        lastHawkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Pass 3: commission offers — weaponsmiths and bladesmiths take custom
    // work; armorsmiths and farriers sell ready-made.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = smithTypeFor(record.username);
        if (type !== SMITH_WEAPONSMITH && type !== SMITH_BLADESMITH) continue;
        const last = lastCommissionByCitizen.get(record.username) || 0;
        if (nowMs - last < COMMISSION_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= COMMISSION_CHANCE) continue;
        doCommissionOffer(citizen, record, nowMs);
        lastCommissionByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-blacksmiths] tick failed:", e?.message ?? e);
  }
}

/** The visible work: hammering/smelt animation + emote line + journal line. */
function doForgeWork(director, record, citizen, type, nowMs) {
  const rng = Math.random;
  const { label, forge } = jobFor(record.username, type, nowMs);
  const { metal } = wareFor(record.username, type, nowMs);

  // Farriers and half the armorsmiths smelt; the rest hammer at the anvil.
  const smelt = type === SMITH_FARRIER || (type === SMITH_ARMORSMITH && rng() < 0.5);
  playAnim(director, citizen, smelt ? ANIM_SMELT : ANIM_SMITH);

  if (smelt && rng() < 0.4) {
    sayLine(citizen, pickOne(rng, SMELT_LINES).replace("{metal}", metal));
  } else if (rng() < 0.5) {
    sayLine(citizen, pickOne(rng, WORK_EMOTES));
  } else {
    sayLine(citizen, pickOne(rng, WORK_LINES).replaceAll("{label}", label));
  }
  journalEvent(record.username, `working the forge at ${forge}, forging ${label}`);
}

/** Hawking: announce today's wares; masterworks become the crowd moment. */
function doWaresHawk(director, citizen, record, type, nowMs) {
  const rng = Math.random;
  const { label, forge } = jobFor(record.username, type, nowMs);
  void director;

  const piece = masterworkFor(record.username, nowMs);
  if (piece && rng() < 0.6) {
    sayLine(citizen, pickOne(rng, MASTERWORK_LINES).replace("{piece}", piece));
    journalEvent(record.username, `unveiled a masterwork: ${piece} at ${forge}`);
    return;
  }

  if (type === SMITH_WEAPONSMITH && rng() < 0.25) {
    // Kingdoms at war feed the forges — soldiers need arming.
    sayLine(citizen, pickOne(rng, BATTLE_LINES).replaceAll("{label}", label).replace("{forge}", forge));
    journalEvent(record.username, `arming soldiers with ${label} at ${forge}`);
  } else if (type === SMITH_ARMORSMITH || type === SMITH_FARRIER) {
    sayLine(citizen, pickOne(rng, READYMADE_LINES).replaceAll("{label}", label));
    journalEvent(record.username, `selling ready-made ${label} at ${forge}`);
  } else {
    sayLine(citizen, pickOne(rng, HAWK_LINES).replaceAll("{label}", label).replace("{forge}", forge));
    journalEvent(record.username, `hawking ${label} at ${forge}`);
  }
}

/** Commission offers from the custom-blade smiths. */
function doCommissionOffer(citizen, record, nowMs) {
  const line = pickOne(Math.random, COMMISSION_LINES);
  sayLine(citizen, line);
  journalEvent(record.username, "offered to take a custom weapon commission");
}

/**
 * Supply hook for CitizenMarketStalls — today's smith wares, same data the
 * visible tiers show. Pure, derived, no storage.
 */
function waresFor(username, kingdom, dateMs) {
  const type = smithTypeFor(username);
  if (!type) return null;
  const { label, metal, item } = wareFor(username, type, dateMs);
  const forge = forgeFor(username, kingdom);
  return { type, label, metal, item, forge: forge.name };
}

module.exports = {
  tickSmiths,
  // Pure helpers for tests and integration:
  hashStr,
  smithTypeFor,
  forgeFor,
  metalFor,
  wareFor,
  jobFor,
  masterworkFor,
  waresFor,
  shouldFire,
  pickOne,
  isRealPlayer,
  withinTiles,
  SMITH_TYPES,
  FORGES,
  METALS,
};
