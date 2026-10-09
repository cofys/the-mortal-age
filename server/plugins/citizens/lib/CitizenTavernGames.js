"use strict";

/**
 * CitizenTavernGames — citizens play tavern games: dice, cards, arm wrestling,
 * and drinking contests.
 *
 * Taverns are the social heart of a capital: citizens gather in the evenings
 * and play. Games create crowds, noise, rivalries, and local champions — and
 * give real players something to watch, join, and bet alongside.
 *
 * WHAT IT DOES (data tier, free):
 *   Each kingdom runs a game-night phase machine on the slow (~60s) director
 *   tick: idle -> forming (challenges issued at the tavern) -> playing
 *   (rounds resolved data-tier) -> wrapup (champion recorded, rivalries
 *   journaled) -> idle until the next evening. Every game, wager, win, and
 *   loss is journaled, so when a player asks "how'd the dice go last night?",
 *   the foreground LLM speaks truthfully. Champions and rivalries persist to
 *   disk. Runs with 170 citizens and zero players online without spending a
 *   token.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Challenge calls, round banter, crowd reactions, and winner announcements
 *   as scripted forceChat lines (personality-gated) when a real player is
 *   within earshot of the tavern. Players can join games via the
 *   `tavern:game-join` custom event and report results via
 *   `tavern:game-result`; winners are announced via `tavern:game-prize` so a
 *   gameplay plugin can award coins. All visible lines are scripted pools;
 *   the LLM handles free-form banter only in direct conversation (reads the
 *   journaled games).
 *
 * Zero LLM: every forceChat line comes from the curated pools below. The
 * foreground LLM never runs in this tick path.
 *
 * Wiring: slow director tick calls tickTavernGames(this, hour, nowMs) after
 * the toasts block. Plain-node testable: CitizenTavernGames.test.js.
 */

const fs = require("fs");
const path = require("path");
const { agentRng, chance, humanizerProfile } = require("./humanizer");
const { getJournal } = require("./CitizenJournal");
const { isFriend, isEnemy, normalizeName } = require("./CitizenBonds");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-tavern-games.json");

// === Tuning: all magic numbers here ===
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

const FORMING_MS = 3 * MIN_MS;    // challenges + gathering
const PLAYING_MS = 10 * MIN_MS;   // rounds resolve (data tier, fast)
const WRAPUP_MS = 5 * MIN_MS;     // champion announced, crowd disperses
const NIGHT_GAP_MIN_MS = 90 * MIN_MS;   // shortest gap between game nights
const NIGHT_GAP_MAX_MS = 5 * HOUR_MS;   // longest gap

const TAVERN_RADIUS = 16;         // tiles — close enough to hear the game
const MAX_SPECTATORS = 6;         // crowd cap
const HOST_RADIUS = 30;           // host must be near the tavern
const CHALLENGER_RADIUS = 45;     // challenger/spectator search radius

const FORM_CHANCE_EVENING = 0.16; // per kingdom per ~60s tick, 18:00-01:59
const FORM_CHANCE_DAY = 0.02;     // daytime games are rare

const BANTER_CHANCE = 0.45;       // per game night per slow tick near a player
const BANTER_COOLDOWN_MS = 30 * MIN_MS;

const WAGER_BASE_MIN = 50;        // coins — journaled, never moved for real
const WAGER_BASE_MAX = 200;

// === Game types ===
const GAME_TYPES = Object.freeze(["dice", "cards", "armwrestle", "drinking"]);

const GAME_LABELS = Object.freeze({
  dice: "dice",
  cards: "cards",
  armwrestle: "arm wrestling",
  drinking: "a drinking contest",
});

// === Scripted line pools (zero LLM). {a} = host, {b} = challenger, {w} = winner. ===
const CHALLENGE_LINES = Object.freeze([
  "{a}: \"Fancy a game of {game}, {b}? Loser buys the next round!\"",
  "{a}: \"Dice! Cards! Arm wrestling! Who's brave enough to face me at {game}?\"",
  "*{a} slaps the tavern table* \"{b}! {game}. You and me. Right now!\"",
  "{a}: \"I hear you're the one to beat at {game}, {b}. Prove it.\"",
  "{a}: \"Come on, {b}. A friendly game of {game}. What are you afraid of?\"",
]);

