"use strict";

/**
 * CitizenGoalChatter — citizens talk about their REAL social goals in public chat.
 *
 * Two prongs of the "Richer dialogue" master todo (war chatter already shipped
 * as b720db3f/01aef775). The human player model: real players talk about the
 * group content they're doing ("mole run tonight, who's in") and their people
 * ("me and X run together all the time"). Citizens should sound the same.
 *
 * What this does (zero LLM, data tier only):
 *   1. Boss-run goal chatter — party members talk about the run at each phase,
 *      grounded in the REAL party state from CitizenBonds + CitizenBossRuns:
 *        - travel phase: the leader states the plan — the REAL boss label
 *          (from BOSSES via bossById), the REAL member count, once per party;
 *          one companion chimes in ("in for the Mole").
 *        - fight phase: short combat calls grounded in party.bossSeen (the
 *          boss's real NPC is in local NPC range) and the materialized member
 *          count. Not-seen-yet reads "where IS this thing"; seen reads
 *          "eyes up". Nothing invented.
 *      (The kill shout already exists in CitizenBossRuns.shoutIfWatched —
 *      this module does not duplicate it.)
 *   2. Friend-making goal chatter — grounded in the REAL social stores:
 *        - pending invites (CitizenBonds.getInvites, TTL-checked there): the
 *          recipient mentions a real clan/party/boss/friend invite once per
 *          invite id. fromDisplay is the name stored at send time.
 *        - new friendships (CitizenBonds.isFriend): when a citizen's friend
 *          list gains a name not in the persisted announced set, they say it
 *          once. The announced set persists to disk and is SEEDED from the
 *          current friend lists on first run, so a restart never re-announces
 *          old friendships.
 *        - running with a friend (getParty + isFriend): a party member says
 *          they're running with a real friend by name, once per party id.
 *
 * What this does NOT do (anti-fiction guarantees):
 *   - Boss labels come only from BOSSES (bossById). Unknown bossId -> silence.
 *   - Member names come from roster records (displayName ?? username). A
 *     member with no roster record is never named.
 *   - Invites come from getInvites only — expired invites never speak.
 *   - Friendships come from CitizenBonds.isFriend only — never the raw score
 *     guesswork, never a hash, never a cache.
 *   - No LLM in the tick path (scripted pools only, personality-scaled
 *     through citizenVoice).
 *   - Never speaks when no real player is nearby — chatter is FOR players.
 *   - Only citizens in the NEAR or MID LOD band chatter.
 *   - Throttled: boss-party plan lines once per party; fight calls every
 *     5-10 min per party; friend announcements per-citizen 15-30 min.
 *
 * Throttle math: boss runs are rare (a handful per hour across the world),
 * each party chatting a few lines per phase; friend events are rarer still.
 * Across a busy capital this is a line every few minutes — flavor, not spam.
 * sayPublic's own 8s chat-box throttle is the backstop.
 */

const path = require("path");
const fs = require("fs");

const { sayPublic, pickLineAvoidingRepeat } = require("./CitizenSayPublic");
const { voiceFor, voiceLine } = require("../lib/citizenVoice");
const { bandOf, BAND_NEAR, BAND_MID } = require("../lib/CitizenTickLod");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { getJournal } = require("../lib/CitizenJournal");

// --- persistence (announced pairs/parties/invites) ----------------------------

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-goal-chatter.json");
const MAX_SAVED = 5000; // cap each set; oldest entries are dropped

let persisted = null; // { announcedFriends: [], announcedInvites: [], announcedParties: [] }
let persistedDirty = false;
let lastSaveAt = 0;

function freshStore() {
  return { announcedFriends: [], announcedInvites: [], announcedParties: [] };
}

function loadPersisted() {
  if (persisted) return persisted;
  persisted = freshStore();
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        for (const k of Object.keys(persisted)) {
          if (Array.isArray(raw[k])) persisted[k] = raw[k].filter((x) => typeof x === "string").slice(-MAX_SAVED);
        }
      }
    }
  } catch {
    // Missing/corrupt save -> start fresh; seeding below fills it.
  }
  return persisted;
}

