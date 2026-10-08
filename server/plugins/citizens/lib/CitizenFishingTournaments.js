"use strict";

/**
 * CitizenFishingTournaments — citizens organize real fishing tournaments.
 *
 * Each kingdom runs its own tournament on a staggered weekly cycle:
 *   announcement (6h) -> registration (24h) -> competition (2h) ->
 *   weigh-in (30m) -> prizes (6h) -> idle until next week.
 *
 * WHAT IT DOES (data tier, free):
 *   Phase machine per kingdom driven by wall-clock time on the slow (~60s)
 *   director tick. Registration is weighted by personality (patient, outdoorsy
 *   citizens love it; gruff ones scoff). Catches are simulated data-tier:
 *   each entrant has a deterministic fishing skill (hashed from username),
 *   and per tick they land catches from a weighted fish pool — higher skill
 *   means more fish and access to rarer species. Results are scored in three
 *   categories: biggest fish, most fish, rarest catch. Winners are journaled
 *   (so the LLM can riff later) and losers journal grudges — rivalries form
 *   naturally when the same citizen keeps beating you.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   The organizer announces at the docks; registrants trash-talk near
 *   players (scripted pools, personality-gated); during competition,
 *   contestants call out their catches; weigh-in results are announced.
 *   Players can register via `fishing:tournament-register` and their real
 *   catches count via `fishing:tournament-catch`. Prize winners get coins
 *   through the `fishing:tournament-prize` event.
 *
 * PLAYER EVENTS (custom event bus):
 *   emit `fishing:tournament-register` with { kingdomId, playerName }
 *   emit `fishing:tournament-catch` with { kingdomId, playerName, fishName, weightKg }
 *   listen `fishing:tournament-prize` for { kingdomId, category, winner,
 *     prizeCoins, isPlayer } — a gameplay plugin awards the actual coins.
 *
 * LLM role: commentary only. All visible lines are scripted pools; when a
 * player asks a contestant "how's the tournament going?", the foreground LLM
 * reads their journaled catches — no LLM in this tick path.
 *
 * Wiring: slow director tick calls tickFishingTournaments(this, nowMs) after
 * the festivals block. Plain-node testable: CitizenFishingTournaments.test.js.
 */

const fs = require("fs");
const path = require("path");
const { getJournal } = require("./CitizenJournal");
const { normalizeName } = require("./CitizenBonds");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-fishing-tournaments.json");

// === Tuning: all magic numbers here ===
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

const ANNOUNCE_MS = 6 * HOUR_MS;
const REGISTRATION_MS = 24 * HOUR_MS;
const COMPETITION_MS = 2 * HOUR_MS;
const WEIGHIN_MS = 30 * MIN_MS;
const PRIZES_MS = 6 * HOUR_MS;
const CYCLE_MS = 7 * DAY_MS; // weekly tournaments per kingdom

const TOURNAMENT_RADIUS = 14; // tiles — close enough to hear the banter
const TRASHTALK_COOLDOWN_MS = 2 * HOUR_MS; // a citizen trash-talks at most this often
const TRASHTALK_CHANCE = 0.35; // per eligible citizen per slow tick near a player
const CATCH_CALL_CHANCE = 0.25; // contestants call out catches this often

const MAX_ENTRANTS = 12; // citizens per tournament (players are extra)

// Prizes: coins per category placement (awarded via fishing:tournament-prize).
const PRIZE_COINS = Object.freeze({ first: 10000, second: 5000, third: 2500 });

