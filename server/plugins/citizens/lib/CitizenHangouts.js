"use strict";

/**
 * CitizenHangouts — visible ambient social clusters.
 *
 * Citizens don't just walk past each other; sometimes they stop and stay
 * awhile. A hangout is 2-5 citizens converging on a social anchor (tavern,
 * town square, market corner), forming a loose circle, and exchanging
 * ambient chit-chat for a few minutes before drifting back to their lives.
 *
 * From Jon's perspective it reads like players idling together between
 * activities: facing each other, chatting, laughing, then dispersing.
 *
 * Design notes:
 *   - DATA TIER, zero LLM. All lines are a curated ambient corpus,
 *     personality-weighted. The foreground LLM never needs this.
 *   - Prefer friends and familiar faces; never seat enemies together.
 *   - Hangouts strengthen the social fabric: repeat hangouts build
 *     familiarity, and strangers can become friends here (bounded).
 *   - Every member journals "hung out with X, Y at the tavern", so when
 *     a player asks "what have you been up to?", the LLM speaks truthfully.
 *
 * Wiring: CitizenDirector.tick() calls tickHangouts(this, hour) once per
 * tick, after the offices block. Travel leans on BotNavigation directly
 * (like the other citizen modules), not the brain activities, so a
 * hangout is a soft overlay — the brain resumes normally when it ends.
 */

const { agentRng, chance, humanizerProfile } = require("./humanizer");
const { getJournal } = require("./CitizenJournal");
const {
  isFriend,
  isEnemy,
  addFriend,
  getParty,
  normalizeName,
} = require("./CitizenBonds");
const { siteTileByKingdom } = require("../brain/CitizenSites");

// --- tuning ------------------------------------------------------------------

const FORM_CHANCE_PER_TICK = 0.08; // per kingdom per ~60s tick
const MAX_ACTIVE_PER_KINGDOM = 1; // at most one visible cluster per kingdom
const MAX_ACTIVE_GLOBAL = 3; // world-wide cap
const HANGOUT_TICKS_MIN = 3; // ~3-7 minutes of lingering
const HANGOUT_TICKS_MAX = 7;
const MEMBER_COOLDOWN_MS = 45 * 60 * 1000; // a citizen hangs out every ~45min max
const HOST_RADIUS = 35; // host must be within this many tiles of the anchor
const GUEST_RADIUS = 50; // guests within this many tiles
const ARRIVED_RADIUS = 4; // close enough to count as "at the circle"
const LINE_CHANCE = 0.5; // per tick: someone says something
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 5;

// Social anchor kinds, in preference order. Keldagrim has no tavern in
// sites.json; the fallback chain keeps a misconfigured kingdom sane.
const ANCHOR_KINDS = ["tavern", "square", "market"];

// Ring offsets around the anchor so members form a loose circle.
const RING = [
  [2, 0], [-2, 0], [0, 2], [0, -2],
  [2, 2], [-2, -2], [2, -2], [-2, 2],
];

// Familiarity: pair -> hangouts shared. Drives invite preference and the
// bounded friendship formation. In-memory; the journal is the durable record.
const familiarity = new Map();
function pairKey(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}
function bumpFamiliarity(a, b) {
  const key = pairKey(a, b);
  familiarity.set(key, (familiarity.get(key) ?? 0) + 1);
  return familiarity.get(key);
}
function getFamiliarity(a, b) {
  return familiarity.get(pairKey(a, b)) ?? 0;
}

// Ambient chit-chat corpus. Short, warm, human; no em dashes — these lines
// are player-visible forceChat. {name} and {kingdom} get substituted.
const CHIT_CHAT = Object.freeze([
  "Quiet today, isn't it.",
  "You look well rested. Lucky.",
  "Heard the market's short on bread again.",
  "I swear the days are getting shorter.",
  "Remind me to never take the night watch again.",
  "My boots are falling apart. Anyone know a cobbler?",
  "Saw a merchant selling silk down by the docks. Silk!",
  "I dreamed about the sea last night.",
  "Do you think the king ever gets tired of the crown?",
  "Someone's roasting something good over there. Smell that?",
  "I lost at dice again. Third time this week.",
  "The guards were drilling at dawn. Woke the whole street.",
  "If it rains again I'll scream.",
  "Lovely weather, though. Can't complain.",
  "You hear about the price of iron? Outrageous.",
  "I miss the old festivals. Used to be music every week.",
  "Someone told me there's a new stall by the square.",
  "I need a nap and it's barely midday.",
  "Have you tried the tavern's new stew? Actually decent.",
  "One more hour of this and I'm done for the day.",
  "I keep meaning to visit my cousin in the next town.",
  "Careful on the road north, I heard. Bandits, maybe.",
  "The flowers by the fountain are blooming early.",
  "I won at dice! Finally. Don't tell my wife.",
  "You ever wonder what's past the mountains?",
  "The smith's hammering kept me up half the night.",
  "I feel like something's about to happen. Good or bad, can't say.",
  "Anyone else starving? Just me?",
  "I saw the strangest cloud this morning. Looked like a ship.",
  "Work can wait. This is nicer.",
]);

