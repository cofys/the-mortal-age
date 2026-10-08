"use strict";

/**
 * CitizenJudges — legal authorities who hear cases, settle disputes and
 * uphold the law: magistrates, high judges, arbiters and bailiffs.
 *
 * WHAT IT DOES (data tier, free):
 *   Every judge citizen gets a hash-stable judge type. Court sessions run on
 *   a daily rhythm derived from hashes — which judge holds court, the docket
 *   of cases (plaintiff, defendant, kind), and verdicts with punishments —
 *   all deterministic, zero disk state. The wanted list from CitizenGuards
 *   is read live (bailiffs work wanted cases; high judges sentence them).
 *   Fines are kept in an in-memory court ledger (TTL, pruned). Everything is
 *   journaled so the LLM mouth can riff on it later. Each session seeds one
 *   real "verdict" rumor so citizens gossip about trials; fined defendants
 *   may appeal (deterministic), and later sessions review pending appeals
 *   through the real ledgers (overturn pays the fine off in full).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   During court hours (09:00-16:00 server time) a materialized judge holds
 *   a scripted trial: bailiff calls the case, defendant pleads, the judge
 *   hands down the verdict, sentence follows. Bailiffs serve summons on
 *   lingering players; arbiters offer to settle disputes; exile verdicts
 *   and acquittals are crowd moments. Work journaled once per loop.
 *
 * Zero LLM: every line is scripted from pools; the LLM mouth only reads the
 * journal ("fined fifty coins for stealing bread yesterday"). Complements
 * CitizenGuards (arrests, the wanted list) and CitizenBankers (loans) —
 * this module owns types, sessions, the docket, verdicts, fines and
 * appeals. No overlap.
 *
 * Wired into the director tick in tickProximity(), right after the guards
 * block. Plain-node testable: CitizenJudges.test.js.
 */

// === Tuning: all magic numbers here ===
const JUDGE_RADIUS = 14; // tiles — a real player must be near to see/hear
const SESSION_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a judge holds court at most this often
const SUMMONS_COOLDOWN_MS = 45 * 60 * 1000; // a bailiff serves at most this often
const ARBITER_COOLDOWN_MS = 60 * 60 * 1000;
const SESSION_HOUR_START = 9; // court in session 09:00-16:00 server time
const SESSION_HOUR_END = 16;
const FINE_LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // unpaid fines linger a week
const JUDGE_CHANCE = 0.35; // ~35% of courtiers become judges

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Judge types and courts ===
const JUDGE_TYPES = Object.freeze(["magistrate", "high-judge", "arbiter", "bailiff"]);

const COURTS = Object.freeze([
  { name: "the Varrock court hall", kingdom: "varrock" },
  { name: "the Lumbridge petty court", kingdom: "lumbridge" },
  { name: "the Falador tribunal", kingdom: "falador" },
  { name: "the Port Sarim maritime court", kingdom: "portsarim" },
  { name: "the Ardougne assizes", kingdom: "ardougne" },
  { name: "the Seers' court of equity", kingdom: "kandarin" },
  { name: "the Keldagrim law vault", kingdom: "keldagrim" },
  { name: "the Dorgesh court of small claims", kingdom: "dorgeshuun" },
  { name: "the Darkmeyer blood court", kingdom: "morytania" },
  { name: "the Al Kharid qadi's court", kingdom: "alkharid" },
]);

const CASE_KINDS = Object.freeze([
  { kind: "theft", gravity: 1, suits: ["magistrate", "high-judge"] },
  { kind: "disturbance", gravity: 1, suits: ["magistrate", "arbiter"] },
  { kind: "fraud", gravity: 2, suits: ["high-judge", "arbiter"] },
  { kind: "assault", gravity: 2, suits: ["high-judge"] },
  { kind: "debt", gravity: 1, suits: ["arbiter", "magistrate"] },
  { kind: "trespass", gravity: 1, suits: ["magistrate", "arbiter"] },
  { kind: "robbery", gravity: 3, suits: ["high-judge"] },
  { kind: "smuggling", gravity: 2, suits: ["high-judge", "magistrate"] },
]);

const FINES_BY_GRAVITY = Object.freeze({ 1: [25, 75], 2: [100, 400], 3: [500, 2000] });
const JAIL_BY_GRAVITY = Object.freeze({ 1: "a night", 2: "a week", 3: "a month" });