// === Fish pool: name -> { weightKg (typical), rarity (0-10), minSkill } ===
// Weights are plausible real-world values; rarity gates by fishing skill.
const FISH_POOL = Object.freeze([
  { name: "shrimp", weightKg: 0.05, rarity: 0, minSkill: 1 },
  { name: "sardine", weightKg: 0.1, rarity: 0, minSkill: 1 },
  { name: "anchovy", weightKg: 0.05, rarity: 0, minSkill: 1 },
  { name: "herring", weightKg: 0.2, rarity: 1, minSkill: 5 },
  { name: "trout", weightKg: 0.5, rarity: 1, minSkill: 10 },
  { name: "mackerel", weightKg: 0.5, rarity: 1, minSkill: 16 },
  { name: "pike", weightKg: 1.5, rarity: 2, minSkill: 20 },
  { name: "cod", weightKg: 3, rarity: 2, minSkill: 23 },
  { name: "salmon", weightKg: 2, rarity: 2, minSkill: 30 },
  { name: "tuna", weightKg: 15, rarity: 3, minSkill: 35 },
  { name: "lobster", weightKg: 1, rarity: 3, minSkill: 40 },
  { name: "bass", weightKg: 2.5, rarity: 4, minSkill: 46 },
  { name: "swordfish", weightKg: 80, rarity: 5, minSkill: 50 },
  { name: "lava eel", weightKg: 1, rarity: 5, minSkill: 53 },
  { name: "monkfish", weightKg: 5, rarity: 6, minSkill: 62 },
  { name: "shark", weightKg: 100, rarity: 7, minSkill: 76 },
  { name: "infernal eel", weightKg: 2, rarity: 8, minSkill: 80 },
  { name: "anglerfish", weightKg: 8, rarity: 8, minSkill: 82 },
  { name: "dark crab", weightKg: 4, rarity: 9, minSkill: 85 },
  { name: "sacred eel", weightKg: 1.5, rarity: 10, minSkill: 87 },
]);

// === Scripted line pools (zero LLM) ===
const ANNOUNCE_LINES = Object.freeze([
  "Hear ye! The {kingdom} Fishing Tournament opens soon — register at the docks!",
  "*{name} pins a tournament notice to the dock post* — fishing tournament this week!",
  "Anglers of {kingdom}! The tournament waters await. Sign up, sign up!",
]);

const TRASHTALK_LINES = Object.freeze([
  "{name}: \"I've been fishing these waters since before you could swim.\"",
  "{name}: \"Hope you brought a bigger net. You'll need it.\"",
  "{name}: \"Last tournament I landed a beauty. This time? Bigger.\"",
  "{name}: \"{rival}, was that a fish or did you fall in again?\"",
  "{name}: \"My grandmother fishes better than you lot, and she's been dead ten years.\"",
  "{name}: \"Careful out there — the big ones bite.\"",
]);

const CATCH_LINES = Object.freeze([
  "*{name} hauls in a {fish}!*",
  "{name}: \"That's a beauty! {fish}, right there!\"",
  "*{name} holds up a {fish} for all to see*",
]);

const WIN_LINES = Object.freeze([
  "{name} wins {category} with {detail}! The crowd goes wild!",
  "Unbelievable! {name} takes {category} — {detail}!",
  "*{name} lifts the trophy high* — {category} champion!",
]);

const GRUMBLE_LINES = Object.freeze([
  "{name}: \"The fish were biting everyone else's hooks today...\"",
  "{name}: \"Next time. Next time for sure.\"",
  "*{name} glares at the leaderboard*",
]);

// === State ===
const tournaments = new Map(); // kingdomId -> tournament state
let dirty = false;
const trashtalkCooldowns = new Map(); // username -> timestamp

// Memory-leak plug.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of trashtalkCooldowns) {
    if (at < cutoff) trashtalkCooldowns.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Tournament key is just the kingdom id (one tournament per kingdom). */
function tournamentKey(kingdomId) {
  return String(kingdomId);
}

