"use strict";

/**
 * CitizenConversations.js (chat) — multi-turn citizen conversations.
 *
 * WHY THIS EXISTS (root cause of the "always exactly 2 messages" tell):
 * the old passerby chat in CitizenAlive.tickSocialAwareness was a
 * hard-coded two-step script with NO conversation state: citizen A spoke
 * one greeting from a 6-line pool, and a single coin flip
 * (0.4 x B's sociability) decided whether B spoke exactly one line from
 * a 4-line content-free pool ("Hey!", "Good day!", "Alright, mate.",
 * "You too!"). A third turn was structurally impossible, so every
 * exchange anyone ever saw was exactly 2 lines (or a lone greeting).
 * The apprentice/master chatter had the same question+answer shape, and
 * the only multi-turn machinery (CitizenSocial LLM threads) is gated on
 * a real player nearby AND on the LLM gateway answering — in practice
 * the scripted 2-liners were all a player ever saw.
 *
 * This module replaces that shape with a real conversation engine:
 *   - A conversation is a small state machine: participants (2, often
 *     a 3rd joins), ONE topic chosen once from REAL state, a planned
 *     length drawn from a distribution, and turns scheduled seconds
 *     apart with human jitter.
 *   - Length varies: lone comments nobody answers, 2-line hellos,
 *     4-8 turn chats. Driven by relationship (friends talk longer),
 *     personality (sociability), and context (passing on the road vs
 *     standing together).
 *   - People get ignored, answer late, or walk off mid-chat (the next
 *     turn finds them gone / out of range and the chat just ends).
 *   - Topics come only from real state: the participants' current
 *     work (skilling session / profession), live wars from
 *     Wars.Kingdoms, the real bread price vs baseline from
 *     Prices.Economy, the latest CitizenNewspaper headline, the
 *     speaker's real CitizenIntents goal, boss runs from CitizenBossRuns
 *     (a live party via CitizenBonds, else a recently journaled boss
 *     event), and shared history from CitizenMemory / CitizenSocialBonds.
 *   - ZERO LLM anywhere. Templates + combinatorics + real state only.
 *
 * Volume discipline (501 citizens): a global cap on concurrent
 * conversations, per-citizen post-conversation cooldowns, and the
 * existing starter gates in CitizenAlive (greet chance + 5 min
 * lastGreetAt) all stay in force. sayPublic's per-citizen chat-box
 * throttle (8s) is respected by the turn pacing (3.8-8.5s between
 * turns, so the same speaker is >= 7.6s apart).
 *
 * Players: when a citizen answers a real player via the scripted
 * reflex pools in CitizenChat, maybePlayerFollowUp() can extend the
 * exchange with the same topic machinery (a follow-up thought, maybe
 * a second line, maybe a nearby friend chiming in) instead of the
 * conversation dying after exactly one reply.
 */

const { sayPublic, pickLineAvoidingRepeat } = require("./CitizenSayPublic");
const { voiceFor, voiceLine } = require("../lib/citizenVoice");
const { humanizerProfile } = require("../lib/humanizer");

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MAX_ACTIVE = 20; // concurrent conversations across the whole world
const MAX_TURNS = 8; // hard cap on lines in one conversation
const CONV_RADIUS = 14; // participants farther than this have "walked off"
const JOIN_RADIUS = 10; // a third citizen must be this close to join in
const TURN_DELAY_MIN_MS = 3800;
const TURN_DELAY_MAX_MS = 8500;
const STALE_MS = 3 * 60 * 1000; // safety prune for orphaned conversations
const COOLDOWN_MIN_MS = 4 * 60 * 1000; // per-citizen quiet time after a chat
const COOLDOWN_MAX_MS = 9 * 60 * 1000;
const TRAIL_OFF_CHANCE = 0.1; // per turn beyond the second, end early
const JOIN_CHANCE_LINGERING = 0.2;
const JOIN_CHANCE_PASSING = 0.07;
const BOSS_JOURNAL_RECENT_MS = 24 * 3600 * 1000; // a journaled boss run stays "recent" this long

// Player-directed initiation: a citizen occasionally OPENS a conversation
// with a nearby real player (the "player" kind already exists for
// continuations; initiation was citizen<->citizen only). Rare and heavily
// gated — one hail at a time, long cooldowns both sides.
const PLAYER_INITIATE_CITIZEN_COOLDOWN_MS = 15 * 60 * 1000; // a citizen hails a player at most every 15 min
const PLAYER_INITIATE_PLAYER_COOLDOWN_MS = 20 * 60 * 1000; // a real player is hailed at most every 20 min
const PLAYER_INITIATE_NO_REPLY_MS = 90 * 1000; // opener lingers this long for a reply

// Planned exchange lengths, drawn at conversation start. Contexts:
// "passing" (either party is on the move) skews short; "lingering"
// (both standing together) allows real conversations.
const LENGTH_TABLES = Object.freeze({
  passing: [
    [1, 0.28],
    [2, 0.45],
    [3, 0.18],
    [4, 0.09],
  ],
  lingering: [
    [1, 0.14],
    [2, 0.28],
    [3, 0.22],
    [4, 0.16],
    [5, 0.1],
    [6, 0.06],
    [7, 0.03],
    [8, 0.01],
  ],
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let nextConvId = 1;
const conversations = new Map(); // id -> conv
const byParticipant = new Map(); // username -> conv id
const cooldownUntil = new Map(); // username -> ms timestamp
const lastInitiateByCitizen = new Map(); // username -> timestamp (player hails)
const lastInitiatedPlayer = new Map(); // player name -> timestamp (player hails)

function _resetForTests() {
  conversations.clear();
  byParticipant.clear();
  cooldownUntil.clear();
  lastInitiateByCitizen.clear();
  lastInitiatedPlayer.clear();
  nextConvId = 1;
}

function activeConversationFor(username) {
  if (!username) return null;
  const id = byParticipant.get(username);
  if (id == null) return null;
  const conv = conversations.get(id);
  return conv && conv.state === "active" ? conv : null;
}

// ---------------------------------------------------------------------------
// Small helpers (engine reads only; every call fail-safe)
// ---------------------------------------------------------------------------

function botTile(bot) {
  try {
    const loc = bot?.getLocation?.() ?? bot?.location ?? null;
    if (!loc) return null;
    const x = typeof loc.getX === "function" ? loc.getX() : loc.x;
    const y = typeof loc.getY === "function" ? loc.getY() : loc.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function isMoving(bot) {
  try {
    const queue = bot?.getMovementQueue?.();
    if (queue && typeof queue.size === "function" && queue.size() > 0) return true;
    if (bot?.getForceMovement?.()) return true;
    return false;
  } catch {
    return false;
  }
}

function firstNameOf(record, username) {
  const raw =
    record?.displayName ?? record?.personality?.name ?? username ?? "friend";
  return String(raw).split(/\s+/)[0] || "friend";
}

function defaultSchedule(fn, delayMs) {
  const t = setTimeout(fn, delayMs);
  if (typeof t.unref === "function") t.unref();
  return t;
}

function render(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) =>
    vars && vars[key] != null ? String(vars[key]) : m
  );
}

function tokensOf(template) {
  const out = [];
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(String(template)))) out.push(m[1]);
  return out;
}

/** Pick a voice line whose {tokens} are all satisfied by vars.
 * Returns null when no line in the pool fully qualifies (the caller
 * skips the turn rather than speaking unresolved template text). */
function pickLine(voice, pools, vars, rng) {
  if (!pools) return null;
  const register = voice?.register === "terse" ? "terse" : "plain";
  const pool = pools[register]?.length ? pools[register] : pools.plain;
  if (!pool?.length) return null;
  const usable = pool.filter((line) =>
    tokensOf(line).every((t) => vars && vars[t] != null)
  );
  // If nothing in the pool is fully satisfiable, speak nothing: falling
  // back to the full pool would render unresolved {token} text verbatim —
  // the most visible bot tell possible. The caller (speakLine via
  // pickTurnLine) treats null as "skip this turn", which falls back to the
  // normal reflex/LLM path rather than speaking a template.
  if (!usable.length) return null;
  return voiceLine(voice, { plain: usable, terse: usable }, rng);
}

// ---------------------------------------------------------------------------
// Real-state sources (lazy requires; every source fail-safe to null)
// ---------------------------------------------------------------------------

