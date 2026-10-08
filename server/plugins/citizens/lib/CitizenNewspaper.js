"use strict";

/**
 * CitizenNewspaper — the town crier's weekly paper.
 *
 * WHAT IT DOES (data tier, free):
 *   Once a week, the paper is compiled from the realm's own data: citizen
 *   journals (quest completions, big kills, level-ups, feuds, friendships),
 *   active rumors, the festival calendar, recent election results, and newly
 *   retired elders. The edition is saved to disk. Zero LLM — headlines are
 *   template frames filled from real events.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Each capital has a town crier (a designated citizen, deterministic per
 *   kingdom). When a real player walks within earshot, the crier shouts the
 *   top headline via forceChat and hands them a copy — the heraldic web
 *   overlay opens with the full edition. Once per edition per player.
 *
 * Sections: headlines (big events), gossip column (social news), announcements
 * (festivals, elections, caravans), obituaries (retired/departed citizens).
 *
 * The LLM never compiles the paper. It may riff on the paper's contents later
 * through the normal chat path, reading the crier's journal like any citizen.
 *
 * Wired into the slow director tick (weekly compile, next to festivals) and
 * the proximity tick (crier shouts, next to toasts). Plain-node testable:
 * CitizenNewspaper.test.js.
 */

const fs = require("fs");
const path = require("path");

const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");

// === Tuning: all magic numbers here ===
const EDITION_INTERVAL_MS = 7 * 24 * 3600 * 1000; // weekly paper
const CRIER_RADIUS = 14; // tiles — earshot
const CRIER_SHOUT_COOLDOWN_MS = 30 * 60 * 1000; // a crier shouts at most every 30m
const CRIER_SHOUT_CHANCE = 0.6; // per eligible crier per proximity tick
const MAX_HEADLINES = 5;
const MAX_GOSSIP_ITEMS = 5;
const MAX_ANNOUNCEMENTS = 5;
const MAX_OBITUARIES = 3;

const NEWSPAPER_OPEN_ATTRIBUTE = "newspaper:open";
const NEWSPAPER_SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-newspaper.json");

// Paper names per kingdom — flavor.
const PAPER_NAMES = {
  misthalin: "The Varrock Voice",
  asgarnia: "The Falador Herald",
  kandarin: "The Ardougne Post",
  morytania: "The Darkmeyer Gazette",
  keldagrim: "The Keldagrim Ledger",
  wanderer: "The Wanderer's Wire",
};

function paperName(kingdomId) {
  return PAPER_NAMES[String(kingdomId || "").toLowerCase()] || "The Realm Reporter";
}

// === State ===
const lastShoutByCrier = new Map(); // crier username -> timestamp
let lastEdition = null; // { id, weekOf, compiledAt, kingdom, ...sections }
let savePathOverride = null; // test seam

// Memory-leak plug: prune shout cooldowns older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastShoutByCrier) {
    if (at < cutoff) lastShoutByCrier.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** True if a new weekly edition is due. Pure. */
function editionDue(lastCompiledAt, nowMs) {
  if (!lastCompiledAt) return true;
  return nowMs - lastCompiledAt >= EDITION_INTERVAL_MS;
}

