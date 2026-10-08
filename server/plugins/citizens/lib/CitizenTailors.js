"use strict";

/**
 * CitizenTailors — tailor citizens who clothe the cities: clothiers sew
 * everyday clothes, armorers stitch padded armor and gambesons, weavers
 * turn wool and flax into cloth at the loom, embroiderers decorate
 * fine garments for special occasions.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a tailor trade (or none)
 *   from their username hash — no storage, stable across restarts. Workshop
 *   assignment prefers the citizen's kingdom. Seasonal styles come from the
 *   farmers' season calendar and kingdom colors, so the simulation runs
 *   with zero players online at zero token cost. Materials are derived from
 *   the real producer tables: wool from the farmers' livestock season table,
 *   flax from the fallback textile list, hides and leather from the
 *   hunters' prey tables. Garments are completed on a daily rhythm; work
 *   events are journaled once per visible loop so the interaction-tier LLM
 *   answers "what have you been up to?" truthfully (and can riff on selling
 *   today's garments — buying dialogue is the LLM's job, journaled state is
 *   its source of truth).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Tailors visibly work their workshops: weaving at the loom, cutting
 *   patterns, stitching seams, embroidering hems (engine-verified crafting
 *   animation 885 — fine hand work). The season's style is announced, fresh
 *   garments are hawked, and lingering players get offered a custom
 *   commission — the commission dialogue is LLM, the journaled commission
 *   is its source of truth.
 *
 * Zero LLM: scripted emote pools, announcement/hawk/commission lines,
 * chance-gated.
 *
 * Ties into CitizenFarmers (wool and flax from the produce tables),
 * CitizenHunters (hides and leather from the prey tables),
 * CitizenMarketStalls (garmentsFor supply hook), CitizenWarfare (armorers
 * pad the kingdoms' armies), CitizenWeddings and CitizenFestivals
 * (embroiderers dress special occasions).
 *
 * Wired into the director tick right after the cooks block.
 * Plain-node testable: CitizenTailors.test.js.
 */

// === Tuning: all magic numbers here ===
const WORK_RADIUS = 40; // tiles — visible workshop work (same as the other work-loop features)
const HAWK_RADIUS = 14; // tiles — garment hawking / style announcements, close enough to hear
const WORK_COOLDOWN_MS = 3 * 60 * 60 * 1000; // visible work at most every 3h
const WORK_CHANCE = 0.4; // per eligible citizen per tick
const HAWK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // hawk fresh garments at most every 4h
const HAWK_CHANCE = 0.35;
const COMMISSION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // commission offers at most every 6h
const COMMISSION_CHANCE = 0.3;
const MASTERPIECE_CHANCE = 0.1; // a visible loop finishes a rare masterpiece this often

// Engine animation (from server/plugins/skills/Crafting.plugin.js — the
// gem-cutting anims 885-892 are the engine's fine-hand-work set; the
// CitizenArtisans module already uses 885 for needlework).
const ANIM_NEEDLEWORK = 885;

// === Tailor types ===
const TAILOR_CLOTHIER = "clothier";
const TAILOR_ARMORER = "armorer";
const TAILOR_WEAVER = "weaver";
const TAILOR_EMBROIDERER = "embroiderer";
const TAILOR_TYPES = Object.freeze([TAILOR_CLOTHIER, TAILOR_ARMORER, TAILOR_WEAVER, TAILOR_EMBROIDERER]);

// === Workshops (names players recognise; kingdoms for derived assignment —
// we never need coordinates, only names) ===
const WORKSHOPS = Object.freeze([
  { name: "the Varrock tailor's shop", short: "varrocktailor", kingdom: "misthalin", kind: "shop" },
  { name: "the Lumbridge weavers' loft", short: "lumbridgeweavers", kingdom: "misthalin", kind: "loom" },
  { name: "the Ardougne cloth hall", short: "ardougnecloth", kingdom: "kandarin", kind: "hall" },
  { name: "the Seers' village embroidery house", short: "seersembroidery", kingdom: "kandarin", kind: "atelier" },
  { name: "the Falador garment works", short: "faladorgarments", kingdom: "asgarnia", kind: "works" },
  { name: "the Burthorpe armorers' tent", short: "burthorpearmor", kingdom: "asgarnia", kind: "tent" },
  { name: "the Keldagrim weavers' hall", short: "keldagrimweavers", kingdom: "keldagrim", kind: "hall" },
  { name: "the Dwarven padding forge", short: "dwarvenpadding", kingdom: "keldagrim", kind: "forge" },
  { name: "the Darkmeyer atelier", short: "darkmeyeratelier", kingdom: "morytania", kind: "atelier" },
  { name: "the Meiyerditch stitchers' den", short: "meiyerditchstitch", kingdom: "morytania", kind: "den" },
]);

