"use strict";

/**
 * CitizenPress — the REAL, persistent journalism layer for The Mortal Age.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenNewspaper owns: the WEEKLY compiled paper — template headlines
 *     from citizen journals, town-crier shouts near players, the heraldic
 *     web overlay, sections (headlines/gossip/announcements/obituaries).
 *   - THIS module owns: the journalist PROFESSION (persistent reporter
 *     registry), INVESTIGATIVE stories filed from real events, PRINTING
 *     PRESSES with real papyrus costs, SUBSCRIPTION distribution with real
 *     coin transactions, PLAYER-submitted stories, and political salience
 *     (how much news a kingdom has read — elections may read it).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Journalist registry: real citizens registered by the life tick from
 *     ONLINE citizens only (honest reads — journalist career or
 *     curious/social traits).
 *   - Events: real happenings recorded per beat (crime, politics, war,
 *     discovery, culture). Recorded by the life tick from defensive reads
 *     of other modules; also submittable by tests/other systems.
 *   - Stories: journalists claim events and file stories. Headlines are
 *     deterministic template frames filled from the REAL event data —
 *     never random, never invented. Quality 1–10 from the author's real
 *     engagement (stories filed, beats covered).
 *   - Printing presses: one per kingdom, deterministic tile near the
 *     market. Stocked with REAL papyrus (970) donated from real inventories.
 *     Printing a special edition consumes 1 papyrus per copy — the press
 *     never prints what it cannot afford.
 *   - Special editions: compiled when a major real event fires (war
 *     declared, election held, landmark completed, champion crowned) or
 *     when 3+ stories on one beat accumulate within 48h. Stories bundled,
 *     printed, distributed.
 *   - Subscriptions: citizens subscribe per kingdom for REAL coins
 *     (5/edition, honest — broke citizens can't). Subscribers receive
 *     copies first; the political salience of a kingdom rises with the
 *     political stories its citizens actually read.
 *   - Player stories: real players file stories via chat ("publish: ...").
 *     They are attributed, quality-scored by length/specificity, and
 *     appear in editions like any citizen story.
 *   - `politicalSalienceFor(kingdomId)`: count of political stories read
 *     in the last 7 days — exposed for elections to read defensively.
 *     This module never touches elections itself.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Registration/investigation/edition logic lives in
 *     lib/CitizenPressLife.js (the director ticks that).
 *   - No LLM. Headlines are templates; the chat layer riffs.
 *   - No physical movement — the brain action handles that.
 *   - No invented coins or items. Papyrus 970 is the real engine item
 *     (same ID cartography/art use).
 */

const path = require("path");

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-press.json";
const MAT_PAPYRUS = 970; // papyrus — real engine item (matches CitizenArt/CitizenMaps)
const SUBSCRIPTION_PRICE = 5; // coins per edition, real coins
const EDITION_COPY_PRICE = 8; // coins per copy at the press, real coins
const STORIES_FOR_EDITION = 3; // auto-edition when N stories on one beat in window
const EDITION_WINDOW_MS = 48 * 3600 * 1000; // 48h story accumulation window
const SALIENCE_WINDOW_MS = 7 * 24 * 3600 * 1000; // political salience window
const MASTERWORK_QUALITY = 9; // quality >= 9 is a masterwork (fame deed)
const STORIES_FOR_INKSLINGER = 5; // fame deed threshold
const CRIME_STORIES_FOR_MUCKRAKER = 3; // fame deed threshold

const BEAT_CRIME = "crime";
const BEAT_POLITICS = "politics";
const BEAT_WAR = "war";
const BEAT_DISCOVERY = "discovery";
const BEAT_CULTURE = "culture";
const BEATS = Object.freeze([BEAT_CRIME, BEAT_POLITICS, BEAT_WAR, BEAT_DISCOVERY, BEAT_CULTURE]);

const KIND_MAJOR = "major"; // war declared, election held, landmark done, champion crowned
const KIND_ROUTINE = "routine"; // trials, laws, discoveries, matches

// --- state --------------------------------------------------------------------

let cache = null;
// { journalists, events, stories, presses, editions, subscriptions, playerStories, reads, nextId }
let dirty = false;
let nextId = 1;

