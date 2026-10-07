"use strict";

/**
 * CitizenFavors — citizens proactively ask nearby players for bounded favors.
 *
 * Runs on the director's tick (data tier, zero LLM — the mouth stays cheap).
 * A citizen with players nearby may ask for one of three bounded favors:
 *
 *   fetch: "bring me N x <item>" — the player hands the items over (saying
 *          "here"/"done", or automatically when they walk up carrying them).
 *          The citizen pays a fixed coin reward from a daily budget.
 *   coins: "spare me N coins" — the player hands over coins out of kindness;
 *          repaid in goodwill, not coin.
 *   guard: "stand with me a while" — the player stays within 6 tiles for a
 *          few ticks; a small coin thank-you.
 *
 * Outcomes (asked/accepted/completed/declined/ignored) feed CitizenMemory
 * (tone, meetings, spend) and therefore the existing friend/favorite and
 * grudge mechanics — a player who always helps becomes a friend faster;
 * one who always ignores gets cold greetings.
 *
 * Anti-spam: per-citizen ask throttle, per citizen×player cooldown, a cap on
 * active favors per player, asks expire (ignored = mild tone dip), accepted
 * favors expire if abandoned. Active favors live in memory only — they're
 * short-lived by design; what persists (tone/meetings/spend) already lives
 * in CitizenMemory's save.
 *
 * Plain-node testable: CitizenFavors.test.js.
 */

const { getMemory } = require("./CitizenMemory");
const { isEnemy } = require("./CitizenBonds");
const { agentRng, chance } = require("./humanizer");

const COINS = 995;

// Favor kinds.
const FAVOR_FETCH = "fetch";
const FAVOR_COINS = "coins";
const FAVOR_GUARD = "guard";

// Favor states.
const ASKED = "asked";
const ACCEPTED = "accepted";
const DONE = "done";
const DECLINED = "declined";
const EXPIRED = "expired";

// Ask gating.
const ASK_CHANCE = 0.03; // per 60s tick, per eligible citizen with a target
const ASK_PAIR_COOLDOWN_MS = 2 * 3600 * 1000; // same citizen won't re-ask you this soon
const ASK_CITIZEN_THROTTLE_MS = 45 * 60 * 1000; // a citizen asks anyone at most this often
const ASK_EXPIRY_MS = 10 * 60 * 1000; // an unanswered ask dies (ignored)
const ACCEPTED_EXPIRY_MS = 2 * 3600 * 1000; // an abandoned accepted favor is cleaned up
const MAX_ACTIVE_PER_PLAYER = 2; // nobody gets mobbed by favor requests
const MAX_ACTIVE_PER_CITIZEN = 1;

// Economy bounds (fixed rewards, no GE lookups).
const FAVOR_DAILY_BUDGET = 3000; // coins a citizen will spend on favors per day
const FETCH_REWARD_CAP = 500; // max coins paid for one fetch favor
const COINS_ASK_MIN = 25;
const COINS_ASK_MAX = 100;
const GUARD_THANKS = 50; // flat thank-you for standing guard
const GUARD_REQUIRED_TICKS = 3; // ~3 director ticks near the citizen
const GUARD_RANGE = 6; // tiles (Chebyshev)

// Catalog of fetchable goods: common, low-tier, easily gathered.
// Display names resolve from the cache at ask time; values are fixed so
// favors can never inflate the economy.
const FAVOR_ITEMS = [
  { id: 1511, qty: [5, 10], value: 15 }, // Logs
  { id: 317, qty: [5, 15], value: 8 }, // Raw shrimps
  { id: 436, qty: [5, 10], value: 10 }, // Copper ore
  { id: 438, qty: [5, 10], value: 10 }, // Tin ore
  { id: 440, qty: [5, 10], value: 18 }, // Iron ore
  { id: 453, qty: [5, 8], value: 35 }, // Coal
  { id: 526, qty: [5, 15], value: 12 }, // Bones
];

