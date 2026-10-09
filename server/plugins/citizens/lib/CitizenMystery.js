"use strict";

/**
 * CitizenMystery — a monthly town mystery citizens whisper about and players can solve.
 *
 * WHAT IT DOES (data tier, free):
 *   Once per calendar month, a mystery is generated deterministically from the
 *   citizen roster: someone goes missing, something is stolen, or strange
 *   lights appear. A chain of 3-5 clues is scattered around the victim's home
 *   town. The mystery, its clues, and its hidden truth are pure data — zero
 *   LLM, runs fine with zero players online. Solved mysteries are journaled
 *   as town legend; unsolved ones quietly fade when the month turns.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Citizens whisper about the mystery via scripted forceChat lines. When a
 *   real player walks within earshot of an unrevealed clue, it is "found":
 *   a nearby citizen reacts and the clue is journaled. Helpful citizens give
 *   real hints toward the next clue; suspicious/grumpy ones give red herrings.
 *   When every clue is found, the truth comes out and the town reacts.
 *   The LLM handles free-form investigation dialogue through the normal chat
 *   path, riffing on the journal entries this module writes.
 *
 * Zero LLM: all mechanics are scripted templates and deterministic data.
 *
 * Wired into the director tick right after the rumors block (mystery-adjacent).
 * Plain-node testable: CitizenMystery.test.js.
 */

const { getJournal } = require("./CitizenJournal");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// === Tuning: all magic numbers here ===
const MYSTERY_WHISPER_RADIUS = 12; // tiles — tavern/street earshot
const MYSTERY_WHISPER_COOLDOWN_MS = 45 * 60 * 1000; // a citizen whispers at most this often
const MYSTERY_WHISPER_CHANCE = 0.25; // per eligible citizen per ~60s tick
const MYSTERY_CLUE_RADIUS = 4; // tiles — standing this close "finds" a clue
const MYSTERY_CLUE_SCATTER = 22; // clues scatter within this many tiles of victim home
const MYSTERY_MIN_CLUES = 3;
const MYSTERY_MAX_CLUES = 5;
const MYSTERY_JOURNAL_KIND = "mystery";

// === Cooldown state ===
const lastWhisperByCitizen = new Map(); // username -> timestamp

// === Active mystery (data tier, in-memory, deterministic per month) ===
let activeMystery = null; // { monthKey, type, victim, culprit, truth, clues: [...], status }

// Memory-leak plug: prune whisper cooldowns hourly, drop entries older than a day.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWhisperByCitizen) {
    if (at < cutoff) lastWhisperByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** FNV-1a hash of a string -> uint32. Stable across restarts. */