/** Deterministic FNV-1a hash -> [0,1) for staggering schedules and skills. */
function hash01(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * A citizen's fishing skill: deterministic 1-99 from their username.
 * Stable across restarts, so rivalries and form persist.
 * Pure: (username) -> 1..99.
 */
function fishingSkillFor(username) {
  return 1 + Math.floor(hash01("fishing:" + normalizeName(username)) * 99);
}

/**
 * How keen a citizen is to enter: patient/outdoorsy types love it,
 * gruff/busy types scoff. Pure: (record) -> 0..1.
 */
function entryKeenness(record) {
  const traits = (record.personality?.traits ?? []).map((t) => String(t).toLowerCase());
  let score = 0.3; // baseline curiosity
  const keen = ["patient", "calm", "methodical", "curious", "cheerful", "chatty"];
  const averse = ["gruff", "suspicious", "ambitious", "dutiful"];
  for (const t of keen) if (traits.includes(t)) score += 0.15;
  for (const t of averse) if (traits.includes(t)) score -= 0.12;
  if (record.role === "merchant") score += 0.1; // merchants love a crowd
  if (record.role === "guard") score -= 0.1; // guards are on duty
  return Math.max(0, Math.min(1, score));
}

/**
 * Pick up to MAX_ENTRANTS from eligible citizens, weighted by keenness.
 * Pure-ish: (rng, eligible) -> chosen records.
 */
function pickEntrants(rng, eligible) {
  const scored = eligible
    .map((r) => ({ record: r, score: entryKeenness(r) + rng() }))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_ENTRANTS).map((s) => s.record);
}

/**
 * Simulate one tick of catches for an entrant during competition.
 * Higher skill -> more catches, access to rarer fish.
 * Pure: (rng, username) -> [{name, weightKg, rarity}].
 */
function simulateCatches(rng, username) {
  const skill = fishingSkillFor(username);
  // 0-3 catches per tick, scaled by skill.
  const count = Math.floor(rng() * (1 + skill / 30));
  const catches = [];
  const pool = FISH_POOL.filter((f) => f.minSkill <= skill);
  for (let i = 0; i < count && pool.length; i++) {
    // Weight toward common fish; skilled anglers occasionally hit rare ones.
    const idx = Math.floor(Math.pow(rng(), 1 + skill / 50) * pool.length);
    const fish = pool[Math.min(idx, pool.length - 1)];
    // Weight varies ±30% around typical.
    const weightKg = Math.round(fish.weightKg * (0.7 + rng() * 0.6) * 100) / 100;
    catches.push({ name: fish.name, weightKg, rarity: fish.rarity });
  }
  return catches;
}

/**
 * Score the three categories from entrant catch lists.
 * Pure: (entrants: [{username, catches[], isPlayer}]) ->
 *   { biggest: {username, fish, weightKg}, most: {username, count},
 *     rarest: {username, fish, rarity} }.
 */
function scoreCategories(entrants) {
  const result = { biggest: null, most: null, rarest: null };
  for (const e of entrants) {
    const catches = e.catches ?? [];
    const count = catches.length;
    if (!result.most || count > result.most.count) {
      result.most = { username: e.username, count, isPlayer: !!e.isPlayer };
    }
    for (const c of catches) {
      if (!result.biggest || c.weightKg > result.biggest.weightKg) {
        result.biggest = { username: e.username, fish: c.name, weightKg: c.weightKg, isPlayer: !!e.isPlayer };
      }
      if (!result.rarest || c.rarity > result.rarest.rarity) {
        result.rarest = { username: e.username, fish: c.name, rarity: c.rarity, isPlayer: !!e.isPlayer };
      }
    }
  }
  return result;
}

/**
 * Build a fresh tournament in idle with a staggered first start.
 * Pure: (kingdomId, nowMs) -> tournament state.
 */
function newTournament(kingdomId, nowMs) {
  // Stagger: each kingdom's first tournament starts 0-6 days out.
  const delay = Math.floor(hash01(tournamentKey(kingdomId) + ":tourney") * 6 * DAY_MS);
  return {
    kingdomId,
    phase: "idle",
    phaseEndsAt: nowMs + delay,
    entrants: [], // {username, catches[], isPlayer}
    results: null,
    history: [], // past winners for rivalries
  };
}

/** Fill a line template. Pure. */
function fillLine(line, vars) {
  let out = line;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

function journalOne(username, kind, text) {
  try {
    getJournal().log(username, kind, text);
  } catch { /* journal cold — fine */ }
}

// ============================================================================
// Persistence
// ============================================================================

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    for (const [key, t] of Object.entries(data.tournaments ?? {})) {
      if (t && t.kingdomId) tournaments.set(key, t);
    }
  } catch { /* corrupt save — start fresh */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ tournaments: Object.fromEntries(tournaments) }, null, 2));
    dirty = false;
  } catch { /* disk busy — try next tick */ }
}