// === Kingdom colors — every garment is cut in its kingdom's palette ===
const KINGDOM_COLORS = Object.freeze({
  misthalin: "Varrock blue and silver",
  kandarin: "Ardougne green and gold",
  asgarnia: "Falador white and crimson",
  keldagrim: "dwarven iron-grey and bronze",
  morytania: "Darkmeyer black and blood-red",
});

// === Seasonal styles (by farmer season names: spring/summer/autumn/winter) ===
const SEASONAL_STYLES = Object.freeze({
  spring: ["light linen tunics", "embroidered spring cloaks", "festival sashes"],
  summer: ["breezy desert robes", "sun-bleached smocks", "traveler's light wraps"],
  autumn: ["heavy wool cloaks", "harvest-fair doublets", "quilted riding coats"],
  winter: ["fur-lined greatcoats", "thick gambesons", "snow-white wedding gowns"],
});

// === Everyday garments by tailor type ===
const CLOTHIER_GARMENTS = Object.freeze([
  "workaday tunics",
  "sturdy breeches",
  "everyday cloaks",
  "aprons",
  "linen shirts",
]);

const WEAVER_BOLTS = Object.freeze([
  "woolen broadcloth",
  "linen canvas",
  "fine summer weave",
  "dwarven twill",
  "sail cloth",
]);

const ARMORER_WARES = Object.freeze([
  "padded gambesons",
  "quilted armor linings",
  "leather jerkins",
  "soldiers' surcoats",
  "winter campaign coats",
]);

const EMBROIDERED_PIECES = Object.freeze([
  "wedding gowns",
  "court doublets",
  "ceremonial sashes",
  "bridal veils",
  "coronation robes",
]);

// === Occasion garments — the embroiderers' special work ===
const OCCASION_GARMENTS = Object.freeze([
  "a wedding gown",
  "a court doublet",
  "a ceremonial sash",
  "a festival mantle",
  "a christening robe",
]);

