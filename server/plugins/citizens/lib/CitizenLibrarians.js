"use strict";

/**
 * CitizenLibrarians — citizens become librarians who keep the kingdom libraries.
 *
 * WHAT IT DOES (data tier, free — runs on the proximity tick, all derived):
 *   A stable subset of commoners are librarians (hash-gated, ~35%). Each has
 *   a deterministic librarian type (archivist / researcher / scribe /
 *   storyteller), works at a kingdom-preferred named library, and the
 *   library's collection grows daily — all derived from hashes, zero disk
 *   state. Researchers read the real CitizenScholars library (lazy require,
 *   so the shelves hold the scholars' actual published findings). Scribes
 *   keep the schools supplied with copied texts (ties into CitizenTeachers).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Archivists shelve and offer to find books; researchers study aloud and
 *   offer research topics; scribes copy manuscripts and take copying work;
 *   storytellers tell scripted evening tales. Rare-tome unveilings are the
 *   crowd moment. Borrowing and donations run through a data-tier ledger
 *   (in-memory, TTL-pruned) so the LLM dialogue tier can answer "do you
 *   have it?" and "can I borrow it?" truthfully.
 *
 * Zero LLM: every visible line is a scripted template filled from the
 * librarian's type + library + catalog. Gates run cheapest-first:
 * cooldown -> eligibility -> materialized -> proximity -> chance.
 *
 * Wired into the director proximity tick right after the innkeepers block.
 * Plain-node testable: CitizenLibrarians.test.js.
 */

const { getJournal } = require("./CitizenJournal");

// === Tuning: all magic numbers here ===
const LIBRARY_RADIUS = 14; // tiles — close enough to hear a page turn
const WORK_COOLDOWN_MS = 45 * 60 * 1000; // 45 min per librarian between work emotes
const OFFER_COOLDOWN_MS = 3 * 3600 * 1000; // 3h per librarian between service offers
const TALE_HOURS_START = 18; // storytellers tell tales in the evening
const TALE_HOURS_END = 23;
const LIBRARIAN_FRACTION = 0.35; // ~35% of commoners are librarians
const BORROW_TTL_MS = 7 * 24 * 3600 * 1000; // borrowed books return after a week

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastOfferByCitizen = new Map(); // username -> timestamp
const borrowedByPlayer = new Map(); // playerName(lower) -> { title, by, at }

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWorkByCitizen) {
    if (at < cutoff) lastWorkByCitizen.delete(k);
  }
  for (const [k, at] of lastOfferByCitizen) {
    if (at < cutoff) lastOfferByCitizen.delete(k);
  }
  const borrowCutoff = nowMs - BORROW_TTL_MS;
  for (const [k, v] of borrowedByPlayer) {
    if ((v?.at ?? 0) < borrowCutoff) borrowedByPlayer.delete(k);
  }
}

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

// === Librarian types ===
const LIBRARIAN_ARCHIVIST = "archivist";
const LIBRARIAN_RESEARCHER = "researcher";
const LIBRARIAN_SCRIBE = "scribe";
const LIBRARIAN_STORYTELLER = "storyteller";
const LIBRARIAN_TYPES = [
  LIBRARIAN_ARCHIVIST,
  LIBRARIAN_RESEARCHER,
  LIBRARIAN_SCRIBE,
  LIBRARIAN_STORYTELLER,
];
const LIBRARIAN_TYPE_WEIGHTS = {
  [LIBRARIAN_ARCHIVIST]: 0.3,
  [LIBRARIAN_RESEARCHER]: 0.25,
  [LIBRARIAN_SCRIBE]: 0.25,
  [LIBRARIAN_STORYTELLER]: 0.2,
};

/** True if this commoner is a librarian (stable across restarts, no storage). */
function isLibrarian(username) {
  return hashChance("librarian", username) < LIBRARIAN_FRACTION;
}

/** Hash-derived librarian type for a username (stable across restarts). */
function librarianTypeFor(username) {
  const r = hashChance("librarian-type", username);
  let acc = 0;
  for (const t of LIBRARIAN_TYPES) {
    acc += LIBRARIAN_TYPE_WEIGHTS[t];
    if (r < acc) return t;
  }
  return LIBRARIAN_ARCHIVIST;
}

