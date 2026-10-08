"use strict";

/**
 * CitizenMessengers2 — the runnerfolk: amateur word-carriers under the
 * official post. Gossip-carriers who run rumors between taverns and corners,
 * word-runners who carry SPOKEN messages between post corners (never written
 * mail), and board-runners who pin notes on the pin-boards at each city's
 * post corner. Commoners who live off small word-work — the informal,
 * mouth-to-ear economy under the professional couriers and heralds.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived runner types (~35% nominal share of commoners,
 *   post-exclusion), per-day post corners (kingdom-preferred, read from the
 *   master module's real post offices), per-day verbal routes and boards,
 *   per-kingdom-per-day lost-satchel / misdelivered-note set-pieces plus a
 *   breathless-runner crowd moment (journaled + rumor-seeded), and a
 *   read-only gossip bridge that lets runners repeat what the real
 *   CitizenRumors pools are actually saying.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted breathless runners, gossip lines that name
 * real rumors, board pins, the spilled satchel, the misdelivered note, the
 * crowd gathering to hear the runner's news. Real deliveries and retellings
 * are LLM tier — this module only tracks state, timers and the visible
 * street scene.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Wired into the director tick right after the messengers (proximity) block.
 * Plain-node testable: CitizenMessengers2.test.js.
 *
 * No overlap (by design):
 *   - CitizenMessengers (master) owns the OFFICIAL post: couriers, heralds,
 *     postmasters, urgent dispatches, sealed letters, the player letter
 *     ledger, proclamations of decrees/events/warnings. Citizens claimed
 *     by the master's real claimed-type function (messengerTypeFor) are
 *     excluded via its null path BEFORE the share roll — a citizen is never
 *     both a professional messenger and a runnerfolk.
 *   - CitizenCouriers2 (errand-runners) owns FETCH-AND-CARRY GOODS: hired
 *     fetch errands, baskets, water, the fetch-request and short-note
 *     ledgers. Runnerfolk carry WORDS, never parcels or hired fetch work —
 *     they never touch the fetch/note ledgers.
 *   - CitizenHawkers2 owns goods-cries — runnerfolk sell nothing.
 *   - CitizenWatchmen/CitizenGuards own the watch — runnerfolk carry words,
 *     never patrol or stand guard.
 */

// === Tuning: all magic numbers here ===
const RUNNER_RADIUS = 14; // tiles — close enough to hear
const RUNNER_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const RUNNER_CHANCE = 0.15; // per eligible citizen per tick
const RUNNER_SHARE = 35; // ~35% nominal share of commoners (post-exclusion)
const SATCHEL_CHANCE = 0.06; // ~6% per kingdom per day: lost satchel
const MISDELIVERED_CHANCE = 0.07; // ~7% per kingdom per day: misdelivered note
const RUNNER_CROWD_CHANCE = 0.08; // ~8% per post corner per day: crowd gathers for the runner
const WORK_START_HOUR = 6; // 06:00 server local time (the morning rounds start early)
const WORK_END_HOUR = 20; // 20:00 server local time

// === Top-level safeRequires (no lazy requires in the per-citizen path).
// The exclusion chain is linear; no cycle risk. ===
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProMessengers = safeRequire("./CitizenMessengers"); // master post: real claimed-type fn + real post offices
const Bonds = safeRequire("./CitizenBonds");
const Lod = safeRequire("./CitizenTickLod");
const Journal = safeRequire("./CitizenJournal");
const Rumors = safeRequire("./CitizenRumors");

// === Runner types ===
const GOSSIP_CARRIER = "gossip-carrier";
const WORD_RUNNER = "word-runner";
const BOARD_RUNNER = "board-runner";
const RUNNER_TYPES = [GOSSIP_CARRIER, WORD_RUNNER, BOARD_RUNNER];
const RUNNER_WEIGHTS = {
  [GOSSIP_CARRIER]: 40,
  [WORD_RUNNER]: 35,
  [BOARD_RUNNER]: 25,
};

// === The words a word-runner carries: SPOKEN messages only — never
// written mail, never parcels. What they carry would never be entrusted
// to the official post. ===
const VERBAL_WORDS = [
  "tell Old Maro his boat's patched and waiting",
  "the miller says the grinding's a day behind — tell the baker",
  "remind the cooper his hoops arrived at the yard",
  "the midwife's asking after the fishwife's daughter",
  "tell the mason the north wall stone is laid",
  "the farrier says the mare's shoe held — tell the stable",
  "the dyer's wife wants word sent to the market — cheap red cloth",
  "tell the tanner the hides are salted and ready",
  "the landlord wants the rent talked over at the tavern tonight",
  "tell the chandler the candles sold out — he should make more",
];

