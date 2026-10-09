"use strict";

/**
 * IdleSocial — the art of hanging around. Walks to a social anchor (court,
 * tavern) and lingers: occasional personality-flavoured chatter on log-normal
 * gaps, drifting a few tiles now and then, reacting to war alerts by
 * gathering closer to the anchor's heart.
 *
 * Social layer (brain/CitizenRelationships): citizens are social agents, not
 * scenery.
 *   - Extroverts (chatty/warm) seek out nearby friends and walk to them.
 *   - Introverts (taciturn/nervous/guarded) pick quiet spots away from crowds.
 *   - Everyone drifts away from nearby rivals.
 *   - Citizens clustered together fall into group conversation: group lines,
 *     staying clustered, and slow rapport gains with each companion.
 *   - Friends get warm greetings by name (per-pair cooldown).
 *   - A citizen near both a friend and a real player sometimes introduces them.
 *
 * Used directly by the courtier_attend and tavern_social activities, and as a
 * delegate by CitizenRoutine's social phases.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { isKingdomAtWar } = require("../../CitizenEvents");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const { isFriend, isEnemy } = require("../../lib/CitizenBonds");
const { noteInteraction } = require("../CitizenRelationships");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");

const ARRIVE_RADIUS = 3;
const NEARBY_SCAN_TILES = 12;
const GROUP_RADIUS = 6;
const GREET_RADIUS = 8;
const RIVAL_AVOID_RADIUS = 8;
const CROWD_RADIUS = 8;

const GREET_COOLDOWN_MS = 20 * 60 * 1000;
const INTRO_COOLDOWN_MS = 30 * 60 * 1000;
const RAPPORT_CHAT_COOLDOWN_MS = 15 * 60 * 1000;

const TAVERN_LINES = Object.freeze([
  "Ale's decent tonight.",
  "Heard the strangest rumour about the river...",
  "Another round? I'm buying. Well — almost.",
  "You ever wonder why the gods went quiet?",
  "My back's killing me. Getting old.",
  "Quiet in here for a weeknight.",
  "They say the king's men are hiring. Again.",
]);

const COURT_LINES = Object.freeze([
  "The court never sleeps, does it?",
  "Have you seen the steward? I need a word.",
  "Politics. Give me an honest day's work instead.",
  "They say the succession question is... delicate.",
  "Mind your manners past those doors.",
]);

const COURT_LINES_WAR = Object.freeze([
  "War. The court reeks of fear and perfume.",
  "They're mustering the guard. Stay close to the walls.",
]);

const MARKET_LINES = Object.freeze([
  "Just looking today.",
  "Prices are up again, I swear.",
  "Smell that bread...",
  "Mind the pickpockets, friend.",
  "Good crowd today.",
]);

const GROUP_LINES = Object.freeze({
  plain: Object.freeze([
    "You lot hear the news from the river?",
    "Good company, this.",
    "Anyone else short on coin this week?",
    "Remember when the well ran dry? Dark times.",
    "I'll get the next round. Probably.",
    "So what are we all avoiding going home to?",
  ]),
  terse: Object.freeze(["Hm.", "News?", "Coin's tight.", "Aye."]),
});

const FRIEND_GREET_LINES = Object.freeze({
  plain: Object.freeze([
    "{name}! Good to see you.",
    "{name} — pull up a stool.",
    "Well met, {name}!",
    "{name}! You look well.",
  ]),
  terse: Object.freeze(["{name}.", "Oh. {name}.", "Hey, {name}."]),
});

const INTRO_LINES = Object.freeze({
  plain: Object.freeze([
    "Have you met {name}? Knows everyone worth knowing.",
    "{name}, this one's new — be nice.",
    "You two should talk — {name} was just saying the same thing.",
  ]),
  terse: Object.freeze(["This is {name}.", "{name}. Talk."]),
});

function linesFor(anchorKind, atWar) {
  if (anchorKind === "court") {
    return atWar ? COURT_LINES_WAR : COURT_LINES;
  }
  if (anchorKind === "market") {
    return MARKET_LINES;
  }
  return TAVERN_LINES;
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function dist(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function locOf(player) {
  try {
    const l = player.getLocation();
    return { x: l.getX(), y: l.getY(), z: l.getZ() ?? 0 };
  } catch {
    return null;
  }
}

function isCitizenBot(p, selfName) {
  try {
    if (!p || p.isPlayerBot?.() !== true) return false;
    const n = p.getUsername?.();
    return !!n && String(n).toLowerCase() !== String(selfName).toLowerCase();
  } catch {
    return false;
  }
}

function isRealPlayer(p) {
  try {
    if (!p || p.isPlayerBot?.() === true) return false;
    if (p.getHostAddress?.() === "bot") return false;
    return typeof p.getUsername === "function";
  } catch {
    return false;
  }
}

/** Nearby citizen bots and real players, with locations. */
function scanNearby(player, selfName, radius = NEARBY_SCAN_TILES) {
  const me = locOf(player);
  if (!me) return { citizens: [], reals: [] };
  const citizens = [];
  const reals = [];
  let locals = [];
  try {
    locals = player.getLocalPlayers?.() ?? [];
  } catch {
    locals = [];
  }
  for (const p of locals) {
    const l = locOf(p);
    if (!l || l.z !== me.z || dist(me, l) > radius) continue;
    if (isCitizenBot(p, selfName)) citizens.push({ player: p, name: p.getUsername(), loc: l });
    else if (isRealPlayer(p)) reals.push({ player: p, name: p.getUsername(), loc: l });
  }
  return { citizens, reals };
}