function saveIfDirty() {
  if (dirty) save();
}

// ============================================================================
// Player integration via custom events
// ============================================================================

/**
 * Register a real player for the current tournament.
 * Safe to call from the event bus at any time.
 */
function handlePlayerRegister(director, event) {
  try {
    const kingdomId = event?.kingdomId;
    const playerName = event?.playerName;
    if (!kingdomId || !playerName) return false;
    const t = tournaments.get(tournamentKey(kingdomId));
    if (!t || !["announcement", "registration"].includes(t.phase)) return false;
    const norm = normalizeName(playerName);
    if (t.entrants.some((e) => normalizeName(e.username) === norm)) return false;
    t.entrants.push({ username: playerName, catches: [], isPlayer: true });
    dirty = true;
    journalOne(playerName, "fishing",
      `Registered for the ${kingdomId} Fishing Tournament.`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a real player's catch during competition.
 * Safe to call from the event bus at any time.
 */
function handlePlayerCatch(director, event) {
  try {
    const kingdomId = event?.kingdomId;
    const playerName = event?.playerName;
    const fishName = event?.fishName;
    const weightKg = Number(event?.weightKg) || 0;
    if (!kingdomId || !playerName || !fishName) return false;
    const t = tournaments.get(tournamentKey(kingdomId));
    if (!t || t.phase !== "competition") return false;
    const norm = normalizeName(playerName);
    let entrant = t.entrants.find((e) => normalizeName(e.username) === norm);
    if (!entrant) {
      // Auto-register late players who start fishing during competition.
      entrant = { username: playerName, catches: [], isPlayer: true };
      t.entrants.push(entrant);
    }
    const poolFish = FISH_POOL.find((f) => f.name === String(fishName).toLowerCase());
    entrant.catches.push({
      name: fishName,
      weightKg,
      rarity: poolFish ? poolFish.rarity : 2,
    });
    dirty = true;
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Phase machine
// ============================================================================

function citizensFor(director, kingdomId) {
  const out = [];
  try {
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdomId === kingdomId) out.push(record);
    }
  } catch { /* roster cold */ }
  return out;
}

/**
 * Advance one tournament's phase machine. Mutates state, journals, and
 * returns player-visible announcements {kind, text}.
 * Pure except journaling: (rng, director, t, nowMs) -> announcements[].
 */
function advanceTournament(rng, director, t, nowMs) {
  const announcements = [];
  if (nowMs < t.phaseEndsAt) return announcements;

  if (t.phase === "idle") {
    t.phase = "announcement";
    t.phaseEndsAt = nowMs + ANNOUNCE_MS;
    t.entrants = [];
    t.results = null;
    dirty = true;
    announcements.push({
      kind: "announce",
      text: fillLine(ANNOUNCE_LINES[Math.floor(rng() * ANNOUNCE_LINES.length)], {
        kingdom: t.kingdomId,
        name: "the harbormaster",
      }),
    });
    for (const c of citizensFor(director, t.kingdomId)) {
      journalOne(c.username, "fishing",
        `Heard about the upcoming ${t.kingdomId} Fishing Tournament.`);
    }
  } else if (t.phase === "announcement") {
    t.phase = "registration";
    t.phaseEndsAt = nowMs + REGISTRATION_MS;
    dirty = true;
    announcements.push({
      kind: "registration",
      text: `Registration is open for the ${t.kingdomId} Fishing Tournament! Sign up at the docks!`,
    });
  } else if (t.phase === "registration") {
    // Close registration: pick the citizen field.
    const eligible = citizensFor(director, t.kingdomId);
    const chosen = pickEntrants(rng, eligible);
    t.entrants = chosen.map((r) => ({ username: r.username, catches: [], isPlayer: false }));
    t.phase = "competition";
    t.phaseEndsAt = nowMs + COMPETITION_MS;
    dirty = true;
    for (const e of t.entrants) {
      journalOne(e.username, "fishing",
        `Entered the ${t.kingdomId} Fishing Tournament.`);
    }
    announcements.push({
      kind: "competition",
      text: `The ${t.kingdomId} Fishing Tournament begins! ${t.entrants.length} anglers compete for biggest, most, and rarest!`,
    });
  } else if (t.phase === "competition") {
    t.phase = "weigh-in";
    t.phaseEndsAt = nowMs + WEIGHIN_MS;
    dirty = true;
    announcements.push({
      kind: "weigh-in",
      text: `Lines in! The ${t.kingdomId} Fishing Tournament weigh-in begins!`,
    });
  } else if (t.phase === "weigh-in") {
    // Score it.
    t.results = scoreCategories(t.entrants);
    t.phase = "prizes";
    t.phaseEndsAt = nowMs + PRIZES_MS;
    dirty = true;
    // Journal winners, losers, and grudges (rivalries).
    const winners = new Set(
      [t.results.biggest, t.results.most, t.results.rarest]
        .filter(Boolean)
        .map((r) => normalizeName(r.username))
    );
    for (const e of t.entrants) {
      if (winners.has(normalizeName(e.username))) {
        const cats = [];
        if (t.results.biggest && normalizeName(t.results.biggest.username) === normalizeName(e.username)) cats.push("biggest fish");
        if (t.results.most && normalizeName(t.results.most.username) === normalizeName(e.username)) cats.push("most fish");
        if (t.results.rarest && normalizeName(t.results.rarest.username) === normalizeName(e.username)) cats.push("rarest catch");
        journalOne(e.username, "fishing",
          `WON the ${t.kingdomId} Fishing Tournament (${cats.join(", ")}).`);
        // Multi-category sweep earns the Master Angler title.
        if (cats.length >= 2) {
          journalOne(e.username, "fishing",
            `Earned the title "Master Angler" of ${t.kingdomId}.`);
        }
      } else {
        const beatBy = [...winners].slice(0, 2).join(" and ");
        journalOne(e.username, "fishing",
          `Lost the ${t.kingdomId} Fishing Tournament${beatBy ? ` to ${beatBy}` : ""}. Will remember this.`);
      }
    }
    t.history.push({ at: nowMs, results: t.results });
    if (t.history.length > 12) t.history = t.history.slice(-12);
    announcements.push({
      kind: "results",
      text: buildResultsText(t),
    });
  } else if (t.phase === "prizes") {
    t.phase = "idle";
    t.phaseEndsAt = nowMs + CYCLE_MS;
    dirty = true;
  }
  return announcements;
}

function buildResultsText(t) {
  const parts = [];
  if (t.results?.biggest) {
    parts.push(`biggest fish: ${t.results.biggest.username} (${t.results.biggest.weightKg}kg ${t.results.biggest.fish})`);
  }
  if (t.results?.most) {
    parts.push(`most fish: ${t.results.most.username} (${t.results.most.count})`);
  }
  if (t.results?.rarest) {
    parts.push(`rarest catch: ${t.results.rarest.username} (${t.results.rarest.fish})`);
  }
  return parts.length
    ? `${t.kingdomId} Fishing Tournament results — ${parts.join("; ")}!`
    : `The ${t.kingdomId} Fishing Tournament ended with no catches.`;
}

/** Emit prize events for each category winner (a gameplay plugin awards coins). */
function emitPrizes(director, t) {
  try {
    if (!t.results) return;
    const placements = [
      ["biggest", t.results.biggest, `${t.results.biggest?.weightKg ?? 0}kg ${t.results.biggest?.fish ?? ""}`],
      ["most", t.results.most, `${t.results.most?.count ?? 0} fish`],
      ["rarest", t.results.rarest, t.results.rarest?.fish ?? ""],
    ];
    for (const [category, winner, detail] of placements) {
      if (!winner) continue;
      try {
        director.api?.emitCustomEvent?.("fishing:tournament-prize", {
          kingdomId: t.kingdomId,
          category,
          winner: winner.username,
          detail,
          prizeCoins: PRIZE_COINS.first,
          isPlayer: !!winner.isPlayer,
        });
      } catch { /* event bus cold */ }
    }
  } catch { /* best-effort */ }
}

// ============================================================================
// Interaction tier: visible banter near real players (scripted, zero LLM)
// ============================================================================

function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch { return false; }
}

function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch { return false; }
}

function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch { return false; }
}