const CROWD_LINES = Object.freeze([
  "Oooooh!",
  "Come on, come on!",
]);

const ROUND_LINES = Object.freeze({
  dice: [
    "{a}: \"Double sixes! Read them and weep!\"",
    "{b}: \"No way. No WAY. Roll again!\"",
  ],
  cards: [
    "{b}: \"He's bluffing. I can always tell.\"",
    "{a}: \"All in. Call it or fold.\"",
  ],
  armwrestle: [
    "{a}: \"Grr... you're stronger than you look!\"",
  ],
  drinking: [
    "{b}: \"*hic*... one more. I can do one more.\"",
    "{a}: \"Is the room spinning, or is it just me?\"",
  ],
});

const WIN_LINES = Object.freeze([
  "{w} wins the {game}! The tavern erupts!",
  "*{w} leaps up, arms raised* — {game} champion of the night!",
  "Unbelievable! {w} takes the {game}!",
  "{w}: \"Ha! Told you! Drinks are on {l}!\"",
]);

const LOSE_LINES = Object.freeze([
  "{l}: \"Best two out of three. I demand a rematch!\"",
  "{l}: \"The dice hate me. They have always hated me.\"",
  "{l}: \"You got lucky. That's all. Lucky.\"",
]);

const CHAMPION_LINES = Object.freeze([
  "They call {w} the {game} champion of {kingdom} now — {wins} wins and counting!",
  "*{w} gets a round of applause* — still the {game} champion!",
]);

const RIVALRY_LINES = Object.freeze([
  "{w} has beaten {l} at {game} three times running. This is a rivalry now.",
  "Everyone's watching {w} vs {l} — the tavern's favorite {game} feud.",
]);

// === State ===
const gameNights = new Map(); // kingdomId -> game night state
const banterCooldowns = new Map(); // kingdomId -> timestamp
let dirty = false;

// Champions persisted to disk: kingdomId -> { [gameType]: {champion, wins, streak}, rivalries: [...] }
const champions = new Map();

// Memory-leak plug.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of banterCooldowns) {
    if (at < cutoff) banterCooldowns.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic FNV-1a hash -> [0,1). */