// === Libraries ===
const LIBRARIES = [
  { name: "the Varrock Grand Library", kingdom: "varrock" },
  { name: "the Lumbridge Archive", kingdom: "varrock" },
  { name: "the Ardougne Athenaeum", kingdom: "kandarin" },
  { name: "the Falador Hall of Records", kingdom: "asgarnia" },
  { name: "the Keldagrim Record Hall", kingdom: "keldagrim" },
  { name: "the Dwarven Deep Archive", kingdom: "keldagrim" },
  { name: "the Darkmeyer Black Library", kingdom: "morytania" },
  { name: "the Al Kharid House of Scrolls", kingdom: "kharidian" },
  { name: "the Port Sarim Chart House", kingdom: "asgarnia" },
  { name: "the Entrana Scriptorium", kingdom: "kandarin" },
];

function normalizeKingdom(k) {
  return String(k ?? "varrock").toLowerCase().replace(/[^a-z]/g, "");
}

/** Kingdom-preferred library for a citizen (stable across restarts). */
function libraryFor(username, kingdomId) {
  const k = normalizeKingdom(kingdomId);
  const matching = LIBRARIES.filter((l) => normalizeKingdom(l.kingdom) === k);
  const pool = matching.length ? matching : LIBRARIES;
  const idx = Math.floor(hashChance("library", username, k) * pool.length);
  return pool[idx];
}

// === The collection: subjects, books, rare tomes ===
const SUBJECTS = [
  "history",
  "magic",
  "crafts",
  "bestiary",
  "poetry",
  "navigation",
  "herblore",
  "warfare",
  "religion",
  "genealogy",
];

const BOOK_TITLES = {
  history: [
    "A Chronicle of the Five Kingdoms",
    "The Fall of the Zarosian Remnants",
    "Kings of Asgarnia, Volume III",
  ],
  magic: [
    "On the Nature of Runes",
    "A Treatise of Elemental Binding",
    "The Lunar Dialogues",
  ],
  crafts: [
    "The Smith's Companion",
    "Weaves and Warps: A Tailor's Handbook",
    "Carpentry for Cathedrals",
  ],
  bestiary: [
    "Beasts of the Feldip Jungle",
    "A Field Guide to Dragons",
    "On Wyverns and Where They Roost",
  ],
  poetry: [
    "Odes to the Moon",
    "The Harper's Last Song",
    "Verses from the Black Library",
  ],
  navigation: [
    "Charts of the Eastern Sea",
    "Star Paths for Sailors",
    "The Cartographer's Oath",
  ],
  herblore: [
    "The Herbalist's Almanac",
    "Poisons and Their Antidotes",
    "On the Virtues of Tarromin",
  ],
  warfare: [
    "Siege Engines of the Fourth Age",
    "The Commander's Primer",
    "Shield Walls and Spear Lines",
  ],
  religion: [
    "The Saradominist Psalms",
    "Whispers of the Dark Lord",
    "Gods of the First Age",
  ],
  genealogy: [
    "Bloodlines of the Kandarin Courts",
    "The Dwarven Clan Rolls",
    "Heirs and Pretenders",
  ],
};

const RARE_TOMES = [
  "the Codex Umbra",
  "a first-edition Bestiary of Gielinor",
  "the drowned captain's logbook",
  "a dragonhide-bound grimoire",
  "the last copy of the Kharidian star charts",
  "a palimpsest of the God Wars",
  "the beekeeper's illuminated herbal",
  "a vellum map to a lost mine",
];

/** Day key (UTC) for per-day derivation. */
function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The library catalog for a citizen on a given day: subject -> titles.
 * Derived, no storage. Rare tomes appear on ~1 day in 6 per library.
 */
