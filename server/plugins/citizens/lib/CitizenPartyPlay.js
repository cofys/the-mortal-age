"use strict";

/**
 * CitizenPartyPlay — citizens adventure WITH players. Real parties, real combat.
 *
 * Jon's AI-player directive: citizens indistinguishable from real players —
 * "boss runs, every player function." Citizens already skill and chat. This
 * module lets them PARTY UP with real players:
 *
 * 1. PARTY INVITES — a real player right-clicks a citizen and picks
 *    "Invite to party" (player option slot 9, diegetic — no ::commands).
 *    The citizen decides based on personality + relationship + what they're
 *    doing right now. Friends usually say yes. Enemies never do. Busy
 *    citizens may decline.
 *
 * 2. FOLLOW & ASSIST — party members follow the player leader (existing
 *    tickFollow handles movement). When the leader is in combat with an NPC,
 *    members attack the SAME target using the REAL combat engine
 *    (bot.getCombat().attack(npc)) — the same path CitizenSlayer uses.
 *
 * 3. FOOD AT LOW HP — party members eat real food from their inventory when
 *    hurt (HP-driven, per Jon's correction — no hunger). Uses the real FOOD
 *    map from Food.plugin.js. No food + critical HP = retreat.
 *
 * 4. LOOT SHARING — on NPC death with party involvement, the killer shares
 *    coins with party members (real inventory transfer). Boss kills get
 *    "gz" lines and a relationship boost for good leaders.
 *
 * 5. PARTY CHAT — throttled, personality-scaled lines during the adventure.
 *    "gz" on boss kills. Citizens remember good party leaders.
 *
 * Zero LLM. Tick-safe (every engine read guarded). No *2 modules.
 * No fake combat — if the engine can't do it, the citizen doesn't do it.
 */

const {
  ATTR_CITIZEN_PERSONALITY,
} = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");
const { humanizerProfile } = require("./humanizer");
const { hpPercent } = require("../brain/CitizenNeeds");

// Bond functions via lazy require (not destructured at load) so tests can
// mock CitizenBonds and the mocks take effect.
function bonds() {
  return require("./CitizenBonds");
}
const normalizeName = (...args) => bonds().normalizeName(...args);
const isFriend = (...args) => bonds().isFriend(...args);
const isEnemy = (...args) => bonds().isEnemy(...args);
const getParty = (...args) => bonds().getParty(...args);
const setParty = (...args) => bonds().setParty(...args);
const clearParty = (...args) => bonds().clearParty(...args);

// Right-click "Invite to party" on a citizen. Slots 1-8 taken (attack,
// trade req, follow, duel, recruit, forfeit, trade, examine). Client uses
// a Map, so 9 works.
const PARTY_OPTION_SLOT = 9;

// Combat behavior tuning.
const ASSIST_RANGE_TILES = 12; // How far members will go to assist.
const EAT_AT_HP_PERCENT = 50; // Eat when HP drops below this.
const RETREAT_AT_HP_PERCENT = 20; // Run when HP critical and no food.
const BOSS_COMBAT_LEVEL = 100; // NPCs at/above this are "bosses" for gz.

// Party chat throttles.
const PARTY_CHAT_COOLDOWN_MS = 90 * 1000;
const lastPartyChat = new Map(); // partyKey -> timestamp

// Pending invites: citizenName -> { playerName, expiresAt }
const pendingInvites = new Map();
const INVITE_EXPIRES_MS = 60 * 1000;

let pluginApi = null;

// --- voice lines ------------------------------------------------------------

const ACCEPT_LINES = Object.freeze({
  plain: [
    "Sure, let's go!",
    "Party up! Lead the way.",
    "I'm in. What are we hunting?",
    "Sounds fun, let's do it.",
  ],
  terse: ["fine.", "let's go.", "k."],
});

const DECLINE_LINES = Object.freeze({
  plain: [
    "Sorry, I'm in the middle of something.",
    "Not right now — maybe later?",
    "I can't, I've got my own thing going.",
    "Pass. Good luck though!",
  ],
  terse: ["busy.", "not now.", "pass."],
});

const ENEMY_DECLINE_LINES = Object.freeze({
  plain: ["Not with you.", "I'd rather not.", "Find someone else."],
  terse: ["no.", "never."],
});

const ASSIST_LINES = Object.freeze({
  plain: [
    "On it!",
    "Got your back!",
    "Taking it down!",
  ],
  terse: ["on it.", "got it."],
});