function hash01(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * A citizen's game skill: deterministic 1-99 per game type from username.
 * Stable across restarts, so form and rivalries persist.
 * Pure: (username, gameType) -> 1..99.
 */
function skillFor(username, gameType) {
  return 1 + Math.floor(hash01(`tavern:${gameType}:` + normalizeName(username)) * 99);
}

/**
 * How keen a citizen is to play a given game: personality-driven.
 * Bold/brash love cards; cheerful/chatty love drinking; guards and
 * laborers love arm wrestling; everyone dabbles in dice.
 * Pure: (record, gameType) -> 0..1.
 */
function playKeenness(record, gameType) {
  const traits = (record.personality?.traits ?? []).map((t) => String(t).toLowerCase());
  const demeanor = String(record.personality?.demeanor ?? "").toLowerCase();
  let score = 0.35; // baseline curiosity
  if (gameType === "dice") {
    if (traits.includes("impulsive") || traits.includes("cheerful")) score += 0.25;
    if (traits.includes("cautious") || traits.includes("methodical")) score -= 0.15;
  } else if (gameType === "cards") {
    if (demeanor.includes("bold") || demeanor.includes("brash") || traits.includes("cunning")) score += 0.3;
    if (demeanor.includes("nervous") || traits.includes("honest")) score -= 0.2;
  } else if (gameType === "armwrestle") {
    if (record.role === "guard") score += 0.35;
    if (traits.includes("strong") || traits.includes("boastful")) score += 0.25;
    if (demeanor.includes("frail") || traits.includes("elderly")) score -= 0.3;
  } else if (gameType === "drinking") {
    if (traits.includes("cheerful") || traits.includes("chatty") || traits.includes("boisterous")) score += 0.3;
    if (traits.includes("sober") || traits.includes("dutiful")) score -= 0.25;
  }
  const profile = humanizerProfile(record.personality);
  score *= 0.7 + profile.sociability * 0.3;
  return Math.max(0, Math.min(1, score));
}

/**
 * Wager sizing: personality-driven risk-taking. Bold citizens bet big,
 * cautious ones bet small. Journaled only — no real coins move between
 * citizens. Pure: (record, rng) -> coins.
 */
function wagerFor(record, rng) {
  const profile = humanizerProfile(record.personality);
  const base = WAGER_BASE_MIN + rng() * (WAGER_BASE_MAX - WAGER_BASE_MIN);
  const wager = Math.round((base * profile.riskTolerance) / 10) * 10;
  return Math.max(10, Math.min(1000, wager));
}

/** Pick a game type, weighted slightly toward what the host likes. Pure. */
function pickGameType(rng, hostRecord) {
  const weights = GAME_TYPES.map((g) => 1 + playKeenness(hostRecord, g) * 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < GAME_TYPES.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return GAME_TYPES[i];
  }
  return GAME_TYPES[0];
}

/**
 * Resolve a dice game: 2d6 each, high wins; ties reroll (max 3), then draw.
 * Pure: (rng, skillA, skillB) -> { winner: "a"|"b"|"draw", aTotal, bTotal }.
 * Skill nudges the dice: higher skill rolls 2d6+skill/25.
 */
function resolveDice(rng, skillA, skillB) {
  const roll = (skill) => {
    const d1 = 1 + Math.floor(rng() * 6);
    const d2 = 1 + Math.floor(rng() * 6);
    return d1 + d2 + Math.floor(skill / 25);
  };
  let aTotal = 0, bTotal = 0;
  for (let i = 0; i < 3; i++) {
    aTotal = roll(skillA);
    bTotal = roll(skillB);
    if (aTotal !== bTotal) break;
  }
  if (aTotal === bTotal) return { winner: "draw", aTotal, bTotal };
  return { winner: aTotal > bTotal ? "a" : "b", aTotal, bTotal };
}

/**
 * Resolve a cards game: hidden draw 1-10 plus bluff.
 * Bold citizens bluff (higher variance, higher ceiling); nervous ones play
 * straight. Pure: (rng, skillA, skillB, boldA, boldB) -> result.
 */
function resolveCards(rng, skillA, skillB, boldA, boldB) {
  const hand = (skill, bold) => {
    const draw = 1 + Math.floor(rng() * 10);
    const read = skill / 12; // reading the table
    const bluff = bold ? rng() * 4 : 0; // bluffs sometimes pay off
    return draw + read + bluff;
  };
  const aTotal = hand(skillA, boldA);
  const bTotal = hand(skillB, boldB);
  if (Math.abs(aTotal - bTotal) < 0.5) return { winner: "draw", aTotal, bTotal };
  return { winner: aTotal > bTotal ? "a" : "b", aTotal, bTotal };
}

/**
 * Resolve arm wrestling: best of 3 rounds; strength = skill + role bonus.
 * Guards and laborers are built for it.
 * Pure: (rng, strengthA, strengthB) -> { winner, rounds: [..] }.
 */
function resolveArmwrestle(rng, strengthA, strengthB) {
  const rounds = [];
  let aWins = 0, bWins = 0;
  for (let i = 0; i < 3 && aWins < 2 && bWins < 2; i++) {
    const a = rng() * strengthA;
    const b = rng() * strengthB;
    const w = a === b ? (rng() < 0.5 ? "a" : "b") : a > b ? "a" : "b";
    rounds.push(w);
    if (w === "a") aWins++; else bWins++;
  }
  return { winner: aWins > bWins ? "a" : "b", rounds };
}

/**
 * Resolve a drinking contest: rounds of constitution checks. Each round the
 * mug count rises and effective constitution falls. First to fail loses.
 * Pure: (rng, conA, conB) -> { winner, rounds }.
 */
function resolveDrinking(rng, conA, conB) {
  let rounds = 0;
  let aOut = false, bOut = false;
  while (!aOut && !bOut && rounds < 20) {
    rounds++;
    const penalty = rounds * 8;
    if (rng() * 100 > conA - penalty) aOut = true;
    if (rng() * 100 > conB - penalty) bOut = true;
  }
  if (aOut && bOut) return { winner: "draw", rounds };
  if (aOut) return { winner: "b", rounds };
  return { winner: "a", rounds };
}

/** Role-based strength bonus for arm wrestling. Pure. */
function strengthBonus(role) {
  if (role === "guard") return 15;
  if (role === "merchant") return 2;
  return 5; // commoners, courtiers, refugees: ordinary folk
}

/** Is this citizen bold enough to bluff at cards? Pure. */
function isBold(record) {
  const demeanor = String(record.personality?.demeanor ?? "").toLowerCase();
  const traits = (record.personality?.traits ?? []).map((t) => String(t).toLowerCase());
  return demeanor.includes("bold") || demeanor.includes("brash") || traits.includes("cunning");
}

/** Fill a line template. Pure. */
function fillLine(line, vars) {
  let out = line;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

function journalOne(username, text) {
  try {
    getJournal().log(username, "tavern", text);
  } catch { /* journal cold — fine */ }
}

// ============================================================================
// Persistence (champions + rivalries)
// ============================================================================

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    for (const [key, c] of Object.entries(data.champions ?? {})) {
      if (c) champions.set(key, c);
    }
  } catch { /* corrupt save — start fresh */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ champions: Object.fromEntries(champions) }, null, 2));
    dirty = false;
  } catch { /* disk busy — try next tick */ }
}