function catalogFor(username, kingdomId, nowMs) {
  const lib = libraryFor(username, kingdomId);
  const day = dayKey(nowMs);
  const catalog = {};
  for (const subject of SUBJECTS) {
    const titles = BOOK_TITLES[subject];
    const count = 1 + Math.floor(hashChance("catalog", lib.name, subject, day) * 3);
    catalog[subject] = [];
    for (let i = 0; i < count; i++) {
      catalog[subject].push(
        titles[Math.floor(hashChance("catalog-pick", lib.name, subject, day, String(i)) * titles.length)]
      );
    }
  }
  const rare =
    hashChance("rare-tome", lib.name, day) < 1 / 6
      ? RARE_TOMES[Math.floor(hashChance("rare-pick", lib.name, day) * RARE_TOMES.length)]
      : null;
  return { library: lib.name, catalog, rareTome: rare };
}

/** Total volumes shelved (derived, grows ~1/day per library). */
function collectionSize(username, kingdomId, nowMs) {
  const lib = libraryFor(username, kingdomId);
  const days = Math.floor(nowMs / 86400000);
  const base = 400 + Math.floor(hashChance("collection-base", lib.name) * 600);
  return base + Math.floor(days / 7); // roughly one new volume a week, forever growing
}

/** True during storytelling hours (server local hour). */
function isTaleHours(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= TALE_HOURS_START || h < 1; // 18:00 -> 00:59
}

// === Lazy module bridges (never throw, never store) ===
let _scholars = null;
function scholarsMod() {
  if (_scholars === null) {
    try {
      _scholars = require("./CitizenScholars");
    } catch {
      _scholars = false;
    }
  }
  return _scholars || null;
}

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

function logWork(username, kind, text) {
  try {
    journal()?.log(username, kind, text);
  } catch {
    /* journal is best-effort */
  }
}

// === Scripted lines ===
const WORK_LINES = {
  [LIBRARIAN_ARCHIVIST]: [
    "*slides a volume back onto its shelf*",
    "*dusts a row of chronicles*",
    "*relabels a misfiled scroll*",
    "*straightens the genealogy folios*",
  ],
  [LIBRARIAN_RESEARCHER]: [
    "*scribbles notes in the margins*",
    "*cross-references two heavy tomes*",
    "*murmurs over a star chart*",
    "*traces a finger down a bestiary page*",
  ],
  [LIBRARIAN_SCRIBE]: [
    "*copies a manuscript in a fair hand*",
    "*sharpens a quill*",
    "*rules fresh vellum*",
    "*illuminates a capital letter in gold leaf*",
  ],
  [LIBRARIAN_STORYTELLER]: [
    "*polishes a storyteller's staff*",
    "*rehearses a verse under their breath*",
    "*arranges the tale-benches in a circle*",
  ],
};

const OFFER_LINES = {
  [LIBRARIAN_ARCHIVIST]: [
    "Looking for something? The catalog is in my head — name a subject.",
    "Every scroll has its shelf. Tell me what you seek and I shall find it.",
  ],
  [LIBRARIAN_RESEARCHER]: [
    "I am chasing {topic} through the stacks. Walk with me a while?",
    "The scholars publish, we shelve. Ask me what the learned are learning.",
  ],
  [LIBRARIAN_SCRIBE]: [
    "Need a letter writ fair, a map copied, a contract in a clean hand?",
    "My quill is at your service — for a modest fee, of course.",
  ],
  [LIBRARIAN_STORYTELLER]: [
    "Come evening I tell tales by the hearth. The old ones, the true ones.",
    "Every scar has a story. Sit, and I shall give you one of mine.",
  ],
};

const TALE_VERSES = [
  "“...and the wyvern dove through the burning rigging, and the sea itself held its breath...”",
  "“...the mason laid the last stone at dawn, and the king wept, for the tower was taller than his pride...”",
  "“...she traded her crown for a fishing boat, and the gulls crowned her instead...”",
  "“...the deep mine sang that night, and the dwarves sang back, pick to stone, stone to song...”",
];

function workLineFor(type, rng) {
  const lines = WORK_LINES[type] ?? WORK_LINES[LIBRARIAN_ARCHIVIST];
  return pickOne(rng, lines);
}

function offerLineFor(type, rng, topic) {
  const lines = OFFER_LINES[type] ?? OFFER_LINES[LIBRARIAN_ARCHIVIST];
  return pickOne(rng, lines).replace("{topic}", topic ?? "the old wars");
}