const EAT_LINES = Object.freeze({
  plain: ["*munches*", "Need to patch up!", "Eating — cover me!"],
  terse: ["*eats*", "patching up."],
});

const RETREAT_LINES = Object.freeze({
  plain: [
    "Too hot — falling back!",
    "I need to get out of here!",
    "Retreating! Don't die without me!",
  ],
  terse: ["falling back!", "too hot!"],
});

const BOSS_KILL_LINES = Object.freeze({
  plain: [
    "GZ! That was clean!",
    "Gzz! Nice kill!",
    "We actually did it! Gz!",
  ],
  terse: ["gz.", "nice."],
});

const LOOT_SHARE_LINES = Object.freeze({
  plain: [
    "Here's your share!",
    "Split's split — enjoy!",
    "Your cut, as promised.",
  ],
  terse: ["your share.", "split."],
});

// --- food -------------------------------------------------------------------

/** Lazy FOOD map from the real Food plugin (itemId -> { heal }). */
function foodMap() {
  try {
    return require("../../items/Food.plugin.js").FOOD ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the best food in a bot's inventory. Returns { id, heal, slot } or null.
 * "Best" = highest heal amount (citizens aren't picky mid-fight).
 */
function findBestFood(bot) {
  const foods = foodMap();
  if (!foods) return null;
  let best = null;
  try {
    const items = bot?.getInventory?.()?.getItems?.() ?? [];
    for (const item of items) {
      const id = item?.getId?.();
      const amount = item?.getAmount?.() ?? 0;
      if (!Number.isInteger(id) || amount <= 0) continue;
      const food = foods.get(id);
      if (!food || !(food.heal > 0)) continue;
      if (!best || food.heal > best.heal) {
        best = { id, heal: food.heal };
      }
    }
  } catch {
    return null;
  }
  return best;
}

/**
 * Eat the best food in inventory. Real consumption: delete 1, heal the amount.
 * Returns true if something was eaten.
 */
function eatBestFood(bot) {
  const best = findBestFood(bot);
  if (!best) return false;
  try {
    const inv = bot.getInventory();
    if (!inv) return false;
    const before = inv.getAmount?.(best.id) ?? 0;
    if (before <= 0) return false;
    inv.deleteNumber(best.id, 1);
    try {
      bot.heal?.(best.heal);
    } catch {
      // Item consumed; HP restore is best-effort.
    }
    // Eat animation (829) — visible, like a player clicking food.
    try {
      const { Animation } = require("../../../src/main/typescript/elvarg/game/model/Animation");
      bot.performAnimation?.(new Animation(829));
    } catch {
      // Animation is cosmetic.
    }
    return true;
  } catch {
    return false;
  }
}

// --- invite decision --------------------------------------------------------

/**
 * Should this citizen accept a party invite from this player?
 * Returns { accept: boolean, reason: string }.
 *
 * Factors (all real state, no fiction):
 * - Enemy: never.
 * - Friend: very likely.
 * - Personality: brave/sociable citizens say yes more; nervous/loner less.
 * - Current activity: mid-session citizens are less likely to drop everything.
 * - Combat level: citizens won't suicide into content far above them (they
 *   don't know the target yet, so this uses the PLAYER's level as a proxy —
 *   a level 3 citizen won't party with a level 126 going bossing).
 */
function decidePartyInvite(record, player, citizenCombatLevel = 3, rng = Math.random) {
  const playerName = player?.getUsername?.() ?? "someone";
  const citizenName = record?.username ?? record?.displayName ?? "citizen";

  // Enemies never party.
  if (isEnemy(citizenName, playerName)) {
    return { accept: false, reason: "enemy" };
  }

  let chance = 0.45; // Base: slightly hesitant stranger.

  // Relationship.
  if (isFriend(citizenName, playerName)) {
    chance += 0.35;
  }

  // Personality.
  try {
    const profile = humanizerProfile(record.personality);
    const sociability = profile.sociability ?? 1;
    const bravery = profile.bravery ?? profile.courage ?? 1;
    chance += (sociability - 1) * 0.15;
    chance += (bravery - 1) * 0.1;
  } catch {
    // Personality unreadable — use base chance.
  }

  // Current activity: citizens deep in a session are less likely to drop it.
  try {
    const busy = record.currentActivity && record.currentActivity !== "idle";
    if (busy) chance -= 0.2;
  } catch {
    // Activity unreadable.
  }

  // Combat level sanity: don't suicide.
  try {
    const citizenCombat = citizenCombatLevel;
    const playerCombat = player?.getSkillManager?.()?.getCombatLevel?.() ?? 3;
    if (playerCombat - citizenCombat > 50) {
      chance -= 0.25; // "you're way out of my league"
    }
  } catch {
    // Levels unreadable.
  }

  chance = Math.max(0.05, Math.min(0.95, chance));
  return { accept: rng() < chance, reason: chance >= 0.5 ? "willing" : "busy" };
}

// --- party invite flow (diegetic) -------------------------------------------

/** Send the "Party" right-click option to a real player (once). */
const partyOptionSent = new WeakSet();
function syncPartyOption(player) {
  if (!player || player.isPlayerBot?.() === true) return;
  if (partyOptionSent.has(player)) return;
  try {
    player.getPacketSender()?.sendPlayerOption(PARTY_OPTION_SLOT, "Invite to party", false);
    partyOptionSent.add(player);
  } catch {
    // Retry next tick.
  }
}

/**
 * Handle a player right-clicking a citizen and picking "Party".
 * Sends an invite; the citizen decides on their next tick.
 */
function onPartyPlayerOption(event) {
  if (!event || event.option !== PARTY_OPTION_SLOT || event.handled) return;
  const { player, target } = event;
  if (player?.isPlayerBot?.() === true) return;
  if (target?.isPlayerBot?.() !== true) return; // Only citizens.
  event.handled = true;

  const citizenName = target.getUsername?.();
  const playerName = player.getUsername?.();
  if (!citizenName || !playerName) return;

  // Already in a party together? Just confirm.
  try {
    const party = getParty(citizenName);
    if (party && (party.members ?? []).map(normalizeName).includes(normalizeName(playerName))) {
      sayTo(player, target, "We're already partied up!");
      return;
    }
  } catch {
    // Party unreadable — proceed with invite.
  }

  // Record the pending invite; the citizen's tick will decide.
  pendingInvites.set(normalizeName(citizenName), {
    playerName,
    player,
    expiresAt: Date.now() + INVITE_EXPIRES_MS,
  });

  // Visible: the citizen acknowledges the invite.
  try {
    const record = findRecord(citizenName);
    const voice = voiceFor(record?.personality ?? target.getAttribute?.(ATTR_CITIZEN_PERSONALITY));
    sayPublic(target, voiceLine(voice, {
      plain: ["Party invite? Let me think...", "Hmm, a party?"],
      terse: ["hmm.", "thinking."],
    }));
  } catch {
    // Silent acknowledgment.
  }
}

/** Say something to a specific player (game message). */
function sayTo(player, from, text) {
  try {
    player.sendMessage?.(`[${from.getUsername?.()}] ${text}`);
  } catch {
    // Best-effort.
  }
}

/** Find a citizen's roster record by name. */
function findRecord(citizenName) {
  try {
    const director = require("../director/CitizenDirector").getDirector?.();
    return director?.roster?.get?.(citizenName) ?? director?.roster?.get?.(normalizeName(citizenName)) ?? null;
  } catch {
    return null;
  }
}

// --- party combat tick ------------------------------------------------------

/**
 * Per-tick party maintenance. Called from CitizenDirector.
 * For each party led by a real player:
 * - Members already follow via tickFollow (movement).
 * - If the leader is in combat, members assist (real combat).
 * - Members eat at low HP, retreat when critical with no food.
 * - Throttled party chat.
 */
function tickPartyPlay(director) {
  if (!director) return;
  const nowMs = Date.now();

  // Prune expired invites.
  for (const [name, invite] of pendingInvites) {
    if (nowMs > invite.expiresAt) pendingInvites.delete(name);
  }

  const seenParties = new Set();
  for (const record of director.roster?.values?.() ?? []) {
    const party = getParty(record.username);
    if (!party || seenParties.has(partyKey(party))) continue;
    seenParties.add(partyKey(party));

    try {
      tickOneParty(director, party, nowMs);
    } catch {
      // One bad party must not break the tick.
    }
  }

  // Resolve pending player→citizen invites.
  resolvePendingInvites(director, nowMs);
}

function partyKey(party) {
  return `${party.leader ?? "none"}:${(party.members ?? []).length}`;
}

/** Process pending invites: citizens decide accept/decline. */
function resolvePendingInvites(director, nowMs) {
  for (const [citizenKey, invite] of pendingInvites) {
    if (nowMs > invite.expiresAt) {
      pendingInvites.delete(citizenKey);
      continue;
    }
    const record = findRecordByKey(director, citizenKey);
    const bot = record ? director.getBot?.(record) : null;
    if (!record || !bot) continue; // Citizen not materialized yet.

    pendingInvites.delete(citizenKey);
    // Get the citizen's real combat level for the sanity check.
    let citizenCombat = 3;
    try {
      citizenCombat = bot.getSkillManager?.()?.getCombatLevel?.() ?? 3;
    } catch {
      // Fallback to 3.
    }
    const decision = decidePartyInvite(record, invite.player, citizenCombat);

    try {
      const voice = voiceFor(record.personality);
      if (decision.accept) {
        // Join or create the party.
        joinOrCreateParty(record.username, invite.playerName);
        sayPublic(bot, voiceLine(voice, ACCEPT_LINES));
        // Relationship: accepting is a positive interaction.
        recordInteraction(record.username, invite.playerName, "partied");
      } else {
        const lines = decision.reason === "enemy" ? ENEMY_DECLINE_LINES : DECLINE_LINES;
        sayPublic(bot, voiceLine(voice, lines));
      }
    } catch {
      // Decision made but speech failed — non-fatal.
    }
  }
}

function findRecordByKey(director, key) {
  for (const record of director.roster?.values?.() ?? []) {
    if (normalizeName(record.username) === key) return record;
  }
  return null;
}

/** Add a player to a citizen's party, or create a new party. */
function joinOrCreateParty(citizenName, playerName) {
  let party = getParty(citizenName);
  if (!party) {
    party = {
      leader: citizenName,
      members: [citizenName],
      formedAt: Date.now(),
      playerLed: false,
    };
  }
  // The PLAYER leads (they invited). Citizens follow the player.
  party.leader = playerName;
  party.playerLed = true;
  if (!(party.members ?? []).map(normalizeName).includes(normalizeName(playerName))) {
    party.members.push(playerName);
  }
  // Every citizen member gets the updated party (so tickFollow works).
  for (const member of party.members ?? []) {
    try {
      if (member !== playerName) setParty(member, party);
    } catch {
      // Best-effort.
    }
  }
  setParty(citizenName, party);
  return party;
}

/** Per-party tick: combat assist, food, retreat, chat. */
function tickOneParty(director, party, nowMs) {
  const leaderName = party.leader;
  if (!leaderName) return;

  // Only player-led parties get combat assist (citizen-led parties use
  // the autonomous systems — ActivityParties, BossRuns).
  if (!party.playerLed) return;

  const leader = findPlayerEntity(leaderName);
  if (!leader) return; // Leader logged out — members keep following via tickFollow.

  // What's the leader fighting?
  const target = getCombatTarget(leader);
  
  for (const memberName of party.members ?? []) {
    if (normalizeName(memberName) === normalizeName(leaderName)) continue;
    const record = findRecordByKey(director, normalizeName(memberName));
    const bot = record ? director.getBot?.(record) : null;
    if (!record || !bot) continue;

    try {
      tickPartyMember(director, record, bot, leader, target, party, nowMs);
    } catch {
      // One bad member must not break the party.
    }
  }
}

/** Per-member tick: assist, eat, retreat. */
function tickPartyMember(director, record, bot, leader, target, party, nowMs) {
  const hp = hpPercent(bot);

  // 1. SURVIVAL FIRST: eat when hurt.
  if (hp < EAT_AT_HP_PERCENT) {
    const ate = eatBestFood(bot);
    if (ate) {
      const voice = voiceFor(record.personality);
      sayPublic(bot, voiceLine(voice, EAT_LINES));
      return; // Eating takes priority this tick.
    }
    // No food and critical — retreat!
    if (hp < RETREAT_AT_HP_PERCENT) {
      retreatFromCombat(bot, record);
      return;
    }
  }

  // 2. COMBAT ASSIST: if the leader is fighting something, join in.
  if (target && isAttackable(target)) {
    const currentTarget = getCombatTarget(bot);
    if (currentTarget !== target) {
      // In range? Attack. Too far? tickFollow will close the distance.
      if (distanceTo(bot, target) <= ASSIST_RANGE_TILES) {
        try {
          bot.getCombat?.()?.attack?.(target);
          // Occasional assist line (throttled per party).
          maybePartyChat(party, bot, record, ASSIST_LINES, nowMs);
        } catch {
          // Combat failed — non-fatal.
        }
      }
    }
  } else {
    // Leader not in combat — make sure we're not stuck fighting.
    // (Don't reset combat aggressively; the engine handles disengage.)
  }
}

/** Get an entity's current combat target (player or NPC). */
function getCombatTarget(entity) {
  try {
    return entity?.getCombat?.()?.getTarget?.() ?? null;
  } catch {
    return null;
  }
}

/** Is this NPC attackable? (Not dead, not already dead.) */
function isAttackable(npc) {
  try {
    if (!npc) return false;
    const hp = npc.getHitpoints?.() ?? npc.getCurrentHitpoints?.() ?? 1;
    const maxHp = npc.getMaxHitpoints?.() ?? 1;
    if (hp <= 0) return false;
    if (npc.isDead?.()) return false;
    return true;
  } catch {
    return false;
  }
}

/** Tile distance between two entities. */
function distanceTo(a, b) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb) return 999;
    const dx = (la.getX?.() ?? 0) - (lb.getX?.() ?? 0);
    const dy = (la.getY?.() ?? 0) - (lb.getY?.() ?? 0);
    return Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev.
  } catch {
    return 999;
  }
}

