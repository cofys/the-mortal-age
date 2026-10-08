"use strict";

/**
 * CitizenAlchemists — alchemist citizens who brew potions, study reactions
 * and practise early chemistry: potion brewers cook up healing and combat
 * draughts, transmuters chase metal transformation, scholars log every
 * reaction, apothecaries sell remedies over the counter.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned an alchemist trade (or
 *   none) from their username hash — no storage, stable across restarts.
 *   Lab assignment prefers the citizen's kingdom. The brew of the day is a
 *   potion derived from the username and the day of the year, so the
 *   simulation runs with zero players online at zero token cost. Brewing
 *   happens on a daily rhythm; work events are journaled once per visible
 *   loop so the interaction-tier LLM answers "what have you been up to?"
 *   truthfully (and can riff on selling today's brew — buying dialogue is
 *   the LLM's job, journaled state is its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Alchemists visibly work their laboratories: stirring cauldrons,
 *   decanting vials, weighing powders (engine-verified herblore anim 363).
 *   Breakthrough discoveries are unveiled to the crowd, rare mishaps
 *   (explosions, toxic fumes) send everyone a step back, apothecaries
 *   hawk remedies, and lingering players get offered a recipe lesson — the
 *   teaching itself is LLM dialogue, the journaled recipe is its source
 *   of truth.
 *
 * Zero LLM: scripted emote pools, announcement/hawk/teach lines,
 * chance-gated.
 *
 * Ties into CitizenHealers (remedies — the healers' herbalists gather the
 * herbs the brewers need), CitizenFarmers (botanical ingredients), and
 * CitizenMarketStalls (potionsFor supply hook).
 *
 * Wired into the director tick right after the blacksmiths block.
 * Plain-node testable: CitizenAlchemists.test.js.
 */

// === Tuning: all magic numbers here ===
const WORK_RADIUS = 40; // tiles — visible lab work (same as the other work-loop features)
const HAWK_RADIUS = 14; // tiles — remedy hawking, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const HAWK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // hawk remedies at most every 4h
const HAWK_CHANCE = 0.35;
const TEACH_COOLDOWN_MS = 6 * 60 * 60 * 1000; // recipe lesson offers at most every 6h
const TEACH_CHANCE = 0.3;
const BREAKTHROUGH_CHANCE = 0.08; // a visible loop unveils a breakthrough this often
const MISHAP_CHANCE = 0.05; // a brewing loop goes wrong this often (scripted, no damage)

// Engine animation (verified in server/plugins/skills/Herblore.plugin.js:
// HERBLORE_ANIM = new Animation(363) — potion brewing).
const ANIM_HERBLORE = 363;

// === Alchemist types ===
const ALCHEMIST_BREWER = "potion-brewer";
const ALCHEMIST_TRANSMUTER = "transmuter";
const ALCHEMIST_SCHOLAR = "scholar";
const ALCHEMIST_APOTHECARY = "apothecary";
const ALCHEMIST_TYPES = Object.freeze([
  ALCHEMIST_BREWER,
  ALCHEMIST_TRANSMUTER,
  ALCHEMIST_SCHOLAR,
  ALCHEMIST_APOTHECARY,
]);

// === Laboratories (names players recognise; kingdoms for derived assignment) ===
const LABS = Object.freeze([
  { name: "the Varrock alchemists' tower", short: "varrocktower", kingdom: "misthalin", kind: "tower" },
  { name: "the Lumbridge distillery", short: "lumbridgedistill", kingdom: "misthalin", kind: "distillery" },
  { name: "the Ardougne apothecary", short: "ardougneapothecary", kingdom: "kandarin", kind: "shop" },
  { name: "the Tower of Life annex", short: "toweroflife", kingdom: "kandarin", kind: "annex" },
  { name: "the Falador alchemists' guild", short: "faladorguild", kingdom: "asgarnia", kind: "guild" },
  { name: "the White Knights' crucible", short: "whitecrucible", kingdom: "asgarnia", kind: "crucible" },
  { name: "the Keldagrim deep laboratory", short: "keldagrimlab", kingdom: "keldagrim", kind: "lab" },
  { name: "the Dwarven transmutation vault", short: "dwarvenvault", kingdom: "keldagrim", kind: "vault" },
  { name: "the Meiyerditch remedy den", short: "meiyerditchden", kingdom: "morytania", kind: "den" },
  { name: "the Darkmeyer retort house", short: "darkmeyerretort", kingdom: "morytania", kind: "retort" },
]);