const FRIENDLY_LINES = Object.freeze([
  "Good to see you, {name}.",
  "There you are, {name}! Was wondering where you'd got to.",
  "How's the family, {name}?",
  "Still owe you a drink, {name}. One of these days.",
  "You always know where the good gossip is, {name}.",
]);

const WARM_LINES = Object.freeze([
  "You're good company, {name}.",
  "We should do this more often.",
  "This is the best part of the day, honestly.",
]);

// Active hangouts: kingdomId -> hangout. One per kingdom max.
const active = new Map(); // kingdomId -> hangout object
const memberCooldown = new Map(); // normalized username -> ms timestamp

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

function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "social", text);
  } catch {
    // Non-fatal.
  }
}

function requestMovement(bot, x, y, z) {
  try {
    const { requestMovement: rm } = require("../../bots/behaviours/navigation/BotNavigation");
    rm(bot, x, y, { reason: "citizen_hangout", basicPather: true, z: z ?? 0 });
    return true;
  } catch {
    return false;
  }
}

function faceToward(bot, targetTile) {
  try {
    const my = botTile(bot);
    if (!my || !targetTile) return false;
    const dx = Math.sign(targetTile.x - my.x);
    const dy = Math.sign(targetTile.y - my.y);
    if (dx === 0 && dy === 0) return false;
    bot.face?.(targetTile.x, targetTile.y);
    return true;
  } catch {
    return false;
  }
}

/** Anchor tile for a kingdom: tavern first, then square, then market. */
function anchorFor(kingdomId) {
  for (const kind of ANCHOR_KINDS) {
    const tile = siteTileByKingdom(kingdomId, kind);
    if (tile) return { tile, kind };
  }
  return null;
}

function isBusyCitizen(record) {
  try {
    return getParty(normalizeName(record.username)) != null;
  } catch {
    return false;
  }
}

function inHangout(record) {
  return record.hangoutUntil != null && record.hangoutUntil > Date.now();
}

function eligibleHost(record, director, anchorTile) {
  if (record.hangoutUntil > Date.now()) return false;
  if (isBusyCitizen(record)) return false;
  const bot = director.getBot(record);
  if (!bot) return false;
  const tile = botTile(bot);
  if (!tile || chebyshev(tile, anchorTile) > HOST_RADIUS) return false;
  const cd = memberCooldown.get(normalizeName(record.username)) ?? 0;
  if (Date.now() - cd < MEMBER_COOLDOWN_MS) return false;
  // Nervous/guarded citizens don't start gatherings; chatty/warm ones do.
  const profile = humanizerProfile(record.personality);
  if (profile.sociability < 0.9) return false;
  return true;
}

function eligibleGuest(record, director, host, anchorTile) {
  if (record === host) return false;
  if (record.hangoutUntil > Date.now()) return false;
  if (isBusyCitizen(record)) return false;
  if (record.kingdomId !== host.kingdomId) return false;
  const bot = director.getBot(record);
  if (!bot) return false;
  const tile = botTile(bot);
  if (!tile || chebyshev(tile, anchorTile) > GUEST_RADIUS) return false;
  const cd = memberCooldown.get(normalizeName(record.username)) ?? 0;
  if (Date.now() - cd < MEMBER_COOLDOWN_MS) return false;
  // Never seat enemies together. Taciturn citizens rarely join.
  if (isEnemy(host.username, record.username)) return false;
  const profile = humanizerProfile(record.personality);
  return profile.sociability >= 0.6;
}

/** Score a guest for a hangout: friends first, then familiar faces. */
function guestScore(host, guest, rng) {
  let score = rng();
  if (isFriend(host.username, guest.username)) score += 2.0;
  else score += Math.min(getFamiliarity(host.username, guest.username), 4) * 0.4;
  const profile = humanizerProfile(guest.personality);
  score += (profile.sociability - 1.0) * 0.5;
  return score;
}