function savePersisted(nowMs) {
  if (!persistedDirty) return;
  if (nowMs - lastSaveAt < 60 * 1000) return; // at most once a minute
  lastSaveAt = nowMs;
  persistedDirty = false;
  try {
    for (const k of Object.keys(persisted)) {
      if (persisted[k].length > MAX_SAVED) persisted[k] = persisted[k].slice(-MAX_SAVED);
    }
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(persisted));
  } catch {
    // Best-effort; in-memory sets keep working.
  }
}

// --- per-tick state -------------------------------------------------------------

const nextPartyChatterAt = new Map(); // party id -> ms (boss plan + fight calls)
const nextFriendChatterAt = new Map(); // normalized username -> ms
let friendsSeeded = false;
let lastPruneAt = 0;

function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of nextPartyChatterAt) {
    if (at < cutoff) nextPartyChatterAt.delete(k);
  }
  for (const [k, at] of nextFriendChatterAt) {
    if (at < cutoff) nextFriendChatterAt.delete(k);
  }
}

// --- tuning -------------------------------------------------------------------

const BOSS_PLAN_MIN_MS = 30 * 60 * 1000; // plan line: once per party, long tail
const BOSS_FIGHT_MIN_MS = 5 * 60 * 1000; // fight calls: rare per party
const FRIEND_MIN_MS = 15 * 60 * 1000; // friend announcements per citizen
const FRIEND_MAX_MS = 30 * 60 * 1000;

// --- line pools ----------------------------------------------------------------
// Short, informal, first-person. {boss} = real boss label from BOSSES,
// {n} = real member count, {leader}/{friend}/{from} = real display names.
// Pools are explicit (not generated) so they read like a real player typed them.

const BOSS_PLAN_LINES = {
  plain: [
    "we're taking down {boss} tonight. {n} of us, split the loot",
    "plan's simple: down into {boss}'s lair and we don't leave empty-handed",
    "{n} of us going after {boss}. who's ready",
    "{boss} run — stay with me, split everything at the end",
  ],
  terse: ["{boss}. {n} of us.", "taking down {boss}.", "{n} strong. {boss}."],
};

const BOSS_CHIME_LINES = {
  plain: [
    "in for the {boss}! {leader} knows the way",
    "{boss} with {leader}, let's go",
    "first {boss} run. not dying today",
    "running with {leader} against {boss}",
  ],
  terse: ["in. {boss}.", "let's go. {boss}.", "ready."],
};

const BOSS_FIGHT_SEEN_LINES = {
  plain: [
    "{boss} is here! eyes up!",
    "pile on! don't let it breathe",
    "watch the special — keep moving",
    "we've got this, keep hitting {boss}",
  ],
  terse: ["eyes up.", "pile on.", "keep hitting."],
};

const BOSS_FIGHT_UNSEEN_LINES = {
  plain: [
    "where IS this thing... spread out",
    "{boss} hasn't shown itself yet. stay sharp",
    "it's around here somewhere. weapons ready",
  ],
  terse: ["spread out.", "where is it.", "stay sharp."],
};

const FRIEND_NEW_LINES = {
  plain: [
    "me and {friend} are proper friends these days",
    "{friend} and i are solid now",
    "good friends with {friend} lately",
    "{friend}'s good people. run with them all the time",
  ],
  terse: ["friends with {friend}.", "{friend}'s solid.", "good friends."],
};

const CLAN_INVITE_LINES = {
  plain: [
    "got a clan invite from {from}. thinking about it",
    "{from} invited me to their clan. might join",
    "clan invite from {from} — we'll see",
  ],
  terse: ["clan invite from {from}.", "thinking about {from}'s clan."],
};

const PARTY_INVITE_LINES = {
  plain: [
    "{from} wants me on a party trip. maybe",
    "got a party invite from {from}",
    "{from} is putting together a party. could be fun",
  ],
  terse: ["party invite from {from}.", "maybe. {from}'s party."],
};

const FRIEND_INVITE_LINES = {
  plain: [
    "got a friend request from {from}. sure, why not",
    "{from} wants to be friends. always down for more",
    "friend request from {from} — accepted",
  ],
  terse: ["friend request from {from}.", "sure, {from}."],
};

const RUN_WITH_FRIEND_LINES = {
  plain: [
    "running {what} with {friend} today",
    "{friend} and i are doing {what} together",
    "best part of {what}? doing it with {friend}",
  ],
  terse: ["{what} with {friend}.", "with {friend} today."],
};

// --- helpers -------------------------------------------------------------------