// === Brews of the day (brewers' output) ===
const BREWS = Object.freeze({
  spring: ["nettle tea draught", "spring tonic", "pollenskin salve"],
  summer: ["sunbloom potion", "cooling draught", "antidote++ (weak batch)"],
  autumn: ["harvest restorative", "ember-warm tonic", "stamina potion"],
  winter: ["frostward draught", "lung-clearing tea", "thick winter tonic"],
});

// === Transmuters' experiments ===
const TRANSMUTATIONS = Object.freeze([
  "lead into iron",
  "copper into silver",
  "tin into bronze",
  "iron into steel",
  "silver into 'moon-steel'",
  "coal into 'black diamond'",
]);

// === Breakthrough discoveries (rare, celebrated) ===
const BREAKTHROUGHS = Object.freeze([
  "a stable gold-tinted elixir",
  "a potion that stays hot for an hour",
  "a smoke that maps the veins of the mine",
  "a salve that knits cloth like skin",
  "a draught that makes torches burn blue",
  "a powder that cleans polluted water",
]);

// === Mishap scripts (explosions, fumes, unstable mixtures — cosmetic only) ===
const MISHAP_LINES = Object.freeze([
  "*POOF* — purple smoke everywhere!*",
  "*duck! the retort just spat green flames!*",
  "*cough* — open a window, that batch went wrong!*",
  "*a foul smell rolls out of the lab — hold your nose!*",
]);