function blankState() {
  return {
    journalists: Object.create(null), // norm -> { username, kingdomId, stories, beats: {}, registeredAt }
    events: Object.create(null), // id -> { id, beat, kind, kingdomId, subjectId, summary, happenedAt, claimedBy }
    stories: Object.create(null), // id -> { id, eventId, beat, author, authorIsPlayer, kingdomId, headline, quality, publishedAt, editionId }
    presses: Object.create(null), // kingdomId -> { kingdomId, tile, paper, editionsPrinted, foundedAt }
    editions: Object.create(null), // id -> { id, kingdomId, beat, storyIds, trigger, printedAt, copies, price, soldCopies }
    subscriptions: Object.create(null), // kingdomId -> { norm -> { username, since, editionsReceived } }
    playerStories: Object.create(null), // id -> story id (attribution index)
    reads: Object.create(null), // id -> { id, username, editionId, kingdomId, readAt } (political salience)
    nextId: 1,
  };
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

function savePath() {
  try {
    return path.join(__dirname, "..", "data", "saves", SAVE_KEY);
  } catch {
    return SAVE_KEY;
  }
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    if (fs.existsSync(savePath())) {
      const raw = JSON.parse(fs.readFileSync(savePath(), "utf8"));
      if (raw && typeof raw === "object") {
        for (const k of Object.keys(blankState())) {
          if (raw[k] && typeof raw[k] === "object") cache[k] = raw[k];
        }
        if (typeof raw.nextId === "number") nextId = raw.nextId;
      }
    }
  } catch { /* corrupt save = start fresh, never crash */ }
  return cache;
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const st = load();
    st.nextId = nextId;
    const p = savePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(st, null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function resetForTests() {
  cache = blankState();
  dirty = false;
  nextId = 1;
}

function allocId(prefix) {
  return `${prefix}-${nextId++}`;
}

// --- journalists --------------------------------------------------------------

/**
 * Register a citizen as a journalist. Honest: only registers real
 * usernames with a kingdom; the caller (life tick) checks the citizen is
 * online and in the journalist career or curious/social.
 */
function registerJournalist(username, kingdomId) {
  const st = load();
  const key = norm(username);
  if (!key || !kingdomId) return { ok: false, reason: "no-identity" };
  if (st.journalists[key]) return { ok: true, already: true };
  st.journalists[key] = {
    username: String(username),
    kingdomId: String(kingdomId),
    stories: 0,
    crimeStories: 0,
    beats: Object.create(null),
    registeredAt: Date.now(),
  };
  markDirty();
  return { ok: true, already: false };
}

function isJournalist(username) {
  return !!load().journalists[norm(username)];
}

function journalistFor(username) {
  return load().journalists[norm(username)] ?? null;
}

function journalistsIn(kingdomId) {
  const kid = String(kingdomId).toLowerCase();
  return Object.values(load().journalists).filter((j) => j.kingdomId === kid);
}

// --- events -------------------------------------------------------------------

/**
 * Record a real happening. The life tick calls this from defensive reads
 * of other modules; tests call it directly. Dedupes on (beat, subjectId)
 * so the same trial/war/election is never recorded twice.
 */
function recordEvent(beat, kingdomId, subjectId, summary, kind = KIND_ROUTINE) {
  const st = load();
  if (!BEATS.includes(beat)) return { ok: false, reason: "bad-beat" };
  const sid = String(subjectId ?? "");
  for (const e of Object.values(st.events)) {
    if (e.beat === beat && String(e.subjectId) === sid) {
      return { ok: true, already: true, id: e.id };
    }
  }
  const id = allocId("evt");
  st.events[id] = {
    id,
    beat,
    kind: kind === KIND_MAJOR ? KIND_MAJOR : KIND_ROUTINE,
    kingdomId: String(kingdomId ?? "").toLowerCase(),
    subjectId: sid,
    summary: String(summary ?? ""),
    happenedAt: Date.now(),
    claimedBy: null,
  };
  markDirty();
  return { ok: true, already: false, id };
}

function unclaimedEvents(beat, kingdomId, sinceMs = EDITION_WINDOW_MS) {
  const now = Date.now();
  const kid = String(kingdomId).toLowerCase();
  return Object.values(load().events).filter(
    (e) => e.beat === beat && e.kingdomId === kid && !e.claimedBy && now - e.happenedAt < sinceMs
  );
}

function majorEventsSince(kingdomId, sinceMs) {
  const now = Date.now();
  const kid = String(kingdomId).toLowerCase();
  return Object.values(load().events).filter(
    (e) => e.kingdomId === kid && e.kind === KIND_MAJOR && now - e.happenedAt < sinceMs
  );
}

/**
 * Additive read accessor (press guild ethics tribunal): a single event by
 * id, so fabrication claims can be verified against real records.
 */
function eventFor(id) {
  return load().events[String(id)] || null;
}

// --- stories ------------------------------------------------------------------

const HEADLINE_FRAMES = Object.freeze({
  [BEAT_CRIME]: [
    (s) => `Justice Served: ${s}`,
    (s) => `Court Report: ${s}`,
    (s) => `Under the Law: ${s}`,
  ],
  [BEAT_POLITICS]: [
    (s) => `Council News: ${s}`,
    (s) => `From the Halls of Power: ${s}`,
    (s) => `The Realm Decides: ${s}`,
  ],
  [BEAT_WAR]: [
    (s) => `War Report: ${s}`,
    (s) => `From the Front: ${s}`,
    (s) => `The Drums of War: ${s}`,
  ],
  [BEAT_DISCOVERY]: [
    (s) => `Discovery: ${s}`,
    (s) => `Explorers Report: ${s}`,
    (s) => `New Horizons: ${s}`,
  ],
  [BEAT_CULTURE]: [
    (s) => `Champion Crowned: ${s}`,
    (s) => `Celebration: ${s}`,
    (s) => `Arts & Games: ${s}`,
  ],
});

/**
 * Deterministic headline from the event's real summary. Frame choice is
 * a stable function of the event id — never random.
 */
function headlineFor(event) {
  const frames = HEADLINE_FRAMES[event.beat] ?? HEADLINE_FRAMES[BEAT_CULTURE];
  let h = 0;
  for (const ch of String(event.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return frames[h % frames.length](event.summary || "news from the realm");
}

/**
 * A journalist claims an event and files a story. Quality 1–10 is
 * deterministic from the author's real engagement (stories filed so far
 * + beats covered) — a human writes better with experience.
 */
function fileStory(username, eventId) {
  const st = load();
  const key = norm(username);
  const j = st.journalists[key];
  if (!j) return { ok: false, reason: "not-a-journalist" };
  const ev = st.events[eventId];
  if (!ev) return { ok: false, reason: "no-event" };
  if (ev.claimedBy) return { ok: false, reason: "already-claimed" };
  const id = allocId("story");
  const beatsCovered = Object.keys(j.beats).length;
  const quality = Math.max(1, Math.min(10, 3 + Math.floor(j.stories / 2) + Math.min(3, beatsCovered)));
  ev.claimedBy = j.username;
  j.stories += 1;
  j.beats[ev.beat] = (j.beats[ev.beat] ?? 0) + 1;
  if (ev.beat === BEAT_CRIME) j.crimeStories += 1;
  const story = {
    id,
    eventId: ev.id,
    beat: ev.beat,
    author: j.username,
    authorIsPlayer: false,
    kingdomId: ev.kingdomId,
    headline: headlineFor(ev),
    quality,
    publishedAt: Date.now(),
    editionId: null,
  };
  st.stories[id] = story;
  markDirty();
  return { ok: true, id, story };
}

/**
 * A real player files a story directly. Quality from length/specificity
 * of the headline — a human's real words, never invented content.
 */
function submitPlayerStory(playerName, kingdomId, beat, headline) {
  const st = load();
  if (!BEATS.includes(beat)) return { ok: false, reason: "bad-beat" };
  const head = String(headline ?? "").trim().slice(0, 140);
  if (head.length < 8) return { ok: false, reason: "too-short" };
  const id = allocId("story");
  const words = head.split(/\s+/).length;
  const quality = Math.max(1, Math.min(10, 2 + Math.floor(words / 6)));
  const story = {
    id,
    eventId: null,
    beat,
    author: String(playerName),
    authorIsPlayer: true,
    kingdomId: String(kingdomId ?? "").toLowerCase(),
    headline: head,
    quality,
    publishedAt: Date.now(),
    editionId: null,
  };
  st.stories[id] = story;
  st.playerStories[id] = true;
  markDirty();
  return { ok: true, id, story };
}

function storiesFor(kingdomId, beat, sinceMs = EDITION_WINDOW_MS) {
  const now = Date.now();
  const kid = String(kingdomId).toLowerCase();
  return Object.values(load().stories).filter(
    (s) => s.kingdomId === kid && (!beat || s.beat === beat) && now - s.publishedAt < sinceMs && !s.editionId
  );
}

function storyCountFor(username) {
  const j = load().journalists[norm(username)];
  return j ? j.stories : 0;
}

function fameDeedsFor(username) {
  // Returns deed ids the author has newly earned — the caller awards them.
  const j = load().journalists[norm(username)];
  if (!j) return [];
  const out = [];
  if (j.stories >= STORIES_FOR_INKSLINGER) out.push("inkslinger");
  if (j.crimeStories >= CRIME_STORIES_FOR_MUCKRAKER) out.push("muckraker");
  return out;
}

// --- presses ------------------------------------------------------------------

function pressTileFor(kingdomId) {
  try {
    const { siteTileByKingdom } = require("../brain/CitizenSites");
    const t = siteTileByKingdom(String(kingdomId), "market");
    if (t) return { x: t.x + 12, y: t.y - 12, z: t.z ?? 0 };
  } catch { /* fall through */ }
  return { x: 3200, y: 3200, z: 0 };
}

function ensurePress(kingdomId) {
  const st = load();
  const kid = String(kingdomId).toLowerCase();
  if (!st.presses[kid]) {
    st.presses[kid] = {
      kingdomId: kid,
      tile: pressTileFor(kid),
      paper: 0,
      editionsPrinted: 0,
      foundedAt: Date.now(),
    };
    markDirty();
  }
  return st.presses[kid];
}

function pressFor(kingdomId) {
  return load().presses[String(kingdomId).toLowerCase()] ?? null;
}

/** Stock the press with real papyrus. The caller moved real inventory. */
function stockPress(kingdomId, sheets) {
  const p = ensurePress(kingdomId);
  p.paper += Math.max(0, Math.floor(sheets));
  markDirty();
  return { ok: true, paper: p.paper };
}

// --- editions ------------------------------------------------------------------

/**
 * Compile a special edition from stories on one beat. Honest printing:
 * the press must hold enough real papyrus for the copies — copies beyond
 * paper stock are never printed.
 */
function compileEdition(kingdomId, beat, trigger) {
  const st = load();
  const kid = String(kingdomId).toLowerCase();
  const p = ensurePress(kid);
  const pool = storiesFor(kid, beat).sort((a, b) => b.quality - a.quality);
  if (!pool.length) return { ok: false, reason: "no-stories" };
  const subs = st.subscriptions[kid] ?? {};
  const subCount = Object.keys(subs).length;
  const wantCopies = Math.max(subCount, 5); // subscribers first, then newsstand
  const copies = Math.min(wantCopies, p.paper); // never print what we can't afford
  if (copies < 1) return { ok: false, reason: "no-paper" };
  const id = allocId("ed");
  const storyIds = pool.map((s) => s.id);
  for (const sid of storyIds) st.stories[sid].editionId = id;
  p.paper -= copies;
  p.editionsPrinted += 1;
  st.editions[id] = {
    id,
    kingdomId: kid,
    beat,
    storyIds,
    trigger: String(trigger ?? "accumulation"),
    printedAt: Date.now(),
    copies,
    price: EDITION_COPY_PRICE,
    soldCopies: 0,
  };
  markDirty();
  return { ok: true, id, edition: st.editions[id] };
}

function editionFor(id) {
  return load().editions[id] ?? null;
}

function latestEdition(kingdomId) {
  const kid = String(kingdomId).toLowerCase();
  const eds = Object.values(load().editions)
    .filter((e) => e.kingdomId === kid)
    .sort((a, b) => b.printedAt - a.printedAt);
  return eds[0] ?? null;
}

/** Record a copy sold at the press. Real coins move in the caller. */
function recordCopySold(editionId) {
  const st = load();
  const ed = st.editions[editionId];
  if (!ed) return { ok: false, reason: "no-edition" };
  ed.soldCopies += 1;
  markDirty();
  return { ok: true, soldCopies: ed.soldCopies };
}

// --- subscriptions -------------------------------------------------------------

/**
 * Subscribe a citizen to their kingdom's press. Returns the honest
 * outcome — the caller moves real coins (or refuses when broke).
 */
function subscribe(username, kingdomId) {
  const st = load();
  const kid = String(kingdomId).toLowerCase();
  const key = norm(username);
  if (!key || !kid) return { ok: false, reason: "no-identity" };
  if (!st.subscriptions[kid]) st.subscriptions[kid] = {};
  if (st.subscriptions[kid][key]) return { ok: true, already: true };
  st.subscriptions[kid][key] = { username: String(username), since: Date.now(), editionsReceived: 0 };
  markDirty();
  return { ok: true, already: false, price: SUBSCRIPTION_PRICE };
}

function isSubscriber(username, kingdomId) {
  const st = load();
  const kid = String(kingdomId).toLowerCase();
  return !!(st.subscriptions[kid] && st.subscriptions[kid][norm(username)]);
}

function subscribersIn(kingdomId) {
  const st = load();
  const kid = String(kingdomId).toLowerCase();
  return Object.values(st.subscriptions[kid] ?? {});
}

/** Record that a subscriber received (read) an edition. */
function recordRead(username, editionId) {
  const st = load();
  const ed = st.editions[editionId];
  if (!ed) return { ok: false, reason: "no-edition" };
  const key = norm(username);
  const sub = st.subscriptions[ed.kingdomId]?.[key];
  if (sub) sub.editionsReceived += 1;
  const id = allocId("read");
  st.reads[id] = { id, username: String(username), editionId, kingdomId: ed.kingdomId, readAt: Date.now() };
  markDirty();
  return { ok: true };
}

/**
 * Political salience: how many political stories this kingdom's readers
 * have actually read in the last 7 days. Exposed for elections to read
 * defensively — this module never touches elections itself.
 */
function politicalSalienceFor(kingdomId) {
  const st = load();
  const kid = String(kingdomId).toLowerCase();
  const cutoff = Date.now() - SALIENCE_WINDOW_MS;
  let n = 0;
  for (const r of Object.values(st.reads)) {
    if (r.kingdomId !== kid || r.readAt < cutoff) continue;
    const ed = st.editions[r.editionId];
    if (ed && ed.beat === BEAT_POLITICS) n += 1;
  }
  return n;
}

// --- describe -------------------------------------------------------------------

function describe(kingdomId) {
  const st = load();
  const kid = String(kingdomId).toLowerCase();
  const p = st.presses[kid];
  return {
    hasPress: !!p,
    paper: p?.paper ?? 0,
    editionsPrinted: p?.editionsPrinted ?? 0,
    journalistCount: journalistsIn(kid).length,
    subscriberCount: Object.keys(st.subscriptions[kid] ?? {}).length,
    unclaimedEvents: BEATS.reduce((acc, b) => acc + unclaimedEvents(b, kid).length, 0),
    unpublishedStories: storiesFor(kid).length,
    politicalSalience: politicalSalienceFor(kid),
  };
}

module.exports = {
  // constants
  BEATS, BEAT_CRIME, BEAT_POLITICS, BEAT_WAR, BEAT_DISCOVERY, BEAT_CULTURE,
  KIND_MAJOR, KIND_ROUTINE,
  SUBSCRIPTION_PRICE, EDITION_COPY_PRICE, MAT_PAPYRUS,
  STORIES_FOR_INKSLINGER, CRIME_STORIES_FOR_MUCKRAKER,
  // journalists
  registerJournalist, isJournalist, journalistFor, journalistsIn,
  // events
  recordEvent, unclaimedEvents, majorEventsSince, eventFor,
  // stories
  fileStory, submitPlayerStory, storiesFor, storyCountFor, fameDeedsFor, headlineFor,
  // presses
  ensurePress, pressFor, pressTileFor, stockPress,
  // editions
  compileEdition, editionFor, latestEdition, recordCopySold,
  // subscriptions
  subscribe, isSubscriber, subscribersIn, recordRead,
  // politics seam
  politicalSalienceFor,
  // describe + persistence
  describe, save, resetForTests,
};