/** Speak an announcement through a citizen near a real player (best-effort). */
function announce(director, t, announcement) {
  try {
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdomId !== t.kingdomId) continue;
      const citizen = (director.isOnline(record) ? director.getBot(record) : null);
      if (!citizen) continue;
      if (!anyRealPlayerNear(director, citizen, TOURNAMENT_RADIUS)) continue;
      citizen.forceChat?.(announcement.text.slice(0, 120));
      return;
    }
  } catch { /* visible announcement is best-effort */ }
}

/** Trash-talk and catch calls during registration/competition (scripted). */
function banter(director, t, nowMs, rng) {
  try {
    if (!["registration", "competition"].includes(t.phase)) return;
    if (!t.entrants.length) return;
    const positions = director.realPlayerPositions?.() ?? [];
    for (const e of t.entrants) {
      if (e.isPlayer) continue; // players speak for themselves
      const last = trashtalkCooldowns.get(normalizeName(e.username)) || 0;
      if (nowMs - last < TRASHTALK_COOLDOWN_MS) continue;
      const record = director.roster?.get?.(normalizeName(e.username));
      const citizen = record ? (director.isOnline(record) ? director.getBot(record) : null) : null;
      if (!citizen) continue;
      if (!anyRealPlayerNear(director, citizen, TOURNAMENT_RADIUS)) continue;
      const chance = t.phase === "registration" ? TRASHTALK_CHANCE : CATCH_CALL_CHANCE;
      if (rng() > chance) continue;

      let line;
      if (t.phase === "registration") {
        // Pick a rival from the entrants for directed trash-talk.
        const rivals = t.entrants.filter((x) => normalizeName(x.username) !== normalizeName(e.username));
        const rival = rivals.length ? rivals[Math.floor(rng() * rivals.length)].username : "everyone";
        const pool = TRASHTALK_LINES.filter((l) => l.includes("{rival}") === (rival !== "everyone"))
          .concat(TRASHTALK_LINES.filter((l) => !l.includes("{rival}")));
        line = fillLine(pool[Math.floor(rng() * pool.length)], { name: e.username, rival });
      } else {
        // Competition: call out the latest catch, or boast.
        const lastCatch = (e.catches ?? [])[(e.catches ?? []).length - 1];
        const fish = lastCatch ? lastCatch.name : "a nibble";
        line = fillLine(CATCH_LINES[Math.floor(rng() * CATCH_LINES.length)], {
          name: e.username,
          fish,
        });
      }
      citizen.forceChat?.(line.slice(0, 120));
      trashtalkCooldowns.set(normalizeName(e.username), nowMs);
    }
  } catch (e) {
    console.warn("[citizen-fishing] banter failed:", e?.message ?? e);
  }
}