// === Fallback botanical ingredients (used only if CitizenFarmers can't load) ===
const FALLBACK_INGREDIENTS = Object.freeze({
  spring: ["tarromin", "harralander", "limpwurt root"],
  summer: ["marrentill", "guam", "wildblood hops"],
  autumn: ["avantoe", "cadantine", "irit"],
  winter: ["snapdragon", "toadflax", "snowdrop petals"],
});

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastHawkByCitizen = new Map(); // username -> timestamp
const lastTeachByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWorkByCitizen) {
    if (at < cutoff) lastWorkByCitizen.delete(k);
  }
  for (const [k, at] of lastHawkByCitizen) {
    if (at < cutoff) lastHawkByCitizen.delete(k);
  }
  for (const [k, at] of lastTeachByCitizen) {
    if (at < cutoff) lastTeachByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash — deterministic, stable across restarts. */
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

// === Lazy access to CitizenFarmers (botanical tie-in; may not load in tests) ===
let _farmers = null;
function farmers() {
  if (_farmers === null) {
    try {
      _farmers = require("./CitizenFarmers");
    } catch {
      _farmers = false;
    }
  }
  return _farmers || null;
}

/** Season name for a timestamp, via the farmers' season calendar. */
function seasonFor(dateMs) {
  try {
    const f = farmers();
    if (f && f.seasonFor) return f.seasonFor(new Date(dateMs).getUTCMonth());
  } catch {
    // fall through to local estimate
  }
  const m = new Date(dateMs).getUTCMonth();
  if (m >= 2 && m <= 4) return "spring";
  if (m >= 5 && m <= 7) return "summer";
  if (m >= 8 && m <= 10) return "autumn";
  return "winter";
}

/** Fresh botanical ingredients for the season, from the farmers' tables. */
function ingredientsFor(season) {
  try {
    const f = farmers();
    if (f && f.produceFor) {
      const got = new Set();
      for (const type of ["crop", "orchard", "apiary"]) {
        const items = f.produceFor(type, season);
        if (Array.isArray(items)) items.forEach((i) => got.add(i));
      }
      if (got.size > 0) return Array.from(got);
    }
  } catch {
    // fall through to fallback
  }
  return FALLBACK_INGREDIENTS[season] || FALLBACK_INGREDIENTS.summer;
}

/**
 * Alchemist trade for a username, or null for a non-alchemist.
 * ~35% of commoners alchemise; the trade is hash-derived and stable.
 */
function alchemistTypeFor(username) {
  if (!username) return null;
  const h = hashStr("alchemist|" + String(username).toLowerCase());
  if (h % 20 >= 7) return null; // not an alchemist
  return ALCHEMIST_TYPES[h % ALCHEMIST_TYPES.length];
}

/** The laboratory this citizen works in, preferring their kingdom. */
function labFor(username, kingdom) {
  let pool = (LABS || []).filter((l) => l.kingdom === kingdom);
  if (pool.length === 0) pool = LABS;
  const h = hashStr("lab|" + String(username).toLowerCase());
  return pool[h % pool.length];
}

/** The brew of the day for a brewer: potion, derived from the day. */
function brewFor(username, dateMs) {
  const season = seasonFor(dateMs);
  const h = hashStr("brew|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  const brews = BREWS[season] || BREWS.summer;
  return brews[h % brews.length];
}

/** Today's transmutation experiment. */
function transmutationFor(username, dateMs) {
  const h = hashStr("transmute|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return TRANSMUTATIONS[h % TRANSMUTATIONS.length];
}

/** Today's breakthrough discovery. */
function breakthroughFor(username, dateMs) {
  const h = hashStr("breakthrough|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return BREAKTHROUGHS[h % BREAKTHROUGHS.length];
}

/** The remedy wares an apothecary hawks. */
function waresFor(username, dateMs) {
  const season = seasonFor(dateMs);
  const h = hashStr("wares|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  const pool = (BREWS[season] || BREWS.summer).concat(["cough syrup", "burn salve", "splint wrap"]);
  return pool[h % pool.length];
}

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = {
  [ALCHEMIST_BREWER]: [
    "*stirs the cauldron, watching the colour change*",
    "*decants a vial, checking the hue*",
    "*weighs the powdered ingredients with care*",
    "*tastes a drop and winces*",
  ],
  [ALCHEMIST_TRANSMUTER]: [
    "*pours molten metal from crucible to mould*",
    "*muttering over the circle, chalk in hand*",
    "*holds the crucible up to the light*",
    "*scratches another failed equation off the slate*",
  ],
  [ALCHEMIST_SCHOLAR]: [
    "*logs the reaction in a heavy tome*",
    "*measures the temperature of the distillate*",
    "*compares two vials against the light*",
    "*scribbles a diagram of the apparatus*",
  ],
  [ALCHEMIST_APOTHECARY]: [
    "*grinds dried herbs into powder*",
    "*labels a fresh row of bottles*",
    "*bundles dried remedies for the counter*",
    "*counts out pills into a paper twist*",
  ],
};

// === Hawker lines (apothecary only sells over the counter) ===
const HAWK_LINES = [
  "Fresh {wares} at {lab} — cures what ails you!",
  "Remedies brewed this morning! {wares}, get your {wares}!",
  "Step right up — {wares}, straight from the lab!",
  "Got a cough? A burn? Try {wares}, brewed fresh today!",
];

// === Discovery announcement lines (breakthroughs) ===
const BREAKTHROUGH_LINES = [
  "By the flasks — I've done it! {find}!",
  "Come see, come see — {find}, right here in {lab}!",
  "Years of work — {find}! The guild will hear of this!",
  "Nobody will believe it: {find}!",
];

// === Recipe lesson offer lines (brewers and apothecaries teach) ===
const TEACH_LINES = [
  "Want to learn how I brew {brew}? I can show you the basics.",
  "I could teach you the {brew} recipe, if you've got the patience.",
  "The {brew} recipe isn't hard — fancy a lesson?",
];

/** Pick a work line for a type. */
function workLineFor(rng, type) {
  const pool = WORK_LINES[type] || WORK_LINES[ALCHEMIST_BREWER];
  return pickOne(rng, pool);
}

/** Pick a hawker line, templated. */
function hawkLineFor(rng, wares, lab) {
  const line = pickOne(rng, HAWK_LINES);
  return line.replace("{wares}", wares).replace("{wares}", wares).replace("{lab}", lab ? lab.name : "the lab");
}

/** Pick a breakthrough announcement, templated. */
function breakthroughLineFor(rng, find, lab) {
  const line = pickOne(rng, BREAKTHROUGH_LINES);
  return line.replace("{find}", find).replace("{lab}", lab ? lab.name : "the lab");
}

/** Pick a mishap line. */
function mishapLineFor(rng) {
  return pickOne(rng, MISHAP_LINES);
}

/** Pick a recipe lesson offer, templated. */
function teachLineFor(rng, brew) {
  return pickOne(rng, TEACH_LINES).replace("{brew}", brew).replace("{brew}", brew);
}

/** Gate check for visible lab work: cheap ordering, testable. */
function shouldFire(lastFiredAt, nowMs) {
  return nowMs - (lastFiredAt || 0) >= WORK_COOLDOWN_MS;
}

/** Gate check for hawking. */
function shouldHawk(lastHawkedAt, nowMs) {
  return nowMs - (lastHawkedAt || 0) >= HAWK_COOLDOWN_MS;
}

/** Gate check for lesson offers. */
function shouldTeach(lastTaughtAt, nowMs) {
  return nowMs - (lastTaughtAt || 0) >= TEACH_COOLDOWN_MS;
}

// === Journal helper ===
function journalEvent(username, text) {
  try {
    const Journal = require("./CitizenJournal");
    const citizenName = String(username).toLowerCase();
    Journal.journalFor?.(citizenName)?.log(citizenName, "work", text);
  } catch {
    // Journal is best-effort; never break the tick.
  }
}

/** Play the herblore animation, best-effort (engine-verified anim 363). */
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

/** Animation for an alchemist type — transmuters stir too; all use 363. */
function animFor(type) {
  void type;
  return ANIM_HERBLORE;
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → commoner → alchemist type → materialized
// → real player near → chance → work. Three passes: lab work, remedy
// hawking, recipe lesson offers.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickAlchemists(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners alchemise (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = alchemistTypeFor(record.username);
        if (!type) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        if (!shouldFire(lastWorkByCitizen.get(record.username), nowMs)) continue;

        // 3. Citizen must be materialized (near a player already).
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. A real player must be within sight of the lab.
        if (!anyRealPlayerNear(director, citizen, WORK_RADIUS)) continue;

        // 5. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= WORK_CHANCE) continue;
        doAlchemistWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Remedy hawking: apothecaries only, tighter radius, own cooldown.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = alchemistTypeFor(record.username);
        if (type !== ALCHEMIST_APOTHECARY) continue;
        if (!shouldHawk(lastHawkByCitizen.get(record.username), nowMs)) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= HAWK_CHANCE) continue;
        doAlchemistHawk(director, citizen, record, type, nowMs);
        lastHawkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Recipe lesson offers: brewers and apothecaries teach; transmuters
    // guard their secrets and scholars only lecture their notebooks.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = alchemistTypeFor(record.username);
        if (type !== ALCHEMIST_BREWER && type !== ALCHEMIST_APOTHECARY) continue;
        if (!shouldTeach(lastTeachByCitizen.get(record.username), nowMs)) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= TEACH_CHANCE) continue;
        doTeachOffer(citizen, record, type, nowMs);
        lastTeachByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-alchemists] tick failed:", e?.message ?? e);
  }
}

/** The visible work: herblore animation + emote line + journal line. */
function doAlchemistWork(director, record, citizen, type, nowMs) {
  const lab = labFor(record.username, record.kingdom);
  const season = seasonFor(nowMs);
  const ingredients = ingredientsFor(season);
  const ingredient = ingredients.length > 0 ? ingredients[hashStr(record.username) % ingredients.length] : "dried herbs";

  // Rare breakthroughs are the crowd moment.
  if (Math.random() < BREAKTHROUGH_CHANCE) {
    const find = breakthroughFor(record.username, nowMs);
    try {
      citizen.forceChat?.(breakthroughLineFor(Math.random, find, lab));
    } catch {
      // forceChat is best-effort.
    }
    playAnim(director, citizen, animFor(type));
    journalEvent(record.username, `Unveiled a breakthrough at ${lab ? lab.name : "the lab"}: ${find}.`);
    return;
  }

  // Rare mishaps: explosions, fumes, unstable mixtures — cosmetic only.
  if (Math.random() < MISHAP_CHANCE) {
    try {
      citizen.forceChat?.(mishapLineFor(Math.random));
    } catch {
      // forceChat is best-effort.
    }
    journalEvent(record.username, `A batch went wrong at ${lab ? lab.name : "the lab"} — smoke and noise, no harm done.`);
    return;
  }

  const line = workLineFor(Math.random, type);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  playAnim(director, citizen, animFor(type));
  // One journal line per loop — the LLM's source of truth.
  const doing = type === ALCHEMIST_TRANSMUTER
    ? `experimenting with turning ${transmutationFor(record.username, nowMs)}`
    : type === ALCHEMIST_SCHOLAR
      ? "logging reactions and calibrating apparatus"
      : type === ALCHEMIST_APOTHECARY
        ? `restocking the counter with fresh ${waresFor(record.username, nowMs)}`
        : `brewing today's ${brewFor(record.username, nowMs)}`;
  journalEvent(
    record.username,
    `Working at ${lab ? lab.name : "the lab"} — ${doing}, with fresh ${ingredient} from the herbalists.`
  );
}

/** Remedy hawking for nearby players. */
function doAlchemistHawk(director, citizen, record, type, nowMs) {
  void director;
  void type;
  const lab = labFor(record.username, record.kingdom);
  const wares = waresFor(record.username, nowMs);
  const line = hawkLineFor(Math.random, wares, lab);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Hawking fresh remedies at ${lab ? lab.name : "the lab"}: ${wares}.`);
}

/** Recipe lesson offer — journal records the recipe so the LLM tier knows. */
function doTeachOffer(citizen, record, type, nowMs) {
  void type;
  const lab = labFor(record.username, record.kingdom);
  const brew = brewFor(record.username, nowMs);
  const line = teachLineFor(Math.random, brew);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Offered to teach the recipe for ${brew} at ${lab ? lab.name : "the lab"}.`);
}