// === Line pools (scripted, zero LLM) ===
const SESSION_OPEN_LINES = Object.freeze([
  "{court} is now in session. All rise for {judge} the {type}.",
  "Hear ye, hear ye — {court} sits today under {judge} the {type}.",
  "Court is in session at {court}. {judge} presides.",
]);

const CASE_CALL_LINES = Object.freeze([
  "Bailiff: the case of {plaintiff} against {defendant} — charged with {kind}.",
  "Bailiff: {defendant}, you stand accused of {kind}. {plaintiff} brings the charge.",
  "Bailiff: all rise. The court hears {plaintiff} versus {defendant}, a case of {kind}.",
]);

const PLEA_LINES = Object.freeze([
  "{defendant}: Not guilty, your honor. I swear it.",
  "{defendant}: Guilty, your honor. I throw myself on the court's mercy.",
  "{defendant}: I did what I did, and I'd do it again.",
]);

const VERDICT_GUILTY_LINES = Object.freeze([
  "{judge}: The court finds {defendant} guilty of {kind}.",
  "{judge}: Guilty. The evidence is plain and the law is plainer.",
  "{judge}: Guilty as charged. The court will now sentence.",
]);

const VERDICT_ACQUIT_LINES = Object.freeze([
  "{judge}: The court finds {defendant} not guilty. The charge is dismissed.",
  "{judge}: Not guilty. {plaintiff}, bring better evidence next time.",
  "{judge}: Acquitted. This court will not punish on rumor alone.",
]);

const SENTENCE_FINE_LINES = Object.freeze([
  "{judge}: {defendant} shall pay {fine} coins to the court. Case closed.",
  "{judge}: A fine of {fine} coins. Pay the clerk on your way out, {defendant}.",
]);

const SENTENCE_JAIL_LINES = Object.freeze([
  "{judge}: {defendant} shall spend {jail} in the cells. Bailiff, take them away.",
  "{judge}: The cells for {jail}, {defendant}. Think on what you've done.",
]);

const SENTENCE_EXILE_LINES = Object.freeze([
  "{judge}: {defendant} is hereby exiled from this kingdom until the moon turns. Begone.",
  "{judge}: Exile. {defendant} shall not set foot here for a month and a day.",
]);

const SUMMONS_LINES = Object.freeze([
  "Bailiff: {name}, by order of {court}, you are summoned to answer a charge of {kind}.",
  "Bailiff: hold, {name}. The court would have words with you about a {kind}.",
  "Bailiff: {name}, this summons bears the seal of {court}. Appear at next session.",
]);

const ARBITER_OFFER_LINES = Object.freeze([
  "{judge}: quarrels settled without blood, for a small fee. Bring me your dispute.",
  "{judge}: neighbors at odds? An arbiter's word saves a magistrate's gavel. Speak.",
  "{judge}: I settle debts and boundaries. Cheaper than a trial, fairer than a feud.",
]);

const WANTED_SENTENCE_LINES = Object.freeze([
  "{judge}: {defendant}, already wanted for {kind} — the court adds its own sentence. The law is patient, but it is not blind.",
  "{judge}: a wanted {kind} walks into my court? {defendant}, your sentence starts now.",
]);

const APPEAL_LINES = Object.freeze([
  "{judge}: an appeal? Very well — the court will hear it. {defendant}, your fine is stayed until the review.",
  "{judge}: the appeal is noted. Justice twice-measured is justice sure.",
]);

const APPEAL_UPHOLD_LINES = Object.freeze([
  "{judge}: the appeal is denied. {defendant}, the fine stands. Justice has spoken twice.",
  "{judge}: appeal reviewed and upheld. The sentence stands, {defendant}.",
]);

const APPEAL_OVERTURN_LINES = Object.freeze([
  "{judge}: on appeal, the court corrects itself — {defendant}, your fine is overturned.",
  "{judge}: the appeal is granted. {defendant} owes nothing. The record is struck.",
]);

const CLOSING_LINES = Object.freeze([
  "Bailiff: court is adjourned. The docket is clear.",
  "{judge}: justice is done for today. Court stands adjourned.",
]);

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a hash of a string — stable judge-type assignment across restarts. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Normalize a name for map keys. */
function normName(name) {
  return String(name ?? "").trim().toLowerCase();
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

/** Fill {slots} in a template line. */
function fillLine(line, vars) {
  let out = String(line ?? "");
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.split("{" + k + "}").join(String(v ?? ""));
  }
  return out.slice(0, 120);
}