/** Edition id: the ISO date (YYYY-MM-DD) of compilation day. Pure. */
function editionIdFor(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Deterministic 32-bit hash for stable crier picks. Pure. */
function hash32(str) {
  let h = 2166136261;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Pick the town crier for a kingdom: deterministic per kingdom + week, so the
 * same citizen criers all week but it rotates. Pure.
 */
function crierFor(kingdomId, records, editionId) {
  const kid = String(kingdomId || "").toLowerCase();
  const pool = (records || []).filter(
    (r) => String(r.kingdom || "").toLowerCase() === kid && r.username
  );
  if (pool.length === 0) return null;
  const flavored = pool.filter((r) =>
    ["commoner", "merchant"].includes(String(r.role || "").toLowerCase())
  );
  const pick = flavored.length > 0 ? flavored : pool;
  const idx = hash32(kid + ":" + editionId) % pick.length;
  return pick[idx];
}

/** Journal event kinds worth a headline. */
const HEADLINE_KINDS = new Set([
  "quest", "kill", "earned", "goal", "war", "befriended", "argued", "traded",
]);

/** Turn a journal event into a headline frame. Template-based, zero LLM. Pure. */
function headlineFor(event) {
  if (!event || !HEADLINE_KINDS.has(event.kind)) return null;
  const who = event.display || "A citizen";
  const text = String(event.text || "").slice(0, 120);
  if (!text) return null;
  switch (event.kind) {
    case "quest": return `${who} completes a great deed: ${text}`;
    case "kill": return `${who} fells a fearsome foe — ${text}`;
    case "earned": return `${who} rises in skill: ${text}`;
    case "goal": return `${who} achieves a life goal: ${text}`;
    case "war": return `War news: ${text}`;
    case "befriended": return `${who} forges a new bond${event.with ? ` with ${event.with}` : ""}`;
    case "argued": return `Quarrel in the streets: ${who} clashes${event.with ? ` with ${event.with}` : ""}`;
    case "traded": return `Market talk: ${text}`;
    default: return null;
  }
}

/** Turn a rumor into a gossip-column item. Pure. */
function gossipItemFor(rumor) {
  if (!rumor) return null;
  const text = String(rumor.text || rumor.claim || "").slice(0, 140);
  if (!text) return null;
  return text;
}

/** Compile a full edition from data sources. Pure — no engine, no I/O. */
function compileEdition(sources, kingdomId, nowMs) {
  const src = sources || {};
  const id = editionIdFor(nowMs);

  const headlines = [];
  for (const ev of src.journalEvents || []) {
    if (headlines.length >= MAX_HEADLINES) break;
    const h = headlineFor(ev);
    if (h) headlines.push(h);
  }
  if (headlines.length === 0) {
    headlines.push("A quiet week in the realm — the streets hum with ordinary life.");
  }

  const gossip = [];
  for (const r of src.rumors || []) {
    if (gossip.length >= MAX_GOSSIP_ITEMS) break;
    const g = gossipItemFor(r);
    if (g) gossip.push(g);
  }

  const announcements = [];
  for (const a of src.announcements || []) {
    if (announcements.length >= MAX_ANNOUNCEMENTS) break;
    const text = String(a.text || a).slice(0, 160);
    if (text) announcements.push(text);
  }

  const obituaries = [];
  for (const o of src.retired || []) {
    if (obituaries.length >= MAX_OBITUARIES) break;
    const name = o.display || o.username || "An elder";
    const role = o.role ? `, ${o.role}` : "";
    obituaries.push(`${name}${role} — honored in retirement after a life of service.`);
  }

  return {
    id, kingdom: String(kingdomId || ""), paper: paperName(kingdomId),
    compiledAt: nowMs, headlines, gossip, announcements, obituaries,
  };
}

/** The crier's shout line for a new edition. Scripted frames, zero LLM. Pure. */
function crierShoutLine(rng, edition) {
  const top = (edition.headlines || [])[0] || "news from across the realm";
  const frames = [
    `Extra! Extra! ${top} — read all about it in the ${edition.paper}!`,
    `Hear ye! ${top}! Get your copy of the ${edition.paper}!`,
    `News! News! ${top}! Fresh off the press — the ${edition.paper}!`,
  ];
  return frames[Math.floor(rng() * frames.length)];
}

/** Should this crier shout now? Pure. */
function shouldShout(rng, lastShoutMs, nowMs) {
  if (nowMs - (lastShoutMs || 0) < CRIER_SHOUT_COOLDOWN_MS) return false;
  return rng() < CRIER_SHOUT_CHANCE;
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch { return false; }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch { return false; }
}

/** Find a real player near the citizen, or null. */
function realPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return p;
    }
    return null;
  } catch { return null; }
}

// ============================================================================
// Persistence
// ============================================================================

function savePath() { return savePathOverride || NEWSPAPER_SAVE_FILE; }

function saveEdition(edition) {
  try {
    const p = savePath();
    if (!p) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const existing = loadEdition();
    const payload = {
      current: edition,
      previous: existing && existing.current ? existing.current : null,
    };
    fs.writeFileSync(p, JSON.stringify(payload));
    return true;
  } catch { return false; }
}

function loadEdition() {
  try {
    const p = savePath();
    if (!p) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return null; }
}

/** The latest compiled edition, for the web overlay API. */
function latestEdition() {
  if (lastEdition) return lastEdition;
  try {
    const saved = loadEdition();
    if (saved && saved.current) {
      lastEdition = saved.current;
      return lastEdition;
    }
  } catch { /* fall through */ }
  return null;
}

// ============================================================================
// Data gathering (impure — reads live systems)
// ============================================================================