function saveIfDirty() {
  if (dirty) save();
}

function championRecord(kingdomId) {
  const key = String(kingdomId);
  if (!champions.has(key)) {
    champions.set(key, {
      dice: { champion: null, wins: 0 },
      cards: { champion: null, wins: 0 },
      armwrestle: { champion: null, wins: 0 },
      drinking: { champion: null, wins: 0 },
      rivalries: [], // { a, b, gameType, losses }
    });
    dirty = true;
  }
  return champions.get(key);
}

// ============================================================================
// Player integration via custom events (documented; a gameplay plugin wires these)
// ============================================================================

/**
 * Register a real player for the forming game.
 * Safe to call from the event bus at any time.
 * Event: { kingdomId, gameType?, playerName }
 */
function handlePlayerJoin(director, event) {
  try {
    const kingdomId = event?.kingdomId;
    const playerName = event?.playerName;
    if (!kingdomId || !playerName) return false;
    const night = gameNights.get(String(kingdomId));
    if (!night || night.phase !== "forming") return false;
    const norm = normalizeName(playerName);
    if (normalizeName(night.host.username) === norm) return false;
    if (night.players.some((p) => normalizeName(p.username) === norm)) return false;
    night.players.push({ username: playerName, isPlayer: true });
    dirty = true;
    journalOne(playerName, `Joined a tavern ${GAME_LABELS[night.gameType]} game against ${night.host.username}.`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report a real player's game result during the playing phase.
 * Safe to call from the event bus at any time.
 * Event: { kingdomId, playerName, won }
 */
function handlePlayerResult(director, event) {
  try {
    const kingdomId = event?.kingdomId;
    const playerName = event?.playerName;
    if (!kingdomId || !playerName || typeof event?.won !== "boolean") return false;
    const night = gameNights.get(String(kingdomId));
    if (!night || night.phase !== "playing") return false;
    const norm = normalizeName(playerName);
    const playerEntry = night.players.find((p) => normalizeName(p.username) === norm && p.isPlayer);
    if (!playerEntry) return false;
    night.result = {
      winner: event.won ? norm : normalizeName(night.host.username),
      loser: event.won ? normalizeName(night.host.username) : norm,
      isPlayer: true,
      draw: false,
    };
    dirty = true;
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Tavern anchor + citizen selection
// ============================================================================

function botTile(bot) {
  try {
    const loc = bot.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ?.() ?? 0 };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Tavern anchor tile for a kingdom; null if none (Keldagrim fallback: square). */
function tavernAnchor(kingdomId) {
  const tavern = siteTileByKingdom(kingdomId, "tavern");
  if (tavern) return { tile: tavern, kind: "tavern" };
  const square = siteTileByKingdom(kingdomId, "square");
  if (square) return { tile: square, kind: "square" };
  return null;
}

function nearTavern(director, record, tile, radius) {
  try {
    if (!director.isOnline?.(record)) return false;
    const bot = director.getBot?.(record);
    if (!bot) return false;
    const t = botTile(bot);
    return t && chebyshev(t, tile) <= radius;
  } catch {
    return false;
  }
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Choose a host (sociable, at the tavern) and a challenger (not an enemy,
 * friends preferred). Pure-ish given candidate lists.
 */
function pickPlayers(rng, candidates, hostRecord) {
  const hosts = candidates.filter(
    (r) => r !== hostRecord && humanizerProfile(r.personality).sociability >= 0.9
  );
  if (!hosts.length) return null;
  const host = pickOne(rng, hosts);
  const others = candidates.filter(
    (r) => r !== host && !isEnemy(host.username, r.username)
  );
  if (!others.length) return null;
  // Friends first, then anyone sociable enough to play.
  const scored = others.map((r) => {
    let score = rng() + playKeenness(r, "dice");
    if (isFriend(host.username, r.username)) score += 1.5;
    return { record: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return { host, challenger: scored[0].record };
}

// ============================================================================
// Phase machine
// ============================================================================

function isEvening(hour) {
  return hour >= 18 || hour <= 1;
}

function ensureNights(director, nowMs) {
  try {
    const kingdoms = new Set();
    for (const record of director.roster?.values?.() ?? []) {
      if (record.kingdomId) kingdoms.add(String(record.kingdomId));
    }
    for (const kingdomId of kingdoms) {
      if (!gameNights.has(kingdomId)) {
        const stagger = Math.floor(hash01(`tavern:night:${kingdomId}`) * (NIGHT_GAP_MAX_MS - NIGHT_GAP_MIN_MS));
        gameNights.set(kingdomId, {
          kingdomId,
          phase: "idle",
          phaseEndsAt: nowMs + NIGHT_GAP_MIN_MS + stagger,
          gameType: null,
          host: null,
          players: [],
          spectators: [],
          wager: 0,
          result: null,
          anchor: null,
        });
      }
    }
  } catch { /* roster cold */ }
}

/** Resolve one game between host (a) and challenger (b). Pure. */
function resolveGame(rng, gameType, hostRecord, challengerRecord) {
  const aName = normalizeName(hostRecord.username);
  const bName = normalizeName(challengerRecord.username);
  const skillA = skillFor(aName, gameType);
  const skillB = skillFor(bName, gameType);
  let raw;
  if (gameType === "dice") raw = resolveDice(rng, skillA, skillB);
  else if (gameType === "cards") raw = resolveCards(rng, skillA, skillB, isBold(hostRecord), isBold(challengerRecord));
  else if (gameType === "armwrestle") {
    raw = resolveArmwrestle(rng, skillA + strengthBonus(hostRecord.role), skillB + strengthBonus(challengerRecord.role));
  } else raw = resolveDrinking(rng, skillA, skillB);

  if (raw.winner === "draw") {
    return { winner: null, loser: null, draw: true, detail: raw };
  }
  const winner = raw.winner === "a" ? aName : bName;
  const loser = raw.winner === "a" ? bName : aName;
  return { winner, loser, draw: false, detail: raw };
}

function advanceNight(rng, director, night, nowMs, hour) {
  const announcements = [];
  if (nowMs < night.phaseEndsAt) return announcements;

  if (night.phase === "idle") {
    // Form a game night: evening-weighted.
    const p = isEvening(hour) ? FORM_CHANCE_EVENING : FORM_CHANCE_DAY;
    night.phaseEndsAt = nowMs + MIN_MS; // re-roll soon if it doesn't fire
    if (!chance(rng, p)) return announcements;
    const anchor = tavernAnchor(night.kingdomId);
    if (!anchor) return announcements;
    const candidates = [];
    try {
      for (const record of director.roster?.values?.() ?? []) {
        if (String(record.kingdomId) !== night.kingdomId) continue;
        if (record.role === "guard") continue; // guards are on duty
        if (!nearTavern(director, record, anchor.tile, CHALLENGER_RADIUS)) continue;
        candidates.push(record);
      }
    } catch { /* roster cold */ }
    if (candidates.length < 2) return announcements;
    const picked = pickPlayers(rng, candidates, null);
    if (!picked) return announcements;

    night.gameType = pickGameType(rng, picked.host);
    night.host = picked.host;
    night.players = [
      { username: picked.host.username, isPlayer: false },
      { username: picked.challenger.username, isPlayer: false },
    ];
    night.spectators = candidates
      .filter((r) => r !== picked.host && r !== picked.challenger)
      .slice(0, MAX_SPECTATORS)
      .map((r) => r.username);
    night.wager = wagerFor(picked.host, rng);
    night.result = null;
    night.anchor = anchor;
    night.phase = "forming";
    night.phaseEndsAt = nowMs + FORMING_MS;
    dirty = true;

    const label = GAME_LABELS[night.gameType];
    journalOne(picked.host.username,
      `Challenged ${picked.challenger.username} to ${label} at the ${anchor.kind} (${night.wager} coin wager).`);
    journalOne(picked.challenger.username,
      `Accepted ${picked.host.username}'s ${label} challenge (${night.wager} coins on the line).`);
    announcements.push({
      kind: "challenge",
      text: fillLine(pickOne(rng, CHALLENGE_LINES), {
        a: picked.host.username,
        b: picked.challenger.username,
        game: label,
      }),
    });
  } else if (night.phase === "forming") {
    night.phase = "playing";
    night.phaseEndsAt = nowMs + PLAYING_MS;
    dirty = true;
  } else if (night.phase === "playing") {
    // Resolve the game (player results already recorded via events).
    if (!night.result) {
      night.result = resolveGame(rng, night.gameType, night.host,
        findRecord(director, night.players[1]?.username) ?? night.host);
    }
    night.phase = "wrapup";
    night.phaseEndsAt = nowMs + WRAPUP_MS;
    dirty = true;

    const label = GAME_LABELS[night.gameType];
    if (night.result.draw) {
      for (const p of night.players) {
        if (!p.isPlayer) journalOne(p.username, `Drew a tavern ${label} game against ${otherName(night, p.username)}.`);
      }
      announcements.push({ kind: "draw", text: `The ${label} game ends in a draw! The crowd demands a rematch!` });
    } else {
      const w = night.result.winner;
      const l = night.result.loser;
      if (!night.result.isPlayer) {
        journalOne(w, `Won ${night.wager} coins from ${l} at tavern ${label}.`);
        journalOne(l, `Lost ${night.wager} coins to ${w} at tavern ${label}.`);
      }
      updateChampions(director, night, rng, announcements);
      announcements.push({
        kind: "win",
        text: fillLine(pickOne(rng, WIN_LINES), { w, l, game: label }),
      });
      announcements.push({
        kind: "lose",
        text: fillLine(pickOne(rng, LOSE_LINES), { w, l, game: label }),
      });
    }
  } else if (night.phase === "wrapup") {
    night.phase = "idle";
    night.phaseEndsAt = nowMs + NIGHT_GAP_MIN_MS + Math.floor(rng() * (NIGHT_GAP_MAX_MS - NIGHT_GAP_MIN_MS));
    night.gameType = null;
    night.host = null;
    night.players = [];
    night.spectators = [];
    night.result = null;
    night.anchor = null;
    dirty = true;
  }
  return announcements;
}

function findRecord(director, username) {
  try {
    const norm = normalizeName(username);
    for (const record of director.roster?.values?.() ?? []) {
      if (normalizeName(record.username) === norm) return record;
    }
  } catch { /* roster cold */ }
  return null;
}

function otherName(night, username) {
  const other = night.players.find((p) => normalizeName(p.username) !== normalizeName(username));
  return other ? other.username : "their opponent";
}

/** Update champion records and detect rivalries. */
function updateChampions(director, night, rng, announcements) {
  try {
    const rec = championRecord(night.kingdomId);
    const slot = rec[night.gameType];
    const w = night.result.winner;
    const l = night.result.loser;
    const label = GAME_LABELS[night.gameType];
    if (!slot) return;

    const wNorm = normalizeName(w);
    if (normalizeName(slot.champion) === wNorm) {
      slot.wins += 1;
      journalOne(w, `Defended the ${night.kingdomId} ${label} championship (${slot.wins} wins).`);
    } else {
      const old = slot.champion;
      slot.champion = w;
      slot.wins = 1;
      journalOne(w, `Became the ${night.kingdomId} ${label} champion${old ? `, dethroning ${old}` : ""}.`);
      if (old) journalOne(old, `Lost the ${night.kingdomId} ${label} championship to ${w}.`);
    }
    dirty = true;

    // Rivalry: same winner beats same loser 3 times in this game type.
    if (l) {
      let rivalry = rec.rivalries.find(
        (r) => r.gameType === night.gameType &&
          normalizeName(r.a) === wNorm && normalizeName(r.b) === normalizeName(l)
      );
      if (!rivalry) {
        rivalry = { a: w, b: l, gameType: night.gameType, losses: 0 };
        rec.rivalries.push(rivalry);
      }
      rivalry.losses += 1;
      dirty = true;
      if (rivalry.losses === 3) {
        journalOne(w, `Has beaten ${l} at ${label} three times running — a real tavern rivalry.`);
        journalOne(l, `Has lost to ${w} at ${label} three times running — wants revenge.`);
        announcements.push({
          kind: "rivalry",
          text: fillLine(pickOne(rng, RIVALRY_LINES), { w, l, game: label }),
        });
      }
    }

    // Emit a prize event so a gameplay plugin can award coins.
    try {
      director.api?.emitCustomEvent?.("tavern:game-prize", {
        kingdomId: night.kingdomId,
        gameType: night.gameType,
        winner: w,
        detail: `${label} winner`,
        wagerCoins: night.wager,
        isPlayer: !!night.result.isPlayer,
      });
    } catch { /* event bus cold */ }
  } catch { /* champion bookkeeping is best-effort */ }
}

// ============================================================================
// Interaction tier: visible game banter near real players (scripted, zero LLM)
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
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch { return false; }
}

/** Speak through a materialized citizen near a real player (best-effort). */
function sayThrough(director, username, text) {
  try {
    const record = findRecord(director, username);
    if (!record) return false;
    const citizen = director.getBot?.(record);
    if (!citizen) return false;
    if (!anyRealPlayerNear(director, citizen, TAVERN_RADIUS)) return false;
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [String(text).slice(0, 120)] })); }
    return true;
  } catch { return false; }
}

/** Announce game events through someone at the table, plus crowd noise. */
function visibleAnnounce(director, night, announcement, rng) {
  try {
    const anchor = night.anchor;
    if (!anchor) return;
    // Find a materialized citizen near the tavern with a real player watching.
    let speaker = null;
    try {
      for (const record of director.roster?.values?.() ?? []) {
        if (String(record.kingdomId) !== night.kingdomId) continue;
        const citizen = director.getBot?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, TAVERN_RADIUS)) continue;
        const t = botTile(citizen);
        if (t && chebyshev(t, anchor.tile) <= TAVERN_RADIUS + 10) {
          speaker = citizen;
          break;
        }
      }
    } catch { /* best-effort */ }
    if (!speaker) return;
    { const _cvp = speaker.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(speaker, voiceLine(voiceFor(_cvp), { plain: [String(announcement.text).slice(0, 140)] })); }
    // Crowd noise on big moments: spectators react.
    if (["win", "rivalry", "draw"].includes(announcement.kind) && chance(rng, 0.6)) {
      const crowdLine = pickOne(rng, CROWD_LINES);
      // A spectator says it, if one is materialized.
      for (const s of night.spectators) {
        if (sayThrough(director, s, crowdLine)) break;
      }
    }
  } catch { /* visible output is best-effort */ }
}

/** Ambient mid-game banter: round lines + crowd reactions. */
function gameBanter(director, night, nowMs, rng) {
  try {
    if (!["forming", "playing"].includes(night.phase)) return;
    if (!night.anchor) return;
    const last = banterCooldowns.get(night.kingdomId) || 0;
    if (nowMs - last < BANTER_COOLDOWN_MS) return;
    if (rng() > BANTER_CHANCE) return;

    // Need a real player watching.
    let watching = false;
    try {
      for (const record of director.roster?.values?.() ?? []) {
        if (String(record.kingdomId) !== night.kingdomId) continue;
        const citizen = director.getBot?.(record);
        if (!citizen) continue;
        const t = botTile(citizen);
        if (t && chebyshev(t, night.anchor.tile) <= TAVERN_RADIUS + 10 &&
            anyRealPlayerNear(director, citizen, TAVERN_RADIUS)) {
          watching = true;
          break;
        }
      }
    } catch { /* best-effort */ }
    if (!watching) return;

    const [a, b] = night.players;
    const label = GAME_LABELS[night.gameType];
    const pool = ROUND_LINES[night.gameType] ?? [];
    if (!pool.length || !a || !b) return;
    const line = fillLine(pickOne(rng, pool), {
      a: a.username, b: b.username, game: label,
    });
    // A player at the table says the round line; sometimes the crowd chimes in.
    const speaker = rng() < 0.7 ? (rng() < 0.5 ? a.username : b.username)
      : pickOne(rng, night.spectators.length ? night.spectators : [a.username]);
    if (sayThrough(director, speaker, line)) {
      banterCooldowns.set(night.kingdomId, nowMs);
      if (chance(rng, 0.35)) {
        for (const s of night.spectators) {
          if (sayThrough(director, s, pickOne(rng, CROWD_LINES))) break;
        }
      }
    }
  } catch (e) {
    console.warn("[citizen-tavern-games] banter failed:", e?.message ?? e);
  }
}

// ============================================================================
// The tick — slow director tick (~60s).
// ============================================================================

function tickTavernGames(director, hour, nowMs) {
  pruneCooldowns(nowMs);
  try {
    ensureNights(director, nowMs);
    const rng = agentRng(`tavern-games:${nowMs >> 16}`);
    for (const night of gameNights.values()) {
      try {
        const announcements = advanceNight(rng, director, night, nowMs, hour);
        for (const a of announcements) visibleAnnounce(director, night, a, rng);
      } catch (e) {
        console.warn("[citizen-tavern-games] night failed:", e?.message ?? e);
      }
    }
    // Mid-game banter near real players.
    for (const night of gameNights.values()) {
      try {
        gameBanter(director, night, nowMs, rng);
      } catch (e) {
        console.warn("[citizen-tavern-games] banter pass failed:", e?.message ?? e);
      }
    }
    saveIfDirty();
  } catch (e) {
    console.warn("[citizen-tavern-games] tick failed:", e?.message ?? e);
  }
}

load();

module.exports = {
  tickTavernGames,
  handlePlayerJoin,
  handlePlayerResult,
  saveIfDirty,
  // Pure helpers for tests:
  GAME_TYPES,
  GAME_LABELS,
  hash01,
  skillFor,
  playKeenness,
  wagerFor,
  pickGameType,
  resolveDice,
  resolveCards,
  resolveArmwrestle,
  resolveDrinking,
  strengthBonus,
  isBold,
  fillLine,
  isEvening,
  resolveGame,
  FORM_CHANCE_EVENING,
  FORM_CHANCE_DAY,
  TAVERN_RADIUS,
  // Test seam:
  _gameNights: gameNights,
  _champions: champions,
};