/** Retreat: stop combat and run away from the threat. */
function retreatFromCombat(bot, record) {
  try {
    bot.getCombat?.()?.reset?.();
  } catch {
    // Best-effort.
  }
  try {
    const voice = voiceFor(record.personality);
    sayPublic(bot, voiceLine(voice, RETREAT_LINES));
  } catch {
    // Silent retreat.
  }
  // Run: stop following into danger. tickFollow will re-engage when safe.
  // (We don't clear the party — just break combat this tick.)
}

/** Throttled party chat line. */
function maybePartyChat(party, bot, record, lines, nowMs) {
  const key = partyKey(party);
  const last = lastPartyChat.get(key) ?? 0;
  if (nowMs - last < PARTY_CHAT_COOLDOWN_MS) return;
  lastPartyChat.set(key, nowMs);
  try {
    const voice = voiceFor(record.personality);
    sayPublic(bot, voiceLine(voice, lines));
  } catch {
    // Silent.
  }
}

/** Find a player entity by name (real player or citizen bot). */
function findPlayerEntity(name) {
  try {
    // Real players via world.
    const { World } = require("../../../src/main/typescript/elvarg/game/World");
    const player = World.getPlayers?.()?.get?.(name) ?? null;
    if (player) return player;
  } catch {
    // World lookup failed.
  }
  try {
    // Maybe a citizen bot.
    const director = require("../director/CitizenDirector").getDirector?.();
    const record = findRecordByKey(director, normalizeName(name));
    return record ? director.getBot?.(record) : null;
  } catch {
    return null;
  }
}

