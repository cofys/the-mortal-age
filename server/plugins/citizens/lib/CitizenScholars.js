"use strict";

/**
 * CitizenScholars — citizens become researchers, historians, and inventors.
 *
 * WHAT IT DOES (data tier, free — runs on the slow ~60s director tick):
 *   A stable subset of the roster are scholars (hash-gated, ~1 in 12 citizens).
 *   Each has a deterministic scholar type (historian / naturalist / inventor /
 *   philosopher), pursues one research topic at a time, and advances it every
 *   slow tick. On completion they PUBLISH: the finding is journaled (kind
 *   "discovery", so gossip networks and the LLM prompt pick it up), added to
 *   the per-kingdom library, and a "scholars:discovery" custom event fires so
 *   other plugins (quests, lore) can react. No LLM, no stored world state —
 *   progress lives in this module's memory and is rebuilt deterministically.
 *
 * WHAT THE PLAYER SEES (interaction tier, fast proximity tick only):
 *   Scholars studying near real players muse aloud ("*scribbles notes about
 *   the wyvern migration*"), and occasionally announce public lectures —
 *   scripted forceChat lines, never LLM. Players ask scholars about their
 *   work through normal chat and the LLM answers from the journal (the
 *   "lately" line already contains the research progress).
 *
 * THE LIBRARY: getLibrary(kingdomId) returns published works for that
 * kingdom — a future web overlay / NPC dialogue can surface it. For now it
 * is a data-tier knowledge base the LLM reads through journals.
 *
 * Zero LLM: every visible line is a scripted template filled from the
 * scholar's type + topic + discovery. Lecture/study gates run cheapest-first:
 * cooldown -> materialized -> real player near -> desync slot.
 *
 * Wired into the director slow tick (tickResearch) next to the kinship block,
 * and the fast proximity tick (tickLectures) next to the rumors block.
 * Plain-node testable: CitizenScholars.test.js.
 */

const { getJournal } = require("./CitizenJournal");

// === Tuning ===
const LECTURE_RADIUS = 14; // tiles — close enough to hear a talk
const STUDY_RADIUS = 12; // tiles — close enough to see someone writing
const LECTURE_COOLDOWN_MS = 3 * 3600 * 1000; // 3h per scholar
const STUDY_COOLDOWN_MS = 45 * 60 * 1000; // 45 min per scholar
const RESEARCH_MIN_PER_TICK = 8; // progress points per slow tick
const RESEARCH_MAX_PER_TICK = 25;
const RESEARCH_COMPLETE = 100;

// === Scholar types ===
const SCHOLAR_HISTORIAN = "historian";
const SCHOLAR_NATURALIST = "naturalist";
const SCHOLAR_INVENTOR = "inventor";
const SCHOLAR_PHILOSOPHER = "philosopher";
const SCHOLAR_TYPES = [
  SCHOLAR_HISTORIAN,
  SCHOLAR_NATURALIST,
  SCHOLAR_INVENTOR,
  SCHOLAR_PHILOSOPHER,
];

const RESEARCH_TOPICS = {
  [SCHOLAR_HISTORIAN]: [
    "the fall of the old kingdoms",
    "Lowerniel's disappearance",
    "Roald's hidden bloodline",
    "the treaties of the First Kingdoms",
  ],
  [SCHOLAR_NATURALIST]: [
    "crimson wyvern migration routes",
    "deep-sea leviathan behavior",
    "Morytania swamp flora",
    "phoenix nesting grounds",
  ],
  [SCHOLAR_INVENTOR]: [
    "smokeless forge designs",
    "self-winding crossbow mechanisms",
    "wind-powered mill gears",
    "long-distance signal lanterns",
  ],
  [SCHOLAR_PHILOSOPHER]: [
    "the nature of the soul",
    "the ethics of resurrection",
    "why kingdoms rise and fall",
    "free will and the gods",
  ],
};

const DISCOVERY_LINES = {
  [SCHOLAR_HISTORIAN]: [
    "uncovered a lost charter of {topic}",
    "translated an old scroll about {topic}",
    "pieced together the timeline of {topic}",
  ],
  [SCHOLAR_NATURALIST]: [
    "documented new field observations of {topic}",
    "sketched the complete anatomy behind {topic}",
    "tracked a full season of {topic}",
  ],
  [SCHOLAR_INVENTOR]: [
    "built a working prototype: {topic}",
    "drafted blueprints for {topic}",
    "solved the key mechanism of {topic}",
  ],
  [SCHOLAR_PHILOSOPHER]: [
    "published a treatise on {topic}",
    "won a debate defending a new view of {topic}",
    "completed a meditation cycle on {topic}",
  ],
};

