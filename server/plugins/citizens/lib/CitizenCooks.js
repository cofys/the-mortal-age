"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenCooks — cook citizens who feed the cities: tavern keepers serve
 * food and drink, bakers bake bread and pastries, chefs plate fine dining,
 * street vendors sell quick food to passers-by.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a cook trade (or none)
 *   from their username hash — no storage, stable across restarts. Kitchen
 *   assignment prefers the citizen's kingdom. The meal of the day is a
 *   regional dish by kingdom with a seasonal special derived from the
 *   farmers' season calendar, so the simulation runs with zero players
 *   online at zero token cost. Cooking happens in the background on a
 *   daily rhythm; work events are journaled once per visible loop so the
 *   interaction-tier LLM answers "what have you been up to?" truthfully
 *   (and can riff on selling today's meal — buying dialogue is the LLM's
 *   job, journaled state is its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Cooks visibly work their kitchens: stirring pots, kneading dough,
 *   tasting sauces (engine-verified cooking anims 896/897). The meal of
 *   the day is announced, fresh food is hawked, and lingering players get
 *   offered a recipe lesson — the teaching itself is LLM dialogue, the
 *   journaled recipe is its source of truth.
 *
 * Zero LLM: scripted emote pools, announcement/hawk/teach lines,
 * chance-gated.
 *
 * Ties into CitizenFarmers (ingredients sourced from the produce tables),
 * CitizenMarketStalls (mealOfTheDayFor supply hook), CitizenHunters and
 * CitizenFishers (meat/fish on the menu), CitizenTavernGames (tavern
 * keepers host game nights in their taverns).
 *
 * Wired into the director tick right after the hunters block.
 * Plain-node testable: CitizenCooks.test.js.
 */

// === Tuning: all magic numbers here ===
const WORK_RADIUS = 40; // tiles — visible kitchen work (same as the other work-loop features)
const HAWK_RADIUS = 14; // tiles — food hawking / meal announcements, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const HAWK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // hawk fresh food at most every 4h
const HAWK_CHANCE = 0.35;
const TEACH_COOLDOWN_MS = 6 * 60 * 60 * 1000; // recipe lesson offers at most every 6h
const TEACH_CHANCE = 0.3;
const SPECIAL_CHANCE = 0.1; // a visible loop unveils a rare seasonal special this often

// Engine animations (verified from server/plugins/skills/Cooking.plugin.js).
const ANIM_FIRE_COOK = 896; // cooking on a fire
const ANIM_RANGE_COOK = 897; // cooking on a range

// === Cook types ===
const COOK_TAVERN_KEEPER = "tavern-keeper";
const COOK_BAKER = "baker";
const COOK_CHEF = "chef";
const COOK_STREET_VENDOR = "street-vendor";
const COOK_TYPES = Object.freeze([COOK_TAVERN_KEEPER, COOK_BAKER, COOK_CHEF, COOK_STREET_VENDOR]);

// === Kitchens (names players recognise; kingdoms for derived assignment —
// we never need coordinates, only names) ===
const KITCHENS = Object.freeze([
  { name: "the Blue Moon inn", short: "bluemoon", kingdom: "misthalin", kind: "tavern" },
  { name: "the Varrock bakehouse", short: "varrockbake", kingdom: "misthalin", kind: "bakery" },
  { name: "the Flying Horse inn", short: "flyinghorse", kingdom: "kandarin", kind: "tavern" },
  { name: "the Ardougne market bakery", short: "ardougnebakery", kingdom: "kandarin", kind: "bakery" },
  { name: "the Rising Sun inn", short: "risingsun", kingdom: "asgarnia", kind: "tavern" },
  { name: "the Falador grand kitchen", short: "faladorkitchen", kingdom: "asgarnia", kind: "kitchen" },
  { name: "the Dwarven alehouse", short: "dwarvenale", kingdom: "keldagrim", kind: "tavern" },
  { name: "the Keldagrim stone kitchen", short: "keldagrimkitchen", kingdom: "keldagrim", kind: "kitchen" },
  { name: "the Bloody Rose inn", short: "bloodyrose", kingdom: "morytania", kind: "tavern" },
  { name: "the Darkmeyer cookhouse", short: "darkmeyercook", kingdom: "morytania", kind: "kitchen" },
]);

// === Regional dishes by kingdom ===
const REGIONAL_DISHES = Object.freeze({
  misthalin: ["shepherd's pie", "steak and kidney pudding", "Varrock stew"],
  kandarin: ["Ardougne spiced curry", "Gnome crunchie tart", "Seers' village omelette"],
  asgarnia: ["Falador roast boar", "white knight's platter", "Taverley mushroom soup"],
  keldagrim: ["dwarven rockcake", "deep-mine stew", "golden ale pie"],
  morytania: ["swamp paste tart", "Haunted Woods venison", "Darkmeyer blood pie"],
});

// === Seasonal specials (by farmer season names: spring/summer/autumn/winter) ===
const SEASONAL_SPECIALS = Object.freeze({
  spring: ["spring lamb roast", "wild garlic soup", "herb-stuffed trout"],
  summer: ["grilled shark steak", "sweetcorn fritters", "chilled fruit tart"],
  autumn: ["pumpkin pie", "harvest goose", "blackberry crumble"],
  winter: ["hearty mutton stew", "baked apple pudding", "spiced mead cake"],
});

// === Chef-only fine-dining plates ===
const EXOTIC_PLATES = Object.freeze([
  "dragonfruit flambé",
  "spiced kebab platter",
  "gilded lobster tail",
  "herb-crusted lava eel",
]);

// === Baker-only bakes ===
const BAKER_BAKES = Object.freeze([
  "warm bread loaves",
  "honeyed buns",
  "cinnamon rolls",
  "meat pies",
  "fruit tarts",
]);

// === Street-vendor quick food ===
const STREET_FOOD = Object.freeze([
  "skewered kebabs",
  "roast corn on the cob",
  "baked potatoes",
  "sausage rolls",
  "fried onions",
]);

// === Fallback ingredient lists (used only if CitizenFarmers can't load) ===
const FALLBACK_INGREDIENTS = Object.freeze({
  spring: ["cabbage", "onion", "milk", "eggs"],
  summer: ["wheat", "sweetcorn", "milk", "eggs"],
  autumn: ["potato", "pumpkin", "mutton", "apples"],
  winter: ["milk", "eggs", "flour", "spices"],
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

/**
 * The materialized bot for a roster record, or null.
 * Canonical replacement for the dead director.playerFor: only materialize
 * when the director says the citizen is online.
 */
function materializedBot(director, record) {
  try {
    return director?.isOnline?.(record) ? director.getBot?.(record) ?? null : null;
  } catch {
    return null;
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

// === Lazy access to CitizenFarmers (ingredients tie-in; may not load in tests) ===
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

/** Fresh ingredients for the season, from the farmers' produce tables. */
function ingredientsFor(season) {
  try {
    const f = farmers();
    if (f && f.produceFor) {
      const got = new Set();
      for (const type of ["crop", "livestock", "orchard", "apiary"]) {
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
 * Cook trade for a username, or null for a non-cook.
 * ~35% of commoners cook; the trade is hash-derived and stable.
 */
function cookTypeFor(username) {
  if (!username) return null;
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "cook") return null;
  const h = hashStr("cook|" + String(username).toLowerCase());
  return COOK_TYPES[h % COOK_TYPES.length];
}

/** The kitchen this citizen cooks in, preferring their kingdom. */
function kitchenFor(username, kingdom, type) {
  let pool = (KITCHENS || []).filter((k) => k.kingdom === kingdom);
  if (pool.length === 0) pool = KITCHENS;
  // Street vendors work the streets, not a named kitchen — but they still
  // base out of one kitchen.
  const h = hashStr("kitchen|" + String(username).toLowerCase());
  return pool[h % pool.length];
}

/** The meal of the day for a cook: regional dish, with a seasonal special. */
function mealFor(username, kingdom, dateMs) {
  const season = seasonFor(dateMs);
  const h = hashStr("meal|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  const regionals = REGIONAL_DISHES[kingdom] || REGIONAL_DISHES.misthalin;
  const specials = SEASONAL_SPECIALS[season] || SEASONAL_SPECIALS.summer;
  // Roughly a third of days the seasonal special takes the headline.
  return h % 3 === 0 ? specials[h % specials.length] : regionals[h % regionals.length];
}

/** The rare seasonal special a cook unveils on a special loop. */
function specialFor(username, kingdom, dateMs) {
  const season = seasonFor(dateMs);
  const specials = SEASONAL_SPECIALS[season] || SEASONAL_SPECIALS.summer;
  const h = hashStr("special|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  return specials[h % specials.length];
}

/** The sellable wares for a cook type (what they hawk). */
function waresFor(username, type, dateMs, kingdom) {
  if (type === COOK_BAKER) return BAKER_BAKES[hashStr("wares|" + String(username).toLowerCase()) % BAKER_BAKES.length];
  if (type === COOK_STREET_VENDOR) return STREET_FOOD[hashStr("wares|" + String(username).toLowerCase()) % STREET_FOOD.length];
  if (type === COOK_CHEF) return EXOTIC_PLATES[hashStr("wares|" + String(username).toLowerCase()) % EXOTIC_PLATES.length];
  // Tavern keepers sell the meal of the day.
  return mealFor(username, kingdom || "misthalin", dateMs);
}

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = {
  [COOK_TAVERN_KEEPER]: [
    "Tavern's open!",
    "Hot food here.",
    "Keeper serving.",
  ],
  [COOK_BAKER]: [
    "Fresh bread!",
    "Baking today.",
    "Hot loaves here.",
  ],
  [COOK_CHEF]: [
    "Chef at work.",
    "Cooking up a feast.",
    "Kitchen's busy.",
  ],
  [COOK_STREET_VENDOR]: [
    "Street food here!",
    "Hot snacks!",
    "Vendor open.",
  ],
};

/** Scripted visible work line for a cook type, or null. */
function workLineFor(rng, type) {
  const pool = WORK_LINES[type];
  if (!pool) return null;
  return pickOne(rng, pool);
}

/** Meal-of-the-day announcement — the line that draws a lunch crowd. */
function mealLineFor(rng, meal, kitchen) {
  const kitchenName = kitchen && kitchen.name ? kitchen.name : "the kitchen";
  return pickOne(rng, [
    `Today's meal at ${kitchenName}: ${meal}! Hot and fresh!`,
    `*rings the serving bell* ${meal.charAt(0).toUpperCase() + meal.slice(1)}, ready at ${kitchenName}!`,
    `Come hungry, friends — ${meal} is on the menu at ${kitchenName} today!`,
    `The pot's on at ${kitchenName}: ${meal}. First come, first served!`,
  ]);
}

/** Fresh food hawking line for passers-by. */
function hawkLineFor(rng, wares, kitchen) {
  const kitchenName = kitchen && kitchen.name ? kitchen.name : "the kitchen";
  return pickOne(rng, [
    `Fresh ${wares}, hot from ${kitchenName}! Get them while they're warm!`,
    `Who's hungry? ${wares.charAt(0).toUpperCase() + wares.slice(1)}, made this very morning!`,
    `Best ${wares} in the city — straight out of ${kitchenName}!`,
    `*waves a steaming tray* ${wares}! Come and get it!`,
  ]);
}

/** Recipe lesson offer — the teaching itself is LLM dialogue; the journal
 * records which recipe was offered so the LLM knows. */
function teachLineFor(rng, meal) {
  return pickOne(rng, [
    `You cook? I could teach you my ${meal} — it's the family recipe.`,
    `*taps the recipe book* Want to learn ${meal}? I teach a fair lesson.`,
    `That hunger could be ambition. Come by the kitchen — I'll show you ${meal}.`,
    `*grins* A cook's secrets for a cook's friend. Shall I teach you ${meal}?`,
  ]);
}

/** Rare seasonal-special unveiling — the crowd moment. */
function specialLineFor(rng, special, kitchen) {
  const kitchenName = kitchen && kitchen.name ? kitchen.name : "the kitchen";
  return pickOne(rng, [
    `*unveils a covered dish* Behold — ${special}! A once-a-season special at ${kitchenName}!`,
    `The secret recipe is READY! ${special.charAt(0).toUpperCase() + special.slice(1)} — only while it lasts!`,
    `*bangs the ladle on the pot* Gather round! Today's a special day: ${special} at ${kitchenName}!`,
  ]);
}

/**
 * Decide whether this cook should do visible work now.
 * Pure: (rng, lastWorkMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastWorkMs, nowMs) {
  if (nowMs - (lastWorkMs || 0) < WORK_COOLDOWN_MS) return false;
  return rng() < WORK_CHANCE;
}

/** Decide whether this cook should hawk fresh food now. Pure. */
function shouldHawk(rng, lastHawkMs, nowMs) {
  if (nowMs - (lastHawkMs || 0) < HAWK_COOLDOWN_MS) return false;
  return rng() < HAWK_CHANCE;
}

/** Decide whether a recipe lesson offer should fire now. Pure. */
function shouldTeach(rng, lastTeachMs, nowMs) {
  if (nowMs - (lastTeachMs || 0) < TEACH_COOLDOWN_MS) return false;
  return rng() < TEACH_CHANCE;
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

/** Play a cooking animation, best-effort (engine-verified anim ids 896/897). */
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

/** Animation for a cook type. */
function animFor(type) {
  // Tavern keepers and street vendors cook on fires; bakers and chefs on ranges.
  if (type === COOK_BAKER || type === COOK_CHEF) return ANIM_RANGE_COOK;
  return ANIM_FIRE_COOK;
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → commoner → cook type → materialized →
// real player near → chance → work. Three passes: kitchen work, fresh-food
// hawking, recipe lesson offers.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickCooks(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners cook (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = cookTypeFor(record.username);
        if (!type) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        // 3. Citizen must be materialized (near a player already).
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. A real player must be within sight of the kitchen.
        if (!anyRealPlayerNear(director, citizen, WORK_RADIUS)) continue;

        // 5. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= WORK_CHANCE) continue;
        doCookWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Fresh-food hawking: tighter radius, own cooldown. Players learn who
    // has the day's meal.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = cookTypeFor(record.username);
        if (!type) continue;
        const last = lastHawkByCitizen.get(record.username) || 0;
        if (nowMs - last < HAWK_COOLDOWN_MS) continue;
        const citizen = materializedBot(director, record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= HAWK_CHANCE) continue;
        doCookHawk(director, citizen, record, type, nowMs);
        lastHawkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Recipe lesson offers: tavern keepers, bakers and chefs teach;
    // street vendors are too busy slinging food.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = cookTypeFor(record.username);
        if (type === COOK_STREET_VENDOR) continue;
        if (!type) continue;
        const last = lastTeachByCitizen.get(record.username) || 0;
        if (nowMs - last < TEACH_COOLDOWN_MS) continue;
        const citizen = materializedBot(director, record);
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
    console.warn("[citizen-cooks] tick failed:", e?.message ?? e);
  }
}

/** The visible work: cooking animation + emote line + journal line. */
function doCookWork(director, record, citizen, type, nowMs) {
  const line = workLineFor(Math.random, type);
  if (!line) return;
  const kitchen = kitchenFor(record.username, record.kingdomId ?? record.kingdom, type);
  const season = seasonFor(nowMs);
  const ingredients = ingredientsFor(season);
  // Rare seasonal-special unveilings are the crowd moment.
  if (Math.random() < SPECIAL_CHANCE) {
    const special = specialFor(record.username, record.kingdomId ?? record.kingdom, nowMs);
    try {
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [specialLineFor(Math.random, special, kitchen)] })); }
    } catch {
      // forceChat is best-effort.
    }
    playAnim(director, citizen, animFor(type));
    journalEvent(record.username, `Unveiled a seasonal special at ${kitchen ? kitchen.name : "the kitchen"}: ${special}. The crowd loved it.`);
    return;
  }
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  playAnim(director, citizen, animFor(type));
  // One journal line per loop — the LLM's source of truth. Includes the
  // kitchen, the meal, and where the ingredients came from (the farmers),
  // so "what have you been up to?" is answerable.
  const meal = mealFor(record.username, record.kingdomId ?? record.kingdom, nowMs);
  const ingredient = ingredients.length > 0 ? ingredients[hashStr(record.username) % ingredients.length] : "local produce";
  const tavernNote = type === COOK_TAVERN_KEEPER ? " Game night at the tavern later — everyone's welcome." : "";
  journalEvent(
    record.username,
    `Cooking at ${kitchen ? kitchen.name : "the kitchen"} — today's meal is ${meal}, made with fresh ${ingredient} from the farms.${tavernNote}`
  );
}

/** Meal announcement + fresh-food hawking for nearby players. */
function doCookHawk(director, citizen, record, type, nowMs) {
  void director;
  const kitchen = kitchenFor(record.username, record.kingdomId ?? record.kingdom, type);
  const meal = mealFor(record.username, record.kingdomId ?? record.kingdom, nowMs);
  const wares = waresFor(record.username, type, nowMs, record.kingdomId ?? record.kingdom);
  const line = mealLineFor(Math.random, meal, kitchen);
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Announced today's meal at ${kitchen ? kitchen.name : "the kitchen"}: ${meal}. Hawking fresh ${wares}.`);
}

/** Recipe lesson offer — journal records the recipe so the LLM tier knows. */
function doTeachOffer(citizen, record, type, nowMs) {
  void type;
  const kitchen = kitchenFor(record.username, record.kingdomId ?? record.kingdom, type);
  const meal = mealFor(record.username, record.kingdomId ?? record.kingdom, nowMs);
  const line = teachLineFor(Math.random, meal);
  try {
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Offered to teach the recipe for ${meal} at ${kitchen ? kitchen.name : "the kitchen"}.`);
}

/**
 * Meal of the day for a cook — exported so CitizenMarketStalls can stock
 * cook wares later. Actual selling rides on the market-stall haggle
 * system; this is the supply-side hook.
 */
function mealOfTheDayFor(username, kingdom, dateMs) {
  const type = cookTypeFor(username);
  if (!type) return null;
  const kitchen = kitchenFor(username, kingdom, type);
  return {
    type,
    kitchen: kitchen ? kitchen.name : "the kitchen",
    meal: mealFor(username, kingdom, dateMs),
    wares: waresFor(username, type, dateMs, kingdom),
  };
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  void director; // director.playerFor/onlinePlayers are dead; proximity comes from the bot.
  try {
    const players = citizen.getLocalPlayers?.() ?? [];
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
  tickCooks,
  // Pure helpers for tests and integration:
  hashStr,
  cookTypeFor,
  kitchenFor,
  mealFor,
  specialFor,
  waresFor,
  ingredientsFor,
  seasonFor,
  workLineFor,
  mealLineFor,
  hawkLineFor,
  teachLineFor,
  specialLineFor,
  mealOfTheDayFor,
  animFor,
  shouldFire,
  shouldHawk,
  shouldTeach,
  pickOne,
  isRealPlayer,
  withinTiles,
  COOK_TYPES,
  KITCHENS,
  REGIONAL_DISHES,
  SEASONAL_SPECIALS,
  EXOTIC_PLATES,
  BAKER_BAKES,
  STREET_FOOD,
  ANIM_FIRE_COOK,
  ANIM_RANGE_COOK,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastHawkByCitizen.clear();
    lastTeachByCitizen.clear();
    lastPruneAt = 0;
  },
};
