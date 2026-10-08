"use strict";

/**
 * CitizenWeddings — anniversaries, romantic drama, and player-facing romance.
 *
 * WHAT IT DOES (data tier, free — runs with zero players online):
 *   - Anniversaries: married couples hit yearly milestones from their
 *     wedding date (bond.updatedAt at the "married" stage). Journaled for
 *     both partners + gossiped, with named milestones (1st, 5th, 10th,
 *     25th silver, 50th gold).
 *   - Love triangles: rarely, a single citizen develops a crush on a
 *     taken citizen. The pining is journaled, gossip spreads, and it
 *     resolves as "moved on" — or "jilted" if the couple marries
 *     mid-triangle. Never touches the real bond; the drama is social.
 *   - Cold feet: a tiny personality-driven chance that an announced
 *     wedding is called off before the ceremony. The couple stays
 *     "serious" and the existing proposal logic may re-announce later.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   - Anniversary celebrations: a scripted forceChat line when a real
 *     player is near either partner on their anniversary.
 *   - Wedding welcomes: an in-progress ceremony invites nearby players
 *     to attend ("all are welcome").
 *   - Proposals: a single citizen who adores a real player (memory tone
 *     >= 7) may rarely propose — scripted line, journaled, gossiped.
 *     The LLM carries the romantic dialogue from the journal entry.
 *
 * Zero LLM: all visible output is scripted pools + journal quotes.
 *
 * Wired into the director tick BEFORE CitizenKinship.tickKinship so cold
 * feet can cancel an announced wedding before the ceremony machine runs.
 * Plain-node testable: CitizenWeddings.test.js.
 */

// === Tuning: all magic numbers here ===
const YEAR_MS = 365 * 24 * 3600 * 1000;
const ANNIVERSARY_RADIUS = 14; // tiles — close enough to hear the celebration
const TRIANGLE_SPAWN_P = 0.002; // per eligible bond per ~60s tick (rare)
const TRIANGLE_LIFETIME_MS = 14 * 24 * 3600 * 1000; // admirer pines, then moves on
const TRIANGLE_JILT_P = 0.35; // if the couple marries mid-triangle, chance of a jilted scene
const COLD_FEET_BASE_P = 0.015; // per tick while announced, personality-modified
const PROPOSAL_TONE_MIN = 7; // memory tone toward the player (-10..10)
const PROPOSAL_P = 0.01; // per eligible citizen per tick (rare)
const PROPOSAL_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // per citizen
const WELCOME_RADIUS = 16;

// Personality: who gets cold feet, who pines. (proposalChance lives in
// CitizenKinship alongside the other trait scorers.)
const ROMANTIC_TRAITS = new Set(["devout", "cheerful", "chatty", "easygoing"]);
const NERVOUS_TRAITS = new Set(["nervous", "timid", "fearful"]);
const BOLD_TRAITS = new Set(["bold", "confident", "proud"]);

function proposalChance(traitsA, traitsB) {
  try {
    return require("./CitizenKinship").proposalChance(traitsA, traitsB);
  } catch {
    return 0.55;
  }
}

// === Lazy singletons (avoid load-order cycles) ===
function kinship() {
  try {
    return require("./CitizenKinship").getKinship();
  } catch {
    return null;
  }
}
function journal() {
  try {
    return require("./CitizenJournal").getJournal();
  } catch {
    return null;
  }
}
function memory() {
  try {
    return require("./CitizenMemory").getMemory();
  } catch {
    return null;
  }
}
function gossipKinds() {
  try {
    const m = require("./CitizenMemory");
    return { wedding: m.GOSSIP_WEDDING ?? "wedding", feud: m.GOSSIP_FEUD ?? "feud" };
  } catch {
    return { wedding: "wedding", feud: "feud" };
  }
}