function defaultSources() {
  const sources = {
    // Relationship state: CitizenSocialBonds score + CitizenMemory meetings
    // + CitizenBonds friendship/enmity.
    bondScore: (a, b) => {
      try {
        const { scoreOf } = require("../lib/CitizenSocialBonds");
        return scoreOf(a, b);
      } catch {
        return 0;
      }
    },
    isFriend: (a, b) => {
      try {
        const { isFriend } = require("../lib/CitizenBonds");
        return isFriend(a, b) === true;
      } catch {
        return false;
      }
    },
    isEnemy: (a, b) => {
      try {
        const Bonds = require("../lib/CitizenBonds");
        if (typeof Bonds.isEnemy === "function") {
          return Bonds.isEnemy(a, b) === true || Bonds.isEnemy(b, a) === true;
        }
      } catch {
        /* fall through */
      }
      try {
        const { standingFor } = require("../lib/CitizenSocialBonds");
        const s = standingFor(a, b);
        return s === "rival" || s === "nemesis";
      } catch {
        return false;
      }
    },
    memoryEntry: (a, b) => {
      try {
        const { getMemory } = require("../lib/CitizenMemory");
        return getMemory().getEntry(a, b) ?? null;
      } catch {
        return null;
      }
    },
    // Newest remembered favor/grudge STORY between the pair (real events
    // with real text, e.g. "lent you 5k for the rune scim"). Used by the
    // tier-flavor layer so friends reminisce and rivals nurse grudges
    // truthfully instead of inventing history. Null when nothing stored.
    favorStory: (a, b) => {
      try {
        const { favors } = require("../lib/CitizenSocialBonds");
        const list = favors(a, b) ?? [];
        const text = String(list[list.length - 1]?.text ?? "").trim();
        if (!text) return null;
        return text.length > 56 ? text.slice(0, 56).trimEnd() + "…" : text;
      } catch {
        return null;
      }
    },
    grudgeStory: (a, b) => {
      try {
        const { grudges } = require("../lib/CitizenSocialBonds");
        const list = grudges(a, b) ?? [];
        const text = String(list[list.length - 1]?.text ?? "").trim();
        if (!text) return null;
        return text.length > 56 ? text.slice(0, 56).trimEnd() + "…" : text;
      } catch {
        return null;
      }
    },
    // Spouse/partner check via the real CitizenKinship store.
    isFamily: (a, b) => {
      try {
        const kin = require("../lib/CitizenKinship");
        const norm = (n) => String(n ?? "").trim().toLowerCase();
        const target = norm(b);
        if (!target) return false;
        if (norm(kin.spouseOf?.(a)) === target) return true;
        if (norm(kin.partnerOf?.(a)?.other) === target) return true;
        return false;
      } catch {
        return false;
      }
    },
    // Current work: live skilling session first, profession as fallback.
    workContext: (record, bot) => {
      try {
        const Skilling = require("../brain/CitizenSkilling");
        const session = Skilling._sessions?.get?.(record.username);
        if (session?.skill) {
          const label = Skilling.SKILL_LABELS?.[session.skill] ?? session.skill;
          return { skill: String(label).toLowerCase() };
        }
      } catch {
        /* fall through */
      }
      try {
        const profession = record?.personality?.profession;
        if (profession) return { skill: String(profession).toLowerCase() };
      } catch {
        /* non-fatal */
      }
      return null;
    },
    // Live wars for the speaker's kingdom (Wars.Kingdoms + KingdomStore).
    warContext: (record) => {
      try {
        if (!record?.kingdomId) return null;
        const KingdomStore = require("../../kingdoms/KingdomStore.Kingdoms");
        const Wars = require("../../kingdoms/Wars.Kingdoms");
        const wars = Wars.getWars(record.kingdomId, KingdomStore) ?? [];
        if (!wars.length) return null;
        const war = wars[0];
        const enemyId =
          war.attackerId === record.kingdomId ? war.defenderId : war.attackerId;
        const enemy = KingdomStore.getKingdom(enemyId)?.name ?? null;
        if (!enemy) return null; // no named enemy -> no fiction
        const goal =
          (war.goal && Wars.WAR_GOAL_LABELS?.[war.goal]) ?? war.goalLabel ?? null;
        return { enemy, goal };
      } catch {
        return null;
      }
    },
    // Real bread price vs baseline (Prices.Economy). Bread is the staple
    // every citizen buys (CitizenNeeds.BREAD_ID); only notable movement
    // is worth talking about.
    priceContext: () => {
      try {
        const Prices = require("../../economy/Prices.Economy");
        const { BREAD_ID } = require("../brain/CitizenNeeds");
        const base = Prices.getBaseline(BREAD_ID);
        const ref = Prices.getReferencePrice(BREAD_ID, Date.now());
        if (!base || !ref) return null;
        const ratio = ref / base;
        if (ratio >= 1.12) return { item: "bread", dir: "up", pct: Math.round((ratio - 1) * 100) };
        if (ratio <= 0.89) return { item: "bread", dir: "down", pct: Math.round((1 - ratio) * 100) };
        return null;
      } catch {
        return null;
      }
    },
    // Latest newspaper headline (real edition, compiled from the journal).
    newsContext: () => {
      try {
        const { latestEdition } = require("../lib/CitizenNewspaper");
        const edition = latestEdition();
        const headline = edition?.headlines?.[0];
        if (typeof headline === "string" && headline.trim().length > 10) {
          return { headline: headline.trim().slice(0, 64) };
        }
        return null;
      } catch {
        return null;
      }
    },
    // The speaker's own current goal (CitizenIntents).
    goalContext: (record, bot) => {
      try {
        const Intents = require("../lib/CitizenIntents");
        const active = Intents.activeIntents(bot) ?? [];
        if (active.length && active[0].label) {
          return { goal: String(active[0].label) };
        }
        return null;
      } catch {
        return null;
      }
    },
    // Live boss-run state for the speaker: a current boss party (CitizenBonds
    // party + CitizenBossRuns bossById, with the real member count), else a
    // recently journaled boss event (formation / descend / loot / kill lines
    // all carry the boss label from BOSSES). Returns { boss, n? } or null —
    // never invents a run.
    bossContext: (record) => {
      try {
        const { getParty } = require("../lib/CitizenBonds");
        const { bossById, BOSSES } = require("../lib/CitizenBossRuns");
        const partyState = (username) => {
          if (!username) return null;
          const party = getParty(username);
          if (!party) return null;
          const boss = bossById(party.bossId ?? party.activity);
          if (!boss?.label) return null; // not a boss party — never speak
          const members = Array.isArray(party.members) ? party.members : [];
          return {
            boss: boss.label,
            n: members.length > 0 ? members.length : null,
          };
        };
        const ownParty = partyState(record?.username);
        if (ownParty) return ownParty;
        const labels = (BOSSES ?? [])
          .map((b) => String(b?.label ?? "").replace(/^the\s+/i, ""))
          .filter((l) => l.length > 0);
        if (!labels.length) return null;
        const { getJournal } = require("../lib/CitizenJournal");
        const now = Date.now();
        for (const e of getJournal().recent(record?.username, 12) ?? []) {
          if (!e?.text || now - (e.at ?? 0) > BOSS_JOURNAL_RECENT_MS) continue;
          const hit = labels.find((l) => String(e.text).includes(l));
          if (hit) {
            const full =
              (BOSSES ?? []).find(
                (b) => String(b?.label ?? "").replace(/^the\s+/i, "") === hit
              )?.label ?? hit;
            return { boss: full, n: null };
          }
        }
        return null;
      } catch {
        return null;
      }
    },
  };
  return sources;
}

// ---------------------------------------------------------------------------
// Closeness: how well do these two know each other?
// ---------------------------------------------------------------------------

/**
 * Tier: "close" | "friend" | "familiar" | "neutral" | "cold" | "hostile".
 * Built from real relationship state only (bond score both directions,
 * friendship flags, shared-meeting memory).
 */