/** Record a social interaction (relationship tracking). */
function recordInteraction(citizenName, playerName, kind) {
  try {
    require("./CitizenSocialBonds").recordInteraction(citizenName, playerName, kind);
  } catch {
    // Bonding must never break party play.
  }
}

// --- loot sharing & kill reactions ------------------------------------------

/**
 * On NPC death: if a party member (or their player leader) was involved,
 * share loot, say gz on bosses, boost the leader's relationship.
 *
 * The engine delivers drops through normal flow — we don't touch that.
 * Sharing = the citizen killer gives coin shares to party members
 * (real inventory transfer). Boss kills get celebration + memory.
 */
function onPartyKill(event) {
  const { npc, killer } = event ?? {};
  if (!npc || !killer) return;

  const killerName = killer.getUsername?.();
  if (!killerName) return;

  // Is the killer in a party?
  let party = null;
  try {
    party = getParty(killerName);
  } catch {
    return;
  }
  if (!party || !party.playerLed) return;

  const npcName = getNpcName(npc);
  const combatLevel = getNpcCombatLevel(npc);
  const isBoss = combatLevel >= BOSS_COMBAT_LEVEL;

  // Find citizen members (not the leader, not the killer).
  const members = (party.members ?? []).filter(
    (m) => normalizeName(m) !== normalizeName(killerName)
  );

  // Boss kill: everyone says gz.
  if (isBoss) {
    for (const memberName of members) {
      try {
        const director = require("../director/CitizenDirector").getDirector?.();
        const record = findRecordByKey(director, normalizeName(memberName));
        const bot = record ? director.getBot?.(record) : null;
        if (!bot) continue;
        const voice = voiceFor(record.personality);
        // Only the sociable ones speak up.
        const profile = humanizerProfile(record.personality);
        if ((profile.sociability ?? 1) < 0.7 && Math.random() < 0.5) continue;
        sayPublic(bot, voiceLine(voice, BOSS_KILL_LINES));
      } catch {
        // Silent.
      }
    }
    // Remember: this leader is good. Relationship boost.
    for (const memberName of members) {
      recordInteraction(memberName, party.leader, "good_party_leader");
    }
  }

  // Loot sharing: if the killer is a citizen with coins, share.
  if (killer.isPlayerBot?.() === true && members.length > 0) {
    shareLoot(killer, killerName, members, npcName);
  }
}