// === Tavern gossip the runners fall back on when the real rumor pools are
// quiet — coarse street talk, never news or decrees. ===
const STREET_GOSSIP = [
  "they say the baker's new apprentice burns every third loaf",
  "word is the ferryman's charging double after dark",
  "they say the mayor's cat had kittens in the court archives",
  "heard the dock lads found a barrel of rum with no owner",
  "they say the weaver's daughter is sweet on a guard",
  "word is the tavern's best ale keg runs dry by Saturday",
  "they say the cobbler's raising prices — hide your shoes",
  "heard the night watch lost their lantern again",
];

// === Board pins: the notes board-runners pin at the post corners — small
// paper notices, never official decrees. ===
const BOARD_NOTES = [
  "lost: one brass button, sentimental — reward a copper",
  "found: a single good boot, left, by the well",
  "tutor sought for a stubborn boy, afternoons",
  "will trade two laying hens for a stout cart wheel",
  "musician wanted for the harvest dance — fiddle preferred",
  "day laborers hired at the north gate, first light",
  "sweet plums for sale at the third house past the mill",
  "someone's dog keeps stealing sausages — please leash it",
];

// === Line pools — all scripted, zero LLM. ===

// The breathless run: one pool per runner type.
const RUN_LINES = {
  [GOSSIP_CARRIER]: [
    "Did you hear? {gossip} — pass it on!",
    "Fresh word, fresh word! {gossip}",
    "They say — {gossip}! Heard it at {corner}.",
    "Oy! {gossip} — that's the talk today.",
  ],
  [WORD_RUNNER]: [
    "{runner}: Got a word for {dest} — \"{word}\"! Got to keep moving!",
    "Make way! Carrying a word to {dest}: \"{word}\"!",
    "{runner} barely slows: \"{word}\" — that's for {dest}!",
    "Word bound for {dest}: \"{word}\" — tell them I ran it myself!",
  ],
  [BOARD_RUNNER]: [
    "{runner} pins a note to the board: \"{note}\"",
    "Fresh on the pin-board: \"{note}\" — read it here!",
    "{runner}: Pinned at {corner} — \"{note}\"",
    "The board at {corner} grows: \"{note}\"",
  ],
};

// Lost-satchel set-piece: the notes spill everywhere.
const SATCHEL_LINES = [
  "My satchel! The notes — they're everywhere! Help me grab them!",
  "(pages scatter across the cobbles) Not the notes! Pick them up, quick!",
  "Lost my satchel — the words are loose in the street! Catch them!",
];

// Misdelivered-note set-piece: the wrong door got the wrong word.
const MISDELIVERED_LINES = [
    "(sheepish) I… gave the note to the wrong house. The wrong house!",
    "Delivered the message to the wrong door — the look on her face!",
    "(groans) Wrong corner again. The words went to the wrong ears!",
];

// Breathless-runner crowd moment: once per corner per day, a crowd gathers
// to hear the news the runner brought.
const BREATHLESS_LINES = [
  "The crowd gathers round {corner} — the runner's got news!",
  "Hear it! The runner brings word to {corner} — gather round!",
  "A crowd draws round the breathless runner at {corner}!",
  "Word from the runner! The folk gather at {corner} to listen!",
];