function cooldownOk(map, key, cooldownMs, nowMs) {
  return nowMs - (map[key] ?? 0) >= cooldownMs;
}

function createIdleSocialAction(spec, world) {
  const anchorKind = ["court", "tavern", "market"].includes(spec.anchorKind)
    ? spec.anchorKind
    : "tavern";
  const chatterMinMs = Math.max(1000, Number(spec.chatterMinMs ?? 60000));
  const chatterMaxMs = Math.max(chatterMinMs, Number(spec.chatterMaxMs ?? 240000));

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`social:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        voice: voiceFor(personality),
        spot: null,
        nextChatAt: 0,
        nextDriftAt: 0,
        greetedAt: {},
        introAt: {},
        chatPairAt: {},
      };
    });
  }

  function sayStyled(player, state, pool, fill = {}) {
    try {
      let line = voiceLine(state.voice, pool, state.rng);
      for (const [k, v] of Object.entries(fill)) {
        line = line.split(`{${k}}`).join(String(v));
      }
      if (line) sayPublic(player, line);
    } catch {
      // Cosmetic only.
    }
  }

  const action = {
    id: "idleSocial",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      const selfName = player.getUsername?.() ?? "unknown";
      const kingdomId = kingdomIdOf(player);
      const atWar = isKingdomAtWar(kingdomId);
      const anchor = siteTile(player, anchorKind) ?? siteTile(player, "tavern");
      if (!anchor) {
        return "failed";
      }

      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }

      const me = locOf(player);
      const { citizens, reals } = scanNearby(player, selfName);
      const sociability = state.human.sociability ?? 1;

      const friendsNear = citizens.filter((c) => {
        try {
          return isFriend(selfName, c.name);
        } catch {
          return false;
        }
      });
      const rivalsNear = citizens.filter((c) => {
        try {
          return isEnemy(selfName, c.name);
        } catch {
          return false;
        }
      });

      // --- Rival avoidance: everyone gives rivals a wide berth. ---
      const nearRival = rivalsNear
        .filter((c) => me && dist(me, c.loc) <= RIVAL_AVOID_RADIUS)
        .sort((a, b) => dist(me, a.loc) - dist(me, b.loc))[0];
      if (nearRival && me) {
        const dx = me.x - nearRival.loc.x;
        const dy = me.y - nearRival.loc.y;
        const tile = {
          x: me.x + (dx === 0 ? (chance(state.rng, 0.5) ? 6 : -6) : Math.sign(dx) * 7),
          y: me.y + (dy === 0 ? (chance(state.rng, 0.5) ? 6 : -6) : Math.sign(dy) * 7),
          z: me.z,
        };
        state.spot = tile;
        requestMovement(player, tile.x, tile.y, {
          reason: "citizen_social_avoid",
          basicPather: true,
          z: tile.z,
        });
        return "running";
      }

      // --- Friend-seeking: extroverts walk to nearby friends. ---
      const seeksFriends = sociability >= 1.2;
      if (seeksFriends && friendsNear.length > 0 && me) {
        const nearest = friendsNear.sort((a, b) => dist(me, a.loc) - dist(me, b.loc))[0];
        if (dist(me, nearest.loc) > 4) {
          const tile = noisyTile(nearest.loc.x, nearest.loc.y, 2, state.rng);
          state.spot = { x: tile.x, y: tile.y, z: nearest.loc.z };
          requestMovement(player, tile.x, tile.y, {
            reason: "citizen_social_friend",
            basicPather: true,
            z: nearest.loc.z,
          });
          return "running";
        }
      }

      // --- Spot picking: introverts avoid crowds. ---
      const avoidsCrowds = sociability <= 0.6;
      if (!state.spot || (atWar && state.spot.loose === true)) {
        const radius = atWar ? 2 : 6;
        let tile = noisyTile(anchor.x, anchor.y, radius, state.rng);
        if (avoidsCrowds && me) {
          let best = tile;
          let bestCount = Infinity;
          for (let i = 0; i < 3; i++) {
            const cand = noisyTile(anchor.x, anchor.y, radius + 4, state.rng);
            const count = citizens.filter(
              (c) => Math.max(Math.abs(c.loc.x - cand.x), Math.abs(c.loc.y - cand.y)) <= CROWD_RADIUS
            ).length;
            if (count < bestCount) {
              best = cand;
              bestCount = count;
            }
          }
          tile = best;
        }
        state.spot = { x: tile.x, y: tile.y, z: anchor.z ?? 0, loose: atWar !== true };
      }
      if (!atTile(player, state.spot)) {
        requestMovement(player, state.spot.x, state.spot.y, {
          reason: "citizen_social",
          basicPather: true,
          z: state.spot.z,
        });
        return "running";
      }

      // --- Group conversation: clustered citizens chat together. ---
      const group = me ? citizens.filter((c) => dist(me, c.loc) <= GROUP_RADIUS) : [];
      const grouped = group.length >= 1;

      // Warm greetings for friends arriving nearby.
      for (const f of friendsNear) {
        if (
          me &&
          dist(me, f.loc) <= GREET_RADIUS &&
          cooldownOk(state.greetedAt, f.name.toLowerCase(), GREET_COOLDOWN_MS, nowMs)
        ) {
          state.greetedAt[f.name.toLowerCase()] = nowMs;
          const first = String(f.name).split(" ")[0];
          sayStyled(player, state, FRIEND_GREET_LINES, { name: first });
          try {
            noteInteraction(selfName, f.name, "greeted");
          } catch {
            // Rapport must never break social.
          }
          break; // one greeting per tick
        }
      }

      // Drift: humans don't root to a tile for an hour. Grouped citizens
      // stay clustered; loners drift.
      if (nowMs >= state.nextDriftAt) {
        state.nextDriftAt =
          nowMs + logNormalJitter(state.rng, 120000, state.human.tempoSigma);
        if (!grouped && chance(state.rng, 0.5)) {
          const tile = noisyTile(anchor.x, anchor.y, atWar ? 2 : 6, state.rng);
          state.spot = { x: tile.x, y: tile.y, z: anchor.z ?? 0, loose: atWar !== true };
          return "running";
        }
      }

      // Chatter on log-normal gaps, scaled by personality.
      if (nowMs >= state.nextChatAt) {
        const gap = chatterMinMs + state.rng() * (chatterMaxMs - chatterMinMs);
        state.nextChatAt =
          nowMs + Math.round(gap / Math.max(0.2, state.human.chatRate));

        // Introductions: friend + real player nearby.
        if (friendsNear.length > 0 && reals.length > 0 && me && chance(state.rng, 0.3)) {
          const f = friendsNear[Math.floor(state.rng() * friendsNear.length)];
          if (
            dist(me, f.loc) <= GREET_RADIUS &&
            cooldownOk(state.introAt, f.name.toLowerCase(), INTRO_COOLDOWN_MS, nowMs)
          ) {
            state.introAt[f.name.toLowerCase()] = nowMs;
            const first = String(f.name).split(" ")[0];
            sayStyled(player, state, INTRO_LINES, { name: first });
            return "running";
          }
        }

        if (grouped && chance(state.rng, 0.7)) {
          sayStyled(player, state, GROUP_LINES);
          // Hanging out together warms rapport, slowly.
          for (const c of group.slice(0, 3)) {
            const key = `${selfName.toLowerCase()}>${String(c.name).toLowerCase()}`;
            if (cooldownOk(state.chatPairAt, key, RAPPORT_CHAT_COOLDOWN_MS, nowMs)) {
              state.chatPairAt[key] = nowMs;
              try {
                noteInteraction(selfName, c.name, "chatted");
              } catch {
                // Rapport must never break social.
              }
            }
          }
        } else if (chance(state.rng, 0.65)) {
          const pool = linesFor(anchorKind, atWar);
          try {
            sayPublic(player, pool[Math.floor(state.rng() * pool.length)]);
          } catch {
            // Cosmetic only.
          }
        }
      }
      return "running";
    },
    stop(ctx) {
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  return action;
}

module.exports = {
  createIdleSocialAction,
};
