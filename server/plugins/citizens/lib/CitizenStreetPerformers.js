"use strict";

/**
 * CitizenStreetPerformers — buskers, bards, and conjurers of the capitals.
 *
 * Some commoners are street performers: musicians, jugglers, storytellers,
 * and magicians who work the town squares, marketplaces, and tavern
 * entrances for tips. Designation is deterministic (FNV-1a hash of the
 * username) so the same citizens are always the performers, stable across
 * restarts.
 *
 * Data tier (free, zero LLM): performer designation, spot assignment,
 * performance hours, reputation tracking — all in-memory.
 *
 * Interaction tier (near real players only): scripted performance lines
 * via forceChat, crowd appreciation from nearby citizen bots, and real
 * coin tips through "use coins on performer". Performances are journaled
 * so the LLM can riff on them when players chat with performers later
 * ("loved your set at the square yesterday").
 *
 * Wiring: CitizenDirector.tickProximity() calls tickPerformers(this,
 * nowMs) on the fast tick, after the market-stalls layer.
 * Citizens.plugin.js registers tipPerformer on onItemOnPlayer BEFORE the
 * generic gift handler, so coin tips on performers become tips, not gifts.
 * Per-citizen try/catch: one bad bot never breaks the tick.
 */

const { getJournal } = require("./CitizenJournal");
const { getMemory } = require("./CitizenMemory");
const { normalizeName } = require("./CitizenBonds");
const { warmthOf } = require("../StreetNotices");
const { siteTileByKingdom } = require("../brain/CitizenSites");
const { chance, humanizerProfile } = require("./humanizer");

// --- tuning ----------------------------------------------------------------

const COINS_ID = 995;
const PERFORMER_FRACTION_PCT = 15; // ~15% of commoners are performers
const PERFORMANCE_RADIUS = 12; // tiles — audience distance
const CROWD_RADIUS = 8; // tiles — crowd appreciation distance
const PERFORMANCE_COOLDOWN_MS = 5 * 60 * 1000; // a performer plays a set at most every 5 min
const CROWD_COOLDOWN_MS = 15 * 60 * 1000; // a citizen applauds at most every 15 min
const PERFORMANCE_CHANCE = 0.6; // per eligible performer per fast tick
const PERFORMANCE_OPEN_HOUR = 10; // performers work 10:00–22:00 server time
const PERFORMANCE_CLOSE_HOUR = 22;
const TIP_MAX_COINS = 25000; // fat-finger guard per tip
const TIP_MEMORY_TONE = 2; // generous tippers are remembered warmly
const TIP_RIPPLE_MIN_COINS = 100; // small change draws no crowd reaction
const TIP_RIPPLE_CHANCE = 0.7; // per eligible onlooker
const TIP_RIPPLE_MAX_VOICES = 2; // at most two voices per tip — never a chorus

// Performance spots: deterministic offsets around the anchor tile so
// performers spread out instead of stacking on one tile.
const SPOT_KINDS = Object.freeze(["square", "market", "tavern"]);
const SPOT_OFFSETS = Object.freeze([
  [-3, -2], [0, -2], [3, -2],
  [-3, 0], [3, 0],
  [-3, 2], [0, 2], [3, 2],
]);

// Reputation tiers: skilled performers draw bigger crowds.
const REP_UNKNOWN = "unknown"; // 0–4 applause
const REP_LIKED = "liked"; // 5–19
const REP_POPULAR = "popular"; // 20–49
const REP_RENOWNED = "renowned"; // 50+

const PERFORMER_MUSICIAN = "musician";
const PERFORMER_JUGGLER = "juggler";
const PERFORMER_STORYTELLER = "storyteller";
const PERFORMER_MAGICIAN = "magician";
const PERFORMER_TYPES = Object.freeze([
  PERFORMER_MUSICIAN,
  PERFORMER_JUGGLER,
  PERFORMER_STORYTELLER,
  PERFORMER_MAGICIAN,
]);