function normalizeName(name) {
  return String(name ?? "").toLowerCase().trim();
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function between(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function journalEvent(citizenName, text, kind) {
  try {
    require("./CitizenJournal").getJournal().log(citizenName, kind ?? "favor", text);
  } catch {
    // Non-fatal.
  }
}

function memTone(citizenName, playerName, delta) {
  try {
    getMemory().recordTone(citizenName, playerName, delta);
  } catch {
    // Non-fatal.
  }
}

function memMeeting(citizenName, playerName) {
  try {
    getMemory().recordMeeting(citizenName, playerName);
  } catch {
    // Non-fatal.
  }
}

/**
 * In-memory store of live favors. Outcomes persist via CitizenMemory;
 * the favors themselves are ephemeral by design.
 */
class FavorStore {
  constructor() {
    this.favors = new Map(); // id -> favor record
    this.lastAskPair = new Map(); // "citizenKey|playerKey" -> ts
    this.lastAskCitizen = new Map(); // citizenKey -> ts (any target)
    this.budget = new Map(); // citizenKey -> { day, spent }
    this.seq = 0;
  }

  resetForTests() {
    this.favors.clear();
    this.lastAskPair.clear();
    this.lastAskCitizen.clear();
    this.budget.clear();
    this.seq = 0;
  }

  /** Coins of the daily budget a citizen has left today. */
  budgetLeft(citizenName, now = Date.now()) {
    const day = new Date(now).toDateString();
    const row = this.budget.get(normalizeName(citizenName));
    if (!row || row.day !== day) return FAVOR_DAILY_BUDGET;
    return Math.max(0, FAVOR_DAILY_BUDGET - row.spent);
  }

  spendBudget(citizenName, amount, now = Date.now()) {
    const day = new Date(now).toDateString();
    const key = normalizeName(citizenName);
    const row = this.budget.get(key);
    if (!row || row.day !== day) {
      this.budget.set(key, { day, spent: amount });
    } else {
      row.spent += amount;
    }
  }

  /** Live (asked/accepted) favors for this player, any citizen. */
  activeForPlayer(playerName) {
    const key = normalizeName(playerName);
    const out = [];
    for (const favor of this.favors.values()) {
      if (favor.playerKey === key && (favor.state === ASKED || favor.state === ACCEPTED)) {
        out.push(favor);
      }
    }
    return out;
  }

  activeForCitizen(citizenName) {
    const key = normalizeName(citizenName);
    const out = [];
    for (const favor of this.favors.values()) {
      if (favor.citizenKey === key && (favor.state === ASKED || favor.state === ACCEPTED)) {
        out.push(favor);
      }
    }
    return out;
  }

  /** The unanswered ask from this citizen to this player, if any. */
  pendingAsk(citizenName, playerName) {
    const c = normalizeName(citizenName);
    const p = normalizeName(playerName);
    for (const favor of this.favors.values()) {
      if (favor.citizenKey === c && favor.playerKey === p && favor.state === ASKED) {
        return favor;
      }
    }
    return null;
  }

  /** An accepted (in-progress) favor from this citizen to this player. */
  acceptedFavor(citizenName, playerName) {
    const c = normalizeName(citizenName);
    const p = normalizeName(playerName);
    for (const favor of this.favors.values()) {
      if (favor.citizenKey === c && favor.playerKey === p && favor.state === ACCEPTED) {
        return favor;
      }
    }
    return null;
  }

  canAsk(citizenName, playerName, now = Date.now()) {
    const c = normalizeName(citizenName);
    const p = normalizeName(playerName);
    if (this.activeForCitizen(citizenName).length >= MAX_ACTIVE_PER_CITIZEN) return false;
    if (this.activeForPlayer(playerName).length >= MAX_ACTIVE_PER_PLAYER) return false;
    const lastPair = this.lastAskPair.get(`${c}|${p}`) ?? 0;
    if (now - lastPair < ASK_PAIR_COOLDOWN_MS) return false;
    const lastCitizen = this.lastAskCitizen.get(c) ?? 0;
    if (now - lastCitizen < ASK_CITIZEN_THROTTLE_MS) return false;
    return true;
  }

  recordAsk(citizenName, playerName, now = Date.now()) {
    const c = normalizeName(citizenName);
    const p = normalizeName(playerName);
    this.lastAskPair.set(`${c}|${p}`, now);
    this.lastAskCitizen.set(c, now);
  }

  add(favor) {
    this.favors.set(favor.id, favor);
    return favor;
  }

  finish(id, state) {
    const favor = this.favors.get(id);
    if (favor) favor.state = state;
    return favor;
  }
}

let store = null;

function getFavorStore() {
  if (!store) store = new FavorStore();
  return store;
}

/** A citizen can ask this player for a favor when: met, no grudge, not an enemy. */
function isAskable(citizenName, playerName) {
  let entry = null;
  try {
    entry = getMemory().getEntry(citizenName, playerName);
  } catch {
    return false;
  }
  if (!entry || !(entry.met > 0)) return false;
  if ((entry.grudge ?? 0) > 0) return false;
  try {
    if (isEnemy(citizenName, playerName)) return false;
  } catch {
    // Non-fatal.
  }
  return true;
}

function describeFavor(favor) {
  if (favor.kind === FAVOR_FETCH) {
    return `bring me ${favor.qty}x ${favor.itemName}`;
  }
  if (favor.kind === FAVOR_COINS) {
    return `spare me ${favor.coins} coins`;
  }
  return "stand guard with me for a few minutes";
}

function askText(favor, playerName) {
  const task = describeFavor(favor);
  if (favor.kind === FAVOR_FETCH) {
    return `${playerName}, could you ${task}? I'll pay ${favor.reward} coins for the trouble.`;
  }
  if (favor.kind === FAVOR_COINS) {
    return `${playerName}, times are hard — could you ${task}? I'd owe you one.`;
  }
  return `${playerName}, could you ${task}? Just stay close a bit — bandits about.`;
}

/** Choose the favor kind and parameters; returns null if nothing affordable. */
function chooseFavor(rng, citizenName) {
  const s = getFavorStore();
  const roll = rng();
  if (roll < 0.55) {
    // Fetch: pick an affordable item.
    const budgetLeft = s.budgetLeft(citizenName);
    const affordable = FAVOR_ITEMS.filter((it) => {
      const qty = between(rng, it.qty[0], it.qty[1]);
      return Math.min(qty * it.value, FETCH_REWARD_CAP) <= budgetLeft;
    });
    if (affordable.length === 0) return null;
    const it = pick(rng, affordable);
    const qty = between(rng, it.qty[0], it.qty[1]);
    const reward = Math.min(qty * it.value, FETCH_REWARD_CAP);
    return { kind: FAVOR_FETCH, itemId: it.id, qty, reward };
  }
  if (roll < 0.8) {
    return {
      kind: FAVOR_COINS,
      coins: between(rng, COINS_ASK_MIN, COINS_ASK_MAX),
    };
  }
  // Guard: only if the budget covers the thank-you.
  if (s.budgetLeft(citizenName) < GUARD_THANKS) return null;
  return { kind: FAVOR_GUARD };
}

function resolveItemName(itemId, deps) {
  try {
    const name = deps?.itemName?.(itemId);
    if (name) return name;
  } catch {
    // Fall through to the id.
  }
  return `item ${itemId}`;
}

/** Citizen asks the player: overhead chat + a direct message. */
function issueAsk(bot, player, favor) {
  const playerName = player.getUsername?.() ?? favor.player;
  const text = askText(favor, playerName);
  try {
    bot.forceChat?.(`${playerName}, a favor? ${describeFavor(favor)}.`);
  } catch {
    // Cosmetic.
  }
  try {
    player.sendMessage?.(
      `${favor.citizen} asks you a favor: "${text}" Say "yes" to me to accept, "no" to decline.`
    );
  } catch {
    // Non-fatal.
  }
  memMeeting(favor.citizen, playerName);
  journalEvent(favor.citizen, `Asked ${playerName} to ${describeFavor(favor)}.`);
}

/**
 * Progress accepted favors and expire stale ones; maybe ask a new favor.
 * Called from the director tick per online citizen. `nearbyPlayers` are the
 * real players near this citizen's bot. `deps.itemName(id)` resolves item
 * display names from the cache (optional — falls back to the id).
 */
function tickFavors(record, getBot, nearbyPlayers, deps) {
  const s = getFavorStore();
  const now = Date.now();
  const name = record.username;
  const bot = getBot ? getBot(record) : null;

  // 1. Expire stale favors.
  for (const favor of s.activeForCitizen(name)) {
    if (favor.state === ASKED && now - favor.askedAt > ASK_EXPIRY_MS) {
      s.finish(favor.id, EXPIRED);
      memTone(name, favor.player, -1); // ignored — a mild cold shoulder later
      journalEvent(name, `${favor.player} ignored my favor ask. Noted.`);
      try {
        bot?.forceChat?.("Hmph. Never mind then.");
      } catch {
        // Cosmetic.
      }
    } else if (favor.state === ACCEPTED && now - favor.acceptedAt > ACCEPTED_EXPIRY_MS) {
      s.finish(favor.id, EXPIRED);
      journalEvent(name, `${favor.player} accepted my favor and never came through.`);
    }
  }

  // 2. Progress accepted favors (player must still be around).
  const nearbyKeys = new Set((nearbyPlayers ?? []).map((p) => normalizeName(p.getUsername?.())));
  for (const favor of s.activeForCitizen(name)) {
    if (favor.state !== ACCEPTED) continue;
    const player = (nearbyPlayers ?? []).find(
      (p) => normalizeName(p.getUsername?.()) === favor.playerKey
    );
    if (!player) continue; // they'll finish it when they come back
    try {
      if (favor.kind === FAVOR_GUARD) {
        progressGuard(bot, player, favor);
      } else {
        autoComplete(bot, player, favor);
      }
    } catch {
      // One favor's bookkeeping never breaks the tick.
    }
  }

  // 3. Maybe ask a new favor.
  if (!bot || !nearbyPlayers || nearbyPlayers.length === 0) return;
  const rng = agentRng(`favors:${name}:${now >> 16}`);
  if (!chance(rng, ASK_CHANCE)) return;
  const candidates = nearbyPlayers.filter((p) => {
    const pName = p.getUsername?.();
    return pName && isAskable(name, pName) && s.canAsk(name, pName, now);
  });
  if (candidates.length === 0) return;
  // Guards are too busy to ask for favors.
  if (record.role === "guard") return;

  const player = pick(rng, candidates);
  const playerName = player.getUsername();
  const spec = chooseFavor(rng, name);
  if (!spec) return;

  const favor = {
    id: `${normalizeName(name)}|${normalizeName(playerName)}|${++s.seq}`,
    citizen: name,
    citizenKey: normalizeName(name),
    player: playerName,
    playerKey: normalizeName(playerName),
    state: ASKED,
    askedAt: now,
    acceptedAt: 0,
    guardTicks: 0,
    ...spec,
  };
  if (favor.kind === FAVOR_FETCH) {
    favor.itemName = resolveItemName(favor.itemId, deps);
  }
  s.recordAsk(name, playerName, now);
  s.add(favor);
  issueAsk(bot, player, favor);
}

function playerHas(player, itemId, qty) {
  try {
    return (player.getInventory?.()?.getAmount?.(itemId) ?? 0) >= qty;
  } catch {
    return false;
  }
}

function playerTake(player, itemId, qty) {
  player.getInventory()?.deleteNumber?.(itemId, qty);
}

function playerGive(player, itemId, qty) {
  player.getInventory()?.adds?.(itemId, qty);
}

/** Accepted fetch/coins favor: take the goods the moment the player has them. */
function autoComplete(bot, player, favor) {
  const s = getFavorStore();
  if (favor.kind === FAVOR_FETCH) {
    if (!playerHas(player, favor.itemId, favor.qty)) return;
    playerTake(player, favor.itemId, favor.qty);
    const reward = favor.reward;
    // Pay from the citizen's pocket; the budget gate at ask time makes a
    // shortfall unlikely, but never leave the player unpaid for goods taken.
    let paid = 0;
    try {
      const have = bot?.getInventory?.()?.getAmount?.(COINS) ?? 0;
      paid = Math.min(have, reward);
      if (paid > 0) bot.getInventory().deleteNumber(COINS, paid);
    } catch {
      // Non-fatal.
    }
    playerGive(player, COINS, paid);
    s.spendBudget(favor.citizen, reward);
    s.finish(favor.id, DONE);
    memTone(favor.citizen, favor.player, 2);
    try {
      getMemory().recordSpend?.(favor.citizen, favor.player, reward);
    } catch {
      // Non-fatal.
    }
    journalEvent(favor.citizen, `${favor.player} brought ${favor.qty}x ${favor.itemName}. Paid ${paid}.`);
    try {
      bot?.forceChat?.("You're a lifesaver, thank you!");
      player.sendMessage?.(
        paid >= reward
          ? `${favor.citizen} takes the goods and pays you ${paid} coins.`
          : `${favor.citizen} takes the goods. "I'm short on coin — I'll make it up to you."`
      );
    } catch {
      // Cosmetic.
    }
  } else if (favor.kind === FAVOR_COINS) {
    if (!playerHas(player, COINS, favor.coins)) return;
    playerTake(player, COINS, favor.coins);
    try {
      bot?.getInventory?.()?.adds?.(COINS, favor.coins);
    } catch {
      // Non-fatal.
    }
    s.finish(favor.id, DONE);
    memTone(favor.citizen, favor.player, 3);
    try {
      getMemory().recordSpend?.(favor.citizen, favor.player, favor.coins);
    } catch {
      // Non-fatal.
    }
    journalEvent(favor.citizen, `${favor.player} spared me ${favor.coins} coins. A true friend.`);
    try {
      bot?.forceChat?.("Bless you, I'll not forget this!");
      player.sendMessage?.(`${favor.citizen} is deeply grateful for your ${favor.coins} coins.`);
    } catch {
      // Cosmetic.
    }
  }
}

/** Accepted guard favor: accumulate ticks while the player stays close. */
function progressGuard(bot, player, favor) {
  const s = getFavorStore();
  let dx = 99;
  let dy = 99;
  try {
    const bp = bot?.getPosition?.();
    const pp = player?.getPosition?.();
    dx = Math.abs((bp?.getX?.() ?? bp?.x ?? 0) - (pp?.getX?.() ?? pp?.x ?? 0));
    dy = Math.abs((bp?.getY?.() ?? bp?.y ?? 0) - (pp?.getY?.() ?? pp?.y ?? 0));
  } catch {
    return;
  }
  if (dx > GUARD_RANGE || dy > GUARD_RANGE) return;
  favor.guardTicks += 1;
  if (favor.guardTicks >= GUARD_REQUIRED_TICKS) {
    let paid = 0;
    try {
      const have = bot?.getInventory?.()?.getAmount?.(COINS) ?? 0;
      paid = Math.min(have, GUARD_THANKS);
      if (paid > 0) bot.getInventory().deleteNumber(COINS, paid);
    } catch {
      // Non-fatal.
    }
    playerGive(player, COINS, paid);
    s.spendBudget(favor.citizen, GUARD_THANKS);
    s.finish(favor.id, DONE);
    memTone(favor.citizen, favor.player, 2);
    journalEvent(favor.citizen, `${favor.player} stood guard with me. Paid ${paid}.`);
    try {
      bot?.forceChat?.("All quiet thanks to you. Much obliged!");
      player.sendMessage?.(`${favor.citizen} thanks you for standing guard (+${paid} coins).`);
    } catch {
      // Cosmetic.
    }
  }
}

/** Player says "yes" to a pending ask from this citizen. */
function acceptFavor(citizenName, playerName) {
  const s = getFavorStore();
  const favor = s.pendingAsk(citizenName, playerName);
  if (!favor) return null;
  favor.state = ACCEPTED;
  favor.acceptedAt = Date.now();
  memTone(citizenName, playerName, 1);
  memMeeting(citizenName, playerName);
  journalEvent(citizenName, `${playerName} agreed to ${describeFavor(favor)}.`);
  return favor;
}

/** Player says "no" to a pending ask from this citizen. */
function declineFavor(citizenName, playerName) {
  const s = getFavorStore();
  const favor = s.pendingAsk(citizenName, playerName);
  if (!favor) return null;
  s.finish(favor.id, DECLINED);
  memTone(citizenName, playerName, -1);
  journalEvent(citizenName, `${playerName} declined my favor ask.`);
  return favor;
}

/**
 * Player says "here"/"done": try to complete an accepted fetch/coins favor
 * right now. `bot`/`player` are the live objects (resolved by the caller).
 * Returns the favor if one was in progress, null otherwise.
 */
function attemptComplete(citizenName, playerName, bot, player) {
  const s = getFavorStore();
  const favor = s.acceptedFavor(citizenName, playerName);
  if (!favor) return null;
  if (favor.kind === FAVOR_GUARD) {
    // Guard favors complete on the tick, not on demand.
    try {
      player?.sendMessage?.(`${citizenName}: "Just stay close a little longer."`);
    } catch {
      // Cosmetic.
    }
    return favor;
  }
  if (favor.kind === FAVOR_FETCH && !playerHas(player, favor.itemId, favor.qty)) {
    try {
      player?.sendMessage?.(
        `${citizenName} still needs ${favor.qty}x ${favor.itemName} — you don't have them yet.`
      );
    } catch {
      // Cosmetic.
    }
    return favor;
  }
  if (favor.kind === FAVOR_COINS && !playerHas(player, COINS, favor.coins)) {
    try {
      player?.sendMessage?.(
        `${citizenName} still needs ${favor.coins} coins — you don't carry that many.`
      );
    } catch {
      // Cosmetic.
    }
    return favor;
  }
  autoComplete(bot, player, favor);
  return favor;
}

/** One-line status for the ::citizen favors command. */
function favorStatus() {
  const s = getFavorStore();
  const live = [];
  for (const favor of s.favors.values()) {
    if (favor.state === ASKED || favor.state === ACCEPTED) {
      live.push(`${favor.citizen}→${favor.player}: ${describeFavor(favor)} (${favor.state})`);
    }
  }
  return live;
}

module.exports = {
  getFavorStore,
  tickFavors,
  acceptFavor,
  declineFavor,
  attemptComplete,
  favorStatus,
  describeFavor,
  FAVOR_FETCH,
  FAVOR_COINS,
  FAVOR_GUARD,
  ASKED,
  ACCEPTED,
  DONE,
  DECLINED,
  EXPIRED,
  COINS,
  ASK_CHANCE,
  ASK_PAIR_COOLDOWN_MS,
  ASK_CITIZEN_THROTTLE_MS,
  ASK_EXPIRY_MS,
  MAX_ACTIVE_PER_PLAYER,
  MAX_ACTIVE_PER_CITIZEN,
  FAVOR_DAILY_BUDGET,
  FETCH_REWARD_CAP,
  GUARD_REQUIRED_TICKS,
};