/** Share coins with party members (real inventory transfer). */
function shareLoot(killerBot, killerName, members, npcName) {
  try {
    const COINS = 995;
    const coins = killerBot.getInventory?.()?.getAmount?.(COINS) ?? 0;
    if (coins < 1000) return; // Not worth splitting pocket change.

    const share = Math.floor(coins * 0.1 / members.length);
    if (share < 10) return;

    for (const memberName of members) {
      try {
        const member = findPlayerEntity(memberName);
        if (!member) continue;
        const memberInv = member.getInventory?.();
        if (!memberInv) continue;
        killerBot.getInventory().deleteNumber(COINS, share);
        memberInv.adds(COINS, share);
      } catch {
        // One failed share doesn't stop the rest.
      }
    }

    // Announce the share.
    try {
      const director = require("../director/CitizenDirector").getDirector?.();
      const record = findRecordByKey(director, normalizeName(killerName));
      const voice = voiceFor(record?.personality ?? {});
      sayPublic(killerBot, voiceLine(voice, LOOT_SHARE_LINES));
    } catch {
      // Silent generosity.
    }
  } catch {
    // Sharing failed — non-fatal.
  }
}

function getNpcName(npc) {
  try {
    return npc.getDefinition?.()?.getName?.() ?? npc.getName?.() ?? "monster";
  } catch {
    return "monster";
  }
}