/** Judge type from username hash, stable across restarts, zero storage. */
function judgeTypeFor(username) {
  return JUDGE_TYPES[fnv1a(username) % JUDGE_TYPES.length];
}

/** ~35% of courtiers are judges — stable per username, zero storage. */
function isJudge(username) {
  return (fnv1a("judge:" + username) % 100) < Math.round(JUDGE_CHANCE * 100);
}

/** Court for a username — kingdom-preferred, then hash fallback. */
function courtFor(username, kingdom) {
  const k = normName(kingdom);
  const match = COURTS.filter((c) => normName(c.kingdom) === k);
  const pool = match.length ? match : COURTS;
  return pool[fnv1a("court:" + username) % pool.length].name;
}

/** Is court in session at this wall-clock hour? Pure. */
function inSessionAtHour(hour) {
  return hour >= SESSION_HOUR_START && hour < SESSION_HOUR_END;
}

/**
 * The day's docket: which cases this judge hears today. Derived from
 * (judge, date), no storage. Each case: { plaintiff, defendant, kind }.
 */
function docketFor(judgeUsername, judgeType, dateMs, rosterNames) {
  const day = Math.floor(dateMs / 86400000);
  const seed = fnv1a("docket:" + judgeUsername + ":" + day);
  const names = (rosterNames ?? []).filter((n) => normName(n) !== normName(judgeUsername));
  if (!names.length) return [];
  const suited = CASE_KINDS.filter((c) => c.suits.includes(judgeType));
  const pool = suited.length ? suited : CASE_KINDS;
  const rng = mulberry(seed);
  const n = 1 + Math.floor(rng() * 3); // 1-3 cases per judge per day
  const cases = [];
  for (let i = 0; i < n; i++) {
    const defendant = names[Math.floor(rng() * names.length)];
    let plaintiff = names[Math.floor(rng() * names.length)];
    if (normName(plaintiff) === normName(defendant) && names.length > 1) {
      plaintiff = names[(names.indexOf(plaintiff) + 1) % names.length];
    }
    cases.push({
      plaintiff: String(plaintiff),
      defendant: String(defendant),
      kind: pool[Math.floor(rng() * pool.length)],
    });
  }
  return cases;
}

/** Verdict for a case — derived from (case, date), deterministic. */
function verdictFor(caseObj, dateMs) {
  const day = Math.floor(dateMs / 86400000);
  const seed = fnv1a("verdict:" + caseObj.defendant + ":" + caseObj.kind.kind + ":" + day);
  const rng = mulberry(seed);
  const guilty = rng() < 0.7; // courts convict most of the time
  if (!guilty) return { guilty: false, sentence: null };
  const fine = fineFor(caseObj.kind.gravity, rng);
  const sentence = sentenceFor(caseObj.kind.gravity, rng);
  return { guilty: true, sentence: { fine, jail: sentence } };
}

/** Fine in coins for a gravity level, using the rng. Pure. */
function fineFor(gravity, rng) {
  const [lo, hi] = FINES_BY_GRAVITY[gravity] ?? FINES_BY_GRAVITY[1];
  return lo + Math.floor((rng ? rng() : 0.5) * (hi - lo + 1));
}

/** Sentence kind for a gravity level: fine, jail, or exile. Pure. */
function sentenceFor(gravity, rng) {
  const r = rng ? rng() : 0.5;
  if (gravity >= 3 && r < 0.25) return "exile";
  if (r < 0.55) return "fine";
  return "jail";
}

/** Jail duration string for a gravity level. Pure. */
function jailFor(gravity) {
  return JAIL_BY_GRAVITY[gravity] ?? JAIL_BY_GRAVITY[1];
}

/** Deterministic PRNG from a seed. */
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generic cooldown + chance gate. Pure and testable. */
function shouldFire(rng, lastMs, nowMs, cooldownMs, chance) {
  if (nowMs - (lastMs || 0) < cooldownMs) return false;
  return rng() < chance;
}

// === Fine ledger (data tier, in-memory, TTL) ===
const fineLedger = new Map(); // normName -> { name, amount, at, until, kind }

function recordFine(username, amount, kind, nowMs) {
  const key = normName(username);
  if (!key || !(amount > 0)) return false;
  fineLedger.set(key, {
    name: String(username).trim(),
    amount,
    kind: String(kind ?? "fine"),
    at: nowMs,
    until: nowMs + FINE_LEDGER_TTL_MS,
  });
  return true;
}