// Engine emote ids (see CitizenAlive EMOTES): dance for the musician,
// cheer for the juggler's flourish, wave for the magician's reveal.
const TYPE_ANIMS = Object.freeze({
  [PERFORMER_MUSICIAN]: 866, // dance
  [PERFORMER_JUGGLER]: 862, // cheer
  [PERFORMER_STORYTELLER]: null, // the tale is the whole show
  [PERFORMER_MAGICIAN]: 1286, // wave
});

// --- scripted lines (data tier; the LLM riffs via the journal) ---------------

const PERFORMANCE_LINES = Object.freeze({
  [PERFORMER_MUSICIAN]: Object.freeze([
    "*strums a bright tune on the lute* ♪",
    "A song for the square! Gather round, gather round!",
    "*plays a haunting melody* ...they say this one was written for a lost sailor.",
    "Coin for the musician? The next one's a love song!",
    "*taps a lively rhythm* Dance if the spirit moves you!",
    "This one's called 'The Merchant's Regret' — you'll see why!",
  ]),
  [PERFORMER_JUGGLER]: Object.freeze([
    "*tosses three knives high into the air*",
    "Watch closely — nothing up my sleeves, everything in the air!",
    "*juggles painted balls, adding one more each pass*",
    "A juggler's got to eat! Toss a coin if you're entertained!",
    "*balances a sword on one fingertip* ...steady... steady...",
    "Five torches! Who wants to see FIVE torches?",
  ]),
  [PERFORMER_STORYTELLER]: Object.freeze([
    "Gather round — I tell the tale of the king who bargained with a dragon!",
    "...and that's when the door swung open BY ITSELF. But I'm getting ahead of myself.",
    "They say the river remembers every name ever drowned in it. Listen...",
    "A story for a coin! A legend for two!",
    "I was THERE when the south gate fell — well. Nearly there. Close enough to hear it.",
    "Hush now. This part's the good part...",
  ]),
  [PERFORMER_MAGICIAN]: Object.freeze([
    "*flourishes an empty hand* ...and now — a coin from thin air!",
    "Pick a card. Any card. No, not that one — the OTHER one. Yes! That one!",
    "*pulls a silk scarf from a spectator's ear*",
    "Magic, friends! Real magic! (Terms and conditions apply.)",
    "Watch the cup. Watch it closely. Now — where did the ball go?",
    "For my next trick, I'll make your coin... disappear into my hat. Generously.",
  ]),
});

const CROWD_LINES = Object.freeze([
  "*applauds warmly*",
  "Bravo! Encore!",
  "Ha! Wonderful!",
  "*whistles appreciatively*",
  "Well done, well done!",
  "*claps along with the rhythm*",
  "That's the spirit!",
  "Marvelous!",
]);

const THANK_LINES = Object.freeze([
  "A generous soul! Thank you, {name} — this one's for you!",
  "{name}! Bless your pockets — thank you kindly!",
  "A tip! The gods smile on you, {name}!",
  "Thank you, {name}! You've made my day!",
  "{amount} coins! {name}, you're a legend of the square!",
  "Much obliged, {name}! I'll drink to your health tonight!",
]);

// Onlooker reactions when a real player tips a performer generously.
// Personality-voiced via warmthOf; slots: {name} tipper, {amount}, {performer}.
const TIP_RIPPLE_LINES = Object.freeze({
  warm: Object.freeze([
    "Well tipped, {name}! The square loves a generous soul.",
    "{amount} coins! {name}, you've made {performer}'s day.",
    "*applauds* That's how you treat an artist, {name}!",
    "Generous and kind — {name} sets the example!",
  ]),
  neutral: Object.freeze([
    "A solid tip, {name}. {amount} coins, well placed.",
    "*nods approvingly at {name}* The performer earned it.",
    "{name} knows quality when they hear it.",
  ]),
  wry: Object.freeze([
    "{amount} coins? {name}'s either generous or showing off.",
    "Easy there, {name} — you'll spoil {performer}.",
    "Hah! {name} tips better than most pay their tab.",
  ]),
});