/** Winners celebrate and losers grumble during the prizes phase. */
function celebrate(director, t, nowMs, rng) {
  try {
    if (t.phase !== "prizes" || !t.results) return;
    const winners = new Set(
      [t.results.biggest, t.results.most, t.results.rarest]
        .filter(Boolean)
        .map((r) => normalizeName(r.username))
    );
    for (const e of t.entrants) {
      if (e.isPlayer) continue;
      const last = trashtalkCooldowns.get(normalizeName(e.username)) || 0;
      if (nowMs - last < TRASHTALK_COOLDOWN_MS) continue;
      const record = director.roster?.get?.(normalizeName(e.username));
      const citizen = record ? (director.isOnline(record) ? director.getBot(record) : null) : null;
      if (!citizen) continue;
      if (!anyRealPlayerNear(director, citizen, TOURNAMENT_RADIUS)) continue;
      if (rng() > TRASHTALK_CHANCE) continue;

      let line;
      if (winners.has(normalizeName(e.username))) {
        const cats = [];
        if (t.results.biggest && normalizeName(t.results.biggest.username) === normalizeName(e.username)) {
          cats.push(["biggest fish", `${t.results.biggest.weightKg}kg ${t.results.biggest.fish}`]);
        }
        if (t.results.most && normalizeName(t.results.most.username) === normalizeName(e.username)) {
          cats.push(["most fish", `${t.results.most.count} fish`]);
        }
        if (t.results.rarest && normalizeName(t.results.rarest.username) === normalizeName(e.username)) {
          cats.push(["rarest catch", `a ${t.results.rarest.fish}`]);
        }
        const [category, detail] = cats[0] ?? ["champion", "the day"];
        line = fillLine(WIN_LINES[Math.floor(rng() * WIN_LINES.length)], {
          name: e.username,
          category,
          detail,
        });
      } else {
        line = fillLine(GRUMBLE_LINES[Math.floor(rng() * GRUMBLE_LINES.length)], {
          name: e.username,
        });
      }
      citizen.forceChat?.(line.slice(0, 120));
      trashtalkCooldowns.set(normalizeName(e.username), nowMs);
    }
  } catch (e) {
    console.warn("[citizen-fishing] celebrate failed:", e?.message ?? e);
  }
}

