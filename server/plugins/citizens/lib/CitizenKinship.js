"use strict";

/**
 * CitizenKinship — citizens have real relationships with each other.
 *
 * Until now every citizen bond pointed at the player: friends, enemies,
 * parties, invites. But Jon's locked law is "every person is real", and
 * real people have lives with each other — not just with whoever walks by.
 * This module is the citizen-to-citizen social fabric:
 *
 *   FRIENDS:  citizens who share a city and get along become friends
 *              (trait-compat weighted), deepening to "close" over time.
 *   ROMANCE:   single citizens can start courting, go serious, and get
 *              MARRIED — a real ceremony at the kingdom square with guests,
 *              vows, cheers, journal entries and gossip. Married life is
 *              journaled; spouses show up in each other's chat context.
 *   FEUDS:     clashing personalities spark feuds (cold -> bitter -> open).
 *              Open feuds mean public shouting matches when both are near,
 *              cold shoulders in citizen chatter, and gossip. Feuds can be
 *              reconciled — stubborn traits make it slower.
 *
 * Two-tier as always: everything runs on the director tick as pure data
 * (zero LLM). The foreground reads it — chat context mentions spouses and
 * feuds, gossip carries wedding/feud news to players, ceremonies are
 * visible through forceChat where players can see them.
 *
 * Bonds: pair-keyed "a|b" (sorted, normalized). One romance per citizen
 * (married is for life), max 12 bonds per citizen. Persisted to
 * data/saves/citizen-kin.json alongside citizen-bonds.json.
 */

const fs = require("fs");
const path = require("path");
const { agentRng, chance } = require("./humanizer");
const { ROLE_MERCHANT } = require("../constants");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-kin.json");
const MAX_BONDS_PER_CITIZEN = 12;

// --- bond types & stages -------------------------------------------------
const BOND_FRIEND = "friend";   // stages: friend -> close
const BOND_ROMANCE = "romance"; // stages: courting -> serious -> married
const BOND_FEUD = "feud";       // stages: cold -> bitter -> open

const STAGES = Object.freeze({
  [BOND_FRIEND]: ["friend", "close"],
  [BOND_ROMANCE]: ["courting", "serious", "married"],
  [BOND_FEUD]: ["cold", "bitter", "open"],
});

// --- pacing (director tick ~= 60s) ----------------------------------------
const FORM_FRIEND_P = 0.0009;   // per pair per tick, x compat
const FORM_ROMANCE_P = 0.00006; // per pair per tick, x compat (rare)
const FORM_FEUD_P = 0.00012;    // per pair per tick, x clash
const SAME_ROLE_BONUS = 1.6;    // shared routines breed friendship

const FRIEND_CLOSE_AGE_MS = 2 * 24 * 3600 * 1000;
const FRIEND_CLOSE_P = 0.002;
const COURTING_AGE_MS = 3 * 24 * 3600 * 1000;
const COURTING_DEEPEN_P = 0.004;
const SERIOUS_AGE_MS = 4 * 24 * 3600 * 1000;
const FEUD_ESCALATE_AGE_MS = 1 * 24 * 3600 * 1000;
const FEUD_ESCALATE_P = 0.01;
const RECONCILE_P = 0.004; // x trait modifier
const DOMESTIC_P = 0.001;  // married-life journal flavor

// Wedding event machine: announced -> gather -> vows -> cheers -> done.
const WEDDING_WAIT_MS = 20 * 3600 * 1000;     // announcement -> ceremony
const WEDDING_MAX_WAIT_MS = 72 * 3600 * 1000; // then marry quietly, no crowd
const ARGUE_COOLDOWN_MS = 30 * 60 * 1000;
const ARGUE_RANGE = 15;
const MAX_WEDDING_GUESTS = 6;