// --- state (in-memory; re-derived on restart, idempotent) --------------------

const lastPerformanceAt = new Map(); // normalized performer name -> ms
const lastCrowdAt = new Map(); // normalized citizen name -> ms (applause)
const applauseCount = new Map(); // normalized performer name -> applause total

// Memory-leak plug: prune cooldown maps hourly, drop entries older than a day.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const m of [lastPerformanceAt, lastCrowdAt]) {
    for (const [k, at] of m) {
      if (at < cutoff) m.delete(k);
    }
  }
}

// --- pure helpers ------------------------------------------------------------

/** FNV-1a hash of the lowercased username (same as CitizenTimingDesync). */
function hashUsername(username) {
  const s = String(username ?? "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function fillLine(line, vars) {
  let out = String(line);
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.split(`{${k}}`).join(String(v ?? ""));
  }
  return out;
}

/**
 * Which performer type this citizen is, or null if they are not one.
 * Deterministic: ~15% of commoners, type from the same hash.
 */
function performerTypeOf(record) {
  if (!record || record.role !== "commoner") return null;
  const name = normalizeName(record.username);
  if (!name) return null;
  const h = hashUsername(name);
  if (h % 100 >= PERFORMER_FRACTION_PCT) return null;
  return PERFORMER_TYPES[h % PERFORMER_TYPES.length];
}

/**
 * The performer's spot: an anchor kind (square/market/tavern) plus a
 * deterministic offset. Null when the kingdom has no anchor data.
 */
function spotFor(record) {
  if (!record) return null;
  const name = normalizeName(record.username);
  if (!name) return null;
  const h = hashUsername(name);
  const kind = SPOT_KINDS[h % SPOT_KINDS.length];
  const anchor = siteTileByKingdom(record.kingdomId, kind);
  if (!anchor) return null;
  const [dx, dy] = SPOT_OFFSETS[h % SPOT_OFFSETS.length];
  return { x: anchor.x + dx, y: anchor.y + dy, z: anchor.z ?? 0, kind };
}

/** Reputation tier from applause count. Skilled performers draw bigger crowds. */
function reputationOf(username) {
  const n = applauseCount.get(normalizeName(username)) ?? 0;
  if (n >= 50) return REP_RENOWNED;
  if (n >= 20) return REP_POPULAR;
  if (n >= 5) return REP_LIKED;
  return REP_UNKNOWN;
}

/** Crowd appreciation chance scales with the performer's reputation. */
function crowdChanceFor(rep) {
  switch (rep) {
    case REP_RENOWNED: return 0.9;
    case REP_POPULAR: return 0.7;
    case REP_LIKED: return 0.5;
    default: return 0.35;
  }
}

function isPerformanceHour(nowMs) {
  const hour = new Date(nowMs).getHours();
  return hour >= PERFORMANCE_OPEN_HOUR && hour < PERFORMANCE_CLOSE_HOUR;
}

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

function isCitizenBot(player) {
  try {
    return player?.getHostAddress?.() === "bot";
  } catch {
    return false;
  }
}

function botTile(bot) {
  try {
    const loc = bot?.getLocation?.();
    if (!loc) return null;
    const x = loc.getX?.() ?? loc.x;
    const y = loc.getY?.() ?? loc.y;
    const z = loc.getZ?.() ?? loc.z ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, z };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b || a.z !== b.z) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Real (non-bot) players within N tiles of this bot. */
function realPlayersWithin(bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me) return out;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || !isRealPlayer(p)) continue;
      if (chebyshev(me, botTile(p)) <= tiles) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