// Runner small talk that names the real post offices via the bridge.
const POST_CORNER_LINES = [
  "For proper letters, the lads run out of {office} — I only carry words.",
  "The real post is at {office}; I run the mouth-words between corners.",
  "Post your letters at {office}, friend — I only carry spoken word.",
  "{office} runs the sealed post — my feet run the gossip.",
];

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
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

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** Weighted pick of a runner type from a 0..99 roll. */
function runnerTypeFromRoll(roll) {
  let acc = 0;
  for (const t of RUNNER_TYPES) {
    acc += RUNNER_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return GOSSIP_CARRIER;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
}

/** True during work hours (06:00-20:00 server local time). */
function isWorkHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
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

/** Cheap rng from a seed (mulberry-ish LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

/** Normalized username via CitizenBonds (fallback: lowercase). */
function normalizeName(name) {
  try {
    if (Bonds && typeof Bonds.normalizeName === "function") return Bonds.normalizeName(name);
  } catch { /* fall through */ }
  return String(name ?? "").toLowerCase();
}

// ============================================================================
// Runner identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * True when the master CitizenMessengers module claims this citizen —
 * called through the master's real claimed-type function (messengerTypeFor),
 * i.e. its null path, so professional couriers, heralds, runners and
 * postmasters are never also runnerfolk. Never throws.
 */
function isMasterMessenger(username) {
  try {
    if (!ProMessengers || typeof ProMessengers.messengerTypeFor !== "function") return false;
    const name = normalizeName(username);
    if (!name) return false;
    return ProMessengers.messengerTypeFor(name) !== null;
  } catch {
    return false;
  }
}

/**
 * The runner type for a roster record, or null.
 * Excludes citizens claimed by the master messengers (see above). The
 * exclusion runs BEFORE the share roll, so it holds regardless of the
 * 35% draw. Uses name-first salts to avoid the FNV-1a prefix-correlation
 * bug.
 */
function runnerTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const name = normalizeName(record?.username);
    if (!name) return null;
    if (isMasterMessenger(name)) return null;
    const roll = hashStr(name + "|messenger2") % 100;
    if (roll >= RUNNER_SHARE) return null;
    return runnerTypeFromRoll(hashStr(name + "|messenger2-type") % 100);
  } catch {
    return null;
  }
}

// ============================================================================
// Read-only bridges — real data, never written.
// ============================================================================

/**
 * The post corners: the master module's real post offices (name + kingdom),
 * read-only, so runner small talk names the same post the heralds and
 * couriers work out of. Returns the master POST_OFFICES list, or null.
 */
function postOffices() {
  try {
    if (!ProMessengers || !Array.isArray(ProMessengers.POST_OFFICES)) return null;
    if (ProMessengers.POST_OFFICES.length === 0) return null;
    return ProMessengers.POST_OFFICES;
  } catch {
    return null;
  }
}

/** Today's post corner for a runner citizen: kingdom-preferred. */
function postCornerFor(record, dateMs = Date.now()) {
  try {
    const offices = postOffices();
    if (!offices) return null;
    const kid = record?.kingdomId ?? record?.kingdom;
    const local = kid ? offices.filter((o) => String(o.kingdom).toLowerCase() === String(kid).toLowerCase()) : [];
    const src = local.length ? local : offices;
    const name = normalizeName(record?.username) || "anon";
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|messenger2corner:" + day));
    return pickOne(rng, src);
  } catch {
    return null;
  }
}

/**
 * Read-only gossip bridge: what the real CitizenRumors pools are saying
 * right now (claim text of live rumors), so the gossip-carriers repeat the
 * same talk the taverns are actually telling. Returns an array of strings,
 * possibly empty. Never throws.
 */
function liveGossip() {
  try {
    if (!Rumors || !(Rumors._activeRumors instanceof Map)) return [];
    const out = [];
    for (const rumor of Rumors._activeRumors.values()) {
      const what = rumor?.claim?.what ?? rumor?.truth?.what;
      if (what && String(what).trim()) out.push(String(what).trim());
    }
    return out;
  } catch {
    return [];
  }
}

/** Today's gossip for a gossip-carrier: live rumor talk when the pools are
 * active, else seeded street gossip. Seeded per day so it holds all day. */
function gossipFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|messenger2gossip:" + day));
    const live = liveGossip();
    const pool = live.length ? live : STREET_GOSSIP;
    return pickOne(rng, pool);
  } catch {
    return null;
  }
}

/** Today's spoken word for a word-runner: seeded per day. */
function wordFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|messenger2word:" + day));
    return pickOne(rng, VERBAL_WORDS);
  } catch {
    return null;
  }
}

/** Today's board note for a board-runner: seeded per day. */
function boardNoteFor(username, dateMs = Date.now()) {
  try {
    const name = normalizeName(username) || "anon";
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|messenger2board:" + day));
    return pickOne(rng, BOARD_NOTES);
  } catch {
    return null;
  }
}

/** Today's verbal route: origin corner -> destination corner, seeded per day. */
function routeFor(username, dateMs = Date.now()) {
  try {
    const offices = postOffices();
    if (!offices) return null;
    const name = normalizeName(username) || "anon";
    const day = dayNumber(dateMs);
    const rng = seededRng(hashStr(name + "|messenger2route:" + day));
    const origin = pickOne(rng, offices);
    let dest = pickOne(rng, offices);
    if (dest === origin && offices.length > 1) dest = pickOne(rng, offices);
    return { origin, dest };
  } catch {
    return null;
  }
}

