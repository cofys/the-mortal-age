"use strict";

/**
 * CitizenMemory — what each citizen remembers about the players they've met.
 *
 * The brain acts, the gateway talks; this is the part that *remembers*.
 * Per citizen, per player, a small bounded record:
 *
 *   { met, firstMet, lastSeen, tone, spent,
 *     grudge, grudgeAt, grudgeKind,
 *     heard: { subjectKey: { at, kind, severity } },
 *     generosityTier }
 *
 * - met/lastSeen: every interaction is no longer a first impression.
 * - tone: running friendly/rude sum from chat sentiment (heuristic word
 *   lists in scoreTone) plus witnessed behavior.
 * - spent: coins the player has paid at this citizen's stall.
 * - grudge: severity 1-3 (insult/witnessed theft = 1, attack = 3), decaying
 *   linearly to zero over GRUDGE_DECAY_MS. Higher prices, cold greetings,
 *   guards warned — until it's forgotten.
 * - heard: gossip other citizens passed along ("Did you hear what X did?").
 *   News travels holder -> social link, not instantly global.
 *
 * Bounds: MAX_PLAYERS_PER_CITIZEN per citizen (LRU eviction, grudges
 * protected), MAX_GOSSIP active rumors, stale entries pruned on save.
 * Persisted to data/saves/citizen-memory.json (same shape/place as the
 * player-shop saves). Plain-node testable: CitizenMemory.test.js.
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-memory.json");

const MAX_PLAYERS_PER_CITIZEN = 40;
const MAX_GOSSIP = 24;
// Memorable moments per citizen-player pair. Specific things the citizen
// remembers the player doing — "you helped me carry the lumber last week"
// is a real thing now, not just a tone number.
const MAX_MOMENTS = 10;
// Memorable-moment kinds. Positive moments make citizens fond of a player;
// negative ones feed grudges and gossip. New kinds must be added here and
// nowhere else (rule 13: no one-offs).
const MOMENT_MET = "met";
const MOMENT_HELPED = "helped";       // player aided the citizen directly
const MOMENT_GIFT = "gift";           // player gave the citizen something
const MOMENT_FOUGHT_WITH = "fought_with"; // fought beside the citizen
const MOMENT_SAVED = "saved";         // player saved the citizen's life
const MOMENT_TRADED = "traded";       // a notable fair trade
const MOMENT_GENEROUS = "generous";   // big spend at the stall
const MOMENT_WEDDING = "wedding";     // attended the citizen's wedding
const MOMENT_INSULTED = "insulted";   // player insulted the citizen
const MOMENT_BETRAYED = "betrayed";   // player attacked / stole from them
const MOMENT_HELPED_KINGDOM = "helped_kingdom"; // aided the citizen's kingdom

const POSITIVE_MOMENTS = new Set([
  MOMENT_HELPED, MOMENT_GIFT, MOMENT_FOUGHT_WITH, MOMENT_SAVED,
  MOMENT_TRADED, MOMENT_GENEROUS, MOMENT_WEDDING, MOMENT_HELPED_KINGDOM,
]);
const NEGATIVE_MOMENTS = new Set([MOMENT_INSULTED, MOMENT_BETRAYED]);
// A grudge is fully forgotten after this long with no fresh offense.
const GRUDGE_DECAY_MS = 3 * 24 * 3600 * 1000;
// Entries this old with no grudge, no spend and barely any meetings are pruned.
const STALE_ENTRY_MS = 30 * 24 * 3600 * 1000;

// Regulars and favorites: meetings OR lifetime spend at this citizen.
const REGULAR_MIN_MEETINGS = 3;
const REGULAR_MIN_SPENT = 500;
const FAVORITE_MIN_MEETINGS = 10;
const FAVORITE_MIN_SPENT = 5000;

// Generosity gossip fires once per tier of lifetime spend.
const GENEROSITY_TIERS = [1000, 10000, 100000];

// Haggling: a granted discount is one-time (consumed at the next stall
// opening) and a haggle attempt — granted or refused — starts a cooldown
// so players can't farm the stallkeeper for a better price every minute.
const HAGGLE_WINDOW_MS = 30 * 60 * 1000; // granted discount stays valid this long
const HAGGLE_COOLDOWN_MS = 2 * 3600 * 1000; // then the answer stays "no" for this long
const HAGGLE_MAX_PCT = 25;

// Grudge severity by offense.
const GRUDGE_INSULT = 1;
const GRUDGE_THEFT = 1;
const GRUDGE_ATTACK = 3;
const GRUDGE_MAX = 3;

// Gossip kinds.
const GOSSIP_THEFT = "theft";
const GOSSIP_ATTACK = "attack";
const GOSSIP_INSULT = "insult";
const GOSSIP_GENEROSITY = "generosity";
const GOSSIP_OFFICE = "office";
const GOSSIP_WEDDING = "wedding";
const GOSSIP_FEUD = "feud";
const GOSSIP_QUEST = "quest"; // a real player finished a quest — street news

const GOSSIP_HOPS = 3; // max hops: a rumor crosses at most 3 real social ties
const GOSSIP_HOP_MIN_MS = 90 * 1000; // min time between hops
const GOSSIP_MAX_AGE_MS = 6 * 3600 * 1000;
const GOSSIP_SPEAK_COOLDOWN_MS = 10 * 60 * 1000; // per citizen, mirrors realm rumors
// Per event: the same rumor is spoken aloud at most once per ~30 minutes,
// no matter how many citizens end up carrying it.
const GOSSIP_RUMOR_SPEAK_COOLDOWN_MS = 30 * 60 * 1000;

// Citizen-to-citizen street talk. Zero LLM: template lines only, each naming
// the subject (the "street-talk names the subject" invariant). {S} = subject
// display, {T} = rumor text.
const GOSSIP_SPEAK_LINES = {
  wedding: ["Have you heard? {S} {T}", "Did you hear the news? {S} {T}"],
  feud: ["Word is {S} {T}", "Heard about it? {S} {T}"],
  office: ["Big news — {S} {T}", "Did you hear? {S} {T}"],
  quest: ["Did you hear? {S} {T}", "Word travels fast — {S} {T}"],
  default: ["Did you hear what {S} did? {T}", "Word is {S} — {T}"],
};

function gossipSpeakLine(kind, subjectDisplay, text) {
  const pool = GOSSIP_SPEAK_LINES[kind] ?? GOSSIP_SPEAK_LINES.default;
  const tpl = pool[Math.floor(Math.random() * pool.length)];
  return tpl.replace("{S}", subjectDisplay).replace("{T}", text);
}

const FRIENDLY_WORDS = [
  "thank", "thanks", "please", "hello", "hi", "hey", "good", "great",
  "love", "awesome", "nice", "greetings", "bless", "cheers", "kind",
  "sorry", "morning", "evening", "friend", "welcome",
];
const RUDE_WORDS = [
  "idiot", "stupid", "dumb", "shut", "hate", "kill", "die", "trash",
  "worthless", "scam", "scammer", "damn", "hell", "crap", "shit",
  "fuck", "bitch", "asshole", "moron", "ugly", "loser", "pathetic",
];

function normalizeName(name) {
  return String(name ?? "").toLowerCase().trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Heuristic chat sentiment: +1 per friendly word, -2 per rude word,
 * clamped to [-5, +5]. Crude on purpose — the gateway's LLM does nuance;
 * this just needs to catch "thanks!" vs "shut up, idiot".
 */
