"use strict";
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


/**
 * CitizenRumors — citizens spread rumors: some true, some exaggerated, some false.
 *
 * WHAT IT DOES (data tier, free):
 *   Rumors seed from real journal events (quest completions, big kills, thefts).
 *   Each retelling along social ties has a chance to EXAGGERATE, MINIMIZE, or
 *   FABRICATE details. Every distortion is recorded in the rumor's lineage, so
 *   the truth is always traceable back to the seed event. Some rumors are
 *   "leads" — they point to real hidden things (a buried cache, a secret spot)
 *   that players can actually go find and confirm.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Citizens in taverns and streets speak rumors aloud via forceChat, using
 *   scripted template lines filled with the rumor's current (possibly wild)
 *   claims. Zero LLM: the mechanics are pure data; the LLM only riffs when
 *   a player directly asks "tell me more" through the normal chat path.
 *
 * Wired into the director tick next to the gossip-adjacent features.
 * Plain-node testable: CitizenRumors.test.js.
 */

// === Tuning: all magic numbers here ===
const RUMOR_RADIUS = 12; // tiles — tavern/street earshot
const RUMOR_CITIZEN_COOLDOWN_MS = 45 * 60 * 1000; // a citizen speaks a rumor at most this often
const RUMOR_CHANCE = 0.25; // per eligible citizen per ~60s tick
const RUMOR_MAX_HOPS = 5; // a rumor crosses at most 5 social ties before dying out
const RUMOR_HOP_MIN_MS = 2 * 60 * 1000; // min time between retellings
const RUMOR_MAX_AGE_MS = 12 * 3600 * 1000; // rumors go stale after 12h
const RUMOR_MAX_ACTIVE = 30; // cap active rumors (memory bound)
const RUMOR_DISTORT_CHANCE = 0.55; // chance each retelling distorts the claim

// === Cooldown state ===
const lastSpokeByCitizen = new Map(); // username -> timestamp

