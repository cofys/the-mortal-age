"use strict";

/**
 * CitizenFaith — gods, faith, devotion, priests, temples, and holy wars.
 *
 * The Mortal Age pantheon blends the classic three with local customs:
 *   - Saradomin: order, justice, light. Favored by the dutiful and the just.
 *   - Zamorak: chaos, ambition, power. Favored by the ambitious and the bold.
 *   - Guthix: balance, nature, the wild. Favored by the easygoing and free.
 *   - The Wanderer: roads, travelers, merchants. A Mortal Age custom.
 *   - The Hearthmother: home, family, harvest. A Mortal Age custom.
 *   - The Silent One: death, mystery, the unknown. A Mortal Age custom.
 *
 * Faith is honest state, never hash-fiction: a citizen's god comes from
 * their personality traits, their family's faith, or their kingdom's
 * patron god. Devotion drifts with temple attendance and festivals.
 *
 * Effects are data other systems can read:
 *   - prayerBonus(username) → 0..10 morale modifier for the day's work
 *   - templeBonus(kingdomId) → chapel building tier read defensively
 *   - holyWarBetween(a, b) → true when opposed-faith kingdoms are at war
 *
 * Priests are clergy-career citizens with high devotion — religious
 * leaders drawn from the real career and government systems.
 *
 * Data tier, zero LLM. The foreground LLM reads the journal when a
 * player asks about religion.
 *
 * Wiring: CitizenDirector calls tickFaith() (in CitizenFaithLife) in the
 * slow tick; save() in the save section.
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "saves",
  "citizen-faith.json"
);

function _setSavePathForTests(p) {
  module.exports._saveFileOverride = p;
}
function _saveFile() {
  return module.exports._saveFileOverride || SAVE_FILE;
}

// ---------------------------------------------------------------------------
// God catalog
// ---------------------------------------------------------------------------

const GODS = Object.freeze({
  saradomin: {
    name: "Saradomin",
    epithet: "the Just",
    domains: ["order", "justice", "light"],
    favoredTraits: ["dutiful", "honest", "just", "protective", "loyal"],
    opposed: ["zamorak"],
    holyDay: "Sunsday",
    prayerLine: "May Saradomin's light guide my hand.",
  },
  zamorak: {
    name: "Zamorak",
    epithet: "the Bold",
    domains: ["chaos", "ambition", "power"],
    favoredTraits: ["ambitious", "bold", "cunning", "ruthless", "proud"],
    opposed: ["saradomin"],
    holyDay: "Chaosday",
    prayerLine: "Strength to the bold — Zamorak favors the strong.",
  },
  guthix: {
    name: "Guthix",
    epithet: "the Balanced",
    domains: ["balance", "nature", "the wild"],
    favoredTraits: ["easygoing", "patient", "thoughtful", "free", "calm"],
    opposed: [],
    holyDay: "Wildsday",
    prayerLine: "Balance in all things. Guthix sleeps, but watches.",
  },
  wanderer: {
    name: "The Wanderer",
    epithet: "of the Roads",
    domains: ["travel", "trade", "luck"],
    favoredTraits: ["curious", "restless", "sociable", "chatty", "brave"],
    opposed: [],
    holyDay: "Roadsday",
    prayerLine: "Safe roads and fair winds, Wanderer.",
  },
  hearthmother: {
    name: "The Hearthmother",
    epithet: "Keeper of the Hearth",
    domains: ["home", "family", "harvest"],
    favoredTraits: ["warm", "nurturing", "generous", "kind", "homely"],
    opposed: [],
    holyDay: "Hearthday",
    prayerLine: "Hearthmother, keep my kin warm and fed.",
  },
  "silent-one": {
    name: "The Silent One",
    epithet: "of the Veil",
    domains: ["death", "mystery", "dreams"],
    favoredTraits: ["mysterious", "quiet", "taciturn", "brooding", "wise"],
    opposed: [],
    holyDay: "Veilsday",
    prayerLine: "...", // the Silent One asks for no words
  },
});

const GOD_KEYS = Object.freeze(Object.keys(GODS));

// Kingdom patron gods — the old faith of each land, seeded by lore.
// Kingdoms not listed take the majority faith of their roster.
const KINGDOM_PATRONS = Object.freeze({
  misthalin: "saradomin",
  asgarnia: "saradomin",
  kandarin: "guthix",
  morytania: "zamorak",
  karamja: "guthix",
  fremennik: "guthix",
  desert: "wanderer",
  keldagrim: "hearthmother",
});

function godOf(key) {
  return GODS[String(key ?? "").toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let _faith = null; // Map<lowerUsername, {username, god, devotion, sinceMs, priest}>
let _dirty = false;

function _load() {
  if (_faith) return _faith;
  _faith = new Map();
  try {
    const raw = fs.readFileSync(_saveFile(), "utf8");
    const data = JSON.parse(raw);
    for (const rec of data.faith ?? []) {
      if (rec?.username) _faith.set(String(rec.username).toLowerCase(), rec);
    }
  } catch {
    // no save yet — start empty
  }
  return _faith;
}

function save() {
  if (!_dirty) return false;
  try {
    fs.mkdirSync(path.dirname(_saveFile()), { recursive: true });
    fs.writeFileSync(
      _saveFile(),
      JSON.stringify({ faith: [..._load().values()] }, null, 2)
    );
    _dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  _faith = null;
  _dirty = false;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** No auto-create — returns null for the faithless. */
function faithOf(username) {
  const rec = _load().get(String(username ?? "").toLowerCase());
  return rec ?? null;
}

function devotionOf(username) {
  return faithOf(username)?.devotion ?? 0;
}

function isPriest(username) {
  return faithOf(username)?.priest === true;
}

function godName(key) {
  return godOf(key)?.name ?? String(key);
}