// === Cooldown state ===
const lastProposalByCitizen = new Map(); // username -> timestamp
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastProposalByCitizen) {
    if (at < cutoff) lastProposalByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

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

function displayOf(record, username) {
  return record?.displayName ?? record?.personality?.name ?? username;
}

function traitsOf(record) {
  return record?.personality?.traits ?? [];
}

/**
 * How many anniversaries are due for a married bond.
 * bond.updatedAt is the wedding date (set by setStage("married")).
 * bond.data.anniversaries counts already-celebrated ones.
 * Pure: (bond, nowMs) => n >= 0.
 */
function anniversariesDue(bond, nowMs) {
  if (!bond || bond.stage !== "married") return 0;
  const weddingAt = bond.updatedAt ?? 0;
  if (!weddingAt || nowMs <= weddingAt) return 0;
  const celebrated = bond.data?.anniversaries ?? 0;
  const elapsed = Math.floor((nowMs - weddingAt) / YEAR_MS);
  return Math.max(0, elapsed - celebrated);
}

/** "1st", "5th", "25th (silver)" ... */
function milestoneName(n) {
  const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
  const special = n === 25 ? " (silver)" : n === 50 ? " (gold)" : n === 10 ? " (tin)" : "";
  return `${n}${suffix}${special}`;
}

/**
 * 0..1 per-tick chance an announced wedding is called off.
 * Nervous citizens get cold feet; bold ones never do.
 */
function coldFeetChance(traitsA, traitsB) {
  const t = new Set([...(traitsA ?? []), ...(traitsB ?? [])]);
  let p = COLD_FEET_BASE_P;
  for (const n of NERVOUS_TRAITS) if (t.has(n)) p *= 3;
  for (const b of BOLD_TRAITS) if (t.has(b)) p *= 0.2;
  return Math.min(0.2, p);
}

/**
 * Is this roster record an eligible secret admirer?
 * Single (no romance bond), same kingdom, not either partner.
 */
function eligibleAdmirer(record, username, a, b, k) {
  if (!record || record.username === a || record.username === b) return false;
  if (record.kingdomId !== k.bond.kingdomId) return false;
  try {
    return !k.hasRomance(record.username);
  } catch {
    return false;
  }
}

/** Memory tone a citizen holds toward a player (-10..10). */
function toneToward(citizenName, playerName) {
  try {
    const m = memory();
    const entry = m?.getEntry?.(citizenName, playerName);
    return entry?.tone ?? 0;
  } catch {
    return 0;
  }
}

function say(bot, line) {
  try {
    bot?.forceChat?.(String(line).slice(0, 160));
  } catch {
    // Non-fatal.
  }
}

function journalEvent(name, text, kind = "romance", other = null) {
  try {
    const j = journal();
    if (j) j.log(name, kind, text, other ? { with: other } : {});
  } catch {
    // Non-fatal.
  }
}

function seedRumor({ kingdomId, kind, subject, subjectDisplay, text, holder }) {
  try {
    const m = memory();
    if (!m || !holder) return;
    m.seedGossip({ kingdomId, kind, subject, subjectDisplay, text, holder });
  } catch {
    // Non-fatal.
  }
}

function botOf(director, record) {
  try {
    return director.isOnline(record) ? director.getBot(record) : null;
  } catch {
    return null;
  }
}

/** Real (non-bot) players within radius tiles of a bot. */
function realPlayersNear(bot, radius) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && isRealPlayer(p) && withinTiles(bot, p, radius)) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

// --- scripted line pools (zero LLM) ------------------------------------------

const ANNIVERSARY_LINES = Object.freeze([
  "{A} and {B} — {N} anniversary! Here's to many more!",
  "Everyone raise a cup — {A} and {B} have been married {N} year{s}!",
  "{N} anniversary for {A} and {B}. Love like that keeps a town warm.",
]);

const TRIANGLE_PINING = Object.freeze([
  "I see {T} watching {A} again. Poor soul — that heart chose someone else.",
  "{T} has been writing letters they never send. We all know who they're for.",
  "Someone should tell {T} to let {A} go. Pining never built a home.",
]);

const TRIANGLE_JILTED = Object.freeze([
  "{T} stood at the back of the square, white as milk, and walked away.",
  "They say {T} wept when the vows were spoken. {A} never even looked.",
  "{T} won't speak to {A} now. Love curdles fast when it's one-sided.",
]);