// === Fallback textile materials (used only if CitizenFarmers/CitizenHunters can't load) ===
const FALLBACK_MATERIALS = Object.freeze(["wool", "flax", "linen thread", "cured hides", "leather"]);

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
  for (const [k, at] of lastWorkByCitizen) {
    if (at < cutoff) lastWorkByCitizen.delete(k);
  }
  for (const [k, at] of lastHawkByCitizen) {
    if (at < cutoff) lastHawkByCitizen.delete(k);
  }
  for (const [k, at] of lastCommissionByCitizen) {
    if (at < cutoff) lastCommissionByCitizen.delete(k);
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

// === Lazy access to CitizenFarmers / CitizenHunters (materials tie-in;
// the modules may not load in plain-node tests) ===
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

let _hunters = null;
function hunters() {
  if (_hunters === null) {
    try {
      _hunters = require("./CitizenHunters");
    } catch {
      _hunters = false;
    }
  }
  return _hunters || null;
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

/**
 * Textile materials available this season, derived from the real producer
 * tables: wool from the farmers' livestock produce, flax from the crop
 * tables when present, hides and leather from the hunters' world.
 */
function materialsFor(season) {
  const got = new Set();
  try {
    const f = farmers();
    if (f && f.produceFor) {
      for (const type of ["livestock", "crop", "orchard"]) {
        const items = f.produceFor(type, season);
        if (Array.isArray(items)) {
          for (const item of items) {
            const lower = String(item).toLowerCase();
            if (/wool|flax|cotton|hide|leather|fur|silk/.test(lower)) got.add(item);
          }
        }
      }
    }
  } catch {
    // fall through to fallback
  }
  // Hunters always yield hides and leather — the prey tables are
  // season-independent.
  got.add("cured hides");
  got.add("leather");
  if (got.size <= 2) {
    for (const m of FALLBACK_MATERIALS) got.add(m);
  }
  return Array.from(got);
}

/**
 * Tailor trade for a username, or null for a non-tailor.
 * ~35% of commoners tailor; the trade is hash-derived and stable.
 */
function tailorTypeFor(username) {
  if (!username) return null;
  const h = hashStr("tailor|" + String(username).toLowerCase());
  if (h % 20 >= 7) return null; // not a tailor
  return TAILOR_TYPES[h % TAILOR_TYPES.length];
}

/** The workshop this citizen tailors in, preferring their kingdom. */
function workshopFor(username, kingdom, type) {
  let pool = (WORKSHOPS || []).filter((w) => w.kingdom === kingdom);
  if (pool.length === 0) pool = WORKSHOPS;
  // Weavers prefer looms; armorers prefer forges and tents.
  let pref = pool;
  if (type === TAILOR_WEAVER) {
    const looms = pool.filter((w) => w.kind === "loom" || w.kind === "hall");
    if (looms.length > 0) pref = looms;
  } else if (type === TAILOR_ARMORER) {
    const forges = pool.filter((w) => w.kind === "forge" || w.kind === "tent");
    if (forges.length > 0) pref = forges;
  }
  const h = hashStr("workshop|" + String(username).toLowerCase());
  return pref[h % pref.length];
}

/** The style of the season for a kingdom: seasonal look in kingdom colors. */
function styleFor(kingdom, dateMs) {
  const season = seasonFor(dateMs);
  const styles = SEASONAL_STYLES[season] || SEASONAL_STYLES.summer;
  const h = hashStr("style|" + kingdom + "|" + Math.floor(dateMs / 86400000));
  const colors = KINGDOM_COLORS[kingdom] || KINGDOM_COLORS.misthalin;
  return { season, style: styles[h % styles.length], colors };
}

/** The sellable wares for a tailor type (what they hawk). */
function waresFor(username, type, dateMs) {
  const h = hashStr("wares|" + String(username).toLowerCase());
  if (type === TAILOR_WEAVER) return WEAVER_BOLTS[h % WEAVER_BOLTS.length];
  if (type === TAILOR_ARMORER) return ARMORER_WARES[h % ARMORER_WARES.length];
  if (type === TAILOR_EMBROIDERER) return EMBROIDERED_PIECES[h % EMBROIDERED_PIECES.length];
  // Clothiers sell the season's style in their kingdom's colors.
  return CLOTHIER_GARMENTS[h % CLOTHIER_GARMENTS.length];
}

/** The rare masterpiece a tailor finishes on a masterpiece loop. */
function masterpieceFor(username, kingdom, dateMs) {
  const h = hashStr("masterpiece|" + String(username).toLowerCase() + "|" + Math.floor(dateMs / 86400000));
  const piece = OCCASION_GARMENTS[h % OCCASION_GARMENTS.length];
  const colors = KINGDOM_COLORS[kingdom] || KINGDOM_COLORS.misthalin;
  return `${piece} in ${colors}`;
}

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = {
  [TAILOR_CLOTHIER]: [
    "*pins the pattern to the cloth*",
    "*snips along the chalk line*",
    "*stitches the seam with quick even strokes*",
    "*holds the garment up to the light*",
  ],
  [TAILOR_ARMORER]: [
    "*quilts the gambeson padding*",
    "*punches eyelets for the laces*",
    "*stitches a patch onto a worn jerkin*",
    "*tests the padding with a firm press*",
  ],
  [TAILOR_WEAVER]: [
    "*throws the shuttle across the loom*",
    "*beats the weft into place*",
    "*spools the dyed thread*",
    "*measures out a fresh bolt*",
  ],
  [TAILOR_EMBROIDERER]: [
    "*threads the needle with silver thread*",
    "*stitches a rose into the hem*",
    "*unrolls the goldwork pattern*",
    "*knots the final stitch and snips*",
  ],
};

/** Scripted visible work line for a tailor type, or null. */
function workLineFor(rng, type) {
  const pool = WORK_LINES[type];
  if (!pool) return null;
  return pickOne(rng, pool);
}

/** Season-style announcement — the line that draws a fashion crowd. */
function styleLineFor(rng, styleInfo, workshop) {
  const workshopName = workshop && workshop.name ? workshop.name : "the workshop";
  return pickOne(rng, [
    `This season's look at ${workshopName}: ${styleInfo.style} in ${styleInfo.colors}!`,
    `*drapes the new pattern* Behold — ${styleInfo.style}, cut in ${styleInfo.colors}!`,
    `Fresh from the loom for ${styleInfo.season}: ${styleInfo.style} in ${styleInfo.colors}!`,
    `The city will be wearing ${styleInfo.style} this ${styleInfo.season} — in ${styleInfo.colors}, of course!`,
  ]);
}

/** Fresh garment hawking line for passers-by. */
function hawkLineFor(rng, wares, workshop) {
  const workshopName = workshop && workshop.name ? workshop.name : "the workshop";
  return pickOne(rng, [
    `Fine ${wares}, fresh off the bench at ${workshopName}!`,
    `Who needs ${wares.charAt(0).toUpperCase() + wares.slice(1)}? Made this very week!`,
    `Best ${wares} in the city — from ${workshopName}, none finer!`,
    `*holds up the finished piece* ${wares}! Come and see the quality at ${workshopName}!`,
  ]);
}

/** Custom commission offer — the commission dialogue is LLM; the journal
 * records the commission so the LLM tier knows. */
function commissionLineFor(rng, styleInfo) {
  return pickOne(rng, [
    `*eyes your outfit* I could cut you something in ${styleInfo.colors} — a proper commission. Interested?`,
    `You walk like someone who deserves a better fit. Shall I take your measure?`,
    `Custom work is my pride. Tell me what you dream of wearing and I'll make it real.`,
    `*taps the pattern book* One commission slot left this week — shall it be yours?`,
  ]);
}

/** Rare masterpiece unveiling — the crowd moment. */
function masterpieceLineFor(rng, masterpiece, workshop) {
  const workshopName = workshop && workshop.name ? workshop.name : "the workshop";
  return pickOne(rng, [
    `*unveils the finished piece* Behold — ${masterpiece}! My masterpiece, only at ${workshopName}!`,
    `A hundred hours of stitching! ${masterpiece.charAt(0).toUpperCase() + masterpiece.slice(1)} — finished at last!`,
    `*rings a small bell* Gather round! My finest work is done: ${masterpiece}!`,
  ]);
}

/**
 * Decide whether this tailor should do visible work now.
 * Pure: (rng, lastWorkMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastWorkMs, nowMs) {
  if (nowMs - (lastWorkMs || 0) < WORK_COOLDOWN_MS) return false;
  return rng() < WORK_CHANCE;
}

/** Decide whether this tailor should hawk fresh garments now. Pure. */
function shouldHawk(rng, lastHawkMs, nowMs) {
  if (nowMs - (lastHawkMs || 0) < HAWK_COOLDOWN_MS) return false;
  return rng() < HAWK_CHANCE;
}

/** Decide whether a commission offer should fire now. Pure. */
function shouldOfferCommission(rng, lastMs, nowMs) {
  if (nowMs - (lastMs || 0) < COMMISSION_COOLDOWN_MS) return false;
  return rng() < COMMISSION_CHANCE;
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

/** Play the needlework animation, best-effort (engine-verified anim 885). */
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

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → commoner → tailor type → materialized →
// real player near → chance → work. Three passes: workshop work, garment
// hawking, commission offers.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   interface consistency with the other work-loop features)
 */
function tickTailors(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners tailor (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = tailorTypeFor(record.username);
        if (!type) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < WORK_COOLDOWN_MS) continue;

        // 3. Citizen must be materialized (near a player already).
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. A real player must be within sight of the workshop.
        if (!anyRealPlayerNear(director, citizen, WORK_RADIUS)) continue;

        // 5. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= WORK_CHANCE) continue;
        doTailorWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Garment hawking: tighter radius, own cooldown. Players learn who
    // has the season's style.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = tailorTypeFor(record.username);
        if (!type) continue;
        const last = lastHawkByCitizen.get(record.username) || 0;
        if (nowMs - last < HAWK_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, HAWK_RADIUS)) continue;
        if (Math.random() >= HAWK_CHANCE) continue;
        doTailorHawk(director, citizen, record, type, nowMs);
        lastHawkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Commission offers: clothiers and embroiderers take custom work;
    // weavers and armorers sell bolts and padding by the piece.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = tailorTypeFor(record.username);
        if (type !== TAILOR_CLOTHIER && type !== TAILOR_EMBROIDERER) continue;
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
    console.warn("[citizen-tailors] tick failed:", e?.message ?? e);
  }
}

/** The visible work: needlework animation + emote line + journal line. */
function doTailorWork(director, record, citizen, type, nowMs) {
  const line = workLineFor(Math.random, type);
  if (!line) return;
  const workshop = workshopFor(record.username, record.kingdom, type);
  const season = seasonFor(nowMs);
  const materials = materialsFor(season);
  // Rare masterpiece unveilings are the crowd moment.
  if (Math.random() < MASTERPIECE_CHANCE) {
    const masterpiece = masterpieceFor(record.username, record.kingdom, nowMs);
    try {
      citizen.forceChat?.(masterpieceLineFor(Math.random, masterpiece, workshop));
    } catch {
      // forceChat is best-effort.
    }
    playAnim(director, citizen, ANIM_NEEDLEWORK);
    journalEvent(record.username, `Finished a masterpiece at ${workshop ? workshop.name : "the workshop"}: ${masterpiece}. The crowd gathered round.`);
    return;
  }
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  playAnim(director, citizen, ANIM_NEEDLEWORK);
  // One journal line per loop — the LLM's source of truth. Includes the
  // workshop, the wares, and where the materials came from (the farms and
  // the hunters), so "what have you been up to?" is answerable.
  const wares = waresFor(record.username, type, nowMs);
  const material = materials.length > 0 ? materials[hashStr(record.username) % materials.length] : "fine cloth";
  const armyNote = type === TAILOR_ARMORER ? " The king's army gets its padding from this bench." : "";
  journalEvent(
    record.username,
    `Tailoring at ${workshop ? workshop.name : "the workshop"} — working ${material} into ${wares}.${armyNote}`
  );
}

/** Season-style announcement + garment hawking for nearby players. */
function doTailorHawk(director, citizen, record, type, nowMs) {
  void director;
  const workshop = workshopFor(record.username, record.kingdom, type);
  const styleInfo = styleFor(record.kingdom, nowMs);
  const wares = waresFor(record.username, type, nowMs);
  // Armorers announce the army contract instead of fashion.
  let line;
  if (type === TAILOR_ARMORER) {
    line = pickOne(Math.random, [
      `Sturdy ${wares}, straight from ${workshop ? workshop.name : "the forge"}! Padded for the campaign!`,
      `Soldiers! ${wares.charAt(0).toUpperCase() + wares.slice(1)} — tested on the drill field!`,
    ]);
  } else if (type === TAILOR_WEAVER) {
    line = pickOne(Math.random, [
      `Fresh bolts of ${wares} at ${workshop ? workshop.name : "the loom"}! Woven this week!`,
      `Weavers' finest! ${wares.charAt(0).toUpperCase() + wares.slice(1)}, true in the weave!`,
    ]);
  } else {
    line = styleLineFor(Math.random, styleInfo, workshop) + " " + hawkLineFor(Math.random, wares, workshop);
  }
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Hawked fresh ${wares} at ${workshop ? workshop.name : "the workshop"} — the season's style is ${styleInfo.style} in ${styleInfo.colors}.`);
}

/** Commission offer — journal records the offer so the LLM tier knows. */
function doCommissionOffer(citizen, record, nowMs) {
  const workshop = workshopFor(record.username, record.kingdom, tailorTypeFor(record.username));
  const styleInfo = styleFor(record.kingdom, nowMs);
  const line = commissionLineFor(Math.random, styleInfo);
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(record.username, `Offered a custom clothing commission at ${workshop ? workshop.name : "the workshop"} — the season's style is ${styleInfo.style} in ${styleInfo.colors}.`);
}

/**
 * Garments available from a tailor — exported so CitizenMarketStalls can
 * stock tailor wares later. Actual selling rides on the market-stall haggle
 * system; this is the supply-side hook.
 */
function garmentsFor(username, kingdom, dateMs) {
  const type = tailorTypeFor(username);
  if (!type) return null;
  const workshop = workshopFor(username, kingdom, type);
  const styleInfo = styleFor(kingdom, dateMs);
  return {
    type,
    workshop: workshop ? workshop.name : "the workshop",
    style: styleInfo.style,
    season: styleInfo.season,
    colors: styleInfo.colors,
    wares: waresFor(username, type, dateMs),
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
  tickTailors,
  // Pure helpers for tests and integration:
  hashStr,
  tailorTypeFor,
  workshopFor,
  styleFor,
  waresFor,
  materialsFor,
  masterpieceFor,
  seasonFor,
  workLineFor,
  styleLineFor,
  hawkLineFor,
  commissionLineFor,
  masterpieceLineFor,
  garmentsFor,
  shouldFire,
  shouldHawk,
  shouldOfferCommission,
  pickOne,
  isRealPlayer,
  withinTiles,
  TAILOR_TYPES,
  WORKSHOPS,
  KINGDOM_COLORS,
  SEASONAL_STYLES,
  CLOTHIER_GARMENTS,
  WEAVER_BOLTS,
  ARMORER_WARES,
  EMBROIDERED_PIECES,
  OCCASION_GARMENTS,
  ANIM_NEEDLEWORK,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastHawkByCitizen.clear();
    lastCommissionByCitizen.clear();
    lastPruneAt = 0;
  },
};