/**
 * Choose a god for a roster record. Pure function of real state:
 * family faith first (children inherit), then personality traits,
 * then the kingdom's patron god. Never random for its own sake —
 * ties break toward the patron.
 */
function chooseGodFor(record, ctx) {
  ctx = ctx || {};
  const traits = new Set(record?.personality?.traits ?? []);
  // 1. Family inheritance.
  const familyGod = ctx.familyGod ? String(ctx.familyGod).toLowerCase() : null;
  if (familyGod && godOf(familyGod)) return familyGod;
  // 2. Personality: count favored-trait hits per god.
  let best = null;
  let bestScore = -1;
  for (const key of GOD_KEYS) {
    let score = 0;
    for (const t of GODS[key].favoredTraits) {
      if (traits.has(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  if (bestScore > 0) return best;
  // 3. Kingdom patron.
  const kingdomId = String(record?.kingdomId ?? "").toLowerCase();
  if (KINGDOM_PATRONS[kingdomId]) return KINGDOM_PATRONS[kingdomId];
  // 4. Default: the Hearthmother keeps the common folk.
  return "hearthmother";
}

function patronGodOfKingdom(kingdomId, rosterRecords) {
  const patron = KINGDOM_PATRONS[String(kingdomId ?? "").toLowerCase()];
  if (patron) return patron;
  // Majority faith of the roster.
  const counts = new Map();
  for (const r of rosterRecords ?? []) {
    const g = faithOf(r?.username)?.god;
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = "hearthmother";
  let bestN = -1;
  for (const [g, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = g;
    }
  }
  return best;
}

/**
 * Chapel building bonus for a kingdom. Reads the Castle module
 * defensively — the module may be absent (merge casualties happen).
 * Returns 0..3 (chapel tier) or 0.
 */
function templeBonus(kingdomId) {
  try {
    const Castle = require("../../kingdoms/Castle.Kingdoms");
    const store = require("../../kingdoms/KingdomStore");
    const castle =
      store.getCastle?.(kingdomId) ?? store.getKingdom?.(kingdomId)?.castle;
    const tier = castle?.buildings?.chapel?.tier ?? 0;
    return Math.max(0, Math.min(3, Number(tier) || 0));
  } catch {
    return 0;
  }
}

/**
 * Prayer bonus: 0..10 morale modifier other systems may apply.
 * Devout citizens start the day steadier. Priests pray deeper.
 */
function prayerBonus(username) {
  const rec = faithOf(username);
  if (!rec) return 0;
  let bonus = Math.floor(rec.devotion / 10);
  if (rec.priest) bonus += 2;
  return Math.max(0, Math.min(10, bonus));
}

/**
 * True when two kingdoms are at war AND their patron gods oppose
 * each other — a holy war. Reads Wars state defensively.
 */
function holyWarBetween(kingdomA, kingdomB) {
  const a = String(kingdomA ?? "").toLowerCase();
  const b = String(kingdomB ?? "").toLowerCase();
  if (!a || !b || a === b) return false;
  let atWar = false;
  try {
    const Wars = require("../../kingdoms/Wars.Kingdoms");
    const store = require("../../kingdoms/KingdomStore");
    atWar = Boolean(Wars.isAtWar?.(a, b, store));
  } catch {
    return false;
  }
  if (!atWar) return false;
  const godA = patronGodOfKingdom(a);
  const godB = patronGodOfKingdom(b);
  const opposedA = godOf(godA)?.opposed ?? [];
  const opposedB = godOf(godB)?.opposed ?? [];
  return opposedA.includes(godB) || opposedB.includes(godA);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function setFaith(username, god, devotion) {
  const g = godOf(god);
  if (!g) return null;
  const key = String(username ?? "").toLowerCase();
  if (!key) return null;
  const rec = {
    username: String(username),
    god: String(god).toLowerCase(),
    devotion: Math.max(0, Math.min(100, Number(devotion ?? 40) || 0)),
    sinceMs: Date.now(),
    priest: false,
  };
  _load().set(key, rec);
  _dirty = true;
  return rec;
}

function adjustDevotion(username, delta) {
  const rec = faithOf(username);
  if (!rec) return null;
  rec.devotion = Math.max(0, Math.min(100, rec.devotion + Number(delta || 0)));
  _dirty = true;
  return rec;
}

function setPriest(username, priest) {
  const rec = faithOf(username);
  if (!rec) return null;
  rec.priest = Boolean(priest);
  _dirty = true;
  return rec;
}

function convert(username, newGod) {
  const rec = faithOf(username);
  if (!rec || !godOf(newGod)) return null;
  rec.god = String(newGod).toLowerCase();
  rec.devotion = 30; // converts start lukewarm
  rec.priest = false;
  rec.sinceMs = Date.now();
  _dirty = true;
  return rec;
}

function forgetCitizen(username) {
  const removed = _load().delete(String(username ?? "").toLowerCase());
  if (removed) _dirty = true;
  return removed;
}

function faithSummary(username) {
  const rec = faithOf(username);
  if (!rec) return null;
  const g = godOf(rec.god);
  return {
    god: rec.god,
    godName: g?.name ?? rec.god,
    epithet: g?.epithet ?? "",
    devotion: rec.devotion,
    priest: rec.priest,
  };
}

module.exports = {
  GODS,
  GOD_KEYS,
  KINGDOM_PATRONS,
  godOf,
  godName,
  faithOf,
  devotionOf,
  isPriest,
  chooseGodFor,
  patronGodOfKingdom,
  templeBonus,
  prayerBonus,
  holyWarBetween,
  setFaith,
  adjustDevotion,
  setPriest,
  convert,
  forgetCitizen,
  faithSummary,
  save,
  resetForTests,
  _setSavePathForTests,
};