/**
 * Potions of the day for an alchemist — exported so CitizenMarketStalls
 * can stock alchemist wares later. Actual selling rides on the
 * market-stall haggle system; this is the supply-side hook.
 */
function potionsFor(username, kingdom, dateMs) {
  const type = alchemistTypeFor(username);
  if (!type) return null;
  const lab = labFor(username, kingdom);
  return {
    type,
    lab: lab ? lab.name : "the lab",
    brew: brewFor(username, dateMs),
    wares: waresFor(username, dateMs),
  };
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

module.exports = {
  tickAlchemists,
  // Pure helpers for tests and integration:
  hashStr,
  alchemistTypeFor,
  labFor,
  brewFor,
  transmutationFor,
  breakthroughFor,
  waresFor,
  ingredientsFor,
  seasonFor,
  workLineFor,
  hawkLineFor,
  teachLineFor,
  breakthroughLineFor,
  mishapLineFor,
  potionsFor,
  animFor,
  shouldFire,
  shouldHawk,
  shouldTeach,
  pickOne,
  isRealPlayer,
  withinTiles,
  ALCHEMIST_TYPES,
  LABS,
  BREWS,
  TRANSMUTATIONS,
  BREAKTHROUGHS,
  MISHAP_LINES,
  ANIM_HERBLORE,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastHawkByCitizen.clear();
    lastTeachByCitizen.clear();
    lastPruneAt = 0;
  },
};