function closenessTier(aName, bName, sources) {
  try {
    if (sources.isEnemy(aName, bName)) return "hostile";
    const score = Math.round(
      (Number(sources.bondScore(aName, bName)) +
        Number(sources.bondScore(bName, aName))) /
        2
    );
    const friend = sources.isFriend(aName, bName) || sources.isFriend(bName, aName);
    const entry =
      sources.memoryEntry(aName, bName) ?? sources.memoryEntry(bName, aName);
    const met = entry?.met ?? 0;
    if (score <= -25) return "cold";
    if (friend && score >= 40) return "close";
    if (friend || score >= 25) return "friend";
    if (score >= 8 || met >= 3) return "familiar";
    return "neutral";
  } catch {
    return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Tier flavor: what the relationship sounds like.
// ---------------------------------------------------------------------------

/**
 * Flavor bucket for one directed line: "warm" | "cold" | "family" | null.
 * The conversation's conv.tier is the pair average; the bucket is directed
 * (speaker -> addressee) so a warm citizen doesn't snap at someone who
 * merely dislikes them, and a cold citizen doesn't gush at a friend of
 * their rival. Built from real relationship state only.
 */
function flavorBucket(conv, speakerName, addresseeName) {
  try {
    const s = conv.sources ?? {};
    // Family first: spouses/partners use familiar terms — unless the
    // directed score says they're openly feuding.
    if (s.isFamily?.(speakerName, addresseeName)) {
      const directed = Number(s.bondScore?.(speakerName, addresseeName)) || 0;
      if (directed > -25) return "family";
    }
    const directed = Number(s.bondScore?.(speakerName, addresseeName)) || 0;
    if (conv.tier === "cold" && directed <= -15) return "cold";
    if (
      (conv.tier === "close" || conv.tier === "friend") &&
      (directed >= 8 || s.isFriend?.(speakerName, addresseeName))
    )
      return "warm";
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Length planning
// ---------------------------------------------------------------------------

function drawLength(rng, table) {
  const roll = rng();
  let acc = 0;
  for (const [len, p] of table) {
    acc += p;
    if (roll <= acc) return len;
  }
  return table[table.length - 1][0];
}

/**
 * Draw the planned number of LINES for an exchange.
 * opts: { context: "passing"|"lingering", tier, responderSociability }
 */
function planLength(rng, { context, tier, responderSociability }) {
  let table = LENGTH_TABLES[context] ?? LENGTH_TABLES.passing;
  // Friends standing on a road corner still stop and talk properly.
  if ((tier === "friend" || tier === "close") && context === "passing" && rng() < 0.65) {
    table = LENGTH_TABLES.lingering;
  }
  let len = drawLength(rng, table);
  if (tier === "friend" || tier === "close") {
    if (rng() < 0.45) len += 1; // friends run long
    if (rng() < 0.15) len += 1; // and sometimes really long
  }
  if (tier === "cold") len = Math.min(len, 2);
  // A taciturn responder may just not answer: the exchange collapses to
  // a lone comment (the "ignored" case). Friends are exempt — they at
  // least grunt back.
  if (
    responderSociability != null &&
    responderSociability <= 0.5 &&
    tier !== "friend" &&
    tier !== "close" &&
    rng() < 0.35
  ) {
    len = 1;
  }
  return Math.max(1, Math.min(MAX_TURNS, len));
}

// ---------------------------------------------------------------------------
// Topic pools. Every topic has stages so a conversation stays on ONE
// subject: opener -> reply -> follow (alternating) -> react (short) ->
// closer. {tokens} are filled from the topic's real-state vars only.
// ---------------------------------------------------------------------------

const TOPIC_POOLS = Object.freeze({
  greeting: {
    label: "in passing",
    opener: {
      plain: [
        "Morning!",
        "Alright?",
        "How's the day treating you?",
        "Hey there.",
        "Good to see you.",
        "Mind how you go.",
      ],
      terse: ["Morning.", "Alright?", "Hey."],
    },
    reply: {
      plain: [
        "Morning!",
        "Not bad, yourself?",
        "Can't complain.",
        "Hey! How's things?",
        "Good, good. You?",
      ],
      terse: ["Fine.", "Alright.", "Mm."],
    },
    follow: {
      plain: [
        "Much on today?",
        "Same old, same old here.",
        "Just passing through?",
        "Busy day for it.",
        "Weather's holding, at least.",
      ],
      terse: ["Busy?", "Fair enough.", "Mm."],
    },
    react: {
      plain: ["lol", "Yeah.", "Heh.", "True."],
      terse: ["Mm.", "Yeah."],
    },
    closer: {
      plain: [
        "Right, I'd best get on.",
        "See you round.",
        "Mind how you go.",
        "Later!",
      ],
      terse: ["Later.", "Right. Off."],
    },
  },

  catchup: {
    label: "catching up",
    opener: {
      plain: [
        "{other}! Been a while.",
        "Oh hey, {other}. How've you been?",
        "{other}! We must've crossed paths {met} times now.",
        "There you are. Was just thinking of you.",
      ],
      terse: ["{other}. Been a while.", "Hey, {other}."],
    },
    reply: {
      plain: [
        "Too long, honestly.",
        "Been keeping busy. You?",
        "Same streets, same faces, eh?",
        "Good to see you standing.",
      ],
      terse: ["Busy. You?", "Standing. Just."],
    },
    follow: {
      plain: [
        "We should run something together soon.",
        "You still at the same work?",
        "Heard anything from the others lately?",
        "We keep saying we'll do a trip. One day.",
        "You look well, at least.",
      ],
      terse: ["Trip soon. Yeah?", "Same work?"],
    },
    react: {
      plain: ["lol yeah", "You know it.", "Ha! True."],
      terse: ["Heh.", "Yeah."],
    },
    closer: {
      plain: [
        "Don't be a stranger, {other}.",
        "I'll catch you later, {other}.",
        "Always good seeing you.",
      ],
      terse: ["Later, {other}.", "Don't vanish."],
    },
  },

  work: {
    label: "about work",
    opener: {
      plain: [
        "How's the {skill} treating you?",
        "Been at the {skill} long today?",
        "{skill} again? You're keen.",
        "Grinding {skill} too, eh?",
      ],
      terse: ["{skill} going well?", "Long day at it?"],
    },
    reply: {
      plain: [
        "Steady. Hands are killing me.",
        "Been at it since morning.",
        "One more run then I'm done. Maybe.",
        "Slow going, but it adds up.",
      ],
      terse: ["Steady.", "Since dawn.", "Nearly done."],
    },
    follow: {
      plain: [
        "You sell it all or keep it?",
        "My hands gave up an hour ago lol.",
        "Worth it when the levels land.",
        "The {skill} never ends, does it?",
        "You been at the {skill} long, all told?",
      ],
      terse: ["Sell or keep?", "Levels land eventually."],
    },
    react: {
      plain: ["lol", "Felt that.", "Yeah...", "Oof."],
      terse: ["Mm.", "Heh."],
    },
    closer: {
      plain: [
        "Right, back to the {skill}.",
        "No rest for us.",
        "Shout if you need a hand.",
      ],
      terse: ["Back to it.", "Later."],
    },
  },

  war: {
    label: "about the war",
    opener: {
      plain: [
        "Heard the latest on {enemy}?",
        "War with {enemy}... over {goal}, they say.",
        "You keeping safe with {enemy} about?",
        "This {enemy} business is getting worse.",
      ],
      terse: ["{enemy}. Heard?", "War news?"],
    },
    reply: {
      plain: [
        "{goal}. That's what it's all for, apparently.",
        "My cousin's out there now.",
        "We'll hold. We always do.",
        "Scary times, honestly.",
      ],
      terse: ["We'll hold.", "Bad times."],
    },
    follow: {
      plain: [
        "You know anyone who's gone to fight?",
        "Prices will go mad if it drags on.",
        "The council better know what they're doing.",
        "Just hope it ends quick.",
        "Heard anything from the front?",
      ],
      terse: ["Ends quick, hopefully.", "Council knows best. Supposedly."],
    },
    react: {
      plain: ["Yeah...", "Gods.", "Mm.", "Hope so."],
      terse: ["Mm.", "Gods."],
    },
    closer: {
      plain: ["Stay safe, you hear?", "Keep your head down.", "We'll get through it."],
      terse: ["Stay safe.", "Head down."],
    },
  },

  prices_up: {
    label: "about prices",
    opener: {
      plain: [
        "Seen the price of {item} lately? Through the roof.",
        "{item}'s gone up again. Everything has.",
        "They're charging what for {item} now?",
      ],
      terse: ["{item} prices. Mad.", "Seen {item} lately?"],
    },
    reply: {
      plain: [
        "It's the war, mark my words.",
        "Everything costs more these days.",
        "My purse felt that one.",
        "Shopkeepers are loving it.",
      ],
      terse: ["War, innit.", "Felt that."],
    },
    follow: {
      plain: [
        "Used to eat for a week on that.",
        "Wonder what shoots up next.",
        "Glad I stocked up when I did.",
        "Can't keep going up forever. Can it?",
      ],
      terse: ["Madness.", "What next?"],
    },
    react: {
      plain: ["lol", "Madness.", "Yeah."],
      terse: ["Mm.", "Heh."],
    },
    closer: {
      plain: ["Anyway. Best get on.", "Coins don't earn themselves."],
      terse: ["On with it.", "Later."],
    },
  },

  prices_down: {
    label: "about prices",
    opener: {
      plain: [
        "{item}'s cheap as anything right now.",
        "Stock up on {item} while it's down, I say.",
        "Seen {item} prices? Dropped right down.",
      ],
      terse: ["{item}'s cheap now.", "Stock up time."],
    },
    reply: {
      plain: [
        "Filled my pack already.",
        "Makes a change, that.",
        "Won't last. Never does.",
        "Good. Purse needed a break.",
      ],
      terse: ["Already did.", "Won't last."],
    },
    follow: {
      plain: [
        "Bet it shoots back up by the week's end.",
        "Wonder why it's down. Someone flooded the market?",
        "Might grab more while it's like this.",
      ],
      terse: ["Back up soon.", "Grab more, maybe."],
    },
    react: {
      plain: ["lol", "Yeah.", "True."],
      terse: ["Mm.", "Yeah."],
    },
    closer: {
      plain: ["Anyway. Best get on.", "Coins don't earn themselves."],
      terse: ["On with it.", "Later."],
    },
  },

  news: {
    label: "about the news",
    opener: {
      plain: [
        "Did you see the paper? {headline}",
        "You heard? {headline}",
        "Paper says: {headline}",
      ],
      terse: ["Seen the paper?", "Paper. {headline}"],
    },
    reply: {
      plain: [
        "No way. When was this?",
        "Everyone's talking about it.",
        "Read it this morning. Mad.",
        "Had to happen sooner or later.",
      ],
      terse: ["Mad.", "Heard. Yeah."],
    },
    follow: {
      plain: [
        "Wonder what happens next.",
        "Someone at the tavern had the full story.",
        "Realm's never dull, I'll give it that.",
        "You reckon it's true, all of it?",
      ],
      terse: ["What next, eh?", "Full story somewhere."],
    },
    react: {
      plain: ["lol", "Wow.", "Gods.", "Yeah."],
      terse: ["Mm.", "Gods."],
    },
    closer: {
      plain: ["Anyway, that's the news.", "Keep your ear out."],
      terse: ["That's the news.", "Later."],
    },
  },

  goals: {
    label: "about their plans",
    opener: {
      plain: [
        "Gonna {goal} today.",
        "{goal} — that's my day sorted.",
        "Plan: {goal}. Wish me luck.",
      ],
      terse: ["{goal} today.", "Plan: {goal}."],
    },
    reply: {
      plain: [
        "Best part of the day, that.",
        "Rather you than me lol.",
        "Solid plan. I'm jealous.",
        "You and half the town.",
      ],
      terse: ["Solid.", "Good luck."],
    },
    follow: {
      plain: [
        "Should be a good one.",
        "Days like this are the best ones.",
        "Been meaning to do it all week.",
        "Should be done by dark, with luck.",
      ],
      terse: ["Good day for it.", "By dark, hopefully."],
    },
    react: {
      plain: ["lol", "Yeah.", "Nice."],
      terse: ["Mm.", "Heh."],
    },
    closer: {
      plain: ["Right, best crack on with it.", "Wish me luck out there."],
      terse: ["Crack on, then.", "Later."],
    },
  },

  // Boss runs. Perspective tags {own}/{theirs}/{past} are present-but-empty:
  // pickLine's token filter uses their presence to pick the right
  // first-/second-person lines for whoever actually ran the boss, and
  // render() prints nothing for them. {n} (live party size) is only set for
  // a current party; a journaled run is past-tense ({past}).
  boss: {
    label: "about boss runs",
    opener: {
      plain: [
        "We're running {boss} — {n} of us, heading down soon.{own}",
        "Taking {n} of us down after {boss} tonight.{own}",
        "We took down {boss}. Still buzzing.{own}{past}",
        "{boss} went down. Good run.{own}{past}",
        "You lot are running {boss} — {n} strong?{theirs}",
        "Heard you're taking {n} down after {boss}.{theirs}",
        "You lot took down {boss}, right? How'd it go?{theirs}{past}",
        "Heard the {boss} run went well.{theirs}{past}",
      ],
      terse: [
        "Running {boss}. {n} of us.{own}",
        "Took down {boss}.{own}{past}",
        "You lot. {boss}. {n} strong?{theirs}",
        "{boss} run went well?{theirs}{past}",
      ],
    },
    reply: {
      plain: [
        "Good luck down there.{own}",
        "Watch yourself.{own}",
        "Bring back something shiny.{own}",
        "Nice. Get anything good?{own}{past}",
        "No way. How'd it go?{own}{past}",
        "Yeah — {n} of us. Heading down soon.{theirs}",
        "{n} of us, yeah. Wish us luck.{theirs}",
        "Went down clean.{theirs}{past}",
        "Yeah. Split the loot even.{theirs}{past}",
      ],
      terse: [
        "Good luck.{own}",
        "Loot?{own}{past}",
        "Yeah. {n}.{theirs}",
        "Clean kill.{theirs}{past}",
      ],
    },
    follow: {
      plain: [
        "Nothing like a good boss run.",
        "You been down before, or is this the first?",
        "Heard {boss} doesn't go down easy.",
        "Better than standing around the square all day.",
        "I'll get on one of those runs myself, one day.",
      ],
      terse: ["Boss runs. Good.", "One day, me."],
    },
    react: {
      plain: ["lol", "Gods.", "No way.", "Nice."],
      terse: ["Mm.", "Heh."],
    },
    closer: {
      plain: [
        "Right, back to it.",
        "Stay safe out there.",
        "Catch you later.",
        "Good chatting.",
      ],
      terse: ["Later.", "Right."],
    },
  },
});

// ---------------------------------------------------------------------------
// Tier-flavor pools: what the relationship sounds like, independent of the
// topic. Checked before the topic's own stage pools in speakLine; the
// {favor}/{grudge} lines are only eligible when a real remembered story
// exists (pickLine's token filter), so nothing is ever invented.
// ---------------------------------------------------------------------------

const FLAVOR_CHANCE = 0.6; // share of eligible lines that use tier flavor

const TIER_FLAVOR_POOLS = Object.freeze({
  // Friends tease, use first names, and reminisce about real shared history.
  warm: {
    opener: {
      plain: [
        "{other}! Well, well.",
        "Look what the cat dragged in — {other}!",
        "{other}! You look like trouble.",
        "There's my favourite troublemaker.",
        "I'll never forget it — {favor}.",
        "Still think about {favor}, you know.",
      ],
      terse: [
        "{other}. Good to see you.",
        "Well. {other}.",
        "{favor}, eh? Never forgot.",
      ],
    },
    reply: {
      plain: [
        "Ha! Good to see you, {other}.",
        "You know it, {other}.",
        "Missed you, you menace.",
        "Couldn't agree more, {other}.",
      ],
      terse: ["Good to see you.", "Ha. You too, {other}."],
    },
    follow: {
      plain: [
        "We should do that trip we keep talking about.",
        "Don't work too hard, yeah?",
        "You take care of yourself, {other}.",
        "Same time tomorrow, then?",
        "You always know how to cheer a person up.",
      ],
      terse: ["Trip soon, yeah?", "Take care, {other}."],
    },
    closer: {
      plain: [
        "Don't be a stranger, {other}.",
        "Later, legend.",
        "Take care out there, {other}.",
        "Always good, {other}.",
      ],
      terse: ["Later, {other}.", "Take care."],
    },
  },
  // Rivals trade barbs and nurse real grudges.
  cold: {
    opener: {
      plain: [
        "Oh. It's you.",
        "What do you want, {other}?",
        "{other}.",
        "We got business, or are you just blocking the road?",
        "Still haven't forgotten — {grudge}.",
        "We still got unfinished business — {grudge}.",
      ],
      terse: ["You.", "What.", "Talk, {other}."],
    },
    reply: {
      plain: ["Hmph.", "Make it quick.", "Is that right.", "Fascinating."],
      terse: ["Hmph.", "Quick.", "Right."],
    },
    follow: {
      plain: [
        "Say your piece.",
        "This better be going somewhere.",
        "I'm listening. Barely.",
        "And?",
      ],
      terse: ["And?", "Go on."],
    },
    closer: {
      plain: [
        "We're done here.",
        "Watch yourself, {other}.",
        "Don't follow me.",
      ],
      terse: ["Done.", "Watch it."],
    },
  },
  // Spouses/partners use familiar terms. Only opener/closer; the middle of
  // the chat falls back to the warm pools.
  family: {
    opener: {
      plain: [
        "Hey love.",
        "There's my favourite.",
        "Alright, dear?",
        "{other}, love — how's your day going?",
      ],
      terse: ["Hey love.", "Alright, dear?"],
    },
    closer: {
      plain: [
        "See you at home.",
        "Don't be late, yeah?",
        "Mind yourself out there, love.",
      ],
      terse: ["See you home.", "Mind yourself."],
    },
  },
});

/** Resolve the tier-flavor pool for a bucket+stage, or null. */
function flavorPoolFor(bucket, stage) {
  try {
    const pools = TIER_FLAVOR_POOLS[bucket];
    if (!pools) return null;
    if (pools[stage]) return pools[stage];
    // Family falls back to warm for the middle of the chat.
    if (bucket === "family") return TIER_FLAVOR_POOLS.warm[stage] ?? null;
    return null;
  } catch {
    return null;
  }
}

// A third citizen muscling in.
const JOININ_POOL = Object.freeze({
  plain: [
    "Mind if I join?",
    "Oh, we talking about this? Count me in.",
    "Didn't mean to eavesdrop, but... yeah.",
    "Ha! Heard that from over here.",
  ],
  terse: ["Joining.", "Heard that. Agreed."],
});

// Spoken by whoever is left when the other party drifts off mid-chat.
const WALKAWAY_POOL = Object.freeze({
  plain: ["...And off they go.", "Right then. Just me, apparently.", "Oi! ...Never mind."],
  terse: ["...Right.", "Off they go."],
});

// ---------------------------------------------------------------------------
// Topic selection: ONE topic per conversation, from real state only.
// ---------------------------------------------------------------------------

function buildTopicCandidates(ctx) {
  const { sources, aRecord, aBot, bRecord, tier, context, rng } = ctx;
  const out = [];
  const greetingWeight = context === "passing" ? 5 : 2;
  out.push({ id: "greeting", weight: greetingWeight, vars: {} });

  if (tier === "friend" || tier === "close" || tier === "familiar") {
    const entry =
      sources.memoryEntry(aRecord.username, bRecord.username) ??
      sources.memoryEntry(bRecord.username, aRecord.username);
    out.push({
      id: "catchup",
      weight: 4,
      vars: { met: Math.max(1, entry?.met ?? 1) },
    });
  }

  const workA = sources.workContext(aRecord, aBot);
  const workB = sources.workContext(bRecord, null);
  const work = workA ?? workB;
  if (work?.skill) out.push({ id: "work", weight: 4, vars: { skill: work.skill } });

  const war = sources.warContext(aRecord);
  if (war?.enemy) {
    const vars = { enemy: war.enemy };
    // The goal line is only spoken when Wars provided a real label.
    if (war.goal) vars.goal = war.goal;
    out.push({ id: "war", weight: 4, vars });
  }

  const price = sources.priceContext();
  if (price?.item) {
    out.push({
      id: price.dir === "down" ? "prices_down" : "prices_up",
      weight: 3,
      vars: { item: price.item },
    });
  }

  const news = sources.newsContext();
  if (news?.headline) out.push({ id: "news", weight: 3, vars: { headline: news.headline } });

  const goal = sources.goalContext(aRecord, aBot);
  if (goal?.goal) out.push({ id: "goals", weight: 3, vars: { goal: goal.goal } });

  // Boss runs: the opener's own live party or recent run first, else the
  // other citizen's as gossip. Never selectable with no real boss state.
  const bossA = sources.bossContext(aRecord);
  let bossPick = bossA?.boss ? { state: bossA, tag: "own" } : null;
  if (!bossPick) {
    const bossB = sources.bossContext(bRecord);
    if (bossB?.boss) bossPick = { state: bossB, tag: "theirs" };
  }
  if (bossPick) {
    const vars = { boss: bossPick.state.boss };
    vars[bossPick.tag] = ""; // perspective tag: presence-filtered, renders empty
    if (bossPick.state.n) vars.n = bossPick.state.n;
    else vars.past = ""; // journaled run — no live party, past tense
    out.push({ id: "boss", weight: 4, vars });
  }

  void rng;
  return out;
}

function pickTopic(ctx) {
  const candidates = buildTopicCandidates(ctx);
  let total = 0;
  for (const c of candidates) total += c.weight;
  let roll = ctx.rng() * total;
  let chosen = candidates[0];
  for (const c of candidates) {
    roll -= c.weight;
    if (roll <= 0) {
      chosen = c;
      break;
    }
  }
  const def = TOPIC_POOLS[chosen.id] ?? TOPIC_POOLS.greeting;
  return { id: chosen.id, label: def.label, vars: { ...chosen.vars }, pools: def };
}

// ---------------------------------------------------------------------------
// Engine internals
// ---------------------------------------------------------------------------

function resolveBot(conv, participant) {
  try {
    return conv.director?.getBot?.(participant.record) ?? null;
  } catch {
    return null;
  }
}

function isOnline(conv, participant) {
  try {
    if (typeof conv.director?.isOnline === "function") {
      return conv.director.isOnline(participant.record) === true;
    }
    return !!resolveBot(conv, participant);
  } catch {
    return false;
  }
}

function rememberMeeting(aName, bName) {
  try {
    const { getMemory } = require("../lib/CitizenMemory");
    const memory = getMemory();
    memory.recordMeeting(aName, bName);
    memory.recordMeeting(bName, aName);
  } catch {
    /* non-fatal */
  }
}

function journalChat(conv, participant, otherNames) {
  try {
    const { getJournal } = require("../lib/CitizenJournal");
    const label = conv.topic.label;
    const text =
      label === "in passing"
        ? `Exchanged words with ${otherNames} in passing.`
        : `Chatted with ${otherNames} — ${label}.`;
    getJournal().log(participant.username, "social", text);
  } catch {
    /* non-fatal */
  }
}

function recordChatBond(conv) {
  if (conv.turn < 2) return;
  try {
    const { recordInteraction } = require("../lib/CitizenSocialBonds");
    const citizens = conv.participants.filter((p) => !p.isPlayer);
    for (const a of citizens) {
      for (const b of citizens) {
        if (a.username !== b.username) {
          recordInteraction(a.username, b.username, "chatted");
        }
      }
    }
  } catch {
    /* non-fatal */
  }
}

function turnDelay(conv, nextRecord) {
  const base =
    TURN_DELAY_MIN_MS + conv.rng() * (TURN_DELAY_MAX_MS - TURN_DELAY_MIN_MS);
  let sociability = 1;
  try {
    sociability = humanizerProfile(nextRecord?.personality).sociability;
  } catch {
    /* default */
  }
  // Taciturn citizens answer late; chatty ones a touch sooner.
  const scale = sociability <= 0.5 ? 1.25 : sociability >= 1.4 ? 0.9 : 1;
  return Math.round(base * scale);
}

/**
 * Pick the line for a turn without saying it. Same pools/vars/flavor as
 * speakLine — split out so a line can be picked now and spoken later
 * (a delayed reply needs the actual line to compute its typing delay).
 * Returns { line, addressee } or null when nothing usable is picked.
 */
function pickTurnLine(conv, participant, stage) {
  const voice = voiceFor(participant.record?.personality);
  // The person being addressed: whoever spoke last, else the next
  // participant round-robin. {other}/{met} come from real state.
  const addressee =
    conv.participants[conv.lastSpeakerIdx ?? -1] ??
    conv.participants.find((p) => p.username !== participant.username);
  // Tier flavor: friends tease and reminisce, rivals snap, family is
  // familiar — strangers keep the base (shallow) pools.
  const bucket = addressee
    ? flavorBucket(conv, participant.username, addressee.username)
    : null;
  const vars = {
    ...conv.topic.vars,
    other: addressee
      ? firstNameOf(addressee.record, addressee.username)
      : "friend",
  };
  if (bucket === "warm" && addressee) {
    const story = conv.sources.favorStory?.(
      participant.username,
      addressee.username
    );
    if (story) vars.favor = story;
  } else if (bucket === "cold" && addressee) {
    const story = conv.sources.grudgeStory?.(
      participant.username,
      addressee.username
    );
    if (story) vars.grudge = story;
  }
  let pools =
    stage === "joinin"
      ? JOININ_POOL
      : stage === "walkaway"
        ? WALKAWAY_POOL
        : conv.topic.pools[stage];
  if (
    bucket &&
    (stage === "opener" ||
      stage === "reply" ||
      stage === "follow" ||
      stage === "closer")
  ) {
    const flavorPool = flavorPoolFor(bucket, stage);
    // The greeting topic is pure social ritual — a cold pair saying
    // "Good to see you." is the exact wrongness this layer exists to
    // kill, so cold openers/replies there always use the cold pool.
    // Substantive topics keep the 60/40 mix so real-state lines survive.
    const threshold =
      bucket === "cold" &&
      conv.topic.id === "greeting" &&
      (stage === "opener" || stage === "reply")
        ? 1.0
        : FLAVOR_CHANCE;
    if (flavorPool && conv.rng() < threshold) pools = flavorPool;
  }
  // Anti-repeat: re-roll the template pick while the RENDERED line (names
  // filled) matches this citizen's or the area's recent speech. A pool miss
  // still returns null — the caller, not the guard, decides that silence.
  const speakerBot = resolveBot(conv, participant);
  const raw = pickLineAvoidingRepeat(speakerBot, () => {
    const picked = pickLine(voice, pools, vars, conv.rng);
    return picked ? render(picked, vars) : null;
  });
  if (!raw) return null;
  return { line: raw, addressee };
}

/** Face the person you're talking to, like a person would. */
function faceAddressee(conv, bot, addressee) {
  try {
    // Lazy require: CitizenAlive owns the canonical faceToward (real
    // engine facing API). Top-level would be a load cycle
    // (CitizenAlive requires this module).
    const { faceToward } = require("../lib/CitizenAlive");
    const theirTile = addressee ? botTile(resolveBot(conv, addressee)) : null;
    if (theirTile) faceToward(bot, theirTile);
  } catch {
    /* cosmetic */
  }
}

function bookTurn(conv, participant, stage, text) {
  conv.turn += 1;
  conv.lastAt = conv.now();
  conv.lastSpeakerIdx = conv.participants.indexOf(participant);
  conv.history.push({
    speaker: participant.username,
    stage,
    topicId: conv.topic.id,
  });
  if (typeof conv.onLine === "function") {
    try {
      conv.onLine(conv, participant.username, text, stage);
    } catch {
      /* test hook only */
    }
  }
}

function speakLine(conv, participant, stage) {
  const bot = resolveBot(conv, participant);
  if (!bot) return false;
  const picked = pickTurnLine(conv, participant, stage);
  if (!picked) return false;
  faceAddressee(conv, bot, picked.addressee);
  conv.say(bot, picked.line);
  bookTurn(conv, participant, stage, picked.line);
  return true;
}

/**
 * Speak a turn after a human typing delay (slice-2 pacing): the line is
 * picked NOW on the current topic/flavor state, then spoken after the
 * typing delay for its actual length plus a base pacing delay. Used when
 * a player continues an active thread — the reply lands like a person
 * typed it, and the thread's later turns are scheduled after the reply
 * speaks (slice-3 offset behavior), never under it.
 * Token-guarded: a newer continuation cancels a pending delayed reply.
 * `after` runs after the line is spoken (thread bookkeeping).
 */
function speakLineDelayed(conv, participant, stage, baseDelayMs, after) {
  try {
    const picked = pickTurnLine(conv, participant, stage);
    if (!picked) return false;
    let typingMs = 0;
    try {
      const { typingDelayMs } = require("./CitizenHeardReactions");
      if (typeof typingDelayMs === "function") {
        typingMs = typingDelayMs(
          picked.line,
          participant.record?.personality,
          conv.rng
        );
      }
    } catch {
      /* fail-safe: base pacing only */
    }
    const delay = Math.max(0, Math.round((Number(baseDelayMs) || 0) + typingMs));
    const token = conv.turnToken ?? 0;
    conv.schedule(() => {
      if (conv.state !== "active" || (conv.turnToken ?? 0) !== token) return;
      const liveBot = resolveBot(conv, participant);
      if (!liveBot || !isOnline(conv, participant)) {
        return finishConversation(conv, "stale");
      }
      faceAddressee(conv, liveBot, picked.addressee);
      conv.say(liveBot, picked.line);
      bookTurn(conv, participant, stage, picked.line);
      if (typeof after === "function") {
        try {
          after(conv, liveBot);
        } catch {
          /* non-fatal */
        }
      }
    }, delay);
    return true;
  } catch {
    return false;
  }
}

function finishConversation(conv, reason) {
  if (conv.state !== "active") return;
  conv.state = "done";
  conv.endReason = reason;
  conv.endedAt = conv.now();
  for (const p of conv.participants) {
    if (byParticipant.get(p.username) === conv.id) byParticipant.delete(p.username);
    if (!p.isPlayer) {
      const until =
        conv.now() +
        COOLDOWN_MIN_MS +
        conv.rng() * (COOLDOWN_MAX_MS - COOLDOWN_MIN_MS);
      cooldownUntil.set(p.username, until);
    }
  }
  const citizens = conv.participants.filter((p) => !p.isPlayer);
  // No exchange happened (a player never answered an initiation, or the
  // opener couldn't land): nothing truthful to journal.
  if (conv.turn === 0) return;
  for (const p of citizens) {
    const others = conv.participants
      .filter((o) => o.username !== p.username)
      .map((o) => firstNameOf(o.record, o.username))
      .join(" and ");
    if (others) journalChat(conv, p, others);
  }
  recordChatBond(conv);
}

function scheduleNextTurn(conv) {
  const next = conv.participants[conv.nextIdx];
  const delay = turnDelay(conv, next?.record);
  conv.schedule(() => runTurn(conv), delay);
}

/** Find a third citizen close enough to muscle into the chat. */
function findJoiner(conv, anchorBot) {
  try {
    const anchorTile = botTile(anchorBot);
    if (!anchorTile) return null;
    const { normalizeName } = require("../lib/CitizenBonds");
    let best = null;
    let bestDist = Infinity;
    for (const p of anchorBot.getLocalPlayers?.() ?? []) {
      if (!p?.isPlayerBot?.()) continue;
      const username = p.getUsername?.();
      if (!username) continue;
      if (conv.participants.some((x) => x.username === username)) continue;
      if (activeConversationFor(username)) continue;
      const tile = botTile(p);
      if (!tile) continue;
      const d = chebyshev(anchorTile, tile);
      if (d > JOIN_RADIUS || d >= bestDist) continue;
      const record = conv.director?.roster?.get?.(normalizeName(username)) ?? null;
      if (!record) continue;
      if (
        conv.participants.some((x) => conv.sources.isEnemy(username, x.username))
      ) {
        continue;
      }
      best = { username, record };
      bestDist = d;
    }
    return best;
  } catch {
    return null;
  }
}

function runTurn(conv) {
  if (conv.state !== "active") return;
  const speaker = conv.participants[conv.nextIdx];
  if (!speaker) return finishConversation(conv, "stale");

  // Walk-away: the person whose turn it is has left (offline, or drifted
  // out of earshot of whoever spoke last). The chat just dies — or, if it
  // was a real chat, the one left behind remarks on it.
  const speakerBot = resolveBot(conv, speaker);
  const lastSpeaker = conv.participants[conv.lastSpeakerIdx ?? -1];
  const lastBot = lastSpeaker ? resolveBot(conv, lastSpeaker) : null;
  const drifted =
    speakerBot && lastBot
      ? chebyshev(botTile(speakerBot), botTile(lastBot)) > CONV_RADIUS
      : false;
  const wanderedOff =
    speakerBot && lastBot
      ? isMoving(speakerBot) &&
        chebyshev(botTile(speakerBot), botTile(lastBot)) > CONV_RADIUS / 2
      : false;
  if (!speakerBot || !isOnline(conv, speaker) || drifted || wanderedOff) {
    if (conv.turn >= 3 && lastSpeaker && lastBot && isOnline(conv, lastSpeaker)) {
      speakLine(conv, lastSpeaker, "walkaway");
    }
    return finishConversation(conv, "walkaway");
  }

  // Trail-off: even a planned chat sometimes just... ends. Friends
  // trail off half as often — they're actually enjoying this.
  const trailOffChance =
    conv.tier === "friend" || conv.tier === "close"
      ? TRAIL_OFF_CHANCE / 2
      : TRAIL_OFF_CHANCE;
  if (
    conv.turn >= 2 &&
    conv.turn < conv.plannedTurns &&
    conv.rng() < trailOffChance
  ) {
    return finishConversation(conv, "trailoff");
  }

  // A third citizen joins in, occasionally.
  if (
    conv.participants.length === 2 &&
    (conv.turn === 1 || conv.turn === 2) &&
    conv.rng() <
      (conv.context === "lingering" ? JOIN_CHANCE_LINGERING : JOIN_CHANCE_PASSING)
  ) {
    const joiner = findJoiner(conv, speakerBot);
    if (joiner) {
      conv.participants.push(joiner);
      byParticipant.set(joiner.username, conv.id);
      conv.plannedTurns = Math.min(MAX_TURNS, conv.plannedTurns + 1);
      speakLine(conv, joiner, conv.rng() < 0.5 ? "joinin" : "react");
      if (conv.turn >= conv.plannedTurns) return finishConversation(conv, "planned");
      conv.nextIdx = conv.participants.indexOf(speaker);
      return scheduleNextTurn(conv);
    }
  }

  // Stage for this line: reply answers the opener; the last planned line
  // of a longer chat is a closer; otherwise follow-ups with the odd short
  // reaction mixed in.
  let stage;
  if (conv.turn === conv.plannedTurns - 1 && conv.plannedTurns >= 4) {
    stage = "closer";
  } else if (conv.turn === 1) {
    stage = "reply";
  } else {
    stage = conv.rng() < 0.25 ? "react" : "follow";
  }
  speakLine(conv, speaker, stage);
  if (conv.turn >= conv.plannedTurns) {
    return finishConversation(conv, conv.plannedTurns <= 1 ? "no-reply" : "planned");
  }
  conv.nextIdx = (conv.nextIdx + 1) % conv.participants.length;
  scheduleNextTurn(conv);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a citizen-citizen conversation. Called by CitizenAlive's social
 * tick (which owns the starter chance + cooldown gates). Returns the
 * conversation, or null when declined (caps, cooldowns, hostility).
 * opts (test seams): { rng, say, schedule, now, deps, forceTopic, topicVars, onLine, context }
 */
function maybeStart(director, aRecord, aBot, bRecord, bBot, nowMs, opts = {}) {
  try {
    if (!director || !aRecord?.username || !bRecord?.username) return null;
    if (aRecord.username === bRecord.username) return null;
    if (conversations.size >= MAX_ACTIVE) return null;
    const now = typeof opts.now === "function" ? opts.now() : nowMs ?? Date.now();
    for (const name of [aRecord.username, bRecord.username]) {
      if (activeConversationFor(name)) return null;
      if ((cooldownUntil.get(name) ?? 0) > now) return null;
    }
    const rng = opts.rng ?? Math.random;
    const sources = { ...defaultSources(), ...(opts.deps ?? {}) };
    const tier = closenessTier(aRecord.username, bRecord.username, sources);
    if (tier === "hostile") return null;

    const context =
      opts.context ??
      (isMoving(aBot) || isMoving(bBot) ? "passing" : "lingering");
    let topic;
    if (opts.forceTopic && TOPIC_POOLS[opts.forceTopic]) {
      const def = TOPIC_POOLS[opts.forceTopic];
      topic = {
        id: opts.forceTopic,
        label: def.label,
        vars: { ...(opts.topicVars ?? {}) },
        pools: def,
      };
    } else {
      topic = pickTopic({ sources, aRecord, aBot, bRecord, tier, context, rng });
    }
    const responderSociability = humanizerProfile(bRecord.personality).sociability;
    const plannedTurns = planLength(rng, { context, tier, responderSociability });

    const conv = {
      id: nextConvId++,
      kind: "citizens",
      director,
      sources,
      rng,
      say: opts.say ?? ((bot, text) => sayPublic(bot, text)),
      schedule: opts.schedule ?? defaultSchedule,
      now: typeof opts.now === "function" ? opts.now : () => Date.now(),
      onLine: opts.onLine ?? null,
      context,
      tier,
      topic,
      participants: [
        { username: aRecord.username, record: aRecord },
        { username: bRecord.username, record: bRecord },
      ],
      turn: 0,
      plannedTurns,
      nextIdx: 1,
      lastSpeakerIdx: -1,
      startedAt: now,
      lastAt: now,
      state: "active",
      endReason: null,
      history: [],
    };
    conversations.set(conv.id, conv);
    byParticipant.set(aRecord.username, conv.id);
    byParticipant.set(bRecord.username, conv.id);
    rememberMeeting(aRecord.username, bRecord.username);

    speakLine(conv, conv.participants[0], "opener");
    if (conv.plannedTurns <= 1) {
      finishConversation(conv, "no-reply");
      return conv;
    }
    scheduleNextTurn(conv);
    return conv;
  } catch {
    return null;
  }
}

/**
 * Extend a citizen's scripted reply to a REAL player with the same topic
 * machinery: a follow-up thought or two, human-paced, occasionally with
 * a nearby citizen chiming in — instead of the exchange dying after
 * exactly one reply. Called by CitizenChat after a scripted reaction.
 * Probability gating lives at the call site; cooldowns/caps live here.
 * opts.initialDelayMs shifts the first follow-up turn later — CitizenChat
 * passes the typing delay of the reply that precedes it, so the
 * follow-up thought lands after the reply, not under it.
 */
function maybePlayerFollowUp(director, record, bot, playerName, opts = {}) {
  try {
    if (!director || !record?.username || !playerName) return null;
    if (conversations.size >= MAX_ACTIVE) return null;
    const rng = opts.rng ?? Math.random;
    const nowFn = typeof opts.now === "function" ? opts.now : () => Date.now();
    if (!opts.force) {
      if (activeConversationFor(record.username)) return null;
      if ((cooldownUntil.get(record.username) ?? 0) > nowFn()) return null;
    }
    const sources = { ...defaultSources(), ...(opts.deps ?? {}) };
    const pseudoPartner = {
      username: playerName,
      personality: null,
      kingdomId: record.kingdomId,
    };
    const tier = closenessTier(record.username, playerName, sources);
    const topic =
      opts.forceTopic && TOPIC_POOLS[opts.forceTopic]
        ? {
            id: opts.forceTopic,
            label: TOPIC_POOLS[opts.forceTopic].label,
            vars: { ...(opts.topicVars ?? {}) },
            pools: TOPIC_POOLS[opts.forceTopic],
          }
        : pickTopic({
            sources,
            aRecord: record,
            aBot: bot,
            bRecord: pseudoPartner,
            tier,
            context: "lingering",
            rng,
          });
    const extraLines = 1 + (rng() < 0.4 ? 1 : 0);
    const conv = {
      id: nextConvId++,
      kind: "player",
      director,
      sources,
      rng,
      say: opts.say ?? ((b, text) => sayPublic(b, text)),
      schedule: opts.schedule ?? defaultSchedule,
      now: nowFn,
      onLine: opts.onLine ?? null,
      context: "lingering",
      tier,
      topic,
      participants: [
        { username: record.username, record },
        { username: playerName, record: pseudoPartner, isPlayer: true },
      ],
      turn: 0,
      plannedTurns: extraLines,
      nextIdx: 0,
      lastSpeakerIdx: -1,
      startedAt: nowFn(),
      lastAt: nowFn(),
      state: "active",
      endReason: null,
      history: [],
      playerLinesSpoken: 0,
      chimedIn: false,
      turnToken: 0, // bumped by continuations to cancel stale turns
    };
    conversations.set(conv.id, conv);
    byParticipant.set(record.username, conv.id);
    // The follow-up is a second thought AFTER the initial reply lands.
    // Its pacing window starts once that reply has been spoken (the
    // reply itself now carries a human typing delay), so it never
    // races the reply it follows.
    const replyDelayMs = Math.max(0, Number(opts.initialDelayMs) || 0);
    const delay =
      replyDelayMs +
      TURN_DELAY_MIN_MS +
      rng() * (TURN_DELAY_MAX_MS - TURN_DELAY_MIN_MS);
    schedulePlayerTurn(conv, bot, delay);
    return conv;
  } catch {
    return null;
  }
}

/**
 * A citizen OPENS a conversation with a nearby real player — the initiation
 * side of the "player" conversation kind (which previously only existed
 * for continuations after the player spoke first). The citizen's opener is
 * directed at the player with the normal topic machinery, real
 * relationship state, and voice pools.
 *
 * If the player answers, CitizenChat's continuePlayerConversation picks
 * the thread up on the same topic like any other "player" thread. If the
 * player never answers, the opener is left to hang and the thread closes
 * quietly after PLAYER_INITIATE_NO_REPLY_MS — nobody stands there
 * waiting, and the post-chat cooldown keeps volume sane.
 *
 * opts (test seams): { rng, say, schedule, now, deps, forceTopic, topicVars, onLine }
 */
function maybePlayerInitiate(director, record, bot, playerName, playerBot, nowMs = Date.now(), opts = {}) {
  try {
    if (!director || !record?.username || !playerName || !bot) return null;
    if (conversations.size >= MAX_ACTIVE) return null;
    if (activeConversationFor(record.username)) return null;
    const now = typeof opts.now === "function" ? opts.now() : nowMs ?? Date.now();
    if ((cooldownUntil.get(record.username) ?? 0) > now) return null;
    if (now - (lastInitiateByCitizen.get(record.username) ?? 0) < PLAYER_INITIATE_CITIZEN_COOLDOWN_MS) {
      return null;
    }
    if (now - (lastInitiatedPlayer.get(playerName) ?? 0) < PLAYER_INITIATE_PLAYER_COOLDOWN_MS) {
      return null;
    }
    const rng = opts.rng ?? Math.random;
    const sources = { ...defaultSources(), ...(opts.deps ?? {}) };
    const pseudoPartner = {
      username: playerName,
      personality: null,
      kingdomId: record.kingdomId,
    };
    const tier = closenessTier(record.username, playerName, sources);
    if (tier === "hostile") return null;

    const topic =
      opts.forceTopic && TOPIC_POOLS[opts.forceTopic]
        ? {
            id: opts.forceTopic,
            label: TOPIC_POOLS[opts.forceTopic].label,
            vars: { ...(opts.topicVars ?? {}) },
            pools: TOPIC_POOLS[opts.forceTopic],
          }
        : pickTopic({
            sources,
            aRecord: record,
            aBot: bot,
            bRecord: pseudoPartner,
            tier,
            context: "lingering",
            rng,
          });

    const conv = {
      id: nextConvId++,
      kind: "player",
      director,
      sources,
      rng,
      say: opts.say ?? ((b, text) => sayPublic(b, text)),
      schedule: opts.schedule ?? defaultSchedule,
      now: typeof opts.now === "function" ? opts.now : () => Date.now(),
      onLine: opts.onLine ?? null,
      context: "lingering",
      tier,
      topic,
      participants: [
        { username: record.username, record },
        { username: playerName, record: pseudoPartner, isPlayer: true },
      ],
      turn: 0,
      plannedTurns: 1, // opener only — the player either answers or it dies
      nextIdx: 0,
      lastSpeakerIdx: -1,
      startedAt: now,
      lastAt: now,
      state: "active",
      endReason: null,
      history: [],
      playerLinesSpoken: 0,
      chimedIn: false,
      turnToken: 0,
      initiated: true, // citizen opened it; the player never spoke first
    };
    conversations.set(conv.id, conv);
    byParticipant.set(record.username, conv.id);
    lastInitiateByCitizen.set(record.username, now);
    lastInitiatedPlayer.set(playerName, now);
    rememberMeeting(record.username, playerName);

    // Face the player, like a person would when calling out to them.
    try {
      const tile = playerBot?.getLocation?.();
      if (tile && bot.face) bot.face(tile.getX(), tile.getY());
    } catch {
      // Cosmetic.
    }
    speakLine(conv, conv.participants[0], "opener");
    if (conv.turn === 0) {
      // The opener couldn't land (no usable line) — nothing was said.
      finishConversation(conv, "no-reply");
      return conv;
    }
    // The opener hangs in the air briefly. If the player answers, the
    // "player"-kind machinery extends plannedTurns and continues it;
    // otherwise the thread closes quietly.
    conv.schedule(() => {
      if (conv.state === "active" && conv.plannedTurns === 1) {
        finishConversation(conv, "no-reply");
      }
    }, PLAYER_INITIATE_NO_REPLY_MS);
    return conv;
  } catch {
    return null;
  }
}

/**
 * Schedule a player-thread turn. Token-guarded: each player continuation
 * bumps conv.turnToken, so a turn scheduled against an older line becomes
 * a no-op instead of double-speaking over the new reply.
 */
function schedulePlayerTurn(conv, citizenBot, delayMs, forcedStage) {
  const token = conv.turnToken ?? 0;
  conv.schedule(() => {
    if (conv.state !== "active" || (conv.turnToken ?? 0) !== token) return;
    runPlayerTurn(conv, citizenBot, forcedStage);
  }, Math.max(0, Math.round(delayMs)));
}

/** Shared tail after a player-thread line is spoken: count it, finish the
 * thread at the planned length, else schedule the next turn. */
function afterPlayerReply(conv, liveBot) {
  conv.playerLinesSpoken += 1;
  if (conv.playerLinesSpoken >= conv.plannedTurns) {
    return finishConversation(conv, "planned");
  }
  schedulePlayerTurn(
    conv,
    liveBot,
    TURN_DELAY_MIN_MS + conv.rng() * (TURN_DELAY_MAX_MS - TURN_DELAY_MIN_MS)
  );
}

function sameName(a, b) {
  try {
    const { normalizeName } = require("../lib/CitizenBonds");
    if (typeof normalizeName === "function") {
      return normalizeName(a) === normalizeName(b);
    }
  } catch {
    /* fall through */
  }
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

/**
 * Continue an ACTIVE player conversation when the player sends another
 * line mid-thread: the citizen answers the new line on the SAME topic
 * (same flavor/pacing/relationship state, same bounded length) instead
 * of the engine firing a fresh one-shot reflex.
 *
 * Returns true when the thread was continued — the caller should skip
 * the normal reflex/LLM path. Returns false on any miss (no active
 * player thread, different speaker, citizen offline, any error), and
 * the caller must fall back to the current one-shot behavior.
 * Zero LLM anywhere in the path.
 */
function continuePlayerConversation(citizenUsername, playerName, text, bot, opts = {}) {
  try {
    if (!citizenUsername || !playerName) return false;
    const conv = activeConversationFor(citizenUsername);
    if (!conv || conv.state !== "active" || conv.kind !== "player") {
      return false;
    }
    const citizen = conv.participants[0];
    if (!citizen || citizen.username !== citizenUsername) return false;
    const player = conv.participants.find((p) => p.isPlayer === true);
    if (!player || !sameName(player.username, playerName)) return false;
    const liveBot = resolveBot(conv, citizen) ?? bot ?? null;
    if (!liveBot || !isOnline(conv, citizen)) {
      finishConversation(conv, "stale");
      return false; // fall back to the normal one-shot path
    }
    // Record the player's line in the thread (shared-history context).
    conv.history.push({
      speaker: playerName,
      stage: "player-line",
      topicId: conv.topic.id,
      text: String(text ?? "").slice(0, 80),
    });
    conv.lastAt = conv.now();
    conv.startedAt = conv.now(); // a talked-to thread isn't stale
    // Extend the thread by one citizen answer, bounded by MAX_TURNS.
    conv.plannedTurns = Math.min(MAX_TURNS, conv.plannedTurns + 1);
    // Invalidate any already-scheduled turn so the new reply answers
    // THIS line; the stale timer becomes a no-op (never double-speaks).
    const prevToken = conv.turnToken ?? 0;
    conv.turnToken = prevToken + 1;
    // Answer on the same topic with human typing pacing (slice 2); the
    // thread's normal turn pacing resumes after the reply lands, so a
    // later follow-up keeps its offset (slice 3).
    const ok = speakLineDelayed(
      conv,
      citizen,
      "reply",
      turnDelay(conv, citizen.record),
      afterPlayerReply
    );
    if (!ok) {
      conv.turnToken = prevToken; // restore: let the pending turn stand
      return false;
    }
    return true;
  } catch {
    return false; // fail-safe: any error falls back to current behavior
  }
}

function runPlayerTurn(conv, citizenBot, forcedStage) {
  if (conv.state !== "active") return;
  const citizen = conv.participants[0];
  const liveBot = resolveBot(conv, citizen) ?? citizenBot;
  if (!liveBot || !isOnline(conv, citizen)) {
    return finishConversation(conv, "stale");
  }
  // Occasionally a nearby citizen chimes in once before the follow-up.
  if (!conv.chimedIn && conv.rng() < 0.25) {
    const joiner = findJoiner(conv, liveBot);
    if (joiner) {
      conv.chimedIn = true;
      conv.participants.push(joiner);
      speakLine(conv, joiner, conv.rng() < 0.5 ? "joinin" : "react");
      conv.participants.pop();
    }
  }
  const stage =
    forcedStage ??
    (conv.playerLinesSpoken === 0
      ? "follow"
      : conv.rng() < 0.5
        ? "closer"
        : "react");
  // Player-conversation lines don't consume the generic turn counter the
  // same way; track them separately so finish conditions stay clear.
  const before = conv.turn;
  speakLine(conv, citizen, stage);
  if (conv.turn === before) return finishConversation(conv, "stale");
  afterPlayerReply(conv, liveBot);
}

/**
 * Periodic pruning, called from CitizenAlive.tickAlive. No scans beyond
 * the conversation maps themselves (bounded by MAX_ACTIVE).
 */
function housekeep(nowMs) {
  const now = nowMs ?? Date.now();
  for (const conv of [...conversations.values()]) {
    if (conv.state === "active" && now - conv.startedAt > STALE_MS) {
      finishConversation(conv, "stale");
    }
    if (conv.state === "done" && now - (conv.endedAt ?? conv.startedAt) > 60_000) {
      conversations.delete(conv.id);
    }
  }
  for (const [name, until] of [...cooldownUntil.entries()]) {
    if (now > until + 60 * 60 * 1000) cooldownUntil.delete(name);
  }
  // Player-hail cooldowns: prune entries older than a day.
  const dayAgo = now - 24 * 60 * 60 * 1000;
  for (const m of [lastInitiateByCitizen, lastInitiatedPlayer]) {
    for (const [name, at] of [...m.entries()]) {
      if (at < dayAgo) m.delete(name);
    }
  }
}

module.exports = {
  maybeStart,
  maybePlayerFollowUp,
  maybePlayerInitiate,
  continuePlayerConversation,
  housekeep,
  activeConversationFor,
  MAX_ACTIVE,
  MAX_TURNS,
  TURN_DELAY_MIN_MS,
  TURN_DELAY_MAX_MS,
  // Test seams.
  _resetForTests,
  _conversations: conversations,
  _cooldownUntil: cooldownUntil,
  _planLength: planLength,
  _pickTopic: pickTopic,
  _closenessTier: closenessTier,
  _flavorBucket: flavorBucket,
  _flavorPoolFor: flavorPoolFor,
  _defaultSources: defaultSources,
};