/** Pure-ish: read a fine, pruning expired entries. */
function fineForPlayer(username, nowMs) {
  const key = normName(username);
  const f = fineLedger.get(key);
  if (!f) return null;
  if (f.until <= nowMs) {
    fineLedger.delete(key);
    return null;
  }
  return f;
}

/** Pure: pay down (or clear) a fine. */
function payFine(username, amount, nowMs) {
  const f = fineForPlayer(username, nowMs);
  if (!f || !(amount > 0)) return null;
  f.amount -= amount;
  if (f.amount <= 0) {
    fineLedger.delete(normName(username));
    return { paid: true, remaining: 0 };
  }
  return { paid: false, remaining: f.amount };
}

/** Pure: outstanding fine count (expired pruned). */
function fineCount(nowMs) {
  let n = 0;
  for (const [k, f] of fineLedger) {
    if (!f || f.until <= nowMs) fineLedger.delete(k);
    else n++;
  }
  return n;
}

// === Appeals (data tier, in-memory, TTL) ===
const appealLedger = new Map(); // normName -> { name, at, until }

function requestAppeal(username, nowMs) {
  const key = normName(username);
  if (!key) return false;
  if (appealLedger.has(key)) return false; // one appeal per fine
  appealLedger.set(key, { name: String(username).trim(), at: nowMs, until: nowMs + FINE_LEDGER_TTL_MS });
  return true;
}

function appealFor(username, nowMs) {
  const key = normName(username);
  const a = appealLedger.get(key);
  if (!a) return null;
  if (a.until <= nowMs) {
    appealLedger.delete(key);
    return null;
  }
  return a;
}

/** Clear a pending appeal (after review). Returns true if one existed. */
function resolveAppeal(username) {
  const key = normName(username);
  if (!key || !appealLedger.has(key)) return false;
  appealLedger.delete(key);
  return true;
}

/** Deterministic appeal gate: ~30% of fined defendants appeal, per (defendant, day). Pure. */
function appealFiresFor(defendant, dayMs) {
  const day = Math.floor(dayMs / 86400000);
  return mulberry(fnv1a("appeal:" + normName(defendant) + ":" + day))() < 0.3;
}

/** Deterministic appeal review outcome, per (defendant, day). Pure. */
function appealOverturnedFor(defendant, dayMs) {
  const day = Math.floor(dayMs / 86400000);
  return mulberry(fnv1a("appealreview:" + normName(defendant) + ":" + day))() < 0.5;
}

/**
 * Review pending appeals for the day's docket defendants (data tier).
 * Only appeals filed on an EARLIER day are reviewable — a fine appealed
 * this session is stayed, not decided. Overturned fines are paid off in
 * full through the real fine ledger. Returns the reviewed list for the
 * tick to announce and journal: [{ defendant, kind, overturned, fine }].
 */
function reviewAppeals(judgeName, docket, nowMs) {
  const out = [];
  const day = Math.floor(nowMs / 86400000);
  for (const c of docket ?? []) {
    const defendant = c?.defendant;
    if (!defendant) continue;
    let a;
    try {
      a = appealFor(defendant, nowMs);
    } catch {
      continue;
    }
    if (!a) continue;
    if (Math.floor(a.at / 86400000) >= day) continue; // this session's own appeals stay pending
    const fine = fineForPlayer(defendant, nowMs);
    const overturned = appealOverturnedFor(defendant, nowMs);
    if (overturned && fine) payFine(defendant, fine.amount, nowMs);
    resolveAppeal(defendant);
    out.push({
      defendant: String(defendant),
      kind: c.kind?.kind ?? "the case",
      overturned,
      fine: fine ? fine.amount : 0,
    });
  }
  return out;
}

// ============================================================================
// Engine helpers (impure, guarded).
// ============================================================================

function journal(director, name, kind, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(name, kind, text, data ? { data } : undefined);
  } catch {
    // Journal must never break the court.
  }
}

function forceSay(bot, line) {
  try {
    bot.forceChat?.(String(line).slice(0, 120));
  } catch {
    // Cosmetic only.
  }
}

/** Roster names for docket building — cheap, from memory. */
function rosterNames(director) {
  try {
    const out = [];
    for (const r of director.roster?.values?.() ?? []) {
      if (r && r.username) out.push(r.username);
      if (out.length >= 60) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = bot.getLocation?.();
    if (!me) return out;
    const mx = me.getX();
    const my = me.getY();
    const mz = me.getZ?.() ?? 0;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (!isRealPlayer(p)) continue;
      try {
        const l = p.getLocation?.();
        if (!l) continue;
        if ((l.getZ?.() ?? 0) !== mz) continue;
        if (Math.max(Math.abs(l.getX() - mx), Math.abs(l.getY() - my)) <= tiles) out.push(p);
      } catch { /* skip */ }
    }
  } catch { /* never break */ }
  return out;
}