function realPlayersNear(bot) {
  const out = [];
  try {
    for (const p of bot.getLocalPlayers?.() ?? []) {
      if (p !== bot && p?.isPlayerBot?.() !== true) out.push(p);
    }
  } catch {
    // Non-fatal.
  }
  return out;
}

function personalityOf(bot) {
  try {
    return bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    return {};
  }
}

function usernameOf(bot) {
  try {
    return bot.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

/** Display name from the roster record, else the raw username. Never invented. */
function displayNameOfRecord(record, fallback) {
  try {
    const dn = record?.displayName;
    if (typeof dn === "string" && dn.trim().length > 0) return dn.trim();
  } catch {
    // fall through
  }
  return fallback ?? null;
}

function fillTemplate(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

/** Chatty citizens chatter more; taciturn ones mostly stay quiet. */
function chatterChance(personality) {
  try {
    const traits = new Set(personality?.traits ?? []);
    if (traits.has("chatty")) return 0.8;
    if (traits.has("cheerful") || traits.has("easygoing")) return 0.6;
    if (traits.has("taciturn") || traits.has("gruff") || traits.has("suspicious"))
      return 0.2;
    return 0.45;
  } catch {
    return 0.45;
  }
}

function bossLabelOf(bossById, bossId) {
  try {
    const boss = bossById(bossId);
    const label = boss?.label;
    return typeof label === "string" && label.length > 0 ? label : null;
  } catch {
    return null;
  }
}

// --- boss-run chatter ----------------------------------------------------------

/**
 * Collect boss-run parties from the roster: deduped by party id, leader-first.
 * Same shape as CitizenBossRuns.tickBossRuns' collection loop: party.bossId
 * must resolve in BOSSES (bossById). Non-leader records are skipped; the
 * leader's own record is always checked first so the dedup can't swallow it.
 */
function bossPartiesFor(director, roster, getParty, bossById) {
  const seen = new Set();
  const parties = [];
  for (const record of roster) {
    let party = null;
    try {
      party = getParty(record?.username);
    } catch {
      continue;
    }
    if (!party) continue;
    let boss = null;
    try {
      boss = bossById(party.bossId ?? party.activity);
    } catch {
      continue;
    }
    if (!boss) continue; // not a boss party — never speak
    if (normalizeName(party.leader) !== normalizeName(record.username)) continue;
    if (seen.has(party.id)) continue;
    seen.add(party.id);
    parties.push({ party, boss, leader: record });
  }
  return parties;
}

/**
 * One boss party's chatter for this tick.
 *   - travel phase: leader states the plan (real boss label, real member
 *     count); one companion chimes in. Each fires ONCE per party (the plan
 *     cooldown is longer than any run lasts).
 *   - fight phase: a combat call grounded in party.bossSeen (the boss's real
 *     NPC is in local NPC range) — "seen" vs "unseen" pools.
 * Every named member comes from the roster (displayName ?? username). A boss
 * label that doesn't resolve -> silence. Zero LLM.
 */
function tickBossGoalChatter(director, overrides = {}) {
  const nowMs = overrides.nowMs ?? Date.now();
  const rng = overrides.rng ?? Math.random;
  const getParty = overrides.getParty ?? require("../lib/CitizenBonds").getParty;
  const bossById = overrides.bossById ?? require("../lib/CitizenBossRuns").bossById;
  const bandFor = overrides.bandFor ?? ((record) => bandOf(record));
  const say = overrides.sayPublic ?? sayPublic;
  const journal = overrides.journal ?? getJournal();
  pruneState(nowMs);

  let roster = [];
  try {
    roster = [...(director.roster?.values?.() ?? [])];
  } catch {
    return;
  }
  const byName = new Map();
  for (const r of roster) {
    try {
      byName.set(normalizeName(r?.username), r);
    } catch {
      // skip bad records
    }
  }

  const parties = bossPartiesFor(director, roster, getParty, bossById);

  for (const { party, boss, leader } of parties) {
    try {
      if (!director.isOnline(leader)) continue;
      const bot = director.getBot(leader);
      if (!bot) continue;
      const key = normalizeName(leader.username);

      // LOD gate: only near/mid citizens talk.
      const band = bandFor(leader);
      if (band !== BAND_NEAR && band !== BAND_MID) continue;

      // Watched-only: chatter is for players.
      if (realPlayersNear(bot).length === 0) continue;

      const bossLabel = bossLabelOf(bossById, party.bossId ?? party.activity);
      if (!bossLabel) continue; // never invent a boss

      const personality = personalityOf(bot);
      const voice = voiceFor(personality);
      if (rng() >= chatterChance(personality)) continue;

      const phase = party.phase ?? "travel";
      const partyId = String(party.id ?? `party:${key}`);
      const members = Array.isArray(party.members) ? party.members : [];

      if (phase === "travel") {
        if (nowMs < (nextPartyChatterAt.get(partyId) ?? 0)) continue;
        nextPartyChatterAt.set(partyId, nowMs + BOSS_PLAN_MIN_MS);
        const n = Math.max(members.length, 1);
        // Anti-repeat: re-roll the template pick against recent speech.
        const line = pickLineAvoidingRepeat(bot, () =>
          fillTemplate(voiceLine(voice, BOSS_PLAN_LINES, rng), {
            boss: bossLabel,
            n: String(n),
          })
        );
        if (line) {
          try { say(bot, line); } catch { /* cosmetic */ }
          try { journal?.log(leader.username, "social", line); } catch { /* best-effort */ }
        }
        // One companion chimes in: a REAL online party member from the roster.
        const companions = members
          .map((m) => byName.get(normalizeName(m)))
          .filter((r) => r && normalizeName(r.username) !== key && director.isOnline(r));
        const comp = companions[Math.floor(rng() * companions.length)];
        if (comp) {
          const compBot = director.getBot(comp);
          if (compBot && realPlayersNear(compBot).length > 0) {
            const compPersonality = personalityOf(compBot);
            if (rng() < chatterChance(compPersonality)) {
              const compVoice = voiceFor(compPersonality);
              const compLine = pickLineAvoidingRepeat(compBot, () =>
                fillTemplate(voiceLine(compVoice, BOSS_CHIME_LINES, rng), {
                  boss: bossLabel,
                  leader: displayNameOfRecord(leader, leader.username) ?? leader.username,
                })
              );
              if (compLine) {
                try { say(compBot, compLine); } catch { /* cosmetic */ }
                try { journal?.log(comp.username, "social", compLine); } catch { /* best-effort */ }
              }
            }
          }
        }
      } else if (phase === "fight") {
        if (nowMs < (nextPartyChatterAt.get(partyId) ?? 0)) continue;
        nextPartyChatterAt.set(partyId, nowMs + BOSS_FIGHT_MIN_MS);
        const seen = !!party.bossSeen;
        const pool = seen ? BOSS_FIGHT_SEEN_LINES : BOSS_FIGHT_UNSEEN_LINES;
        const line = pickLineAvoidingRepeat(bot, () =>
          fillTemplate(voiceLine(voice, pool, rng), { boss: bossLabel })
        );
        if (line) {
          try { say(bot, line); } catch { /* cosmetic */ }
          try { journal?.log(leader.username, "combat", line); } catch { /* best-effort */ }
        }
      }
      // "done"/unknown phases: the run is over (disbanded) or broken — silence.
    } catch {
      // Per-party isolation — one bad party never breaks the tick.
    }
  }
}

// --- friend-making chatter -----------------------------------------------------

/**
 * Seed the announced-friends set from current friend lists so the very first
 * run after deploy never bursts old friendships into chat. Only genuinely
 * NEW additions (gains after seeding) ever get announced.
 */
function seedFriendsIfNeeded(director, overrides) {
  if (friendsSeeded) return;
  friendsSeeded = true;
  const store = overrides.store ?? loadPersisted();
  const bondsFn = overrides.bonds ?? require("../lib/CitizenBonds").bonds;
  const seen = new Set(store.announcedFriends ?? []);
  let roster = [];
  try {
    roster = [...(director.roster?.values?.() ?? [])];
  } catch {
    return;
  }
  for (const record of roster) {
    try {
      const owner = normalizeName(record?.username);
      if (!owner) continue;
      const list = bondsFn(record.username)?.friends ?? [];
      for (const f of list) {
        const key = `${owner}|${normalizeName(f)}`;
        if (!seen.has(key)) {
          seen.add(key);
          (store.announcedFriends ?? (store.announcedFriends = [])).push(key);
        }
      }
    } catch {
      // Per-citizen isolation.
    }
  }
  persistedDirty = true;
}

/**
 * Friend-making goal chatter for one tick.
 *   - pending invites: getInvites(username) (TTL-checked there) — the
 *     recipient mentions a real clan/party/boss/friend invite once per
 *     invite id. fromDisplay is the name stored at send time.
 *   - new friendships: CitizenBonds.isFriend list gains a name not in the
 *     persisted announced set -> announced once (persisted, so restarts
 *     never re-announce).
 *   - running with a friend: citizen in a party (any) with an isFriend
 *     member -> says so by name, once per party id.
 * All real state only. Zero LLM. Watched-only, LOD-gated, throttled.
 */
function tickFriendGoalChatter(director, overrides = {}) {
  const nowMs = overrides.nowMs ?? Date.now();
  const rng = overrides.rng ?? Math.random;
  const getInvites = overrides.getInvites ?? require("../lib/CitizenBonds").getInvites;
  const isFriend = overrides.isFriend ?? require("../lib/CitizenBonds").isFriend;
  const bondsFn = overrides.bonds ?? require("../lib/CitizenBonds").bonds;
  const getParty = overrides.getParty ?? require("../lib/CitizenBonds").getParty;
  const bossById = overrides.bossById ?? require("../lib/CitizenBossRuns").bossById;
  const bandFor = overrides.bandFor ?? ((record) => bandOf(record));
  const say = overrides.sayPublic ?? sayPublic;
  const journal = overrides.journal ?? getJournal();
  const store = overrides.store ?? loadPersisted();
  pruneState(nowMs);
  seedFriendsIfNeeded(director, overrides);

  const announcedInvites = new Set(store.announcedInvites ?? []);
  const announcedParties = new Set(store.announcedParties ?? []);
  const announcedFriends = new Set(store.announcedFriends ?? []);

  let roster = [];
  try {
    roster = [...(director.roster?.values?.() ?? [])];
  } catch {
    return;
  }
  const byName = new Map();
  for (const r of roster) {
    try {
      byName.set(normalizeName(r?.username), r);
    } catch {
      // skip bad records
    }
  }

  const { INVITE_FRIEND, INVITE_CLAN, INVITE_BOSS, INVITE_PARTY, INVITE_ACTIVITY } = require("../lib/CitizenBonds");

  for (const record of roster) {
    try {
      if (!record || !director.isOnline(record)) continue;
      const bot = director.getBot(record);
      if (!bot) continue;
      const username = usernameOf(bot) ?? record.username;
      if (!username) continue;
      const key = normalizeName(username);

      // LOD gate: only near/mid citizens talk.
      const band = bandFor(record);
      if (band !== BAND_NEAR && band !== BAND_MID) continue;

      // Watched-only: chatter is for players.
      if (realPlayersNear(bot).length === 0) continue;

      const personality = personalityOf(bot);
      const voice = voiceFor(personality);
      if (nowMs < (nextFriendChatterAt.get(key) ?? 0)) continue;
      if (rng() >= chatterChance(personality)) continue;

      let line = null;
      let markFriendKey = null;
      let markInviteId = null;
      let markPartyId = null;

      // 1) Pending invites — real invites only (TTL-checked by getInvites).
      try {
        const invites = getInvites(username) ?? [];
        for (const inv of invites) {
          if (!inv || announcedInvites.has(inv.id)) continue;
          const from = typeof inv.fromDisplay === "string" && inv.fromDisplay.length > 0
            ? inv.fromDisplay
            : inv.from;
          if (!from) continue;
          let pool = null;
          if (inv.kind === INVITE_CLAN) pool = CLAN_INVITE_LINES;
          else if (inv.kind === INVITE_FRIEND) pool = FRIEND_INVITE_LINES;
          else if (inv.kind === INVITE_PARTY || inv.kind === INVITE_BOSS || inv.kind === INVITE_ACTIVITY)
            pool = PARTY_INVITE_LINES;
          if (!pool) continue; // unknown invite kind -> silence, never invent
          line = pickLineAvoidingRepeat(bot, () =>
            fillTemplate(voiceLine(voice, pool, rng), { from })
          );
          markInviteId = inv.id;
          break;
        }
      } catch {
        // Invite reads are best-effort.
      }

      // 2) New friendships — friend-list gains since the persisted seed.
      if (!line) {
        try {
          const list = bondsFn(username)?.friends ?? [];
          for (const f of list) {
            const fkey = `${key}|${normalizeName(f)}`;
            if (announcedFriends.has(fkey)) continue;
            const friendRecord = byName.get(normalizeName(f));
            // Name real people: roster display names for citizens. Players
            // are real too — mention them by their username as-is.
            const friendName = friendRecord
              ? (displayNameOfRecord(friendRecord, f) ?? f)
              : f;
            line = pickLineAvoidingRepeat(bot, () =>
              fillTemplate(voiceLine(voice, FRIEND_NEW_LINES, rng), { friend: friendName })
            );
            markFriendKey = fkey;
            break;
          }
        } catch {
          // Friendship reads are best-effort.
        }
      }

      // 3) Running with a friend — real party + real friendship.
      if (!line) {
        try {
          const party = getParty(username);
          if (party && Array.isArray(party.members) && party.id) {
            const pid = `party:${party.id}`;
            if (!announcedParties.has(pid)) {
              let friendName = null;
              for (const m of party.members) {
                if (normalizeName(m) === key) continue;
                let friend = false;
                try { friend = isFriend(username, m) || isFriend(m, username); } catch { /* non-fatal */ }
                if (!friend) continue;
                const mr = byName.get(normalizeName(m));
                friendName = mr ? (displayNameOfRecord(mr, m) ?? m) : m;
                break;
              }
              if (friendName) {
                let what = "stuff";
                try {
                  const b = bossById(party.bossId ?? party.activity);
                  if (b?.label) what = `a ${b.label} run`;
                  else if (typeof party.activity === "string" && party.activity.length > 0)
                    what = `a ${party.activity.replace(/_/g, " ")} trip`;
                } catch {
                  // keep generic
                }
                line = pickLineAvoidingRepeat(bot, () =>
                  fillTemplate(voiceLine(voice, RUN_WITH_FRIEND_LINES, rng), {
                    friend: friendName,
                    what,
                  })
                );
                markPartyId = pid;
              }
            }
          }
        } catch {
          // Party reads are best-effort.
        }
      }

      if (!line) continue;
      nextFriendChatterAt.set(key, nowMs + FRIEND_MIN_MS + rng() * (FRIEND_MAX_MS - FRIEND_MIN_MS));
      if (markFriendKey) {
        announcedFriends.add(markFriendKey);
        (store.announcedFriends ?? (store.announcedFriends = [])).push(markFriendKey);
        persistedDirty = true;
      }
      if (markInviteId) {
        announcedInvites.add(markInviteId);
        (store.announcedInvites ?? (store.announcedInvites = [])).push(markInviteId);
        persistedDirty = true;
      }
      if (markPartyId) {
        announcedParties.add(markPartyId);
        (store.announcedParties ?? (store.announcedParties = [])).push(markPartyId);
        persistedDirty = true;
      }
      try { say(bot, line); } catch { /* cosmetic */ }
      try { journal?.log(username, "social", line); } catch { /* best-effort */ }
    } catch {
      // Per-citizen isolation — one bad citizen never breaks the tick.
    }
  }

  savePersisted(nowMs);
}

// --- combined entry ----------------------------------------------------------

/** Director tick entry: boss-run goals + friend-making goals. Zero LLM. */
function tickGoalChatter(director, overrides = {}) {
  tickBossGoalChatter(director, overrides);
  tickFriendGoalChatter(director, overrides);
}

module.exports = {
  tickGoalChatter,
  tickBossGoalChatter,
  tickFriendGoalChatter,
  // exposed for tests
  _resetForTests() {
    nextPartyChatterAt.clear();
    nextFriendChatterAt.clear();
    friendsSeeded = false;
    persisted = null;
    persistedDirty = false;
    lastSaveAt = 0;
    lastPruneAt = 0;
  },
  _bossPartiesFor: bossPartiesFor,
  _bossLabelOf: bossLabelOf,
  _chatterChance: chatterChance,
  _fillTemplate: fillTemplate,
  _nextPartyChatterAt: nextPartyChatterAt,
  _nextFriendChatterAt: nextFriendChatterAt,
  BOSS_PLAN_MIN_MS,
  BOSS_FIGHT_MIN_MS,
  FRIEND_MIN_MS,
  FRIEND_MAX_MS,
};