// ============================================================================
// Daily set-pieces (seeded per kingdom per day / per corner per day).
// ============================================================================

/** Lost satchel: the kingdom's runnerfolk spill their notes (~6%/kingdom/day). */
function satchelFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("messenger2satchel:" + kingdomId + ":" + day)), SATCHEL_CHANCE);
}

/** Misdelivered note: the word went to the wrong ears (~7%/kingdom/day). */
function misdeliveredFor(kingdomId, dateMs) {
  if (!kingdomId) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("messenger2mis:" + kingdomId + ":" + day)), MISDELIVERED_CHANCE);
}

/** Breathless-runner crowd moment: the folk gather for the news (~8%/corner/day). */
function runnerCrowdFor(corner, dateMs) {
  if (!corner) return false;
  const day = dayNumber(dateMs);
  return chance(seededRng(hashStr("messenger2crowd:" + corner.name + ":" + day)), RUNNER_CROWD_CHANCE);
}

// ============================================================================
// Cooldown state (monotonic Date.now() timestamps)
// ============================================================================
const lastFiredByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// ============================================================================
// Journal + rumor helpers (top-level requires; never throw).
// ============================================================================

function journalize(citizen, text) {
  try {
    if (Journal && typeof Journal.appendEntry === "function") {
      Journal.appendEntry(citizen, text);
    } else if (Journal && typeof Journal.addEntry === "function") {
      Journal.addEntry(citizen, text);
    }
  } catch { /* journal absent */ }
}

function seedRumor(rng, event) {
  try {
    if (Rumors && typeof Rumors.seedRumor === "function") Rumors.seedRumor(rng, event);
  } catch { /* rumors absent */ }
}

/** Scripted speech via forceChat; never throws. */
function forceSay(citizen, text) {
  try {
    citizen.forceChat?.(String(text).slice(0, 120));
  } catch { /* cosmetic */ }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → LOD brain gate → runner? →
// materialized → work hours → real player near → chance → work.
// ============================================================================

function tickMessengers2(director, nowMs, desync) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < RUNNER_CITIZEN_COOLDOWN_MS) continue;

        // 2. LOD brain gate — distant citizens skip visible runner life on
        // most cycles (near-band and unclassified always due: unchanged).
        if (Lod && typeof Lod.brainTickDue === "function") {
          if (!Lod.brainTickDue(director, record, desync?.tick)) continue;
        }

        // 3. Must be runnerfolk (hash-derived, cheap; exclusions inside)
        const type = runnerTypeOf(record);
        if (!type) continue;

        // 4. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 5. Work hours only (morning rounds start at 6)
        if (!isWorkHour(nowMs)) continue;

        // 6. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, RUNNER_RADIUS)) continue;

        // 7. Chance gate
        if (!chance(Math.random, RUNNER_CHANCE)) continue;

        // 8. Do the thing (scripted, zero LLM)
        doRunnerWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-messengers2] citizen failed:", e?.message ?? e);
      }
    }

    // Daily rhythms: lost satchels and misdelivered notes (cheap, day-gated).
    dailyRhythms(director, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-messengers2] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doRunnerWork(director, record, citizen, type, nowMs) {
  const name = normalizeName(record.username);
  const kid = record?.kingdomId ?? record?.kingdom;
  const day = dayNumber(nowMs);
  const corner = postCornerFor(record, nowMs);
  const cornerName = corner ? corner.name : "the post corner";
  const route = routeFor(name, nowMs);
  const destName = route ? route.dest.name : cornerName;

  // Lost-satchel set-piece: the notes spill everywhere.
  if (kid && satchelFor(kid, nowMs)) {
    forceSay(citizen, fill(pickOne(Math.random, SATCHEL_LINES), {}));
    journalize(citizen, `spilled their satchel of notes at ${cornerName}`);
    seedRumor(Math.random, {
      kind: "runner",
      what: `a runner spilled their satchel at ${cornerName} — the notes are loose in the street`,
      who: record.username,
      where: cornerName,
    });
    return;
  }

  // Misdelivered-note set-piece: the word went to the wrong ears.
  if (kid && misdeliveredFor(kid, nowMs) && Math.random() < 0.5) {
    forceSay(citizen, fill(pickOne(Math.random, MISDELIVERED_LINES), {}));
    journalize(citizen, `misdelivered a note at ${cornerName}`);
    return;
  }

  // Breathless-runner crowd moment: once per corner per day, the folk
  // gather to hear the runner's news.
  if (corner && runnerCrowdFor(corner, nowMs)) {
    const key = "messenger2crowd:" + corner.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const gossip = gossipFor(name, nowMs) ?? "fresh word!";
      forceSay(citizen, fill(pickOne(Math.random, BREATHLESS_LINES), { corner: cornerName }));
      journalize(citizen, `drew a breathless crowd at ${cornerName} with word of ${gossip}`);
      seedRumor(Math.random, {
        kind: "runner",
        what: `a breathless runner drew a crowd at ${cornerName}`,
        who: record.username,
        where: cornerName,
      });
      return;
    }
  }

  const roll = Math.random();
  if (roll < 0.6) {
    const lines = RUN_LINES[type] ?? RUN_LINES[GOSSIP_CARRIER];
    forceSay(citizen, fill(pickOne(Math.random, lines), {
      runner: record.username,
      gossip: gossipFor(name, nowMs) ?? "fresh word",
      word: wordFor(name, nowMs) ?? "word",
      note: boardNoteFor(name, nowMs) ?? "a note",
      dest: destName,
      corner: cornerName,
    }));
    journalize(citizen, `ran words through ${cornerName}`);
  } else {
    // Post-corner small talk: name the real post office via the bridge.
    const offices = postOffices();
    const office = offices ? pickOne(Math.random, offices) : null;
    const officeName = office ? office.name : "the post office";
    forceSay(citizen, fill(pickOne(Math.random, POST_CORNER_LINES), { office: officeName }));
    journalize(citizen, `talked the real post at ${officeName} while running ${cornerName}`);
  }
}