// === Active rumors (data tier, in-memory; persisted via CitizenMemory-style save if needed) ===
const activeRumors = new Map(); // rumorId -> rumor object

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastSpokeByCitizen) {
    if (at < cutoff) lastSpokeByCitizen.delete(k);
  }
  // Prune stale rumors too.
  for (const [id, rumor] of activeRumors) {
    if (nowMs - rumor.createdAt > RUMOR_MAX_AGE_MS || rumor.hops >= RUMOR_MAX_HOPS) {
      activeRumors.delete(id);
    }
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function normalizeName(name) {
  return String(name ?? "").toLowerCase().trim();
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

// --- Rumor seeding -----------------------------------------------------------

/**
 * Seed a rumor from a real journal event.
 * Pure: (rng, event) => rumor | null.
 * event: { kind, who, whoDisplay, what, where, whereDisplay, amount }
 */
function seedRumor(rng, event) {
  if (!event || !event.kind || !event.what) return null;
  if (activeRumors.size >= RUMOR_MAX_ACTIVE) return null;

  const now = Date.now();
  const id = `rumor-${now}-${Math.floor(rng() * 1e6)}`;

  const truth = {
    who: event.whoDisplay ?? String(event.who ?? "someone"),
    what: String(event.what).slice(0, 80),
    where: event.whereDisplay ?? String(event.where ?? "somewhere"),
    amount: typeof event.amount === "number" ? event.amount : null,
  };

  const rumor = {
    id,
    seedKind: event.kind,
    truth: { ...truth },
    claim: { ...truth }, // starts true; distortions mutate claim only
    lineage: [{ holder: normalizeName(event.holder ?? "unknown"), distortion: "seed", at: now }],
    hops: 0,
    holder: normalizeName(event.holder ?? "unknown"),
    holderDisplay: String(event.holder ?? "someone"),
    isLead: !!event.isLead,
    leadTarget: event.leadTarget ?? null, // { x, y, z, description } — a real discoverable
    confirmed: false,
    createdAt: now,
    lastHopAt: now,
    lastSpokeAt: 0,
  };

  activeRumors.set(id, rumor);
  return rumor;
}

// --- Rumor distortion --------------------------------------------------------

const EXAGGERATE_WORDS = [
  ["big", "enormous"], ["many", "countless"], ["strong", "unstoppable"],
  ["rich", "filthy rich"], ["dangerous", "terrifying"], ["fast", "blindingly fast"],
  ["old", "ancient"], ["hidden", "buried deep"],
];
const MINIMIZE_WORDS = [
  ["enormous", "big"], ["countless", "a few"], ["unstoppable", "tough"],
  ["filthy rich", "comfortable"], ["terrifying", "a bit scary"], ["ancient", "old"],
];
const FABRICATE_DETAILS = [
  "and the king himself was watching",
  "and there was a dragon circling overhead",
  "and it happened at midnight under a blood moon",
  "and a mysterious stranger in black was there",
  "and the whole tavern went silent",
  "and nobody has seen anything like it since",
];

/** Apply word swaps from a pair list to a string. Pure. */
function swapWords(text, pairs) {
  let out = String(text ?? "");
  for (const [from, to] of pairs) {
    const idx = out.toLowerCase().indexOf(from);
    if (idx >= 0) {
      out = out.slice(0, idx) + to + out.slice(idx + from.length);
      break; // one swap per distortion — keeps it readable
    }
  }
  return out;
}

/**
 * Distort a rumor's claim through one retelling.
 * Pure: (rng, rumor) => distortion type applied ("exaggerate"|"minimize"|"fabricate"|"none").
 * Mutates rumor.claim and appends to rumor.lineage. Truth is never touched.
 */
function distortRumor(rng, rumor, holderName) {
  if (!rumor || rumor.confirmed) return "none";
  if (rng() > RUMOR_DISTORT_CHANCE) {
    rumor.lineage.push({ holder: normalizeName(holderName), distortion: "none", at: Date.now() });
    return "none";
  }

  const roll = rng();
  let distortion;
  if (roll < 0.4) distortion = "exaggerate";
  else if (roll < 0.7) distortion = "minimize";
  else distortion = "fabricate";

  const claim = rumor.claim;
  if (distortion === "exaggerate") {
    if (typeof claim.amount === "number" && claim.amount > 0) {
      claim.amount = Math.round(claim.amount * (2 + rng() * 3)); // 2x–5x
    }
    claim.what = swapWords(claim.what, EXAGGERATE_WORDS);
    if (claim.what === rumor.truth.what && (claim.amount === rumor.truth.amount || claim.amount == null)) {
      claim.what = `truly ${claim.what}`;
    }
  } else if (distortion === "minimize") {
    if (typeof claim.amount === "number" && claim.amount > 0) {
      claim.amount = Math.max(1, Math.round(claim.amount / (2 + rng() * 3)));
    }
    claim.what = swapWords(claim.what, MINIMIZE_WORDS);
    if (claim.what === rumor.truth.what) {
      claim.what = `barely ${claim.what}`;
    }
  } else {
    // fabricate: bolt on a false detail
    const detail = pickOne(rng, FABRICATE_DETAILS);
    claim.what = `${claim.what} — ${detail}`;
  }

  rumor.lineage.push({ holder: normalizeName(holderName), distortion, at: Date.now() });
  return distortion;
}

/**
 * Retell a rumor to a new holder (one hop along the social graph).
 * Pure-ish: (rng, rumor, newHolder) => rumor (mutated) | null if it can't hop.
 */
function retellRumor(rng, rumor, newHolder) {
  if (!rumor || rumor.confirmed) return null;
  if (rumor.hops >= RUMOR_MAX_HOPS) return null;
  const now = Date.now();
  if (now - rumor.lastHopAt < RUMOR_HOP_MIN_MS) return null;

  distortRumor(rng, rumor, newHolder);
  rumor.hops += 1;
  rumor.holder = normalizeName(newHolder);
  rumor.holderDisplay = String(newHolder);
  rumor.lastHopAt = now;
  return rumor;
}

// --- Rumor speech ------------------------------------------------------------

const RUMOR_FRAMES = [
  (c) => `Psst — have you heard? ${c.who} ${c.what}${c.where ? ` near ${c.where}` : ""}.`,
  (c) => `Word around the tavern is ${c.who} ${c.what}${c.where ? ` over by ${c.where}` : ""}.`,
  (c) => `You didn't hear it from me, but ${c.who} ${c.what}${c.where ? ` at ${c.where}` : ""}.`,
  (c) => `Everyone's talking about how ${c.who} ${c.what}${c.where ? ` near ${c.where}` : ""}.`,
  (c) => `I swear it's true — ${c.who} ${c.what}${c.where ? ` by ${c.where}` : ""}.`,
];

const LEAD_FRAMES = [
  (c) => `They say there's something hidden ${c.where ? `near ${c.where}` : "nearby"}... ${c.who} ${c.what}. Worth a look, no?`,
  (c) => `Between you and me — ${c.who} ${c.what}${c.where ? ` at ${c.where}` : ""}. Might be something there for whoever checks first.`,
];

/**
 * Build the scripted speak line for a rumor. Pure.
 * Leads get the treasure-hint frame; normal rumors get a gossip frame.
 */
function rumorLine(rng, rumor) {
  if (!rumor) return null;
  const c = rumor.claim;
  // Append amount if the claim has one and the text doesn't already mention it.
  let what = c.what;
  if (typeof c.amount === "number" && !/\d/.test(what)) {
    what = `${what} — ${c.amount.toLocaleString("en-US")} of them, they say`;
  }
  const filled = { who: c.who, what, where: c.where };
  const frames = rumor.isLead && !rumor.confirmed ? LEAD_FRAMES : RUMOR_FRAMES;
  return pickOne(rng, frames)(filled);
}

/**
 * Decide whether this citizen should speak a rumor now.
 * Pure: (rng, lastSpokeMs, nowMs) => boolean. Test this.
 */
function shouldSpeak(rng, lastSpokeMs, nowMs) {
  if (nowMs - (lastSpokeMs || 0) < RUMOR_CITIZEN_COOLDOWN_MS) return false;
  return rng() < RUMOR_CHANCE;
}

/** Pick the freshest unconfirmed rumor this citizen could plausibly know. Pure. */
function pickRumorFor(rng, holderName) {
  const now = Date.now();
  const candidates = [...activeRumors.values()].filter(
    (r) => !r.confirmed && now - r.createdAt < RUMOR_MAX_AGE_MS && now - r.lastSpokeAt > 5 * 60 * 1000
  );
  if (candidates.length === 0) return null;
  // Prefer rumors this citizen already holds (they're "their" story), else freshest.
  const held = candidates.filter((r) => r.holder === normalizeName(holderName));
  const pool = held.length > 0 ? held : candidates;
  pool.sort((a, b) => b.createdAt - a.createdAt);
  return pool[Math.floor(rng() * Math.min(3, pool.length))];
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → citizen exists → real player near → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} rng - injectable RNG (default Math.random)
 */
function tickRumors(director, nowMs, rng = Math.random) {
  pruneCooldowns(nowMs);
  try {
    // 0. Spread step: each rumor has a chance to hop along social ties.
    // Cheap: bounded by RUMOR_MAX_ACTIVE, no player checks.
    spreadRumorsTick(director, nowMs, rng);

    // 1. Speech step: citizens near real players may voice a rumor.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // Cooldown gate — O(1), skips almost everyone
        const last = lastSpokeByCitizen.get(record.username) || 0;
        if (!shouldSpeak(rng, last, nowMs)) continue;

        // Citizen must be materialized (near a player already)
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, RUMOR_RADIUS)) continue;

        // Pick a rumor and speak it (scripted, zero LLM)
        const rumor = pickRumorFor(rng, record.username);
        if (!rumor) continue;
        const line = rumorLine(rng, rumor);
        if (!line) continue;

        { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
        rumor.lastSpokeAt = nowMs;
        // Speaking counts as a retelling — the listener may distort it next hop.
        lastSpokeByCitizen.set(record.username, nowMs);
      } catch (inner) {
        // Per-citizen: one bad citizen never breaks the loop.
        console.warn("[citizen-rumors] citizen failed:", record?.username, inner?.message ?? inner);
      }
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-rumors] tick failed:", e?.message ?? e);
  }
}