function markBusy(record, untilMs) {
  record.hangoutUntil = untilMs;
  memberCooldown.set(normalizeName(record.username), Date.now());
}

function tryFormHangout(director, rng, nowMs) {
  if (active.size >= MAX_ACTIVE_GLOBAL) return;
  const kingdoms = Array.from(director.roster.values())
    .map((r) => r.kingdomId)
    .filter((id, i, arr) => id && !active.has(id) && arr.indexOf(id) === i);
  if (!kingdoms.length) return;
  // One kingdom per tick max, so formations stay rare and readable.
  const kingdomId = pickOne(rng, kingdoms);
  if (!chance(rng, FORM_CHANCE_PER_TICK)) return;
  const anchor = anchorFor(kingdomId);
  if (!anchor) return;

  const citizens = Array.from(director.roster.values()).filter(
    (r) => director.isOnline(r) && r.kingdomId === kingdomId
  );
  const hosts = citizens.filter((r) => eligibleHost(r, director, anchor.tile));
  if (!hosts.length) return;
  const host = pickOne(rng, hosts);

  const guests = citizens
    .filter((r) => eligibleGuest(r, director, host, anchor.tile))
    .map((r) => ({ record: r, score: guestScore(host, r, rng) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MEMBERS - 1)
    .map((g) => g.record);
  const members = [host, ...guests];
  if (members.length < MIN_MEMBERS) return;

  const hangout = {
    kingdomId,
    anchorTile: anchor.tile,
    anchorKind: anchor.kind,
    members: members.map((record, i) => {
      const ring = RING[i % RING.length];
      return {
        record,
        // Jitter the ring tile so the circle looks organic, not a grid.
        ringTile: {
          x: anchor.tile.x + ring[0] + Math.floor(rng() * 3) - 1,
          y: anchor.tile.y + ring[1] + Math.floor(rng() * 3) - 1,
          z: anchor.tile.z ?? 0,
        },
        arrived: false,
      };
    }),
    ticksLeft: HANGOUT_TICKS_MIN + Math.floor(rng() * (HANGOUT_TICKS_MAX - HANGOUT_TICKS_MIN + 1)),
    lineCooldown: 1,
  };

  const untilMs = nowMs + (hangout.ticksLeft + 3) * 60 * 1000;
  for (const m of hangout.members) {
    markBusy(m.record, untilMs);
    // Nudge everyone toward the circle. The brain's own activity may re-path
    // them mid-hangout; the tick re-nudges until they arrive.
    try {
      requestMovement(director.getBot(m.record), m.ringTile.x, m.ringTile.y, m.ringTile.z);
    } catch {
      // Non-fatal.
    }
  }
  active.set(kingdomId, hangout);
  const names = hangout.members.map((m) => m.record.username).join(", ");
  journalEvent(host.username, `started hanging out with ${names} at the ${anchor.kind}`, "social");
  try {
    director.log?.("hangout formed", { kingdom: kingdomId, anchor: anchor.kind, members: names });
  } catch {
    // Non-fatal.
  }
}

function speakMember(director, hangout, rng) {
  const arrived = hangout.members.filter((m) => m.arrived);
  if (!arrived.length) return;
  const speaker = pickOne(rng, arrived);
  const profile = humanizerProfile(speaker.record.personality);
  if (!chance(rng, LINE_CHANCE * profile.chatRate)) return;

  const others = hangout.members.filter((m) => m !== speaker).map((m) => m.record.username);
  let line;
  const roll = rng();
  if (roll < 0.25 && others.length) {
    // Address a friend warmly, or just someone present.
    const target = pickOne(rng, others);
    const friendly = isFriend(speaker.record.username, target);
    line = friendly
      ? pickOne(rng, FRIENDLY_LINES)
      : pickOne(rng, WARM_LINES);
    line = line.replace("{name}", target);
  } else {
    line = pickOne(rng, CHIT_CHAT);
  }
  line = line.replace("{kingdom}", hangout.kingdomId);

  try {
    const bot = director.getBot(speaker.record);
    if (!bot) return;
    // Look at who you're talking to: the anchor/center reads as the group.
    faceToward(bot, hangout.anchorTile);
    bot.forceChat?.(line);
    journalEvent(speaker.record.username, `chatted at the ${hangout.anchorKind}: "${line}"`, "social");
  } catch {
    // Non-fatal.
  }
}

function endHangout(director, kingdomId, rng) {
  const hangout = active.get(kingdomId);
  if (!hangout) return;
  active.delete(kingdomId);
  const names = hangout.members.map((m) => m.record.username);
  // Familiarity grows; one bounded new friendship may spark from a good time.
  let newFriendship = false;
  for (let i = 0; i < names.length && !newFriendship; i++) {
    for (let j = i + 1; j < names.length && !newFriendship; j++) {
      const fam = bumpFamiliarity(names[i], names[j]);
      if (
        fam >= 3 &&
        !isFriend(names[i], names[j]) &&
        !isEnemy(names[i], names[j]) &&
        chance(rng, 0.35)
      ) {
        try {
          addFriend(names[i], names[j]);
          newFriendship = true;
          journalEvent(names[i], `became friends with ${names[j]} after hanging out together`, "social");
          journalEvent(names[j], `became friends with ${names[i]} after hanging out together`, "social");
        } catch {
          // Non-fatal.
        }
      }
    }
  }
  for (const m of hangout.members) {
    try {
      const others = names.filter((n) => n !== m.record.username).join(", ");
      journalEvent(m.record.username, `hung out with ${others} at the ${hangout.anchorKind}`, "social");
      m.record.hangoutUntil = null;
      // Send them on their way: the brain will re-path on its own next tick,
      // but a small drift step breaks the circle so they visibly disperse.
      const bot = director.getBot(m.record);
      const tile = bot && botTile(bot);
      if (tile) {
        const dx = Math.sign(tile.x - hangout.anchorTile.x) || (rng() < 0.5 ? 1 : -1);
        const dy = Math.sign(tile.y - hangout.anchorTile.y) || (rng() < 0.5 ? 1 : -1);
        requestMovement(bot, tile.x + dx * 3, tile.y + dy * 3, tile.z);
      }
    } catch {
      // Non-fatal.
    }
  }
  try {
    director.log?.("hangout ended", {
      kingdom: kingdomId,
      members: names.join(", "),
      newFriendship,
    });
  } catch {
    // Non-fatal.
  }
}

/**
 * Director tick: maintain active hangouts, occasionally form new ones.
 * Everything is per-citizen try/catch — a hangout never breaks the tick.
 */
function tickHangouts(director, hour) {
  const nowMs = Date.now();
  const rng = agentRng(`hangouts:${nowMs >> 16}`);

  // Maintain existing hangouts.
  for (const [kingdomId, hangout] of Array.from(active.entries())) {
    try {
      let allArrived = true;
      for (const m of hangout.members) {
        const bot = director.getBot(m.record);
        if (!bot || !director.isOnline(m.record)) {
          m.arrived = false;
          allArrived = false;
          continue;
        }
        const tile = botTile(bot);
        if (!tile) {
          allArrived = false;
          continue;
        }
        if (!m.arrived) {
          if (chebyshev(tile, m.ringTile) <= ARRIVED_RADIUS) {
            m.arrived = true;
          } else {
            allArrived = false;
            // Re-nudge: the brain may have stolen them mid-walk.
            requestMovement(bot, m.ringTile.x, m.ringTile.y, m.ringTile.z);
            continue;
          }
        }
        // Face the center of the group: a circle of people talking.
        faceToward(bot, hangout.anchorTile);
      }
      hangout.ticksLeft -= 1;
      if (hangout.ticksLeft <= 0) {
        endHangout(director, kingdomId, rng);
        continue;
      }
      // Someone says something every couple of ticks once folks arrive.
      if (allArrived) {
        hangout.lineCooldown -= 1;
        if (hangout.lineCooldown <= 0) {
          speakMember(director, hangout, rng);
          hangout.lineCooldown = 2;
        }
      }
    } catch {
      // Non-fatal; keep other hangouts healthy.
    }
  }

  // Form new ones (bounded, rare).
  try {
    tryFormHangout(director, rng, nowMs);
  } catch {
    // Non-fatal.
  }
}

module.exports = {
  tickHangouts,
  // Exposed for tests.
  _test: {
    active,
    familiarity,
    pairKey,
    getFamiliarity,
    guestScore,
    anchorFor,
    ANCHOR_KINDS,
    eligibleHost,
    eligibleGuest,
    tryFormHangout,
    endHangout,
    FORM_CHANCE_PER_TICK,
  },
};