/** Read the live wanted list from CitizenGuards (lazy, never throws). */
function wantedInfo(username, nowMs) {
  try {
    const guards = require("./CitizenGuards");
    return guards.isWanted?.(username, nowMs) ? true : false;
  } catch {
    return false;
  }
}

/** Seed one real "verdict" rumor per court session so citizens gossip about trials. Guarded. */
function seedVerdictRumor(judgeName, court, caseObj, verdict, nowMs) {
  try {
    const { seedRumor } = require("./CitizenRumors");
    const day = Math.floor(nowMs / 86400000);
    const rng = mulberry(fnv1a("verdictrumor:" + normName(judgeName) + ":" + day));
    let what;
    if (verdict.guilty) {
      const s = verdict.sentence;
      const outcome =
        s.jail === "exile" ? "exiled from the kingdom"
        : s.jail === "jail" ? `jailed for ${jailFor(caseObj.kind.gravity)}`
        : `fined ${s.fine} coins`;
      what = `found guilty of ${caseObj.kind.kind} and ${outcome}`;
    } else {
      what = `acquitted of ${caseObj.kind.kind}`;
    }
    seedRumor(rng, {
      kind: "verdict",
      who: caseObj.defendant,
      whoDisplay: caseObj.defendant,
      what,
      where: court,
      whereDisplay: court,
      holder: judgeName,
    });
  } catch {
    // Rumors must never break the court.
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → citizen exists → real player near → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickJudges(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    const hour = new Date(nowMs).getHours();
    const inSession = inSessionAtHour(hour);
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < SESSION_COOLDOWN_MS) continue;

        // 2. Must be a judge (courtiers only)
        if (!record || record.role !== "courtier" || !isJudge(record.username)) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. A real player must be within earshot
        const near = realPlayersWithin(citizen, JUDGE_RADIUS);
        if (!near.length) continue;

        const type = judgeTypeFor(record.username);
        const court = courtFor(record.username, record.kingdom);
        const vars = { judge: record.username, type: type.replace("-", " "), court };

        if (inSession && type !== "bailiff") {
          // Court in session: hold a trial from today's docket.
          const names = rosterNames(director);
          const docket = docketFor(record.username, type, nowMs, names);
          if (!docket.length) continue;
          const rng = mulberry(fnv1a("session:" + record.username + ":" + Math.floor(nowMs / 86400000)));
          // Appeal reviews first: earlier-day appeals from today's docket defendants.
          for (const rev of reviewAppeals(record.username, docket, nowMs)) {
            const rvars = { ...vars, defendant: rev.defendant, fine: rev.fine };
            forceSay(citizen, fillLine(pickOne(rng, rev.overturned ? APPEAL_OVERTURN_LINES : APPEAL_UPHOLD_LINES), rvars));
            journal(director, record.username, "court",
              `${rev.defendant}'s appeal was ${rev.overturned ? "granted — fine overturned" : "denied — fine stands"} at ${court}`,
              { kind: rev.kind });
          }
          const c = pickOne(rng, docket);
          const verdict = verdictFor(c, nowMs);
          const cvars = { ...vars, plaintiff: c.plaintiff, defendant: c.defendant, kind: c.kind.kind };

          forceSay(citizen, fillLine(pickOne(rng, SESSION_OPEN_LINES), vars));
          forceSay(citizen, fillLine(pickOne(rng, CASE_CALL_LINES), cvars));
          forceSay(citizen, fillLine(pickOne(rng, PLEA_LINES), cvars));

          if (verdict.guilty) {
            const isWantedCase = wantedInfo(c.defendant, nowMs);
            forceSay(citizen, fillLine(pickOne(rng, VERDICT_GUILTY_LINES), cvars));
            if (isWantedCase) {
              forceSay(citizen, fillLine(pickOne(rng, WANTED_SENTENCE_LINES), cvars));
            }
            const sent = verdict.sentence;
            if (sent.jail === "exile") {
              forceSay(citizen, fillLine(pickOne(rng, SENTENCE_EXILE_LINES), cvars));
            } else if (sent.jail === "jail") {
              forceSay(citizen, fillLine(pickOne(rng, SENTENCE_JAIL_LINES), { ...cvars, jail: jailFor(c.kind.gravity) }));
            } else {
              forceSay(citizen, fillLine(pickOne(rng, SENTENCE_FINE_LINES), { ...cvars, fine: sent.fine }));
              recordFine(c.defendant, sent.fine, c.kind.kind, nowMs);
              if (appealFiresFor(c.defendant, nowMs) && requestAppeal(c.defendant, nowMs)) {
                forceSay(citizen, fillLine(pickOne(rng, APPEAL_LINES), cvars));
                journal(director, record.username, "court",
                  `${c.defendant} appealed the ${sent.fine}-coin fine for ${c.kind.kind} at ${court}`,
                  { kind: c.kind.kind });
              }
            }
            journal(director, record.username, "court",
              `found ${c.defendant} guilty of ${c.kind.kind} at ${court}`, { plaintiff: c.plaintiff });
          } else {
            forceSay(citizen, fillLine(pickOne(rng, VERDICT_ACQUIT_LINES), cvars));
            journal(director, record.username, "court",
              `acquitted ${c.defendant} of ${c.kind.kind} at ${court}`, { plaintiff: c.plaintiff });
          }
          seedVerdictRumor(record.username, court, c, verdict, nowMs);
          forceSay(citizen, fillLine(pickOne(rng, CLOSING_LINES), vars));
        } else if (type === "bailiff") {
          // Bailiffs serve summons on lingering players.
          const last2 = lastFiredByCitizen.get("bailiff:" + record.username) || 0;
          if (nowMs - last2 < SUMMONS_COOLDOWN_MS) continue;
          const p = near[0];
          const pname = p.getUsername?.() ?? "traveler";
          const rng = mulberry(fnv1a("summons:" + record.username + ":" + Math.floor(nowMs / 3600000)));
          const kind = pickOne(rng, ["theft", "disturbance", "debt"]);
          forceSay(citizen, fillLine(pickOne(rng, SUMMONS_LINES), { ...vars, name: pname, kind }));
          journal(director, record.username, "summons", `served ${pname} a summons for ${kind}`);
          lastFiredByCitizen.set("bailiff:" + record.username, nowMs);
        } else if (type === "arbiter") {
          // Arbiters offer to settle disputes out of session hours.
          forceSay(citizen, fillLine(pickOne(mulberry(fnv1a("arb:" + record.username)), ARBITER_OFFER_LINES), vars));
          journal(director, record.username, "court", `offered arbitration at ${court}`);
        } else {
          // Non-session judges: hold office hours.
          forceSay(citizen, fillLine(pickOne(mulberry(fnv1a("hold:" + record.username)), SESSION_OPEN_LINES), vars));
        }

        lastFiredByCitizen.set(record.username, nowMs);
      } catch { /* per-citizen: never break the loop */ }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-judges] tick failed:", e?.message ?? e);
  }
}