const TRIANGLE_MOVED_ON = Object.freeze([
  "{T} seems lighter these days. The pining finally passed, I think.",
  "Heard {T} laughing at the tavern again. Time heals, even this.",
]);

const COLD_FEET_LINES = Object.freeze([
  "The wedding's off — {A} got cold feet at the last. Give them time.",
  "{A} panicked and called it off. {B} says they understand. Weddings wait.",
  "No wedding today. {A} needs more time, and {B} is giving it.",
]);

const PROPOSAL_LINES = Object.freeze([
  "{C}, my heart — will you marry me? Say yes and make me the happiest soul in {K}.",
  "I've loved you from the first day I saw you, {C}. Marry me?",
  "{C} — I don't have much, but I have this ring and my whole heart. Marry me?",
]);

const WELCOME_LINES = Object.freeze([
  "Friends, travelers — all are welcome to witness this wedding!",
  "Come closer, everyone! A wedding is a town's business!",
  "Stay a while — {A} and {B} would have the whole world at their wedding!",
]);

// ============================================================================
// Data-tier ticks — run with zero players online.
// ============================================================================

function tickAnniversaries(director, rng, nowMs) {
  const k = kinship();
  if (!k) return;
  const roster = director.roster;
  for (const { a, b, bond } of [...k.bonds.values()]) {
    if (bond.type !== "romance" || bond.stage !== "married") continue;
    const due = anniversariesDue(bond, nowMs);
    if (due <= 0) continue;
    const ra = roster?.get(a);
    const rb = roster?.get(b);
    const da = displayOf(ra, a);
    const db = displayOf(rb, b);
    bond.data.anniversaries = (bond.data.anniversaries ?? 0) + due;
    k.touch(a, b, nowMs);
    // Journal both partners (latest milestone if several lapsed).
    const n = bond.data.anniversaries;
    journalEvent(a, `${milestoneName(n)} anniversary with ${db}. Still the best decision I ever made.`, "romance", b);
    journalEvent(b, `${milestoneName(n)} anniversary with ${da}. My heart is full.`, "romance", a);
    seedRumor({
      kingdomId: bond.kingdomId,
      kind: gossipKinds().wedding,
      subject: a,
      subjectDisplay: `${da} and ${db}`,
      text: `celebrated their ${milestoneName(n)} anniversary!`,
      holder: a,
    });
    // Interaction tier: celebrate out loud if a real player is near.
    const botA = ra ? botOf(director, ra) : null;
    const botB = rb ? botOf(director, rb) : null;
    const speaker = botA ?? botB;
    if (speaker && realPlayersNear(speaker, ANNIVERSARY_RADIUS).length > 0) {
      const years = n === 1 ? "1 year" : `${n} years`;
      say(speaker, pickOne(rng, ANNIVERSARY_LINES).replace("{A}", da).replace("{B}", db).replace("{N}", milestoneName(n)).replace("{s}", n === 1 ? "" : "s").replace("{N} year{s}", years));
    }
  }
}