function hashStr(str) {
  let h = 2166136261;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic LCG from a uint32 seed. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** "YYYY-MM" month key for rotation. Pure on the timestamp. */
function monthKey(nowMs) {
  const d = new Date(nowMs);
  const m = d.getUTCMonth() + 1;
  return `${d.getUTCFullYear()}-${m < 10 ? "0" + m : m}`;
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

// --- Mystery content: types, templates, truths ---

const MYSTERY_TYPES = Object.freeze(["missing", "stolen", "lights"]);

const STOLEN_ITEMS = Object.freeze([
  "silver locket",
  "prize turnip",
  "lucky fishing rod",
  "wedding ring",
  "best cooking pot",
  "lucky horseshoe",
  "carved wooden duck",
]);

const MYSTERY_FRAMES = {
  missing: {
    whisper: (v) => `Have you seen ${v}? Nobody's seen ${v} since last night.`,
    truth: (v, c) =>
      `${v} wasn't taken at all — ${c} helped ${v} slip away to start over somewhere new.`,
  },
  stolen: {
    whisper: (v, item) => `Someone stole ${v}'s ${item}! Right out from under their nose.`,
    truth: (v, c, item) =>
      `It was ${c} all along — needed the ${item} to pay off a debt, and couldn't face asking.`,
  },
  lights: {
    whisper: () => `Strange lights over the rooftops last night. Green ones. I swear it.`,
    truth: (v, c) =>
      `The lights were ${c}'s signal lanterns — warning ${v} the night watch was coming.`,
  },
};

const CLUE_HINTS = {
  missing: Object.freeze([
    "a half-packed travel bag, left in a hurry",
    "a note that just says 'don't follow me'",
    "two sets of footprints heading east",
    "a cold campfire, a day's walk out",
    "a farewell letter, never sent",
  ]),
  stolen: Object.freeze([
    "muddy bootprints that don't match the owner",
    "a dropped copper coin near the door",
    "a forced lock, picked clean",
    "a scrap of cloth snagged on the fence",
    "the item's empty box, hidden in the bushes",
  ]),
  lights: Object.freeze([
    "a burnt-out green lantern wick",
    "wax drippings on the rooftop tiles",
    "a signal chart, half-burned",
    "fresh rope marks on the chimney",
    "a lookout's stool, still warm",
  ]),
};

const RED_HERRINGS = Object.freeze([
  "I heard it was the goblins. Always the goblins.",
  "My cousin's neighbor saw everything, but he won't say a word.",
  "Mark my words, it's the tax collector's doing.",
  "Probably just the wind. The wind does strange things here.",
  "I saw a suspicious pigeon. Pigeons know things.",
]);

const HELPFUL_HINT_FRAMES = Object.freeze([
  "If you're looking into it, check near {where} — {hint}.",
  "Between you and me: {hint}, over by {where}.",
  "I noticed {hint} near {where}. Might mean nothing. Might not.",
]);

const WHERE_WORDS = Object.freeze([
  "the old well",
  "the market square",
  "the chapel steps",
  "the east gate",
  "the tavern cellar",
  "the mill bridge",
  "the notice board",
  "the fountain",
]);

/** Traits that give red herrings instead of real hints. */
const TRICKSTER_TRAITS = new Set(["suspicious", "gruff", "greedy", "mischievous", "proud"]);

function traitsOf(record) {
  const t = record?.personality?.traits;
  if (Array.isArray(t)) return t;
  if (typeof t === "string") return [t];
  return [];
}

function isTrickster(record) {
  return traitsOf(record).some((t) => TRICKSTER_TRAITS.has(String(t).toLowerCase()));
}

/**
 * Generate a mystery deterministically for a month.
 * Pure: (rosterArray, monthKeyStr) => mystery | null.
 * rosterArray entries need { username, home?: {x,y,z} }.
 */
function generateMystery(rosterArray, monthKeyStr) {
  const folks = (rosterArray ?? []).filter((r) => r && r.username);
  if (folks.length < 2) return null;
  const rng = lcg(hashStr("mystery:" + monthKeyStr));
  const type = pickOne(rng, MYSTERY_TYPES);
  const victim = pickOne(rng, folks);
  let culprit = pickOne(rng, folks);
  let guard = 0;
  while (culprit.username === victim.username && guard++ < 20) {
    culprit = pickOne(rng, folks);
  }
  const item = type === "stolen" ? pickOne(rng, STOLEN_ITEMS) : null;
  const frame = MYSTERY_FRAMES[type];
  const truth = frame.truth(victim.username, culprit.username, item);
  const clueCount =
    MYSTERY_MIN_CLUES + Math.floor(rng() * (MYSTERY_MAX_CLUES - MYSTERY_MIN_CLUES + 1));
  const hintPool = [...CLUE_HINTS[type]];
  const home = victim.home ?? { x: 3200, y: 3200, z: 0 };
  const clues = [];
  for (let i = 0; i < clueCount; i++) {
    const hintIdx = Math.floor(rng() * hintPool.length);
    const hint = hintPool.splice(hintIdx, 1)[0] ?? hintPool[0];
    const dx = Math.floor(rng() * (MYSTERY_CLUE_SCATTER * 2 + 1)) - MYSTERY_CLUE_SCATTER;
    const dy = Math.floor(rng() * (MYSTERY_CLUE_SCATTER * 2 + 1)) - MYSTERY_CLUE_SCATTER;
    clues.push({
      index: i,
      hint,
      x: (home.x ?? 3200) + dx,
      y: (home.y ?? 3200) + dy,
      z: home.z ?? 0,
      where: pickOne(rng, WHERE_WORDS),
      revealed: false,
    });
  }
  return {
    monthKey: monthKeyStr,
    type,
    victim: victim.username,
    culprit: culprit.username,
    item,
    truth,
    clues,
    status: "active",
    createdAt: Date.now(),
  };
}

/** Scripted whisper line about the active mystery. Pure. */
function whisperLine(rng, mystery) {
  if (!mystery) return null;
  return MYSTERY_FRAMES[mystery.type].whisper(mystery.victim, mystery.item);
}

/**
 * Hint line for a citizen talking about the mystery.
 * Helpful citizens point at the next unrevealed clue; tricksters give red herrings.
 * Pure: (rng, record, mystery) => string | null.
 */
function hintLine(rng, record, mystery) {
  if (!mystery) return null;
  if (mystery.status === "solved") return `It's solved, friend. ${mystery.truth}`;
  if (mystery.status !== "active") return null;
  if (isTrickster(record)) return pickOne(rng, RED_HERRINGS);
  const next = mystery.clues.find((c) => !c.revealed);
  if (!next) return `It's solved, friend. ${mystery.truth}`;
  const frame = pickOne(rng, HELPFUL_HINT_FRAMES);
  return frame.replace("{where}", next.where).replace("{hint}", next.hint);
}

/**
 * Find an unrevealed clue within radius of a tile. Pure.
 * Returns the clue object or null.
 */
function clueAt(mystery, x, y, z, radius = MYSTERY_CLUE_RADIUS) {
  if (!mystery || mystery.status !== "active") return null;
  for (const clue of mystery.clues) {
    if (clue.revealed) continue;
    if (clue.z !== z) continue;
    if (Math.max(Math.abs(clue.x - x), Math.abs(clue.y - y)) <= radius) return clue;
  }
  return null;
}

/**
 * Mark a clue revealed. Returns true if that solved the mystery.
 * Mutates the mystery's clue (data-tier state), returns a boolean.
 */
function revealClue(mystery, clueIndex) {
  if (!mystery || mystery.status !== "active") return false;
  const clue = mystery.clues[clueIndex];
  if (!clue || clue.revealed) return false;
  clue.revealed = true;
  if (mystery.clues.every((c) => c.revealed)) {
    mystery.status = "solved";
    return true;
  }
  return false;
}

/** Decide whether this citizen should whisper now. Pure. */
function shouldWhisper(rng, lastWhisperMs, nowMs) {
  if (nowMs - (lastWhisperMs || 0) < MYSTERY_WHISPER_COOLDOWN_MS) return false;
  return rng() < MYSTERY_WHISPER_CHANCE;
}

// ============================================================================
// Director wiring — data tier runs always; visible parts need real players.
// ============================================================================

/** Ensure the active mystery matches the current month (data tier, free). */
function ensureMystery(director, nowMs) {
  const key = monthKey(nowMs);
  if (activeMystery && activeMystery.monthKey === key) return activeMystery;
  // Month turned: archive the old one.
  if (activeMystery) {
    archiveMystery(director, activeMystery);
  }
  const roster = [...(director.roster?.values?.() ?? [])];
  activeMystery = generateMystery(roster, key);
  if (activeMystery) {
    journalToTown(
      director,
      `${MYSTERY_FRAMES[activeMystery.type].whisper(activeMystery.victim, activeMystery.item)}`
    );
  }
  return activeMystery;
}

/** Journal one line to every roster citizen (feeds gossip + LLM prompts). */
function journalToTown(director, text) {
  try {
    const journal = getJournal();
    for (const record of director.roster?.values?.() ?? []) {
      if (record?.username) journal.log(record.username, MYSTERY_JOURNAL_KIND, text);
    }
  } catch {
    // Journaling is best-effort; never break the tick.
  }
}

function archiveMystery(director, mystery) {
  try {
    const journal = getJournal();
    if (mystery.status === "solved") {
      journalToTown(director, `Town legend: ${mystery.truth}`);
    } else {
      for (const record of director.roster?.values?.() ?? []) {
        if (record?.username) {
          journal.log(
            record.username,
            MYSTERY_JOURNAL_KIND,
            `The mystery of ${mystery.victim} was never solved. Some say the truth is still out there.`
          );
        }
      }
    }
  } catch {
    // Best-effort.
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

/** Clue discovery: real players walking near clue spots find them (data tier). */
function discoverClues(director, nowMs) {
  const mystery = activeMystery;
  if (!mystery || mystery.status !== "active") return;
  let players = [];
  try {
    players = (director.onlinePlayers?.() ?? []).filter(isRealPlayer);
  } catch {
    return;
  }
  if (players.length === 0) return;
  for (const player of players) {
    let loc = null;
    try {
      loc = player.getLocation?.();
    } catch {
      continue;
    }
    if (!loc) continue;
    const px = loc.getX?.() ?? loc.x;
    const py = loc.getY?.() ?? loc.y;
    const pz = loc.getZ?.() ?? loc.z ?? 0;
    const clue = clueAt(mystery, px, py, pz);
    if (!clue) continue;
    const solved = revealClue(mystery, clue.index);
    const finder = player.getUsername?.() ?? "someone";
    if (solved) {
      journalToTown(director, `Mystery solved! ${mystery.truth}`);
      announceToNearby(director, px, py, pz, `*gasps* It's solved! ${mystery.truth}`);
    } else {
      journalToTown(director, `${finder} found a clue: ${clue.hint}.`);
      announceToNearby(director, px, py, pz, `*points* Look — ${clue.hint}!`);
    }
  }
}

/** One nearby citizen reacts aloud to a discovery (scripted, zero LLM). */
function announceToNearby(director, x, y, z, line) {
  try {
    for (const record of director.roster?.values?.() ?? []) {
      const citizen = director.playerFor?.(record);
      if (!citizen) continue;
      let loc = null;
      try {
        loc = citizen.getLocation?.();
      } catch {
        continue;
      }
      if (!loc) continue;
      const cx = loc.getX?.() ?? loc.x;
      const cy = loc.getY?.() ?? loc.y;
      const cz = loc.getZ?.() ?? loc.z ?? 0;
      if (cz !== z) continue;
      if (Math.max(Math.abs(cx - x), Math.abs(cy - y)) > MYSTERY_WHISPER_RADIUS) continue;
      try {
        { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      } catch {
        // One citizen failing to emote is fine.
      }
      return; // One announcer is enough.
    }
  } catch {
    // Best-effort.
  }
}

/** Citizens whisper about the active mystery near real players. */
function whisperMystery(director, nowMs) {
  const mystery = activeMystery;
  if (!mystery || mystery.status !== "active") return;
  const rng = Math.random;
  for (const record of director.roster?.values?.() ?? []) {
    // 1. Cooldown gate — O(1), skips almost everyone
    const last = lastWhisperByCitizen.get(record.username) || 0;
    if (nowMs - last < MYSTERY_WHISPER_COOLDOWN_MS) continue;

    // 2. Citizen must be materialized (near a player already)
    let citizen = null;
    try {
      citizen = director.playerFor?.(record);
    } catch {
      continue;
    }
    if (!citizen) continue;

    // 3. A real player must be within earshot
    if (!anyRealPlayerNear(director, citizen, MYSTERY_WHISPER_RADIUS)) continue;

    // 4. Chance gate + scripted whisper (zero LLM)
    if (rng() >= MYSTERY_WHISPER_CHANCE) continue;
    const line = whisperLine(rng, mystery);
    if (!line) continue;
    try {
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    } catch {
      continue;
    }
    lastWhisperByCitizen.set(record.username, nowMs);
  }
}

/**
 * The tick function. Called from the director tick.
 * Data tier (rotation + discovery) always runs; whispers need real players.
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickMystery(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    ensureMystery(director, nowMs);
  } catch (e) {
    console.warn("[citizen-mystery] rotation failed:", e?.message ?? e);
  }
  try {
    discoverClues(director, nowMs);
  } catch (e) {
    console.warn("[citizen-mystery] discovery failed:", e?.message ?? e);
  }
  try {
    whisperMystery(director, nowMs);
  } catch (e) {
    console.warn("[citizen-mystery] whisper failed:", e?.message ?? e);
  }
}

/** Test seam: reset module state. */
function resetForTests() {
  activeMystery = null;
  lastWhisperByCitizen.clear();
  lastPruneAt = 0;
}

module.exports = {
  tickMystery,
  // Pure helpers for tests:
  generateMystery,
  whisperLine,
  hintLine,
  clueAt,
  revealClue,
  shouldWhisper,
  monthKey,
  hashStr,
  lcg,
  pickOne,
  isRealPlayer,
  withinTiles,
  isTrickster,
  resetForTests,
  // Test seam: read/replace active mystery.
  _getActiveMystery: () => activeMystery,
  _setActiveMystery: (m) => {
    activeMystery = m;
  },
};