// --- flavor ---------------------------------------------------------------
const VOWS_A = [
  "I promise to share my bread and my blanket, in winter and in war.",
  "By the square and all who gather here — I choose you, today and always.",
  "You're the best thing this city ever gave me. I'm yours.",
  "I'll mend your nets and you'll mend my temper. Deal?",
  "Through lean harvests and fat ones — I stand with you.",
];
const VOWS_B = [
  "And I choose you. Even when you snore.",
  "I promise the same — bread, blanket, and all my tomorrows.",
  "Deal. You're stuck with me now.",
  "Then it's settled. My heart's been yours for months.",
  "Always. Now let's feast before the bread goes stale.",
];
const CHEERS = [
  "To the happy couple!",
  "About time, you two!",
  "May your hearth always be warm!",
  "Blessings on you both!",
  "Another round for the happy couple!",
  "The square hasn't seen a joy like this in years!",
];
const ARGUE_LINES = [
  "You short-changed me at the market and you know it, {B}!",
  "Stay out of my way, {B}. I've no patience for liars today.",
  "Everyone knows you water the ale, {B}. Everyone.",
  "You call that craftsmanship? My grandmother carves better, {B}.",
  "{B}, if you eye my stall once more I'll— ugh. Forget it.",
  "Cheat! I'd rather trade with a goblin than with you, {B}.",
  "You spread lies about my prices, {B}. Take it back!",
];
const DOMESTIC_LINES = [
  "Spent a quiet evening with {S}.",
  "{S} saved the last loaf for me. Small things.",
  "Mended {S}'s cloak by lamplight.",
  "Walked home with {S} under the stars.",
  "Argued with {S} about whose turn it is to fetch water. Made up.",
  "{S} hummed while cooking. The whole house smelled of stew.",
];

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function pairKey(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// --- trait chemistry -------------------------------------------------------
const WARM_TRAITS = new Set(["chatty", "cheerful", "easygoing", "devout"]);
const COLD_TRAITS = new Set(["gruff", "suspicious", "taciturn", "greedy"]);

/** 0..1 — how naturally two citizens become friends/lovers. */
function compatScore(traitsA, traitsB) {
  const a = Array.isArray(traitsA) ? traitsA : [];
  const b = Array.isArray(traitsB) ? traitsB : [];
  const setB = new Set(b);
  let s = 0.45;
  for (const t of a) if (setB.has(t)) s += 0.18;
  const aWarm = a.some((t) => WARM_TRAITS.has(t));
  const bWarm = b.some((t) => WARM_TRAITS.has(t));
  const aCold = a.some((t) => COLD_TRAITS.has(t));
  const bCold = b.some((t) => COLD_TRAITS.has(t));
  if (aWarm && bWarm) s += 0.15;
  if (aCold && bCold) s += 0.08;
  if ((aWarm && bCold) || (bWarm && aCold)) s -= 0.12;
  return clamp01(s);
}

/** 0..1 — how likely two citizens are to spark a feud. */
function clashScore(traitsA, traitsB) {
  const a = Array.isArray(traitsA) ? traitsA : [];
  const b = Array.isArray(traitsB) ? traitsB : [];
  let s = 0.3;
  if (a.includes("greedy") || b.includes("greedy")) s += 0.2;
  if (a.includes("proud") && b.includes("proud")) s += 0.25;
  if (a.includes("gruff") && b.includes("gruff")) s += 0.15;
  if (a.includes("suspicious") || b.includes("suspicious")) s += 0.1;
  return clamp01(s);
}

/** Reconciliation speed multiplier from personality. */
function reconcileMod(traits) {
  const t = Array.isArray(traits) ? traits : [];
  let m = 1;
  if (t.includes("proud")) m *= 0.4;
  if (t.includes("gruff")) m *= 0.6;
  if (t.includes("suspicious")) m *= 0.7;
  if (t.includes("easygoing")) m *= 1.8;
  if (t.includes("cheerful")) m *= 1.4;
  return m;
}

/**
 * 0..1 — how likely a serious couple is to actually propose.
 * Romantic/warm souls propose readily; shy/gruff pairs often stay
 * "serious" forever, happy as they are.
 */
function proposalChance(traitsA, traitsB) {
  const t = new Set([...(traitsA ?? []), ...(traitsB ?? [])]);
  let p = 0.55;
  for (const r of ["devout", "cheerful", "chatty", "easygoing"]) if (t.has(r)) p += 0.12;
  for (const s of ["taciturn", "suspicious"]) if (t.has(s)) p -= 0.18;
  if (t.has("gruff")) p -= 0.12;
  return Math.min(0.95, Math.max(0.05, p));
}

// --- data layer ------------------------------------------------------------
function blankBond(type, stage, kingdomId, now) {
  return {
    type,
    stage,
    kingdomId: kingdomId ?? null,
    since: now,
    updatedAt: now,
    data: {}, // event machine state lives here (weddings, argue cooldowns)
  };
}

class CitizenKinshipStore {
  constructor() {
    this.bonds = new Map(); // pairKey -> { a, b, bond }
    this.dirty = false;
    this._savePath = SAVE_FILE;
  }

  /** Test seam: clear without touching disk. */
  resetForTests() {
    this.bonds = new Map();
    this.dirty = false;
  }

  load() {
    try {
      if (!fs.existsSync(this._savePath)) return;
      const raw = JSON.parse(fs.readFileSync(this._savePath, "utf8"));
      if (!raw || typeof raw !== "object") return;
      for (const [key, bond] of Object.entries(raw)) {
        if (!bond || typeof bond !== "object") continue;
        if (!STAGES[bond.type] || !STAGES[bond.type].includes(bond.stage)) continue;
        const [a, b] = String(key).split("|");
        if (!a || !b) continue;
        this.bonds.set(key, { a, b, bond });
      }
    } catch {
      // Corrupt save -> start clean. Never break boot on a save file.
    }
  }

  save() {
    if (!this.dirty) return false;
    try {
      fs.mkdirSync(path.dirname(this._savePath), { recursive: true });
      const out = {};
      for (const [key, { bond }] of this.bonds) out[key] = bond;
      fs.writeFileSync(this._savePath, JSON.stringify(out));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  saveIfDirty() {
    return this.save();
  }

  _loaded() {
    if (this._everLoaded) return;
    this._everLoaded = true;
    this.load();
  }

  get(a, b) {
    this._loaded();
    const rec = this.bonds.get(pairKey(a, b));
    return rec ?? null;
  }

  /** All bonds for one citizen: [{ other, bond }]. */
  of(name) {
    this._loaded();
    const key = normalizeName(name);
    const out = [];
    for (const { a, b, bond } of this.bonds.values()) {
      if (a === key) out.push({ other: b, bond });
      else if (b === key) out.push({ other: a, bond });
    }
    return out;
  }

  count(name) {
    return this.of(name).length;
  }

  hasRomance(name) {
    return this.of(name).some(({ bond }) => bond.type === BOND_ROMANCE);
  }

  /**
   * Add a bond. Enforces: no self-bonds, per-citizen cap, one romance
   * per citizen (married is for life). Returns the record or null.
   */
  add(a, b, type, stage, kingdomId, now = Date.now()) {
    this._loaded();
    const x = normalizeName(a);
    const y = normalizeName(b);
    if (!x || !y || x === y) return null;
    if (!STAGES[type] || !STAGES[type].includes(stage)) return null;
    if (this.bonds.has(pairKey(x, y))) return null;
    if (this.count(x) >= MAX_BONDS_PER_CITIZEN) return null;
    if (this.count(y) >= MAX_BONDS_PER_CITIZEN) return null;
    if (type === BOND_ROMANCE && (this.hasRomance(x) || this.hasRomance(y))) return null;
    const rec = { a: x, b: y, bond: blankBond(type, stage, kingdomId, now) };
    this.bonds.set(pairKey(x, y), rec);
    this.dirty = true;
    return rec;
  }

  remove(a, b) {
    this._loaded();
    const ok = this.bonds.delete(pairKey(a, b));
    if (ok) this.dirty = true;
    return ok;
  }

  /**
   * Drop every bond involving a citizen who no longer exists (refugee
   * column stood down, war casualty). Prevents orphaned pair-keys from
   * accumulating across wars. Memory-leak plug, 2026-10-07.
   */
  forgetCitizen(name) {
    this._loaded();
    const key = normalizeName(name);
    if (!key) return 0;
    let removed = 0;
    for (const [pair, rec] of this.bonds) {
      if (rec.a === key || rec.b === key) {
        this.bonds.delete(pair);
        removed += 1;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  setStage(a, b, stage, now = Date.now()) {
    this._loaded();
    const rec = this.bonds.get(pairKey(a, b));
    if (!rec || !STAGES[rec.bond.type].includes(stage)) return false;
    rec.bond.stage = stage;
    rec.bond.updatedAt = now;
    this.dirty = true;
    return true;
  }

  touch(a, b, now = Date.now()) {
    const rec = this.bonds.get(pairKey(a, b));
    if (rec) {
      rec.bond.updatedAt = now;
      this.dirty = true;
    }
  }
}

// --- singleton -------------------------------------------------------------
let _store = null;
function getKinship() {
  if (!_store) _store = new CitizenKinshipStore();
  return _store;
}
function resetKinshipForTests() {
  _store = new CitizenKinshipStore();
  _store.resetForTests();
}

// Lazy singletons (avoid load-order cycles with the director).
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
function journal() {
  try {
    return require("./CitizenJournal").getJournal();
  } catch {
    return null;
  }
}
function kingdomName(kingdomId) {
  try {
    const KingdomStore = require("../kingdoms/KingdomStore");
    return KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
  } catch {
    return kingdomId;
  }
}
function atWar(kingdomId) {
  try {
    return require("../CitizenEvents").isKingdomAtWar(kingdomId) === true;
  } catch {
    return false;
  }
}
function squareTile(kingdomId) {
  try {
    return require("../brain/CitizenSites").siteTileByKingdom(kingdomId, "square");
  } catch {
    return null;
  }
}

// --- queries ---------------------------------------------------------------
/** Display name for messages: record display or the raw username. */
function displayOf(record, username) {
  return record?.displayName ?? record?.personality?.name ?? username;
}

function spouseOf(name) {
  const hit = getKinship().of(name).find(
    ({ bond }) => bond.type === BOND_ROMANCE && bond.stage === "married"
  );
  return hit ? hit.other : null;
}

function partnerOf(name) {
  const hit = getKinship().of(name).find(({ bond }) => bond.type === BOND_ROMANCE);
  return hit ? { other: hit.other, stage: hit.bond.stage } : null;
}

function isOpenFeud(a, b) {
  const rec = getKinship().get(a, b);
  return !!rec && rec.bond.type === BOND_FEUD && rec.bond.stage === "open";
}

/**
 * One-line kinship summary for the LLM chat context (token-lean).
 * The citizen talks about their spouse, their sweetheart, their close
 * friends — and goes cold on their feud. That's what real people do.
 */
function kinSummary(name, roster) {
  const parts = [];
  const get = (u) => roster?.get?.(normalizeName(u)) ?? null;
  const spouse = spouseOf(name);
  if (spouse) {
    parts.push(`You are married to ${displayOf(get(spouse), spouse)}.`);
  } else {
    const partner = partnerOf(name);
    if (partner) {
      const word = partner.stage === "serious" ? "engaged to" : "courting";
      parts.push(`You are ${word} ${displayOf(get(partner.other), partner.other)}.`);
    }
  }
  const close = getKinship()
    .of(name)
    .filter(({ bond }) => bond.type === BOND_FRIEND && bond.stage === "close")
    .slice(0, 2)
    .map(({ other }) => displayOf(get(other), other));
  if (close.length > 0) parts.push(`You are close friends with ${close.join(" and ")}.`);
  const feuds = getKinship()
    .of(name)
    .filter(({ bond }) => bond.type === BOND_FEUD && bond.stage === "open")
    .slice(0, 2)
    .map(({ other }) => displayOf(get(other), other));
  if (feuds.length > 0) parts.push(`You are feuding with ${feuds.join(" and ")}. Be cold toward them.`);
  return parts.join(" ");
}

// --- mechanics -------------------------------------------------------------
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function journalEvent(name, text, kind = "social", other = null) {
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

function say(bot, line) {
  try {
    bot?.forceChat?.(String(line).slice(0, 160));
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

function moveTo(director, bot, tile, jitter = 2) {
  try {
    const Loc = director.api?.core?.Location;
    if (!Loc || !bot?.moveTo) return false;
    const x = tile.x + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;
    const y = tile.y + Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;
    bot.moveTo(new Loc(x, y, tile.z ?? 0));
    return true;
  } catch {
    return false;
  }
}

/** Drop bonds whose citizen left the roster (roles change, citizens retire). */
function pruneDeadBonds(director) {
  const roster = director.roster;
  let pruned = 0;
  for (const { a, b } of [...getKinship().bonds.values()]) {
    if (!roster.has(a) || !roster.has(b)) {
      getKinship().remove(a, b);
      pruned++;
    }
  }
  return pruned;
}

/** Formation: sample every same-kingdom pair once per tick. */
function formBonds(director, rng, now) {
  const roster = director.roster;
  const byKingdom = new Map();
  for (const record of roster.values()) {
    if (!record?.kingdomId) continue;
    if (!byKingdom.has(record.kingdomId)) byKingdom.set(record.kingdomId, []);
    byKingdom.get(record.kingdomId).push(record);
  }
  for (const members of byKingdom.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        maybeFormPair(director, members[i], members[j], rng, now);
      }
    }
  }
}

function maybeFormPair(director, ra, rb, rng, now) {
  const a = ra.username;
  const b = rb.username;
  if (getKinship().get(a, b)) return; // already bonded
  const ta = ra.personality?.traits ?? [];
  const tb = rb.personality?.traits ?? [];
  const compat = compatScore(ta, tb);
  const clash = clashScore(ta, tb);

  // Romance first: rarest, and it blocks other romances for both.
  if (!getKinship().hasRomance(a) && !getKinship().hasRomance(b) && chance(rng, FORM_ROMANCE_P * (0.3 + compat))) {
    const rec = getKinship().add(a, b, BOND_ROMANCE, "courting", ra.kingdomId, now);
    if (rec) {
      const da = displayOf(ra, a);
      const db = displayOf(rb, b);
      journalEvent(a, `Can't stop thinking about ${db}.`, "romance", b);
      journalEvent(b, `Can't stop thinking about ${da}.`, "romance", a);
    }
    return;
  }
  // Feuds spark from clashing personalities and bad luck.
  if (chance(rng, FORM_FEUD_P * (0.3 + clash))) {
    const rec = getKinship().add(a, b, BOND_FEUD, "cold", ra.kingdomId, now);
    if (rec) {
      const da = displayOf(ra, a);
      const db = displayOf(rb, b);
      journalEvent(a, `Had words with ${db} at the market. Not letting it go.`, "feud", b);
      journalEvent(b, `${da} has it out for me, I can tell.`, "feud", a);
    }
    return;
  }
  // Friendship: the common case. Shared routines help.
  let p = FORM_FRIEND_P * (0.3 + compat);
  if (ra.role && ra.role === rb.role) p *= SAME_ROLE_BONUS;
  if (chance(rng, p)) {
    const rec = getKinship().add(a, b, BOND_FRIEND, "friend", ra.kingdomId, now);
    if (rec) {
      const da = displayOf(ra, a);
      const db = displayOf(rb, b);
      journalEvent(a, `Shared a long drink with ${db}. Good company.`, "social", b);
      journalEvent(b, `${da} and I talked until the tavern closed.`, "social", a);
    }
  }
}

/** Stage progression for existing bonds. */
function progressBonds(director, rng, now) {
  const roster = director.roster;
  for (const { a, b, bond } of [...getKinship().bonds.values()]) {
    const ra = roster.get(a);
    const rb = roster.get(b);
    if (!ra || !rb) continue;
    const da = displayOf(ra, a);
    const db = displayOf(rb, b);
    const age = now - (bond.since ?? now);

    if (bond.type === BOND_FRIEND && bond.stage === "friend") {
      if (age > FRIEND_CLOSE_AGE_MS && chance(rng, FRIEND_CLOSE_P)) {
        getKinship().setStage(a, b, "close", now);
        journalEvent(a, `${db} is one of my closest friends now.`, "social", b);
        journalEvent(b, `${da} is one of my closest friends now.`, "social", a);
      }
      continue;
    }

    if (bond.type === BOND_ROMANCE) {
      if (bond.stage === "courting" && age > COURTING_AGE_MS && chance(rng, COURTING_DEEPEN_P)) {
        getKinship().setStage(a, b, "serious", now);
        journalEvent(a, `${db} and I are serious now. Everyone can see it.`, "romance", b);
        journalEvent(b, `${da} and I are serious now. Everyone can see it.`, "romance", a);
        seedRumor({
          kingdomId: bond.kingdomId,
          kind: gossipKinds().wedding,
          subject: a,
          subjectDisplay: `${da} and ${db}`,
          text: `are courting — wedding bells soon, mark my words!`,
          holder: pickFriendOrSelf(director, a, b),
        });
      } else if (bond.stage === "serious" && age > SERIOUS_AGE_MS && !bond.data.event && !bond.data.proposalShy) {
        // Personality-driven proposals: not every serious couple marries.
        // Romantic souls propose readily; shy/gruff pairs may stay "serious"
        // forever, happy as they are.
        const pChance = proposalChance(ra.personality?.traits ?? [], rb.personality?.traits ?? []);
        if (!chance(rng, pChance)) {
          if (chance(rng, 0.3)) {
            bond.data.proposalShy = true;
            getKinship().touch(a, b, now);
            journalEvent(a, `${db} and I are happy as we are — no need for vows.`, "romance", b);
          }
          continue;
        }
        bond.data.event = { type: "wedding", phase: "announced", at: now };
        getKinship().touch(a, b, now);
        journalEvent(a, `I'm marrying ${db}! The whole square will hear of it.`, "romance", b);
        journalEvent(b, `I'm marrying ${da}! The whole square will hear of it.`, "romance", a);
        seedRumor({
          kingdomId: bond.kingdomId,
          kind: gossipKinds().wedding,
          subject: a,
          subjectDisplay: `${da} and ${db}`,
          text: `are getting married! Spread the word!`,
          holder: pickFriendOrSelf(director, a, b),
        });
      } else if (bond.stage === "married" && chance(rng, DOMESTIC_P)) {
        // Married life, journaled: the quiet texture of a shared home.
        const line = pick(rng, DOMESTIC_LINES).replace("{S}", chance(rng, 0.5) ? db : da);
        journalEvent(chance(rng, 0.5) ? a : b, line, "social", chance(rng, 0.5) ? b : a);
      }
      continue;
    }

    if (bond.type === BOND_FEUD) {
      // Reconciliation can happen at any stage; stubborn traits slow it.
      const mod = reconcileMod(ra.personality?.traits ?? []) * reconcileMod(rb.personality?.traits ?? []);
      if (chance(rng, RECONCILE_P * mod)) {
        reconcile(director, a, b, ra, rb, bond, now);
        continue;
      }
      // ...otherwise the grudge festers and escalates.
      const stages = STAGES[BOND_FEUD];
      const idx = stages.indexOf(bond.stage);
      if (idx < stages.length - 1 && age > FEUD_ESCALATE_AGE_MS && chance(rng, FEUD_ESCALATE_P)) {
        const next = stages[idx + 1];
        getKinship().setStage(a, b, next, now);
        if (next === "open") {
          journalEvent(a, `${db} and I aren't speaking anymore. Let the whole city know.`, "feud", b);
          journalEvent(b, `${da} and I aren't speaking anymore. Let the whole city know.`, "feud", a);
          seedRumor({
            kingdomId: bond.kingdomId,
            kind: gossipKinds().feud,
            subject: a,
            subjectDisplay: `${da} and ${db}`,
            text: `had a blazing row in the streets. Steer clear!`,
            holder: pickFriendOrSelf(director, a, b),
          });
        } else {
          journalEvent(a, `The bad blood with ${db} is getting worse.`, "feud", b);
        }
      }
    }
  }
}

function reconcile(director, a, b, ra, rb, bond, now) {
  const da = displayOf(ra, a);
  const db = displayOf(rb, b);
  const stages = STAGES[BOND_FEUD];
  const idx = stages.indexOf(bond.stage);
  if (idx <= 0) {
    getKinship().remove(a, b);
    journalEvent(a, `${db} and I made peace. It's over.`, "social", b);
    journalEvent(b, `${da} and I made peace. It's over.`, "social", a);
    seedRumor({
      kingdomId: bond.kingdomId,
      kind: gossipKinds().feud,
      subject: a,
      subjectDisplay: `${da} and ${db}`,
      text: `made peace at last. About time!`,
      holder: pickFriendOrSelf(director, a, b),
    });
  } else {
    getKinship().setStage(a, b, stages[idx - 1], now);
    journalEvent(a, `Maybe ${db} isn't so bad after all. Cooling off.`, "feud", b);
  }
}

/** A gossip seed: a mutual friend if one is handy, else one of the pair. */
function pickFriendOrSelf(director, a, b) {
  try {
    const { bonds } = require("./CitizenBonds");
    const friends = new Set(bonds(a).friends);
    for (const f of bonds(b).friends) {
      if (friends.has(f)) return f;
    }
  } catch {
    // Non-fatal.
  }
  return a;
}

// --- weddings ---------------------------------------------------------------
/** The ceremony machine: announced -> gather -> vows -> cheers -> done. */
function tickWeddings(director, rng, now) {
  const roster = director.roster;
  for (const { a, b, bond } of [...getKinship().bonds.values()]) {
    if (bond.type !== BOND_ROMANCE) continue;
    const event = bond.data.event;
    if (!event || event.type !== "wedding" || event.phase === "done") continue;
    const ra = roster.get(a);
    const rb = roster.get(b);
    if (!ra || !rb) {
      bond.data.event = null;
      getKinship().touch(a, b, now);
      continue;
    }
    const da = displayOf(ra, a);
    const db = displayOf(rb, b);

    if (event.phase === "announced") {
      // Love waits out war, but doesn't celebrate through it.
      if (atWar(bond.kingdomId)) continue;
      if (now - event.at < WEDDING_WAIT_MS) continue;
      const botA = botOf(director, ra);
      const botB = botOf(director, rb);
      if (!botA || !botB) {
        if (now - event.at > WEDDING_MAX_WAIT_MS) {
          // Married quietly: one partner was away too long. Life goes on.
          finishWedding(director, a, b, ra, rb, bond, now, true);
        }
        continue;
      }
      const square = squareTile(bond.kingdomId);
      if (!square) {
        finishWedding(director, a, b, ra, rb, bond, now, true);
        continue;
      }
      // Gather the couple and their guests at the square (data-tier move,
      // same precedent as boss-run/lair teleports).
      moveTo(director, botA, square, 1);
      moveTo(director, botB, square, 1);
      const guests = weddingGuests(director, a, b, bond.kingdomId);
      for (const g of guests) {
        const grec = roster.get(g);
        const gbot = grec ? botOf(director, grec) : null;
        if (gbot) moveTo(director, gbot, square, 4);
      }
      event.guests = guests;
      event.phase = "gather";
      getKinship().touch(a, b, now);
      journalEvent(a, `My wedding day! ${db} waiting at the square — my heart won't sit still.`, "romance", b);
      journalEvent(b, `My wedding day! Walking to the square with ${da}.`, "romance", a);
      const herald = guests.length > 0 ? botOf(director, roster.get(guests[0])) : botA;
      say(herald, `Everyone — the wedding of ${da} and ${db} begins! Gather round!`);
      continue;
    }

    if (event.phase === "gather") {
      const botA = botOf(director, ra);
      const botB = botOf(director, rb);
      if (!botA || !botB) {
        event.phase = "announced"; // someone wandered off; try again
        getKinship().touch(a, b, now);
        continue;
      }
      say(botA, pick(rng, VOWS_A));
      event.phase = "vows";
      getKinship().touch(a, b, now);
      continue;
    }

    if (event.phase === "vows") {
      const botB = botOf(director, rb);
      if (botB) say(botB, pick(rng, VOWS_B));
      event.phase = "cheers";
      getKinship().touch(a, b, now);
      continue;
    }

    if (event.phase === "cheers") {
      for (const g of event.guests ?? []) {
        const grec = roster.get(g);
        const gbot = grec ? botOf(director, grec) : null;
        if (gbot && chance(rng, 0.7)) say(gbot, pick(rng, CHEERS));
      }
      const botA = botOf(director, ra);
      if (botA) say(botA, "Thank you all! There's bread and ale for everyone!");
      finishWedding(director, a, b, ra, rb, bond, now, false);
    }
  }
}

/** Up to N online same-kingdom citizen-friends of the couple. */
function weddingGuests(director, a, b, kingdomId) {
  const guests = [];
  try {
    const { bonds, normalizeName } = require("./CitizenBonds");
    const fa = new Set((bonds(a).friends ?? []).map(normalizeName));
    const fb = new Set((bonds(b).friends ?? []).map(normalizeName));
    const both = [...fa].filter((f) => fb.has(f));
    const either = [...new Set([...fa, ...fb])];
    const pool = [...both, ...either.filter((f) => !both.includes(f))];
    for (const g of pool) {
      if (guests.length >= MAX_WEDDING_GUESTS) break;
      const rec = director.roster.get(g);
      if (!rec || rec.kingdomId !== kingdomId) continue;
      if (!botOf(director, rec)) continue;
      guests.push(g);
    }
  } catch {
    // Non-fatal.
  }
  return guests;
}

function finishWedding(director, a, b, ra, rb, bond, now, quiet) {
  const da = displayOf(ra, a);
  const db = displayOf(rb, b);
  getKinship().setStage(a, b, "married", now);
  bond.data.event = { type: "wedding", phase: "done", at: now, quiet };
  if (quiet) {
    journalEvent(a, `${db} and I were married quietly — no crowd, just us.`, "romance", b);
    journalEvent(b, `${da} and I were married quietly — no crowd, just us.`, "romance", a);
  } else {
    journalEvent(a, `Married ${db} at the square, before all our friends. Best day of my life.`, "romance", b);
    journalEvent(b, `Married ${da} at the square, before all our friends. Best day of my life.`, "romance", a);
  }
  seedRumor({
    kingdomId: bond.kingdomId,
    kind: gossipKinds().wedding,
    subject: a,
    subjectDisplay: `${da} and ${db}`,
    text: quiet ? `got married quietly. Wish I'd been there!` : `were married at the square! What a day!`,
    holder: pickFriendOrSelf(director, a, b),
  });
  getKinship().touch(a, b, now);
}

// --- feud confrontations ------------------------------------------------------
/** Open feuds boil over in public when both parties are near each other. */
function tickFeudArguments(director, rng, now) {
  for (const { a, b, bond } of [...getKinship().bonds.values()]) {
    if (bond.type !== BOND_FEUD || bond.stage !== "open") continue;
    const last = bond.data.lastArgueAt ?? 0;
    if (now - last < ARGUE_COOLDOWN_MS) continue;
    const ra = director.roster.get(a);
    const rb = director.roster.get(b);
    if (!ra || !rb) continue;
    const botA = botOf(director, ra);
    const botB = botOf(director, rb);
    if (!botA || !botB) continue;
    let dist = Infinity;
    try {
      dist = botA.getLocation?.()?.getDistance?.(botB.getLocation?.()) ?? Infinity;
    } catch {
      continue;
    }
    if (dist > ARGUE_RANGE) continue;
    const da = displayOf(ra, a);
    const db = displayOf(rb, b);
    const arguerFirst = chance(rng, 0.5);
    const line = pick(rng, ARGUE_LINES).replace("{B}", arguerFirst ? db : da);
    say(arguerFirst ? botA : botB, line);
    bond.data.lastArgueAt = now;
    getKinship().touch(a, b, now);
    journalEvent(a, `Had a shouting match with ${db} in the street.`, "feud", b);
    journalEvent(b, `${da} shouted at me in front of everyone. Unforgivable.`, "feud", a);
    seedRumor({
      kingdomId: bond.kingdomId,
      kind: gossipKinds().feud,
      subject: a,
      subjectDisplay: `${da} and ${db}`,
      text: `had another shouting match. The whole street heard it!`,
      holder: pickFriendOrSelf(director, a, b),
    });
  }
}

// --- ambient peer greetings ---------------------------------------------------
/**
 * Friends, spouses and sweethearts who cross paths in the street greet each
 * other by name, sometimes trading a line back — and same-party adventuring
 * companions greet each other too, even without a kinship bond. The greeter
 * waves (anim 1286) when the bot supports animations. Zero LLM: template
 * lines through forceChat. Bot-authored chat never reaches the gateway
 * (onSocialPacket drops citizen speakers), so this costs nothing but pixels.
 * Feuds get shouting matches; everyone else gets warmth.
 *
 * Pacing: per-pair cooldown 20 min (kinship bonds persist theirs in bond.data;
 * party pairs gate in memory), server-wide max 1 event per tick.
 */
const GREET_RANGE = 8;
const GREET_COOLDOWN_MS = 20 * 60 * 1000;
const REPLY_CHANCE = 0.5;
const REPLY_DELAY_MS = 4000;
const REPLY_RANGE = 12;
const MAX_PENDING_REPLIES = 20;

const GREET_LINES = {
  married: [
    "There you are, {B}.",
    "{B}, my love. How's the day treating you?",
    "Come here, {B}. Missed you.",
    "{B}! Everything alright?",
  ],
  courting: [
    "{B}! You look lovely today.",
    "Fancy seeing you here, {B}.",
    "Walk with me a bit, {B}?",
    "{B}! Was just thinking of you.",
  ],
  close: [
    "Oi {B}! How's it going?",
    "{B}! You old dog.",
    "Good to see you, {B}!",
    "Ha! {B}, buy you an ale later?",
  ],
  friend: [
    "Morning, {B}.",
    "Hey {B}, fancy meeting you here.",
    "{B}! How's business?",
    "Alright, {B}?",
  ],
  // Same-party adventuring companions who haven't formed a kinship bond yet.
  party: [
    "{B}! Still with us?",
    "Ha! There's my party mate, {B}.",
    "Oi {B}, stay close.",
    "Good to see you, {B}. Ready?",
  ],
};

const ANIM_WAVE = 1286; // wave emote (matches Emotes.plugin.js)

// Party-pair greetings are cooldown-gated in memory only — no new save file.
// Restarting the server just resets the 20-minute gate, which is harmless.
const partyGreetCooldowns = new Map(); // pairKey -> lastGreetAt (ms)

/** Wave at someone, if the bot supports animations. Silent no-op otherwise. */
function playWave(director, bot) {
  try {
    const Anim = director?.api?.core?.Animation;
    if (!Anim || !bot?.performAnimation) return false;
    bot.performAnimation(new Anim(ANIM_WAVE));
    return true;
  } catch {
    return false;
  }
}

const GREET_REPLIES = [
  "Hey {A}! Good to see you.",
  "Ha, {A}! How goes it?",
  "{A}! All well here.",
  "Good to see you too, {A}!",
];

let pendingGreetReplies = [];

function firstNameOf(display) {
  return String(display ?? "").split(" ")[0] || display;
}

function greetLinesFor(bond) {
  if (bond.type === BOND_ROMANCE) {
    return bond.stage === "married" ? GREET_LINES.married : GREET_LINES.courting;
  }
  if (bond.stage === "party") return GREET_LINES.party;
  return bond.stage === "close" ? GREET_LINES.close : GREET_LINES.friend;
}

/** Fire due replies; drop ones whose moment passed. Bounded, tick-local. */
function tickGreetReplies(director, now) {
  if (pendingGreetReplies.length === 0) return;
  const still = [];
  for (const r of pendingGreetReplies) {
    if (still.length >= MAX_PENDING_REPLIES) break;
    if (r.dueAt > now) {
      still.push(r);
      continue;
    }
    if (now - r.dueAt > 60000) continue; // stale: moment passed, drop
    try {
      const ra = director.roster.get(r.a);
      const rb = director.roster.get(r.b);
      const botA = ra && botOf(director, ra);
      const botB = rb && botOf(director, rb);
      if (botA && botB) {
        const dist = botA.getLocation?.()?.getDistance?.(botB.getLocation?.()) ?? Infinity;
        if (dist <= REPLY_RANGE) {
          say(botB, r.line.replace("{A}", firstNameOf(r.da)));
        }
      }
    } catch {
      // Non-fatal.
    }
  }
  pendingGreetReplies = still;
}

/**
 * Party-member pairs eligible for a greeting, independent of kinship bonds.
 * Pairs that already share a kinship bond greet as kinship (handled by the
 * main loop); open feuds never greet. Cooldown is per-pair, in-memory.
 */
function collectPartyPairs(director, now) {
  const { getParty } = require("./CitizenBonds");
  const kinship = getKinship();
  const byParty = new Map(); // partyId -> [{ rec, name }]
  for (const rec of director.roster.values()) {
    const name = normalizeName(rec?.username ?? "");
    if (!name) continue;
    let party = null;
    try {
      party = getParty(name);
    } catch {
      continue;
    }
    if (!party?.id || !Array.isArray(party.members) || party.members.length < 2) continue;
    if (!byParty.has(party.id)) byParty.set(party.id, []);
    byParty.get(party.id).push({ rec, name });
  }
  const out = [];
  for (const members of byParty.values()) {
    // Parties cap at 5 members; pair enumeration is tiny and bounded.
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const { rec: ra, name: a } = members[i];
        const { rec: rb, name: b } = members[j];
        if (kinship.bonds.has(pairKey(a, b))) continue; // covered by kinship loop
        if (isOpenFeud(a, b)) continue;
        if (now - (partyGreetCooldowns.get(pairKey(a, b)) ?? 0) < GREET_COOLDOWN_MS) continue;
        const botA = botOf(director, ra);
        const botB = botOf(director, rb);
        if (!botA || !botB) continue;
        let dist = Infinity;
        try {
          dist = botA.getLocation?.()?.getDistance?.(botB.getLocation?.()) ?? Infinity;
        } catch {
          continue;
        }
        if (dist > GREET_RANGE) continue;
        out.push({
          a,
          b,
          ra,
          rb,
          botA,
          botB,
          bond: { type: BOND_FRIEND, stage: "party" },
          partyPair: true,
        });
      }
    }
  }
  return out;
}

function tickPeerGreetings(director, rng, now) {
  tickGreetReplies(director, now);
  const eligible = [];
  for (const { a, b, bond } of [...getKinship().bonds.values()]) {
    if (bond.type !== BOND_FRIEND && bond.type !== BOND_ROMANCE) continue;
    const last = bond.data.lastGreetAt ?? 0;
    if (now - last < GREET_COOLDOWN_MS) continue;
    const ra = director.roster.get(a);
    const rb = director.roster.get(b);
    if (!ra || !rb) continue;
    const botA = botOf(director, ra);
    const botB = botOf(director, rb);
    if (!botA || !botB) continue;
    let dist = Infinity;
    try {
      dist = botA.getLocation?.()?.getDistance?.(botB.getLocation?.()) ?? Infinity;
    } catch {
      continue;
    }
    if (dist > GREET_RANGE) continue;
    eligible.push({ a, b, bond, ra, rb, botA, botB, partyPair: false });
  }
  // Party members greet even without a kinship bond. Same server-wide
  // throttle: both pools share the single pick below (1 event/tick max).
  try {
    for (const p of collectPartyPairs(director, now)) eligible.push(p);
  } catch {
    // Non-fatal: kinship greetings still fire.
  }
  if (eligible.length === 0) return;
  // One event per tick max: pick a random eligible pair, not always the first.
  const chosen = pick(rng, eligible.slice(0, 200));
  const { a, b, bond, botA, botB, partyPair } = chosen;
  const speakerFirst = chance(rng, 0.5);
  const greeter = speakerFirst ? botA : botB;
  const greeterKey = speakerFirst ? a : b;
  const greetedKey = speakerFirst ? b : a;
  const greeterRec = speakerFirst ? chosen.ra : chosen.rb;
  const greetedRec = speakerFirst ? chosen.rb : chosen.ra;
  // Merchants stay behind the stall: they can be greeted, but don't start chats.
  if (greeterRec?.role === ROLE_MERCHANT) return;
  const db = firstNameOf(displayOf(greetedRec, greetedKey));
  const line = pick(rng, greetLinesFor(bond)).replace("{B}", db);
  say(greeter, line);
  playWave(director, greeter);
  if (partyPair) {
    partyGreetCooldowns.set(pairKey(a, b), now);
  } else {
    bond.data.lastGreetAt = now;
    getKinship().touch(a, b, now);
  }
  if (chance(rng, REPLY_CHANCE)) {
    pendingGreetReplies.push({
      a: greetedKey,
      b: greeterKey,
      da: displayOf(greeterRec, greeterKey),
      dueAt: now + REPLY_DELAY_MS,
      line: pick(rng, GREET_REPLIES),
    });
  }
}

// --- entry point ---------------------------------------------------------------
/**
 * Run once per director tick (background tier, zero LLM). Formation samples
 * every same-kingdom pair; progression, weddings and feud arguments advance
 * the bonds that exist. All visible output goes through forceChat, the
 * journal, and gossip — the foreground reads those, never this.
 */
function tickKinship(director, hour, nowMs = Date.now()) {
  if (!director?.roster) return;
  const rng = agentRng(`kinship:${Math.floor(nowMs / 60000)}`);
  const now = nowMs;
  try {
    pruneDeadBonds(director);
  } catch { /* non-fatal */ }
  try {
    formBonds(director, rng, now);
  } catch { /* non-fatal */ }
  try {
    progressBonds(director, rng, now);
  } catch { /* non-fatal */ }
  try {
    tickWeddings(director, rng, now);
  } catch { /* non-fatal */ }
  try {
    tickFeudArguments(director, rng, now);
  } catch { /* non-fatal */ }
  try {
    tickPeerGreetings(director, rng, now);
  } catch { /* non-fatal */ }
  // `hour` is accepted for signature parity with the other tick modules.
  void hour;
}

module.exports = {
  CitizenKinshipStore,
  getKinship,
  resetKinshipForTests,
  tickKinship,
  spouseOf,
  partnerOf,
  isOpenFeud,
  kinSummary,
  compatScore,
  clashScore,
  reconcileMod,
  proposalChance,
  pairKey,
  normalizeName,
  BOND_FRIEND,
  BOND_ROMANCE,
  BOND_FEUD,
  STAGES,
  MAX_BONDS_PER_CITIZEN,
};