/** Online citizen bots (not the performer) within N tiles. Roster-backed. */
function citizenCrowdNear(director, bot, tiles) {
  const out = [];
  try {
    const me = botTile(bot);
    if (!me || !director?.roster) return out;
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p === bot || !isCitizenBot(p)) continue;
      if (chebyshev(me, botTile(p)) > tiles) continue;
      let username = null;
      try {
        username = p.getUsername?.();
      } catch {
        continue;
      }
      const name = normalizeName(username);
      if (!name) continue;
      const record = director.roster.get(name);
      if (!record || !director.isOnline?.(record)) continue;
      out.push({ record, bot: p, name });
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function journalEvent(citizenName, text, data) {
  try {
    getJournal().log(citizenName, "work", text, data ? { data } : undefined);
  } catch {
    // Non-fatal.
  }
}

// --- performance --------------------------------------------------------------

/**
 * One performance set: the performer plays, the crowd reacts.
 * Scripted forceChat, zero LLM.
 */
function performSet(director, record, bot, type, nowMs) {
  const name = normalizeName(record.username);
  const lines = PERFORMANCE_LINES[type] ?? [];
  if (lines.length === 0) return;

  // The act itself is the line — scripted, zero LLM.
  const line = pickOne(Math.random, lines);
  try {
    bot.forceChat?.(line.slice(0, 120));
  } catch {
    // A silent performer.
  }
  const anim = TYPE_ANIMS[type];
  if (anim != null) {
    try {
      bot.performAnimation?.(anim);
    } catch {
      // Cosmetic.
    }
  }

  // The crowd: nearby citizen bots applaud, more often for renowned acts.
  const rep = reputationOf(name);
  const crowd = citizenCrowdNear(director, bot, CROWD_RADIUS).filter(({ name: cn }) => {
    if (nowMs - (lastCrowdAt.get(cn) ?? 0) < CROWD_COOLDOWN_MS) return false;
    return chance(Math.random, crowdChanceFor(rep));
  });
  // One or two voices from the crowd — a chorus would drown the act.
  const speakers = crowd.slice(0, rep === REP_RENOWNED ? 2 : 1);
  let applauded = 0;
  for (const { bot: fan, name: fanName } of speakers) {
    try {
      fan.forceChat?.(pickOne(Math.random, CROWD_LINES).slice(0, 120));
    } catch {
      // A silent fan.
    }
    lastCrowdAt.set(fanName, nowMs);
    applauded += 1;
  }
  if (applauded > 0) {
    applauseCount.set(name, (applauseCount.get(name) ?? 0) + applauded);
  }
  lastPerformanceAt.set(name, nowMs);

  journalEvent(
    record.username,
    `Performed as a ${type} at the ${spotFor(record)?.kind ?? "square"} (crowd of ~${1 + applauded}).`,
    { type, applauded, rep }
  );
}

/**
 * Walk the performer toward their spot when they are not there yet.
 * Mirrors CitizenMarketStalls.walkTo.
 */
function walkToSpot(director, bot, spot) {
  try {
    const me = botTile(bot);
    if (!me) return;
    if (chebyshev(me, spot) <= 2) return; // close enough to perform
    bot.moveTo?.(spot);
  } catch {
    // Non-fatal.
  }
}

function tickCitizenPerformers(director, record, nowMs) {
  const type = performerTypeOf(record);
  if (!type) return;
  const name = normalizeName(record.username);
  if (!name) return;
  if (nowMs - (lastPerformanceAt.get(name) ?? 0) < PERFORMANCE_COOLDOWN_MS) return;
  if (!director?.isOnline?.(record)) return;
  const bot = director.getBot?.(record);
  if (!bot) return;

  const spot = spotFor(record);
  if (!spot) return;
  // Head to the spot; the show starts once they're in place and watched.
  const me = botTile(bot);
  if (!me) return;
  if (chebyshev(me, spot) > 2) {
    walkToSpot(director, bot, spot);
    return;
  }
  if (realPlayersWithin(bot, PERFORMANCE_RADIUS).length === 0) return;
  if (!chance(Math.random, PERFORMANCE_CHANCE)) return;

  performSet(director, record, bot, type, nowMs);
}

/**
 * Fast-tick entry. Called from CitizenDirector.tickProximity() (~10s),
 * after the market-stalls layer. Per-citizen try/catch inside.
 */
function tickPerformers(director, nowMs = Date.now()) {
  if (!director?.roster) return;
  if (!isPerformanceHour(nowMs)) return;
  for (const record of director.roster.values()) {
    try {
      tickCitizenPerformers(director, record, nowMs);
    } catch {
      // One bad citizen never breaks the tick.
    }
  }
  try {
    pruneCooldowns(nowMs);
  } catch {
    // Non-fatal.
  }
}

// --- tipping -------------------------------------------------------------------

function getDirectorSafe() {
  try {
    return require("./director/CitizenDirector").getDirector?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * The tip ripples: nearby onlooker citizens acknowledge a generous tipper.
 * Personality-voiced (warm/neutral/wry via warmthOf), sociability-gated —
 * nervous/guarded citizens stay quiet. Shares the 15-minute crowd voice
 * budget (lastCrowdAt), caps at TIP_RIPPLE_MAX_VOICES, and ignores small
 * change below TIP_RIPPLE_MIN_COINS. Cosmetic: never throws.
 *
 * `deps.rng` injects the RNG in tests; production uses Math.random.
 * Returns the number of onlookers who spoke.
 */
function rippleAppreciation(director, target, { tipperName, amount, performerName } = {}, deps = {}, nowMs = Date.now()) {
  try {
    if (!director?.roster || !target) return 0;
    if (!Number.isFinite(amount) || amount < TIP_RIPPLE_MIN_COINS) return 0;
    if (!tipperName) return 0;
    const rng = deps.rng ?? Math.random;
    const crowd = citizenCrowdNear(director, target, CROWD_RADIUS);
    let voices = 0;
    for (const { record, bot: fan, name } of crowd) {
      if (voices >= TIP_RIPPLE_MAX_VOICES) break;
      if (nowMs - (lastCrowdAt.get(name) ?? 0) < CROWD_COOLDOWN_MS) continue;
      if (humanizerProfile(record?.personality).sociability < 1.0) continue;
      if (!chance(rng, TIP_RIPPLE_CHANCE)) continue;
      const warmth = warmthOf(record?.personality);
      const pool = TIP_RIPPLE_LINES[warmth] ?? TIP_RIPPLE_LINES.neutral;
      const line = fillLine(pickOne(rng, pool), {
        name: tipperName,
        amount,
        performer: performerName ?? "the performer",
      });
      try {
        fan.forceChat?.(line.slice(0, 120));
      } catch {
        continue;
      }
      lastCrowdAt.set(name, nowMs);
      voices += 1;
    }
    return voices;
  } catch {
    return 0;
  }
}

/**
 * A real player used coins on a citizen: if the citizen is a street
 * performer, it is a tip, not a gift. Moves real coins, thanks the tipper
 * with a scripted line, and remembers generous tippers in CitizenMemory
 * (+tone) and the journal so the LLM can greet them warmly later.
 *
 * Registered on onItemOnPlayer BEFORE the generic gift handler; sets
 * event.handled so coins-on-performer never double as gifts.
 *
 * `deps.director` injects a stubbed director in tests; production uses the
 * live singleton.
 */
function tipPerformer(event, deps = {}, nowMs = Date.now()) {
  const { player, target, item } = event ?? {};
  if (event?.handled) return;
  if (!isRealPlayer(player)) return;
  if (!isCitizenBot(target)) return;
  if (!item || item.getId?.() !== COINS_ID) return;

  const director = deps.director ?? getDirectorSafe();
  if (!director?.roster) return;
  const citizenName = target.getUsername?.();
  const name = normalizeName(citizenName);
  if (!name) return;
  const record = director.roster.get(name);
  const type = performerTypeOf(record);
  if (!type) return; // not a performer — let the gift handler have it

  const playerName = player.getUsername?.() ?? "traveller";
  const offered = Math.max(0, Math.floor(item.getAmount?.() ?? 0));
  if (offered <= 0) return;
  const amount = Math.min(offered, TIP_MAX_COINS);

  // Move real coins. Bail silently (no voiding) if inventories misbehave.
  let moved = false;
  try {
    const playerInv = player.getInventory?.();
    const targetInv = target.getInventory?.();
    if (!playerInv || !targetInv) return;
    const held = playerInv.getAmount?.(COINS_ID) ?? 0;
    if (held < amount) {
      try {
        player.sendMessage?.("You don't have that many coins.");
      } catch {
        // Cosmetic.
      }
      return;
    }
    playerInv.deleteNumber(COINS_ID, amount);
    try {
      playerInv.refreshItems?.();
    } catch {
      // Cosmetic.
    }
    targetInv.adds(COINS_ID, amount);
    moved = true;
  } catch {
    return;
  }
  if (!moved) return;
  event.handled = true;

  if (offered > TIP_MAX_COINS) {
    try {
      player.sendMessage?.(
        `You tip ${amount} coins (tips are capped at ${TIP_MAX_COINS} per use).`
      );
    } catch {
      // Cosmetic.
    }
  } else {
    try {
      player.sendMessage?.(`You tip ${citizenName} ${amount} coins.`);
    } catch {
      // Cosmetic.
    }
  }

  const rep = reputationOf(name);
  const line = fillLine(pickOne(Math.random, THANK_LINES), {
    name: playerName,
    amount,
  });
  try {
    target.forceChat?.(line.slice(0, 120));
  } catch {
    // A silent performer.
  }
  const anim = TYPE_ANIMS[type];
  if (anim != null) {
    try {
      target.performAnimation?.(anim);
    } catch {
      // Cosmetic.
    }
  }

  // Remember generous tippers: they get warmer greetings from this performer.
  try {
    const memory = getMemory();
    memory.recordMeeting(name, playerName, nowMs);
    memory.recordTone(name, playerName, TIP_MEMORY_TONE, nowMs);
  } catch {
    // Memory must never break the tip.
  }
  // Applause counts too — big tips build the performer's name.
  applauseCount.set(name, (applauseCount.get(name) ?? 0) + 2);
  journalEvent(
    citizenName,
    `Received a ${amount} coin tip from ${playerName} (${rep} act).`,
    { from: playerName, amount, type }
  );
  // The moment ripples: nearby onlookers acknowledge a generous tipper.
  try {
    rippleAppreciation(director, target, {
      tipperName: playerName,
      amount,
      performerName: citizenName,
    }, deps, nowMs);
  } catch {
    // Cosmetic — the tip already landed.
  }
}

module.exports = {
  // tuning
  COINS_ID,
  PERFORMER_FRACTION_PCT,
  PERFORMANCE_RADIUS,
  CROWD_RADIUS,
  PERFORMANCE_COOLDOWN_MS,
  CROWD_COOLDOWN_MS,
  PERFORMANCE_CHANCE,
  PERFORMANCE_OPEN_HOUR,
  PERFORMANCE_CLOSE_HOUR,
  TIP_MAX_COINS,
  TIP_RIPPLE_MIN_COINS,
  TIP_RIPPLE_CHANCE,
  TIP_RIPPLE_MAX_VOICES,
  TIP_RIPPLE_LINES,
  // types
  PERFORMER_TYPES,
  PERFORMER_MUSICIAN,
  PERFORMER_JUGGLER,
  PERFORMER_STORYTELLER,
  PERFORMER_MAGICIAN,
  REP_UNKNOWN,
  REP_LIKED,
  REP_POPULAR,
  REP_RENOWNED,
  // pure/testable
  performerTypeOf,
  spotFor,
  reputationOf,
  crowdChanceFor,
  isPerformanceHour,
  fillLine,
  pickOne,
  hashUsername,
  isRealPlayer,
  // lifecycle
  tickPerformers,
  tipPerformer,
  rippleAppreciation,
};