const LECTURE_LINES = [
  "Gather round! {name} lectures on {topic} — all are welcome.",
  "{name} begins a public talk: \"{Topic}.\" Come listen!",
  "A crowd forms as {name} speaks on {topic}.",
];

const STUDY_LINES = [
  "*scribbles notes about {topic}*",
  "*mutters while studying {topic}*",
  "*cross-references scrolls on {topic}*",
  "*sketches diagrams of {topic}*",
];

// === State ===
const researchByCitizen = new Map(); // username -> { type, topic, progress }
const lastLectureAt = new Map(); // username -> timestamp
const lastStudyAt = new Map(); // username -> timestamp
const libraryByKingdom = new Map(); // kingdomId -> [{ author, title, topic, type, at }]

// Memory-leak plug: prune cooldown/state maps hourly, drop entries older than a day.
let lastPruneAt = 0;
function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastLectureAt) if (at < cutoff) lastLectureAt.delete(k);
  for (const [k, at] of lastStudyAt) if (at < cutoff) lastStudyAt.delete(k);
  for (const [k, r] of researchByCitizen) {
    if (r.lastAdvancedAt && r.lastAdvancedAt < cutoff) researchByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash, same family as the timing-desync slotter. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** True for the stable ~1-in-12 subset of citizens who are scholars. */
function isScholar(username) {
  if (!username) return false;
  return hash32(String(username).toLowerCase()) % 12 === 0;
}

/** Deterministic scholar type from username. Stable across restarts. */
function scholarTypeFor(username) {
  return SCHOLAR_TYPES[hash32(String(username).toLowerCase() + ":scholar") % SCHOLAR_TYPES.length];
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Choose a research topic for a scholar type. */
function pickTopic(rng, type) {
  const topics = RESEARCH_TOPICS[type] ?? RESEARCH_TOPICS[SCHOLAR_HISTORIAN];
  return pickOne(rng, topics);
}

/** Progress gained on one slow (~60s) tick. */
function researchGain(rng) {
  return RESEARCH_MIN_PER_TICK + Math.floor(rng() * (RESEARCH_MAX_PER_TICK - RESEARCH_MIN_PER_TICK + 1));
}

/** Render a discovery line for a scholar type + topic. */
function discoveryLine(type, topic, rng = Math.random) {
  const frames = DISCOVERY_LINES[type] ?? DISCOVERY_LINES[SCHOLAR_HISTORIAN];
  return pickOne(rng, frames).replaceAll("{topic}", topic);
}

/** Render a lecture announcement for a scholar. */
function lectureLine(name, topic, rng = Math.random) {
  const line = pickOne(rng, LECTURE_LINES);
  const capTopic = topic.charAt(0).toUpperCase() + topic.slice(1);
  return line.replaceAll("{name}", name).replaceAll("{topic}", topic).replaceAll("{Topic}", capTopic);
}

/** Render a studying-aloud emote line. */
function studyLine(topic, rng = Math.random) {
  return pickOne(rng, STUDY_LINES).replaceAll("{topic}", topic);
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
    return (
      Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius
    );
  } catch {
    return false;
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

/**
 * The library: published scholarly works, per kingdom.
 * A future web overlay or NPC dialogue can surface these directly.
 */
function getLibrary(kingdomId) {
  return [...(libraryByKingdom.get(kingdomId) ?? [])];
}

/** Total published works across all kingdoms. */
function librarySize() {
  let n = 0;
  for (const works of libraryByKingdom.values()) n += works.length;
  return n;
}

// ============================================================================
// Research record management (data tier).
// ============================================================================

function researchFor(record, rng) {
  const key = record.username;
  let r = researchByCitizen.get(key);
  if (!r) {
    const type = scholarTypeFor(key);
    r = { type, topic: pickTopic(rng, type), progress: 0, lastAdvancedAt: 0 };
    researchByCitizen.set(key, r);
  }
  return r;
}

/** Advance one scholar's research; returns the discovery text when published, else null. */
function advanceResearch(record, rng, nowMs) {
  const r = researchFor(record, rng);
  r.progress += researchGain(rng);
  r.lastAdvancedAt = nowMs;
  if (r.progress < RESEARCH_COMPLETE) return null;
  // Published! Pick a fresh topic for the next cycle.
  const discovery = discoveryLine(r.type, r.topic, rng);
  const published = { type: r.type, topic: r.topic, discovery, at: nowMs };
  r.topic = pickTopic(rng, r.type);
  r.progress = 0;
  return published;
}

// ============================================================================
// The ticks.
// ============================================================================

/**
 * Slow-tick research (data tier, zero LLM): every scholar advances their
 * current topic; completed research is published — journaled as a
 * "discovery" (so gossip + the LLM prompt spread it), shelved in the
 * kingdom library, and broadcast as a custom event for other plugins.
 *
 * @param {object} director - the CitizenDirector instance
 * @param {function} rng - injectable rng (default Math.random)
 * @param {number} nowMs - Date.now()
 * @returns {number} discoveries published this tick
 */
function tickResearch(director, rng = Math.random, nowMs = Date.now()) {
  pruneState(nowMs);
  let published = 0;
  try {
    const journal = getJournal();
    for (const record of director.roster?.values?.() ?? []) {
      if (!isScholar(record.username)) continue;
      try {
        const result = advanceResearch(record, rng, nowMs);
        if (!result) continue;
        published += 1;
        // Journal it: the LLM prompt's "lately" line now carries the finding,
        // and gossip networks spread it like any other event.
        journal.log(
          record.username,
          "discovery",
          `${record.username} ${result.discovery}.`
        );
        // Shelve it in the kingdom library.
        const works = libraryByKingdom.get(record.kingdomId) ?? [];
        works.push({
          author: record.username,
          title: `${result.topic}`,
          topic: result.topic,
          type: result.type,
          discovery: result.discovery,
          at: nowMs,
        });
        libraryByKingdom.set(record.kingdomId, works);
        // World hook: quests / lore plugins can react to new knowledge.
        try {
          director.api?.emitCustomEvent?.("scholars:discovery", {
            author: record.username,
            kingdomId: record.kingdomId,
            type: result.type,
            topic: result.topic,
            discovery: result.discovery,
          });
        } catch {
          /* event bus optional — never break the tick */
        }
      } catch (e) {
        // Per-citizen try/catch: one scholar's failure never stops the rest.
        console.warn("[citizen-scholars] research failed for", record.username, e?.message ?? e);
      }
    }
  } catch (e) {
    console.warn("[citizen-scholars] tickResearch failed:", e?.message ?? e);
  }
  return published;
}

/**
 * Fast-tick visible life (proximity-gated, zero LLM): scholars near real
 * players muse aloud while studying, and occasionally announce public
 * lectures. Desync-compatible — pass the desync object from the director.
 *
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object|null} desync - { tick, spread } or null
 */
function tickLectures(director, nowMs = Date.now(), desync = null) {
  pruneState(nowMs);
  if (!director || !director.roster) return; // hostile input: silent no-op
  try {
    for (const record of director.roster?.values?.() ?? []) {
      // 1. Scholar gate (cheap hash).
      if (!isScholar(record.username)) continue;
      // 2. Desync gate (optional) — spread scholars across the tick cycle.
      if (
        desync &&
        typeof desync.tick === "number" &&
        typeof desync.spread === "number"
      ) {
        if (hash32(record.username.toLowerCase()) % desync.spread !== desync.tick % desync.spread)
          continue;
      }
      // 3. Citizen must be materialized.
      const citizen = director.playerFor?.(record);
      if (!citizen) continue;
      // 4. A real player must be within earshot.
      if (!anyRealPlayerNear(director, citizen, LECTURE_RADIUS)) continue;

      const r = researchFor(record, Math.random);
      const name = record.username;

      // Lecture: rare, announced to the area.
      const lastLecture = lastLectureAt.get(name) || 0;
      if (nowMs - lastLecture >= LECTURE_COOLDOWN_MS) {
        try {
          citizen.forceChat?.(lectureLine(name, r.topic));
        } catch {
          /* display-only */
        }
        lastLectureAt.set(name, nowMs);
        getJournal().log(name, "lecture", `${name} gave a public lecture on ${r.topic}.`);
        continue;
      }

      // Studying aloud: frequent ambient flavor.
      const lastStudy = lastStudyAt.get(name) || 0;
      if (nowMs - lastStudy >= STUDY_COOLDOWN_MS) {
        try {
          citizen.forceChat?.(studyLine(r.topic));
        } catch {
          /* display-only */
        }
        lastStudyAt.set(name, nowMs);
      }
    }
  } catch (e) {
    console.warn("[citizen-scholars] tickLectures failed:", e?.message ?? e);
  }
}

module.exports = {
  tickResearch,
  tickLectures,
  getLibrary,
  librarySize,
  // Pure helpers for tests:
  isScholar,
  scholarTypeFor,
  pickTopic,
  researchGain,
  discoveryLine,
  lectureLine,
  studyLine,
  pickOne,
  isRealPlayer,
  withinTiles,
  SCHOLAR_TYPES,
  RESEARCH_TOPICS,
  SCHOLAR_HISTORIAN,
  SCHOLAR_NATURALIST,
  SCHOLAR_INVENTOR,
  SCHOLAR_PHILOSOPHER,
};