// ============================================================================
// The tick — slow director tick (~60s).
// ============================================================================

function ensureTournaments(director, nowMs) {
  try {
    const kingdoms = new Set();
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdomId) kingdoms.add(record.kingdomId);
    }
    for (const kingdomId of kingdoms) {
      const key = tournamentKey(kingdomId);
      if (!tournaments.has(key)) {
        tournaments.set(key, newTournament(kingdomId, nowMs));
        dirty = true;
      }
    }
  } catch { /* roster cold */ }
}

function tickFishingTournaments(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    ensureTournaments(director, nowMs);
    const rng = Math.random;
    for (const t of tournaments.values()) {
      try {
        // Competition: simulate catches for citizen entrants.
        if (t.phase === "competition") {
          for (const e of t.entrants) {
            if (e.isPlayer) continue; // real catches come via events
            try {
              const fresh = simulateCatches(rng, e.username);
              e.catches.push(...fresh);
              if (fresh.length) dirty = true;
            } catch { /* one bad entrant never breaks the tick */ }
          }
        }
        const announcements = advanceTournament(rng, director, t, nowMs);
        for (const a of announcements) {
          announce(director, t, a);
          if (a.kind === "results") emitPrizes(director, t);
        }
      } catch (e) {
        // One bad tournament never breaks the tick.
        console.warn("[citizen-fishing] tournament failed:", e?.message ?? e);
      }
    }
    // Visible banter near real players.
    for (const t of tournaments.values()) {
      try {
        banter(director, t, nowMs, rng);
        celebrate(director, t, nowMs, rng);
      } catch (e) {
        console.warn("[citizen-fishing] banter pass failed:", e?.message ?? e);
      }
    }
    saveIfDirty();
  } catch (e) {
    console.warn("[citizen-fishing] tick failed:", e?.message ?? e);
  }
}

load();

module.exports = {
  tickFishingTournaments,
  handlePlayerRegister,
  handlePlayerCatch,
  saveIfDirty,
  // Pure helpers for tests:
  FISH_POOL,
  PRIZE_COINS,
  tournamentKey,
  hash01,
  fishingSkillFor,
  entryKeenness,
  pickEntrants,
  simulateCatches,
  scoreCategories,
  newTournament,
  advanceTournament,
  buildResultsText,
  fillLine,
  ANNOUNCE_MS,
  REGISTRATION_MS,
  COMPETITION_MS,
  WEIGHIN_MS,
  PRIZES_MS,
  CYCLE_MS,
  MAX_ENTRANTS,
  // Test seam:
  _tournaments: tournaments,
};