/** Once-per-day kingdom rhythms: lost satchels and misdelivered notes. */
function dailyRhythms(director, nowMs) {
  const day = dayNumber(nowMs);
  try {
    const offices = postOffices() ?? [];
    const kingdoms = [...new Set(offices.map((o) => o.kingdom).filter(Boolean))];
    for (const kid of kingdoms) {
      if (satchelFor(kid, nowMs)) {
        const key = "daily-messenger2satchel:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const corner = offices.find((o) => o.kingdom === kid);
          const line = `The runnerfolk in ${kid} lost a satchel — the notes are loose in the street at ${corner ? corner.name : kid}.`;
          journalize({ username: "the runnerfolk" }, line);
          seedRumor(Math.random, { kind: "runner", what: line, who: "the runnerfolk", where: kid });
        }
      }
      if (misdeliveredFor(kid, nowMs)) {
        const key = "daily-messenger2mis:" + kid + ":" + day;
        if (!lastFiredByCitizen.has(key)) {
          lastFiredByCitizen.set(key, nowMs);
          const corner = offices.find((o) => o.kingdom === kid);
          const line = `A runner gave the word to the wrong door in ${kid} — the wrong ears heard it at ${corner ? corner.name : kid}.`;
          journalize({ username: "the runnerfolk" }, line);
          seedRumor(Math.random, { kind: "runner", what: line, who: "the runnerfolk", where: kid });
        }
      }
    }
  } catch { /* daily rhythms are best-effort */ }
}

module.exports = {
  tickMessengers2,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  runnerTypeOf,
  isMasterMessenger,
  postCornerFor,
  postOffices,
  liveGossip,
  gossipFor,
  wordFor,
  boardNoteFor,
  routeFor,
  satchelFor,
  misdeliveredFor,
  runnerCrowdFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  runnerTypeFromRoll,
  isRealPlayer,
  withinTiles,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  RUNNER_TYPES,
  GOSSIP_CARRIER,
  WORD_RUNNER,
  BOARD_RUNNER,
  VERBAL_WORDS,
  STREET_GOSSIP,
  BOARD_NOTES,
  RUN_LINES,
  SATCHEL_LINES,
  MISDELIVERED_LINES,
  BREATHLESS_LINES,
  POST_CORNER_LINES,
  // Tuning (tests pin the documented behavior):
  RUNNER_RADIUS,
  RUNNER_CITIZEN_COOLDOWN_MS,
  RUNNER_CHANCE,
  RUNNER_SHARE,
  SATCHEL_CHANCE,
  MISDELIVERED_CHANCE,
  RUNNER_CROWD_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  RUNNER_TYPES_WEIGHTS: RUNNER_WEIGHTS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    lastPruneAt = 0;
  },
  // Test seam (read/write view of the cooldown/crowd-once-per-day map):
  _lastFiredByCitizen: lastFiredByCitizen,
};