function getNpcCombatLevel(npc) {
  try {
    return npc.getDefinition?.()?.getCombatLevel?.() ?? npc.getCombatLevel?.() ?? 1;
  } catch {
    return 1;
  }
}

// --- leave party ------------------------------------------------------------

/** Remove a citizen from their party (e.g. on logout, or player dismisses). */
function leaveParty(citizenName) {
  try {
    const party = getParty(citizenName);
    if (!party) return;
    // Remove from member list.
    party.members = (party.members ?? []).filter(
      (m) => normalizeName(m) !== normalizeName(citizenName)
    );
    clearParty(citizenName);
    // If the party is now empty of citizens, it's done.
    const hasCitizens = (party.members ?? []).some((m) => {
      try {
        return findRecord(m)?.username != null;
      } catch {
        return false;
      }
    });
    if (!hasCitizens) {
      for (const m of party.members ?? []) {
        try { clearParty(m); } catch { /* best-effort */ }
      }
    }
  } catch {
    // Best-effort.
  }
}

// --- init -------------------------------------------------------------------

function initPartyPlay(api) {
  pluginApi = api;
  api.onPlayerProcess(({ player }) => syncPartyOption(player));
  api.onPlayerOption(onPartyPlayerOption);
  api.onNpcDeath(onPartyKill);
  api.onPlayerLogout(({ player }) => {
    try {
      const name = player?.getUsername?.();
      if (name && player?.isPlayerBot?.() === true) leaveParty(name);
    } catch {
      // Best-effort.
    }
  });
  api.log?.("[citizens] party play ready (right-click → Party)");
}

// --- test seam --------------------------------------------------------------

function _resetStateForTests() {
  pendingInvites.clear();
  lastPartyChat.clear();
  partyOptionSent.clear?.();
}

module.exports = {
  initPartyPlay,
  tickPartyPlay,
  onPartyPlayerOption,
  onPartyKill,
  decidePartyInvite,
  joinOrCreateParty,
  leaveParty,
  findBestFood,
  eatBestFood,
  PARTY_OPTION_SLOT,
  _resetStateForTests,
};