/**
 * One rumor-propagation step: each rumor may hop to a social tie of its holder.
 * Runs on the data tier — no players needed, zero LLM.
 */
function spreadRumorsTick(director, nowMs, rng = Math.random) {
  try {
    const memory = director.citizenMemory?.() ?? null;
    for (const rumor of activeRumors.values()) {
      if (rumor.confirmed) continue;
      if (rumor.hops >= RUMOR_MAX_HOPS) continue;
      if (nowMs - rumor.lastHopAt < RUMOR_HOP_MIN_MS) continue;
      if (nowMs - rumor.createdAt > RUMOR_MAX_AGE_MS) continue;
      if (rng() > 0.35) continue; // not every rumor hops every tick

      // Find a social tie to pass it to — prefer the memory gossip graph.
      const next = pickNextHolder(director, memory, rumor, rng);
      if (next) retellRumor(rng, rumor, next);
    }
  } catch (e) {
    console.warn("[citizen-rumors] spread failed:", e?.message ?? e);
  }
}

/** Pick who hears the rumor next: a social tie of the current holder. Pure-ish. */
function pickNextHolder(director, memory, rumor, rng) {
  try {
    const rosterNames = [...(director.roster?.keys?.() ?? [])];
    let links = [];
    if (memory?.bondedGossipLinks) {
      links = memory.bondedGossipLinks(rumor.holderDisplay ?? rumor.holder) ?? [];
    } else if (memory?.socialLinks) {
      links = memory.socialLinks(rumor.holder, rosterNames, 5) ?? [];
    }
    const fresh = links.filter(
      (n) => normalizeName(n) !== rumor.holder && !rumor.lineage.some((l) => l.holder === normalizeName(n))
    );
    if (fresh.length === 0) return null;
    return String(pickOne(rng, fresh));
  } catch {
    return null;
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

// --- Leads: player investigation ---------------------------------------------

/**
 * Mark a rumor's lead as confirmed (a player actually found the thing).
 * Called by quest/object handlers when the discovery happens — NOT from the tick.
 * Pure data update; returns the rumor or null.
 */
function confirmLead(rumorId, finderName) {
  const rumor = activeRumors.get(rumorId);
  if (!rumor || !rumor.isLead || rumor.confirmed) return null;
  rumor.confirmed = true;
  rumor.lineage.push({ holder: normalizeName(finderName), distortion: "confirmed", at: Date.now() });
  return rumor;
}

/** Test seam: clear all state. */
function resetForTests() {
  activeRumors.clear();
  lastSpokeByCitizen.clear();
  lastPruneAt = 0;
}

module.exports = {
  tickRumors,
  seedRumor,
  distortRumor,
  retellRumor,
  rumorLine,
  shouldSpeak,
  pickRumorFor,
  confirmLead,
  spreadRumorsTick,
  resetForTests,
  // Test seams (read-only views):
  _activeRumors: activeRumors,
  // Pure helpers:
  isRealPlayer,
  withinTiles,
  pickOne,
  swapWords,
  // Tuning (for tests):
  _tuning: {
    RUMOR_MAX_HOPS,
    RUMOR_CITIZEN_COOLDOWN_MS,
    RUMOR_DISTORT_CHANCE,
    RUMOR_MAX_ACTIVE,
  },
};