function tickTriangles(director, rng, nowMs) {
  const k = kinship();
  if (!k) return;
  const roster = director.roster;
  const BOND_ROMANCE = "romance";
  for (const { a, b, bond } of [...k.bonds.values()]) {
    if (bond.type !== BOND_ROMANCE) continue;
    if (bond.stage !== "courting" && bond.stage !== "serious") continue;
    const tri = bond.data.triangle;

    // Resolve an active triangle.
    if (tri) {
      const ra = roster?.get(a);
      const rb = roster?.get(b);
      const da = displayOf(ra, a);
      // The couple married mid-triangle: the admirer is jilted.
      if (bond.stage === "married" && !tri.jilted && rng() < TRIANGLE_JILT_P) {
        tri.jilted = true;
        const line = pickOne(rng, TRIANGLE_JILTED).replace("{T}", tri.admirerDisplay).replace("{A}", da);
        journalEvent(tri.admirer, line, "romance", a);
        seedRumor({
          kingdomId: bond.kingdomId,
          kind: gossipKinds().wedding,
          subject: tri.admirer,
          subjectDisplay: tri.admirerDisplay,
          text: `took ${da}'s wedding hard. One-sided love is a cruel thing.`,
          holder: a,
        });
        bond.data.triangle = null;
        k.touch(a, b, nowMs);
        continue;
      }
      // Time heals: the admirer moves on.
      if (nowMs - tri.since > TRIANGLE_LIFETIME_MS) {
        journalEvent(tri.admirer, pickOne(rng, TRIANGLE_MOVED_ON).replace("{T}", tri.admirerDisplay), "romance", a);
        bond.data.triangle = null;
        k.touch(a, b, nowMs);
        continue;
      }
      // Pining, throttled by the triangle's own clock.
      if (!tri.lastPineAt || nowMs - tri.lastPineAt > 3 * 24 * 3600 * 1000) {
        tri.lastPineAt = nowMs;
        const line = pickOne(rng, TRIANGLE_PINING).replace("{T}", tri.admirerDisplay).replace("{A}", da);
        journalEvent(tri.admirer, line, "romance", a);
        if (rng() < 0.3) {
          seedRumor({
            kingdomId: bond.kingdomId,
            kind: gossipKinds().wedding,
            subject: tri.admirer,
            subjectDisplay: tri.admirerDisplay,
            text: `has been seen watching ${da}... make of that what you will.`,
            holder: a,
          });
        }
        k.touch(a, b, nowMs);
      }
      continue;
    }

    // Spawn a new triangle (rare).
    if (bond.data.triangleCooldownUntil && nowMs < bond.data.triangleCooldownUntil) continue;
    if (rng() >= TRIANGLE_SPAWN_P) continue;
    const candidates = [];
    for (const [, rec] of roster?.entries?.() ?? []) {
      if (eligibleAdmirer(rec, rec.username, a, b, { bond, hasRomance: (n) => k.hasRomance(n) })) {
        candidates.push(rec);
      }
    }
    if (candidates.length === 0) {
      bond.data.triangleCooldownUntil = nowMs + 7 * 24 * 3600 * 1000;
      continue;
    }
    const admirer = pickOne(rng, candidates);
    const target = rng() < 0.5 ? a : b;
    const rt = roster.get(target);
    bond.data.triangle = {
      admirer: admirer.username,
      admirerDisplay: displayOf(admirer, admirer.username),
      target,
      since: nowMs,
      lastPineAt: 0,
    };
    journalEvent(admirer.username, `I can't stop thinking about ${displayOf(rt, target)}. This is hopeless, and I know it.`, "romance", target);
    k.touch(a, b, nowMs);
  }
}

function tickColdFeet(director, rng, nowMs) {
  const k = kinship();
  if (!k) return;
  const roster = director.roster;
  const WEDDING_WAIT_MS = 20 * 3600 * 1000;
  for (const { a, b, bond } of [...k.bonds.values()]) {
    if (bond.type !== "romance" || bond.stage !== "serious") continue;
    const event = bond.data.event;
    if (!event || event.type !== "wedding" || event.phase !== "announced") continue;
    if (nowMs - event.at >= WEDDING_WAIT_MS) continue; // ceremony already due; too late for doubts
    const ra = roster?.get(a);
    const rb = roster?.get(b);
    const p = coldFeetChance(traitsOf(ra), traitsOf(rb));
    if (rng() >= p) continue;
    // Called off. The couple stays serious; the proposal logic may try again later.
    const da = displayOf(ra, a);
    const db = displayOf(rb, b);
    bond.data.event = null;
    bond.data.coldFeetAt = nowMs;
    k.touch(a, b, nowMs);
    journalEvent(a, `I panicked about the wedding. ${db} deserves better than a coward — I need more time.`, "romance", b);
    journalEvent(b, `${da} called off the wedding. It hurts, but I'd rather wait than rush.`, "romance", a);
    seedRumor({
      kingdomId: bond.kingdomId,
      kind: gossipKinds().wedding,
      subject: a,
      subjectDisplay: `${da} and ${db}`,
      text: pickOne(rng, COLD_FEET_LINES).replace("{A}", da).replace("{B}", db),
      holder: a,
    });
  }
}