function gatherSources(director, nowMs) {
  const journalEvents = [];
  const announcements = [];
  const retired = [];
  const since = nowMs - EDITION_INTERVAL_MS;

  try {
    const journal = getJournal();
    for (const record of journal.entries?.values?.() ?? []) {
      for (const ev of record.events || []) {
        if (ev.at < since) continue;
        if (!HEADLINE_KINDS.has(ev.kind)) continue;
        journalEvents.push({ kind: ev.kind, text: ev.text, with: ev.with, display: record.display, at: ev.at });
        if (journalEvents.length >= 40) break;
      }
      if (journalEvents.length >= 40) break;
    }
    journalEvents.sort((a, b) => b.at - a.at);
  } catch { /* headlines fall back */ }

  const rumors = [];
  try {
    const CitizenRumors = require("./CitizenRumors");
    const active = CitizenRumors._activeRumors;
    if (active) {
      for (const rumor of active.values()) {
        rumors.push(rumor);
        if (rumors.length >= MAX_GOSSIP_ITEMS) break;
      }
    }
  } catch { /* no rumors */ }

  try {
    const Festivals = require("./CitizenFestivals");
    const active = Festivals.activeFestival?.(nowMs);
    if (active) {
      announcements.push({ text: `${active.name} is underway — ${active.blurb}. Join the revelry!` });
    }
    for (const f of Festivals.FESTIVALS || []) {
      if (announcements.length >= MAX_ANNOUNCEMENTS) break;
      const now = new Date(nowMs);
      const fDate = new Date(now.getFullYear(), f.month, f.startDay);
      const diffDays = (fDate - now) / (24 * 3600 * 1000);
      if (diffDays > 0 && diffDays <= 14) {
        announcements.push({ text: `${f.name} begins in ${Math.ceil(diffDays)} days — ${f.blurb}.` });
      }
    }
  } catch { /* no festival news */ }

  try {
    const Retirement = require("./CitizenRetirement");
    for (const record of director.roster?.values?.() ?? []) {
      if (retired.length >= MAX_OBITUARIES) break;
      if (Retirement.isRetired?.(record.username)) {
        retired.push({ username: record.username, display: record.display || record.username, role: record.role });
      }
    }
  } catch { /* no obituaries */ }

  return { journalEvents, rumors, announcements, retired };
}

// ============================================================================
// Tick functions
// ============================================================================

/** Weekly compile — called from the slow director tick. Data tier, zero LLM. */
function tickNewspaper(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    const saved = loadEdition();
    const lastAt = saved?.current?.compiledAt || 0;
    if (!editionDue(lastAt, nowMs)) return;

    const kingdoms = new Set();
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdom) kingdoms.add(String(record.kingdom).toLowerCase());
    }
    if (kingdoms.size === 0) return;

    const sources = gatherSources(director, nowMs);
    let compiled = 0;
    for (const kingdomId of kingdoms) {
      const edition = compileEdition(sources, kingdomId, nowMs);
      if (saveEdition(edition)) {
        lastEdition = edition;
        compiled++;
      }
      try {
        const crier = crierFor(kingdomId, [...(director.roster?.values?.() ?? [])], edition.id);
        if (crier) {
          getJournal().log(crier.username, "worked", `published this week's ${edition.paper}`,
            { data: { editionId: edition.id } });
        }
      } catch { /* journaling is best-effort */ }
    }
    if (compiled > 0) {
      director.log?.("newspaper compiled", { kingdoms: [...kingdoms], edition: editionIdFor(nowMs) });
    }
  } catch (e) {
    console.warn("[citizen-newspaper] tick failed:", e?.message ?? e);
  }
}

/** Crier shouts — called from the proximity tick. Zero LLM. */
function tickCrier(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    const edition = latestEdition();
    if (!edition) return;

    const records = [...(director.roster?.values?.() ?? [])];
    const kingdoms = new Set(records.map((r) => String(r.kingdom || "").toLowerCase()).filter(Boolean));

    for (const kingdomId of kingdoms) {
      const crierRec = crierFor(kingdomId, records, edition.id);
      if (!crierRec) continue;

      const last = lastShoutByCrier.get(crierRec.username) || 0;
      if (nowMs - last < CRIER_SHOUT_COOLDOWN_MS) continue;

      const crier = director.playerFor?.(crierRec);
      if (!crier) continue;

      const player = realPlayerNear(director, crier, CRIER_RADIUS);
      if (!player) continue;

      if (Math.random() >= CRIER_SHOUT_CHANCE) continue;

      try { crier.forceChat?.(crierShoutLine(Math.random, edition)); } catch { /* best-effort */ }
      lastShoutByCrier.set(crierRec.username, nowMs);

      try {
        const seenKey = `newspaper:seen-${edition.id}`;
        if (!player.getAttribute?.(seenKey)) {
          player.setAttribute?.(seenKey, "1");
          player.setAttribute?.(NEWSPAPER_OPEN_ATTRIBUTE, edition.id);
        }
      } catch { /* best-effort */ }
    }
  } catch (e) {
    console.warn("[citizen-newspaper] crier tick failed:", e?.message ?? e);
  }
}

function _setSavePath(p) { savePathOverride = p; lastEdition = null; }
function _resetForTests() { lastShoutByCrier.clear(); lastEdition = null; lastPruneAt = 0; }

module.exports = {
  tickNewspaper, tickCrier, latestEdition,
  editionDue, editionIdFor, hash32, crierFor, headlineFor, gossipItemFor,
  compileEdition, crierShoutLine, shouldShout, isRealPlayer, withinTiles, paperName,
  NEWSPAPER_OPEN_ATTRIBUTE, EDITION_INTERVAL_MS,
  _setSavePath, _resetForTests,
  _saveEdition: saveEdition, _loadEdition: loadEdition,
};