function scoreTone(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  let score = 0;
  for (const word of words) {
    if (RUDE_WORDS.includes(word)) score -= 2;
    else if (FRIENDLY_WORDS.includes(word)) score += 1;
  }
  return clamp(score, -5, 5);
}

function blankEntry(now) {
  return {
    met: 0,
    firstMet: now,
    lastSeen: now,
    tone: 0,
    spent: 0,
    grudge: 0,
    grudgeAt: 0,
    grudgeKind: null,
    heard: {},
    generosityTier: 0,
    moments: [],
  };
}

/** "yesterday", "3 days ago", "last week" — how a person actually talks. */
function relativeTime(at, now = Date.now()) {
  const mins = Math.max(0, Math.floor((now - at) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "last week";
  if (weeks < 5) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "last month" : `${months} months ago`;
}

/** Effective grudge severity after decay: severity * (1 - elapsed/decay). */
function grudgeLevel(entry, now = Date.now()) {
  if (!entry || entry.grudge <= 0) return 0;
  const elapsed = Math.max(0, now - (entry.grudgeAt || 0));
  if (elapsed >= GRUDGE_DECAY_MS) return 0;
  return entry.grudge * (1 - elapsed / GRUDGE_DECAY_MS);
}

class CitizenMemoryStore {
  constructor() {
    this.citizens = new Map(); // citizenKey -> { display, players: Map(playerKey -> {display, entry}) }
    this.gossip = []; // active rumors
    this.lastGossipSpeakAt = new Map(); // citizenKey -> timestamp
    this.dirty = false;
    this._savePath = SAVE_FILE;
  }

  /** Test seam: keep everything in memory, never touch disk. */
  resetForTests() {
    this.citizens = new Map();
    this.gossip = [];
    this.lastGossipSpeakAt = new Map();
    this.dirty = false;
    this._savePath = null;
  }

  _citizen(citizenName) {
    const key = normalizeName(citizenName);
    let record = this.citizens.get(key);
    if (!record) {
      record = { display: String(citizenName ?? key), players: new Map() };
      this.citizens.set(key, record);
    }
    return record;
  }

  _entry(citizenName, playerName, now = Date.now(), evict = true) {
    const record = this._citizen(citizenName);
    const key = normalizeName(playerName);
    let held = record.players.get(key);
    if (!held) {
      held = { display: String(playerName ?? key), entry: blankEntry(now) };
      record.players.set(key, held);
      if (evict) this._evictIfNeeded(record, now);
    }
    return held.entry;
  }

  /** LRU eviction past the cap; entries with a live grudge are protected. */
  _evictIfNeeded(record, now) {
    while (record.players.size > MAX_PLAYERS_PER_CITIZEN) {
      let victim = null;
      let oldest = Infinity;
      for (const [key, held] of record.players) {
        if (grudgeLevel(held.entry, now) >= 0.5) continue;
        if (held.entry.lastSeen < oldest) {
          oldest = held.entry.lastSeen;
          victim = key;
        }
      }
      if (!victim) break; // everyone holds a grudge — cap bends, grudges don't
      record.players.delete(victim);
    }
  }

  getEntry(citizenName, playerName) {
    const record = this.citizens.get(normalizeName(citizenName));
    return record?.players.get(normalizeName(playerName))?.entry ?? null;
  }

  /** Any interaction counts as a meeting: chat heard, stall opened, trade. */
  recordMeeting(citizenName, playerName, now = Date.now()) {
    const entry = this._entry(citizenName, playerName, now);
    const first = entry.met === 0;
    entry.met += 1;
    entry.lastSeen = now;
    if (first) {
      this.recordMoment(citizenName, playerName, MOMENT_MET, "met for the first time", {}, now);
    }
    this.dirty = true;
    return entry;
  }

  /** Tone delta from chat sentiment or witnessed behavior; clamped. */
  recordTone(citizenName, playerName, delta, now = Date.now()) {
    const entry = this._entry(citizenName, playerName, now);
    entry.tone = clamp(entry.tone + delta, -10, 10);
    entry.lastSeen = now;
    this.dirty = true;
    return entry;
  }

  /**
   * Coins paid at this citizen's stall. Returns the generosity tiers newly
   * crossed (for "generous patron" gossip) — each tier fires once.
   */
  recordSpend(citizenName, playerName, coins, now = Date.now()) {
    const entry = this._entry(citizenName, playerName, now);
    entry.spent += Math.max(0, Math.floor(coins));
    entry.lastSeen = now;
    const crossed = [];
    while (
      entry.generosityTier < GENEROSITY_TIERS.length &&
      entry.spent >= GENEROSITY_TIERS[entry.generosityTier]
    ) {
      entry.generosityTier += 1;
      crossed.push(GENEROSITY_TIERS[entry.generosityTier - 1]);
    }
    if (crossed.length > 0) {
      this.recordMoment(
        citizenName,
        playerName,
        MOMENT_GENEROUS,
        `paid ${entry.spent.toLocaleString("en-US")} coins at my stall — a generous patron`,
        {},
        now
      );
    }
    this.dirty = true;
    return crossed;
  }

  /**
   * Remember an offense. Re-offending refreshes the grudge clock and can
   * escalate severity (up to GRUDGE_MAX); the decay then starts over.
   */
  addGrudge(citizenName, playerName, severity, kind, now = Date.now()) {
    // Create without evicting: a fresh grudge must survive its own birth.
    const entry = this._entry(citizenName, playerName, now, false);
    const sev = clamp(Math.floor(severity), 1, GRUDGE_MAX);
    // A worse offense escalates; a repeat of the same refreshes the clock.
    entry.grudge = Math.min(GRUDGE_MAX, Math.max(entry.grudge, sev));
    entry.grudgeAt = now;
    entry.grudgeKind = kind ?? entry.grudgeKind;
    entry.tone = clamp(entry.tone - sev * 2, -10, 10);
    entry.met += 1; // an offense is an interaction — they remember the face
    entry.lastSeen = now;
    // The offense becomes a specific memory, not just a number.
    const kindText = sev >= 3 ? "attacked me" : kind === "theft" ? "stole from me" : "wronged me";
    this.recordMoment(citizenName, playerName, MOMENT_BETRAYED, kindText, { pinned: sev >= 3 }, now);
    this._evictIfNeeded(this._citizen(citizenName), now); // grudge now protects it
    this.dirty = true;
    return entry;
  }

  /** Second-hand news: this citizen heard what the subject did. */
  heardAbout(citizenName, subjectName, kind, severity = 1, now = Date.now()) {
    const entry = this._entry(citizenName, subjectName, now);
    entry.heard[normalizeName(subjectName)] = {
      at: now,
      kind: kind ?? "rumor",
      severity: clamp(severity, 0, GRUDGE_MAX),
    };
    this.dirty = true;
    return entry;
  }

  /** Has this citizen heard (first- or second-hand) about the subject? */
  hasHeard(citizenName, subjectName) {
    const entry = this.getEntry(citizenName, subjectName);
    return !!entry?.heard?.[normalizeName(subjectName)];
  }

  /**
   * Remember something specific the player did. Text should read like a
   * person recalling it: "helped me carry the lumber to the market".
   * Bounded per pair (oldest non-pinned moments drop off); exact
   * duplicates within a day are ignored.
   */
  recordMoment(citizenName, playerName, kind, text, opts = {}, now = Date.now()) {
    const entry = this._entry(citizenName, playerName, now);
    if (!Array.isArray(entry.moments)) entry.moments = [];
    const clean = String(text ?? "").trim().slice(0, 140);
    if (!clean) return entry;
    const recentDup = entry.moments.some(
      (m) => m.text === clean && now - m.at < 24 * 3600 * 1000
    );
    if (recentDup) {
      entry.lastSeen = now;
      return entry;
    }
    entry.moments.push({
      at: now,
      kind: kind ?? MOMENT_HELPED,
      text: clean,
      pinned: !!opts.pinned, // pinned moments (weddings, saves) survive eviction
    });
    while (entry.moments.length > MAX_MOMENTS) {
      const idx = entry.moments.findIndex((m) => !m.pinned);
      if (idx < 0) break;
      entry.moments.splice(idx, 1);
    }
    if (POSITIVE_MOMENTS.has(kind)) entry.tone = clamp(entry.tone + 1, -10, 10);
    if (NEGATIVE_MOMENTS.has(kind)) entry.tone = clamp(entry.tone - 1, -10, 10);
    entry.lastSeen = now; // callers (meeting, grudge, spend) count the interaction
    this.dirty = true;
    return entry;
  }

  /**
   * What this citizen remembers the player doing, in their own voice:
   * "You remember specific things about this person: they helped you carry
   * the lumber to the market (last week); they paid 1,200 coins at your
   * stall (2 days ago)."
   * Returns null when there's nothing specific to recall.
   */
  momentLine(citizenName, playerName, now = Date.now(), max = 2) {
    const entry = this.getEntry(citizenName, playerName);
    const moments = entry?.moments;
    if (!Array.isArray(moments) || moments.length === 0) return null;
    const shown = moments.slice(-max).reverse();
    const bits = shown.map((m) => `${m.text} (${relativeTime(m.at, now)})`);
    return `You remember specific things about this person: ${bits.join("; ")}.`;
  }

  /**
   * The citizen's opinion of the player in one plain sentence — WHY they
   * feel the way they do, not just the standing word. The LLM speaks from
   * this; behavior modules read standing() for mechanics.
   */
  opinionLine(citizenName, playerName, now = Date.now()) {
    const entry = this.getEntry(citizenName, playerName);
    if (!entry || entry.met === 0) return null;
    const standing = this.standing(citizenName, playerName, now);
    const display = entry.display ?? playerName;
    const eff = grudgeLevel(entry, now);
    const moments = Array.isArray(entry.moments) ? entry.moments : [];
    const lastGood = [...moments].reverse().find((m) => POSITIVE_MOMENTS.has(m.kind));
    const lastBad = [...moments].reverse().find((m) => NEGATIVE_MOMENTS.has(m.kind));
    switch (standing) {
      case "hostile":
        return (
          `You despise ${display}. ` +
          (lastBad
            ? `You will never forget: ${lastBad.text} (${relativeTime(lastBad.at, now)}).`
            : "What they did is unforgivable.")
        );
      case "cold":
        return (
          `You distrust ${display}. ` +
          (eff >= 0.5
            ? `They wronged you and you haven't forgotten.`
            : "They rub you the wrong way.")
        );
      case "favorite":
        return (
          `${display} is one of your favorite people. ` +
          (lastGood
            ? `You remember: ${lastGood.text} (${relativeTime(lastGood.at, now)}).`
            : "They've been nothing but kind to you.")
        );
      case "regular":
        return `You know ${display} well and think fondly of them.`;
      case "warm":
        return `You like ${display}.`;
      default:
        return null;
    }
  }

  /**
   * How this citizen feels about the player right now:
   * hostile > cold > favorite > regular > warm > neutral.
   * Grudges outrank loyalty — a favorite who attacks is still hostile.
   */
  standing(citizenName, playerName, now = Date.now()) {
    const entry = this.getEntry(citizenName, playerName);
    if (!entry || entry.met === 0) return "neutral";
    const eff = grudgeLevel(entry, now);
    if (eff >= 1.5) return "hostile";
    if (eff >= 0.5 || entry.tone <= -4) return "cold";
    if (entry.met >= FAVORITE_MIN_MEETINGS || entry.spent >= FAVORITE_MIN_SPENT)
      return "favorite";
    if (entry.met >= REGULAR_MIN_MEETINGS || entry.spent >= REGULAR_MIN_SPENT)
      return "regular";
    if (entry.tone >= 3) return "warm";
    return "neutral";
  }

  /**
   * Merchant price multiplier for this player: favorites and regulars get
   * a small loyalty discount; grudges pay a surcharge. 1.0 = list price.
   */
  priceMultiplier(citizenName, playerName, now = Date.now()) {
    const entry = this.getEntry(citizenName, playerName);
    if (!entry) return 1.0;
    const eff = grudgeLevel(entry, now);
    if (eff >= 1.5) return 1.5;
    if (eff >= 0.5) return 1.25;
    const standing = this.standing(citizenName, playerName, now);
    if (standing === "favorite") return 0.9;
    if (standing === "regular") return 0.95;
    return 1.0;
  }

  /**
   * Haggling, decided data-tier in CitizenChat and voiced by the LLM.
   * A grant is a one-time discount: recordHaggle stores it, haggleDiscount
   * reads it, consumeHaggle spends it (called when the stall opens).
   * Every attempt — granted or refused — stamps haggleAt, which starts the
   * cooldown during which further haggling is refused outright.
   */
  recordHaggle(citizenName, playerName, discountPct, now = Date.now()) {
    const entry = this._entry(citizenName, playerName, now);
    entry.haggle = {
      pct: clamp(Math.floor(discountPct), 1, HAGGLE_MAX_PCT),
      at: now,
    };
    entry.haggleAt = now;
    entry.lastSeen = now;
    this.dirty = true;
    return entry;
  }

  /** Stamp a refused (or decided) haggle attempt — starts the cooldown. */
  recordHaggleAttempt(citizenName, playerName, now = Date.now()) {
    const entry = this._entry(citizenName, playerName, now);
    entry.haggleAt = now;
    entry.lastSeen = now;
    this.dirty = true;
    return entry;
  }

  /** Pending one-time discount pct (0 when none or expired). */
  haggleDiscount(citizenName, playerName, now = Date.now()) {
    const entry = this.getEntry(citizenName, playerName);
    const h = entry?.haggle;
    if (!h || !Number.isFinite(h.pct) || h.pct <= 0) return 0;
    if (now - h.at > HAGGLE_WINDOW_MS) return 0;
    return h.pct;
  }

  /** Spend the pending discount. Returns the pct that was applied (0 if none). */
  consumeHaggle(citizenName, playerName, now = Date.now()) {
    const pct = this.haggleDiscount(citizenName, playerName, now);
    const entry = this.getEntry(citizenName, playerName);
    if (entry && entry.haggle) {
      entry.haggle = null;
      this.dirty = true;
    }
    return pct;
  }

  /** True while the haggle cooldown is running (attempts refused). */
  hasHaggledRecently(citizenName, playerName, now = Date.now()) {
    const entry = this.getEntry(citizenName, playerName);
    if (!entry?.haggleAt) return false;
    return now - entry.haggleAt < HAGGLE_COOLDOWN_MS;
  }

  /**
   * The worst any citizen thinks of this player: max effective grudge, with
   * second-hand gossip counting at half weight. Guards use this for the
   * "we've been warned about you" challenge; merchants for cold shoulders.
   */
  notoriety(playerName, now = Date.now()) {
    const key = normalizeName(playerName);
    let worst = 0;
    for (const record of this.citizens.values()) {
      const held = record.players.get(key);
      if (!held) continue;
      worst = Math.max(worst, grudgeLevel(held.entry, now));
      const heard = held.entry.heard?.[key];
      if (heard) worst = Math.max(worst, (heard.severity ?? 1) * 0.5);
    }
    return worst;
  }

  // --- greetings ---------------------------------------------------------

  greetingFor(citizenName, playerName, now = Date.now()) {
    const standing = this.standing(citizenName, playerName, now);
    const name = this._displayPlayer(citizenName, playerName);
    switch (standing) {
      case "hostile":
        return pick([
          `You. Make it quick, ${name} — you're not welcome here.`,
          `${name}. I remember what you did. Watch yourself.`,
        ]);
      case "cold":
        return pick([
          `Oh. It's you, ${name}.`,
          `${name}. What do you want?`,
        ]);
      case "favorite":
        return pick([
          `Welcome back, ${name}! The good stock's set aside for you.`,
          `${name}! Always a pleasure. First pick of today's wares, as ever.`,
        ]);
      case "regular":
        return pick([
          `Back again, ${name}? Good to see you.`,
          `Welcome back, ${name}.`,
        ]);
      case "warm":
        return pick([`Good to see you, ${name}.`, `Well met, ${name}.`]);
      default:
        return null; // strangers get the merchant's usual patter, not a greeting
    }
  }

  _displayPlayer(citizenName, playerName) {
    const held = this.citizens
      .get(normalizeName(citizenName))
      ?.players.get(normalizeName(playerName));
    return held?.display ?? String(playerName ?? "");
  }

  // --- gossip ------------------------------------------------------------

  /**
   * Seed a rumor: notable player action (theft, generosity, office win).
   * The seed holder "knows" immediately; spreadGossipTick walks it along
   * social links on the director tick.
   */
  seedGossip({ kingdomId, kind, subject, subjectDisplay, victim, text, holder }) {
    if (this.gossip.length >= MAX_GOSSIP) this.gossip.shift();
    const now = Date.now();
    const entry = {
      id: `${now}-${Math.floor(Math.random() * 1e6)}`,
      kingdomId,
      kind,
      subject: normalizeName(subject),
      subjectDisplay: subjectDisplay ?? String(subject ?? ""),
      victimDisplay: victim ?? null,
      text: String(text ?? "").slice(0, 160),
      holder: normalizeName(holder),
      holderDisplay: String(holder ?? ""),
      hops: GOSSIP_HOPS,
      createdAt: now,
      lastHopAt: now,
      lastSpokeAt: 0, // per-event speak cooldown (persisted with the rumor)
    };
    this.gossip.push(entry);
    // The seed holder saw it first-hand — they "heard" it too.
    if (holder) this.heardAbout(holder, subjectDisplay ?? subject, kind, 1, now);
    this.dirty = true;
    return entry;
  }

  /**
   * Deterministic social links: up to N other citizens of the same kingdom
   * this citizen gossips with. Pure function of names — no storage, and the
   * same links every time, so news genuinely travels a network.
   */
  socialLinks(citizenName, kingdomUsernames, count = 5) {
    const self = normalizeName(citizenName);
    const others = (kingdomUsernames ?? [])
      .map((n) => String(n))
      .filter((n) => normalizeName(n) !== self);
    if (others.length === 0) return [];
    // Seeded shuffle by citizen name so links are stable.
    let seed = 0;
    for (const ch of self) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const shuffled = [...others];
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, Math.max(1, Math.min(count, shuffled.length)));
  }

  /**
   * Real social ties for gossip: the holder's kinship bonds (friends, close
   * friends, lovers — never feuds) plus their adventuring party, deduped.
   * Returns [] when the holder has no real ties (or isn't a citizen at all,
   * e.g. the office-herald seed holders); the caller falls back to the
   * deterministic socialLinks in that case. News genuinely travels the
   * relationship graph now, not a pseudo-random shuffle.
   *
   * Lazy requires, all guarded: this module sits below CitizenKinship in the
   * load graph, so these must never run at require time.
   */
  bondedGossipLinks(holderName) {
    const out = [];
    const seen = new Set();
    const self = normalizeName(holderName);
    if (!self) return out;
    const push = (n) => {
      const k = normalizeName(n);
      if (!k || k === self || seen.has(k)) return;
      seen.add(k);
      out.push(n);
    };
    try {
      const { getKinship } = require("./CitizenKinship");
      for (const { other, bond } of getKinship().of(holderName) ?? []) {
        if (!bond || bond.type === "feud") continue; // feuds don't pass news
        push(other);
      }
    } catch {
      // Kinship unavailable: party/fallback still work.
    }
    try {
      const { getParty } = require("./CitizenBonds");
      const party = getParty(holderName);
      for (const m of party?.members ?? []) push(m);
    } catch {
      // Party unavailable: fallback still works.
    }
    return out;
  }

  /**
   * One gossip-propagation step (called on the director's ~60s tick).
   * deps: { kingdomMembers: Map(kingdomId -> [username]),
   *         isOnline(username) -> bool, botFor(username) -> player|null }
   * Returns [{ speaker, line }] for citizens who said the rumor aloud.
   *
   * Pacing (all zero-LLM): rumors hop along the holder's REAL social ties
   * (kinship bonds, then party, then deterministic fallback links), at most
   * 3 hops; each rumor is spoken aloud at most once per ~30 minutes; and
   * server-wide at most one rumor is spoken per tick (≤60/hr worst case).
   * Rumors that don't get to speak still hop silently through memory.
   */
  spreadGossipTick(deps, now = Date.now()) {
    const spoken = [];
    const { kingdomMembers, isOnline, botFor } = deps ?? {};
    if (!kingdomMembers) return spoken;
    const live = [];
    let spokeThisTick = false;
    for (const rumor of this.gossip) {
      if (now - rumor.createdAt > GOSSIP_MAX_AGE_MS || rumor.hops <= 0) continue;
      live.push(rumor);
      if (now - rumor.lastHopAt < GOSSIP_HOP_MIN_MS) continue;
      if (Math.random() > 0.6) continue;
      const members = kingdomMembers.get(rumor.kingdomId) ?? [];
      const holderName = rumor.holderDisplay || rumor.holder;
      // Real ties first: the holder tells their bonded friends and party.
      // Holders with no ties (or non-citizen seed holders) fall back to the
      // deterministic social links so every rumor can still travel.
      const tied = this.bondedGossipLinks(holderName);
      const links =
        tied.length > 0 ? tied : this.socialLinks(holderName, members);
      if (links.length === 0) continue;
      const next = links[Math.floor(Math.random() * links.length)];
      // The link hears it — second-hand memory, even if they're offline.
      this.heardAbout(next, rumor.subjectDisplay, rumor.kind, 1, now);
      rumor.holder = normalizeName(next);
      rumor.holderDisplay = next;
      rumor.hops -= 1;
      rumor.lastHopAt = now;
      this.dirty = true;
      // ...and if they're around, they say it where players can hear.
      if (
        !spokeThisTick &&
        isOnline?.(next) &&
        now - (rumor.lastSpokeAt ?? 0) >= GOSSIP_RUMOR_SPEAK_COOLDOWN_MS &&
        now - (this.lastGossipSpeakAt.get(rumor.holder) ?? 0) >= GOSSIP_SPEAK_COOLDOWN_MS
      ) {
        const bot = botFor?.(next);
        const line = gossipSpeakLine(rumor.kind, rumor.subjectDisplay, rumor.text);
        try {
          bot?.forceChat?.(line.slice(0, 160));
          rumor.lastSpokeAt = now; // per-event ~30min cooldown, persisted
          this.lastGossipSpeakAt.set(rumor.holder, now);
          this.dirty = true;
          spokeThisTick = true;
          spoken.push({ speaker: next, line });
        } catch {
          // A silent citizen still spread the word.
        }
      }
    }
    this.gossip = live;
    return spoken;
  }

  // --- persistence -------------------------------------------------------

  toJSON() {
    const citizens = {};
    for (const [key, record] of this.citizens) {
      const players = {};
      for (const [pkey, held] of record.players) {
        players[pkey] = { display: held.display, ...held.entry };
      }
      citizens[key] = { display: record.display, players };
    }
    return { version: 1, citizens, gossip: this.gossip };
  }

  load() {
    if (!this._savePath) return false;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this._savePath, "utf8"));
    } catch {
      return false; // first boot: no save yet
    }
    try {
      this.citizens = new Map();
      for (const [key, record] of Object.entries(parsed?.citizens ?? {})) {
        const players = new Map();
        for (const [pkey, data] of Object.entries(record?.players ?? {})) {
          const { display, ...entry } = data ?? {};
          players.set(pkey, {
            display: display ?? pkey,
            entry: { ...blankEntry(0), ...entry, heard: entry.heard ?? {} },
          });
        }
        this.citizens.set(key, { display: record?.display ?? key, players });
      }
      this.gossip = Array.isArray(parsed?.gossip) ? parsed.gossip : [];
      this.prune(Date.now());
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  /** Drop stale entries so the file stays bounded across months of play. */
  prune(now = Date.now()) {
    for (const record of this.citizens.values()) {
      for (const [pkey, held] of [...record.players]) {
        const e = held.entry;
        const stale =
          now - e.lastSeen > STALE_ENTRY_MS &&
          grudgeLevel(e, now) <= 0 &&
          e.spent < 100 &&
          e.met < 3;
        if (stale) record.players.delete(pkey);
      }
      // Enforce the cap on load too (saves from older builds).
      this._evictIfNeeded(record, now);
    }
    this.gossip = this.gossip.filter(
      (g) => now - (g.createdAt ?? 0) <= GOSSIP_MAX_AGE_MS
    );
    while (this.gossip.length > MAX_GOSSIP) this.gossip.shift();
  }

  /**
   * Drop all memory data for a citizen who no longer exists (refugee
   * column stood down, war casualty). Prevents orphaned records from
   * accumulating across wars. Memory-leak plug, 2026-10-07.
   */
  forget(citizenName) {
    const key = normalizeName(citizenName);
    if (this.citizens.delete(key)) this.dirty = true;
  }

  saveIfDirty() {
    if (!this.dirty || !this._savePath) return false;
    try {
      this.prune(Date.now());
      fs.mkdirSync(path.dirname(this._savePath), { recursive: true });
      fs.writeFileSync(this._savePath, JSON.stringify(this.toJSON(), null, 2));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }
}

function pick(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}

let singleton = null;

/** Process-global store; initCitizenMemory loads the save at plugin boot. */
function getMemory() {
  if (!singleton) singleton = new CitizenMemoryStore();
  return singleton;
}

function initCitizenMemory() {
  const memory = getMemory();
  memory.load();
  return memory;
}

module.exports = {
  CitizenMemoryStore,
  getMemory,
  initCitizenMemory,
  scoreTone,
  grudgeLevel,
  normalizeName,
  relativeTime,
  MAX_PLAYERS_PER_CITIZEN,
  MAX_MOMENTS,
  GRUDGE_DECAY_MS,
  GRUDGE_INSULT,
  GRUDGE_THEFT,
  GRUDGE_ATTACK,
  GOSSIP_THEFT,
  GOSSIP_ATTACK,
  GOSSIP_INSULT,
  GOSSIP_GENEROSITY,
  GOSSIP_OFFICE,
  GOSSIP_WEDDING,
  GOSSIP_FEUD,
  GOSSIP_QUEST,
  MOMENT_MET,
  MOMENT_HELPED,
  MOMENT_GIFT,
  MOMENT_FOUGHT_WITH,
  MOMENT_SAVED,
  MOMENT_TRADED,
  MOMENT_GENEROUS,
  MOMENT_WEDDING,
  MOMENT_INSULTED,
  MOMENT_BETRAYED,
  MOMENT_HELPED_KINGDOM,
};