// ============================================================================
// Interaction-tier ticks — only when real players are near.
// ============================================================================

function tickPlayerProposals(director, rng, nowMs) {
  pruneCooldowns(nowMs);
  const k = kinship();
  if (!k) return;
  const roster = director.roster;
  for (const [, record] of roster?.entries?.() ?? []) {
    // Cooldown gate (cheapest).
    const last = lastProposalByCitizen.get(record.username) || 0;
    if (nowMs - last < PROPOSAL_COOLDOWN_MS) continue;
    // Must be single.
    try {
      if (k.hasRomance(record.username)) continue;
    } catch {
      continue;
    }
    // Must be materialized and near a real player.
    const bot = botOf(director, record);
    if (!bot) continue;
    const nearby = realPlayersNear(bot, ANNIVERSARY_RADIUS);
    if (nearby.length === 0) continue;
    // Must adore the player.
    const player = nearby[0];
    let playerName = "";
    try {
      playerName = player.getUsername();
    } catch {
      continue;
    }
    if (toneToward(record.username, playerName) < PROPOSAL_TONE_MIN) continue;
    // Rare, and romantic souls propose more.
    const traits = traitsOf(record);
    const romantic = traits.some((t) => ROMANTIC_TRAITS.has(t)) ? 3 : 1;
    if (rng() >= PROPOSAL_P * romantic) continue;
    // Propose — scripted line; the LLM carries the dialogue from the journal.
    const cName = displayOf(record, record.username);
    const kName = record.kingdomId ?? "the realm";
    say(bot, pickOne(rng, PROPOSAL_LINES).replace("{C}", playerName).replace("{K}", kName));
    journalEvent(record.username, `I proposed to ${playerName}. My hands are still shaking.`, "romance", playerName);
    seedRumor({
      kingdomId: record.kingdomId,
      kind: gossipKinds().wedding,
      subject: record.username,
      subjectDisplay: cName,
      text: `proposed to ${playerName}! The whole town is holding its breath!`,
      holder: record.username,
    });
    lastProposalByCitizen.set(record.username, nowMs);
  }
}

function tickWeddingWelcomes(director, rng, nowMs) {
  const k = kinship();
  if (!k) return;
  const roster = director.roster;
  for (const { a, b, bond } of [...k.bonds.values()]) {
    if (bond.type !== "romance") continue;
    const event = bond.data.event;
    if (!event || event.type !== "wedding") continue;
    if (event.phase !== "gather" && event.phase !== "vows" && event.phase !== "cheers") continue;
    if (event.welcomed) continue;
    const ra = roster?.get(a);
    const rb = roster?.get(b);
    const botA = ra ? botOf(director, ra) : null;
    const botB = rb ? botOf(director, rb) : null;
    const anchor = botA ?? botB;
    if (!anchor) continue;
    if (realPlayersNear(anchor, WELCOME_RADIUS).length === 0) continue;
    const da = displayOf(ra, a);
    const db = displayOf(rb, b);
    say(anchor, pickOne(rng, WELCOME_LINES).replace("{A}", da).replace("{B}", db));
    event.welcomed = true;
    k.touch(a, b, nowMs);
  }
}

/**
 * Main entry — called from the director tick BEFORE CitizenKinship.tickKinship.
 * @param {object} director - the CitizenDirector instance
 * @param {object} rng - Math.random or an injected deterministic rng
 * @param {number} nowMs - Date.now()
 */
function tickWeddings(director, rng, nowMs) {
  try {
    tickColdFeet(director, rng, nowMs);
    tickAnniversaries(director, rng, nowMs);
    tickTriangles(director, rng, nowMs);
    tickPlayerProposals(director, rng, nowMs);
    tickWeddingWelcomes(director, rng, nowMs);
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-weddings] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickWeddings,
  // Pure helpers for tests:
  anniversariesDue,
  milestoneName,
  proposalChance,
  coldFeetChance,
  eligibleAdmirer,
  isRealPlayer,
  withinTiles,
  pickOne,
};