// === Borrowing ledger (data tier, in-memory, TTL-pruned) ===
function borrowBook(playerName, title, librarianName, nowMs) {
  const key = String(playerName ?? "").toLowerCase();
  if (!key) return null;
  borrowedByPlayer.set(key, { title, by: librarianName, at: nowMs });
  return { title, dueInDays: 7 };
}

function returnBook(playerName) {
  const key = String(playerName ?? "").toLowerCase();
  const rec = borrowedByPlayer.get(key) ?? null;
  if (rec) borrowedByPlayer.delete(key);
  return rec;
}

function borrowedFor(playerName) {
  return borrowedByPlayer.get(String(playerName ?? "").toLowerCase()) ?? null;
}

/** A player donates a tome; the library's rare shelf grows for the day. */
function donateTome(playerName, title, librarianName) {
  logWork(librarianName, "donation", `${playerName} donated "${title}" to the collection.`);
  return { title, accepted: true };
}

// ============================================================================
// The tick function — called from the director proximity tick.
// Gate order: cooldown (cheapest) -> eligibility -> materialized ->
// proximity -> chance -> work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickLibrarians(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Eligibility gate — hash check, no I/O
        if (!isLibrarian(record.username)) continue;
        const type = librarianTypeFor(record.username);

        // 2. Cooldown gate — O(1)
        const lastWork = lastWorkByCitizen.get(record.username) || 0;
        const workDue = nowMs - lastWork >= WORK_COOLDOWN_MS;
        const lastOffer = lastOfferByCitizen.get(record.username) || 0;
        const offerDue = nowMs - lastOffer >= OFFER_COOLDOWN_MS;
        if (!workDue && !offerDue) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, LIBRARY_RADIUS)) continue;

        const kingdom =
          record.kingdom ??
          record[Object.keys(record).find((k) => /kingdom/i.test(k)) ?? ""] ??
          "varrock";
        const lib = libraryFor(record.username, kingdom);
        const rng = Math.random;

        // 5a. Work emote (scripted, zero LLM)
        if (workDue && rng() < 0.6) {
          try {
            citizen.forceChat(workLineFor(type, rng));
          } catch {
            /* forceChat is best-effort */
          }
          logWork(record.username, "work", `${type} tending the shelves at ${lib.name}.`);
          lastWorkByCitizen.set(record.username, nowMs);
        }

        // 5b. Service offer (scripted, zero LLM)
        if (offerDue && rng() < 0.5) {
          const cat = catalogFor(record.username, kingdom, nowMs);
          let topic = "the old wars";
          const sm = scholarsMod();
          try {
            const works = sm?.getLibrary?.(normalizeKingdom(kingdom)) ?? [];
            if (works.length) topic = String(works[0]?.title ?? works[0] ?? topic);
          } catch {
            /* scholars bridge is best-effort */
          }
          let line = offerLineFor(type, rng, topic);

          // Rare-tome unveiling: the crowd moment, ~1 day in 6 per library
          if (cat.rareTome && rng() < 0.4) {
            line = `Behold — ${cat.rareTome} has come into our keeping! Come and see it before the scholars lock it away.`;
            logWork(
              record.username,
              "discovery",
              `Unveiled ${cat.rareTome} at ${lib.name}.`
            );
          } else if (type === LIBRARIAN_STORYTELLER && isTaleHours(nowMs) && rng() < 0.5) {
            line = pickOne(rng, TALE_VERSES);
            logWork(record.username, "work", `Told an evening tale at ${lib.name}.`);
          }

          try {
            citizen.forceChat(line);
          } catch {
            /* forceChat is best-effort */
          }
          lastOfferByCitizen.set(record.username, nowMs);
        }
      } catch (e) {
        // Per-citizen guard: one bad record never stops the loop.
        console.warn("[citizen-librarians] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-librarians] tick failed:", e?.message ?? e);
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

module.exports = {
  tickLibrarians,
  borrowBook,
  returnBook,
  borrowedFor,
  donateTome,
  catalogFor,
  collectionSize,
  // Pure helpers for tests:
  isLibrarian,
  librarianTypeFor,
  libraryFor,
  isTaleHours,
  workLineFor,
  offerLineFor,
  hashStr,
  hashChance,
  isRealPlayer,
  withinTiles,
  pickOne,
};