module.exports = {
  tickJudges,
  recordFine,
  fineForPlayer,
  payFine,
  fineCount,
  requestAppeal,
  appealFor,
  resolveAppeal,
  reviewAppeals,
  appealFiresFor,
  appealOverturnedFor,
  // Export pure helpers for tests:
  pickOne,
  isRealPlayer,
  withinTiles,
  fillLine,
  fnv1a,
  normName,
  judgeTypeFor,
  isJudge,
  courtFor,
  inSessionAtHour,
  docketFor,
  verdictFor,
  fineFor,
  sentenceFor,
  jailFor,
  shouldFire,
  mulberry,
  // Tuning (tests pin the documented behavior):
  JUDGE_RADIUS,
  SESSION_COOLDOWN_MS,
  SESSION_HOUR_START,
  SESSION_HOUR_END,
  JUDGE_CHANCE,
  // Line pools (non-empty checks):
  SESSION_OPEN_LINES,
  CASE_CALL_LINES,
  PLEA_LINES,
  VERDICT_GUILTY_LINES,
  VERDICT_ACQUIT_LINES,
  SENTENCE_FINE_LINES,
  SENTENCE_JAIL_LINES,
  SENTENCE_EXILE_LINES,
  SUMMONS_LINES,
  ARBITER_OFFER_LINES,
  WANTED_SENTENCE_LINES,
  APPEAL_LINES,
  APPEAL_UPHOLD_LINES,
  APPEAL_OVERTURN_LINES,
  CLOSING_LINES,
  COURTS,
  CASE_KINDS,
};
